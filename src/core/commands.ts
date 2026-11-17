/**
 * User commands on groups. Each one is a pure function of (state, snapshot, args)
 * and returns the new state plus the ops the adapter must carry out.
 *
 * Commands expect a state that satisfies `invariants` for the snapshot (reconcile
 * guarantees that). Arguments that do not apply (unknown ids, pinned tabs, tabs in
 * another strip) are ignored; when nothing applies the input state is returned as is.
 */
import { canHide, clipName, isGroupColor, nearestVisible, pickColor, pushTombstones } from './model';
import { planReorder } from './sequence';
import type { CommandResult, Group, GroupColor, GroupState, Snapshot, Tombstone } from './types';
import { at, get } from './util';
import { Work } from './work';

export interface CreateGroupResult extends CommandResult {
	/** Id of the new group, or null when no tab could be grouped. */
	readonly groupId: string | null;
}

function unchanged(state: GroupState): CommandResult {
	return { state, ops: [] };
}

/** Unique, existing, unpinned tabs among `leafIds`, in the order given. */
function usableLeaves(w: Work, leafIds: readonly string[]): string[] {
	const seen = new Set<string>();
	return leafIds.filter((id) => {
		if (seen.has(id) || !w.leaves.has(id) || w.pinned(id)) return false;
		seen.add(id);
		return true;
	});
}

/** Groups that still have at least one member in the work copy. */
function liveGroups(w: Work): Group[] {
	const used = new Set(w.memberOf.values());
	return [...w.groups.values()].filter((g) => used.has(g.id));
}

/**
 * If the strip's current tab is now hidden, show the nearest visible tab instead
 * (right first, skipping hidden tabs, then left), or create a new tab at the end.
 */
function keepCurrentVisible(w: Work, paneId: string): void {
	const current = get(w.panes, paneId).currentLeafId;
	if (current === null || !w.leaves.has(current) || !w.hidden(current)) return;
	const span = w.span(get(w.memberOf, current));
	const order = w.order(paneId);
	const target = nearestVisible(order, span.start, span.end, (id) => w.hidden(id));
	w.ops.push(target === null ? { kind: 'create', paneId, index: order.length } : { kind: 'activate', leafId: target });
}

/**
 * New group from `leafIds` (tabs in the strip of the first usable one). The tabs leave
 * their old groups and are lined up at the position of the leftmost one, or just
 * after the group that position falls into.
 */
export function createGroup(
	state: GroupState,
	snapshot: Snapshot,
	leafIds: readonly string[],
	options: { readonly name?: string; readonly color?: GroupColor } = {},
): CreateGroupResult {
	const w = new Work(snapshot, state);
	const usable = usableLeaves(w, leafIds);
	if (usable.length === 0) return { ...unchanged(state), groupId: null };
	const paneId = get(w.paneOf, at(usable, 0));
	const chosen = new Set(usable.filter((id) => w.paneOf.get(id) === paneId));

	const order = w.order(paneId);
	const block = order.filter((id) => chosen.has(id));
	for (const id of block) w.memberOf.delete(id);
	const rest = order.filter((id) => !chosen.has(id));
	let insertAt = order.indexOf(at(block, 0));
	// Never split another group: step past the group the position falls into.
	const left = insertAt > 0 ? w.memberOf.get(at(rest, insertAt - 1)) : undefined;
	if (left !== undefined) {
		while (insertAt < rest.length && w.memberOf.get(at(rest, insertAt)) === left) insertAt++;
	}
	w.reorder(paneId, [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)], planReorder);

	const color = options.color !== undefined && isGroupColor(options.color) ? options.color : pickColor(liveGroups(w));
	const groupId = w.freshGroupId();
	w.setGroup({ id: groupId, name: clipName(options.name ?? ''), color, collapsed: false });
	for (const id of block) w.memberOf.set(id, groupId);
	return { state: w.finish(), ops: w.ops, groupId };
}

/** Adds tabs of the group's strip to the end of the group. */
export function addToGroup(
	state: GroupState,
	snapshot: Snapshot,
	leafIds: readonly string[],
	groupId: string,
): CommandResult {
	const w = new Work(snapshot, state);
	const group = w.groups.get(groupId);
	const span = w.run(groupId);
	if (group === undefined || span === null) return unchanged(state);
	const adding = new Set(
		usableLeaves(w, leafIds).filter((id) => w.paneOf.get(id) === span.paneId && w.memberOf.get(id) !== groupId),
	);
	if (adding.size === 0) return unchanged(state);

	const order = w.order(span.paneId);
	const moving = order.filter((id) => adding.has(id));
	for (const id of moving) w.memberOf.delete(id);
	const rest = order.filter((id) => !adding.has(id));
	const end = rest.indexOf(at(span.ids, span.ids.length - 1)) + 1;
	w.reorder(span.paneId, [...rest.slice(0, end), ...moving, ...rest.slice(end)], planReorder);
	for (const id of moving) w.memberOf.set(id, groupId);

	// The shown tab must not end up hidden: adding it to a collapsed group expands the group.
	const current = get(w.panes, span.paneId).currentLeafId;
	if (group.collapsed && current !== null && adding.has(current)) w.setGroup({ ...group, collapsed: false });
	return { state: w.finish(), ops: w.ops };
}

/**
 * Takes tabs out of their groups. A tab from the middle of a group moves to just
 * after the rest of the group; tabs at either end stay where they are.
 */
export function removeFromGroup(state: GroupState, snapshot: Snapshot, leafIds: readonly string[]): CommandResult {
	const w = new Work(snapshot, state);
	const byGroup = new Map<string, Set<string>>();
	for (const id of leafIds) {
		const groupId = w.memberOf.get(id);
		if (groupId === undefined || !w.leaves.has(id)) continue;
		const set = byGroup.get(groupId) ?? new Set<string>();
		set.add(id);
		byGroup.set(groupId, set);
	}
	if (byGroup.size === 0) return unchanged(state);

	for (const [groupId, removing] of byGroup) {
		const span = w.span(groupId);
		for (const id of removing) w.memberOf.delete(id);
		const remaining = span.ids.filter((id) => !removing.has(id));
		if (remaining.length === 0) continue;
		const order = w.order(span.paneId);
		const first = order.indexOf(at(remaining, 0));
		const last = order.indexOf(at(remaining, remaining.length - 1));
		const inside = span.ids.filter((id) => {
			const i = order.indexOf(id);
			return removing.has(id) && i > first && i < last;
		});
		if (inside.length === 0) continue;
		const rest = order.filter((id) => !inside.includes(id));
		const end = rest.indexOf(at(remaining, remaining.length - 1)) + 1;
		w.reorder(span.paneId, [...rest.slice(0, end), ...inside, ...rest.slice(end)], planReorder);
	}
	return { state: w.finish(), ops: w.ops };
}

function updateGroup(state: GroupState, groupId: string, change: (g: Group) => Group): CommandResult {
	const index = state.groups.findIndex((g) => g.id === groupId);
	if (index < 0) return unchanged(state);
	const before = at(state.groups, index);
	const after = change(before);
	if (after.name === before.name && after.color === before.color && after.collapsed === before.collapsed) {
		return unchanged(state);
	}
	const groups = [...state.groups];
	groups[index] = after;
	return { state: { ...state, groups }, ops: [] };
}

export function renameGroup(state: GroupState, groupId: string, name: string): CommandResult {
	return updateGroup(state, groupId, (g) => ({ ...g, name: clipName(name) }));
}

export function recolorGroup(state: GroupState, groupId: string, color: GroupColor): CommandResult {
	if (!isGroupColor(color)) return unchanged(state);
	return updateGroup(state, groupId, (g) => ({ ...g, color }));
}

/**
 * Collapses or expands a group. Collapsing is refused in a stacked strip. When the
 * strip's shown tab is in the group, the ops show the nearest visible tab to the
 * right (skipping other collapsed groups), else to the left, else a new tab.
 */
export function setCollapsed(state: GroupState, snapshot: Snapshot, groupId: string, collapsed: boolean): CommandResult {
	const w = new Work(snapshot, state);
	const group = w.groups.get(groupId);
	const span = w.run(groupId);
	if (group === undefined || span === null || group.collapsed === collapsed) return unchanged(state);
	if (collapsed && !canHide(get(w.panes, span.paneId))) return unchanged(state);
	w.setGroup({ ...group, collapsed });
	keepCurrentVisible(w, span.paneId);
	return { state: w.finish(), ops: w.ops };
}

/** Collapses every other expanded group in the same strip. */
export function collapseOthers(state: GroupState, snapshot: Snapshot, groupId: string): CommandResult {
	const w = new Work(snapshot, state);
	const span = w.run(groupId);
	if (span === null || !canHide(get(w.panes, span.paneId))) return unchanged(state);
	const others = [...w.groups.values()].filter(
		(g) => g.id !== groupId && !g.collapsed && w.run(g.id)?.paneId === span.paneId,
	);
	if (others.length === 0) return unchanged(state);
	for (const g of others) w.setGroup({ ...g, collapsed: true });
	keepCurrentVisible(w, span.paneId);
	return { state: w.finish(), ops: w.ops };
}

/** Removes the group; its tabs stay where they are. */
export function ungroup(state: GroupState, groupId: string): CommandResult {
	if (!state.groups.some((g) => g.id === groupId)) return unchanged(state);
	return {
		state: {
			...state,
			groups: state.groups.filter((g) => g.id !== groupId),
			members: state.members.filter((m) => m.groupId !== groupId),
		},
		ops: [],
	};
}

/**
 * Closes all tabs of the group. Members are written to the tombstone ring so undo-close
 * can rebuild the group. If the strip's shown tab is in the group, the nearest visible
 * tab outside it is shown first.
 */
export function closeGroup(state: GroupState, snapshot: Snapshot, groupId: string): CommandResult {
	const w = new Work(snapshot, state);
	const group = w.groups.get(groupId);
	const span = w.run(groupId);
	if (group === undefined || span === null) return unchanged(state);
	const order = w.order(span.paneId);
	// The tabs close left to right, so each one's slot is the group's start (see reconcile).
	const batch: Tombstone[] = span.ids.map((leafId) => ({
		leafId,
		groupId,
		groupName: group.name,
		groupColor: group.color,
		paneId: span.paneId,
		paneIndex: span.start,
		indexInGroup: 0,
		fingerprint: get(w.leaves, leafId).fingerprint,
		left: span.start > 0 ? at(order, span.start - 1) : null,
		right: order[span.end + 1] ?? null,
	}));
	w.tombstones = pushTombstones(w.tombstones, batch.reverse());
	for (const id of span.ids) w.memberOf.delete(id);

	const current = get(w.panes, span.paneId).currentLeafId;
	if (current !== null && span.ids.includes(current)) {
		const target = nearestVisible(order, span.start, span.end, (id) => w.hidden(id));
		if (target !== null) w.ops.push({ kind: 'activate', leafId: target });
	}
	w.ops.push({ kind: 'close', leafIds: span.ids });
	return { state: w.finish(), ops: w.ops };
}
