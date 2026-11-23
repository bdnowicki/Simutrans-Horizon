// Simutrans-Horizon dashboard: detail panel of a station (the game's station window: storage, waiting
// goods by type and next stop, lines, departure board, 12-month chart). Artistic License, see LICENSE.txt.
import { html } from "/vendor/htm/standalone.module.js";
import { S, useTopics, stationIndex, convoyIndex, lineName } from "/js/store.js";
import { apiGet } from "/js/api.js";
import { useRemote } from "/js/hooks.js";
import { HistoryChart } from "/js/history.js";
import { showOnMap } from "/js/map.js";
import { colLabels } from "/js/views/linepanel.js";
import { t } from "/js/i18n.js";
import { fmtInt } from "/js/format.js";
import { Icon } from "/js/icons.js";
import { Section, Fig, Meter, Owner, LineLink, ConvoyLink, StationLink, LoadNote, goToMap } from "/js/views/detailparts.js";

const GROUPS = () => [
	{ id: "pax", label: t("passengers"), unit: "count", cols: ["happy", "unhappy", "no_route", "walked"], optional: ["walked"] },
	{ id: "goods", label: t("grp_handling"), unit: "count", cols: ["waiting", "arrived", "departed"] },
	{ id: "convoys", label: t("convoys_arrived"), unit: "count", cols: ["convoys"] },
];

const CLASSES = ["passengers", "mail", "goods"];

/** Waiting amount per storage class, from waiting_by_goods or else from the station's waiting totals. */
function waitingByClass(d) {
	const out = { passengers: 0, mail: 0, goods: 0 };
	if (Array.isArray(d.waiting_by_goods)) {
		for (const g of d.waiting_by_goods) {
			if (g.class in out) {
				out[g.class] += g.amount || 0;
			}
		}
		return out;
	}
	const w = (d.station && d.station.waiting) || {};
	out.passengers = w.passengers || 0;
	out.mail = w.mail || 0;
	out.goods = Math.max(0, (w.total || 0) - out.passengers - out.mail);
	return out;
}

function Board({ items, dir }) {
	if (!items.length) {
		return html`<p class="muted small">${t("board_empty")}</p>`;
	}
	const cidx = convoyIndex().map;
	return html`<div class="table-wrap"><table class="data compact board">
		<thead><tr><th>${t("time")}</th><th>${t("line")}</th><th>${dir === "dep" ? t("to") : t("from")}</th></tr></thead>
		<tbody>${items.map((x, i) => html`<tr key=${i}>
			<td class="nowrap">${x.time}</td>
			<td class="wrap">${x.line ? html`<${LineLink} id=${x.line} name=${lineName(x.line)} />`
				: html`<${ConvoyLink} id=${x.convoy} name=${cidx.get(x.convoy) ? cidx.get(x.convoy).name : null} />`}</td>
			<td class="wrap"><${StationLink} id=${x.halt} name=${x.name} /></td>
		</tr>`)}</tbody>
	</table></div>`;
}

export function StationPanel({ id }) {
	useTopics(["stations", "lines", "convoys", "players", "poll", "lang"]);
	const det = useRemote(`station:${id}:${S.worldKey}`,
		() => apiGet("station", { id, history: 1, waiting: "goods,next", lines: 1, departures: 12 }), { every: 10000 });
	const d = det.data;
	const st = d && d.station;
	const sum = stationIndex().map.get(id);
	const name = st ? st.name : sum ? sum.name : "#" + id;
	const pos = st ? st.pos : sum ? sum.pos : null;
	const cap = d && d.capacity;
	const wc = d ? waitingByClass(d) : null;
	const accepts = st && st.accepts ? CLASSES.filter((k) => st.accepts[k]) : [];
	const locate = () => goToMap(() => pos && showOnMap({ kind: "station", id, x: pos.x, y: pos.y }));
	// an engine without the detail commands answers only the fields of the station window
	const extras = d && (cap || d.history || d.lines);
	return html`<div class="pbody">
		<h2 class="panel-title" tabindex="-1">${name}</h2>
		<div class="panel-sub">${t("station")} #${id} · <${Owner} nr=${st ? st.owner : sum ? sum.owner : -1} />
			${st ? html` · ${t("n_tiles", fmtInt(typeof st.tiles === "number" ? st.tiles : (d.tiles || []).length))}` : null}</div>
		<div class="panel-actions">
			<button type="button" class="btn small" disabled=${!pos} onClick=${locate}><${Icon} name="locate" size=${16} />${t("locate_on_map")}</button>
		</div>
		<${LoadNote} error=${det.error} loading=${!d} />
		${d && !extras ? html`<p class="note">${t("needs_engine")}</p>` : null}
		${st ? html`<div class="figs">
			<${Fig} label=${t("waiting")} value=${fmtInt(st.waiting && st.waiting.total)} />
			<${Fig} label=${t("happy")} value=${fmtInt(d.this_month && d.this_month.happy)} sub=${t("last_month") + ": " + fmtInt(d.last_month && d.last_month.happy)} />
			<${Fig} label=${t("no_route_pax")} value=${fmtInt(d.this_month && d.this_month.no_route)} sub=${t("last_month") + ": " + fmtInt(d.last_month && d.last_month.no_route)} />
			<${Fig} label=${t("convoys_arrived")} value=${fmtInt(d.this_month && d.this_month.convoys_arrived)} sub=${t("last_month") + ": " + fmtInt(d.last_month && d.last_month.convoys_arrived)} />
		</div>` : null}
		${cap ? html`<${Section} title=${t("storage")} extra=${cap.separate ? t("separate_storage") : t("shared_storage")}>
			${CLASSES.filter((k) => accepts.includes(k) || wc[k] > 0).map((k) => html`<${Meter} value=${wc[k]} max=${cap[k]} label=${t(k)} />`)}
			${accepts.length === 0 && !CLASSES.some((k) => wc[k] > 0) ? html`<p class="muted small">${t("none")}</p>` : null}
		<//>` : null}
		${d && Array.isArray(d.waiting_by_goods) ? html`<${Section} title=${t("waiting_goods")}>
			${d.waiting_by_goods.length ? html`<ul class="plain">${d.waiting_by_goods.map((g) => html`<li>
				<span>${g.goods}</span><span class="num">${fmtInt(g.amount)}${g.unit ? " " + g.unit : ""}</span></li>`)}</ul>`
			: html`<p class="muted small">${t("none")}</p>`}
		<//>` : null}
		${d && Array.isArray(d.waiting_by_next) ? html`<${Section} title=${t("waiting_next")}>
			${d.waiting_by_next.length ? html`<div class="table-wrap"><table class="data compact">
				<thead><tr><th>${t("next_stop")}</th><th>${t("goods")}</th><th class="right">${t("amount")}</th></tr></thead>
				<tbody>${d.waiting_by_next.map((x, i) => html`<tr key=${i}>
					<td class="wrap"><${StationLink} id=${x.halt} name=${x.name} /></td><td>${x.goods}</td><td class="right">${fmtInt(x.amount)}</td>
				</tr>`)}
				${d.waiting_other ? html`<tr><td class="muted" colspan="2">${t("waiting_other")}</td><td class="right">${fmtInt(d.waiting_other)}</td></tr>` : null}
				</tbody></table></div>` : html`<p class="muted small">${t("none")}</p>`}
		<//>` : null}
		${d && Array.isArray(d.lines) ? html`<${Section} title=${t("lines_here")} extra=${fmtInt(d.lines.length)}>
			${d.lines.length ? html`<div class="chips">${d.lines.map((l) => html`<${LineLink} id=${l.id} name=${l.name} />`)}</div>`
				: html`<p class="muted small">${t("none")}</p>`}
			${d.lineless_convoys && d.lineless_convoys.length ? html`<div class="card-h">${t("lineless_convoys")}</div>
				<div class="chips">${d.lineless_convoys.map((c) => html`<${ConvoyLink} id=${c.id} name=${c.name} />`)}</div>` : null}
		<//>` : null}
		${d && Array.isArray(d.departures) ? html`<${Section} title=${t("departures")}><${Board} items=${d.departures} dir="dep" /><//>` : null}
		${d && Array.isArray(d.arrivals) ? html`<${Section} title=${t("arrivals")}><${Board} items=${d.arrivals} dir="arr" /><//>` : null}
		${d ? html`<${Section} title=${t("this_month") + " / " + t("last_month")}>
			<table class="mini">
				<thead><tr><th></th><th>${t("this_month")}</th><th>${t("last_month")}</th></tr></thead>
				<tbody>${["happy", "unhappy", "no_route", "arrived", "departed", "convoys_arrived"].map((k) => html`<tr>
					<th>${t(k === "no_route" ? "no_route_pax" : k)}</th><td>${fmtInt(d.this_month && d.this_month[k])}</td><td>${fmtInt(d.last_month && d.last_month[k])}</td>
				</tr>`)}</tbody>
			</table>
		<//>` : null}
		${d && d.history ? html`<${Section} title=${t("history_12")}>
			<${HistoryChart} history=${d.history} groups=${GROUPS()} labels=${colLabels()} date=${S.poll && S.poll.date} name=${"station-" + id} />
		<//>` : null}
	</div>`;
}
