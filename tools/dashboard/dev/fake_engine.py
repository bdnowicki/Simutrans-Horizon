#!/usr/bin/env python3
# This file is part of the Simutrans-Horizon project under the Artistic License.
# (see LICENSE.txt)
"""
Fake Simutrans remote control for developing and testing the dashboard bridge without a game.

Speaks the line protocol (HELLO handshake, one JSON line per request, rid= echo) and answers
poll, positions, messages [since=], players, lines, convoys, stations, factories, cities,
status, ping, map, tile and the actions pause, fast_forward, view, zoom, tool, cash with
synthetic data shaped like the real replies (contract in the phase 0b spec). Time runs, convoys
move, messages appear. Protocol 2 (HELLO simutrans-remote 2) adds subscribe/unsubscribe and the
event lines of tools/mcp/README.md "Events (protocol 2)": messages, month, world, status, cash,
convoys, arrivals and overflow. Test-only commands:
  fake_reload            load "another world" (world.gen + 1, new ids, messages reset)
  fake_message text=..   add a message now
  fake_burst n=N         add N messages at once
  fake_remove_convoy [id=]  remove a convoy (default: the last one)
  fake_set_state id= state=N  set the state of a convoy (index into the states list)
  fake_overflow drop=K   the next K events of every subscribed connection are lost (then overflow)
  fake_build x= y= [w=1] [h=1]  "build" a road on the region (a map change for map_changes)
  fake_fail n=N          the next N minimap requests fail (tests of tile retries)
  fake_legs [shift=N]    the convoys of every line drive the next legs of their schedule (or leg N)
  fake_schedule          a schedule changed (poll.rev.schedules + 1)
  fake_event topic= data=  an event with any JSON data (e.g. of an unexpected shape)
  fake_stats [reset=1]   how often desc_list, scene3d, heights and vehicles3d were asked (cache tests)
  fake_time [month=1-12][&day=1][&hour=0-24]  jump to that time of the current year (next year when it would go
                         back before the start; month event); scene3d season and snowline follow the game's
                         formulas (winter snowline 3, summer 9)

--markup puts HTML with script (<img onerror>, <svg onload>) into every name, message and label, so a
test can check that the dashboard shows game strings as text.

The map export (palette, minimap, map_changes with 64 x 64 cells, labels) draws a synthetic map;
the statistics modes (traffic, ...) change their colours every game month. The detail commands
finance, line, convoy, line_route and station (with history, capacity, waiting, lines, departures)
answer with synthetic histories. Every line has a schedule; line_route all=1 returns the legs of at
most two convoys per line, which move on to the next legs every quarter month (or with fake_legs),
so a client sees the route of a line only bit by bit, like in the game. city, factory, supply_chain,
goods, world_stats and factories links=1 describe a small world of 6 cities and 13 factories with 10
supply links (storage, histories and which links are active change every month); --old answers the
lists only, without city ids and links.

The 3D export (desc_list, scene3d, heights, vehicles3d) answers in the block layouts of the game
(tools/mcp/README.md "3D export") for the synthetic map: heights in 16 x 16 blocks, the river as water,
the roads (also those of fake_build) as ways, trees, a few buildings, a stop building on the square of every
station, a 2 x 2 factory building at every factory and a 2 x 2 town hall at every city (picking tests), the
convoys with two cars each. The first four convoys of a world drive scripted routes in vehicles3d (smooth, from the
game time): a train of 4 cars on a loop around squares 99-131 x 66-80 with a tunnel (squares 108-116 of its south
side), a push-pull shuttle of 3 cars on squares 100-112 of row 90 that turns round at both ends (the cars are placed
anew, as in the game), a bus with a trailer that leaves a depot at (104, 96), drives round a block and enters the
depot again (then stays away for 1.5 s), and an aircraft circling (116, 74) at 5 levels; the fifth is a ship loading
at the dock (a 2 x 1 Harbour on the river squares 88-89 of row 104, the ship on 89). A 2 x 2 FakeOffice stands on
squares 127-128 x 127-128, over the corner of four chunks. City cars and pedestrians (extras=1) move along the roads.
`tile` names the station of a square.

Remote control modes like the game's: --read-only (-remote_control_readonly: actions refused with "read-only remote
control"), --time (-remote_control_time: pause and fast forward also when read-only), --agent
(-remote_control_agent). HELLO reports read_only, time_control and agent (agent = not read-only, or --agent).

Engine agent commands (tools/dashboard checkpoint contract E) with a SIMULATED effect, for tests of the team runtime:
agent_tool (allow-list of infrastructure tools; player checks; removal refused for objects the company does not own;
built objects recorded, ways drawn into the map), depot_op (convoys appear in a depot, new convoy ids), line_op
(lines created, changed, deleted, renamed; they show up in `lines`), convoy_op, plan_way (dry run: a straight or
L-shaped path with bridges over the river and a cost), estimate (prices of the descs, also the agent-only depots
FakeRoadDepot and FakeTrainDepot) and the read `depot`. Money comes off the company's cash. --players N adds human
companies 2..N-1 (player 0 Human, 1 Public). --net imitates a network game: changing agent commands answer
{"pending": true} and take effect about 0.5 s later (failures then vanish silently, as in the game); --net-client
also refuses the companies given with --locked N (repeatable; shown as locked in `players`) like a client that does
not know their password. --forbid-tool NAME imitates a scenario that forbids a tool. What the agent commands spend
is booked into `finance` (construction, new_vehicles of the running month; the synthetic purchases and construction
of a month are lumps that do not grow while it runs), `tile` lists the ways, signs, way objects, bridges and depots
of a square, `convoy` the real vehicles, home depot, withdraw flag and value of convoys bought by agents, `line` the
minimum loads of schedules set by agents, plan_way the "param" that builds its route, and estimate "available" (and
"waytype" of vehicles) like the game. "Old bus" is an obsolete vehicle known to the agent commands only (not in
desc_list). --agent-cost-factor F makes agent commands really cost F times the prices that estimate and plan_way
tell (tests of the executor's 20 % overrun stop); --net-delay S sets the delay of pending changes. Test-only command:
  fake_agent_state       what the agent commands built and changed (objects, depots, log, cash, pending changes)

  python tools/dashboard/dev/fake_engine.py [--port 13399] [--old] [--no-events] [--no-map] [--no-3d]
         [--convoys 60] [--size 256x256] [--markup] [--delay-3d S] [--read-only] [--time] [--agent]
         [--players N] [--net] [--net-client] [--locked N] [--forbid-tool NAME] [--agent-cost-factor F]
         [--net-delay S]

--old imitates an engine without poll, positions, messages since=, paging, events, the map export and
the 3D export (limit=0 then returns nothing, like the engine before phase 0b). --no-events imitates an
engine with the phase 0b commands but only protocol 1. Both close the connection on HELLO
simutrans-remote 2, as such engines do. --no-map leaves out the map export (and the 3D export, which
came later), --no-3d only the 3D export (like the engine before it). --delay-3d makes every 3D request
take that many seconds more (tests of the queues and of the single flight of the bridge).
"""

import argparse
import base64
import json
import queue
import random
import socketserver
import struct
import threading
import time
import urllib.parse
import zlib

TOPICS = ["messages", "month", "world", "status", "cash", "convoys", "arrivals"]
RING = 2048

STATES = ["in_depot", "edit_schedule", "routing", "dummy4", "dummy5", "no_route", "driving", "loading",
          "waiting_for_clearance", "waiting_for_clearance_one_month", "can_start", "can_start_one_month",
          "self_destruct", "waiting_for_clearance_two_months", "can_start_two_months", "leaving_depot",
          "entering_depot"]
TYPE_NAMES = ["general", "ai", "city", "problems", "industry", "chat", "new_vehicle", "full", "warnings",
              "traffic_jams", "scenario", "chat_common", "chat_company", "chat_private"]
# --markup: every game string carries HTML that runs script when a page puts it into innerHTML (XSS tests)
XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1"><svg onload="window.__xss=1"></svg>'
MARK = ""
PLAYER_NAMES = ["Human", "Public"]
SIZE = 256      # world size (x, y), set by --size
SIZE_Y = 256
MAP_MODES = ["terrain", "owner", "traffic", "freight", "passengers", "mail", "tracks", "speed", "power",
             "forest", "level", "climates"]
MAP_CELL = 64
HEIGHT_COLORS = [97, 99, 19, 21, 23, 160, 161, 162, 163, 164, 165, 166, 167, 176, 177, 178, 179, 180, 181, 182,
                 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198]
SEVERITY_COLORS = [106, 2, 85, 86, 29, 30, 171, 71, 39, 132]
COL_ROAD = 208
MAP_SEVERITY_MODES = ("traffic", "freight", "speed", "power", "level")
# 3D export
VIEW3D_COMMANDS = ("desc_list", "scene3d", "heights", "vehicles3d")
DESC_KINDS = ["buildings", "vehicles", "ways", "bridges", "tunnels", "trees", "signs", "wayobjs", "goods", "citycars",
              "pedestrians"]
SCENE_LAYOUT = "x:u8,y:u8,z:i8,kind:u8,desc:i16,a:u16,b:u16,owner:i8"
VEH_LAYOUT = ("cnv:u16,desc:i16,x:u16,y:u16,ox:i16,oy:i16,zoff:i16,speed:u16,flags:u16,idx:u8,kind:u8,z:i8,dir:u8,"
              "steps:u8,steps_next:u8,nx:i8,ny:i8,nz:i8,owner:i8")
COL_FMT = {"u8": "B", "i8": "b", "u16": "H", "i16": "h"}
CLIMATE = 4  # temperate


def pack_columns(rows, layout):
    """rows -> the column block of the game: all values of a field, then the next field, little endian"""
    out = []
    for k, field in enumerate(layout.split(",")):
        out.append(struct.pack("<%d%s" % (len(rows), COL_FMT[field.split(":")[1]]), *(r[k] for r in rows)))
    return b"".join(out)


def b64z(data, level=4):
    return base64.b64encode(zlib.compress(bytes(data), level)).decode("ascii")


def fake_descs():
    """the catalogue of desc_list, every list sorted by name"""
    def year(d):
        return dict(d, intro=1900, retire=2999)
    lists = {
        "buildings": [year({"name": "FakeHouse", "type": "res", "size": [1, 1], "layouts": 1, "level": 1, "height": 1,
                            "climates": 16, "waytype": None}),
                      year({"name": "FakeOffice", "type": "com", "size": [2, 2], "layouts": 2, "level": 12, "height": 6,
                            "climates": 16, "waytype": None}),
                      year({"name": "FakeStop", "type": "stop", "size": [1, 1], "layouts": 2, "level": 1, "height": 1,
                            "climates": 255, "waytype": "road", "enables": 3}),
                      year({"name": "FakeTownhall", "type": "tow", "size": [2, 2], "layouts": 1, "level": 4, "height": 4,
                            "climates": 255, "waytype": None}),
                      year({"name": "FakeWorks", "type": "factory", "size": [2, 2], "layouts": 1, "level": 1, "height": 3,
                            "climates": 255, "waytype": None}),
                      year({"name": "Harbour", "type": "stop", "size": [2, 1], "layouts": 4, "level": 1, "height": 1,
                            "climates": 255, "waytype": "water", "enables": 4})],
        "vehicles": [year({"name": "Fake airliner", "waytype": "air", "length": 8, "freight": "Passagiere",
                           "capacity": 150, "power": 8000, "speed": 800}),
                     year({"name": "Fake bus", "waytype": "road", "length": 8, "freight": "Passagiere", "capacity": 40,
                           "power": 150, "speed": 80}),
                     year({"name": "Fake coach", "waytype": "track", "length": 8, "freight": "Passagiere",
                           "capacity": 60, "power": 0, "speed": 160}),
                     year({"name": "Fake loco", "waytype": "track", "length": 8, "freight": "None", "capacity": 0,
                           "power": 2000, "speed": 160}),
                     year({"name": "Mail trailer", "waytype": "road", "length": 6, "freight": "Post", "capacity": 20,
                           "power": 0, "speed": 80}),
                     year({"name": "Steamer", "waytype": "water", "length": 8, "freight": "Kohle", "capacity": 400,
                           "power": 900, "speed": 30})],
        "ways": [{"name": "fake_road", "waytype": "road", "system": "flat", "speed": 50},
                 {"name": "fake_track", "waytype": "track", "system": "flat", "speed": 120},
                 {"name": "powerline", "waytype": "powerline", "system": "flat", "speed": 0}],
        "bridges": [{"name": "fake_bridge", "waytype": "road", "speed": 50, "pillars": 2}],
        "tunnels": [{"name": "fake_tunnel", "waytype": "road", "speed": 50}],
        "trees": [{"name": "Birch", "climates": 16}, {"name": "Oak", "climates": 16}, {"name": "Pine", "climates": 48}],
        "signs": [{"name": "fake_oneway", "waytype": "road", "flags": 1, "traffic_light": False},
                  {"name": "fake_signal", "waytype": "track", "flags": 8, "traffic_light": False}],
        "wayobjs": [{"name": "fake_catenary", "waytype": "track", "speed": 160, "overhead": True}],
        "goods": [{"name": g[1], "color": g[7], "catg": g[5]} for g in sorted(GOODS, key=lambda g: g[1].encode())],
        "citycars": [year({"name": "FakeCar red", "speed": 60}), year({"name": "FakeVan", "speed": 50})],
        "pedestrians": [year({"name": "FakeWalker"})],
    }
    for kind in DESC_KINDS:
        lists[kind] = [dict({"i": i}, **d) for i, d in enumerate(lists[kind])]
    gen = 0x811C9DC5  # FNV-1a over all lists, like the game's catalogue hash
    for b in json.dumps([lists[k] for k in DESC_KINDS], separators=(",", ":")).encode("utf-8"):
        gen = ((gen ^ b) * 0x01000193) & 0xFFFFFFFF
    return lists, gen


# -- scripted vehicles of vehicles3d (the first four convoys of a world): positions from the game time

SIDE_BIT = {(0, -1): 1, (1, 0): 2, (0, 1): 4, (-1, 0): 8}
VF_FRONT, VF_LAST, VF_LEAVING, VF_ENTERING, VF_LOADING = 1, 2, 4, 8, 16
VF_TUNNEL, VF_HIDDEN, VF_FLYING = 64, 128, 256
SCRIPTS = ("loop", "shuttle", "depot", "air", "ship")
DOCK = ((88, 104), (89, 104))  # the Harbour's squares (river), the ship lies on the second
OFFICE_CORNER = (127, 127)  # a 2 x 2 FakeOffice over the corner of chunks (1,1), (2,1), (1,2), (2,2)
# seasons and snowline as the game computes them (world/simworld.cc recalc_season_snowline)
MONTH_SEASON = (2, 2, 2, 3, 3, 0, 0, 0, 0, 1, 1, 2)
SNOW_FACTOR = (99, 95, 80, 50, 25, 10, 0, 5, 20, 35, 65, 85)
WINTER_LINE, SUMMER_LINE = 3, 9


def make_track(tiles, closed):
    """squares -> segments (tile, entry and exit edge middles, dir, steps_next, next square, length) + total"""
    segs, cum, n = [], 0.0, len(tiles)
    for i, (x, y) in enumerate(tiles):
        nxt = tiles[(i + 1) % n] if closed or i < n - 1 else None
        prv = tiles[i - 1] if closed or i > 0 else None
        if prv is None:
            prv = (2 * x - nxt[0], 2 * y - nxt[1])
        if nxt is None:
            nxt = (2 * x - prv[0], 2 * y - prv[1])
        ein, eout = (prv[0] - x, prv[1] - y), (nxt[0] - x, nxt[1] - y)
        straight = ein == (-eout[0], -eout[1])
        d = SIDE_BIT[eout] if straight else SIDE_BIT[eout] | SIDE_BIT[(-ein[0], -ein[1])]
        ln = 1.0 if straight else 0.5 ** 0.5
        segs.append({"tx": x, "ty": y, "a": (x + 0.5 + ein[0] * 0.5, y + 0.5 + ein[1] * 0.5),
                     "b": (x + 0.5 + eout[0] * 0.5, y + 0.5 + eout[1] * 0.5), "dir": d, "sn": 255 if straight else 180,
                     "next": eout, "len": ln, "cum": cum})
        cum += ln
    return segs, cum


def track_at(track, s, closed):
    segs, total = track
    s = s % total if closed else min(max(s, 0.0), total - 1e-4)
    lo, hi = 0, len(segs) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if segs[mid]["cum"] <= s:
            lo = mid
        else:
            hi = mid - 1
    g = segs[lo]
    f = (s - g["cum"]) / g["len"]
    x = g["a"][0] + (g["b"][0] - g["a"][0]) * f
    z = g["a"][1] + (g["b"][1] - g["a"][1]) * f
    return g, f, x, z


def tile_rows(track, closed, fronts, descs, speed, flags_of, cnv, owner, height):
    """one vehicles3d row per car: fronts = arc positions of the cars, front first"""
    rows = []
    for k, s in enumerate(fronts):
        g, f, x, z = track_at(track, s, closed)
        tx, ty = g["tx"], g["ty"]
        fl = flags_of(g, f) | (VF_FRONT if k == 0 else 0) | (VF_LAST if k == len(fronts) - 1 else 0)
        rows.append((cnv & 0xFFFF, descs[k], tx, ty, int(round((x - tx - 0.5) * 256)), int(round((z - ty - 0.5) * 256)), 0,
                     speed, fl, k, 0, height(tx, ty), g["dir"], min(g["sn"], int(f * (g["sn"] + 1))), g["sn"],
                     g["next"][0], g["next"][1], 0, owner))
    return rows


LOOP = make_track([(x, 66) for x in range(100, 132)] + [(131, y) for y in range(67, 81)]
                  + [(x, 80) for x in range(130, 98, -1)] + [(99, y) for y in range(79, 65, -1)], True)
SHUTTLE_E = make_track([(x, 90) for x in range(100, 113)], False)
SHUTTLE_W = make_track([(x, 90) for x in range(112, 99, -1)], False)
DEPOT = make_track([(104, 96)] + [(x, 96) for x in range(105, 118)] + [(117, y) for y in range(95, 90, -1)]
                   + [(x, 91) for x in range(116, 103, -1)] + [(104, y) for y in range(92, 97)], False)
LOOP_V, SHUTTLE_V, DEPOT_V, AIR_V = 2.0, 2.0, 1.5, 8.0  # squares per 1000 ticks
SHUTTLE_RUN, SHUTTLE_WAIT, DEPOT_AWAY = (13.0 - 1.5) / SHUTTLE_V * 1000, 3000, 3000
AIR_C, AIR_R = (116.0, 74.0), 12.0


def yards(v):
    return int(v / 1000 * 256 * 4096)


def loop_flags(g, f):
    if g["ty"] == 80 and 109 <= g["tx"] <= 115:
        return VF_TUNNEL
    if g["ty"] == 80 and ((g["tx"] == 116 and f >= 0.5) or (g["tx"] == 108 and f < 0.5)):
        return VF_HIDDEN
    return 0


def script_rows(role, ticks, cnv, owner, height, vi):
    """rows of a scripted convoy at game time ticks (empty while it is away), and the square of its front"""
    t = float(ticks)
    if role == "loop":
        s0 = t * LOOP_V / 1000
        return tile_rows(LOOP, True, [s0 - 0.5 * k for k in range(4)], [vi["Fake loco"]] + [vi["Fake coach"]] * 3,
                         yards(LOOP_V), loop_flags, cnv, owner, height)
    if role == "shuttle":
        half = SHUTTLE_RUN + SHUTTLE_WAIT
        ph = t % (2 * half)
        west = ph >= half
        ph -= half if west else 0
        run = min(ph, SHUTTLE_RUN)
        s0 = 1.5 + run * SHUTTLE_V / 1000
        waiting = ph >= SHUTTLE_RUN
        descs = [vi["Fake loco"], vi["Fake coach"], vi["Fake loco"]]
        return tile_rows(SHUTTLE_W if west else SHUTTLE_E, False, [s0 - 0.5 * k for k in range(3)], descs,
                         0 if waiting else yards(SHUTTLE_V), lambda g, f: VF_LOADING if waiting else 0, cnv, owner, height)
    if role == "depot":
        total = DEPOT[1]
        drive = (total - 0.6) / DEPOT_V * 1000
        ph = t % (drive + DEPOT_AWAY)
        if ph >= drive:
            return []
        s0 = 0.55 + ph * DEPOT_V / 1000
        fl = VF_LEAVING if s0 < 1.6 else VF_ENTERING if s0 > total - 1.6 else 0
        return tile_rows(DEPOT, False, [s0, s0 - 0.5], [vi["Fake bus"], vi["Mail trailer"]], yards(DEPOT_V),
                         lambda g, f: fl, cnv, owner, height)
    if role == "ship":
        x, y = DOCK[1]
        return [(cnv & 0xFFFF, vi["Steamer"], x, y, 0, 0, 0, 0, VF_FRONT | VF_LAST | VF_LOADING, 0, 0, 0, 2, 128, 255, 1, 0,
                 0, owner)]
    if role == "air":
        import math
        a = t * AIR_V / 1000 / AIR_R
        x, z = AIR_C[0] + AIR_R * math.cos(a), AIR_C[1] + AIR_R * math.sin(a)
        hx, hz = -math.sin(a), math.cos(a)
        tx, ty = int(x), int(z)
        sx, sz = (1 if hx > 0.38 else -1 if hx < -0.38 else 0), (1 if hz > 0.38 else -1 if hz < -0.38 else 0)
        d = (2 if sx > 0 else 8 if sx < 0 else 0) | (4 if sz > 0 else 1 if sz < 0 else 0)
        return [(cnv & 0xFFFF, vi["Fake airliner"], tx, ty, int(round((x - tx - 0.5) * 256)), int(round((z - ty - 0.5) * 256)),
                 80, yards(AIR_V), VF_FRONT | VF_LAST | VF_HIDDEN | VF_FLYING, 0, 0, height(tx, ty), d, 128, 255, sx, sz, 0, owner)]
    return []


# goods: index, internal name, translated, unit, category, catg, catg_index, colour index, value, speed bonus, weight
GOODS = [
    (0, "Passagiere", "Passengers", "", "Special freight", 0, 0, 62, 4.67, 18, 85),
    (1, "Post", "Mail", "bags", "Special freight", 0, 1, 70, 5.33, 15, 50),
    (2, "Kohle", "Coal", "t", "Bulk goods", 2, 10, 140, 8.0, 0, 1000),
    (3, "Holz", "Wood", "t", "Long goods", 6, 7, 100, 16.67, 0, 1000),
    (4, "Bretter", "Planks", "t", "Long goods", 6, 7, 36, 13.33, 2, 1000),
    (5, "Oel", "Crude oil", "m³", "Oil/gasoline", 3, 9, 125, 10.0, 0, 900),
    (6, "Gasoline", "Gasoline", "m³", "Oil/gasoline", 3, 9, 92, 13.33, 4, 860),
    (7, "Plastik", "Plastic", "t", "Pallets", 1, 8, 15, 14.0, 5, 800),
    (8, "Getreide", "Grain", "t", "Bulk goods", 2, 10, 180, 9.0, 2, 1000),
    (9, "Lebensmittel", "Food", "crates", "Refrigerated", 4, 11, 222, 20.0, 12, 600),
    (10, "Ethanol", "Ethanol", "m³", "Oil/gasoline", 3, 9, 84, 17.67, 6, 780),
]
# factories: name, type, x, y, inputs [(goods index, max)], outputs [(goods index, max)], base production
FACTORIES = [
    ("Coal mine", "coal_mine", 10, 20, [], [(2, 400)], 40),
    ("Coal mine", "coal_mine", 60, 24, [], [(2, 400)], 30),
    ("Power plant", "coal_power", 30, 40, [(2, 900)], [], 50),
    ("Forest", "forest", 80, 90, [], [(3, 300)], 25),
    ("Sawmill", "sawmill", 100, 100, [(3, 600)], [(4, 300)], 30),
    ("Shop", "shop", 120, 140, [(4, 200), (9, 300), (7, 150)], [], 20),
    ("Oil field", "oil_field", 200, 30, [], [(5, 800)], 60),
    ("Refinery", "refinery", 180, 80, [(5, 1600)], [(6, 600), (7, 300)], 80),
    ("Gas station", "gas_station", 150, 200, [(6, 300)], [], 15),
    ("Gas station", "gas_station", 220, 210, [(6, 300)], [], 15),
    ("Farm", "farm", 40, 180, [], [(8, 500)], 35),
    ("Food factory", "food_factory", 70, 200, [(8, 900)], [(9, 400)], 45),
    ("Brewery \"<b>Ale</b>\" & Co", "brewery", 240, 120, [], [], 10),
]
# supply links: (supplier index, consumer index, goods index)
SUPPLY = [(0, 2, 2), (1, 2, 2), (3, 4, 3), (4, 5, 4), (6, 7, 5), (7, 8, 6), (7, 9, 6), (7, 5, 7), (10, 11, 8),
          (11, 5, 9)]
# cities: name, townhall x, y, area x1, y1, x2, y2, citizens at the start, growth per month
CITIES = [
    ("Springfield", 50, 60, 30, 42, 74, 84, 12400, 9),
    ("Shelbyville", 150, 160, 128, 140, 176, 186, 9800, 4),
    ("Ogdenville", 210, 60, 196, 46, 230, 78, 4100, 2),
    ("North Haverbrook", 60, 222, 44, 208, 80, 240, 2600, -1),
    ("Capital City", 130, 40, 108, 18, 156, 64, 15800, 12),
    ("Brockway <i>&amp;</i> \"Sons\"", 232, 142, 220, 130, 246, 156, 1500, 1),
]
CITY_COLUMNS = ["citizens", "growth", "buildings", "citycars", "passengers_transported", "passengers_walked",
                "passengers_generated", "mail_transported", "mail_walked", "mail_generated", "goods_supplied",
                "goods_needed"]
WORLD_COLUMNS = ["citizens", "growth", "towns", "factories", "convoys", "citycars", "passenger_ratio",
                 "passengers_generated", "mail_ratio", "mail_generated", "goods_ratio", "goods_transported"]
FACTORY_COLUMNS = ["production", "power", "boost_electric", "boost_passengers", "boost_mail", "passengers_generated",
                   "passengers_departed", "passengers_arrived", "mail_generated", "mail_departed", "mail_arrived"]


def fake_palette():
    """256 distinct colours: hues by index, 239-255 black like the game's palette"""
    out = []
    for i in range(256):
        if i >= 239:
            out.append([0, 0, 0])
            continue
        out.append([(i * 97) % 256, (i * 57 + 40) % 256, (i * 151 + 90) % 256])
    return out


def date_obj(months):
    return {"year": months // 12, "month": months % 12 + 1}


VEH_INDEX = {d["name"]: d["i"] for d in fake_descs()[0]["vehicles"]}

# -- engine agent mode (contract E): command kinds, allow-list, prices of the descs (money = the unit of cash)
ACTION_COMMANDS = ("view", "zoom", "tool", "cash")      # refused by a read-only remote control
TIME_COMMANDS = ("pause", "fast_forward")               # ... unless it has time control
AGENT_COMMANDS = ("agent_tool", "depot_op", "line_op", "convoy_op", "plan_way", "estimate")
PLAYER_UNOWNED = 15
# tool names of agent_tool: script name -> (engine name, general tool number); everything else is refused
AGENT_TOOLS = {"tool_build_way": ("TOOL_BUILD_WAY", 14), "tool_build_bridge": ("TOOL_BUILD_BRIDGE", 15),
               "tool_build_tunnel": ("TOOL_BUILD_TUNNEL", 16), "tool_remove_way": ("TOOL_WAYREMOVER", 17),
               "tool_build_wayobj": ("TOOL_BUILD_WAYOBJ", 18), "tool_build_station": ("TOOL_BUILD_STATION", 19),
               "tool_build_roadsign": ("TOOL_BUILD_ROADSIGN", 20), "tool_build_depot": ("TOOL_BUILD_DEPOT", 21),
               "tool_remove_wayobj": ("TOOL_REMOVE_WAYOBJ", 33), "tool_remover": ("TOOL_REMOVER", 1)}
REMOVAL_TOOLS = ("tool_remover", "tool_remove_way", "tool_remove_wayobj")
# name -> (waytype, price per tile/unit, maintenance per month)
WAY_PRICES = {"fake_road": ("road", 500, 15), "fake_track": ("track", 1200, 30), "powerline": ("powerline", 300, 5)}
BRIDGE_PRICES = {"fake_bridge": ("road", 5000, 60)}
TUNNEL_PRICES = {"fake_tunnel": ("road", 8000, 80)}
WAYOBJ_PRICES = {"fake_catenary": ("track", 800, 10)}
SIGN_PRICES = {"fake_oneway": ("road", 300, 2), "fake_signal": ("track", 1500, 8)}
SIGN_FLAGS = {d["name"]: d["flags"] for d in fake_descs()[0]["signs"]}
SIGNAL_TYPE = 8 | 16 | 64 | 256     # roadsign_desc_t::is_signal_type()
# the game's reasons of tool_build_roadsign_t as agent_tool replies them (translated to English, on one line)
SIGN_REFUSED = "You cannot place rail signals here."
SIGN_FOREIGN = "This piece of land is owned by another player!"
NESW = ((0, -1, 1, "n"), (1, 0, 2, "e"), (0, 1, 4, "s"), (-1, 0, 8, "w"))   # dx, dy, direction bit, letter


def dirs_text(ribi):
    return "".join(c for _, _, bit, c in NESW if ribi & bit)


def ribi_count(ribi):
    return bin(ribi & 15).count("1")
STATION_PRICES = {"FakeStop": ("road", 3000, 40), "Harbour": ("water", 6000, 80)}
DEPOT_PRICES = {"FakeRoadDepot": ("road", 6000, 50), "FakeTrainDepot": ("track", 12000, 90)}
# vehicle -> (price, running cost per km, fixed cost per month)
VEHICLE_PRICES = {"Fake airliner": (900000, 9.0, 3000), "Fake bus": (25000, 1.2, 40), "Fake coach": (40000, 0.8, 30),
                  "Fake loco": (120000, 4.0, 200), "Mail trailer": (8000, 0.2, 10), "Steamer": (150000, 3.0, 150)}
VEHICLE_DESCS = {d["name"]: d for d in fake_descs()[0]["vehicles"]}
# an agent-only obsolete vehicle (not in desc_list, whose catalogue hash the 3D tests compare): "not available" tests
VEHICLE_DESCS["Old bus"] = {"name": "Old bus", "waytype": "road", "length": 8, "freight": "Passagiere",
                            "capacity": 30, "power": 90, "speed": 50, "intro": 1850, "retire": 1900}
VEHICLE_PRICES["Old bus"] = (15000, 1.5, 30)
SELL_FACTOR = 0.8   # share of the price a sold vehicle brings
# line types (simline_t) and the waytypes of their vehicles
LINE_TYPES = {1: "road", 2: "rail", 3: "water", 4: "air", 5: "monorail", 6: "tram", 7: "maglev", 8: "narrowgauge"}
LINE_WAYTYPE = {1: "road", 2: "track", 3: "water", 4: "air", 5: "monorail", 6: "tram", 7: "maglev", 8: "narrowgauge"}
NET_DELAY = 0.5     # --net: seconds until a pending change takes effect


class World:
    def __init__(self, opts):
        self.opts = opts
        self.lock = threading.Lock()
        self.gen = 1
        self.rng = random.Random(1)
        self.paused = False
        self.ff = False
        self.mult = 16
        self.view = {"x": 128, "y": 128, "z": 0}
        self.zoom = 4
        # events (protocol 2): seq -> (topic, client id or 0, line bytes), the newest RING kept
        self.events = {}
        self.event_seq = 0
        self.arrivals_pending = []
        self.mute = True  # no message events while a world is built
        self.leg_shift = 0
        self.schedule_counter = 0
        self.new_world()
        self.mute = False

    def add_event(self, topic, data, client=0):
        if self.mute:
            return
        self.event_seq += 1
        line = json.dumps({"event": topic, "seq": self.event_seq, "date": date_obj(self.months), "data": data},
                          separators=(",", ":")) + "\n"
        self.events[self.event_seq] = (topic, client, line.encode("utf-8"))
        self.events.pop(self.event_seq - RING, None)

    def new_world(self):
        rng = self.rng
        base = 100 * self.gen
        self.ticks = 1000 * self.gen
        self.ticks_per_month = int(self.opts.month_seconds * 2000)
        self.start_months = 1950 * 12 + self.gen
        self.cash = [1000000.0, 50000.0] + [500000.0] * (len(PLAYER_NAMES) - 2)
        self.arrivals_pending = []
        self.lines = [{"id": base + i, "name": "Line %d" % (base + i) + MARK, "owner": i % 2, "type": "bus"}
                      for i in range(1, 9)]
        self.stations = [{"id": base + i, "name": "Stop %d" % (base + i) + MARK, "owner": i % 2,
                          "pos": {"x": rng.randrange(SIZE), "y": rng.randrange(SIZE_Y), "z": 0}}
                         for i in range(1, 21)]
        # schedules: 4-6 different stops per line; the first line also passes a waypoint
        for i, line in enumerate(self.lines, 1):
            line["stops"] = [self.stations[(i * 3 + j * 2) % len(self.stations)] for j in range(4 + i % 3)]
            if i == 1:
                line["stops"].insert(2, {"waypoint": True, "pos": {"x": 5, "y": 7, "z": 0}})
        self.convoys = []
        for i in range(1, self.opts.convoys + 1):
            line = self.lines[i % len(self.lines)]
            self.convoys.append({"id": base + i, "name": "(%d) Bus" % (base + i) + MARK, "owner": line["owner"],
                                 "line": line["id"], "x": rng.randrange(SIZE), "y": rng.randrange(SIZE_Y),
                                 "z": 0, "dx": rng.choice((-1, 1)), "state": 6, "load": rng.randrange(101)})
        for c, role in zip(self.convoys, SCRIPTS):
            c["script"] = role
        self.messages = []
        for k in range(3):
            self._add_message("World %d message %d" % (self.gen, k) + MARK, 0)
        self.new_map()
        self.new_agent_state(base)

    def new_agent_state(self, base):
        """what the engine agent commands work on: depots (a road and a track depot of player 0, a road depot of every
        further human company), objects built by agents (by square), the log of applied changes, id counters"""
        self.depots = [{"pos": [104, 96, 0], "owner": 0, "waytype": "road", "name": "FakeRoadDepot", "convoys": [],
                        "stored": []},
                       {"pos": [60, 100, 0], "owner": 0, "waytype": "track", "name": "FakeTrainDepot", "convoys": [],
                        "stored": []}]
        for p in range(2, len(PLAYER_NAMES)):
            self.depots.append({"pos": [20 + 10 * p, 200, 0], "owner": p, "waytype": "road", "name": "FakeRoadDepot",
                                "convoys": [], "stored": []})
        self.objects = {}       # (x, y) -> [{"kind", "name", "owner"}] built by agent commands
        self.booked = {}        # (player, month) -> [construction, new_vehicles] of agent commands (finance)
        self.agent_log = []     # applied changes (also failed pending ones), newest last
        self.next_convoy = base + self.opts.convoys + 1
        self.next_line = base + 50
        self.next_station = base + 50

    def new_map(self):
        """synthetic minimap colours (height bands, a river, a road grid) and the change tracking"""
        self.map_gen = getattr(self, "map_gen", 0) + 1
        self.track_start = self.map_gen
        self.terrain = bytearray(SIZE * SIZE_Y)
        self.owned = bytearray(SIZE * SIZE_Y)  # 0 = nobody, else player nr + 1
        shift = self.gen * 8
        for y in range(SIZE_Y):
            row = y * SIZE
            for x in range(SIZE):
                if abs(x - SIZE // 3 - (y % 40) // 4) < 4:
                    c = HEIGHT_COLORS[2]
                elif (x + shift) % 32 == 0 or (y + shift) % 32 == 0:
                    c = COL_ROAD
                    self.owned[row + x] = 2  # public roads
                else:
                    c = HEIGHT_COLORS[5 + (x // 24 + y // 32) % 30]
                self.terrain[row + x] = c
        self.cells = ((SIZE + MAP_CELL - 1) // MAP_CELL, (SIZE_Y + MAP_CELL - 1) // MAP_CELL)
        self.cell_gen = [0] * (self.cells[0] * self.cells[1])
        self.labels = [{"pos": {"x": 20, "y": 20, "z": 0}, "text": "Marker <b>&</b>" + MARK, "owner": 0},
                       {"pos": {"x": SIZE - 30, "y": SIZE_Y - 30, "z": 0}, "text": "Far marker", "owner": -1}]

    def build(self, x, y, w, h):
        """a road on the region: a map change"""
        self.map_gen += 1
        for yy in range(max(0, y), min(SIZE_Y, y + h)):
            for xx in range(max(0, x), min(SIZE, x + w)):
                self.terrain[yy * SIZE + xx] = COL_ROAD
                self.owned[yy * SIZE + xx] = 1
                self.cell_gen[(yy // MAP_CELL) * self.cells[0] + xx // MAP_CELL] = self.map_gen

    def map_color(self, x, y, mode):
        i = y * SIZE + x
        c = self.terrain[i]
        if mode == "terrain":
            return c
        if mode == "owner":
            o = self.owned[i]
            return (o - 1) * 8 + 3 if o else c
        if c == COL_ROAD:
            if mode in MAP_SEVERITY_MODES:
                return SEVERITY_COLORS[(self.months + x // 32 + y // 32) % len(SEVERITY_COLORS)]
            if mode == "tracks":
                return 215
        return c

    @property
    def months(self):
        return self.start_months + self.ticks // self.ticks_per_month

    def _add_message(self, text, mtype, player=-1, pos=None):
        msg = {"seq": len(self.messages) + 1, "text": text, "type": mtype,
               "type_name": TYPE_NAMES[mtype], "player": player,
               "date": date_obj(self.months), "pos": pos}
        self.messages.append(msg)
        self.add_event("messages", msg)

    def step(self, dt, now):
        """advance time by dt seconds of wall clock"""
        with self.lock:
            if self.paused:
                return
            old_months = self.months
            self.ticks += int(2000 * dt * (5 if self.ff else 1))
            self.cash[0] += 10.0
            for c in self.convoys:
                if c["state"] == 6:
                    c["x"] = (c["x"] + c["dx"]) % SIZE
                if "script" in c:
                    rows = script_rows(c["script"], self.ticks, c["id"], c["owner"], lambda x, y: 0, VEH_INDEX)
                    if rows:
                        c["x"], c["y"] = rows[0][2], rows[0][3]
                if c["state"] in (6, 7) and self.rng.random() < 0.02:  # states set by fake_set_state stay
                    c["state"] = 7 if c["state"] == 6 else 6
                    c["load"] = self.rng.randrange(101)
                    if c["state"] == 7:
                        self.arrivals_pending.append([c["id"], self.rng.choice(self.stations)["id"]])
            if self.months != old_months:
                self.add_event("month", {"date": date_obj(self.months),
                                         "year_changed": self.months // 12 != old_months // 12})
                self._add_message("New month %d" % self.months, 0)
            if now - getattr(self, "_last_msg", 0) >= self.opts.msg_seconds:
                self._last_msg = now
                c = self.rng.choice(self.convoys)
                self._add_message("%s is waiting\nat a stop" % c["name"], 3, c["owner"],
                                  {"x": c["x"], "y": c["y"], "z": 0})


class Sub:
    """What a protocol 2 connection subscribed, and the state of its watchers."""

    def __init__(self, w, now):
        self.topics = set()
        self.frm = {}           # topic -> events only with a larger seq
        self.interval = 1.0
        self.player = -1
        self.next_seq = w.event_seq + 1
        self.lost = 0
        self.lost_seq = 0
        self.drop = 0           # fake_overflow: events still to lose
        self.gen = w.gen
        self.last_watch = now
        self.last_status = 0.0
        self.status = None
        self.cash = None
        self.states = None
        self.arrivals = []

    def reset(self, w, topics, now):
        if "status" in topics:
            self.status = (w.paused, w.ff, w.mult, 0)
            self.last_status = now - self.interval
        if "cash" in topics:
            self.cash = list(w.cash)
        if "convoys" in topics:
            self.states = {c["id"]: c["state"] for c in w.convoys}
        if "arrivals" in topics:
            self.arrivals = []


class Conn:
    def __init__(self, wfile):
        self.wfile = wfile
        self.wlock = threading.Lock()
        self.proto = 1
        self.sub = None
        self.id = 0

    def send(self, data):
        with self.wlock:
            try:
                self.wfile.write(data)
            except OSError:
                pass


class Engine:
    def __init__(self, opts):
        self.opts = opts
        self.w = World(opts)
        self.conns = set()
        self.conns_lock = threading.Lock()
        self.deliver_lock = threading.Lock()
        self.next_id = 1
        self.calls = {}  # 3D command -> number of requests (fake_stats)
        # --net: changes of agent commands wait here (due time, effect, what) and are applied in order
        self.net_queue = queue.Queue()
        self.pending_done = 0
        if opts.net:
            threading.Thread(target=self.net_worker, name="net", daemon=True).start()

    # -- events

    def add_conn(self, conn):
        with self.conns_lock:
            conn.id = self.next_id
            self.next_id += 1
            self.conns.add(conn)

    def remove_conn(self, conn):
        with self.conns_lock:
            self.conns.discard(conn)

    def run_watchers(self, conn, now):
        w, s = self.w, conn.sub
        if "arrivals" in s.topics:
            s.arrivals.extend(w.arrivals_pending)
        if s.gen != w.gen:
            s.gen = w.gen
            s.reset(w, s.topics, now)
            s.last_watch = now
            return
        if "status" in s.topics:
            cur = (w.paused, w.ff, w.mult, 0)
            if cur != s.status and now - s.last_status >= s.interval:
                w.add_event("status", {"paused": cur[0], "ff": cur[1], "mult": cur[2], "player": cur[3]}, conn.id)
                s.status = cur
                s.last_status = now
        if now - s.last_watch < s.interval:
            return
        s.last_watch = now
        if "cash" in s.topics:
            for i, cash in enumerate(w.cash):
                if s.cash is None or i >= len(s.cash) or s.cash[i] != cash:
                    if s.player < 0 or s.player == i:
                        w.add_event("cash", {"player": i, "cash": round(cash, 2), "net_wealth": round(cash, 2)}, conn.id)
            s.cash = list(w.cash)
        if "convoys" in s.topics:
            now_states = {c["id"]: c["state"] for c in w.convoys}
            old = s.states or {}
            changes = [[cid, st, old[cid]] for cid, st in now_states.items() if cid in old and old[cid] != st]
            added = [cid for cid in now_states if cid not in old]
            removed = [cid for cid in old if cid not in now_states]
            s.states = now_states
            if changes or added or removed:
                w.add_event("convoys", {"changes": changes, "added": added, "removed": removed, "states": STATES},
                            conn.id)
        if "arrivals" in s.topics and s.arrivals:
            w.add_event("arrivals", {"items": s.arrivals}, conn.id)
            s.arrivals = []

    def process_events(self):
        """watchers + delivery of the new events to every subscribed connection (like one frame)"""
        with self.deliver_lock:
            out = []
            now = time.monotonic()
            with self.w.lock:
                w = self.w
                with self.conns_lock:
                    conns = [c for c in self.conns if c.sub is not None]
                for conn in conns:
                    self.run_watchers(conn, now)
                w.arrivals_pending = []
                for conn in conns:
                    s = conn.sub
                    oldest = w.event_seq - RING + 1
                    if s.next_seq < oldest:
                        s.lost += oldest - s.next_seq
                        s.lost_seq = oldest - 1
                        s.next_seq = oldest
                    lines = []
                    while s.next_seq <= w.event_seq:
                        seq = s.next_seq
                        s.next_seq += 1
                        topic, client, line = w.events[seq]
                        if topic not in s.topics or seq <= s.frm.get(topic, 0) or client not in (0, conn.id):
                            continue
                        if s.drop > 0:
                            s.drop -= 1
                            s.lost += 1
                            s.lost_seq = seq
                            continue
                        if s.lost:
                            lines.append(self.overflow_line(s))
                        lines.append(line)
                    if s.lost and not s.drop:
                        lines.append(self.overflow_line(s))
                    if lines:
                        out.append((conn, b"".join(lines)))
            for conn, data in out:
                conn.send(data)

    def overflow_line(self, s):
        line = json.dumps({"event": "overflow", "seq": s.lost_seq, "date": date_obj(self.w.months),
                           "data": {"lost": s.lost}}, separators=(",", ":")) + "\n"
        s.lost = 0
        return line.encode("utf-8")

    def parse_topics(self, text):
        if text in ("", "all"):
            return set(TOPICS) if text == "all" else set()
        topics = set(t.strip() for t in text.split(","))
        for t in topics:
            if t not in TOPICS:
                raise ValueError("unknown topic: " + t)
        return topics

    def topic_list(self, topics):
        return [t for t in TOPICS if t in topics]

    def cmd_subscribe(self, a, conn=None):
        if conn is None or conn.proto < 2:
            raise ValueError("events need protocol 2 (greeting HELLO simutrans-remote 2)")
        topics = self.parse_topics(a.get("topics", ""))
        if not topics:
            raise ValueError("no topics")
        now = time.monotonic()
        w = self.w
        s = conn.sub
        if s is None:
            s = conn.sub = Sub(w, now)
        if "interval" in a:
            s.interval = max(250, min(3600000, int(a["interval"]))) / 1000.0
        if "player" in a:
            s.player = -1 if a["player"] == "all" else int(a["player"])
        added = topics - s.topics
        for t in added:
            s.frm[t] = w.event_seq
        s.topics |= topics
        s.reset(w, added, now)
        return {"topics": self.topic_list(s.topics), "seq": w.event_seq, "interval": int(s.interval * 1000),
                "player": s.player}

    def cmd_unsubscribe(self, a, conn=None):
        if conn is None or conn.proto < 2:
            raise ValueError("events need protocol 2 (greeting HELLO simutrans-remote 2)")
        topics = self.parse_topics(a.get("topics", "all"))
        if conn.sub is not None:
            conn.sub.topics -= topics
            if not conn.sub.topics:
                conn.sub = None
        return {"topics": self.topic_list(conn.sub.topics if conn.sub else ()), "seq": self.w.event_seq}

    # -- helpers

    def paged(self, items, a, summary_keys, full_fn):
        old = self.opts.old
        limit = int(a.get("limit", "200") or 200)
        offset = 0 if old else int(a.get("offset", "0") or 0)
        rest = items[offset:]
        if limit == 0 and not old:
            page = rest
        else:
            page = rest[:max(limit, 0)]
        summary = a.get("fields") == "summary" and not old
        out = [{k: it[k] for k in summary_keys if k in it} if summary else full_fn(it) for it in page]
        reply = {"truncated": len(rest) > len(page)}
        if not old:
            reply["total"] = len(items)
            reply["offset"] = offset
        return out, reply

    # -- commands

    def cmd_ping(self, a):
        return {"pong": True}

    def cmd_poll(self, a):
        w = self.w
        return {"ticks": w.ticks, "date": date_obj(w.months),
                "month_progress": round((w.ticks % w.ticks_per_month) / w.ticks_per_month, 3),
                "ticks_per_month": w.ticks_per_month, "paused": w.paused, "ff": w.ff, "mult": w.mult,
                "player": {"nr": 0, "name": PLAYER_NAMES[0], "cash": round(w.cash[0], 2)},
                "msg_seq": len(w.messages),
                "counts": {"convoys": len(w.convoys), "lines": len(w.lines), "halts": len(w.stations),
                           "factories": len(FACTORIES), "cities": len(CITIES), "players": len(PLAYER_NAMES)},
                "rev": {"objects": sum(c["id"] for c in w.convoys) & 0xffffffff, "schedules": w.schedule_counter,
                        "map": 0 if self.opts.no_map else w.map_gen},
                "world": {"gen": w.gen, "size_x": SIZE, "size_y": SIZE_Y, "rotation": 0}}

    def cmd_status(self, a):
        w = self.w
        return {"game": {"pakset": "fake", "networkmode": False, "server": False, "player_change_allowed": True},
                "screen": {"w": 800, "h": 600, "tile_raster_width": 64, "zoom_index": w.zoom},
                "world": {"size_x": SIZE, "size_y": SIZE_Y, "date": date_obj(w.months), "ticks": w.ticks,
                          "paused": w.paused, "fast_forward": w.ff, "time_multiplier": w.mult, "rotation": 0,
                          "cities": len(CITIES), "convoys": len(w.convoys)},
                "scenario": {"active": False},
                "player": {"nr": 0, "name": PLAYER_NAMES[0], "cash": round(w.cash[0], 2), "net_wealth": round(w.cash[0], 2)},
                "tool": {}, "view": {"center": dict(w.view), "cursor": None, "underground_mode": 0},
                "windows": []}

    def cmd_positions(self, a):
        owner = a.get("owner")
        rows = [[c["id"], c["x"], c["y"], c["z"], c["state"], c["owner"], c["line"], c["load"]]
                for c in self.w.convoys if owner is None or str(c["owner"]) == owner]
        return {"cols": ["id", "x", "y", "z", "state", "owner", "line", "load"], "states": STATES, "rows": rows}

    def cmd_messages(self, a):
        msgs = self.w.messages
        count = max(1, min(500, int(a.get("count", "20") or 20)))
        if self.opts.old:
            return {"messages": [{k: m[k] for k in ("text", "type", "date", "pos")}
                                 for m in reversed(msgs[-count:])]}
        newest = len(msgs)
        if "since" not in a:
            return {"messages": list(reversed(msgs[-count:]))}
        since = int(a["since"] or 0)
        if since > newest:
            return {"seq": newest, "messages": msgs[-count:], "truncated": newest > count, "reset": True}
        new = msgs[since:]
        return {"seq": newest, "messages": new[-count:], "truncated": len(new) > count, "reset": False}

    def cmd_players(self, a):
        w = self.w
        return {"active_player": 0, "players": [
            {"nr": i, "name": PLAYER_NAMES[i], "type": "public" if i == 1 else "human", "active": True,
             "locked": i in self.opts.locked, "cash": round(w.cash[i], 2), "net_wealth": round(w.cash[i], 2),
             "lines": sum(1 for l in w.lines if l["owner"] == i),
             "convoys": sum(1 for c in w.convoys if c["owner"] == i),
             "stations": sum(1 for s in w.stations if s["owner"] == i)} for i in range(len(PLAYER_NAMES))]}

    def owner_filter(self, items, a):
        if "owner" in a:
            return [it for it in items if str(it["owner"]) == a["owner"]]
        return items

    def cmd_convoys(self, a):
        w = self.w
        items = []
        for c in self.owner_filter(w.convoys, a):
            items.append({"id": c["id"], "name": c["name"], "owner": c["owner"],
                          "pos": {"x": c["x"], "y": c["y"], "z": c["z"]}, "state": STATES[c["state"]],
                          "line": c["line"], "speed_kmh": 50 if c["state"] == 6 else 0, "max_speed_kmh": 80,
                          "vehicles": len(c["vehicles"]) if "vehicles" in c else 2, "loading_level": c["load"],
                          "next_stop": None,
                          "profit_this_year": 100.0 + c["id"] % 7 * 10, "profit_last_month": -5.0 + c["id"] % 3})
        out, reply = self.paged(items, a, ("id", "name", "owner", "pos", "state", "line"),
                                lambda it: dict(it, line={"id": it["line"], "name": "Line %d" % it["line"]}))
        reply["convoys"] = out
        return reply

    def cmd_lines(self, a):
        w = self.w
        items = [dict(l, convoys=sum(1 for c in w.convoys if c["line"] == l["id"]))
                 for l in self.owner_filter(w.lines, a)]
        out, reply = self.paged(items, a, ("id", "name", "owner", "convoys"), self.line_full)
        reply["lines"] = out
        return reply

    def line_full(self, it):
        """item of `lines` without fields=summary"""
        out = {k: it[k] for k in ("id", "name", "owner", "type", "convoys")}
        out["stops"] = [{"pos": dict(st["pos"]), "station": "" if st.get("waypoint") else st["name"]}
                        for st in it["stops"]]
        out["this_month"], out["last_month"] = self.line_month(it, 0), self.line_month(it, 1)
        return out

    def line_month(self, line, ago):
        h = self.line_history(line)[ago]
        return {"profit": h[5], "revenue": h[2], "transported": h[1], "capacity": h[1] + h[0]}

    def cmd_stations(self, a):
        items = self.owner_filter(self.w.stations, a)
        out, reply = self.paged(items, a, ("id", "name", "owner", "pos"),
                                lambda it: dict(it, tiles=1, waiting={"total": 5}))
        reply["stations"] = out
        return reply

    def cmd_factories(self, a):
        old = self.opts.old
        links = a.get("links") == "1" and not old
        items = []
        for i in range(len(FACTORIES)):
            it = self.factory_item(i)
            if links:
                it["suppliers"] = [{"x": FACTORIES[s][2], "y": FACTORIES[s][3]} for s, c, g in SUPPLY if c == i]
                it["consumers"] = [{"x": FACTORIES[c][2], "y": FACTORIES[c][3]} for s, c, g in SUPPLY if s == i]
            items.append(it)
        keys = ("name", "type", "pos") + (("suppliers", "consumers") if links else ())
        out, reply = self.paged(items, a, keys, dict)
        reply["count"] = len(items)
        reply["factories"] = out
        return reply

    def cmd_cities(self, a):
        items = [self.city_item(i) for i in range(len(CITIES))]
        if self.opts.old:  # an engine before the city ids
            for it in items:
                del it["id"]
        items.sort(key=lambda c: -c["citizens"])
        out, reply = self.paged(items, a, ("id", "name", "townhall", "citizens"), dict)
        reply["count"] = len(items)
        reply["cities"] = out
        return reply

    # -- cities and factories (synthetic, they change every month; absent with --old except the lists)

    def city_citizens(self, i, months):
        base, growth = CITIES[i][7], CITIES[i][8]
        return max(100, base + growth * (months - self.w.start_months))

    def city_month(self, i, months):
        """one row of the city chart (CITY_COLUMNS) for a game month"""
        cz = self.city_citizens(i, months)
        pg = int(cz * 0.3 + self.wave(i + 300, months, 40, 30))
        pt = int(pg * (0.05 + 0.04 * (i % 3)) + self.wave(i + 310, months, 10, 8))
        pw = int(pg * 0.02)
        mg = int(cz * 0.07 + self.wave(i + 320, months, 10, 6))
        mt = int(mg * (0.03 + 0.02 * (i % 2)))
        need = 100 + i * 25
        return [cz, cz - self.city_citizens(i, months - 1), cz // 100, int(self.wave(i + 330, months, 8, 5)),
                max(pt, 0), pw, pg, max(mt, 0), int(mg * 0.01), mg, int(need * (0.2 + 0.1 * (i % 4))), need]

    def city_item(self, i):
        name, tx, ty, x1, y1, x2, y2 = CITIES[i][:7]
        m = self.w.months
        last = self.city_month(i, m - 1)
        col = CITY_COLUMNS.index
        return {"id": i, "name": name, "townhall": {"x": tx, "y": ty}, "area": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "citizens": self.city_citizens(i, m), "growth_this_month": self.city_month(i, m)[1],
                "buildings": self.city_citizens(i, m) // 100,
                "last_month": {"passengers_generated": last[col("passengers_generated")],
                               "passengers_transported": last[col("passengers_transported")],
                               "passengers_walked": last[col("passengers_walked")],
                               "mail_generated": last[col("mail_generated")],
                               "mail_transported": last[col("mail_transported")],
                               "goods_supplied": last[col("goods_supplied")], "goods_needed": last[col("goods_needed")]}}

    def find_city(self, a):
        n = len(CITIES)
        if "id" in a:
            try:
                i = int(a["id"])
            except ValueError:
                i = -1
            if not 0 <= i < n:
                raise ValueError("no city with this id")
            return i
        if "name" in a:
            for i in range(n):
                if CITIES[i][0] == a["name"]:
                    return i
            for i in range(n):
                if CITIES[i][0].lower() == a["name"].lower():
                    return i
            raise ValueError("no city with this name")
        if "x" in a and "y" in a:
            x, y = int(a["x"] or -1), int(a["y"] or -1)
            for i in range(n):
                c = CITIES[i]
                if c[3] <= x <= c[5] and c[4] <= y <= c[6]:
                    return i
            raise ValueError("no city at this position")
        raise ValueError("id=, name= or x= y= needed")

    def cmd_city(self, a):
        i = self.find_city(a)
        history = a.get("history", "month") or "month"
        if history not in ("month", "year", "none", "0"):
            raise ValueError("history must be month, year or none")
        x1, y1, x2, y2, growth = CITIES[i][3], CITIES[i][4], CITIES[i][5], CITIES[i][6], CITIES[i][8]
        city = self.city_item(i)
        m = self.w.months
        city.update(center={"x": (x1 + x2) // 2, "y": (y1 + y2) // 2}, growth=round(growth / 10.0, 1),
                    unemployed=(i * 37 + m) % 200 - 40, homeless=(i * 11 + m) % 90 - 60, allow_growth=i != 3)
        reply = {"city": city}
        if history == "month":
            reply["history"] = {"columns": CITY_COLUMNS, "rows": [self.city_month(i, m - k) for k in range(12)]}
        elif history == "year":
            rows = []
            for k in range(12):
                months = [self.city_month(i, m - 12 * k - j) for j in range(12)]
                row = [sum(r[c] for r in months) for c in range(len(CITY_COLUMNS))]
                row[0], row[2] = months[0][0], months[0][2]  # stock values: those of the newest month
                rows.append(row)
            reply["history"] = {"columns": CITY_COLUMNS, "rows": rows}
        reply["period"] = history if history in ("month", "year") else "none"
        return reply

    def slot_storage(self, i, k, mx, ago=0):
        tick = self.w.ticks // 4000 if ago == 0 else 0
        return int(mx * (((self.w.months - ago) * 7 + i * 13 + k * 29 + tick) % 100) / 100.0)

    def factory_item(self, i, full=False):
        """item of `factories` (full: with the fields the factory window adds per slot)"""
        name, ftype, x, y, ins, outs, prod = FACTORIES[i]
        m = self.w.months
        inputs = []
        for k, (g, mx) in enumerate(ins):
            it = {"goods": GOODS[g][2], "unit": GOODS[g][3], "storage": self.slot_storage(i, k, mx), "max": mx,
                  "in_transit": (i * 17 + k * 5 + m) % 60,
                  "received": [int(self.wave(i * 10 + k, m - j, mx * 0.6, mx * 0.2)) for j in (0, 1)],
                  "consumed": [int(self.wave(i * 10 + k + 5, m - j, mx * 0.5, mx * 0.2)) for j in (0, 1)]}
            if full:
                it.update(factor=100 + 50 * k, name=GOODS[g][1], category=GOODS[g][4])
            inputs.append(it)
        outputs = []
        for k, (g, mx) in enumerate(outs):
            it = {"goods": GOODS[g][2], "unit": GOODS[g][3], "storage": self.slot_storage(i, k + 3, mx), "max": mx,
                  "produced": [int(self.wave(i * 10 + k + 20, m - j, mx * 0.7, mx * 0.2)) for j in (0, 1)],
                  "delivered": [int(self.wave(i * 10 + k + 25, m - j, mx * 0.6, mx * 0.2)) for j in (0, 1)]}
            if full:
                it.update(factor=100 - 20 * k, name=GOODS[g][1], category=GOODS[g][4])
            outputs.append(it)
        return {"name": name, "type": ftype, "pos": {"x": x, "y": y, "z": 0}, "production": prod * 3,
                "inputs": inputs, "outputs": outputs,
                "suppliers": sum(1 for s, c, g in SUPPLY if c == i), "consumers": sum(1 for s, c, g in SUPPLY if s == i)}

    def link_active(self, j):
        return (j + self.w.months) % 3 != 0

    def factory_index(self, a):
        if "x" not in a or "y" not in a:
            raise ValueError("x= y= needed")
        x, y = int(a["x"] or -1), int(a["y"] or -1)
        for i, f in enumerate(FACTORIES):
            if f[2] <= x <= f[2] + 1 and f[3] <= y <= f[3] + 1:  # 2 x 2 squares
                return i
        raise ValueError("no factory at this position")

    def factory_halts(self, i):
        st = self.w.stations
        return [] if i % 4 == 3 else [st[(i * 3) % len(st)], st[(i * 3 + 1) % len(st)]][:1 + i % 2]

    def cmd_factory(self, a):
        i = self.factory_index(a)
        history = a.get("history", "1") not in ("0", "false", "no", "off")
        name, ftype, x, y, ins, outs, prod = FACTORIES[i]
        m = self.w.months
        f = self.factory_item(i, full=True)
        halts = self.factory_halts(i)
        if history:
            for k, it in enumerate(f["inputs"]):
                mx = it["max"]
                it["history"] = {"columns": ["storage", "received", "consumed", "in_transit"],
                                 "rows": [[self.slot_storage(i, k, mx, j),
                                           int(self.wave(i * 10 + k, m - j, mx * 0.6, mx * 0.2)),
                                           int(self.wave(i * 10 + k + 5, m - j, mx * 0.5, mx * 0.2)),
                                           (i * 17 + k * 5 + m - j) % 60] for j in range(12)]}
            for k, it in enumerate(f["outputs"]):
                mx = it["max"]
                it["history"] = {"columns": ["storage", "delivered", "produced"],
                                 "rows": [[self.slot_storage(i, k + 3, mx, j),
                                           int(self.wave(i * 10 + k + 25, m - j, mx * 0.6, mx * 0.2)),
                                           int(self.wave(i * 10 + k + 20, m - j, mx * 0.7, mx * 0.2))]
                                          for j in range(12)]}
        # status like fabrik_t::recalc_factory_status (simplified)
        full_in = [it["storage"] >= it["max"] for it in f["inputs"]]
        high_out = [it["storage"] >= 0.75 * it["max"] for it in f["outputs"]]
        if not ins and not outs:
            status = "nothing"
        elif not ins:
            if any(high_out):
                status = ("bad" if all(high_out) else "medium") if halts else "inactive"
            else:
                status = "good"
        elif not outs:
            status = "bad" if all(full_in) else "medium" if any(full_in) else "good"
        else:
            status = "bad" if any(it["storage"] == 0 for it in f["inputs"]) and halts else "good"
        boost_p = (i * 7 + m) % 30
        f.update(owner=-1 if i % 5 else 1, size={"x": 2, "y": 2}, status=status, base_production=prod,
                 production_per_minute=round(prod * 1.75 * (100 + boost_p) / 100.0, 2), productivity=100 + boost_p,
                 boost={"electric": 0, "passengers": boost_p, "mail": 0},
                 max_boost={"electric": 0, "passengers": 50, "mail": 20},
                 power={"mw": 0, "last_month_mw": 0, "producer": ftype == "coal_power", "transformer": False},
                 fields=4 if ftype == "farm" else 0, min_fields=2 if ftype == "farm" else 0)
        if ftype == "coal_power":
            f["power"].update(mw=120, last_month_mw=118, generation_mw=120)
        reply = {"factory": f,
                 "suppliers": [{"x": FACTORIES[s][2], "y": FACTORIES[s][3], "name": FACTORIES[s][0],
                                "active": self.link_active(j)} for j, (s, c, g) in enumerate(SUPPLY) if c == i],
                 "consumers": [{"x": FACTORIES[c][2], "y": FACTORIES[c][3], "name": FACTORIES[c][0],
                                "active": self.link_active(j)} for j, (s, c, g) in enumerate(SUPPLY) if s == i],
                 "halts": [{"id": h["id"], "name": h["name"], "owner": h["owner"]} for h in halts],
                 "cities": [{"id": k, "name": CITIES[k][0], "passengers": (k * 13 + m) % 90, "mail": (k * 5 + m) % 20}
                            for k in range(len(CITIES)) if (k + i) % 4 == 0]}
        if history:
            rows = []
            for j in range(12):
                bp = (i * 7 + m - j) % 30
                rows.append([int(self.wave(i + 500, m - j, prod * 3, prod)), 120 if ftype == "coal_power" else 0, 0, bp,
                             0, int(self.wave(i + 510, m - j, 60, 20)), int(self.wave(i + 520, m - j, 20, 10)),
                             int(self.wave(i + 530, m - j, 15, 8)), int(self.wave(i + 540, m - j, 12, 5)),
                             int(self.wave(i + 550, m - j, 4, 2)), int(self.wave(i + 560, m - j, 3, 2))])
            reply["history"] = {"columns": FACTORY_COLUMNS, "rows": rows}
        return reply

    def goods_index(self, text):
        t = text.lower()
        for g in GOODS:
            if g[1].lower() == t or g[2].lower() == t:
                return g[0]
        raise ValueError("unknown goods")

    def cmd_supply_chain(self, a):
        gi = None
        reply = {}
        if a.get("goods"):
            gi = self.goods_index(a["goods"])
            reply["goods"] = GOODS[gi][2]
            idx = [i for i, f in enumerate(FACTORIES) if any(g == gi for g, mx in f[4] + f[5])]
        else:
            idx = list(range(len(FACTORIES)))
        pos = {i: k for k, i in enumerate(idx)}
        reply["nodes"] = [{"pos": {"x": FACTORIES[i][2], "y": FACTORIES[i][3], "z": 0}, "name": FACTORIES[i][0],
                           "type": FACTORIES[i][1]} for i in idx]
        reply["edges"] = [[pos[s], pos[c], GOODS[g][2], self.link_active(j)] for j, (s, c, g) in enumerate(SUPPLY)
                          if s in pos and c in pos and (gi is None or g == gi)]
        return reply

    def cmd_goods(self, a):
        pal = fake_palette()
        used = {g for f in FACTORIES for g, mx in f[4] + f[5]} | {0, 1}
        return {"goods": [{"index": g[0], "name": g[1], "translated": g[2], "unit": g[3], "category": g[4],
                           "catg": g[5], "catg_index": g[6], "color_index": g[7], "color": pal[g[7]], "value": g[8],
                           "speed_bonus": g[9], "weight": g[10], "used": g[0] in used} for g in GOODS]}

    def world_month(self, months):
        rows = [self.city_month(i, months) for i in range(len(CITIES))]
        col = CITY_COLUMNS.index
        pg, pt = sum(r[col("passengers_generated")] for r in rows), sum(r[col("passengers_transported")] for r in rows)
        mg, mt = sum(r[col("mail_generated")] for r in rows), sum(r[col("mail_transported")] for r in rows)
        gs, gn = sum(r[col("goods_supplied")] for r in rows), sum(r[col("goods_needed")] for r in rows)
        return [sum(r[0] for r in rows), sum(r[1] for r in rows), len(CITIES), len(FACTORIES),
                max(0, len(self.w.convoys) - (self.w.months - months) // 3), sum(r[col("citycars")] for r in rows),
                round(100.0 * pt / pg, 2) if pg else 0, pg, round(100.0 * mt / mg, 2) if mg else 0, mg,
                round(100.0 * gs / gn, 2) if gn else 0, int(self.wave(900, months, 3000, 800))]

    def cmd_world_stats(self, a):
        period = a.get("period", "month") or "month"
        if period not in ("month", "year"):
            raise ValueError("period must be month or year")
        m = self.w.months
        if period == "month":
            rows = [self.world_month(m - k) for k in range(12)]
        else:
            rows = []
            for k in range(12):
                months = [self.world_month(m - 12 * k - j) for j in range(12)]
                row = [sum(r[c] for r in months) for c in range(len(WORLD_COLUMNS))]
                for c in (0, 2, 3, 4):  # stock values: those of the newest month
                    row[c] = months[0][c]
                for c in (6, 8, 10):
                    row[c] = round(sum(r[c] for r in months) / 12.0, 2)
                rows.append(row)
        return {"period": period, "date": date_obj(m), "columns": WORLD_COLUMNS, "rows": rows}

    def cmd_map(self, a):
        x, y = int(a.get("x", 0) or 0), int(a.get("y", 0) or 0)
        ww, hh = int(a.get("w", 32) or 32), int(a.get("h", a.get("w", 32)) or 32)
        ww, hh = max(0, min(ww, SIZE - x, 512)), max(0, min(hh, SIZE_Y - y, 512))
        w = self.w
        rows = ["".join("R" if w.terrain[(y + j) * SIZE + x + i] == COL_ROAD else "." for i in range(ww))
                for j in range(hh)]
        reply = {"region": {"x": x, "y": y, "w": ww, "h": hh}, "truncated": False, "groundwater": 0,
                 "terrain": rows}
        if a.get("features") == "1":
            reply["labels"] = [l for l in w.labels if x <= l["pos"]["x"] < x + ww and y <= l["pos"]["y"] < y + hh]
        return reply

    # -- details and histories (absent with --old)

    def wave(self, seed, month, base, amp):
        """deterministic synthetic value for a month (index counted from year 0)"""
        r = random.Random(seed * 1000003 + month)
        return base + amp * ((month * 37 + seed * 11) % 17 - 8) / 8.0 + amp * 0.3 * r.random()

    def find(self, items, a, what, key="id"):
        try:
            want = int(a.get(key, "") or "x")
        except ValueError:
            raise ValueError("%s must be a number" % key) from None
        for it in items:
            if it["id"] == want:
                return it
        raise ValueError("no %s with this id" % what)

    def stop_entry(self, st, waiting):
        if st.get("waypoint"):
            e = {"pos": dict(st["pos"]), "halt": None, "name": "Waypoint", "wait_for_load": 0}
        else:
            e = {"pos": dict(st["pos"]), "halt": st["id"], "name": st["name"],
                 "wait_for_load": 50 if st["id"] % 5 == 0 else 0}
        if waiting:
            e["waiting"] = 0 if st.get("waypoint") else (st["id"] * 7 + self.w.months) % 50
        return e

    def route_end(self, st):
        if st.get("waypoint"):
            return {"halt": None, "pos": [st["pos"]["x"], st["pos"]["y"]]}
        return {"halt": st["id"], "name": st["name"], "pos": [st["pos"]["x"], st["pos"]["y"]]}

    def leg_shift(self):
        w = self.w
        return w.leg_shift + w.ticks // max(1, w.ticks_per_month // 4)

    def convoy_leg(self, c):
        """(line, from index, to index) in the schedule of its line for a convoy that drives, else None"""
        w = self.w
        line = next((ln for ln in w.lines if ln["id"] == c["line"]), None)
        if line is None or c["state"] not in (6, 7):
            return None
        mates = [x["id"] for x in w.convoys if x["line"] == c["line"]]
        n = len(line["stops"])
        k = (mates.index(c["id"]) + self.leg_shift()) % n
        return line, k, (k + 1) % n

    def leg_reply(self, c, line, i, j):
        a, b = line["stops"][i], line["stops"][j]
        ax, ay, bx, by = a["pos"]["x"], a["pos"]["y"], b["pos"]["x"], b["pos"]["y"]
        pts = [[ax, ay]] + ([[bx, ay]] if ax != bx and ay != by else []) + [[bx, by]]
        return {"convoy": c["id"], "leg": True, "from": self.route_end(a), "to": self.route_end(b),
                "length": abs(bx - ax) + abs(by - ay), "index": 1, "points": pts}

    def line_history(self, line):
        """12 months x free_capacity transported revenue operation toll profit convoys distance max_speed"""
        w = self.w
        conv = sum(1 for c in w.convoys if c["line"] == line["id"])
        rows = []
        for ago in range(12):
            m = w.months - ago
            tr = int(self.wave(line["id"], m, 300, 120))
            rev = round(tr * 2.5, 2)
            op = round(-self.wave(line["id"] + 50, m, 400, 80), 2)
            rows.append([int(self.wave(line["id"] + 9, m, 500, 200)), tr, rev, op, 0, round(rev + op, 2), conv,
                         int(self.wave(line["id"] + 3, m, 900, 300)), 50 + line["id"] % 30])
        return rows

    def cmd_finance(self, a):
        w = self.w
        nr = int(a.get("player", "0") or 0)
        if not 0 <= nr < len(PLAYER_NAMES):
            raise ValueError("no player with this number")
        tt_list = ["all", "road", "rail"]
        tt = a.get("tt", "all") or "all"
        if tt not in ("all", "road", "rail", "ship", "monorail", "maglev", "tram", "narrowgauge", "air", "other",
                      "powerline"):
            raise ValueError("unknown transport type")
        scale = {"all": 1.0, "road": 0.7, "rail": 0.3}.get(tt, 0.0)
        period = a.get("period", "both") or "both"
        columns = ["transported", "delivered", "revenue", "running_costs", "maintenance", "toll", "operating_profit",
                   "new_vehicles", "construction", "profit", "cash", "assets", "margin", "net_wealth"]
        first = w.start_months - 30  # the game "started" 30 months before the fake world

        def row(seed, m, n_months, progress):
            f = scale * n_months * (progress if progress is not None else 1.0)
            tr = int(self.wave(seed, m, 20000, 6000) * f)
            rev = round(self.wave(seed + 1, m, 900000, 250000) * f, 2)
            run = round(-self.wave(seed + 2, m, 350000, 50000) * f, 2)
            mnt = round(-self.wave(seed + 3, m, 220000, 4000) * f, 2)
            op = round(rev + run + mnt, 2)
            # purchases and construction are lumps, not spread over the month (so they do not drift while a month
            # runs), plus what the agent commands of the player spent in these months (the executor measures it)
            lump = scale * n_months
            nv = -500000.0 * lump if m % 5 == 0 else 0.0
            con = -80000.0 * lump if m % 7 == 0 else 0.0
            if tt == "all":
                for k in range(m, m + n_months):
                    booked = w.booked.get((nr, k))
                    if booked:
                        con += booked[0]
                        nv += booked[1]
            nv, con = round(nv, 2), round(con, 2)
            cash = round(w.cash[nr] - (w.months - m) * 9000.0, 2)
            assets = round(self.wave(seed + 4, m, 2.0e7, 1.0e6) * scale, 2)
            return [tr, int(tr * 0.55), rev, run, mnt, 0, op, nv, con, round(op + nv + con, 2), cash, assets,
                    round(100.0 * op / rev, 2) if rev else 0, round(cash + assets, 2)]
        progress = (w.ticks % w.ticks_per_month) / w.ticks_per_month
        reply = {"player": nr, "name": PLAYER_NAMES[nr], "tt": tt, "date": date_obj(w.months),
                 "columns": columns, "maintenance_per_month": round(-220000.0 * scale, 2), "overdrawn_months": 0,
                 "tt_list": tt_list}
        if period in ("both", "month"):
            reply["month"] = [row(nr * 100, w.months - i, 1, progress if i == 0 else None)
                              for i in range(min(25, w.months - first + 1))]
        if period in ("both", "year"):
            year = w.months // 12
            reply["year"] = [row(nr * 100 + 50, (year - i) * 12, 12,
                                 ((w.months % 12) + progress) / 12 if i == 0 else None)
                             for i in range(min(25, year - first // 12 + 1))]
        return reply

    def cmd_line(self, a):
        w = self.w
        line = self.find(w.lines, a, "line")
        conv = [c for c in w.convoys if c["line"] == line["id"]]
        reply = {"line": {"id": line["id"], "name": line["name"], "owner": line["owner"], "type": line["type"],
                          "convoys": len(conv), "withdraw": bool(line.get("withdraw")),
                          "this_month": self.line_month(line, 0),
                          "last_month": self.line_month(line, 1)},
                 "goods": ["Passengers", "Mail"], "convoys": [c["id"] for c in conv], "capacity": 60 * len(conv),
                 "load": sum(c["load"] * 60 // 100 for c in conv),
                 "schedule": [self.stop_entry(st, True) for st in line["stops"]]}
        if "loads" in line:  # lines of agent commands: the minimum loads of their schedule entries
            for e, load in zip(reply["schedule"], line["loads"]):
                e["wait_for_load"] = 0 if e["halt"] is None else load
        if a.get("history") == "1":
            reply["history"] = {"columns": ["free_capacity", "transported", "revenue", "operation", "toll", "profit",
                                            "convoys", "distance", "max_speed"], "rows": self.line_history(line)}
        return reply

    def cmd_convoy(self, a):
        w = self.w
        c = self.find(w.convoys, a, "convoy")
        item = next(it for it in self.cmd_convoys({"limit": "0"})["convoys"] if it["id"] == c["id"])
        leg = self.convoy_leg(c)
        line = next((ln for ln in w.lines if ln["id"] == c["line"]), None)
        item.update(power_kw=150, weight_t=20, empty_weight_t=15, running_cost_per_km=1.2, value=12000.5,
                    odometer_km=10000 + c["id"] * 13, speedbonus_kmh=50, loading_limit=0, length_tiles=1,
                    withdraw=False, no_load=False, home_depot={"x": 3, "y": 4, "z": 0},
                    route={"index": 1, "length": self.leg_reply(c, *leg)["length"]} if leg else {"index": 0, "length": 0})
        if leg:
            item["next_stop"] = dict(leg[0]["stops"][leg[2]]["pos"])
        vehicles = [{"name": "Fake bus", "built": {"year": 1940, "month": 3}, "age_months": w.months - 1940 * 12 - 2,
                     "value": 10000.25, "capacity": 40, "load": c["load"] * 40 // 100, "goods": "Passengers", "unit": "",
                     "speed_kmh": 80, "power_kw": 150, "weight_t": 15, "running_cost_per_km": 1.0,
                     "fixed_cost_per_month": 10.0, "retired": False},
                    {"name": "Mail trailer", "built": {"year": 1941, "month": 7}, "age_months": w.months - 1941 * 12 - 6,
                     "value": 2000.25, "capacity": 20, "load": 5, "goods": "Mail", "unit": "bags",
                     "speed_kmh": 80, "power_kw": 0, "weight_t": 5, "running_cost_per_km": 0.2,
                     "fixed_cost_per_month": 0, "retired": True}]
        if "vehicles" in c:
            # a convoy of agent commands: its real vehicles, home depot, withdraw flag and resale value
            vehicles = [{"name": n, "built": {"year": w.months // 12, "month": 1}, "age_months": 0,
                         "value": VEHICLE_PRICES[n][0] * SELL_FACTOR, "capacity": VEHICLE_DESCS[n]["capacity"],
                         "load": 0, "goods": "Passengers", "unit": "", "speed_kmh": VEHICLE_DESCS[n]["speed"],
                         "power_kw": VEHICLE_DESCS[n]["power"], "weight_t": 10,
                         "running_cost_per_km": VEHICLE_PRICES[n][1], "fixed_cost_per_month": VEHICLE_PRICES[n][2],
                         "retired": False} for n in c["vehicles"]]
            home = c.get("home")
            item.update(withdraw=bool(c.get("withdraw")), value=sum(v["value"] for v in vehicles),
                        home_depot={"x": home[0], "y": home[1], "z": home[2]} if home else None)
            if not c["line"]:
                item.pop("line", None)  # like the game: no line, no key
        stops = line["stops"] if line else []
        reply = {"convoy": item, "vehicles": vehicles,
                 "schedule": {"current": leg[2] if leg else 0, "entries": [self.stop_entry(st, False) for st in stops]},
                 "freight": []}
        halts = [st for st in stops if not st.get("waypoint")]
        if halts:
            dest = halts[c["id"] % len(halts)]
            via = halts[(c["id"] + 1) % len(halts)]
            reply["freight"] = [{"goods": "Passengers", "amount": c["load"] * 40 // 100, "unit": "",
                                 "destination": dest["name"], "destination_id": dest["id"], "via": via["name"],
                                 "via_id": via["id"], "factory": None},
                                {"goods": "Mail", "amount": 5, "unit": "bags", "destination": dest["name"],
                                 "destination_id": dest["id"], "via": None, "via_id": None, "factory": None}]
        if a.get("history") == "1":
            rows = []
            for ago in range(12):
                m = w.months - ago
                tr = int(self.wave(c["id"], m, 40, 15))
                rev, op = round(tr * 2.5, 2), round(-self.wave(c["id"] + 7, m, 60, 10), 2)
                rows.append([int(self.wave(c["id"] + 1, m, 80, 30)), tr, rev, op, round(rev + op, 2),
                             int(self.wave(c["id"] + 2, m, 120, 40)), 80, 0])
            reply["history"] = {"columns": ["free_capacity", "transported", "revenue", "operation", "profit", "distance",
                                            "max_speed", "toll"], "rows": rows}
        return reply

    def cmd_line_route(self, a):
        w = self.w
        if "convoy" in a:
            c = self.find(w.convoys, a, "convoy", key="convoy")
            leg = self.convoy_leg(c)
            if not leg:
                return {"convoy": c["id"], "state": STATES[c["state"]], "points": [],
                        "reason": "the convoy has no route now"}
            return self.leg_reply(c, *leg)
        line = self.find(w.lines, a, "line")
        conv = [c for c in w.convoys if c["line"] == line["id"]]
        if a.get("all") != "1":
            for c in conv:
                leg = self.convoy_leg(c)
                if leg:
                    return dict(self.leg_reply(c, *leg), line=line["id"])
            return {"line": line["id"], "convoy": None, "points": [], "reason": "no convoy of the line has a route now"}
        legs, seen = [], set()
        for c in conv:
            leg = self.convoy_leg(c)
            if not leg or (leg[1], leg[2]) in seen:
                continue
            seen.add((leg[1], leg[2]))
            legs.append(self.leg_reply(c, *leg))
            if len(legs) >= 2:  # the fake drives only two convoys of a line at a time
                break
        return {"line": line["id"], "legs": legs, "stops": len(line["stops"]), "covered": len(seen)}

    def cmd_station(self, a):
        w = self.w
        if "id" in a:
            st = self.find(w.stations, a, "station")
        else:
            x, y = int(a.get("x", "-1") or -1), int(a.get("y", "-1") or -1)
            st = next((s for s in w.stations if s["pos"]["x"] == x and s["pos"]["y"] == y), None)
            if st is None:
                raise ValueError("no station at this position")
        m = w.months
        waiting = (st["id"] * 7 + m) % 50

        def month(ago):
            return {"happy": 50 + (st["id"] + m - ago) % 30, "unhappy": (m - ago) % 4,
                    "no_route": 100 + st["id"] % 50, "arrived": 40, "departed": 35, "convoys_arrived": 8}
        reply = {"station": {"id": st["id"], "name": st["name"], "owner": st["owner"], "pos": dict(st["pos"]),
                             "tiles": 1, "accepts": {"passengers": True, "mail": True, "goods": False},
                             "waiting": {"total": waiting, "passengers": waiting, "mail": 0}},
                 "this_month": month(0), "last_month": month(1), "tiles": [{"pos": dict(st["pos"])}],
                 "capacity": {"passengers": 256, "mail": 256, "goods": 256, "separate": False}}
        if self.opts.old:
            del reply["capacity"]  # an engine before the detail commands knows only the station window
            return reply
        if a.get("history") == "1":
            reply["history"] = {"columns": ["happy", "unhappy", "no_route", "waiting", "arrived", "departed", "convoys",
                                            "walked"],
                                "rows": [[month(i)["happy"], month(i)["unhappy"], month(i)["no_route"], waiting, 40, 35,
                                          8, 5] for i in range(12)]}
        lines = [ln for ln in w.lines if any(s is st for s in ln["stops"])]
        want = set((a.get("waiting") or "").split(","))
        if "goods" in want:
            reply["waiting_by_goods"] = ([{"goods": "Passengers", "amount": waiting, "unit": "", "class": "passengers"}]
                                         if waiting else [])
        if "next" in want:
            nxt = []
            for ln in lines:
                halts = [s for s in ln["stops"] if not s.get("waypoint")]
                nb = halts[(halts.index(st) + 1) % len(halts)]
                if nb is not st and not any(x["halt"] == nb["id"] for x in nxt):
                    nxt.append({"halt": nb["id"], "name": nb["name"], "goods": "Passengers", "amount": waiting // 2})
            reply["waiting_by_next"] = nxt
            reply["waiting_other"] = max(0, waiting - sum(x["amount"] for x in nxt))
        if a.get("lines") == "1":
            reply["lines"] = [{"id": ln["id"], "name": ln["name"], "owner": ln["owner"], "type": ln["type"]}
                              for ln in lines]
            reply["lineless_convoys"] = []
        if "departures" in a:
            n = max(1, min(100, int(a["departures"] or 1)))
            deps, arrs = [], []
            tpm = w.ticks_per_month
            for ln in lines:
                halts = [s for s in ln["stops"] if not s.get("waypoint")]
                i = halts.index(st)
                nb, pb = halts[(i + 1) % len(halts)], halts[i - 1]
                for k, c in enumerate(c for c in w.convoys if c["line"] == ln["id"]):
                    ticks = (k * 37 + c["id"]) * 1000 % tpm
                    deps.append({"convoy": c["id"], "line": ln["id"], "halt": nb["id"], "name": nb["name"],
                                 "ticks": ticks, "time": "now" if ticks < 2000 else "%d:00h" % (ticks * 24 // tpm)})
                    arrs.append({"convoy": c["id"], "line": ln["id"], "halt": pb["id"], "name": pb["name"],
                                 "ticks": ticks + 500, "time": "%d:30h" % (ticks * 24 // tpm)})
            reply["departures"] = sorted(deps, key=lambda d: d["ticks"])[:n]
            reply["arrivals"] = sorted(arrs, key=lambda d: d["ticks"])[:n]
            reply["ticks_per_month"] = tpm
        return reply

    def cmd_fake_legs(self, a):
        w = self.w
        w.leg_shift = int(a["shift"]) if a.get("shift") else w.leg_shift + 1
        return {"shift": self.leg_shift()}

    def cmd_fake_schedule(self, a):
        w = self.w
        w.schedule_counter = (w.schedule_counter + 1) & 255
        return {"schedules": w.schedule_counter}

    # -- map export (absent with --old and --no-map)

    def cmd_palette(self, a):
        return {"source": "builtin", "colors": fake_palette(),
                "players": [{"nr": i, "name": PLAYER_NAMES[i], "color1": i * 8, "color2": 24 + i * 8,
                             "minimap_color": i * 8 + 3} for i in range(len(PLAYER_NAMES))],
                "height_colors": HEIGHT_COLORS, "severity_colors": SEVERITY_COLORS,
                "maximumheight": 32, "minimumheight": -10, "groundwater": 0, "rotation": 0}

    def cmd_minimap(self, a):
        w = self.w
        if getattr(self, "fail_minimap", 0) > 0:
            self.fail_minimap -= 1
            raise ValueError("fake failure")
        step = int(a.get("step", "1") or 1)
        if step not in (1, 2, 4, 8, 16):
            raise ValueError("step must be 1, 2, 4, 8 or 16")
        x, y = int(a.get("x", "0") or 0), int(a.get("y", "0") or 0)
        ww, hh = int(a.get("w", str(SIZE)) or SIZE), int(a.get("h", str(SIZE_Y)) or SIZE_Y)
        if x < 0:
            ww, x = ww + x, 0
        if y < 0:
            hh, y = hh + y, 0
        ww, hh = min(ww, SIZE - x), min(hh, SIZE_Y - y)
        if ww <= 0 or hh <= 0:
            raise ValueError("region is outside of the map")
        sw, sh = (ww + step - 1) // step, (hh + step - 1) // step
        if sw * sh > 1048576:
            raise ValueError("too many samples (at most 1048576 per request): use a larger step or a smaller region")
        mode = a.get("mode", "terrain")
        if mode == "passenger":
            mode = "passengers"
        if mode not in MAP_MODES:
            raise ValueError("unknown mode (terrain owner traffic freight passengers mail tracks speed power forest level climates)")
        out = bytearray()
        for sy in range(sh):
            for sx in range(sw):
                out.append(w.map_color(x + sx * step, y + sy * step, mode))
        reply = {"region": {"x": x, "y": y, "w": ww, "h": hh}, "step": step, "mode": mode, "encoding": "zlib+base64",
                 "width": sw, "height": sh, "gen": w.map_gen,
                 "data": base64.b64encode(zlib.compress(bytes(out), 6)).decode("ascii")}
        if mode in ("traffic", "freight", "level"):
            reply["max"] = 100
        return reply

    def cmd_map_changes(self, a):
        w = self.w
        since = int(a.get("since", "0") or 0)
        chunk = int(a.get("chunk", "256") or 256)
        if chunk < MAP_CELL or chunk > 4096 or chunk & (chunk - 1):
            raise ValueError("chunk must be a power of 2 from 64 to 4096")
        full = since < w.track_start or since > w.map_gen
        chunks = []
        if not full:
            per = chunk // MAP_CELL
            for cy in range((w.cells[1] + per - 1) // per):
                for cx in range((w.cells[0] + per - 1) // per):
                    if any(w.cell_gen[yy * w.cells[0] + xx] > since
                           for yy in range(cy * per, min((cy + 1) * per, w.cells[1]))
                           for xx in range(cx * per, min((cx + 1) * per, w.cells[0]))):
                        chunks.append([cx, cy])
        return {"gen": w.map_gen, "full": full, "chunk": chunk, "chunks": chunks, "rotation": 0,
                "world_gen": w.gen, "size_x": SIZE, "size_y": SIZE_Y}

    def cmd_labels(self, a):
        return {"labels": self.w.labels}

    def cmd_fake_fail(self, a):
        self.fail_minimap = int(a.get("n", "1") or 1)
        return {"n": self.fail_minimap}

    def cmd_fake_build(self, a):
        w = self.w
        w.build(int(a["x"]), int(a["y"]), int(a.get("w", "1") or 1), int(a.get("h", "1") or 1))
        return {"gen": w.map_gen}

    # -- 3D export (absent with --old, --no-map and --no-3d)

    def grid_height(self, gx, gy):
        """height of a grid point (the north-west corner of square gx, gy): 16 x 16 blocks of heights 1-4"""
        return 1 + (gx // 16 + gy // 16) % 4

    def is_water(self, x, y):
        return self.w.terrain[min(y, SIZE_Y - 1) * SIZE + min(x, SIZE - 1)] == HEIGHT_COLORS[2]

    def is_road(self, x, y):
        return 0 <= x < SIZE and 0 <= y < SIZE_Y and self.w.terrain[y * SIZE + x] == COL_ROAD

    def specials(self):
        """squares of the stop, factory and town hall buildings: (x, y) -> (desc name, ox, oy, owner)"""
        w = self.w
        if getattr(self, "_spec_gen", None) != w.gen:
            sp = {}
            for f in FACTORIES:
                for oy in (0, 1):
                    for ox in (0, 1):
                        sp[(f[2] + ox, f[3] + oy)] = ("FakeWorks", ox, oy, -1)
            for c in CITIES:
                for oy in (0, 1):
                    for ox in (0, 1):
                        sp[(c[1] + ox, c[2] + oy)] = ("FakeTownhall", ox, oy, 1)
            for st in w.stations:
                sp[(st["pos"]["x"], st["pos"]["y"])] = ("FakeStop", 0, 0, st["owner"])
            for k, sq in enumerate(DOCK):
                sp[sq] = ("Harbour", k, 0, 0)
            for oy in (0, 1):
                for ox in (0, 1):
                    sp[(OFFICE_CORNER[0] + ox, OFFICE_CORNER[1] + oy)] = ("FakeOffice", ox, oy, -1)
            self._spec, self._spec_gen = sp, w.gen
        return self._spec

    def season_snowline(self):
        """season and snowline of the game at the fake's time (month and the share of it gone)"""
        w = self.w
        m0 = w.months % 12
        frac = (w.ticks % w.ticks_per_month) / w.ticks_per_month
        factor = SNOW_FACTOR[m0] + int((SNOW_FACTOR[(m0 + 1) % 12] - SNOW_FACTOR[m0]) * frac)
        return MONTH_SEASON[m0], SUMMER_LINE - (SUMMER_LINE - WINTER_LINE) * factor // 100

    def int_arg(self, a, key, default=None):
        if key not in a:
            if default is None:
                raise ValueError("missing %s" % key)
            return default
        try:
            return int(a[key])
        except ValueError:
            raise ValueError("%s must be a number" % key) from None

    def region(self, a):
        """x1 y1 x2 y2 (inclusive, default the whole map) clipped to the map"""
        x1, y1 = self.int_arg(a, "x1", 0), self.int_arg(a, "y1", 0)
        x2, y2 = self.int_arg(a, "x2", SIZE - 1), self.int_arg(a, "y2", SIZE_Y - 1)
        x1, y1, x2, y2 = max(x1, 0), max(y1, 0), min(x2, SIZE - 1), min(y2, SIZE_Y - 1)
        if x1 > x2 or y1 > y2:
            raise ValueError("region is outside of the map")
        return x1, y1, x2, y2

    def level(self, a, default):
        lv = self.int_arg(a, "level", default)
        if not 1 <= lv <= 9:
            raise ValueError("level must be 1-9")
        return lv

    def cmd_desc_list(self, a):
        lists, gen = fake_descs()
        kinds = DESC_KINDS
        if "kinds" in a:
            kinds = [k.strip() for k in a["kinds"].split(",")]
            for k in kinds:
                if k not in DESC_KINDS:
                    raise ValueError("unknown kind: %s" % k)
        reply = {"pakset": "fake/", "gen": gen}
        for k in DESC_KINDS:
            if k in kinds:
                reply[k] = lists[k]
        reply["t_us"] = 90
        return reply

    def cmd_scene3d(self, a):
        w = self.w
        if "cx" not in a or "cy" not in a:
            raise ValueError("missing chunk coordinates cx,cy")
        size = self.int_arg(a, "size", 64)
        if size not in (16, 32, 64):
            raise ValueError("size must be 16, 32 or 64")
        cx, cy = self.int_arg(a, "cx"), self.int_arg(a, "cy")
        x0, y0 = cx * size, cy * size
        if cx < 0 or cy < 0 or x0 >= SIZE or y0 >= SIZE_Y:
            raise ValueError("chunk is outside of the map")
        objs_mode = a.get("objs", "bin")
        if objs_mode not in ("bin", "json"):
            raise ValueError("objs must be bin or json")
        level = self.level(a, 4)
        cw, ch = min(size, SIZE - x0), min(size, SIZE_Y - y0)
        corners, ground, objs = bytearray(), bytearray(), []
        spec = self.specials()
        bidx = {d["name"]: d["i"] for d in fake_descs()[0]["buildings"]}
        for ly in range(ch):
            for lx in range(cw):
                x, y = x0 + lx, y0 + ly
                if self.is_water(x, y):
                    cs = (0, 0, 0, 0)
                    ground.append(CLIMATE << 4 | 1)
                else:
                    gh = self.grid_height
                    cs = (gh(x, y + 1), gh(x + 1, y + 1), gh(x + 1, y), gh(x, y))  # sw se ne nw
                z = min(cs)
                cs = tuple(min(c, z + 2) for c in cs)
                corners.extend(c & 0xFF for c in cs)
                sp = spec.get((x, y))
                if self.is_water(x, y):
                    if sp and sp[0] == "Harbour":
                        objs.append((lx, ly, z, 1, bidx["Harbour"], 0, sp[1] + 256 * sp[2], sp[3]))
                    continue
                slope = (cs[0] - z) + 3 * (cs[1] - z) + 9 * (cs[2] - z) + 27 * (cs[3] - z)
                if self.is_road(x, y):
                    ribi = (1 if self.is_road(x, y - 1) else 0) | (2 if self.is_road(x + 1, y) else 0) | \
                           (4 if self.is_road(x, y + 1) else 0) | (8 if self.is_road(x - 1, y) else 0)
                    objs.append((lx, ly, z, 0, 0, ribi, slope << 8, w.owned[y * SIZE + x] - 1))
                    if sp and sp[0] == "FakeStop":  # a stop on the road
                        objs.append((lx, ly, z, 1, bidx["FakeStop"], 0, 0, sp[3]))
                    ground.append(CLIMATE << 4)
                elif sp:
                    objs.append((lx, ly, z, 1, bidx[sp[0]], 0, sp[1] + 256 * sp[2], sp[3]))
                    ground.append(CLIMATE << 4 | 2)
                elif x % 32 == 8 and y % 32 == 8:
                    objs.append((lx, ly, z, 1, 0, 0, 0, -1))  # FakeHouse
                    ground.append(CLIMATE << 4 | 2)
                elif 16 <= x % 32 <= 17 and 16 <= y % 32 <= 17:
                    objs.append((lx, ly, z, 1, 1, 0, x % 32 - 16 + 256 * (y % 32 - 16), -1))  # FakeOffice 2 x 2
                    ground.append(CLIMATE << 4 | 2)
                else:
                    if (x * 7 + y * 13) % 11 == 0:
                        objs.append((lx, ly, z, 2, (x + y) % 3, (x * 3 + y) % 5, 0, -1))
                    ground.append(CLIMATE << 4)
        season, snowline = self.season_snowline()
        reply = {"cx": cx, "cy": cy, "size": size, "x0": x0, "y0": y0, "w": cw, "h": ch, "rev": w.map_gen,
                 "desc_gen": fake_descs()[1], "water": 0, "season": season, "snowline": snowline, "rotation": 0,
                 "encoding": "zlib+base64", "corners": b64z(corners, level), "ground": b64z(ground, level),
                 "count": len(objs)}
        if objs_mode == "json":
            reply["objs"] = [list(r) for r in objs]
        else:
            reply["objs_layout"] = SCENE_LAYOUT
            reply["objs"] = b64z(pack_columns(objs, SCENE_LAYOUT), level)
        reply["t_us"] = 700
        return reply

    def cmd_heights(self, a):
        step = self.int_arg(a, "step", 1)
        if step not in (1, 2, 4, 8, 16):
            raise ValueError("step must be 1, 2, 4, 8 or 16")
        x1, y1, x2, y2 = self.region(a)
        level = self.level(a, 1)
        cols = [x1 + i * step for i in range(-(-(x2 - x1 + 1) // step))] + [x2 + 1]
        rows = [y1 + j * step for j in range(-(-(y2 - y1 + 1) // step))] + [y2 + 1]
        if len(cols) * len(rows) > 66049:
            raise ValueError("too many samples (at most 66049 per request): use a larger step or a smaller region")
        hs = [-2 if self.is_water(gx, gy) else self.grid_height(gx, gy) for gy in rows for gx in cols]
        return {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "step": step, "w": len(cols), "h": len(rows),
                "rev": self.w.map_gen, "water": 0, "min": min(hs), "max": max(hs), "encoding": "zlib+base64",
                "heights": b64z((h & 0xFF for h in hs), level), "water_heights": b64z(bytes(len(hs)), level),
                "t_us": 300}

    def cmd_vehicles3d(self, a):
        w = self.w
        x1, y1, x2, y2 = self.region(a)
        extras = a.get("extras") == "1"
        if extras and (x2 - x1 + 1) * (y2 - y1 + 1) > 65536:
            raise ValueError("extras=1: region too large (at most 65536 squares)")
        objs_mode = a.get("objs", "bin")
        if objs_mode not in ("bin", "json"):
            raise ValueError("objs must be bin or json")
        level = self.level(a, 1)
        rows = []
        descs = (VEH_INDEX["Fake bus"], VEH_INDEX["Mail trailer"])
        for c in w.convoys:
            if "script" in c:
                for r in script_rows(c["script"], w.ticks, c["id"], c["owner"], self.grid_height, VEH_INDEX):
                    if x1 <= r[2] <= x2 and y1 <= r[3] <= y2:
                        rows.append(r)
                continue
            if not (x1 <= c["x"] <= x2 and y1 <= c["y"] <= y2):
                continue
            for idx in (0, 1):
                flags = (1 if idx == 0 else 2) | (16 if c["state"] == 7 else 0)
                rows.append((c["id"] & 0xFFFF, descs[idx], c["x"], c["y"], 0, 0, 0, 640 if c["state"] == 6 else 0, flags,
                             idx, 0, self.grid_height(c["x"], c["y"]), 2 if c["dx"] > 0 else 8, (w.ticks // 8) % 256,
                             255, c["dx"], 0, 0, c["owner"]))
        convoy_rows = len(rows)
        if extras:
            # city cars drive east along the roads of the rows, pedestrians walk south along the roads of the columns
            shift = w.gen * 8
            for y in range(y1, y2 + 1):
                if (y + shift) % 32 == 0:
                    for k in range(SIZE // 12):
                        x = (k * 12 + 5 + w.ticks * 1.2 / 1000) % SIZE
                        tx = int(x)
                        if x1 <= tx <= x2 and self.is_road(tx, y):
                            rows.append((0, k % 2, tx, y, int((x - tx - 0.5) * 256), 0, 0, yards(1.2), 3, 0, 1,
                                         self.grid_height(tx, y), 2, int((x - tx) * 255), 255, 1, 0, 0, -1))
            for x in range(x1, x2 + 1):
                if (x + shift) % 32 == 0:
                    for k in range(SIZE_Y // 16):
                        y = (k * 16 + 3 + w.ticks * 0.15 / 1000) % SIZE_Y
                        ty = int(y)
                        if y1 <= ty <= y2 and self.is_road(x, ty):
                            rows.append((0, 0, x, ty, 0, int((y - ty - 0.5) * 256), 0, 128, 3, 0, 2,
                                         self.grid_height(x, ty), 4, int((y - ty) * 255), 255, 0, 1, 0, -1))
        reply = {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "ticks": w.ticks, "paused": w.paused, "ff": w.ff,
                 "mult": w.mult, "drive_left": False, "diag_steps": 181, "desc_gen": fake_descs()[1],
                 "count": len(rows), "convoy_rows": convoy_rows}
        if objs_mode == "json":
            reply["objs"] = [list(r) for r in rows]
        else:
            reply.update(encoding="zlib+base64", objs_layout=VEH_LAYOUT, objs=b64z(pack_columns(rows, VEH_LAYOUT), level))
        reply["t_us"] = 400
        return reply

    def cmd_fake_time(self, a):
        w = self.w  # execute() holds w.lock
        month = self.int_arg(a, "month", w.months % 12 + 1)
        day, hour = float(a.get("day", "1") or 1), float(a.get("hour", "12") or 12)
        if not 1 <= month <= 12 or not 1 <= day <= 31 or not 0 <= hour <= 24:
            raise ValueError("month 1-12, day 1-31, hour 0-24")
        old = w.months
        target = (w.months // 12) * 12 + month - 1
        if target < w.start_months:
            target += 12
        days = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
        frac = min(0.9999, (min(day, days) - 1 + hour / 24.0) / days)
        w.ticks = (target - w.start_months) * w.ticks_per_month + int(frac * w.ticks_per_month)
        if w.months != old:
            w.add_event("month", {"date": date_obj(w.months), "year_changed": w.months // 12 != old // 12})
        season, snowline = self.season_snowline()
        return {"ticks": w.ticks, "date": date_obj(w.months), "season": season, "snowline": snowline}

    def cmd_fake_stats(self, a):
        calls = dict(self.calls)
        if a.get("reset") == "1":
            self.calls.clear()
        return {"calls": {k: calls.get(k, 0) for k in VIEW3D_COMMANDS}}

    def cmd_tile(self, a):
        if "x" not in a or "y" not in a:
            raise ValueError("missing tile coordinates x,y")
        x, y = int(a["x"]), int(a["y"])
        if not (0 <= x < SIZE and 0 <= y < SIZE_Y):
            raise ValueError("tile coordinates outside of the map")
        g = {"pos": {"x": x, "y": y, "z": 0}, "type": "Boden", "surface": True, "objects": []}
        st = next((s for s in self.w.stations if s["pos"]["x"] == x and s["pos"]["y"] == y), None)
        if st:
            g["halt"] = st["name"]
            g["objects"].append({"type": "building", "name": "FakeStop", "owner": st["owner"]})
        # ways (the synthetic roads and those of agent commands), what agents built on them, depots: the object
        # types of the game's tile read; ways, signs and way objects with desc, waytype and dirs like the game's
        for waytype, owner, name in self.ways_at(x, y):
            g["objects"].append({"type": "way", "name": name, "owner": owner, "desc": name, "waytype": waytype,
                                 "dirs": dirs_text(self.way_ribi(x, y, waytype))})
        kinds = {"bridge": "bridge", "tunnel": "tunnel", "wayobj": "wayobj"}
        for o in self.w.objects.get((x, y), ()):
            if o["kind"] in kinds:
                item = {"type": kinds[o["kind"]], "name": o["name"], "owner": o["owner"]}
                if o["kind"] == "wayobj":
                    wt = WAYOBJ_PRICES[o["name"]][0]
                    item.update(desc=o["name"], waytype=wt, dirs=dirs_text(self.way_ribi(x, y, wt)))
                g["objects"].append(item)
            elif o["kind"] == "sign":
                signal = bool(SIGN_FLAGS.get(o["name"], 0) & SIGNAL_TYPE)
                g["objects"].append({"type": "signal" if signal else "roadsign", "name": "Signal" if signal
                                     else "Roadsign", "owner": o["owner"], "desc": o["name"],
                                     "waytype": SIGN_PRICES[o["name"]][0], "dirs": dirs_text(o.get("dir", 0))})
        for d in self.w.depots:
            if (d["pos"][0], d["pos"][1]) == (x, y):
                g["objects"].append({"type": "road_depot" if d["waytype"] == "road" else "rail_depot",
                                     "name": d["name"], "owner": d["owner"]})
        if self.opts.no_tile_dirs:
            for o in g["objects"]:
                for k in ("desc", "waytype", "dirs"):
                    o.pop(k, None)
        return {"grounds": [g]}

    def cmd_pause(self, a):
        w = self.w
        w.paused = (a["on"] not in ("0", "false", "no", "off")) if a.get("on") else not w.paused
        return {"paused": w.paused}

    def cmd_fast_forward(self, a):
        w = self.w
        w.ff = (a["on"] not in ("0", "false", "no", "off")) if a.get("on") else not w.ff
        return {"fast_forward": w.ff}

    def cmd_view(self, a):
        if "x" not in a or "y" not in a:
            raise ValueError("missing tile coordinates x,y")
        self.w.view = {"x": int(a["x"]), "y": int(a["y"]), "z": int(a.get("z", 0) or 0)}
        return {"center": dict(self.w.view)}

    def cmd_zoom(self, a):
        self.w.zoom += -1 if a.get("dir", "in") == "in" else 1
        return {"zoom_index": self.w.zoom, "tile_raster_width": 64}

    def cmd_tool(self, a):
        if self.opts.old:
            raise ValueError("unknown command")
        if "tool" not in a:
            raise ValueError("missing tool")
        return {"result": None}

    def cmd_cash(self, a):
        amount = float(a.get("amount", "0"))
        nr = int(a.get("player", "0") or 0)
        before = self.w.cash[nr]
        self.w.cash[nr] += amount
        return {"player": nr, "amount": amount, "cash_before": before, "cash": self.w.cash[nr], "steps": 1}

    def cmd_fake_reload(self, a):
        w = self.w
        w.add_event("world", {"event": "closed", "gen": w.gen, "size_x": SIZE, "size_y": SIZE_Y})
        w.gen += 1
        w.mute = True
        w.new_world()
        w.mute = False
        w.add_event("world", {"event": "loaded", "gen": w.gen, "size_x": SIZE, "size_y": SIZE_Y})
        return {"gen": w.gen}

    def cmd_fake_remove_convoy(self, a):
        w = self.w
        cid = int(a["id"]) if a.get("id") else w.convoys[-1]["id"]
        w.convoys = [c for c in w.convoys if c["id"] != cid]
        return {"removed": cid}

    def cmd_fake_set_state(self, a):
        w = self.w
        cid, state = int(a["id"]), int(a["state"])
        for c in w.convoys:
            if c["id"] == cid:
                c["state"] = state
                return {"id": cid, "state": state}
        raise ValueError("no such convoy")

    def cmd_fake_message(self, a):
        w = self.w
        w._add_message(a.get("text", "test message"), int(a.get("type", "0") or 0))
        return {"seq": len(w.messages)}

    def cmd_fake_burst(self, a):
        w = self.w
        for i in range(int(a.get("n", "10") or 10)):
            w._add_message("Burst message %d" % i, 0)
        return {"seq": len(w.messages)}

    def cmd_fake_event(self, a):
        """an event of any topic with any JSON data (tests of a subscriber with unexpected events)"""
        self.w.add_event(a.get("topic", "arrivals"), json.loads(a.get("data", "{}")))
        return {"seq": self.w.event_seq}

    def cmd_fake_overflow(self, a):
        drop = int(a.get("drop", "5") or 5)
        with self.conns_lock:
            subs = [c.sub for c in self.conns if c.sub is not None]
        for s in subs:
            s.drop = drop
        return {"subscribers": len(subs)}

    # -- engine agent mode (contract E), simulated: checks like the engine, effects on the fake world

    def agent_player(self, a):
        """player=N of an agent command, checked like the engine (public player, unknown players, locked companies
        on a network client)"""
        if "player" not in a or a["player"] == "":
            raise ValueError("player=N is required")
        try:
            nr = int(a["player"])
        except ValueError:
            raise ValueError("player=N is required") from None
        if nr == 1:
            raise ValueError("agents cannot act as the public player")
        if not 0 <= nr < min(len(PLAYER_NAMES), PLAYER_UNOWNED):
            raise ValueError("no such player")
        if self.opts.net_client and nr in self.opts.locked:
            raise ValueError("player %d is protected by a password on this client" % nr)
        return nr

    def pos_arg(self, a, kx="x", ky="y"):
        if kx not in a or ky not in a:
            raise ValueError("missing tile coordinates %s,%s" % (kx, ky))
        try:
            x, y = int(a[kx]), int(a[ky])
        except ValueError:
            raise ValueError("%s,%s must be numbers" % (kx, ky)) from None
        if not (0 <= x < SIZE and 0 <= y < SIZE_Y):
            raise ValueError("position %d,%d is outside of the map" % (x, y))
        return x, y

    def agent_done(self, effect, what):
        """single player: run the change now -> {"result": null, ...extras}; network game (--net): the change
        takes effect NET_DELAY s later -> {"pending": true} (a failure then vanishes, as in the game)"""
        w = self.w
        if self.opts.net:
            self.net_queue.put((time.monotonic() + self.opts.net_delay, effect, what))
            return {"pending": True}
        extras = effect() or {}
        w.agent_log.append({"what": what, "ok": True})
        return dict({"result": None}, **extras)

    def net_worker(self):
        """applies the pending changes of --net in order, each NET_DELAY s after its command"""
        while True:
            due, effect, what = self.net_queue.get()
            time.sleep(max(0.0, due - time.monotonic()))
            with self.w.lock:
                try:
                    effect()
                    self.w.agent_log.append({"what": what, "ok": True})
                except (ValueError, KeyError, IndexError) as e:
                    self.w.agent_log.append({"what": what, "ok": False, "error": str(e)})
                self.pending_done += 1
            self.process_events()

    def pay(self, nr, cost, column="construction"):
        """an agent command spends money: --agent-cost-factor times the price (tests of the executor's overrun
        stop), booked into the finance column of the running month like the game books it"""
        w = self.w
        cost = cost * self.opts.agent_cost_factor
        if cost > w.cash[nr]:
            raise ValueError("Insufficient funds: %.2f needed" % cost)
        w.cash[nr] -= cost
        self.book(nr, -cost, column)

    def earn(self, nr, amount):
        """a sale of vehicles: cash and the new_vehicles column of the running month"""
        self.w.cash[nr] += amount
        self.book(nr, amount, "new_vehicles")

    def book(self, nr, amount, column):
        entry = self.w.booked.setdefault((nr, self.w.months), [0.0, 0.0])
        entry[0 if column == "construction" else 1] += amount

    def ways_at(self, x, y):
        """[(waytype, owner, name)] of the ways on a square: the synthetic roads and those built by agents"""
        w = self.w
        out = [(WAY_PRICES.get(o["name"], ("road",))[0], o["owner"], o["name"])
               for o in w.objects.get((x, y), ()) if o["kind"] == "way"]
        if not out and w.terrain[y * SIZE + x] == COL_ROAD:
            out.append(("road", w.owned[y * SIZE + x] - 1, "fake_road"))
        return out

    def objects_at(self, x, y):
        """[(kind, name, owner)] of everything on a square that a remover would take (owner -1 = nobody)"""
        w = self.w
        out = [(o["kind"], o["name"], o["owner"]) for o in w.objects.get((x, y), ()) if o["kind"] != "way"]
        out += [("way", name, owner) for _, owner, name in self.ways_at(x, y)]
        for st in w.stations:
            if (st["pos"]["x"], st["pos"]["y"]) == (x, y) and not any(k == "station" for k, _, _ in out):
                out.append(("station", st["name"], st["owner"]))
        for d in w.depots:
            if (d["pos"][0], d["pos"][1]) == (x, y) and not any(k == "depot" for k, _, _ in out):
                out.append(("depot", d["name"], d["owner"]))
        for f in FACTORIES:
            if f[2] <= x <= f[2] + 1 and f[3] <= y <= f[3] + 1:
                out.append(("factory", f[0], -1))
        for c in CITIES:
            if c[1] <= x <= c[1] + 1 and c[2] <= y <= c[2] + 1:
                out.append(("townhall", c[0], 1))
        return out

    def route(self, x, y, x2, y2, straight=False):
        """the squares of a way from (x, y) to (x2, y2): first along x, then along y (or a straight line only)"""
        if straight and x != x2 and y != y2:
            return None
        tiles = []
        sx = 1 if x2 >= x else -1
        for xx in range(x, x2 + sx, sx):
            tiles.append((xx, y))
        sy = 1 if y2 >= y else -1
        for yy in range(y + sy, y2 + sy, sy) if y2 != y else ():
            tiles.append((x2, yy))
        return tiles

    def mark(self, x, y, road, owner):
        """a square of the synthetic map becomes (or stops being) a road of an owner: a map change"""
        w = self.w
        w.map_gen += 1
        i = y * SIZE + x
        if road:
            w.terrain[i], w.owned[i] = COL_ROAD, owner + 1
        else:
            w.terrain[i], w.owned[i] = HEIGHT_COLORS[5 + (x // 24 + y // 32) % 30], 0
        w.cell_gen[(y // MAP_CELL) * w.cells[0] + x // MAP_CELL] = w.map_gen

    def add_object(self, x, y, kind, name, owner, **extra):
        self.w.objects.setdefault((x, y), []).append(dict({"kind": kind, "name": name, "owner": owner}, **extra))

    def way_object(self, x, y, waytype):
        """the way of a waytype that agents built on a square, or None"""
        for o in self.w.objects.get((x, y), ()):
            if o["kind"] == "way" and WAY_PRICES.get(o["name"], ("road",))[0] == waytype:
                return o
        return None

    def connect(self, tiles, waytype):
        """the way builder joins the squares of its route one after the other: the direction bits on both sides"""
        for a, b in zip(tiles, tiles[1:]):
            for p, q in ((a, b), (b, a)):
                o = self.way_object(p[0], p[1], waytype)
                if o is not None:
                    o["ribi"] = o.get("ribi", 0) | SIDE_BIT[(q[0] - p[0], q[1] - p[1])]

    def way_ribi(self, x, y, waytype):
        """the directions of the way of a waytype on a square (the game's unmasked ribi): the joins of an agent-built
        way that still lead to a way of that waytype; a synthetic road joins every neighbouring road"""
        o = self.way_object(x, y, waytype)
        ribi = 0
        for dx, dy, bit, _ in NESW:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < SIZE and 0 <= ny < SIZE_Y):
                continue
            if o is not None:
                if o.get("ribi", 0) & bit and any(wt == waytype for wt, _, _ in self.ways_at(nx, ny)):
                    ribi |= bit
            elif waytype == "road" and self.is_road(nx, ny):
                ribi |= bit
        return ribi

    def sign_click(self, nr, x, y, name):
        """the effect of one click of the sign tool at x,y with the rules of the game's tool_build_roadsign_t
        (check_pos_intern, place_sign_intern; simtool.cc): raises ValueError with the game's reason, or returns the
        change (a function)"""
        w = self.w
        waytype, price, _ = SIGN_PRICES[name]
        flags = SIGN_FLAGS.get(name, 0)
        signal, one_way, choose = bool(flags & SIGNAL_TYPE), bool(flags & 1), bool(flags & 2)
        way = next(((o, n) for wt, o, n in self.ways_at(x, y) if wt == waytype), None)
        # a way of the waytype that the company may use (its own, public, nobody's)
        if way is None or way[0] not in (nr, 1, -1):
            raise ValueError(SIGN_REFUSED)
        signs = [o for o in w.objects.get((x, y), ()) if o["kind"] == "sign"]
        if any(bool(SIGN_FLAGS.get(o["name"], 0) & SIGNAL_TYPE) != signal for o in signs):
            raise ValueError(SIGN_REFUSED)  # no signal next to a road sign and the other way round
        ribi = self.way_ribi(x, y, waytype)
        n = ribi_count(ribi)
        if signal and n > 2:
            raise ValueError(SIGN_REFUSED)  # no signals on switches
        if (one_way or signal) and n != 2:
            raise ValueError(SIGN_REFUSED)  # signals and one-way signs need exactly two directions
        old = signs[0] if signs else None
        if old is not None and old["owner"] not in (nr, -1):
            raise ValueError(SIGN_FOREIGN)
        if old is not None and not signal and old["name"] != name:
            raise ValueError(SIGN_REFUSED)  # only signals are replaced

        def build():
            if old is None:
                self.pay(nr, price)
                d = ribi
                if one_way or choose:
                    d = next(bit for _, _, bit, _ in NESW if ribi & bit)
                self.add_object(x, y, "sign", name, nr, dir=d)
            elif signal and old["name"] == name:
                # the same signal turns: two-way -> the last direction, then the other one, then both again
                d, sig, i = ribi, old.get("dir", ribi), 0
                bits = [bit for _, _, bit, _ in NESW]
                if ribi_count(sig) != 2:
                    while i < 4:
                        if (d & bits[i]) == sig:
                            i += 1
                            break
                        i += 1
                while i < 4:
                    if d & bits[i]:
                        d = bits[i]
                    i += 1
                old["dir"] = d
            elif signal:
                self.pay(nr, price + SIGN_PRICES[old["name"]][1])
                old["name"], old["owner"] = name, nr
            elif one_way or choose:
                old["dir"] = ~old.get("dir", 0) & ribi
            return {}
        return build

    def cmd_agent_tool(self, a):
        w = self.w
        nr = self.agent_player(a)
        given = a.get("tool", "")
        name = given.strip().lower()
        for script, (engine, number) in AGENT_TOOLS.items():
            # engine name or id with the general tool flag (0x1000), as the game's parse_work_tool takes them
            if name in (engine.lower(), str(number | 0x1000), hex(number | 0x1000)):
                name = script
        if name not in AGENT_TOOLS:
            raise ValueError("tool '%s' is not allowed for agents" % given)
        if name in self.opts.forbid_tool:
            raise ValueError("scenario: %s is not allowed in this scenario" % name)
        x, y = self.pos_arg(a)
        two = "x2" in a or "y2" in a
        x2, y2 = self.pos_arg(a, "x2", "y2") if two else (x, y)
        param = a.get("param", "")
        if name in REMOVAL_TOOLS:
            if name == "tool_remover":
                tiles = [(x, y)]
            else:
                tiles = self.route(x, y, x2, y2)
            doomed = []
            for tx, ty in tiles:
                objs = self.objects_at(tx, ty)
                if name == "tool_remove_wayobj":
                    objs = [o for o in objs if o[0] == "wayobj"]
                elif name == "tool_remove_way":
                    # the way goes, and everything that stands on it
                    if not any(o[0] == "way" for o in objs):
                        continue
                for kind, oname, owner in objs:
                    if owner != nr:
                        who = "nobody" if owner < 0 else "player %d%s" % (owner, " (public)" if owner == 1 else "")
                        raise ValueError("cannot remove %s %s at %d,%d: it belongs to %s" % (kind, oname, tx, ty, who))
                    doomed.append((tx, ty, kind))
            if not doomed:
                raise ValueError("nothing to remove at %d,%d" % (x, y))

            def remove():
                for tx, ty, kind in doomed:
                    if kind == "way":
                        self.mark(tx, ty, False, -1)
                    if kind == "station":
                        w.stations = [s for s in w.stations if (s["pos"]["x"], s["pos"]["y"]) != (tx, ty)]
                    if kind == "depot":
                        w.depots = [d for d in w.depots if (d["pos"][0], d["pos"][1]) != (tx, ty)]
                    left = [o for o in w.objects.get((tx, ty), ()) if o["kind"] != kind]
                    if left:
                        w.objects[(tx, ty)] = left
                    else:
                        w.objects.pop((tx, ty), None)
                self.pay(nr, 10.0 * len(doomed))
            return self.agent_done(remove, {"tool": name, "player": nr, "removed": [list(d) for d in doomed]})
        if name == "tool_build_way":
            # <way>[,[a][k][s][t][,<max length>,<bridge>[,<tunnel>]]] like the game's way tool (plan_way's "param")
            fields = param.split(",")
            way = fields[0]
            bridge = fields[3] if len(fields) > 3 and fields[3] else None
            if way not in WAY_PRICES:
                raise ValueError("unknown way '%s'" % way)
            if bridge is not None and bridge not in BRIDGE_PRICES:
                raise ValueError("unknown bridge '%s'" % bridge)
            tiles = self.route(x, y, x2, y2)
            waytype, price, _ = WAY_PRICES[way]

            def build():
                new = [(tx, ty) for tx, ty in tiles if not any(wt == waytype for wt, _, _ in self.ways_at(tx, ty))]
                # with a bridge, water squares are bridged at the bridge's price (as plan_way counts them)
                wet = [t for t in new if bridge is not None and self.is_water(*t)]
                self.pay(nr, price * (len(new) - len(wet)) + (BRIDGE_PRICES[bridge][1] * len(wet) if wet else 0))
                for tx, ty in new:
                    self.add_object(tx, ty, "way", way, nr)
                    if (tx, ty) in wet:
                        self.add_object(tx, ty, "bridge", bridge, nr)
                    if waytype == "road":
                        self.mark(tx, ty, True, nr)
                # the route joins its squares, also existing ways of the waytype it passes (a branch makes a switch)
                self.connect(tiles, waytype)
                return {}
            return self.agent_done(build, {"tool": name, "player": nr, "from": [x, y], "to": [x2, y2], "way": way})
        if name in ("tool_build_bridge", "tool_build_tunnel"):
            table, kind = (BRIDGE_PRICES, "bridge") if name == "tool_build_bridge" else (TUNNEL_PRICES, "tunnel")
            if param not in table:
                raise ValueError("unknown %s '%s'" % (kind, param))
            tiles = self.route(x, y, x2, y2, straight=True)
            if tiles is None:
                raise ValueError("a %s must be straight" % kind)

            def build():
                self.pay(nr, table[param][1] * len(tiles))
                for tx, ty in tiles:
                    self.add_object(tx, ty, kind, param, nr)
                return {}
            return self.agent_done(build, {"tool": name, "player": nr, "from": [x, y], "to": [x2, y2], kind: param})
        if name == "tool_build_wayobj":
            if param not in WAYOBJ_PRICES:
                raise ValueError("unknown way object '%s'" % param)
            waytype, price, _ = WAYOBJ_PRICES[param]
            tiles = self.route(x, y, x2, y2)
            for tx, ty in tiles:
                if not any(wt == waytype for wt, _, _ in self.ways_at(tx, ty)):
                    raise ValueError("%s needs a %s way at %d,%d" % (param, waytype, tx, ty))

            def build():
                self.pay(nr, price * len(tiles))
                for tx, ty in tiles:
                    self.add_object(tx, ty, "wayobj", param, nr)
                return {}
            return self.agent_done(build, {"tool": name, "player": nr, "from": [x, y], "to": [x2, y2], "wayobj": param})
        # one square: station, sign, depot
        table = {"tool_build_station": STATION_PRICES, "tool_build_roadsign": SIGN_PRICES,
                 "tool_build_depot": DEPOT_PRICES}[name]
        kind = {"tool_build_station": "station", "tool_build_roadsign": "sign", "tool_build_depot": "depot"}[name]
        if kind == "station" and "," in param and param.rsplit(",", 1)[1].isdigit():
            param = param.rsplit(",", 1)[0]  # <name>,<rotation>
        if param not in table:
            raise ValueError("unknown %s '%s'" % (kind, param))
        waytype, price, _ = table[param]
        if kind == "sign":
            # one click on one square (two positions would place a row of signs: not imitated)
            if two and (x2, y2) != (x, y):
                raise ValueError("the fake engine places one sign per click")
            self.sign_click(nr, x, y, param)  # the game's checks before the tool is sent (refusals answer at once)
            # checked again when the click takes effect (--net: the square may have changed meanwhile)
            return self.agent_done(lambda: self.sign_click(nr, x, y, param)(),
                                   {"tool": name, "player": nr, "at": [x, y], kind: param})
        if waytype != "water" and not any(wt == waytype for wt, _, _ in self.ways_at(x, y)):
            raise ValueError("%s needs a %s way at %d,%d" % (param, waytype, x, y))
        if kind in ("station", "depot") and any(k in ("station", "depot") for k, _, _ in self.objects_at(x, y)):
            raise ValueError("there is a stop or depot at %d,%d already" % (x, y))

        def build():
            self.pay(nr, price)
            self.add_object(x, y, kind, param, nr)
            if kind == "station":
                w.stations.append({"id": w.next_station, "name": "Stop %d" % w.next_station, "owner": nr,
                                   "pos": {"x": x, "y": y, "z": 0}})
                w.next_station += 1
            elif kind == "depot":
                w.depots.append({"pos": [x, y, 0], "owner": nr, "waytype": waytype, "name": param, "convoys": [],
                                 "stored": []})
            return {}
        return self.agent_done(build, {"tool": name, "player": nr, "at": [x, y], kind: param})

    def find_depot(self, a, nr):
        x, y = self.pos_arg(a)
        for d in self.w.depots:
            if (d["pos"][0], d["pos"][1]) == (x, y):
                if d["owner"] != nr:
                    raise ValueError("the depot at %d,%d belongs to player %d" % (x, y, d["owner"]))
                return d
        raise ValueError("no depot at %d,%d" % (x, y))

    def find_convoy(self, cid, nr):
        for c in self.w.convoys:
            if c["id"] == cid:
                if c["owner"] != nr:
                    raise ValueError("convoy %d belongs to player %d" % (cid, c["owner"]))
                return c
        raise ValueError("no convoy %d" % cid)

    def find_line(self, lid, nr):
        for ln in self.w.lines:
            if ln["id"] == lid:
                if ln["owner"] != nr:
                    raise ValueError("line %d belongs to player %d" % (lid, ln["owner"]))
                return ln
        raise ValueError("no line %d" % lid)

    @staticmethod
    def id_arg(a, key, default=None):
        if key not in a or a[key] == "":
            if default is None:
                raise ValueError("%s= is required" % key)
            return default
        try:
            return int(a[key])
        except ValueError:
            raise ValueError("%s must be a number" % key) from None

    def convoy_waytype(self, c):
        names = c.get("vehicles") or ["Fake bus"]
        return VEHICLE_DESCS[names[0]]["waytype"]

    def depot_reply(self, d):
        w = self.w
        convoys = []
        for cid in d["convoys"]:
            c = next((c for c in w.convoys if c["id"] == cid), None)
            if c is not None:
                convoys.append({"id": c["id"], "name": c["name"], "vehicles": list(c.get("vehicles") or []),
                                "line": c["line"] or None})
        return {"pos": list(d["pos"]), "owner": d["owner"], "waytype": d["waytype"], "convoys": convoys,
                "stored": list(d["stored"])}

    def cmd_depot(self, a):
        x, y = self.pos_arg(a)
        for d in self.w.depots:
            if (d["pos"][0], d["pos"][1]) == (x, y):
                return self.depot_reply(d)
        raise ValueError("no depot at %d,%d" % (x, y))

    def cmd_depot_op(self, a):
        w = self.w
        nr = self.agent_player(a)
        d = self.find_depot(a, nr)
        op = a.get("op", "")
        if op not in ("a", "i", "b", "d", "v", "s"):
            raise ValueError("op must be a, i, b, d, v or s")
        cid = self.id_arg(a, "convoy", 0)
        if cid and cid not in d["convoys"]:
            raise ValueError("convoy %d is not in this depot" % cid)
        c = self.find_convoy(cid, nr) if cid else None
        vehicle = a.get("vehicle", "")
        if op in ("a", "i", "s"):
            if vehicle not in VEHICLE_DESCS:
                raise ValueError("unknown vehicle '%s'" % vehicle)
            desc = VEHICLE_DESCS[vehicle]
            if op != "s" and desc["waytype"] != d["waytype"]:
                raise ValueError("vehicle %s (%s) does not fit this %s depot" % (vehicle, desc["waytype"], d["waytype"]))
            year = w.months // 12
            if op != "s" and not desc["intro"] <= year < desc["retire"]:
                raise ValueError("vehicle %s is not available in %d" % (vehicle, year))
            if op == "s" and vehicle not in d["stored"]:
                raise ValueError("no stored %s in this depot" % vehicle)
        if op in ("b", "d", "v") and c is None:
            raise ValueError("op %s needs convoy=<id> of a convoy in this depot" % op)
        if op == "b" and not (c["line"] or c.get("schedule")):
            raise ValueError("convoy %d has no schedule" % cid)

        def change():
            if op in ("a", "i"):
                self.pay(nr, VEHICLE_PRICES[vehicle][0], "new_vehicles")
                if c is None:
                    cv = {"id": w.next_convoy, "name": "(%d) %s" % (w.next_convoy, vehicle), "owner": nr, "line": 0,
                          "x": d["pos"][0], "y": d["pos"][1], "z": 0, "dx": 1, "state": 0, "load": 0,
                          "vehicles": [vehicle], "depot": list(d["pos"]), "withdraw": False, "schedule": None,
                          "home": list(d["pos"])}
                    w.next_convoy += 1
                    w.convoys.append(cv)
                    d["convoys"].append(cv["id"])
                    return {"convoy": cv["id"]}
                if c["id"] not in [x["id"] for x in w.convoys]:
                    raise ValueError("convoy %d is gone" % cid)
                c.setdefault("vehicles", [])
                if op == "a":
                    c["vehicles"].append(vehicle)
                else:
                    c["vehicles"].insert(0, vehicle)
                return {}
            if op == "s":
                d["stored"].remove(vehicle)
                self.earn(nr, VEHICLE_PRICES[vehicle][0] * SELL_FACTOR)
                return {}
            if c["id"] not in d["convoys"]:
                raise ValueError("convoy %d is not in this depot any more" % cid)
            if op == "b":
                d["convoys"].remove(c["id"])
                c.update(state=6, depot=None)
                return {}
            d["convoys"].remove(c["id"])
            w.convoys = [x for x in w.convoys if x["id"] != c["id"]]
            names = c.get("vehicles") or ["Fake bus", "Mail trailer"]
            if op == "d":
                d["stored"].extend(names)
            else:
                self.earn(nr, sum(VEHICLE_PRICES[n][0] for n in names) * SELL_FACTOR)
            return {}
        return self.agent_done(change, {"cmd": "depot_op", "op": op, "player": nr, "depot": list(d["pos"]),
                                        "convoy": cid, "vehicle": vehicle or None})

    def parse_schedule(self, text, linetype, nr, loads=None):
        """engine schedule text <cur>|<type>|<x>,<y>,<z>,<min_load>,<wait>|...| -> (cur, stops) for a line or convoy
        of the line type; stops are the station dicts (or waypoints) of the fake world; loads (a list) gets the
        minimum load of every entry"""
        if loads is None:
            loads = []
        parts = (text or "").split("|")
        if len(parts) < 3:
            raise ValueError("invalid schedule: <cur>|<type>|<x>,<y>,<z>,<min_load>,<wait>|...|")
        try:
            cur, stype = int(parts[0]), int(parts[1])
        except ValueError:
            raise ValueError("invalid schedule: <cur>|<type>| must be numbers") from None
        if stype != linetype:
            raise ValueError("schedule type %d does not match the line type %d" % (stype, linetype))
        stops, entries = [], [p for p in parts[2:] if p.strip()]
        if not entries:
            raise ValueError("the schedule has no entries")
        for e in entries:
            f = e.split(",")
            try:
                x, y = int(f[0]), int(f[1])
                min_load, wait = (int(f[3]) if len(f) > 3 else 0), (int(f[4]) if len(f) > 4 else 0)
            except (ValueError, IndexError):
                raise ValueError("invalid schedule entry '%s'" % e) from None
            if not (0 <= x < SIZE and 0 <= y < SIZE_Y) or not 0 <= min_load <= 100 or wait < 0:
                raise ValueError("invalid schedule entry '%s'" % e)
            st = next((s for s in self.w.stations if (s["pos"]["x"], s["pos"]["y"]) == (x, y)), None)
            if st is not None:
                if st["owner"] not in (nr, 1):
                    raise ValueError("the stop at %d,%d belongs to player %d" % (x, y, st["owner"]))
                stops.append(st)
            elif self.ways_at(x, y) or any((d["pos"][0], d["pos"][1]) == (x, y) for d in self.w.depots):
                stops.append({"waypoint": True, "pos": {"x": x, "y": y, "z": 0}})
            else:
                raise ValueError("no stop or way at %d,%d" % (x, y))
            loads.append(min_load)
        if not 0 <= cur < len(stops):
            raise ValueError("schedule: current entry %d does not exist" % cur)
        return cur, stops

    def cmd_line_op(self, a):
        w = self.w
        nr = self.agent_player(a)
        op = a.get("op", "")
        if op in ("t", "u"):
            raise ValueError("line_op op=%s is not offered to agents" % op)
        if op == "c":
            wt = a.get("waytype", "")
            names = {v: k for k, v in LINE_TYPES.items()}
            linetype = int(wt) if wt.isdigit() else names.get(wt)
            if linetype not in LINE_TYPES:
                raise ValueError("waytype must be 1..8 or road, rail, water, air, monorail, tram, maglev, narrowgauge")
            loads = []
            cur, stops = self.parse_schedule(a.get("schedule"), linetype, nr, loads)

            def create():
                lid = w.next_line
                w.next_line += 1
                w.lines.append({"id": lid, "name": "Line %d" % lid, "owner": nr, "type": LINE_TYPES[linetype],
                                "linetype": linetype, "stops": stops, "loads": loads, "withdraw": False})
                return {"line": lid}
            return self.agent_done(create, {"cmd": "line_op", "op": "c", "player": nr})
        if op not in ("g", "d", "w", "r"):
            raise ValueError("op must be c, g, d, w or r")
        ln = self.find_line(self.id_arg(a, "line"), nr)
        if op == "g":
            loads = []
            cur, stops = self.parse_schedule(a.get("schedule"), ln.get("linetype", 1), nr, loads)
            change = lambda: ln.update(stops=stops, loads=loads) or {}  # noqa: E731
        elif op == "d":
            def change():
                w.lines = [x for x in w.lines if x is not ln]
                for c in w.convoys:
                    if c["line"] == ln["id"]:
                        c["line"] = 0
                return {}
        elif op == "w":
            if a.get("withdraw") not in ("0", "1"):
                raise ValueError("withdraw must be 0 or 1")
            value = a["withdraw"] == "1"

            def change():
                ln["withdraw"] = value
                for c in w.convoys:
                    if c["line"] == ln["id"]:
                        c["withdraw"] = value
                return {}
        else:
            name = (a.get("name") or "").strip()
            if not name or len(name) > 255:
                raise ValueError("name must be 1-255 characters")
            change = lambda: ln.update(name=name) or {}  # noqa: E731
        return self.agent_done(change, {"cmd": "line_op", "op": op, "player": nr, "line": ln["id"]})

    def cmd_convoy_op(self, a):
        w = self.w
        nr = self.agent_player(a)
        c = self.find_convoy(self.id_arg(a, "convoy"), nr)
        op = a.get("op", "")
        waytype = self.convoy_waytype(c)
        linetype = next((k for k, v in LINE_WAYTYPE.items() if v == waytype), 1)
        if op == "l":
            ln = self.find_line(self.id_arg(a, "line"), nr)
            if ln.get("linetype", 1) != linetype:
                raise ValueError("line %d is of another type than convoy %d" % (ln["id"], c["id"]))
            change = lambda: c.update(line=ln["id"], schedule=None) or {}  # noqa: E731
        elif op == "g":
            cur, stops = self.parse_schedule(a.get("schedule"), linetype, nr)
            change = lambda: c.update(line=0, schedule=[s["pos"] for s in stops]) or {}  # noqa: E731
        elif op == "x":
            def change():
                w.convoys = [x for x in w.convoys if x["id"] != c["id"]]
                for d in w.depots:
                    if c["id"] in d["convoys"]:
                        d["convoys"].remove(c["id"])
                names = c.get("vehicles") or ["Fake bus", "Mail trailer"]
                self.earn(nr, sum(VEHICLE_PRICES[n][0] for n in names) * SELL_FACTOR)
                return {}
        elif op == "d":
            depot = next((d for d in w.depots if d["owner"] == nr and d["waytype"] == waytype), None)
            if depot is None:
                raise ValueError("no %s depot of player %d for convoy %d" % (waytype, nr, c["id"]))

            def change():
                if c["id"] not in depot["convoys"]:
                    depot["convoys"].append(c["id"])
                c.update(state=0, x=depot["pos"][0], y=depot["pos"][1], depot=list(depot["pos"]))
                return {}
        elif op == "w":
            if a.get("withdraw") not in ("0", "1"):
                raise ValueError("withdraw must be 0 or 1")
            value = a["withdraw"] == "1"
            # like the engine: nothing is sent when the convoy has the value already (also in network games), and
            # a convoy standing in a depot is not withdrawn
            if bool(c.get("withdraw")) == value:
                return {"result": None, "changed": False}
            if value and any(c["id"] in d["convoys"] for d in w.depots):
                raise ValueError("convoy %d is standing in a depot: the engine does not withdraw it there (sell it "
                                 "with op=x)" % c["id"])
            change = lambda: c.update(withdraw=value) or {}  # noqa: E731
        else:
            raise ValueError("op must be l, g, x, d or w")
        return self.agent_done(change, {"cmd": "convoy_op", "op": op, "player": nr, "convoy": c["id"]})

    def cmd_plan_way(self, a):
        """dry run of a way: never changes the fake world, never pending"""
        self.agent_player(a)
        way = a.get("way", "")
        if way not in WAY_PRICES:
            raise ValueError("unknown way '%s'" % way)
        bridge, tunnel = a.get("bridge"), a.get("tunnel")
        if bridge is not None and bridge not in BRIDGE_PRICES:
            raise ValueError("unknown bridge '%s'" % bridge)
        if tunnel is not None and tunnel not in TUNNEL_PRICES:
            raise ValueError("unknown tunnel '%s'" % tunnel)
        x, y = self.pos_arg(a)
        x2, y2 = self.pos_arg(a, "x2", "y2")
        tiles = self.route(x, y, x2, y2, straight=a.get("straight") == "1")
        if tiles is None:
            return {"ok": False, "reason": "no straight route between the squares",
                    "error": "no straight route between the squares"}
        waytype, price, _ = WAY_PRICES[way]
        # the river: consecutive water squares are bridged (from the square before to the square after)
        bridges, i = [], 0
        while i < len(tiles):
            if self.is_water(*tiles[i]):
                j = i
                while j + 1 < len(tiles) and self.is_water(*tiles[j + 1]):
                    j += 1
                if bridge is None or i == 0 or j == len(tiles) - 1:
                    return {"ok": False, "reason": "no route: water at %d,%d needs a bridge" % tiles[i],
                            "error": "no route: water at %d,%d needs a bridge" % tiles[i]}
                bridges.append((i - 1, j + 1))
                i = j + 1
            i += 1
        on_bridge = {k for s, e in bridges for k in range(s, e + 1)}
        cost = 0
        for k, (tx, ty) in enumerate(tiles):
            if k in on_bridge:
                cost += BRIDGE_PRICES[bridge][1]
            elif not any(wt == waytype for wt, _, _ in self.ways_at(tx, ty)):
                cost += price
        # the param of agent_tool tool_build_way that builds the same route (as the game writes it)
        param = way + "," + ("s" if a.get("straight") == "1" else "")
        if bridge or tunnel:
            param += ",0," + (bridge or "") + ("," + tunnel if tunnel else "")
        return {"tiles": [[tx, ty, 0] for tx, ty in tiles], "length": len(tiles), "cost": float(cost),
                "bridges": [[[tiles[s][0], tiles[s][1], 0], [tiles[e][0], tiles[e][1], 0]] for s, e in bridges],
                "tunnels": [], "param": param}

    def cmd_estimate(self, a):
        kind, name = a.get("kind", ""), a.get("name", "")
        tables = {"way": WAY_PRICES, "bridge": BRIDGE_PRICES, "tunnel": TUNNEL_PRICES, "wayobj": WAYOBJ_PRICES,
                  "roadsign": SIGN_PRICES, "station": STATION_PRICES, "depot": DEPOT_PRICES}
        if kind not in tables and kind != "vehicle":
            raise ValueError("kind must be way, bridge, tunnel, wayobj, roadsign, station, depot or vehicle")
        count, length = self.id_arg(a, "count", 1), self.id_arg(a, "length", 1)
        if not 1 <= count <= 10000 or not 1 <= length <= 100000:
            raise ValueError("count must be 1..10000 and length 1..100000")
        sx = sy = 1
        if a.get("size"):
            try:
                sx, sy = (int(v) for v in a["size"].lower().split("x"))
            except ValueError:
                raise ValueError("size must look like 2x3") from None
            if not (1 <= sx <= 64 and 1 <= sy <= 64):
                raise ValueError("size must look like 2x3")
        if kind == "vehicle":
            if name not in VEHICLE_DESCS:
                raise ValueError("unknown vehicle '%s'" % name)
            d, (price, running, fixed) = VEHICLE_DESCS[name], VEHICLE_PRICES[name]
            year = self.w.months // 12
            return {"kind": kind, "name": name, "price": float(price), "maintenance": float(fixed), "count": count,
                    "total": float(price * count), "running_cost": running, "fixed_cost": float(fixed),
                    "power": d["power"], "speed": d["speed"], "capacity": d["capacity"], "freight": d["freight"],
                    "waytype": d["waytype"], "intro_year": d["intro"], "obsolete": year >= d["retire"],
                    "available": d["intro"] <= year < d["retire"]}
        if name not in tables[kind]:
            raise ValueError("unknown %s '%s'" % (kind, name))
        _, price, maintenance = tables[kind][name]
        units = {"way": length, "wayobj": length, "bridge": length, "tunnel": length, "station": sx * sy}.get(kind, 1)
        reply = {"kind": kind, "name": name, "price": float(price), "maintenance": float(maintenance), "count": count,
                 "total": float(price * units * count), "available": True}
        # like the game: linear objects tell the length, stations their size
        if kind in ("way", "wayobj", "bridge", "tunnel"):
            reply["length"] = length
        if kind == "station":
            reply["size"] = [sx, sy]
        return reply

    def cmd_fake_agent_state(self, a):
        w = self.w
        return {"objects": [{"x": x, "y": y, "kind": o["kind"], "name": o["name"], "owner": o["owner"]}
                            for (x, y), objs in sorted(w.objects.items()) for o in objs],
                "depots": [self.depot_reply(d) for d in w.depots], "log": w.agent_log[-200:],
                "cash": [round(c, 2) for c in w.cash], "pending": self.net_queue.qsize(),
                "applied": self.pending_done}

    def execute(self, line, conn=None):
        name, _, query = line.partition(" ")
        args = dict(urllib.parse.parse_qsl(query, keep_blank_values=True))
        reply = {}
        rid = args.pop("rid", None)
        if rid is not None:
            reply["rid"] = rid
        fn = getattr(self, "cmd_" + name, None)
        if self.opts.old and name in ("poll", "positions", "finance", "line", "convoy", "line_route", "fake_legs",
                                      "city", "factory", "supply_chain", "goods", "world_stats", "depot",
                                      "fake_agent_state") + AGENT_COMMANDS:
            fn = None
        if fn is not None:
            # the kinds of the game: actions refused by a read-only remote control, time commands unless it has time
            # control, agent commands unless it is a full remote control or has agent mode
            o = self.opts
            refused = None
            if o.read_only and (name in ACTION_COMMANDS or (name in TIME_COMMANDS and not o.time)):
                refused = "read-only remote control"
            elif name in AGENT_COMMANDS and o.read_only and not o.agent:
                refused = "agent commands need -remote_control_agent"
            if refused:
                reply.update(ok=False, error=refused)
                return reply
        if (self.opts.old or self.opts.no_events) and name in ("subscribe", "unsubscribe"):
            fn = None
        if (self.opts.old or self.opts.no_map) and name in ("palette", "minimap", "map_changes", "labels", "fake_build", "fake_fail"):
            fn = None
        if (self.opts.old or self.opts.no_map or self.opts.no_3d) and name in VIEW3D_COMMANDS:
            fn = None
        if name in VIEW3D_COMMANDS:
            self.calls[name] = self.calls.get(name, 0) + 1
        if fn is None:
            reply.update(ok=False, error="unknown command")
            return reply
        with self.w.lock:
            try:
                if name in ("subscribe", "unsubscribe"):
                    result = fn(args, conn)
                else:
                    result = fn(args)
                reply.update(result)
                if "ok" not in result:  # plan_way answers {"ok": false, "reason"} for no route
                    reply["ok"] = True
            except (ValueError, KeyError, IndexError) as e:
                reply.update(ok=False, error=str(e).strip("'"))
        return reply


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(5)
        try:
            hello = self.rfile.readline()
        except OSError:
            return
        engine = self.server.engine
        protocols = (b"1",) if engine.opts.old or engine.opts.no_events else (b"1", b"2")
        hello = hello.strip()
        if not hello.startswith(b"HELLO simutrans-remote ") or hello[23:] not in protocols:
            return  # like the game: closed without an answer
        self.connection.settimeout(None)
        conn = Conn(self.wfile)
        conn.proto = int(hello[23:])
        o = engine.opts
        if o.old:
            greeting = {"ok": True, "protocol": conn.proto, "read_only": False}
        else:
            # like the game: time control unless read-only without -remote_control_time; agent commands unless
            # read-only without -remote_control_agent
            greeting = {"ok": True, "protocol": conn.proto, "read_only": o.read_only,
                        "time_control": not o.read_only or o.time, "agent": not o.read_only or o.agent}
        conn.send((json.dumps(greeting, separators=(",", ":")) + "\n").encode("utf-8"))
        engine.add_conn(conn)
        try:
            for raw in self.rfile:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                if engine.opts.delay:
                    time.sleep(engine.opts.delay)
                if engine.opts.delay_3d and line.split(" ", 1)[0] in VIEW3D_COMMANDS:
                    time.sleep(engine.opts.delay_3d)
                reply = engine.execute(line, conn)
                conn.send((json.dumps(reply, separators=(",", ":")) + "\n").encode("utf-8"))
                engine.process_events()  # the next "frame": watchers see what the request changed
        except OSError:
            pass
        finally:
            engine.remove_conn(conn)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False


def main():
    p = argparse.ArgumentParser(description="fake Simutrans remote control for dashboard tests")
    p.add_argument("--port", type=int, default=13399)
    p.add_argument("--old", action="store_true", help="imitate an engine before phase 0b")
    p.add_argument("--no-events", action="store_true", help="imitate an engine with protocol 1 only")
    p.add_argument("--no-map", action="store_true", help="imitate an engine without the map export (and 3D export)")
    p.add_argument("--no-3d", action="store_true", help="imitate an engine without the 3D export")
    p.add_argument("--delay-3d", type=float, default=0.0, help="extra seconds per 3D request")
    p.add_argument("--size", default="256x256", help="world size WxH (default 256x256)")
    p.add_argument("--convoys", type=int, default=60)
    p.add_argument("--month-seconds", type=float, default=20.0, help="wall seconds per game month")
    p.add_argument("--msg-seconds", type=float, default=2.0, help="seconds between generated messages")
    p.add_argument("--step", type=float, default=0.25, help="seconds between simulation steps")
    p.add_argument("--delay", type=float, default=0.0, help="extra seconds per request")
    p.add_argument("--markup", action="store_true", help="put HTML with script into every name and message (XSS tests)")
    p.add_argument("--read-only", action="store_true", help="imitate -remote_control_readonly")
    p.add_argument("--time", action="store_true", help="imitate -remote_control_time (with --read-only)")
    p.add_argument("--agent", action="store_true", help="imitate -remote_control_agent (with --read-only)")
    p.add_argument("--players", type=int, default=2,
                   help="number of players (default 2: 0 Human, 1 Public; more are human companies)")
    p.add_argument("--net", action="store_true",
                   help="imitate a network game: changing agent commands answer pending and act 0.5 s later")
    p.add_argument("--net-client", action="store_true",
                   help="imitate a network client (implies --net): --locked companies are refused")
    p.add_argument("--locked", type=int, action="append", default=[], metavar="N",
                   help="company N is protected by a password (repeatable)")
    p.add_argument("--forbid-tool", action="append", default=[], metavar="NAME",
                   help="a scenario forbids this tool (script name, e.g. tool_build_way) for agent_tool")
    p.add_argument("--net-delay", type=float, default=NET_DELAY, metavar="S",
                   help="--net: seconds until a pending change takes effect (default %.1f)" % NET_DELAY)
    p.add_argument("--agent-cost-factor", type=float, default=1.0, metavar="F",
                   help="agent commands really cost F times the prices that estimate and plan_way tell (tests of the "
                        "executor's overrun stop)")
    p.add_argument("--no-tile-dirs", action="store_true",
                   help="imitate an engine whose tile read has no desc, waytype and dirs of ways, signs, way objects")
    opts = p.parse_args()
    if not 2 <= opts.players <= PLAYER_UNOWNED:
        p.error("--players takes 2..%d" % PLAYER_UNOWNED)
    if opts.net_client:
        opts.net = True
    opts.locked = set(opts.locked)
    opts.forbid_tool = set(t.lower() for t in opts.forbid_tool)
    PLAYER_NAMES[2:] = ["Company %d" % i for i in range(2, opts.players)]
    global SIZE, SIZE_Y, MARK
    if opts.markup:
        MARK = " " + XSS
        PLAYER_NAMES[:] = [n + MARK for n in PLAYER_NAMES]
        CITIES[:] = [(c[0] + MARK,) + tuple(c[1:]) for c in CITIES]
        FACTORIES[:] = [(f[0] + MARK,) + tuple(f[1:]) for f in FACTORIES]
        GOODS[:] = [tuple(g[:2]) + (g[2] + MARK,) + tuple(g[3:]) for g in GOODS]
    try:
        SIZE, SIZE_Y = (int(v) for v in opts.size.lower().split("x"))
    except ValueError:
        p.error("--size takes WxH, e.g. 600x400")
    engine = Engine(opts)
    server = Server(("127.0.0.1", opts.port), Handler)
    server.engine = engine

    def ticker():
        last = time.monotonic()
        while True:
            time.sleep(opts.step)
            now = time.monotonic()
            engine.w.step(now - last, now)
            engine.process_events()
            last = now
    threading.Thread(target=ticker, daemon=True).start()
    print("fake engine on 127.0.0.1:%d%s%s%s%s" % (opts.port, " (old protocol)" if opts.old else
                                                   " (protocol 1 only)" if opts.no_events else "",
                                                   " (no 3D export)" if opts.no_3d else "",
                                                   " (read-only%s%s)" % (", time" if opts.time else "",
                                                                         ", agent" if opts.agent else "")
                                                   if opts.read_only else "",
                                                   " (network %s)" % ("client" if opts.net_client else "server")
                                                   if opts.net else ""), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
