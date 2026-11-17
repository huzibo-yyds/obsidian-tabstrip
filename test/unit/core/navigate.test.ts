/**
 * N01: "go to the next / previous tab, skipping collapsed groups" (step L5).
 */
import { describe, expect, it } from 'vitest';
import { isHidden, stepVisible } from '../../../src/core/navigate';
import { emptyState } from '../../../src/core/model';
import { groups, snap } from './dsl';

describe('N01 stepVisible', () => {
	const st = groups({ G: { members: 'g1 g2 g3', collapsed: true }, H: 'h1 h2', K: { members: 'k1', collapsed: true } });

	it('skips hidden members to the right and to the left', () => {
		const s = snap('A: p* a g1 g2 g3 b h1 h2 k1 c', { active: 'a' });
		expect(stepVisible(st, s, 'a', 1)).toBe('b');
		expect(stepVisible(st, s, 'b', -1)).toBe('a');
		// Expanded groups, pinned and ungrouped tabs count normally.
		expect(stepVisible(st, s, 'b', 1)).toBe('h1');
		expect(stepVisible(st, s, 'h2', 1)).toBe('c');
		expect(stepVisible(st, s, 'a', -1)).toBe('p');
	});

	it('wraps around like the native commands, still skipping hidden tabs', () => {
		const s = snap('A: g1 g2 a b k1', { active: 'b' });
		expect(stepVisible(st, s, 'b', 1)).toBe('a');
		expect(stepVisible(st, s, 'a', -1)).toBe('b');
	});

	it('returns null when no other tab is visible or the tab is unknown', () => {
		expect(stepVisible(st, snap('A: a g1 g2 g3', { active: 'a' }), 'a', 1)).toBeNull();
		expect(stepVisible(st, snap('A: a', { active: 'a' }), 'a', -1)).toBeNull();
		expect(stepVisible(st, snap('A: a b'), 'zz', 1)).toBeNull();
	});

	it('stays in the strip of the tab', () => {
		const s = snap('A: a b | B: x g1 y', { active: 'x' });
		expect(stepVisible(st, s, 'x', 1)).toBe('y');
		expect(stepVisible(st, s, 'y', 1)).toBe('x');
		expect(stepVisible(st, s, 'b', 1)).toBe('a');
	});

	it('in a stacked strip nothing is hidden, so collapsed members count', () => {
		const s = snap('A: a g1 g2 b', { active: 'a', stacked: ['A'] });
		expect(stepVisible(st, s, 'a', 1)).toBe('g1');
		expect(isHidden(st, s, 'g1')).toBe(false);
	});

	it('without groups it is plain next / previous', () => {
		const s = snap('A: a b c', { active: 'c' });
		expect(stepVisible(emptyState(), s, 'c', 1)).toBe('a');
		expect(stepVisible(emptyState(), s, 'a', -1)).toBe('c');
	});
});

describe('N02 isHidden', () => {
	it('is true only for members of collapsed groups in strips that hide tabs', () => {
		const st = groups({ G: { members: 'g1', collapsed: true }, H: 'h1' });
		const s = snap('A: a g1 h1', { active: 'a' });
		expect(isHidden(st, s, 'g1')).toBe(true);
		expect(isHidden(st, s, 'h1')).toBe(false);
		expect(isHidden(st, s, 'a')).toBe(false);
		expect(isHidden(st, s, 'zz')).toBe(false);
	});
});
