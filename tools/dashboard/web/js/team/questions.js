// Simutrans-Horizon dashboard: question cards of the AI team (the agents' ask_user). One card holds 1-4 questions of the
// types choice (one or several options with descriptions, the recommended one first, "Other" with own text), text, number
// (min/max), map (a square, an area or points A and B, picked on the 2D map) and object (a line, station, convoy or
// factory from a list or picked on the map). All answers go out together (POST /api/team/answer); "Dismiss" ends the
// question without an answer. Answered and dismissed cards show the answer and who gave it. Drafts live in T.drafts, so a
// pick on the map (another tab) keeps them. Artistic License, see LICENSE.txt.
import { html, useReducer, useState } from "/vendor/htm/standalone.module.js";
import { S, setUi, emit, useTopics, lineName, convoyIndex, stationIndex, factoryIndex, playerName } from "/js/store.js";
import { mapCtl } from "/js/map.js";
import { t } from "/js/i18n.js";
import { collator } from "/js/format.js";
import { ownerColor } from "/js/colors.js";
import { Icon } from "/js/icons.js";
import { T, draftOf, answerQuestion, dismissQuestion, tokenLabel, company } from "/js/team/state.js";
import { markdown } from "/js/team/markdown.js";
import { agentName, fmtTime, StateBadge } from "/js/team/common.js";

const OTHER = "\u0000other";
const MAX_LIST = 150;
const KINDS = ["line", "station", "convoy", "factory"];

/** The questions of a question row (payload {tool_call_id, questions: [...]}, or the list itself). */
export function items(q) {
	const p = q && q.payload;
	const list = p && Array.isArray(p.questions) ? p.questions : Array.isArray(p) ? p : [];
	return list.filter((it) => it && typeof it === "object").slice(0, 4).map((it, k) => Object.assign({}, it,
		{ id: typeof it.id === "string" || typeof it.id === "number" ? String(it.id) : "q" + (k + 1) }));
}

// --- texts of values --------------------------------------------------------------------------------------------------

function tileText(p) {
	return p && typeof p.x === "number" ? `${p.x},${p.y}` : "?";
}

/** The name of a picked object ({kind, id} or {kind: "factory", x, y}). */
export function objectText(v) {
	if (!v || typeof v !== "object") {
		return "?";
	}
	if (v.kind === "line") {
		const n = lineName(v.id);
		return n.startsWith("#") ? n : `${n} (#${v.id})`;
	}
	if (v.kind === "station") {
		const s = stationIndex().map.get(v.id);
		return s ? `${s.name} (#${v.id})` : "#" + v.id;
	}
	if (v.kind === "convoy") {
		const c = convoyIndex().map.get(v.id);
		return c ? `${c.name} (#${v.id})` : "#" + v.id;
	}
	if (v.kind === "factory") {
		const f = factoryIndex().get(v.x + "," + v.y);
		return (f ? f.name + " " : "") + `(${v.x},${v.y})`;
	}
	return typeof v.id === "number" ? "#" + v.id : tileText(v);
}

/** A value of the answer of one question as text. */
export function valueText(item, v) {
	if (v === undefined || v === null) {
		return "–";
	}
	const type = item ? item.type : null;
	if (type === "choice" || (!type && (typeof v === "string" || Array.isArray(v)))) {
		const one = (x) => (x && typeof x === "object" && "other" in x ? t("team_q_other_value", String(x.other)) : String(x));
		return Array.isArray(v) ? v.map(one).join(", ") : one(v);
	}
	if (type === "map" || (v && typeof v === "object" && ("x1" in v || "a" in v))) {
		if ("x1" in v) {
			return t("team_q_area_value", `${v.x1},${v.y1}`, `${v.x2},${v.y2}`);
		}
		if (v.a && v.b) {
			return t("team_q_ab_value", tileText(v.a), tileText(v.b));
		}
		return t("team_q_tile_value", tileText(v));
	}
	if (type === "object") {
		return objectText(v);
	}
	if (typeof v === "object") {
		try {
			return JSON.stringify(v);
		} catch (e) {
			return "?";
		}
	}
	return String(v);
}

// --- values of a draft ------------------------------------------------------------------------------------------------

function validTile(p) {
	return p && Number.isInteger(p.x) && Number.isInteger(p.y);
}

/** {ok, value, error} of the draft of one question. */
function itemValue(item, d) {
	const id = item.id;
	const v = d.values[id];
	switch (item.type) {
		case "choice": {
			if (item.multi) {
				if (d.open[id]) {
					const text = (d.other[id] || "").trim();
					return text ? { ok: true, value: { other: text } } : { ok: false, error: "team_q_need_other" };
				}
				const list = Array.isArray(v) ? v : [];
				return list.length ? { ok: true, value: list.slice() } : { ok: false, error: "team_q_need_choice" };
			}
			if (v === OTHER) {
				const text = (d.other[id] || "").trim();
				return text ? { ok: true, value: { other: text } } : { ok: false, error: "team_q_need_other" };
			}
			return typeof v === "string" && v ? { ok: true, value: v } : { ok: false, error: "team_q_need_choice" };
		}
		case "number": {
			const raw = typeof v === "string" ? v.trim().replace(",", ".") : v;
			if (raw === undefined || raw === null || raw === "") {
				return { ok: false, error: "team_q_need_number" };
			}
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				return { ok: false, error: "team_q_need_number" };
			}
			if ((typeof item.min === "number" && n < item.min) || (typeof item.max === "number" && n > item.max)) {
				return { ok: false, error: "team_q_range" };
			}
			return { ok: true, value: n };
		}
		case "map": {
			const mode = item.mode || "tile";
			const ok = mode === "area" ? v && Number.isInteger(v.x1) && Number.isInteger(v.y2)
				: mode === "ab" ? v && validTile(v.a) && validTile(v.b) : validTile(v);
			return ok ? { ok: true, value: v } : { ok: false, error: "team_q_need_map" };
		}
		case "object":
			return v && v.kind ? { ok: true, value: v } : { ok: false, error: "team_q_need_object" };
		default: {
			const s = typeof v === "string" ? v.trim() : "";
			return s ? { ok: true, value: s } : { ok: false, error: "team_q_need_text" };
		}
	}
}

// --- map picks ----------------------------------------------------------------------------------------------------------

/** Switches to the map for a pick; the value lands in the draft and the Team tab comes back. */
export function startMapPick(qid, item, spec) {
	const back = () => {
		T.focus = { kind: "question", id: qid };
		setUi({ tab: "team" });
		emit("team");
	};
	setUi({ tab: "map", selection: null });
	mapCtl.startPick(spec, (value) => {
		draftOf(qid).values[item.id] = value;
		back();
	}, back);
	requestAnimationFrame(() => mapCtl.invalidate());
}

function locateValue(v) {
	if (!v || typeof v !== "object") {
		return;
	}
	setUi({ tab: "map" });
	requestAnimationFrame(() => {
		if ("x1" in v) {
			mapCtl.fitBox(v.x1, v.y1, v.x2, v.y2, 4);
		} else if (v.a && v.b) {
			mapCtl.fitPoints([v.a, v.b], 4);
		} else if (typeof v.x === "number") {
			mapCtl.locate(v.x, v.y, { marker: true });
		}
	});
}

// --- object list --------------------------------------------------------------------------------------------------------

function objectsOf(kind) {
	if (kind === "line") {
		return ((S.lines && S.lines.lines) || []).map((l) => ({ key: "l" + l.id, value: { kind, id: l.id }, name: String(l.name),
			owner: l.owner, sub: "#" + l.id + " · " + t("n_convoys", l.convoys ?? "?") }));
	}
	if (kind === "station") {
		return ((S.stations && S.stations.stations) || []).map((s) => ({ key: "s" + s.id, value: { kind, id: s.id },
			name: String(s.name), owner: s.owner, sub: "#" + s.id + (s.pos ? " · " + tileText(s.pos) : "") }));
	}
	if (kind === "convoy") {
		return ((S.convoys && S.convoys.convoys) || []).map((c) => ({ key: "c" + c.id, value: { kind, id: c.id },
			name: String(c.name), owner: c.owner, sub: "#" + c.id + (c.line ? " · " + lineName(c.line) : "") }));
	}
	if (kind === "factory") {
		return ((S.factories && S.factories.factories) || []).filter((f) => f && f.pos).map((f) => ({ key: "f" + f.pos.x + "," + f.pos.y,
			value: { kind, x: f.pos.x, y: f.pos.y }, name: String(f.name), owner: null, sub: tileText(f.pos) }));
	}
	return [];
}

/** A searchable list of the lines, stations, convoys or factories (own company first). */
export function PickerList({ kind, onPick }) {
	useTopics(["lines", "stations", "convoys", "factories", "players", "lang"]);
	const [q, setQ] = useState("");
	const c = company();
	const own = c && typeof c.nr === "number" ? c.nr : null;
	const [mine, setMine] = useState(own !== null && kind !== "factory");
	const ql = q.trim().toLowerCase();
	const all = objectsOf(kind);
	const rows = all.filter((r) => (!mine || r.owner === own) && (!ql || r.name.toLowerCase().includes(ql) || r.sub.toLowerCase().includes(ql)))
		.sort((a, b) => collator().compare(a.name, b.name));
	return html`<div class="qpicker">
		<div class="qpicker-bar">
			<input type="search" class="search qpicker-search" placeholder=${t("search")} aria-label=${t("search")} value=${q}
				onInput=${(e) => setQ(e.target.value)} />
			${own !== null && kind !== "factory" ? html`<label class="check small"><input type="checkbox" checked=${mine}
				onChange=${(e) => setMine(e.target.checked)} />${t("team_q_only_mine")}</label>` : null}
		</div>
		${!all.length ? html`<p class="muted small">${t("team_q_list_empty")}</p>` : !rows.length ? html`<p class="muted small">${t("rows_none")}</p>`
		: html`<ul class="qpicker-list" role="listbox" aria-label=${t("pick_kind_" + kind)}>
			${rows.slice(0, MAX_LIST).map((r) => html`<li key=${r.key}><button type="button" class="qpicker-item" onClick=${() => onPick(r.value)}>
				${r.owner !== null && r.owner !== undefined ? html`<span class="swatch" style=${{ background: ownerColor(r.owner) }} title=${playerName(r.owner)}></span>` : null}
				<span class="qpicker-name">${r.name}</span><span class="muted small">${r.sub}</span>
			</button></li>`)}
		</ul>
		${rows.length > MAX_LIST ? html`<p class="muted small">${t("team_q_list_more", rows.length - MAX_LIST)}</p>` : null}`}
	</div>`;
}

// --- one question --------------------------------------------------------------------------------------------------------

function ChoiceInput({ qid, item, d, force, disabled }) {
	const opts = Array.isArray(item.options) ? item.options.filter((o) => o && (o.label !== undefined)) : [];
	const allowOther = item.allow_other !== false;
	const name = "q" + qid + "-" + item.id;
	const v = d.values[item.id];
	const set = (fn) => {
		fn();
		force();
	};
	const option = (o, k) => {
		const label = String(o.label);
		const on = item.multi ? Array.isArray(v) && v.includes(label) && !d.open[item.id] : v === label;
		const change = () => set(() => {
			if (item.multi) {
				d.open[item.id] = false;
				const list = Array.isArray(v) ? v.slice() : [];
				const i = list.indexOf(label);
				if (i >= 0) {
					list.splice(i, 1);
				} else {
					list.push(label);
				}
				d.values[item.id] = list;
			} else {
				d.values[item.id] = label;
			}
		});
		return html`<label class=${"qopt" + (on ? " on" : "")}>
			<input type=${item.multi ? "checkbox" : "radio"} name=${name} checked=${on} disabled=${disabled} onChange=${change} />
			<span class="qopt-text"><span class="qopt-label">${label}${k === 0 && opts.length > 1 ? html` <span class="badge qrec">${t("team_q_recommended")}</span>` : null}</span>
				${o.description ? html`<span class="qopt-desc muted small">${String(o.description)}</span>` : null}</span>
		</label>`;
	};
	const otherOn = item.multi ? !!d.open[item.id] : v === OTHER;
	return html`<div class="qopts" role=${item.multi ? "group" : "radiogroup"}>
		${opts.map(option)}
		${allowOther ? html`<label class=${"qopt other" + (otherOn ? " on" : "")}>
			<input type=${item.multi ? "checkbox" : "radio"} name=${name} checked=${otherOn} disabled=${disabled}
				onChange=${() => set(() => {
					if (item.multi) {
						d.open[item.id] = !d.open[item.id];
						if (d.open[item.id]) {
							d.values[item.id] = []; // "Other" stands alone (an answer is labels or one own text)
						}
					} else {
						d.values[item.id] = OTHER;
					}
				})} />
			<span class="qopt-text"><span class="qopt-label">${t("team_q_other")}</span>
				${otherOn ? html`<input type="text" class="qother" maxlength="500" value=${d.other[item.id] || ""} disabled=${disabled}
					aria-label=${t("team_q_other")} onInput=${(e) => { d.other[item.id] = e.target.value; force(); }} />` : null}</span>
		</label>` : null}
	</div>`;
}

function MapInput({ qid, item, d, disabled }) {
	const mode = ["tile", "area", "ab"].includes(item.mode) ? item.mode : "tile";
	const v = d.values[item.id];
	const ok = itemValue(item, d).ok;
	return html`<div class="qmap">
		<button type="button" class="btn small q-pick" disabled=${disabled} onClick=${() => startMapPick(qid, item, { mode })}>
			<${Icon} name="locate" size=${16} />${t("team_q_pick_" + mode)}</button>
		${ok ? html`<span class="qvalue">${valueText(item, v)}</span>
			<button type="button" class="linkish small" onClick=${() => locateValue(v)}>${t("locate")}</button>` : html`<span class="muted small">${t("team_q_nothing_picked")}</span>`}
	</div>`;
}

function ObjectInput({ qid, item, d, force, disabled }) {
	const kind = KINDS.includes(item.kind) ? item.kind : "station";
	const v = d.values[item.id];
	const listOpen = !!d.open["list:" + item.id];
	return html`<div class="qobject">
		<div class="qmap">
			<button type="button" class="btn small q-list" disabled=${disabled} aria-expanded=${listOpen}
				onClick=${() => { d.open["list:" + item.id] = !listOpen; force(); }}><${Icon} name="lines" size=${16} />${t("team_q_from_list")}</button>
			<button type="button" class="btn small q-pick" disabled=${disabled} onClick=${() => startMapPick(qid, item, { mode: "object", kind })}>
				<${Icon} name="locate" size=${16} />${t("team_q_pick_object")}</button>
			${v && v.kind ? html`<span class="qvalue">${objectText(v)}</span>` : html`<span class="muted small">${t("team_q_nothing_picked")}</span>`}
		</div>
		${listOpen && !disabled ? html`<${PickerList} kind=${kind} onPick=${(val) => {
			d.values[item.id] = val;
			d.open["list:" + item.id] = false;
			force();
		}} />` : null}
	</div>`;
}

function ItemInput(props) {
	const { item, d, force, disabled } = props;
	switch (item.type) {
		case "choice":
			return html`<${ChoiceInput} ...${props} />`;
		case "number": {
			const range = [typeof item.min === "number" ? t("team_q_min", item.min) : null,
				typeof item.max === "number" ? t("team_q_max", item.max) : null].filter(Boolean).join(", ");
			return html`<div class="qnumber">
				<input type="number" class="qnum" inputmode="decimal" min=${item.min} max=${item.max} step="any" disabled=${disabled}
					value=${d.values[item.id] ?? ""} aria-label=${item.header || item.text || ""}
					onInput=${(e) => { d.values[item.id] = e.target.value; force(); }} />
				${range ? html`<span class="muted small">${range}</span>` : null}
			</div>`;
		}
		case "map":
			return html`<${MapInput} ...${props} />`;
		case "object":
			return html`<${ObjectInput} ...${props} />`;
		default:
			return html`<textarea class="qtext" rows="2" maxlength="2000" disabled=${disabled} value=${d.values[item.id] || ""}
				aria-label=${item.header || item.text || ""} onInput=${(e) => { d.values[item.id] = e.target.value; force(); }}></textarea>`;
	}
}

// --- card ----------------------------------------------------------------------------------------------------------------

/** The card of a question row q (present_question). */
export function QuestionCard({ q }) {
	useTopics(["team", "lang"]);
	const [, force] = useReducer((x) => x + 1, 0);
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState(false);
	const list = items(q);
	const d = draftOf(q.id);
	const pending = q.state === "pending";
	const sent = T.sent.has("q" + q.id);
	const disabled = !pending || sent || busy;
	const vals = list.map((it) => itemValue(it, d));
	const valid = vals.every((v) => v.ok);
	const submit = async () => {
		setTried(true);
		if (!valid) {
			return;
		}
		const answer = {};
		list.forEach((it, k) => {
			answer[it.id] = vals[k].value;
		});
		setBusy(true);
		try {
			await answerQuestion(q.id, answer);
		} catch (e) { /* toast shown */ }
		setBusy(false);
	};
	const dismiss = async () => {
		setBusy(true);
		try {
			await dismissQuestion(q.id);
		} catch (e) { /* toast shown */ }
		setBusy(false);
	};
	const answer = q.answer && typeof q.answer === "object" ? q.answer : null;
	const who = tokenLabel(q.answered_by, q.answered_by_label);
	return html`<section class=${"qcard st-" + q.state} data-question=${q.id} aria-label=${t("team_q_title", agentName(q.agent))}>
		<header class="qcard-head">
			<${Icon} name="help" size=${17} />
			<span class="qcard-title">${t("team_q_title", agentName(q.agent))}</span>
			<${StateBadge} kind="q" state=${q.state} />
		</header>
		${list.map((it, k) => html`<div class="qitem" key=${it.id}>
			<div class="qitem-q">${it.header ? html`<span class="badge qhdr">${String(it.header)}</span>` : null}
				<div class="md qitem-text">${markdown(it.text || "")}</div></div>
			${pending ? html`<${ItemInput} qid=${q.id} item=${it} d=${d} force=${force} disabled=${disabled} />
				${tried && !vals[k].ok ? html`<p class="qerror small">${t(vals[k].error)}</p>` : null}`
			: q.state === "answered" ? html`<p class="qanswer"><span class="muted small">${t("team_q_answer")}:</span>
				<span class="qanswer-value">${valueText(it, answer ? answer[it.id] : undefined)}</span></p>` : null}
		</div>`)}
		${pending ? html`<div class="qcard-actions">
			${sent ? html`<span class="muted small">${t("team_q_sent")}</span>` : html`
				<button type="button" class="btn small primary q-submit" disabled=${busy} onClick=${submit}>${t("team_q_send")}</button>
				<button type="button" class="btn small q-dismiss" disabled=${busy} onClick=${dismiss}>${t("team_q_dismiss")}</button>`}
		</div>` : html`<p class="muted small qwho">${q.state === "dismissed" ? t("team_q_dismissed_by", who || "?") : t("team_q_answered_by", who || "?")}
			${q.answered ? " · " + fmtTime(q.answered) : ""}</p>`}
	</section>`;
}
