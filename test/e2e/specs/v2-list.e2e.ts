/**
 * Steps V2-V4 (combined): the vertical strip's list and mouse (V2), the icon bar and resizing (V3),
 * and the keyboard and accessibility (V4).
 *
 * Every case drives the strip with REAL input: WebDriver pointer actions (clicks, middle clicks,
 * right clicks, hover, drags of the edge handle) and key presses (browser.keys). Test code only sets
 * things up (opening notes, grouping, putting the keyboard focus on the tree) and reads the page.
 *
 * The user's settings are only READ (their obsidian.json, for the window frame); the frame is
 * written into the sandbox's own throwaway config folder, never into a user file.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run).
 */
import { $, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { realHome } from '../../../scripts/host-guard.mjs';
import {
	closeMenus,
	commandAvailable,
	errorTimeline,
	makeGroup,
	menuTitles,
	clickMenuItem,
	openNotes,
	pageState,
	record,
	residue,
	runCommand,
	setActive,
	setLook,
	setPinned,
	shot,
	startErrorWatch,
	waitForMenu,
	writeEvidence,
	type Rect,
} from '../helpers';

const KEY = 'tabstrip-session-v1';
const CMD = {
	toggle: 'tabstrip:toggle-vertical-tabs',
	collapse: 'tabstrip:toggle-vertical-strip-collapsed',
	restoreNative: 'tabstrip:restore-native-tab-bar',
	show: 'tabstrip:show-tab-groups',
} as const;
const PEEK_WAIT = 700;

// ---------------------------------------------------------------- page reads

interface ItemState {
	kind: 'tab' | 'group' | 'new';
	key: string;
	leafId: string | null;
	groupId: string | null;
	title: string;
	icon: string;
	classes: string[];
	color: string | null;
	bar: string;
	role: string | null;
	level: string | null;
	setsize: string | null;
	posinset: string | null;
	expanded: string | null;
	selected: string | null;
	label: string | null;
	tabindex: string | null;
	count: string;
	chipFill: string;
	rect: Rect;
	shown: boolean;
	region: string;
}

interface SectionState {
	kind: string;
	role: string | null;
	label: string | null;
	title: string;
	titleShown: boolean;
	items: ItemState[];
}

interface ListState {
	mounted: boolean;
	collapsed: boolean;
	peek: boolean;
	strip: Rect | null;
	panel: Rect | null;
	root: Rect;
	treeRole: string | null;
	sections: SectionState[];
	focusKey: string | null;
	focusOutline: string;
	rootIds: string[];
	rootTitles: Record<string, string>;
	rootIcons: Record<string, string>;
	deferred: string[];
	activeId: string | null;
	currents: string[];
	nativeShown: number;
	spines: { shown: number; total: number };
	stored: { width?: number; collapsed?: boolean } | null;
}

async function list(): Promise<ListState> {
	return browser.executeObsidian(({ app }) => {
		const box = (el: Element): Rect => {
			const r = el.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
		};
		const sig = (el: Element | null): string => (el === null ? '' : Array.from(el.querySelectorAll('*')).map((n) => `${n.tagName.toLowerCase()}.${n.getAttribute('class') ?? ''}${n.getAttribute('data-e2e-icon') ?? ''}`).join(','));
		const region = (el: Element) => {
			const cs = getComputedStyle(el);
			return cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region');
		};
		const ws = app.workspace.containerEl;
		const strip = ws.querySelector(':scope > .tabstrip-vstrip');
		const panel = strip?.querySelector('.tabstrip-vstrip-panel') ?? null;
		const tree = strip?.querySelector('.tabstrip-vstrip-list') ?? null;
		const sections: SectionState[] = Array.from(tree?.children ?? []).map((sec) => {
			const title = sec.querySelector(':scope > .tabstrip-vpane-title');
			return {
				kind: sec.classList.contains('mod-pinned') ? 'pinned' : 'pane',
				role: sec.getAttribute('role'),
				label: sec.getAttribute('aria-label'),
				title: (title?.textContent ?? '').trim(),
				titleShown: title instanceof HTMLElement && title.offsetHeight > 0,
				items: Array.from(sec.querySelectorAll<HTMLElement>(':scope > [data-tabstrip-item]')).map((el) => {
					const key = el.getAttribute('data-tabstrip-item') ?? '';
					const chip = el.querySelector('.tabstrip-vgroup-chip');
					return {
						kind: key.startsWith('t:') ? 'tab' : key.startsWith('g:') ? 'group' : 'new',
						key,
						leafId: el.getAttribute('data-tabstrip-leaf'),
						groupId: el.getAttribute('data-tabstrip-group'),
						title: (el.querySelector('.tabstrip-vrow-title, .tabstrip-vgroup-label')?.textContent ?? '').trim(),
						icon: sig(el.querySelector('.tabstrip-vrow-icon')),
						classes: Array.from(el.classList),
						color: el.getAttribute('data-tabstrip-color'),
						bar: getComputedStyle(el, '::before').backgroundColor,
						role: el.getAttribute('role'),
						level: el.getAttribute('aria-level'),
						setsize: el.getAttribute('aria-setsize'),
						posinset: el.getAttribute('aria-posinset'),
						expanded: el.getAttribute('aria-expanded'),
						selected: el.getAttribute('aria-selected'),
						label: el.getAttribute('aria-label'),
						tabindex: el.getAttribute('tabindex'),
						count: (el.querySelector('.tabstrip-vgroup-count')?.textContent ?? '').trim(),
						chipFill: chip ? getComputedStyle(chip).backgroundColor : '',
						rect: box(el),
						shown: el.offsetHeight > 0,
						region: region(el),
					};
				}),
			};
		});
		type Tabs = { children: { id: string; tabHeaderEl: HTMLElement; isDeferred: boolean }[]; currentTab: number; containerEl: HTMLElement };
		const tabsList: Tabs[] = [];
		app.workspace.iterateRootLeaves((leaf) => {
			const parent = leaf.parent as unknown as Tabs;
			if (!tabsList.includes(parent)) tabsList.push(parent);
		});
		const leaves = tabsList.flatMap((t) => t.children);
		const rootEl = (app.workspace.rootSplit as unknown as { containerEl: HTMLElement }).containerEl;
		const focused = document.activeElement;
		const focusItem = focused?.closest('[data-tabstrip-item]') ?? null;
		const spines = Array.from(rootEl.querySelectorAll<HTMLElement>('.workspace-tabs.mod-stacked .workspace-tab-container > .workspace-tab-header'));
		const stored = app.loadLocalStorage('tabstrip-session-v1') as { vstrip?: { width?: number; collapsed?: boolean } } | null;
		return {
			mounted: strip !== null,
			collapsed: strip?.classList.contains('is-collapsed') ?? false,
			peek: strip?.classList.contains('is-peek') ?? false,
			strip: strip ? box(strip) : null,
			panel: panel ? box(panel) : null,
			root: box(rootEl),
			treeRole: tree?.getAttribute('role') ?? null,
			sections,
			focusKey: focusItem === focused ? (focusItem?.getAttribute('data-tabstrip-item') ?? null) : null,
			focusOutline: focusItem === focused && focused ? getComputedStyle(focused).outlineStyle : '',
			rootIds: leaves.map((l) => l.id),
			rootTitles: Object.fromEntries(leaves.map((l) => [l.id, (l.tabHeaderEl.querySelector('.workspace-tab-header-inner-title')?.textContent ?? '').trim()])),
			rootIcons: Object.fromEntries(leaves.map((l) => [l.id, sig(l.tabHeaderEl.querySelector('.workspace-tab-header-inner-icon'))])),
			deferred: leaves.filter((l) => l.isDeferred).map((l) => l.id),
			activeId: (app.workspace as unknown as { activeLeaf: { id: string } | null }).activeLeaf?.id ?? null,
			currents: tabsList.map((t) => t.children[t.currentTab]?.id ?? ''),
			nativeShown: Array.from(rootEl.querySelectorAll<HTMLElement>('.workspace-tabs > .workspace-tab-header-container')).filter((c) => c.offsetHeight > 0).length,
			spines: { shown: spines.filter((s) => s.offsetWidth > 0 || s.offsetHeight > 0).length, total: spines.length },
			stored: stored?.vstrip ?? null,
		};
	});
}

const items = (s: ListState) => s.sections.flatMap((x) => x.items);
const shape = (s: ListState) => s.sections.map((x) => `${x.kind}${x.titleShown ? `(${x.title})` : ''}: ${x.items.map((i) => (i.kind === 'tab' ? `${i.level ?? ''}${i.leafId ?? ''}` : i.kind === 'group' ? `${i.level ?? ''}[${i.groupId ?? ''}]` : '+')).join(' ')}`);
const item = (s: ListState, key: string): ItemState => {
	const found = items(s).find((i) => i.key === key);
	if (!found) throw new Error(`no item ${key} in ${JSON.stringify(shape(s))}`);
	return found;
};

async function waitL(ok: (s: ListState) => boolean, what: string, timeout = 6000): Promise<ListState> {
	const start = Date.now();
	let last = await list();
	while (!ok(last)) {
		if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${what}\nlast: ${JSON.stringify({ roots: last.rootIds.length, tabRows: items(last).filter((i) => i.kind === 'tab').length, shape: shape(last), focus: last.focusKey, active: last.activeId, collapsed: last.collapsed, peek: last.peek, strip: last.strip, panel: last.panel })}`);
		await browser.pause(60);
		last = await list();
	}
	return last;
}

const row = (leafId: string) => `.tabstrip-vrow[data-tabstrip-leaf="${leafId}"]`;
const groupRow = (groupId: string) => `.tabstrip-vgroup[data-tabstrip-group="${groupId}"]`;

async function plugin<T>(fn: string, ...args: unknown[]): Promise<T> {
	return browser.executeObsidian(
		({ app }, name, rest) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { debug: Record<string, (...a: unknown[]) => unknown> } | undefined> } }).plugins.plugins['tabstrip'];
			if (!p) throw new Error('tabstrip not loaded');
			const f = p.debug[name];
			if (!f) throw new Error(`no debug ${name}`);
			return JSON.parse(JSON.stringify(f(...rest) ?? null)) as unknown;
		},
		fn,
		args,
	) as Promise<T>;
}

async function groupsState(): Promise<{ id: string; name: string; color: string; collapsed: boolean }[]> {
	return (await pageState()).state.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed }));
}

async function expectNoErrors(): Promise<void> {
	expect(await errorTimeline()).toEqual([]);
}

/** Real pointer: move onto the element's centre (or an offset from its top-left), press and release `button`. */
async function pointerClick(selector: string, button: 0 | 1 | 2 = 0): Promise<void> {
	const el = await $(selector).getElement();
	await browser
		.action('pointer', { parameters: { pointerType: 'mouse' } })
		.move({ origin: el, duration: 0 })
		.down({ button })
		.pause(30)
		.up({ button })
		.perform();
}

async function hover(selector: string): Promise<void> {
	const el = await $(selector).getElement();
	await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ origin: el, duration: 50 }).perform();
}

async function pointerAt(x: number, y: number): Promise<void> {
	await browser.action('pointer', { parameters: { pointerType: 'mouse' } }).move({ x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 50 }).perform();
}

/** Puts the keyboard focus on a tree item (setup only; the keys that follow are real). */
async function focusItem(key: string): Promise<void> {
	await browser.execute((k) => {
		const el = document.querySelector<HTMLElement>(`[data-tabstrip-item="${k}"]`);
		if (!el) throw new Error(`no item ${k}`);
		el.focus();
	}, key);
	await browser.pause(50);
}

interface FocusAt {
	item: string | null;
	inList: boolean;
	inStrip: boolean;
	editable: boolean;
	desc: string;
}

/** Where the keyboard focus is now (read only). */
async function focusAt(): Promise<FocusAt> {
	return browser.execute(() => {
		const a = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const it = a?.closest('[data-tabstrip-item]') ?? null;
		return {
			item: it !== null && it === a ? it.getAttribute('data-tabstrip-item') : null,
			inList: a?.closest('.tabstrip-vstrip-list') != null,
			inStrip: a?.closest('.tabstrip-vstrip') != null,
			editable: a !== null && (a.isContentEditable || a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'),
			desc: a === null ? 'none' : `${a.tagName.toLowerCase()}.${a.className}`,
		};
	});
}

/**
 * Setup only: puts the focus on the first focusable element after the strip in document order (where
 * a Shift+Tab into the strip starts). Throws when that is an editor (Shift+Tab would outdent there).
 */
async function focusAfterStrip(): Promise<string> {
	return browser.execute(() => {
		const strip = document.querySelector('.tabstrip-vstrip');
		if (!strip) throw new Error('no strip');
		const all = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'));
		const next = all.find(
			(el) =>
				!strip.contains(el) &&
				(strip.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
				el.tabIndex >= 0 &&
				!el.hasAttribute('disabled') &&
				el.getClientRects().length > 0 &&
				getComputedStyle(el).visibility !== 'hidden',
		);
		if (!next) throw new Error('nothing focusable after the strip');
		const desc = `${next.tagName.toLowerCase()}.${next.className}`;
		if (next.isContentEditable || next.closest('.cm-editor') !== null) throw new Error(`the first focusable element after the strip is an editor: ${desc}`);
		next.focus();
		if (document.activeElement !== next) throw new Error(`could not focus ${desc}`);
		return desc;
	});
}

/**
 * Real Tab (or Shift+Tab) presses until the focus is on a tree item; returns that item and the path.
 * Fails when the focus reaches an editor first (a Tab there would type) or after `max` presses.
 */
async function tabToTree(back: boolean, max = 8): Promise<{ item: string; path: string[] }> {
	const path: string[] = [];
	for (let i = 0; i < max; i++) {
		await browser.keys(back ? [Key.Shift, Key.Tab] : [Key.Tab]);
		await browser.pause(30);
		const at = await focusAt();
		path.push(at.desc);
		if (at.item !== null) return { item: at.item, path };
		if (at.editable) throw new Error(`${back ? 'Shift+Tab' : 'Tab'} reached an editor before the tree: ${path.join(' > ')}`);
	}
	throw new Error(`${back ? 'Shift+Tab' : 'Tab'} did not reach the tree: ${path.join(' > ')}`);
}

async function menuOpen(): Promise<boolean> {
	return (await menuTitles()).length > 0;
}

async function menuBox(): Promise<Rect | null> {
	return browser.execute(() => {
		const m = document.querySelector('.menu');
		if (!m) return null;
		const r = m.getBoundingClientRect();
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
	});
}

async function editorBox(): Promise<{ box: Rect; focused: boolean; value: string } | null> {
	return browser.execute(() => {
		const e = document.querySelector('.tabstrip-editor');
		if (!e) return null;
		const r = e.getBoundingClientRect();
		const input = e.querySelector('input');
		return { box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }, focused: document.activeElement === input, value: input?.value ?? '' };
	});
}

/** Real pointer onto a menu item, without clicking it. */
async function hoverMenuItem(title: string): Promise<void> {
	const at = await browser.execute((t) => {
		const found = Array.from(document.querySelectorAll('.menu .menu-item')).find((i) => (i.querySelector('.menu-item-title')?.textContent ?? '').trim() === t);
		if (!found) return null;
		const r = found.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}, title);
	if (at === null) throw new Error(`no menu item ${title}`);
	await pointerAt(at.x, at.y);
}

function intersects(a: Rect, b: Rect): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

async function toggleVertical(want: 'vertical' | 'horizontal'): Promise<ListState> {
	expect(await runCommand(CMD.toggle)).toBe(true);
	return waitL((s) => (want === 'vertical' ? s.mounted && items(s).length > 0 : !s.mounted), `orientation ${want}`);
}

async function storedRecord(): Promise<Record<string, unknown> | null> {
	return browser.executeObsidian(({ app }, key) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { flushSave(): void } } | undefined> } }).plugins.plugins['tabstrip'];
		p?.debug.flushSave();
		return app.loadLocalStorage(key) as Record<string, unknown> | null;
	}, KEY);
}

/** Leaves the root split with one pane (closes every other split). */
async function onePane(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		const first = new Set<unknown>();
		let keep: unknown = null;
		app.workspace.iterateRootLeaves((leaf) => {
			keep ??= leaf.parent;
			first.add(leaf);
		});
		const extra: import('obsidian').WorkspaceLeaf[] = [];
		app.workspace.iterateRootLeaves((leaf) => {
			if (leaf.parent !== keep) extra.push(leaf);
		});
		for (const leaf of extra) leaf.detach();
	});
	await browser.pause(200);
}

// ---------------------------------------------------------------- the user's frame (read only)

function userFrame(): string {
	const globalFile = path.join(realHome(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
	const global = JSON.parse(fs.readFileSync(globalFile, 'utf8')) as { frame?: unknown };
	return typeof global.frame === 'string' ? global.frame : 'hidden';
}

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

function setSandboxFrame(frame: string): void {
	const file = path.join(sandboxConfigDir(), 'obsidian.json');
	const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
	json['frame'] = frame;
	fs.writeFileSync(file, JSON.stringify(json));
}

async function restart(): Promise<void> {
	await browser.executeObsidian(async ({ app }) => {
		await app.workspace.requestSaveLayout.run();
	});
	await storedRecord();
	await browser.reloadObsidian({ plugins: ['tabstrip'] });
	await startErrorWatch();
	await browser.waitUntil(async () => browser.executeObsidian(({ app }) => (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins['tabstrip'] !== undefined && app.workspace.layoutReady), {
		timeout: 20000,
		timeoutMsg: 'tabstrip did not load after the restart',
	});
	await browser.pause(800);
}

async function windowButtons(): Promise<Rect> {
	const pos = await browser.execute(() => {
		type Win = { getWindowButtonPosition?: () => { x: number; y: number } | null; getTrafficLightPosition?: () => { x: number; y: number } };
		const w = (window as unknown as { require(m: string): { remote: { getCurrentWindow(): Win } } }).require('electron').remote.getCurrentWindow();
		return (typeof w.getWindowButtonPosition === 'function' ? w.getWindowButtonPosition() : null) ?? (typeof w.getTrafficLightPosition === 'function' ? w.getTrafficLightPosition() : null);
	});
	const p = pos ?? { x: 7, y: 6 };
	return { left: p.x, top: p.y, right: p.x + 54, bottom: p.y + 16, width: 54, height: 16 };
}

/**
 * What is under the traffic lights: points on a grid over their box. A point is "blocked" when the
 * top element there is (inside) something clickable that is not a window drag region.
 */
async function underLights(lights: Rect): Promise<{ points: number; blocked: string[]; drag: number }> {
	return browser.execute((l) => {
		const clickable = 'button, input, .clickable-icon, [role="button"], [role="treeitem"], .view-header-title, .workspace-tab-header, .tabstrip-vstrip-resize';
		let points = 0;
		let drag = 0;
		const blocked: string[] = [];
		for (let x = l.left + 2; x <= l.right - 2; x += 6) {
			for (let y = l.top + 2; y <= l.bottom - 2; y += 4) {
				points++;
				const hit = document.elementFromPoint(x, y);
				if (!hit) continue;
				const c = hit.closest(clickable);
				if (c) blocked.push(`${String(x)},${String(y)} ${c.className}`);
				let el: Element | null = hit;
				while (el) {
					const cs = getComputedStyle(el);
					const r = cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region');
					if (r === 'drag') {
						drag++;
						break;
					}
					if (r === 'no-drag') break;
					el = el.parentElement;
				}
			}
		}
		return { points, blocked, drag };
	}, lights);
}

// ---------------------------------------------------------------- the cases

describe('V2-V4 vertical tab strip: list, mouse, icon bar, resize, keyboard', function () {
	let ids: Record<string, string> = {};
	/** Width left by L7 (keyboard step after the drags), stored per device. */
	let widthAfterL7 = 0;

	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
			app.workspace.leftSplit.collapse();
			app.workspace.rightSplit.collapse();
		});
		await startErrorWatch();
		record('v2-setup', { obsidian: browser.getObsidianVersion(), installer: browser.getObsidianInstallerVersion() });
	});

	after(function () {
		writeEvidence('v2-list');
	});

	// A case that failed may leave a menu or the bubble open: close them, so the next case starts clean.
	beforeEach(async function () {
		if (await menuOpen()) await closeMenus();
		if ((await editorBox()) !== null) await browser.keys(Key.Escape);
	});

	it('L1 list content: pinned area, pane sections (titled only with two panes), group rows with arrow and count, member colour bars, New tab rows, native titles and icons', async function () {
		ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
		const g1 = await makeGroup([ids['n2'] ?? '', ids['n3'] ?? ''], 'Work', 'blue');
		const g2 = await makeGroup([ids['n5'] ?? ''], '', 'orange');
		await setActive(ids['n1'] ?? '');
		let s = await toggleVertical('vertical');
		s = await waitL((x) => items(x).some((i) => i.kind === 'group'), 'group rows');
		expect(s.treeRole).toBe('tree');
		// One pane: no title, no pinned area.
		expect(shape(s)).toEqual([`pane: 1${ids['n1'] ?? ''} 1[${g1}] 2${ids['n2'] ?? ''} 2${ids['n3'] ?? ''} 1${ids['n4'] ?? ''} 1[${g2}] 2${ids['n5'] ?? ''} 1${ids['n6'] ?? ''} 1${ids['n7'] ?? ''} +`]);
		expect(s.sections[0]?.role).toBe('none');
		// Titles and icons are the native headers'.
		for (const i of items(s).filter((x) => x.kind === 'tab')) {
			expect(i.title).toBe(s.rootTitles[i.leafId ?? '']);
			expect(i.icon).toBe(s.rootIcons[i.leafId ?? '']);
		}
		// Group rows: arrow, name (or the colour's group name), count; members carry the group colour bar in the chip's colour.
		const gr = item(s, `g:${g1}`);
		expect(gr.title).toBe('Work');
		expect(gr.count).toBe('2');
		expect(gr.expanded).toBe('true');
		expect(gr.label).toBe('Work, 2 tabs');
		const unnamed = item(s, `g:${g2}`);
		expect(unnamed.title).toBe('Orange group');
		expect(unnamed.count).toBe('1');
		const member = item(s, `t:${ids['n2'] ?? ''}`);
		expect(member.bar).toBe(gr.chipFill);
		expect(member.classes).toContain('is-member');
		expect(item(s, `t:${ids['n1'] ?? ''}`).bar).toBe('rgba(0, 0, 0, 0)');
		const newRow = items(s).at(-1);
		expect(newRow?.kind).toBe('new');
		expect(newRow?.title).toBe('New tab');
		// Pin a tab: a pinned area on top.
		await setPinned(ids['n7'] ?? '', true);
		s = await waitL((x) => x.sections[0]?.kind === 'pinned', 'pinned area');
		expect(shape(s)[0]).toBe(`pinned: 1${ids['n7'] ?? ''}`);
		expect(s.sections[0]?.role).toBe('group');
		expect(s.sections[0]?.label).toBe('Pinned tabs');
		expect(item(s, `t:${ids['n7'] ?? ''}`).label).toContain('pinned');
		// A second pane: one titled section per pane, each with its New tab row.
		const right = await browser.executeObsidian(async ({ app, obsidian }, path) => {
			const leaf = app.workspace.getLeaf('split', 'vertical');
			const file = app.vault.getFileByPath(path);
			if (!(file instanceof obsidian.TFile)) throw new Error('no note');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		}, 'Inbox.md');
		s = await waitL((x) => x.sections.filter((y) => y.kind === 'pane').length === 2, 'two panes');
		const panes = s.sections.filter((x) => x.kind === 'pane');
		expect(panes.map((p) => [p.title, p.titleShown, p.role, p.label])).toEqual([
			['Pane 1', true, 'group', 'Pane 1'],
			['Pane 2', true, 'group', 'Pane 2'],
		]);
		expect(shape(s)[2]).toBe(`pane(Pane 2): 1${right} +`);
		// Tree positions in a section.
		expect(panes[1]?.items.map((i) => [i.level, i.posinset, i.setsize])).toEqual([
			['1', '1', '2'],
			['1', '2', '2'],
		]);
		expect(s.nativeShown).toBe(0);
		record('L1', { shape: shape(s) });
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.detach();
		}, right);
		await setPinned(ids['n7'] ?? '', false);
		await waitL((x) => x.sections.length === 1 && !x.sections.some((y) => y.kind === 'pinned'), 'one pane again');
		await expectNoErrors();
	});

	it('L2 mouse: a click shows the tab, a middle click and the close button close it; a group row click (or its arrow) collapses and expands; the shown tab is never hidden', async function () {
		let s = await list();
		const n4 = ids['n4'] ?? '';
		await pointerClick(row(n4));
		s = await waitL((x) => x.activeId === n4, 'clicked row active');
		expect(item(s, `t:${n4}`).classes).toContain('is-active');
		expect(item(s, `t:${n4}`).selected).toBe('true');
		// Middle click closes (real button 1).
		const extra = await browser.executeObsidian(async ({ app, obsidian }) => {
			const leaf = app.workspace.getLeaf('tab');
			const file = app.vault.getFileByPath('Daily/2026-11-08.md');
			if (!(file instanceof obsidian.TFile)) throw new Error('no note');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		});
		await waitL((x) => x.rootIds.includes(extra) && items(x).some((i) => i.leafId === extra), 'extra row');
		await setActive(n4);
		await pointerClick(row(extra), 1);
		s = await waitL((x) => !x.rootIds.includes(extra) && !items(x).some((i) => i.leafId === extra), 'middle click closed the tab');
		expect(s.activeId).toBe(n4);
		// The close button at the row end (shown on hover).
		const extra2 = await browser.executeObsidian(async ({ app, obsidian }) => {
			const leaf = app.workspace.getLeaf('tab');
			const file = app.vault.getFileByPath('Daily/2026-11-08.md');
			if (!(file instanceof obsidian.TFile)) throw new Error('no note');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		});
		await waitL((x) => items(x).some((i) => i.leafId === extra2), 'extra row 2');
		// Close review: close an INACTIVE tab with the mouse while the editor has the focus. The focus
		// must stay out of the strip, so a following Backspace closes nothing.
		await setActive(n4);
		await browser.executeObsidian(({ app }) => {
			(app.workspace.activeEditor?.editor as { focus(): void } | undefined)?.focus();
		});
		await hover(row(extra2));
		await browser.pause(100);
		await pointerClick(`${row(extra2)} .tabstrip-vrow-close`);
		s = await waitL((x) => !x.rootIds.includes(extra2), 'close button closed the tab');
		const focusInStrip = await browser.execute(() => Boolean(document.activeElement?.closest('.tabstrip-vstrip')));
		expect(focusInStrip).toBe(false);
		const before = s.rootIds.length;
		await browser.keys(['Backspace']);
		await browser.pause(300);
		s = await waitL((x) => x.rootIds.length === before, 'Backspace after a mouse close closed nothing');
		expect(s.activeId).toBe(n4);
		// Group row: click collapses; members hide; click on the arrow expands again.
		const g1 = (await groupsState()).find((g) => g.name === 'Work')?.id ?? '';
		await setActive(n4);
		await pointerClick(groupRow(g1));
		s = await waitL((x) => item(x, `g:${g1}`).expanded === 'false', 'group collapsed');
		expect(items(s).some((i) => i.leafId === ids['n2'])).toBe(false);
		expect(item(s, `g:${g1}`).count).toBe('2');
		expect(item(s, `g:${g1}`).label).toBe('Work, 2 tabs, collapsed');
		expect((await groupsState()).find((g) => g.id === g1)?.collapsed).toBe(true);
		await pointerClick(`${groupRow(g1)} .tabstrip-vgroup-arrow`);
		s = await waitL((x) => item(x, `g:${g1}`).expanded === 'true' && items(x).some((i) => i.leafId === ids['n2']), 'group expanded');
		// Collapsing the group that holds the shown tab first shows the nearest visible tab (same model as the chip).
		const n3 = ids['n3'] ?? '';
		await pointerClick(row(n3));
		await waitL((x) => x.activeId === n3, 'member active');
		await pointerClick(groupRow(g1));
		s = await waitL((x) => item(x, `g:${g1}`).expanded === 'false', 'group with the active tab collapsed');
		expect(s.activeId).toBe(n4);
		expect(items(s).some((i) => i.leafId === n3)).toBe(false);
		// A hidden member that becomes shown expands its group again.
		await setActive(n3);
		s = await waitL((x) => item(x, `g:${g1}`).expanded === 'true', 'group expanded for the shown tab');
		expect(item(s, `t:${n3}`).shown).toBe(true);
		await expectNoErrors();
	});

	it("L3 right click: a tab row opens Obsidian's own tab menu plus the group items; a group row opens the chip menu; the bubble opens at the group row", async function () {
		const n6 = ids['n6'] ?? '';
		const before = (await pageState()).stats.stripMenus;
		await pointerClick(row(n6), 2);
		let titles = await waitForMenu();
		// Native items (built by Obsidian's own tab header handler) and ours.
		expect(titles).toContain('Close');
		expect(titles.some((t) => t === 'Pin' || t === 'Unpin')).toBe(true);
		expect(titles).toContain('Add tab to new group');
		expect(titles.some((t) => t.startsWith('Add tab to group: '))).toBe(true);
		expect((await pageState()).stats.stripMenus).toBe(before + 1);
		const s0 = await list();
		const menu = await menuBox();
		const r6 = item(s0, `t:${n6}`).rect;
		expect(menu).not.toBeNull();
		// At the pointer (over the row), and it stays open (its parent is the visible row).
		expect(Math.abs((menu?.top ?? 0) - (r6.top + r6.height / 2))).toBeLessThanOrEqual(r6.height);
		await browser.pause(1200);
		expect(await menuOpen()).toBe(true);
		const shotMenu = await shot('v2-tab-menu-default-light', 'V2');
		await clickMenuItem('Add tab to new group');
		let s = await waitL((x) => item(x, `t:${n6}`).groupId !== null && items(x).some((i) => i.kind === 'group' && i.groupId === item(x, `t:${n6}`).groupId), 'new group row');
		const g3 = item(s, `t:${n6}`).groupId ?? '';
		// The editor bubble opens at the new group row (below it, aligned with it).
		const ed = await editorBox();
		const gRect = item(s, `g:${g3}`).rect;
		expect(ed).not.toBeNull();
		expect(ed?.focused).toBe(true);
		expect(ed?.box.top ?? 0).toBeGreaterThanOrEqual(gRect.bottom);
		expect((ed?.box.top ?? 0) - gRect.bottom).toBeLessThanOrEqual(12);
		expect(Math.abs((ed?.box.left ?? 0) - gRect.left)).toBeLessThanOrEqual(12);
		await browser.keys(['Notes']);
		await browser.keys(Key.Enter);
		s = await waitL((x) => item(x, `g:${g3}`).title === 'Notes', 'renamed in the bubble');
		// Right click on a group row: the chip menu.
		await pointerClick(groupRow(g3), 2);
		titles = await waitForMenu();
		for (const t of ['Rename group', 'Grey', 'Blue', 'Orange', 'New tab in group', 'Ungroup', 'Close group', 'Collapse other groups']) expect(titles).toContain(t);
		const shotGroupMenu = await shot('v2-group-menu-default-light', 'V2');
		await clickMenuItem('Rename group');
		await browser.waitUntil(async () => (await editorBox()) !== null, { timeout: 3000, timeoutMsg: 'no bubble from the menu' });
		const ed2 = await editorBox();
		s = await list();
		expect(ed2?.box.top ?? 0).toBeGreaterThanOrEqual(item(s, `g:${g3}`).rect.bottom);
		await browser.keys(['Notes 2']);
		await browser.keys(Key.Enter);
		await waitL((x) => item(x, `g:${g3}`).title === 'Notes 2', 'renamed from the menu');
		// "Remove from group" from the native menu of a member row.
		await pointerClick(row(n6), 2);
		titles = await waitForMenu();
		expect(titles).toContain('Remove from group');
		await clickMenuItem('Remove from group');
		s = await waitL((x) => item(x, `t:${n6}`).groupId === null, 'removed from group');
		expect(items(s).some((i) => i.key === `g:${g3}`)).toBe(false);
		record('L3', { titles, shotMenu, shotGroupMenu });
		await expectNoErrors();
	});

	it('L4 keyboard: a tree with roving tabindex; arrows, Home / End, Enter, Space, Delete, F2, Shift+F10; visible focus; IME composition ignored; aria correct', async function () {
		const n1 = ids['n1'] ?? '';
		const n4 = ids['n4'] ?? '';
		const g1 = (await groupsState()).find((g) => g.name === 'Work')?.id ?? '';
		await setActive(n4);
		let s = await list();
		// Exactly one tab stop: the highlighted tab.
		expect(items(s).filter((i) => i.tabindex === '0').map((i) => i.key)).toEqual([`t:${n4}`]);
		for (const i of items(s)) expect(i.role).toBe('treeitem');
		// Review round 3: real Tab presses. From the strip's first header button, Tab goes through the
		// header buttons and lands on the one tab stop (the highlighted tab); one more Tab leaves the tree;
		// Shift+Tab from the first focusable element after the strip comes back to the same row.
		await browser.execute(() => {
			const b = document.querySelector<HTMLElement>('.tabstrip-vstrip-header .clickable-icon');
			if (!b) throw new Error('no header button');
			b.focus();
		});
		const tabIn = await tabToTree(false);
		expect(tabIn.item).toBe(`t:${n4}`);
		expect(tabIn.path.slice(0, -1).every((d) => d.includes('tabstrip-vstrip-collapse') || d.includes('tabstrip-vstrip-toggle'))).toBe(true);
		s = await list();
		expect(s.focusOutline).not.toBe('none');
		await browser.keys(Key.Tab);
		const tabOut = await focusAt();
		expect(tabOut.inList).toBe(false);
		expect(tabOut.item).toBeNull();
		const after = await focusAfterStrip();
		const shiftIn = await tabToTree(true);
		expect(shiftIn.item).toBe(`t:${n4}`);
		// Only the edge handle (the strip's last stop) may come between.
		expect(shiftIn.path.slice(0, -1).every((d) => d.includes('tabstrip-vstrip-resize'))).toBe(true);
		record('L4-tab', { tabIn: tabIn.path, tabOut: tabOut.desc, after, shiftIn: shiftIn.path });
		await focusItem(`t:${n1}`);
		await browser.keys(Key.ArrowDown);
		s = await waitL((x) => x.focusKey === `g:${g1}`, 'down to the group row');
		expect(s.focusOutline).not.toBe('none');
		expect(items(s).filter((i) => i.tabindex === '0').map((i) => i.key)).toEqual([`g:${g1}`]);
		// The tab stop moved with the focus: Tab out and Shift+Tab back lands on the group row.
		await browser.keys(Key.Tab);
		expect((await focusAt()).inList).toBe(false);
		expect((await tabToTree(true)).item).toBe(`g:${g1}`);
		await browser.keys(Key.ArrowDown);
		await waitL((x) => x.focusKey === `t:${ids['n2'] ?? ''}`, 'down to the first member');
		await browser.keys(Key.ArrowUp);
		await waitL((x) => x.focusKey === `g:${g1}`, 'up to the group row');
		await browser.keys(Key.End);
		s = await waitL((x) => x.focusKey?.startsWith('n:') === true, 'End: New tab row');
		const first = items(s)[0]?.key ?? '';
		await browser.keys(Key.Home);
		s = await waitL((x) => x.focusKey === first, 'Home: first row');
		// Enter shows the focused tab.
		const steps = items(s).findIndex((i) => i.key === `t:${ids['n3'] ?? ''}`);
		expect(steps).toBeGreaterThan(0);
		for (let k = 0; k < steps; k++) await browser.keys(Key.ArrowDown);
		await waitL((x) => x.focusKey === `t:${ids['n3'] ?? ''}`, 'down to n3');
		await browser.keys(Key.Enter);
		await waitL((x) => x.activeId === ids['n3'], 'Enter showed the tab');
		// Space on the group row collapses it (the shown member gives way); the focus stays on the group row.
		await focusItem(`g:${g1}`);
		await browser.keys(Key.Space);
		s = await waitL((x) => item(x, `g:${g1}`).expanded === 'false', 'Space collapsed the group');
		expect(s.focusKey).toBe(`g:${g1}`);
		expect(s.activeId).not.toBe(ids['n3']);
		// Arrow Right expands, Arrow Left collapses, Left on a member goes to its group row.
		await browser.keys(Key.ArrowRight);
		s = await waitL((x) => item(x, `g:${g1}`).expanded === 'true', 'Right expanded');
		expect(s.focusKey).toBe(`g:${g1}`);
		await browser.keys(Key.ArrowRight);
		await waitL((x) => x.focusKey === `t:${ids['n2'] ?? ''}`, 'Right to the first member');
		await browser.keys(Key.ArrowLeft);
		await waitL((x) => x.focusKey === `g:${g1}`, 'Left to the group row');
		await browser.keys(Key.ArrowLeft);
		await waitL((x) => item(x, `g:${g1}`).expanded === 'false', 'Left collapsed');
		await browser.keys(Key.Enter);
		await waitL((x) => item(x, `g:${g1}`).expanded === 'true', 'Enter expanded');
		// F2 renames the focused group: the bubble opens at its row; Enter commits, the focus returns to the row.
		await browser.keys(Key.F2);
		await browser.waitUntil(async () => (await editorBox())?.focused === true, { timeout: 3000, timeoutMsg: 'F2 opened no bubble' });
		s = await list();
		expect((await editorBox())?.box.top ?? 0).toBeGreaterThanOrEqual(item(s, `g:${g1}`).rect.bottom);
		// The bubble opens with the name selected: typing replaces it.
		await browser.keys(['Work 2']);
		await browser.keys(Key.Enter);
		s = await waitL((x) => item(x, `g:${g1}`).title === 'Work 2' && x.focusKey === `g:${g1}`, 'F2 renamed, focus back on the row');
		await browser.keys(['ArrowDown']);
		// IME composition: a composing Enter / Delete / F2 does nothing (dispatched as composing key events on the focused row).
		const imeBefore = { groups: await groupsState(), ids: (await list()).rootIds, active: (await list()).activeId };
		await browser.execute(() => {
			const el = document.activeElement;
			if (!el) throw new Error('no focus');
			for (const key of ['Enter', 'Delete', 'F2', ' ']) el.dispatchEvent(new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true }));
			el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, bubbles: true, cancelable: true }));
		});
		await browser.pause(300);
		expect({ groups: await groupsState(), ids: (await list()).rootIds, active: (await list()).activeId }).toEqual(imeBefore);
		expect(await editorBox()).toBeNull();
		// Shift+F10 on a tab row: the native tab menu with the group items, under the row.
		await focusItem(`t:${n4}`);
		await browser.keys([Key.Shift, Key.F10]);
		let titles = await waitForMenu();
		expect(titles).toContain('Close');
		expect(titles).toContain('Add tab to new group');
		s = await list();
		const menu = await menuBox();
		const r4 = item(s, `t:${n4}`).rect;
		const winH = await browser.execute(() => window.innerHeight);
		record('L4-key-menu', { menu, row: r4, winH, items: titles.length });
		// At the row's start; under the row, unless the menu is too tall for the room below it (the
		// shown tab's menu has the view's items too): then Obsidian moves it up, and it still reaches the row.
		expect(Math.abs((menu?.left ?? 0) - (r4.left + 12))).toBeLessThanOrEqual(4);
		if ((menu?.height ?? 0) <= winH - r4.bottom - 8) expect(menu?.top ?? 0).toBeGreaterThanOrEqual(r4.bottom - 2);
		else expect(menu?.bottom ?? 0).toBeGreaterThanOrEqual(r4.bottom);
		// Review round 1: Escape closes the menu and the focus goes back to the row that opened it.
		await closeMenus();
		s = await waitL((x) => x.focusKey === `t:${n4}`, 'Escape: focus back on the tab row', 3000);
		expect(s.focusOutline).not.toBe('none');
		// Review round 3: a tab row whose menu fits below it (a background tab near the top): the menu
		// opens under the row's start, so the "under the row" branch above is really exercised.
		await focusItem(`t:${n1}`);
		await browser.keys([Key.Shift, Key.F10]);
		titles = await waitForMenu();
		expect(titles).toContain('Add tab to new group');
		s = await list();
		const menu1 = await menuBox();
		const r1 = item(s, `t:${n1}`).rect;
		record('L4-key-menu-background', { menu: menu1, row: r1, winH, items: titles.length });
		expect(menu1?.height ?? 0).toBeLessThanOrEqual(winH - r1.bottom - 8);
		expect(Math.abs((menu1?.left ?? 0) - (r1.left + 12))).toBeLessThanOrEqual(4);
		expect(menu1?.top ?? 0).toBeGreaterThanOrEqual(r1.bottom - 2);
		expect((menu1?.top ?? 0) - r1.bottom).toBeLessThanOrEqual(12);
		await closeMenus();
		await waitL((x) => x.focusKey === `t:${n1}`, 'Escape: focus back on the background tab row', 3000);
		// Shift+F10 on a group row: the chip menu, under the group row's start (a short menu: it fits);
		// Escape puts the focus back on the group row.
		await focusItem(`g:${g1}`);
		await browser.keys([Key.Shift, Key.F10]);
		titles = await waitForMenu();
		expect(titles).toContain('Rename group');
		s = await list();
		const gMenu = await menuBox();
		const rg = item(s, `g:${g1}`).rect;
		record('L4-key-menu-group', { menu: gMenu, row: rg, winH, items: titles.length });
		expect(gMenu?.height ?? 0).toBeLessThanOrEqual(winH - rg.bottom - 8);
		expect(Math.abs((gMenu?.left ?? 0) - rg.left)).toBeLessThanOrEqual(4);
		expect(gMenu?.top ?? 0).toBeGreaterThanOrEqual(rg.bottom - 2);
		expect((gMenu?.top ?? 0) - rg.bottom).toBeLessThanOrEqual(12);
		await closeMenus();
		await waitL((x) => x.focusKey === `g:${g1}`, 'Escape: focus back on the group row', 3000);

		// Delete closes the focused tab; the focus stays in the tree (on the next item).
		const extra = await browser.executeObsidian(async ({ app, obsidian }) => {
			const leaf = app.workspace.getLeaf('tab');
			const file = app.vault.getFileByPath('Daily/2026-11-08.md');
			if (!(file instanceof obsidian.TFile)) throw new Error('no note');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		});
		await waitL((x) => items(x).some((i) => i.leafId === extra), 'extra row');
		await focusItem(`t:${extra}`);
		await browser.keys(Key.Delete);
		s = await waitL((x) => !x.rootIds.includes(extra) && x.focusKey !== null, 'Delete closed the tab');
		expect(items(s).filter((i) => i.tabindex === '0')).toHaveLength(1);
		// Enter on the New tab row makes a tab at the end of the pane.
		const count = s.rootIds.length;
		await browser.keys(Key.End);
		await waitL((x) => x.focusKey?.startsWith('n:') === true, 'End');
		await browser.keys(Key.Enter);
		s = await waitL((x) => x.rootIds.length === count + 1, 'New tab row made a tab');
		const made = s.rootIds.at(-1) ?? '';
		expect(s.activeId).toBe(made);
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.detach();
		}, made);
		// aria: levels, set sizes, expanded on group rows only, selected on tabs.
		s = await waitL((x) => !x.rootIds.includes(made), 'made tab closed');
		for (const i of items(s)) {
			if (i.kind === 'group') expect(['true', 'false']).toContain(i.expanded);
			else expect(i.expanded).toBeNull();
			if (i.kind === 'tab') expect(['true', 'false']).toContain(i.selected);
			expect(Number(i.posinset)).toBeGreaterThanOrEqual(1);
			expect(Number(i.posinset)).toBeLessThanOrEqual(Number(i.setsize));
		}
		expect(items(s).filter((i) => i.selected === 'true')).toHaveLength(1);
		record('L4', { shape: shape(s) });
		await expectNoErrors();
	});

	it('L5 one group model with the horizontal strip: switching orientation keeps groups, pinned and collapsed state; stacked panes show no spines in vertical mode', async function () {
		const g1 = (await pageState()).state.members.find((m) => m.leafId === ids['n2'])?.groupId ?? '';
		expect(g1).not.toBe('');
		await setActive(ids['n1'] ?? '');
		await pointerClick(groupRow(g1));
		await waitL((x) => item(x, `g:${g1}`).expanded === 'false', 'collapsed');
		await setPinned(ids['n7'] ?? '', true);
		await waitL((x) => x.sections[0]?.kind === 'pinned', 'pinned');
		const before = await groupsState();
		const layoutBefore = await browser.executeObsidian(({ app }) => JSON.stringify(app.workspace.getLayout()));
		await toggleVertical('horizontal');
		const h = await pageState();
		expect(h.state.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed }))).toEqual(before);
		expect(h.chips.find((c) => c.groupId === g1)?.ariaLabel).toContain('collapsed');
		expect(h.strips[0]?.pinned[h.strips[0].leafIds.indexOf(ids['n7'] ?? '')]).toBe(true);
		const s = await toggleVertical('vertical');
		expect(await groupsState()).toEqual(before);
		expect(item(s, `g:${g1}`).expanded).toBe('false');
		expect(s.sections[0]?.kind).toBe('pinned');
		expect(await browser.executeObsidian(({ app }) => JSON.stringify(app.workspace.getLayout()))).toBe(layoutBefore);
		await setPinned(ids['n7'] ?? '', false);
		await pointerClick(groupRow(g1));
		await waitL((x) => item(x, `g:${g1}`).expanded === 'true', 'expanded again');
		// Review round 3: a group collapsed before its pane is stacked. Stacked tabs never hide tabs, so the
		// group row says expanded (arrow down, aria-expanded true) while its members are listed; Arrow Right
		// goes to the first member; asking to collapse it (Arrow Left, a click) says why nothing happens.
		await pointerClick(groupRow(g1));
		await waitL((x) => item(x, `g:${g1}`).expanded === 'false', 'collapsed before stacking');
		await browser.executeObsidian(({ app }) => {
			const leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
			(leaf?.parent as unknown as { setStacked(on: boolean): void }).setStacked(true);
		});
		const memberKeys = [`t:${ids['n2'] ?? ''}`, `t:${ids['n3'] ?? ''}`];
		let st = await waitL((x) => x.spines.total > 0 && memberKeys.every((k) => items(x).some((i) => i.key === k)), 'stacked: members listed');
		const gStacked = item(st, `g:${g1}`);
		expect((await groupsState()).find((g) => g.id === g1)?.collapsed).toBe(true);
		expect(gStacked.expanded).toBe('true');
		expect(gStacked.classes).not.toContain('is-collapsed');
		expect(gStacked.label ?? '').not.toContain('collapsed');
		const arrowIcon = await browser.execute((sel: string) => document.querySelector(`${sel} .tabstrip-vgroup-arrow svg`)?.getAttribute('class') ?? '', groupRow(g1));
		expect(arrowIcon).toContain('chevron-down');
		for (const k of memberKeys) expect(item(st, k).level).toBe('2');
		const stackNotices = async () =>
			browser.execute(() => Array.from(document.querySelectorAll('.notice')).filter((n) => (n.textContent ?? '').includes('cannot be collapsed in stacked tabs')).length);
		const noticesBefore = await stackNotices();
		await focusItem(`g:${g1}`);
		await browser.keys(Key.ArrowRight);
		await waitL((x) => x.focusKey === memberKeys[0], 'stacked: Right to the first member');
		await browser.keys(Key.ArrowLeft);
		await waitL((x) => x.focusKey === `g:${g1}`, 'stacked: Left back to the group row');
		await browser.keys(Key.ArrowLeft);
		await browser.waitUntil(async () => (await stackNotices()) > noticesBefore, { timeout: 3000, timeoutMsg: 'Arrow Left on the stacked group gave no notice' });
		st = await list();
		expect(item(st, `g:${g1}`).expanded).toBe('true');
		expect(st.focusKey).toBe(`g:${g1}`);
		expect((await groupsState()).find((g) => g.id === g1)?.collapsed).toBe(true);
		record('L5-stacked-collapsed', { group: gStacked, arrowIcon, shape: shape(st) });
		// Stacked tabs: their spines are hidden with the header rows (V1 review note), the notes still show.
		expect(st.spines.shown).toBe(0);
		expect(st.nativeShown).toBe(0);
		const leavesShown = await browser.executeObsidian(({ app }) => {
			let n = 0;
			app.workspace.iterateRootLeaves((leaf) => {
				const el = (leaf as unknown as { containerEl: HTMLElement }).containerEl;
				if (el.offsetWidth > 0) n++;
			});
			return n;
		});
		expect(leavesShown).toBeGreaterThan(1);
		// Back to horizontal: the spines are back.
		await toggleVertical('horizontal');
		st = await list();
		expect(st.spines.shown).toBe(st.spines.total);
		await browser.executeObsidian(({ app }) => {
			const leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
			(leaf?.parent as unknown as { setStacked(on: boolean): void }).setStacked(false);
		});
		await toggleVertical('vertical');
		// Unstacked, the group is collapsed again (the model kept it); a click expands it for what follows.
		st = await waitL((x) => item(x, `g:${g1}`).expanded === 'false' && !items(x).some((i) => i.key === memberKeys[0]), 'unstacked: collapsed again');
		await pointerClick(groupRow(g1));
		await waitL((x) => item(x, `g:${g1}`).expanded === 'true', 'expanded after unstacking');
		record('L5', { before, spines: st.spines, leavesShown });
		await expectNoErrors();
	});

	it('L6 icon bar: the command and the header button collapse to about 48px (icons, group markers, active mark) and expand; hover opens it as an overlay without reflow and leaving closes it', async function () {
		expect(await commandAvailable(CMD.collapse)).toBe(true);
		const wide = await list();
		expect(wide.collapsed).toBe(false);
		expect(await runCommand(CMD.collapse)).toBe(true);
		let s = await waitL((x) => x.collapsed && (x.strip?.width ?? 0) < 60, 'icon bar');
		expect(s.strip?.width).toBeGreaterThanOrEqual(44);
		expect(s.strip?.width).toBeLessThanOrEqual(52);
		// The workspace reflows once for the narrower strip (the root split moves left by the difference).
		expect(Math.abs(wide.root.left - s.root.left - ((wide.strip?.width ?? 0) - (s.strip?.width ?? 0)))).toBeLessThanOrEqual(1);
		// Icons only: titles hidden, every row inside the bar; the highlighted tab keeps its mark; groups are markers.
		const titlesShown = await browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.tabstrip-vstrip .tabstrip-vrow-title, .tabstrip-vstrip .tabstrip-vgroup-label')).filter((e) => e.offsetWidth > 0).length);
		expect(titlesShown).toBe(0);
		for (const i of items(s)) {
			expect(i.rect.right).toBeLessThanOrEqual((s.strip?.right ?? 0) + 0.5);
			// Labels stay for screen readers.
			if (i.kind !== 'new') expect(i.label ?? '').not.toBe('');
		}
		expect(items(s).filter((i) => i.classes.includes('is-active'))).toHaveLength(1);
		const marker = items(s).find((i) => i.kind === 'group');
		expect(marker?.chipFill).not.toBe('rgba(0, 0, 0, 0)');
		await pointerAt(600, 400);
		await browser.pause(PEEK_WAIT);
		const shotBar = await shot('v2-icon-bar-default-light', 'V2');
		// Review round 2: opening the overlay moves no row. The real pointer rests on a group marker and
		// on a tab icon further down; after the overlay has opened fully the same row is under it, and
		// every row keeps its top and height.
		const barRows = items(s);
		const lowTab = barRows.filter((i) => i.kind === 'tab').at(-1);
		for (const target of [marker, lowTab]) {
			if (!target) throw new Error('no marker or tab row in the bar');
			await pointerAt(600, 400);
			await waitL((x) => !x.peek && (x.panel?.width ?? 999) < 60, 'bar before the pointer check', 3000);
			const px = Math.round(target.rect.left + target.rect.width / 2);
			const py = Math.round(target.rect.top + target.rect.height / 2);
			const under = async () =>
				browser.execute(
					(x: number, y: number) => {
						const el = document.elementFromPoint(x, y)?.closest('.tabstrip-vrow, .tabstrip-vgroup, .tabstrip-vnew');
						return el instanceof HTMLElement ? (el.dataset['tabstripLeaf'] ?? el.dataset['tabstripGroup'] ?? 'new') : null;
					},
					px,
					py,
				);
			const before = await under();
			expect(before).toBe(target.leafId ?? target.groupId);
			await pointerAt(px, py);
			const open = await waitL((x) => x.peek && (x.panel?.width ?? 0) >= 239, 'overlay open over the row', 3000);
			await browser.pause(150);
			expect(await under()).toBe(before);
			const moved = items(open)
				.map((i) => ({ key: i.key, bar: barRows.find((b) => b.key === i.key)?.rect, now: i.rect }))
				.filter((m) => m.bar === undefined || Math.abs(m.bar.top - m.now.top) > 0.5 || Math.abs(m.bar.height - m.now.height) > 0.5);
			record(`L6-steady-${target.kind}`, { px, py, before, moved });
			expect(moved).toEqual([]);
		}
		await pointerAt(600, 400);
		s = await waitL((x) => !x.peek && (x.panel?.width ?? 999) < 60, 'bar again', 3000);
		// Hover: after a short delay the panel opens over the workspace; the strip's own box and the root split do not move.
		const rootBefore = s.root;
		await hover(`.tabstrip-vstrip .tabstrip-vrow`);
		s = await waitL((x) => x.peek && (x.panel?.width ?? 0) > 200, 'hover overlay', 3000);
		expect(s.strip?.width).toBeLessThanOrEqual(52);
		expect(s.root).toEqual(rootBefore);
		const hit = await browser.execute((x: number, y: number) => document.elementFromPoint(x, y)?.closest('.tabstrip-vstrip') !== null, (s.panel?.left ?? 0) + 150, (s.panel?.top ?? 0) + 200);
		expect(hit).toBe(true);
		const shotPeek = await shot('v2-hover-overlay-default-light', 'V2');
		// A click in the overlay shows that tab; the overlay stays while hovered.
		const target = items(s).find((i) => i.kind === 'tab' && !i.classes.includes('is-active'));
		await pointerClick(row(target?.leafId ?? ''));
		await waitL((x) => x.activeId === target?.leafId, 'click in the overlay');
		// Leaving closes it after a short delay.
		await pointerAt(700, 400);
		s = await waitL((x) => !x.peek && (x.panel?.width ?? 999) < 60, 'overlay closed', 3000);
		expect(s.collapsed).toBe(true);
		// Review round 3: real keys into the icon bar. The click above left a pointer focus behind; a
		// Shift+Tab from the first focusable element after the strip lands on the bar's one tab stop (the
		// row just clicked) and opens the overlay. The pointer passing over the bar and leaving does not
		// close it (the keyboard focus holds it); Tab out of the strip closes it.
		const afterBar = await focusAfterStrip();
		const barIn = await tabToTree(true, 1);
		expect(barIn.item).toBe(`t:${target?.leafId ?? ''}`);
		await waitL((x) => x.peek && (x.panel?.width ?? 0) >= 239, 'Shift+Tab into the bar opened the overlay', 3000);
		await hover(row(target?.leafId ?? ''));
		await browser.pause(150);
		await pointerAt(700, 400);
		await browser.pause(PEEK_WAIT + 300);
		s = await list();
		expect(s.peek).toBe(true);
		expect(s.focusKey).toBe(`t:${target?.leafId ?? ''}`);
		await browser.keys(Key.Tab);
		s = await waitL((x) => !x.peek && (x.panel?.width ?? 999) < 60, 'Tab out of the bar: overlay closed', 3000);
		expect((await focusAt()).inStrip).toBe(false);
		record('L6-tab', { afterBar, barIn: barIn.path });
		// Keyboard focus in the bar opens it too (and Escape-less leaving by focus closes it).
		await focusItem(`t:${target?.leafId ?? ''}`);
		await waitL((x) => x.peek, 'focus opens the overlay', 3000);
		await browser.executeObsidian(({ app }) => {
			const leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
			if (leaf) app.workspace.setActiveLeaf(leaf, { focus: true });
		});
		await waitL((x) => !x.peek, 'focus left: overlay closed', 3000);
		// The header button expands again (real click), from the open overlay.
		await pointerAt(700, 400);
		await browser.pause(PEEK_WAIT);
		await hover(`.tabstrip-vstrip ${row(target?.leafId ?? '')}`);
		// Wait until the overlay has opened fully (its width animates): the button moves while it does.
		await waitL((x) => x.peek && (x.panel?.width ?? 0) >= 239, 'overlay for the button', 3000);
		await browser.pause(150);
		const buttonHit = await browser.execute(() => {
			const b = document.querySelector('.tabstrip-vstrip-collapse');
			if (!b) return null;
			const r = b.getBoundingClientRect();
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return { rect: [r.left, r.top, r.width, r.height], hit: hit === null ? null : `${hit.tagName}.${hit.className}`, inside: hit !== null && b.contains(hit) };
		});
		record('L6-button', buttonHit);
		await pointerClick('.tabstrip-vstrip-collapse');
		s = await waitL((x) => !x.collapsed && (x.strip?.width ?? 0) > 200, 'expanded by the button');
		await storedRecord();
		expect((await list()).stored?.collapsed).toBeUndefined();
		await pointerAt(700, 400);
		// The button collapses too, and the state is stored.
		await pointerClick('.tabstrip-vstrip-collapse');
		s = await waitL((x) => x.collapsed, 'collapsed by the button');
		await storedRecord();
		expect((await list()).stored?.collapsed).toBe(true);
		expect(await runCommand(CMD.collapse)).toBe(true);
		await waitL((x) => !x.collapsed, 'expanded by the command');
		record('L6', { shotBar, shotPeek });
		await expectNoErrors();
	});

	it('L6b review round 1: group commands in vertical mode; in the icon bar, mouse clicks do not keep the overlay open, menus and the rename bubble do', async function () {
		this.timeout(180000);
		ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const gR = await makeGroup([ids['n2'] ?? '', ids['n3'] ?? ''], 'Review', 'green');
		await setActive(ids['n4'] ?? '');
		let s = await list();
		if (s.collapsed) {
			await runCommand(CMD.collapse);
			s = await waitL((x) => !x.collapsed, 'expanded');
		}
		const fullRow = (x: ListState) => item(x, `g:${gR}`).rect.width > 150;
		const bubbleAtRow = (x: ListState, ed: { box: Rect } | null) => {
			const r = item(x, `g:${gR}`).rect;
			expect(ed).not.toBeNull();
			expect(ed?.box.top ?? 0).toBeGreaterThanOrEqual(r.bottom);
			expect((ed?.box.top ?? 0) - r.bottom).toBeLessThanOrEqual(12);
			expect(Math.abs((ed?.box.left ?? 0) - r.left)).toBeLessThanOrEqual(12);
		};
		const focusEditor = async () => {
			await browser.executeObsidian(({ app }) => {
				const leaf = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
				if (leaf) app.workspace.setActiveLeaf(leaf, { focus: true });
			});
		};
		// V1 final review: the group commands act on the group row in vertical mode.
		await setActive(ids['n2'] ?? '');
		expect(await runCommand('tabstrip:toggle-collapse-current-group')).toBe(true);
		s = await waitL((x) => item(x, `g:${gR}`).expanded === 'false', 'command collapsed the group row');
		expect(s.activeId).not.toBe(ids['n2']);
		await pointerClick(groupRow(gR));
		await waitL((x) => item(x, `g:${gR}`).expanded === 'true', 'group row click expanded it');
		await setActive(ids['n3'] ?? '');
		expect(await runCommand('tabstrip:rename-group')).toBe(true);
		await browser.waitUntil(async () => (await editorBox())?.focused === true, { timeout: 3000, timeoutMsg: 'rename command opened no bubble' });
		bubbleAtRow(await list(), await editorBox());
		await browser.keys(Key.Escape);
		await browser.waitUntil(async () => (await editorBox()) === null, { timeout: 3000, timeoutMsg: 'bubble did not close' });

		expect(await runCommand(CMD.collapse)).toBe(true);
		await waitL((x) => x.collapsed && (x.strip?.width ?? 0) < 60, 'icon bar');
		await pointerAt(700, 400);
		await browser.pause(PEEK_WAIT);
		const openOverlay = async () => {
			await hover(row(ids['n1'] ?? ''));
			return waitL((x) => x.peek && (x.panel?.width ?? 0) >= 239, 'overlay open', 3000);
		};
		const leaveAndClose = async (what: string) => {
			await pointerAt(700, 400);
			return waitL((x) => !x.peek && (x.panel?.width ?? 999) < 60, what, 3000);
		};
		// 1. A mouse click on a group marker in the overlay toggles the group; the click leaves the focus
		// in the strip, and still the overlay closes once the pointer leaves.
		await openOverlay();
		await pointerClick(groupRow(gR));
		await waitL((x) => item(x, `g:${gR}`).expanded === 'false', 'marker click collapsed');
		const focusInStrip = await browser.execute(() => document.activeElement?.closest('.tabstrip-vstrip') != null);
		await leaveAndClose('overlay closed after a group marker click');
		await openOverlay();
		await pointerClick(groupRow(gR));
		await waitL((x) => item(x, `g:${gR}`).expanded === 'true', 'marker click expanded');
		await leaveAndClose('overlay closed after the second marker click');
		// 2. The same after a click on a sidebar button of the bar (open and close the right sidebar).
		await openOverlay();
		await pointerClick('.tabstrip-vstrip-toggle.mod-right');
		await browser.pause(300);
		await pointerClick('.tabstrip-vstrip-toggle.mod-right');
		const buttonFocused = await browser.execute(() => document.activeElement?.classList.contains('tabstrip-vstrip-toggle') === true);
		await leaveAndClose('overlay closed after a sidebar button click');
		// 3. Right click in the overlay, the pointer moves onto the menu: the overlay stays open past its
		// close delay; "Add tab to new group" opens the bubble under the whole group row, which stays put.
		await openOverlay();
		await pointerClick(row(ids['n5'] ?? ''), 2);
		await waitForMenu();
		await hoverMenuItem('Add tab to new group');
		await browser.pause(PEEK_WAIT + 200);
		s = await list();
		expect(s.peek).toBe(true);
		expect(await menuOpen()).toBe(true);
		await clickMenuItem('Add tab to new group');
		s = await waitL((x) => item(x, `t:${ids['n5'] ?? ''}`).groupId !== null && items(x).some((i) => i.key === `g:${item(x, `t:${ids['n5'] ?? ''}`).groupId ?? ''}`), 'new group from the overlay menu');
		const gNew = item(s, `t:${ids['n5'] ?? ''}`).groupId ?? '';
		await browser.waitUntil(async () => (await editorBox())?.focused === true, { timeout: 3000, timeoutMsg: 'no bubble from the overlay menu' });
		const ed1 = await editorBox();
		await browser.pause(PEEK_WAIT + 200);
		s = await list();
		expect(s.peek).toBe(true);
		expect(item(s, `g:${gNew}`).rect.width).toBeGreaterThan(150);
		const ed2 = await editorBox();
		expect(ed2?.box).toEqual(ed1?.box);
		const rNew = item(s, `g:${gNew}`).rect;
		expect(ed2?.box.top ?? 0).toBeGreaterThanOrEqual(rNew.bottom);
		expect((ed2?.box.top ?? 0) - rNew.bottom).toBeLessThanOrEqual(12);
		const shotBubble = await shot('v2-icon-bar-bubble-default-light', 'V2');
		await browser.keys(['Later']);
		await browser.keys(Key.Enter);
		await waitL((x) => item(x, `g:${gNew}`).title === 'Later', 'named from the overlay');
		await leaveAndClose('overlay closed after the bubble');
		// 4. F2 from the keyboard in the bar: the overlay opens for the focus, the bubble sits under the
		// whole group row and the overlay stays; Escape gives the focus back to the row (overlay still
		// open for the keyboard focus); the focus leaving closes it.
		await focusEditor();
		await focusItem(`g:${gR}`);
		await waitL((x) => x.peek && fullRow(x), 'focus opened the overlay', 3000);
		await browser.keys(Key.F2);
		await browser.waitUntil(async () => (await editorBox())?.focused === true, { timeout: 3000, timeoutMsg: 'F2 opened no bubble in the icon bar' });
		const f2a = await editorBox();
		await browser.pause(PEEK_WAIT + 200);
		s = await list();
		expect(s.peek).toBe(true);
		expect(fullRow(s)).toBe(true);
		expect((await editorBox())?.box).toEqual(f2a?.box);
		bubbleAtRow(s, await editorBox());
		await browser.keys(Key.Escape);
		await waitL((x) => x.focusKey === `g:${gR}`, 'Escape: focus back on the group row', 3000);
		await browser.pause(PEEK_WAIT + 200);
		expect((await list()).peek).toBe(true);
		// Shift+F10 in the bar, Escape: the focus is back on the row and the overlay stays.
		await browser.keys([Key.Shift, Key.F10]);
		await waitForMenu();
		await closeMenus();
		s = await waitL((x) => x.focusKey === `g:${gR}`, 'Escape from the key menu: focus back on the group row', 3000);
		expect(s.peek).toBe(true);
		await focusEditor();
		await waitL((x) => !x.peek, 'focus left: overlay closed', 3000);
		// 5. The rename command while the bar is closed: the overlay opens for the bubble, and closes with it.
		await setActive(ids['n2'] ?? '');
		expect(await runCommand('tabstrip:rename-group')).toBe(true);
		await browser.waitUntil(async () => (await editorBox())?.focused === true, { timeout: 3000, timeoutMsg: 'rename command opened no bubble in the icon bar' });
		s = await list();
		expect(s.peek).toBe(true);
		bubbleAtRow(s, await editorBox());
		await browser.keys(Key.Escape);
		await waitL((x) => !x.peek, 'bubble closed: overlay closed', 3000);
		expect(await runCommand(CMD.collapse)).toBe(true);
		await waitL((x) => !x.collapsed, 'expanded');
		record('L6b', { focusInStrip, buttonFocused, shotBubble });
		await expectNoErrors();
	});

	it('L7 resize: dragging the edge follows the pointer within 180-480 px, is stored per device; the sidebars keep their own resizing', async function () {
		await pointerAt(700, 400);
		let s = await list();
		const handle = await browser.execute(() => {
			const h = document.querySelector('.tabstrip-vstrip-resize');
			if (!h) throw new Error('no handle');
			const r = h.getBoundingClientRect();
			return { x: r.left + r.width / 2, y: r.top + r.height / 2, role: h.getAttribute('role'), now: h.getAttribute('aria-valuenow') };
		});
		expect(handle.role).toBe('separator');
		expect(handle.now).toBe(String(Math.round(s.strip?.width ?? 0)));
		const drag = async (dx: number) => {
			await browser
				.action('pointer', { parameters: { pointerType: 'mouse' } })
				.move({ x: Math.round(handle.x), y: Math.round(handle.y), origin: 'viewport' })
				.down({ button: 0 })
				.move({ x: Math.round(handle.x + dx / 2), y: Math.round(handle.y), origin: 'viewport', duration: 100 })
				.move({ x: Math.round(handle.x + dx), y: Math.round(handle.y), origin: 'viewport', duration: 100 })
				.up({ button: 0 })
				.perform();
			await browser.pause(200);
		};
		const w0 = s.strip?.width ?? 0;
		const gap = s.root.left - (s.strip?.right ?? 0);
		await drag(80);
		s = await list();
		expect(Math.abs((s.strip?.width ?? 0) - (w0 + 80))).toBeLessThanOrEqual(2);
		// The workspace follows the strip's edge.
		expect(Math.abs(s.root.left - (s.strip?.right ?? 0) - gap)).toBeLessThanOrEqual(1);
		await storedRecord();
		expect((await list()).stored?.width).toBe(Math.round(s.strip?.width ?? 0));
		// Clamped.
		handle.x = (s.strip?.right ?? 0) - 3;
		await drag(-200);
		s = await list();
		expect(s.strip?.width).toBe(180);
		handle.x = (s.strip?.right ?? 0) - 3;
		await drag(600);
		s = await list();
		expect(s.strip?.width).toBe(480);
		handle.x = (s.strip?.right ?? 0) - 3;
		await drag(300 - 480);
		s = await list();
		expect(Math.abs((s.strip?.width ?? 0) - 300)).toBeLessThanOrEqual(2);
		// The left sidebar (right of the strip) keeps its own resize handle; the right sidebar too.
		const side = async (which: 'left' | 'right') =>
			browser.executeObsidian(({ app }, w) => {
				const split = (w === 'left' ? app.workspace.leftSplit : app.workspace.rightSplit) as unknown as { containerEl: HTMLElement };
				const r = split.containerEl.getBoundingClientRect();
				const h = split.containerEl.querySelector(':scope > .workspace-leaf-resize-handle')?.getBoundingClientRect();
				return { width: r.width, left: r.left, handle: h ? { x: h.left + h.width / 2, y: h.top + h.height / 2 } : null };
			}, which);
		await browser.executeObsidian(({ app }) => {
			app.workspace.leftSplit.expand();
			app.workspace.rightSplit.expand();
		});
		await browser.pause(500);
		for (const which of ['left', 'right'] as const) {
			const b = await side(which);
			if (!b.handle) throw new Error(`no ${which} handle`);
			const dx = which === 'left' ? 60 : -60;
			const hit = await browser.execute((x: number, y: number) => document.elementFromPoint(x, y)?.className ?? '', b.handle.x, b.handle.y);
			expect(hit).toContain('workspace-leaf-resize-handle');
			await browser
				.action('pointer', { parameters: { pointerType: 'mouse' } })
				.move({ x: Math.round(b.handle.x), y: Math.round(b.handle.y), origin: 'viewport' })
				.down({ button: 0 })
				.move({ x: Math.round(b.handle.x + dx / 2), y: Math.round(b.handle.y), origin: 'viewport', duration: 100 })
				.move({ x: Math.round(b.handle.x + dx), y: Math.round(b.handle.y), origin: 'viewport', duration: 100 })
				.up({ button: 0 })
				.perform();
			await browser.pause(300);
			const a = await side(which);
			expect(Math.abs(a.width - b.width - Math.abs(dx))).toBeLessThanOrEqual(3);
		}
		s = await list();
		expect(Math.abs((s.strip?.width ?? 0) - 300)).toBeLessThanOrEqual(2);
		// The handle with the keyboard.
		await browser.execute(() => document.querySelector<HTMLElement>('.tabstrip-vstrip-resize')?.focus());
		await browser.keys(Key.ArrowRight);
		const beforeKey = Math.round(s.strip?.width ?? 0);
		s = await waitL((x) => Math.round(x.strip?.width ?? 0) === beforeKey + 16, 'keyboard resize');
		widthAfterL7 = beforeKey + 16;
		await browser.executeObsidian(({ app }) => {
			app.workspace.leftSplit.collapse();
			app.workspace.rightSplit.collapse();
		});
		record('L7', { width: s.strip?.width });
		await expectNoErrors();
	});

	it("L8 restart with the user's window frame: width and icon bar come back; deferred tabs are greyed and never loaded by the strip; the traffic lights stay clear and the header drags the window", async function () {
		expect(await runCommand(CMD.collapse)).toBe(true);
		await waitL((x) => x.collapsed, 'collapsed before restart');
		const frame = userFrame();
		setSandboxFrame(frame);
		await restart();
		let s = await waitL((x) => x.mounted && x.collapsed && items(x).length > 3, 'strip after restart', 10000);
		expect(s.stored).toEqual({ width: widthAfterL7, collapsed: true });
		// Deferred (not loaded) tabs are greyed, read from the public isDeferred; the strip loads none of them.
		expect(s.deferred.length).toBeGreaterThan(0);
		const greyed = items(s).filter((i) => i.classes.includes('is-deferred')).map((i) => i.leafId);
		expect([...greyed].sort()).toEqual(s.deferred.filter((id) => items(s).some((i) => i.leafId === id)).sort());
		const deferredBefore = s.deferred;
		await hover('.tabstrip-vstrip .tabstrip-vrow');
		await waitL((x) => x.peek, 'peek', 3000);
		await pointerAt(700, 400);
		await waitL((x) => !x.peek, 'peek closed', 3000);
		await browser.executeObsidian(({ app }) => {
			app.workspace.trigger('layout-change');
		});
		await browser.pause(300);
		s = await list();
		expect(s.deferred).toEqual(deferredBefore);
		expect(item(s, `t:${deferredBefore[0] ?? ''}`).label).toContain('not loaded');
		// Showing a deferred tab loads it (Obsidian), and its row turns normal.
		const first = deferredBefore[0] ?? '';
		await hover(row(first));
		await waitL((x) => x.peek && (x.panel?.width ?? 0) >= 300, 'peek for the click', 3000);
		await browser.pause(150);
		await pointerClick(row(first));
		s = await waitL((x) => !x.deferred.includes(first) && !item(x, `t:${first}`).classes.includes('is-deferred'), 'loaded tab not greyed');
		await pointerAt(700, 400);
		await waitL((x) => !x.peek, 'peek closed', 3000);
		const shotDeferred = await shot('v2-deferred-icon-bar', 'V2');
		// Window frame: with the hidden frame on macOS the traffic lights' box is never under anything clickable.
		const bodyClasses = await browser.execute(() => Array.from(document.body.classList));
		let lightsReport: unknown = null;
		if (bodyClasses.includes('is-hidden-frameless') && bodyClasses.includes('mod-macos')) {
			const lights = await windowButtons();
			for (const left of [false, true]) {
				await browser.executeObsidian(({ app }, open) => {
					if (open) app.workspace.leftSplit.expand();
					else app.workspace.leftSplit.collapse();
				}, left);
				await browser.pause(500);
				const collapsed = await underLights(lights);
				expect(collapsed.blocked).toEqual([]);
				// The bar's header is a drag region under the lights.
				expect(collapsed.drag).toBeGreaterThan(0);
				expect(await runCommand(CMD.collapse)).toBe(true);
				await waitL((x) => !x.collapsed, 'expanded');
				await pointerAt(700, 400);
				const expanded = await underLights(lights);
				expect(expanded.blocked).toEqual([]);
				expect(await runCommand(CMD.collapse)).toBe(true);
				await waitL((x) => x.collapsed, 'collapsed');
				lightsReport = { ...(lightsReport as object), [left ? 'leftOpen' : 'leftClosed']: { collapsed, expanded } };
			}
			await browser.executeObsidian(({ app }) => {
				app.workspace.leftSplit.collapse();
			});
			const header = await browser.execute(() => {
				const h = document.querySelector('.tabstrip-vstrip-header');
				if (!h) throw new Error('no header');
				const cs = getComputedStyle(h);
				const buttons = Array.from(h.querySelectorAll('.clickable-icon')).map((b) => {
					const r = b.getBoundingClientRect();
					const bs = getComputedStyle(b);
					return { region: bs.getPropertyValue('-webkit-app-region') || bs.getPropertyValue('app-region'), rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };
				});
				return { region: cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'), buttons };
			});
			expect(header.region).toBe('drag');
			for (const b of header.buttons) {
				expect(b.region).toBe('no-drag');
				expect(intersects(b.rect, lights)).toBe(false);
			}
		}
		record('L8', { frame, bodyClasses: bodyClasses.filter((c) => c.startsWith('is-') || c.startsWith('mod-')), deferredBefore, lightsReport, shotDeferred });
		await expectNoErrors();
	});

	it('L9 performance: 150 tabs in 15 groups, most of them not loaded: every strip update at most 5 ms plugin time; the strip loads no deferred tab', async function () {
		this.timeout(240000);
		expect(await runCommand(CMD.collapse)).toBe(true);
		await waitL((x) => !x.collapsed, 'expanded');
		await onePane();
		const made = await browser.executeObsidian(async ({ app, obsidian }) => {
			const files = app.vault.getMarkdownFiles();
			const leaves: string[] = [];
			const first = app.workspace.getMostRecentLeaf(app.workspace.rootSplit);
			const others: import('obsidian').WorkspaceLeaf[] = [];
			app.workspace.iterateRootLeaves((l) => {
				if (l !== first) others.push(l);
			});
			for (const l of others) l.detach();
			if (!first) throw new Error('no leaf');
			leaves.push((first as unknown as { id: string }).id);
			for (let i = 1; i < 150; i++) {
				const leaf = app.workspace.getLeaf('tab');
				const file = files[i % files.length];
				if (!(file instanceof obsidian.TFile)) throw new Error('no file');
				await leaf.openFile(file, { active: false });
				leaves.push((leaf as unknown as { id: string }).id);
			}
			return leaves.length;
		});
		expect(made).toBe(150);
		// Reload the layout: background tabs come back deferred, like after a restart.
		await browser.executeObsidian(async ({ app }) => {
			const layout = app.workspace.getLayout();
			await (app.workspace as unknown as { changeLayout(l: unknown): Promise<void> }).changeLayout(layout);
		});
		let s = await waitL((x) => x.rootIds.length === 150 && items(x).filter((i) => i.kind === 'tab').length === 150, '150 rows', 20000);
		const ids150 = s.rootIds;
		for (let g = 0; g < 15; g++) await makeGroup(ids150.slice(10 * g + 1, 10 * g + 9), `G${String(g)}`, (['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const)[g % 9]);
		s = await waitL((x) => items(x).filter((i) => i.kind === 'group').length === 15, '15 group rows', 10000);
		const deferredBefore = s.deferred;
		expect(deferredBefore.length).toBeGreaterThan(100);
		const statsBefore = (await pageState()).stats.stripMs.length;
		const renderBefore = (await plugin<{ renderMs: number[] }>('vstrip')).renderMs.length;
		// Updates: switching tabs by click, collapsing and expanding groups, a rename, the icon bar.
		const gIds = (await groupsState()).map((g) => g.id);
		for (let k = 0; k < 4; k++) {
			await pointerClick(groupRow(gIds[k] ?? ''));
			await browser.pause(150);
			await pointerClick(groupRow(gIds[k] ?? ''));
			await browser.pause(150);
		}
		await plugin('rename', gIds[0], 'Renamed');
		await runCommand(CMD.collapse);
		await browser.pause(300);
		await runCommand(CMD.collapse);
		await browser.pause(300);
		// Review round 1: showing tabs from the strip, by real clicks and Enter, on rows of tabs that are
		// not loaded yet (Obsidian loads the view; the strip update that follows used to force a layout)
		// and on loaded ones.
		const shown: string[] = [];
		const intoView = async (leafId: string) => {
			await browser.execute((sel: string) => {
				document.querySelector(sel)?.scrollIntoView({ block: 'center' });
			}, row(leafId));
			await browser.pause(80);
		};
		const notLoaded = s.deferred.filter((id) => id !== s.activeId);
		const loadedIds = s.rootIds.filter((id) => !s.deferred.includes(id));
		const steps: { leafId: string; how: 'click' | 'enter'; deferred: boolean }[] = [];
		for (let k = 0; k < 4; k++) steps.push({ leafId: notLoaded[5 + 11 * k] ?? '', how: 'click', deferred: true });
		for (let k = 0; k < 3; k++) steps.push({ leafId: notLoaded[60 + 13 * k] ?? '', how: 'enter', deferred: true });
		for (const id of loadedIds.slice(0, 2)) steps.push({ leafId: id, how: 'click', deferred: false });
		const perStep: { how: string; deferred: boolean; ms: number[] }[] = [];
		for (const step of steps) {
			expect(step.leafId).not.toBe('');
			await intoView(step.leafId);
			const at = (await pageState()).stats.stripMs.length;
			if (step.how === 'click') {
				await pointerClick(row(step.leafId));
			} else {
				await focusItem(`t:${step.leafId}`);
				await browser.keys(Key.Enter);
			}
			await waitL((x) => x.activeId === step.leafId && !x.deferred.includes(step.leafId), `shown ${step.leafId}`, 6000);
			await browser.pause(300);
			shown.push(step.leafId);
			perStep.push({ how: step.how, deferred: step.deferred, ms: (await pageState()).stats.stripMs.slice(at).map((x) => Math.round(x * 10) / 10) });
		}
		record('L9-activation', perStep);
		const stats = (await pageState()).stats.stripMs.slice(statsBefore);
		s = await list();
		const sorted = [...stats].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
		const max = sorted.at(-1) ?? 0;
		const renders = (await plugin<{ renderMs: number[] }>('vstrip')).renderMs.slice(renderBefore);
		record('L9', { all: stats.map((x) => Math.round(x * 10) / 10), renders: renders.map((x) => Math.round(x * 10) / 10), updates: stats.length, median, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max, deferred: deferredBefore.length });
		expect(stats.length).toBeGreaterThan(8);
		expect(max).toBeLessThanOrEqual(5);
		// Every update while showing tabs stays within budget too (they are part of `stats` above).
		expect(perStep.filter((p) => p.deferred).length).toBe(7);
		for (const p of perStep) expect(p.ms.length).toBeGreaterThan(0);
		// Only the tabs this test showed were loaded: the strip itself loads none.
		expect(s.deferred.filter((id) => !deferredBefore.includes(id))).toEqual([]);
		const loaded = deferredBefore.filter((id) => !s.deferred.includes(id));
		expect(loaded.filter((id) => !shown.includes(id))).toEqual([]);
		// Back to a small set of tabs for the screenshots.
		ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
		await expectNoErrors();
	});

	it('L10 screenshots: expanded, icon bar, hover overlay, collapsed group and menus in default and Atom, light and dark; forced colours', async function () {
		this.timeout(240000);
		ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
		const gA = await makeGroup([ids['n2'] ?? '', ids['n3'] ?? ''], 'Research', 'blue');
		const gB = await makeGroup([ids['n5'] ?? '', ids['n6'] ?? ''], '读书', 'orange');
		await setPinned(ids['n1'] ?? '', true);
		await setActive(ids['n4'] ?? '');
		const files: string[] = [];
		for (const theme of ['default', 'Atom'] as const) {
			for (const dark of [false, true]) {
				await setLook(theme, dark);
				const tag = `${theme === 'default' ? 'default' : 'atom'}-${dark ? 'dark' : 'light'}`;
				await pointerAt(700, 400);
				let s = await list();
				if (s.collapsed) {
					await runCommand(CMD.collapse);
					s = await waitL((x) => !x.collapsed, 'expanded');
				}
				const gStates = await groupsState();
				if (gStates.find((g) => g.id === gB)?.collapsed !== true) await plugin('setCollapsed', gB, true);
				await waitL((x) => item(x, `g:${gB}`).expanded === 'false', 'collapsed group');
				files.push(await shot(`v2-expanded-${tag}`, 'V2'));
				// Review round 1: a hovered row is told apart from the highlighted one in every look (semibold
				// title and a ring on the highlighted row, a lighter hover); the highlighted row's icon takes
				// its text colour (readable on Atom's accent background).
				await hover(row(ids['n3'] ?? ''));
				await browser.pause(200);
				files.push(await shot(`v2-hover-active-${tag}`, 'V2'));
				const look = await browser.execute(
					(a: string, h: string) => {
						const read = (sel: string) => {
							const el = document.querySelector(sel);
							if (!el) throw new Error(`no ${sel}`);
							const cs = getComputedStyle(el);
							const title = el.querySelector('.tabstrip-vrow-title');
							const icon = el.querySelector('.tabstrip-vrow-icon');
							const close = el.querySelector('.tabstrip-vrow-close');
							const ccs = close ? getComputedStyle(close) : null;
							return {
								bg: cs.backgroundColor,
								shadow: cs.boxShadow,
								color: cs.color,
								weight: title ? Number(getComputedStyle(title).fontWeight) : 0,
								icon: icon ? getComputedStyle(icon).color : '',
								close: ccs ? { color: ccs.color, opacity: Number(ccs.opacity), display: ccs.display } : null,
							};
						};
						return { active: read(a), hovered: read(h) };
					},
					row(ids['n4'] ?? ''),
					row(ids['n3'] ?? ''),
				);
				record(`L10-look-${tag}`, look);
				expect(look.active.weight).toBeGreaterThanOrEqual(600);
				expect(look.hovered.weight).toBeLessThan(600);
				expect(look.active.shadow).not.toBe('none');
				expect(look.hovered.bg).not.toBe(look.active.bg);
				expect(look.active.icon).toBe(look.active.color);
				// Review round 3: the highlighted row's close button (always shown there) takes the row's text
				// colour at full opacity, resting and under the real pointer (it nearly vanished on Atom's blue).
				expect(look.active.close?.display).toBe('flex');
				expect(look.active.close?.color).toBe(look.active.color);
				expect(look.active.close?.opacity).toBe(1);
				await hover(`${row(ids['n4'] ?? '')} .tabstrip-vrow-close`);
				await browser.pause(200);
				const closeHover = await browser.execute((a: string) => {
					const el = document.querySelector(a);
					const close = el?.querySelector('.tabstrip-vrow-close');
					if (!el || !close) throw new Error(`no close button in ${a}`);
					const cs = getComputedStyle(close);
					return { row: getComputedStyle(el).color, color: cs.color, opacity: Number(cs.opacity), hovered: close.matches(':hover') };
				}, row(ids['n4'] ?? ''));
				record(`L10-close-hover-${tag}`, closeHover);
				expect(closeHover.hovered).toBe(true);
				expect(closeHover.color).toBe(closeHover.row);
				expect(closeHover.opacity).toBe(1);
				await pointerAt(700, 400);
				// V1 final review: with the file list open, the strip's edge shows a line in every theme.
				await browser.executeObsidian(({ app }) => {
					app.workspace.leftSplit.expand();
				});
				await browser.pause(500);
				const edge = await browser.execute(() => {
					const panel = document.querySelector('.tabstrip-vstrip-panel');
					return panel ? getComputedStyle(panel).borderRightColor : '';
				});
				record(`L10-edge-${tag}`, edge);
				expect(edge).not.toBe('');
				expect(edge).not.toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/);
				files.push(await shot(`v2-file-list-${tag}`, 'V2'));
				await browser.executeObsidian(({ app }) => {
					app.workspace.leftSplit.collapse();
				});
				await browser.pause(300);
				// Review round 2: the pinned area's and the pane sections' separators show a line in every
				// theme (Atom's divider colour is transparent). A second pane is opened just for this read.
				const second = await browser.executeObsidian(async ({ app, obsidian }, path) => {
					const leaf = app.workspace.getLeaf('split', 'vertical');
					const file = app.vault.getFileByPath(path);
					if (!(file instanceof obsidian.TFile)) throw new Error('no note');
					await leaf.openFile(file);
					return (leaf as unknown as { id: string }).id;
				}, 'Inbox.md');
				await waitL((x) => x.sections.filter((y) => y.kind === 'pane').length === 2, 'two panes for the separators');
				const separators = await browser.execute(() => {
					const pinned = document.querySelector('.tabstrip-vsection.mod-pinned');
					const pane = document.querySelector('.tabstrip-vsection.mod-pane + .tabstrip-vsection.mod-pane');
					return {
						pinned: pinned ? `${getComputedStyle(pinned).borderBottomStyle} ${getComputedStyle(pinned).borderBottomColor}` : '',
						pane: pane ? `${getComputedStyle(pane).borderTopStyle} ${getComputedStyle(pane).borderTopColor}` : '',
					};
				});
				record(`L10-separators-${tag}`, separators);
				for (const line of [separators.pinned, separators.pane]) {
					expect(line).toMatch(/^solid /);
					expect(line).not.toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent/);
				}
				await browser.executeObsidian(({ app }, id) => {
					app.workspace.getLeafById(id)?.detach();
				}, second);
				await waitL((x) => x.sections.filter((y) => y.kind === 'pane').length === 1, 'one pane after the separators');
				await setActive(ids['n4'] ?? '');
				await pointerClick(row(ids['n4'] ?? ''), 2);
				await waitForMenu();
				files.push(await shot(`v2-tab-menu-${tag}`, 'V2'));
				await closeMenus();
				await pointerClick(groupRow(gA), 2);
				await waitForMenu();
				files.push(await shot(`v2-group-menu-${tag}`, 'V2'));
				await closeMenus();
				await runCommand(CMD.collapse);
				await waitL((x) => x.collapsed, 'icon bar');
				await pointerAt(700, 400);
				await browser.pause(PEEK_WAIT);
				files.push(await shot(`v2-icon-bar-${tag}`, 'V2'));
				await hover(row(ids['n4'] ?? ''));
				await waitL((x) => x.peek, 'peek', 3000);
				await browser.pause(300);
				files.push(await shot(`v2-hover-overlay-${tag}`, 'V2'));
				await pointerAt(700, 400);
				await waitL((x) => !x.peek, 'peek closed', 3000);
				await runCommand(CMD.collapse);
				await waitL((x) => !x.collapsed, 'expanded');
				await plugin('setCollapsed', gB, false);
				// Group chip text keeps its contrast: the ink was chosen for this theme.
				const ink = await browser.execute((g: string) => document.querySelector(`.tabstrip-vgroup[data-tabstrip-group="${g}"] .tabstrip-vgroup-chip`)?.getAttribute('data-tabstrip-ink') ?? null, gA);
				expect(ink).not.toBeNull();
			}
		}
		await setLook('default', false);
		// Forced colours (Chromium emulation, sandbox only): groups are outlined, focus and selection use system colours.
		await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
		await browser.pause(300);
		const forced = await browser.execute((g: string) => {
			const chip = document.querySelector(`.tabstrip-vgroup[data-tabstrip-group="${g}"] .tabstrip-vgroup-chip`);
			return { media: matchMedia('(forced-colors: active)').matches, outline: chip ? getComputedStyle(chip).outlineStyle : '' };
		}, gA);
		files.push(await shot('v2-forced-colors', 'V2'));
		await runCommand(CMD.collapse);
		await waitL((x) => x.collapsed, 'icon bar');
		await pointerAt(700, 400);
		await browser.pause(PEEK_WAIT);
		files.push(await shot('v2-forced-colors-icon-bar', 'V2'));
		await runCommand(CMD.collapse);
		await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [] });
		expect(forced.media).toBe(true);
		expect(forced.outline).toBe('solid');
		await setPinned(ids['n1'] ?? '', false);
		record('L10', { files });
		await expectNoErrors();
	});

	it('L11 "Restore native tab bar" removes the strip in every state (icon bar too) and leaves nothing; showing again brings back the same look', async function () {
		expect(await runCommand(CMD.collapse)).toBe(true);
		await waitL((x) => x.collapsed, 'icon bar');
		expect(await runCommand(CMD.restoreNative)).toBe(true);
		const s = await waitL((x) => !x.mounted && x.nativeShown > 0, 'native');
		expect(await commandAvailable(CMD.collapse)).toBe(false);
		const left = await residue();
		expect(left.found).toEqual([]);
		expect(s.spines.shown).toBe(s.spines.total);
		expect(await runCommand(CMD.show)).toBe(true);
		await waitL((x) => x.mounted && x.collapsed, 'back, still the icon bar');
		expect(await runCommand(CMD.collapse)).toBe(true);
		await waitL((x) => !x.collapsed, 'expanded');
		await expectNoErrors();
	});
});
