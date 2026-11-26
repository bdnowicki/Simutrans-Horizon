"""
Tests of team.executor (contract R2 "Projects"): approved projects carried out on the fake engine (port 13396) in a
single player game and in a network game (--net: pending changes applied 0.5 s later, verified by reading the game
again), new ids resolved through refs (create_line, then buy_convoy with line "$l1"), the report and its events,
rule 15 (no start without the money), rule 14 (stop at the first failed op, later ops skipped), the 20 % overrun stop
(--agent-cost-factor makes the real cost higher; also between the convoys of one buy_convoy), a change that never
shows up (--net-delay longer than the verification), reject, double approval, one project per company at a time,
recover() after a restart, company isolation and a worker that fails instead of dying silently.
"""

import time
import unittest

import teamtestlib as T
from team import TeamError
from team import projects as P
from team.db import TeamDB
from team.engine import company_engine
from team.executor import Executor
from test_team_projects import COMPANY, ENGINE_PORT, EngineClient, RecordingEvents, ok, start_fake

STOPS = [{"at": [30, 180]}, {"at": [50, 180], "load": 50}]
INFRA = [{"type": "build_way", "from": [30, 180], "to": [50, 180], "way": "fake_road"},
         {"type": "build_station", "at": [30, 180], "building": "FakeStop"},
         {"type": "build_station", "at": [50, 180], "building": "FakeStop", "rotation": 1}]
LINE = [{"type": "create_line", "ref": "l1", "waytype": "road", "name": "Express", "stops": STOPS},
        {"type": "buy_convoy", "ref": "c1", "depot": [40, 200], "vehicles": ["Fake bus", "Mail trailer"],
         "line": "$l1"},
        {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"], "count": 2, "line": "$l1"}]


class ExecCase(unittest.TestCase):
    FLAGS = ()
    TIMEOUT = 8.0

    @classmethod
    def setUpClass(cls):
        cls.proc = start_fake(cls, *cls.FLAGS)   # cls.raw, cleanups

    def setUp(self):
        self.db = TeamDB(None)
        self.events = RecordingEvents()
        self.ex = Executor(self.db, self.events, lambda c: company_engine(self.raw, c), feed=None,
                           verify_timeout=self.TIMEOUT, poll_interval=0.1)
        self.token = self.db.add_token("player", COMPANY, "tester")[0]

    def tearDown(self):
        self.ex.shutdown()
        self.db.close()

    def eng(self, command, args=None):
        return company_engine(self.raw, COMPANY)(command, args)

    def propose(self, agent, ops, title="Test project"):
        return P.propose(self.db, self.events, company_engine(self.raw, COMPANY), COMPANY, agent, title,
                         "because", ops)["id"]

    def finished(self, pid, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            p = self.db.get_project(COMPANY, pid)
            if p["state"] in ("done", "failed", "rejected"):
                return p
            time.sleep(0.1)
        self.fail("project %d did not finish: %s" % (pid, self.db.get_project(COMPANY, pid)["state"]))

    def run_project(self, agent, ops, title="Test project"):
        pid = self.propose(agent, ops, title)
        self.ex.approve(COMPANY, pid, self.token)
        return self.finished(pid)

    def cash(self):
        return next(p["cash"] for p in ok(self.raw("players"))["players"] if p["nr"] == COMPANY)

    def set_cash(self, value):
        ok(self.raw("cash", {"player": COMPANY, "amount": value - self.cash()}))

    def notes(self, agent):
        conv = self.db.find_main_conversation(COMPANY, agent)
        if conv is None:
            return []
        return [m for m in self.db.conversation_messages(COMPANY, conv) if m["role"] == "system_note"]

    def states(self, report):
        return [e["state"] for e in report["ops"]]

    def check_line_project(self, infra, line):
        """The infrastructure and line projects of a fresh game ran completely and did what they said."""
        r = infra["report"]
        self.assertEqual(infra["state"], "done", r)
        self.assertEqual(self.states(r), ["done"] * 3)
        self.assertEqual([e["cost"] for e in r["ops"]], [10500.0, 3000.0, 3000.0])
        self.assertEqual((r["actual_cost"], r["estimate"]), (16500.0, 16500.0))
        self.assertEqual(r["cost_source"], "finance")
        self.assertNotIn("stopped", r)
        self.assertEqual(sorted(s["pos"]["x"] for s in ok(self.raw("stations"))["stations"]
                                if s["owner"] == COMPANY and s["pos"]["y"] == 180), [30, 50])
        r = line["report"]
        self.assertEqual(line["state"], "done", r)
        self.assertEqual(self.states(r), ["done"] * 3)
        lid = r["ops"][0]["result"]["line"]
        c1 = r["ops"][1]["result"]["convoys"]
        more = r["ops"][2]["result"]["convoys"]
        self.assertEqual((len(c1), len(more)), (1, 2))
        self.assertEqual([e["cost"] for e in r["ops"]], [0.0, 33000.0, 50000.0])
        self.assertEqual(r["actual_cost"], 83000.0)
        # the ids came through the refs: every convoy runs on the new line, with the vehicles asked for
        info = ok(self.raw("line", {"id": lid}))
        self.assertEqual(info["line"]["owner"], COMPANY)
        self.assertEqual(info["line"]["name"], "Express")
        self.assertEqual([(e["pos"]["x"], e["wait_for_load"]) for e in info["schedule"]], [(30, 0), (50, 50)])
        self.assertEqual(sorted(info["convoys"]), sorted(c1 + more))
        for cid in c1 + more:
            conv = ok(self.raw("convoy", {"id": cid}))["convoy"]
            self.assertEqual((conv["owner"], conv["line"]["id"]), (COMPANY, lid))
            self.assertNotEqual(conv["state"], "in_depot")
        self.assertEqual(ok(self.raw("convoy", {"id": c1[0]}))["vehicles"][1]["name"], "Mail trailer")
        self.assertEqual(ok(self.raw("depot", {"x": 40, "y": 200}))["convoys"], [])
        # events: proposed, approved, running, progress, done; the note in the author's chat
        states = [e["project"]["state"] for e in self.events.named("team_project", COMPANY)
                  if e["project"]["id"] == line["id"]]
        self.assertEqual(states[:3], ["proposed", "approved", "running"])
        self.assertEqual(states[-1], "done")
        for e in self.events.named("team_project"):
            self.assertNotIn("preview", e["project"])
        notes = self.notes("logistician")
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["meta"], {"project_id": line["id"]})
        self.assertIn('Project #%d "Line" was carried out: all 3 operations done' % line["id"], notes[0]["content"])
        self.assertIn("New line: %d." % lid, notes[0]["content"])
        msgs = [e for e in self.events.named("team_message", COMPANY) if e["agent"] == "logistician"]
        self.assertEqual(msgs[-1]["message"]["project_id"], line["id"])
        self.assertEqual(msgs[-1]["message"]["role"], "system_note")
        self.assertEqual(line["approved_by"], self.token)


class SinglePlayerTests(ExecCase):
    def test_a_projects_done(self):
        infra = self.run_project("engineer", INFRA, "Road")
        line = self.run_project("logistician", LINE, "Line")
        self.check_line_project(infra, line)

    def test_rule_15_not_enough_money(self):
        pid = self.propose("logistician", [{"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"],
                                            "count": 2}])
        before = self.cash()
        depot = ok(self.raw("depot", {"x": 40, "y": 200}))["convoys"]
        try:
            self.set_cash(1000)
            self.ex.approve(COMPANY, pid, self.token)
            p = self.finished(pid)
        finally:
            self.set_cash(before)
        self.assertEqual(p["state"], "failed")
        self.assertIn("not enough money: cash 1000, estimate 50000", p["report"]["stopped"])
        self.assertEqual(self.states(p["report"]), ["skipped"])
        self.assertEqual(p["report"]["actual_cost"], 0.0)
        self.assertEqual(ok(self.raw("depot", {"x": 40, "y": 200}))["convoys"], depot)
        self.assertIn("not enough money", self.notes("logistician")[-1]["content"])

    def test_rule_14_stop_at_the_first_failure(self):
        p = self.run_project("engineer", [
            {"type": "build_way", "from": [60, 150], "to": [64, 150], "way": "fake_road"},
            {"type": "remove", "at": [24, 40]},                       # a public road: the engine refuses
            {"type": "build_station", "at": [64, 150], "building": "FakeStop"}])
        r = p["report"]
        self.assertEqual(p["state"], "failed")
        self.assertEqual(self.states(r), ["done", "failed", "skipped"])
        self.assertIn("cannot remove way", r["ops"][1]["error"])
        self.assertTrue(r["stopped"].startswith("ops[1] (remove) failed: agent_tool refused: cannot remove way"))
        self.assertEqual(r["actual_cost"], 2500.0)
        self.assertNotIn(64, [s["pos"]["x"] for s in ok(self.raw("stations"))["stations"]
                              if s["pos"]["y"] == 150])
        note = self.notes("engineer")[-1]["content"]
        self.assertIn("stopped: ops[1] (remove) failed", note)
        self.assertIn("1 of 3 operations done", note)

    def test_reject(self):
        pid = self.propose("engineer", [{"type": "build_way", "from": [100, 140], "to": [104, 140],
                                         "way": "fake_road"}])
        self.ex.reject(COMPANY, pid, "too expensive", self.token)
        p = self.db.get_project(COMPANY, pid)
        self.assertEqual(p["state"], "rejected")
        self.assertEqual(p["report"]["stopped"], "rejected by the user: too expensive")
        self.assertEqual(p["report"]["rejected"]["by"], self.token)
        self.assertIn("rejected project #%d" % pid, self.notes("engineer")[-1]["content"])
        self.assertIn("too expensive", self.notes("engineer")[-1]["content"])
        self.assertEqual(self.events.named("team_project")[-1]["project"]["state"], "rejected")
        for action in (lambda: self.ex.approve(COMPANY, pid, self.token),
                       lambda: self.ex.reject(COMPANY, pid, None, self.token)):
            with self.assertRaises(TeamError) as cm:
                action()
            self.assertEqual(cm.exception.status, 409)

    def test_double_approve(self):
        pid = self.propose("engineer", [{"type": "build_way", "from": [100, 144], "to": [104, 144],
                                         "way": "fake_road"}])
        self.ex.approve(COMPANY, pid, self.token)
        with self.assertRaises(TeamError) as cm:
            self.ex.approve(COMPANY, pid, self.token)
        self.assertEqual(cm.exception.status, 409)
        self.assertEqual(self.finished(pid)["state"], "done")
        with self.assertRaises(TeamError) as cm:
            self.ex.approve(COMPANY, pid, self.token)
        self.assertEqual(cm.exception.status, 409)

    def test_company_isolation(self):
        other = self.db.create_project(0, "engineer", "Company 0", "", [{"type": "remove", "at": [5, 5]}],
                                       estimate={"total": 0}, preview=None)
        for action in (lambda: self.ex.approve(COMPANY, other, self.token),
                       lambda: self.ex.reject(COMPANY, other, "no", self.token)):
            with self.assertRaises(TeamError) as cm:
                action()
            self.assertEqual(cm.exception.status, 404)
        self.assertEqual(self.db.get_project(0, other)["state"], "proposed")
        self.assertEqual(self.events.named("team_project", 0), [])

    def test_recover_after_restart(self):
        ops = [{"type": "remove", "at": [5, 5]}, {"type": "remove", "at": [6, 5]}, {"type": "remove", "at": [7, 5]}]
        running = self.db.create_project(COMPANY, "engineer", "Half done", "", ops, estimate={"total": 100},
                                         state="running")
        self.db.update_project(COMPANY, running, report={"ops": [{"op": 0, "type": "remove", "state": "done",
                                                                  "cost": 10.0}], "actual_cost": 10.0,
                                                         "estimate": 100.0})
        approved = self.db.create_project(COMPANY, "designer", "Not started", "", ops, estimate={"total": 100},
                                          state="approved")
        untouched = self.db.create_project(COMPANY, "engineer", "Waiting", "", ops, estimate={"total": 100})
        self.assertEqual(self.ex.recover(), 2)
        p = self.db.get_project(COMPANY, running)
        self.assertEqual(p["state"], "failed")
        self.assertEqual(p["report"]["stopped"], "interrupted by a restart")
        self.assertEqual(self.states(p["report"]), ["done", "failed", "skipped"])
        self.assertIn("may or may not", p["report"]["ops"][1]["error"])
        self.assertEqual(p["report"]["actual_cost"], 10.0)
        p = self.db.get_project(COMPANY, approved)
        self.assertEqual((p["state"], self.states(p["report"])), ("failed", ["skipped"] * 3))
        self.assertEqual(self.db.get_project(COMPANY, untouched)["state"], "proposed")
        self.assertIn("interrupted by a restart", self.notes("engineer")[-1]["content"])
        self.assertIn("interrupted by a restart", self.notes("designer")[-1]["content"])
        self.assertEqual(sorted(e["project"]["id"] for e in self.events.named("team_project", COMPANY)),
                         sorted([running, approved]))
        self.assertEqual(self.ex.recover(), 0)

    def test_worker_error_fails_the_project(self):
        def broken(company):
            raise RuntimeError("no engine today")
        ex = Executor(self.db, self.events, broken, verify_timeout=1)
        pid = self.propose("engineer", [{"type": "build_way", "from": [100, 148], "to": [104, 148],
                                         "way": "fake_road"}])
        ex.approve(COMPANY, pid, self.token)
        p = self.finished(pid, 10)
        self.assertEqual(p["state"], "failed")
        self.assertEqual(p["report"]["stopped"], "internal error: RuntimeError: no engine today")
        self.assertEqual(self.states(p["report"]), ["skipped"])
        self.assertTrue(T.wait_until(lambda: not ex.busy(COMPANY), 5))
        ex.shutdown()

    def test_exception_inside_an_op(self):
        # a stored plan the executor cannot use (written by hand): that op fails with the error, the rest is skipped
        ops = [{"type": "build_way", "from": [100, 156], "to": [104, 156], "way": "fake_road"},
               {"type": "remove", "at": [100, 156]}]
        pid = self.db.create_project(COMPANY, "engineer", "Broken plan", "", ops,
                                     estimate={"total": 2500, "plans": {"0": {"param": "fake_road,", "from": None,
                                                                              "to": [104, 156, 0]}}})
        self.ex.approve(COMPANY, pid, self.token)
        p = self.finished(pid)
        self.assertEqual(p["state"], "failed")
        self.assertEqual(self.states(p["report"]), ["failed", "skipped"])
        self.assertIn("internal error: TypeError", p["report"]["ops"][0]["error"])
        self.assertTrue(T.wait_until(lambda: not self.ex.busy(COMPANY), 5))

    def test_cost_from_cash_without_finance(self):
        def no_finance(company):
            eng = company_engine(self.raw, company)

            def call(command, args=None):
                if command == "finance":
                    return {"ok": False, "error": "unknown command"}
                return eng(command, args)
            return call
        ex = Executor(self.db, self.events, no_finance, verify_timeout=self.TIMEOUT, poll_interval=0.1)
        pid = self.propose("engineer", [{"type": "build_way", "from": [100, 154], "to": [104, 154],
                                         "way": "fake_road"}])
        ex.approve(COMPANY, pid, self.token)
        p = self.finished(pid)
        ex.shutdown()
        self.assertEqual(p["state"], "done", p["report"])
        self.assertEqual((p["report"]["actual_cost"], p["report"]["cost_source"]), (2500.0, "cash"))

    def test_withdraw_sell_replace(self):
        # a convoy of company 2 on a line of its own (made directly), then the fleet manager's ops
        ok(self.eng("agent_tool", {"tool": "tool_build_way", "x": 30, "y": 120, "x2": 40, "y2": 120,
                                   "param": "fake_road"}))
        for x in (30, 40):
            ok(self.eng("agent_tool", {"tool": "tool_build_station", "x": x, "y": 120, "param": "FakeStop"}))
        lid = ok(self.eng("line_op", {"op": "c", "waytype": 1, "schedule": "0|1|30,120,0,0,0|40,120,0,0,0|"}))["line"]
        cids = []
        for _ in range(3):
            cid = ok(self.eng("depot_op", {"x": 40, "y": 200, "op": "a", "convoy": 0, "vehicle": "Fake bus"}))["convoy"]
            ok(self.eng("convoy_op", {"convoy": cid, "op": "l", "line": lid}))
            ok(self.eng("depot_op", {"x": 40, "y": 200, "op": "b", "convoy": cid}))
            cids.append(cid)
        p = self.run_project("fleet_manager", [
            {"type": "withdraw", "convoy": cids[0]},
            {"type": "withdraw", "convoy": cids[0]},                  # already withdrawn: nothing changes
            {"type": "sell", "convoy": cids[1]},
            {"type": "replace_convoy", "convoy": cids[2], "vehicles": ["Fake bus", "Mail trailer"]}])
        r = p["report"]
        self.assertEqual(p["state"], "done", r)
        self.assertEqual(r["ops"][0]["result"], {"convoy": cids[0], "withdraw": "withdrawn"})
        self.assertEqual(r["ops"][1]["result"], {"convoy": cids[0], "withdraw": "unchanged"})
        self.assertEqual(r["ops"][2]["result"], {"sold": cids[1]})
        self.assertEqual(r["ops"][2]["cost"], -20000.0)
        new = r["ops"][3]["result"]["convoy"]
        self.assertEqual(r["ops"][3]["result"], {"replaced": cids[2], "convoy": new, "old": "withdrawn"})
        self.assertEqual((r["actual_cost"], r["income"]), (33000.0, 20000.0))
        self.assertTrue(ok(self.raw("convoy", {"id": cids[0]}))["convoy"]["withdraw"])
        self.assertIn("error", self.raw("convoy", {"id": cids[1]}))
        conv = ok(self.raw("convoy", {"id": new}))
        self.assertEqual((conv["convoy"]["line"]["id"], [v["name"] for v in conv["vehicles"]]),
                         (lid, ["Fake bus", "Mail trailer"]))
        self.assertTrue(ok(self.raw("convoy", {"id": cids[2]}))["convoy"]["withdraw"])
        self.assertIn("income 20000", self.notes("fleet_manager")[-1]["content"])

    def test_dispatcher_schedule(self):
        ok(self.eng("agent_tool", {"tool": "tool_build_way", "x": 30, "y": 110, "x2": 40, "y2": 110,
                                   "param": "fake_road"}))
        for x in (30, 40):
            ok(self.eng("agent_tool", {"tool": "tool_build_station", "x": x, "y": 110, "param": "FakeStop"}))
        lid = ok(self.eng("line_op", {"op": "c", "waytype": 1, "schedule": "0|1|30,110,0,0,0|40,110,0,0,0|"}))["line"]
        p = self.run_project("dispatcher", [{"type": "set_line_schedule", "line": lid,
                                             "stops": [{"at": [30, 110], "load": 75}, {"at": [40, 110]}]}])
        self.assertEqual(p["state"], "done", p["report"])
        info = ok(self.raw("line", {"id": lid}))
        self.assertEqual([e["wait_for_load"] for e in info["schedule"]], [75, 0])


class MoneyTests(unittest.TestCase):
    """The cost arithmetic of the executor (no game needed)."""

    def run_(self):
        from team.executor import _Run
        return _Run(None, COMPANY, {"id": 1, "estimate": {"total": 1000}}, None)

    def test_finance_same_month_and_new_month(self):
        r = self.run_()
        s0 = {"src": "finance", "month": 100, "m0": -5000.0, "m1": -9000.0, "cash": 50000.0}
        self.assertEqual(r.spent_between(s0, dict(s0, m0=-7500.0, cash=60000.0)), 2500.0)  # income ignored
        # a new month began: 1000 more in the old month (now row 1), 400 in the new one
        s1 = {"src": "finance", "month": 101, "m0": -400.0, "m1": -6000.0, "cash": 0.0}
        self.assertEqual(r.spent_between(s0, s1), 1400.0)
        self.assertEqual(r.sources, {"finance"})
        # a sale books new vehicles positive: negative cost (income)
        self.assertEqual(r.spent_between(s0, dict(s0, m0=15000.0)), -20000.0)

    def test_cash_fallback_and_unknown(self):
        r = self.run_()
        fin = {"src": "finance", "month": 100, "m0": 0.0, "m1": None, "cash": 1000.0}
        self.assertEqual(r.spent_between(fin, {"src": "cash", "cash": 400.0}), 600.0)
        self.assertEqual(r.spent_between(fin, dict(fin, month=103, cash=900.0)), 100.0)  # months skipped
        self.assertEqual(r.sources, {"cash"})
        self.assertIsNone(r.spent_between(None, fin))
        self.assertIsNone(r.spent_between({"src": "finance", "month": 1, "m0": 0.0, "m1": None},
                                          {"src": "finance", "month": 3, "m0": 0.0, "m1": None}))
        self.assertEqual(r.limit, 1200.0)


class NetworkTests(ExecCase):
    FLAGS = ("--net",)

    def test_a_projects_done_with_pending_changes(self):
        infra = self.run_project("engineer", INFRA, "Road")
        line = self.run_project("logistician", LINE, "Line")
        self.check_line_project(infra, line)
        self.assertEqual(ok(self.raw("fake_agent_state"))["pending"], 0)

    def test_b_every_op_verified(self):
        p = self.run_project("engineer", [
            {"type": "build_way", "from": [30, 190], "to": [50, 190], "way": "fake_road"},
            {"type": "build_station", "at": [30, 190], "building": "FakeStop"},
            {"type": "build_station", "at": [50, 190], "building": "FakeStop"},
            {"type": "build_way", "from": [60, 170], "to": [66, 170], "way": "fake_road"},
            {"type": "build_depot", "at": [66, 170], "building": "FakeRoadDepot"},
            {"type": "build_roadsign", "at": [62, 170], "sign": "fake_oneway"},
            {"type": "remove", "at": [62, 170], "kind": "roadsign"},
            {"type": "remove_way", "from": [63, 170], "to": [64, 170], "waytype": "road"},
            {"type": "build_way", "from": [60, 174], "to": [64, 174], "way": "fake_track"},
            {"type": "build_wayobj", "from": [60, 174], "to": [64, 174], "wayobj": "fake_catenary"}])
        self.assertEqual(p["state"], "done", p["report"])
        self.assertEqual(ok(self.raw("depot", {"x": 66, "y": 170}))["owner"], COMPANY)
        objs = ok(self.raw("fake_agent_state"))["objects"]
        self.assertFalse([o for o in objs if o["y"] == 170 and 62 <= o["x"] <= 64])
        self.assertEqual(len([o for o in objs if o["y"] == 174 and o["kind"] == "wayobj"]), 5)
        stops = [{"at": [30, 190]}, {"at": [50, 190]}]
        p = self.run_project("logistician", [
            {"type": "create_line", "ref": "l1", "waytype": "road", "stops": stops},
            {"type": "create_line", "ref": "l2", "waytype": "road", "stops": stops[::-1]},
            {"type": "buy_convoy", "ref": "a", "depot": [40, 200], "vehicles": ["Fake bus"], "line": "$l1"},
            {"type": "buy_convoy", "ref": "b", "depot": [40, 200], "vehicles": ["Fake bus"], "line": "$l1"},
            {"type": "buy_convoy", "ref": "c", "depot": [40, 200], "vehicles": ["Fake bus"], "line": "$l1"}])
        self.assertEqual(p["state"], "done", p["report"])
        res = [e.get("result") or {} for e in p["report"]["ops"]]
        l1, l2 = res[0]["line"], res[1]["line"]
        a, b, c = (res[k]["convoys"][0] for k in (2, 3, 4))
        p = self.run_project("dispatcher", [
            {"type": "set_line_schedule", "line": l1, "stops": [{"at": [30, 190], "load": 60}, {"at": [50, 190]}]},
            {"type": "assign_line", "convoy": c, "line": l2}])
        self.assertEqual(p["state"], "done", p["report"])
        p = self.run_project("fleet_manager", [{"type": "withdraw", "convoy": a}, {"type": "sell", "convoy": b}])
        self.assertEqual(p["state"], "done", p["report"])
        self.assertEqual(p["report"]["income"], 20000.0)
        p = self.run_project("logistician", [{"type": "delete_line", "line": l2}])
        self.assertEqual(p["state"], "done", p["report"])
        self.assertEqual([e["wait_for_load"] for e in ok(self.raw("line", {"id": l1}))["schedule"]], [60, 0])
        self.assertIn("error", self.raw("line", {"id": l2}))
        self.assertTrue(ok(self.raw("convoy", {"id": a}))["convoy"]["withdraw"])
        self.assertIn("error", self.raw("convoy", {"id": b}))
        self.assertNotIn("line", ok(self.raw("convoy", {"id": c}))["convoy"])  # its line was deleted

    def test_one_project_per_company(self):
        first = self.propose("engineer", [
            {"type": "build_way", "from": [60, 150], "to": [64, 150], "way": "fake_road"},
            {"type": "build_way", "from": [60, 152], "to": [64, 152], "way": "fake_road"}])
        second = self.propose("engineer", [{"type": "build_way", "from": [60, 154], "to": [64, 154],
                                            "way": "fake_road"}])
        self.ex.approve(COMPANY, first, self.token)
        self.assertTrue(self.ex.busy(COMPANY))
        with self.assertRaises(TeamError) as cm:
            self.ex.approve(COMPANY, second, self.token)
        self.assertEqual(cm.exception.status, 409)
        self.assertIn("another project", cm.exception.message)
        self.assertEqual(self.db.get_project(COMPANY, second)["state"], "proposed")
        self.assertEqual(self.finished(first)["state"], "done")
        self.ex.approve(COMPANY, second, self.token)
        self.assertEqual(self.finished(second)["state"], "done")


class SlowNetworkTests(ExecCase):
    FLAGS = ("--net", "--net-delay", "4")
    TIMEOUT = 1.5

    def test_change_that_does_not_show_up(self):
        p = self.run_project("engineer", [
            {"type": "build_way", "from": [60, 150], "to": [64, 150], "way": "fake_road"},
            {"type": "build_station", "at": [64, 150], "building": "FakeStop"}])
        r = p["report"]
        self.assertEqual(p["state"], "failed")
        self.assertEqual(self.states(r), ["failed", "skipped"])
        self.assertIn("did not show up in the game within 2 s: the way from 60,150,0 to 64,150,0", r["ops"][0]["error"])


class OverrunTests(ExecCase):
    FLAGS = ("--agent-cost-factor", "2")

    def test_stop_after_an_op(self):
        p = self.run_project("engineer", [
            {"type": "build_way", "from": [30, 170], "to": [50, 170], "way": "fake_road"},
            {"type": "build_station", "at": [50, 170], "building": "FakeStop"}])
        r = p["report"]
        self.assertEqual(p["state"], "failed")
        self.assertEqual(self.states(r), ["done", "skipped"])
        self.assertEqual(r["ops"][0]["cost"], 21000.0)
        self.assertEqual(r["stopped"], "stopped: the actual cost 21000 exceeds the estimate 13500 by more than 20 %")
        self.assertIn("1 of 2 operations done", self.notes("engineer")[-1]["content"])

    def test_stop_between_convoys(self):
        # estimate 6 x 25000 = 150000, limit 180000; each bus really costs 50000: after the 4th the limit is passed
        p = self.run_project("logistician", [
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"], "count": 5},
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"]}])
        r = p["report"]
        self.assertEqual(p["state"], "failed")
        self.assertEqual(self.states(r), ["failed", "skipped"])
        self.assertEqual(len(r["ops"][0]["result"]["convoys"]), 4)
        self.assertEqual(r["ops"][0]["cost"], 200000.0)
        self.assertEqual(r["actual_cost"], 200000.0)
        self.assertTrue(r["stopped"].startswith("stopped: the actual cost 200000 exceeds the estimate 150000"))


if __name__ == "__main__":
    unittest.main()
