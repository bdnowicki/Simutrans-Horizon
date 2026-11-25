// Simutrans-Horizon dashboard, 3D view: procedural buildings (worker side, no three.js). Every building desc of
// desc_list except stations, extensions and depots (stations.js) gets a generated low-poly model: a form (block,
// industrial hall, factory site, church, tower, park, ...) chosen by category and name keywords from gen/rules.json,
// sized from the desc (footprint, height clearance; level only varies the height within the clearance's range),
// with a seed from the desc name, so a building looks the same everywhere. A model is made once per (desc, layout
// [, owner for company coloured ones]) and cached: footprint of the rotated layout, origin at the north-west corner
// of the square with offset (0, 0), y = 0 at the ground of that square. Layout 0 faces south (+z); layouts 1, 2, 3
// face east, north, west (2 layouts: south and east), as the game turns city buildings towards their street.
// Artistic License, see LICENSE.txt.
import { TBuf, col } from "./tbuf.js";
import { hashStr } from "../meshbuf.js";
import { weighted, pickPal } from "./common.js";
import { block, hall, civic, plinth } from "./block.js";
import { works, fuelstation, turbine, solar, oilrig, buoys } from "./works.js";
import * as L from "./landmarks.js";

export { mergeRules } from "../pak.js";

// types drawn by stations.js
const STATION_TYPES = new Set(["stop", "ext", "depot"]);
const WARM = 0b00001110, COLD = 0b11100000;

function prng(seed) {
	let a = (seed * 4294967296) >>> 0 || 0x9e3779b9;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const reCache = new Map();
export function keywordRe(s) {
	let r = reCache.get(s);
	if (!r) {
		try {
			r = new RegExp(s, "i");
		} catch (e) {
			r = /$^/;
		}
		reCache.set(s, r);
	}
	return r;
}

function climateClass(mask) {
	let w = 0, c = 0;
	for (let b = 0; b < 8; b++) {
		if (mask & (1 << b) & WARM) w++;
		if (mask & (1 << b) & COLD) c++;
	}
	return w > c ? "warm" : c > w ? "cold" : "any";
}

/** Rotation (quarter turns: front south -> east -> north -> west) of a building layout. */
export function rotationOf(layouts, layout) {
	return layouts >= 4 ? layout & 3 : layouts === 2 ? layout & 1 : 0;
}

/**
 * cat: desc_list; opts: {hs, rules (gen/rules.json, optional), players: [[r, g, b] sRGB 0..1 per player number],
 * categoryOf(desc) -> category name or null (a pak 3D entry with "generator")}.
 * Returns {has(i), template(i, layout, owner), topAt(i, layout, owner, ox, oy), category(i), info}.
 */
export function createBuildingGen(cat, opts = {}) {
	const hs = opts.hs;
	const rules = opts.rules || {};
	const units = Object.assign({ storey: 0.62, column: 0.13 }, rules.units || {});
	const palettes = rules.palettes || {};
	const cats = rules.categories || {};
	const byType = {};
	for (const [name, c] of Object.entries(cats)) {
		for (const t of c.types || []) {
			if (!byType[t]) {
				byType[t] = [name, c];
			}
		}
	}
	const FALLBACK = { res: "block", com: "block", ind: "hall", cur: "civic", mon: "statue", tow: "townhall", hq: "headquarters",
		factory: "works", other: "plinth" };
	const info = [];
	for (const d of cat.buildings || []) {
		if (STATION_TYPES.has(d.type)) {
			continue;
		}
		const forced = opts.categoryOf ? opts.categoryOf(d) : null;
		const tc = forced && cats[forced] ? [forced, cats[forced]] : byType[d.type] || [d.type, { form: FALLBACK[d.type] || "block" }];
		let P = tc[1];
		for (const k of P.keywords || []) {
			if (k.match && keywordRe(k.match).test(d.name || "")) {
				P = Object.assign({}, P, k);
				break;
			}
		}
		info[d.i] = { d, category: tc[0], P, form: P.form || FALLBACK[d.type] || "block" };
	}
	const players = opts.players || [];
	const cache = new Map();
	let made = 0, madeMs = 0;

	/** Cache key of a model: desc, layout and (for company coloured ones) the owner. */
	function keyOf(i, layout, owner) {
		const inf = info[i];
		const company = inf && inf.P.companyColor && owner >= 0 ? owner : -1;
		return i * 4096 + (layout & 15) * 256 + (company + 1);
	}

	function template(i, layout, owner) {
		const inf = info[i];
		if (!inf) {
			return null;
		}
		const company = inf.P.companyColor && owner >= 0 ? owner : -1;
		const key = keyOf(i, layout, owner);
		let t = cache.get(key);
		if (!t) {
			const t0 = performance.now();
			t = make(inf, layout, company >= 0 ? players[company] || [0.6, 0.6, 0.6] : null);
			t.key = key;
			madeMs += performance.now() - t0;
			made++;
			cache.set(key, t);
		}
		return t;
	}

	function make(inf, layout, company) {
		const d = inf.d, P = inf.P;
		const sx = (d.size && d.size[0]) || 1, sy = (d.size && d.size[1]) || 1;
		const rnd = prng(hashStr(d.name || String(d.i)));
		const lev = levelsOf(d, sx, sy, rnd);
		const tb = new TBuf();
		const g = {
			tb, W: sx, D: sy, d, P, rnd, hs, lev, H: lev * hs, st: units.storey * hs, colW: units.column,
			climate: climateClass(d.climates ?? 255), company: company ? col(company) : null,
			range: (r, k = 1) => (Array.isArray(r) ? r[0] + (r[1] - r[0]) * rnd() : r ?? k),
			int: (r) => (Array.isArray(r) ? r[0] + Math.floor(rnd() * (r[1] - r[0] + 1)) : r | 0),
			pick: (a) => a[Math.floor(rnd() * a.length) % a.length],
			weighted: (o) => weighted(o, rnd),
			pal: (name, k = 1) => col(pickPal(palettes, name, rnd), k),
			palHex: (name) => pickPal(palettes, name, rnd),
		};
		(FORMS[inf.form] || FORMS.block)(g);
		return finish(tb, sx, sy, rotationOf(d.layouts | 0, layout));
	}

	function topAt(i, layout, owner, ox, oy) {
		const t = template(i, layout, owner);
		if (!t) {
			return null;
		}
		const k = Math.min(t.w - 1, Math.max(0, ox)) + Math.min(t.d - 1, Math.max(0, oy)) * t.w;
		return t.tops[k];
	}

	return {
		has: (i) => !!info[i],
		category: (i) => (info[i] ? info[i].category : null),
		form: (i) => (info[i] ? info[i].form : null),
		template, topAt, keyOf,
		info: () => ({ templates: cache.size, made, made_ms: Math.round(madeMs * 10) / 10 }),
	};
}

/** Height of the building in levels from the desc: `height` is the drawn height of its tallest image. */
function levelsOf(d, sx, sy, rnd) {
	const h = d.height | 0;
	let lev;
	if (h <= 4) {
		lev = Math.max(0.75, h);
	} else {
		// images of several rows: the top row may be partly empty, so the building is up to ~5 levels lower;
		// the level (size class) and the seed pick a height in that range
		const t = Math.min(1, Math.max(0, ((d.level | 0) - 20) / 45));
		lev = h - 5 + 5 * (0.3 + 0.7 * (0.6 * t + 0.4 * rnd()));
	}
	// the image of a large building also reaches over its squares in front
	return Math.max(Math.min(lev, 1.2), lev - (sx + sy - 2));
}

/** Rotates the canonical model into the layout's footprint, computes the tops per square, compacts the arrays. */
function finish(tb, sx, sy, r) {
	const n = tb.nv, P = tb.pos;
	const w = r & 1 ? sy : sx, d = r & 1 ? sx : sy;
	for (let i = 0; i < n * 3; i += 3) {
		const x = P[i], z = P[i + 2];
		if (r === 1) {
			P[i] = z;
			P[i + 2] = sx - x;
		} else if (r === 2) {
			P[i] = sx - x;
			P[i + 2] = sy - z;
		} else if (r === 3) {
			P[i] = sy - z;
			P[i + 2] = x;
		}
	}
	let ymax = 0, ymin = 0;
	for (let i = 1; i < n * 3; i += 3) {
		if (P[i] > ymax) {
			ymax = P[i];
		}
		if (P[i] < ymin) {
			ymin = P[i];
		}
	}
	// top per square: the highest triangle over it (by the triangle's footprint, so wide roofs count everywhere)
	const tops = new Float32Array(w * d).fill(0.02);
	const I = tb.idx, cl = (v, m) => Math.min(m - 1, Math.max(0, Math.floor(v)));
	for (let k = 0; k < tb.ni; k += 3) {
		const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
		const x0 = cl(Math.min(P[a], P[b], P[c]) + 1e-4, w), x1 = Math.max(x0, cl(Math.max(P[a], P[b], P[c]) - 1e-4, w));
		const z0 = cl(Math.min(P[a + 2], P[b + 2], P[c + 2]) + 1e-4, d), z1 = Math.max(z0, cl(Math.max(P[a + 2], P[b + 2], P[c + 2]) - 1e-4, d));
		const y = Math.max(P[a + 1], P[b + 1], P[c + 1]);
		for (let tz = z0; tz <= z1; tz++) {
			for (let tx = x0; tx <= x1; tx++) {
				if (y > tops[tx + tz * w]) {
					tops[tx + tz * w] = y;
				}
			}
		}
	}
	const idx = tb.idx.subarray(0, tb.ni);
	return {
		pos: tb.pos.slice(0, n * 3), col: tb.col.slice(0, n * 3), win: tb.win.slice(0, n * 3),
		idx: n < 65536 ? Uint16Array.from(idx) : idx.slice(), nv: n, ni: tb.ni, tops, w, d, height: ymax, ymin,
	};
}

const FORMS = {
	block, hall, works, civic, plinth, fuelstation, turbine, solar, oilrig, buoys,
	...L,
};

export const FORM_NAMES = Object.keys(FORMS);
