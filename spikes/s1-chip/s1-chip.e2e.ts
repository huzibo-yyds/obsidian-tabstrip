/**
 * Spike S1 (step L2): can a group chip that lives inside the first member tab's header survive
 * Obsidian's own tab header refreshes, and can its mouse events be kept away from that tab?
 *
 * Run only through `npm run spike:s1` (sandbox Obsidian, host checks around the run).
 * Every MUST case saves a screenshot of the sandbox window. For Obsidian 1.15.0 they go to
 * docs/verification/L2/<case>.png; other versions write to .e2e-state/l2-screens/<version>/.
 * Measured facts per case go to docs/verification/L2/evidence-<version>.json.
 *
 * The sandbox vault is a temporary copy of test/vaults/basic (fixture notes only).
 */
import { $, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import { obsidianPage, type ExecuteObsidianArg } from 'wdio-obsidian-service';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChipColor, SpikeStats } from './plugin/main';

const PLUGIN_ID = 'tabstrip-spike-s1';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
/** Screenshots of this version go into the report folder. */
const REPORT_VERSION = '1.15.0';
const GROUP_NAME = '研究 Research';
const GROUP_COLOR: ChipColor = 'blue';
const NOTES = {
	m1: '欢迎.md',
	m2: '会议记录（2026-11-08）.md',
	m3: '项目/计划.md',
	n1: 'Getting Started.md',
	n2: 'Inbox.md',
} as const;
type Role = keyof typeof NOTES;
const RENAMED = '欢迎（已改名）.md';
const UNDO_CLOSE = 'workspace:undo-close-pane';

// ---- types of what the in-page code returns ----

interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

interface HeaderInfo {
	id: string;
	file: string | null;
	title: string;
	pinned: boolean;
	pinIcon: boolean;
	member: boolean;
	groupAttr: string | null;
	colorClass: boolean;
	hasChipClass: boolean;
	slot: string;
	marker: string | null;
}

interface StripInfo {
	currentId: string | null;
	leafIds: string[];
	/** Leaf ids in the order their headers appear in the DOM. */
	headerOrder: string[];
	headers: HeaderInfo[];
}

interface ChipInfo {
	serial: string;
	text: string;
	hostLeafId: string | null;
	rect: Rect;
	hostRect: Rect | null;
	hostPosition: string;
	/** Visible part of the strip's tabHeaderContainerEl (clipped by every scrolling/clipping ancestor and the window). */
	containerVisible: Rect | null;
	/** Visible part of the clipping `.workspace-tab-header-container-inner` (its padding box). */
	innerVisible: Rect | null;
	/** x where the strip's content starts (container left + its inline-start padding, e.g. room for traffic lights). */
	contentStartX: number | null;
	insideContainerVisible: boolean;
	insideInnerVisible: boolean;
	insideViewport: boolean;
	clearOfFramePadding: boolean;
	/** elementFromPoint at the chip's center and 2px inside its left / right edge hits the chip. */
	hits: { center: boolean; left: boolean; right: boolean };
	hitElements: { center: string; left: string; right: string };
	appRegion: string;
	hostAppRegion: string;
	innerAppRegion: string;
	containerAppRegion: string;
}

interface Snapshot {
	strips: StripInfo[];
	/** Chips connected to the document. */
	chips: ChipInfo[];
	chipCountInDocument: number;
	activeLeafId: string | null;
	stats: SpikeStats;
	env: {
		frameless: boolean;
		titlebarStyle: string | null;
		theme: string;
		cssTheme: string;
		dark: boolean;
		showRibbon: boolean;
		leftCollapsed: boolean;
		viewport: { w: number; h: number; dpr: number };
	};
}

/** Runs in the sandbox page; must be self-contained (it is serialized). Reads private fields; test code only. */
function snapshotInPage({ app }: ExecuteObsidianArg): Snapshot {
	type Leaf = {
		id: string;
		tabHeaderEl: HTMLElement;
		parent: unknown;
		getViewState(): { state?: Record<string, unknown>; pinned?: boolean };
	};
	type Tabs = { children: Leaf[]; currentTab: number; tabHeaderContainerEl: HTMLElement };
	const priv = app as unknown as {
		plugins: { plugins: Record<string, { readStats(): SpikeStats } | undefined> };
		vault: { getConfig(key: string): unknown };
		workspace: { activeLeaf: Leaf | null; leftSplit: { collapsed: boolean } };
	};
	const doc = activeDocument;
	const win = activeWindow as Window & { titlebarStyle?: string };
	const rectOf = (el: Element): Rect => {
		const r = el.getBoundingClientRect();
		return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
	};
	const make = (left: number, top: number, right: number, bottom: number): Rect => ({
		left,
		top,
		right,
		bottom,
		width: Math.max(0, right - left),
		height: Math.max(0, bottom - top),
	});
	const intersect = (a: Rect, b: Rect): Rect =>
		make(Math.max(a.left, b.left), Math.max(a.top, b.top), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
	const inside = (inner: Rect, outer: Rect | null, tol = 0.5): boolean =>
		outer !== null &&
		inner.width > 0 &&
		inner.left >= outer.left - tol &&
		inner.top >= outer.top - tol &&
		inner.right <= outer.right + tol &&
		inner.bottom <= outer.bottom + tol;
	const paddingBox = (el: HTMLElement): Rect => {
		const r = el.getBoundingClientRect();
		const left = r.left + el.clientLeft;
		const top = r.top + el.clientTop;
		return make(left, top, left + el.clientWidth, top + el.clientHeight);
	};
	const viewport = make(0, 0, win.innerWidth, win.innerHeight);
	/** The element's box, cut by every ancestor that clips (overflow not visible) and by the window. */
	const visibleRect = (el: HTMLElement): Rect => {
		let r = rectOf(el);
		for (let p = el.parentElement; p && p !== doc.documentElement; p = p.parentElement) {
			const cs = getComputedStyle(p);
			if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') r = intersect(r, paddingBox(p));
		}
		return intersect(r, viewport);
	};
	const describe = (el: Element | null): string => {
		if (!el) return 'nothing';
		const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
		return `${el.tagName.toLowerCase()}${cls}`;
	};
	const appRegion = (el: Element | null): string => {
		if (!el) return 'n/a';
		const cs = getComputedStyle(el);
		return cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') || '(empty)';
	};

	const strips = new Set<Tabs>();
	app.workspace.iterateRootLeaves((leaf) => {
		const p = (leaf as unknown as Leaf).parent as Partial<Tabs> | null;
		if (p && Array.isArray(p.children) && p.tabHeaderContainerEl) strips.add(p as Tabs);
	});
	const headerToId = new Map<Element, string>();
	const stripInfos: StripInfo[] = [...strips].map((tabs) => {
		const headers = tabs.children.map((leaf): HeaderInfo => {
			const h = leaf.tabHeaderEl;
			headerToId.set(h, leaf.id);
			const vs = leaf.getViewState();
			const file = vs.state?.['file'];
			return {
				id: leaf.id,
				file: typeof file === 'string' ? file : null,
				title: h.querySelector('.workspace-tab-header-inner-title')?.textContent ?? '',
				pinned: vs.pinned === true,
				pinIcon: h.querySelector('.workspace-tab-header-status-icon.mod-pinned') !== null,
				member: h.classList.contains('tabstrip-member'),
				groupAttr: h.getAttribute('data-tabstrip-group'),
				colorClass: Array.from(h.classList).some((c) => c.startsWith('tabstrip-color-')),
				hasChipClass: h.classList.contains('tabstrip-has-chip'),
				slot: h.style.getPropertyValue('--tabstrip-chip-slot'),
				marker: h.getAttribute('data-s1-old-header'),
			};
		});
		const inner = tabs.children[0]?.tabHeaderEl.parentElement ?? null;
		const headerOrder = inner
			? Array.from(inner.children)
					.map((el) => headerToId.get(el))
					.filter((id): id is string => id !== undefined)
			: [];
		return { currentId: tabs.children[tabs.currentTab]?.id ?? null, leafIds: tabs.children.map((l) => l.id), headerOrder, headers };
	});

	const chips: ChipInfo[] = [];
	for (const tabs of strips) {
		const container = tabs.tabHeaderContainerEl;
		for (const chip of Array.from(container.querySelectorAll<HTMLElement>('.tabstrip-chip'))) {
			const host = chip.parentElement;
			const inner = host?.parentElement ?? null;
			const rect = rectOf(chip);
			const containerVisible = visibleRect(container);
			const innerVisible = inner ? intersect(paddingBox(inner), visibleRect(inner)) : null;
			const cRect = container.getBoundingClientRect();
			const contentStartX = cRect.left + container.clientLeft + parseFloat(getComputedStyle(container).paddingInlineStart || '0');
			const cy = (rect.top + rect.bottom) / 2;
			const hitAt = (x: number) => doc.elementFromPoint(x, cy);
			const center = hitAt((rect.left + rect.right) / 2);
			const left = hitAt(rect.left + 2);
			const right = hitAt(rect.right - 2);
			chips.push({
				serial: chip.getAttribute('data-serial') ?? '?',
				text: chip.textContent ?? '',
				hostLeafId: host ? (headerToId.get(host) ?? null) : null,
				rect,
				hostRect: host ? rectOf(host) : null,
				hostPosition: host ? getComputedStyle(host).position : 'n/a',
				containerVisible,
				innerVisible,
				contentStartX,
				insideContainerVisible: inside(rect, containerVisible),
				insideInnerVisible: inside(rect, innerVisible),
				insideViewport: inside(rect, viewport),
				clearOfFramePadding: rect.left >= contentStartX - 0.5,
				hits: {
					center: center !== null && chip.contains(center),
					left: left !== null && chip.contains(left),
					right: right !== null && chip.contains(right),
				},
				hitElements: { center: describe(center), left: describe(left), right: describe(right) },
				appRegion: appRegion(chip),
				hostAppRegion: appRegion(host),
				innerAppRegion: appRegion(inner),
				containerAppRegion: appRegion(container),
			});
		}
	}

	const plugin = priv.plugins.plugins['tabstrip-spike-s1'];
	if (!plugin) throw new Error('spike plugin not loaded');
	return {
		strips: stripInfos,
		chips,
		chipCountInDocument: doc.querySelectorAll('.tabstrip-chip').length,
		activeLeafId: priv.workspace.activeLeaf?.id ?? null,
		stats: plugin.readStats(),
		env: {
			frameless: doc.body.classList.contains('is-hidden-frameless'),
			titlebarStyle: win.titlebarStyle ?? null,
			theme: typeof priv.vault.getConfig('theme') === 'string' ? (priv.vault.getConfig('theme') as string) : 'unset',
			cssTheme: typeof priv.vault.getConfig('cssTheme') === 'string' ? (priv.vault.getConfig('cssTheme') as string) : '',
			dark: doc.body.classList.contains('theme-dark'),
			showRibbon: priv.vault.getConfig('showRibbon') !== false,
			leftCollapsed: priv.workspace.leftSplit.collapsed,
			viewport: { w: win.innerWidth, h: win.innerHeight, dpr: win.devicePixelRatio },
		},
	};
}

// ---- helpers (node side) ----

const ids = {} as Record<Role, string>;
const evidence: Record<string, unknown> = {};
const screenshots: string[] = [];
const version = () => browser.getObsidianVersion();
const headerSel = (id: string) => `.workspace .mod-root .workspace-tab-header[data-tabstrip-leaf="${id}"]`;
const CHIP_SEL = '.workspace .mod-root .workspace-tab-header > .tabstrip-chip';

const snap = () => browser.executeObsidian(snapshotInPage);

function onlyStrip(s: Snapshot): StripInfo {
	expect(s.strips).toHaveLength(1);
	const strip = s.strips[0];
	if (!strip) throw new Error('no strip');
	return strip;
}

function header(s: Snapshot, id: string): HeaderInfo {
	const h = onlyStrip(s).headers.find((x) => x.id === id);
	if (!h) throw new Error(`no header for leaf ${id}`);
	return h;
}

/** Polls the sandbox until `ok` holds; fails with the last snapshot. */
async function waitForSnap(ok: (s: Snapshot) => boolean, what: string, timeout = 6000): Promise<Snapshot> {
	const start = Date.now();
	let last = await snap();
	while (!ok(last)) {
		if (Date.now() - start > timeout) {
			throw new Error(`timed out waiting for: ${what}\nlast snapshot: ${JSON.stringify({ ...compact(last), env: last.env })}`);
		}
		await browser.pause(100);
		last = await snap();
	}
	// Let a pending debounced layout-change (10 ms) and the decoration pass after it run, then re-read.
	await browser.pause(150);
	return snap();
}

/** Short form for logs and evidence. */
function compact(s: Snapshot) {
	const strip = s.strips[0];
	const roleOf = (id: string | null) => (Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id) as string;
	return {
		order: strip?.leafIds.map(roleOf),
		headerOrder: strip?.headerOrder.map(roleOf),
		current: roleOf(strip?.currentId ?? null),
		active: roleOf(s.activeLeafId),
		members: strip?.headers.filter((h) => h.member).map((h) => roleOf(h.id)),
		chips: s.chips.map((c) => ({ serial: c.serial, host: roleOf(c.hostLeafId), text: c.text })),
		chipCountInDocument: s.chipCountInDocument,
		stats: {
			passes: s.stats.passes,
			layoutChanges: s.stats.layoutChanges,
			chipsCreated: s.stats.chipsCreated,
			memberWrites: s.stats.memberWrites,
			chipEvents: s.stats.chipEvents,
			chipMenus: s.stats.chipMenus,
			restores: s.stats.restores.map((r) => ({ ...r, id: roleOf(r.id) })),
		},
	};
}

function record(name: string, data: unknown) {
	evidence[name] = data;
	console.log(`[s1] ${name}: ${JSON.stringify(data)}`);
}

async function shot(name: string) {
	const dir =
		version() === REPORT_VERSION
			? path.join(repoRoot, 'docs', 'verification', 'L2')
			: path.join(repoRoot, '.e2e-state', 'l2-screens', version());
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.png`);
	await browser.saveScreenshot(file);
	screenshots.push(path.relative(repoRoot, file));
}

/** Exactly one chip in the document, in `hostId`'s header (and, when given, the same chip element as before). */
function expectSingleChip(s: Snapshot, hostId: string, serial?: string) {
	expect(s.chipCountInDocument).toBe(1);
	expect(s.chips.map((c) => c.hostLeafId)).toEqual([hostId]);
	if (serial !== undefined) expect(s.chips[0]?.serial).toBe(serial);
	expect(header(s, hostId).hasChipClass).toBe(true);
}

/** Member classes and attributes are on exactly the member headers. */
function expectMembers(s: Snapshot, memberIds: string[]) {
	for (const h of onlyStrip(s).headers) {
		const isMember = memberIds.includes(h.id);
		expect({ id: h.id, member: h.member, groupAttr: h.groupAttr, colorClass: h.colorClass }).toEqual({
			id: h.id,
			member: isMember,
			groupAttr: isMember ? 'spike-group-1' : null,
			colorClass: isMember,
		});
	}
}

/** Obsidian kept the decoration: the plugin did not have to write member classes or create a chip. */
function expectNoRedecoration(before: Snapshot, after: Snapshot) {
	expect(after.stats.memberWrites).toBe(before.stats.memberWrites);
	expect(after.stats.chipsCreated).toBe(before.stats.chipsCreated);
}

/** a >= b for dotted version strings. */
function atLeast(a: string, b: string): boolean {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return true;
}

const members = () => [ids.m1, ids.m2, ids.m3];
const order = (...roles: Role[]) => roles.map((r) => ids[r]);

async function moveLeaf(id: string, toIndex: number) {
	await browser.executeObsidian(
		({ app }, leafId, index) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { moveLeafById(id: string, i: number): void }> } }).plugins
				.plugins['tabstrip-spike-s1'];
			if (!plugin) throw new Error('spike plugin not loaded');
			plugin.moveLeafById(leafId, index);
		},
		id,
		toIndex,
	);
}

async function menuTitles(): Promise<string[]> {
	return browser.execute(() =>
		Array.from(activeDocument.querySelectorAll('.menu .menu-item-title')).map((e) => (e.textContent ?? '').trim()),
	);
}

async function closeMenus() {
	await browser.keys('Escape');
	await browser.waitUntil(async () => (await browser.execute(() => activeDocument.querySelectorAll('.menu').length)) === 0, {
		timeout: 3000,
		timeoutMsg: 'menu did not close',
	});
}

/** Centre of the active note's content area: a neutral place for the pointer, outside every tab header. */
async function neutralPoint(): Promise<{ x: number; y: number }> {
	return browser.execute(() => {
		const el = activeDocument.querySelector('.workspace .mod-root .workspace-leaf.mod-active .view-content');
		if (!el) throw new Error('no active view content');
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
	});
}

async function movePointerTo(point: { x: number; y: number }) {
	await browser.action('pointer').move({ x: point.x, y: point.y, duration: 0 }).perform();
}

// ---- the spike ----

describe('S1 spike: group chip inside the first member tab header', function () {
	before(async function () {
		// Same window size in every run, for comparable screenshots (sandbox window only).
		let windowSize: string;
		try {
			await browser.setWindowSize(1280, 800);
			windowSize = 'set to 1280x800';
		} catch (e) {
			windowSize = `not set: ${String(e).slice(0, 200)}`;
		}
		const opened = await browser.executeObsidian(async ({ app, obsidian }, notes) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void };
			// Like the user: DOM menus (the native macOS menu cannot be inspected), light base theme, and
			// links updated on rename without asking (otherwise renaming a linked note opens a modal).
			vault.setConfig('nativeMenus', false);
			vault.setConfig('theme', 'moonstone');
			vault.setConfig('alwaysUpdateLinks', true);
			const roots: import('obsidian').WorkspaceLeaf[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				roots.push(leaf);
			});
			const first = roots[0] ?? app.workspace.getLeaf(true);
			for (const leaf of roots.slice(1)) leaf.detach();
			const out: string[] = [];
			for (const [i, p] of notes.entries()) {
				const file = app.vault.getFileByPath(p);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing fixture note ${p}`);
				const leaf = i === 0 ? first : app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				out.push((leaf as unknown as { id: string }).id);
			}
			await activeDocument.fonts.ready;
			return out;
		}, Object.values(NOTES));
		(Object.keys(NOTES) as Role[]).forEach((role, i) => {
			const id = opened[i];
			if (!id) throw new Error(`no leaf for ${role}`);
			ids[role] = id;
		});

		let s = await snap();
		// Put the tabs in the planned order with the native move recipe if Obsidian placed them otherwise.
		const planned = order('m1', 'm2', 'm3', 'n1', 'n2');
		if (JSON.stringify(onlyStrip(s).leafIds) !== JSON.stringify(planned)) {
			for (const [i, id] of planned.entries()) await moveLeaf(id, i);
		}
		await browser.executeObsidian(
			({ app }, memberIds, name, color) => {
				const plugin = (
					app as unknown as { plugins: { plugins: Record<string, { setGroup(ids: string[], n: string, c: ChipColor): void }> } }
				).plugins.plugins['tabstrip-spike-s1'];
				if (!plugin) throw new Error('spike plugin not loaded');
				plugin.setGroup(memberIds, name, color);
			},
			members(),
			GROUP_NAME,
			GROUP_COLOR,
		);
		s = await waitForSnap((x) => x.chips.length === 1 && x.chips[0]?.hostLeafId === ids.m1, 'first decoration');
		expect(onlyStrip(s).leafIds).toEqual(planned);
		expectSingleChip(s, ids.m1);
		expectMembers(s, members());
		record('setup', {
			obsidian: version(),
			installer: browser.getObsidianInstallerVersion(),
			notes: NOTES,
			ids,
			windowSize,
			env: s.env,
			chip: s.chips[0],
			state: compact(s),
		});
	});

	after(function () {
		const file = path.join(repoRoot, 'docs', 'verification', 'L2', `evidence-${version()}.json`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ version: version(), screenshots, evidence }, null, '\t') + '\n');
	});

	// ---------------- A1: decoration survives native refreshes ----------------

	it('A1-1 switching tabs with real clicks keeps chip and member classes', async function () {
		const before = await snap();
		const serial = before.chips[0]?.serial;
		await $(headerSel(ids.n1)).click();
		const s1 = await waitForSnap((s) => s.activeLeafId === ids.n1 && onlyStrip(s).currentId === ids.n1, 'N1 active');
		expectSingleChip(s1, ids.m1, serial);
		expectMembers(s1, members());
		expectNoRedecoration(before, s1);

		await $(headerSel(ids.m2)).click();
		const s2 = await waitForSnap((s) => s.activeLeafId === ids.m2 && onlyStrip(s).currentId === ids.m2, 'M2 active');
		expectSingleChip(s2, ids.m1, serial);
		expectMembers(s2, members());
		expectNoRedecoration(before, s2);
		record('A1-1-switch', { before: compact(before), afterN1: compact(s1), afterM2: compact(s2) });
		await shot('a1-1-switch');
	});

	it('A1-2 reordering with the native move recipe keeps chip and member classes', async function () {
		const before = await snap();
		const serial = before.chips[0]?.serial;

		// A non-member moves in front of the group: every header is re-inserted, the chip must stay put.
		await moveLeaf(ids.n2, 0);
		const s1 = await waitForSnap((s) => JSON.stringify(onlyStrip(s).leafIds) === JSON.stringify(order('n2', 'm1', 'm2', 'm3', 'n1')), 'N2 first');
		expect(onlyStrip(s1).headerOrder).toEqual(onlyStrip(s1).leafIds);
		expectSingleChip(s1, ids.m1, serial);
		expectMembers(s1, members());
		expectNoRedecoration(before, s1);
		await shot('a1-2-reorder');

		// The first member moves to the end of the group: the chip follows the new first member.
		await moveLeaf(ids.m1, 3);
		const s2 = await waitForSnap((s) => s.chips[0]?.hostLeafId === ids.m2 && onlyStrip(s).leafIds[3] === ids.m1, 'chip on M2');
		expect(onlyStrip(s2).leafIds).toEqual(order('n2', 'm2', 'm3', 'm1', 'n1'));
		expect(onlyStrip(s2).headerOrder).toEqual(onlyStrip(s2).leafIds);
		expectSingleChip(s2, ids.m2);
		expectMembers(s2, members());
		expect(s2.stats.memberWrites).toBe(before.stats.memberWrites);

		// Back to the planned order.
		await moveLeaf(ids.m1, 1);
		await moveLeaf(ids.n2, 4);
		const s3 = await waitForSnap(
			(s) => JSON.stringify(onlyStrip(s).leafIds) === JSON.stringify(order('m1', 'm2', 'm3', 'n1', 'n2')) && s.chips[0]?.hostLeafId === ids.m1,
			'planned order again',
		);
		expect(onlyStrip(s3).headerOrder).toEqual(onlyStrip(s3).leafIds);
		expectSingleChip(s3, ids.m1);
		expectMembers(s3, members());
		expect(s3.stats.memberWrites).toBe(before.stats.memberWrites);
		record('A1-2-reorder', { before: compact(before), nonMemberToFront: compact(s1), firstMemberToGroupEnd: compact(s2), restored: compact(s3) });
	});

	it('A1-2b drag and drop: probe real input safely, then drive the native drop handler with synthetic drag events', async function () {
		// Part 1, real input. ChromeDriver for Electron 28 has no drag interception, so a real HTML5
		// drag would turn into a macOS drag session that follows the real cursor and could drop onto
		// another app (the user's Obsidian). Only probe whether WebDriver pointer input starts a drag,
		// on a test-only element, and cancel any dragstart at once in the capture phase on window,
		// before anything else sees it. A cancelled dragstart never starts a system drag.
		await browser.execute(() => {
			const probe = activeDocument.body.createDiv({ cls: 's1-drag-probe', text: 'drag probe', attr: { draggable: 'true' } });
			probe.setCssProps({ position: 'fixed', right: '40px', bottom: '40px', width: '120px', height: '32px', 'z-index': '9999', background: 'var(--background-modifier-hover)' });
			const w = activeWindow as Window & { s1DragProbe?: { dragstarts: number; listener: (e: DragEvent) => void } };
			const listener = (e: DragEvent) => {
				e.preventDefault();
				e.stopImmediatePropagation();
				if (w.s1DragProbe) w.s1DragProbe.dragstarts++;
			};
			w.s1DragProbe = { dragstarts: 0, listener };
			activeWindow.addEventListener('dragstart', listener, { capture: true });
		});
		const probe = await $('.s1-drag-probe').getElement();
		await browser
			.action('pointer')
			.move({ origin: probe, duration: 0 })
			.down({ button: 0 })
			.move({ origin: probe, x: 20, y: 0, duration: 100 })
			.move({ origin: probe, x: 60, y: 0, duration: 100 })
			.up({ button: 0 })
			.perform();
		const probeResult = await browser.execute(() => {
			const w = activeWindow as Window & { s1DragProbe?: { dragstarts: number; listener: (e: DragEvent) => void } };
			const result = { dragstarts: w.s1DragProbe?.dragstarts ?? -1 };
			if (w.s1DragProbe) activeWindow.removeEventListener('dragstart', w.s1DragProbe.listener, { capture: true });
			delete w.s1DragProbe;
			activeDocument.querySelector('.s1-drag-probe')?.remove();
			return result;
		});

		// Part 2, synthetic DragEvents (not real input) through Obsidian's own tab drag and drop code:
		// drag N1's header onto the left part of M1's header.
		const before = await snap();
		const serial = before.chips[0]?.serial;
		const dnd = await browser.execute(
			(srcSel, dstSel) => {
				const src = activeDocument.querySelector<HTMLElement>(srcSel);
				const dst = activeDocument.querySelector<HTMLElement>(dstSel);
				if (!src || !dst) throw new Error('headers not found');
				const dt = new DataTransfer();
				const s = src.getBoundingClientRect();
				const d = dst.getBoundingClientRect();
				const at = (x: number, y: number) => ({ bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y });
				const sx = s.left + s.width / 2;
				const sy = s.top + s.height / 2;
				const dx = d.left + Math.min(8, d.width / 5);
				const dy = d.top + d.height / 2;
				const started = src.dispatchEvent(new DragEvent('dragstart', at(sx, sy)));
				dst.dispatchEvent(new DragEvent('dragenter', at(dx + 20, dy)));
				dst.dispatchEvent(new DragEvent('dragover', at(dx + 20, dy)));
				dst.dispatchEvent(new DragEvent('dragover', at(dx, dy)));
				dst.dispatchEvent(new DragEvent('drop', at(dx, dy)));
				src.dispatchEvent(new DragEvent('dragend', at(dx, dy)));
				return { started, grabbing: activeDocument.body.classList.contains('is-grabbing') };
			},
			headerSel(ids.n1),
			headerSel(ids.m1),
		);
		await browser.pause(400);
		const after = await snap();
		const moved = JSON.stringify(onlyStrip(after).leafIds) !== JSON.stringify(onlyStrip(before).leafIds);
		// Whatever the drop did, the decoration must follow the order: one chip on the first member.
		const firstMember = onlyStrip(after).leafIds.find((id) => members().includes(id));
		if (!firstMember) throw new Error('no member left');
		expectSingleChip(after, firstMember);
		expectMembers(after, members());
		expect(after.stats.memberWrites).toBe(before.stats.memberWrites);
		if (firstMember === ids.m1) expect(after.chips[0]?.serial).toBe(serial);
		record('A1-2b-dnd', {
			realInputProbe: probeResult,
			synthetic: { ...dnd, orderChanged: moved, before: compact(before), after: compact(after) },
		});
		await shot('a1-2b-dnd');

		// Back to the planned order for the next cases.
		const planned = order('m1', 'm2', 'm3', 'n1', 'n2');
		for (const [i, id] of planned.entries()) await moveLeaf(id, i);
		const s = await waitForSnap((x) => JSON.stringify(onlyStrip(x).leafIds) === JSON.stringify(planned) && x.chips[0]?.hostLeafId === ids.m1, 'planned order');
		expectSingleChip(s, ids.m1);
	});

	it('A1-3 renaming the first member file keeps chip and member classes', async function () {
		const before = await snap();
		const serial = before.chips[0]?.serial;
		await browser.executeObsidian(
			async ({ app, obsidian }, from, to) => {
				const file = app.vault.getFileByPath(from);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${from}`);
				await app.fileManager.renameFile(file, to);
			},
			NOTES.m1,
			RENAMED,
		);
		const s = await waitForSnap((x) => header(x, ids.m1).title === RENAMED.replace(/\.md$/, ''), 'title updated');
		expect(header(s, ids.m1).file).toBe(RENAMED);
		expectSingleChip(s, ids.m1, serial);
		expectMembers(s, members());
		expectNoRedecoration(before, s);
		record('A1-3-rename', { titleBefore: header(before, ids.m1).title, titleAfter: header(s, ids.m1).title, state: compact(s) });
		await shot('a1-3-rename');
	});

	it('A1-4 pinning then unpinning the first member keeps chip and member classes', async function () {
		const before = await snap();
		const serial = before.chips[0]?.serial;
		const setPinned = (pinned: boolean) =>
			browser.executeObsidian(
				({ app }, id, value) => {
					const leaf = app.workspace.getLeafById(id);
					if (!leaf) throw new Error(`no leaf ${id}`);
					leaf.setPinned(value);
				},
				ids.m1,
				pinned,
			);

		await setPinned(true);
		const pinned = await waitForSnap((x) => header(x, ids.m1).pinned && header(x, ids.m1).pinIcon, 'pinned');
		expectSingleChip(pinned, ids.m1, serial);
		expectMembers(pinned, members());
		expectNoRedecoration(before, pinned);
		await shot('a1-4-pin');

		await setPinned(false);
		const unpinned = await waitForSnap((x) => !header(x, ids.m1).pinned && !header(x, ids.m1).pinIcon, 'unpinned');
		expectSingleChip(unpinned, ids.m1, serial);
		expectMembers(unpinned, members());
		expectNoRedecoration(before, unpinned);
		expect(onlyStrip(unpinned).leafIds).toEqual(onlyStrip(before).leafIds);
		record('A1-4-pin', { pinned: compact(pinned), unpinned: compact(unpinned) });
	});

	it('A1-5 undo close: the chip comes back on the restored leaf (same leaf id, new header)', async function () {
		// Mark the current header element, to tell a new header from the old one later.
		await browser.execute((sel) => activeDocument.querySelector(sel)?.setAttribute('data-s1-old-header', '1'), headerSel(ids.m1));
		const before = await snap();
		const serial = Number(before.chips[0]?.serial);

		// Close the first member with a real click on its close button.
		await $(headerSel(ids.m1)).moveTo();
		await $(`${headerSel(ids.m1)} .workspace-tab-header-inner-close-button`).click();
		const closed = await waitForSnap((x) => !onlyStrip(x).leafIds.includes(ids.m1) && x.chips[0]?.hostLeafId === ids.m2, 'M1 closed, chip on M2');
		expectSingleChip(closed, ids.m2);
		expectMembers(closed, [ids.m2, ids.m3]);

		await browser.executeObsidianCommand(UNDO_CLOSE);
		const s = await waitForSnap((x) => onlyStrip(x).leafIds[0] === ids.m1 && x.chips[0]?.hostLeafId === ids.m1, 'M1 restored at its index with the chip');
		const restore = s.stats.restores.find((r) => r.id === ids.m1);
		record('A1-5-undo-close', { before: compact(before), closed: compact(closed), restored: compact(s), nativeRestoreIndex: restore?.nativeIndex ?? null });
		await shot('a1-5-undo-close');
		expect(onlyStrip(s).leafIds).toEqual(order('m1', 'm2', 'm3', 'n1', 'n2'));
		expect(onlyStrip(s).headerOrder).toEqual(onlyStrip(s).leafIds);
		// Same leaf id, but a new header element (the old one carried the marker).
		expect(header(s, ids.m1).marker).toBeNull();
		expect(header(s, ids.m1).file).toBe(RENAMED);
		expectSingleChip(s, ids.m1);
		expect(Number(s.chips[0]?.serial)).toBeGreaterThan(serial);
		expectMembers(s, members());
		// The re-decoration was driven by layout-change. Obsidian did not put the leaf back at its old
		// index by itself; the spike moved it there with the native move recipe.
		expect(s.stats.layoutChanges).toBeGreaterThan(closed.stats.layoutChanges);
		expect(restore?.restoredIndex).toBe(0);
		expect(restore?.nativeIndex).not.toBe(0);
		// Requirements 7.2 (checked on 1.15.0): undo-close puts the tab at the end of the strip.
		// 1.13.x places it elsewhere (recorded above); only the documented versions are held to it.
		if (atLeast(version(), '1.14.0')) expect(restore?.nativeIndex).toBe(4);
		// The new header needed its 3 member marks once.
		expect(s.stats.memberWrites).toBe(before.stats.memberWrites + 3);
	});

	// ---------------- A2: the chip's events are kept from the tab ----------------

	it('A2-1 a real left click on the chip does not switch tabs', async function () {
		await $(headerSel(ids.n1)).click();
		const before = await waitForSnap((x) => x.activeLeafId === ids.n1 && onlyStrip(x).currentId === ids.n1, 'N1 active');
		await $(CHIP_SEL).click();
		await browser.pause(400);
		const after = await snap();
		expect(after.stats.chipEvents.click).toBe(before.stats.chipEvents.click + 1);
		expect(after.activeLeafId).toBe(ids.n1);
		expect(onlyStrip(after).currentId).toBe(ids.n1);
		expectSingleChip(after, ids.m1);
		record('A2-1-left-click', { before: compact(before), after: compact(after) });
		await shot('a2-1-left-click');
	});

	it('A2-2 a real middle click on the chip does not close the tab', async function () {
		// Control: a middle click on a plain tab header does close that tab (then undo-close brings it back).
		await $(`${headerSel(ids.n2)} .workspace-tab-header-inner-title`).click({ button: 'middle' });
		const controlClosed = await waitForSnap((x) => !onlyStrip(x).leafIds.includes(ids.n2), 'control: N2 closed by middle click');
		await browser.executeObsidianCommand(UNDO_CLOSE);
		await waitForSnap((x) => onlyStrip(x).leafIds.includes(ids.n2), 'control: N2 back');
		await $(headerSel(ids.n1)).click();
		const before = await waitForSnap((x) => x.activeLeafId === ids.n1, 'N1 active');

		await $(CHIP_SEL).click({ button: 'middle' });
		await browser.pause(500);
		const after = await snap();
		expect(after.stats.chipEvents.auxclick).toBe(before.stats.chipEvents.auxclick + 1);
		expect(onlyStrip(after).leafIds).toEqual(onlyStrip(before).leafIds);
		expect(onlyStrip(after).leafIds).toContain(ids.m1);
		expectSingleChip(after, ids.m1);
		record('A2-2-middle-click', { controlClosedN2: !onlyStrip(controlClosed).leafIds.includes(ids.n2), before: compact(before), after: compact(after) });
		await shot('a2-2-middle-click');
	});

	it("A2-3 a real right click on the chip opens no tab menu (only the plugin's own menu)", async function () {
		// Control: a right click on the first member's title opens Obsidian's tab menu.
		await $(`${headerSel(ids.m1)} .workspace-tab-header-inner-title`).click({ button: 'right' });
		await browser.waitUntil(async () => (await menuTitles()).length > 0, { timeout: 3000, timeoutMsg: 'control: no tab menu' });
		const nativeTitles = await menuTitles();
		expect(nativeTitles).toContain('Close');
		await closeMenus();

		const before = await snap();
		await $(CHIP_SEL).click({ button: 'right' });
		await browser.waitUntil(async () => (await menuTitles()).length > 0, { timeout: 3000, timeoutMsg: 'no menu after right click on chip' });
		const chipTitles = await menuTitles();
		const after = await snap();
		expect(chipTitles).toEqual(['Spike chip menu']);
		expect(chipTitles.filter((t) => nativeTitles.includes(t))).toEqual([]);
		expect(after.stats.chipEvents.contextmenu).toBe(before.stats.chipEvents.contextmenu + 1);
		expect(after.stats.chipMenus).toBe(before.stats.chipMenus + 1);
		record('A2-3-right-click', { nativeTabMenuTitles: nativeTitles, chipMenuTitles: chipTitles });
		await shot('a2-3-right-click');
		await closeMenus();
	});

	it('A2-4 hovering the chip with Mod held opens no page preview', async function () {
		// Watch for hover-link events from tab headers and for page preview popovers.
		await browser.executeObsidian(({ app }) => {
			type Monitor = { hoverLinks: string[]; popovers: number; observer: MutationObserver; ref: import('obsidian').EventRef };
			const w = activeWindow as Window & { s1Hover?: Monitor };
			const monitor = {
				hoverLinks: [] as string[],
				popovers: 0,
				observer: new MutationObserver((records) => {
					for (const r of records) {
						for (const n of Array.from(r.addedNodes)) {
							if (n instanceof HTMLElement && (n.matches('.hover-popover') || n.querySelector('.hover-popover'))) monitor.popovers++;
						}
					}
				}),
				// 'hover-link' is not in the public typings.
				ref: (app.workspace as unknown as { on(name: 'hover-link', cb: (data: { source: string }) => void): import('obsidian').EventRef }).on(
					'hover-link',
					(data) => {
						monitor.hoverLinks.push(data.source);
					},
				),
			};
			monitor.observer.observe(activeDocument.body, { childList: true, subtree: true });
			w.s1Hover = monitor;
		});
		const readMonitor = () =>
			browser.execute(() => {
				const w = activeWindow as Window & { s1Hover?: { hoverLinks: string[]; popovers: number } };
				const m = w.s1Hover;
				const out = { hoverLinks: [...(m?.hoverLinks ?? [])], popovers: m?.popovers ?? -1, open: activeDocument.querySelectorAll('.hover-popover').length };
				if (m) {
					m.hoverLinks.length = 0;
					m.popovers = 0;
				}
				return out;
			});
		const modHover = async (target: WebdriverIO.Element) => {
			const key = browser.action('key').down(Key.Command).pause(0).pause(1500).up(Key.Command);
			const pointer = browser.action('pointer').pause(0).move({ origin: target, duration: 0 }).pause(1500).pause(0);
			await browser.actions([key, pointer]);
		};
		const neutral = await neutralPoint();

		// Control: Mod + hover on the first member's title (coming from outside the header) opens a preview.
		await movePointerTo(neutral);
		await browser.pause(300);
		await readMonitor();
		await modHover(await $(`${headerSel(ids.m1)} .workspace-tab-header-inner-title`).getElement());
		const control = await readMonitor();
		expect(control.hoverLinks).toContain('tab-header');
		expect(control.popovers).toBeGreaterThan(0);

		// Leave, let the preview close.
		await movePointerTo(neutral);
		await browser.waitUntil(async () => (await browser.execute(() => activeDocument.querySelectorAll('.hover-popover').length)) === 0, {
			timeout: 5000,
			timeoutMsg: 'control preview did not close',
		});
		await browser.pause(300);
		await readMonitor();

		// Mod + hover on the chip, also coming straight from outside the header.
		const before = await snap();
		await modHover(await $(CHIP_SEL).getElement());
		const onChip = await readMonitor();
		const after = await snap();
		expect(after.stats.chipEvents.mouseover).toBeGreaterThan(before.stats.chipEvents.mouseover);
		expect(onChip.hoverLinks.filter((s) => s === 'tab-header')).toEqual([]);
		expect(onChip.popovers).toBe(0);
		expect(onChip.open).toBe(0);
		record('A2-4-mod-hover', { control, onChip, chipMouseovers: after.stats.chipEvents.mouseover - before.stats.chipEvents.mouseover });
		await shot('a2-4-mod-hover');

		await browser.executeObsidian(({ app }) => {
			const w = activeWindow as Window & { s1Hover?: { observer: MutationObserver; ref: import('obsidian').EventRef } };
			if (w.s1Hover) {
				w.s1Hover.observer.disconnect();
				app.workspace.offref(w.s1Hover.ref);
			}
			delete w.s1Hover;
		});
		await movePointerTo(neutral);
	});

	it('A2-5 the chip is a no-drag region of the frameless window, and its double click stays on the chip', async function () {
		const s = await snap();
		const chip = s.chips[0];
		if (!chip) throw new Error('no chip');
		expect(chip.appRegion).toBe('no-drag');
		// Context: the strip it sits in is a window drag region.
		expect(chip.innerAppRegion).toBe('drag');

		// On macOS without a frame, a double click on the strip zooms the window. Count double clicks
		// that reach the strip container.
		await browser.execute(() => {
			const container = activeDocument.querySelector('.workspace .mod-root .workspace-tab-header-container');
			if (!container) throw new Error('no strip');
			const w = activeWindow as Window & { s1Dbl?: { count: number; listener: () => void; container: Element } };
			const state = { count: 0, listener: () => state.count++, container };
			container.addEventListener('dblclick', state.listener);
			w.s1Dbl = state;
		});
		const windowRect = () =>
			browser.execute(() => ({ x: activeWindow.screenX, y: activeWindow.screenY, w: activeWindow.outerWidth, h: activeWindow.outerHeight }));
		const rectBefore = await windowRect();
		const before = await snap();
		await $(CHIP_SEL).doubleClick();
		await browser.pause(600);
		const after = await snap();
		const rectAfter = await windowRect();
		const reached = await browser.execute(() => {
			const w = activeWindow as Window & { s1Dbl?: { count: number; listener: () => void; container: Element } };
			const count = w.s1Dbl?.count ?? -1;
			if (w.s1Dbl) w.s1Dbl.container.removeEventListener('dblclick', w.s1Dbl.listener);
			delete w.s1Dbl;
			return count;
		});
		expect(after.stats.chipEvents.dblclick).toBe(before.stats.chipEvents.dblclick + 1);
		expect(reached).toBe(0);
		expect(rectAfter).toEqual(rectBefore);
		expect(after.activeLeafId).toBe(before.activeLeafId);
		record('A2-5-app-region', {
			frameless: s.env.frameless,
			titlebarStyle: s.env.titlebarStyle,
			chipAppRegion: chip.appRegion,
			headerAppRegion: chip.hostAppRegion,
			innerAppRegion: chip.innerAppRegion,
			containerAppRegion: chip.containerAppRegion,
			dblclickReachedStrip: reached,
			windowRect: { before: rectBefore, after: rectAfter },
		});
		await shot('a2-5-app-region');
	});

	// ---------------- A3: themes, chip fully visible ----------------

	const layouts = [
		{ name: 'sidebar', showRibbon: true, leftCollapsed: false, dark: false },
		{ name: 'user-layout', showRibbon: false, leftCollapsed: true, dark: false },
		{ name: 'user-layout-dark', showRibbon: false, leftCollapsed: true, dark: true },
	] as const;

	for (const theme of ['default', 'Atom'] as const) {
		it(`A3 ${theme} theme: the chip is fully visible, not clipped or covered`, async function () {
			await obsidianPage.setTheme(theme);
			await browser.waitUntil(
				async () =>
					browser.execute((name) => {
						const divider = getComputedStyle(activeDocument.body).getPropertyValue('--divider-color').trim();
						// Atom sets --divider-color to transparent; the default theme does not.
						return name === 'Atom' ? divider === 'transparent' : divider !== 'transparent';
					}, theme),
				{ timeout: 5000, timeoutMsg: `${theme} theme not applied` },
			);
			const results: unknown[] = [];
			for (const layout of layouts) {
				// Test setup, not an assertion: Obsidian saves config 1 s after a change and re-reads the
				// config files when they change on disk; a re-read inside that second can undo a setting.
				// So write the config to disk right away, and re-apply if it was undone.
				const applied = (x: Snapshot) =>
					x.env.leftCollapsed === layout.leftCollapsed && x.env.dark === layout.dark && x.env.showRibbon === layout.showRibbon;
				let attempts = 0;
				let s = await snap();
				while (!applied(s) || attempts === 0) {
					if (attempts >= 3) throw new Error(`${layout.name} not applied: ${JSON.stringify(s.env)}`);
					attempts++;
					await browser.executeObsidian(
						async ({ app }, showRibbon, leftCollapsed, dark) => {
							const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
							vault.setConfig('showRibbon', showRibbon);
							vault.setConfig('theme', dark ? 'obsidian' : 'moonstone');
							await vault.saveConfig();
							if (leftCollapsed) app.workspace.leftSplit.collapse();
							else app.workspace.leftSplit.expand();
						},
						layout.showRibbon,
						layout.leftCollapsed,
						layout.dark,
					);
					await movePointerTo({ x: 640, y: 500 });
					await browser.pause(1500);
					s = await snap();
				}
				s = await waitForSnap(applied, `${layout.name} applied`);
				expectSingleChip(s, ids.m1);
				const chip = s.chips[0];
				if (!chip) throw new Error('no chip');
				const visibility = {
					insideContainerVisible: chip.insideContainerVisible,
					insideInnerVisible: chip.insideInnerVisible,
					insideViewport: chip.insideViewport,
					clearOfFramePadding: chip.clearOfFramePadding,
					hits: chip.hits,
				};
				results.push({ layout: layout.name, setupAttempts: attempts, env: s.env, chip, state: compact(s) });
				await shot(`a3-${theme.toLowerCase()}-${layout.name}`);
				expect(visibility).toEqual({
					insideContainerVisible: true,
					insideInnerVisible: true,
					insideViewport: true,
					clearOfFramePadding: true,
					hits: { center: true, left: true, right: true },
				});
				expect(chip.hostPosition).toBe('relative');
			}
			record(`A3-${theme}`, results);
		});
	}

	// ---------------- extras (not MUST) ----------------

	it('extra: no error-level console messages from the spike plugin', async function () {
		const logs = (await browser.getLogs('browser')) as { level: string; message: string }[];
		const severe = logs.filter((l) => l.level === 'SEVERE');
		record('extra-console', { entries: logs.length, severe: severe.map((l) => l.message.slice(0, 300)) });
		expect(severe.filter((l) => /tabstrip|spike/i.test(l.message))).toEqual([]);
	});

	it('extra: disabling the spike plugin removes every chip, class, attribute and custom property', async function () {
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins.disablePlugin('tabstrip-spike-s1');
		});
		const leftovers = await browser.execute(() => {
			const found: string[] = [];
			for (const el of Array.from(activeDocument.querySelectorAll('*'))) {
				if (el.classList.contains('tabstrip-chip')) found.push('chip');
				for (const c of Array.from(el.classList)) if (c.startsWith('tabstrip-')) found.push(`class ${c}`);
				for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-tabstrip')) found.push(`attr ${a.name}`);
				if (el instanceof HTMLElement && el.style.getPropertyValue('--tabstrip-chip-slot')) found.push('slot property');
			}
			return found;
		});
		record('extra-unload', { leftovers });
		expect(leftovers).toEqual([]);
		expect(PLUGIN_ID).toBe('tabstrip-spike-s1');
	});
});
