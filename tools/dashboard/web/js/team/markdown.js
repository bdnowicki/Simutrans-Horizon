// Simutrans-Horizon dashboard: a small, safe markdown renderer for the texts of the AI agents. It builds Preact nodes
// (h()) with the text as text nodes, never an HTML string: paragraphs, line breaks, **bold**, *italic*, ~~struck~~,
// `code`, fenced code blocks, headings, bullet and numbered lists (nested by indentation), quotes, rules and simple
// tables. Links are shown as plain text (their address in brackets), images as their description. Artistic License,
// see LICENSE.txt.
import { h } from "/vendor/htm/standalone.module.js";

const MAX_CHARS = 40000; // longer texts are cut (the model's answers are far shorter)
const MAX_DEPTH = 6;
// characters one line may scan in search of closing marks (emphasis, links): text like "*a *a *a ..." would make
// every opening mark scan to the end of the line (quadratic: seconds for 40000 characters, and a streamed answer is
// parsed again with every piece); past the budget the rest of the line is plain text
const SCAN_BUDGET = 60000;

const FENCE = /^ {0,3}(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^( {0,12})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,12})(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function isBlank(line) {
	return !line.trim();
}

function indentOf(line) {
	const m = /^ */.exec(line.replace(/\t/g, "    "));
	return m[0].length;
}

function startsBlock(line) {
	return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || BULLET.test(line)
		|| ORDERED.test(line);
}

function splitRow(line) {
	let s = line.trim();
	if (s.startsWith("|")) {
		s = s.slice(1);
	}
	if (s.endsWith("|") && !s.endsWith("\\|")) {
		s = s.slice(0, -1);
	}
	return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

// --- inline -----------------------------------------------------------------------------------------------------

/** Inline markdown of one text (no line breaks) as an array of strings and nodes. budget: the scan budget shared by
 * the nested calls of one line. */
export function inline(text, depth = 0, budget = { left: SCAN_BUDGET }) {
	const out = [];
	let buf = "";
	let i = 0;
	const flush = () => {
		if (buf) {
			out.push(buf);
			buf = "";
		}
	};
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "\\" && i + 1 < n && /[\\`*_~[\]()#+\-.!|>]/.test(text[i + 1])) {
			buf += text[i + 1];
			i += 2;
			continue;
		}
		if (c === "`") {
			let ticks = 1;
			while (text[i + ticks] === "`") {
				ticks++;
			}
			const fence = "`".repeat(ticks);
			const end = text.indexOf(fence, i + ticks);
			if (end > i) {
				flush();
				out.push(h("code", { class: "md-code" }, text.slice(i + ticks, end).replace(/^ (.*) $/, "$1")));
				i = end + ticks;
				continue;
			}
			buf += fence;
			i += ticks;
			continue;
		}
		if (depth < MAX_DEPTH && (c === "*" || c === "_")) {
			const strong = text[i + 1] === c;
			const mark = strong ? c + c : c;
			const prev = i > 0 ? text[i - 1] : " ";
			const next = text[i + mark.length];
			// "_" only at word boundaries (snake_case stays as it is); an opening mark is followed by a non-space
			const opens = next !== undefined && !/\s/.test(next) && (c === "*" || !/[\p{L}\p{N}]/u.test(prev));
			if (opens) {
				let end = -1;
				for (let j = i + mark.length + 1; j < n; j++) {
					if (--budget.left < 0) {
						break; // out of budget: no emphasis any more on this line
					}
					if (text[j] === "`") {
						const e = text.indexOf("`", j + 1);
						budget.left -= (e > j ? e : n) - j; // the search counts too
						if (e > j) {
							j = e;
						}
						continue;
					}
					if (text[j] !== c) {
						continue;
					}
					let run = 1;
					while (text[j + run] === c) {
						run++;
					}
					const ok = !/\s/.test(text[j - 1])
						&& (c === "*" || j + run >= n || !/[\p{L}\p{N}]/u.test(text[j + run]));
					if (strong ? run >= 2 && ok : run === 1 && ok) {
						end = strong ? j + run - 2 : j; // "***" closing bold and italic: the last two close the bold
						break;
					}
					j += run - 1; // a "**" inside italic belongs to a nested bold
				}
				if (end > 0) {
					flush();
					const inner = inline(text.slice(i + mark.length, end), depth + 1, budget);
					out.push(h(strong ? "strong" : "em", null, ...inner));
					i = end + mark.length;
					continue;
				}
			}
			buf += mark;
			i += mark.length;
			continue;
		}
		if (depth < MAX_DEPTH && c === "~" && text[i + 1] === "~") {
			const end = text.indexOf("~~", i + 2);
			if (end > i + 2) {
				flush();
				out.push(h("del", null, ...inline(text.slice(i + 2, end), depth + 1, budget)));
				i = end + 2;
				continue;
			}
		}
		if (c === "[" || (c === "!" && text[i + 1] === "[")) {
			// [text](address) and ![description](address): only the text, the address as plain text
			const img = c === "!";
			const open = img ? i + 1 : i;
			const close = text.indexOf("]", open + 1);
			if (close > open && text[close + 1] === "(") {
				let end = -1;
				for (let j = close + 2, depth = 0; j < n; j++) { // the closing bracket of the address (nested ones balanced)
					if (--budget.left < 0) {
						break; // out of budget: the rest is plain text
					}
					if (text[j] === "(") {
						depth++;
					} else if (text[j] === ")" && depth-- === 0) {
						end = j;
						break;
					}
				}
				if (end > close) {
					flush();
					const label = text.slice(open + 1, close);
					const href = text.slice(close + 2, end).trim();
					if (img) {
						out.push(label || href);
					} else {
						out.push(h("span", { class: "md-link" }, ...inline(label, depth + 1, budget)));
						if (href && href !== label) {
							out.push(h("span", { class: "md-href" }, " (" + href + ")"));
						}
					}
					i = end + 1;
					continue;
				}
			}
		}
		buf += c;
		i++;
	}
	flush();
	return out;
}

/** Lines of a paragraph: inline markdown with line breaks between them. */
function lines(ls) {
	const out = [];
	ls.forEach((l, k) => {
		if (k) {
			out.push(h("br", null));
		}
		out.push(...inline(l.trim()));
	});
	return out;
}

// --- blocks -----------------------------------------------------------------------------------------------------

function parseList(ls, i, depth) {
	const first = BULLET.exec(ls[i]) || ORDERED.exec(ls[i]);
	const ordered = !BULLET.test(ls[i]);
	const base = first[1].length;
	const items = [];
	let start = ordered ? Number(first[2]) : 1;
	while (i < ls.length) {
		const m = (ordered ? ORDERED : BULLET).exec(ls[i]);
		if (!m || m[1].length !== base) {
			break;
		}
		const body = [m[3]];
		const cont = base + 2;
		i++;
		while (i < ls.length) {
			const l = ls[i];
			if (isBlank(l)) {
				// a blank line ends the list unless the next line still belongs to the item (indented)
				if (i + 1 < ls.length && !isBlank(ls[i + 1]) && indentOf(ls[i + 1]) >= cont) {
					body.push("");
					i++;
					continue;
				}
				break;
			}
			const ind = indentOf(l);
			if (ind < cont && (BULLET.test(l) || ORDERED.test(l))) {
				break; // the next item of this list (or of an outer one)
			}
			if (ind < cont && startsBlock(l)) {
				break;
			}
			body.push(ind >= cont ? l.replace(/\t/g, "    ").slice(Math.min(ind, cont)) : l.trim());
			i++;
		}
		items.push(body);
	}
	const lis = items.map((body) => {
		const simple = body.length && !body.some((l) => startsBlock(l) || isBlank(l));
		return h("li", null, ...(simple ? lines(body) : blocks(body, depth + 1)));
	});
	const node = ordered ? h("ol", start !== 1 ? { start } : null, ...lis) : h("ul", null, ...lis);
	return [node, i];
}

function parseTable(ls, i) {
	const head = splitRow(ls[i]);
	const aligns = splitRow(ls[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : null));
	i += 2;
	const rows = [];
	while (i < ls.length && !isBlank(ls[i]) && ls[i].includes("|")) {
		rows.push(splitRow(ls[i]));
		i++;
	}
	const cell = (tag, text, k) => h(tag, aligns[k] ? { style: { textAlign: aligns[k] } } : null, ...inline(text));
	const node = h("div", { class: "md-table-wrap" }, h("table", { class: "md-table" },
		h("thead", null, h("tr", null, ...head.map((c, k) => cell("th", c, k)))),
		h("tbody", null, ...rows.map((r) => h("tr", null, ...head.map((_, k) => cell("td", r[k] || "", k)))))));
	return [node, i];
}

function blocks(ls, depth = 0) {
	const out = [];
	let i = 0;
	let para = [];
	const endPara = () => {
		if (para.length) {
			out.push(h("p", null, ...lines(para)));
			para = [];
		}
	};
	while (i < ls.length) {
		const l = ls[i];
		if (isBlank(l)) {
			endPara();
			i++;
			continue;
		}
		const fence = FENCE.exec(l);
		if (fence) {
			endPara();
			const code = [];
			i++;
			while (i < ls.length && !(ls[i].trim().startsWith(fence[1]) && FENCE.test(ls[i]))) {
				code.push(ls[i]);
				i++;
			}
			i++;
			out.push(h("pre", { class: "md-pre" }, h("code", null, code.join("\n"))));
			continue;
		}
		if (RULE.test(l)) {
			endPara();
			out.push(h("hr", null));
			i++;
			continue;
		}
		if (depth < MAX_DEPTH && (BULLET.test(l) || ORDERED.test(l))) {
			endPara();
			const [node, j] = parseList(ls, i, depth);
			out.push(node);
			i = j;
			continue;
		}
		const hd = HEADING.exec(l);
		if (hd) {
			endPara();
			out.push(h("p", { class: "md-h md-h" + Math.min(3, hd[1].length) }, ...inline(hd[2])));
			i++;
			continue;
		}
		if (depth < MAX_DEPTH && QUOTE.test(l)) {
			endPara();
			const q = [];
			while (i < ls.length && QUOTE.test(ls[i])) {
				q.push(QUOTE.exec(ls[i])[1]);
				i++;
			}
			out.push(h("blockquote", null, ...blocks(q, depth + 1)));
			continue;
		}
		if (l.includes("|") && i + 1 < ls.length && TABLE_SEP.test(ls[i + 1]) && !para.length) {
			const [node, j] = parseTable(ls, i);
			out.push(node);
			i = j;
			continue;
		}
		para.push(l);
		i++;
	}
	endPara();
	return out;
}

/** The markdown text as an array of Preact nodes (block level). */
export function markdown(text) {
	let s = text === null || text === undefined ? "" : String(text);
	if (s.length > MAX_CHARS) {
		s = s.slice(0, MAX_CHARS) + " …";
	}
	return blocks(s.replace(/\r\n?/g, "\n").split("\n"));
}
