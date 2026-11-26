// Simutrans-Horizon dashboard: map tab (Leaflet map, layer controls, legend, info card).
// Artistic License, see LICENSE.txt.
import { html, useRef, useEffect, useState } from "/vendor/htm/standalone.module.js";
import { S, useTopics, setUi, playerName } from "/js/store.js";
import { mapCtl } from "/js/map.js";
import { MODES } from "/js/minimap.js";
import { InfoCard } from "/js/views/infocard.js";
import { t, stateName } from "/js/i18n.js";
import { ownerColor, paletteColor, CATEGORY_COLOR, CATEGORY_ORDER } from "/js/colors.js";
import { collator } from "/js/format.js";
import { Icon } from "/js/icons.js";
import { useNarrow } from "/js/vtable.js";
import { supplyLinks, supplyGoods, goodsColor } from "/js/supply.js";

const CATEGORY_SAMPLE = {
	ok: "driving", busy: "loading", wait: "waiting_for_clearance", stuck: "waiting_for_clearance_one_month",
	noroute: "no_route", depot: "entering_depot", other: "routing",
};

function Legend() {
	useTopics(["players", "ui", "lang"]);
	const mode = S.ui.colorMode;
	if (mode === "state") {
		return html`<ul class="legend">${CATEGORY_ORDER.map((c) => html`<li>
			<span class="dot" style=${{ background: CATEGORY_COLOR[c] }}></span>${stateName(CATEGORY_SAMPLE[c])}</li>`)}
			<li><span class="dot ring"></span>${t("st_problems")}</li></ul>`;
	}
	if (mode === "owner") {
		const players = (S.players && S.players.players) || [];
		return html`<ul class="legend">${players.filter((p) => p.convoys > 0 || p.stations > 0).map((p) => html`<li>
			<span class="dot" style=${{ background: ownerColor(p.nr) }}></span>${p.name}</li>`)}
			<li><span class="dot ring"></span>${t("st_problems")}</li></ul>`;
	}
	return html`<p class="muted small">${t("color_line")}</p>`;
}

// palette indices of the game's minimap colours (src/simutrans/gui/minimap.cc, simcolor.h)
const MAP_COL = { road: 208, rail: 185, canal: 23, runway: 28, power: 55, halt: 131, unowned: 155,
	track: 215, electric: 131, signal: 171, trees: 140 };
const CLIMATES = [["desert", 171], ["tropic", 143], ["mediterran", 140], ["temperate", 136], ["tundra", 168],
	["rocky", 189], ["arctic", 11]];
// severity modes: [legend title, low end, high end]
const SCALES = { traffic: ["lg_traffic", "lg_few", "lg_many"], freight: ["lg_freight", "lg_few", "lg_many"],
	speed: ["lg_speed", "0", "450 km/h"], power: ["lg_power_load", "lg_power_low", "lg_power_high"],
	level: ["lg_level", "lg_low", "lg_high"] };

function Swatch({ index }) {
	return html`<span class="swatch" style=${{ background: paletteColor(index) || "transparent" }}></span>`;
}

function Gradient({ indices, low, high }) {
	const cols = indices.map((i) => paletteColor(i)).filter(Boolean);
	if (cols.length < 2) {
		return null;
	}
	return html`<div class="grad-wrap">
		<div class="grad" style=${{ background: `linear-gradient(to right, ${cols.join(", ")})` }}></div>
		<div class="grad-ends"><span>${low}</span><span>${high}</span></div>
	</div>`;
}

function players() {
	const pal = (S.palette && S.palette.players) || [];
	return pal.filter((p) => p && typeof p.minimap_color === "number");
}

/** What the colours of the base map mean (not every mode needs a legend). */
function MapLegend() {
	useTopics(["ui", "lang", "palette", "players", "map_export"]);
	const pal = S.palette;
	if (mapCtl.mapExport !== true || !pal) {
		return null;
	}
	const mode = mapCtl.mode();
	const item = (index, text) => html`<li><${Swatch} index=${index} />${text}</li>`;
	const lt = (k) => (k.startsWith("lg_") ? t(k) : k);
	if (mode === "terrain") {
		const hc = pal.height_colors || [];
		return html`<div class="map-legend">
			<${Gradient} indices=${hc.slice(0, 5).concat(hc.slice(5).filter((_, i) => i % 3 === 0))} low=${t("lg_water")} high=${t("lg_height_high")} />
			<ul class="legend cols">${item(MAP_COL.road, t("lg_road"))}${item(MAP_COL.rail, t("lg_rail"))}
				${item(MAP_COL.canal, t("lg_canal"))}${item(MAP_COL.runway, t("lg_runway"))}
				${item(MAP_COL.power, t("lg_power"))}${item(MAP_COL.halt, t("lg_station"))}</ul>
		</div>`;
	}
	if (mode === "owner" || mode === "passengers" || mode === "mail") {
		return html`<div class="map-legend">
			${mode !== "owner" ? html`<p class="muted small">${t("lg_covered")}</p>` : null}
			<ul class="legend">${players().map((p) => item(p.minimap_color, playerName(p.nr)))}
				${mode === "owner" ? item(MAP_COL.unowned, t("lg_unowned")) : null}</ul>
		</div>`;
	}
	if (SCALES[mode]) {
		const [title, low, high] = SCALES[mode];
		return html`<div class="map-legend">
			<span class="label small">${t(title)}</span>
			<${Gradient} indices=${pal.severity_colors || []} low=${lt(low)} high=${lt(high)} />
			${mode !== "speed" ? html`<p class="muted small">${t("lg_monthly")}</p>` : null}
		</div>`;
	}
	if (mode === "tracks") {
		return html`<ul class="legend map-legend">${item(MAP_COL.track, t("lg_track"))}${item(MAP_COL.electric, t("lg_electric"))}
			${item(MAP_COL.signal, t("lg_signal"))}</ul>`;
	}
	if (mode === "forest") {
		return html`<ul class="legend map-legend">${item(MAP_COL.trees, t("lg_trees"))}</ul>`;
	}
	if (mode === "climates") {
		return html`<ul class="legend cols map-legend">${CLIMATES.map(([k, i]) => item(i, t("cl_" + k)))}</ul>`;
	}
	return null;
}

function ModeSelect() {
	useTopics(["ui", "lang", "map_export"]);
	if (mapCtl.mapExport !== true) {
		return null;
	}
	return html`<div class="field">
		<label for="map-mode">${t("map_mode")}</label>
		<select id="map-mode" value=${mapCtl.mode()} onChange=${(e) => setUi({ mapMode: e.target.value })}>
			${MODES.map((m) => html`<option value=${m}>${t("mode_" + m)}</option>`)}
		</select>
		<${MapLegend} />
	</div>`;
}

/** How much of the highlighted line's route is known (the bridge merges the legs over time). */
export function RouteNote({ route }) {
	if (route.fallback) {
		return html`<p class="muted small">${t("route_straight")}</p>`;
	}
	if (route.complete) {
		return html`<p class="muted small">${t("route_complete")}</p>`;
	}
	return html`<p class="muted small">${t("route_partial", route.covered, route.pairs)}</p>`;
}

function LineSelect() {
	useTopics(["lines", "ui", "route"]);
	const lines = ((S.lines && S.lines.lines) || []).slice().sort((a, b) => collator().compare(a.name, b.name));
	const hl = S.ui.highlightLine;
	return html`<div class="field">
		<label for="hl-line">${t("highlight_line")}</label>
		<div class="row">
			<select id="hl-line" value=${hl || ""} onChange=${(e) => setUi({ highlightLine: Number(e.target.value) || null })}>
				<option value="">${t("no_highlight")}</option>
				${lines.map((l) => html`<option value=${l.id}>${l.name} (${l.convoys})</option>`)}
			</select>
			${hl ? html`<button type="button" class="icon-btn" title=${t("fit_map")} aria-label=${t("fit_map")} onClick=${() => mapCtl.fitRoute()}><${Icon} name="fit" /></button>` : null}
		</div>
		${hl && mapCtl.route ? html`<${RouteNote} route=${mapCtl.route} />` : null}
	</div>`;
}

/** Goods on the supply links with their colours, and what solid and dashed lines mean. */
function SupplyLegend() {
	useTopics(["supply_chain", "goods", "ui", "lang", "snapshot"]);
	if (!S.ui.layers.supply) {
		return null;
	}
	if (!S.supply_chain) {
		return S.poll ? html`<p class="muted small supply-note">${t("supply_needs_engine")}</p>` : null;
	}
	const goods = supplyGoods(collator());
	if (!supplyLinks().length) {
		return html`<p class="muted small supply-note">${t("supply_none")}</p>`;
	}
	return html`<div class="map-legend supply-legend">
		<ul class="legend cols">${goods.map((g) => html`<li title=${g}><span class="swatch line" style=${{ background: goodsColor(g) }}></span>
			<span class="ellipsis">${g}</span></li>`)}</ul>
		<div class="route-legend small muted"><span class="lg-solid"></span>${t("supply_active")}</div>
		<div class="route-legend small muted"><span class="lg-dash"></span>${t("supply_inactive")}</div>
		${S.ui.panel && S.ui.panel.kind === "factory" ? html`<p class="muted small">${t("supply_focus")}</p>` : null}
	</div>`;
}

function Controls() {
	useTopics(["ui", "lang"]);
	const narrow = useNarrow();
	const [open, setOpen] = useState(!narrow);
	const layers = S.ui.layers;
	const toggle = (k) => setUi({ layers: Object.assign({}, layers, { [k]: !layers[k] }) });
	return html`<div class=${"map-controls" + (open ? " open" : "")}>
		<button type="button" class="icon-btn ctl-toggle" aria-expanded=${open} aria-label=${t("legend")} title=${t("legend")}
			onClick=${() => setOpen(!open)}><${Icon} name="layers" /></button>
		${open ? html`<div class="ctl-body">
			<${ModeSelect} />
			<fieldset class="layers">
				${["convoys", "stations", "factories", "cities", "labels", "supply"].map((k) => html`<label class="check">
					<input type="checkbox" checked=${!!layers[k]} onChange=${() => toggle(k)} />${t("layer_" + k)}</label>`)}
			</fieldset>
			<${SupplyLegend} />
			<div class="field">
				<span class="label">${t("color_by")}</span>
				<div class="seg" role="group" aria-label=${t("color_by")}>
					${["owner", "line", "state"].map((m) => html`<button type="button" aria-pressed=${S.ui.colorMode === m}
						class=${S.ui.colorMode === m ? "on" : ""} onClick=${() => setUi({ colorMode: m })}>${t("color_" + m)}</button>`)}
				</div>
			</div>
			<${LineSelect} />
			<${Legend} />
			<button type="button" class="btn small" onClick=${() => mapCtl.fit()}>${t("fit_map")}</button>
		</div>` : null}
	</div>`;
}

function TerrainStatus() {
	useTopics(["terrain", "lang"]);
	if (mapCtl.tileErrors) {
		return html`<div class="map-status error">${t("map_error", t("tiles_failed", mapCtl.tileErrors))}</div>`;
	}
	const st = mapCtl.terrain.status();
	if (mapCtl.terrain.lastError && st.pending === 0 && st.loaded < st.total && mapCtl.terrain.errors) {
		return html`<div class="map-status error">${t("map_error", mapCtl.terrain.lastError)}</div>`;
	}
	if (!st.pending) {
		return null;
	}
	return html`<div class="map-status">${t("map_loading", st.loaded, st.loaded + st.pending)}</div>`;
}

const PICK_HINTS = { tile: "pick_hint_tile", area: "pick_hint_area", ab: "pick_hint_ab" };

/** What a running map pick of the AI team asks for, with a button to cancel it (Escape cancels too). */
function PickHint() {
	useTopics(["pick", "lang"]);
	const p = mapCtl.pickInfo();
	if (!p) {
		return null;
	}
	let text;
	if (p.mode === "object") {
		text = t(p.miss ? "pick_hint_miss" : "pick_hint_object", t("pick_kind_" + p.kind));
	} else if (p.mode === "area" && p.points.length) {
		text = t("pick_hint_area2");
	} else if (p.mode === "ab" && p.points.length) {
		text = t("pick_hint_b");
	} else {
		text = t(PICK_HINTS[p.mode] || "pick_hint_tile");
	}
	return html`<div class="map-pill pick-hint" role="status">
		<span>${text}</span>
		<button type="button" class="btn small" onClick=${() => mapCtl.cancelPick(true)}>${t("pick_cancel")}</button>
	</div>`;
}

/** The plan of a project drawn on the map: its name, fit and remove. */
function PlanBadge() {
	useTopics(["plan", "lang"]);
	const plan = mapCtl.plan;
	if (!plan) {
		return null;
	}
	return html`<div class="map-pill plan-badge" role="status">
		<span class="plan-swatch"></span>
		<span class="plan-title">${t("plan_on_map", plan.title || "#" + plan.id)}</span>
		<button type="button" class="icon-btn" title=${t("fit_plan")} aria-label=${t("fit_plan")} onClick=${() => mapCtl.fitPlan()}>
			<${Icon} name="fit" size=${16} /></button>
		<button type="button" class="icon-btn plan-clear" title=${t("plan_clear")} aria-label=${t("plan_clear")}
			onClick=${() => mapCtl.setPlan(null)}><${Icon} name="close" size=${16} /></button>
	</div>`;
}

export function MapView({ visible }) {
	const box = useRef(null);
	useEffect(() => {
		mapCtl.mount(box.current);
		// the map gets narrower when a detail panel opens beside it
		const ro = new ResizeObserver(() => mapCtl.invalidate());
		ro.observe(box.current);
		return () => ro.disconnect();
	}, []);
	useEffect(() => {
		mapCtl.setVisible(visible);
		if (visible) {
			requestAnimationFrame(() => mapCtl.invalidate());
		}
	}, [visible]);
	return html`<div class="mapview">
		<div class="map" ref=${box}></div>
		<${Controls} />
		<${TerrainStatus} />
		<div class="map-top"><${PickHint} /><${PlanBadge} /></div>
		<${InfoCard} />
	</div>`;
}
