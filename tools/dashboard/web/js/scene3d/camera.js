// Simutrans-Horizon dashboard, 3D view: the cameras. Isometric (orthographic, 30 degrees elevation, azimuth
// 45 + k * 90 degrees, four rotations like the game) and free (perspective + MapControls); drag pans, wheel and
// pinch zoom around the target point (the centre of the view), rotations turn around it (in the free camera to the
// next of the four iso directions). Both can zoom out to the whole map. Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { MapControls } from "/vendor/three/addons/controls/MapControls.js";
import { ELEVATION, BASE_PPU, MAX_PPU, ISO_DIST, CHUNK, azimuthOf } from "./config.js";

const FREE_FOV = 50;
const FREE_ELEVATION = THREE.MathUtils.degToRad(40);
const FREE_MIN_POLAR = 0.05;
const FREE_MAX_POLAR = THREE.MathUtils.degToRad(84);
const ROTATE_MS = 240;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function dirFor(az, el) {
	return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

export class CameraRig {
	/** opts: {onChange(), groundAt(x, z) -> world y of the ground (or null)} */
	constructor(dom, opts = {}) {
		this.dom = dom;
		this.onChange = opts.onChange || (() => {});
		this.groundAt = opts.groundAt || (() => null);
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
	}

	controls(cam, iso) {
		const c = new MapControls(cam, this.dom);
		c.enableDamping = true;
		c.dampingFactor = 0.2;
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
		this.onChange();
	}

	/** Azimuth of the free camera around its target. */
	freeAz() {
		return norm(Math.atan2(this.free.position.x - this.freeCtl.target.x, this.free.position.z - this.freeCtl.target.z));
	}

	/** Turn around the target: dir +1 or -1. Iso: by 90 degrees; free: to the next of the four iso directions. */
	rotate(dir) {
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
		this.isoCtl.dispose();
		this.freeCtl.dispose();
	}
}
