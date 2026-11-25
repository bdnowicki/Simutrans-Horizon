// Simutrans-Horizon dashboard: inline SVG icons. Artistic License, see LICENSE.txt.
import { html } from "/vendor/htm/standalone.module.js";

const P = {
	pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
	play: "M8 5l11 7-11 7z",
	ff: "M4 6l8 6-8 6zM12 6l8 6-8 6z",
	map: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
	money: "M4 7h16v10H4zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM4 10a3 3 0 003-3M20 10a3 3 0 01-3-3M4 14a3 3 0 013 3M20 14a3 3 0 00-3 3",
	msg: "M4 5h16v11H9l-5 4z",
	bus: "M6 4h12a2 2 0 012 2v10H4V6a2 2 0 012-2zM4 11h16M7 19v-3M17 19v-3M7.5 14h.01M16.5 14h.01",
	lines: "M5 6a2 2 0 104 0 2 2 0 10-4 0M15 18a2 2 0 104 0 2 2 0 10-4 0M7 8v4a3 3 0 003 3h5",
	close: "M6 6l12 12M18 6L6 18",
	locate: "M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 100 8 4 4 0 100-8",
	layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	sort_up: "M8 14l4-4 4 4",
	sort_down: "M8 10l4 4 4-4",
	fit: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
	back: "M15 5l-7 7 7 7",
	chev: "M9 6l6 6-6 6",
	info: "M12 3a9 9 0 100 18 9 9 0 100-18M12 11v6M12 7.5h.01",
	route: "M6 19a2 2 0 100-4 2 2 0 100 4M18 9a2 2 0 100-4 2 2 0 100 4M8 17h6a3 3 0 000-6h-4a3 3 0 010-6h6",
	station: "M5 4h14v12H5zM5 10h14M8 20l2-4M16 20l-2-4",
	globe: "M12 3a9 9 0 100 18 9 9 0 100-18M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18",
	cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
	rotl: "M4 5v5h5M4.6 10a8 8 0 111.1 6.5",
	rotr: "M20 5v5h-5M19.4 10a8 8 0 10-1.1 6.5",
	plus: "M12 5v14M5 12h14",
	minus: "M5 12h14",
	eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 100-6",
	people: "M9 6a3 3 0 100 6 3 3 0 100-6M3 20a6 6 0 0112 0M17 7a2.5 2.5 0 100 5 2.5 2.5 0 100-5M16 14.2A5 5 0 0121 19",
	follow: "M3 7h12v10H3zM15 10.5l6-3.5v10l-6-3.5",
	tag: "M4 4h8l8 8-8 8-8-8zM8.5 8.5h.01",
	sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
};

const FILLED = new Set(["pause", "play", "ff"]);

export function Icon({ name, size = 18, title }) {
	return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden=${title ? undefined : "true"}
		fill=${FILLED.has(name) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
		${title ? html`<title>${title}</title>` : null}
		<path d=${P[name] || ""} /></svg>`;
}
