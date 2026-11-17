/**
 * Ink cache: chip text colour measured per window. A pop-out window gets its stylesheets
 * after it opens; a measurement taken before they apply must not be kept
 * (close-out round 1 of step L4: pop-out ink contrast).
 */
import { describe, expect, it } from 'vitest';
import { InkCache } from '../../../src/ui/ink';
import { FakeDocument, FakeWindow, type FakeElement } from './fake-dom';

/** Obsidian 1.15 default light theme fills. */
const LIGHT: Record<string, string> = {
	grey: 'rgb(171, 171, 171)',
	blue: 'rgb(8, 109, 221)',
	red: 'rgb(233, 49, 71)',
	yellow: 'rgb(224, 172, 0)',
	green: 'rgb(8, 185, 78)',
	pink: 'rgb(213, 57, 132)',
	purple: 'rgb(120, 82, 238)',
	cyan: 'rgb(0, 191, 188)',
	orange: 'rgb(236, 117, 0)',
};

/**
 * A window whose styles may not be there yet. Without Obsidian's stylesheet the colour
 * variables are undefined, so `--tabstrip-group-color: var(--color-blue)` is invalid and the
 * probe's background is transparent, on a transparent body.
 */
class StyledWindow extends FakeWindow {
	styled = false;
	reads = 0;

	override getComputedStyle(el: FakeElement) {
		this.reads++;
		const color = el.getAttribute('data-tabstrip-color');
		const computed: Record<string, string> =
			color === null
				? { backgroundColor: this.styled ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)' }
				: this.styled
					? { backgroundColor: LIGHT[color] ?? '', '--tabstrip-group-color': LIGHT[color] ?? '' }
					: { backgroundColor: 'rgba(0, 0, 0, 0)', '--tabstrip-group-color': '' };
		return { ...computed, getPropertyValue: (name: string) => computed[name] ?? '' };
	}
}

function popout(): { doc: FakeDocument; win: StyledWindow } {
	const win = new StyledWindow();
	return { doc: new FakeDocument(win), win };
}

const asDoc = (d: FakeDocument) => d as unknown as Document;

describe('InkCache', () => {
	it('styles not applied yet (a fresh pop-out): no ink, nothing cached; the real ink once they apply', () => {
		const { doc, win } = popout();
		const cache = new InkCache();
		expect(cache.inkFor(asDoc(doc), 'blue')).toBeNull();
		expect(cache.takePending()).toBe(true);
		win.styled = true;
		// White on #086ddd is 4.95:1; dark ink would be 3.25:1.
		expect(cache.inkFor(asDoc(doc), 'blue')).toBe('light');
		expect(cache.takePending()).toBe(false);
	});

	it('a stylesheet still loading counts as not ready, even when the colour variables are there', () => {
		const { doc, win } = popout();
		win.styled = true;
		const link = doc.el(doc.head, '', undefined, 'link') as FakeElement & { sheet?: unknown };
		link.setAttribute('rel', 'stylesheet');
		link.sheet = null;
		const cache = new InkCache();
		expect(cache.inkFor(asDoc(doc), 'blue')).toBeNull();
		link.sheet = {};
		// Within one pass a window that was not ready is not measured again.
		expect(cache.inkFor(asDoc(doc), 'red')).toBeNull();
		expect(cache.takePending()).toBe(true);
		expect(cache.inkFor(asDoc(doc), 'blue')).toBe('light');
	});

	it('measures a ready window once, until clear()', () => {
		const { doc, win } = popout();
		win.styled = true;
		const cache = new InkCache();
		expect(cache.inkFor(asDoc(doc), 'yellow')).toBe('dark');
		const reads = win.reads;
		expect(cache.inkFor(asDoc(doc), 'blue')).toBe('light');
		expect(win.reads).toBe(reads);
		cache.clear();
		cache.inkFor(asDoc(doc), 'blue');
		expect(win.reads).toBeGreaterThan(reads);
	});

	it('leaves no probe behind, ready or not', () => {
		const { doc, win } = popout();
		const cache = new InkCache();
		cache.inkFor(asDoc(doc), 'blue');
		win.styled = true;
		cache.clear();
		cache.inkFor(asDoc(doc), 'blue');
		expect(doc.body.children).toEqual([]);
	});

	it('a document whose window is gone: no ink and nothing to wait for', () => {
		const doc = new FakeDocument(null);
		const cache = new InkCache();
		expect(cache.inkFor(asDoc(doc), 'blue')).toBeNull();
		expect(cache.takePending()).toBe(false);
	});
});

/**
 * Close-out round 2 (ink-unparseable-color-white-fallback): a theme that defines its colours in
 * oklch (Cupertino's greys on macOS: --colorist-l-50 0.8) computes to `oklch(…)`. The ink must
 * be chosen from that fill, never fall back to white unchecked.
 */
class FillWindow extends FakeWindow {
	constructor(private readonly fills: Record<string, string>) {
		super();
	}

	override getComputedStyle(el: FakeElement) {
		const color = el.getAttribute('data-tabstrip-color');
		const fill = color === null ? 'rgb(255, 255, 255)' : (this.fills[color] ?? LIGHT[color] ?? '');
		const computed: Record<string, string> = color === null ? { backgroundColor: fill } : { backgroundColor: fill, '--tabstrip-group-color': fill };
		return { ...computed, getPropertyValue: (name: string) => computed[name] ?? '' };
	}
}

/** A 2D context that only knows the colours in `known` (as a canvas would after parsing them). */
function fakeCanvasContext(known: Record<string, [number, number, number, number]>) {
	let style = '#000000';
	let painted: [number, number, number, number] = [0, 0, 0, 0];
	return {
		get fillStyle() {
			return style;
		},
		set fillStyle(v: string) {
			if (v === '#000000' || v === '#ffffff' || v in known) style = v;
		},
		clearRect() {
			painted = [0, 0, 0, 0];
		},
		fillRect() {
			painted = style === '#000000' ? [0, 0, 0, 255] : style === '#ffffff' ? [255, 255, 255, 255] : (known[style] ?? [0, 0, 0, 0]);
		},
		getImageData() {
			return { data: painted };
		},
	};
}

describe('InkCache: fills in other colour spaces', () => {
	it('an oklch grey (Cupertino, macOS light) gets the dark ink, not white (1.9:1)', () => {
		const doc = new FakeDocument(new FillWindow({ grey: 'oklch(0.8 0 279)' }));
		expect(new InkCache().inkFor(asDoc(doc), 'grey')).toBe('dark');
	});

	it('the same on Windows (oklch L 0.76): dark ink (7.5:1), not white (2.1:1)', () => {
		const doc = new FakeDocument(new FillWindow({ grey: 'oklch(0.76 0 285)' }));
		expect(new InkCache().inkFor(asDoc(doc), 'grey')).toBe('dark');
	});

	it('lab() and color(display-p3 …) fills are converted too', () => {
		const doc = new FakeDocument(new FillWindow({ grey: 'lab(77 0 0)', blue: 'color(display-p3 0.1 0.2 0.6)' }));
		const cache = new InkCache();
		expect(cache.inkFor(asDoc(doc), 'grey')).toBe('dark');
		expect(cache.inkFor(asDoc(doc), 'blue')).toBe('light');
	});

	it('a form the parser does not know is painted on a canvas of the window and read back', () => {
		const doc = new FakeDocument(new FillWindow({ grey: 'color(future-space 0.8 0.8 0.8)' }));
		const created: string[] = [];
		const createElement = doc.createElement.bind(doc);
		doc.createElement = (tag: string) => {
			created.push(tag);
			const el = createElement(tag);
			if (tag === 'canvas') Object.assign(el, { getContext: () => fakeCanvasContext({ 'color(future-space 0.8 0.8 0.8)': [204, 204, 204, 255] }) });
			return el;
		};
		expect(new InkCache().inkFor(asDoc(doc), 'grey')).toBe('dark');
		expect(created).toContain('canvas');
		// Nothing was added to the page for it.
		expect(doc.body.children).toEqual([]);
	});

	it('a fill that can be read in no way gets no ink (the stylesheet fallback), never a guessed white', () => {
		const doc = new FakeDocument(new FillWindow({ grey: 'color(future-space 0.8 0.8 0.8)' }));
		const cache = new InkCache();
		expect(cache.inkFor(asDoc(doc), 'grey')).toBeNull();
		// Not a window that is still loading: nothing to retry.
		expect(cache.takePending()).toBe(false);
		// The other colours of that window are still measured.
		expect(cache.inkFor(asDoc(doc), 'blue')).toBe('light');
	});
});
