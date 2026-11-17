/**
 * Step V5: the vertical strip's drop spots (src/ui/vdrop.ts) and the keyboard's drag keys. The
 * property test builds the real list (planVerticalList) of random grouped layouts, lays its rows out
 * 30px apart, drops at random heights and checks every drop with the L7 rule oracle: the same rules
 * as the horizontal strip, and the highlight always equals the result.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { predictDrop, type DropTarget } from '../../../src/core/drag';
import type { GroupState, Snapshot } from '../../../src/core/types';
import { collapsedLineY, vspotAt, vspotKey, type VDropBox, type VDropSpot } from '../../../src/ui/vdrop';
import { keyAction, type VKeyItem } from '../../../src/ui/vkeys';
import { planVerticalList, type VListStrip } from '../../../src/ui/vplan';
import { checkDrop } from '../core/drop-oracle';
import { groups, membership, snap } from '../core/dsl';
import { layoutArb } from '../core/layout-arb';

const NUM_RUNS = Math.max(1000, Number(process.env['FC_RUNS'] ?? 0) || 0);
const TIMEOUT_MS = Math.max(30_000, NUM_RUNS * 10);
const ROW = 30;

/** The strip's input from a snapshot (main panes are listed; pop-outs are not). */
function stripsOf(s: Snapshot): VListStrip[] {
	return s.panes.map((p) => ({ paneId: p.id, kind: p.kind, leaves: p.leaves.map((l) => ({ id: l.id, info: { pinned: l.pinned } })), currentLeafId: p.currentLeafId, stacked: p.stacked === true }));
}

/** Rows of the list laid out ROW px apart, from y = 0, sections 10px apart (titles are not rows). */
function boxesOf(s: Snapshot, st: GroupState): VDropBox[] {
	const plan = planVerticalList(stripsOf(s), st, s.activeLeafId);
	const boxes: VDropBox[] = [];
	let y = 0;
	for (const section of plan.sections) {
		y += 10;
		for (const item of section.items) {
			const top = y;
			const bottom = y + ROW;
			y = bottom;
			if (item.kind === 'tab') boxes.push({ kind: 'tab', paneId: item.row.paneId, leafId: item.row.leafId, pinned: item.row.pinned, top, bottom });
			else if (item.kind === 'group') boxes.push({ kind: 'group', paneId: item.paneId, groupId: item.groupId, firstLeafId: item.memberIds[0] ?? '', top, bottom });
			else boxes.push({ kind: 'new', paneId: item.paneId, top, bottom });
		}
	}
	return boxes;
}

/** Whether the dragged tab is pinned. */
function pinnedIn(s: Snapshot, leafId: string): boolean {
	return s.panes.some((p) => p.leaves.some((l) => l.id === leafId && l.pinned));
}

/**
 * V5 review round 2: the drop line is drawn where the tab settles, as far as pinned tabs go. Pinned
 * tabs stay first in their pane, so for a drop that changes something: a pinned tab's line has only
 * pinned rows above it; an unpinned tab's line sits right above an unpinned row of the target pane.
 */
function lineProblem(s: Snapshot, st: GroupState, boxes: readonly VDropBox[], leafId: string, spot: VDropSpot): string | null {
	const prediction = predictDrop(st, s, { leafId, paneId: spot.paneId, spot: spot.spot });
	const before = st.members.find((m) => m.leafId === leafId)?.groupId ?? null;
	if (!prediction.moves && prediction.groupId === before) return null;
	const isPinned = (b: VDropBox): boolean => b.kind === 'tab' && b.pinned === true;
	if (pinnedIn(s, leafId)) {
		const above = boxes.filter((b) => b.bottom <= spot.lineY + 0.5);
		return above.every(isPinned) ? null : `pinned tab's line below an unpinned row (y=${String(spot.lineY)})`;
	}
	const below = boxes.find((b) => b.top >= spot.lineY - 0.5);
	if (below === undefined) return `no row below the line (y=${String(spot.lineY)})`;
	if (isPinned(below)) return `unpinned tab's line above a pinned row (y=${String(spot.lineY)})`;
	if (below.paneId !== spot.paneId) return `line above a row of pane ${below.paneId}, drop into ${spot.paneId}`;
	return null;
}

describe('vspotAt: the drop spot under the pointer in the vertical strip', () => {
	// a [0,30] [G] [30,60] g1 [60,90] g2 [90,120] new [120,150]
	const boxes: VDropBox[] = [
		{ kind: 'tab', paneId: 'A', leafId: 'a', top: 0, bottom: 30 },
		{ kind: 'group', paneId: 'A', groupId: 'G', firstLeafId: 'g1', top: 30, bottom: 60 },
		{ kind: 'tab', paneId: 'A', leafId: 'g1', top: 60, bottom: 90 },
		{ kind: 'tab', paneId: 'A', leafId: 'g2', top: 90, bottom: 120 },
		{ kind: 'new', paneId: 'A', top: 120, bottom: 150 },
	];

	it('a tab row: upper half before it, lower half after it; the line at that edge', () => {
		expect(vspotAt(5, boxes)).toEqual({ paneId: 'A', row: 0, spot: { kind: 'tab', leafId: 'a', side: 'before' }, lineY: 0 });
		expect(vspotAt(20, boxes)).toEqual({ paneId: 'A', row: 0, spot: { kind: 'tab', leafId: 'a', side: 'after' }, lineY: 30 });
		expect(vspotAt(100, boxes)?.spot).toEqual({ kind: 'tab', leafId: 'g2', side: 'before' });
	});

	it('a group row: upper half is the gap before the group, lower half its chip', () => {
		expect(vspotAt(35, boxes)).toEqual({ paneId: 'A', row: 1, spot: { kind: 'gap', beforeLeafId: 'g1' }, lineY: 30 });
		expect(vspotAt(50, boxes)).toEqual({ paneId: 'A', row: 1, spot: { kind: 'chip', groupId: 'G' }, lineY: 60 });
	});

	it('"New tab" and everything below the last row: the end of the pane', () => {
		expect(vspotAt(125, boxes)?.spot).toEqual({ kind: 'empty' });
		expect(vspotAt(400, boxes)?.spot).toEqual({ kind: 'empty' });
		expect(vspotAt(400, boxes)?.lineY).toBe(120);
	});

	it('above the first row (a section title): the first row\'s upper half; no rows: nothing', () => {
		expect(vspotAt(-20, boxes)?.spot).toEqual({ kind: 'tab', leafId: 'a', side: 'before' });
		expect(vspotAt(10, [])).toBeNull();
	});

	it('the line after a collapsed group goes below its shown tab (the strip\'s shown member stays visible)', () => {
		const c: VDropBox[] = [
			{ kind: 'group', paneId: 'A', groupId: 'C', firstLeafId: 'c1', top: 0, bottom: 30 },
			{ kind: 'tab', paneId: 'A', leafId: 'c2', top: 30, bottom: 60 },
			{ kind: 'tab', paneId: 'A', leafId: 'x', top: 60, bottom: 90 },
		];
		expect(collapsedLineY(c, 0, new Set(['c1', 'c2']))).toBe(60);
		expect(collapsedLineY(c, 0, new Set(['c1']))).toBe(30);
	});

	it('vspotKey tells every spot apart', () => {
		const keys = [5, 20, 35, 50, 70, 100, 125].map((y) => vspotKey(vspotAt(y, boxes)));
		expect(new Set(keys).size).toBe(keys.length);
		expect(vspotKey(null)).toBe('');
	});
});

describe('drops on the vertical strip follow the horizontal rules', () => {
	/** The drop at height y of the dragged tab, through the oracle. */
	function dropAt(s: Snapshot, st: GroupState, leafId: string, y: number) {
		const spot = vspotAt(y, boxesOf(s, st));
		if (spot === null) throw new Error('no spot');
		const target: DropTarget = { leafId, paneId: spot.paneId, spot: spot.spot };
		const r = checkDrop(s, st, target);
		return { spot: spot.spot, members: membership(r.state), order: r.next.panes.map((p) => p.leaves.map((l) => l.id).join(' ')).join(' | ') };
	}

	// One pane: a, [G], g1, g2, b, new  -> rows from y=10: a 10-40, G 40-70, g1 70-100, g2 100-130, b 130-160, new 160-190
	const s = snap('A: a g1 g2 b', { active: 'b' });
	const st = groups({ G: 'g1 g2' });

	it('on a member: joins (rule 1 / 2), the drop line between members', () => {
		const r = dropAt(s, st, 'b', 90);
		expect(r.spot).toEqual({ kind: 'tab', leafId: 'g1', side: 'after' });
		expect(r.order).toBe('a g1 b g2');
		expect(r.members.b).toBe('G');
	});

	it('the lower half of the group row: joins at the start', () => {
		const r = dropAt(s, st, 'b', 60);
		expect(r.order).toBe('a b g1 g2');
		expect(r.members.b).toBe('G');
	});

	it('the upper half of the group row: before the group, outside it', () => {
		const r = dropAt(s, st, 'b', 45);
		expect(r.order).toBe('a b g1 g2');
		expect(r.members.b).toBeUndefined();
	});

	it('the last member onto the tab after the group: leaves in place; to the end: leaves', () => {
		expect(dropAt(snap('A: a g1 g2 b', { active: 'g2' }), st, 'g2', 135).members.g2).toBeUndefined();
		const r = dropAt(snap('A: a g1 g2 b', { active: 'g1' }), st, 'g1', 170);
		expect(r.order).toBe('a g2 b g1');
		expect(r.members.g1).toBeUndefined();
	});

	it('a collapsed group row is never joined: the tab goes right after the group', () => {
		const c = groups({ G: { members: 'g1 g2', collapsed: true } });
		// a 10-40, G 40-70 (members hidden), b 70-100, new 100-130
		const r = dropAt(snap('A: a g1 g2 b', { active: 'a' }), c, 'a', 60);
		expect(r.order).toBe('g1 g2 a b');
		expect(r.members.a).toBeUndefined();
	});

	it('into another pane\'s group (two panes: pane sections), leaving its own group', () => {
		const two = groups({ G: 'g1 g2', H: 'h1 h2' });
		const s2 = snap('A: g1 g2 a | B: h1 h2 b', { active: 'g2' });
		// A: G 10-40, g1 40-70, g2 70-100, a 100-130, new 130-160; B: (+10) H 170-200, h1 200-230, h2 230-260, b, new
		const r = dropAt(s2, two, 'g2', 220);
		expect(r.order).toBe('g1 a | h1 g2 h2 b');
		expect(r.members.g2).toBe('H');
	});

	describe('pinned tabs stay first: the line shows where the tab really lands (review round 2)', () => {
		/** The spot at y (aimed for the dragged tab) and the settled order, through the oracle. */
		function aimAt(s2: Snapshot, st2: GroupState, leafId: string, y: number) {
			const boxes = boxesOf(s2, st2);
			const spot = vspotAt(y, boxes, pinnedIn(s2, leafId));
			if (spot === null) throw new Error('no spot');
			const r = checkDrop(s2, st2, { leafId, paneId: spot.paneId, spot: spot.spot });
			return { spot, problem: lineProblem(s2, st2, boxes, leafId, spot), members: membership(r.state), order: r.next.panes.map((p) => p.leaves.map((l) => l.id).join(' ')).join(' | ') };
		}

		it('an unpinned tab on a pinned row of its pane: before the first unpinned row (the group row), outside the group', () => {
			// pinned area: p 10-40, q 40-70; A: G 80-110, a 110-140, b 140-170, c 170-200, new 200-230
			const s2 = snap('A: p* q* a b c', { active: 'c' });
			const st2 = groups({ G: 'a b' });
			const r = aimAt(s2, st2, 'c', 45);
			expect(r.spot.spot).toEqual({ kind: 'gap', beforeLeafId: 'a' });
			expect(r.spot.lineY).toBe(80);
			expect(r.problem).toBeNull();
			expect(r.order).toBe('p q c a b');
			expect(r.members.c).toBeUndefined();
		});

		it('an unpinned tab on a pinned row of another pane: before that pane\'s first unpinned row', () => {
			// pinned: p 10-40 (A), r 40-70 (B); A: a 80-110, c 110-140, new 140-170; B: x 180-210, new 210-240
			const s2 = snap('A: p* a c | B: r* x', { active: 'c' });
			const r = aimAt(s2, groups({}), 'c', 45);
			expect(r.spot).toMatchObject({ paneId: 'B', spot: { kind: 'tab', leafId: 'x', side: 'before' }, lineY: 180 });
			expect(r.problem).toBeNull();
			expect(r.order).toBe('p a | r c x');
		});

		it('a pane with no unpinned tab: its "New tab" row, the end of the pane', () => {
			// pinned: p 10-40 (A), r 40-70 (B); A: a, c, new; B: new 180-210
			const r = aimAt(snap('A: p* a c | B: r*', { active: 'c' }), groups({}), 'c', 60);
			expect(r.spot).toMatchObject({ paneId: 'B', spot: { kind: 'empty' }, lineY: 180 });
			expect(r.order).toBe('p a | r c');
		});

		it('a pinned tab on an unpinned row: after its pane\'s pinned rows (never into a group)', () => {
			// pinned: p 10-40, q 40-70; A: G 80-110, a 110-140, b 140-170, new
			const s2 = snap('A: p* q* a b', { active: 'a' });
			const r = aimAt(s2, groups({ G: 'a b' }), 'p', 130);
			expect(r.spot).toMatchObject({ paneId: 'A', spot: { kind: 'tab', leafId: 'q', side: 'after' }, lineY: 70 });
			expect(r.problem).toBeNull();
			expect(r.order).toBe('q p a b');
			expect(r.members.p).toBeUndefined();
		});

		it('a pinned tab on a pane with no pinned tab: at that pane\'s place in the pinned area', () => {
			// pinned: p 10-40 (A), z 40-70 (C); A: a, new; B: x, new; C: y, new
			const s2 = snap('A: p* a | B: x | C: z* y', { active: 'a' });
			const r = aimAt(s2, groups({}), 'z', 10 + 60 + 10 + 60 + 10 + 5);
			expect(r.spot).toMatchObject({ paneId: 'B', spot: { kind: 'tab', leafId: 'x', side: 'before' }, lineY: 40 });
			expect(r.problem).toBeNull();
			expect(r.order).toBe('p a | z x | y');
		});
	});

	it(`V5-P1 a drop at any height of the real list, of any shown tab, follows the rules (${String(NUM_RUNS)} runs)`, () => {
		const outcomes = new Map<string, number>();
		fc.assert(
			fc.property(layoutArb, fc.nat(1000), fc.nat(100), ({ s: snapshot, st: state }, yPick, tabPick) => {
				const boxes = boxesOf(snapshot, state);
				const rows = boxes.flatMap((b) => (b.kind === 'tab' ? [b.leafId] : []));
				const leafId = rows[tabPick % Math.max(1, rows.length)];
				const last = boxes[boxes.length - 1];
				if (leafId === undefined || last === undefined) return;
				const spot = vspotAt((yPick / 1000) * (last.bottom + 20), boxes, pinnedIn(snapshot, leafId));
				if (spot === null) return;
				const r = checkDrop(snapshot, state, { leafId, paneId: spot.paneId, spot: spot.spot });
				expect(lineProblem(snapshot, state, boxes, leafId, spot), `${leafId} ${JSON.stringify(spot)}`).toBeNull();
				outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
			}),
			{ numRuns: NUM_RUNS },
		);
		console.info(`V5-P1 outcomes: ${JSON.stringify(Object.fromEntries([...outcomes].sort()))}`);
		for (const o of ['joined-boundary', 'stayed-out', 'no-move', 'joined-in-place', 'left-in-place', 'pinned']) expect(outcomes.get(o) ?? 0, o).toBeGreaterThan(0);
	}, TIMEOUT_MS);
});

describe('keyboard: Alt+Arrow Up / Down on a tab row moves it', () => {
	const items: VKeyItem[] = [
		{ kind: 'tab', level: 1 },
		{ kind: 'group', level: 1, collapsed: false },
		{ kind: 'tab', level: 2 },
		{ kind: 'new', level: 1 },
	];
	it('on a tab: move up / down; on group and "New tab" rows: nothing; other modifiers: Obsidian\'s', () => {
		expect(keyAction(items, 0, { key: 'ArrowUp', altKey: true })).toEqual({ kind: 'move', dir: -1 });
		expect(keyAction(items, 2, { key: 'ArrowDown', altKey: true })).toEqual({ kind: 'move', dir: 1 });
		expect(keyAction(items, 1, { key: 'ArrowDown', altKey: true })).toBeNull();
		expect(keyAction(items, 3, { key: 'ArrowUp', altKey: true })).toBeNull();
		expect(keyAction(items, 0, { key: 'ArrowUp', altKey: true, shiftKey: true })).toBeNull();
		expect(keyAction(items, 0, { key: 'ArrowUp', altKey: true, metaKey: true })).toBeNull();
		expect(keyAction(items, 0, { key: 'ArrowDown', altKey: true, isComposing: true })).toBeNull();
		// Without Alt the arrows still move the focus.
		expect(keyAction(items, 0, { key: 'ArrowDown' })).toEqual({ kind: 'focus', index: 1 });
	});
});
