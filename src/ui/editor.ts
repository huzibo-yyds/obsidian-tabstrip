/**
 * Chrome-like group editor bubble: a small popover under the tab strip, at the chip, with the
 * name field and the nine colour swatches. Opens right after a group is created and from
 * "Rename group".
 *
 * Enter or a click outside commits, Escape cancels. While an input method is composing,
 * Enter and Escape belong to the input method and are ignored (requirements 5.6).
 * The bubble is created in the chip's own document, so it works in pop-out windows.
 *
 * Placement (placement.ts): under the whole strip, so the group's underline stays visible
 * while a colour is picked. In a stacked strip the chip is hidden; the bubble then opens
 * beside the group's first tab header.
 *
 * Focus: when the bubble closes with Enter or Escape, the keyboard focus goes back to where it
 * was (the note), or to the chip when the bubble came from the chip's keyboard menu, so it never
 * drops to the page body. A click outside keeps whatever focus the click gave.
 */
import { GROUP_COLORS, type GroupColor } from '../core/types';
import { GROUP_NAME_LIMIT } from '../core/model';
import type { Translator } from '../i18n';
import { ATTR } from './decorator';
import { placeBubble, type Box } from './placement';

export interface EditorTarget {
	readonly groupId: string;
	readonly name: string;
	readonly color: GroupColor;
}

export interface EditorCallbacks {
	/** The name field changed (live preview on the chip). */
	preview(name: string): void;
	/** A swatch was picked. */
	color(color: GroupColor): void;
	/** Enter or a click outside. */
	commit(name: string): void;
	/** Escape: undo the preview and colour changes made in this bubble. */
	cancel(original: EditorTarget): void;
	/** The element that had the focus before the bubble opened is gone: focus the active tab instead. */
	focusFallback?(): void;
	/** The bubble closed, however (after the focus was handled). */
	closed?(): void;
}

export interface EditorOptions {
	/** Where the focus goes back to when the bubble closes, looked up then (for example the chip). */
	readonly returnFocus?: () => HTMLElement | null;
}

/** How a closing bubble treats the keyboard focus. */
type FocusOnClose =
	/** Give it back now (Enter, Escape). */
	| 'now'
	/** A click outside: keep the focus the click gave; give it back only if it ended on the body. */
	| 'if-lost'
	/** Give it back only if it was in the bubble (the bubble was dropped). */
	| 'if-inside'
	/** Leave it (another bubble opens). */
	| 'none';

export const EDITOR_CLS = {
	root: 'tabstrip-editor',
	input: 'tabstrip-editor-input',
	colors: 'tabstrip-editor-colors',
	swatch: 'tabstrip-swatch',
} as const;

/** Bubble width in px (styles.css uses the same); used before the bubble has a box. */
const WIDTH = 248;

interface OpenEditor {
	readonly target: EditorTarget;
	/** The chip it is placed at (updated by reposition). */
	anchor: HTMLElement;
	readonly doc: Document;
	readonly win: Window;
	readonly root: HTMLElement;
	readonly input: HTMLInputElement;
	readonly callbacks: EditorCallbacks;
	readonly options: EditorOptions;
	/** What had the focus when the bubble opened. */
	readonly before: Element | null;
	readonly cleanup: () => void;
	/** Last position written ("left,top"), so an unchanged place writes nothing. */
	placed: string;
}

function hasBox(r: DOMRect): boolean {
	return r.width > 0 || r.height > 0;
}

/**
 * The element the bubble is placed at: the chip, or its tab header when the chip has no box
 * (hidden in a stacked strip); null when neither is visible.
 */
function anchorOf(chip: HTMLElement): { el: Element; box: Box } | null {
	const chipBox = chip.getBoundingClientRect();
	if (hasBox(chipBox)) return { el: chip, box: chipBox };
	const header = chip.closest('.workspace-tab-header');
	if (header === null) return null;
	const headerBox = header.getBoundingClientRect();
	return hasBox(headerBox) ? { el: header, box: headerBox } : null;
}

export class GroupEditor {
	private open: OpenEditor | null = null;

	constructor(private readonly t: Translator) {}

	get groupId(): string | null {
		return this.open?.target.groupId ?? null;
	}

	get element(): HTMLElement | null {
		return this.open?.root ?? null;
	}

	/** Document of the open bubble. */
	get document(): Document | null {
		return this.open?.doc ?? null;
	}

	/**
	 * Opens the bubble at `anchor` (the chip). Closes (commits) any other open bubble first.
	 * Returns false when neither the chip nor its tab header is visible.
	 */
	show(anchor: HTMLElement, target: EditorTarget, callbacks: EditorCallbacks, options: EditorOptions = {}): boolean {
		this.finish('commit', 'none');
		const doc = anchor.ownerDocument;
		const win = doc.defaultView;
		if (win === null || anchorOf(anchor) === null) return false;
		const before = doc.activeElement;

		const root = doc.createElement('div');
		root.className = EDITOR_CLS.root;
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-label', this.t.t('editor.title'));

		const input = doc.createElement('input');
		input.type = 'text';
		input.className = EDITOR_CLS.input;
		input.value = target.name;
		input.placeholder = this.t.t('editor.placeholder');
		input.spellcheck = false;
		input.maxLength = GROUP_NAME_LIMIT;
		input.setAttribute('aria-label', this.t.t('editor.name'));
		root.appendChild(input);

		const colors = doc.createElement('div');
		colors.className = EDITOR_CLS.colors;
		colors.setAttribute('role', 'radiogroup');
		colors.setAttribute('aria-label', this.t.t('editor.colors'));
		const swatches = GROUP_COLORS.map((color) => {
			const swatch = doc.createElement('div');
			swatch.className = EDITOR_CLS.swatch;
			swatch.setAttribute('role', 'radio');
			swatch.setAttribute('tabindex', '0');
			swatch.setAttribute(ATTR.color, color);
			swatch.setAttribute('aria-label', this.t.colorName(color));
			colors.appendChild(swatch);
			return { color, swatch };
		});
		const check = (color: GroupColor) => {
			for (const s of swatches) {
				s.swatch.setAttribute('aria-checked', String(s.color === color));
				s.swatch.toggleClass('is-selected', s.color === color);
			}
		};
		check(target.color);
		root.appendChild(colors);

		doc.body.appendChild(root);

		let composing = false;
		const onInput = () => {
			callbacks.preview(input.value);
		};
		const onCompositionStart = () => {
			composing = true;
		};
		const onCompositionEnd = () => {
			composing = false;
		};
		const onKeyDown = (evt: KeyboardEvent) => {
			// Enter and Escape during IME composition confirm or cancel the composition, not the bubble.
			if (evt.isComposing || composing || evt.key === 'Process') return;
			if (evt.key === 'Enter') {
				const swatch = swatches.find((s) => s.swatch === evt.target);
				evt.preventDefault();
				evt.stopPropagation();
				if (swatch !== undefined) {
					check(swatch.color);
					callbacks.color(swatch.color);
					return;
				}
				this.finish('commit', 'now');
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				evt.stopPropagation();
				this.finish('cancel', 'now');
			} else if (evt.key === ' ') {
				const swatch = swatches.find((s) => s.swatch === evt.target);
				if (swatch === undefined) return;
				evt.preventDefault();
				check(swatch.color);
				callbacks.color(swatch.color);
			}
		};
		const onSwatchClick = (evt: MouseEvent) => {
			const swatch = swatches.find((s) => s.swatch === evt.target);
			if (swatch === undefined) return;
			check(swatch.color);
			callbacks.color(swatch.color);
			input.focus();
		};
		const onOutside = (evt: MouseEvent) => {
			const node = evt.target as Node | null;
			if (node !== null && root.contains(node)) return;
			this.finish('commit', 'if-lost');
		};
		// Stay at the chip while open: the strip scrolls (a stacked strip scrolls the active tab
		// into view), tabs change width or settle after a layout change, the window is resized.
		// Checked once per frame; the bubble only moves when its place changed.
		let frame = 0;
		const follow = () => {
			frame = win.requestAnimationFrame(follow);
			if (this.open === open) this.place(open, open.anchor);
		};
		input.addEventListener('input', onInput);
		input.addEventListener('compositionstart', onCompositionStart);
		input.addEventListener('compositionend', onCompositionEnd);
		root.addEventListener('keydown', onKeyDown);
		colors.addEventListener('click', onSwatchClick);
		doc.addEventListener('mousedown', onOutside, true);

		const open: OpenEditor = {
			target,
			anchor,
			doc,
			win,
			root,
			input,
			callbacks,
			options,
			before,
			cleanup: () => {
				doc.removeEventListener('mousedown', onOutside, true);
				win.cancelAnimationFrame(frame);
				root.remove();
			},
			placed: '',
		};
		this.open = open;
		this.place(open, anchor);
		frame = win.requestAnimationFrame(follow);
		input.focus();
		input.select();
		return true;
	}

	/** Places the open bubble again at its chip (after a render: the chip moved, or the strip turned stacked). */
	reposition(anchor: HTMLElement): void {
		const open = this.open;
		if (open === null || anchor.ownerDocument !== open.doc) return;
		open.anchor = anchor;
		this.place(open, anchor);
	}

	/**
	 * Closes the bubble: 'commit' keeps the name, 'cancel' undoes this bubble's changes, 'drop'
	 * does neither. The focus goes back only if it was in the bubble.
	 */
	close(how: 'commit' | 'cancel' | 'drop'): void {
		this.finish(how, 'if-inside');
	}

	private place(open: OpenEditor, chip: HTMLElement): void {
		const anchor = anchorOf(chip);
		if (anchor === null) return;
		// Under the whole horizontal strip; in a stacked strip (no header container) the header's own bottom.
		const strip = anchor.el.closest('.workspace-tab-header-container');
		const below = strip === null ? anchor.box.bottom : strip.getBoundingClientRect().bottom;
		const size = open.root.getBoundingClientRect();
		const rtl = open.win.getComputedStyle(chip).direction === 'rtl';
		const at = placeBubble(
			anchor.box,
			below,
			{ width: size.width > 0 ? size.width : WIDTH, height: size.height },
			{ width: open.win.innerWidth, height: open.win.innerHeight },
			rtl,
		);
		const left = Math.round(at.left);
		const top = Math.round(at.top);
		const placed = `${String(left)},${String(top)}`;
		if (placed === open.placed) return;
		open.placed = placed;
		open.root.setCssProps({
			'--tabstrip-editor-left': `${String(left)}px`,
			'--tabstrip-editor-top': `${String(top)}px`,
		});
	}

	private finish(how: 'commit' | 'cancel' | 'drop', focus: FocusOnClose): void {
		const open = this.open;
		if (open === null) return;
		this.open = null;
		const name = open.input.value.trim();
		const focusInside = open.doc.activeElement !== null && open.root.contains(open.doc.activeElement);
		open.cleanup();
		if (how === 'commit') open.callbacks.commit(name);
		else if (how === 'cancel') open.callbacks.cancel(open.target);
		if (focus === 'now' || (focus === 'if-inside' && focusInside)) {
			this.restoreFocus(open);
		} else if (focus === 'if-lost') {
			// After the click's own default action has moved the focus (or not).
			open.win.setTimeout(() => {
				const now = open.doc.activeElement;
				if (now === null || now === open.doc.body) this.restoreFocus(open);
			}, 0);
		}
		open.callbacks.closed?.();
	}

	private restoreFocus(open: OpenEditor): void {
		const usable = (el: Element | null | undefined): HTMLElement | null => {
			if (el === null || el === undefined || !el.isConnected || el === open.doc.body || open.root.contains(el)) return null;
			const focusable = el as Partial<HTMLElement>;
			return typeof focusable.focus === 'function' ? (el as HTMLElement) : null;
		};
		const target = usable(open.options.returnFocus?.()) ?? usable(open.before);
		if (target !== null) target.focus();
		else open.callbacks.focusFallback?.();
	}
}
