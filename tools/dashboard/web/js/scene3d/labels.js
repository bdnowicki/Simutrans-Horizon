// Simutrans-Horizon dashboard, 3D view: names of the cities (at their town halls) and, when zoomed in, of the stations
// over the view (CSS2DRenderer). A fixed pool of label elements is placed only when the camera, the data or the
// loaded ground changed: largest cities first, then the stations with most waiting, each where it does not overlap a
// label already placed (box from the length of the name), the rest hidden. Names are text nodes (textContent).
// Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { CSS2DRenderer, CSS2DObject } from "/vendor/three/addons/renderers/CSS2DRenderer.js";
import { S, subscribe } from "/js/store.js";

const CITY_MAX = 48;
const STATION_MAX = 80;
const STATION_PPU = 28; // stations from this many pixels per square
const CITY_H = 1.6, STATION_H = 0.55; // label height above the ground (squares)
const GAP = 3; // pixels around a city label
const STATION_GAP = [14, 9]; // pixels around a station label (sideways, up and down): fewer, calmer labels

export class LabelLayer {
	/** view: {scene, rig, chunks, far, container, quality}; enabled: shown at the start. */
	constructor(view, enabled) {
		this.view = view;
		this.enabled = !!enabled;
		this.css = new CSS2DRenderer();
		this.css.sortObjects = false;
		const el = this.css.domElement;
		el.className = "v3d-labels";
		el.setAttribute("aria-hidden", "true");
		el.style.display = this.enabled ? "" : "none";
		view.container.appendChild(el);
		this.scene = new THREE.Scene();
		this.pool = [];
		for (let i = 0; i < CITY_MAX + STATION_MAX; i++) {
			const div = document.createElement("div");
			div.className = "v3d-label";
			const o = new CSS2DObject(div);
			o.center.set(0.5, 1);
			o.visible = false;
			o.userData.key = null;
			o.userData.text = null;
			this.scene.add(o);
			this.pool.push(o);
		}
		this.entries = [];
		this.dirty = true;
		this.dataDirty = true;
		this.version = -1;
		this.shown = { cities: 0, stations: 0 };
		this.stats = { places: 0, ms: 0 };
		this.unsub = subscribe(["cities", "stations"], () => {
			this.dataDirty = true;
			this.dirty = true;
			this.view.dirty = true;
		});
		this.v = new THREE.Vector3();
	}

	setEnabled(on) {
		this.enabled = !!on;
		this.css.domElement.style.display = this.enabled ? "" : "none";
		this.dirty = true;
		this.view.dirty = true;
	}

	setSize(w, h) {
		this.css.setSize(w, h);
		this.dirty = true;
	}

	onView() {
		this.dirty = true;
	}

	/** The cities and stations with a place and a name, by priority. */
	collect() {
		this.dataDirty = false;
		const out = [];
		const cities = (S.cities && S.cities.cities) || [];
		const cs = cities.filter((c) => c && c.townhall && typeof c.townhall.x === "number" && c.name)
			.sort((a, b) => (b.citizens || 0) - (a.citizens || 0));
		for (const c of cs) {
			out.push({ key: "c" + (c.id ?? c.name), kind: 0, name: String(c.name), x: c.townhall.x + 1, z: c.townhall.y + 1,
				big: (c.citizens || 0) > 50000 });
		}
		const stations = (S.stations && S.stations.stations) || [];
		const ss = stations.filter((s) => s && s.pos && typeof s.pos.x === "number" && s.name)
			.sort((a, b) => ((b.waiting && b.waiting.total) || 0) - ((a.waiting && a.waiting.total) || 0));
		for (const s of ss) {
			out.push({ key: "s" + s.id, kind: 1, name: String(s.name), x: s.pos.x + 0.5, z: s.pos.y + 0.5 });
		}
		this.entries = out;
	}

	/** Called by the view before a frame is drawn; places the labels when something changed. */
	update() {
		const chunks = this.view.chunks;
		if (chunks.version !== this.version) {
			this.version = chunks.version;
			this.dirty = true;
		}
		return false;
	}

	/** Places and draws the labels (after the WebGL frame, with its camera) when needed. */
	render() {
		if (!this.enabled || !this.dirty) {
			return;
		}
		const t0 = performance.now();
		this.dirty = false;
		if (this.dataDirty) {
			this.collect();
		}
		const view = this.view, rig = view.rig, cam = rig.camera;
		const w = view.container.clientWidth, h = view.container.clientHeight;
		cam.updateMatrixWorld(true);
		const iso = rig.mode === "iso", focal = iso ? 0 : rig.focal(), eye = cam.position;
		const ground = (x, z) => view.chunks.groundAt(x, z) ?? (view.far ? view.far.groundAt(x, z) : null) ?? 0;
		const boxes = [];
		const want = new Map(); // key -> [x, y, z, entry]
		let nc = 0, ns = 0;
		const v = this.v;
		const noStations = iso && rig.ppu < STATION_PPU;
		for (const e of this.entries) {
			if (e.kind === 1 && (ns >= STATION_MAX || noStations)) {
				break; // the stations come after all cities
			}
			if (e.kind === 0 && nc >= CITY_MAX) {
				continue;
			}
			const gy = ground(e.x, e.z) + (e.kind === 0 ? CITY_H : STATION_H);
			if (e.kind === 1) {
				const ppu = iso ? rig.ppu : focal / Math.max(1, Math.hypot(e.x - eye.x, gy - eye.y, e.z - eye.z));
				if (ppu < STATION_PPU) {
					continue;
				}
			}
			v.set(e.x, gy, e.z).project(cam);
			if (v.z < -1 || v.z > 1 || Math.abs(v.x) > 1.02 || Math.abs(v.y) > 1.05) {
				continue;
			}
			const sx = (v.x + 1) * w / 2, sy = (1 - v.y) * h / 2;
			const fw = e.kind === 0 ? (e.big ? 8.6 : 7.6) : 6.3, bw = Math.min(260, e.name.length * fw + 12), bh = e.kind === 0 ? 20 : 17;
			const mx = e.kind === 0 ? GAP : STATION_GAP[0], my = e.kind === 0 ? GAP : STATION_GAP[1];
			const b = [sx - bw / 2 - mx, sy - bh - my, sx + bw / 2 + mx, sy + my];
			let free = true;
			for (const o of boxes) {
				if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) {
					free = false;
					break;
				}
			}
			if (!free) {
				continue;
			}
			boxes.push(b);
			want.set(e.key, [e.x, gy, e.z, e]);
			if (e.kind === 0) {
				nc++;
			} else {
				ns++;
			}
		}
		// keep the elements of labels that stay, give the free ones to the new labels
		const freeObjs = [];
		for (const o of this.pool) {
			const k = o.userData.key;
			const p = k !== null ? want.get(k) : undefined;
			if (p) {
				o.position.set(p[0], p[1], p[2]);
				o.visible = true;
				want.delete(k);
			} else {
				o.visible = false;
				o.userData.key = null;
				freeObjs.push(o);
			}
		}
		for (const [k, p] of want) {
			const o = freeObjs.pop();
			if (!o) {
				break;
			}
			const e = p[3];
			o.userData.key = k;
			if (o.userData.text !== e.name) {
				o.element.textContent = e.name;
				o.userData.text = e.name;
			}
			o.element.className = e.kind === 0 ? (e.big ? "v3d-label v3d-label-city big" : "v3d-label v3d-label-city") : "v3d-label v3d-label-station";
			o.position.set(p[0], p[1], p[2]);
			o.visible = true;
		}
		this.scene.updateMatrixWorld(true);
		this.css.render(this.scene, cam);
		this.shown = { cities: nc, stations: ns };
		this.stats.places++;
		this.stats.ms = Math.round((performance.now() - t0) * 100) / 100;
	}

	info() {
		const el = this.css.domElement;
		return { enabled: this.enabled, cities: this.shown.cities, stations: this.shown.stations, entries: this.entries.length,
			pool: this.pool.length, elements: el.querySelectorAll(".v3d-label").length,
			visible: [...el.querySelectorAll(".v3d-label")].filter((d) => d.style.display !== "none").map((d) => d.textContent).slice(0, 40),
			places: this.stats.places, ms: this.stats.ms };
	}

	dispose() {
		this.unsub();
		this.scene.clear(); // CSS2DObject removes its element when removed
		this.css.domElement.remove();
		this.pool = [];
	}
}
