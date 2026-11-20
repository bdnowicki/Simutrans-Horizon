#!/usr/bin/env python3
"""
MCP server (stdio transport) that lets AI agents such as Claude Code read and play
Simutrans. Everything is returned as JSON: game state, the map as a character grid,
players, cities, stations, convoys, lines, factories, open windows with their GUI
elements, plus mouse/keyboard input and the full Squirrel scripting API.

It talks to a running Simutrans that was started with  -remote_control [port]
(see src/simutrans/network/remote_control.h). Only the Python standard
library is used.

Environment variables:
  SIMUTRANS_REMOTE_PORT  port of the game (default 13360)
  SIMUTRANS_EXE          Simutrans executable, used by the launch_game tool
  SIMUTRANS_ARGS         default arguments for launch_game, e.g.
                         -set_basedir C:/simutrans -objects pak128/
"""

import base64
import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse

SERVER_NAME = "simutrans"
SERVER_VERSION = "1.2.0"
MAX_IMAGE_BYTES = 4 * 1024 * 1024  # stay below the 5 MB image limit of the Claude API
MAX_IMAGE_SIDE = 1568  # Claude scales larger images down anyway
HELLO = "HELLO simutrans-remote 1"
DEFAULT_PORT = 13360
KNOWN_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")

MAP_LEGEND = """\
Map grid (map_view): one string per map row y (top = region.y), one character per tile x (left = region.x).
terrain: . empty land  T trees  o rocks/ground objects  ~ water  f factory field
         R road  = rail  t tram  n narrow gauge  m monorail  g maglev  w canal  a runway/taxiway
         X crossing / two ways  P power line  B bridge  E elevated way  U tunnel entrance
         S station/stop  D depot  F factory  C city hall  h residential  c commercial  i industrial
         A attraction/monument  Q company headquarters  b other building
height:  ground height z = height_base + digit, digits 0-9 a-z A-Z (0..61); groundwater gives sea level
owner:   . nobody, 0-9 a-f player number (1 = public service)
slope:   . flat, n s e w = ramp in that direction, * other slope
The screen shows the map isometrically: x grows towards the bottom right, y towards the bottom left."""

INSTRUCTIONS = """\
Tools to read and play the transport simulation Simutrans. All results are JSON.
The game must run with -remote_control (use launch_game if it is not running).

Reading the game:
- game_status: date, speed, money, selected tool, view center, open windows with their
  buttons/labels/tabs/text fields (screen positions).
- map_view: the map around the view (or any region) as character grids with stations,
  factories, cities, convoys, depots and labels in it. tile_info: everything on one tile.
- players, cities, stations, station_details, convoys, lines, factories: game objects.
- run_squirrel: any other query through the scripting API.
- screenshot: an image of the game window. Use it only after the JSON tools: map_view and
  tile_info are exact, cheap and give coordinates; a screenshot is costly and approximate.
  It is meant for what JSON does not show (graphics, charts, layout of a window, a visual check).

Acting:
- use_tool applies a build/remove tool exactly at map coordinates (preferred for building).
- click_element clicks a GUI element by its text; click/drag/press_key/type_text for
  everything else. Screen positions of map tiles come from tile_to_screen.
- Input is handled in the next frames; actions report the open windows afterwards
  (ui=true includes their elements).
- change_cash adds money to (or takes it from) a player's bank account.
Useful keys: escape closes the top window, "p" pauses, "," and "." change the speed.

""" + MAP_LEGEND

SQUIRREL_HELP = """\
Runs Squirrel code inside the game with the Simutrans scripting API (AI flavour) and
returns the result as JSON. The code may be a single expression or statements with
'return'. Scalars, arrays, tables and the data members of objects are converted.
Errors come back with line numbers. The active player is the script's player.

Examples:
  world.get_time()                                   // year, month, ticks
  player_x(0).get_name() + " " + player_x(0).get_current_cash()
  local r = []; foreach (c in city_list_x()) r.append({name=c.get_name(), citizens=c.get_citizens()[0], pos=c.get_pos()}); return r
  local r = []; foreach (h in halt_list_x()) r.append({name=h.get_name(), owner=h.get_owner().get_name()}); return r
  local r = []; foreach (f in factory_list_x()) r.append({name=f.get_name(), x=f.x, y=f.y}); return r
  local r = []; foreach (l in player_x(0).get_line_list()) r.append(l.get_name()); return r
  square_x(10,20).get_ground_tile()                  // tile_x with height z
  local r = []; foreach (w in way_desc_x.get_available_ways(wt_road, st_flat)) r.append(w.get_name()); return r
  command_x(tool_build_way).work(player_x(0), coord3d(10,20,0), coord3d(15,20,0), "<way name>")  // null = success
  command_x(tool_remover).work(player_x(0), coord3d(10,20,0))
Lists like city_list_x() must be iterated with foreach (no random access).
Tool constants: tool_build_way, tool_build_bridge, tool_build_tunnel, tool_build_station,
tool_build_depot, tool_remover, tool_raise_land, tool_lower_land, tool_setslope, tool_build_wayobj,
tool_build_roadsign, tool_build_house, tool_headquarter, tool_buy_house, tool_change_water_height ...
Way types: wt_road, wt_rail, wt_water, wt_monorail, wt_maglev, wt_tram, wt_narrowgauge, wt_air, wt_power.
API reference: https://dwachs.github.io/simutrans-sqapi-doc/ (AI part); script coordinates equal
map coordinates unless the map was rotated after the game started.
"""


class GameError(Exception):
    """Error reported by the game or the connection, shown to the agent."""


class GameConnection:
    """Line based connection to the remote control port of the game."""

    def __init__(self, port):
        self.port = port
        self.sock = None
        self.file = None
        self.lock = threading.Lock()

    def close(self):
        try:
            if self.file:
                self.file.close()
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        self.sock = None
        self.file = None

    def connect(self):
        try:
            sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        except OSError as e:
            raise GameError(
                f"Simutrans is not reachable on 127.0.0.1:{self.port} ({e}). "
                "Start the game with -remote_control (or use the launch_game tool).") from e
        sock.settimeout(180)
        f = sock.makefile("rwb")
        f.write((HELLO + "\n").encode("utf-8"))
        f.flush()
        line = f.readline()
        if not line:
            sock.close()
            raise GameError("the game closed the connection during the handshake")
        reply = json.loads(line.decode("utf-8", errors="replace"))
        if not reply.get("ok"):
            sock.close()
            raise GameError(f"handshake rejected: {reply}")
        self.sock = sock
        self.file = f

    def request(self, command, **args):
        params = {}
        for k, v in args.items():
            if v is None:
                continue
            if isinstance(v, bool):
                v = "1" if v else "0"
            elif isinstance(v, (list, tuple)):
                v = ",".join(str(x) for x in v)
            params[k] = str(v)
        line = command
        if params:
            line += " " + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        data = (line + "\n").encode("utf-8")

        with self.lock:
            for attempt in range(2):
                fresh = self.file is None
                if fresh:
                    self.connect()
                try:
                    self.file.write(data)
                    self.file.flush()
                    reply = self.file.readline()
                except socket.timeout as e:
                    self.close()
                    raise GameError("the game did not answer in time (busy loading?)") from e
                except OSError:
                    reply = b""
                if reply:
                    break
                # stale connection (e.g. game restarted): reconnect once
                self.close()
                if fresh or attempt == 1:
                    raise GameError("the game closed the connection")
        result = json.loads(reply.decode("utf-8", errors="replace"))
        if not result.get("ok"):
            raise GameError(result.get("error") or "unknown error")
        result.pop("ok", None)
        return result


PORT = int(os.environ.get("SIMUTRANS_REMOTE_PORT", DEFAULT_PORT))
game = GameConnection(PORT)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def text(obj):
    if isinstance(obj, str):
        return {"type": "text", "text": obj}
    return {"type": "text", "text": json.dumps(obj, ensure_ascii=False, separators=(",", ":"))}


def add_centers(windows):
    for win in windows:
        for el in win.get("elements", []):
            el["cx"] = el["x"] + el["w"] // 2
            el["cy"] = el["y"] + el["h"] // 2
    return windows


def after_input(args, done):
    """GUI input is processed by the game in the next frames: wait, then report the windows."""
    wait_ms = args.get("wait_ms", 300)
    time.sleep(max(0, min(int(wait_ms), 10000)) / 1000.0)
    with_elements = bool(args.get("ui"))
    windows = game.request("windows", components=with_elements)["windows"]
    if with_elements:
        add_centers(windows)
    else:
        windows = [{"title": w["title"], "top": w["top"], "x": w["x"], "y": w["y"], "w": w["w"], "h": w["h"]}
                   for w in windows]
    return [text({"done": done, "open_windows": windows})]


def squirrel_literal(value):
    return json.dumps(value)  # JSON strings are valid Squirrel string literals


def squirrel_pos(x, y, z):
    if z is None:
        return f"square_x({int(x)},{int(y)}).get_ground_tile()"
    return f"coord3d({int(x)},{int(y)},{int(z)})"


def pick(args, *names):
    return {n: args.get(n) for n in names}


# ---------------------------------------------------------------------------
# tools: reading
# ---------------------------------------------------------------------------

def tool_game_status(args):
    status = game.request("status", components=args.get("ui", True))
    add_centers(status.get("windows", []))
    return [text(status)]


def tool_map_view(args):
    layers = args.get("layers") or ["terrain", "height"]
    return [text(game.request("map", layers=layers, features=args.get("features", True),
                              max_size=args.get("max_size"), **pick(args, "x", "y", "w", "h")))]


def tool_ui_elements(args):
    windows = add_centers(game.request("windows", components=True,
                                       max_elements=args.get("max_elements", 300))["windows"])
    flt = (args.get("window") or "").lower()
    if flt:
        windows = [w for w in windows if flt in (w.get("title") or "").lower()]
    return [text({"windows": windows})]


def tool_tile_info(args):
    return [text(game.request("tile", x=args["x"], y=args["y"]))]


def tool_players(args):
    return [text(game.request("players"))]


def tool_cities(args):
    return [text(game.request("cities", limit=args.get("limit")))]


def tool_stations(args):
    return [text(game.request("stations", **pick(args, "owner", "limit")))]


def tool_station_details(args):
    return [text(game.request("station", **pick(args, "id", "x", "y")))]


def tool_convoys(args):
    return [text(game.request("convoys", **pick(args, "owner", "limit")))]


def tool_lines(args):
    return [text(game.request("lines", **pick(args, "owner", "limit")))]


def tool_factories(args):
    return [text(game.request("factories", **pick(args, "x1", "y1", "x2", "y2", "limit")))]


def tool_messages(args):
    return [text(game.request("messages", count=args.get("count", 20)))]


def tool_screen_to_tile(args):
    return [text(game.request("tile_at", x=args["x"], y=args["y"]))]


def tool_tile_to_screen(args):
    return [text(game.request("screen_pos", x=args["x"], y=args["y"], z=args.get("z")))]


def tool_run_squirrel(args):
    r = game.request("eval", code=args["code"], ops=args.get("max_ops"), reset=args.get("reset"),
                     unowned=args.get("unowned"))
    return [text({"result": r.get("result")})]


def find_window(title_filter):
    """Open window whose title contains title_filter (the top window first) and the titles of the
    windows that are drawn over it."""
    wanted = title_filter.lower()
    windows = game.request("windows", components=False)["windows"]
    windows.sort(key=lambda w: (not w.get("top"), -w.get("index", 0)))
    for win in windows:
        if wanted in (win.get("title") or "").lower():
            covered_by = [o.get("title") for o in windows
                          if o.get("index", 0) > win.get("index", 0)
                          and o["x"] < win["x"] + win["w"] and win["x"] < o["x"] + o["w"]
                          and o["y"] < win["y"] + win["h"] and win["y"] < o["y"] + o["h"]]
            return win, covered_by
    titles = [w.get("title") for w in windows]
    raise GameError(f"no open window with '{title_filter}' in its title; open windows: {titles}")


def tool_screenshot(args):
    area = {}
    covered_by = []
    if args.get("window"):
        win, covered_by = find_window(args["window"])
        area = {k: win[k] for k in ("x", "y", "w", "h")}
    elif args.get("w") is not None and args.get("h") is not None:
        area = {"x": args.get("x", 0), "y": args.get("y", 0), "w": args["w"], "h": args["h"]}
    scale = args.get("scale")
    if scale is None:
        # smallest scale that fits the image into the size Claude actually looks at
        if area:
            w, h = area["w"], area["h"]
        else:
            screen = game.request("status", components=False)["screen"]
            w, h = screen["w"], screen["h"]
        scale = max(1, -(-max(int(w), int(h)) // MAX_IMAGE_SIDE))

    fd, path = tempfile.mkstemp(prefix="simutrans_screenshot_", suffix=".png")
    os.close(fd)
    try:
        info = game.request("screenshot", path=path, scale=scale, **area)
        with open(path, "rb") as f:
            data = f.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    if len(data) > MAX_IMAGE_BYTES:
        raise GameError(f"screenshot is {len(data) // 1024} KB, too large to return; "
                        "use a higher scale or a smaller region")
    info.pop("path", None)
    if args.get("window"):
        info["window"] = win.get("title")
        if covered_by:
            # the image shows the screen area of the window, so these windows hide parts of it
            info["covered_by"] = covered_by
            info["hint"] = "click the title bar of the window to bring it to the top, then take the screenshot again"
    info["note"] = "image of the screen; for exact tiles and coordinates use map_view / tile_info"
    return [text(info), {"type": "image", "data": base64.b64encode(data).decode("ascii"), "mimeType": "image/png"}]


# ---------------------------------------------------------------------------
# tools: acting
# ---------------------------------------------------------------------------

def tool_click(args):
    game.request("click", x=args["x"], y=args["y"], button=args.get("button", "left"),
                 count=args.get("count", 1), shift=args.get("shift"), ctrl=args.get("ctrl"))
    return after_input(args, f"clicked {args.get('button', 'left')} at ({args['x']},{args['y']})")


def tool_click_element(args):
    wanted = args["text"].strip().lower()
    win_filter = (args.get("window") or "").lower()
    types = args.get("types")
    windows = add_centers(game.request("windows", components=True, max_elements=1000)["windows"])
    # top window first
    windows.sort(key=lambda w: (not w.get("top"), -w.get("index", 0)))
    exact, partial = [], []
    for win in windows:
        if win_filter and win_filter not in (win.get("title") or "").lower():
            continue
        for el in win.get("elements", []):
            if types and el["type"] not in types:
                continue
            t = (el.get("text") or "").strip().lower()
            if not t:
                continue
            if t == wanted:
                exact.append((win, el))
            elif wanted in t:
                partial.append((win, el))
    matches = exact or partial
    if not matches:
        raise GameError(f"no visible element with text '{args['text']}' (use ui_elements to list them)")
    index = int(args.get("index", 0))
    if index >= len(matches):
        raise GameError(f"only {len(matches)} matching elements")
    win, el = matches[index]
    game.request("click", x=el["cx"], y=el["cy"], button=args.get("button", "left"))
    others = "" if len(matches) == 1 else f" ({len(matches)} matches, used index {index})"
    return after_input(args, f"clicked {el['type']} '{el.get('text')}' in window '{win.get('title')}' "
                             f"at ({el['cx']},{el['cy']}){others}")


def tool_drag(args):
    game.request("drag", x1=args["x1"], y1=args["y1"], x2=args["x2"], y2=args["y2"],
                 button=args.get("button", "left"), steps=args.get("steps", 10),
                 shift=args.get("shift"), ctrl=args.get("ctrl"))
    return after_input(args, f"dragged from ({args['x1']},{args['y1']}) to ({args['x2']},{args['y2']})")


def tool_move_mouse(args):
    game.request("move", x=args["x"], y=args["y"])
    return after_input(args, f"mouse moved to ({args['x']},{args['y']})")


def tool_scroll_wheel(args):
    game.request("wheel", x=args["x"], y=args["y"], dir=args.get("direction", "up"), count=args.get("count", 1))
    return after_input(args, f"wheel {args.get('direction', 'up')} x{args.get('count', 1)}")


def tool_press_key(args):
    r = game.request("key", key=args["key"], shift=args.get("shift"), ctrl=args.get("ctrl"),
                     count=args.get("count", 1))
    return after_input(args, f"pressed key '{args['key']}' (code {r.get('code')})")


def tool_type_text(args):
    game.request("text", text=args["text"])
    return after_input(args, f"typed {len(args['text'])} characters")


def tool_center_view(args):
    r = game.request("view", x=args["x"], y=args["y"], z=args.get("z"))
    return after_input(args, f"view centered on {r.get('center')}")


def tool_zoom(args):
    r = game.request("zoom", dir=args.get("direction", "in"), count=args.get("count", 1))
    return after_input(args, f"zoom index {r.get('zoom_index')}, tile width {r.get('tile_raster_width')} px")


def tool_set_pause(args):
    return [text(game.request("pause", on=args.get("paused", True)))]


def tool_set_fast_forward(args):
    return [text(game.request("fast_forward", on=args.get("enabled", True)))]


def tool_change_cash(args):
    return [text(game.request("cash", player=args.get("player"), amount=args["amount"]))]


def tool_use_tool(args):
    tool = args["tool"]
    tool_expr = str(int(tool)) if str(tool).lstrip("-").isdigit() else str(tool)
    if not tool_expr.replace("_", "").isalnum():
        raise GameError("tool must be a constant name like tool_build_way or a numeric id")
    player = f"player_x({int(args['player'])})" if args.get("player") is not None else "player_x.self()"
    start = squirrel_pos(args["x"], args["y"], args.get("z"))
    params = [player, start]
    if args.get("x2") is not None and args.get("y2") is not None:
        params.append(squirrel_pos(args["x2"], args["y2"], args.get("z2")))
        params.append(squirrel_literal(args.get("param", "")))
    elif args.get("param") is not None:
        params.append(squirrel_literal(args["param"]))
    code = f"return command_x({tool_expr}).work({', '.join(params)})"
    r = game.request("eval", code=code)
    result = r.get("result")
    if result:
        raise GameError(f"tool failed: {result}")
    return after_input(args, f"tool executed: {code}")


def tool_wait(args):
    seconds = max(0.0, min(float(args.get("seconds", 5)), 300.0))
    time.sleep(seconds)
    st = game.request("status")
    return [text({"waited_seconds": seconds, "date": st["world"]["date"], "paused": st["world"]["paused"],
                  "player": st.get("player")})]


def tool_launch_game(args):
    try:
        game.request("ping")
        return [text("Simutrans is already running with remote control.")]
    except GameError:
        pass
    exe = args.get("exe") or os.environ.get("SIMUTRANS_EXE")
    if not exe or not os.path.isfile(exe):
        raise GameError("Simutrans executable not found; pass exe or set SIMUTRANS_EXE")
    if args.get("args") is not None:
        extra = list(args["args"])
    else:
        extra = [a.strip('"') for a in shlex.split(os.environ.get("SIMUTRANS_ARGS", ""), posix=False)]
    cmd = [exe] + extra + ["-remote_control", str(PORT)]
    flags = 0
    if os.name == "nt":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    proc = subprocess.Popen(cmd, cwd=os.path.dirname(os.path.abspath(exe)), stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags,
                            start_new_session=(os.name != "nt"))
    timeout = float(args.get("timeout", 240))
    start = time.time()
    while time.time() - start < timeout:
        if proc.poll() is not None:
            raise GameError(f"Simutrans exited with code {proc.returncode}; command: {cmd}")
        try:
            game.request("ping")
            return [text(f"Simutrans started (pid {proc.pid}) after {time.time() - start:.0f}s: {cmd}")]
        except GameError:
            time.sleep(1)
    raise GameError(f"Simutrans started (pid {proc.pid}) but remote control did not answer within {timeout:.0f}s")


# ---------------------------------------------------------------------------
# tool table
# ---------------------------------------------------------------------------

def schema(props=None, required=None):
    s = {"type": "object", "properties": props or {}}
    if required:
        s["required"] = required
    return s


INT = {"type": "integer"}
BOOL = {"type": "boolean"}
OWNER = {"type": "integer", "description": "only objects of this player number"}
LIMIT = {"type": "integer", "description": "maximum number of entries"}
AFTER = {
    "wait_ms": {"type": "integer", "description": "milliseconds to wait for the game to process the input (default 300)"},
    "ui": {"type": "boolean", "description": "include the GUI elements of the open windows in the result"},
}
MODS = {"shift": BOOL, "ctrl": BOOL}
BUTTON = {"type": "string", "enum": ["left", "right", "middle"]}


def with_after(props):
    p = dict(props)
    p.update(AFTER)
    return p


TOOLS = [
    # --- reading
    ("game_status", tool_game_status,
     "Current game state as JSON: date, pause/speed, map size, active player with cash and net wealth, "
     "selected tool, view center, screen size, scenario and the open windows with their GUI elements "
     "(buttons, labels, tabs, text fields with screen positions; ui=false leaves the elements out).",
     schema({"ui": BOOL}), True),
    ("map_view", tool_map_view,
     "The map as JSON: character grids (layers terrain, height, owner, slope) for the visible area around the "
     "view center or for region x,y,w,h, plus the cities, stations, factories, convoys, depots and labels in it.\n"
     + MAP_LEGEND,
     schema({"x": INT, "y": INT, "w": INT, "h": INT,
             "layers": {"type": "array", "items": {"type": "string", "enum": ["terrain", "height", "owner", "slope"]},
                        "description": "default [terrain, height]"},
             "features": {"type": "boolean", "description": "include objects in the region (default true)"},
             "max_size": {"type": "integer", "description": "maximum width/height in tiles (default 96, max 512)"}}),
     True),
    ("tile_info", tool_tile_info,
     "Everything on one map tile: grounds (incl. bridges/tunnels), ways, buildings, vehicles, owner, station, city.",
     schema({"x": INT, "y": INT}, ["x", "y"]), True),
    ("players", tool_players,
     "All players: cash, net wealth, this/last month revenue, costs, profit, transported passengers/mail/goods, "
     "number of lines/convoys/stations, headquarters.", schema(), True),
    ("cities", tool_cities,
     "Cities sorted by size: town hall position, area, citizens, growth, buildings and last month's "
     "passenger/mail/goods service.", schema({"limit": LIMIT}), True),
    ("stations", tool_stations,
     "Stations/stops: id, name, owner, position, size, accepted cargo and waiting passengers/mail/goods.",
     schema({"owner": OWNER, "limit": LIMIT}), True),
    ("station_details", tool_station_details,
     "One station by id or by a tile position: happy/unhappy/no-route passengers, arrivals, departures, tiles.",
     schema({"id": INT, "x": INT, "y": INT}), True),
    ("convoys", tool_convoys,
     "Vehicles/convoys: id, name, owner, position, state, speed, load, line, next stop, profit.",
     schema({"owner": OWNER, "limit": LIMIT}), True),
    ("lines", tool_lines,
     "Lines: id, name, owner, type, number of convoys, stops (positions and station names), profit, "
     "transported and capacity this and last month.", schema({"owner": OWNER, "limit": LIMIT}), True),
    ("factories", tool_factories,
     "Factories with production, input/output storage and number of suppliers/consumers; optional region "
     "x1,y1,x2,y2.", schema({"x1": INT, "y1": INT, "x2": INT, "y2": INT, "limit": LIMIT}), True),
    ("messages", tool_messages, "Latest messages of the message center (newest first), incl. scenario messages.",
     schema({"count": INT}), True),
    ("ui_elements", tool_ui_elements,
     "Open windows with their visible GUI elements (buttons, labels, tabs, text fields, list items), "
     "each with screen rectangle and center (cx, cy).",
     schema({"window": {"type": "string", "description": "only windows whose title contains this text"},
             "max_elements": INT}), True),
    ("tile_to_screen", tool_tile_to_screen, "Screen position of the center of a map tile (z = ground if omitted).",
     schema({"x": INT, "y": INT, "z": INT}, ["x", "y"]), True),
    ("screen_to_tile", tool_screen_to_tile, "Map tile under a screen position.",
     schema({"x": INT, "y": INT}, ["x", "y"]), True),
    ("run_squirrel", tool_run_squirrel, SQUIRREL_HELP,
     schema({"code": {"type": "string"},
             "max_ops": {"type": "integer", "description": "opcode budget (default 2000000)"},
             "reset": {"type": "boolean", "description": "start with a fresh script VM"},
             "unowned": {"type": "boolean", "description": "run like a scenario script: tools may act for any "
                         "player, also password-locked ones such as the public player (not in network games)"}},
            ["code"]), False),
    ("screenshot", tool_screenshot,
     "PNG image of the game window, of one open window (by title) or of a screen region x,y,w,h. "
     "Second choice after the JSON tools: for the map use map_view / tile_info, for windows ui_elements, "
     "which are exact and much cheaper. Use a screenshot only for what they do not show (graphics, charts, "
     "window layout, a visual check of a result). A window is captured as its screen area, so windows "
     "on top of it show in the image (listed as covered_by). scale 1-8 shrinks the image; by default "
     "the smallest scale that keeps the longer side within 1568 px.",
     schema({"window": {"type": "string", "description": "capture the open window whose title contains this text"},
             "x": INT, "y": INT,
             "w": {"type": "integer", "description": "region width in screen pixels (with h, x, y)"},
             "h": {"type": "integer", "description": "region height in screen pixels"},
             "scale": {"type": "integer", "description": "divide width and height by this factor (1-8)"}}),
     True),
    # --- acting
    ("use_tool", tool_use_tool,
     "Apply a game tool exactly at map coordinates as the active player, e.g. tool=tool_build_way with "
     "x,y -> x2,y2 and param=<way name>, or tool=tool_remover at x,y. z defaults to the ground height. "
     "Returns an error text if the game refuses (cost, scenario rules, terrain).",
     schema(with_after({"tool": {"type": "string", "description": "tool constant like tool_build_way, or numeric id"},
                        "x": INT, "y": INT, "z": INT, "x2": INT, "y2": INT, "z2": INT,
                        "param": {"type": "string", "description": "tool parameter, usually a descriptor name"},
                        "player": INT}), ["tool", "x", "y"]), False),
    ("click_element", tool_click_element,
     "Click a visible GUI element (button, tab, list item, ...) by its text, exact match preferred, top window first.",
     schema(with_after({"text": {"type": "string"},
                        "window": {"type": "string", "description": "restrict to windows whose title contains this"},
                        "types": {"type": "array", "items": {"type": "string"},
                                  "description": "restrict to element types, e.g. [\"button\",\"tab\"]"},
                        "index": {"type": "integer", "description": "which match to use if there are several (default 0)"},
                        "button": BUTTON}), ["text"]), False),
    ("click", tool_click,
     "Mouse click at screen coordinates (GUI or map). On the map this applies the selected tool to the tile "
     "under the cursor; use tile_to_screen for the position of a tile.",
     schema(with_after(dict({"x": INT, "y": INT, "button": BUTTON,
                             "count": {"type": "integer", "description": "2 = double click"}}, **MODS)), ["x", "y"]), False),
    ("drag", tool_drag,
     "Press a mouse button at (x1,y1), move to (x2,y2) and release (right-drag scrolls the map, left-drag "
     "moves windows or builds with drag tools).",
     schema(with_after(dict({"x1": INT, "y1": INT, "x2": INT, "y2": INT, "button": BUTTON, "steps": INT}, **MODS)),
            ["x1", "y1", "x2", "y2"]), False),
    ("move_mouse", tool_move_mouse, "Move the mouse (hover, tool preview).",
     schema(with_after({"x": INT, "y": INT}), ["x", "y"]), False),
    ("scroll_wheel", tool_scroll_wheel, "Mouse wheel at a screen position (zooms the map, scrolls lists).",
     schema(with_after({"x": INT, "y": INT, "direction": {"type": "string", "enum": ["up", "down"]}, "count": INT}),
            ["x", "y"]), False),
    ("press_key", tool_press_key,
     "Press a key: a single character (keyboard shortcut, e.g. 'p' pause) or a name: escape, enter, backspace, "
     "tab, delete, space, home, end, pageup, pagedown, up, down, left, right, f1..f15.",
     schema(with_after(dict({"key": {"type": "string"}, "count": INT}, **MODS)), ["key"]), False),
    ("type_text", tool_type_text, "Type text into the focused text field (click it first).",
     schema(with_after({"text": {"type": "string"}}), ["text"]), False),
    ("center_view", tool_center_view, "Scroll the map so that tile x,y (z = ground if omitted) is in the center.",
     schema(with_after({"x": INT, "y": INT, "z": INT}), ["x", "y"]), False),
    ("zoom", tool_zoom, "Zoom the map in or out.",
     schema(with_after({"direction": {"type": "string", "enum": ["in", "out"]}, "count": INT})), False),
    ("set_pause", tool_set_pause, "Pause or resume the game.", schema({"paused": BOOL}), False),
    ("set_fast_forward", tool_set_fast_forward, "Enable or disable fast forward.", schema({"enabled": BOOL}), False),
    ("change_cash", tool_change_cash,
     "Add money to (or with a negative amount take money from) a player's bank account, in credits "
     "(max +-1e9 per call). Works like book_cash() of scenario scripts. Returns cash before and after; "
     "pending=true means the game has not booked it (network game: done by the server; or refused).",
     schema({"amount": {"type": "number", "description": "credits, e.g. 1000000 or -50000"},
             "player": {"type": "integer", "description": "player number (default: active player)"}}, ["amount"]),
     False),
    ("wait", tool_wait, "Let the game run for some seconds (max 300), then report the date.",
     schema({"seconds": {"type": "number"}}), True),
    ("launch_game", tool_launch_game,
     "Start Simutrans with remote control enabled if it is not running. Uses SIMUTRANS_EXE / SIMUTRANS_ARGS "
     "unless exe / args are given, e.g. args [\"-objects\", \"pak128/\", \"-scenario\", \"new_york_city\"].",
     schema({"exe": {"type": "string"}, "args": {"type": "array", "items": {"type": "string"}},
             "timeout": {"type": "number"}}), False),
]

TOOL_BY_NAME = {t[0]: t for t in TOOLS}


def tool_list():
    tools = []
    for name, _, desc, input_schema, read_only in TOOLS:
        tools.append({
            "name": name,
            "description": desc,
            "inputSchema": input_schema,
            "annotations": {"readOnlyHint": read_only, "openWorldHint": False},
        })
    return tools


# ---------------------------------------------------------------------------
# JSON-RPC over stdio
# ---------------------------------------------------------------------------

def send(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(msg):
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if msg_id is None:
        return None  # notification, e.g. notifications/initialized

    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if requested in KNOWN_PROTOCOL_VERSIONS or (
            isinstance(requested, str) and len(requested) == 10 and requested[4] == "-") else KNOWN_PROTOCOL_VERSIONS[1]
        return {"jsonrpc": "2.0", "id": msg_id, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": INSTRUCTIONS,
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": tool_list()}}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        entry = TOOL_BY_NAME.get(name)
        if entry is None:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32602, "message": f"unknown tool {name}"}}
        try:
            content = entry[1](args)
            return {"jsonrpc": "2.0", "id": msg_id, "result": {"content": content, "isError": False}}
        except GameError as e:
            return {"jsonrpc": "2.0", "id": msg_id, "result": {"content": [text(str(e))], "isError": True}}
        except KeyError as e:
            return {"jsonrpc": "2.0", "id": msg_id,
                    "result": {"content": [text(f"missing argument {e}")], "isError": True}}
        except Exception as e:  # report bugs instead of dying
            traceback.print_exc(file=sys.stderr)
            return {"jsonrpc": "2.0", "id": msg_id,
                    "result": {"content": [text(f"internal error: {e!r}")], "isError": True}}
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    # stdout carries the protocol: make sure it is UTF-8 without newline translation
    sys.stdout = open(sys.stdout.fileno(), "w", encoding="utf-8", newline="\n", buffering=1, closefd=False)
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        messages = msg if isinstance(msg, list) else [msg]
        for m in messages:
            reply = handle(m)
            if reply is not None:
                send(reply)


if __name__ == "__main__":
    main()
