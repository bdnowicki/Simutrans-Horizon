#!/usr/bin/env python3
# This file is part of the Simutrans-Horizon project under the Artistic License.
# (see LICENSE.txt)
"""
Browser dashboard bridge for Simutrans-Horizon.

Serves the static dashboard (tools/dashboard/web/) and a small HTTP API, and talks to a
running Simutrans that was started with -remote_control [port] (line protocol, see
tools/mcp/README.md). A poller connection reads the game periodically and fans the
results out to all browsers through Server-Sent Events; requests of the browsers use a
second connection. A third connection subscribes the events of the game (protocol 2), so
messages, pause and cash changes arrive at once and the poller can poll less; without
protocol 2 the bridge only polls. Map tiles (/tiles/<mode>/<step>/<cx>/<cy>.png) are palette
PNGs made from the game's minimap and kept until map_changes, a new month or another world
makes them old. GET /api/factory_status gathers the factory windows of all factories (pipelined) for
the factories table; goods and supply_chain travel as feeds. The 3D view reads desc_list, scene3d,
heights and vehicles3d through two more connections of its own (opened when needed), cached by the
map changes; /pak3d/ serves the models of a pak 3D directory (--pak3d). Static files and large JSON
replies are sent gzip compressed to browsers that accept it. Only the Python standard library is
used (Python 3.10+).

  python tools/dashboard/simutrans_dashboard.py [--game-port 13360] [--port 13380] [--pak3d DIR]

tools/dashboard/README.md documents the HTTP API and the security model.
"""

import argparse
import base64
import collections
import gzip
import hashlib
import hmac
import json
import logging
import os
import queue
import re
import secrets
import signal
import socket
import struct
import sys
import threading
import time
import urllib.parse
import zlib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
_MCP_DIR = os.path.join(os.path.dirname(HERE), "mcp")
sys.path.insert(0, _MCP_DIR)
try:
    # importing only defines classes and constants, it does not connect to the game
    from simutrans_mcp import GameConnection, GameError
finally:
    sys.path.remove(_MCP_DIR)

VERSION = "0.1.0"
DEFAULT_GAME_PORT = 13360
DEFAULT_PORT = 13380
WEB_DIR = os.path.join(HERE, "web")

log = logging.getLogger("dashboard")

# --- what browsers may do ----------------------------------------------------------------

READ_COMMANDS = ("ping", "status", "tile", "map", "players", "cities", "stations", "station",
                 "convoys", "lines", "factories", "messages", "poll", "positions",
                 "palette", "minimap", "map_changes", "labels",
                 # details and histories (older engines answer "unknown command")
                 "finance", "line", "convoy", "line_route", "city", "factory", "supply_chain", "goods",
                 "world_stats")
# read requests the bridge answers itself (from several game requests), see App.factory_status
BRIDGE_READS = ("factory_status",)
# action command -> arguments passed to the game
ACTION_ARGS = {
    "view": ("x", "y", "z"),
    "zoom": ("dir", "count"),
    "pause": ("on",),
    "fast_forward": ("on",),
    "tool": ("tool", "x", "y", "z", "x2", "y2", "z2", "param", "ctrl", "shift"),
    "cash": ("amount", "player"),
}
ROLE_ACTIONS = {
    "viewer": (),
    "player": ("view", "zoom", "pause", "fast_forward", "tool"),
    "admin": ("view", "zoom", "pause", "fast_forward", "tool", "cash"),
}
# never reachable through the bridge, whatever the role (also refused as unknown commands)
NEVER_PROXIED = frozenset(("eval", "screenshot", "click", "move", "drag", "wheel", "key", "text",
                           "unlock_game", "remove_password", "tool_visibility", "windows"))
TOOL_REFUSED_ARGS = ("player", "unowned")
# general tools the dashboard never applies (number = index in simmenu.h): locking the game sets a
# password and switches off changing the player; the others run scripts or write files
REFUSED_TOOLS = {28: "tool_lock_game", 42: "tool_exec_script", 43: "tool_exec_two_click_script",
                 47: "tool_generate_script"}
HEAVY_LISTS = ("stations", "convoys", "lines")
MAX_MAP_TILES = 512 * 512
MAX_HEAVY = 2
MAX_SSE = 64
MAX_SESSIONS = 1000
MAX_BODY = 16 * 1024
SESSION_IDLE = 12 * 3600
RATE_PER_SECOND = 30.0
RATE_BURST = 60.0
LOGIN_FAILURES = 5          # failed logins per IP and minute
RING_EVENTS = 500
RING_BYTES = 32 * 1024 * 1024
SSE_QUEUE = 2000
ARG_NAME = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_ARG_VALUE = 512
SESSION_CHECK = 5.0         # seconds between session checks of an open event stream
MAX_CONNECTIONS = 256       # open HTTP connections (one thread each) at once ...
MAX_CONNECTIONS_PER_IP = 32  # ... and from one address other than the loopback (proxies, tunnels)
# map exports of the browsers (map, minimap, uncached tiles) run in a frame of the game, a minimap of a
# whole 1024 x 1024 map in a statistics mode takes some 0.2 s: their round-trip time is limited to this
# many seconds per second (bursts up to EXPORT_BURST s), further ones get 429
EXPORT_COMMANDS = ("map", "minimap")
EXPORT_RATE = 0.25
EXPORT_BURST = 2.0

assert not NEVER_PROXIED & (set(READ_COMMANDS) | set(ACTION_ARGS) | set(BRIDGE_READS))

# map tiles: /tiles/<mode>/<step>/<cx>/<cy>.png, one chunk of CHUNK x CHUNK minimap samples
MAP_MODES = ("terrain", "owner", "traffic", "freight", "passengers", "mail", "tracks", "speed", "power",
             "forest", "level", "climates")
TRACKED_MODES = frozenset(("terrain", "owner"))  # the game's change tracking covers these colours
MAP_STEPS = (1, 2, 4, 8, 16)
CHUNK = 256
TILE_PATH = re.compile(r"^/tiles/([a-z]{1,16})/(\d{1,2})/(\d{1,5})/(\d{1,5})\.png$")
TILE_CACHE_BYTES = 48 * 1024 * 1024
TILE_RATE = 60.0            # tile requests per second and session, bursts up to TILE_BURST
TILE_BURST = 120.0
MAP_FOLLOW = 600            # seconds after the last tile request the bridge still follows map changes

# line routes: GET /api/line_route?id= merges the legs the convoys of a line drive over time
ROUTE_REFRESH = 30.0        # seconds: the legs of a line are fetched again at most this often
ROUTE_LINES = 64            # lines kept in the route cache (the least recently requested ones go first)

# factory status (GET /api/factory_status): the `factory` windows of all factories, kept this long
FACTORY_STATUS_TTL = 30.0
FACTORY_BATCH = 64          # factory requests sent at once (pipelined) on the request connection

# 3D view (tools/mcp/README.md "3D export"): GET /api/desc_list, scene3d, heights, vehicles3d
VIEW3D_READS = ("desc_list", "scene3d", "heights", "vehicles3d")
DESC_KINDS = ("buildings", "vehicles", "ways", "bridges", "tunnels", "trees", "signs", "wayobjs", "goods", "citycars",
              "pedestrians")
SCENE_SIZES = (16, 32, 64)
CELL = 64                   # squares per side of a cell of map_changes chunk=64 (the unit of the 3D change tracking)
HEIGHTS_STEPS = (1, 2, 4, 8, 16)
MAX_HEIGHT_SAMPLES = 66049
HEIGHTS_REFRESH = 10.0      # s: a cached heights region whose cells changed is fetched again at most this often
VERIFY_REVS = 64            # cached replies checked per map change whether a reported change predates them
VEH_MAX_SIDE = 256          # vehicles3d regions: at most 256 x 256 squares (also the engine's limit with extras=1)
VEH_CACHE = 0.1             # s: a vehicles3d reply is shared by the requests for the same region within this time
SCENE_CACHE_BYTES = 64 * 1024 * 1024
HEIGHTS_CACHE_BYTES = 8 * 1024 * 1024
DESC_CACHE_BYTES = 8 * 1024 * 1024
VEH_CACHE_BYTES = 4 * 1024 * 1024
QUEUE_3D = 32               # requests waiting for the 3D game connection (desc_list, scene3d, heights) ...
QUEUE_VEH = 8               # ... and for the vehicles3d connection; further ones get 503
WAIT_3D = 30.0              # s a request waits for its turn and the game's answer, then 503
IDLE_3D = 120.0             # s without requests after which a 3D game connection is closed (frees one of the 8)
# own token buckets (per session, instead of the general one): chunks like map tiles, vehicles about 5/s
VIEW3D_RATES = {"scene3d": (60.0, 120.0), "vehicles3d": (5.0, 10.0)}
UNSUPPORTED_3D = {"ok": False, "error": "unsupported",
                  "detail": "the game has no 3D export (desc_list, scene3d, heights, vehicles3d): it needs a newer "
                            "Simutrans-Horizon"}

# gzip: static files of these types and JSON replies of at least GZIP_MIN bytes, for browsers that accept it
GZIP_MIN = 1024
GZIP_CACHE_BYTES = 64 * 1024 * 1024   # compressed static files, by path, mtime and size
STATIC_MAX = 32 * 1024 * 1024         # larger static files are streamed (not compressed)
COMPRESSIBLE = frozenset((".html", ".js", ".mjs", ".css", ".svg", ".json", ".txt", ".md", ".map", ".gltf", ".glb",
                          ".bin"))
# /pak3d/...: files of the pak 3D directory (--pak3d), only these types; names with a content hash are immutable
PAK3D_TYPES = frozenset((".json", ".glb", ".gltf", ".bin", ".png", ".webp", ".ktx2", ".jpg", ".jpeg", ".txt", ".md"))
HASHED_NAME = re.compile(r"\.[0-9a-f]{8,64}\.[a-z0-9]+$")
INT_ARG = re.compile(r"^-?\d{1,6}$")

# seconds between polls of each feed, and the shortest gap when a feed is triggered early
INTERVALS = {"poll": 1, "positions": 1, "messages": 5, "players": 5, "convoys": 15, "lines": 15,
             "stations": 30, "factories": 30, "cities": 30, "palette": 60, "map": 10, "goods": 600,
             "supply_chain": 60}
MIN_GAP = {"poll": 0.5, "positions": 0.5, "messages": 0.5, "players": 2, "convoys": 5, "lines": 5,
           "stations": 5, "factories": 5, "cities": 5, "palette": 5, "map": 0.5, "goods": 5, "supply_chain": 5}
# ... while the game pushes events: messages, status, cash and convoy states come as events, so the
# poll is only needed for the clock and the lists change on events (month, added/removed convoys)
EVENT_INTERVALS = dict(INTERVALS, poll=2, messages=3600, players=15, convoys=30, lines=30)
EVENT_TOPICS = "messages,month,world,status,cash,convoys,arrivals"
EVENT_INTERVAL_MS = 1000    # interval of the watcher events (status, cash, convoys, arrivals)
ARRIVALS_GAP = 1.0          # arrivals go to the browsers at most once per this many seconds
MAX_ARRIVALS = 4096         # arrivals per SSE event, further ones are counted in "dropped"
STATUS_FIELDS = ("paused", "ff", "mult")
HEARTBEAT = 25
LIST_FEEDS = ("convoys", "lines", "stations", "factories", "cities")
SUMMARY_FEEDS = ("convoys", "lines", "stations")
FEEDS = ("poll", "players", "lines", "convoys", "stations", "factories", "cities", "palette", "goods",
         "supply_chain")
# feeds of detail commands: an engine without them answers "unknown command" (the feed stays null)
DETAIL_FEEDS = ("goods", "supply_chain")
UNLIMITED = 1000000  # limit for engines without limit=0

MESSAGE_TYPES = ("general", "ai", "city", "problems", "industry", "chat", "new_vehicle", "full",
                 "warnings", "traffic_jams", "scenario", "chat_common", "chat_company", "chat_private")

# connect-src blob:: three.js' GLTFLoader turns the textures embedded in a .glb into blob: URLs of the page and
# fetches them (ImageBitmapLoader); such a URL only ever holds bytes the page already has (README, "Pak 3D")
CSP = ("default-src 'self'; img-src 'self' data: blob:; connect-src 'self' blob:; frame-ancestors 'none'; "
       "base-uri 'none'; form-action 'self'")
SECURITY_HEADERS = (
    ("Content-Security-Policy", CSP),
    ("X-Frame-Options", "DENY"),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
)
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
    ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8", ".map": "application/json",
    ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
    ".webp": "image/webp", ".ktx2": "image/ktx2", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
}
STATIC_EXACT = {"/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css"}
STATIC_PREFIXES = ("/vendor/", "/img/", "/js/")
STATIC_CACHED = ("vendor/", "img/")
TOKEN_RE = re.compile(r"(token=)[^&\s\"']*", re.IGNORECASE)


def json_dumps(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def utf8(text):
    return text.encode("utf-8", "replace")


class Unreachable(Exception):
    """The game cannot be reached (not running, connection lost, no answer)."""


class EngineFail(Exception):
    """The game answers but refuses the poll (e.g. no world loaded)."""


class Reconnected(Exception):
    """GameConnection reconnected inside a request (game restarted): start over."""


def unreachable_text(port, error):
    return ("Simutrans is not reachable on 127.0.0.1:%d (%s). Start the game with -remote_control %d, "
            "or start the dashboard with --game-port <remote control port of the game>." % (port, error, port))


class EngineConnection(GameConnection):
    """GameConnection of tools/mcp with a configurable timeout and replies that keep "ok"."""

    def __init__(self, port, timeout):
        super().__init__(port)
        self.timeout = timeout
        self.generation = 0  # counts successful connects, so callers notice reconnects

    def connect(self):
        try:
            super().connect()
        except GameError as e:
            if isinstance(e.__cause__, OSError):
                # the text of tools/mcp points to an MCP tool, not to the dashboard
                raise GameError(unreachable_text(self.port, e.__cause__)) from e.__cause__
            raise
        except (OSError, ValueError) as e:
            # reset or garbage during the handshake (e.g. the game is full or just quitting)
            raise GameError("the game closed the connection during the handshake (%s)" % e) from e
        self.sock.settimeout(self.timeout)
        self.generation += 1

    def call(self, command, **args):
        """Reply dict with "ok"; game errors come back as {"ok":false,"error":..}.
        Raises Unreachable when the game cannot be reached."""
        try:
            result = self.request(command, **args)
        except GameError as e:
            if self.file is None:
                raise Unreachable(str(e)) from None
            return {"ok": False, "error": str(e)}
        except (ValueError, AttributeError):
            self.close()
            raise Unreachable("the game sent an invalid reply") from None
        result["ok"] = True
        return result

    def call_many(self, requests):
        """Replies (dicts with "ok") of several requests sent at once: the game answers them in order,
        several in one frame. requests: [(command, {arg: value})]. Raises Unreachable."""
        lines = []
        for command, args in requests:
            params = {k: str(v) for k, v in args.items() if v is not None}
            lines.append(command + (" " + urllib.parse.urlencode(params, quote_via=urllib.parse.quote) if params else ""))
        data = ("\n".join(lines) + "\n").encode("utf-8")
        with self.lock:
            for attempt in range(2):
                fresh = self.file is None
                try:
                    if fresh:
                        self.connect()
                    self.file.write(data)
                    self.file.flush()
                    raw = [self.file.readline() for _ in requests]
                except GameError as e:
                    raise Unreachable(str(e)) from None
                except socket.timeout:
                    self.close()
                    raise Unreachable("the game did not answer in time") from None
                except OSError:
                    raw = [b""]
                if raw and raw[0] and raw[-1]:
                    break
                # stale connection (e.g. the game restarted): reconnect once
                self.close()
                if fresh or attempt == 1 or (raw and raw[0]):
                    raise Unreachable("the game closed the connection")
        out = []
        for line in raw:
            try:
                out.append(json.loads(line.decode("utf-8", errors="replace")))
            except ValueError:
                self.close()
                raise Unreachable("the game sent an invalid reply") from None
        return out


def is_unknown_command(reply):
    return not reply.get("ok") and reply.get("error") == "unknown command"


# --- map tiles -----------------------------------------------------------------------------------

def _png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def make_tile_png(samples, width, height, colors):
    """8-bit indexed PNG of CHUNK x CHUNK pixels from minimap samples (palette indices of `colors`,
    width x height, row after row). Pixels without a sample (beyond the map edge) are transparent;
    the PLTE holds only the colours used."""
    used = sorted(set(samples))
    pad = width < CHUNK or height < CHUNK
    if pad and len(used) > 255:
        used = used[:255]  # never in practice (the minimap uses some 40 colours): merge the rest
    table = bytearray(256)
    for i, c in enumerate(used):
        table[c] = i
    for c in range(256):
        if c > used[-1]:
            table[c] = len(used) - 1
    data = samples.translate(bytes(table))
    plte = b"".join(bytes(colors[c]) for c in used)
    rows = []
    if pad:
        clear = len(used)
        plte += b"\0\0\0"
        fill = bytes((clear,)) * (CHUNK - width)
        rows = [b"\0" + data[y * width:(y + 1) * width] + fill for y in range(height)]
        rows.extend([b"\0" + bytes((clear,)) * CHUNK] * (CHUNK - height))
    else:
        rows = [b"\0" + data[y * width:(y + 1) * width] for y in range(height)]
    parts = [b"\x89PNG\r\n\x1a\n",
             _png_chunk(b"IHDR", struct.pack(">IIBBBBB", CHUNK, CHUNK, 8, 3, 0, 0, 0)),
             _png_chunk(b"PLTE", plte)]
    if pad:
        parts.append(_png_chunk(b"tRNS", b"\xff" * len(used) + b"\0"))
    parts.append(_png_chunk(b"IDAT", zlib.compress(b"".join(rows), 6)))
    parts.append(_png_chunk(b"IEND", b""))
    return b"".join(parts)


def palette_colors(reply):
    """The 256 [r, g, b] colours of a palette reply as a tuple of 3-byte values, or None."""
    colors = reply.get("colors") if isinstance(reply, dict) else None
    if not isinstance(colors, list) or len(colors) != 256:
        return None
    out = []
    for c in colors:
        if not isinstance(c, list) or len(c) != 3 or not all(isinstance(v, int) for v in c):
            return None
        out.append(bytes(min(max(v, 0), 255) for v in c))
    return tuple(out)


class TileCache:
    """PNG tiles of the minimap by (mode, step, cx, cy). An entry stays valid while no chunk it covers
    changed after the map gen it was made at (chunk gens come from map_changes), the statistics modes
    also only within one game month, and everything until the next reset (another world, a full
    reload of the map, a reconnect)."""

    def __init__(self, max_bytes=TILE_CACHE_BYTES):
        self.lock = threading.Lock()
        self.max_bytes = max_bytes
        self.entries = collections.OrderedDict()  # key -> (png, etag, gen, epoch, stats)
        self.bytes = 0
        self.epoch = 0
        self.chunk_gen = {}       # (x, y) of a CHUNK x CHUNK square at step 1 -> gen of its last change
        self.month = None
        self.stats = 0            # counts game months for the statistics modes
        self.colors = None
        self.first_gen = None     # smallest gen of a minimap reply since the last reset
        self.requested = None     # time.monotonic() of the last tile request
        self.flights = {}         # key -> threading.Event while one request fetches the tile

    def reset(self):
        with self.lock:
            self.epoch += 1
            self.entries.clear()
            self.bytes = 0
            self.chunk_gen.clear()
            self.first_gen = None

    def set_colors(self, colors):
        with self.lock:
            if colors != self.colors:
                self.colors = colors
                self.entries.clear()
                self.bytes = 0

    def new_month(self, date):
        """A game month began (event or poll date); True when it is new to the cache."""
        if not isinstance(date, dict) or not isinstance(date.get("year"), int) or not isinstance(date.get("month"), int):
            return False
        key = date["year"] * 12 + date["month"]
        with self.lock:
            if key == self.month:
                return False
            self.month = key
            self.stats += 1
            return True

    def changed(self, gen, chunks):
        with self.lock:
            for c in chunks:
                if isinstance(c, list) and len(c) == 2:
                    self.chunk_gen[(c[0], c[1])] = gen

    def note_request(self):
        """A browser wants a tile; True for the first one since the bridge stopped following changes."""
        now = time.monotonic()
        with self.lock:
            first = self.requested is None or now - self.requested > MAP_FOLLOW
            self.requested = now
            return first

    def following(self):
        with self.lock:
            return self.requested is not None and time.monotonic() - self.requested <= MAP_FOLLOW

    def since_gen(self):
        with self.lock:
            return self.first_gen

    def state(self):
        with self.lock:
            return self.epoch, self.stats

    def _valid_locked(self, key, entry):
        mode, step, cx, cy = key
        if entry[3] != self.epoch or (mode not in TRACKED_MODES and entry[4] != self.stats):
            return False
        if self.chunk_gen:
            gen = entry[2]
            for y in range(cy * step, (cy + 1) * step):
                for x in range(cx * step, (cx + 1) * step):
                    if self.chunk_gen.get((x, y), -1) > gen:
                        return False
        return True

    def lookup(self, key):
        """(png, etag) of a valid entry, or None."""
        with self.lock:
            entry = self.entries.get(key)
            if entry is None or not self._valid_locked(key, entry):
                return None
            self.entries.move_to_end(key)
            return entry[0], entry[1]

    def store(self, key, png, etag, gen, epoch, stats):
        with self.lock:
            if epoch != self.epoch:
                return  # reset while the tile was fetched
            if self.first_gen is None or gen < self.first_gen:
                self.first_gen = gen
            old = self.entries.pop(key, None)
            if old is not None:
                self.bytes -= len(old[0])
            self.entries[key] = (png, etag, gen, epoch, stats)
            self.bytes += len(png)
            while self.bytes > self.max_bytes and len(self.entries) > 1:
                _, dropped = self.entries.popitem(last=False)
                self.bytes -= len(dropped[0])

    def begin(self, key):
        """None when this caller fetches the tile (call end() afterwards), else an Event to wait for."""
        with self.lock:
            ev = self.flights.get(key)
            if ev is None:
                self.flights[key] = threading.Event()
            return ev

    def end(self, key):
        with self.lock:
            ev = self.flights.pop(key, None)
        if ev is not None:
            ev.set()


# --- line routes ---------------------------------------------------------------------------------

def route_key(end):
    """Key of a schedule entry or of an end of a leg: the halt id, or the square (waypoints, depots)."""
    if not isinstance(end, dict):
        return None
    halt = end.get("halt")
    if isinstance(halt, int) and not isinstance(halt, bool):
        return ("h", halt)
    pos = end.get("pos")
    if isinstance(pos, dict):
        pos = (pos.get("x"), pos.get("y"))
    if isinstance(pos, (list, tuple)) and len(pos) >= 2 and all(type(v) is int for v in pos[:2]):
        return ("p", pos[0], pos[1])
    return None


def route_stop(entry):
    """Schedule entry of `line` -> {"halt", "name", "pos": [x, y]} (+ "depot") for the route reply."""
    pos = entry.get("pos") if isinstance(entry, dict) else None
    out = {"halt": entry.get("halt") if isinstance(entry, dict) else None,
           "name": entry.get("name") if isinstance(entry, dict) else None,
           "pos": [pos.get("x"), pos.get("y")] if isinstance(pos, dict) else None}
    if isinstance(entry, dict) and entry.get("depot"):
        out["depot"] = True
    return out


class RouteCache:
    """The legs of line routes, merged over time. A convoy knows only the leg to its next stop, so
    `line_route id= all=1` gives the legs the convoys drive right now; every refresh adds the legs seen
    then, keyed by the halts (or squares) at their ends. Dropped when another world is loaded or the
    schedule counter of the game (poll.rev.schedules) changes."""

    CLAIM = 10.0  # seconds one request may take to refresh a line while others get the cached legs

    def __init__(self, refresh=ROUTE_REFRESH, max_lines=ROUTE_LINES):
        self.lock = threading.Lock()
        self.refresh = refresh
        self.max_lines = max_lines
        self.entries = collections.OrderedDict()  # line id -> {"keys","schedule","legs","fetched_at",...}
        self.stamp = None

    def clear(self):
        with self.lock:
            self.entries.clear()
            self.stamp = None

    def check_stamp(self, stamp):
        """stamp = (world gen, schedule counter); a different one drops every line."""
        with self.lock:
            if stamp != self.stamp:
                self.entries.clear()
                self.stamp = stamp

    def lookup(self, line_id, now):
        """Reply from the cache, or None when the caller refreshes the line (then merge() or release())."""
        with self.lock:
            e = self.entries.get(line_id)
            if e is None:
                return None
            self.entries.move_to_end(line_id)
            if now - e["fetched_at"] < self.refresh or now - e["claimed"] < self.CLAIM:
                return self.build(line_id, e)
            e["claimed"] = now
            return None

    def release(self, line_id):
        with self.lock:
            e = self.entries.get(line_id)
            if e is not None:
                e["claimed"] = 0.0

    def merge(self, line_id, line_reply, route_reply, now, stamp):
        """Add the legs of a `line_route all=1` reply; returns the merged reply."""
        sched = line_reply.get("schedule")
        sched = sched if isinstance(sched, list) else []
        keys = [route_key(s) for s in sched]
        wall = round(time.time(), 1)
        with self.lock:
            e = self.entries.get(line_id) if stamp == self.stamp else None
            if e is None or e["keys"] != keys:
                e = {"keys": keys, "legs": {}, "claimed": 0.0}
            e.update(schedule=[route_stop(s) for s in sched], fetched_at=now, wall=wall, claimed=0.0)
            for leg in route_reply.get("legs") or ():
                if not isinstance(leg, dict) or not isinstance(leg.get("points"), list):
                    continue
                k = (route_key(leg.get("from")), route_key(leg.get("to")))
                if None in k:
                    continue
                e["legs"][k] = {"convoy": leg.get("convoy"), "from": leg.get("from"), "to": leg.get("to"),
                                "length": leg.get("length"), "points": leg["points"], "seen": wall}
            if len(e["legs"]) > 4 * len(keys) + 32:
                # legs that belong to no schedule step (old schedules, trips to a depot): forget the oldest
                wanted = set(zip(keys, keys[1:] + keys[:1]))
                extra = sorted((v["seen"], k) for k, v in e["legs"].items() if k not in wanted)
                for _, k in extra[:len(e["legs"]) - 4 * len(keys) - 32]:
                    del e["legs"][k]
            if stamp == self.stamp:
                self.entries[line_id] = e
                self.entries.move_to_end(line_id)
                while len(self.entries) > self.max_lines:
                    self.entries.popitem(last=False)
            return self.build(line_id, e)

    @staticmethod
    def build(line_id, e):
        keys, n = e["keys"], len(e["keys"])
        legs, missing = [], []
        pairs = 0
        for i in range(n if n >= 2 else 0):
            j = (i + 1) % n
            a, b = keys[i], keys[j]
            if a is None or b is None or a == b:
                continue
            pairs += 1
            leg = e["legs"].get((a, b))
            if leg is None:
                missing.append([i, j])
            else:
                legs.append(dict(leg, from_index=i, to_index=j))
        return {"line": line_id, "merged": True, "legs": legs, "missing": missing, "stops": n, "pairs": pairs,
                "covered": pairs - len(missing), "complete": pairs > 0 and not missing,
                "schedule": e["schedule"], "fetched": e["wall"]}


# --- 3D view: caches and game connections ----------------------------------------------------------

def gzip_bytes(body):
    return gzip.compress(body, 6, mtime=0)


class Entry:
    """A cached reply: JSON bytes (with "ok"), their gzip form (None when not worth it), the ETag (content without
    t_us and rev, so a refetch of an unchanged chunk keeps it), the map gen it was made at and the cells it covers."""
    __slots__ = ("body", "gz", "etag", "rev", "checked", "cells", "at", "size")

    def __init__(self, reply, prefix, cells=(), etag=True):
        reply.pop("rid", None)
        reply["ok"] = True
        self.body = utf8(json_dumps(reply))
        gz = gzip_bytes(self.body) if len(self.body) >= GZIP_MIN else None
        self.gz = gz if gz is not None and len(gz) < len(self.body) else None
        self.etag = None
        if etag:
            content = {k: v for k, v in reply.items() if k not in ("t_us", "rev", "ok")}
            self.etag = '"%s-%s"' % (prefix, hashlib.sha1(utf8(json_dumps(content))).hexdigest()[:24])
        rev = reply.get("rev")
        self.rev = rev if type(rev) is int else None
        self.checked = self.rev  # map gen up to which the entry is known to be unchanged
        self.cells = tuple(cells)
        self.at = time.monotonic()
        self.size = len(self.body) + len(self.gz or b"")


class Flight:
    """One game request that concurrent requests for the same key wait for. check: the cached entry to verify
    (map_changes since=<its checked gen>) before fetching it again, or None."""
    __slots__ = ("done", "result", "epoch", "check")

    def __init__(self, epoch, check=None):
        self.done = threading.Event()
        self.result = None
        self.epoch = epoch
        self.check = check


class Store3D:
    """Replies of the 3D commands by key (LRU up to max_bytes) with single flight: requests for a key that is not
    cached share one game request. map_changes tells which cells changed in a window (since, gen] of map gens, not
    when: an entry made (or last checked) before `since` whose cell is reported is stale (with `grace`: only once it is
    that many seconds old), one made within the window is checked (one light map_changes since=<its gen>) by the poller
    at once or at its next request. Entries also expire after `max_age` seconds and with reset() (another world, a
    reconnect, a full map change)."""

    def __init__(self, max_bytes, max_age=None, grace=0.0):
        self.lock = threading.Lock()
        self.max_bytes, self.max_age, self.grace = max_bytes, max_age, grace
        self.entries = collections.OrderedDict()
        self.bytes = 0
        self.epoch = 0
        self.cell_gen = {}        # (cx, cy) of a CELL x CELL cell -> (since, gen) of its last reported change
        self.first_rev = None     # smallest rev of an entry since the last reset (map_changes since=)
        self.flights = {}
        self.requested = None     # time.monotonic() of the last request (the bridge follows the map changes)

    def reset(self):
        with self.lock:
            self.epoch += 1
            self.entries.clear()
            self.bytes = 0
            self.cell_gen.clear()
            self.first_rev = None
            self.flights.clear()

    def changed(self, since, gen, cells, exact=None):
        """map_changes reported `cells` for (since, gen]. exact: {g: cells changed after g} for the entries checked up
        to a gen g within that window (see ambiguous()): those whose cells did not change after g stay valid."""
        with self.lock:
            for c in cells:
                self.cell_gen[(c[0], c[1])] = (since, gen)
            if exact:
                for e in self.entries.values():
                    later = exact.get(e.checked)
                    if later is not None and later.isdisjoint(e.cells):
                        e.checked = max(e.checked, gen)

    def confirm(self, e, gen, later):
        """Result of the check of an entry: `later` = cells changed after e.checked up to gen. True if still valid."""
        with self.lock:
            if not later.isdisjoint(e.cells):
                return False
            e.checked = max(e.checked, gen)
            return True

    def ambiguous(self, since, gen, cells):
        """the gens up to which entries are known unchanged that lie in (since, gen) while a cell of them is reported:
        the reported change may or may not postdate them"""
        cells = set(cells)
        with self.lock:
            return {e.checked for e in self.entries.values() if e.rev is not None and since < e.checked < gen
                    and not cells.isdisjoint(e.cells)}

    def note_request(self):
        """True for the first request since the bridge stopped following the map changes."""
        now = time.monotonic()
        with self.lock:
            first = self.requested is None or now - self.requested > MAP_FOLLOW
            self.requested = now
            return first

    def following(self):
        with self.lock:
            return self.requested is not None and time.monotonic() - self.requested <= MAP_FOLLOW

    def since_gen(self):
        with self.lock:
            return self.first_rev

    def _state_locked(self, e, now):
        """"hit", "check" (a reported change may predate the entry) or "stale"."""
        if self.max_age is not None and now - e.at > self.max_age:
            return "stale"
        state = "hit"
        if e.rev is not None and self.cell_gen:
            for c in e.cells:
                since, gen = self.cell_gen.get(c, (0, -1))
                if gen > e.checked:
                    if since >= e.checked:  # changed after the entry for sure
                        return "hit" if now - e.at < self.grace else "stale"
                    state = "check"
        return "hit" if state == "check" and now - e.at < self.grace else state

    def acquire(self, key):
        """("hit", entry), ("wait", flight) while another request fetches or checks the key, or ("own", flight): the
        caller checks flight.check (if set) or fetches the key, and calls finish()."""
        now = time.monotonic()
        with self.lock:
            e = self.entries.get(key)
            state = self._state_locked(e, now) if e is not None else "stale"
            if state == "hit":
                self.entries.move_to_end(key)
                return "hit", e
            f = self.flights.get(key)
            if f is not None:
                return "wait", f
            f = self.flights[key] = Flight(self.epoch, e if state == "check" else None)
            return "own", f

    def finish(self, key, flight, result, entry=None):
        with self.lock:
            if entry is not None and flight.epoch == self.epoch:
                old = self.entries.pop(key, None)
                if old is not None:
                    self.bytes -= old.size
                self.entries[key] = entry
                self.bytes += entry.size
                if entry.rev is not None and (self.first_rev is None or entry.rev < self.first_rev):
                    self.first_rev = entry.rev
                while self.bytes > self.max_bytes and len(self.entries) > 1:
                    _, dropped = self.entries.popitem(last=False)
                    self.bytes -= dropped.size
            if self.flights.get(key) is flight:
                del self.flights[key]
        flight.result = result
        flight.done.set()


class EngineWorker(threading.Thread):
    """A game connection of its own with a FIFO of at most `depth` waiting requests, so that the heavy 3D requests
    (the game answers at most one per frame) delay neither the poller nor the other browser requests. The
    connection opens with the first request and closes after IDLE_3D seconds without one."""

    def __init__(self, name, port, depth, idle=IDLE_3D):
        super().__init__(name=name, daemon=True)
        self.conn = EngineConnection(port, timeout=WAIT_3D)
        self.depth = depth
        self.idle = idle
        self.cv = threading.Condition()
        self.jobs = collections.deque()
        self.stopped = False
        self.last = time.monotonic()

    def stop(self):
        with self.cv:
            self.stopped = True
            self.cv.notify_all()
        self.conn.close()

    def submit(self, command, args, timeout=WAIT_3D):
        """(HTTP status, reply dict): 200/400 as the game answered, 502 unreachable, 503 queue full or no answer
        in time."""
        job = {"command": command, "args": args, "done": threading.Event(), "result": None, "cancelled": False}
        with self.cv:
            if self.stopped:
                return 503, {"ok": False, "error": "the bridge is stopping"}
            if len(self.jobs) >= self.depth:
                return 503, {"ok": False, "error": "too many 3D requests are waiting for the game, retry later"}
            self.jobs.append(job)
            self.cv.notify()
        if not job["done"].wait(timeout):
            job["cancelled"] = True
            return 503, {"ok": False, "error": "the game did not answer the 3D request in time"}
        return job["result"]

    def run(self):
        while True:
            with self.cv:
                while not self.jobs and not self.stopped:
                    if self.conn.file is not None and time.monotonic() - self.last > self.idle:
                        self.conn.close()
                    self.cv.wait(min(self.idle, 30.0))
                if self.stopped:
                    return
                job = self.jobs.popleft()
            if job["cancelled"]:
                continue
            try:
                reply = self.conn.call(job["command"], **job["args"])
                result = ((200 if reply.get("ok") else 400), reply)
            except Unreachable as e:
                result = (502, {"ok": False, "error": str(e)})
            except Exception:
                log.exception("%s: request failed", self.name)
                self.conn.close()
                result = (500, {"ok": False, "error": "internal error"})
            self.last = time.monotonic()
            job["result"] = result
            job["done"].set()


class GzipCache:
    """gzip forms of static files by (path, mtime, size), b"" when compressing does not pay; LRU up to max_bytes."""

    def __init__(self, max_bytes=GZIP_CACHE_BYTES):
        self.lock = threading.Lock()
        self.max_bytes = max_bytes
        self.entries = collections.OrderedDict()
        self.bytes = 0

    def get(self, key):
        with self.lock:
            gz = self.entries.get(key)
            if gz is not None:
                self.entries.move_to_end(key)
            return gz

    def put(self, key, gz):
        with self.lock:
            old = self.entries.pop(key, None)
            if old is not None:
                self.bytes -= len(old)
            self.entries[key] = gz
            self.bytes += len(gz)
            while self.bytes > self.max_bytes and len(self.entries) > 1:
                _, dropped = self.entries.popitem(last=False)
                self.bytes -= len(dropped)


# --- shared state + SSE fan-out --------------------------------------------------------------

class SseClient:
    CLOSE = b""

    def __init__(self, sid):
        self.sid = sid
        self.queue = queue.Queue(maxsize=SSE_QUEUE)
        self.dead = False

    def push(self, chunk):
        try:
            self.queue.put_nowait(chunk)
        except queue.Full:
            self.dead = True  # too slow: dropped, the browser reconnects and resyncs


class Hub:
    """Cache of the polled game state, ring buffer of events and the SSE subscribers."""

    def __init__(self):
        self.lock = threading.Lock()
        # event ids start at the current time in ms, so ids of an earlier bridge process
        # are never mistaken for ids of this one (Last-Event-ID then gets a snapshot)
        self.seq = int(time.time() * 1000)
        self.ring = collections.deque()
        self.ring_bytes = 0
        self.clients = set()
        self.closed = False
        self.game_base = {"connected": False, "error": None, "missing": []}  # as the poller sees it
        self.events_live = False      # the event connection is subscribed
        self.events_missing = False   # the game has no protocol 2
        self.game = self._game_locked()
        self.tiles = TileCache()
        self.routes = RouteCache()
        self.map_export = None        # the game has palette/minimap/map_changes (None: not known yet)
        self.scenes = Store3D(SCENE_CACHE_BYTES)
        self.heights = Store3D(HEIGHTS_CACHE_BYTES, grace=HEIGHTS_REFRESH)
        self.descs = Store3D(DESC_CACHE_BYTES)
        self.vehicles = Store3D(VEH_CACHE_BYTES, max_age=VEH_CACHE)
        self._clear_locked()

    # -- map changes: the tiles and the 3D caches share the poller's map_changes (chunk=CELL)

    def map_following(self):
        return self.tiles.following() or self.scenes.following()

    def map_since(self):
        gens = [g for g in (self.tiles.since_gen(), self.scenes.since_gen(), self.heights.since_gen()) if g is not None]
        return min(gens) if gens else None

    def map_changed(self, since, gen, cells, exact=None):
        per = CHUNK // CELL
        self.tiles.changed(gen, [[x, y] for x, y in sorted({(c[0] // per, c[1] // per) for c in cells})])
        self.scenes.changed(since, gen, cells, exact)
        self.heights.changed(since, gen, cells, exact)

    def ambiguous_revs(self, since, gen, cells):
        return self.scenes.ambiguous(since, gen, cells) | self.heights.ambiguous(since, gen, cells)

    def map_reset(self):
        self.tiles.reset()
        self.scenes.reset()
        self.heights.reset()

    def reset_3d(self):
        for store in (self.scenes, self.heights, self.descs, self.vehicles):
            store.reset()

    def _clear_locked(self):
        self.routes.clear()
        self.feeds = dict.fromkeys(FEEDS)
        self.hashes = {}
        self.dirty_hash = set()  # feeds changed in place by events: hash them again before comparing
        self.positions = None  # {"cols", "states", "rows": {id: row}}
        self.messages = collections.deque(maxlen=100)
        self.messages_loaded = False
        self.msg_seq = 0  # seq of the newest message in self.messages
        # values from events or action replies: (time.monotonic(), value...), they win over a poll
        # or players reply that was requested before them
        self.overrides = {}

    def _publish(self, etype, data):
        self.seq += 1
        chunk = utf8("id: %d\nevent: %s\ndata: %s\n\n" % (self.seq, etype, data))
        self.ring.append((self.seq, chunk))
        self.ring_bytes += len(chunk)
        while len(self.ring) > RING_EVENTS or (self.ring_bytes > RING_BYTES and len(self.ring) > 1):
            self.ring_bytes -= len(self.ring.popleft()[1])
        for client in self.clients:
            client.push(chunk)

    def publish(self, etype, payload):
        with self.lock:
            self._publish(etype, json_dumps(payload))

    def clear(self):
        with self.lock:
            self._clear_locked()

    def _replace_locked(self, name, payload, publish=True):
        data = json_dumps(payload)
        digest = hashlib.sha1(utf8(data)).digest()
        if self.hashes.get(name) == digest and self.feeds.get(name) is not None:
            return False
        self.feeds[name] = payload
        self.hashes[name] = digest
        if publish:
            self._publish(name, data)
        return True

    def update_feed(self, name, payload, publish=True, fetched_at=None):
        """Store a full-replacement feed; publish it only when it changed. fetched_at: when the
        request was sent; newer values from events then replace the older ones of the reply."""
        payload.pop("ok", None)
        payload.pop("rid", None)
        if name in ("poll", "players"):
            # small feeds that events patch: compare and store under the lock
            with self.lock:
                if fetched_at is not None:
                    self._apply_overrides_locked(name, payload, fetched_at)
                return self._replace_locked(name, payload, publish)
        data = json_dumps(payload)
        digest = hashlib.sha1(utf8(data)).digest()
        with self.lock:
            if name in self.dirty_hash:
                self.dirty_hash.discard(name)
                cur = self.feeds.get(name)
                self.hashes[name] = None if cur is None else hashlib.sha1(utf8(json_dumps(cur))).digest()
            if self.hashes.get(name) == digest and self.feeds.get(name) is not None:
                return False
            self.feeds[name] = payload
            self.hashes[name] = digest
            if publish:
                self._publish(name, data)
        return True

    def _apply_overrides_locked(self, name, payload, fetched_at):
        def newer(key):
            o = self.overrides.get(key)
            return o if o is not None and o[0] > fetched_at else None
        if name == "poll":
            for k in STATUS_FIELDS:
                o = newer(k)
                if o:
                    payload[k] = o[1]
            pl = payload.get("player")
            o = newer(("cash", pl.get("nr"))) if isinstance(pl, dict) else None
            if o:
                payload["player"] = dict(pl, cash=o[1])
        else:
            items = payload.get("players")
            for i, p in enumerate(items if isinstance(items, list) else ()):
                o = newer(("cash", p.get("nr"))) if isinstance(p, dict) else None
                if o:
                    items[i] = dict(p, cash=o[1], net_wealth=o[2])

    def apply_status(self, fields):
        """Pause, fast forward or time multiplier from an event or an action reply: patch the cached
        poll and publish it at once. True when the event names another active player than the poll."""
        now = time.monotonic()
        with self.lock:
            for k in STATUS_FIELDS:
                if k in fields:
                    self.overrides[k] = (now, fields[k])
            poll = self.feeds.get("poll")
            if poll is None:
                return False
            new = dict(poll)
            for k in STATUS_FIELDS:
                if k in fields:
                    new[k] = fields[k]
            self._replace_locked("poll", new)
            pl = poll.get("player")
            return "player" in fields and fields["player"] != (pl.get("nr") if isinstance(pl, dict) else -1)

    def apply_cash(self, items):
        """cash events ({"player","cash","net_wealth"}): patch the cached poll and players, publish."""
        now = time.monotonic()
        with self.lock:
            cash = {}
            for d in items:
                nr = d.get("player")
                if isinstance(nr, int):
                    cash[nr] = (now, d.get("cash"), d.get("net_wealth"))
            self.overrides.update((("cash", nr), v) for nr, v in cash.items())
            poll = self.feeds.get("poll")
            pl = poll.get("player") if poll else None
            if isinstance(pl, dict) and pl.get("nr") in cash:
                self._replace_locked("poll", dict(poll, player=dict(pl, cash=cash[pl["nr"]][1])))
            players = self.feeds.get("players")
            lst = players.get("players") if players else None
            if isinstance(lst, list):
                new = [dict(p, cash=cash[p["nr"]][1], net_wealth=cash[p["nr"]][2])
                       if isinstance(p, dict) and p.get("nr") in cash else p for p in lst]
                self._replace_locked("players", dict(players, players=new))

    def apply_convoy_states(self, data):
        """convoys event: publish it as convoy_states and keep the cached convoy list up to date."""
        changes = data.get("changes") or []
        names = data.get("states") or []
        with self.lock:
            conv = self.feeds.get("convoys")
            items = conv.get("convoys") if conv else None
            if changes and isinstance(items, list):
                index = {c.get("id"): i for i, c in enumerate(items) if isinstance(c, dict)}
                for ch in changes:
                    i = index.get(ch[0]) if isinstance(ch, list) and len(ch) >= 2 else None
                    if i is not None and isinstance(ch[1], int) and 0 <= ch[1] < len(names):
                        items[i] = dict(items[i], state=names[ch[1]])
                        self.dirty_hash.add("convoys")
            self._publish("convoy_states", json_dumps({"changes": changes, "added": data.get("added") or [],
                                                       "removed": data.get("removed") or [], "states": names}))

    def update_positions(self, reply, publish=True):
        cols, states = reply.get("cols") or [], reply.get("states") or []
        rows = {}
        for row in reply.get("rows") or []:
            if row:
                rows[row[0]] = row
        old = self.positions  # only the poller thread replaces it
        full = old is None or old["cols"] != cols or old["states"] != states
        if full:
            changed, deleted = list(rows.values()), []
        else:
            orows = old["rows"]
            changed = [row for rid, row in rows.items() if orows.get(rid) != row]
            deleted = [rid for rid in orows if rid not in rows]
        with self.lock:
            self.positions = {"cols": cols, "states": states, "rows": rows}
            if publish and (full or changed or deleted):
                self._publish("positions", json_dumps({"full": full, "cols": cols, "states": states,
                                                       "rows": changed, "del": deleted}))

    def clear_positions(self):
        with self.lock:
            self.positions = None

    def set_messages(self, items, reset, publish=True, truncated=False, newest=None):
        """Messages of a `messages` reply (oldest first); without reset only those newer than the
        newest known one (events may have brought some already). newest: seq of the reply."""
        with self.lock:
            if reset:
                self.messages.clear()
                self.msg_seq = 0
            else:
                items = [m for m in items if not isinstance(m.get("seq"), int) or m["seq"] > self.msg_seq]
            self.messages.extend(items)
            seqs = [m["seq"] for m in items if isinstance(m.get("seq"), int)]
            if isinstance(newest, int):
                seqs.append(newest)
            self.msg_seq = max([self.msg_seq] + seqs)
            self.messages_loaded = True
            if publish and (items or reset):
                self._publish("messages", json_dumps({"messages": items, "reset": bool(reset),
                                                      "truncated": bool(truncated)}))

    def add_event_messages(self, items):
        """Messages from events, oldest first. Appends those that follow the newest known message
        and publishes them; True when one is missing in between (fetch `messages since` then)."""
        fresh = []
        gap = False
        with self.lock:
            for m in items:
                seq = m.get("seq") if isinstance(m, dict) else None
                if not self.messages_loaded or not isinstance(seq, int):
                    gap = True
                elif seq == self.msg_seq + 1:
                    self.msg_seq = seq
                    fresh.append(m)
                elif seq > self.msg_seq:
                    gap = True  # comes with the fetch, like the missing ones
            if fresh:
                self.messages.extend(fresh)
                self._publish("messages", json_dumps({"messages": fresh, "reset": False, "truncated": False}))
        return gap

    def known_msg_seq(self):
        with self.lock:
            return self.msg_seq

    def _game_locked(self):
        missing = set(self.game_base["missing"])
        if self.events_missing:
            missing.add("events")
        return {"connected": self.game_base["connected"], "error": self.game_base["error"],
                "missing": sorted(missing), "events": self.events_live}

    def _update_game_locked(self):
        new = self._game_locked()
        if new != self.game:
            self.game = new
            self._publish("game", json_dumps(new))

    def set_game(self, connected, error, missing):
        with self.lock:
            self.game_base = {"connected": bool(connected), "error": error, "missing": list(missing)}
            self._update_game_locked()

    def set_events(self, live=None, missing=None):
        with self.lock:
            if live is not None:
                self.events_live = bool(live)
            if missing is not None:
                self.events_missing = bool(missing)
            self._update_game_locked()

    def game_state(self):
        with self.lock:
            return dict(self.game)

    def world_size(self):
        """(size_x, size_y) of the world from the cached poll, or None."""
        with self.lock:
            w = (self.feeds.get("poll") or {}).get("world") or {}
            sx, sy = w.get("size_x"), w.get("size_y")
            return (sx, sy) if isinstance(sx, int) and isinstance(sy, int) and sx > 0 and sy > 0 else None

    def status_stamp(self):
        """(world gen, size, date) of the cached poll: the factory status is valid for one stamp."""
        with self.lock:
            poll = self.feeds.get("poll") or {}
            w = poll.get("world") or {}
            date = poll.get("date") or {}
            return (w.get("gen"), w.get("size_x"), w.get("size_y"), date.get("year"), date.get("month"))

    def factory_positions(self):
        """[(x, y)] of the cached factories feed, or None when it is not known."""
        with self.lock:
            fac = self.feeds.get("factories")
            items = fac.get("factories") if isinstance(fac, dict) else None
            if not isinstance(items, list):
                return None
            out = []
            for f in items:
                p = f.get("pos") if isinstance(f, dict) else None
                if isinstance(p, dict) and isinstance(p.get("x"), int) and isinstance(p.get("y"), int):
                    out.append((p["x"], p["y"]))
            return out

    def route_stamp(self):
        """(world gen, schedule counter) of the cached poll: the route cache is valid for one stamp."""
        with self.lock:
            poll = self.feeds.get("poll") or {}
            return ((poll.get("world") or {}).get("gen"), (poll.get("rev") or {}).get("schedules"))

    def reset_world(self, gen):
        with self.lock:
            self._clear_locked()
            self._publish("world", json_dumps({"gen": gen}))

    def _snapshot_locked(self):
        pos = self.positions
        snap = {k: self.feeds.get(k) for k in FEEDS}
        snap["positions"] = None if pos is None else {
            "full": True, "cols": pos["cols"], "states": pos["states"],
            "rows": list(pos["rows"].values()), "del": []}
        snap["messages"] = list(self.messages) if self.messages_loaded else None
        snap["game"] = dict(self.game)
        return snap

    def publish_snapshot(self):
        with self.lock:
            self._publish("snapshot", json_dumps(self._snapshot_locked()))

    def subscribe(self, sid, last_id):
        """Register a stream. Returns (client, event id, replay chunks or None, snapshot or None);
        None as client when too many streams are open."""
        with self.lock:
            if self.closed or len(self.clients) >= MAX_SSE:
                return None, 0, None, None
            client = SseClient(sid)
            self.clients.add(client)
            replay = None
            if last_id is not None and last_id <= self.seq:
                if last_id == self.seq:
                    replay = []
                elif self.ring and self.ring[0][0] <= last_id + 1:
                    replay = [chunk for eid, chunk in self.ring if eid > last_id]
            snapshot = self._snapshot_locked() if replay is None else None
            return client, self.seq, replay, snapshot

    def unsubscribe(self, client):
        with self.lock:
            self.clients.discard(client)

    def stream_count(self):
        with self.lock:
            return len(self.clients)

    def close(self):
        with self.lock:
            self.closed = True
            for client in self.clients:
                client.dead = True
                client.push(SseClient.CLOSE)

    def close_session(self, sid):
        """End the event streams of a session (signed out or replaced by a new sign-in)."""
        with self.lock:
            for client in self.clients:
                if client.sid == sid:
                    client.dead = True
                    client.push(SseClient.CLOSE)


# --- poller ------------------------------------------------------------------------------------

def poll_from_status(st):
    """poll-shaped dict from `status`, for engines without the poll command."""
    w = st.get("world") or {}
    pl = st.get("player") or {}
    return {
        "ticks": w.get("ticks"), "date": w.get("date"), "month_progress": None, "ticks_per_month": None,
        "paused": w.get("paused"), "ff": w.get("fast_forward"), "mult": w.get("time_multiplier"),
        "player": {"nr": pl["nr"], "name": pl.get("name"), "cash": pl.get("cash")} if "nr" in pl else None,
        "msg_seq": None,
        "counts": {"convoys": w.get("convoys"), "lines": None, "halts": None, "factories": None,
                   "cities": w.get("cities"), "players": None},
        "rev": None,
        "world": {"gen": None, "size_x": w.get("size_x"), "size_y": w.get("size_y"),
                  "rotation": w.get("rotation")},
        "source": "status",
    }


def to_summary(cmd, reply):
    """Give a list reply of an engine without paging the shape of `limit=0 fields=summary`."""
    items = reply.get(cmd) or []
    if cmd == "stations":
        items = [{k: it.get(k) for k in ("id", "name", "owner", "pos")} for it in items]
    elif cmd == "convoys":
        items = [{"id": it.get("id"), "name": it.get("name"), "owner": it.get("owner"), "pos": it.get("pos"),
                  "line": (it.get("line") or {}).get("id", 0), "state": it.get("state")} for it in items]
    elif cmd == "lines":
        items = [{k: it.get(k) for k in ("id", "name", "owner", "convoys")} for it in items]
    reply[cmd] = items
    reply.update(total=len(items), offset=0, truncated=False)


class Poller(threading.Thread):
    TASKS = ("poll", "palette", "map", "positions", "messages", "players", "convoys", "lines", "stations",
             "factories", "cities", "goods", "supply_chain")

    def __init__(self, hub, port, intervals, min_gap, event_intervals=None):
        super().__init__(name="poller", daemon=True)
        self.hub = hub
        self.conn = EngineConnection(port, timeout=60)
        self.poll_intervals = intervals
        self.event_intervals = event_intervals or intervals
        self.intervals = intervals  # the set in use: event_intervals while events are live
        self.min_gap = min_gap
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.conn_generation = 0
        self.need_full = True
        self.lost_reported = None
        # requests of the event subscriber (other thread), taken by take_requests()
        self.ext_lock = threading.Lock()
        self.ext_tasks = set()
        self.ext_world = None
        self.ext_live = False
        self.live = False
        self.reset_state()

    def stop(self):
        self.stop_event.set()
        self.wake.set()
        self.conn.close()

    def reset_state(self):
        self.caps = {"poll": None, "positions": None, "since": None, "map_export": None, "goods": None,
                     "supply_chain": None, "3d": None}
        self.hub.map_export = None
        self.map_gen = None   # map gen of the last map_changes (None: not following the map yet)
        self.rev_map = None   # poll.rev.map seen last
        self.paging = {}
        self.missing = set()
        self.poll_msg_seq = None
        self.msg_behind = None
        self.force_messages = False
        self.fallback_keys = []
        self.fallback_seq = 0
        self.world = None
        self.logged = set()
        now = time.monotonic()
        self.due = dict.fromkeys(self.TASKS, now)
        self.last_run = dict.fromkeys(self.TASKS, 0.0)

    # -- requests of the event subscriber (called from its thread)

    def request(self, *tasks):
        """Run these tasks soon (respecting the minimal gaps); "messages" also when the poll
        says nothing is new."""
        with self.ext_lock:
            self.ext_tasks.update(tasks)
        self.wake.set()

    def request_world(self, gen):
        """The game loaded or created a world with this gen: start over unless done already."""
        with self.ext_lock:
            self.ext_world = gen
        self.wake.set()

    def set_events_live(self, live):
        with self.ext_lock:
            self.ext_live = bool(live)
        self.wake.set()

    def take_requests(self):
        with self.ext_lock:
            tasks, world, live = self.ext_tasks, self.ext_world, self.ext_live
            self.ext_tasks, self.ext_world = set(), None
        if live != self.live:
            self.live = live
            self.intervals = self.event_intervals if live else self.poll_intervals
            for task in self.TASKS:
                self.due[task] = min(self.due[task], self.last_run[task] + self.intervals[task])
        if world is not None and self.world is not None and not self.need_full and world != self.world["gen"]:
            log.info("another world was loaded (gen %s), refetching everything", world)
            self.hub.reset_world(world)
            self.need_full = True
            return
        if "messages" in tasks:
            self.force_messages = True
        for task in tasks:
            self.trigger(task)

    # -- main loop

    def run(self):
        backoff = 1.0
        while not self.stop_event.is_set():
            try:
                if self.conn.file is None:
                    self.conn.connect()
                if self.conn.generation != self.conn_generation:
                    self.conn_generation = self.conn.generation
                    log.info("connected to the game on port %d", self.conn.port)
                    self.reset_state()
                    self.need_full = True
                    # maybe another engine: the subscriber checks protocol 2 again
                    self.hub.set_events(missing=False)
                self.take_requests()
                if self.need_full:
                    self.full_refresh()
                else:
                    self.cycle()
                self.hub.set_game(True, None, sorted(self.missing))
                self.lost_reported = None
                backoff = 1.0
            except Reconnected:
                continue
            except (GameError, Unreachable) as e:
                self.conn.close()
                self.lost(str(e))
                self.stop_event.wait(backoff)
                backoff = min(backoff * 2, 10.0)
                continue
            except EngineFail as e:
                if self.lost_reported != str(e):
                    log.warning("the game refuses to answer: %s", e)
                    self.lost_reported = str(e)
                self.hub.set_game(True, str(e), sorted(self.missing))
                self.need_full = True
                self.stop_event.wait(1.0)
                continue
            except Exception:
                log.exception("poller failed")
                self.conn.close()
                self.lost("bridge error, see the bridge log")
                self.stop_event.wait(backoff)
                backoff = min(backoff * 2, 10.0)
                continue
            # requests that arrive after wait() returned stay in ext_tasks for the next round
            self.wake.wait(self.sleep_time())
            self.wake.clear()

    def lost(self, error):
        if self.stop_event.is_set():
            return
        if self.lost_reported != error:
            log.warning("game connection: %s", error)
            self.lost_reported = error
        self.hub.set_game(False, error, sorted(self.missing))

    def sleep_time(self):
        if self.need_full:
            return 0
        return max(0.01, min(self.due.values()) - time.monotonic())

    def call(self, command, **args):
        reply = self.conn.call(command, **args)
        if self.conn.generation != self.conn_generation:
            raise Reconnected()
        return reply

    def log_once(self, key, error):
        if (key, error) not in self.logged:
            self.logged.add((key, error))
            log.warning("%s: %s", key, error)

    def add_missing(self, name, what):
        if name not in self.missing:
            self.missing.add(name)
            log.info("the game has no %s, %s", name, what)

    def trigger(self, task):
        now = time.monotonic()
        self.due[task] = min(self.due[task], max(now, self.last_run[task] + self.min_gap[task]))

    def full_refresh(self):
        """Fetch every feed without publishing, then publish one snapshot."""
        self.hub.clear()
        self.hub.tiles.reset()  # the browsers load all tiles again after the snapshot
        self.hub.reset_3d()
        self.map_gen = None
        self.fallback_keys = []
        self.world = None
        self.msg_behind = None
        self.force_messages = False
        t0 = time.monotonic()
        poll = self.fetch_poll()
        self.note_world(poll)
        self.hub.update_feed("poll", poll, publish=False, fetched_at=t0)
        for task in self.TASKS[1:]:
            self.run_task(task, publish=False)
        self.probe_3d()
        self.need_full = False
        self.hub.set_game(True, None, sorted(self.missing))
        self.hub.publish_snapshot()
        now = time.monotonic()
        for task in self.TASKS:
            self.last_run[task] = now
            self.due[task] = now + self.intervals[task]

    def cycle(self):
        now = time.monotonic()
        for task in self.TASKS:
            if self.need_full or self.stop_event.is_set():
                return
            if self.due[task] <= now:
                self.run_task(task, publish=True)
                done = time.monotonic()
                self.last_run[task] = done
                self.due[task] = done + self.intervals[task]

    def run_task(self, task, publish):
        if task == "poll":
            self.task_poll()
        elif task == "palette":
            self.task_palette(publish)
        elif task == "map":
            self.task_map()
        elif task == "positions":
            self.task_positions(publish)
        elif task == "messages":
            self.task_messages(publish)
        elif task in DETAIL_FEEDS:
            self.task_detail_feed(task, publish)
        elif task == "players":
            t0 = time.monotonic()
            reply = self.call("players")
            if reply["ok"]:
                self.hub.update_feed("players", reply, publish, fetched_at=t0)
            else:
                self.log_once("players", reply["error"])
        else:
            self.task_list(task, publish)

    # -- tasks

    def fetch_poll(self):
        if self.caps["poll"] is not False:
            reply = self.call("poll")
            if reply["ok"]:
                self.caps["poll"] = True
                return reply
            if not is_unknown_command(reply):
                raise EngineFail(reply["error"])
            self.caps["poll"] = False
            self.add_missing("poll", "deriving it from status")
        reply = self.call("status")
        if not reply["ok"]:
            raise EngineFail(reply["error"])
        return poll_from_status(reply)

    def note_world(self, poll):
        """Remember the world identity; True when another world was loaded."""
        w = poll.get("world") or {}
        cur = {"gen": w.get("gen"), "size": (w.get("size_x"), w.get("size_y")), "ticks": poll.get("ticks"),
               "date": poll.get("date"), "rev": (poll.get("rev") or {}).get("objects")}
        self.poll_msg_seq = poll.get("msg_seq")
        old, self.world = self.world, cur
        if old is None:
            return False
        if cur["gen"] is not None and old["gen"] is not None:
            changed = cur["gen"] != old["gen"]
        else:
            changed = cur["size"] != old["size"] or (
                isinstance(cur["ticks"], int) and isinstance(old["ticks"], int) and cur["ticks"] < old["ticks"])
        if not changed:
            if cur["date"] != old["date"]:
                self.hub.tiles.new_month(cur["date"])
                self.new_month()
                if not self.live and isinstance(cur["date"], dict) and isinstance(old["date"], dict):
                    # with events the month event of the game is passed on instead
                    self.hub.publish("month", {"date": cur["date"],
                                               "year_changed": cur["date"].get("year") != old["date"].get("year")})
            if cur["rev"] != old["rev"]:
                for task in ("convoys", "lines", "stations"):
                    self.trigger(task)
        return changed

    def new_month(self):
        for task in ("players", "lines", "convoys", "cities", "factories", "palette", "goods", "supply_chain"):
            self.trigger(task)

    def task_poll(self):
        t0 = time.monotonic()
        poll = self.fetch_poll()
        if self.note_world(poll):
            gen = (poll.get("world") or {}).get("gen")
            log.info("another world was loaded (gen %s), refetching everything", gen)
            self.hub.reset_world(gen)
            self.need_full = True
            return
        self.hub.update_feed("poll", poll, True, fetched_at=t0)
        rev = (poll.get("rev") or {}).get("map")
        if rev != self.rev_map:
            self.rev_map = rev
            if self.caps["map_export"] and rev != self.map_gen and self.hub.map_following():
                self.trigger("map")
        seq, known = self.poll_msg_seq, self.hub.known_msg_seq()
        behind = seq is not None and seq != known
        # with events a message the poll already counts may still be on its way: fetch only when
        # the messages counted by the previous poll have not arrived yet
        if behind and (not self.live or (self.msg_behind is not None and known < self.msg_behind)):
            self.trigger("messages")
        self.msg_behind = seq if behind else None

    def task_positions(self, publish):
        if self.caps["positions"] is False:
            return
        reply = self.call("positions")
        if not reply["ok"]:
            if is_unknown_command(reply):
                self.caps["positions"] = False
                self.add_missing("positions", "no live convoy positions")
                self.hub.clear_positions()
            else:
                self.log_once("positions", reply["error"])
            return
        self.caps["positions"] = True
        self.hub.update_positions(reply, publish)

    def task_palette(self, publish):
        """palette (colours of the minimap, players); also finds out whether the game has the map export."""
        if self.caps["map_export"] is False:
            return
        reply = self.call("palette")
        if not reply["ok"]:
            if is_unknown_command(reply):
                self.caps["map_export"] = False
                self.hub.map_export = False
                self.add_missing("map_export", "the browsers draw the map from map grids")
            else:
                self.log_once("palette", reply["error"])
            return
        colors = palette_colors(reply)
        if colors is None:
            self.log_once("palette", "invalid colours")
            return
        self.caps["map_export"] = True
        self.hub.map_export = True
        self.hub.tiles.set_colors(colors)
        self.hub.update_feed("palette", reply, publish)

    def task_map(self):
        """Follow the map changes (only while browsers request tiles or 3D chunks) in cells of CELL x CELL squares,
        update the caches and tell the browsers what to load again: SSE map_changes {gen, full, chunks (CHUNK x
        CHUNK, the tiles), cells (CELL x CELL, the scene3d chunks), world_gen}."""
        hub = self.hub
        if not self.caps["map_export"] or not hub.map_following():
            return
        since = self.map_gen if self.map_gen is not None else hub.map_since()
        if since is None:
            return  # nothing fetched since the last reset: nothing to compare with
        reply = self.call("map_changes", since=since, chunk=CELL)
        if not reply["ok"]:
            self.log_once("map_changes", reply["error"])
            return
        gen = reply.get("gen")
        if not isinstance(gen, int):
            return
        full = bool(reply.get("full"))
        size = reply.get("chunk") if reply.get("chunk") in (CELL, 128, 256, 512, 1024, 2048, 4096) else CELL
        per = size // CELL
        cells = set()
        for c in reply.get("chunks") or ():
            if isinstance(c, list) and len(c) == 2 and all(type(v) is int and 0 <= v < 65536 for v in c):
                cells.update((c[0] * per + i, c[1] * per + j) for i in range(per) for j in range(per))
        self.map_gen = gen
        if full:
            hub.map_reset()
        elif cells:
            hub.map_changed(since, gen, cells, self.exact_changes(since, gen, cells))
        else:
            return
        cells = sorted(cells)
        chunks = sorted({(x // (CHUNK // CELL), y // (CHUNK // CELL)) for x, y in cells})
        hub.publish("map_changes", {"gen": gen, "full": full, "chunks": [] if full else [list(c) for c in chunks],
                                    "cells": [] if full else [list(c) for c in cells],
                                    "world_gen": reply.get("world_gen")})

    def exact_changes(self, since, gen, cells):
        """{g: cells changed after g} for the cached 3D replies made (or last checked, at g) between since and gen whose
        cells were reported: the change may predate them. Typical after the start of the game's change tracking, which
        reports every cell once while it takes its colours (some 250 on the NYC map within 0.3 s). One light
        map_changes per g, pipelined; beyond VERIFY_REVS the entries are checked at their next request instead."""
        revs = sorted(self.hub.ambiguous_revs(since, gen, cells))
        if not revs or len(revs) > VERIFY_REVS:
            return None
        replies = self.conn.call_many([("map_changes", {"since": r, "chunk": CELL}) for r in revs])
        if self.conn.generation != self.conn_generation:
            raise Reconnected()
        exact = {}
        for r, reply in zip(revs, replies):
            if reply.get("ok") and not reply.get("full") and reply.get("chunk") == CELL:
                exact[r] = {(c[0], c[1]) for c in reply.get("chunks") or () if isinstance(c, list) and len(c) == 2}
        return exact

    def probe_3d(self):
        """Whether the game has the 3D export (once per connection): a vehicles3d of one square is cheap."""
        if self.caps["3d"] is not None:
            return
        reply = self.call("vehicles3d", x1=0, y1=0, x2=0, y2=0)
        if is_unknown_command(reply):
            self.caps["3d"] = False
            self.add_missing("3d", "no 3D view")
        else:
            self.caps["3d"] = True

    def task_detail_feed(self, cmd, publish):
        """goods (once per world, then rarely) and supply_chain (every minute and at a new month): the
        browsers get them in the snapshot and as events; engines without them keep the feed null."""
        if self.caps[cmd] is False:
            return
        reply = self.call(cmd)
        if not reply["ok"]:
            if is_unknown_command(reply):
                self.caps[cmd] = False
                log.info("the game has no %s command", cmd)
            else:
                self.log_once(cmd, reply["error"])
            return
        self.caps[cmd] = True
        self.hub.update_feed(cmd, reply, publish)

    def task_messages(self, publish):
        force, self.force_messages = self.force_messages, False
        known = self.hub.known_msg_seq()
        if (publish and not force and self.caps["since"] and self.poll_msg_seq is not None
                and self.poll_msg_seq == known):
            return  # poll says there is nothing new
        reply = None
        if self.caps["since"] is not False:
            reply = self.call("messages", since=known, count=100)
            if not reply["ok"]:
                self.log_once("messages", reply["error"])
                return
            if "seq" in reply:
                self.caps["since"] = True
                reset = bool(reply.get("reset")) or not publish
                self.hub.set_messages(reply.get("messages") or [], reset, publish, reply.get("truncated"),
                                      newest=reply["seq"])
                return
            self.caps["since"] = False
            self.add_missing("messages_since", "comparing message lists")
        if reply is None:
            reply = self.call("messages", count=100)
            if not reply["ok"]:
                self.log_once("messages", reply["error"])
                return
        self.fallback_messages(reply.get("messages") or [], publish)

    def fallback_messages(self, newest_first, publish):
        """Engines without `messages since`: find the new messages by aligning the lists."""
        items = list(reversed(newest_first))
        keys = [json.dumps(m, sort_keys=True) for m in items]
        old = self.fallback_keys
        if publish and keys == old:
            return
        start = None
        if publish and old:
            for new_count in range(len(keys)):
                m = len(keys) - new_count
                if m <= len(old) and keys[:m] == old[len(old) - m:]:
                    start = m
                    break
        reset = start is None
        self.fallback_keys = keys
        fresh = items if reset else items[start:]
        for msg in fresh:
            self.fallback_seq += 1
            msg["seq"] = self.fallback_seq
            t = msg.get("type")
            if "type_name" not in msg and isinstance(t, int):
                msg["type_name"] = MESSAGE_TYPES[t] if 0 <= t < len(MESSAGE_TYPES) else str(t)
        self.hub.set_messages(fresh, reset, publish)

    def task_list(self, cmd, publish):
        paged = self.paging.get(cmd)
        if paged is False:
            reply = self.call(cmd, limit=UNLIMITED)
        else:
            args = {"limit": 0}
            if cmd in SUMMARY_FEEDS:
                args["fields"] = "summary"
            reply = self.call(cmd, **args)
            if reply["ok"] and paged is None:
                if "total" in reply:
                    self.paging[cmd] = True
                else:
                    # older engine: limit=0 means nothing, no paging, no summaries
                    self.paging[cmd] = False
                    if cmd in SUMMARY_FEEDS:
                        self.add_missing("paging", "fetching full lists")
                    reply = self.call(cmd, limit=UNLIMITED)
        if not reply["ok"]:
            self.log_once(cmd, reply["error"])
            return
        if self.paging.get(cmd) is False:
            to_summary(cmd, reply)
        self.hub.update_feed(cmd, reply, publish)


# --- events (protocol 2) ---------------------------------------------------------------------

class NoProtocol2(Exception):
    """The game speaks only protocol 1 (an engine without events)."""


class Subscriber(threading.Thread):
    """Own game connection with protocol 2 that subscribes the events of the game. Event lines go to
    the hub at once (messages, status, cash, convoy states, arrivals) or make the poller fetch
    something (month, world, overflow). Without protocol 2 nothing changes: the poller polls."""

    HELLO = b"HELLO simutrans-remote %d\n"
    REPROBE = 300  # seconds between protocol 2 checks of a game without it (also on a reconnect)

    def __init__(self, hub, poller, port, interval_ms=EVENT_INTERVAL_MS, arrivals_gap=ARRIVALS_GAP):
        super().__init__(name="events", daemon=True)
        self.hub = hub
        self.poller = poller
        self.port = port
        self.interval_ms = interval_ms
        self.arrivals_gap = arrivals_gap
        self.stop_event = threading.Event()
        self.sock = None
        self.buf = b""
        self.live = False
        self.arrivals = []
        self.arrivals_dropped = 0
        self.arrivals_sent = 0.0
        self.logged = None

    def stop(self):
        self.stop_event.set()
        self.close()

    def close(self):
        sock, self.sock = self.sock, None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
        self.buf = b""

    def log_state(self, level, text, *args):
        key = text % args
        if key != self.logged:
            self.logged = key
            log.log(level, "events: " + text, *args)

    # -- line I/O with a buffer of its own (socket timeouts would break makefile readers)

    def connect(self, protocol):
        self.close()
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.sock.sendall(self.HELLO % protocol)
        line = self.read_line(10)
        if line is None:
            self.close()
            return None
        return json.loads(line)

    def read_line(self, timeout):
        """One line (bytes, without the line end), b"" on timeout, None when the game closed."""
        end = time.monotonic() + timeout
        while b"\n" not in self.buf:
            left = end - time.monotonic()
            if left <= 0 or self.stop_event.is_set():
                return b""
            self.sock.settimeout(left)  # stop() closes the socket, which ends the wait
            try:
                data = self.sock.recv(65536)
            except socket.timeout:
                continue
            if not data:
                return None
            self.buf += data
        line, self.buf = self.buf.split(b"\n", 1)
        return line

    def read_lines(self, timeout):
        """All complete lines that arrive within timeout (at least one wait); None when closed."""
        line = self.read_line(timeout)
        if line is None:
            return None
        lines = [line] if line else []
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            lines.append(line)
        return lines

    # -- main loop

    def run(self):
        backoff = 1.0
        unsupported_at = None  # (time, poller connection generation) of the last failed check
        while not self.stop_event.is_set():
            if unsupported_at is not None:
                t, gen = unsupported_at
                if gen == self.poller.conn.generation and time.monotonic() - t < self.REPROBE:
                    self.stop_event.wait(1.0)
                    continue
                unsupported_at = None
            try:
                self.session()
                backoff = 1.0
            except NoProtocol2:
                unsupported_at = (time.monotonic(), self.poller.conn.generation)
                self.hub.set_events(live=False, missing=True)
                self.log_state(logging.INFO, "the game has no protocol 2, polling only")
                continue
            except (OSError, ValueError) as e:
                if self.live:
                    backoff = 1.0
                self.log_state(logging.INFO, "no event connection (%s), polling", str(e) or type(e).__name__)
            except Exception:
                # e.g. an event of an unexpected shape: keep the thread, connect again
                log.exception("events: subscriber failed")
            finally:
                self.set_live(False)
                self.close()
            self.stop_event.wait(backoff)
            backoff = min(backoff * 2, 10.0)

    def set_live(self, live):
        if live == self.live:
            return
        self.live = live
        self.arrivals, self.arrivals_dropped = [], 0
        self.hub.set_events(live=live, missing=False if live else None)
        self.poller.set_events_live(live)

    def session(self):
        hello = self.connect(2)
        if hello is None:
            # older engines close the connection on a greeting they do not know; check protocol 1,
            # and protocol 2 once more in case the game was only full (8 connections)
            hello1 = self.connect(1)
            self.close()
            if hello1 is not None and hello1.get("ok"):
                hello = self.connect(2)
                if hello is None:
                    raise NoProtocol2()
            if hello is None:
                raise OSError("the game closed the connection")
        if not hello.get("ok") or hello.get("protocol", 1) < 2:
            raise NoProtocol2()
        self.sock.sendall(("subscribe " + urllib.parse.urlencode(
            {"topics": EVENT_TOPICS, "interval": self.interval_ms}, safe=",") + "\n").encode())
        while True:
            line = self.read_line(30)
            if line is None:
                raise OSError("the game closed the connection")
            if not line:
                raise OSError("no answer to subscribe")
            reply = json.loads(line)
            if "ok" in reply:
                break
        if not reply.get("ok"):
            error = str(reply.get("error"))
            if "protocol" in error:
                raise NoProtocol2()
            raise OSError("subscribe refused: " + error)
        self.log_state(logging.INFO, "subscribed (%s, every %d ms)", ",".join(reply.get("topics") or ()),
                       reply.get("interval") or self.interval_ms)
        self.set_live(True)
        # events start now: fetch what may have changed since the last poll
        self.poller.request("messages", "poll", "players")
        while not self.stop_event.is_set():
            # wake up only for event lines, or when collected arrivals are due
            wait = 5.0
            if self.arrivals or self.arrivals_dropped:
                wait = max(0.02, self.arrivals_sent + self.arrivals_gap - time.monotonic())
            lines = self.read_lines(wait)
            if lines is None:
                raise OSError("the game closed the event connection")
            if lines:
                self.handle(lines)
            self.flush_arrivals(False)

    # -- events

    def handle(self, lines):
        messages, cash = [], []
        for raw in lines:
            try:
                ev = json.loads(raw)
            except ValueError:
                log.warning("events: invalid line from the game: %r", raw[:200])
                continue
            kind = ev.get("event") if isinstance(ev, dict) else None
            if kind is None:
                continue  # a reply; this connection sends no requests after subscribe
            data = ev.get("data")
            if not isinstance(data, dict):
                data = {}
            if kind == "messages":
                messages.append(data)
                continue
            if kind == "cash":
                cash.append(data)
                continue
            if messages:  # keep the order of messages and world events
                self.on_messages(messages)
                messages = []
            if kind == "status":
                if self.hub.apply_status(data):
                    self.poller.request("poll", "players")  # another active player: name and cash
            elif kind == "month":
                date = data.get("date") or ev.get("date")
                self.hub.tiles.new_month(date)  # before the browsers hear of it and reload tiles
                self.hub.publish("month", {"date": date, "year_changed": bool(data.get("year_changed"))})
                self.poller.request("players", "lines", "convoys", "cities", "factories", "palette", "goods",
                                    "supply_chain")
            elif kind == "world":
                self.arrivals, self.arrivals_dropped = [], 0
                if data.get("event") in ("loaded", "created") and isinstance(data.get("gen"), int):
                    self.poller.request_world(data["gen"])
            elif kind == "convoys":
                self.hub.apply_convoy_states(data)
                if data.get("added") or data.get("removed"):
                    self.poller.request("convoys", "lines")
            elif kind == "arrivals":
                items = data.get("items") or []
                room = MAX_ARRIVALS - len(self.arrivals)
                self.arrivals.extend(items[:max(room, 0)])
                self.arrivals_dropped += max(len(items) - max(room, 0), 0) + int(data.get("dropped") or 0)
            elif kind == "overflow":
                log.info("events: the game dropped %s events for the bridge, refetching", data.get("lost"))
                self.poller.request("messages", "poll", "players", "convoys", "lines")
        if messages:
            self.on_messages(messages)
        if cash:
            self.hub.apply_cash(cash)

    def on_messages(self, messages):
        if self.hub.add_event_messages(messages):
            self.poller.request("messages")

    def flush_arrivals(self, force):
        if not (self.arrivals or self.arrivals_dropped):
            return
        now = time.monotonic()
        if not force and now - self.arrivals_sent < self.arrivals_gap:
            return
        self.arrivals_sent = now
        self.hub.publish("arrivals", {"items": self.arrivals, "dropped": self.arrivals_dropped})
        self.arrivals, self.arrivals_dropped = [], 0


# --- sessions and rate limits ----------------------------------------------------------------

class Session:
    __slots__ = ("sid", "role", "created", "last_seen", "tokens", "stamp", "tile_tokens", "tile_stamp", "buckets")

    def __init__(self, sid, role):
        now = time.monotonic()
        self.sid, self.role, self.created, self.last_seen = sid, role, now, now
        self.tokens, self.stamp = RATE_BURST, now
        self.tile_tokens, self.tile_stamp = TILE_BURST, now
        self.buckets = {}  # name of a VIEW3D_RATES bucket -> (tokens, stamp)


class Sessions:
    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}

    def _purge_locked(self, now):
        for sid in [s for s, v in self.items.items() if now - v.last_seen > SESSION_IDLE]:
            del self.items[sid]

    def create(self, role):
        sid = secrets.token_urlsafe(32)
        now = time.monotonic()
        with self.lock:
            self._purge_locked(now)
            while len(self.items) >= MAX_SESSIONS:
                # the oldest session of the same role goes first, so signing in again and again with one
                # token cannot sign out the sessions of the other roles
                same = [s for s in self.items.values() if s.role == role]
                oldest = min(same or self.items.values(), key=lambda s: s.last_seen)
                del self.items[oldest.sid]
            self.items[sid] = Session(sid, role)
        return sid

    def get(self, sid):
        if not sid:
            return None
        now = time.monotonic()
        with self.lock:
            s = self.items.get(sid)
            if s is None:
                return None
            if now - s.last_seen > SESSION_IDLE:
                del self.items[sid]
                return None
            s.last_seen = now
            return s

    def delete(self, sid):
        with self.lock:
            self.items.pop(sid, None)

    def allow(self, s):
        """Token bucket per session: RATE_PER_SECOND requests, bursts up to RATE_BURST."""
        now = time.monotonic()
        with self.lock:
            s.tokens = min(RATE_BURST, s.tokens + (now - s.stamp) * RATE_PER_SECOND)
            s.stamp = now
            if s.tokens < 1:
                return False
            s.tokens -= 1
            return True

    def allow_tile(self, s):
        """Own token bucket for map tiles: TILE_RATE requests per second, bursts up to TILE_BURST."""
        now = time.monotonic()
        with self.lock:
            s.tile_tokens = min(TILE_BURST, s.tile_tokens + (now - s.tile_stamp) * TILE_RATE)
            s.tile_stamp = now
            if s.tile_tokens < 1:
                return False
            s.tile_tokens -= 1
            return True

    def allow_3d(self, s, name):
        """Own token bucket of a 3D endpoint (VIEW3D_RATES: requests per second, burst)."""
        rate, burst = VIEW3D_RATES[name]
        now = time.monotonic()
        with self.lock:
            tokens, stamp = s.buckets.get(name, (burst, now))
            tokens = min(burst, tokens + (now - stamp) * rate)
            ok = tokens >= 1
            s.buckets[name] = (tokens - 1 if ok else tokens, now)
            return ok


class TimeBudget:
    """Token bucket of seconds: `rate` seconds per second, at most `burst`. A request may start while the
    level is above zero and is charged its duration afterwards."""

    def __init__(self, rate, burst):
        self.lock = threading.Lock()
        self.rate, self.burst = rate, burst
        self.level, self.stamp = burst, time.monotonic()

    def _refill_locked(self):
        now = time.monotonic()
        self.level = min(self.burst, self.level + (now - self.stamp) * self.rate)
        self.stamp = now

    def available(self):
        with self.lock:
            self._refill_locked()
            return self.level > 0

    def charge(self, seconds):
        with self.lock:
            self._refill_locked()
            self.level -= seconds


class LoginLimiter:
    """At most LOGIN_FAILURES failed logins per IP and minute; further attempts get 429."""

    def __init__(self):
        self.lock = threading.Lock()
        self.failures = {}

    def blocked(self, ip):
        now = time.monotonic()
        with self.lock:
            q = self.failures.get(ip)
            if not q:
                return False
            while q and now - q[0] > 60:
                q.popleft()
            if not q:
                del self.failures[ip]
                return False
            return len(q) >= LOGIN_FAILURES

    def failed(self, ip):
        now = time.monotonic()
        with self.lock:
            if len(self.failures) > 10000:
                self.failures.clear()
            self.failures.setdefault(ip, collections.deque()).append(now)


# --- HTTP ------------------------------------------------------------------------------------

LOGIN_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simutrans dashboard</title>
<link rel="stylesheet" href="/login.css">
</head>
<body>
<main>
<h1>Simutrans dashboard</h1>
%s<form method="post" action="/login">
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="off" required autofocus>
<button type="submit">Sign in</button>
</form>
<p class="hint">The bridge prints the access links when it starts. Signed in already?
<a href="/">Open the dashboard</a></p>
</main>
</body>
</html>
"""

# answer to a token link: sets the cookie, then moves on by itself (see Handler.login)
LOGIN_BOUNCE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=/">
<title>Simutrans dashboard</title>
<link rel="stylesheet" href="/login.css">
</head>
<body>
<main>
<h1>Simutrans dashboard</h1>
<p class="hint">Signed in. <a href="/">Open the dashboard</a></p>
</main>
</body>
</html>
"""

LOGIN_CSS = """:root{color-scheme:light dark;--bg:#f4f5f7;--fg:#1d2330;--card:#fff;--line:#c9ced8;--accent:#2f6fde;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#14171d;--fg:#e4e7ee;--card:#1e232c;--line:#3a4250;--accent:#6d9cff;--err:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:360px;margin:12vh auto;padding:24px;background:var(--card);border:1px solid var(--line);border-radius:8px}
h1{font-size:20px;margin:0 0 16px}label{display:block;margin-bottom:4px}
input{box-sizing:border-box;width:100%;padding:8px;font:inherit;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg)}
button{margin-top:12px;padding:8px 16px;font:inherit;border:0;border-radius:4px;background:var(--accent);color:#fff;cursor:pointer}
.error{color:var(--err)}.hint{font-size:14px;opacity:.8}a{color:var(--accent)}
"""

LOGIN_ERRORS = {
    "wrong": "Wrong or expired token.",
    "limit": "Too many failed attempts, try again in a minute.",
}


class App:
    def __init__(self, port, game_port, bind, allowed_hosts, tokens, intervals, min_gap, heartbeat, verbose,
                 event_intervals=None, events=True, event_interval_ms=EVENT_INTERVAL_MS, arrivals_gap=ARRIVALS_GAP,
                 route_refresh=ROUTE_REFRESH, status_ttl=FACTORY_STATUS_TTL, pak3d=None, queue_3d=QUEUE_3D,
                 queue_veh=QUEUE_VEH):
        self.port = port
        self.game_port = game_port
        self.tokens = tokens  # [(role, token)]
        self.roles = [role for role, _ in tokens]
        self.heartbeat = heartbeat
        self.verbose = verbose
        self.cookie_name = "sdash_%d" % port
        self.sessions = Sessions()
        self.logins = LoginLimiter()
        self.hub = Hub()
        self.hub.routes.refresh = route_refresh
        self.poller = Poller(self.hub, game_port, intervals, min_gap, event_intervals)
        self.subscriber = Subscriber(self.hub, self.poller, game_port, event_interval_ms, arrivals_gap) if events else None
        self.req_conn = EngineConnection(game_port, timeout=60)
        self.req_lock = threading.Lock()
        self.heavy = threading.BoundedSemaphore(MAX_HEAVY)
        self.export_budget = TimeBudget(EXPORT_RATE, EXPORT_BURST)
        self.status_lock = threading.Lock()
        self.status_cache = None  # {"stamp", "at", "reply"} of GET /api/factory_status
        self.status_ttl = status_ttl
        # 3D: heavy requests (desc_list, scene3d, heights) and vehicles3d on two game connections of their own
        self.worker_3d = EngineWorker("game-3d", game_port, queue_3d)
        self.worker_veh = EngineWorker("game-vehicles3d", game_port, queue_veh)
        self.pak3d = os.path.normcase(os.path.realpath(pak3d)) if pak3d else None
        self.gzip_cache = GzipCache()
        self.web_dir = os.path.normcase(os.path.realpath(WEB_DIR))
        hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port, "[::1]:%d" % port}
        if bind not in ("", "0.0.0.0", "::"):
            hosts.add(("[%s]:%d" if ":" in bind else "%s:%d") % (bind.lower(), port))
        for name in allowed_hosts:
            name = name.lower()
            hosts.add(name)
            if not re.search(r"(^\[[^\]]*\]|^[^:\[\]]+):\d+$", name):
                hosts.add("%s:%d" % (name, port))
        self.allowed_hosts = frozenset(hosts)
        self.allowed_origins = frozenset(s + "://" + h for h in hosts for s in ("http", "https"))

    def check_token(self, token):
        given = utf8(token)
        role = None
        for r, t in self.tokens:  # compare with every token, constant time each
            if hmac.compare_digest(given, utf8(t)):
                role = r
        return role

    def engine_request(self, command, params, heavy):
        """(HTTP status, reply dict) of a browser request through the request connection."""
        export = command in EXPORT_COMMANDS
        if export and not self.export_budget.available():
            return 429, {"ok": False, "error": "the game is busy with map requests of the browsers, retry later"}
        if heavy and not self.heavy.acquire(blocking=False):
            return 429, {"ok": False, "error": "too many large requests at the same time, retry later"}
        try:
            if not self.req_lock.acquire(timeout=30):
                return 503, {"ok": False, "error": "the game connection is busy"}
            t0 = time.monotonic()
            try:
                reply = self.req_conn.call(command, **params)
            except Unreachable as e:
                return 502, {"ok": False, "error": str(e)}
            finally:
                self.req_lock.release()
                if export:
                    self.export_budget.charge(time.monotonic() - t0)
        finally:
            if heavy:
                self.heavy.release()
        return (200 if reply.get("ok") else 400), reply

    def line_route(self, args):
        """(HTTP status, reply) of GET /api/line_route. With id (and without convoy): the legs of the line
        merged over time from `line_route id= all=1` (see RouteCache); anything else goes to the game."""
        if "convoy" in args or "id" not in args:
            return self.engine_request("line_route", args, False)
        line_id = as_int(args["id"])
        if line_id is None:
            return 400, {"ok": False, "error": "id must be an integer"}
        routes = self.hub.routes
        stamp = self.hub.route_stamp()
        routes.check_stamp(stamp)
        now = time.monotonic()
        cached = routes.lookup(line_id, now)
        if cached is not None:
            return 200, dict(cached, ok=True)
        code, line = self.engine_request("line", {"id": line_id}, False)
        if code == 200:
            code, route = self.engine_request("line_route", {"id": line_id, "all": 1}, False)
            if code == 200:
                return 200, dict(routes.merge(line_id, line, route, now, stamp), ok=True)
            line = route
        routes.release(line_id)
        return code, line

    def factory_status(self):
        """(HTTP status, reply) of GET /api/factory_status: status, productivity and served stops of every
        factory from the `factory` window of each (history=0), sent pipelined (about 1 ms in the game for
        200 factories). Shared by all browsers: fetched again after FACTORY_STATUS_TTL s, a new month or
        another world. Engines without `factory` give 400 unknown command."""
        if not self.heavy.acquire(blocking=False):
            return 429, {"ok": False, "error": "too many large requests at the same time, retry later"}
        try:
            with self.status_lock:
                stamp = self.hub.status_stamp()
                now = time.monotonic()
                c = self.status_cache
                if c is not None and c["stamp"] == stamp and now - c["at"] < self.status_ttl:
                    return 200, dict(c["reply"], ok=True)
                positions = self.hub.factory_positions()
                if positions is None:
                    code, reply = self.engine_request("factories", {"limit": 0, "fields": "summary"}, False)
                    if code != 200:
                        return code, reply
                    positions = [(f["pos"]["x"], f["pos"]["y"]) for f in reply.get("factories") or ()
                                 if isinstance(f, dict) and isinstance(f.get("pos"), dict)]
                items = []
                for i in range(0, len(positions), FACTORY_BATCH):
                    batch = positions[i:i + FACTORY_BATCH]
                    if not self.req_lock.acquire(timeout=30):
                        return 503, {"ok": False, "error": "the game connection is busy"}
                    try:
                        replies = self.req_conn.call_many([("factory", {"x": x, "y": y, "history": 0})
                                                           for x, y in batch])
                    except Unreachable as e:
                        return 502, {"ok": False, "error": str(e)}
                    finally:
                        self.req_lock.release()
                    for (x, y), r in zip(batch, replies):
                        if not r.get("ok"):
                            if r.get("error") == "unknown command":
                                return 400, {"ok": False, "error": "unknown command"}
                            continue  # e.g. the factory was removed since the list
                        f = r.get("factory") or {}
                        items.append({"x": x, "y": y, "status": f.get("status"), "productivity": f.get("productivity"),
                                      "production_per_minute": f.get("production_per_minute"),
                                      "base_production": f.get("base_production"), "owner": f.get("owner"),
                                      "halts": len(r.get("halts") or ()), "cities": len(r.get("cities") or ())})
                date = {"year": stamp[3], "month": stamp[4]} if stamp[3] is not None else None
                reply = {"factories": items, "date": date, "fetched": round(time.time(), 1)}
                self.status_cache = {"stamp": stamp, "at": time.monotonic(), "reply": reply}
                return 200, dict(reply, ok=True)
        finally:
            self.heavy.release()

    def tile(self, mode, step, cx, cy):
        """(200, (png, etag)) or (HTTP status, error text) of a map tile; mode and step are checked."""
        hub, tiles = self.hub, self.hub.tiles
        if hub.map_export is False:
            return 404, "the game has no map export (palette, minimap)"
        size = hub.world_size()
        if size is None or hub.map_export is None:
            return 503, "the game is not ready"
        span = CHUNK * step
        if cx * span >= size[0] or cy * span >= size[1]:
            return 404, "tile outside of the map"
        if tiles.note_request():
            self.poller.request("map")  # follow the map changes from now on
        if tiles.colors is None:
            code, reply = self.engine_request("palette", {}, False)
            colors = palette_colors(reply) if code == 200 else None
            if colors is None:
                return (code if code != 200 else 502), reply.get("error") or "no palette"
            tiles.set_colors(colors)
        key = (mode, step, cx, cy)
        for _ in range(3):
            hit = tiles.lookup(key)
            if hit is not None:
                return 200, hit
            wait = tiles.begin(key)
            if wait is None:
                break
            wait.wait(30)  # another request fetches this tile
        else:
            return 503, "the tile is busy"
        try:
            epoch, stats = tiles.state()
            colors = tiles.colors
            code, reply = self.engine_request(
                "minimap", {"x": cx * span, "y": cy * span, "w": span, "h": span, "step": step, "mode": mode}, False)
            if code != 200:
                return code, reply.get("error") or "minimap failed"
            width, height, gen = reply.get("width"), reply.get("height"), reply.get("gen")
            try:
                samples = zlib.decompress(base64.b64decode(reply.get("data") or ""))
            except (ValueError, zlib.error):
                samples = None
            if (not isinstance(width, int) or not isinstance(height, int) or not isinstance(gen, int)
                    or not 0 < width <= CHUNK or not 0 < height <= CHUNK or samples is None
                    or len(samples) != width * height):
                return 502, "the game sent an invalid minimap"
            png = make_tile_png(samples, width, height, colors)
            etag = '"%s"' % hashlib.sha1(png).hexdigest()[:24]
            tiles.store(key, png, etag, gen, epoch, stats)
            return 200, (png, etag)
        finally:
            tiles.end(key)

    # -- 3D view

    def fetch3d(self, store, key, worker, command, args, prefix, cells=(), etag=True):
        """(200, Entry) from the cache or the game (one game request for concurrent requests of a key), else
        (HTTP status, error reply)."""
        if self.poller.caps.get("3d") is False:
            return 501, UNSUPPORTED_3D
        state, flight = store.acquire(key)
        if state == "hit":
            return 200, flight
        if state == "wait":
            if not flight.done.wait(WAIT_3D + 5) or flight.result is None:
                return 503, {"ok": False, "error": "the game did not answer the 3D request in time"}
            return flight.result
        result, entry = (500, {"ok": False, "error": "internal error"}), None
        try:
            if flight.check is not None and self.check_entry(store, worker, flight.check):
                result = (200, flight.check)
                return result
            code, reply = worker.submit(command, args)
            if code == 200:
                entry = Entry(reply, prefix, cells, etag)
                result = (200, entry)
            elif is_unknown_command(reply):
                result = (501, UNSUPPORTED_3D)
            else:
                result = (code, reply)
        finally:
            store.finish(key, flight, result, entry)
        return result

    @staticmethod
    def check_entry(store, worker, e):
        """A cached reply whose cells were reported in a window that contains its rev: still valid if none of them
        changed after it (one light map_changes on the same connection instead of fetching it again)."""
        code, reply = worker.submit("map_changes", {"since": e.checked, "chunk": CELL})
        if code != 200 or reply.get("full") or reply.get("chunk") != CELL or type(reply.get("gen")) is not int:
            return False
        later = {(c[0], c[1]) for c in reply.get("chunks") or () if isinstance(c, list) and len(c) == 2}
        return store.confirm(e, reply["gen"], later)

    def follow_3d(self):
        """A chunk or heights request: the poller follows the map changes (again)."""
        if self.hub.scenes.note_request():
            # not followed until now, changes may have been missed
            self.hub.scenes.reset()
            self.hub.heights.reset()
            self.poller.request("map")

    NOT_READY = (503, {"ok": False, "error": "the game is not ready"})

    def desc_list(self, kinds):
        """kinds: None (all lists) or the validated comma separated list."""
        if kinds is not None:
            given = kinds.split(",")
            if any(k not in DESC_KINDS for k in given) or len(set(given)) != len(given):
                return 400, {"ok": False, "error": "kinds must be a comma separated list of " + ",".join(DESC_KINDS)}
            kinds = ",".join(k for k in DESC_KINDS if k in given)
        return self.fetch3d(self.hub.descs, kinds or "", self.worker_3d, "desc_list",
                            {"kinds": kinds} if kinds else {}, "dl")

    def scene3d(self, cx, cy, size):
        world = self.hub.world_size()
        if world is None:
            return self.NOT_READY
        if cx * size >= world[0] or cy * size >= world[1]:
            return 404, {"ok": False, "error": "chunk is outside of the map"}
        self.follow_3d()
        cell = (cx * size // CELL, cy * size // CELL)
        return self.fetch3d(self.hub.scenes, (cx, cy, size), self.worker_3d, "scene3d",
                            {"cx": cx, "cy": cy, "size": size}, "s3", (cell,))

    def heights(self, step, region):
        world = self.hub.world_size()
        if world is None:
            return self.NOT_READY
        x1, y1, x2, y2 = region or (0, 0, world[0] - 1, world[1] - 1)
        if x1 >= world[0] or y1 >= world[1]:
            return 400, {"ok": False, "error": "region is outside of the map"}
        x2, y2 = min(x2, world[0] - 1), min(y2, world[1] - 1)
        if (-(-(x2 - x1 + 1) // step) + 1) * (-(-(y2 - y1 + 1) // step) + 1) > MAX_HEIGHT_SAMPLES:
            return 400, {"ok": False, "error": "too many samples (at most %d per request): use a larger step or a "
                                               "smaller region" % MAX_HEIGHT_SAMPLES}
        self.follow_3d()
        # the samples of the east and south edge are corners of the next squares
        ex, ey = min(x2 + 1, world[0] - 1), min(y2 + 1, world[1] - 1)
        cells = [(cx, cy) for cy in range(y1 // CELL, ey // CELL + 1) for cx in range(x1 // CELL, ex // CELL + 1)]
        return self.fetch3d(self.hub.heights, (step, x1, y1, x2, y2), self.worker_3d, "heights",
                            {"step": step, "x1": x1, "y1": y1, "x2": x2, "y2": y2}, "h3", cells)

    def vehicles3d(self, region, extras):
        world = self.hub.world_size()
        if world is None:
            return self.NOT_READY
        x1, y1, x2, y2 = region
        if x1 >= world[0] or y1 >= world[1]:
            return 400, {"ok": False, "error": "region is outside of the map"}
        x2, y2 = min(x2, world[0] - 1), min(y2, world[1] - 1)
        args = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
        if extras:
            args["extras"] = 1
        return self.fetch3d(self.hub.vehicles, (x1, y1, x2, y2, extras), self.worker_veh, "vehicles3d", args, "v3",
                            etag=False)


def check_args(pairs):
    """dict of validated request arguments, or an error text."""
    args = {}
    for k, v in pairs:
        if k == "rid":
            continue
        if not ARG_NAME.match(k) or k in ("command", "self"):
            return "invalid argument name"
        if len(v) > MAX_ARG_VALUE:
            return "argument %s is too long" % k
        # the game reads many values as C strings: "4124\0" would be the number 4124 there (tool_lock_game)
        # but no number here; lone surrogates cannot be sent as UTF-8
        if "\0" in v or any(0xD800 <= ord(c) <= 0xDFFF for c in v):
            return "argument %s contains an invalid character" % k
        args[k] = v
    return args


def as_int(v, default=None):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def check_map_region(args):
    for k in ("x", "y", "w", "h", "max_size"):
        if k in args and as_int(args[k]) is None:
            return "%s must be an integer" % k
    w = as_int(args.get("w"), 32)
    h = as_int(args.get("h"), w)
    if w < 0 or h < 0 or w * h > MAX_MAP_TILES:
        return "map region too large (at most %d tiles)" % MAX_MAP_TILES
    if as_int(args.get("max_size"), 0) > 512:
        return "max_size must be at most 512"
    return None


VIEW3D_ARGS = {"desc_list": ("kinds",), "scene3d": ("cx", "cy", "size"), "heights": ("step", "x1", "y1", "x2", "y2"),
               "vehicles3d": ("x1", "y1", "x2", "y2", "extras")}


def view3d_args(name, args):
    """Validated arguments of a 3D request (dict, numbers as int), or an error text."""
    out = {}
    for k, v in args.items():
        if k not in VIEW3D_ARGS[name]:
            return "unknown argument: %s" % k
        if k == "kinds":
            if not v:
                return "kinds must not be empty"
            out[k] = v
        elif not INT_ARG.match(v):
            return "%s must be an integer" % k
        else:
            out[k] = int(v)
    if name == "scene3d":
        if "cx" not in out or "cy" not in out:
            return "missing chunk coordinates cx,cy"
        if out["cx"] < 0 or out["cy"] < 0:
            return "chunk is outside of the map"
        out.setdefault("size", 64)
        if out["size"] not in SCENE_SIZES:
            return "size must be 16, 32 or 64"
    if name == "heights" and out.get("step") not in HEIGHTS_STEPS:
        return "step must be 1, 2, 4, 8 or 16"
    if name in ("heights", "vehicles3d"):
        given = [k for k in ("x1", "y1", "x2", "y2") if k in out]
        if given and len(given) != 4 or name == "vehicles3d" and not given:
            return "the region needs all of x1, y1, x2, y2"
        if given:
            if min(out[k] for k in given) < 0:
                return "region is outside of the map"
            if out["x1"] > out["x2"] or out["y1"] > out["y2"]:
                return "the region needs x1 <= x2 and y1 <= y2"
            out["region"] = (out["x1"], out["y1"], out["x2"], out["y2"])
    if name == "vehicles3d":
        if out["x2"] - out["x1"] >= VEH_MAX_SIDE or out["y2"] - out["y1"] >= VEH_MAX_SIDE:
            return "region too large (at most %d x %d squares)" % (VEH_MAX_SIDE, VEH_MAX_SIDE)
        if out.get("extras", 0) not in (0, 1):
            return "extras must be 0 or 1"
    return out


def general_tool_number(value):
    """Number of the general tool the game would use for a tool= value, None if unknown.
    Follows remote_control.cc parse_work_tool: names in any case, general_tool[N], or a number
    (decimal, 0x hex, 0 octal like strtoul) including the 0x1000 flag."""
    s = value.strip().lower()
    for nr, name in REFUSED_TOOLS.items():
        if s == name:
            return nr
    m = re.fullmatch(r"general_tool\[\s*([+-]?\d+)\]", s)
    if m:
        return int(m.group(1))
    if s[:1].isdigit():
        try:
            if s.startswith("0x"):
                n = int(s[2:], 16)
            elif s.startswith("0") and len(s) > 1:
                n = int(s, 8)
            else:
                n = int(s, 10)
        except ValueError:
            return None
        if n & 0xF000 == 0x1000:
            return n & 0x0FFF
    return None


def is_heavy(command, args):
    if command == "map":
        return True
    if command == "minimap":
        # more than four tiles' worth of samples (the default region is the whole map)
        step = max(as_int(args.get("step"), 1) or 1, 1)
        w, h = as_int(args.get("w")), as_int(args.get("h"))
        return w is None or h is None or (w // step + 1) * (h // step + 1) > 4 * CHUNK * CHUNK
    if command in HEAVY_LISTS and "limit" in args:
        limit = as_int(args["limit"], 0)
        return limit == 0 or limit > 1000
    return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SimutransDashboard/" + VERSION
    sys_version = ""
    timeout = 60

    def setup(self):
        super().setup()
        self.app = self.server.app
        self._cache_set = False

    # -- headers on every response

    def send_response(self, code, message=None):
        self._cache_set = False
        super().send_response(code, message)

    def send_header(self, keyword, value):
        if keyword.lower() == "cache-control":
            self._cache_set = True
        super().send_header(keyword, value)

    def end_headers(self):
        for k, v in SECURITY_HEADERS:
            super().send_header(k, v)
        if not self._cache_set:
            super().send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        log.info("%s %s", self.client_address[0], TOKEN_RE.sub(r"\1***", fmt % args))

    def log_error(self, fmt, *args):
        if not fmt.startswith("Request timed out"):  # idle keep-alive connections, normal
            super().log_error(fmt, *args)

    def log_request(self, code="-", size="-"):
        status = code.value if isinstance(code, HTTPStatus) else as_int(code, 0)
        if self.app.verbose or status >= 400:
            super().log_request(code, size)

    def send_bytes(self, code, body, ctype, cache="no-store", headers=()):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        for k, v in headers:
            self.send_header(k, v)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, code, obj, headers=()):
        self.send_body(code, utf8(json_dumps(obj)), "application/json; charset=utf-8", headers=headers)

    def accepts_gzip(self):
        star = False
        for header in self.headers.get_all("Accept-Encoding") or ():
            for part in header.split(","):
                token, _, params = part.partition(";")
                token = token.strip().lower()
                q = 1.0
                for p in params.split(";"):
                    k, _, v = p.partition("=")
                    if k.strip().lower() == "q":
                        try:
                            q = float(v)
                        except ValueError:
                            q = 0.0
                if token in ("gzip", "x-gzip"):
                    return q > 0
                if token == "*":
                    star = q > 0
        return star

    def etag_matches(self, etag):
        """If-None-Match against an ETag ('"tag"'; the gzip form is sent as '"tag-gz"'), weak comparison."""
        header = self.headers.get("If-None-Match")
        if not header:
            return False
        base = etag[1:-1]
        for t in header.split(","):
            t = t.strip()
            if t == "*":
                return True
            if t.startswith("W/"):
                t = t[2:]
            if len(t) >= 2 and t[0] == t[-1] == '"' and t[1:-1] in (base, base + "-gz"):
                return True
        return False

    def send_not_modified(self, cache, headers=()):
        self.send_response(304)
        for k, v in headers:
            if k in ("ETag", "Vary"):
                self.send_header(k, v)
        self.send_header("Cache-Control", cache)
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()

    def send_body(self, code, body, ctype, cache="no-store", headers=(), gz=None, compress=True, etag=None):
        """send_bytes, gzip compressed for browsers that accept it (gz: the known gzip form; compress: make one for
        bodies of at least GZIP_MIN bytes), and with an ETag 304 for a matching If-None-Match."""
        headers = list(headers)
        may = gz is not None or (compress and len(body) >= GZIP_MIN)
        if may:
            headers.append(("Vary", "Accept-Encoding"))
        use_gz = may and self.accepts_gzip()
        if etag:
            headers.append(("ETag", etag[:-1] + '-gz"' if use_gz else etag))
            if code == 200 and self.etag_matches(etag):
                return self.send_not_modified(cache, headers)
        if use_gz:
            if gz is None:
                gz = gzip_bytes(body)
            if len(gz) < len(body):
                headers.append(("Content-Encoding", "gzip"))
                body = gz
        self.send_bytes(code, body, ctype, cache, headers)

    def send_err(self, code, error, headers=()):
        self.send_json(code, {"ok": False, "error": error}, headers)

    def send_text(self, code, text):
        self.send_bytes(code, utf8(text + "\n"), "text/plain; charset=utf-8")

    def send_login(self, code, error=None):
        msg = '<p class="error">%s</p>\n' % LOGIN_ERRORS[error] if error else ""
        self.send_bytes(code, utf8(LOGIN_PAGE % msg), "text/html; charset=utf-8")

    def redirect(self, code, cookie=None):
        headers = [("Location", "/")]
        if cookie:
            headers.append(("Set-Cookie", cookie))
        self.send_bytes(code, b"", "text/plain; charset=utf-8", headers=headers)

    # -- request plumbing

    def check_host(self):
        host = (self.headers.get("Host") or "").strip().lower()
        if host in self.app.allowed_hosts:
            return True
        self.close_connection = True
        self.send_text(421, "misdirected request")
        return False

    def split_target(self):
        path, _, query = self.path.partition("?")
        return path, query.partition("#")[0]

    def cookie_sid(self):
        prefix = self.app.cookie_name + "="
        for header in self.headers.get_all("Cookie") or ():
            for part in header.split(";"):
                part = part.strip()
                if part.startswith(prefix):
                    return part[len(prefix):]
        return None

    def session(self):
        return self.app.sessions.get(self.cookie_sid())

    def make_cookie(self, sid):
        cookie = "%s=%s; HttpOnly; SameSite=Strict; Path=/" % (self.app.cookie_name, sid)
        if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https":
            cookie += "; Secure"
        return cookie

    def login(self, token, redirect_code=None):
        """Sign in with a token. redirect_code None (token link): a page that sets the cookie and goes on to /
        by itself. A link opened from another site or app (chat, mail) is a cross-site navigation, and browsers
        do not send the SameSite=Strict cookie on a redirect of it, so a 302 would show the sign-in page again;
        the page's own navigation is same-site."""
        ip = self.client_address[0]
        if self.app.logins.blocked(ip):
            return self.send_login(429, "limit")
        role = self.app.check_token(token)
        if role is None:
            self.app.logins.failed(ip)
            log.info("%s failed login", ip)
            return self.send_login(401, "wrong")
        old = self.cookie_sid()
        if old:
            self.app.sessions.delete(old)
            self.app.hub.close_session(old)
        sid = self.app.sessions.create(role)
        log.info("%s signed in as %s", ip, role)
        cookie = self.make_cookie(sid)
        if redirect_code is None:
            return self.send_bytes(200, utf8(LOGIN_BOUNCE), "text/html; charset=utf-8",
                                   headers=[("Set-Cookie", cookie)])
        self.redirect(redirect_code, cookie)

    def read_body(self, allowed=True):
        """Request body (bytes), or None after an error response. A body the bridge would not read
        (GET) is refused, as are unclear lengths: left in the connection, its bytes would be taken for
        the next request (behind a proxy that reuses connections, maybe of another user)."""
        lengths = self.headers.get_all("Content-Length") or []
        error = None
        if self.headers.get("Transfer-Encoding"):
            error = (411, "Content-Length required") if allowed else (400, "a GET request has no body")
        elif len(lengths) > 1 or (lengths and not re.fullmatch(r"\d{1,9}", lengths[0].strip())):
            error = (400, "invalid Content-Length")
        else:
            length = int(lengths[0]) if lengths else 0
            if length > MAX_BODY:
                error = (413, "request body too large")
            elif length and not allowed:
                error = (400, "a GET request has no body")
        if error:
            self.close_connection = True
            self.send_err(*error)
            return None
        return self.rfile.read(length) if length else b""

    def origin_ok(self, allow_null):
        origin = (self.headers.get("Origin") or "").strip().lower()
        if origin == "null" or not origin:
            return allow_null
        return origin in self.app.allowed_origins

    def same_origin(self):
        """False for requests that browsers mark as coming from another site (also another port of the same
        host, which gets the SameSite cookie); requests without Sec-Fetch-Site (other clients) pass."""
        return (self.headers.get("Sec-Fetch-Site") or "same-origin").lower() in ("same-origin", "none")

    def run_safely(self, fn):
        try:
            fn()
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except Exception:
            log.exception("%s %s failed", self.command, TOKEN_RE.sub(r"\1***", self.path))
            self.close_connection = True
            try:
                self.send_err(500, "internal error")
            except OSError:
                pass

    # -- methods

    def do_GET(self):
        self.run_safely(self.get)

    def do_POST(self):
        self.run_safely(self.post)

    def get(self):
        if not self.check_host() or self.read_body(allowed=False) is None:
            return
        path, query = self.split_target()
        if path == "/":
            params = urllib.parse.parse_qs(query)
            if "token" in params:
                if (self.headers.get("Sec-Fetch-Dest") or "document").lower() != "document":
                    # an <img> or <iframe> of another site: no sign-in, no failed attempt counted
                    return self.send_text(403, "sign in with the link in the address bar")
                return self.login(params["token"][0])
            if self.session() is None:
                return self.send_login(200)
            return self.static("/index.html")
        if path == "/login":
            return self.send_login(200)
        if path == "/login.css":
            return self.send_bytes(200, utf8(LOGIN_CSS), "text/css; charset=utf-8")
        if path == "/favicon.ico":
            return self.send_text(404, "not found")
        if path.startswith(("/api/", "/tiles/", "/pak3d/")) and not self.same_origin():
            return self.send_err(403, "cross-site request")
        sess = self.session()
        if path.startswith("/api/"):
            if sess is None:
                return self.send_err(401, "not signed in")
            name = path[5:]
            if not (self.app.sessions.allow_3d(sess, name) if name in VIEW3D_RATES else self.app.sessions.allow(sess)):
                return self.send_err(429, "rate limit", [("Retry-After", "1")])
            if name == "session":
                return self.api_session(sess)
            if name == "events":
                return self.events(sess)
            return self.api_read(name, query)
        if path.startswith("/tiles/"):
            if sess is None:
                return self.send_err(401, "not signed in")
            return self.map_tile(sess, path)
        if path.startswith("/pak3d/"):
            if sess is None:
                return self.send_text(401, "not signed in")
            return self.pak3d(path)
        if sess is None:
            return self.send_text(401, "not signed in")
        return self.static(path)

    def post(self):
        if not self.check_host():
            return
        body = self.read_body()
        if body is None:
            return
        path, _ = self.split_target()
        if path == "/login":
            # the login form is posted with Referrer-Policy no-referrer, so browsers send Origin: null; other
            # sites can send that too (failed attempts block the address for a minute): Sec-Fetch-Site tells
            if not self.origin_ok(allow_null=True) or not self.same_origin():
                return self.send_text(403, "forbidden origin")
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype != "application/x-www-form-urlencoded" or len(body) > 4096:
                return self.send_login(400)
            fields = urllib.parse.parse_qs(body.decode("utf-8", "replace"))
            return self.login((fields.get("token") or [""])[0], 303)
        if not path.startswith("/api/"):
            return self.send_text(404, "not found")
        sess = self.session()
        if sess is None:
            return self.send_err(401, "not signed in")
        if not self.app.sessions.allow(sess):
            return self.send_err(429, "rate limit", [("Retry-After", "1")])
        if self.headers.get("X-Dashboard") != "1":
            return self.send_err(403, "missing X-Dashboard header")
        if not self.origin_ok(allow_null=False):
            return self.send_err(403, "forbidden origin")
        if not self.same_origin():
            return self.send_err(403, "cross-site request")
        name = path[5:]
        if name == "logout":
            self.app.sessions.delete(sess.sid)
            self.app.hub.close_session(sess.sid)
            cookie = "%s=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" % self.app.cookie_name
            return self.send_json(200, {"ok": True}, [("Set-Cookie", cookie)])
        if name not in ROLE_ACTIONS[sess.role]:
            return self.send_err(403, "command not allowed")
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self.send_err(415, "Content-Type must be application/json")
        try:
            args = json.loads(body.decode("utf-8")) if body.strip() else {}
        except (ValueError, UnicodeDecodeError):
            return self.send_err(400, "invalid JSON")
        if not isinstance(args, dict):
            return self.send_err(400, "the body must be a JSON object")
        self.api_action(name, args)

    # -- API

    def api_session(self, sess):
        game = self.app.hub.game_state()
        self.send_json(200, {
            "role": sess.role,
            "allowed": {"read": list(READ_COMMANDS) + list(BRIDGE_READS) + list(VIEW3D_READS),
                        "action": list(ROLE_ACTIONS[sess.role])},
            "game": {"connected": game["connected"], "missing": game["missing"], "events": game["events"]},
            "bridge": {"version": VERSION, "game_port": self.app.game_port},
            # supported: the game has the 3D export (null: not known yet); pak3d: /pak3d/ serves a directory
            "view3d": {"supported": self.app.poller.caps.get("3d"), "pak3d": self.app.pak3d is not None},
        })

    def api_read(self, name, query):
        if name not in READ_COMMANDS and name not in BRIDGE_READS and name not in VIEW3D_READS:
            return self.send_err(403, "command not allowed")
        if len(query) > 4096:
            return self.send_err(400, "query too long")
        args = check_args(urllib.parse.parse_qsl(query, keep_blank_values=True))
        if isinstance(args, str):
            return self.send_err(400, args)
        if name in VIEW3D_READS:
            return self.api_view3d(name, args)
        if name == "map":
            error = check_map_region(args)
            if error:
                return self.send_err(400, error)
        if name == "line_route":
            code, reply = self.app.line_route(args)
        elif name == "factory_status":
            code, reply = self.app.factory_status()
        else:
            code, reply = self.app.engine_request(name, args, is_heavy(name, args))
        headers = [("Retry-After", "1")] if code == 429 else ()
        self.send_json(code, reply, headers)

    def api_view3d(self, name, args):
        """GET /api/desc_list, scene3d, heights, vehicles3d: the game's reply unchanged (plus "ok"), from the caches
        of the bridge; scene3d, heights and desc_list with an ETag (304), vehicles3d not cached by the browser."""
        a = view3d_args(name, args)
        if isinstance(a, str):
            return self.send_err(400, a)
        app = self.app
        if name == "desc_list":
            code, result = app.desc_list(a.get("kinds"))
        elif name == "scene3d":
            code, result = app.scene3d(a["cx"], a["cy"], a["size"])
        elif name == "heights":
            code, result = app.heights(a["step"], a.get("region"))
        else:
            code, result = app.vehicles3d(a["region"], a.get("extras", 0))
        if code != 200:
            return self.send_json(code, result, [("Retry-After", "1")] if code in (429, 503) else ())
        cache = "no-store" if name == "vehicles3d" else "private, no-cache"
        self.send_body(200, result.body, "application/json; charset=utf-8", cache, gz=result.gz, compress=False,
                       etag=result.etag)

    def api_action(self, name, body):
        if name == "cash":
            if body.pop("confirm", None) is not True:
                return self.send_err(400, 'cash needs "confirm": true')
        pairs = []
        for k, v in body.items():
            if name == "tool" and k in TOOL_REFUSED_ARGS:
                return self.send_err(400, "argument not allowed: %s" % k)
            if k not in ACTION_ARGS[name]:
                return self.send_err(400, "unknown argument: %s" % k)
            if v is None:
                continue
            if isinstance(v, bool):
                v = "1" if v else "0"
            elif isinstance(v, (int, float)):
                v = repr(v)
            elif not isinstance(v, str):
                return self.send_err(400, "argument %s must be a string, number or boolean" % k)
            pairs.append((k, v))
        args = check_args(pairs)
        if isinstance(args, str):
            return self.send_err(400, args)
        if name == "tool" and general_tool_number(args.get("tool", "")) in REFUSED_TOOLS:
            return self.send_err(403, "this tool is not available from the dashboard")
        code, reply = self.app.engine_request(name, args, False)
        if code == 200:
            # every browser sees the new state at once, not only at the next poll
            if name == "pause" and isinstance(reply.get("paused"), bool):
                self.app.hub.apply_status({"paused": reply["paused"]})
            elif name == "fast_forward" and isinstance(reply.get("fast_forward"), bool):
                self.app.hub.apply_status({"ff": reply["fast_forward"]})
        self.send_json(code, reply)

    def map_tile(self, sess, path):
        """GET /tiles/<mode>/<step>/<cx>/<cy>.png (the query, e.g. ?v=, is ignored): a palette PNG of
        one CHUNK x CHUNK chunk of the minimap, revalidated with its ETag (304)."""
        m = TILE_PATH.match(path)
        if not m:
            return self.send_err(404, "no such tile")
        mode, step, cx, cy = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
        if mode not in MAP_MODES:
            return self.send_err(400, "unknown map mode")
        if step not in MAP_STEPS:
            return self.send_err(400, "step must be 1, 2, 4, 8 or 16")
        if not self.app.sessions.allow_tile(sess):
            return self.send_err(429, "rate limit", [("Retry-After", "1")])
        code, result = self.app.tile(mode, step, cx, cy)
        if code != 200:
            return self.send_err(code, result, [("Retry-After", "1")] if code in (429, 503) else ())
        png, etag = result
        given = [t.strip() for t in (self.headers.get("If-None-Match") or "").split(",")]
        if etag in given or "W/" + etag in given:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "private, no-cache")
            self.end_headers()
            return
        self.send_bytes(200, png, "image/png", "private, no-cache", [("ETag", etag)])

    # -- SSE

    def write_chunk(self, data):
        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))

    def events(self, sess):
        last_id = as_int((self.headers.get("Last-Event-ID") or "").strip())
        client, eid, replay, snapshot = self.app.hub.subscribe(sess.sid, last_id)
        if client is None:
            return self.send_err(503, "too many event streams", [("Retry-After", "5")])
        clean_end = False
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            hello = json_dumps({"role": sess.role, "bridge_version": VERSION})
            # on a resume hello keeps the client's position, so a drop before the replay loses nothing
            hello_id = last_id if replay is not None else eid
            first = [utf8("retry: 3000\nid: %d\nevent: hello\ndata: %s\n\n" % (hello_id, hello))]
            if replay is not None:
                first.extend(replay)
            else:
                first.append(utf8("id: %d\nevent: snapshot\ndata: %s\n\n" % (eid, json_dumps(snapshot))))
            self.write_chunk(b"".join(first))
            last_write = time.monotonic()
            check_at = last_write + SESSION_CHECK
            hb = self.app.heartbeat
            while True:
                if client.dead:
                    clean_end = True
                    break
                now = time.monotonic()
                if now >= check_at:
                    # also while events flow: an evicted or expired session ends its streams; the check
                    # counts as activity of the session
                    if self.app.sessions.get(sess.sid) is None:
                        clean_end = True
                        break
                    check_at = now + SESSION_CHECK
                wait = min(hb - (now - last_write), check_at - now)
                try:
                    chunk = client.queue.get(timeout=max(0.05, wait))
                except queue.Empty:
                    if time.monotonic() - last_write >= hb:
                        self.write_chunk(b": hb\n\n")
                        last_write = time.monotonic()
                    continue
                if chunk == SseClient.CLOSE:
                    clean_end = True
                    break
                parts = [chunk]
                while len(parts) < 64:  # send what has queued up in one write
                    try:
                        more = client.queue.get_nowait()
                    except queue.Empty:
                        break
                    if more == SseClient.CLOSE:
                        client.dead = True
                        break
                    parts.append(more)
                self.write_chunk(b"".join(parts))
                last_write = time.monotonic()
        except (ConnectionError, TimeoutError, OSError):
            pass
        finally:
            self.app.hub.unsubscribe(client)
            self.close_connection = True
            if clean_end:
                try:
                    self.wfile.write(b"0\r\n\r\n")
                except OSError:
                    pass

    # -- static files

    def static(self, path):
        if path in STATIC_EXACT:
            rel = STATIC_EXACT[path]
        elif path.startswith(STATIC_PREFIXES):
            try:
                rel = urllib.parse.unquote(path[1:], errors="strict")
            except UnicodeDecodeError:
                return self.send_text(404, "not found")
        else:
            return self.send_text(404, "not found")
        parts = rel.split("/")
        if any(c in rel for c in "\\:\0") or any(p in ("", ".", "..") or p.startswith(".") for p in parts):
            return self.send_text(404, "not found")
        root = self.app.web_dir
        full = os.path.normcase(os.path.realpath(os.path.join(root, *parts)))
        try:
            inside = os.path.commonpath([full, root]) == root and full != root
        except ValueError:
            inside = False
        if not inside or not os.path.isfile(full):
            return self.send_text(404, "not found")
        ctype = MIME.get(os.path.splitext(full)[1], "application/octet-stream")
        cached = rel.startswith(STATIC_CACHED)
        self.send_file(full, ctype, "private, max-age=3600" if cached else "no-store", etag=cached)

    def pak3d(self, path):
        """GET /pak3d/<path>: a file of the --pak3d directory (only PAK3D_TYPES, no hidden names, no links out of
        the directory), with an ETag; names with a content hash (name.<hex>.ext) may be cached for a year."""
        root = self.app.pak3d
        if root is None:
            return self.send_text(404, "not found")
        try:
            rel = urllib.parse.unquote(path[len("/pak3d/"):], errors="strict")
        except UnicodeDecodeError:
            return self.send_text(404, "not found")
        parts = rel.split("/")
        if (any(c in rel for c in "\\:\0") or any(p in ("", ".", "..") or p.startswith(".") for p in parts)
                or os.path.splitext(rel)[1].lower() not in PAK3D_TYPES):
            return self.send_text(404, "not found")
        full = os.path.normcase(os.path.realpath(os.path.join(root, *parts)))
        try:
            inside = os.path.commonpath([full, root]) == root and full != root
        except ValueError:
            inside = False
        # a link may point to another file of the directory, not out of it nor to a hidden one (e.g. in .git)
        if (not inside or any(p.startswith(".") for p in os.path.relpath(full, root).split(os.sep))
                or os.path.splitext(full)[1].lower() not in PAK3D_TYPES or not os.path.isfile(full)):
            return self.send_text(404, "not found")
        cache = "private, max-age=31536000, immutable" if HASHED_NAME.search(parts[-1]) else "private, no-cache"
        self.send_file(full, MIME[os.path.splitext(full)[1].lower()], cache, etag=True)

    def send_file(self, full, ctype, cache, etag=False):
        """A static file: gzip compressed (cached in memory by path, mtime and size) for browsers that accept it
        when its type is COMPRESSIBLE; with etag an ETag of mtime and size and 304 for a matching If-None-Match."""
        try:
            f = open(full, "rb")
        except OSError:
            return self.send_text(404, "not found")
        with f:
            st = os.fstat(f.fileno())
            may = os.path.splitext(full)[1].lower() in COMPRESSIBLE and GZIP_MIN <= st.st_size <= STATIC_MAX
            headers = [("Vary", "Accept-Encoding")] if may else []
            accepts = may and self.accepts_gzip()
            key = (full, st.st_mtime_ns, st.st_size)
            gz = self.app.gzip_cache.get(key) if accepts else None
            tag = '"%x-%x"' % (st.st_mtime_ns, st.st_size) if etag else None
            if tag and self.etag_matches(tag):
                return self.send_not_modified(cache, headers + [("ETag", tag[:-1] + '-gz"' if accepts and gz != b""
                                                                 else tag)])
            if st.st_size > STATIC_MAX:
                return self.stream_file(f, st.st_size, ctype, cache, headers + ([("ETag", tag)] if tag else []))
            body = None if gz else f.read()  # with the gzip form cached the file need not be read
        if accepts and gz is None:
            gz = gzip_bytes(body)
            if len(gz) > len(body) * 0.9:
                gz = b""  # not worth it (e.g. a mesh that is compressed already)
            self.app.gzip_cache.put(key, gz)
        if gz:
            if tag:
                headers.append(("ETag", tag[:-1] + '-gz"'))
            return self.send_bytes(200, gz, ctype, cache, headers + [("Content-Encoding", "gzip")])
        if tag:
            headers.append(("ETag", tag))
        self.send_bytes(200, body, ctype, cache, headers)

    def stream_file(self, f, size, ctype, cache, headers):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache)
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        left = size
        while left > 0:
            data = f.read(min(1 << 20, left))
            if not data:
                self.close_connection = True  # the file became shorter: the length was wrong
                break
            self.wfile.write(data)
            left -= len(data)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = os.name != "nt"  # on Windows SO_REUSEADDR lets others take the port
    request_queue_size = 64

    def __init__(self, address, app):
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        self.app = app
        self.conn_lock = threading.Lock()
        self.conns = {}  # accepted socket -> address; every one has a thread until it is closed
        super().__init__(address, Handler)

    def verify_request(self, request, client_address):
        """Refuse (close at once) connections over MAX_CONNECTIONS, or over MAX_CONNECTIONS_PER_IP from one
        address that is not the loopback (a proxy or tunnel there carries all users): every connection
        holds a thread, and a client that never finishes its request would keep it for long."""
        ip = client_address[0]
        with self.conn_lock:
            if len(self.conns) >= MAX_CONNECTIONS:
                return False
            if not (ip.startswith(("127.", "::ffff:127.")) or ip == "::1") and \
                    sum(1 for a in self.conns.values() if a == ip) >= MAX_CONNECTIONS_PER_IP:
                return False
            self.conns[request] = ip
        return True

    def shutdown_request(self, request):
        with self.conn_lock:
            self.conns.pop(request, None)
        super().shutdown_request(request)

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return
        log.exception("request from %s failed", client_address[0])


# --- start ---------------------------------------------------------------------------------

def load_tokens(enable_admin):
    tokens = []
    roles = ["viewer", "player"] + (["admin"] if enable_admin else [])
    for role in roles:
        env = "SIMUTRANS_DASHBOARD_TOKEN_" + role.upper()
        token = os.environ.get(env, "").strip()
        if token:
            if len(token) < 16 or not re.fullmatch(r"[A-Za-z0-9_\-.~]+", token):
                raise SystemExit("%s must have at least 16 characters (letters, digits, - _ . ~)" % env)
        else:
            token = secrets.token_urlsafe(16)
        tokens.append((role, token))
    if not enable_admin and os.environ.get("SIMUTRANS_DASHBOARD_TOKEN_ADMIN"):
        log.warning("SIMUTRANS_DASHBOARD_TOKEN_ADMIN is ignored without --enable-admin")
    if len({t for _, t in tokens}) != len(tokens):
        raise SystemExit("the dashboard tokens of the roles must differ")
    return tokens


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Browser dashboard for Simutrans-Horizon: serves tools/dashboard/web and an HTTP/SSE API "
                    "that talks to a game started with -remote_control.")
    env_port = os.environ.get("SIMUTRANS_REMOTE_PORT")
    p.add_argument("--game-port", type=int, default=int(env_port) if env_port else DEFAULT_GAME_PORT,
                   help="remote control port of the game (default: $SIMUTRANS_REMOTE_PORT or %d)" % DEFAULT_GAME_PORT)
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP port of the dashboard (default %d)" % DEFAULT_PORT)
    p.add_argument("--bind", default="127.0.0.1",
                   help="address to listen on (default 127.0.0.1; see README before exposing it)")
    p.add_argument("--allowed-host", action="append", default=[], metavar="NAME",
                   help="additional Host name the dashboard answers to, e.g. a tunnel hostname (repeatable)")
    p.add_argument("--enable-admin", action="store_true",
                   help="also create an admin token (adds the cash command)")
    p.add_argument("--no-events", action="store_true",
                   help="do not subscribe the events of the game (protocol 2), only poll")
    p.add_argument("--pak3d", metavar="DIR", default=os.environ.get("SIMUTRANS_DASHBOARD_PAK3D") or None,
                   help="directory of a pak 3D (models and textures of the 3D view) served under /pak3d/ "
                        "(default: $SIMUTRANS_DASHBOARD_PAK3D, else none)")
    p.add_argument("--verbose", action="store_true", help="log every request")
    # hidden: short intervals and heartbeat for automated tests
    p.add_argument("--test-fast", action="store_true", help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    for name in args.allowed_host:
        if not re.fullmatch(r"(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.\-]+)(:\d+)?", name):
            p.error("--allowed-host takes a host name with an optional port, not %r" % name)
    return args


def main(argv=None):
    args = parse_args(argv)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(errors="backslashreplace")  # game texts may not fit the console code page
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    tokens = load_tokens(args.enable_admin)
    intervals, min_gap, heartbeat = dict(INTERVALS), dict(MIN_GAP), HEARTBEAT
    event_intervals, event_ms, arrivals_gap = dict(EVENT_INTERVALS), EVENT_INTERVAL_MS, ARRIVALS_GAP
    if args.test_fast:
        intervals = {k: v * 0.2 for k, v in intervals.items()}
        event_intervals = {k: v * 0.2 for k, v in event_intervals.items()}
        min_gap = {k: v * 0.2 for k, v in min_gap.items()}
        heartbeat = 2
        event_ms, arrivals_gap = 250, 0.25
    pak3d = args.pak3d
    if pak3d and not os.path.isdir(pak3d):
        # e.g. a volume that is not mounted: the dashboard works without models (the 3D view draws stand-ins)
        log.warning("--pak3d %s is not a directory, /pak3d/ answers 404", pak3d)
        pak3d = None
    app = App(args.port, args.game_port, args.bind, args.allowed_host, tokens, intervals, min_gap,
              heartbeat, args.verbose, event_intervals, not args.no_events, event_ms, arrivals_gap,
              1.0 if args.test_fast else ROUTE_REFRESH, 1.0 if args.test_fast else FACTORY_STATUS_TTL, pak3d,
              8 if args.test_fast else QUEUE_3D, 4 if args.test_fast else QUEUE_VEH)
    if not os.path.isfile(os.path.join(WEB_DIR, "index.html")):
        log.warning("%s has no index.html", WEB_DIR)
    try:
        server = Server((args.bind, args.port), app)
    except OSError as e:
        raise SystemExit("cannot listen on %s:%d: %s" % (args.bind, args.port, e))

    def stop(signum, frame):
        raise KeyboardInterrupt
    for name in ("SIGTERM", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stop)

    app.poller.start()
    if app.subscriber:
        app.subscriber.start()
    app.worker_3d.start()
    app.worker_veh.start()
    if args.bind in ("127.0.0.1", "0.0.0.0", "::", "localhost"):
        host = "127.0.0.1"
    else:
        host = "[%s]" % args.bind if ":" in args.bind else args.bind
    print("Simutrans dashboard %s on http://%s:%d/ (game port %d)%s" % (
        VERSION, host, args.port, args.game_port, ", pak 3D %s" % pak3d if pak3d else ""))
    for role, token in tokens:
        print("  %-6s http://%s:%d/?token=%s" % (role, host, args.port, token))
    if args.bind not in ("127.0.0.1", "::1", "localhost"):
        print("  warning: listening on %s; use TLS and an access proxy outside your LAN (see README)" % args.bind)
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        app.poller.stop()
        if app.subscriber:
            app.subscriber.stop()
        app.worker_3d.stop()
        app.worker_veh.stop()
        app.hub.close()
        end = time.monotonic() + 1.0  # let the event streams send their last chunk
        while app.hub.stream_count() and time.monotonic() < end:
            time.sleep(0.02)
        server.server_close()
        app.req_conn.close()


if __name__ == "__main__":
    main()
