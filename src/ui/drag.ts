/**
 * Step L7: watches Obsidian's own tab drag on the horizontal strips, passively.
 *
 * Listeners sit on each strip's header row (`tabHeaderContainerEl`, whitelisted) in every window,
 * in the capture phase, and on each window's document for the end of a drag. They never cancel or
 * stop an event: Obsidian's drag code (on the window) runs exactly as without the plugin.
 *
 * - dragstart on a tab header, seen on each window's document (capture): which tab is dragged,
 *   from any strip, stacked ones too (L7 review round 3: a stacked strip's headers are not in its
 *   header row). A chip cancels its own drags, see the decorator; copies of headers, such as
 *   Obsidian's drag image or the closing animation's clone, are no tab of any strip and are ignored.
 * - dragover: the pointer's x is kept; at most once per animation frame the spot under it is
 *   worked out from the real headers' boxes (measured once per strip and drag, and again after the
 *   row scrolled; all reads before any write) and the group the tab would end up in is highlighted.
 * - drop on a strip: the spot is reported (`dropped`), for the drop intent of the next pass.
 * - dragend, Escape, leaving the strip: the highlight goes; a drag that ended without a drop on a
 *   strip reports `ended(false)`.
 * - The drag also ends (L7 review round 1) on any drop in a watched window, once Obsidian has
 *   handled it; on the next dragstart of anything that is not a tab; on a dragend at the dragged
 *   header itself, wherever it now lives; and when a watched window closes. A drag whose source
 *   window closed (its last tab dropped elsewhere) or whose dragend went to a window without a
 *   horizontal strip therefore never leaves a dragged tab behind for a later file or link drag.
 * - A tab's dragstart that a later listener cancels starts no drag (and so no dragend, no drop):
 *   once the event is done the watcher checks `defaultPrevented` and lets go of the tab. A drag that
 *   carries files is never a tab drag either: it ends any tab still recorded (L7 review round 4).
 * - Step V6 review round 2: any drag that starts in a watched window (a tab of any strip or sidebar, a
 *   note from the file explorer, a strip row) is reported through `anyDrag(true)`, and its end
 *   (dragend, a drop once handled, Escape, the next dragstart, the next pointerdown (a drag whose
 *   source element was removed gets its dragend on the detached node), a watched window closing) through
 *   `anyDrag(false)`. The vertical strip uses it to give stacked panes their drop band for every drag,
 *   not only for drags started on the strip. This is separate from the tab bookkeeping above.
 *
 * Nothing here changes tabs; nothing is written to `el.style` (classes only).
 */
import type { StripRead } from '../adapter/read';
import { spotAt, type ChipBox, type DropSpot, type DropTarget, type HeaderBox } from '../core';
import { ATTR, CLS } from './decorator';

export const DROP_CLS = {
	/** On the member headers of the group the dragged tab would join (or stay in). */
	join: 'tabstrip-drop-join',
	/** On that group's chip. */
	chip: 'is-drop-target',
} as const;

export interface DragHooks {
	/** The tab of a header, or null for anything that is not a strip's tab header. */
	leafOf(header: HTMLElement): string | null;
	/** The group the dragged tab ends up in if dropped at `target`, or null. */
	predict(target: DropTarget): string | null;
	/** The dragged tab was released over a strip. */
	dropped(target: DropTarget): void;
	/** The drag is over; `dropped`: it was released over a strip and not cancelled. */
	ended(dropped: boolean): void;
	/** Step V6 review round 2: some drag started (`true`) or ended (`false`) in a watched window. */
	anyDrag?(on: boolean): void;
}

interface StripView {
	readonly paneId: string;
	readonly container: HTMLElement;
	readonly headers: readonly { readonly leafId: string; readonly el: HTMLElement }[];
}

interface Geometry {
	readonly headers: HeaderBox[];
	readonly chips: ChipBox[];
	/** The strip runs right to left. */
	readonly rtl: boolean;
}

export interface DragTimings {
	/** Milliseconds per dragover / dragenter event handled. */
	readonly eventMs: number[];
	/** Milliseconds per animation frame that worked out the spot and highlight. */
	readonly frameMs: number[];
}

const TIMING_LIMIT = 2000;

function push(list: number[], value: number): void {
	list.push(value);
	if (list.length > TIMING_LIMIT) list.splice(0, list.length - TIMING_LIMIT);
}

export class DragWatcher {
	private views = new Map<HTMLElement, StripView>();
	private readonly unlistenRows = new Map<HTMLElement, () => void>();
	private readonly unlistenDocs = new Map<Document, () => void>();
	/** The dragged tab, while one of our tabs is dragged. */
	private dragged: string | null = null;
	private droppedOnStrip = false;
	/** Counts drags, so a deferred end after a drop ends only its own drag. */
	private dragSeq = 0;
	/** Removes the dragend listener on the dragged header. */
	private unlistenHeader: (() => void) | null = null;
	/**
	 * Header boxes per strip, measured once per drag (tabs do not move while a tab is dragged) and
	 * forgotten when the row scrolls (Chromium's drag autoscroll, a wheel; L7 review round 3).
	 */
	private geometry = new Map<HTMLElement, Geometry>();
	private pointer: { row: HTMLElement; x: number } | null = null;
	private frame: { win: Window; id: number } | null = null;
	private lastKey = '';
	private painted: HTMLElement[] = [];
	/** Some drag (of anything) is open in a watched window (Step V6 review round 2). */
	private anyDragging = false;
	/** Counts drag starts of any kind, so a deferred end after a drop ends only its own drag. */
	private anySeq = 0;
	readonly timings: DragTimings = { eventMs: [], frameMs: [] };

	constructor(private readonly hooks: DragHooks) {}

	/** Follows the strips of the latest render (call after every render; non-stacked strips only). */
	watch(strips: readonly StripRead[]): void {
		const views = new Map<HTMLElement, StripView>();
		const docs = new Set<Document>();
		for (const strip of strips) {
			const row = strip.container;
			// Every window with a strip, stacked ones too: the end of a drag goes to the document that
			// holds the dragged header, which may be a window with only stacked strips.
			const doc = row?.ownerDocument ?? strip.leaves.find((l) => l.header !== null)?.header?.ownerDocument;
			if (doc !== undefined) docs.add(doc);
			if (row === null || strip.stacked) continue;
			const headers = strip.leaves.flatMap((l) => (l.header === null ? [] : [{ leafId: l.id, el: l.header }]));
			views.set(row, { paneId: strip.paneId, container: row, headers });
			if (!this.unlistenRows.has(row)) this.unlistenRows.set(row, this.listenRow(row));
		}
		for (const [row, unlisten] of this.unlistenRows) {
			if (views.has(row)) continue;
			unlisten();
			this.unlistenRows.delete(row);
		}
		for (const doc of docs) if (!this.unlistenDocs.has(doc)) this.unlistenDocs.set(doc, this.listenDocument(doc));
		let closed = false;
		for (const [doc, unlisten] of this.unlistenDocs) {
			if (docs.has(doc)) continue;
			unlisten();
			this.unlistenDocs.delete(doc);
			closed = true;
		}
		// A window went away during a drag (its last tab was dropped elsewhere): its dragend may never come.
		if (closed) {
			this.finish();
			this.setAnyDrag(false);
		}
		this.views = views;
		// A render may have moved headers (chips, collapsed groups): measure again.
		this.geometry.clear();
		this.lastKey = '';
	}

	/** Removes every listener and highlight. */
	clear(): void {
		for (const unlisten of this.unlistenRows.values()) unlisten();
		this.unlistenRows.clear();
		for (const unlisten of this.unlistenDocs.values()) unlisten();
		this.unlistenDocs.clear();
		this.views.clear();
		this.reset();
		this.setAnyDrag(false);
	}

	/** Some drag is open in a watched window (for tests). */
	get anyDragOpen(): boolean {
		return this.anyDragging;
	}

	/** The dragged tab (for tests). */
	get draggedLeaf(): string | null {
		return this.dragged;
	}

	/**
	 * Step V5: a tab is dragged from somewhere that is no tab header (a row of the vertical strip,
	 * which started Obsidian's own tab drag for it). From now on the watcher treats it like a dragged
	 * header: a drop on a horizontal strip (a pop-out's) follows the same rules. `source` is the
	 * dragged element: its dragend ends the drag, like a header's. `start` is its dragstart: a later
	 * listener may still cancel it (then no drag and no dragend come), which is checked once the event
	 * is done, as for a header's dragstart (V5 review round 1).
	 */
	begin(leafId: string, source: HTMLElement, start?: DragEvent): void {
		this.finish();
		this.dragged = leafId;
		const seq = ++this.dragSeq;
		if (start !== undefined) {
			(source.ownerDocument.defaultView ?? window).setTimeout(() => {
				if (this.dragSeq === seq && start.defaultPrevented) this.finish();
			}, 0);
		}
		const onEnd = (e: DragEvent) => {
			this.onDragEnd(e);
		};
		const options: AddEventListenerOptions = { passive: true };
		source.addEventListener('dragend', onEnd, options);
		this.unlistenHeader = () => {
			source.removeEventListener('dragend', onEnd, options);
		};
	}

	private listenRow(row: HTMLElement): () => void {
		const options: AddEventListenerOptions = { capture: true, passive: true };
		const onOver = (e: DragEvent) => {
			this.onDragOver(row, e);
		};
		const onLeave = (e: DragEvent) => {
			this.onDragLeave(row, e);
		};
		const onDrop = (e: DragEvent) => {
			this.onDrop(row, e);
		};
		// scroll does not bubble; a capture listener on the row sees its inner scroller's scrolls too.
		const onScroll = () => {
			this.onScroll(row);
		};
		row.addEventListener('dragenter', onOver, options);
		row.addEventListener('dragover', onOver, options);
		row.addEventListener('dragleave', onLeave, options);
		row.addEventListener('drop', onDrop, options);
		row.addEventListener('scroll', onScroll, options);
		return () => {
			row.removeEventListener('dragenter', onOver, options);
			row.removeEventListener('dragover', onOver, options);
			row.removeEventListener('dragleave', onLeave, options);
			row.removeEventListener('drop', onDrop, options);
			row.removeEventListener('scroll', onScroll, options);
		};
	}

	private listenDocument(doc: Document): () => void {
		const options: AddEventListenerOptions = { capture: true, passive: true };
		const onEnd = (e: DragEvent) => {
			this.onDragEnd(e);
			this.setAnyDrag(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			this.setAnyDrag(false);
			if (this.dragged === null) return;
			this.reset();
			this.hooks.ended(false);
		};
		// Any new drag ends a drag still open; a tab's own dragstart (any strip of this window, stacked
		// ones too) starts the next one.
		const onStart = (e: DragEvent) => {
			this.onDragStart(e);
			this.onAnyDragStart(e, doc);
		};
		// Any drop ends the drag once Obsidian has handled it (the source window may be gone by then).
		const onDrop = () => {
			if (this.anyDragging) {
				const anySeq = this.anySeq;
				(doc.defaultView ?? window).setTimeout(() => {
					if (this.anySeq === anySeq) this.setAnyDrag(false);
				}, 0);
			}
			if (this.dragged === null) return;
			const seq = this.dragSeq;
			(doc.defaultView ?? window).setTimeout(() => {
				if (this.dragSeq === seq) this.finish();
			}, 0);
		};
		// A drag whose source element was removed while it was open gets its dragend on the detached
		// node, so no listener here sees it. No pointer button goes down during a drag, so the next
		// pointerdown in a watched window proves it is over (V6 final review).
		const onPointerDown = () => {
			if (this.anyDragging) this.setAnyDrag(false);
		};
		doc.addEventListener('dragend', onEnd, options);
		doc.addEventListener('pointerdown', onPointerDown, options);
		doc.addEventListener('keydown', onKey, options);
		doc.addEventListener('dragstart', onStart, options);
		doc.addEventListener('drop', onDrop, options);
		return () => {
			doc.removeEventListener('dragend', onEnd, options);
			doc.removeEventListener('pointerdown', onPointerDown, options);
			doc.removeEventListener('keydown', onKey, options);
			doc.removeEventListener('dragstart', onStart, options);
			doc.removeEventListener('drop', onDrop, options);
		};
	}

	/**
	 * Any dragstart in a watched window: some drag is open. A later listener may still cancel it (then
	 * no drag starts and no dragend comes): checked once the event is done, as for a tab's dragstart.
	 */
	private onAnyDragStart(e: DragEvent, doc: Document): void {
		const seq = ++this.anySeq;
		this.setAnyDrag(true);
		(doc.defaultView ?? window).setTimeout(() => {
			if (this.anySeq === seq && e.defaultPrevented) this.setAnyDrag(false);
		}, 0);
	}

	private setAnyDrag(on: boolean): void {
		if (this.anyDragging === on) return;
		this.anyDragging = on;
		this.hooks.anyDrag?.(on);
	}

	private onDragEnd(e: DragEvent): void {
		if (this.dragged === null) return;
		const dropped = this.droppedOnStrip && e.dataTransfer?.dropEffect !== 'none';
		this.reset();
		this.hooks.ended(dropped);
	}

	/** Ends a drag still open, as dropped if it was released over a strip. */
	private finish(): void {
		if (this.dragged === null) return;
		const dropped = this.droppedOnStrip;
		this.reset();
		this.hooks.ended(dropped);
	}

	private onDragStart(e: DragEvent): void {
		this.finish();
		const target = e.target;
		if (!isElement(target)) return;
		if (target.closest(`.${CLS.chip}`) !== null) return;
		const header = target.closest('.workspace-tab-header');
		if (header === null || !isElement(header)) return;
		const leafId = this.hooks.leafOf(header);
		// Not a tab of a strip (another plugin's element, a copy of a header): not our drag.
		if (leafId === null) return;
		this.dragged = leafId;
		const seq = ++this.dragSeq;
		// Our listener runs first (document, capture); a later one may still cancel the dragstart, and
		// then no drag starts. Check once the event is done (no layout read, no write).
		(header.ownerDocument.defaultView ?? window).setTimeout(() => {
			if (this.dragSeq === seq && e.defaultPrevented) this.finish();
		}, 0);
		// Chromium sends dragend to the dragged header, wherever it is by then (another window).
		const onEnd = (e: DragEvent) => {
			this.onDragEnd(e);
		};
		const options: AddEventListenerOptions = { passive: true };
		header.addEventListener('dragend', onEnd, options);
		this.unlistenHeader = () => {
			header.removeEventListener('dragend', onEnd, options);
		};
	}

	private onDragOver(row: HTMLElement, e: DragEvent): void {
		if (this.dragged === null) return;
		if (carriesFiles(e)) {
			this.finish();
			return;
		}
		const started = performance.now();
		this.pointer = { row, x: e.clientX };
		if (this.frame === null) {
			const win = row.ownerDocument.defaultView;
			if (win !== null) {
				const id = win.requestAnimationFrame(() => {
					this.frame = null;
					this.runFrame();
				});
				this.frame = { win, id };
			}
		}
		push(this.timings.eventMs, performance.now() - started);
	}

	/** The row scrolled: its boxes are stale. Measured again on the next frame or drop (no read here). */
	private onScroll(row: HTMLElement): void {
		if (this.dragged === null) return;
		this.geometry.delete(row);
	}

	private onDragLeave(row: HTMLElement, e: DragEvent): void {
		if (this.dragged === null) return;
		const to = e.relatedTarget;
		if (isElement(to) && row.contains(to)) return;
		if (this.pointer?.row === row) this.pointer = null;
		this.cancelFrame();
		this.unpaint();
		this.lastKey = '';
	}

	private onDrop(row: HTMLElement, e: DragEvent): void {
		if (this.dragged !== null && carriesFiles(e)) this.finish();
		const leafId = this.dragged;
		const view = this.views.get(row);
		// Read first (the spot may need a fresh measure), then write (the highlight goes): no layout
		// read after a class change (L7 review round 2).
		const spot = leafId === null || view === undefined ? null : this.spotIn(view, e.clientX);
		this.cancelFrame();
		this.unpaint();
		this.pointer = null;
		if (leafId === null || view === undefined || spot === null) return;
		this.droppedOnStrip = true;
		this.hooks.dropped({ leafId, paneId: view.paneId, spot });
	}

	private runFrame(): void {
		const pointer = this.pointer;
		const leafId = this.dragged;
		if (pointer === null || leafId === null) return;
		const started = performance.now();
		const view = this.views.get(pointer.row);
		if (view !== undefined) {
			const spot = this.spotIn(view, pointer.x);
			const key = `${view.paneId}|${JSON.stringify(spot)}`;
			if (key !== this.lastKey) {
				this.lastKey = key;
				const groupId = this.hooks.predict({ leafId, paneId: view.paneId, spot });
				this.paint(view, groupId);
			}
		}
		push(this.timings.frameMs, performance.now() - started);
	}

	/** The spot under the pointer, from the real headers' boxes (measured once per strip and drag). */
	private spotIn(view: StripView, x: number): DropSpot {
		let g = this.geometry.get(view.container);
		if (g === undefined) {
			g = measure(view);
			this.geometry.set(view.container, g);
		}
		return spotAt(x, g.headers, g.chips, g.rtl);
	}

	/** Highlights the group's member headers in this strip and its chip. */
	private paint(view: StripView, groupId: string | null): void {
		this.unpaint();
		if (groupId === null) return;
		for (const { el } of view.headers) {
			if (el.getAttribute(ATTR.group) !== groupId || !el.hasClass(CLS.member)) continue;
			el.addClass(DROP_CLS.join);
			this.painted.push(el);
			const chip = el.querySelector(`:scope > .${CLS.chip}`);
			if (isElement(chip)) {
				chip.addClass(DROP_CLS.chip);
				this.painted.push(chip);
			}
		}
	}

	private unpaint(): void {
		for (const el of this.painted) {
			el.removeClass(DROP_CLS.join);
			el.removeClass(DROP_CLS.chip);
		}
		this.painted = [];
	}

	private cancelFrame(): void {
		if (this.frame === null) return;
		this.frame.win.cancelAnimationFrame(this.frame.id);
		this.frame = null;
	}

	private reset(): void {
		this.unlistenHeader?.();
		this.unlistenHeader = null;
		this.cancelFrame();
		this.unpaint();
		this.dragged = null;
		this.droppedOnStrip = false;
		this.pointer = null;
		this.lastKey = '';
		this.geometry.clear();
	}
}

/** Files dragged in from outside: never one of our tabs. */
function carriesFiles(e: DragEvent): boolean {
	const types = e.dataTransfer?.types;
	return types !== undefined && types.includes('Files');
}

/** Works for elements of pop-out windows too (each window has its own Element). */
function isElement(value: unknown): value is HTMLElement {
	return typeof value === 'object' && value !== null && (value as Node).nodeType === 1 && typeof (value as HTMLElement).closest === 'function';
}

/** Reads the boxes of a strip's real tab headers and of its chips (no writes). */
function measure(view: StripView): Geometry {
	const headers: HeaderBox[] = [];
	const chips: ChipBox[] = [];
	for (const { leafId, el } of view.headers) {
		const r = el.getBoundingClientRect();
		const hidden = el.hasClass(CLS.collapsed) ? el.getAttribute(ATTR.group) : null;
		headers.push({ leafId, left: r.left, right: r.right, hiddenGroupId: hidden });
		const chip = el.hasClass(CLS.hasChip) ? el.querySelector(`:scope > .${CLS.chip}`) : null;
		const groupId = chip === null ? null : chip.getAttribute(ATTR.group);
		if (isElement(chip) && groupId !== null) {
			const c = chip.getBoundingClientRect();
			chips.push({ groupId, left: c.left, right: c.right });
		}
	}
	const win = view.container.ownerDocument.defaultView;
	const rtl = win !== null && win.getComputedStyle(view.container).direction === 'rtl';
	return { headers, chips, rtl };
}
