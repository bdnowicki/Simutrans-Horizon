#!/usr/bin/env python3
# Simutrans-Horizon: checks a pak 3D directory (manifest, model files, limits, licences) before it is published.
# Standard library only. Usage (tools/pak3d/README.md):
#   python tools/pak3d/check_pak3d.py PAK_DIR [--descs desc_list.json] [--strict] [--quiet]
# Exit code 0 = no errors (warnings allowed unless --strict), 1 = errors, 2 = the directory cannot be read.
# Artistic License, see LICENSE.txt.
import argparse
import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pak3dlib as P  # noqa: E402

SERVED = (".json", ".glb", ".gltf", ".bin", ".png", ".webp", ".ktx2", ".jpg", ".jpeg", ".txt", ".md")
NOT_LISTED = ("LICENSES.md", "LICENSE", "LICENSE.md", "LICENSE.txt", "README.md", "README.txt")
FOOT_TOL = 0.1      # squares a building may reach over its footprint (or be off centre)
LEN_TOL = 0.25      # share a vehicle may differ from its length (warning above a third of it)
GROUND_TOL = 0.05   # squares the lowest point may lie above or below the ground


class Report:
    def __init__(self, quiet):
        self.errors, self.warnings, self.quiet = [], [], quiet

    def error(self, where, text):
        self.errors.append("%s: %s" % (where, text))
        print("ERROR %s: %s" % (where, text))

    def warn(self, where, text):
        self.warnings.append("%s: %s" % (where, text))
        if not self.quiet:
            print("WARN  %s: %s" % (where, text))


def load_descs(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    return d.get("reply", d) if isinstance(d, dict) else {}


def check_model(rep, root, path, uses, descs, stats_out):
    """one model file against every entry that uses it"""
    full = os.path.join(root, *path.split("/"))
    if not os.path.isfile(full):
        rep.error(path, "missing (used by entries %s)" % ", ".join(str(e["index"]) for e, _ in uses))
        return
    with open(full, "rb") as f:
        data = f.read()
    try:
        j, b = P.parse_gltf(data)
    except ValueError as ex:
        rep.error(path, str(ex))
        return
    base = os.path.dirname(full)

    def read_file(uri):
        rel = urllib.parse.unquote(uri)
        parts = rel.split("/")
        if rel.startswith("/") or "\\" in rel or ":" in rel or any(s in ("", "..") or s.startswith(".") for s in parts):
            raise OSError("not a file inside the pak")
        full2 = os.path.normpath(os.path.join(base, *parts))
        if os.path.commonpath([full2, os.path.normpath(root)]) != os.path.normpath(root):
            raise OSError("not a file inside the pak")
        with open(full2, "rb") as f2:
            return f2.read()
    s = P.gltf_stats(j, b, read_file)
    for p in s["problems"]:
        rep.error(path, p)
    if (j.get("asset") or {}).get("version") != "2.0":
        rep.error(path, "asset.version must be \"2.0\"")
    if s["cameras"]:
        rep.error(path, "holds %d camera(s): remove them before exporting" % s["cameras"])
    if s["lights"]:
        rep.error(path, "holds %d light(s): remove them (KHR_lights_punctual) before exporting" % s["lights"])
    if s["unsupported"]:
        rep.error(path, "needs %s, which the dashboard does not decode (no Draco, meshopt or KTX2)" % ", ".join(s["unsupported"]))
    if not s["triangles"] or not s["bbox"]:
        rep.error(path, "no triangles with bounds")
        return
    kinds = sorted({e["kind"] for e, _ in uses})
    featured = all(e["featured"] for e, _ in uses)
    for kind in kinds:
        limit = P.LIMITS[kind][1 if featured else 0]
        if s["triangles"] > limit:
            rep.error(path, "%d triangles, limit %d for %s%s models" % (s["triangles"], limit, "featured " if featured else "", kind))
    xl = P.TEXTURE_LIMIT[1 if featured else 0]
    for w, h, t, where in s["images"]:
        if t == "unknown":
            rep.error(path, "%s: not a PNG, JPEG or WebP image" % where)
        elif w > xl or h > xl:
            rep.error(path, "%s: texture %dx%d, limit %d%s" % (where, w, h, xl, " (featured)" if featured else ""))
        elif w & (w - 1) or h & (h - 1):
            rep.warn(path, "%s: texture %dx%d is not a power of two (mipmaps on old devices)" % (where, w, h))
    tile = 1.0
    for e, pak in uses:
        tile = pak["units"]["tile"]
    sc = 1.0 / tile
    x0, y0, z0, x1, y1, z1 = [v * sc for v in s["bbox"]]
    mats = set(s["materials"])
    for e, _ in uses:
        where = "%s (entries[%d] %s:%s)" % (path, e["index"], e["kind"], e["pattern"])
        for name in e["player"]:
            if name not in mats:
                rep.warn(where, "player_color names material %s, which the model does not have" % json.dumps(name))
        if abs(y0) > GROUND_TOL and e["kind"] != "vehicle":
            rep.warn(where, "lowest point at %.3f squares: the origin belongs on the ground" % y0)
        foot = e["footprint"] or ([1, 1] if e.get("at") else None)
        if foot is None and e["kind"] == "building" and e["exact"] and descs:
            d = next((d for d in descs.get("buildings", []) if d.get("name") == e["pattern"]), None)
            foot = d.get("size") if d else None
        if e["kind"] == "building" and foot:
            sx, sy = foot
            if x0 < -sx / 2 - FOOT_TOL or x1 > sx / 2 + FOOT_TOL or z0 < -sy / 2 - FOOT_TOL or z1 > sy / 2 + FOOT_TOL:
                rep.error(where, "reaches over its %dx%d footprint: x %.2f..%.2f, z %.2f..%.2f (origin = middle of the "
                          "footprint, layout 0: +X = east, +Z = south)" % (sx, sy, x0, x1, z0, z1))
            elif (x1 - x0) < sx * 0.5 or (z1 - z0) < sy * 0.5:
                rep.warn(where, "covers less than half of its %dx%d footprint (%.2f x %.2f)" % (sx, sy, x1 - x0, z1 - z0))
            if abs((x0 + x1) / 2) > FOOT_TOL * max(1, sx) or abs((z0 + z1) / 2) > FOOT_TOL * max(1, sy):
                rep.warn(where, "off centre by %.2f, %.2f squares" % ((x0 + x1) / 2, (z0 + z1) / 2))
        length = e["length"]
        if length is None and e["kind"] == "vehicle" and e["exact"] and descs:
            d = next((d for d in descs.get("vehicles", []) if d.get("name") == e["pattern"]), None)
            length = d["length"] / 16 if d and d.get("length") else None
        if e["kind"] in ("vehicle", "citycar") and length:
            ratio = (x1 - x0) / length
            if abs(ratio - 1) > LEN_TOL:
                rep.error(where, "%.2f squares long along X, the vehicle is %.2f (front = +X, origin in the middle)"
                          % (x1 - x0, length))
            elif abs(ratio - 1) > LEN_TOL / 3:
                rep.warn(where, "%.2f squares long along X, the vehicle is %.2f" % (x1 - x0, length))
            if abs((x0 + x1) / 2) > length * 0.15:
                rep.warn(where, "off centre along X by %.2f squares" % ((x0 + x1) / 2))
        if e["kind"] in ("tree", "sign") and (max(x1 - x0, z1 - z0) > 1.5 or abs((x0 + x1) / 2) > 0.2 or abs((z0 + z1) / 2) > 0.2):
            rep.warn(where, "a %s should stand on its origin within one square (x %.2f..%.2f, z %.2f..%.2f)"
                     % (e["kind"], x0, x1, z0, z1))
    stats_out.append((path, s["triangles"], len(s["materials"]),
                      ",".join(sorted(m for m in mats if m in (P.PLAYER1, P.PLAYER2, P.NIGHT))) or "-",
                      "%.2fx%.2fx%.2f" % (x1 - x0, y1 - y0, z1 - z0),
                      ",".join("%dx%d" % (w, h) for w, h, _, _ in s["images"]) or "-"))


def check(root, descs=None, quiet=False):
    rep = Report(quiet)
    mpath = os.path.join(root, "manifest.json")
    if not os.path.isfile(mpath):
        rep.error("manifest.json", "missing")
        return rep, None
    try:
        with open(mpath, encoding="utf-8") as f:
            j = json.load(f)
    except ValueError as ex:
        rep.error("manifest.json", "not valid JSON: %s" % ex)
        return rep, None
    pak, errors, warnings = P.validate_manifest(j)
    for w in warnings:
        rep.warn("manifest.json", w)
    for e in errors:
        rep.error("manifest.json", e)
    if pak is None:
        return rep, None
    # rules and generator categories
    files_used = {"manifest.json"}
    for what, p in ([("rules", pak["rules"])] if isinstance(pak["rules"], str) else []) + \
            [("generators." + k, v) for k, v in pak["generators"].items()]:
        files_used.add(p)
        full = os.path.join(root, *p.split("/"))
        try:
            with open(full, encoding="utf-8") as f:
                v = json.load(f)
            if not isinstance(v, dict):
                rep.error(p, "%s must hold a JSON object" % what)
        except OSError:
            rep.error(p, "missing (%s)" % what)
        except ValueError as ex:
            rep.error(p, "not valid JSON: %s" % ex)
    # models
    uses = {}
    for e in pak["entries"]:
        for p in P.all_paths(e):
            uses.setdefault(p, []).append((e, pak))
            files_used.add(p)
    stats = []
    for p in sorted(uses):
        check_model(rep, root, p, uses[p], descs, stats)
    # entries against the catalogue of a game
    if descs:
        for e in pak["entries"]:
            lst = descs.get(P.KIND_LIST[e["kind"]], [])
            hits = [d for d in lst if P.entry_matches(e, d)]
            if not hits:
                rep.warn("manifest.json", "entries[%d] %s:%s matches nothing in the catalogue" % (e["index"], e["kind"], e["pattern"]))
    # licences
    lic = os.path.join(root, "LICENSES.md")
    rows = []
    if not os.path.isfile(lic):
        rep.error("LICENSES.md", "missing: every file needs its author and licence")
    else:
        with open(lic, encoding="utf-8") as f:
            rows = P.parse_licenses(f.read())
        if not rows:
            rep.error("LICENSES.md", "no table with the columns File | Author | License (| Source | Notes)")
        for r in rows:
            where = "LICENSES.md line %d" % r["line"]
            if not r["file"]:
                rep.error(where, "no file")
            if not r["author"]:
                rep.error(where, "%s: no author" % r["file"])
            kind = P.license_kind(r["license"])
            if kind is None:
                rep.error(where, "%s: licence %s (CC BY 4.0, or CC0 with its note)" % (r["file"], json.dumps(r["license"])))
            elif kind == "CC0" and not (r["notes"] or r["source"]):
                rep.error(where, "%s: CC0 needs its note (source or notes column)" % r["file"])
    present = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.startswith("."):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
            if rel in NOT_LISTED or not fn.lower().endswith(SERVED):
                continue
            present.append(rel)
            if rows and not P.file_listed(rel, rows):
                rep.error(rel, "not in LICENSES.md (author and licence of every file)")
            if rel.lower().endswith((".glb", ".gltf")) and rel not in files_used:
                rep.warn(rel, "not used by any entry")
    for r in rows:
        if r["file"] and not any(P.file_listed(p, [r]) for p in present) and r["file"] not in NOT_LISTED:
            rep.warn("LICENSES.md line %d" % r["line"], "%s names no file of the pak" % r["file"])
    return rep, (pak, stats)


def main():
    ap = argparse.ArgumentParser(description="Checks a pak 3D directory for the Simutrans-Horizon dashboard.")
    ap.add_argument("pak", help="the pak 3D directory (with manifest.json)")
    ap.add_argument("--descs", help="desc_list reply of the game (JSON file, e.g. saved from /api/desc_list): checks "
                                    "that entries match objects and takes footprints and lengths from it")
    ap.add_argument("--strict", action="store_true", help="warnings count as errors")
    ap.add_argument("--quiet", action="store_true", help="print only errors and the summary")
    a = ap.parse_args()
    if not os.path.isdir(a.pak):
        print("ERROR %s is not a directory" % a.pak)
        return 2
    descs = None
    if a.descs:
        try:
            descs = load_descs(a.descs)
        except (OSError, ValueError) as ex:
            print("ERROR --descs: %s" % ex)
            return 2
    rep, res = check(a.pak, descs, a.quiet)
    if res:
        pak, stats = res
        print("\n%s %s: %d entries, %d model files" % (pak.get("name", "pak 3D"), pak.get("version", ""), len(pak["entries"]),
                                                       len(stats)))
        if stats and not a.quiet:
            print("  %-40s %9s %5s %-28s %-16s %s" % ("model", "triangles", "mats", "special materials", "size x*y*z", "textures"))
            for row in stats:
                print("  %-40s %9d %5d %-28s %-16s %s" % row)
    print("\n%d error(s), %d warning(s)" % (len(rep.errors), len(rep.warnings)))
    return 1 if rep.errors or (a.strict and rep.warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
