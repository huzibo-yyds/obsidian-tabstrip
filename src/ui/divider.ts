/**
 * Which side of a tab the theme draws the tab divider on.
 *
 * Obsidian draws the divider between tabs as `.workspace-tab-header-inner::after`, at each
 * tab's inline end, so the divider before a group's first tab belongs to the previous tab and
 * sits before the chip. Some themes (Atom, the user's theme) move it to each tab's inline
 * start: then the first member's own divider sits between the chip and the tab it labels, and
 * nothing separates the previous tab from the chip, so the chip reads as part of the previous
 * tab. In that case the decorator marks the first member (`tabstrip-divider-start`) and the
 * stylesheet moves that one divider back before the chip, by the width of the chip's room.
 *
 * The side is read once per window from the computed style of a header's `::after` (where an
 * absolutely positioned box's left and right are resolved to used values) and kept until the
 * CSS changes, so a pass costs one cache lookup per chip. Only the side is decided here;
 * whether the divider shows (themes hide it next to the active tab or on the first tab) stays
 * with the theme.
 */

export type DividerSide = 'start' | 'end';

/** The parts of a computed `::after` style this needs. */
export interface DividerStyle {
	readonly content: string;
	readonly display: string;
	readonly position: string;
	readonly left: string;
	readonly right: string;
}

function px(value: string): number | null {
	const m = /^(-?[\d.]+(?:e[+-]?\d+)?)px$/.exec(value.trim());
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : null;
}

/**
 * Pure decision: the divider's logical side, or null when there is no positioned divider box
 * to go by (no content, not displayed, not absolutely positioned, or no usable offsets).
 */
export function dividerSide(style: DividerStyle, rtl: boolean): DividerSide | null {
	if (style.content === 'none' || style.content === 'normal' || style.content === '') return null;
	if (style.display === 'none') return null;
	if (style.position !== 'absolute' && style.position !== 'fixed') return null;
	const left = px(style.left);
	const right = px(style.right);
	let physicalLeft: boolean;
	if (left !== null && right !== null) {
		if (left === right) return null;
		physicalLeft = left < right;
	} else if (left !== null) {
		physicalLeft = true;
	} else if (right !== null) {
		physicalLeft = false;
	} else {
		return null;
	}
	return physicalLeft !== rtl ? 'start' : 'end';
}

/** Per window: the divider side of its horizontal tab strips, measured once. */
export class DividerCache {
	/** 'none': that window's tabs show no positioned divider box (nothing to move). */
	private sides = new WeakMap<Document, DividerSide | 'none'>();

	/**
	 * Whether the theme draws the divider at the start of `header`. Measured on the first header
	 * of a horizontal strip asked about in its window, then cached for the window; a header of a
	 * stacked strip (outside the header container) is not measured and gives false.
	 */
	atStart(header: HTMLElement): boolean {
		return this.sideOf(header) === 'start';
	}

	/**
	 * Whether the theme draws the divider at the end of `header` (Obsidian's default). Same
	 * measurement and cache as atStart; false when the tabs show no positioned divider box.
	 */
	atEnd(header: HTMLElement): boolean {
		return this.sideOf(header) === 'end';
	}

	/** The divider side for the header's window, or null when it cannot be measured (yet). */
	private sideOf(header: HTMLElement): DividerSide | 'none' | null {
		const doc = header.ownerDocument;
		const known = this.sides.get(doc);
		if (known !== undefined) return known;
		const win = doc.defaultView;
		// A hidden member of a collapsed group has width 0, which says nothing about the side:
		// measure a visible tab of the same strip instead (the shown tab is never hidden).
		const sample = header.classList.contains('tabstrip-collapsed')
			? (header.parentElement?.querySelector<HTMLElement>(':scope > .workspace-tab-header:not(.tabstrip-collapsed)') ?? null)
			: header;
		const inner = sample?.querySelector(':scope > .workspace-tab-header-inner') ?? null;
		if (win === null || sample === null || inner === null || sample.closest('.workspace-tab-header-container') === null) return null;
		const style = win.getComputedStyle(inner, '::after');
		const side = dividerSide(
			{ content: style.content, display: style.display, position: style.position, left: style.left, right: style.right },
			win.getComputedStyle(sample).direction === 'rtl',
		);
		this.sides.set(doc, side ?? 'none');
		return side ?? 'none';
	}

	/** Forget everything (theme or CSS changed). */
	clear(): void {
		this.sides = new WeakMap();
	}
}
