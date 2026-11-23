// Simutrans-Horizon dashboard: shared Preact hooks. Artistic License, see LICENSE.txt.
import { useState, useEffect, useRef } from "/vendor/htm/standalone.module.js";
import { subscribe } from "/js/store.js";

const EMPTY = { key: null, data: null, error: null, at: 0 };

/**
 * Load data for `key` (null: nothing) and keep it fresh: again every `every` ms while the page is
 * visible, and whenever one of `topics` fires (default: a new game month). Old data stay shown while a
 * reload runs or fails. Returns {data, error (ApiError), at (ms of the last answer)}.
 */
export function useRemote(key, load, { every = 0, topics = ["month"] } = {}) {
	const [state, setState] = useState(EMPTY);
	const loadRef = useRef(load);
	loadRef.current = load;
	useEffect(() => {
		if (key === null || key === undefined) {
			setState(EMPTY);
			return undefined;
		}
		let alive = true, timer = null, busy = false, again = false;
		const run = async () => {
			clearTimeout(timer);
			if (busy) {
				again = true;
				return;
			}
			busy = true;
			try {
				const data = await loadRef.current();
				if (alive) {
					setState({ key, data, error: null, at: Date.now() });
				}
			} catch (e) {
				if (alive) {
					setState((s) => ({ key, data: s.key === key ? s.data : null, error: e, at: Date.now() }));
				}
			}
			busy = false;
			if (!alive) {
				return;
			}
			if (again) {
				again = false;
				run();
			} else if (every) {
				timer = setTimeout(tick, every);
			}
		};
		const tick = () => {
			if (document.hidden) {
				timer = setTimeout(tick, every);
			} else {
				run();
			}
		};
		setState((s) => (s.key === key ? s : Object.assign({}, EMPTY, { key })));
		run();
		const off = topics && topics.length ? subscribe(topics, () => run()) : null;
		return () => {
			alive = false;
			clearTimeout(timer);
			if (off) {
				off();
			}
		};
	}, [key]);
	return state.key === key ? state : Object.assign({}, EMPTY, { key });
}
