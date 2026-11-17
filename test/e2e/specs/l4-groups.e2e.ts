/**
 * Step L4: group creation, chip, chip menu, tab menu and commands in the real plugin
 * (horizontal strip). Cases E1–E8 of the L4 brief; E9 is l4-perf, E11 is l4-look.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run).
 */
import { $, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import { GROUP_COLORS, type GroupColor } from '../../../src/core/types';
import { contrast, MIN_CONTRAST, parseCssColor, pickInk } from '../../../src/ui/color';
import { expectedFillCss, TARGET_INK } from '../palette';
import {
	brief,
	bubbleGeometry,
	chipSel,
	clickMenuItem,
	closePopout,
	commandAvailable,
	closeMenus,
	errorTimeline,
	expectContiguous,
	expectContinuousLine,
	expectBubblePlaced,
	expectDecorated,
	focusInfo,
	groupOf,
	headerSel,
	mainStrip,
	makeGroup,
	membersInOrder,
	openNotes,
	openPopoutLeafWithNotes,
	openPopoutWithNotes,
	pageState,
	popoutCloseReports,
	readErrors,
	RO_LOOP_MESSAGE,
	residue,
	record,
	runCommand,
	setActive,
	setLook,
	setPinned,
	setPopoutCleanup,
	shot,
	startErrorWatch,
	strandedObservations,
	stripOf,
	titleSel,
	waitForMenu,
	waitForState,
	warmUpPopouts,
	windowHandleWith,
	withWarmPopout,
	writeEvidence,
	type PageState,
} from '../helpers';

const CMD = {
	add: 'tabstrip:add-to-new-group',
	remove: 'tabstrip:remove-from-group',
	rename: 'tabstrip:rename-group',
} as const;

const COLOR_NAMES: Record<GroupColor, string> = {
	grey: 'Grey',
	blue: 'Blue',
	red: 'Red',
	yellow: 'Yellow',
	green: 'Green',
	pink: 'Pink',
	purple: 'Purple',
	cyan: 'Cyan',
	orange: 'Orange',
};

function onlyGroup(s: PageState, name?: string) {
	const groups = name === undefined ? s.state.groups : s.state.groups.filter((g) => g.name === name);
	expect(groups).toHaveLength(1);
	const g = groups[0];
	if (!g) throw new Error('no group');
	return g;
}

/**
 * Computed fill of each group colour in the main window: the intended palette expression (the
 * Obsidian variable mixed towards black or white, test/e2e/palette.ts) for the current mode.
 */
async function expectedFills(): Promise<Record<string, string>> {
	const dark = await browser.execute(() => activeDocument.body.classList.contains('theme-dark'));
	const css = Object.fromEntries(GROUP_COLORS.map((c) => [c, expectedFillCss(c, dark ? 'dark' : 'light')]));
	return browser.execute((list) => {
		const out: Record<string, string> = {};
		for (const [c, value] of Object.entries(list)) {
			const probe = activeDocument.body.createDiv();
			probe.setCssProps({ 'background-color': value });
			out[c] = getComputedStyle(probe).backgroundColor;
			probe.remove();
		}
		return out;
	}, css);
}

function contrastOf(text: string, fill: string): number {
	const a = parseCssColor(text);
	const b = parseCssColor(fill);
	if (a === null || b === null) throw new Error(`unparsable colour ${text} / ${fill}`);
	return contrast(a, b);
}

describe('L4 groups on the horizontal tab strip', function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			// Like the user: DOM menus, light base theme, links updated on rename without asking.
			vault.setConfig('nativeMenus', false);
			vault.setConfig('theme', 'moonstone');
			vault.setConfig('alwaysUpdateLinks', true);
			await vault.saveConfig();
		});
		await startErrorWatch();
		// The session's first pop-out, out of the way before any case (close-out round 2): later
		// pop-outs are opened the way users open them (openPopoutLeaf, "Move to new window").
		const warmUp = await warmUpPopouts();
		const s = await pageState();
		record('setup', {
			warmUp,
			obsidian: browser.getObsidianVersion(),
			installer: browser.getObsidianInstallerVersion(),
			docFocused: s.docFocused,
			features: await browser.executeObsidian(({ app }) => {
				const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { features(): unknown; capabilities(): unknown; missingFeatures(): string[] } }> } }).plugins.plugins['tabstrip'];
				return { features: p?.debug.features(), capabilities: p?.debug.capabilities(), missing: p?.debug.missingFeatures() };
			}),
		});
	});

	after(function () {
		writeEvidence('l4-groups');
	});

	// ------------------------------------------------------------------ E1

	it('E1 tab menu "Add tab to new group": grey group, chip, editor bubble; Chinese name + Enter; Escape cancels', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		await setActive(ids.n1);
		await pageState();

		await $(titleSel(ids.n2)).click({ button: 'right' });
		const titles = await waitForMenu();
		expect(titles).toContain('Add tab to new group');
		expect(titles).toContain('Close');
		expect(titles.filter((t) => t.startsWith('Add tab to group:'))).toEqual([]);
		expect(titles).not.toContain('Remove from group');
		// Our items sit in the tab menu's 'pane' section, before Obsidian's own Pin item.
		if (titles.includes('Pin')) expect(titles.indexOf('Add tab to new group')).toBeLessThan(titles.indexOf('Pin'));
		await clickMenuItem('Add tab to new group');

		let s = await waitForState((x) => x.state.groups.length === 1 && x.editor.open, 'group created, bubble open');
		const g = onlyGroup(s);
		expect(g.color).toBe('grey');
		expect(g.name).toBe('');
		expect(membersInOrder(s, g.id)).toEqual([ids.n2]);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5]);
		expectDecorated(s, g.id);
		const created = s.chips.find((c) => c.groupId === g.id);
		expect(created?.unnamed).toBe(true);
		expect(s.editor).toEqual({ open: true, groupId: g.id, inputFocused: true, value: '', doc: 'main' });
		// Under the strip, so the group's underline stays visible while editing (close-out round 1).
		const createdAt = await bubbleGeometry(g.id);
		expectBubblePlaced(createdAt);
		const created1 = await shot('e1-1-created-bubble');

		await browser.keys('研究 Research');
		s = await waitForState((x) => x.editor.value === '研究 Research', 'name typed');
		// Live preview on the chip while typing.
		expect(onlyGroup(s).name).toBe('研究 Research');
		expectBubblePlaced(await bubbleGeometry(g.id));
		await browser.keys(Key.Enter);
		s = await waitForState((x) => !x.editor.open, 'bubble closed by Enter');
		expect(onlyGroup(s).name).toBe('研究 Research');
		// The keyboard focus goes back to the note, not to the page body (close-out round 1).
		const focusAfterEnter = await focusInfo();
		expect(focusAfterEnter).toMatchObject({ body: false, inActiveView: true });
		const chip = s.chips.find((c) => c.groupId === g.id);
		expect(chip?.text).toBe('研究 Research');
		expect(chip?.unnamed).toBe(false);
		expect(chip?.role).toBe('button');
		expect(chip?.tabindex).toBe('0');
		expect(chip?.ariaLabel).toBe('研究 Research, 1 tab');
		expect(chip?.hostPosition).toBe('relative');
		expect(chip?.appRegion).toBe('no-drag');
		expectDecorated(s, g.id);
		const named = await shot('e1-2-named');

		// Escape path: Rename group from the chip menu, type, Escape → unchanged.
		await $(chipSel(g.id)).click({ button: 'right' });
		const chipTitles = await waitForMenu();
		expect(chipTitles).toContain('Rename group');
		await clickMenuItem('Rename group');
		s = await waitForState((x) => x.editor.open && x.editor.inputFocused, 'bubble open again');
		expect(s.editor.value).toBe('研究 Research');
		await browser.keys('临时名字');
		s = await waitForState((x) => onlyGroup(x).name === '临时名字', 'preview of second edit');
		await browser.keys(Key.Escape);
		s = await waitForState((x) => !x.editor.open, 'bubble closed by Escape');
		expect(onlyGroup(s).name).toBe('研究 Research');
		expect(s.chips.find((c) => c.groupId === g.id)?.text).toBe('研究 Research');
		// The right click focused the chip, so the focus goes back to the chip (the element that opened the bubble).
		const focusAfterEscape = await focusInfo();
		expect(focusAfterEscape).toMatchObject({ body: false, chipGroup: g.id });
		record('E1', { ids, tabMenu: titles, chipMenu: chipTitles, group: onlyGroup(s), chip, bubble: createdAt, focusAfterEnter, focusAfterEscape, screenshots: [created1, named] });
	});

	// ------------------------------------------------------------------ E1 (close-out round 2)

	it('E1 bubble: a swatch click recolours chip and underline at once, Escape restores the colour; a click outside commits name and colour', async function () {
		let s = await pageState();
		const target = mainStrip(s).leafIds[3];
		if (!target || groupOf(s, target) !== null) throw new Error('expected an ungrouped fourth tab from E1');
		const fills = await expectedFills();
		/** The group's colour as drawn: group state, chip fill (the dot for an unnamed group), every underline segment. */
		const drawn = async (gid: string) =>
			browser.execute((id) => {
				const chip = activeDocument.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${id}"]`);
				const dot = chip?.querySelector<HTMLElement>('.tabstrip-chip-dot');
				const named = chip !== null && !chip.classList.contains('is-unnamed');
				const fill = chip ? getComputedStyle(named ? chip : (dot ?? chip)).backgroundColor : null;
				const lines = Array.from(activeDocument.querySelectorAll<HTMLElement>(`.workspace-tab-header[data-tabstrip-group="${id}"] > .tabstrip-line`)).map((l) => getComputedStyle(l).backgroundColor);
				const swatches = Array.from(activeDocument.querySelectorAll<HTMLElement>('.tabstrip-editor .tabstrip-swatch'));
				return {
					fill,
					lines,
					checked: swatches.filter((w) => w.getAttribute('aria-checked') === 'true').map((w) => w.getAttribute('data-tabstrip-color')),
					selected: swatches.filter((w) => w.classList.contains('is-selected')).map((w) => w.getAttribute('data-tabstrip-color')),
					inputFocused: activeDocument.activeElement?.matches('.tabstrip-editor input') ?? false,
				};
			}, gid);
		const swatchSel = (color: GroupColor) => `.tabstrip-editor .tabstrip-swatch[data-tabstrip-color="${color}"]`;

		await setActive(target);
		expect(await runCommand(CMD.add)).toBe(true);
		s = await waitForState((x) => x.editor.open && x.editor.inputFocused && groupOf(x, target) !== null, 'bubble for the new group');
		const gid = groupOf(s, target) ?? '';
		const original = s.state.groups.find((g) => g.id === gid)?.color;
		if (original === undefined) throw new Error('no group');
		const before = await drawn(gid);
		expect(before).toMatchObject({ fill: fills[original], checked: [original], selected: [original], inputFocused: true });
		expect(before.lines).toEqual([fills[original]]);

		// Real click on the red swatch: the colour changes at once, the check moves, typing goes on in the name field.
		const pick: GroupColor = original === 'red' ? 'purple' : 'red';
		await $(swatchSel(pick)).click();
		s = await waitForState((x) => x.state.groups.find((g) => g.id === gid)?.color === pick, 'recoloured by the swatch');
		expect(s.editor.open).toBe(true);
		const picked = await drawn(gid);
		expect(picked).toMatchObject({ fill: fills[pick], checked: [pick], selected: [pick], inputFocused: true });
		expect(picked.lines).toEqual([fills[pick]]);
		expect(fills[pick]).not.toBe(fills[original]);
		const pickedShot = await shot('e1-3-swatch-picked');

		// Escape undoes the bubble's colour change too.
		await browser.keys(Key.Escape);
		s = await waitForState((x) => !x.editor.open, 'bubble closed by Escape');
		expect(s.state.groups.find((g) => g.id === gid)?.color).toBe(original);
		const restored = await drawn(gid);
		expect(restored.fill).toBe(fills[original]);
		expect(restored.lines).toEqual([fills[original]]);

		// A click outside commits: name typed in the field and a swatch picked, then a real click on the note.
		expect(await runCommand(CMD.rename)).toBe(true);
		s = await waitForState((x) => x.editor.open && x.editor.groupId === gid && x.editor.inputFocused, 'rename bubble');
		await browser.keys('外面 Outside');
		await $(swatchSel(pick)).click();
		s = await waitForState((x) => x.state.groups.find((g) => g.id === gid)?.color === pick, 'recoloured again');
		expect((await drawn(gid)).inputFocused).toBe(true);
		await $('.workspace-leaf.mod-active .cm-content').click();
		s = await waitForState((x) => !x.editor.open, 'bubble closed by a click outside');
		const committed = s.state.groups.find((g) => g.id === gid);
		expect(committed).toMatchObject({ name: '外面 Outside', color: pick });
		expect(s.chips.find((c) => c.groupId === gid)).toMatchObject({ text: '外面 Outside', unnamed: false, fill: fills[pick] });
		// The click put the focus in the note (the bubble did not take it back).
		const focusAfterOutside = await focusInfo();
		expect(focusAfterOutside).toMatchObject({ body: false, inActiveView: true, inBubble: false });

		// Leave E1's state for E2: the tab out of its group again (a one-tab group goes away).
		await runCommand(CMD.remove);
		s = await waitForState((x) => !x.state.groups.some((g) => g.id === gid), 'group gone');
		record('E1-bubble', { gid, original, pick, before, picked, restored, committed, focusAfterOutside, screenshot: pickedShot });
	});

	// ------------------------------------------------------------------ E2

	it('E2 "Add tab to group" joins at the group end; "Remove from group" moves a middle member out, edge members stay', async function () {
		let s = await pageState();
		const g = onlyGroup(s, '研究 Research');
		const [n1, n2, n3, n4, n5] = mainStrip(s).leafIds;
		if (!n1 || !n2 || !n3 || !n4 || !n5) throw new Error('expected five tabs from E1');
		const addVia = async (leafId: string, label: string) => {
			await $(titleSel(leafId)).click({ button: 'right' });
			const titles = await waitForMenu();
			expect(titles).toContain(`Add tab to group: ${label}`);
			await clickMenuItem(`Add tab to group: ${label}`);
		};
		const removeVia = async (leafId: string) => {
			await $(titleSel(leafId)).click({ button: 'right' });
			const titles = await waitForMenu();
			expect(titles).toContain('Remove from group');
			await clickMenuItem('Remove from group');
		};

		await addVia(n3, '研究 Research');
		s = await waitForState((x) => membersInOrder(x, g.id).length === 2, 'n3 joined');
		expect(mainStrip(s).leafIds).toEqual([n1, n2, n3, n4, n5]);
		expect(membersInOrder(s, g.id)).toEqual([n2, n3]);

		// Non-adjacent tab: joins and is moved to the group's end.
		await addVia(n5, '研究 Research');
		s = await waitForState((x) => membersInOrder(x, g.id).length === 3, 'n5 joined');
		expect(mainStrip(s).leafIds).toEqual([n1, n2, n3, n5, n4]);
		expect(membersInOrder(s, g.id)).toEqual([n2, n3, n5]);
		expectContiguous(s, g.id);
		expectDecorated(s, g.id);
		const joined = await shot('e2-1-joined-at-end');

		// Middle member out: it moves to just after the group.
		await removeVia(n3);
		s = await waitForState((x) => membersInOrder(x, g.id).length === 2, 'n3 removed');
		expect(mainStrip(s).leafIds).toEqual([n1, n2, n5, n3, n4]);
		expect(membersInOrder(s, g.id)).toEqual([n2, n5]);
		expect(groupOf(s, n3)).toBeNull();
		expectDecorated(s, g.id);
		const middle = await shot('e2-2-middle-removed');

		// n1 joins (moved to the end), then the first member leaves in place.
		await addVia(n1, '研究 Research');
		s = await waitForState((x) => membersInOrder(x, g.id).length === 3, 'n1 joined');
		expect(mainStrip(s).leafIds).toEqual([n2, n5, n1, n3, n4]);
		await removeVia(n2);
		s = await waitForState((x) => groupOf(x, n2) === null, 'first member removed');
		expect(mainStrip(s).leafIds).toEqual([n2, n5, n1, n3, n4]);
		expect(membersInOrder(s, g.id)).toEqual([n5, n1]);
		expectDecorated(s, g.id);
		// Last member leaves in place too.
		await removeVia(n1);
		s = await waitForState((x) => groupOf(x, n1) === null, 'last member removed');
		expect(mainStrip(s).leafIds).toEqual([n2, n5, n1, n3, n4]);
		expect(membersInOrder(s, g.id)).toEqual([n5]);
		expectDecorated(s, g.id);
		expect(s.stats.loopStops).toBe(0);
		record('E2', { final: brief(s), screenshots: [joined, middle] });
	});

	// ------------------------------------------------------------------ E3

	it('E3 commands: add to new group, rename (IME-safe), remove; unavailable for sidebar leaves and pinned tabs', async function () {
		let s = await pageState();
		const before = s.state.groups.length;
		const target = mainStrip(s).leafIds[4];
		if (!target) throw new Error('no fifth tab');
		await setActive(target);
		expect(await runCommand(CMD.add)).toBe(true);
		s = await waitForState((x) => x.state.groups.length === before + 1 && x.editor.open, 'group from command');
		const g = s.state.groups.find((x) => membersInOrder(s, x.id).includes(target));
		if (!g) throw new Error('no new group');
		// Least used colour in this window: grey is taken by E1's group, so blue.
		expect(g.color).toBe('blue');
		expect(s.editor.inputFocused).toBe(true);
		await browser.keys(Key.Escape);
		s = await waitForState((x) => !x.editor.open, 'bubble closed');
		expect(s.state.groups.find((x) => x.id === g.id)?.name).toBe('');
		expect(s.chips.find((c) => c.groupId === g.id)?.unnamed).toBe(true);

		expect(await runCommand(CMD.rename)).toBe(true);
		s = await waitForState((x) => x.editor.open && x.editor.groupId === g.id && x.editor.inputFocused, 'rename bubble');
		// IME: while composing, Enter and Escape belong to the input method (WebDriver cannot compose,
		// so the composition events are synthetic; the keys after it are real).
		const ime = await browser.execute(() => {
			const input = activeDocument.querySelector<HTMLInputElement>('.tabstrip-editor input');
			if (!input) throw new Error('no input');
			input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
			input.value = 'zu';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
			input.dispatchEvent(enter);
			const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
			input.dispatchEvent(esc);
			const openAfterComposingKeys = activeDocument.querySelector('.tabstrip-editor') !== null;
			// isComposing false but inside compositionstart/end (some IMEs): still ignored.
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			const openAfterPlainEnterWhileComposing = activeDocument.querySelector('.tabstrip-editor') !== null;
			input.value = '组';
			input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '组' }));
			input.dispatchEvent(new Event('input', { bubbles: true }));
			return { openAfterComposingKeys, openAfterPlainEnterWhileComposing, enterPrevented: enter.defaultPrevented, escPrevented: esc.defaultPrevented };
		});
		expect(ime).toEqual({ openAfterComposingKeys: true, openAfterPlainEnterWhileComposing: true, enterPrevented: false, escPrevented: false });
		await browser.keys(['命令', Key.Enter]);
		s = await waitForState((x) => !x.editor.open, 'rename committed');
		expect(s.state.groups.find((x) => x.id === g.id)?.name).toBe('组命令');

		expect(await runCommand(CMD.remove)).toBe(true);
		s = await waitForState((x) => !x.state.groups.some((y) => y.id === g.id), 'single member removed, group gone');
		expect(groupOf(s, target)).toBeNull();
		const afterRemove = s.state.groups.length;

		// A sidebar leaf is active: the commands are not available and change nothing.
		await browser.executeObsidian(async ({ app }) => {
			app.workspace.leftSplit.expand();
			const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
			if (!leaf) throw new Error('no file explorer');
			await app.workspace.revealLeaf(leaf);
			app.workspace.setActiveLeaf(leaf, { focus: true });
		});
		await browser.pause(200);
		const sidebarActive = await browser.executeObsidian(({ app, obsidian }) => {
			const ws = app.workspace as unknown as { activeLeaf: { view: { getViewType(): string } } | null };
			return {
				activeType: ws.activeLeaf?.view.getViewType() ?? null,
				activeViewType: app.workspace.getActiveViewOfType(obsidian.View)?.getViewType() ?? null,
			};
		});
		record('E3-sidebar-active', sidebarActive);
		const sidebar = {
			add: await commandAvailable(CMD.add),
			remove: await commandAvailable(CMD.remove),
			rename: await commandAvailable(CMD.rename),
		};
		expect(sidebar).toEqual({ add: false, remove: false, rename: false });
		// Running them anyway (e.g. from a hotkey) is a no-op.
		await runCommand(CMD.add);
		await runCommand(CMD.remove);
		await runCommand(CMD.rename);
		s = await pageState();
		expect(s.state.groups.length).toBe(afterRemove);
		expect(s.editor.open).toBe(false);

		// A pinned tab cannot be grouped.
		await setActive(target);
		await setPinned(target, true);
		s = await waitForState((x) => stripOf(x, target).pinned[stripOf(x, target).leafIds.indexOf(target)] === true, 'pinned');
		expect(await commandAvailable(CMD.add)).toBe(false);
		await setPinned(target, false);
		s = await waitForState((x) => !stripOf(x, target).pinned.some(Boolean), 'unpinned');
		expect(s.state.groups.length).toBe(afterRemove);
		record('E3', { sidebar, ime, final: brief(s) });
	});

	// ------------------------------------------------------------------ E4

	it('E4 chip menu: rename, all nine colours (fill, underline, contrast), new tab in group, ungroup, close group', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		await setActive(ids.n1);
		const gid = await makeGroup([ids.n2, ids.n3], 'Colours');
		let s = await waitForState((x) => x.chips.some((c) => c.groupId === gid), 'chip for E4 group');

		// Rename from the chip menu (commit with Enter).
		await $(chipSel(gid)).click({ button: 'right' });
		const titles = await waitForMenu();
		expect(titles).toEqual(['Rename group', ...GROUP_COLORS.map((c) => COLOR_NAMES[c]), 'New tab in group', 'Ungroup', 'Close group']);
		await clickMenuItem('Rename group');
		await waitForState((x) => x.editor.open && x.editor.inputFocused, 'bubble from chip menu');
		await browser.keys(['颜色 Colours', Key.Enter]);
		s = await waitForState((x) => !x.editor.open && x.state.groups.some((g) => g.name === '颜色 Colours'), 'renamed');

		// Every colour through the chip menu: state, chip fill, underline, menu check mark, contrast.
		const expected = await expectedFills();
		const results: Record<string, unknown>[] = [];
		for (const color of GROUP_COLORS) {
			await $(chipSel(gid)).click({ button: 'right' });
			await waitForMenu();
			await clickMenuItem(COLOR_NAMES[color]);
			s = await waitForState((x) => x.state.groups.find((g) => g.id === gid)?.color === color, `colour ${color}`);
			const chip = s.chips.find((c) => c.groupId === gid);
			const lines = s.lines.filter((l) => l.groupId === gid);
			if (!chip) throw new Error('no chip');
			const ratio = contrastOf(chip.textColor, chip.fill);
			results.push({ color, fill: chip.fill, expected: expected[color], line: lines.map((l) => l.color), text: chip.textColor, ink: chip.ink, contrast: Number(ratio.toFixed(2)) });
			expect(chip.fill).toBe(expected[color]);
			expect(lines.map((l) => l.color)).toEqual(lines.map(() => expected[color]));
			expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
			expectDecorated(s, gid);
			// The menu shows a check on the current colour.
			await $(chipSel(gid)).click({ button: 'right' });
			await waitForMenu();
			const checked = await browser.execute(() =>
				Array.from(activeDocument.querySelectorAll('.menu .menu-item'))
					.filter((i) => i.classList.contains('mod-checked') || i.querySelector('.menu-item-icon.mod-checked, .mod-checked') !== null)
					.map((i) => (i.querySelector('.menu-item-title')?.textContent ?? '').trim()),
			);
			expect(checked).toEqual([COLOR_NAMES[color]]);
			await closeMenus();
		}
		expect(new Set(results.map((r) => r['fill'])).size).toBe(9);
		await shot('e4-1-colours-menu-default-light');

		// New tab in group: created at the group's end through createLeafInParent; getLeaf is never called.
		await browser.executeObsidian(({ app }) => {
			const ws = app.workspace as unknown as { getLeaf: (...a: unknown[]) => unknown; e2eGetLeafCalls?: number };
			const original = ws.getLeaf;
			ws.e2eGetLeafCalls = 0;
			// Test-only spy on the instance (shadows the method; removed below).
			ws.getLeaf = function (this: unknown, ...args: unknown[]) {
				ws.e2eGetLeafCalls = (ws.e2eGetLeafCalls ?? 0) + 1;
				return original.apply(this, args);
			};
		});
		const beforeNew = await pageState();
		await $(chipSel(gid)).click({ button: 'right' });
		await waitForMenu();
		await clickMenuItem('New tab in group');
		s = await waitForState((x) => membersInOrder(x, gid).length === 3, 'new tab is a member');
		const spy = await browser.executeObsidian(({ app }) => {
			const ws = app.workspace as unknown as { getLeaf?: unknown; e2eGetLeafCalls?: number };
			const calls = ws.e2eGetLeafCalls ?? -1;
			delete ws.getLeaf;
			delete ws.e2eGetLeafCalls;
			return { calls, restored: typeof (app.workspace as unknown as { getLeaf: unknown }).getLeaf === 'function' };
		});
		const members = membersInOrder(s, gid);
		const newId = members[2];
		expect(spy).toEqual({ calls: 0, restored: true });
		expect(members.slice(0, 2)).toEqual([ids.n2, ids.n3]);
		expect(mainStrip(beforeNew).leafIds.includes(newId ?? '')).toBe(false);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, newId, ids.n4, ids.n5, ids.n6]);
		expect(s.activeId).toBe(newId);
		expectDecorated(s, gid);
		await shot('e4-2-new-tab-in-group');

		// Ungroup: tabs stay, group gone.
		const orderBefore = mainStrip(s).leafIds;
		await $(chipSel(gid)).click({ button: 'right' });
		await waitForMenu();
		await clickMenuItem('Ungroup');
		s = await waitForState((x) => !x.state.groups.some((g) => g.id === gid), 'ungrouped');
		expect(mainStrip(s).leafIds).toEqual(orderBefore);
		expect(s.chips.filter((c) => c.groupId === gid)).toEqual([]);
		expect(s.memberHeaders.filter((h) => h.groupId === gid)).toEqual([]);

		// Close group: members closed, group gone, no errors.
		const closing = await makeGroup([ids.n4, ids.n5], 'Close me');
		await waitForState((x) => x.chips.some((c) => c.groupId === closing), 'chip for close');
		await $(chipSel(closing)).click({ button: 'right' });
		await waitForMenu();
		await clickMenuItem('Close group');
		s = await waitForState((x) => !mainStrip(x).leafIds.includes(ids.n4) && !mainStrip(x).leafIds.includes(ids.n5), 'members closed');
		expect(s.state.groups.some((g) => g.id === closing)).toBe(false);
		expect(s.state.tombstones.filter((t) => t.groupId === closing).map((t) => t.leafId).sort()).toEqual([ids.n4, ids.n5].sort());
		expect(await errorTimeline()).toEqual([]);
		record('E4', { menu: titles, colours: results, newTab: { spy, newId }, final: brief(s) });
	});

	it('E4 nine colours under default and Atom, light and dark: fill = mapped variable mixed per the palette, distinct, text contrast ≥ 4.5', async function () {
		const roles = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'] as const;
		const ids = await openNotes([...roles]);
		await setActive(ids.n1);
		const names = ['灰', '蓝', '红', '黄', '绿', '粉', '紫', '青', '橙'];
		const groupIds: string[] = [];
		for (const [i, color] of GROUP_COLORS.entries()) {
			groupIds.push(await makeGroup([ids[roles[i] ?? 'n1']], names[i] ?? color, color));
		}
		await waitForState((x) => x.chips.length === 9, 'nine chips');
		const looks: Record<string, unknown> = {};
		for (const theme of ['default', 'Atom'] as const) {
			for (const dark of [false, true]) {
				await setLook(theme, dark);
				const s = await waitForState((x) => x.chips.length === 9, 'chips after theme change');
				const expected = await expectedFills();
				const rows = GROUP_COLORS.map((color, i) => {
					const chip = s.chips.find((c) => c.groupId === groupIds[i]);
					const line = s.lines.find((l) => l.groupId === groupIds[i]);
					if (!chip || !line) throw new Error(`no chip or line for ${color}`);
					return { color, fill: chip.fill, expected: expected[color], line: line.color, text: chip.textColor, ink: chip.ink, contrast: Number(contrastOf(chip.textColor, chip.fill).toFixed(2)) };
				});
				const key = `${theme}-${dark ? 'dark' : 'light'}`;
				looks[key] = rows;
				const file = await shot(`e4-3-nine-colours-${key}`);
				for (const r of rows) {
					expect(r.fill).toBe(r.expected);
					expect(r.line).toBe(r.expected);
					expect(r.contrast).toBeGreaterThanOrEqual(MIN_CONTRAST);
				}
				expect(new Set(rows.map((r) => r.fill)).size).toBe(9);
				record(`E4-look-${key}`, { rows, screenshot: file });
			}
		}
		await setLook('default', false);
	});

	// ------------------------------------------------------------------ E5

	it('E5 native behaviour through reconcile: new tab inside, open in place, split, pin and unpin', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		await setActive(ids.n1);
		const gid = await makeGroup([ids.n2, ids.n3, ids.n4], 'E5 组');
		let s = await waitForState((x) => membersInOrder(x, gid).length === 3, 'E5 group');
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6]);

		// Obsidian puts a new tab right after the active tab (not at the strip end). With the
		// first member active, that is strictly inside the group, so it joins.
		await setActive(ids.n2);
		const fromGetLeaf = await browser.executeObsidian(({ app }) => (app.workspace.getLeaf('tab') as unknown as { id: string }).id);
		s = await waitForState((x) => mainStrip(x).leafIds.includes(fromGetLeaf) && groupOf(x, fromGetLeaf) === gid, 'new tab joined');
		expect(mainStrip(s).leafIds.indexOf(fromGetLeaf)).toBe(mainStrip(s).leafIds.indexOf(ids.n2) + 1);
		expectContiguous(s, gid);
		expectDecorated(s, gid);
		const newTabShot = await shot('e5-1-new-tab-inside-joins');
		// With the last member active the new tab lands on the group's end boundary: it stays out.
		await setActive(ids.n4);
		const atEnd = await browser.executeObsidian(({ app }) => (app.workspace.getLeaf('tab') as unknown as { id: string }).id);
		s = await waitForState((x) => mainStrip(x).leafIds.includes(atEnd), 'tab after last member');
		expect(mainStrip(s).leafIds.indexOf(atEnd)).toBe(mainStrip(s).leafIds.indexOf(ids.n4) + 1);
		expect(groupOf(s, atEnd)).toBeNull();
		// Public API that inserts at an index: inside the group joins.
		const inserted = await browser.executeObsidian(
			({ app }, inside) => {
				const leaf = app.workspace.getLeafById(inside);
				if (!leaf) throw new Error('no leaf');
				const tabs = leaf.parent;
				const index = (tabs as unknown as { children: unknown[] }).children.indexOf(leaf);
				return (app.workspace.createLeafInParent(tabs, index) as unknown as { id: string }).id;
			},
			ids.n3,
		);
		s = await waitForState((x) => groupOf(x, inserted) === gid, 'createLeafInParent inside joins');
		expectContiguous(s, gid);
		await browser.executeObsidian(
			({ app }, a, b, c) => {
				for (const id of [a, b, c]) app.workspace.getLeafById(id)?.detach();
			},
			fromGetLeaf,
			atEnd,
			inserted,
		);
		s = await waitForState((x) => mainStrip(x).leafIds.length === 6, 'extra tabs closed');
		expect(membersInOrder(s, gid)).toEqual([ids.n2, ids.n3, ids.n4]);

		// Open another file in place in a member: still a member, fingerprint follows the file.
		await browser.executeObsidian(
			async ({ app, obsidian }, id, path) => {
				const leaf = app.workspace.getLeafById(id);
				const file = app.vault.getFileByPath(path);
				if (!leaf || !(file instanceof obsidian.TFile)) throw new Error('missing');
				await leaf.openFile(file);
			},
			ids.n3,
			'读书笔记：深度学习.md',
		);
		s = await waitForState(
			(x) => x.state.members.find((m) => m.leafId === ids.n3)?.fingerprint.path === '读书笔记：深度学习.md',
			'fingerprint updated',
		);
		expect(groupOf(s, ids.n3)).toBe(gid);
		expect(membersInOrder(s, gid)).toEqual([ids.n2, ids.n3, ids.n4]);

		// Split right from a member: the new leaf is in another strip and ungrouped.
		const split = await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			if (!leaf) throw new Error('no leaf');
			return (app.workspace.createLeafBySplit(leaf, 'vertical') as unknown as { id: string }).id;
		}, ids.n3);
		s = await waitForState((x) => x.strips.filter((st) => st.kind === 'main').length === 2 && x.strips.some((st) => st.leafIds.includes(split)), 'split');
		expect(stripOf(s, split).leafIds).not.toContain(ids.n3);
		expect(groupOf(s, split)).toBeNull();
		expect(membersInOrder(s, gid)).toEqual([ids.n2, ids.n3, ids.n4]);
		expectDecorated(s, gid);
		const splitShot = await shot('e5-2-split-right');
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.detach();
		}, split);
		s = await waitForState((x) => x.strips.length === 1, 'split closed');

		// Pin a member: it leaves the group, moves to the end of the pinned prefix, and a notice names the group.
		await setPinned(ids.n3, true);
		s = await waitForState((x) => groupOf(x, ids.n3) === null && mainStrip(x).leafIds[0] === ids.n3, 'pinned member left');
		expect(mainStrip(s).pinned[0]).toBe(true);
		expect(membersInOrder(s, gid)).toEqual([ids.n2, ids.n4]);
		expectContiguous(s, gid);
		expectDecorated(s, gid);
		expect(s.stats.notices.some((n) => n.includes('E5 组'))).toBe(true);
		expect(s.notices.some((n) => n.includes('E5 组'))).toBe(true);
		const pinShot = await shot('e5-3-pinned-notice');
		// Unpin: it stays right after the pinned prefix (here: first) and does not return to the group.
		await setPinned(ids.n3, false);
		s = await waitForState((x) => !mainStrip(x).pinned[0], 'unpinned');
		await browser.pause(200);
		s = await pageState();
		expect(mainStrip(s).leafIds[0]).toBe(ids.n3);
		expect(groupOf(s, ids.n3)).toBeNull();
		expect(membersInOrder(s, gid)).toEqual([ids.n2, ids.n4]);
		expect(s.stats.loopStops).toBe(0);
		record('E5', { getLeafPlacement: 'right after the active tab', final: brief(s), notices: s.stats.notices, screenshots: [newTabShot, splitShot, pinShot] });
	});

	// ------------------------------------------------------------------ E6

	it('E6 chip shielding: clicks, preview, double click, drag source, hover look, Shift+F10 menu', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4']);
		const gid = await makeGroup([ids.n2, ids.n3], '盾 Shield');
		await setActive(ids.n4);
		let s = await waitForState((x) => x.chips.some((c) => c.groupId === gid), 'E6 chip');
		const chip = chipSel(gid);
		const neutral = await browser.execute(() => {
			const el = activeDocument.querySelector('.workspace .mod-root .workspace-leaf.mod-active .view-content');
			if (!el) throw new Error('no view content');
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
		});
		const pointerTo = async (p: { x: number; y: number }) => {
			await browser.action('pointer').move({ x: p.x, y: p.y, duration: 0 }).perform();
		};

		// Left click: no tab switch. Since step L5 the click collapses the group (and a second click
		// expands it again); before L5 it did nothing else.
		await $(chip).click();
		await browser.pause(300);
		s = await pageState();
		expect(s.activeId).toBe(ids.n4);
		expect(mainStrip(s).currentId).toBe(ids.n4);
		expect(s.editor.open).toBe(false);
		expect(s.state.groups.find((g) => g.id === gid)?.collapsed).toBe(true);
		await browser.pause(600);
		await $(chip).click();
		await browser.pause(300);
		s = await pageState();
		expect(s.activeId).toBe(ids.n4);
		expect(mainStrip(s).currentId).toBe(ids.n4);
		expect(s.state.groups.find((g) => g.id === gid)?.collapsed).toBe(false);

		// Middle click: no tab closed.
		await $(chip).click({ button: 'middle' });
		await browser.pause(300);
		s = await pageState();
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4]);

		// Right click: only the chip menu, none of the native tab menu items.
		await $(chip).click({ button: 'right' });
		const titles = await waitForMenu();
		expect(titles).toContain('Rename group');
		expect(titles).not.toContain('Close');
		expect(titles).not.toContain('Add tab to new group');
		await closeMenus();

		// Mod + hover: no page preview from the tab header (control on the title first).
		await browser.executeObsidian(({ app }) => {
			type Monitor = { hoverLinks: string[]; popovers: number; observer: MutationObserver; ref: import('obsidian').EventRef };
			const w = window as Window & { e2eHover?: Monitor };
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
				ref: (app.workspace as unknown as { on(name: 'hover-link', cb: (data: { source: string }) => void): import('obsidian').EventRef }).on('hover-link', (data) => {
					monitor.hoverLinks.push(data.source);
				}),
			};
			monitor.observer.observe(activeDocument.body, { childList: true, subtree: true });
			w.e2eHover = monitor;
		});
		const readHover = () =>
			browser.execute(() => {
				const m = (window as Window & { e2eHover?: { hoverLinks: string[]; popovers: number } }).e2eHover;
				const out = { hoverLinks: [...(m?.hoverLinks ?? [])], popovers: m?.popovers ?? -1 };
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
		await pointerTo(neutral);
		await browser.pause(300);
		await readHover();
		await modHover(await $(titleSel(ids.n2)).getElement());
		const control = await readHover();
		expect(control.hoverLinks).toContain('tab-header');
		await pointerTo(neutral);
		await browser.waitUntil(async () => (await browser.execute(() => activeDocument.querySelectorAll('.hover-popover').length)) === 0, { timeout: 5000 });
		await browser.pause(300);
		await readHover();
		await modHover(await $(chip).getElement());
		const onChip = await readHover();
		expect(onChip.hoverLinks.filter((x) => x === 'tab-header')).toEqual([]);
		expect(onChip.popovers).toBe(0);
		await browser.executeObsidian(({ app }) => {
			const w = window as Window & { e2eHover?: { observer: MutationObserver; ref: import('obsidian').EventRef } };
			if (w.e2eHover) {
				w.e2eHover.observer.disconnect();
				app.workspace.offref(w.e2eHover.ref);
			}
			delete w.e2eHover;
		});
		await pointerTo(neutral);

		// Double click stays on the chip (in a frameless window a double click on the strip zooms it).
		const dbl = await browser.execute((sel) => {
			const container = activeDocument.querySelector('.workspace .mod-root .workspace-tab-header-container');
			if (!container) throw new Error('no strip');
			const w = window as Window & { e2eDbl?: { count: number; listener: () => void } };
			const st = { count: 0, listener: () => st.count++ };
			container.addEventListener('dblclick', st.listener);
			w.e2eDbl = st;
			const el = activeDocument.querySelector(sel);
			return { appRegion: el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : '' };
		}, chip);
		await $(chip).doubleClick();
		await browser.pause(400);
		const dblReached = await browser.execute(() => {
			const container = activeDocument.querySelector('.workspace .mod-root .workspace-tab-header-container');
			const w = window as Window & { e2eDbl?: { count: number; listener: () => void } };
			const count = w.e2eDbl?.count ?? -1;
			if (w.e2eDbl && container) container.removeEventListener('dblclick', w.e2eDbl.listener);
			delete w.e2eDbl;
			return count;
		});
		expect(dbl.appRegion).toBe('no-drag');
		expect(dblReached).toBe(0);
		// Since step L5: a double click on the chip toggles the group once (its second click is
		// swallowed, see the decorator); no tab was activated. Expand it again for the rest.
		s = await pageState();
		expect(s.activeId).toBe(ids.n4);
		expect(s.state.groups.find((g) => g.id === gid)?.collapsed).toBe(true);
		await browser.pause(600);
		await $(chip).click();
		s = await waitForState((x) => x.state.groups.find((g) => g.id === gid)?.collapsed === false, 'E6 expanded again after the double click');
		await browser.pause(600);

		// Drag: real pointer input. A capture listener on window cancels every dragstart at once
		// (so no OS drag ever starts) and records its target; a listener on the chip's tab header
		// counts dragstarts that reach it.
		const hostId = ids.n2;
		await browser.execute((hostSel) => {
			const host = activeDocument.querySelector(hostSel);
			if (!host) throw new Error('no host');
			type Rec = { targets: string[]; headerSaw: number; capture: (e: DragEvent) => void; onHeader: () => void };
			const rec: Rec = {
				targets: [],
				headerSaw: 0,
				capture: (e: DragEvent) => {
					const t = e.target as HTMLElement;
					rec.targets.push(t.classList.contains('tabstrip-chip') ? 'chip' : t.classList.contains('workspace-tab-header') ? 'tab-header' : t.className);
					e.preventDefault();
					// Control drags from a tab must not reach Obsidian's own tab drag code either.
					if (!t.classList.contains('tabstrip-chip')) e.stopImmediatePropagation();
				},
				onHeader: () => {
					rec.headerSaw++;
				},
			};
			window.addEventListener('dragstart', rec.capture, true);
			host.addEventListener('dragstart', rec.onHeader);
			(window as Window & { e2eDrag?: Rec }).e2eDrag = rec;
		}, headerSel(hostId));
		const drag = async (el: WebdriverIO.Element) => {
			await browser
				.action('pointer')
				.move({ origin: el, duration: 0 })
				.down({ button: 0 })
				.move({ origin: el, x: 20, y: 0, duration: 100 })
				.move({ origin: el, x: 60, y: 0, duration: 100 })
				.up({ button: 0 })
				.perform();
			await browser.pause(300);
		};
		const readDrag = () =>
			browser.execute(() => {
				const rec = (window as Window & { e2eDrag?: { targets: string[]; headerSaw: number } }).e2eDrag;
				const out = { targets: [...(rec?.targets ?? [])], headerSaw: rec?.headerSaw ?? -1, grabbing: activeDocument.body.classList.contains('is-grabbing') };
				if (rec) {
					rec.targets.length = 0;
					rec.headerSaw = 0;
				}
				return out;
			});
		await drag(await $(titleSel(ids.n3)).getElement());
		const dragControl = await readDrag();
		await drag(await $(chip).getElement());
		const dragChip = await readDrag();
		await browser.execute((hostSel) => {
			const rec = (window as Window & { e2eDrag?: { capture: (e: DragEvent) => void; onHeader: () => void } }).e2eDrag;
			if (rec) {
				window.removeEventListener('dragstart', rec.capture, true);
				activeDocument.querySelector(hostSel)?.removeEventListener('dragstart', rec.onHeader);
			}
			delete (window as Window & { e2eDrag?: unknown }).e2eDrag;
		}, headerSel(hostId));
		expect(dragControl.targets).toEqual(['tab-header']);
		expect(dragChip).toEqual({ targets: ['chip'], headerSaw: 0, grabbing: false });
		s = await pageState();
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4]);
		// Released over its own tab, the press on the chip did not activate that tab either.
		expect(s.activeId).not.toBe(hostId);
		await setActive(ids.n4);

		// Hovering the chip shows neither the first member's hover background nor its close button.
		const look = () =>
			browser.execute((hostSel) => {
				const h = activeDocument.querySelector<HTMLElement>(hostSel);
				const inner = h?.querySelector('.workspace-tab-header-inner');
				const close = h?.querySelector('.workspace-tab-header-inner-close-button');
				if (!h || !inner || !close) throw new Error('header parts missing');
				const cs = getComputedStyle(h);
				return {
					bg: cs.backgroundColor,
					shadow: cs.boxShadow,
					before: getComputedStyle(h, '::before').boxShadow,
					after: getComputedStyle(h, '::after').boxShadow,
					innerBg: getComputedStyle(inner).backgroundColor,
					innerBorder: getComputedStyle(inner).borderColor,
					close: getComputedStyle(close).display,
					headerHovered: h.matches(':hover'),
					chipHovered: h.querySelector('.tabstrip-chip:hover') !== null,
				};
			}, headerSel(hostId));
		const hover: Record<string, unknown> = {};
		for (const theme of ['default', 'Atom'] as const) {
			await setLook(theme, false);
			await pointerTo(neutral);
			await browser.pause(300);
			const rest = await look();
			await browser.action('pointer').move({ origin: await $(chip).getElement(), duration: 0 }).perform();
			await browser.pause(300);
			const overChip = await look();
			await browser.action('pointer').move({ origin: await $(titleSel(hostId)).getElement(), duration: 0 }).perform();
			await browser.pause(300);
			const overTab = await look();
			await pointerTo(neutral);
			hover[theme] = { rest, overChip, overTab };
			expect(rest.close).toBe('none');
			expect(overChip.chipHovered).toBe(true);
			expect(overChip.headerHovered).toBe(true);
			// A shadow made only of fully transparent layers draws nothing: compare it as 'none'.
			const shadow = (v: string) => (v === 'none' || v.replace(/rgba\(0, 0, 0, 0\)[^,]*(?:,|$)/g, '').trim() === '' ? 'none' : v);
			const visual = (x: typeof rest) => ({
				bg: x.bg,
				shadow: shadow(x.shadow),
				before: shadow(x.before),
				after: shadow(x.after),
				innerBg: x.innerBg,
				innerBorder: x.innerBorder,
				close: x.close,
			});
			expect(visual(overChip)).toEqual(visual(rest));
			// Control: hovering the tab itself does change its look.
			expect(overTab.close).toBe('flex');
			expect(visual(overTab)).not.toEqual(visual(rest));
		}
		await setLook('default', false);

		// Keyboard: focus the chip, Shift+F10 opens the chip menu.
		await browser.execute((sel) => {
			activeDocument.querySelector<HTMLElement>(sel)?.focus();
		}, chip);
		const focused = await browser.execute((sel) => activeDocument.activeElement === activeDocument.querySelector(sel), chip);
		expect(focused).toBe(true);
		await browser.keys([Key.Shift, Key.F10]);
		const keyTitles = await waitForMenu();
		expect(keyTitles[0]).toBe('Rename group');
		expect(keyTitles).not.toContain('Close');
		const keyShot = await shot('e6-1-keyboard-menu');
		// Rename from the keyboard-opened menu: when the bubble closes, the focus is back on the
		// chip (close-out round 1), so a keyboard user keeps their place.
		await clickMenuItem('Rename group');
		s = await waitForState((x) => x.editor.open && x.editor.inputFocused, 'E6 rename bubble');
		expectBubblePlaced(await bubbleGeometry(gid));
		await browser.keys(['盾 Key', Key.Enter]);
		s = await waitForState((x) => !x.editor.open, 'E6 bubble closed');
		expect(s.state.groups.find((g) => g.id === gid)?.name).toBe('盾 Key');
		const keyFocus = await focusInfo();
		expect(keyFocus).toMatchObject({ body: false, chipGroup: gid });
		record('E6', { control, onChip, dblReached, dragControl, dragChip, hover, keyTitles, keyFocus, screenshot: keyShot });
	});

	// ------------------------------------------------------------------ E7

	it('E7 pop-out window (workspace.openPopoutLeaf): group two tabs there, chip and underline in the pop-out, bubble in the pop-out, close without errors', async function () {
		// Opened with the public API, like a user's "Open in new window" (close-out round 2).
		const { result: pop, warm } = await withWarmPopout(() => openPopoutLeafWithNotes(['读书笔记：深度学习.md', '中文 English 混合 note.md', 'notes with spaces/a b c.md']));
		const [p1, p2, p3] = pop;
		if (!p1 || !p2 || !p3) throw new Error('popout leaves');
		let s = await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 3), 'pop-out with three tabs');
		expect(stripOf(s, p1).leafIds).toEqual([p1, p2, p3]);
		const mainColours = new Set(s.state.groups.map((g) => g.color));

		await setActive(p1);
		expect(await runCommand(CMD.add)).toBe(true);
		s = await waitForState((x) => x.editor.open && x.editor.doc === 'popout', 'bubble in the pop-out');
		expect(s.editor.inputFocused).toBe(true);
		const g = s.state.groups.find((x) => membersInOrder(s, x.id).includes(p1));
		if (!g) throw new Error('no pop-out group');
		// Chrome picks the least used colour per window: the pop-out has no group yet, so grey,
		// even though the main window already uses grey.
		expect(g.color).toBe('grey');
		expect(mainColours.has('grey')).toBe(true);
		expectBubblePlaced(await bubbleGeometry(g.id));

		// Real input in the pop-out window: switch WebDriver to it.
		const mainHandle = await browser.getWindowHandle();
		let popHandle: string | null = null;
		for (const h of await browser.getWindowHandles()) {
			if (h === mainHandle) continue;
			await browser.switchToWindow(h);
			if (await browser.execute(() => document.querySelector('.tabstrip-editor') !== null)) {
				popHandle = h;
				break;
			}
		}
		const usedRealInput = popHandle !== null;
		let popBubble: Awaited<ReturnType<typeof bubbleGeometry>> | null = null;
		let popFocus: Awaited<ReturnType<typeof focusInfo>> | null = null;
		try {
			if (popHandle !== null) {
				await browser.keys(['弹出 Popout', Key.Enter]);
			} else {
				await browser.switchToWindow(mainHandle);
				await browser.executeObsidian(({ app }, leafId) => {
					const doc = app.workspace.getLeafById(leafId)?.getContainer().doc;
					const input = doc?.querySelector<HTMLInputElement>('.tabstrip-editor input');
					if (!input) throw new Error('no bubble input in the pop-out');
					input.value = '弹出 Popout';
					input.dispatchEvent(new Event('input', { bubbles: true }));
					input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
				}, p1);
			}
			if (popHandle !== null) await browser.switchToWindow(mainHandle);
			s = await waitForState((x) => !x.editor.open && x.state.groups.some((y) => y.id === g.id && y.name === '弹出 Popout'), 'pop-out group named');

			// Second tab joins through the tab menu in the pop-out.
			if (popHandle !== null) {
				await browser.switchToWindow(popHandle);
				await $(titleSel(p2)).click({ button: 'right' });
				await waitForMenu();
				await clickMenuItem('Add tab to group: 弹出 Popout');
				await browser.switchToWindow(mainHandle);
			} else {
				throw new Error('no WebDriver handle for the pop-out window');
			}
			s = await waitForState((x) => membersInOrder(x, g.id).length === 2, 'second pop-out member');
			expect(membersInOrder(s, g.id)).toEqual([p1, p2]);
			expectDecorated(s, g.id);
			const chipInPopout = await browser.executeObsidian(({ app }, leafId) => {
				const doc = app.workspace.getLeafById(leafId)?.getContainer().doc;
				return { chips: doc?.querySelectorAll('.tabstrip-chip').length ?? -1, lines: doc?.querySelectorAll('.tabstrip-line').length ?? -1, isMainDoc: doc === document };
			}, p1);
			expect(chipInPopout).toEqual({ chips: 1, lines: 2, isMainDoc: false });
			if (popHandle !== null) {
				await browser.switchToWindow(popHandle);
				await shot('e7-1-popout-group');
				await browser.switchToWindow(mainHandle);
			}

			// Rename from the chip menu: the bubble opens in the pop-out document.
			await browser.switchToWindow(popHandle);
			await $(chipSel(g.id)).click({ button: 'right' });
			await waitForMenu();
			await clickMenuItem('Rename group');
			await browser.switchToWindow(mainHandle);
			s = await waitForState((x) => x.editor.open && x.editor.doc === 'popout' && x.editor.inputFocused, 'rename bubble in the pop-out');
			popBubble = await bubbleGeometry(g.id);
			expect(popBubble.doc).toBe('popout');
			expectBubblePlaced(popBubble);
			await browser.switchToWindow(popHandle);
			await shot('e7-2-popout-bubble');
			await browser.keys(Key.Escape);
			await browser.switchToWindow(mainHandle);
			s = await waitForState((x) => !x.editor.open, 'pop-out bubble closed');
			// The focus stays in the pop-out, back on the chip whose right click opened the bubble (close-out round 1).
			popFocus = await focusInfo(p1);
			expect(popFocus).toMatchObject({ body: false, chipGroup: g.id });
		} finally {
			await browser.switchToWindow(mainHandle);
		}

		// Close the pop-out window: no errors, its group is gone. The error watch removes Obsidian's
		// own observers of the closed window (see startErrorWatch); Tabstrip has none there.
		await closePopout(p1);
		s = await waitForState((x) => !x.strips.some((st) => st.kind === 'popout'), 'pop-out closed');
		expect(s.state.groups.some((x) => x.id === g.id)).toBe(false);
		await browser.pause(500);
		const closes = await popoutCloseReports();
		const close = closes[closes.length - 1];
		expect(close?.pluginOwned).toBe(0);
		expect((await strandedObservations(false)).plugin).toBe(0);
		expect(await errorTimeline()).toEqual([]);
		record('E7', { opened: 'workspace.openPopoutLeaf', warm, usedRealInput, popoutClose: close, popBubble, popFocus, final: brief(s) });
	});

	// ------------------------------------------------------------------ close-out round 1: pop-out edge cases

	it('pop-out: "Move to new window" on the chip holder (moveLeafToPopout); group and edit in that pop-out; Tabstrip observers never get an element of another window', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3']);
		// Test-only: count ResizeObserver notifications about an element of another document, by
		// owner (Tabstrip or not). Installed before the chip exists, so the chip's observer is counted.
		await browser.execute(() => {
			type Cross = { plugin: number; other: number; pluginTotal: number; original: typeof ResizeObserver };
			const original = window.ResizeObserver;
			const cross: Cross = { plugin: 0, other: 0, pluginTotal: 0, original };
			class Counting extends original {
				constructor(callback: ResizeObserverCallback) {
					const plugin = (new Error().stack ?? '').includes('plugin:tabstrip');
					super((entries, observer) => {
						if (plugin) cross.pluginTotal += entries.length;
						for (const e of entries) {
							if (e.target.ownerDocument === document) continue;
							if (plugin) cross.plugin++;
							else cross.other++;
						}
						callback(entries, observer);
					});
				}
			}
			window.ResizeObserver = Counting;
			(window as Window & { e2eCross?: Cross }).e2eCross = cross;
		});
		const readCross = () =>
			browser.execute(() => {
				const c = (window as Window & { e2eCross?: { plugin: number; other: number; pluginTotal: number } }).e2eCross;
				return c ? { plugin: c.plugin, other: c.other, pluginTotal: c.pluginTotal } : null;
			});
		let moved: PageState | null = null;
		let titles: string[] = [];
		try {
			const gid = await makeGroup([ids.n2, ids.n3], 'Move 移');
			await setActive(ids.n1);
			let s = await waitForState((x) => x.chips.some((c) => c.groupId === gid && c.hostLeafId === ids.n2), 'chip on n2');
			await withWarmPopout(async () => {
				await $(titleSel(ids.n2)).click({ button: 'right' });
				titles = await waitForMenu();
				const moveTitle = titles.find((t) => /new window/i.test(t));
				if (moveTitle === undefined) throw new Error(`no "Move to new window" item in ${JSON.stringify(titles)}`);
				await clickMenuItem(moveTitle);
				await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(ids.n2)), 'n2 moved to a pop-out');
			});
			await browser.pause(800);
			s = await pageState();
			moved = s;
			// The moved tab is in another strip now, so it left its group (core); the chip went to n3.
			expect(groupOf(s, ids.n2)).toBe(null);
			expect(membersInOrder(s, gid)).toEqual([ids.n3]);
			expectDecorated(s, gid);
			const popoutMarks = await browser.executeObsidian(({ app }, id) => {
				const doc = app.workspace.getLeafById(id)?.getContainer().doc;
				return doc ? doc.querySelectorAll('.tabstrip-chip, .tabstrip-line, .tabstrip-member').length : -1;
			}, ids.n2);
			expect(popoutMarks).toBe(0);
			const cross = await readCross();
			record('closeout-move-to-window', { titles, cross, popoutMarks, after: brief(s) });
			// The counting really wraps Tabstrip's observers (each chip gets its first notification) ...
			expect(cross?.pluginTotal).toBeGreaterThan(0);
			// ... and none of them was ever about an element in the pop-out document.
			expect(cross?.plugin).toBe(0);

			// Close-out round 2: group and edit in this pop-out, whose first tab header was made in
			// the main document and carried over by Obsidian. Real right clicks and keys in the pop-out.
			const second = await browser.executeObsidian(
				async ({ app, obsidian }, id, notePath) => {
					const leaf = app.workspace.getLeafById(id);
					const file = app.vault.getFileByPath(notePath);
					if (!leaf || !(file instanceof obsidian.TFile)) throw new Error('moved leaf or note missing');
					app.workspace.setActiveLeaf(leaf, { focus: true });
					const next = app.workspace.getLeaf('tab');
					await next.openFile(file);
					return (next as unknown as { id: string }).id;
				},
				ids.n2,
				'Daily/2026-11-08.md',
			);
			s = await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 2 && st.leafIds[0] === ids.n2 && st.leafIds[1] === second), 'second tab in the moved pop-out');
			// "Move to new window" opens a 600 x 600 window. A note tab's menu (28 items with ours) is
			// taller than that; Obsidian clips it, and a WebDriver click on an item of a clipped menu
			// does nothing, with or without Tabstrip (checked with Obsidian's own "Pin" item and the
			// plugin disabled in a 480 px tall window). So the test makes the window as tall as the others.
			await browser.executeObsidian(({ app }, id) => {
				app.workspace.getLeafById(id)?.getContainer().win.resizeTo(1024, 800);
			}, ids.n2);
			await browser.pause(500);
			const popHandle = await windowHandleWith(headerSel(ids.n2));
			if (popHandle === null) throw new Error('no WebDriver handle for the moved pop-out');
			const mainHandle = await browser.getWindowHandle();
			let popGroup = '';
			let popBubble: Awaited<ReturnType<typeof bubbleGeometry>> | null = null;
			try {
				await browser.switchToWindow(popHandle);
				await $(titleSel(ids.n2)).click({ button: 'right' });
				await waitForMenu();
				await clickMenuItem('Add tab to new group');
				await browser.switchToWindow(mainHandle);
				s = await waitForState((x) => x.editor.open && x.editor.doc === 'popout' && x.editor.inputFocused && groupOf(x, ids.n2) !== null, 'bubble in the moved pop-out');
				popGroup = groupOf(s, ids.n2) ?? '';
				expect(s.state.groups.find((g) => g.id === popGroup)?.color).toBe('grey');
				expectBubblePlaced(await bubbleGeometry(popGroup));
				await browser.switchToWindow(popHandle);
				await browser.keys(['移出 Moved', Key.Enter]);
				await browser.switchToWindow(mainHandle);
				s = await waitForState((x) => !x.editor.open && x.state.groups.some((g) => g.id === popGroup && g.name === '移出 Moved'), 'moved pop-out group named');
				await browser.switchToWindow(popHandle);
				await $(titleSel(second)).click({ button: 'right' });
				const secondMenu = await waitForMenu();
				record('closeout-moved-second-menu', { secondMenu });
				await clickMenuItem('Add tab to group: 移出 Moved');
				await browser.switchToWindow(mainHandle);
				s = await waitForState((x) => membersInOrder(x, popGroup).length === 2, 'two members in the moved pop-out');
				expect(membersInOrder(s, popGroup)).toEqual([ids.n2, second]);
				expect(s.state.groups.find((g) => g.id === popGroup)?.name).toBe('移出 Moved');
				expectDecorated(s, popGroup);
				expectContinuousLine(s, popGroup);
				const where = await browser.executeObsidian(
					({ app }, id, gid) => {
						const doc = app.workspace.getLeafById(id)?.getContainer().doc;
						const chip = doc?.querySelector(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
						return {
							isMainDoc: doc === document,
							chips: doc?.querySelectorAll('.tabstrip-chip').length ?? -1,
							lines: doc?.querySelectorAll('.tabstrip-line').length ?? -1,
							chipInThatDoc: chip?.ownerDocument === doc,
							hostInThatDoc: chip?.parentElement?.ownerDocument === doc,
						};
					},
					ids.n2,
					popGroup,
				);
				expect(where).toEqual({ isMainDoc: false, chips: 1, lines: 2, chipInThatDoc: true, hostInThatDoc: true });
				// Rename from the chip menu: the bubble opens in the pop-out, Escape closes it there.
				await browser.switchToWindow(popHandle);
				await $(chipSel(popGroup)).click({ button: 'right' });
				await waitForMenu();
				await clickMenuItem('Rename group');
				await browser.switchToWindow(mainHandle);
				s = await waitForState((x) => x.editor.open && x.editor.doc === 'popout' && x.editor.inputFocused, 'rename bubble in the moved pop-out');
				popBubble = await bubbleGeometry(popGroup);
				expectBubblePlaced(popBubble);
				await browser.switchToWindow(popHandle);
				await shot('closeout-moved-popout-bubble');
				await browser.keys(Key.Escape);
				await browser.switchToWindow(mainHandle);
				s = await waitForState((x) => !x.editor.open, 'moved pop-out bubble closed');
				expect(s.state.groups.find((g) => g.id === popGroup)?.name).toBe('移出 Moved');
			} finally {
				await browser.switchToWindow(mainHandle);
			}
			const crossAfter = await readCross();
			record('closeout-moved-popout-group', { second, popGroup, popBubble, cross: crossAfter, after: brief(s) });
			// Still none of Tabstrip's main-window observers was ever about a pop-out element.
			expect(crossAfter?.plugin).toBe(0);
		} finally {
			await browser.execute(() => {
				const w = window as Window & { e2eCross?: { original: typeof ResizeObserver } };
				if (w.e2eCross) window.ResizeObserver = w.e2eCross.original;
				delete w.e2eCross;
			});
		}
		await closePopout(ids.n2);
		const s = await waitForState((x) => !x.strips.some((st) => st.kind === 'popout'), 'pop-out closed');
		// Its group went with it.
		expect(s.state.members.some((m) => m.leafId === ids.n2)).toBe(false);
		await browser.pause(500);
		const closes = await popoutCloseReports();
		expect(closes[closes.length - 1]?.pluginOwned).toBe(0);
		expect((await strandedObservations(false)).plugin).toBe(0);
		expect(await errorTimeline()).toEqual([]);
		record('closeout-move-to-window-end', { moved: moved === null ? null : brief(moved), final: brief(s) });
	});

	it('pop-out whose stylesheets apply late: the chip text colour is measured again (red and orange: contrast ≥ 4.5)', async function () {
		const { ids: pop, settle } = await openPopoutWithNotes(['Daily/2026-11-08.md', '归档/计划.md']);
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 2), 'pop-out ready');
		// Test-only: switch the pop-out's stylesheets off, as in the first pop-out of a session before
		// its stylesheets have loaded, and make two one-tab groups there in the same task. Each
		// colour catches one way of getting this wrong (palette review round 1):
		// - red: its ink is the light one, while a measurement taken on the unstyled page reads a
		//   transparent fill over white and picks the dark ink. A stale early measurement that was
		//   kept fails on red (dark on red is about 2.65:1).
		// - orange: its ink is the dark one, while the stylesheet's fallback text colour is white
		//   (2.95:1 on light orange). A chip that is never measured again fails on orange.
		// And while the sheets are off, no chip may have an ink at all.
		const LATE = [
			{ color: 'red', name: 'Late 晚' },
			{ color: 'orange', name: 'Late 橙' },
		] as const;
		const early = await browser.executeObsidian(
			({ app }, leafIds, late) => {
				const doc = app.workspace.getLeafById(leafIds[0] ?? '')?.getContainer().doc;
				if (!doc) throw new Error('no pop-out document');
				const sheets = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
					.map((l) => l.sheet)
					.filter((x): x is CSSStyleSheet => x !== null);
				for (const sheet of sheets) sheet.disabled = true;
				(window as Window & { e2eLateSheets?: CSSStyleSheet[] }).e2eLateSheets = sheets;
				const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { group(ids: string[], name: string, color?: string): string | null } } | undefined> } }).plugins.plugins['tabstrip'];
				const groups = late.map((g, i) => {
					const gid = plugin?.debug.group([leafIds[i] ?? ''], g.name, g.color) ?? null;
					const chip = doc.querySelector(`.tabstrip-chip[data-tabstrip-group="${gid ?? ''}"]`);
					return { color: g.color, gid, ink: chip?.getAttribute('data-tabstrip-ink') ?? null };
				});
				return { groups, sheets: sheets.length, styleElements: doc.querySelectorAll('style').length };
			},
			pop,
			LATE.map((g) => ({ ...g })),
		);
		if (early.groups.some((g) => g.gid === null)) throw new Error('no group in the pop-out');
		expect(early.sheets).toBeGreaterThan(0);
		await browser.pause(300);
		const duringState = await pageState();
		const during = early.groups.map((g) => ({ color: g.color, ink: duringState.chips.find((c) => c.groupId === g.gid)?.ink ?? null }));
		await browser.execute(() => {
			const w = window as Window & { e2eLateSheets?: CSSStyleSheet[] };
			for (const sheet of w.e2eLateSheets ?? []) sheet.disabled = false;
			delete w.e2eLateSheets;
		});
		// Wait for the chip text colours of the styled pop-out (measured inks, then the contrast).
		const lateChips = async () => {
			const st = await pageState();
			return early.groups.map((g) => ({ color: g.color, chip: st.chips.find((c) => c.groupId === g.gid) }));
		};
		const settled = (cs: Awaited<ReturnType<typeof lateChips>>) =>
			cs.every(({ chip }) => chip !== undefined && chip.ink !== null && contrastOf(chip.textColor, chip.fill) >= MIN_CONTRAST);
		let chips = await lateChips();
		const deadline = Date.now() + 3000;
		while (!settled(chips) && Date.now() < deadline) {
			await browser.pause(100);
			chips = await lateChips();
		}
		const fills = await expectedFills();
		const final = chips.map(({ color, chip }) => {
			if (!chip) throw new Error(`pop-out ${color} chip gone`);
			const fill = parseCssColor(chip.fill);
			return { color, ink: chip.ink, text: chip.textColor, fill: chip.fill, contrast: contrastOf(chip.textColor, chip.fill), picked: fill === null ? 'unparsable' : pickInk(fill) };
		});
		record('closeout-late-popout-styles', { settle, early, during, final });
		// While the stylesheets were off, no ink was measured (none could be right).
		expect(early.groups.map((g) => g.ink)).toEqual([null, null]);
		expect(during.map((g) => g.ink)).toEqual([null, null]);
		for (const f of final) {
			expect(f.fill).toBe(fills[f.color]);
			// The ink measured on the styled pop-out is the one the colour needs (and the intended one).
			expect(f.ink).toBe(f.picked);
			expect(f.ink).toBe(TARGET_INK.light[f.color]);
			expect(f.contrast).toBeGreaterThanOrEqual(MIN_CONTRAST);
		}
		await closePopout(pop[0] ?? '');
		await waitForState((x) => !x.strips.some((st) => st.kind === 'popout'), 'pop-out closed');
		await browser.pause(500);
		const closes = await popoutCloseReports();
		expect(closes[closes.length - 1]?.pluginOwned).toBe(0);
		expect(await errorTimeline()).toEqual([]);
	});

	// ------------------------------------------------------------------ extra (NICE)

	it('extra: "Restore native tab bar" removes every trace until "Show tab groups again"', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3']);
		const gid = await makeGroup([ids.n2, ids.n3], 'Native 原生');
		let s = await waitForState((x) => x.chips.some((c) => c.groupId === gid), 'chip');
		expect((await residue()).found.length).toBeGreaterThan(0);
		expect(await commandAvailable('tabstrip:show-tab-groups')).toBe(false);
		expect(await runCommand('tabstrip:restore-native-tab-bar')).toBe(true);
		await browser.pause(200);
		expect(await residue()).toEqual({ docs: 1, found: [] });
		// No group items in the tab menu, no group commands meanwhile.
		await $(titleSel(ids.n1)).click({ button: 'right' });
		const titles = await waitForMenu();
		expect(titles.filter((t) => t.includes('group'))).toEqual([]);
		await closeMenus();
		expect(await commandAvailable(CMD.add)).toBe(false);
		// Layout changes meanwhile do not bring the decoration back.
		await setActive(ids.n2);
		await browser.pause(200);
		expect((await residue()).found).toEqual([]);
		expect(await runCommand('tabstrip:show-tab-groups')).toBe(true);
		s = await waitForState((x) => x.chips.some((c) => c.groupId === gid), 'chip back');
		expectDecorated(s, gid);
		record('extra-native', { titles });
	});

	it('extra: stacked tabs keep the colour; no group items for pinned or sidebar tabs; undo close gives no error', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4']);
		const gid = await makeGroup([ids.n2, ids.n3], 'Stack 叠');
		await setActive(ids.n1);
		await waitForState((x) => x.chips.some((c) => c.groupId === gid), 'chip');

		// Stacked tabs (native command): no crash, members keep a coloured line, the chip is hidden.
		expect(await runCommand('workspace:toggle-stacked-tabs')).toBe(true);
		let s = await waitForState((x) => mainStrip(x).stacked, 'stacked');
		const stacked = await browser.execute((groupId) => {
			const lines = Array.from(document.querySelectorAll<HTMLElement>(`.workspace-tab-header[data-tabstrip-group="${groupId}"] > .tabstrip-line`));
			const chip = document.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${groupId}"]`);
			const host = chip?.parentElement;
			return {
				lines: lines.map((l) => ({ w: l.getBoundingClientRect().width, h: l.getBoundingClientRect().height, bg: getComputedStyle(l).backgroundColor })),
				chipDisplay: chip ? getComputedStyle(chip).display : null,
				hostMargin: host ? getComputedStyle(host).marginInlineStart : null,
			};
		}, gid);
		const stackedShot = await shot('extra-1-stacked');
		expect(stacked.lines).toHaveLength(2);
		const stackColor = s.state.groups.find((g) => g.id === gid)?.color ?? 'grey';
		const stackFill = (await expectedFills())[stackColor];
		for (const l of stacked.lines) {
			expect(l.w).toBeGreaterThan(0);
			expect(l.h).toBeGreaterThan(0);
			expect(l.bg).toBe(stackFill);
		}
		expect(stacked.chipDisplay).toBe('none');
		expect(stacked.hostMargin).toBe('0px');
		expect(membersInOrder(s, gid)).toEqual([ids.n2, ids.n3]);

		// The editor bubble in a stacked strip opens beside the first member's header, not in the
		// window corner: the chip is hidden there (close-out round 1). Real right-click on a
		// stacked tab, real click on "Add tab to new group".
		await $(titleSel(ids.n1)).click({ button: 'right' });
		await waitForMenu();
		await clickMenuItem('Add tab to new group');
		s = await waitForState((x) => x.editor.open && groupOf(x, ids.n1) !== null, 'stacked: bubble for a new group');
		const stackedGroup = groupOf(s, ids.n1) ?? '';
		const stackedBubble = await bubbleGeometry(stackedGroup);
		expectBubblePlaced(stackedBubble);
		const stackedBubbleShot = await shot('extra-2-stacked-bubble');
		await browser.keys(Key.Escape);
		s = await waitForState((x) => !x.editor.open, 'stacked bubble closed');
		const stackedFocus = await focusInfo();
		expect(stackedFocus).toMatchObject({ body: false, inActiveView: true });
		expect(await runCommand(CMD.remove)).toBe(true);
		s = await waitForState((x) => groupOf(x, ids.n1) === null, 'n1 out of its group again');

		// A bubble that is open while the strip turns back to normal tabs follows its chip under the strip.
		await setActive(ids.n2);
		expect(await runCommand(CMD.rename)).toBe(true);
		s = await waitForState((x) => x.editor.open && x.editor.groupId === gid, 'rename bubble in the stacked strip');
		const stackedRename = await bubbleGeometry(gid);
		expectBubblePlaced(stackedRename);
		expect(await runCommand('workspace:toggle-stacked-tabs')).toBe(true);
		s = await waitForState((x) => !mainStrip(x).stacked && x.editor.open, 'unstacked with the bubble open');
		await browser.pause(200);
		const unstackedRename = await bubbleGeometry(gid);
		expect(unstackedRename.chipDisplay).not.toBe('none');
		expectBubblePlaced(unstackedRename);
		await browser.keys(Key.Escape);
		s = await waitForState((x) => !x.editor.open, 'bubble closed after unstacking');
		expectDecorated(s, gid);
		await setActive(ids.n1);

		// Pinned tab: its tab menu has no group items.
		await setPinned(ids.n4, true);
		s = await waitForState((x) => mainStrip(x).leafIds[0] === ids.n4, 'pinned first');
		await $(titleSel(ids.n4)).click({ button: 'right' });
		const pinnedTitles = await waitForMenu();
		expect(pinnedTitles).toContain('Unpin');
		expect(pinnedTitles.filter((t) => t.includes('group'))).toEqual([]);
		await closeMenus();
		await setPinned(ids.n4, false);

		// Sidebar tab header: no group items either.
		await browser.executeObsidian(({ app }) => {
			app.workspace.leftSplit.expand();
		});
		await browser.pause(300);
		const sidebarHeader = await browser.execute(() => {
			const h = document.querySelector('.mod-left-split .workspace-tab-header');
			h?.setAttribute('data-e2e-sidebar', '1');
			return h !== null;
		});
		expect(sidebarHeader).toBe(true);
		await $('.mod-left-split .workspace-tab-header[data-e2e-sidebar="1"]').click({ button: 'right' });
		const sidebarTitles = await waitForMenu();
		expect(sidebarTitles.filter((t) => t.includes('group'))).toEqual([]);
		await closeMenus();
		await browser.execute(() => document.querySelector('[data-e2e-sidebar]')?.removeAttribute('data-e2e-sidebar'));

		// Undo close of a member (restoring it to its group is step L6): only "no error" here.
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.detach();
		}, ids.n3);
		s = await waitForState((x) => !mainStrip(x).leafIds.includes(ids.n3), 'member closed');
		expect(await runCommand('workspace:undo-close-pane')).toBe(true);
		s = await waitForState((x) => mainStrip(x).leafIds.includes(ids.n3), 'undo close');
		await browser.pause(300);
		s = await pageState();
		for (const g of s.state.groups) expectContiguous(s, g.id);
		expect(s.stats.loopStops).toBe(0);
		expect(await errorTimeline()).toEqual([]);
		record('extra-stacked-menus-undo', {
			stacked,
			stackedShot,
			stackedBubble,
			stackedBubbleShot,
			stackedFocus,
			stackedRename,
			unstackedRename,
			pinnedTitles,
			sidebarTitles,
			afterUndo: brief(s),
		});
	});

	// ------------------------------------------------------------------ E8

	it('E8 disabling leaves no trace in the main window or a pop-out; enabling again works', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4']);
		await makeGroup([ids.n2, ids.n3], 'Main 组');
		// Opened with the public API (close-out round 2).
		const { result: pop, warm } = await withWarmPopout(() => openPopoutLeafWithNotes(['Daily/2026-11-08.md', '归档/计划.md']));
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 2), 'pop-out ready');
		await makeGroup(pop, '');
		// An open editor bubble too.
		await setActive(ids.n2);
		expect(await runCommand(CMD.rename)).toBe(true);
		let s = await waitForState((x) => x.chips.length === 2 && x.editor.open, 'decorated in both windows, bubble open');

		const beforeDisable = await residue();
		expect(beforeDisable.docs).toBe(2);
		expect(beforeDisable.found.length).toBeGreaterThan(0);
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins.disablePlugin('tabstrip');
		});
		const afterDisable = await residue();
		expect(afterDisable).toEqual({ docs: 2, found: [] });
		const disabledShot = await shot('e8-1-disabled-native');

		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { enablePlugin(id: string): Promise<boolean> } }).plugins.enablePlugin('tabstrip');
		});
		await browser.pause(500);
		// Step L6: enabling again restores the groups saved when the plugin was disabled.
		const restoredGroups = (await waitForState((x) => x.state.groups.length === 2 && x.chips.length === 2, 'groups restored after enabling')).state.groups;
		expect(restoredGroups.map((g) => g.name).sort()).toEqual(['', 'Main 组']);
		await setActive(ids.n3);
		expect(await runCommand(CMD.add)).toBe(true);
		s = await waitForState((x) => x.state.groups.length === 3 && x.editor.open && x.chips.length === 3, 'works again after enabling');
		await browser.keys(Key.Escape);
		s = await waitForState((x) => !x.editor.open, 'bubble closed');
		await closePopout(pop[0] ?? '');
		s = await waitForState((x) => !x.strips.some((st) => st.kind === 'popout'), 'pop-out closed');
		await browser.pause(500);
		const closes = await popoutCloseReports();
		const close = closes[closes.length - 1];
		expect(close?.pluginOwned).toBe(0);
		expect((await strandedObservations(false)).plugin).toBe(0);
		expect(await errorTimeline()).toEqual([]);
		record('E8', { opened: 'workspace.openPopoutLeaf', warm, beforeDisable: beforeDisable.found.length, afterDisable, screenshot: disabledShot, popoutClose: close, final: brief(s) });
	});

	it('no console errors or warnings during the whole run', async function () {
		const errors = await errorTimeline();
		const popoutCloses = await popoutCloseReports();
		const logs = (await browser.getLogs('browser')) as { level: string; message: string }[];
		const severe = logs.filter((l) => l.level === 'SEVERE' || l.level === 'WARNING');
		record('console', { errors, popoutCloses, severe: severe.map((l) => `${l.level} ${l.message.slice(0, 300)}`) });
		expect(errors).toEqual([]);
		expect(popoutCloses.length).toBeGreaterThanOrEqual(2);
		expect(popoutCloses.every((c) => c.pluginOwned === 0)).toBe(true);
		expect(severe.filter((l) => /tabstrip/i.test(l.message))).toEqual([]);
	});

	// ------------------------------------------------------------------ control (runs last)

	it('control: without Tabstrip, Obsidian alone strands observers on a closed pop-out and the main window reports the loop', async function () {
		await browser.executeObsidian(async ({ app }) => {
			await (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins.disablePlugin('tabstrip');
		});
		const loaded = await browser.executeObsidian(({ app }) => (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins['tabstrip'] !== undefined);
		expect(loaded).toBe(false);
		await setPopoutCleanup(false);
		try {
			const errorCount = async () => (await readErrors()).length;
			const start = await errorCount();
			// Two notes in a new pop-out, the second one active: the state in which the sandbox
			// showed the loop in every run, with and without Tabstrip.
			const { ids: pop } = await openPopoutWithNotes(['Daily/2026-11-08.md', '归档/计划.md']);
			await browser.pause(800);
			await closePopout(pop[0] ?? '');
			await browser.pause(1000);
			const during = (await readErrors()).slice(start);
			const closes = await popoutCloseReports();
			const close = closes[closes.length - 1];
			const stranded = await strandedObservations(true);
			// Let a frame that was already under way finish, then nothing more may come.
			await browser.pause(200);
			const mark = await errorCount();
			await browser.pause(1000);
			const afterRemoval = (await readErrors()).slice(mark);
			record('control-popout-close', {
				loopMessagesIn1s: during.length,
				otherMessages: during.filter((m) => m !== RO_LOOP_MESSAGE),
				strandedObsidianObservations: stranded.obsidian,
				strandedPluginObservations: stranded.plugin,
				close,
				afterRemovalIn1s: afterRemoval.length,
			});
			expect(close?.cleanup).toBe(false);
			expect(during.filter((m) => m !== RO_LOOP_MESSAGE)).toEqual([]);
			expect(stranded.plugin).toBe(0);
			// Every loop message is explained by Obsidian's stranded observations: removing them stops it.
			if (during.length > 0) expect(stranded.obsidian.length).toBeGreaterThan(0);
			expect(afterRemoval).toEqual([]);
		} finally {
			await setPopoutCleanup(true);
		}
	});
});
