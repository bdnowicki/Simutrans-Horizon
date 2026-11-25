// Simutrans-Horizon dashboard, 3D view: geometry of one generated object (worker side, no three.js). Faces carry a
// window attribute for the "building" material (parts.js): u along the facade in window columns, v up in storeys
// (both stored * 256 in int16) and a window style (0 none, see WIN). Faces are oriented away from a centre point, so
// the primitives need no care about winding. Artistic License, see LICENSE.txt.
import { rgb8 } from "../meshbuf.js";

// window styles of the building shader: punched windows, ribbon windows, industrial strip, shop front, tall
// narrow windows (classic/civic), curtain wall, door
export const WIN = { none: 0, punched: 1, ribbon: 2, industrial: 3, shop: 4, tall: 5, curtain: 6, door: 7 };

const colCache = new Map();

/** "#rrggbb" or [r, g, b] (sRGB 0..1) times k -> linear uint8 triple (cached). */
export function col(c, k = 1) {
	const key = (Array.isArray(c) ? c.join(",") : c) + "*" + k;
	let v = colCache.get(key);
	if (!v) {
		const rgb = Array.isArray(c) ? c : [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
		v = rgb8(rgb, k);
		colCache.set(key, v);
	}
	return v;
}

export class TBuf {
	constructor() {
		this.pos = new Float32Array(3 * 256);
		this.col = new Uint8Array(3 * 256);
		this.win = new Int16Array(3 * 256);
		this.idx = new Uint32Array(3 * 256);
		this.nv = 0;
		this.ni = 0;
	}

	v(x, y, z, c, u = 0, w = 0, s = 0) {
		if ((this.nv + 1) * 3 > this.pos.length) {
			const n = this.pos.length * 2;
			const p = new Float32Array(n), cc = new Uint8Array(n), ww = new Int16Array(n);
			p.set(this.pos);
			cc.set(this.col);
			ww.set(this.win);
			this.pos = p;
			this.col = cc;
			this.win = ww;
		}
		const o = this.nv * 3;
		this.pos[o] = x;
		this.pos[o + 1] = y;
		this.pos[o + 2] = z;
		this.col[o] = c[0];
		this.col[o + 1] = c[1];
		this.col[o + 2] = c[2];
		this.win[o] = Math.max(-32767, Math.min(32767, Math.round(u * 256)));
		this.win[o + 1] = Math.max(-32767, Math.min(32767, Math.round(w * 256)));
		this.win[o + 2] = s;
		return this.nv++;
	}

	tri(a, b, c) {
		if (this.ni + 3 > this.idx.length) {
			const n = new Uint32Array(this.idx.length * 2);
			n.set(this.idx);
			this.idx = n;
		}
		this.idx[this.ni++] = a;
		this.idx[this.ni++] = b;
		this.idx[this.ni++] = c;
	}

	/**
	 * Convex polygon facing away from centre (cx, cy, cz). pts: [[x, y, z, u?, w?], ...]; s: window style (u, w per
	 * point in window cells; without them the face has no windows).
	 */
	face(pts, cx, cy, cz, c, s = 0) {
		const n = pts.length;
		let nx = 0, ny = 0, nz = 0, mx = 0, my = 0, mz = 0;
		for (let i = 0; i < n; i++) {
			const p = pts[i], q = pts[(i + 1) % n];
			nx += (p[1] - q[1]) * (p[2] + q[2]);
			ny += (p[2] - q[2]) * (p[0] + q[0]);
			nz += (p[0] - q[0]) * (p[1] + q[1]);
			mx += p[0];
			my += p[1];
			mz += p[2];
		}
		const out = nx * (mx / n - cx) + ny * (my / n - cy) + nz * (mz / n - cz) >= 0;
		const ids = new Array(n);
		for (let i = 0; i < n; i++) {
			const p = pts[out ? i : n - 1 - i];
			ids[i] = this.v(p[0], p[1], p[2], c, p[3] || 0, p[4] || 0, s);
		}
		for (let i = 1; i + 1 < n; i++) {
			this.tri(ids[0], ids[i], ids[i + 1]);
		}
	}

	/** Both sides of a flat polygon (blades, flags). */
	face2(pts, c) {
		let nx = 0, ny = 0, nz = 0, mx = 0, my = 0, mz = 0;
		const n = pts.length;
		for (let i = 0; i < n; i++) {
			const p = pts[i], q = pts[(i + 1) % n];
			nx += (p[1] - q[1]) * (p[2] + q[2]);
			ny += (p[2] - q[2]) * (p[0] + q[0]);
			nz += (p[0] - q[0]) * (p[1] + q[1]);
			mx += p[0] / n;
			my += p[1] / n;
			mz += p[2] / n;
		}
		this.face(pts, mx - nx, my - ny, mz - nz, c);
		this.face(pts, mx + nx, my + ny, mz + nz, c);
	}

	/**
	 * Vertical wall from (x0, z0) to (x1, z1), y0..y1, facing away from (cx, cz). With a window spec
	 * {s, col: column width, st: storey height, v0: storey number at y0} the face gets window cells: a whole number of
	 * columns along it, storeys from v0.
	 */
	wall(x0, z0, x1, z1, y0, y1, cx, cz, c, w) {
		if (y1 - y0 < 1e-4) {
			return;
		}
		if (!w || !w.s) {
			this.face([[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]], cx, (y0 + y1) / 2, cz, c, 0);
			return;
		}
		const len = Math.hypot(x1 - x0, z1 - z0);
		const n = Math.max(1, Math.round(len / w.col));
		const v0 = w.v0 || 0, v1 = v0 + (y1 - y0) / w.st;
		this.face([[x0, y0, z0, 0, v0], [x1, y0, z1, n, v0], [x1, y1, z1, n, v1], [x0, y1, z0, 0, v1]], cx, (y0 + y1) / 2, cz, c, w.s);
	}

	/** Prism over a convex footprint q ([[x, z], ...]) from y0 to y1, walls with windows w, a top (no bottom). */
	prism(q, y0, y1, c, top, w, noTop = false) {
		let cx = 0, cz = 0;
		for (const p of q) {
			cx += p[0] / q.length;
			cz += p[1] / q.length;
		}
		for (let i = 0; i < q.length; i++) {
			const a = q[i], b = q[(i + 1) % q.length];
			this.wall(a[0], a[1], b[0], b[1], y0, y1, cx, cz, c, w);
		}
		if (!noTop) {
			this.face(q.map((p) => [p[0], y1, p[1]]), cx, y1 - 1, cz, top || c, 0);
		}
	}

	/** Axis aligned box x0..x1, z0..z1, y0..y1 (no bottom). */
	box(x0, x1, y0, y1, z0, z1, c, top, w) {
		this.prism([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y0, y1, c, top, w);
	}

	/** Box with a footprint rotated by angle a about its centre (cx, cz), half sizes hx, hz. */
	obox(cx, cz, hx, hz, a, y0, y1, c, top) {
		const cs = Math.cos(a), sn = Math.sin(a);
		const P = (x, z) => [cx + cs * x - sn * z, cz + sn * x + cs * z];
		this.prism([P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz)], y0, y1, c, top);
	}

	/** Frustum (cylinder when r0 = r1) with n sides around (cx, cz); cap: top face; w: windows on the sides. */
	cyl(cx, cz, r0, r1, y0, y1, n, c, cap = true, top = c, w = null, phase = 0) {
		const lo = [], hi = [];
		for (let i = 0; i < n; i++) {
			const a = phase + (i / n) * Math.PI * 2;
			lo.push([cx + Math.cos(a) * r0, cz + Math.sin(a) * r0]);
			hi.push([cx + Math.cos(a) * r1, cz + Math.sin(a) * r1]);
		}
		const ym = (y0 + y1) / 2;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			if (w && w.s) {
				const seg = Math.hypot(lo[j][0] - lo[i][0], lo[j][1] - lo[i][1]);
				const k = Math.max(1, Math.round(seg / w.col)), v0 = w.v0 || 0, v1 = v0 + (y1 - y0) / w.st;
				this.face([[lo[i][0], y0, lo[i][1], 0, v0], [lo[j][0], y0, lo[j][1], k, v0], [hi[j][0], y1, hi[j][1], k, v1],
					[hi[i][0], y1, hi[i][1], 0, v1]], cx, ym, cz, c, w.s);
			} else if (r1 < 1e-5) {
				this.face([[lo[i][0], y0, lo[i][1]], [lo[j][0], y0, lo[j][1]], [cx, y1, cz]], cx, y0 + (y1 - y0) * 0.25, cz, c);
			} else {
				this.face([[lo[i][0], y0, lo[i][1]], [lo[j][0], y0, lo[j][1]], [hi[j][0], y1, hi[j][1]], [hi[i][0], y1, hi[i][1]]], cx, ym, cz, c);
			}
		}
		if (cap && r1 > 1e-5) {
			this.face(hi.map((p) => [p[0], y1, p[1]]), cx, y1 - 1, cz, top);
		}
	}

	/** Dome (half sphere, squashed by k) on a ring of radius r at height y; rings of n sides. */
	dome(cx, cz, r, y, n, rings, c, k = 1, onion = 0) {
		let prevR = r, prevY = y;
		for (let i = 1; i <= rings; i++) {
			const a = (i / rings) * Math.PI / 2;
			let rr = Math.cos(a) * r, yy = y + Math.sin(a) * r * k;
			if (onion) {
				rr *= 1 + onion * Math.sin(a * 2) * (1 - i / rings);
			}
			if (i === rings) {
				rr = 0;
			}
			this.cyl(cx, cz, prevR, rr, prevY, yy, n, c, false);
			prevR = rr;
			prevY = yy;
		}
	}

	/** Gable roof over x0..x1, z0..z1 from y (eaves) up h; ridge along x when alongX, overhang o. */
	gable(x0, x1, z0, z1, y, h, alongX, c, wallC, o = 0.02) {
		const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, cy = y + h * 0.3;
		if (alongX) {
			this.face([[x0 - o, y, z0 - o], [x1 + o, y, z0 - o], [x1 + o, y + h, cz], [x0 - o, y + h, cz]], cx, cy, cz, c);
			this.face([[x0 - o, y, z1 + o], [x1 + o, y, z1 + o], [x1 + o, y + h, cz], [x0 - o, y + h, cz]], cx, cy, cz, c);
			this.face([[x0, y, z0], [x0, y, z1], [x0, y + h, cz]], cx, cy, cz, wallC);
			this.face([[x1, y, z0], [x1, y, z1], [x1, y + h, cz]], cx, cy, cz, wallC);
		} else {
			this.face([[x0 - o, y, z0 - o], [x0 - o, y, z1 + o], [cx, y + h, z1 + o], [cx, y + h, z0 - o]], cx, cy, cz, c);
			this.face([[x1 + o, y, z0 - o], [x1 + o, y, z1 + o], [cx, y + h, z1 + o], [cx, y + h, z0 - o]], cx, cy, cz, c);
			this.face([[x0, y, z0], [x1, y, z0], [cx, y + h, z0]], cx, cy, cz, wallC);
			this.face([[x0, y, z1], [x1, y, z1], [cx, y + h, z1]], cx, cy, cz, wallC);
		}
	}

	/** Hip roof (pyramid when the ridge would be shorter than 0), ridge along the longer side. */
	hip(x0, x1, z0, z1, y, h, c, o = 0.02) {
		x0 -= o;
		x1 += o;
		z0 -= o;
		z1 += o;
		const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, cy = y + h * 0.3;
		const wx = x1 - x0, wz = z1 - z0;
		if (wx >= wz) {
			const r = Math.max(0, (wx - wz) / 2);
			const a = [cx - r, y + h, cz], b = [cx + r, y + h, cz];
			this.face([[x0, y, z0], [x1, y, z0], b, a], cx, cy, cz, c);
			this.face([[x0, y, z1], [x1, y, z1], b, a], cx, cy, cz, c);
			this.face([[x0, y, z0], [x0, y, z1], a], cx, cy, cz, c);
			this.face([[x1, y, z0], [x1, y, z1], b], cx, cy, cz, c);
		} else {
			const r = Math.max(0, (wz - wx) / 2);
			const a = [cx, y + h, cz - r], b = [cx, y + h, cz + r];
			this.face([[x0, y, z0], [x0, y, z1], b, a], cx, cy, cz, c);
			this.face([[x1, y, z0], [x1, y, z1], b, a], cx, cy, cz, c);
			this.face([[x0, y, z0], [x1, y, z0], a], cx, cy, cz, c);
			this.face([[x0, y, z1], [x1, y, z1], b], cx, cy, cz, c);
		}
	}

	/** Saw-tooth roof (factory halls): n teeth across z, glazing facing -z. */
	sawtooth(x0, x1, z0, z1, y, h, n, c, glass) {
		const d = (z1 - z0) / n, cx = (x0 + x1) / 2;
		for (let i = 0; i < n; i++) {
			const a = z0 + i * d, b = a + d;
			this.face([[x0, y, a], [x1, y, a], [x1, y + h, a + d * 0.15], [x0, y + h, a + d * 0.15]], cx, y, a + d * 0.6, glass);
			this.face([[x0, y + h, a + d * 0.15], [x1, y + h, a + d * 0.15], [x1, y, b], [x0, y, b]], cx, y, a + d * 0.3, c);
			this.face([[x0, y, a], [x0, y + h, a + d * 0.15], [x0, y, b]], cx + 1, y, a + d / 2, c);
			this.face([[x1, y, a], [x1, y + h, a + d * 0.15], [x1, y, b]], cx - 1, y, a + d / 2, c);
		}
	}

	/** Flat quad at height y (lots, courts, paths). */
	pad(x0, x1, z0, z1, y, c) {
		this.face([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], (x0 + x1) / 2, y - 1, (z0 + z1) / 2, c);
	}
}
