/**
 * Step V6: switching between the horizontal tab bar and the vertical strip, and what is left of the
 * vertical strip after the V5 final review.
 *
 * Switching (requirements 5.2 "切换方向"): the command keeps groups, pinned tabs, collapsed groups,
 * the tab order, the active tab and the editor focus; the layout JSON and workspace.json do not
 * change; no frame shows both tab bars or neither (frames sampled before each paint, with positive
 * controls), in both directions, with a drag open, with the icon bar's hover overlay open, with the
 * rename bubble open and with a pop-out open; the orientation survives a restart in both
 * directions; "Restore native tab bar" and disable / enable work from either orientation.
 *
 * Also: stacked panes in vertical mode (V5 final review item 3: why there is no left / right split),
 * and the development-only seed plugin behind `npm run try -- --vertical`.
 *
 * Commands run through app.commands.executeCommandById inside the page, like a hotkey: nothing moves
 * the focus on the way (no command palette). Drags start with real pointer input with Chromium's drag
 * interception on (test/e2e/drag.ts).
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run).
 */
import { $, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cancelDrag, dragOver, dropAt, enableDrags, startDrag, startRowDrag, type Point } from '../drag';
import {
	bubbleGeometry,
	closePopout,
	commandAvailable,
	errorTimeline,
	makeGroup,
	NOTES,
	openNotes,
	openPopoutLeafWithNotes,
	pageState,
	record,
	repoRoot,
	residue,
	runCommand,
	shot,
	setActive,
	setPinned,
	startErrorWatch,
	waitForState,
	waitForMenu,
	warmUpPopouts,
	withWarmPopout,
	writeEvidence,
} from '../helpers';

const PROBE = 'e2e-startup-log-probe';
const SEED = 'tabstrip-try-seed';
const KEY = 'tabstrip-session-v1';
const CMD = {
	toggle: 'tabstrip:toggle-vertical-tabs',
	collapseStrip: 'tabstrip:toggle-vertical-strip-collapsed',
	restoreNative: 'tabstrip:restore-native-tab-bar',
	show: 'tabstrip:show-tab-groups',
	rename: 'tabstrip:rename-group',
} as const;

// ---------------------------------------------------------------- page reads

/** Everything a switch must keep: the group model, the tabs, the active tab, the focus, the layout. */
interface Model {
	orientation: string;
	groups: { id: string; name: string; color: string; collapsed: boolean; members: string[] }[];
	panes: { ids: string[]; pinned: boolean[]; current: string | null; stacked: boolean }[];
	activeId: string | null;
	/** Where the keyboard focus is: 'editor' (the active note's editor), 'strip', 'chip', 'bubble', 'body' or a tag. */
	focus: string;
	cursor: { line: number; ch: number } | null;
	layout: string;
}

async function model(): Promise<Model> {
	return browser.executeObsidian(({ app, obsidian }) => {
		type Tabs = { children: { id: string; getViewState(): { pinned?: boolean } }[]; currentTab: number; isStacked?: boolean };
		const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { orientation(): string; flush(): void; state(): { groups: { id: string; name: string; color: string; collapsed: boolean }[]; members: { leafId: string; groupId: string }[] } } } | undefined> } }).plugins.plugins['tabstrip'];
		if (!p) throw new Error('tabstrip not loaded');
		p.debug.flush();
		const st = p.debug.state();
		const tabsList: Tabs[] = [];
		app.workspace.iterateRootLeaves((leaf) => {
			const parent = leaf.parent as unknown as Tabs;
			if (!tabsList.includes(parent)) tabsList.push(parent);
		});
		const panes = tabsList.map((t) => ({
			ids: t.children.map((l) => l.id),
			pinned: t.children.map((l) => l.getViewState().pinned === true),
			current: t.children[t.currentTab]?.id ?? null,
			stacked: t.isStacked === true,
		}));
		const order = panes.flatMap((x) => x.ids);
		const groups = st.groups.map((g) => ({
			id: g.id,
			name: g.name,
			color: g.color,
			collapsed: g.collapsed,
			members: st.members
				.filter((m) => m.groupId === g.id)
				.map((m) => m.leafId)
				.sort((a, b) => order.indexOf(a) - order.indexOf(b)),
		}));
		const el = document.activeElement;
		const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
		const focus =
			el === null || el === document.body
				? 'body'
				: view !== null && view.contentEl.contains(el) && el.closest('.cm-content') !== null
					? 'editor'
					: el.closest('.tabstrip-vstrip') !== null
						? 'strip'
						: el.closest('.tabstrip-chip') !== null
							? 'chip'
							: el.closest('.tabstrip-editor') !== null
								? 'bubble'
								: `${el.tagName.toLowerCase()}.${String(el.className)}`;
		const cursor = view?.editor.getCursor() ?? null;
		return {
			orientation: p.debug.orientation(),
			groups,
			panes,
			activeId: (app.workspace as unknown as { activeLeaf: { id: string } | null }).activeLeaf?.id ?? null,
			focus,
			cursor: cursor === null ? null : { line: cursor.line, ch: cursor.ch },
			layout: JSON.stringify(app.workspace.getLayout()),
		};
	});
}

/** The model without the orientation (what a switch must keep). */
const kept = (m: Model) => ({ groups: m.groups, panes: m.panes, activeId: m.activeId, focus: m.focus, cursor: m.cursor, layout: m.layout });

/** workspace.json as Obsidian writes it now (its save runs first). */
async function workspaceJson(): Promise<string> {
	return browser.executeObsidian(async ({ app }) => {
		await app.workspace.requestSaveLayout.run();
		return app.vault.adapter.read(`${app.vault.configDir}/workspace.json`);
	});
}

interface StripView {
	mounted: boolean;
	cls: boolean;
	collapsed: boolean;
	peek: boolean;
	/** Shown native tab header rows of the root split. */
	native: number;
	chips: number;
	rows: string[];
}

async function view(): Promise<StripView> {
	return browser.executeObsidian(({ app }) => {
		const ws = app.workspace.containerEl;
		const strip = ws.querySelector<HTMLElement>(':scope > .tabstrip-vstrip');
		const root = (app.workspace.rootSplit as unknown as { containerEl: HTMLElement }).containerEl;
		return {
			mounted: strip !== null,
			cls: ws.classList.contains('tabstrip-vertical'),
			collapsed: strip?.classList.contains('is-collapsed') ?? false,
			peek: strip?.classList.contains('is-peek') ?? false,
			native: Array.from(root.querySelectorAll<HTMLElement>('.workspace-tabs > .workspace-tab-header-container')).filter((c) => c.offsetHeight > 0 && getComputedStyle(c).visibility !== 'hidden').length,
			chips: Array.from(root.querySelectorAll<HTMLElement>('.tabstrip-chip')).filter((c) => c.offsetWidth > 0).length,
			rows: Array.from(strip?.querySelectorAll('.tabstrip-vrow') ?? []).map((r) => r.getAttribute('data-tabstrip-leaf') ?? ''),
		};
	});
}

async function waitView(ok: (v: StripView) => boolean, what: string, timeout = 5000): Promise<StripView> {
	let last = await view();
	const start = Date.now();
	while (!ok(last)) {
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${what}\nlast: ${JSON.stringify(last)}`);
		await browser.pause(60);
		last = await view();
	}
	return last;
}

const isVertical = (v: StripView) => v.mounted && v.cls && v.native === 0 && v.rows.length > 0;
const isHorizontal = (v: StripView) => !v.mounted && !v.cls && v.native > 0;

async function toggle(want: 'vertical' | 'horizontal'): Promise<StripView> {
	if ((await orientation()) === want) throw new Error(`already ${want}: a switch case must start from the other orientation`);
	expect(await runCommand(CMD.toggle)).toBe(true);
	return waitView(want === 'vertical' ? isVertical : isHorizontal, `switched to ${want}`);
}

async function orientation(): Promise<string> {
	return browser.executeObsidian(({ app }) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { orientation(): string } } | undefined> } }).plugins.plugins['tabstrip'];
		return p?.debug.orientation() ?? 'none';
	});
}

async function storedOrientation(): Promise<string | null> {
	return browser.executeObsidian(({ app }, key) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { flushSave(): void } } | undefined> } }).plugins.plugins['tabstrip'];
		p?.debug.flushSave();
		const rec = app.loadLocalStorage(key) as { orientation?: string } | null;
		return rec?.orientation ?? null;
	}, KEY);
}

/** Focuses the active note's editor and puts the cursor at (line, ch). */
async function focusEditor(line: number, ch: number): Promise<void> {
	await browser.executeObsidian(
		({ app, obsidian }, l, c) => {
			const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			if (!v) throw new Error('no active markdown view');
			v.editor.focus();
			v.editor.setCursor({ line: l, ch: c });
		},
		line,
		ch,
	);
	await browser.pause(80);
}

// ---------------------------------------------------------------- frame sampler

interface SampleReport {
	frames: number;
	bad: { frame: number; bad: string; strip: boolean; cls: boolean; native: number }[];
	withStrip: number;
	withNative: number;
	/** Frames in which the strip's rows were not the root split's tabs (stale rows). */
	rowMismatch: number;
	errors: string[];
}

/**
 * Samples every frame before it is painted with the probe plugin's check (a frame is bad when the
 * strip and its class disagree, when the strip shows next to native tab rows, or when neither shows
 * while the root split has tabs).
 */
async function startSampler(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		type St = { strip: boolean; cls: boolean; native: number; tabs: number; rows: number; bad: string | null };
		const w = window as unknown as { __tabstripVFrameState?: (a: unknown) => St; __v6Sampler?: { on: boolean; rep: SampleReport } };
		const state = w.__tabstripVFrameState;
		if (!state) throw new Error('probe frame state missing');
		const rep: SampleReport = { frames: 0, bad: [], withStrip: 0, withNative: 0, rowMismatch: 0, errors: [] };
		const s = { on: true, rep };
		w.__v6Sampler = s;
		type Tabs = { children: { id: string }[] };
		const rootIds = (): string[] => {
			const root = app.workspace.rootSplit as unknown as { containerEl: HTMLElement };
			if (!root.containerEl.isConnected) return [];
			const tabsList: Tabs[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				const parent = leaf.parent as unknown as Tabs;
				if (!tabsList.includes(parent)) tabsList.push(parent);
			});
			return tabsList.flatMap((t) => t.children.map((l) => l.id));
		};
		const frame = () => {
			if (!s.on) return;
			rep.frames++;
			try {
				const st = state(app);
				if (st.strip) rep.withStrip++;
				if (st.native > 0) rep.withNative++;
				if (st.bad !== null && rep.bad.length < 50) rep.bad.push({ frame: rep.frames, bad: st.bad, strip: st.strip, cls: st.cls, native: st.native });
				if (st.strip) {
					// The rows are the root split's tabs in order, minus members of collapsed groups (hidden):
					// every row is a root tab, in root order, and every root tab outside a collapsed group has a row.
					const rows = Array.from(app.workspace.containerEl.querySelectorAll(':scope > .tabstrip-vstrip .tabstrip-vrow')).map((r) => r.getAttribute('data-tabstrip-leaf') ?? '');
					const root = rootIds();
					const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { state(): { groups: { id: string; collapsed: boolean }[]; members: { leafId: string; groupId: string }[] } } } | undefined> } }).plugins.plugins['tabstrip'];
					const model = p?.debug.state();
					const collapsed = new Set((model?.groups ?? []).filter((g) => g.collapsed).map((g) => g.id));
					const hideable = new Set((model?.members ?? []).filter((m) => collapsed.has(m.groupId)).map((m) => m.leafId));
					let at = -1;
					const inOrder = rows.every((id) => {
						const i = root.indexOf(id, at + 1);
						if (i < 0) return false;
						at = i;
						return true;
					});
					const complete = root.every((id) => hideable.has(id) || rows.includes(id));
					if (!inOrder || !complete) rep.rowMismatch++;
				}
			} catch (e) {
				if (rep.errors.length < 20) rep.errors.push(String(e));
			}
			window.requestAnimationFrame(frame);
		};
		window.requestAnimationFrame(frame);
	});
	// A few frames of the state before whatever comes next (positive control: both states are seen).
	await browser.pause(100);
}

async function stopSampler(): Promise<SampleReport> {
	await browser.pause(150);
	return browser.execute(() => {
		const s = (window as unknown as { __v6Sampler?: { on: boolean; rep: SampleReport } }).__v6Sampler;
		if (!s) throw new Error('no sampler');
		s.on = false;
		return s.rep;
	});
}

/**
 * The sampler measured (positive control: many frames, both tab bars seen when `both`), no frame was
 * bad, and the strip's rows were the root split's tabs in every frame that showed it.
 */
function expectFrames(rep: SampleReport, both: boolean): void {
	expect(rep.errors).toEqual([]);
	expect(rep.frames).toBeGreaterThan(5);
	if (both) {
		expect(rep.withStrip).toBeGreaterThan(0);
		expect(rep.withNative).toBeGreaterThan(0);
	}
	expect(rep.bad).toEqual([]);
	expect(rep.rowMismatch).toBe(0);
}

/** A switch with the sampler on; returns the frames. */
async function sampledToggle(want: 'vertical' | 'horizontal'): Promise<SampleReport> {
	await startSampler();
	await browser.pause(100);
	await toggle(want);
	await browser.pause(150);
	return stopSampler();
}

/**
 * Positive control: a test style breaks the tab bars for three frames (hides the native rows in
 * horizontal mode, shows them next to the strip in vertical mode); the sampler must report it.
 */
async function breakFrames(kind: 'neither' | 'both'): Promise<void> {
	await browser.execute(async (k) => {
		const style = document.createElement('style');
		style.textContent =
			k === 'neither'
				? '.workspace > .workspace-split.mod-root .workspace-tabs > .workspace-tab-header-container { display: none !important; }'
				: '.workspace.tabstrip-vertical > .workspace-split.mod-root .workspace-tabs > .workspace-tab-header-container { display: flex !important; }';
		const frame = () => new Promise((r) => window.requestAnimationFrame(r));
		await frame();
		document.head.appendChild(style);
		for (let i = 0; i < 3; i++) await frame();
		style.remove();
		await frame();
	}, kind);
}

// ---------------------------------------------------------------- set-up

async function plugin<T>(fn: string, ...args: unknown[]): Promise<T> {
	return browser.executeObsidian(
		({ app }, name, rest) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { debug: Record<string, (...a: unknown[]) => unknown> } | undefined> } }).plugins.plugins['tabstrip'];
			if (!p) throw new Error('tabstrip not loaded');
			const f = p.debug[name];
			if (typeof f !== 'function') throw new Error(`no debug.${name}`);
			return f(...rest) as T;
		},
		fn,
		args,
	);
}

/** Removes every group (test reset). */
async function ungroupAll(): Promise<void> {
	const s = await pageState();
	for (const g of s.state.groups) {
		await browser.executeObsidian(({ app }, gid) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { controller?: { ungroup?(id: string): void } } | undefined> } }).plugins.plugins['tabstrip'];
			p?.controller?.ungroup?.(gid);
		}, g.id);
	}
}

/**
 * The scene of the switch cases: eight notes in one pane, n1 pinned, groups A [n2, n3] (blue),
 * B [n4, n5] (collapsed), C [n6, n7]; n8 active with the cursor in its editor.
 */
async function scene(): Promise<Record<'n1' | 'n2' | 'n3' | 'n4' | 'n5' | 'n6' | 'n7' | 'n8', string>> {
	// Every case starts horizontal, whatever the case before left behind.
	if ((await orientation()) === 'vertical') await toggle('horizontal');
	await ungroupAll();
	const ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
	await setPinned(ids.n1, true);
	await waitForState((s) => s.strips.some((x) => x.kind === 'main' && x.pinned[0] === true), 'n1 pinned');
	await makeGroup([ids.n2, ids.n3], 'Alpha 甲', 'blue');
	const b = await makeGroup([ids.n4, ids.n5], 'Beta 乙', 'red');
	await makeGroup([ids.n6, ids.n7], 'Gamma 丙', 'green');
	await setActive(ids.n8);
	expect(await plugin<boolean>('setCollapsed', b, true)).toBe(true);
	await waitForState((s) => s.state.groups.some((g) => g.id === b && g.collapsed), 'B collapsed');
	await focusEditor(0, 3);
	return ids;
}

async function expectNoErrors(): Promise<void> {
	expect(await errorTimeline()).toEqual([]);
}

/** Native drag leftovers and the strip's own (line, highlight, dimmed rows). */
async function dragResidue(): Promise<Record<string, number | boolean>> {
	return browser.execute(() => ({
		line: document.querySelectorAll('.tabstrip-vdrop-line.is-shown').length,
		join: document.querySelectorAll('.tabstrip-vdrop-join').length,
		dragging: document.querySelectorAll('.tabstrip-vrow.is-dragging').length,
		highlight: document.querySelectorAll('.tabstrip-drop-target, .tabstrip-drop-chip').length,
		ghost: document.querySelectorAll('.drag-ghost').length,
		fake: document.querySelectorAll('.workspace-fake-target-overlay, .workspace-fake-target-container').length,
		grabbing: document.body.classList.contains('is-grabbing'),
		// Review round 2: the host classes that give stacked panes their drop band during a drag.
		band: document.querySelectorAll('.tabstrip-vdragging, .tabstrip-vdrag-any').length,
	}));
}

const NO_DRAG = { line: 0, join: 0, dragging: 0, highlight: 0, ghost: 0, fake: 0, grabbing: false, band: 0 };

async function rowPoint(leafId: string, fy = 0.5): Promise<Point> {
	return browser.execute(
		(id, f) => {
			const el = document.querySelector(`.tabstrip-vstrip .tabstrip-vrow[data-tabstrip-leaf="${id}"]`);
			if (!el) throw new Error(`no row ${id}`);
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height * f) };
		},
		leafId,
		fy,
	);
}

async function headerPoint(leafId: string): Promise<Point> {
	return browser.execute((id) => {
		const el = document.querySelector(`.workspace-tab-header[data-e2e-leaf="${id}"]`);
		if (!el) throw new Error(`no header ${id}`);
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width * 0.7), y: Math.round(r.top + r.height / 2) };
	}, leafId);
}

async function restart(plugins: string[] = ['tabstrip', PROBE]): Promise<void> {
	await browser.executeObsidian(async ({ app }) => {
		await app.workspace.requestSaveLayout.run();
	});
	await storedOrientation();
	await browser.reloadObsidian({ plugins });
	await startErrorWatch();
	await browser.waitUntil(async () => browser.executeObsidian(({ app }) => (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins['tabstrip'] !== undefined && app.workspace.layoutReady), { timeout: 20000, timeoutMsg: 'tabstrip did not load after the restart' });
	await browser.pause(800);
	await enableDrags();
}

interface StartFrames {
	storedVertical: boolean;
	frames: number;
	firstStripFrame: number | null;
	nativeFrames: number;
	bad: unknown[];
	errors: number;
}

async function startFrames(): Promise<StartFrames | null> {
	return browser.execute(() => (window as unknown as { __tabstripVFrames?: StartFrames }).__tabstripVFrames ?? null);
}

describe('V6 switching orientation, and the vertical strip after V5', function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
		});
		await startErrorWatch();
		const warm = await warmUpPopouts();
		await enableDrags();
		record('v6-setup', { warm, obsidian: browser.getObsidianVersion() });
	});

	after(function () {
		writeEvidence('v6-switch');
	});

	it('S0 positive controls: the frame sampler reports a frame with neither tab bar and a frame with both', async function () {
		await openNotes(['n1', 'n2', 'n3']);
		expect(isHorizontal(await view())).toBe(true);
		await startSampler();
		await breakFrames('neither');
		const neither = await stopSampler();
		await toggle('vertical');
		await startSampler();
		await breakFrames('both');
		const both = await stopSampler();
		await toggle('horizontal');
		record('S0', { neither: { frames: neither.frames, bad: neither.bad.length, kinds: [...new Set(neither.bad.map((b) => b.bad))] }, both: { frames: both.frames, bad: both.bad.length, kinds: [...new Set(both.bad.map((b) => b.bad))] } });
		expect(neither.bad.length).toBeGreaterThanOrEqual(2);
		expect(new Set(neither.bad.map((b) => b.bad))).toEqual(new Set(['no-tab-ui']));
		expect(both.bad.length).toBeGreaterThanOrEqual(2);
		expect(new Set(both.bad.map((b) => b.bad))).toEqual(new Set(['strip-and-native']));
		await expectNoErrors();
	});

	it('S1 both directions keep groups, pinned, collapsed, order, active tab, editor focus and cursor; layout and workspace.json unchanged; no bad frame', async function () {
		const ids = await scene();
		const m0 = await model();
		const ws0 = await workspaceJson();
		expect(m0.orientation).toBe('horizontal');
		expect(m0.focus).toBe('editor');
		expect(m0.cursor).toEqual({ line: 0, ch: 3 });
		expect(m0.activeId).toBe(ids.n8);
		expect(m0.groups.map((g) => [g.name, g.collapsed, g.members.length])).toEqual([
			['Alpha 甲', false, 2],
			['Beta 乙', true, 2],
			['Gamma 丙', false, 2],
		]);
		expect(m0.panes[0]?.pinned[0]).toBe(true);

		const toV = await sampledToggle('vertical');
		const m1 = await model();
		const ws1 = await workspaceJson();
		expect(m1.orientation).toBe('vertical');
		expect(kept(m1)).toEqual(kept(m0));
		expect(ws1).toBe(ws0);
		expectFrames(toV, true);
		// In the strip: the pinned area, the three group rows, B's members hidden.
		const v = await view();
		expect(v.rows).toEqual([ids.n1, ids.n2, ids.n3, ids.n6, ids.n7, ids.n8]);
		expect(await storedOrientation()).toBe('vertical');

		const toH = await sampledToggle('horizontal');
		const m2 = await model();
		const ws2 = await workspaceJson();
		expect(m2.orientation).toBe('horizontal');
		expect(kept(m2)).toEqual(kept(m0));
		expect(ws2).toBe(ws0);
		expectFrames(toH, true);
		const h = await view();
		expect(h.chips).toBe(3);
		// B is collapsed again on the horizontal bar: its members' headers are hidden behind its chip (width 0).
		const widths = await browser.executeObsidian(
			({ app }, a, b) => [a, b].map((id) => (app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement } | null)?.tabHeaderEl.getBoundingClientRect().width ?? -1),
			ids.n4,
			ids.n5,
		);
		expect(widths[0]).toBe(0);
		expect(widths[1]).toBeLessThanOrEqual(1);
		expect(await storedOrientation()).toBeNull();
		record('S1', { toV: { frames: toV.frames, withStrip: toV.withStrip, withNative: toV.withNative }, toH: { frames: toH.frames, withStrip: toH.withStrip, withNative: toH.withNative }, workspaceJsonBytes: ws0.length, focus: m2.focus, cursor: m2.cursor });
		await expectNoErrors();
	});

	it('S2 the keyboard focus on a strip row or on a chip that the switch removes goes to the active note, not to nothing', async function () {
		const ids = await scene();
		await toggle('vertical');
		await browser.executeObsidian(({ app }, id) => {
			const row = app.workspace.containerEl.querySelector<HTMLElement>(`.tabstrip-vstrip .tabstrip-vrow[data-tabstrip-leaf="${id}"]`);
			if (!row) throw new Error('no row');
			row.focus();
		}, ids.n3);
		expect((await model()).focus).toBe('strip');
		await toggle('horizontal');
		const a = await model();
		expect(a.focus).toBe('editor');
		expect(a.activeId).toBe(ids.n8);
		// A focused chip (horizontal) disappears from the hidden header row in vertical mode.
		await browser.execute((sel) => {
			const chip = document.querySelector<HTMLElement>(sel);
			if (!chip) throw new Error('no chip');
			chip.focus();
		}, '.workspace-split.mod-root .tabstrip-chip');
		expect((await model()).focus).toBe('chip');
		await toggle('vertical');
		const b = await model();
		expect(b.focus).toBe('editor');
		expect(b.activeId).toBe(ids.n8);
		await toggle('horizontal');
		record('S2', { afterRow: a.focus, afterChip: b.focus });
		await expectNoErrors();
	});

	it('S3 with a drag in progress: the switch waits for the drag; a cancelled drag leaves nothing and moves nothing, in both directions; a drop is applied before the switch', async function () {
		const ids = await scene();
		const m0 = await model();
		// Vertical, a row drag over the strip with the drop line shown; the toggle comes in the middle.
		await toggle('vertical');
		await startSampler();
		await startRowDrag(ids.n3);
		const over = await rowPoint(ids.n7, 0.3);
		await dragOver(over, true);
		await browser.pause(60);
		await dragOver(over);
		await browser.pause(100);
		expect(await runCommand(CMD.toggle)).toBe(true);
		await browser.pause(150);
		const during = await view();
		expect(isVertical(during)).toBe(true);
		expect((await dragResidue()).line).toBe(1);
		await cancelDrag();
		const afterV = await waitView(isHorizontal, 'switched after the cancelled drag');
		await browser.pause(200);
		const framesV = await stopSampler();
		expect(afterV.chips).toBe(3);
		expect(await dragResidue()).toEqual(NO_DRAG);
		const m1 = await model();
		expect(m1.groups).toEqual(m0.groups);
		expect(m1.panes).toEqual(m0.panes);
		expectFrames(framesV, true);

		// Horizontal, a native tab header drag (Obsidian's own drag, followed by the drag watcher).
		await pageState(); // marks the headers (data-e2e-leaf)
		await startSampler();
		await startDrag(ids.n3);
		const target = await headerPoint(ids.n6);
		await dragOver(target, true);
		await browser.pause(60);
		await dragOver(target);
		await browser.pause(100);
		expect(await runCommand(CMD.toggle)).toBe(true);
		await browser.pause(150);
		expect(isHorizontal(await view())).toBe(true);
		await cancelDrag();
		await waitView(isVertical, 'switched after the cancelled header drag');
		await browser.pause(200);
		const framesH = await stopSampler();
		expect(await dragResidue()).toEqual(NO_DRAG);
		const m2 = await model();
		expect(m2.groups).toEqual(m0.groups);
		expect(m2.panes).toEqual(m0.panes);
		expectFrames(framesH, true);

		// Vertical again: toggled during a drag that is then dropped on the strip (n8 into Gamma, after n6).
		const drops0 = (await pageState()).stats.drops.length;
		await startRowDrag(ids.n8);
		const into = await rowPoint(ids.n6, 0.7);
		await dragOver(into, true);
		await browser.pause(60);
		await dragOver(into);
		await browser.pause(100);
		expect(await runCommand(CMD.toggle)).toBe(true);
		await dropAt(into);
		await waitView(isHorizontal, 'switched after the drop');
		const s = await waitForState((x) => x.stats.drops.length > drops0 && x.stats.drops.at(-1)?.fate !== 'pending', 'drop handled');
		const gamma = s.state.groups.find((g) => g.name === 'Gamma 丙');
		const members = s.state.members.filter((m) => m.groupId === gamma?.id).map((m) => m.leafId);
		expect(members).toContain(ids.n8);
		expect(s.stats.drops.at(-1)?.fate).toBe('used');
		expect(await dragResidue()).toEqual(NO_DRAG);
		record('S3', { vertical: { frames: framesV.frames }, horizontal: { frames: framesH.frames }, drop: s.stats.drops.at(-1) });
		await expectNoErrors();
	});

	it('S4 with the icon bar\'s hover overlay open: both directions are clean and the icon bar comes back closed', async function () {
		const ids = await scene();
		await toggle('vertical');
		expect(await runCommand(CMD.collapseStrip)).toBe(true);
		await waitView((v) => v.collapsed, 'icon bar');
		const p = await rowPoint(ids.n2);
		await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: 20, y: p.y, origin: 'viewport', duration: 30 }).perform();
		await waitView((v) => v.peek, 'overlay open');
		const m0 = await model();
		await startSampler();
		await toggle('horizontal');
		await browser.pause(200);
		const toH = await stopSampler();
		expectFrames(toH, true);
		expect((await residue()).found.filter((f) => f.includes('vstrip') || f.includes('vrow') || f.includes('tabstrip-vertical'))).toEqual([]);
		await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: 700, y: 400, origin: 'viewport', duration: 30 }).perform();
		const toV = await sampledToggle('vertical');
		expectFrames(toV, true);
		const v = await view();
		expect(v.collapsed).toBe(true);
		expect(v.peek).toBe(false);
		expect((await model()).groups).toEqual(m0.groups);
		expect(await runCommand(CMD.collapseStrip)).toBe(true);
		await waitView((x) => !x.collapsed, 'expanded');
		await toggle('horizontal');
		record('S4', { toH: toH.frames, toV: toV.frames });
		await expectNoErrors();
	});

	it('S5 with the rename bubble open: it moves to the chip (horizontal) or the group row (vertical), keeps the typed text and the focus, and commits', async function () {
		const ids = await scene();
		await toggle('vertical');
		await setActive(ids.n2);
		expect(await runCommand(CMD.rename)).toBe(true);
		let s = await waitForState((x) => x.editor.open && x.editor.inputFocused, 'bubble open');
		const gid = s.editor.groupId ?? '';
		await browser.keys(['Delete']);
		await browser.keys('Renamed');
		await startSampler();
		await toggle('horizontal');
		await browser.pause(200);
		const toH = await stopSampler();
		expectFrames(toH, true);
		s = await pageState();
		expect(s.editor.open).toBe(true);
		expect(s.editor.inputFocused).toBe(true);
		expect(s.editor.value).toBe('Renamed');
		const atChip = await bubbleGeometry(gid);
		expect(atChip.chip?.width ?? 0).toBeGreaterThan(0);
		expect(Math.abs((atChip.bubble?.left ?? -99) - (atChip.chip?.left ?? 0))).toBeLessThanOrEqual(1);
		await browser.keys(' 2');
		const toV = await sampledToggle('vertical');
		expectFrames(toV, true);
		s = await pageState();
		expect(s.editor.open).toBe(true);
		expect(s.editor.inputFocused).toBe(true);
		expect(s.editor.value).toBe('Renamed 2');
		const row = await browser.execute((g) => {
			const el = document.querySelector(`.tabstrip-vstrip [data-tabstrip-item="g:${g}"]`);
			const b = document.querySelector('.tabstrip-editor');
			if (!el || !b) return null;
			const r = el.getBoundingClientRect();
			const q = b.getBoundingClientRect();
			return { rowBottom: r.bottom, rowLeft: r.left, bubbleTop: q.top, bubbleLeft: q.left };
		}, gid);
		if (row === null) throw new Error('no group row or bubble');
		expect(row.bubbleTop - row.rowBottom).toBeGreaterThanOrEqual(-1);
		expect(row.bubbleTop - row.rowBottom).toBeLessThanOrEqual(12);
		await browser.keys(['Enter']);
		s = await waitForState((x) => !x.editor.open, 'bubble closed');
		expect(s.state.groups.find((g) => g.id === gid)?.name).toBe('Renamed 2');
		await toggle('horizontal');
		record('S5', { atChip: { bubble: atChip.bubble, chip: atChip.chip }, row });
		await expectNoErrors();
	});

	it('S6 with a pop-out open: the main window switches, the pop-out keeps its horizontal bar and its group chip; nothing else changes', async function () {
		const ids = await scene();
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n10, NOTES.n11]));
		const [p1, p2] = pop;
		if (!p1 || !p2) throw new Error('pop-out leaves');
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 3), 'pop-out ready');
		const pg = await makeGroup([p1, p2], 'Pop 弹', 'purple');
		await setActive(ids.n8);
		await focusEditor(0, 2);
		const m0 = await model();
		const chipsInPopout = async () =>
			browser.executeObsidian(({ app }, id) => {
				const doc = app.workspace.getLeafById(id)?.getContainer().doc;
				if (!doc || doc === document) return -1;
				return Array.from(doc.querySelectorAll<HTMLElement>('.tabstrip-chip')).filter((c) => c.offsetWidth > 0).length + (doc.querySelector('.tabstrip-vstrip') ? 100 : 0);
			}, p1);
		expect(await chipsInPopout()).toBe(1);
		const toV = await sampledToggle('vertical');
		expectFrames(toV, true);
		expect(await chipsInPopout()).toBe(1);
		const m1 = await model();
		expect(kept(m1)).toEqual(kept(m0));
		const toH = await sampledToggle('horizontal');
		expectFrames(toH, true);
		expect(await chipsInPopout()).toBe(1);
		expect(kept(await model())).toEqual(kept(m0));
		const s = await pageState();
		expect(s.state.groups.find((g) => g.id === pg)).toBeDefined();
		await closePopout(p1);
		await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, { timeout: 5000, timeoutMsg: 'pop-out did not close' });
		record('S6', { toV: toV.frames, toH: toH.frames });
		await expectNoErrors();
	});

	it('S7 "Restore native tab bar" and disable / enable from either orientation', async function () {
		const ids = await scene();
		const m0 = await model();
		const strip = async () => browser.executeObsidian(({ app }) => app.workspace.containerEl.querySelector(':scope > .tabstrip-vstrip') !== null);
		const leftovers = async () => (await residue()).found;
		const focusAfterNative: string[] = [];
		for (const start of ['horizontal', 'vertical'] as const) {
			if ((await orientation()) !== start) await toggle(start);
			// Review round 1: the keyboard focus sits on a strip row (vertical) or a chip (horizontal), as
			// after keyboard navigation; restoring the native tab bar removes it, the focus goes to the note.
			const activeBefore = (await model()).activeId;
			if (start === 'vertical') {
				await browser.executeObsidian(({ app }, id) => {
					const row = app.workspace.containerEl.querySelector<HTMLElement>(`.tabstrip-vstrip .tabstrip-vrow[data-tabstrip-leaf="${id}"]`);
					if (!row) throw new Error('no row');
					row.focus();
				}, ids.n3);
				expect((await model()).focus).toBe('strip');
			} else {
				await browser.execute((sel) => {
					const chip = document.querySelector<HTMLElement>(sel);
					if (!chip) throw new Error('no chip');
					chip.focus();
				}, '.workspace-split.mod-root .tabstrip-chip');
				expect((await model()).focus).toBe('chip');
			}
			// Restore native: no strip, no chip, no mark; the toggle command is not available meanwhile.
			await startSampler();
			expect(await runCommand(CMD.restoreNative)).toBe(true);
			await waitView((v) => !v.mounted && v.native > 0 && v.chips === 0, 'native tab bar');
			const nativeFrames = await stopSampler();
			const afterNative = await model();
			expect(afterNative.focus).toBe('editor');
			expect(afterNative.activeId).toBe(activeBefore);
			focusAfterNative.push(afterNative.focus);
			expectFrames(nativeFrames, start === 'vertical');
			expect(await leftovers()).toEqual([]);
			expect(await commandAvailable(CMD.toggle)).toBe(false);
			// Show again: the same orientation as before, groups as before.
			expect(await runCommand(CMD.show)).toBe(true);
			await waitView(start === 'vertical' ? isVertical : (v) => isHorizontal(v) && v.chips === 3, `${start} again`);
			expect(await orientation()).toBe(start);
			// "Restore native tab bar" expands every group first (L5: nothing may stay hidden without the
			// chips); names, colours and members are kept.
			expect((await model()).groups).toEqual(m0.groups.map((g) => ({ ...g, collapsed: false })));
			// Disable: everything goes; enable: the same orientation and groups come back.
			await browser.executeObsidian(async ({ app }) => {
				await (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins.disablePlugin('tabstrip');
			});
			await browser.pause(300);
			expect(await strip()).toBe(false);
			expect(await leftovers()).toEqual([]);
			await browser.executeObsidian(async ({ app }) => {
				await (app as unknown as { plugins: { enablePlugin(id: string): Promise<void> } }).plugins.enablePlugin('tabstrip');
			});
			await browser.waitUntil(async () => (await orientation()) === start, { timeout: 10000, timeoutMsg: 'enabled again' });
			await waitView(start === 'vertical' ? isVertical : (v) => isHorizontal(v) && v.chips === 3, `${start} after enable`, 10000);
			const back = await model();
			expect(back.groups.map((g) => [g.name, g.color, g.members])).toEqual(m0.groups.map((g) => [g.name, g.color, g.members]));
			await startErrorWatch();
		}
		await toggle('horizontal');
		expect(ids.n1).toBeTruthy();
		record('S7', { focusAfterNative });
		await expectNoErrors();
	});

	it('S8 the orientation survives a restart in both directions; no bad start-up frame either way', async function () {
		const ids = await scene();
		const m0 = await model();
		await toggle('vertical');
		await restart();
		const fv = await startFrames();
		expect(await orientation()).toBe('vertical');
		const v = await waitView(isVertical, 'vertical after restart');
		expect(v.rows).toContain(ids.n2);
		expect(fv?.storedVertical).toBe(true);
		expect(fv?.bad).toEqual([]);
		expect(fv?.nativeFrames).toBe(0);
		const mv = await model();
		expect(mv.groups.map((g) => [g.name, g.collapsed, g.members])).toEqual(m0.groups.map((g) => [g.name, g.collapsed, g.members]));
		await toggle('horizontal');
		await restart();
		const fh = await startFrames();
		expect(await orientation()).toBe('horizontal');
		await waitView((x) => isHorizontal(x) && x.chips === 3, 'horizontal after restart');
		expect(fh?.storedVertical).toBe(false);
		expect(fh?.bad).toEqual([]);
		expect(fh?.firstStripFrame).toBeNull();
		const mh = await model();
		expect(mh.groups.map((g) => [g.name, g.collapsed, g.members])).toEqual(m0.groups.map((g) => [g.name, g.collapsed, g.members]));
		record('S8', { vertical: fv, horizontal: fh });
		await expectNoErrors();
	});

	it('S9 stacked panes (V5 final review item 3, review round 2): Obsidian splits a stacked pane left / right only with the pointer in its tab header row; during any drag that hidden row gets an invisible box one row high, so the drop zones match the horizontal tab bar', async function () {
		await scene();
		await ungroupAll();
		const all = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'] as const;
		// The tabs of the one stacked pane; new leaves after every reset.
		let cur = await openNotes(all);
		const stack = async (on: boolean) => {
			await browser.executeObsidian(
				({ app }, id, value) => {
					const leaf = app.workspace.getLeafById(id) as unknown as { parent: { setStacked(v: boolean): void } } | null;
					leaf?.parent.setStacked(value);
				},
				cur.n8,
				on,
			);
			await browser.pause(300);
		};
		const geometry = async () =>
			browser.executeObsidian(({ app }, id) => {
				const leaf = app.workspace.getLeafById(id) as unknown as { parent: { containerEl: HTMLElement; tabHeaderContainerEl: HTMLElement } } | null;
				if (!leaf) throw new Error('no leaf');
				const box = (el: Element) => {
					const r = el.getBoundingClientRect();
					return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
				};
				const hc = leaf.parent.tabHeaderContainerEl;
				const pane = box(leaf.parent.containerEl);
				const hit = (x: number, y: number) => {
					const el = document.elementFromPoint(x, y);
					return el !== null && hc.contains(el);
				};
				const cs = getComputedStyle(hc);
				const ws = app.workspace.containerEl.classList;
				return {
					pane,
					header: box(hc),
					visibility: cs.visibility,
					display: cs.display,
					appRegion: cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'),
					// Neither the middle of the pane nor the middle of its top row (the box) is ever hit.
					centreHitsHeader: hit((pane.left + pane.right) / 2, (pane.top + pane.bottom) / 2),
					topHitsHeader: hit((pane.left + pane.right) / 2, pane.top + 10),
					hostClasses: ['tabstrip-vdragging', 'tabstrip-vdrag-any'].filter((c) => ws.contains(c)),
				};
			}, cur.n8);
		const panes = async () => (await model()).panes.length;
		type Geo = Awaited<ReturnType<typeof geometry>>;
		/**
		 * Drags a tab (its header, its row, or the header of `leafId` elsewhere, a sidebar's tab) to `p` and
		 * drops; whether a pane was added, and the stacked pane while dragging.
		 */
		const tryDrop = async (how: 'header' | 'row', p: Point, picture?: string, leafId?: string): Promise<{ split: boolean; during: Geo }> => {
			const leaf = leafId ?? cur.n3;
			const before = await panes();
			if (how === 'header') {
				if (leafId === undefined) await pageState(); // marks the headers (data-e2e-leaf)
				await startDrag(leaf);
			} else await startRowDrag(leaf);
			await dragOver(p, true);
			await browser.pause(60);
			await dragOver(p);
			await browser.pause(120);
			const during = await geometry();
			if (picture !== undefined) await shot(picture, 'V6');
			await dropAt(p);
			await browser.pause(400);
			const split = (await panes()) > before;
			// One stacked pane again for the next try.
			cur = await openNotes(all);
			await stack(true);
			return { split, during };
		};
		const at = (g: Geo, fx: number, fy: number): Point => ({ x: Math.round(g.pane.left + (g.pane.right - g.pane.left) * fx), y: Math.round(g.pane.top + (g.pane.bottom - g.pane.top) * fy) });
		/**
		 * The drop zones of a stacked pane, at points relative to the pane and to its tab header row
		 * (`row`: the row's height on the horizontal tab bar). Obsidian's rule: in the row, its left and
		 * right thirds split left / right and its top third splits up; below the row, the right third does
		 * not split, the upper and middle parts join the stack, the bottom third splits down.
		 */
		const PROBES = {
			rowRight: (g: Geo, row: number) => ({ x: at(g, 0.8, 0).x, y: Math.round(g.pane.top + row / 2) }),
			rowLeft: (g: Geo, row: number) => ({ x: at(g, 0.2, 0).x, y: Math.round(g.pane.top + row / 2) }),
			rowTop: (g: Geo) => ({ x: at(g, 0.5, 0).x, y: Math.round(g.pane.top + 4) }),
			bodyRight: (g: Geo) => at(g, 0.8, 0.5),
			upper: (g: Geo) => at(g, 0.5, 0.2),
			centre: (g: Geo) => at(g, 0.5, 0.5),
			lower: (g: Geo) => at(g, 0.5, 0.8),
		} as const;
		type Probe = keyof typeof PROBES;
		const EXPECTED: Record<Probe, boolean> = { rowRight: true, rowLeft: true, rowTop: true, bodyRight: false, upper: false, centre: false, lower: true };
		const probeAll = async (how: 'header' | 'row', g: Geo, row: number, picture?: Probe) => {
			const out = {} as Record<Probe, { split: boolean; during: Geo }>;
			for (const name of Object.keys(PROBES) as Probe[]) out[name] = await tryDrop(how, PROBES[name](g, row), name === picture ? 'stacked-split-right' : undefined);
			return out;
		};
		const splits = (r: Record<Probe, { split: boolean }>) => Object.fromEntries((Object.keys(r) as Probe[]).map((k) => [k, r[k].split])) as Record<Probe, boolean>;

		// Horizontal (native tab bar): Obsidian's own zones, the reference.
		await stack(true);
		const gh = await geometry();
		expect(gh.header.height).toBeGreaterThan(20);
		const rowH = gh.header.height;
		const horizontal = await probeAll('header', gh, rowH);
		record('S9-horizontal', { gh, horizontal: splits(horizontal) });
		expect(splits(horizontal)).toEqual(EXPECTED);

		// Vertical: the header row is hidden. Control first: a test style keeps it display: none during the
		// drag too (as before V6): no split at the right end of the top row.
		await toggle('vertical');
		await stack(true);
		const gv = await geometry();
		expect(gv.display).toBe('none');
		expect(gv.header.height).toBe(0);
		const noBox = async (on: boolean) =>
			browser.execute((value) => {
				document.getElementById('e2e-v6-no-stacked-box')?.remove();
				if (!value) return true;
				const style = document.createElement('style');
				style.id = 'e2e-v6-no-stacked-box';
				style.textContent = '.workspace .workspace-tabs.mod-stacked > .workspace-tab-header-container { display: none !important; }';
				document.head.appendChild(style);
				return true;
			}, on);
		expect(await noBox(true)).toBe(true);
		const vControl = await tryDrop('row', PROBES.rowRight(gv, rowH));
		await noBox(false);
		expect(vControl.split).toBe(false);
		// With the box (one row high) during the drag: the same zones as on the horizontal tab bar.
		const vertical = await probeAll('row', gv, rowH, 'rowRight');
		record('S9-vertical', { gv, control: vControl.split, vertical: splits(vertical) });
		expect(splits(vertical)).toEqual(EXPECTED);
		expect(splits(vertical)).toEqual(splits(horizontal));
		// The box during the drag: one header row at the top of the pane, not shown, never hit, drags no window.
		for (const d of [vertical.rowRight.during, vertical.upper.during]) {
			expect(d.display).toBe('flex');
			expect(Math.abs(d.header.top - d.pane.top)).toBeLessThanOrEqual(1);
			expect(Math.abs(d.header.height - rowH)).toBeLessThanOrEqual(1);
			expect(Math.abs(d.header.width - d.pane.width)).toBeLessThanOrEqual(1);
			expect(d.visibility).toBe('hidden');
			expect(d.centreHitsHeader).toBe(false);
			expect(d.topHitsHeader).toBe(false);
			expect(d.appRegion === '' || d.appRegion === 'no-drag').toBe(true);
			expect(d.hostClasses).toContain('tabstrip-vdragging');
		}

		// Review round 2: a drag that does not start in the strip (a tab of the right sidebar, Obsidian's own
		// drag) gets the same box: the right end of the top row splits, as on the horizontal tab bar.
		const sidebar = await browser.executeObsidian(({ app }) => (app.workspace.rightSplit as unknown as { collapsed: boolean }).collapsed);
		const sideLeaf = async () =>
			browser.executeObsidian(
				async ({ app, obsidian }, p) => {
					app.workspace.rightSplit.expand();
					const leaf = app.workspace.getRightLeaf(true);
					const file = app.vault.getFileByPath(p);
					if (!leaf || !(file instanceof obsidian.TFile)) throw new Error('no sidebar leaf');
					await leaf.openFile(file);
					const l = leaf as unknown as { id: string; tabHeaderEl: HTMLElement };
					l.tabHeaderEl.setAttribute('data-e2e-leaf', l.id);
					return l.id;
				},
				NOTES.n1,
			);
		const dropSide = async (control: boolean) => {
			const id = await sideLeaf();
			await browser.pause(300);
			// The open right sidebar narrows the stacked pane: measure it again.
			const gs = await geometry();
			if (control) await noBox(true);
			const r = await tryDrop('header', PROBES.rowRight(gs, rowH), control ? undefined : 'stacked-split-right-sidebar', id);
			if (control) await noBox(false);
			// Not dropped into the root (the control): close it.
			await browser.executeObsidian(({ app }, leafId) => app.workspace.getLeafById(leafId)?.detach(), id);
			return r;
		};
		const sControl = await dropSide(true);
		const sRight = await dropSide(false);
		record('S9-sidebar', { control: sControl.split, right: sRight.split, during: sRight.during });
		expect(sControl.split).toBe(false);
		expect(sRight.split).toBe(true);
		expect(sRight.during.display).toBe('flex');
		expect(Math.abs(sRight.during.header.height - rowH)).toBeLessThanOrEqual(1);
		expect(sRight.during.hostClasses).toEqual(['tabstrip-vdrag-any']);
		if (sidebar) await browser.executeObsidian(({ app }) => app.workspace.rightSplit.collapse());

		// After the drags the row is display: none again and no class is left.
		const after = await geometry();
		expect(after.display).toBe('none');
		expect(after.hostClasses).toEqual([]);
		expect(await dragResidue()).toEqual(NO_DRAG);
		await stack(false);
		await toggle('horizontal');
		record('S9', { rowHeight: rowH, horizontal: splits(horizontal), vertical: splits(vertical), control: vControl.split, sidebar: { control: sControl.split, right: sRight.split }, during: vertical.rowRight.during });
		await expectNoErrors();
	});

	it('S10 npm run try -- --vertical: the seed plugin opens the sandbox in vertical tabs with three groups (one collapsed) and a pinned tab', async function () {
		const vault = await browser.executeObsidian(({ app }) => (app.vault.adapter as unknown as { getBasePath(): string }).getBasePath());
		const configDir = await browser.executeObsidian(({ app }) => app.vault.configDir);
		const dir = path.join(vault, configDir, 'plugins', SEED);
		fs.mkdirSync(dir, { recursive: true });
		for (const f of ['manifest.json', 'main.js']) fs.copyFileSync(path.join(repoRoot, 'scripts', 'try-seed', f), path.join(dir, f));
		await browser.executeObsidian(({ app }) => {
			app.saveLocalStorage('tabstrip-try-seeded', null);
		});
		await ungroupAll();
		if ((await orientation()) !== 'horizontal') await toggle('horizontal');
		await openNotes(['n1']);
		// The seed plugin enabled while Obsidian runs (wdio-obsidian-service restarts only with the plugins
		// it installed itself): it waits for Tabstrip to run, then seeds, as at a start of `npm run try`.
		await browser.executeObsidian(async ({ app }, id) => {
			const plugins = (app as unknown as { plugins: { loadManifests(): Promise<void>; enablePlugin(id: string): Promise<boolean> } }).plugins;
			await plugins.loadManifests();
			await plugins.enablePlugin(id);
		}, SEED);
		const v = await waitView(isVertical, 'seeded vertical', 15000);
		const s = await waitForState((x) => x.state.groups.length === 3, 'three seeded groups', 10000);
		record('S10-strips', s.strips.map((x) => ({ kind: x.kind, n: x.leafIds.length, pinned: x.pinned })));
		const names = s.state.groups.map((g) => g.name).sort();
		expect(names).toEqual(['归档 Archive', '阅读 Reading', '项目 Project'].sort());
		expect(s.state.groups.filter((g) => g.collapsed).length).toBe(1);
		expect(s.strips.find((x) => x.kind === 'main')?.pinned.filter(Boolean).length).toBe(1);
		expect(await storedOrientation()).toBe('vertical');
		expect(v.rows.length).toBeGreaterThanOrEqual(6);
		await browser.pause(300);
		const picture = await shot('try-vertical-seeded', 'V6');
		record('S10', { rows: v.rows.length, names, picture });
		// Back to horizontal for the rest of the run; the seed plugin goes (it seeds once per vault anyway).
		await browser.executeObsidian(async ({ app }, id) => {
			await (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins.disablePlugin(id);
		}, SEED);
		await toggle('horizontal');
		await expectNoErrors();
	});

	it('S11 a real Escape from the keyboard during the bubble after a switch cancels it (the bubble keeps its own keys)', async function () {
		const ids = await scene();
		await setActive(ids.n2);
		expect(await runCommand(CMD.rename)).toBe(true);
		await waitForState((x) => x.editor.open && x.editor.inputFocused, 'bubble open');
		await browser.keys('Zzz');
		await toggle('vertical');
		await browser.keys([Key.Escape]);
		const s = await waitForState((x) => !x.editor.open, 'bubble closed');
		expect(s.state.groups.some((g) => g.name === 'Alpha 甲')).toBe(true);
		await toggle('horizontal');
		expect(await $('.tabstrip-editor').isExisting()).toBe(false);
		await expectNoErrors();
	});

	it('S12 phase-2 criterion 1 by keyboard only in vertical mode: Shift+F10 on a tab row, "Add tab to new group", name and Enter; Shift+F10 on the group row, "Ungroup"', async function () {
		const ids = await scene();
		await toggle('vertical');
		/** Arrow Down through the open menu until the highlighted item is `title`, then Enter. */
		const choose = async (title: string) => {
			await browser.waitUntil(async () => browser.execute(() => document.querySelector('.menu') !== null), { timeout: 3000, timeoutMsg: 'no menu' });
			for (let i = 0; i < 60; i++) {
				await browser.keys([Key.ArrowDown]);
				const at = await browser.execute(() => (document.querySelector('.menu .menu-item.selected')?.textContent ?? '').trim());
				if (at === title) {
					await browser.keys([Key.Enter]);
					return;
				}
			}
			const seen = await browser.execute(() => ({
				items: Array.from(document.querySelectorAll('.menu .menu-item')).map((i) => `${(i.textContent ?? '').trim()}|${i.className}`),
				focus: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className)}` : 'none',
				stack: (() => {
					const km = (window as unknown as { app: { keymap: { getWindowStack(w: Window): { scope: { keys?: { key: string | null }[] } | null; prevScopes: { keys?: { key: string | null }[] }[] } } } }).app.keymap;
					const st = km.getWindowStack(window);
					const d = (sc: { keys?: { key: string | null }[] } | null) => (sc?.keys ?? []).map((k) => String(k.key)).join('/');
					return [d(st.scope), ...st.prevScopes.map(d)].join(' | ');
				})(),
			}));
			throw new Error(`menu item ${title} not reached by keyboard: ${JSON.stringify(seen)}`);
		};
		const focusRow = async (key: string) => {
			await browser.execute((k) => {
				const el = document.querySelector<HTMLElement>(`.tabstrip-vstrip [data-tabstrip-item="${k}"]`);
				if (!el) throw new Error(`no item ${k}`);
				el.focus();
			}, key);
			await browser.pause(80);
		};
		// Keyboard only: the pointer rests far from where the menus open (Chromium sends hover events to a
		// pointer that items scroll under, and the menu selects the hovered item).
		await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: 1010, y: 790, origin: 'viewport', duration: 30 }).perform();
		const groups0 = (await pageState()).state.groups.length;
		await focusRow(`t:${ids.n8}`);
		await browser.keys([Key.Shift, Key.F10]);
		await choose('Add tab to new group');
		let s = await waitForState((x) => x.editor.open && x.editor.inputFocused, 'bubble after the keyboard menu');
		await browser.keys('Keys 键');
		await browser.keys([Key.Enter]);
		s = await waitForState((x) => !x.editor.open && x.state.groups.length === groups0 + 1, 'group made by keyboard');
		const g = s.state.groups.find((x) => x.name === 'Keys 键');
		expect(g).toBeDefined();
		expect(s.state.members.filter((m) => m.groupId === g?.id).map((m) => m.leafId)).toEqual([ids.n8]);
		await focusRow(`g:${g?.id ?? ''}`);
		await browser.keys([Key.Shift, Key.F10]);
		await choose('Ungroup');
		s = await waitForState((x) => x.state.groups.length === groups0, 'ungrouped by keyboard');
		expect(s.state.groups.some((x) => x.name === 'Keys 键')).toBe(false);
		await browser.keys([Key.Escape]);
		await toggle('horizontal');
		record('S12', { made: g?.name });
		await expectNoErrors();
	});

	it('S13 review round 2: phase-2 criterion 1 end to end in vertical mode with the mouse: group-row menu (colour, new tab in group, collapse other groups, close group), add to an existing group, skip-collapsed next / previous, undo close back into the group, pin a member', async function () {
		const ids = await scene();
		await toggle('vertical');
		const until = async (ok: (m: Model) => boolean, what: string): Promise<Model> => {
			let m = await model();
			const started = Date.now();
			while (!ok(m)) {
				if (Date.now() - started > 5000) throw new Error(`timed out waiting for: ${what}\nlast: ${JSON.stringify({ groups: m.groups, panes: m.panes, activeId: m.activeId })}`);
				await browser.pause(60);
				m = await model();
			}
			return m;
		};
		const rightClick = async (selector: string) => {
			const el = await $(selector).getElement();
			await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ origin: el, duration: 0 }).down({ button: 2 }).pause(30).up({ button: 2 }).perform();
		};
		const chipOf = (groupId: string) => `.tabstrip-vstrip .tabstrip-vgroup[data-tabstrip-group="${groupId}"] .tabstrip-vgroup-chip`;
		const rowOf = (leafId: string) => `.tabstrip-vstrip .tabstrip-vrow[data-tabstrip-leaf="${leafId}"]`;
		/**
		 * Right click on `selector`, then a real click on the item `title`. A tab menu as tall as the
		 * window scrolls a little (Obsidian's own `.menu-scroll`) when an item near its edge is hovered, so
		 * the item can move away from under the pointer: hover it, wait, and click only once the hovered
		 * item stays under the pointer (every move is recorded).
		 */
		const menu = async (selector: string, title: string) => {
			await rightClick(selector);
			await waitForMenu();
			const where = async () =>
				browser.execute((t) => {
					const item = Array.from(document.querySelectorAll('.menu .menu-item')).find((i) => (i.querySelector('.menu-item-title')?.textContent ?? '').trim() === t);
					const r = item?.getBoundingClientRect();
					return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
				}, title);
			const moves: unknown[] = [];
			for (let i = 0; ; i++) {
				const at = await where();
				if (at === null) throw new Error(`no menu item ${title}`);
				await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: at.x, y: at.y, origin: 'viewport', duration: 30 }).pause(300).perform();
				const now = await where();
				if (JSON.stringify(now) === JSON.stringify(at)) {
					menuMoves.push({ title, moves });
					await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: at.x, y: at.y, origin: 'viewport', duration: 0 }).down({ button: 0 }).pause(30).up({ button: 0 }).perform();
					return;
				}
				moves.push({ from: at, to: now });
				if (i >= 5) throw new Error(`menu item ${title} keeps moving: ${JSON.stringify(moves)}`);
			}
		};
		const menuMoves: { title: string; moves: unknown[] }[] = [];
		const m0 = await model();
		const group = (m: Model, prefix: string) => {
			const g = m.groups.find((x) => x.name.startsWith(prefix));
			if (!g) throw new Error(`no group ${prefix}`);
			return g;
		};
		const A = group(m0, 'Alpha').id;
		const B = group(m0, 'Beta').id;
		const C = group(m0, 'Gamma').id;
		const byId = (m: Model, id: string) => m.groups.find((g) => g.id === id);
		const order = (m: Model) => m.panes.flatMap((p) => p.ids);

		// Colour from the group row's menu: the model and the group row change.
		await menu(chipOf(A), 'Orange');
		await until((m) => byId(m, A)?.color === 'orange', 'Alpha orange');
		await browser.waitUntil(async () => (await browser.execute((sel) => document.querySelector(sel)?.getAttribute('data-tabstrip-color') ?? null, chipOf(A))) === 'orange', { timeout: 3000, timeoutMsg: 'group row not orange' });
		// Add a tab to an existing group from its tab row's menu.
		await menu(rowOf(ids.n8), 'Add tab to group: Gamma 丙');
		let m = await until((x) => JSON.stringify(byId(x, C)?.members) === JSON.stringify([ids.n6, ids.n7, ids.n8]), 'n8 joined Gamma');
		// New tab in group from the group row's menu: a new tab at the group's end, with its row in the strip.
		await menu(chipOf(A), 'New tab in group');
		m = await until((x) => (byId(x, A)?.members.length ?? 0) === 3, 'new tab in Alpha');
		const fresh = byId(m, A)?.members[2] ?? '';
		expect(order(m).indexOf(fresh)).toBe(order(m).indexOf(ids.n3) + 1);
		await waitView((v) => v.rows.includes(fresh), 'row for the new tab');
		// Collapse other groups from Gamma's row: Alpha and Beta collapse, their rows go; Gamma stays open.
		await setActive(ids.n8);
		await menu(chipOf(C), 'Collapse other groups');
		m = await until((x) => byId(x, A)?.collapsed === true && byId(x, B)?.collapsed === true && byId(x, C)?.collapsed === false, 'others collapsed');
		let v = await waitView((x) => !x.rows.includes(fresh) && !x.rows.includes(ids.n2), 'collapsed rows hidden');
		expect(v.rows).toEqual([ids.n1, ids.n6, ids.n7, ids.n8]);
		// Next / previous tab skipping collapsed groups.
		await setActive(ids.n1);
		expect(await runCommand('tabstrip:next-tab-skip-collapsed')).toBe(true);
		m = await until((x) => x.activeId === ids.n6, 'next skips Alpha and Beta');
		expect(await runCommand('tabstrip:previous-tab-skip-collapsed')).toBe(true);
		m = await until((x) => x.activeId === ids.n1, 'previous skips them back');
		// Undo close: a closed member comes back into its group, with its row in the group.
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.detach();
		}, ids.n7);
		m = await until((x) => !order(x).includes(ids.n7), 'n7 closed');
		expect(byId(m, C)?.members).toEqual([ids.n6, ids.n8]);
		expect(await runCommand('workspace:undo-close-pane')).toBe(true);
		m = await until((x) => (byId(x, C)?.members.length ?? 0) === 3, 'n7 back in Gamma');
		const back = byId(m, C)?.members[1] ?? '';
		expect(byId(m, C)?.members).toEqual([ids.n6, back, ids.n8]);
		v = await waitView((x) => x.rows.includes(back), 'row for the restored tab');
		expect(v.rows).toEqual([ids.n1, ids.n6, back, ids.n8]);
		expect(await browser.execute((sel) => document.querySelector(sel)?.getAttribute('data-tabstrip-group') ?? null, rowOf(back))).toBe(C);
		// Pin a member: it leaves the group and joins the pinned tabs at the top.
		await setPinned(ids.n6, true);
		m = await until((x) => !(byId(x, C)?.members.includes(ids.n6) ?? true) && order(x)[1] === ids.n6, 'pinned member left Gamma');
		expect(m.panes[0]?.pinned.slice(0, 2)).toEqual([true, true]);
		v = await waitView((x) => x.rows[1] === ids.n6, 'pinned row at the top');
		expect(await browser.execute((sel) => document.querySelector(sel)?.getAttribute('data-tabstrip-group') ?? null, rowOf(ids.n6))).toBeNull();
		await setPinned(ids.n6, false);
		// Close group from the group row's menu: its tabs close, the group and its rows go.
		await menu(chipOf(C), 'Close group');
		m = await until((x) => byId(x, C) === undefined && !order(x).includes(ids.n8) && !order(x).includes(back), 'Gamma closed');
		v = await waitView((x) => !x.rows.includes(ids.n8), 'Gamma rows gone');
		expect(await browser.execute((sel) => document.querySelector(sel) === null, chipOf(C))).toBe(true);
		await toggle('horizontal');
		record('S13', { menuMoves, colour: 'orange', fresh, restored: back, rowsAfter: v.rows, groupsAfter: m.groups.map((g) => [g.name, g.color, g.collapsed, g.members.length]) });
		await expectNoErrors();
	});
});
