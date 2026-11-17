/**
 * Tab navigation that skips collapsed groups (requirements 5.1 "折叠": the commands "go to the
 * next / previous tab, skipping collapsed groups"). Pure: the caller activates the returned tab.
 */
import type { GroupState, Snapshot } from './types';
import { Work } from './work';

export type Direction = 1 | -1;

/**
 * The next visible tab after (`direction` 1) or before (-1) `fromLeafId` in its strip, wrapping
 * around like Obsidian's own next / previous tab commands. Tabs hidden in a collapsed group are
 * skipped; pinned and ungrouped tabs count like any other. Null when the tab is unknown or no
 * other tab of the strip is visible.
 */
export function stepVisible(state: GroupState, snapshot: Snapshot, fromLeafId: string, direction: Direction): string | null {
	const w = new Work(snapshot, state);
	const paneId = w.paneOf.get(fromLeafId);
	if (paneId === undefined) return null;
	const order = w.order(paneId);
	const from = order.indexOf(fromLeafId);
	const n = order.length;
	for (let k = 1; k < n; k++) {
		const id = order[(((from + direction * k) % n) + n) % n];
		if (id !== undefined && !w.hidden(id)) return id;
	}
	return null;
}

/** True when this tab is a member of a collapsed group in a strip that hides tabs (not stacked). */
export function isHidden(state: GroupState, snapshot: Snapshot, leafId: string): boolean {
	const w = new Work(snapshot, state);
	return w.leaves.has(leafId) && w.hidden(leafId);
}
