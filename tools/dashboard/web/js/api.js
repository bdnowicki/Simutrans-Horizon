// Simutrans-Horizon dashboard: HTTP API of the bridge and the event stream. Artistic License, see LICENSE.txt.
import { S, applyEvent, emit, setSse, toast, subscribe } from "/js/store.js";
import { t } from "/js/i18n.js";

export class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

let leaving = false;

function goLogin() {
	if (!leaving) {
		leaving = true;
		location.assign("/");
	}
}

function errorText(status, body) {
	if (body && typeof body.error === "string") {
		return body.error;
	}
	if (status === 429) {
		return t("rate_limited");
	}
	if (status === 502) {
		return t("game_unreachable");
	}
	return t("http_error", status);
}

async function handle(r) {
	let body = null;
	try {
		body = await r.json();
	} catch (e) { /* not JSON */ }
	if (r.status === 401) {
		goLogin();
		throw new ApiError(401, errorText(401, body));
	}
	if (!r.ok || !body || body.ok === false) {
		throw new ApiError(r.status, errorText(r.status, body));
	}
	return body;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// read commands the game answered with "unknown command" (older engine): not asked again until the next
// snapshot (a reconnect, maybe to a newer game)
const unknownCmds = new Set();
subscribe(["snapshot"], () => unknownCmds.clear());

/** Whether the bridge lets this session read the command (older bridges have fewer). */
export function canRead(cmd) {
	const read = S.session && S.session.allowed && S.session.allowed.read;
	return Array.isArray(read) && read.includes(cmd);
}

/** The game or the bridge does not know the command (older engine or bridge): use a fallback. */
export function isMissingCommand(e) {
	return !!e && (e.status === 403 || (e.status === 400 && /unknown command/i.test(e.message || "")));
}

/** GET /api/<cmd>?params. Retries rate limits (429) and a busy game (503) a few times. */
export async function apiGet(cmd, params = {}, retries = 3) {
	const qs = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) {
			qs.set(k, String(v));
		}
	}
	const q = qs.toString();
	if (unknownCmds.has(cmd)) {
		throw new ApiError(400, "unknown command");
	}
	for (let attempt = 0; ; attempt++) {
		let r;
		try {
			r = await fetch(`/api/${cmd}${q ? "?" + q : ""}`, { credentials: "same-origin", cache: "no-store" });
		} catch (e) {
			if (attempt < retries) {
				await sleep(1500);
				continue;
			}
			throw new ApiError(0, t("network_error"));
		}
		if ((r.status === 429 || r.status === 503) && attempt < retries) {
			await sleep(1100 + attempt * 600);
			continue;
		}
		try {
			return await handle(r);
		} catch (e) {
			if (isMissingCommand(e) && e.status === 400) {
				unknownCmds.add(cmd);
			}
			throw e;
		}
	}
}

/** POST /api/<cmd> with a JSON body; shows a toast and rethrows on failure. */
export async function apiAction(cmd, body = {}, label = cmd) {
	try {
		let r;
		try {
			r = await fetch(`/api/${cmd}`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json", "X-Dashboard": "1" },
				body: JSON.stringify(body),
			});
		} catch (e) {
			throw new ApiError(0, t("network_error"));
		}
		return await handle(r);
	} catch (e) {
		if (e.status !== 401) {
			toast(t("action_failed", label, e.message));
		}
		throw e;
	}
}

export async function loadSession() {
	S.session = await apiGet("session");
	emit("session");
	return S.session;
}

export async function logout() {
	try {
		await apiAction("logout", {}, t("logout"));
	} catch (e) { /* go to the login page anyway */ }
	goLogin();
}

// --- event stream --------------------------------------------------------------------------

// month, convoy_states and arrivals come only from bridges/games with events, palette and map_changes
// only with the map export of the game, goods and supply_chain only from games with these commands; the
// rest works without
const EVENTS = ["hello", "snapshot", "poll", "positions", "messages", "players", "lines", "convoys", "stations",
	"factories", "cities", "game", "world", "month", "convoy_states", "arrivals", "palette", "map_changes", "goods",
	"supply_chain"];

let es = null;
let reconnectTimer = null;

export function connectEvents() {
	clearTimeout(reconnectTimer);
	if (es) {
		es.close();
	}
	setSse("connecting");
	const src = new EventSource("/api/events");
	es = src;
	src.onopen = () => {
		if (es === src) {
			setSse("open");
		}
	};
	src.onerror = () => {
		if (es !== src) {
			return;
		}
		if (src.readyState === EventSource.CLOSED) {
			// HTTP error (e.g. 401, 503): EventSource gives up, so check the session and retry
			setSse("closed");
			reconnectTimer = setTimeout(recover, 3000);
		} else {
			setSse("connecting");
		}
	};
	for (const type of EVENTS) {
		src.addEventListener(type, (ev) => {
			if (es !== src) {
				return;
			}
			let data;
			try {
				data = JSON.parse(ev.data);
			} catch (e) {
				console.warn("bad event data", type);
				return;
			}
			if (S.sse !== "open") {
				setSse("open");
			}
			if (type === "hello" && S.session && data.role && data.role !== S.session.role) {
				// signed in again with another token in another tab
				loadSession().catch(() => {});
			}
			applyEvent(type, data);
		});
	}
}

async function recover() {
	try {
		await loadSession();
	} catch (e) {
		if (e.status === 401) {
			return;
		}
	}
	connectEvents();
}
