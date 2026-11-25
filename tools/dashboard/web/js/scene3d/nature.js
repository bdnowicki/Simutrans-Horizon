// Simutrans-Horizon dashboard, 3D view: trees, fields and ground objects of a chunk (worker side, no three.js).
// Trees: a low-poly shape per tree desc (name keywords, else its climates; gen/rules.json "trees"), scaled by the age
// class, with a small stable jitter of position, turn and size. Trees keep their summer colour here; the season
// (autumn leaves, bare and snowy winter trees, spring green) is drawn by their shader (sky.js), so a new season
// needs no new geometry: each copy carries its class (evergreen, deciduous, none), a random and its ground level.
// They go to the chunk's nature furniture (`out.nf`, furniture.js: instanced when a shape has many copies). Fields:
// the crop of the nearest factory in the chunk (rules "fields"), a crop patch with rows over the terrain (in the ways
// mesh), pens, fences or saplings for some farms. Ground objects (rocks, bushes; the export does not say which): by
// the climate of the square. Artistic License, see LICENSE.txt.
import { rgb8, rgbLin, hash, hashStr } from "./meshbuf.js";
import { K, SW, SE, NE, NW } from "./decode.js";
import { keywordRe } from "./gen/buildings.js";

const DECIDUOUS = new Set(["round", "birch", "poplar", "shrub"]);
const FALLBACK_COLORS = { round: ["#4f7d33"], birch: ["#7aa04a"], conifer: ["#2f5a34"], poplar: ["#3f6a32"], palm: ["#5c8f3a"],
	shrub: ["#557f38"], cactus: ["#5f8a4a"], autumn: ["#c0762a", "#b4532a", "#d19a32"], winter: ["#6b5d4d"], spring: ["#7bab47"] };

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

function weightedKey(o, r) {
	let sum = 0;
	for (const v of Object.values(o)) {
		sum += v;
	}
	let x = r * sum;
	for (const [k, v] of Object.entries(o)) {
		x -= v;
		if (x <= 0) {
			return k;
		}
	}
	return Object.keys(o)[0];
}

/** Shape of a tree desc: keyword, else the first climate rule that fits its climates. */
export function treeShape(d, R) {
	const name = d.name || "";
	for (const k of R.keywords || []) {
		if (k.match && keywordRe(k.match).test(name)) {
			return k.shape;
		}
	}
	const m = (d.climates ?? 16) & 0xfe;
	for (const c of R.climates || []) {
		if ((c.mask !== undefined && (c.mask & 0xfe) === m) || (c.only !== undefined && (m & ~c.only) === 0) || (c.mask === undefined && c.only === undefined)) {
			return weightedKey(c.shapes || { round: 1 }, hashStr("s" + name));
		}
	}
	return hashStr("c" + name) < 0.35 ? "conifer" : "round";
}

/** cat: desc_list; opts: {hs, rules, treeDensity (0..1)}. */
export function createNatureBuilder(cat, opts = {}) {
	const hs = opts.hs;
	const R = (opts.rules && opts.rules.trees) || {};
	const F = (opts.rules && opts.rules.fields) || {};
	const colors = Object.assign({}, FALLBACK_COLORS, R.colors || {});
	const pal = {};
	for (const [k, v] of Object.entries(colors)) {
		pal[k] = v.map(hex);
	}
	const trees = [];
	for (const d of cat.trees || []) {
		const shape = treeShape(d, R);
		const own = pal[shape] || pal.round;
		trees[d.i] = { shape, key: "tree_" + shape, base: own[Math.floor(hashStr("k" + d.name) * own.length) % own.length],
			cls: DECIDUOUS.has(shape) ? 1 : shape === "cactus" ? 2 : 0 };
	}
	const crops = (F.crops || []).map((c) => Object.assign({}, c, { re: keywordRe(c.match || "$^") }));
	const factoryCrop = [];
	for (const d of cat.buildings || []) {
		if (d.type === "factory") {
			const c = crops.find((k) => k.re.test(d.name || ""));
			if (c) {
				factoryCrop[d.i] = c;
			}
		}
	}
	const defCrop = F.default || { summer: "#c9b04a", autumn: "#a99a5a", rows: "#9a8a3a" };
	const density = opts.treeDensity ?? 1;
	const linCache = new Map();
	const lin = (rgb, k) => {
		const key = rgb.join() + k;
		let v = linCache.get(key);
		if (!v) {
			v = rgbLin(rgb, k);
			linCache.set(key, v);
		}
		return v;
	};

	/** Summer colour of a tree (the shader turns it into the season's). */
	function treeColor(st, r2) {
		return lin(st.base, Math.round((0.88 + 0.24 * r2) * 20) / 20);
	}

	/** sink(i, x, y, z, s, rot, ageScale): a pak 3D model draws tree i (pakplace.js), when c.modelled[i]. */
	function build(c, out, sink = null) {
		const { w, h, corners: C, ground: GR, objs: o } = c;
		const f = out.nf;
		const hAt = (b, u, v) => (C[b + NW] * (1 - u) * (1 - v) + C[b + NE] * u * (1 - v) + C[b + SE] * u * v + C[b + SW] * (1 - u) * v) * hs;
		const treeCount = new Uint8Array(w * h);
		let factories = null, fieldAt = null;
		const stats = { trees: 0, skipped: 0, fields: 0, groundobjs: 0, modelTrees: 0 };
		for (let i = 0; i < o.n; i++) {
			const kind = o.kind[i];
			if (kind !== K.TREE && kind !== K.FIELD && kind !== K.GROUNDOBJ) {
				continue;
			}
			const lx = o.x[i], ly = o.y[i], t = ly * w + lx, b = t * 4;
			const gx = c.x0 + lx, gy = c.y0 + ly;
			if (kind === K.TREE) {
				const k = treeCount[t]++;
				if (density < 1 && hash(gx, gy, k * 3 + 9) > density) {
					stats.skipped++;
					continue;
				}
				const st = trees[o.desc[i]] || { shape: "round", key: "tree_round", base: pal.round[0], cls: 1 };
				const u = 0.18 + 0.64 * hash(gx, gy, k * 3 + 1), v = 0.18 + 0.64 * hash(gx, gy, k * 3 + 2);
				const r1 = hash(gx, gy, k * 7 + 3), r2 = hash(gx, gy, k * 7 + 4);
				const age = 0.42 + 0.14 * Math.min(4, o.a[i]), jitter = 0.88 + 0.24 * hash(gx, gy, k * 7 + 5);
				if (sink && c.modelled && c.modelled[i]) {
					// a model of the pak 3D: full size when grown (age class 4), scaled by age only if its entry says so
					sink(i, lx + u, hAt(b, u, v) - 0.01, ly + v, jitter, hash(gx, gy, k + 5) * 6.283, age / 0.98);
					stats.modelTrees++;
					continue;
				}
				const s = age * jitter;
				const sxz = s * (1 + 0.25 * r2);
				f.add(st.key, lx + u, hAt(b, u, v) - 0.01, ly + v, sxz, s, sxz, treeColor(st, r2), hash(gx, gy, k + 5) * 6.283,
					[st.cls, r1, o.z[i]]);
				stats.trees++;
			} else if (kind === K.FIELD) {
				if (!factories) {
					factories = [];
					fieldAt = new Uint8Array(w * h);
					for (let j = 0; j < o.n; j++) {
						if (o.kind[j] === K.BUILDING && o.b[j] === 0 && factoryCrop[o.desc[j]]) {
							factories.push([o.x[j], o.y[j], factoryCrop[o.desc[j]]]);
						} else if (o.kind[j] === K.FIELD) {
							fieldAt[o.y[j] * w + o.x[j]] = 1;
						}
					}
				}
				let crop = null, best = 24;
				for (const [fx, fy, cr] of factories) {
					const dd = Math.abs(fx - lx) + Math.abs(fy - ly);
					if (dd < best) {
						best = dd;
						crop = cr;
					}
				}
				field(c, out, lx, ly, b, hAt, crop || defCrop, fieldAt);
				stats.fields++;
			} else {
				const clim = (GR[t] >> 4) & 7, r = hash(gx, gy, 31);
				const u = 0.25 + 0.5 * hash(gx, gy, 11), v = 0.25 + 0.5 * hash(gx, gy, 12), y = hAt(b, u, v);
				const rot = hash(gx, gy, 13) * 6.283;
				if (clim === 1 && r < 0.4) {
					f.add("tree_cactus", lx + u, y, ly + v, 0.5, 0.5, 0.5, lin(pal.cactus[0], 1), rot, [2, r, o.z[i]]);
				} else if (clim !== 1 && clim < 6 && r < 0.55) {
					const s = 0.45 + 0.3 * hash(gx, gy, 14);
					f.add("tree_shrub", lx + u, y - 0.01, ly + v, s, s, s, treeColor({ base: pal.shrub[0] }, hash(gx, gy, 15)), rot,
						[1, r, o.z[i]]);
				} else {
					const s = 0.22 + 0.16 * hash(gx, gy, 14);
					const grey = clim === 7 ? [0.86, 0.87, 0.9] : [0.56 + 0.06 * r, 0.54 + 0.05 * r, 0.5];
					f.add("rock", lx + u, y - 0.015, ly + v, s, s, s * (0.8 + 0.4 * r), lin(grey, 1), rot);
				}
				stats.groundobjs++;
			}
		}
		return stats;
	}

	function field(c, out, lx, ly, b, hAt, crop, fieldAt) {
		const m = out.way, f = out.nf, C = c.corners;
		const gx = c.x0 + lx, gy = c.y0 + ly;
		// crops keep their summer colour through the year (as the game draws them; snow comes from the shader)
		const baseHex = crop.summer;
		const base = rgb8(hex(baseHex), 0.95 + 0.1 * hash(gx >> 2, gy >> 2, 21));
		const y = (u, v) => hAt(b, u, v) + 0.002;
		const q = (u0, v0, u1, v1, dy, col) => {
			const i0 = m.v(lx + u0, y(u0, v0) + dy, ly + v0, col), i1 = m.v(lx + u0, y(u0, v1) + dy, ly + v1, col);
			const i2 = m.v(lx + u1, y(u1, v1) + dy, ly + v1, col), i3 = m.v(lx + u1, y(u1, v0) + dy, ly + v0, col);
			m.quad(i0, i1, i2, i3);
		};
		q(0, 0, 1, 1, 0, base);
		if (crop.pens) {
			const fc = f.c8([0.62, 0.5, 0.36]);
			const y0 = Math.min(C[b], C[b + 1], C[b + 2], C[b + 3]) * hs;
			fence(f, lx, ly, y0, 0.035, fc, [1, 1, 1, 1]);
			return;
		}
		if (crop.saplings) {
			for (let k = 0; k < 4; k++) {
				const u = 0.2 + 0.6 * (k & 1), v = 0.2 + 0.6 * (k >> 1);
				f.add("tree_conifer", lx + u, hAt(b, u, v), ly + v, 0.22, 0.22, 0.22, rgbLin([0.25, 0.45, 0.26]), hash(gx, gy, k) * 6.283,
					[0, 0.5, Math.min(C[b], C[b + 1], C[b + 2], C[b + 3])]);
			}
			return;
		}
		if (crop.fence && fieldAt) {
			const w = c.w, h = c.h;
			const edge = (dx, dy) => {
				const x = lx + dx, yy = ly + dy;
				return x < 0 || yy < 0 || x >= w || yy >= h ? 0 : fieldAt[yy * w + x] ? 0 : 1;
			};
			const y0 = Math.min(C[b], C[b + 1], C[b + 2], C[b + 3]) * hs;
			fence(f, lx, ly, y0, 0.03, f.c8([0.85, 0.83, 0.78]), [edge(-1, 0), edge(1, 0), edge(0, -1), edge(0, 1)]);
			return;
		}
		// crop rows along one axis per 4 x 4 block of squares (neighbours line up)
		const rows = rgb8(hex(crop.rows || "#9a8a3a"));
		const alongX = hash(gx >> 2, gy >> 2, 7) < 0.5;
		const dy = crop.tall || 0.004;
		for (let k = 0; k < 4; k++) {
			const a0 = (k + 0.25) / 4, a1 = (k + 0.7) / 4;
			if (alongX) {
				q(0.02, a0, 0.98, a1, dy, rows);
			} else {
				q(a0, 0.02, a1, 0.98, dy, rows);
			}
		}
	}

	return { build, trees: (i) => trees[i] || null };
}

/** Low fence on the sides of a square: sides [west, east, north, south] (1 = fence). */
function fence(f, lx, ly, y, hgt, col, sides) {
	const t = 0.012;
	if (sides[0]) f.box(lx, lx + t, y, y + hgt, ly, ly + 1, col);
	if (sides[1]) f.box(lx + 1 - t, lx + 1, y, y + hgt, ly, ly + 1, col);
	if (sides[2]) f.box(lx, lx + 1, y, y + hgt, ly, ly + t, col);
	if (sides[3]) f.box(lx, lx + 1, y, y + hgt, ly + 1 - t, ly + 1, col);
}
