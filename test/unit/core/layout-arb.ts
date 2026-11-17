/**
 * A random valid grouped layout for property tests (L7, V5): random strips, pinned prefixes, groups
 * from random runs, some collapsed.
 */
import fc from 'fast-check';
import { createGroup, setCollapsed } from '../../../src/core/commands';
import { applyOps } from '../../../src/core/ops';
import { reconcile } from '../../../src/core/reconcile';
import type { GroupState, LeafInfo, PaneInfo, Snapshot } from '../../../src/core/types';

export const layoutArb = fc
	.record({
		panes: fc.array(
			fc.record({ size: fc.integer({ min: 1, max: 9 }), pinned: fc.integer({ min: 0, max: 2 }), popout: fc.boolean(), stacked: fc.nat(9) }),
			{ minLength: 1, maxLength: 3 },
		),
		runs: fc.array(fc.record({ pane: fc.nat(9), start: fc.nat(9), length: fc.integer({ min: 1, max: 4 }), collapse: fc.boolean() }), { maxLength: 5 }),
		active: fc.nat(40),
	})
	.map(({ panes, runs, active }) => {
		let n = 0;
		const ps: PaneInfo[] = panes.map((p, i) => {
			const leaves: LeafInfo[] = Array.from({ length: p.size }, (_, k) => ({
				id: `l${String(n++)}`,
				pinned: k < Math.min(p.pinned, p.size - 1),
				fingerprint: { viewType: 'markdown' },
			}));
			const pane: PaneInfo = { id: `p${String(i)}`, kind: i > 0 && p.popout ? 'popout' : 'main', leaves, currentLeafId: leaves[leaves.length - 1]?.id ?? null };
			return p.stacked === 0 ? { ...pane, stacked: true } : pane;
		});
		const all = ps.flatMap((p) => p.leaves);
		let s: Snapshot = { panes: ps, activeLeafId: all[active % all.length]?.id ?? null };
		let st: GroupState = { groups: [], members: [], tombstones: [], nextGroupSeq: 1 };
		for (const run of runs) {
			const pane = s.panes[run.pane % s.panes.length];
			if (pane === undefined) continue;
			const ids = pane.leaves.slice(run.start % pane.leaves.length, (run.start % pane.leaves.length) + run.length).map((l) => l.id);
			const res = createGroup(st, s, ids);
			s = applyOps(s, res.ops, () => 'never');
			st = res.state;
			if (run.collapse && res.groupId !== null) {
				const c = setCollapsed(st, s, res.groupId, true);
				s = applyOps(s, c.ops, () => `new${String(n++)}`);
				st = c.state;
				const settled = reconcile(s, s, st);
				s = applyOps(s, settled.ops, () => 'never');
				st = settled.state;
			}
		}
		return { s, st };
	});

