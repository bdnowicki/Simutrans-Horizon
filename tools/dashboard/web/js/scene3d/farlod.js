// Simutrans-Horizon dashboard, 3D view: the far terrain. One coarse mesh of the whole map from /api/heights (at
// most 66049 samples per request: larger maps or finer steps are fetched in regions), textured with the minimap
// tiles (/tiles/<mode>/<step>/<cx>/<cy>.png) of the climates mode (the ground by climate, water, cities, ways, stops,
// factories and their fields) and of the forest mode (the squares with trees darken), drawn into one canvas with the
// colours of the near chunks, so the map reads from far away and matches them at the seams.
// It is not drawn where a near chunk is shown: a mask texture of the chunks (one texel per 64 x 64 chunk, updated when
// chunks.js changes its `version`) makes the fragment shader discard those squares, so the coarse surface can neither
// z-fight with nor poke through the detailed one. It also lies a little lower (BIAS), so that along the seams the
// skirts of the chunks show instead of slivers of its edge; it is double sided, so a remaining gap shows its
// underside, not the sky. map_changes refresh it at most every 10 s (the bridge refreshes heights no faster).
// Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { S, subscribe } from "/js/store.js";
import { b64ToBytes, inflate } from "./decode.js";
import { rgb8 } from "./meshbuf.js";
import { CHUNK, HEIGHT_STEP, yieldTask, compileSpread } from "./config.js";
import { envMaterial } from "./sky.js";

const MAX_SAMPLES = 66049; // per heights request (bridge and game)
const REGION = 256; // squares per region side in steps (+1 shared edge row = 257 samples)
const TILE = 256; // pixels of a map tile
const REFRESH_MS = 10000;
const FIRST_REFRESH_MS = 1500;
const UPLOAD_MS = 250;
const TILE_CONCURRENCY = 4;
const BIAS = -0.08;
const STEPS = [1, 2, 4, 8, 16];

// colours (sRGB) of the far terrain: those of the near chunks (terrain.js, objects.js, parts.js)
const CLIMATE_RGB = [[0.55, 0.62, 0.40], [0.86, 0.78, 0.52], [0.25, 0.55, 0.20], [0.60, 0.65, 0.33],
	[0.38, 0.58, 0.26], [0.52, 0.56, 0.38], [0.55, 0.52, 0.47], [0.93, 0.95, 0.97]];
const LAND = CLIMATE_RGB[4];
const TREES = [0.24, 0.45, 0.21];
const FOREST_MIX = 0.5;
const WATER = [0.23, 0.42, 0.63];
const CITY = [0.68, 0.62, 0.56];
const ROAD = [0.33, 0.33, 0.36];
const RAIL = [0.46, 0.37, 0.29];
const STOP = [0.95, 0.84, 0.22];
const DECK = [0.50, 0.50, 0.53];
const CLIFF = [0.42, 0.36, 0.30];
// palette indices of the game's minimap (src/simutrans/gui/minimap.cc, simcolor.h); climates 1..7 as in scene3d
const PAL = { city: 212, road: 208, rail: 185, halt: 131, bridge: 232, trees: 140 };
const PAL_CLIMATES = [171, 143, 140, 136, 168, 189, 11];
const MODES = ["climates", "forest"];

const pack = (r, g, b) => (r << 16) | (g << 8) | b;
const to8 = (rgb, k = 1) => rgb.map((v) => Math.max(0, Math.min(255, Math.round(v * k * 255))));

let recolorFor = null, recolorMap = null;
/**
 * From the game's palette (null without one): {map: RGB of a minimap colour -> RGB of the 3D view, trees: RGB of the
 * tree squares of the forest mode}.
 */
function recolorTable(pal) {
	if (!pal || !Array.isArray(pal.colors) || pal.colors.length !== 256) {
		return null;
	}
	if (recolorFor === pal) {
		return recolorMap;
	}
	const m = new Map(), col = (i) => pal.colors[i & 255] || [0, 0, 0];
	const set = (i, rgb) => m.set(pack(...col(i)), rgb);
	set(PAL.city, to8(CITY));
	set(PAL.road, to8(ROAD));
	set(PAL.rail, to8(RAIL));
	set(PAL.halt, to8(STOP));
	set(PAL.bridge, to8(DECK));
	PAL_CLIMATES.forEach((i, n) => set(i, to8(CLIMATE_RGB[n + 1], 0.97)));
	// the height colours win where a palette repeats a colour (the land is most of the map)
	const hc = Array.isArray(pal.height_colors) ? pal.height_colors : [];
	hc.forEach((i, n) => set(i, n < 5 ? to8(WATER, 0.9 + 0.025 * n) : to8(LAND, 0.9 + 0.2 * Math.min(1, (n - 5) / 30))));
	recolorFor = pal;
	recolorMap = { map: m, trees: pack(...col(PAL.trees)) };
	return recolorMap;
}

class HttpError extends Error {
	constructor(status, message, retry) {
		super(message);
		this.status = status;
		this.retry = retry;
	}
}

async function fetchOk(url) {
	const r = await fetch(url, { credentials: "same-origin", cache: "no-cache" });
	if (!r.ok) {
		throw new HttpError(r.status, "HTTP " + r.status + " for " + url.split("?")[0], Number(r.headers.get("Retry-After")) || 1);
	}
	return r;
}

/** Smallest step of STEPS (from `from`) with at most `limit` samples for the whole map, else the largest. */
function stepFor(sx, sy, limit, from = 1) {
	for (const s of STEPS) {
		if (s >= from && (Math.ceil(sx / s) + 1) * (Math.ceil(sy / s) + 1) <= limit) {
			return s;
		}
	}
	return STEPS[STEPS.length - 1];
}

function maskMaterial(base, mask) {
	base.onBeforeCompile = (sh) => {
		sh.uniforms.uNearMask = { value: mask.tex };
		sh.uniforms.uNearScale = { value: mask.scale };
		sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vFarXZ;")
			.replace("#include <begin_vertex>", "#include <begin_vertex>\nvFarXZ = position.xz;");
		sh.fragmentShader = sh.fragmentShader.replace("#include <common>",
			"#include <common>\nvarying vec2 vFarXZ;\nuniform sampler2D uNearMask;\nuniform vec2 uNearScale;")
			.replace("void main() {", "void main() {\n\tif (texture2D(uNearMask, vFarXZ * uNearScale).r > 0.5) discard;");
	};
	base.customProgramCacheKey = () => "farlod-mask";
	return base;
}

export class FarLayer {
	/** view: {scene, renderer, chunks, quality, status(), authFailed()} */
	constructor(view) {
		this.view = view;
		this.quality = view.quality;
		this.group = new THREE.Group();
		this.group.name = "far";
		view.scene.add(this.group);
		this.gen = 0;
		this.size = null;
		this.grid = null;
		this.mesh = null;
		this.canvas = null;
		this.tex = null;
		this.mask = null;
		this.ready = false;
		this.error = null;
		this.reset();
		this.unsub = subscribe(["palette"], () => {
			if (this.canvas && this.tiles) {
				// drawn before the palette arrived (or with another one): map the colours again
				for (const t of this.tiles.values()) {
					t.etag = null;
				}
				this.markTiles(null);
				this.schedule();
			}
		});
	}

	reset() {
		this.gen++;
		clearTimeout(this.retryTimer);
		if (this.mesh) {
			this.mesh.removeFromParent();
			this.mesh.geometry.dispose();
			this.mesh = null;
		}
		for (const m of this.mats || []) {
			m.dispose();
		}
		this.mats = null;
		if (this.tex) {
			this.tex.dispose();
			this.tex = null;
		}
		if (this.mask) {
			this.mask.tex.dispose();
			this.mask = null;
		}
		this.canvas = null;
		this.grid = null;
		this.ready = false;
		this.error = null;
		this.tiles = null;
		this.tileQueue = [];
		this.tileInflight = 0;
		this.texDirty = false;
		this.uploadAt = 0;
		this.nearVer = -1;
		this.refreshAt = 0;
		this.lastRefresh = 0;
		this.refreshing = false;
		this.dirtyHeights = false;
		this.pausedUntil = 0;
		this.stats = { heightRequests: [], tileRequests: 0, tileErrors: 0, tilesChanged: 0, builds: 0, buildMs: null,
			refreshes: 0, heightsUnchanged: 0 };
	}

	// --- start: heights, mesh, texture -----------------------------------------------------------------------

	async start(sx, sy) {
		this.reset();
		this.size = { x: sx, y: sy };
		const gen = this.gen;
		const step = stepFor(sx, sy, this.quality.farSamples, 4);
		try {
			const grid = await this.fetchHeights(step, gen);
			if (gen !== this.gen) {
				return;
			}
			this.grid = grid;
			const mesh = this.buildMesh();
			// its two shader programs one per task (compiled off the main thread where the browser can), then the
			// texture uploaded in a task of its own: no long first frame with the far terrain on a slow phone
			const alive = () => gen === this.gen;
			await yieldTask();
			await compileSpread(this.view.renderer, mesh.material.map((m) => new THREE.Mesh(mesh.geometry, m)),
				this.view.rig.camera, this.view.scene, alive);
			if (alive()) {
				this.view.renderer.initTexture(this.tex);
				await yieldTask();
			}
			if (gen !== this.gen) {
				mesh.geometry.dispose();
				return;
			}
			this.mesh = mesh;
			this.group.add(mesh);
			this.ready = true;
			this.view.dirty = true;
			this.view.status();
			this.startTiles();
		} catch (e) {
			if (gen !== this.gen) {
				return;
			}
			if (e.status === 401) {
				this.view.authFailed();
			} else if (e.status === 429 || e.status === 503 || e.status === 502 || e.status === 0 || e.status === undefined) {
				this.retryTimer = setTimeout(() => this.start(sx, sy), Math.max(1, e.retry || 2) * 1000);
			} else {
				this.error = String(e.message || e);
				this.view.status();
			}
		}
	}

	/** The heights of the whole map at `step`, in regions of at most MAX_SAMPLES samples. */
	async fetchHeights(step, gen, old) {
		const { x: sx, y: sy } = this.size;
		const W = Math.ceil(sx / step) + 1, H = Math.ceil(sy / step) + 1;
		const lev = old ? old.lev : new Int8Array(W * H), floor = old ? old.floor : new Int8Array(W * H);
		const side = REGION * step, etags = [];
		let changed = !old;
		for (let ry = 0; ry * side < sy; ry++) {
			for (let rx = 0; rx * side < sx; rx++) {
				const x1 = rx * side, y1 = ry * side, x2 = Math.min(sx - 1, x1 + side - 1), y2 = Math.min(sy - 1, y1 + side - 1);
				const w = Math.ceil((x2 - x1 + 1) / step) + 1, h = Math.ceil((y2 - y1 + 1) / step) + 1;
				if (w * h > MAX_SAMPLES) {
					throw new Error("heights region too large");
				}
				const whole = x1 === 0 && y1 === 0 && x2 === sx - 1 && y2 === sy - 1;
				const url = `/api/heights?step=${step}` + (whole ? "" : `&x1=${x1}&y1=${y1}&x2=${x2}&y2=${y2}`);
				this.stats.heightRequests.push({ step, x1, y1, x2, y2, samples: w * h });
				if (this.stats.heightRequests.length > 64) {
					this.stats.heightRequests.shift();
				}
				const r = await fetchOk(url);
				const etag = r.headers.get("ETag");
				const j = await r.json();
				if (gen !== this.gen) {
					return null;
				}
				etags.push(etag);
				const k = etags.length - 1;
				if (old && old.etags[k] && old.etags[k] === etag) {
					continue;
				}
				changed = true;
				if (j.w !== w || j.h !== h) {
					throw new Error("heights: unexpected size " + j.w + "x" + j.h);
				}
				const hs = await inflate(b64ToBytes(j.heights)), ws = await inflate(b64ToBytes(j.water_heights));
				if (hs.length !== w * h || ws.length !== w * h) {
					throw new Error("heights: bad block size");
				}
				const hv = new Int8Array(hs.buffer, hs.byteOffset, hs.length), wv = new Int8Array(ws.buffer, ws.byteOffset, ws.length);
				const c0 = rx * REGION, r0 = ry * REGION;
				for (let j2 = 0; j2 < h; j2++) {
					for (let i = 0; i < w; i++) {
						const s = j2 * w + i, d = (r0 + j2) * W + c0 + i;
						lev[d] = Math.max(hv[s], wv[s]);
						floor[d] = hv[s];
					}
				}
			}
		}
		const colX = new Float32Array(W), rowZ = new Float32Array(H);
		for (let i = 0; i < W; i++) {
			colX[i] = Math.min(i * step, sx);
		}
		for (let j = 0; j < H; j++) {
			rowZ[j] = Math.min(j * step, sy);
		}
		return { step, W, H, lev, floor, colX, rowZ, etags, changed };
	}

	buildMesh() {
		const t0 = performance.now();
		const g = this.grid, { W, H, lev, colX, rowZ } = g, hs = HEIGHT_STEP;
		let minLev = 127;
		for (let i = 0; i < g.floor.length; i++) {
			minLev = Math.min(minLev, g.floor[i]);
		}
		const floorY = (minLev - 2) * hs;
		const nTop = W * H, nSkirt = 4 * (W + H);
		const pos = new Float32Array((nTop + nSkirt) * 3), uv = new Float32Array((nTop + nSkirt) * 2);
		const col = new Uint8Array((nTop + nSkirt) * 3);
		const tex = this.texInfo(), water8 = rgb8(WATER), land8 = rgb8(LAND);
		for (let j = 0; j < H; j++) {
			for (let i = 0; i < W; i++) {
				const v = j * W + i;
				pos[v * 3] = colX[i];
				pos[v * 3 + 1] = lev[v] * hs + BIAS;
				pos[v * 3 + 2] = rowZ[j];
				uv[v * 2] = colX[i] / tex.ts / tex.cw;
				uv[v * 2 + 1] = rowZ[j] / tex.ts / tex.ch;
				col.set(lev[v] > g.floor[v] ? water8 : land8, v * 3);
			}
		}
		const cells = (W - 1) * (H - 1);
		const idx = new Uint32Array(cells * 6 + 2 * (W - 1 + H - 1) * 6);
		let n = 0;
		for (let j = 0; j + 1 < H; j++) {
			for (let i = 0; i + 1 < W; i++) {
				const a = j * W + i, b = a + 1, c = a + W, d = c + 1; // nw ne sw se
				if (Math.abs(lev[a] - lev[d]) <= Math.abs(lev[b] - lev[c])) {
					idx[n] = a; idx[n + 1] = c; idx[n + 2] = d; idx[n + 3] = a; idx[n + 4] = d; idx[n + 5] = b;
				} else {
					idx[n] = a; idx[n + 1] = c; idx[n + 2] = b; idx[n + 3] = b; idx[n + 4] = c; idx[n + 5] = d;
				}
				n += 6;
			}
		}
		const topCount = n;
		// skirts along the map border down below the lowest ground, like those of the chunks
		const cliff = rgb8(CLIFF);
		let v = nTop;
		const edge = (verts) => {
			const start = v;
			for (const t of verts) {
				for (const low of [false, true]) {
					pos[v * 3] = pos[t * 3];
					pos[v * 3 + 1] = low ? floorY : pos[t * 3 + 1];
					pos[v * 3 + 2] = pos[t * 3 + 2];
					col.set(cliff, v * 3);
					v++;
				}
			}
			for (let k = 0; k + 1 < verts.length; k++) {
				const p = start + 2 * k;
				idx[n] = p; idx[n + 1] = p + 1; idx[n + 2] = p + 3; idx[n + 3] = p; idx[n + 4] = p + 3; idx[n + 5] = p + 2;
				n += 6;
			}
		};
		const range = (len, f) => Array.from({ length: len }, (_, k) => f(k));
		edge(range(W, (i) => i));
		edge(range(W, (i) => (H - 1) * W + i));
		edge(range(H, (j) => j * W));
		edge(range(H, (j) => j * W + W - 1));
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
		geo.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
		geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array((nTop + nSkirt) * 3), 3));
		geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1));
		geo.addGroup(0, topCount, 0);
		geo.addGroup(topCount, n - topCount, 1);
		this.normals(geo);
		geo.computeBoundingSphere();
		this.makeMask();
		this.makeTexture(tex);
		const top = envMaterial(maskMaterial(new THREE.MeshStandardMaterial({ map: this.tex, roughness: 0.95, metalness: 0,
			side: THREE.DoubleSide }), this.mask), { ground: "frag", k: 0.9 });
		const skirt = maskMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0,
			side: THREE.DoubleSide, flatShading: true }), this.mask);
		const mesh = new THREE.Mesh(geo, [top, skirt]);
		mesh.name = "far terrain";
		mesh.matrixAutoUpdate = false;
		this.mats = [top, skirt];
		this.stats.builds++;
		this.stats.buildMs = Math.round((performance.now() - t0) * 10) / 10;
		return mesh;
	}

	/** New heights of the same grid: positions and normals updated in place. */
	updateHeights() {
		const g = this.grid, pos = this.mesh.geometry.attributes.position.array, hs = HEIGHT_STEP;
		for (let v = 0; v < g.W * g.H; v++) {
			pos[v * 3 + 1] = g.lev[v] * hs + BIAS;
		}
		const W = g.W, H = g.H;
		let v = W * H;
		const edge = (verts) => {
			for (const t of verts) {
				pos[v * 3 + 1] = pos[t * 3 + 1];
				v += 2;
			}
		};
		edge(Array.from({ length: W }, (_, i) => i));
		edge(Array.from({ length: W }, (_, i) => (H - 1) * W + i));
		edge(Array.from({ length: H }, (_, j) => j * W));
		edge(Array.from({ length: H }, (_, j) => j * W + W - 1));
		const geo = this.mesh.geometry;
		geo.attributes.position.needsUpdate = true;
		this.normals(geo);
		geo.computeBoundingSphere();
		this.stats.builds++;
	}

	/** Normals of the top grid from its height differences (the skirts are drawn flat shaded). */
	normals(geo) {
		const g = this.grid, { W, H, colX, rowZ } = g, pos = geo.attributes.position.array, nor = geo.attributes.normal;
		const a = nor.array;
		for (let j = 0; j < H; j++) {
			const j0 = Math.max(0, j - 1), j1 = Math.min(H - 1, j + 1);
			for (let i = 0; i < W; i++) {
				const i0 = Math.max(0, i - 1), i1 = Math.min(W - 1, i + 1);
				const dx = (pos[(j * W + i1) * 3 + 1] - pos[(j * W + i0) * 3 + 1]) / (colX[i1] - colX[i0]);
				const dz = (pos[(j1 * W + i) * 3 + 1] - pos[(j0 * W + i) * 3 + 1]) / (rowZ[j1] - rowZ[j0]);
				const k = 1 / Math.sqrt(dx * dx + dz * dz + 1), v = (j * W + i) * 3;
				a[v] = -dx * k;
				a[v + 1] = k;
				a[v + 2] = -dz * k;
			}
		}
		for (let v = W * H * 3 + 1; v < a.length; v += 3) {
			a[v] = 1;
		}
		nor.needsUpdate = true;
	}

	makeMask() {
		const nx = Math.ceil(this.size.x / CHUNK), ny = Math.ceil(this.size.y / CHUNK);
		const data = new Uint8Array(nx * ny);
		const tex = new THREE.DataTexture(data, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
		tex.magFilter = THREE.NearestFilter;
		tex.minFilter = THREE.NearestFilter;
		tex.generateMipmaps = false;
		tex.unpackAlignment = 1;
		tex.needsUpdate = true;
		this.mask = { tex, data, nx, ny, scale: new THREE.Vector2(1 / (nx * CHUNK), 1 / (ny * CHUNK)), shown: 0 };
		this.nearVer = -1;
	}

	/** Size of the texture: pixels per square side 1/ts, ts as small as the quality profile allows. */
	texInfo() {
		const { x: sx, y: sy } = this.size;
		let ts = 1;
		while (ts < 16 && Math.max(Math.ceil(sx / ts), Math.ceil(sy / ts)) > this.quality.farTexture) {
			ts *= 2;
		}
		const cw = Math.ceil(sx / ts), ch = Math.ceil(sy / ts);
		return { ts, cw, ch, nx: Math.ceil(cw / TILE), ny: Math.ceil(ch / TILE) };
	}

	makeTexture(ti) {
		const c = document.createElement("canvas");
		c.width = ti.cw;
		c.height = ti.ch;
		const ctx = c.getContext("2d", { willReadFrequently: true });
		ctx.fillStyle = "rgb(" + to8(LAND).join(",") + ")";
		ctx.fillRect(0, 0, ti.cw, ti.ch);
		this.canvas = c;
		this.ctx = ctx;
		this.ti = ti;
		const tex = new THREE.CanvasTexture(c);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.flipY = false;
		tex.magFilter = THREE.NearestFilter;
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		tex.anisotropy = Math.min(8, this.view.renderer.capabilities.getMaxAnisotropy());
		tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
		this.tex = tex;
	}

	// --- minimap tiles -----------------------------------------------------------------------------------------

	startTiles() {
		const ti = this.ti;
		this.tiles = new Map();
		for (let ty = 0; ty < ti.ny; ty++) {
			for (let tx = 0; tx < ti.nx; tx++) {
				this.tiles.set(tx + "," + ty, { tx, ty, etag: null, state: "idle", dirty: false });
			}
		}
		this.tileQueue = [...this.tiles.keys()];
	}

	/** Tiles to load again: chunks [[cx, cy], ...] of 256 x 256 squares, or all (null). */
	markTiles(chunks) {
		if (!this.tiles) {
			return;
		}
		const ts = this.ti.ts;
		const keys = chunks ? chunks.filter((c) => Array.isArray(c)).map((c) => Math.floor(c[0] / ts) + "," + Math.floor(c[1] / ts))
			: [...this.tiles.keys()];
		for (const k of keys) {
			const t = this.tiles.get(k);
			if (t && !this.tileQueue.includes(k)) {
				t.dirty = true;
			}
		}
	}

	pumpTiles(now) {
		if (now < this.pausedUntil) {
			return;
		}
		while (this.tileInflight < TILE_CONCURRENCY && this.tileQueue.length) {
			this.loadTile(this.tiles.get(this.tileQueue.shift()));
		}
	}

	async loadTile(t) {
		const gen = this.gen, ti = this.ti;
		this.tileInflight++;
		t.state = "loading";
		this.stats.tileRequests++;
		try {
			const rs = await Promise.all(MODES.map((m) => fetchOk(`/tiles/${m}/${ti.ts}/${t.tx}/${t.ty}.png`)));
			const etag = rs.map((r) => r.headers.get("ETag")).join("|");
			if (gen !== this.gen) {
				return;
			}
			if (etag && etag === t.etag) {
				t.state = "ready";
				return;
			}
			const bmps = await Promise.all(rs.map(async (r) => createImageBitmap(await r.blob())));
			if (gen !== this.gen) {
				bmps.forEach((b) => b.close());
				return;
			}
			this.drawTile(t, bmps[0], bmps[1]);
			bmps.forEach((b) => b.close());
			t.etag = etag;
			t.state = "ready";
			this.stats.tilesChanged++;
		} catch (e) {
			if (gen !== this.gen) {
				return;
			}
			this.stats.tileErrors++;
			t.state = "idle";
			if (e.status === 401) {
				this.view.authFailed();
			} else if (e.status !== 404) {
				this.pausedUntil = performance.now() + Math.max(1, e.retry || 2) * 1000;
				this.tileQueue.push(t.tx + "," + t.ty);
			} else {
				t.state = "missing";
				this.withoutTiles();
			}
		} finally {
			if (gen === this.gen) {
				this.tileInflight--;
			}
		}
	}

	/** No minimap tiles (a game without the map export): land and water from the heights' vertex colours. */
	withoutTiles() {
		const m = this.mesh && this.mesh.material[0];
		if (m && m.map) {
			m.map = null;
			m.vertexColors = true;
			m.needsUpdate = true;
			this.view.dirty = true;
		}
	}

	/** One tile: the climates picture in the colours of the 3D view, darker where the forest picture has trees. */
	drawTile(t, climates, forest) {
		const ctx = this.ctx, x = t.tx * TILE, y = t.ty * TILE;
		const w = Math.min(TILE, this.ti.cw - x), h = Math.min(TILE, this.ti.ch - y);
		if (w <= 0 || h <= 0) {
			return;
		}
		ctx.clearRect(x, y, w, h);
		ctx.drawImage(forest, 0, 0, w, h, x, y, w, h);
		const fd = ctx.getImageData(x, y, w, h).data;
		ctx.clearRect(x, y, w, h);
		ctx.drawImage(climates, 0, 0, w, h, x, y, w, h);
		const tab = recolorTable(S.palette), map = tab && tab.map;
		const img = ctx.getImageData(x, y, w, h), d = img.data, land = to8(LAND), trees = to8(TREES), k = FOREST_MIX;
		for (let i = 0; i < d.length; i += 4) {
			if (d[i + 3] === 0) {
				d[i] = land[0];
				d[i + 1] = land[1];
				d[i + 2] = land[2];
				d[i + 3] = 255;
				continue;
			}
			const rgb = map && map.get(pack(d[i], d[i + 1], d[i + 2]));
			if (rgb) {
				d[i] = rgb[0];
				d[i + 1] = rgb[1];
				d[i + 2] = rgb[2];
			}
			if (tab && fd[i + 3] && pack(fd[i], fd[i + 1], fd[i + 2]) === tab.trees) {
				d[i] = d[i] * (1 - k) + trees[0] * k;
				d[i + 1] = d[i + 1] * (1 - k) + trees[1] * k;
				d[i + 2] = d[i + 2] * (1 - k) + trees[2] * k;
			}
		}
		ctx.putImageData(img, x, y);
		this.texDirty = true;
	}

	// --- changes ---------------------------------------------------------------------------------------------

	onMapChanges(d) {
		if (!this.ready) {
			return;
		}
		if (d.full) {
			this.markTiles(null);
		} else if (Array.isArray(d.chunks) && d.chunks.length) {
			this.markTiles(d.chunks);
		} else if (!(Array.isArray(d.cells) && d.cells.length)) {
			return;
		}
		this.dirtyHeights = true;
		this.schedule();
	}

	onSnapshot() {
		if (this.ready) {
			this.markTiles(null);
			this.dirtyHeights = true;
			this.schedule();
		}
	}

	schedule() {
		if (!this.refreshAt) {
			const now = performance.now();
			this.refreshAt = Math.max(now + FIRST_REFRESH_MS, this.lastRefresh + REFRESH_MS);
		}
	}

	async refresh() {
		const gen = this.gen;
		this.refreshing = true;
		this.refreshAt = 0;
		this.lastRefresh = performance.now();
		this.stats.refreshes++;
		for (const [k, t] of this.tiles) {
			if (t.dirty) {
				t.dirty = false;
				if (!this.tileQueue.includes(k)) {
					this.tileQueue.push(k);
				}
			}
		}
		if (this.dirtyHeights) {
			this.dirtyHeights = false;
			try {
				const g = await this.fetchHeights(this.grid.step, gen, this.grid);
				if (gen !== this.gen || !g) {
					return;
				}
				if (g.changed) {
					this.grid = g;
					this.updateHeights();
					this.view.dirty = true;
				} else {
					this.grid.etags = g.etags;
					this.stats.heightsUnchanged++;
				}
			} catch (e) {
				if (gen === this.gen) {
					this.dirtyHeights = true;
					if (e.status === 401) {
						this.view.authFailed();
					}
				}
			}
		}
		if (gen === this.gen) {
			this.refreshing = false;
			if (this.dirtyHeights || [...this.tiles.values()].some((t) => t.dirty)) {
				this.schedule();
			}
		}
	}

	// --- per frame -------------------------------------------------------------------------------------------

	update(now) {
		if (!this.mesh) {
			return false;
		}
		let changed = false;
		const ch = this.view.chunks;
		if (ch.version !== this.nearVer) {
			this.nearVer = ch.version;
			const m = this.mask;
			m.data.fill(0);
			let shown = 0;
			ch.eachShown((cx, cy) => {
				if (cx < m.nx && cy < m.ny) {
					m.data[cy * m.nx + cx] = 255;
					shown++;
				}
			});
			m.shown = shown;
			m.tex.needsUpdate = true;
			changed = true;
		}
		this.pumpTiles(now);
		if (this.texDirty && now - this.uploadAt >= UPLOAD_MS) {
			this.texDirty = false;
			this.uploadAt = now;
			this.tex.needsUpdate = true;
			changed = true;
		}
		if (this.refreshAt && now >= this.refreshAt && !this.refreshing) {
			this.refresh();
		}
		return changed;
	}

	onView() {}

	/** World height of the far ground at (x, z) (bilinear between the samples), or null. */
	groundAt(x, z) {
		const g = this.grid;
		if (!g || x < 0 || z < 0 || x > this.size.x || z > this.size.y) {
			return null;
		}
		const fx = Math.min(g.W - 1.0001, x / g.step), fz = Math.min(g.H - 1.0001, z / g.step);
		const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
		const L = g.lev, a = j * g.W + i;
		const h = L[a] * (1 - u) * (1 - v) + L[a + 1] * u * (1 - v) + L[a + g.W] * (1 - u) * v + L[a + g.W + 1] * u * v;
		return h * HEIGHT_STEP;
	}

	/** Heights and texture loaded, nothing loading (a refresh may be scheduled; tests, screenshots). */
	settled() {
		if (this.error) {
			return true;
		}
		if (!this.ready || this.texDirty || this.refreshing || this.tileInflight || this.tileQueue.length) {
			return false;
		}
		return ![...this.tiles.values()].some((t) => t.state === "loading" || t.state === "idle");
	}

	info() {
		const g = this.grid, tiles = this.tiles ? [...this.tiles.values()] : [];
		return {
			ready: this.ready, error: this.error, step: g ? g.step : null, samples: g ? g.W * g.H : 0,
			triangles: this.mesh ? this.mesh.geometry.index.count / 3 : 0, visible: !!(this.mesh && this.mesh.visible),
			heightRequests: this.stats.heightRequests.slice(), maskShown: this.mask ? this.mask.shown : 0,
			tiles: { step: this.ti ? this.ti.ts : null, total: tiles.length, ready: tiles.filter((t) => t.state === "ready").length,
				modes: MODES, requests: this.stats.tileRequests * MODES.length, errors: this.stats.tileErrors,
				changed: this.stats.tilesChanged },
			builds: this.stats.builds, build_ms: this.stats.buildMs, refreshes: this.stats.refreshes,
			refreshedAt: Math.round(this.lastRefresh),
			heightsUnchanged: this.stats.heightsUnchanged, texture: this.ti ? [this.ti.cw, this.ti.ch] : null,
		};
	}

	dispose() {
		this.unsub();
		this.reset();
		this.group.removeFromParent();
	}
}
