// Simutrans-Horizon dashboard, 3D view: factory sites (a hall, an office and features such as chimneys, tanks, silos
// and cooling towers on a grid of half squares, by the recipes of gen/rules.json) and special industry forms (wind
// turbines, solar fields, oil rigs, fuel stations) of the procedural buildings, worker side.
// Artistic License, see LICENSE.txt.
import { col } from "./tbuf.js";
import { DARK, STEEL, WHITE, facadeOf, roofCol, lot, winOf, rooftop } from "./common.js";

/** A factory site: a main hall (by recipe), an office, and features placed on a grid of half squares. */
export function works(g) {
	const { tb, W, D, P } = g;
	const R = P.recipe || {};
	const HR = R.hall || { frac: 0.5 };
	const m = 0.06;
	lot(g, R.lot === undefined ? "lot_paved" : R.lot);
	const fac = facadeOf(g);
	const free = [];
	const step = 0.5;
	const nx = Math.max(1, Math.floor((W - 2 * m) / step)), nz = Math.max(1, Math.floor((D - 2 * m) / step));
	const sx = (W - 2 * m) / nx, sz = (D - 2 * m) / nz;
	const used = new Uint8Array(nx * nz);
	// hall along the back rows (north), or the west columns of a deep site
	const frac = HR.frac ?? 0.5;
	if (frac > 0) {
		const alongX = W >= D;
		const k = Math.max(1, Math.round((alongX ? nz : nx) * frac));
		const hx1 = alongX ? W - m : m + k * sx, hz1 = alongX ? m + k * sz : D - m;
		const H = Math.max(0.2, Math.min(1.1, g.H * 0.4 * (HR.tall || 1)));
		const roof = HR.roof || "sawtooth";
		const roofC = roofCol(g, roof === "barn" ? "gable" : roof);
		if (roof === "barn") {
			const bc = col("#9b3b2c");
			tb.box(m, hx1, 0, H * 0.7, m, hz1, bc, bc);
			tb.gable(m, hx1, m, hz1, H * 0.7, Math.min(0.25, (alongX ? hz1 - m : hx1 - m) * 0.4), alongX, g.pal("roof_slate"), bc);
		} else {
			tb.prism([[m, m], [hx1, m], [hx1, hz1], [m, hz1]], 0, H, fac.c, roofC, winOf(g, "industrial", H), roof !== "flat");
			if (roof === "sawtooth") {
				tb.pad(m, hx1, m, hz1, H, roofC);
				tb.sawtooth(m, hx1, m, hz1, H, 0.09, Math.max(2, Math.round((hz1 - m) / 0.25)), roofC, col("#7f99a8"));
			} else if (roof === "gable") {
				tb.gable(m, hx1, m, hz1, H, Math.min(0.16, (alongX ? hz1 - m : hx1 - m) * 0.25), alongX, roofC, fac.c);
			} else {
				rooftop(g, m, hx1, m, hz1, H, { rooftop: { hvac: 0.8, bulkhead: 0.4 } });
			}
			if (HR.sign) {
				const sc = col(g.palHex("accent"));
				tb.box(m + 0.1, hx1 - 0.1, H * 0.62, H * 0.86, hz1, hz1 + 0.01, sc);
			}
		}
		for (let j = 0; j < nz; j++) {
			for (let i = 0; i < nx; i++) {
				if ((alongX && j < k) || (!alongX && i < k)) {
					used[j * nx + i] = 1;
				}
			}
		}
	}
	// office in a free front corner
	if (g.rnd() < (R.office ?? 0.4)) {
		const i = nx - 1, j = nz - 1;
		if (!used[j * nx + i]) {
			used[j * nx + i] = 1;
			const x0 = m + i * sx + 0.06, x1 = m + (i + 1) * sx - 0.04, z0 = m + j * sz + 0.06, z1 = m + (j + 1) * sz - 0.04;
			const oh = Math.max(g.st * 2, Math.min(g.st * 4, g.H * 0.3));
			const oc = g.pal(g.pick(["office", "stone", "concrete"]));
			tb.prism([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], 0, oh, oc, col("#5e5f61"), winOf(g, "ribbon", oh / Math.max(1, Math.round(oh / g.st))));
		}
	}
	for (let j = 0; j < nz; j++) {
		for (let i = 0; i < nx; i++) {
			if (!used[j * nx + i]) {
				free.push([i, j]);
			}
		}
	}
	// shuffle the free slots
	for (let k = free.length - 1; k > 0; k--) {
		const r = Math.floor(g.rnd() * (k + 1));
		[free[k], free[r]] = [free[r], free[k]];
	}
	const take = (big) => {
		for (let k = 0; k < free.length; k++) {
			const [i, j] = free[k];
			if (used[j * nx + i]) {
				continue;
			}
			if (big) {
				if (i + 1 >= nx || j + 1 >= nz || used[j * nx + i + 1] || used[(j + 1) * nx + i] || used[(j + 1) * nx + i + 1]) {
					continue;
				}
				used[j * nx + i] = used[j * nx + i + 1] = used[(j + 1) * nx + i] = used[(j + 1) * nx + i + 1] = 1;
				return [m + (i + 1) * sx, m + (j + 1) * sz, Math.min(sx, sz)];
			}
			used[j * nx + i] = 1;
			return [m + (i + 0.5) * sx, m + (j + 0.5) * sz, Math.min(sx, sz) / 2];
		}
		return null;
	};
	for (const f of R.features || []) {
		const n = g.int(f.n ?? 1);
		for (let k = 0; k < n; k++) {
			const big = BIG_FEATURES.has(f.kind) && W * D >= 4;
			const at = take(big) || (big ? take(false) : null);
			if (!at) {
				break;
			}
			const fn = FEATURES[f.kind];
			if (fn) {
				fn(g, at[0], at[1], at[2], f);
			}
		}
	}
}

const BIG_FEATURES = new Set(["cooling", "pit", "solartower", "parking", "furnace"]);

// features: (g, centre x, centre z, radius of the slot, feature rule)
export const FEATURES = {
	chimney(g, x, z, r, f) {
		const h = Math.max(0.5, g.H * (f.scale || 1) * (0.9 + 0.3 * g.rnd()));
		const c = g.pal(g.pick(["brick", "concrete"]));
		g.tb.cyl(x, z, 0.055, 0.04, 0, h, 8, c, true, col(DARK));
		if (h > 0.9) {
			g.tb.cyl(x, z, 0.0415, 0.0405, h * 0.86, h * 0.92, 8, col("#c8392b"), false);
		}
	},
	flare(g, x, z, r, f) {
		const h = Math.max(0.6, g.H * 0.9);
		g.tb.cyl(x, z, 0.02, 0.015, 0, h, 5, col(STEEL), true);
		g.tb.cyl(x, z, 0.03, 0, h, h + 0.08, 5, col("#f2a33a"), false);
	},
	tank(g, x, z, r, f) {
		const rr = Math.min(r * 0.85, 0.12 + 0.12 * g.rnd()) * (f.scale || 1);
		const h = rr * (0.8 + 0.6 * g.rnd());
		const c = col(g.pick(["#d8d8d2", "#c9cbc6", "#e2dfd5"]));
		g.tb.cyl(x, z, rr, rr, 0, h, 10, c, false);
		g.tb.dome(x, z, rr, h, 10, 2, col("#bdbdb7"), 0.25);
	},
	column(g, x, z, r, f) {
		const h = Math.max(0.7, g.H * (0.85 + 0.45 * g.rnd()) * (f.scale || 1));
		const rr = 0.04 + 0.03 * g.rnd();
		g.tb.cyl(x, z, rr, rr, 0, h, 8, col("#b9bbb8"), true, col("#8f918e"));
		for (let y = h * 0.25; y < h; y += h * 0.25) {
			g.tb.cyl(x, z, rr * 1.5, rr * 1.5, y, y + 0.012, 8, col("#6f7275"), true);
		}
	},
	piperack(g, x, z, r) {
		const c = col("#7a7f85"), h = 0.12;
		g.tb.box(x - r * 0.9, x + r * 0.9, h, h + 0.03, z - 0.04, z + 0.04, c);
		for (const dx of [-0.8, 0, 0.8]) {
			g.tb.box(x + dx * r - 0.01, x + dx * r + 0.01, 0, h, z - 0.01, z + 0.01, c);
		}
	},
	cooling(g, x, z, r, f) {
		const s = (f.scale || 1) * Math.min(r * 0.95, 0.5);
		const h = Math.max(0.6, g.H * 0.75) * (f.scale || 1);
		const c = col("#cfccc4");
		g.tb.cyl(x, z, s, s * 0.72, 0, h * 0.6, 12, c, false);
		g.tb.cyl(x, z, s * 0.72, s * 0.66, h * 0.6, h * 0.85, 12, c, false);
		g.tb.cyl(x, z, s * 0.66, s * 0.7, h * 0.85, h, 12, c, false);
	},
	silo(g, x, z, r, f) {
		const s = Math.min(r * 0.8, 0.11) * (f.scale || 1);
		const h = Math.max(0.35, g.H * 0.55) * (f.scale || 1);
		const c = col(g.pick(["#d0cdc5", "#bfc3c6", "#c9c1ae"]));
		g.tb.cyl(x, z, s, s, 0, h, 8, c, false);
		g.tb.cyl(x, z, s, 0, h, h + s * 0.8, 8, col("#9a9c9e"), false);
	},
	kettle(g, x, z, r) {
		const s = Math.min(r * 0.7, 0.1);
		g.tb.cyl(x, z, s, s, 0, s * 1.4, 8, col("#a8673a"), false);
		g.tb.dome(x, z, s, s * 1.4, 8, 2, col("#b87a45"), 0.8);
	},
	furnace(g, x, z, r) {
		const s = Math.min(r * 0.5, 0.18), h = Math.max(0.6, g.H * 0.7);
		g.tb.cyl(x, z, s, s * 0.7, 0, h, 8, col("#5a4a40"), true, col(DARK));
		g.tb.box(x + s * 0.4, x + r * 0.9, h * 0.55, h * 0.62, z - 0.03, z + 0.03, col("#7a7f85"));
		g.tb.cyl(x - r * 0.55, z - r * 0.4, s * 0.45, s * 0.45, 0, h * 0.55, 8, col("#8a5a48"), true);
	},
	headframe(g, x, z, r) {
		const h = Math.max(0.45, g.H * 0.75), c = col("#5f6a72");
		for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
			g.tb.box(x + dx * 0.07 - 0.01, x + dx * 0.07 + 0.01, 0, h, z + dz * 0.07 - 0.01, z + dz * 0.07 + 0.01, c);
		}
		g.tb.box(x - 0.09, x + 0.09, h, h + 0.04, z - 0.09, z + 0.09, c);
		g.tb.cyl(x, z, 0.06, 0.06, h + 0.04, h + 0.05, 8, col("#3f4448"), true);
		g.tb.obox(x + 0.18, z, 0.15, 0.012, 0, h * 0.4, h * 0.45, c);
	},
	pumpjack(g, x, z) {
		const c = col("#4a4c50"), a = col("#c8a032");
		g.tb.box(x - 0.08, x + 0.08, 0, 0.02, z - 0.03, z + 0.03, c);
		g.tb.box(x - 0.012, x + 0.012, 0.02, 0.12, z - 0.012, z + 0.012, c);
		g.tb.obox(x, z, 0.1, 0.012, 0.15, 0.12, 0.14, a);
		g.tb.box(x + 0.08, x + 0.1, 0.03, 0.12, z - 0.02, z + 0.02, a);
	},
	pile(g, x, z, r, f) {
		const s = r * 0.9;
		g.tb.cyl(x, z, s, 0, 0, s * 0.7, 7, col(f.color || g.pick(["#7a6a55", "#8a7a60", "#5f5a52"])), false);
	},
	pit(g, x, z, r) {
		const c0 = col("#6a5a48"), c1 = col("#7d6a52");
		g.tb.pad(x - r * 0.95, x + r * 0.95, z - r * 0.95, z + r * 0.95, 0.008, c0);
		g.tb.pad(x - r * 0.6, x + r * 0.6, z - r * 0.6, z + r * 0.6, 0.012, c1);
	},
	conveyor(g, x, z, r) {
		const c = col("#6f7378");
		g.tb.face2([[x - r, 0.02, z - 0.03], [x + r, 0.3, z - 0.03], [x + r, 0.3, z + 0.03], [x - r, 0.02, z + 0.03]], c);
		g.tb.box(x + r * 0.5 - 0.01, x + r * 0.5 + 0.01, 0, 0.23, z - 0.01, z + 0.01, c);
	},
	farmhouse(g, x, z, r) {
		const s = Math.min(r * 0.7, 0.16), h = 0.14, c = g.pal("stucco");
		g.tb.box(x - s, x + s, 0, h, z - s * 0.7, z + s * 0.7, c);
		g.tb.gable(x - s, x + s, z - s * 0.7, z + s * 0.7, h, 0.1, true, g.pal("roof_tile"), c);
	},
	shed(g, x, z, r) {
		const s = Math.min(r * 0.7, 0.15), c = col("#8a7a62");
		g.tb.box(x - s, x + s, 0, 0.1, z - s * 0.6, z + s * 0.6, c);
		g.tb.gable(x - s, x + s, z - s * 0.6, z + s * 0.6, 0.1, 0.06, true, col("#6b6e72"), c);
	},
	logs(g, x, z, r) {
		const c = col("#8a6340"), e = col("#c8a070");
		for (let k = 0; k < 3; k++) {
			g.tb.box(x - r * 0.8, x + r * 0.8, k * 0.035, (k + 1) * 0.035, z - 0.1 + k * 0.02, z + 0.1 - k * 0.02, c, e);
		}
	},
	pond(g, x, z, r) {
		g.tb.pad(x - r * 0.85, x + r * 0.85, z - r * 0.85, z + r * 0.85, 0.01, col("#3f6f96"));
	},
	parking(g, x, z, r) {
		const c = col("#4a4b4d"), l = col("#d8d8d0");
		g.tb.pad(x - r * 0.95, x + r * 0.95, z - r * 0.95, z + r * 0.95, 0.009, c);
		for (let k = -3; k <= 3; k++) {
			g.tb.pad(x + k * r * 0.25 - 0.006, x + k * r * 0.25 + 0.006, z - r * 0.5, z + r * 0.5, 0.011, l);
		}
	},
	panels(g, x, z, r) {
		const c = col("#2f4a6a"), f = col("#9aa0a6");
		for (const dz of [-0.5, 0, 0.5]) {
			g.tb.face([[x - r * 0.9, 0.03, z + dz * r - 0.06], [x + r * 0.9, 0.03, z + dz * r - 0.06], [x + r * 0.9, 0.07, z + dz * r + 0.04],
				[x - r * 0.9, 0.07, z + dz * r + 0.04]], x, -1, z + dz * r, c);
			g.tb.box(x - 0.01, x + 0.01, 0, 0.04, z + dz * r - 0.01, z + dz * r + 0.01, f);
		}
	},
	solartower(g, x, z, r) {
		const h = Math.max(1, g.H * 0.95);
		g.tb.box(x - 0.06, x + 0.06, 0, h, z - 0.06, z + 0.06, col("#d8d6d0"));
		g.tb.box(x - 0.08, x + 0.08, h, h + 0.12, z - 0.08, z + 0.08, col("#f4e9b8"));
	},
};

export function fuelstation(g) {
	const { tb, W, D } = g;
	lot(g, "lot_paved");
	const shopC = g.pal("stucco");
	tb.box(0.1, Math.min(0.45, W * 0.45), 0, 0.14, 0.1, Math.min(0.4, D - 0.1), shopC, col("#5e5f61"), winOf(g, "shop", 0.14));
	const cx = W * 0.65, cz = D * 0.55, ac = g.company || col(g.palHex("accent"));
	for (const [dx, dz] of [[-0.18, -0.12], [0.18, -0.12], [-0.18, 0.12], [0.18, 0.12]]) {
		tb.box(cx + dx - 0.012, cx + dx + 0.012, 0, 0.17, cz + dz - 0.012, cz + dz + 0.012, col("#d8d8d8"));
	}
	tb.box(cx - 0.24, cx + 0.24, 0.17, 0.2, cz - 0.17, cz + 0.17, ac, col(WHITE));
	for (const dx of [-0.1, 0.1]) {
		tb.box(cx + dx - 0.02, cx + dx + 0.02, 0, 0.06, cz - 0.03, cz + 0.03, col("#c8c8c8"));
	}
}

export function turbine(g) {
	const { tb, W, D } = g;
	const x = W / 2, z = D / 2, h = Math.max(1.2, g.H * 0.9), c = col("#ecece6");
	tb.cyl(x, z, 0.035, 0.018, 0, h, 6, c, false);
	tb.box(x - 0.03, x + 0.05, h - 0.02, h + 0.03, z - 0.02, z + 0.02, c);
	for (let k = 0; k < 3; k++) {
		const a = (k / 3) * Math.PI * 2 + 0.3;
		const ex = Math.cos(a) * h * 0.38, ey = Math.sin(a) * h * 0.38;
		tb.face2([[x + 0.055, h, z - 0.012], [x + 0.055, h, z + 0.012], [x + 0.055, h + ey, z + ex]], c);
	}
}

export function solar(g) {
	const { W, D } = g;
	lot(g, "lot_paved");
	if (/pond/i.test(g.d.name)) {
		FEATURES.pond(g, W / 2, D / 2, Math.min(W, D) / 2 - 0.05);
		return;
	}
	for (let i = 0; i < W * 2; i++) {
		for (let j = 0; j < D * 2; j++) {
			FEATURES.panels(g, (i + 0.5) / 2, (j + 0.5) / 2, 0.22);
		}
	}
}

export function oilrig(g) {
	const { tb, W, D } = g;
	const y = 0.35, c = col("#6f747a"), deck = col("#8a8d90");
	for (const [x, z] of [[0.5, 0.5], [W - 0.5, 0.5], [0.5, D - 0.5], [W - 0.5, D - 0.5]]) {
		tb.cyl(x, z, 0.07, 0.06, -0.6, y, 6, c, false);
	}
	tb.box(0.3, W - 0.3, y, y + 0.08, 0.3, D - 0.3, c, deck);
	tb.box(0.5, W * 0.55, y + 0.08, y + 0.3, 0.5, D * 0.5, col("#d8d6d0"), col("#5e5f61"), winOf(g, "punched", 0.11));
	const dx = W * 0.72, dz = D * 0.35, h = Math.max(1.2, g.H * 0.7);
	tb.cyl(dx, dz, 0.18, 0.03, y + 0.08, y + h, 4, col("#c8392b"), false, null, null, Math.PI / 4);
	tb.cyl(W * 0.72, D * 0.72, 0.16, 0.16, y + 0.08, y + 0.1, 8, col("#3a6a3a"), true);
	FEATURES.flare(g, W - 0.35, D * 0.7, 0.1, {});
}

export function buoys(g) {
	const { tb, W, D } = g;
	for (let k = 0; k < 3; k++) {
		const x = 0.3 + (W - 0.6) * g.rnd(), z = 0.3 + (D - 0.6) * g.rnd();
		tb.cyl(x, z, 0.03, 0.02, -0.02, 0.05, 5, col("#e05a2a"), true);
	}
}

