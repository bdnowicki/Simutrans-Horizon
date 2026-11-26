"""
Tests of the language model client of the team (team/llm.py) against the fake DeepSeek API (dev/fake_llm.py, port
13389): streaming assembly (reasoning, text, tool calls whose arguments arrive in pieces, keep-alive lines), the
request body DeepSeek needs (stream with usage, max_tokens, thinking, tool_choice auto, user_id), usage -> cost,
the error handling (402 stops, 429/5xx retried, 400 surfaced, 401 without the server's text, the key never in an
error), the user_id fallback, timeouts, connection errors and cancelling a running answer.
"""

import calendar
import json
import shutil
import tempfile
import threading
import time
import unittest

import teamtestlib as T
from team import llm

PORT = T.LLM_PORT
KEY = "fake-llm-key-for-client-tests-42"
BASE = "http://127.0.0.1:%d" % PORT
CLOSED_PORT = 13386     # a bridge port of the tests; nothing listens there while this module runs
TOOLS = [{"type": "function", "function": {"name": "list_lines", "description": "lines",
                                           "parameters": {"type": "object", "properties": {}}}}]


def script(entries):
    st, _, data = T.request(PORT, "POST", "/fake/script", {"Content-Type": "application/json"}, entries)
    assert st == 200, data


def requests():
    st, _, data = T.request(PORT, "GET", "/fake/requests")
    return [r for r in json.loads(data)["requests"] if r["path"] == "/chat/completions"]


def client(**kw):
    kw.setdefault("pauses", (0.05, 0.05, 0.05))
    return llm.Client(KEY, BASE, **kw)


USER = [{"role": "system", "content": "You are a test."}, {"role": "user", "content": "hello"}]


class LlmClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="team-llm-")
        cls.proc = T.Proc([T.FAKE_LLM, "--port", str(PORT), "--key", KEY], cls.dir, "fake-llm", port=PORT)

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        script([])
        self.before = len(requests())

    def new_requests(self):
        return requests()[self.before:]

    def test_streaming_assembly_and_request(self):
        content = "The best line is line 102; it earns most. " * 4
        args = {"sort": "profit_last_month", "limit": 5, "search": "Zażółć gęślą jaźń"}
        script([{"reasoning": "Let me think about the lines carefully.", "content": content,
                 "tool_calls": [{"name": "list_lines", "arguments": args},
                                {"name": "game_overview", "arguments": {}}]}])
        deltas = []
        r = client().chat("deepseek-flash", USER, tools=TOOLS, max_tokens=1234, on_delta=deltas.append,
                          user="company-2")
        self.assertEqual(r["content"], content)
        self.assertEqual("".join(deltas), content)
        self.assertGreater(len(deltas), 3)  # pieces, not one block
        self.assertEqual(r["reasoning"], "Let me think about the lines carefully.")
        self.assertEqual(r["finish_reason"], "tool_calls")
        self.assertEqual([c["function"]["name"] for c in r["tool_calls"]], ["list_lines", "game_overview"])
        self.assertEqual(json.loads(r["tool_calls"][0]["function"]["arguments"]), args)
        self.assertTrue(all(c["id"].startswith("call_") and c["type"] == "function" for c in r["tool_calls"]))
        self.assertFalse(r["usage"]["estimated"])
        self.assertGreater(r["usage"]["completion"], 0)
        reqs = self.new_requests()
        self.assertEqual(len(reqs), 1)
        body = reqs[0]["body"]
        self.assertEqual(reqs[0]["headers"].get("Authorization"), "Bearer ***")
        self.assertEqual((body["stream"], body["stream_options"], body["max_tokens"]),
                         (True, {"include_usage": True}, 1234))
        self.assertEqual(body["thinking"], {"type": "enabled"})
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(body["tools"], TOOLS)
        self.assertEqual(body["user_id"], "company-2")
        self.assertEqual(body["messages"], USER)
        # without tools: no tools and no tool_choice
        script([{"content": "plain"}])
        r = client().chat("deepseek-flash", USER, max_tokens=100)
        body = self.new_requests()[-1]["body"]
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)
        self.assertEqual(r["finish_reason"], "stop")

    def test_usage_and_cost(self):
        script([{"content": "x", "usage": {"prompt_tokens": 1000, "prompt_cache_hit_tokens": 400,
                                           "prompt_cache_miss_tokens": 600, "completion_tokens": 200,
                                           "completion_tokens_details": {"reasoning_tokens": 150}}}])
        u = client().chat("deepseek-v4-pro", USER, max_tokens=100)["usage"]
        self.assertEqual((u["prompt_hit"], u["prompt_miss"], u["completion"], u["reasoning"], u["estimated"]),
                         (400, 600, 200, 150, False))
        flash = llm.cost_usd("deepseek-flash", 400, 600, 200)
        self.assertAlmostEqual(flash, (400 * 0.006 + 600 * 0.30 + 200 * 1.20) / 1e6)
        pro = llm.cost_usd("deepseek-v4-pro", 400, 600, 200)
        self.assertAlmostEqual(pro, (400 * 0.044 + 600 * 1.32 + 200 * 3.96) / 1e6)
        self.assertAlmostEqual(llm.cost_usd("some-new-model", 400, 600, 200), pro)  # unknown: the dearest
        # off-peak factor only when asked for, only outside the peak hours
        sunday = calendar.timegm((2026, 11, 29, 12, 0, 0))
        monday_peak = calendar.timegm((2026, 11, 30, 2, 30, 0))
        self.assertAlmostEqual(llm.cost_usd("deepseek-flash", 0, 1000000, 0, None, sunday), 0.30)
        self.assertAlmostEqual(llm.cost_usd("deepseek-flash", 0, 1000000, 0, 0.5, sunday), 0.15)
        self.assertAlmostEqual(llm.cost_usd("deepseek-flash", 0, 1000000, 0, 0.5, monday_peak), 0.30)
        self.assertEqual(llm.usage_from({"prompt_tokens": 50, "completion_tokens": 5})["prompt_miss"], 50)

    def test_402_stops_without_retry(self):
        script([{"error": 402, "times": 5}])
        with self.assertRaises(llm.LLMError) as cm:
            client().chat("deepseek-flash", USER, max_tokens=100)
        self.assertEqual((cm.exception.kind, cm.exception.message), ("balance", "DeepSeek balance exhausted"))
        self.assertEqual(len(self.new_requests()), 1)

    def test_429_and_5xx_retried(self):
        script([{"error": 429, "times": 2}, {"error": 503}, {"content": "finally"}])
        r = client().chat("deepseek-flash", USER, max_tokens=100)
        self.assertEqual(r["content"], "finally")
        self.assertEqual(len(self.new_requests()), 4)
        script([{"error": 500, "times": 10}])
        before = len(requests())
        with self.assertRaises(llm.LLMError) as cm:
            client().chat("deepseek-flash", USER, max_tokens=100)
        self.assertEqual(cm.exception.kind, "server")
        self.assertEqual(len(requests()) - before, 4)  # 1 + 3 retries

    def test_400_and_401_surfaced(self):
        script([{"error": 400, "message": "messages[3]: tool_call_id is missing (sent key %s)" % KEY}])
        with self.assertRaises(llm.LLMError) as cm:
            client().chat("deepseek-flash", USER, max_tokens=100)
        e = cm.exception
        self.assertEqual((e.kind, e.status), ("bad_request", 400))
        self.assertIn("tool_call_id is missing", e.message)
        self.assertNotIn(KEY, e.message)
        self.assertEqual(len(self.new_requests()), 1)
        script([{"error": 401, "message": "Authentication Fails, your api key %s is invalid" % KEY}])
        with self.assertRaises(llm.LLMError) as cm:
            client().chat("deepseek-flash", USER, max_tokens=100)
        self.assertEqual((cm.exception.kind, cm.exception.message), ("auth", "API key rejected"))
        # a wrong key against the fake (--key): 401 as well
        with self.assertRaises(llm.LLMError) as cm:
            llm.Client("another-key-123456", BASE, pauses=()).chat("deepseek-flash", USER, max_tokens=10)
        self.assertEqual(cm.exception.kind, "auth")
        self.assertNotIn("another-key", repr(llm.Client("another-key-123456", BASE)))

    def test_user_id_fallback(self):
        script([{"error": 400, "message": "Unknown parameter: user_id"}, {"content": "ok"}, {"content": "again"}])
        c = client()
        self.assertEqual(c.chat("deepseek-flash", USER, max_tokens=50, user="company-0")["content"], "ok")
        self.assertEqual(c.chat("deepseek-flash", USER, max_tokens=50, user="company-0")["content"], "again")
        reqs = self.new_requests()
        self.assertEqual([("user_id" in r["body"]) for r in reqs], [True, False, False])

    def test_connection_error_and_timeout(self):
        c = llm.Client(KEY, "http://127.0.0.1:%d" % CLOSED_PORT, pauses=(0.01, 0.01))
        t0 = time.time()
        with self.assertRaises(llm.LLMError) as cm:
            c.chat("deepseek-flash", USER, max_tokens=10)
        self.assertEqual(cm.exception.kind, "network")
        self.assertLess(time.time() - t0, 10)
        script([{"content": "late", "delay": 1.5, "times": 3}])
        c = client(read_timeout=0.4, pauses=(0.01,))
        with self.assertRaises(llm.LLMError) as cm:
            c.chat("deepseek-flash", USER, max_tokens=10)
        self.assertEqual(cm.exception.kind, "timeout")
        time.sleep(1.6)  # let the fake finish the late answers

    def test_cancel_during_the_answer(self):
        script([{"content": "word " * 300, "piece_delay": 0.03}])
        cancel = llm.Cancel()
        got = []

        def on_delta(text):
            got.append(text)
            if len(got) == 3:
                threading.Timer(0.05, cancel.cancel).start()
        t0 = time.time()
        with self.assertRaises(llm.LLMCancelled) as cm:
            client().chat("deepseek-flash", USER, max_tokens=4000, on_delta=on_delta, cancel=cancel)
        self.assertLess(time.time() - t0, 5)
        self.assertLess(len("".join(got)), 1500)
        u = cm.exception.usage
        self.assertTrue(u["estimated"])
        self.assertGreater(u["prompt_miss"], 0)
        # a cancelled Cancel refuses at once
        with self.assertRaises(llm.LLMCancelled):
            client().chat("deepseek-flash", USER, max_tokens=10, cancel=cancel)


if __name__ == "__main__":
    unittest.main()
