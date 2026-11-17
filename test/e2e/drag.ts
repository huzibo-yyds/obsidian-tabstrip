/**
 * Real tab drags in the sandbox (step L7).
 *
 * How a drag runs here:
 * 1. Chromium's drag interception is turned on for the window first (DevTools protocol
 *    `Input.setInterceptDrags`, sent through ChromeDriver's `goog/cdp/execute`). With it, a drag
 *    never becomes a system (macOS) drag: it stays inside the sandbox's browser.
 * 2. The drag starts with REAL pointer input (WebDriver press and move on the tab's title):
 *    Chromium fires a trusted dragstart on the tab header, and Obsidian's own tab drag starts.
 * 3. Moving and dropping are browser-level drag events (`Input.dispatchDragEvent` dragEnter /
 *    dragOver / drop / dragCancel at viewport coordinates). Chromium hit-tests them and sends
 *    trusted dragenter, dragover, dragleave, drop and dragend to the page, exactly the path a
 *    mouse drag takes after the system hands it back. Obsidian's drop code runs unchanged.
 *
 * Safety: every window gets a capture listener that cancels any dragstart until interception
 * was confirmed for that window (so a real press and move can never start a system drag there),
 * and `startDrag` refuses to run in a window that is not confirmed.
 */
import { browser } from '@wdio/globals';
import { headerSel } from './helpers';

export interface Point {
	x: number;
	y: number;
}

/** Sends a DevTools protocol command to the current window (ChromeDriver's `goog/cdp/execute`). */
export async function cdp(cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
	return browser.sendCommandAndGetResult(cmd, params);
}

const confirmed = new Set<string>();

/** Interception on for the current window, then its guard lets drags through. Idempotent. */
export async function enableDrags(): Promise<void> {
	const key = `${browser.sessionId}|${await browser.getWindowHandle()}`;
	// Guard first: until the flag is set, every dragstart in this window is cancelled.
	await browser.execute(() => {
		type W = Window & { e2eDragGuard?: { ok: boolean; starts: { trusted: boolean; leaf: string | null; cancelled: boolean }[] } };
		const w = window as W;
		if (w.e2eDragGuard) return;
		const guard = { ok: false, starts: [] as { trusted: boolean; leaf: string | null; cancelled: boolean }[] };
		w.e2eDragGuard = guard;
		window.addEventListener(
			'dragstart',
			(e) => {
				const el = e.target as HTMLElement | null;
				const header = el?.closest?.('.workspace-tab-header');
				// Step V5: a row of the vertical strip carries its leaf id itself.
				const row = el?.closest?.('.tabstrip-vrow');
				if (!guard.ok) e.preventDefault();
				guard.starts.push({ trusted: e.isTrusted, leaf: header?.getAttribute('data-e2e-leaf') ?? row?.getAttribute('data-tabstrip-leaf') ?? null, cancelled: !guard.ok });
			},
			true,
		);
	});
	if (confirmed.has(key)) return;
	await cdp('Input.setInterceptDrags', { enabled: true });
	confirmed.add(key);
	await browser.execute(() => {
		const g = (window as Window & { e2eDragGuard?: { ok: boolean } }).e2eDragGuard;
		if (g) g.ok = true;
	});
}

/** dragstarts seen by the guard of the current window (and clears the list). */
export async function dragStarts(): Promise<{ trusted: boolean; leaf: string | null; cancelled: boolean }[]> {
	return browser.execute(() => {
		const g = (window as Window & { e2eDragGuard?: { starts: { trusted: boolean; leaf: string | null; cancelled: boolean }[] } }).e2eDragGuard;
		const out = [...(g?.starts ?? [])];
		if (g) g.starts.length = 0;
		return out;
	});
}

/**
 * Starts dragging this tab with real pointer input (press on its title, move 24 px). The current
 * window must have interception confirmed (enableDrags).
 */
export async function startDrag(leafId: string): Promise<void> {
	await startDragOn(headerSel(leafId), leafId, '.workspace-tab-header', '.workspace-tab-header-inner-close-button');
}

/** Step V5: starts dragging this tab's row in the vertical strip (real press and move, like startDrag). */
export async function startRowDrag(leafId: string): Promise<void> {
	await startDragOn(`.tabstrip-vrow[data-tabstrip-leaf="${leafId}"]`, leafId, '.tabstrip-vrow', '.tabstrip-vrow-close');
}

/**
 * Starts dragging the element `selector` (a tab header or a row of the vertical strip, of tab
 * `leafId`) with real pointer input: press on it, away from its close button (`avoid`), and move
 * 24 px. `own` is what the element under the press must belong to.
 */
async function startDragOn(selector: string, leafId: string, own: string, avoid: string): Promise<void> {
	const key = `${browser.sessionId}|${await browser.getWindowHandle()}`;
	if (!confirmed.has(key)) throw new Error('startDrag: drag interception is not confirmed for this window');
	// Wait until the tab's header stays put (closing animations, tabs resizing) and pick a point on
	// it, away from the close button, where the header is the topmost element: the press lands on
	// this tab.
	let point: Point | null = null;
	let why = '';
	await browser.waitUntil(
		async () => {
			const r = await browser.execute(async (sel, ownSel, avoidSel) => {
				const header = document.querySelector(sel);
				if (!header) return { why: 'no header' };
				// A strip with many tabs scrolls: bring the tab into view (test input only).
				header.scrollIntoView({ block: 'nearest', inline: 'nearest' });
				const a = header.getBoundingClientRect();
				await new Promise((res) => setTimeout(res, 80));
				const b = header.getBoundingClientRect();
				if (a.left !== b.left || a.width !== b.width) return { why: `moving ${String(a.left)}→${String(b.left)}` };
				if (b.width < 8) return { why: `width ${String(b.width)}` };
				let last = '';
				for (const f of [0.3, 0.15, 0.5, 0.08, 0.65]) {
					const p = { x: Math.round(b.left + Math.min(16, b.width * f)), y: Math.round(b.top + b.height / 2) };
					const top = document.elementFromPoint(p.x, p.y);
					if (top === null) last = `nothing at ${JSON.stringify(p)}`;
					else if (top.closest(ownSel) !== header) last = `covered by ${top.className.toString()} at ${JSON.stringify(p)}`;
					else if (top.closest(avoidSel) !== null) last = `close button at ${JSON.stringify(p)}, width ${String(b.width)}`;
					else return { point: p };
				}
				return { why: last };
			}, selector, own, avoid);
			if ('point' in r && r.point) point = r.point;
			else why = 'why' in r ? (r.why ?? '') : '';
			return point !== null;
		},
		{ timeout: 3000, interval: 50, timeoutMsg: `startDrag ${leafId}: its header did not settle` },
	).catch((e: unknown) => {
		throw new Error(`${String(e)} (${why})`);
	});
	const at = point as Point | null;
	if (at === null) throw new Error('no point');
	await dragStarts();
	await browser
		.action('pointer')
		.move({ x: at.x, y: at.y, duration: 0 })
		.down({ button: 0 })
		.move({ x: at.x + 12, y: at.y, duration: 40 })
		.move({ x: at.x + 24, y: at.y, duration: 40 })
		.up({ button: 0 })
		.perform();
	const starts = await dragStarts();
	if (starts.length !== 1 || starts[0]?.trusted !== true || starts[0].cancelled || starts[0].leaf !== leafId) {
		// End whatever drag did start, so it does not hang over the next case.
		if (starts.some((x) => !x.cancelled)) await cancelDrag();
		throw new Error(`startDrag ${leafId}: expected one trusted dragstart on it, got ${JSON.stringify(starts)}`);
	}
}

const DATA = { items: [{ mimeType: 'text/plain', data: '' }], dragOperationsMask: 17 };

/** Moves the drag to this point of the current window (dragEnter the first time, then dragOver). */
export async function dragOver(p: Point, enter = false): Promise<void> {
	if (enter) await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: p.x, y: p.y, data: DATA });
	await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y, data: DATA });
}

/** Releases the drag at this point of the current window. */
export async function dropAt(p: Point): Promise<void> {
	await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y, data: DATA });
	await cdp('Input.dispatchDragEvent', { type: 'drop', x: p.x, y: p.y, data: DATA });
}

/** Cancels the drag in the current window (what Escape does to a system drag). */
export async function cancelDrag(): Promise<void> {
	await cdp('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data: DATA });
}

export type SpotSpec = { tab: string; side: 'before' | 'after' } | { chip: string } | { endOf: string };

/** Viewport point (in the window that holds it) for a spot: a tab's half, a chip, the empty end of a strip. */
export async function pointFor(spec: SpotSpec): Promise<Point> {
	return browser.executeObsidian(({ app }, s) => {
		type Leaf = { id: string; tabHeaderEl: HTMLElement; parent: { tabHeaderContainerEl: HTMLElement; children: Leaf[] } };
		const all: Leaf[] = [];
		app.workspace.iterateAllLeaves((l) => {
			all.push(l as unknown as Leaf);
		});
		const center = (r: DOMRect, fx: number): { x: number; y: number } => ({ x: r.left + r.width * fx, y: r.top + r.height / 2 });
		if ('tab' in s) {
			const leaf = all.find((l) => l.id === s.tab);
			if (!leaf) throw new Error(`no leaf ${s.tab}`);
			return center(leaf.tabHeaderEl.getBoundingClientRect(), s.side === 'before' ? 0.25 : 0.75);
		}
		if ('chip' in s) {
			for (const leaf of all) {
				const chip = leaf.tabHeaderEl.querySelector(`.tabstrip-chip[data-tabstrip-group="${s.chip}"]`);
				if (chip) return center(chip.getBoundingClientRect(), 0.5);
			}
			throw new Error(`no chip ${s.chip}`);
		}
		const leaf = all.find((l) => l.id === s.endOf);
		if (!leaf) throw new Error(`no leaf ${s.endOf}`);
		const row = leaf.parent.tabHeaderContainerEl.getBoundingClientRect();
		const lastHeader = leaf.parent.children[leaf.parent.children.length - 1]?.tabHeaderEl.getBoundingClientRect();
		const header = leaf.tabHeaderEl.getBoundingClientRect();
		const x = Math.min((lastHeader?.right ?? row.left) + 30, row.right - 60);
		return { x, y: header.top + header.height / 2 };
	}, spec);
}

/** Highlight state in the current window: member headers marked as drop target, and chips. */
export async function highlight(): Promise<{ headers: string[]; chips: string[]; group: string | null }> {
	return browser.execute(() => {
		const headers = Array.from(document.querySelectorAll('.workspace-tab-header.tabstrip-drop-join')).map((h) => h.getAttribute('data-e2e-leaf') ?? '?');
		const chips = Array.from(document.querySelectorAll('.tabstrip-chip.is-drop-target')).map((c) => c.getAttribute('data-tabstrip-group') ?? '?');
		const first = document.querySelector('.workspace-tab-header.tabstrip-drop-join');
		return { headers, chips, group: first?.getAttribute('data-tabstrip-group') ?? null };
	});
}

/** Obsidian's own drop indicator (`.workspace-drop-overlay`) in the current window, or null when hidden. */
export async function indicator(): Promise<{ left: number; right: number; center: number; top: number; bottom: number; transition: string } | null> {
	return browser.execute(() => {
		const el = document.querySelector<HTMLElement>('.workspace-drop-overlay');
		if (!el || !el.isConnected) return null;
		const cs = getComputedStyle(el);
		if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
		const r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return null;
		return { left: r.left, right: r.right, center: (r.left + r.right) / 2, top: r.top, bottom: r.bottom, transition: cs.transition };
	});
}

/** A full drag of `leafId` dropped at `spec` (both in the current window). */
export async function dragTo(leafId: string, spec: SpotSpec, beforeDrop?: () => Promise<void>): Promise<void> {
	await startDrag(leafId);
	const p = await pointFor(spec);
	await dragOver(p, true);
	await browser.pause(60);
	await dragOver(p);
	await browser.pause(60);
	if (beforeDrop) await beforeDrop();
	await dropAt(p);
}
