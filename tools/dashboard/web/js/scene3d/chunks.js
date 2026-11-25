// Simutrans-Horizon dashboard, 3D view: streaming of the 64 x 64 chunks. Picks the chunks the camera sees (plus a
// margin, nearest to the view target first, at most the budget of the quality profile, none while a chunk would be
// smaller than NEAR_MIN_PX on the screen), fetches them through the worker (which also builds their geometry) a few
// at a time, adds at most one chunk per frame, unloads the least recently seen ones and fetches chunks again whose
// cell `map_changes` reports (an unchanged chunk answers 304 and keeps its meshes). Only the wanted chunks are shown;
// the far terrain (farlod.js) covers the rest and follows `version`. The copies of pak 3D models in a chunk go to the
// model layer (pakmodels.js), which follows `version` too. Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { PartFactory } from "./parts.js";
import { warnOnce } from "./pakmodels.js";
import { ownerColor } from "../colors.js";
import { S } from "/js/store.js";
import { CHUNK, HEIGHT_STEP, BUILDING_HEADROOM, NEAR_MIN_PX } from "./config.js";

const WANT_MS = 120; // at most this often the visible chunks are worked out again
const LOW_DETAIL_PPU = 9; // instanced shapes with a <key>_lo variant (trees) use it below this many pixels per square
const MARGIN = 12; // squares around the view that are loaded in advance
const MAX_SAMPLES = 200;

const keyOf = (cx, cy) => cx + "," + cy;

/** Company colours of the players 0..15 as sRGB triples (colors.js: the game's palette when known). */
function companyColors() {
	const out = [];
	for (let i = 0; i < 16; i++) {
		const c = ownerColor(i);
		const m = /^#([0-9a-f]{6})$/i.exec(c || "");
		out.push(m ? [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16) / 255) : [0.55, 0.55, 0.58]);
	}
	return out;
}

function push(arr, v) {
	arr.push(v);
	if (arr.length > MAX_SAMPLES) {
		arr.shift();
	}
}

export class ChunkLayer {
	/** view: {scene, rig, quality, status(), authFailed(), unsupported(reason), fail(error)} */
	constructor(view) {
		this.view = view;
		this.quality = view.quality;
		this.group = new THREE.Group();
		this.group.name = "chunks";
		view.scene.add(this.group);
		this.parts = new PartFactory();
		this.chunks = new Map();
		this.worker = null;
		this.gen = 0;
		this.ready = false;
		this.size = null;
		this.inflight = 0;
		this.pausedUntil = 0;
		this.pending = [];
		this.wanted = [];
		this.wantedSet = new Set();
		this.version = 0; // + 1 whenever the set of shown chunks changes
		this.wantDirty = true;
		this.wantAt = 0;
		this.range = { min: -8, max: 40, water: 0 };
		this.error = null;
		this.stats = { requests: 0, ok: 0, notModified: 0, sameEtag: 0, retries: 0, failed: 0, refetches: 0,
			evicted: 0, fetchMs: [], decodeMs: [], buildMs: [], addMs: [], bytes: 0 };
	}

	// --- worker ----------------------------------------------------------------------------------------------

	startWorker() {
		const w = new Worker("/js/scene3d/worker.js", { type: "module", name: "scene3d" });
		const gen = this.gen;
		this.rpcSeq = 0;
		this.rpcWait = new Map();
		w.onmessage = (e) => {
			const p = this.rpcWait.get(e.data.id);
			if (p) {
				this.rpcWait.delete(e.data.id);
				p(e.data);
			}
		};
		w.onerror = (e) => {
			if (gen === this.gen) {
				this.view.fail(new Error("worker: " + (e.message || "failed to load")));
			}
		};
		this.worker = w;
	}

	rpc(msg) {
		const w = this.worker;
		return new Promise((resolve) => {
			const id = ++this.rpcSeq;
			this.rpcWait.set(id, resolve);
			w.postMessage(Object.assign({ id }, msg));
		});
	}

	/** Starts (or restarts) streaming for a world of sizeX x sizeY squares. */
	async start(sizeX, sizeY) {
		this.reset();
		this.size = { x: sizeX, y: sizeY };
		const gen = this.gen;
		const pak = await this.view.pakReady; // the pak 3D (or none) and the generator rules
		if (gen !== this.gen) {
			return;
		}
		this.startWorker();
		const r = await this.rpc({ op: "init", treeDensity: this.quality.treeDensity, players: companyColors(),
			buildingInstanceMin: this.quality.buildingInstanceMin || 0, pak: pak && pak.state === "loaded" ? pak.pak : null,
			rules: pak ? pak.rules : null });
		if (gen !== this.gen) {
			return;
		}
		if (!r.ok) {
			if ([0, 429, 502, 503].includes(r.status)) {
				// busy, no world yet or the game is restarting: try again
				this.retryTimer = setTimeout(() => this.start(sizeX, sizeY), Math.max(1, r.retry || 2) * 1000);
				return;
			}
			this.workerFailed(r, null);
			return;
		}
		this.parts.setShapes(r.shapes);
		if (r.min !== null && r.min !== undefined) {
			this.range = { min: r.min, max: r.max, water: r.water };
		}
		await this.view.warmup(this.parts);
		if (gen !== this.gen) {
			return;
		}
		this.ready = true;
		this.wantDirty = true;
	}

	reset() {
		this.gen++;
		clearTimeout(this.retryTimer);
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		for (const e of this.chunks.values()) {
			this.drop(e);
		}
		this.chunks.clear();
		if (this.view.models) {
			this.view.models.clear();
		}
		this.pending = [];
		this.wanted = [];
		this.wantedSet = new Set();
		this.version++;
		this.inflight = 0;
		this.ready = false;
		this.error = null;
	}

	// --- events ----------------------------------------------------------------------------------------------

	onView() {
		this.wantDirty = true;
		this.detail();
	}

	/**
	 * Low detail trees where a square is smaller than LOW_DETAIL_PPU pixels: the whole iso view by its zoom, in the
	 * free camera chunk by chunk by its distance. Swaps the geometry of the instanced parts (same instances).
	 */
	detail(only) {
		const rig = this.view.rig, cam = rig.camera;
		const pos = cam.position, h = rig.h || 800;
		for (const e of only ? [only] : this.chunks.values()) {
			if (!e.obj) {
				continue;
			}
			let ppu = rig.ppu;
			if (rig.mode !== "iso") {
				const d = Math.hypot(pos.x - (e.x0 + e.w / 2), pos.y - rig.target.y, pos.z - (e.y0 + e.h / 2));
				ppu = h / (Math.max(1, d) * 1.6);
			}
			const low = ppu < LOW_DETAIL_PPU;
			if (low === e.low) {
				continue;
			}
			e.low = low;
			for (const o of e.obj.children) {
				const s = o.userData.shape;
				const geo = s && this.parts.shapes.get(low ? s + "_lo" : s);
				if (geo && (low || this.parts.shapes.has(s + "_lo"))) {
					o.geometry = geo;
				}
			}
		}
	}

	/** SSE map_changes: {full, cells: [[cx, cy], ...]} of 64 x 64 cells (= chunks of size 64). */
	onMapChanges(d) {
		if (d.full) {
			this.markAllDirty();
			return;
		}
		for (const c of d.cells || []) {
			const e = Array.isArray(c) ? this.chunks.get(keyOf(c[0], c[1])) : null;
			if (e) {
				this.markDirty(e);
			}
		}
		this.wantDirty = true;
	}

	/** A new snapshot of the same world (reconnect): changes may have been missed, revalidate everything. */
	onSnapshot() {
		this.markAllDirty();
	}

	markAllDirty() {
		for (const e of this.chunks.values()) {
			this.markDirty(e);
		}
		this.wantDirty = true;
	}

	markDirty(e) {
		if (e.state === "loading") {
			e.dirtyAgain = true;
		} else if (e.state === "ready") {
			e.dirty = true;
		} else if (e.state === "building") {
			e.dirtyAfterAdd = true;
		} else if (e.state === "empty" || e.state === "failed") {
			e.state = "idle";
		}
	}

	// --- per frame ---------------------------------------------------------------------------------------------

	/** True when meshes were added or removed (the frame must be drawn). */
	update(now) {
		if (!this.ready) {
			return false;
		}
		let changed = false;
		if (this.wantDirty && now - this.wantAt >= WANT_MS) {
			this.wantDirty = false;
			this.wantAt = now;
			changed = this.computeWanted(now) || changed;
		}
		this.pump(now);
		// one chunk per frame: its buffers go to the GPU when the frame is drawn
		if (this.pending.length) {
			this.add(this.pending.shift());
			changed = true;
			this.view.status();
		}
		if (this.overVersion !== this.version) {
			this.overVersion = this.version;
			changed = this.updateOverhang() || changed;
		}
		const sky = this.view.sky;
		if (sky && sky.probeWanted && !this.probing && this.worker && this.chunks.size) {
			this.probeSnow(sky);
		}
		return changed;
	}

	/**
	 * The bridge keeps chunk replies until their squares change, with the season and snowline of their time: after a
	 * new month a 16 x 16 chunk at a place that changes every month (hardly ever cached) tells the current snowline.
	 */
	async probeSnow(sky) {
		sky.probeWanted = false;
		this.probing = true;
		const gen = this.gen, n16x = Math.ceil(this.size.x / 16), n16y = Math.ceil(this.size.y / 16);
		const k = ((S.monthKey || 0) * 7919 + (this.probes = (this.probes || 0) + 1) * 104729) % (n16x * n16y);
		const r = await this.rpc({ op: "probe", cx: k % n16x, cy: Math.floor(k / n16x) });
		if (gen !== this.gen) {
			return;
		}
		this.probing = false;
		if (r.ok) {
			sky.noteSnowline(r.snowline, r.rev, true);
			this.view.dirty = true;
		}
	}

	/** Overhang parts (buildings of a neighbour chunk reaching into a chunk) show only while that chunk is not shown. */
	updateOverhang() {
		let changed = false;
		for (const e of this.chunks.values()) {
			if (!e.over || !e.over.length) {
				continue;
			}
			for (const o of e.over) {
				const src = this.chunks.get(o.userData.over);
				const vis = !(src && src.obj && src.obj.visible);
				if (o.visible !== vis) {
					o.visible = vis;
					changed = true;
				}
			}
		}
		return changed;
	}

	/** Overhang parts drawn now (tests): [{chunk, over}]. */
	overhangShown() {
		const out = [];
		for (const e of this.chunks.values()) {
			if (e.obj && e.obj.visible && e.over) {
				for (const o of e.over) {
					if (o.visible) {
						out.push({ chunk: e.key, over: o.userData.over });
					}
				}
			}
		}
		return out;
	}

	heightBounds() {
		return { yLo: (this.range.min - 2) * HEIGHT_STEP, yHi: (this.range.max + BUILDING_HEADROOM) * HEIGHT_STEP };
	}

	computeWanted(now) {
		const rig = this.view.rig, size = this.size;
		const { yLo, yHi } = this.heightBounds();
		const fp = rig.footprint(yLo, yHi);
		const nx = Math.ceil(size.x / CHUNK), ny = Math.ceil(size.y / CHUNK);
		const cx0 = Math.max(0, Math.floor((fp.x0 - MARGIN) / CHUNK)), cx1 = Math.min(nx - 1, Math.floor((fp.x1 + MARGIN) / CHUNK));
		const cy0 = Math.max(0, Math.floor((fp.z0 - MARGIN) / CHUNK)), cy1 = Math.min(ny - 1, Math.floor((fp.z1 + MARGIN) / CHUNK));
		const frustum = rig.frustum();
		const t = rig.target, eye = rig.camera.position;
		// zoomed out: chunks too small to show their detail are left to the far terrain
		const range = rig.nearRange(NEAR_MIN_PX);
		const box = new THREE.Box3();
		const list = [];
		for (let cy = cy0; cy <= cy1 && range > 0; cy++) {
			for (let cx = cx0; cx <= cx1; cx++) {
				const x0 = cx * CHUNK, z0 = cy * CHUNK;
				const x1 = Math.min(size.x, x0 + CHUNK), z1 = Math.min(size.y, z0 + CHUNK);
				const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
				const d = Math.hypot(mx - t.x, mz - t.z);
				if (d - CHUNK * 0.71 > fp.radius) {
					continue;
				}
				if (range !== Infinity && Math.hypot(mx - eye.x, t.y - eye.y, mz - eye.z) - CHUNK * 0.71 > range) {
					continue;
				}
				box.min.set(x0 - MARGIN, yLo, z0 - MARGIN);
				box.max.set(x1 + MARGIN, yHi, z1 + MARGIN);
				if (frustum.intersectsBox(box)) {
					list.push({ cx, cy, d });
				}
			}
		}
		list.sort((a, b) => a.d - b.d);
		const keys = list.slice(0, this.quality.maxChunks).map((c) => {
			const k = keyOf(c.cx, c.cy);
			let e = this.chunks.get(k);
			if (!e) {
				e = { key: k, cx: c.cx, cy: c.cy, state: "idle", obj: null, etag: null, dirty: false, dirtyAgain: false,
					lastUsed: now, hgrid: null, retryAt: 0, fails: 0 };
				this.chunks.set(k, e);
			}
			e.lastUsed = now;
			return k;
		});
		this.wanted = keys;
		this.wantedSet = new Set(keys);
		let changed = this.evict(this.wantedSet);
		for (const c of this.chunks.values()) {
			if (c.obj && c.obj.visible !== this.wantedSet.has(c.key)) {
				c.obj.visible = !c.obj.visible;
				changed = true;
			}
		}
		if (changed) {
			this.version++;
		}
		this.view.status();
		return changed;
	}

	pump(now) {
		if (now < this.pausedUntil) {
			return;
		}
		for (const k of this.wanted) {
			if (this.inflight >= this.quality.concurrency) {
				break;
			}
			const e = this.chunks.get(k);
			if (!e) {
				continue;
			}
			const need = e.state === "idle" || (e.state === "failed" && now >= e.retryAt) || (e.state === "ready" && e.dirty);
			if (need) {
				this.load(e);
			}
		}
	}

	async load(e) {
		const gen = this.gen;
		const had = e.state === "ready";
		e.state = "loading";
		e.dirty = false;
		this.inflight++;
		this.stats.requests++;
		if (had) {
			this.stats.refetches++;
		}
		const r = await this.rpc({ op: "chunk", cx: e.cx, cy: e.cy, etag: had ? e.etag : null });
		if (gen !== this.gen) {
			return;
		}
		this.inflight--;
		const back = () => {
			e.state = had ? "ready" : "idle";
		};
		if (!r.ok) {
			this.workerFailed(r, e, back, had);
		} else if (r.status === 304) {
			this.stats.notModified++;
			e.state = "ready";
		} else if (had && r.etag && r.etag === e.etag) {
			this.stats.sameEtag++;
			e.state = "ready";
		} else {
			this.stats.ok++;
			push(this.stats.fetchMs, r.fetch_ms);
			push(this.stats.decodeMs, r.decode_ms);
			push(this.stats.buildMs, r.build_ms);
			e.state = had ? "ready" : "building";
			this.pending.push({ e, r });
		}
		if (e.dirtyAgain) {
			e.dirtyAgain = false;
			if (e.state === "ready") {
				e.dirty = true;
			} else if (e.state === "building") {
				e.dirtyAfterAdd = true;
			}
		}
		this.view.status();
	}

	/**
	 * The main thread cannot use a model of the pak 3D (pakmodels.js): the worker generates its objects from now on, and
	 * the chunks with copies of it are built again (fetched without their ETag, so not answered by a 304).
	 */
	modelFailed(path, reason) {
		if (!this.worker) {
			return;
		}
		this.rpc({ op: "modelFailed", path, reason });
		for (const e of this.chunks.values()) {
			if (e.modelPaths && e.modelPaths.includes(path)) {
				e.etag = null;
				this.markDirty(e);
			}
		}
		this.wantDirty = true;
	}

	workerFailed(r, e, back, had) {
		const st = r.status;
		if (st === 429 || st === 503) {
			this.stats.retries++;
			this.pausedUntil = performance.now() + Math.max(1, r.retry || 1) * 1000;
			if (back) {
				back();
				if (had) {
					e.dirty = true;
				}
			}
			return;
		}
		if (st === 401) {
			this.view.authFailed();
			if (back) {
				back();
			}
			return;
		}
		if (st === 501) {
			this.view.unsupported(r.error);
			return;
		}
		if (e && st === 404) {
			e.state = "empty";
			return;
		}
		this.stats.failed++;
		this.error = r.error || "HTTP " + st;
		if (!e) {
			this.view.fail(new Error(this.error));
			return;
		}
		e.fails++;
		e.retryAt = performance.now() + Math.min(30000, 1000 * Math.pow(2, e.fails));
		e.state = had ? "ready" : "failed";
		if (had) {
			e.dirty = true;
			e.retryAt = 0;
		}
	}

	add({ e, r }) {
		const t0 = performance.now();
		if (this.chunks.get(e.key) !== e) {
			return; // evicted while it was waiting
		}
		const g = new THREE.Group();
		g.name = "chunk " + e.key;
		g.matrixAutoUpdate = false; // parts are in world coordinates
		g.updateMatrix();
		if (r.shapes) {
			this.parts.setShapes(r.shapes);
		}
		for (const p of r.parts) {
			const o = this.parts.build(p);
			if (o) {
				g.add(o);
			}
		}
		if (e.obj) {
			this.release(e.obj);
		}
		e.low = false;
		e.over = g.children.filter((o) => o.userData.over);
		g.visible = this.wantedSet.has(e.key);
		if (this.view.sky) {
			this.view.sky.noteSnowline(r.snowline, r.rev);
		}
		this.group.add(g);
		this.version++;
		e.obj = g;
		e.etag = r.etag;
		e.hgrid = r.hgrid;
		e.top = r.top;
		e.picks = r.picks;
		e.x0 = r.x0;
		e.y0 = r.y0;
		e.w = r.w;
		e.h = r.h;
		e.count = r.count;
		e.state = "ready";
		this.objects = r.objects || null;
		e.modelPaths = (r.models || []).map((p) => p.lods[0]);
		if (this.view.models) {
			this.view.models.setChunk(e.key, r.models || []);
		}
		for (const f of r.modelFailures || []) {
			warnOnce(f.path + ": " + f.reason + " (generated instead)");
		}
		this.detail(e);
		e.fails = 0;
		if (e.dirtyAfterAdd) {
			e.dirtyAfterAdd = false;
			e.dirty = true;
		}
		if (r.maxLevel > this.range.max) {
			this.range.max = r.maxLevel;
		}
		push(this.stats.addMs, performance.now() - t0);
	}

	release(g) {
		g.removeFromParent();
		for (const o of g.children) {
			PartFactory.release(o);
		}
	}

	drop(e) {
		if (e.obj) {
			this.release(e.obj);
			e.obj = null;
			this.version++;
		}
		if (this.view.models) {
			this.view.models.removeChunk(e.key);
		}
		e.hgrid = null;
		e.top = null;
		e.picks = null;
	}

	/** Unloads chunks beyond the cache size (least recently wanted first) and changed chunks out of view. */
	evict(wanted) {
		let changed = false;
		const ready = [];
		for (const e of this.chunks.values()) {
			if (wanted.has(e.key)) {
				continue;
			}
			if (e.state === "ready" && e.dirty) {
				this.drop(e);
				this.chunks.delete(e.key);
				this.stats.evicted++;
				changed = true;
			} else if (e.state === "ready" || e.state === "building") {
				ready.push(e);
			} else if (e.state !== "loading") {
				this.chunks.delete(e.key);
			}
		}
		const loaded = ready.length + wanted.size;
		if (loaded > this.quality.cacheChunks) {
			ready.sort((a, b) => a.lastUsed - b.lastUsed);
			for (const e of ready.slice(0, loaded - this.quality.cacheChunks)) {
				this.drop(e);
				this.chunks.delete(e.key);
				this.stats.evicted++;
				changed = true;
			}
		}
		return changed;
	}

	/** World height of the ground at (x, z), or null when its chunk is not loaded. */
	groundAt(x, z) {
		const e = this.chunks.get(keyOf(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
		if (!e || !e.hgrid) {
			return null;
		}
		const lx = Math.floor(x) - e.x0, lz = Math.floor(z) - e.y0;
		if (lx < 0 || lz < 0 || lx >= e.w || lz >= e.h) {
			return null;
		}
		return e.hgrid[lz * e.w + lx] * HEIGHT_STEP;
	}

	/** The shown chunk with square (x, z) and its height grid, or null (picking: then the far terrain is shown). */
	shownAt(x, z) {
		const e = this.chunks.get(keyOf(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
		return e && e.hgrid && e.obj && e.obj.visible ? e : null;
	}

	/** Calls fn(cx, cy) for every shown chunk. */
	eachShown(fn) {
		for (const e of this.chunks.values()) {
			if (e.obj && e.obj.visible) {
				fn(e.cx, e.cy);
			}
		}
	}

	/** Nothing left to do for the current view (tests, screenshots). */
	settled() {
		const p = this.progress();
		const dirty = this.wanted.some((k) => {
			const e = this.chunks.get(k);
			return e && e.dirty;
		});
		return this.ready && !this.wantDirty && !dirty && p.inflight === 0 && p.pending === 0 && p.ready >= p.wanted;
	}

	progress() {
		let ready = 0;
		for (const k of this.wanted) {
			const e = this.chunks.get(k);
			if (e && (e.state === "ready" || e.state === "empty")) {
				ready++;
			}
		}
		return { ready, wanted: this.wanted.length, inflight: this.inflight, pending: this.pending.length };
	}

	info() {
		const states = {};
		for (const e of this.chunks.values()) {
			states[e.state] = (states[e.state] || 0) + 1;
		}
		const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null);
		const max = (a) => (a.length ? Math.max(...a) : null);
		const s = this.stats;
		let shown = 0;
		this.eachShown(() => shown++);
		return Object.assign(this.progress(), {
			states, loaded: (states.ready || 0), shown, budget: this.quality.maxChunks, requests: s.requests, ok: s.ok, notModified: s.notModified,
			sameEtag: s.sameEtag, retries: s.retries, failed: s.failed, refetches: s.refetches, evicted: s.evicted,
			fetch_ms: [med(s.fetchMs), max(s.fetchMs)], decode_ms: [med(s.decodeMs), max(s.decodeMs)],
			build_ms: [med(s.buildMs), max(s.buildMs)], add_ms: [med(s.addMs), max(s.addMs)],
			keys: [...this.chunks.values()].filter((e) => e.state === "ready").map((e) => e.key), error: this.error,
			shownKeys: [...this.chunks.values()].filter((e) => e.obj && e.obj.visible).map((e) => e.key),
			objects: this.objects || null, lowDetail: [...this.chunks.values()].filter((e) => e.low).length,
		});
	}

	dispose() {
		this.reset();
		this.parts.dispose();
		this.group.removeFromParent();
	}
}
