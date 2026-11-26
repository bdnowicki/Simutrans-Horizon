"""
Tests of the fake DeepSeek API (tools/dashboard/dev/fake_llm.py) on port 13389: streaming pieces, keep-alive lines,
the usage chunk, tool call assembly, the DeepSeek rules (Authorization, reasoning_content, tool_choice), scripted
replies (match, FIFO, times), error injection, delays and the request log.
"""

import http.client
import json
import os
import shutil
import tempfile
import time
import unittest

import teamtestlib as T

PORT = T.LLM_PORT
KEY = "fake-test-key-0123456789"
AUTH = {"Authorization": "Bearer " + KEY, "Content-Type": "application/json"}


def post(path, body, headers=AUTH):
    return T.request(PORT, "POST", path, headers, body)


def chat(body, headers=AUTH):
    st, _, data = post("/chat/completions", dict({"model": "deepseek-flash"}, **body), headers)
    return st, T.jbody(data)


def stream(body):
    """(status, events (parsed JSON chunks), comment lines, raw lines) of a streamed completion."""
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=15)
    conn.request("POST", "/chat/completions", json.dumps(dict({"model": "deepseek-flash", "stream": True}, **body)),
                 dict(AUTH, Host="127.0.0.1:%d" % PORT))
    r = conn.getresponse()
    raw = r.read().decode("utf-8")
    conn.close()
    lines = [ln for ln in raw.split("\n") if ln]
    events = [json.loads(ln[6:]) for ln in lines if ln.startswith("data: ") and ln != "data: [DONE]"]
    comments = [ln for ln in lines if ln.startswith(":")]
    return r.status, events, comments, lines


def script(entries):
    st, _, data = post("/fake/script", entries, {"Content-Type": "application/json"})
    assert st == 200, data


USER = [{"role": "user", "content": "hello"}]


class FakeLlmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="fake-llm-")
        cls.log = os.path.join(cls.dir, "requests.jsonl")
        cls.proc = T.Proc([T.FAKE_LLM, "--port", str(PORT), "--log", cls.log, "--key", KEY], cls.dir, "fake-llm",
                          port=PORT)

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        script([])

    def test_auth(self):
        st, body = chat({"messages": USER}, {"Content-Type": "application/json"})
        self.assertEqual(st, 401)
        self.assertEqual(body["error"]["type"], "authentication_error")
        st, _ = chat({"messages": USER}, {"Authorization": "Bearer wrong-key", "Content-Type": "application/json"})
        self.assertEqual(st, 401)
        st, _, _ = T.request(PORT, "GET", "/models")
        self.assertEqual(st, 401)

    def test_models_and_balance(self):
        st, _, data = T.request(PORT, "GET", "/models", AUTH)
        self.assertEqual(st, 200)
        self.assertEqual([m["id"] for m in T.jbody(data)["data"]], ["deepseek-flash", "deepseek-v4-pro"])
        st, _, data = T.request(PORT, "GET", "/user/balance", AUTH)
        self.assertEqual(st, 200)
        self.assertTrue(T.jbody(data)["is_available"])

    def test_default_reply_and_thinking(self):
        st, body = chat({"messages": USER})
        self.assertEqual(st, 200)
        msg = body["choices"][0]["message"]
        self.assertEqual(msg["content"], "OK (fake)")
        self.assertTrue(msg["reasoning_content"])
        self.assertEqual(body["choices"][0]["finish_reason"], "stop")
        self.assertEqual(set(body["usage"]) >= {"prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens",
                                                "prompt_cache_miss_tokens", "completion_tokens_details"}, True)
        st, body = chat({"messages": USER, "thinking": {"type": "disabled"}})
        self.assertNotIn("reasoning_content", body["choices"][0]["message"])

    def test_stream_pieces_tool_calls_and_usage(self):
        args = {"region": [10, 20, 30, 40], "mode": "summary", "note": "a longer argument string"}
        script([{"reasoning": "I should look at the lines first.", "content": "Let me check the lines.",
                 "tool_calls": [{"name": "read_lines", "arguments": args}, {"name": "read_players", "arguments": {}}]}])
        st, events, comments, lines = stream({"messages": USER, "stream_options": {"include_usage": True}})
        self.assertEqual(st, 200)
        self.assertEqual(lines[-1], "data: [DONE]")
        self.assertTrue(comments and all(c == ": keep-alive" for c in comments))
        deltas = [e["choices"][0]["delta"] for e in events if e["choices"]]
        reasoning = [d["reasoning_content"] for d in deltas if "reasoning_content" in d]
        content = [d["content"] for d in deltas if d.get("content")]
        self.assertGreater(len(reasoning), 1)
        self.assertGreater(len(content), 1)
        self.assertEqual("".join(reasoning), "I should look at the lines first.")
        self.assertEqual("".join(content), "Let me check the lines.")
        calls = {}
        for d in deltas:
            for tc in d.get("tool_calls") or ():
                c = calls.setdefault(tc["index"], {"id": None, "name": None, "args": "", "first": tc})
                if "id" in tc:
                    c["id"], c["name"] = tc["id"], tc["function"]["name"]
                    self.assertEqual(tc["type"], "function")
                c["args"] += tc["function"].get("arguments", "")
        self.assertEqual(sorted(calls), [0, 1])
        self.assertEqual(calls[0]["name"], "read_lines")
        self.assertEqual(calls[0]["first"]["function"]["arguments"], "")
        self.assertTrue(calls[0]["id"].startswith("call_"))
        self.assertEqual(json.loads(calls[0]["args"]), args)
        self.assertEqual(json.loads(calls[1]["args"]), {})
        self.assertGreater(sum(1 for d in deltas for tc in d.get("tool_calls") or () if tc["index"] == 0), 2)
        finals = [e for e in events if e["choices"] and e["choices"][0]["finish_reason"]]
        self.assertEqual([e["choices"][0]["finish_reason"] for e in finals], ["tool_calls"])
        usage = [e for e in events if not e["choices"]]
        self.assertEqual(len(usage), 1)
        self.assertIs(events[-1], usage[0])
        u = usage[0]["usage"]
        self.assertEqual(u["prompt_cache_hit_tokens"] + u["prompt_cache_miss_tokens"], u["prompt_tokens"])
        self.assertIn("reasoning_tokens", u["completion_tokens_details"])
        # without include_usage: no usage chunk
        st, events, _, _ = stream({"messages": USER})
        self.assertFalse([e for e in events if not e["choices"]])
        self.assertEqual(events[-1]["choices"][0]["finish_reason"], "stop")

    def test_reasoning_content_rule(self):
        history = USER + [{"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "type": "function", "function": {"name": "x", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "{}"}]
        st, body = chat({"messages": history})
        self.assertEqual(st, 400)
        self.assertIn("reasoning_content", body["error"]["message"])
        st, _ = chat({"messages": history, "thinking": {"type": "disabled"}})
        self.assertEqual(st, 200)
        history[1]["reasoning_content"] = "because"
        st, _ = chat({"messages": history})
        self.assertEqual(st, 200)

    def test_tool_choice_rule(self):
        tools = [{"type": "function", "function": {"name": "x", "parameters": {"type": "object"}}}]
        for choice in ("required", {"type": "function", "function": {"name": "x"}}):
            st, _ = chat({"messages": USER, "tools": tools, "tool_choice": choice})
            self.assertEqual(st, 400, choice)
            st, _ = chat({"messages": USER, "tools": tools, "tool_choice": choice, "thinking": {"type": "disabled"}})
            self.assertEqual(st, 200, choice)
        st, _ = chat({"messages": USER, "tools": tools, "tool_choice": "auto"})
        self.assertEqual(st, 200)

    def test_script_match_fifo_times_and_errors(self):
        script([{"error": 429, "times": 2}, {"content": "second"},
                {"match": "budget", "content": "about the budget", "times": 2}, {"error": 402}])
        self.assertEqual(chat({"messages": [{"role": "user", "content": "what is our budget?"}]})[1]
                         ["choices"][0]["message"]["content"], "about the budget")
        self.assertEqual(chat({"messages": USER})[0], 429)
        self.assertEqual(chat({"messages": USER})[0], 429)
        self.assertEqual(chat({"messages": USER})[1]["choices"][0]["message"]["content"], "second")
        tool_turn = USER + [{"role": "assistant", "content": "", "reasoning_content": "r", "tool_calls": [
            {"id": "c", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c", "content": "the budget is 5"}]
        self.assertEqual(chat({"messages": tool_turn})[1]["choices"][0]["message"]["content"], "about the budget")
        st, body = chat({"messages": USER})
        self.assertEqual((st, body["error"]["type"]), (402, "insufficient_balance"))
        self.assertEqual(chat({"messages": USER})[1]["choices"][0]["message"]["content"], "OK (fake)")
        for code in (400, 401, 500, 503):
            script([{"error": code}])
            self.assertEqual(chat({"messages": USER})[0], code)

    def test_delay_and_validation(self):
        script([{"content": "slow", "delay": 0.5}])
        t0 = time.time()
        st, body = chat({"messages": USER})
        self.assertGreaterEqual(time.time() - t0, 0.45)
        self.assertEqual(body["choices"][0]["message"]["content"], "slow")
        self.assertEqual(chat({"messages": []})[0], 400)
        st, _, _ = post("/chat/completions", {"messages": USER})  # no model
        self.assertEqual(st, 400)
        st, _, _ = post("/fake/script", {"not": "a list"}, {"Content-Type": "application/json"})
        self.assertEqual(st, 400)

    def test_request_log_masks_the_key(self):
        chat({"messages": [{"role": "user", "content": "log me"}]})
        with open(self.log, encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn(KEY, text)
        entries = [json.loads(ln) for ln in text.splitlines()]
        last = [e for e in entries if e["path"] == "/chat/completions"][-1]
        self.assertEqual(last["headers"].get("Authorization"), "Bearer ***")
        self.assertEqual(last["body"]["messages"][-1]["content"], "log me")
        st, _, data = T.request(PORT, "GET", "/fake/requests")
        self.assertEqual(st, 200)
        self.assertNotIn(KEY, data.decode())


if __name__ == "__main__":
    unittest.main()
