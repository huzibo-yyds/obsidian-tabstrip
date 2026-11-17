/**
 * Reconcile: bring the group state in line with a layout change.
 *
 * Obsidian owns which tabs exist and their order. When the layout changes, reconcile
 * compares the previous and the next snapshot and decides group membership for the
 * tabs that were opened, closed, moved, pinned or restored. It prefers changing
 * membership over moving tabs; it only moves tabs to keep pinned tabs first, to push
 * a tab out of a collapsed group, and to put an undo-closed member back in its slot.
 *
 * The result always satisfies `invariants`, and a valid (snapshot, state) pair is a
 * fixed point: reconciling again after applying the returned ops yields no ops and
 * the same state.
 */
import { canHide, indexLeaves, nearestVisible, pinnedPrefixLength, pushTombstones, type LeafPlace } from './model';
import { planReorder, stableSubsequence } from './sequence';
import type {
	DropIntent,
	GroupState,
	ModelEvent,
	ReconcileContext,
	ReconcileResult,
	Snapshot,
	Tombstone,
} from './types';
import { at, get } from './util';
import { Work } from './work';

export function reconcile(
	prev: Snapshot,
	next: Snapshot,
	state: GroupState,
	ctx: ReconcileContext = {},
): ReconcileResult {
	const w = new Work(next, state);
	const before = indexLeaves(prev);
	const prevPanes = new Set(prev.panes.map((p) => p.id));
	const intent = ctx.txnId === undefined ? ctx.dropIntent : undefined;
	const events: ModelEvent[] = [];

	recordClosedMembers(w, before);
	forgetClosedStrips(w, prevPanes);
	dropPinnedMembers(w, events);
	keepGroupsInOnePane(w, before);
	for (const paneId of w.orders.keys()) keepPinnedFirst(w, paneId);
	restoreFromTombstones(w, before);
	placeAfterCollapsedChip(w, intent);
	for (const paneId of w.orders.keys()) settlePane(w, paneId, before, intent);
	revealShownTabs(w, prev);
	return { state: w.finish(), ops: w.ops, events };
}

/**
 * Members that are gone: tombstone them (with group name and color) and drop them.
 * Tabs closed in one change count as closed left to right, so each tombstone's slot
 * counts only tabs that were still open when it closed. Native undo-close restores
 * the last closed tab first, which then puts every tab back where it was.
 */
function recordClosedMembers(w: Work, before: ReadonlyMap<string, LeafPlace>): void {
	const closed = [...w.memberOf.keys()].filter((id) => !w.leaves.has(id));
	if (closed.length === 0) return;
	const batch: Tombstone[] = [];
	for (const [leafId, place] of before) {
		const groupId = w.memberOf.get(leafId);
		if (groupId === undefined || w.leaves.has(leafId)) continue;
		const group = get(w.groups, groupId);
		const open = place.pane.leaves.slice(0, place.index).filter((l) => w.leaves.has(l.id));
		const right = place.pane.leaves.slice(place.index + 1).find((l) => w.leaves.has(l.id));
		batch.push({
			leafId,
			groupId,
			groupName: group.name,
			groupColor: group.color,
			paneId: place.pane.id,
			paneIndex: open.length,
			indexInGroup: open.filter((l) => w.memberOf.get(l.id) === groupId).length,
			fingerprint: place.leaf.fingerprint,
			left: open.length > 0 ? at(open, open.length - 1).id : null,
			right: right?.id ?? null,
		});
	}
	for (const id of closed) w.memberOf.delete(id);
	w.tombstones = pushTombstones(w.tombstones, batch.reverse());
}

/**
 * A strip that closes takes its slots with it. Tombstones of a strip that is gone now,
 * or whose id only now appears (Obsidian gives the split it makes on undo-close the old
 * strip id), lose their strip for good (`paneId` becomes null). Those tabs come back
 * ungrouped, also when a later undo-close finds a strip with the old id already there.
 */
function forgetClosedStrips(w: Work, prevPanes: ReadonlySet<string>): void {
	const gone = (t: Tombstone): boolean => t.paneId !== null && !(prevPanes.has(t.paneId) && w.orders.has(t.paneId));
	if (!w.tombstones.some(gone)) return;
	w.tombstones = w.tombstones.map((t) => (gone(t) ? { ...t, paneId: null } : t));
}

/** Pinned tabs are never members. Pinning a member takes it out of its group. */
function dropPinnedMembers(w: Work, events: ModelEvent[]): void {
	for (const [leafId, groupId] of [...w.memberOf]) {
		if (!w.pinned(leafId)) continue;
		w.memberOf.delete(leafId);
		events.push({ kind: 'pinned-out', leafId, groupId, groupName: get(w.groups, groupId).name });
	}
}

/**
 * A group lives in one strip. Its home is where most members that did not change
 * strip are; members elsewhere leave. If every member changed strip, the group
 * follows only when it had two or more members and they all landed in one strip.
 */
function keepGroupsInOnePane(w: Work, before: ReadonlyMap<string, LeafPlace>): void {
	const byGroup = new Map<string, string[]>();
	for (const [leafId, groupId] of w.memberOf) {
		const list = byGroup.get(groupId) ?? [];
		list.push(leafId);
		byGroup.set(groupId, list);
	}
	const paneOrder = [...w.orders.keys()];
	for (const ids of byGroup.values()) {
		const stayed = ids.filter((id) => {
			const place = before.get(id);
			return place === undefined || place.pane.id === w.paneOf.get(id);
		});
		let home: string | null;
		if (stayed.length > 0) {
			home = majorityPane(stayed, w, paneOrder);
		} else {
			const panes = new Set(ids.map((id) => get(w.paneOf, id)));
			home = panes.size === 1 && ids.length >= 2 ? majorityPane(ids, w, paneOrder) : null;
		}
		for (const id of ids) {
			if (w.paneOf.get(id) !== home) w.memberOf.delete(id);
		}
	}
}

function majorityPane(ids: readonly string[], w: Work, paneOrder: readonly string[]): string {
	const count = new Map<string, number>();
	for (const id of ids) {
		const pane = get(w.paneOf, id);
		count.set(pane, (count.get(pane) ?? 0) + 1);
	}
	let best = '';
	let bestCount = 0;
	for (const pane of paneOrder) {
		const c = count.get(pane) ?? 0;
		if (c > bestCount) {
			best = pane;
			bestCount = c;
		}
	}
	return best;
}

/** Pinned tabs form a prefix (stable partition: newly pinned go last, unpinned go just after). */
function keepPinnedFirst(w: Work, paneId: string): void {
	const order = w.order(paneId);
	const pinned = order.filter((id) => w.pinned(id));
	if (pinned.every((id, i) => order[i] === id)) return;
	const target = [...pinned, ...order.filter((id) => !w.pinned(id))];
	w.reorder(paneId, target, planReorder);
}

/**
 * Tabs that come back with a tombstoned id (native undo-close keeps the leaf id).
 * The newest tombstone of each id is consumed, also for ids that never left.
 */
function restoreFromTombstones(w: Work, before: ReadonlyMap<string, LeafPlace>): void {
	if (w.tombstones.length === 0) return;
	const newest = new Map<string, Tombstone>();
	for (const t of w.tombstones) {
		if (w.leaves.has(t.leafId) && !newest.has(t.leafId)) newest.set(t.leafId, t);
	}
	if (newest.size === 0) return;
	w.tombstones = w.tombstones.filter((t) => !newest.has(t.leafId));
	const back = [...w.leaves.keys()].filter((id) => newest.has(id) && !before.has(id));
	for (const leafId of back) restoreOne(w, get(newest, leafId));
}

function restoreOne(w: Work, t: Tombstone): void {
	const leafId = t.leafId;
	const paneId = get(w.paneOf, leafId);
	// Pinned, back in another strip, or its strip has closed (paneId null): stays ungrouped where it is.
	if (w.pinned(leafId) || paneId !== t.paneId) return;

	const order = w.order(paneId);
	const without = order.filter((id) => id !== leafId);
	const group = w.groups.get(t.groupId);
	const span = w.run(t.groupId);
	if (group !== undefined && span !== null) {
		if (span.paneId !== paneId) return;
		// Back into its slot among the members that are still there.
		const k = Math.min(t.indexInGroup, span.ids.length);
		const index =
			k < span.ids.length
				? without.indexOf(at(span.ids, k))
				: without.indexOf(at(span.ids, span.ids.length - 1)) + 1;
		w.move(leafId, index);
		w.memberOf.set(leafId, t.groupId);
		return;
	}

	// The group was deleted when it became empty: rebuild it from the tombstone.
	w.setGroup(group ?? { id: t.groupId, name: t.groupName, color: t.groupColor, collapsed: false });
	const pinnedCount = pinnedPrefixLength(without, (id) => w.pinned(id));
	const free = (i: number): boolean => {
		if (i < pinnedCount || i > without.length) return false;
		if (i === 0 || i === without.length) return true;
		const left = w.memberOf.get(at(without, i - 1));
		return left === undefined || left !== w.memberOf.get(at(without, i));
	};
	const wanted = Math.min(Math.max(t.paneIndex, pinnedCount), without.length);
	const current = order.indexOf(leafId);
	const index = free(wanted) ? wanted : free(current) ? current : without.length;
	w.move(leafId, index);
	w.memberOf.set(leafId, t.groupId);
}

/**
 * A drop on a collapsed group's chip (step L7, rule 4): the dropped tab goes to just after the
 * group, where the native drop line showed it (the group's hidden tabs sit right after the chip).
 * It stays out of the group; the group stays collapsed.
 */
function placeAfterCollapsedChip(w: Work, intent?: DropIntent): void {
	const groupId = intent?.afterGroupId;
	if (intent === undefined || groupId === undefined) return;
	const leafId = intent.leafId;
	const paneId = w.paneOf.get(leafId);
	const group = w.groups.get(groupId);
	if (paneId === undefined || group === undefined || !group.collapsed || !canHide(get(w.panes, paneId))) return;
	if (w.pinned(leafId) || w.memberOf.get(leafId) === groupId) return;
	const without = w.order(paneId).filter((id) => id !== leafId);
	let last = -1;
	without.forEach((id, i) => {
		if (w.memberOf.get(id) === groupId) last = i;
	});
	// The group is in another strip: nothing to do here.
	if (last < 0) return;
	w.move(leafId, last + 1);
}

/**
 * A drop never joins a collapsed group in a strip that hides tabs (step L7, rule 4). A member of
 * that group keeps its own group as its intent.
 */
function joinableIntent(w: Work, paneId: string, intent?: DropIntent): DropIntent | undefined {
	const target = intent?.joinGroupId;
	if (intent === undefined || target === null || target === undefined || w.memberOf.get(intent.leafId) === target) return intent;
	const group = w.groups.get(target);
	return group?.collapsed === true && canHide(get(w.panes, paneId)) ? { ...intent, joinGroupId: null } : intent;
}

/**
 * Decides membership of the tabs in one strip that moved, arrived or are new.
 *
 * Tabs that kept their relative order ("anchors", a longest increasing subsequence
 * weighted toward members) keep their membership. The others sit in gaps between
 * anchors and are decided per gap:
 * - gap strictly inside a group: they join it; inside a collapsed group, tabs that do
 *   not belong to it are first moved to just after the group;
 * - gap at group boundaries: the dropped tab follows the drop intent; other tabs keep
 *   their group only if they still touch it; nobody joins without an intent;
 * - a group with no anchor in the strip (moved as a whole) keeps its largest run.
 */
function settlePane(w: Work, paneId: string, before: ReadonlyMap<string, LeafPlace>, dropIntent?: DropIntent): void {
	const intent = joinableIntent(w, paneId, dropIntent);
	const order = w.order(paneId);
	const pinnedCount = pinnedPrefixLength(order, (id) => w.pinned(id));
	if (pinnedCount === order.length) return;

	const anchors = findAnchors(w, paneId, order.slice(pinnedCount), before, intent);
	trimAnchorRuns(w, order.slice(pinnedCount), anchors);
	pushOutOfCollapsed(w, paneId, pinnedCount, anchors);

	const tabs = w.order(paneId).slice(pinnedCount);
	const anchoredGroups = new Set<string>();
	for (const id of anchors) {
		const g = w.memberOf.get(id);
		if (g !== undefined) anchoredGroups.add(g);
	}
	const decided = new Map<string, string | null>();
	const floating = new Map<string, string>();
	let i = 0;
	let leftGroup: string | undefined;
	while (i < tabs.length) {
		const id = at(tabs, i);
		if (anchors.has(id)) {
			leftGroup = w.memberOf.get(id);
			i++;
			continue;
		}
		let j = i;
		while (j < tabs.length && !anchors.has(at(tabs, j))) j++;
		const rightGroup = j < tabs.length ? w.memberOf.get(at(tabs, j)) : undefined;
		settleGap(w, tabs.slice(i, j), leftGroup, rightGroup, intent, anchoredGroups, decided, floating);
		i = j;
	}
	keepLargestFloatingRuns(tabs, floating, decided);
	for (const [id, groupId] of decided) {
		if (groupId === null) w.memberOf.delete(id);
		else w.memberOf.set(id, groupId);
	}
}

/** Tabs that stayed in this strip and kept their relative order. */
function findAnchors(
	w: Work,
	paneId: string,
	tabs: readonly string[],
	before: ReadonlyMap<string, LeafPlace>,
	intent?: DropIntent,
): Set<string> {
	const candidates: string[] = [];
	const keys: number[] = [];
	let keySpace = 0;
	for (const id of tabs) {
		const place = before.get(id);
		if (place === undefined || place.pane.id !== paneId || id === intent?.leafId) continue;
		candidates.push(id);
		keys.push(place.index);
		keySpace = Math.max(keySpace, place.index + 1);
	}
	const keep = stableSubsequence(keys, (j) => (w.memberOf.has(at(candidates, j)) ? 1 : 0), keySpace);
	return new Set(candidates.filter((_, j) => at(keep, j)));
}

/** Safety net: anchors of one group must be one run among the anchors; keep the largest. */
function trimAnchorRuns(w: Work, tabs: readonly string[], anchors: ReadonlySet<string>): void {
	const runs = new Map<string, string[][]>();
	let last: string | undefined;
	for (const id of tabs) {
		if (!anchors.has(id)) continue;
		const g = w.memberOf.get(id);
		if (g !== undefined) addToRun(runs, g, id, g !== last);
		last = g;
	}
	for (const list of runs.values()) {
		if (list.length < 2) continue;
		const keep = largest(list);
		for (const run of list) if (run !== keep) for (const id of run) w.memberOf.delete(id);
	}
}

/** Appends `id` to the last run of group `g`, or to a new run. */
function addToRun(runs: Map<string, string[][]>, g: string, id: string, newRun: boolean): void {
	const list = runs.get(g) ?? [];
	if (newRun) list.push([id]);
	else at(list, list.length - 1).push(id);
	runs.set(g, list);
}

function largest(runs: readonly string[][]): string[] {
	return runs.reduce((best, run) => (run.length > best.length ? run : best));
}

/** Tabs that landed between anchors of a collapsed group, and do not belong to it, go just after it. */
function pushOutOfCollapsed(w: Work, paneId: string, pinnedCount: number, anchors: ReadonlySet<string>): void {
	if (!canHide(get(w.panes, paneId))) return;
	const tabs = w.order(paneId).slice(pinnedCount);
	const outsiders = new Map<string, string[]>();
	let lastAnchor = -1;
	tabs.forEach((id, i) => {
		if (!anchors.has(id)) return;
		const g = w.groupOf(id);
		if (lastAnchor >= 0 && i > lastAnchor + 1 && g?.collapsed === true && w.memberOf.get(at(tabs, lastAnchor)) === g.id) {
			const list = outsiders.get(g.id) ?? [];
			for (const gapId of tabs.slice(lastAnchor + 1, i)) if (w.memberOf.get(gapId) !== g.id) list.push(gapId);
			outsiders.set(g.id, list);
		}
		lastAnchor = i;
	});
	for (const [groupId, list] of outsiders) {
		let after = lastAnchorOf(w, paneId, groupId, anchors);
		for (const id of list) {
			const without = w.order(paneId).filter((x) => x !== id);
			w.move(id, without.indexOf(after) + 1);
			after = id;
		}
	}
}

/** Last anchor of the group, extended over the group's own non-anchor tabs that follow it. */
function lastAnchorOf(w: Work, paneId: string, groupId: string, anchors: ReadonlySet<string>): string {
	const order = w.order(paneId);
	let end = -1;
	order.forEach((id, i) => {
		if (anchors.has(id) && w.memberOf.get(id) === groupId) end = i;
	});
	while (end + 1 < order.length) {
		const id = at(order, end + 1);
		if (anchors.has(id) || w.memberOf.get(id) !== groupId) break;
		end++;
	}
	return at(order, end);
}

function settleGap(
	w: Work,
	gap: readonly string[],
	leftGroup: string | undefined,
	rightGroup: string | undefined,
	intent: DropIntent | undefined,
	anchoredGroups: ReadonlySet<string>,
	decided: Map<string, string | null>,
	floating: Map<string, string>,
): void {
	// Strictly inside one group: everyone joins.
	if (leftGroup !== undefined && leftGroup === rightGroup) {
		for (const id of gap) decided.set(id, leftGroup);
		return;
	}
	const result = new Array<string | null | undefined>(gap.length).fill(undefined);
	const dropped = intent === undefined ? -1 : gap.indexOf(intent.leafId);
	if (intent !== undefined && dropped >= 0) {
		const target = intent.joinGroupId;
		const own = w.memberOf.get(at(gap, dropped));
		if (target !== null && target === leftGroup) result.fill(leftGroup, 0, dropped + 1);
		else if (target !== null && target === rightGroup) result.fill(rightGroup, dropped);
		// A group that moved with the dropped tab (e.g. a one-tab group) is carried along.
		else if (own === undefined || anchoredGroups.has(own)) result[dropped] = null;
	}
	const hint = (k: number): string | undefined => w.memberOf.get(at(gap, k));
	if (leftGroup !== undefined) {
		for (let k = 0; k < gap.length; k++) {
			if (result[k] !== leftGroup && !(result[k] === undefined && hint(k) === leftGroup)) break;
			result[k] = leftGroup;
		}
	}
	if (rightGroup !== undefined) {
		for (let k = gap.length - 1; k >= 0; k--) {
			if (result[k] !== rightGroup && !(result[k] === undefined && hint(k) === rightGroup)) break;
			result[k] = rightGroup;
		}
	}
	gap.forEach((id, k) => {
		const r = result[k];
		if (r !== undefined) {
			decided.set(id, r);
			return;
		}
		const h = hint(k);
		if (h !== undefined && !anchoredGroups.has(h)) floating.set(id, h);
		else decided.set(id, null);
	});
}

/** A group without anchors keeps its largest run of consecutive tabs; the rest leave. */
function keepLargestFloatingRuns(
	tabs: readonly string[],
	floating: ReadonlyMap<string, string>,
	decided: Map<string, string | null>,
): void {
	if (floating.size === 0) return;
	const runs = new Map<string, string[][]>();
	let last: string | undefined;
	for (const id of tabs) {
		const g = floating.get(id);
		if (g !== undefined) addToRun(runs, g, id, g !== last);
		last = g;
	}
	for (const [groupId, list] of runs) {
		const keep = largest(list);
		for (const run of list) for (const id of run) decided.set(id, run === keep ? groupId : null);
	}
}

/**
 * A shown tab (current of its strip, or the active tab) is never hidden. Normally its group
 * expands. When the strip's shown tab was closed and Obsidian now shows a hidden tab, the
 * nearest visible tab is shown instead (see `showVisibleAfterClose`).
 */
function revealShownTabs(w: Work, prev: Snapshot): void {
	const redirected = showVisibleAfterClose(w, prev);
	const shown: (string | null)[] = [];
	for (const pane of w.panes.values()) if (!redirected.has(pane.id)) shown.push(pane.currentLeafId);
	const active = w.snapshot.activeLeafId;
	const activePane = active === null ? undefined : w.paneOf.get(active);
	const activeRedirected =
		activePane !== undefined && redirected.has(activePane) && get(w.panes, activePane).currentLeafId === active;
	if (!activeRedirected) shown.push(active);
	for (const id of shown) {
		if (id === null || !w.leaves.has(id) || !w.hidden(id)) continue;
		const group = get(w.groups, get(w.memberOf, id));
		w.setGroup({ ...group, collapsed: false });
	}
}

/**
 * Like Chrome, closing a tab never opens a collapsed group, and neither does dragging the shown tab
 * to another strip (step L7). Obsidian shows the tab now at the closed (or moved) tab's index (or
 * the new last tab), which may be hidden. For each strip whose shown tab
 * was closed and whose new shown tab is hidden, show the nearest visible tab around the closed
 * tab's slot instead: first to the right, then to the left (skipping hidden tabs). Returns the
 * strips handled. A strip with no visible tab left is not handled: its group expands.
 */
function showVisibleAfterClose(w: Work, prev: Snapshot): Set<string> {
	const handled = new Set<string>();
	for (const prevPane of prev.panes) {
		const closed = prevPane.currentLeafId;
		const pane = w.panes.get(prevPane.id);
		// The shown tab is still in this strip. (Closed, or dragged to another strip since step L7.)
		if (closed === null || pane === undefined || w.paneOf.get(closed) === pane.id) continue;
		const current = pane.currentLeafId;
		if (current === null || w.paneOf.get(current) !== pane.id || !w.hidden(current)) continue;
		const slot = prevPane.leaves.findIndex((l) => l.id === closed);
		const before = new Set(prevPane.leaves.slice(0, Math.max(slot, 0)).map((l) => l.id));
		const order = w.order(pane.id);
		let k = 0;
		order.forEach((id, i) => {
			if (before.has(id)) k = i + 1;
		});
		const target = nearestVisible(order, k, k - 1, (id) => w.hidden(id));
		if (target === null) continue;
		w.ops.push({ kind: 'activate', leafId: target });
		handled.add(pane.id);
	}
	return handled;
}
