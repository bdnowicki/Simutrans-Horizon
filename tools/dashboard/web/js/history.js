// Simutrans-Horizon dashboard: history charts of lines, convoys, stations, cities, factories and the world
// (the charts of the game's windows: 12 months or years, row 0 = the running one). Artistic License, see LICENSE.txt.
import { html, useState, useMemo } from "/vendor/htm/standalone.module.js";
import { useTopics } from "/js/store.js";
import { TimeChart, themeKey } from "/js/chart.js";
import { t } from "/js/i18n.js";
import { fmtMoney, fmtInt, fmtNum, fmtDate, monthSeconds, monthBefore, yearSeconds } from "/js/format.js";

/**
 * Rows for a chart: sums of a running month (or year) are partial and would drop at the right edge, so
 * flow charts leave row 0 out; stock values (cash, number of convoys) keep it. Returns [rows, date of
 * the first row returned].
 */
export function chartRows(rows, date, stock, period = "month") {
	if (stock || !rows.length) {
		return [rows, date];
	}
	return [rows.slice(1), period === "year" ? { year: date.year - 1, month: date.month } : monthBefore(date, 1)];
}

/** [xs, ys...] for uPlot from rows (row 0 newest) of the given column indices; oldest first. */
export function seriesData(rows, colIdx, date, period = "month") {
	const n = rows.length;
	const xs = [];
	const ys = colIdx.map(() => []);
	for (let i = n - 1; i >= 0; i--) {
		xs.push(period === "year" ? yearSeconds(date, i) : monthSeconds(date, i));
		colIdx.forEach((c, k) => {
			const v = rows[i] ? rows[i][c] : null;
			ys[k].push(typeof v === "number" ? v : null);
		});
	}
	return [xs].concat(ys);
}

/** Text of a value in a chart table (and elsewhere): units money, kmh, pct, mw, count. */
export function unitText(unit, v) {
	if (typeof v !== "number") {
		return "–";
	}
	switch (unit) {
		case "money": return fmtMoney(v);
		case "kmh": return fmtInt(v) + " km/h";
		case "pct": return fmtNum(v, 2) + " %";
		case "mw": return fmtInt(v) + " MW";
		default: return fmtInt(v);
	}
}

/** Name of row i of a history table (row 0 = the running month or year). */
export function periodName(date, i, period) {
	return period === "year" ? String(date.year - i) : fmtDate(monthBefore(date, i));
}

/**
 * history: {columns, rows} of the game; groups: [{id, label, unit, cols: [key...], optional: [key...],
 * stock}] — one chart per group (one unit per chart), picked with buttons; optional columns are left out
 * when they are all 0; the chart shows complete months unless `stock` (the table shows the running month
 * too). labels: column key -> text; date: {year, month} of row 0; period: "month" or "year" (rows of
 * years); initial: id of the group shown first (onGroup(id) tells the choice, so a parent can keep it);
 * hint: show how to hide a line (charts with 2+ lines).
 */
export function HistoryChart({ history, groups, labels, date, height = 210, name = "history", period = "month", initial, hint,
	onGroup }) {
	useTopics(["lang", "theme"]);
	const [sel, setSel] = useState(initial || null);
	const [table, setTable] = useState(false);
	const valid = !!history && Array.isArray(history.columns) && Array.isArray(history.rows) && !!date;
	const cols = valid ? history.columns : [];
	const empty = (c) => {
		const i = cols.indexOf(c);
		return !history.rows.some((r) => r[i]);
	};
	const avail = groups.map((g) => Object.assign({}, g, {
		cols: g.cols.filter((c) => cols.includes(c) && !((g.optional || []).includes(c) && empty(c))),
	})).filter((g) => g.cols.length);
	const g = avail.find((x) => x.id === sel) || avail[0] || null;
	const idx = g ? g.cols.map((c) => cols.indexOf(c)) : [];
	// new arrays only when the numbers change (panels re-render with every live update)
	const data = useMemo(() => {
		if (!valid || !g) {
			return null;
		}
		const [rows, first] = chartRows(history.rows, date, g.stock, period);
		return seriesData(rows, idx, first, period);
	}, [history, g && g.id, idx.join(","), date && date.year, date && date.month, period]);
	if (!valid || !g) {
		return html`<p class="muted small">${t("no_history")}</p>`;
	}
	const series = g.cols.map((c, i) => ({ label: labels[c] || c, color: "--series-" + (i + 1) }));
	return html`<div class="history">
		<div class="history-bar">
			${avail.length > 1 ? html`<div class="seg wrap" role="group" aria-label=${t("chart_choice")}>
				${avail.map((x) => html`<button type="button" aria-pressed=${x.id === g.id} class=${x.id === g.id ? "on" : ""}
					onClick=${() => { setSel(x.id); if (onGroup) { onGroup(x.id); } }}>${x.label}</button>`)}
			</div>` : html`<span></span>`}
			<button type="button" class="btn small" aria-pressed=${table} onClick=${() => setTable(!table)}>
				${table ? t("show_chart") : t("show_table")}</button>
		</div>
		${table ? html`<div class="table-wrap"><table class="data compact" aria-label=${name}>
			<thead><tr><th>${t(period === "year" ? "year" : "month")}</th>${g.cols.map((c) => html`<th class="right">${labels[c] || c}</th>`)}</tr></thead>
			<tbody>${history.rows.map((r, i) => html`<tr>
				<td>${periodName(date, i, period)}${i === 0 ? html` <span class="muted small">(${t("so_far")})</span>` : null}</td>
				${idx.map((c) => html`<td class=${"right" + (g.unit === "money" && r[c] < 0 ? " neg" : "")}>${unitText(g.unit, r[c])}</td>`)}
			</tr>`)}</tbody>
		</table></div>`
		: html`<${TimeChart} series=${series} data=${data} height=${height} unit=${g.unit} x=${period}
			version=${themeKey() + ":" + name + ":" + period + ":" + g.id + ":" + g.cols.join(",")} />
			${g.stock ? null : html`<p class="muted small chart-note">${t(period === "year" ? "chart_complete_year" : "chart_complete")}</p>`}
			${hint && g.cols.length > 1 ? html`<p class="muted small chart-note">${t("legend_hint")}</p>` : null}`}
	</div>`;
}

/** Month / year switch of the city and world charts. */
export function PeriodSwitch({ period, onChange }) {
	return html`<div class="seg" role="group" aria-label=${t("period")}>
		${["month", "year"].map((k) => html`<button type="button" aria-pressed=${period === k} class=${period === k ? "on" : ""}
			onClick=${() => onChange(k)}>${t("period_" + k)}</button>`)}
	</div>`;
}
