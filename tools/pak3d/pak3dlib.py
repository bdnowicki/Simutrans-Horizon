# Simutrans-Horizon: shared code of the pak 3D tools (check_pak3d.py, coverage.py), standard library only.
# The manifest rules, matching, limits and glTF reading are the same as in the dashboard
# (tools/dashboard/web/js/scene3d/pak.js); keep both in step.
# Artistic License, see LICENSE.txt.
import base64
import fnmatch
import json
import re
import struct

FORMAT = 1
KIND_LIST = {"building": "buildings", "vehicle": "vehicles", "citycar": "citycars", "pedestrian": "pedestrians",
             "tree": "trees", "sign": "signs", "way": "ways", "bridge": "bridges", "tunnel": "tunnels",
             "wayobj": "wayobjs"}
DRAWN_KINDS = {"building", "vehicle", "citycar", "pedestrian", "tree", "sign"}
CLIMATES = ["water", "desert", "tropic", "mediterran", "temperate", "tundra", "rocky", "arctic"]
SEASONS = ["summer", "autumn", "winter", "spring"]
LIMITS = {"building": (5000, 30000), "vehicle": (3000, 6000), "citycar": (3000, 6000), "pedestrian": (1000, 2000),
          "tree": (500, 2000), "sign": (1000, 2000), "way": (5000, 30000), "bridge": (5000, 30000),
          "tunnel": (5000, 30000), "wayobj": (5000, 30000)}
TEXTURE_LIMIT = (1024, 2048)
UNSUPPORTED_EXT = {"KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"}
DEFAULT_HEIGHT_STEP = 0.2041
PLAYER1, PLAYER2, NIGHT = "player1", "player2", "night_emissive"
TOP_KEYS = {"format", "name", "version", "license", "author", "homepage", "description", "units", "entries",
            "generators", "rules"}
ENTRY_KEYS = {"match", "model", "lod", "player_color", "scale_by_age", "variants", "featured", "generator", "type",
              "climate", "waytype", "size", "system", "freight", "footprint", "length", "comment"}
FILTERS = ("type", "climate", "waytype", "system", "freight")
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def path_error(p, what, exts, templates=False):
    """None for a relative path inside the pak (no '..', hidden parts, backslashes, drive letters), else a text"""
    if not isinstance(p, str) or not p:
        return what + " must be a path string"
    if len(p) > 300 or any(c in p for c in "\\:\0") or p.startswith("/"):
        return "%s %s is not a relative path inside the pak" % (what, json.dumps(p))
    if any(not s or s in (".", "..") or s.startswith(".") for s in p.split("/")):
        return "%s %s has an empty, hidden or parent directory part" % (what, json.dumps(p))
    rest = re.sub(r"\{(season|climate)\}", "", p) if templates else p
    if "{" in rest or "}" in rest:
        return "%s %s: only {season} and {climate} may be used as variants" % (what, json.dumps(p))
    if exts and not p.lower().endswith(exts):
        return "%s %s has the wrong file type" % (what, json.dumps(p))
    return None


def str_list(v):
    if isinstance(v, str):
        return [v]
    if isinstance(v, list) and all(isinstance(s, str) for s in v):
        return v
    return None


def norm_variant(v, values, name, errors, where):
    if v is None:
        return None
    if isinstance(v, list) and v and all(isinstance(s, str) and TOKEN_RE.match(s) for s in v):
        bad = [s for s in v if s not in values]
        if bad:
            errors.append("%s: variants.%s: unknown value %s (one of %s)" % (where, name, json.dumps(bad[0]), ", ".join(values)))
            return None
        return {s: (s if s in v else v[0]) for s in values}
    if isinstance(v, dict):
        for k, s in v.items():
            if k not in values or not isinstance(s, str) or not TOKEN_RE.match(s):
                errors.append("%s: variants.%s: bad mapping %s -> %s" % (where, name, json.dumps(k), json.dumps(s)))
                return None
        first = next(iter(v.values()), None)
        return {s: v.get(s, first if first is not None else s) for s in values}
    errors.append("%s: variants.%s must be a list of values or an object" % (where, name))
    return None


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_manifest(j):
    """(pak, errors, warnings): pak is the normalized manifest (None with errors), like pak.js validateManifest"""
    errors, warnings = [], []
    if not isinstance(j, dict):
        return None, ["manifest.json must hold a JSON object"], warnings
    if j.get("format") != FORMAT:
        errors.append("format must be %d (found %s)" % (FORMAT, json.dumps(j.get("format"))))
    for k in j:
        if k not in TOP_KEYS:
            warnings.append("unknown field %s (ignored)" % json.dumps(k))
    meta = {}
    for k in ("name", "version", "license", "author", "homepage", "description"):
        if k in j:
            if not isinstance(j[k], str) or len(j[k]) > 500:
                errors.append(k + " must be a text of at most 500 characters")
            else:
                meta[k] = j[k]
    units = {"tile": 1.0, "height_step": DEFAULT_HEIGHT_STEP}
    if "units" in j:
        u = j["units"]
        if not isinstance(u, dict):
            errors.append("units must be an object {tile, height_step}")
        else:
            for k in u:
                if k not in ("tile", "height_step"):
                    warnings.append("unknown field units.%s (ignored)" % k)
            t, hs = u.get("tile", 1.0), u.get("height_step", DEFAULT_HEIGHT_STEP)
            if not is_num(t) or not 0.01 <= t <= 100:
                errors.append("units.tile must be a number between 0.01 and 100 (model units per square)")
            else:
                units["tile"] = float(t)
            if not is_num(hs) or not 0.02 <= hs <= 2:
                errors.append("units.height_step must be a number between 0.02 and 2 (squares per height level)")
            else:
                units["height_step"] = float(hs)
                if abs(hs / units["tile"] - DEFAULT_HEIGHT_STEP) > DEFAULT_HEIGHT_STEP * 0.05:
                    warnings.append("units.height_step %s differs from the 3D view's %s per square: models keep their "
                                    "proportions, so their heights in levels differ" % (hs, DEFAULT_HEIGHT_STEP))
    generators = {}
    if "generators" in j:
        g = j["generators"]
        if not isinstance(g, dict):
            errors.append('generators must be an object {category: "generator/file.json"}')
        else:
            for name, p in g.items():
                e = path_error(p, "generators." + name, (".json",)) if NAME_RE.match(name) else \
                    "bad generator name " + json.dumps(name)
                if e:
                    errors.append(e)
                else:
                    generators[name] = p
    rules = None
    if "rules" in j:
        r = j["rules"]
        if isinstance(r, str):
            e = path_error(r, "rules", (".json",))
            if e:
                errors.append(e)
            else:
                rules = r
        elif isinstance(r, dict):
            rules = r
        else:
            errors.append("rules must be an object or the path of a .json file")
    entries = []
    if not isinstance(j.get("entries"), list):
        errors.append("entries must be a list")
    else:
        for idx, e in enumerate(j["entries"]):
            where = "entries[%d]" % idx
            if not isinstance(e, dict):
                errors.append(where + " must be an object")
                continue
            for k in e:
                if k not in ENTRY_KEYS:
                    warnings.append("%s: unknown field %s (ignored)" % (where, json.dumps(k)))
            m = re.match(r"^([a-z]+):(.+)$", e["match"], re.S) if isinstance(e.get("match"), str) else None
            if not m or m.group(1) not in KIND_LIST:
                errors.append('%s: match must be "<kind>:<name or pattern>" with kind one of %s'
                              % (where, ", ".join(KIND_LIST)))
                continue
            out = {"index": idx, "kind": m.group(1), "pattern": m.group(2), "exact": not re.search(r"[*?]", m.group(2)),
                   "model": None, "lod": [], "player": [], "scale_by_age": False,
                   "variants": {"season": None, "climate": None}, "featured": False, "generator": None,
                   "filters": {}, "footprint": None, "length": None}
            if e.get("model") is not None:
                pe = path_error(e["model"], where + ": model", (".glb", ".gltf"), True)
                if pe:
                    errors.append(pe)
                else:
                    out["model"] = e["model"]
            if "lod" in e:
                if not isinstance(e["lod"], list) or len(e["lod"]) > 4:
                    errors.append(where + ": lod must be a list of at most 4 model paths")
                else:
                    for p in e["lod"]:
                        pe = path_error(p, where + ": lod", (".glb", ".gltf"), True)
                        if pe:
                            errors.append(pe)
                        else:
                            out["lod"].append(p)
            if "player_color" in e:
                lst = str_list(e["player_color"])
                if lst is None:
                    errors.append(where + ": player_color must be a list of material names")
                else:
                    out["player"] = lst
            for k in ("scale_by_age", "featured"):
                if k in e and not isinstance(e[k], bool):
                    errors.append("%s: %s must be true or false" % (where, k))
            out["scale_by_age"] = e.get("scale_by_age") is True
            out["featured"] = e.get("featured") is True
            if "variants" in e:
                v = e["variants"]
                if not isinstance(v, dict):
                    errors.append(where + ": variants must be an object {season, climate}")
                else:
                    for k in v:
                        if k not in ("season", "climate"):
                            warnings.append("%s: unknown field variants.%s (ignored)" % (where, k))
                    out["variants"]["season"] = norm_variant(v.get("season"), SEASONS, "season", errors, where)
                    out["variants"]["climate"] = norm_variant(v.get("climate"), CLIMATES, "climate", errors, where)
            if "generator" in e:
                g = e["generator"]
                if not isinstance(g, str) or not NAME_RE.match(g):
                    errors.append(where + ": generator must be the name of a generator category")
                elif out["kind"] != "building":
                    errors.append(where + ": generator is only for buildings")
                else:
                    out["generator"] = g
            if out["model"] and out["generator"]:
                errors.append(where + ": model and generator exclude each other")
            for k in FILTERS:
                if k in e:
                    lst = str_list(e[k])
                    if not lst:
                        errors.append("%s: %s must be a text or a list of texts" % (where, k))
                    elif k == "climate" and any(c not in CLIMATES for c in lst):
                        errors.append("%s: climate must be one of %s" % (where, ", ".join(CLIMATES)))
                    else:
                        out["filters"][k] = lst
            for k in ("size", "footprint"):
                if k in e:
                    v = e[k]
                    if not (isinstance(v, list) and len(v) == 2 and all(isinstance(n, int) and not isinstance(n, bool)
                                                                        and 1 <= n <= 64 for n in v)):
                        errors.append("%s: %s must be [x, y] in squares" % (where, k))
                    elif k == "size":
                        out["filters"]["size"] = v
                    else:
                        out["footprint"] = v
            if "length" in e:
                if not is_num(e["length"]) or not 0 < e["length"] <= 16:
                    errors.append(where + ": length must be the car length in squares (e.g. 0.5)")
                else:
                    out["length"] = float(e["length"])
            if out["kind"] not in DRAWN_KINDS and out["model"]:
                warnings.append("%s: %s models are not drawn by the dashboard yet (generated instead)" % (where, out["kind"]))
            if not out["model"] and out["lod"]:
                errors.append(where + ": lod without model")
            entries.append(out)
    for e in entries:
        if e["generator"] and e["generator"] not in generators:
            warnings.append("entries[%d]: generator %s is not in generators (the rules' own category of that name is "
                            "used, if any)" % (e["index"], json.dumps(e["generator"])))
    if errors:
        return None, errors, warnings
    pak = dict(meta, format=FORMAT, units=units, entries=entries, generators=generators, rules=rules)
    return pak, errors, warnings


def glob_re(p):
    return re.compile("^" + re.escape(p).replace(r"\*", ".*").replace(r"\?", ".") + "$", re.S)


def entry_matches(e, d):
    name = d.get("name") or ""
    if e["exact"]:
        if e["pattern"] != name:
            return False
    elif not glob_re(e["pattern"]).match(name):
        return False
    f = e["filters"]
    for k in ("type", "waytype", "system", "freight"):
        if k in f and d.get(k) not in f[k]:
            return False
    if "size" in f and list(d.get("size") or []) != f["size"]:
        return False
    if "climate" in f:
        mask = 0
        for c in f["climate"]:
            mask |= 1 << CLIMATES.index(c)
        if d.get("climates") is None or not d["climates"] & mask:
            return False
    return True


class Matcher:
    """entries of a pak for the descs of a catalogue: exact names first (file order), then patterns (file order)"""

    def __init__(self, pak, cat):
        self.by_kind = {}
        for e in (pak or {}).get("entries", []):
            self.by_kind.setdefault(e["kind"], []).append(e)
        for lst in self.by_kind.values():
            lst.sort(key=lambda e: (0 if e["exact"] else 1, e["index"]))
        self.cat = cat or {}
        self.cache = {}

    def of(self, kind, d):
        """entry for desc d (dict) of kind, or None"""
        key = (kind, d.get("i"), d.get("name"))
        if key not in self.cache:
            self.cache[key] = next((e for e in self.by_kind.get(kind, []) if entry_matches(e, d)), None)
        return self.cache[key]


def expand(e, path, season, climate):
    s, c = SEASONS[season & 3], CLIMATES[climate & 7]
    if e["variants"]["season"]:
        s = e["variants"]["season"][s]
    if e["variants"]["climate"]:
        c = e["variants"]["climate"][c]
    return path.replace("{season}", s).replace("{climate}", c)


def all_paths(e):
    """every file an entry can use (model and LODs with all their variants)"""
    out = []
    for p in ([e["model"]] if e["model"] else []) + e["lod"]:
        seasons = range(4) if "{season}" in p else [0]
        climates = range(8) if "{climate}" in p else [0]
        for s in seasons:
            for c in climates:
                q = expand(e, p, s, c)
                if q not in out:
                    out.append(q)
    return out


# --- glTF ------------------------------------------------------------------------------------------------------------

def parse_gltf(data):
    """(json, bin) of a .glb (bin may be None) or of a .gltf (bin None); raises ValueError with a readable text"""
    if data[:4] == b"glTF":
        if len(data) < 20:
            raise ValueError("truncated .glb header")
        _, version, total = struct.unpack_from("<4sII", data, 0)
        if version != 2:
            raise ValueError("glTF version %d (only 2 is supported)" % version)
        if total > len(data):
            raise ValueError("truncated .glb (%d of %d bytes)" % (len(data), total))
        len0, type0 = struct.unpack_from("<II", data, 12)
        if type0 != 0x4E4F534A or 20 + len0 > total:
            raise ValueError("the first .glb chunk is not JSON")
        try:
            j = json.loads(data[20:20 + len0].decode("utf-8"))
        except ValueError as ex:
            raise ValueError("the JSON chunk does not parse: %s" % ex)
        b = None
        o = 20 + len0
        if o + 8 <= total:
            len1, type1 = struct.unpack_from("<II", data, o)
            if type1 == 0x004E4942 and o + 8 + len1 <= total:
                b = data[o + 8:o + 8 + len1]
        return j, b
    try:
        return json.loads(data.decode("utf-8")), None
    except ValueError as ex:
        raise ValueError("neither a .glb nor glTF JSON: %s" % ex)


def image_size(b):
    """(w, h, type) of PNG, JPEG or WebP bytes, or None"""
    if not b or len(b) < 30:
        return None
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack_from(">II", b, 16)
        return w, h, "png"
    if b[:2] == b"\xff\xd8":
        o = 2
        while o + 9 < len(b):
            if b[o] != 0xFF:
                o += 1
                continue
            m = b[o + 1]
            ln = (b[o + 2] << 8) | b[o + 3]
            if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack_from(">HH", b, o + 5)
                return w, h, "jpeg"
            o += 2 + ln
        return None
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        c = b[12:16]
        if c == b"VP8 ":
            w, h = struct.unpack_from("<HH", b, 26)
            return w & 0x3FFF, h & 0x3FFF, "webp"
        if c == b"VP8L":
            v = struct.unpack_from("<I", b, 21)[0]
            return (v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1, "webp"
        if c == b"VP8X":
            return (b[24] | b[25] << 8 | b[26] << 16) + 1, (b[27] | b[28] << 8 | b[29] << 16) + 1, "webp"
    return None


def _mul(a, b):
    o = [0.0] * 16
    for c in range(4):
        for r in range(4):
            o[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return o


def _node_matrix(n):
    if isinstance(n.get("matrix"), list) and len(n["matrix"]) == 16:
        return [float(v) for v in n["matrix"]]
    tx, ty, tz = n.get("translation", [0, 0, 0])
    x, y, z, w = n.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = n.get("scale", [1, 1, 1])
    xx, yy, zz, xy, xz, yz, wx, wy, wz = x * x, y * y, z * z, x * y, x * z, y * z, w * x, w * y, w * z
    return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
            2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
            2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1]


def _bounds(j, b, ai):
    acc = (j.get("accessors") or [])
    if ai is None or ai >= len(acc):
        return None
    a = acc[ai]
    if isinstance(a.get("min"), list) and isinstance(a.get("max"), list) and len(a["min"]) >= 3:
        return a["min"], a["max"]
    bvs = j.get("bufferViews") or []
    if b is None or a.get("componentType") != 5126 or a.get("bufferView") is None or a["bufferView"] >= len(bvs):
        return None
    bv = bvs[a["bufferView"]]
    stride = bv.get("byteStride") or 12
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    mn, mx = [float("inf")] * 3, [float("-inf")] * 3
    for i in range(a.get("count", 0)):
        v = struct.unpack_from("<3f", b, base + i * stride)
        for k in range(3):
            mn[k], mx[k] = min(mn[k], v[k]), max(mx[k], v[k])
    return mn, mx


def gltf_stats(j, b, read_file=None):
    """triangles, bbox (node transforms applied), materials, cameras, lights, images [(w, h, type, where)],
    unsupported extensions, problems reading external files. read_file(uri) -> bytes for .gltf resources."""
    out = {"triangles": 0, "bbox": None, "materials": [(m or {}).get("name", "") for m in j.get("materials") or []],
           "cameras": len(j.get("cameras") or []), "lights": 0, "images": [], "unsupported": [], "problems": []}
    out["unsupported"] = [x for x in j.get("extensionsRequired") or [] if x in UNSUPPORTED_EXT]
    le = (j.get("extensions") or {}).get("KHR_lights_punctual") or {}
    out["lights"] = len(le.get("lights") or [])
    if b is None and read_file and (j.get("buffers") or []):
        uri = j["buffers"][0].get("uri")
        if uri and not uri.startswith("data:"):
            try:
                b = read_file(uri)
            except OSError as ex:
                out["problems"].append("buffer %s: %s" % (uri, ex))
        elif uri and uri.startswith("data:"):
            b = base64.b64decode(uri.split(",", 1)[1])
    nodes, meshes, acc = j.get("nodes") or [], j.get("meshes") or [], j.get("accessors") or []
    mn, mx = [float("inf")] * 3, [float("-inf")] * 3

    def visit(ni, parent, depth):
        if ni >= len(nodes) or depth > 64:
            return
        n = nodes[ni]
        m = _mul(parent, _node_matrix(n))
        if n.get("camera") is not None:
            out["cameras"] += 1
        if (n.get("extensions") or {}).get("KHR_lights_punctual"):
            out["lights"] += 1
        mesh = meshes[n["mesh"]] if n.get("mesh") is not None and n["mesh"] < len(meshes) else None
        for p in (mesh or {}).get("primitives") or []:
            pos = (p.get("attributes") or {}).get("POSITION")
            ai = p.get("indices") if p.get("indices") is not None else pos
            count = acc[ai].get("count", 0) if ai is not None and ai < len(acc) else 0
            mode = p.get("mode", 4)
            out["triangles"] += count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
            bb = _bounds(j, b, pos)
            if bb:
                for k in range(8):
                    x, y, z = bb[k & 1][0], bb[(k >> 1) & 1][1], bb[(k >> 2) & 1][2]
                    v = (m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
                         m[2] * x + m[6] * y + m[10] * z + m[14])
                    for c in range(3):
                        mn[c], mx[c] = min(mn[c], v[c]), max(mx[c], v[c])
        for c in n.get("children") or []:
            visit(c, m, depth + 1)

    scenes = j.get("scenes") or []
    roots = (scenes[j.get("scene", 0)] if j.get("scene", 0) < len(scenes) else scenes[0]).get("nodes", []) if scenes \
        else range(len(nodes))
    ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for r in roots:
        visit(r, ident, 0)
    if mn[0] <= mx[0]:
        out["bbox"] = mn + mx
    bvs = j.get("bufferViews") or []
    for k, im in enumerate(j.get("images") or []):
        s, where = None, "image %d" % k
        if im.get("bufferView") is not None and b is not None and im["bufferView"] < len(bvs):
            bv = bvs[im["bufferView"]]
            o = bv.get("byteOffset", 0)
            s = image_size(b[o:o + bv.get("byteLength", 0)])
        elif isinstance(im.get("uri"), str) and im["uri"].startswith("data:"):
            try:
                s = image_size(base64.b64decode(im["uri"].split(",", 1)[1]))
            except ValueError:
                s = None
        elif isinstance(im.get("uri"), str):
            where = im["uri"]
            if read_file:
                try:
                    s = image_size(read_file(im["uri"]))
                except OSError as ex:
                    out["problems"].append("image %s: %s" % (im["uri"], ex))
                    continue
        out["images"].append((s[0], s[1], s[2], where) if s else (0, 0, "unknown", where))
    return out


# --- LICENSES.md ---------------------------------------------------------------------------------------------------

def parse_licenses(text):
    """rows [{file, author, license, source, notes, line}] of the Markdown tables with the columns File and Author"""
    rows, cols = [], None
    for no, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line.startswith("|"):
            cols = None
            continue
        cells = [c.strip().replace("`", "") for c in line.strip("|").split("|")]
        if all(re.match(r"^:?-{2,}:?$", c) for c in cells):
            continue
        if cols is None:
            names = [c.lower() for c in cells]
            if "file" in names and "author" in names:
                cols = names
            continue

        def at(k):
            for i, c in enumerate(cols):
                if c in (k, k + "s") and i < len(cells):
                    return cells[i]
            return ""
        rows.append({"file": at("file"), "author": at("author"), "license": at("license"), "source": at("source"),
                     "notes": at("note"), "line": no})
    return rows


def license_kind(text):
    """'CC BY 4.0' (also for an empty cell), 'CC0', or None for anything else"""
    t = re.sub(r"[\s_-]+", " ", (text or "").strip().upper())
    if not t or t in ("CC BY 4.0", "CC BY 4", "CCBY 4.0"):
        return "CC BY 4.0"
    if t in ("CC0", "CC0 1.0", "CC 0", "CC ZERO"):
        return "CC0"
    return None


def file_listed(path, rows):
    return any(r["file"] == path or (any(c in r["file"] for c in "*?[") and fnmatch.fnmatchcase(path, r["file"]))
               for r in rows)


# --- scene3d chunks ----------------------------------------------------------------------------------------------

OBJS_LAYOUT = "x:u8,y:u8,z:i8,kind:u8,desc:i16,a:u16,b:u16,owner:i8"
KIND = {"WAY": 0, "BUILDING": 1, "TREE": 2, "BRIDGE": 3, "TUNNEL": 4, "SIGN": 5, "WAYOBJ": 6}
VEH_LAYOUT = ("cnv:u16,desc:i16,x:u16,y:u16,ox:i16,oy:i16,zoff:i16,speed:u16,flags:u16,idx:u8,kind:u8,z:i8,"
              "dir:u8,steps:u8,steps_next:u8,nx:i8,ny:i8,nz:i8,owner:i8")


def decode_objs(reply):
    """columns (dict of lists) of the objects of a scene3d reply (binary block or objs=json rows)"""
    n = reply.get("count", 0)
    if isinstance(reply.get("objs"), list):
        rows = reply["objs"]
        keys = ["x", "y", "z", "kind", "desc", "a", "b", "owner"]
        return {k: [r[i] for r in rows] for i, k in enumerate(keys)}
    if reply.get("objs_layout") != OBJS_LAYOUT:
        raise ValueError("unknown scene3d layout %s" % reply.get("objs_layout"))
    import zlib
    b = zlib.decompress(base64.b64decode(reply["objs"])) if n else b""
    if len(b) != 11 * n:
        raise ValueError("bad scene3d block size")
    return {"x": list(b[0:n]), "y": list(b[n:2 * n]), "z": list(struct.unpack_from("<%db" % n, b, 2 * n)),
            "kind": list(b[3 * n:4 * n]), "desc": list(struct.unpack_from("<%dh" % n, b, 4 * n)),
            "a": list(struct.unpack_from("<%dH" % n, b, 6 * n)), "b": list(struct.unpack_from("<%dH" % n, b, 8 * n)),
            "owner": list(struct.unpack_from("<%db" % n, b, 10 * n))}


def decode_vehicles(reply):
    """(desc, kind) columns of a vehicles3d reply"""
    n = reply.get("count", 0)
    if isinstance(reply.get("objs"), list):
        return [r[1] for r in reply["objs"]], [r[10] for r in reply["objs"]]
    if reply.get("objs_layout") != VEH_LAYOUT:
        raise ValueError("unknown vehicles3d layout %s" % reply.get("objs_layout"))
    import zlib
    b = zlib.decompress(base64.b64decode(reply["objs"])) if n else b""
    if len(b) != 28 * n:
        raise ValueError("bad vehicles3d block size")
    return list(struct.unpack_from("<%dh" % n, b, 2 * n)), list(b[18 * n + n:18 * n + 2 * n])
