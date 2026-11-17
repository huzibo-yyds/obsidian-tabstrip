import { describe, expect, it } from 'vitest';
import type { GroupState } from '../../../src/core/types';
import { looksLikeVerticalTabs, planVerticalRows, rowKey, type VStripInput } from '../../../src/ui/vplan';

const fp = { viewType: 'markdown' };
const strip = (paneId: string, ids: string[], current: string | null, kind: 'main' | 'popout' = 'main', pinned: string[] = []): VStripInput => ({
	paneId,
	kind,
	currentLeafId: current,
	leaves: ids.map((id) => ({ id, info: { pinned: pinned.includes(id) } })),
});
const state: GroupState = {
	groups: [
		{ id: 'g1', name: 'One', color: 'red', collapsed: false },
		{ id: 'g2', name: '', color: 'cyan', collapsed: true },
	],
	members: [
		{ leafId: 'b', groupId: 'g1', fingerprint: fp },
		{ leafId: 'c', groupId: 'g1', fingerprint: fp },
		{ leafId: 'e', groupId: 'g2', fingerprint: fp },
		{ leafId: 'z', groupId: 'gone', fingerprint: fp },
	],
	tombstones: [],
	nextGroupSeq: 3,
};

describe('planVerticalRows', () => {
	it('lists the root split tabs pane after pane, in tab order, without pop-out tabs', () => {
		const rows = planVerticalRows([strip('p1', ['a', 'b', 'c'], 'b'), strip('p9', ['x'], 'x', 'popout'), strip('p2', ['d', 'e'], 'd')], state, 'd');
		expect(rows.map((r) => r.leafId)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(rows.map((r) => r.paneStart)).toEqual([false, false, false, true, false]);
		expect(rows.filter((r) => r.current).map((r) => r.leafId)).toEqual(['b', 'd']);
		expect(rows.filter((r) => r.active).map((r) => r.leafId)).toEqual(['d']);
	});

	it('gives group members their group colour (collapsed groups too: V1 has no group rows yet)', () => {
		const rows = planVerticalRows([strip('p1', ['a', 'b', 'c', 'e', 'z'], 'a', 'main', ['a'])], state, null);
		expect(rows.map((r) => [r.leafId, r.groupId, r.color])).toEqual([
			['a', null, null],
			['b', 'g1', 'red'],
			['c', 'g1', 'red'],
			['e', 'g2', 'cyan'],
			// A member of an unknown group gets no colour.
			['z', null, null],
		]);
		expect(rows[0]?.pinned).toBe(true);
	});

	it('keeps one row highlighted while a sidebar view has the focus (review round 1)', () => {
		const strips = [strip('p1', ['a', 'b'], 'b'), strip('p2', ['d', 'e'], 'e')];
		// The focused leaf is not in the root split: the most recently active root tab stays highlighted.
		expect(planVerticalRows(strips, state, null, 'e').filter((r) => r.active).map((r) => r.leafId)).toEqual(['e']);
		// A focused root tab wins over the recent one.
		expect(planVerticalRows(strips, state, 'a', 'e').filter((r) => r.active).map((r) => r.leafId)).toEqual(['a']);
		// No usable recent tab: the first pane's shown tab.
		expect(planVerticalRows(strips, state, null, 'gone').filter((r) => r.active).map((r) => r.leafId)).toEqual(['b']);
		expect(planVerticalRows(strips, state, null, null).filter((r) => r.active).map((r) => r.leafId)).toEqual(['b']);
	});

	it('skips empty strips, and an empty pane does not count for the separator', () => {
		const rows = planVerticalRows([strip('p0', [], null), strip('p1', ['a'], 'a'), strip('p2', ['b'], 'b')], state, null);
		expect(rows.map((r) => [r.leafId, r.paneStart])).toEqual([
			['a', false],
			['b', true],
		]);
	});

	it('row keys change with every mark that is drawn', () => {
		const base = planVerticalRows([strip('p1', ['b'], 'b')], state, 'b')[0];
		if (!base) throw new Error('no row');
		const variants = [{ ...base, current: false }, { ...base, active: false }, { ...base, pinned: true }, { ...base, paneStart: true }, { ...base, groupId: null, color: null }, { ...base, color: 'blue' as const }];
		for (const v of variants) expect(rowKey(v)).not.toBe(rowKey(base));
		expect(rowKey({ ...base })).toBe(rowKey(base));
	});
});

describe('looksLikeVerticalTabs', () => {
	it('sees an open Vertical Tabs view or one of its vt- body classes', () => {
		expect(looksLikeVerticalTabs(0, ['theme-dark', 'mod-macos'])).toBe(false);
		expect(looksLikeVerticalTabs(1, [])).toBe(true);
		expect(looksLikeVerticalTabs(0, ['vt-scrollable-tabs'])).toBe(true);
		expect(looksLikeVerticalTabs(0, ['is-vt'])).toBe(false);
	});
});
