/**
 * Chrome-like group colours (between L4/L5 and L6).
 *
 * Every fill is an Obsidian colour variable mixed in OKLab towards black (light mode) or white
 * (dark mode) by an amount from styles.css. This spec checks, on live computed colours in the
 * sandbox: the fill each surface gets (chip, underline, dot, stacked bar, bubble and menu
 * swatches), the chip text colour and its contrast, and that the nine colours stay apart.
 *
 * Report screenshots: TABSTRIP_WRITE_DOCS=1 npm run e2e -- --spec test/e2e/specs/palette.e2e.ts
 * (1.15.0, default background mode). Otherwise they go to .e2e-state/palette-screens/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { GROUP_COLORS, type GroupColor } from '../../../src/core/types';
import { contrast, MIN_CONTRAST, parseCssColor } from '../../../src/ui/color';
import {
	chipSel,
	closeMenus,
	makeGroup,
	openNotes,
	readErrors,
	record,
	repoRoot,
	runCommand,
	setActive,
	setLook,
	setPinned,
	setTheme,
	setUserLayout,
	shot,
	startErrorWatch,
	waitForMenu,
	waitForState,
	writeEvidence,
	type PageState,
} from '../helpers';
import { closestPair, deltaE, expectedFillCss, MIN_DELTA_E, TARGET_INK, type Srgb } from '../palette';
import { decodePng, pixelAt } from '../png';

const LOOKS = [
	{ theme: 'default', dark: false },
	{ theme: 'default', dark: true },
	{ theme: 'Atom', dark: false },
	{ theme: 'Atom', dark: true },
] as const;
const keyOf = (look: { theme: string; dark: boolean }) => `${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`;
const NAMES = ['灰色', '蓝色', '红色', '黄色', '绿色', '粉色', '紫色', '青色', '橙色'];
const ROLES = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'] as const;

function rgbOf(css: string): Srgb {
	const c = parseCssColor(css);
	if (c === null) throw new Error(`unparsable colour ${css}`);
	if (c.a < 1) throw new Error(`translucent colour ${css}`);
	return c;
}

function contrastOf(a: string, b: string): number {
	return contrast({ ...rgbOf(a), a: 1 }, { ...rgbOf(b), a: 1 });
}

/** What each colour's fill computes to in this window: the intended expression on a test probe. */
async function expectedFills(mode: 'light' | 'dark'): Promise<Record<string, string>> {
	const css = Object.fromEntries(GROUP_COLORS.map((c) => [c, expectedFillCss(c, mode)]));
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

/** A colour as the page paints it in sRGB (1x1 canvas), independent of the plugin's own conversion. */
async function paintedRgb(colors: string[]): Promise<Srgb[]> {
	return browser.execute((list) => {
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('no 2d context');
		return list.map((c) => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = '#000000';
			ctx.fillStyle = c;
			ctx.fillRect(0, 0, 1, 1);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0 };
		});
	}, colors);
}

/** Computed background of each swatch (by colour) in the open bubble or menu. */
async function swatchFills(scope: '.tabstrip-editor' | '.menu'): Promise<Record<string, string>> {
	return browser.execute((sel) => {
		const out: Record<string, string> = {};
		for (const s of Array.from(document.querySelectorAll<HTMLElement>(`${sel} .tabstrip-swatch`))) out[s.getAttribute('data-tabstrip-color') ?? '?'] = getComputedStyle(s).backgroundColor;
		return out;
	}, scope);
}

/** Pointer over the note, so no chip tooltip shows in a screenshot. */
async function pointerAway(): Promise<void> {
	await browser.action('pointer').move({ x: 500, y: 500, duration: 0 }).perform();
	await browser.pause(400);
}

/** Pixels of each chip's fill in a screenshot (left inner edge, vertical middle; 3x3 average). */
function chipPixels(file: string, s: PageState, scale: number, groupIds: readonly string[]): Srgb[] {
	const img = decodePng(fs.readFileSync(path.join(repoRoot, file)));
	return groupIds.map((gid) => {
		const chip = s.chips.find((c) => c.groupId === gid);
		if (!chip) throw new Error(`no chip ${gid}`);
		const cx = Math.round((chip.rect.left + 3) * scale);
		const cy = Math.round(((chip.rect.top + chip.rect.bottom) / 2) * scale);
		const acc = { r: 0, g: 0, b: 0 };
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const [r, g, b] = pixelAt(img, cx + dx, cy + dy);
				acc.r += r / 9;
				acc.g += g / 9;
				acc.b += b / 9;
			}
		}
		return acc;
	});
}

describe('Chrome-like group colours (palette)', function () {
	before(async function () {
		await startErrorWatch();
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
		});
	});

	after(function () {
		writeEvidence('palette');
	});

	it('color-mix() in OKLab is supported by this Obsidian build (exit condition of the step)', async function () {
		const support = await browser.execute(() => ({
			oklab: CSS.supports('color', 'color-mix(in oklab, red, black 10%)'),
			withVar: CSS.supports('background-color', 'color-mix(in oklab, var(--color-red), white 0%)'),
			chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null,
			electron: /Electron\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null,
		}));
		record('palette-support', { obsidian: browser.getObsidianVersion(), ...support });
		expect({ oklab: support.oklab, withVar: support.withVar }).toEqual({ oklab: true, withVar: true });
	});

	it('the user scene in four looks, expanded and collapsed: chip, underline and dot fills are the mixed colours', async function () {
		this.timeout(180_000);
		const ids = await openNotes([...ROLES]);
		await setPinned(ids.n1, true);
		await waitForState((x) => x.strips[0]?.pinned[0] === true, 'pinned');
		const g = {
			research: await makeGroup([ids.n2, ids.n3], '研究 Research', 'blue'),
			dot: await makeGroup([ids.n5], '', 'green'),
			long: await makeGroup([ids.n7, ids.n8], '很长很长的中文组名用来测试省略号效果', 'purple'),
			work: await makeGroup([ids.n9], 'Work', 'orange'),
		};
		const colorOf: Record<string, GroupColor> = { [g.research]: 'blue', [g.dot]: 'green', [g.long]: 'purple', [g.work]: 'orange' };
		await setActive(ids.n4);
		const setCollapsed = (gid: string, v: boolean) =>
			browser.executeObsidian(
				({ app }, id, value) => {
					const plugin = (app as unknown as { plugins: { plugins: Record<string, { debug: { setCollapsed(id: string, c: boolean): boolean } } | undefined> } }).plugins.plugins['tabstrip'];
					if (!plugin) throw new Error('tabstrip not loaded');
					plugin.debug.setCollapsed(id, value);
				},
				gid,
				v,
			);
		const out: Record<string, unknown> = {};
		for (const look of LOOKS) {
			const key = keyOf(look);
			const mode = look.dark ? 'dark' : 'light';
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			await setCollapsed(g.research, false);
			await setCollapsed(g.dot, false);
			const s = await waitForState((x) => x.chips.length === 4 && x.chips.every((c) => c.unnamed || c.ink !== null), 'four chips with ink');
			const expected = await expectedFills(mode);
			const dot = await browser.execute((sel) => {
				const d = document.querySelector<HTMLElement>(`${sel} .tabstrip-chip-dot`);
				return d ? getComputedStyle(d).backgroundColor : '';
			}, chipSel(g.dot));
			const rows = s.chips.map((c) => {
				const color = colorOf[c.groupId ?? ''] ?? 'grey';
				const lines = s.lines.filter((l) => l.groupId === c.groupId).map((l) => l.color);
				return { color, unnamed: c.unnamed, fill: c.fill, expected: expected[color], lines, ink: c.ink, contrast: c.unnamed ? null : Number(contrastOf(c.textColor, c.fill).toFixed(2)) };
			});
			for (const r of rows) {
				expect({ key, color: r.color, lines: r.lines }).toEqual({ key, color: r.color, lines: r.lines.map(() => r.expected) });
				if (r.unnamed) continue;
				expect({ key, color: r.color, fill: r.fill, ink: r.ink }).toEqual({ key, color: r.color, fill: r.expected, ink: TARGET_INK[mode][r.color] });
				expect(r.contrast ?? 0).toBeGreaterThanOrEqual(MIN_CONTRAST);
			}
			expect({ key, dot }).toEqual({ key, dot: expected.green });
			await browser.execute(() => document.fonts.ready);
			await pointerAway();
			const expandedShot = await shot(`look-${key}-expanded`, 'palette');
			await setCollapsed(g.research, true);
			await setCollapsed(g.dot, true);
			const c = await waitForState((x) => x.chips.filter((ch) => ch.groupId === g.research || ch.groupId === g.dot).length === 2, 'collapsed chips');
			const research = c.chips.find((ch) => ch.groupId === g.research);
			expect({ key, fill: research?.fill, ink: research?.ink }).toEqual({ key, fill: expected.blue, ink: TARGET_INK[mode].blue });
			await pointerAway();
			const collapsedShot = await shot(`look-${key}-collapsed`, 'palette');
			out[key] = { rows, dot, expandedShot, collapsedShot };
		}
		await setCollapsed(g.research, false);
		await setCollapsed(g.dot, false);
		record('palette-scene', out);
		expect(await readErrors()).toEqual([]);
	});

	it('nine colours in four looks: fills, swatches, text 4.5:1 with the Chrome-like text colour, all apart (live colours and screenshot pixels)', async function () {
		this.timeout(240_000);
		const ids = await openNotes([...ROLES]);
		await setPinned(ids.n1, false);
		const groupIds: string[] = [];
		for (const [i, color] of GROUP_COLORS.entries()) groupIds.push(await makeGroup([ids[ROLES[i] ?? 'n1']], NAMES[i] ?? color, color));
		await setActive(ids.n1);
		const out: Record<string, unknown> = {};
		const table: Record<string, unknown>[] = [];
		for (const look of LOOKS) {
			const key = keyOf(look);
			const mode = look.dark ? 'dark' : 'light';
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			const s = await waitForState((x) => x.chips.length === 9 && x.chips.every((c) => c.ink !== null), 'nine chips with ink');
			const expected = await expectedFills(mode);
			const chips = GROUP_COLORS.map((color, i) => {
				const chip = s.chips.find((c) => c.groupId === groupIds[i]);
				const line = s.lines.find((l) => l.groupId === groupIds[i]);
				if (!chip || !line) throw new Error(`no chip or line for ${color}`);
				return { color, chip, line };
			});
			const painted = await paintedRgb(chips.flatMap((c) => [c.chip.textColor, c.chip.fill]));
			const rows = chips.map(({ color, chip, line }, i) => {
				const text = painted[2 * i];
				const fill = painted[2 * i + 1];
				if (!text || !fill) throw new Error('painted colour missing');
				return {
					color,
					fill: chip.fill,
					expected: expected[color],
					line: line.color,
					ink: chip.ink,
					target: TARGET_INK[mode][color],
					text: chip.textColor,
					// Parsed by the plugin's own converter, and painted on a canvas (independent).
					contrast: Number(contrastOf(chip.textColor, chip.fill).toFixed(2)),
					contrastPainted: Number(contrast({ ...text, a: 1 }, { ...fill, a: 1 }).toFixed(2)),
				};
			});
			for (const r of rows) {
				expect({ key, color: r.color, fill: r.fill, line: r.line, ink: r.ink }).toEqual({ key, color: r.color, fill: r.expected, line: r.expected, ink: r.target });
				expect({ key, color: r.color, ok: r.contrast >= MIN_CONTRAST && r.contrastPainted >= MIN_CONTRAST }).toEqual({ key, color: r.color, ok: true });
				table.push({ look: key, color: r.color, ink: r.ink, contrast: r.contrast, contrastPainted: r.contrastPainted, fill: r.fill });
			}
			// The nine fills stay apart (live computed colours).
			const live = closestPair(rows.map((r) => ({ name: r.color, rgb: rgbOf(r.fill) })));
			expect({ key, apart: live.deltaE >= MIN_DELTA_E }).toEqual({ key, apart: true });

			// Screenshot: adjacent chips are distinct in the painted pixels too.
			await pointerAway();
			const file = await shot(`colours-nine-${key}`, 'palette');
			const scale = await browser.execute(() => window.devicePixelRatio);
			const pixels = chipPixels(file, s, scale, groupIds);
			const adjacent = pixels.slice(1).map((p, i) => ({ pair: `${GROUP_COLORS[i] ?? ''}/${GROUP_COLORS[i + 1] ?? ''}`, deltaE: Number(deltaE(pixels[i] ?? p, p).toFixed(1)) }));
			const minAdjacent = Math.min(...adjacent.map((a) => a.deltaE));
			expect({ key, minAdjacent: minAdjacent >= MIN_DELTA_E }).toEqual({ key, minAdjacent: true });
			const screenshotClosest = closestPair(pixels.map((rgb, i) => ({ name: GROUP_COLORS[i] ?? '', rgb })));

			// Editor bubble and chip menu: the swatches use the same fills.
			await setActive(ids.n2);
			expect(await runCommand('tabstrip:rename-group')).toBe(true);
			await waitForState((x) => x.editor.open, 'bubble');
			const bubble = await swatchFills('.tabstrip-editor');
			let bubbleShot: string | null = null;
			if (look.theme === 'Atom') bubbleShot = await shot(`bubble-${key}`, 'palette');
			await browser.keys('Escape');
			await waitForState((x) => !x.editor.open, 'bubble closed');
			await $(chipSel(groupIds[1] ?? '')).click({ button: 'right' });
			await waitForMenu();
			const menu = await swatchFills('.menu');
			let menuShot: string | null = null;
			if (look.theme === 'Atom') menuShot = await shot(`menu-chip-${key}`, 'palette');
			await closeMenus();
			expect({ key, bubble }).toEqual({ key, bubble: expected });
			expect({ key, menu }).toEqual({ key, menu: expected });
			await setActive(ids.n1);

			out[key] = {
				rows,
				closestLive: { ...live, deltaE: Number(live.deltaE.toFixed(1)), oklab: Number(live.oklab.toFixed(1)), hueGap: Number(live.hueGap.toFixed(0)) },
				closestScreenshot: { ...screenshotClosest, deltaE: Number(screenshotClosest.deltaE.toFixed(1)) },
				adjacent,
				file,
				bubbleShot,
				menuShot,
			};
		}
		record('palette-nine', out);
		record('palette-contrast-table', table);

		// Stacked tabs: the colour bar uses the same fill (default light).
		await setLook('default', false);
		expect(await runCommand('workspace:toggle-stacked-tabs')).toBe(true);
		const st = await waitForState((x) => x.strips[0]?.stacked === true, 'stacked');
		const expected = await expectedFills('light');
		const bars = GROUP_COLORS.map((color, i) => ({ color, bar: st.lines.find((l) => l.groupId === groupIds[i])?.color ?? '' }));
		await shot('stacked-default-light', 'palette');
		expect(await runCommand('workspace:toggle-stacked-tabs')).toBe(true);
		await waitForState((x) => x.strips[0]?.stacked === false, 'not stacked');
		expect(bars).toEqual(GROUP_COLORS.map((color) => ({ color, bar: expected[color] })));
		expect(await readErrors()).toEqual([]);
	});

	it('other themes (Cupertino, Blue Topaz, Minimal; light): their colours flow through, chip text ≥ 4.5', async function () {
		this.timeout(180_000);
		const installed = await browser.executeObsidian(({ app }) => Object.keys((app as unknown as { customCss: { themes: Record<string, unknown> } }).customCss.themes));
		const themes = ['Cupertino', 'Blue Topaz', 'Minimal'];
		const missing = themes.filter((name) => !installed.includes(name));
		if (missing.length > 0) throw new Error(`themes not installed in the sandbox (copied from the user's vault by wdio.conf.mts): ${missing.join(', ')}`);
		const ids = await openNotes([...ROLES]);
		const groupIds: string[] = [];
		for (const [i, color] of GROUP_COLORS.entries()) groupIds.push(await makeGroup([ids[ROLES[i] ?? 'n1']], NAMES[i] ?? color, color));
		await setActive(ids.n1);
		const out: Record<string, unknown> = {};
		const problems: unknown[] = [];
		try {
			for (const theme of themes) {
				await setTheme(theme);
				await setUserLayout(true);
				const s = await waitForState((x) => x.chips.length === 9 && x.chips.every((c) => c.ink !== null), `${theme}: nine chips with ink`);
				const expected = await expectedFills('light');
				const painted = await paintedRgb(s.chips.flatMap((c) => [c.textColor, c.fill]));
				const rows = GROUP_COLORS.map((color, i) => {
					const idx = s.chips.findIndex((c) => c.groupId === groupIds[i]);
					const chip = s.chips[idx];
					const text = painted[2 * idx];
					const fill = painted[2 * idx + 1];
					if (!chip || !text || !fill) throw new Error(`${theme}: no chip for ${color}`);
					return { color, fill: chip.fill, expected: expected[color], ink: chip.ink, contrast: Number(contrast({ ...text, a: 1 }, { ...fill, a: 1 }).toFixed(2)) };
				});
				for (const r of rows) {
					if (r.fill !== r.expected) problems.push({ theme, color: r.color, fill: r.fill, expected: r.expected });
					if (r.contrast < MIN_CONTRAST) problems.push({ theme, color: r.color, contrast: r.contrast });
				}
				await pointerAway();
				const file = await shot(`theme-${theme.toLowerCase().replace(/\s+/g, '-')}-light`, 'palette');
				out[theme] = { rows, file };
			}
		} finally {
			await setTheme('default');
		}
		record('palette-themes', out);
		expect(problems).toEqual([]);
		expect(await readErrors()).toEqual([]);
	});
});
