// Simutrans-Horizon dashboard, 3D view: city blocks, large low-rise buildings with wings around a yard, industrial
// halls and simple civic buildings (procedural buildings, worker side). Artistic License, see LICENSE.txt.
import { col } from "./tbuf.js";
import { DARK, STEEL, facadeOf, roofKind, roofCol, lot, winOf, rooftop } from "./common.js";

/** City block building: storeys, setbacks for towers, roof by climate and height, ground floor, rooftop details. */
export function block(g, o = {}) {
	const { tb, W, D } = g;
	const P = o.P || g.P;
	const low = g.lev <= 4.5;
	const insR = (P.inset && (low ? P.inset.low : P.inset.high)) || (low ? [0.1, 0.18] : [0.05, 0.09]);
	const ins = g.range(insR);
	const x0 = ins, x1 = W - ins, z0 = ins, z1 = D - ins;
	lot(g, P.lot && (low ? P.lot.low : P.lot.high));
	const fac = o.facade || facadeOf(g, P.facades);
	const kind = o.roof || roofKind(g, P);
	const H = o.H ?? g.H;
	if (low && W >= 2 && D >= 2 && !o.solid) {
		return compound(g, P, fac, kind, H, o.windows || fac.windows || P.windowsLow || P.windows || "punched");
	}
	const minSide = Math.min(x1 - x0, z1 - z0);
	let roofH = 0;
	if (kind === "gable" || kind === "hip") {
		roofH = Math.min(minSide * g.range([0.26, 0.4]), H * 0.45, o.roofMax ?? 0.45);
	} else if (kind === "mansard") {
		roofH = Math.min(g.st * 1.1, H * 0.3, o.roofMax ?? 0.45);
	}
	const wallH = Math.max(g.st * 0.8, H - roofH);
	const nst = Math.max(1, Math.round(wallH / g.st));
	const st = wallH / nst;
	const style = o.windows || fac.windows || (low && P.windowsLow) || P.windows || "punched";
	const c = fac.c;
	// tiers of a tower
	const tiers = [{ ins: 0, y0: 0, y1: wallH }];
	const T = P.tower;
	if (T && nst >= 6 && g.lev >= (T.minLevels ?? 7) && g.rnd() < (T.chance ?? 0.5)) {
		const n = g.int(T.setbacks || [1, 2]);
		const fr = n === 1 ? [0.72] : n === 2 ? [0.55, 0.8] : [0.45, 0.66, 0.84];
		tiers.length = 0;
		let y = 0, inset = 0;
		for (let k = 0; k <= n; k++) {
			const y1 = k < n ? Math.max(y + st, Math.round((fr[k] * wallH) / st) * st) : wallH;
			tiers.push({ ins: inset, y0: y, y1 });
			y = y1;
			inset += g.range(T.step || [0.06, 0.1]);
			if (minSide - 2 * inset < 0.18) {
				inset = (minSide - 0.18) / 2;
			}
		}
	}
	const ground = o.ground ?? P.ground;
	const roofC = roofCol(g, kind);
	for (let k = 0; k < tiers.length; k++) {
		const t = tiers[k];
		const q = [[x0 + t.ins, z0 + t.ins], [x1 - t.ins, z0 + t.ins], [x1 - t.ins, z1 - t.ins], [x0 + t.ins, z1 - t.ins]];
		let ya = t.y0;
		if (k === 0 && (ground === "shop" || ground === "garage") && nst >= 2) {
			const sc = ground === "garage" ? c : col(fac.hex, 0.82);
			tb.prism(q, 0, st, sc, null, winOf(g, ground === "garage" ? "door" : "shop", st), true);
			ya = st;
		}
		const last = k === tiers.length - 1;
		// the top of a lower tier is a setback terrace
		tb.prism(q, ya, t.y1, c, roofC, winOf(g, style, st, ya / st), last && kind !== "flat");
	}
	const tl = tiers[tiers.length - 1];
	const rx0 = x0 + tl.ins, rx1 = x1 - tl.ins, rz0 = z0 + tl.ins, rz1 = z1 - tl.ins;
	if (ground === "door" && x1 - x0 > 0.16) {
		const xm = (x0 + x1) / 2, dw = Math.min(0.05, (x1 - x0) * 0.12);
		tb.face([[xm - dw, 0, z1 + 0.004], [xm + dw, 0, z1 + 0.004], [xm + dw, Math.min(st * 0.85, 0.1), z1 + 0.004],
			[xm - dw, Math.min(st * 0.85, 0.1), z1 + 0.004]], xm, 0.05, z1 - 1, col("#3a2c22"));
	}
	if (g.rnd() < (P.cornice ?? 0) && /brick|stone|brownstone|civic/.test(fac.palette || "") && kind === "flat") {
		const e = 0.012;
		tb.box(rx0 - e, rx1 + e, wallH - 0.012, wallH + 0.01, rz0 - e, rz1 + e, col(fac.hex, 0.88), roofC);
	}
	const y = wallH;
	if (kind === "gable") {
		const alongX = rx1 - rx0 >= (rz1 - rz0) * 0.8;
		tb.gable(rx0, rx1, rz0, rz1, y, roofH, alongX, roofC, c);
	} else if (kind === "hip") {
		tb.hip(rx0, rx1, rz0, rz1, y, roofH, roofC);
	} else if (kind === "mansard") {
		const m = Math.min(0.06, (rx1 - rx0) * 0.2);
		const cx = (rx0 + rx1) / 2, cz = (rz0 + rz1) / 2;
		const lo = [[rx0, rz0], [rx1, rz0], [rx1, rz1], [rx0, rz1]], hi = [[rx0 + m, rz0 + m], [rx1 - m, rz0 + m], [rx1 - m, rz1 - m], [rx0 + m, rz1 - m]];
		for (let i = 0; i < 4; i++) {
			const j = (i + 1) % 4;
			tb.face([[lo[i][0], y, lo[i][1]], [lo[j][0], y, lo[j][1]], [hi[j][0], y + roofH, hi[j][1]], [hi[i][0], y + roofH, hi[i][1]]], cx, y, cz, roofC);
		}
		tb.face(hi.map((p) => [p[0], y + roofH, p[1]]), cx, y, cz, col("#5e5f61"));
	} else {
		// flat: a darker inner field reads as a parapet
		const m = Math.min(0.025, (rx1 - rx0) * 0.1);
		tb.pad(rx0 + m, rx1 - m, rz0 + m, rz1 - m, y + 0.002, col("#545556"));
		crown(g, rx0, rx1, rz0, rz1, y, nst, P, c, fac);
	}
	return { x0, x1, z0, z1, H: wallH + roofH, top: [rx0, rx1, rz0, rz1] };
}

/** A large low-rise building: wings around a yard (U, L, ring or two bars), each with its own roof. */
function compound(g, P, fac, kind, H, style) {
	const { tb, W, D } = g;
	const m = 0.1, dw = Math.min(0.5, Math.max(0.3, Math.min(W, D) * 0.2));
	const shape = g.weighted({ U: 3, L: 2, O: 2, bars: 2 });
	const rects = [[m, W - m, m, m + dw]];
	if (shape === "U" || shape === "O") {
		const z1 = D - m - (shape === "O" ? dw : 0.15);
		rects.push([m, m + dw, m + dw, z1], [W - m - dw, W - m, m + dw, z1]);
		if (shape === "O") {
			rects.push([m, W - m, D - m - dw, D - m]);
		}
	} else if (shape === "L") {
		rects.push([m, m + dw, m + dw, D - m]);
	} else {
		rects.push([m, W - m, D - m - dw, D - m], [W / 2 - dw * 0.3, W / 2 + dw * 0.3, m + dw, D - m - dw]);
	}
	const k = kind === "mansard" ? "hip" : kind;
	const roofC = roofCol(g, k);
	const roofH = k === "flat" ? 0 : Math.min(dw * 0.45, 0.2);
	const wallH = Math.max(g.st, H - roofH);
	const st = wallH / Math.max(1, Math.round(wallH / g.st));
	for (const [x0, x1, z0, z1] of rects) {
		tb.prism([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 0, wallH, fac.c, roofC, winOf(g, style, st), k !== "flat");
		if (k === "gable") {
			tb.gable(x0, x1, z0, z1, wallH, roofH, x1 - x0 >= z1 - z0, roofC, fac.c);
		} else if (k === "hip") {
			tb.hip(x0, x1, z0, z1, wallH, roofH, roofC);
		} else {
			tb.pad(x0 + 0.02, x1 - 0.02, z0 + 0.02, z1 - 0.02, wallH + 0.002, col("#545556"));
		}
	}
	// entrance in the middle of the front wing (or the back wing of a U)
	const fz = shape === "O" || shape === "bars" ? D - m : m + dw;
	tb.face([[W / 2 - 0.05, 0, fz + 0.004], [W / 2 + 0.05, 0, fz + 0.004], [W / 2 + 0.05, Math.min(st * 0.85, 0.1), fz + 0.004],
		[W / 2 - 0.05, Math.min(st * 0.85, 0.1), fz + 0.004]], W / 2, 0.05, fz - 1, col("#3a2c22"));
	return { x0: m, x1: W - m, z0: m, z1: D - m, H: wallH + roofH, top: rects[0] };
}

function crown(g, x0, x1, z0, z1, y, nst, P, c, fac) {
	const tb = g.tb;
	const T = P.tower;
	const w = x1 - x0, d = z1 - z0;
	if (T && nst >= 8 && g.lev >= (T.minLevels ?? 7)) {
		const kind = g.weighted(T.crown || { flat: 1 });
		const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
		if (kind === "stepped") {
			let m = 0.06, yy = y;
			for (let k = 0; k < 2 && w - 2 * m > 0.08; k++) {
				const hh = g.st * (1.2 - k * 0.3);
				tb.box(x0 + m, x1 - m, yy, yy + hh, z0 + m, z1 - m, col(fac.hex, 0.92 - k * 0.05), col("#5a5b5c"));
				yy += hh;
				m += 0.06;
			}
			tb.box(cx - 0.008, cx + 0.008, yy, yy + g.H * 0.08 + 0.05, cz - 0.008, cz + 0.008, col(STEEL));
			return;
		}
		if (kind === "pyramid") {
			tb.hip(x0 + 0.03, x1 - 0.03, z0 + 0.03, z1 - 0.03, y, Math.min(w, d) * 0.55, g.pal(g.rnd() < 0.3 ? "roof_copper" : "roof_slate"), 0);
			return;
		}
		if (kind === "spire") {
			const s = Math.min(w, d) * 0.3;
			tb.box(cx - s, cx + s, y, y + g.st * 1.5, cz - s, cz + s, col(fac.hex, 0.9), col("#5a5b5c"));
			tb.cyl(cx, cz, s * 0.9, 0, y + g.st * 1.5, y + g.st * 1.5 + g.H * 0.22, 4, col("#b8bcc0"), false, null, null, Math.PI / 4);
			return;
		}
	}
	rooftop(g, x0, x1, z0, z1, y, P);
}

/** City industry: low hall with a saw-tooth or shallow roof and an office annex; tall ones are lofts (block). */
export function hall(g) {
	const P = g.P;
	if (g.lev > (P.loftAbove ?? 5)) {
		block(g, { windows: "punched", roof: "flat" });
		return;
	}
	const { tb, W, D } = g;
	const ins = g.range((P.inset && P.inset.low) || [0.05, 0.12]);
	const fac = facadeOf(g);
	const H = Math.max(0.16, g.H * 0.85);
	const x0 = ins, x1 = W - ins, z0 = ins, z1 = D - ins;
	const kind = roofKind(g);
	const roofC = roofCol(g, kind === "sawtooth" ? "sawtooth" : kind);
	tb.prism([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 0, H, fac.c, roofC, winOf(g, "industrial", H), kind !== "flat");
	if (kind === "sawtooth") {
		tb.pad(x0, x1, z0, z1, H, roofC);
		tb.sawtooth(x0, x1, z0, z1, H, Math.min(0.09, H * 0.4), Math.max(2, Math.round((z1 - z0) / 0.22)), roofC, col("#7f99a8"));
	} else if (kind === "gable") {
		tb.gable(x0, x1, z0, z1, H, Math.min(0.1, (z1 - z0) * 0.18), true, roofC, fac.c);
	} else {
		rooftop(g, x0, x1, z0, z1, H);
	}
	// loading doors on the front
	const n = Math.max(1, Math.floor((x1 - x0) / 0.3));
	for (let k = 0; k < n; k++) {
		const xm = x0 + (k + 0.5) * (x1 - x0) / n;
		tb.face([[xm - 0.05, 0, z1 + 0.004], [xm + 0.05, 0, z1 + 0.004], [xm + 0.05, Math.min(H * 0.7, 0.1), z1 + 0.004],
			[xm - 0.05, Math.min(H * 0.7, 0.1), z1 + 0.004]], xm, 0.05, z1 - 1, col("#4a4c50"));
	}
	if (g.rnd() < (P.chimney ?? 0.3)) {
		const cx = x0 + 0.08, cz = z0 + 0.08;
		tb.cyl(cx, cz, 0.035, 0.028, 0, H + 0.35 + 0.2 * g.rnd(), 6, g.pal("brick"), true, col(DARK));
	}
}


export function civic(g) {
	block(g, { roof: g.lev <= 4 ? "hip" : "flat", windows: "tall", ground: "door",
		P: Object.assign({}, g.P, { inset: g.P.inset || { low: [0.1, 0.16], high: [0.08, 0.12] }, roofPalettes: { hip: ["roof_slate", "roof_copper"], flat: ["roof_flat"] }, tower: null }) });
}

export function plinth(g) {
	g.tb.box(0.05, g.W - 0.05, -0.03, Math.max(0.04, Math.min(0.2, g.H * 0.3)), 0.05, g.D - 0.05, col("#8f8d88"));
}
