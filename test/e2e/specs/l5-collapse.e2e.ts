/**
 * Step L5: collapse and expand groups on the horizontal strip (cases C1–C12 of the L5 brief).
 *
 * Collapse hides every member header with width 0 and visibility: hidden (never display: none);
 * only the chip shows. The shown tab is never hidden: collapsing its group shows a neighbour
 * first, and a hidden tab that becomes shown expands its group.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run). Real pointer
 * clicks on the chip; every check reads the live state. No real drag and drop (L2).
 */
import { $, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { contrast, parseCssColor } from '../../../src/ui/color';
import {
	chipSel,
	clickMenuItem,
	closeMenus,
	closePopout,
	commandAvailable,
	dividerPaint,
	errorTimeline,
	expectContiguous,
	expectDecorated,
	focusInfo,
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
	setLook,
	setPinned,
	setUserLayout,
	shot,
	startErrorWatch,
	strandedObservations,
	stripOf,
	titleSel,
	underlinePaint,
	waitForMenu,
	waitForState,
	warmUpPopouts,
	withWarmPopout,
	writeEvidence,
	PAINT_TOLERANCE,
	type PageState,
} from '../helpers';
import { decodePng, innerRows, scanBand } from '../png';

const CMD = {
	toggle: 'tabstrip:toggle-collapse-current-group',
	next: 'tabstrip:next-tab-skip-collapsed',
	prev: 'tabstrip:previous-tab-skip-collapsed',
	add: 'tabstrip:add-to-new-group',
	restore: 'tabstrip:restore-native-tab-bar',
	show: 'tabstrip:show-tab-groups',
} as const;

const LOOKS = [
	{ theme: 'default', dark: false },
	{ theme: 'default', dark: true },
	{ theme: 'Atom', dark: false },
	{ theme: 'Atom', dark: true },
] as const;

function collapsed(s: PageState, groupId: string): boolean | undefined {
	return s.state.groups.find((g) => g.id === groupId)?.collapsed;
}

/** One tab header as laid out: box, computed visibility and display, plugin class, native active class. */
interface HeaderFact {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
	visibility: string;
	display: string;
	collapsedClass: boolean;
	isActive: boolean;
	/** The tab header container (the strip) of this header. */
	strip: { left: number; right: number; top: number; bottom: number } | null;
}

/** Header facts for these leaves, in whatever window they are. */
async function headerFacts(ids: string[]): Promise<Record<string, HeaderFact>> {
	return browser.executeObsidian(({ app }, list) => {
		const out: Record<string, unknown> = {};
		for (const id of list) {
			const leaf = app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement } | null;
			const h = leaf?.tabHeaderEl;
			if (!h) continue;
			const win = h.ownerDocument.defaultView;
			if (!win) continue;
			const r = h.getBoundingClientRect();
			const cs = win.getComputedStyle(h);
			const strip = h.closest('.workspace-tab-header-container');
			const sr = strip?.getBoundingClientRect();
			out[id] = {
				left: r.left,
				right: r.right,
				top: r.top,
				bottom: r.bottom,
				width: r.width,
				height: r.height,
				visibility: cs.visibility,
				display: cs.display,
				collapsedClass: h.classList.contains('tabstrip-collapsed'),
				isActive: h.classList.contains('is-active'),
				strip: sr ? { left: sr.left, right: sr.right, top: sr.top, bottom: sr.bottom } : null,
			};
		}
		return out as Record<string, HeaderFact>;
	}, ids);
}

interface ChipFact {
	rect: { left: number; right: number; top: number; bottom: number; width: number; height: number };
	visibility: string;
	display: string;
	ariaExpanded: string | null;
	ariaLabel: string | null;
	/** The element at the chip's centre is the chip (it can be clicked). */
	hit: boolean;
	collapsedClass: boolean;
	doc: 'main' | 'popout';
}

async function chipFact(groupId: string): Promise<ChipFact | null> {
	return browser.executeObsidian(({ app }, gid) => {
		const docs = new Set<Document>([document]);
		app.workspace.iterateAllLeaves((leaf) => {
			docs.add(leaf.getContainer().doc);
		});
		for (const doc of docs) {
			const chip = doc.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
			const win = doc.defaultView;
			if (!chip || !win) continue;
			const r = chip.getBoundingClientRect();
			const cs = win.getComputedStyle(chip);
			const at = doc.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
			return {
				rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
				visibility: cs.visibility,
				display: cs.display,
				ariaExpanded: chip.getAttribute('aria-expanded'),
				ariaLabel: chip.getAttribute('aria-label'),
				hit: at !== null && chip.contains(at),
				collapsedClass: chip.classList.contains('is-collapsed'),
				doc: doc === document ? 'main' : 'popout',
			} as const;
		}
		return null;
	}, groupId);
}

/**
 * Every shown tab (the current tab of each strip, and the active leaf) is visible: not a member
 * of a collapsed group in the model, and on screen without the collapsed class, visible, with a
 * width. Returns the violations (empty when all is well).
 */
async function hiddenShown(): Promise<string[]> {
	return browser.executeObsidian(({ app }) => {
		type Leaf = { id: string; tabHeaderEl: HTMLElement; parent: unknown };
		type Tabs = { children: Leaf[]; currentTab: number; isStacked?: boolean };
		const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { flush(): void; state(): { groups: { id: string; collapsed: boolean }[]; members: { leafId: string; groupId: string }[] } } } | undefined> } }).plugins.plugins['tabstrip'];
		if (!plugin) return ['plugin not loaded'];
		plugin.debug.flush();
		const st = plugin.debug.state();
		const collapsedGroups = new Set(st.groups.filter((g) => g.collapsed).map((g) => g.id));
		const out: string[] = [];
		const ws = app.workspace as unknown as { rootSplit: unknown; floatingSplit: unknown; activeLeaf: Leaf | null };
		const strips = new Set<Tabs>();
		app.workspace.iterateAllLeaves((leaf) => {
			const root = leaf.getRoot() as unknown;
			if (root !== ws.rootSplit && root !== ws.floatingSplit) return;
			strips.add((leaf as unknown as Leaf).parent as Tabs);
		});
		const check = (leaf: Leaf | undefined | null, what: string, stacked: boolean) => {
			if (!leaf) return;
			const m = st.members.find((x) => x.leafId === leaf.id);
			if (m && collapsedGroups.has(m.groupId) && !stacked) out.push(`${what} ${leaf.id} is in collapsed group ${m.groupId}`);
			const h = leaf.tabHeaderEl;
			const win = h.ownerDocument.defaultView;
			if (h.classList.contains('tabstrip-collapsed')) out.push(`${what} ${leaf.id} header has tabstrip-collapsed`);
			if (win && win.getComputedStyle(h).visibility !== 'visible') out.push(`${what} ${leaf.id} header not visible`);
			if (!stacked && h.getBoundingClientRect().width <= 0) out.push(`${what} ${leaf.id} header has no width`);
		};
		for (const tabs of strips) check(tabs.children[tabs.currentTab], 'current', tabs.isStacked === true);
		// No ancestor of a strip was scrolled (a hidden header brought into view would shift the window).
		for (const tabs of strips) {
			let el: HTMLElement | null = tabs.children[0]?.tabHeaderEl.parentElement ?? null;
			while (el) {
				if (el.scrollTop !== 0) out.push(`ancestor ${el.className} scrollTop ${String(el.scrollTop)}`);
				if (!el.classList.contains('workspace-tab-header-container-inner') && el.scrollLeft !== 0) out.push(`ancestor ${el.className} scrollLeft ${String(el.scrollLeft)}`);
				el = el.parentElement;
			}
		}
		const active = ws.activeLeaf;
		if (active && [...strips].some((t) => t.children.includes(active))) check(active, 'active', (active.parent as Tabs).isStacked === true);
		return out;
	});
}

async function expectNoHiddenShown(step: string): Promise<void> {
	expect({ step, violations: await hiddenShown() }).toEqual({ step, violations: [] });
}

/** Collapses or expands through the plugin's own path (same as a chip click); for set-up only. */
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

/**
 * openNotes, plus: the first tab is reused by openNotes (it opens a note in place), so it may
 * still be a member of a group from an earlier case; take it out first.
 */
async function freshNotes<R extends Parameters<typeof openNotes>[0][number]>(roles: R[]): Promise<Record<R, string>> {
	const ids = (await openNotes(roles)) as Record<R, string>;
	const first = ids[roles[0] as R];
	let s = await pageState();
	if (groupOf(s, first) !== null) {
		await setActive(first);
		expect(await runCommand('tabstrip:remove-from-group')).toBe(true);
		s = await waitForState((x) => groupOf(x, first) === null && x.state.groups.length === 0, 'leftover group gone');
	}
	return ids;
}

/** The text in a note tab's editor (what a stray key press would change). */
async function noteText(leafId: string): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }, id) => {
		const view = app.workspace.getLeafById(id)?.view;
		if (!(view instanceof obsidian.MarkdownView)) throw new Error(`leaf ${id} is not a note`);
		return view.editor.getValue();
	}, leafId);
}

/** Real left click on the chip (in the main window). */
async function clickChip(groupId: string): Promise<void> {
	await $(chipSel(groupId)).click();
}

/** Opens a split to the right of `leafId` with these notes as its tabs; returns their ids (last one active). */
async function splitWithNotes(leafId: string, paths: string[]): Promise<string[]> {
	return browser.executeObsidian(
		async ({ app, obsidian }, id, files) => {
			const anchor = app.workspace.getLeafById(id);
			if (!anchor) throw new Error('no anchor leaf');
			const first = app.workspace.createLeafBySplit(anchor, 'vertical');
			const ids: string[] = [];
			for (const [i, p] of files.entries()) {
				const file = app.vault.getFileByPath(p);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
				const leaf = i === 0 ? first : app.workspace.createLeafInParent(first.parent, i);
				await leaf.openFile(file);
				ids.push((leaf as unknown as { id: string }).id);
			}
			return ids;
		},
		leafId,
		paths,
	);
}

type Paint = Awaited<ReturnType<typeof underlinePaint>>;

/**
 * Columns (device px) in a group's underline band, between two x positions (CSS px), that have
 * the group's colour, on the screenshot `underlinePaint` took (it also painted the reference
 * swatch of the group colour). The band is the underline's box: hidden segments keep their boxes.
 */
function paintedColumns(paint: Paint, groupId: string, from: number, to: number): { matched: number; columns: number; rows: number[] } {
	const g = paint.groups.find((x) => x.groupId === groupId);
	if (!g) throw new Error(`no paint data for ${groupId}`);
	const img = decodePng(fs.readFileSync(path.join(repoRoot, paint.file)));
	const rows = innerRows(g.top, g.bottom, paint.scale);
	const scan = scanBand(img, Math.ceil(from * paint.scale), Math.floor(to * paint.scale), rows, g.painted, PAINT_TOLERANCE);
	const missed = scan.misses.reduce((n, m) => n + m.to - m.from + 1, 0);
	return { matched: scan.columns - missed, columns: scan.columns, rows };
}

async function bandPaint(name: string, groupId: string, from: number, to: number): Promise<{ matched: number; columns: number; file: string; rows: number[] }> {
	const paint = await underlinePaint(name);
	return { ...paintedColumns(paint, groupId, from, to), file: paint.file };
}

function contrastOf(a: string, b: string): number {
	const x = parseCssColor(a);
	const y = parseCssColor(b);
	if (x === null || y === null) throw new Error(`unparsable colour ${a} / ${b}`);
	return contrast(x, y);
}

describe('L5 collapse and expand groups', function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			vault.setConfig('theme', 'moonstone');
			await vault.saveConfig();
		});
		await startErrorWatch();
		const warmUp = await warmUpPopouts();
		record('l5-setup', { warmUp, obsidian: browser.getObsidianVersion(), installer: browser.getObsidianInstallerVersion() });
	});

	after(function () {
		writeEvidence('l5-collapse');
	});

	// ------------------------------------------------------------------ C1

	it('C1 a click on the chip collapses the group to its chip (width 0, hidden, not display: none); a second click expands it', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		await setActive(ids.n1);
		const gid = await makeGroup([ids.n2, ids.n3, ids.n4], 'Collapse 折叠', 'blue');
		let s = await waitForState((x) => x.chips.some((c) => c.groupId === gid), 'chip');
		const members = [ids.n2, ids.n3, ids.n4];
		const before = await chipFact(gid);
		expect(before?.ariaExpanded).toBe('true');
		expect(before?.ariaLabel).toBe('Collapse 折叠, 3 tabs');
		const expandedShot = await shot('c1-1-expanded', 'L5');

		await clickChip(gid);
		s = await waitForState((x) => collapsed(x, gid) === true, 'collapsed by a click');
		expect(s.activeId).toBe(ids.n1);
		expect(membersInOrder(s, gid)).toEqual(members);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6]);
		const h = await headerFacts([ids.n1, ...members, ids.n5]);
		const chip = await chipFact(gid);
		if (!chip) throw new Error('no chip');
		for (const id of members) {
			const f = h[id];
			const where = JSON.stringify({ id, f });
			expect({ where, width: f?.width, visibility: f?.visibility, notNone: f?.display !== 'none', cls: f?.collapsedClass }).toEqual({ where, width: 0, visibility: 'hidden', notNone: true, cls: true });
		}
		expect(chip).toMatchObject({ visibility: 'visible', ariaExpanded: 'false', ariaLabel: 'Collapse 折叠, 3 tabs, collapsed', hit: true, collapsedClass: true });
		expect(chip.rect.width).toBeGreaterThan(20);
		// The chip keeps its room: 4px from the tab before it and 4px from the (zero-width) holder,
		// whose box is where the next visible tab starts.
		const n1 = h[ids.n1];
		const n2 = h[ids.n2];
		const n5 = h[ids.n5];
		if (!n1 || !n2 || !n5) throw new Error('headers');
		expect(Math.abs(chip.rect.left - n1.right - 4)).toBeLessThanOrEqual(1);
		expect(Math.abs(n2.left - chip.rect.right - 4)).toBeLessThanOrEqual(1);
		expect(Math.abs(n5.left - n2.left)).toBeLessThanOrEqual(0.5);
		// No underline painted under the collapsed group: from the chip's start to the end of the next visible tab.
		const band = await bandPaint('c1-collapsed', gid, chip.rect.left - 1, n5.right - 2);
		expect(band.columns).toBeGreaterThan(50);
		expect(band.matched).toBe(0);
		const collapsedShot = await shot('c1-2-collapsed', 'L5');
		await expectNoHiddenShown('C1 collapsed');

		// Click again: expanded, underline continuous again (geometry and screenshot pixels).
		await clickChip(gid);
		s = await waitForState((x) => collapsed(x, gid) === false, 'expanded by a second click');
		expectDecorated(s, gid);
		const after = await chipFact(gid);
		expect(after).toMatchObject({ ariaExpanded: 'true', ariaLabel: 'Collapse 折叠, 3 tabs', collapsedClass: false });
		const h2 = await headerFacts(members);
		for (const id of members) {
			expect(h2[id]?.width).toBeGreaterThan(20);
			expect(h2[id]?.visibility).toBe('visible');
			expect(h2[id]?.collapsedClass).toBe(false);
		}
		const paint = await underlinePaint('c1-expanded');
		const g = paint.groups.find((x) => x.groupId === gid);
		expect({ gaps: g?.gaps, spillBefore: g?.spillBefore, spillAfter: g?.spillAfter }).toEqual({ gaps: [], spillBefore: 0, spillAfter: 0 });
		expect(g?.columns).toBeGreaterThan(100);
		await expectNoHiddenShown('C1 expanded');

		// A double click toggles once: collapsing widens the other tabs, so the chip moves away from
		// the pointer, and the second click would otherwise activate the tab that is now there.
		await browser.pause(600);
		const dblBefore = (await chipFact(gid))?.rect;
		await $(chipSel(gid)).doubleClick();
		await browser.pause(700);
		s = await pageState();
		const dblAfter = (await chipFact(gid))?.rect;
		expect(collapsed(s, gid)).toBe(true);
		expect(s.activeId).toBe(ids.n1);
		expect(mainStrip(s).currentId).toBe(ids.n1);
		await clickChip(gid);
		s = await waitForState((x) => collapsed(x, gid) === false, 'expanded after the double click');
		record('C1-double-click', { chipBefore: dblBefore, chipAfter: dblAfter });
		record('C1', { chipBefore: before, chipCollapsed: chip, headers: h, band, chipAfter: after, paint: { gaps: g?.gaps, columns: g?.columns }, screenshots: [expandedShot, collapsedShot] });
	});

	// ------------------------------------------------------------------ C2

	it('C2 collapsing the group with the active tab: right (skipping a collapsed group), else left, else a new tab', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
		const g1 = await makeGroup([ids.n2, ids.n3], 'Right 右');
		const g2 = await makeGroup([ids.n4, ids.n5], 'Skipped');
		const g3 = await makeGroup([ids.n7, ids.n8], 'End 尾');
		await setActive(ids.n1);
		await setCollapsedVia(g2, true);
		// (a) Active n3 in g1: the nearest visible tab to the right skips g2's hidden n4 and n5.
		await setActive(ids.n3);
		await clickChip(g1);
		let s = await waitForState((x) => collapsed(x, g1) === true, 'g1 collapsed');
		expect(s.activeId).toBe(ids.n6);
		await expectNoHiddenShown('C2 right');
		const right = s.activeId;

		// (b) Active n8, the last tab: nothing to the right; to the left n6 is the nearest visible
		// tab (g1 and g2 are collapsed).
		await setActive(ids.n8);
		await clickChip(g3);
		s = await waitForState((x) => collapsed(x, g3) === true, 'g3 collapsed');
		expect(s.activeId).toBe(ids.n6);
		await expectNoHiddenShown('C2 left');
		// Left, skipping hidden tabs: with n6 in a collapsed group too, only n1 is left.
		const g4 = await makeGroup([ids.n6], '');
		s = await waitForState((x) => groupOf(x, ids.n6) === g4, 'n6 grouped');
		await clickChip(g4);
		s = await waitForState((x) => collapsed(x, g4) === true, 'g4 collapsed');
		expect(s.activeId).toBe(ids.n1);
		await expectNoHiddenShown('C2 left skipping');
		const left = s.activeId;
		const collapsedShot = await shot('c2-1-four-collapsed', 'L5');

		// (c) The strip holds only that group: a new empty tab at the end, ungrouped and visible.
		const ids2 = await freshNotes(['n1', 'n2']);
		const g5 = await makeGroup([ids2.n1, ids2.n2], 'Only 唯一');
		await setActive(ids2.n2);
		await clickChip(g5);
		s = await waitForState((x) => collapsed(x, g5) === true && mainStrip(x).leafIds.length === 3, 'g5 collapsed with a new tab');
		const created = mainStrip(s).leafIds[2] ?? '';
		expect(mainStrip(s).leafIds.slice(0, 2)).toEqual([ids2.n1, ids2.n2]);
		expect(s.activeId).toBe(created);
		expect(groupOf(s, created)).toBeNull();
		expect(mainStrip(s).files[2]).toBeNull();
		await expectNoHiddenShown('C2 new tab');
		const newTabShot = await shot('c2-2-only-group-new-tab', 'L5');

		// (d) The same in a strip without the focus: the new tab is shown there, the focus stays.
		const right2 = await splitWithNotes(created, [NOTES.n3, NOTES.n4]);
		const [b1, b2] = right2;
		if (!b1 || !b2) throw new Error('split');
		const g6 = await makeGroup([b1, b2], 'Other pane');
		await setActive(b2);
		await setActive(created);
		await clickChip(g6);
		s = await waitForState((x) => collapsed(x, g6) === true && stripOf(x, b1).leafIds.length === 3, 'g6 collapsed, new tab in its strip');
		const otherStrip = stripOf(s, b1);
		expect(s.activeId).toBe(created);
		expect(otherStrip.currentId).toBe(otherStrip.leafIds[2]);
		expect(groupOf(s, otherStrip.leafIds[2] ?? '')).toBeNull();
		await expectNoHiddenShown('C2 other strip');
		expect(s.stats.loopStops).toBe(0);
		record('C2', { right, left, created, otherStrip, screenshots: [collapsedShot, newTabShot] });
	});

	// ------------------------------------------------------------------ C3

	it('C3 a hidden tab that becomes shown expands its group, by every path', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const gid = await makeGroup([ids.n3, ids.n4, ids.n5], 'Hidden 隐藏');
		const results: Record<string, unknown> = {};
		/** Back to: n1 active, group collapsed. */
		const reset = async () => {
			await setActive(ids.n1);
			await setCollapsedVia(gid, true);
			await expectNoHiddenShown('reset');
		};
		const expectExpandedWith = async (path: string, leafId: string, active = true) => {
			const s = await waitForState((x) => collapsed(x, gid) === false && (!active || x.activeId === leafId) && mainStrip(x).currentId === leafId, `${path}: group expanded with ${leafId} shown`);
			await expectNoHiddenShown(path);
			const h = await headerFacts([leafId]);
			expect(h[leafId]?.width).toBeGreaterThan(20);
			results[path] = { active: s.activeId, current: mainStrip(s).currentId, passes: s.stats.passes };
		};

		// 1. Native "Go to tab #4" (what its hotkey runs; the command is not patched).
		await reset();
		expect(await runCommand('workspace:goto-tab-4')).toBe(true);
		await expectExpandedWith('goto-tab-4', ids.n4);

		// 2. Native "Go to next tab" from n2 lands on hidden n3.
		await reset();
		await setActive(ids.n2);
		expect(await runCommand('workspace:next-tab')).toBe(true);
		await expectExpandedWith('next-tab', ids.n3);

		// 3. Native "Go to previous tab" from n6 lands on hidden n5.
		await reset();
		await setActive(ids.n6);
		expect(await runCommand('workspace:previous-tab')).toBe(true);
		await expectExpandedWith('previous-tab', ids.n5);

		// 4. Obsidian's tab list (the strip's drop-down of all tabs): real clicks.
		await reset();
		await $('.mod-root .workspace-tab-header-container .workspace-tab-header-tab-list').click();
		const listTitles = await waitForMenu();
		results['tab-list titles'] = listTitles;
		await clickMenuItem('会议记录（2026-11-08）');
		await expectExpandedWith('tab-list', ids.n3);

		// 5. A link click whose target is already open in a hidden tab, with an "open in the
		// existing tab" handler like Open Tab Settings (test-only, public API: getLeavesOfType,
		// setActiveLeaf). Real click on a rendered internal link in n1 (reading view).
		await reset();
		await browser.executeObsidian(async ({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			if (!leaf) throw new Error('no n1');
			const file = app.vault.getFileByPath('L5 link source.md') ?? (await app.vault.create('L5 link source.md', 'Go to [[Inbox]] here.\n'));
			await leaf.openFile(file, { state: { mode: 'preview' } });
			const w = window as Window & { e2eDedupe?: (evt: MouseEvent) => void };
			w.e2eDedupe = (evt: MouseEvent) => {
				const a = (evt.target as HTMLElement | null)?.closest('a.internal-link');
				if (!a) return;
				const target = app.metadataCache.getFirstLinkpathDest(a.getAttribute('data-href') ?? '', 'L5 link source.md');
				const existing = app.workspace.getLeavesOfType('markdown').find((l) => (l.view as unknown as { file?: { path: string } }).file?.path === target?.path);
				if (!existing) return;
				evt.preventDefault();
				evt.stopPropagation();
				app.workspace.setActiveLeaf(existing, { focus: true });
			};
			document.addEventListener('click', w.e2eDedupe, true);
		}, ids.n1);
		await waitForState((x) => mainStrip(x).files[0] === 'L5 link source.md', 'link source shown');
		await browser.pause(300);
		const link = await browser.execute(() => {
			const a = document.querySelector('.mod-root .workspace-leaf.mod-active .markdown-preview-view a.internal-link');
			a?.setAttribute('data-e2e-link', '1');
			return a?.getAttribute('data-href') ?? null;
		});
		expect(link).toBe('Inbox');
		try {
			// Inbox.md is n5, a hidden member.
			await $('[data-e2e-link="1"]').click();
			await expectExpandedWith('link-click (existing tab)', ids.n5);
		} finally {
			await browser.execute(() => {
				const w = window as Window & { e2eDedupe?: (evt: MouseEvent) => void };
				if (w.e2eDedupe) document.removeEventListener('click', w.e2eDedupe, true);
				document.querySelector('[data-e2e-link]')?.removeAttribute('data-e2e-link');
			});
			// Back to editing view: openNotes reuses this tab, and a reading view shows page previews
			// of links under a resting pointer, which can cover the strip in later cases.
			await browser.executeObsidian(async ({ app }, id) => {
				const leaf = app.workspace.getLeafById(id);
				if (!leaf) return;
				const vs = leaf.getViewState();
				await leaf.setViewState({ ...vs, state: { ...(vs.state ?? {}), mode: 'source' } });
			}, ids.n1);
		}

		// 6. setActiveLeaf from other code (also what a dedupe plugin does without a click).
		await reset();
		await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			if (leaf) app.workspace.setActiveLeaf(leaf, { focus: true });
		}, ids.n5);
		await expectExpandedWith('setActiveLeaf', ids.n5);

		// 7. revealLeaf from other code in the focused strip.
		await reset();
		await browser.executeObsidian(async ({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			if (leaf) await app.workspace.revealLeaf(leaf);
		}, ids.n4);
		await expectExpandedWith('revealLeaf', ids.n4, false);

		// 8. revealLeaf on a hidden tab of a strip WITHOUT the focus: no active-leaf-change, no
		// layout-change; only the workspace's resize event follows.
		await reset();
		const right = await splitWithNotes(ids.n6, [NOTES.n7, NOTES.n8, NOTES.n9]);
		const [r1, r2, r3] = right;
		if (!r1 || !r2 || !r3) throw new Error('split');
		const gR = await makeGroup([r1, r2], 'Right pane');
		await setActive(r3);
		await setCollapsedVia(gR, true);
		await setActive(ids.n1);
		let s = await pageState();
		const passesBefore = s.stats.passes;
		await browser.executeObsidian(async ({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			if (leaf) await app.workspace.revealLeaf(leaf);
		}, r2);
		s = await waitForState((x) => collapsed(x, gR) === false && stripOf(x, r2).currentId === r2, 'revealLeaf in the other strip: expanded');
		expect(s.activeId).toBe(ids.n1);
		const resizePasses = s.stats.timings.filter((t) => t.triggers.includes('resize')).length;
		expect(resizePasses).toBeGreaterThan(0);
		await expectNoHiddenShown('revealLeaf other strip');
		results['revealLeaf other strip'] = { active: s.activeId, current: stripOf(s, r2).currentId, passes: s.stats.passes - passesBefore, resizePasses };
		expect(s.stats.loopStops).toBe(0);
		record('C3', results);
	});

	// ------------------------------------------------------------------ C4

	it('C4 "Go to next / previous tab (skip collapsed groups)": skip hidden tabs, wrap around, pinned and ungrouped tabs count', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
		await setPinned(ids.n1, true);
		await waitForState((x) => mainStrip(x).pinned[0] === true, 'n1 pinned');
		const gA = await makeGroup([ids.n3, ids.n4], 'A 折');
		const gB = await makeGroup([ids.n6, ids.n7], 'B 开');
		const gC = await makeGroup([ids.n8], '');
		await setActive(ids.n2);
		await setCollapsedVia(gA, true);
		await setCollapsedVia(gC, true);
		let s = await pageState();
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6, ids.n7, ids.n8, ids.n9]);
		const forward: string[] = [];
		for (let i = 0; i < 7; i++) {
			expect(await commandAvailable(CMD.next)).toBe(true);
			const from = s.activeId;
			expect(await runCommand(CMD.next)).toBe(true);
			s = await waitForState((x) => x.activeId !== from, `next ${String(i)}`);
			forward.push(s.activeId ?? '');
			await expectNoHiddenShown(`next ${String(i)}`);
		}
		// n2 → n5 (skips A) → n6 → n7 → n9 (skips C) → n1 (wraps, pinned) → n2 → n5.
		expect(forward).toEqual([ids.n5, ids.n6, ids.n7, ids.n9, ids.n1, ids.n2, ids.n5]);
		const backward: string[] = [];
		for (let i = 0; i < 7; i++) {
			expect(await commandAvailable(CMD.prev)).toBe(true);
			const from = s.activeId;
			expect(await runCommand(CMD.prev)).toBe(true);
			s = await waitForState((x) => x.activeId !== from, `prev ${String(i)}`);
			backward.push(s.activeId ?? '');
			await expectNoHiddenShown(`prev ${String(i)}`);
		}
		expect(backward).toEqual([ids.n2, ids.n1, ids.n9, ids.n7, ids.n6, ids.n5, ids.n2]);
		expect(collapsed(s, gA)).toBe(true);
		expect(collapsed(s, gC)).toBe(true);
		expect(collapsed(s, gB)).toBe(false);
		// The native command still lands on hidden tabs; the group then expands (C3).
		await setActive(ids.n2);
		expect(await runCommand('workspace:next-tab')).toBe(true);
		s = await waitForState((x) => x.activeId === ids.n3 && collapsed(x, gA) === false, 'native next lands on n3, A expands');
		await expectNoHiddenShown('native next');
		// Not available for a sidebar leaf (like the other group commands).
		await browser.executeObsidian(({ app }) => {
			app.workspace.leftSplit.expand();
			const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
			if (leaf) app.workspace.setActiveLeaf(leaf, { focus: true });
		});
		await browser.pause(300);
		const sidebar = { next: await commandAvailable(CMD.next), prev: await commandAvailable(CMD.prev), toggle: await commandAvailable(CMD.toggle) };
		expect(sidebar).toEqual({ next: false, prev: false, toggle: false });
		await browser.executeObsidian(({ app }) => {
			app.workspace.leftSplit.collapse();
		});
		await setPinned(ids.n1, false);
		record('C4', { forward, backward, sidebar });
	});

	// ------------------------------------------------------------------ C5

	it('C5 chip menu "Collapse other groups"; Enter / Space on the focused chip; command "Collapse/expand current group"', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
		const gA = await makeGroup([ids.n2, ids.n3], 'Keep 留');
		const gB = await makeGroup([ids.n4, ids.n5], 'Other 一');
		const gC = await makeGroup([ids.n6], '');
		await setActive(ids.n5);
		await waitForState((x) => x.chips.length === 3, 'three chips');

		// Real right click on A's chip, real click on the item.
		await $(chipSel(gA)).click({ button: 'right' });
		const titles = await waitForMenu();
		expect(titles[titles.length - 1]).toBe('Collapse other groups');
		const menuShot = await shot('c5-1-chip-menu-collapse-others', 'L5');
		await clickMenuItem('Collapse other groups');
		let s = await waitForState((x) => collapsed(x, gB) === true && collapsed(x, gC) === true, 'others collapsed');
		expect(collapsed(s, gA)).toBe(false);
		// The active n5 was in B: the nearest visible tab to the right is n7 (C is collapsed).
		expect(s.activeId).toBe(ids.n7);
		await expectNoHiddenShown('collapse others');
		// Again: every other group is collapsed already, so the item is disabled.
		await $(chipSel(gA)).click({ button: 'right' });
		await waitForMenu();
		const disabled = await browser.execute(() => {
			const item = Array.from(document.querySelectorAll('.menu .menu-item')).find((i) => (i.querySelector('.menu-item-title')?.textContent ?? '').trim() === 'Collapse other groups');
			return item ? item.classList.contains('is-disabled') : null;
		});
		expect(disabled).toBe(true);
		await closeMenus();

		// Keyboard: focus B's chip, Enter expands, Space collapses again (aria-expanded follows).
		await browser.execute((sel) => {
			activeDocument.querySelector<HTMLElement>(sel)?.focus();
		}, chipSel(gB));
		expect((await focusInfo()).chipGroup).toBe(gB);
		await browser.keys(Key.Enter);
		s = await waitForState((x) => collapsed(x, gB) === false, 'Enter expands B');
		expect((await chipFact(gB))?.ariaExpanded).toBe('true');
		expect((await focusInfo()).chipGroup).toBe(gB);
		await browser.keys(Key.Space);
		s = await waitForState((x) => collapsed(x, gB) === true, 'Space collapses B');
		expect((await chipFact(gB))?.ariaExpanded).toBe('false');
		await expectNoHiddenShown('keyboard');

		// Enter inside the editor bubble (opened from the focused chip's keyboard menu) saves the
		// name and does not toggle the group, also when the focus goes back to the chip.
		await browser.keys([Key.Shift, Key.F10]);
		await waitForMenu();
		await clickMenuItem('Rename group');
		s = await waitForState((x) => x.editor.open && x.editor.inputFocused, 'bubble');
		await browser.keys(['键盘 Keys', Key.Enter]);
		s = await waitForState((x) => !x.editor.open && x.state.groups.some((g) => g.id === gB && g.name === '键盘 Keys'), 'renamed');
		await browser.pause(200);
		s = await pageState();
		expect(collapsed(s, gB)).toBe(true);
		expect((await focusInfo()).chipGroup).toBe(gB);

		// Review round 2 (keyboard-toggle-moves-focus-into-note): Enter / Space on the chip of the
		// group that holds the active tab. Collapsing shows the right neighbour (n7, B and C are
		// collapsed), but the keyboard focus stays on the chip: the next key toggles again and
		// types nothing into the note.
		await setActive(ids.n2);
		await browser.execute((sel) => {
			activeDocument.querySelector<HTMLElement>(sel)?.focus();
		}, chipSel(gA));
		expect((await focusInfo()).chipGroup).toBe(gA);
		const textBefore = await noteText(ids.n7);
		const keyboardSteps: unknown[] = [];
		for (const [i, key] of [Key.Enter, Key.Space, Key.Enter, Key.Space].entries()) {
			const collapse = i % 2 === 0;
			await browser.keys(key);
			s = await waitForState((x) => collapsed(x, gA) === collapse, `key ${String(i)} ${collapse ? 'collapses' : 'expands'} the active group A`);
			// Let any deferred focus change (Obsidian focusing the shown view) happen first.
			await browser.pause(300);
			const f = await focusInfo();
			const step = { i, collapse, active: s.activeId, chip: f.chipGroup, inView: f.inActiveView, desc: f.desc, aria: (await chipFact(gA))?.ariaExpanded ?? null };
			keyboardSteps.push(step);
			expect(step).toEqual({ i, collapse, active: collapse ? ids.n7 : step.active, chip: gA, inView: false, desc: step.desc, aria: collapse ? 'false' : 'true' });
			await expectNoHiddenShown(`keyboard on the active group, step ${String(i)}`);
		}
		expect(await noteText(ids.n7)).toBe(textBefore);

		// Command on the active tab's group: A holds n2 → collapsing shows the right neighbour.
		await setActive(ids.n2);
		expect(await commandAvailable(CMD.toggle)).toBe(true);
		expect(await runCommand(CMD.toggle)).toBe(true);
		s = await waitForState((x) => collapsed(x, gA) === true, 'command collapses A');
		// Right of A: B (n4, n5) and C (n6) are collapsed, so n7.
		expect(s.activeId).toBe(ids.n7);
		await expectNoHiddenShown('command');
		// n7 is not in a group: the command is not available.
		expect(await commandAvailable(CMD.toggle)).toBe(false);
		record('C5', { titles, disabled, menuShot, keyboardSteps });
	});

	// ------------------------------------------------------------------ C6

	it('C6 a new tab that lands next to or inside a collapsed group ends up after it, ungrouped and visible', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const gid = await makeGroup([ids.n2, ids.n3, ids.n4], 'New 新');
		await setActive(ids.n1);
		await setCollapsedVia(gid, true);
		const out: Record<string, unknown> = {};

		// (a) Public createLeafInParent right in the middle of the collapsed group.
		const inside = await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			if (!leaf) throw new Error('no n3');
			const tabs = leaf.parent as unknown as { children: unknown[] } & import('obsidian').WorkspaceSplit;
			const created = app.workspace.createLeafInParent(tabs, tabs.children.indexOf(leaf) + 1);
			return (created as unknown as { id: string }).id;
		}, ids.n3);
		let s = await waitForState((x) => mainStrip(x).leafIds.indexOf(inside) === 4, 'pushed after the group');
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, inside, ids.n5]);
		expect(groupOf(s, inside)).toBeNull();
		expect(collapsed(s, gid)).toBe(true);
		expect(s.activeId).toBe(inside);
		await expectNoHiddenShown('inside');
		out['inside'] = mainStrip(s).leafIds;

		// (b) Native new tab (Cmd+T) with the active tab right before the collapsed group: it lands
		// between the tab and the chip, at the group's start edge, and stays out of the group.
		await setActive(ids.n1);
		expect(await runCommand('workspace:new-tab')).toBe(true);
		s = await waitForState((x) => mainStrip(x).leafIds.length === 7, 'native new tab');
		const nt = s.activeId ?? '';
		expect(groupOf(s, nt)).toBeNull();
		expect(collapsed(s, gid)).toBe(true);
		const ntIndex = mainStrip(s).leafIds.indexOf(nt);
		const memberIdx = membersInOrder(s, gid).map((id) => mainStrip(s).leafIds.indexOf(id));
		expect(ntIndex < Math.min(...memberIdx) || ntIndex > Math.max(...memberIdx)).toBe(true);
		expectContiguous(s, gid);
		await expectNoHiddenShown('native new tab');
		out['nativeNextTo'] = { order: mainStrip(s).leafIds, created: nt };

		// (c) Collapse the group with the active tab (activation moves right), then a native new tab:
		// wherever Obsidian puts it, it is not hidden and not a member.
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.detach();
		}, nt);
		await setCollapsedVia(gid, false);
		await setActive(ids.n3);
		await clickChip(gid);
		s = await waitForState((x) => collapsed(x, gid) === true, 'collapsed with the active tab');
		const shownAfter = s.activeId;
		expect(await runCommand('workspace:new-tab')).toBe(true);
		s = await waitForState((x) => x.activeId !== shownAfter && mainStrip(x).leafIds.length === 7, 'new tab after collapsing the active group');
		const nt2 = s.activeId ?? '';
		expect(groupOf(s, nt2)).toBeNull();
		expectContiguous(s, gid);
		const order = mainStrip(s).leafIds;
		const idx = membersInOrder(s, gid).map((id) => order.indexOf(id));
		expect(order.indexOf(nt2) > Math.max(...idx) || order.indexOf(nt2) < Math.min(...idx)).toBe(true);
		await expectNoHiddenShown('new tab after collapsing');
		out['afterCollapse'] = { order, created: nt2, shownAfter };
		const shotC6 = await shot('c6-1-new-tab-after-collapsed', 'L5');

		// (d) Adding the active tab to a collapsed group (tab menu, real clicks) expands it.
		await $(titleSel(nt2)).click({ button: 'right' });
		await waitForMenu();
		await clickMenuItem('Add tab to group: New 新');
		s = await waitForState((x) => groupOf(x, nt2) === gid, 'active tab joined');
		expect(collapsed(s, gid)).toBe(false);
		expect(s.activeId).toBe(nt2);
		expectDecorated(s, gid);
		await expectNoHiddenShown('add active to collapsed');
		// A tab that is not the active one joins and is hidden with the group.
		await setCollapsedVia(gid, true);
		s = await pageState();
		const outsider = mainStrip(s).leafIds.find((id) => groupOf(s, id) === null && id !== s.activeId && !mainStrip(s).pinned[mainStrip(s).leafIds.indexOf(id)]);
		if (!outsider) throw new Error('no outsider');
		await $(titleSel(outsider)).click({ button: 'right' });
		await waitForMenu();
		await clickMenuItem('Add tab to group: New 新');
		s = await waitForState((x) => groupOf(x, outsider) === gid, 'other tab joined');
		expect(collapsed(s, gid)).toBe(true);
		expect((await headerFacts([outsider]))[outsider]?.width).toBe(0);
		await expectNoHiddenShown('add other to collapsed');
		record('C6', { ...out, shot: shotC6 });
	});

	// ------------------------------------------------------------------ C7

	it('C7 stacked tabs: no collapse (command shows a notice), collapsed groups show their tabs, no errors', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const gid = await makeGroup([ids.n2, ids.n3], 'Stack 叠');
		const other = await makeGroup([ids.n4], 'Was collapsed');
		await setActive(ids.n1);
		await setCollapsedVia(other, true);
		expect(await runCommand('workspace:toggle-stacked-tabs')).toBe(true);
		let s = await waitForState((x) => mainStrip(x).stacked, 'stacked');
		// The collapsed group's tab shows in the stack; nothing is hidden there.
		const h = await headerFacts([ids.n2, ids.n3, ids.n4]);
		for (const id of [ids.n2, ids.n3, ids.n4]) {
			expect(h[id]?.collapsedClass).toBe(false);
			expect(h[id]?.visibility).toBe('visible');
		}
		const chip = await chipFact(gid);
		expect(chip?.display).toBe('none');
		// The command on a group in the stacked strip: a notice, no change.
		await setActive(ids.n2);
		expect(await commandAvailable(CMD.toggle)).toBe(true);
		expect(await runCommand(CMD.toggle)).toBe(true);
		s = await waitForState((x) => x.stats.notices.includes('Groups cannot be collapsed in stacked tabs'), 'notice');
		expect(collapsed(s, gid)).toBe(false);
		expect(s.activeId).toBe(ids.n2);
		const stackedShot = await shot('c7-1-stacked', 'L5');
		// Showing a stacked member of the "collapsed" group is fine there; back to normal tabs the
		// group hides again unless its tab is the shown one, which expands it.
		await setActive(ids.n4);
		expect(await runCommand('workspace:toggle-stacked-tabs')).toBe(true);
		s = await waitForState((x) => !mainStrip(x).stacked, 'unstacked');
		expect(collapsed(s, other)).toBe(false);
		await expectNoHiddenShown('unstacked');
		await setActive(ids.n1);
		await setCollapsedVia(other, true);
		expect(await errorTimeline()).toEqual([]);
		record('C7', { notices: s.stats.notices.slice(-2), chip, stackedShot });
	});

	// ------------------------------------------------------------------ C8

	it('C8 pop-out window: collapse and expand there; closing it with a collapsed group gives no error', async function () {
		const { result: pop, warm } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n7, NOTES.n8, NOTES.n9]));
		const [p1, p2, p3] = pop;
		if (!p1 || !p2 || !p3) throw new Error('pop-out leaves');
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 3), 'pop-out ready');
		const gid = await makeGroup([p1, p2], 'Popout 弹出');
		await setActive(p3);
		await waitForState((x) => x.chips.some((c) => c.groupId === gid), 'chip in the pop-out');
		const main = await browser.getWindowHandle();
		let popHandle: string | null = null;
		for (const h of await browser.getWindowHandles()) {
			if (h === main) continue;
			await browser.switchToWindow(h);
			if (await browser.execute((sel) => document.querySelector(sel) !== null, chipSel(gid))) {
				popHandle = h;
				break;
			}
		}
		await browser.switchToWindow(main);
		if (popHandle === null) throw new Error('no pop-out handle');
		let s: PageState;
		let shots: string[] = [];
		try {
			await browser.switchToWindow(popHandle);
			await $(chipSel(gid)).click();
			await browser.switchToWindow(main);
			s = await waitForState((x) => collapsed(x, gid) === true, 'collapsed in the pop-out');
			const h = await headerFacts([p1, p2, p3]);
			expect(h[p1]?.width).toBe(0);
			expect(h[p2]?.width).toBe(0);
			expect(h[p1]?.visibility).toBe('hidden');
			const chip = await chipFact(gid);
			expect(chip).toMatchObject({ doc: 'popout', visibility: 'visible', ariaExpanded: 'false', hit: true });
			await expectNoHiddenShown('pop-out collapsed');
			await browser.switchToWindow(popHandle);
			shots.push(await shot('c8-1-popout-collapsed', 'L5'));
			await $(chipSel(gid)).click();
			await browser.switchToWindow(main);
			s = await waitForState((x) => collapsed(x, gid) === false, 'expanded in the pop-out');
			expectDecorated(s, gid);
			// Collapse the group with the pop-out's shown tab: the pop-out shows p3.
			await setActive(p1);
			await browser.switchToWindow(popHandle);
			await $(chipSel(gid)).click();
			await browser.switchToWindow(main);
			s = await waitForState((x) => collapsed(x, gid) === true, 'collapsed again, with the shown tab');
			expect(s.activeId).toBe(p3);
			await expectNoHiddenShown('pop-out shown tab');
			record('C8-chip', chip);
		} finally {
			await browser.switchToWindow(main);
		}
		// Close the pop-out with the group collapsed.
		await closePopout(p3);
		s = await waitForState((x) => !x.strips.some((st) => st.kind === 'popout'), 'pop-out closed');
		await browser.pause(500);
		expect(s.state.groups.some((g) => g.id === gid)).toBe(false);
		const closes = await popoutCloseReports();
		expect(closes[closes.length - 1]?.pluginOwned).toBe(0);
		expect((await strandedObservations(false)).plugin).toBe(0);
		expect(await errorTimeline()).toEqual([]);
		record('C8', { warm, close: closes[closes.length - 1], shots });
		shots = [];
	});

	// ------------------------------------------------------------------ C9

	it('C9 "Restore native tab bar" and disabling with collapsed groups: every tab shows at once, no trace; back again works', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const gid = await makeGroup([ids.n2, ids.n3], 'Native 原生');
		const g2 = await makeGroup([ids.n4], '');
		await setActive(ids.n1);
		await setCollapsedVia(gid, true);
		await setCollapsedVia(g2, true);
		const all = [ids.n1, ids.n2, ids.n3, ids.n4, ids.n5];
		const visibleAll = async (what: string) => {
			const h = await headerFacts(all);
			for (const id of all) {
				const f = h[id];
				const where = `${what} ${id} ${JSON.stringify(f)}`;
				expect({ where, ok: f !== undefined && f.width > 20 && f.visibility === 'visible' && !f.collapsedClass }).toEqual({ where, ok: true });
			}
		};
		expect(await runCommand(CMD.restore)).toBe(true);
		await browser.pause(100);
		expect(await residue()).toEqual({ docs: 1, found: [] });
		await visibleAll('native');
		// Back: the groups show again, expanded (restoring the native bar expanded them, step L5 choice).
		expect(await runCommand(CMD.show)).toBe(true);
		let s = await waitForState((x) => x.chips.length === 2 && x.chips.some((c) => c.groupId === gid), 'groups shown again');
		expect(collapsed(s, gid)).toBe(false);
		expect(collapsed(s, g2)).toBe(false);
		expectDecorated(s, gid);
		// Collapse works again, then disable the plugin with collapsed groups.
		await clickChip(gid);
		await waitForState((x) => collapsed(x, gid) === true, 'collapsed again');
		await setCollapsedVia(g2, true);
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins.disablePlugin('tabstrip');
		});
		expect(await residue()).toEqual({ docs: 1, found: [] });
		await visibleAll('disabled');
		const disabledShot = await shot('c9-1-disabled-all-visible', 'L5');
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { enablePlugin(id: string): Promise<boolean> } }).plugins.enablePlugin('tabstrip');
		});
		await browser.pause(500);
		// Step L6: enabling again restores the groups saved when the plugin was disabled (collapsed
		// unless they hold the shown tab), and no shown tab is hidden.
		s = await waitForState((x) => x.state.groups.length === 2, 'groups restored after enabling');
		expect(s.state.groups.map((g) => g.id).sort()).toEqual([gid, g2].sort());
		await expectNoHiddenShown('restored after enabling');
		await setActive(ids.n2);
		expect(await runCommand(CMD.add)).toBe(true);
		s = await waitForState((x) => x.state.groups.length === 3 && x.editor.open, 'a group again after enabling');
		await browser.keys(Key.Escape);
		s = await waitForState((x) => !x.editor.open, 'bubble closed');
		const g3 = s.state.groups.find((g) => g.id !== gid && g.id !== g2)?.id ?? '';
		await setActive(ids.n1);
		await clickChip(g3);
		s = await waitForState((x) => collapsed(x, g3) === true, 'collapse works after enabling');
		expect((await headerFacts([ids.n2]))[ids.n2]?.width).toBe(0);
		await expectNoHiddenShown('after enabling');
		expect(await errorTimeline()).toEqual([]);
		record('C9', { disabledShot });
	});

	// ------------------------------------------------------------------ C10

	it('C10 collapsed headers keep sane boxes for native drop positions (start, middle, end of the strip)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
		const start = await makeGroup([ids.n1, ids.n2], 'Start');
		const middle = await makeGroup([ids.n4], 'Middle');
		const end = await makeGroup([ids.n6, ids.n7], 'End');
		await setActive(ids.n3);
		for (const g of [start, middle, end]) await setCollapsedVia(g, true);
		await setActive(ids.n5);
		const all = [ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6, ids.n7];
		const h = await headerFacts(all);
		const out: Record<string, unknown> = {};
		let lastRight = -Infinity;
		for (const id of all) {
			const f = h[id];
			if (!f?.strip) throw new Error(`no header facts for ${id}`);
			const hidden = id !== ids.n3 && id !== ids.n5;
			const where = JSON.stringify({ id, f });
			// A real box at its place in the strip: inside the strip, in tab order, as tall as a tab.
			expect({ where, inStrip: f.left >= f.strip.left - 0.5 && f.right <= f.strip.right + 0.5, ordered: f.left >= lastRight - 0.5, tall: f.height > 10, notNone: f.display !== 'none' }).toEqual({
				where,
				inStrip: true,
				ordered: true,
				tall: true,
				notNone: true,
			});
			if (hidden) expect({ where, width: f.width }).toEqual({ where, width: 0 });
			else expect(f.width).toBeGreaterThan(20);
			lastRight = f.right;
			out[id] = { left: f.left, width: f.width, hidden };
		}
		// The chip of the group at the strip's start is not cut off by the strip's start.
		const startChip = await chipFact(start);
		expect(startChip?.rect.left).toBeGreaterThanOrEqual((h[ids.n1]?.strip?.left ?? 0) - 0.5);
		expect(startChip?.hit).toBe(true);
		const endChip = await chipFact(end);
		expect(endChip?.hit).toBe(true);
		const geometryShot = await shot('c10-1-start-middle-end-collapsed', 'L5');
		record('C10', { headers: out, startChip: startChip?.rect, endChip: endChip?.rect, geometryShot });
	});

	// ------------------------------------------------------------------ C12

	it('C12 look review: collapsed and expanded, named and unnamed, next to the active tab; dividers; chip menu; high contrast', async function () {
		this.timeout(240_000);
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
		await setPinned(ids.n1, true);
		await waitForState((x) => mainStrip(x).pinned[0] === true, 'pinned');
		const g = {
			research: await makeGroup([ids.n2, ids.n3], '研究 Research', 'blue'),
			dot: await makeGroup([ids.n5], '', 'green'),
			long: await makeGroup([ids.n7, ids.n8], '很长很长的中文组名用来测试省略号效果', 'purple'),
			work: await makeGroup([ids.n9], 'Work', 'orange'),
		};
		await setActive(ids.n4);
		await setUserLayout(true);
		// No notice over the strip during the pixel checks.
		await browser.waitUntil(async () => (await pageState()).notices.length === 0, { timeout: 8000, timeoutMsg: 'notices still shown' });
		const shots: Record<string, unknown> = {};
		for (const look of LOOKS) {
			const key = `${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`;
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			await setCollapsedVia(g.research, false);
			await setCollapsedVia(g.dot, false);
			await waitForState((x) => x.chips.length === 4, 'four chips');
			await browser.execute(() => document.fonts.ready);
			await browser.action('pointer').move({ x: 500, y: 500, duration: 0 }).perform();
			await browser.pause(400);
			const expanded = await shot(`look-${key}-expanded`, 'L5');
			// Research (named) and the dot group collapsed; the active n4 sits right after research's chip.
			await setCollapsedVia(g.research, true);
			await setCollapsedVia(g.dot, true);
			// Pointer over the note, so no tooltip from a chip shows in the review screenshots.
			await browser.action('pointer').move({ x: 500, y: 500, duration: 0 }).perform();
			await browser.pause(400);
			const collapsedShot = await shot(`look-${key}-collapsed`, 'L5');
			// Dividers: one before each chip, also for collapsed chips (Atom draws them at the tab's start).
			const div = await dividerPaint(`l5-divider-${key}`);
			const divFacts = div.groups.map((d) => ({ g: d.groupId, before: d.before, between: d.between, after: d.after, marked: d.marked, prevActive: d.previous?.active ?? null, nextActive: d.next?.active ?? null }));
			for (const d of div.groups) {
				const where = JSON.stringify({ key, d: { g: d.groupId, before: d.before, between: d.between, after: d.after, marked: d.marked, previous: d.previous, next: d.next } });
				// The theme hides the divider next to the active tab; otherwise there is one before the chip.
				if (d.previous && !d.previous.active) expect({ where, before: d.before > 0 }).toEqual({ where, before: true });
				// Review round 2 (atom-extra-divider-next-to-active): a collapsed chip right before the
				// active tab has no divider after it in any look (research is followed by the active n4).
				if (d.groupId === g.research) expect({ where, nextActive: d.next?.active ?? null }).toEqual({ where, nextActive: true });
				if (d.next?.active === true) expect({ where, after: d.after }).toEqual({ where, after: 0 });
			}
			// Underlines: the expanded groups unbroken, the collapsed groups none.
			const paint = await underlinePaint(`l5-underline-${key}`);
			for (const p of paint.groups) {
				const isCollapsed = p.groupId === g.research || p.groupId === g.dot;
				const where = JSON.stringify({ key, group: p.groupId, gaps: p.gaps, spill: [p.spillBefore, p.spillAfter], columns: p.columns });
				if (isCollapsed) {
					// From the chip's start to 30px past it (into the next tab): no underline colour.
					const chipLeft = p.from - 1;
					const band = paintedColumns(paint, p.groupId, chipLeft - 1, p.to + 30);
					expect({ where, matched: band.matched }).toEqual({ where, matched: 0 });
				} else {
					expect({ where, gaps: p.gaps, spill: [p.spillBefore, p.spillAfter] }).toEqual({ where, gaps: [], spill: [0, 0] });
				}
			}
			shots[key] = { expanded, collapsed: collapsedShot, dividers: divFacts };
		}
		// Chip menu with "Collapse other groups" (default light and Atom light).
		for (const theme of ['default', 'Atom'] as const) {
			await setLook(theme, false);
			await setUserLayout(true);
			await $(chipSel(g.long)).click({ button: 'right' });
			await waitForMenu();
			shots[`menu-${theme}`] = await shot(`menu-chip-collapse-others-${theme.toLowerCase()}-light`, 'L5');
			await closeMenus();
		}
		// High contrast (forced colours): collapsed chips stay visible and differ from expanded ones.
		await setLook('default', false);
		await setUserLayout(true);
		await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
		let hc: {
			forced: boolean;
			stripBg: string;
			chips: { gid: string; collapsed: boolean; unnamed: boolean; visible: string; width: number; borderStyle: string; borderWidth: number; borderColor: string; text: string; fill: string; dotBg: string | null; dotBorder: string | null; dotBorderWidth: number }[];
		};
		let hcShot = '';
		try {
			await browser.pause(400);
			hc = await browser.execute((gids) => {
				const probe = document.body.createDiv();
				probe.setCssStyles({ backgroundColor: 'rgb(255, 0, 0)' });
				const forced = getComputedStyle(probe).backgroundColor !== 'rgb(255, 0, 0)';
				probe.remove();
				const strip = document.querySelector('.workspace .mod-root .workspace-tab-header-container');
				return {
					forced,
					stripBg: strip ? getComputedStyle(strip).backgroundColor : '',
					chips: gids.map((gid) => {
						const chip = document.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
						if (!chip) throw new Error(`no chip ${gid}`);
						const cs = getComputedStyle(chip);
						const dot = chip.querySelector<HTMLElement>('.tabstrip-chip-dot');
						const unnamed = chip.classList.contains('is-unnamed');
						const ds = unnamed && dot ? getComputedStyle(dot) : null;
						return {
							gid,
							collapsed: chip.classList.contains('is-collapsed'),
							unnamed,
							visible: cs.visibility,
							width: chip.getBoundingClientRect().width,
							borderStyle: cs.borderTopStyle,
							borderWidth: parseFloat(cs.borderTopWidth),
							borderColor: cs.borderTopColor,
							text: cs.color,
							fill: cs.backgroundColor,
							dotBg: ds ? ds.backgroundColor : null,
							dotBorder: ds ? ds.borderTopColor : null,
							dotBorderWidth: ds ? parseFloat(ds.borderTopWidth) : 0,
						};
					}),
				};
			}, [g.research, g.dot, g.long, g.work]);
			hcShot = await shot('forced-colors-collapsed-default-light', 'L5');
		} finally {
			await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [] });
		}
		expect(hc.forced).toBe(true);
		const research = hc.chips.find((c) => c.gid === g.research);
		const dot = hc.chips.find((c) => c.gid === g.dot);
		const long = hc.chips.find((c) => c.gid === g.long);
		if (!research || !dot || !long) throw new Error('hc chips');
		expect(research).toMatchObject({ collapsed: true, visible: 'visible', borderStyle: 'dashed' });
		expect(research.borderWidth).toBeGreaterThanOrEqual(2);
		expect(contrastOf(research.borderColor, hc.stripBg)).toBeGreaterThanOrEqual(3);
		expect(contrastOf(research.text, research.fill === 'rgba(0, 0, 0, 0)' ? hc.stripBg : research.fill)).toBeGreaterThanOrEqual(4.5);
		expect(long).toMatchObject({ collapsed: false, borderStyle: 'solid' });
		expect(dot).toMatchObject({ collapsed: true, visible: 'visible' });
		expect(dot.dotBorderWidth).toBeGreaterThanOrEqual(2);
		expect(contrastOf(dot.dotBorder ?? '', hc.stripBg)).toBeGreaterThanOrEqual(3);
		expect(dot.dotBg).not.toBe(dot.dotBorder);
		expect(await browser.execute(() => matchMedia('(forced-colors: active)').matches)).toBe(false);
		await setUserLayout(false);
		await setPinned(ids.n1, false);
		record('C12', { shots, hc, hcShot });
	});

	// ------------------------------------------------------------------ C11

	it('C11 performance: collapse / expand a 20-tab group and switch across collapsed groups with ~150 tabs; no deferred tab loaded by the plugin', async function () {
		this.timeout(240_000);
		interface Timing {
			triggers: string[];
			ms: number;
			opsMs: number;
			ops: number;
			leaves: number;
		}
		const built = await browser.executeObsidian(async ({ app }, files) => {
			const hex = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
			const layout = app.workspace.getLayout();
			const tabs = Array.from({ length: 3 }, (_, k) => ({
				id: hex(),
				type: 'tabs',
				currentTab: 0,
				children: Array.from({ length: 50 }, (_, i) => ({
					id: hex(),
					type: 'leaf',
					state: {
						type: 'markdown',
						state: { file: files[(k * 50 + i) % files.length], mode: 'source', source: false },
						icon: 'lucide-file',
						title: (files[(k * 50 + i) % files.length] ?? '').replace(/^.*\//, '').replace(/\.md$/, ''),
					},
				})),
			}));
			await app.workspace.changeLayout({ ...layout, main: { id: hex(), type: 'split', direction: 'vertical', children: tabs }, active: tabs[0]?.children[0]?.id });
			await new Promise((r) => setTimeout(r, 800));
			const all: { id: string; deferred: boolean }[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				all.push({ id: (leaf as unknown as { id: string }).id, deferred: leaf.isDeferred });
			});
			return all;
		}, Object.values(NOTES));
		expect(built.length).toBe(150);
		const deferredAtStart = built.filter((l) => l.deferred).map((l) => l.id);

		const run = await browser.executeObsidian(async ({ app }) => {
			type Debug = {
				stats(): { timings: Timing[]; loopStops: number; passes: number };
				group(ids: string[], name: string, color?: string): string | null;
				setCollapsed(id: string, c: boolean): boolean;
				state(): { groups: { id: string; collapsed: boolean }[] };
				flush(): void;
			};
			const debug = (app as unknown as { plugins: { plugins: Record<string, { debug: Debug } | undefined> } }).plugins.plugins['tabstrip']?.debug;
			if (!debug) throw new Error('tabstrip not loaded');
			const commands = (app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands;
			type Tabs = { children: (import('obsidian').WorkspaceLeaf & { id: string })[]; currentTab: number };
			const strips: Tabs[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				const p = leaf.parent as unknown as Tabs;
				if (!strips.includes(p)) strips.push(p);
			});
			const shown = new Set<string>();
			const noteShown = () => {
				for (const t of strips) {
					const leaf = t.children[t.currentTab];
					if (leaf) shown.add(leaf.id);
				}
			};
			noteShown();
			const settle = async () => {
				await new Promise((r) => setTimeout(r, 40));
				debug.flush();
				noteShown();
			};
			// Strip 1: a 20-tab group (tabs 5–24) and two 5-tab groups; strips 2 and 3: 4 groups of 5.
			const s0 = strips[0];
			if (!s0) throw new Error('no strip');
			const big = debug.group(s0.children.slice(5, 25).map((l) => l.id), '二十 Twenty');
			const small = [debug.group(s0.children.slice(26, 31).map((l) => l.id), 'S1'), debug.group(s0.children.slice(32, 37).map((l) => l.id), 'S2')];
			for (const t of strips.slice(1)) for (let g = 0; g < 4; g++) debug.group(t.children.slice(5 + g * 10, 10 + g * 10).map((l) => l.id), `G${String(g)}`);
			await settle();
			if (big === null || small.includes(null)) throw new Error('groups');
			const first = debug.stats().timings.length;
			// 1. Collapse and expand the 20-tab group 10 times each (the active tab is outside it).
			app.workspace.setActiveLeaf(s0.children[0] as import('obsidian').WorkspaceLeaf, { focus: true });
			await settle();
			const toggleStart = debug.stats().timings.length;
			for (let i = 0; i < 10; i++) {
				debug.setCollapsed(big, true);
				await settle();
				debug.setCollapsed(big, false);
				await settle();
			}
			// 2. Collapse with the active tab inside (activation moves out), 5 times.
			for (let i = 0; i < 5; i++) {
				const inside = s0.children[10 + i];
				if (inside) app.workspace.setActiveLeaf(inside, { focus: true });
				await settle();
				debug.setCollapsed(big, true);
				await settle();
				debug.setCollapsed(big, false);
				await settle();
			}
			const toggleEnd = debug.stats().timings.length;
			// 3. Switch across collapsed groups: all three groups of strip 1 collapsed; the skip command
			// 20 times, and the native next tab 10 times from the tab before the 20-tab group (it lands
			// on a hidden tab and expands the group), collapsing it again each time.
			for (const id of [big, ...small]) if (id !== null) debug.setCollapsed(id, true);
			app.workspace.setActiveLeaf(s0.children[0] as import('obsidian').WorkspaceLeaf, { focus: true });
			await settle();
			const switchStart = debug.stats().timings.length;
			for (let i = 0; i < 20; i++) {
				commands.executeCommandById('tabstrip:next-tab-skip-collapsed');
				await settle();
			}
			for (let i = 0; i < 10; i++) {
				app.workspace.setActiveLeaf(s0.children[4] as import('obsidian').WorkspaceLeaf, { focus: true });
				await settle();
				commands.executeCommandById('workspace:next-tab');
				await settle();
				app.workspace.setActiveLeaf(s0.children[4] as import('obsidian').WorkspaceLeaf, { focus: true });
				await settle();
				debug.setCollapsed(big, true);
				await settle();
			}
			const all = debug.stats().timings;
			const deferredNow: string[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				if (leaf.isDeferred) deferredNow.push((leaf as unknown as { id: string }).id);
			});
			return {
				toggles: all.slice(toggleStart, toggleEnd),
				switches: all.slice(switchStart),
				first,
				deferredNow,
				shownByTest: [...shown],
				loopStops: debug.stats().loopStops,
				collapsedAtEnd: debug.state().groups.filter((g) => g.collapsed).length,
			};
		});
		const stat = (values: number[]) => {
			const sorted = [...values].sort((a, b) => a - b);
			const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
			return { n: sorted.length, median: Number(at(0.5).toFixed(3)), p95: Number(at(0.95).toFixed(3)), max: Number((sorted[sorted.length - 1] ?? NaN).toFixed(3)) };
		};
		const toggleRuns = run.toggles.filter((t) => t.triggers.includes('run'));
		const togglePasses = run.toggles.filter((t) => !t.triggers.includes('run'));
		const switchRuns = run.switches.filter((t) => t.triggers.includes('run'));
		const switchPasses = run.switches.filter((t) => !t.triggers.includes('run'));
		const shown = new Set(run.shownByTest);
		const stillDeferred = new Set(run.deferredNow);
		const loadedByPlugin = deferredAtStart.filter((id) => !shown.has(id) && !stillDeferred.has(id));
		// The plugin's own time: the run or pass minus the time inside Obsidian's API showing a tab
		// (showing a never-loaded tab builds its editor; the native commands pay the same).
		const own = (list: Timing[]) => list.map((t) => t.ms - t.opsMs);
		const result = {
			tabs: built.length,
			deferredAtStart: deferredAtStart.length,
			deferredAtEnd: run.deferredNow.length,
			shownByTest: run.shownByTest.length,
			loadedByPlugin,
			toggleCommand: stat(own(toggleRuns)),
			toggleFollowUpPasses: stat(own(togglePasses)),
			switchCommand: stat(own(switchRuns)),
			switchPasses: stat(own(switchPasses)),
			total: {
				toggleCommand: stat(toggleRuns.map((t) => t.ms)),
				switchCommand: stat(switchRuns.map((t) => t.ms)),
				obsidianShowingTabs: stat([...toggleRuns, ...switchRuns, ...togglePasses, ...switchPasses].filter((t) => t.opsMs > 0).map((t) => t.opsMs)),
			},
			triggers: [...new Set(run.switches.concat(run.toggles).flatMap((t) => t.triggers))],
			loopStops: run.loopStops,
		};
		record('C11', result);
		expect(toggleRuns.length).toBeGreaterThanOrEqual(30);
		expect(switchRuns.length).toBeGreaterThanOrEqual(20);
		for (const k of ['toggleCommand', 'toggleFollowUpPasses', 'switchCommand', 'switchPasses'] as const) {
			const v = result[k];
			expect({ k, median: v.median < 5, max: v.max < 50 }).toEqual({ k, median: true, max: true });
		}
		expect(loadedByPlugin).toEqual([]);
		expect(run.loopStops).toBe(0);
		await expectNoHiddenShown('C11 end');
	});

	it('no console errors or warnings during the whole run', async function () {
		const errors = await errorTimeline();
		record('console', { errors, popoutCloses: await popoutCloseReports() });
		expect(errors).toEqual([]);
		expect(await hiddenShown()).toEqual([]);
		expect((await pageState()).stats.loopStops).toBe(0);
	});
});
