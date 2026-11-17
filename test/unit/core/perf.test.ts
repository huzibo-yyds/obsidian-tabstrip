/**
 * Performance budget (requirements 5.6): one reconcile on 200 tabs in 3 strips and
 * 2 pop-out windows with 20 groups takes under 2 ms (median of 200 runs).
 */
import { describe, expect, it } from 'vitest';
import { invariants } from '../../../src/core/invariants';
import { reconcile } from '../../../src/core/reconcile';
import type { GroupState, LeafInfo, PaneInfo, ReconcileContext, Snapshot } from '../../../src/core/types';

const ITERATIONS = 200;
const WARMUP = 50;
const BUDGET_MS = 2;

function leaf(id: string, pinned = false): LeafInfo {
	return { id, pinned, fingerprint: { viewType: 'markdown', path: `notes/${id}.md` } };
}

/** 200 tabs: strips of 50/50/40 (main) and 30/30 (pop-outs), 4 groups of 5 per strip. */
function scenario(): { snapshot: Snapshot; state: GroupState } {
	const sizes = [50, 50, 40, 30, 30];
	const panes: PaneInfo[] = [];
	const groups: GroupState['groups'][number][] = [];
	const members: GroupState['members'][number][] = [];
	sizes.forEach((size, p) => {
		const leaves = Array.from({ length: size }, (_, i) => leaf(`p${String(p)}l${String(i)}`, i < 2));
		for (let g = 0; g < 4; g++) {
			const id = `G${String(p)}${String(g)}`;
			groups.push({ id, name: `Group ${id}`, color: 'blue', collapsed: g === 3 });
			for (let k = 0; k < 5; k++) {
				const l = leaves[2 + g * 7 + k];
				if (l !== undefined) members.push({ leafId: l.id, groupId: id, fingerprint: l.fingerprint });
			}
		}
		panes.push({
			id: `P${String(p)}`,
			kind: p < 3 ? 'main' : 'popout',
			leaves,
			currentLeafId: leaves[size - 1]?.id ?? null,
		});
	});
	members.sort((a, b) => (a.leafId < b.leafId ? -1 : 1));
	const snapshot = { panes, activeLeafId: panes[0]?.currentLeafId ?? null };
	const state = { groups, members, tombstones: [], nextGroupSeq: 1 };
	expect(snapshot.panes.flatMap((p) => p.leaves)).toHaveLength(200);
	expect(groups).toHaveLength(20);
	expect(invariants(snapshot, state)).toEqual([]);
	return { snapshot, state };
}

function withPane(s: Snapshot, index: number, change: (leaves: LeafInfo[]) => LeafInfo[]): Snapshot {
	return { ...s, panes: s.panes.map((p, i) => (i === index ? { ...p, leaves: change([...p.leaves]) } : p)) };
}

function median(samples: number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function measure(prev: Snapshot, next: Snapshot, state: GroupState, ctx: ReconcileContext = {}): { median: number; p95: number } {
	for (let i = 0; i < WARMUP; i++) reconcile(prev, next, state, ctx);
	const samples: number[] = [];
	for (let i = 0; i < ITERATIONS; i++) {
		const t0 = performance.now();
		reconcile(prev, next, state, ctx);
		samples.push(performance.now() - t0);
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return { median: median(samples), p95: sorted[Math.floor(sorted.length * 0.95)] ?? Number.NaN };
}

describe('reconcile performance (200 tabs, 3 strips + 2 pop-outs, 20 groups)', () => {
	const { snapshot, state } = scenario();
	const cases: [string, Snapshot, ReconcileContext][] = [
		['no change (tab switch)', snapshot, {}],
		[
			'drag a tab into a group (with intent)',
			withPane(snapshot, 0, (l) => {
				const [moved] = l.splice(40, 1);
				if (moved !== undefined) l.splice(4, 0, moved);
				return l;
			}),
			{ dropIntent: { leafId: 'p0l40', joinGroupId: null } },
		],
		['new tab inside a group', withPane(snapshot, 1, (l) => [...l.slice(0, 4), leaf('fresh'), ...l.slice(4)]), {}],
		['close a member', withPane(snapshot, 2, (l) => l.filter((x) => x.id !== 'p2l3')), {}],
		[
			'tab dropped inside a collapsed group',
			withPane(snapshot, 3, (l) => {
				const [moved] = l.splice(29, 1);
				if (moved !== undefined) l.splice(25, 0, moved);
				return l;
			}),
			{ dropIntent: { leafId: 'p3l29', joinGroupId: null } },
		],
		[
			'unrelated reshuffle of a whole strip',
			withPane(snapshot, 4, (l) => [...l.slice(0, 2), ...l.slice(2).reverse()]),
			{},
		],
	];

	it.each(cases)(`%s: median under ${String(BUDGET_MS)} ms over ${String(ITERATIONS)} runs`, (label, next, ctx) => {
		const { median: med, p95 } = measure(snapshot, next, state, ctx);
		console.info(`perf | ${label} | median ${med.toFixed(4)} ms | p95 ${p95.toFixed(4)} ms`);
		expect(med).toBeLessThan(BUDGET_MS);
	});
});
