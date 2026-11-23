// Simutrans-Horizon dashboard: time series charts (uPlot) for live samples and the monthly/yearly
// histories of the game (finance, lines, convoys, stations). Artistic License, see LICENSE.txt.
import { html, useRef, useEffect } from "/vendor/htm/standalone.module.js";
import { getLang, t } from "/js/i18n.js";
import { fmtMoneyAxis, fmtMoney, fmtInt, fmtNum, fmtCountAxis } from "/js/format.js";

const NAMES = {
	en: {
		MMMM: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
		MMM: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
		WWWW: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
		WWW: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
	},
	pl: {
		MMMM: ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"],
		MMM: ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"],
		WWWW: ["niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"],
		WWW: ["nd", "pn", "wt", "śr", "cz", "pt", "sb"],
	},
};

function cssVar(name, fallback) {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return v || fallback;
}

/** Colour of a series: a CSS custom property ("--series-1") or a colour. */
function colorOf(c, i) {
	if (typeof c === "string" && c.startsWith("--")) {
		return cssVar(c, "#2a78d6");
	}
	return c || cssVar("--series-" + ((i % 4) + 1), "#2a78d6");
}

/** Key that changes with the language and the theme: charts are rebuilt with new colours and names. */
export function themeKey() {
	const th = document.documentElement.dataset.theme || "auto";
	const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
	return getLang() + ":" + th + ":" + (dark ? "d" : "l");
}

function valueText(unit, v) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	switch (unit) {
		case "money": return fmtMoney(v);
		case "pct": return fmtNum(v, Math.abs(v) < 10 ? 2 : 1) + " %";
		case "kmh": return fmtInt(v) + " km/h";
		case "mw": return fmtInt(v) + " MW";
		default: return fmtInt(v);
	}
}

function axisText(unit, v, incr, maxAbs) {
	switch (unit) {
		case "money": return fmtMoneyAxis(v, incr, maxAbs);
		case "pct": return fmtNum(v, !(incr > 0) ? 1 : incr >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(incr) - 1e-9))) + " %";
		case "kmh": case "mw": return fmtInt(v);
		default: return fmtCountAxis(v, incr, maxAbs);
	}
}

/**
 * Time chart. series: [{label, color ("--series-1" or a colour), fill}]; data: [xs (unix seconds of game
 * time), ys...]. opts: {unit: "money"|"count"|"pct"|"kmh"|"mw", x: "live"|"month"|"year"}.
 * Returns an object with setData(data) and destroy().
 */
export function createTimeChart(el, series, height = 260, opts = {}) {
	const names = NAMES[getLang()] || NAMES.en;
	const unit = opts.unit || (series.some((s) => s.money) ? "money" : "count");
	const xmode = opts.x || "live";
	const axisColor = cssVar("--muted", "#666");
	const gridColor = cssVar("--grid", "rgba(128,128,128,0.2)");
	const surface = cssVar("--surface", "#fff");
	const xFmt = xmode === "year" ? "{YYYY}" : xmode === "month" ? "{MMM} {YYYY}" : "{YYYY}-{MM}-{DD}";
	const tz = (v) => uPlot.tzDate(new Date(v * 1000), "Etc/UTC");
	const points = xmode !== "live";
	const uopts = {
		width: Math.max(200, el.clientWidth),
		height,
		tzDate: tz,
		fmtDate: (tpl) => uPlot.fmtDate(tpl, names),
		scales: { x: { time: true } },
		legend: { show: true, live: true },
		cursor: { drag: { x: xmode === "live", y: false }, points: { size: 8 } },
		axes: [
			{
				stroke: axisColor, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor },
				space: 64, // room for a label like "Sep 1974" between two ticks
				// game dates: days and months only (the time of day means nothing in the game)
				values: (u, splits, ai, space, incr) => {
					const tpl = xmode === "year" || incr >= 360 * 86400 ? "{YYYY}" : incr >= 28 * 86400 ? "{MMM} {YYYY}" : "{D} {MMM}";
					const f = uPlot.fmtDate(tpl, names);
					let prev = null;
					return splits.map((v) => {
						const s = f(tz(v));
						const out = s === prev ? "" : s;
						prev = s;
						return out;
					});
				},
			},
			{
				stroke: axisColor, grid: { stroke: gridColor, width: 1 }, ticks: { stroke: gridColor },
				// wide enough for the longest tick text (e.g. "2,485.45K")
				size: (u, values) => {
					if (!values || !values.length) {
						return unit === "money" ? 78 : 60;
					}
					const n = Math.max(...values.map((s) => String(s === null || s === undefined ? "" : s).length));
					return Math.max(unit === "money" ? 60 : 44, Math.ceil(n * 7.2) + 18);
				},
				values: (u, vals, ai, space, incr) => {
					const maxAbs = Math.max(...vals.map((v) => Math.abs(v || 0)));
					return vals.map((v) => axisText(unit, v, incr, maxAbs));
				},
			},
		],
		series: [{ label: t(xmode === "year" ? "year" : xmode === "month" ? "month" : "game_date"), value: (u, v) => (v === null ? "–" : uPlot.fmtDate(xFmt, names)(tz(v))) }]
			.concat(series.map((s, i) => {
				const color = colorOf(s.color, i);
				return {
					label: s.label, stroke: color, width: 2, fill: s.fill || undefined,
					points: points ? { show: true, size: 6, width: 2, stroke: color, fill: surface } : { show: false },
					value: (u, v) => valueText(unit, v),
				};
			})),
	};
	const empty = [[]].concat(series.map(() => []));
	const plot = new uPlot(uopts, empty, el);
	const ro = new ResizeObserver(() => {
		const w = el.clientWidth;
		if (w > 0 && w !== plot.width) {
			plot.setSize({ width: w, height });
		}
	});
	ro.observe(el);
	return {
		setData(data) {
			plot.setData(data);
		},
		destroy() {
			ro.disconnect();
			plot.destroy();
		},
	};
}

/** Preact wrapper: recreated when `version` (language, theme, series set) changes, data updated in place. */
export function TimeChart({ series, data, height = 260, version = "", unit, x }) {
	const box = useRef(null);
	const chart = useRef(null);
	useEffect(() => {
		chart.current = createTimeChart(box.current, series, height, { unit, x });
		chart.current.setData(data);
		return () => {
			chart.current.destroy();
			chart.current = null;
		};
	}, [version, series.length, unit, x, height]);
	useEffect(() => {
		if (chart.current) {
			chart.current.setData(data);
		}
	}, [data]);
	return html`<div class="chart" ref=${box}></div>`;
}
