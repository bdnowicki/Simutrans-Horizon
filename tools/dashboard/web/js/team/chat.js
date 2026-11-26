// Simutrans-Horizon dashboard: the chat with one agent of the AI team: the history (shared by all players of the
// company, older pages on request), the answer being streamed (team_delta) with the tools the agent uses, the state of
// its run (with a cancel button), question and project cards at their messages and the input (Enter sends, Shift+Enter
// starts a new line, at most 4000 characters). Artistic License, see LICENSE.txt.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from "/vendor/htm/standalone.module.js";
import { useTopics } from "/js/store.js";
import { t } from "/js/i18n.js";
import { Icon } from "/js/icons.js";
import { T, MAX_TEXT, loadChat, agentRun, agentModel, isBusy, markSeen, sendMessage, cancelRun, pendingQuestions,
	reasonText } from "/js/team/state.js";
import { markdown } from "/js/team/markdown.js";
import { QuestionCard } from "/js/team/questions.js";
import { ProjectCard } from "/js/team/projects.js";
import { agentName, Avatar, fmtTime } from "/js/team/common.js";

const NEAR_BOTTOM = 80;

/** Markdown of a message, parsed once per text. */
function Md({ text }) {
	const nodes = useMemo(() => markdown(text), [text]);
	return html`<div class="md">${nodes}</div>`;
}

function Tools({ tools }) {
	if (!Array.isArray(tools) || !tools.length) {
		return null;
	}
	return html`<ul class="tool-chips">${tools.map((x) => html`<li class="tool-chip" title=${x.summary ? String(x.summary) : ""}>
		<${Icon} name="sliders" size=${12} /><span class="tool-name">${String(x.name || "?")}</span>
		${x.summary ? html`<span class="tool-sum">${String(x.summary)}</span>` : null}</li>`)}</ul>`;
}

function phaseText(r) {
	if (!r || !r.state) {
		return "";
	}
	if (r.state === "running") {
		return t(r.phase ? "team_phase_" + r.phase : "team_run_running");
	}
	return t("team_run_" + r.state);
}

function Message({ m, agent, first }) {
	const q = typeof m.question_id === "number" ? T.questions.get(m.question_id) : null;
	const pid = typeof m.project_id === "number" ? m.project_id : null;
	const project = pid !== null ? html`<${ProjectCard} id=${pid} compact=${!first.has(pid) || first.get(pid) !== m.id} />` : null;
	if (m.role === "user") {
		const who = m.author ? m.author.label || "#" + m.author.token_id : t("team_from_coordinator");
		return html`<li class=${"tmsg user" + (m.author ? "" : " task")} data-msg=${m.id}>
			<div class="tmsg-meta"><span class="tmsg-author">${who}</span><span class="muted">${fmtTime(m.created)}</span></div>
			<div class="tmsg-bubble"><${Md} text=${m.content} /></div>
		</li>`;
	}
	if (m.role === "assistant") {
		return html`<li class="tmsg assistant" data-msg=${m.id}>
			<div class="tmsg-meta"><${Avatar} agent=${agent} size=${20} /><span class="tmsg-author">${agentName(agent)}</span>
				<span class="muted">${fmtTime(m.created)}</span></div>
			${m.content ? html`<div class="tmsg-bubble"><${Md} text=${m.content} /></div>` : null}
			<${Tools} tools=${m.tools} />
			${q ? html`<${QuestionCard} q=${q} />` : null}
			${project}
		</li>`;
	}
	if (m.role === "tool") {
		return html`<li class="tmsg tool" data-msg=${m.id}>
			<div class="tmsg-tool"><${Icon} name="sliders" size=${12} /><span>${m.content}</span></div>
			${q ? html`<${QuestionCard} q=${q} />` : null}
			${project}
		</li>`;
	}
	return html`<li class="tmsg sysnote" data-msg=${m.id}>
		<div class="tmsg-note"><${Icon} name="info" size=${14} /><span>${m.content}</span><span class="muted">${fmtTime(m.created)}</span></div>
		${project}
	</li>`;
}

/** The answer being written now, the tools used so far and the phase of the run. */
function StreamBubble({ agent, onGrow }) {
	useTopics(["team_stream", "lang"]);
	const s = T.streams.get(agent);
	const r = agentRun(agent);
	const active = r && (r.state === "running" || r.state === "queued");
	useLayoutEffect(() => onGrow());
	if (!active && !(s && (s.text || s.tools.length))) {
		return null;
	}
	return html`<li class="tmsg assistant streaming" aria-live="polite">
		<div class="tmsg-meta"><${Avatar} agent=${agent} size=${20} /><span class="tmsg-author">${agentName(agent)}</span>
			${active ? html`<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span><span class="muted">${phaseText(r)}</span>` : null}</div>
		${s && s.text ? html`<div class="tmsg-bubble"><${Md} text=${s.text} /></div>` : null}
		${s ? html`<${Tools} tools=${s.tools} />` : null}
	</li>`;
}

function Composer({ agent, enabled, reason }) {
	const [text, setText] = useState(T.inputs.get(agent) || "");
	const [busy, setBusy] = useState(false);
	const ref = useRef(null);
	useEffect(() => {
		setText(T.inputs.get(agent) || "");
	}, [agent]);
	const update = (v) => {
		setText(v);
		T.inputs.set(agent, v);
	};
	const send = async () => {
		const v = text.trim();
		if (!v || busy || !enabled || v.length > MAX_TEXT) {
			return;
		}
		setBusy(true);
		try {
			await sendMessage(agent, v);
			update("");
		} catch (e) { /* toast shown */ }
		setBusy(false);
		if (ref.current) {
			ref.current.focus();
		}
	};
	const key = (e) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			send();
		}
	};
	// grows with its text up to a limit (CSS max-height)
	useLayoutEffect(() => {
		const el = ref.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = Math.min(el.scrollHeight + 2, 220) + "px";
		}
	}, [text]);
	const n = text.length;
	return html`<div class=${"team-input" + (enabled ? "" : " off")}>
		<textarea ref=${ref} class="team-text" rows="1" maxlength=${MAX_TEXT} value=${text} disabled=${!enabled}
			placeholder=${enabled ? t("team_placeholder", agentName(agent)) : reasonText(reason) || t("team_disabled")}
			aria-label=${t("team_message_to", agentName(agent))} onInput=${(e) => update(e.target.value)} onKeyDown=${key}></textarea>
		<div class="team-input-side">
			<span class=${"team-count small" + (n > MAX_TEXT * 0.9 ? " warn" : "")}>${n}/${MAX_TEXT}</span>
			<button type="button" class="btn small primary team-send" disabled=${!enabled || busy || !text.trim()} onClick=${send}
				title=${t("team_send_hint")}><${Icon} name="send" size=${16} /><span>${t("team_send")}</span></button>
		</div>
	</div>`;
}

export function ChatView({ agent, enabled, reason }) {
	useTopics(["team", "lang"]);
	const c = T.chats.get(agent);
	const scroller = useRef(null);
	const atBottom = useRef(true);
	const prevTop = useRef(null); // [first message id, scrollHeight] before older messages were added
	useEffect(() => {
		if (!c || (!c.loaded && !c.loading && !c.error)) {
			loadChat(agent);
		}
	}, [agent, !!c]);
	const msgs = c ? c.messages : [];
	const newest = T.newest.get(agent) || 0;
	useEffect(() => {
		if (c && c.loaded) {
			markSeen(agent);
		}
	}, [agent, newest, c && c.loaded]);

	// keep the bottom in view while new messages come (unless the user scrolled up); keep the place when older ones come
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) {
			return;
		}
		const p = prevTop.current;
		if (p && msgs.length && msgs[0].id !== p[0]) {
			el.scrollTop += el.scrollHeight - p[1];
			prevTop.current = null;
			return;
		}
		const f = T.focus;
		if (f) {
			const node = el.querySelector(f.kind === "question" ? `[data-question="${f.id}"]` : `[data-project="${f.id}"]`);
			if (node) {
				T.focus = null;
				node.scrollIntoView({ block: "center" });
				atBottom.current = false;
				return;
			}
		}
		if (atBottom.current) {
			el.scrollTop = el.scrollHeight;
		}
	});
	useEffect(() => {
		atBottom.current = true;
	}, [agent]);
	const onScroll = () => {
		const el = scroller.current;
		if (el) {
			atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
		}
	};
	const older = () => {
		const el = scroller.current;
		prevTop.current = msgs.length && el ? [msgs[0].id, el.scrollHeight] : null;
		loadChat(agent, true);
	};

	// the first message of each project shows its card, later ones a link to it
	const first = new Map();
	const shownQuestions = new Set();
	for (const m of msgs) {
		if (typeof m.project_id === "number" && !first.has(m.project_id)) {
			first.set(m.project_id, m.id);
		}
		if (typeof m.question_id === "number" && T.questions.has(m.question_id)) {
			shownQuestions.add(m.question_id);
		}
	}
	const loose = pendingQuestions(agent).filter((q) => !shownQuestions.has(q.id)).sort((a, b) => a.id - b.id);
	const waiting = Array.from(T.projects.values()).filter((p) => p.agent === agent && p.state === "proposed" && !first.has(p.id))
		.sort((a, b) => a.id - b.id);
	const r = agentRun(agent);
	const busy = isBusy(agent);
	const canCancel = r && typeof r.run === "number" && ["queued", "running", "waiting"].includes(r.state);
	return html`<div class="team-chat">
		<div class="team-chat-head">
			<${Avatar} agent=${agent} size=${30} />
			<div class="team-chat-titles">
				<h2 class="team-chat-name">${agentName(agent)}</h2>
				<div class="muted small team-chat-sub">${t("team_role_" + agent)}${agentModel(agent) ? " · " + agentModel(agent) : ""}</div>
			</div>
			${r && r.state ? html`<span class=${"team-run st-" + r.state}>${busy ? html`<span class="spinner" aria-hidden="true"></span>` : null}${phaseText(r)}</span>` : null}
			${canCancel ? html`<button type="button" class="btn small team-cancel" onClick=${() => cancelRun(agent).catch(() => {})}>
				<${Icon} name="stop" size=${14} />${t("team_cancel")}</button>` : null}
		</div>
		${r && r.state === "failed" && r.error ? html`<div class="team-run-error small">${t("team_run_error", String(r.error))}</div>` : null}
		<div class="team-msgs" ref=${scroller} onScroll=${onScroll}>
			${c && c.more ? html`<div class="team-older"><button type="button" class="btn small team-load-older" disabled=${c.loading} onClick=${older}>${t("team_load_older")}</button></div>` : null}
			${c && c.error && !msgs.length ? html`<p class="error small">${t("load_failed", c.error.message)}</p>` : null}
			${c && c.loaded && !msgs.length && !loose.length ? html`<div class="team-empty">
				<${Avatar} agent=${agent} size=${44} />
				<p>${t("team_empty", agentName(agent))}</p>
				<p class="muted small">${t("team_intro_" + agent)}</p>
			</div>` : null}
			${!c || (!c.loaded && c.loading) ? html`<p class="muted small">${t("loading")}</p>` : null}
			<ul class="tmsgs">
				${msgs.map((m) => html`<${Message} key=${m.id} m=${m} agent=${agent} first=${first} />`)}
				<${StreamBubble} agent=${agent} onGrow=${() => {
					const el = scroller.current;
					if (el && atBottom.current && !T.focus) {
						el.scrollTop = el.scrollHeight;
					}
				}} />
			</ul>
			${loose.length ? html`<div class="team-pending">
				<div class="board-h">${t("team_pending_questions")}</div>
				${loose.map((q) => html`<${QuestionCard} key=${q.id} q=${q} />`)}
			</div>` : null}
			${waiting.length ? html`<div class="team-pending">
				<div class="board-h">${t("team_waiting_projects")}</div>
				${waiting.map((p) => html`<${ProjectCard} key=${p.id} id=${p.id} />`)}
			</div>` : null}
		</div>
		<${Composer} agent=${agent} enabled=${enabled} reason=${reason} />
	</div>`;
}

