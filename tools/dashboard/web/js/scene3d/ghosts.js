// Simutrans-Horizon dashboard, 3D view: the ghosts of a planned project of the AI team. S.ui.preview3d ({id, title,
// preview: {bbox, items: [{kind, tiles: [[x, y, z], ...]}]}}) is drawn as semi-transparent boxes on its squares (like
// the markers of picking.js: transparent, no depth writes, drawn after the scene): flat slabs for ways, bridges, tunnels
// and way objects, blocks for stations and depots, posts for signs, red blocks for removals, small blocks for the stops
// of a line (joined by a line) and for convoys at their depot. The preview lives in S.ui, so a view built anew (the 3D tab
// is built at every visit) shows it again; the boxes follow the ground when chunks arrive. Colours: the CSS tokens
// --plan-* of the 2D plan. Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { S, subscribe } from "/js/store.js";
import { HEIGHT_STEP } from "./config.js";

const MAX_BOXES = 20000;
const LIFT = 0.04;
const OPACITY = 0.5;
// height (world units) and inset (part of the square left free on each side) of the boxes per kind
const SHAPE = {
	way: [0.14, 0.1], bridge: [0.18, 0.08], tunnel: [0.1, 0.2], wayobj: [0.5, 0.42], station: [0.9, 0.06],
	depot: [0.8, 0.1], roadsign: [0.7, 0.42], remove: [0.55, 0.04], line: [0.35, 0.3], convoy: [0.45, 0.26],
};
const TOKENS = {
	way: ["--plan-way", "#1c7ed6"], bridge: ["--plan-bridge", "#7048e8"], tunnel: ["--plan-tunnel", "#495057"],
	wayobj: ["--plan-wayobj", "#0c8599"], station: ["--plan-station", "#e8590c"], depot: ["--plan-depot", "#2b8a3e"],
	roadsign: ["--plan-sign", "#f59f00"], remove: ["--plan-remove", "#e03131"], line: ["--plan-line", "#ae3ec9"],
	convoy: ["--plan-convoy", "#1098ad"],
};

function cssColor(token, fallback) {
	const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
	try {
		return new THREE.Color(v || fallback);
	} catch (e) {
		return new THREE.Color(fallback);
	}
}

export class GhostLayer {
	constructor(view) {
		this.view = view;
		this.group = new THREE.Group();
		this.group.name = "plan-ghosts";
		view.scene.add(this.group);
		this.box = new THREE.BoxGeometry(1, 1, 1);
		this.box.translate(0, 0.5, 0); // the bottom at y = 0
		this.materials = new Map();
		this.objects = [];
		this.version = null;
		this.dirty = true;
		this.stats = { id: null, items: 0, boxes: 0, kinds: {}, lines: 0, builds: 0 };
		this.unsub = subscribe(["ui"], (_, patch) => {
			if (!patch || "preview3d" in patch) {
				this.dirty = true;
				this.view.dirty = true;
			}
		});
		this.unsubTheme = subscribe(["theme"], () => {
			for (const [kind, m] of this.materials) {
				const [token, fb] = TOKENS[kind] || TOKENS.way;
				m.color.copy(cssColor(token, fb));
			}
			this.view.dirty = true;
		});
	}

	material(kind, line = false) {
		const key = line ? kind + ":line" : kind;
		let m = this.materials.get(key);
		if (!m) {
			const [token, fb] = TOKENS[kind] || TOKENS.way;
			const opts = { color: cssColor(token, fb), transparent: true, opacity: line ? 0.9 : OPACITY, depthWrite: false };
			m = line ? new THREE.LineBasicMaterial(opts) : new THREE.MeshBasicMaterial(opts);
			this.materials.set(key, m);
		}
		return m;
	}

	/** World height for a ghost on square (x, y): the shown ground, a bridge's own height when it is higher. */
	height(x, y, z, kind) {
		const v = this.view;
		let g = v.chunks.groundAt(x + 0.5, y + 0.5);
		if (g === null && v.far) {
			g = v.far.groundAt(x + 0.5, y + 0.5);
		}
		const own = typeof z === "number" ? z * HEIGHT_STEP : null;
		if (g === null || g === undefined) {
			return own ?? 0;
		}
		return kind === "bridge" && own !== null ? Math.max(g, own) : g;
	}

	clear() {
		for (const o of this.objects) {
			o.removeFromParent();
			if (o.isLine) {
				o.geometry.dispose();
			} else if (o.isInstancedMesh) {
				o.dispose();
			}
		}
		this.objects = [];
	}

	build() {
		this.clear();
		const p = S.ui.preview3d;
		const items = p && p.preview && Array.isArray(p.preview.items) ? p.preview.items : [];
		const size = this.view.size;
		const byKind = new Map();
		const lines = [];
		let boxes = 0;
		for (const it of items) {
			const kind = it && SHAPE[it.kind] ? it.kind : "way";
			const tiles = (Array.isArray(it && it.tiles) ? it.tiles : []).filter((t) => Array.isArray(t)
				&& Number.isFinite(t[0]) && Number.isFinite(t[1]) && (!size || (t[0] >= 0 && t[1] >= 0 && t[0] < size.x && t[1] < size.y)));
			let list = byKind.get(kind);
			if (!list) {
				list = [];
				byKind.set(kind, list);
			}
			for (const t of tiles) {
				if (boxes >= MAX_BOXES) {
					break;
				}
				list.push(t);
				boxes++;
			}
			if (kind === "line" && tiles.length > 1) {
				lines.push(tiles);
			}
		}
		const mtx = new THREE.Matrix4(), pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
		const kinds = {};
		for (const [kind, list] of byKind) {
			if (!list.length) {
				continue;
			}
			const [h, inset] = SHAPE[kind];
			const mesh = new THREE.InstancedMesh(this.box, this.material(kind), list.length);
			list.forEach((t, k) => {
				pos.set(t[0] + 0.5, this.height(t[0], t[1], t[2], kind) + LIFT, t[1] + 0.5);
				scl.set(1 - 2 * inset, h, 1 - 2 * inset);
				mtx.compose(pos, quat, scl);
				mesh.setMatrixAt(k, mtx);
			});
			mesh.instanceMatrix.needsUpdate = true;
			mesh.renderOrder = 20;
			mesh.frustumCulled = false;
			mesh.userData.layer = "plan-ghosts";
			mesh.name = "ghost-" + kind;
			this.group.add(mesh);
			this.objects.push(mesh);
			kinds[kind] = list.length;
		}
		for (const tiles of lines) {
			const pts = tiles.map((t) => new THREE.Vector3(t[0] + 0.5, this.height(t[0], t[1], t[2], "line") + SHAPE.line[0] + 0.6, t[1] + 0.5));
			const geo = new THREE.BufferGeometry().setFromPoints(pts);
			const line = new THREE.Line(geo, this.material("line", true));
			line.renderOrder = 21;
			line.frustumCulled = false;
			line.name = "ghost-line-path";
			this.group.add(line);
			this.objects.push(line);
		}
		this.stats = { id: p ? p.id : null, items: items.length, boxes, kinds, lines: lines.length, builds: this.stats.builds + 1 };
	}

	onView() {}

	update() {
		const ver = this.view.chunks.version + ":" + (this.view.far && this.view.far.ready ? 1 : 0);
		if (ver !== this.version) {
			// heights under the ghosts may have changed (a chunk arrived or went)
			this.version = ver;
			if (S.ui.preview3d) {
				this.dirty = true;
			}
		}
		if (!this.dirty) {
			return false;
		}
		this.dirty = false;
		this.build();
		return true;
	}

	info() {
		return Object.assign({}, this.stats, { visible: this.group.visible, objects: this.objects.length });
	}

	dispose() {
		this.unsub();
		this.unsubTheme();
		this.clear();
		this.group.removeFromParent();
		this.box.dispose();
		for (const m of this.materials.values()) {
			m.dispose();
		}
		this.materials.clear();
	}
}
