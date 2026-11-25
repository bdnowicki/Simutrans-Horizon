// Simutrans-Horizon dashboard, 3D view: module worker that fetches chunks from the bridge, decodes them and builds
// their geometry, so the main thread only adds meshes. Messages (each with an `id`, answered with the same id):
//   {op: "init", treeDensity, players, pak, rules}
//                                            -> {gen, min, max, water, shapes}  (players: [[r, g, b] sRGB 0..1] by
//                                               player number, the company colours; pak: the checked pak 3D manifest
//                                               or null, rules: gen/rules.json with the pak's rules merged, or null)
//   {op: "chunk", cx, cy, etag}              -> {status: 200, etag, rev, cx, cy, x0, y0, w, h, season, snowline, parts,
//                                                models, hgrid, top, picks, objects, modelFailures, ...} (top, picks: pickdata.js;
//                                                objects: counts and the generated building models so far; models:
//                                                copies of pak 3D models, pakplace.js)
//                                               | {status: 304} | {status: 404|401|501, error} | {status: 429|503, retry}
//   {op: "modelFailed", path, reason}        -> {} (the main thread could not use a model: generated from now on)
//   {op: "probe", cx, cy}                    -> {season, snowline, rev} of a 16 x 16 chunk (rarely cached by the bridge,
//                                               so it tells the current snowline; nothing is built)
// Artistic License, see LICENSE.txt.
import { decodeChunk } from "./decode.js";
import { buildTerrain } from "./terrain.js";
import { createObjectBuilder, SHAPES } from "./objects.js";
import { createPickBuilder } from "./pickdata.js";
import { transferables } from "./meshbuf.js";
import { ModelStore, modelTransferables } from "./pakplace.js";
import { HEIGHT_STEP } from "./config.js";

const DESC_KINDS = "buildings,ways,trees,bridges,tunnels,signs,wayobjs";

let catalogue = null;
let objects = null;
let pickData = null;
let world = { min: null, max: null, water: 0 };
let treeDensity = 1;
let players = [];
let rules = null;
let buildingInstanceMin = 0;
let pak = null;
let store = null;
let mapSize = null;

class HttpError extends Error {
	constructor(status, message, retry) {
		super(message);
		this.status = status;
		this.retry = retry;
	}
}

async function getJson(url, headers) {
	const r = await fetch(url, { credentials: "same-origin", cache: "no-store", headers: headers || {} });
	if (r.status === 304) {
		return { status: 304 };
	}
	let body = null;
	try {
		body = await r.json();
	} catch (e) { /* not JSON */ }
	if (!r.ok || !body || body.ok === false) {
		const retry = Number(r.headers.get("Retry-After")) || 1;
		const msg = (body && (body.detail || body.error)) || "HTTP " + r.status;
		throw new HttpError(r.status, msg, retry);
	}
	return { status: r.status, body, etag: r.headers.get("ETag") };
}

async function loadCatalogue() {
	const { body } = await getJson("/api/desc_list?kinds=" + DESC_KINDS);
	catalogue = body;
	objects = createObjectBuilder(catalogue, { hs: HEIGHT_STEP, treeDensity, rules, players, buildingInstanceMin, pak, store,
		size: mapSize });
	pickData = createPickBuilder(catalogue, HEIGHT_STEP, objects);
}

/** The rules of the generated buildings, trees and fields (gen/rules.json); without them the code defaults apply. */
async function loadRules() {
	try {
		const r = await fetch(new URL("./gen/rules.json", import.meta.url), { credentials: "same-origin" });
		rules = r.ok ? await r.json() : null;
	} catch (e) {
		rules = null;
	}
}

async function init(m) {
	treeDensity = m.treeDensity ?? 1;
	players = Array.isArray(m.players) ? m.players : [];
	buildingInstanceMin = m.buildingInstanceMin | 0;
	pak = m.pak || null;
	store = pak ? new ModelStore(pak.units) : null;
	mapSize = m.size && m.size.x > 0 && m.size.y > 0 ? { x: m.size.x | 0, y: m.size.y | 0 } : null;
	if (m.rules) {
		rules = m.rules;
	} else {
		await loadRules();
	}
	await loadCatalogue();
	// the height range of the whole map: border skirts reach below the lowest ground, frustum tests above the highest
	try {
		const { body } = await getJson("/api/heights?step=16");
		world = { min: body.min, max: body.max, water: body.water | 0 };
	} catch (e) {
		if (e.status === 401) {
			throw e;
		}
		world = { min: null, max: null, water: 0 };
	}
	const shapes = {};
	for (const [k, s] of Object.entries(SHAPES)) {
		shapes[k] = { position: s.position.slice(), color: s.color.slice(), index: s.index.slice() };
	}
	return { reply: { gen: catalogue.gen, min: world.min, max: world.max, water: world.water, shapes } };
}

async function chunk(m) {
	const t0 = performance.now();
	const res = await getJson(`/api/scene3d?cx=${m.cx}&cy=${m.cy}`, m.etag ? { "If-None-Match": m.etag } : null);
	if (res.status === 304) {
		return { reply: { status: 304, fetch_ms: performance.now() - t0 } };
	}
	const j = res.body;
	const t1 = performance.now();
	if (j.desc_gen !== undefined && catalogue && j.desc_gen !== catalogue.gen) {
		await loadCatalogue(); // another pakset (a restarted game): the indices refer to another catalogue
	}
	const c = await decodeChunk(j);
	const need = objects.needed(c);
	if (need && need.size) {
		await store.ensure(need); // the model files of the pak 3D, fetched and checked once
	}
	const t2 = performance.now();
	const floor = world.min !== null ? Math.min(world.min, world.water) - 1 : undefined;
	const terrain = buildTerrain(c, { hs: HEIGHT_STEP, floor });
	const parts = terrain.parts, models = [];
	for (const p of objects.build(c)) {
		(p.type === "model" ? models : parts).push(p);
	}
	const shapes = objects.newShapes();
	const pick = pickData(c);
	const t3 = performance.now();
	const reply = {
		status: 200, etag: res.etag, rev: j.rev, cx: c.cx, cy: c.cy, x0: c.x0, y0: c.y0, w: c.w, h: c.h, water: c.water,
		season: c.season, snowline: c.snowline,
		count: c.objs.n, parts, models, modelFailures: store ? store.takeFailed() : [], hgrid: terrain.hgrid, top: pick.top, picks: pick.picks, minLevel: terrain.minLevel,
		maxLevel: terrain.maxLevel, objects: objects.info(), shapes,
		fetch_ms: t1 - t0, decode_ms: t2 - t1, build_ms: t3 - t2,
	};
	const transfer = transferables(parts).concat(modelTransferables(models), [terrain.hgrid.buffer, pick.top.buffer, pick.picks.buffer]);
	return { reply, transfer: shapes ? transfer.concat(transferables(Object.values(shapes))) : transfer };
}

self.onmessage = async (e) => {
	const m = e.data;
	try {
		if (m.op === "modelFailed") {
			if (store) {
				store.fail(m.path, m.reason || "failed");
			}
			self.postMessage({ id: m.id, ok: true });
			return;
		}
		if (m.op === "probe") {
			const { body } = await getJson(`/api/scene3d?cx=${m.cx | 0}&cy=${m.cy | 0}&size=16`);
			self.postMessage({ id: m.id, ok: true, season: body.season, snowline: body.snowline, rev: body.rev });
			return;
		}
		const { reply, transfer } = m.op === "init" ? await init(m) : await chunk(m);
		self.postMessage(Object.assign({ id: m.id, ok: true }, reply), transfer || []);
	} catch (err) {
		self.postMessage({ id: m.id, ok: false, status: err.status || 0, retry: err.retry || 0,
			error: String((err && err.message) || err) });
	}
};
