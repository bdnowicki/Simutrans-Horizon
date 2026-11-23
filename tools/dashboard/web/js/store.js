// Simutrans-Horizon dashboard: client state, event application and change notification.
// Artistic License, see LICENSE.txt.
import { useEffect, useReducer } from "/vendor/htm/standalone.module.js";
import { gameSeconds } from "/js/format.js";
import { setPalette } from "/js/colors.js";

const MAX_MESSAGES = 500;
const MAX_SAMPLES = 4000;

function loadPref(key, fallback) {
	try {
		const v = localStorage.getItem("sdash." + key);
		return v === null ? fallback : JSON.parse(v);
	} catch (e) {
		return fallback;
	}
}

export function savePref(key, value) {
	try {
		localStorage.setItem("sdash." + key, JSON.stringify(value));
	} catch (e) { /* storage blocked */ }
}

/** The whole client state. Feeds are replaced as they arrive; positions are kept in a Map. */
export const S = {
	session: null,
	sse: "connecting",
	game: null,
	poll: null,
	players: null,
	lines: null,
	convoys: null,
	stations: null,
	factories: null,
	cities: null,
	palette: null, // reply of `palette` (colours of the minimap, players), null with older engines
	goods: null, // reply of `goods` (goods types with their colours), null with older engines
	supply_chain: null, // reply of `supply_chain` (factories and their supply links), null with older engines
	factoryStatus: null, // {at, map: "x,y" -> {status, productivity, halts, ...}} from GET /api/factory_status
	positions: { cols: [], states: [], rows: new Map(), idx: {}, ver: 0 },
	messages: [],
	worldKey: null,
	monthKey: null, // year * 12 + month of the newest date seen (poll or month event)
	arrivals: { at: 0, halts: new Set() }, // stops with arrivals in the last arrivals event
	full: { convoys: null, convoysAt: 0, lines: null, linesAt: 0 },
	cash: new Map(), // player nr -> {t: [], v: [], w: []}
	toasts: [],
	ui: {
		tab: "map",
		selection: null, // {kind: "convoy"|"station"|"factory"|"tile"|"city", id, x, y}
		// detail panel {kind: "line"|"convoy"|"station"|"city", id} or {kind: "factory", id: "x,y"}, follows the
		// URL hash (js/panel.js)
		panel: null,
		worldView: loadPref("worldView", "overview"), // sub-view of the world tab: overview, cities, factories
		highlightLine: null,
		colorMode: loadPref("colorMode", "owner"),
		mapMode: loadPref("mapMode", "terrain"), // colours of the base map (minimap mode of the game)
		layers: Object.assign({ stations: true, factories: true, cities: true, convoys: true, labels: true, supply: false },
			loadPref("layers", {})),
		theme: loadPref("theme", "auto"),
	},
};

export const perf = { posApply: [], convoyDraw: [], firstSnapshotAt: null, events: {} };
window.__dashPerf = perf;

// --- change notification -------------------------------------------------------------------

const listeners = new Map();

export function subscribe(topics, fn) {
	for (const t of topics) {
		let set = listeners.get(t);
		if (!set) {
			set = new Set();
			listeners.set(t, set);
		}
		set.add(fn);
	}
	return () => {
		for (const t of topics) {
			listeners.get(t).delete(fn);
		}
	};
}

export function emit(topic, arg) {
	const set = listeners.get(topic);
	if (set) {
		for (const fn of Array.from(set)) {
			try {
				fn(topic, arg);
			} catch (e) {
				console.error(e);
			}
		}
	}
}

/** Re-render the calling component when one of the topics changes. */
export function useTopics(topics) {
	const [, force] = useReducer((x) => x + 1, 0);
	useEffect(() => subscribe(topics, () => force()), [topics.join(",")]);
}

export function setUi(patch) {
	Object.assign(S.ui, patch);
	if ("colorMode" in patch) {
		savePref("colorMode", S.ui.colorMode);
	}
	if ("mapMode" in patch) {
		savePref("mapMode", S.ui.mapMode);
	}
	if ("layers" in patch) {
		savePref("layers", S.ui.layers);
	}
	if ("worldView" in patch) {
		savePref("worldView", S.ui.worldView);
	}
	if ("theme" in patch) {
		savePref("theme", S.ui.theme);
	}
	emit("ui", patch);
}

// --- toasts ---------------------------------------------------------------------------------

let toastId = 0;

export function toast(text, kind = "error") {
	const id = ++toastId;
	S.toasts = S.toasts.concat([{ id, text: String(text), kind }]).slice(-4);
	emit("toasts");
	setTimeout(() => dismissToast(id), 7000);
}

export function dismissToast(id) {
	const n = S.toasts.filter((x) => x.id !== id);
	if (n.length !== S.toasts.length) {
		S.toasts = n;
		emit("toasts");
	}
}

// --- indexes over the feeds (rebuilt when the feed object changes) ------------------------

function indexer(getList, key = "id") {
	let src = null, map = new Map(), order = new Map();
	return () => {
		const list = getList();
		if (list !== src) {
			src = list;
			map = new Map();
			order = new Map();
			(list || []).forEach((it, i) => {
				map.set(it[key], it);
				order.set(it[key], i);
			});
		}
		return { map, order };
	};
}

export const convoyIndex = indexer(() => S.convoys && S.convoys.convoys);
export const lineIndex = indexer(() => S.lines && S.lines.lines);
export const stationIndex = indexer(() => S.stations && S.stations.stations);
export const playerIndex = indexer(() => S.players && S.players.players, "nr");
export const cityIndex = indexer(() => S.cities && S.cities.cities);
export const goodsIndex = indexer(() => S.goods && S.goods.goods, "translated");

let factorySrc = null, factoryMap = new Map();
/** Factories of the feed by "x,y" of their position. */
export function factoryIndex() {
	const list = S.factories && S.factories.factories;
	if (list !== factorySrc) {
		factorySrc = list;
		factoryMap = new Map();
		for (const f of list || []) {
			if (f && f.pos) {
				factoryMap.set(f.pos.x + "," + f.pos.y, f);
			}
		}
	}
	return factoryMap;
}

export function cityName(id) {
	const c = cityIndex().map.get(id);
	return c ? c.name : "#" + id;
}

export function playerName(nr) {
	const p = playerIndex().map.get(nr);
	return p ? p.name : nr === -1 || nr === undefined ? "–" : "#" + nr;
}

export function lineName(id) {
	if (!id) {
		return "";
	}
	const l = lineIndex().map.get(id);
	return l ? l.name : "#" + id;
}

/** Live row of a convoy as an object, or null. */
export function convoyLive(id) {
	const P = S.positions, row = P.rows.get(id);
	if (!row) {
		return null;
	}
	const i = P.idx;
	return {
		id, x: row[i.x], y: row[i.y], z: row[i.z], state: P.states[row[i.state]], owner: row[i.owner],
		line: row[i.line], load: row[i.load],
	};
}

// --- applying bridge events ----------------------------------------------------------------

function worldKeyOf(poll) {
	const w = poll && poll.world;
	if (!w || !w.size_x) {
		return null;
	}
	return `${w.gen}:${w.size_x}x${w.size_y}:${w.rotation}`;
}

function clearWorldData() {
	S.full = { convoys: null, convoysAt: 0, lines: null, linesAt: 0 };
	S.cash = new Map();
	S.monthKey = null;
	S.arrivals = { at: 0, halts: new Set() };
	S.factoryStatus = null;
	S.ui.selection = null;
	S.ui.highlightLine = null;
}

/** Emits "month" once per new game month, whether the poll or the month event shows it first. */
function noteDate(date, yearChanged) {
	if (!date || typeof date.year !== "number" || typeof date.month !== "number") {
		return;
	}
	const key = date.year * 12 + date.month - 1;
	const old = S.monthKey;
	if (old !== null && key <= old) {
		return; // same month, or a poll requested before the month event (another world resets monthKey)
	}
	S.monthKey = key;
	if (old !== null) {
		emit("month", { date, year_changed: yearChanged === undefined ? Math.floor(old / 12) !== date.year : !!yearChanged });
	}
}

/** convoys event of the game: states of convoys between two positions diffs (also in depots). */
function applyConvoyStates(d) {
	const names = d.states || [];
	const changes = d.changes || [];
	const P = S.positions;
	const si = P.idx.state;
	const same = names.length === P.states.length && names.every((n, i) => n === P.states[i]);
	const posIndex = same ? null : new Map(P.states.map((n, i) => [n, i]));
	const summary = convoyIndex().map;
	const full = S.full.convoys;
	let pos = false, sum = false;
	for (const ch of changes) {
		const id = ch[0], name = names[ch[1]];
		if (name === undefined) {
			continue;
		}
		const row = P.rows.get(id);
		if (row && si !== undefined) {
			const i = same ? ch[1] : posIndex.get(name);
			if (i !== undefined && row[si] !== i) {
				row[si] = i;
				pos = true;
			}
		}
		const c = summary.get(id);
		if (c && c.state !== name) {
			c.state = name;
			sum = true;
		}
		const f = full && full.get(id);
		if (f) {
			f.state = name;
		}
	}
	for (const id of d.removed || []) {
		if (P.rows.delete(id)) {
			pos = true;
		}
	}
	if (pos) {
		P.ver++;
		emit("positions");
	}
	if (sum) {
		emit("convoys");
	}
	emit("convoy_states", d);
}

function setPositions(p, replace) {
	const P = S.positions;
	if (!p) {
		P.rows = new Map();
		P.cols = [];
		P.states = [];
		P.ver++;
		return;
	}
	if (replace || p.full) {
		P.rows = new Map();
		P.cols = p.cols || [];
		P.states = p.states || [];
		const idx = {};
		P.cols.forEach((c, i) => { idx[c] = i; });
		P.idx = idx;
	}
	for (const r of p.rows || []) {
		P.rows.set(r[0], r);
	}
	for (const id of p.del || []) {
		P.rows.delete(id);
	}
	P.ver++;
}

function sampleCash(poll) {
	const pl = poll && poll.player;
	if (!pl || typeof pl.cash !== "number") {
		return false;
	}
	const ts = gameSeconds(poll.date, poll.month_progress);
	if (ts === null) {
		return false;
	}
	let s = S.cash.get(pl.nr);
	if (!s) {
		s = { t: [], v: [] };
		S.cash.set(pl.nr, s);
	}
	const n = s.t.length;
	if (n && s.t[n - 1] === ts && s.v[n - 1] === pl.cash) {
		return false;
	}
	if (n && ts < s.t[n - 1]) {
		// time went backwards (another save of the same world): start over
		s.t.length = 0;
		s.v.length = 0;
	}
	if (n && ts === s.t[n - 1]) {
		s.v[n - 1] = pl.cash;
	} else {
		s.t.push(ts);
		s.v.push(pl.cash);
	}
	if (s.t.length > MAX_SAMPLES) {
		// keep every second sample of the older half
		const half = s.t.length >> 1;
		s.t = s.t.filter((_, i) => i >= half || i % 2 === 0);
		s.v = s.v.filter((_, i) => i >= half || i % 2 === 0);
	}
	return true;
}

let schedulesRev;

function setPoll(poll) {
	const rev = poll && poll.rev ? poll.rev.schedules : undefined;
	S.poll = poll;
	if (rev !== schedulesRev) {
		const had = schedulesRev !== undefined;
		schedulesRev = rev;
		if (had) {
			emit("schedules"); // a schedule changed somewhere: routes of lines may be different now
		}
	}
	const key = worldKeyOf(poll);
	if (key && key !== S.worldKey) {
		const had = S.worldKey !== null;
		S.worldKey = key;
		if (had) {
			clearWorldData();
		}
		emit("world", { reset: true });
	}
	if (poll && poll.date) {
		noteDate(poll.date);
	}
	if (sampleCash(poll)) {
		emit("cash");
	}
	emit("poll");
}

const FEEDS = ["players", "lines", "convoys", "stations", "factories", "cities", "palette", "goods", "supply_chain"];

function setFeed(name, value) {
	S[name] = value;
	if (name === "palette") {
		setPalette(value);
	}
}

export function applyEvent(type, data) {
	perf.events[type] = (perf.events[type] || 0) + 1;
	switch (type) {
		case "hello":
			emit("hello", data);
			break;
		case "month": {
			// the game's month event comes before the next poll: show the new month at once
			// (only for the display: the cash samples keep the times of real polls)
			const p = S.poll, d = data.date;
			if (p && p.date && d && d.year * 12 + d.month > p.date.year * 12 + p.date.month) {
				S.poll = Object.assign({}, p, { date: d, month_progress: 0 });
				emit("poll");
			}
			noteDate(d, data.year_changed);
			break;
		}
		case "convoy_states":
			applyConvoyStates(data);
			break;
		case "arrivals": {
			const halts = new Set();
			for (const it of data.items || []) {
				halts.add(it[1]);
			}
			S.arrivals = { at: performance.now(), halts };
			emit("arrivals", data);
			break;
		}
		case "snapshot": {
			const key = worldKeyOf(data.poll);
			const changed = key !== S.worldKey;
			if (changed && S.worldKey !== null) {
				clearWorldData();
			}
			S.worldKey = key;
			for (const f of FEEDS) {
				setFeed(f, data[f] || null);
			}
			S.game = data.game || null;
			setPositions(data.positions, true);
			S.messages = Array.isArray(data.messages) ? data.messages.slice(-MAX_MESSAGES) : [];
			setPoll(data.poll || null);
			emit("world", { reset: changed });
			for (const f of FEEDS) {
				emit(f);
			}
			emit("game");
			emit("positions");
			emit("messages");
			if (perf.firstSnapshotAt === null) {
				perf.firstSnapshotAt = performance.now();
			}
			emit("snapshot");
			break;
		}
		case "poll":
			setPoll(data);
			break;
		case "positions": {
			const t0 = performance.now();
			setPositions(data, false);
			emit("positions");
			const dt = performance.now() - t0;
			perf.posApply.push(dt);
			if (perf.posApply.length > 200) {
				perf.posApply.shift();
			}
			break;
		}
		case "messages":
			if (data.reset) {
				S.messages = (data.messages || []).slice(-MAX_MESSAGES);
			} else {
				S.messages = S.messages.concat(data.messages || []).slice(-MAX_MESSAGES);
			}
			emit("messages");
			break;
		case "game":
			S.game = data;
			emit("game");
			break;
		case "map_changes":
			// {gen, full, chunks: [[cx, cy], ...] of 256 x 256 tiles, world_gen}: load these map parts again
			emit("map_changes", data);
			break;
		case "world":
			// another world: everything tied to object ids is invalid; a snapshot follows
			S.worldKey = null;
			clearWorldData();
			for (const f of FEEDS) {
				// the palette (colours) stays until the snapshot of the new world replaces it
				if (f !== "palette") {
					setFeed(f, null);
				}
			}
			setPositions(null);
			S.messages = [];
			emit("world", { reset: true });
			for (const f of FEEDS) {
				emit(f);
			}
			emit("positions");
			emit("messages");
			emit("ui");
			break;
		default:
			if (FEEDS.includes(type)) {
				setFeed(type, data);
				emit(type);
			}
	}
}

export function setSse(state) {
	if (S.sse !== state) {
		S.sse = state;
		emit("sse");
	}
}

/** Whether the role of this session may POST the command. */
export function canAct(cmd) {
	const a = S.session && S.session.allowed && S.session.allowed.action;
	return Array.isArray(a) && a.includes(cmd);
}
