// Simutrans-Horizon dashboard: a canvas overlay for Leaflet that redraws itself with a callback
// (convoys, stations, labels). Built on L.Renderer for the pan/zoom handling. Artistic License, see LICENSE.txt.

/**
 * createOverlay(draw, {pane}) -> layer with redraw(); draw(ctx, view) gets a view with
 * s (pixels per map tile), toPx(x, y) -> [px, py] of the tile centre in canvas coordinates,
 * and the visible tile range x0, y0, x1, y1.
 */
export function createOverlay(draw, options = {}) {
	const Overlay = L.Renderer.extend({
		options: { padding: 0.1 },

		_initContainer() {
			const c = document.createElement("canvas");
			c.className = "map-overlay";
			this._container = c;
			this._ctx = c.getContext("2d");
		},

		_destroyContainer() {
			L.Util.cancelAnimFrame(this._req);
			this._req = null;
			L.DomUtil.remove(this._container);
			delete this._ctx;
			delete this._container;
		},

		_update() {
			if (this._map._animatingZoom && this._bounds) {
				return;
			}
			L.Renderer.prototype._update.call(this);
			const b = this._bounds, size = b.getSize(), c = this._container;
			const m = Math.min(2, window.devicePixelRatio || 1);
			L.DomUtil.setPosition(c, b.min);
			c.width = Math.round(m * size.x);
			c.height = Math.round(m * size.y);
			c.style.width = size.x + "px";
			c.style.height = size.y + "px";
			this._m = m;
			this._paint();
		},

		redraw() {
			if (!this._map || this._req) {
				return;
			}
			this._req = L.Util.requestAnimFrame(() => {
				this._req = null;
				if (this._map && !this._map._animatingZoom) {
					this._paint();
				}
			});
		},

		view() {
			const map = this._map, b = this._bounds;
			const zoom = map.getZoom();
			const s = map.getZoomScale(zoom, 0);
			const o = map.getPixelOrigin();
			return {
				s, zoom,
				toPx: (x, y) => [(x + 0.5) * s - o.x, (y + 0.5) * s - o.y],
				x0: (b.min.x + o.x) / s - 1, y0: (b.min.y + o.y) / s - 1,
				x1: (b.max.x + o.x) / s + 1, y1: (b.max.y + o.y) / s + 1,
				minX: b.min.x, minY: b.min.y, maxX: b.max.x, maxY: b.max.y,
			};
		},

		_paint() {
			const ctx = this._ctx, c = this._container, m = this._m, b = this._bounds;
			if (!ctx || !b) {
				return;
			}
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, c.width, c.height);
			ctx.setTransform(m, 0, 0, m, -b.min.x * m, -b.min.y * m);
			draw(ctx, this.view());
		},
	});
	return new Overlay(options);
}
