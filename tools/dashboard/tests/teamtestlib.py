"""
Helpers of the dashboard tests: processes (bridge, fake engine, fake LLM) on fixed test ports with logs in a temporary
directory, an HTTP client with the bridge's cookie and headers, a raw SSE reader and a one-shot engine request.

Ports (never the user's game 13360 or the dashboard 13380): bridges 13384-13386, fake engines 13397-13398, fake
LLM 13389. The environment of the started processes has no SIMUTRANS_DASHBOARD_* or DEEPSEEK_* variables of the
caller (the real API key is never used); tests pass fake values explicitly.
"""

import http.client
import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DASH = os.path.dirname(HERE)
BRIDGE = os.path.join(DASH, "simutrans_dashboard.py")
FAKE_ENGINE = os.path.join(DASH, "dev", "fake_engine.py")
FAKE_LLM = os.path.join(DASH, "dev", "fake_llm.py")
if DASH not in sys.path:
    sys.path.insert(0, DASH)  # import team

BRIDGE_PORTS = (13384, 13385, 13386)
ENGINE_PORTS = (13397, 13398)
LLM_PORT = 13389


def clean_env(extra=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("SIMUTRANS_DASHBOARD_", "DEEPSEEK_", "SIMUTRANS_REMOTE_PORT"))}
    env["PYTHONIOENCODING"] = "utf-8"
    env.update(extra or {})
    return env


def port_open(port):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        return True
    except OSError:
        return False


def wait_port(port, timeout=30, proc=None):
    end = time.time() + timeout
    while time.time() < end:
        if port_open(port):
            return True
        if proc is not None and proc.poll() is not None:
            return False
        time.sleep(0.1)
    return False


def wait_free(port, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if not port_open(port):
            return True
        time.sleep(0.1)
    return False


class Proc:
    """A started process with stdout/stderr in files of a directory (read with out() / err())."""

    def __init__(self, args, logdir, name, env=None, port=None):
        if port is not None and not wait_free(port, 5):
            raise RuntimeError("port %d is in use by another process" % port)
        self.name = name
        self.out_path = os.path.join(logdir, name + ".out")
        self.err_path = os.path.join(logdir, name + ".log")
        self._out = open(self.out_path, "ab")
        self._err = open(self.err_path, "ab")
        self.p = subprocess.Popen([sys.executable] + list(args), stdout=self._out, stderr=self._err,
                                  env=clean_env(env), cwd=DASH,
                                  creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        if port is not None and not wait_port(port, 30, self.p):
            self.kill()
            raise RuntimeError("%s did not start on %d: %s" % (name, port, self.err()[-2000:]))

    def out(self):
        with open(self.out_path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def err(self):
        with open(self.err_path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def kill(self):
        if self.p.poll() is None:
            self.p.kill()
            self.p.wait(10)
        for f in (self._out, self._err):
            try:
                f.close()
            except OSError:
                pass


def start_engine(logdir, port, *flags, name=None):
    return Proc([FAKE_ENGINE, "--port", str(port)] + list(flags), logdir, name or "engine-%d" % port, port=port)


def start_bridge(logdir, port, game_port, *flags, env=None, name=None):
    return Proc([BRIDGE, "--game-port", str(game_port), "--port", str(port), "--test-fast"] + list(flags), logdir,
                name or "bridge-%d" % port, env=env, port=port)


def engine(port, line, protocol=1):
    """(handshake, reply) of one request straight to an engine."""
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    try:
        f = s.makefile("rwb")
        f.write(b"HELLO simutrans-remote %d\n" % protocol)
        f.flush()
        hello = json.loads(f.readline())
        f.write((line + "\n").encode("utf-8"))
        f.flush()
        return hello, json.loads(f.readline())
    finally:
        s.close()


def call(port, line):
    return engine(port, line)[1]


def request(port, method, path, headers=None, body=None, timeout=15):
    """(status, headers lowercase, body bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    h = {"Host": "127.0.0.1:%d" % port}
    h.update(headers or {})
    if isinstance(body, (dict, list)):
        body = json.dumps(body)
    if isinstance(body, str):
        body = body.encode("utf-8")
    conn.request(method, path, body=body, headers=h)
    r = conn.getresponse()
    data = r.read()
    hdrs = {k.lower(): v for k, v in r.getheaders()}
    conn.close()
    return r.status, hdrs, data


def jbody(data):
    try:
        return json.loads(data)
    except ValueError:
        return None


class Client:
    """A browser session of a bridge: sign in with a token, then GET/POST with the cookie and the headers the
    dashboard sends (X-Dashboard, Origin of the bridge)."""

    def __init__(self, port, token=None):
        self.port = port
        self.cookie = None
        self.status = None
        if token is not None:
            self.login(token)

    def login(self, token):
        st, h, _ = request(self.port, "GET", "/?token=" + token)
        self.status = st
        sc = h.get("set-cookie", "")
        self.cookie = sc.split(";")[0] if sc else None
        return st

    def get(self, path, headers=None):
        h = {"Cookie": self.cookie or ""}
        h.update(headers or {})
        st, hd, data = request(self.port, "GET", path, h)
        return st, jbody(data)

    def post(self, path, body, headers=None, raw=False):
        h = {"Cookie": self.cookie or "", "Content-Type": "application/json", "X-Dashboard": "1",
             "Origin": "http://127.0.0.1:%d" % self.port}
        h.update(headers or {})
        for k in [k for k, v in h.items() if v is None]:
            del h[k]
        st, hd, data = request(self.port, "POST", path, h, body)
        return (st, data) if raw else (st, jbody(data))


class Sse:
    """Raw-socket SSE client with chunked decoding; events land in a queue."""

    def __init__(self, port, path, cookie, last_id=None):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=60)
        lines = ["GET %s HTTP/1.1" % path, "Host: 127.0.0.1:%d" % port, "Cookie: " + (cookie or ""),
                 "Accept: text/event-stream"]
        if last_id is not None:
            lines.append("Last-Event-ID: %s" % last_id)
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        self.f = self.sock.makefile("rb")
        self.status = int(self.f.readline().split()[1])
        self.headers = {}
        while True:
            line = self.f.readline().decode().strip()
            if not line:
                break
            k, _, v = line.partition(":")
            self.headers[k.strip().lower()] = v.strip()
        self.q = queue.Queue()
        self.ended = False
        self.body = None
        if self.status == 200:
            threading.Thread(target=self._reader, daemon=True).start()
        else:
            n = int(self.headers.get("content-length", "0"))
            self.body = jbody(self.f.read(n))

    def _reader(self):
        buf = b""
        try:
            while True:
                size = self.f.readline()
                if not size:
                    break
                n = int(size.strip(), 16)
                if n == 0:
                    self.ended = True
                    break
                data = self.f.read(n)
                self.f.read(2)
                buf += data
                while b"\n\n" in buf:
                    block, buf = buf.split(b"\n\n", 1)
                    ev = {}
                    for line in block.decode("utf-8").split("\n"):
                        if line.startswith(":"):
                            ev["comment"] = line[1:].strip()
                        else:
                            k, _, v = line.partition(":")
                            ev[k] = v[1:] if v.startswith(" ") else v
                    if "data" in ev:
                        ev["json"] = json.loads(ev["data"])
                    self.q.put(ev)
        except (OSError, ValueError):
            pass
        self.q.put({"closed": True})

    def wait(self, pred, timeout=10):
        """The first event for which pred is true, or None (timeout or stream closed)."""
        end = time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                return None
            try:
                ev = self.q.get(timeout=left)
            except queue.Empty:
                return None
            if ev.get("closed"):
                return None
            if pred(ev):
                return ev

    def events(self, name, timeout):
        """All events of a name within timeout."""
        out = []
        end = time.time() + timeout
        while time.time() < end:
            ev = self.wait(lambda e: e.get("event") == name, end - time.time())
            if ev is None:
                break
            out.append(ev)
        return out

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


def wait_until(fn, timeout=10, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        value = fn()
        if value:
            return value
        time.sleep(step)
    return fn()
