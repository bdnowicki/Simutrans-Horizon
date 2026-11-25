// Simutrans-Horizon dashboard, 3D view: helpers shared by the forms of the procedural buildings (worker side, no
// three.js): palettes, facades, roofs, windows, lots, small trees, rooftop details. Artistic License, see LICENSE.txt.
import { WIN, col } from "./tbuf.js";

export const DARK = "#2a2a2c", STEEL = "#8a8f95", WHITE = "#eeeeea";

export function weighted(o, rnd) {
	let sum = 0;
	for (const v of Object.values(o)) {
		sum += v;
	}
	let r = rnd() * sum;
	for (const [k, v] of Object.entries(o)) {
		r -= v;
		if (r <= 0) {
			return k;
		}
	}
	return Object.keys(o)[0];
}

export function pickPal(palettes, name, rnd) {
	const p = palettes[name];
	if (Array.isArray(p) && p.length) {
		return p[Math.floor(rnd() * p.length) % p.length];
	}
	return typeof name === "string" && name[0] === "#" ? name : "#9a9a96";
}

export function facadeOf(g, list) {
	const fs = (list || g.P.facades || [{ palette: "stone", w: 1 }]).filter((f) => !f.minLevels || g.lev >= f.minLevels);
	const o = {};
	fs.forEach((f, i) => {
		o[i] = f.w ?? 1;
	});
	const f = fs[Number(g.weighted(o))] || fs[0];
	const hex = g.palHex(f.palette);
	return { hex, c: col(hex), windows: f.windows || null, palette: f.palette };
}

export function roofKind(g, P = g.P) {
	for (const r of P.roofs || []) {
		if ((r.maxLevels === undefined || g.lev <= r.maxLevels) && (!r.climate || r.climate === g.climate)) {
			return g.weighted(r.kinds || { flat: 1 });
		}
	}
	return "flat";
}

export function roofCol(g, kind) {
	const rp = (g.P.roofPalettes && g.P.roofPalettes[kind]) || (kind === "flat" ? ["roof_flat"] : ["roof_slate", "roof_tile"]);
	return g.pal(g.pick(rp));
}

export function lot(g, name, x0 = 0.02, x1 = g.W - 0.02, z0 = 0.02, z1 = g.D - 0.02) {
	if (name) {
		g.tb.pad(x0, x1, z0, z1, 0.006, g.pal(name));
	}
}

/** Small low-poly tree in a model (parks, farms). */
export function tree(g, x, z, s, conifer) {
	const tb = g.tb, trunk = col("#6b4f3a");
	tb.cyl(x, z, 0.012 * s, 0.01 * s, 0, 0.08 * s, 4, trunk, false);
	const leaf = col(conifer ? "#2f5a34" : g.pick(["#4f7d33", "#5b8a3a", "#476f2e"]));
	if (conifer) {
		tb.cyl(x, z, 0.07 * s, 0, 0.05 * s, 0.3 * s, 6, leaf, false);
	} else {
		tb.cyl(x, z, 0.05 * s, 0.085 * s, 0.06 * s, 0.14 * s, 6, leaf, false);
		tb.cyl(x, z, 0.085 * s, 0, 0.14 * s, 0.25 * s, 6, leaf, false);
	}
}

/** Window spec of a facade: style name -> {s, col, st, v0}. */
export function winOf(g, style, st, v0 = 0) {
	return { s: WIN[style] ?? WIN.punched, col: style === "curtain" ? g.colW * 0.8 : g.colW, st, v0 };
}

export function rooftop(g, x0, x1, z0, z1, y, P = g.P) {
	const R = P.rooftop || {};
	const tb = g.tb;
	const w = x1 - x0, d = z1 - z0;
	if (w < 0.2 || d < 0.2) {
		return;
	}
	const at = (k) => [x0 + 0.06 + (w - 0.12) * g.rnd(), z0 + 0.06 + (d - 0.12) * g.rnd()];
	if (g.rnd() < (R.bulkhead ?? 0)) {
		const [x, z] = at();
		const s = Math.min(0.1, w * 0.25);
		tb.box(x - s / 2, x + s / 2, y, y + Math.min(g.st * 0.9, 0.11), z - s / 2, z + s / 2, g.pal("concrete"));
	}
	if (g.rnd() < (R.hvac ?? 0)) {
		const [x, z] = at();
		tb.box(x - 0.05, x + 0.05, y, y + 0.04, z - 0.03, z + 0.03, col("#9a9c9e"));
	}
	if (g.rnd() < (R.watertank ?? 0) && g.lev <= 9) {
		const [x, z] = at();
		const r = 0.045 + 0.02 * g.rnd(), wood = col("#7a5a40");
		tb.box(x - r * 0.8, x + r * 0.8, y, y + 0.035, z - r * 0.8, z + r * 0.8, col("#4a4a4a"));
		tb.cyl(x, z, r, r, y + 0.035, y + 0.035 + r * 1.6, 6, wood, false);
		tb.cyl(x, z, r * 1.08, 0, y + 0.035 + r * 1.6, y + 0.035 + r * 2.4, 6, wood, false);
	}
	if (g.rnd() < (R.antenna ?? 0) && g.lev >= 6) {
		const [x, z] = at();
		tb.box(x - 0.006, x + 0.006, y, y + g.H * 0.12 + 0.1, z - 0.006, z + 0.006, col(STEEL));
	}
}
