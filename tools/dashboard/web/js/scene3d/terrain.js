// Simutrans-Horizon dashboard, 3D view: terrain and water of a chunk from its corner heights (worker side, no
// three.js). The builders work in chunk-local squares; the buffers store world coordinates.
// Artistic License, see LICENSE.txt.
import { MeshBuf, rgb8, hash } from "./meshbuf.js";
import { SW, SE, NE, NW, G, K } from "./decode.js";

// climate 0..7: water desert tropic mediterranean temperate tundra rocky arctic (sRGB)
const CLIMATE_RGB = [[0.55, 0.62, 0.40], [0.86, 0.78, 0.52], [0.25, 0.55, 0.20], [0.60, 0.65, 0.33],
	[0.38, 0.58, 0.26], [0.52, 0.56, 0.38], [0.55, 0.52, 0.47], [0.93, 0.95, 0.97]];
const FOUNDATION_RGB = [0.60, 0.59, 0.56];
const OTHER_RGB = [0.50, 0.46, 0.40];
const FIELD_RGB = [0.78, 0.70, 0.36];
const CLIFF_RGB = [0.52, 0.45, 0.37];

const tints = new Map(); // rgb array -> Map(k in 1/100 -> uint8 triple) (few distinct values)
function tint(rgb, k) {
	let m = tints.get(rgb);
	if (!m) {
		m = new Map();
		tints.set(rgb, m);
	}
	const key = Math.round(k * 100);
	let v = m.get(key);
	if (!v) {
		v = rgb8(rgb, key / 100);
		m.set(key, v);
	}
	return v;
}

/**
 * Builds the terrain parts of a decoded chunk.
 * opts: {hs: height step, floor: level the border skirts go down to}
 * Returns {parts, hgrid: Int8Array(w*h) north-west corner levels, minLevel, maxLevel}.
 */
export function buildTerrain(c, opts) {
	const hs = opts.hs;
	const { w, h, ground: GR, objs } = c;
	// tunnel portals: the square is cut flat at the way, the hill behind it becomes a wall (ways.js puts the portal there)
	let C = c.corners;
	for (let t = 0; t < w * h; t++) {
		if ((GR[t] & 15) === G.PORTAL) {
			if (C === c.corners) {
				C = C.slice();
			}
			const b = t * 4, m = Math.min(C[b], C[b + 1], C[b + 2], C[b + 3]);
			C[b] = C[b + 1] = C[b + 2] = C[b + 3] = m;
		}
	}
	let minLevel = 127, maxLevel = -128;
	for (let i = 0; i < C.length; i++) {
		const v = C[i];
		if (v < minLevel) minLevel = v;
		if (v > maxLevel) maxLevel = v;
	}
	const floor = Math.min(opts.floor ?? minLevel - 4, minLevel - 1, c.water - 1);

	const field = new Uint8Array(w * h);
	for (let i = 0; i < objs.n; i++) {
		if (objs.kind[i] === K.FIELD) {
			field[objs.y[i] * w + objs.x[i]] = 1;
		}
	}

	const origin = [c.x0, c.y0];
	const terr = new MeshBuf(w * h * 4 + 2048, true, origin);
	const water = new MeshBuf(512, false, origin);
	const hgrid = new Int8Array(w * h);

	// tops: two triangles per square, split along the flatter diagonal; water squares get the water mesh instead
	for (let ly = 0; ly < h; ly++) {
		for (let lx = 0; lx < w; lx++) {
			const t = ly * w + lx, b = t * 4;
			hgrid[t] = C[b + NW];
			const g = GR[t], low = g & 15;
			if (low === G.WATER) {
				continue;
			}
			const hsw = C[b + SW], hse = C[b + SE], hne = C[b + NE], hnw = C[b + NW];
			let rgb = low === G.FOUNDATION ? FOUNDATION_RGB : low === G.OTHER ? OTHER_RGB : CLIMATE_RGB[(g >> 4) & 7];
			if (field[t] && low !== G.FOUNDATION) {
				rgb = FIELD_RGB;
			}
			const col = tint(rgb, 0.92 + 0.12 * Math.round(hash(c.x0 + lx, c.y0 + ly) * 6) / 6);
			const vnw = terr.v(lx, hnw * hs, ly, col);
			const vne = terr.v(lx + 1, hne * hs, ly, col);
			const vse = terr.v(lx + 1, hse * hs, ly + 1, col);
			const vsw = terr.v(lx, hsw * hs, ly + 1, col);
			if (Math.abs(hnw - hse) <= Math.abs(hne - hsw)) {
				terr.tri(vnw, vsw, vse);
				terr.tri(vnw, vse, vne);
			} else {
				terr.tri(vnw, vsw, vne);
				terr.tri(vne, vsw, vse);
			}
		}
	}

	// walls: the colour depends only on the absolute height, so walls of two chunks that meet look the same
	const span = Math.max(4, maxLevel - floor);
	const wallCol = (lev) => tint(CLIFF_RGB, 0.62 + 0.38 * Math.min(1, Math.max(0, (lev - floor) / span)));
	// wall along an edge from (x0, z0) to (x1, z1): one side has heights a0, a1, the other b0, b1
	const wall = (x0, z0, x1, z1, a0, a1, b0, b1) => {
		if (a0 === b0 && a1 === b1) {
			return;
		}
		const t0 = Math.max(a0, b0), d0 = Math.min(a0, b0), t1 = Math.max(a1, b1), d1 = Math.min(a1, b1);
		const i0 = terr.v(x0, t0 * hs, z0, wallCol(t0)), i1 = terr.v(x1, t1 * hs, z1, wallCol(t1));
		const i2 = terr.v(x1, d1 * hs, z1, wallCol(d1)), i3 = terr.v(x0, d0 * hs, z0, wallCol(d0));
		terr.quad(i0, i1, i2, i3);
	};
	for (let ly = 0; ly < h; ly++) {
		for (let lx = 0; lx < w; lx++) {
			const b = (ly * w + lx) * 4;
			if (lx + 1 < w) {
				wall(lx + 1, ly, lx + 1, ly + 1, C[b + NE], C[b + SE], C[b + 4 + NW], C[b + 4 + SW]);
			}
			if (ly + 1 < h) {
				const s = b + w * 4;
				wall(lx, ly + 1, lx + 1, ly + 1, C[b + SW], C[b + SE], C[s + NW], C[s + NE]);
			}
		}
	}
	// skirts at all four chunk borders down to the floor: whichever side of a border is higher shows its skirt as the
	// cliff, the rest is hidden under the lower side's ground, so chunks need not know their neighbours
	for (let lx = 0; lx < w; lx++) {
		const bn = lx * 4, bs = ((h - 1) * w + lx) * 4;
		wall(lx, 0, lx + 1, 0, C[bn + NW], C[bn + NE], floor, floor);
		wall(lx, h, lx + 1, h, C[bs + SW], C[bs + SE], floor, floor);
	}
	for (let ly = 0; ly < h; ly++) {
		const bw = ly * w * 4, be = (ly * w + w - 1) * 4;
		wall(0, ly, 0, ly + 1, C[bw + NW], C[bw + SW], floor, floor);
		wall(w, ly, w, ly + 1, C[be + NE], C[be + SE], floor, floor);
	}

	// water: flat at the square's own water height (sea or lake). One quad per square on a grid of shared corners:
	// longer quads met their neighbours in T-junctions, which showed hairline cracks across rivers.
	const W1 = w + 1, cornerV = new Int32Array(W1 * (h + 1)).fill(-1), cornerL = new Int8Array(W1 * (h + 1));
	const corner = (x, z, lev) => {
		const k = z * W1 + x;
		if (cornerV[k] < 0 || cornerL[k] !== lev) {
			cornerV[k] = water.v(x, lev * hs, z);
			cornerL[k] = lev;
		}
		return cornerV[k];
	};
	for (let ly = 0; ly < h; ly++) {
		for (let lx = 0; lx < w; lx++) {
			const t = ly * w + lx;
			if ((GR[t] & 15) === G.WATER) {
				const lev = C[t * 4 + NW];
				water.quad(corner(lx, ly, lev), corner(lx, ly + 1, lev), corner(lx + 1, ly + 1, lev), corner(lx + 1, ly, lev));
			}
		}
	}

	return {
		parts: [terr.part("terrain", "terrain"), water.part("water", "water")].filter(Boolean),
		hgrid, minLevel, maxLevel,
	};
}
