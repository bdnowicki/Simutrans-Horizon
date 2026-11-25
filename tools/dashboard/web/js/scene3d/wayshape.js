// Simutrans-Horizon dashboard, 3D view: shapes of ways on a square from their ribi (worker side, no three.js).
// Square-local coordinates: u = east (0..1), v = south (0..1). A piece is a centre line sampled as [u, v, tu, tv]
// (position, unit tangent); ways are drawn as bands along their pieces (ways.js). Shapes:
//   straight (N+S, E+W)      one piece from edge to edge
//   curve (two adjacent)     a cubic curve between the two edge midpoints; an end whose neighbour continues the
//                            diagonal (the game draws diagonals as a chain of such squares) leaves at 45 degrees, so
//                            diagonals become straight lines and single 90 degree turns quarter circles
//   junction (3, 4)          "paths": the straight through + curves into the branch (tracks), "arms": a piece from
//                            every connected edge to a centre square (roads, areas)
//   dead end (1), none (0)   an arm to the centre (+ a buffer stop or a closed centre square)
// Artistic License, see LICENSE.txt.

export const N = 1, E = 2, S = 4, W = 8;
export const DIRS = [N, E, S, W];
// edge midpoints, inward directions (from the edge into the square), neighbour offsets
export const MID = { 1: [0.5, 0], 2: [1, 0.5], 4: [0.5, 1], 8: [0, 0.5] };
export const INWARD = { 1: [0, 1], 2: [-1, 0], 4: [0, -1], 8: [1, 0] };
export const STEP = { 1: [0, -1], 2: [1, 0], 4: [0, 1], 8: [-1, 0] };

export const opposite = (d) => ((d << 2) | (d >> 2)) & 15;
export const rot180 = opposite;
export function bitCount(r) {
	r &= 15;
	return (r & 1) + ((r >> 1) & 1) + ((r >> 2) & 1) + ((r >> 3) & 1);
}
export const isStraight = (r) => r === (N | S) || r === (E | W);
export const isCurve = (r) => r === (N | E) || r === (E | S) || r === (S | W) || r === (W | N);
/** Main axis of a ribi: "ns", "ew" or null (curves, junctions, none). Single directions give their axis. */
export function axisOf(r) {
	r &= 15;
	if (r === N || r === S || r === (N | S)) return "ns";
	if (r === E || r === W || r === (E | W)) return "ew";
	return null;
}

/** Corner offsets of a way slope code (sw + 3*se + 9*ne + 27*nw, each 0..2 levels): [sw, se, ne, nw]. */
export function slopeOffsets(code) {
	return [code % 3, ((code / 3) | 0) % 3, ((code / 9) | 0) % 3, ((code / 27) | 0) % 3];
}

/** Height in levels above z of a slope at (u, v) (bilinear between the corners). */
export function slopeAt(off, u, v) {
	const [sw, se, ne, nw] = off;
	return nw * (1 - u) * (1 - v) + ne * u * (1 - v) + se * u * v + sw * (1 - u) * v;
}

/** The side of a sloped square that is highest (N, E, S, W), or 0 when flat or not a plain ramp. */
export function highSide(sw, se, ne, nw) {
	const n = ne + nw, s = sw + se, e = ne + se, w = nw + sw;
	const m = Math.max(n, s, e, w);
	if (m === Math.min(n, s, e, w)) return 0;
	if (n === m && n > s) return N;
	if (s === m && s > n) return S;
	if (e === m && e > w) return E;
	if (w === m && w > e) return W;
	return 0;
}

const H = 0.27614; // Bezier handle of a quarter circle of radius 0.5 (0.5 * 0.55228)

function cubic(p0, t0, p3, t3, n) {
	const p1 = [p0[0] + t0[0] * H, p0[1] + t0[1] * H], p2 = [p3[0] - t3[0] * H, p3[1] - t3[1] * H];
	const out = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n, s = 1 - t;
		const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
		const u = a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0];
		const v = a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1];
		let du = 3 * s * s * (p1[0] - p0[0]) + 6 * s * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]);
		let dv = 3 * s * s * (p1[1] - p0[1]) + 6 * s * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]);
		const l = Math.hypot(du, dv) || 1;
		out.push([u, v, du / l, dv / l]);
	}
	return out;
}

function line(p0, p1) {
	const du = p1[0] - p0[0], dv = p1[1] - p0[1], l = Math.hypot(du, dv) || 1;
	return [[p0[0], p0[1], du / l, dv / l], [p1[0], p1[1], du / l, dv / l]];
}

const SQRT1_2 = Math.SQRT1_2;

/** Piece between edges a and b (adjacent): leaves edge a inwards (or at 45 degrees when diagonal), enters edge b. */
function curvePiece(a, b, diagA, diagB, n = 6) {
	const p0 = MID[a], p3 = MID[b];
	const chord = [(p3[0] - p0[0]) * 2 * SQRT1_2, (p3[1] - p0[1]) * 2 * SQRT1_2];
	if (diagA && diagB) {
		return line(p0, p3);
	}
	const t0 = diagA ? chord : INWARD[a];
	const out = INWARD[b];
	const t3 = diagB ? chord : [-out[0], -out[1]];
	return cubic(p0, t0, p3, t3, n);
}

/**
 * Pieces of a way square.
 * ribi: connections; diag: edges whose neighbour continues a diagonal (only used by curves);
 * mode: "paths" or "arms"; inner: distance from the centre where arms end in "arms" mode.
 * Returns {pieces: [{pts, kind: "straight"|"curve"|"diagonal"|"arm", from, to}], center: bool, ends: [dirs]}.
 * `center`: the centre square must be drawn ("arms" junctions, dead ends, none); `ends`: dead end directions.
 */
export function wayPieces(ribi, diag = 0, mode = "paths", inner = 0) {
	ribi &= 15;
	// pure function of its arguments: shared results (callers must not change them)
	const key = ribi | ((diag & 15) << 4) | (mode === "arms" ? 256 : 0) | (Math.round(inner * 1000) << 9);
	let r = memo.get(key);
	if (!r) {
		r = piecesOf(ribi, diag, mode, inner);
		memo.set(key, r);
	}
	return r;
}

const memo = new Map();

function piecesOf(ribi, diag, mode, inner) {
	const n = bitCount(ribi);
	const pieces = [];
	const arm = (d, stop) => {
		const m = MID[d], i = INWARD[d], len = 0.5 - stop;
		pieces.push({ pts: line(m, [m[0] + i[0] * len, m[1] + i[1] * len]), kind: "arm", from: d, to: 0 });
	};
	if (n === 2 && isStraight(ribi)) {
		const [a, b] = ribi === (N | S) ? [N, S] : [W, E];
		pieces.push({ pts: line(MID[a], MID[b]), kind: "straight", from: a, to: b });
		return { pieces, center: false, ends: [] };
	}
	if (n === 2) {
		// adjacent pair, ordered clockwise: N->E, E->S, S->W, W->N
		const a = ribi === (W | N) ? W : ribi === (N | E) ? N : ribi === (E | S) ? E : S;
		const b = a === W ? N : (a << 1) & 15;
		const da = (diag & a) !== 0, db = (diag & b) !== 0;
		pieces.push({ pts: curvePiece(a, b, da, db), kind: da && db ? "diagonal" : "curve", from: a, to: b });
		return { pieces, center: false, ends: [] };
	}
	if (n === 1) {
		arm(ribi, mode === "arms" ? inner : 0);
		return { pieces, center: mode === "arms", ends: [ribi] };
	}
	if (n === 0) {
		// an unconnected square: a centre square ("arms") or a short piece in the middle
		if (mode !== "arms") {
			pieces.push({ pts: line([0.5, 0.25], [0.5, 0.75]), kind: "stub", from: 0, to: 0 });
		}
		return { pieces, center: mode === "arms", ends: [] };
	}
	if (mode === "arms") {
		for (const d of DIRS) {
			if (ribi & d) {
				arm(d, inner);
			}
		}
		return { pieces, center: true, ends: [] };
	}
	// paths: through straights, curves from a branch into both directions of the through line
	if (n === 4) {
		pieces.push({ pts: line(MID[N], MID[S]), kind: "straight", from: N, to: S });
		pieces.push({ pts: line(MID[W], MID[E]), kind: "straight", from: W, to: E });
		return { pieces, center: false, ends: [] };
	}
	const br = opposite(DIRS.find((d) => !(ribi & d)));
	const thr = ribi & ~br;
	const [a, b] = thr === (N | S) ? [N, S] : [W, E];
	pieces.push({ pts: line(MID[a], MID[b]), kind: "straight", from: a, to: b });
	for (const d of [a, b]) {
		pieces.push({ pts: curvePiece(br, d, false, false), kind: "curve", from: br, to: d });
	}
	return { pieces, center: false, ends: [] };
}

/** Cumulative arc lengths of a sampled piece. */
export function arcLengths(pts) {
	if (pts.lens) {
		return pts.lens;
	}
	const out = new Float32Array(pts.length);
	pts.lens = out;
	for (let i = 1; i < pts.length; i++) {
		out[i] = out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
	}
	return out;
}

/** Point and tangent at arc length s of a sampled piece (lens from arcLengths). */
export function pointAt(pts, lens, s) {
	let i = 1;
	while (i < pts.length - 1 && lens[i] < s) {
		i++;
	}
	const a = pts[i - 1], b = pts[i], l = lens[i] - lens[i - 1] || 1;
	const t = Math.min(1, Math.max(0, (s - lens[i - 1]) / l));
	const tu = a[2] + (b[2] - a[2]) * t, tv = a[3] + (b[3] - a[3]) * t, n = Math.hypot(tu, tv) || 1;
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, tu / n, tv / n];
}
