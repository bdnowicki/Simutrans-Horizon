// Simutrans-Horizon dashboard: lines table; a row opens the line's detail panel (and highlights its route).
// Artistic License, see LICENSE.txt.
import { html, useState } from "/vendor/htm/standalone.module.js";
import { S, useTopics, setUi, playerName, subscribe } from "/js/store.js";
import { refreshFullLines } from "/js/data.js";
import { openPanel } from "/js/panel.js";
import { mapCtl } from "/js/map.js";
import { VTable, sortRows, useNarrow } from "/js/vtable.js";
import { useFullRefresh } from "/js/views/convoys.js";
import { t } from "/js/i18n.js";
import { fmtInt, fmtMoney, fmtPct } from "/js/format.js";
import { ownerColor, lineColor } from "/js/colors.js";

// fit the map to a line once its route is loaded
let pendingFit = null;
subscribe(["route"], () => {
	if (pendingFit && mapCtl.route && mapCtl.route.id === pendingFit) {
		pendingFit = null;
		mapCtl.fitRoute();
	}
});

export function highlightOnMap(id) {
	pendingFit = id;
	setUi({ tab: "map", highlightLine: id, selection: null });
	requestAnimationFrame(() => {
		mapCtl.invalidate();
		if (mapCtl.route && mapCtl.route.id === id) {
			pendingFit = null;
			mapCtl.fitRoute();
		}
	});
}

export function LinesView({ visible }) {
	useTopics(visible ? ["lines", "players", "full_lines", "ui", "lang"] : ["lang"]);
	const [owner, setOwner] = useState("");
	const [q, setQ] = useState("");
	const [sort, setSort] = useState({ key: "name", dir: 1 });
	const narrow = useNarrow();
	useFullRefresh(visible, refreshFullLines);
	if (!visible) {
		return null;
	}
	const full = S.full.lines;
	const all = ((S.lines && S.lines.lines) || []).map((l) => {
		const f = full && full.get(l.id);
		const lm = f && f.last_month;
		return {
			id: l.id, name: l.name, owner: l.owner, convoys: l.convoys,
			type: f ? f.type : null, stops: f ? (f.stops || []).length : null,
			profit: f && f.this_month ? f.this_month.profit : null,
			profitLm: lm ? lm.profit : null,
			transported: lm ? lm.transported : null,
			use: lm && lm.capacity > 0 ? (100 * lm.transported) / lm.capacity : null,
		};
	});
	const ownerNr = owner === "" ? null : Number(owner);
	const ql = q.trim().toLowerCase();
	const rows = all.filter((r) => (ownerNr === null || r.owner === ownerNr) && (!ql || r.name.toLowerCase().includes(ql)));
	const columns = [
		{ key: "name", label: t("name"), width: "minmax(0, 2.4fr)",
			render: (r) => html`<span class="ellipsis" title=${r.name}><span class="swatch" style=${{ background: lineColor(r.id) }}></span>${r.name}</span>` },
		{ key: "owner", label: t("owner"), width: "minmax(0, 1fr)", minor: true, value: (r) => playerName(r.owner),
			render: (r) => html`<span class="ellipsis"><span class="swatch" style=${{ background: ownerColor(r.owner) }}></span>${playerName(r.owner)}</span>` },
		{ key: "type", label: t("transport"), width: "minmax(0, 1fr)", minor: true, render: (r) => r.type || "–" },
		{ key: "convoys", label: t("convoys"), width: "76px", align: "right", render: (r) => fmtInt(r.convoys) },
		{ key: "stops", label: t("stops"), width: "64px", align: "right", minor: true, render: (r) => fmtInt(r.stops) },
		{ key: "profit", label: t("line_profit_month"), width: "minmax(0, 1fr)", align: "right",
			render: (r) => html`<span class=${r.profit < 0 ? "neg" : ""}>${fmtMoney(r.profit)}</span>` },
		{ key: "profitLm", label: t("line_profit_last"), width: "minmax(0, 1fr)", align: "right", minor: true,
			render: (r) => html`<span class=${r.profitLm < 0 ? "neg" : ""}>${fmtMoney(r.profitLm)}</span>` },
		{ key: "use", label: t("utilisation"), width: "70px", align: "right", minor: true, render: (r) => fmtPct(r.use) },
	];
	const col = columns.find((c) => c.key === sort.key);
	const sorted = sortRows(rows, col, sort.dir);
	const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "name" || key === "owner" || key === "type" ? 1 : -1 }));
	const players = ((S.players && S.players.players) || []).filter((p) => p.lines > 0);
	return html`<div class="page table-page">
		<div class="toolbar">
			<input type="search" class="search" placeholder=${t("search")} aria-label=${t("search")} value=${q} onInput=${(e) => setQ(e.target.value)} />
			<label class="field inline"><span class="flabel">${t("filter_owner")}</span>
				<select aria-label=${t("filter_owner")} value=${owner} onChange=${(e) => setOwner(e.target.value)}>
					<option value="">${narrow ? t("filter_owner") + ": " + t("all") : t("all")}</option>
					${players.map((p) => html`<option value=${p.nr}>${p.name}</option>`)}
				</select>
			</label>
			<span class="muted small count">${t("count_of", fmtInt(rows.length), fmtInt(all.length))}${full ? "" : " · " + t("full_data_loading")}</span>
		</div>
		<${VTable} rows=${sorted} columns=${columns} sort=${sort} onSort=${onSort} rowKey=${(r) => r.id}
			label=${t("tab_lines")} empty=${t("rows_none")}
			activeKey=${S.ui.panel && S.ui.panel.kind === "line" ? S.ui.panel.id : S.ui.highlightLine || undefined}
			onRow=${(r) => openPanel("line", r.id)} />
	</div>`;
}
