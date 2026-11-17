/**
 * Steps V2-V4: the vertical strip's list (pinned area, pane sections, group rows, "New tab"),
 * tree positions, and the keyboard logic. Pure functions only.
 */
import { describe, expect, it } from 'vitest';
import { planVerticalList, itemKey, type VItem, type VListStrip, type VGroupState } from '../../../src/ui/vplan';
import { composing, keyAction, rovingIndex, type VKeyItem } from '../../../src/ui/vkeys';
import { clampStripWidth, parseSession, buildSession, stripPrefsOf, STRIP_WIDTH } from '../../../src/core';
import { emptyState } from '../../../src/core';

const strip = (paneId: string, ids: string[], current: string | null, opts: { pinned?: string[]; deferred?: string[]; kind?: 'main' | 'popout'; stacked?: boolean } = {}): VListStrip => ({
	paneId,
	kind: opts.kind ?? 'main',
	currentLeafId: current,
	...(opts.stacked === true ? { stacked: true } : {}),
	leaves: ids.map((id) => ({ id, info: { pinned: (opts.pinned ?? []).includes(id) }, deferred: (opts.deferred ?? []).includes(id) })),
});
const state = (collapsed = false): VGroupState => ({
	groups: [
		{ id: 'g1', name: 'Work', color: 'blue', collapsed },
		{ id: 'g2', name: '', color: 'orange', collapsed: false },
	],
	members: [
		{ leafId: 'b', groupId: 'g1' },
		{ leafId: 'c', groupId: 'g1' },
		{ leafId: 'e', groupId: 'g2' },
	],
});
const shape = (items: readonly VItem[]) => items.map((i) => (i.kind === 'tab' ? `${String(i.level)}:${i.row.leafId}` : i.kind === 'group' ? `${String(i.level)}:[${i.groupId}]` : `${String(i.level)}:+`));

describe('planVerticalList (step V2)', () => {
	it('one pane: no pinned area without pinned tabs, no pane title, group rows before their members, New tab last', () => {
		const plan = planVerticalList([strip('p1', ['a', 'b', 'c', 'd'], 'a')], state(), 'a');
		expect(plan.sections.map((s) => [s.kind, s.titled])).toEqual([['pane', false]]);
		expect(shape(plan.sections[0]?.items ?? [])).toEqual(['1:a', '1:[g1]', '2:b', '2:c', '1:d', '1:+']);
		const g = plan.sections[0]?.items[1];
		expect(g?.kind === 'group' && [g.name, g.color, g.count, g.collapsed]).toEqual(['Work', 'blue', 2, false]);
		expect(plan.rows.map((r) => r.leafId)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('pinned area first (pinned tabs of every pane, pane order), then one titled section per pane; pop-outs are not listed', () => {
		const plan = planVerticalList([strip('p1', ['a', 'b', 'c'], 'b', { pinned: ['a'] }), strip('px', ['x'], 'x', { kind: 'popout' }), strip('p2', ['p', 'd', 'e'], 'd', { pinned: ['p'] })], state(), 'd');
		expect(plan.sections.map((s) => [s.key, s.titled, s.index])).toEqual([
			['pinned', false, 0],
			['p:p1', true, 1],
			['p:p2', true, 2],
		]);
		expect(shape(plan.sections[0]?.items ?? [])).toEqual(['1:a', '1:p']);
		expect(shape(plan.sections[1]?.items ?? [])).toEqual(['1:[g1]', '2:b', '2:c', '1:+']);
		expect(shape(plan.sections[2]?.items ?? [])).toEqual(['1:d', '1:[g2]', '2:e', '1:+']);
		expect(plan.rows.map((r) => r.leafId)).toEqual(['a', 'p', 'b', 'c', 'd', 'e']);
	});

	it('a collapsed group hides its members (same model as the horizontal strip), never the pane shown tab', () => {
		const hidden = planVerticalList([strip('p1', ['a', 'b', 'c', 'd'], 'a')], state(true), 'a');
		expect(shape(hidden.sections[0]?.items ?? [])).toEqual(['1:a', '1:[g1]', '1:d', '1:+']);
		const group = hidden.sections[0]?.items[1];
		expect(group?.kind === 'group' && [group.collapsed, group.count]).toEqual([true, 2]);
		// The shown tab stays visible even in a collapsed group (the controller expands it right after).
		const shown = planVerticalList([strip('p1', ['a', 'b', 'c', 'd'], 'c')], state(true), 'c');
		expect(shape(shown.sections[0]?.items ?? [])).toEqual(['1:a', '1:[g1]', '2:c', '1:d', '1:+']);
		// Stacked tabs never hide tabs.
		const stacked = planVerticalList([strip('p1', ['a', 'b', 'c', 'd'], 'a', { stacked: true })], state(true), 'a');
		expect(shape(stacked.sections[0]?.items ?? [])).toEqual(['1:a', '1:[g1]', '2:b', '2:c', '1:d', '1:+']);
	});

	it('a collapsed group in a stacked pane reports expanded: its members are listed (review round 3)', () => {
		// Collapse in a normal pane, then the pane gets stacked: stacked panes never hide tabs.
		const stacked = planVerticalList([strip('p1', ['a', 'b', 'c', 'd'], 'a', { stacked: true })], state(true), 'a');
		const items = stacked.sections[0]?.items ?? [];
		const group = items[1];
		expect(group?.kind === 'group' && group.collapsed).toBe(false);
		// The tree agrees: Arrow Right on the group goes to its first listed member, Arrow Left asks to collapse.
		const keys: VKeyItem[] = items.map((i) => (i.kind === 'group' ? { kind: 'group', level: i.level, collapsed: i.collapsed } : { kind: i.kind, level: i.level }));
		expect(keyAction(keys, 1, { key: 'ArrowRight' })).toEqual({ kind: 'focus', index: 2 });
		expect(keyAction(keys, 1, { key: 'ArrowLeft' })).toEqual({ kind: 'collapse' });
		// The drawn marks change with it (the strip redraws the arrow and aria-expanded).
		const plain = planVerticalList([strip('p1', ['a', 'b', 'c', 'd'], 'a')], state(true), 'a').sections[0]?.items[1];
		expect(itemKey(group as VItem, '')).not.toBe(itemKey(plain as VItem, ''));
		expect(plain?.kind === 'group' && plain.collapsed).toBe(true);
	});

	it('tree positions: level 1 counted per section, level 2 per group', () => {
		const plan = planVerticalList([strip('p1', ['a', 'b', 'c', 'd', 'e'], 'a')], state(), 'a');
		const items = plan.sections[0]?.items ?? [];
		expect(items.map((i) => [i.level, i.posinset, i.setsize])).toEqual([
			[1, 1, 5],
			[1, 2, 5],
			[2, 1, 2],
			[2, 2, 2],
			[1, 3, 5],
			[1, 4, 5],
			[2, 1, 1],
			[1, 5, 5],
		]);
	});

	it('deferred tabs are marked, the highlighted tab is marked, and its group holds it', () => {
		const plan = planVerticalList([strip('p1', ['a', 'b', 'c'], 'c', { deferred: ['a'] })], state(), 'c');
		const items = plan.sections[0]?.items ?? [];
		const a = items.find((i) => i.kind === 'tab' && i.row.leafId === 'a');
		expect(a?.kind === 'tab' && a.deferred).toBe(true);
		const g = items.find((i) => i.kind === 'group');
		expect(g?.kind === 'group' && g.holdsActive).toBe(true);
		// The keys change with every mark that is drawn.
		const before = itemKey(a as VItem, '');
		const after = planVerticalList([strip('p1', ['a', 'b', 'c'], 'c')], state(), 'c').sections[0]?.items.find((i) => i.key === 't:a');
		expect(itemKey(after as VItem, '')).not.toBe(before);
	});

	it('no tabs: no sections', () => {
		expect(planVerticalList([], state(), null)).toEqual({ sections: [], rows: [] });
	});
});

describe('keyAction (step V4)', () => {
	const items: VKeyItem[] = [
		{ kind: 'tab', level: 1 },
		{ kind: 'group', level: 1, collapsed: false },
		{ kind: 'tab', level: 2 },
		{ kind: 'tab', level: 2 },
		{ kind: 'group', level: 1, collapsed: true },
		{ kind: 'new', level: 1 },
	];
	const k = (index: number, key: string, mods: Record<string, unknown> = {}) => keyAction(items, index, { key, ...mods });

	it('arrows, Home and End move the focus, clamped at the ends', () => {
		expect(k(0, 'ArrowDown')).toEqual({ kind: 'focus', index: 1 });
		expect(k(5, 'ArrowDown')).toEqual({ kind: 'focus', index: 5 });
		expect(k(0, 'ArrowUp')).toEqual({ kind: 'focus', index: 0 });
		expect(k(3, 'Home')).toEqual({ kind: 'focus', index: 0 });
		expect(k(1, 'End')).toEqual({ kind: 'focus', index: 5 });
	});
	it('Arrow Right / Left follow the tree pattern', () => {
		expect(k(4, 'ArrowRight')).toEqual({ kind: 'expand' });
		expect(k(1, 'ArrowRight')).toEqual({ kind: 'focus', index: 2 });
		expect(k(1, 'ArrowLeft')).toEqual({ kind: 'collapse' });
		expect(k(4, 'ArrowLeft')).toBeNull();
		expect(k(3, 'ArrowLeft')).toEqual({ kind: 'focus', index: 1 });
		expect(k(0, 'ArrowLeft')).toBeNull();
	});
	it('Enter, Space, Delete, F2 and the menu keys', () => {
		expect(k(0, 'Enter')).toEqual({ kind: 'activate' });
		expect(k(1, 'Enter')).toEqual({ kind: 'toggle' });
		expect(k(5, 'Enter')).toEqual({ kind: 'newTab' });
		expect(k(1, ' ')).toEqual({ kind: 'toggle' });
		expect(k(0, ' ')).toEqual({ kind: 'activate' });
		expect(k(0, 'Delete')).toEqual({ kind: 'close' });
		expect(k(1, 'Delete')).toBeNull();
		expect(k(1, 'F2')).toEqual({ kind: 'rename' });
		expect(k(2, 'F2')).toEqual({ kind: 'rename' });
		expect(k(0, 'F2')).toBeNull();
		expect(k(0, 'F10', { shiftKey: true })).toEqual({ kind: 'menu' });
		expect(k(1, 'ContextMenu')).toEqual({ kind: 'menu' });
		expect(k(0, 'F10')).toBeNull();
	});
	it('IME composition and modifier keys never trigger anything', () => {
		expect(k(0, 'Enter', { isComposing: true })).toBeNull();
		expect(k(0, 'Process')).toBeNull();
		expect(k(0, 'Enter', { keyCode: 229 })).toBeNull();
		expect(composing({ key: 'a', isComposing: true })).toBe(true);
		expect(k(0, 'ArrowDown', { metaKey: true })).toBeNull();
		expect(k(0, 'Delete', { ctrlKey: true })).toBeNull();
		expect(k(0, 'Enter', { shiftKey: true })).toBeNull();
		expect(keyAction(items, 9, { key: 'Enter' })).toBeNull();
	});
});

describe('rovingIndex (step V4)', () => {
	it('keeps the focused item, else its place, else the highlighted tab', () => {
		expect(rovingIndex(['a', 'b', 'c'], 'b', 1, 2)).toBe(1);
		expect(rovingIndex(['a', 'c', 'b'], 'b', 1, 0)).toBe(2);
		expect(rovingIndex(['a', 'c'], 'gone', 5, 0)).toBe(1);
		expect(rovingIndex(['a', 'c'], null, -1, 1)).toBe(1);
		expect(rovingIndex(['a', 'c'], null, -1, -1)).toBe(0);
		expect(rovingIndex([], 'a', 0, 0)).toBe(-1);
	});
});

describe('strip prefs in the session record (step V3)', () => {
	const snapshot = { panes: [], activeLeafId: null };
	it('writes only what differs from the defaults and reads it back', () => {
		expect('vstrip' in buildSession(emptyState(), snapshot, [], 'vertical', {})).toBe(false);
		expect('vstrip' in buildSession(emptyState(), snapshot, [], 'vertical', { width: STRIP_WIDTH.default })).toBe(false);
		const s = buildSession(emptyState(), snapshot, [], 'vertical', { width: 300, collapsed: true });
		expect(s.vstrip).toEqual({ width: 300, collapsed: true });
		expect(stripPrefsOf(parseSession(JSON.parse(JSON.stringify(s))))).toEqual({ width: 300, collapsed: true });
	});
	it('drops values it cannot use, without a problem report', () => {
		for (const vstrip of [{ width: 50 }, { width: 9999 }, { width: 250.5 }, { width: '300' }, { collapsed: 'yes' }, 'x', [1]]) {
			const parsed = parseSession({ version: 1, nextGroupSeq: 1, groups: [], closed: [], unmatched: [], vstrip });
			expect(parsed.kind).toBe('ok');
			expect(parsed.kind === 'ok' && parsed.problems).toEqual([]);
			expect(stripPrefsOf(parsed)).toEqual({});
		}
		expect(stripPrefsOf({ kind: 'empty' })).toEqual({});
	});
	it('clampStripWidth keeps widths in range, whole px', () => {
		expect(clampStripWidth(10)).toBe(STRIP_WIDTH.min);
		expect(clampStripWidth(9000)).toBe(STRIP_WIDTH.max);
		expect(clampStripWidth(250.6)).toBe(251);
		expect(clampStripWidth(Number.NaN)).toBe(STRIP_WIDTH.default);
	});
});
