/**
 * Review round 1 (V2-V4): when the icon bar's hover overlay closes again. A small fake page with
 * listeners, focus moves (focusin / focusout with relatedTarget) and fake timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../../../src/i18n';

vi.mock('obsidian', () => ({ setIcon: () => undefined, Scope: class {} }));

const { VerticalStrip, PEEK_OPEN_MS, PEEK_CLOSE_MS } =
	await import('../../../src/ui/vstrip');

type Listener = (evt: Record<string, unknown>) => void;

class El {
	className = '';
	readonly children: El[] = [];
	parentElement: El | null = null;
	private readonly attrs = new Map<string, string>();
	private readonly listeners = new Map<string, Listener[]>();
	readonly classList = {
		add: (c: string) => {
			if (!this.classes().includes(c))
				this.className = [...this.classes(), c].join(' ');
		},
		remove: (c: string) => {
			this.className = this.classes()
				.filter((x) => x !== c)
				.join(' ');
		},
		contains: (c: string) => this.classes().includes(c),
	};
	constructor(readonly ownerDocument: Doc) {}
	private classes(): string[] {
		return this.className.split(' ').filter(Boolean);
	}
	setAttribute(k: string, v: string): void {
		this.attrs.set(k, v);
	}
	getAttribute(k: string): string | null {
		return this.attrs.get(k) ?? null;
	}
	removeAttribute(k: string): void {
		this.attrs.delete(k);
	}
	appendChild<T extends El>(c: T): T {
		c.parentElement = this;
		this.children.push(c);
		return c;
	}
	prepend(c: El): void {
		c.parentElement = this;
		this.children.unshift(c);
	}
	remove(): void {
		const p = this.parentElement;
		if (p) p.children.splice(p.children.indexOf(this), 1);
		this.parentElement = null;
	}
	contains(n: El | null): boolean {
		for (let x = n; x !== null; x = x.parentElement)
			if (x === this) return true;
		return false;
	}
	addEventListener(type: string, f: Listener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]);
	}
	/** Calls this element's listeners for `type` only (pointerenter / pointerleave do not bubble). */
	fire(type: string, extra: Record<string, unknown> = {}): void {
		for (const f of this.listeners.get(type) ?? [])
			f({ target: this, relatedTarget: null, ...extra });
	}
	/** Calls the listeners of this element and its ancestors (bubbling events). */
	bubble(type: string, extra: Record<string, unknown> = {}): void {
		for (const f of this.listeners.get(type) ?? [])
			f({ target: this, relatedTarget: null, ...extra });
		for (let x = this.parentElement; x !== null; x = x.parentElement)
			for (const f of x.listeners.get(type) ?? [])
				f({ target: this, relatedTarget: null, ...extra });
		for (const f of this.ownerDocument.listeners.get(type) ?? [])
			f({ target: this, relatedTarget: null, ...extra });
	}
	focus(): void {
		const doc = this.ownerDocument;
		const prev = doc.activeElement;
		doc.activeElement = this;
		prev?.bubble('focusout', { relatedTarget: this });
		this.bubble('focusin', { relatedTarget: prev });
	}
}

class Doc {
	activeElement: El | null = null;
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
	readonly body: El;
	defaultView: unknown = null;
	constructor() {
		this.body = new El(this);
	}
	createElement(): El {
		return new El(this);
	}
}

function setup() {
	vi.useFakeTimers();
	const doc = new Doc();
	doc.defaultView = {
		setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
		clearTimeout: (h: number) => {
			clearTimeout(h);
		},
		MutationObserver: class {
			observe(): void {}
			disconnect(): void {}
			takeRecords(): unknown[] {
				return [];
			}
		},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => undefined,
	};
	const host = doc.body.appendChild(new El(doc));
	const editor = doc.body.appendChild(new El(doc));
	const strip = new VerticalStrip(translator('en'), {
		activate: () => undefined,
		toggleSidebar: () => undefined,
	});
	strip.setLook({
		collapsed: true,
		width: 240,
		minWidth: 180,
		maxWidth: 480,
	});
	strip.mount(host as unknown as HTMLElement);
	const root = strip.element as unknown as El;
	// The bar's first header button (left sidebar toggle; tabindex 0, so a mouse press focuses it).
	const button = root.children[0]?.children[0]?.children[0];
	if (button === undefined) throw new Error('no header button');
	const open = () => {
		root.fire('pointerenter');
		vi.advanceTimersByTime(PEEK_OPEN_MS + 10);
		expect(strip.peeked).toBe(true);
	};
	return { strip, root, button, editor, open };
}

describe('icon bar overlay (review round 1)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('closes after the pointer leaves even when a mouse press left the focus on a strip element', () => {
		const { strip, root, button, open } = setup();
		open();
		button.bubble('pointerdown');
		button.focus();
		button.bubble('click');
		root.fire('pointerleave');
		vi.advanceTimersByTime(PEEK_CLOSE_MS * 10);
		expect(strip.peeked).toBe(false);
	});

	it('stays open while keyboard focus is in the strip, and closes once the focus leaves', () => {
		const { strip, root, button, editor } = setup();
		// Tab from outside: no pointer press, the focus alone opens the overlay.
		button.focus();
		vi.advanceTimersByTime(PEEK_OPEN_MS + 10);
		expect(strip.peeked).toBe(true);
		root.fire('pointerenter');
		root.fire('pointerleave');
		vi.advanceTimersByTime(PEEK_CLOSE_MS * 10);
		expect(strip.peeked).toBe(true);
		editor.focus();
		vi.advanceTimersByTime(PEEK_CLOSE_MS + 10);
		expect(strip.peeked).toBe(false);
	});

	it('a key press after a mouse press makes the focus count as the keyboard focus', () => {
		const { strip, root, button, open } = setup();
		open();
		button.bubble('pointerdown');
		button.focus();
		button.bubble('keydown', { key: 'ArrowDown' });
		root.fire('pointerleave');
		vi.advanceTimersByTime(PEEK_CLOSE_MS * 10);
		expect(strip.peeked).toBe(true);
	});

	it('keys typed outside the strip (the rename bubble) do not turn a mouse focus into a keyboard focus; Tab does', () => {
		const { strip, root, button, editor, open } = setup();
		open();
		button.bubble('pointerdown');
		button.focus();
		// Into the bubble and back to the button, typing in between.
		editor.focus();
		editor.bubble('keydown', { key: 'Enter' });
		button.focus();
		root.fire('pointerleave');
		vi.advanceTimersByTime(PEEK_CLOSE_MS * 10);
		expect(strip.peeked).toBe(false);
		// Tab (anywhere) moves the focus by keyboard: now it keeps the overlay open.
		editor.focus();
		editor.bubble('keydown', { key: 'Tab' });
		button.focus();
		vi.advanceTimersByTime(PEEK_OPEN_MS + 10);
		vi.advanceTimersByTime(PEEK_CLOSE_MS * 10);
		expect(strip.peeked).toBe(true);
	});

	it('a hold (menu or bubble opened from a row) opens the bar at once and keeps it open until released', () => {
		const { strip, root, editor } = setup();
		expect(strip.peeked).toBe(false);
		const release = strip.holdPeek();
		expect(strip.peeked).toBe(true);
		// The pointer goes to the menu, the focus into the bubble: both outside the strip.
		root.fire('pointerenter');
		root.fire('pointerleave');
		editor.focus();
		vi.advanceTimersByTime(PEEK_CLOSE_MS * 10);
		expect(strip.peeked).toBe(true);
		release();
		release();
		vi.advanceTimersByTime(PEEK_CLOSE_MS + 10);
		expect(strip.peeked).toBe(false);
	});

	it('two holds: the overlay closes only after both are released', () => {
		const { strip } = setup();
		const menu = strip.holdPeek();
		const bubble = strip.holdPeek();
		menu();
		vi.advanceTimersByTime(PEEK_CLOSE_MS * 10);
		expect(strip.peeked).toBe(true);
		bubble();
		vi.advanceTimersByTime(PEEK_CLOSE_MS + 10);
		expect(strip.peeked).toBe(false);
	});
});
