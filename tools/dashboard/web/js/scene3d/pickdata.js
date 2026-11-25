// Simutrans-Horizon dashboard, 3D view: what picking needs to know about a chunk (worker side, no three.js): the top
// of the tallest object of every square (buildings, station roofs, depots, bridge decks with their railings or
// girders, elevated ways), so that a click on a tower selects its square and not the ground behind it, and the squares
// of stations, factories and town halls with the origin and size of their building. Artistic License, see LICENSE.txt.
import { K } from "./decode.js";
import { createStationBuilder } from "./stations.js";

export const PICK_STATION = 1, PICK_FACTORY = 2, PICK_TOWNHALL = 3;
export const NO_TOP = -1e9;
// one entry of `picks`: x, y (world square), class, building origin x, y, size x, y
export const PICK_FIELDS = 7;

const CLASS = { stop: PICK_STATION, ext: PICK_STATION, factory: PICK_FACTORY, tow: PICK_TOWNHALL };

/** Height of a building from its desc alone (when no generated model is known). */
export function buildingHeight(d, hs) {
	return Math.max(0.08, (d.height ?? Math.min(8, 1 + (d.level | 0) / 4)) * hs);
}

/**
 * cat: desc_list reply; hs: height step; objects: the object builder (objects.js), whose generated models give the
 * height of every square of a building (towers and spires are hit first); buildings drawn by a pak 3D model use the
 * top of the model's bounds (chunk.modelTop, set by pakplace.js). Returns build(chunk) -> {top: Float32Array(w*h),
 * picks: Int16Array}.
 */
export function createPickBuilder(cat, hs, objects = null) {
	const stations = createStationBuilder(cat, hs);
	const buildings = [];
	for (const d of cat.buildings || []) {
		const st = stations.topOf(d.i);
		buildings[d.i] = { cls: CLASS[d.type] || 0, h: st ?? buildingHeight(d, hs), station: st !== null,
			sx: (d.size && d.size[0]) || 1, sy: (d.size && d.size[1]) || 1 };
	}
	const bridgeTop = [];
	for (const d of cat.bridges || []) {
		bridgeTop[d.i] = /rail|track|train|bahn/i.test(d.name || "") || d.waytype === "track" ? 0.11 : 0.05;
	}

	return function build(c) {
		const { w, h, corners: C, objs: o } = c;
		const top = new Float32Array(w * h).fill(NO_TOP);
		const picks = [];
		for (let i = 0; i < o.n; i++) {
			const t = o.y[i] * w + o.x[i], kind = o.kind[i], z = o.z[i];
			let y = NO_TOP;
			if (kind === K.BUILDING) {
				const st = buildings[o.desc[i]];
				if (!st) {
					continue;
				}
				const mt = c.modelTop ? c.modelTop[i] : NaN;
				const gh = mt === mt ? mt : st.station || !objects ? null : objects.topOf(o.desc[i], o.a[i], o.owner[i], o.b[i] & 255, o.b[i] >> 8);
				y = z * hs + (gh ?? st.h);
				if (st.cls) {
					const b = o.b[i], swap = (o.a[i] & 1) !== 0;
					const gx = c.x0 + o.x[i], gy = c.y0 + o.y[i];
					picks.push(gx, gy, st.cls, gx - (b & 255), gy - (b >> 8), swap ? st.sy : st.sx, swap ? st.sx : st.sy);
				}
			} else if (kind === K.WAY && (o.b[i] & 1)) {
				// elevated ways, bridge decks and heads (a flat head on sloped ground lies at its highest corner)
				const b4 = t * 4, sl = o.b[i] >> 8;
				const lo = Math.min(C[b4], C[b4 + 1], C[b4 + 2], C[b4 + 3]), hi = Math.max(C[b4], C[b4 + 1], C[b4 + 2], C[b4 + 3]);
				const lev = sl ? z + 2 : z <= lo ? hi : z;
				y = lev * hs + 0.05;
			} else if (kind === K.BRIDGE) {
				y = z * hs + (bridgeTop[o.desc[i]] ?? 0.05);
			}
			if (y > top[t]) {
				top[t] = y;
			}
		}
		return { top, picks: Int16Array.from(picks) };
	};
}
