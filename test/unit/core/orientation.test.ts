/**
 * Step V1: the orientation is an optional field of the version 1 session record. Horizontal
 * records stay exactly what v0.1 wrote; an older reader ignores the field.
 */
import { describe, expect, it } from 'vitest';
import { buildSession, orientationOf, parseSession, SESSION_VERSION, storedColors } from '../../../src/core/persist';
import { groups, snap } from './dsl';

const empty = { groups: [], members: [], tombstones: [], nextGroupSeq: 1 };

describe('orientation in the session record', () => {
	it('is written only when vertical, so a horizontal record is unchanged from v0.1', () => {
		const snapshot = snap('A: a b');
		const horizontal = buildSession(empty, snapshot, []);
		expect('orientation' in horizontal).toBe(false);
		expect(buildSession(empty, snapshot, [], 'horizontal')).toEqual(horizontal);
		const vertical = buildSession(empty, snapshot, [], 'vertical');
		expect(vertical.orientation).toBe('vertical');
		expect(vertical.version).toBe(SESSION_VERSION);
	});

	it('reads back what was written, without problems', () => {
		const state = groups({ G: 'a b' });
		for (const o of ['horizontal', 'vertical'] as const) {
			const written = buildSession(state, snap('A: a b c'), [], o);
			const parsed = parseSession(JSON.parse(JSON.stringify(written)));
			expect(parsed.kind).toBe('ok');
			if (parsed.kind !== 'ok') return;
			expect(parsed.problems).toEqual([]);
			expect(orientationOf(parsed)).toBe(o);
			// The controller compares records as JSON text: the reader's key order matches the writer's.
			expect(JSON.stringify(parsed.session)).toBe(JSON.stringify(written));
		}
	});

	it('treats anything but "vertical" as horizontal, silently (a later version may add values)', () => {
		for (const value of ['sideways', 1, null, true, { a: 1 }, 'VERTICAL']) {
			const parsed = parseSession({ version: 1, nextGroupSeq: 1, groups: [], closed: [], unmatched: [], orientation: value });
			expect(parsed.kind).toBe('ok');
			if (parsed.kind === 'ok') expect(parsed.problems).toEqual([]);
			expect(orientationOf(parsed)).toBe('horizontal');
		}
	});

	it('is horizontal for nothing stored, a newer record and an unreadable one', () => {
		expect(orientationOf(parseSession(null))).toBe('horizontal');
		expect(orientationOf(parseSession({ version: SESSION_VERSION + 1, orientation: 'vertical' }))).toBe('horizontal');
		expect(orientationOf(parseSession({ version: 'x', orientation: 'vertical' }))).toBe('horizontal');
		expect(orientationOf(parseSession({ version: 1, orientation: 'vertical' }))).toBe('vertical');
	});

	it('an older reader that only knows the v0.1 fields still reads a vertical record as a valid session', () => {
		const written = buildSession(empty, snap('A: a'), [], 'vertical');
		// What v0.1 keeps: every field but orientation.
		const { orientation, ...v01 } = written;
		expect(orientation).toBe('vertical');
		const parsed = parseSession(v01);
		expect(parsed.kind).toBe('ok');
		expect(orientationOf(parsed)).toBe('horizontal');
	});
});

describe('storedColors (review round 2: row colours before the layout is ready)', () => {
	it('gives each stored member leaf id its group and colour', () => {
		const written = buildSession(groups({ G: 'a b', H: 'c' }), snap('A: a b c d'), [], 'vertical');
		const colors = storedColors(parseSession(JSON.parse(JSON.stringify(written))));
		expect(colors.members.map((m) => m.leafId).sort()).toEqual(['a', 'b', 'c']);
		const byLeaf = new Map(colors.members.map((m) => [m.leafId, m.groupId]));
		expect(byLeaf.get('a')).toBe(byLeaf.get('b'));
		expect(byLeaf.get('a')).not.toBe(byLeaf.get('c'));
		for (const m of colors.members) expect(colors.groups.some((g) => g.id === m.groupId)).toBe(true);
	});
	it('is empty for nothing stored, a corrupt or a future record', () => {
		for (const v of [null, 'x', { version: 99 }]) expect(storedColors(parseSession(v))).toEqual({ groups: [], members: [] });
	});
});
