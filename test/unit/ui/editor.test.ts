/**
 * Editor bubble: where it opens and where the keyboard focus goes when it closes
 * (close-out round 1 of step L4: stacked-bubble-corner, bubble-hides-underline, bubble-drops-focus).
 */
import { describe, expect, it } from 'vitest';
import { translator } from '../../../src/i18n';
import { GroupEditor, type EditorCallbacks, type EditorTarget } from '../../../src/ui/editor';
import { FakeDocument, fakeEvent, rect, ZERO, type FakeElement } from './fake-dom';

const TARGET: EditorTarget = { groupId: 'g1', name: 'Research', color: 'blue' };

function callbacks(): EditorCallbacks & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		preview: (name) => calls.push(`preview ${name}`),
		color: (color) => calls.push(`color ${color}`),
		commit: (name) => calls.push(`commit ${name}`),
		cancel: (o) => calls.push(`cancel ${o.name} ${o.color}`),
		focusFallback: () => calls.push('fallback'),
	};
}

/**
 * A horizontal strip like Obsidian 1.15's default theme: the strip is 40px tall, the first
 * member's header spans 6–40, the chip sits in its start margin (11–32), and the group's
 * underline runs along the bottom 2px (38–40). A note editor has the focus.
 */
/** The bubble's own box once it is in the page (248 × 110 px). */
function page(): FakeDocument {
	const doc = new FakeDocument();
	doc.defaultBoxes['tabstrip-editor'] = rect(0, 0, 248, 110);
	return doc;
}

function horizontal() {
	const doc = page();
	const container = doc.el(doc.body, 'workspace-tab-header-container', rect(0, 0, 1024, 40));
	const inner = doc.el(container, 'workspace-tab-header-container-inner', rect(0, 5, 1024, 35));
	const header = doc.el(inner, 'workspace-tab-header tabstrip-member tabstrip-has-chip', rect(550, 6, 93, 34));
	const chip = doc.el(header, 'tabstrip-chip', rect(450, 11, 96, 21));
	const line = doc.el(header, 'tabstrip-line', rect(450, 38, 193, 2));
	const note = doc.el(doc.body, 'cm-content', rect(0, 80, 1024, 700));
	note.focus();
	return { doc, container, header, chip, line, note };
}

/**
 * A stacked strip: the headers are tall vertical spines out of the header container, and the
 * stylesheet hides the chip (display: none), so the chip has no box.
 */
function stacked() {
	const doc = page();
	const tabs = doc.el(doc.body, 'workspace-tabs mod-stacked', rect(0, 0, 1024, 800));
	const header = doc.el(tabs, 'workspace-tab-header tabstrip-member tabstrip-has-chip', rect(40, 40, 40, 740));
	const chip = doc.el(header, 'tabstrip-chip', ZERO);
	const note = doc.el(tabs, 'cm-content', rect(80, 80, 900, 700));
	note.focus();
	return { doc, header, chip, note };
}

function bubbleOf(doc: FakeDocument): FakeElement | undefined {
	return doc.body.children.find((c) => c.className === 'tabstrip-editor');
}

function position(doc: FakeDocument): { left: number; top: number } {
	const bubble = bubbleOf(doc);
	if (bubble === undefined) throw new Error('no bubble');
	return { left: parseFloat(bubble.props['--tabstrip-editor-left'] ?? 'NaN'), top: parseFloat(bubble.props['--tabstrip-editor-top'] ?? 'NaN') };
}

function inputOf(doc: FakeDocument): FakeElement {
	const input = bubbleOf(doc)?.children.find((c) => c.className === 'tabstrip-editor-input');
	if (input === undefined) throw new Error('no input');
	return input;
}

function key(doc: FakeDocument, k: string): void {
	doc.dispatch(fakeEvent('keydown', inputOf(doc), { key: k }));
}

function editor(): GroupEditor {
	return new GroupEditor(translator('en'));
}

describe('editor bubble placement', () => {
	it('opens under the whole tab strip, left-aligned with the chip, so the group underline stays visible', () => {
		const { doc, chip, line } = horizontal();
		editor().show(chip as unknown as HTMLElement, TARGET, callbacks());
		const at = position(doc);
		expect(at.left).toBe(450);
		// Below the strip's bottom edge (40), not just below the chip (32): the line (38–40) is not covered.
		expect(at.top).toBeGreaterThanOrEqual(line.box.bottom);
		expect(at.top).toBe(44);
	});

	it('hidden chip (stacked strip): beside the first member header, not in the window corner', () => {
		const { doc, chip, header } = stacked();
		const opened = editor().show(chip as unknown as HTMLElement, TARGET, callbacks());
		expect(opened).toBe(true);
		const at = position(doc);
		expect(at).toEqual({ left: header.box.right + 4, top: header.box.top });
	});

	it('neither the chip nor its header has a box: no bubble', () => {
		const { doc, chip, header } = stacked();
		header.box = ZERO;
		const opened = editor().show(chip as unknown as HTMLElement, TARGET, callbacks());
		expect(opened).toBe(false);
		expect(bubbleOf(doc)).toBeUndefined();
	});

	it('follows its chip when the strip turns stacked while it is open', () => {
		const { doc, chip, header } = horizontal();
		const e = editor();
		e.show(chip as unknown as HTMLElement, TARGET, callbacks());
		// Stacked: the chip loses its box and the header becomes a tall spine out of the container.
		chip.box = ZERO;
		header.remove();
		doc.body.appendChild(header);
		header.box = rect(40, 40, 40, 740);
		e.reposition(chip as unknown as HTMLElement);
		expect(position(doc)).toEqual({ left: 84, top: 40 });
	});

	it('stays at its anchor while open: checked once per frame, moved only when the place changed', () => {
		const { doc, chip, header } = stacked();
		const e = editor();
		e.show(chip as unknown as HTMLElement, TARGET, callbacks());
		expect(position(doc)).toEqual({ left: 84, top: 40 });
		expect(doc.defaultView?.frames.size).toBe(1);
		// The stacked strip scrolls the header into view after the bubble opened (no event needed:
		// tabs that change width or settle late move the anchor without one).
		header.box = rect(524, 40, 40, 740);
		doc.defaultView?.runFrames();
		expect(position(doc)).toEqual({ left: 568, top: 40 });
		header.box = rect(600, 40, 40, 740);
		doc.defaultView?.runFrames();
		expect(position(doc)).toEqual({ left: 644, top: 40 });
		// An unchanged place writes nothing.
		const bubble = bubbleOf(doc);
		if (bubble === undefined) throw new Error('no bubble');
		bubble.props['--tabstrip-editor-left'] = 'untouched';
		doc.defaultView?.runFrames();
		expect(bubble.props['--tabstrip-editor-left']).toBe('untouched');
		// Closed: no frame pending any more.
		e.close('commit');
		expect(doc.defaultView?.frames.size).toBe(0);
	});

	it('right-to-left: aligned with the chip start edge on the right', () => {
		const { doc, chip } = horizontal();
		chip.computed = { direction: 'rtl' };
		editor().show(chip as unknown as HTMLElement, TARGET, callbacks());
		expect(position(doc)).toEqual({ left: chip.box.right - 248, top: 44 });
	});
});

describe('editor bubble focus', () => {
	it('opens with the focus in the name field', () => {
		const { doc, chip } = horizontal();
		editor().show(chip as unknown as HTMLElement, TARGET, callbacks());
		expect(doc.activeElement).toBe(inputOf(doc));
	});

	it('Enter commits and gives the focus back to what had it before (the note)', () => {
		const { doc, chip, note } = horizontal();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		inputOf(doc).value = 'New name';
		key(doc, 'Enter');
		expect(cb.calls).toContain('commit New name');
		expect(bubbleOf(doc)).toBeUndefined();
		expect(doc.activeElement).toBe(note);
	});

	it('Escape cancels and gives the focus back to the chip when the bubble came from the keyboard chip menu', () => {
		const { doc, chip } = horizontal();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb, { returnFocus: () => chip as unknown as HTMLElement });
		key(doc, 'Escape');
		expect(cb.calls).toContain('cancel Research blue');
		expect(doc.activeElement).toBe(chip);
	});

	it('the element that had the focus is gone (a closed menu): the controller focuses the active tab', () => {
		const { doc, chip } = horizontal();
		const menuItem = doc.el(doc.body, 'menu-item');
		menuItem.focus();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		menuItem.remove();
		key(doc, 'Enter');
		expect(cb.calls).toContain('fallback');
	});

	it('focus was on the body before: the controller focuses the active tab', () => {
		const { doc, chip } = horizontal();
		doc.activeElement = doc.body;
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		key(doc, 'Escape');
		expect(cb.calls).toContain('fallback');
	});

	it('a click outside keeps the focus the click gave, and restores it only when the click left it on the body', () => {
		const a = horizontal();
		const other = a.doc.el(a.doc.body, 'nav-file-title');
		const e1 = editor();
		const cb = callbacks();
		e1.show(a.chip as unknown as HTMLElement, TARGET, cb);
		a.doc.dispatch(fakeEvent('mousedown', other));
		expect(bubbleOf(a.doc)).toBeUndefined();
		// A click outside commits (close-out round 2: this was never asserted).
		expect(cb.calls).toEqual(['commit Research']);
		// The browser then focuses what was clicked.
		other.focus();
		a.doc.defaultView?.runTimers();
		expect(a.doc.activeElement).toBe(other);

		const b = horizontal();
		const blank = b.doc.el(b.doc.body, 'workspace-tab-header-spacer');
		editor().show(b.chip as unknown as HTMLElement, TARGET, callbacks());
		b.doc.dispatch(fakeEvent('mousedown', blank));
		// Nothing focusable was clicked: the focus fell back to the body.
		expect(b.doc.activeElement).toBe(b.doc.body);
		b.doc.defaultView?.runTimers();
		expect(b.doc.activeElement).toBe(b.note);
	});

	it('dropped (its group went away): the focus goes back only if it was in the bubble', () => {
		const a = horizontal();
		const e1 = editor();
		e1.show(a.chip as unknown as HTMLElement, TARGET, callbacks());
		e1.close('drop');
		expect(a.doc.activeElement).toBe(a.note);

		const b = horizontal();
		const e2 = editor();
		e2.show(b.chip as unknown as HTMLElement, TARGET, callbacks());
		const elsewhere = b.doc.el(b.doc.body, 'search-input');
		elsewhere.focus();
		e2.close('drop');
		expect(b.doc.activeElement).toBe(elsewhere);
	});

	it('IME composition: Enter and Escape do not close the bubble', () => {
		const { doc, chip } = horizontal();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		doc.dispatch(fakeEvent('keydown', inputOf(doc), { key: 'Enter', isComposing: true }));
		doc.dispatch(fakeEvent('keydown', inputOf(doc), { key: 'Escape', isComposing: true }));
		expect(bubbleOf(doc)).toBeDefined();
		expect(cb.calls).toEqual([]);
	});

	it('opening a second bubble commits the first without moving the focus back', () => {
		const { doc, chip } = horizontal();
		const cb = callbacks();
		const e = editor();
		e.show(chip as unknown as HTMLElement, TARGET, cb);
		e.show(chip as unknown as HTMLElement, { ...TARGET, groupId: 'g2' }, callbacks());
		expect(cb.calls).toContain('commit Research');
		expect(doc.activeElement).toBe(inputOf(doc));
		expect(cb.calls).not.toContain('fallback');
	});
});

/**
 * Close-out round 2 (bubble-swatch-outside-untested): a swatch click recolours at once and keeps
 * the focus in the name field; Escape afterwards undoes it (the original colour goes back with
 * cancel); a click outside commits what was typed.
 */
describe('editor bubble swatches and click outside', () => {
	function swatch(doc: FakeDocument, color: string): FakeElement {
		const colors = bubbleOf(doc)?.children.find((c) => c.className === 'tabstrip-editor-colors');
		const el = colors?.children.find((c) => c.getAttribute('data-tabstrip-color') === color);
		if (el === undefined) throw new Error(`no ${color} swatch`);
		return el;
	}
	const selected = (doc: FakeDocument) =>
		['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].filter((c) => {
			const el = swatch(doc, c);
			return el.getAttribute('aria-checked') === 'true' && el.classList.contains('is-selected');
		});

	it('opens with the group colour checked', () => {
		const { doc, chip } = horizontal();
		editor().show(chip as unknown as HTMLElement, TARGET, callbacks());
		expect(selected(doc)).toEqual(['blue']);
	});

	it('a swatch click recolours, moves the check and keeps the focus in the name field; Escape then cancels with the original colour', () => {
		const { doc, chip, note } = horizontal();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		const red = swatch(doc, 'red');
		// A real click focuses the clicked element first (the swatch is focusable).
		red.focus();
		red.dispatch(fakeEvent('click', red));
		expect(cb.calls).toEqual(['color red']);
		expect(selected(doc)).toEqual(['red']);
		expect(doc.activeElement).toBe(inputOf(doc));
		key(doc, 'Escape');
		expect(cb.calls).toEqual(['color red', 'cancel Research blue']);
		expect(bubbleOf(doc)).toBeUndefined();
		expect(doc.activeElement).toBe(note);
	});

	it('a click outside commits the typed name (trimmed) and the bubble closes', () => {
		const { doc, chip, note } = horizontal();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		swatch(doc, 'green').dispatch(fakeEvent('click', swatch(doc, 'green')));
		inputOf(doc).value = '  Outside  ';
		doc.dispatch(fakeEvent('mousedown', note));
		expect(cb.calls).toEqual(['color green', 'commit Outside']);
		expect(bubbleOf(doc)).toBeUndefined();
		// No cancel: the green colour stays.
		expect(cb.calls.some((c) => c.startsWith('cancel'))).toBe(false);
	});

	it('a press inside the bubble (a swatch, the field) does not close it', () => {
		const { doc, chip } = horizontal();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		doc.dispatch(fakeEvent('mousedown', swatch(doc, 'pink')));
		doc.dispatch(fakeEvent('mousedown', inputOf(doc)));
		expect(bubbleOf(doc)).toBeDefined();
		expect(cb.calls).toEqual([]);
	});

	it('Space or Enter on a focused swatch picks it without closing the bubble', () => {
		const { doc, chip } = horizontal();
		const cb = callbacks();
		editor().show(chip as unknown as HTMLElement, TARGET, cb);
		const cyan = swatch(doc, 'cyan');
		cyan.focus();
		doc.dispatch(fakeEvent('keydown', cyan, { key: ' ' }));
		expect(selected(doc)).toEqual(['cyan']);
		const orange = swatch(doc, 'orange');
		orange.focus();
		doc.dispatch(fakeEvent('keydown', orange, { key: 'Enter' }));
		expect(selected(doc)).toEqual(['orange']);
		expect(cb.calls).toEqual(['color cyan', 'color orange']);
		expect(bubbleOf(doc)).toBeDefined();
		expect(doc.activeElement).toBe(orange);
	});
});
