import { describe, expect, it } from 'vitest';
import { BUBBLE_GAP, placeBubble, WINDOW_MARGIN } from '../../../src/ui/placement';

const VIEW = { width: 1024, height: 800 };
const BUBBLE = { width: 248, height: 110 };
const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });

describe('placeBubble', () => {
	it('under the strip, aligned with the chip', () => {
		expect(placeBubble(box(450, 11, 96, 21), 40, BUBBLE, VIEW)).toEqual({ left: 450, top: 40 + BUBBLE_GAP });
	});

	it('stays inside the window at its right edge', () => {
		expect(placeBubble(box(950, 11, 60, 21), 40, BUBBLE, VIEW).left).toBe(VIEW.width - BUBBLE.width - WINDOW_MARGIN);
	});

	it('stays inside the window at its left edge (right-to-left chip near the edge)', () => {
		expect(placeBubble(box(2, 11, 60, 21), 40, BUBBLE, VIEW, true).left).toBe(WINDOW_MARGIN);
	});

	it('no room below (stacked header spine): beside it, at its top', () => {
		expect(placeBubble(box(40, 40, 40, 740), 780, BUBBLE, VIEW)).toEqual({ left: 40 + 40 + BUBBLE_GAP, top: 40 });
	});

	it('no room below and none after it: before it', () => {
		expect(placeBubble(box(900, 40, 40, 740), 780, BUBBLE, VIEW)).toEqual({ left: 900 - BUBBLE_GAP - BUBBLE.width, top: 40 });
	});

	it('right-to-left: beside it on the left first', () => {
		expect(placeBubble(box(900, 40, 40, 740), 780, BUBBLE, VIEW, true)).toEqual({ left: 900 - BUBBLE_GAP - BUBBLE.width, top: 40 });
	});

	it('a header that starts above the window: the bubble top stays inside', () => {
		expect(placeBubble(box(40, -30, 40, 900), 870, BUBBLE, VIEW).top).toBe(WINDOW_MARGIN);
	});

	it('a window too small for anything: clamped inside', () => {
		const tiny = { width: 200, height: 100 };
		const at = placeBubble(box(40, 40, 40, 40), 80, BUBBLE, tiny);
		expect(at).toEqual({ left: WINDOW_MARGIN, top: WINDOW_MARGIN });
	});
});
