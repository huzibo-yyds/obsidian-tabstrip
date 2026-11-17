/**
 * Horizontal decoration of Obsidian's own tab headers (requirements 7.1 "display layer").
 *
 * - Every member header gets `tabstrip-member`, `data-tabstrip-group`, `data-tabstrip-color`
 *   and an underline element (`.tabstrip-line`).
 * - The first member of a group in a strip also holds the chip (`.tabstrip-chip`). The chip
 *   sits in that header's inline-start margin, whose width is the measured chip width,
 *   written as `--tabstrip-chip-slot` with setCssProps (step L2, S1 spike).
 * - Members of a collapsed group get `tabstrip-collapsed` (step L5; styles.css hides them with
 *   width 0 and visibility: hidden); the chip gets `aria-expanded` and toggles on a left click
 *   or Enter / Space.
 * - The chip keeps its mouse events away from the tab (step L2 §8): click, auxclick,
 *   contextmenu and dblclick are stopped; mouseover is only default-prevented (no page
 *   preview); it is its own drag source and cancels every drag.
 *
 * Elements are created in the header's own document, so this works in pop-out windows.
 * Nothing is written when a header's marks did not change. When Obsidian moves a decorated
 * header into another window, its marks are made again in that window's document.
 */
import type { StripRead } from '../adapter/read';
import type { Translator } from '../i18n';
import { DividerCache } from './divider';
import type { InkCache } from './ink';
import { planKey, type ChipPlan, type HeaderPlan } from './plan';

/** Space between the chip and the neighbouring tabs, on each side, in px (styles.css uses the same). */
export const CHIP_GAP = 4;
export const SLOT_PROP = '--tabstrip-chip-slot';
/**
 * On a hidden member that is not the chip holder: the strip's column gap. A zero-width header is
 * still a flex item, so a theme that spaces tabs with `gap` (Cupertino: 4px) would leave one gap
 * per hidden member after the chip; styles.css takes it back with a negative start margin.
 */
export const GAP_PROP = '--tabstrip-strip-gap';

/** A computed `column-gap` in px (`normal` and anything unparsable count as 0). */
export function gapPx(value: string): number {
	const px = parseFloat(value);
	return Number.isFinite(px) && px > 0 ? px : 0;
}

export const CLS = {
	member: 'tabstrip-member',
	hasChip: 'tabstrip-has-chip',
	chip: 'tabstrip-chip',
	unnamed: 'is-unnamed',
	label: 'tabstrip-chip-label',
	dot: 'tabstrip-chip-dot',
	line: 'tabstrip-line',
	/** On a chip holder whose theme draws the tab divider at the tab's start (divider.ts). */
	dividerStart: 'tabstrip-divider-start',
	/**
	 * On every member header of a collapsed group when the theme draws the tab divider at the
	 * tab's end (Obsidian's default): the group's last member then draws the divider right after
	 * the chip. Never set for start-side themes (Atom), where that divider would sit at the next
	 * tab's start, also next to the active tab (L5 review round 2).
	 */
	dividerEnd: 'tabstrip-divider-end',
	/**
	 * On every member header of a collapsed group (step L5): width 0 and visibility: hidden, never
	 * display: none (native drop positions are computed from the header boxes, requirements 7.2).
	 * The chip holder keeps its chip room; the chip itself stays visible.
	 */
	collapsed: 'tabstrip-collapsed',
	/** On the chip of a collapsed group. */
	chipCollapsed: 'is-collapsed',
} as const;

export const ATTR = {
	group: 'data-tabstrip-group',
	color: 'data-tabstrip-color',
	ink: 'data-tabstrip-ink',
} as const;

export interface DecoratorHooks {
	/** Right click on a chip (`evt`), or the context-menu key / Shift+F10 on a focused chip (`evt` null). */
	chipMenu(groupId: string, chip: HTMLElement, evt: MouseEvent | null): void;
	/** A decorated header left the page or its window (Obsidian moved or closed its tab); a pass should follow. */
	moved(): void;
	/** Left click, or Enter / Space on a focused chip: collapse or expand the group (step L5). */
	/** `keyboard`: Enter / Space on the focused chip (the focus should stay on the chip). */
	toggle(groupId: string, chip: HTMLElement, keyboard: boolean): void;
}

interface HeaderMarks {
	key: string;
	/** The document the marks were made in (the header's window then). */
	doc: Document;
	line: HTMLElement;
	chip: HTMLElement | null;
	observer: ResizeObserver | null;
	/** Removes the chip's listeners on its header. */
	unlisten: (() => void) | null;
	/** The header had no `style` attribute before the slot was written. */
	hadNoStyle: boolean;
}

/** One per window: watches the parents of that window's decorated headers (see watchParent). */
interface ParentWatch {
	readonly observer: MutationObserver;
	readonly parents: WeakSet<Element>;
}

export class HeaderDecorator {
	private readonly marks = new Map<HTMLElement, HeaderMarks>();
	private readonly chipsByGroup = new Map<string, HTMLElement>();
	private readonly parentWatches = new Map<Document, ParentWatch>();
	private readonly divider = new DividerCache();
	/** Column gap per tab header container (measured once, cleared by `invalidate`). */
	private gaps = new WeakMap<Element, number>();
	/** Chips whose slot is measured at the end of the render, all reads before all writes. */
	private pendingSlots: [HTMLElement, HTMLElement][] = [];
	/**
	 * Milliseconds the last render spent in its measuring reads (theme colours, divider side, chip
	 * widths). Such a read makes the browser bring style and layout up to date first, so this is
	 * mostly the browser's rendering work for the page, not script time.
	 */
	lastReadMs = 0;
	/**
	 * Step V6, test-only switch (the pop-out ResizeObserver investigation): when false, chips get no
	 * ResizeObserver (their slot is still written by every render). Always true outside that test.
	 */
	private chipObservers = true;

	constructor(
		private readonly t: Translator,
		private readonly ink: InkCache,
		private readonly hooks: DecoratorHooks,
	) {}

	/** Test-only (step V6): turns the chips' ResizeObservers off (disconnecting the live ones) or on again. */
	setChipObservers(on: boolean): void {
		this.chipObservers = on;
		if (on) return;
		for (const marks of this.marks.values()) {
			marks.observer?.disconnect();
			marks.observer = null;
		}
	}

	/** Live chip ResizeObservers (test-only, step V6). */
	get chipObserverCount(): number {
		let n = 0;
		for (const marks of this.marks.values()) if (marks.observer !== null) n++;
		return n;
	}

	/** Brings every root tab header in line with `plan` (leaf id → marks). */
	render(strips: readonly StripRead[], plan: ReadonlyMap<string, HeaderPlan>): void {
		const seen = new Set<HTMLElement>();
		this.chipsByGroup.clear();
		this.lastReadMs = 0;
		this.prime(strips, plan);
		for (const strip of strips) {
			for (const leaf of strip.leaves) {
				const header = leaf.header;
				const p = plan.get(leaf.id);
				if (header === null || p === undefined) continue;
				seen.add(header);
				const marks = this.apply(header, p);
				if (marks.chip !== null && p.chip !== null) this.chipsByGroup.set(p.chip.groupId, marks.chip);
			}
		}
		for (const header of [...this.marks.keys()]) {
			if (!seen.has(header)) this.unmark(header);
		}
		this.flushSlots();
		this.pruneWatches();
	}

	/**
	 * Measures what the marks depend on (chip text colours, divider side, the strip's gap) before
	 * anything is written, so these reads cost one style pass instead of one after every write. Matters most
	 * for the first render after start-up, when nothing is cached yet (step L6 performance).
	 */
	private prime(strips: readonly StripRead[], plan: ReadonlyMap<string, HeaderPlan>): void {
		const started = performance.now();
		const inks: [Document, HeaderPlan['color']][] = [];
		for (const strip of strips) {
			let chipSeen = false;
			let gapSeen = false;
			for (const leaf of strip.leaves) {
				const p = plan.get(leaf.id);
				if (leaf.header === null || p === undefined) continue;
				// The strip's column gap, for hidden members after the chip holder.
				if (!gapSeen && p.collapsed && p.chip === null) {
					this.gapOf(leaf.header);
					gapSeen = true;
				}
				if (!chipSeen && p.chip !== null) {
					this.divider.atStart(leaf.header);
					if (p.chip.name.trim().length > 0) inks.push([leaf.header.ownerDocument, p.chip.color]);
					chipSeen = true;
				}
			}
		}
		// The colours last: their probes are added to and removed from the body, after which the next
		// style read recomputes much of the page (measured at start-up: 10-18 ms against 0.2 ms).
		for (const [doc, color] of inks) this.ink.inkFor(doc, color);
		this.lastReadMs += performance.now() - started;
	}

	/**
	 * Chip slots: all widths are read first, then all slots written. Measuring after each write
	 * would make the browser lay the strip out once per chip.
	 */
	private flushSlots(): void {
		const pending = this.pendingSlots.filter(([header, chip]) => chip.parentElement === header);
		this.pendingSlots = [];
		const started = performance.now();
		const widths = pending.map(([, chip]) => chip.getBoundingClientRect().width);
		this.lastReadMs += performance.now() - started;
		pending.forEach(([header], i) => {
			this.writeSlot(header, widths[i] ?? 0);
		});
	}

	chipFor(groupId: string): HTMLElement | null {
		return this.chipsByGroup.get(groupId) ?? null;
	}

	/** All headers currently carrying marks (for tests and the unload check). */
	get decoratedCount(): number {
		return this.marks.size;
	}

	/** Re-measure inks and divider sides and rewrite every chip on the next render (theme changed). */
	invalidate(): void {
		this.divider.clear();
		this.gaps = new WeakMap();
		for (const marks of this.marks.values()) marks.key = '';
	}

	/** Removes every mark, chip, underline and custom property this class wrote. */
	clear(): void {
		this.pendingSlots = [];
		for (const header of [...this.marks.keys()]) this.unmark(header);
		this.chipsByGroup.clear();
		this.pruneWatches();
	}

	private apply(header: HTMLElement, p: HeaderPlan): HeaderMarks {
		const doc = header.ownerDocument;
		let marks = this.marks.get(header);
		if (marks !== undefined && marks.doc !== doc) {
			// Obsidian moved this header into another window: start again in that window's document.
			this.unmark(header);
			marks = undefined;
		}
		this.watchParent(header, doc);
		const chipLabel = p.chip === null ? '' : this.t.chipLabel(p.chip.name, p.chip.color, p.chip.count, p.chip.collapsed);
		// No ink while the window's styles are not ready (InkCache); the stylesheet's fallback shows.
		const ink = p.chip !== null && p.chip.name.trim().length > 0 ? (this.ink.inkFor(doc, p.chip.color) ?? '') : '';
		// A theme that draws the tab divider at the tab's start: move this tab's divider before the chip.
		const dividerStart = p.chip !== null && this.divider.atStart(header);
		// A collapsed group in a theme that draws the divider at the tab's end: its last member shows it.
		const dividerEnd = p.collapsed && this.divider.atEnd(header);
		// A hidden member after the chip holder cancels the strip's gap before it.
		const gap = p.collapsed && p.chip === null ? this.gapOf(header) : 0;
		const key = `${planKey(p, chipLabel, ink)}${dividerStart ? '|divider-start' : ''}${dividerEnd ? '|divider-end' : ''}${gap > 0 ? `|gap${String(gap)}` : ''}`;
		if (marks !== undefined && marks.key === key && marks.line.parentElement === header) {
			// Its observer was dropped while the header was out of the page (watchParent).
			if (marks.chip !== null && marks.observer === null) this.observe(header, marks);
			return marks;
		}

		if (marks === undefined) {
			const line = doc.createElement('div');
			line.className = CLS.line;
			line.setAttribute('aria-hidden', 'true');
			marks = { key: '', doc, line, chip: null, observer: null, unlisten: null, hadNoStyle: !header.hasAttribute('style') };
			this.marks.set(header, marks);
		}
		header.addClass(CLS.member);
		header.toggleClass(CLS.collapsed, p.collapsed);
		header.toggleClass(CLS.dividerEnd, dividerEnd);
		setAttr(header, ATTR.group, p.groupId);
		setAttr(header, ATTR.color, p.color);
		if (marks.line.parentElement !== header) header.appendChild(marks.line);
		setProp(header, GAP_PROP, gap > 0 ? `${String(gap)}px` : '');

		if (p.chip === null) {
			this.removeChip(header, marks);
		} else {
			const created = marks.chip === null;
			const chip = marks.chip ?? this.createChip(header, marks);
			const resized = this.updateChip(chip, p.chip, chipLabel, ink);
			header.addClass(CLS.hasChip);
			header.toggleClass(CLS.dividerStart, dividerStart);
			// Measuring forces a layout of the whole strip: only when the chip's size may have changed
			// (new chip, other text, dot or label). Later changes (fonts) come through the observer.
			if (created || resized || header.style.getPropertyValue(SLOT_PROP) === '') this.pendingSlots.push([header, chip]);
		}
		marks.key = key;
		return marks;
	}

	private unmark(header: HTMLElement): void {
		const marks = this.marks.get(header);
		this.marks.delete(header);
		header.removeClass(CLS.member);
		header.removeClass(CLS.collapsed);
		header.removeClass(CLS.dividerEnd);
		header.removeAttribute(ATTR.group);
		header.removeAttribute(ATTR.color);
		setProp(header, GAP_PROP, '');
		if (marks === undefined) return;
		this.removeChip(header, marks);
		marks.line.remove();
		if (marks.hadNoStyle && header.getAttribute('style') === '') header.removeAttribute('style');
	}

	/** The column gap of the header's container (the strip's flex box), cached per container. */
	private gapOf(header: HTMLElement): number {
		const parent = header.parentElement;
		const win = header.ownerDocument.defaultView;
		if (parent === null || win === null) return 0;
		let gap = this.gaps.get(parent);
		if (gap === undefined) {
			gap = gapPx(win.getComputedStyle(parent).columnGap);
			this.gaps.set(parent, gap);
		}
		return gap;
	}

	private createChip(header: HTMLElement, marks: HeaderMarks): HTMLElement {
		const doc = marks.doc;
		const chip = doc.createElement('div');
		chip.className = CLS.chip;
		chip.setAttribute('role', 'button');
		chip.setAttribute('tabindex', '0');
		// Its own drag source, so a drag that starts on the chip never drags the tab (cancelled below).
		chip.setAttribute('draggable', 'true');
		const dot = doc.createElement('span');
		dot.className = CLS.dot;
		const label = doc.createElement('span');
		label.className = CLS.label;
		chip.append(dot, label);
		this.shield(chip);
		header.appendChild(chip);
		marks.chip = chip;
		marks.unlisten = this.guardHeader(header, chip);
		this.observe(header, marks);
		return chip;
	}

	/**
	 * The margin must follow the chip width: CJK text and late font loads change it. The observer
	 * comes from the chip's own window. An observer from another window (say the main window
	 * watching a pop-out chip) belongs to that other window: if it still watches the chip when
	 * the pop-out closes, Chromium can no longer deliver it and reports "ResizeObserver loop
	 * completed with undelivered notifications" in the main window every frame (Obsidian's own
	 * observers do this; found in the maintainer's L4 tests). A window that is already gone gets none,
	 * and neither does a header that is out of its window (watchParent).
	 */
	private observe(header: HTMLElement, marks: HeaderMarks): void {
		const chip = marks.chip;
		if (!this.chipObservers || chip === null || marks.observer !== null || !header.isConnected || header.ownerDocument !== marks.doc) return;
		const Observer = marks.doc.defaultView?.ResizeObserver;
		if (Observer === undefined) return;
		marks.observer = new Observer(() => {
			if (chip.parentElement === header) this.updateSlot(header, chip);
		});
		// The content box. A thicker border (forced colours, styles.css) also changes it: the chip's
		// height is fixed and border-box sized, so its content gets shorter (L5 review round 1, V3).
		marks.observer.observe(chip);
	}

	/**
	 * Obsidian moves a tab into another window ("Move to new window", drag and drop) by taking
	 * its header out of its strip and putting the same element into the other window's strip.
	 * The chip's observer belongs to the old window and must not keep watching an element of
	 * another window (see observe). So each window watches the parents of its decorated headers
	 * (child list only: it changes only when tabs are added, removed or moved). In the microtask
	 * after a decorated header has left the page or its window, before any resize notification
	 * can be delivered, its observer is disconnected and a pass is requested; the pass makes the
	 * marks again where the header is now (or removes them).
	 */
	private watchParent(header: HTMLElement, doc: Document): void {
		const parent = header.parentElement;
		if (parent === null) return;
		let watch = this.parentWatches.get(doc);
		if (watch === undefined) {
			const Observer = doc.defaultView?.MutationObserver;
			if (Observer === undefined) return;
			watch = {
				observer: new Observer(() => {
					this.onHeadersMoved();
				}),
				parents: new WeakSet(),
			};
			this.parentWatches.set(doc, watch);
		}
		if (watch.parents.has(parent)) return;
		watch.parents.add(parent);
		watch.observer.observe(parent, { childList: true });
	}

	private onHeadersMoved(): void {
		let moved = false;
		for (const [header, marks] of this.marks) {
			if (header.isConnected && header.ownerDocument === marks.doc) continue;
			moved = true;
			marks.observer?.disconnect();
			marks.observer = null;
		}
		if (moved) this.hooks.moved();
	}

	/** Stops watching windows that have no decorated header left. */
	private pruneWatches(): void {
		const live = new Set<Document>();
		for (const marks of this.marks.values()) live.add(marks.doc);
		for (const [doc, watch] of this.parentWatches) {
			if (live.has(doc)) continue;
			watch.observer.disconnect();
			this.parentWatches.delete(doc);
		}
	}

	/** Writes the chip's marks; true when its size may have changed (its text, or dot versus label). */
	private updateChip(chip: HTMLElement, p: ChipPlan, chipLabel: string, ink: string): boolean {
		const named = p.name.trim().length > 0;
		const wasUnnamed = chip.classList.contains(CLS.unnamed);
		setAttr(chip, ATTR.group, p.groupId);
		setAttr(chip, ATTR.color, p.color);
		chip.toggleClass(CLS.unnamed, !named);
		chip.toggleClass(CLS.chipCollapsed, p.collapsed);
		setAttr(chip, 'aria-expanded', p.collapsed ? 'false' : 'true');
		if (named && ink !== '') setAttr(chip, ATTR.ink, ink);
		else chip.removeAttribute(ATTR.ink);
		setAttr(chip, 'aria-label', chipLabel);
		const label = chip.querySelector<HTMLElement>(`:scope > .${CLS.label}`);
		let resized = wasUnnamed === named;
		if (label !== null && label.textContent !== p.name) {
			label.textContent = p.name;
			resized = true;
		}
		return resized;
	}

	private updateSlot(header: HTMLElement, chip: HTMLElement): void {
		this.writeSlot(header, chip.getBoundingClientRect().width);
	}

	private writeSlot(header: HTMLElement, width: number): void {
		// A hidden chip (stacked strip, closed window) has no width; keep the last value.
		if (width <= 0) return;
		const slot = `${String(Math.ceil(width) + 2 * CHIP_GAP)}px`;
		if (header.style.getPropertyValue(SLOT_PROP) !== slot) header.setCssProps({ [SLOT_PROP]: slot });
	}

	private removeChip(header: HTMLElement, marks: HeaderMarks): void {
		marks.observer?.disconnect();
		marks.observer = null;
		marks.unlisten?.();
		marks.unlisten = null;
		marks.chip?.remove();
		marks.chip = null;
		header.removeClass(CLS.hasChip);
		header.removeClass(CLS.dividerStart);
		if (header.style.getPropertyValue(SLOT_PROP) !== '') header.setCssProps({ [SLOT_PROP]: '' });
		if (marks.hadNoStyle && header.getAttribute('style') === '') header.removeAttribute('style');
	}

	/**
	 * A press on the chip that is released over its tab makes the browser send the click (or
	 * middle-button auxclick) to the header, their common ancestor: that would activate (or
	 * close) the tab. Swallow exactly that click, in the capture phase on the header.
	 */
	private guardHeader(header: HTMLElement, chip: HTMLElement): () => void {
		let pressedOnChip = false;
		const onDown = (evt: MouseEvent) => {
			pressedOnChip = chip.contains(evt.target as Node | null);
		};
		const onRelease = (evt: MouseEvent) => {
			if (!pressedOnChip || chip.contains(evt.target as Node | null)) return;
			pressedOnChip = false;
			evt.preventDefault();
			evt.stopPropagation();
		};
		header.addEventListener('mousedown', onDown, true);
		header.addEventListener('click', onRelease, true);
		header.addEventListener('auxclick', onRelease, true);
		return () => {
			header.removeEventListener('mousedown', onDown, true);
			header.removeEventListener('click', onRelease, true);
			header.removeEventListener('auxclick', onRelease, true);
		};
	}

	/**
	 * Keeps the chip's events away from the tab header it lives in (the header and its strip
	 * listen in the bubble phase, so stopping at the chip is enough; step L2 §8).
	 */
	private shield(chip: HTMLElement): void {
		const stop = (evt: Event) => {
			evt.preventDefault();
			evt.stopPropagation();
		};
		const groupOf = () => chip.getAttribute(ATTR.group);
		let keyboardMenuAt = 0;
		// Left click collapses or expands the group (step L5), and never reaches the tab.
		chip.addEventListener('click', (evt) => {
			stop(evt);
			const groupId = groupOf();
			if (groupId === null) return;
			this.hooks.toggle(groupId, chip, false);
			if (evt.detail >= 1) swallowSecondClick(chip.ownerDocument, evt);
		});
		// Middle click closes a tab on its header.
		chip.addEventListener('auxclick', stop);
		chip.addEventListener('mousedown', (evt) => {
			// No autoscroll cursor on a middle press.
			if (evt.button === 1) evt.preventDefault();
		});
		chip.addEventListener('dblclick', stop);
		// The header asks for a page preview unless the event was default-prevented; others still see it.
		chip.addEventListener('mouseover', (evt) => {
			evt.preventDefault();
		});
		chip.addEventListener('dragstart', stop);
		chip.addEventListener('contextmenu', (evt) => {
			stop(evt);
			const groupId = groupOf();
			// A context-menu key press may also send a contextmenu event; the key handler already opened the menu.
			if (groupId === null || evt.timeStamp - keyboardMenuAt < 500) return;
			this.hooks.chipMenu(groupId, chip, evt);
		});
		chip.addEventListener('keydown', (evt) => {
			// Enter / Space toggle like a button. The editor bubble handles its own keys on its own root.
			if ((evt.key === 'Enter' || evt.key === ' ') && !evt.shiftKey && !evt.altKey && !evt.ctrlKey && !evt.metaKey && !evt.isComposing) {
				stop(evt);
				const groupId = groupOf();
				if (groupId !== null && !evt.repeat) this.hooks.toggle(groupId, chip, true);
				return;
			}
			if (evt.key !== 'ContextMenu' && !(evt.key === 'F10' && evt.shiftKey)) return;
			stop(evt);
			const groupId = groupOf();
			if (groupId === null) return;
			keyboardMenuAt = evt.timeStamp;
			this.hooks.chipMenu(groupId, chip, null);
		});
	}
}

/** How long after a chip click its double-click partner is expected, in ms (a common system default). */
const DOUBLE_CLICK_MS = 500;

/**
 * Collapsing or expanding changes the tab widths, so the chip can move away from under the
 * pointer: the second click of a double click on the chip would then land on a tab (activating it)
 * and send a double click to the strip (in a frameless window that zooms it). So the press, click
 * and double click that complete a double click right after a chip click, at the same place, are
 * swallowed in the capture phase of that window. A double click on the chip toggles once.
 */
function swallowSecondClick(doc: Document, first: MouseEvent): void {
	const win = doc.defaultView;
	if (win === null) return;
	const types = ['mousedown', 'mouseup', 'click', 'dblclick'] as const;
	const until = first.timeStamp + DOUBLE_CLICK_MS;
	const onEvent = (evt: MouseEvent) => {
		if (evt.timeStamp > until) {
			done();
			return;
		}
		const near = Math.abs(evt.clientX - first.clientX) <= 4 && Math.abs(evt.clientY - first.clientY) <= 4;
		if (evt.detail < 2 || !near || evt.button !== 0) return;
		evt.preventDefault();
		evt.stopPropagation();
		if (evt.type === 'dblclick') done();
	};
	const done = () => {
		win.clearTimeout(timer);
		for (const type of types) doc.removeEventListener(type, onEvent, true);
	};
	for (const type of types) doc.addEventListener(type, onEvent, true);
	const timer = win.setTimeout(done, DOUBLE_CLICK_MS + 50);
}

function setProp(el: HTMLElement, name: string, value: string): void {
	if (el.style.getPropertyValue(name) !== value) el.setCssProps({ [name]: value });
}

function setAttr(el: HTMLElement, name: string, value: string): void {
	if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
