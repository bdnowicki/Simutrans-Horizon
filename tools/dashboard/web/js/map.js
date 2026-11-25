// Simutrans-Horizon dashboard: the live map (Leaflet, CRS.Simple, top-down, 1 unit = 1 map tile, y down).
// Artistic License, see LICENSE.txt.
import { S, subscribe, setUi, emit, perf, toast, stationIndex, cityIndex } from "/js/store.js";
import { Terrain, createTerrainLayer } from "/js/terrain.js";
import { createMinimapLayer, TileVersions, MODES, STATS_MODES } from "/js/minimap.js";
import { createOverlay } from "/js/overlay.js";
import { ownerColor, lineColor, stateColor, isProblem } from "/js/colors.js";
import { lineRoute } from "/js/data.js";
import { supplyLinks } from "/js/supply.js";
import { apiGet } from "/js/api.js";
import { t } from "/js/i18n.js";

const MAX_ZOOM = 5;
const DETAIL_ZOOM = 2.5; // from here on the terrain map is drawn in detail from map grids (over the tiles)
const LABELS_GAP = 15000; // ms between two loads of the map markers after map changes
const PULSE_MS = 900; // length of the arrival pulse of a stop
const MAX_PULSES = 500;

export function isDark() {
	const th = document.documentElement.dataset.theme;
	if (th === "dark") {
		return true;
	}
	if (th === "light") {
		return false;
	}
	return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

const toLatLng = (x, y) => L.latLng(-(y + 0.5), x + 0.5);

function convoyRadius(zoom) {
	return zoom <= -2 ? 1.8 : zoom <= -1 ? 2.2 : zoom <= 0 ? 2.8 : zoom <= 1 ? 3.3 : zoom <= 2 ? 4 : zoom <= 3 ? 5 : zoom <= 4 ? 6 : 7.5;
}

function stationSize(zoom, s) {
	return zoom <= -0.5 ? 2 : zoom <= 0 ? 3 : zoom <= 1 ? 4 : zoom <= 2 ? 5 : Math.min(14, Math.max(7, s * 0.7));
}

class MapController {
	constructor() {
		this.map = null;
		this.terrain = new Terrain();
		this.route = null; // route of the highlighted line, see lineRoute() in data.js
		this.routeReq = 0;
		this.routeTimer = null;
		this.convoyLeg = null; // leg the convoy of the open convoy panel drives: {id, points, ...}
		this.marker = null;
		this.sizeKey = null;
		this.visible = true;
		this.dirty = false;
		// true: base map from the minimap tiles of the game, false: from map grids only (older engines),
		// null: not known yet (no base map)
		this.mapExport = null;
		this.versions = new TileVersions();
		this.tiles = null;
		this.detail = null; // GridLayer from map grids: all zooms (older engines) or the zoomed in terrain map
		this.detailZoom = undefined;
		this.tileErrors = 0;
		this.gameLabels = null; // markers from `labels` (Map "x,y" -> label)
		this.labelsAt = 0;
		this.labelsTimer = null;
		this.pulses = new Map(); // halt id -> start of its arrival pulse
		this.pulseReq = 0;
		this.pulseLast = 0;
		this.lastCenter = null; // Leaflet LatLng of the map centre while it was last visible
	}

	mount(el) {
		if (this.map) {
			return;
		}
		const map = L.map(el, {
			crs: L.CRS.Simple, minZoom: -4, maxZoom: MAX_ZOOM, zoomSnap: 0.5, zoomDelta: 1, attributionControl: false,
			wheelPxPerZoomLevel: 90, maxBoundsViscosity: 0.8, zoomControl: true, tapTolerance: 12,
			fadeAnimation: true, inertia: true,
		});
		this.map = map;
		map.createPane("features").style.zIndex = 410;
		map.createPane("convoys").style.zIndex = 420;
		map.createPane("labels").style.zIndex = 430;
		this.tiles = createMinimapLayer(this.versions, () => this.mode());
		this.tiles.on("tileerror", () => {
			this.tileErrors++;
			emit("terrain");
		});
		this.tiles.on("tileload", () => {
			if (this.tileErrors) {
				this.tileErrors = 0;
				emit("terrain");
			}
		});
		this.tiles.on("load", () => {
			if (perf.mapFirstLoad === undefined) {
				perf.mapFirstLoad = performance.now();
			}
		});
		this.features = createOverlay((ctx, v) => this.drawFeatures(ctx, v), { pane: "features" }).addTo(map);
		this.pulseLayer = createOverlay((ctx, v) => this.drawPulses(ctx, v), { pane: "features" }).addTo(map);
		this.convoys = createOverlay((ctx, v) => this.drawConvoys(ctx, v), { pane: "convoys" }).addTo(map);
		this.labels = createOverlay((ctx, v) => this.drawLabels(ctx, v), { pane: "labels" }).addTo(map);
		map.setView([-512, 512], -1);
		map.on("click", (e) => this.onClick(e));
		// the centre while the map is shown (a hidden map has no size; the 3D view starts here)
		map.on("moveend", () => {
			const s = map.getSize();
			if (s.x > 0 && s.y > 0) {
				this.lastCenter = map.getCenter();
			}
		});
		this.terrain.on((what, arg) => {
			if (what === "region") {
				if (this.detail) {
					this.detail.refreshRegion(arg);
				}
				if (!this.mapExport && this.terrain.labels.size) {
					this.redrawStatic();
				}
			}
			if (what === "status" || what === "error" || what === "reset") {
				emit("terrain");
			}
		});
		subscribe(["positions"], () => this.redrawConvoys());
		subscribe(["stations", "factories", "cities", "supply_chain", "goods"], () => this.redrawStatic());
		subscribe(["ui"], (_, patch) => this.onUi(patch || {}));
		subscribe(["world"], (_, arg) => this.onWorld(arg || {}));
		subscribe(["month"], () => this.onMonth());
		subscribe(["palette", "game", "session"], (topic) => {
			this.updateBase();
			if (topic === "palette") {
				this.redrawAll(); // player colours
			}
		});
		subscribe(["map_changes"], (_, d) => this.onMapChanges(d || {}));
		subscribe(["arrivals"], () => this.onArrivals());
		subscribe(["theme"], () => this.redrawAll());
		subscribe(["session"], () => {
			if (S.ui.highlightLine && (!this.route || this.route.fallback)) {
				this.loadRoute(S.ui.highlightLine, true); // highlighted before the bridge said what it allows
			}
		});
		subscribe(["schedules"], () => {
			if (S.ui.highlightLine) {
				this.loadRoute(S.ui.highlightLine, true); // the bridge dropped the legs it had merged
			}
		});
		this.updateBase();
		this.onWorld({ reset: true });
	}

	/** Mode of the base map (the game's minimap modes). */
	mode() {
		return MODES.includes(S.ui.mapMode) ? S.ui.mapMode : "terrain";
	}

	exportState() {
		const read = S.session && S.session.allowed && S.session.allowed.read;
		if (Array.isArray(read) && !read.includes("minimap")) {
			return false; // older bridge
		}
		if (S.game && Array.isArray(S.game.missing) && S.game.missing.includes("map_export")) {
			return false; // older engine
		}
		if (Array.isArray(read) && S.palette && Array.isArray(S.palette.colors)) {
			return true;
		}
		return this.mapExport; // not known (e.g. between a world event and the snapshot): keep
	}

	/** Base layers for the engine and the map mode: minimap tiles and/or the detailed map from map grids. */
	updateBase() {
		if (!this.map) {
			return;
		}
		const state = this.exportState();
		const changed = state !== this.mapExport;
		this.mapExport = state;
		const detailZoom = state === false ? -8 : state === true && this.mode() === "terrain" ? DETAIL_ZOOM : null;
		if (detailZoom !== this.detailZoom) {
			if (this.detail) {
				this.detail.remove();
				this.detail = null;
			}
			this.detailZoom = detailZoom;
			if (detailZoom !== null) {
				this.detail = createTerrainLayer(this.terrain, { minZoom: detailZoom }).addTo(this.map);
			}
		}
		const tilesOn = this.map.hasLayer(this.tiles);
		if (state === true && !tilesOn) {
			this.tiles.addTo(this.map);
		} else if (state !== true && tilesOn) {
			this.tiles.remove();
		}
		if (changed) {
			emit("map_export");
			this.redrawStatic();
			if (state) {
				this.loadLabels(true);
			}
		}
	}

	onMonth() {
		if (this.mapExport === true) {
			// the statistics modes follow the monthly numbers; the rest comes with map_changes
			if (STATS_MODES.has(this.mode())) {
				this.versions.newMonth();
				this.tiles.refreshTiles(null);
			}
		} else if (this.detail) {
			this.terrain.markStale();
			this.detail.refreshVisible();
		}
	}

	/** SSE map_changes: load the changed chunks again (tiles and the detailed regions in view). */
	onMapChanges(d) {
		if (this.mapExport !== true) {
			return;
		}
		const chunks = Array.isArray(d.chunks) ? d.chunks.filter((c) => Array.isArray(c) && c.length === 2) : [];
		if (d.full) {
			this.versions.reset();
			this.tiles.refreshTiles(null);
			this.terrain.markStale();
		} else if (chunks.length) {
			this.versions.bump(chunks);
			this.tiles.refreshTiles(chunks);
			this.terrain.markChunksStale(chunks);
		} else {
			return;
		}
		if (this.detail) {
			this.detail.requestStale();
		}
		perf.mapChanges = (perf.mapChanges || 0) + 1;
		this.loadLabels(false);
	}

	canRead(cmd) {
		const read = S.session && S.session.allowed && S.session.allowed.read;
		return Array.isArray(read) && read.includes(cmd);
	}

	/** Map markers from `labels` (with the map export); at most every LABELS_GAP ms unless forced. */
	async loadLabels(force) {
		if (this.mapExport !== true || !this.canRead("labels") || !S.ui.layers.labels || !S.worldKey) {
			return;
		}
		const wait = this.labelsAt + LABELS_GAP - Date.now();
		if (!force && wait > 0) {
			if (!this.labelsTimer) {
				this.labelsTimer = setTimeout(() => {
					this.labelsTimer = null;
					this.loadLabels(true);
				}, wait);
			}
			return;
		}
		this.labelsAt = Date.now();
		const key = S.worldKey;
		try {
			const r = await apiGet("labels");
			if (key !== S.worldKey) {
				return;
			}
			const m = new Map();
			for (const l of r.labels || []) {
				if (l && l.pos && typeof l.pos.x === "number") {
					m.set(l.pos.x + "," + l.pos.y, l);
				}
			}
			this.gameLabels = m;
			this.redrawStatic();
		} catch (e) { /* the map works without markers */ }
	}

	labelList() {
		return this.mapExport === true ? this.gameLabels || new Map() : this.terrain.labels;
	}

	// --- arrival pulses of stops (SSE arrivals, at most one per second) -----------------------

	onArrivals() {
		const map = this.map;
		if (!map || !this.visible || !S.ui.layers.stations || document.hidden || map.getZoom() < -1) {
			return;
		}
		const now = performance.now();
		let n = 0;
		for (const id of S.arrivals.halts) {
			this.pulses.set(id, now);
			if (++n >= MAX_PULSES) {
				break;
			}
		}
		if (n && !this.pulseReq) {
			this.pulseReq = requestAnimationFrame((ts) => this.pulseFrame(ts));
		}
	}

	pulseFrame(ts) {
		this.pulseReq = 0;
		const now = performance.now();
		for (const [id, t0] of this.pulses) {
			if (now - t0 > PULSE_MS) {
				this.pulses.delete(id);
			}
		}
		if (ts - this.pulseLast >= 33 || !this.pulses.size) { // about 30 frames per second
			this.pulseLast = ts;
			this.pulseLayer.redraw();
		}
		if (this.pulses.size) {
			this.pulseReq = requestAnimationFrame((t2) => this.pulseFrame(t2));
		}
	}

	drawPulses(ctx, v) {
		if (!this.pulses.size || !S.ui.layers.stations) {
			return;
		}
		const idx = stationIndex().map;
		const now = performance.now();
		const r0 = stationSize(v.zoom, v.s) / 2 + 3;
		ctx.lineWidth = 2;
		for (const [id, t0] of this.pulses) {
			const st = idx.get(id), p = st && st.pos;
			if (!p || p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) {
				continue;
			}
			const f = Math.min(1, (now - t0) / PULSE_MS);
			const [px, py] = v.toPx(p.x, p.y);
			ctx.globalAlpha = 0.9 * (1 - f);
			ctx.strokeStyle = ownerColor(st.owner);
			ctx.beginPath();
			ctx.arc(px, py, r0 + f * 11, 0, 6.2832);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
	}

	/** The map tab is hidden: skip redraws until it is shown again. */
	setVisible(visible) {
		this.visible = visible;
		if (visible && this.dirty) {
			this.dirty = false;
			this.redrawAll();
		}
	}

	redrawStatic() {
		if (!this.visible) {
			this.dirty = true;
			return;
		}
		this.features.redraw();
		this.labels.redraw();
	}

	redrawConvoys() {
		if (!this.visible) {
			this.dirty = true;
			return;
		}
		this.convoys.redraw();
	}

	redrawAll() {
		this.redrawStatic();
		this.redrawConvoys();
	}

	onWorld(arg) {
		const w = S.poll && S.poll.world;
		if (!this.map || !w || !w.size_x) {
			if (arg.reset) {
				this.route = null;
				this.convoyLeg = null;
				this.clearMarker();
			}
			return;
		}
		const changed = this.terrain.reset(S.worldKey, w.size_x, w.size_y);
		if (changed) {
			this.route = null;
			this.convoyLeg = null;
			this.clearMarker();
			const bounds = L.latLngBounds([[-w.size_y, 0], [0, w.size_x]]);
			const sizeKey = w.size_x + "x" + w.size_y;
			if (sizeKey !== this.sizeKey) {
				this.sizeKey = sizeKey;
				this.fit();
			}
			this.map.setMaxBounds(bounds.pad(0.3));
			this.versions.reset();
			this.gameLabels = null;
			this.tiles.options.bounds = bounds; // no tile requests beyond the map
			if (this.map.hasLayer(this.tiles)) {
				this.tiles.redraw();
			}
			if (this.detail) {
				this.detail.redraw();
			}
			this.loadLabels(true);
		} else if (!arg.reset) {
			// a new snapshot of the same world (reconnect): changes may have been missed
			this.terrain.markStale();
			if (this.detail) {
				this.detail.refreshVisible();
			}
			this.versions.reset();
			this.tiles.refreshTiles(null);
			this.loadLabels(true);
		}
		this.redrawAll();
	}

	fit() {
		const w = S.poll && S.poll.world;
		if (!this.map || !w) {
			return;
		}
		const bounds = L.latLngBounds([[-w.size_y, 0], [0, w.size_x]]);
		// Without the max bounds while fitting: a running pan ends inside fitBounds, its moveend
		// pans into the max bounds and that starts a zoom animation to the old zoom.
		const maxBounds = this.map.options.maxBounds;
		this.map.setMaxBounds(null);
		this.map.stop();
		const z = this.map.getBoundsZoom(bounds, false);
		// not setMinZoom(): it may start a zoom animation as well
		this.map.options.minZoom = Math.min(z - 1, 0);
		this.map.fitBounds(bounds, { animate: false });
		this.map.fire("zoomlevelschange");
		if (maxBounds) {
			this.map.setMaxBounds(maxBounds);
		}
	}

	onUi(patch) {
		if ("highlightLine" in patch) {
			this.loadRoute(S.ui.highlightLine);
		}
		if ("mapMode" in patch) {
			this.updateBase();
			this.tiles.refreshTiles(null);
		}
		if ("layers" in patch && S.ui.layers.labels && !this.gameLabels) {
			this.loadLabels(true);
		}
		if ("layers" in patch || "colorMode" in patch || "highlightLine" in patch || "selection" in patch || "panel" in patch) {
			this.redrawAll();
		}
	}

	/**
	 * Load the route of the highlighted line; while it stays highlighted it is loaded again (the bridge
	 * merges further legs as the convoys drive them): every 15 s while legs are missing, else every 60 s.
	 */
	async loadRoute(id, quiet = false) {
		const req = ++this.routeReq;
		clearTimeout(this.routeTimer);
		this.routeTimer = null;
		if (!id) {
			this.route = null;
			this.redrawStatic();
			emit("route");
			return;
		}
		if (this.route && this.route.id !== id) {
			this.route = null;
			this.redrawStatic();
		}
		try {
			const r = await lineRoute(id);
			if (req !== this.routeReq || S.ui.highlightLine !== id) {
				return;
			}
			this.route = r;
			this.redrawStatic();
			emit("route");
		} catch (e) {
			if (req !== this.routeReq) {
				return;
			}
			if (!quiet) {
				toast(t("load_failed", e.message));
			}
		}
		const r = this.route;
		if (r && r.id === id && !r.fallback) {
			const again = () => {
				if (req !== this.routeReq || S.ui.highlightLine !== id) {
					return;
				}
				if (document.hidden) {
					this.routeTimer = setTimeout(again, 5000);
				} else {
					this.loadRoute(id, true);
				}
			};
			this.routeTimer = setTimeout(again, r.complete ? 60000 : 15000);
		}
	}

	/** Leg of the convoy whose panel is open (drawn above the line route), or null. */
	setConvoyLeg(leg) {
		this.convoyLeg = leg;
		this.redrawStatic();
	}

	strokePath(ctx, v, pts) {
		ctx.beginPath();
		pts.forEach(([x, y], i) => {
			const [px, py] = v.toPx(x, y);
			if (i === 0) {
				ctx.moveTo(px, py);
			} else {
				ctx.lineTo(px, py);
			}
		});
		ctx.stroke();
	}

	fitRoute() {
		const r = this.route;
		if (!r || !r.stops.length || !this.map) {
			return;
		}
		const b = L.latLngBounds(r.stops.map((p) => toLatLng(p.x, p.y)));
		this.map.fitBounds(b.pad(0.15), { maxZoom: 4 });
	}

	/** Fit the map to a box of tiles (inclusive corners). */
	fitBox(x1, y1, x2, y2, maxZoom = 3) {
		if (!this.map) {
			return;
		}
		this.invalidate();
		const b = L.latLngBounds([toLatLng(x1, y1), toLatLng(x2, y2)]);
		this.map.fitBounds(b.pad(0.12), { maxZoom });
	}

	/** Fit the map to tiles [{x, y}]. */
	fitPoints(points, maxZoom = 3) {
		const ps = points.filter((p) => p && typeof p.x === "number");
		if (!ps.length) {
			return;
		}
		const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
		this.fitBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), maxZoom);
	}

	/** Factory ("x,y") whose supply links are emphasised: an open factory panel, else the selected
	 * factory while the supply layer is on. */
	supplyFocus() {
		const p = S.ui.panel, sel = S.ui.selection;
		if (p && p.kind === "factory") {
			return p.id;
		}
		return S.ui.layers.supply && sel && sel.kind === "factory" ? sel.id : null;
	}

	/** Supply links between factories in the colours of their goods; inactive ones dashed and dimmer. */
	drawSupply(ctx, v, dark) {
		const on = S.ui.layers.supply;
		const focus = this.supplyFocus();
		if (!on && !focus) {
			return;
		}
		const links = supplyLinks();
		if (!links.length) {
			return;
		}
		const w = v.zoom <= -2 ? 1.3 : v.zoom <= 0 ? 1.7 : v.zoom <= 2 ? 2.2 : 2.8;
		const gap = w + 2;
		const arrows = v.zoom >= -1.5;
		const geo = (l) => {
			const [ax, ay] = v.toPx(l.ax, l.ay);
			const [bx, by] = v.toPx(l.bx, l.by);
			// links between the same two factories side by side (offset the same way in both directions)
			const flip = l.from > l.to ? -1 : 1;
			const dx = (bx - ax) * flip, dy = (by - ay) * flip;
			const len = Math.hypot(dx, dy) || 1;
			const o = (l.k - (l.n - 1) / 2) * gap;
			const ox = (-dy / len) * o, oy = (dx / len) * o;
			return [ax + ox, ay + oy, bx + ox, by + oy, len];
		};
		const visible = (l) => !(Math.max(l.ax, l.bx) < v.x0 || Math.min(l.ax, l.bx) > v.x1
			|| Math.max(l.ay, l.by) < v.y0 || Math.min(l.ay, l.by) > v.y1);
		const arrow = (g, size) => {
			const [ax, ay, bx, by, len] = g;
			if (len < size * 4) {
				return;
			}
			const ux = (bx - ax) / len, uy = (by - ay) / len;
			const cx = ax + (bx - ax) * 0.58, cy = ay + (by - ay) * 0.58;
			ctx.moveTo(cx + ux * size, cy + uy * size);
			ctx.lineTo(cx - ux * size - uy * size * 0.75, cy - uy * size + ux * size * 0.75);
			ctx.lineTo(cx - ux * size + uy * size * 0.75, cy - uy * size - ux * size * 0.75);
			ctx.closePath();
		};
		ctx.save();
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const mine = [];
		if (on) {
			// one path per colour and state
			const groups = new Map();
			for (const l of links) {
				if (focus && (l.from === focus || l.to === focus)) {
					mine.push(l);
					continue;
				}
				if (!visible(l)) {
					continue;
				}
				const key = l.color + (l.active ? "|1" : "|0");
				let g = groups.get(key);
				if (!g) {
					g = { color: l.color, active: l.active, items: [] };
					groups.set(key, g);
				}
				g.items.push(geo(l));
			}
			ctx.lineWidth = w;
			for (const g of groups.values()) {
				ctx.globalAlpha = (g.active ? 0.9 : 0.55) * (focus ? 0.35 : 1);
				ctx.strokeStyle = g.color;
				ctx.fillStyle = g.color;
				ctx.setLineDash(g.active ? [] : [5, 4]);
				ctx.beginPath();
				for (const [ax, ay, bx, by] of g.items) {
					ctx.moveTo(ax, ay);
					ctx.lineTo(bx, by);
				}
				ctx.stroke();
				if (arrows) {
					ctx.setLineDash([]);
					ctx.beginPath();
					for (const it of g.items) {
						arrow(it, w + 3);
					}
					ctx.fill();
				}
			}
		} else {
			for (const l of links) {
				if (l.from === focus || l.to === focus) {
					mine.push(l);
				}
			}
		}
		// the links of the focused factory: wider, with a casing, always with arrows
		if (mine.length) {
			const fw = w + 1.6;
			const casing = dark ? "rgba(0,0,0,0.8)" : "rgba(255,255,255,0.95)";
			const geos = mine.map((l) => [l, geo(l)]);
			ctx.globalAlpha = 1;
			ctx.setLineDash([]);
			ctx.strokeStyle = casing;
			ctx.lineWidth = fw + 3;
			ctx.beginPath();
			for (const [, [ax, ay, bx, by]] of geos) {
				ctx.moveTo(ax, ay);
				ctx.lineTo(bx, by);
			}
			ctx.stroke();
			ctx.lineWidth = fw;
			for (const [l, g] of geos) {
				ctx.globalAlpha = l.active ? 1 : 0.7;
				ctx.strokeStyle = l.color;
				ctx.fillStyle = l.color;
				ctx.setLineDash(l.active ? [] : [7, 5]);
				ctx.beginPath();
				ctx.moveTo(g[0], g[1]);
				ctx.lineTo(g[2], g[3]);
				ctx.stroke();
				ctx.setLineDash([]);
				ctx.beginPath();
				arrow(g, fw + 4);
				ctx.fill();
				ctx.lineWidth = 1.2;
				ctx.strokeStyle = casing;
				ctx.stroke();
				ctx.lineWidth = fw;
			}
		}
		ctx.restore();
	}

	/** Limits of the selected city or of the city whose panel is open (dashed rectangle). */
	drawCityArea(ctx, v, dark) {
		const p = S.ui.panel, sel = S.ui.selection;
		const id = p && p.kind === "city" ? p.id : sel && sel.kind === "city" ? sel.id : null;
		const c = typeof id === "number" ? cityIndex().map.get(id) : null;
		const a = c && c.area;
		if (!a || a.x2 < v.x0 || a.x1 > v.x1 || a.y2 < v.y0 || a.y1 > v.y1) {
			return;
		}
		const [x1, y1] = v.toPx(a.x1 - 0.5, a.y1 - 0.5);
		const [x2, y2] = v.toPx(a.x2 + 0.5, a.y2 + 0.5);
		ctx.save();
		ctx.fillStyle = dark ? "rgba(255, 212, 59, 0.08)" : "rgba(112, 72, 232, 0.07)";
		ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
		ctx.setLineDash([7, 5]);
		ctx.lineWidth = 2;
		ctx.strokeStyle = dark ? "#ffd43b" : "#7048e8";
		ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
		ctx.restore();
	}

	invalidate() {
		if (this.map) {
			this.map.invalidateSize({ pan: false });
		}
	}

	/** Centre the map on a tile; marker: a pin stays there until the next locate. */
	locate(x, y, opts = {}) {
		if (!this.map) {
			return;
		}
		this.invalidate();
		const zoom = Math.max(this.map.getZoom(), opts.zoom ?? 3);
		this.map.setView(toLatLng(x, y), Math.min(zoom, MAX_ZOOM), { animate: true });
		if (opts.marker) {
			this.clearMarker();
			this.marker = L.marker(toLatLng(x, y), { keyboard: false, interactive: false }).addTo(this.map);
		}
	}

	clearMarker() {
		if (this.marker) {
			this.marker.remove();
			this.marker = null;
		}
	}

	// --- drawing ---------------------------------------------------------------------------

	drawFeatures(ctx, v) {
		const layers = S.ui.layers;
		const dark = isDark();

		this.drawCityArea(ctx, v, dark);
		this.drawSupply(ctx, v, dark);

		// line route (under the stations): the legs the convoys were seen driving, and straight dashed
		// lines (dimmer) for the steps of the schedule whose leg is not known yet
		const route = this.route;
		if (route && route.stops.length) {
			ctx.save();
			ctx.strokeStyle = lineColor(route.id);
			ctx.lineJoin = "round";
			ctx.lineCap = "round";
			const w = Math.max(2.5, Math.min(6, v.s * 0.35));
			ctx.lineWidth = Math.max(2, w * 0.75);
			ctx.globalAlpha = 0.45;
			ctx.setLineDash([8, 6]);
			for (const [i, j] of route.missing) {
				const a = route.sched[i], b = route.sched[j];
				if (a && b) {
					this.strokePath(ctx, v, [a, b]);
				}
			}
			ctx.setLineDash([]);
			ctx.lineWidth = w;
			ctx.globalAlpha = 0.9;
			for (const leg of route.legs) {
				this.strokePath(ctx, v, leg.points);
			}
			ctx.restore();
		}

		// the leg the convoy of the open panel drives now, with a dot at its end
		const leg = this.convoyLeg;
		if (leg && leg.points.length >= 2) {
			ctx.save();
			ctx.lineJoin = "round";
			ctx.lineCap = "round";
			const w = Math.max(3, Math.min(7, v.s * 0.4));
			const casing = dark ? "#0b0c0e" : "#ffffff";
			ctx.strokeStyle = casing;
			ctx.lineWidth = w + 4;
			this.strokePath(ctx, v, leg.points);
			ctx.strokeStyle = "#1c7ed6";
			ctx.lineWidth = w;
			this.strokePath(ctx, v, leg.points);
			const [ex, ey] = leg.points[leg.points.length - 1];
			const [px, py] = v.toPx(ex, ey);
			ctx.beginPath();
			ctx.arc(px, py, w + 2, 0, 6.2832);
			ctx.fillStyle = "#1c7ed6";
			ctx.fill();
			ctx.lineWidth = 2;
			ctx.strokeStyle = casing;
			ctx.stroke();
			ctx.restore();
		}

		// stations: owner colour, framed when zoomed in
		const stations = layers.stations && S.stations && S.stations.stations;
		if (stations) {
			const sz = stationSize(v.zoom, v.s);
			const h = sz / 2;
			const framed = sz >= 7;
			let last = null;
			for (const st of stations) {
				const p = st.pos;
				if (!p || p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) {
					continue;
				}
				const [px, py] = v.toPx(p.x, p.y);
				if (framed) {
					ctx.fillStyle = dark ? "#000" : "#222";
					ctx.fillRect(px - h - 2, py - h - 2, sz + 4, sz + 4);
					ctx.fillStyle = "#fff";
					ctx.fillRect(px - h - 1, py - h - 1, sz + 2, sz + 2);
					last = null;
				}
				const col = ownerColor(st.owner);
				if (col !== last) {
					ctx.fillStyle = col;
					last = col;
				}
				ctx.fillRect(px - h, py - h, sz, sz);
			}
		}

		// factories
		const factories = layers.factories && S.factories && S.factories.factories;
		if (factories) {
			const d = v.zoom <= -1 ? 3.5 : v.zoom <= 1 ? 5 : 7;
			ctx.fillStyle = "#a61e1e";
			ctx.strokeStyle = dark ? "#111" : "#fff";
			ctx.lineWidth = 1.2;
			for (const f of factories) {
				const p = f.pos;
				if (!p || p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) {
					continue;
				}
				const [px, py] = v.toPx(p.x, p.y);
				ctx.beginPath();
				ctx.moveTo(px, py - d);
				ctx.lineTo(px + d, py);
				ctx.lineTo(px, py + d);
				ctx.lineTo(px - d, py);
				ctx.closePath();
				ctx.fill();
				ctx.stroke();
			}
		}
		const focus = this.supplyFocus();
		if (focus) {
			const [fx, fy] = focus.split(",").map(Number);
			if (fx >= v.x0 && fx <= v.x1 && fy >= v.y0 && fy <= v.y1) {
				const [px, py] = v.toPx(fx, fy);
				const r = (v.zoom <= -1 ? 3.5 : v.zoom <= 1 ? 5 : 7) + 5;
				ctx.save();
				ctx.lineWidth = 3;
				ctx.strokeStyle = dark ? "#fff" : "#111";
				ctx.beginPath();
				ctx.moveTo(px, py - r);
				ctx.lineTo(px + r, py);
				ctx.lineTo(px, py + r);
				ctx.lineTo(px - r, py);
				ctx.closePath();
				ctx.stroke();
				ctx.restore();
			}
		}

		// map markers (labels placed in the game)
		if (layers.labels && v.zoom >= 0) {
			ctx.fillStyle = "#f59f00";
			for (const l of this.labelList().values()) {
				const p = l.pos;
				if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) {
					continue;
				}
				const [px, py] = v.toPx(p.x, p.y);
				ctx.beginPath();
				ctx.arc(px, py, 3, 0, 6.2832);
				ctx.fill();
			}
		}
	}

	/** Texts above the convoys: route stop numbers, city, station, factory and marker names. */
	drawLabels(ctx, v) {
		const layers = S.ui.layers;
		const dark = isDark();
		const halo = dark ? "rgba(20,22,26,0.85)" : "rgba(255,255,255,0.9)";
		const ink = dark ? "#f1f3f5" : "#1b1e23";
		const placed = [];
		const fits = (x, y, w, h) => {
			for (const r of placed) {
				if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) {
					return false;
				}
			}
			placed.push([x, y, w, h]);
			return true;
		};
		const seen = new Map(); // text -> positions of the labels with this text
		// returns the box of the label drawn [x, y, w, h], or false
		const label = (text, px, py, size, weight, color = ink) => {
			const near = seen.get(text);
			if (near && near.some(([x, y]) => Math.abs(x - px) < 160 && Math.abs(y - py) < 90)) {
				return false;
			}
			ctx.font = `${weight} ${size}px system-ui, sans-serif`;
			const w = ctx.measureText(text).width;
			if (!fits(px - w / 2 - 2, py - size, w + 4, size + 4)) {
				return false;
			}
			if (near) {
				near.push([px, py]);
			} else {
				seen.set(text, [[px, py]]);
			}
			ctx.lineWidth = 3;
			ctx.strokeStyle = halo;
			ctx.strokeText(text, px - w / 2, py);
			ctx.fillStyle = color;
			ctx.fillText(text, px - w / 2, py);
			return [px - w / 2 - 2, py - size, w + 4, size + 4];
		};
		ctx.textBaseline = "alphabetic";
		ctx.lineJoin = "round";

		const route = this.route;
		if (route && route.stops.length && v.zoom >= 0) {
			const col = lineColor(route.id);
			ctx.font = "600 11px system-ui, sans-serif";
			route.stops.forEach((st) => {
				const i = st.index;
				const [px, py] = v.toPx(st.x, st.y);
				ctx.beginPath();
				ctx.arc(px, py, 9, 0, 6.2832);
				ctx.fillStyle = col;
				ctx.fill();
				ctx.lineWidth = 2;
				ctx.strokeStyle = "#fff";
				ctx.stroke();
				const s = String(i + 1);
				ctx.fillStyle = "#fff";
				ctx.fillText(s, px - ctx.measureText(s).width / 2, py + 4);
				placed.push([px - 9, py - 9, 18, 18]);
			});
		}

		// city names, largest first (a click on a name selects the city)
		this.cityHits = [];
		const cities = layers.cities && S.cities && S.cities.cities;
		if (cities) {
			const sorted = cities.slice().sort((a, b) => (b.citizens || 0) - (a.citizens || 0));
			for (const c of sorted) {
				const p = c.townhall;
				if (!p || p.x < v.x0 - 20 || p.x > v.x1 + 20 || p.y < v.y0 - 20 || p.y > v.y1 + 20) {
					continue;
				}
				const big = (c.citizens || 0) > 50000;
				const size = v.zoom <= -1 ? (big ? 13 : 11) : v.zoom <= 1 ? (big ? 15 : 12) : big ? 17 : 14;
				const [px, py] = v.toPx(p.x, p.y);
				const box = label(c.name, px, py, size, big ? 700 : 600);
				if (box) {
					this.cityHits.push([box, c]);
				}
			}
		}

		const stations = layers.stations && S.stations && S.stations.stations;
		if (stations && v.zoom >= 3) {
			let n = 0;
			for (const st of stations) {
				const p = st.pos;
				if (!p || p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) {
					continue;
				}
				const [px, py] = v.toPx(p.x, p.y);
				if (label(st.name, px, py - stationSize(v.zoom, v.s) / 2 - 4, 11, 500) && ++n > 250) {
					break;
				}
			}
		}
		const factories = layers.factories && S.factories && S.factories.factories;
		if (factories && v.zoom >= 2) {
			for (const f of factories) {
				const p = f.pos;
				if (!p || p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) {
					continue;
				}
				const [px, py] = v.toPx(p.x, p.y);
				label(f.name, px, py + 18, 11, 500, dark ? "#ffa8a8" : "#8a1c1c");
			}
		}
		if (layers.labels && v.zoom >= 0) {
			for (const l of this.labelList().values()) {
				const p = l.pos;
				if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) {
					continue;
				}
				const [px, py] = v.toPx(p.x, p.y);
				label(String(l.text || ""), px, py - 5, 11, 600, dark ? "#ffd8a8" : "#7a4a00");
			}
		}
	}

	drawConvoys(ctx, v) {
		const t0 = performance.now();
		const ui = S.ui;
		const P = S.positions, i = P.idx;
		const sel = ui.selection;
		if (ui.layers.convoys && P.rows.size && i.x !== undefined) {
			const r = convoyRadius(v.zoom);
			const hl = ui.highlightLine;
			const mode = ui.colorMode;
			const groups = new Map();
			const problems = [];
			const marked = [];
			for (const row of P.rows.values()) {
				const x = row[i.x], y = row[i.y];
				if (x < v.x0 || x > v.x1 || y < v.y0 || y > v.y1) {
					continue;
				}
				const state = P.states[row[i.state]];
				let col;
				if (mode === "line") {
					col = lineColor(row[i.line]);
				} else if (mode === "state") {
					col = stateColor(state);
				} else {
					col = ownerColor(row[i.owner]);
				}
				const [px, py] = v.toPx(x, y);
				if (hl && row[i.line] === hl) {
					marked.push([px, py, col]);
					continue;
				}
				let g = groups.get(col);
				if (!g) {
					g = [];
					groups.set(col, g);
				}
				g.push(px, py);
				if (isProblem(state)) {
					problems.push(px, py);
				}
			}
			ctx.globalAlpha = hl ? 0.28 : 1;
			const rr = hl ? r * 0.8 : r;
			for (const [col, pts] of groups) {
				ctx.fillStyle = col;
				ctx.beginPath();
				for (let k = 0; k < pts.length; k += 2) {
					ctx.moveTo(pts[k] + rr, pts[k + 1]);
					ctx.arc(pts[k], pts[k + 1], rr, 0, 6.2832);
				}
				ctx.fill();
			}
			if (v.zoom >= 1 && !hl) {
				ctx.lineWidth = 0.8;
				ctx.strokeStyle = isDark() ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.85)";
				for (const pts of groups.values()) {
					ctx.beginPath();
					for (let k = 0; k < pts.length; k += 2) {
						ctx.moveTo(pts[k] + rr, pts[k + 1]);
						ctx.arc(pts[k], pts[k + 1], rr, 0, 6.2832);
					}
					ctx.stroke();
				}
			}
			ctx.globalAlpha = 1;
			if (problems.length) {
				ctx.strokeStyle = "#e03131";
				ctx.lineWidth = 2;
				ctx.beginPath();
				for (let k = 0; k < problems.length; k += 2) {
					ctx.moveTo(problems[k] + rr + 3, problems[k + 1]);
					ctx.arc(problems[k], problems[k + 1], rr + 3, 0, 6.2832);
				}
				ctx.stroke();
			}
			if (marked.length) {
				const mr = r + 2;
				ctx.lineWidth = 2;
				ctx.strokeStyle = isDark() ? "#fff" : "#111";
				for (const [px, py, col] of marked) {
					ctx.beginPath();
					ctx.arc(px, py, mr, 0, 6.2832);
					ctx.fillStyle = col;
					ctx.fill();
					ctx.stroke();
				}
			}
		}
		// selection ring
		if (sel) {
			let x = sel.x, y = sel.y;
			if (sel.kind === "convoy") {
				const row = P.rows.get(sel.id);
				if (row) {
					x = row[i.x];
					y = row[i.y];
				}
			}
			if (typeof x === "number") {
				const [px, py] = v.toPx(x, y);
				const rad = sel.kind === "tile" ? Math.max(6, v.s * 0.7) : convoyRadius(v.zoom) + 7;
				ctx.lineWidth = 3;
				ctx.strokeStyle = "#fff";
				ctx.beginPath();
				ctx.arc(px, py, rad, 0, 6.2832);
				ctx.stroke();
				ctx.lineWidth = 2;
				ctx.strokeStyle = "#f03e3e";
				ctx.stroke();
			}
		}
		const dt = performance.now() - t0;
		perf.convoyDraw.push(dt);
		if (perf.convoyDraw.length > 200) {
			perf.convoyDraw.shift();
		}
	}

	// --- picking ---------------------------------------------------------------------------

	onClick(e) {
		const hit = this.pick(e.containerPoint, e.originalEvent && e.originalEvent.pointerType === "touch");
		if (hit) {
			setUi({ selection: hit });
			return;
		}
		const x = Math.floor(e.latlng.lng), y = Math.floor(-e.latlng.lat);
		const w = S.poll && S.poll.world;
		if (w && x >= 0 && y >= 0 && x < w.size_x && y < w.size_y) {
			setUi({ selection: { kind: "tile", x, y } });
		} else {
			setUi({ selection: null });
		}
	}

	pick(cp, touch) {
		const map = this.map;
		const lp = map.containerPointToLayerPoint(cp);
		const v = this.convoys.view();
		const slack = touch ? 14 : 8;
		let best = null, bestD = Infinity;
		const consider = (kind, id, x, y, radius, extra) => {
			const [px, py] = v.toPx(x, y);
			const d = Math.hypot(px - lp.x, py - lp.y);
			if (d <= radius + slack && d < bestD) {
				bestD = d;
				best = Object.assign({ kind, id, x, y }, extra);
			}
		};
		const P = S.positions, i = P.idx;
		if (S.ui.layers.convoys && i.x !== undefined) {
			const r = convoyRadius(v.zoom);
			for (const row of P.rows.values()) {
				consider("convoy", row[0], row[i.x], row[i.y], r);
			}
			if (best) {
				return best;
			}
		}
		const city = (pad) => {
			if (!S.ui.layers.cities) {
				return null;
			}
			for (const [[x, y, w, h], c] of this.cityHits || []) {
				if (lp.x >= x - pad && lp.x <= x + w + pad && lp.y >= y - pad && lp.y <= y + h + pad && c.townhall) {
					return { kind: "city", id: c.id, x: c.townhall.x, y: c.townhall.y };
				}
			}
			return null;
		};
		const onName = city(0);
		if (onName) {
			return onName;
		}
		if (S.ui.layers.stations && S.stations && S.stations.stations) {
			const sz = stationSize(v.zoom, v.s) / 2;
			for (const st of S.stations.stations) {
				if (st.pos) {
					consider("station", st.id, st.pos.x, st.pos.y, sz);
				}
			}
		}
		if (S.ui.layers.factories && S.factories && S.factories.factories) {
			for (const f of S.factories.factories) {
				if (f.pos) {
					consider("factory", f.pos.x + "," + f.pos.y, f.pos.x, f.pos.y, 6);
				}
			}
		}
		return best || city(touch ? 10 : 4);
	}
}

export const mapCtl = new MapController();
// for debugging in the browser console and for automated tests
window.__dash = { S, mapCtl };

/** Select a city, switch to the map and fit it (its limits are drawn while it is selected). */
export function showCityOnMap(c) {
	if (!c || !c.townhall) {
		return;
	}
	setUi({ tab: "map", selection: { kind: "city", id: c.id, x: c.townhall.x, y: c.townhall.y } });
	requestAnimationFrame(() => {
		const a = c.area;
		if (a) {
			mapCtl.fitBox(a.x1, a.y1, a.x2, a.y2, 3);
		} else {
			mapCtl.locate(c.townhall.x, c.townhall.y, { zoom: 1 });
		}
	});
}

/** Select an object, switch to the map and centre it. */
export function showOnMap(sel, opts = {}) {
	setUi({ tab: "map", selection: sel });
	requestAnimationFrame(() => {
		mapCtl.invalidate();
		if (typeof sel.x === "number") {
			mapCtl.locate(sel.x, sel.y, opts);
		}
	});
}
