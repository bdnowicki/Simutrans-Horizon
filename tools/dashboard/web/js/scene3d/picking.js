// Simutrans-Horizon dashboard, 3D view: clicks and hover. A click or tap (a press that moved less than a few pixels:
// a drag pans and opens nothing) casts a ray through the pointer and marches it over the height field of what is
// shown: the square heights of the near chunks with the tops of their buildings, bridges and elevated ways
// (pickdata.js), else the far terrain. The square found becomes the selection of the 2D map ({kind, id, x, y} in
// S.ui.selection, shown by the same info card): its station, factory or town hall when the chunk says one is there
// (the game's `station x= y=` / `factory x= y=` find it from any of its squares), else the square itself. Like the 2D
// map, a vehicle under the pointer comes first: it selects its convoy and opens the convoy panel (on phones only the
// info card). A touch held longer than LONG_PRESS_MS is no tap (no selection; the browser's context menu is held off by
// the camera controls). The mouse pointer (not touch) highlights the square under it; the selected square is outlined
// too. Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { S, setUi, subscribe, factoryIndex } from "/js/store.js";
import { apiGet } from "/js/api.js";
import { openPanel } from "/js/panel.js";
import { HEIGHT_STEP } from "./config.js";
import { PICK_STATION, PICK_FACTORY, PICK_TOWNHALL, PICK_FIELDS, NO_TOP } from "./pickdata.js";

const CLICK_PX = { mouse: 5, touch: 10, pen: 8 };
const LONG_PRESS_MS = 600;
const LIFT = 0.03;
const MAX_STEPS = 6000;
const HOVER_RGB = 0xffffff;
const SELECT_RGB = 0xf03e3e;

function marker(color, fillOpacity) {
	const g = new THREE.Group();
	const lineGeo = new THREE.BufferGeometry();
	lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
	const line = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true,
		opacity: 0.95 }));
	line.renderOrder = 21;
	line.frustumCulled = false;
	const fillGeo = new THREE.BufferGeometry();
	fillGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
	fillGeo.setIndex([0, 3, 2, 0, 2, 1]);
	const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fillOpacity,
		depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
	fill.renderOrder = 20;
	fill.frustumCulled = false;
	g.add(fill, line);
	g.visible = false;
	g.userData.tile = null;
	return g;
}

export class Picker {
	/** view: {canvas, scene, rig, chunks, far, size, dirty} */
	constructor(view) {
		this.view = view;
		this.ray = new THREE.Raycaster();
		this.press = null;
		this.hoverAt = null;
		this.hoverDirty = false;
		this.seq = 0;
		this.stats = { clicks: 0, drags: 0, longPresses: 0, picks: 0, pickMs: null, lastTile: null };
		this.hover = marker(HOVER_RGB, 0.16);
		this.select = marker(SELECT_RGB, 0.26);
		this.hover.name = "hover";
		this.select.name = "selection";
		view.scene.add(this.hover, this.select);
		const c = view.canvas;
		this.on = {
			pointerdown: (e) => this.down(e),
			pointermove: (e) => this.move(e),
			pointerup: (e) => this.up(e),
			pointercancel: () => this.cancel(),
			pointerleave: () => this.leave(),
		};
		for (const [k, f] of Object.entries(this.on)) {
			c.addEventListener(k, f, { passive: true });
		}
		this.unsub = subscribe(["ui"], (_, patch) => {
			if (!patch || "selection" in patch) {
				this.placeSelection();
			}
		});
		this.selVer = -1;
	}

	// --- pointer -----------------------------------------------------------------------------------------------

	down(e) {
		if (!e.isPrimary) {
			this.press = null; // a second finger: pinch or rotate, not a tap
			return;
		}
		if (e.pointerType === "mouse" && e.button !== 0) {
			this.press = null;
			return;
		}
		this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, moved: false, t: performance.now() };
	}

	move(e) {
		const p = this.press;
		if (p && e.pointerId === p.id) {
			if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > (CLICK_PX[p.type] || 8)) {
				p.moved = true;
				this.setHover(null);
			}
			return;
		}
		if (e.pointerType === "mouse" && e.buttons === 0) {
			this.hoverAt = { x: e.clientX, y: e.clientY };
			this.hoverDirty = true;
		}
	}

	up(e) {
		const p = this.press;
		this.press = null;
		if (!p || e.pointerId !== p.id) {
			return;
		}
		if (p.moved) {
			this.stats.drags++;
			return;
		}
		if (p.type !== "mouse" && performance.now() - p.t > LONG_PRESS_MS) {
			this.stats.longPresses++;
			return;
		}
		this.stats.clicks++;
		this.click(e.clientX, e.clientY, p.type);
	}

	cancel() {
		this.press = null;
	}

	leave() {
		this.hoverAt = null;
		this.setHover(null);
	}

	/** Selects the convoy of the vehicle under the client point (x, y), else what is on the square there. */
	click(x, y, pointerType = "mouse") {
		const hit = this.tileAtClient(x, y);
		const veh = this.view.vehicles ? this.view.vehicles.pickAt(x, y, pointerType, hit) : null;
		if (veh) {
			++this.seq;
			this.stats.vehicles = (this.stats.vehicles || 0) + 1;
			setUi({ selection: { kind: "convoy", id: veh.cnv, x: veh.x, y: veh.y } });
			if (!window.matchMedia("(max-width: 720px)").matches) {
				openPanel("convoy", veh.cnv);
			}
			return Object.assign({ vehicle: veh }, hit || {});
		}
		if (!hit) {
			return null;
		}
		const seq = ++this.seq;
		this.selectionFor(hit.x, hit.y).then((sel) => {
			if (seq === this.seq && !this.view.disposed) {
				setUi({ selection: sel });
			}
		});
		return hit;
	}

	// --- ray -------------------------------------------------------------------------------------------------

	/** The square under the client point: {x, y, source: "chunk"|"far", point: [x, y, z]} or null. */
	tileAtClient(cx, cy) {
		const r = this.view.canvas.getBoundingClientRect();
		if (!r.width || !r.height) {
			return null;
		}
		const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -(((cy - r.top) / r.height) * 2 - 1));
		const cam = this.view.rig.camera;
		cam.updateMatrixWorld(true);
		this.ray.setFromCamera(ndc, cam);
		const t0 = performance.now();
		const hit = this.march(this.ray.ray);
		this.stats.picks++;
		this.stats.pickMs = Math.round((performance.now() - t0) * 100) / 100;
		this.stats.lastTile = hit ? [hit.x, hit.y, hit.source] : null;
		return hit;
	}

	/** Height of the grid point (gx, gz) as shown (a chunk's square corner, else the far terrain), in levels * step. */
	corner(gx, gz) {
		const size = this.view.size, ch = this.view.chunks;
		const tx = Math.min(gx, size.x - 1), tz = Math.min(gz, size.y - 1);
		const e = ch.shownAt(tx, tz);
		if (e && tx === gx && tz === gz) {
			return e.hgrid[(tz - e.y0) * e.w + (tx - e.x0)] * HEIGHT_STEP;
		}
		const f = this.view.far.groundAt(gx, gz);
		if (f !== null) {
			return f;
		}
		return e ? e.hgrid[(tz - e.y0) * e.w + (tx - e.x0)] * HEIGHT_STEP : null;
	}

	/** Height of the shown surface at (x, z): ground, or the top of a building/bridge on that square. */
	surface(x, z) {
		const size = this.view.size;
		if (!size || x < 0 || z < 0 || x >= size.x || z >= size.y) {
			return null;
		}
		const tx = Math.floor(x), tz = Math.floor(z);
		const e = this.view.chunks.shownAt(tx, tz);
		if (!e) {
			return this.view.far.groundAt(x, z);
		}
		const u = x - tx, v = z - tz;
		const a = this.corner(tx, tz), b = this.corner(tx + 1, tz), c = this.corner(tx, tz + 1), d = this.corner(tx + 1, tz + 1);
		const g = (a ?? 0) * (1 - u) * (1 - v) + (b ?? a ?? 0) * u * (1 - v) + (c ?? a ?? 0) * (1 - u) * v + (d ?? a ?? 0) * u * v;
		const top = e.top ? e.top[(tz - e.y0) * e.w + (tx - e.x0)] : NO_TOP;
		return Math.max(g, top);
	}

	/** First point where the ray goes below the shown surface (marched, then bisected). */
	march(ray) {
		const size = this.view.size;
		if (!size) {
			return null;
		}
		const o = ray.origin, d = ray.direction;
		const { yLo, yHi } = this.view.chunks.heightBounds();
		let t0 = 0, t1 = Infinity;
		// clip to the slab of heights and to the map
		const slab = (oo, dd, lo, hi) => {
			if (Math.abs(dd) < 1e-9) {
				return oo >= lo && oo <= hi;
			}
			let a = (lo - oo) / dd, b = (hi - oo) / dd;
			if (a > b) {
				[a, b] = [b, a];
			}
			t0 = Math.max(t0, a);
			t1 = Math.min(t1, b);
			return t0 <= t1;
		};
		if (!slab(o.y, d.y, yLo, yHi) || !slab(o.x, d.x, 0, size.x) || !slab(o.z, d.z, 0, size.y) || !isFinite(t1)) {
			return null;
		}
		const hs = Math.max(1e-3, Math.hypot(d.x, d.z));
		const at = (t) => [o.x + d.x * t, o.y + d.y * t, o.z + d.z * t];
		const below = (t) => {
			const p = at(t), s = this.surface(p[0], p[2]);
			return s !== null && p[1] <= s;
		};
		const near = this.view.rig.mode === "free" ? 0 : t0;
		let prev = t0;
		if (below(t0)) {
			return this.result(at(t0));
		}
		for (let n = 0, t = t0; n < MAX_STEPS && t < t1; n++) {
			const step = Math.max(0.2, (t - near) * 0.002) / hs;
			t = Math.min(t1, t + step);
			if (below(t)) {
				let lo = prev, hi = t;
				for (let k = 0; k < 12; k++) {
					const mid = (lo + hi) / 2;
					if (below(mid)) {
						hi = mid;
					} else {
						lo = mid;
					}
				}
				return this.result(at(hi));
			}
			prev = t;
		}
		return null;
	}

	result(p) {
		const size = this.view.size;
		const x = Math.min(size.x - 1, Math.max(0, Math.floor(p[0]))), y = Math.min(size.y - 1, Math.max(0, Math.floor(p[2])));
		return { x, y, source: this.view.chunks.shownAt(x, y) ? "chunk" : "far", point: p };
	}

	// --- what is on the square -------------------------------------------------------------------------------

	/** The entry of pickdata for square (x, y) of a shown chunk: {cls, ax, ay, sx, sy} or null. */
	pickOf(x, y) {
		const e = this.view.chunks.shownAt(x, y);
		const p = e && e.picks;
		if (!p) {
			return e ? false : null;
		}
		for (let i = 0; i < p.length; i += PICK_FIELDS) {
			if (p[i] === x && p[i + 1] === y) {
				return { cls: p[i + 2], ax: p[i + 3], ay: p[i + 4], sx: p[i + 5], sy: p[i + 6] };
			}
		}
		return false;
	}

	/**
	 * The selection the 2D map would make for this square: {kind: "station"|"factory"|"city", id, x, y} or {kind:
	 * "tile", x, y}. Without a shown chunk (far terrain) only the positions of the lists are compared.
	 */
	async selectionFor(x, y) {
		const pick = this.pickOf(x, y), far = pick === null;
		const at = (p) => p && p.x === x && p.y === y;
		if (far || (pick && pick.cls === PICK_STATION)) {
			const st = ((S.stations && S.stations.stations) || []).find((s) => at(s.pos));
			if (st) {
				return { kind: "station", id: st.id, x: st.pos.x, y: st.pos.y };
			}
			if (pick) {
				try {
					const s = (await apiGet("station", { x, y }, 1)).station;
					if (s && Number.isInteger(s.id)) {
						return { kind: "station", id: s.id, x: s.pos ? s.pos.x : x, y: s.pos ? s.pos.y : y };
					}
				} catch (e) { /* not a station after all */ }
			}
		}
		if (far || (pick && pick.cls === PICK_FACTORY)) {
			const key = pick ? pick.ax + "," + pick.ay : x + "," + y;
			const f = factoryIndex().get(key);
			if (f) {
				return { kind: "factory", id: key, x: f.pos.x, y: f.pos.y };
			}
			if (pick) {
				try {
					const p = (await apiGet("factory", { x, y, history: 0 }, 1)).factory.pos;
					return { kind: "factory", id: p.x + "," + p.y, x: p.x, y: p.y };
				} catch (e) { /* no factory here */ }
			}
		}
		if (far || (pick && pick.cls === PICK_TOWNHALL)) {
			const inside = (p) => p && (pick ? p.x >= pick.ax && p.x < pick.ax + pick.sx && p.y >= pick.ay && p.y < pick.ay + pick.sy
				: at(p));
			const c = ((S.cities && S.cities.cities) || []).find((ct) => inside(ct.townhall));
			if (c && typeof c.id === "number") {
				return { kind: "city", id: c.id, x: c.townhall.x, y: c.townhall.y };
			}
		}
		return { kind: "tile", x, y };
	}

	// --- markers ---------------------------------------------------------------------------------------------

	/** Puts a marker onto square (x, y): on the top of what stands there, else draped over the ground. */
	place(m, x, y) {
		const size = this.view.size;
		if (x === null || !size || x < 0 || y < 0 || x >= size.x || y >= size.y) {
			m.visible = false;
			m.userData.tile = null;
			return;
		}
		const e = this.view.chunks.shownAt(x, y);
		const top = e && e.top ? e.top[(y - e.y0) * e.w + (x - e.x0)] : NO_TOP;
		const cs = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]].map(([gx, gz]) => {
			const h = e ? this.corner(gx, gz) : this.view.far.groundAt(gx, gz);
			return Math.max(h ?? 0, top) + LIFT;
		});
		const fill = m.children[0].geometry.attributes.position, line = m.children[1].geometry.attributes.position;
		const pts = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
		pts.forEach(([px, pz], i) => fill.setXYZ(i, px, cs[i], pz));
		let n = 0;
		for (const inset of [0, 0.05]) {
			const q = [[x + inset, y + inset], [x + 1 - inset, y + inset], [x + 1 - inset, y + 1 - inset], [x + inset, y + 1 - inset]];
			for (let i = 0; i < 4; i++) {
				const j = (i + 1) % 4;
				line.setXYZ(n++, q[i][0], cs[i], q[i][1]);
				line.setXYZ(n++, q[j][0], cs[j], q[j][1]);
			}
		}
		fill.needsUpdate = true;
		line.needsUpdate = true;
		m.visible = true;
		m.userData.tile = [x, y];
		this.view.dirty = true;
	}

	setHover(hit) {
		const was = this.hover.visible;
		this.place(this.hover, hit ? hit.x : null, hit ? hit.y : null);
		if (was !== this.hover.visible) {
			this.view.dirty = true;
		}
	}

	placeSelection() {
		const s = S.ui.selection;
		if (s && s.kind !== "convoy" && typeof s.x === "number" && typeof s.y === "number") {
			this.place(this.select, s.x, s.y);
		} else if (this.select.visible) {
			this.place(this.select, null, null);
		}
	}

	// --- layer -----------------------------------------------------------------------------------------------

	onView() {
		if (this.hoverAt) {
			this.hoverDirty = true;
		}
	}

	update() {
		let changed = false;
		const ver = this.view.chunks.version + ":" + (this.view.far.ready ? 1 : 0);
		if (ver !== this.selVer) {
			// heights under the markers may have changed (a chunk arrived or went)
			this.selVer = ver;
			this.placeSelection();
			if (this.hover.visible && this.hover.userData.tile) {
				this.place(this.hover, ...this.hover.userData.tile);
			}
			changed = true;
		}
		if (this.hoverDirty && !this.press && this.hoverAt) {
			this.hoverDirty = false;
			const hit = this.tileAtClient(this.hoverAt.x, this.hoverAt.y);
			const cur = this.hover.userData.tile;
			if (!hit !== !cur || (hit && (hit.x !== cur[0] || hit.y !== cur[1]))) {
				this.setHover(hit);
				changed = true;
			}
		}
		return changed;
	}

	/** Client position of the centre of square (x, y) as shown (tests). */
	clientOf(x, y) {
		const s = this.surface(x + 0.5, y + 0.5);
		if (s === null) {
			return null;
		}
		const v = new THREE.Vector3(x + 0.5, s, y + 0.5).project(this.view.rig.camera);
		const r = this.view.canvas.getBoundingClientRect();
		return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height, inView: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 };
	}

	info() {
		return Object.assign({}, this.stats, { hover: this.hover.visible ? this.hover.userData.tile : null,
			selected: this.select.visible ? this.select.userData.tile : null });
	}

	dispose() {
		for (const [k, f] of Object.entries(this.on)) {
			this.view.canvas.removeEventListener(k, f);
		}
		this.unsub();
		for (const m of [this.hover, this.select]) {
			m.removeFromParent();
			for (const o of m.children) {
				o.geometry.dispose();
				o.material.dispose();
			}
		}
	}
}
