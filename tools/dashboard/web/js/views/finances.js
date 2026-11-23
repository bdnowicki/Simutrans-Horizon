// Simutrans-Horizon dashboard: finances tab. With the engine's `finance` command: the monthly and yearly
// history of the game's finance window (per transport type), KPI tiles with the change against the
// period before, and charts; refetched at every new game month. Older engines: tiles from `players`
// and the cash sampled during this session. Artistic License, see LICENSE.txt.
import { html, useState, useMemo } from "/vendor/htm/standalone.module.js";
import { S, useTopics } from "/js/store.js";
import { apiGet, canRead, isMissingCommand } from "/js/api.js";
import { useRemote } from "/js/hooks.js";
import { t, getLang } from "/js/i18n.js";
import { fmtMoney, fmtMoneyShort, fmtInt, fmtDateDay, fmtDate, fmtNum, fmtPct, fmtCountShort, monthBefore } from "/js/format.js";
import { TimeChart, themeKey } from "/js/chart.js";
import { seriesData, chartRows } from "/js/history.js";
import { ownerColor } from "/js/colors.js";

// --- engines without `finance` ---------------------------------------------------------------

function Tile({ label, value, money = true, sub, subValue, tone }) {
	const neg = typeof value === "number" && value < 0;
	return html`<div class=${"kpi" + (tone ? " " + tone : "")}>
		<div class="kpi-label">${label}</div>
		<div class=${"kpi-value" + (money && neg ? " neg" : "")} title=${money ? fmtMoney(value) : fmtInt(value)}>
			${money ? fmtMoneyShort(value) : fmtInt(value)}</div>
		${sub ? html`<div class="kpi-sub">${sub}: <span class=${money && subValue < 0 ? "neg" : ""}>${money ? fmtMoneyShort(subValue) : fmtInt(subValue)}</span></div>` : null}
	</div>`;
}

function CashChart({ nr }) {
	useTopics(["cash", "lang", "theme"]);
	const s = S.cash.get(nr);
	if (!s || s.t.length < 2) {
		return html`<p class="muted">${t("no_samples")}</p>`;
	}
	const series = [{ label: t("cash"), color: "--series-1" }];
	return html`<${TimeChart} series=${series} data=${[s.t.slice(), s.v.slice()]} height=${240} unit="money" x="live"
		version=${themeKey()} />`;
}

function LegacyFinances({ me, nr }) {
	const p = S.poll;
	const tm = (me && me.this_month) || {};
	const lm = (me && me.last_month) || {};
	const cash = p && p.player && p.player.nr === nr ? p.player.cash : me ? me.cash : null;
	return html`<section class="kpis" aria-label=${t("tab_finances")}>
			<${Tile} label=${t("cash")} value=${cash} tone="accent" />
			<${Tile} label=${t("net_wealth")} value=${me && me.net_wealth} />
			<${Tile} label=${t("profit")} value=${tm.profit} sub=${t("last_month")} subValue=${lm.profit} />
			<${Tile} label=${t("operating_profit")} value=${tm.operating_profit} sub=${t("last_month")} subValue=${lm.operating_profit} />
			<${Tile} label=${t("revenue")} value=${tm.revenue} sub=${t("last_month")} subValue=${lm.revenue} />
			<${Tile} label=${t("running_costs")} value=${tm.running_costs} sub=${t("last_month")} subValue=${lm.running_costs} />
			<${Tile} label=${t("maintenance")} value=${tm.infrastructure_maintenance} sub=${t("last_month")} subValue=${lm.infrastructure_maintenance} />
			<${Tile} label=${t("construction")} value=${tm.construction} sub=${t("last_month")} subValue=${lm.construction} />
			<${Tile} label=${t("new_vehicles")} value=${tm.new_vehicles} sub=${t("last_month")} subValue=${lm.new_vehicles} />
			<${Tile} label=${t("transported_passengers")} value=${tm.transported_passengers} money=${false} sub=${t("last_month")} subValue=${lm.transported_passengers} />
			<${Tile} label=${t("transported_mail")} value=${tm.transported_mail} money=${false} sub=${t("last_month")} subValue=${lm.transported_mail} />
			<${Tile} label=${t("transported_goods")} value=${tm.transported_goods} money=${false} sub=${t("last_month")} subValue=${lm.transported_goods} />
			<${Tile} label=${t("lines")} value=${me && me.lines} money=${false} />
			<${Tile} label=${t("convoys")} value=${me && me.convoys} money=${false} />
			<${Tile} label=${t("stations")} value=${me && me.stations} money=${false} />
		</section>
		<section class="panel">
			<h2>${t("cash_chart")}</h2>
			${nr !== null && nr !== undefined ? html`<${CashChart} nr=${nr} />` : null}
			<p class="muted small">${t("chart_note")}</p>
		</section>`;
}

// --- engines with `finance` ------------------------------------------------------------------

const TT = ["all", "road", "rail", "ship", "monorail", "maglev", "tram", "narrowgauge", "air", "other", "powerline"];

/** Change of a value against the period before: arrow, amount, and whether that is good. */
function Delta({ cur, prev, kind, neutral, vs }) {
	if (typeof cur !== "number" || typeof prev !== "number") {
		return html`<div class="kpi-delta muted">–</div>`;
	}
	let d, text, inv = false;
	if (kind === "cost") {
		// costs are negative: compare their size, more costs is worse
		cur = Math.abs(cur);
		prev = Math.abs(prev);
		inv = true;
	}
	if (kind === "pp") {
		d = cur - prev;
		text = fmtNum(Math.abs(d), Math.abs(d) < 1 ? 2 : 1) + " " + t("pp");
	} else if (kind === "abs") {
		// small counts that change sign (growth): the difference, not a percentage
		d = cur - prev;
		text = fmtInt(Math.abs(d));
	} else {
		if (prev === 0) {
			return html`<div class="kpi-delta muted">${cur === 0 ? "= " : ""}${t("vs", vs)}</div>`;
		}
		d = ((cur - prev) / Math.abs(prev)) * 100;
		const a = Math.abs(d);
		text = (a >= 1000 ? fmtCountShort(a) : fmtNum(a, a < 1 ? 2 : a < 10 ? 1 : 0)) + " %";
	}
	const dir = d >= 0.005 ? "up" : d <= -0.005 ? "down" : "flat"; // what rounds to 0 is no change
	const tone = neutral || dir === "flat" ? "" : (dir === "up") !== inv ? " good" : " bad";
	return html`<div class="kpi-delta"><span class=${"delta" + tone}>${dir === "up" ? "▲" : dir === "down" ? "▼" : "="} ${text}</span>
		<span class="muted"> ${t("vs", vs)}</span></div>`;
}

function fmtValue(unit, v, short = true) {
	if (unit === "money") {
		return short ? fmtMoneyShort(v) : fmtMoney(v);
	}
	if (unit === "pct") {
		return typeof v === "number" ? fmtNum(v, Math.abs(v) < 10 ? 2 : 1) + " %" : "–";
	}
	return short ? fmtCountShort(v) : fmtInt(v);
}

export function Kpi({ label, value, prev, unit = "money", kind, neutral, vs, sub, tone }) {
	const neg = unit === "money" && typeof value === "number" && value < 0;
	return html`<div class=${"kpi" + (tone ? " " + tone : "")}>
		<div class="kpi-label" title=${label}>${label}</div>
		<div class=${"kpi-value" + (neg ? " neg" : "")} title=${fmtValue(unit, value, false)}>${fmtValue(unit, value)}</div>
		<${Delta} cur=${value} prev=${prev} kind=${kind} neutral=${neutral} vs=${vs} />
		${sub ? html`<div class="kpi-sub">${sub}</div>` : null}
	</div>`;
}

const CHARTS = () => [
	{ id: "revcost", title: t("chart_revenue_costs"), unit: "money", cols: ["revenue", "running_costs", "maintenance", "toll"] },
	{ id: "profit", title: t("chart_profit"), unit: "money", cols: ["operating_profit", "profit"] },
	{ id: "wealth", title: t("chart_wealth"), unit: "money", cols: ["cash", "net_wealth"], stock: true },
	{ id: "transport", title: t("chart_transported"), unit: "count", cols: ["transported", "delivered"] },
];

const COL_LABEL = () => ({
	revenue: t("revenue"), running_costs: t("running_costs"), maintenance: t("maintenance"), toll: t("col_toll"),
	operating_profit: t("operating_profit"), profit: t("profit"), cash: t("cash"), net_wealth: t("net_wealth"),
	transported: t("transported"), delivered: t("delivered"),
});

function FinanceCharts({ d, period }) {
	useTopics(["theme"]);
	const rows = (period === "year" ? d.year : d.month) || [];
	const labels = COL_LABEL();
	const charts = useMemo(() => CHARTS().map((c) => {
		// toll only when there is any (the game's charts leave empty curves out as well)
		let cols = c.cols.filter((k) => d.columns.includes(k));
		if (c.id === "revcost") {
			const ti = d.columns.indexOf("toll");
			if (ti < 0 || !rows.some((r) => r[ti])) {
				cols = cols.filter((k) => k !== "toll");
			}
		}
		const idx = cols.map((k) => d.columns.indexOf(k));
		const [crows, first] = chartRows(rows, d.date, c.stock, period);
		return Object.assign({}, c, { cols, data: seriesData(crows, idx, first, period) });
	}), [d, period, getLang()]);
	if (!rows.length) {
		return html`<p class="muted">${t("no_history")}</p>`;
	}
	return html`<div class="chart-grid">${charts.map((c) => html`<section class="panel" key=${c.id}>
		<h2>${c.title}</h2>
		<${TimeChart} series=${c.cols.map((k, i) => ({ label: labels[k] || k, color: "--series-" + (i + 1) }))}
			data=${c.data} height=${220} unit=${c.unit} x=${period}
			version=${themeKey() + ":" + period + ":" + c.cols.join(",")} />
	</section>`)}</div>
	<p class="muted small">${t(period === "year" ? "chart_last_year" : "chart_last_month")}</p>`;
}

function FinanceKpis({ d, period, me, nr }) {
	const ci = (k) => d.columns.indexOf(k);
	const rows = (period === "year" ? d.year : d.month) || [];
	const v = (r, k) => (r && ci(k) >= 0 && typeof r[ci(k)] === "number" ? r[ci(k)] : null);
	const [r0, r1, r2] = rows;
	const year = period === "year";
	const last = year ? String(d.date.year - 1) : fmtDate(monthBefore(d.date, 1));
	const before = year ? String(d.date.year - 2) : fmtDate(monthBefore(d.date, 2));
	const p = S.poll;
	const cash = p && p.player && p.player.nr === nr && typeof p.player.cash === "number" ? p.player.cash : v(r0, "cash");
	const wealth = me && typeof me.net_wealth === "number" ? me.net_wealth : v(r0, "net_wealth");
	const sofar = (k, unit = "money") => t(year ? "this_year_so_far" : "this_month_so_far", fmtValue(unit, v(r0, k)));
	const flow = (k, label, unit = "money", extra = {}) => html`<${Kpi} label=${label} value=${v(r1, k)} prev=${v(r2, k)}
		unit=${unit} vs=${before} sub=${sofar(k, unit)} ...${extra} />`;
	return html`
		<p class="kpi-note muted small">${t(year ? "kpi_note_year" : "kpi_note_month", last, before)}</p>
		<section class="kpis" aria-label=${t("tab_finances")}>
			<${Kpi} label=${t("cash")} value=${cash} prev=${v(r1, "cash")} vs=${t("end_of", last)} tone="accent" />
			<${Kpi} label=${t("net_wealth")} value=${wealth} prev=${v(r1, "net_wealth")} vs=${t("end_of", last)} />
			${flow("revenue", t("revenue"))}
			${flow("running_costs", t("running_costs"), "money", { kind: "cost" })}
			${flow("maintenance", t("maintenance"), "money", { kind: "cost" })}
			${flow("operating_profit", t("operating_profit"))}
			${flow("profit", t("profit_gross"))}
			${flow("margin", t("margin"), "pct", { kind: "pp" })}
			${flow("transported", t("transported"), "count")}
			${flow("delivered", t("delivered"), "count")}
			${flow("new_vehicles", t("new_vehicles"), "money", { kind: "cost", neutral: true })}
			${flow("construction", t("construction"), "money", { kind: "cost", neutral: true })}
			<${Kpi} label=${t("assets")} value=${v(r0, "assets")} prev=${v(r1, "assets")} vs=${t("end_of", last)} neutral=${true} />
		</section>
		<p class="muted small">${t("maintenance_now", fmtMoney(d.maintenance_per_month))}${d.overdrawn_months > 0
			? html` · <span class="neg">${t("overdrawn", d.overdrawn_months)}</span>` : null}</p>`;
}

function PlayersTable({ players, nr }) {
	return html`<section class="panel">
		<h2>${t("players_title")}</h2>
		<div class="table-wrap">
			<table class="data">
				<thead><tr>
					<th>${t("player")}</th><th class="right">${t("cash")}</th><th class="right">${t("net_wealth")}</th>
					<th class="right">${t("profit")}</th><th class="right hide-sm">${t("lines")}</th>
					<th class="right hide-sm">${t("convoys")}</th><th class="right hide-sm">${t("stations")}</th>
				</tr></thead>
				<tbody>${players.map((x) => html`<tr class=${x.nr === nr ? "me" : ""}>
					<td><span class="swatch" style=${{ background: ownerColor(x.nr) }}></span>${x.name}
						${x.active_player ? html` <span class="badge">${t("active")}</span>` : null}</td>
					<td class=${"right" + (x.cash < 0 ? " neg" : "")}>${fmtMoneyShort(x.cash)}</td>
					<td class=${"right" + (x.net_wealth < 0 ? " neg" : "")}>${fmtMoneyShort(x.net_wealth)}</td>
					<td class=${"right" + (x.this_month && x.this_month.profit < 0 ? " neg" : "")}>${fmtMoneyShort(x.this_month && x.this_month.profit)}</td>
					<td class="right hide-sm">${fmtInt(x.lines)}</td><td class="right hide-sm">${fmtInt(x.convoys)}</td><td class="right hide-sm">${fmtInt(x.stations)}</td>
				</tr>`)}</tbody>
			</table>
		</div>
	</section>`;
}

export function FinancesView() {
	useTopics(["players", "poll", "lang", "session"]);
	const [tt, setTt] = useState("all");
	const [period, setPeriod] = useState("month");
	const [chosen, setChosen] = useState(null);
	const p = S.poll;
	const players = ((S.players && S.players.players) || []).map((x) => Object.assign({}, x,
		{ active_player: S.players && x.nr === S.players.active_player }));
	const active = S.players ? S.players.active_player : p && p.player ? p.player.nr : null;
	const nr = chosen !== null && players.some((x) => x.nr === chosen) ? chosen : active;
	const me = players.find((x) => x.nr === nr);
	const has = canRead("finance");
	const ok = has && typeof nr === "number" && S.worldKey;
	const fin = useRemote(ok ? `fin:${nr}:${tt}:${S.worldKey}` : null, () => apiGet("finance", { player: nr, tt }), { every: 20000 });
	const old = !!S.session && (!has || isMissingCommand(fin.error));
	const d = !old && fin.data && Array.isArray(fin.data.columns) && fin.data.date ? fin.data : null;
	const ttList = d && Array.isArray(d.tt_list) ? d.tt_list.filter((k) => TT.includes(k)) : ["all"];
	return html`<div class="page">
		<div class="page-head">
			<h1>${me ? me.name : t("tab_finances")}</h1>
			<div class="muted">${p ? fmtDateDay(p.date, p.month_progress) : ""}${p && typeof p.month_progress === "number" ? ` · ${t("month_progress")} ${fmtPct(p.month_progress * 100)}` : ""}</div>
		</div>
		${!old ? html`<div class="fin-controls">
			${players.length > 1 ? html`<label class="field inline"><span class="flabel">${t("player")}</span>
				<select value=${nr ?? ""} onChange=${(e) => setChosen(Number(e.target.value))}>
					${players.map((x) => html`<option value=${x.nr}>${x.name}</option>`)}
				</select></label>` : null}
			<label class="field inline"><span class="flabel">${t("transport")}</span>
				<select value=${tt} onChange=${(e) => setTt(e.target.value)}>
					${(ttList.includes(tt) ? ttList : [tt].concat(ttList)).map((k) => html`<option value=${k}>${t("tt_" + k)}</option>`)}
				</select></label>
			<div class="seg" role="group" aria-label=${t("period")}>
				${["month", "year"].map((k) => html`<button type="button" aria-pressed=${period === k} class=${period === k ? "on" : ""}
					onClick=${() => setPeriod(k)}>${t("period_" + k)}</button>`)}
			</div>
		</div>` : null}
		${old ? html`<${LegacyFinances} me=${me} nr=${nr} />`
			: d ? html`<${FinanceKpis} d=${d} period=${period} me=${me} nr=${nr} /><${FinanceCharts} d=${d} period=${period} />`
			: fin.error ? html`<p class="error">${t("load_failed", fin.error.message)}</p>`
			: html`<p class="muted">${t("loading")}</p>`}
		<${PlayersTable} players=${players} nr=${nr} />
	</div>`;
}
