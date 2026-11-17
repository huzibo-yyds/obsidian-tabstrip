/**
 * Drag and drop of tabs into and out of groups (step L7), the pure part.
 *
 * The UI watches Obsidian's own tab drag passively and describes where the pointer is: over a
 * tab (and on which half), over a group's chip, or over the empty end of a strip (`DropSpot`,
 * found from the header boxes by `spotAt`). From that:
 * - `dropIntentOf` gives the drop intent reconcile uses at a group's boundary (rules 2 and 4);
 * - `landing` tells where Obsidian will insert the tab, the same way Obsidian does: the first tab
 *   whose end is at or past the pointer is the one under it, and the pointer's half decides
 *   before or after it;
 * - `predictDrop` runs reconcile on that predicted layout, so the group highlighted while
 *   dragging is exactly the group the tab ends up in;
 * - `dropInPlace` applies the rules to a drop Obsidian does not move (released next to itself).
 *
 * Membership rules (requirements 5.1 "drag", 5.2 scope):
 * 1. dropped with members of one group on both sides: joins that group;
 * 2. dropped at a group's first or last boundary: joins only if the pointer was on a member of that
 *    group or on its chip; on an ungrouped neighbour it stays out;
 * 3. dragged out of its group within the strip: leaves it (a group left empty is deleted);
 * 4. a collapsed group is never joined by a drop: a tab dropped into its middle or on its chip goes
 *    to just after it, ungrouped and visible; the group stays collapsed;
 * 5. dragged to another strip (split, pop-out, new window): leaves its group;
 * 6. pinned tabs are never members;
 * 7. without an intent (programmatic moves, other plugins) reconcile's own rules apply.
 */
import { canHide } from './model';
import { applyOps } from './ops';
import { reconcile } from './reconcile';
import type { CommandResult, DropIntent, GroupState, Op, PaneInfo, Snapshot } from './types';
import { Work } from './work';

export type DropSpot =
	/** Over a tab header; `side` is the pointer's half of it. */
	| { readonly kind: 'tab'; readonly leafId: string; readonly side: 'before' | 'after' }
	/** Over a group's chip (or, for a collapsed group, its hidden tabs right after the chip). */
	| { readonly kind: 'chip'; readonly groupId: string }
	/** Past the last tab of the strip, or an empty strip. */
	| { readonly kind: 'empty' }
	/**
	 * Step V5 (vertical strip): right before this tab, on no tab and no chip: above a group row, so the
	 * tab lands before the group and outside it (no horizontal header has such a place).
	 */
	| { readonly kind: 'gap'; readonly beforeLeafId: string };

/** A dragged tab over a strip. */
export interface DropTarget {
	/** The dragged tab. */
	readonly leafId: string;
	/** The strip under the pointer. */
	readonly paneId: string;
	readonly spot: DropSpot;
}

/** A tab header's horizontal extent, in the strip's tab order. */
export interface HeaderBox {
	readonly leafId: string;
	readonly left: number;
	readonly right: number;
	/** The collapsed group this hidden (zero-width) header belongs to, else null. */
	readonly hiddenGroupId: string | null;
}

export interface ChipBox {
	readonly groupId: string;
	readonly left: number;
	readonly right: number;
}

/**
 * What is under the pointer at `x`. A chip wins (it sits in its first tab's margin, outside that
 * tab's box). Otherwise the tab under the pointer is the first one whose end is at or past it,
 * like Obsidian's own insert position; a hidden tab of a collapsed group counts as its chip.
 */
export function spotAt(x: number, headers: readonly HeaderBox[], chips: readonly ChipBox[], rtl = false): DropSpot {
	// Right to left (best effort): mirror the axis, so "first tab" and "before" keep their tab-order meaning.
	if (rtl) return spotAt(-x, headers.map(mirror), chips.map(mirror));
	for (const chip of chips) if (x >= chip.left && x <= chip.right) return { kind: 'chip', groupId: chip.groupId };
	const last = headers[headers.length - 1];
	if (last === undefined || x > last.right) return { kind: 'empty' };
	const hit = headers.find((h) => x <= h.right) ?? last;
	if (hit.hiddenGroupId !== null) return { kind: 'chip', groupId: hit.hiddenGroupId };
	return { kind: 'tab', leafId: hit.leafId, side: x > (hit.left + hit.right) / 2 ? 'after' : 'before' };
}

function mirror<T extends { readonly left: number; readonly right: number }>(box: T): T {
	return { ...box, left: -box.right, right: -box.left };
}

function groupOf(state: GroupState, leafId: string): string | null {
	return state.members.find((m) => m.leafId === leafId)?.groupId ?? null;
}

/** The group hides tabs in this strip (collapsed, strip not stacked). */
function hiding(state: GroupState, pane: PaneInfo | undefined, groupId: string): boolean {
	const group = state.groups.find((g) => g.id === groupId);
	return group?.collapsed === true && pane !== undefined && canHide(pane);
}

/** The drop intent for reconcile: the group under the pointer (rule 2), or "after this collapsed group" (rule 4). */
export function dropIntentOf(state: GroupState, snapshot: Snapshot, target: DropTarget): DropIntent {
	const pane = snapshot.panes.find((p) => p.id === target.paneId);
	const spot = target.spot;
	let groupId: string | null = null;
	if (spot.kind === 'chip') groupId = spot.groupId;
	else if (spot.kind === 'tab') groupId = groupOf(state, spot.leafId);
	if (groupId === null) return { leafId: target.leafId, joinGroupId: null };
	if (hiding(state, pane, groupId)) {
		return spot.kind === 'chip' ? { leafId: target.leafId, joinGroupId: null, afterGroupId: groupId } : { leafId: target.leafId, joinGroupId: null };
	}
	return { leafId: target.leafId, joinGroupId: groupId };
}

/**
 * Where Obsidian inserts the dragged tab: the index in the target strip once the tab has been taken
 * out of its own strip, or null when the drop does not move it (onto itself, or next to itself on
 * the side it already is) or the target is unknown. A chip sits before its group's first tab.
 */
export function landing(state: GroupState, snapshot: Snapshot, target: DropTarget): number | null {
	const pane = snapshot.panes.find((p) => p.id === target.paneId);
	if (pane === undefined) return null;
	const order = pane.leaves.map((l) => l.id);
	const spot = target.spot;
	let index: number;
	if (spot.kind === 'empty') {
		index = order.length;
	} else if (spot.kind === 'tab') {
		index = order.indexOf(spot.leafId);
		if (index < 0) return null;
		if (spot.side === 'after') index++;
	} else if (spot.kind === 'gap') {
		index = order.indexOf(spot.beforeLeafId);
		if (index < 0) return null;
	} else {
		index = order.findIndex((id) => groupOf(state, id) === spot.groupId);
		if (index < 0) return null;
	}
	const from = order.indexOf(target.leafId);
	if (from < 0) return index;
	if (index > from) index--;
	return index === from ? null : index;
}

/**
 * The layout after Obsidian's move of the dragged tab to `index` of the target strip: it becomes
 * that strip's shown tab and the active tab (a drop activates the tab).
 */
export function movedSnapshot(snapshot: Snapshot, leafId: string, paneId: string, index: number): Snapshot | null {
	const leaf = snapshot.panes.flatMap((p) => p.leaves).find((l) => l.id === leafId);
	if (leaf === undefined || !snapshot.panes.some((p) => p.id === paneId)) return null;
	const panes = snapshot.panes.map((p) => {
		const from = p.leaves.findIndex((l) => l.id === leafId);
		let leaves = p.leaves;
		let current = p.currentLeafId;
		if (from >= 0) {
			leaves = leaves.filter((l) => l.id !== leafId);
			if (current === leafId) current = (leaves[from] ?? leaves[from - 1])?.id ?? null;
		}
		if (p.id === paneId) {
			leaves = [...leaves.slice(0, index), leaf, ...leaves.slice(index)];
			current = leafId;
		}
		return { ...p, leaves, currentLeafId: current };
	});
	return { panes, activeLeafId: leafId };
}

export interface DropPrediction {
	/** The group the tab will be in after the drop, or null. */
	readonly groupId: string | null;
	/**
	 * Whether the drop changes the tab order of any strip, once the rules are applied (a drop that the
	 * rules put straight back, like the tab right after a collapsed group released on its chip, moves
	 * nothing; V5 review round 1).
	 */
	readonly moves: boolean;
}

/**
 * The group the dragged tab will be in if dropped now: reconcile on the predicted layout with the
 * drop intent, so the highlight never disagrees with the result.
 */
export function predictDrop(state: GroupState, snapshot: Snapshot, target: DropTarget): DropPrediction {
	const index = landing(state, snapshot, target);
	if (index === null) {
		// Obsidian does not move it; the plugin may still (dropInPlace).
		const inPlace = dropInPlace(state, snapshot, target);
		return { groupId: groupOf(inPlace?.state ?? state, target.leafId), moves: inPlace?.ops.some((op) => op.kind === 'move') === true };
	}
	const next = movedSnapshot(snapshot, target.leafId, target.paneId, index);
	if (next === null) return { groupId: groupOf(state, target.leafId), moves: false };
	const result = reconcile(snapshot, next, state, { dropIntent: dropIntentOf(state, snapshot, target) });
	return { groupId: groupOf(result.state, target.leafId), moves: !sameOrder(snapshot, settledLayout(next, result.ops)) };
}

/** The layout once these ops ran (moves only change it; null when they cannot be applied here). */
function settledLayout(next: Snapshot, ops: readonly Op[]): Snapshot | null {
	try {
		return applyOps(next, ops, () => '\u0000new');
	} catch {
		return null;
	}
}

/** Whether every strip holds the same tabs in the same order (null: unknown, counts as changed). */
function sameOrder(a: Snapshot, b: Snapshot | null): boolean {
	if (b === null || a.panes.length !== b.panes.length) return false;
	return a.panes.every((p, i) => {
		const q = b.panes[i];
		return q !== undefined && q.id === p.id && q.leaves.length === p.leaves.length && q.leaves.every((l, k) => l.id === p.leaves[k]?.id);
	});
}

/** A drop intent is used only by a pass that sees the dragged tab move within this time after the drop. */
export const DROP_TTL_MS = 1000;

/**
 * Whether the dragged tab moved from `prev` to `next`: it is in another strip now, or in another
 * place among the tabs both layouts share in its strip (tabs opened or closed elsewhere do not count).
 */
export function dropMoved(prev: Snapshot, next: Snapshot, leafId: string): boolean {
	const from = prev.panes.find((p) => p.leaves.some((l) => l.id === leafId));
	const to = next.panes.find((p) => p.leaves.some((l) => l.id === leafId));
	if (from === undefined || to === undefined) return from !== to;
	if (from.id !== to.id) return true;
	const before = new Set(from.leaves.map((l) => l.id));
	const after = new Set(to.leaves.map((l) => l.id));
	const a = from.leaves.map((l) => l.id).filter((id) => after.has(id));
	const b = to.leaves.map((l) => l.id).filter((id) => before.has(id));
	return a.indexOf(leafId) !== b.indexOf(leafId);
}

/**
 * What a pass does with a pending drop: 'use' its intent (the dragged tab moved, in time),
 * 'expired' (too old), 'unmoved' (the layout changed but not by this drop: the drop is dropped, so
 * an unrelated change never applies it), or 'wait' (nothing changed yet).
 */
export function dropUse(ageMs: number, prev: Snapshot, next: Snapshot, leafId: string, layoutChanged: boolean): 'use' | 'expired' | 'unmoved' | 'wait' {
	if (ageMs > DROP_TTL_MS) return 'expired';
	if (!layoutChanged) return 'wait';
	return dropMoved(prev, next, leafId) ? 'use' : 'unmoved';
}

/**
 * Rule 4 when Obsidian does not move the tab: the tab right before a collapsed group, released on
 * that group's chip. Obsidian inserts "before the group", where the tab already is, while its drop
 * line shows after the chip; like any other drop on a collapsed chip, the tab goes to just after the
 * group, ungrouped and visible, and the group stays collapsed. Null when this is not that case.
 */
export function dropAfterCollapsed(state: GroupState, snapshot: Snapshot, target: DropTarget): CommandResult | null {
	if (landing(state, snapshot, target) !== null) return null;
	const intent = dropIntentOf(state, snapshot, target);
	const groupId = intent.afterGroupId;
	const pane = snapshot.panes.find((p) => p.id === target.paneId);
	if (groupId === undefined || pane === undefined) return null;
	const leaf = pane.leaves.find((l) => l.id === target.leafId);
	if (leaf === undefined || leaf.pinned) return null;
	const rest = pane.leaves.filter((l) => l.id !== target.leafId);
	let last = -1;
	rest.forEach((l, i) => {
		if (groupOf(state, l.id) === groupId) last = i;
	});
	if (last < 0) return null;
	const index = last + 1;
	const leaves = [...rest.slice(0, index), leaf, ...rest.slice(index)];
	const next: Snapshot = { ...snapshot, panes: snapshot.panes.map((p) => (p.id === pane.id ? { ...p, leaves } : p)) };
	const settled = reconcile(snapshot, next, state, { dropIntent: intent });
	return { state: settled.state, ops: [{ kind: 'move', leafId: target.leafId, paneId: pane.id, index }, ...settled.ops] };
}

/**
 * What the plugin does for a drop Obsidian does not move (L7 review round 2): the tab is released
 * next to itself, on the side it already is, so the layout does not change and reconcile never sees
 * the drop. The rules still apply to where the pointer was:
 * - on the chip of the collapsed group right after it: rule 4 (`dropAfterCollapsed`);
 * - on the chip or the facing member of a group it touches: rule 2, it joins that group in place
 *   (the tab right before an expanded group released on its chip or its first member's left half
 *   becomes its first member; right after it, on its last member's right half, its last member);
 * - its own group's boundary member released on the facing half of an ungrouped neighbour, or the
 *   last tab released on the empty end: rules 2 and 3, it leaves its group in place (a group of one
 *   tab stays, as it does when it moves with its tab).
 * Null when Obsidian moves the tab (reconcile decides) or nothing changes.
 */
export function dropInPlace(state: GroupState, snapshot: Snapshot, target: DropTarget): CommandResult | null {
	if (landing(state, snapshot, target) !== null) return null;
	const collapsed = dropAfterCollapsed(state, snapshot, target);
	if (collapsed !== null) return collapsed;
	const pane = snapshot.panes.find((p) => p.id === target.paneId);
	if (pane === undefined) return null;
	const order = pane.leaves.map((l) => l.id);
	const k = order.indexOf(target.leafId);
	const leaf = pane.leaves[k];
	if (leaf === undefined || leaf.pinned) return null;
	const spot = target.spot;
	if (spot.kind === 'tab' && spot.leafId === target.leafId) return null;
	const intent = dropIntentOf(state, snapshot, target);
	if (intent.afterGroupId !== undefined) return null;
	const own = groupOf(state, target.leafId);
	const want = intent.joinGroupId;
	if (want === own) return null;
	if (want !== null) {
		// Only a group the tab touches (its run is contiguous, so the tab is then at its boundary).
		const left = order[k - 1];
		const right = order[k + 1];
		const touches = (id: string | undefined) => id !== undefined && groupOf(state, id) === want;
		if (!touches(left) && !touches(right)) return null;
	} else {
		if (own === null || spot.kind === 'chip') return null;
		// A hidden tab of a collapsed group counts as its chip (spotAt), which is rule 4's, not this.
		if (spot.kind === 'tab') {
			const under = groupOf(state, spot.leafId);
			if (under !== null && hiding(state, pane, under)) return null;
		}
		// A gap (step V5) at the tab's own place: the tab is at that side's boundary of its group only
		// when the tab across the gap is not a member too (a gap inside a group never splits it).
		if (spot.kind === 'gap') {
			const across = spot.beforeLeafId === target.leafId ? order[k - 1] : spot.beforeLeafId;
			if (across !== undefined && groupOf(state, across) === own) return null;
		}
		// A group of one tab stays with its tab.
		if (state.members.filter((m) => m.groupId === own).length === 1) return null;
	}
	const w = new Work(snapshot, state);
	if (want === null) w.memberOf.delete(target.leafId);
	else w.memberOf.set(target.leafId, want);
	return { state: w.finish(), ops: [] };
}

/**
 * Step V5, the keyboard alternative to dragging in the vertical strip: the drop that moves a tab one
 * row up (`dir` -1) or down (+1) in its strip, so the same rules apply as for a drag. Like Chrome's
 * keyboard tab moves, a group boundary is a step of its own:
 * - a member at its group's edge first leaves the group in place (a group of one tab moves with it);
 * - an ungrouped tab next to an expanded group first joins it in place, at that edge;
 * - next to a collapsed group it jumps over the whole group (rule 4: never joined);
 * - otherwise it swaps places with its neighbour, staying in its group.
 * Pinned tabs move among the pinned tabs of their strip only (they are never members), and an
 * ungrouped tab never moves into the pinned area. Null when the tab cannot move that way, or when
 * it is hidden in a collapsed group.
 */
export function stepTarget(state: GroupState, snapshot: Snapshot, leafId: string, dir: -1 | 1): DropTarget | null {
	const pane = snapshot.panes.find((p) => p.leaves.some((l) => l.id === leafId));
	if (pane === undefined) return null;
	const order = pane.leaves.map((l) => l.id);
	const k = order.indexOf(leafId);
	const pinned = (id: string | undefined) => id !== undefined && pane.leaves.find((l) => l.id === id)?.pinned === true;
	const target = (spot: DropSpot): DropTarget => ({ leafId, paneId: pane.id, spot });
	const next = order[k + dir];
	// A tab hidden in a collapsed group has no row to move (only its strip's shown tab stays visible).
	const ownGroup = groupOf(state, leafId);
	if (ownGroup !== null && hiding(state, pane, ownGroup) && pane.currentLeafId !== leafId) return null;
	if (pinned(leafId)) {
		if (!pinned(next) || next === undefined) return null;
		return target({ kind: 'tab', leafId: next, side: dir < 0 ? 'before' : 'after' });
	}
	if (next === undefined || pinned(next)) {
		// Nothing to pass; only leaving the group in place is left.
		const own = groupOf(state, leafId);
		if (own === null || state.members.filter((m) => m.groupId === own).length < 2) return null;
		return dir < 0 ? target({ kind: 'gap', beforeLeafId: leafId }) : target({ kind: 'empty' });
	}
	const own = groupOf(state, leafId);
	const theirs = groupOf(state, next);
	if (own !== null && theirs !== own && state.members.filter((m) => m.groupId === own).length > 1) {
		// At its group's edge: leave the group, the tab stays where it is.
		return target({ kind: 'gap', beforeLeafId: dir < 0 ? leafId : next });
	}
	if (theirs !== null && theirs !== own) {
		if (hiding(state, pane, theirs)) {
			// Over the whole collapsed group.
			if (dir > 0) return target({ kind: 'chip', groupId: theirs });
			const first = order.find((id) => groupOf(state, id) === theirs);
			return first === undefined ? null : target({ kind: 'gap', beforeLeafId: first });
		}
		// Into the expanded group, at its edge.
		return dir > 0 ? target({ kind: 'chip', groupId: theirs }) : target({ kind: 'tab', leafId: next, side: 'after' });
	}
	return target({ kind: 'tab', leafId: next, side: dir < 0 ? 'before' : 'after' });
}
