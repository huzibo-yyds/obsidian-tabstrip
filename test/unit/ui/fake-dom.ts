/**
 * A tiny stand-in for the browser DOM, enough for the editor bubble and the ink cache: a
 * tree of elements with classes, attributes, listeners, focus and fixed boxes, plus the two
 * Obsidian additions they use (setCssProps, toggleClass). No page needed.
 */

export interface FakeRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export function rect(left: number, top: number, width: number, height: number): FakeRect {
	return { left, top, right: left + width, bottom: top + height, width, height };
}

export const ZERO: FakeRect = rect(0, 0, 0, 0);

type Listener = (evt: FakeEvent) => void;

export interface FakeEvent {
	type: string;
	target: FakeElement | null;
	key?: string;
	shiftKey?: boolean;
	isComposing?: boolean;
	defaultPrevented: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

export function fakeEvent(type: string, target: FakeElement | null, extra: Partial<FakeEvent> = {}): FakeEvent {
	const evt: FakeEvent = {
		type,
		target,
		defaultPrevented: false,
		preventDefault() {
			evt.defaultPrevented = true;
		},
		stopPropagation() {
			// Nothing bubbles in this fake.
		},
		...extra,
	};
	return evt;
}

export class FakeElement {
	readonly nodeType = 1;
	parent: FakeElement | null = null;
	readonly children: FakeElement[] = [];
	readonly attrs = new Map<string, string>();
	readonly props: Record<string, string> = {};
	readonly listeners = new Map<string, Listener[]>();
	className = '';
	value = '';
	type = '';
	placeholder = '';
	spellcheck = true;
	box: FakeRect = ZERO;
	/** Computed style values for getComputedStyle. */
	computed: Record<string, string> = {};
	/** Computed style values of pseudo-elements ('::after' …) for getComputedStyle(el, pseudo). */
	pseudo: Record<string, Record<string, string>> = {};

	constructor(
		readonly ownerDocument: FakeDocument,
		readonly tagName: string,
	) {}

	get isConnected(): boolean {
		return this.ownerDocument.documentElement.contains(this);
	}

	get parentElement(): FakeElement | null {
		return this.parent;
	}

	get classList(): { contains(c: string): boolean } {
		return { contains: (c: string) => this.className.split(/\s+/).includes(c) };
	}

	setAttribute(name: string, value: string): void {
		this.attrs.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attrs.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attrs.has(name);
	}

	removeAttribute(name: string): void {
		this.attrs.delete(name);
	}

	appendChild(child: FakeElement): FakeElement {
		child.remove();
		child.parent = this;
		this.children.push(child);
		return child;
	}

	append(...children: FakeElement[]): void {
		for (const c of children) this.appendChild(c);
	}

	remove(): void {
		const parent = this.parent;
		if (parent === null) return;
		const doc = this.ownerDocument;
		const hadFocus = doc.activeElement !== null && this.contains(doc.activeElement);
		parent.children.splice(parent.children.indexOf(this), 1);
		this.parent = null;
		// HTML "focus fixup": a removed focused element leaves the focus on the body.
		if (hadFocus) doc.activeElement = doc.body;
	}

	contains(other: unknown): boolean {
		let el = other as FakeElement | null;
		while (el !== null && el !== undefined) {
			if (el === this) return true;
			el = el.parent;
		}
		return false;
	}

	matches(selector: string): boolean {
		const cls = selector.startsWith('.') ? selector.slice(1) : null;
		return cls !== null && this.classList.contains(cls);
	}

	closest(selector: string): FakeElement | null {
		if (this.matches(selector)) return this;
		return this.parent === null ? null : this.parent.closest(selector);
	}

	/** `:scope > .cls` (a child), `:scope > .cls:not(.other)`, or `.cls` (any descendant). */
	querySelector(selector: string): FakeElement | null {
		const child = /^:scope > (\.[\w-]+)(?::not\((\.[\w-]+)\))?$/.exec(selector);
		if (child) return this.children.find((c) => c.matches(child[1] ?? '') && (child[2] === undefined || !c.matches(child[2]))) ?? null;
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector: string): FakeElement[] {
		const out: FakeElement[] = [];
		const walk = (el: FakeElement) => {
			for (const c of el.children) {
				if (c.matches(selector) || (selector === 'link[rel="stylesheet"]' && c.tagName === 'link')) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}

	getBoundingClientRect(): FakeRect {
		if (this.box === ZERO) return this.ownerDocument.defaultBoxes[this.className] ?? ZERO;
		return this.box;
	}

	addEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		const i = list.indexOf(listener);
		if (i >= 0) list.splice(i, 1);
	}

	/** Calls this element's listeners and those of its ancestors (bubbling, no capture). */
	dispatch(evt: FakeEvent): void {
		for (const l of [...(this.listeners.get(evt.type) ?? [])]) l(evt);
		this.parent?.dispatch(evt);
	}

	focus(): void {
		this.ownerDocument.activeElement = this;
	}

	select(): void {
		// Nothing to select in the fake.
	}

	setCssProps(props: Record<string, string>): void {
		Object.assign(this.props, props);
	}

	hasClass(cls: string): boolean {
		return this.classList.contains(cls);
	}

	addClass(cls: string): void {
		this.toggleClass(cls, true);
	}

	removeClass(cls: string): void {
		this.toggleClass(cls, false);
	}

	toggleClass(cls: string, on: boolean): void {
		const set = new Set(this.className.split(/\s+/).filter((c) => c.length > 0));
		if (on) set.add(cls);
		else set.delete(cls);
		this.className = [...set].join(' ');
	}
}

export class FakeWindow {
	innerWidth = 1024;
	innerHeight = 800;
	readonly timers: (() => void)[] = [];
	readonly frames = new Map<number, () => void>();
	readonly listeners = new Map<string, Listener[]>();
	private nextFrame = 1;

	addEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		const i = list.indexOf(listener);
		if (i >= 0) list.splice(i, 1);
	}

	dispatch(evt: FakeEvent): void {
		for (const l of [...(this.listeners.get(evt.type) ?? [])]) l(evt);
	}

	requestAnimationFrame(fn: () => void): number {
		const id = this.nextFrame++;
		this.frames.set(id, fn);
		return id;
	}

	cancelAnimationFrame(id: number): void {
		this.frames.delete(id);
	}

	/** Runs the queued animation frames. */
	runFrames(): void {
		const due = [...this.frames.values()];
		this.frames.clear();
		for (const fn of due) fn();
	}

	getComputedStyle(el: FakeElement, pseudo?: string): { getPropertyValue(name: string): string; [key: string]: unknown } {
		const values = pseudo === undefined ? el.computed : (el.pseudo[pseudo] ?? {});
		return {
			...values,
			getPropertyValue: (name: string) => values[name] ?? '',
		};
	}

	setTimeout(fn: () => void): number {
		this.timers.push(fn);
		return this.timers.length;
	}

	/** Runs the queued timers. */
	runTimers(): void {
		while (this.timers.length > 0) this.timers.shift()?.();
	}
}

export class FakeDocument {
	readonly nodeType = 9;
	readonly defaultView: FakeWindow | null;
	readonly documentElement: FakeElement;
	readonly head: FakeElement;
	readonly body: FakeElement;
	activeElement: FakeElement | null = null;
	readonly listeners = new Map<string, Listener[]>();
	/** Box of elements that were not given one, by class name (for elements the code under test creates). */
	readonly defaultBoxes: Record<string, FakeRect> = {};

	constructor(win: FakeWindow | null = new FakeWindow()) {
		this.defaultView = win;
		this.documentElement = new FakeElement(this, 'html');
		this.head = this.documentElement.appendChild(new FakeElement(this, 'head'));
		this.body = this.documentElement.appendChild(new FakeElement(this, 'body'));
		this.activeElement = this.body;
	}

	createElement(tag: string): FakeElement {
		return new FakeElement(this, tag);
	}

	querySelectorAll(selector: string): FakeElement[] {
		return this.documentElement.querySelectorAll(selector);
	}

	addEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		const i = list.indexOf(listener);
		if (i >= 0) list.splice(i, 1);
	}

	/** Document-level (capture) listeners first, then the target's own chain. */
	dispatch(evt: FakeEvent): void {
		for (const l of [...(this.listeners.get(evt.type) ?? [])]) l(evt);
		evt.target?.dispatch(evt);
	}

	/** A child element with these classes and box, appended to `parent`. */
	el(parent: FakeElement, className: string, box: FakeRect = ZERO, tag = 'div'): FakeElement {
		const el = this.createElement(tag);
		el.className = className;
		el.box = box;
		parent.appendChild(el);
		return el;
	}
}
