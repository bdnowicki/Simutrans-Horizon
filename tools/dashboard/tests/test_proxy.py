"""
Tests of the reverse proxy options of the bridge: --trusted-proxy (the client address of a request from a trusted proxy
is the right-most X-Forwarded-For entry that is not a trusted proxy; X-Forwarded-For of other peers is ignored) and
--max-conn-per-ip (open connections, or for a trusted proxy open requests, of one client address). Unit tests of the
address parsing and of ConnectionLimits, and HTTP tests against two bridges: 13384 trusts the loopback as its proxy
(every test request comes from 127.0.0.1 and names its client in X-Forwarded-For), 13385 trusts nobody. Fake engine
13397, logs in a temporary directory.
"""

import contextlib
import http.client
import io
import os
import shutil
import socket
import tempfile
import time
import unittest

import teamtestlib as T
import simutrans_dashboard as SD

BP, BP_PLAIN, EP = 13384, 13385, 13397
VIEWER = "proxy-viewer-token-0123456789"
PLAYER = "proxy-player-token-0123456789"
WRONG = "wrong-token-0123456789abcdef"


class ProxyUnitTests(unittest.TestCase):
    def test_parse_trusted_proxy(self):
        P = SD.parse_trusted_proxy
        self.assertEqual(str(P("10.251.253.5")), "10.251.253.5/32")
        self.assertEqual(str(P(" 10.0.0.0/8 ")), "10.0.0.0/8")
        self.assertEqual(str(P("10.1.2.3/24")), "10.1.2.0/24")  # host bits allowed: the network meant
        self.assertEqual(str(P("::1")), "::1/128")
        self.assertEqual(str(P("fd00::/8")), "fd00::/8")
        self.assertEqual(str(P("::ffff:10.0.0.1")), "10.0.0.1/32")
        for bad in ("", " ", "localhost", "router.lan", "10.0.0.256", "10.0.0.0/33", "1.2.3.4,5.6.7.8",
                    "1.2.3.4 5.6.7.8", "0.0.0.0/0", "::/0", "10.0.0.1/-1", "http://10.0.0.1", "10.0.0.1:80",
                    "fe80::1%eth0"):
            with self.assertRaises(ValueError, msg=bad):
                P(bad)

    def test_options(self):
        args = SD.parse_args(["--trusted-proxy", "10.251.253.5", "--trusted-proxy", "172.16.0.0/12",
                              "--max-conn-per-ip", "64"])
        self.assertEqual([str(n) for n in args.trusted_proxy], ["10.251.253.5/32", "172.16.0.0/12"])
        self.assertEqual(args.max_conn_per_ip, 64)
        args = SD.parse_args([])
        self.assertEqual(args.trusted_proxy, ())
        self.assertEqual(args.max_conn_per_ip, SD.MAX_CONNECTIONS_PER_IP)
        for bad in (["--trusted-proxy", "localhost"], ["--trusted-proxy", "0.0.0.0/0"], ["--trusted-proxy", ""],
                    ["--max-conn-per-ip", "0"], ["--max-conn-per-ip", "257"], ["--max-conn-per-ip", "x"]):
            err = io.StringIO()
            with self.assertRaises(SystemExit, msg=bad), contextlib.redirect_stderr(err):
                SD.parse_args(bad)
            self.assertIn(bad[0], err.getvalue())

    def test_client_address(self):
        L = SD.ConnectionLimits([SD.parse_trusted_proxy("10.0.0.1"), SD.parse_trusted_proxy("172.16.0.0/12")])
        c = L.client
        # a peer that is no trusted proxy: X-Forwarded-For is ignored, the peer stays as it is
        self.assertEqual(c("192.0.2.50", ["203.0.113.9"]), "192.0.2.50")
        self.assertEqual(c("::ffff:192.0.2.50", ["203.0.113.9"]), "::ffff:192.0.2.50")
        self.assertEqual(c("127.0.0.1", ["203.0.113.9"]), "127.0.0.1")
        # a trusted proxy: the right-most entry (the one it appended)
        self.assertEqual(c("10.0.0.1", ["198.51.100.1, 203.0.113.9"]), "203.0.113.9")
        self.assertEqual(c("::ffff:10.0.0.1", ["203.0.113.9"]), "203.0.113.9")
        self.assertEqual(c("10.0.0.1", ["198.51.100.1", "203.0.113.9"]), "203.0.113.9")  # several header lines
        # trusted proxies in the chain are skipped (e.g. a CDN -> the proxy -> the bridge, the CDN trusted too)
        self.assertEqual(c("10.0.0.1", ["203.0.113.9, 172.20.1.2"]), "203.0.113.9")
        # what the client wrote itself (left of the address its proxy appended) is never used
        self.assertEqual(c("10.0.0.1", ["127.0.0.1, 10.0.0.1, 203.0.113.9"]), "203.0.113.9")
        # only trusted entries: the left-most of them
        self.assertEqual(c("10.0.0.1", ["172.16.0.5, 172.20.1.2"]), "172.16.0.5")
        # no valid right-most entry: the proxy itself
        for value in ([], [""], ["203.0.113.9, unknown"], ["evil.example"], ["fe80::1%eth0"], ["1.2.3.4.5"],
                      ["[2001:db8::7"], ["[2001:db8::7]x"]):
            self.assertEqual(c("10.0.0.1", value), "10.0.0.1", value)
        # an invalid entry ends the walk
        self.assertEqual(c("10.0.0.1", ["203.0.113.9, garbage, 172.20.1.2"]), "172.20.1.2")
        # ports, brackets, other spellings
        self.assertEqual(c("10.0.0.1", ["203.0.113.9:4711"]), "203.0.113.9")
        self.assertEqual(c("10.0.0.1", ["[2001:db8::7]:443"]), "2001:db8::7")
        self.assertEqual(c("10.0.0.1", ["[2001:db8::7]"]), "2001:db8::7")
        self.assertEqual(c("10.0.0.1", [" 2001:DB8:0::7 "]), "2001:db8::7")
        self.assertEqual(c("10.0.0.1", ["::ffff:203.0.113.9"]), "203.0.113.9")
        # only the last MAX_FORWARDED entries are looked at
        many = ", ".join(["172.16.0.9"] * (SD.MAX_FORWARDED + 5))
        self.assertEqual(c("10.0.0.1", ["203.0.113.9, " + many]), "172.16.0.9")
        # without --trusted-proxy nothing is trusted
        self.assertEqual(SD.ConnectionLimits().client("10.0.0.1", ["203.0.113.9"]), "10.0.0.1")
        self.assertFalse(SD.ConnectionLimits().trusted("10.0.0.1"))
        self.assertTrue(L.trusted("::ffff:10.0.0.1"))
        self.assertFalse(L.trusted("10.0.0.2"))
        self.assertFalse(L.trusted("garbage"))

    def test_limits(self):
        L = SD.ConnectionLimits([SD.parse_trusted_proxy("10.0.0.1")], max_per_ip=2, max_total=6)
        # direct connections: at most 2 per address, the loopback without a limit
        self.assertTrue(L.accept("a", "192.0.2.1"))
        self.assertTrue(L.accept("b", "192.0.2.1"))
        self.assertFalse(L.accept("c", "192.0.2.1"))
        self.assertTrue(L.accept("c", "192.0.2.2"))
        for key, peer in (("l1", "127.0.0.1"), ("l2", "::1"), ("l3", "::ffff:127.0.0.1")):
            self.assertTrue(L.accept(key, peer))
        # the global limit holds for everybody
        self.assertFalse(L.accept("p1", "10.0.0.1"))
        for key in ("l1", "l2", "l3", "c"):
            L.close(key)
        # a trusted proxy is not limited by its own address ...
        for key in ("p1", "p2", "p3", "p4"):
            self.assertTrue(L.accept(key, "10.0.0.1"))
        self.assertFalse(L.accept("p5", "10.0.0.1"))  # (global limit: a, b and p1-p4)
        # ... its requests count for the clients they come from
        self.assertTrue(L.enter("p1", "203.0.113.5"))
        self.assertTrue(L.enter("p2", "203.0.113.5"))
        self.assertFalse(L.enter("p3", "203.0.113.5"))
        self.assertTrue(L.enter("p3", "203.0.113.6"))
        L.leave("p1")  # a request answered: its connection (idle) counts for nobody
        self.assertTrue(L.enter("p1", "203.0.113.5"))
        for key in ("p1", "p2", "p3"):
            L.leave(key)
        for key in ("p1", "p2", "p3"):
            self.assertTrue(L.enter(key, "127.0.0.1"))  # a loopback client (e.g. a tunnel on the proxy host)
        L.close("p1")
        self.assertNotIn("p1", L.forwarded)
        self.assertNotIn("p1", L.conns)


def open_raw(port, lines):
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    return s


def is_held(s, wait=0.6):
    """True while the bridge answers nothing on s (it waits for the rest of the request)."""
    s.settimeout(wait)
    try:
        s.recv(1)
    except socket.timeout:
        return True
    except OSError:
        return False
    return False


def status_line(s, timeout=10):
    s.settimeout(timeout)
    data = b""
    while b"\r\n" not in data:
        try:
            chunk = s.recv(1)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
    parts = data.split()
    return int(parts[1]) if len(parts) > 1 else None


class ProxyHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="dash-proxy-")
        cls.engine = T.start_engine(cls.dir, EP)
        env = {"SIMUTRANS_DASHBOARD_TOKEN_VIEWER": VIEWER, "SIMUTRANS_DASHBOARD_TOKEN_PLAYER": PLAYER}
        cls.bridge = T.start_bridge(cls.dir, BP, EP, "--trusted-proxy", "127.0.0.1", "--max-conn-per-ip", "3",
                                    env=env, name="bridge-proxy")
        cls.plain = T.start_bridge(cls.dir, BP_PLAIN, EP, "--max-conn-per-ip", "3", env=env, name="bridge-plain")

    @classmethod
    def tearDownClass(cls):
        cls.bridge.kill()
        cls.plain.kill()
        cls.engine.kill()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.socks = []

    def tearDown(self):
        for s in self.socks:
            try:
                s.close()
            except OSError:
                pass

    def hold(self, client=None, port=BP):
        """A request that the bridge keeps open after its headers: a POST whose body never comes."""
        lines = ["POST /api/logout HTTP/1.1", "Host: 127.0.0.1:%d" % port, "Content-Type: application/json",
                 "Content-Length: 50"]
        if client:
            lines.append("X-Forwarded-For: 198.51.100.200, " + client)
        s = open_raw(port, lines)
        self.socks.append(s)
        return s

    def hold_when_free(self, client, timeout=5):
        end = time.time() + timeout
        while True:
            s = self.hold(client)
            if is_held(s):
                return s
            s.close()
            if time.time() > end:
                return None
            time.sleep(0.2)

    def login(self, token, client=None, port=BP):
        headers = {"X-Forwarded-For": client} if client else {}
        st, h, _ = T.request(port, "GET", "/?token=" + token, headers)
        return st, (h.get("set-cookie") or "").split(";")[0]

    def stream(self, cookie, client):
        lines = ["GET /api/events HTTP/1.1", "Host: 127.0.0.1:%d" % BP, "Cookie: " + cookie,
                 "Accept: text/event-stream", "X-Forwarded-For: " + client]
        s = open_raw(BP, lines)
        self.socks.append(s)
        return s, status_line(s)

    def test_01_login_limit_per_forwarded_client(self):
        for _ in range(SD.LOGIN_FAILURES):
            self.assertEqual(self.login(WRONG, "198.51.100.1, 203.0.113.10")[0], 401)
        self.assertEqual(self.login(WRONG, "203.0.113.10")[0], 429)
        self.assertEqual(self.login(PLAYER, "203.0.113.10")[0], 429)  # blocked, also with the right token
        # what the client writes left of its address changes nothing
        self.assertEqual(self.login(PLAYER, "203.0.113.11, 203.0.113.10")[0], 429)
        # other clients behind the same proxy are not blocked
        st, cookie = self.login(PLAYER, "203.0.113.10, 203.0.113.11")
        self.assertEqual(st, 200)
        self.assertTrue(cookie)
        self.assertEqual(self.login(VIEWER)[0], 200)  # no X-Forwarded-For: the proxy's own address
        log = self.bridge.err()
        self.assertEqual(log.count("203.0.113.10 failed login"), SD.LOGIN_FAILURES)
        self.assertNotIn("127.0.0.1 failed login", log)
        self.assertNotIn("198.51.100.1 failed login", log)
        self.assertIn("203.0.113.10 \"GET /?token=*** HTTP/1.1\" 429", log)  # request log with the client address
        self.assertIn("203.0.113.11 signed in as player", log)

    def test_02_untrusted_peer_forwarded_ignored(self):
        for i in range(SD.LOGIN_FAILURES):
            self.assertEqual(self.login(WRONG, "203.0.113.%d" % (20 + i), BP_PLAIN)[0], 401)
        # all failures counted for the peer 127.0.0.1, whatever X-Forwarded-For says
        self.assertEqual(self.login(PLAYER, "203.0.113.99", BP_PLAIN)[0], 429)
        self.assertEqual(self.login(PLAYER, None, BP_PLAIN)[0], 429)
        log = self.plain.err()
        self.assertEqual(log.count("127.0.0.1 failed login"), SD.LOGIN_FAILURES)
        self.assertNotIn("203.0.113.", log)

    def test_03_connection_limit_per_forwarded_client(self):
        held = [self.hold("192.0.2.7") for _ in range(3)]
        for s in held:
            self.assertTrue(is_held(s))
        over = self.hold("192.0.2.7")
        self.assertEqual(status_line(over), 429)  # answered at once, after its headers
        other = self.hold("192.0.2.8")
        self.assertTrue(is_held(other))
        # the loopback (no X-Forwarded-For: the trusted proxy itself) has no limit
        local = [self.hold() for _ in range(5)]
        for s in local:
            self.assertTrue(is_held(s))
        held[0].close()
        self.assertIsNotNone(self.hold_when_free("192.0.2.7"))
        log = self.bridge.err()
        self.assertIn("192.0.2.7 \"POST /api/logout HTTP/1.1\" 429", log)

    def test_04_idle_proxy_connections_count_for_nobody(self):
        conn = http.client.HTTPConnection("127.0.0.1", BP, timeout=10)
        try:
            # one keep-alive connection of the proxy carries requests of several clients
            for client in ("192.0.2.9", "192.0.2.9", "203.0.113.21", "203.0.113.22", "192.0.2.9"):
                conn.request("GET", "/?token=" + WRONG if client.startswith("203.") else "/login",
                             headers={"Host": "127.0.0.1:%d" % BP, "X-Forwarded-For": client})
                r = conn.getresponse()
                r.read()
                self.assertIn(r.status, (200, 401))
            # the idle connection does not count for 192.0.2.9: three requests of it may be open
            held = [self.hold("192.0.2.9") for _ in range(3)]
            for s in held:
                self.assertTrue(is_held(s))
            # a fourth request on the idle connection is one too many
            conn.request("GET", "/login", headers={"Host": "127.0.0.1:%d" % BP, "X-Forwarded-For": "192.0.2.9"})
            r = conn.getresponse()
            r.read()
            self.assertEqual(r.status, 429)
            self.assertEqual(r.getheader("Retry-After"), "5")
        finally:
            conn.close()
        log = self.bridge.err()
        self.assertIn("203.0.113.21 failed login", log)
        self.assertIn("203.0.113.22 failed login", log)

    def test_05_event_streams_per_forwarded_client(self):
        st, cookie = self.login(VIEWER, "192.0.2.30")
        self.assertEqual(st, 200)
        statuses = [self.stream(cookie, "192.0.2.30")[1] for _ in range(3)]
        self.assertEqual(statuses, [200, 200, 200])
        s, st = self.stream(cookie, "192.0.2.30")
        self.assertEqual(st, 429)
        self.assertEqual(self.stream(cookie, "192.0.2.31")[1], 200)  # another client behind the proxy

    def test_06_no_leftover_slots(self):
        # after the requests of the tests above every slot of a client is free again
        self.tearDown()
        self.socks = []
        for client in ("192.0.2.7", "192.0.2.9", "192.0.2.30"):
            got = [self.hold_when_free(client) for _ in range(3)]
            self.assertTrue(all(got), client)
            for s in got:
                s.close()


if __name__ == "__main__":
    unittest.main()
