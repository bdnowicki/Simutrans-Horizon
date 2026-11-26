// Simutrans-Horizon dashboard: the Team tab (only for players of a company): the list of the eight agents (busy, pending
// questions, unread messages; a selector on phones), the chat with the chosen agent, the task board of the coordinator
// (tasks by state from agent to agent, pending questions, the projects by state), one project on its own, the costs of
// today against the daily limit, and a banner when the agents cannot work (with the reason). Artistic License, see
// LICENSE.txt.
import { html, useEffect } from "/vendor/htm/standalone.module.js";
import { S, setUi, useTopics } from "/js/store.js";
import { t } from "/js/i18n.js";
import { Icon } from "/js/icons.js";
import { useNarrow } from "/js/vtable.js";
import { T, AGENTS, ensureLoaded, reloadAll, isBusy, pendingCount, pendingQuestions, isUnread, reasonText, resetTime,
	company } from "/js/team/state.js";
import { ChatView } from "/js/team/chat.js";
import { items } from "/js/team/questions.js";
import { ProjectList, ProjectView } from "/js/team/projects.js";
import { markdown } from "/js/team/markdown.js";
import { agentName, Avatar, fmtTime, fmtUsd, StateBadge } from "/js/team/common.js";

const VIEWS = [["chat", "team_chat"], ["board", "team_board"]];

function openAgent(agent) {
	setUi({ teamView: "chat", teamAgent: agent });
}

/** Spent today against the daily limit (all companies) and the company's share. */
function Usage() {
	const u = T.state && T.state.usage;
	if (!u || typeof u !== "object") {
		return null;
	}
	const today = typeof u.today_usd === "number" ? u.today_usd : 0;
	const limit = typeof u.limit_usd === "number" ? u.limit_usd : null;
	const pct = limit ? Math.max(0, Math.min(100, (100 * today) / limit)) : 0;
	const share = typeof u.company_limit_usd === "number" ? u.company_limit_usd : null;
	const tip = t("team_usage_tip", resetTime() || "?");
	return html`<div class="team-usage" title=${tip} aria-label=${tip}>
		<span class="team-usage-text"><span class="muted">${t("team_usage_today")}</span>
			<strong>${fmtUsd(today)}</strong>${limit !== null ? html`<span class="muted"> / ${fmtUsd(limit)}</span>` : null}</span>
		${limit ? html`<span class="meter team-usage-meter"><span class=${"meter-fill" + (pct >= 90 ? " hot" : "")} style=${{ width: pct + "%" }}></span></span>` : null}
		<span class="team-usage-company small muted">${t("team_usage_company", fmtUsd(u.company_usd))}${share !== null ? " / " + fmtUsd(share) : ""}</span>
	</div>`;
}

function AgentRow({ agent, active }) {
	const busy = isBusy(agent);
	const n = pendingCount(agent);
	const unread = isUnread(agent) && !active;
	return html`<li>
		<button type="button" class=${"team-agent" + (active ? " on" : "")} aria-current=${active ? "page" : undefined}
			data-agent=${agent} onClick=${() => openAgent(agent)}>
			<${Avatar} agent=${agent} size=${30} />
			<span class="team-agent-text">
				<span class="team-agent-name">${agentName(agent)}</span>
				<span class="team-agent-sub small muted">${busy ? t("team_busy") : t("team_role_" + agent)}</span>
			</span>
			${busy ? html`<span class="spinner" title=${t("team_busy")}></span>` : null}
			${n ? html`<span class="badge qbadge" title=${t("team_q_pending_n", n)}>?${n > 1 ? " " + n : ""}</span>` : null}
			${unread ? html`<span class="unread-dot" title=${t("team_unread")}></span>` : null}
		</button>
	</li>`;
}

function AgentList({ current }) {
	return html`<nav class="team-agents" aria-label=${t("team_agents")}>
		<ul>${AGENTS.map((a) => html`<${AgentRow} key=${a} agent=${a} active=${S.ui.teamView === "chat" && a === current} />`)}</ul>
	</nav>`;
}

/** Phones: the agents as a selector (with their marks in the option texts). */
function AgentSelect({ current }) {
	return html`<label class="team-agent-select">
		<span class="sr-only">${t("team_agents")}</span>
		<select value=${current} aria-label=${t("team_agents")} onChange=${(e) => openAgent(e.target.value)}>
			${AGENTS.map((a) => {
				const marks = [isBusy(a) ? "…" : "", pendingCount(a) ? "?" + pendingCount(a) : "", isUnread(a) && a !== current ? "●" : ""]
					.filter(Boolean).join(" ");
				return html`<option value=${a}>${agentName(a)}${marks ? "  " + marks : ""}</option>`;
			})}
		</select>
	</label>`;
}

function TaskCard({ task }) {
	const qs = pendingQuestions(task.to_agent).filter((q) => task.run_id && q.run_id === task.run_id);
	return html`<li class=${"task st-" + task.state}>
		<button type="button" class="task-btn" onClick=${() => openAgent(task.to_agent)}>
			<div class="task-route small"><${Avatar} agent=${task.from_agent} size=${18} /><span>${agentName(task.from_agent)}</span>
				<span aria-hidden="true">→</span><${Avatar} agent=${task.to_agent} size=${18} /><span>${agentName(task.to_agent)}</span>
				${qs.length ? html`<span class="badge qbadge" title=${t("team_q_pending_n", qs.length)}>?${qs.length > 1 ? " " + qs.length : ""}</span>` : null}</div>
			<div class="task-title">${task.title || "#" + task.id}</div>
			${task.result ? html`<div class="md task-result small">${markdown(String(task.result).slice(0, 600))}</div>` : null}
			<div class="muted small">#${task.id} · ${fmtTime(task.updated || task.created)}</div>
		</button>
	</li>`;
}

const TASK_COLS = [["open", ["open"]], ["working", ["working"]], ["waiting", ["waiting"]], ["done", ["done"]],
	["cancelled", ["cancelled"]]];

function Board() {
	useTopics(["team", "lang"]);
	const tasks = Array.from(T.tasks.values()).sort((a, b) => b.id - a.id);
	const pend = pendingQuestions();
	return html`<div class="team-board">
		<section class="board-sec">
			<h2 class="board-title">${t("team_tasks")}</h2>
			${tasks.length ? html`<div class="board-cols">${TASK_COLS.map(([k, states]) => {
				const list = tasks.filter((x) => states.includes(x.state));
				return html`<section class=${"board-col col-" + k}>
					<h3 class="board-h"><${StateBadge} kind="t" state=${k} /> <span class="muted small">${list.length}</span></h3>
					${list.length ? html`<ul class="tasks">${list.map((x) => html`<${TaskCard} key=${x.id} task=${x} />`)}</ul>`
						: html`<p class="muted small">${t("team_none")}</p>`}
				</section>`;
			})}</div>` : html`<p class="muted small">${t("team_tasks_none")}</p>`}
		</section>
		<section class="board-sec">
			<h2 class="board-title">${t("team_pending_questions")} <span class="badge">${pend.length}</span></h2>
			${pend.length ? html`<ul class="board-questions">${pend.map((q) => {
				const first = items(q)[0];
				return html`<li><button type="button" class="board-q" onClick=${() => openAgent(q.agent)}>
					<${Avatar} agent=${q.agent} size=${22} /><span class="board-q-agent">${agentName(q.agent)}</span>
					<span class="board-q-text">${first ? String(first.header || first.text || "") : "#" + q.id}</span>
					<span class="muted small">${fmtTime(q.created)}</span></button></li>`;
			})}</ul>` : html`<p class="muted small">${t("team_q_none")}</p>`}
		</section>
		<section class="board-sec">
			<h2 class="board-title">${t("team_projects")}</h2>
			<${ProjectList} />
		</section>
	</div>`;
}

function Banner({ st }) {
	if (!st || st.enabled !== false) {
		return null;
	}
	return html`<div class="team-banner" role="status"><${Icon} name="info" size=${16} />
		<span>${reasonText(st.reason) || t("team_disabled")}</span></div>`;
}

export function TeamView({ visible }) {
	useTopics(["team", "ui", "lang", "session"]);
	const narrow = useNarrow("(max-width: 640px)");
	useEffect(() => {
		if (visible) {
			ensureLoaded();
		}
	}, [visible]);
	if (!visible) {
		return null;
	}
	const st = T.state;
	const view = ["chat", "board", "project"].includes(S.ui.teamView) ? S.ui.teamView : "chat";
	const agent = AGENTS.includes(S.ui.teamAgent) ? S.ui.teamAgent : "coordinator";
	const enabled = !!(st && st.enabled);
	const c = company();
	let main;
	if (!st && T.error) {
		main = html`<div class="team-main-msg"><p class="error">${t("load_failed", T.error.message)}</p>
			<button type="button" class="btn small" onClick=${() => reloadAll()}>${t("retry")}</button></div>`;
	} else if (view === "board") {
		main = html`<${Board} />`;
	} else if (view === "project" && S.ui.teamProject) {
		main = html`<${ProjectView} id=${S.ui.teamProject} />`;
	} else {
		main = html`<${ChatView} agent=${agent} enabled=${enabled} reason=${st ? st.reason : null} />`;
	}
	const totalQ = pendingQuestions().length;
	return html`<div class=${"team" + (narrow ? " narrow" : "")}>
		<div class="team-head">
			<div class="seg team-views" role="group" aria-label=${t("team_views")}>
				${VIEWS.map(([k, label]) => html`<button type="button" aria-pressed=${view === k || (k === "board" && view === "project")}
					class=${view === k || (k === "board" && view === "project") ? "on" : ""} onClick=${() => setUi({ teamView: k })}>
					${t(label)}${k === "board" && totalQ ? html` <span class="badge qbadge">?${totalQ}</span>` : null}</button>`)}
			</div>
			${narrow && view === "chat" ? html`<${AgentSelect} current=${agent} />` : null}
			<div class="team-company muted small">${c ? t("team_company", c.name || "#" + c.nr) : ""}
				${T.sse === "closed" ? html` · <span class="neg">${t("sse_closed")}</span>` : null}</div>
			<${Usage} />
		</div>
		<${Banner} st=${st} />
		<div class="team-body">
			${!narrow ? html`<${AgentList} current=${agent} />` : null}
			<div class="team-main">${!st && T.loading ? html`<p class="muted team-main-msg">${t("loading")}</p>` : main}</div>
		</div>
	</div>`;
}
