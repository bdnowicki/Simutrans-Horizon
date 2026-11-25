// Simutrans-Horizon dashboard, 3D view: decodes the blocks of `scene3d` replies (tools/mcp/README.md, "3D export":
// base64 zlib streams; objects as little endian columns). No three.js. Artistic License, see LICENSE.txt.

export const OBJS_LAYOUT = "x:u8,y:u8,z:i8,kind:u8,desc:i16,a:u16,b:u16,owner:i8";

// object kinds of scene3d
export const K = { WAY: 0, BUILDING: 1, TREE: 2, BRIDGE: 3, TUNNEL: 4, SIGN: 5, WAYOBJ: 6, PILLAR: 7, POWERLINE: 8,
	FIELD: 9, GROUNDOBJ: 10, OTHER: 11 };

// corner order of the `corners` block
export const SW = 0, SE = 1, NE = 2, NW = 3;

// low nibble of `ground`
export const G = { LAND: 0, WATER: 1, FOUNDATION: 2, PORTAL: 3, BRIDGEHEAD: 4, OTHER: 5 };

export function b64ToBytes(s) {
	if (typeof Uint8Array.fromBase64 === "function") {
		return Uint8Array.fromBase64(s);
	}
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

/** zlib (RFC 1950) stream -> bytes. */
export async function inflate(bytes) {
	const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}

async function block(s) {
	return inflate(b64ToBytes(s));
}

function columns(buf, n) {
	// 16-bit columns start at even offsets (4n, 6n, 8n), so typed array views are aligned
	const ab = buf.buffer, o = buf.byteOffset;
	return {
		n,
		x: new Uint8Array(ab, o, n),
		y: new Uint8Array(ab, o + n, n),
		z: new Int8Array(ab, o + 2 * n, n),
		kind: new Uint8Array(ab, o + 3 * n, n),
		desc: new Int16Array(ab, o + 4 * n, n),
		a: new Uint16Array(ab, o + 6 * n, n),
		b: new Uint16Array(ab, o + 8 * n, n),
		owner: new Int8Array(ab, o + 10 * n, n),
	};
}

function columnsOfRows(rows) {
	const n = rows.length;
	const c = { n, x: new Uint8Array(n), y: new Uint8Array(n), z: new Int8Array(n), kind: new Uint8Array(n),
		desc: new Int16Array(n), a: new Uint16Array(n), b: new Uint16Array(n), owner: new Int8Array(n) };
	rows.forEach((r, i) => {
		c.x[i] = r[0]; c.y[i] = r[1]; c.z[i] = r[2]; c.kind[i] = r[3];
		c.desc[i] = r[4]; c.a[i] = r[5]; c.b[i] = r[6]; c.owner[i] = r[7];
	});
	return c;
}

/** A scene3d reply -> {cx, cy, x0, y0, w, h, water, ..., corners: Int8Array(w*h*4), ground: Uint8Array(w*h), objs}. */
export async function decodeChunk(j) {
	const w = j.w ?? j.size, h = j.h ?? j.size;
	if (j.encoding && j.encoding !== "zlib+base64") {
		throw new Error("unknown encoding " + j.encoding);
	}
	const cb = await block(j.corners);
	const ground = await block(j.ground);
	if (cb.length !== w * h * 4 || ground.length !== w * h) {
		throw new Error(`chunk ${j.cx},${j.cy}: bad block sizes`);
	}
	const corners = new Int8Array(cb.buffer, cb.byteOffset, cb.length);
	let objs;
	if (Array.isArray(j.objs)) {
		objs = columnsOfRows(j.objs);
	} else {
		if (j.objs_layout !== OBJS_LAYOUT) {
			throw new Error("unknown objs_layout " + j.objs_layout);
		}
		const n = j.count | 0;
		const ob = n ? await block(j.objs) : new Uint8Array(0);
		if (ob.length !== 11 * n) {
			throw new Error(`chunk ${j.cx},${j.cy}: bad objs size`);
		}
		objs = columns(ob, n);
	}
	return {
		cx: j.cx, cy: j.cy, size: j.size, x0: j.x0 ?? j.cx * j.size, y0: j.y0 ?? j.cy * j.size, w, h,
		rev: j.rev, descGen: j.desc_gen, water: j.water | 0, season: j.season, snowline: j.snowline, rotation: j.rotation,
		corners, ground, objs,
	};
}
