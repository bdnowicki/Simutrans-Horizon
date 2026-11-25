// Simutrans-Horizon dashboard, 3D view: turns the geometry parts made by the worker into three.js objects.
// A part is {type: "mesh", layer, material, position, color?, index, sphere} or {type: "instances", layer, shape,
// material, matrix, color, count, sphere}; `material` is a key of the material registry below, `shape` a key of the
// shapes the worker sent at init (objects.js SHAPES). Later phases register more materials (registerMaterial) and
// shapes (e.g. glTF models by name). The materials read the shared uniforms of sky.js (snow above the snowline, the
// colours of the season on trees, lit windows at night). Artistic License, see LICENSE.txt.
import * as THREE from "/vendor/three/three.module.js";
import { envMaterial, patchEnv, treeMaterial } from "./sky.js";
import { HEIGHT_STEP } from "./config.js";

const MATERIALS = {
	terrain: () => envMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide,
		roughness: 0.95, metalness: 0 }), { ground: "frag", k: 1 }),
	water: () => new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.35, metalness: 0.05 }),
	// ways lie on the ground: pulled towards the camera in the depth buffer; a thinner layer of snow
	way: () => envMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0,
		polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), { ground: "frag", k: 0.55 }),
	// rivers and canals: way strips with the shine of the water
	waterway: () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.35, metalness: 0.05,
		polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
	solid: () => envMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 }),
		{ ground: "frag", k: 0.9, up: [0.6, 0.85] }),
	building: buildingMaterial,
	tree: () => treeMaterial(-1),
	tree0: () => treeMaterial(0),
	tree1: () => treeMaterial(1),
	tree2: () => treeMaterial(2),
};

// layers whose objects cast shadows (the rest only receive them)
const CASTERS = new Set(["buildings", "network", "nature", "pakmodels", "overhang"]);

// Windows of generated buildings, drawn in the fragment shader from the int16 attribute `win` (u along the facade in
// window columns, v in storeys, both * 256; z = style (gen/tbuf.js WIN) + 8 * (ground level + 128) + 2048 * seed of
// the copy, meshbuf.js StampBuf): no textures, sharp at any zoom, fading to the average when a window gets smaller than
// about two pixels. Style 6 (curtain wall) tints the glass with the facade colour and shows the vertex colour only as
// mullions. At night a share of the windows is lit (per window from its cell, facade and copy: the same windows every
// night, more of them as the night falls); roofs get snow when the ground of the building is above the snowline.
const WINDOW_VERT = `
attribute vec3 win;
varying vec3 vWin;
varying float vGroundY;
varying float vBSeed;`;
const WINDOW_VERT_MAIN = `#include <begin_vertex>
	{
		float wz = win.z;
		float wlv = mod(floor(wz / 8.0), 256.0);
		vWin = vec3(win.xy, mod(wz, 8.0));
#ifdef USE_INSTANCING
		vGroundY = instanceMatrix[3].y;
		vBSeed = floor(fract(instanceMatrix[3].x * 0.137 + instanceMatrix[3].z * 0.291) * 16.0);
#else
		vGroundY = wlv > 0.5 ? (wlv - 128.0) * ${HEIGHT_STEP.toFixed(5)} : 1e5;
		vBSeed = floor(wz / 2048.0);
#endif
	}`;
const WINDOW_FRAG = `
varying vec3 vWin;
varying float vGroundY;
varying float vBSeed;
float winMask = 0.0;
vec3 envGlow = vec3(0.0);
vec4 winRect(float s) {
	if (s < 1.5) return vec4(0.24, 0.76, 0.26, 0.78);
	if (s < 2.5) return vec4(0.03, 0.97, 0.2, 0.84);
	if (s < 3.5) return vec4(0.08, 0.92, 0.5, 0.86);
	if (s < 4.5) return vec4(0.06, 0.94, 0.06, 0.82);
	if (s < 5.5) return vec4(0.3, 0.7, 0.18, 0.86);
	if (s < 6.5) return vec4(0.05, 0.95, 0.04, 0.96);
	return vec4(0.12, 0.88, 0.0, 0.9);
}
vec3 winGlass(float s, vec3 facade) {
	if (s < 1.5) return vec3(0.075, 0.09, 0.115);
	if (s < 2.5) return vec3(0.13, 0.19, 0.24);
	if (s < 3.5) return vec3(0.22, 0.26, 0.28);
	if (s < 4.5) return vec3(0.12, 0.15, 0.17);
	if (s < 5.5) return vec3(0.07, 0.085, 0.11);
	if (s < 6.5) return facade * 0.55 + vec3(0.015, 0.02, 0.03);
	return vec3(0.05, 0.045, 0.04);
}`;
const WINDOW_COLOR = `
	if (vWin.z > 0.5) {
		vec2 cell = vWin.xy / 256.0;
		vec2 f = fract(cell);
		vec2 fw = max(fwidth(cell), vec2(1e-4));
		vec4 r = winRect(vWin.z);
		float mx = clamp((f.x - r.x) / fw.x + 0.5, 0.0, 1.0) - clamp((f.x - r.y) / fw.x + 0.5, 0.0, 1.0);
		float my = clamp((f.y - r.z) / fw.y + 0.5, 0.0, 1.0) - clamp((f.y - r.w) / fw.y + 0.5, 0.0, 1.0);
		float m = clamp(mx, 0.0, 1.0) * clamp(my, 0.0, 1.0);
		float cover = (r.y - r.x) * (r.w - r.z);
		m = mix(m, cover, smoothstep(0.3, 0.65, max(fw.x, fw.y)));
		vec3 glass = winGlass(vWin.z, diffuseColor.rgb);
		if (vWin.z > 5.5 && vWin.z < 6.5) {
			diffuseColor.rgb = mix(vec3(0.62, 0.64, 0.66), glass, m);
		} else {
			diffuseColor.rgb = mix(diffuseColor.rgb, glass, m);
		}
		winMask = m;
		if (uNight > 0.01) {
			vec3 fn = envNormal();
			float plane = floor(dot(fn, vEnvW) * 4.0 + 0.5);
			// curtain walls (offices) light up in runs of six bays per storey, softer and cooler, over a faint glow
			bool curtain = vWin.z > 5.5 && vWin.z < 6.5;
			vec2 wc = curtain ? vec2(floor(cell.x / 6.0), floor(cell.y)) : floor(cell);
			float h = envHash(vec3(wc + vec2(plane * 0.37, vBSeed * 5.3), plane + vBSeed * 17.0 + fn.x * 3.0 + fn.z * 7.0));
			float on = smoothstep(0.05, 0.4, uNight);
			float share = (curtain ? 0.45 : 0.62) * smoothstep(0.12, 0.85, uNight);
			// windows smaller than about two pixels: the average of lit and dark (no flicker of single windows)
			float far = smoothstep(0.3, 0.65, max(fw.x, fw.y));
			float lit = mix(step(h, share), share, far) * (vWin.z > 6.5 ? 0.6 : 1.0);
			float k = mix(curtain ? 0.3 + 0.15 * fract(h * 31.0) : 1.1 + 0.6 * fract(h * 31.0), curtain ? 0.37 : 1.4, far);
			vec3 warm = curtain ? vec3(0.95, 0.9, 0.78) : mix(mix(vec3(1.0, 0.72, 0.38), vec3(0.85, 0.9, 1.0), step(0.82, fract(h * 13.7))),
				vec3(0.98, 0.76, 0.45), far);
			envGlow = (warm * k * lit + (curtain ? vec3(0.03, 0.035, 0.045) : vec3(0.0))) * m * on;
			diffuseColor.rgb *= 1.0 - (curtain ? 0.4 : 0.7) * lit * m * on;
		}
	}`;

function buildingMaterial() {
	const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
	m.onBeforeCompile = (sh) => {
		// colour step: the windows, then the snow of patchEnv (roofs only)
		patchEnv(sh, { ground: "vGroundY", k: 0.95, up: [0.75, 0.9] });
		sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>" + WINDOW_VERT)
			.replace("#include <begin_vertex>", WINDOW_VERT_MAIN);
		sh.fragmentShader = sh.fragmentShader.replace("varying vec3 vEnvW;", "varying vec3 vEnvW;" + WINDOW_FRAG)
			.replace("#include <color_fragment>", "#include <color_fragment>" + WINDOW_COLOR)
			.replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, 0.32, winMask);")
			.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += envGlow;");
	};
	m.customProgramCacheKey = () => "building-windows-2";
	return m;
}

/** Adds a material key (a factory called once per view). */
export function registerMaterial(key, factory) {
	MATERIALS[key] = factory;
}

export class PartFactory {
	constructor() {
		this.materials = new Map();
		this.shapes = new Map();
	}

	material(key) {
		let m = this.materials.get(key);
		if (!m) {
			m = (MATERIALS[key] || MATERIALS.solid)();
			this.materials.set(key, m);
		}
		return m;
	}

	/** Shapes of instanced parts: {key: {position, color, index}} (replaces shapes of the same key). */
	setShapes(shapes) {
		for (const [key, s] of Object.entries(shapes || {})) {
			const g = new THREE.BufferGeometry();
			g.setAttribute("position", new THREE.BufferAttribute(s.position, 3));
			if (s.color) {
				g.setAttribute("color", new THREE.BufferAttribute(s.color, 3, true));
			}
			if (s.win) {
				g.setAttribute("win", new THREE.BufferAttribute(s.win, 3));
			}
			g.setIndex(new THREE.BufferAttribute(s.index, 1));
			g.computeBoundingSphere();
			const old = this.shapes.get(key);
			if (old) {
				old.dispose();
			}
			this.shapes.set(key, g);
		}
	}

	/** A three.js object for the part, or null (unknown shape). */
	build(p) {
		const sphere = p.sphere ? new THREE.Sphere(new THREE.Vector3(p.sphere[0], p.sphere[1], p.sphere[2]), p.sphere[3]) : null;
		let obj;
		if (p.type === "instances") {
			const shape = this.shapes.get(p.shape);
			if (!shape) {
				return null;
			}
			obj = new THREE.InstancedMesh(shape, this.material(p.material), p.count);
			obj.instanceMatrix = new THREE.InstancedBufferAttribute(p.matrix, 16);
			obj.instanceColor = new THREE.InstancedBufferAttribute(p.color, 3);
			if (sphere) {
				obj.boundingSphere = sphere;
			} else {
				obj.computeBoundingSphere();
			}
		} else {
			const g = new THREE.BufferGeometry();
			g.setAttribute("position", new THREE.BufferAttribute(p.position, 3));
			if (p.color) {
				g.setAttribute("color", new THREE.BufferAttribute(p.color, 3, true));
			}
			if (p.win) {
				g.setAttribute("win", new THREE.BufferAttribute(p.win, 3));
			}
			if (p.tree) {
				g.setAttribute("tree", new THREE.BufferAttribute(p.tree, 4));
			}
			g.setIndex(new THREE.BufferAttribute(p.index, 1));
			if (sphere) {
				g.boundingSphere = sphere;
			} else {
				g.computeBoundingSphere();
			}
			obj = new THREE.Mesh(g, this.material(p.material));
		}
		obj.name = p.layer || "";
		obj.userData.layer = p.layer;
		obj.castShadow = CASTERS.has(p.layer);
		obj.receiveShadow = true;
		if (p.over) {
			obj.userData.over = p.over; // a building of the chunk p.over reaching into this one (chunks.js)
		}
		if (p.shape) {
			obj.userData.shape = p.shape;
		}
		obj.matrixAutoUpdate = false;
		return obj;
	}

	/** Frees what build() made for one object (shapes and materials are shared and stay). */
	static release(obj) {
		if (obj.isInstancedMesh) {
			obj.dispose();
		} else if (obj.geometry) {
			obj.geometry.dispose();
		}
	}

	dispose() {
		for (const m of this.materials.values()) {
			m.dispose();
		}
		for (const g of this.shapes.values()) {
			g.dispose();
		}
		this.materials.clear();
		this.shapes.clear();
	}
}
