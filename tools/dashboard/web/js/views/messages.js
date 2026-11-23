// Simutrans-Horizon dashboard: message feed (newest first, type filter, locate).
// Artistic License, see LICENSE.txt.
import { html, useState } from "/vendor/htm/standalone.module.js";
import { S, useTopics } from "/js/store.js";
import { showOnMap } from "/js/map.js";
import { t, msgTypeName, MESSAGE_TYPE_KEYS } from "/js/i18n.js";
import { fmtDate, relDate } from "/js/format.js";
import { Icon } from "/js/icons.js";

const SHOW_MAX = 300;

export function MessagesView() {
	useTopics(["messages", "lang", "month"]);
	const [type, setType] = useState("");
	const [withPos, setWithPos] = useState(false);
	const all = S.messages;
	const present = new Set(all.map((m) => m.type_name));
	const types = MESSAGE_TYPE_KEYS.filter((k) => present.has(k));
	const list = [];
	for (let i = all.length - 1; i >= 0 && list.length < SHOW_MAX; i--) {
		const m = all[i];
		if ((type && m.type_name !== type) || (withPos && !m.pos)) {
			continue;
		}
		list.push(m);
	}
	const now = S.poll && S.poll.date;
	return html`<div class="page messages">
		<div class="toolbar">
			<label class="field inline">${t("type_filter")}
				<select aria-label=${t("type_filter")} value=${type} onChange=${(e) => setType(e.target.value)}>
					<option value="">${t("all")} (${all.length})</option>
					${types.map((k) => html`<option value=${k}>${msgTypeName(k)}</option>`)}
				</select>
			</label>
			<label class="check"><input type="checkbox" checked=${withPos} onChange=${(e) => setWithPos(e.target.checked)} />${t("only_with_pos")}</label>
		</div>
		${list.length === 0 ? html`<p class="muted">${t("no_messages")}</p>` : html`<ol class="msglist">
			${list.map((m) => html`<li key=${m.seq} class=${"msg type-" + m.type_name}>
				<div class="msg-meta">
					<span class="badge">${msgTypeName(m.type_name)}</span>
					<time title=${fmtDate(m.date)}>${relDate(m.date, now)}</time>
				</div>
				<div class="msg-text">${m.text}</div>
				${m.pos ? html`<button type="button" class="btn small locate" onClick=${() => showOnMap({ kind: "tile", x: m.pos.x, y: m.pos.y }, { marker: true, zoom: 4 })}>
					<${Icon} name="locate" size=${16} />${t("locate")}</button>` : null}
			</li>`)}
		</ol>`}
	</div>`;
}
