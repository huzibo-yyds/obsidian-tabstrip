/**
 * Mutable scratch copy of a snapshot plus a group state, used inside one command or
 * one reconcile call. Nothing here escapes: callers turn it back into plain data.
 */
import { canHide, finishState } from './model';
import type { Group, GroupState, LeafInfo, Op, PaneInfo, Snapshot, Tombstone } from './types';
import { get } from './util';

export class Work {
	/** Working tab order per strip, updated by `move`. */
	readonly orders = new Map<string, string[]>();
	readonly panes = new Map<string, PaneInfo>();
	readonly leaves = new Map<string, LeafInfo>();
	readonly paneOf = new Map<string, string>();
	readonly memberOf = new Map<string, string>();
	/** Insertion order is creation order. */
	readonly groups = new Map<string, Group>();
	readonly ops: Op[] = [];
	tombstones: Tombstone[];
	nextGroupSeq: number;

	constructor(
		readonly snapshot: Snapshot,
		readonly state: GroupState,
	) {
		for (const pane of snapshot.panes) {
			if (this.panes.has(pane.id)) continue;
			this.panes.set(pane.id, pane);
			const order: string[] = [];
			for (const leaf of pane.leaves) {
				if (this.leaves.has(leaf.id)) continue;
				this.leaves.set(leaf.id, leaf);
				this.paneOf.set(leaf.id, pane.id);
				order.push(leaf.id);
			}
			this.orders.set(pane.id, order);
		}
		for (const group of state.groups) {
			if (!this.groups.has(group.id)) this.groups.set(group.id, group);
		}
		for (const m of state.members) {
			if (this.groups.has(m.groupId) && !this.memberOf.has(m.leafId)) this.memberOf.set(m.leafId, m.groupId);
		}
		this.tombstones = [...state.tombstones];
		this.nextGroupSeq = state.nextGroupSeq;
	}

	order(paneId: string): string[] {
		return get(this.orders, paneId);
	}

	pinned(leafId: string): boolean {
		return get(this.leaves, leafId).pinned;
	}

	groupOf(leafId: string): Group | undefined {
		const id = this.memberOf.get(leafId);
		return id === undefined ? undefined : this.groups.get(id);
	}

	/** True when the tab is a member of a collapsed group in a strip that hides tabs. */
	hidden(leafId: string): boolean {
		const group = this.groupOf(leafId);
		return group !== undefined && group.collapsed && canHide(get(this.panes, get(this.paneOf, leafId)));
	}

	/** Members of a group in working order, with the strip they are in (the first member's strip). */
	run(groupId: string): { paneId: string; ids: string[]; start: number; end: number } | null {
		for (const [paneId, order] of this.orders) {
			let start = -1;
			let end = -1;
			const ids: string[] = [];
			order.forEach((id, i) => {
				if (this.memberOf.get(id) !== groupId) return;
				if (start < 0) start = i;
				end = i;
				ids.push(id);
			});
			if (ids.length > 0) return { paneId, ids, start, end };
		}
		return null;
	}

	/** Like `run`, for a group known to have members. */
	span(groupId: string): { paneId: string; ids: string[]; start: number; end: number } {
		const found = this.run(groupId);
		if (found === null) throw new RangeError(`tabstrip core: group ${groupId} has no members`);
		return found;
	}

	/** Moves a tab within its strip and records the op. */
	move(leafId: string, index: number): void {
		const paneId = get(this.paneOf, leafId);
		const order = this.order(paneId);
		const from = order.indexOf(leafId);
		if (from === index) return;
		order.splice(from, 1);
		order.splice(index, 0, leafId);
		this.ops.push({ kind: 'move', leafId, paneId, index });
	}

	/** Replaces a strip's order with `target`, recording ops from `plan`. */
	reorder(paneId: string, target: string[], plan: (paneId: string, current: string[], target: string[]) => Op[]): void {
		const ops = plan(paneId, this.order(paneId), target);
		if (ops.length === 0) return;
		this.orders.set(paneId, target);
		this.ops.push(...ops);
	}

	setGroup(group: Group): void {
		this.groups.set(group.id, group);
	}

	freshGroupId(): string {
		const id = `g${String(this.nextGroupSeq)}`;
		this.nextGroupSeq += 1;
		return id;
	}

	/** Drops memberships of leaves that are not in the snapshot. */
	dropUnknownMembers(): void {
		for (const leafId of [...this.memberOf.keys()]) {
			if (!this.leaves.has(leafId)) this.memberOf.delete(leafId);
		}
	}

	finish(): GroupState {
		this.dropUnknownMembers();
		return finishState(
			this.state,
			[...this.groups.values()],
			this.memberOf,
			(id) => get(this.leaves, id).fingerprint,
			this.tombstones,
			this.nextGroupSeq,
		);
	}
}
