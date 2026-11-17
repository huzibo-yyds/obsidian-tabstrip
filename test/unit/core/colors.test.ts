import { describe, expect, it } from 'vitest';
import { colorForNewGroup, pickColor } from '../../../src/core/model';
import { GROUP_COLORS } from '../../../src/core/types';
import { groups, snap } from './dsl';

describe('colorForNewGroup (Chrome: least used colour in the window)', () => {
	it('starts with grey, then follows Chrome order', () => {
		const s = snap('A: a b c d');
		expect(colorForNewGroup(groups({}), s, new Set(['A']))).toBe('grey');
		const one = groups({ G: { members: 'a', color: 'grey' } });
		expect(colorForNewGroup(one, s, new Set(['A']))).toBe('blue');
	});

	it('counts only groups whose members are in the given strips (one window)', () => {
		const s = snap('A: a b | B: x y | W: p q', { popouts: ['W'] });
		const st = groups({
			G1: { members: 'a', color: 'grey' },
			G2: { members: 'x', color: 'blue' },
			G3: { members: 'p', color: 'grey' },
		});
		// Main window = strips A and B: grey and blue are used once each, red is free.
		expect(colorForNewGroup(st, s, new Set(['A', 'B']))).toBe('red');
		// The pop-out window only has a grey group.
		expect(colorForNewGroup(st, s, new Set(['W']))).toBe('blue');
		// An empty window starts again at grey.
		expect(colorForNewGroup(st, s, new Set(['nowhere']))).toBe('grey');
	});

	it('picks the least used colour once every colour is taken, ties in Chrome order', () => {
		const leaves = GROUP_COLORS.map((_, i) => `t${String(i)}`).concat(['u0', 'u1']);
		const s = snap(`A: ${leaves.join(' ')}`);
		const spec: Record<string, { members: string; color: (typeof GROUP_COLORS)[number] }> = {};
		GROUP_COLORS.forEach((color, i) => {
			spec[`G${String(i)}`] = { members: `t${String(i)}`, color };
		});
		spec['X0'] = { members: 'u0', color: 'grey' };
		spec['X1'] = { members: 'u1', color: 'red' };
		expect(colorForNewGroup(groups(spec), s, new Set(['A']))).toBe('blue');
		expect(pickColor([])).toBe('grey');
	});
});
