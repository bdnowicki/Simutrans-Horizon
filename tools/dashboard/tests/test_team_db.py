"""
Unit tests of the team database (team/db.py), the env token import of the bridge (prepare_tokens), the env file
reader and the per-company event streams (team/events.py). No processes, temporary files only.
"""

import hashlib
import importlib.util
import logging
import os
import shutil
import sqlite3
import tempfile
import unittest

import teamtestlib as T  # noqa: F401  (puts tools/dashboard on sys.path)
from team import TeamError
from team import db as team_db
from team import engine as team_engine
from team import events as team_events

ENV = {"SIMUTRANS_DASHBOARD_TOKEN_VIEWER": "viewer-token-0123456789",
       "SIMUTRANS_DASHBOARD_TOKEN_PLAYER": "player-token-0123456789",
       "SIMUTRANS_DASHBOARD_TOKEN_ADMIN": "admin-token-0123456789A"}


def load_bridge():
    spec = importlib.util.spec_from_file_location("dash_under_test", T.BRIDGE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TempDir(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="team-db-")
        self.dbs = []

    def tearDown(self):
        for db in self.dbs:
            db.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def open(self, name="t.sqlite"):
        db = team_db.TeamDB(os.path.join(self.dir, name) if name else None)
        self.dbs.append(db)
        return db


class SchemaTests(TempDir):
    TABLES = {"settings", "tokens", "conversations", "messages", "runs", "tasks", "questions", "projects", "usage"}

    def tables(self, db):
        return {r["name"] for r in db._all("SELECT name FROM sqlite_master WHERE type='table'")}

    def test_memory_schema(self):
        db = self.open(None)
        self.assertTrue(db.memory)
        self.assertEqual(self.tables(db), self.TABLES)
        self.assertEqual(db.schema_version(), team_db.SCHEMA_VERSION)
        self.assertEqual(db.get_setting("daily_limit_usd"), "0.50")
        self.assertIsNone(db.get_setting("company_limit_usd"))
        self.assertEqual(db.limits(), (0.5, None))

    def test_file_mode_wal_foreign_keys_and_parent_dir(self):
        db = self.open(os.path.join("sub", "dir", "agents.sqlite"))
        self.assertFalse(db.memory)
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "sub", "dir", "agents.sqlite")))
        self.assertEqual(db._one("PRAGMA journal_mode")["journal_mode"], "wal")
        self.assertEqual(db._one("PRAGMA foreign_keys")["foreign_keys"], 1)
        with self.assertRaises(sqlite3.IntegrityError):
            db._run("INSERT INTO messages(conversation_id, role, content, created) VALUES(999, 'user', 'x', 'now')")

    def test_migrations_idempotent(self):
        db = self.open()
        db.set_setting("daily_limit_usd", "1.25")
        db.migrate()
        db.migrate()
        db.close()
        db2 = self.open()
        self.assertEqual(db2.schema_version(), 1)
        self.assertEqual(db2.get_setting("daily_limit_usd"), "1.25")  # defaults never overwrite a setting
        self.assertEqual(db2._one("SELECT COUNT(*) AS n FROM settings WHERE key='schema_version'")["n"], 1)

    def test_later_migration_runs_once(self):
        db = self.open()
        db.close()
        calls = []

        def v2(conn):
            calls.append(1)
            conn.execute("ALTER TABLE tasks ADD COLUMN priority INTEGER")
        old_version, old_migrations = team_db.SCHEMA_VERSION, dict(team_db.MIGRATIONS)
        team_db.SCHEMA_VERSION = 2
        team_db.MIGRATIONS[2] = v2
        try:
            db2 = self.open()
            self.assertEqual(db2.schema_version(), 2)
            db2.close()
            db3 = self.open()
            self.assertEqual(calls, [1])
            cols = [r["name"] for r in db3._all("PRAGMA table_info(tasks)")]
            self.assertIn("priority", cols)
        finally:
            team_db.SCHEMA_VERSION = old_version
            team_db.MIGRATIONS.clear()
            team_db.MIGRATIONS.update(old_migrations)

    def test_failed_migration_rolls_back(self):
        db = self.open()
        db.close()

        def broken(conn):
            conn.execute("ALTER TABLE tasks ADD COLUMN half INTEGER")
            raise RuntimeError("broken migration")
        old_version, old_migrations = team_db.SCHEMA_VERSION, dict(team_db.MIGRATIONS)
        team_db.SCHEMA_VERSION = 2
        team_db.MIGRATIONS[2] = broken
        try:
            with self.assertRaises(RuntimeError):
                team_db.TeamDB(os.path.join(self.dir, "t.sqlite"))
        finally:
            team_db.SCHEMA_VERSION = old_version
            team_db.MIGRATIONS.clear()
            team_db.MIGRATIONS.update(old_migrations)
        db2 = self.open()
        self.assertEqual(db2.schema_version(), 1)
        self.assertNotIn("half", [r["name"] for r in db2._all("PRAGMA table_info(tasks)")])

    def test_newer_schema_refused(self):
        db = self.open()
        db.set_setting("schema_version", "99")
        db.close()
        with self.assertRaises(RuntimeError) as cm:
            team_db.TeamDB(os.path.join(self.dir, "t.sqlite"))
        self.assertIn("newer", str(cm.exception))


class TokenTests(TempDir):
    def test_add_lookup_list_revoke(self):
        db = self.open()
        tid, token = db.add_token("player", 2, "Alice")
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(db.lookup_token(token), {"id": tid, "role": "player", "company": 2, "label": "Alice"})
        self.assertIsNone(db.lookup_token(token + "x"))
        self.assertIsNone(db.lookup_token(""))
        rows = db.list_tokens()
        self.assertEqual(len(rows), 1)
        self.assertEqual(set(rows[0]), {"id", "role", "company", "label", "created", "revoked"})
        self.assertTrue(db.token_active(tid))
        self.assertTrue(db.revoke_token(tid))
        self.assertFalse(db.revoke_token(tid))
        self.assertFalse(db.token_active(tid))
        self.assertIsNone(db.lookup_token(token))
        self.assertIsNotNone(db.list_tokens()[0]["revoked"])
        self.assertFalse(db.revoke_token(12345))

    def test_only_hashes_stored(self):
        db = self.open()
        _, token = db.add_token("admin", 0, None)
        row = db._one("SELECT * FROM tokens")
        self.assertEqual(row["hash"], hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(token, [str(v) for v in row.values()])
        db.close()
        for name in os.listdir(self.dir):
            with open(os.path.join(self.dir, name), "rb") as f:
                self.assertNotIn(token.encode(), f.read(), name)

    def test_role_company_rules(self):
        db = self.open(None)
        for role, company in (("player", None), ("player", 1), ("player", 15), ("player", -1), ("admin", None),
                              ("viewer", 0), ("root", 0), ("player", True)):
            with self.assertRaises(ValueError, msg=(role, company)):
                db.add_token(role, company)
        db.add_token("viewer", None)
        db.add_token("player", 0)
        db.add_token("player", 14)
        with self.assertRaises(ValueError):
            db.add_token("player", 0, "x" * 101)

    def test_env_tokens_validation(self):
        self.assertEqual([r for r, _ in team_db.env_tokens(ENV, True)], ["viewer", "player", "admin"])
        self.assertEqual([r for r, _ in team_db.env_tokens(ENV, False)], ["viewer", "player"])
        with self.assertRaises(ValueError):
            team_db.env_tokens({"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": "short"}, False)
        with self.assertRaises(ValueError):
            team_db.env_tokens({"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": "bad token with spaces!!"}, False)
        with self.assertRaises(ValueError):
            team_db.env_tokens({"SIMUTRANS_DASHBOARD_TOKEN_VIEWER": "same-token-0123456789",
                                "SIMUTRANS_DASHBOARD_TOKEN_PLAYER": "same-token-0123456789"}, False)
        self.assertEqual(team_db.env_player_company({}), 0)
        self.assertEqual(team_db.env_player_company({"SIMUTRANS_DASHBOARD_PLAYER_COMPANY": "3"}), 3)
        for bad in ("1", "15", "-2", "x"):
            with self.assertRaises(ValueError):
                team_db.env_player_company({"SIMUTRANS_DASHBOARD_PLAYER_COMPANY": bad})


class EnvImportTests(TempDir):
    @classmethod
    def setUpClass(cls):
        cls.bridge = load_bridge()

    def test_file_db_imports_once(self):
        db = self.open()
        pairs = self.bridge.prepare_tokens(db, True, dict(ENV, SIMUTRANS_DASHBOARD_PLAYER_COMPANY="2"))
        self.assertEqual(pairs, [("viewer", ENV["SIMUTRANS_DASHBOARD_TOKEN_VIEWER"]),
                                 ("player", ENV["SIMUTRANS_DASHBOARD_TOKEN_PLAYER"]),
                                 ("admin", ENV["SIMUTRANS_DASHBOARD_TOKEN_ADMIN"])])
        self.assertEqual(db.lookup_token(ENV["SIMUTRANS_DASHBOARD_TOKEN_PLAYER"])["company"], 2)
        self.assertEqual(db.lookup_token(ENV["SIMUTRANS_DASHBOARD_TOKEN_ADMIN"])["company"], 2)
        self.assertIsNone(db.lookup_token(ENV["SIMUTRANS_DASHBOARD_TOKEN_VIEWER"])["company"])
        db.close()
        db2 = self.open()
        other = {"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": "another-player-token-0123"}
        with self.assertLogs("dashboard", logging.WARNING) as logs:
            self.assertEqual(self.bridge.prepare_tokens(db2, True, other), [])
        self.assertIn("env tokens ignored", "\n".join(logs.output))
        self.assertNotIn("another-player-token-0123", "\n".join(logs.output))
        self.assertIsNone(db2.lookup_token("another-player-token-0123"))
        self.assertEqual(db2.token_count(), 3)

    def test_missing_roles_get_random_tokens(self):
        db = self.open()
        pairs = self.bridge.prepare_tokens(db, False, {"SIMUTRANS_DASHBOARD_TOKEN_PLAYER": "player-token-0123456789"})
        self.assertEqual([r for r, _ in pairs], ["viewer", "player"])
        self.assertEqual(pairs[1][1], "player-token-0123456789")
        self.assertGreaterEqual(len(pairs[0][1]), 16)
        self.assertEqual(db.lookup_token(pairs[0][1])["role"], "viewer")

    def test_memory_db_imports_every_start(self):
        for _ in range(2):
            db = self.open(None)
            self.assertEqual(len(self.bridge.prepare_tokens(db, True, ENV)), 3)
            self.assertEqual(db.lookup_token(ENV["SIMUTRANS_DASHBOARD_TOKEN_ADMIN"])["role"], "admin")

    def test_invalid_env_stops_the_start(self):
        db = self.open(None)
        with self.assertRaises(SystemExit):
            self.bridge.prepare_tokens(db, False, {"SIMUTRANS_DASHBOARD_PLAYER_COMPANY": "1"})
        with self.assertRaises(SystemExit):
            self.bridge.prepare_tokens(db, False, {"SIMUTRANS_DASHBOARD_TOKEN_VIEWER": "short"})

    def test_env_file(self):
        path = os.path.join(self.dir, ".env")
        with open(path, "w", encoding="utf-8") as f:
            f.write("# comment\n\nDEEPSEEK_API_KEY='sk-fake-123'\nexport DEEPSEEK_BASE_URL=\"http://127.0.0.1:13389\"\n"
                    "PLAIN=value # trailing comment\nKEPT=from-file\n")
        environ = {"KEPT": "from-env"}
        self.assertEqual(self.bridge.load_env_file(path, environ), 3)
        self.assertEqual(environ, {"DEEPSEEK_API_KEY": "sk-fake-123", "DEEPSEEK_BASE_URL": "http://127.0.0.1:13389",
                                   "PLAIN": "value", "KEPT": "from-env"})
        with open(path, "w", encoding="utf-8") as f:
            f.write("SECRET_LINE_WITHOUT_EQUALS sk-should-not-be-shown\n")
        with self.assertRaises(SystemExit) as cm:
            self.bridge.load_env_file(path, {})
        self.assertNotIn("sk-should-not-be-shown", str(cm.exception))
        with self.assertRaises(SystemExit):
            self.bridge.load_env_file(os.path.join(self.dir, "missing.env"), {})


class IsolationTests(TempDir):
    def seed(self, db, company, tag):
        tok, _ = db.add_token("player", company, "p%d" % company)
        conv = db.main_conversation(company, "coordinator")
        msg = db.add_message(company, conv, "user", "%s hello" % tag, author_token_id=tok)
        run = db.create_run(company, "coordinator", conv, state="running")
        task = db.create_task(company, "coordinator", "analyst", "%s task" % tag, "body", run_id=run)
        q = db.create_question(company, "coordinator", run, conv, {"text": "%s?" % tag})
        p = db.create_project(company, "designer", "%s project" % tag, "why", [{"op": "build_way"}])
        return dict(tok=tok, conv=conv, msg=msg["id"], run=run, task=task, q=q, p=p)

    def test_company_rows_are_invisible_to_others(self):
        db = self.open()
        a, b = self.seed(db, 0, "c0"), self.seed(db, 2, "c2")
        self.assertIsNone(db.get_conversation(2, a["conv"]))
        self.assertIsNone(db.get_message(2, a["msg"]))
        self.assertIsNone(db.get_run(2, a["run"]))
        self.assertIsNone(db.get_task(2, a["task"]))
        self.assertIsNone(db.get_question(2, a["q"]))
        self.assertIsNone(db.get_project(2, a["p"]))
        self.assertEqual(db.conversation_messages(2, a["conv"]), [])
        self.assertEqual(db.messages_page(2, a["conv"]), ([], False))
        self.assertEqual([t["title"] for t in db.list_tasks(2)], ["c2 task"])
        self.assertEqual([p["title"] for p in db.list_projects(0)], ["c0 project"])
        self.assertEqual([q["payload"]["text"] for q in db.list_questions(2)], ["c2?"])
        self.assertEqual([r["id"] for r in db.list_runs(0)], [a["run"]])
        with self.assertRaises(ValueError):
            db.add_message(2, a["conv"], "assistant", "intruder")
        with self.assertRaises(ValueError):
            db.create_run(2, "coordinator", a["conv"])
        with self.assertRaises(ValueError):
            db.create_task(2, "coordinator", "analyst", "x", run_id=a["run"])
        self.assertFalse(db.answer_question(2, a["q"], "yes", b["tok"]))
        self.assertFalse(db.dismiss_question(2, a["q"], b["tok"]))
        self.assertFalse(db.update_project(2, a["p"], state="approved"))
        self.assertFalse(db.update_task(2, a["task"], state="done"))
        self.assertFalse(db.set_run_state(2, a["run"], "cancelled"))
        self.assertFalse(db.set_message_meta(2, a["msg"], {"x": 1}))
        self.assertEqual(db.get_project(0, a["p"])["state"], "proposed")
        with self.assertRaises(ValueError):
            db.list_tasks(1)  # the public service is never a company
        with self.assertRaises(ValueError):
            db.list_tasks(None)

    def test_conversations_messages_and_states(self):
        db = self.open(None)
        c = db.main_conversation(0, "analyst")
        self.assertEqual(db.main_conversation(0, "analyst"), c)
        self.assertNotEqual(db.main_conversation(0, "accountant"), c)
        self.assertIsNone(db.find_main_conversation(2, "analyst"))
        task = db.create_task(0, "coordinator", "analyst", "t")
        tc = db.create_conversation(0, "analyst", task)
        self.assertNotEqual(tc, c)
        self.assertEqual(db.main_conversation(0, "analyst"), c)
        self.assertEqual([x["id"] for x in db.task_conversations(0, task)], [tc])
        ids = [db.add_message(0, c, "user", "m%d" % i)["id"] for i in range(5)]
        m = db.add_message(0, c, "assistant", "", reasoning_content="r", tool_calls=[{"id": "1"}], meta={"a": 1})
        self.assertEqual(m["tool_calls"], [{"id": "1"}])
        self.assertEqual(m["meta"], {"a": 1})
        rows, more = db.messages_page(0, c, limit=3)
        self.assertEqual([r["content"] for r in rows], ["m3", "m4", ""])
        self.assertTrue(more)
        rows, more = db.messages_page(0, c, before=ids[3], limit=3)
        self.assertEqual([r["content"] for r in rows], ["m0", "m1", "m2"])
        self.assertFalse(more)
        self.assertEqual(len(db.conversation_messages(0, c, after=ids[1])), 4)
        with self.assertRaises(ValueError):
            db.add_message(0, c, "boss", "x")
        q = db.create_question(0, "analyst", None, c, {"kind": "options"})
        self.assertEqual(db.pending_question_counts(0), {"analyst": 1})
        self.assertTrue(db.answer_question(0, q, {"choice": 1}, None))
        self.assertFalse(db.answer_question(0, q, {"choice": 2}, None))
        self.assertEqual(db.get_question(0, q)["answer"], {"choice": 1})
        self.assertEqual(db.pending_question_counts(0), {})
        p = db.create_project(0, "designer", "p", "", [])
        self.assertTrue(db.update_project(0, p, expect=("proposed",), state="approved", approved_by=None))
        self.assertFalse(db.update_project(0, p, expect=("proposed",), state="rejected"))
        with self.assertRaises(ValueError):
            db.update_project(0, p, owner=3)
        self.assertTrue(db.update_project(0, p, report={"done": 2}))
        self.assertEqual(db.get_project(0, p)["report"], {"done": 2})

    def test_interrupt_runs(self):
        db = self.open()
        c = db.main_conversation(0, "analyst")
        runs = {s: db.create_run(0, "analyst", c, state=s) for s in ("queued", "running", "waiting", "done")}
        self.assertEqual(db.busy_agents(0), {"analyst"})
        self.assertEqual(db.interrupt_runs(), 2)
        self.assertEqual({s: db.get_run(0, r)["state"] for s, r in runs.items()},
                         {"queued": "interrupted", "running": "interrupted", "waiting": "waiting", "done": "done"})
        self.assertEqual(db.busy_agents(0), set())
        self.assertTrue(db.set_run_state(0, runs["waiting"], "running", expect=("waiting",)))
        self.assertFalse(db.set_run_state(0, runs["waiting"], "running", expect=("waiting",)))

    def test_usage(self):
        db = self.open(None)
        db.add_usage(0, "deepseek-flash", 10, 20, 5, 0.001)
        db.add_usage(0, "deepseek-flash", 1, 2, 3, 0.002)
        db.add_usage(2, "deepseek-v4-pro", 1, 1, 1, 0.5)
        db.add_usage(0, "deepseek-flash", 1, 1, 1, 9.0, day="2000-01-01")
        rows = db.usage_rows(company=0)
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["prompt_hit"], rows[0]["prompt_miss"], rows[0]["completion"]), (11, 22, 8))
        s = db.usage_summary(0)
        self.assertEqual(set(s), {"today_usd", "limit_usd", "company_usd", "company_limit_usd", "resets_at"})
        self.assertAlmostEqual(s["today_usd"], 0.503)
        self.assertAlmostEqual(s["company_usd"], 0.003)
        self.assertTrue(s["resets_at"].endswith("T00:00:00Z"))
        db.set_setting("company_limit_usd", "0.2")
        self.assertEqual(db.usage_summary(2)["company_limit_usd"], 0.2)


class EventTests(unittest.TestCase):
    def test_company_isolation_and_replay(self):
        ev = team_events.TeamEvents(team_events.StreamSlots(10))
        c0, first0 = ev.subscribe(0, "s0", None)
        c2, first2 = ev.subscribe(2, "s2", None)
        self.assertIn(b'"resync":true', first0)
        ids = [ev.publish(0, "team_message", {"n": i}) for i in range(3)]
        ev.publish(2, "team_task", {"n": 9})
        got0 = [c0.queue.get_nowait() for _ in range(3)]
        self.assertTrue(c0.queue.empty())
        self.assertEqual(c2.queue.get_nowait().count(b"team_task"), 1)
        self.assertTrue(c2.queue.empty())
        self.assertIn(b"event: team_message", got0[0])
        # replay after the first event: the second and third, hello keeps the position
        c0b, first = ev.subscribe(0, "s0", ids[0])
        self.assertIn(b"id: %d\nevent: hello" % ids[0], first)
        self.assertIn(b'"resync":false', first)
        self.assertEqual(first.count(b"event: team_message"), 2)
        # an id of company 2's stream means nothing to company 0: resync (ids of another process, too)
        _, first = ev.subscribe(0, "s0", 5)
        self.assertIn(b'"resync":true', first)
        _, first = ev.subscribe(0, "s0", ids[-1] + 100)
        self.assertIn(b'"resync":true', first)
        ev.close_session("s0")
        self.assertEqual(c0.queue.get_nowait(), b"")
        self.assertEqual(c2.queue.qsize(), 0)

    def test_ring_limit_and_names(self):
        ev = team_events.TeamEvents(ring_events=5)
        ids = [ev.publish(3, "team_delta", {"i": i}) for i in range(8)]
        _, first = ev.subscribe(3, "s", ids[1])  # fell out of the ring
        self.assertIn(b'"resync":true', first)
        _, first = ev.subscribe(3, "s", ids[3])
        self.assertEqual(first.count(b"event: team_delta"), 4)
        for name in ("snapshot", "team-x", "team_" + "x" * 40, None):
            with self.assertRaises(ValueError):
                ev.publish(3, name, {})
        for company in (1, 15, -1, None, "0"):
            with self.assertRaises(ValueError):
                ev.publish(company, "team_delta", {})

    def test_slots_shared(self):
        slots = team_events.StreamSlots(2)
        ev = team_events.TeamEvents(slots)
        a, _ = ev.subscribe(0, "a", None)
        b, _ = ev.subscribe(0, "b", None)
        self.assertEqual(ev.subscribe(0, "c", None), (None, None))
        ev.unsubscribe(a)
        ev.unsubscribe(a)  # twice: one slot only
        self.assertEqual(slots.count(), 1)
        self.assertIsNotNone(ev.subscribe(0, "c", None)[0])


class EngineBindingTests(unittest.TestCase):
    def test_company_engine(self):
        sent = []
        call = team_engine.company_engine(lambda c, a: sent.append((c, a)) or {"ok": True}, 2)
        call("agent_tool", {"tool": "tool_build_way", "x": 1, "y": 2})
        call("depot_op", {"player": "2", "op": "b"})
        call("estimate", {"kind": "way", "name": "fake_road"})
        self.assertEqual([a.get("player") for _, a in sent], [2, 2, None])
        with self.assertRaises(TeamError) as cm:
            call("line_op", {"player": 0, "op": "d", "line": 5})
        self.assertEqual(cm.exception.status, 403)
        with self.assertRaises(TeamError):
            call("estimate", {"player": 2, "kind": "way", "name": "x"})
        for bad in (1, 15, None, "2"):
            with self.assertRaises(ValueError):
                team_engine.company_engine(lambda c, a: {}, bad)


if __name__ == "__main__":
    unittest.main()
