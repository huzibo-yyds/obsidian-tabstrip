/**
 * Step L7: an independent statement of the drag membership rules, used to check reconcile.
 *
 * Given a valid layout and state, a dragged tab and where it is dropped (`DropTarget`), the oracle
 * says which group the tab must end up in and where, written straight from the rules (requirements
 * 5.1 "drag", 5.2 scope) instead of from reconcile's algorithm:
 * 1. members of one group on both sides of the landing slot: joins that group;
 * 2. at a group boundary: joins only the group under the pointer (member or chip), else stays out;
 * 3. dragged out of its group: leaves (a group of one tab moves with it within its strip);
 * 4. never joins a collapsed group: dropped into its middle or on its chip, the tab goes to just
 *    after the group, ungrouped, and the group stays collapsed;
 * 5. to another strip: leaves its group (unless it joins a group there by rules 1-2);
 * 6. pinned tabs are never members.
 * Every other tab keeps its group, every group stays as collapsed as it was.
 */
import { expect } from 'vitest';
import { dropInPlace, dropIntentOf, landing, movedSnapshot, predictDrop, type DropTarget } from '../../../src/core/drag';
import { invariants } from '../../../src/core/invariants';
import { canHide } from '../../../src/core/model';
import { applyOps } from '../../../src/core/ops';
import { reconcile } from '../../../src/core/reconcile';
import type { GroupState, Snapshot } from '../../../src/core/types';
import { layout } from './dsl';

export interface DropCheck {
	/** What happened, for statistics. */
	readonly outcome: 'no-move' | 'joined-in-place' | 'left-in-place' | 'after-collapsed-in-place' | 'joined-middle' | 'joined-boundary' | 'after-collapsed' | 'stayed-out' | 'kept-own' | 'pinned' | 'pinned-area';
	readonly next: Snapshot;
	readonly state: GroupState;
}

const groupOf = (st: GroupState, id: string | undefined): string | null =>
	id === undefined ? null : (st.members.find((m) => m.leafId === id)?.groupId ?? null);

/**
 * Applies a drop like Obsidian (`landing` + `movedSnapshot`), reconciles with the drop intent and
 * checks the result against the rules. Returns the settled layout and state.
 */
export function checkDrop(s: Snapshot, st: GroupState, target: DropTarget, log: () => string = () => ''): DropCheck {
	const msg = (what: string) => `${what}\n${JSON.stringify(target)}\n${log()}`;
	const index = landing(st, s, target);
	const prediction = predictDrop(st, s, target);
	if (index === null) return checkInPlace(s, st, target, msg);
	const next = movedSnapshot(s, target.leafId, target.paneId, index);
	if (next === null) throw new Error('drop target not in the snapshot');
	const intent = dropIntentOf(st, s, target);
	const r = reconcile(s, next, st, { dropIntent: intent });
	const after = applyOps(next, r.ops, () => 'never');
	expect(invariants(after, r.state), msg('invariants')).toEqual([]);
	const again = reconcile(next, after, r.state);
	expect(again.ops, msg('idempotent')).toEqual([]);
	expect(again.state, msg('idempotent state')).toBe(r.state);

	const d = target.leafId;
	const final = groupOf(r.state, d);
	expect(prediction.groupId, msg('highlight = result')).toBe(final);
	// V5 review round 1: the drop line shows only when the order really changes.
	expect(prediction.moves, msg('moves = the order changes')).toBe(layout(after) !== layout(s));

	// Every other tab keeps its group; no group changes its collapsed flag.
	for (const m of st.members) {
		if (m.leafId === d) continue;
		expect(groupOf(r.state, m.leafId), msg(`other tab ${m.leafId} keeps its group`)).toBe(m.groupId);
	}
	// A group opens only when the shown tab was dragged out of a strip with no visible tab left.
	const source = s.panes.find((p) => p.leaves.some((l) => l.id === d));
	const sourceAfter = next.panes.find((p) => p.id === source?.id);
	const shownLeft = source !== undefined && source.id !== target.paneId && source.currentLeafId === d;
	const visibleLeft = (sourceAfter?.leaves ?? []).some((l) => {
		const g = groupOf(st, l.id);
		return !(g !== null && st.groups.find((x) => x.id === g)?.collapsed === true && sourceAfter !== undefined && canHide(sourceAfter));
	});
	for (const g of r.state.groups) {
		const was = st.groups.find((x) => x.id === g.id);
		if (was === undefined || g.collapsed === was.collapsed) continue;
		expect(shownLeft && !visibleLeft && was.collapsed, msg(`group ${g.id} collapsed flag`)).toBe(true);
	}

	const pane = next.panes.find((p) => p.id === target.paneId);
	if (pane === undefined) throw new Error('no target pane');
	const leaf = pane.leaves.find((l) => l.id === d);
	if (leaf?.pinned === true) {
		expect(final, msg('rule 6')).toBeNull();
		return { outcome: 'pinned', next: after, state: r.state };
	}
	const order = pane.leaves.map((l) => l.id);
	const k = order.indexOf(d);
	const left = order[k - 1];
	const right = order[k + 1];
	if (right !== undefined && pane.leaves[k + 1]?.pinned === true) {
		// Dropped among pinned tabs: moved back out (L3 rule R06); it never lands in a group's middle.
		return { outcome: 'pinned-area', next: after, state: r.state };
	}
	const hides = (g: string | null): boolean => g !== null && st.groups.find((x) => x.id === g)?.collapsed === true && canHide(pane);
	const own = groupOf(st, d);
	const sourcePane = s.panes.find((p) => p.leaves.some((l) => l.id === d));
	const ownAlone = own !== null && st.members.filter((m) => m.groupId === own).length === 1 && sourcePane?.id === target.paneId;
	const gL = groupOf(st, left);
	const gR = groupOf(st, right);
	const finalPane = after.panes.find((p) => p.leaves.some((l) => l.id === d));
	const finalOrder = finalPane?.leaves.map((l) => l.id) ?? [];
	const justAfter = (groupId: string) => {
		const members = finalOrder.filter((id) => groupOf(r.state, id) === groupId);
		const last = finalOrder.indexOf(members[members.length - 1] ?? '');
		expect(finalOrder[last + 1], msg(`right after ${groupId}`)).toBe(d);
	};

	if (gL !== null && gL === gR && gL !== own) {
		if (hides(gL)) {
			expect(final, msg('rule 4 (middle)')).toBe(ownAlone ? own : null);
			justAfter(gL);
			return { outcome: 'after-collapsed', next: after, state: r.state };
		}
		expect(final, msg('rule 1')).toBe(gL);
		return { outcome: 'joined-middle', next: after, state: r.state };
	}
	if (intent.afterGroupId !== undefined) {
		expect(final, msg('rule 4 (chip)')).toBe(ownAlone ? own : null);
		justAfter(intent.afterGroupId);
		return { outcome: 'after-collapsed', next: after, state: r.state };
	}
	// The tab is where Obsidian put it.
	expect(finalOrder, msg('not moved by the plugin')).toEqual(order);
	if (gL !== null && gL === gR && gL === own) {
		// Dropped back inside its own group's run.
		expect(final, msg('own run')).toBe(own);
		return { outcome: 'kept-own', next: after, state: r.state };
	}
	const h = intent.joinGroupId;
	if (h !== null && !hides(h) && (h === gL || h === gR)) {
		expect(final, msg('rule 2 (join)')).toBe(h);
		return { outcome: 'joined-boundary', next: after, state: r.state };
	}
	if (ownAlone) {
		expect(final, msg('one-tab group moves with its tab')).toBe(own);
		return { outcome: 'kept-own', next: after, state: r.state };
	}
	expect(final, msg('rules 2, 3, 5 (stays out)')).toBeNull();
	return { outcome: 'stayed-out', next: after, state: r.state };
}

/**
 * A drop Obsidian does not move (the tab released next to itself, on the side it already is; L7
 * review round 2). The rules, from the pointer and the tab's neighbours:
 * - on a collapsed (hiding) group's chip: rule 4, the tab goes to just after that group, ungrouped;
 * - on the chip or a member of a group it touches, other than its own: rule 2, joins it in place;
 * - otherwise, not over its own group (an ungrouped neighbour, the empty end): rules 2 and 3, leaves
 *   its group in place, unless that group is just this tab (it moves with its tab elsewhere too);
 * - pinned tabs and drops on itself or its own group change nothing.
 */
function checkInPlace(s: Snapshot, st: GroupState, target: DropTarget, msg: (what: string) => string): DropCheck {
	const prediction = predictDrop(st, s, target);
	const r = dropInPlace(st, s, target);
	const after = applyOps(s, r?.ops ?? [], () => 'never');
	const state = r?.state ?? st;
	expect(invariants(after, state), msg('in place: invariants')).toEqual([]);
	expect(reconcile(after, after, state).ops, msg('in place: settled')).toEqual([]);
	const d = target.leafId;
	const final = groupOf(state, d);
	expect(prediction.groupId, msg('in place: highlight = result')).toBe(final);
	for (const m of st.members) {
		if (m.leafId === d) continue;
		expect(groupOf(state, m.leafId), msg(`in place: other tab ${m.leafId} keeps its group`)).toBe(m.groupId);
	}
	for (const g of state.groups) expect(g.collapsed, msg(`in place: group ${g.id} collapsed flag`)).toBe(st.groups.find((x) => x.id === g.id)?.collapsed);

	const pane = s.panes.find((p) => p.id === target.paneId);
	const order = pane?.leaves.map((l) => l.id) ?? [];
	const k = order.indexOf(d);
	const leaf = pane?.leaves[k];
	const own = groupOf(st, d);
	const spot = target.spot;
	const hides = (g: string | null): boolean =>
		g !== null && pane !== undefined && st.groups.find((x) => x.id === g)?.collapsed === true && canHide(pane);
	const unchanged = (outcome: DropCheck['outcome']): DropCheck => {
		expect(r === null || (r.ops.length === 0 && r.state === st), msg('in place: nothing changes')).toBe(true);
		expect(prediction.moves, msg('in place: no move')).toBe(false);
		return { outcome, next: s, state: st };
	};
	if (leaf === undefined || leaf.pinned || (spot.kind === 'tab' && spot.leafId === d)) return unchanged('no-move');
	const pointer = spot.kind === 'chip' ? spot.groupId : spot.kind === 'tab' ? groupOf(st, spot.leafId) : null;
	if (spot.kind === 'chip' && hides(pointer) && pointer !== own) {
		const ownAlone = own !== null && st.members.filter((m) => m.groupId === own).length === 1;
		expect(final, msg('in place: rule 4 (chip)')).toBe(ownAlone ? own : null);
		const finalOrder = after.panes.find((p) => p.id === target.paneId)?.leaves.map((l) => l.id) ?? [];
		const members = finalOrder.filter((id) => groupOf(state, id) === pointer);
		expect(finalOrder[finalOrder.indexOf(members[members.length - 1] ?? '') + 1], msg('in place: right after the collapsed group')).toBe(d);
		expect(prediction.moves, msg('in place: rule 4 moves')).toBe(true);
		return { outcome: 'after-collapsed-in-place', next: after, state };
	}
	expect(layout(after), msg('in place: layout unchanged')).toBe(layout(s));
	const touches = pointer !== null && (groupOf(st, order[k - 1]) === pointer || groupOf(st, order[k + 1]) === pointer);
	if (pointer !== null && pointer !== own && !hides(pointer) && touches) {
		expect(final, msg('in place: rule 2 (join)')).toBe(pointer);
		return { outcome: 'joined-in-place', next: after, state };
	}
	const alone = own !== null && st.members.filter((m) => m.groupId === own).length === 1;
	// Step V5: a gap at the tab's own place is the boundary of its group only when the tab across it is outside.
	const across = spot.kind === 'gap' ? (spot.beforeLeafId === d ? order[k - 1] : spot.beforeLeafId) : undefined;
	const gapInside = spot.kind === 'gap' && across !== undefined && groupOf(st, across) === own;
	if (own !== null && pointer !== own && spot.kind !== 'chip' && !hides(pointer) && !alone && !gapInside) {
		expect(final, msg('in place: rules 2, 3 (leaves)')).toBeNull();
		return { outcome: 'left-in-place', next: after, state };
	}
	return unchanged('no-move');
}
