// Simutrans-Horizon dashboard: info card of the selected convoy, station, factory or tile.
// Artistic License, see LICENSE.txt.
import { html, useState, useEffect } from "/vendor/htm/standalone.module.js";
import { S, useTopics, setUi, convoyIndex, stationIndex, convoyLive, playerName, lineName, cityIndex, factoryIndex } from "/js/store.js";
import { apiGet, canRead } from "/js/api.js";
import { convoyDetails, refreshFullLines } from "/js/data.js";
import { mapCtl } from "/js/map.js";
import { t, stateName } from "/js/i18n.js";
import { fmtInt, fmtMoney, fmtPct, fmtPos } from "/js/format.js";
import { ownerColor, stateColor, lineColor } from "/js/colors.js";
import { Icon } from "/js/icons.js";
import { openPanel } from "/js/panel.js";
import { FactoryStatus, GoodsName } from "/js/views/detailparts.js";
import { followIn3D, view3dSupported } from "/js/views/view3d.js";
import { share, fmtShare } from "/js/views/citypanel.js";

/** Load details for the selection; reload every `every` ms while it stays selected. */
function useDetails(key, load, every = 0) {
	const [state, setState] = useState({ key: null, data: null, error: null });
	useEffect(() => {
		let alive = true, timer = null;
		const run = async () => {
			try {
				const data = await load();
				if (alive) {
					setState({ key, data, error: null });
				}
			} catch (e) {
				if (alive) {
					setState((s) => ({ key, data: s.key === key ? s.data : null, error: e.message }));
				}
			}
			if (alive && every) {
				timer = setTimeout(run, every);
			}
		};
		setState((s) => (s.key === key ? s : { key, data: null, error: null }));
		run();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [key]);
	return state.key === key ? state : { data: null, error: null };
}

function Row({ k, children }) {
	return html`<dt>${k}</dt><dd>${children}</dd>`;
}

function Owner({ nr }) {
	return html`<span class="owner"><span class="swatch" style=${{ background: ownerColor(nr) }}></span>${playerName(nr)}</span>`;
}

function LineLink({ id }) {
	if (!id) {
		return html`<span class="muted">${t("no_line")}</span>`;
	}
	const on = S.ui.highlightLine === id;
	return html`<button type="button" class=${"linkish" + (on ? " on" : "")} title=${t("line_details")}
		onClick=${() => openPanel("line", id)}>
		<span class="swatch" style=${{ background: lineColor(id) }}></span>${lineName(id)}
	</button>`;
}

function ConvoyCard({ sel }) {
	useTopics(["positions", "convoys", "lines", "players"]);
	const sum = convoyIndex().map.get(sel.id);
	const live = convoyLive(sel.id);
	const det = useDetails("c" + sel.id, () => convoyDetails(sel.id), 10000);
	const d = det.data;
	const state = live ? live.state : sum ? sum.state : d ? d.state : null;
	const line = live ? live.line : sum ? sum.line : d && d.line ? d.line.id : 0;
	const owner = live ? live.owner : sum ? sum.owner : d ? d.owner : -1;
	const pos = live ? { x: live.x, y: live.y, z: live.z } : sum ? sum.pos : d ? d.pos : null;
	return html`<h2 class="card-title">${sum ? sum.name : d ? d.name : "#" + sel.id}</h2>
		<div class="card-sub">${t("convoy")} #${sel.id}</div>
		<dl class="kv">
			<${Row} k=${t("state")}><span class="state"><span class="dot" style=${{ background: stateColor(state) }}></span>${stateName(state)}</span><//>
			<${Row} k=${t("owner")}><${Owner} nr=${owner} /><//>
			<${Row} k=${t("line")}><${LineLink} id=${line} /><//>
			<${Row} k=${t("load")}>${live ? fmtPct(live.load) : d ? fmtPct(d.loading_level) : "–"}<//>
			${d ? html`
				<${Row} k=${t("speed")}>${fmtInt(d.speed_kmh)} km/h <span class="muted">(${t("max_speed")} ${fmtInt(d.max_speed_kmh)})</span><//>
				<${Row} k=${t("vehicles")}>${fmtInt(d.vehicles)}<//>
				<${Row} k=${t("next_stop")}>${d.next_stop ? html`<button type="button" class="linkish" onClick=${() => mapCtl.locate(d.next_stop.x, d.next_stop.y, { marker: true })}>${fmtPos(d.next_stop)}</button>` : "–"}<//>
				<${Row} k=${t("profit_year")}><span class=${d.profit_this_year < 0 ? "neg" : ""}>${fmtMoney(d.profit_this_year)}</span><//>
				<${Row} k=${t("profit_last_month")}><span class=${d.profit_last_month < 0 ? "neg" : ""}>${fmtMoney(d.profit_last_month)}</span><//>
			` : null}
			<${Row} k=${t("position")}>${fmtPos(pos)}<//>
		</dl>
		${det.error ? html`<p class="error small">${t("load_failed", det.error)}</p>` : !d ? html`<p class="muted small">${t("loading")}</p>` : null}
		<div class="card-actions"><button type="button" class="btn small" onClick=${() => openPanel("convoy", sel.id)}>
			<${Icon} name="info" size=${16} />${t("details")}</button>
			${view3dSupported() ? html`<button type="button" class="btn small follow3d" onClick=${() => followIn3D(sel.id)}>
				<${Icon} name="follow" size=${16} />${t("follow_3d")}</button>` : null}</div>`;
}

function linesAtStation(tiles) {
	const full = S.full.lines;
	if (!full || !tiles) {
		return null;
	}
	const set = new Set(tiles.map((x) => x.pos.x + "," + x.pos.y));
	const out = [];
	for (const l of full.values()) {
		if ((l.stops || []).some((s) => s.pos && set.has(s.pos.x + "," + s.pos.y))) {
			out.push(l);
		}
	}
	return out;
}

function StationCard({ sel }) {
	useTopics(["stations", "full_lines", "players", "lines"]);
	const sum = stationIndex().map.get(sel.id);
	const det = useDetails("s" + sel.id, () => apiGet("station", { id: sel.id }), 15000);
	const d = det.data;
	const st = d && d.station;
	const lines = d ? linesAtStation(d.tiles) : null;
	const acc = st && st.accepts ? Object.entries(st.accepts).filter(([, v]) => v).map(([k]) => t(k)).join(", ") : "";
	return html`<h2 class="card-title">${sum ? sum.name : st ? st.name : "#" + sel.id}</h2>
		<div class="card-sub">${t("station")} #${sel.id}</div>
		<dl class="kv">
			<${Row} k=${t("owner")}><${Owner} nr=${sum ? sum.owner : st ? st.owner : -1} /><//>
			${st ? html`
				<${Row} k=${t("waiting")}>${fmtInt(st.waiting && st.waiting.total)}
					<span class="muted"> (${t("passengers")} ${fmtInt(st.waiting && st.waiting.passengers)}, ${t("mail")} ${fmtInt(st.waiting && st.waiting.mail)})</span><//>
				<${Row} k=${t("accepts")}>${acc || "–"}<//>
				<${Row} k=${t("tiles")}>${fmtInt(st.tiles)}<//>` : null}
			<${Row} k=${t("position")}>${fmtPos(sum ? sum.pos : st && st.pos)}<//>
		</dl>
		${d ? html`<table class="mini">
			<thead><tr><th></th><th>${t("this_month")}</th><th>${t("last_month")}</th></tr></thead>
			<tbody>
				${["happy", "unhappy", "no_route", "arrived", "departed", "convoys_arrived"].map((k) => html`<tr>
					<th>${t(k === "no_route" ? "no_route_pax" : k)}</th><td>${fmtInt(d.this_month && d.this_month[k])}</td><td>${fmtInt(d.last_month && d.last_month[k])}</td>
				</tr>`)}
			</tbody>
		</table>` : null}
		<div class="card-section">
			<div class="card-h">${t("lines_here")}</div>
			${lines === null ? html`<button type="button" class="btn small" onClick=${() => refreshFullLines().catch(() => {})}>${t("show_lines")}</button>`
				: lines.length === 0 ? html`<span class="muted">${t("none")}</span>`
				: html`<div class="chips">${lines.map((l) => html`<${LineLink} id=${l.id} />`)}</div>`}
		</div>
		${det.error ? html`<p class="error small">${t("load_failed", det.error)}</p>` : !d ? html`<p class="muted small">${t("loading")}</p>` : null}
		<div class="card-actions"><button type="button" class="btn small" onClick=${() => openPanel("station", sel.id)}>
			<${Icon} name="info" size=${16} />${t("details")}</button></div>`;
}

function Goods({ list, kind }) {
	if (!list || !list.length) {
		return html`<span class="muted">${t("none")}</span>`;
	}
	return html`<ul class="goods">${list.map((g) => html`<li>
		<span class="gname"><${GoodsName} name=${g.goods} /></span>
		<span>${fmtInt(g.storage)} / ${fmtInt(g.max)} ${g.unit || ""}</span>
		${kind === "in" && g.in_transit ? html`<span class="muted"> (+${fmtInt(g.in_transit)} ${t("in_transit")})</span>` : null}
	</li>`)}</ul>`;
}

function FactoryCard({ sel }) {
	useTopics(["factories", "goods", "factory_status"]);
	const key = sel.x + "," + sel.y;
	const f = factoryIndex().get(key);
	const has = canRead("factory");
	const det = useDetails(has ? "f" + key : "f-", () => (has ? apiGet("factory", { x: sel.x, y: sel.y, history: 0 }) : Promise.resolve(null)), 15000);
	const d = det.data && det.data.factory;
	const st = d || (S.factoryStatus && S.factoryStatus.map.get(key)) || null;
	if (!f) {
		return html`<h2 class="card-title">${t("factory")}</h2><p class="muted">${t("unknown")}</p>`;
	}
	return html`<h2 class="card-title">${f.name}</h2>
		<div class="card-sub">${t("factory")} · ${f.type}</div>
		<dl class="kv">
			${st ? html`<${Row} k=${t("status")}><${FactoryStatus} status=${st.status} /><//>
				<${Row} k=${t("productivity")}>${fmtPct(st.productivity)}<//>` : null}
			<${Row} k=${t("production")}>${t("per_day", fmtInt(f.production))}<//>
			<${Row} k=${t("inputs")}><${Goods} list=${f.inputs} kind="in" /><//>
			<${Row} k=${t("outputs")}><${Goods} list=${f.outputs} kind="out" /><//>
			<${Row} k=${t("suppliers")}>${fmtInt(Array.isArray(f.suppliers) ? f.suppliers.length : f.suppliers)}<//>
			<${Row} k=${t("consumers")}>${fmtInt(Array.isArray(f.consumers) ? f.consumers.length : f.consumers)}<//>
			<${Row} k=${t("position")}>${fmtPos(f.pos)}<//>
		</dl>
		<div class="card-actions"><button type="button" class="btn small" onClick=${() => openPanel("factory", key)}>
			<${Icon} name="info" size=${16} />${t("details")}</button></div>`;
}

function CityCard({ sel }) {
	useTopics(["cities"]);
	const c = typeof sel.id === "number" ? cityIndex().map.get(sel.id)
		: ((S.cities && S.cities.cities) || []).find((x) => x.townhall && x.townhall.x === sel.x && x.townhall.y === sel.y);
	if (!c) {
		return html`<h2 class="card-title">${t("city")}</h2><p class="muted">${t("unknown")}</p>`;
	}
	const lm = c.last_month || {};
	return html`<h2 class="card-title">${c.name}</h2>
		<div class="card-sub">${t("city")}${typeof c.id === "number" ? " #" + c.id : ""}</div>
		<dl class="kv">
			<${Row} k=${t("citizens")}>${fmtInt(c.citizens)}${typeof c.growth_this_month === "number"
				? html` <span class="muted">(${t("growth_this_month", (c.growth_this_month > 0 ? "+" : "") + fmtInt(c.growth_this_month))})</span>` : null}<//>
			${typeof c.buildings === "number" ? html`<${Row} k=${t("buildings")}>${fmtInt(c.buildings)}<//>` : null}
			${c.last_month ? html`<${Row} k=${t("pax_share")}>${fmtShare(share(lm.passengers_transported, lm.passengers_generated))}
					<span class="muted"> (${t("last_month")})</span><//>
				<${Row} k=${t("mail_share")}>${fmtShare(share(lm.mail_transported, lm.mail_generated))}<//>` : null}
			<${Row} k=${t("position")}>${fmtPos(c.townhall)}<//>
		</dl>
		${typeof c.id === "number" ? html`<div class="card-actions"><button type="button" class="btn small" onClick=${() => openPanel("city", c.id)}>
			<${Icon} name="info" size=${16} />${t("details")}</button></div>` : null}`;
}

function TileCard({ sel }) {
	const det = useDetails(`t${sel.x},${sel.y}`, () => apiGet("tile", { x: sel.x, y: sel.y }));
	const d = det.data;
	const grounds = (d && d.grounds) || [];
	return html`<h2 class="card-title">${t("tile")} ${sel.x},${sel.y}</h2>
		${d && d.nearest_city ? html`<div class="card-sub">${t("nearest_city")}: ${d.nearest_city.name} (${fmtInt(d.nearest_city.citizens)})</div>` : null}
		${grounds.map((g) => html`<div class="card-section">
			<div class="card-h">${g.type}${g.water ? ` · ${t("water")}` : ""} <span class="muted">z ${g.pos ? g.pos.z : ""}</span></div>
			${g.objects && g.objects.length ? html`<ul class="objs">${g.objects.map((o) => html`<li>
				<span class="otype">${o.type}</span> ${o.name || ""}${typeof o.owner === "number" && o.owner >= 0 ? html` <span class="muted">· ${playerName(o.owner)}</span>` : null}
			</li>`)}</ul>` : null}
		</div>`)}
		${det.error ? html`<p class="error small">${t("load_failed", det.error)}</p>` : !d ? html`<p class="muted small">${t("loading")}</p>` : null}`;
}

/** onLocate(x, y): shows a square in the view the card belongs to (default: the 2D map). */
export function InfoCard({ onLocate } = {}) {
	useTopics(["ui", "lang"]);
	const sel = S.ui.selection;
	if (!sel) {
		return null;
	}
	const body = sel.kind === "convoy" ? html`<${ConvoyCard} sel=${sel} />`
		: sel.kind === "station" ? html`<${StationCard} sel=${sel} />`
		: sel.kind === "factory" ? html`<${FactoryCard} sel=${sel} />`
		: sel.kind === "city" ? html`<${CityCard} sel=${sel} />`
		: html`<${TileCard} sel=${sel} />`;
	const locate = () => {
		let x = sel.x, y = sel.y;
		if (sel.kind === "convoy") {
			const live = convoyLive(sel.id);
			if (live) {
				x = live.x;
				y = live.y;
			}
		}
		if (typeof x === "number") {
			if (onLocate) {
				onLocate(x, y);
			} else {
				mapCtl.locate(x, y);
			}
		}
	};
	return html`<aside class="infocard" aria-live="polite">
		<div class="card-tools">
			<button type="button" class="icon-btn" title=${t("locate")} aria-label=${t("locate")} onClick=${locate}><${Icon} name="locate" /></button>
			<button type="button" class="icon-btn" title=${t("close")} aria-label=${t("close")} onClick=${() => setUi({ selection: null })}><${Icon} name="close" /></button>
		</div>
		${body}
	</aside>`;
}
