/**
 * Pure helpers of the header decorator (step L5 review round 1).
 */
import { describe, expect, it } from 'vitest';
import { gapPx } from '../../../src/ui/decorator';

describe('gapPx: a computed column-gap in px', () => {
	it('reads px values', () => {
		expect(gapPx('4px')).toBe(4);
		expect(gapPx('2.5px')).toBe(2.5);
	});

	it('normal, zero, negative and unparsable count as no gap', () => {
		expect(gapPx('normal')).toBe(0);
		expect(gapPx('0px')).toBe(0);
		expect(gapPx('-3px')).toBe(0);
		expect(gapPx('')).toBe(0);
	});
});
