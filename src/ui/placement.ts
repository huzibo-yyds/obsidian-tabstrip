/**
 * Where the editor bubble opens (pure, no page access).
 *
 * Like Chrome: under the tab strip, aligned with the chip's start edge, so neither the strip
 * nor the group's underline is covered while the user picks a name or colour. When there is no
 * room below the anchor (a stacked strip, where the anchor is a tall vertical tab header), the
 * bubble goes beside the anchor, at its top. It always stays inside the window.
 */

export interface Box {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export interface Size {
	readonly width: number;
	readonly height: number;
}

/** Space between the strip (or the anchor) and the bubble, in px. */
export const BUBBLE_GAP = 4;
/** Minimum distance from the window edges, in px. */
export const WINDOW_MARGIN = 8;

/**
 * @param anchor the chip (or, when the chip is hidden, its tab header)
 * @param below the lowest edge the bubble must stay under: the tab strip's bottom edge, or the
 *   anchor's own bottom edge when it is not in a horizontal strip
 * @param rtl right-to-left layout: align with the anchor's right edge, put it on its left side
 */
export function placeBubble(anchor: Box, below: number, bubble: Size, viewport: Size, rtl = false): { left: number; top: number } {
	const maxLeft = viewport.width - bubble.width - WINDOW_MARGIN;
	const maxTop = viewport.height - bubble.height - WINDOW_MARGIN;
	const clampX = (x: number) => Math.max(WINDOW_MARGIN, Math.min(x, maxLeft));
	const clampY = (y: number) => Math.max(WINDOW_MARGIN, Math.min(y, maxTop));

	const top = below + BUBBLE_GAP;
	if (top <= maxTop) return { left: clampX(rtl ? anchor.right - bubble.width : anchor.left), top };

	// No room below: beside the anchor, on its inline-end side first.
	const after = anchor.right + BUBBLE_GAP;
	const before = anchor.left - BUBBLE_GAP - bubble.width;
	const sides = rtl ? [before, after] : [after, before];
	const side = sides.find((x) => x >= WINDOW_MARGIN && x <= maxLeft);
	if (side !== undefined) return { left: side, top: clampY(anchor.top) };
	return { left: clampX(rtl ? anchor.right - bubble.width : anchor.left), top: clampY(top) };
}
