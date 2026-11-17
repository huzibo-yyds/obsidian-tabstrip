/**
 * Step V6 (carry-overs from the V5 final review):
 * 1. When the list scrolls during a row drag, the drop line is drawn again at its row's new place,
 *    also when the spot (row and half) under the pointer is unchanged.
 * 2. At most one paint of the drop line and highlight per animation frame, however many drag
 *    events arrive, and none outside a frame.
 * A small fake page with a controllable animation frame queue: the parts of a mounted strip the
 * drag code touches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../src/i18n';

vi.mock('obsidian', () => ({ setIcon: () => undefined, Scope: class {} }));

const { VerticalStrip } = await import('../../../src/ui/vstrip');

type Listener = (evt: FakeDragEvent) => void;

interface FakeDragEvent {
	target: unknown;
	clientY?: number;
	relatedTarget?: unknown;
	defaultPrevented: boolean;
	dataTransfer: { types: string[]; dropEffect?: string; effectAllowed?: string; setData?: () => void };
	preventDefault(): void;
}

class Target {
	readonly listeners = new Map<string, Listener[]>();
	addEventListener(type: string, f: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
	}
	removeEventListener(type: string, f: Listener): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((x) => x !== f),
		);
	}
	fire(type: string, e: FakeDragEvent): void {
		for (const f of [...(this.listeners.get(type) ?? [])]) f(e);
	}
}

function event(target: unknown, extra: Partial<FakeDragEvent> = {}): FakeDragEvent {
	const e: FakeDragEvent = {
		target,
		defaultPrevented: false,
		dataTransfer: { types: ['text/plain'], setData: () => undefined },
		preventDefault() {
			e.defaultPrevented = true;
		},
		...extra,
	};
	return e;
}

interface StripInternals {
	m: unknown;
	items: Map<string, unknown>;
	order: unknown[];
	startDrag(m: unknown, evt: FakeDragEvent): void;
}

/** A fake element whose box can move (a scroll shifts the rows by `scroll`). */
function makeEl(doc: unknown, box: { top: number; bottom: number }, shift: () => number) {
	const classes = new Set<string>();
	const props: Record<string, string> = {};
	return Object.assign(new Target(), {
		ownerDocument: doc,
		isConnected: true,
		className: '',
		props,
		classList: {
			add: (c: string) => classes.add(c),
			remove: (c: string) => classes.delete(c),
			contains: (c: string) => classes.has(c),
		},
		getBoundingClientRect: () => ({ top: box.top - shift(), bottom: box.bottom - shift(), height: box.bottom - box.top }),
		setCssProps: (p: Record<string, string>) => Object.assign(props, p),
		setAttribute: () => undefined,
		appendChild: (c: unknown) => c,
		remove: () => undefined,
		getAttribute: () => null,
		contains: (_n: unknown): boolean => false,
	});
}

function setup() {
	vi.useFakeTimers();
	let scroll = 0;
	const frames: ((at: number) => void)[] = [];
	let clock = 0;
	const doc: { createElement: () => ReturnType<typeof makeEl> } = { createElement: () => makeEl(doc, { top: 0, bottom: 0 }, () => 0) };
	const win = Object.assign(new Target(), {
		setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
		clearTimeout: (h: ReturnType<typeof setTimeout>) => {
			clearTimeout(h);
		},
		requestAnimationFrame: (f: (at: number) => void) => frames.push(f),
		cancelAnimationFrame: () => undefined,
	});
	/** Runs one browser frame: every callback queued so far, with the same timestamp. */
	const frame = () => {
		clock += 16;
		const now = frames.splice(0);
		for (const f of now) f(clock);
		return now.length;
	};
	const fixed = () => 0;
	const shifted = () => scroll;
	const root = makeEl(doc, { top: 0, bottom: 600 }, fixed);
	const list = makeEl(doc, { top: 40, bottom: 600 }, fixed);
	const rows = Array.from({ length: 12 }, (_, i) => makeEl(doc, { top: 40 + i * 30, bottom: 70 + i * 30 }, shifted));
	list.contains = (n: unknown) => n === list || rows.includes(n as (typeof rows)[number]);
	const first = rows[0];
	if (first === undefined) throw new Error('rows');
	const rowEl = Object.assign(first, {
		closest: () => rowEl,
		getAttribute: (k: string) => (k === 'data-tabstrip-item' ? 't:r0' : null),
	});
	const strip = new VerticalStrip(translator('en'), {
		activate: () => undefined,
		toggleSidebar: () => undefined,
		dragStart: () => 'native',
		dragPredict: () => ({ groupId: null, changes: true }),
	} as unknown as ConstructorParameters<typeof VerticalStrip>[1]);
	const m = { host: makeEl(doc, { top: 0, bottom: 0 }, fixed), root, list, win, collapseButton: makeEl(doc, { top: 0, bottom: 0 }, fixed), handle: makeEl(doc, { top: 0, bottom: 0 }, fixed) };
	const s = strip as unknown as StripInternals;
	s.m = m;
	const its = rows.map((el, i) => ({ el, kind: 'tab', id: `t:r${String(i)}`, item: { kind: 'tab', row: { leafId: `r${String(i)}`, paneId: 'A', groupId: null, pinned: false } } }));
	for (const it of its) s.items.set(it.id, it);
	s.order = its;
	s.startDrag(m, event(rowEl));
	/** The line element the strip made (its --tabstrip-vdrop-y is the line's place in the strip). */
	const lineY = (): number | null => {
		const created = (root as unknown as { lastLine?: ReturnType<typeof makeEl> }).lastLine;
		const y = created?.props['--tabstrip-vdrop-y'];
		return y === undefined ? null : Number.parseFloat(y);
	};
	// Remember the line when the strip appends it to its root.
	root.appendChild = (c: unknown) => {
		(root as unknown as { lastLine?: unknown }).lastLine = c;
		return c;
	};
	const over = (y: number, target: unknown = rows[5]) => {
		win.fire('dragover', event(target, { clientY: y }));
	};
	const scrollBy = (dy: number) => {
		scroll += dy;
		list.fire('scroll', event(list));
	};
	return { strip, frame, over, scrollBy, lineY, frames };
}

describe('the drop line follows a scroll of the list under an unchanged spot (V6 carry-over 1)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('draws the line again at the row after the list scrolled, though the spot is the same', () => {
		const t = setup();
		// Row r5 spans 190-220; the pointer at 195 is its upper half: the line at its top (190, strip top 0).
		t.over(195);
		t.frame();
		expect(t.lineY()).toBe(190);
		const paints = t.strip.stats.dragPaints;
		// The list scrolls 6 px: r5 is now 184-214, the pointer (still at 195) is still in its upper half.
		t.scrollBy(6);
		t.frame();
		expect(t.lineY()).toBe(184);
		expect(t.strip.stats.dragPaints).toBe(paints + 1);
		expect(t.strip.stats.dragScrollRepaints).toBe(1);
		// No scroll, no new spot: no paint.
		t.over(196);
		t.frame();
		expect(t.strip.stats.dragPaints).toBe(paints + 1);
	});

	it('a scroll while the pointer is off the list paints nothing', () => {
		const t = setup();
		t.over(200);
		t.frame();
		const paints = t.strip.stats.dragPaints;
		t.over(10, {}); // off the list (an element elsewhere in the window)
		t.frame();
		const afterLeave = t.strip.stats.dragPaints;
		expect(afterLeave).toBe(paints + 1);
		t.scrollBy(6);
		expect(t.frames.length).toBe(0);
		t.frame();
		expect(t.strip.stats.dragPaints).toBe(afterLeave);
	});
});

describe('at most one paint per animation frame during a drag (V6 carry-over 2)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('many drag events and scrolls within frames: one frame callback and at most one paint per frame, none outside', () => {
		const t = setup();
		let frames = 0;
		for (let f = 0; f < 50; f++) {
			// Several drag events per frame, moving over different rows, plus a scroll now and then.
			for (let k = 0; k < 6; k++) t.over(60 + ((f * 37 + k * 53) % 330));
			if (f % 7 === 0) t.scrollBy(f % 2 === 0 ? 3 : -3);
			const before = t.strip.stats.dragPaints;
			const ran = t.frame();
			expect(ran).toBeLessThanOrEqual(1);
			frames += ran;
			expect(t.strip.stats.dragPaints - before).toBeLessThanOrEqual(1);
		}
		const st = t.strip.stats;
		expect(frames).toBeGreaterThan(30);
		expect(st.dragFrames).toBe(frames);
		expect(st.dragPaints).toBeGreaterThan(10);
		expect(st.dragPaints).toBeLessThanOrEqual(st.dragFrames);
		expect(st.dragPaintsOffFrame).toBe(0);
		expect(st.dragFramesSameFrame).toBe(0);
	});
});
