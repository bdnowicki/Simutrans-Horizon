// Simutrans-Horizon dashboard, 3D view: the glTF models of the pak 3D on the main thread. loadPak() reads and checks
// /pak3d/manifest.json (only when /api/session says the bridge serves a pak 3D) and merges its rules over
// gen/rules.json; ModelCache loads each model file once (GLTFLoader; embedded textures come as blob: URLs, hence the
// CSP's `connect-src 'self' blob:`), bakes its nodes into one geometry per material (scaled by 1/units.tile) and
// checks the limits again (triangles, decoded texture sizes); ModelBatch draws copies of a model as one
// InstancedMesh per material sharing the instance matrices, with the company colour on the materials player1 /
// player2 (and those named by the entry's player_color); ModelLayer draws the "model" parts of the chunks
// (pakplace.js): per model and LOD level, the copies of all shown chunks in one batch, or one batch per chunk
// when a model has more than SHARED_MAX copies (trees). The LOD level follows the size of the model on the screen
// with thresholds per kind (LOD_PX: vehicles switch to their finest level much earlier than buildings), scaled by the
// LOD distance setting. A model that cannot be used is reported to the worker, whose chunks then generate the objects
// instead. Materials get the shared uniforms of sky.js: snow on buildings and trees, night_emissive lit at night
// (per copy, from its place: some buildings later than others; vehicles and featured models always). A model with
// animation clips keeps its nodes as separate parts whose transform is a uniform driven by an AnimationMixer, which
// runs only while a copy of it was drawn recently (paused off screen). GLTFLoader is imported only when a pak 3D is
// loaded. Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { ownerColor, ownerColor2 } from "/js/colors.js";
import { validateManifest, mergeRules, pakUrl, parseLicenses, triangleLimit, TEXTURE_LIMIT, PLAYER1, PLAYER2, NIGHT,
	DEFAULT_HEIGHT_STEP } from "./pak.js";
import { patchEnv } from "./sky.js";

// a model at least this many pixels large uses LOD 0, 1, 2; smaller ones the next
export const LOD_PX = { building: [120, 40, 12], tree: [64, 22, 7], sign: [48, 16, 5], vehicle: [44, 15, 5],
	citycar: [30, 10, 4], pedestrian: [22, 8, 3] };
let lodScale = 1;
/** LOD distance setting: > 1 keeps the finer levels longer (far), < 1 switches earlier (near). */
export function setLodScale(s) {
	lodScale = s > 0 ? s : 1;
}
const SHARED_MAX = 4096; // copies of a model gathered across chunks; more get a batch per chunk
const ANIM_SEEN_MS = 400; // an animation runs while a copy was drawn within this time
const MOVING = new Set(["vehicle", "citycar", "pedestrian"]);
const LOD_MS = 150;
const MAP_KEYS = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "bumpMap",
	"lightMap", "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap", "sheenColorMap", "specularColorMap",
	"transmissionMap", "thicknessMap"];

const warned = new Set();
/** console.warn once per text (unknown manifest fields, unusable models). */
export function warnOnce(text) {
	if (!warned.has(text)) {
		warned.add(text);
		console.warn("pak 3D: " + text);
	}
}

async function fetchJson(url, what) {
	let r;
	try {
		r = await fetch(url, { credentials: "same-origin" });
	} catch (e) {
		throw new Error(what + ": " + ((e && e.message) || e));
	}
	if (!r.ok) {
		throw new Error(what + ": HTTP " + r.status);
	}
	try {
		return await r.json();
	} catch (e) {
		throw new Error(what + " is not valid JSON");
	}
}

/**
 * The pak 3D of this bridge: {state: "none" | "missing" | "loaded" | "error", pak, rules, error, warnings}.
 * session: /api/session reply (view3d.pak3d says whether /pak3d/ serves a directory; without it nothing under /pak3d/
 * is requested). rules: gen/rules.json, with the pak's "rules" and "generators" merged over it when loaded.
 */
export async function loadPak(session) {
	const out = { state: "none", pak: null, rules: null, error: null, warnings: [] };
	try {
		out.rules = await fetchJson(new URL("./gen/rules.json", import.meta.url), "gen/rules.json");
	} catch (e) {
		out.rules = null;
	}
	if (!(session && session.view3d && session.view3d.pak3d)) {
		return out;
	}
	try {
		const r = await fetch(pakUrl("manifest.json"), { credentials: "same-origin" });
		if (r.status === 404) {
			out.state = "missing";
			return out;
		}
		if (!r.ok) {
			throw new Error("manifest.json: HTTP " + r.status);
		}
		let j;
		try {
			j = await r.json();
		} catch (e) {
			throw new Error("manifest.json is not valid JSON");
		}
		const v = validateManifest(j);
		out.warnings = v.warnings;
		for (const w of v.warnings) {
			warnOnce(w);
		}
		if (!v.ok) {
			throw new Error(v.errors.slice(0, 5).join("; ") + (v.errors.length > 5 ? " (+" + (v.errors.length - 5) + " more)" : ""));
		}
		let rules = out.rules;
		if (v.pak.rules) {
			const over = typeof v.pak.rules === "string" ? await fetchJson(pakUrl(v.pak.rules), v.pak.rules) : v.pak.rules;
			if (!over || typeof over !== "object" || Array.isArray(over)) {
				throw new Error("rules must hold a JSON object");
			}
			rules = mergeRules(rules, over);
		}
		for (const [name, path] of Object.entries(v.pak.generators)) {
			const cat = await fetchJson(pakUrl(path), path);
			if (!cat || typeof cat !== "object" || Array.isArray(cat)) {
				throw new Error(path + " must hold a JSON object (a generator category)");
			}
			rules = mergeRules(rules, { categories: { [name]: cat } });
		}
		out.pak = v.pak;
		out.rules = rules;
		out.state = "loaded";
	} catch (e) {
		out.state = "error";
		out.error = String((e && e.message) || e);
		out.pak = null;
		console.warn("pak 3D ignored: " + out.error);
	}
	return out;
}

/** LICENSES.md of the pak: {rows: [{file, author, license, source, notes}], error}. */
export async function loadLicenses() {
	try {
		const r = await fetch(pakUrl("LICENSES.md"), { credentials: "same-origin" });
		if (!r.ok) {
			return { rows: [], error: "LICENSES.md: HTTP " + r.status };
		}
		return { rows: parseLicenses(await r.text()), error: null };
	} catch (e) {
		return { rows: [], error: String((e && e.message) || e) };
	}
}

// --- models -----------------------------------------------------------------------------------------------------

/** Cache key of a model file for a use (its limits and company coloured materials). */
export function modelKey(path, use) {
	return path + "#" + (use.kind || "building") + (use.featured ? "*" : "") + "#" + (use.player || []).join(",");
}

function plainAttr(a) {
	const n = a.count, k = a.itemSize, arr = new Float32Array(n * k);
	const get = [a.getX, a.getY, a.getZ, a.getW];
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < k; j++) {
			arr[i * k + j] = get[j].call(a, i);
		}
	}
	return new THREE.BufferAttribute(arr, k);
}

/**
 * A mesh's geometry in model space: float positions and normals, baked transform, indexed, scaled. local: keep the
 * mesh's own space (an animated node: its transform is applied in the shader).
 */
function bake(mesh, scale, local = false) {
	const src = mesh.geometry, g = new THREE.BufferGeometry();
	for (const [name, a] of Object.entries(src.attributes)) {
		if (!/^(position|normal|uv|uv1|color|tangent)$/.test(name)) {
			continue;
		}
		g.setAttribute(name, a.isInterleavedBufferAttribute || name === "position" || name === "normal" ? plainAttr(a) : a.clone());
	}
	if (!g.attributes.position) {
		return null;
	}
	const n = g.attributes.position.count;
	const idx = src.index ? Array.from(src.index.array) : Array.from({ length: n }, (_, i) => i);
	const m = local ? new THREE.Matrix4() : new THREE.Matrix4().makeScale(scale, scale, scale).multiply(mesh.matrixWorld);
	if (m.determinant() < 0) {
		for (let i = 0; i + 2 < idx.length; i += 3) {
			const t = idx[i + 1];
			idx[i + 1] = idx[i + 2];
			idx[i + 2] = t;
		}
	}
	g.setIndex(n < 65536 ? new THREE.Uint16BufferAttribute(idx, 1) : new THREE.Uint32BufferAttribute(idx, 1));
	g.applyMatrix4(m);
	if (!g.attributes.normal) {
		g.computeVertexNormals();
	}
	return g;
}

/**
 * Model files of the pak, each loaded once per view. get(path, use) -> record {state: "loading" | "ready" | "failed",
 * model, error}; onChange(key, record) is called when a record leaves "loading".
 */
export class ModelCache {
	/**
	 * onChange(key, rec): a model is ready or failed. warm(objects, textures) (optional, async): compiles the shader
	 * programs of the objects and uploads the textures before a model is used, a little per task.
	 */
	constructor(pak, onChange, warm = null) {
		this.pak = pak;
		this.scale = 1 / ((pak && pak.units && pak.units.tile) || 1);
		this.onChange = onChange;
		this.warm = warm;
		this.addons = null; // {loader, mergeGeometries}, imported with the first model
		this.records = new Map();
		this.stats = { loaded: 0, failed: 0, ms: 0 };
		this.disposed = false;
		const hs = pak && pak.units ? pak.units.height_step / ((pak.units.tile) || 1) : DEFAULT_HEIGHT_STEP;
		if (Math.abs(hs - DEFAULT_HEIGHT_STEP) > DEFAULT_HEIGHT_STEP * 0.05) {
			warnOnce("height step " + hs + " of the pak differs from the view's " + DEFAULT_HEIGHT_STEP);
		}
	}

	get(path, use) {
		const key = modelKey(path, use);
		let rec = this.records.get(key);
		if (!rec) {
			rec = { key, path, use, state: "loading", model: null, error: null };
			this.records.set(key, rec);
			this.load(rec);
		}
		return rec;
	}

	/**
	 * The shader programs (several PBR variants per model, each 50-100 ms to link on an integrated GPU) and the textures
	 * of a model, prepared in short tasks before its first frame instead of all in that frame.
	 */
	async warmModel(model) {
		if (!this.warm) {
			return;
		}
		const objs = model.parts.map((p) => {
			const m = new THREE.InstancedMesh(p.geometry, p.material, 1);
			if (p.player) {
				m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3);
			}
			m.castShadow = m.receiveShadow = true;
			return m;
		});
		const tex = new Set();
		for (const p of model.parts) {
			for (const k of MAP_KEYS) {
				const t = p.material && p.material[k];
				if (t && t.isTexture) {
					tex.add(t);
				}
			}
		}
		try {
			await this.warm(objs, [...tex]);
		} catch (e) { /* done when first drawn instead */ }
		for (const m of objs) {
			m.dispose();
		}
	}

	ready(key) {
		const r = this.records.get(key);
		return r && r.state === "ready" ? r.model : null;
	}

	async load(rec) {
		const t0 = performance.now();
		try {
			if (!this.addons) {
				this.addons = Promise.all([import("/vendor/three/addons/loaders/GLTFLoader.js"),
					import("/vendor/three/addons/utils/BufferGeometryUtils.js")])
					.then(([g, u]) => ({ loader: new g.GLTFLoader(), mergeGeometries: u.mergeGeometries }));
			}
			const addons = await this.addons;
			const gltf = await addons.loader.loadAsync(pakUrl(rec.path));
			if (this.disposed) {
				disposeGltf(gltf);
				return;
			}
			rec.model = this.convert(gltf, rec.use, addons.mergeGeometries);
			await this.warmModel(rec.model);
			if (this.disposed) {
				return;
			}
			rec.state = "ready";
			this.stats.loaded++;
		} catch (e) {
			rec.state = "failed";
			rec.error = String((e && e.message) || e);
			this.stats.failed++;
			warnOnce(rec.path + ": " + rec.error + " (generated instead)");
		}
		this.stats.ms += performance.now() - t0;
		if (!this.disposed && this.onChange) {
			this.onChange(rec.key, rec);
		}
	}

	/**
	 * glTF scene -> {parts: [{geometry, material, player: 0|1|2, base: Color, night, node, uNode}], triangles, bbox, size,
	 * anim: null | {mixer, root, S, seen, last, updates}, ...}.
	 */
	convert(gltf, use, mergeGeometries) {
		const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
		if (!scene) {
			throw new Error("no scene");
		}
		scene.updateMatrixWorld(true);
		const animated = !!(gltf.animations && gltf.animations.length);
		const groups = [], byMat = new Map();
		scene.traverse((o) => {
			if (!o.isMesh || o.isSkinnedMesh) {
				return;
			}
			const mat = Array.isArray(o.material) ? o.material[0] : o.material;
			const g = bake(o, this.scale, animated);
			if (!g) {
				return;
			}
			if (animated) {
				groups.push({ mat, geos: [g], node: o }); // every node moves on its own
				return;
			}
			let l = byMat.get(mat);
			if (!l) {
				l = { mat, geos: [], node: null };
				byMat.set(mat, l);
				groups.push(l);
			}
			l.geos.push(g);
		});
		const S = new THREE.Matrix4().makeScale(this.scale, this.scale, this.scale);
		const players = new Set(use.player || []);
		const parts = [];
		let triangles = 0;
		const xl = TEXTURE_LIMIT[use.featured ? 1 : 0];
		const problems = [];
		for (const { mat: src, geos, node } of groups) {
			let list = geos;
			// merged only when all have the same attributes (mergeGeometries logs an error otherwise)
			const sig = (g) => Object.keys(g.attributes).sort().map((k) => k + g.attributes[k].itemSize + g.attributes[k].array.constructor.name).join();
			if (geos.length > 1 && geos.every((g) => sig(g) === sig(geos[0]))) {
				const merged = mergeGeometries(geos, false);
				if (merged) {
					for (const g of geos) {
						g.dispose();
					}
					list = [merged];
				}
			}
			const name = (src && src.name) || "";
			const player = name === PLAYER2 ? 2 : name === PLAYER1 || players.has(name) ? 1 : 0;
			const base = src && src.color ? src.color.clone() : new THREE.Color(1, 1, 1);
			// an animated node gets a material of its own (its transform is a uniform of it)
			const mat = node && src ? src.clone() : src;
			if (player && mat.color) {
				mat.color.setRGB(1, 1, 1); // the instance colour paints it (a texture still multiplies)
			}
			const night = name === NIGHT && mat.emissive ? { emissive: mat.emissive.clone(), intensity: mat.emissiveIntensity } : null;
			const uNode = node ? { value: S.clone().multiply(node.matrixWorld) } : null;
			if (mat) {
				patchModelMaterial(mat, { kind: use.kind || "building", featured: !!use.featured, night: !!night, uNode });
			}
			for (const k of MAP_KEYS) {
				const tex = mat && mat[k];
				const img = tex && (tex.image || (tex.source && tex.source.data));
				if (img && (img.width > xl || img.height > xl)) {
					problems.push("texture " + img.width + "x" + img.height + " (limit " + xl + ")");
				}
			}
			for (const g of list) {
				triangles += g.index.count / 3;
				g.computeBoundingBox();
				g.computeBoundingSphere();
				parts.push({ geometry: g, material: mat, player, base, night, node, uNode, own: !!node });
			}
		}
		const tl = triangleLimit(use.kind || "building", use.featured);
		if (triangles > tl) {
			problems.push(triangles + " triangles (limit " + tl + ")");
		}
		if (!parts.length) {
			problems.push("no meshes");
		}
		if (problems.length) {
			for (const p of parts) {
				p.geometry.dispose();
				if (p.own) {
					p.material.dispose();
				}
			}
			disposeGltf(gltf);
			throw new Error(problems.join(", "));
		}
		const box = new THREE.Box3();
		for (const p of parts) {
			box.union(p.uNode ? p.geometry.boundingBox.clone().applyMatrix4(p.uNode.value) : p.geometry.boundingBox);
		}
		const sz = box.getSize(new THREE.Vector3());
		// the geometries are copies: the loaded scene's own buffers can go (materials, textures and the nodes of an
		// animated model stay)
		scene.traverse((o) => {
			if (o.isMesh && o.geometry) {
				o.geometry.dispose();
			}
		});
		let anim = null;
		if (animated) {
			const mixer = new THREE.AnimationMixer(scene);
			for (const clip of gltf.animations) {
				mixer.clipAction(clip).play();
			}
			anim = { mixer, root: scene, S, seen: 0, last: 0, updates: 0, clips: gltf.animations.length };
		}
		return { parts, triangles, bbox: box, size: Math.max(sz.x, sz.y, sz.z), top: box.max.y, length: sz.x, width: sz.z,
			radius: Math.max(box.min.length(), box.max.length()), anim };
	}

	/** Moves the animated models on that were drawn recently (paused off screen). True when one moved. */
	animate(now) {
		let moved = false;
		for (const r of this.records.values()) {
			const a = r.model && r.model.anim;
			if (!a) {
				continue;
			}
			if (now - a.seen > ANIM_SEEN_MS) {
				a.last = 0;
				continue;
			}
			const dt = a.last ? Math.min(100, now - a.last) : 16;
			a.last = now;
			a.mixer.update(dt / 1000);
			a.root.updateMatrixWorld(true);
			for (const p of r.model.parts) {
				if (p.uNode) {
					p.uNode.value.copy(a.S).multiply(p.node.matrixWorld);
				}
			}
			a.updates++;
			moved = true;
		}
		return moved;
	}

	/** Animated models: [{path, clips, time, updates, running}] (tests). */
	animInfo() {
		const now = performance.now(), out = [];
		for (const r of this.records.values()) {
			const a = r.model && r.model.anim;
			if (a) {
				out.push({ path: r.path, clips: a.clips, time: Math.round(a.mixer.time * 1000) / 1000, updates: a.updates,
					running: now - a.seen <= ANIM_SEEN_MS });
			}
		}
		return out;
	}

	info() {
		const states = {};
		for (const r of this.records.values()) {
			states[r.state] = (states[r.state] || 0) + 1;
		}
		return Object.assign({ states, models: [...this.records.values()].filter((r) => r.state === "ready").map((r) => ({ path: r.path,
			triangles: r.model.triangles, parts: r.model.parts.length, size: Math.round(r.model.size * 1000) / 1000,
			player: r.model.parts.filter((p) => p.player).length,
			textures: r.model.parts.reduce((n, p) => n + MAP_KEYS.filter((k) => p.material[k] && p.material[k].image).length, 0) })),
		failures: [...this.records.values()].filter((r) => r.state === "failed").map((r) => ({ path: r.path, error: r.error })) }, this.stats);
	}

	dispose() {
		this.disposed = true;
		const done = new Set();
		for (const r of this.records.values()) {
			if (r.model) {
				for (const p of r.model.parts) {
					p.geometry.dispose();
					if (p.material && !done.has(p.material)) {
						done.add(p.material);
						disposeMaterial(p.material);
					}
				}
			}
		}
		this.records.clear();
	}
}

function disposeMaterial(m) {
	for (const k of MAP_KEYS) {
		const t = m[k];
		if (t && t.isTexture) {
			const img = t.image;
			t.dispose();
			if (img && typeof img.close === "function") {
				img.close(); // ImageBitmap
			}
		}
	}
	m.dispose();
}

function disposeGltf(gltf) {
	const mats = new Set();
	(gltf.scene || new THREE.Group()).traverse((o) => {
		if (o.isMesh) {
			o.geometry.dispose();
			(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && mats.add(m));
		}
	});
	for (const m of mats) {
		disposeMaterial(m);
	}
}

/**
 * Shared uniforms (sky.js) on a model's material: snow on buildings and trees (their copy's base above the snowline),
 * night_emissive lit at night (o.night: per copy from its place, vehicles and featured models always), the node
 * transform of an animated model (o.uNode).
 */
function patchModelMaterial(mat, o) {
	const snow = o.kind === "building" || o.kind === "tree";
	const always = MOVING.has(o.kind) || o.featured;
	if (!snow && !o.night && !o.uNode) {
		return;
	}
	mat.onBeforeCompile = (sh) => {
		patchEnv(sh, snow ? { ground: "instance", k: 0.9, up: [0.75, 0.9] } : {});
		if (o.uNode) {
			sh.uniforms.uNode = o.uNode;
			sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform mat4 uNode;")
				.replace("#include <begin_vertex>", "#include <begin_vertex>\n\ttransformed = (uNode * vec4(transformed, 1.0)).xyz;")
				.replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\n\tobjectNormal = mat3(uNode) * objectNormal;");
		}
		if (o.night) {
			sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying float vEnvLit;")
				.replace("#include <project_vertex>", (always ? `\tvEnvLit = smoothstep(0.05, 0.3, uNight) * ${MOVING.has(o.kind) ? "1.0" : "1.6"};\n` : `
#ifdef USE_INSTANCING
	float envH = envHash(instanceMatrix[3].xyz * vec3(0.71, 0.0, 1.13) + vec3(0.5, 0.0, 0.25));
#else
	float envH = 0.5;
#endif
	vEnvLit = smoothstep(envH * 0.7, envH * 0.7 + 0.15, uNight) * (0.7 + 0.3 * fract(envH * 9.7));
`) + "#include <project_vertex>");
			sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vEnvLit;")
				.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vEnvLit;");
		}
	};
	const key = "pak-env|" + [snow, o.night, always, !!o.uNode].join();
	mat.customProgramCacheKey = () => key;
	mat.needsUpdate = true;
}

const tmpColor = new THREE.Color();
const colorCache = new Map();
/** Linear RGB of a company colour (player 1 or 2 colour of owner nr). */
function companyLinear(owner, which) {
	const key = owner * 4 + which;
	let c = colorCache.get(key);
	if (!c) {
		tmpColor.setStyle(which === 2 ? ownerColor2(owner) : ownerColor(owner));
		c = [tmpColor.r, tmpColor.g, tmpColor.b];
		colorCache.set(key, c);
	}
	return c;
}

/** Forgets the cached company colours (after the palette arrived or changed). */
export function resetCompanyColors() {
	colorCache.clear();
}

/**
 * Copies of one model: an InstancedMesh per part, all sharing one instance matrix buffer; parts on company coloured
 * materials get an instance colour (the owner's colour, the material's own colour without an owner).
 */
export class ModelBatch {
	constructor(model, parent, name) {
		this.model = model;
		this.parent = parent;
		this.name = name;
		this.meshes = [];
		this.cap = 0;
		this.n = 0;
		this.matrix = null;
		this.colors = [];
	}

	/** Room for n copies (the arrays of a larger batch keep what was written). */
	reserve(n) {
		if (n <= this.cap) {
			return;
		}
		const cap = Math.max(16, 1 << Math.ceil(Math.log2(n)));
		const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
		matrix.setUsage(THREE.DynamicDrawUsage);
		if (this.matrix) {
			matrix.array.set(this.matrix.array);
		}
		const old = this.meshes;
		this.meshes = [];
		this.colors = [];
		this.model.parts.forEach((p, k) => {
			const m = new THREE.InstancedMesh(p.geometry, p.material, cap);
			m.instanceMatrix = matrix;
			if (p.player) {
				m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
				m.instanceColor.setUsage(THREE.DynamicDrawUsage);
				if (old[k] && old[k].instanceColor) {
					m.instanceColor.array.set(old[k].instanceColor.array);
				}
			}
			m.count = 0;
			m.matrixAutoUpdate = false;
			m.name = this.name;
			m.userData.layer = "pakmodels";
			m.userData.part = k;
			m.castShadow = true;
			m.receiveShadow = true;
			if (this.model.anim) {
				const a = this.model.anim;
				m.onBeforeRender = () => {
					a.seen = performance.now(); // drawn: its animation runs (ModelCache.animate)
				};
			}
			this.parent.add(m);
			this.meshes.push(m);
			this.colors.push(p.player ? m.instanceColor.array : null);
		});
		for (const m of old) {
			m.removeFromParent();
			m.dispose();
		}
		this.matrix = matrix;
		this.cap = cap;
	}

	/** Colour of copy i for owner (a player number, or < 0); rgb overrides the company colour (city cars). */
	setOwner(i, owner, rgb = null) {
		const parts = this.model.parts;
		for (let k = 0; k < parts.length; k++) {
			const a = this.colors[k];
			if (!a) {
				continue;
			}
			const p = parts[k];
			const c = rgb && p.player === 1 ? rgb : owner >= 0 ? companyLinear(owner, p.player) : null;
			a[i * 3] = c ? c[0] : p.base.r;
			a[i * 3 + 1] = c ? c[1] : p.base.g;
			a[i * 3 + 2] = c ? c[2] : p.base.b;
		}
	}

	/** Shows the first n copies; sphere (THREE.Sphere) bounds them for culling (null: never culled). */
	commit(n, sphere = null) {
		this.n = n;
		for (const m of this.meshes) {
			m.count = n;
			m.visible = n > 0;
			if (sphere) {
				m.boundingSphere = sphere;
				m.frustumCulled = true;
			} else {
				m.frustumCulled = false;
			}
			if (m.instanceColor && n) {
				m.instanceColor.clearUpdateRanges();
				m.instanceColor.addUpdateRange(0, n * 3);
				m.instanceColor.needsUpdate = true;
			}
		}
		if (this.matrix && n) {
			this.matrix.clearUpdateRanges();
			this.matrix.addUpdateRange(0, n * 16);
			this.matrix.needsUpdate = true;
		}
	}

	setVisible(v) {
		for (const m of this.meshes) {
			m.visible = v && this.n > 0;
		}
	}

	triangles() {
		let t = 0;
		for (const p of this.model.parts) {
			t += p.geometry.index.count / 3;
		}
		return t * this.n;
	}

	dispose() {
		for (const m of this.meshes) {
			m.removeFromParent();
			m.dispose();
		}
		this.meshes = [];
		this.cap = 0;
	}
}

/** LOD level for a model of `size` squares at `ppu` pixels per square (thresholds of its kind, LOD distance). */
export function lodLevel(size, ppu, kind = "building") {
	const px = size * ppu * lodScale, T = LOD_PX[kind] || LOD_PX.building;
	let l = 0;
	while (l < T.length && px < T[l]) {
		l++;
	}
	return l;
}

/** The model parts of the shown chunks (see the head of this file). */
export class ModelLayer {
	/** view: {scene, rig, chunks, dirty}; cache: ModelCache. */
	constructor(view, cache) {
		this.view = view;
		this.cache = cache;
		this.group = new THREE.Group();
		this.group.name = "pakmodels";
		view.scene.add(this.group);
		this.members = new Map(); // chunk key -> [member]
		this.buckets = new Map(); // model key -> {key, members: Set, batch, large, dirty}
		this.version = -1;
		this.lodDirty = false;
		this.lodAt = 0;
		this.changed = false;
		this.rebuilds = 0;
	}

	/** The model parts of chunk `key` (replacing those it had). */
	setChunk(key, parts) {
		this.removeChunk(key);
		if (!parts || !parts.length) {
			return;
		}
		const list = parts.map((p) => {
			const use = { kind: p.kind, featured: p.featured, player: p.player };
			const keys = p.lods.map((path) => this.cache.get(path, use).key);
			return { chunk: key, p, keys, level: -1, bucket: null, batch: null, visible: false };
		});
		this.members.set(key, list);
		this.relevel(list);
		this.version = -1;
	}

	removeChunk(key) {
		const list = this.members.get(key);
		if (!list) {
			return;
		}
		for (const m of list) {
			this.leave(m);
		}
		this.members.delete(key);
	}

	clear() {
		for (const key of [...this.members.keys()]) {
			this.removeChunk(key);
		}
	}

	/** A model record left "loading" (cache callback). */
	onModel(key, rec) {
		if (rec.state === "failed") {
			const lod0 = [...this.members.values()].some((l) => l.some((m) => m.keys[0] === key));
			if (lod0) {
				this.view.chunks.modelFailed(rec.path, rec.error);
			}
		}
		for (const list of this.members.values()) {
			if (list.some((m) => m.keys.includes(key))) {
				this.relevel(list);
			}
		}
		const b = this.buckets.get(key);
		if (b) {
			b.dirty = true;
		}
		this.view.dirty = true;
	}

	leave(m) {
		if (m.batch) {
			m.batch.dispose();
			m.batch = null;
		}
		if (m.bucket) {
			m.bucket.members.delete(m);
			m.bucket.dirty = true;
			m.bucket = null;
		}
	}

	ppuOf(chunk) {
		const rig = this.view.rig;
		if (rig.mode === "iso") {
			return rig.ppu;
		}
		const e = this.view.chunks.chunks.get(chunk);
		if (!e || e.x0 === undefined) {
			return rig.ppu;
		}
		const pos = rig.camera.position;
		const d = Math.hypot(pos.x - (e.x0 + e.w / 2), pos.y - rig.target.y, pos.z - (e.y0 + e.h / 2));
		return (rig.h || 800) / (Math.max(1, d) * 1.6);
	}

	/** Picks the LOD level of each member (the wanted one if ready, else the nearest finer ready one) and its bucket. */
	relevel(list) {
		for (const m of list) {
			const want = Math.min(m.keys.length - 1, lodLevel(m.p.size, this.ppuOf(m.chunk), m.p.kind));
			let level = -1;
			for (let l = want; l >= 0; l--) {
				if (this.cache.ready(m.keys[l])) {
					level = l;
					break;
				}
			}
			for (let l = want + 1; level < 0 && l < m.keys.length; l++) {
				if (this.cache.ready(m.keys[l])) {
					level = l; // the finer levels are still loading
				}
			}
			if (level === m.level && m.bucket) {
				continue;
			}
			this.leave(m);
			m.level = level;
			if (level < 0) {
				continue;
			}
			const key = m.keys[level];
			let b = this.buckets.get(key);
			if (!b) {
				b = { key, members: new Set(), batch: null, large: false, dirty: true };
				this.buckets.set(key, b);
			}
			b.members.add(m);
			b.dirty = true;
			m.bucket = b;
		}
	}

	onView() {
		this.lodDirty = true;
	}

	update(now) {
		this.changed = false;
		const chunks = this.view.chunks;
		if (chunks.version !== this.version) {
			this.version = chunks.version;
			const shown = (k) => {
				const e = chunks.chunks.get(k);
				return !!(e && e.obj && e.obj.visible);
			};
			for (const [key, list] of this.members) {
				const here = shown(key);
				for (const m of list) {
					// an overhang copy (a building of a neighbour chunk) only while that chunk is not shown
					const vis = here && !(m.p.over && shown(m.p.over));
					if (m.visible !== vis) {
						m.visible = vis;
						if (m.bucket) {
							m.bucket.dirty = true;
						}
					}
				}
			}
		}
		if (this.lodDirty && now - this.lodAt >= LOD_MS) {
			this.lodDirty = false;
			this.lodAt = now;
			for (const list of this.members.values()) {
				this.relevel(list);
			}
		}
		for (const [key, b] of this.buckets) {
			if (b.dirty) {
				this.rebuild(b);
				if (!b.members.size) {
					if (b.batch) {
						b.batch.dispose();
					}
					this.buckets.delete(key);
				}
			}
		}
		return this.changed;
	}

	rebuild(b) {
		b.dirty = false;
		this.changed = true;
		this.rebuilds++;
		const model = this.cache.ready(b.key);
		const vis = [...b.members].filter((m) => m.visible);
		let total = 0;
		for (const m of vis) {
			total += m.p.count;
		}
		if (!model) {
			if (b.batch) {
				b.batch.commit(0);
			}
			return;
		}
		b.large = b.large ? total > SHARED_MAX / 2 : total > SHARED_MAX;
		if (!b.large) {
			for (const m of b.members) {
				if (m.batch) {
					m.batch.dispose();
					m.batch = null;
				}
			}
			if (!b.batch) {
				b.batch = new ModelBatch(model, this.group, "pak:" + b.key.split("#")[0]);
			}
			const batch = b.batch;
			batch.reserve(Math.max(1, total));
			let off = 0;
			const sphere = new THREE.Sphere(), s = new THREE.Sphere();
			let first = true;
			for (const m of vis) {
				fill(batch, m.p, off);
				off += m.p.count;
				s.center.set(m.p.sphere[0], m.p.sphere[1], m.p.sphere[2]);
				s.radius = m.p.sphere[3];
				if (first) {
					sphere.copy(s);
					first = false;
				} else {
					sphere.union(s);
				}
			}
			batch.commit(total, total ? sphere : null);
			return;
		}
		if (b.batch) {
			b.batch.commit(0);
		}
		for (const m of b.members) {
			if (!m.visible) {
				if (m.batch) {
					m.batch.setVisible(false);
				}
				continue;
			}
			if (!m.batch || m.batch.model !== model) {
				if (m.batch) {
					m.batch.dispose();
				}
				m.batch = new ModelBatch(model, this.group, "pak:" + b.key.split("#")[0]);
				m.batch.reserve(m.p.count);
				fill(m.batch, m.p, 0);
				m.batch.commit(m.p.count, new THREE.Sphere(new THREE.Vector3(m.p.sphere[0], m.p.sphere[1], m.p.sphere[2]), m.p.sphere[3]));
			}
			m.batch.setVisible(true);
		}
	}

	/** Copies per model and LOD level drawn now, triangles, draw calls. */
	info() {
		const models = {};
		let instances = 0, triangles = 0, calls = 0, batches = 0;
		const add = (key, batch) => {
			if (!batch || !batch.n || !batch.meshes.length || !batch.meshes[0].visible) {
				return;
			}
			const path = key.split("#")[0];
			models[path] = (models[path] || 0) + batch.n;
			instances += batch.n;
			triangles += batch.triangles();
			calls += batch.meshes.length;
			batches++;
		};
		for (const b of this.buckets.values()) {
			add(b.key, b.batch);
			for (const m of b.members) {
				add(b.key, m.batch);
			}
		}
		let members = 0, overhang = 0;
		const levels = {};
		for (const list of this.members.values()) {
			for (const m of list) {
				members++;
				levels[m.level] = (levels[m.level] || 0) + 1;
				if (m.p.over && m.visible) {
					overhang += m.p.count;
				}
			}
		}
		return { instances, models, triangles, calls, batches, members, levels, rebuilds: this.rebuilds, overhang };
	}

	/** Instance matrices and colours of the drawn copies of a model path (tests): [{matrix: [16], color: [3] | null}]. */
	copies(path, limit = 64) {
		const out = [];
		const take = (batch) => {
			if (!batch || !batch.n || !batch.meshes[0].visible) {
				return;
			}
			for (let i = 0; i < batch.n && out.length < limit; i++) {
				const k = batch.colors.findIndex((c) => c);
				out.push({ matrix: Array.from(batch.matrix.array.subarray(i * 16, i * 16 + 16)),
					color: k >= 0 ? Array.from(batch.colors[k].subarray(i * 3, i * 3 + 3)) : null });
			}
		};
		for (const b of this.buckets.values()) {
			if (b.key.split("#")[0] === path) {
				take(b.batch);
				for (const m of b.members) {
					take(m.batch);
				}
			}
		}
		return out;
	}

	dispose() {
		this.clear();
		for (const b of this.buckets.values()) {
			if (b.batch) {
				b.batch.dispose();
			}
		}
		this.buckets.clear();
		this.group.removeFromParent();
	}
}

/** Writes the copies of model part p into batch at offset off. */
function fill(batch, p, off) {
	batch.matrix.array.set(p.matrix, off * 16);
	for (let i = 0; i < p.count; i++) {
		batch.setOwner(off + i, p.owner[i]);
	}
}
