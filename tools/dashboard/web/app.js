// Simutrans-Horizon dashboard: entry point. Artistic License, see LICENSE.txt.
import { html, render } from "/vendor/htm/standalone.module.js";
import { S, useTopics, setUi, subscribe, emit, dismissToast } from "/js/store.js";
import { loadSession, connectEvents } from "/js/api.js";
import { t } from "/js/i18n.js";
import { Icon } from "/js/icons.js";
import { StatusBar } from "/js/views/status.js";
import { MapView } from "/js/views/mapview.js";
import { FinancesView } from "/js/views/finances.js";
import { MessagesView } from "/js/views/messages.js";
import { ConvoysView } from "/js/views/convoys.js";
import { LinesView } from "/js/views/lines.js";
import { WorldView } from "/js/views/world.js";
import { View3DTab, view3dSupported } from "/js/views/view3d.js";
import { DetailPanel } from "/js/views/detailpanel.js";
import "/js/panel.js";

const TABS = [
	["map", "tab_map", "map"],
	["view3d", "tab_3d", "cube"],
	["finances", "tab_finances", "money"],
	["messages", "tab_messages", "msg"],
	["convoys", "tab_convoys", "bus"],
	["lines", "tab_lines", "lines"],
	["world", "tab_world", "globe"],
];

// --- theme -----------------------------------------------------------------------------------

function applyTheme() {
	const th = S.ui.theme;
	if (th === "light" || th === "dark") {
		document.documentElement.dataset.theme = th;
	} else {
		delete document.documentElement.dataset.theme;
	}
	emit("theme");
}
applyTheme();
subscribe(["ui"], (_, patch) => {
	if (patch && "theme" in patch) {
		applyTheme();
	}
});
if (window.matchMedia) {
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => emit("theme"));
}

// --- components ------------------------------------------------------------------------------

function Tabs() {
	useTopics(["ui", "lang", "session", "game"]);
	const tabs = TABS.filter(([id]) => id !== "view3d" || view3dSupported());
	return html`<nav class="tabs" role="tablist" aria-label=${t("app_title")}>
		${tabs.map(([id, label, icon]) => html`<button type="button" role="tab" aria-selected=${S.ui.tab === id}
			class=${"tab" + (S.ui.tab === id ? " on" : "")} onClick=${() => setUi({ tab: id })}>
			<${Icon} name=${icon} size=${20} /><span>${t(label)}</span>
		</button>`)}
	</nav>`;
}

function Toasts() {
	useTopics(["toasts"]);
	return html`<div class="toasts" role="status" aria-live="assertive">
		${S.toasts.map((x) => html`<div key=${x.id} class=${"toast " + x.kind}>
			<span class="toast-text">${x.text}</span>
			<button type="button" class="icon-btn" aria-label=${t("close")} onClick=${() => dismissToast(x.id)}><${Icon} name="close" size=${16} /></button>
		</div>`)}
	</div>`;
}

function Banner() {
	useTopics(["game", "sse", "lang"]);
	const g = S.game;
	if (S.sse === "closed") {
		return html`<div class="banner bad">${t("sse_closed")}</div>`;
	}
	if (g && !g.connected) {
		return html`<div class="banner bad">${t("game_down")}${g.error ? html`: <span>${g.error}</span>` : null}</div>`;
	}
	if (g && g.error) {
		return html`<div class="banner warn">${t("game_noworld")}: <span>${g.error}</span></div>`;
	}
	return null;
}

function App() {
	useTopics(["ui", "lang"]);
	const tab = S.ui.tab;
	document.title = t("app_title");
	return html`<${StatusBar} />
		<${Banner} />
		<div class="workspace">
			<main class="views">
				<section class="view" hidden=${tab !== "map"}><${MapView} visible=${tab === "map"} /></section>
				<section class="view" hidden=${tab !== "view3d"}><${View3DTab} visible=${tab === "view3d"} /></section>
				<section class="view scroll" hidden=${tab !== "finances"}>${tab === "finances" ? html`<${FinancesView} />` : null}</section>
				<section class="view scroll" hidden=${tab !== "messages"}><${MessagesView} /></section>
				<section class="view" hidden=${tab !== "convoys"}><${ConvoysView} visible=${tab === "convoys"} /></section>
				<section class="view" hidden=${tab !== "lines"}><${LinesView} visible=${tab === "lines"} /></section>
				<section class="view" hidden=${tab !== "world"}><${WorldView} visible=${tab === "world"} /></section>
			</main>
			<${DetailPanel} />
		</div>
		<${Tabs} />
		<${Toasts} />`;
}

// --- start -----------------------------------------------------------------------------------

async function start() {
	const root = document.getElementById("app");
	root.textContent = "";
	render(html`<${App} />`, root);
	try {
		await loadSession();
	} catch (e) {
		if (e.status === 401) {
			return;
		}
	}
	connectEvents();
}

start();
