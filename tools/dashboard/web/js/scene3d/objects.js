// Simutrans-Horizon dashboard, 3D view: the objects of a chunk (worker side, no three.js). The transport network
// (ways.js), station buildings and depots (stations.js), the other buildings (generated per desc and layout by
// gen/buildings.js, one copy per building at its square with offset 0,0) and trees, fields and ground objects
// (nature.js). Interface used by the worker:
//   SHAPES: {key: {position: Float32Array, color: Uint8Array (linear RGB, normalized), index: Uint16Array}} shapes
//           of instanced parts (shapes.js), sent once to the main thread;
//   createObjectBuilder(catalogue, opts) -> {build(chunk) -> parts, needed(chunk), topOf(desc, layout, owner, ox, oy),
//           info(), newShapes()} with parts as in meshbuf.js ("mesh" or "instances" of a SHAPES key, or of a building
//           model that newShapes() returns once; materials of parts.js: "way", "waterway", "solid", "building"), and
//           with a pak 3D "model" parts (pakplace.js) for the objects drawn by its glTF models instead.
// A building that reaches over a chunk border is drawn by the chunk with its square at offset 0,0 (its north-west
// square), so it is drawn exactly once. The chunks it reaches into draw it too, as "overhang" parts that name the
// chunk of its origin (`over`): the main thread shows those only while that chunk is not shown (chunks.js).
// Artistic License, see LICENSE.txt.
import { MeshBuf, StampBuf, InstBuf } from "./meshbuf.js";
import { K } from "./decode.js";
import { SHAPES } from "./shapes.js";
import { Furniture } from "./furniture.js";
import { createWayBuilder } from "./ways.js";
import { createStationBuilder } from "./stations.js";
import { createBuildingGen } from "./gen/buildings.js";
import { createNatureBuilder } from "./nature.js";
import { createPakPlacer } from "./pakplace.js";

export { SHAPES };

const WHITE = [1, 1, 1];

/**
 * cat: desc_list; opts: {hs, rules (gen/rules.json), players ([r, g, b] sRGB per player number), treeDensity,
 * buildingInstanceMin (a model with at least this many copies in a chunk is drawn as instances; 0 = always merged),
 * pak (normalized pak 3D manifest) and store (pakplace.js ModelStore): objects with a model are not generated,
 * size ({x, y} of the map, for the pak's places in a turned world)}.
 */
export function createObjectBuilder(cat, opts = {}) {
	const hs = opts.hs;
	const ways = createWayBuilder(cat, hs);
	const stations = createStationBuilder(cat, hs, { players: opts.players });
	const placer = opts.pak && opts.store ? createPakPlacer(cat, opts.pak, opts.store, hs, opts.size) : null;
	const categoryOf = placer ? (d) => {
		const e = placer.matcher.of("building", d.i);
		return e && e.generator;
	} : null;
	const gen = createBuildingGen(cat, { hs, rules: opts.rules, players: opts.players, categoryOf });
	const nature = createNatureBuilder(cat, { hs, rules: opts.rules, treeDensity: opts.treeDensity ?? 1 });
	let last = null;
	const instMin = opts.buildingInstanceMin || 0;
	const sent = new Set(); // models already sent as instanced shapes
	let shapes = null;

	function build(c) {
		const o = c.objs;
		const origin = [c.x0, c.y0];
		const out = { way: new MeshBuf(8192, true, origin), water: new MeshBuf(1024, true, origin), f: new Furniture(origin),
			nf: new Furniture(origin) };
		const pp = placer ? placer.place(c) : null;
		const skip = pp ? pp.modelled : null;
		const ctx = { sink: pp ? pp.sink : null };
		ways.build(c, out, ctx);
		stations.build(c, out, ctx);
		let counts = null;
		const inst = new Map();
		if (instMin > 0) {
			counts = new Map();
			for (let i = 0; i < o.n; i++) {
				if (o.kind[i] === K.BUILDING && o.b[i] === 0 && gen.has(o.desc[i]) && !(skip && skip[i])) {
					const k = gen.keyOf(o.desc[i], o.a[i], o.owner[i]);
					counts.set(k, (counts.get(k) || 0) + 1);
				}
			}
		}
		// the models first (cached after their first use), so the merged buffer gets its exact size
		const rows = [];
		let nv = 0, ni = 0;
		for (let i = 0; i < o.n; i++) {
			if (o.kind[i] !== K.BUILDING || o.b[i] !== 0 || (skip && skip[i])) {
				continue;
			}
			const t = gen.template(o.desc[i], o.a[i], o.owner[i]);
			if (!t) {
				continue;
			}
			rows.push(i, t);
			if (!(counts && counts.get(t.key) >= instMin)) {
				nv += t.nv;
				ni += t.ni;
			}
		}
		const bld = new StampBuf(nv, ni, origin);
		for (let r = 0; r < rows.length; r += 2) {
			const i = rows[r], t = rows[r + 1];
			if (counts && counts.get(t.key) >= instMin) {
				let e = inst.get(t.key);
				if (!e) {
					e = { t, ib: new InstBuf(64, origin) };
					inst.set(t.key, e);
				}
				e.ib.add(o.x[i], o.z[i] * hs, o.y[i], 1, 1, 1, WHITE);
			} else {
				bld.stamp(t, o.x[i], o.z[i] * hs, o.y[i], o.z[i]);
			}
		}
		// buildings of the chunks to the west and north that reach into this one: one copy each, at its first square here
		const over = new Map(); // origin chunk key -> StampBuf
		for (let i = 0; i < o.n; i++) {
			if (o.kind[i] !== K.BUILDING || o.b[i] === 0 || (skip && skip[i])) {
				continue;
			}
			const ox = o.b[i] & 255, oy = o.b[i] >> 8, x0 = o.x[i] - ox, y0 = o.y[i] - oy;
			if ((x0 >= 0 && y0 >= 0) || o.x[i] !== Math.max(x0, 0) || o.y[i] !== Math.max(y0, 0)) {
				continue;
			}
			const t = gen.template(o.desc[i], o.a[i], o.owner[i]);
			if (!t) {
				continue;
			}
			const key = (c.cx - (x0 < 0 ? 1 : 0)) + "," + (c.cy - (y0 < 0 ? 1 : 0));
			let sb = over.get(key);
			if (!sb) {
				sb = new StampBuf(t.nv * 2, t.ni * 2, origin);
				over.set(key, sb);
			}
			sb.stamp(t, x0, o.z[i] * hs, y0, o.z[i]);
		}
		const overParts = [];
		let overCopies = 0;
		for (const [key, sb] of over) {
			const p = sb.part("overhang", "building");
			if (p) {
				p.over = key;
				overParts.push(p);
				overCopies += sb.copies;
			}
		}
		const instParts = [];
		shapes = null;
		for (const { t, ib } of inst.values()) {
			const part = ib.part("buildings", "b" + t.key, "building");
			// the instance sphere assumes unit shapes: widen it to the model
			part.sphere[3] += Math.hypot(t.w, t.d, t.height);
			instParts.push(part);
			if (!sent.has(t.key)) {
				sent.add(t.key);
				shapes = shapes || {};
				shapes["b" + t.key] = { position: t.pos.slice(), color: t.col.slice(), win: t.win.slice(), index: t.idx.slice() };
			}
		}
		const ns = nature.build(c, out, ctx.sink);
		last = { buildings: rows.length / 2, merged: bld.copies, trees: ns.trees, fields: ns.fields, groundobjs: ns.groundobjs,
			models: pp ? pp.count() : 0, overhang: overCopies };
		return [
			out.way.part("ways", "way"),
			out.water.part("ways", "waterway"),
			...out.f.parts("network"),
			bld.part("buildings", "building"),
			...instParts,
			...overParts,
			...out.nf.parts("nature"),
			...(pp ? pp.parts() : []),
		].filter(Boolean);
	}

	/** Height of a generated building above its ground on its square (ox, oy), or null (not generated). */
	function topOf(desc, layout, owner, ox, oy) {
		return gen.has(desc) ? gen.topAt(desc, layout, owner, ox, oy) : null;
	}

	return { build, stations, gen, topOf, info: () => Object.assign({ last }, gen.info()),
		/** Model files (pak 3D) that chunk c needs (Map path -> use), or null without a pak. */
		needed: (c) => (placer ? placer.needed(c) : null),
		/** Instanced building models first used by the last build (to send with its parts), or null. */
		newShapes: () => shapes };
}
