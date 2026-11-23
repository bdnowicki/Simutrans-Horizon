// Simutrans-Horizon dashboard: convoys table (virtual scrolling, sort, filters).
// Artistic License, see LICENSE.txt.
import { html, useState, useEffect } from "/vendor/htm/standalone.module.js";
import { S, useTopics, playerName, lineName } from "/js/store.js";
import { refreshFullConvoys } from "/js/data.js";
import { openPanel } from "/js/panel.js";
import { VTable, sortRows, useNarrow } from "/js/vtable.js";
import { t, stateName } from "/js/i18n.js";
import { fmtInt, fmtMoney, fmtPct, collator } from "/js/format.js";
import { ownerColor, lineColor, stateColor, stateCategory, isProblem, isStuck } from "/js/colors.js";

const REFRESH_MS = 20000;

/** Fetch the full convoy list now and every 20 s while the tab is visible. */
function useFullRefresh(visible, refresh, topic) {
	useEffect(() => {
		if (!visible) {
			return undefined;
		}
		let timer = null, alive = true;
		const tick = () => {
			if (!alive) {
				return;
			}
			if (!document.hidden) {
				refresh().catch(() => {});
			}
			timer = setTimeout(tick, REFRESH_MS);
		};
		tick();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [visible]);
}

export { useFullRefresh };

function buildRows() {
	const P = S.positions, i = P.idx;
	const list = (S.convoys && S.convoys.convoys) || [];
	const full = S.full.convoys;
	const rows = [];
	const seen = new Set();
	const make = (id, sum) => {
		const live = P.rows.get(id);
		const f = full && full.get(id);
		const state = live ? P.states[live[i.state]] : sum ? sum.state : f ? f.state : null;
		return {
			id,
			name: sum ? sum.name : f ? f.name : "#" + id,
			owner: live ? live[i.owner] : sum ? sum.owner : f ? f.owner : -1,
			line: live ? live[i.line] : sum ? sum.line : f && f.line ? f.line.id : 0,
			state,
			load: live ? live[i.load] : f ? f.loading_level : null,
			x: live ? live[i.x] : sum && sum.pos ? sum.pos.x : null,
			y: live ? live[i.y] : sum && sum.pos ? sum.pos.y : null,
			speed: f ? f.speed_kmh : null,
			profit: f ? f.profit_this_year : null,
			profitLm: f ? f.profit_last_month : null,
		};
	};
	for (const c of list) {
		seen.add(c.id);
		rows.push(make(c.id, c));
	}
	for (const id of P.rows.keys()) {
		if (!seen.has(id)) {
			rows.push(make(id, null));
		}
	}
	return rows;
}

const STATE_FILTERS = {
	problems: (r) => isProblem(r.state),
	no_route: (r) => r.state === "no_route",
	stuck: (r) => isStuck(r.state),
	loss: (r) => typeof r.profit === "number" && r.profit < 0,
	loading: (r) => stateCategory(r.state) === "busy",
	driving: (r) => r.state === "driving",
	depot: (r) => stateCategory(r.state) === "depot",
};

export function ConvoysView({ visible }) {
	useTopics(visible ? ["convoys", "positions", "players", "lines", "full_convoys", "ui", "lang"] : ["lang"]);
	const [owner, setOwner] = useState("");
	const [line, setLine] = useState("");
	const [stf, setStf] = useState("");
	const [q, setQ] = useState("");
	const [sort, setSort] = useState({ key: "name", dir: 1 });
	const narrow = useNarrow();
	useFullRefresh(visible, refreshFullConvoys);
	if (!visible) {
		return null;
	}

	const all = buildRows();
	const ql = q.trim().toLowerCase();
	const ownerNr = owner === "" ? null : Number(owner);
	const lineId = line === "" ? null : Number(line);
	const sf = STATE_FILTERS[stf];
	const rows = all.filter((r) => (ownerNr === null || r.owner === ownerNr)
		&& (lineId === null || r.line === lineId)
		&& (!sf || sf(r))
		&& (!ql || r.name.toLowerCase().includes(ql) || String(r.id) === ql));

	const columns = [
		{ key: "id", label: t("id"), width: "64px", align: "right", minor: true },
		{ key: "name", label: t("name"), width: "minmax(0, 2.2fr)", render: (r) => html`<span class="ellipsis" title=${r.name}>${r.name}</span>` },
		{ key: "owner", label: t("owner"), width: "minmax(0, 1fr)", minor: true, value: (r) => playerName(r.owner),
			render: (r) => html`<span class="ellipsis"><span class="swatch" style=${{ background: ownerColor(r.owner) }}></span>${playerName(r.owner)}</span>` },
		{ key: "line", label: t("line"), width: "minmax(0, 1.4fr)", minor: true, value: (r) => (r.line ? lineName(r.line) : null),
			render: (r) => (r.line ? html`<span class="ellipsis" title=${lineName(r.line)}><span class="swatch" style=${{ background: lineColor(r.line) }}></span>${lineName(r.line)}</span>` : html`<span class="muted">–</span>`) },
		{ key: "state", label: t("state"), width: "minmax(0, 1.3fr)", value: (r) => stateName(r.state),
			render: (r) => html`<span class=${"ellipsis" + (isProblem(r.state) ? " problem" : "")}><span class="dot" style=${{ background: stateColor(r.state) }}></span>${stateName(r.state)}</span>` },
		{ key: "load", label: t("load"), width: "64px", align: "right", render: (r) => fmtPct(r.load) },
		{ key: "speed", label: t("speed"), width: "74px", align: "right", minor: true, render: (r) => (r.speed === null ? "–" : fmtInt(r.speed) + " km/h") },
		{ key: "profit", label: t("profit_short"), width: "minmax(0, 1fr)", align: "right",
			render: (r) => html`<span class=${r.profit < 0 ? "neg" : ""}>${fmtMoney(r.profit)}</span>` },
		{ key: "profitLm", label: t("profit_lm_short"), width: "minmax(0, 1fr)", align: "right", minor: true,
			render: (r) => html`<span class=${r.profitLm < 0 ? "neg" : ""}>${fmtMoney(r.profitLm)}</span>` },
		{ key: "pos", label: t("position"), width: "86px", align: "right", minor: true, value: (r) => (r.x === null ? null : r.x * 100000 + r.y),
			render: (r) => (r.x === null ? "–" : `${r.x},${r.y}`) },
	];
	const col = columns.find((c) => c.key === sort.key);
	const sorted = sortRows(rows, col, sort.dir);
	const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "name" || key === "line" || key === "owner" ? 1 : -1 }));

	const players = ((S.players && S.players.players) || []).filter((p) => p.convoys > 0);
	const lines = ((S.lines && S.lines.lines) || []).filter((l) => ownerNr === null || l.owner === ownerNr)
		.slice().sort((a, b) => collator().compare(a.name, b.name));
	const age = S.full.convoysAt ? Math.round((Date.now() - S.full.convoysAt) / 1000) : null;

	return html`<div class="page table-page">
		<div class="toolbar">
			<input type="search" class="search" placeholder=${t("search")} aria-label=${t("search")} value=${q} onInput=${(e) => setQ(e.target.value)} />
			<label class="field inline"><span class="flabel">${t("filter_owner")}</span>
				<select aria-label=${t("filter_owner")} value=${owner} onChange=${(e) => { setOwner(e.target.value); setLine(""); }}>
					<option value="">${narrow ? t("filter_owner") + ": " + t("all") : t("all")}</option>
					${players.map((p) => html`<option value=${p.nr}>${p.name}</option>`)}
				</select>
			</label>
			<label class="field inline"><span class="flabel">${t("filter_line")}</span>
				<select aria-label=${t("filter_line")} value=${line} onChange=${(e) => setLine(e.target.value)}>
					<option value="">${narrow ? t("filter_line") + ": " + t("all") : t("all")}</option>
					<option value="0">${t("no_line")}</option>
					${lines.map((l) => html`<option value=${l.id}>${l.name}</option>`)}
				</select>
			</label>
			<label class="field inline"><span class="flabel">${t("filter_state")}</span>
				<select aria-label=${t("filter_state")} value=${stf} onChange=${(e) => setStf(e.target.value)}>
					<option value="">${narrow ? t("filter_state") + ": " + t("all") : t("all")}</option>
					${Object.keys(STATE_FILTERS).map((k) => html`<option value=${k}>${t("st_" + k)}</option>`)}
				</select>
			</label>
			<span class="muted small count">${t("count_of", fmtInt(rows.length), fmtInt(all.length)) + " · " + (age === null ? t("full_data_loading") : t("full_data_age", age))}</span>
		</div>
		${stf === "loss" && !S.full.convoys ? html`<p class="muted small">${t("loss_needs_details")}</p>` : null}
		<${VTable} rows=${sorted} columns=${columns} sort=${sort} onSort=${onSort} rowKey=${(r) => r.id}
			label=${t("tab_convoys")} empty=${t("rows_none")}
			activeKey=${S.ui.panel && S.ui.panel.kind === "convoy" ? S.ui.panel.id : undefined}
			onRow=${(r) => openPanel("convoy", r.id)} />
	</div>`;
}
