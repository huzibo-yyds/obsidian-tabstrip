/**
 * Step L6: start-up restore (recovery order 1 leaf id, 3 recently closed, 4 unique fingerprint,
 * 5 unmatched), "Restore unmatched groups", and undo-close after a restart.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { invariants } from '../../../src/core/invariants';
import { buildSession, parseSession, SESSION_LIMITS, type Session, type StoredGroup, type UnmatchedGroup } from '../../../src/core/persist';
import { reconcile } from '../../../src/core/reconcile';
import { dropRevived, restoreSession, restoreUnmatched, windowOf, withoutLeaves } from '../../../src/core/restore';
import type { GroupState, Snapshot } from '../../../src/core/types';
import { apply, fp, group, groups, layout, membership, snap, tomb } from './dsl';
import { at } from '../../../src/core/util';

const RUNS = Math.max(1000, Number(process.env.FC_RUNS ?? 0));

function session(partial: Partial<Session>): Session {
	return { version: 1, nextGroupSeq: 50, groups: [], closed: [], unmatched: [], ...partial };
}

function stored(id: string, members: string, extra: Partial<StoredGroup> = {}): StoredGroup {
	return {
		groupId: id,
		name: id,
		color: 'blue',
		collapsed: false,
		members: members.split(/\s+/).map((m) => ({ leafId: m, type: 'markdown', path: `${m}.md` })),
		...extra,
	};
}

/** Restores, applies the ops, then runs the first pass like the controller; checks invariants. */
function boot(sess: Session, snapshot: Snapshot) {
	const r = restoreSession(sess, snapshot);
	const after = apply(snapshot, r.ops);
	expect(invariants(after, r.state)).toEqual([]);
	const pass = reconcile(withoutLeaves(after, r.returning), after, r.state);
	const final = apply(after, pass.ops);
	expect(invariants(final, pass.state)).toEqual([]);
	const again = reconcile(final, final, pass.state);
	expect(again.ops).toEqual([]);
	return { ...r, after, pass, final };
}

describe('step 1: leaf ids', () => {
	it('restores name, colour, collapsed state, members and creation order without moving tabs', () => {
		const sess = session({
			groups: [stored('g2', 'b c', { name: '工作', color: 'green', collapsed: true }), stored('g1', 'e f', { color: 'red' })],
		});
		const r = boot(sess, snap('A: a b c d e f', { active: 'a' }));
		expect(r.ops).toEqual([]);
		expect(r.state.groups).toEqual([
			{ id: 'g2', name: '工作', color: 'green', collapsed: true },
			{ id: 'g1', name: 'g1', color: 'red', collapsed: false },
		]);
		expect(membership(r.state)).toEqual({ b: 'g2', c: 'g2', e: 'g1', f: 'g1' });
		expect(r.report).toEqual({ byId: 4, byClosed: 0, byFingerprint: 0, missing: 0, restoredGroups: 2, unmatchedGroups: 0, droppedUnmatched: 0 });
		expect(r.state.nextGroupSeq).toBe(50);
	});

	it('a collapsed group that holds the active tab or a strip’s shown tab is expanded; others stay collapsed', () => {
		const sess = session({
			groups: [
				stored('G', 'g1 g2', { collapsed: true }),
				stored('H', 'h1 h2', { collapsed: true }),
				stored('K', 'k1', { collapsed: true }),
			],
		});
		const r = boot(sess, snap('A: a g1 g2 h1 h2 | B: x k1', { active: 'g2', current: { B: 'k1' } }));
		expect(group(r.state, 'G')?.collapsed).toBe(false);
		expect(group(r.state, 'H')?.collapsed).toBe(true);
		expect(group(r.state, 'K')?.collapsed).toBe(false);
	});

	it('in a stacked strip a collapsed group stays collapsed (it hides nothing there)', () => {
		const r = boot(session({ groups: [stored('G', 'g1', { collapsed: true })] }), snap('A: a g1', { active: 'g1', stacked: ['A'] }));
		expect(group(r.state, 'G')?.collapsed).toBe(true);
	});

	it('pinned tabs and tabs that are gone are not restored; a group with some tabs left is kept', () => {
		const r = boot(session({ groups: [stored('G', 'g1 g2 g3')] }), snap('A: g1* g2 a'));
		expect(membership(r.state)).toEqual({ g2: 'G' });
		expect(r.report.missing).toBe(2);
		expect(r.unmatched).toEqual([]);
	});

	it('scattered tabs are lined up in stored order at the leftmost one, never inside another group', () => {
		const sess = session({ groups: [stored('H', 'h1 h2'), stored('G', 'g1 g2 g3')] });
		const r = boot(sess, snap('A: p* g3 h1 h2 x g1 y g2'));
		expect(layout(r.after)).toBe('A: p* g1 g2 g3 h1 h2 x y');
		expect(membership(r.state)).toEqual({ h1: 'H', h2: 'H', g1: 'G', g2: 'G', g3: 'G' });
	});

	it('a contiguous group keeps Obsidian’s order even if it differs from the stored one', () => {
		const r = boot(session({ groups: [stored('G', 'g1 g2 g3')] }), snap('A: a g3 g1 g2 b'));
		expect(r.ops).toEqual([]);
	});

	it('a group split over two strips stays in the strip with most of its tabs', () => {
		const r = boot(session({ groups: [stored('G', 'g1 g2 g3')] }), snap('A: a g1 | B: g2 b g3'));
		expect(membership(r.state)).toEqual({ g2: 'G', g3: 'G' });
		expect(layout(r.after)).toBe('A: a g1 | B: g2 g3 b');
	});
});

describe('step 3: recently closed records', () => {
	it('closed records survive with their strip found again through the neighbours', () => {
		const sess = buildSession(
			groups({ G: 'g1 g3' }, { tombstones: [tomb({ leafId: 'g2', groupId: 'G', paneId: 'p7', paneIndex: 2, indexInGroup: 1, left: 'g1', right: 'g3' })] }),
			snap('A: a g1 g3'),
			[],
		);
		const r = restoreSession(sess, snap('X: a g1 g3 | Y: b'));
		expect(r.state.tombstones.map((t) => [t.leafId, t.paneId])).toEqual([['g2', 'X']]);
		// Neighbour gone: no strip any more. Already stripless: stays null.
		const gone = restoreSession({ ...sess, closed: [{ ...sess.closed[0]!, left: 'zz', right: null }, { ...sess.closed[0]!, leafId: 'q', pane: null }] }, snap('X: a g1 g3'));
		expect(gone.state.tombstones.map((t) => [t.leafId, t.paneId])).toEqual([
			['g2', null],
			['q', null],
		]);
	});

	it('undo-close after a restart puts the tab back into its group and slot', () => {
		const sess = buildSession(
			groups({ G: 'g1 g3' }, { tombstones: [tomb({ leafId: 'g2', groupId: 'G', paneId: 'old', paneIndex: 2, indexInGroup: 1, left: 'g1', right: 'g3' })] }),
			snap('A: a g1 g3 b'),
			[],
		);
		const start = boot(sess, snap('A: a g1 g3 b'));
		// Native undo-close restores the same id at the strip's end.
		const undone = snap('A: a g1 g3 b g2');
		const r = reconcile(start.final, undone, start.pass.state);
		expect(layout(apply(undone, r.ops))).toBe('A: a g1 g2 g3 b');
		expect(membership(r.state).g2).toBe('G');
	});

	it('a tab with a closed record that is open at start-up goes back like an undo-close (step 3)', () => {
		// Disabled plugin, native undo-close, plugin enabled again: g2 is open again at the end.
		const sess = buildSession(
			groups({ G: 'g1 g3' }, { tombstones: [tomb({ leafId: 'g2', groupId: 'G', paneId: 'old', paneIndex: 2, indexInGroup: 1, left: 'g1', right: 'g3' })] }),
			snap('A: a g1 g3 b'),
			[],
		);
		const r = boot(sess, snap('A: a g1 g3 b g2'));
		expect(r.returning).toEqual(['g2']);
		expect(r.report.byClosed).toBe(1);
		expect(layout(r.final)).toBe('A: a g1 g2 g3 b');
		expect(membership(r.pass.state).g2).toBe('G');
		expect(r.pass.state.tombstones).toEqual([]);
	});

	it('the group of a returning tab was deleted: it is rebuilt with the recorded name and colour', () => {
		const sess = session({
			closed: [{ leafId: 'g1', groupId: 'g4', name: 'Gone', color: 'pink', pane: 'old', paneIndex: 1, indexInGroup: 0, left: 'a', right: 'b', type: 'markdown', path: 'g1.md' }],
		});
		const r = boot(sess, snap('A: a b g1'));
		expect(layout(r.final)).toBe('A: a g1 b');
		expect(r.pass.state.groups).toEqual([{ id: 'g4', name: 'Gone', color: 'pink', collapsed: false }]);
	});

	it('a returning tab whose strip is gone stays ungrouped where it is', () => {
		const sess = session({
			closed: [{ leafId: 'g1', groupId: 'g4', name: 'Gone', color: 'pink', pane: 'old', paneIndex: 1, indexInGroup: 0, left: 'zz', right: null, type: 'markdown', path: 'g1.md' }],
		});
		const r = boot(sess, snap('A: a b | B: g1'));
		expect(layout(r.final)).toBe('A: a b | B: g1');
		expect(r.pass.state.groups).toEqual([]);
	});

	it('a tab found by leaf id is not taken by a closed record', () => {
		const sess = session({
			groups: [stored('G', 'g1')],
			closed: [{ leafId: 'g1', groupId: 'g9', name: 'X', color: 'red', pane: 'p', paneIndex: 0, indexInGroup: 0, left: null, right: null, type: 'markdown', path: 'g1.md' }],
		});
		const r = boot(sess, snap('A: g1'));
		expect(r.returning).toEqual([]);
		expect(membership(r.pass.state)).toEqual({ g1: 'G' });
	});
});

describe('step 4: unique file fingerprint', () => {
	const paths = { n1: 'g1.md', n2: 'g2.md', n3: 'g3.md' };

	it('new leaf ids (another device’s layout): found by file, in stored order', () => {
		const sess = session({ groups: [stored('G', 'g1 g2 g3', { name: 'Work', color: 'red', collapsed: true })] });
		const r = boot(sess, snap('A: a n2 n1 b n3', { paths, active: 'a' }));
		expect(r.report).toMatchObject({ byId: 0, byFingerprint: 3, restoredGroups: 1 });
		expect(layout(r.after)).toBe('A: a n1 n2 n3 b');
		expect(r.state.groups).toEqual([{ id: 'G', name: 'Work', color: 'red', collapsed: true }]);
		expect(r.state.members.map((m) => m.leafId)).toEqual(['n1', 'n2', 'n3']);
	});

	it('mixed: some members by id, the rest by fingerprint in the same window', () => {
		const sess = session({ groups: [stored('G', 'g1 g2 g3')] });
		const r = boot(sess, snap('A: g1 n2 | P: n3', { paths, popouts: ['P'] }));
		expect(r.report).toMatchObject({ byId: 1, byFingerprint: 1, missing: 1 });
		expect(membership(r.state)).toEqual({ g1: 'G', n2: 'G' });
	});

	it('two open tabs of the same file in the window: ambiguous, not matched', () => {
		const r = boot(session({ groups: [stored('G', 'g1')] }), snap('A: n1 m1', { paths: { n1: 'g1.md', m1: 'g1.md' } }));
		expect(r.state.groups).toEqual([]);
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['G']);
	});

	it('the same file in two windows: the window with most unique matches wins', () => {
		const sess = session({ groups: [stored('G', 'g1 g2')] });
		const r = boot(sess, snap('A: n1 | P: m1 m2', { paths: { n1: 'g1.md', m1: 'g1.md', m2: 'g2.md' }, popouts: ['P'] }));
		expect(membership(r.state)).toEqual({ m1: 'G', m2: 'G' });
		expect(windowOf(r.after.panes[1]!)).toBe('popout:P');
	});

	it('strips of one window share it (windowId), so uniqueness counts across them', () => {
		const base = snap('A: n1 | B: m1', { paths: { n1: 'g1.md', m1: 'g1.md' } });
		const r = boot(session({ groups: [stored('G', 'g1')] }), base);
		expect(r.state.groups).toEqual([]);
		const split = { ...base, panes: base.panes.map((p, i) => ({ ...p, windowId: `w${String(i)}` })) };
		const r2 = boot(session({ groups: [stored('G', 'g1')] }), split);
		expect(membership(r2.state)).toEqual({ n1: 'G' });
	});

	it('empty tabs never match by fingerprint; views without a file match by type', () => {
		const sess = session({
			groups: [
				{ groupId: 'E', name: '', color: 'grey', collapsed: false, members: [{ leafId: 'e', type: 'empty' }] },
				{ groupId: 'V', name: '', color: 'grey', collapsed: false, members: [{ leafId: 'v', type: 'graph' }] },
			],
		});
		const base = snap('A: x y');
		const s: Snapshot = {
			...base,
			panes: [{ ...base.panes[0]!, leaves: [{ id: 'x', pinned: false, fingerprint: { viewType: 'empty' } }, { id: 'y', pinned: false, fingerprint: { viewType: 'graph' } }] }],
		};
		const r = boot(sess, s);
		expect(membership(r.state)).toEqual({ y: 'V' });
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['E']);
	});

	it('tabs already taken by id or by another group are not candidates', () => {
		const sess = session({ groups: [stored('G', 'g1'), stored('H', 'zz', { members: [{ leafId: 'zz', type: 'markdown', path: 'g1.md' }] })] });
		const r = boot(sess, snap('A: g1'));
		expect(membership(r.state)).toEqual({ g1: 'G' });
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['H']);
	});
});

describe('step 5: unmatched groups', () => {
	const old: UnmatchedGroup = { groupId: 'g9', name: 'Older', color: 'yellow', collapsed: false, members: [{ type: 'markdown', path: 'old.md' }] };

	it('a group with no tab found is parked (newest first) with its fingerprints', () => {
		const r = boot(session({ groups: [stored('G', 'g1 g2', { name: 'Lost', color: 'purple', collapsed: true })], unmatched: [old] }), snap('A: a'));
		expect(r.state.groups).toEqual([]);
		expect(r.unmatched).toEqual([
			{ groupId: 'G', name: 'Lost', color: 'purple', collapsed: true, members: [{ type: 'markdown', path: 'g1.md' }, { type: 'markdown', path: 'g2.md' }] },
			old,
		]);
		expect(r.report.unmatchedGroups).toBe(1);
	});

	it('the list is capped (oldest dropped) and the drop is reported, never silent (review round 5)', () => {
		const cap = SESSION_LIMITS.unmatched;
		const many = Array.from({ length: cap }, (_, i) => ({ ...old, groupId: `u${String(i)}` }));
		const r = restoreSession(session({ groups: [stored('G', 'g1')], unmatched: many }), snap('A: a'));
		expect(r.unmatched).toHaveLength(cap);
		expect(r.unmatched[0]?.groupId).toBe('G');
		expect(r.unmatched.at(-1)?.groupId).toBe(`u${String(cap - 2)}`);
		expect(r.report.unmatchedGroups).toBe(1);
		expect(r.report.droppedUnmatched).toBe(1);
		// Positive control: under the cap nothing is dropped.
		const few = restoreSession(session({ groups: [stored('G', 'g1')], unmatched: many.slice(0, 3) }), snap('A: a'));
		expect(few.unmatched).toHaveLength(4);
		expect(few.report.droppedUnmatched).toBe(0);
	});

	it('every group of one restart fits the list: as many unmatched entries as stored groups are kept (review round 5)', () => {
		expect(SESSION_LIMITS.unmatched).toBeGreaterThanOrEqual(SESSION_LIMITS.groups);
		const all = Array.from({ length: SESSION_LIMITS.groups }, (_, i) => stored(`g${String(i + 1)}`, `m${String(i)}`));
		const r = restoreSession(session({ groups: all }), snap('A: a'));
		expect(r.unmatched).toHaveLength(SESSION_LIMITS.groups);
		expect(r.report.unmatchedGroups).toBe(SESSION_LIMITS.groups);
		expect(r.report.droppedUnmatched).toBe(0);
		// It is saved and read back whole.
		const back = parseSession(JSON.parse(JSON.stringify(buildSession(r.state, snap('A: a'), r.unmatched))));
		expect(back.kind === 'ok' ? [back.session.unmatched.length, back.problems] : null).toEqual([SESSION_LIMITS.groups, []]);
	});

	it('30 stored and 25 new unmatched groups: all 55 kept, the notice count is the 25 new ones (review round 5)', () => {
		const stored30 = Array.from({ length: 30 }, (_, i) => ({ ...old, groupId: `u${String(i)}` }));
		const new25 = Array.from({ length: 25 }, (_, i) => stored(`n${String(i)}`, `z${String(i)}`));
		const r = restoreSession(session({ groups: new25, unmatched: stored30 }), snap('A: a'));
		expect(r.unmatched).toHaveLength(55);
		expect(r.report).toMatchObject({ unmatchedGroups: 25, droppedUnmatched: 0 });
	});

	it('"Restore unmatched groups" recreates groups from free tabs whose files match', () => {
		const lost: UnmatchedGroup = { groupId: 'G', name: 'Lost', color: 'purple', collapsed: true, members: [{ type: 'markdown', path: 'g1.md' }, { type: 'markdown', path: 'g2.md' }] };
		const st = groups({ H: 'h1' });
		const s = snap('A: x2 h1 x1 y', { paths: { x1: 'g1.md', x2: 'g2.md' }, active: 'y' });
		const r = restoreUnmatched(st, s, [lost, old]);
		const after = apply(s, r.ops);
		expect(invariants(after, r.state)).toEqual([]);
		expect(layout(after)).toBe('A: x1 x2 h1 y');
		expect(group(r.state, 'G')).toEqual({ id: 'G', name: 'Lost', color: 'purple', collapsed: true });
		expect(membership(r.state)).toEqual({ h1: 'H', x1: 'G', x2: 'G' });
		expect(r.restored).toEqual([lost]);
		expect(r.remaining).toEqual([old]);
		expect(reconcile(after, after, r.state).ops).toEqual([]);
	});

	it('a recreated group gets a fresh id when its old id is in use; grouped tabs are never taken', () => {
		const lost: UnmatchedGroup = { groupId: 'H', name: 'Lost', color: 'red', collapsed: false, members: [{ type: 'markdown', path: 'h1.md' }, { type: 'markdown', path: 'q.md' }] };
		const st = groups({ H: 'h1' }, { nextGroupSeq: 12 });
		const s = snap('A: h1 q', { active: 'q' });
		const r = restoreUnmatched(st, s, [lost]);
		expect(membership(r.state)).toEqual({ h1: 'H', q: 'g12' });
		expect(group(r.state, 'g12')?.name).toBe('Lost');
	});

	it('nothing matches: state unchanged, all remain', () => {
		const st = groups({ H: 'h1' });
		const r = restoreUnmatched(st, snap('A: h1'), [old]);
		expect(r.state).toBe(st);
		expect(r.ops).toEqual([]);
		expect(r.restored).toEqual([]);
		expect(r.remaining).toEqual([old]);
	});

	it('a member with several matching tabs takes the leftmost free one (the user asked for it)', () => {
		const dup: UnmatchedGroup = { groupId: 'G', name: 'DupU', color: 'red', collapsed: false, members: [{ type: 'markdown', path: 'n5.md' }, { type: 'markdown', path: 'n6.md' }] };
		const s = snap('A: a n5a n6 n5b', { paths: { n5a: 'n5.md', n5b: 'n5.md', n6: 'n6.md' }, active: 'a' });
		const r = restoreUnmatched(groups({}), s, [dup]);
		const after = apply(s, r.ops);
		expect(invariants(after, r.state)).toEqual([]);
		expect(membership(r.state)).toEqual({ n5a: 'G', n6: 'G' });
		expect(layout(after)).toBe('A: a n5a n6 n5b');
		expect(r.restored).toEqual([dup]);
		expect(r.remaining).toEqual([]);
		expect(r.leftMembers).toBe(0);
	});

	it('members without a matching tab stay in the list as a smaller group with a fresh id', () => {
		const part: UnmatchedGroup = {
			groupId: 'G',
			name: 'Part',
			color: 'green',
			collapsed: true,
			members: [{ type: 'markdown', path: 'n5.md' }, { type: 'markdown', path: 'n7.md' }, { type: 'markdown', path: 'n6.md' }],
		};
		const st = groups({}, { nextGroupSeq: 30 });
		const s = snap('A: a n5 n6', { paths: { n5: 'n5.md', n6: 'n6.md' }, active: 'a' });
		const r = restoreUnmatched(st, s, [part]);
		expect(membership(r.state)).toEqual({ n5: 'G', n6: 'G' });
		expect(r.restored).toEqual([part]);
		expect(r.remaining).toEqual([{ groupId: 'g30', name: 'Part', color: 'green', collapsed: true, members: [{ type: 'markdown', path: 'n7.md' }] }]);
		expect(r.leftMembers).toBe(1);
		expect(r.state.nextGroupSeq).toBe(31);
		// The kept part comes back later, once its file is open, under its own id.
		const s2 = snap('A: a n5 n6 n7', { paths: { n5: 'n5.md', n6: 'n6.md', n7: 'n7.md' }, active: 'a' });
		const r2 = restoreUnmatched(r.state, s2, r.remaining);
		expect(membership(r2.state)).toEqual({ n5: 'G', n6: 'G', n7: 'g30' });
		expect(group(r2.state, 'g30')).toEqual({ id: 'g30', name: 'Part', color: 'green', collapsed: true });
		expect(r2.remaining).toEqual([]);
	});

	it('a member whose only match is in another strip of the same window stays in the list (L6 review round 6)', () => {
		const u: UnmatchedGroup = { groupId: 'U', name: 'Split', color: 'blue', collapsed: false, members: [{ type: 'markdown', path: 'a.md' }, { type: 'markdown', path: 'b.md' }] };
		const st = groups({}, { nextGroupSeq: 9 });
		const s = snap('A: x a | B: y b', { paths: { a: 'a.md', b: 'b.md' } });
		const r = restoreUnmatched(st, s, [u]);
		const after = apply(s, r.ops);
		expect(invariants(after, r.state)).toEqual([]);
		expect(membership(r.state)).toEqual({ a: 'U' });
		expect(r.restored).toEqual([u]);
		expect(r.remaining).toEqual([{ groupId: 'g9', name: 'Split', color: 'blue', collapsed: false, members: [{ type: 'markdown', path: 'b.md' }] }]);
		expect(r.leftMembers).toBe(1);
		// Once b.md is open in the group's strip too, running the command again brings it back.
		const s2 = snap('A: x a b2 | B: y b', { paths: { a: 'a.md', b: 'b.md', b2: 'b.md' } });
		const r2 = restoreUnmatched(r.state, s2, r.remaining);
		expect(membership(r2.state)).toEqual({ a: 'U', b2: 'g9' });
		expect(r2.remaining).toEqual([]);
	});

	it('a member whose leftmost match is in another strip takes its copy in the group strip', () => {
		const u: UnmatchedGroup = {
			groupId: 'U',
			name: 'Split',
			color: 'blue',
			collapsed: false,
			members: [{ type: 'markdown', path: 'a.md' }, { type: 'markdown', path: 'b.md' }, { type: 'markdown', path: 'c.md' }],
		};
		// Leftmost in the window: a (B), b1 (A), c (B). The group strip is B (two of three), and B
		// has its own copy of b.md.
		const s = snap('A: b1 | B: a c b2', { paths: { a: 'a.md', b1: 'b.md', b2: 'b.md', c: 'c.md' } });
		const r = restoreUnmatched(groups({}), s, [u]);
		const after = apply(s, r.ops);
		expect(invariants(after, r.state)).toEqual([]);
		expect(membership(r.state)).toEqual({ a: 'U', b2: 'U', c: 'U' });
		expect(layout(after)).toBe('A: b1 | B: a c b2');
		expect(r.remaining).toEqual([]);
		expect(r.leftMembers).toBe(0);
	});

	it('a recreated collapsed group holding the shown tab is expanded', () => {
		const lost: UnmatchedGroup = { groupId: 'G', name: '', color: 'red', collapsed: true, members: [{ type: 'markdown', path: 'q.md' }] };
		const r = restoreUnmatched(groups({}), snap('A: a q', { active: 'q' }), [lost]);
		expect(group(r.state, 'G')?.collapsed).toBe(false);
	});
});

describe('a parked group that a returning closed tab rebuilds (review round 3)', () => {
	// Stored: G = [a] (a is gone now); recently closed: b from G, and b is open again (undo-close
	// while the plugin was off, or after a restart).
	const closedB = {
		leafId: 'b',
		groupId: 'g7',
		name: 'G',
		color: 'red',
		pane: 'old',
		paneIndex: 1,
		indexInGroup: 1,
		left: 'x',
		right: null,
		type: 'markdown',
		path: 'b.md',
	} as const;
	const sess = session({ groups: [stored('g7', 'a', { name: 'G', color: 'red' })], closed: [closedB] });

	/** Saves the state after the first pass and reads it back. */
	function roundTrip(state: GroupState, s: Snapshot, unmatched: readonly UnmatchedGroup[]) {
		const back = parseSession(JSON.parse(JSON.stringify(buildSession(state, s, unmatched))));
		expect(back.kind).toBe('ok');
		return back.kind === 'ok' ? back : null;
	}

	it('is not parked: it comes back once, through step 3, and the saved record reads back cleanly', () => {
		const r = boot(sess, snap('A: x b y'));
		expect(r.unmatched).toEqual([]);
		expect(r.report.unmatchedGroups).toBe(0);
		expect(r.report.missing).toBe(1);
		expect(r.returning).toEqual(['b']);
		expect(r.pass.state.groups).toEqual([{ id: 'g7', name: 'G', color: 'red', collapsed: false }]);
		expect(membership(r.pass.state)).toEqual({ b: 'g7' });
		const back = roundTrip(r.pass.state, r.final, r.unmatched);
		expect(back?.problems).toEqual([]);
		expect(back?.session.unmatched).toEqual([]);
		expect(back?.session.groups.map((g) => g.groupId)).toEqual(['g7']);
	});

	it('"Restore unmatched groups" afterwards makes no second group G', () => {
		const r = boot(sess, snap('A: x b y'));
		const s2 = snap('A: x b y a');
		const p2 = reconcile(r.final, s2, r.pass.state);
		const u = restoreUnmatched(p2.state, apply(s2, p2.ops), r.unmatched);
		expect(u.state.groups.filter((g) => g.name === 'G')).toHaveLength(1);
	});

	it('an older unmatched entry with the same id is dropped too; other entries stay', () => {
		const other: UnmatchedGroup = { groupId: 'g3', name: 'H', color: 'blue', collapsed: false, members: [{ type: 'markdown', path: 'h.md' }] };
		const old: UnmatchedGroup = { groupId: 'g7', name: 'G', color: 'red', collapsed: false, members: [{ type: 'markdown', path: 'a.md' }] };
		const r = boot(session({ closed: [closedB], unmatched: [old, other] }), snap('A: x b y'));
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['g3']);
		expect(roundTrip(r.pass.state, r.final, r.unmatched)?.problems).toEqual([]);
	});

	it('positive control: a group with no returning closed tab is still parked', () => {
		const r = boot(sess, snap('A: x y'));
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['g7']);
		expect(r.report.unmatchedGroups).toBe(1);
		expect(r.pass.state.groups).toEqual([]);
	});

	it('in a running session: undo-close rebuilds a parked group; dropRevived keeps one copy and the record reads back cleanly', () => {
		// At start b is closed (not open): G is parked, the closed record stays.
		const start = boot(sess, snap('A: x y'));
		expect(start.unmatched.map((u) => u.groupId)).toEqual(['g7']);
		// Native undo-close brings b back at the strip's end; the pass rebuilds g7 from its record.
		const undone = snap('A: x y b');
		const pass = reconcile(start.final, undone, start.pass.state);
		expect(pass.state.groups.map((g) => g.id)).toEqual(['g7']);
		const final = apply(undone, pass.ops);
		// Without the guard the record holds g7 twice and reads back with a problem.
		expect(roundTrip(pass.state, final, start.unmatched)?.problems).toEqual(['unmatched[0]: missing or duplicate id']);
		const kept = dropRevived(start.unmatched, pass.state);
		expect(kept).toEqual([]);
		expect(roundTrip(pass.state, final, kept)?.problems).toEqual([]);
		// No live group with that id: the list is returned as it is.
		expect(dropRevived(start.unmatched, start.pass.state)).toBe(start.unmatched);
	});
});

describe('a returning closed tab that cannot rebuild its group (review round 5)', () => {
	// Stored: G = [a] (a is gone, its file not open); recently closed: b from G with neighbour a
	// only. b is open again (undo-close while the plugin was off, or a crash before the save).
	const closedB = {
		leafId: 'b',
		groupId: 'g7',
		name: 'G',
		color: 'red',
		pane: 'old',
		paneIndex: 1,
		indexInGroup: 1,
		left: 'a',
		right: null,
		type: 'markdown',
		path: 'b.md',
	} as const;
	const sess = session({ groups: [stored('g7', 'a', { name: 'G', color: 'red' })], closed: [closedB] });

	it('neighbours gone (no strip for the record): b stays ungrouped and G is parked, not lost', () => {
		const r = boot(sess, snap('A: x b y'));
		expect(r.pass.state.groups).toEqual([]);
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['g7']);
		expect(r.unmatched[0]?.members).toEqual([{ type: 'markdown', path: 'a.md' }]);
		expect(r.report.unmatchedGroups).toBe(1);
	});

	it('b is back in another strip than its neighbour: G is parked', () => {
		const r = boot({ ...sess, closed: [{ ...closedB, left: 'x' }] }, snap('A: x y | B: b'));
		expect(r.pass.state.groups).toEqual([]);
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['g7']);
	});

	it('b is pinned: G is parked', () => {
		const r = boot(sess, snap('A: b* x y'));
		expect(r.unmatched.map((u) => u.groupId)).toEqual(['g7']);
	});

	it('positive control: b can go back (neighbour in its strip), G is rebuilt once and not parked', () => {
		const r = boot({ ...sess, closed: [{ ...closedB, left: 'x' }] }, snap('A: x y b'));
		expect(r.pass.state.groups.map((g) => g.id)).toEqual(['g7']);
		expect(r.unmatched).toEqual([]);
	});
});

describe('withoutLeaves', () => {
	it('drops the tabs and moves a strip’s shown tab and the active tab off them', () => {
		const s = withoutLeaves(snap('A: a b | B: c', { active: 'b' }), ['b', 'c']);
		expect(layout(s)).toBe('A: a | B:');
		expect(s.panes.map((p) => p.currentLeafId)).toEqual(['a', null]);
		expect(s.activeLeafId).toBeNull();
		const same = snap('A: a');
		expect(withoutLeaves(same, [])).toBe(same);
	});
});

describe('restore properties', () => {
	/**
	 * Random strips and a random valid state; some grouped tabs are closed before the save (so the
	 * record holds closed entries). At the next start: the same or new ids, a shuffle, a pinned first
	 * tab, some tabs gone, and some closed tabs open again (they keep their id, like undo-close), at
	 * the end of the first or of the last strip.
	 */
	const scenario = fc
		.record({
			sizes: fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 3 }),
			groupCuts: fc.array(fc.integer({ min: 0, max: 7 }), { maxLength: 6 }),
			collapsed: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
			renameIds: fc.boolean(),
			shuffle: fc.array(fc.nat(), { maxLength: 10 }),
			pinFirst: fc.boolean(),
			close: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
			gone: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
			reopen: fc.array(fc.constantFrom('no', 'first', 'last'), { minLength: 8, maxLength: 8 }),
		})
		.map(({ sizes, groupCuts, collapsed, renameIds, shuffle, pinFirst, close, gone, reopen }) => {
			const specs = sizes.map((n, p) => `S${String(p)}: ${Array.from({ length: n }, (_, i) => `l${String(p)}_${String(i)}`).join(' ')}`);
			const s = snap(specs.join(' | '));
			// Groups: consecutive runs in the first strip.
			const first = s.panes[0]!.leaves.map((l) => l.id);
			const spec: Record<string, string> = {};
			let at = 0;
			groupCuts.forEach((len, i) => {
				const ids = first.slice(at, at + len + 1);
				at += len + 1;
				if (ids.length > 0) spec[`g${String(i + 1)}`] = ids.join(' ');
			});
			const base = groups(spec);
			const state: GroupState = { ...base, groups: base.groups.map((g, i) => ({ ...g, collapsed: collapsed[i] ?? false })), nextGroupSeq: 20 };
			// Close some grouped tabs of the first strip: the pass makes the closed records.
			const grouped = new Set(state.members.map((m) => m.leafId));
			const closed = first.filter((id, i) => close[i] === true && grouped.has(id));
			const afterClose = withoutLeaves(s, closed);
			const saved = closed.length === 0 ? { state, snapshot: s } : { state: reconcile(s, afterClose, state).state, snapshot: afterClose };
			// The layout at the next start.
			const back = closed.filter((id) => reopen[first.indexOf(id)] !== 'no');
			const rename = (id: string) => (renameIds ? `r_${id}` : id);
			const panes = afterClose.panes.map((p, pi) => {
				const kept = p.leaves.filter((l) => !(pi === 0 && gone[first.indexOf(l.id)] === true));
				const leaves = kept.map((l, i) => ({ id: rename(l.id), pinned: pinFirst && i === 0, fingerprint: fp(l.id) }));
				for (const [k, v] of shuffle.entries()) {
					if (leaves.length === 0) break;
					const a = k % leaves.length;
					const b = v % leaves.length;
					[leaves[a], leaves[b]] = [leaves[b]!, leaves[a]!];
				}
				const last = pi === afterClose.panes.length - 1;
				for (const id of back) {
					const where = reopen[first.indexOf(id)];
					if ((where === 'first' && pi === 0) || (where === 'last' && last && !(pi === 0 && afterClose.panes.length > 1))) {
						leaves.push({ id, pinned: false, fingerprint: fp(id) });
					}
				}
				const sorted = [...leaves.filter((l) => l.pinned), ...leaves.filter((l) => !l.pinned)];
				return { ...p, leaves: sorted, currentLeafId: sorted[sorted.length - 1]?.id ?? null };
			});
			const live = panes.filter((p) => p.leaves.length > 0);
			const next: Snapshot = { panes: live, activeLeafId: live[0]?.currentLeafId ?? null };
			return { stored: buildSession(saved.state, saved.snapshot, []), next };
		})
		.filter(({ next }) => next.panes.length > 0);

	it('restore + first pass always satisfies the invariants and is a fixed point', () => {
		fc.assert(
			fc.property(scenario, ({ stored: sess, next }) => {
				const r = boot(sess, next);
				// Every stored group is live after the first pass or parked, never lost silently.
				const live = new Set(r.pass.state.groups.map((g) => g.id));
				const parked = new Set(r.unmatched.map((u) => u.groupId));
				for (const g of sess.groups) expect(live.has(g.groupId) || parked.has(g.groupId)).toBe(true);
			}),
			{ numRuns: RUNS },
		);
	});

	it('the generator makes the hard cases (closed records, returning tabs, groups with no tab left)', () => {
		const seen = { closed: 0, returning: 0, revivedOrParked: 0 };
		fc.assert(
			fc.property(scenario, ({ stored: sess, next }) => {
				const r = restoreSession(sess, next);
				if (sess.closed.length > 0) seen.closed++;
				if (r.returning.length > 0) seen.returning++;
				const open = new Set(next.panes.flatMap((p) => p.leaves.map((l) => l.id)));
				if (r.returning.length > 0 && sess.groups.some((g) => g.members.every((m) => !open.has(m.leafId)))) seen.revivedOrParked++;
			}),
			{ numRuns: RUNS },
		);
		expect(seen.closed).toBeGreaterThan(RUNS / 10);
		expect(seen.returning).toBeGreaterThan(RUNS / 20);
		expect(seen.revivedOrParked).toBeGreaterThan(0);
	});
});

describe('performance', () => {
	it('restoring 50 tabs in 10 groups (by id, and by fingerprint) takes well under 20 ms', () => {
		const ids = Array.from({ length: 50 }, (_, i) => `t${String(i)}`);
		const spec: Record<string, string> = {};
		for (let g = 0; g < 10; g++) spec[`g${String(g + 1)}`] = ids.slice(g * 5, g * 5 + 4).join(' ');
		const s = snap(`A: ${ids.join(' ')}`);
		const sess = buildSession(groups(spec), s, []);
		const renamed: Snapshot = { ...s, panes: s.panes.map((p) => ({ ...p, leaves: p.leaves.map((l) => ({ ...l, id: `n${l.id}` })), currentLeafId: `n${p.currentLeafId ?? ''}` })), activeLeafId: null };
		for (const target of [s, renamed]) {
			const times: number[] = [];
			for (let i = 0; i < 60; i++) {
				const started = performance.now();
				const r = restoreSession(sess, target);
				times.push(performance.now() - started);
				expect(r.state.groups).toHaveLength(10);
			}
			times.sort((a, b) => a - b);
			expect(times[30]!).toBeLessThan(2);
		}
	});
});

describe('"Restore unmatched groups" never loses a member (property, L6 review round 6)', () => {
	const PATHS = ['a.md', 'b.md', 'c.md', 'd.md'];
	const scenario = fc.record({
		strips: fc.array(fc.array(fc.integer({ min: 0, max: PATHS.length }), { maxLength: 5 }), { minLength: 1, maxLength: 3 }),
		popout: fc.boolean(),
		members: fc.array(fc.integer({ min: 0, max: PATHS.length - 1 }), { minLength: 1, maxLength: 4 }),
	});

	it('each identifying member is either a tab of the recreated group or kept in the list', () => {
		let crossStrip = 0;
		fc.assert(
			fc.property(scenario, ({ strips, popout, members }) => {
				let n = 0;
				const paths: Record<string, string> = {};
				const spec = strips
					.map((tabs, si) => {
						const ids = tabs.map((p) => {
							const id = `t${String(n++)}`;
							// Index PATHS.length: a tab of a file no member names.
							paths[id] = PATHS[p] ?? 'other.md';
							return id;
						});
						return `S${String(si)}: ${ids.join(' ')}`;
					})
					.join(' | ');
				const s = snap(spec, { paths, popouts: popout ? ['S1'] : [] });
				if (s.panes.every((p) => p.leaves.length === 0)) return;
				const u: UnmatchedGroup = { groupId: 'U', name: 'P', color: 'red', collapsed: false, members: members.map((p) => ({ type: 'markdown', path: at(PATHS, p) })) };
				const r = restoreUnmatched(groups({}), s, [u]);
				const after = apply(s, r.ops);
				expect(invariants(after, r.state)).toEqual([]);
				const grouped = r.state.members.length;
				if (r.restored.length === 0) {
					expect(r.remaining).toEqual([u]);
					return;
				}
				expect(grouped + r.leftMembers).toBe(u.members.length);
				expect(r.remaining.reduce((k, g) => k + g.members.length, 0)).toBe(r.leftMembers);
				const panesWithMatch = new Set(s.panes.filter((p) => p.leaves.some((l) => members.some((m) => l.fingerprint.path === PATHS[m]))).map((p) => p.id));
				if (panesWithMatch.size > 1) crossStrip++;
			}),
			{ numRuns: RUNS },
		);
		expect(crossStrip).toBeGreaterThan(RUNS / 10);
	});
});
