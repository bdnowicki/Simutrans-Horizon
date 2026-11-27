"""
Tests of the engine agent mode of the fake engine (tools/dashboard/dev/fake_engine.py, contract E): handshake flags
and read-only modes, player checks, the agent_tool allow-list and removal checks, depots, lines, convoys, plan_way,
estimate, the network game imitation (pending changes) and locked companies on a client. Ports 13397/13398.
"""

import shutil
import tempfile
import time
import unittest
import urllib.parse

import teamtestlib as T

P1, P2 = T.ENGINE_PORTS


def q(cmd, **args):
    return cmd + (" " + urllib.parse.urlencode({k: str(v) for k, v in args.items()}) if args else "")


class EngineCase(unittest.TestCase):
    FLAGS = ()
    PORT = P1

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="fake-agent-")
        cls.proc = T.start_engine(cls.dir, cls.PORT, *cls.FLAGS)

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def call(self, cmd, **args):
        return T.call(self.PORT, q(cmd, **args))

    def ok(self, cmd, **args):
        r = self.call(cmd, **args)
        self.assertTrue(r.get("ok"), (cmd, args, r))
        return r

    def err(self, cmd, text, **args):
        r = self.call(cmd, **args)
        self.assertFalse(r.get("ok"), (cmd, args, r))
        self.assertIn(text, r.get("error", ""), (cmd, args, r))
        return r

    def cash(self, nr):
        return next(p["cash"] for p in self.ok("players")["players"] if p["nr"] == nr)

    def state(self):
        return self.ok("fake_agent_state")


class ModeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="fake-modes-")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)

    def start(self, *flags):
        self.procs.append(T.start_engine(self.dir, P2, *flags, name="engine-%d" % len(self.procs)))

    def stop(self):
        self.procs.pop().kill()
        T.wait_free(P2)

    def test_full_mode(self):
        self.start()
        hello, r = T.engine(P2, "pause on=1")
        self.assertEqual((hello["read_only"], hello["time_control"], hello["agent"]), (False, True, True))
        self.assertTrue(r["ok"])
        self.assertTrue(T.call(P2, "estimate kind=way&name=fake_road")["ok"])

    def test_read_only(self):
        self.start("--read-only")
        hello, _ = T.engine(P2, "ping")
        self.assertEqual((hello["read_only"], hello["time_control"], hello["agent"]), (True, False, False))
        for line in ("pause on=1", "fast_forward on=1", "tool tool=tool_remover&x=1&y=1", "view x=1&y=1",
                     "cash amount=5"):
            self.assertEqual(T.call(P2, line).get("error"), "read-only remote control", line)
        r = T.call(P2, "agent_tool tool=tool_build_way&x=1&y=1&x2=3&y2=1&param=fake_road&player=0")
        self.assertIn("agent commands need -remote_control_agent", r["error"])
        self.assertIn("-remote_control_agent", T.call(P2, "estimate kind=way&name=fake_road")["error"])
        self.assertTrue(T.call(P2, "players")["ok"])
        self.assertTrue(T.call(P2, "depot x=104&y=96")["ok"])  # a read: no agent mode needed
        self.stop()
        self.start("--read-only", "--time", "--agent")
        hello, r = T.engine(P2, "pause on=1")
        self.assertEqual((hello["read_only"], hello["time_control"], hello["agent"]), (True, True, True))
        self.assertTrue(r["ok"])
        self.assertEqual(T.call(P2, "tool tool=tool_remover&x=1&y=1").get("error"), "read-only remote control")
        r = T.call(P2, "agent_tool tool=tool_build_way&x=1&y=1&x2=3&y2=1&param=fake_road&player=0")
        self.assertEqual(r, {"result": None, "ok": True})

    def test_old_engine_has_no_agent_commands(self):
        self.start("--old")
        hello, r = T.engine(P2, "estimate kind=way&name=fake_road")
        self.assertNotIn("agent", hello)
        self.assertEqual(r["error"], "unknown command")


class AgentCommandTests(EngineCase):
    FLAGS = ("--players", "3")

    def test_players_and_common_checks(self):
        players = self.ok("players")["players"]
        self.assertEqual([(p["nr"], p["type"]) for p in players], [(0, "human"), (1, "public"), (2, "human")])
        for player, text in (("", "player=N is required"), ("x", "player=N is required"),
                             ("1", "agents cannot act as the public player"), ("3", "no such player"),
                             ("15", "no such player"), ("-1", "no such player")):
            args = dict(tool="tool_build_way", x=1, y=1, x2=2, y2=1, param="fake_road")
            if player:
                args["player"] = player
            self.err("agent_tool", text, **args)
            self.err("plan_way", text, **dict(way="fake_road", x=1, y=1, x2=2, y2=1, **({"player": player}
                                                                                       if player else {})))

    def test_allow_list(self):
        for tool in ("tool_raise_land", "tool_lock_game", "tool_exec_script", "TOOL_BUILD_HOUSE", "4124", "14",
                     "tool_set_owner", ""):
            self.err("agent_tool", "not allowed for agents", tool=tool, x=5, y=5, player=2)
        self.ok("agent_tool", tool="TOOL_BUILD_WAY", x=150, y=150, x2=151, y2=150, param="fake_road", player=2)
        self.ok("agent_tool", tool="0x100e", x=150, y=152, x2=151, y2=152, param="fake_road", player=2)
        self.err("agent_tool", "unknown way", tool="tool_build_way", x=1, y=1, x2=2, y2=1, param="nope", player=2)
        self.err("agent_tool", "outside of the map", tool="tool_build_way", x=1, y=1, x2=999, y2=1,
                 param="fake_road", player=2)

    def test_build_plan_and_remove_ways(self):
        before = self.cash(2)
        plan = self.ok("plan_way", way="fake_road", x=140, y=10, x2=146, y2=13, player=2)
        self.assertEqual(plan["length"], 10)
        self.assertEqual(plan["tiles"][0], [140, 10, 0])
        self.assertEqual(plan["tiles"][-1], [146, 13, 0])
        self.assertEqual((plan["bridges"], plan["tunnels"]), ([], []))
        self.assertEqual(self.cash(2), before)  # a dry run changes nothing
        rev = self.ok("poll")["rev"]["map"]
        r = self.ok("agent_tool", tool="tool_build_way", x=140, y=10, x2=146, y2=13, param="fake_road", player=2)
        self.assertEqual(r, {"result": None, "ok": True})
        self.assertAlmostEqual(before - self.cash(2), plan["cost"], delta=20)  # cash also grows with time
        self.assertGreater(self.ok("poll")["rev"]["map"], rev)
        ways = [o for o in self.state()["objects"] if o["kind"] == "way" and o["owner"] == 2 and 10 <= o["y"] <= 13]
        self.assertEqual(len(ways), 10)
        # removal: own way yes; public roads, factories, other companies' ways no
        self.err("agent_tool", "cannot remove way", tool="tool_remover", x=24, y=40, player=2)
        self.err("agent_tool", "cannot remove factory", tool="tool_remover", x=10, y=20, player=2)
        self.ok("agent_tool", tool="tool_build_way", x=140, y=30, x2=142, y2=30, param="fake_road", player=0)
        self.err("agent_tool", "belongs to player 0", tool="tool_remove_way", x=140, y=30, x2=142, y2=30,
                 param="fake_road", player=2)
        self.err("agent_tool", "nothing to remove", tool="tool_remover", x=200, y=200, player=2)
        self.ok("agent_tool", tool="tool_remover", x=140, y=10, player=2)
        self.ok("agent_tool", tool="tool_remove_way", x=141, y=10, x2=146, y2=10, param="fake_road", player=2)
        left = [o for o in self.state()["objects"] if o["kind"] == "way" and o["owner"] == 2 and o["y"] == 10]
        self.assertEqual(left, [])

    def test_plan_way_bridges_and_straight(self):
        r = self.call("plan_way", way="fake_road", x=70, y=12, x2=100, y2=12, player=2)
        self.assertFalse(r["ok"])
        self.assertIn("bridge", r["reason"])
        r = self.ok("plan_way", way="fake_road", x=70, y=12, x2=100, y2=12, bridge="fake_bridge", player=2)
        self.assertEqual(len(r["bridges"]), 1)
        start, end = r["bridges"][0]
        self.assertLess(start[0], end[0])
        r = self.call("plan_way", way="fake_road", x=10, y=10, x2=20, y2=20, straight=1, player=2)
        self.assertEqual((r["ok"], "straight" in r["reason"]), (False, True))
        self.err("plan_way", "unknown bridge", way="fake_road", x=1, y=1, x2=3, y2=1, bridge="nope", player=2)

    def test_estimate(self):
        r = self.ok("estimate", kind="way", name="fake_road", length=10, count=2)
        self.assertEqual((r["price"], r["total"], r["count"]), (500.0, 10000.0, 2))
        self.assertIn("maintenance", r)
        r = self.ok("estimate", kind="station", name="FakeStop", size="2x3")
        self.assertEqual(r["total"], 3000.0 * 6)
        r = self.ok("estimate", kind="depot", name="FakeTrainDepot", count=2)
        self.assertEqual(r["total"], 24000.0)
        r = self.ok("estimate", kind="vehicle", name="Fake bus", count=3)
        for k in ("running_cost", "fixed_cost", "power", "speed", "capacity", "freight", "intro_year", "obsolete",
                  "available"):
            self.assertIn(k, r)
        self.assertEqual(r["total"], 75000.0)
        self.assertTrue(r["available"])
        self.err("estimate", "unknown vehicle", kind="vehicle", name="Rocket")
        self.err("estimate", "kind must be", kind="house", name="x")

    def test_stations_depots_lines_convoys(self):
        # two stops of company 2 on its own road, a depot read of its depot
        self.ok("agent_tool", tool="tool_build_way", x=30, y=180, x2=50, y2=180, param="fake_road", player=2)
        self.err("agent_tool", "needs a road way", tool="tool_build_station", x=30, y=181, param="FakeStop", player=2)
        for x in (30, 50):
            self.ok("agent_tool", tool="tool_build_station", x=x, y=180, param="FakeStop", player=2)
        self.err("agent_tool", "already", tool="tool_build_station", x=30, y=180, param="FakeStop", player=2)
        stops = [s for s in self.ok("stations")["stations"] if s["owner"] == 2]
        self.assertEqual(sorted(s["pos"]["x"] for s in stops), [30, 50])
        depot = self.ok("depot", x=40, y=200)
        self.assertEqual((depot["owner"], depot["waytype"], depot["convoys"]), (2, "road", []))
        self.err("depot", "no depot", x=41, y=200)
        # a convoy: buy, extend, refuse wrong waytypes and other companies' depots
        before = self.cash(2)
        r = self.ok("depot_op", player=2, x=40, y=200, op="a", convoy=0, vehicle="Fake bus")
        cid = r["convoy"]
        self.assertAlmostEqual(before - self.cash(2), 25000, delta=20)
        self.ok("depot_op", player=2, x=40, y=200, op="a", convoy=cid, vehicle="Mail trailer")
        self.err("depot_op", "does not fit", player=2, x=40, y=200, op="a", convoy=cid, vehicle="Fake loco")
        self.err("depot_op", "belongs to player 0", player=2, x=104, y=96, op="a", convoy=0, vehicle="Fake bus")
        self.err("depot_op", "unknown vehicle", player=2, x=40, y=200, op="a", convoy=0, vehicle="Rocket")
        self.err("depot_op", "not in this depot", player=2, x=40, y=200, op="b", convoy=101)
        self.err("depot_op", "no schedule", player=2, x=40, y=200, op="b", convoy=cid)
        depot = self.ok("depot", x=40, y=200)
        self.assertEqual(depot["convoys"], [{"id": cid, "name": "(%d) Fake bus" % cid,
                                             "vehicles": ["Fake bus", "Mail trailer"], "line": None}])
        conv = next(c for c in self.ok("convoys", limit=0)["convoys"] if c["id"] == cid)
        self.assertEqual((conv["owner"], conv["state"], conv["vehicles"]), (2, "in_depot", 2))
        # a line between the stops: created, listed, changed, renamed
        sched = "0|1|30,180,0,0,0|50,180,0,50,0|"
        r = self.ok("line_op", player=2, op="c", waytype="road", schedule=sched)
        lid = r["line"]
        line = next(ln for ln in self.ok("lines", limit=0)["lines"] if ln["id"] == lid)
        self.assertEqual((line["owner"], [s["pos"]["x"] for s in line["stops"]]), (2, [30, 50]))
        self.err("line_op", "does not match", player=2, op="c", waytype="rail", schedule=sched)
        self.err("line_op", "belongs to player", player=2, op="c", waytype=1,
                 schedule="0|1|30,180,0,0,0|%d,%d,0,0,0|" % (self.ok("stations")["stations"][1]["pos"]["x"],
                                                            self.ok("stations")["stations"][1]["pos"]["y"]))
        self.err("line_op", "no stop or way", player=2, op="c", waytype=1, schedule="0|1|31,181,0,0,0|")
        self.err("line_op", "not offered", player=2, op="u", line=lid)
        self.err("line_op", "belongs to player 2", player=0, op="d", line=lid)
        self.ok("line_op", player=2, op="g", line=lid, schedule="0|1|50,180,0,0,0|30,180,0,0,0|40,180,0,0,0|")
        self.ok("line_op", player=2, op="r", line=lid, name="Express")
        self.ok("line_op", player=2, op="w", line=lid, withdraw=1)
        line = self.ok("line", id=lid)
        self.assertEqual((line["line"]["name"], line["line"]["withdraw"], len(line["schedule"])), ("Express", True, 3))
        self.ok("line_op", player=2, op="w", line=lid, withdraw=0)
        # the convoy on the line: start, withdraw, back to the depot, sell
        self.err("convoy_op", "belongs to player 0", player=2, convoy=101, op="w", withdraw=1)
        self.ok("convoy_op", player=2, convoy=cid, op="l", line=lid)
        self.ok("depot_op", player=2, x=40, y=200, op="b", convoy=cid)
        conv = next(c for c in self.ok("convoys", limit=0)["convoys"] if c["id"] == cid)
        self.assertEqual((conv["line"]["id"], conv["state"] in ("driving", "loading")), (lid, True))
        self.assertEqual(self.ok("depot", x=40, y=200)["convoys"], [])
        self.ok("convoy_op", player=2, convoy=cid, op="w", withdraw=1)
        self.ok("convoy_op", player=2, convoy=cid, op="d")
        self.assertEqual([c["id"] for c in self.ok("depot", x=40, y=200)["convoys"]], [cid])
        before = self.cash(2)
        self.ok("convoy_op", player=2, convoy=cid, op="x")
        self.assertGreater(self.cash(2), before + 20000)
        self.assertNotIn(cid, [c["id"] for c in self.ok("convoys", limit=0)["convoys"]])
        # disassemble and sell stored vehicles
        cid = self.ok("depot_op", player=2, x=40, y=200, op="a", convoy=0, vehicle="Fake bus")["convoy"]
        self.ok("depot_op", player=2, x=40, y=200, op="d", convoy=cid)
        self.assertEqual(self.ok("depot", x=40, y=200)["stored"], ["Fake bus"])
        self.ok("depot_op", player=2, x=40, y=200, op="s", vehicle="Fake bus")
        self.err("depot_op", "no stored", player=2, x=40, y=200, op="s", vehicle="Fake bus")
        self.ok("line_op", player=2, op="d", line=lid)
        self.assertNotIn(lid, [ln["id"] for ln in self.ok("lines", limit=0)["lines"]])
        log = self.state()["log"]
        self.assertTrue(log and all(e["ok"] for e in log))


    def tile_objects(self, x, y, typ):
        return [o for g in self.ok("tile", x=x, y=y)["grounds"] for o in g["objects"] if o["type"] == typ]

    def test_signs_and_directions(self):
        # the tile read: way directions like the game's (a branch makes a switch), signs with desc and directions
        self.ok("agent_tool", tool="tool_build_way", x=170, y=200, x2=180, y2=200, param="fake_track", player=2)
        self.ok("agent_tool", tool="tool_build_way", x=175, y=200, x2=175, y2=204, param="fake_track", player=2)
        dirs = {xy: self.tile_objects(xy[0], xy[1], "way")[0]["dirs"]
                for xy in ((170, 200), (173, 200), (175, 200), (180, 200), (175, 202), (175, 204))}
        self.assertEqual(dirs, {(170, 200): "e", (173, 200): "ew", (175, 200): "esw", (180, 200): "w",
                                (175, 202): "ns", (175, 204): "n"})
        w = self.tile_objects(173, 200, "way")[0]
        self.assertEqual((w["desc"], w["waytype"], w["owner"]), ("fake_track", "track", 2))
        self.assertEqual(self.tile_objects(24, 40, "way")[0]["dirs"], "ns")       # a public road column
        # signals: refused on switches and dead ends with the game's reason (agent_tool replies it translated)
        for x, y in ((175, 200), (170, 200), (175, 204), (24, 40), (150, 150)):
            self.err("agent_tool", "You cannot place rail signals here.", tool="tool_build_roadsign", x=x, y=y,
                     param="fake_signal", player=2)
        before = self.cash(2)
        self.ok("agent_tool", tool="tool_build_roadsign", x=173, y=200, param="fake_signal", player=2)
        self.assertAlmostEqual(before - self.cash(2), 1500, delta=20)
        s = self.tile_objects(173, 200, "signal")
        self.assertEqual([(o["name"], o["desc"], o["dirs"], o["owner"]) for o in s], [("Signal", "fake_signal", "ew", 2)])
        # a click on the same signal turns it (no new one, no cost): ew -> e -> w -> ew like the game
        turns = []
        for _ in range(3):
            self.ok("agent_tool", tool="tool_build_roadsign", x=173, y=200, param="fake_signal", player=2)
            turns.append([o["dirs"] for o in self.tile_objects(173, 200, "signal")])
        self.assertEqual(turns, [["e"], ["w"], ["ew"]])
        # one-way signs on a public road: one direction, a second click reverses it; another company's sign refused
        self.ok("agent_tool", tool="tool_build_roadsign", x=24, y=60, param="fake_oneway", player=2)
        self.assertEqual([o["dirs"] for o in self.tile_objects(24, 60, "roadsign")], ["n"])
        self.ok("agent_tool", tool="tool_build_roadsign", x=24, y=60, param="fake_oneway", player=2)
        self.assertEqual([o["dirs"] for o in self.tile_objects(24, 60, "roadsign")], ["s"])
        self.err("agent_tool", "This piece of land is owned by another player!", tool="tool_build_roadsign", x=24, y=60,
                 param="fake_oneway", player=0)
        self.err("agent_tool", "You cannot place rail signals here.", tool="tool_build_roadsign", x=24, y=24,
                 param="fake_oneway", player=2)                                    # a junction: nesw
        # a signal and a road sign never share a square (a level crossing with a one-way sign)
        self.ok("agent_tool", tool="tool_build_way", x=186, y=210, x2=190, y2=210, param="fake_road", player=2)
        self.ok("agent_tool", tool="tool_build_way", x=188, y=208, x2=188, y2=212, param="fake_track", player=2)
        self.ok("agent_tool", tool="tool_build_roadsign", x=188, y=210, param="fake_oneway", player=2)
        self.err("agent_tool", "You cannot place rail signals here.", tool="tool_build_roadsign", x=188, y=210,
                 param="fake_signal", player=2)
        # one sign per click
        self.err("agent_tool", "one sign per click", tool="tool_build_roadsign", x=171, y=200, x2=174, y2=200,
                 param="fake_signal", player=2)


class OldTileTests(EngineCase):
    FLAGS = ("--players", "3", "--no-tile-dirs")
    PORT = P2

    def test_tile_without_the_new_keys(self):
        self.ok("agent_tool", tool="tool_build_way", x=170, y=200, x2=180, y2=200, param="fake_track", player=2)
        self.ok("agent_tool", tool="tool_build_roadsign", x=173, y=200, param="fake_signal", player=2)
        objs = [o for g in self.ok("tile", x=173, y=200)["grounds"] for o in g["objects"]]
        self.assertEqual(sorted(o["type"] for o in objs), ["signal", "way"])
        for o in objs:
            self.assertFalse({"desc", "waytype", "dirs"} & set(o), o)


class NetworkTests(EngineCase):
    FLAGS = ("--players", "3", "--net")

    def test_pending_then_applied(self):
        r = self.ok("agent_tool", tool="tool_build_way", x=140, y=60, x2=145, y2=60, param="fake_road", player=2)
        self.assertEqual(r, {"pending": True, "ok": True})
        self.assertFalse([o for o in self.state()["objects"] if o["y"] == 60])
        r = self.ok("depot_op", player=2, x=40, y=200, op="a", convoy=0, vehicle="Fake bus")
        self.assertEqual(r, {"pending": True, "ok": True})
        r = self.ok("plan_way", way="fake_road", x=1, y=1, x2=3, y2=1, player=2)
        self.assertNotIn("pending", r)
        self.assertEqual(r["length"], 3)
        st = T.wait_until(lambda: (lambda s: s if s["applied"] >= 2 else None)(self.state()), 5)
        self.assertEqual(len([o for o in st["objects"] if o["y"] == 60]), 6)
        self.assertEqual(len(self.ok("depot", x=40, y=200)["convoys"]), 1)
        # a change that fails when it is applied (no money left) vanishes as in a network game; the log tells
        self.ok("cash", player=2, amount=-self.cash(2) + 100)
        r = self.ok("agent_tool", tool="tool_build_way", x=150, y=70, x2=159, y2=70, param="fake_road", player=2)
        self.assertEqual(r["pending"], True)
        time.sleep(1.0)
        st = self.state()
        self.assertFalse([o for o in st["objects"] if o["y"] == 70])
        self.assertEqual(st["log"][-1]["ok"], False)
        self.assertIn("Insufficient funds", st["log"][-1]["error"])


class ClientLockTests(EngineCase):
    FLAGS = ("--players", "3", "--net-client", "--locked", "2", "--forbid-tool", "tool_build_depot")
    PORT = P2

    def test_locked_company_refused_on_a_client(self):
        players = {p["nr"]: p for p in self.ok("players")["players"]}
        self.assertTrue(players[2]["locked"])
        self.assertFalse(players[0]["locked"])
        self.err("agent_tool", "protected by a password on this client", tool="tool_build_way", x=1, y=1, x2=2, y2=1,
                 param="fake_road", player=2)
        self.err("depot_op", "protected by a password on this client", player=2, x=40, y=200, op="a", convoy=0,
                 vehicle="Fake bus")
        r = self.ok("agent_tool", tool="tool_build_way", x=1, y=5, x2=2, y2=5, param="fake_road", player=0)
        self.assertEqual(r["pending"], True)
        self.ok("estimate", kind="way", name="fake_road")
        self.err("agent_tool", "scenario", tool="tool_build_depot", x=24, y=24, param="FakeRoadDepot", player=0)


class LockedSinglePlayerTests(EngineCase):
    FLAGS = ("--players", "3", "--locked", "2")
    PORT = P2

    def test_locked_company_acts_in_single_player(self):
        self.assertTrue({p["nr"]: p for p in self.ok("players")["players"]}[2]["locked"])
        r = self.ok("agent_tool", tool="tool_build_way", x=1, y=5, x2=2, y2=5, param="fake_road", player=2)
        self.assertEqual(r, {"result": None, "ok": True})


if __name__ == "__main__":
    unittest.main()
