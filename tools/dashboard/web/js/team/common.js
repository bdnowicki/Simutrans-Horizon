// Simutrans-Horizon dashboard: small parts of the Team tab (agent names and avatars, times, state badges, money in USD,
// positions). Artistic License, see LICENSE.txt.
import { html } from "/vendor/htm/standalone.module.js";
import { t, locale } from "/js/i18n.js";

export function agentName(id) {
	const key = "team_agent_" + id;
	const s = t(key);
	return s === key ? String(id || "?") : s;
}

/** A round badge with the first letter of the agent's name in the agent's colour. */
export function Avatar({ agent, size = 28 }) {
	const name = agentName(agent);
	return html`<span class=${"team-avatar ag-" + agent} style=${{ width: size + "px", height: size + "px" }} aria-hidden="true">${name.slice(0, 1)}</span>`;
}

const timeFmt = new Map();
function fmt(key, opts) {
	const k = locale() + key;
	let f = timeFmt.get(k);
	if (!f) {
		f = new Intl.DateTimeFormat(locale(), opts);
		timeFmt.set(k, f);
	}
	return f;
}

/** Local time of an ISO time: "14:05" today, else "26 Nov, 14:05". */
export function fmtTime(iso) {
	if (!iso) {
		return "";
	}
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return "";
	}
	const now = new Date();
	if (d.toDateString() === now.toDateString()) {
		return fmt("t", { hour: "2-digit", minute: "2-digit" }).format(d);
	}
	return fmt("dt", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

const usdFmt = new Map();

/** Costs of the AI in US dollars: "$0.125", "$1.50" (Polish: "0,125 USD"). */
export function fmtUsd(v) {
	if (typeof v !== "number" || Number.isNaN(v)) {
		return "–";
	}
	const digits = Math.abs(v) < 1 ? 3 : 2;
	const k = locale() + digits;
	let f = usdFmt.get(k);
	if (!f) {
		f = new Intl.NumberFormat(locale(), { style: "currency", currency: "USD", minimumFractionDigits: 2,
			maximumFractionDigits: digits });
		usdFmt.set(k, f);
	}
	return f.format(v);
}

/** A position of the team's JSON ([x, y], [x, y, z] or {x, y}) as "x,y". */
export function posText(p) {
	if (Array.isArray(p) && p.length >= 2) {
		return p.slice(0, 3).map((n) => String(n)).join(",");
	}
	if (p && typeof p === "object" && typeof p.x === "number") {
		return typeof p.z === "number" ? `${p.x},${p.y},${p.z}` : `${p.x},${p.y}`;
	}
	return p === undefined || p === null ? "?" : String(p);
}

/** State of a project, task, question or run as a coloured badge (always with its name). */
export function StateBadge({ kind, state }) {
	const key = "team_" + kind + "_st_" + state;
	const s = t(key);
	return html`<span class=${"badge team-st st-" + state}>${s === key ? String(state || "?") : s}</span>`;
}
