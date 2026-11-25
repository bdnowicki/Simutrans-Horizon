// Simutrans-Horizon dashboard, 3D view: stations, stops, station extensions and depots of a chunk (worker side, no
// three.js). Rail stops: platforms beside the track on the side of the layout (16 layouts: bit 3 = near side, else
// both sides), a canopy when the building has a height; road stops: shelters at both kerbs; airport stands, terminals,
// radar; docks: a pier towards the water; extensions by name (paved tiles, cranes, tanks, warehouses); depots: sheds
// over the way end, the door towards the way. Every square of a multi-square building draws its own part, so stations
// along a track are continuous. Buildings of a company (owner >= 0) show its colour: canopy roofs, stop signs, a band
// over depot doors and on the roof rim of station buildings. Artistic License, see LICENSE.txt.
import { rgbLin, hash } from "./meshbuf.js";
import { K, G, SW, SE, NE, NW } from "./decode.js";
import { N, E, S, W, axisOf } from "./wayshape.js";
import { WT } from "./ways.js";

const PLATFORM = [0.72, 0.71, 0.68], PLATFORM_SIDE = [0.55, 0.54, 0.52], SAFETY = [0.95, 0.82, 0.25];
const ROOF_MODERN = [0.42, 0.52, 0.64], ROOF_OLD = [0.55, 0.32, 0.26], POST = [0.4, 0.42, 0.46];
const SHED_WALL = [0.7, 0.64, 0.55], SHED_ROOF = [0.42, 0.4, 0.42], DOOR = [0.16, 0.16, 0.18];
const PIER = [0.5, 0.4, 0.3], PIER_SIDE = [0.4, 0.32, 0.25];
const BUS_SIGN = rgbLin([0.35, 0.55, 1]);
const CONTAINERS = [[0.75, 0.22, 0.16], [0.18, 0.4, 0.66], [0.85, 0.6, 0.15], [0.25, 0.55, 0.3], [0.6, 0.6, 0.62]];

function classify(d) {
	const name = d.name || "", wt = d.waytype;
	const h = d.height | 0;
	// `height` is the tallest image of the building in levels; the images of a multi-square building also reach over
	// the squares in front of it (2 levels per square of the footprint diagonal in the game's projection)
	const sx = (d.size && d.size[0]) || 1, sy = (d.size && d.size[1]) || 1;
	const lev = Math.max(1, h - 2 * (sx + sy - 2));
	if (d.type === "depot") {
		return { kind: "depot", wt, top: wt === "air" ? 0.62 : wt === "road" ? 0.36 : 0.56, h };
	}
	if (d.type === "stop") {
		if (wt === "road") {
			const freight = !(d.enables & 1) && (d.enables & 6) !== 0 || /freight|truck|lkw|goods|cargo/i.test(name);
			return { kind: "road", freight, top: freight ? 0.12 : 0.24, h };
		}
		if (wt === "air") {
			return { kind: "stand", top: 0.02, h };
		}
		if (wt === "water") {
			return { kind: "dock", top: 0.3, h, bulk: /bulk/i.test(name), passengers: (d.enables & 1) !== 0 && !/goods|bulk|oil|fluid|crate/i.test(name) };
		}
		if (wt) {
			const freight = !(d.enables & 1) && (d.enables & 6) !== 0 || /freight|goods|container|cargo/i.test(name);
			const roof = freight ? 0 : h;
			return { kind: "rail", wt, freight, container: /container/i.test(name), roof, old: /^(Train|Open)/.test(name),
				top: roof >= 2 ? 0.66 : roof === 1 ? 0.5 : 0.2, h };
		}
	}
	// station extensions and other station buildings
	if (/crane/i.test(name)) return { kind: "crane", top: 0.9, h };
	if (/fluid|tank|oil/i.test(name)) return { kind: "tanks", top: 0.36, h };
	if (/radar/i.test(name)) return { kind: "radar", top: 0.7, h };
	if (/papi/i.test(name)) return { kind: "papi", top: 0.04, h };
	if (/plain_tile|ramp_tile|_tile|pavement|platz/i.test(name)) return { kind: "paved", top: 0.04, h };
	if (/warehouse|goods|storage|lager|shed/i.test(name)) return { kind: "warehouse", top: Math.max(0.3, lev * 0.2), h };
	return { kind: wt === "air" ? "terminal" : "building", top: Math.max(0.3, Math.min(3, lev * 0.2041)), h };
}

/** Linear-RGB company colour of an owner (opts.players: sRGB triples by player number), or null. */
function companyOf(players, owner) {
	const c = owner >= 0 && players ? players[owner] : null;
	return c ? c.map((v) => Math.min(1, Math.max(0, v))) : null;
}

/** cat: desc_list, hs: height step, opts: {players: [[r, g, b] sRGB 0..1 per player number]}. */
export function createStationBuilder(cat, hs, opts = {}) {
	const players = opts.players || null;
	const info = [];
	for (const d of cat.buildings || []) {
		if (d.type === "stop" || d.type === "ext" || d.type === "depot") {
			const k = classify(d);
			k.d = d;
			k.sx = (d.size && d.size[0]) || 1;
			k.sy = (d.size && d.size[1]) || 1;
			k.layouts = d.layouts | 0;
			info[d.i] = k;
		}
	}

	/** Height of the station square above its ground (picking), or null when desc i is not a station building. */
	function topOf(i) {
		const k = info[i];
		return k ? k.top : null;
	}

	function build(c, out, ctx) {
		const { w, h, corners: C, objs: o } = c;
		const f = out.f;
		const groundY = (t, u, v) => {
			const b = t * 4;
			return (C[b + NW] * (1 - u) * (1 - v) + C[b + NE] * u * (1 - v) + C[b + SE] * u * v + C[b + SW] * (1 - u) * v) * hs;
		};
		const stationAt = new Map(); // tile * 256 + z -> desc index (neighbours of the same kind join seamlessly)
		for (let i = 0; i < o.n; i++) {
			if (o.kind[i] === K.BUILDING && info[o.desc[i]]) {
				stationAt.set((o.y[i] * w + o.x[i]) * 256 + (o.z[i] & 255), o.desc[i]);
			}
		}
		for (let i = 0; i < o.n; i++) {
			if (o.kind[i] !== K.BUILDING) {
				continue;
			}
			const k = info[o.desc[i]];
			if (!k || (c.modelled && c.modelled[i])) {
				continue; // not a station building, or drawn by a model of the pak 3D
			}
			const lx = o.x[i], ly = o.y[i], z = o.z[i], t = ly * w + lx, a = o.a[i], b = o.b[i];
			const gx = c.x0 + lx, gy = c.y0 + ly;
			const ox = b & 255, oy = b >> 8;
			const env = { f, out, lx, ly, z, t, a, ox, oy, gx, gy, hs, ctx, w, h, groundY, di: o.desc[i], ground: c.ground,
				company: companyOf(players, o.owner[i]),
				same: (dx, dy) => {
					const x = lx + dx, y = ly + dy;
					return x >= 0 && y >= 0 && x < w && y < h && stationAt.get((y * w + x) * 256 + (z & 255)) === o.desc[i];
				} };
			switch (k.kind) {
				case "rail": railStop(env, k); break;
				case "road": roadStop(env, k); break;
				case "stand": stand(env); break;
				case "dock": dock(env, k); break;
				case "depot": depot(env, k); break;
				case "crane": crane(env, k); break;
				case "tanks": tanks(env); break;
				case "radar": radar(env); break;
				case "papi": paved(env, k, true); break;
				case "paved": paved(env, k, false); break;
				case "warehouse": warehouse(env, k); break;
				default: building(env, k);
			}
		}
	}

	return { build, topOf, isStation: (i) => !!info[i] };
}

// --- helpers --------------------------------------------------------------------------------------------------

/** The way of waytype wt on the square at height z (ways.js index), or null. */
function wayOf(env, wt) {
	return env.ctx.wayAt ? env.ctx.wayAt(env.t, WT[wt] ?? WT.track, env.z) : null;
}

/** Axis of a station square: from its straight way, else from the layout (bit 0: 0 north-south, 1 east-west). */
function axisFor(way, layout) {
	const ax = way ? axisOf(way.ribi) : null;
	return ax || ((layout & 1) ? "ew" : "ns");
}

/** Box in square coordinates across/along an axis: across [a0, a1] (from the centre line, + = east/south), along [l0, l1]. */
function axBox(env, ax, a0, a1, l0, l1, y0, y1, c, top) {
	const { f, lx, ly } = env;
	if (ax === "ns") {
		f.box(lx + 0.5 + a0, lx + 0.5 + a1, y0, y1, ly + l0, ly + l1, c, top);
	} else {
		f.box(lx + l0, lx + l1, y0, y1, ly + 0.5 + a0, ly + 0.5 + a1, c, top);
	}
}

function baseY(env, way) {
	return way ? way.yAt(0.5, 0.5) : env.z * env.hs;
}

// --- stops ----------------------------------------------------------------------------------------------------

function railStop(env, k) {
	const { f } = env;
	const way = wayOf(env, k.wt);
	const ax = axisFor(way, env.a);
	const y = baseY(env, way);
	const hw = way ? way.st.hw : 0.25;
	const sides = k.layouts === 16 ? [(env.a & 8) ? 1 : -1] : [-1, 1];
	const p0 = Math.min(0.42, hw + 0.01), py = y + (k.freight ? 0.1 : 0.075);
	const top = f.c8(k.freight ? [0.6, 0.58, 0.55] : PLATFORM), side = f.c8(PLATFORM_SIDE);
	const y0 = way && way.deck ? y - 0.09 : y - 0.03;
	for (const s of sides) {
		const a0 = s > 0 ? p0 : -0.5, a1 = s > 0 ? 0.5 : -p0;
		axBox(env, ax, a0, a1, 0, 1, y0, py, side, top);
		if (!k.freight) {
			const e0 = s > 0 ? p0 : -p0 - 0.03, e1 = e0 + 0.03;
			axBox(env, ax, e0, e1, 0, 1, py, py + 0.002, f.c8(SAFETY));
		}
		const mid = s * (p0 + 0.5) / 2;
		if (k.roof === 1) {
			const ry = py + 0.36, roof = f.c8(tint(k.old ? ROOF_OLD : ROOF_MODERN, env.company));
			for (const l of [0.25, 0.75]) {
				axBox(env, ax, mid - 0.015, mid + 0.015, l - 0.015, l + 0.015, py, ry, f.c8(POST));
			}
			const r0 = s > 0 ? p0 - 0.12 : -0.5, r1 = s > 0 ? 0.5 : -p0 + 0.12;
			axBox(env, ax, r0, r1, 0, 1, ry, ry + 0.025, roof, roof);
		} else if (k.roof === 0 && !k.freight && (env.gx + env.gy) % 2 === 0) {
			const cx = ax === "ns" ? env.lx + 0.5 + mid : env.lx + 0.5, cz = ax === "ns" ? env.ly + 0.5 : env.ly + 0.5 + mid;
			// shelter: local +Z (open side) faces the track
			const D = ax === "ns" ? [-s, 0] : [0, -s];
			f.add("shelter", cx, py, cz, 0.9, 1, 0.9, [1, 1, 1], Math.atan2(D[0], D[1]));
		}
		if (k.container) {
			for (const l of [0.2, 0.62]) {
				const cc = CONTAINERS[Math.floor(hash(env.gx, env.gy, l * 10) * CONTAINERS.length)];
				axBox(env, ax, mid - 0.08, mid + 0.08, l, l + 0.3, py, py + 0.13, f.c8(cc));
			}
		}
	}
	if (k.roof >= 2) {
		// a hall over tracks and platforms: gable roof across the square
		const ey = y + 0.52, ry = y + 0.66, roof = f.c8(tint(k.old ? ROOF_OLD : ROOF_MODERN, env.company)), m = f.mesh;
		for (const s of [-1, 1]) {
			for (const l of [0.1, 0.9]) {
				axBox(env, ax, s * 0.47 - 0.015, s * 0.47 + 0.015, l - 0.015, l + 0.015, y, ey, f.c8(POST));
			}
		}
		const P = (ac, al, yy) => ax === "ns" ? [env.lx + 0.5 + ac, yy, env.ly + al] : [env.lx + al, yy, env.ly + 0.5 + ac];
		for (const s of [-1, 1]) {
			const q = [P(s * 0.52, 0, ey), P(0, 0, ry), P(0, 1, ry), P(s * 0.52, 1, ey)].map((p) => m.v(p[0], p[1], p[2], roof));
			upQuad(m, q);
		}
	}
}

/** A roof colour mixed half way towards the company colour. */
function tint(rgb, company) {
	return company ? rgb.map((v, i) => v * 0.45 + company[i] * 0.55) : rgb;
}

/** Adds the quad so that it faces up (counter-clockwise seen from above). */
function upQuad(m, q) {
	const P = m.p.a, o = (i) => i * 3;
	const ax = P[o(q[0])], az = P[o(q[0]) + 2], bx = P[o(q[1])], bz = P[o(q[1]) + 2], cx = P[o(q[2])], cz = P[o(q[2]) + 2];
	const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
	if (ny >= 0) {
		m.quad(q[0], q[1], q[2], q[3]);
	} else {
		m.quad(q[0], q[3], q[2], q[1]);
	}
}

function roadStop(env, k) {
	const { f } = env;
	const way = wayOf(env, "road");
	const ax = axisFor(way, env.a);
	const y = baseY(env, way);
	const ws = way && way.st.centre ? way.st.centre.ws : 0.37;
	for (const s of [-1, 1]) {
		const o = Math.min(0.44, ws + 0.01) * s;
		const cx = ax === "ns" ? env.lx + 0.5 + o : env.lx + 0.5, cz = ax === "ns" ? env.ly + 0.5 : env.ly + 0.5 + o;
		if (k.freight) {
			axBox(env, ax, o - 0.06, o + 0.06, 0.15, 0.85, y, y + 0.1, f.c8([0.55, 0.52, 0.48]));
			continue;
		}
		// open side (local +Z) towards the road: direction -s across
		const D = ax === "ns" ? [-s, 0] : [0, -s];
		f.add("shelter", cx, y + 0.008, cz, 1, 1, 1, [1, 1, 1], Math.atan2(D[0], D[1]));
		if (s > 0) {
			const sx = ax === "ns" ? cx : env.lx + 0.2, sz = ax === "ns" ? env.ly + 0.2 : cz;
			f.add("sign", sx, y + 0.008, sz, 1, 1, 1, env.company ? rgbLin(env.company) : BUS_SIGN, ax === "ns" ? 0 : Math.PI / 2);
		}
	}
}

function stand(env) {
	const { out, lx, ly } = env;
	const way = wayOf(env, "air");
	const y = baseY(env, way) + 0.003;
	const m = out.way, pad = out.f.c8([0.62, 0.62, 0.6]), line = out.f.c8([0.95, 0.78, 0.22]);
	const q = (u0, v0, u1, v1, yy, c) => {
		const i0 = m.v(lx + u0, yy, ly + v0, c), i1 = m.v(lx + u0, yy, ly + v1, c), i2 = m.v(lx + u1, yy, ly + v1, c), i3 = m.v(lx + u1, yy, ly + v0, c);
		m.quad(i0, i1, i2, i3);
	};
	q(0.06, 0.06, 0.94, 0.94, y, pad);
	const ax = axisFor(way, env.a);
	if (ax === "ns") {
		q(0.485, 0.06, 0.515, 0.94, y + 0.001, line);
		q(0.3, 0.2, 0.7, 0.23, y + 0.001, line);
	} else {
		q(0.06, 0.485, 0.94, 0.515, y + 0.001, line);
		q(0.2, 0.3, 0.23, 0.7, y + 0.001, line);
	}
}

/** Direction from a dock square towards the water: along the long side of the dock (layouts 1 and 3 swap x, y). */
function dock(env, k) {
	const { f, lx, ly, t, groundY } = env;
	let sx = k.sx, sy = k.sy;
	if (env.a & 1) {
		[sx, sy] = [sy, sx];
	}
	const towardsY = sy > sx;
	const sea = towardsY ? [0, 1] : [1, 0];
	const y = env.z * env.hs + 0.13;
	const m0 = 0.06;
	if (env.ground && (env.ground[t] & 15) === G.WATER) {
		berth(env, y);
		return;
	}
	// deck over the whole square, piles under its seaward half
	f.box(lx + m0, lx + 1 - m0, y - 0.05, y, ly + m0, ly + 1 - m0, f.c8(PIER_SIDE), f.c8(PIER));
	const wY = Math.min(groundY(t, 0.5, 0.5), env.z * env.hs) - 0.15;
	for (const [u, v] of [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85], [0.5, 0.15], [0.5, 0.85]]) {
		f.box(lx + u - 0.025, lx + u + 0.025, wY, y - 0.05, ly + v - 0.025, ly + v + 0.025, f.c8(PIER_SIDE));
	}
	const last = towardsY ? env.oy === sy - 1 : env.ox === sx - 1;
	if (last) {
		for (const s of [0.25, 0.5, 0.75]) {
			const u = towardsY ? s : 0.88, v = towardsY ? 0.88 : s;
			f.box(lx + u - 0.02, lx + u + 0.02, y, y + 0.04, ly + v - 0.02, ly + v + 0.02, f.c8([0.2, 0.2, 0.22]));
		}
		return;
	}
	if (k.passengers) {
		f.add("shelter", lx + 0.5, y, ly + 0.5, 1.4, 1.2, 1.4, [1, 1, 1], Math.atan2(sea[0], sea[1]));
	} else if (k.bulk) {
		f.box(lx + 0.3, lx + 0.7, y, y + 0.32, ly + 0.3, ly + 0.7, f.c8([0.5, 0.48, 0.42]));
		f.obox(lx + 0.5 + sea[0] * 0.3, ly + 0.5 + sea[1] * 0.3, 0.3, 0.04, y + 0.26, y + 0.3, Math.atan2(-sea[1], sea[0]), f.c8([0.4, 0.4, 0.42]));
	} else {
		dockCrane(env, y, sea);
	}
}

/**
 * A dock square on the water is where ships lie: no deck over it, only a quay edge with bollards along its land side
 * (a neighbour that is not water) and piles under the edge; out on the water mooring posts at its corners.
 */
function berth(env, y) {
	const { f, lx, ly, w, h, ground } = env;
	const dry = (dx, dy) => {
		const x = lx + dx, yy = ly + dy;
		return x >= 0 && yy >= 0 && x < w && yy < h && (ground[yy * w + x] & 15) !== G.WATER;
	};
	const side = [[0, -1], [1, 0], [0, 1], [-1, 0]].find(([dx, dy]) => dry(dx, dy));
	const e = 0.11, wY = env.z * env.hs - 0.15;
	if (!side) {
		for (const [u, v] of [[0.1, 0.1], [0.9, 0.9]]) {
			f.box(lx + u - 0.035, lx + u + 0.035, wY, y, ly + v - 0.035, ly + v + 0.035, f.c8(PIER_SIDE), f.c8([0.2, 0.2, 0.22]));
		}
		return;
	}
	const [x0, x1, z0, z1] = side[0] < 0 ? [0, e, 0, 1] : side[0] > 0 ? [1 - e, 1, 0, 1] : side[1] < 0 ? [0, 1, 0, e] : [0, 1, 1 - e, 1];
	f.box(lx + x0, lx + x1, y - 0.05, y, ly + z0, ly + z1, f.c8(PIER_SIDE), f.c8(PIER));
	for (const s of [0.2, 0.5, 0.8]) {
		const u = side[0] ? (side[0] < 0 ? e / 2 : 1 - e / 2) : s, v = side[1] ? (side[1] < 0 ? e / 2 : 1 - e / 2) : s;
		f.box(lx + u - 0.025, lx + u + 0.025, wY, y - 0.05, ly + v - 0.025, ly + v + 0.025, f.c8(PIER_SIDE));
		f.box(lx + u - 0.018, lx + u + 0.018, y, y + 0.035, ly + v - 0.018, ly + v + 0.018, f.c8([0.2, 0.2, 0.22]));
	}
}

function dockCrane(env, y, sea) {
	const { f, lx, ly } = env;
	const c = f.c8([0.85, 0.55, 0.15]);
	for (const [u, v] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
		f.box(lx + u - 0.025, lx + u + 0.025, y, y + 0.5, ly + v - 0.025, ly + v + 0.025, c);
	}
	f.box(lx + 0.2, lx + 0.8, y + 0.5, y + 0.58, ly + 0.2, ly + 0.8, c);
	f.obox(lx + 0.5 + sea[0] * 0.35, ly + 0.5 + sea[1] * 0.35, 0.45, 0.035, y + 0.6, y + 0.66, Math.atan2(-sea[1], sea[0]), c);
}

// --- depots ---------------------------------------------------------------------------------------------------

const DOOR_DIR = [S, E, N, W];

function depot(env, k) {
	const { f, lx, ly } = env;
	const way = wayOf(env, k.wt || "road");
	const y = way ? way.yAt(0.5, 0.5) : env.z * env.hs;
	// four layouts: the way leaves towards S, E, N, W; two layouts: a through depot (0 north-south, 1 east-west)
	const through = k.layouts === 2;
	const door = through ? null : DOOR_DIR[env.a & 3];
	const ax = through ? ((env.a & 1) ? "ew" : "ns") : (door === N || door === S ? "ns" : "ew");
	const wall = f.c8(k.wt === "road" ? [0.68, 0.62, 0.55] : SHED_WALL), roof = f.c8(SHED_ROOF), dark = f.c8(DOOR);
	if (k.wt === "water") {
		const wy = env.z * env.hs + 0.12;
		f.box(lx + 0.12, lx + 0.88, wy - 0.04, wy, ly + 0.12, ly + 0.88, f.c8(PIER_SIDE), f.c8(PIER));
		gableShed(env, "ns", wy, 0.34, 0.3, 0.44, f.c8([0.62, 0.5, 0.38]), roof);
		return;
	}
	if (k.wt === "air") {
		axBox(env, "ew", -0.46, 0.46, 0.06, 0.94, y, y + 0.36, f.c8([0.7, 0.72, 0.74]));
		barrelRoof(env, y + 0.36, 0.46, f.c8([0.6, 0.62, 0.66]));
		doorFace(env, door || S, y, 0.36, 0.7, dark);
		companyBand(env, door || S, y + 0.36, 0.7);
		return;
	}
	if (k.wt === "road") {
		// garage: flat roof, door towards the road
		f.box(lx + 0.12, lx + 0.88, y, y + 0.3, ly + 0.12, ly + 0.88, wall, f.c8([0.48, 0.46, 0.45]));
		f.box(lx + 0.1, lx + 0.9, y + 0.3, y + 0.33, ly + 0.1, ly + 0.9, f.c8([0.5, 0.48, 0.47]));
		doorFace(env, door || S, y, 0.24, 0.5, dark, 0.38);
		companyBand(env, door || S, y + 0.25, 0.5, 0.38);
		return;
	}
	// rail (also tram, monorail, maglev, narrow gauge): a long gabled shed along the track, open at its ends
	gableShed(env, ax, y, 0.36, 0.34, 0.56, wall, roof);
	for (const d of through ? (ax === "ns" ? [N, S] : [E, W]) : [door]) {
		doorFace(env, d, y, 0.3, 0.36, dark, 0.38);
		companyBand(env, d, y + 0.31, 0.36, 0.38);
	}
}

/** A band in the company colour above a door (none without an owner). */
function companyBand(env, d, y, width, wallOff = 0.46) {
	if (env.company) {
		doorFace(env, d, y, 0.035, width + 0.08, env.f.c8(env.company), wallOff + 0.002);
	}
}

/** A shed along ax: walls up to y + eave at +-half across, a ridge at y + ridge. */
function gableShed(env, ax, y, half, eave, ridge, wall, roof) {
	const { f, lx, ly } = env;
	axBox(env, ax, -half, half, 0.04, 0.96, y, y + eave, wall);
	const m = f.mesh;
	const P = (ac, al, yy) => ax === "ns" ? [lx + 0.5 + ac, yy, ly + al] : [lx + al, yy, ly + 0.5 + ac];
	for (const s of [-1, 1]) {
		const q = [P(s * (half + 0.04), 0.02, y + eave), P(0, 0.02, y + ridge), P(0, 0.98, y + ridge), P(s * (half + 0.04), 0.98, y + eave)]
			.map((p) => m.v(p[0], p[1], p[2], roof));
		upQuad(m, q);
	}
	// gables
	for (const al of [0.04, 0.96]) {
		const tri = [P(-half, al, y + eave), P(half, al, y + eave), P(0, al, y + ridge)].map((p) => m.v(p[0], p[1], p[2], wall));
		m.tri(tri[0], tri[1], tri[2]);
		m.tri(tri[0], tri[2], tri[1]);
	}
}

function barrelRoof(env, y, half, c) {
	const { f, lx, ly } = env;
	const m = f.mesh, n = 4;
	for (let i = 0; i < n; i++) {
		const a0 = Math.PI * i / n, a1 = Math.PI * (i + 1) / n;
		const u0 = 0.5 - Math.cos(a0) * half, u1 = 0.5 - Math.cos(a1) * half;
		const y0 = y + Math.sin(a0) * 0.18, y1 = y + Math.sin(a1) * 0.18;
		const q = [m.v(lx + u0, y0, ly + 0.06, c), m.v(lx + u1, y1, ly + 0.06, c), m.v(lx + u1, y1, ly + 0.94, c), m.v(lx + u0, y0, ly + 0.94, c)];
		upQuad(m, q);
	}
}

/** A dark door on the face of a building towards direction d (just outside the wall at +-wallOff). */
function doorFace(env, d, y, hgt, width, c, wallOff = 0.46) {
	const { f, lx, ly } = env;
	const off = wallOff + 0.004, hw = width / 2;
	if (d === N) f.box(lx + 0.5 - hw, lx + 0.5 + hw, y, y + hgt, ly + 0.5 - off - 0.004, ly + 0.5 - off, c);
	else if (d === S) f.box(lx + 0.5 - hw, lx + 0.5 + hw, y, y + hgt, ly + 0.5 + off, ly + 0.5 + off + 0.004, c);
	else if (d === E) f.box(lx + 0.5 + off, lx + 0.5 + off + 0.004, y, y + hgt, ly + 0.5 - hw, ly + 0.5 + hw, c);
	else f.box(lx + 0.5 - off - 0.004, lx + 0.5 - off, y, y + hgt, ly + 0.5 - hw, ly + 0.5 + hw, c);
}

// --- extensions -----------------------------------------------------------------------------------------------

function groundTop(env) {
	const { t, groundY } = env;
	return Math.max(groundY(t, 0, 0), groundY(t, 1, 0), groundY(t, 0, 1), groundY(t, 1, 1));
}

/** Margins of a square towards neighbours that are not the same building: [west, east, north, south]. */
function margins(env, m) {
	return [env.same(-1, 0) ? 0 : m, env.same(1, 0) ? 0 : m, env.same(0, -1) ? 0 : m, env.same(0, 1) ? 0 : m];
}

function paved(env, k, papi) {
	const { f, lx, ly } = env;
	const y = groundTop(env);
	f.box(lx, lx + 1, y - 0.03, y + 0.035, ly, ly + 1, f.c8([0.58, 0.57, 0.55]), f.c8(PLATFORM));
	if (papi) {
		for (const u of [0.3, 0.43, 0.56, 0.69]) {
			f.box(lx + u, lx + u + 0.06, y + 0.035, y + 0.07, ly + 0.45, ly + 0.55, f.c8([0.95, 0.9, 0.85]));
		}
	} else if ((env.gx * 7 + env.gy * 3) % 4 === 0) {
		f.add("light", lx + 0.85, y + 0.035, ly + 0.15, 1, 1, 1, [1, 1, 1], Math.PI * 0.75);
	}
}

function crane(env, k) {
	const { f, lx, ly } = env;
	const y = groundTop(env);
	const c = f.c8([0.85, 0.55, 0.15]), rail = f.c8([0.35, 0.35, 0.37]);
	f.box(lx, lx + 1, y - 0.02, y + 0.02, ly, ly + 1, f.c8([0.5, 0.5, 0.48]));
	// legs on every square of the building's border, a beam across the top
	let sx = k.sx, sy = k.sy;
	if (env.a & 1) {
		[sx, sy] = [sy, sx];
	}
	const top = y + Math.max(0.6, Math.min(1.6, k.h * 0.12));
	const legsX = [env.ox === 0 ? 0.12 : null, env.ox === sx - 1 ? 0.88 : null].filter((v) => v !== null);
	const legsZ = [env.oy === 0 ? 0.12 : null, env.oy === sy - 1 ? 0.88 : null].filter((v) => v !== null);
	for (const u of legsX) {
		for (const v of legsZ) {
			f.box(lx + u - 0.03, lx + u + 0.03, y, top, ly + v - 0.03, ly + v + 0.03, c);
		}
	}
	f.box(lx, lx + 1, top, top + 0.07, ly + 0.08, ly + 0.92, c);
	f.box(lx + 0.4, lx + 0.6, top - 0.12, top, ly + 0.4, ly + 0.6, rail);
}

function tanks(env) {
	const { f, lx, ly } = env;
	const y = groundTop(env);
	f.box(lx + 0.04, lx + 0.96, y - 0.02, y + 0.02, ly + 0.04, ly + 0.96, f.c8([0.55, 0.54, 0.52]));
	const c = rgbLin([0.86, 0.86, 0.84]);
	f.add("tank", lx + 0.32, y + 0.02, ly + 0.32, 0.36, 0.32, 0.36, c);
	f.add("tank", lx + 0.7, y + 0.02, ly + 0.66, 0.4, 0.34, 0.4, c);
}

function radar(env) {
	const { f, lx, ly } = env;
	const y = groundTop(env);
	f.box(lx + 0.35, lx + 0.65, y, y + 0.2, ly + 0.35, ly + 0.65, f.c8([0.72, 0.72, 0.7]));
	f.box(lx + 0.47, lx + 0.53, y + 0.2, y + 0.55, ly + 0.47, ly + 0.53, f.c8([0.55, 0.56, 0.58]));
	f.obox(lx + 0.5, ly + 0.5, 0.22, 0.03, y + 0.55, y + 0.66, hash(env.gx, env.gy) * Math.PI, f.c8([0.9, 0.9, 0.92]));
}

function warehouse(env, k) {
	const y = groundTop(env);
	gableShed(env, (env.a & 1) ? "ew" : "ns", y, 0.42, Math.max(0.24, k.top - 0.12), k.top, env.f.c8([0.66, 0.6, 0.52]), env.f.c8(SHED_ROOF));
}

function building(env, k) {
	const { f, lx, ly } = env;
	const y = groundTop(env);
	const top = y + k.top;
	const terminal = k.kind === "terminal";
	const wall = f.c8(terminal ? [0.78, 0.8, 0.82] : [0.82, 0.76, 0.62]);
	// squares of the same building (or a row of the same building) join into one block
	const [mw, me, mn, ms] = margins(env, 0.06);
	f.box(lx + mw, lx + 1 - me, y - 0.02, top, ly + mn, ly + 1 - ms, wall, f.c8([0.5, 0.5, 0.52]));
	if (terminal) {
		// glass band
		const g = f.c8([0.35, 0.5, 0.62]), y0 = y + 0.05, y1 = Math.min(top - 0.04, y + 0.2), e = 0.005;
		f.box(lx + mw - e, lx + 1 - me + e, y0, y1, ly + mn - e, ly + 1 - ms + e, g, wall);
	}
	const [rw, re, rn, rs] = margins(env, 0.03);
	f.box(lx + rw, lx + 1 - re, top, top + 0.025, ly + rn, ly + 1 - rs, f.c8(env.company || [0.45, 0.45, 0.48]));
}
