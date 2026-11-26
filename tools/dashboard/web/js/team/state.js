// Simutrans-Horizon dashboard: state of the AI team (Team tab): the team's state, the chats of the agents, questions,
// projects and tasks of the company, read with GET /api/team/* and kept up to date by the team event stream
// (/api/team/events, a second EventSource that only sessions of a company's players open). Actions go out as POST
// /api/team/<action>. The deep links #team, #team/<agent>, #team/board and #team/project/<id> open the tab. Texts of the
// model and of the game are only ever rendered as text nodes (js/team/markdown.js). Artistic License, see LICENSE.txt.
import { S, emit, subscribe, setUi, toast, loadPref, savePref } from "/js/store.js";
import { apiGet, ApiError } from "/js/api.js";
import { t } from "/js/i18n.js";

/** Agent ids in the order of the team (team.roles.AGENTS). */
export const AGENTS = ["coordinator", "analyst", "accountant", "designer", "engineer", "logistician", "dispatcher",
	"fleet_manager"];
export const MAX_TEXT = 4000;
export const ACTIVE_RUN = ["queued", "running", "waiting"];
const PAGE = 50;
const EVENTS = ["hello", "team_delta", "team_message", "team_tool", "team_run", "team_question", "team_task",
	"team_project", "team_usage"];

/** Everything the Team tab shows. Changes are announced with emit("team") (chat deltas: "team_stream"). */
export const T = {
	loaded: false,
	loading: false,
	error: null,
	state: null, // body of GET /api/team/state
	sse: "idle", // idle | connecting | open | closed
	chats: new Map(), // agent -> {messages: [], more, loading, error, loaded}
	newest: new Map(), // agent -> id of the newest message known
	runs: new Map(), // agent -> {run, state, phase, error}
	streams: new Map(), // agent -> {run, text, tools: [{name, summary}]}
	questions: new Map(), // id -> question (present_question)
	projects: new Map(), // id -> project (present_project, the list has no preview)
	full: new Map(), // id -> project with preview (GET /api/team/projects?id=)
	tasks: new Map(), // id -> task
	labels: new Map(), // token id -> label (from the authors of messages)
	drafts: new Map(), // question id -> {values: {item id: value}, other: {item id: text}, open: {item id: bool}}
	sent: new Set(), // "q<id>" / "p<id>": action accepted, waiting for the event that shows the new state
	inputs: new Map(), // agent -> text typed and not sent yet
	focus: null, // {kind: "question"|"project", id}: scroll there when the chat is shown again
};

let rafStream = 0;
function emitStream() {
	if (!rafStream) {
		rafStream = requestAnimationFrame(() => {
			rafStream = 0;
			emit("team_stream");
		});
	}
}

function changed() {
	emit("team");
}

export function isTeam() {
	return !!(S.session && S.session.team);
}

export function company() {
	const st = T.state && T.state.company;
	if (st && typeof st.nr === "number") {
		return st;
	}
	return (S.session && S.session.company) || null;
}

// --- HTTP ---------------------------------------------------------------------------------------------------------

export class TeamError extends ApiError {
	constructor(status, message, reason) {
		super(status, message);
		this.reason = reason || null;
	}
}

/** GET /api/team/<name>?params (with the retries of apiGet). */
export function teamGet(name, params = {}) {
	return apiGet("team/" + name, params);
}

/** Text of a reason code of the team (disabled banner, refused actions). */
export function reasonText(reason) {
	if (!reason) {
		return "";
	}
	const key = "team_reason_" + reason;
	const s = t(key);
	if (s !== key) {
		if (reason === "over_limit") {
			return t(key, resetTime());
		}
		return s;
	}
	return t("team_reason_other", reason);
}

/** POST /api/team/<name> with a JSON body; a failure shows a toast and throws a TeamError (with the reason code). */
export async function teamPost(name, body, label) {
	let r, data = null;
	try {
		try {
			r = await fetch("/api/team/" + name, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json", "X-Dashboard": "1" },
				body: JSON.stringify(body),
			});
		} catch (e) {
			throw new TeamError(0, t("network_error"));
		}
		try {
			data = await r.json();
		} catch (e) { /* not JSON */ }
		if (r.status === 401) {
			location.assign("/");
			throw new TeamError(401, "unauthorized");
		}
		if (!r.ok || !data || data.ok === false) {
			const msg = data && typeof data.error === "string" ? data.error : t("http_error", r.status);
			throw new TeamError(r.status, msg, data && data.reason);
		}
		return data;
	} catch (e) {
		if (e.status !== 401) {
			toast(t("action_failed", label || name, e.reason ? reasonText(e.reason) : e.message));
		}
		throw e;
	}
}

// --- derived values -------------------------------------------------------------------------------------------------

function agentState(id) {
	const list = (T.state && T.state.agents) || [];
	return list.find((a) => a && a.id === id) || null;
}

export function agentModel(id) {
	const a = agentState(id);
	return a && a.model ? a.model : "";
}

/** The run of the agent the chat shows: {run, state, phase, error} or null. */
export function agentRun(id) {
	const r = T.runs.get(id);
	if (r) {
		return r;
	}
	const a = agentState(id);
	if (a && (a.busy || a.run || a.run_id)) {
		// /api/team/state: run = the active run of the agent, run_state = queued | running | waiting
		return { run: a.run || a.run_id || null, state: a.run_state || a.state || (a.busy ? "running" : null),
			phase: a.phase || null };
	}
	return null;
}

export function isBusy(id) {
	const r = agentRun(id);
	return !!(r && (r.state === "queued" || r.state === "running"));
}

/** Pending questions of an agent (all agents with null), newest first. */
export function pendingQuestions(agent = null) {
	const out = [];
	for (const q of T.questions.values()) {
		if (q.state === "pending" && (agent === null || q.agent === agent)) {
			out.push(q);
		}
	}
	return out.sort((a, b) => b.id - a.id);
}

export function pendingCount(agent) {
	if (T.loaded) {
		return pendingQuestions(agent).length;
	}
	const a = agentState(agent);
	return a && typeof a.pending_questions === "number" ? a.pending_questions : 0;
}

export function totalPending() {
	return AGENTS.reduce((n, a) => n + pendingCount(a), 0);
}

export function tokenLabel(id, label) {
	if (label) {
		return label;
	}
	if (typeof id !== "number") {
		return null;
	}
	return T.labels.get(id) || "#" + id;
}

function noteAuthor(m) {
	if (m && m.author && typeof m.author.token_id === "number" && m.author.label) {
		T.labels.set(m.author.token_id, m.author.label);
	}
}

/** Local time of the reset of the daily limit (usage.resets_at), or "". */
export function resetTime() {
	const u = T.state && T.state.usage;
	const d = u && u.resets_at ? new Date(u.resets_at) : null;
	if (!d || Number.isNaN(d.getTime())) {
		return "";
	}
	return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

// --- seen messages (unread dots), per browser and company ---------------------------------------------------------

function seenAll() {
	const v = loadPref("teamSeen", {});
	return v && typeof v === "object" ? v : {};
}

function seenOf() {
	const c = company();
	const all = seenAll();
	const k = c ? String(c.nr) : "?";
	return all[k] && typeof all[k] === "object" ? all[k] : null;
}

function saveSeen(map) {
	const c = company();
	const all = seenAll();
	all[c ? String(c.nr) : "?"] = map;
	savePref("teamSeen", all);
}

/** The newest message of the agent is newer than the one this browser showed last. */
export function isUnread(agent) {
	const n = T.newest.get(agent);
	if (!n) {
		return false;
	}
	const seen = seenOf();
	return !seen || !(seen[agent] >= n);
}

/** The chat of the agent is on screen: everything in it is seen. */
export function markSeen(agent) {
	const n = T.newest.get(agent);
	if (!n) {
		return;
	}
	const seen = seenOf() || {};
	if (seen[agent] >= n) {
		return;
	}
	seen[agent] = n;
	saveSeen(seen);
	changed();
}

function noteNewest(agent, id) {
	if (typeof id === "number" && id > (T.newest.get(agent) || 0)) {
		T.newest.set(agent, id);
	}
}

// --- loading --------------------------------------------------------------------------------------------------------

let loadSeq = 0;

/** Loads the state, questions, projects and tasks (and the newest message of every agent) anew. */
export async function reloadAll() {
	if (!isTeam()) {
		return;
	}
	const seq = ++loadSeq;
	T.loading = true;
	changed();
	try {
		const [st, qs, ps, ts] = await Promise.all([teamGet("state"), teamGet("questions"), teamGet("projects"),
			teamGet("tasks")]);
		if (seq !== loadSeq) {
			return;
		}
		T.state = st;
		T.questions = new Map((qs.questions || []).map((q) => [q.id, q]));
		T.projects = new Map((ps.projects || []).map((p) => [p.id, p]));
		T.full = new Map();
		T.tasks = new Map((ts.tasks || []).map((x) => [x.id, x]));
		const busy = new Map();
		for (const a of st.agents || []) {
			const r = T.runs.get(a.id);
			if (r && ACTIVE_RUN.includes(r.state) && (a.busy || r.state === "waiting")) {
				busy.set(a.id, r); // the run id this page knows from events or from sending
			}
		}
		T.runs = busy;
		for (const [a, s] of Array.from(T.streams)) {
			if (!busy.has(a) || busy.get(a).run !== s.run) {
				T.streams.delete(a);
			}
		}
		// the chats loaded before are read again when shown
		T.chats = new Map();
		const tops = await Promise.all(AGENTS.map((a) => teamGet("chat", { agent: a, limit: 1 })
			.then((r) => [a, r.messages && r.messages.length ? r.messages[r.messages.length - 1].id : 0])
			.catch(() => [a, 0])));
		if (seq !== loadSeq) {
			return;
		}
		for (const [a, id] of tops) {
			noteNewest(a, id);
		}
		if (!seenOf()) {
			// the first visit of this company in this browser: the history so far counts as seen
			const m = {};
			for (const [a, id] of T.newest) {
				m[a] = id;
			}
			saveSeen(m);
		}
		T.loaded = true;
		T.error = null;
	} catch (e) {
		if (seq === loadSeq) {
			T.error = e;
		}
	} finally {
		if (seq === loadSeq) {
			T.loading = false;
			changed();
		}
	}
}

export function ensureLoaded() {
	if (isTeam() && !T.loaded && !T.loading) {
		reloadAll();
	}
}

export async function refreshState() {
	try {
		T.state = await teamGet("state");
		changed();
	} catch (e) { /* keep the old state */ }
}

/** Loads the newest page of an agent's chat (older: the page before the oldest message shown). */
export async function loadChat(agent, older = false) {
	let c = T.chats.get(agent);
	if (c && c.loading) {
		return;
	}
	if (!c) {
		c = { messages: [], more: false, loading: false, error: null, loaded: false };
		T.chats.set(agent, c);
	}
	c.loading = true;
	c.error = null;
	changed();
	const params = { agent, limit: PAGE };
	if (older && c.messages.length) {
		params.before = c.messages[0].id;
	}
	try {
		const r = await teamGet("chat", params);
		if (T.chats.get(agent) !== c) {
			return;
		}
		const got = Array.isArray(r.messages) ? r.messages : [];
		got.forEach(noteAuthor);
		if (older) {
			const have = new Set(c.messages.map((m) => m.id));
			c.messages = got.filter((m) => !have.has(m.id)).concat(c.messages);
		} else {
			// messages that came with events while the page loaded stay
			const ids = new Set(got.map((m) => m.id));
			const top = got.length ? got[got.length - 1].id : 0;
			c.messages = got.concat(c.messages.filter((m) => !ids.has(m.id) && m.id > top));
			c.more = !!r.more;
		}
		if (older) {
			c.more = !!r.more;
		}
		if (c.messages.length) {
			noteNewest(agent, c.messages[c.messages.length - 1].id);
		}
		c.loaded = true;
	} catch (e) {
		c.error = e;
	} finally {
		c.loading = false;
		changed();
	}
}

/** The full project (with its preview) from the cache or GET /api/team/projects?id=. */
export async function fullProject(id) {
	const cached = T.full.get(id);
	const listed = T.projects.get(id);
	if (cached && (!listed || listed.updated === cached.updated)) {
		return cached;
	}
	const r = await teamGet("projects", { id });
	const p = r.project;
	if (p) {
		T.full.set(id, p);
		if (!listed || listed.updated !== p.updated) {
			T.projects.set(id, Object.assign({}, p));
		}
		changed();
	}
	return p;
}

// --- actions --------------------------------------------------------------------------------------------------------

export async function sendMessage(agent, text) {
	const r = await teamPost("send", { agent, text }, t("team_send"));
	if (r && typeof r.run_id === "number") {
		const cur = T.runs.get(agent);
		if (!cur || cur.run !== r.run_id) {
			T.runs.set(agent, { run: r.run_id, state: "queued", phase: null });
		}
	}
	if (r && typeof r.message_id === "number") {
		noteNewest(agent, r.message_id);
		markSeen(agent);
	}
	changed();
	return r;
}

export async function cancelRun(agent) {
	const r = agentRun(agent);
	if (!r || typeof r.run !== "number") {
		return null;
	}
	return teamPost("cancel", { run_id: r.run }, t("team_cancel"));
}

export async function answerQuestion(id, answer) {
	const r = await teamPost("answer", { question_id: id, answer }, t("team_q_send"));
	T.sent.add("q" + id);
	changed();
	return r;
}

export async function dismissQuestion(id) {
	const r = await teamPost("answer", { question_id: id, dismiss: true }, t("team_q_dismiss"));
	T.sent.add("q" + id);
	changed();
	return r;
}

export async function approveProject(id) {
	const r = await teamPost("approve", { project_id: id }, t("team_p_approve"));
	T.sent.add("p" + id);
	changed();
	return r;
}

export async function rejectProject(id, reason) {
	const body = { project_id: id };
	if (reason && reason.trim()) {
		body.reason = reason.trim().slice(0, 1000);
	}
	const r = await teamPost("reject", body, t("team_p_reject"));
	T.sent.add("p" + id);
	changed();
	return r;
}

export function draftOf(qid) {
	let d = T.drafts.get(qid);
	if (!d) {
		d = { values: {}, other: {}, open: {} };
		T.drafts.set(qid, d);
	}
	return d;
}

// --- events ---------------------------------------------------------------------------------------------------------

const FINAL_RUN = ["done", "failed", "cancelled", "interrupted"];

function streamOf(agent, run) {
	let s = T.streams.get(agent);
	if (!s || (run !== undefined && run !== null && s.run !== run)) {
		s = { run: run ?? null, text: "", tools: [] };
		T.streams.set(agent, s);
	}
	return s;
}

function setRun(agent, run, state, phase, error) {
	const old = T.runs.get(agent);
	if (old && old.run !== run && typeof run === "number" && typeof old.run === "number" && run < old.run
		&& ACTIVE_RUN.includes(old.state) && FINAL_RUN.includes(state)) {
		return; // an older run of the agent ended while a newer one is queued
	}
	T.runs.set(agent, { run, state, phase: phase || null, error: error || null });
	const a = agentState(agent);
	if (a) {
		a.busy = state === "queued" || state === "running";
	}
}

export function applyTeamEvent(type, d) {
	if (!d || typeof d !== "object") {
		return;
	}
	switch (type) {
		case "hello":
			if (d.resync !== false) {
				reloadAll();
			}
			break;
		case "team_delta": {
			if (!AGENTS.includes(d.agent) || d.reasoning === true || typeof d.text !== "string") {
				return;
			}
			const s = streamOf(d.agent, d.run);
			s.text += d.text;
			const r = T.runs.get(d.agent);
			if (!r || r.run !== d.run || r.state !== "running" || r.phase !== "writing") {
				setRun(d.agent, d.run, "running", "writing");
				changed();
			}
			emitStream();
			break;
		}
		case "team_tool": {
			if (!AGENTS.includes(d.agent)) {
				return;
			}
			const s = streamOf(d.agent, d.run);
			s.tools = s.tools.concat([{ name: String(d.name || ""), summary: d.summary == null ? "" : String(d.summary) }]).slice(-30);
			emitStream();
			break;
		}
		case "team_run": {
			if (!AGENTS.includes(d.agent)) {
				return;
			}
			setRun(d.agent, d.run, d.state, d.phase, d.error);
			if (FINAL_RUN.includes(d.state) || d.state === "waiting") {
				const s = T.streams.get(d.agent);
				if (s && (s.run === d.run || s.run === null)) {
					T.streams.delete(d.agent);
				}
			}
			changed();
			emitStream();
			break;
		}
		case "team_message": {
			const m = d.message;
			if (!AGENTS.includes(d.agent) || !m || typeof m.id !== "number") {
				return;
			}
			noteAuthor(m);
			noteNewest(d.agent, m.id);
			const c = T.chats.get(d.agent);
			if (c && c.loaded && !c.messages.some((x) => x.id === m.id)) {
				c.messages = c.messages.concat([m]).sort((a, b) => a.id - b.id);
			}
			if (m.role === "assistant") {
				// the streamed text is now part of this message
				const s = T.streams.get(d.agent);
				if (s) {
					s.text = "";
					s.tools = [];
				}
			}
			changed();
			emitStream();
			break;
		}
		case "team_question": {
			const q = d.question;
			if (q && typeof q.id === "number") {
				T.questions.set(q.id, q);
				if (q.state !== "pending") {
					T.sent.delete("q" + q.id);
				}
				changed();
			}
			break;
		}
		case "team_task": {
			const x = d.task;
			if (x && typeof x.id === "number") {
				T.tasks.set(x.id, x);
				changed();
			}
			break;
		}
		case "team_project": {
			const p = d.project;
			if (p && typeof p.id === "number") {
				const old = T.projects.get(p.id);
				T.projects.set(p.id, p);
				const f = T.full.get(p.id);
				if (f && f.updated !== p.updated) {
					// keep the preview (it does not change after the proposal), take the rest
					T.full.set(p.id, Object.assign({}, f, p, { preview: f.preview }));
				}
				if (!old || old.state !== p.state) {
					T.sent.delete("p" + p.id);
				}
				changed();
			}
			break;
		}
		case "team_usage":
			if (d.usage && typeof d.usage === "object") {
				if (T.state) {
					T.state = Object.assign({}, T.state, { usage: d.usage });
				}
				changed();
			}
			break;
		default:
	}
}

// --- event stream -----------------------------------------------------------------------------------------------------

let es = null;
let retryTimer = null;
let retryMs = 3000;

function setSse(state) {
	if (T.sse !== state) {
		T.sse = state;
		changed();
	}
}

export function connectTeamEvents() {
	clearTimeout(retryTimer);
	if (es) {
		es.close();
		es = null;
	}
	if (!isTeam()) {
		setSse("idle");
		return;
	}
	setSse("connecting");
	const src = new EventSource("/api/team/events");
	es = src;
	src.onopen = () => {
		if (es === src) {
			retryMs = 3000;
			setSse("open");
		}
	};
	src.onerror = () => {
		if (es !== src) {
			return;
		}
		if (src.readyState === EventSource.CLOSED) {
			// refused (e.g. 403, 503): the browser gives up; try again later while the session may use the team
			setSse("closed");
			retryTimer = setTimeout(() => {
				if (isTeam()) {
					connectTeamEvents();
				}
			}, retryMs);
			retryMs = Math.min(60000, retryMs * 2);
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
				console.warn("bad team event data", type);
				return;
			}
			if (T.sse !== "open") {
				setSse("open");
			}
			applyTeamEvent(type, data);
		});
	}
}

function disconnect() {
	clearTimeout(retryTimer);
	if (es) {
		es.close();
		es = null;
	}
	setSse("idle");
}

// --- session, deep links --------------------------------------------------------------------------------------------

let sessionKey = null;
subscribe(["session"], () => {
	const key = isTeam() ? "team:" + ((S.session.company && S.session.company.nr) ?? "?") : null;
	if (key === sessionKey) {
		return;
	}
	sessionKey = key;
	T.loaded = false;
	T.state = null;
	T.chats = new Map();
	T.newest = new Map();
	T.runs = new Map();
	T.streams = new Map();
	T.questions = new Map();
	T.projects = new Map();
	T.full = new Map();
	T.tasks = new Map();
	if (key) {
		connectTeamEvents();
		applyLink();
	} else {
		disconnect();
		if (S.ui.tab === "team") {
			setUi({ tab: "map" });
		}
	}
	changed();
});

const LINK = /^#team(?:\/(board|project\/(\d{1,9})|[a-z_]{1,32}))?$/;

/** The team location of the URL hash: {view, agent?, project?} or null. */
export function parseTeamHash(hash = location.hash) {
	const m = LINK.exec(hash);
	if (!m) {
		return null;
	}
	if (!m[1]) {
		return { view: null };
	}
	if (m[1] === "board") {
		return { view: "board" };
	}
	if (m[2]) {
		return { view: "project", project: Number(m[2]) };
	}
	return AGENTS.includes(m[1]) ? { view: "chat", agent: m[1] } : null;
}

let pendingLink = parseTeamHash();

function applyLink() {
	const l = pendingLink;
	if (!l || !S.session) {
		return;
	}
	pendingLink = null;
	if (!isTeam()) {
		return;
	}
	const patch = { tab: "team" };
	if (l.view) {
		patch.teamView = l.view;
	}
	if (l.agent) {
		patch.teamAgent = l.agent;
	}
	if (l.project) {
		patch.teamProject = l.project;
	}
	setUi(patch);
}

window.addEventListener("hashchange", () => {
	const l = parseTeamHash();
	if (l) {
		pendingLink = l;
		applyLink();
	}
});

/** The hash for the team location shown now. */
function teamHash() {
	const v = S.ui.teamView;
	if (v === "board") {
		return "#team/board";
	}
	if (v === "project" && S.ui.teamProject) {
		return "#team/project/" + S.ui.teamProject;
	}
	return "#team/" + S.ui.teamAgent;
}

// the URL follows the Team tab (replaced, no new history entries) while no detail panel uses the hash
subscribe(["ui"], (_, patch) => {
	if (!patch || !("tab" in patch || "teamView" in patch || "teamAgent" in patch || "teamProject" in patch)) {
		return;
	}
	if (S.ui.panel || pendingLink) {
		return;
	}
	const isTeamHash = /^#team(\/|$)/.test(location.hash);
	if (S.ui.tab === "team" && isTeam()) {
		const h = teamHash();
		if (location.hash !== h) {
			history.replaceState(history.state, "", location.pathname + location.search + h);
		}
	} else if (isTeamHash) {
		history.replaceState(history.state, "", location.pathname + location.search);
	}
});

// the agent shown last is remembered per browser
subscribe(["ui"], (_, patch) => {
	if (patch && "teamAgent" in patch && AGENTS.includes(S.ui.teamAgent)) {
		savePref("teamAgent", S.ui.teamAgent);
	}
});

// defaults of the tab (S.ui is created by store.js)
if (!("teamView" in S.ui)) {
	const saved = loadPref("teamAgent", "coordinator");
	Object.assign(S.ui, { teamView: "chat", teamAgent: AGENTS.includes(saved) ? saved : "coordinator", teamProject: null,
		preview3d: null, look3d: null });
}

// for automated tests
window.__team = T;
