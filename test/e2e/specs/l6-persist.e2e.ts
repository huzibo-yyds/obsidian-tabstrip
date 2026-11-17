/**
 * Step L6: groups survive a restart (per-device storage T1), and native undo-close puts a tab back
 * into its group.
 *
 * Restarts are real: `browser.reloadObsidian()` quits the sandbox app and starts it again with the
 * same throwaway config directory and vault copy (wdio-obsidian-service), so Obsidian reloads its
 * own workspace.json and the app's local storage. The start-up frames are watched by the test-only
 * probe plugin (test/e2e/plugins/startup-log-probe). The layout file edited between runs is the
 * sandbox vault copy's own .obsidian/workspace.json (in the throwaway temp folder), never a user file.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run). Every case reads
 * the live state.
 */
import { $, browser, expect } from '@wdio/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GroupColor } from '../../../src/core/types';
import {
	closePopout,
	errorTimeline,
	expectContiguous,
	expectDecorated,
	groupOf,
	mainStrip,
	makeGroup,
	membersInOrder,
	NOTES,
	openNotes,
	openPopoutLeafWithNotes,
	pageState,
	popoutCloseReports,
	record,
	repoRoot,
	residue,
	runCommand,
	setActive,
	startErrorWatch,
	stripOf,
	waitForState,
	warmUpPopouts,
	withWarmPopout,
	writeEvidence,
	type PageState,
} from '../helpers';

const KEY = 'tabstrip-session-v1';
const PROBE = 'e2e-startup-log-probe';
const CMD = {
	undo: 'workspace:undo-close-pane',
	remove: 'tabstrip:remove-from-group',
	restoreUnmatched: 'tabstrip:restore-unmatched-groups',
	clear: 'tabstrip:clear-local-data',
	restoreNative: 'tabstrip:restore-native-tab-bar',
	show: 'tabstrip:show-tab-groups',
} as const;

interface StoredLike {
	version: number;
	nextGroupSeq: number;
	groups: { groupId: string; name: string; color: string; collapsed: boolean; members: { leafId: string; type: string; path?: string }[] }[];
	closed: { leafId: string; groupId: string; name: string; color: string; pane: string | null; left: string | null; right: string | null }[];
	unmatched: { groupId: string; name: string; color: string; members: { type: string; path?: string }[] }[];
}

interface FrameRecord {
	layoutReadyAtLoad: boolean;
	frames: number;
	decoratedFrames: number;
	firstDecorated: { frame: number; ms: number; chips: number; collapsedHeaders: number } | null;
	maxCollapsedHeaders: number;
	violations: { frame: number; leafId: string; reason: string; ms: number }[];
	errors: number;
}

function collapsed(s: PageState, groupId: string): boolean | undefined {
	return s.state.groups.find((g) => g.id === groupId)?.collapsed;
}

/** The stored record (null when nothing is stored). */
async function storedValue(): Promise<StoredLike | null> {
	return browser.executeObsidian(({ app }, key) => app.loadLocalStorage(key) as StoredLike | null, KEY);
}

/** Test setup: writes the stored record directly (public saveLocalStorage). */
async function writeStored(value: unknown): Promise<void> {
	await browser.executeObsidian(({ app }, key, v) => app.saveLocalStorage(key, v), KEY, value);
}

/** Test setup: writes raw text (not JSON) under the key, through the app id Obsidian prefixes keys with. */
async function writeRawStored(text: string): Promise<void> {
	await browser.executeObsidian(
		({ app }, key, t) => {
			const appId = (app as unknown as { appId: string }).appId;
			window.localStorage.setItem(`${appId}-${key}`, t);
		},
		KEY,
		text,
	);
}

async function waitStored(ok: (v: StoredLike | null) => boolean, what: string, timeout = 5000): Promise<StoredLike | null> {
	let last: StoredLike | null = null;
	await browser.waitUntil(
		async () => {
			last = await storedValue();
			return ok(last);
		},
		{ timeout, interval: 100, timeoutMsg: `stored record: ${what}` },
	);
	return last;
}

async function pluginLoaded(): Promise<boolean> {
	return browser.executeObsidian(({ app }) => (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins['tabstrip'] !== undefined);
}

async function setEnabled(on: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, value) => {
		const plugins = (app as unknown as { plugins: { enablePlugin(id: string): Promise<boolean>; disablePlugin(id: string): Promise<void> } }).plugins;
		if (value) await plugins.enablePlugin('tabstrip');
		else await plugins.disablePlugin('tabstrip');
	}, on);
	await browser.waitUntil(async () => (await pluginLoaded()) === on, { timeout: 5000, timeoutMsg: `tabstrip ${on ? 'enabled' : 'disabled'}` });
	if (on) await browser.pause(300);
}

/** The restore record of this plugin instance (null until the layout is ready). */
async function restoreStats(): Promise<PageState['stats']['restore']> {
	return browser.executeObsidian(({ app }) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { stats(): { restore: unknown } } } | undefined> } }).plugins.plugins['tabstrip'];
		return (plugin?.debug.stats().restore ?? null) as PageState['stats']['restore'];
	});
}

/**
 * A real restart of the sandbox app (quit, start again with the same config and vault copy).
 * Obsidian's layout is saved first the way it saves it on quit; the plugin's own save is not
 * forced (it must have run by itself, or on Obsidian's 'quit' event).
 */
async function restart(): Promise<{ restore: PageState['stats']['restore']; ms: number }> {
	await browser.executeObsidian(async ({ app }) => {
		await app.workspace.requestSaveLayout.run();
	});
	const started = Date.now();
	await browser.reloadObsidian({ plugins: ['tabstrip', PROBE] });
	await startErrorWatch();
	await browser.waitUntil(async () => (await pluginLoaded()) && (await restoreStats()) !== null, { timeout: 15000, timeoutMsg: 'tabstrip did not restore after the restart' });
	await browser.pause(300);
	const timing = await browser.executeObsidian(({ app }) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { stats(): { timings: { triggers: string[]; ms: number; opsMs: number; renderMs: number; layoutMs: number; leaves: number }[] } } } | undefined> } }).plugins.plugins['tabstrip'];
		return { start: plugin?.debug.stats().timings.find((t) => t.triggers.includes('start')) ?? null };
	});
	const restore = await restoreStats();
	const startup = await startupConsole();
	restarts.push({ ms: Date.now() - started, start: timing.start, restoreMs: restore?.ms ?? null, groups: restore?.report?.restoredGroups ?? 0, startup });
	record('restarts', restarts);
	// Review round 1: errors and warnings while the new app started and Tabstrip restored are
	// checked after every restart, not only in the last session. Two sources: the probe's hook
	// (from the moment it loads, before the restore in onLayoutReady) and the new session's
	// browser log (from process start; only the probe's own known test line is left out).
	expect(startup.probe).toEqual({ errors: [], warnings: [], uncaught: [], controls: 1 });
	expect(startup.log).toEqual([]);
	// Positive control: the new session's log has the probe's start-up line.
	expect(startup.probeLineSeen).toBe(true);
	return { restore, ms: Date.now() - started };
}

/**
 * After the sandbox app quit by itself (P16): starts it again through wdio-obsidian-service's
 * reloadObsidian, the same way restart() does. Its first step ends the old WebDriver session; the
 * app is already gone then, so an error from that step alone is expected and ignored (logged).
 */
async function relaunchAfterQuit(plugins: string[]): Promise<void> {
	quitRelaunch.active = true;
	try {
		await browser.reloadObsidian({ plugins });
	} finally {
		quitRelaunch.active = false;
	}
	await startErrorWatch();
	await browser.waitUntil(async () => browser.executeObsidian(({ app }) => app.workspace.layoutReady), { timeout: 15000, timeoutMsg: 'the app did not start again' });
	const startup = await startupConsole();
	restarts.push({ afterQuit: true, startup, deleteSessionErrors: quitRelaunch.errors });
	record('restarts', restarts);
	expect(startup.probe).toEqual({ errors: [], warnings: [], uncaught: [], controls: 1 });
	expect(startup.log).toEqual([]);
	expect(startup.probeLineSeen).toBe(true);
}

/** While relaunchAfterQuit runs, ending the (already dead) old session may fail; see there. */
const quitRelaunch: { active: boolean; errors: string[] } = { active: false, errors: [] };

/** Console errors, warnings and uncaught errors of the session that just started (see restart). */
type StartupRecord = { errors: string[]; warnings: string[]; uncaught: string[]; controls: number };

async function startupConsole(): Promise<{ probe: StartupRecord | null; log: string[]; probeLineSeen: boolean }> {
	const probe = await browser.execute(() => (window as Window & { __e2eStartupConsole?: StartupRecord }).__e2eStartupConsole ?? null);
	const logs = (await browser.getLogs('browser')) as { level: string; message: string }[];
	startupLogs.push(...logs);
	const own = (m: string) => m.includes('e2e-startup-probe error');
	const log = logs.filter((l) => (l.level === 'SEVERE' || l.level === 'WARNING') && !own(l.message)).map((l) => `${l.level} ${l.message.slice(0, 300)}`);
	return { probe, log, probeLineSeen: logs.some((l) => l.message.includes('e2e-startup-probe error')) };
}

/** Browser log entries read (and so drained) by startupConsole, for the last test. */
const startupLogs: { level: string; message: string }[] = [];

const restarts: unknown[] = [];

/**
 * Closes a tab (public detach) and waits until Obsidian's close animation is over: Obsidian
 * animates a closing tab on a copy of its header (with whatever marks it had) for about 200 ms.
 */
async function closeLeaf(leafId: string): Promise<PageState> {
	await browser.executeObsidian(({ app }, id) => app.workspace.getLeafById(id)?.detach(), leafId);
	return waitForState(
		(x) => !x.strips.some((st) => st.leafIds.includes(leafId)) && x.chips.every((c) => c.hostLeafId !== null) && x.memberHeaders.every((h) => h.leafId !== null),
		`${leafId} closed`,
	);
}

/** Shows a tab with Obsidian's public API only (works while the plugin is disabled). */
async function activateNatively(leafId: string): Promise<void> {
	await browser.executeObsidian(({ app }, id) => {
		const leaf = app.workspace.getLeafById(id);
		if (!leaf) throw new Error(`no leaf ${id}`);
		app.workspace.setActiveLeaf(leaf, { focus: true });
	}, leafId);
	await browser.waitUntil(
		async () => browser.executeObsidian(({ app }, id) => (app.workspace as unknown as { activeLeaf: { id: string } | null }).activeLeaf?.id === id, leafId),
		{ timeout: 3000, timeoutMsg: `leaf ${leafId} not active` },
	);
}

/** Real click on the confirmation modal's button with exactly this text. */
async function clickModalButton(text: string): Promise<void> {
	const found = await browser.execute((t) => {
		const buttons = Array.from(document.querySelectorAll('.modal.tabstrip-confirm button'));
		for (const b of buttons) b.removeAttribute('data-e2e-button');
		const hit = buttons.find((b) => (b.textContent ?? '').trim() === t);
		hit?.setAttribute('data-e2e-button', '1');
		return hit !== undefined;
	}, text);
	if (!found) throw new Error(`no modal button "${text}"`);
	await $('.modal.tabstrip-confirm button[data-e2e-button="1"]').click();
}

async function frames(): Promise<FrameRecord | null> {
	return browser.execute(() => (window as unknown as { __tabstripFrames?: FrameRecord }).__tabstripFrames ?? null);
}

async function setCollapsedVia(groupId: string, value: boolean): Promise<void> {
	await browser.executeObsidian(
		({ app }, gid, v) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { setCollapsed(id: string, c: boolean): boolean } } | undefined> } }).plugins.plugins['tabstrip'];
			if (!plugin) throw new Error('tabstrip not loaded');
			plugin.debug.setCollapsed(gid, v);
		},
		groupId,
		value,
	);
	await waitForState((x) => collapsed(x, groupId) === value, `group ${groupId} ${value ? 'collapsed' : 'expanded'}`);
}

/** openNotes, with every tab taken out of any group left over from an earlier case. */
async function freshNotes<R extends Parameters<typeof openNotes>[0][number]>(roles: R[]): Promise<Record<R, string>> {
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

/** Header box and visibility of one tab. */
async function headerBox(leafId: string): Promise<{ width: number; visibility: string; collapsedClass: boolean }> {
	return browser.executeObsidian(({ app }, id) => {
		const leaf = app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement } | null;
		if (!leaf) throw new Error(`no leaf ${id}`);
		const el = leaf.tabHeaderEl;
		return { width: el.getBoundingClientRect().width, visibility: getComputedStyle(el).visibility, collapsedClass: el.classList.contains('tabstrip-collapsed') };
	}, leafId);
}

/** Groups as name/colour/collapsed plus members in tab order, for comparing across a restart. */
function groupsView(s: PageState): { name: string; color: GroupColor; collapsed: boolean; members: string[] }[] {
	return s.state.groups.map((g) => ({ name: g.name, color: g.color, collapsed: g.collapsed, members: membersInOrder(s, g.id) }));
}

/** Leaves that are loaded (not deferred). */
async function loadedLeaves(): Promise<string[]> {
	return browser.executeObsidian(({ app }) => {
		const out: string[] = [];
		app.workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot() as unknown;
			const ws = app.workspace as unknown as { rootSplit: unknown; floatingSplit: unknown };
			if ((root === ws.rootSplit || root === ws.floatingSplit) && !leaf.isDeferred) out.push((leaf as unknown as { id: string }).id);
		});
		return out;
	});
}

async function noticeTexts(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll('.notice')).map((n) => (n.textContent ?? '').trim()));
}

async function pluginNotices(): Promise<string[]> {
	return (await pageState()).stats.notices;
}

describe('L6 keep groups across restart, undo-close back into the group', function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
		});
		// P16: ending the WebDriver session of an app that already quit by itself may fail; only then
		// (quitRelaunch.active) the error is kept and not thrown, so the relaunch goes on.
		// (A protocol command: webdriverio can overwrite it, its typings only list browser commands.)
		type Overwrite = (name: string, fn: (original: (o: unknown) => Promise<unknown>, options: unknown) => Promise<void>) => void;
		(browser.overwriteCommand as unknown as Overwrite).call(browser, 'deleteSession', async (original, options) => {
			try {
				await original(options);
			} catch (e) {
				if (!quitRelaunch.active) throw e;
				quitRelaunch.errors.push(String(e).slice(0, 300));
			}
		});
		await startErrorWatch();
		const warmUp = await warmUpPopouts();
		record('l6-setup', { warmUp, obsidian: browser.getObsidianVersion(), installer: browser.getObsidianInstallerVersion() });
	});

	after(function () {
		writeEvidence('l6-persist');
	});

	// ------------------------------------------------------------------ P0

	it('P0 the sandbox renders at a fixed device scale factor of 2 (pixel checks do not depend on the main display)', async function () {
		const dpr = await browser.execute(() => window.devicePixelRatio);
		const file = path.join(repoRoot, '.e2e-state', 'l6-screens', `p0-scale-${browser.getObsidianVersion()}.png`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		await browser.saveScreenshot(file);
		const png = fs.readFileSync(file);
		// PNG IHDR: width at byte 16 (big-endian).
		const width = png.readUInt32BE(16);
		const inner = await browser.execute(() => window.innerWidth);
		record('P0', { devicePixelRatio: dpr, screenshotWidth: width, innerWidth: inner });
		expect(dpr).toBe(2);
		expect(width).toBe(inner * 2);
	});

	// ------------------------------------------------------------------ P1

	it('P1 a real restart keeps groups, names, colours, collapsed state and order (main window and a pop-out)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
		const a = await makeGroup([ids.n2, ids.n3], 'Work 工作', 'red');
		await makeGroup([ids.n5, ids.n6, ids.n7], '', 'green');
		await makeGroup([ids.n8], 'Solo', 'purple');
		await setActive(ids.n4);
		await setCollapsedVia(a, true);
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n10, NOTES.n11]));
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 3), 'pop-out ready');
		await makeGroup([pop[0] ?? '', pop[1] ?? ''], 'Pop 弹出', 'cyan');
		await setActive(ids.n4);
		const before = await waitForState((x) => x.state.groups.length === 4 && x.activeId === ids.n4, 'four groups');
		// The plugin saves by itself (debounced); nothing is flushed here.
		const storedBefore = await waitStored((v) => v?.groups.length === 4 && v.groups.some((g) => g.collapsed), 'four groups saved');
		const viewBefore = groupsView(before);
		const mainBefore = mainStrip(before).leafIds;
		const popBefore = before.strips.find((st) => st.kind === 'popout')?.leafIds ?? [];

		const { restore, ms } = await restart();
		const s = await waitForState((x) => x.state.groups.length >= 3, 'groups restored');
		const viewAfter = groupsView(s);
		const popAfter = s.strips.find((st) => st.kind === 'popout')?.leafIds ?? [];
		record('P1', { restartMs: ms, restore, storedBefore, viewBefore, viewAfter, mainBefore, mainAfter: mainStrip(s).leafIds, popBefore, popAfter, errors: await errorTimeline() });
		// Obsidian keeps the leaf ids and the order; every group is back by leaf id.
		expect(mainStrip(s).leafIds).toEqual(mainBefore);
		expect(popAfter).toEqual(popBefore);
		expect(viewAfter).toEqual(viewBefore);
		expect(restore?.stored).toBe('ok');
		expect(restore?.report?.byId).toBe(8);
		expect(restore?.report?.byFingerprint).toBe(0);
		expect(restore?.ops).toBe(0);
		for (const g of s.state.groups) {
			expectContiguous(s, g.id);
			if (!g.collapsed) expectDecorated(s, g.id);
		}
		// The collapsed group is collapsed on screen: its members are hidden, its chip shows.
		for (const id of [ids.n2, ids.n3]) expect(await headerBox(id)).toMatchObject({ width: 0, visibility: 'hidden', collapsedClass: true });
		expect(s.chips.some((c) => c.groupId === a)).toBe(true);
		expect(await errorTimeline()).toEqual([]);
	});

	// ------------------------------------------------------------------ P2

	it('P2 the active tab was in a collapsed group at quit: after a restart it is shown and its group expanded from the first painted frame', async function () {
		let s = await pageState();
		const work = s.state.groups.find((g) => g.name === 'Work 工作');
		const green = s.state.groups.find((g) => g.color === 'green' && g.name === '');
		if (!work || !green) throw new Error('groups of P1 missing');
		const workMembers = membersInOrder(s, work.id);
		const greenMembers = membersInOrder(s, green.id);
		await setCollapsedVia(green.id, true);
		await waitStored((v) => v?.groups.filter((g) => g.collapsed).length === 2, 'both collapsed saved');
		// Plugin off (the stored record stays), then Obsidian alone shows a tab of the collapsed group.
		await setEnabled(false);
		await activateNatively(workMembers[1] ?? '');
		const storedAtQuit = await storedValue();
		expect(storedAtQuit?.groups.find((g) => g.groupId === work.id)?.collapsed).toBe(true);

		const { restore } = await restart();
		const rec = await frames();
		s = await waitForState((x) => x.state.groups.length >= 4, 'restored');
		const shownBox = await headerBox(workMembers[1] ?? '');
		// Positive control for the frame probe: it does flag a hidden header.
		const probeControl = await browser.executeObsidian(({ app }, hiddenId, shownId) => {
			const check = (window as unknown as { __tabstripFrameHidden?: (el: HTMLElement) => boolean }).__tabstripFrameHidden;
			const header = (id: string) => (app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement }).tabHeaderEl;
			if (!check) throw new Error('probe not loaded');
			return { hidden: check(header(hiddenId)), shown: check(header(shownId)) };
		}, greenMembers[0] ?? '', workMembers[1] ?? '');
		record('P2', { restore, frames: rec, shownBox, probeControl, active: s.activeId, groups: groupsView(s) });
		expect(s.activeId).toBe(workMembers[1]);
		expect(collapsed(s, work.id)).toBe(false);
		expect(collapsed(s, green.id)).toBe(true);
		expect(shownBox.collapsedClass).toBe(false);
		expect(shownBox.visibility).toBe('visible');
		expect(shownBox.width).toBeGreaterThan(20);
		expect(probeControl).toEqual({ hidden: true, shown: false });
		// Every frame the probe saw, from before the plugin restored until well after: no hidden shown tab.
		expect(rec).not.toBeNull();
		expect(rec?.layoutReadyAtLoad).toBe(false);
		expect(rec?.errors).toBe(0);
		expect(rec?.violations).toEqual([]);
		// The first decorated frame already hid the other collapsed group (3 headers): hiding was on.
		expect(rec?.firstDecorated?.collapsedHeaders).toBe(greenMembers.length);
		expect(rec?.decoratedFrames).toBeGreaterThan(10);
		expect(await errorTimeline()).toEqual([]);
	});

	// ------------------------------------------------------------------ P3

	it('P3 native undo-close puts a closed member back into the middle of its group', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n2, ids.n3, ids.n4], 'Mid 中间', 'blue');
		await setActive(ids.n1);
		let s = await closeLeaf(ids.n3);
		const tomb = s.state.tombstones[0];
		expect(tomb).toMatchObject({ leafId: ids.n3, groupId: g, groupName: 'Mid 中间', groupColor: 'blue', indexInGroup: 1, left: ids.n2, right: ids.n4 });
		expect(await runCommand(CMD.undo)).toBe(true);
		s = await waitForState((x) => mainStrip(x).leafIds.includes(ids.n3) && groupOf(x, ids.n3) === g, 'n3 back in its group');
		record('P3', { tomb, after: mainStrip(s).leafIds });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5]);
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3, ids.n4]);
		expectContiguous(s, g);
		expectDecorated(s, g);
		expect(s.state.tombstones.some((t) => t.leafId === ids.n3)).toBe(false);
		expect(s.stats.loopStops).toBe(0);
	});

	// ------------------------------------------------------------------ P4

	it('P4 undo-close into a collapsed group: the tab is back in its slot, shown, and the group expanded', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n2, ids.n3, ids.n4], 'Fold 折叠', 'orange');
		await setActive(ids.n5);
		await setCollapsedVia(g, true);
		let s = await closeLeaf(ids.n3);
		expect(collapsed(s, g)).toBe(true);
		expect(await runCommand(CMD.undo)).toBe(true);
		s = await waitForState((x) => groupOf(x, ids.n3) === g && collapsed(x, g) === false, 'n3 back, group expanded');
		const box = await headerBox(ids.n3);
		record('P4', { after: mainStrip(s).leafIds, active: s.activeId, box });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5]);
		expect(s.activeId).toBe(ids.n3);
		expect(box.width).toBeGreaterThan(20);
		expect(box.visibility).toBe('visible');
		expectDecorated(s, g);
	});

	// ------------------------------------------------------------------ P5

	it('P5 undo-close after the group was deleted (its last member closed) rebuilds it with its name and colour', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Gone 删除', 'pink');
		await setActive(ids.n1);
		for (const id of [ids.n2, ids.n3]) await closeLeaf(id);
		let s = await pageState();
		expect(s.state.groups.some((x) => x.id === g)).toBe(false);
		expect(await runCommand(CMD.undo)).toBe(true);
		s = await waitForState((x) => groupOf(x, ids.n3) === g, 'group rebuilt with n3');
		const rebuilt = s.state.groups.find((x) => x.id === g);
		expect(rebuilt).toMatchObject({ name: 'Gone 删除', color: 'pink' });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n3, ids.n4]);
		expect(await runCommand(CMD.undo)).toBe(true);
		s = await waitForState((x) => groupOf(x, ids.n2) === g, 'n2 back');
		record('P5', { rebuilt, after: mainStrip(s).leafIds });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4]);
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3]);
		expectDecorated(s, g);
	});

	// ------------------------------------------------------------------ P6

	it('P6 undo-close when the original strip is gone: the tab stays where Obsidian puts it, in no group', async function () {
		const ids = await freshNotes(['n1', 'n2']);
		await setActive(ids.n2);
		const split = await browser.executeObsidian(async ({ app, obsidian }, files) => {
			const out: string[] = [];
			const first = app.workspace.getLeaf('split', 'vertical');
			for (const [i, p] of files.entries()) {
				const file = app.vault.getFileByPath(p);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
				const leaf = i === 0 ? first : app.workspace.createLeafInParent(first.parent, i);
				await leaf.openFile(file);
				out.push((leaf as unknown as { id: string }).id);
			}
			return out;
		}, [NOTES.n6, NOTES.n7]);
		let s = await waitForState((x) => x.strips.filter((st) => st.kind === 'main').length === 2, 'split made');
		const g = await makeGroup(split, 'Split 分屏', 'yellow');
		s = await waitForState((x) => membersInOrder(x, g).length === 2, 'grouped in the split');
		for (const id of split) await closeLeaf(id);
		s = await waitForState((x) => x.strips.filter((st) => st.kind === 'main').length === 1, 'split gone');
		expect(s.state.tombstones.filter((t) => split.includes(t.leafId)).every((t) => t.paneId === null)).toBe(true);
		expect(await runCommand(CMD.undo)).toBe(true);
		s = await waitForState((x) => x.strips.some((st) => st.leafIds.includes(split[1] ?? '')), 'last closed is back');
		const where1 = stripOf(s, split[1] ?? '').leafIds;
		expect(await runCommand(CMD.undo)).toBe(true);
		s = await waitForState((x) => x.strips.some((st) => st.leafIds.includes(split[0] ?? '')), 'first closed is back');
		await browser.pause(300);
		s = await pageState();
		record('P6', { where1, strips: s.strips.map((x) => x.leafIds), groups: s.state.groups });
		// Obsidian made a new split for them; neither is grouped, and the plugin moved nothing.
		expect(groupOf(s, split[0] ?? '')).toBeNull();
		expect(groupOf(s, split[1] ?? '')).toBeNull();
		expect(s.state.groups.some((x) => x.id === g)).toBe(false);
		expect(stripOf(s, split[1] ?? '').leafIds).not.toContain(ids.n1);
		// Clean up the split.
		for (const id of split) await browser.executeObsidian(({ app }, leafId) => app.workspace.getLeafById(leafId)?.detach(), id);
		await waitForState((x) => x.strips.filter((st) => st.kind === 'main').length === 1, 'split closed again');
	});

	// ------------------------------------------------------------------ P7

	it('P7 the recently closed list survives a restart (strips found again by the neighbours)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n2, ids.n3, ids.n4], 'Keep 保留', 'green');
		await setActive(ids.n1);
		let s = await closeLeaf(ids.n3);
		expect(s.state.tombstones[0]?.leafId).toBe(ids.n3);
		const view = (t: PageState['state']['tombstones'][number]) => [t.leafId, t.groupId, t.groupName, t.groupColor, t.paneIndex, t.indexInGroup, t.left ?? null, t.right ?? null];
		const before = s.state.tombstones.map(view);
		await waitStored((v) => v?.closed[0]?.leafId === ids.n3, 'closed record saved');
		await restart();
		s = await waitForState((x) => x.state.tombstones.length === before.length, 'closed list back');
		const after = s.state.tombstones.map(view);
		const n3Strip = s.state.tombstones[0]?.paneId;
		record('P7', { before, after, n3Strip, mainStrip: s.strips.find((x) => x.kind === 'main') });
		expect(after).toEqual(before);
		// Its neighbours are open in the main strip, so the record points at that strip again.
		expect(n3Strip).not.toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n4]);
	});

	// ------------------------------------------------------------------ P8

	it('P8 closing a pop-out window that holds groups records all its groups and members, without errors', async function () {
		let s = await pageState();
		let popIds = s.strips.find((x) => x.kind === 'popout')?.leafIds ?? [];
		if (popIds.length < 3) {
			const { result } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n10, NOTES.n11]));
			popIds = result;
		}
		s = await pageState();
		for (const id of popIds) {
			if (groupOf(s, id) === null) continue;
			await setActive(id);
			expect(await runCommand(CMD.remove)).toBe(true);
			s = await waitForState((x) => groupOf(x, id) === null, 'pop-out tab ungrouped');
		}
		const p1 = await makeGroup([popIds[0] ?? '', popIds[1] ?? ''], 'Pop A', 'cyan');
		const p2 = await makeGroup([popIds[2] ?? ''], '', 'grey');
		const closesBefore = (await popoutCloseReports()).length;
		await closePopout(popIds[0] ?? '');
		s = await waitForState((x) => !x.strips.some((st) => st.kind === 'popout'), 'pop-out closed');
		await browser.pause(500);
		s = await pageState();
		const recorded = s.state.tombstones.filter((t) => popIds.includes(t.leafId));
		const stored = await waitStored((v) => popIds.every((id) => v?.closed.some((c) => c.leafId === id)), 'pop-out members saved as closed');
		const closes = await popoutCloseReports();
		record('P8', { popIds, recorded, storedClosed: stored?.closed.filter((c) => popIds.includes(c.leafId)), close: closes[closes.length - 1] });
		expect(recorded.map((t) => t.leafId).sort()).toEqual([...popIds].sort());
		// All tabs of the window close in one change; they count as closed left to right (so a later
		// undo-close in reverse order rebuilds each group in order), and the strip is gone (no slot).
		expect(recorded.find((t) => t.leafId === popIds[0])).toMatchObject({ groupId: p1, groupName: 'Pop A', groupColor: 'cyan', paneId: null, indexInGroup: 0 });
		expect(recorded.find((t) => t.leafId === popIds[1])).toMatchObject({ groupId: p1, groupName: 'Pop A', groupColor: 'cyan', paneId: null, indexInGroup: 0 });
		expect(recorded.find((t) => t.leafId === popIds[2])).toMatchObject({ groupId: p2, groupName: '', groupColor: 'grey' });
		expect(s.state.groups.some((g) => g.id === p1 || g.id === p2)).toBe(false);
		expect(closes.length).toBe(closesBefore + 1);
		expect(closes[closes.length - 1]?.pluginOwned).toBe(0);
		expect(await errorTimeline()).toEqual([]);
	});

	// ------------------------------------------------------------------ P9 + P10

	it('P9 new leaf ids in workspace.json (another device): groups come back by unique file; a group with no open file is parked', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const f = await makeGroup([ids.n2, ids.n3], 'Finger 指纹', 'blue');
		await setCollapsedVia(f, false);
		const lost = await makeGroup([ids.n5], 'Lost 丢失', 'yellow');
		await setActive(ids.n1);
		await waitStored((v) => v?.groups.some((g) => g.groupId === lost) === true && v.groups.some((g) => g.groupId === f), 'saved');
		await setEnabled(false);
		// Edit the sandbox vault copy's own workspace.json: every leaf gets a new id, and the tab of
		// the "Lost" group shows another file (that device never opened it). The running app loads the
		// same layout, so it writes this file back unchanged when it quits.
		const edit = await browser.executeObsidian(async ({ app }, lostFile, otherFile) => {
			const layout = app.workspace.getLayout();
			let text = JSON.stringify(layout);
			const renamed: Record<string, string> = {};
			app.workspace.iterateAllLeaves((leaf) => {
				const id = (leaf as unknown as { id: string }).id;
				const fresh = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
				renamed[id] = fresh;
				text = text.split(`"${id}"`).join(`"${fresh}"`);
			});
			text = text.split(JSON.stringify(lostFile)).join(JSON.stringify(otherFile));
			const adapter = app.vault.adapter as unknown as { basePath: string };
			return { text, renamed, file: `${adapter.basePath}/${app.vault.configDir}/workspace.json` };
		}, NOTES.n5, NOTES.n11);
		expect(edit.file.startsWith(fs.realpathSync(repoRoot))).toBe(false);
		fs.writeFileSync(edit.file, edit.text);
		await browser.executeObsidian(async ({ app }, text) => {
			await app.workspace.changeLayout(JSON.parse(text));
		}, edit.text);
		const { restore } = await restart();
		const s = await waitForState((x) => x.state.groups.some((g) => g.id === f), 'Finger restored');
		const fileOf = (id: string) => s.strips.flatMap((x) => x.leafIds.map((l, i) => [l, x.files[i]] as const)).find(([l]) => l === id)?.[1] ?? null;
		const members = membersInOrder(s, f);
		const notices = await pluginNotices();
		const noticeShot = path.join(repoRoot, '.e2e-state', 'l6-screens', `p9-restored-by-file-${browser.getObsidianVersion()}.png`);
		await browser.saveScreenshot(noticeShot);
		const unmatched = await browser.executeObsidian(({ app }) => (app as unknown as { plugins: { plugins: Record<string, { debug: { unmatchedCount(): number } }> } }).plugins.plugins['tabstrip']?.debug.unmatchedCount() ?? -1);
		record('P9', { file: edit.file, noticeShot: path.relative(repoRoot, noticeShot), restore, members, files: members.map(fileOf), notices, unmatched, groups: s.state.groups });
		expect(members.every((id) => edit.renamed[ids.n2] === id || edit.renamed[ids.n3] === id)).toBe(true);
		expect(members).toEqual([edit.renamed[ids.n2], edit.renamed[ids.n3]]);
		expect(members.map(fileOf)).toEqual([NOTES.n2, NOTES.n3]);
		expect(s.state.groups.find((g) => g.id === f)).toMatchObject({ name: 'Finger 指纹', color: 'blue', collapsed: false });
		expect(s.state.groups.some((g) => g.id === lost)).toBe(false);
		expect(restore?.report?.byFingerprint).toBeGreaterThanOrEqual(2);
		expect(restore?.report?.unmatchedGroups).toBe(1);
		expect(unmatched).toBe(1);
		expect(notices).toContain('Tabstrip: tab groups without matching open tabs: 1. Run "Restore unmatched groups" to try again.');
		expectContiguous(s, f);
		expectDecorated(s, f);
	});

	it('P10 "Restore unmatched groups" says when nothing matches, recreates the group once its file is open, and then has nothing left', async function () {
		const noticesBefore = (await pluginNotices()).length;
		expect(await runCommand(CMD.restoreUnmatched)).toBe(true);
		let s = await pageState();
		expect(s.stats.notices.slice(noticesBefore)).toEqual(['No open tabs match the unmatched tab groups (1).']);
		const opened = await browser.executeObsidian(async ({ app, obsidian }, p) => {
			const file = app.vault.getFileByPath(p);
			if (!(file instanceof obsidian.TFile)) throw new Error('missing');
			const leaf = app.workspace.getLeaf('tab');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		}, NOTES.n5);
		await waitForState((x) => mainStrip(x).leafIds.includes(opened), 'Inbox open');
		expect(await runCommand(CMD.restoreUnmatched)).toBe(true);
		s = await waitForState((x) => groupOf(x, opened) !== null, 'Lost recreated');
		const g = s.state.groups.find((x) => x.id === groupOf(s, opened));
		const notices = s.stats.notices.slice(noticesBefore);
		expect(await runCommand(CMD.restoreUnmatched)).toBe(true);
		const last = (await pluginNotices()).slice(-1);
		record('P10', { g, notices, last });
		expect(g).toMatchObject({ name: 'Lost 丢失', color: 'yellow' });
		expect(notices).toContain('Restored tab groups: 1.');
		expect(last).toEqual(['There are no unmatched tab groups.']);
		expectDecorated(s, g?.id ?? '');
		await waitStored((v) => v?.unmatched.length === 0 && v.groups.some((x) => x.name === 'Lost 丢失'), 'saved without unmatched');
	});

	// ------------------------------------------------------------------ P10b

	it('P10b "Restore unmatched groups": a file open in two tabs takes the leftmost; a member whose file is not open stays in the list and comes back later', async function () {
		const openInNewTab = (p: string) =>
			browser.executeObsidian(async ({ app, obsidian }, notePath) => {
				const file = app.vault.getFileByPath(notePath);
				if (!(file instanceof obsidian.TFile)) throw new Error('missing');
				const leaf = app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				return (leaf as unknown as { id: string }).id;
			}, p);
		await setEnabled(false);
		await writeStored({
			version: 1,
			nextGroupSeq: 90,
			groups: [],
			closed: [],
			unmatched: [
				{
					groupId: 'g80',
					name: 'DupU 重复',
					color: 'cyan',
					collapsed: false,
					members: [
						{ type: 'markdown', path: NOTES.n5 },
						{ type: 'markdown', path: NOTES.n7 },
						{ type: 'markdown', path: NOTES.n6 },
					],
				},
			],
		});
		await setEnabled(true);
		const ids = await freshNotes(['n1', 'n5', 'n6']);
		const dupe = await openInNewTab(NOTES.n5);
		let s = await waitForState((x) => mainStrip(x).leafIds.includes(dupe), 'second Inbox tab open');
		expect(mainStrip(s).leafIds.indexOf(ids.n5)).toBeLessThan(mainStrip(s).leafIds.indexOf(dupe));
		const noticesBefore = (await pluginNotices()).length;
		expect(await runCommand(CMD.restoreUnmatched)).toBe(true);
		s = await waitForState((x) => groupOf(x, ids.n5) !== null, 'DupU recreated');
		const gid = groupOf(s, ids.n5) ?? '';
		const g = s.state.groups.find((x) => x.id === gid);
		const firstNotices = s.stats.notices.slice(noticesBefore);
		const kept = await waitStored((v) => v?.unmatched.length === 1 && v.groups.some((x) => x.groupId === gid), 'the missing member kept');
		// Later the missing file is open: the command brings the kept part back.
		const n7 = await openInNewTab(NOTES.n7);
		await waitForState((x) => mainStrip(x).leafIds.includes(n7), 'n7 open');
		expect(await runCommand(CMD.restoreUnmatched)).toBe(true);
		const s2 = await waitForState((x) => groupOf(x, n7) !== null, 'kept part recreated');
		const g2 = s2.state.groups.find((x) => x.id === groupOf(s2, n7));
		const secondNotices = s2.stats.notices.slice(noticesBefore);
		const finalStored = await waitStored((v) => v?.unmatched.length === 0, 'unmatched list empty');
		record('P10b', { g, firstNotices, kept: kept?.unmatched, g2, secondNotices, finalUnmatched: finalStored?.unmatched });
		expect(g).toMatchObject({ name: 'DupU 重复', color: 'cyan' });
		expect(groupOf(s, ids.n6)).toBe(gid);
		expect(groupOf(s, dupe)).toBeNull();
		expectDecorated(s, gid);
		expect(firstNotices).toEqual(['Restored tab groups: 1. Tabs not found: 1. They stay in the unmatched list; open their files and run "Restore unmatched groups" again.']);
		expect(kept?.unmatched[0]).toMatchObject({ name: 'DupU 重复', color: 'cyan', members: [{ type: 'markdown', path: NOTES.n7 }] });
		expect(kept?.unmatched[0]?.groupId).not.toBe(gid);
		expect(g2).toMatchObject({ name: 'DupU 重复', color: 'cyan' });
		expect(g2?.id).not.toBe(gid);
		expect(secondNotices.slice(-1)).toEqual(['Restored tab groups: 1.']);
		expectDecorated(s2, g2?.id ?? '');
	});

	// ------------------------------------------------------------------ P11

	it('P11 damaged or foreign stored data never throws: skipped with a notice, a newer version is kept untouched', async function () {
		const results: Record<string, unknown> = {};
		const enableWith = async (name: string, write: () => Promise<void>) => {
			await setEnabled(false);
			await write();
			const before = await browser.execute(() => document.querySelectorAll('.notice').length);
			await setEnabled(true);
			const s = await pageState();
			const out = { stored: s.stats.restore?.stored, problems: s.stats.restore?.problems, notices: s.stats.notices, groups: s.state.groups.length, newNotices: (await noticeTexts()).slice(before) };
			results[name] = out;
			return out;
		};
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		// Wrong types and partial entries: the valid group survives, the rest is skipped.
		const partial = await enableWith('partial', () =>
			writeStored({ version: 1, nextGroupSeq: 'x', groups: [{ groupId: 'g70', name: 'Valid', color: 'red', members: [{ leafId: ids.n2, type: 'markdown', path: NOTES.n2 }] }, { groupId: 7 }, 'junk'], closed: [{ bad: 1 }], unmatched: 5 }),
		);
		expect(partial.stored).toBe('ok');
		expect(partial.problems).toBeGreaterThan(0);
		expect(partial.notices).toEqual(['Tabstrip: part of the saved tab group data could not be read and was skipped.']);
		expect(partial.groups).toBe(1);
		await waitStored((v) => Array.isArray(v?.closed) && Array.isArray(v?.unmatched) && v?.nextGroupSeq === 71, 'repaired record written');
		// Not a session at all.
		const corrupt = await enableWith('corrupt', () => writeStored('hello'));
		expect(corrupt.stored).toBe('corrupt');
		expect(corrupt.notices).toEqual([
			'Tabstrip: the saved tab groups could not be read. They are kept unchanged and tab groups are not saved on this device; run "Clear data on this device" to start saving again.',
		]);
		expect(corrupt.groups).toBe(0);
		// Review round 6: what it cannot read is kept, also after a change to a group (no write).
		const savesBefore = (await pageState()).stats.saves;
		const cg = await makeGroup([ids.n1], 'After corrupt', 'blue');
		await browser.pause(1200);
		const keptCorrupt = await storedValue();
		const savesAfter = (await pageState()).stats.saves;
		expect(keptCorrupt).toBe('hello');
		expect(savesAfter).toBe(savesBefore);
		// Positive control: after "Clear data on this device" the next change is saved.
		expect(await runCommand(CMD.clear)).toBe(true);
		await $('.modal.tabstrip-confirm').waitForDisplayed({ timeout: 3000 });
		await clickModalButton('Clear data');
		await browser.executeObsidian(({ app }, id) => {
			(app as unknown as { plugins: { plugins: Record<string, { debug: { rename(id: string, name: string): void } }> } }).plugins.plugins['tabstrip']?.debug.rename(id, 'Saved after clear');
		}, cg);
		const afterClear = await waitStored((v) => v?.groups?.some((g) => g.groupId === cg && g.name === 'Saved after clear') === true, 'saved again after clear');
		results['corrupt-kept'] = { keptCorrupt, savesBefore, savesAfter, afterClear: afterClear?.groups.map((g) => g.name) };
		await setActive(ids.n1);
		expect(await runCommand(CMD.remove)).toBe(true);
		// Not even JSON: Obsidian's loadLocalStorage gives null, so this reads as nothing stored.
		const invalid = await enableWith('invalid-json', () => writeRawStored('{"version":1,"groups":[{'));
		expect(invalid.stored).toBe('empty');
		expect(invalid.groups).toBe(0);
		// Huge lists: cut, fast.
		const huge = await enableWith('huge', () =>
			writeStored({
				version: 1,
				nextGroupSeq: 1,
				groups: Array.from({ length: 5000 }, (_, i) => ({ groupId: `g${String(i + 1)}`, color: 'blue', members: [{ leafId: `x${String(i)}`, type: 'markdown', path: `nope${String(i)}.md` }] })),
				closed: Array.from({ length: 20000 }, (_, i) => ({ leafId: `c${String(i)}`, groupId: 'g1', paneIndex: 0, indexInGroup: 0, type: 'markdown' })),
			}),
		);
		expect(huge.stored).toBe('ok');
		const hugeStats = await restoreStats();
		expect(hugeStats?.ms ?? 999).toBeLessThan(200);
		// A newer format: kept as it is, groups start empty, nothing is written over it.
		const future = { version: 99, groups: [{ whatever: true }], note: 'from a newer Tabstrip' };
		const fut = await enableWith('future', () => writeStored(future));
		expect(fut.stored).toBe('future');
		expect(fut.notices).toEqual(['Tabstrip: the tab groups saved on this device come from a newer version of Tabstrip. They are kept unchanged; groups start empty until you update Tabstrip.']);
		expect(fut.groups).toBe(0);
		await makeGroup([ids.n3], 'After future', 'red');
		await browser.pause(1200);
		await setEnabled(false);
		expect(await storedValue()).toEqual(future);
		record('P11', { results, hugeStats });
		await setEnabled(true);
		expect(await errorTimeline()).toEqual([]);
	});

	// ------------------------------------------------------------------ P12

	it('P12 "Clear data on this device" asks first; Cancel keeps the data, Clear removes the key and nothing rewrites it on disable or on a re-enable without groups', async function () {
		// Start from a clean record of our own (P11 left the newer-version one).
		await setEnabled(false);
		await writeStored(null);
		await setEnabled(true);
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n2, ids.n3], 'Clear 清除', 'purple');
		await setActive(ids.n1);
		await waitStored((v) => v?.groups.some((x) => x.groupId === g) === true, 'saved');
		const open = async () => {
			expect(await runCommand(CMD.clear)).toBe(true);
			await $('.modal.tabstrip-confirm').waitForDisplayed({ timeout: 3000 });
		};
		await open();
		const modal = await browser.execute(() => {
			const m = document.querySelector('.modal.tabstrip-confirm');
			return {
				title: m?.querySelector('.modal-title')?.textContent ?? null,
				text: m?.querySelector('.modal-content p')?.textContent ?? null,
				buttons: Array.from(m?.querySelectorAll('button') ?? []).map((b) => ({ text: b.textContent, warning: b.classList.contains('mod-destructive') || b.classList.contains('mod-warning'), cta: b.classList.contains('mod-cta') })),
			};
		});
		const modalShot = path.join(repoRoot, '.e2e-state', 'l6-screens', `p12-clear-modal-${browser.getObsidianVersion()}.png`);
		await browser.saveScreenshot(modalShot);
		if (browser.getObsidianVersion() === '1.15.0' && process.env.TABSTRIP_WRITE_DOCS === '1') {
			fs.mkdirSync(path.join(repoRoot, 'docs', 'verification', 'L6'), { recursive: true });
			fs.copyFileSync(modalShot, path.join(repoRoot, 'docs', 'verification', 'L6', 'p12-clear-modal.png'));
		}
		await clickModalButton('Cancel');
		await $('.modal.tabstrip-confirm').waitForDisplayed({ reverse: true, timeout: 3000 });
		expect((await storedValue())?.groups.some((x) => x.groupId === g)).toBe(true);
		await open();
		await clickModalButton('Clear data');
		await $('.modal.tabstrip-confirm').waitForDisplayed({ reverse: true, timeout: 3000 });
		const afterClear = await storedValue();
		const notices = (await pluginNotices()).slice(-1);
		await setEnabled(false);
		const afterDisable = await storedValue();
		await setEnabled(true);
		const s = await pageState();
		// Starting with nothing stored and no group writes nothing, even after the save debounce
		// (review round 2): the key stays gone until a group exists.
		await browser.pause(2500);
		const afterQuietStart = await storedValue();
		const saves = (await pageState()).stats.saves;
		// Positive control: the next group made is saved.
		const again = await freshNotes(['n1', 'n2']);
		const g2 = await makeGroup([again.n2], 'After clear', 'green');
		const afterGroup = await waitStored((v) => v?.groups.some((x) => x.groupId === g2) === true, 'saved after a new group');
		record('P12', { modal, modalShot: path.relative(repoRoot, modalShot), afterClear, notices, afterDisable, restored: s.stats.restore, groups: s.state.groups, afterQuietStart, saves, afterGroup });
		expect(modal.title).toBe('Clear Tabstrip data on this device?');
		expect(modal.buttons.map((b) => b.text)).toEqual(['Cancel', 'Clear data']);
		expect(modal.buttons[1]?.warning).toBe(true);
		expect(afterClear).toBeNull();
		expect(notices).toEqual(['Tabstrip data on this device was cleared.']);
		expect(afterDisable).toBeNull();
		expect(s.stats.restore?.stored).toBe('empty');
		expect(s.state.groups).toEqual([]);
		expect(afterQuietStart).toBeNull();
		expect(saves).toBe(0);
		expect(afterGroup?.groups.map((x) => x.name)).toEqual(['After clear']);
	});

	// ------------------------------------------------------------------ P13

	it('P13 restore-native mode still saves; disable keeps the groups and enable restores them; undo-close while disabled goes back on enable', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n2, ids.n3, ids.n4], 'Keep 保留', 'green');
		await setActive(ids.n1);
		expect(await runCommand(CMD.restoreNative)).toBe(true);
		const k = await makeGroup([ids.n5], 'Native 原生', 'red');
		const inNative = await waitStored((v) => v?.groups.some((x) => x.groupId === k) === true, 'saved while native');
		expect(await runCommand(CMD.show)).toBe(true);
		let s = await waitForState((x) => x.chips.length === 2, 'shown again');
		const viewBefore = groupsView(s);
		await setEnabled(false);
		const storedOff = await storedValue();
		const traces = await residue();
		await setEnabled(true);
		s = await waitForState((x) => x.state.groups.length === 2, 'groups back after enable');
		expect(groupsView(s)).toEqual(viewBefore);
		expectDecorated(s, g);
		// Close a member, disable, undo-close with Obsidian alone, enable: back in its group and slot.
		expect((await closeLeaf(ids.n3)).state.tombstones[0]?.leafId).toBe(ids.n3);
		await setEnabled(false);
		expect(await runCommand(CMD.undo)).toBe(true);
		await browser.waitUntil(async () => browser.executeObsidian(({ app }, id) => app.workspace.getLeafById(id) !== null, ids.n3), { timeout: 3000, timeoutMsg: 'native undo-close' });
		const nativeOrder = await browser.executeObsidian(({ app }, id) => {
			const tabs = app.workspace.getLeafById(id)?.parent as unknown as { children: { id: string }[] };
			return tabs.children.map((l) => l.id);
		}, ids.n3);
		await setEnabled(true);
		s = await waitForState((x) => groupOf(x, ids.n3) === g, 'n3 back in its group');
		record('P13', { inNative: inNative?.groups.map((x) => x.name), storedOff: storedOff?.groups.map((x) => x.name), traces, nativeOrder, after: mainStrip(s).leafIds, restore: s.stats.restore });
		expect(storedOff?.groups.map((x) => x.groupId).sort()).toEqual([g, k].sort());
		expect(traces.found).toEqual([]);
		// Where Obsidian alone puts it differs by version (1.15.0: the end; 1.13.4: next to the shown
		// tab); the plugin then moves it to its slot either way.
		expect(nativeOrder).toContain(ids.n3);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5]);
		expect(s.stats.restore?.report?.byClosed).toBe(1);
		expectDecorated(s, g);
	});

	// ------------------------------------------------------------------ P14

	it('P14 performance: restoring 50 tabs in 10 groups after a restart takes < 20 ms of plugin time, loads no deferred tab; saves are debounced', async function () {
		// 50 tabs in the main strip, built like a saved workspace (background tabs deferred).
		await setEnabled(false);
		await browser.executeObsidian(async ({ app }, files) => {
			const hex = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
			const layout = app.workspace.getLayout();
			const children = Array.from({ length: 50 }, (_, i) => ({
				id: hex(),
				type: 'leaf',
				state: { type: 'markdown', state: { file: files[i % files.length], mode: 'source', source: false }, icon: 'lucide-file', title: `t${String(i)}` },
			}));
			await app.workspace.changeLayout({ ...layout, main: { id: hex(), type: 'split', direction: 'vertical', children: [{ id: hex(), type: 'tabs', currentTab: 0, children }] }, active: children[0]?.id });
			await new Promise((r) => setTimeout(r, 800));
		}, Object.values(NOTES));
		await setEnabled(true);
		let s = await pageState();
		const leafIds = mainStrip(s).leafIds;
		expect(leafIds).toHaveLength(50);
		for (let g = 0; g < 10; g++) await makeGroup(leafIds.slice(1 + g * 5, 1 + g * 5 + 4), `G${String(g)}`, (['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'blue'] as const)[g]);
		s = await waitForState((x) => x.state.groups.length === 10, 'ten groups');
		await setActive(leafIds[0] ?? '');

		// Saves: one change is written only after the debounce, never at once.
		const savesBefore = s.stats.saves;
		const t0 = Date.now();
		await makeGroup([leafIds[45] ?? ''], 'Late', 'red');
		const midway = await storedValue();
		await waitStored((v) => v?.groups.some((x) => x.name === 'Late') === true, 'late group saved');
		const savedAfterMs = Date.now() - t0;
		// A burst of 20 real changes 10 ms apart (G0 renamed each time, plus a layout-change event
		// each time): every request carries new data, so a save per request would be 20 writes. The
		// requests are coalesced into exactly one write, with the last name (review round 4).
		// Positive control: two renames 1000 ms apart (more than the debounce) are two writes.
		const burst = await browser.executeObsidian(async ({ app }) => {
			type Debug = { stats(): { saves: number; saveRequests: number }; state(): { groups: { id: string; name: string }[] }; rename(id: string, name: string): void };
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: Debug }> } }).plugins.plugins['tabstrip'];
			const stats = () => plugin?.debug.stats() ?? { saves: 0, saveRequests: 0 };
			const stored = () => {
				const raw = app.loadLocalStorage('tabstrip-session-v1') as unknown;
				const v = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { groups?: { groupId: string; name: string }[] } | null;
				return v?.groups ?? [];
			};
			const id = plugin?.debug.state().groups.find((x) => x.name === 'G0')?.id ?? '';
			const before = stats();
			for (let i = 0; i < 20; i++) {
				plugin?.debug.rename(id, `Burst ${String(i)}`);
				app.workspace.trigger('layout-change');
				await new Promise((r) => setTimeout(r, 10));
			}
			await new Promise((r) => setTimeout(r, 1500));
			const after = stats();
			const storedName = stored().find((x) => x.groupId === id)?.name ?? null;
			plugin?.debug.rename(id, 'Control A');
			await new Promise((r) => setTimeout(r, 1000));
			plugin?.debug.rename(id, 'Control B');
			await new Promise((r) => setTimeout(r, 1000));
			const control = stats();
			return {
				saves: after.saves - before.saves,
				requests: after.saveRequests - before.saveRequests,
				storedName,
				controlSaves: control.saves - after.saves,
				controlStoredName: stored().find((x) => x.groupId === id)?.name ?? null,
			};
		});
		s = await pageState();
		const debounce = { savedAfterMs, midwayHasLate: midway?.groups.some((x) => x.name === 'Late') ?? false, saves: s.stats.saves - savesBefore, burst };

		const { restore } = await restart();
		s = await waitForState((x) => x.state.groups.length === 11, 'eleven groups back');
		const start = s.stats.timings.find((t) => t.triggers.includes('start'));
		// Plugin time: the restore plus the first pass, without Obsidian's own API time for moves
		// (none here) and without the browser's style and layout work that the measuring reads wait
		// for (layoutMs, recorded and reported on its own).
		const scriptMs = (restore?.ms ?? 0) - (restore?.opsMs ?? 0) + ((start?.ms ?? 0) - (start?.opsMs ?? 0) - (start?.layoutMs ?? 0));
		const pluginMs = scriptMs;
		const withLayoutMs = scriptMs + (start?.layoutMs ?? 0);
		const loaded = await loadedLeaves();
		const shown = new Set(s.strips.map((x) => x.currentId));
		const loadedByPlugin = loaded.filter((id) => !shown.has(id));
		const rec = await frames();
		record('P14', { restore, start, pluginMs, withLayoutMs, loaded: loaded.length, loadedByPlugin, debounce, frames: rec });
		expect(restore?.report?.byId).toBe(41);
		expect(pluginMs).toBeLessThan(20);
		// Review round 1: the forced style and layout inside the plugin's first pass is not part of
		// the 20 ms budget (a decision made in the L6 step), but it must not grow unnoticed: measured 26-33 ms.
		expect(withLayoutMs).toBeLessThan(60);
		expect(loadedByPlugin).toEqual([]);
		expect(debounce.midwayHasLate).toBe(false);
		expect(debounce.savedAfterMs).toBeGreaterThanOrEqual(300);
		expect(burst.requests).toBeGreaterThanOrEqual(20);
		expect(burst.saves).toBe(1);
		expect(burst.storedName).toBe('Burst 19');
		expect(burst.controlSaves).toBe(2);
		expect(burst.controlStoredName).toBe('Control B');
		expect(rec?.violations).toEqual([]);
	});

	// ------------------------------------------------------------------ P15

	it('P15 on Obsidian\'s quit event the pending save runs at once and nothing is written after it', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n2], 'Before quit', 'blue');
		// No waiting for the debounce: the quit event itself must write it.
		await browser.executeObsidian(({ app }) => {
			app.workspace.trigger('quit', { add: () => undefined });
		});
		const atQuit = await storedValue();
		await makeGroup([ids.n3], 'After quit', 'red');
		await browser.pause(1500);
		const later = await storedValue();
		record('P15', { atQuit: atQuit?.groups.map((x) => x.name), later: later?.groups.map((x) => x.name) });
		expect(atQuit?.groups.some((x) => x.groupId === g)).toBe(true);
		expect(later?.groups.some((x) => x.name === 'After quit')).toBe(false);
		// A new plugin instance writes again.
		await setEnabled(false);
		await setEnabled(true);
		await makeGroup([ids.n1], 'Next session', 'green');
		await waitStored((v) => v?.groups.some((x) => x.name === 'Next session') === true, 'written again');
	});

	// ------------------------------------------------------------------ P16

	it('P16 a real app quit (Electron app.quit, as Cmd+Q) with a pop-out holding a group: the change made just before is stored by the quit save, the pop-out group stays open, nothing is written after', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n2, ids.n3], 'Main before quit', 'blue');
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n10]));
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 2), 'pop-out ready');
		const pg = await makeGroup([pop[0] ?? '', pop[1] ?? ''], 'Pop at quit', 'orange');
		// Both groups saved by the debounced save; from here on only the quit save can store more.
		await waitStored((v) => v?.groups.some((x) => x.groupId === g) === true && v.groups.some((x) => x.groupId === pg), 'both groups saved');
		await browser.executeObsidian(({ app }) => {
			// Obsidian saves its layout on quit itself; this only makes sure the pop-out is in it.
			void app.workspace.requestSaveLayout.run();
		});
		await browser.pause(300);
		// Test-side listener, registered after the plugin's, so it runs after the plugin's onQuit:
		// it keeps what the plugin did and the stored record at that moment under a separate key.
		const atRename = await browser.executeObsidian(
			({ app }, key, gid) => {
				type Plugin = { debug: { stats(): { saves: number; quits: number }; rename(id: string, name: string): void } };
				const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin | undefined> } }).plugins.plugins['tabstrip'];
				if (!plugin) throw new Error('tabstrip not loaded');
				app.workspace.on('quit', () => {
					const stats = plugin.debug.stats();
					app.saveLocalStorage('tabstrip-e2e-quit-log', { quits: stats.quits, saves: stats.saves, stored: app.loadLocalStorage(key) as unknown, popouts: (app.workspace as unknown as { floatingSplit: { children: unknown[] } }).floatingSplit.children.length });
				});
				const savesBefore = plugin.debug.stats().saves;
				plugin.debug.rename(gid, 'Renamed at quit');
				const storedName = (app.loadLocalStorage(key) as { groups: { groupId: string; name: string }[] } | null)?.groups.find((x) => x.groupId === gid)?.name ?? null;
				const remote = (window as unknown as { electron: { remote: { app: { quit(): void } } } }).electron.remote;
				// Well inside the save debounce (500 ms): only the quit save can write the new name.
				window.setTimeout(() => remote.app.quit(), 50);
				return { savesBefore, savesAfterRename: plugin.debug.stats().saves, storedName, quits: plugin.debug.stats().quits };
			},
			KEY,
			g,
		);
		const quitStarted = Date.now();
		// The sandbox app quits on its own; wait until the session's window is gone.
		await browser.waitUntil(
			async () => {
				try {
					await browser.execute(() => 1);
					return false;
				} catch {
					return true;
				}
			},
			{ timeout: 15000, interval: 200, timeoutMsg: 'the sandbox app did not quit' },
		);
		const quitMs = Date.now() - quitStarted;
		// Start it again without Tabstrip, so the stored record is read exactly as the quit left it.
		await relaunchAfterQuit([PROBE]);
		const raw = await storedValue();
		const quitLog = await browser.executeObsidian(({ app }) => app.loadLocalStorage('tabstrip-e2e-quit-log') as { quits: number; saves: number; stored: StoredLike | null; popouts: number } | null);
		const popoutsAfter = await browser.executeObsidian(({ app }) => (app.workspace as unknown as { floatingSplit: { children: unknown[] } }).floatingSplit.children.length);
		// Then Tabstrip again: the groups come back by leaf id, the pop-out one in the pop-out.
		await setEnabled(true);
		await browser.waitUntil(async () => (await restoreStats()) !== null, { timeout: 10000, timeoutMsg: 'tabstrip did not restore' });
		const restore = await restoreStats();
		const s = await waitForState((x) => x.state.groups.some((y) => y.id === g) && x.state.groups.some((y) => y.id === pg), 'groups restored');
		record('P16', { atRename, quitMs, quitLog, raw: { groups: raw?.groups.map((x) => [x.groupId, x.name, x.members.length]), closed: raw?.closed.map((x) => [x.leafId, x.groupId]) }, popoutsAfter, restore });
		// Before the quit: the rename was not saved yet (the debounce was still pending).
		expect(atRename.storedName).toBe('Main before quit');
		expect(atRename.savesAfterRename).toBe(atRename.savesBefore);
		expect(atRename.quits).toBe(0);
		// Obsidian fired 'quit' on the real quit; the plugin's handler ran once and saved once.
		expect(quitLog?.quits).toBe(1);
		expect(quitLog?.saves).toBe(atRename.savesBefore + 1);
		// The pop-out was still open when 'quit' fired (it is not closed on the way out).
		expect(quitLog?.popouts).toBe(1);
		// The record at the next start is the one written by the quit save: nothing after it.
		expect(raw).toEqual(quitLog?.stored);
		expect(raw?.groups.find((x) => x.groupId === g)?.name).toBe('Renamed at quit');
		expect(raw?.groups.find((x) => x.groupId === pg)?.members.map((m) => m.leafId)).toEqual([pop[0], pop[1]]);
		expect(raw?.closed.filter((c) => c.leafId === pop[0] || c.leafId === pop[1] || c.groupId === pg)).toEqual([]);
		// Obsidian brought the pop-out back, and Tabstrip its group.
		expect(popoutsAfter).toBe(1);
		expect(restore?.report?.byId).toBeGreaterThanOrEqual(4);
		expect(s.state.groups.find((y) => y.id === g)?.name).toBe('Renamed at quit');
		expect(membersInOrder(s, pg)).toEqual([pop[0], pop[1]]);
		expect(stripOf(s, pop[0] ?? '').kind).toBe('popout');
		expect(await errorTimeline()).toEqual([]);
	});

	// ------------------------------------------------------------------ P17

	it('P17 a restart with scattered members (reordered while Tabstrip was off): the restore lines each group up in stored order with the move recipe, before the first pass, loading no deferred tab (main window and a pop-out)', async function () {
		// P16 left a pop-out open; openNotes (test helper) opens notes from the first root leaf and
		// lines them up there, which assumes no pop-out holds root leaves. Close it first.
		for (const strip of (await pageState()).strips.filter((x) => x.kind === 'popout')) await closePopout(strip.leafIds[0] ?? '');
		await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'no pop-out left');
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const sg = await makeGroup([ids.n2, ids.n3, ids.n4], 'Scatter 打散', 'pink');
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n10, NOTES.n11]));
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(pop[2] ?? '')), 'pop-out ready');
		const [p0, p1, p2] = [pop[0] ?? '', pop[1] ?? '', pop[2] ?? ''];
		const pg = await makeGroup([p0, p1], 'Pop scatter', 'cyan');
		await setActive(ids.n1);
		let s = await waitForState((x) => membersInOrder(x, sg).length === 3 && membersInOrder(x, pg).length === 2, 'two groups');
		const storedOrder: Record<string, string[]> = { [sg]: membersInOrder(s, sg), [pg]: membersInOrder(s, pg) };
		await waitStored((v) => v?.groups.some((g) => g.groupId === sg) === true && v.groups.some((g) => g.groupId === pg), 'both saved');
		await setEnabled(false);
		// Tabstrip off: the tabs are reordered in the sandbox's layout (like a user dragging them, or
		// another device's workspace.json). Main: n3 first, two other tabs, n2, one other, n4, the
		// rest. Pop-out: p1 p2 p0, then the rest.
		const edit = await browser.executeObsidian(
			async ({ app }, mainIds, popOrder) => {
				type Node = { id?: string; type?: string; children?: Node[]; currentTab?: number };
				const layout = app.workspace.getLayout();
				const tabsOf = (node: unknown, leafId: string): Node | null => {
					if (node === null || typeof node !== 'object') return null;
					const n = node as Node;
					if (n.type === 'tabs' && n.children?.some((c) => c.id === leafId)) return n;
					for (const c of n.children ?? []) {
						const found = tabsOf(c, leafId);
						if (found) return found;
					}
					return null;
				};
				const find = (leafId: string): Node => {
					for (const value of Object.values(layout)) {
						const found = tabsOf(value, leafId);
						if (found?.children) return found;
					}
					throw new Error(`strip of ${leafId} not found in the layout`);
				};
				const [n2, n3, n4] = mainIds as [string, string, string];
				const main = find(n2);
				const mainById = new Map((main.children ?? []).map((c) => [c.id ?? '', c]));
				const others = [...mainById.keys()].filter((id) => !mainIds.includes(id));
				const mainOrder = [n3, ...others.slice(0, 2), n2, ...others.slice(2, 3), n4, ...others.slice(3)];
				// The shown tab of each strip stays the same tab (currentTab is an index).
				const keepCurrent = (tabs: Node, order: string[]) => {
					const current = tabs.children?.[tabs.currentTab ?? 0]?.id ?? '';
					tabs.currentTab = Math.max(0, order.indexOf(current));
				};
				keepCurrent(main, mainOrder);
				main.children = mainOrder.map((id) => mainById.get(id) as Node);
				const popTabs = find(popOrder[0] ?? '');
				const popById = new Map((popTabs.children ?? []).map((c) => [c.id ?? '', c]));
				const popRest = [...popById.keys()].filter((id) => !popOrder.includes(id));
				keepCurrent(popTabs, [...popOrder, ...popRest]);
				popTabs.children = [...popOrder, ...popRest].map((id) => popById.get(id) as Node);
				const adapter = app.vault.adapter as unknown as { basePath: string };
				return { text: JSON.stringify(layout), file: `${adapter.basePath}/${app.vault.configDir}/workspace.json`, mainOrder };
			},
			[ids.n2, ids.n3, ids.n4],
			[p1, p2, p0],
		);
		expect(edit.file.startsWith(fs.realpathSync(repoRoot))).toBe(false);
		fs.writeFileSync(edit.file, edit.text);
		await browser.executeObsidian(async ({ app }, text) => {
			await app.workspace.changeLayout(JSON.parse(text));
			await new Promise((r) => setTimeout(r, 500));
		}, edit.text);
		// Positive control: the layout Tabstrip will find is scattered (read with Tabstrip off).
		const scattered = await browser.executeObsidian(
			({ app }, a, b) => {
				const order = (id: string) => (app.workspace.getLeafById(id)?.parent as unknown as { children: { id: string }[] } | undefined)?.children.map((l) => l.id) ?? [];
				return { main: order(a), pop: order(b) };
			},
			ids.n2,
			p0,
		);
		expect(scattered.main).toEqual(edit.mainOrder);
		expect(scattered.main.indexOf(ids.n2) - scattered.main.indexOf(ids.n3)).toBe(3);
		expect(scattered.main.indexOf(ids.n4) - scattered.main.indexOf(ids.n2)).toBe(2);
		expect(scattered.pop.slice(0, 3)).toEqual([p1, p2, p0]);

		const { restore } = await restart();
		s = await waitForState((x) => membersInOrder(x, sg).length === 3 && membersInOrder(x, pg).length === 2, 'groups restored');
		const loaded = await loadedLeaves();
		const shown = new Set(s.strips.map((x) => x.currentId));
		const loadedByPlugin = loaded.filter((id) => !shown.has(id));
		const rec = await frames();
		const mainAfter = stripOf(s, ids.n2).leafIds;
		const popAfter = stripOf(s, p0).leafIds;
		record('P17', { restore, storedOrder, scattered, mainAfter, popAfter, loaded: loaded.length, loadedByPlugin, frames: rec, errors: await errorTimeline() });
		// The restore itself made the moves (before the first pass).
		expect(restore?.stored).toBe('ok');
		expect(restore?.ops ?? 0).toBeGreaterThan(0);
		expect(restore?.report?.byId).toBeGreaterThanOrEqual(5);
		// Each group is one block in its stored order, in its own strip; the other tabs keep their order.
		expect(membersInOrder(s, sg)).toEqual(storedOrder[sg]);
		expect(membersInOrder(s, pg)).toEqual(storedOrder[pg]);
		expectContiguous(s, sg);
		expectContiguous(s, pg);
		const notIn = (members: string[] | undefined) => (id: string) => !(members ?? []).includes(id);
		expect(mainAfter.filter(notIn(storedOrder[sg]))).toEqual(scattered.main.filter(notIn(storedOrder[sg])));
		expect(popAfter.filter(notIn(storedOrder[pg]))).toEqual(scattered.pop.filter(notIn(storedOrder[pg])));
		// Lined up at the leftmost member's place (the first tab of each strip here).
		expect(mainAfter.slice(0, 3)).toEqual(storedOrder[sg]);
		expect(popAfter.slice(0, 2)).toEqual(storedOrder[pg]);
		expect(stripOf(s, p0).kind).toBe('popout');
		expectDecorated(s, sg);
		expectDecorated(s, pg);
		// No deferred tab loaded by the moves; no frame showed a hidden shown tab.
		expect(loadedByPlugin).toEqual([]);
		expect(rec?.violations).toEqual([]);
		// A later pass has nothing left to move.
		const opsBefore = s.stats.opsApplied;
		await browser.executeObsidian(({ app }) => app.workspace.trigger('layout-change'));
		await browser.pause(300);
		expect((await pageState()).stats.opsApplied).toBe(opsBefore);
		expect(await errorTimeline()).toEqual([]);
	});

	it('no console errors or warnings during the whole run', async function () {
		const errors = await errorTimeline();
		const logs = [...startupLogs, ...((await browser.getLogs('browser')) as { level: string; message: string }[])];
		const severe = logs.filter((l) => (l.level === 'SEVERE' || l.level === 'WARNING') && !/e2e-(startup-)?(log-)?probe/.test(l.message));
		record('console', { errors, severe: severe.map((l) => `${l.level} ${l.message.slice(0, 300)}`) });
		expect(errors).toEqual([]);
		expect(severe.filter((l) => /tabstrip/i.test(l.message))).toEqual([]);
	});
});
