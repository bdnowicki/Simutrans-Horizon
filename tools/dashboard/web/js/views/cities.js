// Simutrans-Horizon dashboard: cities table (sortable, searchable); a row opens the city's detail panel.
// Artistic License, see LICENSE.txt.
import { html, useState } from "/vendor/htm/standalone.module.js";
import { S, useTopics } from "/js/store.js";
import { openPanel } from "/js/panel.js";
import { showCityOnMap } from "/js/map.js";
import { VTable, sortRows } from "/js/vtable.js";
import { t } from "/js/i18n.js";
import { fmtInt } from "/js/format.js";
import { share, fmtShare } from "/js/views/citypanel.js";

function signed(v) {
	return typeof v === "number" && v > 0 ? "+" + fmtInt(v) : fmtInt(v);
}

export function CitiesView({ visible }) {
	useTopics(visible ? ["cities", "ui", "lang"] : ["lang"]);
	const [q, setQ] = useState("");
	const [sort, setSort] = useState({ key: "citizens", dir: -1 });
	if (!visible) {
		return null;
	}
	const list = (S.cities && S.cities.cities) || [];
	const all = list.map((c, i) => {
		const lm = c.last_month;
		return {
			key: typeof c.id === "number" ? c.id : "n" + i, id: c.id, name: String(c.name), citizens: c.citizens,
			growth: c.growth_this_month, buildings: c.buildings,
			pax: lm ? share(lm.passengers_transported, lm.passengers_generated) : null,
			mail: lm ? share(lm.mail_transported, lm.mail_generated) : null,
			goods: lm ? share(lm.goods_supplied, lm.goods_needed) : null,
			x: c.townhall ? c.townhall.x : null, y: c.townhall ? c.townhall.y : null, city: c,
		};
	});
	const ql = q.trim().toLowerCase();
	const rows = ql ? all.filter((r) => r.name.toLowerCase().includes(ql)) : all;
	const total = rows.reduce((n, r) => n + (r.citizens || 0), 0);
	const columns = [
		{ key: "name", label: t("name"), width: "minmax(0, 2.2fr)", render: (r) => html`<span class="ellipsis" title=${r.name}>${r.name}</span>` },
		{ key: "citizens", label: t("citizens"), width: "minmax(0, 1fr)", align: "right", render: (r) => fmtInt(r.citizens) },
		{ key: "growth", label: t("growth_month"), width: "minmax(0, 1fr)", align: "right", minor: true,
			render: (r) => html`<span class=${r.growth < 0 ? "neg" : ""}>${signed(r.growth)}</span>` },
		{ key: "buildings", label: t("buildings"), width: "minmax(0, 0.9fr)", align: "right", minor: true, render: (r) => fmtInt(r.buildings) },
		{ key: "pax", label: t("pax_share"), title: t("pax_share_tip"), width: "minmax(0, 1fr)", align: "right", render: (r) => fmtShare(r.pax) },
		{ key: "mail", label: t("mail_share"), title: t("mail_share_tip"), width: "minmax(0, 1fr)", align: "right", render: (r) => fmtShare(r.mail) },
		{ key: "goods", label: t("goods_share"), title: t("goods_share_tip"), width: "minmax(0, 1fr)", align: "right", minor: true,
			render: (r) => fmtShare(r.goods) },
		{ key: "pos", label: t("position"), width: "86px", align: "right", minor: true, value: (r) => (r.x === null ? null : r.x * 100000 + r.y),
			render: (r) => (r.x === null ? "–" : `${r.x},${r.y}`) },
	];
	const col = columns.find((c) => c.key === sort.key);
	const sorted = sortRows(rows, col, sort.dir);
	const onSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: key === "name" ? 1 : -1 }));
	const open = (r) => (typeof r.id === "number" ? openPanel("city", r.id) : showCityOnMap(r.city));
	return html`<div class="page table-page">
		<div class="toolbar">
			<input type="search" class="search" placeholder=${t("search")} aria-label=${t("search")} value=${q} onInput=${(e) => setQ(e.target.value)} />
			<span class="muted small count">${t("count_of", fmtInt(rows.length), fmtInt(all.length))} · ${t("citizens")} ${fmtInt(total)}</span>
		</div>
		<${VTable} rows=${sorted} columns=${columns} sort=${sort} onSort=${onSort} rowKey=${(r) => r.key}
			label=${t("world_cities")} empty=${t("rows_none")}
			activeKey=${S.ui.panel && S.ui.panel.kind === "city" ? S.ui.panel.id : undefined}
			onRow=${open} />
	</div>`;
}
