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

  python tools/dashboard/dev/fake_engine.py [--port 13399] [--old] [--no-events] [--no-map]
         [--convoys 60] [--size 256x256] [--markup]

--old imitates an engine without poll, positions, messages since=, paging, events and the map
export (limit=0 then returns nothing, like the engine before phase 0b). --no-events imitates an
engine with the phase 0b commands but only protocol 1. Both close the connection on HELLO
simutrans-remote 2, as such engines do. --no-map leaves out only the map export.
"""

import argparse
import base64
import json
import random
import socketserver
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
        self.cash = [1000000.0, 50000.0]
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
        self.messages = []
        for k in range(3):
            self._add_message("World %d message %d" % (self.gen, k) + MARK, 0)
        self.new_map()

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
                           "factories": len(FACTORIES), "cities": len(CITIES), "players": 2},
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
            {"nr": i, "name": PLAYER_NAMES[i], "type": ["human", "public"][i], "active": True,
             "locked": False, "cash": round(w.cash[i], 2), "net_wealth": round(w.cash[i], 2),
             "lines": sum(1 for l in w.lines if l["owner"] == i),
             "convoys": sum(1 for c in w.convoys if c["owner"] == i),
             "stations": sum(1 for s in w.stations if s["owner"] == i)} for i in range(2)]}

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
                          "vehicles": 2, "loading_level": c["load"], "next_stop": None,
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
        if nr not in (0, 1):
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
            nv = round(-500000.0 * f, 2) if m % 5 == 0 else 0.0
            con = round(-80000.0 * f, 2) if m % 7 == 0 else 0.0
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
                          "convoys": len(conv), "withdraw": False, "this_month": self.line_month(line, 0),
                          "last_month": self.line_month(line, 1)},
                 "goods": ["Passengers", "Mail"], "convoys": [c["id"] for c in conv], "capacity": 60 * len(conv),
                 "load": sum(c["load"] * 60 // 100 for c in conv),
                 "schedule": [self.stop_entry(st, True) for st in line["stops"]]}
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
                             "minimap_color": i * 8 + 3} for i in range(2)],
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

    def cmd_tile(self, a):
        if "x" not in a or "y" not in a:
            raise ValueError("missing tile coordinates x,y")
        return {"grounds": [{"pos": {"x": int(a["x"]), "y": int(a["y"]), "z": 0}, "type": "Boden",
                             "objects": []}]}

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

    def execute(self, line, conn=None):
        name, _, query = line.partition(" ")
        args = dict(urllib.parse.parse_qsl(query, keep_blank_values=True))
        reply = {}
        rid = args.pop("rid", None)
        if rid is not None:
            reply["rid"] = rid
        fn = getattr(self, "cmd_" + name, None)
        if self.opts.old and name in ("poll", "positions", "finance", "line", "convoy", "line_route", "fake_legs",
                                      "city", "factory", "supply_chain", "goods", "world_stats"):
            fn = None
        if (self.opts.old or self.opts.no_events) and name in ("subscribe", "unsubscribe"):
            fn = None
        if (self.opts.old or self.opts.no_map) and name in ("palette", "minimap", "map_changes", "labels", "fake_build", "fake_fail"):
            fn = None
        if fn is None:
            reply.update(ok=False, error="unknown command")
            return reply
        with self.w.lock:
            try:
                if name in ("subscribe", "unsubscribe"):
                    reply.update(fn(args, conn))
                else:
                    reply.update(fn(args))
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
        conn.send(b'{"ok":true,"protocol":%d,"read_only":false}\n' % conn.proto)
        engine.add_conn(conn)
        try:
            for raw in self.rfile:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                if engine.opts.delay:
                    time.sleep(engine.opts.delay)
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
    p.add_argument("--no-map", action="store_true", help="imitate an engine without the map export")
    p.add_argument("--size", default="256x256", help="world size WxH (default 256x256)")
    p.add_argument("--convoys", type=int, default=60)
    p.add_argument("--month-seconds", type=float, default=20.0, help="wall seconds per game month")
    p.add_argument("--msg-seconds", type=float, default=2.0, help="seconds between generated messages")
    p.add_argument("--step", type=float, default=0.25, help="seconds between simulation steps")
    p.add_argument("--delay", type=float, default=0.0, help="extra seconds per request")
    p.add_argument("--markup", action="store_true", help="put HTML with script into every name and message (XSS tests)")
    opts = p.parse_args()
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
    print("fake engine on 127.0.0.1:%d%s" % (opts.port, " (old protocol)" if opts.old else
                                             " (protocol 1 only)" if opts.no_events else ""), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
