// Simutrans-Horizon dashboard, 3D view: low-poly shapes of repeated parts (worker side, no three.js), drawn as
// instances or stamped into a chunk mesh (furniture.js). A shape is {position: Float32Array, color: Uint8Array (linear
// RGB, normalized), index: Uint16Array}; unless noted its unit is one square, base at y = 0, centred on x = z = 0, and
// local +X is the direction an instance rotation points to. Artistic License, see LICENSE.txt.
import { rgb8 } from "./meshbuf.js";

export function shapeBuilder() {
	const pos = [], col = [];
	// convex polygon, oriented to face away from `center`
	const face = (pts, center, rgb) => {
		const [a, b, c] = pts;
		const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
		const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		let mx = 0, my = 0, mz = 0;
		for (const p of pts) {
			mx += p[0] / pts.length;
			my += p[1] / pts.length;
			mz += p[2] / pts.length;
		}
		const out = nx * (mx - center[0]) + ny * (my - center[1]) + nz * (mz - center[2]) >= 0;
		const ordered = out ? pts : pts.slice().reverse();
		const c8 = rgb8(rgb);
		for (let i = 1; i + 1 < ordered.length; i++) {
			for (const p of [ordered[0], ordered[i], ordered[i + 1]]) {
				pos.push(p[0], p[1], p[2]);
				col.push(c8[0], c8[1], c8[2]);
			}
		}
	};
	// axis aligned box without its bottom
	const box = (x0, x1, y0, y1, z0, z1, rgb, top = rgb) => {
		const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
		face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], c, rgb);
		face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], c, rgb);
		face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], c, rgb);
		face([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], c, rgb);
		face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], c, top);
	};
	const done = () => {
		const n = pos.length / 3;
		return { position: new Float32Array(pos), color: new Uint8Array(col), index: Uint16Array.from({ length: n }, (_, i) => i) };
	};
	return { face, box, done };
}

export function ring(n, r, y, phase = 0) {
	return Array.from({ length: n }, (_, i) => {
		const a = phase + (i / n) * Math.PI * 2;
		return [Math.cos(a) * r, y, Math.sin(a) * r];
	});
}

export function prism(sb, n, r0, r1, y0, y1, rgb, caps, phase = 0) {
	const lo = ring(n, r0, y0, phase), hi = ring(n, r1, y1, phase), c = [0, (y0 + y1) / 2, 0];
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		sb.face([lo[i], lo[j], hi[j], hi[i]], c, rgb);
	}
	if (caps) {
		sb.face(hi, c, rgb);
	}
}

const WHITE = [1, 1, 1];
const STEEL = [0.55, 0.57, 0.6];
const DARK = [0.22, 0.22, 0.24];

function boxShape() {
	const sb = shapeBuilder();
	sb.box(-0.5, 0.5, 0, 1, -0.5, 0.5, WHITE, [0.72, 0.72, 0.74]);
	return sb.done();
}

const TRUNK = [0.62, 0.45, 0.33];

// icosahedron around (0, cy, 0): radius r, squashed or stretched by sy, optional jitter of the vertices
function ico(sb, r, cy, sy, rgb, jitter = 0) {
	const t = (1 + Math.sqrt(5)) / 2, k = r / Math.sqrt(1 + t * t);
	const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
		[t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(([x, y, z], i) => {
		const j = 1 + jitter * Math.sin(i * 12.9898 + 4.1414);
		return [x * k * j, y * k * sy * j + cy, z * k * j];
	});
	const f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4,
		3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
	for (let i = 0; i < f.length; i += 3) {
		sb.face([v[f[i]], v[f[i + 1]], v[f[i + 2]]], [0, cy, 0], rgb);
	}
}

function cone(sb, n, r, y0, y1, rgb, base, phase = 0) {
	const ring0 = ring(n, r, y0, phase), apex = [0, y1, 0], c = [0, (y0 + y1) / 2 - (y1 - y0) * 0.2, 0];
	for (let i = 0; i < n; i++) {
		sb.face([apex, ring0[i], ring0[(i + 1) % n]], c, rgb);
	}
	if (base) {
		sb.face(ring0, [0, y1, 0], base);
	}
}

// trees: unit size about one square tall at scale 1; the canopy is white (tinted by the instance colour)
function coniferShape() {
	const sb = shapeBuilder();
	prism(sb, 3, 0.05, 0.04, 0, 0.24, TRUNK, false);
	cone(sb, 6, 0.32, 0.18, 0.8, WHITE, [0.78, 0.78, 0.78]);
	cone(sb, 5, 0.23, 0.5, 1.1, WHITE, [0.85, 0.85, 0.85], 0.3);
	return sb.done();
}

function roundShape() {
	const sb = shapeBuilder();
	prism(sb, 3, 0.05, 0.04, 0, 0.36, TRUNK, false);
	ico(sb, 0.36, 0.68, 0.9, WHITE, 0.08);
	return sb.done();
}

function birchShape() {
	const sb = shapeBuilder();
	prism(sb, 3, 0.035, 0.03, 0, 0.5, [0.95, 0.94, 0.9], false);
	ico(sb, 0.25, 0.78, 1.35, WHITE, 0.1);
	return sb.done();
}

function poplarShape() {
	const sb = shapeBuilder();
	prism(sb, 3, 0.04, 0.035, 0, 0.16, TRUNK, false);
	prism(sb, 6, 0.1, 0.15, 0.1, 0.55, WHITE, false);
	cone(sb, 6, 0.15, 0.55, 1.2, WHITE);
	sb.face(ring(6, 0.1, 0.1), [0, 1, 0], [0.8, 0.8, 0.8]);
	return sb.done();
}

function palmShape() {
	const sb = shapeBuilder();
	const top = 0.85;
	prism(sb, 4, 0.045, 0.03, 0, top, [0.7, 0.58, 0.42], false);
	for (let i = 0; i < 5; i++) {
		const a = (i / 5) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), px = -sa * 0.06, pz = ca * 0.06;
		// a frond: from the crown out and down, facing up
		sb.face([[px, top, pz], [ca * 0.42 + px * 0.3, top - 0.12, sa * 0.42 + pz * 0.3], [ca * 0.42 - px * 0.3, top - 0.12, sa * 0.42 - pz * 0.3],
			[-px, top, -pz]], [ca * 0.2, top - 1, sa * 0.2], WHITE);
	}
	return sb.done();
}

function cactusShape() {
	const sb = shapeBuilder();
	prism(sb, 4, 0.07, 0.06, 0, 0.55, WHITE, true, Math.PI / 4);
	// two arms: short prisms beside the stem (the stem hides where they would join)
	for (const [x, y0] of [[0.09, 0.2], [-0.09, 0.28]]) {
		const lo = ring(3, 0.035, y0).map((p) => [p[0] + x, p[1], p[2]]), hi = ring(3, 0.03, y0 + 0.2).map((p) => [p[0] + x, p[1], p[2]]);
		const c = [x, y0 + 0.1, 0];
		for (let i = 0; i < 3; i++) {
			sb.face([lo[i], lo[(i + 1) % 3], hi[(i + 1) % 3], hi[i]], c, WHITE);
		}
		sb.face(hi, c, WHITE);
	}
	return sb.done();
}

// bare deciduous tree (winter): trunk and four branches
function bareShape() {
	const sb = shapeBuilder();
	prism(sb, 3, 0.045, 0.03, 0, 0.5, WHITE, false);
	for (let i = 0; i < 4; i++) {
		const a = (i / 4) * Math.PI * 2 + 0.4, ca = Math.cos(a), sa = Math.sin(a), y0 = 0.3 + 0.08 * i;
		const lo = ring(3, 0.022, 0).map((p) => [p[0] + ca * 0.02, p[1] + y0, p[2] + sa * 0.02]);
		const hi = ring(3, 0.008, 0).map((p) => [p[0] + ca * 0.26, p[1] + y0 + 0.36, p[2] + sa * 0.26]);
		const c = [ca * 0.14, y0 + 0.18, sa * 0.14];
		for (let k = 0; k < 3; k++) {
			sb.face([lo[k], lo[(k + 1) % 3], hi[(k + 1) % 3], hi[k]], c, WHITE);
		}
	}
	return sb.done();
}

function shrubShape() {
	const sb = shapeBuilder();
	ico(sb, 0.3, 0.16, 0.6, WHITE, 0.15);
	return sb.done();
}

// low detail trees for zoomed out views (chunks.js swaps <key>_lo in): same size, 4-10 triangles
function octa(sb, r, cy, sy, rgb) {
	const v = [[r, cy, 0], [0, cy, r], [-r, cy, 0], [0, cy, -r]], top = [0, cy + r * sy, 0], bot = [0, cy - r * sy, 0];
	for (let i = 0; i < 4; i++) {
		sb.face([top, v[i], v[(i + 1) % 4]], [0, cy, 0], rgb);
		sb.face([bot, v[i], v[(i + 1) % 4]], [0, cy, 0], rgb);
	}
}

function lowShape(kind) {
	const sb = shapeBuilder();
	if (kind === "conifer") {
		cone(sb, 4, 0.32, 0.12, 1.1, WHITE);
	} else if (kind === "poplar") {
		cone(sb, 4, 0.16, 0.08, 1.2, WHITE);
	} else if (kind === "round") {
		octa(sb, 0.38, 0.66, 0.85, WHITE);
	} else if (kind === "birch") {
		octa(sb, 0.27, 0.78, 1.3, WHITE);
	} else if (kind === "shrub") {
		octa(sb, 0.3, 0.16, 0.6, WHITE);
	} else if (kind === "cactus") {
		prism(sb, 4, 0.07, 0.06, 0, 0.55, WHITE, false, Math.PI / 4);
	} else if (kind === "palm") {
		prism(sb, 3, 0.04, 0.03, 0, 0.85, [0.7, 0.58, 0.42], false);
		sb.face([[-0.4, 0.75, 0], [0, 0.86, -0.05], [0.4, 0.75, 0], [0, 0.86, 0.05]], [0, 0, 0], WHITE);
		sb.face([[0, 0.75, -0.4], [0.05, 0.86, 0], [0, 0.75, 0.4], [-0.05, 0.86, 0]], [0, 0, 0], WHITE);
	} else {
		prism(sb, 3, 0.045, 0.03, 0, 0.5, WHITE, false);
		sb.face([[0, 0.3, -0.02], [0, 0.3, 0.02], [0.24, 0.7, 0]], [0, 0.5, -1], WHITE);
		sb.face([[0, 0.38, -0.02], [0, 0.38, 0.02], [-0.22, 0.75, 0.05]], [0, 0.5, 1], WHITE);
	}
	return sb.done();
}

// rock: a lumpy stone, unit size, base at y = 0 (sunk a little)
function rockShape() {
	const sb = shapeBuilder();
	ico(sb, 0.5, 0.12, 0.55, WHITE, 0.22);
	return sb.done();
}

// bridge pillar: unit footprint, unit height (scaled per instance), tapered, with a cap
function pillarShape() {
	const sb = shapeBuilder();
	const c = [0, 0.5, 0];
	const lo = 0.5, hi = 0.4;
	const p = [[-lo, 0, -lo], [lo, 0, -lo], [lo, 0, lo], [-lo, 0, lo]], q = [[-hi, 0.92, -hi], [hi, 0.92, -hi], [hi, 0.92, hi], [-hi, 0.92, hi]];
	for (let i = 0; i < 4; i++) {
		sb.face([p[i], p[(i + 1) % 4], q[(i + 1) % 4], q[i]], c, WHITE);
	}
	sb.box(-0.55, 0.55, 0.92, 1, -0.55, 0.55, [0.9, 0.9, 0.9]);
	return sb.done();
}

// column of elevated ways: octagonal, unit radius 0.5, unit height
function columnShape() {
	const sb = shapeBuilder();
	prism(sb, 6, 0.5, 0.42, 0, 1, WHITE, true, Math.PI / 6);
	return sb.done();
}

// catenary mast in squares: pole at the origin, cantilever along +X to the contact wire (x = 0.3)
function mastShape() {
	const sb = shapeBuilder();
	sb.box(-0.014, 0.014, 0, 0.56, -0.014, 0.014, STEEL);
	sb.box(0, 0.33, 0.5, 0.515, -0.006, 0.006, STEEL);
	sb.box(0, 0.33, 0.44, 0.45, -0.005, 0.005, STEEL);
	return sb.done();
}

// power line pylon in squares: tapered lattice tower (shown solid), cross arms along X
function pylonShape() {
	const sb = shapeBuilder();
	const c = [0, 0.5, 0], rgb = [0.62, 0.63, 0.64];
	const lo = 0.11, hi = 0.03, top = 1.05;
	const p = [[-lo, 0, -lo], [lo, 0, -lo], [lo, 0, lo], [-lo, 0, lo]], q = [[-hi, top, -hi], [hi, top, -hi], [hi, top, hi], [-hi, top, hi]];
	for (let i = 0; i < 4; i++) {
		sb.face([p[i], p[(i + 1) % 4], q[(i + 1) % 4], q[i]], c, rgb);
	}
	sb.face(q, c, rgb);
	sb.box(-0.3, 0.3, 0.8, 0.83, -0.02, 0.02, rgb);
	sb.box(-0.22, 0.22, 0.95, 0.98, -0.02, 0.02, rgb);
	for (const [x, y] of [[-0.28, 0.8], [0.28, 0.8], [-0.2, 0.95], [0.2, 0.95]]) {
		sb.box(x - 0.008, x + 0.008, y - 0.05, y, -0.008, 0.008, [0.35, 0.4, 0.45]);
	}
	return sb.done();
}

// signal in squares: pole and a head facing +X (towards the vehicles it stops)
function signalShape() {
	const sb = shapeBuilder();
	sb.box(-0.012, 0.012, 0, 0.36, -0.012, 0.012, [0.45, 0.45, 0.47]);
	sb.box(-0.02, 0.02, 0.28, 0.42, -0.03, 0.03, DARK);
	return sb.done();
}

// lamp of a signal (instance colour = the signal state), sits on the +X face of the head
function lampShape() {
	const sb = shapeBuilder();
	sb.box(0.018, 0.03, 0.37, 0.4, -0.016, 0.016, WHITE);
	return sb.done();
}

// road sign in squares: pole and a plate facing +X
function signShape() {
	const sb = shapeBuilder();
	sb.box(-0.01, 0.01, 0, 0.3, -0.01, 0.01, [0.6, 0.6, 0.62]);
	sb.box(-0.004, 0.006, 0.22, 0.32, -0.05, 0.05, WHITE);
	return sb.done();
}

// bus shelter in squares: along X, open towards +Z (the road), back wall at -Z
function shelterShape() {
	const sb = shapeBuilder();
	const glass = [0.62, 0.72, 0.78], frame = [0.42, 0.44, 0.48], roof = [0.7, 0.72, 0.74];
	sb.box(-0.17, 0.17, 0.02, 0.2, -0.065, -0.055, glass);
	sb.box(-0.17, -0.16, 0, 0.2, -0.065, 0.06, frame);
	sb.box(0.16, 0.17, 0, 0.2, -0.065, 0.06, frame);
	sb.box(-0.19, 0.19, 0.2, 0.215, -0.08, 0.08, roof);
	return sb.done();
}

// buffer stop at a track end, facing +X
function bufferShape() {
	const sb = shapeBuilder();
	sb.box(-0.03, 0.03, 0, 0.07, -0.13, 0.13, [0.75, 0.2, 0.15]);
	sb.box(0.03, 0.045, 0.03, 0.06, -0.11, 0.11, [0.9, 0.9, 0.88]);
	return sb.done();
}

// level crossing barrier: post, boom along +Z
function barrierShape() {
	const sb = shapeBuilder();
	sb.box(-0.015, 0.015, 0, 0.16, -0.015, 0.015, [0.85, 0.85, 0.85]);
	for (let i = 0; i < 4; i++) {
		sb.box(-0.008, 0.008, 0.13, 0.15, 0.02 + i * 0.07, 0.09 + i * 0.07, i % 2 ? [0.95, 0.95, 0.95] : [0.85, 0.12, 0.1]);
	}
	return sb.done();
}

// tank: unit radius 0.5, unit height
function tankShape() {
	const sb = shapeBuilder();
	prism(sb, 10, 0.5, 0.5, 0, 0.94, WHITE, false);
	prism(sb, 10, 0.5, 0.25, 0.94, 1, [0.85, 0.85, 0.85], true);
	return sb.done();
}

// lamp post / light mast in squares
function lightShape() {
	const sb = shapeBuilder();
	sb.box(-0.008, 0.008, 0, 0.3, -0.008, 0.008, [0.4, 0.4, 0.42]);
	sb.box(-0.01, 0.05, 0.29, 0.305, -0.012, 0.012, [0.95, 0.92, 0.75]);
	return sb.done();
}

export const SHAPES = {
	box: boxShape(), tree_conifer: coniferShape(), tree_round: roundShape(), tree_birch: birchShape(),
	tree_poplar: poplarShape(), tree_palm: palmShape(), tree_cactus: cactusShape(), tree_shrub: shrubShape(), tree_bare: bareShape(), rock: rockShape(),
	tree_conifer_lo: lowShape("conifer"), tree_round_lo: lowShape("round"), tree_birch_lo: lowShape("birch"), tree_poplar_lo: lowShape("poplar"),
	tree_palm_lo: lowShape("palm"), tree_cactus_lo: lowShape("cactus"), tree_shrub_lo: lowShape("shrub"), tree_bare_lo: lowShape("bare"),
	pillar: pillarShape(), column: columnShape(), mast: mastShape(), pylon: pylonShape(), signal: signalShape(),
	lamp: lampShape(), sign: signShape(), shelter: shelterShape(), buffer: bufferShape(), barrier: barrierShape(),
	tank: tankShape(), light: lightShape(),
};
