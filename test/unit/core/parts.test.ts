/**
 * Smaller building blocks of the core: invariants, op semantics, order helpers.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { invariants } from '../../../src/core/invariants';
import {
	emptyState,
	indexLeaves,
	pickColor,
	pinnedPrefixLength,
	pushTombstones,
	sameState,
	TOMBSTONE_LIMIT,
} from '../../../src/core/model';
import { applyOps, OpError } from '../../../src/core/ops';
import { planReorder, stableSubsequence } from '../../../src/core/sequence';
import type { GroupState, Op } from '../../../src/core/types';
import { at, get } from '../../../src/core/util';
import { Work } from '../../../src/core/work';
import { apply, fp, groups, layout, snap, tomb } from './dsl';

describe('I invariants report every broken rule', () => {
	it('a consistent pair has no violations', () => {
		expect(invariants(snap('A: p* a g1 g2 | B: h1'), groups({ G: 'g1 g2', H: 'h1' }))).toEqual([]);
	});

	it('I1 pinned tabs must be a prefix', () => {
		expect(invariants(snap('A: a p* b'), emptyState())).toEqual([{ kind: 'pinned-not-prefix', paneId: 'A', leafId: 'p' }]);
	});

	it('I2 groups must be contiguous', () => {
		expect(invariants(snap('A: g1 a g2'), groups({ G: 'g1 g2' }))).toEqual([{ kind: 'group-not-contiguous', groupId: 'G' }]);
	});

	it('I3 a group lives in one strip', () => {
		expect(invariants(snap('A: g1 | B: g2'), groups({ G: 'g1 g2' }))).toEqual([{ kind: 'group-spans-panes', groupId: 'G' }]);
	});

	it('I4 no empty groups', () => {
		const st: GroupState = { ...emptyState(), groups: [{ id: 'G', name: '', color: 'grey', collapsed: false }] };
		expect(invariants(snap('A: a'), st)).toEqual([{ kind: 'empty-group', groupId: 'G' }]);
	});

	it('I5 no pinned members', () => {
		expect(invariants(snap('A: g1* g2'), groups({ G: 'g1 g2' }))).toEqual([{ kind: 'pinned-member', leafId: 'g1' }]);
	});

	it('I6 the shown and the active tab are not hidden (unless the strip is stacked)', () => {
		const st = groups({ G: { members: 'g1', collapsed: true } });
		expect(invariants(snap('A: a g1', { active: 'g1' }), st)).toEqual([
			{ kind: 'hidden-current', paneId: 'A', leafId: 'g1' },
			{ kind: 'hidden-active', leafId: 'g1' },
		]);
		expect(invariants(snap('A: a g1', { active: 'g1', stacked: ['A'] }), st)).toEqual([]);
	});

	it('I7 membership only references existing tabs and groups, once each', () => {
		const st: GroupState = {
			...groups({ G: 'a' }),
			members: [
				{ leafId: 'a', groupId: 'G', fingerprint: fp('a') },
				{ leafId: 'a', groupId: 'G', fingerprint: fp('a') },
				{ leafId: 'b', groupId: 'X', fingerprint: fp('b') },
				{ leafId: 'zz', groupId: 'G', fingerprint: fp('zz') },
			],
		};
		expect(invariants(snap('A: a b'), st)).toEqual([
			{ kind: 'duplicate-member', leafId: 'a' },
			{ kind: 'unknown-group', leafId: 'b', groupId: 'X' },
			{ kind: 'unknown-leaf', leafId: 'zz' },
		]);
	});

	it('I8 snapshot and state ids are unique', () => {
		const st: GroupState = {
			...groups({ G: 'a' }),
			groups: [
				{ id: 'G', name: '', color: 'grey', collapsed: false },
				{ id: 'G', name: '', color: 'red', collapsed: false },
			],
		};
		expect(invariants(snap('A: a | B: a'), st)).toEqual([
			{ kind: 'duplicate-leaf', leafId: 'a' },
			{ kind: 'duplicate-group', groupId: 'G' },
		]);
	});
});

describe('O op semantics (applyOps)', () => {
	it('move uses the index after taking the tab out', () => {
		expect(layout(apply(snap('A: a b c d'), [{ kind: 'move', leafId: 'a', paneId: 'A', index: 2 }]))).toBe('A: b c a d');
	});

	it('activate shows a tab; it becomes active only in the focused strip', () => {
		const s = snap('A: a b | B: x y', { active: 'a' });
		const inFocus = apply(s, [{ kind: 'activate', leafId: 'b' }]);
		expect([inFocus.activeLeafId, inFocus.panes[0]?.currentLeafId]).toEqual(['b', 'b']);
		const other = apply(s, [{ kind: 'activate', leafId: 'y' }]);
		expect([other.activeLeafId, other.panes[1]?.currentLeafId]).toEqual(['a', 'y']);
	});

	it('create inserts an empty tab and shows it', () => {
		const out = apply(snap('A: a b', { active: 'a' }), [{ kind: 'create', paneId: 'A', index: 1 }]);
		expect(layout(out)).toBe('A: a n1 b');
		expect(out.activeLeafId).toBe('n1');
		expect(out.panes[0]?.leaves[1]?.fingerprint).toEqual({ viewType: 'empty' });
		const none = apply({ panes: [{ id: 'A', kind: 'main', leaves: [], currentLeafId: null }], activeLeafId: null }, [
			{ kind: 'create', paneId: 'A', index: 0 },
		]);
		expect(none.activeLeafId).toBe('n1');
	});

	it('close shows the right neighbour, else the left one, and keeps stacked flags', () => {
		const s = snap('A: a b c', { active: 'b', stacked: ['A'] });
		const right = apply(s, [{ kind: 'close', leafIds: ['b'] }]);
		expect([right.activeLeafId, right.panes[0]?.stacked]).toEqual(['c', true]);
		const left = apply(snap('A: a b c', { active: 'c' }), [{ kind: 'close', leafIds: ['c'] }]);
		expect(left.activeLeafId).toBe('b');
	});

	it('an emptied pop-out or split goes away; the last main strip gets a new empty tab', () => {
		const popout = apply(snap('A: a | W: w1', { popouts: ['W'], active: 'w1' }), [{ kind: 'close', leafIds: ['w1'] }]);
		expect(layout(popout)).toBe('A: a');
		expect(popout.activeLeafId).toBe('a');
		const split = apply(snap('A: a | B: b', { active: 'a' }), [{ kind: 'close', leafIds: ['b'] }]);
		expect(layout(split)).toBe('A: a');
		const last = apply(snap('A: a', { active: 'a' }), [{ kind: 'close', leafIds: ['a'] }]);
		expect(layout(last)).toBe('A: n1');
		expect(last.activeLeafId).toBe('n1');
	});

	it('closing the last tab of a layout made of pop-outs only leaves nothing active', () => {
		const out = apply(snap('W: w1', { popouts: ['W'] }), [{ kind: 'close', leafIds: ['w1'] }]);
		expect(out).toEqual({ panes: [], activeLeafId: null });
	});

	it.each<[string, Op]>([
		['unknown leaf', { kind: 'activate', leafId: 'zz' }],
		['unknown strip', { kind: 'create', paneId: 'Z', index: 0 }],
		['index out of range', { kind: 'move', leafId: 'a', paneId: 'A', index: 5 }],
		['negative index', { kind: 'create', paneId: 'A', index: -1 }],
		['move to another strip', { kind: 'move', leafId: 'a', paneId: 'B', index: 0 }],
		['close unknown leaf', { kind: 'close', leafIds: ['zz'] }],
	])('rejects %s', (_label, op) => {
		expect(() => apply(snap('A: a b | B: x'), [op])).toThrow(OpError);
	});

	it('does not change its input', () => {
		const s = snap('A: a b c');
		const copy = JSON.stringify(s);
		applyOps(s, [{ kind: 'move', leafId: 'a', paneId: 'A', index: 2 }, { kind: 'close', leafIds: ['b'] }], () => 'x');
		expect(JSON.stringify(s)).toBe(copy);
	});
});

describe('S order helpers', () => {
	it('stableSubsequence finds a longest increasing run and prefers heavier ones', () => {
		// Ties go to the chain found first; weights break ties between equally long chains.
		expect(stableSubsequence([1, 0, 2, 3], () => 0, 4)).toEqual([true, false, true, true]);
		expect(stableSubsequence([1, 0, 2, 3], (j) => (j === 1 ? 1 : 0), 4)).toEqual([false, true, true, true]);
		expect(stableSubsequence([3, 0, 1, 2], (j) => (j === 0 ? 5 : 0), 4)).toEqual([false, true, true, true]);
		expect(stableSubsequence([], () => 0, 0)).toEqual([]);
	});

	it('planReorder reaches the target with a minimal number of moves', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 12 }).chain((n) =>
					fc.tuple(fc.constant(Array.from({ length: n }, (_, i) => `t${String(i)}`)), fc.shuffledSubarray(Array.from({ length: n }, (_, i) => `t${String(i)}`), { minLength: n, maxLength: n })),
				),
				([current, target]) => {
					const ops = planReorder('A', current, target);
					const s = { panes: [{ id: 'A', kind: 'main' as const, leaves: current.map((id) => ({ id, pinned: false, fingerprint: fp(id) })), currentLeafId: null }], activeLeafId: null };
					const out = applyOps(s, ops, () => 'x');
					expect(out.panes[0]?.leaves.map((l) => l.id)).toEqual(target);
					// Minimal: n minus the longest common subsequence.
					const pos = new Map(target.map((id, i) => [id, i]));
					const keep = stableSubsequence(current.map((id) => pos.get(id) ?? 0), () => 0, target.length);
					expect(ops).toHaveLength(keep.filter((k) => !k).length);
				},
			),
			{ numRuns: 1000 },
		);
	});

	it('planReorder rejects a target that is not a permutation', () => {
		expect(() => planReorder('A', ['a', 'b'], ['a', 'c'])).toThrow(RangeError);
		expect(() => planReorder('A', ['a'], ['a', 'b'])).toThrow(RangeError);
	});
});

describe('M model helpers', () => {
	it('pinnedPrefixLength counts leading pinned tabs only', () => {
		const pinned = (id: string) => id.startsWith('p');
		expect(pinnedPrefixLength(['p1', 'p2', 'a', 'p3'], pinned)).toBe(2);
		expect(pinnedPrefixLength(['p1'], pinned)).toBe(1);
		expect(pinnedPrefixLength([], pinned)).toBe(0);
	});

	it('indexLeaves keeps the first place of a duplicated id', () => {
		const map = indexLeaves(snap('A: a b | B: a'));
		expect(map.get('a')?.pane.id).toBe('A');
		expect(map.size).toBe(2);
	});

	it('pickColor takes the least used color in Chrome order', () => {
		expect(pickColor([])).toBe('grey');
		expect(pickColor(groups({ A: { members: 'a', color: 'grey' } }).groups)).toBe('blue');
	});

	it('pushTombstones keeps the newest TOMBSTONE_LIMIT entries but a whole batch', () => {
		const old = Array.from({ length: TOMBSTONE_LIMIT }, (_, i) => tomb({ leafId: `o${String(i)}`, groupId: 'G', paneId: 'A' }));
		const ring = pushTombstones(old, [tomb({ leafId: 'n', groupId: 'G', paneId: 'A' })]);
		expect(ring).toHaveLength(TOMBSTONE_LIMIT);
		expect(ring[0]?.leafId).toBe('n');
		expect(pushTombstones(old, [])).toEqual(old);
	});

	it('sameState compares structure', () => {
		const a = groups({ G: 'g1' });
		expect(sameState(a, groups({ G: 'g1' }))).toBe(true);
		expect(sameState(a, groups({ G: { members: 'g1', collapsed: true } }))).toBe(false);
		expect(sameState(a, groups({ G: 'g2' }))).toBe(false);
		expect(sameState(a, { ...a, nextGroupSeq: 7 })).toBe(false);
	});

	it('checked access throws on a miss (a bug in the model, never a silent default)', () => {
		expect(() => at<number>([], 0)).toThrow(RangeError);
		expect(() => get(new Map<string, number>(), 'k')).toThrow(RangeError);
		expect(() => new Work(snap('A: a'), emptyState()).span('nope')).toThrow(RangeError);
	});

	it('Work ignores duplicate strips, tabs, groups and memberships in its input', () => {
		const s = snap('A: a b | A: c | B: a');
		const st: GroupState = {
			...groups({ G: 'a' }),
			groups: [
				{ id: 'G', name: 'first', color: 'grey', collapsed: false },
				{ id: 'G', name: 'second', color: 'red', collapsed: false },
			],
			members: [
				{ leafId: 'a', groupId: 'G', fingerprint: fp('a') },
				{ leafId: 'a', groupId: 'H', fingerprint: fp('a') },
			],
		};
		const w = new Work(s, st);
		expect([...w.orders.entries()]).toEqual([
			['A', ['a', 'b']],
			['B', []],
		]);
		expect(w.groups.get('G')?.name).toBe('first');
		expect(w.memberOf.get('a')).toBe('G');
	});
});

describe('public entry point', () => {
	it('src/core/index.ts exports the model API', async () => {
		const api = await import('../../../src/core/index');
		expect(Object.keys(api).sort()).toEqual(
			[
				'GROUP_COLORS',
				'OpError',
				'TOMBSTONE_LIMIT',
				'addToGroup',
				'applyOps',
				'closeGroup',
				'collapseOthers',
				'colorForNewGroup',
				'createGroup',
				'dropRevived',
				'emptyState',
				'invariants',
				'isGroupColor',
				'isHidden',
				'pickColor',
				'recolorGroup',
				'reconcile',
				'removeFromGroup',
				'renameGroup',
				'setCollapsed',
				'stepVisible',
				'ungroup',
				'MIGRATIONS',
				'SESSION_LIMITS',
				'SESSION_VERSION',
				'STRIP_WIDTH',
				'buildSession',
				'clampStripWidth',
				'parseSession',
				'restoreSession',
				'restoreUnmatched',
				'windowOf',
				'withoutLeaves',
				'DROP_TTL_MS',
				'dropAfterCollapsed',
				'dropInPlace',
				'dropIntentOf',
				'dropMoved',
				'dropUse',
				'landing',
				'movedSnapshot',
				'orientationOf',
				'storedColors',
				'stripPrefsOf',
				'predictDrop',
				'spotAt',
				'stepTarget',
			].sort(),
		);
		expect(api.GROUP_COLORS).toHaveLength(9);
	});
});
