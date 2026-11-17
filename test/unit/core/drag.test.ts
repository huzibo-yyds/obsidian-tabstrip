/**
 * Step L7: dragging tabs into and out of groups. Example tests per rule (D-rules, see
 * src/core/drag.ts) and property tests against the independent rule oracle (drop-oracle.ts).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	DROP_TTL_MS,
	dropAfterCollapsed,
	dropInPlace,
	dropIntentOf,
	dropMoved,
	dropUse,
	landing,
	movedSnapshot,
	predictDrop,
	spotAt,
	type DropSpot,
	type DropTarget,
	type HeaderBox,
} from '../../../src/core/drag';
import { invariants } from '../../../src/core/invariants';
import { applyOps } from '../../../src/core/ops';
import { reconcile } from '../../../src/core/reconcile';
import type { GroupState, Snapshot } from '../../../src/core/types';
import { group, groups, layout, membership, snap } from './dsl';
import { checkDrop } from './drop-oracle';
import { layoutArb } from './layout-arb';
import { Sim, STEP_KINDS, NATIVE, COMMANDS } from './sim';

const NUM_RUNS = Math.max(1000, Number(process.env['FC_RUNS'] ?? 0) || 0);
const TIMEOUT_MS = Math.max(30_000, NUM_RUNS * 10);

const tab = (leafId: string, side: 'before' | 'after' = 'before'): DropSpot => ({ kind: 'tab', leafId, side });
const chip = (groupId: string): DropSpot => ({ kind: 'chip', groupId });
const empty: DropSpot = { kind: 'empty' };

/** Drops like Obsidian, reconciles with the intent, applies the ops; returns layout and membership. */
function drop(s: Snapshot, st: GroupState, leafId: string, paneId: string, spot: DropSpot) {
	const target: DropTarget = { leafId, paneId, spot };
	const check = checkDrop(s, st, target);
	return { layout: layout(check.next), members: membership(check.state), state: check.state, outcome: check.outcome, predicted: predictDrop(st, s, target) };
}

describe('spotAt: what is under the pointer', () => {
	// a [0,100]  b [100,200]  chip of G [204,240], g1 [244,344]  g2 [344,444]
	const headers: HeaderBox[] = [
		{ leafId: 'a', left: 0, right: 100, hiddenGroupId: null },
		{ leafId: 'b', left: 100, right: 200, hiddenGroupId: null },
		{ leafId: 'g1', left: 244, right: 344, hiddenGroupId: null },
		{ leafId: 'g2', left: 344, right: 444, hiddenGroupId: null },
	];
	const chips = [{ groupId: 'G', left: 204, right: 240 }];

	it('a tab and its half, like Obsidian: the first tab whose end is at or past the pointer', () => {
		expect(spotAt(10, headers, chips)).toEqual(tab('a', 'before'));
		expect(spotAt(60, headers, chips)).toEqual(tab('a', 'after'));
		expect(spotAt(100, headers, chips)).toEqual(tab('a', 'after'));
		expect(spotAt(101, headers, chips)).toEqual(tab('b', 'before'));
		expect(spotAt(400, headers, chips)).toEqual(tab('g2', 'after'));
	});

	it('the chip wins over the gap around it; the gap before a chip belongs to the next tab', () => {
		expect(spotAt(220, headers, chips)).toEqual(chip('G'));
		expect(spotAt(202, headers, chips)).toEqual(tab('g1', 'before'));
	});

	it('past the last tab, or no tab at all: the empty end', () => {
		expect(spotAt(445, headers, chips)).toEqual(empty);
		expect(spotAt(5, [], [])).toEqual(empty);
	});

	it('the zero-width tabs of a collapsed group count as its chip; past them is the next tab', () => {
		// x [0,100], chip of C [104,140], c1 c2 at 144 (width 0), y [144,244]
		const collapsed: HeaderBox[] = [
			{ leafId: 'x', left: 0, right: 100, hiddenGroupId: null },
			{ leafId: 'c1', left: 144, right: 144, hiddenGroupId: 'C' },
			{ leafId: 'c2', left: 144, right: 144, hiddenGroupId: 'C' },
			{ leafId: 'y', left: 144, right: 244, hiddenGroupId: null },
		];
		const c = [{ groupId: 'C', left: 104, right: 140 }];
		expect(spotAt(120, collapsed, c)).toEqual(chip('C'));
		// In the 4px gap between the chip and the hidden tabs: still the collapsed group.
		expect(spotAt(142, collapsed, c)).toEqual(chip('C'));
		expect(spotAt(150, collapsed, c)).toEqual(tab('y', 'before'));
		// A collapsed group at the end: past its hidden tabs is the empty end.
		expect(spotAt(150, collapsed.slice(0, 3), c)).toEqual(empty);
	});
});

describe('spotAt right to left (best effort, L7 review round 1)', () => {
	// Tab order a b c, laid out from the right: a [300,400] b [200,300] c [100,200]; chip of G [404,440] sits before a.
	const rtl: HeaderBox[] = [
		{ leafId: 'a', left: 300, right: 400, hiddenGroupId: null },
		{ leafId: 'b', left: 200, right: 300, hiddenGroupId: null },
		{ leafId: 'c', left: 100, right: 200, hiddenGroupId: null },
	];
	it('the tab under the pointer, and "before" is its right half', () => {
		expect(spotAt(120, rtl, [], true)).toEqual(tab('c', 'after'));
		expect(spotAt(190, rtl, [], true)).toEqual(tab('c', 'before'));
		expect(spotAt(320, rtl, [], true)).toEqual(tab('a', 'after'));
		expect(spotAt(380, rtl, [], true)).toEqual(tab('a', 'before'));
		expect(spotAt(220, rtl, [], true)).toEqual(tab('b', 'after'));
	});
	it('left of the last tab is the empty end; the chip still wins', () => {
		expect(spotAt(50, rtl, [], true)).toEqual(empty);
		expect(spotAt(420, rtl, [{ groupId: 'G', left: 404, right: 440 }], true)).toEqual(chip('G'));
	});
});

describe('a drop applies only to its own move (L7 review round 1)', () => {
	it('dropMoved: another strip, or another place among the tabs both layouts share', () => {
		const prev = snap('A: a x g1 g2 c | B: y');
		expect(dropMoved(prev, snap('A: a g1 g2 c | B: y x'), 'x')).toBe(true);
		expect(dropMoved(prev, snap('A: a g1 x g2 c | B: y'), 'x')).toBe(true);
		// Tabs opened or closed around it do not move it.
		expect(dropMoved(prev, snap('A: x g1 g2 c n | B: y'), 'x')).toBe(false);
		expect(dropMoved(prev, snap('A: n a x g1 g2 c | B: y'), 'x')).toBe(false);
		expect(dropMoved(prev, prev, 'x')).toBe(false);
		// Closed (or never there).
		expect(dropMoved(prev, snap('A: a g1 g2 c | B: y'), 'x')).toBe(true);
		expect(dropMoved(prev, prev, 'zz')).toBe(false);
	});

	it('dropUse: wait for a change, use it only when the tab moved, drop it when old or unrelated', () => {
		const prev = snap('A: a x g1 g2 c');
		const moved = snap('A: a g1 x g2 c');
		const other = snap('A: a x g1 g2 c n');
		expect(dropUse(10, prev, prev, 'x', false)).toBe('wait');
		expect(dropUse(10, prev, moved, 'x', true)).toBe('use');
		expect(dropUse(10, prev, other, 'x', true)).toBe('unmoved');
		expect(dropUse(DROP_TTL_MS + 1, prev, moved, 'x', true)).toBe('expired');
	});

	it('a no-move drop on the left half of a group\'s first member, then a new tab: the new tab is no drop', () => {
		const s = snap('A: a x g1 g2 c', { active: 'x' });
		const st = groups({ G: 'g1 g2' });
		const target: DropTarget = { leafId: 'x', paneId: 'A', spot: tab('g1', 'before') };
		expect(landing(st, s, target)).toBeNull();
		// The drop joins in place (dropInPlace, review round 2) ...
		expect(predictDrop(st, s, target)).toEqual({ groupId: 'G', moves: false });
		// ... but it is never kept for a later pass; were it kept, the next change does not use it.
		const next = snap('A: a x g1 g2 c n', { active: 'n' });
		expect(dropUse(50, s, next, 'x', true)).toBe('unmoved');
		const r = reconcile(s, next, st);
		expect(membership(r.state).x).toBeUndefined();
	});

	it('a no-move drop of a group\'s last tab on the empty end, then another tab closes: that change applies no drop', () => {
		const s = snap('A: a b g1 g2', { active: 'g2' });
		const st = groups({ G: 'g1 g2' });
		const target: DropTarget = { leafId: 'g2', paneId: 'A', spot: empty };
		expect(landing(st, s, target)).toBeNull();
		// The drop itself leaves the group in place (dropInPlace, review round 2) ...
		expect(predictDrop(st, s, target)).toEqual({ groupId: null, moves: false });
		// ... while reconcile of an unrelated change keeps it.
		const next = snap('A: b g1 g2', { active: 'g2' });
		expect(dropUse(50, s, next, 'g2', true)).toBe('unmoved');
		expect(membership(reconcile(s, next, st).state).g2).toBe('G');
	});
});

describe('dropAfterCollapsed: rule 4 when Obsidian does not move the tab (L7 review round 1)', () => {
	const st = groups({ G: { members: 'g1 g2', collapsed: true } });

	it('the tab right before a collapsed group, released on its chip: right after the group, ungrouped, still collapsed', () => {
		const s = snap('A: a x g1 g2 c', { active: 'x' });
		const target: DropTarget = { leafId: 'x', paneId: 'A', spot: chip('G') };
		expect(landing(st, s, target)).toBeNull();
		const r = dropAfterCollapsed(st, s, target);
		expect(r?.ops[0]).toEqual({ kind: 'move', leafId: 'x', paneId: 'A', index: 3 });
		const after = applyOps(s, r?.ops ?? [], () => 'never');
		expect(layout(after)).toBe('A: a g1 g2 x c');
		expect(membership(r?.state ?? st).x).toBeUndefined();
		expect(group(r?.state ?? st, 'G')?.collapsed).toBe(true);
		expect(invariants(after, r?.state ?? st)).toEqual([]);
		expect(reconcile(after, after, r?.state ?? st).ops).toEqual([]);
	});

	it('a member of another group right before it leaves that group', () => {
		const two = groups({ H: 'h1 h2', G: { members: 'g1 g2', collapsed: true } });
		const s = snap('A: h1 h2 g1 g2 c', { active: 'h2' });
		const r = dropAfterCollapsed(two, s, { leafId: 'h2', paneId: 'A', spot: chip('G') });
		const after = applyOps(s, r?.ops ?? [], () => 'never');
		expect(layout(after)).toBe('A: h1 g1 g2 h2 c');
		expect(membership(r?.state ?? two)).toEqual({ h1: 'H', g1: 'G', g2: 'G' });
		expect(invariants(after, r?.state ?? two)).toEqual([]);
	});

	it('not that case: Obsidian moves the tab, the group is expanded, the strip is stacked, the target is not a chip', () => {
		const s = snap('A: a x g1 g2 c', { active: 'x' });
		expect(dropAfterCollapsed(st, s, { leafId: 'a', paneId: 'A', spot: chip('G') })).toBeNull();
		expect(dropAfterCollapsed(groups({ G: 'g1 g2' }), s, { leafId: 'x', paneId: 'A', spot: chip('G') })).toBeNull();
		expect(dropAfterCollapsed(st, snap('A: a x g1 g2 c', { stacked: ['A'] }), { leafId: 'x', paneId: 'A', spot: chip('G') })).toBeNull();
		expect(dropAfterCollapsed(st, s, { leafId: 'x', paneId: 'A', spot: tab('x', 'after') })).toBeNull();
		expect(dropAfterCollapsed(st, s, { leafId: 'x', paneId: 'Z', spot: chip('G') })).toBeNull();
	});
});

describe('dropInPlace: rules 2 and 3 when Obsidian does not move the tab (L7 review round 2)', () => {
	const st = groups({ G: 'g1 g2' });
	const s = snap('A: a x g1 g2 y b', { active: 'x' });
	const settle = (state: GroupState, snapshot: Snapshot, target: DropTarget) => {
		expect(landing(state, snapshot, target)).toBeNull();
		const r = dropInPlace(state, snapshot, target);
		const after = applyOps(snapshot, r?.ops ?? [], () => 'never');
		const out = r?.state ?? state;
		expect(invariants(after, out)).toEqual([]);
		expect(reconcile(after, after, out).ops).toEqual([]);
		// The highlight shows the same group.
		expect(predictDrop(state, snapshot, target).groupId).toBe(membership(out)[target.leafId] ?? null);
		return { layout: layout(after), members: membership(out), state: out, ops: r?.ops ?? [] };
	};

	it("the tab right before an expanded group, released on its chip or its first member's left half, joins as first member", () => {
		for (const spot of [chip('G'), tab('g1', 'before')]) {
			const r = settle(st, s, { leafId: 'x', paneId: 'A', spot });
			expect(r.layout).toBe('A: a x g1 g2 y b');
			expect(r.ops).toEqual([]);
			expect(r.members).toEqual({ x: 'G', g1: 'G', g2: 'G' });
		}
	});

	it("the tab right after it, released on its last member's right half, joins as last member", () => {
		const r = settle(st, s, { leafId: 'y', paneId: 'A', spot: tab('g2', 'after') });
		expect(r.layout).toBe('A: a x g1 g2 y b');
		expect(r.members).toEqual({ g1: 'G', g2: 'G', y: 'G' });
	});

	it("a boundary member released on the facing half of its ungrouped neighbour leaves the group (the chip moves to the next member)", () => {
		const first = settle(st, s, { leafId: 'g1', paneId: 'A', spot: tab('x', 'after') });
		expect(first.members).toEqual({ g2: 'G' });
		const last = settle(st, s, { leafId: 'g2', paneId: 'A', spot: tab('y', 'before') });
		expect(last.members).toEqual({ g1: 'G' });
	});

	it('the last member at the end of the strip, released on the empty end, leaves (outside the group)', () => {
		const end = snap('A: a g1 g2', { active: 'g2' });
		expect(settle(st, end, { leafId: 'g2', paneId: 'A', spot: empty }).members).toEqual({ g1: 'G' });
	});

	it('a member of a neighbouring group moves over to the group under the pointer; a group left empty goes', () => {
		const two = groups({ H: 'h1 h2', G: 'g1 g2' });
		const s2 = snap('A: h1 h2 g1 g2', { active: 'h2' });
		expect(settle(two, s2, { leafId: 'h2', paneId: 'A', spot: chip('G') }).members).toEqual({ h1: 'H', h2: 'G', g1: 'G', g2: 'G' });
		expect(settle(two, s2, { leafId: 'g1', paneId: 'A', spot: tab('h2', 'after') }).members).toEqual({ h1: 'H', h2: 'H', g1: 'H', g2: 'G' });
		const one = groups({ H: 'h1', G: 'g1 g2' });
		const s1 = snap('A: h1 g1 g2', { active: 'h1' });
		const r = settle(one, s1, { leafId: 'h1', paneId: 'A', spot: chip('G') });
		expect(r.members).toEqual({ h1: 'G', g1: 'G', g2: 'G' });
		expect(r.state.groups.map((g) => g.id)).toEqual(['G']);
	});

	it('a collapsed group in a stacked strip hides nothing, so it is joined like an expanded one', () => {
		const c = groups({ G: { members: 'g1 g2', collapsed: true } });
		const stacked = snap('A: a x g1 g2 y', { active: 'x', stacked: ['A'] });
		expect(settle(c, stacked, { leafId: 'x', paneId: 'A', spot: chip('G') }).members).toEqual({ x: 'G', g1: 'G', g2: 'G' });
	});

	it('nothing changes: on itself, on its own group, a one-tab group by an ungrouped neighbour, a pinned tab, a collapsed group (rule 4 is dropAfterCollapsed)', () => {
		const none = (state: GroupState, snapshot: Snapshot, target: DropTarget) => {
			const r = dropInPlace(state, snapshot, target);
			expect(r === null || (r.ops.length === 0 && r.state === state), JSON.stringify(target)).toBe(true);
		};
		none(st, s, { leafId: 'x', paneId: 'A', spot: tab('x', 'after') });
		none(st, s, { leafId: 'g1', paneId: 'A', spot: tab('g1', 'before') });
		none(st, s, { leafId: 'g1', paneId: 'A', spot: chip('G') });
		none(st, s, { leafId: 'g2', paneId: 'A', spot: tab('g1', 'after') });
		none(st, s, { leafId: 'a', paneId: 'A', spot: tab('x', 'before') });
		none(groups({ G: 'g1' }), snap('A: a g1 b'), { leafId: 'g1', paneId: 'A', spot: tab('a', 'after') });
		none(st, snap('A: p* x g1 g2'), { leafId: 'p', paneId: 'A', spot: tab('x', 'before') });
		none(groups({ G: { members: 'g1 g2', collapsed: true } }), snap('A: a x g1 g2 y', { active: 'x' }), { leafId: 'y', paneId: 'A', spot: tab('g2', 'after') });
		// Obsidian moves the tab: reconcile decides, not dropInPlace.
		expect(dropInPlace(st, s, { leafId: 'a', paneId: 'A', spot: chip('G') })).toBeNull();
	});

	it('rule 4 still applies through dropInPlace', () => {
		const c = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = dropInPlace(c, snap('A: a x g1 g2 c', { active: 'x' }), { leafId: 'x', paneId: 'A', spot: chip('G') });
		expect(r?.ops[0]).toEqual({ kind: 'move', leafId: 'x', paneId: 'A', index: 3 });
	});
});

describe('dragging the shown tab out of a strip next to a collapsed group (L7 review round 1)', () => {
	it('the source strip shows its visible neighbour with an activate op; the active tab stays the dropped one', () => {
		// The adapter carries out this op in a strip without the active leaf with selectTabIndex only
		// (no revealLeaf: no window focus, no deferred load); see test/unit/adapter/activate.test.ts.
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const prev = snap('A: a x g1 g2 c | B: y', { active: 'x', popouts: ['B'] });
		const next = snap('A: a g1 g2 c | B: y x', { active: 'x', current: { A: 'g1' }, popouts: ['B'] });
		const r = reconcile(prev, next, st);
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'c' }]);
		const after = applyOps(next, r.ops, () => 'never');
		expect(after.activeLeafId).toBe('x');
		expect(group(r.state, 'G')?.collapsed).toBe(true);
	});
});

describe('landing: where Obsidian inserts the tab', () => {
	const s = snap('A: a b g1 g2 c | B: x y');
	const st = groups({ G: 'g1 g2' });

	it('before or after the tab under the pointer, counted without the dragged tab', () => {
		expect(landing(st, s, { leafId: 'a', paneId: 'A', spot: tab('g1', 'before') })).toBe(1);
		expect(landing(st, s, { leafId: 'a', paneId: 'A', spot: tab('g1', 'after') })).toBe(2);
		expect(landing(st, s, { leafId: 'c', paneId: 'A', spot: tab('a', 'before') })).toBe(0);
		expect(landing(st, s, { leafId: 'a', paneId: 'A', spot: empty })).toBe(4);
	});

	it('a chip means before the group\'s first tab', () => {
		expect(landing(st, s, { leafId: 'c', paneId: 'A', spot: chip('G') })).toBe(2);
		expect(landing(st, s, { leafId: 'x', paneId: 'A', spot: chip('G') })).toBe(2);
	});

	it('no move when the tab would land where it is; unknown targets', () => {
		expect(landing(st, s, { leafId: 'a', paneId: 'A', spot: tab('a', 'after') })).toBeNull();
		expect(landing(st, s, { leafId: 'a', paneId: 'A', spot: tab('b', 'before') })).toBeNull();
		expect(landing(st, s, { leafId: 'g1', paneId: 'A', spot: chip('G') })).toBeNull();
		expect(landing(st, s, { leafId: 'a', paneId: 'Z', spot: empty })).toBeNull();
		expect(landing(st, s, { leafId: 'a', paneId: 'A', spot: tab('nope') })).toBeNull();
		expect(landing(st, s, { leafId: 'a', paneId: 'B', spot: chip('G') })).toBeNull();
	});

	it('another strip: the index as is', () => {
		expect(landing(st, s, { leafId: 'a', paneId: 'B', spot: tab('y', 'after') })).toBe(2);
	});

	it('movedSnapshot: the tab becomes shown and active; its old strip shows its neighbour', () => {
		const moved = movedSnapshot(snap('A: a b c | B: x', { active: 'b' }), 'b', 'B', 0);
		expect(moved && layout(moved)).toBe('A: a c | B: b x');
		expect(moved?.activeLeafId).toBe('b');
		expect(moved?.panes.map((p) => p.currentLeafId)).toEqual(['c', 'b']);
		expect(movedSnapshot(s, 'nope', 'A', 0)).toBeNull();
		expect(movedSnapshot(s, 'a', 'Z', 0)).toBeNull();
	});
});

describe('dropIntentOf', () => {
	const s = snap('A: a g1 g2 c1 c2 b');
	const st = groups({ G: 'g1 g2', C: { members: 'c1 c2', collapsed: true } });
	const intent = (spot: DropSpot) => dropIntentOf(st, s, { leafId: 'a', paneId: 'A', spot });

	it('a member or the chip of an expanded group: that group', () => {
		expect(intent(tab('g2', 'after'))).toEqual({ leafId: 'a', joinGroupId: 'G' });
		expect(intent(chip('G'))).toEqual({ leafId: 'a', joinGroupId: 'G' });
	});

	it('an ungrouped tab, a pinned tab or the empty end: no group', () => {
		expect(intent(tab('b'))).toEqual({ leafId: 'a', joinGroupId: null });
		expect(intent(empty)).toEqual({ leafId: 'a', joinGroupId: null });
	});

	it('a collapsed group: never joined; its chip means "after the group"', () => {
		expect(intent(chip('C'))).toEqual({ leafId: 'a', joinGroupId: null, afterGroupId: 'C' });
		expect(intent(tab('c1'))).toEqual({ leafId: 'a', joinGroupId: null });
	});

	it('in a stacked strip a collapsed group hides nothing, so it is joinable', () => {
		const stacked = snap('A: a g1 g2 c1 c2 b', { stacked: ['A'] });
		expect(dropIntentOf(st, stacked, { leafId: 'a', paneId: 'A', spot: chip('C') })).toEqual({ leafId: 'a', joinGroupId: 'C' });
	});
});

describe('L7 rules on examples (drop like Obsidian, then reconcile with the intent)', () => {
	const st = groups({ G: 'g1 g2 g3' });
	const s = snap('A: a g1 g2 g3 b c');

	it('rule 1: dropped between two members joins, wherever the pointer is', () => {
		const r = drop(s, st, 'c', 'A', tab('g2', 'before'));
		expect(r.layout).toBe('A: a g1 c g2 g3 b');
		expect(r.members.c).toBe('G');
		expect(r.predicted).toEqual({ groupId: 'G', moves: true });
	});

	it('rule 2: at the end boundary, pointer on the last member joins; on the ungrouped neighbour does not', () => {
		const on = drop(s, st, 'c', 'A', tab('g3', 'after'));
		expect(on.layout).toBe('A: a g1 g2 g3 c b');
		expect(on.members.c).toBe('G');
		const off = drop(s, st, 'c', 'A', tab('b', 'before'));
		expect(off.layout).toBe('A: a g1 g2 g3 c b');
		expect(off.members.c).toBeUndefined();
		expect(off.predicted.groupId).toBeNull();
	});

	it('rule 2: at the start boundary, pointer on the chip joins (chip moves to it); on the neighbour does not', () => {
		const on = drop(s, st, 'c', 'A', chip('G'));
		expect(on.layout).toBe('A: a c g1 g2 g3 b');
		expect(on.members.c).toBe('G');
		const first = drop(s, st, 'c', 'A', tab('g1', 'before'));
		expect(first.members.c).toBe('G');
		const off = drop(s, st, 'c', 'A', tab('a', 'after'));
		expect(off.layout).toBe('A: a c g1 g2 g3 b');
		expect(off.members.c).toBeUndefined();
	});

	it('rule 3: dragged out of its group leaves it; the first member moves the chip to the next', () => {
		const r = drop(s, st, 'g1', 'A', tab('c', 'after'));
		expect(r.layout).toBe('A: a g2 g3 b c g1');
		expect(r.members).toEqual({ g2: 'G', g3: 'G' });
		// Its own boundary with the pointer outside: leaves too.
		const edge = drop(s, st, 'g3', 'A', tab('b', 'after'));
		expect(edge.members.g3).toBeUndefined();
		// Within its own run it stays.
		const inside = drop(s, st, 'g1', 'A', tab('g2', 'after'));
		expect(inside.layout).toBe('A: a g2 g1 g3 b c');
		expect(inside.members.g1).toBe('G');
		expect(inside.outcome).toBe('kept-own');
	});

	it('rule 3: a group left empty disappears (its only tab dragged to another strip)', () => {
		const one = groups({ H: 'h' });
		const r = drop(snap('A: a h | B: x'), one, 'h', 'B', tab('x', 'after'));
		expect(r.state.groups).toEqual([]);
	});

	it('rule 4: into the middle of a collapsed group: right after it, ungrouped, group still collapsed', () => {
		const c = groups({ G: { members: 'g1 g2 g3', collapsed: true } });
		// The pointer cannot be over hidden tabs; this is a drop computed elsewhere (another plugin's
		// index, a theme with wider hidden tabs): reconcile moves it out.
		const next = snap('A: a g1 c g2 g3 b', { active: 'c' });
		const r = reconcile(snap('A: a g1 g2 g3 b c', { active: 'c' }), next, c, { dropIntent: { leafId: 'c', joinGroupId: null } });
		const after = applyOps(next, r.ops, () => 'never');
		expect(layout(after)).toBe('A: a g1 g2 g3 c b');
		expect(membership(r.state).c).toBeUndefined();
		expect(group(r.state, 'G')?.collapsed).toBe(true);
		expect(invariants(after, r.state)).toEqual([]);
	});

	it('rule 4: on a collapsed chip: right after the group; on its neighbours: where the line showed', () => {
		const c = groups({ G: { members: 'g1 g2 g3', collapsed: true } });
		const sc = snap('A: a g1 g2 g3 b c', { active: 'a' });
		const onChip = drop(sc, c, 'c', 'A', chip('G'));
		expect(onChip.layout).toBe('A: a g1 g2 g3 c b');
		expect(onChip.members.c).toBeUndefined();
		expect(group(onChip.state, 'G')?.collapsed).toBe(true);
		expect(onChip.outcome).toBe('after-collapsed');
		const before = drop(sc, c, 'c', 'A', tab('a', 'after'));
		expect(before.layout).toBe('A: a c g1 g2 g3 b');
		expect(before.members.c).toBeUndefined();
		const after = drop(sc, c, 'c', 'A', tab('b', 'before'));
		expect(after.layout).toBe('A: a g1 g2 g3 c b');
		expect(after.members.c).toBeUndefined();
		expect(after.predicted.groupId).toBeNull();
	});

	it('rule 4: collapsed groups at the start and at the end of a strip', () => {
		const c = groups({ S: { members: 's1 s2', collapsed: true }, E: { members: 'e1 e2', collapsed: true } });
		const sc = snap('A: s1 s2 a b e1 e2', { active: 'a' });
		expect(drop(sc, c, 'b', 'A', chip('S')).layout).toBe('A: s1 s2 b a e1 e2');
		expect(drop(sc, c, 'a', 'A', chip('E')).layout).toBe('A: s1 s2 b e1 e2 a');
		expect(drop(sc, c, 'a', 'A', empty).layout).toBe('A: s1 s2 b e1 e2 a');
		for (const r of [drop(sc, c, 'b', 'A', chip('S')), drop(sc, c, 'a', 'A', chip('E'))]) {
			expect(r.state.groups.every((g) => g.collapsed)).toBe(true);
			expect(r.members.a ?? r.members.b).toBeUndefined();
		}
	});

	it('rule 5: to another strip leaves the group; joins a group there at its boundary by the pointer', () => {
		const two = groups({ G: 'g1 g2', H: 'h1 h2' });
		const s2 = snap('A: g1 g2 | B: h1 h2 x');
		const out = drop(s2, two, 'g2', 'B', tab('x', 'after'));
		expect(out.layout).toBe('A: g1 | B: h1 h2 x g2');
		expect(out.members).toEqual({ g1: 'G', h1: 'H', h2: 'H' });
		const join = drop(s2, two, 'g2', 'B', tab('h2', 'after'));
		expect(join.members.g2).toBe('H');
		const middle = drop(s2, two, 'g2', 'B', tab('h2', 'before'));
		expect(middle.members.g2).toBe('H');
		const pop = drop(snap('A: g1 g2 | P: y', { popouts: ['P'] }), groups({ G: 'g1 g2' }), 'g1', 'P', empty);
		expect(pop.members).toEqual({ g2: 'G' });
	});

	it('rule 6: a pinned tab never joins; an unpinned tab dropped among pinned tabs is moved back out', () => {
		const sp = snap('A: p* a g1 g2 g3');
		const pinnedIn = drop(sp, st, 'p', 'A', tab('g2', 'before'));
		expect(pinnedIn.members.p).toBeUndefined();
		expect(pinnedIn.outcome).toBe('pinned');
		const intoPinned = drop(snap('A: p* q* g1 g2 g3 a'), st, 'a', 'A', tab('q', 'before'));
		expect(intoPinned.layout).toBe('A: p* q* a g1 g2 g3');
		expect(intoPinned.members.a).toBeUndefined();
	});

	it('a dragged one-tab group moves with its tab within the strip', () => {
		const one = groups({ H: 'h', G: 'g1 g2' });
		const r = drop(snap('A: h a b g1 g2'), one, 'h', 'A', tab('b', 'after'));
		expect(r.members.h).toBe('H');
		const join = drop(snap('A: h a b g1 g2'), one, 'h', 'A', chip('G'));
		expect(join.members.h).toBe('G');
	});

	it('dragging the shown tab out of a strip never opens a collapsed group there (like closing it)', () => {
		const c = groups({ G: { members: 'g1 g2', collapsed: true } });
		const s3 = snap('A: g1 g2 a b | B: x', { active: 'a' });
		const r = drop(s3, c, 'a', 'B', empty);
		expect(group(r.state, 'G')?.collapsed).toBe(true);
		// Obsidian showed b (next to a); the plugin did not change that.
		expect(r.layout).toBe('A: g1 g2 b | B: x a');
		// Only hidden tabs left: the group opens (a strip must show a tab).
		const only = drop(snap('A: g1 g2 a | B: x', { active: 'a' }), c, 'a', 'B', empty);
		expect(group(only.state, 'G')?.collapsed).toBe(false);
	});

	it('no move: nothing changes and the prediction keeps the own group', () => {
		const r = drop(s, st, 'g2', 'A', tab('g2', 'after'));
		expect(r.outcome).toBe('no-move');
		expect(r.predicted).toEqual({ groupId: 'G', moves: false });
	});
});

// ---------------------------------------------------------------- properties

function visibleTabs(s: Snapshot, st: GroupState, paneId?: string): string[] {
	return s.panes
		.filter((p) => paneId === undefined || p.id === paneId)
		.flatMap((p) =>
			p.leaves
				.filter((l) => {
					const g = st.members.find((m) => m.leafId === l.id)?.groupId;
					return !(g !== undefined && st.groups.some((x) => x.id === g && x.collapsed) && p.stacked !== true);
				})
				.map((l) => l.id),
		);
}

/**
 * `aim` steers some drops at the rarer rules, so every outcome is well covered whatever the seed
 * (L7 review round 1: "kept-own" and "joined-middle" came out near 5 per 1000 runs with blind drops):
 * 0: a grouped tab dropped onto a member of its own group (kept-own, or no move);
 * 1: any tab dropped between two members of a group (joined-middle, or rule 4 when collapsed);
 * 2: a tab next to a group boundary released across it without moving (review round 2: joined or
 *    left in place, rule 4 in place);
 * 3: the same, only before collapsed groups, on their chip (rule 4 in place);
 * else: a blind drop anywhere.
 */
const dropArb = fc.record({ dragged: fc.nat(100), pane: fc.nat(10), spotKind: fc.nat(9), pick: fc.nat(100), after: fc.boolean(), aim: fc.nat(7) });

type DropDraw = { dragged: number; pane: number; spotKind: number; pick: number; after: boolean; aim: number };

function aimedTarget(s: Snapshot, st: GroupState, d: DropDraw): DropTarget | null {
	const vis = visibleTabs(s, st);
	if (d.aim === 2 || d.aim === 3) {
		// Review round 2: a visible tab next to a group boundary, released on the far side of that
		// boundary without moving (the neighbour's facing half, or the group's chip). Aim 3 takes only
		// boundaries before a collapsed group (rule 4 in place, the rarest of these).
		const all = s.panes.flatMap((p) =>
			p.leaves.flatMap((l, i) => {
				const r = p.leaves[i + 1];
				if (r === undefined) return [];
				const gl = st.members.find((m) => m.leafId === l.id)?.groupId ?? null;
				const gr = st.members.find((m) => m.leafId === r.id)?.groupId ?? null;
				return gl === gr ? [] : [{ paneId: p.id, left: l.id, right: r.id, gr }];
			}),
		);
		const pairs = d.aim === 2 ? all : all.filter((x) => x.gr !== null && st.groups.some((g) => g.id === x.gr && g.collapsed));
		const pair = pairs[d.pick % Math.max(1, pairs.length)];
		if (pair === undefined) return null;
		if (d.aim === 3) return { leafId: pair.left, paneId: pair.paneId, spot: chip(pair.gr ?? '') };
		if (d.after) return { leafId: pair.right, paneId: pair.paneId, spot: tab(pair.left, 'after') };
		const spot = pair.gr !== null && d.spotKind <= 4 ? chip(pair.gr) : tab(pair.right, 'before');
		return { leafId: pair.left, paneId: pair.paneId, spot };
	}
	if (d.aim === 0) {
		const grouped = vis.filter((id) => st.members.some((m) => m.leafId === id));
		const leafId = grouped[d.dragged % Math.max(1, grouped.length)];
		if (leafId === undefined) return null;
		const groupId = st.members.find((m) => m.leafId === leafId)?.groupId;
		const pane = s.panes.find((p) => p.leaves.some((l) => l.id === leafId));
		if (pane === undefined) return null;
		const order = pane.leaves.map((l) => l.id);
		const mates = order.filter((id) => id !== leafId && st.members.some((m) => m.leafId === id && m.groupId === groupId));
		const mate = mates[d.pick % Math.max(1, mates.length)];
		if (mate === undefined) return { leafId, paneId: pane.id, spot: tab(leafId, d.after ? 'after' : 'before') };
		// The mate's far half (seen from the dragged tab), so the tab moves within its group.
		return { leafId, paneId: pane.id, spot: tab(mate, order.indexOf(mate) < order.indexOf(leafId) ? 'before' : 'after') };
	}
	const leafId = vis[d.dragged % Math.max(1, vis.length)];
	const pane = s.panes[d.pane % s.panes.length];
	if (leafId === undefined || pane === undefined) return null;
	// Between two members of a group in the target strip (the left one's right half).
	const pairs = pane.leaves.flatMap((l, i) => {
		const g = st.members.find((m) => m.leafId === l.id)?.groupId;
		const r = pane.leaves[i + 1];
		return g !== undefined && r !== undefined && st.members.some((m) => m.leafId === r.id && m.groupId === g) ? [l.id] : [];
	});
	const left = pairs[d.pick % Math.max(1, pairs.length)];
	return left === undefined ? null : { leafId, paneId: pane.id, spot: tab(left, 'after') };
}

function targetOf(s: Snapshot, st: GroupState, d: DropDraw): DropTarget | null {
	if (d.aim <= 3) {
		const aimed = aimedTarget(s, st, d);
		if (aimed !== null) return aimed;
	}
	const vis = visibleTabs(s, st);
	const leafId = vis[d.dragged % Math.max(1, vis.length)];
	if (leafId === undefined) return null;
	const pane = s.panes[d.pane % s.panes.length];
	if (pane === undefined) return null;
	const inPane = visibleTabs(s, st, pane.id);
	const groupsHere = st.groups.filter((g) => st.members.some((m) => m.groupId === g.id && pane.leaves.some((l) => l.id === m.leafId)));
	let spot: DropSpot;
	if (d.spotKind <= 2 && groupsHere.length > 0) spot = chip(groupsHere[d.pick % groupsHere.length]?.id ?? '');
	else if (d.spotKind === 3 || inPane.length === 0) spot = empty;
	else spot = tab(inPane[d.pick % inPane.length] ?? '', d.after ? 'after' : 'before');
	return { leafId, paneId: pane.id, spot };
}

describe('L7 properties', () => {
	it(`L7-P1 one drop from any grouped layout follows the rules, and the highlight predicts it (${String(NUM_RUNS)} runs)`, () => {
		const outcomes = new Map<string, number>();
		fc.assert(
			fc.property(layoutArb, dropArb, ({ s, st }, d) => {
				expect(invariants(s, st)).toEqual([]);
				const target = targetOf(s, st, d);
				if (target === null) return;
				const r = checkDrop(s, st, target);
				outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
			}),
			{ numRuns: NUM_RUNS },
		);
		console.info(`L7-P1 outcomes: ${JSON.stringify(Object.fromEntries([...outcomes].sort()))}`);
		// Every rule must actually be exercised, or the property proves little.
		for (const o of ['joined-middle', 'joined-boundary', 'after-collapsed', 'stayed-out', 'kept-own', 'pinned', 'no-move', 'joined-in-place', 'left-in-place', 'after-collapsed-in-place']) {
			expect(outcomes.get(o) ?? 0, o).toBeGreaterThan(NUM_RUNS / 200);
		}
	}, TIMEOUT_MS);

	it(`L7-P2 drag-heavy random sequences keep groups contiguous, in one strip, pinned tabs out and the active tab visible (${String(NUM_RUNS)} runs)`, () => {
		// Half of the steps are drops; the rest create, collapse and expand groups, close, undo-close,
		// split, pin, move to a new window, and so on (the P1 simulator).
		const dropKind = NATIVE.indexOf('drop');
		const weighted = [
			dropKind,
			dropKind,
			dropKind,
			dropKind,
			NATIVE.length + COMMANDS.indexOf('createGroup'),
			NATIVE.length + COMMANDS.indexOf('collapse'),
			NATIVE.length + COMMANDS.indexOf('expand'),
		];
		const stepArb = fc.record({
			kind: fc.oneof(fc.constantFrom(...weighted), fc.integer({ min: 0, max: STEP_KINDS - 1 })),
			a: fc.nat(10_000),
			b: fc.nat(10_000),
			c: fc.nat(10_000),
			d: fc.nat(10_000),
		});
		Sim.stats.clear();
		let steps = 0;
		fc.assert(
			fc.property(
				fc.array(fc.record({ popout: fc.boolean(), size: fc.integer({ min: 2, max: 8 }), pinned: fc.integer({ min: 0, max: 1 }) }), { minLength: 1, maxLength: 3 }),
				fc.array(stepArb, { minLength: 10, maxLength: 50 }),
				(panes, actions) => {
					const sim = new Sim(panes);
					for (const a of actions) {
						sim.step(a);
						steps++;
						// The simulator checks invariants (contiguous groups, one strip per group, no pinned
						// member, no hidden shown or active tab) and idempotency after every step.
						expect(invariants(sim.snapshot, sim.state)).toEqual([]);
					}
				},
			),
			{ numRuns: NUM_RUNS },
		);
		const stats = Object.fromEntries([...Sim.stats].filter(([k]) => k.startsWith('drop')).sort());
		console.info(`L7-P2: ${String(steps)} steps; ${JSON.stringify(stats)}`);
		for (const o of ['joined-middle', 'joined-boundary', 'after-collapsed', 'stayed-out']) expect(Sim.stats.get(`drop:${o}`) ?? 0, o).toBeGreaterThan(20);
		// Review round 2: blind drops in the sequences also hit the in-place rules (about 15-35 times each per 1000 runs).
		for (const o of ['joined-in-place', 'left-in-place']) expect(Sim.stats.get(`drop:${o}`) ?? 0, o).toBeGreaterThan(5);
	}, TIMEOUT_MS);
});
