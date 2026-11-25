// Simutrans-Horizon dashboard, 3D view: the moving vehicles. Polls /api/vehicles3d for the squares around the view
// (at most 256 x 256, at most 5 per second, slower while the game is paused or nothing moves, none while zoomed out or
// the page is hidden) and draws every car as an instance of its generated body (gen/vehicles.js), one InstancedMesh
// per body shape. Motion is snapshot interpolation: the cars are drawn about 1.5 sample intervals in the past, between
// two samples of the same car (convoy id + index; city cars and pedestrians are matched to their previous sample by
// place), along the path through the edges of the squares (no cut corners), with the game time estimated from the
// replies (ticks, paused). Reversals, depot exits and entries and jumps hold the car and then place it anew instead
// of moving it across; tunnels hide it. Convoy cars are drawn as chords from their front to the next car's front,
// like the game. Clicks pick cars before squares; the view can follow a convoy. A car whose desc has a model in the
// pak 3D is drawn with it (pakmodels.js ModelBatch, LOD by its size on the screen; the generated body while the
// model loads or when it cannot be used). Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { loadPref, savePref, convoyLive } from "/js/store.js";
import { ownerColor } from "/js/colors.js";
import { b64ToBytes, inflate } from "./decode.js";
import { HEIGHT_STEP, yieldTask, compileSpread } from "./config.js";
import { createClassifier, buildShape } from "./gen/vehicles.js";
import { createMatcher, expand } from "./pak.js";
import { ModelBatch, lodLevel, warnOnce } from "./pakmodels.js";

export const VEH_LAYOUT = "cnv:u16,desc:i16,x:u16,y:u16,ox:i16,oy:i16,zoff:i16,speed:u16,flags:u16,idx:u8,kind:u8,z:i8,"
	+ "dir:u8,steps:u8,steps_next:u8,nx:i8,ny:i8,nz:i8,owner:i8";
export const VF = { FRONT: 1, LAST: 2, LEAVING: 4, ENTERING: 8, LOADING: 16, WAITING: 32, TUNNEL: 64, HIDDEN: 128, FLYING: 256,
	OVERTAKE: 512 };

const MIN_INTERVAL = 205; // ms between two requests: at most 5 per second (the bridge's limit per session)
const IDLE_INTERVAL = 600; // nothing moved in the last replies
const PAUSED_INTERVAL = 1000;
const IDLE_REPLIES = 3;
const MAX_SIDE = 256; // squares per side of a request (the bridge's limit, also the game's for extras)
const QUANT = 8; // request regions snap to multiples of this (shared bridge cache, fewer distinct requests)
const MARGIN = 6; // squares around the view
const MIN_PPU = 5; // closer than this many pixels per square: vehicles are fetched and drawn
const EXTRAS_MIN_PPU = 10; // city cars from this zoom on (in the free camera: where they are this large)
const WALKERS_MIN_PPU = 32; // pedestrians likewise
const KEEP = 6; // samples per car
const EXTRAP_MS = 250; // a late reply: cars go on for at most this long, then wait
const DELAY_MS = 450; // cars are drawn this long in the past (2 request intervals plus the reply time) ...
const DELAY_MAX = 1200; // ... longer while replies come too late for it (fast forward runs unevenly)
const EXTRAP_MAX = 0.35; // squares a car may go on beyond its last sample
const LANE = 0.14; // road vehicles: right hand lane, squares from the centre line (pak images carry the lane)
const SIDEWALK = 0.33;
const CORNER = 0.12; // headings are blended over this distance around the corners of a path
const TURN_RATE = 0.012; // radians per ms at most (about 690 degrees per second)
const PICK_SLACK = { mouse: 6, touch: 14, pen: 10 };
const SNAP_PX = 6;
const FOLLOW_MS = 700;
const MAX_FRAME_SAMPLES = 240;
const EXTRA_KEY = 1 << 24;
const SHAPE_MS = 6; // new car shapes are generated for at most this long per frame (the rest in the next frames)

const DIRV = (() => {
	const v = new Map();
	const s = Math.SQRT1_2;
	[[1, 0, -1], [2, 1, 0], [4, 0, 1], [8, -1, 0], [3, s, -s], [6, s, s], [12, -s, s], [9, -s, -s]].forEach(([d, x, z]) => v.set(d, [x, z]));
	return v;
})();
const reverseOf = (d) => ((d << 2) | (d >> 2)) & 15;
const SIDE = { 1: [0, -1], 2: [1, 0], 4: [0, 1], 8: [-1, 0] };

function pct(arr, p) {
	const s = arr.slice().sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
}

function hidden(fl) {
	return (fl & VF.TUNNEL) !== 0 || ((fl & VF.HIDDEN) !== 0 && (fl & VF.FLYING) === 0);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function cssLinear(css) {
	const m = /^#([0-9a-f]{6})$/i.exec(css || "");
	const rgb = m ? [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16) / 255) : [0.55, 0.55, 0.58];
	return rgb.map(toLinear);
}

/** A vehicles3d reply -> columns (typed arrays) of its rows. */
export async function decodeVehicles(j) {
	const n = j.count | 0;
	if (Array.isArray(j.objs)) {
		const keys = VEH_LAYOUT.split(",").map((f) => f.split(":")[0]);
		const c = { n };
		keys.forEach((k, i) => {
			c[k] = Float64Array.from(j.objs, (r) => r[i]);
		});
		return c;
	}
	if (j.objs_layout !== VEH_LAYOUT || (j.encoding && j.encoding !== "zlib+base64")) {
		throw new Error("unknown vehicles3d layout " + j.objs_layout);
	}
	const b = n ? await inflate(b64ToBytes(j.objs)) : new Uint8Array(0);
	if (b.length !== 28 * n) {
		throw new Error("bad vehicles3d block size");
	}
	const ab = b.buffer, o = b.byteOffset;
	const u16 = (k) => new Uint16Array(ab, o + 2 * n * k, n), i16 = (k) => new Int16Array(ab, o + 2 * n * k, n);
	const u8 = (k) => new Uint8Array(ab, o + 18 * n + n * k, n), i8 = (k) => new Int8Array(ab, o + 18 * n + n * k, n);
	return { n, cnv: u16(0), desc: i16(1), x: u16(2), y: u16(3), ox: i16(4), oy: i16(5), zoff: i16(6), speed: u16(7), flags: u16(8),
		idx: u8(0), kind: u8(1), z: i8(2), dir: u8(3), steps: u8(4), steps_next: u8(5), nx: i8(6), ny: i8(7), nz: i8(8), owner: i8(9) };
}

/**
 * Position of row i in the map ([x, z, side]). Pedestrians: the game draws those walking on the left side shifted
 * by most of a square across their way; they are put back on the way's centre line (side -1: drawn on the left
 * sidewalk, 1: on the right one).
 */
function rowPos(c, i, dv) {
	let x = c.x[i] + 0.5 + c.ox[i] / 256, z = c.y[i] + 0.5 + c.oy[i] / 256, side = 1;
	if (c.kind[i] === 2) {
		const rx = -dv[1], rz = dv[0];
		const lat = (c.ox[i] / 256) * rx + (c.oy[i] / 256) * rz;
		side = lat < -0.2 ? -1 : 1;
		x -= lat * rx;
		z -= lat * rz;
	}
	return [x, z, side];
}

// --- game time ----------------------------------------------------------------------------------------------------

/**
 * Estimates the game time (ticks, ms of game time) from the replies: the rate from a window of replies (the bridge
 * may answer from a cache up to 100 ms old, so the freshest reply of the last second gives "now"), and the drawn time
 * `ct`, which runs at that rate a delay behind and catches up smoothly (never backwards, except after a jump of
 * seconds). While the game is paused `ct` glides to the last sample and stops.
 */
class GameClock {
	constructor() {
		this.reps = [];
		this.rate = 0; // ticks per ms of wall time
		this.paused = true;
		this.latest = null;
		this.ct = null;
	}

	reset() {
		this.reps = [];
		this.rate = 0;
		this.latest = null;
		this.ct = null;
	}

	add(wall, ticks, paused, mult) {
		if (this.latest !== null && ticks < this.latest - 60000) {
			this.reset(); // another world or a restarted game
		}
		this.latest = this.latest === null ? ticks : Math.max(this.latest, ticks);
		if (paused) {
			this.paused = true;
			this.reps = [];
			this.rate = 0;
			return;
		}
		if (this.paused) {
			this.reps = [];
		}
		this.paused = false;
		const last = this.reps[this.reps.length - 1];
		if (!last || ticks > last.ticks) {
			this.reps.push({ wall, ticks });
		}
		while (this.reps.length > 2 && this.reps[0].wall < wall - 3000) {
			this.reps.shift();
		}
		const a = this.reps[0], b = this.reps[this.reps.length - 1];
		let r = (mult > 0 ? mult : 16) / 16; // the game runs about 1000 * mult / 16 ticks per second
		if (this.reps.length >= 2 && b.wall - a.wall >= 300) {
			r = (b.ticks - a.ticks) / (b.wall - a.wall);
		}
		this.rate = this.rate > 0 ? this.rate + (r - this.rate) * 0.35 : r;
	}

	now(wall) {
		if (this.paused || !this.reps.length) {
			return this.latest;
		}
		let best = -Infinity;
		for (const r of this.reps) {
			if (r.wall >= wall - 1200) {
				best = Math.max(best, r.ticks + (wall - r.wall) * this.rate);
			}
		}
		return best === -Infinity ? this.latest : best;
	}

	step(wall, dt, delayMs) {
		if (this.latest === null) {
			return null;
		}
		if (this.paused) {
			const target = this.latest;
			if (this.ct === null || Math.abs(target - this.ct) > 60000) {
				this.ct = target;
			} else if (this.ct < target) {
				this.ct += (target - this.ct) * Math.min(1, dt / 250);
				if (target - this.ct < 0.5) {
					this.ct = target;
				}
			}
			return this.ct;
		}
		const rate = Math.max(this.rate, 1e-3);
		const target = this.now(wall) - rate * delayMs;
		if (this.ct === null || Math.abs(target - this.ct) > rate * 3000 + 50) {
			this.ct = target;
		} else {
			const k = Math.min(3, Math.max(0, 1 + (target - this.ct) / (rate * 500)));
			this.ct += dt * rate * k;
		}
		this.ct = Math.min(this.ct, this.latest + rate * EXTRAP_MS);
		return this.ct;
	}
}

// --- paths --------------------------------------------------------------------------------------------------------

/** Where a car entered its square: offset of the edge middle from the square centre ([dx, dy] halves), or null. */
function entrySide(s) {
	const d = s.dir;
	if (SIDE[d]) {
		const v = SIDE[d];
		return [-v[0], -v[1]];
	}
	const bits = [1, 2, 4, 8].filter((b) => d & b);
	if (bits.length !== 2 || Math.abs(s.nx) + Math.abs(s.ny) !== 1) {
		return null;
	}
	const exitBit = bits.find((b) => SIDE[b][0] === s.nx && SIDE[b][1] === s.ny);
	if (!exitBit) {
		return null;
	}
	const other = SIDE[bits.find((b) => b !== exitBit)];
	return [-other[0], -other[1]];
}

/** The path from sample a to sample b through the edge middles of their squares: {pts: [x, z, ...], cum, len}. */
function buildPath(a, b) {
	const pts = [a.x, a.z];
	const add = (x, z) => {
		const n = pts.length;
		if (Math.hypot(x - pts[n - 2], z - pts[n - 1]) > 1e-3) {
			pts.push(x, z);
		}
	};
	if ((a.tx !== b.tx || a.ty !== b.ty) && !(a.flags & VF.FLYING && b.flags & VF.FLYING)) {
		if (Math.abs(a.nx) + Math.abs(a.ny) === 1) {
			add(a.tx + 0.5 + a.nx * 0.5, a.ty + 0.5 + a.ny * 0.5);
		}
		const e = entrySide(b);
		if (e) {
			add(b.tx + 0.5 + e[0] * 0.5, b.ty + 0.5 + e[1] * 0.5);
		}
	}
	add(b.x, b.z);
	if (pts.length < 4) {
		pts.push(b.x, b.z);
	}
	let len = 0;
	const cum = [0];
	for (let i = 2; i < pts.length; i += 2) {
		len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
		cum.push(len);
	}
	const direct = Math.hypot(b.x - a.x, b.z - a.z);
	if (pts.length > 4 && len > direct * 2.5 + 1.5) {
		return { pts: [a.x, a.z, b.x, b.z], cum: [0, direct], len: direct };
	}
	return { pts, cum, len };
}

const _seg = [0, 0];

/** Position (out.x, out.z) and heading (out.hx, out.hz) at arc length s of a path; returns false for a point. */
function pathAt(p, s, out) {
	const { pts, cum } = p, n = cum.length;
	if (p.len < 1e-4) {
		out.x = pts[0];
		out.z = pts[1];
		return false;
	}
	s = Math.max(0, Math.min(p.len, s));
	let k = 0;
	while (k < n - 2 && cum[k + 1] < s) {
		k++;
	}
	const sl = cum[k + 1] - cum[k];
	const f = sl > 0 ? (s - cum[k]) / sl : 0;
	const x0 = pts[2 * k], z0 = pts[2 * k + 1], x1 = pts[2 * k + 2], z1 = pts[2 * k + 3];
	out.x = x0 + (x1 - x0) * f;
	out.z = z0 + (z1 - z0) * f;
	const dir = (i) => {
		const l = cum[i + 1] - cum[i] || 1;
		_seg[0] = (pts[2 * i + 2] - pts[2 * i]) / l;
		_seg[1] = (pts[2 * i + 3] - pts[2 * i + 1]) / l;
		return _seg;
	};
	let [hx, hz] = dir(k);
	const ds = s - cum[k], de = cum[k + 1] - s;
	if (k > 0 && ds < CORNER) {
		const w = 0.5 - (0.5 * ds) / CORNER, [px, pz] = dir(k - 1);
		hx = hx * (1 - w) + px * w;
		hz = hz * (1 - w) + pz * w;
	} else if (k < n - 2 && de < CORNER) {
		const w = 0.5 - (0.5 * de) / CORNER, [qx, qz] = dir(k + 1);
		hx = hx * (1 - w) + qx * w;
		hz = hz * (1 - w) + qz * w;
	}
	const l = Math.hypot(hx, hz) || 1;
	out.hx = hx / l;
	out.hz = hz / l;
	return true;
}

// --- the layer ----------------------------------------------------------------------------------------------------

export class VehicleLayer {
	/** view: {scene, rig, chunks, size, quality, canvas, status(), authFailed(), dirty, phase} */
	constructor(view) {
		this.view = view;
		this.group = new THREE.Group();
		this.group.name = "vehicles";
		view.scene.add(this.group);
		this.material = this.makeMaterial();
		this.markerMat = new THREE.MeshBasicMaterial({ color: 0xf03e3e, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
		this.shapes = new Map(); // body key -> {geo, mesh, cap, n, scale}
		this.shapeBudget = null; // time until which frame() may generate new shapes
		this.shapesLeft = false;
		this.shapesMade = 0;
		this.cars = new Map();
		this.convoyCars = new Map(); // cnv -> [car by idx] of the last reply
		this.clock = new GameClock();
		this.classifier = null;
		this.catalogue = null;
		this.catLoading = false;
		this.matcher = null; // pak 3D entries of the vehicles
		this.modelBatches = new Map(); // model key -> ModelBatch (cars drawn with a pak 3D model)
		this.modelCars = 0;
		this.extras = loadPref("v3dExtras", view.quality.name !== "low") !== false;
		this.delay = DELAY_MS;
		this.off = false; // switched off (tests, measurements)
		this.enabled = false;
		this.inflight = false;
		this.nextAt = 0;
		this.lastRect = null;
		this.seq = 0;
		this.idle = 0;
		this.extraSeq = 0;
		this.error = null;
		this.unsupported = false;
		this.lastFrame = 0;
		this.lastCt = null;
		this.visible = 0;
		this.selected = null;
		this.follow = null;
		this.trace = null;
		this.pick = { n: 0, buf: new Float32Array(0) };
		this.holdUntil = 0; // no request before (Retry-After, errors)
		this.stats = { polls: 0, ok: 0, errors: 0, rateLimited: 0, pollTimes: [], fetchMs: [], decodeMs: [], applyMs: [],
			updateMs: [], rows: 0, extrasRows: 0, lastStatus: null, matched: 0, unmatched: 0 };
		this.companyCache = new Map();
		this.tmp = { x: 0, z: 0, hx: 1, hz: 0 };
		this.onPointer = {
			pointerdown: (e) => this.pdown(e),
			pointermove: (e) => this.pmove(e),
			pointerup: (e) => this.pup(e),
			pointercancel: (e) => this.pup(e),
		};
		for (const [k, f] of Object.entries(this.onPointer)) {
			view.canvas.addEventListener(k, f, { passive: true });
		}
		this.press = new Map();
		this.onVis = () => {
			if (!document.hidden) {
				this.nextAt = 0;
			}
		};
		document.addEventListener("visibilitychange", this.onVis);
		this.loadCatalogue();
		this.warmup();
	}

	/**
	 * Compiles the shaders of the vehicles in the background (no long frame when the first cars arrive), not in the
	 * view's constructor and one program per task.
	 */
	async warmup() {
		await yieldTask();
		const view = this.view;
		if (this.disposed) {
			return;
		}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
		geo.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(9), 3, true));
		geo.setAttribute("tint", new THREE.BufferAttribute(new Uint8Array(3), 1, true));
		const meshes = [this.material, this.markerMat].map((mat) => {
			const m = new THREE.InstancedMesh(geo, mat, 1);
			m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
			return m;
		});
		await compileSpread(view.renderer, meshes, view.rig.camera, view.scene, () => !this.disposed);
		for (const m of meshes) {
			m.dispose();
		}
		geo.dispose();
	}

	makeMaterial() {
		const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0.08 });
		m.onBeforeCompile = (sh) => {
			sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nattribute float tint;")
				.replace("#include <color_vertex>", `vColor = vec4(1.0);
#ifdef USE_COLOR
	vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
	vColor.rgb = mix(vColor.rgb, vColor.rgb * instanceColor.rgb, tint);
#endif`);
		};
		m.customProgramCacheKey = () => "vehicle-tint-1";
		return m;
	}

	async loadCatalogue() {
		if (this.catLoading || this.classifier) {
			return;
		}
		this.catLoading = true;
		try {
			const pak = await this.view.pakReady;
			const [cat, rules] = await Promise.all([
				fetch("/api/desc_list?kinds=vehicles,goods,citycars,pedestrians", { credentials: "same-origin" }).then(async (r) => {
					if (r.status === 401) {
						this.view.authFailed();
					}
					if (r.status === 501) {
						this.unsupported = true;
					}
					if (!r.ok) {
						throw new Error("desc_list: HTTP " + r.status);
					}
					return r.json();
				}),
				pak && pak.rules ? pak.rules
					: fetch(new URL("./gen/rules.json", import.meta.url), { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
			]);
			if (this.disposed) {
				return;
			}
			this.catalogue = cat;
			this.classifier = createClassifier(cat, rules);
			this.matcher = pak && pak.state === "loaded" ? createMatcher(pak.pak, cat) : null;
			this.nextAt = 0;
		} catch (e) {
			this.error = String((e && e.message) || e);
			if (!this.unsupported && !this.disposed) {
				setTimeout(() => {
					this.catLoading = false;
					this.loadCatalogue();
				}, 3000);
				return;
			}
		}
		this.catLoading = false;
	}

	// --- what to fetch -------------------------------------------------------------------------------------------

	/** Pixels per square at the view target (iso zoom; free camera by its distance). */
	ppu() {
		const rig = this.view.rig;
		if (rig.mode === "iso") {
			return rig.ppu;
		}
		return rig.focal() / Math.max(1, rig.camera.position.distanceTo(rig.target));
	}

	wanted() {
		const v = this.view;
		return !!(v.size && this.classifier && !this.unsupported && !this.off && !document.hidden && this.ppu() >= MIN_PPU);
	}

	wantExtras() {
		return this.extras && this.ppu() >= EXTRAS_MIN_PPU;
	}

	/** The squares to ask for: the view plus a margin, at most 256 x 256 around the target, snapped to QUANT. */
	rect() {
		const v = this.view, rig = v.rig, size = v.size, range = v.chunks.range;
		const fp = rig.footprint((range.min - 2) * HEIGHT_STEP, (range.max + 12) * HEIGHT_STEP);
		const t = rig.target, half = MAX_SIDE / 2;
		let x0 = Math.max(Math.floor(fp.x0) - MARGIN, Math.floor(t.x) - half), x1 = Math.min(Math.ceil(fp.x1) + MARGIN, Math.floor(t.x) + half - 1);
		let y0 = Math.max(Math.floor(fp.z0) - MARGIN, Math.floor(t.z) - half), y1 = Math.min(Math.ceil(fp.z1) + MARGIN, Math.floor(t.z) + half - 1);
		x0 = Math.floor(x0 / QUANT) * QUANT;
		y0 = Math.floor(y0 / QUANT) * QUANT;
		x1 = Math.min(x0 + MAX_SIDE - 1, Math.ceil((x1 + 1) / QUANT) * QUANT - 1);
		y1 = Math.min(y0 + MAX_SIDE - 1, Math.ceil((y1 + 1) / QUANT) * QUANT - 1);
		x0 = Math.max(0, x0);
		y0 = Math.max(0, y0);
		x1 = Math.min(size.x - 1, x1);
		y1 = Math.min(size.y - 1, y1);
		return x0 <= x1 && y0 <= y1 ? { x1: x0, y1: y0, x2: x1, y2: y1, extras: this.wantExtras() } : null;
	}

	interval() {
		if (this.clock.paused) {
			return PAUSED_INTERVAL;
		}
		return this.idle >= IDLE_REPLIES ? IDLE_INTERVAL : MIN_INTERVAL;
	}

	async poll(now) {
		const r = this.rect();
		if (!r) {
			return;
		}
		this.lastRect = r;
		this.inflight = true;
		this.lastPollAt = now;
		this.nextAt = now + this.interval();
		this.stats.polls++;
		this.stats.pollTimes.push(now);
		while (this.stats.pollTimes.length && this.stats.pollTimes[0] < now - 10000) {
			this.stats.pollTimes.shift();
		}
		const gen = this.gen = (this.gen || 0) + 1;
		const url = `/api/vehicles3d?x1=${r.x1}&y1=${r.y1}&x2=${r.x2}&y2=${r.y2}${r.extras ? "&extras=1" : ""}`;
		try {
			const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
			const t1 = performance.now();
			this.stats.lastStatus = res.status;
			if (this.disposed || gen !== this.gen) {
				return;
			}
			if (!res.ok) {
				this.stats.errors++;
				const ra = Number(res.headers.get("Retry-After")) || 1;
				if (res.status === 429) {
					this.stats.rateLimited++;
					this.holdUntil = performance.now() + ra * 1000;
				} else if (res.status === 401) {
					this.view.authFailed();
					this.holdUntil = performance.now() + 5000;
				} else if (res.status === 501) {
					this.unsupported = true;
				} else {
					this.holdUntil = performance.now() + Math.max(1000, ra * 1000);
				}
				this.nextAt = Math.max(this.nextAt, this.holdUntil);
				this.error = "HTTP " + res.status;
				return;
			}
			const j = await res.json();
			const t2 = performance.now();
			const cols = await decodeVehicles(j);
			const t3 = performance.now();
			if (this.disposed || gen !== this.gen) {
				return;
			}
			this.apply(j, cols, r, t1);
			const t4 = performance.now();
			push(this.stats.fetchMs, t1 - now);
			push(this.stats.decodeMs, t3 - t2);
			push(this.stats.applyMs, t4 - t3);
			this.stats.ok++;
			this.error = null;
		} catch (e) {
			this.stats.errors++;
			this.error = String((e && e.message) || e);
			this.holdUntil = this.nextAt = performance.now() + 2000;
		} finally {
			if (gen === this.gen) {
				this.inflight = false;
			}
		}
	}

	// --- samples -------------------------------------------------------------------------------------------------

	apply(j, c, rect, wall) {
		if (j.desc_gen !== undefined && this.catalogue && j.desc_gen !== this.catalogue.gen) {
			// another pakset (a restarted game): the indices refer to another catalogue
			this.classifier = null;
			this.catalogue = null;
			this.clear();
			this.loadCatalogue();
			return;
		}
		const clock = this.clock, T = j.ticks;
		const ctBefore = clock.ct;
		clock.add(wall, T, !!j.paused, j.mult);
		const seq = ++this.seq;
		let moving = false;
		const touched = [];
		this.convoyCars = new Map();
		const nConv = Math.min(c.n, j.convoy_rows ?? c.n);
		for (let i = 0; i < c.n; i++) {
			if (c.speed[i] > 0) {
				moving = true;
			}
		}
		// convoy cars: identified by convoy id and index
		for (let i = 0; i < nConv; i++) {
			if (c.kind[i] !== 0) {
				continue;
			}
			const key = c.cnv[i] * 256 + c.idx[i];
			let car = this.cars.get(key);
			if (!car || car.desc !== c.desc[i]) {
				car = this.newCar(key, 0, c.desc[i], c.cnv[i], c.idx[i]);
			}
			this.addSample(car, c, i, T, ctBefore, touched);
			car.seen = seq;
			car.owner = c.owner[i];
			let list = this.convoyCars.get(car.cnv);
			if (!list) {
				list = [];
				this.convoyCars.set(car.cnv, list);
			}
			list[car.idx] = car;
			const body = car.body;
			const last = (c.flags[i] & VF.LAST) !== 0;
			car.shape = car.idx === 0 || last ? body.head : body.middle;
			car.flip = !!(body.flipLast && last && car.idx > 0);
		}
		for (const list of this.convoyCars.values()) {
			for (let k = 0; k < list.length; k++) {
				if (list[k]) {
					list[k].next = list[k + 1] || null;
				}
			}
		}
		// city cars and pedestrians: matched to the nearest previous one of the same kind and desc where it could be now
		let extras = 0;
		if (c.n > nConv) {
			extras = this.matchExtras(c, nConv, T, seq, ctBefore, touched);
		}
		this.stats.rows = nConv;
		this.stats.extrasRows = extras;
		for (const car of this.cars.values()) {
			if (car.seen !== seq) {
				car.gone = true;
				if (car.kind !== 0 && !rect.extras) {
					this.cars.delete(car.key);
				}
			}
		}
		// cars that were going on beyond their last sample: the difference to the new path fades out instead of a jump
		const ct = clock.ct;
		if (ct !== null) {
			for (const car of touched) {
				if (car.pre && this.evaluate(car, ct, this.tmp)) {
					// drawn = path position + (ex, ez): keep what was drawn, the difference fades out
					const dx = car.pre[0] - this.tmp.x, dz = car.pre[1] - this.tmp.z;
					if (Math.hypot(dx, dz) < 3) {
						car.ex = dx;
						car.ez = dz;
					}
				}
				car.pre = null;
			}
		}
		this.idle = moving ? 0 : this.idle + 1;
		this.view.dirty = true;
	}

	newCar(key, kind, desc, cnv, idx) {
		const body = this.classifier.of(kind, desc);
		const car = { key, kind, desc, cnv, idx, body, shape: body.head, flip: false, owner: -1, samples: [], seen: 0, gone: false,
			next: null, side: 1, vis: false, valid: false, fx: 0, fz: 0, fy: 0, hx: 1, hz: 0, shx: 1, shz: 0, pitch: 0, roll: 0,
			ex: 0, ez: 0, px: 0, pz: 0, pre: null, segStart: null, jump: false, speed: 0, lane: body.waytype === "road" ? LANE : 0,
			model: this.modelOf(kind, desc) };
		this.cars.set(key, car);
		return car;
	}

	/** The pak 3D model of a vehicle desc: {keys (cache keys of LOD 0, 1, ...), entry, len} or null. */
	modelOf(kind, desc) {
		const cache = this.view.modelCache;
		if (!this.matcher || !cache) {
			return null;
		}
		const k = kind === 1 ? "citycar" : kind === 2 ? "pedestrian" : "vehicle";
		const e = this.matcher.of(k, desc);
		if (!e || !e.model) {
			return null;
		}
		const use = { kind: k, featured: e.featured, player: e.player };
		// vehicles have no square: variants take summer and the temperate climate
		const keys = [e.model, ...e.lod].map((path) => cache.get(expand(e, path, 0, 4), use).key);
		return { keys, entry: e, checked: false };
	}

	/** The loaded model to draw car with now ({key, model}), or null (generated body). */
	modelFor(car, ppu) {
		const m = car.model, cache = this.view.modelCache;
		const m0 = m && cache ? cache.ready(m.keys[0]) : null;
		if (!m0) {
			return null;
		}
		if (!m.checked) {
			m.checked = true;
			const len = car.body.len;
			if (car.kind !== 2 && Math.abs(m0.length / len - 1) > 0.25) {
				warnOnce(m.keys[0].split("#")[0] + ": " + Math.round(m0.length * 100) / 100 + " squares long, the vehicle is "
					+ Math.round(len * 100) / 100);
			}
		}
		const want = Math.min(m.keys.length - 1, lodLevel(m0.size, ppu, car.kind === 1 ? "citycar" : car.kind === 2 ? "pedestrian" : "vehicle"));
		for (let l = want; l >= 0; l--) {
			const mm = cache.ready(m.keys[l]);
			if (mm) {
				return { key: m.keys[l], model: mm };
			}
		}
		return null;
	}

	/** Adds row i as a sample of car; marks breaks where the car must not be moved across. */
	addSample(car, c, i, T, ctBefore, touched) {
		const s = car.samples, p = s[s.length - 1];
		if (p && T <= p.t) {
			return; // the same reply again (bridge cache) or an older one
		}
		const dir = c.dir[i], dv = DIRV.get(dir) || [p ? p.hx : 1, p ? p.hz : 0];
		const [x, z, side] = rowPos(c, i, dv);
		car.side = side;
		const smp = { t: T, x, z, y: (c.z[i] + c.zoff[i] / 16) * HEIGHT_STEP, dir, hx: dv[0], hz: dv[1], flags: c.flags[i],
			speed: c.speed[i], tx: c.x[i], ty: c.y[i], nx: c.nx[i], ny: c.ny[i], brk: false, path: null };
		if (p) {
			const dt = T - p.t;
			const dist = Math.hypot(x - p.x, z - p.z);
			// one step is 1/256 square straight and diagonally
			const expected = (Math.max(p.speed, smp.speed) / 4096) * dt / 256;
			if (reverseOf(p.dir) === dir && p.dir !== dir) {
				smp.brk = true; // the convoy turned round: the game placed its cars anew
			} else if ((smp.flags & VF.LEAVING) && !(p.flags & VF.LEAVING)) {
				smp.brk = true;
			} else if ((p.flags & VF.ENTERING) && !(smp.flags & VF.ENTERING)) {
				smp.brk = true;
			} else if (dist > Math.max(2, expected * 1.6 + 0.75)) {
				smp.brk = true;
			}
		}
		if (ctBefore !== null && p && ctBefore > p.t && car.valid) {
			car.pre = [car.px + car.ex, car.pz + car.ez]; // drawn, without the lane offset
			touched.push(car);
		}
		s.push(smp);
		if (s.length > KEEP) {
			s.shift();
		}
		car.gone = false;
	}

	matchExtras(c, from, T, seq, ctBefore, touched) {
		const grid = new Map(), cell = (x, y) => (x >> 1) * 65536 + (y >> 1);
		for (const car of this.cars.values()) {
			if (car.kind !== 0 && !car.gone) {
				const l = car.samples[car.samples.length - 1];
				const k = cell(l.tx, l.ty);
				let a = grid.get(k);
				if (!a) {
					a = [];
					grid.set(k, a);
				}
				a.push(car);
			}
		}
		let n = 0;
		const rig = this.view.rig, iso = rig.mode === "iso", cam = rig.camera.position, focal = iso ? 0 : rig.focal();
		const ppuIso = iso ? rig.ppu : 0;
		for (let i = from; i < c.n; i++) {
			const kind = c.kind[i];
			if (kind !== 1 && kind !== 2) {
				continue;
			}
			const [x, z] = rowPos(c, i, DIRV.get(c.dir[i]) || [1, 0]);
			// too small to see here: not drawn (pedestrians need a closer view than cars)
			const ppu = iso ? ppuIso : focal / Math.max(1, Math.hypot(x - cam.x, z - cam.z, cam.y));
			if (ppu < (kind === 2 ? WALKERS_MIN_PPU : EXTRAS_MIN_PPU)) {
				continue;
			}
			n++;
			let best = null, bestD = Infinity;
			const cx = c.x[i] >> 1, cy = c.y[i] >> 1;
			for (let gy = cy - 1; gy <= cy + 1; gy++) {
				for (let gx = cx - 1; gx <= cx + 1; gx++) {
					const a = grid.get(gx * 65536 + gy);
					if (!a) {
						continue;
					}
					for (const car of a) {
						if (car.seen === seq || car.kind !== kind || car.desc !== c.desc[i]) {
							continue;
						}
						const l = car.samples[car.samples.length - 1];
						const go = (l.speed / 4096) * Math.max(0, T - l.t) / 256;
						const px = l.x + l.hx * go, pz = l.z + l.hz * go;
						const d = Math.hypot(x - px, z - pz);
						if (d < bestD && d <= 0.45 + go * 0.6) {
							bestD = d;
							best = car;
						}
					}
				}
			}
			if (best) {
				this.stats.matched++;
			} else {
				this.stats.unmatched++;
			}
			const car = best || this.newCar(EXTRA_KEY + (++this.extraSeq % EXTRA_KEY), kind, c.desc[i], 0, 0);
			this.addSample(car, c, i, T, ctBefore, touched);
			car.seen = seq;
			if (kind === 2) {
				car.lane = SIDEWALK * car.side;
			}
		}
		return n;
	}

	/**
	 * Position of the car's front at game time ct (out.x, out.z, out.y, heading out.hx, out.hz, out.vis, out.slope);
	 * false while the car is not there yet (or no more).
	 */
	evaluate(car, ct, out) {
		const s = car.samples, n = s.length;
		if (!n || ct < s[0].t) {
			return false;
		}
		let i = n - 1;
		while (i > 0 && s[i].t > ct) {
			i--;
		}
		const a = s[i];
		out.slope = 0;
		out.seg = a;
		out.speed = a.speed;
		if (i === n - 1) {
			if (car.gone) {
				return false;
			}
			// no newer sample yet: go on along the heading for a moment
			const dt = Math.min(ct - a.t, Math.max(this.clock.rate, 0.05) * EXTRAP_MS);
			const go = (a.flags & VF.LOADING) ? 0 : Math.min(EXTRAP_MAX, (a.speed / 4096) * Math.max(0, dt) / 256);
			out.x = a.x + a.hx * go;
			out.z = a.z + a.hz * go;
			out.y = a.y;
			out.hx = a.hx;
			out.hz = a.hz;
			out.vis = !hidden(a.flags);
			out.path = false;
			return true;
		}
		const b = s[i + 1];
		if (b.brk) {
			out.x = a.x;
			out.z = a.z;
			out.y = a.y;
			out.hx = a.hx;
			out.hz = a.hz;
			out.vis = !hidden(a.flags);
			out.path = false;
			return true;
		}
		const u = (ct - a.t) / (b.t - a.t);
		out.speed = Math.max(a.speed, b.speed);
		const p = b.path || (b.path = buildPath(a, b));
		const at = u * p.len;
		if (pathAt(p, at, out)) {
			out.path = true;
		} else {
			out.hx = b.hx;
			out.hz = b.hz;
			out.path = false;
		}
		out.y = a.y + (b.y - a.y) * u;
		out.slope = p.len > 0.05 ? (b.y - a.y) / p.len : 0;
		const ha = hidden(a.flags), hb = hidden(b.flags);
		if (ha === hb) {
			out.vis = !ha;
		} else {
			const k = p.cum.length;
			const at0 = ha ? (k > 2 ? p.cum[1] : p.len / 2) : (k > 2 ? p.cum[k - 2] : p.len / 2);
			out.vis = ha ? at >= at0 : at < at0;
		}
		return true;
	}

	// --- frames ------------------------------------------------------------------------------------------------

	update(now) {
		const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
		this.lastFrame = now;
		const want = this.wanted();
		if (want !== this.enabled) {
			this.enabled = want;
			if (!want) {
				this.clear();
				return true;
			}
			this.nextAt = 0;
		}
		if (!want) {
			return false;
		}
		const spaced = (!this.lastPollAt || now - this.lastPollAt >= MIN_INTERVAL) && now >= this.holdUntil;
		if (!this.inflight && spaced && now >= this.nextAt) {
			this.poll(now);
		} else if (!this.inflight && spaced && this.lastRect) {
			// the view moved to other squares: ask again without waiting for the slow interval
			const r = this.rect();
			if (r && (Math.abs(r.x1 - this.lastRect.x1) >= 2 * QUANT || Math.abs(r.y1 - this.lastRect.y1) >= 2 * QUANT
				|| Math.abs(r.x2 - this.lastRect.x2) >= 2 * QUANT || Math.abs(r.y2 - this.lastRect.y2) >= 2 * QUANT || r.extras !== this.lastRect.extras)) {
				this.poll(now);
			}
		}
		const t0 = performance.now();
		const ct = this.clock.step(now, dt, this.delay);
		// drawn time beyond the newest sample: the replies come later than the delay allows, draw further back
		if (ct !== null && !this.clock.paused && this.clock.latest !== null && ct > this.clock.latest && this.visible) {
			this.delay = Math.min(DELAY_MAX, this.delay + dt * 0.6);
		} else {
			this.delay = Math.max(DELAY_MS, this.delay - dt * 0.01);
		}
		let changed = false;
		if (ct !== null) {
			changed = this.frame(ct, dt, now);
		}
		push(this.stats.updateMs, performance.now() - t0, MAX_FRAME_SAMPLES);
		return changed;
	}

	companyColor(owner) {
		let c = this.companyCache.get(owner);
		if (!c) {
			c = cssLinear(ownerColor(owner));
			this.companyCache.set(owner, c);
		}
		return c;
	}

	/** The shape `key`, generated when first needed; null when this frame's time for new shapes is used up (lazy). */
	shapeOf(key, lazy = false) {
		let s = this.shapes.get(key);
		if (!s) {
			// at least one new shape per frame
			if (lazy && this.shapeBudget !== null && this.shapesMade > 0 && performance.now() > this.shapeBudget) {
				this.shapesLeft = true;
				return null;
			}
			this.shapesMade++;
			const d = buildShape(key) || buildShape("rail_box");
			const g = new THREE.BufferGeometry();
			g.setAttribute("position", new THREE.BufferAttribute(d.position, 3));
			g.setAttribute("color", new THREE.BufferAttribute(d.color, 3, true));
			g.setAttribute("tint", new THREE.BufferAttribute(d.tint, 1, true));
			g.computeBoundingSphere();
			s = { key, geo: g, mesh: null, cap: 0, n: 0, scale: d.scale };
			this.shapes.set(key, s);
		}
		return s;
	}

	/** Room for n instances in the mesh of shape s (a larger mesh replaces a full one). */
	room(s, n, material = this.material) {
		if (s.mesh && s.cap >= n) {
			return;
		}
		const cap = Math.max(64, 1 << Math.ceil(Math.log2(n + 1)));
		const m = new THREE.InstancedMesh(s.geo, material, cap);
		m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
		m.instanceColor.setUsage(THREE.DynamicDrawUsage);
		if (s.mesh) {
			// keep what this frame wrote already
			m.instanceMatrix.array.set(s.mesh.instanceMatrix.array);
			m.instanceColor.array.set(s.mesh.instanceColor.array);
			s.mesh.removeFromParent();
			s.mesh.dispose();
		}
		if (material === this.markerMat) {
			m.renderOrder = 22;
		} else {
			m.castShadow = true;
			m.receiveShadow = true;
		}
		m.frustumCulled = false;
		m.count = 0;
		m.name = "vehicles:" + s.key;
		m.userData.shape = s.key;
		this.group.add(m);
		s.mesh = m;
		s.cap = cap;
	}

	/** Positions all cars at game time ct and fills the instance buffers. True when something visible changed. */
	frame(ct, dt, now) {
		const out = this.tmp, cars = this.cars;
		const fade = Math.exp(-dt / 140);
		let visible = 0;
		// pass 1: the fronts
		for (const car of cars.values()) {
			if (!this.evaluate(car, ct, out)) {
				const last = car.samples[car.samples.length - 1];
				if (car.gone && (!last || ct > last.t)) {
					cars.delete(car.key);
				}
				car.valid = false;
				car.vis = false;
				continue;
			}
			car.jump = out.seg !== car.segStart && car.segStart !== null && out.seg.brk;
			const appeared = !car.valid;
			car.segStart = out.seg;
			car.ex *= fade;
			car.ez *= fade;
			// headings turn smoothly at a limited rate (a U-turn takes a moment, so the lane offset moves across instead of
			// jumping); after a jump and for new cars at once
			let hx = out.hx, hz = out.hz;
			if (!appeared && !car.jump) {
				const diff = Math.atan2(car.shx * hz - car.shz * hx, car.shx * hx + car.shz * hz);
				const step = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, diff * Math.min(1, dt / 50)));
				const c = Math.cos(step), sn = Math.sin(step);
				hx = car.shx * c - car.shz * sn;
				hz = car.shx * sn + car.shz * c;
			}
			if (car.body.air && (out.seg.flags & VF.FLYING) && !appeared) {
				const turn = Math.atan2(car.shx * hz - car.shz * hx, car.shx * hx + car.shz * hz) / Math.max(1, dt) * 1000;
				car.roll += (Math.max(-0.5, Math.min(0.5, -turn * 0.35)) - car.roll) * Math.min(1, dt / 300);
			} else {
				car.roll *= fade;
			}
			car.shx = hx;
			car.shz = hz;
			const lane = car.lane;
			car.px = out.x;
			car.pz = out.z;
			car.fx = out.x + car.ex - hz * lane;
			car.fz = out.z + car.ez + hx * lane;
			car.fy = out.y;
			car.hx = hx;
			car.hz = hz;
			car.pitch = Math.atan(out.slope || 0);
			car.speed = out.speed;
			car.valid = true;
			car.vis = out.vis;
			if (car.vis) {
				visible++;
			}
		}
		// pass 2: bodies (convoy cars as the chord to the next car's front), instances
		for (const s of this.shapes.values()) {
			s.n = 0;
		}
		this.shapeBudget = performance.now() + SHAPE_MS;
		this.shapesMade = 0;
		this.shapesLeft = false;
		for (const mb of this.modelBatches.values()) {
			mb.k = 0;
		}
		const ppu = this.modelBatches.size || this.matcher ? this.ppu() : 0;
		let modelCars = 0;
		const sel = this.selected;
		let marks = 0;
		if (this.pick.buf.length < visible * 6) {
			this.pick.buf = new Float32Array(Math.max(256, visible * 12));
		}
		const pk = this.pick.buf;
		let np = 0;
		for (const car of cars.values()) {
			if (!car.vis) {
				continue;
			}
			const b = car.body, len = b.len;
			let hx = car.hx, hz = car.hz, pitch = car.pitch, cx, cz, cy;
			const nx = car.next;
			if (nx && nx.valid && car.kind === 0) {
				const dx = car.fx - nx.fx, dz = car.fz - nx.fz, dy = car.fy - nx.fy, cl = Math.hypot(dx, dz);
				if (cl > len * 0.45 && cl < len * 1.8) {
					hx = dx / cl;
					hz = dz / cl;
					pitch = Math.atan2(dy, cl);
				}
			}
			const mdl = car.model ? this.modelFor(car, ppu) : null;
			if (mdl) {
				// a pak 3D model: authored at its size, origin in the middle of the car on the ground, +X forward
				const walker = car.kind === 2;
				cx = car.fx - (walker ? 0 : hx * len * 0.5 * Math.cos(pitch));
				cz = car.fz - (walker ? 0 : hz * len * 0.5 * Math.cos(pitch));
				cy = car.fy - (walker ? 0 : len * 0.5 * Math.sin(pitch));
				if (car.flip) {
					hx = -hx;
					hz = -hz;
					pitch = -pitch;
				}
				let mb = this.modelBatches.get(mdl.key);
				if (!mb || mb.model !== mdl.model) {
					if (mb) {
						mb.dispose();
					}
					mb = new ModelBatch(mdl.model, this.group, "vehicles:pak:" + mdl.key.split("#")[0]);
					mb.k = 0;
					this.modelBatches.set(mdl.key, mb);
				}
				mb.reserve(mb.k + 1);
				writeMatrix(mb.matrix.array, mb.k * 16, cx, cy, cz, hx, hz, pitch, car.roll, 1, 1, 1);
				mb.setOwner(mb.k, car.owner, b.color ? (b.lin || (b.lin = b.color.map(toLinear))) : null);
				mb.k++;
				modelCars++;
				if (car.kind === 0) {
					pk[np++] = cx;
					pk[np++] = cy + 0.1 * mdl.model.top;
					pk[np++] = cz;
					pk[np++] = len;
					pk[np++] = car.cnv;
					pk[np++] = car.idx;
					if (sel !== null && car.cnv === sel) {
						const ms = this.shapeOf("marker");
						this.room(ms, marks + 1, this.markerMat);
						writeMatrix(ms.mesh.instanceMatrix.array, marks * 16, cx, cy + 0.004, cz, hx, hz, 0, 0, len + 0.1, 1,
							mdl.model.width + 0.08);
						marks++;
					}
				}
				continue;
			}
			const shape = this.shapeOf(car.shape, true);
			if (!shape) {
				continue; // drawn from the next frames on
			}
			const one = shape.scale === "1";
			cx = car.fx - (one ? 0 : hx * len * 0.5 * Math.cos(pitch));
			cz = car.fz - (one ? 0 : hz * len * 0.5 * Math.cos(pitch));
			cy = car.fy - (one ? 0 : len * 0.5 * Math.sin(pitch)) + b.y;
			if (car.flip) {
				hx = -hx;
				hz = -hz;
				pitch = -pitch;
			}
			const sx = one ? 1 : len, sy = shape.scale === "xyz" ? len : one ? 1 : b.h, sz = shape.scale === "xyz" ? len : one ? 1 : b.w;
			this.room(shape, shape.n + 1);
			writeMatrix(shape.mesh.instanceMatrix.array, shape.n * 16, cx, cy, cz, hx, hz, pitch, car.roll, sx, sy, sz);
			const col = b.color ? (b.lin || (b.lin = b.color.map(toLinear))) : this.companyColor(car.owner);
			const ca = shape.mesh.instanceColor.array, o = shape.n * 3;
			ca[o] = col[0];
			ca[o + 1] = col[1];
			ca[o + 2] = col[2];
			shape.n++;
			if (car.kind === 0) {
				pk[np++] = cx;
				pk[np++] = cy + 0.1 * sy;
				pk[np++] = cz;
				pk[np++] = len;
				pk[np++] = car.cnv;
				pk[np++] = car.idx;
				if (sel !== null && car.cnv === sel) {
					const ms = this.shapeOf("marker");
					this.room(ms, marks + 1, this.markerMat);
					writeMatrix(ms.mesh.instanceMatrix.array, marks * 16, cx, cy + 0.004, cz, hx, hz, 0, 0, len + 0.1,
						1, (shape.scale === "xyz" ? len * 0.6 : (b.waytype === "road" ? 0.15 : 0.27) * b.w) + 0.08);
					marks++;
				}
			}
		}
		this.pick.n = np / 6;
		for (const mb of this.modelBatches.values()) {
			mb.commit(mb.k);
		}
		this.modelCars = modelCars;
		for (const s of this.shapes.values()) {
			if (s.key === "marker") {
				s.n = marks;
			}
			if (s.mesh) {
				s.mesh.count = s.n;
				s.mesh.visible = s.n > 0;
				if (s.n) {
					s.mesh.instanceMatrix.clearUpdateRanges();
					s.mesh.instanceMatrix.addUpdateRange(0, s.n * 16);
					s.mesh.instanceMatrix.needsUpdate = true;
					if (s.mesh.instanceColor) {
						s.mesh.instanceColor.clearUpdateRanges();
						s.mesh.instanceColor.addUpdateRange(0, s.n * 3);
						s.mesh.instanceColor.needsUpdate = true;
					}
				}
			}
		}
		this.updateFollow(now, dt);
		if (this.trace) {
			this.record(ct, now);
		}
		const changed = (ct !== this.lastCt && (visible > 0 || this.visible > 0)) || visible !== this.visible || marks !== this.marks
			|| this.shapesLeft;
		this.shapeBudget = null;
		this.lastCt = ct;
		this.visible = visible;
		this.marks = marks;
		return changed;
	}

	clear() {
		this.cars.clear();
		this.convoyCars = new Map();
		for (const s of this.shapes.values()) {
			s.n = 0;
			if (s.mesh) {
				s.mesh.count = 0;
				s.mesh.visible = false;
			}
		}
		for (const mb of this.modelBatches.values()) {
			mb.k = 0;
			mb.commit(0);
		}
		this.pick.n = 0;
		this.visible = 0;
		this.clock.reset();
		this.gen = (this.gen || 0) + 1;
		this.inflight = false;
	}

	// --- picking -----------------------------------------------------------------------------------------------

	/** The convoy car under a client point: {cnv, idx, x, y} or null (cars behind a building or hill do not count). */
	pickAt(clientX, clientY, pointerType = "mouse", ground = null) {
		const n = this.pick.n;
		if (!n || !this.enabled) {
			return null;
		}
		const view = this.view, cam = view.rig.camera, r = view.canvas.getBoundingClientRect();
		cam.updateMatrixWorld(true);
		const v = new THREE.Vector3(), w = new THREE.Vector3();
		const px = (p) => [r.left + ((p.x + 1) / 2) * r.width, r.top + ((1 - p.y) / 2) * r.height];
		const slack = PICK_SLACK[pointerType] || 8;
		const camDir = new THREE.Vector3();
		cam.getWorldDirection(camDir);
		const groundDepth = ground && ground.point ? new THREE.Vector3(...ground.point).sub(cam.position).dot(camDir) : Infinity;
		let best = null, bestD = Infinity;
		const pk = this.pick.buf;
		for (let i = 0; i < n; i++) {
			const o = i * 6;
			v.set(pk[o], pk[o + 1], pk[o + 2]);
			const depth = w.copy(v).sub(cam.position).dot(camDir);
			v.project(cam);
			if (Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05 || v.z > 1) {
				continue;
			}
			const [sx, sy] = px(v);
			// the car's half length on the screen
			const ppu = view.rig.mode === "iso" ? view.rig.ppu : view.rig.focal() / Math.max(0.5, depth);
			const rad = Math.max(SNAP_PX, pk[o + 3] * 0.5 * ppu * 0.8);
			const d = Math.hypot(sx - clientX, sy - clientY);
			if (d <= rad + slack && d < bestD && depth < groundDepth + 0.6) {
				bestD = d;
				best = { cnv: pk[o + 4], idx: pk[o + 5], x: Math.floor(pk[o]), y: Math.floor(pk[o + 2]) };
			}
		}
		return best;
	}

	/** Client positions of the drawn cars of convoys (tests): [{cnv, idx, x, y, inView}]. */
	carsOnScreen(limit = 400) {
		const view = this.view, cam = view.rig.camera, r = view.canvas.getBoundingClientRect(), v = new THREE.Vector3(), out = [];
		cam.updateMatrixWorld(true);
		const pk = this.pick.buf;
		for (let i = 0; i < this.pick.n && out.length < limit; i++) {
			const o = i * 6;
			v.set(pk[o], pk[o + 1], pk[o + 2]).project(cam);
			out.push({ cnv: pk[o + 4], idx: pk[o + 5], x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height,
				inView: Math.abs(v.x) <= 0.9 && Math.abs(v.y) <= 0.9, wx: pk[o], wy: pk[o + 1], wz: pk[o + 2] });
		}
		return out;
	}

	setSelected(cnv) {
		this.selected = Number.isInteger(cnv) ? cnv : null;
		this.view.dirty = true;
	}

	// --- follow ------------------------------------------------------------------------------------------------

	/** The point of a convoy as drawn now: the middle between its front and its last car ({x, y, z}) or null. */
	convoyPoint(cnv) {
		const list = this.convoyCars.get(cnv);
		if (!list || !list.length) {
			return null;
		}
		let a = null, b = null;
		for (const car of list) {
			if (car && car.valid) {
				a = a || car;
				b = car;
			}
		}
		if (!a) {
			return null;
		}
		return { x: (a.fx + b.fx) / 2, y: (a.fy + b.fy) / 2, z: (a.fz + b.fz) / 2 };
	}

	startFollow(cnv) {
		if (!Number.isInteger(cnv)) {
			return;
		}
		const rig = this.view.rig, t = rig.target;
		this.follow = { cnv, t0: performance.now(), from: { x: t.x, y: t.y, z: t.z }, found: false, lostAt: performance.now(), jumped: false };
		const p = this.convoyPoint(cnv);
		if (!p) {
			// not among the fetched cars: go where the positions feed has it, the cars come with the next request
			const live = convoyLive(cnv);
			if (live && Math.hypot(live.x + 0.5 - t.x, live.y + 0.5 - t.z) > 24) {
				rig.lookAt(live.x + 0.5, live.y + 0.5);
				this.follow.from = { x: rig.target.x, y: rig.target.y, z: rig.target.z };
				this.follow.jumped = true;
			}
			this.nextAt = 0;
		}
		this.view.status();
	}

	stopFollow() {
		if (this.follow) {
			this.follow = null;
			this.view.status();
		}
	}

	followInfo() {
		const f = this.follow;
		return f ? { cnv: f.cnv, found: f.found } : null;
	}

	updateFollow(now) {
		const f = this.follow;
		if (!f) {
			return;
		}
		const p = this.convoyPoint(f.cnv);
		if (!p) {
			if (f.found && now - f.lostAt > 1500) {
				f.found = false;
				this.view.status();
			}
			return;
		}
		if (!f.found) {
			f.found = true;
			f.t0 = now;
			const t = this.view.rig.target;
			f.from = { x: t.x, y: t.y, z: t.z };
			this.view.status();
		}
		f.lostAt = now;
		const rig = this.view.rig;
		let x = p.x, y = p.y, z = p.z;
		const k = Math.min(1, (now - f.t0) / FOLLOW_MS);
		if (k < 1) {
			const e = 1 - Math.pow(1 - k, 3);
			x = f.from.x + (x - f.from.x) * e;
			y = f.from.y + (y - f.from.y) * e;
			z = f.from.z + (z - f.from.z) * e;
		}
		const t = rig.target;
		if (Math.abs(t.x - x) + Math.abs(t.y - y) + Math.abs(t.z - z) > 1e-5) {
			rig.pending = null;
			rig.moveTarget(x, y, z);
			rig.onChange();
		}
	}

	// a drag that pans the view ends following (rotating the free camera and zooming do not)
	pdown(e) {
		this.press.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, button: e.button });
	}

	pmove(e) {
		const p = this.press.get(e.pointerId);
		if (!p || !this.follow) {
			return;
		}
		if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) {
			const free = this.view.rig.mode === "free";
			const pan = p.type === "mouse" ? (free ? p.button === 0 : p.button === 0 || p.button === 2) : this.press.size === 1;
			if (pan) {
				this.stopFollow();
			}
		}
	}

	pup(e) {
		this.press.delete(e.pointerId);
	}

	// --- settings, tests ---------------------------------------------------------------------------------------

	setExtras(on) {
		this.extras = !!on;
		savePref("v3dExtras", this.extras);
		this.nextAt = 0;
		this.view.status();
	}

	startTrace(opts = {}) {
		this.trace = { frames: [], max: opts.frames || 900, cnv: Array.isArray(opts.cnv) ? new Set(opts.cnv) : null };
	}

	stopTrace() {
		const t = this.trace;
		this.trace = null;
		return t ? t.frames : [];
	}

	record(ct, now) {
		const t = this.trace;
		if (t.frames.length >= t.max) {
			return;
		}
		const cars = [];
		for (const car of this.cars.values()) {
			if (car.kind === 0 && (!t.cnv || t.cnv.has(car.cnv))) {
				cars.push([car.cnv, car.idx, car.valid ? Math.round(car.fx * 1000) / 1000 : null, car.valid ? Math.round(car.fz * 1000) / 1000 : null,
					car.vis ? 1 : 0, car.jump ? 1 : 0, car.segStart ? car.segStart.dir : 0, car.segStart ? car.segStart.flags : 0,
					car.speed || 0, car.shape]);
			}
		}
		const tg = this.view.rig.target;
		t.frames.push({ t: Math.round(now * 10) / 10, ct: Math.round(ct), cars, target: [tg.x, tg.y, tg.z],
			rate: Math.round(this.clock.rate * 1000) / 1000 });
	}

	info() {
		const s = this.stats, now = performance.now();
		const recent = s.pollTimes.filter((t) => t >= now - 5000).length;
		let instances = 0, shapes = 0, triangles = 0;
		for (const sh of this.shapes.values()) {
			if (sh.n) {
				instances += sh.n;
				shapes++;
				triangles += sh.n * sh.geo.attributes.position.count / 3;
			}
		}
		const models = {};
		for (const [key, mb] of this.modelBatches) {
			if (mb.n) {
				const path = key.split("#")[0];
				models[path] = (models[path] || 0) + mb.n;
				instances += mb.n;
				triangles += mb.triangles();
			}
		}
		let extras = 0;
		for (const car of this.cars.values()) {
			if (car.kind !== 0) {
				extras++;
			}
		}
		return {
			enabled: this.enabled, extras: this.extras, wantExtras: this.enabled && this.wantExtras(), cars: this.cars.size, extraCars: extras,
			visible: this.visible, instances, shapes, triangles, polls: s.polls, ok: s.ok, errors: s.errors, rateLimited: s.rateLimited,
			pollRate: recent / 5, interval: this.interval(), paused: this.clock.paused, ticksPerSec: Math.round(this.clock.rate * 1000),
			lagMs: this.clock.ct !== null && this.clock.rate > 0 ? Math.round((this.clock.now(now) - this.clock.ct) / this.clock.rate) : 0,
			delayMs: Math.round(this.delay),
			rect: this.lastRect, rows: s.rows, extrasRows: s.extrasRows, lastStatus: s.lastStatus, error: this.error,
			extrasMatched: s.matched, extrasNew: s.unmatched,
			fetch_ms: [pct(s.fetchMs, 0.5), pct(s.fetchMs, 0.95)], decode_ms: [pct(s.decodeMs, 0.5), pct(s.decodeMs, 0.95)],
			apply_ms: [pct(s.applyMs, 0.5), pct(s.applyMs, 0.95)], update_ms: [pct(s.updateMs, 0.5), pct(s.updateMs, 0.95)],
			follow: this.followInfo(), selected: this.selected, ppu: Math.round(this.ppu() * 100) / 100, unsupported: this.unsupported,
			modelCars: this.modelCars, models,
		};
	}

	/** Matrices and colours of the cars drawn with the pak 3D model `path` (tests). */
	modelCopies(path, limit = 32) {
		const out = [];
		for (const [key, mb] of this.modelBatches) {
			if (key.split("#")[0] !== path) {
				continue;
			}
			const k = mb.colors.findIndex((c) => c);
			for (let i = 0; i < mb.n && out.length < limit; i++) {
				out.push({ matrix: Array.from(mb.matrix.array.subarray(i * 16, i * 16 + 16)),
					color: k >= 0 ? Array.from(mb.colors[k].subarray(i * 3, i * 3 + 3)) : null });
			}
		}
		return out;
	}

	onMapChanges() {}

	onSnapshot() {
		this.clear();
		this.nextAt = 0;
	}

	dispose() {
		this.disposed = true;
		this.gen = (this.gen || 0) + 1;
		for (const [k, f] of Object.entries(this.onPointer)) {
			this.view.canvas.removeEventListener(k, f);
		}
		document.removeEventListener("visibilitychange", this.onVis);
		for (const s of this.shapes.values()) {
			if (s.mesh) {
				s.mesh.removeFromParent();
				s.mesh.dispose();
			}
			s.geo.dispose();
		}
		this.shapes.clear();
		for (const mb of this.modelBatches.values()) {
			mb.dispose();
		}
		this.modelBatches.clear();
		this.material.dispose();
		this.markerMat.dispose();
		this.group.removeFromParent();
		this.cars.clear();
	}
}

function push(arr, v, max = 200) {
	arr.push(v);
	if (arr.length > max) {
		arr.shift();
	}
}

/** Column-major matrix: forward (hx, hz) pitched up by `pitch`, rolled by `roll`, scaled (sx, sy, sz), at (x, y, z). */
function writeMatrix(e, o, x, y, z, hx, hz, pitch, roll, sx, sy, sz) {
	const cp = Math.cos(pitch), sp = Math.sin(pitch);
	const ax = hx * cp, ay = sp, az = hz * cp; // local X
	let bx = -hx * sp, by = cp, bz = -hz * sp; // local Y
	let cx = -hz, cy = 0, cz = hx; // local Z
	if (roll) {
		const cr = Math.cos(roll), sr = Math.sin(roll);
		const nbx = bx * cr + cx * sr, nby = by * cr + cy * sr, nbz = bz * cr + cz * sr;
		cx = cx * cr - bx * sr;
		cy = cy * cr - by * sr;
		cz = cz * cr - bz * sr;
		bx = nbx;
		by = nby;
		bz = nbz;
	}
	e[o] = ax * sx; e[o + 1] = ay * sx; e[o + 2] = az * sx; e[o + 3] = 0;
	e[o + 4] = bx * sy; e[o + 5] = by * sy; e[o + 6] = bz * sy; e[o + 7] = 0;
	e[o + 8] = cx * sz; e[o + 9] = cy * sz; e[o + 10] = cz * sz; e[o + 11] = 0;
	e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
}

