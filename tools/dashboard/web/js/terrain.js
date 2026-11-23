// Simutrans-Horizon dashboard: base map from the `map` command (terrain + height grids),
// loaded lazily per 256 x 256 region and drawn by a Leaflet GridLayer. Artistic License, see LICENSE.txt.
import { apiGet } from "/js/api.js";

export const REGION = 256;
const MAX_REGIONS = 64; // about 40 MB; the oldest regions are dropped (and loaded again when needed)

// --- colours ---------------------------------------------------------------------------------

function rgb(hex) {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// land colour by height above the ground water level
const LAND_STOPS = [[0, "#a7d58a"], [3, "#8cc472"], [8, "#9fbd6a"], [14, "#b9ad6e"], [22, "#a68b6a"],
	[32, "#9a8f86"], [44, "#d9d6d2"], [60, "#ffffff"]].map(([h, c]) => [h, rgb(c)]);
const WATER_SHALLOW = rgb("#79b9e6"), WATER_DEEP = rgb("#2f6fae");

// colour of the object on a tile (1 px per tile); null = ground colour
const OBJ = {
	T: null, // trees: darker ground
	o: rgb("#9b9488"), f: rgb("#e3cf73"),
	R: rgb("#8d8d8d"), "=": rgb("#5b4636"), t: rgb("#a07d5a"), n: rgb("#7a5a3a"), m: rgb("#8e6fb3"),
	g: rgb("#b0469a"), w: rgb("#3f8fd0"), a: rgb("#5d5d63"), X: rgb("#6b6b6b"), P: null,
	B: rgb("#857360"), E: rgb("#7d7d84"), U: rgb("#2b2b2b"), S: rgb("#c2410c"), D: rgb("#e8590c"),
	F: rgb("#8f2d2d"), C: rgb("#f2b705"), h: rgb("#d99a76"), c: rgb("#a3acc4"), i: rgb("#c9a94f"),
	A: rgb("#b56fc0"), Q: rgb("#f59f00"), b: rgb("#a3907a"),
};
const CODE_OBJ = new Array(128).fill(null);
for (const [k, v] of Object.entries(OBJ)) {
	CODE_OBJ[k.charCodeAt(0)] = v;
}
const C = (ch) => ch.charCodeAt(0);
const WATER = C("~"), TREES = C("T"), POWER = C("P");

// codes that carry a way (for connecting lines in the detailed view)
const WAYISH = new Uint8Array(128);
for (const ch of "R=tnmgwaXBEUSD") {
	WAYISH[C(ch)] = 1;
}
const BUILDING = new Uint8Array(128);
for (const ch of "hciAQbCF") {
	BUILDING[C(ch)] = 1;
}

function landColor(rel) {
	if (rel <= LAND_STOPS[0][0]) {
		return LAND_STOPS[0][1];
	}
	for (let i = 1; i < LAND_STOPS.length; i++) {
		const [h1, c1] = LAND_STOPS[i];
		if (rel <= h1) {
			const [h0, c0] = LAND_STOPS[i - 1];
			const f = (rel - h0) / (h1 - h0);
			return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
		}
	}
	return LAND_STOPS[LAND_STOPS.length - 1][1];
}

function heightDigit(code) {
	if (code >= 48 && code <= 57) {
		return code - 48;
	}
	if (code >= 97 && code <= 122) {
		return code - 87;
	}
	if (code >= 65 && code <= 90) {
		return code - 29;
	}
	return 0;
}

function css(c) {
	return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
}

// --- regions ---------------------------------------------------------------------------------

/** Cache of map regions of one world, with a small LIFO request queue (one request at a time). */
export class Terrain {
	constructor() {
		this.key = null;
		this.sx = 0;
		this.sy = 0;
		this.regions = new Map();
		this.pending = new Map(); // "rx,ry" -> true while queued or loading
		this.queue = [];
		this.active = 0;
		this.listeners = new Set();
		this.errors = 0;
		this.lastError = null;
		this.labels = new Map(); // "x,y" -> {pos, text}
	}

	on(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	fire(what, arg) {
		for (const fn of this.listeners) {
			fn(what, arg);
		}
	}

	reset(key, sx, sy) {
		if (key === this.key && sx === this.sx && sy === this.sy) {
			return false;
		}
		this.key = key;
		this.sx = sx;
		this.sy = sy;
		this.regions.clear();
		this.pending.clear();
		this.queue = [];
		this.labels.clear();
		this.fire("reset");
		return true;
	}

	markStale() {
		for (const r of this.regions.values()) {
			r.stale = true;
		}
	}

	/** Regions that changed in the game (map_changes chunks of REGION x REGION tiles): load them again when shown. */
	markChunksStale(chunks) {
		let n = 0;
		for (const c of chunks) {
			const r = this.regions.get(c[0] + "," + c[1]);
			if (r) {
				r.stale = true;
				n++;
			}
		}
		return n;
	}

	get(rx, ry) {
		return this.regions.get(rx + "," + ry);
	}

	status() {
		const total = Math.ceil(this.sx / REGION) * Math.ceil(this.sy / REGION);
		return { loaded: this.regions.size, total, pending: this.pending.size };
	}

	/** Terrain code at a map tile, 0 if unknown. */
	code(x, y) {
		if (x < 0 || y < 0 || x >= this.sx || y >= this.sy) {
			return 0;
		}
		const r = this.regions.get(((x / REGION) | 0) + "," + ((y / REGION) | 0));
		if (!r) {
			return 0;
		}
		return r.terrain[(y - r.y) * r.w + (x - r.x)];
	}

	request(rx, ry, front = true) {
		const k = rx + "," + ry;
		if (!this.key || this.pending.has(k)) {
			return;
		}
		const r = this.regions.get(k);
		if (r && !r.stale) {
			return;
		}
		if (rx < 0 || ry < 0 || rx * REGION >= this.sx || ry * REGION >= this.sy) {
			return;
		}
		this.pending.set(k, true);
		if (front) {
			this.queue.push([rx, ry]);
		} else {
			this.queue.unshift([rx, ry]);
		}
		this.fire("status");
		this.pump();
	}

	pump() {
		while (this.active < 1 && this.queue.length) {
			const [rx, ry] = this.queue.pop();
			this.active++;
			this.load(rx, ry).finally(() => {
				this.active--;
				this.pump();
			});
		}
	}

	async load(rx, ry) {
		const key = this.key, k = rx + "," + ry;
		const x = rx * REGION, y = ry * REGION;
		const w = Math.min(REGION, this.sx - x), h = Math.min(REGION, this.sy - y);
		try {
			const reply = await apiGet("map", {
				x, y, w, h, max_size: REGION, layers: "terrain,height", features: 1,
			}, 4);
			if (key !== this.key) {
				return;
			}
			const region = buildRegion(reply);
			this.regions.delete(k);
			this.regions.set(k, region);
			while (this.regions.size > MAX_REGIONS) {
				this.regions.delete(this.regions.keys().next().value);
			}
			this.pending.delete(k);
			for (const l of reply.labels || []) {
				if (l && l.pos) {
					this.labels.set(l.pos.x + "," + l.pos.y, l);
				}
			}
			this.fire("region", region);
		} catch (e) {
			if (key !== this.key) {
				return;
			}
			this.pending.delete(k);
			this.errors++;
			this.lastError = e.message;
			this.fire("error", e);
		}
		this.fire("status");
	}
}

function buildRegion(reply) {
	const { x, y, w, h } = reply.region;
	const n = w * h;
	const terrain = new Uint8Array(n);
	const height = new Int16Array(n);
	const tr = reply.terrain || [], hr = reply.height || [];
	const base = reply.height_base || 0;
	for (let j = 0; j < h; j++) {
		const ts = tr[j] || "", hs = hr[j] || "";
		const o = j * w;
		for (let i = 0; i < w; i++) {
			terrain[o + i] = ts.charCodeAt(i) || 46;
			height[o + i] = base + heightDigit(hs.charCodeAt(i));
		}
	}
	const gw = typeof reply.groundwater === "number" ? reply.groundwater : 0;
	// ground colour (land/water with hill shading) and final colour per tile
	const ground = new Uint8ClampedArray(n * 3);
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	const img = ctx.createImageData(w, h);
	const px = img.data;
	for (let j = 0; j < h; j++) {
		for (let i = 0; i < w; i++) {
			const o = j * w + i;
			const code = terrain[o];
			const z = height[o];
			let c;
			if (code === WATER) {
				const d = Math.min(1, Math.max(0, (gw - z) / 8));
				c = [WATER_SHALLOW[0] + (WATER_DEEP[0] - WATER_SHALLOW[0]) * d,
					WATER_SHALLOW[1] + (WATER_DEEP[1] - WATER_SHALLOW[1]) * d,
					WATER_SHALLOW[2] + (WATER_DEEP[2] - WATER_SHALLOW[2]) * d];
			} else {
				c = landColor(z - gw);
				const zw = i > 0 ? height[o - 1] : z, zn = j > 0 ? height[o - w] : z;
				const f = Math.max(0.78, Math.min(1.22, 1 + 0.045 * ((z - zw) + (z - zn))));
				c = [c[0] * f, c[1] * f, c[2] * f];
			}
			ground[o * 3] = c[0];
			ground[o * 3 + 1] = c[1];
			ground[o * 3 + 2] = c[2];
			let fc = CODE_OBJ[code];
			if (code === TREES) {
				fc = [c[0] * 0.62, c[1] * 0.78, c[2] * 0.55];
			} else if (code === POWER || !fc) {
				fc = c;
			}
			const p = o * 4;
			px[p] = fc[0];
			px[p + 1] = fc[1];
			px[p + 2] = fc[2];
			px[p + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	return { x, y, w, h, terrain, height, ground, canvas, stale: false, gw };
}

// --- the Leaflet layer -----------------------------------------------------------------------

function hash(x, y) {
	let h = (x * 374761393 + y * 668265263) | 0;
	h = (h ^ (h >>> 13)) * 1274126177;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const WAY_STYLE = {
	R: ["#9a9a9a", 0.46], "=": ["#4a3a2e", 0.22], t: ["#9c7b55", 0.3], n: ["#6e5135", 0.2], m: ["#8e6fb3", 0.24],
	g: ["#b0469a", 0.24], w: ["#3f8fd0", 0.5], a: ["#55555b", 0.6], X: ["#7a7a7a", 0.4], B: ["#7a6650", 0.42],
	E: ["#74747c", 0.42], U: ["#2b2b2b", 0.42], S: ["#7a7a7a", 0.36], D: ["#7a7a7a", 0.36],
};

/** options: Leaflet GridLayer options, e.g. minZoom when the layer only shows the detailed map. */
export function createTerrainLayer(terrain, options = {}) {
	const Layer = L.GridLayer.extend({
		createTile(coords, done) {
			const tile = document.createElement("canvas");
			this.drawTile(tile, coords, true);
			queueMicrotask(() => done(null, tile));
			return tile;
		},

		drawTile(tile, coords, request) {
			const s = Math.pow(2, coords.z); // pixels per map tile
			const span = 256 / s; // map tiles per Leaflet tile
			const x0 = coords.x * span, y0 = coords.y * span;
			const dpr = s >= 8 ? Math.min(2, window.devicePixelRatio || 1) : 1;
			const size = 256 * dpr;
			if (tile.width !== size) {
				tile.width = size;
				tile.height = size;
			}
			const ctx = tile.getContext("2d");
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, size, size);
			if (x0 >= terrain.sx || y0 >= terrain.sy || x0 + span <= 0 || y0 + span <= 0) {
				return;
			}
			const rx0 = Math.max(0, Math.floor(x0 / REGION)), ry0 = Math.max(0, Math.floor(y0 / REGION));
			const rx1 = Math.floor((Math.min(terrain.sx, x0 + span) - 1) / REGION);
			const ry1 = Math.floor((Math.min(terrain.sy, y0 + span) - 1) / REGION);
			const k = s * dpr;
			for (let ry = ry0; ry <= ry1; ry++) {
				for (let rx = rx0; rx <= rx1; rx++) {
					const r = terrain.get(rx, ry);
					if (request && (!r || r.stale)) {
						terrain.request(rx, ry);
					}
					if (!r) {
						continue;
					}
					const ix0 = Math.max(x0, r.x), iy0 = Math.max(y0, r.y);
					const ix1 = Math.min(x0 + span, r.x + r.w), iy1 = Math.min(y0 + span, r.y + r.h);
					if (ix1 <= ix0 || iy1 <= iy0) {
						continue;
					}
					if (s >= 8) {
						drawDetail(ctx, terrain, r, ix0, iy0, ix1, iy1, x0, y0, k);
					} else {
						ctx.imageSmoothingEnabled = s < 1;
						ctx.drawImage(r.canvas, ix0 - r.x, iy0 - r.y, ix1 - ix0, iy1 - iy0,
							(ix0 - x0) * k, (iy0 - y0) * k, (ix1 - ix0) * k, (iy1 - iy0) * k);
					}
				}
			}
		},

		/** Redraw the tiles that show a region (after it was loaded or refreshed). */
		refreshRegion(region) {
			for (const key in this._tiles) {
				const t = this._tiles[key];
				const s = Math.pow(2, t.coords.z), span = 256 / s;
				const x0 = t.coords.x * span, y0 = t.coords.y * span;
				// include the neighbour tiles: way lines connect across region borders
				if (x0 < region.x + region.w + 1 && x0 + span > region.x - 1 && y0 < region.y + region.h + 1 && y0 + span > region.y - 1) {
					this.drawTile(t.el, t.coords, false);
				}
			}
		},

		/** Request the stale regions under the tiles in view; the tiles are redrawn when they arrive. */
		requestStale() {
			for (const key in this._tiles) {
				const t = this._tiles[key];
				if (!t.current) {
					continue;
				}
				const span = 256 / Math.pow(2, t.coords.z);
				const x0 = t.coords.x * span, y0 = t.coords.y * span;
				for (let ry = Math.max(0, Math.floor(y0 / REGION)); ry * REGION < Math.min(terrain.sy, y0 + span); ry++) {
					for (let rx = Math.max(0, Math.floor(x0 / REGION)); rx * REGION < Math.min(terrain.sx, x0 + span); rx++) {
						const r = terrain.get(rx, ry);
						if (r && r.stale) {
							terrain.request(rx, ry);
						}
					}
				}
			}
		},

		/** Request the stale regions in view again. */
		refreshVisible() {
			for (const key in this._tiles) {
				const t = this._tiles[key];
				if (t.current) {
					this.drawTile(t.el, t.coords, true);
				}
			}
		},
	});
	return new Layer(Object.assign({ tileSize: 256, keepBuffer: 2, updateWhenZooming: false, minZoom: -8, maxZoom: 8, zIndex: 2 }, options));
}

function drawDetail(ctx, terrain, r, ix0, iy0, ix1, iy1, x0, y0, k) {
	const ground = r.ground, ter = r.terrain, w = r.w;
	const half = k / 2;
	for (let y = iy0; y < iy1; y++) {
		for (let x = ix0; x < ix1; x++) {
			const o = (y - r.y) * w + (x - r.x);
			const px = (x - x0) * k, py = (y - y0) * k;
			ctx.fillStyle = `rgb(${ground[o * 3]},${ground[o * 3 + 1]},${ground[o * 3 + 2]})`;
			ctx.fillRect(px, py, k + 0.5, k + 0.5);
			const code = ter[o];
			if (code === 46 || code === WATER) {
				continue;
			}
			const ch = String.fromCharCode(code);
			if (code === TREES) {
				ctx.fillStyle = "rgba(38,92,40,0.85)";
				for (let i = 0; i < 3; i++) {
					const hx = hash(x * 3 + i, y), hy = hash(y * 3 + i, x);
					ctx.beginPath();
					ctx.arc(px + k * (0.2 + 0.6 * hx), py + k * (0.2 + 0.6 * hy), k * 0.17, 0, 6.2832);
					ctx.fill();
				}
				continue;
			}
			if (BUILDING[code]) {
				const m = ch === "F" ? k * 0.04 : k * 0.12;
				ctx.fillStyle = css(OBJ[ch]);
				ctx.fillRect(px + m, py + m, k - 2 * m, k - 2 * m);
				ctx.strokeStyle = "rgba(0,0,0,0.35)";
				ctx.lineWidth = Math.max(1, k * 0.05);
				ctx.strokeRect(px + m, py + m, k - 2 * m, k - 2 * m);
				continue;
			}
			if (ch === "f") {
				ctx.fillStyle = css(OBJ.f);
				ctx.fillRect(px, py, k + 0.5, k + 0.5);
				ctx.strokeStyle = "rgba(120,90,20,0.35)";
				ctx.lineWidth = Math.max(1, k * 0.06);
				ctx.beginPath();
				for (let i = 1; i < 4; i++) {
					ctx.moveTo(px, py + (k * i) / 4);
					ctx.lineTo(px + k, py + (k * i) / 4);
				}
				ctx.stroke();
				continue;
			}
			if (ch === "o") {
				ctx.fillStyle = css(OBJ.o);
				ctx.beginPath();
				ctx.arc(px + half, py + half, k * 0.25, 0, 6.2832);
				ctx.fill();
				continue;
			}
			if (ch === "P") {
				ctx.fillStyle = "rgba(60,60,60,0.7)";
				ctx.fillRect(px + half - k * 0.06, py + half - k * 0.06, k * 0.12, k * 0.12);
				continue;
			}
			const style = WAY_STYLE[ch];
			if (!style) {
				continue;
			}
			const cx = px + half, cy = py + half;
			ctx.strokeStyle = style[0];
			ctx.lineWidth = Math.max(1.5, k * style[1]);
			ctx.lineCap = "round";
			ctx.beginPath();
			let links = 0;
			if (WAYISH[terrain.code(x, y - 1)]) { ctx.moveTo(cx, cy); ctx.lineTo(cx, py); links++; }
			if (WAYISH[terrain.code(x + 1, y)]) { ctx.moveTo(cx, cy); ctx.lineTo(px + k, cy); links++; }
			if (WAYISH[terrain.code(x, y + 1)]) { ctx.moveTo(cx, cy); ctx.lineTo(cx, py + k); links++; }
			if (WAYISH[terrain.code(x - 1, y)]) { ctx.moveTo(cx, cy); ctx.lineTo(px, cy); links++; }
			if (!links) {
				ctx.moveTo(cx - k * 0.2, cy);
				ctx.lineTo(cx + k * 0.2, cy);
			}
			ctx.stroke();
			if (ch === "S" || ch === "D") {
				ctx.fillStyle = css(OBJ[ch]);
				const m = k * 0.22;
				ctx.fillRect(px + m, py + m, k - 2 * m, k - 2 * m);
			} else if (ch === "U") {
				ctx.fillStyle = "#111";
				ctx.beginPath();
				ctx.arc(cx, cy, k * 0.3, 0, 6.2832);
				ctx.fill();
			} else if (ch === "B" || ch === "E") {
				ctx.strokeStyle = "rgba(0,0,0,0.35)";
				ctx.lineWidth = Math.max(1, k * 0.05);
				ctx.strokeRect(px + k * 0.25, py + k * 0.25, k * 0.5, k * 0.5);
			}
		}
	}
}
