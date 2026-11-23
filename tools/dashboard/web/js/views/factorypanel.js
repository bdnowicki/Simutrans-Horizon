// Simutrans-Horizon dashboard: detail panel of a factory (the game's factory window: production, boosts,
// storage of inputs and outputs, suppliers and consumers, stops and cities, charts). Its supply links are
// emphasised on the map while the panel is open. Artistic License, see LICENSE.txt.
import { html, useState } from "/vendor/htm/standalone.module.js";
import { S, useTopics, factoryIndex } from "/js/store.js";
import { apiGet, canRead, isMissingCommand } from "/js/api.js";
import { useRemote } from "/js/hooks.js";
import { HistoryChart } from "/js/history.js";
import { showOnMap, mapCtl } from "/js/map.js";
import { factoryLinks } from "/js/supply.js";
import { t } from "/js/i18n.js";
import { fmtInt, fmtNum, fmtPct, fmtPos } from "/js/format.js";
import { Icon } from "/js/icons.js";
import { Section, Fig, Meter, Owner, StationLink, CityLink, FactoryLink, FactoryStatus, GoodsName, LoadNote, goToMap }
	from "/js/views/detailparts.js";

const GROUPS = () => [
	{ id: "production", label: t("grp_production"), unit: "count", cols: ["production"] },
	{ id: "boost", label: t("grp_boost"), unit: "pct", cols: ["boost_electric", "boost_passengers", "boost_mail"],
		optional: ["boost_electric", "boost_passengers", "boost_mail"] },
	{ id: "power", label: t("grp_power"), unit: "mw", cols: ["power"], optional: ["power"] },
	{ id: "pax", label: t("passengers"), unit: "count", cols: ["passengers_generated", "passengers_departed", "passengers_arrived"] },
	{ id: "mail", label: t("mail"), unit: "count", cols: ["mail_generated", "mail_departed", "mail_arrived"] },
];

function labels() {
	return {
		production: t("production"), power: t("power"), boost_electric: t("electricity"), boost_passengers: t("passengers"),
		boost_mail: t("mail"), passengers_generated: t("col_generated"), passengers_departed: t("col_departed"),
		passengers_arrived: t("col_arrived"), mail_generated: t("col_generated"), mail_departed: t("col_departed"),
		mail_arrived: t("col_arrived"), storage: t("storage"), received: t("received"), consumed: t("consumed"),
		in_transit: t("col_in_transit"), delivered: t("delivered_n"), produced: t("produced"),
	};
}

const SLOT_GROUPS = (input) => [
	{ id: "storage", label: t("grp_storage"), unit: "count", cols: ["storage"], stock: true },
	{ id: "flow", label: t("grp_flow"), unit: "count", cols: input ? ["received", "consumed"] : ["produced", "delivered"] },
].concat(input ? [{ id: "transit", label: t("col_in_transit"), unit: "count", cols: ["in_transit"], stock: true }] : []);

/** [this month, last month] of a slot's counter. */
function pair(v) {
	return Array.isArray(v) ? v : [null, null];
}

function Slot({ slot, input }) {
	const rows = input ? [["received", slot.received], ["consumed", slot.consumed]]
		: [["produced", slot.produced], ["delivered_n", slot.delivered]];
	return html`<div class="slot">
		<div class="slot-head"><${GoodsName} name=${slot.goods} />
			${typeof slot.factor === "number" ? html`<span class="muted small">${t("factor", fmtInt(slot.factor))}</span>` : null}</div>
		<${Meter} value=${slot.storage} max=${slot.max} label=${t("storage")} unit=${slot.unit} />
		${input ? html`<div class="muted small">${t("in_transit_n", fmtInt(slot.in_transit)) + (typeof slot.max_transit === "number"
			? " (" + t("max_transit", fmtInt(slot.max_transit)) + ")" : "")}</div>` : null}
		<table class="mini slot-table">
			<thead><tr><th></th><th>${t("this_month")}</th><th>${t("last_month")}</th></tr></thead>
			<tbody>${rows.map(([k, v]) => html`<tr><th>${t(k)}</th><td>${fmtInt(pair(v)[0])}</td><td>${fmtInt(pair(v)[1])}</td></tr>`)}
			</tbody>
		</table>
	</div>`;
}

/** Suppliers or consumers with the goods that go this way (from the supply links) and a locate button. */
function Partners({ list, id, dir }) {
	if (!list.length) {
		return html`<p class="muted small">${t("none")}</p>`;
	}
	const links = factoryLinks(id);
	return html`<ul class="partners">${list.map((p) => {
		const pid = p.x + "," + p.y;
		const goods = links.filter((l) => (dir === "in" ? l.from === pid && l.to === id : l.from === id && l.to === pid)).map((l) => l.goods);
		return html`<li class=${p.active === false ? "inactive" : ""}>
			<div class="partner-main">
				<${FactoryLink} pos=${p} name=${p.name} />
				<div class="muted small">${goods.length ? html`${goods.map((g) => html`<${GoodsName} name=${g} />`)} · ` : null}
					${p.active === false ? t("link_inactive") : p.active ? t("link_active") : fmtPos(p)}</div>
			</div>
			<button type="button" class="icon-btn" title=${t("locate")} aria-label=${t("locate") + ": " + p.name}
				onClick=${() => goToMap(() => showOnMap({ kind: "factory", id: pid, x: p.x, y: p.y }, { zoom: 2 }))}>
				<${Icon} name="locate" size=${16} /></button>
		</li>`;
	})}</ul>`;
}

function Boosts({ f }) {
	const b = f.boost || {}, mx = f.max_boost || {};
	const keys = ["electric", "passengers", "mail"].filter((k) => mx[k] > 0 || b[k] > 0);
	if (!keys.length) {
		return null;
	}
	return html`<${Section} title=${t("boosts")} extra=${t("productivity") + " " + fmtPct(f.productivity)}>
		${keys.map((k) => html`<${Meter} value=${b[k] || 0} max=${mx[k] || 0} label=${t(k === "electric" ? "electricity" : k)}
			text=${fmtPct(b[k] || 0) + " / " + fmtPct(mx[k] || 0)} />`)}
	<//>`;
}

/** Power of a power plant (MW it offers) or of a factory that needs power (MW used of its demand). */
function powerText(p) {
	if (!p) {
		return null;
	}
	if (p.producer) {
		return fmtInt(typeof p.generation_mw === "number" ? p.generation_mw : p.mw) + " MW";
	}
	if (typeof p.demand_mw === "number" && p.demand_mw > 0) {
		return fmtInt(Math.abs(p.mw || 0)) + " / " + fmtInt(p.demand_mw) + " MW";
	}
	return null;
}

export function FactoryPanel({ id }) {
	useTopics(["factories", "supply_chain", "goods", "players", "poll", "session", "lang"]);
	const [slotSel, setSlotSel] = useState(0);
	const [x, y] = id.split(",").map(Number);
	const has = canRead("factory");
	const det = useRemote(has ? `factory:${id}:${S.worldKey}` : null, () => apiGet("factory", { x, y }), { every: 10000 });
	const old = !!S.session && (!has || isMissingCommand(det.error));
	const sum = factoryIndex().get(id);
	const d = det.data;
	const f = d ? d.factory : sum;
	const name = f ? f.name : t("factory") + " " + id;
	const power = d ? powerText(f.power) : null;
	const slots = f ? (f.inputs || []).map((s) => [s, true]).concat((f.outputs || []).map((s) => [s, false])) : [];
	const slot = slots[Math.min(slotSel, slots.length - 1)];
	const partners = d ? d.suppliers.concat(d.consumers) : [];
	const locate = () => goToMap(() => showOnMap({ kind: "factory", id, x, y }, { zoom: 2 }));
	const fitLinks = () => goToMap(() => mapCtl.fitPoints([{ x, y }].concat(partners.length ? partners
		: factoryLinks(id).map((l) => (l.from === id ? { x: l.bx, y: l.by } : { x: l.ax, y: l.ay })))));
	return html`<div class="pbody">
		<h2 class="panel-title" tabindex="-1">${name}</h2>
		<div class="panel-sub">${f && f.type ? html`<span>${f.type}</span> · ` : null}${fmtPos({ x, y })}
			${d && typeof f.owner === "number" && f.owner >= 0 ? html` · <${Owner} nr=${f.owner} />` : null}</div>
		<div class="panel-actions">
			<button type="button" class="btn small" onClick=${locate}><${Icon} name="locate" size=${16} />${t("locate_on_map")}</button>
			<button type="button" class="btn small" disabled=${!partners.length && !factoryLinks(id).length} onClick=${fitLinks}>
				<${Icon} name="route" size=${16} />${t("show_links")}</button>
		</div>
		<${LoadNote} error=${old ? (has ? det.error : { status: 403 }) : det.error} loading=${!f && !det.error} />
		${!f && det.error && !old ? html`<p class="muted small">${t("factory_gone")}</p>` : null}
		${f ? html`<div class="figs">
			${d ? html`<${Fig} label=${t("status")} value=${html`<${FactoryStatus} status=${f.status} />`} />
				<${Fig} label=${t("productivity")} value=${fmtPct(f.productivity)} />` : null}
			<${Fig} label=${t("max_production")} value=${t("per_day", fmtInt(f.production))}
				sub=${d && typeof f.production_per_minute === "number" ? t("per_minute", fmtNum(f.production_per_minute, 2)) : null} />
			${d && (power || f.fields || f.min_fields) ? html`<${Fig} label=${power ? t(f.power.producer ? "power_offer" : "power_use") : t("fields")}
				value=${power || t("fields_min", fmtInt(f.fields), fmtInt(f.min_fields))}
				sub=${power ? (f.power.producer ? t("power_last", fmtInt(f.power.last_month_mw)) : t("transformer") + ": " + t(f.power.transformer ? "connected" : "not_connected")) : null} />` : null}
		</div>` : null}
		${d ? html`<${Boosts} f=${f} />` : null}
		${f && (f.inputs || []).length ? html`<${Section} title=${t("inputs")}>${f.inputs.map((s) => html`<${Slot} slot=${s} input=${true} />`)}<//>` : null}
		${f && (f.outputs || []).length ? html`<${Section} title=${t("outputs")}>${f.outputs.map((s) => html`<${Slot} slot=${s} input=${false} />`)}<//>` : null}
		${d ? html`<${Section} title=${t("suppliers")} extra=${fmtInt(d.suppliers.length)}><${Partners} list=${d.suppliers} id=${id} dir="in" /><//>
			<${Section} title=${t("consumers")} extra=${fmtInt(d.consumers.length)}><${Partners} list=${d.consumers} id=${id} dir="out" /><//>
			${partners.length ? html`<p class="muted small">${t("links_on_map")}</p>` : null}
			<${Section} title=${t("halts_serving")} extra=${fmtInt(d.halts.length)}>
				${d.halts.length ? html`<div class="chips">${d.halts.map((h) => html`<${StationLink} id=${h.id} name=${h.name} />`)}</div>`
					: html`<p class="muted small">${t("not_served")}</p>`}
			<//>
			<${Section} title=${t("connected_cities")} extra=${fmtInt(d.cities.length)}>
				${d.cities.length ? html`<ul class="plain">${d.cities.map((c) => html`<li><${CityLink} id=${c.id} name=${c.name} />
					<span class="num muted">${t("commuters_mail", fmtInt(c.passengers), fmtInt(c.mail))}</span></li>`)}</ul>`
					: html`<p class="muted small">${t("none")}</p>`}
			<//>
			<${Section} title=${t("history_12")}>
				<${HistoryChart} history=${d.history} groups=${GROUPS()} labels=${labels()} date=${S.poll && S.poll.date} name=${"factory-" + id} hint=${true} />
			<//>
			${slot && slot[0].history ? html`<${Section} title=${t("goods_history")}>
				${slots.length > 1 ? html`<div class="seg wrap slot-pick" role="group" aria-label=${t("goods_history")}>
					${slots.map(([s], i) => html`<button type="button" aria-pressed=${s === slot[0]} class=${s === slot[0] ? "on" : ""}
						onClick=${() => setSlotSel(i)}>${s.goods}</button>`)}</div>` : null}
				<${HistoryChart} key=${slot[0].goods + (slot[1] ? ":in" : ":out")} history=${slot[0].history} groups=${SLOT_GROUPS(slot[1])}
					labels=${labels()} date=${S.poll && S.poll.date} name=${"factory-" + id + "-" + slot[0].goods} hint=${true} />
			<//>` : null}` : null}
	</div>`;
}
