// Simutrans-Horizon dashboard: base map from palette PNG tiles of the bridge
// (GET /tiles/<mode>/<step>/<cx>/<cy>.png: one 256 x 256 sample chunk of the game's minimap per Leaflet tile).
// Leaflet zoom z <= 0 maps to step 2^-z; above zoom 0 the step 1 tiles are scaled up (pixelated).
// Artistic License, see LICENSE.txt.

export const CHUNK = 256;
export const MODES = ["terrain", "owner", "traffic", "freight", "passengers", "mail", "tracks", "speed", "power",
	"forest", "level", "climates"];
// modes the game's change tracking does not cover: they follow the monthly statistics
export const STATS_MODES = new Set(MODES.filter((m) => m !== "terrain" && m !== "owner"));
const MIN_NATIVE = -4; // step 16
const EMPTY = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Versions of the map chunks (CHUNK x CHUNK map tiles at step 1) for the tile URLs (?v=): a changed chunk
 * gets a new URL for every tile that covers it; reset() renews all, newMonth() those of the statistics modes.
 */
export class TileVersions {
	constructor() {
		this.epoch = 0;
		this.stats = 0;
		this.chunks = new Map();
	}

	reset() {
		this.epoch++;
		this.chunks.clear();
	}

	newMonth() {
		this.stats++;
	}

	bump(chunks) {
		for (const c of chunks) {
			const k = c[0] + "," + c[1];
			this.chunks.set(k, (this.chunks.get(k) || 0) + 1);
		}
	}

	version(mode, step, cx, cy) {
		let sum = 0;
		if (this.chunks.size) {
			for (let y = cy * step; y < (cy + 1) * step; y++) {
				for (let x = cx * step; x < (cx + 1) * step; x++) {
					sum += this.chunks.get(x + "," + y) || 0;
				}
			}
		}
		return `${this.epoch}.${STATS_MODES.has(mode) ? this.stats : 0}.${sum}`;
	}
}

function stepOf(z) {
	return Math.pow(2, -Math.min(0, Math.max(MIN_NATIVE, z)));
}

/** Whether the Leaflet tile at coords shows one of the chunks [[cx, cy], ...] (step 1 units). */
function covers(coords, chunks) {
	const step = stepOf(coords.z);
	const x0 = coords.x * step, y0 = coords.y * step;
	return chunks.some((c) => c[0] >= x0 && c[0] < x0 + step && c[1] >= y0 && c[1] < y0 + step);
}

/** getMode() -> current mode; versions: a TileVersions. */
export function createMinimapLayer(versions, getMode) {
	const Layer = L.TileLayer.extend({
		getTileUrl(coords) {
			if (coords.x < 0 || coords.y < 0 || coords.z > 0 || coords.z < MIN_NATIVE) {
				return EMPTY;
			}
			const step = stepOf(coords.z), mode = getMode();
			return `/tiles/${mode}/${step}/${coords.x}/${coords.y}.png?v=${versions.version(mode, step, coords.x, coords.y)}`;
		},

		/**
		 * Load the tiles again that show one of the chunks (all tiles without chunks). The new picture is
		 * loaded off-screen first and then swapped in (from the document's image list, without a request),
		 * so the old one stays until then and Leaflet's fade-in does not start again.
		 */
		refreshTiles(chunks) {
			for (const key in this._tiles) {
				const t = this._tiles[key];
				if (chunks && !covers(t.coords, chunks)) {
					continue;
				}
				const url = new URL(this.getTileUrl(t.coords), location.href).href;
				if (t.el.src === url || t.el._want === url) {
					continue;
				}
				const el = t.el;
				if (!t.loaded) {
					el.src = url; // still loading: Leaflet handles the load of the new picture as the first one
					continue;
				}
				el._want = url;
				this._preload(el, t.coords, url, 0);
			}
		},

		_preload(el, coords, url, attempt) {
			const pre = new Image(), src = attempt ? url + "&r=" + attempt : url;
			pre.onload = () => {
				if (el._want === url) {
					el._want = null;
					el._swap = true;
					el.src = src;
				}
			};
			pre.onerror = () => {
				if (el._want !== url) {
					return;
				}
				this.fire("tileerror", { tile: el, coords, error: new Error("tile refresh failed") });
				if (attempt < 3 && el.isConnected) {
					setTimeout(() => {
						if (el._want === url) {
							this._preload(el, coords, url, attempt + 1);
						}
					}, 1500 * (attempt + 1));
				} else {
					el._want = null;
				}
			};
			pre.src = src;
		},

		createTile(coords, done) {
			const tile = L.TileLayer.prototype.createTile.call(this, coords, done);
			tile._coords = coords;
			return tile;
		},

		_tileOnError(done, tile, e) {
			// e.g. 503 while the bridge reconnects or 429: try a few times more (Leaflet does not)
			const n = tile._retries || 0;
			if (n < 3 && tile._coords) {
				tile._retries = n + 1;
				setTimeout(() => {
					const url = this.getTileUrl(tile._coords);
					if (tile.isConnected && url.startsWith("/tiles/")) {
						tile.src = url + "&r=" + (n + 1);
					}
				}, 1500 * (n + 1));
			}
			L.TileLayer.prototype._tileOnError.call(this, done, tile, e);
		},

		_tileOnLoad(done, tile) {
			tile._retries = 0;
			if (tile._swap) {
				tile._swap = false; // a refreshed picture: the tile was shown already
				this.fire("tileload", { tile, coords: null });
				return;
			}
			L.TileLayer.prototype._tileOnLoad.call(this, done, tile);
		},
	});
	return new Layer("", {
		tileSize: CHUNK, minNativeZoom: MIN_NATIVE, maxNativeZoom: 0, minZoom: -8, maxZoom: 8, keepBuffer: 2,
		updateWhenZooming: false, className: "minimap-tiles", zIndex: 1,
	});
}
