/**
 * Step V5: dragging tabs in and out of the vertical strip.
 *
 * Every drag starts with REAL pointer input on a row of the vertical strip (a trusted dragstart),
 * with Chromium's drag interception on, so it never becomes a system drag; moves and drops are
 * browser-level drag events (DevTools `Input.dispatchDragEvent`), hit-tested by Chromium and
 * delivered as trusted dragenter / dragover / drop / dragend (test/e2e/drag.ts). Where a case
 * cannot do this, it says so.
 *
 * Spike cases of the feasibility study: S1 editor split left / right / bottom; S2 the top and the
 * centre of the editor (the two accepted limits); S3 another pane, sidebars, pop-out; S4 out of the
 * window; S5 drops on the strip fire, Obsidian moves nothing and leaves no overlay; S6 redraw right
 * after a drop; S7 Escape / invalid drop cleanup; S8 a deferred tab; S9 a pop-out's horizontal strip
 * follows the L7 rules; S10 Obsidian's onDragLeaf per version.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run).
 */
import { browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cancelDrag, cdp, dragOver, dragStarts, dropAt, enableDrags, highlight, startRowDrag, type Point } from '../drag';
import {
	errorTimeline,
	groupOf,
	headerSel,
	makeGroup,
	mainStrip,
	membersInOrder,
	NOTES,
	openNotes,
	openPopoutLeafWithNotes,
	pageState,
	record,
	runCommand,
	setActive,
	setLook,
	setPinned,
	shot,
	startErrorWatch,
	stripOf,
	waitForState,
	warmUpPopouts,
	windowHandleWith,
	withWarmPopout,
	writeEvidence,
	type PageState,
	type Role,
} from '../helpers';

const CMD = {
	toggle: 'tabstrip:toggle-vertical-tabs',
	collapse: 'tabstrip:toggle-vertical-strip-collapsed',
	back: 'tabstrip:move-tab-back',
	forward: 'tabstrip:move-tab-forward',
	remove: 'tabstrip:remove-from-group',
} as const;

// ---------------------------------------------------------------- page reads

interface VState {
	mounted: boolean;
	collapsed: boolean;
	peek: boolean;
	dragOpen: boolean;
	stripWidth: number;
	panelWidth: number;
	/** Item keys of the shown rows, in list order. */
	order: string[];
	line: { y: number; member: boolean } | null;
	/** Item keys of rows highlighted as the group the tab would join. */
	join: string[];
	dragging: string[];
	dragged: string | null;
	stats: {
		drags: { native: number; missing: number; threw: number };
		drops: number;
		dragEventMs: number[];
		dragFrameMs: number[];
		heldRenders: number;
		dragFrames: number;
		dragPaints: number;
		dragPaintsOffFrame: number;
		dragFramesSameFrame: number;
		dragScrollRepaints: number;
	};
}

async function vstate(): Promise<VState> {
	return browser.executeObsidian(({ app }) => {
		const strip = app.workspace.containerEl.querySelector<HTMLElement>(':scope > .tabstrip-vstrip');
		const panel = strip?.querySelector<HTMLElement>('.tabstrip-vstrip-panel') ?? null;
		const keys = (sel: string) => Array.from(strip?.querySelectorAll(sel) ?? []).map((el) => el.getAttribute('data-tabstrip-item') ?? '?');
		const line = strip?.querySelector<HTMLElement>('.tabstrip-vdrop-line') ?? null;
		const shown = line !== null && getComputedStyle(line).display !== 'none';
		const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { vstrip(): unknown } } | undefined> } }).plugins.plugins['tabstrip'];
		const stats = p?.debug.vstrip() as VState['stats'];
		const controller = (p as unknown as { controller?: { vstrip?: { draggedLeaf: string | null } } } | undefined)?.controller;
		return {
			mounted: strip !== null,
			collapsed: strip?.classList.contains('is-collapsed') ?? false,
			peek: strip?.classList.contains('is-peek') ?? false,
			dragOpen: strip?.classList.contains('is-drag-open') ?? false,
			stripWidth: strip?.getBoundingClientRect().width ?? 0,
			panelWidth: panel?.getBoundingClientRect().width ?? 0,
			order: Array.from(strip?.querySelectorAll<HTMLElement>('[data-tabstrip-item]') ?? [])
				.filter((el) => el.offsetHeight > 0)
				.map((el) => el.getAttribute('data-tabstrip-item') ?? '?'),
			line: shown && line !== null ? { y: line.getBoundingClientRect().top + 1, member: line.classList.contains('is-member') } : null,
			join: keys('.tabstrip-vdrop-join'),
			dragging: keys('.is-dragging'),
			dragged: controller?.vstrip?.draggedLeaf ?? null,
			stats,
		};
	});
}

/** Everything a drag may leave behind: ours (line, highlight, dimmed row) and Obsidian's (ghost, overlay, fake target, opacity, grabbing). */
async function residue(): Promise<Record<string, number | boolean>> {
	return browser.execute(() => {
		const shown = (el: Element) => {
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && (r.width > 0 || r.height > 0);
		};
		return {
			line: Array.from(document.querySelectorAll('.tabstrip-vdrop-line')).length,
			join: document.querySelectorAll('.tabstrip-vdrop-join').length,
			dragging: document.querySelectorAll('.tabstrip-vrow.is-dragging').length,
			dragOpen: document.querySelectorAll('.tabstrip-vstrip.is-drag-open').length,
			ghost: document.querySelectorAll('.drag-ghost').length,
			overlay: Array.from(document.querySelectorAll('.workspace-drop-overlay')).filter(shown).length,
			fake: document.querySelectorAll('.workspace-fake-target-overlay, .workspace-fake-target-container').length,
			// Obsidian hides the pane under its split preview with an inline opacity 0 and clears it at the end.
			// Elements that had it before the case began (marked by beforeEach) are not the drag's, nor
			// Obsidian's split resize handles (always opacity 0 until hovered; a layout load makes new ones).
			opacity: Array.from(document.querySelectorAll<HTMLElement>('.workspace *')).filter((el) => el.style.opacity === '0' && !el.hasAttribute('data-e2e-opacity-base') && !el.classList.contains('workspace-leaf-resize-handle')).length,
			grabbing: document.body.classList.contains('is-grabbing'),
		};
	});
}

const CLEAN = { line: 0, join: 0, dragging: 0, dragOpen: 0, ghost: 0, overlay: 0, fake: 0, opacity: 0, grabbing: false };

/** A viewport point on a strip item (`t:`, `g:`, `n:` + id), at `fy` of its height. */
async function itemPoint(key: string, fy = 0.5): Promise<Point & { top: number; bottom: number }> {
	return browser.execute(
		(k, f) => {
			const el = document.querySelector(`.tabstrip-vstrip [data-tabstrip-item="${k}"]`);
			if (!el) throw new Error(`no strip item ${k}`);
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + r.height * f), top: r.top, bottom: r.bottom };
		},
		key,
		fy,
	);
}

/** Viewport box of the root split pane that holds this leaf (its WorkspaceTabs element). */
async function paneBox(leafId: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
	return browser.executeObsidian(({ app }, id) => {
		const leaf = app.workspace.getLeafById(id) as unknown as { parent: { containerEl: HTMLElement } } | null;
		if (!leaf) throw new Error(`no leaf ${id}`);
		const r = leaf.parent.containerEl.getBoundingClientRect();
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
	}, leafId);
}

/** Where a leaf lives: 'root', 'left', 'right', 'popout', and its parent's children (ids). */
async function whereIs(leafId: string): Promise<{ root: string; siblings: string[]; panes: number }> {
	return browser.executeObsidian(({ app }, id) => {
		const leaf = app.workspace.getLeafById(id) as unknown as { getRoot(): unknown; parent: { children: { id: string }[] } } | null;
		const ws = app.workspace as unknown as { rootSplit: unknown; leftSplit: unknown; rightSplit: unknown };
		const parents = new Set<unknown>();
		app.workspace.iterateRootLeaves((l) => {
			parents.add(l.parent);
		});
		if (!leaf) return { root: 'gone', siblings: [], panes: parents.size };
		const root = leaf.getRoot();
		const name = root === ws.rootSplit ? 'root' : root === ws.leftSplit ? 'left' : root === ws.rightSplit ? 'right' : 'popout';
		return { root: name, siblings: leaf.parent.children.map((c) => c.id), panes: parents.size };
	}, leafId);
}

async function drops(): Promise<PageState['stats']['drops']> {
	return (await pageState()).stats.drops;
}

/** Waits until drop number `count` was handled (not pending), then returns the page state. */
async function afterDrop(count: number): Promise<PageState> {
	return waitForState((x) => x.stats.drops.length >= count && x.stats.drops[count - 1]?.fate !== 'pending', `drop ${String(count)} handled`, 4000);
}

/** A full drag of a row dropped at `p`; `during` runs while the pointer is over `p`. */
async function rowDrag(leafId: string, p: Point, during?: () => Promise<void>): Promise<void> {
	await startRowDrag(leafId);
	await dragOver(p, true);
	await browser.pause(60);
	await dragOver(p);
	await browser.pause(80);
	if (during) await during();
	await dropAt(p);
}

async function waitDragEnded(): Promise<void> {
	await browser.waitUntil(async () => (await vstate()).dragged === null, { timeout: 3000, timeoutMsg: 'the strip drag did not end' });
	await browser.pause(120);
}

async function expectNoErrors(): Promise<void> {
	expect(await errorTimeline()).toEqual([]);
}

async function freshNotes<R extends Role>(roles: R[]): Promise<Record<R, string>> {
	const ids = (await openNotes(roles)) as Record<R, string>;
	let s = await pageState();
	for (const id of Object.values<string>(ids)) {
		if (groupOf(s, id) === null) continue;
		await setActive(id);
		expect(await runCommand(CMD.remove)).toBe(true);
		s = await waitForState((x) => groupOf(x, id) === null, 'leftover group gone');
	}
	return ids;
}

/** Leaves the root split with one pane (closes the others' tabs). */
async function onePane(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		let keep: unknown = null;
		const extra: import('obsidian').WorkspaceLeaf[] = [];
		app.workspace.iterateRootLeaves((leaf) => {
			keep ??= leaf.parent;
			if (leaf.parent !== keep) extra.push(leaf);
		});
		for (const leaf of extra) leaf.detach();
	});
	await waitForState((x) => x.strips.filter((s) => s.kind === 'main').length === 1, 'one pane');
}

async function vertical(): Promise<void> {
	const on = await browser.executeObsidian(({ app }) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { orientation(): string } } | undefined> } }).plugins.plugins['tabstrip'];
		return p?.debug.orientation() === 'vertical';
	});
	if (!on) expect(await runCommand(CMD.toggle)).toBe(true);
	await browser.waitUntil(async () => (await vstate()).order.length > 0, { timeout: 5000, timeoutMsg: 'vertical strip shown' });
}

async function stripCollapsed(want: boolean): Promise<void> {
	const now = (await vstate()).collapsed;
	if (now !== want) expect(await runCommand(CMD.collapse)).toBe(true);
	await browser.waitUntil(async () => (await vstate()).collapsed === want, { timeout: 3000, timeoutMsg: `strip collapsed ${String(want)}` });
}

/** Moves the real pointer far from the strip (the icon bar closes). */
async function pointerAway(): Promise<void> {
	await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: 700, y: 400, origin: 'viewport', duration: 30 }).perform();
}

async function pointerTo(p: Point): Promise<void> {
	await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: Math.round(p.x), y: Math.round(p.y), origin: 'viewport', duration: 40 }).perform();
}

/** Step V6: counts the main window's animation frames (on: start afresh; off: stop and return the count). */
async function pageFrames(on: boolean): Promise<number> {
	return browser.execute((start) => {
		const w = window as Window & { e2eFrames?: { n: number; on: boolean } };
		if (start) {
			const c = { n: 0, on: true };
			w.e2eFrames = c;
			const tick = () => {
				if (!c.on) return;
				c.n++;
				window.requestAnimationFrame(tick);
			};
			window.requestAnimationFrame(tick);
			return 0;
		}
		const c = w.e2eFrames;
		if (!c) throw new Error('frame counter not started');
		c.on = false;
		return c.n;
	}, on);
}

function median(xs: readonly number[]): number {
	const a = [...xs].sort((x, y) => x - y);
	if (a.length === 0) return 0;
	const m = Math.floor(a.length / 2);
	return a.length % 2 === 1 ? (a[m] ?? 0) : ((a[m - 1] ?? 0) + (a[m] ?? 0)) / 2;
}

describe('V5 drag in and out of the vertical strip', function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
			app.workspace.leftSplit.collapse();
			app.workspace.rightSplit.collapse();
		});
		await startErrorWatch();
		const warmUp = await warmUpPopouts();
		await enableDrags();
		record('v5-setup', { warmUp, obsidian: browser.getObsidianVersion(), installer: browser.getObsidianInstallerVersion() });
	});

	beforeEach(async function () {
		const base = await browser.execute(() => {
			const els = Array.from(document.querySelectorAll<HTMLElement>('.workspace *')).filter((el) => el.style.opacity === '0');
			for (const el of els) el.setAttribute('data-e2e-opacity-base', '');
			return els.map((el) => el.className.toString());
		});
		record(`opacity-base-${this.currentTest?.title.split(' ')[0] ?? ''}`, base);
		await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { controller?: { stats: { drops: unknown[] } } | null } | undefined> } }).plugins.plugins['tabstrip'];
			plugin?.controller?.stats.drops.splice(0);
		});
	});

	afterEach(async function () {
		const main = (await browser.getWindowHandles())[0];
		if (main !== undefined) await browser.switchToWindow(main);
		await cancelDrag();
		if (this.currentTest?.state === 'failed') {
			await browser.executeObsidian(({ app }) => {
				const wins = new Set<Window>();
				app.workspace.iterateAllLeaves((leaf) => {
					const win = leaf.getContainer().win;
					if (win !== window) wins.add(win);
				});
				for (const w of wins) w.close();
			});
			await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'pop-outs of a failed case closed');
		}
	});

	after(function () {
		writeEvidence('v5-drag');
	});

	it('V0 only tab rows drag: a real press and move on a row gives one trusted dragstart and starts Obsidian\'s own tab drag (S10); group rows, "New tab" and header buttons do not drag', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Work', 'blue');
		await setActive(ids.n1);
		await vertical();
		const attrs = await browser.execute(() => ({
			rows: Array.from(document.querySelectorAll('.tabstrip-vrow')).map((r) => r.getAttribute('draggable')),
			groups: Array.from(document.querySelectorAll('.tabstrip-vgroup')).map((r) => r.getAttribute('draggable')),
			news: Array.from(document.querySelectorAll('.tabstrip-vnew')).map((r) => r.getAttribute('draggable')),
			buttons: Array.from(document.querySelectorAll('.tabstrip-vstrip-header [role=button]')).map((r) => (r as HTMLElement).draggable),
		}));
		expect(attrs.rows.every((x) => x === 'true')).toBe(true);
		expect(attrs.groups.every((x) => x === null)).toBe(true);
		expect(attrs.news.every((x) => x === null)).toBe(true);
		expect(attrs.buttons.every((x) => !x)).toBe(true);
		const before = (await vstate()).stats.drags;
		await startRowDrag(ids.n4);
		const during = await vstate();
		expect(during.dragged).toBe(ids.n4);
		expect(during.dragging).toEqual([`t:${ids.n4}`]);
		const grabbing = await browser.execute(() => document.body.classList.contains('is-grabbing'));
		await cancelDrag();
		await waitDragEnded();
		const after = await vstate();
		expect(after.stats.drags.native).toBe(before.native + 1);
		expect(after.stats.drags.missing + after.stats.drags.threw).toBe(before.missing + before.threw);
		// A press and move on a group row and on the "New tab" row starts no drag at all.
		{
			const p = await itemPoint(`g:${g}`);
			await dragStarts();
			await browser.action('pointer').move({ x: p.x, y: p.y, duration: 0 }).down({ button: 0 }).move({ x: p.x + 12, y: p.y, duration: 40 }).move({ x: p.x + 24, y: p.y, duration: 40 }).up({ button: 0 }).perform();
			expect(await dragStarts()).toEqual([]);
		}
		const newKey = (await vstate()).order.find((k) => k.startsWith('n:')) ?? '';
		const np = await itemPoint(newKey);
		await dragStarts();
		await browser.action('pointer').move({ x: np.x, y: np.y, duration: 0 }).down({ button: 0 }).move({ x: np.x + 24, y: np.y, duration: 60 }).up({ button: 0 }).perform();
		expect(await dragStarts()).toEqual([]);
		// That press on "New tab" made a tab (a click): close it again.
		await browser.pause(150);
		await freshNotes(['n1', 'n2', 'n3', 'n4']);
		expect(await residue()).toEqual(CLEAN);
		record('V0', { attrs: { rows: attrs.rows.length, groups: attrs.groups.length }, drags: after.stats.drags, grabbingDuringDrag: grabbing });
		await expectNoErrors();
	});

	it('V1 S5 drops on the strip fire and reorder: Obsidian moves nothing itself and leaves no overlay; the line shows where the tab goes; the row list is redrawn at once (S6) with the same row element', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		await setActive(ids.n1);
		await vertical();
		await browser.execute((id) => {
			const row = document.querySelector<HTMLElement & { e2eMark?: number }>(`.tabstrip-vrow[data-tabstrip-leaf="${id}"]`);
			if (row) row.e2eMark = 5;
		}, ids.n4);
		let n = (await drops()).length;
		const target = await itemPoint(`t:${ids.n2}`, 0.25);
		let during: VState | null = null;
		let overlay: unknown = null;
		await rowDrag(ids.n4, target, async () => {
			during = await vstate();
			overlay = await residue();
		});
		let s = await afterDrop(++n);
		const v = await vstate();
		const d = during as VState | null;
		expect(d?.line?.member).toBe(false);
		expect(Math.abs((d?.line?.y ?? 0) - target.top)).toBeLessThanOrEqual(2);
		expect(d?.join).toEqual([]);
		expect((overlay as { overlay: number; fake: number }).overlay).toBe(0);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n4, ids.n2, ids.n3]);
		expect(s.stats.drops[n - 1]).toMatchObject({ via: 'vertical', fate: 'used', target: { leafId: ids.n4, spot: { kind: 'tab', leafId: ids.n2, side: 'before' } } });
		expect(v.order.filter((k) => k.startsWith('t:'))).toEqual([ids.n1, ids.n4, ids.n2, ids.n3].map((id) => `t:${id}`));
		const same = await browser.execute((id) => document.querySelector<HTMLElement & { e2eMark?: number }>(`.tabstrip-vrow[data-tabstrip-leaf="${id}"]`)?.e2eMark ?? null, ids.n4);
		expect(same).toBe(5);
		await waitDragEnded();
		expect(await residue()).toEqual(CLEAN);
		// Down to the end ("New tab" row): last.
		const newKey = (await vstate()).order.find((k) => k.startsWith('n:')) ?? '';
		await rowDrag(ids.n1, await itemPoint(newKey));
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n4, ids.n2, ids.n3, ids.n1]);
		await waitDragEnded();
		expect(await residue()).toEqual(CLEAN);
		record('V1', { during: d, order: mainStrip(s).leafIds });
		await expectNoErrors();
	});

	it('V2 group rules as on the horizontal strip: into a group\'s middle, the group row\'s lower half (joins at its start) and upper half (before it, outside), out of a group; the group to join is highlighted', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n2, ids.n3], 'Work', 'blue');
		await setActive(ids.n1);
		await vertical();
		let n = (await drops()).length;
		// n5 onto the lower half of the first member: between the members, joins.
		let during: VState | null = null;
		await rowDrag(ids.n5, await itemPoint(`t:${ids.n2}`, 0.75), async () => {
			during = await vstate();
		});
		let s = await afterDrop(++n);
		expect((during as VState | null)?.join.sort()).toEqual([`g:${g}`, `t:${ids.n2}`, `t:${ids.n3}`].sort());
		expect((during as VState | null)?.line?.member).toBe(true);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n5, ids.n3, ids.n4]);
		expect(groupOf(s, ids.n5)).toBe(g);
		await waitDragEnded();
		// n4 onto the group row's lower half: joins at the start.
		await rowDrag(ids.n4, await itemPoint(`g:${g}`, 0.8));
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n4, ids.n2, ids.n5, ids.n3]);
		expect(membersInOrder(s, g)).toEqual([ids.n4, ids.n2, ids.n5, ids.n3]);
		await waitDragEnded();
		// n3 (last member) onto the group row's upper half: before the group, outside it.
		during = null;
		await rowDrag(ids.n3, await itemPoint(`g:${g}`, 0.2), async () => {
			during = await vstate();
		});
		s = await afterDrop(++n);
		expect((during as VState | null)?.join).toEqual([]);
		expect((during as VState | null)?.line?.member).toBe(false);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n3, ids.n4, ids.n2, ids.n5]);
		expect(groupOf(s, ids.n3)).toBeNull();
		await waitDragEnded();
		// The first member n4 onto n1's lower half (an ungrouped neighbour): leaves its group in place... (n1 is before the gap of n3).
		// n5 (last member) dragged to the end: leaves.
		const newKey = (await vstate()).order.find((k) => k.startsWith('n:')) ?? '';
		await rowDrag(ids.n5, await itemPoint(newKey));
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n3, ids.n4, ids.n2, ids.n5]);
		expect(groupOf(s, ids.n5)).toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n4, ids.n2]);
		expect(s.stats.drops.slice(-1)[0]).toMatchObject({ via: 'vertical', fate: 'noop', inPlace: true });
		await waitDragEnded();
		expect(await residue()).toEqual(CLEAN);
		record('V2', { order: mainStrip(s).leafIds, members: membersInOrder(s, g) });
		await expectNoErrors();
	});

	it('V3 collapsed groups are never joined (a drop on the group row lands after it, the group stays collapsed); pinned tabs reorder among pinned tabs and never join a group', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n2, ids.n3], 'Closed', 'red');
		await setActive(ids.n1);
		await browser.executeObsidian(
			({ app }, gid) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { setCollapsed(id: string, c: boolean): boolean } } | undefined> } }).plugins.plugins['tabstrip'];
				p?.debug.setCollapsed(gid, true);
			},
			g,
		);
		await vertical();
		await browser.waitUntil(async () => !(await vstate()).order.includes(`t:${ids.n2}`), { timeout: 3000, timeoutMsg: 'members hidden' });
		let n = (await drops()).length;
		let during: VState | null = null;
		await rowDrag(ids.n5, await itemPoint(`g:${g}`, 0.8), async () => {
			during = await vstate();
		});
		let s = await afterDrop(++n);
		expect((during as VState | null)?.join).toEqual([]);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n5, ids.n4]);
		expect(groupOf(s, ids.n5)).toBeNull();
		expect(s.state.groups.find((x) => x.id === g)?.collapsed).toBe(true);
		await waitDragEnded();
		// Review round 1: n5 now sits right after the collapsed group; dropped on the group row's lower half
		// again, the rules put it straight back: no drop line while dragging, nothing moves, a no-op drop.
		during = null;
		await rowDrag(ids.n5, await itemPoint(`g:${g}`, 0.9), async () => {
			during = await vstate();
		});
		s = await afterDrop(++n);
		expect((during as VState | null)?.line).toBeNull();
		expect((during as VState | null)?.join).toEqual([]);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n5, ids.n4]);
		expect(groupOf(s, ids.n5)).toBeNull();
		expect(s.stats.drops[n - 1]).toMatchObject({ via: 'vertical', fate: 'noop', target: { leafId: ids.n5, spot: { kind: 'chip', groupId: g } } });
		expect(s.stats.drops[n - 1]?.afterCollapsed).toBeUndefined();
		record('V3-noop', { drop: s.stats.drops[n - 1] });
		await waitDragEnded();
		// Pinned: n1 and n4 pinned (pinned area). n4 dragged above n1: reordered; dragged into the group: stays out.
		await setPinned(ids.n1, true);
		await setPinned(ids.n4, true);
		s = await waitForState((x) => mainStrip(x).pinned.filter(Boolean).length === 2, 'two pinned');
		await browser.waitUntil(async () => (await vstate()).order.slice(0, 2).every((k) => k === `t:${ids.n1}` || k === `t:${ids.n4}`), { timeout: 3000, timeoutMsg: 'pinned area' });
		await rowDrag(ids.n4, await itemPoint(`t:${ids.n1}`, 0.25));
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds.slice(0, 2)).toEqual([ids.n4, ids.n1]);
		await waitDragEnded();
		// Review round 2: pinned tabs stay first, so the line shows where the tab really lands. Unpinned n5
		// dropped on pinned n1's upper half: the line is at the pane's first unpinned row (the collapsed
		// group's row), and n5 lands there, before the group, outside it.
		const groupRow = await itemPoint(`g:${g}`);
		during = null;
		await rowDrag(ids.n5, await itemPoint(`t:${ids.n1}`, 0.25), async () => {
			during = await vstate();
		});
		s = await afterDrop(++n);
		expect(Math.abs(((during as VState | null)?.line?.y ?? -100) - groupRow.top)).toBeLessThanOrEqual(2);
		expect((during as VState | null)?.join).toEqual([]);
		expect(mainStrip(s).leafIds).toEqual([ids.n4, ids.n1, ids.n5, ids.n2, ids.n3]);
		expect(groupOf(s, ids.n5)).toBeNull();
		await waitDragEnded();
		// Pinned n4 dropped on unpinned n5's lower half: the line is below the pane's last pinned row (n1),
		// and n4 lands there, still pinned, outside any group.
		const lastPinned = await itemPoint(`t:${ids.n1}`);
		during = null;
		await rowDrag(ids.n4, await itemPoint(`t:${ids.n5}`, 0.75), async () => {
			during = await vstate();
		});
		s = await afterDrop(++n);
		expect(Math.abs(((during as VState | null)?.line?.y ?? -100) - lastPinned.bottom)).toBeLessThanOrEqual(2);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n4, ids.n5, ids.n2, ids.n3]);
		expect(mainStrip(s).pinned.slice(0, 3)).toEqual([true, true, false]);
		expect(groupOf(s, ids.n4)).toBeNull();
		await waitDragEnded();
		// Expand the group and drop a pinned tab between its members: no highlight, not a member, back in the pinned area.
		await browser.executeObsidian(
			({ app }, gid) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { setCollapsed(id: string, c: boolean): boolean } } | undefined> } }).plugins.plugins['tabstrip'];
				p?.debug.setCollapsed(gid, false);
			},
			g,
		);
		await browser.waitUntil(async () => (await vstate()).order.includes(`t:${ids.n2}`), { timeout: 3000, timeoutMsg: 'members shown' });
		const pinnedEnd = await itemPoint(`t:${ids.n4}`);
		during = null;
		await rowDrag(ids.n1, await itemPoint(`t:${ids.n2}`, 0.75), async () => {
			during = await vstate();
		});
		s = await afterDrop(++n);
		await browser.pause(300);
		s = await pageState();
		expect((during as VState | null)?.join).toEqual([]);
		// Pinned tabs stay first: n1 lands after the pane's last pinned tab n4, where the line is (review round 2).
		expect(Math.abs(((during as VState | null)?.line?.y ?? -100) - pinnedEnd.bottom)).toBeLessThanOrEqual(2);
		expect(mainStrip(s).leafIds.slice(0, 2)).toEqual([ids.n4, ids.n1]);
		expect(groupOf(s, ids.n1)).toBeNull();
		expect(mainStrip(s).pinned.slice(0, 2)).toEqual([true, true]);
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3]);
		await waitDragEnded();
		await setPinned(ids.n1, false);
		await setPinned(ids.n4, false);
		expect(await residue()).toEqual(CLEAN);
		record('V3', { order: mainStrip(s).leafIds });
		await expectNoErrors();
	});

	it('V4 across panes of the root split: into a group there joins it (highlight in that pane); to a plain place there leaves its group', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n1, ids.n2], 'Left', 'blue');
		await setActive(ids.n1);
		const right = await browser.executeObsidian(
			async ({ app, obsidian }, paths) => {
				const out: string[] = [];
				let leaf = app.workspace.getLeaf('split', 'vertical');
				for (const [i, p] of paths.entries()) {
					const file = app.vault.getFileByPath(p);
					if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
					if (i > 0) leaf = app.workspace.getLeaf('tab');
					await leaf.openFile(file);
					out.push((leaf as unknown as { id: string }).id);
				}
				return out;
			},
			[NOTES.n7, NOTES.n8, NOTES.n9],
		);
		const [r1, r2, r3] = right as [string, string, string];
		await waitForState((x) => x.strips.filter((st) => st.kind === 'main').length === 2, 'split ready');
		const h = await makeGroup([r1, r2], 'Right', 'green');
		await vertical();
		let n = (await drops()).length;
		let during: VState | null = null;
		await rowDrag(ids.n2, await itemPoint(`t:${r1}`, 0.75), async () => {
			during = await vstate();
		});
		let s = await afterDrop(++n);
		expect((during as VState | null)?.join.sort()).toEqual([`g:${h}`, `t:${r1}`, `t:${r2}`].sort());
		expect(stripOf(s, r1).leafIds).toEqual([r1, ids.n2, r2, r3]);
		expect(groupOf(s, ids.n2)).toBe(h);
		expect(membersInOrder(s, g)).toEqual([ids.n1]);
		await waitDragEnded();
		// n1 (the last member of Left) to the end of the right pane: leaves; Left goes (empty).
		const keys = (await vstate()).order.filter((k) => k.startsWith('n:'));
		await rowDrag(ids.n1, await itemPoint(keys[keys.length - 1] ?? ''));
		s = await afterDrop(++n);
		expect(stripOf(s, r1).leafIds).toEqual([r1, ids.n2, r2, r3, ids.n1]);
		expect(groupOf(s, ids.n1)).toBeNull();
		expect(s.state.groups.some((x) => x.id === g)).toBe(false);
		await waitDragEnded();
		expect(await residue()).toEqual(CLEAN);
		record('V4', { right: stripOf(s, r1).leafIds });
		await onePane();
		await expectNoErrors();
	});

	it('V5 S1/S2 out to the editor area: left, right and bottom split (Obsidian\'s own overlay shows); the top third and the centre go to the end of that pane (the two accepted limits); no residue', async function () {
		const results: Record<string, unknown> = {};
		for (const side of ['right', 'left', 'bottom', 'top', 'center'] as const) {
			await onePane();
			const ids = await freshNotes(['n1', 'n2', 'n3']);
			await setActive(ids.n1);
			await vertical();
			// Top and centre (review round 1): drag a tab that is NOT last, so "to the end" is visible: n1, a
			// member of [n1, n2]; at the end it is cut off from its group by n3 and must leave it.
			const nonSplit = side === 'top' || side === 'center';
			const g = nonSplit ? await makeGroup([ids.n1, ids.n2], 'Out', 'purple') : await makeGroup([ids.n2, ids.n3], 'Out', 'purple');
			const dragged = nonSplit ? ids.n1 : ids.n3;
			const box = await paneBox(ids.n1);
			const w = box.right - box.left;
			const hgt = box.bottom - box.top;
			const p: Point =
				side === 'right'
					? { x: box.right - w * 0.1, y: box.top + hgt / 2 }
					: side === 'left'
						? { x: box.left + w * 0.1, y: box.top + hgt / 2 }
						: side === 'bottom'
							? { x: box.left + w / 2, y: box.bottom - hgt * 0.1 }
							: side === 'top'
								? { x: box.left + w / 2, y: box.top + hgt * 0.1 }
								: { x: box.left + w / 2, y: box.top + hgt / 2 };
			let overlay: unknown = null;
			await rowDrag(dragged, p, async () => {
				overlay = await browser.execute(() => {
					const el = document.querySelector<HTMLElement>('.workspace-drop-overlay');
					if (!el) return null;
					const r = el.getBoundingClientRect();
					const cs = getComputedStyle(el);
					return cs.display === 'none' || cs.opacity === '0' || r.width === 0 ? null : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
				});
			});
			await waitDragEnded();
			const where = await whereIs(dragged);
			const s = await waitForState((x) => !nonSplit || mainStrip(x).leafIds[2] === dragged, `${side}: the tab at the end of its pane`);
			results[side] = { overlay, where, group: groupOf(s, dragged), members: membersInOrder(s, g) };
			if (nonSplit) {
				// No split: moved to the end of its own pane (hidden header row: no "top" band, no centre position).
				expect(where.panes).toBe(1);
				expect(where.siblings).toEqual([ids.n2, ids.n3, ids.n1]);
				// Cut off from its group by n3: it left the group (contiguous groups), the group keeps n2.
				expect(groupOf(s, ids.n1)).toBeNull();
				expect(membersInOrder(s, g)).toEqual([ids.n2]);
				// No visible indicator: Obsidian's insert marker sits in the hidden header row (no area).
				const o = overlay as { left: number; right: number; top: number; bottom: number } | null;
				expect(o === null ? 0 : Math.max(0, o.right - o.left) * Math.max(0, o.bottom - o.top)).toBe(0);
			} else {
				expect(where.panes).toBe(2);
				expect(where.siblings).toEqual([ids.n3]);
				expect(groupOf(s, ids.n3)).toBeNull();
				expect(membersInOrder(s, g)).toEqual([ids.n2]);
				expect(overlay).not.toBeNull();
			}
			expect(await residue()).toEqual(CLEAN);
		}
		record('V5', results);
		await onePane();
		await expectNoErrors();
	});

	it('V5b S3 out to ANOTHER pane of the root split (native, review round 1): its centre puts the tab at the end of that pane, no visible indicator (limit 2), out of its group; its right edge splits it', async function () {
		await onePane();
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n2, ids.n3], 'Left', 'blue');
		await setActive(ids.n1);
		const right = await browser.executeObsidian(
			async ({ app, obsidian }, paths) => {
				const out: string[] = [];
				let leaf = app.workspace.getLeaf('split', 'vertical');
				for (const [i, p] of paths.entries()) {
					const file = app.vault.getFileByPath(p);
					if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
					if (i > 0) leaf = app.workspace.getLeaf('tab');
					await leaf.openFile(file);
					out.push((leaf as unknown as { id: string }).id);
				}
				return out;
			},
			[NOTES.n7, NOTES.n8],
		);
		const [r1, r2] = right as [string, string];
		await waitForState((x) => x.strips.filter((st) => st.kind === 'main').length === 2, 'split ready');
		// The first tab of the right pane is shown (not the last), so "the end" is not where the pane's shown tab is.
		await setActive(r1);
		await vertical();
		const overlayBox = async () =>
			browser.execute(() => {
				const el = document.querySelector<HTMLElement>('.workspace-drop-overlay');
				if (!el) return null;
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				return cs.display === 'none' || cs.opacity === '0' || r.width === 0 ? null : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
			});
		let box = await paneBox(r1);
		const n = (await drops()).length;
		// n2 (the first member of Left, not its last tab) onto the centre of the right pane's editor.
		const centre: Point = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
		let overlayCentre: unknown = 'unset';
		await rowDrag(ids.n2, centre, async () => {
			overlayCentre = await overlayBox();
		});
		await waitDragEnded();
		let s = await waitForState((x) => stripOf(x, r1).leafIds.includes(ids.n2), 'n2 in the right pane');
		const whereCentre = await whereIs(ids.n2);
		expect(whereCentre.panes).toBe(2);
		expect(stripOf(s, r1).leafIds).toEqual([r1, r2, ids.n2]);
		expect(groupOf(s, ids.n2)).toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n3]);
		expect(stripOf(s, ids.n1).leafIds).toEqual([ids.n1, ids.n3]);
		// Limit 2: no visible indicator for this drop. Obsidian puts its insert marker into the pane's tab
		// header row, which is hidden: the overlay is either absent or has no area (seen: 10 x 0 px).
		const area = (o: unknown) => (o === null ? 0 : Math.max(0, (o as { right: number; left: number }).right - (o as { left: number }).left) * Math.max(0, (o as { bottom: number }).bottom - (o as { top: number }).top));
		expect(area(overlayCentre)).toBe(0);
		// Obsidian's own drop, not the strip's: no drop record of the strip.
		expect((await drops()).length).toBe(n);
		expect(await residue()).toEqual(CLEAN);
		// n3 (now the only member of Left) onto the right edge of the right pane: a new split; out of its group.
		box = await paneBox(r1);
		const edge: Point = { x: box.right - (box.right - box.left) * 0.08, y: (box.top + box.bottom) / 2 };
		let overlayEdge: unknown = null;
		await rowDrag(ids.n3, edge, async () => {
			overlayEdge = await overlayBox();
		});
		await waitDragEnded();
		const whereEdge = await whereIs(ids.n3);
		s = await pageState();
		expect(whereEdge.panes).toBe(3);
		expect(whereEdge.siblings).toEqual([ids.n3]);
		expect(groupOf(s, ids.n3)).toBeNull();
		expect(s.state.groups.some((x) => x.id === g)).toBe(false);
		expect(area(overlayEdge)).toBeGreaterThan(1000);
		expect(await residue()).toEqual(CLEAN);
		record('V5b', { overlayCentre, whereCentre, overlayEdge, whereEdge, right: stripOf(s, r1).leafIds });
		await onePane();
		await expectNoErrors();
	});

	it('V6 S3 to a sidebar and to a pop-out window\'s horizontal strip (S9: the L7 rules there: onto its chip joins its group, highlighted there)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n1, ids.n2], 'Main', 'red');
		await setActive(ids.n1);
		await vertical();
		// Right sidebar: Obsidian takes the tab into the sidebar.
		await browser.executeObsidian(({ app }) => {
			app.workspace.rightSplit.expand();
		});
		await browser.pause(400);
		const side = await browser.executeObsidian(({ app }) => {
			const r = (app.workspace.rightSplit as unknown as { containerEl: HTMLElement }).containerEl.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		});
		await rowDrag(ids.n2, side);
		await waitDragEnded();
		const inSidebar = await whereIs(ids.n2);
		expect(inSidebar.root).toBe('right');
		// Taken out of the main area: it left its group.
		expect(membersInOrder(await pageState(), g)).toEqual([ids.n1]);
		expect(await residue()).toEqual(CLEAN);
		// Close it there and the sidebar (test code), and start the pop-out part from fresh notes.
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.detach();
			app.workspace.rightSplit.collapse();
		}, ids.n2);
		await browser.pause(300);
		const ids2 = await freshNotes(['n1', 'n2', 'n3']);
		const g2 = await makeGroup([ids2.n1, ids2.n2], 'Main', 'red');
		await setActive(ids2.n1);
		// Pop-out with a group.
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n10]));
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 2), 'pop-out ready');
		const [p1, p2] = pop as [string, string];
		const pg = await makeGroup([p1, p2], 'Pop', 'cyan');
		const main = await browser.getWindowHandle();
		const popHandle = await windowHandleWith(headerSel(p1));
		if (popHandle === null) throw new Error('no pop-out window handle');
		await browser.switchToWindow(popHandle);
		await enableDrags();
		const chip = await browser.execute((gid) => {
			const c = document.querySelector(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
			if (!c) throw new Error('no chip');
			const r = c.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
		}, pg);
		await browser.switchToWindow(main);
		let n = (await drops()).length;
		await startRowDrag(ids2.n2);
		await browser.switchToWindow(popHandle);
		await dragOver(chip, true);
		await browser.pause(120);
		await dragOver(chip);
		await browser.pause(120);
		const during = await highlight();
		await dropAt(chip);
		await browser.switchToWindow(main);
		await cancelDrag();
		let s = await afterDrop(++n);
		s = await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(ids2.n2)), 'n2 in the pop-out');
		expect(during).toEqual({ headers: [p1, p2], chips: [pg], group: pg });
		expect(stripOf(s, p1).leafIds).toEqual([ids2.n2, p1, p2]);
		expect(groupOf(s, ids2.n2)).toBe(pg);
		expect(membersInOrder(s, g2)).toEqual([ids2.n1]);
		expect(s.stats.drops[n - 1]?.fate).toBe('used');
		await waitDragEnded();
		expect(await residue()).toEqual(CLEAN);
		record('V6', { sidebar: inSidebar, during, pop: stripOf(s, p1).leafIds });
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.getContainer().win.close();
		}, p1);
		await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'pop-out closed');
		await expectNoErrors();
	});

	it('V7 S4 out of the window: the drag leaves the window and ends there: Obsidian opens the tab in a new window (the row survived until its dragend)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		await setActive(ids.n1);
		await vertical();
		await startRowDrag(ids.n3);
		const p = await itemPoint(`t:${ids.n1}`);
		await dragOver(p, true);
		await browser.pause(60);
		// Chromium sends dragleave (to nothing) when the pointer leaves the window. With drag interception
		// a pointer outside the viewport is tried first; Obsidian only counts a leave while a button is
		// down, which interception may not report: then a dragleave with no target and the button down is
		// dispatched in the page (test input, recorded).
		let how = 'cdp';
		await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: -40, y: p.y, data: { items: [{ mimeType: 'text/plain', data: '' }], dragOperationsMask: 17 } }).catch(() => undefined);
		await browser.pause(60);
		const rowAlive = await browser.execute((id) => document.querySelector(`.tabstrip-vrow[data-tabstrip-leaf="${id}"]`)?.isConnected === true, ids.n3);
		const handlesBefore = (await browser.getWindowHandles()).length;
		await cancelDrag();
		await browser.pause(800);
		let where = await whereIs(ids.n3);
		if (where.root !== 'popout') {
			how = 'page-dragleave';
			await startRowDrag(ids.n3);
			await dragOver(p, true);
			await browser.pause(60);
			await browser.execute(() => {
				document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: null, buttons: 1, clientX: -40, clientY: 200 }));
			});
			await browser.pause(60);
			await cancelDrag();
			await browser.pause(800);
			where = await whereIs(ids.n3);
		}
		expect(rowAlive).toBe(true);
		expect(where.root).toBe('popout');
		expect(where.siblings).toEqual([ids.n3]);
		await browser.waitUntil(async () => (await browser.getWindowHandles()).length > handlesBefore, { timeout: 3000, timeoutMsg: 'new window' });
		await waitDragEnded();
		expect(await residue()).toEqual(CLEAN);
		record('V7', { how, where });
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.getContainer().win.close();
		}, ids.n3);
		await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'new window closed');
		await expectNoErrors();
	});

	it('V8 S7 Escape (a cancelled drag) and invalid drops leave nothing: no line, highlight, ghost, overlay, fake target, opacity or grabbing; nothing moves', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Esc', 'orange');
		await setActive(ids.n1);
		await vertical();
		const before = await pageState();
		await startRowDrag(ids.n4);
		const p = await itemPoint(`t:${ids.n2}`, 0.75);
		await dragOver(p, true);
		await browser.pause(80);
		await dragOver(p);
		await browser.pause(80);
		const on = await vstate();
		expect(on.join.length).toBeGreaterThan(0);
		expect(on.line).not.toBeNull();
		// Over the editor: Obsidian's overlay, then cancel there.
		const box = await paneBox(ids.n1);
		await dragOver({ x: box.right - 40, y: (box.top + box.bottom) / 2 });
		await browser.pause(80);
		const off = await vstate();
		expect(off.line).toBeNull();
		expect(off.join).toEqual([]);
		await cancelDrag();
		await waitDragEnded();
		let s = await pageState();
		expect(mainStrip(s).leafIds).toEqual(mainStrip(before).leafIds);
		expect(s.stats.drops.length).toBe(before.stats.drops.length);
		expect(await residue()).toEqual(CLEAN);
		// An invalid drop: on the strip's header (not the list): not accepted, nothing moves.
		await startRowDrag(ids.n4);
		const header = await browser.execute(() => {
			const r = document.querySelector('.tabstrip-vstrip-header')?.getBoundingClientRect();
			return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 100, y: 10 };
		});
		await dragOver(header, true);
		await browser.pause(80);
		const headerState = await vstate();
		await dropAt(header);
		await cancelDrag();
		await waitDragEnded();
		s = await pageState();
		expect(headerState.line).toBeNull();
		expect(mainStrip(s).leafIds).toEqual(mainStrip(before).leafIds);
		expect(groupOf(s, ids.n4)).toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3]);
		expect(await residue()).toEqual(CLEAN);
		record('V8', { on: { join: on.join, line: on.line } });
		await expectNoErrors();
	});

	it('V9 S6 the dragged row survives redraws during the drag (held until the drag ends), then the list is up to date', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		await setActive(ids.n1);
		await vertical();
		const held0 = (await vstate()).stats.heldRenders;
		await startRowDrag(ids.n3);
		await dragOver(await itemPoint(`t:${ids.n1}`), true);
		// A layout change during the drag (a new tab, test code).
		const added = await browser.executeObsidian(async ({ app, obsidian }, p) => {
			const file = app.vault.getFileByPath(p);
			if (!(file instanceof obsidian.TFile)) throw new Error('missing');
			const leaf = app.workspace.getLeaf('tab');
			await leaf.openFile(file, { active: false });
			return (leaf as unknown as { id: string }).id;
		}, NOTES.n5);
		await browser.pause(300);
		const mid = await vstate();
		const alive = await browser.execute((id) => document.querySelector(`.tabstrip-vrow[data-tabstrip-leaf="${id}"]`)?.isConnected === true, ids.n3);
		expect(alive).toBe(true);
		expect(mid.dragging).toEqual([`t:${ids.n3}`]);
		expect(mid.stats.heldRenders).toBeGreaterThan(held0);
		expect(mid.order).not.toContain(`t:${added}`);
		await cancelDrag();
		await waitDragEnded();
		const end = await vstate();
		expect(end.order).toContain(`t:${added}`);
		expect(await residue()).toEqual(CLEAN);
		record('V9', { held: mid.stats.heldRenders - held0 });
		await expectNoErrors();
	});

	it('V10 S8 a deferred (not loaded) tab dragged from its row is loaded by Obsidian\'s drag, like a native tab', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		await setActive(ids.n1);
		await vertical();
		// Reload the layout (public changeLayout): background tabs come back deferred.
		await browser.executeObsidian(async ({ app }) => {
			const ws = app.workspace as unknown as { getLayout(): unknown; changeLayout(l: unknown): Promise<void> };
			await ws.changeLayout(ws.getLayout());
		});
		await browser.pause(800);
		const deferredBefore = await browser.executeObsidian(({ app }, id) => (app.workspace.getLeafById(id) as unknown as { isDeferred?: boolean } | null)?.isDeferred ?? null, ids.n3);
		await browser.waitUntil(async () => (await vstate()).order.includes(`t:${ids.n3}`), { timeout: 3000, timeoutMsg: 'rows back' });
		await startRowDrag(ids.n3);
		await browser.pause(200);
		const deferredDuring = await browser.executeObsidian(({ app }, id) => (app.workspace.getLeafById(id) as unknown as { isDeferred?: boolean } | null)?.isDeferred ?? null, ids.n3);
		await cancelDrag();
		await waitDragEnded();
		record('V10', { deferredBefore, deferredDuring });
		expect(deferredBefore).toBe(true);
		expect(deferredDuring).toBe(false);
		expect(await residue()).toEqual(CLEAN);
		await expectNoErrors();
	});

	it('V11 S10 fallback without onDragLeaf: the row still reorders inside the strip', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		await setActive(ids.n1);
		await vertical();
		// Test only: hide Obsidian's method for one drag (an own property on the workspace instance).
		await browser.executeObsidian(({ app }) => {
			(app.workspace as unknown as Record<string, unknown>)['onDragLeaf'] = undefined;
		});
		const before = (await vstate()).stats.drags;
		let n = (await drops()).length;
		try {
			await rowDrag(ids.n3, await itemPoint(`t:${ids.n1}`, 0.25));
			const s = await afterDrop(++n);
			expect(mainStrip(s).leafIds).toEqual([ids.n3, ids.n1, ids.n2]);
			await waitDragEnded();
		} finally {
			await browser.executeObsidian(({ app }) => {
				delete (app.workspace as unknown as Record<string, unknown>)['onDragLeaf'];
			});
		}
		const after = (await vstate()).stats.drags;
		expect(after.missing).toBe(before.missing + 1);
		expect(await residue()).toEqual(CLEAN);
		record('V11', { drags: after });
		await expectNoErrors();
	});

	it('V12 files dragged in from outside are never tab drags: no line, no highlight, no drop; files along with an open row drag end it', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n2, ids.n3], 'Files', 'yellow');
		await setActive(ids.n1);
		await vertical();
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-v5-'));
		const file = path.join(tmp, 'outside.md');
		fs.writeFileSync(file, '# outside\n');
		const before = await pageState();
		const p = await itemPoint(`t:${ids.n2}`, 0.75);
		const data = { items: [], files: [file], dragOperationsMask: 1 };
		await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: p.x, y: p.y, data });
		await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y, data });
		await browser.pause(120);
		await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y + 2, data });
		await browser.pause(120);
		const during = await vstate();
		await cdp('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data });
		await browser.pause(150);
		const s = await pageState();
		fs.rmSync(tmp, { recursive: true, force: true });
		expect(during.line).toBeNull();
		expect(during.join).toEqual([]);
		expect(during.dragged).toBeNull();
		expect(s.stats.drops.length).toBe(before.stats.drops.length);
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3]);
		expect(await residue()).toEqual(CLEAN);
		// Review round 2: files that come along while a row drag is open (a real row drag, then the drag
		// carries files over the list): the strip lets go of the drag at once: no line, no highlight, no drop.
		await waitDragEnded();
		const before2 = await pageState();
		const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-v5-'));
		const file2 = path.join(tmp2, 'along.md');
		fs.writeFileSync(file2, '# along\n');
		await startRowDrag(ids.n1);
		const opened = await vstate();
		const q = await itemPoint(`t:${ids.n3}`, 0.75);
		const data2 = { items: [], files: [file2], dragOperationsMask: 1 };
		await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: q.x, y: q.y, data: data2 });
		await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: q.x, y: q.y, data: data2 });
		await browser.pause(120);
		await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: q.x, y: q.y + 2, data: data2 });
		await browser.pause(120);
		const during2 = await vstate();
		await cancelDrag();
		await browser.pause(150);
		const s2 = await pageState();
		fs.rmSync(tmp2, { recursive: true, force: true });
		expect(opened.dragged).toBe(ids.n1);
		expect(during2.dragged).toBeNull();
		expect(during2.line).toBeNull();
		expect(during2.join).toEqual([]);
		expect(s2.stats.drops.length).toBe(before2.stats.drops.length);
		expect(mainStrip(s2).leafIds).toEqual(mainStrip(before2).leafIds);
		expect(membersInOrder(s2, g)).toEqual([ids.n2, ids.n3]);
		expect(await residue()).toEqual(CLEAN);
		await expectNoErrors();
	});

	it('V13 the icon bar: an open hover overlay stays open (in place) for a drag that started in it, and the drop works; from the closed icon bar the drag works too', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Icons', 'green');
		await setActive(ids.n1);
		await vertical();
		await stripCollapsed(true);
		// Open the overlay with the real pointer.
		await pointerTo(await itemPoint(`t:${ids.n4}`));
		await browser.waitUntil(async () => (await vstate()).peek, { timeout: 3000, timeoutMsg: 'overlay open' });
		let n = (await drops()).length;
		let during: VState | null = null;
		await startRowDrag(ids.n4);
		const target = await itemPoint(`t:${ids.n2}`, 0.75);
		await dragOver(target, true);
		await browser.pause(700);
		await dragOver(target);
		await browser.pause(80);
		during = await vstate();
		await dropAt(target);
		let s = await afterDrop(++n);
		expect(during.peek).toBe(true);
		expect(during.dragOpen).toBe(true);
		expect(during.stripWidth).toBeGreaterThan(150);
		expect(during.join.sort()).toEqual([`g:${g}`, `t:${ids.n2}`, `t:${ids.n3}`].sort());
		expect(groupOf(s, ids.n4)).toBe(g);
		await waitDragEnded();
		const afterOpen = await vstate();
		expect(afterOpen.dragOpen).toBe(false);
		expect(afterOpen.stripWidth).toBeLessThan(60);
		// Closed icon bar: the pointer comes from far away, the drag starts before the overlay opens.
		await pointerAway();
		await browser.waitUntil(async () => !(await vstate()).peek, { timeout: 3000, timeoutMsg: 'overlay closed' });
		await startRowDrag(ids.n1);
		const closed = await vstate();
		const t2 = await itemPoint(`t:${ids.n3}`, 0.75);
		await dragOver(t2, true);
		await browser.pause(500);
		await dragOver(t2);
		await browser.pause(80);
		const closedDuring = await vstate();
		await dropAt(t2);
		s = await afterDrop(++n);
		expect(closed.peek).toBe(false);
		expect(closedDuring.peek).toBe(false);
		expect(closedDuring.stripWidth).toBeLessThan(60);
		expect(groupOf(s, ids.n1)).toBe(g);
		await waitDragEnded();
		await pointerAway();
		await stripCollapsed(false);
		expect(await residue()).toEqual(CLEAN);
		record('V13', { open: { width: during.stripWidth, panel: during.panelWidth }, closed: { width: closedDuring.stripWidth } });
		await expectNoErrors();
	});

	it('V14 keyboard: Alt+Arrow Up / Down on a focused row moves the tab (into and out of groups one step at a time); the commands do the same for the current tab', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Keys', 'pink');
		await setActive(ids.n1);
		await vertical();
		await browser.execute((id) => {
			document.querySelector<HTMLElement>(`.tabstrip-vrow[data-tabstrip-leaf="${id}"]`)?.focus();
		}, ids.n1);
		await browser.pause(80);
		const seen: string[] = [];
		const step = async (key: string) => {
			await browser.keys([Key.Alt, key]);
			await browser.pause(250);
			const s = await pageState();
			seen.push(`${mainStrip(s).leafIds.join(' ')} ${groupOf(s, ids.n1) ?? '-'}`);
			return s;
		};
		let s = await step(Key.ArrowDown);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4]);
		expect(groupOf(s, ids.n1)).toBe(g);
		s = await step(Key.ArrowDown);
		expect(mainStrip(s).leafIds).toEqual([ids.n2, ids.n1, ids.n3, ids.n4]);
		s = await step(Key.ArrowDown);
		s = await step(Key.ArrowDown);
		expect(mainStrip(s).leafIds).toEqual([ids.n2, ids.n3, ids.n1, ids.n4]);
		expect(groupOf(s, ids.n1)).toBeNull();
		s = await step(Key.ArrowDown);
		expect(mainStrip(s).leafIds).toEqual([ids.n2, ids.n3, ids.n4, ids.n1]);
		const focus = await browser.execute(() => document.activeElement?.getAttribute('data-tabstrip-leaf') ?? null);
		expect(focus).toBe(ids.n1);
		s = await step(Key.ArrowUp);
		expect(mainStrip(s).leafIds).toEqual([ids.n2, ids.n3, ids.n1, ids.n4]);
		// The commands, on the current tab (no default hotkey).
		await setActive(ids.n4);
		expect(await runCommand(CMD.back)).toBe(true);
		s = await waitForState((x) => mainStrip(x).leafIds.join() === [ids.n2, ids.n3, ids.n4, ids.n1].join(), 'moved back');
		expect(await runCommand(CMD.forward)).toBe(true);
		s = await waitForState((x) => mainStrip(x).leafIds.join() === [ids.n2, ids.n3, ids.n1, ids.n4].join(), 'moved forward');
		const hotkeys = await browser.executeObsidian(({ app }) => {
			const hk = (app as unknown as { hotkeyManager: { getDefaultHotkeys(id: string): unknown[] | undefined } }).hotkeyManager;
			return ['tabstrip:move-tab-back', 'tabstrip:move-tab-forward'].map((id) => hk.getDefaultHotkeys(id)?.length ?? 0);
		});
		expect(hotkeys).toEqual([0, 0]);
		record('V14', { seen, drops: s.stats.drops.map((d) => d.via) });
		await expectNoErrors();
	});

	it('V15 the drop line and the highlight in four looks (light / dark, default / Atom) and forced colours (screenshots)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Look 看', 'blue');
		await setActive(ids.n1);
		await vertical();
		const files: string[] = [];
		for (const [theme, dark] of [
			['default', false],
			['default', true],
			['Atom', false],
			['Atom', true],
		] as const) {
			await setLook(theme, dark);
			await startRowDrag(ids.n4);
			const p = await itemPoint(`t:${ids.n2}`, 0.75);
			await dragOver(p, true);
			await browser.pause(80);
			await dragOver(p);
			await browser.pause(150);
			const v = await vstate();
			expect(v.join.length).toBe(3);
			expect(v.line?.member).toBe(true);
			files.push(await shot(`drag-${theme.toLowerCase()}-${dark ? 'dark' : 'light'}`, 'V5'));
			await cancelDrag();
			await waitDragEnded();
		}
		await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
		let forcedStyle: unknown = null;
		try {
			await startRowDrag(ids.n4);
			const p = await itemPoint(`t:${ids.n2}`, 0.75);
			await dragOver(p, true);
			await browser.pause(150);
			await dragOver(p);
			await browser.pause(150);
			// V5 review round 1: the line must stand out from the joined rows' outlines.
			const forced = await browser.execute(() => {
				const line = document.querySelector('.tabstrip-vdrop-line.is-shown');
				const row = document.querySelector('.tabstrip-vrow.tabstrip-vdrop-join');
				const chip = document.querySelector('.tabstrip-vgroup.tabstrip-vdrop-join > .tabstrip-vgroup-chip');
				if (line === null || row === null || chip === null) return null;
				const l = getComputedStyle(line);
				const r = getComputedStyle(row);
				const c = getComputedStyle(chip);
				return { lineBg: l.backgroundColor, lineBorder: l.borderTopColor, lineHeight: line.getBoundingClientRect().height, rowOutline: r.outlineColor, rowOutlineWidth: r.outlineWidth, chipOutline: c.outlineColor, chipOutlineStyle: c.outlineStyle };
			});
			forcedStyle = forced;
			expect(forced).not.toBeNull();
			if (forced !== null) {
				expect(forced.lineBg).not.toBe(forced.rowOutline);
				expect(forced.lineBorder).not.toBe(forced.lineBg);
				expect(forced.lineHeight).toBeGreaterThanOrEqual(8);
				expect(forced.rowOutlineWidth).toBe('2px');
				expect(forced.chipOutline).toBe(forced.rowOutline);
				expect(forced.chipOutlineStyle).toBe('solid');
			}
			files.push(await shot('drag-forced-colors', 'V5'));
			await cancelDrag();
			await waitDragEnded();
		} finally {
			await cdp('Emulation.setEmulatedMedia', { features: [] });
		}
		await setLook('default', false);
		expect(await residue()).toEqual(CLEAN);
		record('V15', { files, group: g, forcedStyle });
		await expectNoErrors();
	});

	it('V16 performance: dragover handling and the drop frame stay under 1 ms (median), 60 tabs', async function () {
		await freshNotes(['n1']);
		const ids = await browser.executeObsidian(async ({ app, obsidian }, paths) => {
			const out: string[] = [];
			for (let i = 0; i < 60; i++) {
				const file = app.vault.getFileByPath(paths[i % paths.length] ?? '');
				if (!(file instanceof obsidian.TFile)) throw new Error('missing');
				const leaf = app.workspace.getLeaf('tab');
				await leaf.openFile(file, { active: false });
				out.push((leaf as unknown as { id: string }).id);
			}
			return out;
		}, Object.values(NOTES));
		await vertical();
		for (let i = 0; i < 6; i++) await makeGroup(ids.slice(i * 8, i * 8 + 4), `G${String(i)}`);
		const before = (await vstate()).stats;
		const e0 = before.dragEventMs.length;
		const f0 = before.dragFrameMs.length;
		const first = ids[2] ?? '';
		await startRowDrag(first);
		const top = await itemPoint(`t:${ids[0] ?? ''}`);
		// Step V6 (carry-over 2): browser frames during the drag, counted in the page, against the strip's
		// drag frames and paints: at most one paint per frame, none outside a frame.
		await pageFrames(true);
		await dragOver(top, true);
		for (let k = 0; k < 80; k++) {
			await dragOver({ x: top.x, y: top.y + (k % 20) * 7 });
		}
		await browser.pause(100);
		const browserFrames = await pageFrames(false);
		await cancelDrag();
		await waitDragEnded();
		const st = (await vstate()).stats;
		const events = st.dragEventMs.slice(e0);
		const frames = st.dragFrameMs.slice(f0);
		const paints = { browserFrames, dragFrames: st.dragFrames - before.dragFrames, paints: st.dragPaints - before.dragPaints, offFrame: st.dragPaintsOffFrame - before.dragPaintsOffFrame, sameFrame: st.dragFramesSameFrame - before.dragFramesSameFrame };
		const result = { events: events.length, eventMedian: median(events), eventMax: Math.max(...events), frames: frames.length, frameMedian: median(frames), frameMax: Math.max(...frames), paints };
		record('V16', result);
		expect(events.length).toBeGreaterThan(40);
		expect(result.eventMedian).toBeLessThanOrEqual(1);
		expect(result.frameMedian).toBeLessThanOrEqual(1);
		// Positive control: the drag really painted in many frames (20 rows passed under the pointer).
		expect(paints.paints).toBeGreaterThan(10);
		expect(paints.paints).toBeLessThanOrEqual(paints.dragFrames);
		expect(paints.dragFrames).toBeLessThanOrEqual(paints.browserFrames);
		expect(paints.sameFrame).toBe(0);
		expect(paints.offFrame).toBe(0);
		// More drag events than frames that did work: they were coalesced per frame.
		expect(events.length).toBeGreaterThan(paints.paints);
		await freshNotes(['n1']);
		await expectNoErrors();
	});

	it('V17 (V6 carry-over 1) the list scrolls during a real drag while the spot stays the same: the drop line moves with its row; at most one paint per frame', async function () {
		await freshNotes(['n1']);
		const ids = await browser.executeObsidian(async ({ app, obsidian }, paths) => {
			const out: string[] = [];
			for (let i = 0; i < 40; i++) {
				const file = app.vault.getFileByPath(paths[i % paths.length] ?? '');
				if (!(file instanceof obsidian.TFile)) throw new Error('missing');
				const leaf = app.workspace.getLeaf('tab');
				await leaf.openFile(file, { active: false });
				out.push((leaf as unknown as { id: string }).id);
			}
			return out;
		}, Object.values(NOTES));
		await vertical();
		await stripCollapsed(false);
		// The list overflows; start the drag near the top, then scroll the list to the middle.
		const list = async (scrollTo?: number) =>
			browser.execute((to) => {
				const el = document.querySelector<HTMLElement>('.tabstrip-vstrip .tabstrip-vstrip-list');
				if (!el) throw new Error('no list');
				if (to !== null) el.scrollTop = to;
				return { scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight };
			}, scrollTo ?? null);
		const room = await list(0);
		expect(room.max).toBeGreaterThan(200);
		await startRowDrag(ids[1] ?? '');
		await list(150);
		await browser.pause(120);
		// A row in the middle of the visible list; the pointer at 20 % of its height (upper half).
		const mid = await browser.execute(() => {
			const el = document.querySelector<HTMLElement>('.tabstrip-vstrip .tabstrip-vstrip-list');
			if (!el) throw new Error('no list');
			const box = el.getBoundingClientRect();
			const rows = Array.from(el.querySelectorAll<HTMLElement>('.tabstrip-vrow')).filter((r) => {
				const b = r.getBoundingClientRect();
				return b.top > box.top + 80 && b.bottom < box.bottom - 80;
			});
			const row = rows[Math.floor(rows.length / 2)];
			if (!row) throw new Error('no middle row');
			return row.getAttribute('data-tabstrip-leaf') ?? '';
		});
		const at = await itemPoint(`t:${mid}`, 0.2);
		const s0 = (await vstate()).stats;
		await pageFrames(true);
		await dragOver(at, true);
		await browser.pause(60);
		await dragOver(at);
		await browser.pause(120);
		const before = await vstate();
		const rowBefore = await itemPoint(`t:${mid}`, 0);
		if (before.line === null) throw new Error('no drop line before the scroll');
		expect(Math.abs(before.line.y - rowBefore.top)).toBeLessThanOrEqual(2);
		// A real scroll of the list by 5 px, no drag event: the row moves up 5 px, the pointer stays in its
		// upper half (same spot), so only the scroll can move the line.
		const scrolled = await list(room.max > 160 ? 155 : 145);
		await browser.pause(150);
		const after = await vstate();
		const rowAfter = await itemPoint(`t:${mid}`, 0);
		if (after.line === null) throw new Error('no drop line after the scroll');
		expect(Math.abs(rowAfter.top - rowBefore.top)).toBeGreaterThanOrEqual(4);
		expect(Math.abs(after.line.y - rowAfter.top)).toBeLessThanOrEqual(2);
		expect(after.stats.dragScrollRepaints - s0.dragScrollRepaints).toBeGreaterThanOrEqual(1);
		// The same spot again (a dragover at the same place): nothing to paint.
		const p0 = after.stats.dragPaints;
		await dragOver(at);
		await browser.pause(120);
		const again = await vstate();
		expect(again.stats.dragPaints).toBe(p0);
		expect(again.line?.y).toBe(after.line.y);
		const browserFrames = await pageFrames(false);
		await cancelDrag();
		await waitDragEnded();
		const st = (await vstate()).stats;
		const paints = { browserFrames, dragFrames: st.dragFrames - s0.dragFrames, paints: st.dragPaints - s0.dragPaints, offFrame: st.dragPaintsOffFrame - s0.dragPaintsOffFrame, sameFrame: st.dragFramesSameFrame - s0.dragFramesSameFrame };
		record('V17', { mid, scrolled, before: { line: before.line, row: rowBefore.top }, after: { line: after.line, row: rowAfter.top }, scrollRepaints: after.stats.dragScrollRepaints - s0.dragScrollRepaints, paints });
		expect(paints.paints).toBeGreaterThanOrEqual(2);
		expect(paints.paints).toBeLessThanOrEqual(paints.dragFrames);
		expect(paints.dragFrames).toBeLessThanOrEqual(paints.browserFrames);
		expect(paints.sameFrame).toBe(0);
		expect(paints.offFrame).toBe(0);
		expect(await residue()).toEqual(CLEAN);
		await freshNotes(['n1']);
		await expectNoErrors();
	});
});
