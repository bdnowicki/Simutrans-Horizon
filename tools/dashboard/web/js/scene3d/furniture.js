// Simutrans-Horizon dashboard, 3D view: the solid parts of a chunk (worker side, no three.js): one merged mesh for
// decks, platforms, sheds, wires and the like, and copies of the shapes of shapes.js. A shape with many copies in the
// chunk becomes one instanced draw call; a few copies are stamped into the merged mesh instead (fewer draw calls).
// Trees (add() with a `tree` argument) take the tree materials of sky.js: instanced per class ("tree0" evergreen,
// "tree1" deciduous, "tree2" no seasons), stamped into a mesh of their own with the vertex attribute `tree` (class +
// 4 * canopy, random, canopy shade, ground level + 128), so their season colours change in the shader.
// Artistic License, see LICENSE.txt.
import { MeshBuf, InstBuf, rgb8 } from "./meshbuf.js";
import { SHAPES } from "./shapes.js";

const INST_MIN = 96;

/** Canopy of a tree shape: its grey (tinted) vertex colours, not the coloured trunk (sky.js uses the same test). */
function canopyOf(r, g, b) {
	const lo = Math.min(r, g, b), hi = Math.max(r, g, b);
	return lo > 76 && hi - lo <= 5;
}

export class Furniture {
	constructor(origin) {
		this.origin = origin;
		this.mesh = new MeshBuf(8192, true, origin);
		this.copies = new Map(); // shape -> flat [x, y, z, sx, sy, sz, r, g, b, rot, ...]
		this.trees = new Map(); // shape -> flat [x, y, z, sx, sy, sz, r, g, b, rot, cls, rnd, lev, ...]
		this.treeMesh = null;
		this.treeAttr = null;
		this.colors = new Map(); // sRGB key -> linear uint8 triple
	}

	/** Linear uint8 colour of an sRGB triple (cached). */
	c8(rgb) {
		const k = rgb[0] * 1e6 + rgb[1] * 1e3 + rgb[2];
		let v = this.colors.get(k);
		if (!v) {
			v = rgb8(rgb);
			this.colors.set(k, v);
		}
		return v;
	}

	/**
	 * A copy of shape `key` at chunk-local (x, y, z): scaled, rotated about Y (local +X -> (cos r, -sin r)).
	 * tree: [class 0..2, random 0..1, ground level] for a tree (season colours and snow in its shader).
	 */
	add(key, x, y, z, sx, sy, sz, rgbLin, rot = 0, tree = null) {
		const map = tree ? this.trees : this.copies;
		let a = map.get(key);
		if (!a) {
			a = [];
			map.set(key, a);
		}
		a.push(x, y, z, sx, sy, sz, rgbLin[0], rgbLin[1], rgbLin[2], rot);
		if (tree) {
			a.push(tree[0], tree[1], tree[2]);
		}
	}

	/** Axis aligned box (chunk-local), top colour optional; no bottom. */
	box(x0, x1, y0, y1, z0, z1, c, top = c) {
		const m = this.mesh;
		const v = (x, y, z, col) => m.v(x, y, z, col);
		// sides: -z, +x, +z, -x (outward, counter-clockwise seen from outside)
		let a = v(x0, y0, z0, c), b = v(x0, y1, z0, c), d = v(x1, y1, z0, c), e = v(x1, y0, z0, c);
		m.quad(a, b, d, e);
		a = v(x1, y0, z0, c); b = v(x1, y1, z0, c); d = v(x1, y1, z1, c); e = v(x1, y0, z1, c);
		m.quad(a, b, d, e);
		a = v(x1, y0, z1, c); b = v(x1, y1, z1, c); d = v(x0, y1, z1, c); e = v(x0, y0, z1, c);
		m.quad(a, b, d, e);
		a = v(x0, y0, z1, c); b = v(x0, y1, z1, c); d = v(x0, y1, z0, c); e = v(x0, y0, z0, c);
		m.quad(a, b, d, e);
		a = v(x0, y1, z0, top); b = v(x0, y1, z1, top); d = v(x1, y1, z1, top); e = v(x1, y1, z0, top);
		m.quad(a, b, d, e);
	}

	/** Box with a footprint rotated about its centre (cx, cz): half sizes hx (along dir), hz, rotation as in add(). */
	obox(cx, cz, hx, hz, y0, y1, rot, c, top = c) {
		const cs = Math.cos(rot), sn = Math.sin(rot);
		const P = (lx, lz) => [cx + cs * lx + sn * lz, cz - sn * lx + cs * lz];
		const q = [P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz)];
		this.prism(q, y0, y1, c, top);
	}

	/** Vertical prism over a convex footprint (x, z pairs in any order around), no bottom. */
	prism(q, y0, y1, c, top = c) {
		const m = this.mesh;
		// make the footprint counter-clockwise seen from above (+Y normal for the roof)
		let area = 0;
		for (let i = 0; i < q.length; i++) {
			const a = q[i], b = q[(i + 1) % q.length];
			area += a[0] * b[1] - b[0] * a[1];
		}
		if (area > 0) {
			q = q.slice().reverse();
		}
		for (let i = 0; i < q.length; i++) {
			const a = q[i], b = q[(i + 1) % q.length];
			const i0 = m.v(a[0], y0, a[1], c), i1 = m.v(a[0], y1, a[1], c), i2 = m.v(b[0], y1, b[1], c), i3 = m.v(b[0], y0, b[1], c);
			m.quad(i0, i3, i2, i1);
		}
		const ids = q.map((p) => m.v(p[0], y1, p[1], top));
		for (let i = 1; i + 1 < ids.length; i++) {
			m.tri(ids[0], ids[i], ids[i + 1]);
		}
	}

	/** Parts: the merged mesh (material "solid"), the instanced shapes, the trees. */
	parts(layer) {
		const out = [];
		for (const [key, a] of this.copies) {
			const n = a.length / 10;
			if (n >= INST_MIN) {
				const ib = new InstBuf(n, this.origin);
				for (let i = 0; i < a.length; i += 10) {
					ib.add(a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5], [a[i + 6], a[i + 7], a[i + 8]], a[i + 9]);
				}
				out.push(ib.part(layer, key, "solid"));
			} else {
				this.stamp(SHAPES[key], a, 10);
			}
		}
		for (const [key, a] of this.trees) {
			const n = a.length / 13;
			if (n >= INST_MIN) {
				const ib = new InstBuf(n, this.origin);
				for (let i = 0; i < a.length; i += 13) {
					ib.add(a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5], [a[i + 6], a[i + 7], a[i + 8]], a[i + 9]);
				}
				out.push(ib.part(layer, key, "tree" + a[10]));
			} else {
				this.stampTrees(SHAPES[key], a);
			}
		}
		out.unshift(this.mesh.part(layer, "solid"));
		if (this.treeMesh) {
			const p = this.treeMesh.part(layer, "tree");
			if (p) {
				p.tree = this.treeAttr.slice(0, this.treeMesh.nv * 4);
				out.push(p);
			}
		}
		return out.filter(Boolean);
	}

	stamp(s, a, stride) {
		if (!s) {
			return;
		}
		const m = this.mesh, P = s.position, C = s.color, I = s.index;
		for (let i = 0; i < a.length; i += stride) {
			const x = a[i], y = a[i + 1], z = a[i + 2], sx = a[i + 3], sy = a[i + 4], sz = a[i + 5];
			const r = a[i + 6], g = a[i + 7], b = a[i + 8], cs = Math.cos(a[i + 9]), sn = Math.sin(a[i + 9]);
			const base = m.nv;
			for (let k = 0; k < P.length; k += 3) {
				const px = P[k] * sx, py = P[k + 1] * sy, pz = P[k + 2] * sz;
				m.vc(x + cs * px + sn * pz, y + py, z - sn * px + cs * pz, Math.round(C[k] * r), Math.round(C[k + 1] * g),
					Math.round(C[k + 2] * b));
			}
			for (let k = 0; k < I.length; k += 3) {
				m.tri(base + I[k], base + I[k + 1], base + I[k + 2]);
			}
		}
	}

	/** Trees with few copies: stamped into the tree mesh with their `tree` attribute. */
	stampTrees(s, a) {
		if (!s) {
			return;
		}
		if (!this.treeMesh) {
			this.treeMesh = new MeshBuf(4096, true, this.origin);
			this.treeAttr = new Uint8Array(4096 * 4);
		}
		const m = this.treeMesh, P = s.position, C = s.color, nv = P.length / 3;
		const before = m.nv;
		this.stamp.call({ mesh: m }, s, a, 13);
		const need = m.nv * 4;
		if (this.treeAttr.length < need) {
			const t = new Uint8Array(Math.max(need, this.treeAttr.length * 2));
			t.set(this.treeAttr);
			this.treeAttr = t;
		}
		const ta = this.treeAttr;
		let v = before;
		for (let i = 0; i < a.length; i += 13) {
			const cls = a[i + 10], rnd = Math.round(a[i + 11] * 255), lev = Math.max(0, Math.min(255, a[i + 12] + 128));
			for (let k = 0; k < nv; k++, v++) {
				const r = C[k * 3], g = C[k * 3 + 1], b = C[k * 3 + 2], can = canopyOf(r, g, b);
				const o = v * 4;
				ta[o] = cls + (can ? 4 : 0);
				ta[o + 1] = rnd;
				ta[o + 2] = can ? r : 255;
				ta[o + 3] = lev;
			}
		}
	}
}
