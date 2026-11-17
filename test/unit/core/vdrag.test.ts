/**
 * Step V5: the core parts of dragging in the vertical strip: the `gap` drop spot (above a group row)
 * and the keyboard's drag (`stepTarget`). Every drop is checked by the L7 rule oracle (drop-oracle.ts).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dropInPlace, dropIntentOf, landing, predictDrop, stepTarget, type DropSpot, type DropTarget } from '../../../src/core/drag';
import { invariants } from '../../../src/core/invariants';
import type { GroupState, Snapshot } from '../../../src/core/types';
import { groups, layout, membership, snap } from './dsl';
import { checkDrop } from './drop-oracle';
import { layoutArb } from './layout-arb';

const NUM_RUNS = Math.max(1000, Number(process.env['FC_RUNS'] ?? 0) || 0);
const TIMEOUT_MS = Math.max(30_000, NUM_RUNS * 10);

const gap = (beforeLeafId: string): DropSpot => ({ kind: 'gap', beforeLeafId });

function drop(s: Snapshot, st: GroupState, target: DropTarget) {
	const check = checkDrop(s, st, target);
	return { layout: layout(check.next), members: membership(check.state), outcome: check.outcome, state: check.state, next: check.next };
}

/** Applies keyboard steps one after another (each through the oracle); returns the last layout and members. */
function steps(s0: Snapshot, st0: GroupState, leafId: string, dirs: readonly (-1 | 1)[]) {
	let s = s0;
	let st = st0;
	const seen: string[] = [];
	for (const dir of dirs) {
		const target = stepTarget(st, s, leafId, dir);
		if (target === null) {
			seen.push('none');
			continue;
		}
		const r = checkDrop(s, st, target);
		s = r.next;
		st = r.state;
		const m = membership(st);
		seen.push(`${layout(s)} ${leafId}:${m[leafId] ?? '-'}`);
	}
	return seen;
}

describe('a drop the rules put straight back (V5 review round 1)', () => {
	it('the tab right after a collapsed group, released on its chip: nothing moves, no drop line', () => {
		const st = groups({ H: { members: 'h1 h2', collapsed: true } });
		const s = snap('A: a h1 h2 x', { active: 'x' });
		const t: DropTarget = { leafId: 'x', paneId: 'A', spot: { kind: 'chip', groupId: 'H' } };
		// Obsidian would put it before the group; rule 4 puts it right back after the group.
		expect(landing(st, s, t)).toBe(1);
		expect(predictDrop(st, s, t)).toEqual({ groupId: null, moves: false });
		const r = drop(s, st, t);
		expect(r.layout).toBe('A: a h1 h2 x');
		expect(r.members).toEqual({ h1: 'H', h2: 'H' });
	});

	it('the same drop of a member of a group after it: the order stays, the tab leaves its group (rule 4)', () => {
		const st = groups({ H: { members: 'h1 h2', collapsed: true }, G: 'x y' });
		const s = snap('A: a h1 h2 x y', { active: 'x' });
		const t: DropTarget = { leafId: 'x', paneId: 'A', spot: { kind: 'chip', groupId: 'H' } };
		expect(predictDrop(st, s, t)).toEqual({ groupId: null, moves: false });
		const r = drop(s, st, t);
		expect(r.layout).toBe('A: a h1 h2 x y');
		expect(r.members.x).toBeUndefined();
	});
});

describe('the gap before a group (above its row in the vertical strip)', () => {
	const st = groups({ G: 'g1 g2' });

	it('lands before the group, outside it, from anywhere', () => {
		const s = snap('A: a b g1 g2 c', { active: 'c' });
		const t: DropTarget = { leafId: 'c', paneId: 'A', spot: gap('g1') };
		expect(landing(st, s, t)).toBe(2);
		expect(dropIntentOf(st, s, t)).toEqual({ leafId: 'c', joinGroupId: null });
		expect(predictDrop(st, s, t)).toEqual({ groupId: null, moves: true });
		const r = drop(s, st, t);
		expect(r.layout).toBe('A: a b c g1 g2');
		expect(r.members).toEqual({ g1: 'G', g2: 'G' });
	});

	it('a group at the start of its strip: the tab goes first, outside it', () => {
		const s = snap('A: g1 g2 a b', { active: 'b' });
		const r = drop(s, st, { leafId: 'b', paneId: 'A', spot: gap('g1') });
		expect(r.layout).toBe('A: b g1 g2 a');
		expect(r.members.b).toBeUndefined();
	});

	it('the first member dragged above its own group row leaves the group in place', () => {
		const s = snap('A: a g1 g2 c', { active: 'g1' });
		const t: DropTarget = { leafId: 'g1', paneId: 'A', spot: gap('g1') };
		expect(landing(st, s, t)).toBeNull();
		expect(predictDrop(st, s, t)).toEqual({ groupId: null, moves: false });
		const r = drop(s, st, t);
		expect(r.outcome).toBe('left-in-place');
		expect(r.layout).toBe('A: a g1 g2 c');
		expect(r.members).toEqual({ g2: 'G' });
	});

	it('the last member of the group before it leaves that group in place', () => {
		const two = groups({ H: 'h1 h2', G: 'g1 g2' });
		const s = snap('A: h1 h2 g1 g2', { active: 'h2' });
		const r = drop(s, two, { leafId: 'h2', paneId: 'A', spot: gap('g1') });
		expect(r.outcome).toBe('left-in-place');
		expect(r.members).toEqual({ h1: 'H', g1: 'G', g2: 'G' });
	});

	it('a gap inside a group never splits it; a one-tab group stays with its tab', () => {
		const s = snap('A: a g1 g2 g3', { active: 'g2' });
		const three = groups({ G: 'g1 g2 g3' });
		expect(dropInPlace(three, s, { leafId: 'g2', paneId: 'A', spot: gap('g2') })).toBeNull();
		expect(dropInPlace(three, s, { leafId: 'g2', paneId: 'A', spot: gap('g3') })).toBeNull();
		const one = groups({ G: 'g1' });
		expect(dropInPlace(one, snap('A: a g1 b'), { leafId: 'g1', paneId: 'A', spot: gap('g1') })).toBeNull();
	});

	it('a collapsed group: the gap before it is outside it too (rule 4 holds)', () => {
		const c = groups({ G: { members: 'g1 g2', collapsed: true } });
		const s = snap('A: a g1 g2 b', { active: 'b' });
		const r = drop(s, c, { leafId: 'b', paneId: 'A', spot: gap('g1') });
		expect(r.layout).toBe('A: a b g1 g2');
		expect(r.members).toEqual({ g1: 'G', g2: 'G' });
	});

	it('into another pane, before a group there: leaves its own group, joins none', () => {
		const two = groups({ H: 'h1 h2', G: 'g1 g2' });
		const s = snap('A: h1 h2 a | B: x g1 g2', { active: 'h2' });
		const r = drop(s, two, { leafId: 'h2', paneId: 'B', spot: gap('g1') });
		expect(r.layout).toBe('A: h1 a | B: x h2 g1 g2');
		expect(r.members).toEqual({ h1: 'H', g1: 'G', g2: 'G' });
	});
});

describe('stepTarget: the keyboard drag (Alt+Arrow Up / Down in the vertical strip)', () => {
	it('an ungrouped tab passes ungrouped tabs; at the ends nothing happens', () => {
		const s = snap('A: a b c', { active: 'b' });
		const st = groups({});
		expect(steps(s, st, 'b', [-1, -1])).toEqual(['A: b a c b:-', 'none']);
		expect(steps(s, st, 'b', [1, 1])).toEqual(['A: a c b b:-', 'none']);
	});

	it('into an expanded group at its edge, through it, and out at the other edge, one step each', () => {
		const s = snap('A: a g1 g2 b', { active: 'a' });
		const st = groups({ G: 'g1 g2' });
		expect(steps(s, st, 'a', [1, 1, 1, 1, 1])).toEqual([
			// joins in place at the start
			'A: a g1 g2 b a:G',
			'A: g1 a g2 b a:G',
			'A: g1 g2 a b a:G',
			// leaves in place at the end
			'A: g1 g2 a b a:-',
			'A: g1 g2 b a a:-',
		]);
		expect(steps(snap('A: a g1 g2 b', { active: 'b' }), st, 'b', [-1, -1, -1, -1, -1])).toEqual([
			'A: a g1 g2 b b:G',
			'A: a g1 b g2 b:G',
			'A: a b g1 g2 b:G',
			'A: a b g1 g2 b:-',
			'A: b a g1 g2 b:-',
		]);
	});

	it('over a collapsed group in one step, never into it', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		expect(steps(snap('A: a g1 g2 b', { active: 'a' }), st, 'a', [1])).toEqual(['A: g1 g2 a b a:-']);
		expect(steps(snap('A: a g1 g2 b', { active: 'b' }), st, 'b', [-1])).toEqual(['A: a b g1 g2 b:-']);
	});

	it('a one-tab group moves with its tab', () => {
		const st = groups({ G: 'g1' });
		expect(steps(snap('A: a g1 b', { active: 'g1' }), st, 'g1', [1, -1, -1])).toEqual(['A: a b g1 g1:G', 'A: a g1 b g1:G', 'A: g1 a b g1:G']);
	});

	it('pinned tabs move among pinned tabs only; an unpinned tab never enters the pinned area', () => {
		const s = snap('A: p1* p2* a b', { active: 'p1' });
		const st = groups({});
		expect(steps(s, st, 'p1', [1, 1])).toEqual(['A: p2* p1* a b p1:-', 'none']);
		expect(steps(snap('A: p1* p2* a b', { active: 'a' }), st, 'a', [-1])).toEqual(['none']);
	});

	it('a member at the start of its strip leaves its group before nothing; a lone end tab stays', () => {
		const st = groups({ G: 'g1 g2' });
		expect(steps(snap('A: g1 g2 a', { active: 'g1' }), st, 'g1', [-1, -1])).toEqual(['A: g1 g2 a g1:-', 'none']);
		expect(steps(snap('A: a g1 g2', { active: 'g2' }), st, 'g2', [1, 1])).toEqual(['A: a g1 g2 g2:-', 'none']);
	});

	it('a tab hidden in a collapsed group has no row: no step', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		expect(stepTarget(st, snap('A: a g1 g2 b', { active: 'a' }), 'g1', 1)).toBeNull();
		// The shown tab of the strip stays visible in its collapsed group and can move.
		expect(stepTarget(st, snap('A: a g1 g2 b', { active: 'g2' }), 'g2', -1)).not.toBeNull();
	});

	it(`V5-P2 any keyboard step from any grouped layout follows the drop rules (${String(NUM_RUNS)} runs)`, () => {
		fc.assert(
			fc.property(layoutArb, fc.nat(100), fc.boolean(), ({ s, st }, pick, up) => {
				const all = s.panes.flatMap((p) => p.leaves.map((l) => l.id));
				const leafId = all[pick % all.length];
				if (leafId === undefined) return;
				const target = stepTarget(st, s, leafId, up ? -1 : 1);
				if (target === null) return;
				const r = checkDrop(s, st, target);
				expect(invariants(r.next, r.state)).toEqual([]);
				// Never into another strip.
				expect(r.next.panes.find((p) => p.leaves.some((l) => l.id === leafId))?.id).toBe(target.paneId);
			}),
			{ numRuns: NUM_RUNS },
		);
	}, TIMEOUT_MS);
});
