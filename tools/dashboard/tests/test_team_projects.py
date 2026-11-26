"""
Tests of team.projects (contract R2 "Projects"): role allow-lists, the tool schema, validation of proposals (schema,
limits, map bounds, refs, descs that do not exist or are not available, objects of other companies, the dispatcher's
schedule rule), the estimate (plan_way and estimate dry runs, totals, cash after) and the preview geometry, storing
and publishing. The engine is the fake engine (port 13396) reached with a tiny line-protocol client bound to a company
with team.engine.company_engine, as the bridge's team connection would be; no bridge is started.

Also the home of the helpers of test_team_executor (EngineClient, RecordingEvents, start_fake). Processes that run
these modules take turns on the port (lock_port), so a whole-suite discovery and a single module run do not collide.
"""

import json
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest
import urllib.parse

import teamtestlib as T
from team import projects as P
from team import roles
from team.db import TeamDB
from team.engine import company_engine
from team.events import TeamEvents

ENGINE_PORT = 13396          # this workstream's fake engine port (never the user's game or other test ports)
COMPANY = 2


class EngineClient:
    """engine(command, args) -> reply over one protocol-1 connection to a game, like the bridge's team connection
    (App.team_engine): raw replies, bools as 1/0, None left out; a broken connection gives {"ok": false, "status":
    502}. Thread-safe (the executor's worker and the test use it at the same time)."""

    def __init__(self, port):
        self.port = port
        self.lock = threading.Lock()
        self.sock = self.f = None

    def _connect(self):
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=15)
        self.f = self.sock.makefile("rwb")
        self.f.write(b"HELLO simutrans-remote 1\n")
        self.f.flush()
        self.hello = json.loads(self.f.readline())

    def close(self):
        try:
            if self.sock is not None:
                self.sock.close()
        except OSError:
            pass
        self.sock = self.f = None

    def __call__(self, command, args=None):
        params = {}
        for k, v in (args or {}).items():
            if v is None:
                continue
            params[k] = ("1" if v else "0") if isinstance(v, bool) else str(v)
        line = command + (" " + urllib.parse.urlencode(params) if params else "")
        with self.lock:
            for attempt in (0, 1):
                try:
                    if self.f is None:
                        self._connect()
                    self.f.write((line + "\n").encode("utf-8"))
                    self.f.flush()
                    raw = self.f.readline()
                    if not raw:
                        raise OSError("connection closed")
                    return json.loads(raw)
                except (OSError, ValueError) as e:
                    self.close()
                    if attempt:
                        return {"ok": False, "error": "the game is not reachable: %s" % e, "status": 502}


class RecordingEvents(TeamEvents):
    """TeamEvents that also keeps every published event: [(company, name, data)]."""

    def __init__(self):
        super().__init__()
        self.log = []
        self.log_lock = threading.Lock()

    def publish(self, company, name, data):
        eid = super().publish(company, name, data)
        with self.log_lock:
            self.log.append((company, name, json.loads(json.dumps(data))))
        return eid

    def named(self, name, company=None):
        with self.log_lock:
            return [d for c, n, d in self.log if n == name and (company is None or c == company)]


_PORT_LOCK = []


def lock_port(timeout=900):
    """Test processes that use ENGINE_PORT take turns (a whole-suite discovery runs these modules too): an exclusive
    lock on a file in the temp directory, held until this process ends (the system releases it even after a
    crash)."""
    if _PORT_LOCK:
        return
    f = open(os.path.join(tempfile.gettempdir(), "simutrans-dashboard-tests-%d.lock" % ENGINE_PORT), "a+b")
    end = time.time() + timeout
    while True:
        try:
            if os.name == "nt":
                import msvcrt
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            _PORT_LOCK.append(f)
            return
        except OSError:
            if time.time() > end:
                f.close()
                raise RuntimeError("another test process keeps port %d busy" % ENGINE_PORT)
            time.sleep(0.5)


def start_fake(cls, *flags):
    """A fake engine on ENGINE_PORT for a test class, with a log directory; both go away in a class cleanup, which
    unittest runs even when setUpClass fails later (tearDownClass would not run then and leave the engine)."""
    lock_port()
    cls.dir = tempfile.mkdtemp(prefix="team-c2-")
    cls.addClassCleanup(shutil.rmtree, cls.dir, True)
    proc = T.start_engine(cls.dir, ENGINE_PORT, "--players", "3", "--month-seconds", "3600", *flags,
                          name="engine-%d-%d" % (ENGINE_PORT, len(flags)))

    def stop():
        proc.kill()
        if not T.wait_free(ENGINE_PORT):
            raise RuntimeError("the fake engine on %d did not stop" % ENGINE_PORT)
    cls.addClassCleanup(stop)
    cls.raw = EngineClient(ENGINE_PORT)
    cls.addClassCleanup(cls.raw.close)
    return proc


def ok(reply):
    assert reply.get("ok") is not False and "error" not in reply, reply
    return reply


class ProjectCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = start_fake(cls)
        cls.eng = staticmethod(company_engine(cls.raw, COMPANY))  # a function: not a method of the test
        # objects of company 2 for the line and convoy checks: a road with two stops, a line, a convoy on it and a
        # convoy waiting in its depot (40, 200)
        ok(cls.eng("agent_tool", {"tool": "tool_build_way", "x": 30, "y": 180, "x2": 50, "y2": 180,
                                  "param": "fake_road"}))
        for x in (30, 50):
            ok(cls.eng("agent_tool", {"tool": "tool_build_station", "x": x, "y": 180, "param": "FakeStop"}))
        cls.line = ok(cls.eng("line_op", {"op": "c", "waytype": "road",
                                          "schedule": "0|1|30,180,0,0,0|50,180,0,0,0|"}))["line"]
        cls.convoy = ok(cls.eng("depot_op", {"x": 40, "y": 200, "op": "a", "convoy": 0,
                                             "vehicle": "Fake bus"}))["convoy"]
        ok(cls.eng("convoy_op", {"convoy": cls.convoy, "op": "l", "line": cls.line}))
        ok(cls.eng("depot_op", {"x": 40, "y": 200, "op": "b", "convoy": cls.convoy}))
        cls.parked = ok(cls.eng("depot_op", {"x": 40, "y": 200, "op": "a", "convoy": 0,
                                             "vehicle": "Fake bus"}))["convoy"]
        ok(cls.eng("agent_tool", {"tool": "tool_build_way", "x": 60, "y": 140, "x2": 66, "y2": 140,
                                  "param": "fake_track"}))
        # objects of company 0
        lines = ok(cls.raw("lines", {"owner": 0, "fields": "summary", "limit": 0}))["lines"]
        cls.foreign_line = lines[0]["id"]
        convoys = ok(cls.raw("convoys", {"owner": 0, "fields": "summary", "limit": 0}))["convoys"]
        cls.foreign_convoy = convoys[0]["id"]

    def setUp(self):
        self.db = TeamDB(None)
        self.events = RecordingEvents()

    def tearDown(self):
        self.db.close()

    def propose(self, agent, ops, title="Test project", rationale="because"):
        return P.propose(self.db, self.events, self.eng, COMPANY, agent, title, rationale, ops)

    def refused(self, agent, ops, *texts, title="Test project", rationale="because"):
        stored = len(self.db.list_projects(COMPANY))
        published = len(self.events.log)
        with self.assertRaises(P.ProjectError) as cm:
            self.propose(agent, ops, title, rationale)
        joined = "\n".join(cm.exception.errors)
        for text in texts:
            self.assertIn(text, joined)
        self.assertEqual(cm.exception.status, 400)
        self.assertEqual(cm.exception.body()["errors"], cm.exception.errors)
        # nothing stored, nothing published
        self.assertEqual(len(self.db.list_projects(COMPANY)), stored)
        self.assertEqual(len(self.events.log), published)
        return cm.exception.errors

    def cash(self):
        return next(p["cash"] for p in ok(self.raw("players"))["players"] if p["nr"] == COMPANY)


class RoleAndSchemaTests(ProjectCase):
    def test_role_ops(self):
        self.assertEqual(set(P.ROLE_OPS), set(roles.AGENT_IDS))
        for role in ("analyst", "accountant", "coordinator"):
            self.assertEqual(P.ROLE_OPS[role], frozenset())
            self.assertIsNone(P.ops_schema(role))
        self.assertEqual(P.ROLE_OPS["engineer"], frozenset(P.INFRA_OPS))
        self.assertEqual(P.ROLE_OPS["designer"], frozenset(P.INFRA_OPS))
        self.assertEqual(P.ROLE_OPS["logistician"], frozenset(("create_line", "set_line_schedule", "delete_line",
                                                               "buy_convoy", "assign_line")))
        self.assertEqual(P.ROLE_OPS["dispatcher"], frozenset(("buy_convoy", "assign_line", "withdraw",
                                                              "set_line_schedule")))
        self.assertEqual(P.ROLE_OPS["fleet_manager"], frozenset(("buy_convoy", "replace_convoy", "sell", "withdraw")))
        self.assertIsNone(P.ops_schema("nobody"))

    def test_ops_schema(self):
        for role, ops in P.ROLE_OPS.items():
            if not ops:
                continue
            s = P.ops_schema(role)
            json.dumps(s)
            self.assertEqual(s["type"], "array")
            self.assertEqual(s["maxItems"], P.MAX_OPS)
            item = s["items"]
            self.assertEqual(item["required"], ["type"])
            self.assertFalse(item["additionalProperties"])
            self.assertEqual(set(item["properties"]["type"]["enum"]), set(ops))
            fields = {f for t in ops for f in P.FIELDS[t][0] + P.FIELDS[t][1]}
            self.assertEqual(set(item["properties"]) - {"type"}, fields)
            for t in ops:
                self.assertIn(t + " {", item["properties"]["type"]["description"])
        s = P.ops_schema("engineer")
        self.assertEqual(s["items"]["properties"]["from"]["maxItems"], 3)
        self.assertNotIn("vehicles", s["items"]["properties"])
        self.assertIn("load/wait", P.ops_schema("dispatcher")["items"]["properties"]["type"]["description"])
        self.assertEqual(P.ops_schema("logistician")["items"]["properties"]["stops"]["maxItems"], P.MAX_STOPS)

    def test_read_only_roles_refused(self):
        op = {"type": "build_way", "from": [1, 1], "to": [3, 1], "way": "fake_road"}
        for role in ("analyst", "accountant", "coordinator", "nobody"):
            self.refused(role, [op], "may not propose projects")

    def test_allow_lists(self):
        self.refused("engineer", [{"type": "create_line", "ref": "l", "waytype": "road",
                                   "stops": [{"at": [30, 180]}, {"at": [50, 180]}]}],
                     "ops[0] (create_line): the engineer may not propose this op")
        self.refused("logistician", [{"type": "build_way", "from": [1, 1], "to": [3, 1], "way": "fake_road"}],
                     "ops[0] (build_way): the logistician may not propose this op")
        self.refused("dispatcher", [{"type": "sell", "convoy": self.convoy}], "dispatcher may not propose this op")
        self.refused("fleet_manager", [{"type": "assign_line", "convoy": self.convoy, "line": self.line}],
                     "fleet_manager may not propose this op")
        # allowed ops pass
        p = self.propose("dispatcher", [{"type": "withdraw", "convoy": self.convoy}])
        self.assertEqual(p["state"], "proposed")


class ValidationTests(ProjectCase):
    def test_all_errors_at_once(self):
        ops = [
            {"type": "build_way", "from": [1, 1], "way": "fake_road"},                          # missing to
            {"type": "build_way", "from": [1, 1], "to": [2, 1], "way": "fake_road", "speed": 3},  # unknown field
            {"type": "build_station", "at": [1], "building": "FakeStop"},                       # bad position
            {"type": "build_depot", "at": [999, 5], "building": "FakeRoadDepot"},              # outside the map
            {"type": "build_station", "at": [5, 5], "building": "FakeStop", "rotation": 7},     # rotation
            {"type": "remove", "at": [5, 5], "kind": "tree"},                                   # kind
            {"type": "remove_way", "from": [5, 5], "to": [6, 5], "waytype": "hovercraft"},      # waytype
            {"type": "teleport", "at": [5, 5]},                                                 # unknown op
            "build a road",                                                                     # not an object
            {"type": "build_way", "from": [4, 4], "to": [4, 4], "way": "fake_road"},           # same square
            {"type": "build_way", "from": [1.5, 1], "to": [3, 1], "way": "fake_road"},         # not integers
            {"type": "build_roadsign", "at": [5, 5, 300], "sign": "fake_oneway"},              # z
        ]
        errors = self.refused("engineer", ops,
                              "ops[0] (build_way): missing field(s) to",
                              "ops[1] (build_way): unknown field(s) speed",
                              "ops[2] (build_station): at must be [x, y] or [x, y, z]",
                              "ops[3] (build_depot): at 999,5 is outside of the map (256 x 256)",
                              "ops[4] (build_station): rotation must be 0-3",
                              "ops[5] (remove): kind must be one of",
                              "ops[6] (remove_way): waytype must be one of",
                              "ops[7] (teleport): unknown op type",
                              "ops[8] (?): an op must be an object",
                              "ops[9] (build_way): from and to are the same square",
                              "ops[10] (build_way): from must be [x, y] or [x, y, z] (integers)",
                              "ops[11] (build_roadsign): at: z must be -128..127")
        self.assertGreaterEqual(len(errors), 12)

    def test_line_and_vehicle_fields(self):
        self.refused("logistician", [
            {"type": "create_line", "ref": "l1", "waytype": "zeppelin", "stops": [{"at": [30, 180]}]},
            {"type": "create_line", "ref": "bad ref!", "waytype": "road",
             "stops": [{"at": [30, 180], "load": 120}, {"at": [30, 180], "wait": -1}, {"place": [1, 1]}]},
            {"type": "create_line", "ref": "l3", "waytype": "road", "name": "x" * 101,
             "stops": [{"at": [30, 180]}, {"at": [30, 180]}]},
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": [], "count": 21},
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"], "start": True},
            {"type": "assign_line", "convoy": 1.5, "line": "nope"},
        ], "ops[0] (create_line): waytype must be one of",
            "ops[0] (create_line): stops must be a list of 2-64 stops",
            "ops[1] (create_line): ref must be a name",
            "ops[1] (create_line): stops[0].load must be 0-100",
            "ops[1] (create_line): stops[1].wait must be 0-65535",
            "ops[1] (create_line): stops[2]: unknown field(s) place",
            "ops[2] (create_line): name must be 1-100 characters",
            "ops[2] (create_line): stops need at least two different squares",
            "ops[3] (buy_convoy): vehicles must be a list of 1-32",
            "ops[3] (buy_convoy): count must be 1-20",
            "ops[4] (buy_convoy): start needs a line",
            "ops[5] (assign_line): convoy must be an id",
            "ops[5] (assign_line): line must be an id")

    def test_limits(self):
        op = {"type": "build_way", "from": [1, 1], "to": [3, 1], "way": "fake_road"}
        self.refused("engineer", [op] * (P.MAX_OPS + 1), "at most 40 operations")
        self.refused("engineer", [], "ops must be a list of 1-40")
        self.refused("engineer", "build", "ops must be a list")
        self.refused("engineer", [op], "title must have at most 120", title="t" * 121)
        self.refused("engineer", [op], "title must be a text", title="  ")
        self.refused("engineer", [op], "rationale must have at most 2000", rationale="r" * 2001)
        many = [{"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"], "count": 20}] * 3
        self.refused("logistician", many, "a project buys at most 50 convoys (this one 60)")
        # texts the database or the game cannot take (a lone surrogate from JSON "\ud800", control characters)
        self.refused("engineer", [op], "title must have at most 120 characters and no control", title="a\ud800b")
        self.refused("engineer", [op], "rationale must have at most 2000", rationale="x\0y")
        self.refused("logistician", [{"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake\nbus"]}],
                     "vehicles[0] must be a vehicle name")
        self.refused("engineer", [dict(op, way="fake\u0007road")], "way must be an object name")
        self.propose("engineer", [op], rationale="two lines\nof reasons\twith a tab")

    def test_refs(self):
        stops = [{"at": [30, 180]}, {"at": [50, 180]}]
        self.refused("logistician", [
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"], "line": "$l1"},   # before
            {"type": "create_line", "ref": "l1", "waytype": "road", "stops": stops},
            {"type": "create_line", "ref": "$l1", "waytype": "road", "stops": stops},             # twice
            {"type": "buy_convoy", "ref": "c1", "depot": [40, 200], "vehicles": ["Fake bus"], "count": 2},
            {"type": "buy_convoy", "ref": "c2", "depot": [40, 200], "vehicles": ["Fake bus"]},
            {"type": "assign_line", "convoy": "$c2", "line": "$c2"},                               # wrong kind
            {"type": "assign_line", "convoy": "$nope", "line": "$l1"},                             # undefined
        ], "ops[0] (buy_convoy): line $l1 is not the ref of an earlier op",
            "ops[2] (create_line): ref l1 is already defined by ops[1]",
            "ops[3] (buy_convoy): ref names one convoy: use it only with count 1",
            "ops[5] (assign_line): line $c2 refers to a convoy (ops[4]), not a line",
            "ops[6] (assign_line): convoy $nope is not the ref of an earlier op")
        # defined before use: accepted
        p = self.propose("logistician", [
            {"type": "create_line", "ref": "l1", "waytype": "road", "stops": stops},
            {"type": "buy_convoy", "ref": "c1", "depot": [40, 200], "vehicles": ["Fake bus"], "line": "$l1"},
            {"type": "assign_line", "convoy": "$c1", "line": "$l1"}])
        self.assertEqual([o.get("line") for o in p["ops"]], [None, "$l1", "$l1"])
        self.assertEqual(p["ops"][1]["ref"], "c1")

    def test_descs(self):
        self.refused("fleet_manager", [
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Rocket"]},
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Old bus"]},
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake loco"]},
        ], "ops[0] (buy_convoy): vehicle 'Rocket': unknown vehicle",
            "ops[1] (buy_convoy): vehicle 'Old bus' is not available now (obsolete)",
            "ops[2] (buy_convoy): vehicle 'Fake loco' (track) does not fit a road depot")
        self.refused("engineer", [
            {"type": "build_way", "from": [1, 1], "to": [3, 1], "way": "golden_road"},
            {"type": "build_station", "at": [5, 5], "building": "Palace"},
            {"type": "build_way", "from": [70, 12], "to": [100, 12], "way": "fake_road"},
            {"type": "build_way", "from": [70, 12], "to": [100, 12], "way": "fake_road", "bridge": "rope"},
        ], "ops[0] (build_way): way 'golden_road': unknown way",
            "ops[1] (build_station): station 'Palace': unknown station",
            "ops[2] (build_way): no route from 70,12 to 100,12: no route: water",
            "ops[3] (build_way): bridge 'rope': unknown bridge")

    def test_foreign_objects(self):
        self.refused("fleet_manager", [
            {"type": "buy_convoy", "depot": [104, 96], "vehicles": ["Fake bus"]},
            {"type": "buy_convoy", "depot": [41, 200], "vehicles": ["Fake bus"]},
            {"type": "sell", "convoy": self.foreign_convoy},
            {"type": "withdraw", "convoy": 999999},
            {"type": "replace_convoy", "convoy": self.foreign_convoy, "vehicles": ["Fake bus"]},
        ], "ops[0] (buy_convoy): the depot at 104,96 belongs to company 0, not to this company",
            "ops[1] (buy_convoy): no depot at 41,200",
            "ops[2] (sell): convoy %d belongs to company 0" % self.foreign_convoy,
            "ops[3] (withdraw): convoy 999999 does not exist",
            "ops[4] (replace_convoy): convoy %d belongs to company 0" % self.foreign_convoy)
        self.refused("logistician", [
            {"type": "delete_line", "line": self.foreign_line},
            {"type": "assign_line", "convoy": self.convoy, "line": self.foreign_line},
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"], "line": 999999},
        ], "ops[0] (delete_line): line %d belongs to company 0" % self.foreign_line,
            "ops[1] (assign_line): line %d belongs to company 0" % self.foreign_line,
            "ops[2] (buy_convoy): line 999999 does not exist")

    def test_convoy_states(self):
        self.refused("dispatcher", [{"type": "withdraw", "convoy": self.parked}],
                     "convoy %d stands in a depot" % self.parked)
        p = self.propose("dispatcher", [{"type": "withdraw", "convoy": self.parked, "on": False}])
        self.assertEqual(p["ops"][0]["on"], False)

    def test_dispatcher_schedule_rule(self):
        moved = [{"at": [50, 180]}, {"at": [30, 180]}]
        self.refused("dispatcher", [{"type": "set_line_schedule", "line": self.line, "stops": moved}],
                     "the dispatcher may only change load and wait of the existing stops of line %d" % self.line)
        self.refused("dispatcher", [{"type": "set_line_schedule", "line": self.line,
                                     "stops": [{"at": [30, 180]}, {"at": [50, 180]}, {"at": [40, 180]}]}],
                     "may only change load and wait")
        same = [{"at": [30, 180, 0], "load": 80, "wait": 8192}, {"at": [50, 180]}]
        p = self.propose("dispatcher", [{"type": "set_line_schedule", "line": self.line, "stops": same}])
        self.assertEqual(p["ops"][0]["stops"], [{"at": [30, 180, 0], "load": 80, "wait": 8192}, {"at": [50, 180]}])
        # the logistician may change the stops
        self.propose("logistician", [{"type": "set_line_schedule", "line": self.line, "stops": moved}])


class EstimateTests(ProjectCase):
    def test_infrastructure_estimate_and_preview(self):
        plan = ok(self.eng("plan_way", {"way": "fake_road", "x": 140, "y": 10, "x2": 146, "y2": 13}))
        ops = [{"type": "build_way", "from": [140, 10], "to": [146, 13], "way": "fake_road"},
               {"type": "build_station", "at": [146, 13], "building": "FakeStop", "rotation": 1},
               {"type": "build_depot", "at": [140, 10], "building": "FakeRoadDepot"},
               {"type": "build_roadsign", "at": [143, 10], "sign": "fake_oneway"},
               {"type": "remove", "at": [24, 40]},
               {"type": "remove_way", "from": [150, 20], "to": [152, 21], "waytype": "road"},
               {"type": "build_wayobj", "from": [60, 100], "to": [62, 100], "wayobj": "fake_catenary"}]
        cash = self.cash()
        p = self.propose("engineer", ops, title="  Depot road  ")
        est = p["estimate"]
        self.assertEqual(p["title"], "Depot road")
        self.assertEqual(p["state"], "proposed")
        self.assertEqual([it["op"] for it in est["items"]], list(range(len(ops))))
        costs = [it["cost"] for it in est["items"]]
        self.assertEqual(costs, [plan["cost"], 3000.0, 6000.0, 300.0, 0.0, 0.0, 2400.0])
        self.assertEqual(est["total"], plan["cost"] + 3000 + 6000 + 300 + 2400)
        self.assertAlmostEqual(est["cash"], cash, delta=1)
        self.assertEqual(est["cash_after"], round(est["cash"] - est["total"], 2))
        self.assertEqual(est["maintenance_month"], 15 * plan["length"] + 40 + 50 + 2 + 10 * 3)
        # removals are priced from what the company owns there (nothing of the company on these squares: 0)
        self.assertFalse(any("removal costs are not estimated" in w for w in est["warnings"]))
        self.assertTrue(any("ops[6] (build_wayobj)" in w for w in est["warnings"]))
        self.assertEqual(est["plans"]["0"]["param"], "fake_road,")
        self.assertEqual(est["plans"]["0"]["from"], [140, 10, 0])
        self.assertEqual(est["plans"]["0"]["to"], [146, 13, 0])
        self.assertEqual(est["plans"]["0"]["samples"][0], [140, 10, 0])
        self.assertLessEqual(len(est["plans"]["0"]["samples"]), 6)
        pv = p["preview"]
        kinds = [(it["op"], it["kind"]) for it in pv["items"]]
        self.assertEqual(kinds, [(0, "way"), (1, "station"), (2, "depot"), (3, "roadsign"), (4, "remove"),
                                 (5, "remove"), (6, "wayobj")])
        self.assertEqual(pv["items"][0]["tiles"], plan["tiles"])
        self.assertEqual(pv["items"][0]["waytype"], "road")
        self.assertEqual(pv["items"][3]["waytype"], "road")
        self.assertEqual(pv["items"][6]["waytype"], "track")
        self.assertEqual(pv["items"][1]["tiles"], [[146, 13, 0]])
        self.assertEqual(len(pv["items"][5]["tiles"]), 4)
        for it in pv["items"]:
            self.assertTrue(it["label"])
            for t in it["tiles"]:
                self.assertEqual(len(t), 3)
        self.assertEqual(pv["bbox"], [24, 10, 152, 100])
        # stored as proposed, published without the preview
        row = self.db.get_project(COMPANY, p["id"])
        self.assertEqual((row["state"], row["agent"], row["estimate"]["total"]), ("proposed", "engineer",
                                                                                  est["total"]))
        ev = self.events.named("team_project", COMPANY)
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["project"]["id"], p["id"])
        self.assertNotIn("preview", ev[0]["project"])
        self.assertEqual(ev[0]["project"]["estimate"]["total"], est["total"])
        self.assertEqual(self.events.named("team_project", 0), [])

    def test_routes_along_existing_ways(self):
        p = self.propose("engineer", [
            {"type": "remove_way", "from": [30, 180], "to": [50, 180], "waytype": "road"},
            {"type": "build_wayobj", "from": [60, 140], "to": [66, 140], "wayobj": "fake_catenary"}])
        items = p["preview"]["items"]
        self.assertEqual(len(items[0]["tiles"]), 21)
        self.assertEqual(items[0]["tiles"][0], [30, 180, 0])
        self.assertEqual((items[1]["kind"], items[1]["waytype"], len(items[1]["tiles"])), ("wayobj", "track", 7))
        self.assertEqual(p["estimate"]["items"][1]["cost"], 7 * 800.0)
        self.assertFalse([w for w in p["estimate"]["warnings"] if "no " in w and "way found" in w])

    def test_bridge_preview(self):
        p = self.propose("designer", [{"type": "build_way", "from": [70, 12], "to": [100, 12], "way": "fake_road",
                                       "bridge": "fake_bridge"}])
        kinds = [it["kind"] for it in p["preview"]["items"]]
        self.assertEqual(kinds, ["way", "bridge"])
        bridge = p["preview"]["items"][1]["tiles"]
        self.assertEqual(bridge[0][1], 12)
        self.assertEqual([t[0] for t in bridge], list(range(bridge[0][0], bridge[-1][0] + 1)))
        self.assertEqual(p["estimate"]["plans"]["0"]["param"], "fake_road,,0,fake_bridge")
        self.assertIn("1 bridge", p["estimate"]["items"][0]["label"])

    def test_line_and_vehicles(self):
        stops = [{"at": [30, 180]}, {"at": [50, 180], "load": 50}]
        p = self.propose("logistician", [
            {"type": "create_line", "ref": "l1", "waytype": "road", "name": "Express", "stops": stops},
            {"type": "buy_convoy", "ref": "c1", "depot": [40, 200], "vehicles": ["Fake bus", "Mail trailer"],
             "line": "$l1"},
            {"type": "buy_convoy", "depot": [40, 200], "vehicles": ["Fake bus"], "count": 3, "line": "$l1",
             "start": False}])
        est = p["estimate"]
        self.assertEqual([it["cost"] for it in est["items"]], [0.0, 33000.0, 75000.0])
        self.assertEqual(est["total"], 108000.0)
        self.assertEqual(est["maintenance_month"], 40 + 10 + 3 * 40)
        self.assertEqual(p["ops"][1]["start"], True)
        self.assertEqual(p["ops"][2]["start"], False)
        items = p["preview"]["items"]
        self.assertEqual([it["kind"] for it in items], ["line", "convoy", "convoy"])
        self.assertEqual(items[0]["tiles"], [[30, 180, 0], [50, 180, 0]])
        self.assertEqual(items[0]["waytype"], "road")
        self.assertEqual(items[1]["tiles"], [[40, 200, 0]])

    def test_cash_after_below_zero_is_a_warning(self):
        p = self.propose("logistician", [{"type": "buy_convoy", "depot": [40, 200], "count": 20,
                                          "vehicles": ["Fake bus", "Mail trailer", "Mail trailer", "Mail trailer"]}])
        est = p["estimate"]
        self.assertEqual(est["total"], 20 * 49000.0)
        self.assertLess(est["cash_after"], 0)
        self.assertTrue(any("cannot pay this now" in w for w in est["warnings"]))

    def test_fleet_ops(self):
        p = self.propose("fleet_manager", [{"type": "replace_convoy", "convoy": self.convoy,
                                            "vehicles": ["Fake bus", "Mail trailer"]}])
        est = p["estimate"]
        self.assertEqual(est["total"], 33000.0)
        self.assertEqual(est["plans"]["0"], {"depot": [40, 200, 0], "line": self.line})
        self.assertTrue(any("is sold when it reaches a depot" in w for w in est["warnings"]))
        self.assertEqual(p["preview"]["items"][0]["tiles"], [[40, 200, 0]])
        p = self.propose("fleet_manager", [{"type": "sell", "convoy": self.convoy}])
        est = p["estimate"]
        self.assertEqual(est["total"], 0.0)
        self.assertEqual(est["items"][0]["cost"], -20000.0)
        self.assertEqual(est["income"], 20000.0)
        self.assertEqual(est["cash_after"], est["cash"])
        # a convoy without a line cannot be replaced; a home depot of another waytype refuses the vehicles
        self.refused("fleet_manager", [{"type": "replace_convoy", "convoy": self.parked, "vehicles": ["Fake bus"]}],
                     "convoy %d has no line" % self.parked)
        self.refused("fleet_manager", [{"type": "replace_convoy", "convoy": self.convoy,
                                        "vehicles": ["Fake coach"]}], "does not fit a road depot")


if __name__ == "__main__":
    unittest.main()
