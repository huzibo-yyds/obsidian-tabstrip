/**
 * Example tests for the group commands. Test names start with the rule id
 * used in the maintainer's L3 test report.
 */
import { describe, expect, it } from 'vitest';
import {
	addToGroup,
	closeGroup,
	collapseOthers,
	createGroup,
	recolorGroup,
	removeFromGroup,
	renameGroup,
	setCollapsed,
	ungroup,
} from '../../../src/core/commands';
import { invariants } from '../../../src/core/invariants';
import { emptyState, GROUP_NAME_LIMIT } from '../../../src/core/model';
import { reconcile } from '../../../src/core/reconcile';
import type { CommandResult, GroupColor, GroupState, Snapshot } from '../../../src/core/types';
import { apply, group, groups, layout, membership, snap } from './dsl';

/** Applies the command's ops, checks invariants and that reconcile then has nothing to do. */
function check(before: Snapshot, result: CommandResult): Snapshot {
	const after = apply(before, result.ops);
	expect(invariants(after, result.state)).toEqual([]);
	const again = reconcile(before, after, result.state);
	expect(again.ops).toEqual([]);
	expect(again.state).toBe(result.state);
	return after;
}

describe('C01 createGroup', () => {
	it('groups adjacent tabs in place with an empty name and the first free color', () => {
		const s = snap('A: a b c d');
		const r = createGroup(emptyState(), s, ['b', 'c']);
		expect(r.ops).toEqual([]);
		expect(r.groupId).toBe('g1');
		expect(r.state.groups).toEqual([{ id: 'g1', name: '', color: 'grey', collapsed: false }]);
		expect(membership(r.state)).toEqual({ b: 'g1', c: 'g1' });
		expect(r.state.nextGroupSeq).toBe(2);
		check(s, r);
	});

	it('lines scattered tabs up at the leftmost one', () => {
		const s = snap('A: a b c d e');
		const r = createGroup(emptyState(), s, ['e', 'b', 'd'], { name: 'Read', color: 'cyan' });
		const after = check(s, r);
		expect(layout(after)).toBe('A: a b d e c');
		expect(group(r.state, 'g1')).toEqual({ id: 'g1', name: 'Read', color: 'cyan', collapsed: false });
	});

	it('never splits another group: a tab from inside a group starts the new group after it', () => {
		const st = groups({ H: 'h1 h2 h3' });
		const s = snap('A: a h1 h2 h3 b');
		const r = createGroup(st, s, ['h2', 'b']);
		const after = check(s, r);
		expect(layout(after)).toBe('A: a h1 h3 h2 b');
		expect(membership(r.state)).toEqual({ h1: 'H', h3: 'H', h2: 'g100', b: 'g100' });
	});

	it('picks the least used color', () => {
		const st = groups({ G: { members: 'a', color: 'grey' }, H: { members: 'b', color: 'blue' } });
		const r = createGroup(st, snap('A: a b c'), ['c']);
		expect(group(r.state, 'g100')?.color).toBe('red');
	});

	it('ignores pinned tabs, unknown ids, duplicates and tabs in another strip', () => {
		const s = snap('A: p* a b | B: x');
		const r = createGroup(emptyState(), s, ['p', 'nope', 'a', 'a', 'x']);
		expect(membership(r.state)).toEqual({ a: 'g1' });
		check(s, r);
	});

	it('does nothing when no tab can be grouped', () => {
		const st = emptyState();
		const r = createGroup(st, snap('A: p* a'), ['p', 'zz']);
		expect(r).toEqual({ state: st, ops: [], groupId: null });
		expect(r.state).toBe(st);
	});

	it('an invalid color falls back to the automatic one', () => {
		const r = createGroup(emptyState(), snap('A: a'), ['a'], { color: 'black' as GroupColor });
		expect(group(r.state, 'g1')?.color).toBe('grey');
	});

	it('the group that loses its last member is deleted', () => {
		const st = groups({ H: 'h1' });
		const s = snap('A: h1 a');
		const r = createGroup(st, s, ['h1']);
		expect(r.state.groups.map((g) => g.id)).toEqual(['g100']);
		check(s, r);
	});
});

describe('C02 addToGroup', () => {
	it('appends tabs at the end of the group, from anywhere in the strip and from other groups', () => {
		const st = groups({ G: 'g1 g2', H: 'h1 h2 h3' });
		const s = snap('A: a g1 g2 b h1 h2 h3');
		const r = addToGroup(st, s, ['h2', 'a'], 'G');
		const after = check(s, r);
		expect(layout(after)).toBe('A: g1 g2 a h2 b h1 h3');
		expect(membership(r.state)).toEqual({ g1: 'G', g2: 'G', a: 'G', h2: 'G', h1: 'H', h3: 'H' });
	});

	it('expands a collapsed group when the shown tab is added', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const s = snap('A: g1 g2 a', { active: 'a' });
		const r = addToGroup(st, s, ['a'], 'G');
		expect(group(r.state, 'G')?.collapsed).toBe(false);
		check(s, r);
	});

	it('keeps a collapsed group collapsed when a background tab is added', () => {
		const st = groups({ G: { members: 'g1 g2', collapsed: true } });
		const s = snap('A: a g1 g2 b', { active: 'a' });
		const r = addToGroup(st, s, ['b'], 'G');
		expect(group(r.state, 'G')?.collapsed).toBe(true);
		check(s, r);
	});

	it('ignores tabs of another strip, pinned tabs, members of the group, and unknown groups', () => {
		const st = groups({ G: 'g1' });
		const s = snap('A: p* g1 | B: x');
		expect(addToGroup(st, s, ['x', 'p', 'g1'], 'G').state).toBe(st);
		expect(addToGroup(st, s, ['x'], 'NOPE').state).toBe(st);
	});
});

describe('C03 removeFromGroup', () => {
	it('a middle member moves to just after the group', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const s = snap('A: a g1 g2 g3 b');
		const r = removeFromGroup(st, s, ['g2']);
		const after = check(s, r);
		expect(layout(after)).toBe('A: a g1 g3 g2 b');
		expect(membership(r.state)).toEqual({ g1: 'G', g3: 'G' });
	});

	it('first and last members stay where they are', () => {
		const st = groups({ G: 'g1 g2 g3' });
		const s = snap('A: g1 g2 g3');
		const r = removeFromGroup(st, s, ['g1', 'g3']);
		expect(r.ops).toEqual([]);
		expect(membership(r.state)).toEqual({ g2: 'G' });
		check(s, r);
	});

	it('removing every member deletes the group; tabs from two groups at once', () => {
		const st = groups({ G: 'g1 g2', H: 'h1 h2 h3' });
		const s = snap('A: g1 g2 h1 h2 h3');
		const r = removeFromGroup(st, s, ['g1', 'g2', 'h2', 'x']);
		const after = check(s, r);
		expect(r.state.groups.map((g) => g.id)).toEqual(['H']);
		expect(layout(after)).toBe('A: g1 g2 h1 h3 h2');
	});

	it('does nothing for non-members', () => {
		const st = groups({ G: 'g1' });
		expect(removeFromGroup(st, snap('A: a g1'), ['a', 'zz']).state).toBe(st);
	});
});

describe('C04 renameGroup and recolorGroup', () => {
	const st = groups({ G: 'g1' });

	it('changes name and color only', () => {
		const renamed = renameGroup(st, 'G', '研究 Research');
		expect(group(renamed.state, 'G')?.name).toBe('研究 Research');
		expect(renamed.ops).toEqual([]);
		expect(group(recolorGroup(st, 'G', 'orange').state, 'G')?.color).toBe('orange');
		expect(renameGroup(st, 'G', '').state.groups[0]?.name).toBe('');
	});

	it('cuts a name at GROUP_NAME_LIMIT without splitting a surrogate pair', () => {
		expect(group(renameGroup(st, 'G', 'n'.repeat(GROUP_NAME_LIMIT + 5)).state, 'G')?.name).toBe('n'.repeat(GROUP_NAME_LIMIT));
		const emoji = 'a'.repeat(GROUP_NAME_LIMIT - 1) + '😀';
		expect(group(renameGroup(st, 'G', emoji).state, 'G')?.name).toBe('a'.repeat(GROUP_NAME_LIMIT - 1));
	});

	it('returns the same state for no-ops, unknown groups and invalid colors', () => {
		expect(renameGroup(st, 'G', 'G').state).toBe(st);
		expect(renameGroup(st, 'X', 'y').state).toBe(st);
		expect(recolorGroup(st, 'G', 'black' as GroupColor).state).toBe(st);
	});
});

describe('C05 setCollapsed: collapsing the group with the shown tab picks a visible neighbour', () => {
	it('activates the nearest visible tab to the right', () => {
		const st = groups({ G: 'g1 g2' });
		const s = snap('A: a g1 g2 b c', { active: 'g1' });
		const r = setCollapsed(st, s, 'G', true);
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'b' }]);
		const after = check(s, r);
		expect(after.activeLeafId).toBe('b');
	});

	it('skips other collapsed groups on the right', () => {
		const st = groups({ G: 'g1', H: { members: 'h1 h2', collapsed: true } });
		const s = snap('A: a g1 h1 h2 b', { active: 'g1' });
		expect(setCollapsed(st, s, 'G', true).ops).toEqual([{ kind: 'activate', leafId: 'b' }]);
	});

	it('falls back to the left when nothing on the right is visible', () => {
		const st = groups({ G: 'g1', H: { members: 'h1', collapsed: true } });
		const s = snap('A: p* a g1 h1', { active: 'g1' });
		const r = setCollapsed(st, s, 'G', true);
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'a' }]);
		check(s, r);
	});

	it('a pinned tab on the left counts as visible', () => {
		const st = groups({ G: 'g1' });
		const s = snap('A: p* g1', { active: 'g1' });
		expect(setCollapsed(st, s, 'G', true).ops).toEqual([{ kind: 'activate', leafId: 'p' }]);
	});

	it('creates a new tab at the end when every other tab is hidden', () => {
		const st = groups({ G: 'g1 g2', H: { members: 'h1', collapsed: true } });
		const s = snap('A: h1 g1 g2', { active: 'g2' });
		const r = setCollapsed(st, s, 'G', true);
		expect(r.ops).toEqual([{ kind: 'create', paneId: 'A', index: 3 }]);
		const after = check(s, r);
		expect(layout(after)).toBe('A: h1 g1 g2 n1');
		expect(after.activeLeafId).toBe('n1');
	});

	it('only the strip of the group is affected; another strip keeps focus', () => {
		const st = groups({ G: 'g1 g2' });
		const s = snap('A: a | B: g1 g2 b', { active: 'a', current: { B: 'g2' } });
		const r = setCollapsed(st, s, 'G', true);
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'b' }]);
		const after = check(s, r);
		expect(after.activeLeafId).toBe('a');
		expect(after.panes[1]?.currentLeafId).toBe('b');
	});

	it('no ops when the shown tab is outside the group; expanding needs no ops', () => {
		const st = groups({ G: 'g1 g2' });
		const s = snap('A: a g1 g2', { active: 'a' });
		const collapsed = setCollapsed(st, s, 'G', true);
		expect(collapsed.ops).toEqual([]);
		expect(group(collapsed.state, 'G')?.collapsed).toBe(true);
		const expanded = setCollapsed(collapsed.state, s, 'G', false);
		expect(expanded.ops).toEqual([]);
		expect(group(expanded.state, 'G')?.collapsed).toBe(false);
	});

	it('refuses to collapse in a stacked strip; unknown group or same value is a no-op', () => {
		const st = groups({ G: 'g1' });
		expect(setCollapsed(st, snap('A: a g1', { stacked: ['A'] }), 'G', true).state).toBe(st);
		expect(setCollapsed(st, snap('A: a g1'), 'X', true).state).toBe(st);
		expect(setCollapsed(st, snap('A: a g1'), 'G', false).state).toBe(st);
	});
});

describe('C06 ungroup', () => {
	it('removes the group and keeps the tabs in place', () => {
		const st = groups({ G: 'g1 g2', H: 'h1' });
		const s = snap('A: g1 g2 h1');
		const r = ungroup(st, 'G');
		expect(r.ops).toEqual([]);
		expect(membership(r.state)).toEqual({ h1: 'H' });
		check(s, r);
		expect(ungroup(st, 'X').state).toBe(st);
	});
});

describe('C07 closeGroup', () => {
	it('shows a visible neighbour first, closes the members and tombstones them', () => {
		const st = groups({ G: { members: 'g1 g2', name: 'Docs', color: 'pink' } });
		const s = snap('A: a g1 g2 b', { active: 'g2' });
		const r = closeGroup(st, s, 'G');
		expect(r.ops).toEqual([
			{ kind: 'activate', leafId: 'b' },
			{ kind: 'close', leafIds: ['g1', 'g2'] },
		]);
		expect(r.state.groups).toEqual([]);
		expect(r.state.tombstones.map((t) => [t.leafId, t.groupName, t.groupColor, t.paneIndex, t.indexInGroup])).toEqual([
			['g2', 'Docs', 'pink', 1, 0],
			['g1', 'Docs', 'pink', 1, 0],
		]);
		const after = check(s, r);
		expect(layout(after)).toBe('A: a b');
		expect(after.activeLeafId).toBe('b');
	});

	it('native undo-close (last closed first) rebuilds the group in its old place', () => {
		const st = groups({ G: { members: 'g1 g2 g3', name: 'Docs' } });
		const s0 = snap('A: a g1 g2 g3 b', { active: 'a' });
		const closed = closeGroup(st, s0, 'G');
		let s = check(s0, closed);
		let state = closed.state;
		for (const id of ['g3', 'g2', 'g1']) {
			const reopened = snap(`${layout(s)} ${id}`, { active: id });
			const r = reconcile(s, reopened, state);
			s = apply(reopened, r.ops);
			state = r.state;
			expect(invariants(s, state)).toEqual([]);
		}
		expect(layout(s)).toBe('A: a g1 g2 g3 b');
		expect(membership(state)).toEqual({ g1: 'G', g2: 'G', g3: 'G' });
		expect(group(state, 'G')?.name).toBe('Docs');
	});

	it('when nothing else is visible it leaves the choice of the shown tab to Obsidian', () => {
		const st = groups({ G: 'g1' });
		const r = closeGroup(st, snap('A: g1', { active: 'g1' }), 'G');
		expect(r.ops).toEqual([{ kind: 'close', leafIds: ['g1'] }]);
		expect(closeGroup(st, snap('A: g1'), 'X').state).toBe(st);
	});

	it('no activation when the shown tab is outside the group', () => {
		const st = groups({ G: 'g1' });
		expect(closeGroup(st, snap('A: a g1', { active: 'a' }), 'G').ops).toEqual([{ kind: 'close', leafIds: ['g1'] }]);
	});
});

describe('C08 collapseOthers', () => {
	it('collapses the other expanded groups of the same strip only', () => {
		const st = groups({ G: 'g1', H: 'h1', K: { members: 'k1', collapsed: true }, X: 'x1' });
		const s = snap('A: a g1 h1 k1 | B: x1', { active: 'a' });
		const r = collapseOthers(st, s, 'G');
		expect(r.state.groups.map((g) => [g.id, g.collapsed])).toEqual([
			['G', false],
			['H', true],
			['K', true],
			['X', false],
		]);
		check(s, r);
	});

	it('moves the shown tab out of a group it collapses', () => {
		const st = groups({ G: 'g1', H: 'h1 h2' });
		const s = snap('A: g1 h1 h2', { active: 'h2' });
		const r = collapseOthers(st, s, 'G');
		expect(r.ops).toEqual([{ kind: 'activate', leafId: 'g1' }]);
		check(s, r);
	});

	it('no-ops: nothing to collapse, stacked strip, unknown group', () => {
		const st = groups({ G: 'g1', H: { members: 'h1', collapsed: true } });
		expect(collapseOthers(st, snap('A: g1 h1'), 'G').state).toBe(st);
		expect(collapseOthers(groups({ G: 'g1', H: 'h1' }), snap('A: g1 h1', { stacked: ['A'] }), 'G').ops).toEqual([]);
		expect(collapseOthers(st, snap('A: g1 h1'), 'X').state).toBe(st);
	});
});

describe('commands clean up memberships of tabs that no longer exist', () => {
	it('createGroup drops a stale member', () => {
		const st = groups({ G: 'g1 ghost' });
		const s = snap('A: a g1');
		const r = createGroup(st, s, ['a']);
		expect(membership(r.state)).toEqual({ a: 'g100', g1: 'G' });
		check(s, r);
	});
});

describe('commands keep the input state untouched', () => {
	it('does not mutate its arguments', () => {
		const st: GroupState = groups({ G: 'g1 g2 g3' });
		const s = snap('A: a g1 g2 g3 b');
		const frozen = JSON.stringify([st, s]);
		createGroup(st, s, ['a', 'b']);
		addToGroup(st, s, ['a'], 'G');
		removeFromGroup(st, s, ['g2']);
		setCollapsed(st, s, 'G', true);
		closeGroup(st, s, 'G');
		reconcile(s, snap('A: g1 a g2 b'), st);
		expect(JSON.stringify([st, s])).toBe(frozen);
	});
});
