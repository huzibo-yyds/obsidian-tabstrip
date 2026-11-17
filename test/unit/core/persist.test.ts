/**
 * Step L6: the stored session (T1) — building it from the model and reading it back. Reading
 * must never throw, whatever is stored: unknown versions are left alone, damaged entries are
 * skipped and reported, huge lists are cut.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSession, parseSession, SESSION_LIMITS, SESSION_VERSION, type Session } from '../../../src/core/persist';
import { restoreSession } from '../../../src/core/restore';
import { groups, snap, tomb } from './dsl';
import { Sim, STEP_KINDS } from './sim';

const RUNS = Math.max(1000, Number(process.env.FC_RUNS ?? 0));

function ok(value: unknown) {
	const r = parseSession(value);
	if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
	return r;
}

function sampleSession(): Session {
	const st = groups(
		{ G: { members: 'g1 g2 g3', name: 'Work 工作', color: 'green', collapsed: true }, H: { members: 'h1', name: '', color: 'cyan' } },
		{ tombstones: [tomb({ leafId: 'x', groupId: 'G', paneId: 'A', paneIndex: 2, indexInGroup: 1, left: 'g1', right: 'g2' })], nextGroupSeq: 7 },
	);
	return buildSession(st, snap('A: a g3 g1 g2 | B: h1'), [{ groupId: 'g4', name: 'Old', color: 'red', collapsed: false, members: [{ type: 'markdown', path: 'old.md' }] }]);
}

describe('buildSession', () => {
	it('stores groups in creation order, members in tab order, with fingerprints', () => {
		const s = sampleSession();
		expect(s.version).toBe(SESSION_VERSION);
		expect(s.nextGroupSeq).toBe(7);
		expect(s.groups).toEqual([
			{
				groupId: 'G',
				name: 'Work 工作',
				color: 'green',
				collapsed: true,
				members: [
					{ leafId: 'g3', type: 'markdown', path: 'g3.md' },
					{ leafId: 'g1', type: 'markdown', path: 'g1.md' },
					{ leafId: 'g2', type: 'markdown', path: 'g2.md' },
				],
			},
			{ groupId: 'H', name: '', color: 'cyan', collapsed: false, members: [{ leafId: 'h1', type: 'markdown', path: 'h1.md' }] },
		]);
		expect(s.closed).toEqual([
			{ leafId: 'x', groupId: 'G', name: 'G', color: 'red', pane: 'A', paneIndex: 2, indexInGroup: 1, left: 'g1', right: 'g2', type: 'markdown', path: 'x.md' },
		]);
		expect(s.unmatched.map((u) => u.groupId)).toEqual(['g4']);
	});

	it('members not in the snapshot go last, sorted by id; a view without a file has no path', () => {
		const st = groups({ G: 'b a c' });
		const withView = { ...st, members: st.members.map((m) => (m.leafId === 'c' ? { ...m, fingerprint: { viewType: 'graph' } } : m)) };
		const s = buildSession(withView, snap('A: c'), []);
		expect(s.groups[0]?.members).toEqual([{ leafId: 'c', type: 'graph' }, { leafId: 'a', type: 'markdown', path: 'a.md' }, { leafId: 'b', type: 'markdown', path: 'b.md' }]);
	});

	it('a tombstone without neighbours is stored with null neighbours', () => {
		const st = groups({}, { tombstones: [tomb({ leafId: 'x', groupId: 'G', paneId: null })] });
		expect(buildSession(st, snap('A: a'), []).closed[0]).toMatchObject({ pane: null, left: null, right: null });
	});
});

describe('parseSession', () => {
	it('round-trips a built session through JSON without problems', () => {
		const s = sampleSession();
		const r = ok(JSON.parse(JSON.stringify(s)));
		expect(r.problems).toEqual([]);
		expect(r.session).toEqual(s);
	});

	it('nothing stored is empty', () => {
		expect(parseSession(null)).toEqual({ kind: 'empty' });
		expect(parseSession(undefined)).toEqual({ kind: 'empty' });
	});

	it.each([['a string', 'x'], ['a number', 3], ['an array', [1, 2]], ['true', true]])('%s is corrupt', (_, value) => {
		expect(parseSession(value).kind).toBe('corrupt');
	});

	it.each([['missing', {}], ['a string', { version: '1' }], ['negative', { version: -1 }], ['fractional', { version: 1.5 }]])(
		'a %s version is corrupt',
		(_, value) => {
			expect(parseSession(value).kind).toBe('corrupt');
		},
	);

	it('a newer version is reported as future and not read', () => {
		expect(parseSession({ version: SESSION_VERSION + 1, groups: 'whatever' })).toEqual({ kind: 'future', version: SESSION_VERSION + 1 });
	});

	it('an older version runs the migration hook; without a migration it is corrupt', () => {
		expect(parseSession({ version: 0 })).toEqual({ kind: 'corrupt', problems: ['no migration from version 0'] });
		const migrated = parseSession({ version: 0, tabGroups: [{ groupId: 'g1', members: [{ leafId: 'a', type: 'markdown' }] }] }, {
			0: (v) => ({ ...v, version: 1, groups: v['tabGroups'] }),
		});
		expect(migrated.kind).toBe('ok');
		if (migrated.kind === 'ok') expect(migrated.session.groups.map((g) => g.groupId)).toEqual(['g1']);
		const failing = parseSession({ version: 0 }, {
			0: () => {
				throw new Error('boom');
			},
		});
		expect(failing).toEqual({ kind: 'corrupt', problems: ['migration from version 0 failed'] });
	});

	it('wrong types in entries are skipped or repaired and reported', () => {
		const r = ok({
			version: 1,
			nextGroupSeq: 'x',
			groups: [
				null,
				{ groupId: '', members: [{ leafId: 'a', type: 'markdown' }] },
				{ groupId: 'g1', name: 42, color: 'magenta', collapsed: 'yes', members: [{ leafId: 'a', type: 'markdown', path: 'a.md' }, { leafId: 'b' }, 'c', { leafId: 'd', type: 'markdown', path: 7 }] },
				{ groupId: 'g1', members: [{ leafId: 'e', type: 'markdown' }] },
				{ groupId: 'g2', members: [{ leafId: 'a', type: 'markdown' }] },
				{ groupId: 'g3', members: 'nope' },
			],
			closed: [{ leafId: 'x', groupId: 'g9', paneIndex: -1, indexInGroup: 0, type: 'markdown' }, { leafId: 'y', groupId: 'g9', paneIndex: 0, indexInGroup: 0, type: 'markdown', pane: 5 }, 'z'],
			unmatched: { groupId: 'u' },
		});
		expect(r.session.groups).toEqual([{ groupId: 'g1', name: '', color: 'grey', collapsed: false, members: [{ leafId: 'a', type: 'markdown', path: 'a.md' }] }]);
		expect(r.session.closed).toEqual([
			{ leafId: 'y', groupId: 'g9', name: '', color: 'grey', pane: null, paneIndex: 0, indexInGroup: 0, left: null, right: null, type: 'markdown' },
		]);
		expect(r.session.unmatched).toEqual([]);
		// Derived from the highest group id seen (g9 in the closed list).
		expect(r.session.nextGroupSeq).toBe(10);
		expect(r.problems.length).toBeGreaterThanOrEqual(10);
		expect(r.problems).toContain('unmatched: not a list');
	});

	it('missing lists are simply empty (no problem); a stored nextGroupSeq below the ids is raised', () => {
		const r = ok({ version: 1, nextGroupSeq: 2, groups: [{ groupId: 'g5', color: 'blue', members: [{ leafId: 'a', type: 'markdown' }] }] });
		expect(r.session.closed).toEqual([]);
		expect(r.session.unmatched).toEqual([]);
		expect(r.session.nextGroupSeq).toBe(6);
		expect(r.problems).toEqual([]);
	});

	it('too long ids and paths are not kept; a too long name is cut and reported', () => {
		const long = 'x'.repeat(SESSION_LIMITS.text + 1);
		const longPath = 'p'.repeat(SESSION_LIMITS.path + 1);
		const r = ok({
			version: 1,
			nextGroupSeq: 1,
			groups: [{ groupId: 'g1', name: long, color: 'blue', members: [{ leafId: 'a', type: 'markdown', path: longPath }, { leafId: long, type: 'markdown' }, { leafId: 'b', type: 'markdown' }, { leafId: 'c', type: 'markdown', path: '' }] }],
		});
		expect(r.session.groups[0]?.name).toBe('x'.repeat(SESSION_LIMITS.name));
		expect(r.session.groups[0]?.members).toEqual([{ leafId: 'b', type: 'markdown' }, { leafId: 'c', type: 'markdown', path: '' }]);
		expect(r.problems).toEqual(['groups[0].members[0]: skipped', 'groups[0].members[1]: skipped', 'groups[0]: name cut']);
	});

	it('huge lists are cut to the limits quickly', () => {
		const member = (i: number) => ({ leafId: `l${String(i)}`, type: 'markdown', path: `n${String(i)}.md` });
		const value = {
			version: 1,
			nextGroupSeq: 1,
			groups: Array.from({ length: 20_000 }, (_, i) => ({ groupId: `g${String(i + 1)}`, members: i === 0 ? Array.from({ length: 50_000 }, (_, k) => member(k)) : [member(100_000 + i)] })),
			closed: Array.from({ length: 50_000 }, (_, i) => ({ leafId: `c${String(i)}`, groupId: 'g1', paneIndex: 0, indexInGroup: 0, type: 'markdown' })),
			unmatched: Array.from({ length: 50_000 }, (_, i) => ({ groupId: `u${String(i)}`, members: [{ type: 'markdown', path: 'x.md' }] })),
		};
		const started = performance.now();
		const r = ok(value);
		const ms = performance.now() - started;
		expect(r.session.groups).toHaveLength(SESSION_LIMITS.groups);
		expect(r.session.groups[0]?.members).toHaveLength(SESSION_LIMITS.membersPerGroup);
		expect(r.session.closed).toHaveLength(SESSION_LIMITS.closed);
		expect(r.session.unmatched).toHaveLength(SESSION_LIMITS.unmatched);
		expect(r.problems.some((p) => p.startsWith('groups: kept the first'))).toBe(true);
		expect(ms).toBeLessThan(100);
	});

	it('the same leaf in two groups stays in the first one only; unmatched ids may not repeat group ids', () => {
		const r = ok({
			version: 1,
			nextGroupSeq: 9,
			groups: [{ groupId: 'g1', members: [{ leafId: 'a', type: 'markdown' }] }, { groupId: 'g2', members: [{ leafId: 'a', type: 'markdown' }, { leafId: 'b', type: 'markdown' }] }],
			unmatched: [{ groupId: 'g1', members: [{ type: 'markdown' }] }, { groupId: 'g3', name: 'U', color: 'pink', collapsed: true, members: [{ type: 'markdown', path: 'u.md' }, 5] }],
		});
		expect(r.session.groups.map((g) => [g.groupId, g.members.map((m) => m.leafId)])).toEqual([['g1', ['a']], ['g2', ['b']]]);
		expect(r.session.unmatched).toEqual([{ groupId: 'g3', name: 'U', color: 'pink', collapsed: true, members: [{ type: 'markdown', path: 'u.md' }] }]);
	});

	it('property: never throws on any value, and an ok result reads back unchanged', () => {
		const anyShape = fc.oneof(
			fc.anything(),
			fc.record({ version: fc.oneof(fc.constant(1), fc.integer()), nextGroupSeq: fc.anything(), groups: fc.anything(), closed: fc.anything(), unmatched: fc.anything() }),
			fc.record({
				version: fc.constant(1),
				nextGroupSeq: fc.nat(),
				groups: fc.array(fc.record({ groupId: fc.string(), name: fc.anything(), color: fc.string(), collapsed: fc.anything(), members: fc.array(fc.record({ leafId: fc.string(), type: fc.string(), path: fc.oneof(fc.string(), fc.constant(undefined)) })) })),
				closed: fc.array(fc.record({ leafId: fc.string(), groupId: fc.string(), paneIndex: fc.integer(), indexInGroup: fc.integer(), type: fc.string(), left: fc.anything() })),
			}),
		);
		fc.assert(
			fc.property(anyShape, (value) => {
				const r = parseSession(value);
				if (r.kind !== 'ok') return;
				const again = parseSession(JSON.parse(JSON.stringify(r.session)));
				expect(again).toEqual({ kind: 'ok', session: r.session, problems: [] });
			}),
			{ numRuns: RUNS },
		);
	});
});

describe('writer and reader agree (review round 1)', () => {
	const weird = fc.oneof(fc.string(), fc.constant(''), fc.string({ minLength: 990, maxLength: 1100 }), fc.constant('x'.repeat(1001)));

	it('an empty path, a 1001-char name and a 1001-char path read back without problems', () => {
		const st = groups({ G: { members: 'a b', name: 'n'.repeat(1001) } });
		const odd = {
			...st,
			members: st.members.map((m) => (m.leafId === 'a' ? { ...m, fingerprint: { viewType: 'markdown', path: '' } } : { ...m, fingerprint: { viewType: 'markdown', path: 'p'.repeat(1001) } })),
		};
		const r = ok(JSON.parse(JSON.stringify(buildSession(odd, snap('A: a b'), []))));
		expect(r.problems).toEqual([]);
		expect(r.session.groups[0]?.members.map((m) => m.leafId)).toEqual(['a', 'b']);
		expect(r.session.groups[0]?.name).toBe('n'.repeat(SESSION_LIMITS.text));
	});

	it(`property: parseSession(buildSession(x)) has no problems for any model state (${String(RUNS)} runs)`, () => {
		const paneSeed = fc.record({ popout: fc.boolean(), size: fc.integer({ min: 1, max: 6 }), pinned: fc.integer({ min: 0, max: 1 }) });
		const step = fc.record({ kind: fc.integer({ min: 0, max: STEP_KINDS - 1 }), a: fc.nat(10_000), b: fc.nat(10_000), c: fc.nat(10_000), d: fc.nat(10_000) });
		let withGroups = 0;
		fc.assert(
			fc.property(
				fc.array(paneSeed, { minLength: 1, maxLength: 3 }),
				fc.array(step, { minLength: 5, maxLength: 40 }),
				fc.array(weird, { minLength: 1, maxLength: 8 }),
				(panes, actions, strings) => {
					const sim = new Sim(panes);
					for (const a of actions) sim.step(a);
					const s = sim.state;
					const pickStr = (i: number) => strings[i % strings.length] ?? '';
					const odd = {
						...s,
						groups: s.groups.map((g, i) => ({ ...g, name: pickStr(i) })),
						members: s.members.map((m, i) => ({ ...m, fingerprint: i % 3 === 0 ? { viewType: m.fingerprint.viewType } : { viewType: m.fingerprint.viewType, path: pickStr(i + 1) } })),
						tombstones: s.tombstones.map((t, i) => ({ ...t, groupName: pickStr(i + 2), fingerprint: { viewType: t.fingerprint.viewType, path: pickStr(i + 3) } })),
					};
					if (odd.groups.length > 0) withGroups++;
					const written = buildSession(odd, sim.snapshot, []);
					const r = ok(JSON.parse(JSON.stringify(written)));
					expect(r.problems).toEqual([]);
					expect(r.session.groups.flatMap((g) => g.members.map((m) => m.leafId))).toEqual(written.groups.flatMap((g) => g.members.map((m) => m.leafId)));
					expect(r.session.closed.length).toBe(written.closed.length);
				},
			),
			{ numRuns: RUNS },
		);
		expect(withGroups).toBeGreaterThan(RUNS / 10);
	});
});

describe('large group ids read back cleanly (review round 2: seq-roundtrip-notice-loop)', () => {
	/** Read → restore → write → read, like two starts in a row. */
	function twoStarts(groupId: string) {
		const first = ok({ version: 1, nextGroupSeq: 1, groups: [{ groupId, name: 'Big', color: 'red', collapsed: false, members: [{ leafId: 'a', type: 'markdown', path: 'a.md' }] }] });
		const s = snap('A: a b');
		const restored = restoreSession(first.session, s);
		const second = ok(JSON.parse(JSON.stringify(buildSession(restored.state, s, restored.unmatched))));
		return { first, second };
	}

	it.each(['g1000000', 'g5000000', 'g999999999'])('%s: the second start reports no problem and keeps the counter', (id) => {
		const { first, second } = twoStarts(id);
		expect(first.problems).toEqual([]);
		expect(second.problems).toEqual([]);
		expect(second.session.nextGroupSeq).toBe(first.session.nextGroupSeq);
		expect(second.session.nextGroupSeq).toBe(Number(id.slice(1)) + 1);
	});

	it(`property: any generated id g1..g999999999 round-trips without problems (${String(RUNS)} runs)`, () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 999_999_999 }), (n) => {
				const { first, second } = twoStarts(`g${String(n)}`);
				expect(first.problems).toEqual([]);
				expect(second.problems).toEqual([]);
			}),
			{ numRuns: RUNS },
		);
	});

	it('positive control: a counter above any generated id is still reported', () => {
		const r = ok({ version: 1, nextGroupSeq: 1_000_000_001, groups: [] });
		expect(r.problems).toEqual(['nextGroupSeq: missing, derived from the group ids']);
		expect(r.session.nextGroupSeq).toBe(1);
	});
});
