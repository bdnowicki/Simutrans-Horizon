// Simutrans-Horizon dashboard: building blocks of the detail panels (links between panels, sections,
// figures, load meters). Artistic License, see LICENSE.txt.
import { html } from "/vendor/htm/standalone.module.js";
import { S, setUi, convoyIndex, lineName, playerName, cityName } from "/js/store.js";
import { openPanel, closePanel, factoryId } from "/js/panel.js";
import { goodsColor } from "/js/supply.js";
import { isMissingCommand } from "/js/api.js";
import { t } from "/js/i18n.js";
import { fmtInt, fmtMoney, fmtPct } from "/js/format.js";
import { lineColor, ownerColor } from "/js/colors.js";

export function isNarrow() {
	return window.matchMedia("(max-width: 720px)").matches;
}

/** Switch to the map tab and run fn there; on phones the full-screen panel is closed first. */
export function goToMap(fn) {
	if (isNarrow() && S.ui.panel) {
		closePanel();
	}
	setUi({ tab: "map" });
	requestAnimationFrame(() => fn && fn());
}

export function StationLink({ id, name }) {
	const text = name || (typeof id === "number" ? "#" + id : "–");
	if (typeof id !== "number") {
		return html`<span>${text}</span>`;
	}
	return html`<button type="button" class="linkish" onClick=${() => openPanel("station", id)}>${text}</button>`;
}

export function ConvoyLink({ id, name }) {
	const c = convoyIndex().map.get(id);
	const text = name || (c ? c.name : "#" + id);
	return html`<button type="button" class="linkish" onClick=${() => openPanel("convoy", id)}>${text}</button>`;
}

export function LineLink({ id, name }) {
	if (!id) {
		return html`<span class="muted">${t("no_line")}</span>`;
	}
	return html`<button type="button" class="linkish" onClick=${() => openPanel("line", id)}>
		<span class="swatch" style=${{ background: lineColor(id) }}></span>${name || lineName(id)}</button>`;
}

export function CityLink({ id, name }) {
	if (typeof id !== "number") {
		return html`<span>${name || "–"}</span>`;
	}
	return html`<button type="button" class="linkish" onClick=${() => openPanel("city", id)}>${name || cityName(id)}</button>`;
}

/** Link to a factory panel; pos: {x, y} of the factory. */
export function FactoryLink({ pos, name }) {
	const id = factoryId(pos);
	if (!id) {
		return html`<span>${name || "–"}</span>`;
	}
	return html`<button type="button" class="linkish" onClick=${() => openPanel("factory", id)}>${name || id}</button>`;
}

export const FACTORY_STATES = ["good", "medium", "bad", "inactive", "nothing"];

/** Status of a factory (colour of the game's status bar) with its name, never colour alone. */
export function FactoryStatus({ status }) {
	const known = FACTORY_STATES.includes(status);
	return html`<span class=${"fstatus " + (known ? status : "unknown")}><span class="dot"></span>${t(known ? "fs_" + status : "fs_unknown")}</span>`;
}

/** Name of a goods type with its colour in the game. */
export function GoodsName({ name }) {
	return html`<span class="goods-name"><span class="swatch" style=${{ background: goodsColor(name) }}></span>${name}</span>`;
}

export function Owner({ nr }) {
	return html`<span class="owner"><span class="swatch" style=${{ background: ownerColor(nr) }}></span>${playerName(nr)}</span>`;
}

export function Section({ title, extra, children }) {
	return html`<section class="psec">
		<div class="psec-head"><h3>${title}</h3>${extra ? html`<span class="muted small">${extra}</span>` : null}</div>
		${children}
	</section>`;
}

/** A figure of the panel: label, value, optional second line. kind: "money" colours negative values. */
export function Fig({ label, value, sub, money = false }) {
	const neg = money && typeof value === "number" && value < 0;
	return html`<div class="fig">
		<div class="fig-label">${label}</div>
		<div class=${"fig-value" + (neg ? " neg" : "")}>${money ? fmtMoney(value) : value}</div>
		${sub ? html`<div class="fig-sub">${sub}</div>` : null}
	</div>`;
}

/** Horizontal bar: part of a whole (load of a line, storage of a station). */
export function Meter({ value, max, label, unit, color, text }) {
	const pct = max > 0 ? Math.max(0, Math.min(100, (100 * value) / max)) : 0;
	return html`<div class="meter-row">
		${label ? html`<span class="meter-label">${label}</span>` : null}
		<div class="meter" role="meter" aria-valuemin="0" aria-valuemax=${max || 0} aria-valuenow=${value || 0}
			aria-label=${label || ""}><div class="meter-fill" style=${color ? { width: pct + "%", background: color } : { width: pct + "%" }}></div></div>
		<span class="meter-text">${text !== undefined ? text : fmtInt(value) + " / " + fmtInt(max) + (unit ? " " + unit : "") + (max > 0 ? " · " + fmtPct(pct) : "")}</span>
	</div>`;
}

/** Note for data the game or the bridge cannot give (older versions) or that failed to load. */
export function LoadNote({ error, loading }) {
	if (error) {
		if (isMissingCommand(error)) {
			return html`<p class="note">${t("needs_engine")}</p>`;
		}
		return html`<p class="error small">${t("load_failed", error.message)}</p>`;
	}
	return loading ? html`<p class="muted small">${t("loading")}</p>` : null;
}

/** Schedule entry name: halts link to their panel, depots and waypoints are plain text. */
export function StopName({ entry }) {
	if (typeof entry.halt === "number") {
		return html`<${StationLink} id=${entry.halt} name=${entry.name} />`;
	}
	return html`<span class="muted">${entry.name || (entry.depot ? t("depot") : t("waypoint"))}</span>`;
}

/** Conditions of a schedule entry (minimum load, departures per month). */
export function stopFlags(e) {
	const out = [];
	if (e.wait_for_load > 0) {
		out.push(t("min_load", e.wait_for_load));
	}
	if (typeof e.departures_per_month === "number") {
		out.push(t("departures_month", e.departures_per_month));
	}
	if (e.max_wait_ticks) {
		out.push(t("max_wait"));
	}
	return out.join(" · ");
}
