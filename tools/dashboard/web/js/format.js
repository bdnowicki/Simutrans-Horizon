// Simutrans-Horizon dashboard: number, money and date formatting. Artistic License, see LICENSE.txt.
import { getLang, locale, monthName, monthsAgo } from "/js/i18n.js";

const cache = new Map();

function nf(key, opts) {
	const k = getLang() + key;
	let f = cache.get(k);
	if (!f) {
		f = new Intl.NumberFormat(locale(), opts);
		cache.set(k, f);
	}
	return f;
}

export function fmtInt(v) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	return nf("i", { maximumFractionDigits: 0 }).format(v);
}

export function fmtNum(v, digits = 1) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	return nf("n" + digits, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
}

/** Money in whole credits: "$1,234" (en) or "1 234 $" (pl). */
export function fmtMoney(v) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	const s = nf("i", { maximumFractionDigits: 0 }).format(Math.round(v));
	if (getLang() === "pl") {
		return s + " $";
	}
	return s.startsWith("-") ? "-$" + s.slice(1) : "$" + s;
}

/** Money with cents: "$1.30" / "1,30 $". */
export function fmtMoneyCents(v) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	const s = nf("m2", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
	if (getLang() === "pl") {
		return s + " $";
	}
	return s.startsWith("-") ? "-$" + s.slice(1) : "$" + s;
}

/** Short money: "$10.1B" / "10,1 mld $". */
export function fmtMoneyShort(v) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	if (Math.abs(v) < 100000) {
		return fmtMoney(v);
	}
	const s = nf("c", { notation: "compact", maximumFractionDigits: 1 }).format(v);
	if (getLang() === "pl") {
		return s + " $";
	}
	return s.startsWith("-") ? "-$" + s.slice(1) : "$" + s;
}

const UNITS = {
	en: [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]],
	pl: [[1e12, " bln"], [1e9, " mld"], [1e6, " mln"], [1e3, " tys."]],
};

/** Money for chart axes: one unit for all ticks, as many decimals as the tick step needs. */
export function fmtMoneyAxis(v, incr, maxAbs) {
	if (v === null || v === undefined) {
		return "";
	}
	const lang = getLang() === "pl" ? "pl" : "en";
	let unit = 1, suffix = "";
	for (const [u, s] of UNITS[lang]) {
		if (maxAbs >= u) {
			unit = u;
			suffix = s;
			break;
		}
	}
	const step = Math.abs(incr || unit) / unit;
	const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
	const s = nf("a" + digits, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v / unit) + suffix;
	if (lang === "pl") {
		return s + " $";
	}
	return s.startsWith("-") ? "-$" + s.slice(1) : "$" + s;
}

/** Counts for chart axes: one unit (K, M, ...) for all ticks. */
export function fmtCountAxis(v, incr, maxAbs) {
	if (v === null || v === undefined) {
		return "";
	}
	const lang = getLang() === "pl" ? "pl" : "en";
	let unit = 1, suffix = "";
	for (const [u, s] of UNITS[lang]) {
		if (maxAbs >= u * 10) {
			unit = u;
			suffix = s;
			break;
		}
	}
	const step = Math.abs(incr || unit) / unit;
	const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
	return nf("a" + digits, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v / unit) + suffix;
}

/** Short count: "12.3K" / "12,3 tys.". */
export function fmtCountShort(v) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	if (Math.abs(v) < 100000) {
		return fmtInt(v);
	}
	return nf("c", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

/** Start of the month `ago` months before date {year, month} as unix seconds (chart x values). */
export function monthSeconds(d, ago = 0) {
	const m = d.year * 12 + d.month - 1 - ago;
	return Date.UTC(Math.floor(m / 12), m % 12, 1) / 1000;
}

/** Date {year, month} `ago` months before d. */
export function monthBefore(d, ago) {
	const m = d.year * 12 + d.month - 1 - ago;
	return { year: Math.floor(m / 12), month: (m % 12) + 1 };
}

/** Start of the year `ago` years before the year of d as unix seconds. */
export function yearSeconds(d, ago = 0) {
	return Date.UTC(d.year - ago, 0, 1) / 1000;
}

export function fmtPct(v) {
	if (v === null || v === undefined || Number.isNaN(v)) {
		return "–";
	}
	return nf("i", { maximumFractionDigits: 0 }).format(v) + " %";
}

export function fmtDate(d) {
	if (!d || !d.year) {
		return "–";
	}
	return `${monthName(d.month)} ${d.year}`;
}

/** Game date with the day estimated from the month progress. */
export function fmtDateDay(d, progress) {
	if (!d || !d.year) {
		return "–";
	}
	if (typeof progress !== "number") {
		return fmtDate(d);
	}
	const days = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
	const day = Math.min(days, 1 + Math.floor(progress * days));
	return getLang() === "pl" ? `${day} ${monthName(d.month)} ${d.year}` : `${monthName(d.month)} ${day}, ${d.year}`;
}

export function monthIndex(d) {
	return d && d.year ? d.year * 12 + (d.month - 1) : null;
}

export function relDate(d, now) {
	const a = monthIndex(d), b = monthIndex(now);
	if (a === null || b === null) {
		return fmtDate(d);
	}
	return monthsAgo(b - a);
}

export function fmtPos(p) {
	if (!p) {
		return "–";
	}
	return p.z === undefined ? `${p.x},${p.y}` : `${p.x},${p.y},${p.z}`;
}

/** Game time as unix seconds (for uPlot time axes): month start + progress of the month. */
export function gameSeconds(d, progress) {
	if (!d || !d.year) {
		return null;
	}
	const start = Date.UTC(d.year, d.month - 1, 1);
	const end = Date.UTC(d.year, d.month, 1);
	return (start + (end - start) * (typeof progress === "number" ? progress : 0)) / 1000;
}

const collators = new Map();
export function collator() {
	let c = collators.get(getLang());
	if (!c) {
		c = new Intl.Collator(locale(), { numeric: true, sensitivity: "base" });
		collators.set(getLang(), c);
	}
	return c;
}
