// Simutrans-Horizon dashboard: virtual-scrolled, sortable table (only the visible rows are in the DOM).
// Artistic License, see LICENSE.txt.
import { html, useState, useRef, useEffect, useLayoutEffect } from "/vendor/htm/standalone.module.js";
import { Icon } from "/js/icons.js";
import { collator } from "/js/format.js";

/** True while the viewport is narrow (phone). */
export function useNarrow(query = "(max-width: 720px)") {
	const mq = window.matchMedia(query);
	const [narrow, setNarrow] = useState(mq.matches);
	useEffect(() => {
		const fn = () => setNarrow(mq.matches);
		mq.addEventListener("change", fn);
		return () => mq.removeEventListener("change", fn);
	}, [query]);
	return narrow;
}

/** Sort rows by a column (value(row) gives numbers or strings; null/undefined last). */
export function sortRows(rows, column, dir) {
	if (!column) {
		return rows;
	}
	const val = column.value || ((r) => r[column.key]);
	const coll = collator();
	const keyed = rows.map((r) => [val(r), r]);
	keyed.sort((a, b) => {
		const x = a[0], y = b[0];
		const xn = x === null || x === undefined || Number.isNaN(x), yn = y === null || y === undefined || Number.isNaN(y);
		if (xn || yn) {
			return xn === yn ? 0 : xn ? 1 : -1;
		}
		if (typeof x === "number" && typeof y === "number") {
			return (x - y) * dir;
		}
		return coll.compare(String(x), String(y)) * dir;
	});
	return keyed.map((k) => k[1]);
}

/**
 * columns: [{key, label, title, width, align, render(row), value(row), minor}] — minor columns are hidden on phones,
 * title is the tooltip of the header.
 * sort: {key, dir}; onSort(key); onRow(row); rowKey(row); activeKey: key of a row to mark.
 */
export function VTable({ rows, columns, sort, onSort, onRow, rowKey, rowHeight = 36, activeKey, empty, label }) {
	const narrow = useNarrow();
	const cols = narrow ? columns.filter((c) => !c.minor) : columns;
	const ref = useRef(null);
	const raf = useRef(0);
	const [scroll, setScroll] = useState(0);
	const [height, setHeight] = useState(600);
	const rh = narrow ? rowHeight + 6 : rowHeight;

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) {
			return undefined;
		}
		const ro = new ResizeObserver(() => setHeight(el.clientHeight || 600));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	useEffect(() => () => cancelAnimationFrame(raf.current), []);

	const onScroll = () => {
		if (!raf.current) {
			raf.current = requestAnimationFrame(() => {
				raf.current = 0;
				if (ref.current) {
					setScroll(ref.current.scrollTop);
				}
			});
		}
	};

	const template = cols.map((c) => c.width || "1fr").join(" ");
	const headH = 34;
	const first = Math.max(0, Math.floor((scroll - headH) / rh) - 8);
	const last = Math.min(rows.length, Math.ceil((scroll + height) / rh) + 8);
	const visible = rows.slice(first, last);

	const keyDown = (e, r) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onRow && onRow(r);
		}
	};

	return html`<div class="vt" ref=${ref} onScroll=${onScroll} role="table" aria-label=${label} aria-rowcount=${rows.length}>
		<div class="vt-head" role="row" style=${{ gridTemplateColumns: template }}>
			${cols.map((c) => {
				const active = sort && sort.key === c.key;
				return html`<div role="columnheader" class=${"vt-th" + (c.align === "right" ? " right" : "")}
					aria-sort=${active ? (sort.dir > 0 ? "ascending" : "descending") : "none"}>
					${c.sortable === false ? html`<span title=${c.title}>${c.label}</span>` : html`<button type="button" class="vt-sort" title=${c.title}
						onClick=${() => onSort && onSort(c.key)}>
						<span>${c.label}</span>${active ? html`<${Icon} name=${sort.dir > 0 ? "sort_up" : "sort_down"} size=${14} />` : null}
					</button>`}
				</div>`;
			})}
		</div>
		<div class="vt-space" style=${{ height: rows.length * rh + "px" }}>
			${visible.map((r, k) => {
				const key = rowKey(r);
				return html`<div key=${key} role="row" tabindex="0"
					class=${"vt-row" + ((first + k) % 2 ? " odd" : "") + (activeKey !== undefined && activeKey === key ? " active" : "")}
					style=${{ transform: `translateY(${(first + k) * rh}px)`, height: rh + "px", gridTemplateColumns: template }}
					onClick=${() => onRow && onRow(r)} onKeyDown=${(e) => keyDown(e, r)}>
					${cols.map((c) => html`<div role="cell" class=${"vt-td" + (c.align === "right" ? " right" : "")}>${c.render ? c.render(r) : r[c.key]}</div>`)}
				</div>`;
			})}
		</div>
		${rows.length === 0 ? html`<p class="vt-empty">${empty}</p>` : null}
	</div>`;
}
