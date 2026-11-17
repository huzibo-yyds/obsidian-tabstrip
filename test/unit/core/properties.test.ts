/**
 * Property-based tests (fast-check). Each property runs at least 1,000 times;
 * set FC_RUNS to run more (for example FC_RUNS=20000 npm test).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createGroup } from '../../../src/core/commands';
import { invariants } from '../../../src/core/invariants';
import { applyOps } from '../../../src/core/ops';
import { reconcile } from '../../../src/core/reconcile';
import { GROUP_COLORS, type GroupState, type LeafInfo, type PaneInfo, type Snapshot } from '../../../src/core/types';
import { Sim, STEP_KINDS } from './sim';

const NUM_RUNS = Math.max(1000, Number(process.env['FC_RUNS'] ?? 0) || 0);
const params = { numRuns: NUM_RUNS };
/** Generous per-test time limit that grows with FC_RUNS (about 1 ms per run is typical). */
const TIMEOUT_MS = Math.max(30_000, NUM_RUNS * 5);

const paneSeed = fc.record({
	popout: fc.boolean(),
	size: fc.integer({ min: 1, max: 8 }),
	pinned: fc.integer({ min: 0, max: 2 }),
});
const step = fc.record({
	kind: fc.integer({ min: 0, max: STEP_KINDS - 1 }),
	a: fc.nat(10_000),
	b: fc.nat(10_000),
	c: fc.nat(10_000),
	d: fc.nat(10_000),
});

describe('P1 random user and command sequences', () => {
	it(`keeps invariants, is idempotent and only emits valid ops (${String(NUM_RUNS)} runs)`, () => {
		let steps = 0;
		let maxGroups = 0;
		fc.assert(
			fc.property(fc.array(paneSeed, { minLength: 1, maxLength: 4, size: 'max' }), fc.array(step, { minLength: 10, maxLength: 60, size: 'max' }), (panes, actions) => {
				const sim = new Sim(panes);
				for (const a of actions) {
					sim.step(a);
					steps++;
					maxGroups = Math.max(maxGroups, sim.state.groups.length);
				}
			}),
			params,
		);
		// The generator must actually build groups, or the property proves little.
		expect(maxGroups).toBeGreaterThanOrEqual(3);
		console.info(`P1: ${String(NUM_RUNS)} runs, ${String(steps)} steps, up to ${String(maxGroups)} groups at once`);
		console.info(`P1 stats: ${JSON.stringify(Object.fromEntries([...Sim.stats].sort()))}`);
		expect(Sim.stats.get('restored-from-tombstone') ?? 0).toBeGreaterThan(0);
		expect(Sim.stats.get('reconcile-op:move') ?? 0).toBeGreaterThan(0);
		// Rule R12 is checked in the simulator; make sure its hard case actually occurs:
		// an undo-close into a strip that had closed and whose id is back already.
		expect(Sim.stats.get('undo-close:strip-closed-id-back') ?? 0).toBeGreaterThan(0);
	}, TIMEOUT_MS);
});

/** Random snapshot with unique ids; pinned tabs may be anywhere. */
const snapshotArb = fc
	.array(
		fc.record({
			popout: fc.boolean(),
			stacked: fc.boolean(),
			leaves: fc.array(fc.record({ pinned: fc.boolean(), path: fc.nat(3) }), { minLength: 1, maxLength: 8 }),
			current: fc.nat(10),
		}),
		{ minLength: 1, maxLength: 4 },
	)
	.chain((panes) =>
		fc.record({ panes: fc.constant(panes), active: fc.nat(30) }).map(({ active }) => {
			let n = 0;
			const out: PaneInfo[] = panes.map((p, i) => {
				const leaves: LeafInfo[] = p.leaves.map((l) => ({
					id: `l${String(n++)}`,
					pinned: l.pinned,
					fingerprint: { viewType: 'markdown', path: `f${String(l.path)}.md` },
				}));
				const pane = {
					id: `p${String(i)}`,
					kind: i > 0 && p.popout ? ('popout' as const) : ('main' as const),
					leaves,
					currentLeafId: leaves[p.current % leaves.length]?.id ?? null,
				};
				return p.stacked ? { ...pane, stacked: true } : pane;
			});
			const all = out.flatMap((p) => p.leaves);
			return { panes: out, activeLeafId: all[active % all.length]?.id ?? null } satisfies Snapshot;
		}),
	);

/** Arbitrary (often invalid) state for a snapshot: random groups, members, bogus ids. */
function stateArb(s: Snapshot): fc.Arbitrary<GroupState> {
	const ids = [...s.panes.flatMap((p) => p.leaves.map((l) => l.id)), 'ghost1', 'ghost2'];
	return fc
		.record({
			groups: fc.array(fc.record({ collapsed: fc.boolean(), color: fc.constantFrom(...GROUP_COLORS) }), { maxLength: 5 }),
			members: fc.array(fc.record({ leaf: fc.nat(100), group: fc.nat(6) }), { maxLength: 20 }),
		})
		.map(({ groups, members }) => ({
			groups: groups.map((g, i) => ({ id: `G${String(i)}`, name: '', color: g.color, collapsed: g.collapsed })),
			members: [...new Map(members.map((m) => [ids[m.leaf % ids.length] ?? 'x', `G${String(m.group)}`])).entries()]
				.sort(([x], [y]) => (x < y ? -1 : 1))
				.map(([leafId, groupId]) => ({ leafId, groupId, fingerprint: { viewType: 'markdown' } })),
			tombstones: [],
			nextGroupSeq: 1,
		}));
}

function settle(prev: Snapshot, next: Snapshot, state: GroupState): void {
	const r = reconcile(prev, next, state);
	let n = 0;
	const after = applyOps(next, r.ops, () => `new${String(++n)}`);
	expect(invariants(after, r.state)).toEqual([]);
	const again = reconcile(next, after, r.state);
	expect(again.ops).toEqual([]);
	expect(again.state).toBe(r.state);
}

describe('P2 repair from any state', () => {
	it(`reconcile turns an arbitrary state into a consistent one in one round (${String(NUM_RUNS)} runs)`, () => {
		fc.assert(
			fc.property(
				snapshotArb.chain((s) => fc.tuple(fc.constant(s), stateArb(s))),
				([s, st]) => {
					settle(s, s, st);
					settle({ panes: [], activeLeafId: null }, s, st);
				},
			),
			params,
		);
	}, TIMEOUT_MS);
});

describe('P3 big batched changes from a valid state', () => {
	it(`many simultaneous moves, closes, opens and pins still reconcile to a consistent state (${String(NUM_RUNS)} runs)`, () => {
		fc.assert(
			fc.property(
				snapshotArb,
				fc.array(fc.tuple(fc.nat(50), fc.nat(50)), { maxLength: 4 }),
				fc.array(fc.record({ op: fc.nat(4), x: fc.nat(100), y: fc.nat(100) }), { minLength: 1, maxLength: 12 }),
				fc.option(fc.record({ leaf: fc.nat(100), group: fc.option(fc.nat(10)) })),
				(raw, groupSeeds, edits, intentSeed) => {
					// Start valid: fix pinned prefix with an empty state, then group some ranges.
					const r0 = reconcile(raw, raw, { groups: [], members: [], tombstones: [], nextGroupSeq: 1 });
					let s = applyOps(raw, r0.ops, () => 'never');
					let st = r0.state;
					for (const [p, mask] of groupSeeds) {
						const pane = s.panes[p % s.panes.length];
						if (pane === undefined) continue;
						const res = createGroup(st, s, pane.leaves.filter((_, i) => ((mask + 1) >> i) & 1).map((l) => l.id));
						s = applyOps(s, res.ops, () => 'never');
						st = res.state;
					}
					expect(invariants(s, st)).toEqual([]);

					// Many edits in one layout change.
					const panes = s.panes.map((p) => ({ ...p, leaves: [...p.leaves] }));
					let fresh = 0;
					for (const e of edits) {
						const pane = panes[e.x % panes.length];
						if (pane === undefined) continue;
						if (e.op === 0 && pane.leaves.length > 1) pane.leaves.splice(e.y % pane.leaves.length, 1);
						else if (e.op === 1) {
							pane.leaves.splice(e.y % (pane.leaves.length + 1), 0, {
								id: `fresh${String(fresh++)}`,
								pinned: false,
								fingerprint: { viewType: 'empty' },
							});
						} else if (e.op === 2 && pane.leaves.length > 0) {
							const [leaf] = pane.leaves.splice(e.y % pane.leaves.length, 1);
							const dest = panes[e.y % panes.length];
							if (leaf !== undefined && dest !== undefined) dest.leaves.splice(e.x % (dest.leaves.length + 1), 0, leaf);
						} else if (e.op === 3 && pane.leaves.length > 0) {
							const i = e.y % pane.leaves.length;
							const leaf = pane.leaves[i];
							if (leaf !== undefined) pane.leaves[i] = { ...leaf, pinned: !leaf.pinned };
						}
					}
					const kept = panes
						.filter((p) => p.leaves.length > 0)
						.map((p) => ({ ...p, currentLeafId: p.leaves.some((l) => l.id === p.currentLeafId) ? p.currentLeafId : (p.leaves[0]?.id ?? null) }));
					const all = kept.flatMap((p) => p.leaves);
					const next: Snapshot = {
						panes: kept,
						activeLeafId: all.some((l) => l.id === s.activeLeafId) ? s.activeLeafId : (all[0]?.id ?? null),
					};
					const intentLeaf = intentSeed === null ? undefined : all[intentSeed.leaf % Math.max(1, all.length)];
					const groupIds = st.groups.map((g) => g.id);
					const ctx =
						intentSeed === null || intentLeaf === undefined
							? {}
							: {
									dropIntent: {
										leafId: intentLeaf.id,
										joinGroupId: intentSeed.group === null ? null : (groupIds[intentSeed.group % Math.max(1, groupIds.length)] ?? null),
									},
								};
					const r = reconcile(s, next, st, ctx);
					const after = applyOps(next, r.ops, () => 'never');
					expect(invariants(after, r.state)).toEqual([]);
					const again = reconcile(next, after, r.state);
					expect(again.ops).toEqual([]);
					expect(again.state).toBe(r.state);
				},
			),
			params,
		);
	}, TIMEOUT_MS);
});
