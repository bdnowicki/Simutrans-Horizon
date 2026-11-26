"""
Projects of the AI team (contract R2 "Projects"): an agent proposes a list of game operations, the user approves the
whole project with one click, and deterministic code (team.executor) carries it out. This module is the part before
the approval: the operation types and which role may use which, the JSON schema of the propose_project tool, the
validation of a proposal, the cost estimate from dry runs of the engine and the geometry of the map preview.

Nothing here changes the game: the engine is asked only for reads and dry runs (status, players, tile, depot, line,
convoy, estimate, plan_way, desc_list). The estimate is what the money rules of the executor measure against
(rule 15: no start when cash - estimate.total < 0; stop when the actual cost exceeds estimate.total by more than 20 %),
so it errs on the side of a higher total and says in "warnings" where it can only approximate.

Positions are [x, y] or [x, y, z]; ids of lines and convoys are numbers, or "$name" for the `ref` of an earlier op of
the same project (create_line defines line refs, buy_convoy convoy refs). Every problem of a proposal is collected and
raised at once (ProjectError.errors), so the model can fix all of them in one go.
"""

import re

from . import TeamError
from .api import present_project

# -- operation types and roles -------------------------------------------------------------------------------------

INFRA_OPS = ("build_way", "build_station", "build_depot", "build_roadsign", "build_wayobj", "remove", "remove_way")
LINE_OPS = ("create_line", "set_line_schedule", "delete_line")
VEHICLE_OPS = ("buy_convoy", "assign_line", "withdraw", "replace_convoy", "sell")
OP_TYPES = INFRA_OPS + LINE_OPS + VEHICLE_OPS

# role -> the op types it may propose (the executor runs them all the same way; infrastructure of the designer is
# "executed as engineer" only in the sense that the same deterministic code builds it)
ROLE_OPS = {
    "coordinator": frozenset(),
    "analyst": frozenset(),
    "accountant": frozenset(),
    "designer": frozenset(INFRA_OPS),
    "engineer": frozenset(INFRA_OPS),
    "logistician": frozenset(LINE_OPS + ("buy_convoy", "assign_line")),
    "dispatcher": frozenset(("buy_convoy", "assign_line", "withdraw", "set_line_schedule")),
    "fleet_manager": frozenset(("buy_convoy", "replace_convoy", "sell", "withdraw")),
}

# op type -> (required fields, optional fields); "type" is always required, anything else is refused
FIELDS = {
    "build_way": (("from", "to", "way"), ("bridge", "tunnel", "straight")),
    "build_station": (("at", "building"), ("rotation",)),
    "build_depot": (("at", "building"), ()),
    "build_roadsign": (("at", "sign"), ()),
    "build_wayobj": (("from", "to", "wayobj"), ()),
    "remove": (("at",), ("kind",)),
    "remove_way": (("from", "to", "waytype"), ()),
    "create_line": (("ref", "waytype", "stops"), ("name",)),
    "set_line_schedule": (("line", "stops"), ()),
    "delete_line": (("line",), ()),
    "buy_convoy": (("depot", "vehicles"), ("ref", "count", "line", "start")),
    "assign_line": (("convoy", "line"), ()),
    "withdraw": (("convoy",), ("on",)),
    "replace_convoy": (("convoy", "vehicles"), ("depot",)),
    "sell": (("convoy",), ()),
}

# -- limits (also in the tool schema) ------------------------------------------------------------------------------

MAX_OPS = 40
MAX_TITLE = 120
MAX_RATIONALE = 2000
MAX_COUNT = 20            # convoys of one buy_convoy
MAX_CONVOYS = 50          # convoys bought by one project (buy_convoy counts + replace_convoy)
MAX_VEHICLES = 32         # vehicles of one convoy
MAX_STOPS = 64
MAX_NAME = 128            # object names (pak names)
MAX_LINE_NAME = 100
MAX_WAIT = 65535          # schedule wait: maximum waiting time in 1/65536 of a month
OVERRUN = 1.2             # the executor stops when the actual cost exceeds estimate.total * OVERRUN
REMOVE_BUILDING = 1000    # the game's default demolition cost of a stop or depot building (cost_multiply_remove_haus)

REF_RE = re.compile(r"\$?([A-Za-z0-9_-]{1,32})")   # used with fullmatch

# create_line waytype -> line type = schedule type of the engine (1 road, 2 train, 3 ship, 4 air, 5 monorail, 6 tram,
# 7 maglev, 8 narrow gauge)
LINE_TYPES = {"road": 1, "rail": 2, "track": 2, "train": 2, "water": 3, "ship": 3, "air": 4, "monorail": 5,
              "tram": 6, "maglev": 7, "narrowgauge": 8}
# line type -> the waytype name the engine uses for vehicles, depots and ways ("road", "track", ...)
LINE_WAYTYPE = {1: "road", 2: "track", 3: "water", 4: "air", 5: "monorail", 6: "tram", 7: "maglev", 8: "narrowgauge"}
WAYTYPE_LINE = {v: k for k, v in LINE_WAYTYPE.items()}
# line type names of the `line`/`lines` reads (untranslated English of the game, and the fake engine's) -> line type
LINE_TYPE_NAMES = {"truck": 1, "bus": 1, "road": 1, "train": 2, "rail": 2, "track": 2, "ship": 3, "water": 3,
                   "aircraft": 4, "air": 4, "monorail": 5, "tram": 6, "maglev": 7, "narrowgauge": 8}
# remove_way waytype -> the waytype number tool_remove_way takes (the engine: 2 also for tram tracks)
REMOVE_WAYTYPES = {"road": 1, "rail": 2, "track": 2, "tram": 2, "water": 3, "monorail": 5, "maglev": 6,
                   "narrowgauge": 8, "air": 16}
REMOVE_WAYTYPE_NAME = {1: "road", 2: "track", 3: "water", 5: "monorail", 6: "maglev", 8: "narrowgauge", 16: "air"}
# remove kind -> param of tool_remover (none: what the remover takes first, e.g. the stop building)
REMOVE_KINDS = {"signal": "8", "roadsign": "19", "wayobj": "25", "depot": "12"}
WAYTYPE_ENUM = ("road", "rail", "track", "water", "air", "monorail", "tram", "maglev", "narrowgauge")

# tile object types (the `tile` read) that count as ways of a square, and those that are not property
WAYISH = ("way", "bridge", "tunnel")
MOVING = ("cursor", "cloud", "pedestrian", "citycar", "road_vehicle", "rail_vehicle", "monorail_vehicle",
          "maglev_vehicle", "narrowgauge_vehicle", "ship", "aircraft", "movingobj")


class ProjectError(TeamError):
    """A proposal that cannot be accepted. errors: every problem found (strings naming the op as ops[i]), for the
    model to fix them all at once."""

    def __init__(self, errors, status=400):
        self.errors = [str(e) for e in errors] or ["the project is invalid"]
        shown = "; ".join(self.errors[:8]) + (" (and %d more)" % (len(self.errors) - 8) if len(self.errors) > 8
                                              else "")
        super().__init__(status, "the project was not accepted: " + shown)

    def body(self):
        out = super().body()
        out["errors"] = list(self.errors)
        return out


# -- small helpers (also used by the executor) ---------------------------------------------------------------------

def money(value):
    return round(float(value or 0), 2)


def call(engine, command, args=None):
    """engine(command, args) as a dict that never raises for game errors: {"ok": False, "error": ...} when the game
    refused, did not answer, or the reply was not a JSON object. TeamError of the company binding passes."""
    try:
        reply = engine(command, dict(args or {}))
    except TeamError:
        raise
    except Exception as e:  # a broken connection must not look like an answer
        return {"ok": False, "error": "the game connection failed: %s" % e}
    if not isinstance(reply, dict):
        return {"ok": False, "error": "the game sent no JSON object"}
    return reply


def error_of(reply):
    """The error text of a reply, or None when it worked."""
    if reply.get("ok") is False or "error" in reply:
        return str(reply.get("error") or reply.get("reason") or "unknown error")
    return None


def unreachable(reply):
    return reply.get("status") in (502, 503)


def pos_args(pos, prefix=""):
    """{"x", "y"[, "z"]} (or x2/y2/z2) of a position list."""
    names = ("x2", "y2", "z2") if prefix == "2" else ("x", "y", "z")
    return {names[k]: v for k, v in enumerate(pos)}


def pos_text(pos):
    return ",".join(str(v) for v in pos)


def l_path(a, b):
    """The squares of the shortest path from a to b, first along x, then along y (the preview of routes the engine
    cannot plan in advance). z of every square is that of a (or 0)."""
    z = a[2] if len(a) > 2 else 0
    tiles = []
    sx = 1 if b[0] >= a[0] else -1
    for x in range(a[0], b[0] + sx, sx):
        tiles.append([x, a[1], z])
    sy = 1 if b[1] >= a[1] else -1
    if b[1] != a[1]:
        for y in range(a[1] + sy, b[1] + sy, sy):
            tiles.append([b[0], y, z])
    return tiles


def straight_squares(a, b):
    """All squares from a to b of a straight bridge or tunnel (z of a)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = max(abs(dx), abs(dy))
    if n == 0:
        return [list(a)]
    return [[a[0] + round(dx * k / n), a[1] + round(dy * k / n), a[2] if len(a) > 2 else 0] for k in range(n + 1)]


def tile_objects(reply):
    """[(ground z, type, name, owner, ground)] of a `tile` reply (moving things left out)."""
    out = []
    for g in reply.get("grounds") or ():
        if not isinstance(g, dict):
            continue
        z = (g.get("pos") or {}).get("z", 0)
        for o in g.get("objects") or ():
            if isinstance(o, dict) and o.get("type") not in MOVING:
                out.append((z, o.get("type"), o.get("name"), o.get("owner"), g))
    return out


def ground_z(reply, prefer_halt=False, prefer_way=False):
    """The height of the ground of a `tile` reply that a stop, way or building of the square stands on: a halt ground
    when asked, else a ground with a way, else the surface, else the first; None without grounds."""
    grounds = [g for g in reply.get("grounds") or () if isinstance(g, dict) and isinstance(g.get("pos"), dict)]
    if not grounds:
        return None
    if prefer_halt:
        for g in grounds:
            if g.get("halt") is not None:
                return g["pos"].get("z", 0)
    if prefer_way or prefer_halt:
        for g in grounds:
            if any(isinstance(o, dict) and o.get("type") in WAYISH for o in g.get("objects") or ()):
                return g["pos"].get("z", 0)
    for g in grounds:
        if g.get("surface"):
            return g["pos"].get("z", 0)
    return grounds[0]["pos"].get("z", 0)


def line_id_of(value):
    """The line id of a convoy reply's "line" (an object {"id", "name"}, a number, 0 or missing)."""
    if isinstance(value, dict):
        value = value.get("id")
    return value if type(value) is int and value > 0 else None


def schedule_text(linetype, stops):
    """The engine's schedule text <cur>|<type>|<x>,<y>,<z>,<min load>,<wait>|...| (stops: [{at:[x,y,z], load, wait}],
    z already resolved)."""
    parts = ["0", str(linetype)]
    for s in stops:
        x, y, z = s["at"][0], s["at"][1], s["at"][2]
        parts.append("%d,%d,%d,%d,%d" % (x, y, z, s.get("load", 0), s.get("wait", 0)))
    return "|".join(parts) + "|"


def linetype_from_name(name):
    if isinstance(name, str):
        return LINE_TYPE_NAMES.get(name.strip().lower())
    return None


# -- the tool schema -----------------------------------------------------------------------------------------------

_POS = {"type": "array", "items": {"type": "integer"}, "minItems": 2, "maxItems": 3}
_ID = {"type": ["integer", "string"]}

OP_HELP = {
    "build_way": "build_way {from, to, way, bridge?, tunnel?, straight?}: a way (road, track, ...) from square A to "
                 "B on the route the game's way builder finds (existing ways are reused); bridge/tunnel: names to use "
                 "where the route must cross water or a hill; straight: only a straight line",
    "build_station": "build_station {at, building, rotation?}: a stop/station building on a way of the company "
                     "(or a public road)",
    "build_depot": "build_depot {at, building}: a depot at the end of a way",
    "build_roadsign": "build_roadsign {at, sign}: a road sign or signal on a way",
    "build_wayobj": "build_wayobj {from, to, wayobj}: a way object (e.g. overhead line) along the existing ways "
                    "from A to B",
    "remove": "remove {at, kind?}: remove one object of the company at a square (kind: signal, roadsign, wayobj, "
              "depot; without kind what the game's remover takes first, e.g. the stop building); only objects of "
              "the company",
    "remove_way": "remove_way {from, to, waytype}: remove the company's ways of a waytype along the existing way "
                  "from A to B (with signs, stops and way objects on them)",
    "create_line": "create_line {ref, waytype, name?, stops}: a new line; stops = [{at, load?, wait?}] in order "
                   "(at least 2 different squares with stops or ways of the waytype); later ops use \"$<ref>\" for it",
    "set_line_schedule": "set_line_schedule {line, stops}: replace the schedule of a line",
    "delete_line": "delete_line {line}: delete a line (its convoys keep driving without a line)",
    "buy_convoy": "buy_convoy {depot, vehicles, ref?, count?, line?, start?}: buy count convoys (default 1) of the "
                  "vehicles in this order in a depot of the company; line: put them on the line; start (default "
                  "true with a line): send them off; ref (only with count 1): later ops use \"$<ref>\" for it",
    "assign_line": "assign_line {convoy, line}: put a convoy on a line",
    "withdraw": "withdraw {convoy, on?}: withdraw a convoy (on true, default: it goes to a depot and is sold there; "
                "on false: cancel a withdrawal)",
    "replace_convoy": "replace_convoy {convoy, vehicles, depot?}: buy a new convoy of these vehicles in a depot of "
                      "the company (default the old convoy's home depot) for the old convoy's line, start it, then "
                      "withdraw the old one (or sell it when it stands in a depot)",
    "sell": "sell {convoy}: sell a convoy now",
}

_PROPS = {
    "from": dict(_POS, description="start square [x, y] or [x, y, z]"),
    "to": dict(_POS, description="end square [x, y] or [x, y, z]"),
    "at": dict(_POS, description="square [x, y] or [x, y, z] (z only on bridges, elevated ways, several levels)"),
    "depot": dict(_POS, description="square of a depot of the company [x, y] or [x, y, z]"),
    "way": {"type": "string", "description": "exact name of a way object of the game (available now)"},
    "bridge": {"type": "string", "description": "exact name of a bridge for the way's waytype"},
    "tunnel": {"type": "string", "description": "exact name of a tunnel for the way's waytype"},
    "straight": {"type": "boolean", "description": "only a straight way from A to B"},
    "building": {"type": "string", "description": "exact name of the stop/station or depot building"},
    "rotation": {"type": "integer", "minimum": 0, "maximum": 3, "description": "layout of the station building"},
    "sign": {"type": "string", "description": "exact name of the road sign or signal"},
    "wayobj": {"type": "string", "description": "exact name of the way object"},
    "kind": {"type": "string", "enum": sorted(REMOVE_KINDS), "description": "what to remove at the square"},
    "waytype": {"type": "string", "enum": list(WAYTYPE_ENUM),
                "description": "create_line: road, rail, water, air, monorail, tram, maglev, narrowgauge; "
                               "remove_way: road, rail (also tram tracks), water, air, monorail, maglev, narrowgauge"},
    "ref": {"type": "string", "description": "a name for what this op creates, used by later ops as \"$<name>\" "
                                             "(letters, digits, _ and -, at most 32)"},
    "name": {"type": "string", "maxLength": MAX_LINE_NAME, "description": "name of the new line"},
    "stops": {"type": "array", "minItems": 2, "maxItems": MAX_STOPS,
              "description": "stops in order",
              "items": {"type": "object", "additionalProperties": False, "required": ["at"],
                        "properties": {"at": dict(_POS, description="square of the stop [x, y] or [x, y, z]"),
                                       "load": {"type": "integer", "minimum": 0, "maximum": 100,
                                                "description": "wait until loaded to this % (default 0)"},
                                       "wait": {"type": "integer", "minimum": 0, "maximum": MAX_WAIT,
                                                "description": "with load: maximum waiting time in 1/65536 of a "
                                                               "month (e.g. 8192 = 1/8 month; 0 = no limit)"}}}},
    "line": dict(_ID, description="line id (number), or \"$<ref>\" of a create_line earlier in this project"),
    "convoy": dict(_ID, description="convoy id (number), or \"$<ref>\" of a buy_convoy earlier in this project"),
    "vehicles": {"type": "array", "minItems": 1, "maxItems": MAX_VEHICLES, "items": {"type": "string"},
                 "description": "exact vehicle names in convoy order (vehicles the game couples automatically must "
                                "be listed too)"},
    "count": {"type": "integer", "minimum": 1, "maximum": MAX_COUNT, "description": "number of convoys (default 1)"},
    "start": {"type": "boolean", "description": "send the convoys off (default: true when a line is given)"},
    "on": {"type": "boolean", "description": "true (default) withdraws, false cancels a withdrawal"},
}


def ops_schema(role):
    """JSON schema of the `ops` array of the propose_project tool for a role, or None for roles that may not propose
    projects (analyst, accountant, coordinator, unknown ids)."""
    allowed = ROLE_OPS.get(role)
    if not allowed:
        return None
    types = [t for t in OP_TYPES if t in allowed]
    fields = []
    for t in types:
        req, opt = FIELDS[t]
        for f in req + opt:
            if f not in fields:
                fields.append(f)
    help_lines = [OP_HELP[t] for t in types]
    if role == "dispatcher":
        help_lines = [h + (" - for you only the load/wait of the existing stops may change (same stops, same order)"
                           if h.startswith("set_line_schedule") else "") for h in help_lines]
    props = {"type": {"type": "string", "enum": types, "description": "the operation; fields per type:\n- "
                                                                       + "\n- ".join(help_lines)}}
    for f in fields:
        props[f] = dict(_PROPS[f])
    return {"type": "array", "minItems": 1, "maxItems": MAX_OPS,
            "description": "the operations in the order they are carried out (at most %d); execution stops at the "
                           "first one that fails" % MAX_OPS,
            "items": {"type": "object", "properties": props, "required": ["type"], "additionalProperties": False}}


# -- validation ----------------------------------------------------------------------------------------------------

def _is_int(v):
    return type(v) is int


def _clean_text(s, max_len, newlines=False):
    """True for a string the game, the database and the browser can take: 1..max_len characters after strip, no
    control characters (newlines and tabs only when allowed), no lone surrogates (JSON "\\ud800" from the model)."""
    if not isinstance(s, str) or not s.strip() or len(s) > max_len:
        return False
    for c in s:
        o = ord(c)
        if o == 0 or 0xD800 <= o <= 0xDFFF or (o < 32 and not (newlines and c in "\n\r\t")):
            return False
    return True


class _Checker:
    """Validates and estimates one proposal. errors collects every problem; the engine is asked at most once per
    object (caches)."""

    def __init__(self, engine, company, agent, allowed, size):
        self.engine = engine
        self.company = company
        self.agent = agent
        self.allowed = allowed
        self.size = size              # (size_x, size_y) of the world
        self.errors = []
        self.warnings = []
        self.cache = {}
        self.items = []               # estimate items
        self.maintenance = 0.0
        self.preview = []
        self.plans = {}               # str(op index) -> what the executor needs (build_way param, replace depot)
        self.desc_waytypes = None

    def err(self, i, op_type, text):
        self.errors.append("ops[%d] (%s): %s" % (i, op_type, text) if i is not None else text)

    def warn(self, text):
        if text not in self.warnings:
            self.warnings.append(text)

    def read(self, command, args):
        key = (command, tuple(sorted(args.items())))
        if key not in self.cache:
            self.cache[key] = call(self.engine, command, args)
        return self.cache[key]

    # -- static checks

    def name(self, i, t, op, key, out, required=True):
        v = op.get(key)
        if v is None:
            return  # a missing required field is reported once, with the others
        if not _clean_text(v, MAX_NAME):
            self.err(i, t, "%s must be an object name (1-%d characters)" % (key, MAX_NAME))
            return
        out[key] = v.strip()

    def pos(self, i, t, value, key):
        """A position [x, y] or [x, y, z] inside the map, or None (error recorded)."""
        if not isinstance(value, list) or len(value) not in (2, 3) or not all(_is_int(v) for v in value):
            self.err(i, t, "%s must be [x, y] or [x, y, z] (integers)" % key)
            return None
        x, y = value[0], value[1]
        if not (0 <= x < self.size[0] and 0 <= y < self.size[1]):
            self.err(i, t, "%s %s is outside of the map (%d x %d)" % (key, pos_text(value), self.size[0],
                                                                     self.size[1]))
            return None
        if len(value) == 3 and not -128 <= value[2] <= 127:
            self.err(i, t, "%s: z must be -128..127" % key)
            return None
        return list(value)

    def ident(self, i, t, value, key):
        """A line/convoy id (positive int) or a "$ref" (kept as "$name")."""
        if _is_int(value) and value > 0:
            return value
        if isinstance(value, str):
            if re.fullmatch(r"[0-9]{1,9}", value.strip()) and int(value) > 0:
                return int(value)
            m = REF_RE.fullmatch(value.strip())
            if m and value.strip().startswith("$"):
                return "$" + m.group(1)
        self.err(i, t, "%s must be an id (number) or \"$<ref>\" of an earlier op" % key)
        return None

    def stops(self, i, t, value):
        if not isinstance(value, list) or not 2 <= len(value) <= MAX_STOPS:
            self.err(i, t, "stops must be a list of 2-%d stops" % MAX_STOPS)
            return None
        out = []
        ok = True
        for k, s in enumerate(value):
            if not isinstance(s, dict):
                self.err(i, t, "stops[%d] must be an object {at, load?, wait?}" % k)
                ok = False
                continue
            extra = [f for f in s if f not in ("at", "load", "wait")]
            if extra:
                self.err(i, t, "stops[%d]: unknown field(s) %s" % (k, ", ".join(sorted(map(str, extra)))))
                ok = False
            at = self.pos(i, t, s.get("at"), "stops[%d].at" % k)
            load, wait = s.get("load", 0), s.get("wait", 0)
            if not _is_int(load) or not 0 <= load <= 100:
                self.err(i, t, "stops[%d].load must be 0-100 (%%)" % k)
                ok = False
            if not _is_int(wait) or not 0 <= wait <= MAX_WAIT:
                self.err(i, t, "stops[%d].wait must be 0-%d" % (k, MAX_WAIT))
                ok = False
            if at is None:
                ok = False
                continue
            stop = {"at": at}
            if load:
                stop["load"] = load
            if wait:
                stop["wait"] = wait
            out.append(stop)
        if ok and len({(s["at"][0], s["at"][1]) for s in out}) < 2:
            self.err(i, t, "stops need at least two different squares")
            ok = False
        return out if ok else None

    def vehicles(self, i, t, value):
        if not isinstance(value, list) or not 1 <= len(value) <= MAX_VEHICLES:
            self.err(i, t, "vehicles must be a list of 1-%d vehicle names" % MAX_VEHICLES)
            return None
        out = []
        for k, v in enumerate(value):
            if not _clean_text(v, MAX_NAME):
                self.err(i, t, "vehicles[%d] must be a vehicle name" % k)
                return None
            out.append(v.strip())
        return out

    def static(self, i, op):
        """The op normalised (known fields, checked types and ranges), or None when it has errors."""
        if not isinstance(op, dict):
            self.err(i, "?", "an op must be an object with a type")
            return None
        t = op.get("type")
        if t not in FIELDS:
            self.err(i, str(t)[:40], "unknown op type (known: %s)" % ", ".join(OP_TYPES))
            return None
        before = len(self.errors)
        if t not in self.allowed:
            self.err(i, t, "the %s may not propose this op (allowed: %s)"
                     % (self.agent, ", ".join(x for x in OP_TYPES if x in self.allowed)))
        req, opt = FIELDS[t]
        missing = [f for f in req if op.get(f) is None]
        if missing:
            self.err(i, t, "missing field(s) %s" % ", ".join(missing))
        extra = [f for f in op if f != "type" and f not in req + opt]
        if extra:
            self.err(i, t, "unknown field(s) %s (fields: %s)" % (", ".join(sorted(map(str, extra))),
                                                                ", ".join(req + opt)))
        out = {"type": t}
        for key in ("from", "to", "at", "depot"):
            if key in req + opt and op.get(key) is not None:
                p = self.pos(i, t, op[key], key)
                if p is not None:
                    out[key] = p
        for key in ("way", "bridge", "tunnel", "building", "sign", "wayobj"):
            if key in req + opt:
                self.name(i, t, op, key, out, required=key in req)
        if t == "build_way":
            if op.get("straight") is not None:
                if not isinstance(op["straight"], bool):
                    self.err(i, t, "straight must be true or false")
                elif op["straight"]:
                    out["straight"] = True
            if "from" in out and "to" in out and out["from"][:2] == out["to"][:2]:
                self.err(i, t, "from and to are the same square")
        if t == "build_station" and op.get("rotation") is not None:
            if not _is_int(op["rotation"]) or not 0 <= op["rotation"] <= 3:
                self.err(i, t, "rotation must be 0-3")
            else:
                out["rotation"] = op["rotation"]
        if t == "remove" and op.get("kind") is not None:
            if op["kind"] not in REMOVE_KINDS:
                self.err(i, t, "kind must be one of %s (or left out)" % ", ".join(sorted(REMOVE_KINDS)))
            else:
                out["kind"] = op["kind"]
        if t == "remove_way" and op.get("waytype") is not None:
            if op["waytype"] not in REMOVE_WAYTYPES:
                self.err(i, t, "waytype must be one of %s" % ", ".join(sorted(REMOVE_WAYTYPES)))
            else:
                out["waytype"] = op["waytype"]
        if t == "create_line":
            if op.get("waytype") is not None:
                if op["waytype"] not in LINE_TYPES:
                    self.err(i, t, "waytype must be one of road, rail, water, air, monorail, tram, maglev, "
                                   "narrowgauge")
                else:
                    out["waytype"] = op["waytype"]
            if op.get("name") is not None:
                if not _clean_text(op["name"], MAX_LINE_NAME):
                    self.err(i, t, "name must be 1-%d characters without control characters" % MAX_LINE_NAME)
                else:
                    out["name"] = op["name"].strip()
        if "ref" in req + opt and op.get("ref") is not None:
            m = REF_RE.fullmatch(op["ref"]) if isinstance(op["ref"], str) else None
            if not m:
                self.err(i, t, "ref must be a name of letters, digits, _ and - (at most 32)")
            else:
                out["ref"] = m.group(1)
        if "stops" in req and op.get("stops") is not None:
            s = self.stops(i, t, op["stops"])
            if s is not None:
                out["stops"] = s
        for key in ("line", "convoy"):
            if key in req + opt and op.get(key) is not None:
                v = self.ident(i, t, op[key], key)
                if v is not None:
                    out[key] = v
        if "vehicles" in req and op.get("vehicles") is not None:
            v = self.vehicles(i, t, op["vehicles"])
            if v is not None:
                out["vehicles"] = v
        if t == "buy_convoy":
            count = op.get("count", 1)
            if not _is_int(count) or not 1 <= count <= MAX_COUNT:
                self.err(i, t, "count must be 1-%d" % MAX_COUNT)
            else:
                out["count"] = count
            start = op.get("start")
            if start is not None and not isinstance(start, bool):
                self.err(i, t, "start must be true or false")
            else:
                out["start"] = bool(start) if start is not None else op.get("line") is not None
                if out["start"] and op.get("line") is None:
                    self.err(i, t, "start needs a line (a convoy without schedule cannot leave the depot)")
            if out.get("ref") and out.get("count", 1) > 1:
                self.err(i, t, "ref names one convoy: use it only with count 1")
        if t == "withdraw":
            on = op.get("on", True)
            if not isinstance(on, bool):
                self.err(i, t, "on must be true or false")
            else:
                out["on"] = on
        return out if len(self.errors) == before else None

    def refs(self, norm):
        """Refs are defined once, before they are used, and refer to the right kind of object."""
        defined = {}
        for i, op in enumerate(norm):
            if op is None:
                continue
            t = op["type"]
            for key, kind in (("line", "line"), ("convoy", "convoy")):
                v = op.get(key)
                if isinstance(v, str):
                    name = v[1:]
                    if name not in defined:
                        self.err(i, t, "%s %s is not the ref of an earlier op" % (key, v))
                    elif defined[name][0] != kind:
                        self.err(i, t, "%s %s refers to a %s (ops[%d]), not a %s" % (key, v, defined[name][0],
                                                                                   defined[name][1], kind))
            if op.get("ref"):
                kind = "line" if t == "create_line" else "convoy"
                if op["ref"] in defined:
                    self.err(i, t, "ref %s is already defined by ops[%d]" % (op["ref"], defined[op["ref"]][1]))
                else:
                    defined[op["ref"]] = (kind, i)

    # -- engine checks, estimate and preview

    def desc(self, i, t, kind, name, length=None, size=None):
        """The estimate reply of an available object (count 1), or None (error recorded)."""
        args = {"kind": kind, "name": name}
        if length:
            args["length"] = length
        if size:
            args["size"] = size
        r = self.read("estimate", args)
        e = error_of(r)
        if e:
            self.err(i, t, "%s '%s': %s" % (kind, name, e))
            return None
        if r.get("available") is False:
            self.err(i, t, "%s '%s' is not available now (%s)" % (kind, name, "obsolete" if r.get("obsolete")
                                                                  else "not built in this year"))
            return None
        return r

    def waytype_of(self, kind, name):
        """The waytype of a way, bridge, tunnel, sign or way object from the catalogue (desc_list), or None."""
        if self.desc_waytypes is None:
            self.desc_waytypes = {}
            r = self.read("desc_list", {"kinds": "ways,bridges,tunnels,signs,wayobjs"})
            if not error_of(r):
                for k in ("ways", "bridges", "tunnels", "signs", "wayobjs"):
                    for d in r.get(k) or ():
                        if isinstance(d, dict) and isinstance(d.get("name"), str):
                            self.desc_waytypes[(k, d["name"])] = d.get("waytype")
        return self.desc_waytypes.get((kind, name))

    def existing_route(self, a, b, waytype):
        """The squares from a to b along the existing way of a waytype, as the way builder routes it (plan_way with
        the way object that lies at a, which the builder follows because existing ways are cheap), or None."""
        r = self.read("tile", {"x": a[0], "y": a[1]})
        if error_of(r):
            return None
        for _, typ, name, _, _ in tile_objects(r):
            if typ != "way" or not isinstance(name, str) or self.waytype_of("ways", name) != waytype:
                continue
            args = dict(pos_args(a), **pos_args(b, "2"))
            args["way"] = name
            plan = self.read("plan_way", args)
            tiles = plan.get("tiles") if not error_of(plan) else None
            if isinstance(tiles, list) and len(tiles) >= 2:
                return [list(t) for t in tiles]
        return None

    def z_at(self, pos, prefer_halt=False, prefer_way=False):
        """pos with z: the given z, else the height of the ground from a tile read (0 when unknown)."""
        if len(pos) == 3:
            return list(pos)
        z = ground_z(self.read("tile", {"x": pos[0], "y": pos[1]}), prefer_halt, prefer_way)
        return [pos[0], pos[1], z if z is not None else 0]

    def own_depot(self, i, t, pos):
        r = self.read("depot", pos_args(pos))
        e = error_of(r)
        if e:
            self.err(i, t, "no depot at %s (%s)" % (pos_text(pos), e))
            return None
        if r.get("owner") != self.company:
            self.err(i, t, "the depot at %s belongs to company %s, not to this company" % (pos_text(pos),
                                                                                         r.get("owner")))
            return None
        return r

    def own_line(self, i, t, lid):
        r = self.read("line", {"id": lid})
        e = error_of(r)
        line = r.get("line") if isinstance(r.get("line"), dict) else None
        if e or line is None:
            self.err(i, t, "line %d does not exist (%s)" % (lid, e or "no line in the reply"))
            return None
        if line.get("owner") != self.company:
            self.err(i, t, "line %d belongs to company %s, not to this company" % (lid, line.get("owner")))
            return None
        return r

    def own_convoy(self, i, t, cid):
        r = self.read("convoy", {"id": cid})
        e = error_of(r)
        conv = r.get("convoy") if isinstance(r.get("convoy"), dict) else None
        if e or conv is None:
            self.err(i, t, "convoy %d does not exist (%s)" % (cid, e or "no convoy in the reply"))
            return None
        if conv.get("owner") != self.company:
            self.err(i, t, "convoy %d belongs to company %s, not to this company" % (cid, conv.get("owner")))
            return None
        return conv

    def vehicle_list(self, i, t, names, depot_waytype):
        """(price, fixed cost per month) of a composition, or None (errors recorded): every vehicle exists, is
        available now and fits the depot's waytype (when known)."""
        price = fixed = 0.0
        ok = True
        for name in names:
            r = self.desc(i, t, "vehicle", name)
            if r is None:
                ok = False
                continue
            wt = r.get("waytype")
            if depot_waytype and wt and wt != depot_waytype:
                self.err(i, t, "vehicle '%s' (%s) does not fit a %s depot" % (name, wt, depot_waytype))
                ok = False
            price += float(r.get("price") or 0)
            fixed += float(r.get("fixed_cost", r.get("maintenance")) or 0)
        return (price, fixed) if ok else None

    def item(self, i, label, cost, maintenance=0.0):
        self.items.append({"op": i, "label": label, "cost": money(cost)})
        self.maintenance += float(maintenance or 0)

    def show(self, i, kind, tiles, label, waytype=None):
        self.preview.append({"op": i, "kind": kind, "waytype": waytype, "tiles": [list(p) for p in tiles],
                             "label": label})

    def engine_checks(self, norm):
        built_depots = set()          # squares of depots built by earlier ops of this project
        line_types = {}               # line ref -> line type
        convoys = 0
        for i, op in enumerate(norm):
            if op is None:
                continue
            t = op["type"]
            getattr(self, "_" + t)(i, op, built_depots, line_types)
            if t == "buy_convoy":
                convoys += op.get("count", 1)
            elif t == "replace_convoy":
                convoys += 1
        if convoys > MAX_CONVOYS:
            self.err(None, None, "a project buys at most %d convoys (this one %d)" % (MAX_CONVOYS, convoys))

    # one method per op type: engine checks, estimate item, preview items, executor plans

    def _build_way(self, i, op, built_depots, line_types):
        t = "build_way"
        way = self.desc(i, t, "way", op["way"])
        bridge = self.desc(i, t, "bridge", op["bridge"]) if op.get("bridge") else None
        tunnel = self.desc(i, t, "tunnel", op["tunnel"]) if op.get("tunnel") else None
        if way is None or (op.get("bridge") and bridge is None) or (op.get("tunnel") and tunnel is None):
            return
        args = dict(pos_args(op["from"]), **pos_args(op["to"], "2"))
        args["way"] = op["way"]
        if op.get("bridge"):
            args["bridge"] = op["bridge"]
        if op.get("tunnel"):
            args["tunnel"] = op["tunnel"]
        if op.get("straight"):
            args["straight"] = 1
        plan = call(self.engine, "plan_way", args)
        e = error_of(plan)
        tiles = plan.get("tiles") if isinstance(plan.get("tiles"), list) else []
        if e or len(tiles) < 2:
            self.err(i, t, "no route from %s to %s: %s" % (pos_text(op["from"]), pos_text(op["to"]),
                                                           e or "the game found no route"))
            return
        param = plan.get("param")
        if not isinstance(param, str) or not param:
            # engines before "param": the same text the engine builds (straight flag, no max length, bridge, tunnel)
            param = op["way"] + "," + ("s" if op.get("straight") else "")
            if op.get("bridge") or op.get("tunnel"):
                param += ",0," + (op.get("bridge") or "") + ("," + op["tunnel"] if op.get("tunnel") else "")
        # squares the executor reads before and after building in a network game (start, end, a few between)
        n = len(tiles)
        picks = sorted({0, n - 1} | {round(k * (n - 1) / 5) for k in range(1, 5)}) if n > 6 else range(n)
        self.plans[str(i)] = {"param": param, "from": list(tiles[0]), "to": list(tiles[-1]),
                              "length": int(plan.get("length") or n), "cost": money(plan.get("cost")),
                              "samples": [list(tiles[k]) for k in picks]}
        wt = self.waytype_of("ways", op["way"])
        bridges = [b for b in plan.get("bridges") or () if isinstance(b, list) and len(b) == 2]
        tunnels = [b for b in plan.get("tunnels") or () if isinstance(b, list) and len(b) == 2]
        span = lambda pairs: sum(max(abs(b[0] - a[0]), abs(b[1] - a[1])) + 1 for a, b in pairs)  # noqa: E731
        maint = float(way.get("maintenance") or 0) * len(tiles)
        if bridge:
            maint += float(bridge.get("maintenance") or 0) * span(bridges)
        if tunnel:
            maint += float(tunnel.get("maintenance") or 0) * span(tunnels)
        extra = ""
        if bridges:
            extra += ", %d bridge%s" % (len(bridges), "s" if len(bridges) > 1 else "")
        if tunnels:
            extra += ", %d tunnel%s" % (len(tunnels), "s" if len(tunnels) > 1 else "")
        label = "%s %s -> %s (%d squares%s)" % (op["way"], pos_text(op["from"]), pos_text(op["to"]), len(tiles),
                                                extra)
        self.item(i, label, plan.get("cost") or 0, maint)
        self.show(i, "way", tiles, label, wt)
        for a, b in bridges:
            self.show(i, "bridge", straight_squares(a, b), "%s %s -> %s" % (op.get("bridge") or "bridge",
                                                                            pos_text(a), pos_text(b)), wt)
        for a, b in tunnels:
            self.show(i, "tunnel", straight_squares(a, b), "%s %s -> %s" % (op.get("tunnel") or "tunnel",
                                                                            pos_text(a), pos_text(b)), wt)

    def _build_station(self, i, op, built_depots, line_types):
        t = "build_station"
        r = self.desc(i, t, "station", op["building"])
        if r is None:
            return
        size = r.get("size") if isinstance(r.get("size"), list) and len(r["size"]) == 2 else [1, 1]
        units = max(1, int(size[0]) * int(size[1]))
        label = "%s at %s" % (op["building"], pos_text(op["at"]))
        self.item(i, label, r.get("total") or 0, float(r.get("maintenance") or 0) * units)
        self.show(i, "station", [self.z_at(op["at"], prefer_way=True)], label)

    def _build_depot(self, i, op, built_depots, line_types):
        r = self.desc(i, "build_depot", "depot", op["building"])
        if r is None:
            return
        built_depots.add((op["at"][0], op["at"][1]))
        label = "%s at %s" % (op["building"], pos_text(op["at"]))
        self.item(i, label, r.get("total") or 0, r.get("maintenance") or 0)
        self.show(i, "depot", [self.z_at(op["at"], prefer_way=True)], label)

    def _build_roadsign(self, i, op, built_depots, line_types):
        r = self.desc(i, "build_roadsign", "roadsign", op["sign"])
        if r is None:
            return
        label = "%s at %s" % (op["sign"], pos_text(op["at"]))
        self.item(i, label, r.get("total") or 0, r.get("maintenance") or 0)
        self.show(i, "roadsign", [self.z_at(op["at"], prefer_way=True)], label, self.waytype_of("signs", op["sign"]))

    def _build_wayobj(self, i, op, built_depots, line_types):
        t = "build_wayobj"
        a, b = op["from"], op["to"]
        if self.desc(i, t, "wayobj", op["wayobj"]) is None:
            return
        wt = self.waytype_of("wayobjs", op["wayobj"])
        tiles = self.existing_route(a, b, wt) if wt else None
        if tiles is None:
            tiles = l_path(self.z_at(a, prefer_way=True), b)
            self.warn("ops[%d] (build_wayobj): no %s way found at %s to follow: the cost assumes the shortest path "
                      "of %d squares" % (i, wt or "fitting", pos_text(a), len(tiles)))
        r = self.desc(i, t, "wayobj", op["wayobj"], length=len(tiles))
        if r is None:
            return
        label = "%s %s -> %s (%d squares)" % (op["wayobj"], pos_text(a), pos_text(b), len(tiles))
        self.item(i, label, r.get("total") or 0, float(r.get("maintenance") or 0) * len(tiles))
        self.show(i, "wayobj", tiles, label, wt)

    # -- removal costs: the game charges the price of a removed way, bridge, tunnel, sign or way object, and its
    #    demolition cost (setting cost_multiply_remove_haus) for a stop or depot building. Without an estimate a
    #    removal project would always hit the 20 % overrun stop, so these are upper bounds.

    def price_of(self, kind, name):
        r = self.read("estimate", {"kind": kind, "name": name})
        return None if error_of(r) else float(r.get("price") or 0)

    def max_price(self, kind, est_kind, waytype):
        """The highest price of the signs or way objects of a waytype in the pakset (desc_list): what removing one
        of them can cost at most (the tile read does not name them)."""
        key = ("max_price", kind, waytype)
        if key not in self.cache:
            self.waytype_of(kind, "")
            best = 0.0
            for (k, name), wt in (self.desc_waytypes or {}).items():
                if k == kind and (waytype is None or wt == waytype):
                    p = self.price_of(est_kind, name)
                    best = max(best, p or 0.0)
            self.cache[key] = best
        return self.cache[key]

    def removal_cost(self, reply, waytype=None, kind=None, single=False):
        """Upper bound of the cost of removing the company's objects on a square (a `tile` reply): the sum (way
        removal) or the dearest (one object, `remove`) of the ways of the waytype, bridges, tunnels, signs, way
        objects and stop/depot buildings there; kind limits it to signals, road signs, way objects or depots."""
        way_wt = None
        for _, typ, name, _, _ in tile_objects(reply):
            if typ == "way" and isinstance(name, str):
                way_wt = way_wt or self.waytype_of("ways", name)
        prices = []
        for _, typ, name, owner, _ in tile_objects(reply):
            if owner != self.company:
                continue
            typ = str(typ)
            if typ in ("way", "bridge", "tunnel") and not kind:
                if typ == "way" and waytype and self.waytype_of("ways", name) not in (None, waytype):
                    continue
                p = self.price_of(typ, name) if isinstance(name, str) else None
                if p is None:
                    p = self.max_price({"way": "ways", "bridge": "bridges", "tunnel": "tunnels"}[typ], typ,
                                       waytype or way_wt)
                prices.append(p)
            elif typ in ("roadsign", "signal") and kind in (None, typ):
                prices.append(self.max_price("signs", "roadsign", waytype or way_wt))
            elif typ == "wayobj" and kind in (None, "wayobj"):
                prices.append(self.max_price("wayobjs", "wayobj", waytype or way_wt))
            elif (typ == "building" and kind is None) or (typ.endswith("depot") and kind in (None, "depot")):
                prices.append(REMOVE_BUILDING)
                self.warn("removing a stop or depot building is estimated with the game's default demolition cost "
                          "(%d); a game with a higher setting can exceed the estimate" % REMOVE_BUILDING)
        if single:
            return max(prices, default=0.0)
        return sum(prices)

    def _remove(self, i, op, built_depots, line_types):
        label = "remove %sat %s" % ((op["kind"] + " ") if op.get("kind") else "", pos_text(op["at"]))
        r = self.read("tile", {"x": op["at"][0], "y": op["at"][1]})
        cost = 0.0 if error_of(r) else self.removal_cost(r, kind=op.get("kind"), single=True)
        self.item(i, label, cost)
        self.show(i, "remove", [self.z_at(op["at"])], label)

    def _remove_way(self, i, op, built_depots, line_types):
        wt = REMOVE_WAYTYPE_NAME[REMOVE_WAYTYPES[op["waytype"]]]
        a, b = op["from"], op["to"]
        way_wt = "tram" if op["waytype"] == "tram" else wt
        tiles = self.existing_route(a, b, way_wt)
        if tiles is None:
            tiles = l_path(self.z_at(a, prefer_way=True), b)
            self.warn("ops[%d] (remove_way): no %s way found at %s: the preview shows the shortest path"
                      % (i, op["waytype"], pos_text(a)))
        cost = 0.0
        for p in tiles:
            r = self.read("tile", {"x": p[0], "y": p[1]})
            if not error_of(r):
                cost += self.removal_cost(r, waytype=way_wt)
        label = "remove %s way %s -> %s (%d squares)" % (op["waytype"], pos_text(a), pos_text(b), len(tiles))
        self.item(i, label, cost)
        self.show(i, "remove", tiles, label, wt)

    def _stop_tiles(self, stops):
        return [self.z_at(s["at"], prefer_halt=True) for s in stops]

    def _create_line(self, i, op, built_depots, line_types):
        lt = LINE_TYPES[op["waytype"]]
        line_types[op["ref"]] = lt
        label = "line%s (%s, %d stops)" % (" '%s'" % op["name"] if op.get("name") else "", op["waytype"],
                                           len(op["stops"]))
        self.item(i, label, 0)
        self.show(i, "line", self._stop_tiles(op["stops"]), label, LINE_WAYTYPE[lt])

    def _set_line_schedule(self, i, op, built_depots, line_types):
        t = "set_line_schedule"
        lid = op["line"]
        wt = None
        if isinstance(lid, int):
            r = self.own_line(i, t, lid)
            if r is None:
                return
            wt = LINE_WAYTYPE.get(linetype_from_name(r["line"].get("type")))
            if self.agent == "dispatcher":
                old = [e.get("pos") or {} for e in r.get("schedule") or () if isinstance(e, dict)]
                new = op["stops"]
                same = len(old) == len(new) and all(
                    o.get("x") == s["at"][0] and o.get("y") == s["at"][1]
                    and (len(s["at"]) < 3 or o.get("z") == s["at"][2]) for o, s in zip(old, new))
                if not same:
                    self.err(i, t, "the dispatcher may only change load and wait of the existing stops of line %d "
                                   "(stops now: %s)" % (lid, " ".join(pos_text([o.get("x"), o.get("y"), o.get("z")])
                                                                      for o in old)))
                    return
        else:
            lt = line_types.get(lid[1:])
            wt = LINE_WAYTYPE.get(lt)
        label = "schedule of line %s (%d stops)" % (lid, len(op["stops"]))
        self.item(i, label, 0)
        self.show(i, "line", self._stop_tiles(op["stops"]), label, wt)

    def _delete_line(self, i, op, built_depots, line_types):
        lid = op["line"]
        tiles, wt = [], None
        if isinstance(lid, int):
            r = self.own_line(i, "delete_line", lid)
            if r is None:
                return
            wt = LINE_WAYTYPE.get(linetype_from_name(r["line"].get("type")))
            for e in r.get("schedule") or ():
                p = e.get("pos") if isinstance(e, dict) else None
                if isinstance(p, dict) and _is_int(p.get("x")) and _is_int(p.get("y")):
                    tiles.append([p["x"], p["y"], p.get("z", 0)])
        label = "delete line %s" % lid
        self.item(i, label, 0)
        self.show(i, "line", tiles, label, wt)

    def _buy_convoy(self, i, op, built_depots, line_types):
        t = "buy_convoy"
        depot = op["depot"]
        depot_wt = None
        if (depot[0], depot[1]) in built_depots:
            self.warn("ops[%d] (buy_convoy): the depot is built by this project, so the vehicles are checked "
                      "against it only when they are bought" % i)
        else:
            d = self.own_depot(i, t, depot)
            if d is None:
                return
            depot_wt = d.get("waytype")
            limit = d.get("max_convoy_length")
            if _is_int(limit) and limit > 0 and len(op["vehicles"]) > limit:
                self.err(i, t, "the depot takes convoys of at most %d vehicles" % limit)
                return
        if isinstance(op.get("line"), int) and self.own_line(i, t, op["line"]) is None:
            return
        cost = self.vehicle_list(i, t, op["vehicles"], depot_wt)
        if cost is None:
            return
        n = op.get("count", 1)
        label = "%d x convoy %s in the depot %s%s" % (n, " + ".join(op["vehicles"]), pos_text(depot),
                                                      " for line %s" % op["line"] if op.get("line") else "")
        self.item(i, label, cost[0] * n, cost[1] * n)
        self.show(i, "convoy", [self.z_at(depot, prefer_way=True)], label, depot_wt)

    def _convoy_pos(self, conv):
        p = conv.get("pos") if isinstance(conv.get("pos"), dict) else None
        if p and _is_int(p.get("x")) and _is_int(p.get("y")):
            return [[p["x"], p["y"], p.get("z", 0)]]
        return []

    def _assign_line(self, i, op, built_depots, line_types):
        t = "assign_line"
        tiles = []
        if isinstance(op["convoy"], int):
            conv = self.own_convoy(i, t, op["convoy"])
            if conv is None:
                return
            tiles = self._convoy_pos(conv)
        if isinstance(op["line"], int) and self.own_line(i, t, op["line"]) is None:
            return
        label = "convoy %s to line %s" % (op["convoy"], op["line"])
        self.item(i, label, 0)
        self.show(i, "convoy", tiles, label)

    def _withdraw(self, i, op, built_depots, line_types):
        t = "withdraw"
        tiles = []
        if isinstance(op["convoy"], int):
            conv = self.own_convoy(i, t, op["convoy"])
            if conv is None:
                return
            if op.get("on", True) and conv.get("state") == "in_depot":
                self.err(i, t, "convoy %d stands in a depot: the game does not withdraw it there (sell it)"
                         % op["convoy"])
                return
            tiles = self._convoy_pos(conv)
        label = "%s convoy %s" % ("withdraw" if op.get("on", True) else "cancel the withdrawal of", op["convoy"])
        self.item(i, label, 0)
        self.show(i, "convoy", tiles, label)

    def _replace_convoy(self, i, op, built_depots, line_types):
        t = "replace_convoy"
        if not isinstance(op["convoy"], int):
            # a convoy bought by this project has no history worth replacing; refuse rather than guess its depot
            self.err(i, t, "replace_convoy needs the id of an existing convoy")
            return
        conv = self.own_convoy(i, t, op["convoy"])
        if conv is None:
            return
        line = line_id_of(conv.get("line"))
        if line is None:
            self.err(i, t, "convoy %d has no line: replace_convoy replaces convoys of lines only" % op["convoy"])
            return
        depot = op.get("depot")
        if depot is None:
            home = conv.get("home_depot") if isinstance(conv.get("home_depot"), dict) else None
            if not home or not _is_int(home.get("x")) or not _is_int(home.get("y")):
                self.err(i, t, "convoy %d has no home depot: give depot [x, y]" % op["convoy"])
                return
            depot = [home["x"], home["y"]] + ([home["z"]] if _is_int(home.get("z")) else [])
        d = self.own_depot(i, t, depot)
        if d is None:
            return
        cost = self.vehicle_list(i, t, op["vehicles"], d.get("waytype"))
        if cost is None:
            return
        self.plans[str(i)] = {"depot": list(depot), "line": line}
        value = conv.get("value")
        label = "replace convoy %d (line %d) by %s from the depot %s" % (op["convoy"], line,
                                                                        " + ".join(op["vehicles"]), pos_text(depot))
        self.item(i, label, cost[0], cost[1])
        self.show(i, "convoy", [self.z_at(depot, prefer_way=True)], label, d.get("waytype"))
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            self.warn("ops[%d] (replace_convoy): the old convoy %d is sold when it reaches a depot; its value "
                      "(about %.0f) comes back then and is not counted here" % (i, op["convoy"], value))

    def _sell(self, i, op, built_depots, line_types):
        t = "sell"
        tiles, value = [], 0.0
        if isinstance(op["convoy"], int):
            conv = self.own_convoy(i, t, op["convoy"])
            if conv is None:
                return
            tiles = self._convoy_pos(conv)
            v = conv.get("value")
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                value = float(v)
        label = "sell convoy %s" % op["convoy"]
        self.item(i, label, -value)
        self.show(i, "convoy", tiles, label)


def _bbox(items):
    xs = [p[0] for it in items for p in it["tiles"]]
    ys = [p[1] for it in items for p in it["tiles"]]
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def _company_cash(engine, company):
    """(cash, error) of a company from a fresh players read."""
    r = call(engine, "players", {"limit": 0})
    e = error_of(r)
    if e:
        return None, e
    for p in r.get("players") or ():
        if isinstance(p, dict) and p.get("nr") == company:
            cash = p.get("cash")
            if isinstance(cash, (int, float)) and not isinstance(cash, bool):
                return float(cash), None
            return None, "the players reply has no cash of company %d" % company
    return None, "company %d is not in the game" % company


def company_cash(engine, company):
    return _company_cash(engine, company)


def world_size(engine):
    """(size_x, size_y) of the world from `status`, or raises ProjectError (503: the game did not answer)."""
    r = call(engine, "status")
    e = error_of(r)
    world = r.get("world") if isinstance(r.get("world"), dict) else {}
    sx, sy = world.get("size_x"), world.get("size_y")
    if e or not _is_int(sx) or not _is_int(sy) or sx <= 0 or sy <= 0:
        # not the model's fault: the game is not available (try again later)
        raise ProjectError(["cannot read the game (status): %s" % (e or "no world size")], 503)
    return sx, sy


def propose(db, events, engine, company, agent, title, rationale, ops):
    """Validate, estimate and store a project of an agent of a company; publish team_project; return the project as
    present_project(full=True). engine: company-bound callable (team.engine.company_engine). Raises ProjectError with
    every problem found."""
    allowed = ROLE_OPS.get(agent)
    if not allowed:
        raise ProjectError(["the %s may not propose projects" % agent])
    errors = []
    if not isinstance(title, str) or not title.strip():
        errors.append("title must be a text")
    elif not _clean_text(title.strip(), MAX_TITLE):
        errors.append("title must have at most %d characters and no control characters" % MAX_TITLE)
    if rationale is None:
        rationale = ""
    if not isinstance(rationale, str):
        errors.append("rationale must be a text")
    elif len(rationale) > MAX_RATIONALE or (rationale.strip() and not _clean_text(rationale, MAX_RATIONALE, True)):
        errors.append("rationale must have at most %d characters and no control characters" % MAX_RATIONALE)
    if not isinstance(ops, list) or not ops:
        raise ProjectError(errors + ["ops must be a list of 1-%d operations" % MAX_OPS])
    if len(ops) > MAX_OPS:
        raise ProjectError(errors + ["a project has at most %d operations (this one %d): split it" % (MAX_OPS,
                                                                                                      len(ops))])
    size = world_size(engine)
    chk = _Checker(engine, company, agent, allowed, size)
    chk.errors.extend(errors)
    norm = [chk.static(i, op) for i, op in enumerate(ops)]
    chk.refs(norm)
    chk.engine_checks(norm)
    cash, cash_error = _company_cash(engine, company)
    if cash_error:
        chk.errors.append("cannot read the cash of the company: %s" % cash_error)
    if chk.errors:
        raise ProjectError(chk.errors)

    total = money(sum(max(0.0, it["cost"]) for it in chk.items))
    income = money(sum(-it["cost"] for it in chk.items if it["cost"] < 0))
    estimate = {"total": total, "cash": money(cash), "cash_after": money(cash - total),
                "maintenance_month": money(chk.maintenance), "items": chk.items, "warnings": chk.warnings}
    if income:
        estimate["income"] = income
    if cash - total < 0:
        estimate["warnings"].append("the company cannot pay this now: cash %.0f, estimate %.0f; the project does not "
                                    "start while cash minus the estimate is below 0" % (cash, total))
    # what the executor needs and the browser may ignore
    estimate["plans"] = chk.plans
    preview = {"bbox": _bbox(chk.preview), "items": chk.preview}
    pid = db.create_project(company, agent, title.strip(), rationale, norm, estimate=estimate, preview=preview,
                            state="proposed")
    row = db.get_project(company, pid)
    events.publish(company, "team_project", {"project": present_project(row, full=False)})
    return present_project(row, full=True)
