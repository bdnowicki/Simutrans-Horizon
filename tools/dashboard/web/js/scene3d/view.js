// Simutrans-Horizon dashboard, 3D view: renderer, scene, lights, the frame loop and the layers. Loaded only when
// the 3D tab is opened (it pulls in three.js). A layer is an object with
//   update(now) -> true when the frame must be drawn, onView() (the camera moved), dispose()
// and optional onMapChanges(event), onSnapshot(); the layers are the chunk streaming (chunks.js), the far terrain
// (farlod.js), picking (picking.js), the vehicles (vehicles.js), the labels (labels.js) and, with a pak 3D, its models
// (pakmodels.js), more come with addLayer(). The pak 3D is read once per view (`pakReady`) before the chunks and
// vehicles start. Camera mode, rotation and zoom are remembered per browser (preference "v3dCamera"), the quality
// settings too ("v3dQuality", config.js). Day and night, seasons and snow: sky.js. Optional shadows of the sun with a
// shadow map fitted to the view. Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { S, subscribe, loadPref, savePref } from "/js/store.js";
import { isDark } from "/js/map.js";
import { loadSession } from "/js/api.js";
import { CameraRig } from "./camera.js";
import { ChunkLayer } from "./chunks.js";
import { FarLayer } from "./farlod.js";
import { Picker } from "./picking.js";
import { VehicleLayer } from "./vehicles.js";
import { LabelLayer } from "./labels.js";
import { Sky, setTreePalette } from "./sky.js";
import { loadPak, loadLicenses, ModelCache, ModelLayer, setLodScale } from "./pakmodels.js";
import { qualityProfile, loadSettings, coarse, compileSpread, yieldTask, PROFILES, TREE_DENSITIES, CHUNK, MAX_PPU } from "./config.js";

const DEFAULT_PPU = 24;
const STATUS_MS = 150;
const PREFS_MS = 500;
const SKY = { light: 0xaec6dc, dark: 0x1d2329 };
// automatic quality (profile "auto"): when drawing takes longer than SLOW_MS per frame (median of consecutive frames
// over ADAPT_MS), the pixel ratio, the chunk budget and the shadows go down a level (the phone target is 30 frames
// per second); after UP_WINDOWS windows in a row faster than FAST_MS they go up again (not sooner than UP_HOLD_MS
// after going down, much later when going up made it slow again)
const SLOW_MS = 37;
const FAST_MS = 20;
const ADAPT_MS = 2500;
const ADAPT_FRAMES = 45;
const UP_WINDOWS = 2;
const UP_HOLD_MS = 10000;
const UP_BACKOFF_MS = 60000;
const LEVELS = [{ dpr: 1, chunks: 1, shadow: 1 }, { dpr: 0.75, chunks: 0.7, shadow: 0.5 }, { dpr: 0.5, chunks: 0.5, shadow: 0 },
	{ dpr: 0.5, chunks: 0.35, shadow: 0 }];
const SHADOW_R = 140; // squares around the view target that get shadows at most
const SHADOW_D = 300; // distance of the shadow camera from its target

export class NoWebGL2Error extends Error {}

let live = 0;

/** Creates the view in `container`. opts: {onStatus(status), initial: {center: {x, y}} | {state, worldKey}}. */
export function createView(container, opts = {}) {
	return new View3D(container, opts);
}

function pct(arr, p) {
	const s = arr.slice().sort((a, b) => a - b);
	return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}

class View3D {
	constructor(container, opts) {
		this.container = container;
		this.opts = opts;
		this.settings = loadSettings(loadPref);
		this.quality = Object.assign(qualityProfile(this.settings), { level: 0 });
		this.base = Object.assign({}, this.quality);
		setLodScale(this.quality.lodScale);
		this.adaptLog = [];
		this.drawDeltas = [];
		this.lastDraw = 0;
		this.adaptAt = performance.now();
		this.upHold = 0;
		this.fastWins = 0;
		this.lastUpAt = -Infinity;
		this.size = null;
		this.prefs = loadPref("v3dCamera", null);
		this.prefTimer = null;
		this.disposed = false;
		this.phase = "loading";
		this.error = null;
		this.worldKey = null;
		this.dirty = true;
		this.continuous = 0;
		this.held = false;
		this.frames = 0;
		this.lastRender = { triangles: 0, calls: 0 };
		this.statusTimer = null;
		this.subs = [];

		const canvas = document.createElement("canvas");
		canvas.className = "v3d-canvas";
		canvas.setAttribute("role", "img");
		if (opts.label) {
			canvas.setAttribute("aria-label", opts.label);
		}
		const attrs = { alpha: false, antialias: this.quality.antialias, depth: true, stencil: false,
			powerPreference: "high-performance", preserveDrawingBuffer: false };
		let gl = null;
		try {
			gl = canvas.getContext("webgl2", attrs);
		} catch (e) { /* no WebGL */ }
		if (!gl) {
			throw new NoWebGL2Error("WebGL 2 is not available");
		}
		this.canvas = canvas;
		container.appendChild(canvas);
		const r = new THREE.WebGLRenderer({ canvas, context: gl, antialias: this.quality.antialias });
		r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.dprCap));
		this.renderer = r;
		this.onLost = (e) => {
			e.preventDefault();
			if (!this.disposed) {
				this.fail(new Error("the graphics context was lost"));
			}
		};
		canvas.addEventListener("webglcontextlost", this.onLost);
		const dbg = gl.getExtension("WEBGL_debug_renderer_info");
		this.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
		live++;

		const scene = new THREE.Scene();
		this.scene = scene;
		scene.background = new THREE.Color(isDark() ? SKY.dark : SKY.light);
		scene.fog = new THREE.Fog(scene.background.clone(), 1e7, 2e7);
		// no environment map: its PMREM takes about 0.5 s on the main thread (F0 laptop), so models of the pak 3D keep
		// their metalness low (tools/pak3d/README.md); RoomEnvironment is vendored for a later use
		this.hemi = new THREE.HemisphereLight(0xe8f0ff, 0x6a5a48, 1.5);
		scene.add(this.hemi);
		this.sun = new THREE.DirectionalLight(0xffffff, 2.0);
		scene.add(this.sun, this.sun.target);
		// shadows: the shadow map is always configured, switched with renderer.shadowMap.enabled + castShadow
		r.shadowMap.type = THREE.PCFShadowMap;
		this.sun.shadow.mapSize.set(this.quality.shadowSize, this.quality.shadowSize);
		this.sun.shadow.bias = -0.0004;
		this.shadowOn = false;
		this.shadowInfo = null;
		this.setShadows(this.quality.shadows, true);
		this.sky = new Sky(this, SKY, isDark);
		this.sky.setEnabled(this.settings.daynight);

		// the pak 3D: none unless the bridge serves one (/api/session view3d.pak3d), then its manifest and rules
		this.pak = { state: "loading" };
		this.models = null;
		this.modelCache = null;
		this.pakReady = loadPak(S.session).then((res) => {
			if (this.disposed) {
				return res;
			}
			this.pak = res;
			setTreePalette(res.rules);
			if (res.state === "loaded") {
				this.modelCache = new ModelCache(res.pak, (key, rec) => this.onModel(key, rec), (objs, tex) => this.warmObjects(objs, tex));
				this.models = new ModelLayer(this, this.modelCache);
				this.addLayer(this.models);
			}
			this.status();
			return res;
		});

		this.rig = new CameraRig(canvas, { onChange: () => this.viewChanged(),
			groundAt: (x, z) => this.chunks.groundAt(x, z) ?? (this.far ? this.far.groundAt(x, z) : null) });
		this.chunks = new ChunkLayer(this);
		this.far = new FarLayer(this);
		this.picker = new Picker(this);
		this.vehicles = new VehicleLayer(this);
		this.labels = new LabelLayer(this, this.settings.labels);
		this.layers = [this.chunks, this.far, this.picker, this.vehicles, this.labels];
		this.vehicles.setSelected(S.ui.selection && S.ui.selection.kind === "convoy" ? S.ui.selection.id : null);

		this.subs.push(subscribe(["world", "poll"], () => this.syncWorld()));
		this.subs.push(subscribe(["poll"], () => this.sky.onPoll()));
		this.subs.push(subscribe(["map_changes"], (_, d) => this.eachLayer("onMapChanges", d || {})));
		this.subs.push(subscribe(["snapshot"], () => {
			if (this.worldKey !== null && this.worldKey === S.worldKey) {
				this.eachLayer("onSnapshot");
			}
		}));
		this.subs.push(subscribe(["ui"], (_, patch) => {
			if (!patch || "selection" in patch) {
				const s = S.ui.selection;
				this.vehicles.setSelected(s && s.kind === "convoy" ? s.id : null);
			}
		}));
		this.subs.push(subscribe(["theme"], () => {
			scene.background.set(isDark() ? SKY.dark : SKY.light);
			scene.fog.color.copy(scene.background);
			this.dirty = true;
		}));

		this.ro = new ResizeObserver(() => this.resize());
		this.ro.observe(container);
		this.resize();
		this.onKey = (e) => this.key(e);
		window.addEventListener("keydown", this.onKey);

		this.hooks = this.makeHooks();
		window.__view3d = this.hooks;
		window.__view3dLive = live;
		r.setAnimationLoop(() => this.frame());
		this.syncWorld();
	}

	// --- world and status ------------------------------------------------------------------------------------

	syncWorld() {
		const w = S.poll && S.poll.world;
		const key = S.worldKey;
		if (!w || !w.size_x || !key) {
			if (this.worldKey === null) {
				this.phase = "noworld";
				this.status();
			}
			return;
		}
		if (key === this.worldKey) {
			return;
		}
		const first = this.worldKey === null;
		this.worldKey = key;
		this.phase = "loading";
		this.error = null;
		this.size = { x: w.size_x, y: w.size_y };
		this.rig.setBounds(w.size_x, w.size_y);
		this.updateZoomLimits();
		const init = first ? this.opts.initial : null;
		if (init && init.state && init.worldKey === key) {
			this.rig.restore(init.state);
		} else {
			const c = init && init.center ? init.center : { x: w.size_x / 2, y: w.size_y / 2 };
			this.rig.lookAt(c.x + 0.5, c.y + 0.5, first ? DEFAULT_PPU : null);
			if (first && this.prefs) {
				this.rig.applyPrefs(this.prefs);
			}
		}
		this.chunks.start(w.size_x, w.size_y).catch((e) => this.fail(e));
		this.far.start(w.size_x, w.size_y);
		this.status();
	}

	/**
	 * Compiles the shaders of the chunk materials before the first chunk arrives (no long first frame), one program per
	 * task (config.js compileSpread).
	 */
	async warmup(parts) {
		const list = [], tmp = [];
		const tri = new THREE.BufferGeometry();
		tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
		tri.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(9), 3, true));
		tmp.push(tri);
		for (const key of ["terrain", "water", "way", "waterway", "solid", "building", "tree"]) {
			const m = new THREE.Mesh(tri, parts.material(key));
			m.castShadow = m.receiveShadow = true;
			list.push(m);
		}
		const mats = ["solid", "tree0", "tree1", "tree2"];
		let k = 0;
		for (const shape of parts.shapes.values()) {
			for (const key of k++ ? ["solid"] : mats) {
				const m = new THREE.InstancedMesh(shape, parts.material(key), 1);
				m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
				m.castShadow = m.receiveShadow = true;
				list.push(m);
				tmp.push(m);
			}
		}
		await compileSpread(this.renderer, list, this.rig.camera, this.scene, () => !this.disposed);
		for (const o of tmp) {
			o.dispose();
		}
	}

	/** Shader programs of objects and textures prepared one per task (models of the pak 3D, config.js compileSpread). */
	async warmObjects(objects, textures = []) {
		await compileSpread(this.renderer, objects, this.rig.camera, this.scene, () => !this.disposed);
		for (const t of textures) {
			if (this.disposed) {
				return;
			}
			this.renderer.initTexture(t);
			await yieldTask();
		}
	}

	eachLayer(fn, arg) {
		for (const l of this.layers) {
			if (typeof l[fn] === "function") {
				l[fn](arg);
			}
		}
	}

	addLayer(layer) {
		this.layers.push(layer);
		this.dirty = true;
	}

	/** Reports the state to the tab (throttled). */
	status() {
		if (this.statusTimer || this.disposed) {
			return;
		}
		this.statusTimer = setTimeout(() => {
			this.statusTimer = null;
			if (this.disposed || !this.opts.onStatus) {
				return;
			}
			const p = this.chunks.progress();
			const far = this.far.ready || !!this.far.error;
			if (this.phase === "loading" && this.chunks.ready && far && p.ready >= p.wanted) {
				this.phase = "ready";
			} else if (this.phase === "ready" && p.ready < p.wanted) {
				this.phase = "loading";
			}
			this.opts.onStatus({ phase: this.phase, error: this.error, progress: p, mode: this.rig.mode, azK: this.rig.azK,
				follow: this.vehicles.followInfo(), extras: this.vehicles.extras, pak: this.pakStatus(),
				settings: Object.assign({}, this.settings), quality: { name: this.quality.name, level: this.quality.level,
					auto: this.quality.auto, shadows: this.shadowOn, autoName: coarse() ? "low" : "high", treeDensities: TREE_DENSITIES,
					profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, { shadows: v.shadows, treeDensity: v.treeDensity }])) } });
		}, STATUS_MS);
	}

	/** What the tab shows of the pak 3D: {state, name, version, license, error} (game and pak texts: text nodes only). */
	pakStatus() {
		const r = this.pak || {};
		const p = r.pak || {};
		return { state: r.state || "none", name: p.name || null, version: p.version || null, license: p.license || null,
			author: p.author || null, error: r.error || null };
	}

	/** The rows of the pak's LICENSES.md (authors page). */
	licenses() {
		return loadLicenses();
	}

	/** A model of the pak 3D finished loading (or failed): the layers that draw it. */
	onModel(key, rec) {
		if (this.models) {
			this.models.onModel(key, rec);
		}
		this.dirty = true;
	}

	fail(e) {
		console.error("3D view:", e);
		this.phase = "error";
		this.error = String((e && e.message) || e);
		this.status();
	}

	unsupported(reason) {
		this.phase = "unsupported";
		this.error = reason || null;
		this.status();
	}

	authFailed() {
		loadSession().catch(() => {}); // a 401 there goes to the login page
	}

	// --- camera ------------------------------------------------------------------------------------------------

	viewChanged() {
		this.dirty = true;
		this.eachLayer("onView");
		// fog: the horizon of the free view fades into the sky (the far terrain reaches the map edge); always present
		// (no shader rebuild), out of reach in iso
		const fog = this.scene.fog;
		if (this.rig.mode === "free") {
			const d = this.rig.free.position.distanceTo(this.rig.freeCtl.target);
			fog.near = Math.max(3 * CHUNK, d * 2.5);
			fog.far = Math.max(10 * CHUNK, d * 8);
		} else {
			fog.near = 1e7;
			fog.far = 2e7;
		}
		if (!this.prefTimer && this.worldKey !== null) {
			this.prefTimer = setTimeout(() => this.savePrefs(), PREFS_MS);
		}
	}

	savePrefs() {
		clearTimeout(this.prefTimer);
		this.prefTimer = null;
		if (this.worldKey !== null) {
			this.prefs = this.rig.prefs();
			savePref("v3dCamera", this.prefs);
		}
	}

	resize() {
		const w = this.container.clientWidth, h = this.container.clientHeight;
		if (!w || !h) {
			return;
		}
		this.renderer.setSize(w, h, false);
		this.rig.setSize(w, h);
		if (this.labels) {
			this.labels.setSize(w, h);
		}
		this.updateZoomLimits();
		this.viewChanged();
	}

	/** The iso view may zoom out until the whole map fits (the far terrain fills what the chunks do not). */
	updateZoomLimits() {
		const w = this.container.clientWidth, h = this.container.clientHeight;
		if (!w || !h || !this.size) {
			return;
		}
		const s = this.size.x + this.size.y;
		const fit = Math.min((w * Math.SQRT2) / s, (2 * Math.SQRT2 * h) / s);
		this.rig.setMinPpu(Math.max(0.2, fit * 0.8));
	}

	/** Quality level 0 (the profile) .. 3: pixel ratio, chunk budget, shadow map (automatic quality, tests). */
	setLevel(level, p50 = null) {
		const q = this.quality;
		level = Math.max(0, Math.min(LEVELS.length - 1, level | 0));
		if (level === q.level) {
			return;
		}
		const up = level < q.level;
		q.level = level;
		const L = LEVELS[level];
		q.dprCap = Math.max(1, this.base.dprCap * L.dpr);
		q.maxChunks = Math.max(4, Math.round(this.base.maxChunks * L.chunks));
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dprCap));
		const size = Math.max(512, Math.round(this.base.shadowSize * (L.shadow || 0.5)));
		if (this.sun.shadow.mapSize.x !== size) {
			this.sun.shadow.mapSize.set(size, size);
			if (this.sun.shadow.map) {
				this.sun.shadow.map.dispose();
				this.sun.shadow.map = null;
			}
		}
		this.setShadows(this.base.shadows && L.shadow > 0);
		this.adaptLog.push({ level, up, frame_ms: p50 === null ? null : Math.round(p50 * 10) / 10, dpr: this.renderer.getPixelRatio(),
			maxChunks: q.maxChunks, shadows: this.shadowOn });
		this.chunks.wantDirty = true;
		this.resize();
		this.status();
	}

	/**
	 * Frame times of consecutive drawn frames: slow ones lower the quality, a while of fast ones raises it again
	 * (profile "auto" only).
	 */
	adapt(now) {
		if (this.lastDraw && now - this.lastDraw < 150) {
			this.drawDeltas.push(now - this.lastDraw);
		}
		this.lastDraw = now;
		if (now - this.adaptAt >= ADAPT_MS && this.drawDeltas.length >= ADAPT_FRAMES) {
			const p50 = pct(this.drawDeltas, 0.5);
			this.adaptAt = now;
			this.drawDeltas = [];
			const q = this.quality;
			if (!q.auto || this.bench) {
				return;
			}
			if (p50 > SLOW_MS) {
				this.fastWins = 0;
				// slow again soon after going up: wait much longer before the next try
				this.upHold = now + (now - this.lastUpAt < 2 * UP_HOLD_MS ? UP_BACKOFF_MS : UP_HOLD_MS);
				this.setLevel(q.level + 1, p50);
			} else if (p50 < FAST_MS && q.level > 0 && now >= this.upHold) {
				if (++this.fastWins >= UP_WINDOWS) {
					this.fastWins = 0;
					this.lastUpAt = now;
					this.setLevel(q.level - 1, p50);
				}
			} else {
				this.fastWins = 0;
			}
		}
	}

	// --- shadows, settings ---------------------------------------------------------------------------------------

	/** Shadows of the sun on or off (all materials are compiled again). */
	setShadows(on, first = false) {
		on = !!on;
		if (on === this.shadowOn && !first) {
			return;
		}
		this.shadowOn = on;
		this.renderer.shadowMap.enabled = on;
		this.sun.castShadow = on;
		if (!first) {
			this.scene.traverse((o) => {
				for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
					m.needsUpdate = true;
				}
			});
		}
		this.dirty = true;
	}

	/**
	 * Fits the shadow camera to what the view shows (light space bounds of the ground under the screen corners, at most
	 * SHADOW_R squares from the target), snapped to whole shadow texels so the shadows do not shimmer while panning;
	 * fades them out when zoomed far out.
	 */
	fitShadow() {
		const sun = this.sun, sh = sun.shadow, rig = this.rig, cam = rig.camera, t = rig.target;
		const L = this._L || (this._L = new THREE.Vector3());
		L.copy(sun.position).sub(sun.target.position).normalize();
		const right = (this._R || (this._R = new THREE.Vector3())).set(0, 1, 0).cross(L);
		if (right.lengthSq() < 1e-6) {
			right.set(1, 0, 0);
		}
		right.normalize();
		const up = (this._U || (this._U = new THREE.Vector3())).copy(L).cross(right).normalize();
		const pts = [], p = new THREE.Vector3(), d = new THREE.Vector3();
		const ys = [t.y - 1.5, t.y + 7];
		let fade = 1;
		if (rig.mode === "iso") {
			cam.getWorldDirection(d);
			for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
				const o = new THREE.Vector3(nx, ny, -1).unproject(cam);
				for (const y of ys) {
					const k = (y - o.y) / d.y;
					p.set(o.x + d.x * k, y, o.z + d.z * k);
					const dx = p.x - t.x, dz = p.z - t.z, l = Math.hypot(dx, dz);
					if (l > SHADOW_R) {
						p.x = t.x + (dx / l) * SHADOW_R;
						p.z = t.z + (dz / l) * SHADOW_R;
					}
					pts.push(p.clone());
				}
			}
			fade = THREE.MathUtils.clamp((rig.ppu - 4) / 6, 0, 1);
		} else {
			const dist = cam.position.distanceTo(t), r = Math.min(SHADOW_R, Math.max(12, dist * 1.6));
			for (let i = 0; i < 8; i++) {
				const a = (i / 8) * Math.PI * 2;
				for (const y of ys) {
					pts.push(new THREE.Vector3(t.x + Math.cos(a) * r, y, t.z + Math.sin(a) * r));
				}
			}
			fade = THREE.MathUtils.clamp((420 - dist) / 200, 0, 1);
		}
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
		for (const q of pts) {
			const a = q.dot(right), b = q.dot(up), c = q.dot(L);
			x0 = Math.min(x0, a); x1 = Math.max(x1, a);
			y0 = Math.min(y0, b); y1 = Math.max(y1, b);
			z0 = Math.min(z0, c); z1 = Math.max(z1, c);
		}
		// a stable size (steps of 15 %), texel-aligned centre
		const raw = Math.max(x1 - x0, y1 - y0, 8);
		const size = Math.pow(1.15, Math.ceil(Math.log(raw) / Math.log(1.15)));
		const texel = size / sh.mapSize.x;
		const cx = Math.round((x0 + x1) / 2 / texel) * texel, cy = Math.round((y0 + y1) / 2 / texel) * texel, cz = t.dot(L);
		const c = right.clone().multiplyScalar(cx).addScaledVector(up, cy).addScaledVector(L, cz);
		sun.target.position.copy(c);
		sun.position.copy(c).addScaledVector(L, SHADOW_D);
		sun.target.updateMatrixWorld();
		sun.updateMatrixWorld();
		const sc = sh.camera, half = size / 2;
		sc.left = -half;
		sc.right = half;
		sc.top = half;
		sc.bottom = -half;
		sc.near = Math.max(1, SHADOW_D - (z1 - cz) - 60);
		sc.far = SHADOW_D - (z0 - cz) + 10;
		sc.updateProjectionMatrix();
		sh.normalBias = texel * 1.3;
		sh.intensity = fade * (1 - 0.65 * Math.min(1, this.sky.level / 4));
		this.shadowInfo = { size: Math.round(size * 10) / 10, texel: Math.round(texel * 1000) / 1000, fade, mapSize: sh.mapSize.x };
	}

	/**
	 * New quality settings (config.js loadSettings shape), saved for this browser. Returns true when the view must be
	 * created anew (profile, tree density); the rest applies at once.
	 */
	applySettings(next) {
		const old = this.settings;
		const s = Object.assign({}, old, next);
		this.settings = s;
		savePref("v3dQuality", s);
		if (s.profile !== old.profile || s.trees !== old.trees) {
			return true;
		}
		const q = qualityProfile(s);
		this.base.shadows = q.shadows;
		this.base.lodScale = q.lodScale;
		this.base.maxChunks = q.maxChunks;
		this.base.cacheChunks = q.cacheChunks;
		this.quality.cacheChunks = q.cacheChunks;
		this.quality.lodScale = q.lodScale;
		this.quality.shadows = q.shadows;
		this.quality.maxChunks = Math.max(4, Math.round(q.maxChunks * LEVELS[this.quality.level].chunks));
		setLodScale(q.lodScale);
		this.setShadows(q.shadows && LEVELS[this.quality.level].shadow > 0);
		this.labels.setEnabled(s.labels);
		this.sky.setEnabled(s.daynight);
		this.chunks.wantDirty = true;
		if (this.models) {
			this.models.onView();
		}
		this.dirty = true;
		this.status();
		return false;
	}

	setMode(mode) {
		this.rig.setMode(mode);
		this.status();
	}

	rotate(dir) {
		this.rig.rotate(dir);
		this.status();
	}

	zoomBy(f) {
		this.rig.zoomBy(f);
	}

	/** Centres the view on the point (x, y) of the map (squares); ends following a convoy. */
	lookAt(x, y) {
		this.vehicles.stopFollow();
		this.rig.lookAt(x, y);
	}

	/** The camera follows a convoy (id) until the user pans, presses Escape or stops it. */
	follow(cnv) {
		this.vehicles.startFollow(cnv);
	}

	stopFollow() {
		this.vehicles.stopFollow();
	}

	setExtras(on) {
		this.vehicles.setExtras(on);
	}

	key(e) {
		if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) {
			return;
		}
		const el = e.target;
		if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) {
			return;
		}
		const k = e.key;
		let used = true;
		if (k.startsWith("Arrow")) {
			this.vehicles.stopFollow();
		}
		if (k === "Escape") {
			used = !!this.vehicles.follow;
			this.vehicles.stopFollow();
		} else if (k === "v" || k === "V") {
			const s = S.ui.selection;
			if (this.vehicles.follow) {
				this.vehicles.stopFollow();
			} else if (s && s.kind === "convoy") {
				this.follow(s.id);
			}
		} else if (k === "q" || k === "Q") {
			this.rotate(-1);
		} else if (k === "e" || k === "E") {
			this.rotate(1);
		} else if (k === "f" || k === "F") {
			this.setMode(this.rig.mode === "iso" ? "free" : "iso");
		} else if (k === "l" || k === "L") {
			this.applySettings({ labels: !this.settings.labels });
		} else if (k === "+" || k === "=") {
			this.zoomBy(1.25);
		} else if (k === "-" || k === "_") {
			this.zoomBy(0.8);
		} else if (k === "ArrowLeft") {
			this.rig.panBy(-80, 0);
		} else if (k === "ArrowRight") {
			this.rig.panBy(80, 0);
		} else if (k === "ArrowUp") {
			this.rig.panBy(0, 80);
		} else if (k === "ArrowDown") {
			this.rig.panBy(0, -80);
		} else {
			used = false;
		}
		if (used) {
			e.preventDefault();
		}
	}

	// --- frames ------------------------------------------------------------------------------------------------

	frame() {
		if (this.disposed) {
			return;
		}
		const now = performance.now();
		let dirty = this.dirty;
		this.dirty = false;
		if (this.rig.update()) {
			dirty = true;
		}
		for (const l of this.layers) {
			if (l.update(now)) {
				dirty = true;
			}
		}
		if (this.sky.update(now)) {
			dirty = true;
		}
		if (this.modelCache && this.modelCache.animate(now)) {
			dirty = true;
		}
		if (this.held) {
			if (!this.oneFrame) {
				this.dirty = this.dirty || dirty;
				return;
			}
			this.oneFrame = false;
			dirty = true;
		}
		if (dirty || this.continuous) {
			this.render();
			this.adapt(now);
		}
		if (this.bench) {
			this.benchFrame(now);
		}
	}

	render() {
		const rig = this.rig, cam = rig.camera;
		// light from the upper left of the screen whatever the rotation (with day and night: swinging over the day)
		this.sky.apply(rig, this.scene, this.hemi, this.sun);
		if (this.shadowOn) {
			this.fitShadow();
		}
		this.renderer.render(this.scene, cam);
		const info = this.renderer.info.render;
		this.lastRender = { triangles: info.triangles, calls: info.calls };
		this.frames++;
		this.labels.render();
	}

	benchFrame(now) {
		const b = this.bench;
		if (b.last !== null) {
			b.deltas.push(now - b.last);
		}
		b.last = now;
		if (now - b.t0 >= b.ms) {
			this.bench = null;
			this.continuous--;
			const total = b.deltas.reduce((s, x) => s + x, 0) || 1;
			b.resolve({ frames: b.deltas.length, fps: b.deltas.length / (total / 1000), frame_ms_p50: pct(b.deltas, 0.5),
				frame_ms_p95: pct(b.deltas, 0.95), frame_ms_max: b.deltas.length ? Math.max(...b.deltas) : 0,
				triangles: this.lastRender.triangles, calls: this.lastRender.calls });
		}
	}

	/**
	 * Rough GPU memory of the view in bytes (measurements): vertex/index/instance buffers and textures the scene holds
	 * (hidden chunks too), the shadow map and the drawing buffer.
	 */
	gpuMemory() {
		const seen = new Set();
		let buffers = 0, textures = 0;
		const attr = (a) => {
			const d = a && (a.isInterleavedBufferAttribute ? a.data : a);
			if (d && d.array && !seen.has(d)) {
				seen.add(d);
				buffers += d.array.byteLength;
			}
		};
		const tex = (t) => {
			const img = t && t.image;
			if (img && img.width && !seen.has(t)) {
				seen.add(t);
				textures += img.width * img.height * 4 * (t.generateMipmaps ? 4 / 3 : 1);
			}
		};
		this.scene.traverse((o) => {
			const g = o.geometry;
			if (g) {
				for (const a of Object.values(g.attributes)) {
					attr(a);
				}
				attr(g.index);
			}
			if (o.isInstancedMesh) {
				attr(o.instanceMatrix);
				attr(o.instanceColor);
			}
			for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
				for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap"]) {
					tex(m[k]);
				}
			}
		});
		const shadow = this.shadowOn && this.sun.shadow.map ? this.sun.shadow.mapSize.x * this.sun.shadow.mapSize.y * 4 : 0;
		const gl = this.renderer.getContext();
		const frame = gl.drawingBufferWidth * gl.drawingBufferHeight * 8 * (this.quality.antialias ? 4 : 1);
		return { buffers, textures, shadow, frame, total: buffers + textures + shadow + frame };
	}

	makeHooks() {
		return {
			info: () => Object.assign(this.rig.info(), {
				phase: this.phase, error: this.error, quality: this.quality.name, gpu: this.gpu,
				dpr: this.renderer.getPixelRatio(), frames: this.frames, render: this.lastRender,
				memory: Object.assign({}, this.renderer.info.memory), programs: (this.renderer.info.programs || []).length,
				chunks: this.chunks.info(), fog: this.scene.fog.far < 1e6, far: this.far.info(), pick: this.picker.info(),
				vehicles: this.vehicles.info(),
				pak: Object.assign(this.pakStatus(), { entries: this.pak && this.pak.pak ? this.pak.pak.entries.length : 0,
					warnings: (this.pak && this.pak.warnings) || [], cache: this.modelCache ? this.modelCache.info() : null,
					layer: this.models ? this.models.info() : null }),
				level: this.quality.level, maxChunks: this.quality.maxChunks, adapt: this.adaptLog.slice(),
				minPpu: this.rig.isoCtl.minZoom * (this.rig.ppu / this.rig.iso.zoom), size: this.size,
				heap: performance.memory ? performance.memory.usedJSHeapSize : null,
				sky: this.sky.info(), labels: this.labels.info(), settings: Object.assign({}, this.settings),
				profile: { name: this.quality.name, auto: this.quality.auto, lodScale: this.quality.lodScale,
					treeDensity: this.quality.treeDensity, cacheChunks: this.quality.cacheChunks },
				shadows: { on: this.shadowOn, enabled: this.renderer.shadowMap.enabled, fit: this.shadowInfo,
					intensity: this.sun.shadow.intensity },
				overhang: this.chunks.overhangShown(), anim: this.modelCache ? this.modelCache.animInfo() : [],
			}),
			// quality: settings as in the 3D controls (true: the tab must create the view anew), a level, drawing
			// every frame (measurements and the automatic quality)
			setSettings: (s) => this.applySettings(s),
			setLevel: (n) => {
				this.upHold = 0;
				this.fastWins = 0;
				this.lastUpAt = -Infinity;
				this.setLevel(n);
			},
			continuous: (on) => {
				this.continuous = Math.max(0, this.continuous + (on ? 1 : -1));
			},
			// draws a frame and reads the pixels of a client rectangle every `step` pixels: {n, warm, bright, mean}
			// (warm: lit windows; tests of the night)
			pixels: (x0, y0, x1, y1, step = 2) => {
				this.render();
				const gl = this.renderer.getContext(), r = this.canvas.getBoundingClientRect();
				const sx = gl.drawingBufferWidth / r.width, sy = gl.drawingBufferHeight / r.height;
				const X0 = Math.max(0, Math.floor((x0 - r.left) * sx)), X1 = Math.min(gl.drawingBufferWidth, Math.ceil((x1 - r.left) * sx));
				const Y0 = Math.max(0, Math.floor((r.bottom - y1) * sy)), Y1 = Math.min(gl.drawingBufferHeight, Math.ceil((r.bottom - y0) * sy));
				const w = Math.max(1, X1 - X0), h = Math.max(1, Y1 - Y0), px = new Uint8Array(w * h * 4);
				gl.readPixels(X0, Y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
				let n = 0, warm = 0, bright = 0;
				const mean = [0, 0, 0];
				const k = Math.max(1, Math.round(step * sx));
				for (let y = 0; y < h; y += k) {
					for (let x = 0; x < w; x += k) {
						const o = (y * w + x) * 4, R = px[o], G = px[o + 1], B = px[o + 2];
						n++;
						mean[0] += R; mean[1] += G; mean[2] += B;
						if (R > 150 && R > B + 40 && G > B) warm++;
						if (R + G + B > 600) bright++;
					}
				}
				return { n, warm, bright, mean: mean.map((v) => Math.round(v / Math.max(1, n))) };
			},
			// the first object under a ray straight down at (x, z) of the map: {layer, name, y} (tests: ships at docks)
			rayDown: (x, z, skip) => {
				const ray = new THREE.Raycaster(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0), 0, 1000);
				const hits = ray.intersectObjects(this.scene.children, true).filter((h) => h.object.visible
					&& !(skip || []).includes(h.object.userData.layer || h.object.name));
				const h = hits[0];
				return h ? { layer: h.object.userData.layer || null, name: h.object.name, y: h.point.y } : null;
			},
			rotate: (d) => this.rotate(d),
			setMode: (m) => this.setMode(m),
			zoomBy: (f) => this.zoomBy(f),
			lookAt: (x, y, ppu, h) => this.rig.lookAt(x, y, ppu, h),
			state: () => this.rig.state(),
			prefs: () => this.rig.prefs(),
			settled: () => this.chunks.settled() && this.far.settled() && !this.rig.anim,
			// picking: square under a client point, client point of a square, a click there
			tileAt: (x, y) => this.picker.tileAtClient(x, y),
			clientOf: (x, y) => this.picker.clientOf(x, y),
			selectionFor: (x, y) => this.picker.selectionFor(x, y),
			// vehicles: client points of the drawn convoy cars, the car under a client point (with a pointer type: as a
			// click of it would find it, behind what is in front), follow, extras, a trace of
			// the drawn positions per frame (tests of the motion)
			vehiclesOnScreen: (limit) => this.vehicles.carsOnScreen(limit),
			vehicleAt: (x, y, type) => this.vehicles.pickAt(x, y, type || "mouse", type ? this.picker.tileAtClient(x, y) : null),
			follow: (id) => this.follow(id),
			stopFollow: () => this.stopFollow(),
			setExtras: (on) => this.setExtras(on),
			vehiclesOff: (off) => {
				this.vehicles.off = !!off;
			},
			traceVehicles: (opts) => this.vehicles.startTrace(opts),
			stopTrace: () => this.vehicles.stopTrace(),
			// frame times while drawing every frame for `seconds`
			bench: (seconds = 3) => new Promise((resolve) => {
				this.continuous++;
				this.bench = { t0: performance.now(), ms: seconds * 1000, deltas: [], last: null, resolve };
			}),
			// render + read one pixel per frame: CPU + GPU cost without vsync
			syncFrames: (n = 60) => {
				const gl = this.renderer.getContext(), px = new Uint8Array(4), arr = [];
				for (let i = 0; i < n; i++) {
					const t0 = performance.now();
					this.renderer.render(this.scene, this.rig.camera);
					gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
					arr.push(performance.now() - t0);
				}
				return { n, sync_ms_p50: pct(arr, 0.5), sync_ms_p95: pct(arr, 0.95) };
			},
			// pak 3D: instance matrices and colours of the drawn copies of a model file
			gpuMemory: () => this.gpuMemory(),
			pakCopies: (path, limit) => (this.models ? this.models.copies(path, limit) : []),
			pakVehicleCopies: (path, limit) => this.vehicles.modelCopies(path, limit),
			hold: (on) => {
				this.held = on;
				this.oneFrame = true;
			},
			maxPpu: MAX_PPU,
		};
	}

	/** Frees everything (GPU buffers, the worker, the WebGL context) and returns the camera state. */
	dispose() {
		if (this.disposed) {
			return null;
		}
		const state = this.rig.state();
		this.savePrefs();
		this.disposed = true;
		clearTimeout(this.statusTimer);
		this.renderer.setAnimationLoop(null);
		for (const u of this.subs) {
			u();
		}
		this.ro.disconnect();
		window.removeEventListener("keydown", this.onKey);
		for (const l of this.layers) {
			l.dispose();
		}
		this.rig.dispose();
		this.sky.dispose();
		if (this.modelCache) {
			this.modelCache.dispose();
		}
		this.renderer.dispose();
		this.canvas.removeEventListener("webglcontextlost", this.onLost);
		this.renderer.forceContextLoss();
		this.canvas.remove();
		live--;
		window.__view3dLive = live;
		if (window.__view3d === this.hooks) {
			window.__view3d = null;
		}
		return state;
	}
}
