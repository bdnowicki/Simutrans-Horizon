// Simutrans-Horizon dashboard, 3D view: the cameras. Isometric (orthographic, 30 degrees elevation, azimuth
// 45 + k * 90 degrees, four rotations like the game) and free (perspective + MapControls); a drag pans so that the
// ground under the mouse or finger stays under it (and glides on after a fast release), wheel and pinch zoom around
// the target point (the centre of the view; a pinch in the iso view keeps the ground between the fingers),
// rotations turn around it (in the free camera to the next of the four iso directions). Both can zoom out to the
// whole map. Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { MapControls } from "/vendor/three/addons/controls/MapControls.js";
import { ELEVATION, BASE_PPU, MAX_PPU, ISO_DIST, CHUNK, azimuthOf } from "./config.js";

const FREE_FOV = 50;
const FREE_ELEVATION = THREE.MathUtils.degToRad(40);
const FREE_MIN_POLAR = 0.05;
const FREE_MAX_POLAR = THREE.MathUtils.degToRad(84);
const ROTATE_MS = 240;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
// gliding after a drag: speed over the last THROW_WINDOW_MS of the drag, slowing down with the time constant
// THROW_MS; only from THROW_MIN and at most THROW_MAX pixels per millisecond, stops below THROW_STOP
const THROW_WINDOW_MS = 100;
const THROW_MS = 280;
const THROW_MIN = 0.3;
const THROW_MAX = 6;
const THROW_STOP = 0.02;

function dirFor(az, el) {
	return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

export class CameraRig {
	/**
	 * opts: {onChange(), groundAt(x, z) -> world y of the ground (or null), surfaceAt(clientX, clientY) -> the shown
	 * surface point [x, y, z] under a client point as a click finds it (or null)}
	 */
	constructor(dom, opts = {}) {
		this.dom = dom;
		this.onChange = opts.onChange || (() => {});
		this.groundAt = opts.groundAt || (() => null);
		this.surfaceAt = opts.surfaceAt || (() => null);
		this.mode = "iso";
		this.azK = 0;
		this.az = azimuthOf(0);
		this.anim = null;
		this.w = 1;
		this.h = 1;
		this.bounds = { x0: 0, z0: 0, x1: 256, z1: 256 };
		this.isoDist = ISO_DIST;
		this.iso = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, ISO_DIST * 3);
		this.free = new THREE.PerspectiveCamera(FREE_FOV, 1, 0.3, 3000);
		this.isoCtl = this.controls(this.iso, true);
		this.freeCtl = this.controls(this.free, false);
		this.freeCtl.enabled = false;
		this.pending = null;
		this.iso.zoom = 24 / BASE_PPU;
		this.placeIso();
		// panning is done here, not by MapControls: they move the view by the screen distance at the target with
		// damping, which lags behind the pointer and in the iso view moves the map half as fast as a vertical drag.
		// Here the ground point under the pointer stays under it; MapControls keep zoom and the free camera's rotation.
		this.ptrs = new Map(); // pointer id -> client point, of the presses that pan
		this.drag = null; // {point: the held ground point (world) or null, rotating: two fingers in the free camera}
		this.samples = []; // {t, x, z}: where the drag put the target, for the glide after the release
		this.lastMove = 0;
		this.inertia = null; // {vx, vz, t}: gliding, world units per millisecond
		this.ray = new THREE.Raycaster();
		this.ndc = new THREE.Vector2();
		this.onPtr = {
			pointerdown: (e) => this.ptrDown(e),
			pointermove: (e) => this.ptrMove(e),
			pointerup: (e) => this.ptrUp(e, false),
			pointercancel: (e) => this.ptrUp(e, true),
		};
		for (const [k, f] of Object.entries(this.onPtr)) {
			dom.addEventListener(k, f, { passive: true });
		}
	}

	controls(cam, iso) {
		const c = new MapControls(cam, this.dom);
		c.enableDamping = true;
		c.dampingFactor = 0.2;
		c.enablePan = false; // see the constructor
		c.zoomToCursor = false;
		if (iso) {
			c.enableRotate = false;
			c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
			c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
			c.minZoom = 6 / BASE_PPU;
			c.maxZoom = MAX_PPU / BASE_PPU;
		} else {
			c.minPolarAngle = FREE_MIN_POLAR;
			c.maxPolarAngle = FREE_MAX_POLAR;
			c.minDistance = 3;
			c.maxDistance = 400;
			c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
		}
		c.addEventListener("change", () => this.onChange());
		c.addEventListener("start", () => {
			this.pending = null; // the user took over
		});
		return c;
	}

	get camera() {
		return this.mode === "iso" ? this.iso : this.free;
	}

	get ctl() {
		return this.mode === "iso" ? this.isoCtl : this.freeCtl;
	}

	get target() {
		return this.ctl.target;
	}

	/** Pixels per square side of the iso view (zoom). */
	get ppu() {
		return BASE_PPU * this.iso.zoom;
	}

	/** The map size: the iso depth range, the free camera's reach and far plane cover the whole map. */
	setBounds(sizeX, sizeY) {
		this.bounds = { x0: 0, z0: 0, x1: sizeX, z1: sizeY };
		const diag = Math.hypot(sizeX, sizeY);
		this.isoDist = Math.max(ISO_DIST, diag);
		this.iso.far = this.isoDist * 3;
		this.freeCtl.maxDistance = Math.max(400, diag * 0.9);
		this.free.far = Math.max(3000, diag * 3);
		this.free.updateProjectionMatrix();
		this.placeIso();
	}

	setSize(w, h) {
		this.w = Math.max(1, w);
		this.h = Math.max(1, h);
		this.free.aspect = this.w / this.h;
		this.free.updateProjectionMatrix();
		this.placeIso();
	}

	/** Lowest iso zoom (more squares on the screen means more chunks to load). */
	setMinPpu(ppu) {
		this.isoCtl.minZoom = Math.min(ppu, MAX_PPU) / BASE_PPU;
		if (this.iso.zoom < this.isoCtl.minZoom) {
			this.iso.zoom = this.isoCtl.minZoom;
			this.placeIso();
		}
	}

	placeIso() {
		const t = this.isoCtl.target;
		this.iso.left = -this.w / (2 * BASE_PPU);
		this.iso.right = this.w / (2 * BASE_PPU);
		this.iso.top = this.h / (2 * BASE_PPU);
		this.iso.bottom = -this.h / (2 * BASE_PPU);
		this.iso.position.copy(t).addScaledVector(dirFor(this.az, ELEVATION), this.isoDist);
		this.iso.up.set(0, 1, 0);
		this.iso.lookAt(t);
		this.iso.updateProjectionMatrix();
		this.iso.updateMatrixWorld(true);
	}

	freeDistanceFor(ppu) {
		return THREE.MathUtils.clamp(this.focal() / ppu, 4, this.freeCtl.maxDistance);
	}

	/** Pixels per world unit at distance 1 of the free camera. */
	focal() {
		return this.h / (2 * Math.tan(THREE.MathUtils.degToRad(FREE_FOV / 2)));
	}

	/**
	 * Where near chunks are at least px pixels wide: iso Infinity (everywhere) or 0 (nowhere, zoomed out), free the
	 * distance from the camera.
	 */
	nearRange(px) {
		if (this.mode === "iso") {
			return this.ppu * CHUNK >= px ? Infinity : 0;
		}
		return (this.focal() * CHUNK) / px;
	}

	/**
	 * Centre the view on the point (x, y) of the map at height h (world units; default the ground there: until its
	 * chunk is loaded the target waits at 0 and is lifted onto the ground when it arrives). ppu: iso zoom.
	 */
	lookAt(x, y, ppu, h) {
		let gy = h ?? this.groundAt(x, y);
		this.pending = gy === null || gy === undefined ? { x, z: y } : null;
		gy = gy ?? 0;
		if (ppu) {
			this.iso.zoom = THREE.MathUtils.clamp(ppu / BASE_PPU, this.isoCtl.minZoom, this.isoCtl.maxZoom);
		}
		this.moveTarget(x, gy, y);
		this.onChange();
	}

	/** Moves the target of both cameras, keeping the free camera's offset. */
	moveTarget(x, y, z) {
		this.inertia = null;
		this.isoCtl.target.set(x, y, z);
		this.placeIso();
		if (this.mode === "free") {
			const off = this.free.position.clone().sub(this.freeCtl.target);
			this.freeCtl.target.set(x, y, z);
			this.free.position.copy(this.freeCtl.target).add(off);
			this.free.lookAt(this.freeCtl.target);
			this.freeCtl.update();
		}
	}

	placeFree(dist, x, y, z) {
		this.freeCtl.target.set(x, y, z);
		this.free.position.copy(this.freeCtl.target).addScaledVector(dirFor(this.az, FREE_ELEVATION), dist);
		this.free.lookAt(this.freeCtl.target);
		this.freeCtl.update();
	}

	setMode(mode) {
		if (mode === this.mode || (mode !== "iso" && mode !== "free")) {
			return;
		}
		this.anim = null;
		this.inertia = null;
		if (mode === "free") {
			const t = this.isoCtl.target;
			this.mode = "free";
			this.isoCtl.enabled = false;
			this.freeCtl.enabled = true;
			this.placeFree(this.freeDistanceFor(this.ppu), t.x, t.y, t.z);
		} else {
			const t = this.freeCtl.target, off = this.free.position.clone().sub(t);
			// the nearest of the four iso directions
			const a = norm(Math.atan2(off.x, off.z));
			this.azK = ((Math.round((a - Math.PI / 4) / (Math.PI / 2)) % 4) + 4) % 4;
			this.az = azimuthOf(this.azK);
			const dist = off.length();
			const ppu = this.focal() / dist;
			this.iso.zoom = THREE.MathUtils.clamp(ppu / BASE_PPU, this.isoCtl.minZoom, this.isoCtl.maxZoom);
			this.mode = "iso";
			this.freeCtl.enabled = false;
			this.isoCtl.enabled = true;
			this.isoCtl.target.copy(t);
			this.placeIso();
		}
		if (this.ptrs.size) {
			this.grab(); // switched while dragging: hold the ground under the pointer in the new camera
		}
		this.onChange();
	}

	/** Azimuth of the free camera around its target. */
	freeAz() {
		return norm(Math.atan2(this.free.position.x - this.freeCtl.target.x, this.free.position.z - this.freeCtl.target.z));
	}

	/** Turn around the target: dir +1 or -1. Iso: by 90 degrees; free: to the next of the four iso directions. */
	rotate(dir) {
		this.inertia = null;
		const step = dir > 0 ? 1 : -1, Q = Math.PI / 2;
		const start = this.mode === "free" && !this.anim ? this.freeAz() : this.currentAz();
		let end;
		if (this.mode === "iso") {
			end = (this.anim ? this.anim.to : this.az) + step * Q;
			this.azK = (((this.azK + step) % 4) + 4) % 4;
		} else {
			const base = this.anim ? this.anim.to : start, u = (base - Math.PI / 4) / Q;
			const k = step > 0 ? Math.floor(u + 1e-3) + 1 : Math.ceil(u - 1e-3) - 1;
			end = Math.PI / 4 + k * Q;
			this.azK = ((k % 4) + 4) % 4;
		}
		this.anim = { t0: performance.now(), from: start, to: end, freeAz: start,
			freeOff: this.mode === "free" ? this.free.position.clone().sub(this.freeCtl.target) : null };
	}

	currentAz() {
		const a = this.anim;
		if (!a) {
			return this.az;
		}
		const k = Math.min(1, (performance.now() - a.t0) / ROTATE_MS);
		const e = 1 - Math.pow(1 - k, 3);
		return a.from + (a.to - a.from) * e;
	}

	zoomBy(f) {
		if (this.mode === "iso") {
			this.iso.zoom = THREE.MathUtils.clamp(this.iso.zoom * f, this.isoCtl.minZoom, this.isoCtl.maxZoom);
			this.placeIso();
		} else {
			const t = this.freeCtl.target, off = this.free.position.clone().sub(t);
			const d = THREE.MathUtils.clamp(off.length() / f, this.freeCtl.minDistance, this.freeCtl.maxDistance);
			this.free.position.copy(t).addScaledVector(off.normalize(), d);
			this.freeCtl.update();
		}
		this.onChange();
	}

	/** Move the view by screen pixels (keyboard). */
	panBy(dx, dy) {
		this.pending = null;
		this.inertia = null;
		const cam = this.camera, t = this.target;
		const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).setY(0).normalize();
		const fwd = new THREE.Vector3().crossVectors(Y_AXIS, right).normalize(); // screen up, on the ground
		const scale = this.mode === "iso" ? 1 / this.ppu : (cam.position.distanceTo(t) * 1.6) / this.h;
		const d = right.multiplyScalar(dx * scale).addScaledVector(fwd, dy * scale * (this.mode === "iso" ? 2 : 1));
		t.add(d);
		cam.position.add(d);
		this.ctl.update();
		this.onChange();
	}

	// --- drag pan ----------------------------------------------------------------------------------------------

	/** Whether a press pans: any finger; mouse left, in the iso view also right (free: right and modifiers rotate). */
	pans(e) {
		if (e.pointerType === "touch") {
			return true;
		}
		if (this.mode === "iso") {
			return e.button === 0 || e.button === 2;
		}
		return e.button === 0 && !(e.ctrlKey || e.metaKey || e.shiftKey);
	}

	ptrDown(e) {
		this.inertia = null;
		if (!this.ctl.enabled || !this.pans(e) || (e.pointerType !== "touch" && this.ptrs.size)) {
			return;
		}
		this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
		try {
			this.dom.setPointerCapture(e.pointerId);
		} catch {
			// the pointer is already gone
		}
		this.pending = null; // the user took over
		this.grab();
	}

	ptrMove(e) {
		const p = this.ptrs.get(e.pointerId);
		if (p) {
			p.x = e.clientX;
			p.y = e.clientY;
			this.lastMove = performance.now();
		}
	}

	ptrUp(e, cancel) {
		if (!this.ptrs.delete(e.pointerId)) {
			return;
		}
		if (this.ptrs.size) {
			this.grab(); // one of two fingers lifted: go on with the other one from where it is
			return;
		}
		this.drag = null;
		this.throwOn(cancel);
	}

	/** Client point of the drag: the pointer, with two fingers their middle. */
	centre() {
		let x = 0, y = 0, n = 0;
		for (const p of this.ptrs.values()) {
			x += p.x;
			y += p.y;
			if (++n === 2) {
				break;
			}
		}
		return { x: x / n, y: y / n };
	}

	/** Takes hold of the ground under the drag point; two fingers in the free camera rotate it instead (MapControls). */
	grab() {
		const rotating = this.mode === "free" && this.ptrs.size > 1;
		const c = this.centre();
		this.drag = { point: rotating ? null : this.groundHit(c.x, c.y), rotating };
		this.samples.length = 0;
	}

	/**
	 * The point under the client point (x, y) that a drag holds: the shown surface (ground, roof or bridge) as a click
	 * finds it, else the ground; with h the point at that height (world units). Null above the horizon, and in the
	 * free camera beyond its reach.
	 */
	groundHit(x, y, h) {
		const r = this.dom.getBoundingClientRect();
		if (!r.width || !r.height) {
			return null;
		}
		const cam = this.camera;
		cam.updateMatrixWorld(true);
		this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
		this.ray.setFromCamera(this.ndc, cam);
		const o = this.ray.ray.origin, d = this.ray.ray.direction;
		if (d.y > -1e-3) {
			return null;
		}
		let gy = h;
		if (gy === undefined) {
			const s = this.surfaceAt(x, y);
			gy = s ? s[1] : this.groundAlong(o, d);
		}
		const k = (gy - o.y) / d.y;
		if (cam.isPerspectiveCamera && (k < 0 || k > Math.max(64, 8 * cam.position.distanceTo(this.freeCtl.target)))) {
			return null;
		}
		return new THREE.Vector3(o.x + d.x * k, gy, o.z + d.z * k);
	}

	/** Height of the ground under the ray (origin o, direction d): a few steps along it from the target's height. */
	groundAlong(o, d) {
		let gy = this.target.y;
		for (let i = 0; i < 3; i++) {
			const k = (gy - o.y) / d.y;
			const g = this.groundAt(o.x + d.x * k, o.z + d.z * k);
			if (g === null || g === undefined || Math.abs(g - gy) < 0.01) {
				break;
			}
			gy = g;
		}
		return gy;
	}

	/** Moves the target and the camera across the ground. */
	shift(dx, dz) {
		const t = this.target, cam = this.camera;
		t.x += dx;
		t.z += dz;
		cam.position.x += dx;
		cam.position.z += dz;
		cam.updateMatrixWorld(true);
	}

	/** Screen pixels per world unit at the target. */
	pxPerUnit() {
		return this.mode === "iso" ? this.ppu : this.focal() / Math.max(1e-3, this.free.position.distanceTo(this.freeCtl.target));
	}

	/** Per frame while dragging: puts the held ground point under the drag point again. True when the view moved. */
	dragStep() {
		const dr = this.drag;
		if (!dr || dr.rotating || !this.ptrs.size) {
			return false;
		}
		const c = this.centre();
		if (!dr.point) {
			dr.point = this.groundHit(c.x, c.y); // pressed above the horizon: hold the ground once the pointer is on it
			return false;
		}
		const p = this.groundHit(c.x, c.y, dr.point.y);
		if (!p) {
			return false;
		}
		const dx = dr.point.x - p.x, dz = dr.point.z - p.z, now = performance.now();
		this.samples.push({ t: now, x: this.target.x + dx, z: this.target.z + dz });
		while (this.samples.length > 2 && now - this.samples[0].t > THROW_WINDOW_MS) {
			this.samples.shift();
		}
		if (Math.abs(dx) + Math.abs(dz) < 1e-6) {
			return false;
		}
		this.shift(dx, dz);
		return true;
	}

	/** At the release of a fast drag the view glides on and slows down, like the 2D map. */
	throwOn(cancel) {
		const s = this.samples, now = performance.now();
		this.inertia = null;
		const a = s[0], b = s[s.length - 1];
		s.length = 0;
		if (cancel || !a || a === b || now - this.lastMove > 60 || b.t - a.t < 20) {
			return;
		}
		let vx = (b.x - a.x) / (b.t - a.t), vz = (b.z - a.z) / (b.t - a.t);
		const px = Math.hypot(vx, vz) * this.pxPerUnit();
		if (px < THROW_MIN) {
			return;
		}
		if (px > THROW_MAX) {
			vx *= THROW_MAX / px;
			vz *= THROW_MAX / px;
		}
		this.inertia = { vx, vz, t: now };
	}

	/** Per frame while gliding. True when the view moved. */
	throwStep() {
		const m = this.inertia;
		if (!m || this.ptrs.size) {
			return false;
		}
		const now = performance.now(), dt = Math.min(64, now - m.t);
		m.t = now;
		const f = Math.exp(-dt / THROW_MS), k = THROW_MS * (1 - f);
		this.shift(m.vx * k, m.vz * k);
		m.vx *= f;
		m.vz *= f;
		if (Math.hypot(m.vx, m.vz) * this.pxPerUnit() < THROW_STOP) {
			this.inertia = null;
		}
		return true;
	}

	/** Per frame: rotation animation, damping, the iso target kept on the ground. True when the view moved. */
	update() {
		let moved = false;
		if (this.anim) {
			const a = this.anim, now = performance.now();
			const az = this.currentAz();
			if (this.mode === "iso") {
				this.az = az;
				this.placeIso();
			} else {
				const off = a.freeOff.clone().applyAxisAngle(Y_AXIS, az - a.freeAz);
				this.free.position.copy(this.freeCtl.target).add(off);
				this.free.lookAt(this.freeCtl.target);
				this.az = az;
			}
			if (now - a.t0 >= ROTATE_MS) {
				this.anim = null;
				this.az = this.mode === "iso" ? azimuthOf(this.azK) : norm(this.az);
				if (this.mode === "iso") {
					this.placeIso();
				}
			}
			moved = true;
			this.onChange();
		}
		if (this.ctl.update()) {
			moved = true;
		}
		if (this.dragStep() || this.throwStep()) {
			moved = true;
			this.onChange();
		}
		if (this.pending) {
			const gy = this.groundAt(this.pending.x, this.pending.z);
			if (gy !== null) {
				this.moveTarget(this.pending.x, gy, this.pending.z);
				this.pending = null;
				moved = true;
			}
		}
		const t = this.target, cam = this.camera;
		// keep the target inside the map (plus a margin)
		const m = 24, b = this.bounds;
		const cx = THREE.MathUtils.clamp(t.x, b.x0 - m, b.x1 + m), cz = THREE.MathUtils.clamp(t.z, b.z0 - m, b.z1 + m);
		if (cx !== t.x || cz !== t.z) {
			cam.position.x += cx - t.x;
			cam.position.z += cz - t.z;
			t.x = cx;
			t.z = cz;
			moved = true;
		}
		if (this.mode === "iso" && !this.pending) {
			// panning moves the target across the ground plane at its height: put it back onto the terrain along the view
			// direction (in an orthographic view that does not change the picture), so rotations turn around the ground
			const gy = this.groundAt(t.x, t.z);
			if (gy !== null && Math.abs(gy - t.y) > 0.02) {
				const d = t.clone().sub(cam.position).normalize();
				const k = (gy - t.y) / d.y;
				t.addScaledVector(d, k);
				cam.position.addScaledVector(d, k);
				cam.updateMatrixWorld(true);
			}
		}
		if (this.mode === "free") {
			// depth precision: the near plane moves away with the camera (the whole map seen from far above)
			const near = THREE.MathUtils.clamp(cam.position.distanceTo(t) * 0.004, 0.3, 8);
			if (Math.abs(near - cam.near) > cam.near * 0.2) {
				cam.near = near;
				cam.updateProjectionMatrix();
			}
		}
		return moved;
	}

	/** Squares (x0, z0, x1, z1) that the view may show, for heights between yLo and yHi (world units). */
	footprint(yLo, yHi) {
		const cam = this.camera;
		cam.updateMatrixWorld(true);
		const t = this.target;
		if (this.mode === "free") {
			const r = THREE.MathUtils.clamp(cam.position.distanceTo(t) * 2.4, 3 * CHUNK / 2, 6 * CHUNK);
			return { x0: t.x - r, z0: t.z - r, x1: t.x + r, z1: t.z + r, radius: r };
		}
		const fwd = new THREE.Vector3();
		cam.getWorldDirection(fwd);
		let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
		const o = new THREE.Vector3();
		for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			o.set(nx, ny, -1).unproject(cam);
			for (const y of [yLo, yHi]) {
				const k = (y - o.y) / fwd.y;
				const px = o.x + fwd.x * k, pz = o.z + fwd.z * k;
				x0 = Math.min(x0, px);
				z0 = Math.min(z0, pz);
				x1 = Math.max(x1, px);
				z1 = Math.max(z1, pz);
			}
		}
		return { x0, z0, x1, z1, radius: Infinity };
	}

	frustum() {
		const cam = this.camera;
		cam.updateMatrixWorld(true);
		const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
		return new THREE.Frustum().setFromProjectionMatrix(m);
	}

	/** Mode, rotation and zoom, remembered per browser (not the place: the 3D view starts where the 2D map is). */
	prefs() {
		const p = { mode: this.mode, azK: this.azK, ppu: Math.round(this.ppu * 100) / 100 };
		if (this.mode === "free") {
			const off = this.free.position.clone().sub(this.freeCtl.target), d = off.length();
			p.free = { dist: Math.round(d * 10) / 10, polar: Math.acos(THREE.MathUtils.clamp(off.y / d, -1, 1)), az: this.freeAz() };
		}
		return p;
	}

	/** Applies prefs() of an earlier visit around the current target. */
	applyPrefs(p) {
		if (!p || typeof p !== "object") {
			return;
		}
		if (Number.isInteger(p.azK)) {
			this.azK = p.azK & 3;
			this.az = azimuthOf(this.azK);
		}
		if (typeof p.ppu === "number" && p.ppu > 0) {
			this.iso.zoom = THREE.MathUtils.clamp(p.ppu / BASE_PPU, this.isoCtl.minZoom, this.isoCtl.maxZoom);
		}
		this.placeIso();
		const f = p.free;
		if (p.mode === "free" && f && [f.dist, f.polar, f.az].every((v) => typeof v === "number" && isFinite(v))) {
			this.setMode("free");
			const d = THREE.MathUtils.clamp(f.dist, this.freeCtl.minDistance, this.freeCtl.maxDistance);
			const polar = THREE.MathUtils.clamp(f.polar, FREE_MIN_POLAR, FREE_MAX_POLAR);
			const t = this.freeCtl.target;
			this.free.position.set(t.x + d * Math.sin(polar) * Math.sin(f.az), t.y + d * Math.cos(polar),
				t.z + d * Math.sin(polar) * Math.cos(f.az));
			this.free.lookAt(t);
			this.freeCtl.update();
		}
		this.onChange();
	}

	/** The point the cameras look at and the free camera's place, to restore a view later. */
	state() {
		const t = this.target;
		return { mode: this.mode, azK: this.azK, x: t.x, y: t.z, h: t.y, ppu: this.ppu,
			free: this.mode === "free" ? { pos: this.free.position.toArray(), target: this.freeCtl.target.toArray() } : null };
	}

	restore(st) {
		this.azK = st.azK & 3;
		this.az = azimuthOf(this.azK);
		this.lookAt(st.x, st.y, st.ppu, st.h);
		if (st.mode === "free" && st.free) {
			this.setMode("free");
			this.freeCtl.target.fromArray(st.free.target);
			this.free.position.fromArray(st.free.pos);
			this.free.lookAt(this.freeCtl.target);
			this.freeCtl.update();
		}
	}

	info() {
		const az = this.mode === "free" && !this.anim ? this.freeAz() : this.az;
		return { mode: this.mode, azK: this.azK, azimuth: Math.round(THREE.MathUtils.radToDeg(norm(az))) % 360,
			target: [this.target.x, this.target.y, this.target.z], ppu: this.ppu,
			camera: this.camera.isOrthographicCamera ? "orthographic" : "perspective" };
	}

	dispose() {
		for (const [k, f] of Object.entries(this.onPtr)) {
			this.dom.removeEventListener(k, f);
		}
		this.isoCtl.dispose();
		this.freeCtl.dispose();
	}
}
