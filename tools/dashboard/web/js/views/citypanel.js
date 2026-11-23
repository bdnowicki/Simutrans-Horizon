// Simutrans-Horizon dashboard: detail panel of a city (the game's city window: citizens, growth, jobs and
// homes, passengers and mail of last month, the chart by months or years). Artistic License, see LICENSE.txt.
import { html, useState } from "/vendor/htm/standalone.module.js";
import { S, useTopics, cityIndex } from "/js/store.js";
import { apiGet, canRead, isMissingCommand } from "/js/api.js";
import { useRemote } from "/js/hooks.js";
import { HistoryChart, PeriodSwitch } from "/js/history.js";
import { showCityOnMap } from "/js/map.js";
import { t } from "/js/i18n.js";
import { fmtInt, fmtNum, fmtPct } from "/js/format.js";
import { Icon } from "/js/icons.js";
import { Section, Fig, LoadNote, goToMap } from "/js/views/detailparts.js";

/** Groups of the city chart: one unit per chart; the legend hides single lines. */
export const CITY_GROUPS = () => [
	{ id: "pax", label: t("grp_pax"), unit: "count", cols: ["passengers_generated", "passengers_transported", "passengers_walked"] },
	{ id: "mail", label: t("grp_mail"), unit: "count", cols: ["mail_generated", "mail_transported", "mail_walked"] },
	{ id: "citizens", label: t("grp_citizens"), unit: "count", cols: ["citizens"], stock: true },
	{ id: "growth", label: t("grp_growth"), unit: "count", cols: ["growth"] },
	{ id: "buildings", label: t("grp_buildings"), unit: "count", cols: ["buildings"], stock: true },
	{ id: "goods", label: t("grp_goods"), unit: "count", cols: ["goods_needed", "goods_supplied"] },
	{ id: "cars", label: t("grp_cars"), unit: "count", cols: ["citycars"] },
];

export function cityLabels() {
	return {
		citizens: t("citizens"), growth: t("growth"), buildings: t("buildings"), citycars: t("citycars"),
		passengers_generated: t("col_generated"), passengers_transported: t("col_transported"), passengers_walked: t("col_walked"),
		mail_generated: t("col_generated"), mail_transported: t("col_transported"), mail_walked: t("col_walked"),
		goods_supplied: t("goods_supplied"), goods_needed: t("goods_needed"),
	};
}

/** Part in % (null without a whole). */
export function share(part, whole) {
	return typeof part === "number" && typeof whole === "number" && whole > 0 ? (100 * part) / whole : null;
}

export function fmtShare(v) {
	return v === null ? "–" : fmtNum(v, v < 10 ? 1 : 0) + " %";
}

function signed(v) {
	return typeof v === "number" && v > 0 ? "+" + fmtInt(v) : fmtInt(v);
}

/** Unemployed or homeless: negative numbers mean free jobs or homes. */
function People({ label, value, free }) {
	if (typeof value !== "number") {
		return html`<${Fig} label=${label} value="–" />`;
	}
	return html`<${Fig} label=${label} value=${fmtInt(Math.max(0, value))} sub=${value < 0 ? t(free, fmtInt(-value)) : null} />`;
}

function LastMonth({ lm }) {
	const row = (label, gen, tr, walked) => html`<tr>
		<th>${label}</th><td>${fmtInt(gen)}</td><td>${fmtInt(tr)}</td><td>${walked === undefined ? "–" : fmtInt(walked)}</td>
		<td>${fmtShare(share(tr, gen))}</td></tr>`;
	return html`<table class="mini">
		<thead><tr><th></th><th>${t("col_generated")}</th><th>${t("col_transported")}</th><th>${t("col_walked")}</th><th>${t("share")}</th></tr></thead>
		<tbody>
			${row(t("passengers"), lm.passengers_generated, lm.passengers_transported, lm.passengers_walked)}
			${row(t("mail"), lm.mail_generated, lm.mail_transported, undefined)}
		</tbody>
	</table>
	<p class="muted small">${t("goods_share") + ": " + fmtShare(share(lm.goods_supplied, lm.goods_needed))
		+ " (" + t("goods_supplied") + " " + fmtInt(lm.goods_supplied) + " / " + t("goods_needed") + " " + fmtInt(lm.goods_needed) + ")"}</p>`;
}

export function CityPanel({ id }) {
	useTopics(["cities", "poll", "session", "lang"]);
	const [period, setPeriod] = useState("month");
	const [group, setGroup] = useState("pax");
	const has = canRead("city");
	const det = useRemote(has ? `city:${id}:${S.worldKey}` : null, () => apiGet("city", { id, history: "month" }), { every: 30000 });
	const years = useRemote(has && period === "year" ? `cityy:${id}:${S.worldKey}` : null,
		() => apiGet("city", { id, history: "year" }), { every: 60000 });
	const old = !!S.session && (!has || isMissingCommand(det.error));
	const sum = cityIndex().map.get(id);
	const d = det.data;
	const c = d ? d.city : sum;
	const name = c ? c.name : "#" + id;
	const area = c && c.area;
	const lm = (c && c.last_month) || null;
	const date = S.poll && S.poll.date;
	const history = period === "year" ? years.data && years.data.history : d && d.history;
	const locate = () => goToMap(() => c && showCityOnMap(c));
	return html`<div class="pbody">
		<h2 class="panel-title" tabindex="-1">${name}</h2>
		<div class="panel-sub">${t("city")} #${id}${area ? " · " + t("city_area", area.x2 - area.x1 + 1, area.y2 - area.y1 + 1) : ""}
			${d && d.city.allow_growth === false ? html` <span class="badge">${t("growth_stopped")}</span>` : null}</div>
		<div class="panel-actions">
			<button type="button" class="btn small" disabled=${!c || !c.townhall} onClick=${locate}><${Icon} name="locate" size=${16} />${t("locate_on_map")}</button>
		</div>
		<${LoadNote} error=${old ? (has ? det.error : { status: 403 }) : det.error} loading=${!c} />
		${c ? html`<div class="figs">
			<${Fig} label=${t("citizens")} value=${fmtInt(c.citizens)} sub=${t("growth_this_month", signed(c.growth_this_month))} />
			<${Fig} label=${t("growth_rate")} value=${d ? fmtNum(d.city.growth, 1) : "–"} />
			<${Fig} label=${t("buildings")} value=${fmtInt(c.buildings)} />
			<${Fig} label=${t("pax_share")} value=${lm ? fmtShare(share(lm.passengers_transported, lm.passengers_generated)) : "–"} sub=${t("last_month")} />
			${d ? html`<${People} label=${t("unemployed")} value=${d.city.unemployed} free="free_jobs" />
				<${People} label=${t("homeless")} value=${d.city.homeless} free="free_homes" />` : null}
		</div>` : null}
		${lm ? html`<${Section} title=${t("last_month")}><${LastMonth} lm=${lm} /><//>` : null}
		${area ? html`<p class="muted small">${t("city_limits")}</p>` : null}
		${d ? html`<${Section} title=${t(period === "year" ? "history_years" : "history_12")}>
			<div class="period-row"><${PeriodSwitch} period=${period} onChange=${setPeriod} /></div>
			${history ? html`<${HistoryChart} history=${history} groups=${CITY_GROUPS()} labels=${cityLabels()} date=${date}
				name=${"city-" + id} period=${period} initial=${group} onGroup=${setGroup} hint=${true} />`
				: html`<${LoadNote} error=${years.error} loading=${true} />`}
		<//>` : null}
	</div>`;
}
