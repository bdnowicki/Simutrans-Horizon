// Simutrans-Horizon dashboard: small parts of the Team tab (agent names and avatars, times, state badges, money in USD,
// positions). Artistic License, see LICENSE.txt.
import { html, useState } from "/vendor/htm/standalone.module.js";
import { t, locale } from "/js/i18n.js";
import { AGENTS } from "/js/team/state.js";

export function agentName(id) {
	const key = "team_agent_" + id;
	const s = t(key);
	return s === key ? String(id || "?") : s;
}

/** From this size (CSS pixels) an avatar shows the agent's portrait, below it the role pictogram. */
export const PORTRAIT_MIN = 24;
// pictures of this page: loaded (no letter under them any more) and failed (the letter stays, no retry until a reload)
const picLoaded = new Set();
const picFailed = new Set();

/** URL of the picture of an agent at a size: /img/team/<id>.svg (portrait) or /img/team/<id>-icon.svg (pictogram);
 * null for an unknown agent. */
export function avatarSrc(agent, size) {
	if (!AGENTS.includes(agent)) {
		return null;
	}
	return "/img/team/" + agent + (size >= PORTRAIT_MIN ? "" : "-icon") + ".svg";
}

/** The agent's picture in a fixed round box of the agent's colour: the portrait from 24 px, the role pictogram below.
 * While the picture loads, when it fails (an older deployment, a missing file) and for unknown agents the box shows
 * the first letter of the agent's name. Decorative: the name is always next to it. */
export function Avatar({ agent, size = 28 }) {
	const [, redraw] = useState(0);
	const name = agentName(agent);
	const src = avatarSrc(agent, size);
	const pic = src !== null && !picFailed.has(src);
	const shown = pic && picLoaded.has(src);
	const done = (ok) => {
		(ok ? picLoaded : picFailed).add(src);
		redraw((n) => n + 1);
	};
	return html`<span class=${"team-avatar ag-" + agent + (shown ? " pic" : "")} style=${{ width: size + "px", height: size + "px" }}
		aria-hidden="true">${name.slice(0, 1)}${pic ? html`<img key=${src} class="team-avatar-img" src=${src} alt="" aria-hidden="true"
		width=${size} height=${size} draggable=${false} decoding="async" onLoad=${() => done(true)} onError=${() => done(false)} />` : null}</span>`;
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
