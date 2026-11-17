/**
 * Step V1 (spike S7): the vertical tab strip is mounted inside the main window's .workspace, stays
 * mounted through layout loads, layout changes, pop-outs, restarts and disable/enable, hides the
 * native tab rows of the root split without touching the tab model, and keeps the window frame
 * usable (traffic lights, drag region, sidebar toggles, sidebar resizing) with the user's settings
 * (hidden window frame, no ribbon) and with the native frame.
 *
 * Frames are sampled with requestAnimationFrame (runs right before each paint): a frame is bad when
 * the strip and the tabstrip-vertical class disagree, when the strip shows next to native tab rows,
 * or when neither shows while the root split has tabs. Start-up frames are sampled by the test-only
 * probe plugin (test/e2e/plugins/startup-log-probe).
 *
 * The user's settings are only READ (their obsidian.json and the vault's appearance.json). The
 * frame setting is written into the sandbox's own throwaway config folder (Chromium's
 * --user-data-dir of this session, inside the temp folder), never into a user file.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run).
 */
import { $, browser, expect } from '@wdio/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mainVaultPath, realHome } from '../../../scripts/host-guard.mjs';
import {
	closePopout,
	errorTimeline,
	makeGroup,
	NOTES,
	openNotes,
	openPopoutLeafWithNotes,
	pageState,
	readErrors,
	record,
	repoRoot,
	residue,
	runCommand,
	commandAvailable,
	setActive,
	setLook,
	shot,
	startErrorWatch,
	waitForState,
	warmUpPopouts,
	withWarmPopout,
	writeEvidence,
	type Rect,
} from '../helpers';

const PROBE = 'e2e-startup-log-probe';
const KEY = 'tabstrip-session-v1';
const CMD = {
	toggle: 'tabstrip:toggle-vertical-tabs',
	restoreNative: 'tabstrip:restore-native-tab-bar',
	show: 'tabstrip:show-tab-groups',
} as const;

interface RowState {
	leafId: string | null;
	title: string;
	icon: string;
	classes: string[];
	color: string | null;
	bar: string;
	appRegion: string;
	rect: Rect;
}

interface VState {
	orientation: string;
	mounted: boolean;
	parentIsWorkspace: boolean;
	firstChild: boolean;
	cls: boolean;
	strip: Rect | null;
	header: Rect | null;
	workspace: Rect;
	win: { w: number; h: number };
	rows: RowState[];
	rootIds: string[];
	rootTitles: string[];
	rootIcons: string[];
	nativeShown: number;
	activeId: string | null;
	currents: string[];
	stats: { renders: number; renderMs: number[]; refreshMs: number[]; updates: number; updateMs: number[]; remounts: number; remountLog: { at: number; what: string }[]; headerRefreshes: number; styleWaits: number[] };
}

/** In-page: the strip, its rows, and the root split's tabs as Obsidian has them. Self-contained. */
async function vstate(): Promise<VState> {
	return browser.executeObsidian(({ app }) => {
		const box = (el: Element): Rect => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		};
		const sig = (el: Element | null): string => (el === null ? '' : Array.from(el.querySelectorAll('*')).map((n) => `${n.tagName.toLowerCase()}.${n.getAttribute('class') ?? ''}${n.getAttribute('data-e2e-icon') ?? ''}`).join(','));
		const appRegion = (el: Element) => {
			const cs = getComputedStyle(el);
			return cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region');
		};
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { orientation(): string; vstrip(): VState['stats'] } } | undefined> } }).plugins.plugins['tabstrip'];
		const ws = app.workspace.containerEl;
		const strip = ws.querySelector(':scope > .tabstrip-vstrip') ?? document.querySelector('.tabstrip-vstrip');
		const header = strip?.querySelector('.tabstrip-vstrip-header') ?? null;
		const rows: RowState[] = Array.from(strip?.querySelectorAll('.tabstrip-vrow') ?? []).map((row) => ({
			leafId: row.getAttribute('data-tabstrip-leaf'),
			title: (row.querySelector('.tabstrip-vrow-title')?.textContent ?? '').trim(),
			icon: sig(row.querySelector('.tabstrip-vrow-icon')),
			classes: Array.from(row.classList),
			color: row.getAttribute('data-tabstrip-color'),
			bar: getComputedStyle(row, '::before').backgroundColor,
			appRegion: appRegion(row),
			rect: box(row),
		}));
		type Tabs = { children: { id: string; tabHeaderEl: HTMLElement }[]; currentTab: number; containerEl: HTMLElement };
		const tabsList: Tabs[] = [];
		app.workspace.iterateRootLeaves((leaf) => {
			const parent = leaf.parent as unknown as Tabs;
			if (!tabsList.includes(parent)) tabsList.push(parent);
		});
		const leaves = tabsList.flatMap((t) => t.children);
		const nativeShown = Array.from((app.workspace.rootSplit as unknown as { containerEl: HTMLElement }).containerEl.querySelectorAll<HTMLElement>('.workspace-tabs > .workspace-tab-header-container')).filter((c) => c.offsetHeight > 0).length;
		return {
			orientation: plugin?.debug.orientation() ?? 'none',
			mounted: strip !== null,
			parentIsWorkspace: strip?.parentElement === ws,
			firstChild: ws.firstElementChild === strip && strip !== null,
			cls: ws.classList.contains('tabstrip-vertical'),
			strip: strip ? box(strip) : null,
			header: header ? box(header) : null,
			workspace: box(ws),
			win: { w: window.innerWidth, h: window.innerHeight },
			rows,
			rootIds: leaves.map((l) => l.id),
			rootTitles: leaves.map((l) => (l.tabHeaderEl.querySelector('.workspace-tab-header-inner-title')?.textContent ?? '').trim()),
			rootIcons: leaves.map((l) => sig(l.tabHeaderEl.querySelector('.workspace-tab-header-inner-icon'))),
			nativeShown,
			activeId: (app.workspace as unknown as { activeLeaf: { id: string } | null }).activeLeaf?.id ?? null,
			currents: tabsList.map((t) => t.children[t.currentTab]?.id ?? ''),
			stats: plugin?.debug.vstrip() ?? { renders: 0, renderMs: [], refreshMs: [], updates: 0, updateMs: [], remounts: 0, remountLog: [], headerRefreshes: 0, styleWaits: [] },
		};
	});
}

async function waitV(ok: (s: VState) => boolean, what: string, timeout = 6000): Promise<VState> {
	const start = Date.now();
	let last = await vstate();
	while (!ok(last)) {
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${what}\nlast: ${JSON.stringify({ ...last, rows: last.rows.map((r) => [r.leafId, r.title, r.classes.join(' ')]) })}`);
		await browser.pause(80);
		last = await vstate();
	}
	await browser.pause(100);
	return vstate();
}

const sameRows = (s: VState) => JSON.stringify(s.rows.map((r) => r.leafId)) === JSON.stringify(s.rootIds);

/** The mounted strip, in its place, with every root tab as a row and no native tab row shown. */
function expectMounted(s: VState): void {
	expect(s.mounted).toBe(true);
	expect(s.parentIsWorkspace).toBe(true);
	expect(s.firstChild).toBe(true);
	expect(s.cls).toBe(true);
	expect(s.nativeShown).toBe(0);
	expect(s.rows.map((r) => r.leafId)).toEqual(s.rootIds);
	expect(s.rows.map((r) => r.title)).toEqual(s.rootTitles);
	expect(s.rows.map((r) => r.icon)).toEqual(s.rootIcons);
}

/** Native tab bar back, nothing of the strip left. */
function expectNative(s: VState): void {
	expect(s.mounted).toBe(false);
	expect(s.cls).toBe(false);
	expect(s.nativeShown).toBeGreaterThan(0);
}

// ---------------------------------------------------------------- frame sampler

interface SampleReport {
	frames: number;
	bad: { frame: number; bad: string; strip: boolean; cls: boolean; native: number }[];
	withStrip: number;
	withNative: number;
	/**
	 * Review round 2: frames where the strip is there but its rows are not the root split's tabs in
	 * order (stale rows of an old layout, or no rows while the root split has tabs). While the root
	 * split is not in the page (a layout load in progress) the expected list is empty.
	 */
	rowMismatch: number;
	mismatches: { frame: number; rows: string[]; root: string[] }[];
	/** Sampler callbacks that threw (the loop goes on). */
	errors: string[];
}

async function startSampler(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		type St = { strip: boolean; cls: boolean; native: number; tabs: number; rows: number; bad: string | null };
		const w = window as unknown as { __tabstripVFrameState?: (a: unknown) => St; __v1Sampler?: { on: boolean; rep: SampleReport } };
		const state = w.__tabstripVFrameState;
		if (!state) throw new Error('probe frame state missing');
		const rep: SampleReport = { frames: 0, bad: [], withStrip: 0, withNative: 0, rowMismatch: 0, mismatches: [], errors: [] };
		const s = { on: true, rep };
		w.__v1Sampler = s;
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
					const rows = Array.from(app.workspace.containerEl.querySelectorAll(':scope > .tabstrip-vstrip .tabstrip-vrow')).map((r) => r.getAttribute('data-tabstrip-leaf') ?? '');
					const root = rootIds();
					if (rows.join(',') !== root.join(',')) {
						rep.rowMismatch++;
						if (rep.mismatches.length < 20) rep.mismatches.push({ frame: rep.frames, rows, root });
					}
				}
			} catch (e) {
				if (rep.errors.length < 20) rep.errors.push(String(e));
			}
			window.requestAnimationFrame(frame);
		};
		window.requestAnimationFrame(frame);
	});
}

async function stopSampler(): Promise<SampleReport> {
	await browser.pause(150);
	return browser.execute(() => {
		const w = window as unknown as { __v1Sampler?: { on: boolean; rep: SampleReport } };
		const s = w.__v1Sampler;
		if (!s) throw new Error('no sampler');
		s.on = false;
		return s.rep;
	});
}

/**
 * Review round 2: the sampler really measured (positive control). At least `floor` frames, none
 * whose check threw, the strip in `stripFrames` of them ('all': every frame), no bad frame, and at
 * most one frame whose rows were not the root split's tabs.
 */
function expectSampled(samples: SampleReport, stripFrames: 'all' | 'some', floor = 5): void {
	expect(samples.errors).toEqual([]);
	expect(samples.frames).toBeGreaterThan(floor);
	if (stripFrames === 'all') expect(samples.withStrip).toBe(samples.frames);
	else expect(samples.withStrip).toBeGreaterThan(0);
	expect(samples.bad).toEqual([]);
	if (samples.rowMismatch > 1) console.log(`[v1] row mismatches: ${JSON.stringify(samples.mismatches)}`);
	expect(samples.rowMismatch).toBeLessThanOrEqual(1);
}

// ---------------------------------------------------------------- app helpers

async function toggleVertical(want: 'vertical' | 'horizontal'): Promise<VState> {
	expect(await runCommand(CMD.toggle)).toBe(true);
	return waitV((s) => s.orientation === want && (want === 'vertical' ? s.mounted && sameRows(s) : !s.mounted), `orientation ${want}`);
}

async function storedRecord(): Promise<Record<string, unknown> | null> {
	return browser.executeObsidian(({ app }, key) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { flushSave(): void } } | undefined> } }).plugins.plugins['tabstrip'];
		plugin?.debug.flushSave();
		return app.loadLocalStorage(key) as Record<string, unknown> | null;
	}, KEY);
}

async function layoutJson(): Promise<string> {
	return browser.executeObsidian(({ app }) => JSON.stringify(app.workspace.getLayout()));
}

async function noticeTexts(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll('.notice')).map((n) => (n.textContent ?? '').trim()));
}

async function pluginNotices(): Promise<string[]> {
	return (await pageState()).stats.notices;
}

async function expectNoErrors(): Promise<void> {
	expect(await errorTimeline()).toEqual([]);
}

/** The settings the user runs Obsidian with, read only. */
function userSettings(): { frame: string; showRibbon: boolean; source: string[] } {
	const globalFile = path.join(realHome(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
	const vault = mainVaultPath();
	if (vault === null) throw new Error('set the main vault (TABSTRIP_MAIN_VAULT or .tabstrip-local.json, see README) to copy your window settings');
	const appearanceFile = path.join(vault, '.obsidian', 'appearance.json');
	const global = JSON.parse(fs.readFileSync(globalFile, 'utf8')) as { frame?: unknown };
	const appearance = JSON.parse(fs.readFileSync(appearanceFile, 'utf8')) as { showRibbon?: unknown };
	return {
		// Obsidian's default for a missing value is the hidden frame.
		frame: typeof global.frame === 'string' ? global.frame : 'hidden',
		showRibbon: appearance.showRibbon !== false,
		source: [globalFile, appearanceFile],
	};
}

/** The sandbox's own config folder (Chromium --user-data-dir of this session), checked to be a temp folder. */
function sandboxConfigDir(): string {
	const caps = browser.requestedCapabilities as unknown as { 'goog:chromeOptions'?: { args?: string[] } };
	const arg = (caps['goog:chromeOptions']?.args ?? []).find((a) => a.startsWith('--user-data-dir='));
	if (!arg) throw new Error('no --user-data-dir');
	const dir = fs.realpathSync(arg.slice('--user-data-dir='.length));
	const tmp = fs.realpathSync(os.tmpdir());
	if (!dir.startsWith(tmp + path.sep) || dir.startsWith(fs.realpathSync(realHome()) + path.sep + 'Library')) throw new Error(`refusing to write outside the temp folder: ${dir}`);
	if (!fs.existsSync(path.join(dir, 'obsidian.json'))) throw new Error(`no sandbox obsidian.json in ${dir}`);
	return dir;
}

/** Writes the window frame setting into the SANDBOX obsidian.json (takes effect at the next start). */
function setSandboxFrame(frame: string): string {
	const file = path.join(sandboxConfigDir(), 'obsidian.json');
	const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	json['frame'] = frame;
	fs.writeFileSync(file, JSON.stringify(json));
	return file;
}

async function setRibbon(show: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, value) => {
		const vault = app.vault as unknown as { setConfig(key: string, v: unknown): void; saveConfig(): Promise<void> };
		vault.setConfig('showRibbon', value);
		await vault.saveConfig();
	}, show);
	await browser.pause(300);
}

async function pluginLoaded(): Promise<boolean> {
	return browser.executeObsidian(({ app }) => (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins['tabstrip'] !== undefined && app.workspace.layoutReady);
}

interface VFrames {
	storedVertical: boolean;
	frames: number;
	firstRootFrame: number | null;
	firstStripFrame: number | null;
	firstRowsFrame: number | null;
	nativeFrames: number;
	/** Frames with the strip mounted but no row yet while the root split has tabs (review round 1). */
	emptyRowFrames: number;
	bad: unknown[];
	errors: number;
}

/** Real restart of the sandbox app (same config folder and vault copy). */
async function restart(): Promise<VFrames | null> {
	await browser.executeObsidian(async ({ app }) => {
		await app.workspace.requestSaveLayout.run();
	});
	await storedRecord();
	await browser.reloadObsidian({ plugins: ['tabstrip', PROBE] });
	await startErrorWatch();
	await browser.waitUntil(pluginLoaded, { timeout: 20000, timeoutMsg: 'tabstrip did not load after the restart' });
	await browser.pause(800);
	return browser.execute(() => (window as unknown as { __tabstripVFrames?: VFrames }).__tabstripVFrames ?? null);
}

/** Window geometry from Electron (test-only: the remote module, which plugin code never uses). */
async function windowFrame(): Promise<{ titlebarStyle: string; buttonPos: { x: number; y: number } | null; legacyPos: { x: number; y: number } | null; bounds: Rect; content: Rect; fullScreen: boolean; bodyClasses: string[] }> {
	return browser.execute(() => {
		type B = { x: number; y: number; width: number; height: number };
		type Win = { getBounds(): B; getContentBounds(): B; isFullScreen(): boolean; getWindowButtonPosition?: () => { x: number; y: number } | null; getTrafficLightPosition?: () => { x: number; y: number } };
		const remote = (window as unknown as { require(m: string): { remote: { getCurrentWindow(): Win } } }).require('electron').remote;
		const w = remote.getCurrentWindow();
		const rect = (b: B): Rect => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, width: b.width, height: b.height });
		const legacy = typeof w.getTrafficLightPosition === 'function' ? w.getTrafficLightPosition() : null;
		return {
			titlebarStyle: String((window as unknown as { titlebarStyle?: string }).titlebarStyle),
			buttonPos: typeof w.getWindowButtonPosition === 'function' ? w.getWindowButtonPosition() : null,
			legacyPos: legacy,
			bounds: rect(w.getBounds()),
			content: rect(w.getContentBounds()),
			fullScreen: w.isFullScreen(),
			bodyClasses: Array.from(document.body.classList),
		};
	});
}

interface HeaderParts {
	header: Rect;
	paddingStart: number;
	headerRegion: string;
	dragRegion: string;
	toggles: { side: string; rect: Rect; region: string; hit: boolean; label: string | null }[];
	nativeToggles: { side: string; shown: boolean }[];
}

async function headerParts(): Promise<HeaderParts> {
	return browser.execute(() => {
		const box = (el: Element): Rect => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		};
		const region = (el: Element) => {
			const cs = getComputedStyle(el);
			return cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region');
		};
		const header = document.querySelector('.tabstrip-vstrip-header');
		if (!header) throw new Error('no strip header');
		const toggles = Array.from(document.querySelectorAll('.tabstrip-vstrip-toggle')).map((t) => {
			const r = box(t);
			const hitEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return { side: t.classList.contains('mod-left') ? 'left' : 'right', rect: r, region: region(t), hit: hitEl !== null && t.contains(hitEl), label: t.getAttribute('aria-label') };
		});
		const nativeToggles = Array.from(document.querySelectorAll<HTMLElement>('.sidebar-toggle-button')).map((t) => ({ side: t.classList.contains('mod-left') ? 'left' : 'right', shown: t.offsetHeight > 0 && t.offsetWidth > 0 }));
		const drag = header.querySelector('.tabstrip-vstrip-drag');
		return {
			header: box(header),
			paddingStart: parseFloat(getComputedStyle(header).paddingInlineStart),
			headerRegion: region(header),
			dragRegion: drag ? region(drag) : '',
			toggles,
			nativeToggles,
		};
	});
}

async function sidebar(side: 'left' | 'right'): Promise<{ collapsed: boolean; rect: Rect; handle: Rect | null }> {
	return browser.executeObsidian(({ app }, s) => {
		const split = (s === 'left' ? app.workspace.leftSplit : app.workspace.rightSplit) as unknown as { collapsed: boolean; containerEl: HTMLElement };
		const box = (el: Element): Rect => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		};
		const handle = split.containerEl.querySelector(':scope > .workspace-leaf-resize-handle');
		return { collapsed: split.collapsed, rect: box(split.containerEl), handle: handle ? box(handle) : null };
	}, side);
}

async function setSidebar(side: 'left' | 'right', open: boolean): Promise<void> {
	await browser.executeObsidian(
		({ app }, s, o) => {
			const split = s === 'left' ? app.workspace.leftSplit : app.workspace.rightSplit;
			if (o) split.expand();
			else split.collapse();
		},
		side,
		open,
	);
	await browser.waitUntil(async () => (await sidebar(side)).collapsed === !open, { timeout: 3000, timeoutMsg: `${side} sidebar ${open ? 'open' : 'closed'}` });
	await browser.pause(500);
}

/** Real pointer drag of a sidebar's resize handle by dx; returns widths and where the handle ended up. */
async function dragHandle(side: 'left' | 'right', dx: number): Promise<{ before: number; after: number; pointerX: number; handleCenter: number }> {
	const s = await sidebar(side);
	if (s.handle === null) throw new Error(`no ${side} resize handle`);
	const x = Math.round(s.handle.left + s.handle.width / 2);
	const y = Math.round(s.handle.top + s.handle.height / 2);
	await browser
		.action('pointer', { parameters: { pointerType: 'mouse' } })
		.move({ x, y, origin: 'viewport' })
		.down({ button: 0 })
		.move({ x: x + Math.round(dx / 2), y, origin: 'viewport', duration: 100 })
		.move({ x: x + dx, y, origin: 'viewport', duration: 100 })
		.up({ button: 0 })
		.perform();
	await browser.pause(400);
	const after = await sidebar(side);
	return { before: s.rect.width, after: after.rect.width, pointerX: x + dx, handleCenter: after.handle ? after.handle.left + after.handle.width / 2 : NaN };
}

async function deferredLeaves(): Promise<string[]> {
	return browser.executeObsidian(({ app }) => {
		const out: string[] = [];
		app.workspace.iterateRootLeaves((leaf) => {
			if (leaf.isDeferred) out.push((leaf as unknown as { id: string }).id);
		});
		return out;
	});
}

const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('V1 vertical tab strip: mounting and the window frame', function () {
	let user: ReturnType<typeof userSettings>;

	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
		});
		await startErrorWatch();
		const warmUp = await warmUpPopouts();
		user = userSettings();
		record('v1-setup', { warmUp, obsidian: browser.getObsidianVersion(), installer: browser.getObsidianInstallerVersion(), user: { frame: user.frame, showRibbon: user.showRibbon } });
	});

	after(function () {
		writeEvidence('v1-mount');
	});

	it('M0 default stays horizontal: no strip, nothing stored, the command is there', async function () {
		await openNotes(['n1', 'n2', 'n3']);
		const s = await vstate();
		expect(s.orientation).toBe('horizontal');
		expectNative(s);
		expect(await commandAvailable(CMD.toggle)).toBe(true);
		const stored = await storedRecord();
		expect(stored === null || !('orientation' in stored)).toBe(true);
		record('M0', { stored, nativeShown: s.nativeShown });
		await expectNoErrors();
	});

	it('M1 the command mounts the strip inside .workspace at x = 0, full height; native rows hidden; tab model and layout unchanged', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4']);
		await setActive(ids.n2);
		const layoutBefore = await layoutJson();
		await startSampler();
		const s = await toggleVertical('vertical');
		const samples = await stopSampler();
		expectMounted(s);
		expect(s.strip?.left).toBe(0);
		expect(s.strip?.top).toBe(0);
		expect(s.workspace.left).toBe(0);
		expect(Math.abs((s.strip?.height ?? 0) - s.workspace.height)).toBeLessThanOrEqual(0.5);
		expect(s.rows.find((r) => r.leafId === ids.n2)?.classes).toContain('is-active');
		expect(s.rows.filter((r) => r.classes.includes('is-active')).length).toBe(1);
		expect(s.rows.every((r) => r.icon.includes('svg'))).toBe(true);
		expect(await layoutJson()).toBe(layoutBefore);
		const stored = await storedRecord();
		expect(stored?.['orientation']).toBe('vertical');
		// Off and on again: layout still unchanged.
		const off = await toggleVertical('horizontal');
		expectNative(off);
		expect(await layoutJson()).toBe(layoutBefore);
		expect((await storedRecord())?.['orientation']).toBeUndefined();
		const on = await toggleVertical('vertical');
		expectMounted(on);
		expectSampled(samples, 'some');
		record('M1', { strip: s.strip, workspace: s.workspace, rows: s.rows.map((r) => [r.leafId, r.title, r.classes]), samples, stored });
		await expectNoErrors();
	});

	it('M2 a real click on a row shows and focuses that tab', async function () {
		const s0 = await vstate();
		const target = s0.rows.find((r) => !r.classes.includes('is-active'));
		if (!target?.leafId) throw new Error('no background row');
		await $(`.tabstrip-vrow[data-tabstrip-leaf="${target.leafId}"]`).click();
		const s = await waitV((x) => x.activeId === target.leafId && x.rows.find((r) => r.leafId === target.leafId)?.classes.includes('is-active') === true, 'clicked row active');
		expect(s.currents).toContain(target.leafId);
		const focusInLeaf = await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			return leaf !== null && document.activeElement !== null && leaf.view.containerEl.contains(document.activeElement);
		}, target.leafId);
		expect(focusInLeaf).toBe(true);
		// Review round 1: with the focus in a sidebar view the strip still highlights exactly one row,
		// the root tab that was active last.
		const leftWasCollapsed = (await sidebar('left')).collapsed;
		await setSidebar('left', true);
		const sidebarFocused = await browser.executeObsidian(({ app }) => {
			const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
			if (!leaf) return false;
			app.workspace.setActiveLeaf(leaf, { focus: true });
			return app.workspace.getMostRecentLeaf(app.workspace.leftSplit) === leaf;
		});
		expect(sidebarFocused).toBe(true);
		const side = await waitV((x) => x.activeId !== target.leafId, 'focus left the root split');
		await browser.pause(200);
		const sideRows = (await vstate()).rows.filter((r) => r.classes.includes('is-active')).map((r) => r.leafId);
		expect(sideRows).toEqual([target.leafId]);
		await setActive(target.leafId);
		if (leftWasCollapsed) await setSidebar('left', false);
		record('M2', { clicked: target.leafId, active: s.activeId, sidebarFocus: { activeId: side.activeId, highlighted: sideRows } });
		await expectNoErrors();
	});

	it('M3 rows follow open, close, rename, move, icon changes (Iconize-like) and group colours, live', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4']);
		let s = await waitV(sameRows, 'rows after openNotes');
		expectMounted(s);
		// Open.
		const opened = await browser.executeObsidian(async ({ app }, p) => {
			const leaf = app.workspace.getLeaf('tab');
			const file = app.vault.getFileByPath(p);
			if (!file) throw new Error('no file');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		}, NOTES.n5);
		s = await waitV((x) => x.rows.some((r) => r.leafId === opened) && sameRows(x), 'opened tab listed');
		expectMounted(s);
		// Close.
		await browser.executeObsidian(({ app }, id) => app.workspace.getLeafById(id)?.detach(), opened);
		s = await waitV((x) => !x.rows.some((r) => r.leafId === opened) && sameRows(x), 'closed tab gone');
		// Rename (the file of n3).
		const renamed = await browser.executeObsidian(async ({ app }, p) => {
			const file = app.vault.getFileByPath(p);
			if (!file) throw new Error('no file');
			await app.fileManager.renameFile(file, 'V1 renamed note.md');
			return 'V1 renamed note';
		}, NOTES.n3);
		s = await waitV((x) => x.rows.find((r) => r.leafId === ids.n3)?.title === renamed, 'renamed title');
		expectMounted(s);
		await browser.executeObsidian(async ({ app }, p) => {
			const file = app.vault.getFileByPath('V1 renamed note.md');
			if (file) await app.fileManager.renameFile(file, p);
		}, NOTES.n3);
		// Move with Obsidian's own recipe (test code): n4 to the front.
		await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			const tabs = leaf?.parent as unknown as { children: unknown[]; currentTab: number; removeChild(l: unknown): void; insertChild(i: number, l: unknown): void; selectTabIndex(i: number): void };
			const shown = tabs.children[tabs.currentTab];
			tabs.removeChild(leaf);
			(leaf as unknown as { setDimension(d: null): void }).setDimension(null);
			tabs.insertChild(0, leaf);
			tabs.selectTabIndex(tabs.children.indexOf(shown));
			(app.workspace as unknown as { requestResize(): void }).requestResize();
		}, ids.n4);
		s = await waitV((x) => x.rows[0]?.leafId === ids.n4 && sameRows(x), 'moved tab first');
		// Iconize-like: another icon inside the native header's icon element.
		await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement };
			const icon = leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-icon');
			if (!icon) throw new Error('no native icon');
			const span = document.createElement('span');
			span.setAttribute('data-e2e-icon', 'iconize');
			span.textContent = '★';
			icon.replaceChildren(span);
		}, ids.n1);
		s = await waitV((x) => (x.rows.find((r) => r.leafId === ids.n1)?.icon ?? '').includes('iconize'), 'row icon follows the native icon');
		expectMounted(s);
		// Group colour bar.
		const groupId = await makeGroup([ids.n1, ids.n2], 'V1', 'purple');
		s = await waitV((x) => x.rows.filter((r) => r.color === 'purple').length === 2, 'member rows coloured');
		const members = s.rows.filter((r) => r.color === 'purple');
		// Review round 3: the hidden native headers of the root split carry no chip in vertical mode, so the
		// reference fill is the plugin's own purple swatch (the same colour the chip has in horizontal mode).
		const chipFill = await browser.execute(() => {
			const probe = document.createElement('span');
			probe.className = 'tabstrip-swatch';
			probe.setAttribute('data-tabstrip-color', 'purple');
			document.body.appendChild(probe);
			const fill = getComputedStyle(probe).backgroundColor;
			probe.remove();
			return fill;
		});
		const mainChips = await browser.executeObsidian(({ app }, g) => {
			const ws = app.workspace.containerEl;
			return ws.querySelectorAll(`:scope > .workspace-split.mod-root .tabstrip-chip[data-tabstrip-group="${g}"], :scope > .workspace-split.mod-root .tabstrip-member`).length;
		}, groupId);
		expect(mainChips).toBe(0);
		expect(chipFill).toMatch(/^(rgb|color|oklab)/);
		expect(members.every((r) => r.bar === chipFill)).toBe(true);
		expect(s.rows.filter((r) => r.color === null).every((r) => r.bar === 'rgba(0, 0, 0, 0)' || r.bar === 'transparent' || r.bar === '')).toBe(true);
		record('M3', { refreshes: s.stats.headerRefreshes, chipFill, mainChips, rows: s.rows.map((r) => [r.leafId, r.title, r.color, r.bar]) });
		await expectNoErrors();
	});

	it('M4 stays mounted through workspace layout loads (other tabs) and layout changes; rows match the root split in every frame', async function () {
		// Review round 2: the loaded layouts hold OTHER tabs than the one shown before, so stale rows would show.
		const other = await openNotes(['n5', 'n6']);
		const layoutOther = await browser.executeObsidian(({ app }) => app.workspace.getLayout());
		const first = await openNotes(['n1', 'n2', 'n3', 'n4']);
		const layoutFirst = await browser.executeObsidian(({ app }) => app.workspace.getLayout());
		const before = await waitV((x) => x.mounted && sameRows(x) && x.rows.length === 4, 'rows of the first layout');
		await startSampler();
		// The Workspaces core plugin's path: changeLayout (setLayout resets the .workspace children).
		await browser.executeObsidian(async ({ app }, l) => {
			await app.workspace.changeLayout(l);
		}, layoutOther);
		let s = await waitV((x) => x.mounted && sameRows(x) && x.rows.length > 0, 'rows after changeLayout');
		expectMounted(s);
		expect(s.rows.map((r) => r.leafId)).toEqual([other.n5, other.n6]);
		const afterLoad = s.stats.remounts;
		// A second pane (split), then back to one.
		const split = await browser.executeObsidian(async ({ app }, p) => {
			const leaf = app.workspace.getLeaf('split', 'vertical');
			const file = app.vault.getFileByPath(p);
			if (!file) throw new Error('no file');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		}, NOTES.n7);
		s = await waitV((x) => x.rows.some((r) => r.leafId === split) && sameRows(x), 'second pane listed');
		expectMounted(s);
		expect(s.rows.find((r) => r.leafId === split)?.classes).toContain('is-pane-start');
		// Real click on a row of the first pane while the second pane holds the focus.
		const firstPane = s.rows.find((r) => r.leafId !== split && !r.classes.includes('is-current'));
		if (firstPane?.leafId) {
			await $(`.tabstrip-vrow[data-tabstrip-leaf="${firstPane.leafId}"]`).click();
			s = await waitV((x) => x.activeId === firstPane.leafId, 'row in the other pane active');
			expect(s.currents).toContain(firstPane.leafId);
		}
		await browser.executeObsidian(({ app }, id) => app.workspace.getLeafById(id)?.detach(), split);
		s = await waitV((x) => !x.rows.some((r) => r.leafId === split) && sameRows(x), 'second pane gone');
		// Another layout load (as at start-up), back to the first tabs: the private setLayout, test code only.
		await browser.executeObsidian(async ({ app }, l) => {
			const ws = app.workspace as unknown as { setLayout(l: unknown): Promise<void> };
			await ws.setLayout(l);
		}, layoutFirst);
		s = await waitV((x) => x.mounted && sameRows(x) && x.rows.length === 4, 'rows after setLayout');
		const samples = await stopSampler();
		expectMounted(s);
		expect(s.rows.map((r) => r.leafId)).toEqual([first.n1, first.n2, first.n3, first.n4]);
		expect(afterLoad).toBeGreaterThan(before.stats.remounts);
		expect(s.stats.remounts).toBeGreaterThan(afterLoad);
		expectSampled(samples, 'all');
		expect(samples.withNative).toBe(0);
		record('M4', { remounts: s.stats.remounts, remountLog: s.stats.remountLog.slice(-6), samples });
		await expectNoErrors();
	});

	it('M5 pop-out windows keep their native tab bar and get no strip; the main strip stays through open and close', async function () {
		await startSampler();
		const { result: popIds } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n7, NOTES.n8]));
		const pop = await browser.executeObsidian(({ app }, id) => {
			const doc = app.workspace.getLeafById(id)?.getContainer().doc;
			if (!doc || doc === document) throw new Error('not in a pop-out');
			const shown = Array.from(doc.querySelectorAll<HTMLElement>('.workspace-tab-header-container')).filter((c) => c.offsetHeight > 0).length;
			return { strips: doc.querySelectorAll('.tabstrip-vstrip').length, vertical: doc.querySelectorAll('.tabstrip-vertical').length, nativeShown: shown };
		}, popIds[0] ?? '');
		let s = await vstate();
		expectMounted(s);
		expect(s.rows.some((r) => popIds.includes(r.leafId ?? ''))).toBe(false);
		expect(pop).toEqual({ strips: 0, vertical: 0, nativeShown: 1 });
		await closePopout(popIds[0] ?? '');
		await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, { timeout: 5000, timeoutMsg: 'pop-out did not close' });
		s = await waitV((x) => sameRows(x), 'main rows after the pop-out closed');
		const samples = await stopSampler();
		expectMounted(s);
		expectSampled(samples, 'all');
		record('M5', { pop, samples });
		await expectNoErrors();
	});

	it("M6 restart with the user's frame setting copied in: vertical comes back, no bad start-up frame, no deferred tab loaded", async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		await setActive(ids.n1);
		await setRibbon(user.showRibbon);
		const file = setSandboxFrame(user.frame);
		const frames = await restart();
		const s = await waitV((x) => x.mounted && x.rows.length >= 6 && sameRows(x), 'strip after restart', 10000);
		expectMounted(s);
		expect(s.orientation).toBe('vertical');
		const deferredBefore = await deferredLeaves();
		// Updates and a toggle off and on: the plugin loads no deferred tab.
		await toggleVertical('horizontal');
		await toggleVertical('vertical');
		await browser.executeObsidian(({ app }) => {
			app.workspace.trigger('layout-change');
		});
		await browser.pause(300);
		const deferredAfter = await deferredLeaves();
		const frame = await windowFrame();
		expect(frame.titlebarStyle).toBe(user.frame);
		expect(frames).not.toBeNull();
		expect(frames?.storedVertical).toBe(true);
		expect(frames?.bad).toEqual([]);
		expect(frames?.nativeFrames).toBe(0);
		// Review round 2: the rows are drawn with the strip (at most one frame of an empty strip while the root split has tabs).
		expect(frames?.firstRowsFrame).not.toBeNull();
		expect(frames?.emptyRowFrames).toBeLessThanOrEqual(1);
		expect(deferredBefore.length).toBeGreaterThan(0);
		expect(deferredAfter).toEqual(deferredBefore);
		record('M6', { sandboxConfig: path.basename(path.dirname(file)), frames, deferredBefore, deferredAfter, titlebarStyle: frame.titlebarStyle });
		await expectNoErrors();
	});

	it("M7 the user's hidden frame: traffic lights keep a clear area, the header drags the window, the strip's sidebar toggles work", async function () {
		const frame = await windowFrame();
		const ribbonShown = await browser.executeObsidian(({ app }) => (app.workspace as unknown as { leftRibbon: { containerEl: HTMLElement } }).leftRibbon.containerEl.offsetWidth > 0);
		expect(ribbonShown).toBe(user.showRibbon);
		expect(frame.bodyClasses).toContain('is-hidden-frameless');
		expect(frame.bodyClasses).toContain('mod-macos');
		expect(frame.fullScreen).toBe(false);
		// Hidden frame: the page starts at the window's top edge (no title bar above it).
		expect(frame.content.top).toBe(frame.bounds.top);
		await setSidebar('left', false);
		await setSidebar('right', false);
		const parts = await headerParts();
		// Traffic lights: Electron's position when set, else the system's for a hidden title bar
		// (close button at about 7,6; three 14px buttons 6px apart, 54 x 16).
		const pos = frame.buttonPos ?? frame.legacyPos ?? { x: 7, y: 6 };
		const lights: Rect = { left: pos.x, top: pos.y, right: pos.x + 54, bottom: pos.y + 16, width: 54, height: 16 };
		expect(parts.header.left).toBe(0);
		expect(parts.header.top).toBe(0);
		expect(lights.bottom).toBeLessThanOrEqual(parts.header.bottom);
		expect(parts.paddingStart).toBeGreaterThanOrEqual(80);
		expect(parts.paddingStart).toBeGreaterThanOrEqual(lights.right);
		for (const t of parts.toggles) {
			expect(intersects(t.rect, lights)).toBe(false);
			expect(t.rect.left).toBeGreaterThanOrEqual(lights.right);
			expect(t.hit).toBe(true);
			expect(t.region).toBe('no-drag');
		}
		expect(parts.headerRegion).toBe('drag');
		expect(parts.dragRegion).toBe('drag');
		const s = await vstate();
		for (const r of s.rows) {
			expect(r.appRegion).toBe('no-drag');
			expect(intersects(r.rect, lights)).toBe(false);
		}
		// With both sidebars collapsed, Obsidian's own toggles sit in the hidden native tab rows.
		expect(parts.nativeToggles.filter((t) => t.shown)).toEqual([]);
		// The strip's toggles, with real clicks (WebDriver refuses a covered element).
		await $('.tabstrip-vstrip-toggle.mod-left').click();
		await browser.waitUntil(async () => !(await sidebar('left')).collapsed, { timeout: 3000, timeoutMsg: 'left sidebar did not open' });
		await $('.tabstrip-vstrip-toggle.mod-right').click();
		await browser.waitUntil(async () => !(await sidebar('right')).collapsed, { timeout: 3000, timeoutMsg: 'right sidebar did not open' });
		await browser.pause(400);
		await $('.tabstrip-vstrip-toggle.mod-left').click();
		await browser.waitUntil(async () => (await sidebar('left')).collapsed, { timeout: 3000, timeoutMsg: 'left sidebar did not close' });
		await browser.pause(400);
		const corner = path.join(repoRoot, browser.getObsidianVersion() === '1.15.0' && process.env.TABSTRIP_WRITE_DOCS === '1' ? 'docs/verification/V1' : '.e2e-state/v1-screens', 'v1-corner-hidden-frame.png');
		fs.mkdirSync(path.dirname(corner), { recursive: true });
		await $('.tabstrip-vstrip-header').saveScreenshot(corner);
		record('M7', { frame, lights, parts });
		await expectNoErrors();
	});

	it('M8 file explorer and strip side by side; real pointer resizing of both sidebars follows the pointer', async function () {
		await setSidebar('left', true);
		await browser.executeObsidian(async ({ app }) => {
			const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
			if (leaf) await app.workspace.revealLeaf(leaf);
		});
		await browser.pause(400);
		const together = await browser.executeObsidian(({ app }) => {
			const box = (el: Element) => el.getBoundingClientRect();
			const strip = document.querySelector('.tabstrip-vstrip');
			const explorer = app.workspace.getLeavesOfType('file-explorer')[0]?.view.containerEl;
			if (!strip || !explorer) return null;
			const a = box(strip);
			const b = box(explorer);
			return { strip: [a.left, a.right, a.width], explorer: [b.left, b.right, b.width], explorerShown: b.width > 0 && b.height > 0 };
		});
		expect(together).not.toBeNull();
		expect(together?.explorerShown).toBe(true);
		expect((together?.strip[1] ?? 1) <= (together?.explorer[0] ?? 0) + 0.5).toBe(true);
		// Left sidebar: drag its handle right by 80px.
		const left = await dragHandle('left', 80);
		expect(Math.abs(left.after - left.before - 80)).toBeLessThanOrEqual(3);
		expect(Math.abs(left.handleCenter - left.pointerX)).toBeLessThanOrEqual(4);
		// Right sidebar: open, drag its handle left by 120px (wider).
		await setSidebar('left', false);
		await setSidebar('right', true);
		const right = await dragHandle('right', -120);
		expect(Math.abs(right.after - right.before - 120)).toBeLessThanOrEqual(3);
		expect(Math.abs(right.handleCenter - right.pointerX)).toBeLessThanOrEqual(4);
		const back = await dragHandle('right', 60);
		expect(Math.abs(back.before - back.after - 60)).toBeLessThanOrEqual(3);
		const s = await vstate();
		expectMounted(s);
		record('M8', { together, left, right, back });
		await setSidebar('right', false);
		await expectNoErrors();
	});

	it('M9 with Vertical Tabs signs on the page, one overlap notice already in horizontal mode, none more after switching, nothing else changes', async function () {
		await toggleVertical('horizontal');
		const before = (await pluginNotices()).length;
		// What Vertical Tabs puts on <body> (one of its settings classes); its view cannot be installed here.
		await browser.execute(() => document.body.classList.add('vt-scrollable-tabs'));
		// The next pass (here: after a CSS change, as when that plugin loads its styles) notices it.
		await browser.executeObsidian(({ app }) => {
			app.workspace.trigger('css-change');
		});
		const start = Date.now();
		while ((await pluginNotices()).length === before && Date.now() - start < 3000) await browser.pause(80);
		const horizontal = await vstate();
		const inHorizontal = (await pluginNotices()).slice(before);
		const onScreen = await noticeTexts();
		await toggleVertical('vertical');
		await toggleVertical('horizontal');
		const s = await toggleVertical('vertical');
		const notices = (await pluginNotices()).slice(before);
		await browser.execute(() => document.body.classList.remove('vt-scrollable-tabs'));
		expect(horizontal.orientation).toBe('horizontal');
		expect(horizontal.mounted).toBe(false);
		expect(inHorizontal.length).toBe(1);
		expect(inHorizontal[0]).toContain('Vertical Tabs');
		expect(inHorizontal[0]).toContain('Tabstrip leaves it enabled');
		expect(onScreen.some((n) => n.includes('Vertical Tabs'))).toBe(true);
		expectMounted(s);
		expect(notices).toEqual(inHorizontal);
		record('M9', { notices });
		await expectNoErrors();
	});

	it('M10 performance: 50 tabs, each strip update at most 5 ms plugin time', async function () {
		await openNotes(['n1']);
		const opened = await browser.executeObsidian(async ({ app }, paths) => {
			const ids: string[] = [];
			for (let i = 0; i < 49; i++) {
				const file = app.vault.getFileByPath(paths[i % paths.length] ?? '');
				if (!file) throw new Error('no file');
				const leaf = app.workspace.getLeaf('tab');
				await leaf.openFile(file, { active: false });
				ids.push((leaf as unknown as { id: string }).id);
			}
			return ids;
		}, Object.values(NOTES));
		let s = await waitV((x) => x.rows.length === 50 && sameRows(x), '50 rows', 15000);
		type Timing = { triggers: string[]; ms: number; opsMs: number; renderMs: number; layoutMs: number; ops: number; leaves: number };
		const passes = () =>
			browser.executeObsidian(({ app }) => {
				const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { stats(): { passes: number; timings: Timing[]; inkMs?: number[] } } } | undefined> } }).plugins.plugins['tabstrip'];
				const st = plugin?.debug.stats();
				return { passes: st?.passes ?? 0, timings: st?.timings ?? [], inkMs: st?.inkMs ?? [] };
			});
		// Review round 3: the whole plugin time of each update is measured, not only the row writes.
		// Updates outside a pass (header rows changed, layout load, mount) are timed read + plan + render
		// (updateMs); updates inside a pass are timed by the pass (read + reconcile + decorate + strip),
		// less the time spent inside Obsidian's own tab API calls the pass makes (opsMs).
		const before = { s, p: await passes() };
		for (let i = 0; i < 20; i++) {
			const id = opened[(i * 7) % opened.length] ?? '';
			await setActive(id);
		}
		// Open and close tabs (50 → 55 → 50).
		const extra = await browser.executeObsidian(async ({ app }, p) => {
			const ids: string[] = [];
			const file = app.vault.getFileByPath(p);
			if (!file) throw new Error('no file');
			for (let i = 0; i < 5; i++) {
				const leaf = app.workspace.getLeaf('tab');
				await leaf.openFile(file, { active: false });
				ids.push((leaf as unknown as { id: string }).id);
				await new Promise((r) => window.setTimeout(r, 50));
			}
			return ids;
		}, NOTES.n2);
		s = await waitV((x) => x.rows.length === 55 && sameRows(x), '55 rows', 8000);
		for (const id of extra) {
			await browser.executeObsidian(({ app }, leafId) => app.workspace.getLeafById(leafId)?.detach(), id);
			await browser.pause(50);
		}
		s = await waitV((x) => x.rows.length === 50 && sameRows(x), '50 rows again', 8000);
		await makeGroup([opened[3] ?? '', opened[4] ?? ''], 'Perf', 'green');
		s = await waitV((x) => x.rows.filter((r) => r.color === 'green').length === 2, 'perf group drawn');
		const after = await passes();
		const newUpdates = s.stats.updates - before.s.stats.updates;
		const newPasses = after.passes - before.p.passes;
		expect(newUpdates).toBeLessThanOrEqual(200);
		const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
		const q = (xs: number[], f: number) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] ?? NaN;
		const updates = sorted(s.stats.updateMs.slice(-newUpdates));
		const passTimings = after.timings.slice(-newPasses).filter((t) => t.leaves >= 50);
		const passPlugin = sorted(passTimings.map((t) => t.ms - t.opsMs));
		const passTotal = sorted(passTimings.map((t) => t.ms));
		const renders = sorted(s.stats.renderMs.slice(-(s.stats.renders - before.s.stats.renders)));
		const refresh = sorted(s.stats.refreshMs);
		record('M10', {
			updates: { n: updates.length, median: q(updates, 0.5), p95: q(updates, 0.95), max: updates[updates.length - 1] },
			passes: { n: passPlugin.length, median: q(passPlugin, 0.5), p95: q(passPlugin, 0.95), max: passPlugin[passPlugin.length - 1], maxWithOps: passTotal[passTotal.length - 1] },
			slowestPasses: [...passTimings].sort((a, b) => b.ms - a.ms).slice(0, 3),
			inkMs: after.inkMs.slice(before.p.inkMs.length),
			renderOnlyMax: renders[renders.length - 1],
			refreshMax: refresh[refresh.length - 1] ?? null,
		});
		// Open and close changed the header rows: those updates ran outside a pass and were timed.
		expect(updates.length).toBeGreaterThanOrEqual(10);
		expect(passPlugin.length).toBeGreaterThanOrEqual(20);
		expect(updates[updates.length - 1]).toBeLessThanOrEqual(5);
		expect(passPlugin[passPlugin.length - 1]).toBeLessThanOrEqual(5);
		// V2 review round 2: the chip inks were measured while idle (after start), not by these updates;
		// measuring them in the first named group's update cost 1-2 ms of its plugin time.
		expect(after.inkMs.slice(before.p.inkMs.length)).toEqual([]);
		expectMounted(s);
		await expectNoErrors();
	});

	it('M11 screenshots: vertical mode in default and Atom, light and dark', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n7', 'n8']);
		await makeGroup([ids.n2, ids.n3], 'Work 工作', 'blue');
		await makeGroup([ids.n5, ids.n7], '', 'orange');
		await setActive(ids.n3);
		await setSidebar('left', true);
		const files: string[] = [];
		for (const [theme, dark] of [
			['default', false],
			['default', true],
			['Atom', false],
			['Atom', true],
		] as const) {
			await setLook(theme, dark);
			const s = await vstate();
			expectMounted(s);
			files.push(await shot(`v1-${theme.toLowerCase()}-${dark ? 'dark' : 'light'}`, 'V1'));
		}
		await setLook('default', false);
		await setSidebar('left', false);
		record('M11', { files });
		await expectNoErrors();
	});

	it('M12 "Restore native tab bar" and disabling the plugin remove everything; showing again and enabling mount the strip again', async function () {
		await openNotes(['n1', 'n2', 'n3']);
		let s = await waitV((x) => x.mounted && sameRows(x), 'mounted');
		expect(await runCommand(CMD.restoreNative)).toBe(true);
		s = await waitV((x) => !x.mounted, 'native mode');
		expectNative(s);
		expect((await residue()).found).toEqual([]);
		expect(await runCommand(CMD.show)).toBe(true);
		s = await waitV((x) => x.mounted && sameRows(x), 'shown again');
		expectMounted(s);
		await startSampler();
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins.disablePlugin('tabstrip');
		});
		await browser.pause(300);
		s = await vstate();
		expectNative(s);
		const left = await residue();
		expect(left.found).toEqual([]);
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { enablePlugin(id: string): Promise<void> } }).plugins.enablePlugin('tabstrip');
		});
		s = await waitV((x) => x.mounted && sameRows(x) && x.rows.length >= 3, 'mounted after enable', 10000);
		const samples = await stopSampler();
		expectMounted(s);
		expectSampled(samples, 'some');
		// Frames the mount after enabling waited for styles.css (empty: it was applied at onload already).
		record('M12', { residue: left, samples, styleWaits: s.stats.styleWaits });
		await startErrorWatch();
		await expectNoErrors();
	});

	it('M13 back to horizontal: native tab bar, chips as before, no strip residue, orientation not stored', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4']);
		const groupId = await makeGroup([ids.n2, ids.n3], 'Back', 'red');
		const s = await toggleVertical('horizontal');
		expectNative(s);
		const ps = await waitForState((x) => x.chips.some((c) => c.groupId === groupId && c.rect.width > 0), 'chip visible again');
		const chip = ps.chips.find((c) => c.groupId === groupId);
		expect(chip?.hostLeafId).toBe(ids.n2);
		const found = (await residue()).found.filter((f) => f.includes('vstrip') || f.includes('vrow') || f.includes('tabstrip-vertical') || f.includes('tabstrip-leaf'));
		expect(found).toEqual([]);
		expect((await storedRecord())?.['orientation']).toBeUndefined();
		record('M13', { chip: chip?.rect });
		await expectNoErrors();
	});

	it('M14 native window frame (restart): no traffic-light room, no drag region, toggles and resizing still work', async function () {
		await toggleVertical('vertical');
		setSandboxFrame('native');
		const frames = await restart();
		const frame = await windowFrame();
		expect(frame.titlebarStyle).toBe('native');
		expect(frame.bodyClasses).not.toContain('is-hidden-frameless');
		// Native frame: a title bar above the page.
		expect(frame.content.top).toBeGreaterThan(frame.bounds.top);
		const s = await waitV((x) => x.mounted && sameRows(x) && x.rows.length > 0, 'strip after native restart', 10000);
		expectMounted(s);
		expect(frames?.bad).toEqual([]);
		expect(frames?.emptyRowFrames).toBeLessThanOrEqual(1);
		await setSidebar('left', false);
		await setSidebar('right', false);
		const parts = await headerParts();
		expect(parts.paddingStart).toBeLessThan(20);
		expect(parts.headerRegion).not.toBe('drag');
		for (const t of parts.toggles) expect(t.hit).toBe(true);
		await $('.tabstrip-vstrip-toggle.mod-right').click();
		await browser.waitUntil(async () => !(await sidebar('right')).collapsed, { timeout: 3000, timeoutMsg: 'right sidebar did not open' });
		await browser.pause(400);
		const right = await dragHandle('right', -100);
		expect(Math.abs(right.after - right.before - 100)).toBeLessThanOrEqual(3);
		expect(Math.abs(right.handleCenter - right.pointerX)).toBeLessThanOrEqual(4);
		await $('.tabstrip-vstrip-toggle.mod-left').click();
		await browser.waitUntil(async () => !(await sidebar('left')).collapsed, { timeout: 3000, timeoutMsg: 'left sidebar did not open' });
		await browser.pause(400);
		const left = await dragHandle('left', 60);
		expect(Math.abs(left.after - left.before - 60)).toBeLessThanOrEqual(3);
		const corner = path.join(repoRoot, browser.getObsidianVersion() === '1.15.0' && process.env.TABSTRIP_WRITE_DOCS === '1' ? 'docs/verification/V1' : '.e2e-state/v1-screens', 'v1-corner-native-frame.png');
		await $('.tabstrip-vstrip-header').saveScreenshot(corner);
		record('M14', { frame, parts, frames, right, left });
		await expectNoErrors();
		expect(await readErrors()).toEqual([]);
	});
});
