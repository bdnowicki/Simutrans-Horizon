"""
HTTP tests of the team foundation of the bridge against the fake engine: tokens from the database, sessions bound to
a company, the /api/team/* routes (access, validation, company isolation, delegation to the R1 runtime stub), the
per-company team event stream, body limits, the protection headers, revoked tokens and the engine agent commands
that a browser can never reach. Bridges 13384-13386, fake engines 13397-13398, temporary databases and logs.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import teamtestlib as T
from team import db as team_db

BP, EP = 13384, 13397
AGENTS = ["coordinator", "analyst", "accountant", "designer", "engineer", "logistician", "dispatcher", "fleet_manager"]
AGENT_COMMANDS = ("agent_tool", "depot_op", "line_op", "convoy_op", "plan_way", "estimate", "depot")
ENV_PLAYER = "env-player-token-0123456789"


def seed(db, company, tag, author):
    """rows of one company: chat of the coordinator (all message kinds), an analyst chat of 5 messages, runs,
    a task, questions, projects and usage"""
    ids = {}
    conv = db.main_conversation(company, "coordinator")
    ids["user_msg"] = db.add_message(company, conv, "user", "%s hello" % tag, author_token_id=author)["id"]
    db.add_message(company, conv, "assistant", "%s answer" % tag, reasoning_content="SECRET-REASONING-%s" % tag,
                   tool_calls=[{"id": "call_1", "type": "function",
                                "function": {"name": "read_lines", "arguments": "{\"limit\": 5}"}}])
    db.add_message(company, conv, "tool", "%s " % tag + "x" * 500, tool_call_id="call_1")
    db.add_message(company, conv, "system_note", "%s note" % tag)
    ids["running"] = db.create_run(company, "coordinator", conv, state="running")
    ids["waiting"] = db.create_run(company, "coordinator", conv, state="waiting")
    ids["done_run"] = db.create_run(company, "coordinator", conv, state="done")
    ids["task"] = db.create_task(company, "coordinator", "analyst", "%s task" % tag, "do it", run_id=ids["waiting"])
    ids["pending_q"] = db.create_question(company, "coordinator", ids["waiting"], conv, {"text": "%s?" % tag})
    ids["answered_q"] = db.create_question(company, "coordinator", ids["waiting"], conv, {"text": "old"})
    db.answer_question(company, ids["answered_q"], "yes", author)
    ids["proposed"] = db.create_project(company, "designer", "%s project" % tag, "why", [{"op": "build_way"}],
                                        estimate={"cost": 5}, preview={"tiles": [[1, 2]]})
    ids["done_p"] = db.create_project(company, "designer", "%s done" % tag, "", [], state="done")
    ids["draft"] = db.create_project(company, "designer", "%s draft" % tag, "", [], state="draft")
    meta = db.add_message(company, conv, "assistant", "%s asks" % tag)
    db.set_message_meta(company, meta["id"], {"question_id": ids["pending_q"], "project_id": ids["proposed"]})
    if company == 0:
        ac = db.main_conversation(company, "analyst")
        ids["analyst"] = [db.add_message(company, ac, "assistant", "a%d" % i)["id"] for i in range(5)]
    db.add_usage(company, "deepseek-flash", 100, 50, 20, 0.01 * (company + 1))
    return ids


class TeamHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="team-http-")
        cls.dbpath = os.path.join(cls.dir, "agents.sqlite")
        db = team_db.TeamDB(cls.dbpath)
        cls.tok, cls.tid = {}, {}
        for key, role, company, label in (("viewer", "viewer", None, "Viewer"), ("p0", "player", 0, "Alice"),
                                          ("p2", "player", 2, "Bob"), ("admin", "admin", 0, "Root"),
                                          ("p0b", "player", 0, "Revoked"), ("p0c", "player", 0, "Revoked by CLI")):
            cls.tid[key], cls.tok[key] = db.add_token(role, company, label)
        cls.ids = {0: seed(db, 0, "c0", cls.tid["p0"]), 2: seed(db, 2, "c2", cls.tid["p2"])}
        db.close()
        cls.engine = T.start_engine(cls.dir, EP, "--players", "3")
        # no key of the language model: the runtime is disabled (reason no_api_key), so the routes are tested
        # without runs (the runtime itself: test_team_runtime.py)
        env = {"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": ENV_PLAYER, "DEEPSEEK_BASE_URL": "http://127.0.0.1:%d" % T.LLM_PORT}
        cls.bridge = T.start_bridge(cls.dir, BP, EP, "--db", cls.dbpath, "--enable-admin", "--test-team", env=env)
        cls.viewer = T.Client(BP, cls.tok["viewer"])
        cls.p0 = T.Client(BP, cls.tok["p0"])
        cls.p2 = T.Client(BP, cls.tok["p2"])
        cls.admin = T.Client(BP, cls.tok["admin"])
        # the company names come with the players feed of the poller
        T.wait_until(lambda: (cls.p2.get("/api/session")[1] or {}).get("company", {}).get("name"), 15)

    @classmethod
    def tearDownClass(cls):
        cls.bridge.kill()
        cls.engine.kill()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        # fresh sessions for every test: the bridge limits the requests per session (30/s, bursts of 60)
        if not self._testMethodName.startswith("test_01"):
            self.viewer, self.p0, self.p2, self.admin = (T.Client(BP, self.tok[k])
                                                         for k in ("viewer", "p0", "p2", "admin"))

    def chat(self, client, agent="coordinator", query=""):
        st, body = client.get("/api/team/chat?agent=%s%s" % (agent, query))
        self.assertEqual(st, 200, body)
        return body

    # -- sign-in and sessions

    def test_01_login_and_session(self):
        for c in (self.viewer, self.p0, self.p2, self.admin):
            self.assertEqual(c.status, 200)
            self.assertTrue(c.cookie)
        self.assertEqual(T.Client(BP, ENV_PLAYER).status, 401)  # the database holds the tokens: env ignored
        log = self.bridge.err()
        self.assertIn("env tokens ignored", log)
        self.assertNotIn(ENV_PLAYER, log)
        for t in self.tok.values():
            self.assertNotIn(t, log)
            self.assertNotIn(t, self.bridge.out())
        self.assertIn("access tokens: in the database", self.bridge.out())
        st, s = self.viewer.get("/api/session")
        self.assertEqual((st, s["role"], s["company"], s["team"]), (200, "viewer", None, False))
        st, s = self.p0.get("/api/session")
        self.assertEqual((s["role"], s["company"], s["team"]), ("player", {"nr": 0, "name": "Human"}, True))
        self.assertEqual(s["allowed"]["action"], ["view", "zoom", "pause", "fast_forward", "tool"])
        st, s = self.p2.get("/api/session")
        self.assertEqual((s["company"], s["team"]), ({"nr": 2, "name": "Company 2"}, True))
        st, s = self.admin.get("/api/session")
        self.assertEqual((s["role"], s["company"]["nr"], s["team"], s["allowed"]["action"][-1]),
                         ("admin", 0, True, "cash"))

    def test_02_interrupted_runs_at_start(self):
        db = team_db.TeamDB(self.dbpath)
        try:
            self.assertEqual(db.get_run(0, self.ids[0]["running"])["state"], "interrupted")
            self.assertEqual(db.get_run(0, self.ids[0]["waiting"])["state"], "waiting")
        finally:
            db.close()

    def test_03_viewer_refused_everywhere(self):
        for path in ("state", "chat?agent=coordinator", "tasks", "projects", "projects?id=1", "questions", "nope"):
            st, body = self.viewer.get("/api/team/" + path)
            self.assertEqual(st, 403, path)
            self.assertIn("error", body)
        s = T.Sse(BP, "/api/team/events", self.viewer.cookie)
        self.assertEqual(s.status, 403)
        s.close()
        for name, body in (("send", {"agent": "coordinator", "text": "hi"}), ("cancel", {"run_id": 1}),
                           ("answer", {"question_id": 1, "answer": "x"}), ("approve", {"project_id": 1}),
                           ("reject", {"project_id": 1}), ("test_publish", {"name": "team_x", "data": {}})):
            st, reply = self.viewer.post("/api/team/" + name, body)
            self.assertEqual(st, 403, name)
            st, _ = self.viewer.post("/api/team/" + name, "x", {"Content-Type": "text/plain"})
            self.assertEqual(st, 403, name)

    # -- state and the disabled runtime

    def test_04_state(self):
        for client, nr, name, mine in ((self.p0, 0, "Human", 0.01), (self.admin, 0, "Human", 0.01),
                                       (self.p2, 2, "Company 2", 0.03)):
            st, s = client.get("/api/team/state")
            self.assertEqual(st, 200, s)
            self.assertEqual(s["company"], {"nr": nr, "name": name})
            self.assertEqual((s["enabled"], s["reason"]), (False, "no_api_key"))
            self.assertEqual([a["id"] for a in s["agents"]], AGENTS)
            for a in s["agents"]:
                # run / run_state: the active run of the agent (R3); the seeded waiting run of the coordinator
                self.assertEqual(set(a), {"id", "model", "busy", "pending_questions", "unread", "run", "run_state"})
                self.assertFalse(a["busy"])
                if a["id"] == "coordinator":
                    self.assertEqual((a["run"], a["run_state"]),
                                     (self.ids[nr]["waiting"], "waiting") if nr in self.ids else (None, None))
                else:
                    self.assertEqual((a["run"], a["run_state"]), (None, None))
            coord = s["agents"][0]
            self.assertEqual((coord["model"], coord["pending_questions"]), ("deepseek-v4-pro", 1))
            self.assertEqual(s["agents"][2]["model"], "deepseek-flash")
            u = s["usage"]
            self.assertEqual(set(u), {"today_usd", "limit_usd", "company_usd", "company_limit_usd", "resets_at"})
            self.assertAlmostEqual(u["today_usd"], 0.04)
            self.assertAlmostEqual(u["company_usd"], mine)
            self.assertEqual((u["limit_usd"], u["company_limit_usd"]), (0.5, None))
        st, _ = self.p0.get("/api/team/state?x=1")
        self.assertEqual(st, 400)

    def test_05_send_refused_while_unavailable(self):
        before = self.chat(self.p0)["messages"]
        st, body = self.p0.post("/api/team/send", {"agent": "coordinator", "text": "please build a line"})
        self.assertEqual((st, body.get("reason")), (503, "no_api_key"))
        self.assertIn("error", body)
        self.assertEqual(self.chat(self.p0)["messages"], before)  # nothing stored
        for body in ({"agent": "boss", "text": "hi"}, {"agent": "coordinator", "text": "   "},
                     {"agent": "coordinator", "text": "x" * 4001}, {"agent": "coordinator"},
                     {"agent": "coordinator", "text": 5}, {"agent": "coordinator", "text": "hi", "extra": 1},
                     {"agent": "coordinator", "text": "a\u0000b"}):
            st, _ = self.p0.post("/api/team/send", body)
            self.assertEqual(st, 400, body)
        st, _ = self.p0.post("/api/team/send", "{not json")
        self.assertEqual(st, 400)
        st, _ = self.p0.post("/api/team/send", "[1]")
        self.assertEqual(st, 400)
        st, _ = self.p0.post("/api/team/send", "{}", {"Content-Type": "text/plain"})
        self.assertEqual(st, 415)
        st, _ = self.p0.post("/api/team/nope", {})
        self.assertEqual(st, 404)

    # -- reads: company isolation and presentation

    def test_06_chat_isolation_and_presentation(self):
        for client, tag, other in ((self.p0, "c0", "c2"), (self.p2, "c2", "c0"), (self.admin, "c0", "c2")):
            st, h, raw = T.request(BP, "GET", "/api/team/chat?agent=coordinator", {"Cookie": client.cookie})
            self.assertEqual(st, 200)
            text = raw.decode("utf-8")
            self.assertNotIn("SECRET-REASONING", text)
            self.assertNotIn("reasoning", text)
            body = json.loads(text)
            self.assertEqual(body["agent"], "coordinator")
            self.assertFalse(body["more"])
            msgs = body["messages"]
            # the seeded running run was interrupted by the start of the bridge: the runtime noted it once
            self.assertEqual([m["role"] for m in msgs], ["user", "assistant", "tool", "system_note", "assistant",
                                                         "system_note"])
            self.assertIn("interrupted by a restart", msgs.pop()["content"])
            self.assertTrue(all(m["content"].startswith(tag) for m in msgs), msgs)
            self.assertFalse(any(other in m["content"] for m in msgs))
            user, assistant, tool, note, asks = msgs
            label = "Alice" if tag == "c0" else "Bob"
            self.assertEqual(user["author"], {"token_id": self.tid["p0" if tag == "c0" else "p2"], "label": label})
            self.assertEqual(assistant["tools"], [{"name": "read_lines", "summary": "{\"limit\": 5}"}])
            self.assertIsNone(assistant["author"])
            self.assertLessEqual(len(tool["content"]), 200)
            self.assertNotIn("tools", note)
            ids = self.ids[0 if tag == "c0" else 2]
            self.assertEqual((asks["question_id"], asks["project_id"]), (ids["pending_q"], ids["proposed"]))
            for m in msgs:
                self.assertTrue({"id", "role", "content", "author", "created"} <= set(m))
        self.assertEqual(self.chat(self.p2, "analyst"), {"agent": "analyst", "messages": [], "more": False})
        page = self.chat(self.p0, "analyst", "&limit=2")
        self.assertEqual(([m["content"] for m in page["messages"]], page["more"]), (["a3", "a4"], True))
        page = self.chat(self.p0, "analyst", "&limit=2&before=%d" % page["messages"][0]["id"])
        self.assertEqual(([m["content"] for m in page["messages"]], page["more"]), (["a1", "a2"], True))
        page = self.chat(self.p0, "analyst", "&before=%d" % page["messages"][0]["id"])
        self.assertEqual(([m["content"] for m in page["messages"]], page["more"]), (["a0"], False))
        for query in ("", "agent=boss", "agent=coordinator&limit=0", "agent=coordinator&limit=101",
                      "agent=coordinator&before=abc", "agent=coordinator&other=1"):
            st, _ = self.p0.get("/api/team/chat?" + query)
            self.assertEqual(st, 400, query)

    def test_07_tasks_projects_questions_isolation(self):
        for client, tag in ((self.p0, "c0"), (self.p2, "c2")):
            nr = 0 if tag == "c0" else 2
            st, body = client.get("/api/team/tasks")
            self.assertEqual([t["title"] for t in body["tasks"]], ["%s task" % tag])
            self.assertEqual(set(body["tasks"][0]), {"id", "from_agent", "to_agent", "title", "body", "state",
                                                     "result", "run_id", "created", "updated"})
            st, body = client.get("/api/team/projects")
            self.assertEqual([p["title"] for p in body["projects"]], ["%s draft" % tag, "%s done" % tag,
                                                                      "%s project" % tag])
            self.assertNotIn("preview", body["projects"][0])
            st, body = client.get("/api/team/projects?id=%d" % self.ids[nr]["proposed"])
            self.assertEqual(st, 200)
            p = body["project"]
            self.assertEqual((p["title"], p["ops"], p["estimate"], p["preview"], p["state"]),
                             ("%s project" % tag, [{"op": "build_way"}], {"cost": 5}, {"tiles": [[1, 2]]}, "proposed"))
            st, body = client.get("/api/team/projects?id=%d" % self.ids[2 - nr]["proposed"])
            self.assertEqual(st, 404)
            st, body = client.get("/api/team/projects?state=done")
            self.assertEqual([p["title"] for p in body["projects"]], ["%s done" % tag])
            st, body = client.get("/api/team/questions")
            self.assertEqual(sorted(q["payload"]["text"] for q in body["questions"]), sorted(["%s?" % tag, "old"]))
            self.assertTrue(all(q["id"] in (self.ids[nr]["pending_q"], self.ids[nr]["answered_q"])
                                for q in body["questions"]))
            st, body = client.get("/api/team/questions?state=pending")
            self.assertEqual([q["id"] for q in body["questions"]], [self.ids[nr]["pending_q"]])
        for path in ("tasks?state=bad", "projects?id=abc", "projects?state=bad", "questions?state=bad"):
            st, _ = self.p0.get("/api/team/" + path)
            self.assertEqual(st, 400, path)

    def test_08_actions_validated_then_delegated(self):
        """the runtime is disabled (no key): what would start something (approve, answer, dismiss) is refused with
        the reason, what only stops something (reject, cancel) is carried out"""
        mine, other = self.ids[0], self.ids[2]
        cases = [
            ("approve", {"project_id": mine["proposed"]}, 503), ("approve", {"project_id": other["proposed"]}, 404),
            ("approve", {"project_id": mine["done_p"]}, 409), ("approve", {"project_id": mine["draft"]}, 409),
            ("approve", {}, 400), ("approve", {"project_id": "abc"}, 400), ("approve", {"project_id": True}, 400),
            ("approve", {"project_id": mine["proposed"], "x": 1}, 400),
            ("answer", {"question_id": mine["pending_q"], "answer": {"choice": 1}}, 503),
            ("answer", {"question_id": mine["pending_q"], "dismiss": True}, 503),
            ("answer", {"question_id": mine["answered_q"], "answer": "x"}, 409),
            ("answer", {"question_id": other["pending_q"], "answer": "x"}, 404),
            ("answer", {"question_id": mine["pending_q"], "answer": "x", "dismiss": True}, 400),
            ("answer", {"question_id": mine["pending_q"]}, 400),
            ("answer", {"question_id": mine["pending_q"], "dismiss": "yes"}, 400),
            ("reject", {"project_id": mine["draft"], "reason": "x" * 1001}, 400),
            ("reject", {"project_id": other["draft"]}, 404), ("reject", {"project_id": mine["done_p"]}, 409),
            ("reject", {"project_id": mine["draft"], "reason": "too expensive"}, 200),
            ("reject", {"project_id": mine["draft"]}, 409),
            ("cancel", {"run_id": other["waiting"]}, 404), ("cancel", {"run_id": mine["done_run"]}, 409),
            ("cancel", {"run_id": mine["running"]}, 409), ("cancel", {"run_id": 0}, 400),
            ("cancel", {"run_id": mine["waiting"]}, 200), ("cancel", {"run_id": mine["waiting"]}, 409),
            ("answer", {"question_id": mine["pending_q"], "answer": {"choice": 1}}, 409),
        ]
        for name, body, want in cases:
            st, reply = self.p0.post("/api/team/" + name, body)
            self.assertEqual(st, want, (name, body, reply))
            if want == 503:
                self.assertEqual(reply.get("reason"), "no_api_key")
            if want == 200:
                self.assertTrue(reply.get("accepted"), reply)
        st, body = self.p0.get("/api/team/projects?id=%d" % mine["proposed"])
        self.assertEqual(body["project"]["state"], "proposed")
        st, body = self.p0.get("/api/team/projects?id=%d" % mine["draft"])
        self.assertEqual(body["project"]["state"], "rejected")
        db = team_db.TeamDB(self.dbpath)
        try:
            self.assertEqual(db.get_run(0, mine["waiting"])["state"], "cancelled")
            self.assertEqual(db.get_question(0, mine["pending_q"])["state"], "dismissed")
            # company 2 untouched
            self.assertEqual(db.get_run(2, other["waiting"])["state"], "waiting")
            self.assertEqual(db.get_question(2, other["pending_q"])["state"], "pending")
            self.assertEqual(db.get_project(2, other["draft"])["state"], "draft")
        finally:
            db.close()

    # -- request protection

    def test_09_body_limits_and_headers(self):
        big = json.dumps({"agent": "coordinator", "text": "x" * (33 * 1024)})
        st, _ = self.p0.post("/api/team/send", big)
        self.assertEqual(st, 413)
        mid = json.dumps({"agent": "coordinator", "text": "x" * (20 * 1024)})
        st, body = self.p0.post("/api/team/send", mid)
        self.assertEqual(st, 400)  # within the 32 KB of the team: refused for the text, not the size
        self.assertIn("too long", body["error"])
        st, _ = self.p0.post("/api/pause", mid)
        self.assertEqual(st, 413)  # other routes keep 16 KB
        st, _ = self.p0.post("/api/team/send", "[" * 30000)
        self.assertEqual(st, 400)  # nested too deep: refused, not a crash
        send = {"agent": "coordinator", "text": "hi"}
        for headers in ({"X-Dashboard": None}, {"Origin": None}, {"Origin": "http://evil.example"},
                        {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            st, _ = self.p0.post("/api/team/send", send, headers)
            self.assertEqual(st, 403, headers)
        st, _ = self.p0.get("/api/team/state", {"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(st, 403)
        st, _, _ = T.request(BP, "GET", "/api/team/state")
        self.assertEqual(st, 401)

    def test_10_agent_commands_not_proxied(self):
        for client in (self.p0, self.admin, self.viewer):
            for cmd in AGENT_COMMANDS:
                time.sleep(0.05)  # stay below the request limit of the session
                st, _ = client.get("/api/%s?player=0&x=1&y=1&tool=tool_build_way" % cmd)
                self.assertEqual(st, 403, cmd)
                st, _ = client.post("/api/" + cmd, {"player": 0, "x": 1, "y": 1, "tool": "tool_build_way",
                                                    "param": "fake_road", "x2": 3, "y2": 1})
                self.assertEqual(st, 403, cmd)
        self.assertEqual(T.call(EP, "fake_agent_state")["objects"], [])  # nothing reached the game
        st, body = self.p0.post("/api/tool", {"tool": "tool_build_way", "x": 1, "y": 1, "player": 2})
        self.assertEqual(st, 400)

    # -- team event streams

    def publish(self, client, data, name="team_message"):
        st, body = client.post("/api/team/test_publish", {"name": name, "data": data})
        self.assertEqual(st, 200, body)
        return body["id"]

    def test_11_team_events_isolation(self):
        s0 = T.Sse(BP, "/api/team/events", self.p0.cookie)
        s2 = T.Sse(BP, "/api/team/events", self.p2.cookie)
        sa = T.Sse(BP, "/api/team/events", self.admin.cookie)
        main = T.Sse(BP, "/api/events", self.p0.cookie)
        try:
            self.assertEqual((s0.status, s0.headers.get("content-type")), (200, "text/event-stream; charset=utf-8"))
            for s, nr in ((s0, 0), (s2, 2), (sa, 0)):
                hello = s.wait(lambda e: e.get("event") == "hello", 5)
                self.assertEqual(hello["json"], {"company": nr, "resync": True})
                self.assertEqual(hello.get("retry"), "3000")
            self.publish(self.p0, {"secret": "of company 0"})
            ev = s0.wait(lambda e: e.get("event") == "team_message", 5)
            self.assertEqual(ev["json"], {"secret": "of company 0"})
            self.assertIsNotNone(sa.wait(lambda e: e.get("event") == "team_message", 5))
            self.publish(self.p2, {"secret": "of company 2"}, "team_task")
            self.assertEqual(s2.wait(lambda e: e.get("event", "").startswith("team_"), 5)["json"],
                             {"secret": "of company 2"})
            time.sleep(1.0)
            self.assertIsNone(s2.wait(lambda e: e.get("json") == {"secret": "of company 0"}, 0.5))
            self.assertIsNone(s0.wait(lambda e: e.get("json") == {"secret": "of company 2"}, 0.5))
            self.assertIsNone(main.wait(lambda e: e.get("event", "").startswith("team_"), 1.0))
            st, _ = self.p0.post("/api/team/test_publish", {"name": "snapshot", "data": {}})
            self.assertEqual(st, 400)
        finally:
            for s in (s0, s2, sa, main):
                s.close()

    def test_12_team_events_replay(self):
        ids = [self.publish(self.p0, {"n": i}) for i in range(3)]
        self.publish(self.p2, {"n": "other"})
        s = T.Sse(BP, "/api/team/events", self.p0.cookie, last_id=ids[0])
        try:
            hello = s.wait(lambda e: e.get("event") == "hello", 5)
            self.assertEqual((hello["id"], hello["json"]["resync"]), (str(ids[0]), False))
            got = [s.wait(lambda e: e.get("event") == "team_message", 5) for _ in range(2)]
            self.assertEqual([(int(e["id"]), e["json"]) for e in got], [(ids[1], {"n": 1}), (ids[2], {"n": 2})])
            self.assertIsNone(s.wait(lambda e: e.get("event") == "team_message", 1.0))
        finally:
            s.close()
        for last in ("garbage", "5", str(ids[-1] + 1000)):
            s = T.Sse(BP, "/api/team/events", self.p0.cookie, last_id=last)
            try:
                self.assertTrue(s.wait(lambda e: e.get("event") == "hello", 5)["json"]["resync"], last)
            finally:
                s.close()

    def test_13_revoked_token(self):
        c = T.Client(BP, self.tok["p0b"])
        self.assertEqual(c.get("/api/session")[0], 200)
        stream = T.Sse(BP, "/api/team/events", c.cookie)
        main = T.Sse(BP, "/api/events", c.cookie)
        self.assertEqual((stream.status, main.status), (200, 200))
        db = team_db.TeamDB(self.dbpath)
        try:
            self.assertTrue(db.revoke_token(self.tid["p0b"]))
        finally:
            db.close()
        t0 = time.time()
        self.assertTrue(T.wait_until(lambda: c.get("/api/session")[0] == 401, 5))
        self.assertLess(time.time() - t0, 4.5)
        self.assertEqual(c.get("/api/team/state")[0], 401)
        self.assertIsNone(stream.wait(lambda e: False, 8))
        self.assertTrue(stream.ended)
        self.assertIsNone(main.wait(lambda e: False, 1))
        self.assertTrue(main.ended)
        stream.close()
        main.close()
        self.assertEqual(T.Client(BP, self.tok["p0b"]).status, 401)
        # revoked with the CLI while the bridge runs
        c = T.Client(BP, self.tok["p0c"])
        self.assertEqual(c.get("/api/session")[0], 200)
        p = subprocess.run([sys.executable, T.BRIDGE, "token", "revoke", str(self.tid["p0c"]), "--db", self.dbpath],
                           capture_output=True, text=True, env=T.clean_env(), timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(T.wait_until(lambda: c.get("/api/session")[0] == 401, 5))

    def test_14_cli_token_added_while_running(self):
        p = subprocess.run([sys.executable, T.BRIDGE, "token", "add", "--role", "player", "--company", "2", "--label",
                            "Carol", "--db", self.dbpath], capture_output=True, text=True, env=T.clean_env(), timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        c = T.Client(BP, p.stdout.strip().splitlines()[-1])
        self.assertEqual(c.status, 200)
        st, s = c.get("/api/session")
        self.assertEqual((s["company"]["nr"], s["team"]), (2, True))
        self.assertEqual([t["title"] for t in c.get("/api/team/tasks")[1]["tasks"]], ["c2 task"])

    def test_15_stream_limit_shared(self):
        time.sleep(3)  # streams of earlier tests are noticed closed at their next heartbeat (2 s)
        viewers = [T.Client(BP, self.tok["viewer"]) for _ in range(3)]
        streams = [T.Sse(BP, "/api/events", viewers[i % 3].cookie) for i in range(60)]
        streams += [T.Sse(BP, "/api/team/events", self.p0.cookie) for _ in range(4)]
        try:
            self.assertTrue(all(s.status == 200 for s in streams), [s.status for s in streams])
            extra_team = T.Sse(BP, "/api/team/events", self.p2.cookie)
            extra_main = T.Sse(BP, "/api/events", self.p2.cookie)
            self.assertEqual((extra_team.status, extra_main.status), (503, 503))
            extra_team.close()
            extra_main.close()
        finally:
            for s in streams:
                s.close()
        time.sleep(3)
        again = T.Sse(BP, "/api/team/events", self.p2.cookie)
        self.assertEqual(again.status, 200)
        again.close()

    def test_16_no_tracebacks(self):
        log = self.bridge.err()
        self.assertNotIn("Traceback", log)
        self.assertNotIn("fake-key-for-tests-0001", log + self.bridge.out())


class TeamReasonTests(unittest.TestCase):
    """state reasons with other engines and settings; one bridge (13385/13386) and fake engine (13398) per test"""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="team-reason-")
        self.procs = []

    def tearDown(self):
        for p in reversed(self.procs):
            p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)

    def start(self, engine_flags, bridge_port, bridge_flags=(), env=None):
        self.procs.append(T.start_engine(self.dir, T.ENGINE_PORTS[1], *engine_flags))
        bridge = T.start_bridge(self.dir, bridge_port, T.ENGINE_PORTS[1], *bridge_flags, env=env)
        self.procs.append(bridge)
        return bridge

    def reason(self, client):
        st, s = client.get("/api/team/state")
        return s.get("reason") if st == 200 else st

    def test_no_engine_agent_mode_in_memory_db(self):
        env = {"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": ENV_PLAYER, "SIMUTRANS_DASHBOARD_PLAYER_COMPANY": "2",
               "DEEPSEEK_API_KEY": "fake-key-for-tests-0002"}
        bridge = self.start(("--read-only", "--players", "3"), 13385, env=env)
        c = T.Client(13385, ENV_PLAYER)
        self.assertEqual(c.status, 200)  # in memory: the env tokens, as before the database
        self.assertEqual(T.wait_until(lambda: self.reason(c) == "no_engine_agent_mode" and self.reason(c), 10),
                         "no_engine_agent_mode")
        st, s = c.get("/api/session")
        self.assertEqual((s["company"]["nr"], s["team"], s["allowed"]["action"]), (2, True, []))
        st, body = c.post("/api/team/send", {"agent": "analyst", "text": "hi"})
        self.assertEqual((st, body["reason"]), (503, "no_engine_agent_mode"))
        self.assertIn("player http://127.0.0.1:13385/?token=" + ENV_PLAYER, bridge.out())
        self.assertIn("team history is not kept; pass --db", bridge.err())

    def test_no_api_key_then_env_file(self):
        env = {"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": ENV_PLAYER}
        self.start(("--read-only", "--agent"), 13386, env=env)
        c = T.Client(13386, ENV_PLAYER)
        self.assertEqual(T.wait_until(lambda: self.reason(c) == "no_api_key" and self.reason(c), 10), "no_api_key")
        self.procs.pop().kill()
        T.wait_free(13386)
        envfile = os.path.join(self.dir, ".env")
        with open(envfile, "w", encoding="utf-8") as f:
            f.write("# test\nDEEPSEEK_API_KEY=\"fake-key-from-env-file-03\"\n")
        bridge = T.start_bridge(self.dir, 13386, T.ENGINE_PORTS[1], "--env-file", envfile, env=env, name="bridge-env")
        self.procs.append(bridge)
        c = T.Client(13386, ENV_PLAYER)
        # with the key (and an engine with agent mode) the team is enabled: no reason
        self.assertTrue(T.wait_until(lambda: (c.get("/api/team/state")[1] or {}).get("enabled"), 10))
        self.assertNotIn("reason", c.get("/api/team/state")[1])
        self.assertNotIn("fake-key-from-env-file-03", bridge.err() + bridge.out())
        self.assertIn("took 1 settings from", bridge.err())

    def test_no_team(self):
        env = {"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": ENV_PLAYER, "DEEPSEEK_API_KEY": "fake-key-for-tests-0004"}
        self.start((), 13386, ("--no-team",), env=env)
        c = T.Client(13386, ENV_PLAYER)
        self.assertEqual(c.get("/api/team/state")[0], 404)
        self.assertEqual(c.post("/api/team/send", {"agent": "analyst", "text": "hi"})[0], 404)
        s = T.Sse(13386, "/api/team/events", c.cookie)
        self.assertEqual(s.status, 404)
        s.close()
        self.assertEqual(c.get("/api/session")[1]["team"], False)


if __name__ == "__main__":
    unittest.main()
