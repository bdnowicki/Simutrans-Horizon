// Simutrans-Horizon dashboard: factories table (sortable, filters by type and status); a row opens the
// factory's detail panel. The status comes from GET /api/factory_status (refreshed while the table is shown).
// Artistic License, see LICENSE.txt.
import { html, useState, useEffect } from "/vendor/htm/standalone.module.js";
import { S, useTopics, subscribe } from "/js/store.js";
import { refreshFactoryStatus } from "/js/data.js";
import { openPanel } from "/js/panel.js";
import { VTable, sortRows, useNarrow } from "/js/vtable.js";
import { t } from "/js/i18n.js";
import { fmtInt, fmtPct, collator } from "/js/format.js";
import { FACTORY_STATES } from "/js/views/detailparts.js";

const REFRESH_MS = 30000;

/** Load the status of all factories now, every 30 s while the table is shown, and at a new month. */
function useStatusRefresh(visible) {
	useEffect(() => {
		if (!visible) {
			return undefined;
		}
		let timer = null, alive = true;
		const run = () => refreshFactoryStatus().catch(() => {});
		const tick = () => {
			if (!alive) {
				return;
			}
			if (!document.hidden) {
				run();
			}
			timer = setTimeout(tick, REFRESH_MS);
		};
		tick();
		const off = subscribe(["month", "session", "snapshot"], run);
		return () => {
			alive = false;
			clearTimeout(timer);
			off();
		};
	}, [visible]);
}

/** Storage of the slots in % of their capacity (null without slots). */
function fill(slots) {
	let st = 0, mx = 0;
	for (const s of slots || []) {
		st += s.storage || 0;
		mx += s.max || 0;
	}
	return mx > 0 ? (100 * st) / mx : null;
}

const count = (v) => (Array.isArray(v) ? v.length : typeof v === "number" ? v : null);

export function FactoriesView({ visible }) {
	useTopics(visible ? ["factories", "factory_status", "ui", "lang"] : ["lang"]);
	const [q, setQ] = useState("");
	const [type, setType] = useState("");
	const [status, setStatus] = useState("");
	const [sort, setSort] = useState({ key: "name", dir: 1 });
	const narrow = useNarrow();
	useStatusRefresh(visible);
	if (!visible) {
		return null;
	}
	const fs = S.factoryStatus;
	const smap = fs ? fs.map : null;
	const list = (S.factories && S.factories.factories) || [];
	const all = list.filter((f) => f && f.pos).map((f) => {
		const key = f.pos.x + "," + f.pos.y;
		const st = smap && smap.get(key);
		return {
			key, name: String(f.name), type: String(f.type), production: f.production,
			status: st ? st.status : null, productivity: st ? st.productivity : null, halts: st ? st.halts : null,
			inFill: fill(f.inputs), outFill: fill(f.outputs), suppliers: count(f.suppliers), consumers: count(f.consumers),
			x: f.pos.x, y: f.pos.y,
		};
	});
	// type filter: the internal type, shown with the factory name of that type
	const types = new Map();
	for (const r of all) {
		const e = types.get(r.type);
		if (e) {
			e.n++;
		} else {
			types.set(r.type, { name: r.name, n: 1 });
		}
	}
	const typeList = Array.from(types.entries()).sort((a, b) => collator().compare(a[1].name, b[1].name));
	const ql = q.trim().toLowerCase();
	const rows = all.filter((r) => (!type || r.type === type) && (!status || r.status === status)
		&& (!ql || r.name.toLowerCase().includes(ql) || r.type.toLowerCase().includes(ql)));
	const statusText = (s) => t(FACTORY_STATES.includes(s) ? "fs_" + s : "fs_unknown");
	const columns = [
		{ key: "name", label: t("name"), width: "minmax(0, 2.2fr)", render: (r) => html`<span class="ellipsis" title=${r.name}>
			<span class=${"fstatus-dot " + (r.status || "unknown")} title=${statusText(r.status)}></span>${r.name}</span>` },
		{ key: "status", label: t("col_status"), width: "minmax(0, 1fr)", minor: true, value: (r) => (r.status ? FACTORY_STATES.indexOf(r.status) : null),
			render: (r) => (r.status ? statusText(r.status) : html`<span class="muted">–</span>`) },
		{ key: "type", label: t("type"), width: "minmax(0, 1fr)", minor: true, render: (r) => html`<span class="ellipsis muted" title=${r.type}>${r.type}</span>` },
		{ key: "production", label: t("production"), width: "minmax(0, 0.9fr)", align: "right", render: (r) => fmtInt(r.production) },
		{ key: "productivity", label: t("col_productivity"), width: "minmax(0, 0.9fr)", align: "right", render: (r) => fmtPct(r.productivity) },
		{ key: "inFill", label: t("col_input"), width: "minmax(0, 0.9fr)", align: "right", minor: true, render: (r) => fmtPct(r.inFill) },
		{ key: "outFill", label: t("col_output"), width: "minmax(0, 0.9fr)", align: "right", minor: true, render: (r) => fmtPct(r.outFill) },
		{ key: "suppliers", label: t("suppliers"), width: "minmax(0, 0.8fr)", align: "right", minor: true, render: (r) => fmtInt(r.suppliers) },
		{ key: "consumers", label: t("consumers"), width: "minmax(0, 0.8fr)", align: "right", minor: true, render: (r) => fmtInt(r.consumers) },
		{ key: "halts", label: t("col_served"), width: "minmax(0, 0.8fr)", align: "right", minor: true,
			render: (r) => (r.halts === null ? "–" : r.halts > 0 ? t("yes") : html`<span class="muted">${t("no")}</span>`) },
		{ key: "pos", label: t("position"), width: "86px", align: "right", minor: true, value: (r) => r.x * 100000 + r.y,
			render: (r) => `${r.x},${r.y}` },
	];
	const col = columns.find((c) => c.key === sort.key);
	const sorted = sortRows(rows, col, sort.dir);
	const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "name" || key === "type" || key === "status" ? 1 : -1 }));
	const age = fs && fs.at && !fs.missing ? Math.round((Date.now() - fs.at) / 1000) : null;
	const statusNote = fs && fs.missing ? t("status_needs_engine") : age === null ? t("status_loading") : t("status_age", age);
	return html`<div class="page table-page">
		<div class="toolbar">
			<input type="search" class="search" placeholder=${t("search")} aria-label=${t("search")} value=${q} onInput=${(e) => setQ(e.target.value)} />
			<label class="field inline"><span class="flabel">${t("filter_type")}</span>
				<select aria-label=${t("filter_type")} value=${type} onChange=${(e) => setType(e.target.value)}>
					<option value="">${narrow ? t("filter_type") + ": " + t("all") : t("all")}</option>
					${typeList.map(([k, e]) => html`<option value=${k}>${e.name} (${e.n})</option>`)}
				</select>
			</label>
			<label class="field inline"><span class="flabel">${t("filter_status")}</span>
				<select aria-label=${t("filter_status")} value=${status} disabled=${!smap || fs.missing} onChange=${(e) => setStatus(e.target.value)}>
					<option value="">${narrow ? t("filter_status") + ": " + t("all") : t("all")}</option>
					${FACTORY_STATES.map((k) => html`<option value=${k}>${t("fs_" + k)} (${all.filter((r) => r.status === k).length})</option>`)}
				</select>
			</label>
			<span class="muted small count">${t("count_of", fmtInt(rows.length), fmtInt(all.length))} · ${statusNote}</span>
		</div>
		<${VTable} rows=${sorted} columns=${columns} sort=${sort} onSort=${onSort} rowKey=${(r) => r.key}
			label=${t("world_factories")} empty=${t("rows_none")}
			activeKey=${S.ui.panel && S.ui.panel.kind === "factory" ? S.ui.panel.id : undefined}
			onRow=${(r) => openPanel("factory", r.key)} />
	</div>`;
}
