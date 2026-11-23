// Simutrans-Horizon dashboard: details fetched on demand (full convoy/line data, one convoy, one line,
// line routes). Artistic License, see LICENSE.txt.
import { S, emit, subscribe, convoyIndex, lineIndex } from "/js/store.js";
import { apiGet, canRead, isMissingCommand } from "/js/api.js";

const inflight = new Map();

// a new month changes profits and histories: cached details are old now; an open table refetches
let staleBefore = 0;
subscribe(["month"], () => {
	staleBefore = Date.now();
	if (S.ui.tab === "convoys" && S.full.convoys) {
		refreshFullConvoys().catch(() => {});
	}
	if (S.ui.tab === "lines" && S.full.lines) {
		refreshFullLines().catch(() => {});
	}
});

function once(key, fn) {
	let p = inflight.get(key);
	if (!p) {
		p = fn().finally(() => inflight.delete(key));
		inflight.set(key, p);
	}
	return p;
}

/** All convoys with details (profit, speed, ...): GET /api/convoys?limit=0. */
export function refreshFullConvoys() {
	return once("convoys", async () => {
		const key = S.worldKey;
		const r = await apiGet("convoys", { limit: 0 });
		if (key !== S.worldKey) {
			return null;
		}
		const m = new Map();
		for (const c of r.convoys || []) {
			m.set(c.id, c);
		}
		S.full.convoys = m;
		S.full.convoysAt = Date.now();
		emit("full_convoys");
		return m;
	});
}

/** All lines with stops and profit: GET /api/lines?limit=0. */
export function refreshFullLines() {
	return once("lines", async () => {
		const key = S.worldKey;
		const r = await apiGet("lines", { limit: 0 });
		if (key !== S.worldKey) {
			return null;
		}
		const m = new Map();
		for (const l of r.lines || []) {
			m.set(l.id, l);
		}
		S.full.lines = m;
		S.full.linesAt = Date.now();
		emit("full_lines");
		return m;
	});
}

/**
 * Details of one item of a list command. The summary feed has the same order as the engine's
 * list, so a small page around the item's index finds it cheaply; otherwise the full list.
 */
async function oneOf(cmd, id, index, cache, maxAge, refreshAll) {
	if (cache && Date.now() - cache.at < maxAge && cache.at > staleBefore && cache.map && cache.map.has(id)) {
		return cache.map.get(id);
	}
	const i = index().order.get(id);
	if (i !== undefined) {
		const offset = Math.max(0, i - 8);
		const r = await apiGet(cmd, { offset, limit: 17 });
		const found = (r[cmd] || []).find((x) => x.id === id);
		if (found) {
			return found;
		}
	}
	const all = await refreshAll();
	return all ? all.get(id) || null : null;
}

export function convoyDetails(id) {
	return oneOf("convoys", id, convoyIndex, { map: S.full.convoys, at: S.full.convoysAt }, 5000, refreshFullConvoys);
}

export function lineDetails(id) {
	return oneOf("lines", id, lineIndex, { map: S.full.lines, at: S.full.linesAt }, 30000, refreshFullLines);
}

/**
 * Route of a line for the map:
 * {id, stops: [{x, y, name, halt, index}], sched: [[x, y] | null] (by schedule index),
 *  legs: [{points: [[x, y], ...], i, j}] (driven legs between schedule entries i and j),
 *  missing: [[i, j], ...] (steps without a known leg), complete, covered, pairs, fallback}.
 * The bridge merges the legs the convoys drive over time (GET /api/line_route?id=); older bridges or
 * engines give only the stops, which the map joins with straight lines.
 */
export async function lineRoute(id) {
	if (!S.session) {
		return null; // not known yet what the bridge allows; loaded again with the session
	}
	if (canRead("line_route")) {
		try {
			const r = await apiGet("line_route", { id });
			if (r.merged && Array.isArray(r.schedule)) {
				const sched = r.schedule.map((s) => (Array.isArray(s.pos) ? [s.pos[0], s.pos[1]] : null));
				const stops = [];
				r.schedule.forEach((s, i) => {
					if (sched[i]) {
						stops.push({ x: sched[i][0], y: sched[i][1], name: s.name || "", halt: s.halt, index: i });
					}
				});
				const legs = (r.legs || []).filter((l) => Array.isArray(l.points) && l.points.length >= 2)
					.map((l) => ({ points: l.points, i: l.from_index, j: l.to_index }));
				return { id, stops, sched, legs, missing: r.missing || [], complete: !!r.complete,
					covered: r.covered || 0, pairs: r.pairs || 0, fallback: false };
			}
		} catch (e) {
			if (!isMissingCommand(e)) {
				throw e;
			}
		}
	}
	const line = await lineDetails(id);
	if (!line) {
		return null;
	}
	const stops = (line.stops || []).filter((s) => s.pos).map((s, i) => ({ x: s.pos.x, y: s.pos.y, name: s.station || "", halt: null, index: i }));
	const sched = stops.map((s) => [s.x, s.y]);
	const missing = [];
	for (let i = 0; i < sched.length && sched.length > 1; i++) {
		missing.push([i, (i + 1) % sched.length]);
	}
	return { id, stops, sched, legs: [], missing, complete: false, covered: 0, pairs: missing.length, fallback: true };
}

/** The leg a convoy drives now: {id, points, index, length, from, to} or null (no route, older engine). */
export async function convoyLeg(id) {
	if (!canRead("line_route")) {
		return null;
	}
	try {
		const r = await apiGet("line_route", { convoy: id });
		if (Array.isArray(r.points) && r.points.length >= 2) {
			return { id, points: r.points, index: r.index, length: r.length, from: r.from, to: r.to };
		}
		return null;
	} catch (e) {
		if (isMissingCommand(e)) {
			return null;
		}
		throw e;
	}
}

/**
 * Status, productivity and served stops of every factory (GET /api/factory_status, made by the bridge
 * from the factory window of each factory and shared by all browsers for 30 s). Kept in S.factoryStatus
 * {at, map: "x,y" -> item} (missing: true when the game lacks the factory command); stays null with an older
 * bridge.
 */
export function refreshFactoryStatus() {
	return once("factory_status", async () => {
		if (!canRead("factory_status")) {
			return null;
		}
		const key = S.worldKey;
		let r;
		try {
			r = await apiGet("factory_status");
		} catch (e) {
			if (!isMissingCommand(e)) {
				throw e;
			}
			S.factoryStatus = { at: Date.now(), map: new Map(), missing: true }; // older game
			emit("factory_status");
			return null;
		}
		if (key !== S.worldKey) {
			return null;
		}
		const m = new Map();
		for (const f of r.factories || []) {
			if (f && typeof f.x === "number" && typeof f.y === "number") {
				m.set(f.x + "," + f.y, f);
			}
		}
		S.factoryStatus = { at: Date.now(), map: m };
		emit("factory_status");
		return m;
	});
}
