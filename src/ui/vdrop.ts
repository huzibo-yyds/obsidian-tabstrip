/**
 * Step V5, the pure part of dropping a tab on the vertical strip: which drop spot of the core rules
 * (src/core/drag.ts) the pointer's height means, and where the drop line goes. No page access here;
 * the strip measures its shown rows (VDropBox) and calls `vspotAt` once per frame.
 *
 * Rows, from the top of the list (the same rules as the horizontal strip, turned on their side):
 * - a tab row: its upper half is "before this tab", its lower half "after this tab"; the pointer is
 *   on that tab, so at a group's edge it joins the tab's group (rule 2), next to it it stays out;
 * - a group row: its upper half is the gap before the group (the tab lands before the group, outside
 *   it); its lower half is the group's chip: an expanded group is joined at its start, a collapsed
 *   one is never joined, the tab goes right after it (rule 4);
 * - the "New tab" row, and everything below the last row: the end of that pane, outside any group;
 * - above the first row of a section (its title): the first row's upper half.
 * Pinned rows belong to their own pane's strip (the pinned area lists every pane's pinned tabs).
 * Pinned tabs stay first in their pane (L3 rule R06), so a spot that the rules would undo is aimed
 * where the tab really lands (V5 review round 2): an unpinned tab over a pinned row goes before its
 * pane's first unpinned row; a pinned tab over an unpinned row goes after its pane's pinned rows.
 */
import type { DropSpot } from '../core';

/** A shown row of the strip's list, with its measured vertical extent (viewport px). */
export type VDropBox =
	| {
			readonly kind: 'tab';
			readonly paneId: string;
			readonly leafId: string;
			/** A pinned tab (listed in the pinned area). */
			readonly pinned?: boolean;
			readonly top: number;
			readonly bottom: number;
	  }
	| {
			readonly kind: 'group';
			readonly paneId: string;
			readonly groupId: string;
			/** The group's first tab in its strip (hidden or not): the gap before the group is before it. */
			readonly firstLeafId: string;
			readonly top: number;
			readonly bottom: number;
	  }
	| { readonly kind: 'new'; readonly paneId: string; readonly top: number; readonly bottom: number };

export interface VDropSpot {
	readonly paneId: string;
	readonly spot: DropSpot;
	/** Height of the drop line (viewport px): the edge of the row the tab would be put next to. */
	readonly lineY: number;
	/** Index of the row the pointer is over (for the line of a collapsed group, see `vlineY`). */
	readonly row: number;
}

/**
 * The drop spot under the pointer at height `y`, from the shown rows in list order. The row under
 * the pointer is the first one whose bottom is at or below it (rows below the list's last row count
 * as that row's lower half). Null when there is no row at all.
 */
export function vspotAt(y: number, boxes: readonly VDropBox[], draggedPinned = false): VDropSpot | null {
	if (boxes.length === 0) return null;
	let row = boxes.findIndex((b) => y <= b.bottom);
	if (row < 0) row = boxes.length - 1;
	const box = boxes[row];
	if (box === undefined) return null;
	const pinnedRow = box.kind === 'tab' && box.pinned === true;
	if (pinnedRow !== draggedPinned) {
		const aimed = draggedPinned ? afterPinned(box.paneId, boxes) : beforeUnpinned(box.paneId, boxes);
		if (aimed !== null) return aimed;
	}
	const upper = y < (box.top + box.bottom) / 2;
	switch (box.kind) {
		case 'tab':
			return { paneId: box.paneId, row, spot: { kind: 'tab', leafId: box.leafId, side: upper ? 'before' : 'after' }, lineY: upper ? box.top : box.bottom };
		case 'group':
			return upper
				? { paneId: box.paneId, row, spot: { kind: 'gap', beforeLeafId: box.firstLeafId }, lineY: box.top }
				: { paneId: box.paneId, row, spot: { kind: 'chip', groupId: box.groupId }, lineY: box.bottom };
		case 'new':
			return { paneId: box.paneId, row, spot: { kind: 'empty' }, lineY: box.top };
	}
}

/** An unpinned tab over a pinned row of `paneId`: before the pane's first unpinned row. */
function beforeUnpinned(paneId: string, boxes: readonly VDropBox[]): VDropSpot | null {
	const row = boxes.findIndex((b) => b.paneId === paneId && !(b.kind === 'tab' && b.pinned === true));
	const box = boxes[row];
	return box === undefined ? null : { paneId, row, spot: firstSpot(box), lineY: box.top };
}

/**
 * A pinned tab over an unpinned row of `paneId`: after the pane's last pinned row; with none, at the
 * pane's start, where its pinned rows would be in the pinned area (after the pinned rows of the panes
 * listed before it).
 */
function afterPinned(paneId: string, boxes: readonly VDropBox[]): VDropSpot | null {
	const isPinned = (b: VDropBox): boolean => b.kind === 'tab' && b.pinned === true;
	let last = -1;
	boxes.forEach((b, i) => {
		if (isPinned(b) && b.paneId === paneId) last = i;
	});
	const lastBox = boxes[last];
	if (lastBox?.kind === 'tab') return { paneId, row: last, spot: { kind: 'tab', leafId: lastBox.leafId, side: 'after' }, lineY: lastBox.bottom };
	const first = boxes.findIndex((b) => b.paneId === paneId && !isPinned(b));
	const firstBox = boxes[first];
	if (firstBox === undefined) return null;
	// Panes in list order (their sections), then the last pinned row of a pane listed before this one.
	const panes: string[] = [];
	for (const b of boxes) if (!isPinned(b) && !panes.includes(b.paneId)) panes.push(b.paneId);
	const earlier = new Set(panes.slice(0, panes.indexOf(paneId)));
	let lineY: number | null = null;
	for (const b of boxes) if (isPinned(b) && earlier.has(b.paneId)) lineY = b.bottom;
	lineY ??= boxes.find(isPinned)?.top ?? firstBox.top;
	return { paneId, row: first, spot: firstSpot(firstBox), lineY };
}

/** The spot right before an unpinned row: before its tab, before its group (outside it), or the end. */
function firstSpot(box: VDropBox): DropSpot {
	switch (box.kind) {
		case 'tab':
			return { kind: 'tab', leafId: box.leafId, side: 'before' };
		case 'group':
			return { kind: 'gap', beforeLeafId: box.firstLeafId };
		case 'new':
			return { kind: 'empty' };
	}
}

/**
 * Where the drop line goes when the tab lands right after a collapsed group (its chip's lower half):
 * below the group's last shown row (the group row, or its shown tab that stays visible), not between
 * the group row and that tab.
 */
export function collapsedLineY(boxes: readonly VDropBox[], row: number, members: ReadonlySet<string>): number {
	let y = boxes[row]?.bottom ?? 0;
	for (let i = row + 1; i < boxes.length; i++) {
		const b = boxes[i];
		if (b?.kind !== 'tab' || !members.has(b.leafId)) break;
		y = b.bottom;
	}
	return y;
}

/** A stable text key of a spot (to repaint only when it changed). */
export function vspotKey(s: VDropSpot | null): string {
	if (s === null) return '';
	const spot = s.spot;
	switch (spot.kind) {
		case 'tab':
			return `${s.paneId}|t|${spot.leafId}|${spot.side}`;
		case 'chip':
			return `${s.paneId}|c|${spot.groupId}`;
		case 'gap':
			return `${s.paneId}|g|${spot.beforeLeafId}`;
		case 'empty':
			return `${s.paneId}|e`;
	}
}
