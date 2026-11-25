// Simutrans-Horizon dashboard: colours of players, lines and convoy states. Artistic License, see LICENSE.txt.

// distinct colours for player numbers 0..15, for engines without the `palette` command
const OWNER = ["#1f6fd1", "#7a7a7a", "#d1491f", "#2f9e44", "#9c36b5", "#e8a200", "#0b9aa8", "#c2255c",
	"#5c7cfa", "#8d6e3f", "#37b24d", "#f76707", "#1098ad", "#ae3ec9", "#495057", "#a61e4d"];

let palette = null; // {colors: ["#rrggbb" x 256], players: Map nr -> css colour, players2: Map nr -> second colour}

/** The game's palette (reply of `palette`, or null): player colours as in the game's minimap. */
export function setPalette(p) {
	if (!p || !Array.isArray(p.colors) || p.colors.length !== 256) {
		palette = null;
		return;
	}
	const colors = p.colors.map((c) => (Array.isArray(c) ? "#" + c.map((v) => (v & 255).toString(16).padStart(2, "0")).join("") : "#000000"));
	const players = new Map(), players2 = new Map();
	for (const pl of p.players || []) {
		if (pl && typeof pl.nr === "number" && typeof pl.minimap_color === "number") {
			players.set(pl.nr, colors[pl.minimap_color & 255]);
		}
		if (pl && typeof pl.nr === "number" && typeof pl.color2 === "number") {
			players2.set(pl.nr, colors[(pl.color2 + 3) & 255]); // the middle of its 8 shades, like minimap_color
		}
	}
	palette = { colors, players, players2 };
}

/** CSS colour of a palette index of the game, or null without a palette. */
export function paletteColor(index) {
	return palette && typeof index === "number" ? palette.colors[index & 255] : null;
}

export function ownerColor(nr) {
	if (typeof nr !== "number" || nr < 0) {
		return "#868e96";
	}
	const c = palette && palette.players.get(nr);
	return c || OWNER[nr % OWNER.length];
}

/** The second company colour of player nr (3D models, material "player2"): the game's when known. */
export function ownerColor2(nr) {
	if (typeof nr !== "number" || nr < 0) {
		return "#868e96";
	}
	const c = palette && palette.players2.get(nr);
	return c || OWNER[(nr + 8) % OWNER.length];
}

const lineCache = new Map();

/** Stable colour per line id (golden angle hues). */
export function lineColor(id) {
	if (!id) {
		return "#868e96";
	}
	let c = lineCache.get(id);
	if (!c) {
		const hue = (id * 137.508) % 360;
		const light = 42 + (id % 3) * 8;
		c = `hsl(${hue.toFixed(1)} 72% ${light}%)`;
		lineCache.set(id, c);
	}
	return c;
}

// state categories: ok, busy, wait, stuck, noroute, depot, other
export const STATE_CATEGORY = {
	driving: "ok", loading: "busy", can_start: "busy", leaving_depot: "depot", entering_depot: "depot",
	in_depot: "depot", waiting_for_clearance: "wait", routing: "other", edit_schedule: "other",
	no_route: "noroute", waiting_for_clearance_one_month: "stuck", waiting_for_clearance_two_months: "stuck",
	can_start_one_month: "stuck", can_start_two_months: "stuck", self_destruct: "other",
};

export const CATEGORY_COLOR = {
	ok: "#2f9e44", busy: "#1c7ed6", wait: "#f08c00", stuck: "#e03131", noroute: "#c2255c",
	depot: "#868e96", other: "#adb5bd",
};

export const CATEGORY_ORDER = ["ok", "busy", "wait", "stuck", "noroute", "depot", "other"];

export function stateCategory(name) {
	return STATE_CATEGORY[name] || "other";
}

export function stateColor(name) {
	return CATEGORY_COLOR[stateCategory(name)];
}

export function isProblem(name) {
	const c = STATE_CATEGORY[name];
	return c === "stuck" || c === "noroute";
}

export function isStuck(name) {
	return STATE_CATEGORY[name] === "stuck";
}
