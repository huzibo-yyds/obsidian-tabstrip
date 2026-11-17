/**
 * Step L7, S5: event and layout sequences recorded in the sandbox (test/e2e/specs/l7-drag.e2e.ts,
 * case D13, written with TABSTRIP_WRITE_FIXTURES=1 on Obsidian 1.15.0) replayed through reconcile.
 *
 * Each fixture holds the DOM drag events and workspace events in the order they happened, and the
 * plugin's passes (previous and next snapshot, state before, drop intent, state after, ops). Here
 * every pass is reconciled again (same result as in the app) and checked against the rule it shows.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { invariants } from '../../../src/core/invariants';
import { applyOps } from '../../../src/core/ops';
import { reconcile } from '../../../src/core/reconcile';
import type { GroupState, Op, ReconcileContext, Snapshot } from '../../../src/core/types';

interface Pass {
	triggers: string[];
	prev: Snapshot;
	next: Snapshot;
	before: GroupState;
	ctx: ReconcileContext;
	after: GroupState;
	ops: Op[];
}

interface Fixture {
	name: string;
	what: string;
	obsidian: string;
	events: { t: number; type: string; detail?: string }[];
	passes: Pass[];
}

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 's5');
const fixtures: Fixture[] = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith('.json'))
	.sort()
	.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Fixture);

const groupOf = (st: GroupState, id: string) => st.members.find((m) => m.leafId === id)?.groupId ?? null;
const paneOf = (s: Snapshot, id: string) => s.panes.find((p) => p.leaves.some((l) => l.id === id));
const types = (f: Fixture) => f.events.map((e) => e.type.replace(/x\d+$/, ''));
const fixture = (name: string): Fixture => {
	const f = fixtures.find((x) => x.name === name);
	if (f === undefined) throw new Error(`no fixture ${name}`);
	return f;
};
/** The one pass of a fixture that saw the change. */
const pass = (name: string): Pass => {
	const f = fixture(name);
	expect(f.passes.length).toBe(1);
	return f.passes[0] as Pass;
};

describe('S5 recorded sequences', () => {
	it('all eleven recordings are there, from Obsidian 1.15.0', () => {
		expect(fixtures.map((f) => f.name)).toEqual([
			'drag-end-boundary-member',
			'drag-end-boundary-outside',
			'drag-into-middle',
			'drag-out',
			'drag-start-boundary-chip',
			'drag-to-popout',
			'drag-to-split',
			'duplicate-tab',
			'load-layout',
			'move-to-new-window',
			'open-after-current',
		]);
		for (const f of fixtures) expect(f.obsidian).toBe('1.15.0');
	});

	for (const f of fixtures) {
		it(`${f.name}: every pass reconciles to the same result, valid and idempotent`, () => {
			for (const p of f.passes) {
				const r = reconcile(p.prev, p.next, p.before, p.ctx);
				expect(r.state).toEqual(p.after);
				expect(r.ops).toEqual(p.ops);
				const settled = applyOps(p.next, r.ops, () => 'never');
				expect(invariants(settled, r.state)).toEqual([]);
				expect(reconcile(p.next, settled, r.state).ops).toEqual([]);
			}
		});
	}

	it('a drag: dragstart, dragenter, dragover…, drop, dragend, then layout-change (the pass runs after it with the intent)', () => {
		for (const name of ['drag-into-middle', 'drag-start-boundary-chip', 'drag-end-boundary-member', 'drag-end-boundary-outside', 'drag-out', 'drag-to-split']) {
			expect(types(fixture(name))).toEqual(['dragstart@main', 'dragenter@main', 'dragover', 'drop@main', 'dragend@main', 'layout-change']);
			const p = pass(name);
			expect(p.ctx.dropIntent).toBeDefined();
			// Obsidian moved exactly the dragged tab: it is the only one out of place.
			const id = p.ctx.dropIntent?.leafId ?? '';
			const without = (s: Snapshot) => s.panes.map((x) => x.leaves.map((l) => l.id).filter((l) => l !== id));
			expect(without(p.next)).toEqual(without(p.prev));
		}
	});

	it('into the middle, onto the chip, onto the last member: joins (rules 1, 2)', () => {
		for (const name of ['drag-into-middle', 'drag-start-boundary-chip', 'drag-end-boundary-member']) {
			const p = pass(name);
			const id = p.ctx.dropIntent?.leafId ?? '';
			expect(p.ctx.dropIntent?.joinGroupId).not.toBeNull();
			expect(groupOf(p.after, id)).toBe(p.ctx.dropIntent?.joinGroupId);
			expect(p.ops).toEqual([]);
		}
	});

	it('past the strip end, or out of the middle: leaves (rules 2, 3)', () => {
		for (const name of ['drag-end-boundary-outside', 'drag-out']) {
			const p = pass(name);
			const id = p.ctx.dropIntent?.leafId ?? '';
			expect(groupOf(p.before, id)).not.toBeNull();
			expect(groupOf(p.after, id)).toBeNull();
		}
	});

	it('to another split and to a pop-out: leaves (rule 5); in the pop-out case the drop and dragend come from the pop-out', () => {
		for (const name of ['drag-to-split', 'drag-to-popout']) {
			const p = pass(name);
			const id = p.ctx.dropIntent?.leafId ?? '';
			expect(paneOf(p.prev, id)?.id).not.toBe(paneOf(p.next, id)?.id);
			expect(groupOf(p.before, id)).not.toBeNull();
			expect(groupOf(p.after, id)).toBeNull();
		}
		expect(types(fixture('drag-to-popout'))).toEqual(['dragstart@main', 'dragenter@popout', 'dragover', 'drop@popout', 'layout-change', 'dragend@popout']);
		expect(paneOf(pass('drag-to-popout').next, pass('drag-to-popout').ctx.dropIntent?.leafId ?? '')?.kind).toBe('popout');
	});

	it('"Move to new window": a new window opens, no drag events, no intent; the tab leaves its group', () => {
		const f = fixture('move-to-new-window');
		expect(types(f)).toEqual(['window-open', 'layout-change']);
		const p = pass('move-to-new-window');
		expect(p.ctx.dropIntent).toBeUndefined();
		const moved = p.prev.panes.flatMap((x) => x.leaves.map((l) => l.id)).filter((id) => paneOf(p.next, id)?.kind === 'popout' && paneOf(p.prev, id)?.kind === 'main');
		expect(moved).toHaveLength(1);
		expect(groupOf(p.before, moved[0] ?? '')).not.toBeNull();
		expect(groupOf(p.after, moved[0] ?? '')).toBeNull();
	});

	it('duplicate and open-after-current from a middle member: the new tab lands inside the group and joins it', () => {
		for (const name of ['duplicate-tab', 'open-after-current']) {
			const p = pass(name);
			expect(p.ctx.dropIntent).toBeUndefined();
			const old = new Set(p.prev.panes.flatMap((x) => x.leaves.map((l) => l.id)));
			const added = p.next.panes.flatMap((x) => x.leaves.map((l) => l.id)).filter((id) => !old.has(id));
			expect(added).toHaveLength(1);
			const pane = paneOf(p.next, added[0] ?? '');
			const order = pane?.leaves.map((l) => l.id) ?? [];
			const k = order.indexOf(added[0] ?? '');
			const left = groupOf(p.before, order[k - 1] ?? '');
			expect(left).not.toBeNull();
			expect(groupOf(p.before, order[k + 1] ?? '')).toBe(left);
			expect(groupOf(p.after, added[0] ?? '')).toBe(left);
		}
	});

	it('loading a layout of the same tabs: same leaf ids, groups unchanged, no ops', () => {
		const p = pass('load-layout');
		expect(p.ctx.dropIntent).toBeUndefined();
		expect(p.after.members).toEqual(p.before.members);
		expect(p.ops).toEqual([]);
	});
});
