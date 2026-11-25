// Simutrans-Horizon dashboard, 3D view: models of the pak 3D in a chunk (worker side, no three.js). Before a chunk is
// built, place() finds the objects whose desc has a model entry (buildings, trees, signs), fetches and checks each
// model file once (glTF JSON: triangles, bounds, textures, no cameras or lights, against the limits of pak.js) and
// marks the objects drawn by a model (`c.modelled`, so the generators skip them; `c.modelTop` = height for picking).
// Buildings are placed here: one copy per building at its square with offset 0,0, origin at the middle of the
// footprint of its layout, turned by the layout (layout 0 as modelled, then quarter turns like the generator).
// Trees and signs are placed by nature.js and ways.js through sink(). An entry bound to a place ("at") covers the
// buildings that match it and stand (by their square with offset 0,0) in its footprint: one copy over the whole
// footprint, placed by the chunk of its north-west square (by a chunk to the east or south as an overhang copy while
// that one is not shown), turned with the map. The copies leave as "model" parts (instance
// matrices + owners per model and LOD list, pakmodels.js draws them). A model that fails (fetch, parse, limits)
// is never used again: its objects are generated. Artistic License, see LICENSE.txt.
import { K } from "./decode.js";
import { InstBuf } from "./meshbuf.js";
import { rotationOf } from "./gen/buildings.js";
import { createMatcher, entryMatches, expand, pakUrl, parseGltf, gltfStats, modelProblems, placedRect } from "./pak.js";

const KIND_OF = { [K.BUILDING]: "building", [K.TREE]: "tree", [K.SIGN]: "sign" };
const NO_COLOR = [1, 1, 1];

/** Fetches and checks model files once per worker: path -> {ok, stats, reason}. */
export class ModelStore {
	constructor(units) {
		this.scale = 1 / ((units && units.tile) || 1);
		this.models = new Map();
		this.failed = [];
	}

	/** Makes sure every model of `need` (Map path -> {kind, featured}) is known (fetched and checked). */
	async ensure(need) {
		const todo = [];
		for (const [path, use] of need) {
			if (!this.models.has(path)) {
				const p = this.load(path, use);
				this.models.set(path, { pending: p });
				todo.push(p);
			} else if (this.models.get(path).pending) {
				todo.push(this.models.get(path).pending);
			}
		}
		await Promise.all(todo);
	}

	async load(path, use) {
		let rec;
		try {
			const r = await fetch(pakUrl(path), { credentials: "same-origin" });
			if (!r.ok) {
				throw new Error("HTTP " + r.status);
			}
			const { json, bin } = parseGltf(await r.arrayBuffer());
			const stats = gltfStats(json, bin);
			const bad = modelProblems(stats, use.kind, use.featured);
			if (!stats.bbox) {
				bad.push("no geometry with bounds");
			}
			if (bad.length) {
				throw new Error(bad.join(", "));
			}
			const s = this.scale, b = stats.bbox.map((v) => v * s);
			rec = { ok: true, stats, bbox: b, top: b[4], radius: Math.hypot(Math.max(-b[0], b[3]), b[4], Math.max(-b[2], b[5])),
				size: Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) };
		} catch (e) {
			rec = { ok: false, reason: String((e && e.message) || e) };
			this.failed.push({ path, reason: rec.reason });
		}
		this.models.set(path, rec);
		return rec;
	}

	get(path) {
		const m = this.models.get(path);
		return m && m.ok ? m : null;
	}

	/** The main thread could not use the model (e.g. a texture over the limit): generated from now on. */
	fail(path, reason) {
		this.models.set(path, { ok: false, reason });
	}

	/** Failures since the last call (reported once with a chunk). */
	takeFailed() {
		const f = this.failed;
		this.failed = [];
		return f;
	}
}

/**
 * cat: desc_list; pak: normalized manifest (pak.js); store: ModelStore; hs: height step; size: {x, y} of the map
 * (for the entries bound to a place in a turned world).
 * Returns {needed(c) -> Map path -> use, place(c) -> placer for the chunk}.
 */
export function createPakPlacer(cat, pak, store, hs, size = null) {
	const matcher = createMatcher(pak, cat);
	const buildings = [];
	for (const d of cat.buildings || []) {
		buildings[d.i] = d;
	}
	const placed = ((pak && pak.entries) || []).filter((e) => e.at && e.model && e.kind === "building");
	const rectCache = new Map(); // rotation -> [{x, y, w, h, turn, e}]

	function entryOf(kind, desc) {
		const e = matcher.of(kind, desc);
		return e && e.model ? e : null;
	}

	/** The places of the entries bound to one in the chunk's map rotation. */
	function rectsOf(c) {
		const rot = c.rotation & 3;
		let r = rectCache.get(rot);
		if (!r) {
			r = [];
			for (const e of placed) {
				const q = placedRect(e, rot, size);
				if (q) {
					r.push(Object.assign(q, { e }));
				}
			}
			rectCache.set(rot, r);
		}
		return r;
	}

	/** The place whose entry covers object i of chunk c (a matching building standing in its footprint), or null. */
	function placeOf(rects, c, i) {
		const o = c.objs;
		if (!rects.length || o.kind[i] !== K.BUILDING) {
			return null;
		}
		const d = buildings[o.desc[i]];
		if (!d) {
			return null;
		}
		const x = c.x0 + o.x[i] - (o.b[i] & 255), y = c.y0 + o.y[i] - (o.b[i] >> 8);
		for (const q of rects) {
			if (x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h && entryMatches(q.e, d)) {
				return q;
			}
		}
		return null;
	}

	/** Paths of LOD 0 and the LODs of entry e for the variant of object i. */
	function pathsOf(e, c, i) {
		const t = c.objs.y[i] * c.w + c.objs.x[i];
		const climate = (c.ground[t] >> 4) & 7, season = c.season | 0;
		return [expand(e, e.model, season, climate), ...e.lod.map((p) => expand(e, p, season, climate))];
	}

	/** The model files the chunk needs. */
	function needed(c) {
		const o = c.objs, need = new Map(), rects = rectsOf(c);
		for (let i = 0; i < o.n; i++) {
			const kind = KIND_OF[o.kind[i]];
			const q = placeOf(rects, c, i);
			const e = q ? q.e : kind ? entryOf(kind, o.desc[i]) : null;
			if (e) {
				for (const p of pathsOf(e, c, i)) {
					if (!need.has(p)) {
						need.set(p, { kind, featured: e.featured });
					}
				}
			}
		}
		return need;
	}

	/** Marks the modelled objects of chunk c, places its buildings; returns {sink(i, x, y, z, s, rot), parts(), info}. */
	function place(c) {
		const o = c.objs, origin = [c.x0, c.y0], rects = rectsOf(c);
		const modelled = new Uint8Array(o.n), top = new Float32Array(o.n).fill(NaN);
		const groups = new Map(); // entry | LOD 0 path [| overhang] -> {e, lods, ib, owner: [], m}
		const use = new Array(o.n); // object -> [entry, model, paths, place or undefined]
		const at = new Map(); // place -> objects it covers in this chunk
		let count = 0;
		for (let i = 0; i < o.n; i++) {
			const kind = KIND_OF[o.kind[i]];
			const q = placeOf(rects, c, i);
			const e = q ? q.e : kind ? entryOf(kind, o.desc[i]) : null;
			if (!e) {
				continue;
			}
			const paths = pathsOf(e, c, i);
			const m = store.get(paths[0]);
			if (!m) {
				continue; // failed: generated instead
			}
			modelled[i] = 1;
			top[i] = m.top;
			use[i] = [e, m, paths, q];
			if (q) {
				const l = at.get(q);
				if (l) {
					l.push(i);
				} else {
					at.set(q, [i]);
				}
			}
		}
		c.modelled = modelled;
		c.modelTop = top;

		function group(i, over = null) {
			const [e, m, paths] = use[i];
			const key = e.index + "|" + paths[0] + (over ? "|" + over : "");
			let g = groups.get(key);
			if (!g) {
				const lods = [paths[0]];
				for (const p of paths.slice(1)) {
					if (store.get(p)) {
						lods.push(p);
					}
				}
				g = { e, m, lods, ib: new InstBuf(16, origin), owner: [], over };
				groups.set(key, g);
			}
			return g;
		}

		/**
		 * A copy of the model of object i at chunk-local (x, y, z), turned by rot (radians), scaled by s, and by ageScale
		 * when its entry has scale_by_age (trees). over: key of the chunk a building reaches in from (overhang copy).
		 */
		function sink(i, x, y, z, s, rot, ageScale = 1, over = null) {
			if (!modelled[i]) {
				return false;
			}
			const g = group(i, over);
			if (g.e.scaleByAge) {
				s *= ageScale;
			}
			g.ib.add(x, y, z, s, s, s, NO_COLOR, rot);
			g.owner.push(o.owner[i]);
			count++;
			return true;
		}

		// buildings: at their square with offset 0,0; those of the chunks to the west and north that reach into this one
		// once more as overhang copies (shown only while their own chunk is not, pakmodels.js)
		for (let i = 0; i < o.n; i++) {
			if (!modelled[i] || o.kind[i] !== K.BUILDING || use[i][3]) {
				continue;
			}
			let x0 = o.x[i], y0 = o.y[i], over = null;
			if (o.b[i] !== 0) {
				x0 -= o.b[i] & 255;
				y0 -= o.b[i] >> 8;
				if ((x0 >= 0 && y0 >= 0) || o.x[i] !== Math.max(x0, 0) || o.y[i] !== Math.max(y0, 0)) {
					continue;
				}
				over = (c.cx - (x0 < 0 ? 1 : 0)) + "," + (c.cy - (y0 < 0 ? 1 : 0));
			}
			const d = buildings[o.desc[i]];
			const sx = (d && d.size && d.size[0]) || 1, sy = (d && d.size && d.size[1]) || 1;
			const r = rotationOf((d && d.layouts) | 0, o.a[i]);
			const w = r & 1 ? sy : sx, dd = r & 1 ? sx : sy;
			sink(i, x0 + w / 2, o.z[i] * hs, y0 + dd / 2, 1, r * Math.PI / 2, 1, over);
		}

		// places: one copy over the footprint, at the height of the building on its north-west square (else of the
		// first one here); placed by the chunk of that square, by this one as an overhang copy when it lies west or north
		for (const [q, list] of at) {
			const ax = q.x - c.x0, ay = q.y - c.y0;
			let ref = list[0];
			for (const i of list) {
				if (o.x[i] - (o.b[i] & 255) === ax && o.y[i] - (o.b[i] >> 8) === ay) {
					ref = i;
					break;
				}
			}
			const n = c.size || c.w;
			const over = ax < 0 || ay < 0 ? Math.floor(q.x / n) + "," + Math.floor(q.y / n) : null;
			sink(ref, ax + q.w / 2, o.z[ref] * hs, ay + q.h / 2, 1, q.turn * Math.PI / 2, 1, over);
		}

		function parts() {
			const out = [];
			for (const g of groups.values()) {
				const path = g.lods[0];
				const p = g.ib.part("pakmodels", path, "model");
				if (!p) {
					continue;
				}
				// InstBuf's sphere is that of unit shapes: widen it to the model
				p.sphere[3] += g.m.radius;
				p.type = "model";
				p.kind = g.e.kind;
				p.featured = g.e.featured;
				p.lods = g.lods;
				p.player = g.e.player;
				p.owner = Int8Array.from(g.owner);
				p.size = g.m.size;
				p.top = g.m.top;
				if (g.over) {
					p.over = g.over;
				}
				delete p.color;
				out.push(p);
			}
			return out;
		}

		return { sink, parts, modelled, count: () => count };
	}

	return { needed, place, matcher };
}

/** The typed arrays of the model parts, to transfer them. */
export function modelTransferables(parts) {
	const out = [];
	for (const p of parts) {
		out.push(p.matrix.buffer, p.owner.buffer);
	}
	return out;
}
