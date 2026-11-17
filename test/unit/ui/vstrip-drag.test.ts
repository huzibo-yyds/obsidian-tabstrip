/**
 * V5 review round 1: a row's dragstart that a later listener cancels starts no drag and sends no
 * dragend. The strip must not stay "dragging" (renders held, window listeners left on), and a later,
 * unrelated drag over the list must never be taken for the old tab. A tiny fake page: just the parts
 * of a mounted strip that the drag code touches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../src/i18n';
import type { DropTarget } from '../../../src/core/drag';

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
	count(): number {
		let n = 0;
		for (const v of this.listeners.values()) n += v.length;
		return n;
	}
}

function event(target: unknown, extra: Partial<FakeDragEvent> = {}): FakeDragEvent {
	const e: FakeDragEvent = {
		target,
		defaultPrevented: false,
		dataTransfer: { types: [], setData: () => undefined },
		preventDefault() {
			e.defaultPrevented = true;
		},
		...extra,
	};
	return e;
}

/** Internals of the strip this test drives (a mounted strip with two tab rows a and b). */
interface StripInternals {
	m: unknown;
	items: Map<string, unknown>;
	order: unknown[];
	startDrag(m: unknown, evt: FakeDragEvent): void;
}

function setup() {
	vi.useFakeTimers();
	const doc = {};
	const win = Object.assign(new Target(), {
		setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
		clearTimeout: (h: ReturnType<typeof setTimeout>) => {
			clearTimeout(h);
		},
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => undefined,
	});
	const el = (top: number, bottom: number) =>
		Object.assign(new Target(), {
			ownerDocument: doc,
			isConnected: true,
			classList: { add: () => undefined, remove: () => undefined, contains: () => false },
			getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
			remove: () => undefined,
			getAttribute: () => null,
			contains: (_n: unknown): boolean => false,
		});
	const list = el(0, 300);
	const root = el(0, 300);
	const rowA = el(0, 30);
	const rowB = el(30, 60);
	list.contains = (n: unknown) => n === rowA || n === rowB || n === list;
	const rowEl = Object.assign(rowA, {
		closest: () => rowEl,
		getAttribute: (k: string) => (k === 'data-tabstrip-item' ? 't:a' : null),
	});
	const dropped: DropTarget[] = [];
	const order: string[] = [];
	let ends = 0;
	const strip = new VerticalStrip(translator('en'), {
		activate: () => undefined,
		toggleSidebar: () => undefined,
		dragStart: () => 'native',
		dragDrop: (t: DropTarget) => {
			dropped.push(t);
			order.push('drop');
		},
		dragEnd: () => {
			ends++;
			order.push('end');
			// Like the controller's deferred switches: something the caller runs on the next task.
			setTimeout(() => order.push('after-end task'), 0);
		},
	} as unknown as ConstructorParameters<typeof VerticalStrip>[1]);
	const m = { host: el(0, 0), root, list, win, collapseButton: el(0, 0), handle: el(0, 0) };
	const s = strip as unknown as StripInternals;
	s.m = m;
	const itA = { el: rowA, kind: 'tab', id: 't:a', item: { kind: 'tab', row: { leafId: 'a', paneId: 'A', groupId: null } } };
	const itB = { el: rowB, kind: 'tab', id: 't:b', item: { kind: 'tab', row: { leafId: 'b', paneId: 'A', groupId: null } } };
	s.items.set('t:a', itA);
	s.items.set('t:b', itB);
	s.order = [itA, itB];
	const start = (target: unknown = rowA) => {
		const e = event(target);
		s.startDrag(m, e);
		return e;
	};
	/** A later drag (not a tab, no 'Files') over row b's lower half, then released there. */
	const laterDrag = () => {
		const over = event(rowB, { clientY: 50, dataTransfer: { types: ['text/plain'], dropEffect: 'none' } });
		win.fire('dragover', over);
		win.fire('drop', event(rowB, { clientY: 50, dataTransfer: { types: ['text/plain'] } }));
		vi.advanceTimersByTime(1100);
		return over;
	};
	return { strip, win, rowA, rowB, start, laterDrag, dropped, order, ends: () => ends };
}

describe('a vertical-strip row drag whose dragstart is cancelled (V5 review round 1)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('ends once the dragstart is done: renders go on, listeners go, a later drag moves nothing', () => {
		const t = setup();
		const e = t.start();
		// A later (bubble-phase) listener cancels the dragstart: Chromium starts no drag, no dragend comes.
		e.preventDefault();
		expect(t.strip.draggedLeaf).toBe('a');
		vi.advanceTimersByTime(0);
		expect(t.strip.draggedLeaf).toBeNull();
		expect(t.ends()).toBe(1);
		expect(t.win.count()).toBe(0);
		const held = t.strip.stats.heldRenders;
		t.strip.render({ sections: [], rows: [] }, () => null);
		expect(t.strip.stats.heldRenders).toBe(held);
		const over = t.laterDrag();
		expect(over.defaultPrevented).toBe(false);
		expect(t.dropped).toEqual([]);
	});

	it('a drag that really started stays open past the dragstart, until its dragend or a drop', () => {
		const t = setup();
		t.start();
		vi.advanceTimersByTime(10);
		expect(t.strip.draggedLeaf).toBe('a');
	});

	it('any later dragstart in the window ends a drag still open (its dragend never came)', () => {
		const t = setup();
		t.start();
		vi.advanceTimersByTime(10);
		// A note dragged from the file explorer later.
		t.win.fire('dragstart', event({}));
		expect(t.strip.draggedLeaf).toBeNull();
		expect(t.win.count()).toBe(0);
		const over = t.laterDrag();
		expect(over.defaultPrevented).toBe(false);
		expect(t.dropped).toEqual([]);
	});
});

/**
 * V5 review round 2: files dragged in (dataTransfer types include 'Files') are never a tab drag, also
 * while a row drag is open (its dragend may never have come, or the files come along with it). The
 * control case is the same drop without 'Files', which the strip does hand on.
 */
describe('files over the strip during a row drag (V5 review round 2)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const files = (target: unknown) => event(target, { clientY: 50, dataTransfer: { types: ['Files'], dropEffect: 'none' } });

	it('control: the same drop without files is a tab drop on the strip', () => {
		const t = setup();
		t.start();
		vi.advanceTimersByTime(10);
		const over = t.laterDrag();
		expect(over.defaultPrevented).toBe(true);
		expect(t.dropped).toEqual([{ leafId: 'a', paneId: 'A', spot: { kind: 'tab', leafId: 'b', side: 'after' } }]);
	});

	it('a dragover carrying files ends the open drag: nothing accepted, listeners gone, no drop later', () => {
		const t = setup();
		t.start();
		vi.advanceTimersByTime(10);
		const over = files(t.rowB);
		t.win.fire('dragover', over);
		expect(over.defaultPrevented).toBe(false);
		expect(over.dataTransfer.dropEffect).toBe('none');
		expect(t.strip.draggedLeaf).toBeNull();
		expect(t.ends()).toBe(1);
		expect(t.win.count()).toBe(0);
		t.win.fire('drop', files(t.rowB));
		vi.advanceTimersByTime(1100);
		expect(t.dropped).toEqual([]);
	});

	it('a drop carrying files on the list is not taken: not accepted, and the drag hands on no drop at its end', () => {
		const t = setup();
		t.start();
		vi.advanceTimersByTime(10);
		const drop = files(t.rowB);
		t.win.fire('drop', drop);
		expect(drop.defaultPrevented).toBe(false);
		vi.advanceTimersByTime(1100);
		t.rowA.fire('dragend', event(t.rowA));
		vi.advanceTimersByTime(10);
		expect(t.strip.draggedLeaf).toBeNull();
		expect(t.dropped).toEqual([]);
		expect(t.strip.stats.drops).toBe(0);
	});
});

describe('the order at the end of a drag with a drop (V6)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('the drop is handed on in a task queued before anything the dragEnd hook queues', () => {
		const t = setup();
		t.start();
		vi.advanceTimersByTime(10);
		t.laterDrag();
		expect(t.dropped).toHaveLength(1);
		expect(t.order).toEqual(['end', 'drop', 'after-end task']);
	});
});
