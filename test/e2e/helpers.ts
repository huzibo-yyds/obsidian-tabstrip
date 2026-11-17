/**
 * Shared helpers for the L4 end-to-end specs. Everything that runs in the sandbox page is
 * serialized by WebdriverIO, so in-page functions are self-contained.
 *
 * Test code may read Obsidian's private fields (it is not plugin code). Tab headers are tagged
 * with `data-e2e-leaf` so real pointer input can target a leaf's header; that attribute is the
 * test's own and is ignored by the residue checks.
 */
import { $, browser, expect } from '@wdio/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroupColor, GroupState } from '../../src/core/types';
import type { ControllerStats } from '../../src/controller';
import { parseCssColor } from '../../src/ui/color';
import { decodePng, innerRows, pixelAt, scanBand, type Rgb } from './png';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
export const REPORT_VERSION = '1.15.0';
export const PLUGIN_ID = 'tabstrip';

export const NOTES = {
	n1: 'Getting Started.md',
	n2: '欢迎.md',
	n3: '会议记录（2026-11-08）.md',
	n4: '项目/计划.md',
	n5: 'Inbox.md',
	n6: '归档/计划.md',
	n7: '读书笔记：深度学习.md',
	n8: '中文 English 混合 note.md',
	n9: 'notes with spaces/a b c.md',
	n10: 'Daily/2026-11-08.md',
	n11: '长文件名 带空格，以及全角标点！.md',
} as const;
export type Role = keyof typeof NOTES;

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export interface StripState {
	kind: 'main' | 'popout';
	leafIds: string[];
	files: (string | null)[];
	pinned: boolean[];
	currentId: string | null;
	stacked: boolean;
}

export interface ChipState {
	groupId: string | null;
	hostLeafId: string | null;
	text: string;
	unnamed: boolean;
	color: string | null;
	ink: string | null;
	ariaLabel: string | null;
	role: string | null;
	tabindex: string | null;
	rect: Rect;
	hostRect: Rect | null;
	fill: string;
	textColor: string;
	appRegion: string;
	hostPosition: string;
	slot: string;
}

export interface LineState {
	leafId: string | null;
	groupId: string | null;
	rect: Rect;
	/** The member header that holds this segment. */
	hostRect: Rect | null;
	/** Width of that header's right border (the segment is placed in its padding box). */
	hostBorderRight: number;
	color: string;
}

export interface PageState {
	strips: StripState[];
	activeId: string | null;
	state: GroupState;
	stats: ControllerStats;
	chips: ChipState[];
	lines: LineState[];
	/** Leaf ids whose headers carry member marks, with their group attribute. */
	memberHeaders: { leafId: string | null; groupId: string | null; color: string | null }[];
	editor: { open: boolean; groupId: string | null; inputFocused: boolean; value: string | null; doc: 'main' | 'popout' | null };
	menuTitles: string[];
	notices: string[];
	docFocused: boolean;
}

/** In-page: reads strips (private fields), plugin state and the decoration. Self-contained. */
export function pageStateInPage({ app }: { app: import('obsidian').App }): PageState {
	type Leaf = {
		id: string;
		tabHeaderEl: HTMLElement;
		parent: unknown;
		getViewState(): { state?: Record<string, unknown>; pinned?: boolean };
	};
	type Tabs = { children: Leaf[]; currentTab: number; isStacked?: boolean; getContainer(): unknown };
	const ws = app.workspace as unknown as { rootSplit: unknown; activeLeaf: Leaf | null };
	const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { state(): GroupState; stats(): ControllerStats; flush(): void; editorGroupId(): string | null } } | undefined> } }).plugins.plugins['tabstrip'];
	if (!plugin) throw new Error('tabstrip not loaded');
	plugin.debug.flush();
	const rectOf = (el: Element): Rect => {
		const r = el.getBoundingClientRect();
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
	};
	const strips = new Set<Tabs>();
	const floating = (app.workspace as unknown as { floatingSplit: unknown }).floatingSplit;
	app.workspace.iterateAllLeaves((leaf) => {
		const root = leaf.getRoot() as unknown;
		if (root !== ws.rootSplit && root !== floating) return;
		const p = (leaf as unknown as Leaf).parent as Partial<Tabs> | null;
		if (p && Array.isArray(p.children)) strips.add(p as Tabs);
	});
	const headerToId = new Map<Element, string>();
	const docs = new Set<Document>();
	const stripStates: StripState[] = [...strips].map((tabs) => {
		const files = tabs.children.map((leaf) => {
			headerToId.set(leaf.tabHeaderEl, leaf.id);
			leaf.tabHeaderEl.setAttribute('data-e2e-leaf', leaf.id);
			docs.add(leaf.tabHeaderEl.ownerDocument);
			const f = leaf.getViewState().state?.['file'];
			return typeof f === 'string' ? f : null;
		});
		return {
			kind: tabs.getContainer() === ws.rootSplit ? 'main' : 'popout',
			leafIds: tabs.children.map((l) => l.id),
			files,
			pinned: tabs.children.map((l) => l.getViewState().pinned === true),
			currentId: tabs.children[tabs.currentTab]?.id ?? null,
			stacked: tabs.isStacked === true,
		};
	});
	const chips: ChipState[] = [];
	const lines: LineState[] = [];
	const memberHeaders: PageState['memberHeaders'] = [];
	let editor: PageState['editor'] = { open: false, groupId: null, inputFocused: false, value: null, doc: null };
	const menuTitles: string[] = [];
	const notices: string[] = [];
	for (const doc of docs) {
		const win = doc.defaultView;
		if (!win) continue;
		for (const chip of Array.from(doc.querySelectorAll<HTMLElement>('.tabstrip-chip'))) {
			const host = chip.parentElement;
			const cs = win.getComputedStyle(chip);
			chips.push({
				groupId: chip.getAttribute('data-tabstrip-group'),
				hostLeafId: host ? (headerToId.get(host) ?? null) : null,
				text: chip.textContent ?? '',
				unnamed: chip.classList.contains('is-unnamed'),
				color: chip.getAttribute('data-tabstrip-color'),
				ink: chip.getAttribute('data-tabstrip-ink'),
				ariaLabel: chip.getAttribute('aria-label'),
				role: chip.getAttribute('role'),
				tabindex: chip.getAttribute('tabindex'),
				rect: rectOf(chip),
				hostRect: host ? rectOf(host) : null,
				fill: cs.backgroundColor,
				textColor: cs.color,
				appRegion: cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'),
				hostPosition: host ? win.getComputedStyle(host).position : '',
				slot: host ? host.style.getPropertyValue('--tabstrip-chip-slot') : '',
			});
		}
		for (const line of Array.from(doc.querySelectorAll<HTMLElement>('.tabstrip-line'))) {
			const host = line.parentElement;
			lines.push({
				leafId: host ? (headerToId.get(host) ?? null) : null,
				groupId: host?.getAttribute('data-tabstrip-group') ?? null,
				rect: rectOf(line),
				hostRect: host ? rectOf(host) : null,
				hostBorderRight: host ? parseFloat(win.getComputedStyle(host).borderRightWidth) || 0 : 0,
				color: win.getComputedStyle(line).backgroundColor,
			});
		}
		for (const h of Array.from(doc.querySelectorAll<HTMLElement>('.workspace-tab-header.tabstrip-member'))) {
			memberHeaders.push({
				leafId: headerToId.get(h) ?? null,
				groupId: h.getAttribute('data-tabstrip-group'),
				color: h.getAttribute('data-tabstrip-color'),
			});
		}
		const bubble = doc.querySelector<HTMLElement>('.tabstrip-editor');
		if (bubble) {
			const input = bubble.querySelector<HTMLInputElement>('input');
			editor = {
				open: true,
				groupId: plugin.debug.editorGroupId(),
				inputFocused: input !== null && doc.activeElement === input,
				value: input?.value ?? null,
				doc: doc === document ? 'main' : 'popout',
			};
		}
		for (const t of Array.from(doc.querySelectorAll('.menu .menu-item-title'))) menuTitles.push((t.textContent ?? '').trim());
		for (const n of Array.from(doc.querySelectorAll('.notice'))) notices.push((n.textContent ?? '').trim());
	}
	return {
		strips: stripStates,
		activeId: ws.activeLeaf?.id ?? null,
		state: plugin.debug.state(),
		stats: plugin.debug.stats(),
		chips,
		lines,
		memberHeaders,
		editor,
		menuTitles,
		notices,
		docFocused: document.hasFocus(),
	};
}

export const pageState = (): Promise<PageState> => browser.executeObsidian(pageStateInPage);

/** Polls until `ok` holds, then lets pending passes run and reads again. */
export async function waitForState(ok: (s: PageState) => boolean, what: string, timeout = 6000): Promise<PageState> {
	const start = Date.now();
	let last = await pageState();
	while (!ok(last)) {
		if (Date.now() - start > timeout) {
			throw new Error(`timed out waiting for: ${what}\nlast: ${JSON.stringify(brief(last))}`);
		}
		await browser.pause(80);
		last = await pageState();
	}
	await browser.pause(120);
	return pageState();
}

export function brief(s: PageState) {
	return {
		strips: s.strips.map((x) => ({ kind: x.kind, ids: x.leafIds, current: x.currentId, pinned: x.pinned })),
		active: s.activeId,
		groups: s.state.groups,
		members: s.state.members.map((m) => `${m.leafId}:${m.groupId}`),
		chips: s.chips.map((c) => ({ g: c.groupId, host: c.hostLeafId, text: c.text })),
		editor: s.editor,
		menu: s.menuTitles,
		loopStops: s.stats.loopStops,
	};
}

export function mainStrip(s: PageState): StripState {
	const strip = s.strips.find((x) => x.kind === 'main');
	if (!strip) throw new Error('no main strip');
	return strip;
}

export function stripOf(s: PageState, leafId: string): StripState {
	const strip = s.strips.find((x) => x.leafIds.includes(leafId));
	if (!strip) throw new Error(`no strip holds ${leafId}`);
	return strip;
}

/** Members of a group in tab order. */
export function membersInOrder(s: PageState, groupId: string): string[] {
	const ids = new Set(s.state.members.filter((m) => m.groupId === groupId).map((m) => m.leafId));
	return s.strips.flatMap((x) => x.leafIds.filter((id) => ids.has(id)));
}

export function groupOf(s: PageState, leafId: string): string | null {
	return s.state.members.find((m) => m.leafId === leafId)?.groupId ?? null;
}

/** The group is a contiguous run of tabs in one strip. */
export function expectContiguous(s: PageState, groupId: string): void {
	const members = membersInOrder(s, groupId);
	expect(members.length).toBeGreaterThan(0);
	const strip = stripOf(s, members[0] ?? '');
	const idx = members.map((id) => strip.leafIds.indexOf(id));
	expect(idx.every((v) => v >= 0)).toBe(true);
	const first = Math.min(...idx);
	expect(strip.leafIds.slice(first, first + members.length)).toEqual(members);
}

/** One chip per group, on the group's first member; every member header marked; underline continuous. */
export function expectDecorated(s: PageState, groupId: string): void {
	const members = membersInOrder(s, groupId);
	const chips = s.chips.filter((c) => c.groupId === groupId);
	expect(chips.map((c) => c.hostLeafId)).toEqual([members[0]]);
	const marked = s.memberHeaders.filter((h) => h.groupId === groupId).map((h) => h.leafId);
	expect(new Set(marked)).toEqual(new Set(members));
	expectContinuousLine(s, groupId);
}

/**
 * The underline segments' boxes run from the chip's start to the end of the last member, without
 * gaps. This is geometry only: whether the line is also painted unbroken (not covered by the
 * active tab's curved feet) is checked on screenshot pixels by `underlinePaint`.
 */
export function expectContinuousLine(s: PageState, groupId: string): void {
	const members = membersInOrder(s, groupId);
	const chip = s.chips.find((c) => c.groupId === groupId);
	const segments = s.lines
		.filter((l) => l.groupId === groupId)
		.map((l) => l.rect)
		.sort((a, b) => a.left - b.left);
	expect(segments.length).toBe(members.length);
	if (!chip || segments.length === 0) throw new Error('no chip or line');
	const first = segments[0];
	const last = segments[segments.length - 1];
	const lastLine = s.lines.find((l) => l.leafId === members[members.length - 1]);
	const lastHost = lastLine?.hostRect;
	if (!first || !last || !lastLine || !lastHost) throw new Error('no line');
	// Starts under the chip's start edge, ends at the last member header's end edge.
	expect(Math.abs(first.left - chip.rect.left)).toBeLessThanOrEqual(1);
	let reach = first.right;
	for (const seg of segments.slice(1)) {
		expect(seg.left).toBeLessThanOrEqual(reach + 0.5);
		reach = Math.max(reach, seg.right);
		// Same height and baseline.
		expect(Math.abs(seg.bottom - first.bottom)).toBeLessThanOrEqual(0.5);
	}
	// To the last member's end edge: the inner edge of its border, if it has one (some themes draw
	// tabs as bordered pills; default and Atom have none).
	expect(Math.abs(reach - (lastHost.right - lastLine.hostBorderRight))).toBeLessThanOrEqual(0.5);
	expect(first.height).toBeGreaterThanOrEqual(2);
	expect(first.height).toBeLessThanOrEqual(3);
}

export const headerSel = (id: string) => `.workspace-tab-header[data-e2e-leaf="${id}"]`;
export const titleSel = (id: string) => `${headerSel(id)} .workspace-tab-header-inner-title`;
export const chipSel = (groupId: string) => `.tabstrip-chip[data-tabstrip-group="${groupId}"]`;

/** Clicks the visible menu item with exactly this title (real click). */
export async function clickMenuItem(title: string): Promise<void> {
	await browser.waitUntil(
		async () =>
			browser.execute((t) => {
				// `document` is the window WebDriver is switched to (main window or a pop-out).
				const items = Array.from(document.querySelectorAll('.menu .menu-item'));
				const item = items.find((i) => (i.querySelector('.menu-item-title')?.textContent ?? '').trim() === t);
				for (const i of items) i.removeAttribute('data-e2e-item');
				if (!item) return false;
				item.setAttribute('data-e2e-item', '1');
				return true;
			}, title),
		{ timeout: 3000, timeoutMsg: `no menu item "${title}"` },
	);
	await $('.menu .menu-item[data-e2e-item="1"]').click();
}

export async function menuTitles(): Promise<string[]> {
	return browser.execute(() => Array.from(document.querySelectorAll('.menu .menu-item-title')).map((e) => (e.textContent ?? '').trim()));
}

export async function waitForMenu(): Promise<string[]> {
	await browser.waitUntil(async () => (await menuTitles()).length > 0, { timeout: 3000, timeoutMsg: 'no menu opened' });
	return menuTitles();
}

export async function closeMenus(): Promise<void> {
	await browser.keys('Escape');
	await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll('.menu').length)) === 0, {
		timeout: 3000,
		timeoutMsg: 'menu did not close',
	});
}

/** Opens fixture notes in tabs of the main strip, in this order, closing every other root tab. */
export async function openNotes(roles: readonly Role[]): Promise<Record<Role, string>> {
	const opened = await browser.executeObsidian(
		async ({ app, obsidian }, paths) => {
			const roots: import('obsidian').WorkspaceLeaf[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				roots.push(leaf);
			});
			const first = roots[0] ?? app.workspace.getLeaf(true);
			for (const leaf of roots.slice(1)) leaf.detach();
			first.setPinned(false);
			const out: string[] = [];
			for (const [i, p] of paths.entries()) {
				const file = app.vault.getFileByPath(p);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing fixture note ${p}`);
				const leaf = i === 0 ? first : app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				out.push((leaf as unknown as { id: string }).id);
			}
			// Line them up in this order with the native move recipe (test code may call it directly).
			const tabs = first.parent as unknown as {
				children: unknown[];
				currentTab: number;
				removeChild(l: unknown): void;
				insertChild(i: number, l: unknown): void;
				selectTabIndex(i: number): void;
			};
			for (const [i, id] of out.entries()) {
				const leaf = app.workspace.getLeafById(id);
				if (!leaf || tabs.children.indexOf(leaf) === i) continue;
				const shown = tabs.children[tabs.currentTab];
				tabs.removeChild(leaf);
				(leaf as unknown as { setDimension(d: null): void }).setDimension(null);
				tabs.insertChild(i, leaf);
				tabs.selectTabIndex(shown ? tabs.children.indexOf(shown) : i);
			}
			await activeDocument.fonts.ready;
			return out;
		},
		roles.map((r) => NOTES[r]),
	);
	const ids = {} as Record<Role, string>;
	roles.forEach((role, i) => {
		const id = opened[i];
		if (!id) throw new Error(`no leaf for ${role}`);
		ids[role] = id;
	});
	await waitForState((s) => JSON.stringify(mainStrip(s).leafIds) === JSON.stringify(roles.map((r) => ids[r])), 'notes opened in order');
	return ids;
}

export async function setActive(leafId: string): Promise<void> {
	await browser.executeObsidian(({ app }, id) => {
		const leaf = app.workspace.getLeafById(id);
		if (!leaf) throw new Error(`no leaf ${id}`);
		app.workspace.setActiveLeaf(leaf, { focus: true });
	}, leafId);
	await waitForState((s) => s.activeId === leafId, `leaf ${leafId} active`);
}

/** Whether the command is available now (its checkCallback in checking mode). */
export async function commandAvailable(id: string): Promise<boolean> {
	return browser.executeObsidian(({ app }, commandId) => {
		const cmd = (app as unknown as { commands: { findCommand(id: string): { checkCallback?: (checking: boolean) => boolean } | undefined } }).commands.findCommand(commandId);
		if (!cmd?.checkCallback) throw new Error(`no command ${commandId}`);
		return cmd.checkCallback(true);
	}, id);
}

/** Runs a command. Obsidian returns true whenever the command exists, available or not. */
export async function runCommand(id: string): Promise<boolean> {
	return browser.executeObsidian(({ app }, commandId) => {
		return (app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById(commandId);
	}, id);
}

/** Pins or unpins with the public API. */
export async function setPinned(leafId: string, pinned: boolean): Promise<void> {
	await browser.executeObsidian(
		({ app }, id, value) => {
			const leaf = app.workspace.getLeafById(id);
			if (!leaf) throw new Error(`no leaf ${id}`);
			leaf.setPinned(value);
		},
		leafId,
		pinned,
	);
}

/** Test-only group setup through the plugin's own command path (tab menu "Add tab to new group"). */
export async function makeGroup(leafIds: string[], name: string, color?: GroupColor): Promise<string> {
	const groupId = await browser.executeObsidian(
		({ app }, ids, n, c) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { group(ids: string[], name: string, color?: string): string | null } } | undefined> } }).plugins.plugins['tabstrip'];
			if (!plugin) throw new Error('tabstrip not loaded');
			return plugin.debug.group(ids, n, c ?? undefined);
		},
		leafIds,
		name,
		color ?? null,
	);
	if (groupId === null) throw new Error(`could not group ${leafIds.join(',')}`);
	return groupId;
}

/** Light or dark base theme plus default or Atom; waits until applied and settled. */
export async function setLook(theme: 'default' | 'Atom', dark: boolean): Promise<void> {
	await applyTheme(theme, dark);
	await browser.pause(300);
}

/** The user's layout: left sidebar collapsed, ribbon hidden (the sandbox window is frameless already). */
export async function setUserLayout(on: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, value) => {
		const vault = app.vault as unknown as { setConfig(key: string, v: unknown): void; saveConfig(): Promise<void> };
		vault.setConfig('showRibbon', !value);
		await vault.saveConfig();
		if (value) app.workspace.leftSplit.collapse();
		else app.workspace.leftSplit.expand();
	}, on);
	await browser.pause(400);
}

/**
 * Screenshot of the sandbox window. 1.15.0 + TABSTRIP_WRITE_DOCS=1 writes into the report folder
 * of `step` (the maintainer's L4, L5 or palette test reports).
 */
export async function shot(name: string, step: 'L4' | 'L5' | 'palette' | 'V1' | 'V2' | 'V5' | 'V6' = 'L4'): Promise<string> {
	const version = browser.getObsidianVersion();
	const toDocs = version === REPORT_VERSION && process.env.TABSTRIP_WRITE_DOCS === '1';
	const mode = process.env.TABSTRIP_SANDBOX_ACTIVATION ?? 'background';
	const dir = toDocs ? path.join(repoRoot, 'docs', 'verification', step) : path.join(repoRoot, '.e2e-state', `${step.toLowerCase()}-screens`, version, mode);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.png`);
	await browser.saveScreenshot(file);
	return path.relative(repoRoot, file);
}

export const evidence: Record<string, unknown> = {};

export function record(name: string, data: unknown): void {
	evidence[name] = data;
	console.log(`[l4] ${name}: ${JSON.stringify(data)}`);
}

export function writeEvidence(file: string): void {
	const version = browser.getObsidianVersion();
	const dir = path.join(repoRoot, '.e2e-state', 'l4-evidence');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${file}-${version}.json`), JSON.stringify({ version, evidence, themeReverts }, null, '\t') + '\n');
}

/** The message Chromium reports when a ResizeObserver notification could not be delivered. */
export const RO_LOOP_MESSAGE = 'uncaught: ResizeObserver loop completed with undelivered notifications.';

/** What the error watch did when one pop-out window closed. */
export interface PopoutCloseReport {
	/** Obsidian's own main-window observations of that window's elements, removed by the watch. */
	removed: number;
	/** Class names of their elements. */
	targets: string[];
	/** Tabstrip's main-window observations of that window's elements (left in place; must be 0). */
	pluginOwned: number;
	/** False during the control case, which leaves Obsidian's observations in place. */
	cleanup: boolean;
}

/**
 * Error watch for the whole run. Install it once per session, before any pop-out opens.
 *
 * - Records console.error / console.warn (the plugin and Obsidian log through the main window's
 *   console) and uncaught errors and rejections in the main window and in every pop-out window,
 *   with the time; marks when pop-outs open and close (errorTimeline).
 * - Open pop-outs the way users do (openPopoutLeafWithNotes, "Move to new window") inside
 *   withWarmPopout, after warmUpPopouts at the start of the session: that keeps Obsidian's own
 *   pop-out opening race (see openPopoutWithNotes) out of the tests without filtering anything.
 * - Obsidian's leftover ResizeObservers. Obsidian creates its observers in the main window (tab
 *   strip content, each leaf, each editor scroller), also for pop-out elements, and some stay
 *   registered after a pop-out closes (for example on a leaf the close did not detach). Chromium
 *   cannot deliver an observation whose element's window is gone, so from then on the main window
 *   reports RO_LOOP_MESSAGE every frame, with or without Tabstrip (control case at the end of
 *   l4-groups). To keep that out of the error list without filtering any message, the watch
 *   tracks the main window's observations (test-only bookkeeping around ResizeObserver's
 *   observe / unobserve / disconnect) and, when a pop-out closes, removes the ones on that
 *   window's elements that Obsidian made. Observations made by Tabstrip are never removed, only
 *   counted (`pluginOwned`), so a plugin observer stranded the same way would still show up.
 */
export async function startErrorWatch(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		type Entry = { t: number; msg: string };
		type Tracked = { obs: WeakRef<ResizeObserver>; el: WeakRef<Element>; plugin: boolean };
		type Report = { removed: number; targets: string[]; pluginOwned: number; cleanup: boolean };
		type Watch = { live: Set<Tracked>; cleanup: boolean; closes: Report[]; unobserve: (obs: ResizeObserver, el: Element) => void };
		const w = window as Window & { e2eErrors?: Entry[]; e2eMarks?: Entry[]; e2eRo?: Watch };
		if (w.e2eErrors) return;
		const errors: Entry[] = [];
		w.e2eErrors = errors;
		const push = (msg: string) => errors.push({ t: performance.now(), msg });
		// Pop-out windows opening and closing, to place each error in time (errorTimeline).
		const marks: Entry[] = [];
		w.e2eMarks = marks;
		const mark = (msg: string) => marks.push({ t: performance.now(), msg });
		const origError = console.error;
		const origWarn = console.warn;
		console.error = (...args: unknown[]) => {
			push(`error: ${args.map(String).join(' ')}`);
			origError.apply(console, args);
		};
		console.warn = (...args: unknown[]) => {
			push(`warn: ${args.map(String).join(' ')}`);
			origWarn.apply(console, args);
		};
		const listen = (win: Window, prefix: string) => {
			win.addEventListener('error', (e) => push(`${prefix}uncaught: ${e.message}`));
			win.addEventListener('unhandledrejection', (e) => push(`${prefix}rejection: ${String(e.reason)}`));
		};
		listen(window, '');
		app.workspace.on('window-open', (_ww, win) => {
			mark('pop-out opened');
			listen(win, 'popout ');
		});

		// After a restart (step L6) the test-only startup probe plugin has already started this
		// bookkeeping while Obsidian rebuilt the layout, so the observations Obsidian made for the
		// pop-outs it restored are tracked too; reuse it then (same structure).
		const early = (window as Window & { e2eRoEarly?: { live: Set<Tracked>; unobserve: (obs: ResizeObserver, el: Element) => void } }).e2eRoEarly;
		const live = early?.live ?? new Set<Tracked>();
		let unobserveOne: (obs: ResizeObserver, el: Element) => void;
		if (early) {
			unobserveOne = early.unobserve;
		} else {
			const proto = window.ResizeObserver.prototype;
			// The original methods, called below with an explicit `this`.
			const observe: (this: ResizeObserver, target: Element, options?: ResizeObserverOptions) => void = Reflect.get(proto, 'observe');
			const unobserve: (this: ResizeObserver, target: Element) => void = Reflect.get(proto, 'unobserve');
			const disconnect: (this: ResizeObserver) => void = Reflect.get(proto, 'disconnect');
			proto.observe = function (this: ResizeObserver, target: Element, options?: ResizeObserverOptions) {
				live.add({ obs: new WeakRef(this), el: new WeakRef(target), plugin: (new Error().stack ?? '').includes('plugin:tabstrip') });
				observe.call(this, target, options);
			};
			proto.unobserve = function (this: ResizeObserver, target: Element) {
				for (const t of live) if (t.obs.deref() === this && t.el.deref() === target) live.delete(t);
				unobserve.call(this, target);
			};
			proto.disconnect = function (this: ResizeObserver) {
				for (const t of live) if (t.obs.deref() === this) live.delete(t);
				disconnect.call(this);
			};
			unobserveOne = (obs, el) => {
				unobserve.call(obs, el);
			};
		}
		const watch: Watch = {
			live,
			cleanup: true,
			closes: [],
			unobserve: unobserveOne,
		};
		w.e2eRo = watch;
		app.workspace.on('window-close', (_ww, win) => {
			mark('pop-out closed');
			const report: Report = { removed: 0, targets: [], pluginOwned: 0, cleanup: watch.cleanup };
			for (const t of live) {
				const obs = t.obs.deref();
				const el = t.el.deref();
				if (!obs || !el) {
					live.delete(t);
					continue;
				}
				if (el.ownerDocument !== win.document) continue;
				if (t.plugin) {
					report.pluginOwned++;
					continue;
				}
				if (!watch.cleanup) continue;
				unobserveOne(obs, el);
				live.delete(t);
				report.removed++;
				report.targets.push(String(el.className));
			}
			watch.closes.push(report);
		});
	});
}

/** How long the pop-out window took to settle before it got its tabs. */
export interface PopoutSettle {
	/** Pop-out frames waited. */
	frames: number;
	ms: number;
	/** Window size once settled. */
	size: string;
	stylesheets: number;
}

/**
 * Opens a pop-out window with these notes in its tabs (in this order, the last one active)
 * and returns their leaf ids.
 *
 * Obsidian watches pop-out elements with ResizeObservers that belong to the MAIN window (tab
 * strip content, each leaf, each editor scroller). In the first pop-out of a session the relayed
 * styles are not applied yet when Obsidian fills the window (the body still has the browser's
 * 8px margin), so the pop-out's layout changes in steps for about 100 ms, with or without
 * Tabstrip. When a step lands while the main window is delivering those observations, Obsidian's
 * leaf observer (it reads offsetWidth) pulls the new pop-out layout in halfway through the
 * delivery; the strip content above the leaf has then changed again, and Chromium reports
 * "ResizeObserver loop completed with undelivered notifications" once in the main window. No
 * Tabstrip code runs in that frame (found in the maintainer's L4 tests). So the window is opened
 * empty first, with Obsidian's own openPopout (private, test-only), and filled the way
 * openPopoutLeaf fills it only after its stylesheets have loaded and its size has stayed the same
 * for three frames. No message is filtered.
 */
export async function openPopoutWithNotes(paths: readonly string[]): Promise<{ ids: string[]; settle: PopoutSettle }> {
	return browser.executeObsidian(
		async ({ app, obsidian }, notes) => {
			type Leaf = import('obsidian').WorkspaceLeaf;
			type Popout = { win: Window; doc: Document; insertChild(index: number, child: unknown): void };
			type TabsClass = { createFrom(workspace: unknown, leaf: Leaf): unknown };
			const started = performance.now();
			// The constructors openPopoutLeaf uses, taken from a root leaf of the main window.
			const roots: Leaf[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				roots.push(leaf);
			});
			const anchor = roots[0];
			if (anchor === undefined) throw new Error('no root leaf');
			const LeafClass = anchor.constructor as new (a: typeof app) => Leaf;
			const Tabs = (anchor.parent as unknown as { constructor: TabsClass }).constructor;
			const popout = (app.workspace as unknown as { openPopout(): Popout }).openPopout();
			const { win, doc } = popout;
			const stylesLoaded = () => Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).every((l) => l.sheet !== null);
			let frames = 0;
			let stableFor = 0;
			let size = '';
			while (stableFor < 3) {
				if (performance.now() - started > 8000) throw new Error(`pop-out did not settle (size ${size}, styles loaded ${String(stylesLoaded())})`);
				await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
				frames++;
				const now = `${String(win.innerWidth)}x${String(win.innerHeight)}`;
				stableFor = stylesLoaded() && now === size ? stableFor + 1 : 0;
				size = now;
			}
			await doc.fonts.ready;
			const first = new LeafClass(app);
			popout.insertChild(0, Tabs.createFrom(app.workspace, first));
			const ids: string[] = [];
			for (const [i, p] of notes.entries()) {
				const file = app.vault.getFileByPath(p);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing fixture note ${p}`);
				const leaf = i === 0 ? first : app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				app.workspace.setActiveLeaf(leaf, { focus: true });
				ids.push((leaf as unknown as { id: string }).id);
			}
			return { ids, settle: { frames, ms: Math.round(performance.now() - started), size, stylesheets: doc.styleSheets.length } };
		},
		[...paths],
	);
}

/**
 * Opens a pop-out window the way users and plugins do, through the public API: openPopoutLeaf()
 * and openFile(); the other notes go into new tabs of that window (getLeaf('tab') next to the
 * active pop-out tab). Returns the leaf ids in tab order (the last one active).
 *
 * Use it only after warmUpPopouts(): in the first pop-out of a session Obsidian's own
 * observers can race the window's late styles (see openPopoutWithNotes).
 */
export async function openPopoutLeafWithNotes(paths: readonly string[]): Promise<string[]> {
	return browser.executeObsidian(
		async ({ app, obsidian }, notes) => {
			const first = app.workspace.openPopoutLeaf();
			const ids: string[] = [];
			for (const [i, p] of notes.entries()) {
				const file = app.vault.getFileByPath(p);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing fixture note ${p}`);
				const leaf = i === 0 ? first : app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				app.workspace.setActiveLeaf(leaf, { focus: true });
				ids.push((leaf as unknown as { id: string }).id);
			}
			await first.getContainer().doc.fonts.ready;
			return ids;
		},
		[...paths],
	);
}

/**
 * Opens and closes one pop-out with openPopoutWithNotes, so that the first pop-out of the
 * session (the only one where Obsidian's observers race the window's late styles) is out of
 * the way. Later pop-outs can then be opened the way users open them (openPopoutLeafWithNotes,
 * "Move to new window"), with the error watch on and nothing filtered.
 */
export async function warmUpPopouts(): Promise<PopoutSettle> {
	const { ids, settle } = await openPopoutWithNotes([NOTES.n10]);
	await browser.pause(300);
	await closePopout(ids[0] ?? '');
	await browser.waitUntil(async () => (await browser.getWindowHandles()).length === 1, { timeout: 5000, timeoutMsg: 'warm-up pop-out did not close' });
	await browser.pause(300);
	return settle;
}

/**
 * Runs `open` (which opens a pop-out the way users do: openPopoutLeaf, "Move to new window")
 * while a warm pop-out, opened just before with openPopoutWithNotes, is still open; closes the
 * warm one afterwards. In long runs the window that opens next can again get its stylesheets
 * late, like the session's first one (seen once in E7 and once in E8 in full runs, never in 70
 * opens in a short session), and Obsidian's own observers then race them; a pop-out opened
 * right after another one finds them ready. Nothing is filtered: every error still counts.
 */
export async function withWarmPopout<T>(open: () => Promise<T>): Promise<{ result: T; warm: PopoutSettle }> {
	const { ids, settle } = await openPopoutWithNotes([NOTES.n10]);
	const warmLeaf = ids[0] ?? '';
	let result: T;
	try {
		result = await open();
		await browser.pause(300);
	} finally {
		await closePopout(warmLeaf);
		await browser.waitUntil(
			async () => browser.executeObsidian(({ app }, id) => app.workspace.getLeafById(id) === null, warmLeaf),
			{ timeout: 5000, timeoutMsg: 'warm pop-out did not close' },
		);
		await browser.pause(300);
	}
	return { result, warm: settle };
}

/**
 * The WebDriver handle of the window whose document has an element matching `selector`, or
 * null. WebDriver is left on the main window.
 */
export async function windowHandleWith(selector: string): Promise<string | null> {
	const main = await browser.getWindowHandle();
	let found: string | null = null;
	for (const h of await browser.getWindowHandles()) {
		if (h === main) continue;
		await browser.switchToWindow(h);
		if (await browser.execute((sel) => document.querySelector(sel) !== null, selector)) {
			found = h;
			break;
		}
	}
	await browser.switchToWindow(main);
	return found;
}

/** Closes the pop-out window that holds this leaf. */
export async function closePopout(leafId: string): Promise<void> {
	await browser.executeObsidian(({ app }, id) => {
		app.workspace.getLeafById(id)?.getContainer().win.close();
	}, leafId);
}

/** Every recorded error, warning, uncaught error and rejection (main window and pop-outs). */
export async function readErrors(): Promise<string[]> {
	return browser.execute(() => ((window as Window & { e2eErrors?: { msg: string }[] }).e2eErrors ?? []).map((e) => e.msg));
}

/**
 * Every recorded error with the time since the pop-out window last opened or closed, for the
 * evidence and failure output (for example "+124 ms after pop-out opened #1").
 */
export async function errorTimeline(): Promise<string[]> {
	return browser.execute(() => {
		type Entry = { t: number; msg: string };
		const w = window as Window & { e2eErrors?: Entry[]; e2eMarks?: Entry[] };
		const marks = w.e2eMarks ?? [];
		return (w.e2eErrors ?? []).map((e) => {
			let last = -1;
			marks.forEach((m, i) => {
				if (m.t <= e.t) last = i;
			});
			const m = marks[last];
			const when = m === undefined ? 'before any pop-out' : `+${String(Math.round(e.t - m.t))} ms after ${m.msg} #${String(marks.slice(0, last + 1).filter((x) => x.msg === m.msg).length)}`;
			return `${e.msg} (${when})`;
		});
	});
}

/** One report per closed pop-out window (see startErrorWatch). */
export async function popoutCloseReports(): Promise<PopoutCloseReport[]> {
	return browser.execute(() => (window as Window & { e2eRo?: { closes: PopoutCloseReport[] } }).e2eRo?.closes ?? []);
}

/** Control case only: leave Obsidian's observations of a closing pop-out in place (false) or remove them (true). */
export async function setPopoutCleanup(on: boolean): Promise<void> {
	await browser.execute((value) => {
		const watch = (window as Window & { e2eRo?: { cleanup: boolean } }).e2eRo;
		if (!watch) throw new Error('error watch not installed');
		watch.cleanup = value;
	}, on);
}

/**
 * Main-window observations whose element's window is gone ("stranded"), by owner. With
 * `remove`, Obsidian's are removed (Tabstrip's never are).
 */
export async function strandedObservations(remove: boolean): Promise<{ obsidian: string[]; plugin: number }> {
	return browser.execute((rm) => {
		type Tracked = { obs: WeakRef<ResizeObserver>; el: WeakRef<Element>; plugin: boolean };
		const watch = (window as Window & { e2eRo?: { live: Set<Tracked>; unobserve(obs: ResizeObserver, el: Element): void } }).e2eRo;
		if (!watch) throw new Error('error watch not installed');
		const out = { obsidian: [] as string[], plugin: 0 };
		for (const t of watch.live) {
			const obs = t.obs.deref();
			const el = t.el.deref();
			if (!obs || !el || el.ownerDocument.defaultView !== null) continue;
			if (t.plugin) {
				out.plugin++;
				continue;
			}
			out.obsidian.push(String(el.className));
			if (rm) {
				watch.unobserve(obs, el);
				watch.live.delete(t);
			}
		}
		return out;
	}, remove);
}

/** Plugin traces in every window that has root tabs: classes, data attributes, custom properties. */
export async function residue(): Promise<{ docs: number; found: string[] }> {
	return browser.executeObsidian(({ app }) => {
		const docs = new Set<Document>([document]);
		app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.getContainer().doc);
		});
		const found: string[] = [];
		for (const doc of docs) {
			for (const el of Array.from(doc.querySelectorAll('*'))) {
				for (const c of Array.from(el.classList)) if (c.startsWith('tabstrip-')) found.push(`class ${c}`);
				for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-tabstrip')) found.push(`attr ${a.name}`);
				const style = (el as HTMLElement).style as CSSStyleDeclaration | undefined;
				if (style) for (let i = 0; i < style.length; i++) if (style.item(i).startsWith('--tabstrip-')) found.push(`style ${style.item(i)}`);
			}
		}
		return { docs: docs.size, found };
	});
}

/** One group's underline as painted on screen, in the main window. CSS px, viewport coordinates. */
export interface UnderlinePaint {
	groupId: string;
	/** Computed colour of the underline. */
	color: string;
	/** The same colour as it comes out in the screenshot (read from a reference swatch). */
	painted: Rgb;
	/** The checked stretch: from 1 px after the chip's start edge to 2 px before the last member's end edge. */
	from: number;
	to: number;
	/** The underline's band (its segments' top and bottom). */
	top: number;
	bottom: number;
	/** Member header edges in tab order: [left, right] each. */
	members: [number, number][];
	/** Device-pixel rows and columns looked at. */
	rows: number[];
	columns: number;
	/** Stretches where some looked-at row is not the underline colour (the line is broken there). */
	gaps: { from: number; to: number }[];
	firstMiss: { x: number; y: number; rgb: Rgb } | null;
	/** Largest channel difference among the pixels that were the underline colour. */
	maxMatchedDistance: number;
	/** Columns with the underline colour in every row just before the chip / just after the last member (must be 0). */
	spillBefore: number;
	spillAfter: number;
}

/** Channel tolerance for "this pixel is the underline colour". Groups and backgrounds differ by far more. */
export const PAINT_TOLERANCE = 8;

/** Where the reference swatches go (CSS px): in the note area, well below the tab bar. */
const SWATCH = { left: 20, top: 300, size: 20, step: 30 };

/**
 * Checks on a screenshot that every group's underline in the main window is painted unbroken
 * from the chip's start to the last member's end, and not past either end. Element boxes alone
 * cannot show this: Obsidian paints the active (or hovered) tab's curved feet over its
 * neighbours. The checked stretch stops 2 px before the group's end because a tab right after
 * the group that is active draws its 1 px outline there.
 *
 * The screenshot is in the display's colour space (it carries the display's ICC profile), so a
 * pixel is not compared with the CSS colour itself: for each group the test briefly puts a
 * plain swatch of the underline's computed colour in the note area and compares with that
 * swatch's pixels. The screenshot goes to .e2e-state/l4-paint/<version>/<mode>/<name>.png.
 */
export async function underlinePaint(name: string): Promise<{ scale: number; file: string; groups: UnderlinePaint[] }> {
	const page = await browser.execute(async (sw) => {
		const rect = (el: Element) => el.getBoundingClientRect();
		const groups = Array.from(document.querySelectorAll<HTMLElement>('.tabstrip-chip')).map((chip, i) => {
			const id = chip.getAttribute('data-tabstrip-group') ?? '';
			const strip = chip.parentElement?.parentElement ?? document;
			const headers = Array.from(strip.querySelectorAll<HTMLElement>(':scope > .workspace-tab-header.tabstrip-member')).filter(
				(h) => h.getAttribute('data-tabstrip-group') === id,
			);
			const lines = headers.map((h) => h.querySelector<HTMLElement>(':scope > .tabstrip-line')).filter((l): l is HTMLElement => l !== null);
			const last = headers[headers.length - 1];
			const color = lines[0] ? getComputedStyle(lines[0]).backgroundColor : '';
			// Test-only reference swatch, removed right after the screenshot.
			const swatch = document.body.createDiv();
			swatch.setAttribute('data-e2e-swatch', id);
			swatch.setCssStyles({
				position: 'fixed',
				left: `${String(sw.left + i * sw.step)}px`,
				top: `${String(sw.top)}px`,
				width: `${String(sw.size)}px`,
				height: `${String(sw.size)}px`,
				zIndex: '99999',
				backgroundColor: color,
			});
			return {
				groupId: id,
				color,
				swatch: [sw.left + i * sw.step + sw.size / 2, sw.top + sw.size / 2] as [number, number],
				start: rect(chip).left,
				end: last ? rect(last).right : NaN,
				top: Math.min(...lines.map((l) => rect(l).top)),
				bottom: Math.max(...lines.map((l) => rect(l).bottom)),
				members: headers.map((h): [number, number] => [rect(h).left, rect(h).right]),
			};
		});
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return { groups, innerWidth: window.innerWidth };
	}, SWATCH);
	let png: Buffer;
	try {
		png = Buffer.from(await browser.takeScreenshot(), 'base64');
	} finally {
		await browser.execute(() => {
			for (const el of Array.from(document.querySelectorAll('[data-e2e-swatch]'))) el.remove();
		});
	}
	const version = browser.getObsidianVersion();
	const mode = process.env.TABSTRIP_SANDBOX_ACTIVATION ?? 'background';
	const dir = path.join(repoRoot, '.e2e-state', 'l4-paint', version, mode);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.png`);
	fs.writeFileSync(file, png);
	const img = decodePng(png);
	const scale = img.width / page.innerWidth;
	const groups = page.groups.map((g): UnderlinePaint => {
		const c = parseCssColor(g.color);
		if (c === null || c.a < 1) throw new Error(`group ${g.groupId}: underline colour ${g.color} is not an opaque colour`);
		const painted = pixelAt(img, Math.round(g.swatch[0] * scale), Math.round(g.swatch[1] * scale));
		const rows = innerRows(g.top, g.bottom, scale);
		const from = g.start + 1;
		const to = g.end - 2;
		const scan = scanBand(img, Math.ceil(from * scale), Math.floor(to * scale), rows, painted, PAINT_TOLERANCE);
		// Columns that are the underline colour in every row, just outside either end.
		const spill = (a: number, b: number) => {
			const outside = scanBand(img, Math.round(a * scale), Math.round(b * scale) - 1, rows, painted, PAINT_TOLERANCE);
			return outside.columns - outside.misses.reduce((n, m) => n + m.to - m.from + 1, 0);
		};
		return {
			groupId: g.groupId,
			color: g.color,
			painted,
			from,
			to,
			top: g.top,
			bottom: g.bottom,
			members: g.members,
			rows,
			columns: scan.columns,
			gaps: scan.misses.map((m) => ({ from: m.from / scale, to: (m.to + 1) / scale })),
			firstMiss: scan.firstMiss,
			maxMatchedDistance: scan.maxMatchedDistance,
			spillBefore: spill(g.start - 3, g.start - 1.5),
			spillAfter: spill(g.end + 1.5, g.end + 3),
		};
	});
	return { scale, file: path.relative(repoRoot, file), groups };
}

/** Where the tab dividers are painted around one chip, in the main window (close-out round 2). */
export interface DividerPaint {
	groupId: string;
	/** Computed colour of the divider (the `::after` of a tab header's inner box). */
	color: string;
	painted: Rgb;
	/** Whether the plugin marked the chip holder as a start-side divider tab (`tabstrip-divider-start`). */
	marked: boolean;
	/** The tab before the chip's tab, and whether it is the active one (themes hide dividers next to it). */
	previous: { left: number; right: number; active: boolean } | null;
	chip: { left: number; right: number };
	host: { left: number; right: number };
	/** Divider columns (device px) between the previous tab's end and the chip's start. */
	before: number;
	/** Divider columns between the chip's end and 3 px into its own tab: must be 0. */
	between: number;
	/**
	 * Collapsed group only (L5 review round 2): the next tab that shows after the chip, and the
	 * divider columns from the chip's end to 3 px into that tab. Next to the active tab the theme
	 * hides its dividers, so this must be 0 there.
	 */
	next: { left: number; active: boolean } | null;
	after: number;
	rows: number[];
}

/**
 * Finds the tab dividers around each chip on a screenshot: Obsidian draws a 1 px divider between
 * tabs; with a chip in front of a tab it must sit before the chip (where the tab before ends),
 * never between the chip and the tab it labels. Rows: 3 CSS px around the vertical centre of the
 * chip holder's inner box (the divider is centred there). As in underlinePaint, pixels are
 * compared with a reference swatch of the divider's computed colour painted in the note area.
 * Needs a 2x screen (the 1 px divider at a half-pixel offset fills exactly two device columns).
 */
export async function dividerPaint(name: string): Promise<{ scale: number; file: string; groups: DividerPaint[] }> {
	const page = await browser.execute(async (sw) => {
		const groups = Array.from(document.querySelectorAll<HTMLElement>('.workspace-tab-header-container .tabstrip-chip')).map((chip, i) => {
			const host = chip.parentElement;
			if (!host) throw new Error('chip without a header');
			let prev = host.previousElementSibling;
			while (prev && !prev.classList.contains('workspace-tab-header')) prev = prev.previousElementSibling;
			const inner = host.querySelector(':scope > .workspace-tab-header-inner');
			if (!inner) throw new Error('header without an inner box');
			// The divider colour, from a tab whose divider box is visible (its colour is the same on every tab).
			const color = getComputedStyle(inner, '::after').backgroundColor;
			// A collapsed group: the first header after the chip holder that is not a hidden member.
			let next: Element | null = null;
			if (host.classList.contains('tabstrip-collapsed')) {
				next = host.nextElementSibling;
				while (next && (!next.classList.contains('workspace-tab-header') || next.classList.contains('tabstrip-collapsed'))) next = next.nextElementSibling;
			}
			const swatch = document.body.createDiv();
			swatch.setAttribute('data-e2e-swatch', 'divider');
			swatch.setCssStyles({
				position: 'fixed',
				left: `${String(sw.left + i * sw.step)}px`,
				top: `${String(sw.top + 40)}px`,
				width: `${String(sw.size)}px`,
				height: `${String(sw.size)}px`,
				zIndex: '99999',
				backgroundColor: color,
			});
			const r = (el: Element) => el.getBoundingClientRect();
			return {
				groupId: chip.getAttribute('data-tabstrip-group') ?? '',
				color,
				swatch: [sw.left + i * sw.step + sw.size / 2, sw.top + 40 + sw.size / 2] as [number, number],
				marked: host.classList.contains('tabstrip-divider-start'),
				previous: prev ? { left: r(prev).left, right: r(prev).right, active: prev.classList.contains('is-active') } : null,
				chip: { left: r(chip).left, right: r(chip).right },
				host: { left: r(host).left, right: r(host).right },
				next: next ? { left: r(next).left, active: next.classList.contains('is-active') } : null,
				middle: (r(inner).top + r(inner).bottom) / 2,
			};
		});
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return { groups, innerWidth: window.innerWidth };
	}, SWATCH);
	let png: Buffer;
	try {
		png = Buffer.from(await browser.takeScreenshot(), 'base64');
	} finally {
		await browser.execute(() => {
			for (const el of Array.from(document.querySelectorAll('[data-e2e-swatch]'))) el.remove();
		});
	}
	const version = browser.getObsidianVersion();
	const mode = process.env.TABSTRIP_SANDBOX_ACTIVATION ?? 'background';
	const dir = path.join(repoRoot, '.e2e-state', 'l4-paint', version, mode);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.png`);
	fs.writeFileSync(file, png);
	const img = decodePng(png);
	const scale = img.width / page.innerWidth;
	if (scale < 2) throw new Error(`dividerPaint needs a 2x screenshot, got ${String(scale)}`);
	const groups = page.groups.map((g): DividerPaint => {
		const painted = pixelAt(img, Math.round(g.swatch[0] * scale), Math.round(g.swatch[1] * scale));
		const rows = innerRows(g.middle - 1.5, g.middle + 1.5, scale);
		/** Columns from a to b (CSS px) that are the divider colour in every row. */
		const dividerColumns = (a: number, b: number) => {
			const scan = scanBand(img, Math.round(a * scale), Math.round(b * scale) - 1, rows, painted, PAINT_TOLERANCE);
			return scan.columns - scan.misses.reduce((n, m) => n + m.to - m.from + 1, 0);
		};
		return {
			groupId: g.groupId,
			color: g.color,
			painted,
			marked: g.marked,
			previous: g.previous,
			chip: g.chip,
			host: g.host,
			before: g.previous === null ? 0 : dividerColumns(g.previous.right - 3, g.chip.left - 1),
			between: dividerColumns(g.chip.right + 1, g.host.left + 3),
			next: g.next,
			after: g.next === null ? 0 : dividerColumns(g.chip.right + 1, g.next.left + 3),
			rows,
		};
	});
	return { scale, file: path.relative(repoRoot, file), groups };
}

/** Where the open editor bubble is, next to its group's chip, first member header, strip and underline. */
export interface BubbleGeometry {
	/** 'main' or 'popout': the document the bubble is in. */
	doc: 'main' | 'popout' | null;
	bubble: Rect | null;
	chip: Rect | null;
	chipDisplay: string | null;
	/** The header that holds the chip (the group's first member in that strip). */
	header: Rect | null;
	/** The tab header container (the horizontal strip), or null in a stacked strip. */
	strip: Rect | null;
	/** The group's underline segments in that document. */
	lines: Rect[];
	win: { width: number; height: number };
}

/** In-page: geometry of the open bubble and of the group it edits (any window). */
export async function bubbleGeometry(groupId: string): Promise<BubbleGeometry> {
	return browser.executeObsidian(({ app }, gid) => {
		const rectOf = (el: Element | null | undefined) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		};
		const docs = new Set<Document>([document]);
		app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.getContainer().doc);
		});
		for (const doc of docs) {
			const bubble = doc.querySelector('.tabstrip-editor');
			if (!bubble) continue;
			const chip = doc.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
			const header = chip?.parentElement ?? null;
			const lines = Array.from(doc.querySelectorAll(`.workspace-tab-header[data-tabstrip-group="${gid}"] > .tabstrip-line`))
				.map((l) => rectOf(l))
				.filter((r): r is NonNullable<typeof r> => r !== null);
			const win = doc.defaultView;
			return {
				doc: doc === document ? 'main' : 'popout',
				bubble: rectOf(bubble),
				chip: rectOf(chip),
				chipDisplay: chip && win ? win.getComputedStyle(chip).display : null,
				header: rectOf(header),
				strip: rectOf(header?.closest('.workspace-tab-header-container')),
				lines,
				win: { width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 },
			} as const;
		}
		return { doc: null, bubble: null, chip: null, chipDisplay: null, header: null, strip: null, lines: [], win: { width: 0, height: 0 } } as const;
	}, groupId);
}

function overlaps(a: Rect, b: Rect): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Gap between two boxes (0 when they touch or overlap). */
function distance(a: Rect, b: Rect): number {
	const dx = Math.max(0, b.left - a.right, a.left - b.right);
	const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
	return Math.hypot(dx, dy);
}

/**
 * The bubble is inside its window and near its group: in a horizontal strip, under the whole
 * strip (so it hides neither the strip nor the group's underline), left-aligned with the chip;
 * in a stacked strip (the chip is hidden), right next to the first member's header.
 */
export function expectBubblePlaced(g: BubbleGeometry): void {
	const { bubble, header } = g;
	if (!bubble || !header) throw new Error(`no bubble or header: ${JSON.stringify(g)}`);
	const where = JSON.stringify(g);
	expect({ where, inside: bubble.left >= 0 && bubble.top >= 0 && bubble.right <= g.win.width && bubble.bottom <= g.win.height }).toEqual({ where, inside: true });
	expect({ where, coversLine: g.lines.some((l) => overlaps(l, bubble)) }).toEqual({ where, coversLine: false });
	if (g.chip && g.chip.width > 0 && g.strip) {
		expect({ where, belowStrip: bubble.top >= g.strip.bottom, nearStrip: bubble.top - g.strip.bottom <= 8, alignedWithChip: Math.abs(bubble.left - g.chip.left) <= 1 }).toEqual({
			where,
			belowStrip: true,
			nearStrip: true,
			alignedWithChip: true,
		});
	} else {
		expect({ where, chipHidden: g.chipDisplay === 'none', nearHeader: distance(bubble, header) <= 8, notInCorner: !(bubble.left <= 8 && bubble.top <= 8) }).toEqual({
			where,
			chipHidden: true,
			nearHeader: true,
			notInCorner: true,
		});
	}
}

/** Where the keyboard focus is in the window of `leafId` (default: the main window). */
export interface FocusInfo {
	body: boolean;
	/** Group id when the focused element is a chip. */
	chipGroup: string | null;
	/** Inside the active leaf's view (its editor, for a note). */
	inActiveView: boolean;
	inBubble: boolean;
	focusVisible: boolean;
	desc: string;
}

export async function focusInfo(leafId?: string): Promise<FocusInfo> {
	return browser.executeObsidian(({ app, obsidian }, id) => {
		const doc = id ? (app.workspace.getLeafById(id)?.getContainer().doc ?? document) : document;
		const el = doc.activeElement;
		const view = app.workspace.getActiveViewOfType(obsidian.View)?.containerEl;
		return {
			body: el === null || el === doc.body,
			chipGroup: el?.classList.contains('tabstrip-chip') ? el.getAttribute('data-tabstrip-group') : null,
			inActiveView: el !== null && view !== undefined && view.contains(el),
			inBubble: el?.closest('.tabstrip-editor') != null,
			focusVisible: el?.matches(':focus-visible') ?? false,
			desc: el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}` : 'null',
		};
	}, leafId ?? '');
}

/** A community theme by name ('default' for none), light base theme. For themes without a setLook check. */
export async function setTheme(name: string): Promise<void> {
	await applyTheme(name, false);
	await browser.pause(400);
}

/** Theme switches that Obsidian undid before they settled (see applyTheme). Logged, never hidden. */
export const themeReverts: Record<string, unknown>[] = [];

/**
 * Switches the community theme and the light/dark base theme in one step and waits until the
 * switch has settled: in memory, in the config, on the body, in appearance.json on disk, and for
 * Atom/default also in the computed --divider-color. "Settled" means all of that stayed true for
 * SETTLE_MS, longer than Obsidian's own config-reload debounce, so a reload that reads an older
 * appearance.json cannot undo the switch after this returns.
 *
 * Why (palette review round 2): on the matrix, once in a while the old waitUntil saw the theme
 * never applied within 6 s (1.13.4 "theme Minimal not applied", earlier "Atom dark not applied").
 * The only way that check stays false is that Obsidian itself set the theme back after we set it.
 * If that happens the switch is applied again, at most THEME_ATTEMPTS times, and every undo is
 * printed and kept in themeReverts with a full snapshot. The checks themselves are unchanged.
 */
const SETTLE_MS = 800;
const THEME_ATTEMPT_MS = 8000;
const THEME_ATTEMPTS = 3;
async function applyTheme(name: string, dark: boolean): Promise<void> {
	const what = `${name === 'default' ? 'default' : name} ${dark ? 'dark' : 'light'}`;
	let last: Record<string, unknown> = {};
	for (let attempt = 1; attempt <= THEME_ATTEMPTS; attempt++) {
		await browser.executeObsidian(
			async ({ app }, n, d) => {
				const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
				const css = (app as unknown as { customCss: { setTheme(name: string): void } }).customCss;
				vault.setConfig('theme', d ? 'obsidian' : 'moonstone');
				css.setTheme(n === 'default' ? '' : n);
				await vault.saveConfig();
			},
			name,
			dark,
		);
		const start = Date.now();
		let okSince: number | null = null;
		let everOk = false;
		while (Date.now() - start < THEME_ATTEMPT_MS) {
			last = await themeSnapshot();
			const ok = themeMatches(last, name, dark);
			if (ok) {
				everOk = true;
				okSince ??= Date.now();
				if (Date.now() - okSince >= SETTLE_MS) return;
			} else {
				okSince = null;
				// Applied once and then undone: apply again right away instead of waiting out the attempt.
				if (everOk) break;
			}
			await browser.pause(100);
		}
		const revert = { what, attempt, everOk, ms: Date.now() - start, last };
		themeReverts.push(revert);
		console.log(`[theme] not settled, ${attempt < THEME_ATTEMPTS ? 'applying again' : 'giving up'}: ${JSON.stringify(revert)}`);
	}
	throw new Error(`${what} not applied\nlast: ${JSON.stringify(last)}`);
}

function themeMatches(s: Record<string, unknown>, name: string, dark: boolean): boolean {
	const want = name === 'default' ? '' : name;
	const disk = (s.onDisk ?? {}) as { cssTheme?: unknown; theme?: unknown };
	const base = dark ? 'obsidian' : 'moonstone';
	const body = s.body as string[];
	const divider = s.divider as string;
	// Atom paints no tab dividers; the default theme does. A cheap sign that the stylesheet is in.
	const sheetOk = name === 'Atom' ? divider === 'transparent' : name === 'default' ? divider !== 'transparent' : true;
	return (
		s.customCssTheme === want &&
		(s.cssThemeConfig ?? '') === want &&
		s.baseConfig === base &&
		(disk.cssTheme ?? '') === want &&
		disk.theme === base &&
		body.includes(dark ? 'theme-dark' : 'theme-light') &&
		!body.includes(dark ? 'theme-light' : 'theme-dark') &&
		sheetOk
	);
}

/** What the sandbox thinks the theme is, in memory and on disk. For timeout messages. */
export async function themeSnapshot(): Promise<Record<string, unknown>> {
	return browser.executeObsidian(async ({ app }) => {
		const vault = app.vault as unknown as { getConfig(key: string): unknown; configDir: string };
		const css = (app as unknown as { customCss: { theme: string } }).customCss;
		let onDisk: unknown = null;
		try {
			onDisk = JSON.parse(await app.vault.adapter.read(`${vault.configDir}/appearance.json`));
		} catch (e) {
			onDisk = String(e);
		}
		return {
			customCssTheme: css.theme,
			cssThemeConfig: vault.getConfig('cssTheme'),
			baseConfig: vault.getConfig('theme'),
			body: Array.from(activeDocument.body.classList).filter((c) => c.startsWith('theme-')),
			divider: getComputedStyle(activeDocument.body).getPropertyValue('--divider-color').trim(),
			onDisk,
			at: Date.now(),
		};
	});
}
