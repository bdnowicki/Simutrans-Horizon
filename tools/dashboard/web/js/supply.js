// Simutrans-Horizon dashboard: goods colours and the supply links between factories (from the `goods` and
// `supply_chain` feeds of the bridge), prepared once per feed for the map overlay and the factory panel.
// Artistic License, see LICENSE.txt.
import { S, goodsIndex } from "/js/store.js";

const hueCache = new Map();

/** CSS colour of a goods type (by its translated name) as the game shows it; a stable hue without one. */
export function goodsColor(name) {
	const g = goodsIndex().map.get(name);
	if (g && Array.isArray(g.color) && g.color.length === 3) {
		return `rgb(${g.color[0] & 255}, ${g.color[1] & 255}, ${g.color[2] & 255})`;
	}
	let c = hueCache.get(name);
	if (!c) {
		let h = 0;
		for (const ch of String(name)) {
			h = (h * 31 + ch.codePointAt(0)) >>> 0;
		}
		c = `hsl(${h % 360} 55% 45%)`;
		hueCache.set(name, c);
	}
	return c;
}

let src = null, srcGoods = null;
let links = [];
let byFactory = new Map();

function build() {
	const sc = S.supply_chain;
	if (sc === src && S.goods === srcGoods) {
		return;
	}
	src = sc;
	srcGoods = S.goods;
	links = [];
	byFactory = new Map();
	if (!sc || !Array.isArray(sc.nodes) || !Array.isArray(sc.edges)) {
		return;
	}
	const pairs = new Map(); // unordered pair of factories -> its links (drawn side by side)
	for (const e of sc.edges) {
		if (!Array.isArray(e) || e.length < 4) {
			continue;
		}
		const a = sc.nodes[e[0]], b = sc.nodes[e[1]];
		if (!a || !b || !a.pos || !b.pos) {
			continue;
		}
		const from = a.pos.x + "," + a.pos.y, to = b.pos.x + "," + b.pos.y;
		const goods = String(e[2]);
		const l = { ax: a.pos.x, ay: a.pos.y, bx: b.pos.x, by: b.pos.y, from, to, goods, active: !!e[3],
			color: goodsColor(goods), fromName: a.name, toName: b.name, k: 0, n: 1 };
		links.push(l);
		const key = from < to ? from + "|" + to : to + "|" + from;
		let p = pairs.get(key);
		if (!p) {
			p = [];
			pairs.set(key, p);
		}
		p.push(l);
		for (const id of [from, to]) {
			let list = byFactory.get(id);
			if (!list) {
				list = [];
				byFactory.set(id, list);
			}
			list.push(l);
		}
	}
	for (const p of pairs.values()) {
		p.forEach((l, k) => {
			l.k = k;
			l.n = p.length;
		});
	}
}

/** All supply links: [{ax, ay, bx, by, from: "x,y", to: "x,y", goods, active, color, k, n}] (k of n links between the same pair). */
export function supplyLinks() {
	build();
	return links;
}

/** Links of one factory ("x,y"). */
export function factoryLinks(id) {
	build();
	return byFactory.get(id) || [];
}

/** Goods names that travel on the links, sorted by name. */
export function supplyGoods(collator) {
	build();
	const set = new Set(links.map((l) => l.goods));
	return Array.from(set).sort((a, b) => collator.compare(a, b));
}

/** Whether the game gives supply links (null: not known yet). */
export function hasSupplyChain() {
	return S.supply_chain ? true : S.session && S.poll ? false : null;
}
