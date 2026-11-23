// Simutrans-Horizon dashboard: which detail panel is open (line, convoy, station, city, factory). The panel
// follows the URL hash (#line/12, #convoy/81, #station/46, #city/8, #factory/399,827), so a reload restores
// it and the browser's back button goes back through the panels. Artistic License, see LICENSE.txt.
import { S, emit, subscribe } from "/js/store.js";

export const PANEL_KINDS = ["line", "convoy", "station", "city", "factory"];

const FACTORY_ID = /^(\d{1,5}),(\d{1,5})$/;

function parseHash() {
	const m = /^#(line|convoy|station|city)\/(\d{1,9})$/.exec(location.hash);
	if (m) {
		return { kind: m[1], id: Number(m[2]) };
	}
	const f = /^#factory\/(\d{1,5},\d{1,5})$/.exec(location.hash);
	return f ? { kind: "factory", id: f[1] } : null;
}

/** Id of a factory panel: "x,y" of the factory's position (from "x,y", {x, y} or [x, y]), or null. */
export function factoryId(v) {
	if (v && typeof v === "object") {
		const x = Array.isArray(v) ? v[0] : v.x, y = Array.isArray(v) ? v[1] : v.y;
		v = x + "," + y;
	}
	const m = typeof v === "string" ? FACTORY_ID.exec(v) : null;
	return m ? Number(m[1]) + "," + Number(m[2]) : null;
}

/** Number of panel entries this page pushed onto the history below the current one (0: none). */
function depth() {
	const st = history.state;
	return st && typeof st.sdash === "number" ? st.sdash : 0;
}

function same(a, b) {
	return a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id);
}

function apply() {
	const p = parseHash();
	if (same(p, S.ui.panel)) {
		return;
	}
	S.ui.panel = p;
	emit("ui", { panel: p });
}

export function openPanel(kind, id) {
	if (!PANEL_KINDS.includes(kind)) {
		return;
	}
	if (kind === "factory") {
		id = factoryId(id);
		if (id === null) {
			return;
		}
	} else {
		id = Number(id);
		if (!Number.isInteger(id) || id < 0) {
			return;
		}
	}
	if (same(S.ui.panel, { kind, id })) {
		return;
	}
	history.pushState({ sdash: depth() + 1 }, "", "#" + kind + "/" + id);
	apply();
}

/** True when another panel was open before this one (the back button then returns to it). */
export function hasPanelBefore() {
	return depth() > 1;
}

export function panelBack() {
	if (depth() > 0) {
		history.back();
	} else {
		closePanel();
	}
}

export function closePanel() {
	const d = depth();
	if (d > 0) {
		history.go(-d);
	} else {
		history.replaceState(null, "", location.pathname + location.search);
		apply();
	}
}

window.addEventListener("popstate", apply);
window.addEventListener("hashchange", apply);
apply(); // deep link

// ids belong to one world: close the panel when another world is loaded
let worldKey = null;
subscribe(["world"], () => {
	if (S.worldKey === null) {
		return;
	}
	if (worldKey !== null && worldKey !== S.worldKey && S.ui.panel) {
		closePanel();
	}
	worldKey = S.worldKey;
});
