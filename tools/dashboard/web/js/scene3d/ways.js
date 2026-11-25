// Simutrans-Horizon dashboard, 3D view: the transport network of a chunk (worker side, no three.js): ways with a
// look per way type (road, highway, rail, narrow gauge, tram, monorail, maglev, river, canal, runway, taxiway), their
// slopes, elevated ways and bridge decks with railings and supports, bridge heads, bridge pillars, tunnel portals,
// overhead lines, signals and signs (arrows painted on runways and taxiways), power lines and level crossings. Ways are bands along the pieces of wayshape.js,
// with a cross-section profile of strips. Artistic License, see LICENSE.txt.
import { rgb8, rgbLin } from "./meshbuf.js";
import { K, SW, SE, NE, NW } from "./decode.js";
import { N, E, S, W, DIRS, MID, STEP, INWARD, wayPieces, slopeOffsets, slopeAt, arcLengths, pointAt, axisOf, highSide,
	bitCount } from "./wayshape.js";

export const WT = { road: 0, track: 1, water: 2, monorail: 3, maglev: 4, tram: 5, narrowgauge: 6, air: 7, other: 8 };
// waytype numbers of the engine (wayobj b)
export const WT_NUM = { 1: "road", 2: "track", 3: "water", 5: "monorail", 6: "maglev", 7: "tram", 8: "narrowgauge", 16: "air" };

const DECK_GAP = 0.006; // deck top below the way surface
const WIRE_H = 0.47; // contact wire above the rails

// --- profiles ---------------------------------------------------------------------------------------------

function strip(o0, o1, h0, h1, rgb, extra) {
	return Object.assign({ o0, o1, h0, h1, c: rgb8(rgb) }, extra || {});
}

/** A strip and its mirror image: [o0, o1] right of the centre line with heights h0 at o0 and h1 at o1. */
function pair(o0, o1, h0, h1, rgb, extra) {
	return [strip(-o1, -o0, h1, h0, rgb, extra), strip(o0, o1, h0, h1, rgb, extra)];
}

const ASPHALT = [0.37, 0.37, 0.39], ASPHALT_DARK = [0.27, 0.27, 0.29], SIDEWALK = [0.68, 0.67, 0.64], KERB = [0.8, 0.79, 0.76];
const LINE_W = [0.93, 0.93, 0.9], LINE_Y = [0.95, 0.78, 0.22];
const BALLAST = [0.53, 0.5, 0.46], SLEEPER_WOOD = [0.36, 0.27, 0.2], SLEEPER_CONC = [0.66, 0.65, 0.62], RAIL = [0.66, 0.66, 0.68];
const RAIL_DARK = [0.3, 0.3, 0.32], CONCRETE = [0.66, 0.66, 0.64], STEEL_GIRDER = [0.38, 0.42, 0.48];
const WATER = [0.23, 0.44, 0.66], BANK = [0.47, 0.44, 0.33], CANAL_WALL = [0.6, 0.58, 0.54];

function roadStyle(d) {
	const name = d.name || "", speed = d.speed | 0;
	if (/highway|autobahn|motorway|freeway|expressway/i.test(name) || speed >= 100) {
		return {
			key: "highway", hw: 0.44, inner: 0.37,
			strips: [...pair(0.37, 0.44, 0, 0, [0.42, 0.42, 0.43]), strip(-0.37, 0.37, 0, 0, ASPHALT_DARK),
				...pair(0.345, 0.36, 0.002, 0.002, LINE_W), ...pair(0.008, 0.022, 0.002, 0.002, LINE_Y)],
			centre: { wa: 0.37, ws: 0.44, cA: rgb8(ASPHALT_DARK), cS: rgb8([0.42, 0.42, 0.43]) },
			dash: { o: [-0.19, 0.19], w: 0.012, len: 0.14, period: 1 / 3, h: 0.002, c: rgb8(LINE_W) },
		};
	}
	if (speed <= 30) {
		const dirt = [0.55, 0.5, 0.42];
		return { key: "dirt", hw: 0.26, inner: 0.26, strips: [strip(-0.26, 0.26, 0, 0, dirt)],
			centre: { wa: 0.26, ws: 0.26, cA: rgb8(dirt), cS: rgb8(dirt) } };
	}
	const wide = speed >= 70;
	const wa = wide ? 0.33 : 0.27, ws = wide ? 0.43 : 0.37;
	return {
		key: wide ? "avenue" : "road", hw: ws, inner: wa,
		strips: [...pair(wa + 0.012, ws, 0.008, 0.008, SIDEWALK), ...pair(wa, wa + 0.012, 0.008, 0.008, KERB),
			strip(-wa, wa, 0, 0, ASPHALT)],
		centre: { wa, ws, cA: rgb8(ASPHALT), cS: rgb8(SIDEWALK) },
		dash: { o: [0], w: 0.014, len: 0.15, period: 1 / 3, h: 0.002, c: rgb8(LINE_W) },
	};
}

function trackStyle(d, gauge) {
	const fast = (d.speed | 0) >= 200;
	const g = gauge, bt = g + 0.07, bw = bt + 0.075;
	const sleeper = fast ? SLEEPER_CONC : SLEEPER_WOOD;
	const rails = [...pair(g - 0.011, g + 0.011, 0.044, 0.044, RAIL)];
	return {
		key: gauge < 0.09 ? "narrow" : "track", hw: bw, mode: "paths",
		strips: [...pair(bt, bw, 0.03, 0, BALLAST), strip(-bt, bt, 0.03, 0.03, BALLAST), ...rails],
		sleeper: { o0: -(g + 0.05), o1: g + 0.05, len: 0.05, period: 1 / 6, h: 0.035, c: rgb8(sleeper) },
		rails: [...pair(g - 0.011, g + 0.011, 0.006, 0.006, RAIL_DARK)],
		end: "buffer",
	};
}

function waterStyle(d) {
	if (d.system === "river") {
		const w = /_1|_2|big|large/i.test(d.name || "") ? 0.36 : 0.3;
		return { key: "river", hw: w + 0.07, inner: w,
			strips: [strip(-w, w, -0.01, -0.01, WATER, { water: true }), ...pair(w, w + 0.07, -0.004, 0.004, BANK)],
			centre: { wa: w, ws: w + 0.07, cA: rgb8(WATER), cS: rgb8(BANK), water: true } };
	}
	// canals fill their square like the game's canal images, with walls along the closed sides
	return { key: "canal", hw: 0.5, mode: "area", area: rgb8(WATER), areaWater: true, areaH: -0.012, strips: [],
		closed: { w: 0.08, h: 0.02, c: rgb8(CANAL_WALL) } };
}

function airStyle(d) {
	if (d.system === "runway") {
		return { key: "runway", hw: 0.5, mode: "area", area: rgb8([0.25, 0.25, 0.27]),
			strips: [...pair(0.43, 0.45, 0.002, 0.002, LINE_W)],
			dash: { o: [0], w: 0.022, len: 0.2, period: 0.5, h: 0.002, c: rgb8(LINE_W) }, threshold: rgb8(LINE_W) };
	}
	return { key: "taxiway", hw: 0.5, mode: "area", area: rgb8([0.5, 0.5, 0.5]),
		strips: [strip(-0.012, 0.012, 0.002, 0.002, LINE_Y)] };
}

function styleOf(d) {
	switch (d.waytype) {
		case "road": return Object.assign({ mode: "arms" }, roadStyle(d));
		case "track": return trackStyle(d, 0.1);
		case "narrowgauge": return trackStyle(d, 0.07);
		case "tram": return {
			key: "tram", hw: 0.21, mode: "paths",
			strips: [strip(-0.21, 0.21, 0.004, 0.004, [0.56, 0.55, 0.52]), ...pair(0.058, 0.08, 0.008, 0.008, RAIL_DARK)],
			rails: [...pair(0.058, 0.08, 0.003, 0.003, RAIL_DARK)],
		};
		case "monorail": return { key: "monorail", hw: 0.07, mode: "paths", beam: true,
			strips: [strip(-0.06, 0.06, 0.07, 0.07, [0.74, 0.74, 0.76], { sides: true })] };
		case "maglev": return { key: "maglev", hw: 0.17, mode: "paths", beam: true,
			strips: [strip(-0.16, 0.16, 0.06, 0.06, [0.72, 0.72, 0.74], { sides: true }),
				...pair(0.1, 0.14, 0.062, 0.062, [0.36, 0.38, 0.42])] };
		case "water": return Object.assign({ mode: "arms" }, waterStyle(d));
		case "air": return airStyle(d);
		default: return null;
	}
}

function deckStyleOf(st, elevated) {
	const steel = st.key === "track" || st.key === "narrow" || st.key === "tram";
	return { hw: Math.min(0.5, st.hw + 0.035), thick: elevated && steel ? 0.08 : 0.07,
		c: rgb8(elevated && steel ? [0.46, 0.44, 0.42] : CONCRETE), side: rgb8(elevated && steel ? STEEL_GIRDER : [0.58, 0.58, 0.57]),
		railing: rgb8(steel ? [0.34, 0.37, 0.42] : [0.7, 0.7, 0.68]), rh: steel ? 0.05 : 0.04 };
}

function bridgeDeckStyle(d, st) {
	const rail = /rail|track|train|bahn/i.test(d.name || "") || d.waytype === "track" || d.waytype === "narrowgauge";
	const ds = deckStyleOf(st, false);
	if (rail) {
		ds.side = rgb8([0.42, 0.34, 0.3]);
		ds.railing = rgb8([0.42, 0.34, 0.3]);
		ds.rh = 0.11; // girders
	}
	return ds;
}

// --- the builder ------------------------------------------------------------------------------------------

/**
 * cat: desc_list; hs: height step. build(chunk, out, ctx) adds the network to out = {way, water: MeshBuf, f: Furniture};
 * signs that a pak 3D model draws (chunk.modelled) go to ctx.sink (pakplace.js) instead.
 */
export function createWayBuilder(cat, hs) {
	const styles = [], wts = [];
	for (const d of cat.ways || []) {
		styles[d.i] = styleOf(d);
		wts[d.i] = WT[d.waytype] ?? WT.other;
	}
	const bridges = [];
	for (const d of cat.bridges || []) {
		bridges[d.i] = d;
	}
	const signs = [];
	for (const d of cat.signs || []) {
		signs[d.i] = d;
	}
	const wayobjs = [];
	for (const d of cat.wayobjs || []) {
		wayobjs[d.i] = d;
	}

	// ways on the border squares of the chunks built so far (map square key -> [{wt, z, ribi}]): a diagonal that crosses
	// a chunk border needs to know whether the neighbour square continues it. A neighbour chunk not built yet is guessed
	// from the other end of the square (a diagonal goes on when it came in as one).
	const border = new Map(), borderOf = new Map(); // chunk key -> its square keys
	const sq = (x, y) => y * 65536 + x;
	function noteBorder(c, recs) {
		const ck = c.cx + "," + c.cy;
		for (const k of borderOf.get(ck) || []) {
			border.delete(k);
		}
		const keys = [];
		for (const r of recs) {
			if (r.lx === 0 || r.ly === 0 || r.lx === c.w - 1 || r.ly === c.h - 1) {
				const k = sq(c.x0 + r.lx, c.y0 + r.ly);
				let l = border.get(k);
				if (!l) {
					l = [];
					border.set(k, l);
					keys.push(k);
				}
				l.push({ wt: r.wt, z: r.z, ribi: r.ribi });
			}
		}
		borderOf.set(ck, keys);
	}
	/** The ribi of the way of waytype wt near height z on map square (x, y) of another chunk, null or undefined (unknown). */
	function borderWay(x, y, wt, z) {
		const l = border.get(sq(x, y));
		if (!l) {
			return undefined;
		}
		let best = null;
		for (const e of l) {
			if (e.wt === wt && Math.abs(e.z - z) <= 2 && (!best || Math.abs(e.z - z) < Math.abs(best.z - z))) {
				best = e;
			}
		}
		return best ? best.ribi : null;
	}

	// deck looks: per way type for elevated ways, per bridge and way type for bridges (cached)
	const decks = new Map();
	function deckOf(r, bi) {
		const key = r.bridge ? (bi + 1) * 4096 + r.di : r.di;
		let ds = decks.get(key);
		if (!ds) {
			ds = r.bridge ? bridgeDeckStyle(bridges[bi] || {}, r.st) : deckStyleOf(r.st, true);
			decks.set(key, ds);
		}
		return ds;
	}

	function build(c, out, ctx) {
		const { w, h, corners: C, objs: o } = c;
		const { f } = out;
		const terrainY = (t, u, v) => {
			const b = t * 4;
			return (C[b + NW] * (1 - u) * (1 - v) + C[b + NE] * u * (1 - v) + C[b + SE] * u * v + C[b + SW] * (1 - u) * v) * hs;
		};
		const minC = (t) => Math.min(C[t * 4], C[t * 4 + 1], C[t * 4 + 2], C[t * 4 + 3]);
		const maxC = (t) => Math.max(C[t * 4], C[t * 4 + 1], C[t * 4 + 2], C[t * 4 + 3]);

		// --- index ---
		const recs = [], byTile = new Map(), bridgeAt = new Map(), crossing = new Set(), pillars = new Map();
		for (let i = 0; i < o.n; i++) {
			const kind = o.kind[i], t = o.y[i] * w + o.x[i];
			if (kind === K.WAY) {
				const st = styles[o.desc[i]];
				if (!st) {
					continue;
				}
				const r = { i, t, lx: o.x[i], ly: o.y[i], z: o.z[i], b: o.b[i], ribi: o.a[i] & 15, st, wt: wts[o.desc[i]], di: o.desc[i] };
				recs.push(r);
				let l = byTile.get(t);
				if (!l) {
					l = [];
					byTile.set(t, l);
				}
				l.push(r);
			} else if (kind === K.BRIDGE) {
				bridgeAt.set(t * 256 + (o.z[i] & 255), o.desc[i]);
			} else if (kind === K.OTHER && o.a[i] === 29) {
				crossing.add(t);
			} else if (kind === K.PILLAR && !pillars.has(t)) {
				pillars.set(t, i);
			}
		}
		const wayAt = (t, wt, z) => {
			const l = byTile.get(t);
			let best = null;
			if (l) {
				for (const r of l) {
					if (r.wt === wt && (!best || Math.abs(r.z - z) < Math.abs(best.z - z))) {
						best = r;
					}
				}
			}
			return best && Math.abs(best.z - z) <= 2 ? best : null;
		};
		ctx.wayAt = wayAt;
		ctx.byTile = byTile;
		noteBorder(c, recs);
		out.way.reserve(out.way.nv + recs.length * 48);

		// --- geometry of every way ---
		for (const r of recs) {
			const { t, lx, ly, z, b, ribi, st } = r;
			const sl = (b >> 8) & 255;
			const surface = z <= minC(t);
			r.deck = (b & 1) !== 0 && !surface;
			r.head = (b & 1) !== 0 && surface;
			r.bridge = r.deck && bridgeAt.has(t * 256 + (z & 255));
			r.ground = (u, v) => terrainY(t, clamp01(u), clamp01(v));
			if (sl) {
				const off = slopeOffsets(sl);
				r.yAt = (u, v) => (z + slopeAt(off, clamp01(u), clamp01(v))) * hs;
			} else {
				// a flat bridge ramp on sloped ground lies at the highest corner of the ground
				const top = (b & 1) && surface ? maxC(t) * hs : z * hs;
				r.yAt = () => top;
			}
			// the game draws ways on slopes and tunnel portals as full ramps, also dead ends
			let shape = ribi;
			if ((sl || (b & 2)) && bitCount(ribi) <= 1) {
				const off = sl ? slopeOffsets(sl) : [C[t * 4 + SW], C[t * 4 + SE], C[t * 4 + NE], C[t * 4 + NW]];
				const hi = highSide(off[0], off[1], off[2], off[3]);
				if (hi) {
					shape |= hi === N || hi === S ? N | S : E | W;
				}
			}
			let diag = 0;
			if (shape === 3 || shape === 6 || shape === 12 || shape === 9) {
				const want = ((shape << 2) | (shape >> 2)) & 15;
				let guess = 0;
				for (const d of DIRS) {
					if (!(shape & d)) {
						continue;
					}
					const nx = lx + STEP[d][0], ny = ly + STEP[d][1];
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
						const rb = borderWay(c.x0 + nx, c.y0 + ny, r.wt, z);
						if (rb === want) {
							diag |= d;
						} else if (rb === undefined) {
							guess |= d;
						}
						continue;
					}
					const nb = wayAt(ny * w + nx, r.wt, z);
					if (nb && nb.ribi === want) {
						diag |= d;
					}
				}
				if (guess && guess !== (shape & 15) && (diag & shape & ~guess)) {
					diag |= guess;
				}
			}
			r.shape = shape;
			r.pieces = wayPieces(shape, diag, st.mode === "paths" ? "paths" : "arms", st.inner || 0);
		}

		for (const r of recs) {
			const { t, lx, ly, st } = r;
			const tile = byTile.get(t);
			const onRoad = tile.some((q) => q !== r && q.wt === WT.road && q.z === r.z);
			const railsOnly = st.rails && (crossing.has(t) || (onRoad && (r.wt === WT.track || r.wt === WT.narrowgauge || r.wt === WT.tram)));
			const P = r.pieces;
			const buf = out.way;
			if (st.mode === "area") {
				const y = r.yAt, c = st.area, dst = st.areaWater ? out.water : buf, hh = st.areaH || 0;
				const i0 = dst.v(lx, y(0, 0) + hh, ly, c), i1 = dst.v(lx, y(0, 1) + hh, ly + 1, c);
				const i2 = dst.v(lx + 1, y(1, 1) + hh, ly + 1, c), i3 = dst.v(lx + 1, y(1, 0) + hh, ly, c);
				dst.quad(i0, i1, i2, i3);
				if (st.closed) {
					const k = st.closed;
					for (const d of DIRS) {
						if (!(r.shape & d)) {
							const e = d === N ? [0, 0, 1, k.w] : d === S ? [0, 1 - k.w, 1, 1] : d === W ? [0, 0, k.w, 1] : [1 - k.w, 0, 1, 1];
							rect(buf, lx, ly, e[0], e[1], e[2], e[3], k.h, k.c, y);
						}
					}
				}
				for (const p of P.pieces) {
					band(buf, out.water, lx, ly, p.pts, st.strips, r.yAt);
					if (st.dash && p.kind !== "arm") {
						dashes(buf, lx, ly, p.pts, st.dash, r.yAt);
					}
				}
				if (st.threshold) {
					for (const d of P.ends) {
						threshold(buf, lx, ly, d, st.threshold, r.yAt);
					}
				}
			} else {
				for (const p of P.pieces) {
					if (railsOnly) {
						band(buf, null, lx, ly, p.pts, st.rails, r.yAt);
						continue;
					}
					band(buf, out.water, lx, ly, p.pts, st.strips, r.yAt);
					if (st.sleeper) {
						sleepers(buf, lx, ly, p.pts, st.sleeper, r.yAt);
					}
					if (st.dash && p.kind !== "arm" && !crossing.has(t)) {
						dashes(buf, lx, ly, p.pts, st.dash, r.yAt);
					}
				}
				if (P.center && st.centre && !railsOnly) {
					centreSquare(buf, out.water, lx, ly, r.ribi, st.centre, r.yAt);
				}
				if (st.end === "buffer" && !railsOnly) {
					for (const d of P.ends) {
						const inw = INWARD[d];
						f.add("buffer", lx + 0.5 - inw[0] * 0.04, r.yAt(0.5, 0.5) + 0.03, ly + 0.5 - inw[1] * 0.04, 1, 1, 1, [1, 1, 1],
							Math.atan2(inw[1], -inw[0]));
					}
				}
			}
			if ((r.deck || r.head) && st.beam) {
				if (r.deck) {
					supports(f, r, null, tile);
				}
			} else if (r.deck || r.head) {
				const ds = deckOf(r, bridgeAt.get(t * 256 + (r.z & 255)));
				if (r.deck) {
					deck(f, lx, ly, r, ds);
					if (!r.bridge) {
						supports(f, r, ds, tile);
					}
				} else {
					abutment(f, lx, ly, r, ds, (u, v) => terrainY(t, u, v));
				}
			}
		}

		// --- bridge pillars ---
		for (const [t, i] of pillars) {
			const lx = o.x[i], ly = o.y[i];
			let top = -Infinity, axis = null;
			for (const r of byTile.get(t) || []) {
				if (r.deck && r.z > o.z[i]) {
					const ds = deckOf(r, bridgeAt.get(t * 256 + (r.z & 255)));
					const y = r.yAt(0.5, 0.5) - DECK_GAP - ds.thick;
					if (y > top) {
						top = y;
						axis = axisOf(r.ribi);
					}
				}
			}
			if (top === -Infinity) {
				top = (o.z[i] + 2) * hs;
			}
			const y0 = Math.min(o.z[i] * hs, terrainY(t, 0.5, 0.5));
			if (top - y0 > 0.02) {
				f.add("pillar", lx + 0.5, y0, ly + 0.5, 0.17, top - y0, 0.3, PILLAR_LIN, axis === "ns" ? Math.PI / 2 : 0);
			}
		}

		// --- portals, overhead lines, signs, power lines, crossings ---
		for (let i = 0; i < o.n; i++) {
			const kind = o.kind[i];
			if (kind !== K.TUNNEL && kind !== K.WAYOBJ && kind !== K.SIGN && kind !== K.POWERLINE) {
				continue;
			}
			const lx = o.x[i], ly = o.y[i], z = o.z[i], t = ly * w + lx, a = o.a[i], bb = o.b[i];
			if (kind === K.TUNNEL) {
				portal(f, lx, ly, z, t);
			} else if (kind === K.WAYOBJ) {
				const d = wayobjs[o.desc[i]];
				const r = wayAt(t, WT[WT_NUM[bb]] ?? WT.track, z);
				if (r && d) {
					if (d.overhead !== false && r.wt !== WT.air) {
						catenary(f, lx, ly, r, c.x0 + lx, c.y0 + ly);
					} else {
						edgeLights(f, lx, ly, r);
					}
				}
			} else if (kind === K.SIGN) {
				const d = signs[o.desc[i]];
				if (d) {
					sign(f, lx, ly, z, t, d, a, bb, ctx && ctx.sink && c.modelled && c.modelled[i] ? (x, y, zz, rot) => ctx.sink(i, x, y, zz, 1, rot) : null);
				}
			} else {
				powerline(f, lx, ly, t, a, bb);
			}
		}
		for (const t of crossing) {
			const lx = t % w, ly = (t / w) | 0;
			const r = (byTile.get(t) || []).find((q) => q.wt === WT.road);
			const y = r ? r.yAt(0.5, 0.5) : terrainY(t, 0.5, 0.5);
			f.add("barrier", lx + 0.1, y, ly + 0.1, 1, 1, 1, [1, 1, 1], 0);
			f.add("barrier", lx + 0.9, y, ly + 0.9, 1, 1, 1, [1, 1, 1], Math.PI);
		}

		// --- helpers that need the chunk ---
		function portal(f, lx, ly, z, t) {
			const b = t * 4;
			let side = highSide(C[b + SW], C[b + SE], C[b + NE], C[b + NW]);
			if (!side) {
				const r = (byTile.get(t) || [])[0];
				side = r && r.ribi ? r.ribi & -r.ribi : N;
			}
			const top = Math.max(maxC(t) * hs, z * hs + 0.3) + 0.03, y0 = z * hs;
			const m = MID[side], inw = INWARD[side];
			// facade: a slab along the high edge, an opening in its middle
			const along = [-inw[1], inw[0]];
			const cx = lx + m[0] + inw[0] * 0.025, cz = ly + m[1] + inw[1] * 0.025;
			const rot = Math.atan2(-along[1], along[0]);
			f.obox(cx, cz, 0.5, 0.025, y0 - 0.02, top, rot, f.c8([0.62, 0.6, 0.56]), f.c8([0.5, 0.48, 0.44]));
			const ox = lx + m[0] + inw[0] * 0.052, oz = ly + m[1] + inw[1] * 0.052;
			const mm = f.mesh, dark = f.c8([0.07, 0.07, 0.08]), oh = Math.min(top - y0 - 0.04, 0.34);
			const p0 = [ox - along[0] * 0.3, oz - along[1] * 0.3], p1 = [ox + along[0] * 0.3, oz + along[1] * 0.3];
			const q = [mm.v(p0[0], y0, p0[1], dark), mm.v(p1[0], y0, p1[1], dark), mm.v(p1[0], y0 + oh, p1[1], dark),
				mm.v(p0[0], y0 + oh, p0[1], dark)];
			// facing into the portal square (inward)
			const nx = -(p1[1] - p0[1]), nz = p1[0] - p0[0];
			if (nx * inw[0] + nz * inw[1] > 0) {
				mm.quad(q[0], q[1], q[2], q[3]);
			} else {
				mm.quad(q[0], q[3], q[2], q[1]);
			}
		}

		// model(x, y, z, rot): a pak 3D model instead of the generated post (local +X towards the vehicles)
		function sign(f, lx, ly, z, t, d, a, bb, model) {
			const r = wayAt(t, WT[d.waytype] ?? WT.road, z);
			const y = r ? r.yAt(0.5, 0.5) : terrainY(t, 0.5, 0.5);
			const off = !r ? 0.3 : r.st.centre ? Math.min(0.46, r.st.centre.ws - 0.03) : Math.min(0.46, r.st.hw + 0.05);
			const signal = (bb & 256) !== 0;
			if (d.traffic_light) {
				const open = a & 15;
				for (const [cu, cv, ax] of [[0.08, 0.08, "ew"], [0.92, 0.92, "ew"], [0.92, 0.08, "ns"], [0.08, 0.92, "ns"]]) {
					const green = ax === "ns" ? (open & (N | S)) !== 0 : (open & (E | W)) !== 0;
					const rot = ax === "ns" ? (cv < 0.5 ? -Math.PI / 2 : Math.PI / 2) : (cu < 0.5 ? Math.PI : 0);
					if (model) {
						model(lx + cu, y, ly + cv, rot);
						continue;
					}
					f.add("signal", lx + cu, y, ly + cv, 1, 1, 1, [1, 1, 1], rot);
					f.add("lamp", lx + cu, y, ly + cv, 1, 1, 1, open === 0 ? STATE_RGB[2] : green ? STATE_RGB[1] : STATE_RGB[0], rot);
				}
				return;
			}
			// `dir` points towards the vehicles a sign is meant for (the game tests the direction back along the route):
			// the sign stands right of their travel direction and faces them
			const dirs = DIRS.filter((dd) => a & dd);
			if (!model && !signal && WT[d.waytype] === WT.air) {
				// signs of runways and taxiways are markings on the surface: an arrow in the direction of travel
				const yAt = r ? r.yAt : (u, v) => terrainY(t, u, v);
				for (const dd of dirs.length ? dirs : [N]) {
					groundArrow(out.way, lx, ly, [-STEP[dd][0], -STEP[dd][1]], dirs.length > 1 ? 0.2 : 0, yAt);
				}
				return;
			}
			for (const dd of dirs.length ? dirs : [N]) {
				const T = [-STEP[dd][0], -STEP[dd][1]], R = [-T[1], T[0]];
				const px = lx + 0.5 + R[0] * off, pz = ly + 0.5 + R[1] * off;
				const rot = Math.atan2(T[1], -T[0]); // local +X towards the vehicles (-T)
				if (model) {
					model(px, y, pz, rot);
				} else if (signal) {
					f.add("signal", px, y, pz, 1, 1, 1, [1, 1, 1], rot);
					f.add("lamp", px, y, pz, 1, 1, 1, STATE_RGB[(bb & 255) % 3], rot);
				} else {
					f.add("sign", px, y, pz, 1, 1, 1, signRgb(d), rot);
				}
			}
		}

		function powerline(f, lx, ly, t, a, kind) {
			const y = terrainY(t, 0.5, 0.5);
			const ribi = a & 15, ax = axisOf(ribi);
			if (kind) {
				f.box(lx + 0.32, lx + 0.68, y - 0.02, y + 0.2, ly + 0.36, ly + 0.64, f.c8(kind === 1 ? [0.5, 0.52, 0.5] : [0.45, 0.47, 0.52]));
				for (const u of [0.4, 0.5, 0.6]) {
					f.box(lx + u - 0.012, lx + u + 0.012, y + 0.2, y + 0.29, ly + 0.47, ly + 0.53, f.c8([0.78, 0.55, 0.38]));
				}
			}
			if (!ribi) {
				return;
			}
			const rot = ax === "ns" ? 0 : ax === "ew" ? Math.PI / 2 : Math.PI / 4;
			if (!kind) {
				f.add("pylon", lx + 0.5, y - 0.02, ly + 0.5, 1, 1, 1, [1, 1, 1], rot);
			}
			const A = [Math.cos(rot), -Math.sin(rot)];
			const col = f.c8([0.2, 0.2, 0.22]);
			for (const d of DIRS) {
				if (!(ribi & d)) {
					continue;
				}
				const m = MID[d], perp = d === N || d === S ? [1, 0] : [0, 1];
				for (const [off, hy] of (kind ? [[0, 0.27]] : [[-0.28, 0.75], [0.28, 0.75], [-0.2, 0.9], [0.2, 0.9]])) {
					const p0 = [lx + 0.5 + A[0] * off, y + hy, ly + 0.5 + A[1] * off];
					const ny = lx + m[0] + perp[0] * off, nz = ly + m[1] + perp[1] * off;
					const yEnd = (kind ? y + 0.75 : y + hy) - 0.05;
					wire(f.mesh, p0, [ny, yEnd, nz], col, 0.012);
				}
			}
		}
	}

	return { build };
}

const STATE_RGB = [rgbLin([1, 0.12, 0.08]), rgbLin([0.15, 1, 0.25]), rgbLin([1, 0.8, 0.1])];
const PILLAR_LIN = rgbLin([0.66, 0.65, 0.62]), COLUMN_STEEL = rgbLin([0.42, 0.45, 0.5]), COLUMN_CONC = rgbLin([0.68, 0.67, 0.64]);
const SIGN_RGB = { noentry: rgbLin([1, 0.55, 0.55]), priv: rgbLin([1, 0.85, 0.85]), choose: rgbLin([1, 0.95, 0.6]),
	oneway: rgbLin([0.65, 0.8, 1]), other: rgbLin([0.95, 0.95, 0.95]) };

function signRgb(d) {
	const f = d.flags | 0, n = d.name || "";
	if (/noentry|no_entry|verbot/i.test(n)) return SIGN_RGB.noentry;
	if (f & 4) return SIGN_RGB.priv;
	if (f & 2) return SIGN_RGB.choose;
	if (f & 1) return SIGN_RGB.oneway;
	return SIGN_RGB.other;
}

function clamp01(x) {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** The polygon [[x, y]] grown outwards by g (mitred corners). */
function grown(poly, g) {
	const m = poly.length;
	let area = 0;
	for (let i = 0; i < m; i++) {
		const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % m];
		area += x0 * y1 - x1 * y0;
	}
	const s = area > 0 ? 1 : -1; // counter-clockwise: the outward normal of an edge (dx, dy) is (dy, -dx)
	const nrm = (i) => {
		const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % m], l = Math.hypot(x1 - x0, y1 - y0);
		return [s * (y1 - y0) / l, -s * (x1 - x0) / l];
	};
	return poly.map((p, i) => {
		const a = nrm((i + m - 1) % m), b = nrm(i), k = g / (1 + a[0] * b[0] + a[1] * b[1]);
		return [p[0] + (a[0] + b[0]) * k, p[1] + (a[1] + b[1]) * k];
	});
}

// arrow painted on a runway or taxiway: [along, across] outline of a shaft and a head pointing to +along, with a dark edge
const ARROW = [[-0.28, -0.035], [0.04, -0.035], [0.04, -0.12], [0.3, 0], [0.04, 0.12], [0.04, 0.035], [-0.28, 0.035]];
const ARROW_TRIS = [[0, 1, 5], [0, 5, 6], [2, 3, 4]];
const ARROW_LAYERS = [[grown(ARROW, 0.022), 0.003, rgb8([0.08, 0.08, 0.08])], [ARROW, 0.004, rgb8(LINE_Y)]];

/** Arrow on the way surface of square (lx, ly) pointing along T (a unit step), `side` right of the centre line. */
function groundArrow(buf, lx, ly, T, side, yAt) {
	const R = [-T[1], T[0]];
	for (const [poly, h, c] of ARROW_LAYERS) {
		const ids = poly.map(([al, ac]) => {
			const u = clamp01(0.5 + T[0] * al + R[0] * (ac + side)), v = clamp01(0.5 + T[1] * al + R[1] * (ac + side));
			return [buf.v(lx + u, yAt(u, v) + h, ly + v, c), u, v];
		});
		for (const [i, j, k] of ARROW_TRIS) {
			const p = ids[i], q = ids[j], s = ids[k];
			// facing up: the same turn as the surface quads
			if ((q[2] - p[2]) * (s[1] - p[1]) - (q[1] - p[1]) * (s[2] - p[2]) > 0) {
				buf.tri(p[0], q[0], s[0]);
			} else {
				buf.tri(p[0], s[0], q[0]);
			}
		}
	}
}

// --- band geometry ----------------------------------------------------------------------------------------

/** A band along the sampled piece pts with the cross-section strips; water strips go to `water` when given. */
export function band(buf, water, lx, ly, pts, strips, yAt) {
	const n = pts.length;
	for (const s of strips) {
		const b = s.water && water ? water : buf;
		const base = b.nv;
		for (let k = 0; k < n; k++) {
			const p = pts[k], nu = -p[3], nv = p[2];
			const u0 = p[0] + nu * s.o0, v0 = p[1] + nv * s.o0, u1 = p[0] + nu * s.o1, v1 = p[1] + nv * s.o1;
			b.v(lx + u0, yAt(u0, v0) + s.h0, ly + v0, s.c);
			b.v(lx + u1, yAt(u1, v1) + s.h1, ly + v1, s.c);
		}
		for (let k = 0; k + 1 < n; k++) {
			const a = base + 2 * k;
			b.quad(a, a + 1, a + 3, a + 2);
		}
		if (s.sides) {
			for (const [o, hh, out] of [[s.o0, s.h0, false], [s.o1, s.h1, true]]) {
				const sb = b.nv;
				for (let k = 0; k < n; k++) {
					const p = pts[k], u = p[0] - p[3] * o, v = p[1] + p[2] * o, y = yAt(u, v);
					b.v(lx + u, y + hh, ly + v, s.c);
					b.v(lx + u, y - 0.004, ly + v, s.c);
				}
				for (let k = 0; k + 1 < n; k++) {
					const a = sb + 2 * k; // a top, a+1 bottom at sample k
					if (out) {
						b.quad(a, a + 1, a + 3, a + 2);
					} else {
						b.quad(a, a + 2, a + 3, a + 1);
					}
				}
			}
		}
	}
}

/** Short quads across (sleepers) or along (dashes) a piece every `period` of its length. */
function marks(buf, lx, ly, pts, m, yAt, across) {
	const lens = arcLengths(pts), total = lens[lens.length - 1];
	const count = Math.max(1, Math.round(total / m.period));
	const step = total / count, half = m.len / 2;
	const offs = across ? [null] : m.o;
	for (let k = 0; k < count; k++) {
		const s = (k + 0.5) * step;
		const a = pointAt(pts, lens, Math.max(0, s - half)), b = pointAt(pts, lens, Math.min(total, s + half));
		for (const oc of offs) {
			const o0 = across ? m.o0 : oc - m.w / 2, o1 = across ? m.o1 : oc + m.w / 2;
			const P = (p, o) => {
				const u = p[0] - p[3] * o, v = p[1] + p[2] * o;
				return buf.v(lx + u, yAt(u, v) + m.h, ly + v, m.c);
			};
			const i0 = P(a, o0), i1 = P(a, o1), i2 = P(b, o1), i3 = P(b, o0);
			buf.quad(i0, i1, i2, i3);
		}
	}
}

function sleepers(buf, lx, ly, pts, m, yAt) {
	marks(buf, lx, ly, pts, m, yAt, true);
}

function dashes(buf, lx, ly, pts, m, yAt) {
	marks(buf, lx, ly, pts, m, yAt, false);
}

/** Runway threshold: bars across the end of a dead end. */
function threshold(buf, lx, ly, d, c, yAt) {
	const m = MID[d], inw = INWARD[d], al = [-inw[1], inw[0]];
	for (let k = -3; k <= 3; k++) {
		if (k === 0) continue;
		const o = k * 0.11, p = [m[0] + inw[0] * 0.08 + al[0] * o, m[1] + inw[1] * 0.08 + al[1] * o];
		const pts = [[p[0], p[1], inw[0], inw[1]], [p[0] + inw[0] * 0.22, p[1] + inw[1] * 0.22, inw[0], inw[1]]];
		band(buf, null, lx, ly, pts, [{ o0: -0.03, o1: 0.03, h0: 0.002, h1: 0.002, c }], yAt);
	}
}

/** Axis aligned rectangle of a square at height yAt + h. */
function rect(b, lx, ly, u0, v0, u1, v1, h, c, yAt) {
	const i0 = b.v(lx + u0, yAt(u0, v0) + h, ly + v0, c), i1 = b.v(lx + u0, yAt(u0, v1) + h, ly + v1, c);
	const i2 = b.v(lx + u1, yAt(u1, v1) + h, ly + v1, c), i3 = b.v(lx + u1, yAt(u1, v0) + h, ly + v0, c);
	b.quad(i0, i1, i2, i3);
}

/** Centre square of "arms" junctions and dead ends: surface, kerb corners, closed sides. */
function centreSquare(buf, water, lx, ly, ribi, cs, yAt) {
	const { wa, ws } = cs;
	const q = (b, u0, v0, u1, v1, h, c) => {
		const i0 = b.v(lx + u0, yAt(u0, v0) + h, ly + v0, c), i1 = b.v(lx + u0, yAt(u0, v1) + h, ly + v1, c);
		const i2 = b.v(lx + u1, yAt(u1, v1) + h, ly + v1, c), i3 = b.v(lx + u1, yAt(u1, v0) + h, ly + v0, c);
		b.quad(i0, i1, i2, i3);
	};
	const lo = 0.5 - wa, hi = 0.5 + wa;
	q(cs.water && water ? water : buf, lo, lo, hi, hi, cs.water ? -0.01 : 0, cs.cA);
	if (ws <= wa) {
		return;
	}
	const h = cs.water ? 0.004 : 0.008, so = 0.5 - ws, si = 0.5 + ws;
	const corner = (u0, v0, u1, v1, d1, d2) => {
		if (cs.water && water && (ribi & d1) && (ribi & d2)) {
			q(water, u0, v0, u1, v1, -0.01, cs.cA);
		} else {
			q(buf, u0, v0, u1, v1, h, cs.cS);
		}
	};
	corner(so, so, lo, lo, N, W);
	corner(hi, so, si, lo, N, E);
	corner(so, hi, lo, si, S, W);
	corner(hi, hi, si, si, S, E);
	if (!(ribi & N)) q(buf, lo, so, hi, lo, h, cs.cS);
	if (!(ribi & S)) q(buf, lo, hi, hi, si, h, cs.cS);
	if (!(ribi & W)) q(buf, so, lo, lo, hi, h, cs.cS);
	if (!(ribi & E)) q(buf, hi, lo, si, hi, h, cs.cS);
}

// --- decks, supports, abutments -----------------------------------------------------------------------------

function deck(f, lx, ly, r, ds) {
	const m = f.mesh;
	const top = (u, v) => r.yAt(u, v) - DECK_GAP;
	const pieces = r.pieces.pieces.slice();
	if (r.pieces.center || !pieces.length) {
		const hw = Math.min(0.5, ds.hw);
		pieces.push({ pts: [[0.5, 0.5 - hw, 0, 1], [0.5, 0.5 + hw, 0, 1]], kind: "centre" });
	}
	for (const p of pieces) {
		const pts = p.pts, hw = ds.hw;
		band(m, null, lx, ly, pts, [{ o0: -hw, o1: hw, h0: 0, h1: 0, c: ds.c }], top);
		// side faces below the edges and railings above them
		for (const o of [-hw, hw]) {
			wall(m, lx, ly, pts, o, (u, v) => top(u, v) - ds.thick, top, ds.side, o > 0);
			if (p.kind !== "centre" || r.pieces.pieces.length === 0) {
				wall(m, lx, ly, pts, o * 0.985, top, (u, v) => top(u, v) + ds.rh, ds.railing, o > 0, true);
			}
		}
	}
}

/** Vertical wall along a piece at offset o from yBot to yTop; faces +n when out (else -n), both when twoSided. */
export function wall(m, lx, ly, pts, o, yBot, yTop, c, out, twoSided = false) {
	const n = pts.length, base = m.nv;
	for (let k = 0; k < n; k++) {
		const p = pts[k], u = p[0] - p[3] * o, v = p[1] + p[2] * o;
		m.v(lx + u, yTop(u, v), ly + v, c);
		m.v(lx + u, yBot(u, v), ly + v, c);
	}
	for (let k = 0; k + 1 < n; k++) {
		const a = base + 2 * k;
		if (out || twoSided) {
			m.quad(a, a + 1, a + 3, a + 2);
		}
		if (!out || twoSided) {
			m.quad(a, a + 2, a + 3, a + 1);
		}
	}
}

function supports(f, r, ds, tile) {
	const { lx, ly } = r;
	const yTop = r.yAt(0.5, 0.5) - (ds ? DECK_GAP + ds.thick : 0.004);
	const P = r.pieces.pieces;
	const straight = P.length === 1 && P[0].kind === "straight";
	// ways below: along the same axis (an elevated line over its street) the columns stand at the kerbs, across it or
	// at a junction the square is left free (it spans the street like a bridge)
	const ax = axisOf(r.ribi);
	const under = tile.filter((q) => q !== r && !q.deck && q.z < r.z);
	const below = under.length > 0;
	if (below && (!ds || !ax || under.some((q) => axisOf(q.ribi) !== ax))) {
		return;
	}
	const col = r.st.key === "track" || r.st.key === "narrow" ? COLUMN_STEEL : COLUMN_CONC;
	const groundY = (u, v) => r.ground(u, v);
	if (straight && r.st.hw > 0.15 && ds) {
		const p = P[0].pts[0], nu = -p[3], nv = p[2];
		if (below) {
			// columns at the edges of the square and a cross beam: the street below stays free
			for (const o of [-0.43, 0.43]) {
				const u = 0.5 + nu * o, v = 0.5 + nv * o, y0 = groundY(u, v);
				if (yTop - y0 > 0.03) {
					f.add("column", lx + u, y0, ly + v, 0.07, yTop - y0, 0.07, col);
				}
			}
			const cx = lx + 0.5, cz = ly + 0.5, rot = Math.atan2(-nv, nu);
			f.obox(cx, cz, 0.46, 0.035, yTop - 0.05, yTop, rot, f.c8([0.42, 0.45, 0.5]));
		} else {
			const y0 = groundY(0.5, 0.5);
			if (yTop - y0 > 0.03) {
				f.add("pillar", lx + 0.5, y0, ly + 0.5, 0.14, yTop - y0, Math.min(0.42, r.st.hw * 1.4), col, Math.atan2(-p[3], p[2]));
			}
		}
		return;
	}
	const y0 = groundY(0.5, 0.5);
	if (yTop - y0 > 0.03) {
		f.add("column", lx + 0.5, y0, ly + 0.5, 0.12, yTop - y0, 0.12, col);
		if (r.st.hw <= 0.15) {
			f.obox(lx + 0.5, ly + 0.5, 0.03, 0.14, yTop - 0.03, yTop, 0, f.c8([0.6, 0.6, 0.62]));
		}
	}
}

/** Bridge head or ramp on the ground: walls from the ground up to the way along both edges and the open ends. */
function abutment(f, lx, ly, r, ds, ground) {
	const m = f.mesh, hw = ds.hw;
	const top = (u, v) => r.yAt(u, v) - DECK_GAP;
	const bot = (u, v) => Math.min(ground(u, v), top(u, v)) - 0.02;
	for (const p of r.pieces.pieces) {
		const pts = p.pts;
		band(m, null, lx, ly, pts, [{ o0: -hw, o1: hw, h0: 0, h1: 0, c: ds.c }], top);
		for (const o of [-hw, hw]) {
			wall(m, lx, ly, pts, o, bot, top, ds.side, o > 0);
			wall(m, lx, ly, pts, o * 0.985, top, (u, v) => top(u, v) + ds.rh, ds.railing, o > 0, true);
		}
		// open ends: where the way is above the ground
		for (const end of [0, pts.length - 1]) {
			const q = pts[end], u = q[0], v = q[1];
			if (top(u, v) - ground(u, v) < 0.02) {
				continue;
			}
			const tu = q[2], tv = q[3];
			// a short wall across the band (a two-sample piece along n), facing out of the piece
			const across = [[u + tv * hw, v - tu * hw, -tv, tu], [u - tv * hw, v + tu * hw, -tv, tu]];
			wall(m, lx, ly, across, 0, bot, top, ds.side, end === 0, false);
		}
	}
}

// --- overhead lines and lights -------------------------------------------------------------------------------

function catenary(f, lx, ly, r, gx, gy) {
	const col = f.c8([0.2, 0.2, 0.22]);
	const P = r.pieces.pieces;
	for (const p of P) {
		const pts = p.pts;
		for (let k = 0; k + 1 < pts.length; k++) {
			const a = pts[k], b = pts[k + 1];
			wire(f.mesh, [lx + a[0], r.yAt(a[0], a[1]) + WIRE_H, ly + a[1]], [lx + b[0], r.yAt(b[0], b[1]) + WIRE_H, ly + b[1]], col, 0.01, 0);
		}
	}
	// one mast per square, beside the first piece (on straight squares every square, as the game does)
	const p = P[0];
	if (!p || (p.kind === "arm" && P.length > 1 && (gx + gy) % 2)) {
		return;
	}
	const lens = arcLengths(p.pts), q = pointAt(p.pts, lens, lens[lens.length - 1] / 2);
	const nu = -q[3], nv = q[2], o = Math.min(0.46, r.st.hw + 0.07);
	const u = q[0] + nu * o, v = q[1] + nv * o;
	f.add("mast", lx + u, r.yAt(clamp01(u), clamp01(v)), ly + v, 1, 1, 1, [1, 1, 1], Math.atan2(nv, -nu));
}

function edgeLights(f, lx, ly, r) {
	const c = f.c8([1, 0.92, 0.6]);
	for (const p of r.pieces.pieces) {
		if (p.kind !== "straight") continue;
		const pts = p.pts, lens = arcLengths(pts);
		for (const s of [0.17, 0.5, 0.83]) {
			const q = pointAt(pts, lens, s * lens[lens.length - 1]);
			for (const o of [-0.47, 0.47]) {
				const u = q[0] - q[3] * o, v = q[1] + q[2] * o, y = r.yAt(u, v);
				f.box(lx + u - 0.01, lx + u + 0.01, y, y + 0.025, ly + v - 0.01, ly + v + 0.01, c);
			}
		}
	}
}

/** A thin wire from p0 to p1 (chunk-local x, y, z) with a little sag: two vertical ribbons, seen from both sides. */
export function wire(m, p0, p1, c, th = 0.012, sag = 0.03) {
	const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 - sag, (p0[2] + p1[2]) / 2];
	const segs = sag ? [[p0, mid], [mid, p1]] : [[p0, p1]];
	for (const [a, b] of segs) {
		const i0 = m.v(a[0], a[1], a[2], c), i1 = m.v(a[0], a[1] - th, a[2], c);
		const i2 = m.v(b[0], b[1] - th, b[2], c), i3 = m.v(b[0], b[1], b[2], c);
		m.quad(i0, i1, i2, i3);
		m.quad(i0, i3, i2, i1);
	}
}

