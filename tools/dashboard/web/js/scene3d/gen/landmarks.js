// Simutrans-Horizon dashboard, 3D view: landmarks of the procedural buildings (worker side): churches, towers, parks,
// stadiums, monuments, town halls and company headquarters. Artistic License, see LICENSE.txt.
import { col } from "./tbuf.js";
import { STEEL, WHITE, facadeOf, lot, tree, winOf } from "./common.js";
import { block } from "./block.js";

function plinthBase(g, x0, x1, z0, z1, h, c) {
	g.tb.box(x0, x1, -0.03, h, z0, z1, c || col("#bdb6a6"));
	return h;
}

export function church(g) {
	const { tb, W, D } = g;
	const fac = facadeOf(g);
	lot(g, "lot_green");
	const long = D >= W;
	const nw = Math.min(W, D) * 0.42, h = Math.max(0.25, Math.min(g.H * 0.45, 0.55));
	const cx = W / 2, cz = D / 2;
	const x0 = long ? cx - nw / 2 : 0.1, x1 = long ? cx + nw / 2 : W - 0.25;
	const z0 = long ? 0.25 : cz - nw / 2, z1 = long ? D - 0.1 : cz + nw / 2;
	tb.box(x0, x1, 0, h, z0, z1, fac.c, null, winOf(g, "tall", h));
	tb.gable(x0, x1, z0, z1, h, nw * 0.6, !long, g.pal("roof_slate"), fac.c);
	// tower at the front (south or east end)
	const tw = nw * 0.55, th = Math.max(h * 1.8, g.H * 0.75);
	const tx = long ? cx : x1 + tw * 0.4, tz = long ? z1 - tw * 0.4 : cz;
	tb.box(tx - tw / 2, tx + tw / 2, 0, th, tz - tw / 2, tz + tw / 2, fac.c, null, winOf(g, "tall", th / 3));
	tb.cyl(tx, tz, tw * 0.72, 0, th, th + Math.max(0.25, g.H * 0.35), 4, g.pal(g.pick(["roof_slate", "roof_copper"])), false, null, null, Math.PI / 4);
}

export function cathedral(g) {
	const { tb, W, D } = g;
	const fac = facadeOf(g);
	const cx = W / 2, cz = D / 2, s = Math.min(W, D) * 0.33, h = Math.max(0.25, g.H * 0.35);
	tb.box(cx - s, cx + s, 0, h, cz - s, cz + s, fac.c, null, winOf(g, "tall", h / 2));
	const domeC = col(g.pick(["#3f8a5a", "#c8a032", "#3a6aa8"]));
	const drum = (x, z, r, y0, y1) => {
		tb.cyl(x, z, r, r, y0, y1, 8, fac.c, false);
		tb.dome(x, z, r * 1.25, y1, 8, 3, domeC, 1.3, 0.35);
		tb.cyl(x, z, r * 0.12, 0, y1 + r * 1.6, y1 + r * 2.4, 4, col("#e0c050"), false);
	};
	drum(cx, cz, s * 0.45, h, Math.max(h * 1.9, g.H * 0.7));
	for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
		drum(cx + dx * s * 0.7, cz + dz * s * 0.7, s * 0.22, h, h * 1.45);
	}
}

export function mosque(g) {
	const { tb, W, D } = g;
	const fac = facadeOf(g);
	const cx = W / 2, cz = D / 2, s = Math.min(W, D) * 0.3, h = Math.max(0.2, g.H * 0.3);
	tb.box(cx - s, cx + s, 0, h, cz - s, cz + s, fac.c, null, winOf(g, "tall", h));
	tb.cyl(cx, cz, s * 0.8, s * 0.8, h, h + 0.04, 8, fac.c, false);
	tb.dome(cx, cz, s * 0.8, h + 0.04, 10, 3, col("#5f9ab0"), 1);
	for (const dx of [-1, 1]) {
		const x = cx + dx * (s + 0.08), mh = Math.max(h * 2.4, g.H * 0.9);
		tb.cyl(x, cz + s * 0.6, 0.035, 0.03, 0, mh, 6, fac.c, false);
		tb.cyl(x, cz + s * 0.6, 0.04, 0, mh, mh + 0.1, 6, col("#5f9ab0"), false);
	}
}

export function mast(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, h = Math.max(1.2, g.H);
	const c = col(/futur/i.test(g.d.name) ? "#d8dde2" : "#bfbcb4");
	lot(g, "lot_paved", cx - 0.25, cx + 0.25, cz - 0.25, cz + 0.25);
	tb.cyl(cx, cz, 0.09, 0.05, 0, h * 0.72, 8, c, false);
	tb.cyl(cx, cz, 0.05, 0.16, h * 0.72, h * 0.76, 10, c, false);
	tb.cyl(cx, cz, 0.16, 0.14, h * 0.76, h * 0.82, 10, col("#5f7f96"), false);
	tb.cyl(cx, cz, 0.14, 0.05, h * 0.82, h * 0.84, 10, c, true);
	tb.cyl(cx, cz, 0.04, 0.008, h * 0.84, h, 5, col("#d84030"), false);
	if (/radio/i.test(g.d.name)) {
		tb.box(cx + 0.15, cx + 0.35, 0, 0.12, cz - 0.1, cz + 0.1, col("#c9c3b4"), col("#5e5f61"), winOf(g, "punched", 0.12));
	}
}

export function lighthouse(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, h = Math.max(0.6, g.H * 0.85);
	tb.cyl(cx, cz, 0.12, 0.08, 0, h * 0.4, 8, col(WHITE), false);
	tb.cyl(cx, cz, 0.08, 0.07, h * 0.4, h * 0.7, 8, col("#c8392b"), false);
	tb.cyl(cx, cz, 0.07, 0.065, h * 0.7, h * 0.86, 8, col(WHITE), false);
	tb.cyl(cx, cz, 0.06, 0.06, h * 0.86, h * 0.94, 8, col("#f4e08a"), false);
	tb.cyl(cx, cz, 0.075, 0, h * 0.94, h, 8, col("#3a3a3a"), false);
	tb.box(cx + 0.1, cx + 0.32, 0, 0.12, cz - 0.1, cz + 0.08, col(WHITE));
	tb.gable(cx + 0.1, cx + 0.32, cz - 0.1, cz + 0.08, 0.12, 0.06, true, g.pal("roof_tile"), col(WHITE));
}

export function clocktower(g) {
	const { tb, W, D } = g;
	const fac = facadeOf(g);
	const cx = W / 2, cz = D / 2, s = 0.13, h = Math.max(0.7, g.H * 0.8);
	tb.box(cx - s, cx + s, 0, h, cz - s, cz + s, fac.c, null, winOf(g, "tall", h / 4));
	for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
		const x = cx + dx * (s + 0.003), z = cz + dz * (s + 0.003), y = h * 0.86;
		tb.face([[x - dz * 0.06, y - 0.06, z - dx * 0.06], [x + dz * 0.06, y - 0.06, z + dx * 0.06], [x + dz * 0.06, y + 0.06, z + dx * 0.06],
			[x - dz * 0.06, y + 0.06, z - dx * 0.06]], cx, y, cz, col(WHITE));
	}
	tb.hip(cx - s, cx + s, cz - s, cz + s, h, 0.3, g.pal(g.pick(["roof_copper", "roof_slate"])), 0.02);
}

export function castle(g) {
	const { tb, W, D } = g;
	const ruin = /ruin/i.test(g.d.name);
	const c = col(g.pick(["#a39a88", "#9a907c", "#b0a690"]));
	const h = ruin ? 0.12 : Math.max(0.2, Math.min(0.4, g.H * 0.35));
	const m = 0.12, t = 0.05;
	if (W >= 2 || D >= 2) {
		lot(g, "lot_green");
		const walls = [[m, W - m, m, m + t], [m, W - m, D - m - t, D - m], [m, m + t, m, D - m], [W - m - t, W - m, m, D - m]];
		walls.forEach((w, k) => {
			const wh = ruin ? h * (0.4 + 0.6 * g.rnd()) : h;
			if (!ruin || k !== 1) {
				tb.box(w[0], w[1], 0, wh, w[2], w[3], c);
			}
		});
		for (const [x, z] of [[m, m], [W - m, m], [m, D - m], [W - m, D - m]]) {
			const th = ruin ? h * (0.8 + g.rnd()) : h * 1.6;
			tb.cyl(x, z, 0.09, 0.08, 0, th, 8, c, true);
			if (!ruin) {
				tb.cyl(x, z, 0.1, 0, th, th + 0.15, 8, g.pal("roof_slate"), false);
			}
		}
		if (!ruin) {
			const s = Math.min(W, D) * 0.18;
			tb.box(W / 2 - s, W / 2 + s, 0, h * 2.2, D / 2 - s, D / 2 + s, c, null, winOf(g, "tall", h * 0.7));
			tb.hip(W / 2 - s, W / 2 + s, D / 2 - s, D / 2 + s, h * 2.2, s * 1.2, g.pal("roof_slate"));
		}
	} else {
		arch(g);
	}
}

export function arch(g) {
	const { tb, W, D } = g;
	const c = col(g.pick(["#d8d0bc", "#c9bfa8"])), cx = W / 2, cz = D / 2, h = Math.max(0.3, Math.min(0.6, g.H * 0.6));
	tb.box(cx - 0.3, cx - 0.14, 0, h, cz - 0.1, cz + 0.1, c);
	tb.box(cx + 0.14, cx + 0.3, 0, h, cz - 0.1, cz + 0.1, c);
	tb.box(cx - 0.32, cx + 0.32, h, h + 0.12, cz - 0.11, cz + 0.11, c);
}

export function ruins(g) {
	const { tb, W, D } = g;
	const c = col("#9a907c");
	lot(g, "lot_green");
	for (let k = 0; k < 4; k++) {
		const x = 0.2 + (W - 0.4) * g.rnd(), z = 0.2 + (D - 0.4) * g.rnd();
		tb.box(x - 0.12, x + 0.12, 0, 0.04 + 0.1 * g.rnd(), z - 0.02, z + 0.02, c);
	}
}

export function park(g) {
	const { tb, W, D } = g;
	lot(g, "lot_green", 0, W, 0, D);
	const path = col("#d2c6a4");
	tb.pad(W / 2 - 0.04, W / 2 + 0.04, 0.02, D - 0.02, 0.009, path);
	tb.pad(0.02, W - 0.02, D / 2 - 0.04, D / 2 + 0.04, 0.009, path);
	if (W * D >= 2) {
		tb.cyl(W / 2, D / 2, 0.14, 0.14, 0, 0.03, 10, col("#cfc8b6"), true, col("#4f88b0"));
		tb.cyl(W / 2, D / 2, 0.02, 0.015, 0.03, 0.12, 5, col("#cfc8b6"), true);
	}
	const n = Math.min(14, Math.round(W * D * 3));
	for (let k = 0; k < n; k++) {
		const x = 0.1 + (W - 0.2) * g.rnd(), z = 0.1 + (D - 0.2) * g.rnd();
		if (Math.abs(x - W / 2) < 0.08 || Math.abs(z - D / 2) < 0.08) {
			continue;
		}
		tree(g, x, z, 0.8 + 0.5 * g.rnd(), g.rnd() < 0.3);
	}
}

export function stadium(g) {
	const { tb, W, D } = g;
	const tennis = /tennis/i.test(g.d.name);
	const pitch = col(tennis ? "#b4553a" : "#4f9a45"), line = col(WHITE);
	const m = tennis ? 0.25 : 0.32;
	tb.pad(0.04, W - 0.04, 0.04, D - 0.04, 0.006, col(tennis ? "#4f8a45" : "#8a8a86"));
	tb.pad(m, W - m, m, D - m, 0.009, pitch);
	tb.pad(W / 2 - 0.006, W / 2 + 0.006, m, D - m, 0.011, line);
	if (tennis) {
		tb.box(W / 2 - 0.004, W / 2 + 0.004, 0, 0.05, m, D - m, col("#e8e8e8"));
		return;
	}
	const h = Math.max(0.15, Math.min(0.35, g.H * 0.5)), c = col("#c8c4bc"), seat = col(g.pick(["#3a6aa8", "#b23a2e", "#3b7a46"]));
	const st = (x0, x1, z0, z1, dirX, dirZ) => {
		const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
		const lo = dirX ? [[x0, 0, z0], [x0, 0, z1]] : [[x0, 0, z0], [x1, 0, z0]];
		tb.box(x0, x1, 0, h * 0.3, z0, z1, c);
		// sloped seating towards the pitch
		if (dirX) {
			const xa = dirX > 0 ? x0 : x1, xb = dirX > 0 ? x1 : x0;
			tb.face([[xa, h * 0.3, z0], [xa, h * 0.3, z1], [xb, h, z1], [xb, h, z0]], cx, 0, cz, seat);
			tb.face([[xb, h, z0], [xb, h, z1], [xb, 0, z1], [xb, 0, z0]], cx, h / 2, cz, c);
		} else {
			const za = dirZ > 0 ? z0 : z1, zb = dirZ > 0 ? z1 : z0;
			tb.face([[x0, h * 0.3, za], [x1, h * 0.3, za], [x1, h, zb], [x0, h, zb]], cx, 0, cz, seat);
			tb.face([[x0, h, zb], [x1, h, zb], [x1, 0, zb], [x0, 0, zb]], cx, h / 2, cz, c);
		}
		return lo;
	};
	st(0.05, m - 0.02, 0.05, D - 0.05, -1, 0);
	st(W - m + 0.02, W - 0.05, 0.05, D - 0.05, 1, 0);
	st(m, W - m, 0.05, m - 0.02, 0, -1);
	st(m, W - m, D - m + 0.02, D - 0.05, 0, 1);
}

export function wheel(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, r = Math.max(0.3, Math.min(0.42, g.H * 0.3)), y = r + 0.08, c = col("#e8e8e8");
	tb.box(cx - 0.2, cx + 0.2, 0, 0.02, cz - 0.15, cz + 0.15, col("#9a9a96"));
	const n = 12;
	for (let k = 0; k < n; k++) {
		const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
		const p0 = [cx + Math.cos(a0) * r, y + Math.sin(a0) * r], p1 = [cx + Math.cos(a1) * r, y + Math.sin(a1) * r];
		tb.face([[p0[0], p0[1], cz - 0.01], [p1[0], p1[1], cz - 0.01], [p1[0], p1[1], cz + 0.01], [p0[0], p0[1], cz + 0.01]], cx, y, cz, c);
		tb.box(p0[0] - 0.02, p0[0] + 0.02, p0[1] - 0.04, p0[1], cz - 0.02, cz + 0.02, col(["#d84030", "#3a6aa8", "#e0b030"][k % 3]));
	}
	for (const dx of [-1, 1]) {
		tb.face2([[cx + dx * 0.15, 0, cz - 0.03], [cx + dx * 0.15, 0, cz + 0.03], [cx, y, cz]], c);
	}
}

export function windmill(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, h = Math.max(0.35, g.H * 0.8), c = col("#d8cbb0");
	tb.cyl(cx, cz, 0.12, 0.08, 0, h, 8, c, false);
	tb.dome(cx, cz, 0.09, h, 8, 2, col("#5e4a3a"), 1);
	for (let k = 0; k < 4; k++) {
		const a = (k / 4) * Math.PI * 2 + 0.4;
		tb.face2([[cx - 0.02, h, cz + 0.12], [cx + 0.02, h, cz + 0.12], [cx + Math.cos(a) * 0.32, h + Math.sin(a) * 0.32, cz + 0.12]], col("#efe8d8"));
	}
}

export function pagoda(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, n = 4, c = col("#b8402e"), r = col("#3f4a4a");
	let y = 0, s = 0.26;
	const h = Math.max(0.08, g.H / (n * 1.6));
	for (let k = 0; k < n; k++) {
		tb.box(cx - s * 0.7, cx + s * 0.7, y, y + h, cz - s * 0.7, cz + s * 0.7, c);
		tb.hip(cx - s, cx + s, cz - s, cz + s, y + h, h * 0.5, r, 0);
		y += h * 1.4;
		s *= 0.82;
	}
	tb.cyl(cx, cz, 0.015, 0, y, y + 0.15, 4, col("#c8a032"), false);
}

export function steppyramid(g) {
	const { tb, W, D } = g;
	const c = col("#b8ad92"), n = 5, h = Math.max(0.06, g.H * 0.18 + 0.05);
	let s = Math.min(W, D) / 2 - 0.08;
	for (let k = 0; k < n; k++) {
		tb.box(W / 2 - s, W / 2 + s, k * h, (k + 1) * h, D / 2 - s, D / 2 + s, c);
		s *= 0.78;
	}
	tb.box(W / 2 - s, W / 2 + s, n * h, n * h + h * 1.4, D / 2 - s, D / 2 + s, col("#a0957a"));
}

export function observatory(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, fac = facadeOf(g);
	tb.cyl(cx, cz, 0.22, 0.22, 0, 0.18, 10, fac.c, false);
	tb.dome(cx, cz, 0.22, 0.18, 10, 3, col("#cfd4d8"), 1);
}

export function radar(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, h = Math.max(0.3, g.H * 0.5);
	tb.box(cx - 0.07, cx + 0.07, 0, h, cz - 0.07, cz + 0.07, col("#bdbab2"));
	if (/military/i.test(g.d.name)) {
		tb.obox(cx, cz, 0.2, 0.02, 0.5, h, h + 0.12, col(WHITE));
	} else {
		tb.cyl(cx, cz, 0.12, 0.12, h, h + 0.02, 10, col(WHITE), false);
		tb.dome(cx, cz, 0.13, h + 0.02, 10, 3, col(WHITE), 1);
	}
}

export function tent(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, r = Math.min(W, D) * 0.4, h = Math.max(0.3, g.H * 0.5);
	const n = 12;
	for (let k = 0; k < n; k++) {
		const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, c = col(k % 2 ? "#d84030" : WHITE);
		tb.face([[cx + Math.cos(a0) * r, 0, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, 0, cz + Math.sin(a1) * r],
			[cx + Math.cos(a1) * r, h * 0.35, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, h * 0.35, cz + Math.sin(a0) * r]], cx, h * 0.2, cz, c);
		tb.face([[cx + Math.cos(a0) * r, h * 0.35, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, h * 0.35, cz + Math.sin(a1) * r], [cx, h, cz]],
			cx, h * 0.3, cz, c);
	}
	tb.cyl(cx, cz, 0.012, 0.008, h, h + 0.12, 4, col("#c8a032"), false);
}

export function market(g) {
	const { tb, W, D } = g;
	lot(g, "lot_paved", 0.02, W - 0.02, 0.02, D - 0.02);
	for (let i = 0; i < W * 2; i++) {
		for (let j = 0; j < D * 2; j++) {
			const x = (i + 0.5) / 2, z = (j + 0.5) / 2, c = col(g.pick(["#d84030", "#e0b030", "#3a6aa8", "#3b7a46", WHITE]));
			tb.box(x - 0.1, x + 0.1, 0, 0.06, z - 0.08, z + 0.08, col("#8a7050"));
			tb.gable(x - 0.13, x + 0.13, z - 0.1, z + 0.1, 0.09, 0.05, true, c, c, 0);
		}
	}
}

export function greenhouse(g) {
	const { tb, W, D } = g;
	const glass = col("#a8c8c8"), x0 = 0.12, x1 = W - 0.12, z0 = 0.12, z1 = D - 0.12;
	tb.box(x0, x1, 0, 0.12, z0, z1, glass, glass, winOf(g, "curtain", 0.06));
	tb.gable(x0, x1, z0, z1, 0.12, 0.1, W >= D, glass, glass, 0);
}

export function rock(g) {
	const { tb, W, D } = g;
	const c = col("#8a857a");
	tb.cyl(W / 2, D / 2, Math.min(W, D) * 0.4, Math.min(W, D) * 0.15, 0, Math.max(0.2, g.H * 0.5), 7, c, true, col("#9a958a"));
}

export function statue(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2;
	lot(g, "lot_paved", cx - 0.3, cx + 0.3, cz - 0.3, cz + 0.3);
	const ph = plinthBase(g, cx - 0.1, cx + 0.1, cz - 0.1, cz + 0.1, 0.1, col("#c9c1ad"));
	const bronze = col(g.pick(["#5f8a76", "#6b5a3a", "#9a9a96"]));
	const bust = /bust/i.test(g.d.name);
	if (bust) {
		tb.cyl(cx, cz, 0.04, 0.03, ph, ph + 0.05, 6, bronze, false);
		tb.dome(cx, cz, 0.035, ph + 0.05, 6, 2, bronze, 1.2);
		return;
	}
	const h = Math.max(0.12, Math.min(0.3, g.H * 0.4));
	tb.cyl(cx, cz, 0.035, 0.025, ph, ph + h * 0.7, 6, bronze, false);
	tb.dome(cx, cz, 0.022, ph + h * 0.7, 6, 2, bronze, 1.3);
	tb.obox(cx, cz, 0.06, 0.012, 0.3, ph + h * 0.5, ph + h * 0.56, bronze);
}

export function obelisk(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2, h = Math.max(0.4, g.H * 0.8);
	lot(g, "lot_paved", cx - 0.25, cx + 0.25, cz - 0.25, cz + 0.25);
	const ph = plinthBase(g, cx - 0.09, cx + 0.09, cz - 0.09, cz + 0.09, 0.06);
	tb.cyl(cx, cz, 0.05, 0.03, ph, ph + h, 4, col("#d8d0bc"), true, col("#d8d0bc"), null, Math.PI / 4);
	tb.cyl(cx, cz, 0.032, 0, ph + h, ph + h + 0.05, 4, col("#c8a032"), false, null, null, Math.PI / 4);
}

export function fountain(g) {
	const { tb, W, D } = g;
	const cx = W / 2, cz = D / 2;
	tb.cyl(cx, cz, 0.36, 0.36, 0, 0.012, 12, col("#bcb6a6"), true, col("#7aa055"));
	tb.cyl(cx, cz, 0.14, 0.14, 0.012, 0.04, 10, col("#cfc8b6"), true, col("#4f88b0"));
	tb.cyl(cx, cz, 0.02, 0.015, 0.04, 0.16, 5, col("#cfc8b6"), true);
}

/** Classical civic building: steps, columns, pediment. */
export function temple(g) {
	const { tb, W, D } = g;
	const fac = facadeOf(g);
	lot(g, "lot_paved");
	const big = W * D >= 4;
	const x0 = big ? W * 0.2 : 0.12, x1 = big ? W * 0.8 : W - 0.12, z0 = big ? D * 0.15 : 0.12, z1 = big ? D * 0.7 : D - 0.25;
	const h = Math.max(0.22, Math.min(0.6, g.H * 0.6));
	if (big) {
		for (let k = 0; k < 6; k++) {
			tree(g, k < 3 ? 0.25 : W - 0.25, 0.4 + (k % 3) * (D - 0.8) / 2, 0.9, false);
		}
	}
	tb.box(x0 - 0.03, x1 + 0.03, 0, 0.03, z0 - 0.03, D - 0.06, col("#cfc8b6"));
	tb.box(x0, x1, 0.03, h, z0, z1, fac.c, null, winOf(g, "tall", (h - 0.03) / Math.max(1, Math.round((h - 0.03) / g.st))));
	const pz = big ? z1 + 0.14 : D - 0.12, n = Math.min(10, Math.max(4, Math.round((x1 - x0) / 0.12)));
	for (let k = 0; k < n; k++) {
		const x = x0 + 0.03 + (k * (x1 - x0 - 0.06)) / (n - 1);
		tb.cyl(x, pz, 0.018, 0.015, 0.03, h, 6, col("#efe9dc"), false);
	}
	tb.box(x0, x1, h, h + 0.03, z0, pz + 0.04, fac.c, col("#cfc8b6"));
	tb.gable(x0, x1, z0, pz + 0.04, h + 0.03, Math.min(0.3, (x1 - x0) * 0.16), false, g.pal(g.rnd() < 0.35 ? "roof_copper" : "roof_slate"), col("#e9e3d3"));
	if (big) {
		tb.cyl(W / 2, (z0 + z1) / 2, 0.15, 0.15, h + 0.03, h + 0.1, 10, fac.c, false);
		tb.dome(W / 2, (z0 + z1) / 2, 0.15, h + 0.1, 10, 3, g.pal("roof_copper"), 1);
	}
}

export function townhall(g) {
	const { tb, W, D } = g;
	const fac = facadeOf(g);
	lot(g, "lot_paved");
	const big = (g.d.level | 0) >= 75;
	const H = Math.max(0.35, Math.min(big ? 1.4 : 0.7, g.H * 0.55));
	const r = block(g, { H, roof: g.rnd() < 0.5 ? "hip" : "mansard", ground: "none", windows: "tall", facade: fac, solid: true, roofMax: 0.2,
		P: Object.assign({}, g.P, { inset: { low: [0.12, 0.16], high: [0.1, 0.14] }, tower: null, roofPalettes: g.P.roofPalettes || { hip: ["roof_slate", "roof_copper"] } }) });
	// clock tower over the front
	const s = Math.min(0.16, (r.x1 - r.x0) * 0.16), cx = W / 2, cz = r.z1 - s;
	const th = H * (big ? 1.8 : 1.6) + 0.1;
	tb.box(cx - s, cx + s, 0, th, cz - s, cz + s + 0.04, fac.c, null, winOf(g, "tall", th / 5));
	tb.face([[cx - 0.05, th * 0.86 - 0.05, cz + s + 0.044], [cx + 0.05, th * 0.86 - 0.05, cz + s + 0.044], [cx + 0.05, th * 0.86 + 0.05, cz + s + 0.044],
		[cx - 0.05, th * 0.86 + 0.05, cz + s + 0.044]], cx, th * 0.86, cz, col(WHITE));
	tb.hip(cx - s, cx + s, cz - s, cz + s + 0.04, th, s * 2.2, g.pal(g.pick(["roof_copper", "roof_slate"])), 0.02);
	tb.cyl(cx, cz + 0.02, 0.008, 0.004, th + s * 2.2, th + s * 2.2 + 0.12, 4, col("#c8a032"), false);
}

export function headquarters(g) {
	const { tb, W, D } = g;
	const comp = g.company || col("#5a6a8a");
	if ((g.d.height | 0) >= 8) {
		const r = block(g, { roof: "flat", ground: "shop", P: Object.assign({}, g.P, {
			inset: { low: [0.25, 0.3], high: [0.25, 0.32] }, tower: { minLevels: 0, chance: 1, setbacks: [1, 2], step: [0.08, 0.14], crown: { flat: 1 } },
			rooftop: { bulkhead: 1, antenna: 1 } }) });
		// company band over the ground floor (a ring of walls, no top) and a crown
		const e = 0.008;
		tb.prism([[r.x0 - e, r.z0 - e], [r.x1 + e, r.z0 - e], [r.x1 + e, r.z1 + e], [r.x0 - e, r.z1 + e]], g.st, g.st * 1.3, comp, null, null, true);
		const [a0, a1, b0, b1] = r.top, m = Math.min(0.06, (a1 - a0) * 0.2);
		tb.box(a0 + m, a1 - m, r.H, r.H + 0.06, b0 + m, b1 - m, comp, comp);
	} else {
		lot(g, "lot_green");
		const fac = facadeOf(g, [{ palette: "office", w: 1 }, { palette: "stone", w: 1 }]);
		const h = Math.max(g.st * 2, g.H * 0.8);
		const x0 = 0.35, x1 = W - 0.35, z0 = 0.5, z1 = D - 0.6;
		tb.box(x0, x1, 0, h, z0, z1, fac.c, col("#5e5f61"), winOf(g, "ribbon", h / Math.max(1, Math.round(h / g.st))));
		tb.prism([[x0 - 0.01, z0 - 0.01], [x1 + 0.01, z0 - 0.01], [x1 + 0.01, z1 + 0.01], [x0 - 0.01, z1 + 0.01]], h - 0.04, h + 0.01, comp, null, null, true);
		tb.box(W / 2 - 0.25, W / 2 + 0.25, 0, g.st * 1.1, z1, z1 + 0.25, col("#a8c4cc"), comp, winOf(g, "curtain", g.st));
		// a company-coloured field on the roof (seen from every side) and a sign board over the entrance
		const lw = Math.min(x1 - x0, z1 - z0) * 0.22;
		tb.pad(W / 2 - lw, W / 2 + lw, (z0 + z1) / 2 - lw, (z0 + z1) / 2 + lw, h + 0.003, comp);
		tb.box(W / 2 - 0.2, W / 2 + 0.2, h + 0.01, h + 0.1, z1 - 0.03, z1 - 0.01, comp, comp);
		tb.pad(W / 2 - 0.06, W / 2 + 0.06, z1 + 0.25, D - 0.04, 0.008, col("#cfc8b6"));
	}
	// flag pole with the company colour
	const fx = W - 0.25, fz = D - 0.25;
	tb.box(fx - 0.006, fx + 0.006, 0, 0.45, fz - 0.006, fz + 0.006, col(STEEL));
	tb.face2([[fx, 0.33, fz], [fx + 0.14, 0.33, fz], [fx + 0.14, 0.43, fz], [fx, 0.43, fz]], comp);
}

