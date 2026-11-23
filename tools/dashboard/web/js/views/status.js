// Simutrans-Horizon dashboard: status bar (date, speed, player, cash, connection, actions).
// Artistic License, see LICENSE.txt.
import { html, useState, useEffect, useRef } from "/vendor/htm/standalone.module.js";
import { S, useTopics, canAct, emit, setUi } from "/js/store.js";
import { apiAction, logout } from "/js/api.js";
import { t, getLang, setLang, LANGS } from "/js/i18n.js";
import { fmtDateDay, fmtMoney, fmtMoneyShort, fmtNum } from "/js/format.js";
import { Icon } from "/js/icons.js";

function connState() {
	const g = S.game;
	if (S.sse === "closed" || (g && !g.connected)) {
		return "bad";
	}
	if (S.sse !== "open" || !g || g.error || (g.missing && g.missing.length)) {
		return "warn";
	}
	return "ok";
}

function connText() {
	const g = S.game;
	if (S.sse !== "open") {
		return t(S.sse === "closed" ? "sse_closed" : "sse_connecting");
	}
	if (!g) {
		return t("sse_connecting");
	}
	if (!g.connected) {
		return t("game_down");
	}
	if (g.error) {
		return t("game_noworld");
	}
	return t("sse_open");
}

function useClickOutside(ref, open, close) {
	useEffect(() => {
		if (!open) {
			return undefined;
		}
		const fn = (e) => {
			if (ref.current && !ref.current.contains(e.target)) {
				close();
			}
		};
		const key = (e) => {
			if (e.key === "Escape") {
				close();
			}
		};
		document.addEventListener("pointerdown", fn);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("pointerdown", fn);
			document.removeEventListener("keydown", key);
		};
	}, [open]);
}

function ConnPopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef(null);
	useClickOutside(ref, open, () => setOpen(false));
	const g = S.game || {};
	const st = connState();
	const missing = (g.missing || []).join(", ");
	const role = S.session && S.session.role;
	return html`<div class="pop-wrap" ref=${ref}>
		<button type="button" class=${"chip conn " + st} aria-expanded=${open} onClick=${() => setOpen(!open)}
			title=${t("conn_details")}>
			<span class="dot"></span><span class="conn-text">${connText()}</span>
		</button>
		${open ? html`<div class="popover" role="dialog" aria-label=${t("conn_details")}>
			<dl class="kv">
				<dt>${t("stream")}</dt><dd>${t(S.sse === "open" ? "sse_open" : S.sse === "closed" ? "sse_closed" : "sse_connecting")}</dd>
				<dt>${t("game")}</dt><dd>${!S.game ? "–" : !g.connected ? t("game_down") : g.error ? t("game_noworld") : t("game_ok")}
					${g.error ? html`<div class="muted small">${g.error}</div>` : null}</dd>
				${S.game && g.connected ? html`<dt>${t("updates")}</dt><dd>${t(g.events ? "updates_events" : "updates_polling")}</dd>` : null}
				${missing ? html`<dt>!</dt><dd>${t("missing_features", missing)}</dd>` : null}
				<dt>${t("role")}</dt><dd>${role ? t("role_" + role) : "–"}</dd>
				<dt>${t("bridge")}</dt><dd>${S.session ? `${S.session.bridge.version} · ${t("game")} :${S.session.bridge.game_port}` : "–"}</dd>
			</dl>
		</div>` : null}
	</div>`;
}

function MenuPopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef(null);
	useClickOutside(ref, open, () => setOpen(false));
	return html`<div class="pop-wrap" ref=${ref}>
		<button type="button" class="icon-btn" aria-label=${t("more")} aria-expanded=${open} onClick=${() => setOpen(!open)}>
			<${Icon} name="more" size=${20} />
		</button>
		${open ? html`<div class="popover" role="dialog" aria-label=${t("more")}>
			<label class="field">${t("language")}
				<select value=${getLang()} onChange=${(e) => { setLang(e.target.value); emit("lang"); }}>
					${LANGS.map(([code, name]) => html`<option value=${code}>${name}</option>`)}
				</select>
			</label>
			<label class="field">${t("theme")}
				<select value=${S.ui.theme} onChange=${(e) => setUi({ theme: e.target.value })}>
					<option value="auto">${t("theme_auto")}</option>
					<option value="light">${t("theme_light")}</option>
					<option value="dark">${t("theme_dark")}</option>
				</select>
			</label>
			<div class="muted small">${t("role")}: ${S.session ? t("role_" + S.session.role) : "–"}</div>
			<button type="button" class="btn" onClick=${() => logout()}>${t("logout")}</button>
		</div>` : null}
	</div>`;
}

export function StatusBar() {
	useTopics(["poll", "game", "sse", "session", "ui", "lang"]);
	const [busy, setBusy] = useState(null);
	const p = S.poll;
	const paused = p && p.paused;
	const ff = p && p.ff;
	const mult = p && typeof p.mult === "number" ? p.mult / 16 : null;
	const speedText = !p ? "–" : paused ? t("paused") : ff ? t("fast_forward") : t("running");
	const multText = mult !== null && !paused ? "×" + fmtNum(mult, 2) : "";

	const act = async (cmd, body, label) => {
		setBusy(cmd);
		try {
			const r = await apiAction(cmd, body, label);
			if (S.poll) {
				if (typeof r.paused === "boolean") {
					S.poll = Object.assign({}, S.poll, { paused: r.paused });
				}
				if (typeof r.fast_forward === "boolean") {
					S.poll = Object.assign({}, S.poll, { ff: r.fast_forward });
				}
				emit("poll");
			}
		} catch (e) { /* toast shown */ }
		setBusy(null);
	};

	const pl = p && p.player;
	return html`<header class="statusbar">
		<div class="brand"><img src="/img/icon.svg" alt="" width="22" height="22" /><span class="brand-text">${t("app_title")}</span></div>
		<div class="sb-item date" title=${t("game_date")}>${p ? fmtDateDay(p.date, p.month_progress) : "–"}</div>
		<div class=${"chip speed " + (paused ? "paused" : ff ? "ff" : "run")}>${speedText}${multText ? html` <span class="mult">${multText}</span>` : null}</div>
		${pl ? html`<div class="sb-item player" title=${t("player")}>
			<span class="pname">${pl.name}</span>
			<span class=${"cash" + (pl.cash < 0 ? " neg" : "")} title=${fmtMoney(pl.cash)}>${fmtMoneyShort(pl.cash)}</span>
		</div>` : null}
		<div class="sb-spacer"></div>
		${canAct("pause") ? html`<button type="button" class="icon-btn action" disabled=${!p || busy === "pause"}
			aria-label=${paused ? t("resume") : t("pause")} title=${paused ? t("resume") : t("pause")}
			onClick=${() => act("pause", { on: !paused }, paused ? t("resume") : t("pause"))}>
			<${Icon} name=${paused ? "play" : "pause"} size=${20} />
		</button>` : null}
		${canAct("fast_forward") ? html`<button type="button" class=${"icon-btn action" + (ff ? " on" : "")} disabled=${!p || busy === "fast_forward"}
			aria-pressed=${!!ff} aria-label=${ff ? t("ff_off") : t("ff_on")} title=${ff ? t("ff_off") : t("ff_on")}
			onClick=${() => act("fast_forward", { on: !ff }, t("fast_forward"))}>
			<${Icon} name="ff" size=${20} />
		</button>` : null}
		<${ConnPopover} />
		<${MenuPopover} />
	</header>`;
}
