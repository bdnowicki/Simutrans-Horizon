// Simutrans-Horizon dashboard: detail panel of a line (the game's line window: schedule, convoys,
// capacity, 12-month chart) and its route on the map. Artistic License, see LICENSE.txt.
import { html, useEffect } from "/vendor/htm/standalone.module.js";
import { S, useTopics, setUi, convoyIndex, convoyLive } from "/js/store.js";
import { apiGet, canRead, isMissingCommand } from "/js/api.js";
import { lineDetails } from "/js/data.js";
import { useRemote } from "/js/hooks.js";
import { HistoryChart } from "/js/history.js";
import { mapCtl } from "/js/map.js";
import { highlightOnMap } from "/js/views/lines.js";
import { RouteNote } from "/js/views/mapview.js";
import { t, stateName } from "/js/i18n.js";
import { fmtInt, fmtMoney, fmtPct } from "/js/format.js";
import { lineColor, stateColor, isProblem } from "/js/colors.js";
import { Icon } from "/js/icons.js";
import { Section, Fig, Meter, Owner, ConvoyLink, StopName, stopFlags, LoadNote, goToMap } from "/js/views/detailparts.js";

const GROUPS = () => [
	{ id: "money", label: t("grp_money"), unit: "money", cols: ["revenue", "operation", "profit", "toll"], optional: ["toll"] },
	{ id: "transport", label: t("grp_transport"), unit: "count", cols: ["transported", "free_capacity"] },
	{ id: "convoys", label: t("convoys"), unit: "count", cols: ["convoys"], stock: true },
	{ id: "distance", label: t("col_distance"), unit: "count", cols: ["distance"] },
	{ id: "speed", label: t("col_max_speed"), unit: "kmh", cols: ["max_speed"] },
];

export function colLabels() {
	return {
		revenue: t("revenue"), operation: t("col_operation"), profit: t("profit"), toll: t("col_toll"),
		transported: t("transported"), free_capacity: t("col_free_capacity"), convoys: t("convoys"),
		distance: t("col_distance"), max_speed: t("col_max_speed"), happy: t("happy"), unhappy: t("unhappy"),
		no_route: t("no_route_pax"), walked: t("col_walked"), waiting: t("waiting"), arrived: t("arrived"),
		departed: t("departed"),
	};
}

function ConvoyRows({ ids }) {
	if (!ids.length) {
		return html`<p class="muted small">${t("none")}</p>`;
	}
	const idx = convoyIndex().map;
	const full = S.full.convoys;
	return html`<div class="table-wrap"><table class="data compact">
		<thead><tr><th>${t("name")}</th><th>${t("state")}</th><th class="right">${t("load")}</th>
			${full ? html`<th class="right">${t("profit_short")}</th>` : null}</tr></thead>
		<tbody>${ids.map((id) => {
			const c = idx.get(id);
			const live = convoyLive(id);
			const state = live ? live.state : c ? c.state : null;
			const f = full && full.get(id);
			return html`<tr key=${id}>
				<td class="wrap"><${ConvoyLink} id=${id} /></td>
				<td><span class=${"state" + (isProblem(state) ? " problem" : "")}><span class="dot" style=${{ background: stateColor(state) }}></span>${stateName(state)}</span></td>
				<td class="right">${live ? fmtPct(live.load) : "–"}</td>
				${full ? html`<td class=${"right" + (f && f.profit_this_year < 0 ? " neg" : "")}>${f ? fmtMoney(f.profit_this_year) : "–"}</td>` : null}
			</tr>`;
		})}</tbody>
	</table></div>`;
}

function Schedule({ entries, color }) {
	if (!entries.length) {
		return html`<p class="muted small">${t("none")}</p>`;
	}
	const waiting = entries.some((e) => typeof e.waiting === "number");
	return html`<ol class="sched">${entries.map((e, i) => {
		const flags = stopFlags(e);
		return html`<li key=${i}>
			<span class="sched-nr" style=${{ background: color }}>${i + 1}</span>
			<span class="sched-name"><${StopName} entry=${e} />${flags ? html`<span class="muted small sched-flags">${flags}</span>` : null}</span>
			${waiting ? html`<span class="sched-wait" title=${t("waiting")}>${typeof e.waiting === "number" ? fmtInt(e.waiting) : ""}</span>` : null}
		</li>`;
	})}</ol>`;
}

export function LinePanel({ id }) {
	useTopics(["lines", "convoys", "positions", "players", "route", "full_convoys", "poll", "session", "ui", "lang"]);
	// what the bridge allows is known once the session is loaded (a deep link renders before that)
	const has = canRead("line");
	const det = useRemote(has ? `line:${id}:${S.worldKey}` : null, () => apiGet("line", { id, history: 1 }), { every: 10000 });
	const old = !!S.session && (!has || isMissingCommand(det.error));
	const fb = useRemote(old ? `linefb:${id}:${S.worldKey}` : null, () => lineDetails(id), { every: 30000 });
	// the route of the line is drawn on the map while its panel is open
	useEffect(() => {
		if (S.ui.highlightLine !== id) {
			setUi({ highlightLine: id });
		}
	}, [id]);

	const d = det.data;
	const L = d ? d.line : fb.data;
	const sum = (S.lines && S.lines.lines || []).find((x) => x.id === id);
	const name = L ? L.name : sum ? sum.name : "#" + id;
	const color = lineColor(id);
	const tm = (L && L.this_month) || {};
	const lm = (L && L.last_month) || {};
	const route = mapCtl.route && mapCtl.route.id === id ? mapCtl.route : null;
	const entries = d ? d.schedule || [] : fb.data ? (fb.data.stops || []).map((s) => ({ name: s.station, pos: s.pos })) : [];
	const convoyIds = d ? d.convoys || [] : (S.convoys && S.convoys.convoys || []).filter((c) => c.line === id).map((c) => c.id);
	const date = S.poll && S.poll.date;
	return html`<div class="pbody">
		<h2 class="panel-title" tabindex="-1"><span class="swatch big" style=${{ background: color }}></span>${name}</h2>
		<div class="panel-sub">
			${L && L.type ? html`<span>${L.type}</span> · ` : null}
			<${Owner} nr=${L ? L.owner : sum ? sum.owner : -1} /> · ${t("n_convoys", fmtInt(L ? L.convoys : sum ? sum.convoys : null))}
			${L && L.withdraw ? html` <span class="badge">${t("withdraw")}</span>` : null}
		</div>
		<div class="panel-actions">
			<button type="button" class="btn small" onClick=${() => goToMap(() => highlightOnMap(id))}><${Icon} name="map" size=${16} />${t("show_on_map")}</button>
		</div>
		<${LoadNote} error=${old ? fb.error || (has ? det.error : { status: 403 }) : det.error} loading=${!d && !fb.data} />
		<div class="figs">
			<${Fig} label=${t("line_profit_month")} value=${tm.profit} money=${true} sub=${t("last_month") + ": " + fmtMoney(lm.profit)} />
			<${Fig} label=${t("revenue")} value=${tm.revenue} money=${true} sub=${t("last_month") + ": " + fmtMoney(lm.revenue)} />
			<${Fig} label=${t("transported")} value=${fmtInt(tm.transported)} sub=${t("last_month") + ": " + fmtInt(lm.transported)} />
			<${Fig} label=${t("utilisation")} value=${fmtPct(lm.capacity > 0 ? (100 * lm.transported) / lm.capacity : null)} sub=${t("last_month")} />
		</div>
		${d ? html`<${Section} title=${t("capacity_load")} extra=${(d.goods || []).join(", ")}>
			<${Meter} value=${d.load} max=${d.capacity} label=${t("load")} />
		<//>` : null}
		<${Section} title=${t("route")}>
			${route ? html`<${RouteNote} route=${route} />
				${route.fallback ? null : html`<div class="route-legend small muted"><span class="lg-solid" style=${{ borderColor: color }}></span>${t("route_driven")}
					<span class="lg-dash" style=${{ borderColor: color }}></span>${t("route_unseen")}</div>`}`
			: S.ui.highlightLine !== id ? html`<button type="button" class="btn small" onClick=${() => setUi({ highlightLine: id })}>${t("highlight")}</button>`
			: html`<p class="muted small">${t("loading")}</p>`}
		<//>
		<${Section} title=${t("schedule")} extra=${t("n_stops", entries.length)}>
			<${Schedule} entries=${entries} color=${color} />
		<//>
		<${Section} title=${t("convoys")} extra=${fmtInt(convoyIds.length)}>
			<${ConvoyRows} ids=${convoyIds} />
		<//>
		${d ? html`<${Section} title=${t("history_12")}>
			<${HistoryChart} history=${d.history} groups=${GROUPS()} labels=${colLabels()} date=${date} name=${"line-" + id} />
		<//>` : null}
	</div>`;
}
