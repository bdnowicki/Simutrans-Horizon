#!/usr/bin/env python3
# This file is part of the Simutrans-Horizon project under the Artistic License.
# (see LICENSE.txt)
"""
Fake DeepSeek API (OpenAI compatible) for testing the dashboard's AI team without the real service and without cost.

  POST /chat/completions   stream and non-stream; replies come from a script, else "OK (fake)"
  GET  /models             deepseek-flash, deepseek-v4-pro
  GET  /user/balance       a fixed balance
Test helpers (no Authorization needed, the server listens on 127.0.0.1 only):
  POST /fake/script        replace the script (a JSON list like --script)
  GET  /fake/requests      the received requests (the last 200, Authorization masked)

Streaming answers like DeepSeek: SSE lines `data: {json}` with choices[0].delta pieces of reasoning_content, content
and tool_calls[index] (id, type and name in the first piece, the arguments split over several pieces), `: keep-alive`
comment lines in between, finish_reason "tool_calls" or "stop", with stream_options.include_usage a last chunk with
"choices": [] and usage {prompt_tokens, completion_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens,
completion_tokens_details: {reasoning_tokens}}, then `data: [DONE]`.

The rules of DeepSeek that clients trip over are enforced: Authorization: Bearer <key> (with --key: that key) else
401; thinking is on unless thinking.type is "disabled"; in thinking mode tool_choice "required" or a named tool gives
400, and so does an assistant message with tool_calls but without reasoning_content (it must be sent back). The
cache separation field user_id (the team sends "company-<n>") must be a string of 1-64 characters.

Script (--script FILE or POST /fake/script): a JSON list of entries
  {"match": "<text>"?, "reasoning": "..."?, "content": "..."?, "tool_calls": [{"name": "...", "arguments": {...}}]?,
   "error": 400|401|402|429|500|503?, "message": "..."?, "times": n?, "delay": seconds?, "piece_delay": seconds?,
   "usage": {...}?}
An entry with "match" answers a request whose last user or tool message contains the text; entries without "match"
answer the other requests in order (first in, first out). An entry is used `times` times (default 1). "message" is
the error message of an "error" entry; "piece_delay" pauses between the streamed pieces (a slow answer).

  python tools/dashboard/dev/fake_llm.py [--port 13389] [--script FILE] [--log FILE] [--key KEY]
"""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = ("deepseek-flash", "deepseek-v4-pro")
PIECE = 7               # characters per streamed piece of reasoning, content and arguments
KEEP_ALIVE_EVERY = 3    # a ": keep-alive" comment line after this many pieces
MAX_BODY = 8 * 1024 * 1024
ERROR_TYPES = {400: ("invalid_request_error", "Invalid request"), 401: ("authentication_error", "Authentication Fails"),
               402: ("insufficient_balance", "Insufficient Balance"), 422: ("invalid_request_error", "Invalid Parameters"),
               429: ("rate_limit_reached", "Rate Limit Reached"), 500: ("server_error", "Server Error"),
               503: ("server_overloaded", "Server Overloaded")}


def pieces(text, n=PIECE):
    return [text[i:i + n] for i in range(0, len(text), n)] if text else []


def message_text(msg):
    content = msg.get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # content parts (text, image_url)
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and isinstance(p.get("text"), str))
    return ""


class Script:
    """The scripted replies; thread-safe."""

    def __init__(self, entries=()):
        self.lock = threading.Lock()
        self.entries = []
        self.replace(entries)

    @staticmethod
    def check(entries):
        if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
            raise ValueError("the script is a JSON list of objects")
        for e in entries:
            if "error" in e and e["error"] not in ERROR_TYPES:
                raise ValueError("error must be one of %s" % sorted(ERROR_TYPES))
            for tc in e.get("tool_calls") or ():
                if not isinstance(tc, dict) or not isinstance(tc.get("name"), str):
                    raise ValueError("a tool call needs a name")
        return entries

    def replace(self, entries):
        entries = [dict(e) for e in self.check(list(entries))]
        with self.lock:
            self.entries = entries

    def take(self, last_text):
        """The entry for a request whose last user or tool message is last_text (consumed), or None."""
        with self.lock:
            chosen = next((e for e in self.entries if isinstance(e.get("match"), str) and e["match"] in last_text), None)
            if chosen is None:
                chosen = next((e for e in self.entries if "match" not in e), None)
            if chosen is None:
                return None
            times = int(chosen.get("times", 1)) - 1
            if times <= 0:
                self.entries.remove(chosen)
            else:
                chosen["times"] = times
            return dict(chosen)


class State:
    def __init__(self, script, log_path, key):
        self.script = script
        self.key = key
        self.log_path = log_path
        self.lock = threading.Lock()
        self.requests = []
        self.calls = 0

    def record(self, method, path, headers, body):
        masked = {}
        for k, v in headers.items():
            masked[k] = "Bearer ***" if k.lower() == "authorization" and v else v
        entry = {"time": round(time.time(), 3), "method": method, "path": path, "headers": masked, "body": body}
        with self.lock:
            self.requests.append(entry)
            del self.requests[:-200]
            if self.log_path:
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def next_call_id(self):
        with self.lock:
            self.calls += 1
            return self.calls


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FakeDeepSeek/1.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass  # requests go to --log

    @property
    def state(self):
        return self.server.state

    def send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, code, message=None):
        etype, default = ERROR_TYPES.get(code, ("server_error", "Error"))
        self.send_json(code, {"error": {"message": message or default, "type": etype, "param": None, "code": etype}})

    def authorized(self):
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Bearer ") or not auth[7:].strip():
            return False
        return self.state.key is None or auth[7:].strip() == self.state.key

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw.decode("utf-8")) if raw.strip() else None

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/fake/requests":
            with self.state.lock:
                return self.send_json(200, {"requests": list(self.state.requests)})
        self.state.record("GET", path, dict(self.headers), None)
        if not self.authorized():
            return self.send_error_json(401)
        if path == "/models":
            return self.send_json(200, {"object": "list", "data": [{"id": m, "object": "model", "owned_by": "deepseek"}
                                                                    for m in MODELS]})
        if path == "/user/balance":
            return self.send_json(200, {"is_available": True, "balance_infos": [
                {"currency": "USD", "total_balance": "10.00", "granted_balance": "0.00", "topped_up_balance": "10.00"}]})
        self.send_error_json(404, "not found")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            body = self.read_json()
        except (ValueError, UnicodeDecodeError):
            self.close_connection = True
            return self.send_error_json(400, "invalid JSON body")
        if path == "/fake/script":
            try:
                self.state.script.replace(body if body is not None else [])
            except ValueError as e:
                return self.send_error_json(400, str(e))
            return self.send_json(200, {"ok": True, "entries": len(self.state.script.entries)})
        self.state.record("POST", path, dict(self.headers), body)
        if path != "/chat/completions":
            return self.send_error_json(404, "not found")
        if not self.authorized():
            return self.send_error_json(401)
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list) or not body["messages"]:
            return self.send_error_json(400, "messages must be a non-empty list")
        if not isinstance(body.get("model"), str) or not body["model"]:
            return self.send_error_json(400, "model is missing")
        user_id = body.get("user_id")
        if user_id is not None and (not isinstance(user_id, str) or not 0 < len(user_id) <= 64):
            return self.send_error_json(400, "user_id must be a string of 1-64 characters")
        thinking = body.get("thinking")
        thinking_on = not (isinstance(thinking, dict) and thinking.get("type") == "disabled")
        tool_choice = body.get("tool_choice")
        if thinking_on and (tool_choice == "required" or isinstance(tool_choice, dict)):
            return self.send_error_json(400, "tool_choice 'required' or a named tool is not supported in thinking "
                                             "mode; use 'auto' or disable thinking")
        messages = body["messages"]
        if thinking_on:
            for i, m in enumerate(messages):
                if isinstance(m, dict) and m.get("role") == "assistant" and m.get("tool_calls") \
                        and not m.get("reasoning_content"):
                    return self.send_error_json(400, "Missing `reasoning_content` field in the assistant message at "
                                                     "message index %d. In thinking mode the reasoning_content of "
                                                     "messages with tool calls must be passed back." % i)
        last = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") in ("user", "tool")), {})
        entry = self.state.script.take(message_text(last)) or {"content": "OK (fake)",
                                                               "reasoning": "Thinking (fake)."}
        if entry.get("delay"):
            time.sleep(float(entry["delay"]))
        if entry.get("error"):
            message = entry.get("message")
            return self.send_error_json(int(entry["error"]), message if isinstance(message, str) else None)
        reasoning = (entry.get("reasoning") or "") if thinking_on else ""
        content = entry.get("content") or ""
        calls = []
        for tc in entry.get("tool_calls") or ():
            args = tc.get("arguments", {})
            calls.append({"id": "call_%04d" % self.state.next_call_id(), "type": "function",
                          "function": {"name": tc["name"],
                                       "arguments": args if isinstance(args, str)
                                       else json.dumps(args, ensure_ascii=False)}})
        prompt = max(1, len(json.dumps(messages, ensure_ascii=False)) // 4)
        hit = prompt * 3 // 4 if any(isinstance(m, dict) and m.get("role") == "assistant" for m in messages) else 0
        reasoning_tokens = len(reasoning) // 4
        completion = (len(content) + sum(len(c["function"]["arguments"]) for c in calls)) // 4 + reasoning_tokens + 1
        usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion,
                 "prompt_cache_hit_tokens": hit, "prompt_cache_miss_tokens": prompt - hit,
                 "completion_tokens_details": {"reasoning_tokens": reasoning_tokens}}
        usage.update(entry.get("usage") or {})
        finish = "tool_calls" if calls else "stop"
        cid = "fake-%d" % self.state.next_call_id()
        created = int(time.time())
        if not body.get("stream"):
            msg = {"role": "assistant", "content": content}
            if thinking_on:
                msg["reasoning_content"] = reasoning
            if calls:
                msg["tool_calls"] = calls
            return self.send_json(200, {"id": cid, "object": "chat.completion", "created": created,
                                        "model": body["model"], "system_fingerprint": "fp_fake",
                                        "choices": [{"index": 0, "message": msg, "logprobs": None,
                                                     "finish_reason": finish}], "usage": usage})
        include_usage = isinstance(body.get("stream_options"), dict) and body["stream_options"].get("include_usage")
        self.stream(cid, created, body["model"], reasoning, content, calls, finish, usage if include_usage else None,
                    float(entry.get("piece_delay") or 0))

    def stream(self, cid, created, model, reasoning, content, calls, finish, usage, piece_delay=0.0):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.close_connection = True
        sent = [0]

        def write(data):
            data = data.encode("utf-8")
            self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
            self.wfile.flush()

        def chunk(delta, finish_reason=None):
            write("data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created,
                                         "model": model, "system_fingerprint": "fp_fake",
                                         "choices": [{"index": 0, "delta": delta, "logprobs": None,
                                                      "finish_reason": finish_reason}]}, ensure_ascii=False) + "\n\n")
            sent[0] += 1
            if sent[0] % KEEP_ALIVE_EVERY == 0:
                write(": keep-alive\n\n")
            if piece_delay:
                time.sleep(piece_delay)

        try:
            chunk({"role": "assistant", "content": ""})
            for p in pieces(reasoning):
                chunk({"reasoning_content": p})
            for p in pieces(content):
                chunk({"content": p})
            for i, c in enumerate(calls):
                chunk({"tool_calls": [{"index": i, "id": c["id"], "type": "function",
                                       "function": {"name": c["function"]["name"], "arguments": ""}}]})
                for p in pieces(c["function"]["arguments"]):
                    chunk({"tool_calls": [{"index": i, "function": {"arguments": p}}]})
            chunk({}, finish)
            if usage is not None:
                write("data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created,
                                             "model": model, "system_fingerprint": "fp_fake", "choices": [],
                                             "usage": usage}) + "\n\n")
            write("data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
        except OSError:
            pass  # the client went away (e.g. a cancelled run)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def main():
    p = argparse.ArgumentParser(description="fake DeepSeek API for tests of the dashboard's AI team")
    p.add_argument("--port", type=int, default=13389)
    p.add_argument("--script", metavar="FILE", help="JSON list of scripted replies")
    p.add_argument("--log", metavar="FILE", help="append the received requests as JSON lines (Authorization masked)")
    p.add_argument("--key", help="the only accepted API key (default: any non-empty key)")
    opts = p.parse_args()
    entries = []
    if opts.script:
        with open(opts.script, encoding="utf-8") as f:
            entries = json.load(f)
    try:
        script = Script(entries)
    except ValueError as e:
        p.error(str(e))
    server = Server(("127.0.0.1", opts.port), Handler)
    server.state = State(script, opts.log, opts.key)
    print("fake DeepSeek API on http://127.0.0.1:%d (%d scripted replies)" % (opts.port, len(script.entries)),
          flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
