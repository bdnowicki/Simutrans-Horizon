// Simutrans-Horizon dashboard: project cards of the AI team: title, author, rationale, the operations as readable steps,
// the cost estimate (total, cash, cash after, maintenance, warnings), approve (with a confirmation) or reject (with an
// optional reason), the preview on the 2D map (mapCtl.setPlan) and in the 3D view (S.ui.preview3d), and the report after
// the execution (per operation done / failed / skipped, actual against estimated cost). Texts of the model are rendered
// by markdown.js, names of the game as text nodes. Artistic License, see LICENSE.txt.
import { html, useState, useEffect } from "/vendor/htm/standalone.module.js";
import { S, setUi, useTopics, toast, lineName, convoyIndex } from "/js/store.js";
import { mapCtl } from "/js/map.js";
import { view3dSupported } from "/js/views/view3d.js";
import { t } from "/js/i18n.js";
import { fmtMoney } from "/js/format.js";
import { Icon } from "/js/icons.js";
import { T, fullProject, approveProject, rejectProject, tokenLabel } from "/js/team/state.js";
import { markdown } from "/js/team/markdown.js";
import { agentName, fmtTime, posText, StateBadge } from "/js/team/common.js";

// --- operations as text ---------------------------------------------------------------------------------------------

function str(v) {
	return v === undefined || v === null || v === "" ? "?" : String(v);
}

/** A reference of an operation: "$name" (result of an earlier operation), an id of the game or a position. */
function ref(v, kind) {
	if (typeof v === "string" && v.startsWith("$")) {
		return t("op_ref", v.slice(1));
	}
	if (Array.isArray(v) || (v && typeof v === "object")) {
		return posText(v);
	}
	if (typeof v === "number" && kind === "line") {
		const n = lineName(v);
		return n.startsWith("#") ? n : `${n} (#${v})`;
	}
	if (typeof v === "number" && kind === "convoy") {
		const c = convoyIndex().map.get(v);
		return c ? `${c.name} (#${v})` : "#" + v;
	}
	return str(v);
}

function stopText(s) {
	if (!s || typeof s !== "object" || Array.isArray(s)) {
		return posText(s);
	}
	const extra = [];
	if (typeof s.load === "number" && s.load > 0) {
		extra.push(t("min_load", s.load));
	}
	if (typeof s.wait === "number" && s.wait > 0) {
		extra.push(t("op_wait", s.wait));
	}
	return posText(s.at) + (extra.length ? " (" + extra.join(", ") + ")" : "");
}

/** One operation of a project as a sentence (and its stops for lines). */
export function opText(op) {
	if (!op || typeof op !== "object") {
		return { text: str(op) };
	}
	const ty = op.type || op.op;
	const flags = [];
	switch (ty) {
		case "build_way":
			if (op.bridge) {
				flags.push(t("op_bridges"));
			}
			if (op.tunnel) {
				flags.push(t("op_tunnels"));
			}
			return { text: t("op_build_way", str(op.way), posText(op.from), posText(op.to)), flags };
		case "build_station":
			return { text: t("op_build_station", str(op.building), posText(op.at)) };
		case "build_depot":
			return { text: t("op_build_depot", str(op.building), posText(op.at)) };
		case "build_roadsign":
			return { text: t("op_build_roadsign", str(op.sign), posText(op.at)) };
		case "build_wayobj":
			return { text: t("op_build_wayobj", str(op.wayobj), posText(op.from), posText(op.to)) };
		case "remove":
			return { text: op.kind ? t("op_remove_kind", str(op.kind), posText(op.at)) : t("op_remove", posText(op.at)) };
		case "remove_way":
			return { text: t("op_remove_way", str(op.waytype), posText(op.from), posText(op.to)) };
		case "create_line":
			return { text: t("op_create_line", op.name ? String(op.name) : ref("$" + str(op.ref)), str(op.waytype)),
				stops: Array.isArray(op.stops) ? op.stops.map(stopText) : [] };
		case "set_line_schedule":
			return { text: t("op_set_line_schedule", ref(op.line, "line")), stops: Array.isArray(op.stops) ? op.stops.map(stopText) : [] };
		case "delete_line":
			return { text: t("op_delete_line", ref(op.line, "line")) };
		case "buy_convoy": {
			if (op.line !== undefined && op.line !== null) {
				flags.push(t("op_for_line", ref(op.line, "line")));
			}
			if (op.start === false) {
				flags.push(t("op_stay_in_depot"));
			}
			const veh = Array.isArray(op.vehicles) ? op.vehicles.map(String).join(" + ") : str(op.vehicles);
			return { text: t("op_buy_convoy", typeof op.count === "number" ? op.count : 1, veh, ref(op.depot)), flags };
		}
		case "assign_line":
			return { text: t("op_assign_line", ref(op.convoy, "convoy"), ref(op.line, "line")) };
		case "withdraw":
			return { text: t(op.on === false ? "op_withdraw_off" : "op_withdraw", ref(op.convoy, "convoy")) };
		case "replace_convoy": {
			const veh = Array.isArray(op.vehicles) ? op.vehicles.map(String).join(" + ") : str(op.vehicles);
			return { text: t("op_replace_convoy", ref(op.convoy, "convoy"), veh) };
		}
		case "sell":
			return { text: t("op_sell", ref(op.convoy, "convoy")) };
		default: {
			let json = "";
			try {
				json = JSON.stringify(op);
			} catch (e) { /* not serialisable */ }
			return { text: t("op_unknown", str(ty)) + (json ? " " + json.slice(0, 300) : "") };
		}
	}
}

// --- preview ----------------------------------------------------------------------------------------------------------

function bboxCenter(p) {
	const b = p && p.bbox;
	if (Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === "number")) {
		return { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) };
	}
	for (const it of (p && p.items) || []) {
		const tile = Array.isArray(it.tiles) && it.tiles[0];
		if (Array.isArray(tile)) {
			return { x: tile[0], y: tile[1] };
		}
	}
	return null;
}

async function withPreview(id) {
	try {
		const f = await fullProject(id);
		if (!f || !f.preview || !Array.isArray(f.preview.items) || !f.preview.items.length) {
			toast(t("team_p_no_preview"));
			return null;
		}
		return f;
	} catch (e) {
		toast(t("load_failed", e.message));
		return null;
	}
}

/** Draws the project on the 2D map and fits the map to it. */
export async function showPlanOnMap(id) {
	const f = await withPreview(id);
	if (!f) {
		return;
	}
	mapCtl.setPlan({ id, title: f.title, preview: f.preview });
	setUi({ tab: "map" });
	requestAnimationFrame(() => {
		mapCtl.invalidate();
		mapCtl.fitPlan();
	});
}

/** Shows the project as ghosts in the 3D view and looks at it. */
export async function showPlanIn3D(id) {
	const f = await withPreview(id);
	if (!f) {
		return;
	}
	setUi({ tab: "view3d", preview3d: { id, title: f.title, preview: f.preview }, look3d: bboxCenter(f.preview) });
}

// --- card -------------------------------------------------------------------------------------------------------------

function money(v) {
	return typeof v === "number" ? fmtMoney(v) : "–";
}

function Estimate({ e }) {
	if (!e || typeof e !== "object") {
		return html`<p class="muted small">${t("team_p_no_estimate")}</p>`;
	}
	const neg = typeof e.cash_after === "number" && e.cash_after < 0;
	return html`<div class="pest">
		<div class="figs">
			<div class="fig"><div class="fig-label">${t("team_p_total")}</div><div class="fig-value">${money(e.total)}</div></div>
			<div class="fig"><div class="fig-label">${t("team_p_cash")}</div><div class="fig-value">${money(e.cash)}</div></div>
			<div class="fig"><div class="fig-label">${t("team_p_cash_after")}</div>
				<div class=${"fig-value" + (neg ? " neg" : "")}>${money(e.cash_after)}</div></div>
			<div class="fig"><div class="fig-label">${t("team_p_maintenance")}</div><div class="fig-value">${money(e.maintenance_month)}</div></div>
		</div>
		${Array.isArray(e.warnings) && e.warnings.length ? html`<ul class="pwarn">${e.warnings.map((w) => html`<li>${String(w)}</li>`)}</ul>` : null}
	</div>`;
}

function Report({ p }) {
	const r = p.report;
	if (!r || typeof r !== "object") {
		return null;
	}
	const over = typeof r.actual_cost === "number" && typeof r.estimate === "number" && r.actual_cost > r.estimate;
	return html`<div class=${"preport st-" + p.state}>
		<div class="preport-head"><${Icon} name="info" size=${16} /><strong>${t("team_p_report")}</strong></div>
		<div class="small">${t("team_p_actual")}: <span class=${over ? "neg" : ""}>${money(r.actual_cost)}</span>
			· ${t("team_p_estimated")}: ${money(r.estimate)}</div>
		${r.stopped ? html`<div class="small neg">${t("team_p_stopped", String(r.stopped))}</div>` : null}
	</div>`;
}

/**
 * The card of a project (id). compact: one line (a later reference in a chat) that opens the project.
 */
export function ProjectCard({ id, compact = false }) {
	useTopics(["team", "lang", "lines", "convoys"]);
	const [step, setStep] = useState(null); // null | "approve" | "reject"
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const p = T.projects.get(id) || T.full.get(id);
	if (!p) {
		return html`<div class="pcard missing muted small">${t("team_p_unknown", id)}</div>`;
	}
	const open = () => setUi({ tab: "team", teamView: "project", teamProject: id });
	if (compact) {
		return html`<button type="button" class="pref linkish" onClick=${open}>
			<${Icon} name="plan" size=${15} /><span>${t("team_p_ref", p.title || "#" + id)}</span>
			<${StateBadge} kind="p" state=${p.state} /></button>`;
	}
	const ops = Array.isArray(p.ops) ? p.ops : [];
	const e = p.estimate && typeof p.estimate === "object" ? p.estimate : null;
	const costs = new Map();
	for (const it of (e && Array.isArray(e.items) ? e.items : [])) {
		if (it && typeof it.op === "number") {
			costs.set(it.op, it);
		}
	}
	const rep = new Map();
	for (const it of (p.report && Array.isArray(p.report.ops) ? p.report.ops : [])) {
		if (it && typeof it.op === "number") {
			rep.set(it.op, it);
		}
	}
	const sent = T.sent.has("p" + id);
	const act = async (fn) => {
		setBusy(true);
		try {
			await fn();
			setStep(null);
		} catch (err) { /* toast shown */ }
		setBusy(false);
	};
	const proposed = p.state === "proposed";
	return html`<article class=${"pcard st-" + p.state} data-project=${id}>
		<header class="pcard-head">
			<span class="pcard-icon"><${Icon} name="plan" size=${18} /></span>
			<div class="pcard-titles">
				<h3 class="pcard-title">${p.title || "#" + id}</h3>
				<div class="pcard-sub muted small">${t("team_p_by", agentName(p.agent))} · #${id} · ${fmtTime(p.created)}</div>
			</div>
			<${StateBadge} kind="p" state=${p.state} />
		</header>
		${p.rationale ? html`<div class="md pcard-rationale">${markdown(p.rationale)}</div>` : null}
		<div class="pcard-sec">
			<div class="pcard-h">${t("team_p_ops", ops.length)}</div>
			<ol class="pops">${ops.map((op, k) => {
				const o = opText(op), c = costs.get(k), r = rep.get(k);
				return html`<li class=${r ? "op-" + r.state : ""}>
					<div class="pop-row">
						<span class="pop-text">${o.text}</span>
						${c && typeof c.cost === "number" ? html`<span class="pop-cost" title=${c.label ? String(c.label) : ""}>${money(c.cost)}</span>` : null}
						${r ? html`<${StateBadge} kind="op" state=${r.state} />` : null}
					</div>
					${o.flags && o.flags.length ? html`<div class="pop-flags muted small">${o.flags.join(" · ")}</div>` : null}
					${o.stops && o.stops.length ? html`<ol class="pop-stops small">${o.stops.map((s) => html`<li>${s}</li>`)}</ol>` : null}
					${r && r.error ? html`<div class="pop-error small">${String(r.error)}</div>` : null}
					${r && typeof r.cost === "number" ? html`<div class="muted small">${t("team_p_op_cost", money(r.cost))}</div>` : null}
				</li>`;
			})}</ol>
		</div>
		<div class="pcard-sec">
			<div class="pcard-h">${t("team_p_estimate")}</div>
			<${Estimate} e=${e} />
		</div>
		<${Report} p=${p} />
		${p.approved_by !== null && p.approved_by !== undefined ? html`<p class="muted small">${t(p.state === "rejected" ? "team_p_rejected_by" : "team_p_approved_by",
			tokenLabel(p.approved_by, p.approved_by_label))}</p>` : null}
		<div class="pcard-actions">
			<button type="button" class="btn small" onClick=${() => showPlanOnMap(id)}><${Icon} name="map" size=${16} />${t("team_p_show_map")}</button>
			${view3dSupported() ? html`<button type="button" class="btn small" onClick=${() => showPlanIn3D(id)}><${Icon} name="cube" size=${16} />${t("team_p_show_3d")}</button>` : null}
			${proposed && !step && !sent ? html`<span class="pcard-spacer"></span>
				<button type="button" class="btn small primary p-approve" onClick=${() => setStep("approve")}>${t("team_p_approve")}</button>
				<button type="button" class="btn small p-reject" onClick=${() => setStep("reject")}>${t("team_p_reject")}</button>` : null}
		</div>
		${proposed && sent ? html`<p class="muted small">${t("team_p_sent")}</p>` : null}
		${proposed && step === "approve" ? html`<div class="pconfirm" role="group" aria-label=${t("team_p_approve")}>
			<p>${t("team_p_confirm", money(e && e.total), money(e && e.cash_after))}</p>
			<div class="pcard-actions">
				<button type="button" class="btn small primary p-confirm" disabled=${busy} onClick=${() => act(() => approveProject(id))}>${t("team_p_confirm_btn")}</button>
				<button type="button" class="btn small" disabled=${busy} onClick=${() => setStep(null)}>${t("team_cancel_btn")}</button>
			</div>
		</div>` : null}
		${proposed && step === "reject" ? html`<div class="pconfirm" role="group" aria-label=${t("team_p_reject")}>
			<label class="field">${t("team_p_reason")}
				<textarea class="p-reason" rows="2" maxlength="1000" value=${reason} onInput=${(ev) => setReason(ev.target.value)}></textarea></label>
			<div class="pcard-actions">
				<button type="button" class="btn small danger p-reject-confirm" disabled=${busy} onClick=${() => act(() => rejectProject(id, reason))}>${t("team_p_reject_btn")}</button>
				<button type="button" class="btn small" disabled=${busy} onClick=${() => setStep(null)}>${t("team_cancel_btn")}</button>
			</div>
		</div>` : null}
	</article>`;
}

/** The projects of the company grouped by state (task board). */
export function ProjectList() {
	useTopics(["team", "lang"]);
	const all = Array.from(T.projects.values()).sort((a, b) => b.id - a.id);
	if (!all.length) {
		return html`<p class="muted small">${t("team_p_none")}</p>`;
	}
	const groups = [["proposed", ["proposed", "draft"]], ["running", ["approved", "running"]], ["done", ["done"]],
		["failed", ["failed"]], ["rejected", ["rejected"]]];
	return html`<div class="plist">${groups.map(([g, states]) => {
		const list = all.filter((p) => states.includes(p.state));
		return list.length ? html`<section class="plist-group">
			<h3 class="board-h">${t("team_pg_" + g)} <span class="badge">${list.length}</span></h3>
			<ul class="plist-items">${list.map((p) => html`<li>
				<button type="button" class="plist-item" onClick=${() => setUi({ teamView: "project", teamProject: p.id })}>
					<span class="plist-title">${p.title || "#" + p.id}</span>
					<span class="muted small">${agentName(p.agent)} · #${p.id}${p.estimate && typeof p.estimate.total === "number" ? " · " + fmtMoney(p.estimate.total) : ""}</span>
					<${StateBadge} kind="p" state=${p.state} />
				</button></li>`)}</ul>
		</section>` : null;
	})}</div>`;
}

/** One project on its own (deep link #team/project/<id>). */
export function ProjectView({ id }) {
	useTopics(["team", "lang"]);
	const [error, setError] = useState(null);
	const known = T.projects.has(id) || T.full.has(id);
	useEffect(() => {
		setError(null);
		if (!known && T.loaded) {
			fullProject(id).catch((e) => setError(e));
		}
	}, [id, known, T.loaded]);
	return html`<div class="team-project">
		<div class="team-project-bar">
			<button type="button" class="btn small" onClick=${() => setUi({ teamView: "board" })}><${Icon} name="back" size=${16} />${t("team_board")}</button>
		</div>
		${known ? html`<${ProjectCard} id=${id} />` : error ? html`<p class="error">${t("load_failed", error.message)}</p>`
			: html`<p class="muted">${t("loading")}</p>`}
	</div>`;
}
