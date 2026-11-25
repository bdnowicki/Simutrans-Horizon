// Simutrans-Horizon dashboard, 3D view: the pak 3D (glTF models of selected pak objects, tools/pak3d/README.md).
// No three.js: used by the worker (matching, model checks, placement) and the main thread (manifest, rules,
// authors page). The manifest (format 1) lists entries "kind:pattern" -> model file (+ LODs, variants) or a
// generator category; an exact name wins over patterns, otherwise the first entry in file order that matches.
// An entry with "at" (buildings) is bound to a place of one map instead: it draws its model once over the footprint
// whose north-west square that is, covering the buildings standing there that match it (placedRect, pakplace.js).
// tools/pak3d/pak3dlib.py implements the same rules for the checker and the coverage report.
// Artistic License, see LICENSE.txt.

export const FORMAT = 1;
export const PAK_ROOT = "/pak3d/";

// match kinds -> desc_list list
export const KIND_LIST = { building: "buildings", vehicle: "vehicles", citycar: "citycars", pedestrian: "pedestrians",
	tree: "trees", sign: "signs", way: "ways", bridge: "bridges", tunnel: "tunnels", wayobj: "wayobjs" };
// kinds this dashboard draws from models (ways, bridges, tunnels and overhead lines are accepted but stay generated)
export const DRAWN_KINDS = new Set(["building", "vehicle", "citycar", "pedestrian", "tree", "sign"]);
export const CLIMATES = ["water", "desert", "tropic", "mediterran", "temperate", "tundra", "rocky", "arctic"];
export const SEASONS = ["summer", "autumn", "winter", "spring"]; // scene3d `season` 0..3
// triangles per model file [normal, featured]; textures: largest side [normal, featured]
export const LIMITS = { building: [5000, 30000], vehicle: [3000, 6000], citycar: [3000, 6000], pedestrian: [1000, 2000],
	tree: [500, 2000], sign: [1000, 2000], way: [5000, 30000], bridge: [5000, 30000], tunnel: [5000, 30000],
	wayobj: [5000, 30000] };
export const TEXTURE_LIMIT = [1024, 2048];
// special material names: company colours and lights for the night (F7)
export const PLAYER1 = "player1", PLAYER2 = "player2", NIGHT = "night_emissive";
// glTF extensions that need decoders (wasm) this dashboard does not load
export const UNSUPPORTED_EXT = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"]);
export const DEFAULT_HEIGHT_STEP = 0.2041;

const TOP_KEYS = new Set(["format", "name", "version", "license", "author", "homepage", "description", "units", "entries",
	"generators", "rules"]);
const ENTRY_KEYS = new Set(["match", "model", "lod", "player_color", "scale_by_age", "variants", "featured", "generator",
	"type", "climate", "waytype", "size", "system", "freight", "footprint", "length", "at", "comment"]);
const FILTERS = ["type", "climate", "waytype", "system", "freight"];
const MODEL_EXT = /\.(glb|gltf)$/i;

/** Deep merge of rule objects (gen/rules.json): objects key by key, everything else (arrays, values) replaced. */
export function mergeRules(base, over) {
	if (!over || typeof over !== "object" || Array.isArray(over)) {
		return over === undefined ? base : over;
	}
	const out = Object.assign({}, base && typeof base === "object" && !Array.isArray(base) ? base : {});
	for (const [k, v] of Object.entries(over)) {
		out[k] = v && typeof v === "object" && !Array.isArray(v) ? mergeRules(out[k], v) : v;
	}
	return out;
}

/** A path inside the pak (no "..", hidden names, backslashes, drive letters or absolute paths), or an error text. */
function pathError(p, what, ext, templates) {
	if (typeof p !== "string" || !p) {
		return what + " must be a path string";
	}
	if (p.length > 300 || /[\\:\0]/.test(p) || p.startsWith("/")) {
		return what + " " + JSON.stringify(p) + " is not a relative path inside the pak";
	}
	const parts = p.split("/");
	if (parts.some((s) => !s || s === "." || s === ".." || s.startsWith("."))) {
		return what + " " + JSON.stringify(p) + " has an empty, hidden or parent directory part";
	}
	const rest = templates ? p.replace(/\{(season|climate)\}/g, "") : p;
	if (/[{}]/.test(rest)) {
		return what + " " + JSON.stringify(p) + ": only {season} and {climate} may be used as variants";
	}
	if (ext && !ext.test(p)) {
		return what + " " + JSON.stringify(p) + " has the wrong file type";
	}
	return null;
}

const strList = (v) => (typeof v === "string" ? [v] : Array.isArray(v) && v.every((s) => typeof s === "string") ? v : null);

/** Variants of one placeholder: array of available values (others use the first) or {game value: file value}. */
function normVariant(v, values, name, errors, where) {
	if (v === undefined) {
		return null;
	}
	const map = {};
	if (Array.isArray(v) && v.length && v.every((s) => typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s))) {
		for (const s of v) {
			if (!values.includes(s)) {
				errors.push(where + ": variants." + name + ": unknown value " + JSON.stringify(s) + " (one of " + values.join(", ") + ")");
				return null;
			}
		}
		for (const s of values) {
			map[s] = v.includes(s) ? s : v[0];
		}
		return map;
	}
	if (v && typeof v === "object" && !Array.isArray(v)) {
		for (const [k, s] of Object.entries(v)) {
			if (!values.includes(k) || typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) {
				errors.push(where + ": variants." + name + ": bad mapping " + JSON.stringify(k) + " -> " + JSON.stringify(s));
				return null;
			}
		}
		for (const s of values) {
			map[s] = v[s] ?? Object.values(v)[0] ?? s;
		}
		return map;
	}
	errors.push(where + ": variants." + name + " must be a list of values or an object");
	return null;
}

/**
 * Checks a parsed manifest.json. Returns {ok, errors: [text], warnings: [text], pak} with pak normalized:
 * {format, name, version, license, author, homepage, units: {tile, height_step}, entries: [...], generators: {name: path},
 * rules: object | path | null}. Unknown fields are warnings (ignored); everything else that is wrong is an error.
 */
export function validateManifest(j) {
	const errors = [], warnings = [];
	if (!j || typeof j !== "object" || Array.isArray(j)) {
		return { ok: false, errors: ["manifest.json must hold a JSON object"], warnings, pak: null };
	}
	if (j.format !== FORMAT) {
		errors.push("format must be " + FORMAT + " (found " + JSON.stringify(j.format) + ")");
	}
	for (const k of Object.keys(j)) {
		if (!TOP_KEYS.has(k)) {
			warnings.push("unknown field " + JSON.stringify(k) + " (ignored)");
		}
	}
	const meta = {};
	for (const k of ["name", "version", "license", "author", "homepage", "description"]) {
		if (j[k] !== undefined) {
			if (typeof j[k] !== "string" || j[k].length > 500) {
				errors.push(k + " must be a text of at most 500 characters");
			} else {
				meta[k] = j[k];
			}
		}
	}
	const units = { tile: 1, height_step: DEFAULT_HEIGHT_STEP };
	if (j.units !== undefined) {
		if (!j.units || typeof j.units !== "object" || Array.isArray(j.units)) {
			errors.push("units must be an object {tile, height_step}");
		} else {
			for (const k of Object.keys(j.units)) {
				if (k !== "tile" && k !== "height_step") {
					warnings.push("unknown field units." + k + " (ignored)");
				}
			}
			const t = j.units.tile ?? 1, hs = j.units.height_step ?? DEFAULT_HEIGHT_STEP;
			if (typeof t !== "number" || !(t >= 0.01 && t <= 100)) {
				errors.push("units.tile must be a number between 0.01 and 100 (model units per square)");
			} else {
				units.tile = t;
			}
			if (typeof hs !== "number" || !(hs >= 0.02 && hs <= 2)) {
				errors.push("units.height_step must be a number between 0.02 and 2 (squares per height level)");
			} else {
				units.height_step = hs;
				if (Math.abs(hs / t - DEFAULT_HEIGHT_STEP) > DEFAULT_HEIGHT_STEP * 0.05) {
					warnings.push("units.height_step " + hs + " differs from the 3D view's " + DEFAULT_HEIGHT_STEP
						+ " per square: models keep their proportions, so their heights in levels differ");
				}
			}
		}
	}
	const generators = {};
	if (j.generators !== undefined) {
		if (!j.generators || typeof j.generators !== "object" || Array.isArray(j.generators)) {
			errors.push("generators must be an object {category: \"generator/file.json\"}");
		} else {
			for (const [name, p] of Object.entries(j.generators)) {
				const e = /^[A-Za-z0-9_-]{1,64}$/.test(name) ? pathError(p, "generators." + name, /\.json$/i) : "bad generator name " + JSON.stringify(name);
				if (e) {
					errors.push(e);
				} else {
					generators[name] = p;
				}
			}
		}
	}
	let rules = null;
	if (j.rules !== undefined) {
		if (typeof j.rules === "string") {
			const e = pathError(j.rules, "rules", /\.json$/i);
			if (e) {
				errors.push(e);
			} else {
				rules = j.rules;
			}
		} else if (j.rules && typeof j.rules === "object" && !Array.isArray(j.rules)) {
			rules = j.rules;
		} else {
			errors.push("rules must be an object or the path of a .json file");
		}
	}
	const entries = [];
	if (!Array.isArray(j.entries)) {
		errors.push("entries must be a list");
	} else {
		j.entries.forEach((e, idx) => {
			const where = "entries[" + idx + "]";
			if (!e || typeof e !== "object" || Array.isArray(e)) {
				errors.push(where + " must be an object");
				return;
			}
			for (const k of Object.keys(e)) {
				if (!ENTRY_KEYS.has(k)) {
					warnings.push(where + ": unknown field " + JSON.stringify(k) + " (ignored)");
				}
			}
			const m = typeof e.match === "string" ? /^([a-z]+):(.+)$/.exec(e.match) : null;
			if (!m || !KIND_LIST[m[1]]) {
				errors.push(where + ": match must be \"<kind>:<name or pattern>\" with kind one of " + Object.keys(KIND_LIST).join(", "));
				return;
			}
			const out = { index: idx, kind: m[1], pattern: m[2], exact: !/[*?]/.test(m[2]), model: null, lod: [], player: [],
				scaleByAge: false, variants: { season: null, climate: null }, featured: false, generator: null, filters: {},
				footprint: null, length: null, at: null };
			if (e.model !== undefined && e.model !== null) {
				const pe = pathError(e.model, where + ": model", MODEL_EXT, true);
				if (pe) {
					errors.push(pe);
				} else {
					out.model = e.model;
				}
			}
			if (e.lod !== undefined) {
				if (!Array.isArray(e.lod) || e.lod.length > 4) {
					errors.push(where + ": lod must be a list of at most 4 model paths");
				} else {
					for (const p of e.lod) {
						const pe = pathError(p, where + ": lod", MODEL_EXT, true);
						if (pe) {
							errors.push(pe);
						} else {
							out.lod.push(p);
						}
					}
				}
			}
			if (e.player_color !== undefined) {
				const l = strList(e.player_color);
				if (!l) {
					errors.push(where + ": player_color must be a list of material names");
				} else {
					out.player = l;
				}
			}
			for (const k of ["scale_by_age", "featured"]) {
				if (e[k] !== undefined && typeof e[k] !== "boolean") {
					errors.push(where + ": " + k + " must be true or false");
				}
			}
			out.scaleByAge = e.scale_by_age === true;
			out.featured = e.featured === true;
			if (e.variants !== undefined) {
				if (!e.variants || typeof e.variants !== "object" || Array.isArray(e.variants)) {
					errors.push(where + ": variants must be an object {season, climate}");
				} else {
					for (const k of Object.keys(e.variants)) {
						if (k !== "season" && k !== "climate") {
							warnings.push(where + ": unknown field variants." + k + " (ignored)");
						}
					}
					out.variants.season = normVariant(e.variants.season, SEASONS, "season", errors, where);
					out.variants.climate = normVariant(e.variants.climate, CLIMATES, "climate", errors, where);
				}
			}
			if (e.generator !== undefined) {
				if (typeof e.generator !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.generator)) {
					errors.push(where + ": generator must be the name of a generator category");
				} else if (out.kind !== "building") {
					errors.push(where + ": generator is only for buildings");
				} else {
					out.generator = e.generator;
				}
			}
			if (out.model && out.generator) {
				errors.push(where + ": model and generator exclude each other");
			}
			for (const k of FILTERS) {
				if (e[k] !== undefined) {
					const l = strList(e[k]);
					if (!l || !l.length) {
						errors.push(where + ": " + k + " must be a text or a list of texts");
					} else if (k === "climate" && l.some((c) => !CLIMATES.includes(c))) {
						errors.push(where + ": climate must be one of " + CLIMATES.join(", "));
					} else {
						out.filters[k] = l;
					}
				}
			}
			for (const k of ["size", "footprint"]) {
				if (e[k] !== undefined) {
					const v = e[k];
					if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isInteger(n) && n >= 1 && n <= 64)) {
						errors.push(where + ": " + k + " must be [x, y] in squares");
					} else if (k === "size") {
						out.filters.size = v;
					} else {
						out.footprint = v;
					}
				}
			}
			if (e.length !== undefined) {
				if (typeof e.length !== "number" || !(e.length > 0 && e.length <= 16)) {
					errors.push(where + ": length must be the car length in squares (e.g. 0.5)");
				} else {
					out.length = e.length;
				}
			}
			if (e.at !== undefined) {
				const v = e.at;
				if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isInteger(n) && n >= 0 && n <= 32767)) {
					errors.push(where + ": at must be [x, y], the north-west square of the footprint on the map");
				} else if (out.kind !== "building") {
					errors.push(where + ": at is only for buildings");
				} else if (!out.model) {
					errors.push(where + ": at needs a model");
				} else {
					out.at = v;
					if (!out.footprint) {
						warnings.push(where + ": at without footprint: the model covers one square");
					}
				}
			}
			if (!DRAWN_KINDS.has(out.kind) && out.model) {
				warnings.push(where + ": " + out.kind + " models are not drawn by this dashboard yet (generated instead)");
			}
			if (!out.model && out.lod.length) {
				errors.push(where + ": lod without model");
			}
			entries.push(out);
		});
	}
	for (const e of entries) {
		if (e.generator && !generators[e.generator]) {
			warnings.push("entries[" + e.index + "]: generator " + JSON.stringify(e.generator) + " is not in generators (the rules' own category of that name is used, if any)");
		}
	}
	const ok = errors.length === 0;
	return { ok, errors, warnings, pak: ok ? Object.assign({ format: FORMAT, units, entries, generators, rules }, meta) : null };
}

const globCache = new Map();
/** Glob pattern (* any text, ? one character) -> RegExp, case-sensitive like pak names. */
export function globRe(p) {
	let r = globCache.get(p);
	if (!r) {
		r = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s");
		globCache.set(p, r);
	}
	return r;
}

/** Whether entry e matches desc d (name pattern and all filters). */
export function entryMatches(e, d) {
	const name = (d && d.name) || "";
	if (e.exact ? e.pattern !== name : !globRe(e.pattern).test(name)) {
		return false;
	}
	const f = e.filters;
	if (f.type && !f.type.includes(d.type)) return false;
	if (f.waytype && !f.waytype.includes(d.waytype)) return false;
	if (f.system && !f.system.includes(d.system)) return false;
	if (f.freight && !f.freight.includes(d.freight)) return false;
	if (f.size && !(d.size && d.size[0] === f.size[0] && d.size[1] === f.size[1])) return false;
	if (f.climate) {
		let mask = 0;
		for (const c of f.climate) {
			mask |= 1 << CLIMATES.indexOf(c);
		}
		if (d.climates === undefined || !(d.climates & mask)) return false;
	}
	return true;
}

/**
 * The entries of a pak for the descs of a catalogue (desc_list). of(kind, i) -> entry or null: exact names first (in
 * file order), then patterns in file order; an entry without model and generator stops the search (generated).
 * Entries bound to a place ("at") are not in it: they apply only there (placedRect).
 */
export function createMatcher(pak, cat) {
	const byKind = {};
	for (const e of (pak && pak.entries) || []) {
		if (!e.at) {
			(byKind[e.kind] = byKind[e.kind] || []).push(e);
		}
	}
	for (const k of Object.keys(byKind)) {
		byKind[k].sort((a, b) => (a.exact === b.exact ? a.index - b.index : a.exact ? -1 : 1));
	}
	const cache = {};
	return {
		of(kind, i) {
			const list = byKind[kind];
			if (!list) {
				return null;
			}
			const c = cache[kind] || (cache[kind] = new Map());
			if (c.has(i)) {
				return c.get(i);
			}
			const descs = (cat && cat[KIND_LIST[kind]]) || [];
			const d = descs[i] && descs[i].i === i ? descs[i] : descs.find((x) => x.i === i);
			const e = d ? list.find((x) => entryMatches(x, d)) || null : null;
			c.set(i, e);
			return e;
		},
		has: (kind) => !!byKind[kind],
	};
}

/**
 * The squares of an entry bound to a place ("at", given for the map as saved, rotation 0) in a world turned
 * `rotation` times (scene3d) of size {x, y} (now): {x, y, w, h, turn} with x, y the north-west square, w x h the
 * footprint and turn the quarter turns of the model (layout steps like the buildings: a turn of the map takes one
 * away, gebaeude_t::rotate90). Squares turn like koord::rotate90: (x, y) -> (size y - 1 - y, x). Null without a size
 * for a turned world.
 */
export function placedRect(e, rotation, size) {
	let [x, y] = e.at;
	let [w, h] = e.footprint || [1, 1];
	const r = rotation & 3;
	if (!r) {
		return { x, y, w, h, turn: 0 };
	}
	if (!size || !(size.x > 0) || !(size.y > 0)) {
		return null;
	}
	let sy = r & 1 ? size.x : size.y; // the size along y before each turn (at rotation 0 first)
	let sx = r & 1 ? size.y : size.x;
	for (let k = 0; k < r; k++) {
		const nx = sy - 1 - (y + h - 1);
		y = x;
		x = nx;
		[w, h] = [h, w];
		[sx, sy] = [sy, sx];
	}
	return { x, y, w, h, turn: (4 - r) & 3 };
}

/** A model path of an entry with its variants filled in (season 0..3, climate 0..7). */
export function expand(e, path, season, climate) {
	if (!path || path.indexOf("{") < 0) {
		return path;
	}
	const s = SEASONS[season & 3], c = CLIMATES[climate & 7];
	return path.replace(/\{season\}/g, e.variants.season ? e.variants.season[s] : s)
		.replace(/\{climate\}/g, e.variants.climate ? e.variants.climate[c] : c);
}

/** URL of a pak file. */
export function pakUrl(path) {
	return PAK_ROOT + path.split("/").map(encodeURIComponent).join("/");
}

/** Triangle limit of a model of an entry. */
export function triangleLimit(kind, featured) {
	return (LIMITS[kind] || LIMITS.building)[featured ? 1 : 0];
}

// --- glTF binary ------------------------------------------------------------------------------------------------

/** .glb -> {json, bin: Uint8Array | null}; throws with a readable message. A .gltf (JSON) gives bin null. */
export function parseGltf(buf) {
	const u8 = new Uint8Array(buf);
	if (u8.length >= 4 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) {
		const dv = new DataView(buf);
		if (u8.length < 20) {
			throw new Error("truncated .glb header");
		}
		if (dv.getUint32(4, true) !== 2) {
			throw new Error("glTF version " + dv.getUint32(4, true) + " (only 2 is supported)");
		}
		const total = dv.getUint32(8, true);
		if (total > u8.length) {
			throw new Error("truncated .glb (" + u8.length + " of " + total + " bytes)");
		}
		const len0 = dv.getUint32(12, true);
		if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + len0 > total) {
			throw new Error("the first .glb chunk is not JSON");
		}
		const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len0)));
		let bin = null;
		const o = 20 + len0;
		if (o + 8 <= total) {
			const len1 = dv.getUint32(o, true);
			if (dv.getUint32(o + 4, true) === 0x004e4942 && o + 8 + len1 <= total) {
				bin = u8.subarray(o + 8, o + 8 + len1);
			}
		}
		return { json, bin };
	}
	return { json: JSON.parse(new TextDecoder().decode(u8)), bin: null };
}

function mat4mul(a, b) {
	const o = new Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
		}
	}
	return o;
}

function nodeMatrix(n) {
	if (Array.isArray(n.matrix) && n.matrix.length === 16) {
		return n.matrix;
	}
	const [tx, ty, tz] = n.translation || [0, 0, 0];
	const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
	const [sx, sy, sz] = n.scale || [1, 1, 1];
	const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
	return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
		2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
		2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
}

/** min/max of a POSITION accessor (from the accessor, else read from the binary chunk). */
function accessorBounds(json, bin, ai) {
	const a = json.accessors && json.accessors[ai];
	if (!a) {
		return null;
	}
	if (Array.isArray(a.min) && Array.isArray(a.max) && a.min.length >= 3) {
		return [a.min, a.max];
	}
	const bv = json.bufferViews && json.bufferViews[a.bufferView];
	if (!bin || !bv || a.componentType !== 5126 || (bv.buffer | 0) !== 0) {
		return null;
	}
	const stride = bv.byteStride || 12, base = bin.byteOffset + (bv.byteOffset | 0) + (a.byteOffset | 0);
	const dv = new DataView(bin.buffer);
	const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < a.count; i++) {
		for (let k = 0; k < 3; k++) {
			const v = dv.getFloat32(base + i * stride + k * 4, true);
			mn[k] = Math.min(mn[k], v);
			mx[k] = Math.max(mx[k], v);
		}
	}
	return [mn, mx];
}

/** Width and height of a PNG, JPEG or WebP image from its header, or null. */
export function imageSize(b) {
	if (!b || b.length < 30) {
		return null;
	}
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		const be = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
		return { w: be(16), h: be(20), type: "png" };
	}
	if (b[0] === 0xff && b[1] === 0xd8) {
		let o = 2;
		while (o + 9 < b.length) {
			if (b[o] !== 0xff) {
				o++;
				continue;
			}
			const m = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
			if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
				return { w: (b[o + 7] << 8) | b[o + 8], h: (b[o + 5] << 8) | b[o + 6], type: "jpeg" };
			}
			o += 2 + len;
		}
		return null;
	}
	const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
	if (tag(0) === "RIFF" && tag(8) === "WEBP") {
		const c = tag(12);
		if (c === "VP8 ") {
			return { w: ((b[27] << 8) | b[26]) & 0x3fff, h: ((b[29] << 8) | b[28]) & 0x3fff, type: "webp" };
		}
		if (c === "VP8L") {
			const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
			return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1, type: "webp" };
		}
		if (c === "VP8X") {
			return { w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1, type: "webp" };
		}
	}
	return null;
}

/**
 * What a model holds: {triangles, bbox: [minx, miny, minz, maxx, maxy, maxz] (scene units, node transforms applied),
 * materials: [names], cameras, lights, images: [{w, h, type} | {uri}], unsupported: [extension names]}.
 */
export function gltfStats(json, bin) {
	const out = { triangles: 0, bbox: null, materials: (json.materials || []).map((m) => (m && m.name) || ""),
		cameras: (json.cameras || []).length, lights: 0, images: [], unsupported: [] };
	for (const x of json.extensionsRequired || []) {
		if (UNSUPPORTED_EXT.has(x)) {
			out.unsupported.push(x);
		}
	}
	const lightExt = json.extensions && json.extensions.KHR_lights_punctual;
	out.lights = (lightExt && Array.isArray(lightExt.lights) ? lightExt.lights.length : 0);
	const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	const nodes = json.nodes || [], meshes = json.meshes || [];
	const visit = (ni, parent, depth) => {
		const n = nodes[ni];
		if (!n || depth > 64) {
			return;
		}
		const m = mat4mul(parent, nodeMatrix(n));
		if (n.camera !== undefined) {
			out.cameras++;
		}
		if (n.extensions && n.extensions.KHR_lights_punctual) {
			out.lights++;
		}
		const mesh = n.mesh !== undefined ? meshes[n.mesh] : null;
		for (const p of (mesh && mesh.primitives) || []) {
			const pos = p.attributes && p.attributes.POSITION;
			const acc = json.accessors || [];
			const count = p.indices !== undefined ? (acc[p.indices] || {}).count | 0 : (acc[pos] || {}).count | 0;
			const mode = p.mode ?? 4;
			out.triangles += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
			const bb = pos !== undefined ? accessorBounds(json, bin, pos) : null;
			if (bb) {
				for (let k = 0; k < 8; k++) {
					const x = bb[k & 1][0], y = bb[(k >> 1) & 1][1], z = bb[(k >> 2) & 1][2];
					const v = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
					for (let c = 0; c < 3; c++) {
						mn[c] = Math.min(mn[c], v[c]);
						mx[c] = Math.max(mx[c], v[c]);
					}
				}
			}
		}
		for (const c of n.children || []) {
			visit(c, m, depth + 1);
		}
	};
	const scenes = json.scenes || [];
	const roots = scenes.length ? (scenes[json.scene | 0] || scenes[0]).nodes || [] : nodes.map((_, i) => i);
	const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	for (const r of roots) {
		visit(r, id, 0);
	}
	if (mn[0] <= mx[0]) {
		out.bbox = [mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]];
	}
	for (const im of json.images || []) {
		if (im.bufferView !== undefined && bin) {
			const bv = (json.bufferViews || [])[im.bufferView];
			const s = bv ? imageSize(bin.subarray(bv.byteOffset | 0, (bv.byteOffset | 0) + bv.byteLength)) : null;
			out.images.push(s || { w: 0, h: 0, type: "unknown" });
		} else if (typeof im.uri === "string" && im.uri.startsWith("data:")) {
			const i = im.uri.indexOf(",");
			let s = null;
			try {
				const bin2 = atob(im.uri.slice(i + 1, i + 1 + 400));
				s = imageSize(Uint8Array.from(bin2, (ch) => ch.charCodeAt(0)));
			} catch (e) { /* not base64 */ }
			out.images.push(s || { w: 0, h: 0, type: "unknown" });
		} else {
			out.images.push({ uri: im.uri || "" });
		}
	}
	return out;
}

/** Problems of a model against the limits of its use (kind, featured): [] when fine. */
export function modelProblems(stats, kind, featured) {
	const out = [];
	const tl = triangleLimit(kind, featured), xl = TEXTURE_LIMIT[featured ? 1 : 0];
	if (stats.triangles > tl) {
		out.push(stats.triangles + " triangles (limit " + tl + " for " + (featured ? "featured " : "") + kind + " models)");
	}
	if (!stats.triangles) {
		out.push("no triangles");
	}
	for (const im of stats.images) {
		if (im.w > xl || im.h > xl) {
			out.push("texture " + im.w + "x" + im.h + " (limit " + xl + ")");
		}
	}
	if (stats.cameras) {
		out.push("cameras in the file");
	}
	if (stats.lights) {
		out.push("lights in the file");
	}
	if (stats.unsupported.length) {
		out.push("needs " + stats.unsupported.join(", ") + " (not supported)");
	}
	return out;
}

// --- LICENSES.md ----------------------------------------------------------------------------------------------------

/**
 * Rows of the tables of a LICENSES.md: [{file, author, license, source, notes}] (cells as plain text; the header
 * row names the columns, "File" and "Author" are needed).
 */
export function parseLicenses(text) {
	const rows = [];
	let cols = null;
	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line.startsWith("|")) {
			cols = null;
			continue;
		}
		const cells = line.replace(/^\||\|$/g, "").split("|").map((s) => s.trim().replace(/`/g, ""));
		if (cells.every((s) => /^:?-{2,}:?$/.test(s))) {
			continue;
		}
		if (!cols) {
			const names = cells.map((s) => s.toLowerCase());
			if (names.includes("file") && names.includes("author")) {
				cols = names;
			}
			continue;
		}
		const at = (k) => {
			const i = cols.findIndex((c) => c === k || c === k + "s");
			return i >= 0 ? cells[i] || "" : "";
		};
		rows.push({ file: at("file"), author: at("author"), license: at("license") || "CC BY 4.0", source: at("source"), notes: at("note") });
	}
	return rows;
}
