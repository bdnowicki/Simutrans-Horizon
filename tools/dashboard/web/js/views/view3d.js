// Simutrans-Horizon dashboard: the 3D tab. Loads three.js and the scene modules (js/scene3d/) only when the tab is
// opened and frees all of it (renderer, geometry, worker, WebGL context) when the tab is left. A click on the view
// selects like a click on the 2D map and shows the same info card; the view can follow a convoy (followIn3D, also
// from the convoy panel and the info card). With a pak 3D, a toolbar button opens the "Model authors" page (its
// LICENSES.md); a pak that cannot be used shows its error once. The toolbar switches the names of cities and stations
// and opens the quality panel (profile, shadows, detail distance, trees, names, day and night, city cars); a change of
// the profile or the trees builds the view anew (the camera stays). A planned project of the AI team (S.ui.preview3d)
// is drawn as ghosts (scene3d/ghosts.js) in every view built. Texts of the game and of the pak are only ever text
// nodes. Artistic License, see LICENSE.txt.
import { html, useRef, useEffect, useState } from "/vendor/htm/standalone.module.js";
import { S, setUi, subscribe, useTopics, convoyIndex, convoyLive } from "/js/store.js";
import { closePanel } from "/js/panel.js";
import { mapCtl } from "/js/map.js";
import { InfoCard } from "/js/views/infocard.js";
import { t } from "/js/i18n.js";
import { Icon } from "/js/icons.js";

/** The 3D tab is offered unless the bridge or the game says there is no 3D export. */
export function view3dSupported() {
	const v = S.session && S.session.view3d;
	if (v && v.supported === false) {
		return false;
	}
	const m = S.game && S.game.missing;
	return !(Array.isArray(m) && m.includes("3d"));
}

// leave the tab when the 3D export turns out to be missing (e.g. after a reconnect to an older game)
subscribe(["session", "game", "ui"], () => {
	if (S.ui.tab === "view3d" && !view3dSupported()) {
		setUi({ tab: "map" });
	}
});

/** Opens the 3D tab and follows the convoy there (on phones the full-screen panel is closed first). */
export function followIn3D(id) {
	if (!Number.isInteger(id) || !view3dSupported()) {
		return;
	}
	if (window.matchMedia("(max-width: 720px)").matches && S.ui.panel) {
		closePanel();
	}
	setUi({ tab: "view3d", follow3d: { id, at: Date.now() } });
}

// the camera of the last visit, restored when the map was not moved since
let last = null;
// the pak 3D error the user closed (shown once per page)
let pakErrorSeen = null;

function mapCenter() {
	const w = S.poll && S.poll.world;
	const c = mapCtl.lastCenter; // CRS.Simple: lat = -(y + 0.5), lng = x + 0.5
	if (!w || !c) {
		return null;
	}
	const x = Math.floor(c.lng - 0.5), y = Math.floor(-c.lat - 0.5);
	if (!(x >= 0 && y >= 0 && x < w.size_x && y < w.size_y)) {
		return null;
	}
	return { x, y };
}

function initialView() {
	const f = S.ui.follow3d, live = f ? convoyLive(f.id) : null;
	if (live) {
		return { center: { x: live.x, y: live.y } };
	}
	const center = mapCenter();
	if (last && last.worldKey === S.worldKey && (!center || !last.center ||
		(Math.abs(center.x - last.center.x) <= 1 && Math.abs(center.y - last.center.y) <= 1))) {
		return { state: last.state, worldKey: last.worldKey };
	}
	return { center };
}

function StatusLine({ st }) {
	if (!st) {
		return html`<div class="map-status">${t("v3d_loading")}</div>`;
	}
	if (st.phase === "noworld") {
		return html`<div class="map-status">${t("v3d_no_world")}</div>`;
	}
	if (st.phase === "error") {
		return html`<div class="map-status error">${t("v3d_error", st.error || "?")}</div>`;
	}
	const p = st.progress;
	if (st.phase === "loading" && p && p.wanted) {
		return html`<div class="map-status">${t("v3d_chunks", p.ready, p.wanted)}</div>`;
	}
	if (st.phase === "loading") {
		return html`<div class="map-status">${t("v3d_loading")}</div>`;
	}
	return null;
}

function Toolbar({ view, st, onAuthors, onQuality, quality, onRestart }) {
	const free = st && st.mode === "free";
	const labels = !!(st && st.settings && st.settings.labels);
	const btn = (icon, label, fn, pressed, cls = "") => html`<button type="button" class=${"icon-btn" + cls} title=${label} aria-label=${label}
		aria-pressed=${pressed === undefined ? undefined : String(pressed)} onClick=${fn}><${Icon} name=${icon} /></button>`;
	return html`<div class="v3d-toolbar" role="toolbar" aria-label=${t("tab_3d")}>
		${btn("rotl", t("v3d_rotate_left"), () => view.rotate(-1))}
		${btn("rotr", t("v3d_rotate_right"), () => view.rotate(1))}
		${btn("plus", t("v3d_zoom_in"), () => view.zoomBy(1.25))}
		${btn("minus", t("v3d_zoom_out"), () => view.zoomBy(0.8))}
		${btn(free ? "cube" : "eye", free ? t("v3d_iso") : t("v3d_free"), () => view.setMode(free ? "iso" : "free"), free)}
		${btn("people", t("v3d_extras"), () => view.setExtras(!(st && st.extras)), !!(st && st.extras), " v3d-extras-btn")}
		${btn("tag", t("v3d_labels"), () => view.applySettings({ labels: !labels }) && onRestart(), labels, " v3d-labels-btn")}
		${btn("sliders", t("v3d_quality"), onQuality, quality, " v3d-quality-btn")}
		${st && st.pak && st.pak.state === "loaded" ? btn("info", t("v3d_authors"), onAuthors) : null}
	</div>`;
}

/** The quality panel: settings of this browser (config.js loadSettings), applied at once or by building the view anew. */
function QualityPanel({ view, st, onClose, onRestart }) {
	useEffect(() => {
		const key = (e) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [view]);
	const s = (st && st.settings) || {};
	const q = (st && st.quality) || {};
	// the profiles come with the status (config.js is a module of the 3D view, loaded only with the tab)
	const defs = q.profiles || {};
	const prof = defs[s.profile] || defs[q.autoName] || { shadows: false, treeDensity: 1 };
	const set = (patch) => {
		if (view.applySettings(patch)) {
			onRestart();
		}
	};
	const shadows = s.shadows === null || s.shadows === undefined ? prof.shadows : s.shadows;
	const pname = (n) => t("v3d_q_" + n);
	const row = (label, control) => html`<label class="v3d-q-row"><span>${label}</span>${control}</label>`;
	const check = (label, on, fn, cls) => html`<label class=${"v3d-q-check " + cls}><input type="checkbox" checked=${on}
		onChange=${(e) => fn(e.target.checked)} /><span>${label}</span></label>`;
	return html`<div class="v3d-quality" role="dialog" aria-label=${t("v3d_quality")}>
		<div class="v3d-authors-head">
			<h2>${t("v3d_quality")}</h2>
			<button type="button" class="icon-btn" title=${t("close")} aria-label=${t("close")} onClick=${onClose}>
				<${Icon} name="close" /></button>
		</div>
		${row(t("v3d_q_profile"), html`<select class="v3d-q-profile" value=${s.profile} onChange=${(e) => set({ profile: e.target.value })}>
			<option value="auto">${t("v3d_q_auto", pname(q.autoName || "high"))}</option>
			${["low", "medium", "high"].map((n) => html`<option value=${n}>${pname(n)}</option>`)}
		</select>`)}
		${check(t("v3d_q_shadows"), shadows, (v) => set({ shadows: v }), "v3d-q-shadows")}
		${row(t("v3d_q_lod"), html`<select class="v3d-q-lod" value=${s.lod} onChange=${(e) => set({ lod: e.target.value })}>
			${["near", "normal", "far"].map((n) => html`<option value=${n}>${t("v3d_q_" + n)}</option>`)}
		</select>`)}
		${row(t("v3d_q_trees"), html`<select class="v3d-q-trees" value=${s.trees === null || s.trees === undefined ? "" : String(s.trees)}
			onChange=${(e) => set({ trees: e.target.value === "" ? null : Number(e.target.value) })}>
			<option value="">${t("v3d_q_trees_profile", Math.round(prof.treeDensity * 100))}</option>
			${(q.treeDensities || []).map((d) => html`<option value=${String(d)}>${Math.round(d * 100) + " %"}</option>`)}
		</select>`)}
		${check(t("v3d_q_names"), !!s.labels, (v) => set({ labels: v }), "v3d-q-labels")}
		${check(t("v3d_q_daynight"), !!s.daynight, (v) => set({ daynight: v }), "v3d-q-daynight")}
		${check(t("v3d_q_extras"), !!(st && st.extras), (v) => view.setExtras(v), "v3d-q-extras")}
		${q.auto && q.level > 0 ? html`<p class="muted small v3d-q-level">${t("v3d_q_level", q.level)}</p>` : null}
		<p class="muted small">${t("v3d_q_restart")}</p>
	</div>`;
}

/** A pak 3D that cannot be used: its first problems, until closed. */
function PakError({ text, onClose }) {
	return html`<div class="v3d-pak-error" role="alert">
		<span>${t("v3d_pak_error", text)}</span>
		<button type="button" class="icon-btn" title=${t("close")} aria-label=${t("close")} onClick=${onClose}>
			<${Icon} name="close" size=${16} /></button>
	</div>`;
}

/** "Model authors": name and version of the pak 3D and the rows of its LICENSES.md, as text. */
function Authors({ view, pak, onClose }) {
	const [data, setData] = useState(null);
	useEffect(() => {
		let dead = false;
		view.licenses().then((d) => !dead && setData(d));
		const key = (e) => {
			if (e.key === "Escape") {
				onClose();
			}
		};
		window.addEventListener("keydown", key);
		return () => {
			dead = true;
			window.removeEventListener("keydown", key);
		};
	}, [view]);
	const head = [pak.name || t("v3d_pak"), pak.version, pak.license].filter(Boolean).join(" · ");
	let body;
	if (!data) {
		body = html`<p class="muted">${t("loading")}</p>`;
	} else if (!data.rows.length) {
		body = html`<p class="muted">${t("v3d_authors_none")}</p>`;
	} else {
		body = html`<div class="v3d-authors-scroll"><table class="v3d-authors-table">
			<thead><tr><th>${t("v3d_authors_file")}</th><th>${t("v3d_authors_author")}</th><th>${t("v3d_authors_license")}</th>
				<th>${t("v3d_authors_source")}</th></tr></thead>
			<tbody>${data.rows.map((r) => html`<tr><td class="v3d-authors-file">${r.file}</td><td>${r.author}</td><td class="v3d-authors-lic">${r.license}</td>
				<td>${[r.source, r.notes].filter(Boolean).join(" — ")}</td></tr>`)}</tbody>
		</table></div>`;
	}
	return html`<div class="v3d-authors" role="dialog" aria-modal="true" aria-label=${t("v3d_authors")}>
		<div class="v3d-authors-head">
			<h2>${t("v3d_authors")}</h2>
			<button type="button" class="icon-btn" title=${t("close")} aria-label=${t("close")} onClick=${onClose}>
				<${Icon} name="close" /></button>
		</div>
		<p class="v3d-authors-pak">${head}</p>
		${pak.author ? html`<p class="muted small">${pak.author}</p>` : null}
		${body}
	</div>`;
}

/** The convoy the camera follows, with a button to stop. Game names are text nodes only. */
function FollowBadge({ view, follow }) {
	useTopics(["convoys", "lang"]);
	const sum = convoyIndex().map.get(follow.cnv);
	const name = sum ? sum.name : "#" + follow.cnv;
	return html`<div class="v3d-follow" role="status">
		<${Icon} name="follow" size=${16} />
		<span class="v3d-follow-label">${t("v3d_following")}</span>
		<span class="v3d-follow-name">${name}</span>
		${follow.found ? null : html`<span class="muted small">${t("v3d_follow_searching")}</span>`}
		<button type="button" class="icon-btn" title=${t("v3d_follow_stop")} aria-label=${t("v3d_follow_stop")}
			onClick=${() => view.stopFollow()}><${Icon} name="close" size=${16} /></button>
	</div>`;
}

function Hint() {
	useTopics(["ui", "lang"]);
	return S.ui.selection ? null : html`<p class="v3d-hint muted small">${t("v3d_hint")}</p>`;
}

/** The planned project shown as ghosts: its name, look at it, remove the ghosts. */
function GhostBadge({ view }) {
	useTopics(["ui", "lang"]);
	const p = S.ui.preview3d;
	if (!p) {
		return null;
	}
	const b = p.preview && p.preview.bbox;
	const center = Array.isArray(b) && b.length === 4 ? { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) } : null;
	return html`<div class="v3d-ghosts" role="status">
		<span class="plan-swatch"></span>
		<span class="plan-title">${t("plan_in_3d", p.title || "#" + p.id)}</span>
		${center ? html`<button type="button" class="icon-btn" title=${t("fit_plan")} aria-label=${t("fit_plan")}
			onClick=${() => view.lookAt(center.x + 0.5, center.y + 0.5)}><${Icon} name="locate" size=${16} /></button>` : null}
		<button type="button" class="icon-btn plan-clear" title=${t("plan_clear")} aria-label=${t("plan_clear")}
			onClick=${() => setUi({ preview3d: null })}><${Icon} name="close" size=${16} /></button>
	</div>`;
}

export function View3DTab({ visible }) {
	const box = useRef(null);
	const [view, setView] = useState(null);
	const [st, setSt] = useState(null);
	const [fatal, setFatal] = useState(null); // "nowebgl" | "unsupported" | error text
	const [authors, setAuthors] = useState(false);
	const [quality, setQuality] = useState(false);
	const [restart, setRestart] = useState(0); // + 1 builds the view anew (quality profile, trees)
	const [, setSeen] = useState(0);

	const allowed = visible && view3dSupported();
	useTopics(["ui"]);
	const req = S.ui.follow3d;
	useEffect(() => {
		if (view && req) {
			view.follow(req.id);
			setUi({ follow3d: null });
		}
	}, [view, req]);
	// a place to look at (the plan of a project shown in 3D)
	const look = S.ui.look3d;
	useEffect(() => {
		if (view && look) {
			view.lookAt(look.x + 0.5, look.y + 0.5);
			setUi({ look3d: null });
		}
	}, [view, look]);
	useEffect(() => {
		if (!allowed) {
			return undefined;
		}
		let dead = false, v = null;
		setSt(null);
		setFatal(null);
		Promise.all([import("/js/scene3d/view.js"), import("/js/scene3d/ghosts.js")]).then(async ([m, g]) => {
			// the view in a task of its own, not in the one that evaluated three.js (shorter tasks on slow phones)
			await new Promise((r) => setTimeout(r, 0));
			if (dead) {
				return;
			}
			try {
				v = m.createView(box.current, { initial: initialView(), label: t("v3d_label"),
					onStatus: (s) => !dead && setSt(s) });
			} catch (e) {
				setFatal(e instanceof m.NoWebGL2Error ? "nowebgl" : String(e.message || e));
				return;
			}
			// the ghosts of a planned project (S.ui.preview3d) in every view built
			const ghosts = new g.GhostLayer(v);
			v.addLayer(ghosts);
			v.hooks.ghosts = () => ghosts.info();
			setView(v);
		}).catch((e) => {
			if (!dead) {
				setFatal(String((e && e.message) || e));
			}
		});
		return () => {
			dead = true;
			if (v) {
				const state = v.dispose();
				if (state) {
					last = { state, worldKey: S.worldKey, center: mapCenter() };
				}
			}
			setView(null);
			setAuthors(false);
		};
	}, [allowed, restart]);
	useEffect(() => {
		if (!allowed) {
			setQuality(false);
		}
	}, [allowed]);
	const again = () => setRestart((n) => n + 1);

	let msg = null;
	if (fatal === "nowebgl") {
		msg = t("v3d_no_webgl");
	} else if (fatal) {
		msg = t("v3d_error", fatal);
	} else if (st && st.phase === "unsupported") {
		msg = t("v3d_unsupported");
	}
	return html`<div class="v3d">
		<div class="v3d-stage" ref=${box}></div>
		${msg ? html`<div class="v3d-message" role="alert"><p>${msg}</p></div>` : null}
		${view && !msg ? html`<${Toolbar} view=${view} st=${st} onAuthors=${() => setAuthors(true)} quality=${quality}
			onQuality=${() => setQuality(!quality)} onRestart=${again} />` : null}
		${view && !msg && quality && st ? html`<${QualityPanel} view=${view} st=${st} onClose=${() => setQuality(false)} onRestart=${again} />` : null}
		${view && !msg && st && st.pak && st.pak.state === "error" && st.pak.error !== pakErrorSeen
			? html`<${PakError} text=${st.pak.error} onClose=${() => {
				pakErrorSeen = st.pak.error;
				setSeen((n) => n + 1);
			}} />` : null}
		${view && !msg && authors && st && st.pak ? html`<${Authors} view=${view} pak=${st.pak} onClose=${() => setAuthors(false)} />` : null}
		${view && !msg && st && st.follow ? html`<${FollowBadge} view=${view} follow=${st.follow} />` : null}
		${view && !msg ? html`<${GhostBadge} view=${view} />` : null}
		${!msg && visible ? html`<${StatusLine} st=${st} />` : null}
		${view && !msg ? html`<${Hint} />` : null}
		${view && !msg && visible ? html`<${InfoCard} onLocate=${(x, y) => view.lookAt(x + 0.5, y + 0.5)} />` : null}
	</div>`;
}
