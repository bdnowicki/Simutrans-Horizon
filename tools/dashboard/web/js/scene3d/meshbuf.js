// Simutrans-Horizon dashboard, 3D view: growable typed buffers for chunk geometry, colours and hashes. No three.js,
// so it runs in the worker. Artistic License, see LICENSE.txt.

class Grow {
	constructor(T, n) {
		this.T = T;
		this.a = new T(Math.max(16, n));
		this.n = 0;
	}

	need(k) {
		if (this.n + k > this.a.length) {
			const b = new this.T(Math.max(this.a.length * 2, this.n + k));
			b.set(this.a.subarray(0, this.n));
			this.a = b;
		}
	}

	done() {
		return this.a.slice(0, this.n);
	}
}

/**
 * Indexed triangles with a linear RGB colour (uint8, normalized) per vertex. Callers give chunk-local x, z; the
 * buffer stores world coordinates (+ origin), so that edges shared by two chunks are bit for bit the same after the
 * one view transform (chunks with their own model matrix showed hairline cracks along their borders).
 */
export class MeshBuf {
	constructor(nv, colors = true, origin = [0, 0]) {
		this.ox = origin[0];
		this.oz = origin[1];
		nv = Math.max(64, nv | 0);
		this.pa = new Float32Array(nv * 3);
		this.ca = colors ? new Uint8Array(nv * 3) : null;
		this.ia = new Uint32Array(nv * 3);
		this.nv = 0;
		this.ni = 0;
		this.x0 = this.y0 = this.z0 = Infinity;
		this.x1 = this.y1 = this.z1 = -Infinity;
	}

	/** Positions as {a: Float32Array} (read access for callers that look at vertices they added). */
	get p() {
		return { a: this.pa };
	}

	/** Makes room for at least nv vertices and as many triangles. */
	reserve(nv) {
		while (this.pa.length < nv * 3) {
			this.growV();
		}
		if (this.ia.length < nv * 3) {
			const n = new Uint32Array(nv * 3);
			n.set(this.ia.subarray(0, this.ni));
			this.ia = n;
		}
	}

	growV() {
		const n = this.pa.length * 2;
		const pa = new Float32Array(n);
		pa.set(this.pa);
		this.pa = pa;
		if (this.ca) {
			const ca = new Uint8Array(n);
			ca.set(this.ca);
			this.ca = ca;
		}
	}

	v(x, y, z, rgb) {
		return rgb ? this.vc(x, y, z, rgb[0], rgb[1], rgb[2]) : this.vc(x, y, z, 0, 0, 0);
	}

	vc(x, y, z, r, g, b) {
		x += this.ox;
		z += this.oz;
		const o = this.nv * 3;
		if (o + 3 > this.pa.length) {
			this.growV();
		}
		const pa = this.pa;
		pa[o] = x;
		pa[o + 1] = y;
		pa[o + 2] = z;
		const ca = this.ca;
		if (ca) {
			ca[o] = r;
			ca[o + 1] = g;
			ca[o + 2] = b;
		}
		if (x < this.x0) this.x0 = x;
		if (x > this.x1) this.x1 = x;
		if (y < this.y0) this.y0 = y;
		if (y > this.y1) this.y1 = y;
		if (z < this.z0) this.z0 = z;
		if (z > this.z1) this.z1 = z;
		return this.nv++;
	}

	tri(a, b, c) {
		let ia = this.ia;
		const o = this.ni;
		if (o + 3 > ia.length) {
			const n = new Uint32Array(ia.length * 2);
			n.set(ia);
			this.ia = ia = n;
		}
		ia[o] = a;
		ia[o + 1] = b;
		ia[o + 2] = c;
		this.ni = o + 3;
	}

	quad(a, b, c, d) {
		this.tri(a, b, c);
		this.tri(a, c, d);
	}

	/** A mesh part (see parts.js) or null when empty. */
	part(layer, material) {
		if (!this.nv) {
			return null;
		}
		const idx = this.ia.subarray(0, this.ni);
		const index = this.nv < 65536 ? new Uint16Array(idx) : idx.slice();
		const out = { type: "mesh", layer, material, position: this.pa.slice(0, this.nv * 3), index,
			sphere: sphereOf([this.x0, this.y0, this.z0], [this.x1, this.y1, this.z1]) };
		if (this.ca) {
			out.color = this.ca.slice(0, this.nv * 3);
		}
		return out;
	}
}

/** Instances of a shape: column-major 4x4 matrices (translate * rotateY * scale) and linear RGB floats. */
export class InstBuf {
	constructor(n, origin = [0, 0]) {
		this.ox = origin[0];
		this.oz = origin[1];
		this.m = new Grow(Float32Array, n * 16);
		this.c = new Grow(Float32Array, n * 3);
		this.count = 0;
		this.min = [Infinity, Infinity, Infinity];
		this.max = [-Infinity, -Infinity, -Infinity];
	}

	/** (x, y, z) is the base point; the shape's unit box [-0.5, 0.5] x [0, 1] x [-0.5, 0.5] is scaled by sx, sy, sz. */
	add(x, y, z, sx, sy, sz, rgb, rot = 0) {
		x += this.ox;
		z += this.oz;
		this.m.need(16);
		this.c.need(3);
		const m = this.m.a, o = this.m.n;
		const cs = Math.cos(rot), sn = Math.sin(rot);
		m[o] = cs * sx; m[o + 1] = 0; m[o + 2] = -sn * sx; m[o + 3] = 0;
		m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
		m[o + 8] = sn * sz; m[o + 9] = 0; m[o + 10] = cs * sz; m[o + 11] = 0;
		m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
		this.m.n += 16;
		const c = this.c.a;
		c[this.c.n++] = rgb[0];
		c[this.c.n++] = rgb[1];
		c[this.c.n++] = rgb[2];
		this.count++;
		const r = Math.max(sx, sz) * 0.75;
		const mn = this.min, mx = this.max;
		if (x - r < mn[0]) mn[0] = x - r;
		if (y < mn[1]) mn[1] = y;
		if (z - r < mn[2]) mn[2] = z - r;
		if (x + r > mx[0]) mx[0] = x + r;
		if (y + sy > mx[1]) mx[1] = y + sy;
		if (z + r > mx[2]) mx[2] = z + r;
	}

	part(layer, shape, material) {
		if (!this.count) {
			return null;
		}
		return { type: "instances", layer, shape, material, matrix: this.m.done(), color: this.c.done(), count: this.count,
			sphere: sphereOf(this.min, this.max) };
	}
}

/**
 * Copies of generated models (gen/buildings.js templates: pos, col, win, idx, w, d, ymin, height) merged into one
 * mesh with the window attribute of the "building" material: positions in world coordinates like MeshBuf.
 */
export class StampBuf {
	/** nv, ni: vertices and indices to expect (exact sizes need no copies). */
	constructor(nv, ni, origin = [0, 0]) {
		this.ox = origin[0];
		this.oz = origin[1];
		nv = Math.max(4, nv | 0);
		this.pa = new Float32Array(nv * 3);
		this.ca = new Uint8Array(nv * 3);
		this.wa = new Int16Array(nv * 3);
		this.ia = nv < 65536 ? new Uint16Array(Math.max(3, ni | 0)) : new Uint32Array(Math.max(3, ni | 0));
		this.nv = 0;
		this.ni = 0;
		this.copies = 0;
		this.min = [Infinity, Infinity, Infinity];
		this.max = [-Infinity, -Infinity, -Infinity];
	}

	need(nv, ni) {
		if ((this.nv + nv) * 3 > this.pa.length) {
			const n = Math.max(this.pa.length * 2, (this.nv + nv) * 3);
			const pa = new Float32Array(n), ca = new Uint8Array(n), wa = new Int16Array(n);
			pa.set(this.pa.subarray(0, this.nv * 3));
			ca.set(this.ca.subarray(0, this.nv * 3));
			wa.set(this.wa.subarray(0, this.nv * 3));
			this.pa = pa;
			this.ca = ca;
			this.wa = wa;
		}
		if (this.ni + ni > this.ia.length || (this.nv + nv >= 65536 && !(this.ia instanceof Uint32Array))) {
			const ia = new Uint32Array(Math.max(this.ia.length * 2, this.ni + ni));
			ia.set(this.ia.subarray(0, this.ni));
			this.ia = ia;
		}
	}

	/**
	 * A copy of template t with its origin at chunk-local (x, y, z). lev: its ground level, packed with a seed of the
	 * copy into the window style (win z = style + 8 * (lev + 128) + 2048 * seed; parts.js: snow on roofs, lit windows).
	 */
	stamp(t, x, y, z, lev = null) {
		x += this.ox;
		z += this.oz;
		this.need(t.nv, t.ni);
		const P = t.pos, pa = this.pa, o = this.nv * 3;
		for (let i = 0; i < P.length; i += 3) {
			pa[o + i] = P[i] + x;
			pa[o + i + 1] = P[i + 1] + y;
			pa[o + i + 2] = P[i + 2] + z;
		}
		this.ca.set(t.col, o);
		this.wa.set(t.win, o);
		if (lev !== null) {
			const add = 8 * (Math.max(-127, Math.min(127, lev)) + 128) + 2048 * Math.floor(hash(Math.round(x), Math.round(z), 77) * 16);
			const wa = this.wa;
			for (let i = o + 2, e = o + P.length; i < e; i += 3) {
				wa[i] = (wa[i] & 7) + add;
			}
		}
		const I = t.idx, ia = this.ia, base = this.nv;
		for (let i = 0, j = this.ni; i < I.length; i++, j++) {
			ia[j] = I[i] + base;
		}
		this.nv += t.nv;
		this.ni += t.ni;
		this.copies++;
		const mn = this.min, mx = this.max;
		if (x < mn[0]) mn[0] = x;
		if (z < mn[2]) mn[2] = z;
		if (y + t.ymin < mn[1]) mn[1] = y + t.ymin;
		if (x + t.w > mx[0]) mx[0] = x + t.w;
		if (z + t.d > mx[2]) mx[2] = z + t.d;
		if (y + t.height > mx[1]) mx[1] = y + t.height;
	}

	part(layer, material) {
		if (!this.nv) {
			return null;
		}
		const n = this.nv * 3;
		const fit = (a, k) => (a.length === k ? a : a.slice(0, k));
		let index = fit(this.ia, this.ni);
		if (this.nv < 65536 && index instanceof Uint32Array) {
			index = new Uint16Array(index);
		}
		return { type: "mesh", layer, material, position: fit(this.pa, n), color: fit(this.ca, n), win: fit(this.wa, n), index,
			sphere: sphereOf(this.min, this.max) };
	}
}

function sphereOf(mn, mx) {
	const cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2, cz = (mn[2] + mx[2]) / 2;
	const dx = mx[0] - cx, dy = mx[1] - cy, dz = mx[2] - cz;
	return [cx, cy, cz, Math.sqrt(dx * dx + dy * dy + dz * dz)];
}

/** Typed arrays of the parts, to transfer them to the main thread. */
export function transferables(parts) {
	const out = [];
	for (const p of parts) {
		for (const k of ["position", "color", "win", "tree", "index", "matrix", "owner"]) {
			if (p[k] && p[k].buffer) {
				out.push(p[k].buffer);
			}
		}
	}
	return out;
}

// --- colours --------------------------------------------------------------------------------------------

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** sRGB [0..1] triple (times k) -> linear uint8 triple for vertex colours. */
export function rgb8(rgb, k = 1) {
	return [0, 1, 2].map((i) => Math.round(toLinear(Math.min(1, Math.max(0, rgb[i] * k))) * 255));
}

/** sRGB [0..1] triple (times k) -> linear float triple for instance colours. */
export function rgbLin(rgb, k = 1) {
	return [0, 1, 2].map((i) => toLinear(Math.min(1, Math.max(0, rgb[i] * k))));
}

// --- hashes (stable look: the same square or object looks the same everywhere and every time) -------------

export function hash(a, b, c = 0) {
	let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function hashStr(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	}
	return (h >>> 0) / 4294967296;
}
