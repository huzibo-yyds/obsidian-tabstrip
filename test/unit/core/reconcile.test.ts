/**
 * Example tests for the reconcile rules (requirements 5.1, 7.1). Test names start with
 * the rule id used in the maintainer's L3 test report.
 */
import { describe, expect, it } from 'vitest';
import { invariants } from '../../../src/core/invariants';
import { TOMBSTONE_LIMIT } from '../../../src/core/model';
import { reconcile } from '../../../src/core/reconcile';
import type { GroupState, ReconcileContext, Snapshot } from '../../../src/core/types';
import { apply, fp, group, groups, layout, membership, snap, tomb } from './dsl';

/** Reconciles, applies the ops, checks invariants and that a second round is a no-op. */
function run(prev: Snapshot, next: Snapshot, state: GroupState, ctx: ReconcileContext = {}) {
	const result = reconcile(prev, next, state, ctx);
	const after = apply(next, result.ops);
	expect(invariants(after, result.state)).toEqual([]);
	const again = reconcile(next, after, result.state);
	expect(again.ops).toEqual([]);
	expect(again.state).toBe(result.state);
	return { ...result, after };
}

describe('R01 a tab dropped between two members of the same group joins it', () => {
	it('joins when dragged into the middle (drag intent names the tab)', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const r = run(snap('A: a g1 g2 g3 b'), snap('A: g1 g2 a g3 b'), st, {
			dropIntent: { leafId: 'a', joinGroupId: null },
		});
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G', a: 'G', g3: 'G' });
		expect(r.ops).toEqual([]);
	});

	it('joins without an intent when the move is unambiguous', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const r = run(snap('A: a b g1 g2 g3'), snap('A: b g1 a g2 g3'), st);
		expect(membership(r.state).a).toBe('G');
	});

	it('prefers keeping members in place when an adjacent swap is ambiguous', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: a g1 g2'), snap('A: g1 a g2'), st);
		expect(membership(r.state)).toEqual({ g1: 'G', a: 'G', g2: 'G' });
	});

	it('an ambiguous swap at the group end keeps both members (they count more than the non-member)', () => {
		// Either g2 or a moved. Unweighted, "a stayed" ties with "g2 stayed" and g2 would
		// drop out of its group; members weigh more, so the group stays whole and a joins.
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: g1 g2 a'), snap('A: g1 a g2'), st);
		expect(membership(r.state)).toEqual({ g1: 'G', a: 'G', g2: 'G' });
		expect(r.ops).toEqual([]);
	});

	it('a member of another group dropped inside leaves its group and joins', () => {
		const st = groups({ G: 'g1 g2', H: 'h1 h2' });
		const r = run(snap('A: g1 g2 h1 h2'), snap('A: g1 h2 g2 h1'), st, {
			dropIntent: { leafId: 'h2', joinGroupId: 'H' },
		});
		expect(membership(r.state)).toEqual({ g1: 'G', h2: 'G', g2: 'G', h1: 'H' });
	});
});

describe('R02 at a group boundary the drop intent decides', () => {
	const st = groups({ G: 'g1 g2' });

	it('joins at the end when the pointer was on a member or the chip', () => {
		const r = run(snap('A: a g1 g2 b'), snap('A: g1 g2 a b'), st, { dropIntent: { leafId: 'a', joinGroupId: 'G' } });
		expect(membership(r.state).a).toBe('G');
	});

	it('joins at the start the same way', () => {
		const r = run(snap('A: g1 g2 b'), snap('A: b g1 g2'), st, { dropIntent: { leafId: 'b', joinGroupId: 'G' } });
		expect(membership(r.state).b).toBe('G');
		expect(layout(r.after)).toBe('A: b g1 g2');
	});

	it('does not join when the pointer was outside the group', () => {
		const r = run(snap('A: a g1 g2 b'), snap('A: g1 g2 a b'), st, { dropIntent: { leafId: 'a', joinGroupId: null } });
		expect(membership(r.state).a).toBeUndefined();
	});

	it('does not join without an intent', () => {
		const r = run(snap('A: a b g1 g2'), snap('A: b g1 g2 a'), st);
		expect(membership(r.state).a).toBeUndefined();
	});

	it('ignores an intent for a group that is not at this boundary', () => {
		const st2 = groups({ G: 'g1 g2', H: 'h1' });
		const r = run(snap('A: a g1 g2 h1'), snap('A: g1 g2 a h1'), st2, { dropIntent: { leafId: 'a', joinGroupId: 'X' } });
		expect(membership(r.state).a).toBeUndefined();
	});

	it('a member dropped at its own boundary leaves with a null intent and stays with a group intent', () => {
		const prev = snap('A: g1 g2 g3 b');
		const st3 = groups({ G: 'g1 g2 g3' });
		const out = run(prev, prev, st3, { dropIntent: { leafId: 'g3', joinGroupId: null } });
		expect(membership(out.state).g3).toBeUndefined();
		const stay = run(prev, prev, st3, { dropIntent: { leafId: 'g3', joinGroupId: 'G' } });
		expect(stay.state).toBe(st3);
	});

	it('a member at its own boundary stays without an intent', () => {
		const st3 = groups({ G: 'g1 g2 g3' });
		const r = run(snap('A: g1 g2 g3 b'), snap('A: g3 g1 g2 b'), st3);
		expect(r.state).toBe(st3);
	});

	it('between two groups the intent picks the group', () => {
		const st2 = groups({ G: 'g1 g2', H: 'h1 h2' });
		const prev = snap('A: x g1 g2 h1 h2');
		const next = snap('A: g1 g2 x h1 h2');
		expect(membership(run(prev, next, st2, { dropIntent: { leafId: 'x', joinGroupId: 'G' } }).state).x).toBe('G');
		expect(membership(run(prev, next, st2, { dropIntent: { leafId: 'x', joinGroupId: 'H' } }).state).x).toBe('H');
		expect(membership(run(prev, next, st2).state).x).toBeUndefined();
	});

	it('with several free tabs at a boundary the intent pulls the tabs before the dropped one into the group', () => {
		const st2 = groups({ G: 'g1 g2' });
		const r = run(snap('A: g1 g2 b'), snap('A: g1 g2 n1 n2 b'), st2, { dropIntent: { leafId: 'n2', joinGroupId: 'G' } });
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G', n1: 'G', n2: 'G' });
		const right = run(snap('A: a g1 g2'), snap('A: a n1 n2 g1 g2'), st2, { dropIntent: { leafId: 'n1', joinGroupId: 'G' } });
		expect(membership(right.state)).toEqual({ n1: 'G', n2: 'G', g1: 'G', g2: 'G' });
	});
});

describe('R03 a member that leaves its run leaves the group', () => {
	it('dragged far away', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const r = run(snap('A: g1 g2 g3 a b'), snap('A: g2 g3 a b g1'), st);
		expect(membership(r.state)).toEqual({ g2: 'G', g3: 'G' });
		expect(r.ops).toEqual([]);
	});

	it('a dragged one-tab group keeps its group within the strip', () => {
		const st = groups({ G: 'g1' });
		for (const joinGroupId of ['G', null]) {
			const r = run(snap('A: g1 a b'), snap('A: a b g1'), st, { dropIntent: { leafId: 'g1', joinGroupId } });
			expect(r.state).toBe(st);
		}
	});

	it('a dragged one-tab group dropped at another group\'s boundary with that intent joins it', () => {
		const st = groups({ G: 'g1', H: 'h1 h2' });
		const r = run(snap('A: g1 a h1 h2'), snap('A: a h1 h2 g1'), st, { dropIntent: { leafId: 'g1', joinGroupId: 'H' } });
		expect(membership(r.state)).toEqual({ g1: 'H', h1: 'H', h2: 'H' });
		expect(group(r.state, 'G')).toBeUndefined();
	});

	it('a group moved as a whole within the strip stays a group', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: g1 g2 a b c'), snap('A: a b c g1 g2'), st);
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G' });
	});
});

describe('R04 a member moved to another strip leaves the group', () => {
	it('one member of several', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: g1 g2 | B: x'), snap('A: g1 | B: x g2'), st, { dropIntent: { leafId: 'g2', joinGroupId: null } });
		expect(membership(r.state)).toEqual({ g1: 'G' });
	});

	it('the only member: the group is deleted', () => {
		const st = groups({ G: 'g1' });
		const r = run(snap('A: g1 a | B: x'), snap('A: a | B: x g1'), st);
		expect(r.state.groups).toEqual([]);
		expect(r.state.members).toEqual([]);
	});

	it('every member of a multi-tab group moved together: the group follows', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: a g1 g2 | B: x'), snap('A: a | B: x g1 g2'), st);
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G' });
	});

	it('members scattered over several strips all leave', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: a g1 g2 | B: x | C: y'), snap('A: a | B: x g1 | C: y g2'), st);
		expect(r.state.groups).toEqual([]);
	});

	it('can join a group in the new strip at a boundary by intent', () => {
		const st = groups({ G: 'g1 g2', H: 'h1' });
		const r = run(snap('A: g1 g2 | B: h1 x'), snap('A: g1 | B: h1 g2 x'), st, {
			dropIntent: { leafId: 'g2', joinGroupId: 'H' },
		});
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'H', h1: 'H' });
	});
});

describe('R05 a tab landing inside a collapsed group is moved to just after it', () => {
	const st = groups({ G: { members: 'g1 g2 g3', collapsed: true } });

	it('dragged tab goes after the run and stays out of the group', () => {
		const r = run(snap('A: a g1 g2 g3 b', { active: 'a' }), snap('A: g1 a g2 g3 b', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: null },
		});
		expect(r.ops).toEqual([{ kind: 'move', leafId: 'a', paneId: 'A', index: 3 }]);
		expect(layout(r.after)).toBe('A: g1 g2 g3 a b');
		expect(membership(r.state).a).toBeUndefined();
		expect(group(r.state, 'G')?.collapsed).toBe(true);
	});

	it('an intent for the collapsed group does not make it join: it goes after the group, the group stays collapsed (L7 rule 4)', () => {
		// Until step L7 the tab joined as the last member and the group expanded (it is the shown
		// tab). Requirements L7 rule 4: placed right after the group, ungrouped, visible.
		const r = run(snap('A: a g1 g2 g3 b', { active: 'a' }), snap('A: g1 g2 a g3 b', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: 'G' },
		});
		expect(layout(r.after)).toBe('A: g1 g2 g3 a b');
		expect(membership(r.state).a).toBeUndefined();
		expect(group(r.state, 'G')?.collapsed).toBe(true);
	});

	it('an intent for the collapsed group at its boundary does not join either (L7 rule 4)', () => {
		const end = run(snap('A: a g1 g2 g3 b', { active: 'a' }), snap('A: g1 g2 g3 a b', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: 'G' },
		});
		expect(end.ops).toEqual([]);
		expect(membership(end.state).a).toBeUndefined();
		expect(group(end.state, 'G')?.collapsed).toBe(true);
		const start = run(snap('A: g1 g2 g3 b a', { active: 'a' }), snap('A: a g1 g2 g3 b', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: 'G' },
		});
		expect(start.ops).toEqual([]);
		expect(membership(start.state).a).toBeUndefined();
	});

	it('a drop on the collapsed chip puts the tab right after the group (L7 rule 4, afterGroupId)', () => {
		// Obsidian inserts before the first hidden member; the drop line showed right after the chip.
		const r = run(snap('A: x g1 g2 g3 b a', { active: 'a' }), snap('A: x a g1 g2 g3 b', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: null, afterGroupId: 'G' },
		});
		expect(r.ops).toEqual([{ kind: 'move', leafId: 'a', paneId: 'A', index: 4 }]);
		expect(layout(r.after)).toBe('A: x g1 g2 g3 a b');
		expect(membership(r.state).a).toBeUndefined();
		expect(group(r.state, 'G')?.collapsed).toBe(true);
	});

	it('afterGroupId is ignored for an expanded group, a group in another strip, a pinned tab and a stale intent', () => {
		const open = groups({ G: 'g1 g2 g3' });
		const expanded = run(snap('A: x g1 g2 g3 a'), snap('A: x a g1 g2 g3'), open, { dropIntent: { leafId: 'a', joinGroupId: null, afterGroupId: 'G' } });
		expect(expanded.ops).toEqual([]);
		const other = run(snap('A: g1 g2 g3 | B: y a', { active: 'a' }), snap('A: g1 g2 g3 | B: a y', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: null, afterGroupId: 'G' },
		});
		expect(other.ops).toEqual([]);
		const pinned = run(snap('A: a* g1 g2 g3 b', { active: 'a' }), snap('A: a* g1 g2 g3 b', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: null, afterGroupId: 'G' },
		});
		expect(pinned.ops).toEqual([]);
		const stale = run(snap('A: x g1 g2 g3 b a', { active: 'a' }), snap('A: x a g1 g2 g3 b', { active: 'a' }), st, {
			dropIntent: { leafId: 'a', joinGroupId: null, afterGroupId: 'G' },
			txnId: 't1',
		});
		expect(stale.ops).toEqual([]);
		expect(membership(stale.state).a).toBeUndefined();
	});

	it('a new tab opened inside a collapsed group is moved after it too', () => {
		const r = run(snap('A: a g1 g2 g3 b', { active: 'a' }), snap('A: a g1 n1 g2 g3 b', { active: 'a' }), st);
		expect(layout(r.after)).toBe('A: a g1 g2 g3 n1 b');
		expect(membership(r.state).n1).toBeUndefined();
	});

	it('several tabs keep their order after the run', () => {
		const r = run(snap('A: a g1 g2 g3', { active: 'a' }), snap('A: a g1 n1 g2 n2 g3', { active: 'a' }), st);
		expect(layout(r.after)).toBe('A: a g1 g2 g3 n1 n2');
	});

	it('lands after the group\'s own moved members as well', () => {
		const r = run(snap('A: a g1 g2 g3 b', { active: 'a' }), snap('A: a g1 n1 g2 g3 b', { active: 'a' }), st, {
			dropIntent: { leafId: 'g3', joinGroupId: 'G' },
		});
		expect(layout(r.after)).toBe('A: a g1 g2 g3 n1 b');
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G', g3: 'G' });
	});

	it('does not move tabs in a stacked strip: the tab joins instead', () => {
		const r = run(
			snap('A: a g1 g2 g3', { active: 'a', stacked: ['A'] }),
			snap('A: a g1 n1 g2 g3', { active: 'a', stacked: ['A'] }),
			st,
		);
		expect(r.ops).toEqual([]);
		expect(membership(r.state).n1).toBe('G');
	});
});

describe('R06 pinned tabs form a prefix and are never members', () => {
	it('a tab pinned in place moves to the end of the pinned tabs', () => {
		const r = run(snap('A: p* a b c'), snap('A: p* a b c*'), groups({}));
		expect(r.ops).toEqual([{ kind: 'move', leafId: 'c', paneId: 'A', index: 1 }]);
		expect(layout(r.after)).toBe('A: p* c* a b');
	});

	it('a tab unpinned in place moves to just after the pinned tabs and does not rejoin a group', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: p* q* g1 g2'), snap('A: p q* g1 g2'), st);
		expect(layout(r.after)).toBe('A: q* p g1 g2');
		expect(membership(r.state).p).toBeUndefined();
	});

	it('an unpinned tab dragged among pinned tabs is moved back out', () => {
		const r = run(snap('A: p* q* a b'), snap('A: p* b q* a'), groups({}));
		expect(layout(r.after)).toBe('A: p* q* b a');
	});

	it('a pinned tab dragged among unpinned tabs is moved back', () => {
		const r = run(snap('A: p* a b c'), snap('A: a b p* c'), groups({}));
		expect(layout(r.after)).toBe('A: p* a b c');
	});
});

describe('R07 pinning a member takes it out of its group', () => {
	it('removes it, moves it to the pinned area and reports the group', () => {
		const st = groups({ G: { members: 'g1 g2 g3', name: 'Research' } });
		const r = run(snap('A: p* a g1 g2 g3'), snap('A: p* a g1 g2* g3'), st);
		expect(membership(r.state)).toEqual({ g1: 'G', g3: 'G' });
		expect(layout(r.after)).toBe('A: p* g2* a g1 g3');
		expect(r.events).toEqual([{ kind: 'pinned-out', leafId: 'g2', groupId: 'G', groupName: 'Research' }]);
	});

	it('linked tabs pinned together are all reported', () => {
		const st = groups({ G: 'g1 g2', H: 'h1' });
		const r = run(snap('A: g1 g2 | B: h1 x'), snap('A: g1* g2 | B: h1* x'), st);
		expect(r.events.map((e) => e.leafId)).toEqual(['g1', 'h1']);
		expect(membership(r.state)).toEqual({ g2: 'G' });
		expect(group(r.state, 'H')).toBeUndefined();
	});
});

describe('R08 a new tab strictly inside a group joins it', () => {
	const st = groups({ G: 'g1 g2' });

	it('joins between two members', () => {
		const r = run(snap('A: a g1 g2 b'), snap('A: a g1 n1 g2 b'), st);
		expect(membership(r.state).n1).toBe('G');
		expect(r.ops).toEqual([]);
	});

	it('does not join at the end of the group', () => {
		const r = run(snap('A: a g1 g2 b'), snap('A: a g1 g2 n1 b'), st);
		expect(membership(r.state).n1).toBeUndefined();
	});

	it('does not join at the start of the group', () => {
		const r = run(snap('A: a g1 g2 b'), snap('A: a n1 g1 g2 b'), st);
		expect(membership(r.state).n1).toBeUndefined();
	});
});

describe('R09 a tab created by a split in another strip is never grouped', () => {
	it('split right of a member', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: g1 g2'), snap('A: g1 g2 | B: n1', { active: 'n1' }), st);
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G' });
		expect(r.ops).toEqual([]);
	});
});

describe('R10 undo-close puts a member back into its group and slot', () => {
	it('closing a member records a tombstone with group name, color and slot', () => {
		const st = groups({ G: { members: 'g1 g2 g3', name: 'Work', color: 'green' } });
		const r = run(snap('A: a g1 g2 g3'), snap('A: a g1 g3'), st);
		expect(r.state.tombstones).toEqual([
			{
				leafId: 'g2',
				groupId: 'G',
				groupName: 'Work',
				groupColor: 'green',
				paneId: 'A',
				paneIndex: 2,
				indexInGroup: 1,
				fingerprint: fp('g2'),
				left: 'g1',
				right: 'g3',
			},
		]);
	});

	it('the restored tab (same id, at the end) goes back to its slot in the group', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const closed = run(snap('A: a g1 g2 g3 b'), snap('A: a g1 g3 b'), st);
		const restored = run(snap('A: a g1 g3 b'), snap('A: a g1 g3 b g2', { active: 'g2' }), closed.state);
		expect(layout(restored.after)).toBe('A: a g1 g2 g3 b');
		expect(membership(restored.state)).toEqual({ g1: 'G', g2: 'G', g3: 'G' });
		expect(restored.state.tombstones).toEqual([]);
	});

	it('restores the first slot and the last slot', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const first = run(snap('A: a g1 g2 g3 b'), snap('A: a g2 g3 b'), st);
		const back1 = run(snap('A: a g2 g3 b'), snap('A: a g2 g3 b g1'), first.state);
		expect(layout(back1.after)).toBe('A: a g1 g2 g3 b');
		const last = run(snap('A: a g1 g2 g3 b'), snap('A: a g1 g2 b'), st);
		const back3 = run(snap('A: a g1 g2 b'), snap('A: g3 a g1 g2 b'), last.state);
		expect(layout(back3.after)).toBe('A: a g1 g2 g3 b');
		expect(membership(back3.state).g3).toBe('G');
	});

	it('a restored member of a collapsed group stays hidden unless it is shown', () => {
		const st = groups({ G: { members: 'g1 g2 g3', collapsed: true } }, {
			tombstones: [tomb({ leafId: 'g4', groupId: 'G', paneId: 'A', indexInGroup: 1 })],
		});
		const r = run(snap('A: a g1 g2 g3', { active: 'a' }), snap('A: a g1 g2 g3 g4', { active: 'a' }), st);
		expect(layout(r.after)).toBe('A: a g1 g4 g2 g3');
		expect(group(r.state, 'G')?.collapsed).toBe(true);
		const shown = run(snap('A: a g1 g2 g3', { active: 'a' }), snap('A: a g1 g2 g3 g4', { active: 'g4' }), st);
		expect(group(shown.state, 'G')?.collapsed).toBe(false);
	});

	it('a restored tab that is pinned is not regrouped', () => {
		const st = groups({ G: 'g1' }, { tombstones: [tomb({ leafId: 'g2', groupId: 'G', paneId: 'A' })] });
		const r = run(snap('A: g1'), snap('A: g2* g1'), st);
		expect(membership(r.state)).toEqual({ g1: 'G' });
		expect(r.state.tombstones).toEqual([]);
	});

	it('the group moved to another strip meanwhile: the tab stays ungrouped', () => {
		const st = groups({ G: 'g1' }, { tombstones: [tomb({ leafId: 'g2', groupId: 'G', paneId: 'A' })] });
		const r = run(snap('A: a | B: g1'), snap('A: a g2 | B: g1'), st);
		expect(membership(r.state)).toEqual({ g1: 'G' });
	});

	it('a stale tombstone of a tab that never left is dropped', () => {
		const st = groups({ G: 'g1' }, { tombstones: [tomb({ leafId: 'a', groupId: 'G', paneId: 'A' })] });
		const r = run(snap('A: a g1'), snap('A: a g1'), st);
		expect(r.state.tombstones).toEqual([]);
		expect(membership(r.state).a).toBeUndefined();
	});
});

describe('R11 undo-close rebuilds a group that was deleted', () => {
	it('closing every member deletes the group but keeps tombstones; undo rebuilds it in order', () => {
		const st = groups({ G: { members: 'g1 g2', name: 'Docs', color: 'purple' } });
		const s0 = snap('A: a g1 g2 b');
		const closed = run(s0, snap('A: a b'), st);
		expect(closed.state.groups).toEqual([]);
		// Newest first: g2 counts as closed after g1.
		expect(closed.state.tombstones.map((t) => [t.leafId, t.paneIndex, t.indexInGroup])).toEqual([
			['g2', 1, 0],
			['g1', 1, 0],
		]);

		// Native undo-close restores the most recently closed tab first, at the end.
		const back2 = run(snap('A: a b'), snap('A: a b g2', { active: 'g2' }), closed.state);
		expect(layout(back2.after)).toBe('A: a g2 b');
		expect(group(back2.state, 'G')).toEqual({ id: 'G', name: 'Docs', color: 'purple', collapsed: false });
		const back1 = run(back2.after, snap('A: a g2 b g1', { active: 'g1' }), back2.state);
		expect(layout(back1.after)).toBe('A: a g1 g2 b');
		expect(membership(back1.state)).toEqual({ g1: 'G', g2: 'G' });
	});

	it('when the old index falls inside another group it stays where Obsidian put it', () => {
		const st = groups({ H: 'h1 h2 h3' }, { tombstones: [tomb({ leafId: 'x', groupId: 'G', paneId: 'A', paneIndex: 2 })] });
		const r = run(snap('A: a h1 h2 h3'), snap('A: a h1 h2 h3 x'), st);
		expect(layout(r.after)).toBe('A: a h1 h2 h3 x');
		expect(membership(r.state).x).toBe('G');
	});

	it('when the old index is taken by the pinned tabs it goes just after them', () => {
		const st = groups({}, { tombstones: [tomb({ leafId: 'x', groupId: 'G', paneId: 'A', paneIndex: 0 })] });
		const r = run(snap('A: p* q* a'), snap('A: p* q* a x'), st);
		expect(layout(r.after)).toBe('A: p* q* x a');
	});

	it('when both the old index and its current place are inside groups it goes to the end', () => {
		const st = groups({ H: 'h1 h2', K: 'k1 k2' }, {
			tombstones: [tomb({ leafId: 'x', groupId: 'G', paneId: 'A', paneIndex: 1 })],
		});
		const r = run(snap('A: h1 h2 k1 k2'), snap('A: h1 h2 k1 x k2'), st);
		expect(layout(r.after)).toBe('A: h1 h2 k1 k2 x');
		expect(membership(r.state)).toEqual({ h1: 'H', h2: 'H', k1: 'K', k2: 'K', x: 'G' });
	});
});

describe('R12 undo-close into a strip that no longer exists leaves the tab ungrouped', () => {
	it('Obsidian recreates the strip with the old id: still ungrouped', () => {
		const st = groups({ G: 'g1 g2' });
		const closed = run(snap('A: a | B: g1 g2'), snap('A: a'), st);
		expect(closed.state.tombstones).toHaveLength(2);
		const back = run(snap('A: a'), snap('A: a | B: g2', { active: 'g2' }), closed.state);
		expect(back.state.groups).toEqual([]);
		expect(back.state.members).toEqual([]);
	});

	it('undo-closing both members (last closed first) leaves both ungrouped and where Obsidian put them', () => {
		const st = groups({ G: 'g1 g2' });
		const closed = run(snap('A: a | B: g1 g2'), snap('A: a'), st);
		expect(closed.state.tombstones.map((t) => [t.leafId, t.paneId])).toEqual([
			['g2', null],
			['g1', null],
		]);
		const back2 = run(snap('A: a'), snap('A: a | B: g2', { active: 'g2' }), closed.state);
		expect(back2.ops).toEqual([]);
		expect(back2.state.members).toEqual([]);
		// The strip id exists again now, but it is not the strip g1 was closed in.
		const back1 = run(back2.after, snap('A: a | B: g2 g1', { active: 'g1' }), back2.state);
		expect(back1.ops).toEqual([]);
		expect(layout(back1.after)).toBe('A: a | B: g2 g1');
		expect(back1.state.groups).toEqual([]);
		expect(back1.state.members).toEqual([]);
		expect(back1.state.tombstones).toEqual([]);
	});

	it('a member closed earlier whose strip closes later also comes back ungrouped', () => {
		const st = groups({ G: 'g1 g2' });
		const one = run(snap('A: a | B: g1 g2 b'), snap('A: a | B: g2 b'), st);
		expect(one.state.tombstones.map((t) => [t.leafId, t.paneId])).toEqual([['g1', 'B']]);
		// g2 goes to strip A, then strip B closes with its last tab b.
		const moved = run(one.after, snap('A: a g2 | B: b'), one.state);
		const gone = run(moved.after, snap('A: a g2'), moved.state);
		expect(gone.state.tombstones.map((t) => [t.leafId, t.paneId])).toEqual([['g1', null]]);
		// Undo-close brings b back first (Obsidian reuses the id B), then g1 into that strip.
		const backB = run(gone.after, snap('A: a g2 | B: b', { active: 'b' }), gone.state);
		const back = run(backB.after, snap('A: a g2 | B: b g1', { active: 'g1' }), backB.state);
		expect(back.ops).toEqual([]);
		expect(layout(back.after)).toBe('A: a g2 | B: b g1');
		expect(membership(back.state)).toEqual({});
		expect(back.state.groups).toEqual([]);
	});

	it('a tombstone whose strip id is missing from the previous snapshot is treated the same', () => {
		const st = groups({}, { tombstones: [tomb({ leafId: 'x', groupId: 'G', paneId: 'B', paneIndex: 0 })] });
		const r = run(snap('A: a'), snap('A: a | B: y x', { active: 'x' }), st);
		expect(r.ops).toEqual([]);
		expect(r.state.groups).toEqual([]);
		expect(r.state.tombstones).toEqual([]);
	});
});

describe('R13 empty groups are deleted, tombstones are kept', () => {
	it('closing the last member', () => {
		const st = groups({ G: 'g1' });
		const r = run(snap('A: a g1'), snap('A: a'), st);
		expect(r.state.groups).toEqual([]);
		expect(r.state.tombstones.map((t) => t.groupId)).toEqual(['G']);
	});

	it('the ring keeps the newest 25, but never splits one close batch', () => {
		const many = Array.from({ length: 30 }, (_, i) => `t${String(i)}`);
		const st = groups({ G: many.join(' ') });
		const closedAll = run(snap(`A: a | W: ${many.join(' ')}`, { popouts: ['W'] }), snap('A: a'), st);
		expect(closedAll.state.tombstones).toHaveLength(30);
		expect(closedAll.state.tombstones.map((t) => t.leafId)).toEqual([...many].reverse());
		const st2 = groups({ H: 'h1' }, { tombstones: closedAll.state.tombstones });
		const one = run(snap('A: a h1'), snap('A: a'), st2);
		expect(one.state.tombstones).toHaveLength(TOMBSTONE_LIMIT);
		expect(one.state.tombstones[0]?.leafId).toBe('h1');
	});

	it('closing a non-member leaves no tombstone', () => {
		const st = groups({ G: 'g1' });
		const r = run(snap('A: a g1'), snap('A: g1'), st);
		expect(r.state).toBe(st);
	});
});

describe('R14 a broken group is fixed by changing membership, not by moving tabs', () => {
	it('two members moved apart without intent: the moved one leaves', () => {
		const st = groups({ G: 'g1 g2 g3 g4' });
		const r = run(snap('A: g1 g2 g3 g4 a b c'), snap('A: g1 g2 g4 a b g3 c'), st);
		expect(r.ops).toEqual([]);
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G', g4: 'G' });
	});

	it('a tab moved into a group by someone else joins', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const r = run(snap('A: a b c g1 g2 g3'), snap('A: b c g1 g2 a g3'), st);
		expect(r.ops).toEqual([]);
		expect(membership(r.state).a).toBe('G');
	});
});

describe('R15 the shown tab is never hidden', () => {
	it('a hidden member that became active expands its group (no move)', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = run(snap('A: a g1 g2', { active: 'a' }), snap('A: a g1 g2', { active: 'g2' }), st);
		expect(group(r.state, 'G')?.collapsed).toBe(false);
		expect(r.ops).toEqual([]);
	});

	it('also for the shown tab of a strip that is not focused', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = run(
			snap('A: a | B: b g1 g2', { active: 'a', current: { B: 'b' } }),
			snap('A: a | B: b g1 g2', { active: 'a', current: { B: 'g1' } }),
			st,
		);
		expect(group(r.state, 'G')?.collapsed).toBe(false);
	});

	it('closing the shown tab next to a collapsed group shows the nearest visible tab, not the group', () => {
		// Obsidian shows the tab now at the closed tab's index: hidden g1.
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = run(snap('A: a b g1 g2 c', { active: 'b' }), snap('A: a g1 g2 c', { active: 'g1' }), st);
		expect(group(r.state, 'G')?.collapsed).toBe(true);
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'c' }]);
		expect(r.after.activeLeafId).toBe('c');
	});

	it('closing the last tab after a collapsed group goes left past the group', () => {
		// Obsidian shows the new last tab: hidden g2.
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = run(snap('A: a g1 g2 c', { active: 'c' }), snap('A: a g1 g2', { active: 'g2' }), st);
		expect(group(r.state, 'G')?.collapsed).toBe(true);
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'a' }]);
	});

	it('closing the shown tab of a strip that is not focused also skips the group', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = run(
			snap('A: x | B: b g1 g2 c', { active: 'x', current: { B: 'b' } }),
			snap('A: x | B: g1 g2 c', { active: 'x', current: { B: 'g1' } }),
			st,
		);
		expect(group(r.state, 'G')?.collapsed).toBe(true);
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'c' }]);
		expect(r.after.activeLeafId).toBe('x');
	});

	it('when only hidden tabs are left after a close, the group expands', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = run(snap('A: g1 g2 c', { active: 'c' }), snap('A: g1 g2', { active: 'g2' }), st);
		expect(group(r.state, 'G')?.collapsed).toBe(false);
		expect(r.ops).toEqual([]);
	});

	it('a hidden tab chosen on purpose after a close still expands its group', () => {
		// The closed tab was not the shown one: the hidden tab became active for another reason.
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const r = run(snap('A: a b g1 g2 c', { active: 'a' }), snap('A: a g1 g2 c', { active: 'g2' }), st);
		expect(group(r.state, 'G')?.collapsed).toBe(false);
		expect(r.ops).toEqual([]);
	});

	it('collapsed groups in a stacked strip hide nothing', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const s = snap('A: a g1 g2', { active: 'g1', stacked: ['A'] });
		const r = run(s, s, st);
		expect(r.state).toBe(st);
	});
});

describe('R16 a member that opens another file in place stays and its fingerprint follows', () => {
	it('updates the stored fingerprint', () => {
		const st = groups({ G: 'g1 g2' });
		const r = run(snap('A: g1 g2'), snap('A: g1 g2', { paths: { g2: 'other.md' } }), st);
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G' });
		expect(r.state.members.find((m) => m.leafId === 'g2')?.fingerprint).toEqual({ viewType: 'markdown', path: 'other.md' });
	});
});

describe('R17 reconcile is idempotent and returns the same state object when nothing changes', () => {
	it('no change, no ops', () => {
		const st = groups({ G: 'g1 g2', H: { members: 'h1', collapsed: true } });
		const s = snap('A: p* a g1 g2 h1 | B: x');
		const r = reconcile(s, s, st);
		expect(r.ops).toEqual([]);
		expect(r.state).toBe(st);
		expect(r.events).toEqual([]);
	});
});

describe('R18 a change caused by our own ops (txn) ignores a stale drop intent', () => {
	it('the intent would have taken g2 out; with a txn id it is ignored', () => {
		const st = groups({ G: 'g1 g2' });
		const s = snap('A: g1 g2 a');
		const r = reconcile(s, s, st, { dropIntent: { leafId: 'g2', joinGroupId: null }, txnId: 't1' });
		expect(r.state).toBe(st);
	});
});

describe('R19 reconcile repairs a state that breaks the invariants', () => {
	it('drops unknown leaves and groups, pinned members, and keeps the largest run per group', () => {
		const bad: GroupState = {
			groups: [
				{ id: 'G', name: '', color: 'grey', collapsed: false },
				{ id: 'E', name: '', color: 'red', collapsed: false },
			],
			members: [
				{ leafId: 'a', groupId: 'G', fingerprint: fp('a') },
				{ leafId: 'b', groupId: 'G', fingerprint: fp('b') },
				{ leafId: 'd', groupId: 'G', fingerprint: fp('d') },
				{ leafId: 'gone', groupId: 'G', fingerprint: fp('gone') },
				{ leafId: 'p', groupId: 'G', fingerprint: fp('p') },
				{ leafId: 'x', groupId: 'NOPE', fingerprint: fp('x') },
				{ leafId: 'y', groupId: 'G', fingerprint: fp('y') },
			],
			tombstones: [],
			nextGroupSeq: 1,
		};
		const s = snap('A: p* a b c d | B: x y');
		const r = run(s, s, bad);
		expect(membership(r.state)).toEqual({ a: 'G', b: 'G' });
		expect(r.state.groups.map((g) => g.id)).toEqual(['G']);
	});

	it('repairs a group that spans strips from an empty previous snapshot', () => {
		const st = groups({ G: 'a b x' });
		const r = run({ panes: [], activeLeafId: null }, snap('A: a b | B: x'), st);
		expect(membership(r.state)).toEqual({ a: 'G', b: 'G' });
	});
});
