// Simutrans-Horizon dashboard, 3D view: day and night, seasons and snow. Shared shader uniforms (ENV) that the
// materials read (parts.js, farlod.js, pakmodels.js), so a change of the light, the season or the snowline is a
// uniform update, never a rebuild of geometry.
//   Day and night mirror the game (src/simutrans/display/simview.cc, simgraph16.cc): with the date shown in days
//   (the default date format) a game day lasts ticks_per_month / days of the month; the half hour of the day selects
//   a night level 0..4 (hours2night), and the game darkens red and green by 0.75^level, blue by 0.83^level. Here the
//   level is interpolated between half hours, the lights are scaled by those factors, the sun swings over the day,
//   lit windows of generated buildings and night_emissive materials of the pak 3D glow at night.
//   Seasons and snow mirror world/simworld.cc: season = month_to_season[month]; a square has snow when its height
//   is at least the snowline (scene3d replies carry it). Trees take the colours of the season in their shader.
// The game time comes from the poll (ticks, ticks_per_month, date) and runs on smoothly between polls.
// Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { S } from "/js/store.js";
import { HEIGHT_STEP } from "./config.js";

const HOURS2NIGHT = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 4, 4, 4, 4, 4];
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_SEASON = [2, 2, 2, 3, 3, 0, 0, 0, 0, 1, 1, 2];
const FALLBACK = { autumn: ["#c0762a", "#b4532a", "#d19a32"], winter: ["#6b5d4d"], spring: ["#7bab47"] };
const EXTRAP_MS = 2500; // the game time runs on at most this long after the last poll
const SEASON_MS = 1500; // a new season fades in over this time
const TOGGLE_MS = 900; // switching day and night on or off
const MIN_REDRAW_MS = 33; // light changes alone redraw at most this often

/** Shared uniforms of the materials (one view at a time). */
export const ENV = {
	uNight: { value: 0 }, // 0 day .. 1 full night (night level / 4)
	uSnowY: { value: 1e6 }, // world height from which a square has snow
	uSnowAmt: { value: 1 },
	uSeason: { value: new THREE.Vector4(1, 0, 0, 0) }, // weights of summer, autumn, winter, spring
	uAutumn: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
	uBare: { value: new THREE.Vector3() },
	uSpring: { value: new THREE.Vector3() },
};

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function hexLin(h, out) {
	const m = /^#([0-9a-f]{6})$/i.exec(h || "");
	const v = m ? [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16) / 255) : [0.5, 0.5, 0.5];
	return out.set(lin(v[0]), lin(v[1]), lin(v[2]));
}

/** Season colours of the trees from the generator rules (rules.trees.colors, as nature.js). */
export function setTreePalette(rules) {
	const c = Object.assign({}, FALLBACK, (rules && rules.trees && rules.trees.colors) || {});
	const a = c.autumn && c.autumn.length ? c.autumn : FALLBACK.autumn;
	for (let i = 0; i < 3; i++) {
		hexLin(a[i % a.length], ENV.uAutumn.value[i]);
	}
	hexLin((c.winter && c.winter[0]) || FALLBACK.winter[0], ENV.uBare.value);
	hexLin((c.spring && c.spring[0]) || FALLBACK.spring[0], ENV.uSpring.value);
}
setTreePalette(null);

/** Night level 0..4 of the game at a half hour of the day (0..48, fractional: interpolated between half hours). */
export function nightLevel(halfHours) {
	const h = (((halfHours - 0.5) % 48) + 48) % 48, i = Math.floor(h), f = h - i;
	const a = HOURS2NIGHT[i], b = HOURS2NIGHT[(i + 1) % 48];
	return a + (b - a) * f;
}

/** Half hour of the day (0..48) at `ticks` (the game's formula with the date shown in days). */
export function halfHourOf(ticks, perMonth, month0) {
	if (!(perMonth > 0)) {
		return 24;
	}
	const t = ((ticks % perMonth) + perMonth) % perMonth;
	return ((t / perMonth) * DAYS[((month0 % 12) + 12) % 12] * 48) % 48;
}

// --- shader patches --------------------------------------------------------------------------------------------

const HS = HEIGHT_STEP.toFixed(5);
export const ENV_COMMON = `
uniform float uNight;
uniform float uSnowY;
uniform float uSnowAmt;
varying vec3 vEnvW;
float envHash(vec3 p) {
	p = fract(p * vec3(0.1031, 0.1030, 0.0973));
	p += dot(p, p.yxz + 33.33);
	return fract((p.x + p.y) * p.z);
}`;
export const ENV_WORLD_VERT = `
	{
		vec4 envW4 = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
		envW4 = instanceMatrix * envW4;
#endif
		vEnvW = (modelMatrix * envW4).xyz;
	}
#include <project_vertex>`;
export const ENV_FRAG_FN = `
const vec3 ENV_SNOW = vec3(0.80, 0.84, 0.90);
vec3 envNormal() {
	vec3 n = normalize(cross(dFdx(vEnvW), dFdy(vEnvW)));
	return dot(n, cameraPosition - vEnvW) < 0.0 ? -n : n;
}`;

/**
 * Adds the world position, the shared uniforms and snow to a material's shaders. o: {ground: "frag" (the fragment's
 * own height, smooth edge) | "instance" (the copy's base: instanceMatrix) | GLSL expression, k: snow strength,
 * up: [lo, hi] smoothstep of the normal's y, decl: extra fragment declarations}.
 */
export function patchEnv(sh, o = {}) {
	for (const k of Object.keys(ENV)) {
		sh.uniforms[k] = ENV[k];
	}
	const inst = o.ground === "instance";
	sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>" + ENV_COMMON
		+ (inst ? "\nvarying float vEnvG;" : ""))
		.replace("#include <project_vertex>", ENV_WORLD_VERT + (inst ? `
#ifdef USE_INSTANCING
	vEnvG = instanceMatrix[3].y;
#else
	vEnvG = 1e5;
#endif` : ""));
	sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>" + ENV_COMMON + ENV_FRAG_FN
		+ (inst ? "\nvarying float vEnvG;" : "") + (o.decl || ""));
	if (o.k > 0) {
		const up = o.up || [0.5, 0.8];
		const g = o.ground === "frag" || !o.ground ? "smoothstep(uSnowY - 0.015, uSnowY + 0.015, vEnvW.y)"
			: inst ? "step(uSnowY, vEnvG)" : "step(uSnowY, " + o.ground + ")";
		sh.fragmentShader = sh.fragmentShader.replace("#include <color_fragment>", `#include <color_fragment>
	if (uSnowY < 1e5) {
		float envS = uSnowAmt * ${g} * smoothstep(${up[0].toFixed(3)}, ${up[1].toFixed(3)}, envNormal().y);
		diffuseColor.rgb = mix(diffuseColor.rgb, ENV_SNOW, envS * ${o.k.toFixed(3)});
	}`);
	}
}

/** Wraps a material: patchEnv(o) after its own onBeforeCompile, with a program cache key of its own. */
export function envMaterial(m, o = {}) {
	const prev = m.onBeforeCompile;
	const own = Object.prototype.hasOwnProperty.call(m, "customProgramCacheKey") ? m.customProgramCacheKey.bind(m) : null;
	m.onBeforeCompile = (sh, r) => {
		if (prev) {
			prev.call(m, sh, r);
		}
		patchEnv(sh, o);
	};
	const key = "env:" + JSON.stringify(o);
	m.customProgramCacheKey = () => (own ? own() + "|" : "") + key;
	return m;
}

// trees: the colours of the season in the vertex shader. Stamped trees carry the attribute `tree` (uint8 x4: class
// + 4 * canopy, random, canopy shade, ground level + 128); instanced trees take the class from the material
// (TREE_CLASS), the random from their place, the canopy from the shape's grey vertex colours.
const TREE_VERT_DECL = `
uniform vec4 uSeason;
uniform vec3 uAutumn[3];
uniform vec3 uBare;
uniform vec3 uSpring;
varying float vTreeG;
#ifdef TREE_ATTR
attribute vec4 tree;
#endif`;
const TREE_VERT = `#include <color_vertex>
	{
#ifdef TREE_ATTR
		float tCls = mod(tree.x, 4.0);
		float tCan = step(3.5, tree.x);
		float tR = tree.y / 255.0;
		float tShade = tree.z / 255.0;
		vTreeG = (tree.w - 128.0) * ${HS};
#else
		float tCls = TREE_CLASS;
		float tMin = min(color.r, min(color.g, color.b)), tMax = max(color.r, max(color.g, color.b));
		float tCan = step(0.3, tMin) * step(tMax - tMin, 0.02);
		float tR = envHash(instanceMatrix[3].xyz * vec3(1.37, 0.0, 1.91) + vec3(0.3, 0.0, 0.7));
		float tShade = color.r;
		vTreeG = instanceMatrix[3].y;
#endif
		if (tCan > 0.5 && tCls < 1.5) {
			vec3 c0 = vColor.rgb;
			float j = 0.8 + 0.4 * fract(tR * 7.31);
			vec3 cA = c0, cW = c0 * 0.72, cS = c0;
			if (tCls > 0.5) {
				float ai = floor(fract(tR * 3.97) * 3.0);
				vec3 au = ai < 0.5 ? uAutumn[0] : ai < 1.5 ? uAutumn[1] : uAutumn[2];
				cA = tR < 0.75 ? au * tShade * j : c0;
				cW = tR < 0.4 ? uBare * tShade * j : c0 * 0.8;
				cS = tR < 0.6 ? uSpring * tShade * j : c0;
			}
			vColor.rgb = c0 * uSeason.x + cA * uSeason.y + cW * uSeason.z + cS * uSeason.w;
		}
	}`;

/** Material of trees: cls 0 evergreen, 1 deciduous, 2 without seasons (instanced), -1 stamped (attribute). */
export function treeMaterial(cls) {
	const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
	if (cls < 0) {
		m.defines = { TREE_ATTR: "" };
	} else {
		m.defines = { TREE_CLASS: cls.toFixed(1) };
	}
	m.onBeforeCompile = (sh) => {
		patchEnv(sh, { ground: "vTreeG", k: 0.85, up: [0.3, 0.7], decl: "\nvarying float vTreeG;" });
		sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>" + TREE_VERT_DECL)
			.replace("#include <color_vertex>", TREE_VERT);
	};
	m.customProgramCacheKey = () => "tree-env-" + cls;
	return m;
}

// --- game time, light and season ----------------------------------------------------------------------------

/** Game ticks from the polls, running on between them (smoothly corrected, frozen while paused). */
class PollClock {
	constructor() {
		this.reset();
	}

	reset() {
		this.last = null; // {wall, ticks, paused}
		this.rate = 0; // ticks per ms
		this.shown = null;
		this.shownAt = 0;
	}

	add(wall, poll) {
		const t = poll && poll.ticks;
		if (typeof t !== "number") {
			return;
		}
		const p = this.last;
		if (p && t < p.ticks - 600000) {
			this.reset(); // another world
		}
		const q = this.last;
		if (q && !poll.paused && !q.paused && wall - q.wall > 200 && t >= q.ticks) {
			const r = (t - q.ticks) / (wall - q.wall);
			this.rate = this.rate > 0 ? this.rate + (r - this.rate) * 0.4 : r;
		} else if (!(this.rate > 0)) {
			this.rate = (poll.mult > 0 ? poll.mult : 16) / 16;
		}
		this.last = { wall, ticks: t, paused: !!poll.paused };
	}

	/** Estimated ticks now (smoothed: the shown time never jumps back by less than a second of game time). */
	now(wall) {
		const p = this.last;
		if (!p) {
			return null;
		}
		const target = p.paused ? p.ticks : p.ticks + Math.min(EXTRAP_MS, wall - p.wall) * this.rate;
		if (this.shown === null || Math.abs(target - this.shown) > Math.max(1000, this.rate * 3000)) {
			this.shown = target;
		} else {
			const dt = Math.min(200, Math.max(0, wall - this.shownAt));
			this.shown += (target - this.shown) * Math.min(1, dt / 400);
		}
		this.shownAt = wall;
		return this.shown;
	}
}

const tmpA = new THREE.Color(), tmpB = new THREE.Color();
const DAY = { hemiSky: new THREE.Color(0xe8f0ff), hemiGround: new THREE.Color(0x6a5a48), hemi: 1.5, sun: 2.0 };

/**
 * The light of the view. update(now) moves the game time on and returns true when the picture must be drawn again;
 * apply(rig) places the sun before a frame. setEnabled(on) switches day and night (off: always day).
 */
export class Sky {
	/** view: {scene, sun, hemi, rig, quality}; sky colours {light, dark}; isDark() -> theme. */
	constructor(view, skyColors, isDark) {
		this.view = view;
		this.skyColors = skyColors;
		this.isDark = isDark;
		this.clock = new PollClock();
		this.enabled = false;
		this.amount = 0; // eased 0..1 of the day/night switch
		this.level = 0; // night level 0..4 (eased switch applied)
		this.halfHour = 24;
		this.season = -1;
		this.seasonFrom = new THREE.Vector4(1, 0, 0, 0);
		this.seasonTo = new THREE.Vector4(1, 0, 0, 0);
		this.seasonAt = 0;
		this.snowline = null;
		this.snowRev = -Infinity;
		this.drawn = { level: -1, az: 0, el: 0, season: -1, snow: null };
		this.lastDraw = 0;
		this.lastFrame = 0;
		this.sunAz = 0; // swing of the sun around its screen direction (radians)
		this.sunEl = Math.atan2(90, 65);
		this.stats = { updates: 0, redraws: 0 };
		this.onPoll();
	}

	/** A new poll (S.poll): the game time and the month. */
	onPoll() {
		const p = S.poll;
		if (!p) {
			return;
		}
		this.clock.add(performance.now(), p);
		const m = p.date && typeof p.date.month === "number" ? p.date.month - 1 : null;
		if (m !== null) {
			const key = (p.date.year | 0) * 12 + m;
			if (key !== this.monthKey) {
				this.monthKey = key;
				this.probeWanted = true; // the snowline moves with the month: ask for a fresh one (chunks.js probeSnow)
			}
			this.month0 = m;
			this.setSeason(MONTH_SEASON[((m % 12) + 12) % 12]);
		}
		this.perMonth = p.ticks_per_month;
	}

	setSeason(s, instant = false) {
		if (s === this.season) {
			return;
		}
		const first = this.season < 0;
		this.season = s;
		this.seasonFrom.copy(ENV.uSeason.value);
		this.seasonTo.set(s === 0 ? 1 : 0, s === 1 ? 1 : 0, s === 2 ? 1 : 0, s === 3 ? 1 : 0);
		this.seasonAt = first || instant ? -Infinity : performance.now();
		if (first || instant) {
			ENV.uSeason.value.copy(this.seasonTo);
		}
	}

	/**
	 * Snowline of a scene3d reply made at map revision rev: a newer revision wins (the bridge may answer with replies
	 * of an earlier month); fresh: a probe (made just now, wins at its revision too).
	 */
	noteSnowline(snowline, rev, fresh = false) {
		if (typeof snowline !== "number") {
			return;
		}
		const r = typeof rev === "number" ? rev : this.snowRev;
		if (!fresh && this.snowline !== null && r <= this.snowRev) {
			return;
		}
		this.snowRev = r;
		this.snowline = snowline;
		ENV.uSnowY.value = (snowline - 0.5) * HEIGHT_STEP;
	}

	setEnabled(on) {
		this.enabled = !!on;
		this.toggleAt = performance.now();
	}

	/** Per frame: true when the light, the season or the snow changed enough to draw again. */
	update(now) {
		const dt = this.lastFrame ? Math.min(200, now - this.lastFrame) : 16;
		this.lastFrame = now;
		// day/night switch, eased
		const want = this.enabled ? 1 : 0;
		if (this.amount !== want) {
			const step = dt / TOGGLE_MS;
			this.amount = want > this.amount ? Math.min(want, this.amount + step) : Math.max(want, this.amount - step);
		}
		let level = 0;
		if (this.amount > 0) {
			const ticks = this.clock.now(now);
			if (ticks !== null && this.month0 !== undefined) {
				this.halfHour = halfHourOf(ticks, this.perMonth, this.month0);
				level = nightLevel(this.halfHour);
			}
		}
		this.level = level * this.amount;
		ENV.uNight.value = this.level / 4;
		// sun: swings from the left in the morning to the right in the evening, higher at noon; the moon at night
		const h = this.halfHour / 2, s = Math.max(0, Math.sin((Math.PI * (h - 6.5)) / 13));
		const dayAz = THREE.MathUtils.clamp((h - 13) / 6.5, -1, 1) * 0.85, dayEl = THREE.MathUtils.degToRad(22 + 36 * s);
		const w = this.amount * Math.min(1, this.level / 3), base = Math.atan2(90, 65);
		const az = this.amount * (dayAz * (1 - w)), el = THREE.MathUtils.lerp(THREE.MathUtils.lerp(base, dayEl, this.amount), base, w);
		this.sunAz = az;
		this.sunEl = el;
		// season fade
		if (this.seasonAt !== -Infinity) {
			const k = Math.min(1, (now - this.seasonAt) / SEASON_MS);
			ENV.uSeason.value.lerpVectors(this.seasonFrom, this.seasonTo, k * k * (3 - 2 * k));
			if (k >= 1) {
				this.seasonAt = -Infinity;
			}
		}
		const d = this.drawn;
		const changed = Math.abs(this.level - d.level) > 0.004 || Math.abs(az - d.az) > 0.002 || Math.abs(el - d.el) > 0.002
			|| d.season !== ENV.uSeason.value.x + ENV.uSeason.value.y * 2 + ENV.uSeason.value.z * 4 + ENV.uSeason.value.w * 8
			|| d.snow !== ENV.uSnowY.value;
		this.stats.updates++;
		if (changed && now - this.lastDraw >= (this.view.quality.name === "low" ? 100 : MIN_REDRAW_MS)) {
			return true;
		}
		return false;
	}

	/** Lights, sky and sun direction for a frame (rig: the camera rig; the sun stays upper left on the screen). */
	apply(rig, scene, hemi, sun) {
		const n = this.level;
		const rg = Math.pow(0.75, n), b = Math.pow(0.83, n);
		hemi.color.copy(DAY.hemiSky).multiply(tmpA.setRGB(rg, rg, b));
		hemi.groundColor.copy(DAY.hemiGround).multiply(tmpA);
		hemi.intensity = DAY.hemi;
		sun.color.setRGB(rg, rg, b);
		sun.intensity = DAY.sun * (1 - 0.25 * Math.min(1, n / 4));
		const sky = tmpB.set(this.isDark() ? this.skyColors.dark : this.skyColors.light).multiply(tmpA);
		scene.background.copy(sky);
		scene.fog.color.copy(sky);
		const cam = rig.camera, t = rig.target;
		const az0 = rig.mode === "iso" ? rig.az : Math.atan2(cam.position.x - t.x, cam.position.z - t.z);
		// screen upper left: the original direction (-cos az * 60 + sin az * 25, 90, sin az * 60 + cos az * 25)
		const a = Math.atan2(-Math.cos(az0) * 60 + Math.sin(az0) * 25, Math.sin(az0) * 60 + Math.cos(az0) * 25) + this.sunAz;
		const r = 110 * Math.cos(this.sunEl), y = 110 * Math.sin(this.sunEl);
		sun.position.set(t.x + Math.sin(a) * r, t.y + y, t.z + Math.cos(a) * r);
		sun.target.position.copy(t);
		sun.target.updateMatrixWorld();
		const d = this.drawn;
		d.level = n;
		d.az = this.sunAz;
		d.el = this.sunEl;
		d.season = ENV.uSeason.value.x + ENV.uSeason.value.y * 2 + ENV.uSeason.value.z * 4 + ENV.uSeason.value.w * 8;
		d.snow = ENV.uSnowY.value;
		this.lastDraw = performance.now();
		this.stats.redraws++;
	}

	info() {
		const u = ENV.uSeason.value;
		return { enabled: this.enabled, amount: Math.round(this.amount * 1000) / 1000, level: Math.round(this.level * 1000) / 1000,
			night: Math.round(ENV.uNight.value * 1000) / 1000, halfHour: Math.round(this.halfHour * 100) / 100,
			season: this.season, seasonWeights: [u.x, u.y, u.z, u.w].map((v) => Math.round(v * 1000) / 1000),
			snowline: this.snowline, snowY: ENV.uSnowY.value, ticks: this.clock.shown, rate: this.clock.rate,
			sunAz: Math.round(this.sunAz * 1000) / 1000, sunEl: Math.round(this.sunEl * 1000) / 1000, stats: Object.assign({}, this.stats) };
	}

	dispose() {
		ENV.uNight.value = 0;
		ENV.uSnowY.value = 1e6;
	}
}
