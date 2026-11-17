/**
 * The rules that must hold after every command and every reconcile.
 */
import { canHide } from './model';
import type { GroupState, PaneInfo, Snapshot, Violation } from './types';
import { at } from './util';

/** Returns every broken rule; an empty list means (snapshot, state) is consistent. */
export function invariants(snapshot: Snapshot, state: GroupState): Violation[] {
	const out: Violation[] = [];
	const where = new Map<string, { pane: PaneInfo; index: number; pinned: boolean }>();

	for (const pane of snapshot.panes) {
		let unpinnedSeen = false;
		pane.leaves.forEach((leaf, index) => {
			if (where.has(leaf.id)) out.push({ kind: 'duplicate-leaf', leafId: leaf.id });
			else where.set(leaf.id, { pane, index, pinned: leaf.pinned });
			if (!leaf.pinned) unpinnedSeen = true;
			else if (unpinnedSeen) out.push({ kind: 'pinned-not-prefix', paneId: pane.id, leafId: leaf.id });
		});
	}

	const groups = new Map<string, boolean>();
	for (const g of state.groups) {
		if (groups.has(g.id)) out.push({ kind: 'duplicate-group', groupId: g.id });
		groups.set(g.id, g.collapsed);
	}

	const memberOf = new Map<string, string>();
	const positions = new Map<string, { paneId: string; index: number }[]>();
	for (const m of state.members) {
		if (memberOf.has(m.leafId)) {
			out.push({ kind: 'duplicate-member', leafId: m.leafId });
			continue;
		}
		memberOf.set(m.leafId, m.groupId);
		const place = where.get(m.leafId);
		if (place === undefined) out.push({ kind: 'unknown-leaf', leafId: m.leafId });
		if (!groups.has(m.groupId)) out.push({ kind: 'unknown-group', leafId: m.leafId, groupId: m.groupId });
		if (place === undefined) continue;
		if (place.pinned) out.push({ kind: 'pinned-member', leafId: m.leafId });
		const list = positions.get(m.groupId) ?? [];
		list.push({ paneId: place.pane.id, index: place.index });
		positions.set(m.groupId, list);
	}

	for (const groupId of groups.keys()) {
		const list = positions.get(groupId);
		if (list === undefined) {
			out.push({ kind: 'empty-group', groupId });
			continue;
		}
		if (new Set(list.map((p) => p.paneId)).size > 1) {
			out.push({ kind: 'group-spans-panes', groupId });
			continue;
		}
		const indexes = list.map((p) => p.index).sort((a, b) => a - b);
		if (indexes.some((value, i) => i > 0 && value !== at(indexes, i - 1) + 1)) {
			out.push({ kind: 'group-not-contiguous', groupId });
		}
	}

	const hidden = (leafId: string): boolean => {
		const place = where.get(leafId);
		const groupId = memberOf.get(leafId);
		return place !== undefined && groupId !== undefined && groups.get(groupId) === true && canHide(place.pane);
	};
	for (const pane of snapshot.panes) {
		const current = pane.currentLeafId;
		if (current !== null && hidden(current)) out.push({ kind: 'hidden-current', paneId: pane.id, leafId: current });
	}
	const active = snapshot.activeLeafId;
	if (active !== null && hidden(active)) out.push({ kind: 'hidden-active', leafId: active });
	return out;
}
