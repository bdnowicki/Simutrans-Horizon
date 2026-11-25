#!/usr/bin/env python3
# Simutrans-Horizon: how much of a running game a pak 3D covers with models - the to-do list for modelers.
# Standard library only. Reads the objects of the whole map from a dashboard bridge (a token link of any role) or
# straight from a game with -remote_control, matches them against a pak 3D manifest and reports per kind how many
# object types and copies have a model, and the objects without one that occur most often.
#   python tools/pak3d/coverage.py --bridge http://127.0.0.1:13380 --token TOKEN [--pak3d DIR] [--top 30] [--json OUT]
#   python tools/pak3d/coverage.py --engine 127.0.0.1:13360 --pak3d DIR
# Without --pak3d the manifest is the one the bridge serves under /pak3d/. Artistic License, see LICENSE.txt.
import argparse
import collections
import http.cookiejar
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pak3dlib as P  # noqa: E402

CHUNK = 64
REGION = 256
KINDS = "buildings,vehicles,ways,bridges,tunnels,trees,signs,wayobjs,citycars,pedestrians"


class Bridge:
    """GET requests to a dashboard bridge with a session from a token link; 429 waits for Retry-After"""

    def __init__(self, url, token):
        self.base = url.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.op.addheaders = [("User-Agent", "simutrans-pak3d-coverage")]
        with self.op.open(self.base + "/?token=" + urllib.parse.quote(token), timeout=30) as r:
            r.read()
        if not any(c.name.startswith("sdash_") for c in self.jar):
            raise SystemExit("the bridge did not accept the token")

    def get(self, path, raw=False):
        for _ in range(60):
            try:
                with self.op.open(self.base + path, timeout=60) as r:
                    data = r.read()
                    return data if raw else json.loads(data)
            except urllib.error.HTTPError as ex:
                if ex.code in (429, 503):
                    time.sleep(float(ex.headers.get("Retry-After") or 1))
                    continue
                if ex.code == 404 and raw:
                    return None
                raise SystemExit("%s: HTTP %d %s" % (path, ex.code, ex.read()[:200]))
        raise SystemExit("%s: still busy after 60 tries" % path)

    def desc_list(self):
        return self.get("/api/desc_list?kinds=" + KINDS)

    def world(self):
        w = (self.get("/api/poll") or {}).get("world") or {}
        return w.get("size_x"), w.get("size_y")

    def scene(self, cx, cy):
        return self.get("/api/scene3d?cx=%d&cy=%d" % (cx, cy))

    def vehicles(self, x1, y1, x2, y2, extras):
        time.sleep(0.21)  # the bridge allows 5 per second and session
        return self.get("/api/vehicles3d?x1=%d&y1=%d&x2=%d&y2=%d%s" % (x1, y1, x2, y2, "&extras=1" if extras else ""))

    def manifest(self):
        data = self.get("/pak3d/manifest.json", raw=True)
        return json.loads(data) if data else None


class Engine:
    """the remote control protocol of the game (one connection, one JSON line per command, arguments a=1&b=2)"""

    def __init__(self, addr):
        host, _, port = addr.rpartition(":")
        self.s = socket.create_connection((host or "127.0.0.1", int(port)), timeout=60)
        self.f = self.s.makefile("rwb")
        self.f.write(b"HELLO simutrans-remote 1\n")
        self.f.flush()
        self.f.readline()

    def cmd(self, line):
        self.f.write((line + "\n").encode())
        self.f.flush()
        r = json.loads(self.f.readline())
        if not r.get("ok", True):
            raise SystemExit("%s: %s" % (line, r.get("error")))
        return r

    def desc_list(self):
        return self.cmd("desc_list kinds=" + KINDS)

    def world(self):
        w = self.cmd("poll").get("world") or {}
        return w.get("size_x"), w.get("size_y")

    def scene(self, cx, cy):
        return self.cmd("scene3d cx=%d&cy=%d" % (cx, cy))

    def vehicles(self, x1, y1, x2, y2, extras):
        return self.cmd("vehicles3d x1=%d&y1=%d&x2=%d&y2=%d%s" % (x1, y1, x2, y2, "&extras=1" if extras else ""))

    def manifest(self):
        return None


def count(src, cat, extras, progress, pak=None):
    """instances per (kind, desc index) on the whole map, the buildings among them that the places of the pak
    (entries with "at") cover per (kind, desc index), and per entry index"""
    sx, sy = src.world()
    if not sx:
        raise SystemExit("no world loaded")
    n = collections.Counter()
    covered, per_place = collections.Counter(), collections.Counter()
    places = [e for e in (pak or {}).get("entries", []) if e.get("at") and e["model"]]
    blds = {d["i"]: d for d in cat.get("buildings", [])}
    rects = {}
    nx, ny = -(-sx // CHUNK), -(-sy // CHUNK)
    for cy in range(ny):
        for cx in range(nx):
            sc = src.scene(cx, cy)
            o = P.decode_objs(sc)
            rot = sc.get("rotation", 0) & 3
            if places and rot not in rects:
                rects[rot] = [(P.placed_rect(e, rot, (sx, sy)), e) for e in places]
            x0, y0 = sc.get("x0", cx * CHUNK), sc.get("y0", cy * CHUNK)
            for i in range(len(o["kind"])):
                k = o["kind"][i]
                if k == P.KIND["BUILDING"]:
                    if o["b"][i] == 0:
                        n[("building", o["desc"][i])] += 1
                        d = blds.get(o["desc"][i]) if places else None
                        gx, gy = x0 + o["x"][i], y0 + o["y"][i]
                        for q, e in rects.get(rot, ()) if d else ():
                            if q and q[0] <= gx < q[0] + q[2] and q[1] <= gy < q[1] + q[3] and P.entry_matches(e, d):
                                covered[("building", o["desc"][i])] += 1
                                per_place[e["index"]] += 1
                                break
                elif k == P.KIND["TREE"]:
                    n[("tree", o["desc"][i])] += 1
                elif k == P.KIND["SIGN"]:
                    n[("sign", o["desc"][i])] += 1
                elif k == P.KIND["WAY"]:
                    n[("way", o["desc"][i])] += 1
                elif k == P.KIND["BRIDGE"]:
                    n[("bridge", o["desc"][i])] += 1
                elif k == P.KIND["TUNNEL"]:
                    n[("tunnel", o["desc"][i])] += 1
                elif k == P.KIND["WAYOBJ"]:
                    n[("wayobj", o["desc"][i])] += 1
        if progress:
            print("  scene %d/%d rows of chunks" % (cy + 1, ny), file=sys.stderr)
    for y in range(0, sy, REGION):
        for x in range(0, sx, REGION):
            desc, kind = P.decode_vehicles(src.vehicles(x, y, min(sx, x + REGION) - 1, min(sy, y + REGION) - 1, extras))
            for d, k in zip(desc, kind):
                n[(("vehicle", "citycar", "pedestrian")[k] if k < 3 else "vehicle", d)] += 1
    return n, covered, per_place


def report(cat, pak, n, top, covered=None, per_place=None):
    covered, per_place = covered or {}, per_place or {}
    m = P.Matcher(pak, cat)
    lists = {k: {d["i"]: d for d in cat.get(v, [])} for k, v in P.KIND_LIST.items()}
    rows = collections.defaultdict(lambda: [0, 0, 0, 0])  # group -> [types, types with model, copies, with model]
    missing = []
    for (kind, i), c in n.items():
        d = lists.get(kind, {}).get(i)
        if d is None:
            continue
        e = m.of(kind, d) if pak else None
        has = bool(e and e["model"])
        group = kind + (":" + d.get("type", "?") if kind == "building" else "")
        r = rows[group]
        r[0] += 1
        r[2] += c
        if has and kind in P.DRAWN_KINDS:
            r[1] += 1
            r[3] += c
        else:
            cov = 0 if has else min(c, covered.get((kind, i), 0))  # copies drawn by a model bound to their place
            r[3] += cov
            if cov and cov >= c:
                r[1] += 1
            if c > cov:
                missing.append((c - cov, group, d.get("name", "?"), "declared, drawn generated" if has else
                                "%d more at the places of the pak" % cov if cov else ""))
    places = [e for e in (pak or {}).get("entries", []) if e.get("at")]
    out = {"groups": {g: {"types": r[0], "types_model": r[1], "copies": r[2], "copies_model": r[3]} for g, r in rows.items()},
           "missing": [{"copies": c, "kind": g, "name": nm, "note": note} for c, g, nm, note in sorted(missing, reverse=True)],
           "places": [{"entry": e["index"], "match": e["pattern"], "at": e["at"], "covered": per_place.get(e["index"], 0)}
                      for e in places]}
    order = sorted(rows, key=lambda g: (list(P.KIND_LIST).index(g.split(":")[0]), g))
    print("\n%-22s %8s %8s %6s %10s %10s %6s" % ("kind", "types", "model", "%", "copies", "model", "%"))
    tot = [0, 0, 0, 0]
    for g in order:
        r = rows[g]
        tot = [a + b for a, b in zip(tot, r)]
        note = "" if g.split(":")[0] in P.DRAWN_KINDS else "  (models not drawn yet)"
        print("%-22s %8d %8d %5.1f%% %10d %10d %5.1f%%%s" % (g, r[0], r[1], 100.0 * r[1] / max(1, r[0]), r[2], r[3],
                                                             100.0 * r[3] / max(1, r[2]), note))
    print("%-22s %8d %8d %5.1f%% %10d %10d %5.1f%%" % ("all", tot[0], tot[1], 100.0 * tot[1] / max(1, tot[0]), tot[2],
                                                        tot[3], 100.0 * tot[3] / max(1, tot[2])))
    if places:
        print("\nModels bound to a place (entries with \"at\"):")
        for p in out["places"]:
            print("  entries[%d] %s at %d,%d: %s" % (p["entry"], p["match"], p["at"][0], p["at"][1],
                                                   "%d building(s) covered" % p["covered"] if p["covered"]
                                                   else "nothing that matches stands there (another map?)"))
    print("\nWithout a model, most copies first (the to-do list):")
    print("%5s %10s  %-22s %s" % ("rank", "copies", "kind", "name"))
    for k, x in enumerate(out["missing"][:top], 1):
        print("%5d %10d  %-22s %s%s" % (k, x["copies"], x["kind"], x["name"], "  (" + x["note"] + ")" if x["note"] else ""))
    return out


def main():
    ap = argparse.ArgumentParser(description="Coverage of a running game by the models of a pak 3D.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--bridge", help="URL of a dashboard bridge, e.g. http://127.0.0.1:13380 (needs --token)")
    src.add_argument("--engine", help="HOST:PORT of a game started with -remote_control (needs --pak3d)")
    ap.add_argument("--token", help="a token of the bridge (viewer is enough)")
    ap.add_argument("--pak3d", help="pak 3D directory (default: the manifest the bridge serves)")
    ap.add_argument("--extras", action="store_true", help="also count city cars and pedestrians")
    ap.add_argument("--top", type=int, default=30, help="rows of the to-do list (default 30)")
    ap.add_argument("--json", help="also write the result to this JSON file")
    ap.add_argument("--quiet", action="store_true", help="no progress lines")
    a = ap.parse_args()
    if a.bridge and not a.token:
        ap.error("--bridge needs --token")
    if a.engine and not a.pak3d:
        ap.error("--engine needs --pak3d")
    s = Bridge(a.bridge, a.token) if a.bridge else Engine(a.engine)
    if a.pak3d:
        with open(os.path.join(a.pak3d, "manifest.json"), encoding="utf-8") as f:
            manifest = json.load(f)
    else:
        manifest = s.manifest()
        if manifest is None:
            print("the bridge serves no pak 3D: everything is generated (give --pak3d DIR to check a pak)")
    pak = None
    if manifest is not None:
        pak, errors, warnings = P.validate_manifest(manifest)
        for e in errors:
            print("manifest error: " + e)
        if pak is None:
            return 1
    cat = s.desc_list()
    t0 = time.time()
    n, covered, per_place = count(s, cat, a.extras, not a.quiet, pak)
    print("%s: %s %s, %d entries; map read in %.1f s" % ("pak 3D" if pak else "no pak 3D", (pak or {}).get("name", ""),
                                                        (pak or {}).get("version", ""), len((pak or {}).get("entries", [])),
                                                        time.time() - t0))
    out = report(cat, pak, n, a.top, covered, per_place)
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
