// Simutrans-Horizon dashboard, 3D view: generated vehicle bodies (no three.js). classify() picks a body for a pak
// vehicle from its desc (way type, length, power, freight and its goods category, capacity, name keywords: the
// "vehicles" section of gen/rules.json, a pak 3D may override it); buildShape() makes the low-poly geometry of a
// body once. Shapes are drawn as instances: local +X = forward, Y up, Z across, base at y = 0, centred on x = z = 0.
// Bodies with scale "x" are built one square long (the instance scales X to the car's length, Y and Z keep their
// size in squares); "xyz" bodies (ships, aircraft) are built one unit long with proportional width and height and
// scaled uniformly; "1" bodies (pedestrians) keep their size. Every vertex has a colour (linear) and a tint 0..1:
// the drawn colour is mix(colour, colour * instance colour, tint), so the company colour paints only the tinted
// panels. Artistic License, see LICENSE.txt.
import { rgb8 } from "../meshbuf.js";

// --- geometry -------------------------------------------------------------------------------------------------

class VBuf {
	constructor() {
		this.pos = [];
		this.col = [];
		this.tint = [];
	}

	/** Convex polygon, oriented to face away from `center`. */
	face(pts, center, rgb, tint = 0) {
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
		const o = out ? pts : pts.slice().reverse();
		const c8 = rgb8(rgb), t8 = Math.round(Math.max(0, Math.min(1, tint)) * 255);
		for (let i = 1; i + 1 < o.length; i++) {
			for (const p of [o[0], o[i], o[i + 1]]) {
				this.pos.push(p[0], p[1], p[2]);
				this.col.push(c8[0], c8[1], c8[2]);
				this.tint.push(t8);
			}
		}
	}

	/** Axis aligned box. c: colour of all faces or {side, top, end, bottom}; t: tint or {side, top, end}. */
	box(x0, x1, y0, y1, z0, z1, c, t = 0, bottom = false) {
		const col = (k) => (Array.isArray(c) ? c : c[k] || c.side);
		const tin = (k) => (typeof t === "number" ? t : t[k] ?? t.side ?? 0);
		const m = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
		this.face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], m, col("side"), tin("side"));
		this.face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], m, col("side"), tin("side"));
		this.face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], m, col("end"), tin("end"));
		this.face([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], m, col("end"), tin("end"));
		this.face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], m, col("top"), tin("top"));
		if (bottom) {
			this.face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], m, col("bottom"), tin("bottom"));
		}
	}

	/**
	 * Loft along X between profile a at xa and profile b at xb (lists of [z, y], convex, same length; a profile may
	 * shrink to one point). c(i)/t(i): colour/tint of the side between point i and i + 1 (or values). Caps optional.
	 */
	loft(xa, a, xb, b, c, t = 0, capA = true, capB = true, capC) {
		const n = a.length, col = typeof c === "function" ? c : () => c, tin = typeof t === "function" ? t : () => t;
		let cz = 0, cy = 0;
		for (let i = 0; i < n; i++) {
			cz += (a[i][0] + b[i][0]) / (2 * n);
			cy += (a[i][1] + b[i][1]) / (2 * n);
		}
		const m = [(xa + xb) / 2, cy, cz];
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const q = [[xa, a[i][1], a[i][0]], [xa, a[j][1], a[j][0]], [xb, b[j][1], b[j][0]], [xb, b[i][1], b[i][0]]];
			if (Math.hypot(q[0][1] - q[1][1], q[0][2] - q[1][2]) < 1e-6 && Math.hypot(q[2][1] - q[3][1], q[2][2] - q[3][2]) < 1e-6) {
				continue;
			}
			this.face(degenerate(q) ? [q[0], q[1], q[2]] : q, m, col(i), tin(i));
		}
		const capCol = capC || col(0);
		if (capA && spread(a)) {
			this.face(a.map((p) => [xa, p[1], p[0]]), m, capCol, tin(0));
		}
		if (capB && spread(b)) {
			this.face(b.map((p) => [xb, p[1], p[0]]), m, capCol, tin(0));
		}
	}

	/** Prism along X with a constant profile. */
	extrude(x0, x1, prof, c, t = 0, caps = true, capC) {
		this.loft(x0, prof, x1, prof, c, t, caps, caps, capC);
	}

	done(scale, extra) {
		return Object.assign({ position: new Float32Array(this.pos), color: new Uint8Array(this.col), tint: new Uint8Array(this.tint),
			scale }, extra || {});
	}
}

function degenerate(q) {
	const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	return d(q[2], q[3]) < 1e-6 || d(q[0], q[3]) < 1e-6;
}

function spread(p) {
	return p.some((q) => Math.hypot(q[0] - p[0][0], q[1] - p[0][1]) > 1e-6);
}

/** Polygon profile [z, y] of n points on an ellipse around (0, cy). */
function ellipse(n, rz, ry, cy, phase = 0) {
	return Array.from({ length: n }, (_, i) => {
		const a = phase + (i / n) * Math.PI * 2;
		return [Math.cos(a) * rz, cy + Math.sin(a) * ry];
	});
}

/** Body profile: straight sides from y0 to y1, roof rounded towards the centre. */
function bodyProfile(hw, y0, y1, roof = 0.03, inset = 0.25) {
	return [[-hw, y0], [hw, y0], [hw, y1], [hw * (1 - inset), y1 + roof], [-hw * (1 - inset), y1 + roof], [-hw, y1]];
}

const scaleProf = (p, kz, ky, cy) => p.map(([z, y]) => [z * kz, cy + (y - cy) * ky]);

// --- colours (sRGB) ---------------------------------------------------------------------------------------------

const WHITE = [1, 1, 1];
const GLASS = [0.11, 0.14, 0.18];
const ROOF = [0.55, 0.56, 0.58];
const DARK = [0.15, 0.15, 0.16];
const STEEL = [0.48, 0.5, 0.53];
const SILVER = [0.76, 0.77, 0.79];
const CREAM = [0.93, 0.91, 0.85];
const LOAD = [0.17, 0.16, 0.15];
const WOOD = [0.52, 0.37, 0.22];
const RUST = [0.55, 0.3, 0.2];
const BLUEBOX = [0.2, 0.35, 0.55];
const TANKBLACK = [0.2, 0.2, 0.22];
const SKIN = [0.86, 0.68, 0.55];
const HULLRED = [0.5, 0.16, 0.13];
const DECK = [0.36, 0.4, 0.36];

// --- rail and road parts ----------------------------------------------------------------------------------------

const RAIL = { hw: 0.125, floor: 0.07, top: 0.245 }; // standard track (gauge rails at +-0.1)
const ROAD = { hw: 0.07, floor: 0.03, top: 0.18 };

function bogies(v, hw) {
	for (const x of [-0.3, 0.3]) {
		v.box(x - 0.09, x + 0.09, 0.012, 0.065, -hw * 0.75, hw * 0.75, DARK);
	}
	v.box(-0.47, 0.47, 0.055, RAIL.floor, -hw * 0.92, hw * 0.92, DARK);
}

/** Wheels at the fractions xs of the length: rx half their length (of the unit length), h their height (squares). */
function wheels(v, hw, xs, rx = 0.04, h = 0.04) {
	for (const x of xs) {
		v.box(x - rx, x + rx, 0, h, -hw - 0.004, hw + 0.004, DARK);
	}
}

/** Passenger body with a window band between wy0 and wy1; ends "flat" or a cab nose at +X ("nose"). */
function coachBody(v, d, opts = {}) {
	const { hw, floor, top } = d;
	const wy0 = floor + (top - floor) * (opts.wy0 ?? 0.45), wy1 = floor + (top - floor) * (opts.wy1 ?? 0.86);
	const x0 = -0.48, x1 = opts.nose ? 0.36 : 0.48;
	const band = opts.band || GLASS;
	v.box(x0, x1, floor, wy0, -hw, hw, WHITE, 1);
	v.box(x0, x1, wy0, wy1, -hw, hw, { side: band, end: WHITE }, { side: 0, end: 1 });
	const roofProf = [[-hw, wy1], [hw, wy1], [hw, top], [hw * 0.72, top + 0.03], [-hw * 0.72, top + 0.03], [-hw, top]];
	v.extrude(x0, x1, roofProf, (i) => (i >= 2 && i <= 4 ? ROOF : WHITE), (i) => (i >= 2 && i <= 4 ? 0 : 1));
	if (opts.nose) {
		const a = [[-hw, floor], [hw, floor], [hw, top], [hw * 0.72, top + 0.03], [-hw * 0.72, top + 0.03], [-hw, top]];
		const b = [[-hw * 0.8, floor], [hw * 0.8, floor], [hw * 0.78, floor + (top - floor) * 0.5], [hw * 0.45, top - 0.01],
			[-hw * 0.45, top - 0.01], [-hw * 0.78, floor + (top - floor) * 0.5]];
		v.loft(x1, a, 0.49, b, (i) => (i >= 2 && i <= 4 ? GLASS : WHITE), (i) => (i >= 2 && i <= 4 ? 0 : 1), false, true);
	}
}

/** Freight loads and bodies between x0 and x1 on a floor at y0, up to y1 (half width hw). */
function cargo(v, kind, x0, x1, hw, y0, y1) {
	const len = x1 - x0, xm = (x0 + x1) / 2;
	switch (kind) {
		case "tank": {
			const r = Math.min(hw * 0.92, (y1 - y0) * 0.5);
			v.extrude(x0 + 0.01, x1 - 0.01, ellipse(8, r, r, y0 + r + 0.005, Math.PI / 8), TANKBLACK, 0, true, STEEL);
			v.box(xm - 0.04, xm + 0.04, y0 + 2 * r, y0 + 2 * r + 0.02, -0.03, 0.03, STEEL);
			v.box(x0, x1, y0 - 0.012, y0, -hw, hw, WHITE, 1);
			break;
		}
		case "open": {
			const h = (y1 - y0) * 0.62, w = 0.012;
			v.box(x0, x1, y0, y0 + h, -hw, -hw + w, WHITE, 1);
			v.box(x0, x1, y0, y0 + h, hw - w, hw, WHITE, 1);
			v.box(x0, x0 + w, y0, y0 + h, -hw, hw, WHITE, 1);
			v.box(x1 - w, x1, y0, y0 + h, -hw, hw, WHITE, 1);
			const a = [[-hw + w, y0 + h * 0.75], [hw - w, y0 + h * 0.75], [hw * 0.4, y0 + h * 1.05], [-hw * 0.4, y0 + h * 1.05]];
			v.extrude(x0 + w, x1 - w, a, LOAD, 0);
			break;
		}
		case "covered": {
			const prof = [[-hw * 0.55, y0], [hw * 0.55, y0], [hw, y0 + (y1 - y0) * 0.35], [hw, y1 - 0.02], [hw * 0.6, y1 + 0.01],
				[-hw * 0.6, y1 + 0.01], [-hw, y1 - 0.02], [-hw, y0 + (y1 - y0) * 0.35]];
			v.extrude(x0 + 0.01, x1 - 0.01, prof, (i) => (i === 4 ? ROOF : CREAM), (i) => (i === 4 ? 0 : 0.55));
			break;
		}
		case "reefer":
			v.box(x0, x1, y0, y0 + 0.02, -hw, hw, WHITE, 1);
			v.box(x0, x1, y0 + 0.02, y1, -hw, hw, { side: CREAM, top: SILVER, end: CREAM }, 0);
			break;
		case "stake": {
			const r = Math.min(hw * 0.38, (y1 - y0) * 0.22);
			for (const [z, y] of [[-hw * 0.48, y0 + r], [hw * 0.48, y0 + r], [0, y0 + r * 2.7]]) {
				v.extrude(x0 + 0.02, x1 - 0.02, ellipse(6, r, r, 0).map(([a, b]) => [a + z, b + y]), WOOD, 0, true, [0.76, 0.62, 0.42]);
			}
			for (const x of [x0 + 0.04, xm, x1 - 0.04]) {
				v.box(x - 0.008, x + 0.008, y0, y0 + r * 4, -hw, -hw + 0.012, WHITE, 1);
				v.box(x - 0.008, x + 0.008, y0, y0 + r * 4, hw - 0.012, hw, WHITE, 1);
			}
			break;
		}
		case "steel":
			for (const x of [x0 + len * 0.22, xm, x1 - len * 0.22]) {
				const r = Math.min(hw * 0.7, (y1 - y0) * 0.32);
				v.loft(x - len * 0.09, ellipse(8, r, r, y0 + r), x + len * 0.09, ellipse(8, r, r, y0 + r), SILVER, 0);
			}
			v.box(x0, x1, y0 - 0.012, y0, -hw, hw, WHITE, 1);
			break;
		case "container": {
			const n = len > 0.6 ? 2 : 1, gap = 0.02, cl = (len - gap * (n + 1)) / n;
			for (let k = 0; k < n; k++) {
				const a = x0 + gap + k * (cl + gap);
				const c = k === 0 ? WHITE : (len > 0.6 ? BLUEBOX : RUST), t = k === 0 ? 1 : 0;
				v.box(a, a + cl, y0, y0 + (y1 - y0) * 0.92, -hw * 0.95, hw * 0.95, c, t);
			}
			break;
		}
		case "autos": {
			const deck = y0 + (y1 - y0) * 0.5;
			v.box(x0, x1, deck - 0.008, deck, -hw, hw, STEEL);
			v.box(x0, x1, y1 - 0.01, y1, -hw, hw, WHITE, 1);
			for (const x of [x0 + 0.01, x1 - 0.02]) {
				v.box(x, x + 0.01, y0, y1, -hw, hw, WHITE, 1);
			}
			const cars = Math.max(1, Math.round(len / 0.3));
			const cc = [[0.75, 0.2, 0.18], [0.2, 0.3, 0.6], [0.85, 0.85, 0.82], [0.3, 0.3, 0.32]];
			for (let k = 0; k < cars; k++) {
				const a = x0 + 0.03 + (k * (len - 0.06)) / cars, b = a + (len - 0.06) / cars - 0.02;
				v.box(a, b, y0, y0 + (deck - y0) * 0.55, -hw * 0.7, hw * 0.7, cc[k % 4]);
				v.box(a, b, deck, deck + (y1 - deck) * 0.55, -hw * 0.7, hw * 0.7, cc[(k + 2) % 4]);
			}
			break;
		}
		case "flat":
			v.box(x0 + 0.03, x1 - 0.03, y0, y0 + (y1 - y0) * 0.5, -hw * 0.85, hw * 0.85, [0.42, 0.47, 0.38], 0);
			break;
		default: // "box"
			v.box(x0, x1, y0, y1, -hw, hw, { side: WHITE, end: WHITE, top: ROOF }, { side: 1, end: 1, top: 0 });
			v.box(xm - 0.07, xm + 0.07, y0 + 0.01, y1 - 0.015, -hw - 0.003, hw + 0.003, DARK, 0);
	}
}

// --- rail ---------------------------------------------------------------------------------------------------------

function railCoach(nose, mail) {
	const v = new VBuf();
	bogies(v, RAIL.hw);
	coachBody(v, RAIL, mail ? { band: CREAM, wy0: 0.55, wy1: 0.66, nose } : { nose });
	if (nose) {
		v.box(-0.1, 0.1, RAIL.top + 0.03, RAIL.top + 0.045, -0.04, 0.04, DARK); // pantograph
	}
	return v.done("x");
}

function railLocoElectric() {
	const v = new VBuf(), { hw, floor, top } = RAIL;
	bogies(v, hw);
	v.box(-0.46, 0.46, floor, top, -hw, hw, { side: WHITE, end: WHITE, top: ROOF }, { side: 1, end: 1, top: 0 });
	const wy0 = floor + (top - floor) * 0.55, wy1 = top - 0.025;
	for (const s of [-1, 1]) {
		v.box(s > 0 ? 0.3 : -0.47, s > 0 ? 0.47 : -0.3, wy0, wy1, -hw - 0.003, hw + 0.003, { side: GLASS, end: GLASS, top: GLASS }, 0);
	}
	v.box(-0.44, 0.44, floor + 0.04, floor + 0.055, -hw - 0.002, hw + 0.002, CREAM, 0);
	for (const x of [-0.22, 0.22]) {
		v.box(x - 0.08, x + 0.08, top + 0.03, top + 0.04, -0.012, 0.012, DARK);
		v.box(x - 0.01, x + 0.01, top, top + 0.03, -0.012, 0.012, DARK);
	}
	return v.done("x");
}

function railLocoDiesel() {
	const v = new VBuf(), { hw, floor, top } = RAIL;
	bogies(v, hw);
	v.box(-0.47, 0.47, floor, floor + 0.02, -hw, hw, DARK);
	v.box(-0.46, 0.2, floor + 0.02, top - 0.04, -hw * 0.72, hw * 0.72, { side: WHITE, end: WHITE, top: ROOF }, { side: 1, end: 1, top: 0 });
	v.box(0.2, 0.4, floor + 0.02, top, -hw, hw, { side: WHITE, end: WHITE, top: ROOF }, { side: 1, end: 1, top: 0 });
	v.box(0.21, 0.405, top - 0.075, top - 0.02, -hw - 0.003, hw + 0.003, GLASS, 0);
	v.box(0.4, 0.47, floor + 0.02, floor + 0.09, -hw * 0.72, hw * 0.72, WHITE, 1);
	v.box(-0.3, -0.12, top - 0.04, top - 0.025, -0.03, 0.03, DARK);
	return v.done("x");
}

function railLocoSteam() {
	const v = new VBuf(), { hw, floor } = RAIL;
	v.box(-0.47, 0.47, 0.05, floor, -hw * 0.9, hw * 0.9, DARK);
	wheels(v, hw * 0.9, [-0.28, -0.08, 0.12], 0.075, 0.075);
	wheels(v, hw * 0.9, [0.36], 0.045, 0.045);
	const r = 0.075, cy = floor + r + 0.012;
	v.extrude(-0.14, 0.44, ellipse(8, r, r, cy, Math.PI / 8), [0.16, 0.16, 0.17], 0, true, [0.1, 0.1, 0.1]);
	v.box(0.34, 0.4, cy + r - 0.01, cy + r + 0.06, -0.022, 0.022, [0.1, 0.1, 0.1]);
	v.box(0.12, 0.2, cy + r - 0.01, cy + r + 0.03, -0.03, 0.03, [0.3, 0.3, 0.3]);
	v.box(-0.46, -0.14, floor, 0.25, -hw, hw, { side: WHITE, end: WHITE, top: DARK }, { side: 1, end: 1, top: 0 });
	v.box(-0.4, -0.2, 0.17, 0.225, -hw - 0.003, hw + 0.003, GLASS, 0);
	v.box(0.4, 0.47, floor, floor + 0.04, -hw * 0.9, hw * 0.9, [0.6, 0.15, 0.12]);
	return v.done("x");
}

function railFreight(kind) {
	const v = new VBuf();
	bogies(v, RAIL.hw);
	cargo(v, kind, -0.47, 0.47, RAIL.hw, RAIL.floor, RAIL.top);
	return v.done("x");
}

function tramCar() {
	const v = new VBuf(), d = { hw: 0.1, floor: 0.035, top: 0.205 };
	for (const x of [-0.3, 0.3]) {
		v.box(x - 0.07, x + 0.07, 0.005, 0.04, -0.07, 0.07, DARK);
	}
	coachBody(v, d, { wy0: 0.38, wy1: 0.85 });
	v.box(-0.08, 0.08, d.top + 0.03, d.top + 0.042, -0.035, 0.035, DARK);
	v.box(-0.005, 0.005, d.top, d.top + 0.03, -0.01, 0.01, DARK);
	return v.done("x");
}

/** Monorail and maglev cars: a rounded body above the beam, a long nose on head cars. */
function sleekCar(head, maglev) {
	const v = new VBuf();
	const hw = maglev ? 0.13 : 0.1, floor = maglev ? 0.075 : 0.085, top = maglev ? 0.24 : 0.235;
	const prof = [[-hw, floor], [hw, floor], [hw, top - 0.06], [hw * 0.8, top], [-hw * 0.8, top], [-hw, top - 0.06]];
	const band = (i) => (i === 2 || i === 4 ? GLASS : WHITE), bt = (i) => (i === 2 || i === 4 ? 0 : 1);
	const x1 = head ? 0.2 : 0.48;
	v.extrude(-0.48, x1, prof, (i) => (i === 3 ? ROOF : band(i)), (i) => (i === 3 ? 0 : bt(i)), true, WHITE);
	if (head) {
		const tip = [[-hw * 0.25, floor + 0.01], [hw * 0.25, floor + 0.01], [hw * 0.22, floor + 0.04], [hw * 0.1, floor + 0.05],
			[-hw * 0.1, floor + 0.05], [-hw * 0.22, floor + 0.04]];
		v.loft(x1, prof, 0.49, tip, (i) => (i >= 2 && i <= 4 ? GLASS : WHITE), (i) => (i >= 2 && i <= 4 ? 0 : 1), false, true);
	}
	// skirts over the beam (monorail) or the guideway (maglev)
	const sw = maglev ? 0.17 : 0.075;
	v.box(-0.46, head ? 0.3 : 0.46, floor - 0.04, floor, -sw, -sw + 0.02, DARK);
	v.box(-0.46, head ? 0.3 : 0.46, floor - 0.04, floor, sw - 0.02, sw, DARK);
	return v.done("x");
}

// --- road ---------------------------------------------------------------------------------------------------------

function bus() {
	const v = new VBuf(), { hw, floor } = ROAD, top = 0.19;
	wheels(v, hw, [-0.3, 0.32], 0.05, 0.035);
	v.box(-0.48, 0.48, floor, floor + 0.06, -hw, hw, WHITE, 1);
	v.box(-0.48, 0.48, floor + 0.06, top - 0.025, -hw, hw, { side: GLASS, end: GLASS }, 0);
	v.box(-0.48, 0.48, top - 0.025, top, -hw, hw, { side: WHITE, end: WHITE, top: CREAM }, { side: 1, end: 1, top: 0 });
	return v.done("x");
}

function cab(v, x0, x1, top) {
	const { hw, floor } = ROAD;
	v.box(x0, x1, floor, top, -hw, hw, { side: WHITE, end: WHITE, top: WHITE }, 1);
	v.box(x1 - (x1 - x0) * 0.45, x1 + 0.003, top - 0.055, top - 0.012, -hw - 0.003, hw + 0.003, GLASS, 0);
}

function truck(kind, powered) {
	const v = new VBuf(), { hw } = ROAD;
	const bed = 0.045;
	v.box(-0.47, 0.47, 0.026, bed, -hw * 0.8, hw * 0.8, DARK);
	if (powered) {
		wheels(v, hw, [-0.32, -0.16, 0.34], 0.05, 0.035);
		cab(v, 0.27, 0.48, 0.16);
		if (kind !== "none") {
			cargo(v, kind, -0.48, 0.24, hw, bed, ROAD.top);
		}
	} else {
		wheels(v, hw, [-0.3, -0.14, 0.3], 0.05, 0.035);
		cargo(v, kind === "none" ? "flat" : kind, -0.48, 0.48, hw, bed, ROAD.top);
	}
	return v.done("x");
}

function van() {
	const v = new VBuf(), { hw, floor } = ROAD;
	wheels(v, hw, [-0.3, 0.3], 0.05, 0.035);
	v.box(-0.48, 0.2, floor, 0.17, -hw, hw, { side: WHITE, end: WHITE, top: CREAM }, { side: 1, end: 1, top: 0 });
	cab(v, 0.2, 0.48, 0.14);
	return v.done("x");
}

function car(kindVan) {
	const v = new VBuf(), hw = 0.045;
	wheels(v, hw, [-0.3, 0.3], 0.08, 0.022);
	if (kindVan) {
		v.box(-0.48, 0.48, 0.02, 0.1, -hw, hw, WHITE, 1);
		v.box(0.2, 0.485, 0.06, 0.092, -hw - 0.002, hw + 0.002, GLASS, 0);
		return v.done("x");
	}
	v.box(-0.48, 0.48, 0.015, 0.045, -hw, hw, WHITE, 1);
	const a = [[-hw, 0.045], [hw, 0.045], [hw * 0.8, 0.078], [-hw * 0.8, 0.078]];
	v.loft(-0.3, a, 0.22, a, (i) => (i === 2 ? WHITE : GLASS), (i) => (i === 2 ? 1 : 0), true, true, GLASS);
	return v.done("x");
}

function pedestrian() {
	const v = new VBuf();
	v.box(-0.008, 0.008, 0, 0.045, -0.014, 0.014, [0.2, 0.22, 0.3]);
	v.box(-0.01, 0.01, 0.045, 0.085, -0.017, 0.017, WHITE, 1);
	v.box(-0.008, 0.008, 0.085, 0.105, -0.009, 0.009, SKIN);
	return v.done("1");
}

// --- water --------------------------------------------------------------------------------------------------------

function hull(v, hw, h, bowAt = 0.3) {
	const prof = [[-hw * 0.7, 0], [hw * 0.7, 0], [hw, h], [-hw, h]];
	v.extrude(-0.5, bowAt, prof, (i) => (i === 2 ? DECK : i === 0 ? HULLRED : WHITE), (i) => (i === 1 || i === 3 ? 1 : 0), false);
	v.face([[-0.5, 0, -hw * 0.7], [-0.5, 0, hw * 0.7], [-0.5, h, hw], [-0.5, h, -hw]], [0, h / 2, 0], WHITE, 1);
	const tip = [[0, h * 0.25], [0, h * 0.25], [0.004, h * 1.15], [-0.004, h * 1.15]];
	v.loft(bowAt, prof, 0.5, tip, (i) => (i === 2 ? DECK : i === 0 ? HULLRED : WHITE), (i) => (i === 1 || i === 3 ? 1 : 0), false, false);
}

function ship(kind) {
	const v = new VBuf();
	const hw = kind === "tug" ? 0.16 : 0.12, h = kind === "barge" ? 0.05 : 0.07;
	hull(v, hw, h, kind === "barge" ? 0.42 : 0.3);
	const sup = (x0, x1, y1, w = hw * 0.8) => {
		v.box(x0, x1, h, y1, -w, w, { side: WHITE, end: WHITE, top: CREAM }, 0);
		v.box(x0 + 0.005, x1 - 0.005, y1 - 0.025, y1 - 0.01, -w - 0.002, w + 0.002, GLASS, 0);
	};
	switch (kind) {
		case "tanker":
			sup(-0.48, -0.32, h + 0.13);
			v.box(-0.43, -0.39, h + 0.13, h + 0.17, -0.025, 0.025, WHITE, 1);
			v.extrude(-0.3, 0.32, ellipse(6, 0.02, 0.02, h + 0.02), [0.62, 0.3, 0.2], 0);
			for (let x = -0.24; x < 0.3; x += 0.13) {
				v.box(x, x + 0.03, h, h + 0.035, -0.04, 0.04, STEEL);
			}
			break;
		case "container":
			sup(-0.48, -0.36, h + 0.15);
			for (let x = -0.33, k = 0; x < 0.3; x += 0.105, k++) {
				const c = [[0.62, 0.22, 0.17], [0.2, 0.35, 0.58], WHITE, [0.85, 0.6, 0.2], [0.3, 0.52, 0.35]][k % 5];
				v.box(x, x + 0.095, h, h + 0.07 + (k % 2) * 0.025, -hw * 0.85, hw * 0.85, c, c === WHITE ? 1 : 0);
			}
			break;
		case "ferry":
			v.box(-0.42, 0.3, h, h + 0.06, -hw * 0.9, hw * 0.9, { side: GLASS, end: WHITE, top: CREAM }, 0);
			v.box(-0.36, 0.22, h + 0.06, h + 0.11, -hw * 0.75, hw * 0.75, { side: GLASS, end: WHITE, top: WHITE }, 0);
			v.box(-0.2, -0.12, h + 0.11, h + 0.16, -0.025, 0.025, WHITE, 1);
			break;
		case "tug":
			sup(-0.15, 0.15, h + 0.12, hw * 0.6);
			v.box(-0.08, -0.02, h + 0.12, h + 0.17, -0.02, 0.02, WHITE, 1);
			break;
		case "barge":
			v.box(-0.45, 0.4, h, h + 0.03, -hw * 0.85, hw * 0.85, LOAD, 0);
			break;
		case "bulk":
			sup(-0.48, -0.34, h + 0.13);
			for (let x = -0.3; x < 0.3; x += 0.12) {
				v.box(x, x + 0.09, h, h + 0.02, -hw * 0.75, hw * 0.75, [0.55, 0.3, 0.2]);
			}
			break;
		default: // general cargo
			sup(-0.48, -0.34, h + 0.13);
			v.box(-0.25, 0.25, h, h + 0.04, -hw * 0.7, hw * 0.7, [0.42, 0.47, 0.38]);
			v.box(-0.05, -0.03, h, h + 0.16, -0.008, 0.008, STEEL);
	}
	return v.done("xyz");
}

// --- air ----------------------------------------------------------------------------------------------------------

function aircraft(kind) {
	const v = new VBuf();
	if (kind === "heli") {
		const cy = 0.12;
		v.loft(-0.15, ellipse(8, 0.07, 0.07, cy), 0.2, ellipse(8, 0.06, 0.055, cy - 0.005), (i) => (i >= 1 && i <= 2 ? GLASS : WHITE),
			(i) => (i >= 1 && i <= 2 ? 0 : 1), true, true);
		v.loft(-0.5, ellipse(4, 0.012, 0.012, cy + 0.03), -0.15, ellipse(4, 0.03, 0.03, cy + 0.02), WHITE, 1);
		v.box(-0.5, -0.44, cy + 0.03, cy + 0.12, -0.004, 0.004, WHITE, 1);
		v.box(-0.45, 0.45, cy + 0.085, cy + 0.09, -0.02, 0.02, DARK, 0, true);
		v.box(-0.02, 0.02, cy + 0.085, cy + 0.09, -0.45, 0.45, DARK, 0, true);
		v.box(-0.12, 0.12, 0.0, 0.01, -0.06, -0.05, DARK);
		v.box(-0.12, 0.12, 0.0, 0.01, 0.05, 0.06, DARK);
		return v.done("xyz");
	}
	const big = kind === "wide", prop = kind === "prop";
	const r = big ? 0.06 : kind === "regional" ? 0.045 : prop ? 0.05 : 0.05;
	const cy = r + (prop ? 0.03 : 0.035);
	const ring = (k, dy = 0) => ellipse(8, r * k, r * k, cy + dy, Math.PI / 8);
	// the upper half of the fuselage (seen from above) in the company colour, cargo planes only a hint of it
	const cargoPlane = kind === "cargo";
	const crown = (i) => (i <= 3 ? (cargoPlane ? 0.25 : 0.85) : 0);
	v.loft(-0.5, ring(0.25, r * 0.55), -0.3, ring(1), WHITE, crown, true, false);
	v.extrude(-0.3, 0.36, ring(1), WHITE, crown, false);
	v.loft(0.36, ring(1), 0.5, ring(0.15, -r * 0.3), (i) => (i === 0 || i === 2 ? GLASS : WHITE), (i) => (i === 0 || i === 2 ? 0 : crown(i)), false, true);
	// wings (swept), tail plane and fin
	const span = big ? 0.5 : prop ? 0.48 : 0.45, wy = prop ? cy + r * 0.85 : cy - r * 0.45;
	const sweep = prop ? 0.02 : 0.14;
	const wing = (s) => {
		const p = [[0.1, wy, 0], [-0.08, wy, 0], [-0.08 - sweep - 0.02, wy, s * span], [-0.02 - sweep, wy, s * span]];
		v.face(p, [0, wy - 1, 0], SILVER, 0);
		v.face(p.map(([x, y, z]) => [x, y - 0.008, z]), [0, wy + 1, 0], SILVER, 0);
	};
	wing(-1);
	wing(1);
	const tp = (s) => {
		const p = [[-0.36, cy + r * 0.3, 0], [-0.46, cy + r * 0.3, 0], [-0.5, cy + r * 0.3, s * 0.17], [-0.44, cy + r * 0.3, s * 0.17]];
		v.face(p, [-0.4, cy - 1, 0], SILVER, 0);
		v.face(p.map(([x, y, z]) => [x, y - 0.006, z]), [-0.4, cy + 1, 0], SILVER, 0);
	};
	tp(-1);
	tp(1);
	const fin = [[-0.32, cy + r * 0.6], [-0.47, cy + r * 0.6], [-0.53, cy + r + 0.13], [-0.45, cy + r + 0.13]];
	for (const z of [-0.004, 0.004]) {
		v.face(fin.map(([x, y]) => [x, y, z]), [-0.42, cy + r + 0.05, -z * 100], WHITE, 1);
	}
	// engines
	const engines = big ? [-0.2, -0.38, 0.2, 0.38] : prop ? [-0.17, 0.17] : [-0.18, 0.18];
	for (const z of engines) {
		const x = -0.02 + (prop ? 0.06 : -Math.abs(z) * sweep * 1.2);
		const er = big ? 0.026 : 0.02, ey = prop ? wy - 0.005 : wy - er - 0.004;
		v.extrude(x - 0.06, x + 0.06, ellipse(6, er, er, 0).map(([a, b]) => [a + z, b + ey]), [0.5, 0.52, 0.56], 0, true, DARK);
		if (prop) {
			v.box(x + 0.06, x + 0.065, ey - 0.05, ey + 0.05, z - 0.05, z + 0.05, DARK, 0);
		}
	}
	// landing gear
	v.box(0.3, 0.33, 0, cy - r, -0.008, 0.008, DARK);
	v.box(-0.06, -0.02, 0, cy - r, -r * 0.9, -r * 0.6, DARK);
	v.box(-0.06, -0.02, 0, cy - r, r * 0.6, r * 0.9, DARK);
	return v.done("xyz");
}

// --- selection marker ---------------------------------------------------------------------------------------------

function marker() {
	const v = new VBuf(), w = 0.06;
	v.box(-0.5, 0.5, 0, 0.01, -0.5, -0.5 + w, WHITE, 0, true);
	v.box(-0.5, 0.5, 0, 0.01, 0.5 - w, 0.5, WHITE, 0, true);
	v.box(-0.5, -0.5 + w * 0.6, 0, 0.01, -0.5, 0.5, WHITE, 0, true);
	v.box(0.5 - w * 0.6, 0.5, 0, 0.01, -0.5, 0.5, WHITE, 0, true);
	return v.done("x");
}

// --- shapes by key ------------------------------------------------------------------------------------------------

const CARGO = ["box", "tank", "open", "covered", "reefer", "stake", "steel", "container", "autos", "flat"];

const BUILDERS = {
	rail_coach: () => railCoach(false, false),
	rail_emu: () => railCoach(true, false),
	rail_mail: () => railCoach(false, true),
	rail_loco_electric: railLocoElectric,
	rail_loco_diesel: railLocoDiesel,
	rail_loco_steam: railLocoSteam,
	tram_car: tramCar,
	mono_head: () => sleekCar(true, false),
	mono_car: () => sleekCar(false, false),
	maglev_head: () => sleekCar(true, true),
	maglev_car: () => sleekCar(false, true),
	road_bus: bus,
	road_van: van,
	road_tractor: () => truck("none", true),
	citycar: () => car(false),
	citycar_van: () => car(true),
	pedestrian,
	air_prop: () => aircraft("prop"),
	air_regional: () => aircraft("regional"),
	air_narrow: () => aircraft("narrow"),
	air_wide: () => aircraft("wide"),
	air_cargo: () => aircraft("cargo"),
	air_heli: () => aircraft("heli"),
	marker,
};
for (const k of CARGO) {
	BUILDERS["rail_" + k] = () => railFreight(k);
	BUILDERS["road_truck_" + k] = () => truck(k, true);
	BUILDERS["road_trailer_" + k] = () => truck(k, false);
}
for (const k of ["tanker", "bulk", "container", "ferry", "tug", "barge", "cargo"]) {
	BUILDERS["ship_" + k] = () => ship(k);
}

/** The shape of a body key: {position, color, tint, scale: "x"|"xyz"|"1"}, or null for an unknown key. */
export function buildShape(key) {
	const b = BUILDERS[key];
	return b ? b() : null;
}

export const SHAPE_KEYS = Object.keys(BUILDERS);

// --- classification -----------------------------------------------------------------------------------------------

const DEFAULTS = {
	freight: { Passagiere: "passenger", Post: "mail", Autos: "autos", Cement: "covered", Concrete: "covered", Stahl: "steel",
		None: "none" },
	catg: { 0: "box", 1: "box", 2: "open", 3: "tank", 4: "reefer", 5: "tank", 6: "stake", 7: "covered" },
	keywords: [
		{ match: "container", freight: "container" },
		{ match: "tender", freight: "open" },
		{ match: "tank|kessel|tanker", freight: "tank" },
		{ match: "hopper|silo|grain", freight: "covered" },
		{ match: "steam|dampf", loco: "steam" },
		{ match: "diesel|dmu", loco: "diesel" },
		{ match: "electric|elektr|emu|_e[0-9]", loco: "electric" },
		{ match: "heli", air: "heli" },
	],
	families: {
		track: { w: 1, h: 1, y: 0 }, narrowgauge: { w: 0.78, h: 0.84, y: 0 }, tram: { w: 1, h: 1, y: 0 },
		monorail: { w: 1, h: 1, y: 0 }, maglev: { w: 1, h: 1, y: 0 }, road: { w: 1, h: 1, y: 0 },
	},
	steamBefore: 1935,
	electricFrom: 1960,
	ships: { scale: 2, min: 0.45, max: 1.7 },
	aircraft: [{ upTo: 30, body: "air_prop", length: 0.6 }, { upTo: 110, body: "air_regional", length: 0.85 },
		{ upTo: 280, body: "air_narrow", length: 1.05 }, { upTo: 100000, body: "air_wide", length: 1.35 }],
	citycars: { length: 0.24, van: "truck|van|bus|lorry|pickup|transporter", vanLength: 0.3,
		colors: { red: "#b3312a", blue: "#2f56a0", green: "#3f7a3a", white: "#e9e9e6", black: "#262628", yellow: "#d8b632",
			silver: "#a9adb2", grey: "#7d8186", gray: "#7d8186", orange: "#d1702a", brown: "#6e4b33", beige: "#c8b28c",
			purple: "#6a3f86", pink: "#cf7b9b", gold: "#b9973f", turquoise: "#3a9a9a", cyan: "#3a9aaa", violet: "#6a3f86" },
		palette: ["#b3312a", "#2f56a0", "#e9e9e6", "#262628", "#a9adb2", "#3f7a3a", "#d8b632", "#7d8186"] },
	pedestrians: { palette: ["#c0392b", "#2c6fb0", "#3e8e41", "#d9a42a", "#8e44ad", "#e67e22", "#ecf0f1", "#34495e", "#16a085"] },
};

function merged(rules) {
	const r = (rules && rules.vehicles) || {};
	const out = {};
	for (const [k, v] of Object.entries(DEFAULTS)) {
		const o = r[k];
		out[k] = o === undefined ? v : (v && typeof v === "object" && !Array.isArray(v) && o && typeof o === "object" && !Array.isArray(o))
			? Object.assign({}, v, o) : o;
	}
	return out;
}

function hexRgb(h) {
	const m = /^#?([0-9a-f]{6})$/i.exec(h || "");
	return m ? [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16) / 255) : null;
}

function hashStr(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	}
	return h >>> 0;
}

/**
 * The classifier of a pak: catalogue = desc_list {vehicles, goods, citycars, pedestrians}, rules = gen/rules.json.
 * of(kind, desc index) -> {head, middle, flipLast, len, w, h, y, color?} (len: drawn length in squares; head: shape
 * of a front or rear car, middle: of the cars between; flipLast: a powered last car faces backwards; color: sRGB
 * instance colour, else the company colour).
 */
export function createClassifier(catalogue, rules) {
	const R = merged(rules);
	const goodsCatg = new Map(((catalogue && catalogue.goods) || []).map((g) => [g.name, g.catg]));
	const kw = (R.keywords || []).map((k) => Object.assign({}, k, { re: safeRe(k.match) })).filter((k) => k.re);
	const cache = [new Map(), new Map(), new Map()];
	const vanRe = safeRe(R.citycars.van);

	function freightOf(d) {
		const name = d.freight;
		if (name in R.freight) {
			return R.freight[name];
		}
		if (!name || !d.capacity) {
			return "none";
		}
		const c = goodsCatg.get(name);
		return (c !== undefined && R.catg[c]) || "box";
	}

	function convoyBody(d) {
		const name = d.name || "", wt = d.waytype || "track";
		let fr = freightOf(d), loco = null, air = null, byName = false;
		for (const k of kw) {
			if (k.re.test(name)) {
				if (k.freight && !byName && fr !== "passenger" && fr !== "mail" && !(fr === "none" && (d.power | 0) > 0)) {
					fr = k.freight;
					byName = true;
				}
				loco = loco || k.loco || null;
				air = air || k.air || null;
			}
		}
		const powered = (d.power | 0) > 0, L = Math.max(1, d.length | 0) / 16;
		const fam = R.families[wt] || R.families.track;
		const base = { len: L, w: fam.w ?? 1, h: fam.h ?? 1, y: fam.y ?? 0, flipLast: powered };
		if (wt === "air") {
			const cap = d.capacity | 0;
			const a = R.aircraft.find((x) => cap <= x.upTo) || R.aircraft[R.aircraft.length - 1];
			let body = air === "heli" ? "air_heli" : a.body;
			if (body !== "air_heli" && fr !== "passenger") {
				body = "air_cargo";
			}
			return { head: body, middle: body, len: air === "heli" ? 0.5 : a.length, w: 1, h: 1, y: 0, flipLast: false };
		}
		if (wt === "water") {
			const s = R.ships;
			const body = fr === "passenger" ? "ship_ferry" : fr === "tank" ? "ship_tanker" : fr === "container" ? "ship_container"
				: fr === "open" || fr === "covered" ? "ship_bulk" : fr === "none" ? (powered ? "ship_tug" : "ship_barge")
				: !powered ? "ship_barge" : "ship_cargo";
			return { head: body, middle: body, len: Math.min(s.max, Math.max(s.min, L * s.scale)), w: 1, h: 1, y: 0, flipLast: false };
		}
		if (wt === "road") {
			let body;
			if (fr === "passenger") {
				body = "road_bus";
			} else if (fr === "mail") {
				body = powered ? "road_van" : "road_trailer_box";
			} else if (fr === "none") {
				body = powered ? "road_tractor" : "road_trailer_flat";
			} else {
				body = (powered ? "road_truck_" : "road_trailer_") + fr;
			}
			return Object.assign(base, { head: body, middle: body, flipLast: false });
		}
		if (wt === "tram") {
			const body = fr === "passenger" || fr === "mail" ? "tram_car" : "rail_" + (fr === "none" ? "flat" : fr);
			return Object.assign(base, { head: body, middle: body, flipLast: false, w: 0.8, h: 0.92 });
		}
		if (wt === "monorail" || wt === "maglev") {
			const p = wt === "monorail" ? "mono" : "maglev";
			return Object.assign(base, { head: p + "_head", middle: p + "_car" });
		}
		// track, narrow gauge and anything else on rails
		if (powered && (fr === "none" || (fr !== "passenger" && fr !== "mail"))) {
			const intro = d.intro | 0;
			const kind = loco || (intro && intro < R.steamBefore ? "steam" : intro >= R.electricFrom && (d.speed | 0) >= 140 ? "electric" : "diesel");
			const body = "rail_loco_" + kind;
			return Object.assign(base, { head: body, middle: body });
		}
		if (fr === "passenger") {
			return Object.assign(base, powered ? { head: "rail_emu", middle: "rail_coach" } : { head: "rail_coach", middle: "rail_coach", flipLast: false });
		}
		if (fr === "mail") {
			return Object.assign(base, { head: powered ? "rail_emu" : "rail_mail", middle: "rail_mail" });
		}
		const body = "rail_" + (fr === "none" ? "flat" : fr);
		return Object.assign(base, { head: body, middle: body, flipLast: false });
	}

	function cityCar(d) {
		const name = (d && d.name) || "";
		const van = vanRe && vanRe.test(name);
		let color = null;
		const low = name.toLowerCase();
		for (const [k, hex] of Object.entries(R.citycars.colors)) {
			if (low.includes(k)) {
				color = hexRgb(hex);
				break;
			}
		}
		if (!color) {
			const pal = R.citycars.palette;
			color = hexRgb(pal[hashStr(name) % pal.length]) || [0.6, 0.6, 0.6];
		}
		return { head: van ? "citycar_van" : "citycar", middle: van ? "citycar_van" : "citycar",
			len: van ? R.citycars.vanLength : R.citycars.length, w: 1, h: 1, y: 0, flipLast: false, color };
	}

	function walker(d) {
		const pal = R.pedestrians.palette;
		const color = hexRgb(pal[hashStr((d && d.name) || "") % pal.length]) || [0.5, 0.5, 0.6];
		return { head: "pedestrian", middle: "pedestrian", len: 1, w: 1, h: 1, y: 0, flipLast: false, color };
	}

	return {
		of(kind, i) {
			const c = cache[kind] || cache[0];
			let b = c.get(i);
			if (!b) {
				const list = kind === 1 ? catalogue.citycars : kind === 2 ? catalogue.pedestrians : catalogue.vehicles;
				const d = (list && list[i]) || null;
				b = kind === 1 ? cityCar(d) : kind === 2 ? walker(d)
					: d ? convoyBody(d) : { head: "rail_box", middle: "rail_box", len: 0.5, w: 1, h: 1, y: 0, flipLast: false };
				b.waytype = kind === 0 && d ? d.waytype : kind === 1 ? "road" : kind === 2 ? "walk" : null;
				b.air = b.head.startsWith("air_");
				c.set(i, b);
			}
			return b;
		},
	};
}

function safeRe(s) {
	if (typeof s !== "string" || !s) {
		return null;
	}
	try {
		return new RegExp(s, "i");
	} catch (e) {
		return null;
	}
}
