// Simutrans-Horizon dashboard, 3D view: world conventions and quality profiles. Artistic License, see LICENSE.txt.
//
// World: three.js Y up, X = map x, Z = map y, 1 unit = one square, Y = height level * HEIGHT_STEP.

export const HEIGHT_STEP = 0.2041; // 16 px per level at 128 px squares, seen at 30 degrees (F0)
export const CHUNK = 64; // squares per scene3d chunk side (size=64)
export const ELEVATION = Math.PI / 6; // iso camera: 30 degrees above the ground
export const BASE_PPU = 16; // iso camera: pixels per square side at zoom 1
export const MAX_PPU = 190; // closest iso zoom (a square diamond of about 270 px)
export const ISO_DIST = 1000; // iso camera distance from its target (orthographic: only the depth range)
export const BUILDING_HEADROOM = 64; // levels above the highest terrain that buildings may reach (frustum tests)
export const NEAR_MIN_PX = 192; // near chunks are loaded only while a chunk is at least this many pixels wide

/** Azimuth of the iso camera for rotation k: 45 + k * 90 degrees (k = 0 looks like the game's default view). */
export function azimuthOf(k) {
	return Math.PI / 4 + (((k % 4) + 4) % 4) * (Math.PI / 2);
}

/**
 * Lets the browser draw a frame and handle input before the caller goes on: the start of the view (shader programs,
 * the far terrain) is split into short tasks, a slow phone needs 10-40 ms per shader program.
 */
export function yieldTask() {
	const s = globalThis.scheduler;
	return s && typeof s.yield === "function" ? s.yield() : new Promise((r) => setTimeout(r, 0));
}

/**
 * Compiles the shader programs of `objects` one per task, waits until the driver finished them
 * (KHR_parallel_shader_compile) and reads their uniforms (three.js does that on a program's first use), again one per
 * task, so neither the start nor the first frames with them stall. `alive()` false stops.
 */
export async function compileSpread(renderer, objects, camera, scene, alive = () => true) {
	for (const o of objects) {
		if (!alive()) {
			return;
		}
		try {
			renderer.compile(o, camera, scene);
		} catch (e) { /* compiled on first use instead */ }
		await yieldTask();
	}
	for (const o of objects) {
		if (!alive()) {
			return;
		}
		try {
			await renderer.compileAsync(o, camera, scene);
			for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
				const prog = renderer.properties.get(m).currentProgram;
				if (prog && prog.getUniforms) {
					prog.getUniforms();
				}
			}
		} catch (e) { /* done on first use instead */ }
		await yieldTask();
	}
}

export function coarse() {
	try {
		const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
		const small = Math.min(screen.width, screen.height) < 820;
		return !!(touch && small);
	} catch (e) {
		return false;
	}
}

/**
 * Quality profiles: phones (auto) get "low": fewer chunks, no antialiasing, a lower pixel ratio, a coarser far terrain,
 * fewer trees and no shadows. maxChunks: near chunks around the view target; farSamples: height samples of the far
 * terrain (the whole map); farTexture: largest side of its texture (minimap pixels); shadowSize: side of the shadow map.
 */
export const PROFILES = {
	low: { name: "low", dprCap: 1.5, antialias: false, maxChunks: 12, cacheChunks: 20, concurrency: 2, treeDensity: 0.5,
		farSamples: 129 * 129, farTexture: 512, shadows: false, shadowSize: 1024 },
	medium: { name: "medium", dprCap: 1.5, antialias: true, maxChunks: 20, cacheChunks: 32, concurrency: 3, treeDensity: 0.75,
		farSamples: 193 * 193, farTexture: 1024, shadows: true, shadowSize: 1024 },
	high: { name: "high", dprCap: 2, antialias: true, maxChunks: 30, cacheChunks: 48, concurrency: 3, treeDensity: 1,
		farSamples: 257 * 257, farTexture: 2048, shadows: true, shadowSize: 2048 },
};
export const LOD_SCALE = { near: 0.7, normal: 1, far: 1.5 }; // pixel thresholds of the model LODs and the chunk budget
export const TREE_DENSITIES = [0.25, 0.5, 0.75, 1];
const DEFAULTS = { profile: "auto", shadows: null, lod: "normal", trees: null, labels: true, daynight: false };

/**
 * The quality settings of this browser (preference "v3dQuality"): profile auto | low | medium | high; shadows and
 * trees null = as the profile; lod near | normal | far; labels; daynight (the dashboard cannot know whether the
 * player's game shows day and night, so it starts off).
 */
export function loadSettings(load) {
	const v = load("v3dQuality", null);
	const s = Object.assign({}, DEFAULTS);
	if (v && typeof v === "object") {
		if (["auto", "low", "medium", "high"].includes(v.profile)) s.profile = v.profile;
		if (v.shadows === null || typeof v.shadows === "boolean") s.shadows = v.shadows;
		if (LOD_SCALE[v.lod]) s.lod = v.lod;
		if (v.trees === null || TREE_DENSITIES.includes(v.trees)) s.trees = v.trees;
		if (typeof v.labels === "boolean") s.labels = v.labels;
		if (typeof v.daynight === "boolean") s.daynight = v.daynight;
	}
	return s;
}

/**
 * Quality of a view from the settings: the profile (auto: low on phones, else high) with the user's shadows, trees and
 * LOD distance. `auto` is true when the view may change its level by itself (View3D.adapt).
 */
export function qualityProfile(settings = DEFAULTS) {
	const auto = settings.profile === "auto" || !PROFILES[settings.profile];
	const p = Object.assign({}, PROFILES[auto ? (coarse() ? "low" : "high") : settings.profile]);
	const k = LOD_SCALE[settings.lod] || 1;
	p.lodScale = k;
	p.maxChunks = Math.max(4, Math.round(p.maxChunks * Math.sqrt(k)));
	p.cacheChunks = Math.max(p.maxChunks + 4, Math.round(p.cacheChunks * Math.sqrt(k)));
	if (typeof settings.trees === "number") p.treeDensity = settings.trees;
	if (typeof settings.shadows === "boolean") p.shadows = settings.shadows;
	p.auto = auto;
	return p;
}
