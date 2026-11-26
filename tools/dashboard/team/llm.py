"""
Client of the language model of the team: DeepSeek's OpenAI compatible chat API (stdlib only).

One call = POST {base_url}/chat/completions with `stream: true`: the answer arrives as server-sent events whose
choices[0].delta pieces carry the reasoning (`reasoning_content`), the text (`content`) and the tool calls
(`tool_calls[index]`: id and name in the first piece, the arguments in pieces); the last chunk has the usage
(`stream_options.include_usage`). Comment lines (": keep-alive") and blank lines are skipped.

DeepSeek rules this client follows (tools/dashboard checkpoint "codefacts"): thinking mode is on (explicitly), so
`tool_choice` is "auto" only (required or a named tool gives 400); `max_tokens` is always set; the caller resends
`reasoning_content` of earlier assistant messages (the runtime does). Errors: 400/422 are the request's fault (no
retry), 401 means the key was refused, 402 that the balance is used up (stop, never retry), 429 and 5xx and broken
connections are retried with a growing pause, but only while nothing of the answer was shown yet (a retry would
show the text twice).

Cost: the usage of a call (cache hit / miss prompt tokens, completion tokens) times a price table in USD per million
tokens. The PEAK prices are used always unless an off-peak factor is configured (conservative for the daily limit);
an unknown model costs like the most expensive one. A call that was cancelled or broke off has no usage chunk: its
tokens are estimated from the characters sent and received (rather too many than too few).

The API key is only ever put into the Authorization header: it is not logged, not part of an error text (server
messages are scrubbed of it) and never leaves this module otherwise.
"""

import http.client
import json
import re
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request

# USD per 1 000 000 tokens (peak prices of 2026-11-26): prompt tokens served from the cache, prompt tokens not in the
# cache, completion tokens (reasoning included)
PRICES = {
    "deepseek-flash": {"hit": 0.006, "miss": 0.30, "out": 1.20},
    "deepseek-v4-pro": {"hit": 0.044, "miss": 1.32, "out": 3.96},
}
# hours (UTC, [start, end)) of the peak prices on weekdays; only used with an off-peak factor
PEAK_UTC = ((1, 4), (6, 10))

CONNECT_TIMEOUT = 15.0     # s to open the connection
READ_TIMEOUT = 120.0       # s without a byte of the answer (the server sends keep-alive comments while it thinks)
RETRY_PAUSES = (2.0, 4.0, 8.0)        # pauses before the 2nd, 3rd and 4th attempt
FAST_RETRY_PAUSES = (0.05, 0.1, 0.2)  # --test-fast
RETRY_STATUS = (429, 500, 502, 503, 504)
MAX_ERROR_BODY = 64 * 1024
MAX_LINE = 4 * 1024 * 1024
USER_AGENT = "simutrans-dashboard-team/1"


class LLMError(Exception):
    """A call that failed. kind: bad_request | auth | balance | rate | server | network | timeout | protocol;
    status: the HTTP status or None. The message is safe to show (never contains the key)."""

    def __init__(self, kind, message, status=None, usage=None):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status
        self.usage = usage   # estimated usage of a call that broke off after the answer had started, else None


class LLMCancelled(Exception):
    """The call was cancelled (Cancel.cancel()); usage = the estimated tokens of what was sent and received."""

    def __init__(self, usage=None):
        super().__init__("cancelled")
        self.usage = usage


class Cancel:
    """Cancellation of one run's model calls from another thread: sets a flag that the reading loop checks between
    chunks and closes the open connection, so a read that waits for the server returns at once."""

    def __init__(self):
        self.event = threading.Event()
        self.lock = threading.Lock()
        self.conn = None

    def cancel(self):
        self.event.set()
        with self.lock:
            conn = self.conn
        if conn is not None:
            try:
                if conn.sock is not None:
                    conn.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    @property
    def cancelled(self):
        return self.event.is_set()

    def attach(self, conn):
        with self.lock:
            self.conn = conn
        if self.event.is_set():
            self.cancel()

    def detach(self):
        with self.lock:
            self.conn = None

    def wait(self, seconds):
        """Sleep, but wake up when cancelled; True when cancelled."""
        return self.event.wait(seconds)


def is_peak(t=None):
    tm = time.gmtime(time.time() if t is None else t)
    if tm.tm_wday >= 5:
        return False
    return any(a <= tm.tm_hour < b for a, b in PEAK_UTC)


def price_of(model):
    """The price table of a model; an unknown model costs like the most expensive known one."""
    if model in PRICES:
        return PRICES[model]
    return max(PRICES.values(), key=lambda p: p["miss"] + p["out"])


def cost_usd(model, prompt_hit, prompt_miss, completion, offpeak_factor=None, t=None):
    """USD of a call. offpeak_factor (e.g. 0.5) applies only outside the peak hours and only when given."""
    p = price_of(model)
    usd = (prompt_hit * p["hit"] + prompt_miss * p["miss"] + completion * p["out"]) / 1e6
    if isinstance(offpeak_factor, (int, float)) and 0 < offpeak_factor < 1 and not is_peak(t):
        usd *= offpeak_factor
    return usd


def usage_from(raw):
    """{prompt_hit, prompt_miss, completion, reasoning, estimated} of a usage object of the API."""
    def num(v):
        return v if type(v) is int and v >= 0 else None
    raw = raw if isinstance(raw, dict) else {}
    prompt = num(raw.get("prompt_tokens")) or 0
    hit = num(raw.get("prompt_cache_hit_tokens"))
    miss = num(raw.get("prompt_cache_miss_tokens"))
    if hit is None and miss is None:
        hit, miss = 0, prompt
    elif hit is None:
        hit = max(0, prompt - miss)
    elif miss is None:
        miss = max(0, prompt - hit)
    details = raw.get("completion_tokens_details")
    reasoning = num(details.get("reasoning_tokens")) if isinstance(details, dict) else None
    return {"prompt_hit": hit, "prompt_miss": miss, "completion": num(raw.get("completion_tokens")) or 0,
            "reasoning": reasoning or 0, "estimated": False}


def estimate_usage(sent_chars, received_chars):
    """Tokens of a call without a usage chunk: 3 characters per token (more tokens than DeepSeek counts for English
    and Polish text), all prompt tokens as cache misses."""
    return {"prompt_hit": 0, "prompt_miss": sent_chars // 3 + 1, "completion": received_chars // 3 + 1, "reasoning": 0,
            "estimated": True}


class Client:
    """client = Client(api_key, base_url); result = client.chat(model, messages, tools, max_tokens, on_delta, cancel,
    user) -> {"content", "reasoning", "tool_calls": [{"id","type","function":{"name","arguments"}}],
    "finish_reason", "usage": {...}, "model"}; raises LLMError or LLMCancelled."""

    def __init__(self, api_key, base_url, fast=False, connect_timeout=CONNECT_TIMEOUT, read_timeout=READ_TIMEOUT,
                 pauses=None, send_user=True):
        if not api_key:
            raise ValueError("no API key")
        self._key = api_key
        u = urllib.parse.urlsplit(base_url or "https://api.deepseek.com")
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ValueError("the base URL must be http(s)://host[:port][/path]")
        self.scheme = u.scheme
        self.host = u.hostname
        self.port = u.port or (443 if u.scheme == "https" else 80)
        self.path = (u.path or "").rstrip("/") + "/chat/completions"
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.pauses = tuple(pauses if pauses is not None else (FAST_RETRY_PAUSES if fast else RETRY_PAUSES))
        # the cache separation field (user_id = the company); dropped for good when the API refuses it
        self.send_user = send_user
        self.lock = threading.Lock()

    def __repr__(self):
        return "Client(%s://%s:%d)" % (self.scheme, self.host, self.port)  # never the key

    # -- helpers

    def scrub(self, text, limit=300):
        """A server text that is safe to show: without the key (or anything that looks like an API key), single
        line, at most limit characters."""
        text = str(text or "")
        if self._key:
            text = text.replace(self._key, "***")
        text = re.sub(r"\bsk-[A-Za-z0-9_\-]{8,}", "***", text)
        text = " ".join(text.split())
        return text if len(text) <= limit else text[:limit - 1] + "…"

    def _connection(self):
        """A connection to the API (through the proxy of the environment, if any: CONNECT tunnel for https)."""
        proxies = urllib.request.getproxies()
        proxy = proxies.get(self.scheme)
        if proxy and urllib.request.proxy_bypass(self.host):
            proxy = None
        target = (self.host, self.port)
        if proxy:
            p = urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy)
            target = (p.hostname, p.port or 8080)
        if self.scheme == "https":
            conn = http.client.HTTPSConnection(target[0], target[1], timeout=self.connect_timeout,
                                               context=ssl.create_default_context())
        else:
            conn = http.client.HTTPConnection(target[0], target[1], timeout=self.connect_timeout)
        if proxy and self.scheme == "https":
            conn.set_tunnel(self.host, self.port)
        return conn, bool(proxy) and self.scheme == "http"

    def _body(self, model, messages, tools, max_tokens, user):
        body = {"model": model, "messages": messages, "stream": True, "stream_options": {"include_usage": True},
                "max_tokens": int(max_tokens), "thinking": {"type": "enabled"}}
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"   # thinking mode: "required" or a named tool is a 400
        with self.lock:
            send_user = self.send_user
        if user and send_user:
            body["user_id"] = str(user)
        return body

    # -- one call

    def chat(self, model, messages, tools=None, max_tokens=8192, on_delta=None, cancel=None, user=None):
        cancel = cancel or Cancel()
        attempt = 0
        user_retry = True
        while True:
            body = self._body(model, messages, tools, max_tokens, user)
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            state = {"shown": False}

            def shown(text, _state=state):
                _state["shown"] = True
                if on_delta is not None:
                    on_delta(text)
            try:
                return self._attempt(model, data, shown, cancel)
            except LLMError as e:
                if e.kind == "bad_request" and user_retry and "user_id" in body \
                        and "user_id" in (e.message or "").lower():
                    # the API does not know the cache separation field: send without it from now on
                    with self.lock:
                        self.send_user = False
                    user_retry = False
                    continue
                retryable = e.kind in ("rate", "server", "network", "timeout") and not state["shown"]
                if not retryable or attempt >= len(self.pauses):
                    raise
                if cancel.wait(self.pauses[attempt]):
                    raise LLMCancelled(estimate_usage(0, 0)) from None
                attempt += 1

    def _attempt(self, model, data, shown, cancel):
        if cancel.cancelled:
            raise LLMCancelled(estimate_usage(0, 0))
        conn, absolute = self._connection()
        cancel.attach(conn)
        received = [0]
        try:
            try:
                conn.connect()
                conn.sock.settimeout(self.read_timeout)
                path = ("%s://%s:%d%s" % (self.scheme, self.host, self.port, self.path)) if absolute else self.path
                conn.putrequest("POST", path, skip_accept_encoding=True)
                conn.putheader("Authorization", "Bearer " + self._key)
                conn.putheader("Content-Type", "application/json")
                conn.putheader("Accept", "text/event-stream")
                conn.putheader("User-Agent", USER_AGENT)
                conn.putheader("Content-Length", str(len(data)))
                conn.endheaders(data)
                resp = conn.getresponse()
            except socket.timeout:
                if cancel.cancelled:
                    raise LLMCancelled(estimate_usage(len(data), 0)) from None
                raise LLMError("timeout", "the language model did not answer in time") from None
            except (OSError, http.client.HTTPException) as e:
                if cancel.cancelled:
                    raise LLMCancelled(estimate_usage(len(data), 0)) from None
                raise LLMError("network", "cannot reach the language model (%s)" % type(e).__name__) from None
            if resp.status != 200:
                self._fail(resp)
            return self._read_stream(model, resp, data, shown, cancel, received)
        finally:
            cancel.detach()
            try:
                conn.close()
            except OSError:
                pass

    def _fail(self, resp):
        """Raise the LLMError of a non-200 reply."""
        try:
            raw = resp.read(MAX_ERROR_BODY)
        except (OSError, http.client.HTTPException):
            raw = b""
        message = ""
        try:
            obj = json.loads(raw.decode("utf-8", "replace"))
            err = obj.get("error") if isinstance(obj, dict) else None
            message = err.get("message") if isinstance(err, dict) else (err if isinstance(err, str) else "")
        except ValueError:
            message = raw.decode("utf-8", "replace")
        st = resp.status
        if st == 401 or st == 403:
            raise LLMError("auth", "API key rejected", st)   # the server's text may echo parts of the key
        if st == 402:
            raise LLMError("balance", "DeepSeek balance exhausted", st)
        if st in (400, 404, 413, 422):
            raise LLMError("bad_request", "the language model refused the request (%d): %s"
                           % (st, self.scrub(message) or "no reason given"), st)
        if st == 429:
            raise LLMError("rate", "the language model is busy (429, rate limit)", st)
        if st in RETRY_STATUS or st >= 500:
            raise LLMError("server", "the language model has a problem (%d)" % st, st)
        raise LLMError("protocol", "unexpected answer of the language model (%d)" % st, st)

    def _read_stream(self, model, resp, data, shown, cancel, received):
        content, reasoning = [], []
        calls = {}
        finish = None
        usage = None
        pending = []   # data lines of the current event

        def estimated():
            return estimate_usage(len(data), received[0])

        def dispatch(lines):
            nonlocal finish, usage
            payload = "\n".join(lines)
            if payload.strip() == "[DONE]":
                return True
            try:
                chunk = json.loads(payload)
            except ValueError:
                raise LLMError("protocol", "the language model sent a broken event", usage=estimated()) from None
            if not isinstance(chunk, dict):
                return False
            if chunk.get("error"):
                err = chunk["error"]
                msg = err.get("message") if isinstance(err, dict) else err
                raise LLMError("server", "the language model stopped: %s" % self.scrub(msg), usage=estimated())
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
            for choice in chunk.get("choices") or ():
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                r = delta.get("reasoning_content")
                if isinstance(r, str) and r:
                    reasoning.append(r)
                    received[0] += len(r)
                c = delta.get("content")
                if isinstance(c, str) and c:
                    content.append(c)
                    received[0] += len(c)
                    shown(c)
                for tc in delta.get("tool_calls") or ():
                    if not isinstance(tc, dict):
                        continue
                    idx = tc.get("index") if type(tc.get("index")) is int else len(calls)
                    cur = calls.setdefault(idx, {"id": None, "type": "function", "name": "", "arguments": ""})
                    if isinstance(tc.get("id"), str) and tc["id"]:
                        cur["id"] = tc["id"]
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                    if isinstance(fn.get("name"), str) and fn["name"]:
                        cur["name"] = fn["name"] if not cur["name"] else cur["name"] + fn["name"]
                    if isinstance(fn.get("arguments"), str):
                        cur["arguments"] += fn["arguments"]
                        received[0] += len(fn["arguments"])
                if choice.get("finish_reason"):
                    finish = choice["finish_reason"]
            return False

        done = False
        try:
            while not done:
                if cancel.cancelled:
                    raise LLMCancelled(estimated())
                line = resp.readline(MAX_LINE)
                if not line:
                    break
                text = line.decode("utf-8", "replace").rstrip("\r\n")
                if not text:
                    if pending:
                        done = dispatch(pending)
                        pending = []
                    continue
                if text.startswith(":"):
                    continue   # keep-alive comment
                if text.startswith("data:"):
                    pending.append(text[5:].lstrip(" ") if text.startswith("data: ") else text[5:])
                # other fields (event:, id:, retry:) carry nothing for us
            if pending and not done:
                done = dispatch(pending)
        except LLMCancelled:
            raise
        except socket.timeout:
            if cancel.cancelled:
                raise LLMCancelled(estimated()) from None
            raise LLMError("timeout", "the language model stopped answering", usage=estimated()) from None
        except (OSError, http.client.HTTPException, ValueError) as e:
            if cancel.cancelled:
                raise LLMCancelled(estimated()) from None
            raise LLMError("network", "the connection to the language model broke (%s)" % type(e).__name__,
                           usage=estimated()) from None
        if cancel.cancelled:
            raise LLMCancelled(estimated())
        if not done and finish is None:
            raise LLMError("network", "the answer of the language model broke off", usage=estimated())
        tool_calls = []
        for n, idx in enumerate(sorted(calls)):
            c = calls[idx]
            if not c["name"]:
                continue
            tool_calls.append({"id": c["id"] or "call_%d_%d" % (int(time.time()), n), "type": "function",
                               "function": {"name": c["name"], "arguments": c["arguments"] or "{}"}})
        u = usage_from(usage) if usage is not None else estimated()
        return {"content": "".join(content), "reasoning": "".join(reasoning), "tool_calls": tool_calls,
                "finish_reason": finish, "usage": u, "model": model}
