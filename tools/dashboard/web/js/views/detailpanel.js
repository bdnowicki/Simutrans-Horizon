// Simutrans-Horizon dashboard: the detail panel (line, convoy, station, city, factory): beside the views on wide screens,
// a full-screen sheet with back navigation on phones. Artistic License, see LICENSE.txt.
import { html, useEffect, useRef } from "/vendor/htm/standalone.module.js";
import { S, useTopics } from "/js/store.js";
import { closePanel, panelBack, hasPanelBefore } from "/js/panel.js";
import { useNarrow } from "/js/vtable.js";
import { t } from "/js/i18n.js";
import { Icon } from "/js/icons.js";
import { LinePanel } from "/js/views/linepanel.js";
import { ConvoyPanel } from "/js/views/convoypanel.js";
import { StationPanel } from "/js/views/stationpanel.js";
import { CityPanel } from "/js/views/citypanel.js";
import { FactoryPanel } from "/js/views/factorypanel.js";

const BODIES = { line: LinePanel, convoy: ConvoyPanel, station: StationPanel, city: CityPanel, factory: FactoryPanel };

export function DetailPanel() {
	useTopics(["ui", "lang"]);
	const p = S.ui.panel;
	const narrow = useNarrow();
	const ref = useRef(null);
	const key = p ? p.kind + "/" + p.id : "";

	// focus the title of a newly opened panel (keyboard and screen reader users land in it)
	useEffect(() => {
		const el = ref.current && ref.current.querySelector(".panel-title");
		if (el) {
			el.focus({ preventScroll: true });
		}
	}, [key]);

	useEffect(() => {
		if (!p) {
			return undefined;
		}
		const onKey = (e) => {
			if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".popover")) {
				closePanel();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [!!p]);

	if (!p) {
		return null;
	}
	const Body = BODIES[p.kind];
	const back = narrow || hasPanelBefore();
	return html`<aside class=${"side-panel" + (narrow ? " sheet" : "")} ref=${ref}
		role=${narrow ? "dialog" : "complementary"} aria-modal=${narrow ? "true" : undefined} aria-label=${t(p.kind)}>
		<div class="panel-bar">
			${back ? html`<button type="button" class="icon-btn" aria-label=${t("back")} title=${t("back")} onClick=${panelBack}>
				<${Icon} name="back" size=${20} /></button>` : null}
			<span class="panel-kind">${t(p.kind)}</span>
			<button type="button" class="icon-btn" aria-label=${t("close")} title=${t("close")} onClick=${closePanel}>
				<${Icon} name="close" size=${20} /></button>
		</div>
		<div class="panel-scroll" key=${key}><${Body} id=${p.id} /></div>
	</aside>`;
}
