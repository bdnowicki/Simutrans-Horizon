// Simutrans-Horizon dashboard: world tab with three views: the overview (the world statistics of the game's
// city list window by months or years, and the goods with their colours), the cities and the factories tables.
// Artistic License, see LICENSE.txt.
import { html, useState, useMemo } from "/vendor/htm/standalone.module.js";
import { S, useTopics, setUi } from "/js/store.js";
import { apiGet, canRead, isMissingCommand } from "/js/api.js";
import { useRemote } from "/js/hooks.js";
import { TimeChart, themeKey } from "/js/chart.js";
import { chartRows, seriesData, unitText, periodName, PeriodSwitch } from "/js/history.js";
import { Kpi } from "/js/views/finances.js";
import { CitiesView } from "/js/views/cities.js";
import { FactoriesView } from "/js/views/factories.js";
import { goodsColor } from "/js/supply.js";
import { t, getLang } from "/js/i18n.js";
import { fmtInt, fmtDate, fmtDateDay, fmtMoneyCents, monthBefore, collator } from "/js/format.js";

const SUBS = [["overview", "world_overview"], ["cities", "world_cities"], ["factories", "world_factories"]];

const CHARTS = () => [
	{ id: "citizens", title: t("chart_citizens"), unit: "count", cols: ["citizens"], stock: true },
	{ id: "growth", title: t("chart_growth"), unit: "count", cols: ["growth"] },
	{ id: "ratios", title: t("chart_ratios"), unit: "pct", cols: ["passenger_ratio", "mail_ratio", "goods_ratio"] },
	{ id: "generated", title: t("chart_generated"), unit: "count", cols: ["passengers_generated", "mail_generated"] },
	{ id: "goods", title: t("chart_goods"), unit: "count", cols: ["goods_transported"] },
	{ id: "convoys", title: t("chart_convoys"), unit: "count", cols: ["convoys"], stock: true },
	{ id: "citycars", title: t("chart_citycars"), unit: "count", cols: ["citycars"] },
];

const UNITS = { passenger_ratio: "pct", mail_ratio: "pct", goods_ratio: "pct" };

function labels() {
	return {
		citizens: t("citizens"), growth: t("growth"), towns: t("towns"), factories: t("factories_n"), convoys: t("convoys"),
		citycars: t("citycars"), passenger_ratio: t("pax_share"), passengers_generated: t("passengers"),
		mail_ratio: t("mail_share"), mail_generated: t("mail"), goods_ratio: t("goods_share"),
		goods_transported: t("transported_goods"),
	};
}

function WorldKpis({ d, period }) {
	const ci = (k) => d.columns.indexOf(k);
	const v = (r, k) => (r && ci(k) >= 0 && typeof r[ci(k)] === "number" ? r[ci(k)] : null);
	const [r0, r1, r2] = d.rows;
	const year = period === "year";
	const last = year ? String(d.date.year - 1) : fmtDate(monthBefore(d.date, 1));
	const before = year ? String(d.date.year - 2) : fmtDate(monthBefore(d.date, 2));
	const sofar = (k, unit) => t(year ? "this_year_so_far" : "this_month_so_far", unitText(unit, v(r0, k)));
	// flows: the last complete period against the one before; stocks: now against the end of the last period
	const kpiLabel = (k) => (k === "passengers_generated" ? t("passengers_generated") : labels()[k]);
	const flow = (k, unit = "count", extra = {}) => html`<${Kpi} label=${kpiLabel(k)} value=${v(r1, k)} prev=${v(r2, k)}
		unit=${unit} vs=${before} sub=${sofar(k, unit)} ...${extra} />`;
	const stock = (k, extra = {}) => html`<${Kpi} label=${labels()[k]} value=${v(r0, k)} prev=${v(r1, k)} unit="count"
		vs=${t("end_of", last)} ...${extra} />`;
	return html`<p class="kpi-note muted small">${t(year ? "kpi_note_world_year" : "kpi_note_world_month", last, before)}</p>
		<section class="kpis" aria-label=${t("world")}>
			${stock("citizens", { tone: "accent" })}
			${flow("growth", "count", { kind: "abs" })}
			${flow("passenger_ratio", "pct", { kind: "pp" })}
			${flow("mail_ratio", "pct", { kind: "pp" })}
			${flow("goods_ratio", "pct", { kind: "pp" })}
			${flow("passengers_generated")}
			${flow("goods_transported")}
			${stock("convoys", { neutral: true })}
			${stock("towns", { neutral: true })}
			${stock("factories", { neutral: true })}
		</section>`;
}

function WorldCharts({ d, period }) {
	useTopics(["theme"]);
	const lab = labels();
	const charts = useMemo(() => CHARTS().map((c) => {
		const cols = c.cols.filter((k) => d.columns.includes(k));
		const [rows, first] = chartRows(d.rows, d.date, c.stock, period);
		return Object.assign({}, c, { cols, data: seriesData(rows, cols.map((k) => d.columns.indexOf(k)), first, period) });
	}).filter((c) => c.cols.length), [d, period, getLang()]);
	return html`<div class="chart-grid">${charts.map((c) => html`<section class="panel" key=${c.id}>
		<h2>${c.title}</h2>
		<${TimeChart} series=${c.cols.map((k, i) => ({ label: lab[k] || k, color: "--series-" + (i + 1) }))}
			data=${c.data} height=${200} unit=${c.unit} x=${period}
			version=${themeKey() + ":world:" + period + ":" + c.cols.join(",")} />
	</section>`)}</div>
	<p class="muted small">${t(period === "year" ? "chart_complete_year" : "chart_complete")}</p>`;
}

function WorldTable({ d, period }) {
	const lab = labels();
	return html`<div class="table-wrap"><table class="data compact" aria-label=${t("world")}>
		<thead><tr><th>${t(period === "year" ? "year" : "month")}</th>${d.columns.map((k) => html`<th class="right">${lab[k] || k}</th>`)}</tr></thead>
		<tbody>${d.rows.map((r, i) => html`<tr>
			<td>${periodName(d.date, i, period)}${i === 0 ? html` <span class="muted small">(${t("so_far")})</span>` : null}</td>
			${d.columns.map((k, c) => html`<td class="right">${unitText(UNITS[k] || "count", r[c])}</td>`)}
		</tr>`)}</tbody>
	</table></div>`;
}

function GoodsTable() {
	useTopics(["goods", "session", "lang"]);
	const [usedOnly, setUsedOnly] = useState(true);
	const list = S.goods && Array.isArray(S.goods.goods) ? S.goods.goods : null;
	const rows = list ? list.filter((g) => !usedOnly || g.used !== false)
		.slice().sort((a, b) => collator().compare(String(a.translated), String(b.translated))) : [];
	return html`<section class="panel goods-panel">
		<div class="panel-head">
			<h2>${t("goods_list")}</h2>
			${list ? html`<label class="check small"><input type="checkbox" checked=${usedOnly} onChange=${(e) => setUsedOnly(e.target.checked)} />${t("used_only")}</label>` : null}
		</div>
		${!list ? html`<p class="muted small">${S.session && (!canRead("goods") || S.poll) ? t("needs_engine") : t("loading")}</p>`
		: html`<div class="table-wrap"><table class="data compact goods-table">
			<thead><tr><th>${t("goods")}</th><th>${t("col_unit")}</th><th class="hide-sm">${t("col_category")}</th>
				<th class="right">${t("value")}</th><th class="right hide-sm">${t("col_speed_bonus")}</th><th class="right hide-sm">${t("weight")}</th>
				${usedOnly ? null : html`<th class="right">${t("used_only")}</th>`}</tr></thead>
			<tbody>${rows.map((g) => html`<tr key=${g.index}>
				<td class="wrap"><span class="swatch" style=${{ background: goodsColor(g.translated) }}></span>${g.translated}</td>
				<td>${g.unit || "–"}</td><td class="hide-sm wrap">${g.category}</td>
				<td class="right">${fmtMoneyCents(g.value)}</td><td class="right hide-sm">${fmtInt(g.speed_bonus)} %</td>
				<td class="right hide-sm">${fmtInt(g.weight)} kg</td>
				${usedOnly ? null : html`<td class="right">${g.used ? t("yes") : html`<span class="muted">${t("no")}</span>`}</td>`}
			</tr>`)}</tbody>
		</table></div>
		<p class="muted small">${t("value_note")}</p>`}
	</section>`;
}

function WorldOverview() {
	useTopics(["session", "poll", "cities", "lang"]);
	const [period, setPeriod] = useState("month");
	const [table, setTable] = useState(false);
	const has = canRead("world_stats");
	const ws = useRemote(has && S.worldKey ? `ws:${period}:${S.worldKey}` : null, () => apiGet("world_stats", { period }), { every: 60000 });
	const old = !!S.session && (!has || isMissingCommand(ws.error));
	const d = ws.data && Array.isArray(ws.data.rows) && Array.isArray(ws.data.columns) && ws.data.date ? ws.data : null;
	const p = S.poll;
	const cities = (S.cities && S.cities.cities) || [];
	return html`<div class="page">
		<div class="page-head">
			<h1>${t("world")}</h1>
			<div class="muted">${p ? fmtDateDay(p.date, p.month_progress) : ""}</div>
		</div>
		${old ? html`<p class="note">${t("world_needs_engine")}</p>
			<section class="kpis">
				<div class="kpi accent"><div class="kpi-label">${t("citizens")}</div>
					<div class="kpi-value">${fmtInt(cities.reduce((n, c) => n + (c.citizens || 0), 0))}</div></div>
				<div class="kpi"><div class="kpi-label">${t("towns")}</div><div class="kpi-value">${fmtInt(cities.length)}</div></div>
				<div class="kpi"><div class="kpi-label">${t("factories_n")}</div>
					<div class="kpi-value">${fmtInt(S.factories && S.factories.factories ? S.factories.factories.length : null)}</div></div>
			</section>`
		: html`<div class="fin-controls">
				<${PeriodSwitch} period=${period} onChange=${setPeriod} />
				<button type="button" class="btn small" aria-pressed=${table} onClick=${() => setTable(!table)}>${table ? t("show_chart") : t("show_table")}</button>
			</div>
			${d ? html`<${WorldKpis} d=${d} period=${period} />
				${table ? html`<section class="panel"><${WorldTable} d=${d} period=${period} /></section>` : html`<${WorldCharts} d=${d} period=${period} />`}`
			: ws.error ? html`<p class="error">${t("load_failed", ws.error.message)}</p>`
			: html`<p class="muted">${t("loading")}</p>`}`}
		<${GoodsTable} />
	</div>`;
}

export function WorldView({ visible }) {
	useTopics(["ui", "lang"]);
	const sub = SUBS.some(([k]) => k === S.ui.worldView) ? S.ui.worldView : "overview";
	return html`<div class="world">
		<nav class="subtabs" aria-label=${t("world_views")}>
			<div class="seg" role="group" aria-label=${t("world_views")}>
				${SUBS.map(([k, label]) => html`<button type="button" aria-pressed=${sub === k} class=${sub === k ? "on" : ""}
					onClick=${() => setUi({ worldView: k })}>${t(label)}</button>`)}
			</div>
		</nav>
		<div class="world-body">
			${sub === "overview" ? html`<div class="world-scroll">${visible ? html`<${WorldOverview} />` : null}</div>` : null}
			${sub === "cities" ? html`<${CitiesView} visible=${visible} />` : null}
			${sub === "factories" ? html`<${FactoriesView} visible=${visible} />` : null}
		</div>
	</div>`;
}
