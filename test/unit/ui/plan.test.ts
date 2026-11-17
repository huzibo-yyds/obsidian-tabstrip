import { describe, expect, it } from 'vitest';
import type { GroupState } from '../../../src/core/types';
import { planDecorations, planKey } from '../../../src/ui/plan';

const strip = (...ids: string[]) => ({ leaves: ids.map((id) => ({ id })) });
const fp = { viewType: 'markdown' };

function state(groups: [string, string, string[]][]): GroupState {
	return {
		groups: groups.map(([id, name]) => ({ id, name, color: 'blue' as const, collapsed: false })),
		members: groups.flatMap(([id, , leaves]) => leaves.map((leafId) => ({ leafId, groupId: id, fingerprint: fp }))).sort((a, b) => (a.leafId < b.leafId ? -1 : 1)),
		tombstones: [],
		nextGroupSeq: 9,
	};
}

describe('planDecorations', () => {
	it('marks members and puts one chip on the first member of each group, with the member count', () => {
		const plan = planDecorations([strip('x', 'a', 'b', 'y', 'c'), strip('d')], state([['g1', 'One', ['a', 'b']], ['g2', '', ['c', 'd']]]));
		expect([...plan.keys()]).toEqual(['a', 'b', 'c', 'd']);
		expect(plan.get('a')?.chip).toEqual({ groupId: 'g1', name: 'One', color: 'blue', count: 2, collapsed: false });
		expect(plan.get('b')?.chip).toBeNull();
		// A group that (transiently) spans two strips gets a chip in each.
		expect(plan.get('c')?.chip?.count).toBe(1);
		expect(plan.get('d')?.chip?.count).toBe(1);
	});

	it('plans nothing without groups and ignores members of unknown groups', () => {
		expect(planDecorations([strip('a')], state([])).size).toBe(0);
		const st = { ...state([['g1', 'G', ['a']]]), members: [{ leafId: 'a', groupId: 'zz', fingerprint: fp }] };
		expect(planDecorations([strip('a')], st).size).toBe(0);
	});

	it('keys change with anything that is drawn', () => {
		const plan = planDecorations([strip('a', 'b')], state([['g1', 'G', ['a', 'b']]]));
		const a = plan.get('a');
		expect(planKey(undefined, '', '')).toBe('');
		expect(planKey(plan.get('b'), '', '')).toBe('g1|blue');
		expect(planKey(a, 'G, 2 tabs', 'light')).not.toBe(planKey(a, 'G, 2 tabs', 'dark'));
		expect(planKey(a, 'G, 2 tabs', 'light')).not.toBe(planKey(a, 'G, 3 tabs', 'light'));
	});

	it('hides the members of a collapsed group, chip holder included, except in stacked strips', () => {
		const st = state([['g1', 'G', ['a', 'b']], ['g2', 'H', ['c']]]);
		const collapsed = { ...st, groups: st.groups.map((g) => (g.id === 'g1' ? { ...g, collapsed: true } : g)) };
		const plan = planDecorations([strip('a', 'b', 'c')], collapsed);
		expect(plan.get('a')).toMatchObject({ collapsed: true, chip: { collapsed: true, count: 2 } });
		expect(plan.get('b')).toMatchObject({ collapsed: true, chip: null });
		expect(plan.get('c')).toMatchObject({ collapsed: false, chip: { collapsed: false } });
		const stacked = planDecorations([{ ...strip('a', 'b'), stacked: true }], collapsed);
		expect(stacked.get('a')).toMatchObject({ collapsed: false, chip: { collapsed: false } });
		expect(stacked.get('b')?.collapsed).toBe(false);
		// The key changes with the collapsed state, so the decoration is written again.
		const open = planDecorations([strip('a', 'b')], st);
		expect(planKey(plan.get('b'), '', '')).not.toBe(planKey(open.get('b'), '', ''));
		expect(planKey(plan.get('a'), 'x', 'light')).not.toBe(planKey(open.get('a'), 'x', 'light'));
	});
});
