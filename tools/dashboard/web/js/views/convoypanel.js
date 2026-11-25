// Simutrans-Horizon dashboard: detail panel of a convoy (the game's convoy window: vehicles, schedule,
// freight, 12-month chart) and the leg it drives now on the map; "Follow in 3D" opens the 3D tab following it.
// Artistic License, see LICENSE.txt.
import { html, useEffect } from "/vendor/htm/standalone.module.js";
import { S, useTopics, convoyIndex, convoyLive } from "/js/store.js";
import { apiGet, canRead, isMissingCommand } from "/js/api.js";
import { convoyDetails, convoyLeg } from "/js/data.js";
import { useRemote } from "/js/hooks.js";
import { HistoryChart } from "/js/history.js";
import { mapCtl, showOnMap } from "/js/map.js";
import { colLabels } from "/js/views/linepanel.js";
import { t, stateName } from "/js/i18n.js";
import { fmtInt, fmtMoney, fmtMoneyCents, fmtNum, fmtPct, fmtPos } from "/js/format.js";
import { stateColor, isProblem, lineColor } from "/js/colors.js";
import { Icon } from "/js/icons.js";
import { Section, Fig, Meter, Owner, LineLink, StationLink, StopName, stopFlags, LoadNote, goToMap } from "/js/views/detailparts.js";
import { followIn3D, view3dSupported } from "/js/views/view3d.js";

const GROUPS = () => [
	{ id: "money", label: t("grp_money"), unit: "money", cols: ["revenue", "operation", "profit", "toll"], optional: ["toll"] },
	{ id: "transport", label: t("grp_transport"), unit: "count", cols: ["transported", "free_capacity"] },
	{ id: "distance", label: t("col_distance"), unit: "count", cols: ["distance"] },
	{ id: "speed", label: t("col_max_speed"), unit: "kmh", cols: ["max_speed"] },
];

function age(months) {
	if (typeof months !== "number") {
		return "–";
	}
	const y = Math.floor(months / 12), m = months % 12;
	return y ? t("age_ym", y, m) : t("age_m", m);
}

function Vehicles({ list }) {
	return html`<div class="table-wrap"><table class="data compact">
		<thead><tr><th>${t("vehicle")}</th><th class="right">${t("load")}</th><th class="right">${t("age")}</th>
			<th class="right hide-xs">${t("speed")}</th><th class="right">${t("value")}</th></tr></thead>
		<tbody>${list.map((v, i) => html`<tr key=${i}>
			<td class="wrap">${v.name}${v.retired ? html` <span class="badge" title=${t("retired_long")}>${t("retired")}</span>` : null}
				${v.goods ? html`<div class="muted small">${v.goods}</div>` : null}</td>
			<td class="right">${v.capacity ? `${fmtInt(v.load)} / ${fmtInt(v.capacity)}${v.unit ? " " + v.unit : ""}` : "–"}</td>
			<td class="right">${age(v.age_months)}</td>
			<td class="right hide-xs">${fmtInt(v.speed_kmh)} km/h</td>
			<td class="right">${fmtMoney(v.value)}</td>
		</tr>`)}</tbody>
	</table></div>`;
}

function Freight({ list }) {
	if (!list.length) {
		return html`<p class="muted small">${t("empty_convoy")}</p>`;
	}
	return html`<div class="table-wrap"><table class="data compact">
		<thead><tr><th>${t("goods")}</th><th class="right">${t("amount")}</th><th>${t("destination")}</th><th>${t("via")}</th></tr></thead>
		<tbody>${list.map((f, i) => html`<tr key=${i}>
			<td>${f.goods}</td>
			<td class="right">${fmtInt(f.amount)}${f.unit ? " " + f.unit : ""}</td>
			<td class="wrap"><${StationLink} id=${f.destination_id} name=${f.destination} />${f.factory ? html`<div class="muted small">${f.factory}</div>` : null}</td>
			<td class="wrap">${f.via ? html`<${StationLink} id=${f.via_id} name=${f.via} />` : html`<span class="muted">–</span>`}</td>
		</tr>`)}</tbody>
	</table></div>`;
}

function Schedule({ schedule, color }) {
	const entries = (schedule && schedule.entries) || [];
	if (!entries.length) {
		return html`<p class="muted small">${t("none")}</p>`;
	}
	return html`<ol class="sched">${entries.map((e, i) => {
		const cur = i === schedule.current;
		const flags = stopFlags(e);
		return html`<li key=${i} class=${cur ? "current" : ""} aria-current=${cur ? "step" : undefined}>
			<span class="sched-nr" style=${{ background: color }}>${i + 1}</span>
			<span class="sched-name"><${StopName} entry=${e} />${flags ? html`<span class="muted small sched-flags">${flags}</span>` : null}</span>
			${cur ? html`<span class="badge on">${t("next_stop_short")}</span>` : null}
		</li>`;
	})}</ol>`;
}

/** Draws the leg the convoy drives now on the map while the panel is open. */
function useConvoyLeg(id) {
	const leg = useRemote(canRead("line_route") ? `leg:${id}:${S.worldKey}` : null, () => convoyLeg(id), { every: 10000, topics: [] });
	useEffect(() => {
		mapCtl.setConvoyLeg(leg.data || null);
	}, [leg.data]);
	useEffect(() => () => mapCtl.setConvoyLeg(null), [id]);
	return leg.data;
}

export function ConvoyPanel({ id }) {
	useTopics(["positions", "convoys", "lines", "players", "poll", "session", "lang"]);
	const has = canRead("convoy");
	const det = useRemote(has ? `convoy:${id}:${S.worldKey}` : null, () => apiGet("convoy", { id, history: 1 }), { every: 5000 });
	const old = !!S.session && (!has || isMissingCommand(det.error));
	const fb = useRemote(old ? `convoyfb:${id}:${S.worldKey}` : null, () => convoyDetails(id), { every: 10000 });
	const leg = useConvoyLeg(id);

	const d = det.data;
	const c = d ? d.convoy : fb.data;
	const sum = convoyIndex().map.get(id);
	const live = convoyLive(id);
	const state = live ? live.state : c ? c.state : sum ? sum.state : null;
	const lineId = live ? live.line : c && c.line ? c.line.id : sum ? sum.line : 0;
	const owner = live ? live.owner : c ? c.owner : sum ? sum.owner : -1;
	const pos = live ? { x: live.x, y: live.y, z: live.z } : c ? c.pos : sum ? sum.pos : null;
	const name = c ? c.name : sum ? sum.name : "#" + id;
	const locate = () => goToMap(() => pos && showOnMap({ kind: "convoy", id, x: pos.x, y: pos.y }, { zoom: 4 }));
	const route = c && c.route;
	return html`<div class="pbody">
		<h2 class="panel-title" tabindex="-1">${name}</h2>
		<div class="panel-sub">${t("convoy")} #${id} · <${Owner} nr=${owner} /> · <${LineLink} id=${lineId} name=${c && c.line ? c.line.name : null} /></div>
		<div class="panel-actions">
			<button type="button" class="btn small" disabled=${!pos} onClick=${locate}><${Icon} name="locate" size=${16} />${t("locate_on_map")}</button>
			${view3dSupported() ? html`<button type="button" class="btn small follow3d" onClick=${() => followIn3D(id)}>
				<${Icon} name="follow" size=${16} />${t("follow_3d")}</button>` : null}
		</div>
		<${LoadNote} error=${old ? fb.error || (has ? det.error : { status: 403 }) : det.error} loading=${!c} />
		<div class="figs">
			<${Fig} label=${t("state")} value=${html`<span class=${"state" + (isProblem(state) ? " problem" : "")}><span class="dot" style=${{ background: stateColor(state) }}></span>${stateName(state)}</span>`} />
			<${Fig} label=${t("speed")} value=${c ? fmtInt(c.speed_kmh) + " km/h" : "–"} sub=${c ? t("max_speed") + " " + fmtInt(c.max_speed_kmh) + " km/h" : null} />
			<${Fig} label=${t("load")} value=${fmtPct(live ? live.load : c ? c.loading_level : null)} />
			<${Fig} label=${t("profit_year")} value=${c && c.profit_this_year} money=${true} sub=${c ? t("last_month") + ": " + fmtMoney(c.profit_last_month) : null} />
		</div>
		${route && route.length > 0 ? html`<${Section} title=${t("current_leg")}
			extra=${leg && leg.to ? (leg.to.name || fmtPos({ x: leg.to.pos[0], y: leg.to.pos[1] })) : null}>
			<${Meter} value=${route.index} max=${route.length} label=${t("leg_progress")} />
			${leg ? html`<p class="muted small">${t("leg_on_map")}</p>` : null}
		<//>` : null}
		${d ? html`<${Section} title=${t("details")}>
			<dl class="kv">
				<dt>${t("vehicles")}</dt><dd>${fmtInt(c.vehicles)} · ${t("length_tiles", fmtNum(c.length_tiles, 1))}</dd>
				<dt>${t("power")}</dt><dd>${fmtInt(c.power_kw)} kW</dd>
				<dt>${t("weight")}</dt><dd>${fmtInt(c.weight_t)} t <span class="muted">(${t("empty")} ${fmtInt(c.empty_weight_t)} t)</span></dd>
				<dt>${t("running_cost_km")}</dt><dd>${fmtMoneyCents(c.running_cost_per_km)}</dd>
				<dt>${t("value")}</dt><dd>${fmtMoney(c.value)}</dd>
				<dt>${t("odometer")}</dt><dd>${fmtInt(c.odometer_km)} km</dd>
				<dt>${t("home_depot")}</dt><dd>${c.home_depot ? fmtPos(c.home_depot) : "–"}</dd>
				${c.withdraw || c.no_load ? html`<dt>!</dt><dd>${[c.withdraw ? t("withdraw") : "", c.no_load ? t("no_load") : ""].filter(Boolean).join(" · ")}</dd>` : null}
			</dl>
		<//>
		<${Section} title=${t("vehicles")} extra=${fmtInt((d.vehicles || []).length)}><${Vehicles} list=${d.vehicles || []} /><//>
		<${Section} title=${t("schedule")}><${Schedule} schedule=${d.schedule} color=${lineColor(lineId)} /><//>
		<${Section} title=${t("freight")}><${Freight} list=${d.freight || []} /><//>
		<${Section} title=${t("history_12")}>
			<${HistoryChart} history=${d.history} groups=${GROUPS()} labels=${colLabels()} date=${S.poll && S.poll.date} name=${"convoy-" + id} />
		<//>` : null}
	</div>`;
}
