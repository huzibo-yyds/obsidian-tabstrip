/**
 * A small model of Obsidian's own tab behaviour for property tests: open, close, close
 * every tab of a strip at once, drag (within and across strips), pin, undo-close one to
 * three times (same leaf id, at the end of its old strip or in a new split that reuses
 * the old strip id), split, activate, open a file in place, move to a new window,
 * stacked mode and reordering by another plugin.
 *
 * Every random choice comes from plain numbers, so fast-check can shrink a failing
 * sequence. Each step goes through `reconcile` (or a command, then `reconcile`) and
 * is checked with `invariants` and an idempotency round.
 */
import { expect } from 'vitest';
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
import { canHide, emptyState } from '../../../src/core/model';
import type { DropSpot } from '../../../src/core/drag';
import { checkDrop } from './drop-oracle';
import { applyOps } from '../../../src/core/ops';
import { reconcile } from '../../../src/core/reconcile';
import {
	GROUP_COLORS,
	type CommandResult,
	type DropIntent,
	type GroupState,
	type LeafInfo,
	type Op,
	type PaneInfo,
	type Snapshot,
} from '../../../src/core/types';

export interface Step {
	readonly kind: number;
	readonly a: number;
	readonly b: number;
	readonly c: number;
	readonly d: number;
}

export interface PaneSeed {
	readonly popout: boolean;
	readonly size: number;
	readonly pinned: number;
}

interface MPane {
	id: string;
	kind: 'main' | 'popout';
	leaves: LeafInfo[];
	currentLeafId: string | null;
	stacked?: boolean;
}

function pick<T>(list: readonly T[], n: number): T {
	const value = list[n % list.length];
	if (value === undefined) throw new Error('pick from empty list');
	return value;
}

export const NATIVE = [
	'open',
	'close',
	'close-strip',
	'drag',
	'drag',
	'drag-across',
	'pin',
	'undo-close',
	'split',
	'activate',
	'open-in-place',
	'new-window',
	'stacked',
	'plugin-reorder',
	'drop',
	'drop',
] as const;

export const COMMANDS = [
	'createGroup',
	'createGroup',
	'createGroup',
	'addToGroup',
	'removeFromGroup',
	'rename',
	'recolor',
	'collapse',
	'collapse',
	'expand',
	'ungroup',
	'closeGroup',
	'collapseOthers',
] as const;

export const STEP_KINDS = NATIVE.length + COMMANDS.length;

export class Sim {
	snapshot: Snapshot;
	state: GroupState = emptyState();
	/**
	 * Native undo stack: last closed first, at most 10 (like Obsidian). `stripClosed`
	 * turns true once the strip the tab was closed in has closed.
	 */
	private closed: { leaf: LeafInfo; paneId: string; stripClosed: boolean }[] = [];
	private seq = 0;
	readonly log: string[] = [];
	/** What happened, for the test report: step kinds, reconcile ops and events. */
	static readonly stats = new Map<string, number>();

	private static count(key: string, by = 1): void {
		Sim.stats.set(key, (Sim.stats.get(key) ?? 0) + by);
	}

	constructor(seeds: readonly PaneSeed[]) {
		const panes: PaneInfo[] = seeds.map((seed, p) => {
			const leaves: LeafInfo[] = Array.from({ length: seed.size }, () => this.leaf());
			leaves.forEach((l, i) => {
				if (i < seed.pinned) leaves[i] = { ...l, pinned: true };
			});
			return { id: `p${String(p)}`, kind: p > 0 && seed.popout ? 'popout' : 'main', leaves, currentLeafId: leaves[0]?.id ?? null };
		});
		this.snapshot = { panes, activeLeafId: panes[0]?.currentLeafId ?? null };
		expect(invariants(this.snapshot, this.state)).toEqual([]);
	}

	private fresh(prefix: string): string {
		this.seq += 1;
		return `${prefix}${String(this.seq)}`;
	}

	private leaf(): LeafInfo {
		const id = this.fresh('l');
		return { id, pinned: false, fingerprint: { viewType: 'markdown', path: `${id}.md` } };
	}

	private allLeaves(): LeafInfo[] {
		return this.snapshot.panes.flatMap((p) => p.leaves);
	}

	private mutable(): { panes: MPane[]; active: string | null } {
		return {
			panes: this.snapshot.panes.map((p) => ({ ...p, leaves: [...p.leaves] })),
			active: this.snapshot.activeLeafId,
		};
	}

	private freeze(m: { panes: MPane[]; active: string | null }): Snapshot {
		return { panes: m.panes.map((p) => ({ ...p })), activeLeafId: m.active };
	}

	/** Removes a leaf the way Obsidian does: neighbour gets shown, empty strips go away. */
	private takeOut(m: { panes: MPane[]; active: string | null }, leafId: string): MPane {
		const pane = m.panes.find((p) => p.leaves.some((l) => l.id === leafId));
		if (pane === undefined) throw new Error(`no leaf ${leafId}`);
		const index = pane.leaves.findIndex((l) => l.id === leafId);
		pane.leaves.splice(index, 1);
		if (pane.currentLeafId === leafId) pane.currentLeafId = (pane.leaves[index] ?? pane.leaves[index - 1])?.id ?? null;
		if (pane.leaves.length === 0) {
			const otherMain = m.panes.some((p) => p !== pane && p.kind === 'main');
			if (pane.kind === 'popout' || otherMain) m.panes.splice(m.panes.indexOf(pane), 1);
			else {
				const filler = this.leaf();
				pane.leaves.push(filler);
				pane.currentLeafId = filler.id;
			}
		}
		if (m.active === leafId) m.active = (m.panes.includes(pane) ? pane : m.panes[0])?.currentLeafId ?? null;
		return pane;
	}

	private show(m: { panes: MPane[]; active: string | null }, pane: MPane, leafId: string): void {
		pane.currentLeafId = leafId;
		m.active = leafId;
	}

	private intent(leafId: string, c: number, d: number): DropIntent | undefined {
		const choice = c % 3;
		if (choice === 0) return undefined;
		if (choice === 1 || this.state.groups.length === 0) return { leafId, joinGroupId: null };
		return { leafId, joinGroupId: pick(this.state.groups, d).id };
	}

	/** Leaves of one strip chosen by a bit mask. */
	private someLeaves(a: number, b: number): string[] {
		const pane = pick(this.snapshot.panes, a);
		const chosen = pane.leaves.filter((_, i) => ((b + 1) >> i) & 1).map((l) => l.id);
		return chosen.length > 0 ? chosen : [pick(pane.leaves, b).id];
	}

	step(s: Step): void {
		const k = s.kind % STEP_KINDS;
		Sim.count(`step:${k < NATIVE.length ? pick(NATIVE, k) : pick(COMMANDS, k - NATIVE.length)}`);
		if (k >= NATIVE.length) this.command(pick(COMMANDS, k - NATIVE.length), s);
		else if (pick(NATIVE, k) === 'drop') this.drop(s);
		else if (pick(NATIVE, k) !== 'undo-close') this.native(pick(NATIVE, k), s);
		// Pressing undo-close several times in a row: each restore is its own layout change.
		else for (let i = 0; i <= s.c % 3; i++) this.native('undo-close', s);
	}

	/** Tabs whose headers can be seen (and so dragged or pointed at). */
	private visible(paneId?: string): LeafInfo[] {
		return this.snapshot.panes
			.filter((p) => paneId === undefined || p.id === paneId)
			.flatMap((p) =>
				p.leaves.filter((l) => {
					const g = this.state.members.find((m) => m.leafId === l.id)?.groupId;
					const collapsed = g !== undefined && this.state.groups.some((x) => x.id === g && x.collapsed);
					return !(collapsed && canHide(p));
				}),
			);
	}

	/**
	 * Step L7: a native tab drag dropped where the pointer is (a tab and its half, a chip, the empty
	 * end), carried out like Obsidian and checked against the drop rules (drop-oracle.ts).
	 */
	private drop({ a, b, c, d }: Step): void {
		const dragged = this.visible()[a % Math.max(1, this.visible().length)];
		if (dragged === undefined) return;
		const source = this.snapshot.panes.find((p) => p.leaves.some((l) => l.id === dragged.id));
		const pane = c % 3 === 0 || source === undefined ? pick(this.snapshot.panes, b) : source;
		const chips = this.state.groups.filter((g) => this.state.members.some((m) => m.groupId === g.id && pane.leaves.some((l) => l.id === m.leafId)));
		const tabs = this.visible(pane.id);
		let spot: DropSpot;
		const kind = d % 5;
		if (kind === 2 && chips.length > 0) spot = { kind: 'chip', groupId: pick(chips, b + c).id };
		else if (kind === 3 || tabs.length === 0) spot = { kind: 'empty' };
		else spot = { kind: 'tab', leafId: pick(tabs, b + c).id, side: (d >> 3) % 2 === 0 ? 'before' : 'after' };
		const target = { leafId: dragged.id, paneId: pane.id, spot };
		this.log.push(`drop ${JSON.stringify(target)}`);
		const result = checkDrop(this.snapshot, this.state, target, () => this.log.join('\n'));
		Sim.count(`drop:${result.outcome}`);
		Sim.count(`drop-spot:${spot.kind}`);
		this.snapshot = result.next;
		this.state = result.state;
		// Obsidian closes a strip left empty (the main area keeps one).
		const emptied = this.snapshot.panes.filter((p) => p.leaves.length === 0);
		if (emptied.length === 0) return;
		const m = this.mutable();
		for (const e of emptied) {
			const otherMain = m.panes.some((p) => p.id !== e.id && p.kind === 'main' && p.leaves.length > 0);
			if (e.kind === 'popout' || otherMain) m.panes = m.panes.filter((p) => p.id !== e.id);
			else {
				const filler = this.leaf();
				const pm = m.panes.find((p) => p.id === e.id);
				if (pm !== undefined) {
					pm.leaves.push(filler);
					pm.currentLeafId = filler.id;
				}
			}
		}
		this.settle(this.snapshot, this.freeze(m), this.state, {});
	}

	private native(kind: (typeof NATIVE)[number], { a, b, c, d }: Step): void {
		const m = this.mutable();
		let ctx: { dropIntent?: DropIntent } = {};
		/** Undo-closed tab whose strip had closed: it must stay ungrouped and unmoved (rule R12). */
		let orphan: string | null = null;
		const leaves = this.allLeaves();
		const target = pick(leaves, a);
		switch (kind) {
			case 'open': {
				const pane = pick(m.panes, a);
				const leaf = this.leaf();
				pane.leaves.splice(b % (pane.leaves.length + 1), 0, leaf);
				this.show(m, pane, leaf.id);
				break;
			}
			case 'close': {
				const from = m.panes.find((p) => p.leaves.some((l) => l.id === target.id));
				this.takeOut(m, target.id);
				this.closed.unshift({ leaf: { ...target, pinned: false }, paneId: from?.id ?? '', stripClosed: false });
				this.closed = this.closed.slice(0, 10);
				break;
			}
			case 'close-strip': {
				// Closing a pop-out window or every tab of a split: one layout change.
				const pane = pick(m.panes, a);
				for (const leaf of [...pane.leaves]) {
					this.closed.unshift({ leaf: { ...leaf, pinned: false }, paneId: pane.id, stripClosed: false });
					this.takeOut(m, leaf.id);
				}
				this.closed = this.closed.slice(0, 10);
				break;
			}
			case 'drag': {
				const pane = m.panes.find((p) => p.leaves.some((l) => l.id === target.id));
				if (pane === undefined) throw new Error('drag');
				const leaf = pane.leaves.splice(pane.leaves.findIndex((l) => l.id === target.id), 1)[0] as LeafInfo;
				pane.leaves.splice(b % (pane.leaves.length + 1), 0, leaf);
				this.show(m, pane, leaf.id);
				const i = this.intent(leaf.id, c, d);
				if (i !== undefined) ctx = { dropIntent: i };
				break;
			}
			case 'drag-across':
			case 'new-window': {
				let dest: MPane;
				if (kind === 'new-window') {
					dest = { id: this.fresh('w'), kind: 'popout', leaves: [], currentLeafId: null };
					m.panes.push(dest);
				} else {
					dest = pick(m.panes, b);
				}
				if (dest.leaves.some((l) => l.id === target.id)) return this.native('drag', { kind: 0, a, b, c, d });
				this.takeOut(m, target.id);
				if (!m.panes.includes(dest)) return;
				dest.leaves.splice(c % (dest.leaves.length + 1), 0, target);
				this.show(m, dest, target.id);
				const i = this.intent(target.id, c, d);
				if (i !== undefined) ctx = { dropIntent: i };
				break;
			}
			case 'pin': {
				// Linked tabs are pinned together: sometimes a second tab flips too.
				const ids = new Set([target.id]);
				if (c % 4 === 0) ids.add(pick(leaves, b).id);
				for (const pane of m.panes) pane.leaves = pane.leaves.map((l) => (ids.has(l.id) ? { ...l, pinned: !l.pinned } : l));
				break;
			}
			case 'undo-close': {
				const entry = this.closed.shift();
				if (entry === undefined) return;
				let pane = m.panes.find((p) => p.id === entry.paneId);
				if (entry.stripClosed) {
					orphan = entry.leaf.id;
					Sim.count(pane === undefined ? 'undo-close:strip-closed' : 'undo-close:strip-closed-id-back');
				}
				if (pane === undefined) {
					pane = { id: entry.paneId, kind: 'main', leaves: [], currentLeafId: null };
					m.panes.push(pane);
				}
				pane.leaves.push(entry.leaf);
				this.show(m, pane, entry.leaf.id);
				break;
			}
			case 'split': {
				const from = m.panes.findIndex((p) => p.leaves.some((l) => l.id === target.id));
				const leaf = this.leaf();
				const pane: MPane = { id: this.fresh('s'), kind: 'main', leaves: [leaf], currentLeafId: leaf.id };
				m.panes.splice(from + 1, 0, pane);
				m.active = leaf.id;
				break;
			}
			case 'activate': {
				const pane = m.panes.find((p) => p.leaves.some((l) => l.id === target.id));
				if (pane === undefined) throw new Error('activate');
				this.show(m, pane, target.id);
				break;
			}
			case 'open-in-place': {
				for (const pane of m.panes) {
					pane.leaves = pane.leaves.map((l) =>
						l.id === target.id ? { ...l, fingerprint: { viewType: 'markdown', path: `other-${String(b)}.md` } } : l,
					);
				}
				break;
			}
			case 'stacked': {
				const pane = pick(m.panes, a);
				pane.stacked = pane.stacked !== true;
				break;
			}
			case 'plugin-reorder': {
				const pane = pick(m.panes, a);
				const i = b % pane.leaves.length;
				const j = c % pane.leaves.length;
				const x = pane.leaves[i];
				const y = pane.leaves[j];
				if (x === undefined || y === undefined) return;
				pane.leaves[i] = y;
				pane.leaves[j] = x;
				break;
			}
		}
		this.log.push(`${kind} ${target.id} ${JSON.stringify(ctx)}`);
		const r = this.settle(this.snapshot, this.freeze(m), this.state, ctx);
		if (orphan !== null) {
			const id = orphan;
			expect(r.state.members.some((x) => x.leafId === id), this.log.join('\n')).toBe(false);
			expect(r.ops.some((op) => op.kind === 'move' && op.leafId === id), this.log.join('\n')).toBe(false);
		}
	}

	private command(kind: (typeof COMMANDS)[number], { a, b, c, d }: Step): void {
		const s = this.snapshot;
		const st = this.state;
		const g = st.groups.length > 0 ? pick(st.groups, d).id : 'none';
		let result: CommandResult;
		switch (kind) {
			case 'createGroup':
				result = createGroup(st, s, this.someLeaves(a, b), c % 2 === 0 ? {} : { name: `n${String(c)}`, color: pick(GROUP_COLORS, c) });
				break;
			case 'addToGroup':
				result = addToGroup(st, s, this.someLeaves(a, b), g);
				break;
			case 'removeFromGroup':
				result = removeFromGroup(st, s, this.someLeaves(a, b));
				break;
			case 'rename':
				result = renameGroup(st, g, `r${String(c)}`);
				break;
			case 'recolor':
				result = recolorGroup(st, g, pick(GROUP_COLORS, c));
				break;
			case 'collapse':
				result = setCollapsed(st, s, g, true);
				break;
			case 'expand':
				result = setCollapsed(st, s, g, false);
				break;
			case 'ungroup':
				result = ungroup(st, g);
				break;
			case 'closeGroup':
				result = closeGroup(st, s, g);
				break;
			case 'collapseOthers':
				result = collapseOthers(st, s, g);
				break;
		}
		this.log.push(`${kind} ${g} ${JSON.stringify(result.ops)}`);
		const closes = result.ops.some((op) => op.kind === 'close');
		const after = this.apply(s, result.ops);
		if (!closes) expect(invariants(after, result.state)).toEqual([]);
		for (const op of result.ops) {
			if (op.kind !== 'close') continue;
			for (const id of op.leafIds) {
				const pane = s.panes.find((p) => p.leaves.some((l) => l.id === id));
				const leaf = pane?.leaves.find((l) => l.id === id);
				if (pane !== undefined && leaf !== undefined) this.closed.unshift({ leaf, paneId: pane.id, stripClosed: false });
			}
			this.closed = this.closed.slice(0, 10);
		}
		const r = this.settle(s, after, result.state, { txnId: 'cmd' });
		// A command alone already gives a consistent result; only closing may let Obsidian
		// show a hidden tab, which the next reconcile then reveals.
		if (!closes) {
			expect(r.ops).toEqual([]);
			expect(r.state).toBe(result.state);
		}
	}

	private apply(s: Snapshot, ops: readonly Op[]): Snapshot {
		// Throws if an op refers to a missing leaf or strip, or uses a bad index.
		return applyOps(s, ops, () => this.fresh('c'));
	}

	/** Reconcile, apply, check invariants and idempotency, and commit. */
	private settle(prev: Snapshot, next: Snapshot, state: GroupState, ctx: { dropIntent?: DropIntent; txnId?: string }) {
		// A strip missing from a snapshot has closed; a later strip with its id is a new one.
		for (const e of this.closed) if (!next.panes.some((p) => p.id === e.paneId)) e.stripClosed = true;
		const r = reconcile(prev, next, state, ctx);
		for (const op of r.ops) Sim.count(`reconcile-op:${op.kind}`);
		for (const e of r.events) Sim.count(`event:${e.kind}`);
		const restored = r.state.members.filter((m) => !state.members.some((x) => x.leafId === m.leafId) && !prev.panes.some((p) => p.leaves.some((l) => l.id === m.leafId)));
		Sim.count('restored-from-tombstone', restored.filter((m) => state.tombstones.some((t) => t.leafId === m.leafId)).length);
		Sim.count('groups-expanded-by-reconcile', r.state.groups.filter((g) => !g.collapsed && state.groups.some((x) => x.id === g.id && x.collapsed)).length);
		const after = this.apply(next, r.ops);
		expect(invariants(after, r.state), this.log.join('\n')).toEqual([]);
		const again = reconcile(next, after, r.state);
		expect(again.ops, this.log.join('\n')).toEqual([]);
		expect(again.state, this.log.join('\n')).toBe(r.state);
		this.snapshot = after;
		this.state = r.state;
		return r;
	}
}
