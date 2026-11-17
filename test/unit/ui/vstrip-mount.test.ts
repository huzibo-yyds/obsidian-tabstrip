/**
 * Step V1: the strip mounts only once the plugin's stylesheet is applied (enabling the plugin while
 * Obsidian runs applies styles.css a little after onload). A minimal fake page: elements with
 * classes and children, a window with requestAnimationFrame and getComputedStyle.
 */
import { describe, expect, it, vi } from 'vitest';
import { translator } from '../../../src/i18n';

vi.mock('obsidian', () => ({ setIcon: () => undefined }));

const { VerticalStrip, VCLS, STYLES_MARKER, stylesApplied, movesHeader } = await import('../../../src/ui/vstrip');

class El {
	className = '';
	readonly children: El[] = [];
	parentElement: El | null = null;
	private readonly attrs = new Map<string, string>();
	readonly classList = {
		add: (c: string) => {
			if (!this.classes().includes(c)) this.className = [...this.classes(), c].join(' ');
		},
		remove: (c: string) => {
			this.className = this.classes().filter((x) => x !== c).join(' ');
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
	addEventListener(): void {}
}

class Win {
	frames: (() => void)[] = [];
	marker = '';
	cancelled = 0;
	/** Callbacks of the observers created in this window (review round 2: fire them by hand). */
	static readonly observers: ((records: { type: string }[]) => void)[] = [];
	readonly MutationObserver = class {
		constructor(cb: (records: { type: string }[]) => void) {
			Win.observers.push(cb);
		}
		observe(): void {}
		disconnect(): void {}
	};
	requestAnimationFrame(cb: () => void): number {
		this.frames.push(cb);
		return this.frames.length;
	}
	cancelAnimationFrame(): void {
		this.cancelled++;
		this.frames = [];
	}
	getComputedStyle(): { getPropertyValue(name: string): string } {
		return { getPropertyValue: (name: string) => (name === STYLES_MARKER ? this.marker : '') };
	}
	/** Runs the callbacks of one frame. */
	tick(): void {
		const run = this.frames;
		this.frames = [];
		for (const cb of run) cb();
	}
}

class Doc {
	readonly body: El;
	constructor(readonly defaultView: Win) {
		this.body = new El(this);
	}
	createElement(): El {
		return new El(this);
	}
	/** The strip listens for input at the document (review round 1); nothing is dispatched here. */
	addEventListener(): void {}
	removeEventListener(): void {}
}

function page(marker: string) {
	const win = new Win();
	win.marker = marker;
	const doc = new Doc(win);
	const host = doc.body.appendChild(new El(doc));
	return { win, doc, host };
}

function strip(mounted = vi.fn()) {
	return { s: new VerticalStrip(translator('en'), { activate: () => undefined, toggleSidebar: () => undefined, mounted }), mounted };
}

const asHost = (el: El) => el as unknown as HTMLElement;
const asDoc = (d: Doc) => d as unknown as Document;

describe('stylesApplied', () => {
	it('reads the marker custom property on <body>', () => {
		expect(stylesApplied(asDoc(page(' 1').doc))).toBe(true);
		expect(stylesApplied(asDoc(page('').doc))).toBe(false);
	});
	it('counts as applied without getComputedStyle', () => {
		expect(stylesApplied({ defaultView: null } as unknown as Document)).toBe(true);
	});
});

describe('VerticalStrip.mount waits for the stylesheet', () => {
	it('mounts at once when the stylesheet is applied, without the mounted hook', () => {
		const { host } = page('1');
		const { s, mounted } = strip();
		s.mount(asHost(host));
		expect(s.mounted).toBe(true);
		expect(s.waiting).toBe(false);
		expect(host.children[0]?.className).toBe(VCLS.strip);
		expect(host.classList.contains(VCLS.host)).toBe(true);
		expect(mounted).not.toHaveBeenCalled();
	});

	it('adds nothing to the page until the stylesheet is applied, then mounts in that frame and calls the hook', () => {
		const { win, host } = page('');
		const { s, mounted } = strip();
		s.mount(asHost(host));
		s.mount(asHost(host)); // idempotent while waiting
		expect(win.frames).toHaveLength(1);
		expect(s.mounted).toBe(false);
		expect(s.waiting).toBe(true);
		win.tick();
		win.tick();
		expect(host.children).toHaveLength(0);
		expect(host.classList.contains(VCLS.host)).toBe(false);
		win.marker = '1';
		win.tick();
		expect(s.mounted).toBe(true);
		expect(s.waiting).toBe(false);
		expect(host.children[0]?.className).toBe(VCLS.strip);
		expect(host.classList.contains(VCLS.host)).toBe(true);
		expect(mounted).toHaveBeenCalledTimes(1);
		expect(win.frames).toHaveLength(0);
		expect(s.stats.styleWaits).toEqual([3]);
	});

	it('unmount while waiting cancels the wait: nothing is mounted later', () => {
		const { win, host } = page('');
		const { s, mounted } = strip();
		s.mount(asHost(host));
		s.unmount();
		expect(win.cancelled).toBe(1);
		expect(s.waiting).toBe(false);
		win.marker = '1';
		win.tick();
		expect(s.mounted).toBe(false);
		expect(host.children).toHaveLength(0);
		expect(mounted).not.toHaveBeenCalled();
	});

	it('gives up after a bounded wait and leaves the native tab bar', () => {
		const { win, host } = page('');
		const { s, mounted } = strip();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		s.mount(asHost(host));
		let frames = 0;
		while (win.frames.length > 0 && frames < 10000) {
			win.tick();
			frames++;
		}
		expect(frames).toBe(600);
		expect(s.waiting).toBe(false);
		expect(s.mounted).toBe(false);
		expect(host.children).toHaveLength(0);
		expect(mounted).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe('VerticalStrip host observer (review round 2)', () => {
	it('asks for the rows when the host children change, in the observer callback; not for a class change only', () => {
		Win.observers.length = 0;
		const { host } = page('1');
		const hostChanged = vi.fn();
		const s = new VerticalStrip(translator('en'), { activate: () => undefined, toggleSidebar: () => undefined, hostChanged });
		s.mount(asHost(host));
		const hostObserver = Win.observers[0];
		if (!hostObserver) throw new Error('no host observer');
		// A layout load takes the strip out (setChildrenInPlace): put back, then the rows are asked for.
		host.children[0]?.remove();
		hostObserver([{ type: 'childList' }]);
		expect(host.children[0]?.className).toBe(VCLS.strip);
		expect(hostChanged).toHaveBeenCalledTimes(1);
		host.classList.remove(VCLS.host);
		hostObserver([{ type: 'attributes' }]);
		expect(host.classList.contains(VCLS.host)).toBe(true);
		expect(hostChanged).toHaveBeenCalledTimes(1);
		s.unmount();
		hostObserver([{ type: 'childList' }]);
		expect(hostChanged).toHaveBeenCalledTimes(1);
	});
});

describe('tab headers coming and going (review round 2)', () => {
	const node = (cls: string) => ({ classList: { contains: (c: string) => c === cls } }) as unknown as Node;
	const rec = (added: Node[], removed: Node[] = []) => ({ addedNodes: added as unknown as NodeList, removedNodes: removed as unknown as NodeList });
	it('movesHeader: a native tab header, pane or split added or removed, not a text node, a title change or a chip', () => {
		expect(movesHeader(rec([node('workspace-tab-header')]))).toBe(true);
		expect(movesHeader(rec([], [node('workspace-tab-header')]))).toBe(true);
		expect(movesHeader(rec([], [node('workspace-tabs')]))).toBe(true);
		expect(movesHeader(rec([node('workspace-split')]))).toBe(true);
		expect(movesHeader(rec([node('workspace-leaf')]))).toBe(false);
		expect(movesHeader(rec([{} as Node]))).toBe(false);
		expect(movesHeader(rec([node('tabstrip-chip')], [node('workspace-tab-header-inner-title')]))).toBe(false);
	});
	it('the pane observer calls tabsChanged only for header moves, and not after unmount', () => {
		Win.observers.length = 0;
		const { host } = page('1');
		const tabsChanged = vi.fn();
		const s = new VerticalStrip(translator('en'), { activate: () => undefined, toggleSidebar: () => undefined, tabsChanged });
		s.mount(asHost(host));
		const pane = Win.observers[2];
		if (!pane) throw new Error('no pane observer');
		pane([rec([node('tabstrip-chip')]) as unknown as { type: string }]);
		expect(tabsChanged).not.toHaveBeenCalled();
		pane([rec([node('workspace-tab-header')]) as unknown as { type: string }]);
		expect(tabsChanged).toHaveBeenCalledTimes(1);
		s.unmount();
		pane([rec([node('workspace-tab-header')]) as unknown as { type: string }]);
		expect(tabsChanged).toHaveBeenCalledTimes(1);
	});
});

describe('VerticalStrip.setAnyDrag (V6 review round 2)', () => {
	it('puts the any-drag class on the host while mounted, keeps the state for a mount during the drag, and leaves nothing after unmount', () => {
		const { host } = page('1');
		const { s } = strip();
		s.setAnyDrag(true);
		expect(host.classList.contains(VCLS.hostAnyDrag)).toBe(false);
		s.mount(asHost(host));
		expect(host.classList.contains(VCLS.hostAnyDrag)).toBe(true);
		s.setAnyDrag(false);
		expect(host.classList.contains(VCLS.hostAnyDrag)).toBe(false);
		s.setAnyDrag(true);
		expect(host.classList.contains(VCLS.hostAnyDrag)).toBe(true);
		s.unmount();
		expect(host.classList.contains(VCLS.hostAnyDrag)).toBe(false);
		expect(host.classList.contains(VCLS.host)).toBe(false);
		s.setAnyDrag(false);
		s.mount(asHost(host));
		expect(host.classList.contains(VCLS.hostAnyDrag)).toBe(false);
	});
});
