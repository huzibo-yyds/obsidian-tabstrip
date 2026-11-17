/**
 * Step L4, E11: screenshot set for the user's look review (fixture notes only).
 *
 * For the report, run in the regular (focused) sandbox so the window looks like the user's:
 *   TABSTRIP_SANDBOX_ACTIVATION=regular TABSTRIP_WRITE_DOCS=1 npm run e2e -- --spec test/e2e/specs/l4-look.e2e.ts
 * Otherwise the screenshots go to .e2e-state/l4-screens/<version>/<mode>/.
 */
import { $, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';
import { GROUP_COLORS } from '../../../src/core/types';
import { contrast, MIN_CONTRAST, parseCssColor } from '../../../src/ui/color';
import {
	chipSel,
	closeMenus,
	dividerPaint,
	expectContinuousLine,
	headerSel,
	makeGroup,
	openNotes,
	pageState,
	readErrors,
	record,
	runCommand,
	setActive,
	setLook,
	setPinned,
	setTheme,
	setUserLayout,
	shot,
	startErrorWatch,
	titleSel,
	underlinePaint,
	waitForMenu,
	waitForState,
	writeEvidence,
	type PageState,
	type Role,
} from '../helpers';

const LONG_NAME = '很长很长的中文组名用来测试省略号效果';
const LOOKS = [
	{ theme: 'default', dark: false },
	{ theme: 'default', dark: true },
	{ theme: 'Atom', dark: false },
	{ theme: 'Atom', dark: true },
] as const;

function contrastOf(a: string, b: string): number {
	const x = parseCssColor(a);
	const y = parseCssColor(b);
	if (x === null || y === null) throw new Error(`unparsable colour ${a} / ${b}`);
	return contrast(x, y);
}

/** Community themes from the user's vault (copied read-only by wdio.conf.mts), with style variants. */
const OTHER_THEMES = [
	// Every tab header gets `margin: auto 0` with a high specificity.
	{ theme: 'Cupertino', bodyClass: null, key: 'cupertino', marginRuleOn: 'middle' },
	// The first header of the main area gets `margin-left: 1rem`.
	{ theme: 'Blue Topaz', bodyClass: null, key: 'blue-topaz', marginRuleOn: 'start' },
	// Style Settings "Safari" tabs: every header `margin-left: 12px` and a shorter header.
	{ theme: 'Blue Topaz', bodyClass: 'safari-tab-style', key: 'blue-topaz-safari', marginRuleOn: 'middle' },
	{ theme: 'Minimal', bodyClass: null, key: 'minimal', marginRuleOn: null },
	// Minimal's "Modern" tabs: every header `margin-left: 4px`, 26px tall.
	{ theme: 'Minimal', bodyClass: 'tabs-modern', key: 'minimal-modern', marginRuleOn: 'middle' },
] as const;
const VARIANT_CLASSES = ['safari-tab-style', 'tabs-modern'];

/** What the reviewer should see in the main scene, measured in the page. */
async function sceneFacts(longGroup: string, dotGroup: string) {
	return browser.execute(
		(longSel, dotSel) => {
			const long = document.querySelector<HTMLElement>(`${longSel} .tabstrip-chip-label`);
			const dot = document.querySelector<HTMLElement>(`${dotSel} .tabstrip-chip-dot`);
			const chips = Array.from(document.querySelectorAll<HTMLElement>('.tabstrip-chip'));
			const fontSize = long ? parseFloat(getComputedStyle(long).fontSize) : NaN;
			return {
				longTruncated: long !== null && long.scrollWidth > long.clientWidth,
				longChipWidthEm: long?.parentElement ? long.parentElement.getBoundingClientRect().width / fontSize : NaN,
				dotSize: dot ? { w: dot.getBoundingClientRect().width, h: dot.getBoundingClientRect().height, display: getComputedStyle(dot).display } : null,
				// The header margin (slot) equals the measured chip width plus 4px on each side.
				slotsMatch: chips.every((c) => {
					const slot = parseFloat(c.parentElement?.style.getPropertyValue('--tabstrip-chip-slot') ?? '');
					return Math.abs(slot - (Math.ceil(c.getBoundingClientRect().width) + 8)) < 0.5;
				}),
				fontsReady: document.fonts.status,
				docFocused: document.hasFocus(),
			};
		},
		chipSel(longGroup),
		chipSel(dotGroup),
	);
}

/**
 * How the chip holder's tab looks: everything a theme may change on a tab when it is hovered
 * (header, its curved feet, inner box, title, icon, close button). Close-out round 2
 * (hover-fix-theme-hover-rules): hovering the chip must leave all of it as it is.
 */
async function tabLook(groupId: string) {
	return browser.execute((sel) => {
		const chip = document.querySelector<HTMLElement>(sel);
		const h = chip?.parentElement;
		const inner = h?.querySelector('.workspace-tab-header-inner');
		const title = h?.querySelector('.workspace-tab-header-inner-title');
		const icon = h?.querySelector('.workspace-tab-header-inner-icon');
		const close = h?.querySelector('.workspace-tab-header-inner-close-button');
		if (!chip || !h || !inner || !title || !close) throw new Error('header parts missing');
		const pick = (cs: CSSStyleDeclaration, props: string[]) => Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
		const box = ['background-color', 'box-shadow', 'opacity', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'outline-style', 'color'];
		const feet = ['display', 'background-color', 'box-shadow', 'opacity', 'clip-path'];
		const closeCs = getComputedStyle(close);
		return {
			header: pick(getComputedStyle(h), box),
			before: pick(getComputedStyle(h, '::before'), feet),
			after: pick(getComputedStyle(h, '::after'), feet),
			inner: pick(getComputedStyle(inner), box),
			title: pick(getComputedStyle(title), ['color', 'opacity']),
			icon: icon ? pick(getComputedStyle(icon), ['color', 'opacity']) : null,
			// A hidden close button's colour does not show.
			close: closeCs.display === 'none' ? { display: 'none' } : pick(closeCs, ['display', 'opacity', 'color', 'visibility']),
			headerHovered: h.matches(':hover'),
			chipHovered: chip.matches(':hover'),
		};
	}, chipSel(groupId));
}

/** A shadow made only of fully transparent layers draws nothing: compare it as 'none'. */
function visible(look: Awaited<ReturnType<typeof tabLook>>) {
	const shadow = (v: string | undefined) => (v === undefined || v === 'none' || v.replace(/rgba\(0, 0, 0, 0\)[^,]*(?:,|$)/g, '').trim() === '' ? 'none' : v);
	const fix = (o: Record<string, string> | null) => (o === null ? null : { ...o, ...('box-shadow' in o ? { 'box-shadow': shadow(o['box-shadow']) } : {}) });
	const clear = (c: string | undefined) => c === undefined || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
	// A curved foot that paints nothing (no shadow, no fill, or not displayed) looks the same whatever its clip.
	const foot = (o: Record<string, string>) => {
		const f: Record<string, string | undefined> = fix(o) ?? {};
		return f['display'] === 'none' || (f['box-shadow'] === 'none' && clear(f['background-color'])) ? { paints: 'nothing' } : f;
	};
	return { header: fix(look.header), before: foot(look.before), after: foot(look.after), inner: fix(look.inner), title: look.title, icon: look.icon, close: look.close };
}

/** The properties that differ between two looks, as part.property: [a, b]. */
function diff(a: ReturnType<typeof visible>, b: ReturnType<typeof visible>): Record<string, [unknown, unknown]> {
	const out: Record<string, [unknown, unknown]> = {};
	for (const part of Object.keys(a) as (keyof typeof a)[]) {
		const x = (a[part] ?? {}) as Record<string, unknown>;
		const y = (b[part] ?? {}) as Record<string, unknown>;
		for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) out[`${part}.${k}`] = [x[k], y[k]];
	}
	return out;
}

/** Waits until no transition or animation runs in the tab strip (theme hover transitions). */
async function stripSettled(): Promise<void> {
	await browser.execute(async () => {
		const running = () =>
			document.getAnimations().filter((a) => {
				const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
				return target !== null && target.closest('.workspace-tab-header-container') !== null;
			}).length;
		const started = performance.now();
		while (running() > 0 && performance.now() - started < 3000) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	});
}

/** A colour as the page paints it in sRGB (1x1 canvas), independent of the plugin's own conversion. */
async function paintedRgb(colors: string[]): Promise<{ r: number; g: number; b: number; a: number }[]> {
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
			return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: (d[3] ?? 0) / 255 };
		});
	}, colors);
}

describe('L4 look review screenshots (E11)', function () {
	let groupIds: Record<string, string> = {};

	before(async function () {
		await startErrorWatch();
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
		});
	});

	after(function () {
		writeEvidence('l4-look');
	});

	it('E11 the user layout in default and Atom, light and dark: pinned tab, four groups, ungrouped tabs between them', async function () {
		const ids = await openNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
		await setPinned(ids.n1, true);
		await waitForState((x) => x.strips[0]?.pinned[0] === true, 'pinned');
		groupIds = {
			research: await makeGroup([ids.n2, ids.n3], '研究 Research', 'blue'),
			dot: await makeGroup([ids.n5], '', 'green'),
			long: await makeGroup([ids.n7, ids.n8], LONG_NAME, 'purple'),
			work: await makeGroup([ids.n9], 'Work', 'orange'),
		};
		await setActive(ids.n3);
		await setUserLayout(true);
		let s: PageState = await waitForState((x) => x.chips.length === 4, 'four chips');
		expect(s.strips[0]?.leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6, ids.n7, ids.n8, ids.n9]);
		const shots: Record<string, unknown> = {};
		for (const look of LOOKS) {
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			s = await waitForState((x) => x.chips.length === 4, 'chips after the look change');
			await browser.execute(() => document.fonts.ready);
			const facts = await sceneFacts(groupIds['long'] ?? '', groupIds['dot'] ?? '');
			const name = `look-${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`;
			shots[name] = { file: await shot(name), facts, chips: s.chips.map((c) => ({ text: c.text, w: Math.round(c.rect.width), fill: c.fill, ink: c.ink })) };
			expect(facts.longTruncated).toBe(true);
			expect(facts.longChipWidthEm).toBeLessThanOrEqual(11.5);
			expect(facts.dotSize?.display).toBe('block');
			expect(facts.slotsMatch).toBe(true);
		}
		record('E11-scene', shots);
	});

	it('tab divider: before the chip, never between the chip and its own tab, every look (screenshot pixels, with control)', async function () {
		// Close-out round 2 (atom-divider-detaches-chip): Atom draws the divider at each tab's start.
		await browser.action('pointer').move({ x: 500, y: 500 }).perform();
		const report: Record<string, unknown> = {};
		for (const look of LOOKS) {
			const key = `${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`;
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			await waitForState((x) => x.chips.length === 4, 'scene');
			const paint = await dividerPaint(`divider-${key}`);
			// Control: without the plugin's mark the divider goes back to the theme's own place
			// (test-only: the class is taken off the chip holders and put back right after).
			const unmarked = await browser.execute(() => {
				const hosts = Array.from(document.querySelectorAll('.workspace-tab-header.tabstrip-divider-start'));
				for (const h of hosts) h.classList.remove('tabstrip-divider-start');
				(window as Window & { e2eUnmarked?: Element[] }).e2eUnmarked = hosts;
				return hosts.length;
			});
			let control: Awaited<ReturnType<typeof dividerPaint>> | null = null;
			try {
				control = await dividerPaint(`divider-${key}-control`);
			} finally {
				await browser.execute(() => {
					const w = window as Window & { e2eUnmarked?: Element[] };
					for (const h of w.e2eUnmarked ?? []) h.classList.add('tabstrip-divider-start');
					delete w.e2eUnmarked;
				});
			}
			const brief = (p: typeof paint) => p.groups.map((g) => ({ g: g.groupId, marked: g.marked, before: g.before, between: g.between, previousActive: g.previous?.active ?? null }));
			report[key] = { file: paint.file, scale: paint.scale, groups: brief(paint), control: { unmarked, groups: brief(control) } };
			expect(paint.groups).toHaveLength(4);
			for (const g of paint.groups) {
				const where = `${key} group ${g.groupId}: ${JSON.stringify({ previous: g.previous, chip: g.chip, host: g.host, colour: g.color, painted: g.painted, rows: g.rows })} ${paint.file}`;
				// Every chip in this scene follows an inactive tab: its divider shows, before the chip.
				expect({ where, previousActive: g.previous?.active ?? null, before: g.before >= 1, between: g.between }).toEqual({ where, previousActive: false, before: true, between: 0 });
			}
			// The plugin marks the chip holders only in a theme that draws the divider at the start.
			expect({ key, marked: paint.groups.filter((g) => g.marked).length }).toEqual({ key, marked: look.theme === 'Atom' ? 4 : 0 });
			// Control: in Atom, unmarked, the divider is back between chip and tab and gone from before it.
			if (look.theme === 'Atom') {
				expect({ key, unmarked, between: control.groups.every((g) => g.between >= 1), before: control.groups.every((g) => g.before === 0) }).toEqual({
					key,
					unmarked: 4,
					between: true,
					before: true,
				});
			} else {
				expect(unmarked).toBe(0);
			}
		}
		record('closeout2-divider', report);
		expect(await readErrors()).toEqual([]);
	});

	for (const look of [
		{ theme: 'Atom', dark: false },
		{ theme: 'default', dark: false },
	] as const) {
		it(`E11 ${look.theme} light: chip menu, editor bubble, tab menu with group items`, async function () {
			const key = `${look.theme.toLowerCase()}-light`;
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			const s = await waitForState((x) => x.chips.length === 4, 'scene');
			const research = groupIds['research'] ?? '';
			const files: string[] = [];

			await $(chipSel(research)).click({ button: 'right' });
			await waitForMenu();
			files.push(await shot(`menu-chip-${key}`));
			await closeMenus();

			const member = s.state.members.find((m) => m.groupId === research)?.leafId ?? '';
			await setActive(member);
			expect(await runCommand('tabstrip:rename-group')).toBe(true);
			await waitForState((x) => x.editor.open, 'bubble');
			files.push(await shot(`bubble-${key}`));
			await browser.keys('Escape');
			await waitForState((x) => !x.editor.open, 'bubble closed');

			const ungrouped = s.strips[0]?.leafIds[3] ?? '';
			await $(titleSel(ungrouped)).click({ button: 'right' });
			const titles = await waitForMenu();
			expect(titles.filter((t) => t.startsWith('Add tab to group:'))).toHaveLength(4);
			files.push(await shot(`menu-tab-${key}`));
			await closeMenus();
			record(`E11-menus-${key}`, { files, tabMenu: titles });
		});
	}

	it('chip focus ring: at least 3:1 against the strip in every look (WCAG 1.4.11)', async function () {
		const research = groupIds['research'] ?? '';
		const out: Record<string, unknown> = {};
		for (const look of LOOKS) {
			const key = `${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`;
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			await waitForState((x) => x.chips.length === 4, 'scene');
			await browser.execute((sel) => {
				document.querySelector<HTMLElement>(sel)?.focus();
			}, chipSel(research));
			// A key press on the focused chip: keyboard use, so the ring shows (:focus-visible).
			await browser.keys(Key.ArrowDown);
			const ring = await browser.execute((sel) => {
				const chip = document.querySelector<HTMLElement>(sel);
				if (!chip) throw new Error('no chip');
				const cs = getComputedStyle(chip);
				// What is behind the ring: the chip sits in its header's margin, so start above the header.
				let background = 'rgba(0, 0, 0, 0)';
				for (let el = chip.parentElement?.parentElement ?? null; el; el = el.parentElement) {
					const c = getComputedStyle(el).backgroundColor;
					if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
						background = c;
						break;
					}
				}
				return {
					focused: document.activeElement === chip,
					focusVisible: chip.matches(':focus-visible'),
					style: cs.outlineStyle,
					width: parseFloat(cs.outlineWidth),
					offset: parseFloat(cs.outlineOffset),
					color: cs.outlineColor,
					background,
					fill: cs.backgroundColor,
				};
			}, chipSel(research));
			const file = await shot(`focus-ring-${key}`);
			await browser.execute(() => {
				(document.activeElement as HTMLElement | null)?.blur();
			});
			const ratio = contrastOf(ring.color, ring.background);
			out[key] = { ...ring, contrast: ratio, file };
			expect({ key, focused: ring.focused, focusVisible: ring.focusVisible, style: ring.style, wide: ring.width >= 2, contrast: ratio >= 3 }).toEqual({
				key,
				focused: true,
				focusVisible: true,
				style: 'solid',
				wide: true,
				contrast: true,
			});
		}
		record('closeout-focus-ring', out);
	});

	it('editor bubble swatch focus ring: at least 3:1 against the bubble and on both sides, inside the selection ring, every look (WCAG 1.4.11)', async function () {
		// Close-out round 2 (swatch-focus-ring-contrast).
		const research = groupIds['research'] ?? '';
		const out: Record<string, unknown> = {};
		/** Box-shadow layers as [colour, spread px, inset]. */
		const layers = (shadow: string): { color: string; spread: number; inset: boolean }[] =>
			shadow === 'none'
				? []
				: shadow.split(/,(?![^(]*\))/).map((layer) => {
						const color = /(rgba?|oklch|oklab|lab|lch|color)\([^)]*\)|#[0-9a-f]+/i.exec(layer)?.[0] ?? '';
						const tokens = layer.replace(color, '').trim().split(/\s+/);
						const lengths = tokens.filter((x) => x !== 'inset').map((x) => parseFloat(x));
						return { color, spread: lengths[3] ?? 0, inset: tokens.includes('inset') };
					});
		/**
		 * Palette review round 1 (swatch-focus-ring-blends-into-new-fills): the 1px bands around the
		 * swatch edge, from 2px inside the swatch to 5px outside, as the box-shadow layers paint them
		 * (the first layer on top; a transparent layer paints nothing). The focus ring must reach at
		 * least 3:1 against the band on each side of it, not only against the bubble: next to a
		 * swatch fill or a selection ring in the swatch colour it would otherwise blend in.
		 */
		const ringSides = (r: { shadow: string; fill: string; bubble: string }, ringColor: string) => {
			const all = layers(r.shadow).filter((l) => (parseCssColor(l.color)?.a ?? 0) > 0);
			const band = (k: number): string => {
				const pick = all.find((l) => (k < 0 ? l.inset && l.spread > -k - 1 : !l.inset && l.spread > k));
				return pick?.color ?? (k < 0 ? r.fill : r.bubble);
			};
			const bands = [-2, -1, 0, 1, 2, 3, 4].map((k) => ({ k, color: band(k) }));
			const ringAt = bands.filter((b) => b.color === ringColor).map((b) => b.k);
			if (ringAt.length === 0) return { bands, inner: '', outer: '', innerContrast: 0, outerContrast: 0 };
			const inner = band(Math.min(...ringAt) - 1);
			const outer = band(Math.max(...ringAt) + 1);
			return { bands, inner, outer, innerContrast: contrastOf(ringColor, inner), outerContrast: contrastOf(ringColor, outer) };
		};
		for (const look of LOOKS) {
			const key = `${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`;
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			const s = await waitForState((x) => x.chips.length === 4, 'scene');
			const member = s.state.members.find((m) => m.groupId === research)?.leafId ?? '';
			await setActive(member);
			expect(await runCommand('tabstrip:rename-group')).toBe(true);
			await waitForState((x) => x.editor.open && x.editor.inputFocused, 'bubble');
			// Keyboard: Tab from the name field to the first swatch (grey, not the group's colour).
			await browser.keys(Key.Tab);
			const read = () =>
				browser.execute(() => {
					const sw = document.activeElement as HTMLElement | null;
					const bubble = document.querySelector<HTMLElement>('.tabstrip-editor');
					if (!sw?.classList.contains('tabstrip-swatch') || !bubble) throw new Error(`focus not on a swatch: ${String(sw?.className)}`);
					const cs = getComputedStyle(sw);
					const all = Array.from(bubble.querySelectorAll<HTMLElement>('.tabstrip-swatch'));
					const i = all.indexOf(sw);
					const next = all[i + 1] ?? all[i - 1];
					const a = sw.getBoundingClientRect();
					const b = next?.getBoundingClientRect();
					return {
						color: sw.getAttribute('data-tabstrip-color'),
						selected: sw.classList.contains('is-selected'),
						focusVisible: sw.matches(':focus-visible'),
						outline: { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset), color: cs.outlineColor },
						shadow: cs.boxShadow,
						fill: cs.backgroundColor,
						bubble: getComputedStyle(bubble).backgroundColor,
						gap: b ? Math.max(b.left - a.right, a.left - b.right) : NaN,
					};
				});
			const focused = await read();
			// The same swatch picked with Space: focused and selected.
			await browser.keys(Key.Space);
			await browser.pause(100);
			const both = await read();
			const file = await shot(`focus-ring-swatch-${key}`);
			await browser.keys(Key.Escape);
			await waitForState((x) => !x.editor.open, 'bubble closed');
			/** The focus indicator: the outline if drawn, else the strongest box-shadow layer against the bubble. */
			const indicator = (r: typeof focused) => {
				if (r.outline.style !== 'none' && r.outline.width > 0) return { kind: 'outline', color: r.outline.color, extent: r.outline.offset + r.outline.width };
				// Fully transparent layers draw nothing (and would read as black in a contrast formula).
				const best = layers(r.shadow)
					.filter((l) => l.color !== r.fill && (parseCssColor(l.color)?.a ?? 0) > 0)
					.map((l) => ({ ...l, contrast: parseCssColor(l.color) && parseCssColor(r.bubble) ? contrastOf(l.color, r.bubble) : 0 }))
					.sort((x, y) => y.contrast - x.contrast)[0];
				return { kind: 'box-shadow', color: best?.color ?? '', extent: Math.max(0, ...layers(r.shadow).map((l) => l.spread)) };
			};
			const ring = indicator(focused);
			const ringBoth = indicator(both);
			const ratio = ring.color === '' ? 0 : contrastOf(ring.color, focused.bubble);
			const ratioBoth = ringBoth.color === '' ? 0 : contrastOf(ringBoth.color, both.bubble);
			// When selected, the group colour ring (4px) is still there next to the focus ring.
			const colourRing = layers(both.shadow).some((l) => !l.inset && l.color === both.fill && l.spread === 4);
			const sides = ringSides(focused, ring.color);
			const sidesBoth = ringSides(both, ringBoth.color);
			out[key] = { focused, both, ring, ringBoth, contrast: ratio, contrastBoth: ratioBoth, colourRing, sides, sidesBoth, file };
			expect({
				key,
				onSwatch: focused.focusVisible && !focused.selected,
				selectedWithSpace: both.selected && both.focusVisible,
				contrast: ratio >= 3,
				contrastBoth: ratioBoth >= 3,
				// The ring stands out on both sides: against the swatch side and the outside.
				sides: sides.innerContrast >= 3 && sides.outerContrast >= 3,
				sidesBoth: sidesBoth.innerContrast >= 3 && sidesBoth.outerContrast >= 3,
				// Stays within the selection ring's 4px, so it never reaches the next swatch's ring (gap about 7.75px).
				withinSelectionRing: ring.extent <= 4 && ringBoth.extent <= 4,
				colourRing,
			}).toEqual({ key, onSwatch: true, selectedWithSpace: true, contrast: true, contrastBoth: true, sides: true, sidesBoth: true, withinSelectionRing: true, colourRing: true });
			expect(focused.gap).toBeGreaterThanOrEqual(2 * 4 - 1);
		}
		record('closeout2-swatch-focus-ring', out);
	});

	it('high contrast (forced colours): lines, dots and chips stay visible, and adjacent groups stay apart (requirements 5.6)', async function () {
		await setLook('default', false);
		await setUserLayout(true);
		await waitForState((x) => x.chips.length === 4, 'scene');
		const order = ['research', 'dot', 'long', 'work'].map((k) => groupIds[k] ?? '');
		// Chromium's forced-colours mode, as on Windows with a contrast theme (DevTools protocol, sandbox only).
		await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
		let facts: {
			media: boolean;
			forced: boolean;
			stripBg: string;
			groups: { gid: string; unnamed: boolean; chipText: string; chipFill: string; border: { width: number; color: string }; dot: string | null; lines: { color: string; left: number; right: number }[] }[];
		};
		let file = '';
		try {
			await browser.pause(400);
			facts = await browser.execute((gids) => {
				// Control: is the forcing itself on? Then an author colour is replaced by a system colour.
				const probe = document.body.createDiv();
				probe.setCssStyles({ backgroundColor: 'rgb(255, 0, 0)' });
				const forced = getComputedStyle(probe).backgroundColor !== 'rgb(255, 0, 0)';
				probe.remove();
				const strip = document.querySelector('.workspace .mod-root .workspace-tab-header-container');
				return {
					media: matchMedia('(forced-colors: active)').matches,
					forced,
					stripBg: strip ? getComputedStyle(strip).backgroundColor : '',
					groups: gids.map((gid) => {
						const chip = document.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
						if (!chip) throw new Error(`no chip ${gid}`);
						const cs = getComputedStyle(chip);
						const dot = chip.querySelector<HTMLElement>('.tabstrip-chip-dot');
						const unnamed = chip.classList.contains('is-unnamed');
						return {
							gid,
							unnamed,
							chipText: cs.color,
							chipFill: cs.backgroundColor,
							border: { width: parseFloat(cs.borderTopWidth), color: cs.borderTopColor },
							dot: unnamed && dot ? getComputedStyle(dot).backgroundColor : null,
							lines: Array.from(document.querySelectorAll<HTMLElement>(`.workspace-tab-header[data-tabstrip-group="${gid}"] > .tabstrip-line`)).map((l) => ({
								color: getComputedStyle(l).backgroundColor,
								left: l.getBoundingClientRect().left,
								right: l.getBoundingClientRect().right,
							})),
						};
					}),
				};
			}, order);
			file = await shot('forced-colors-default-light');
		} finally {
			await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [] });
		}
		const checks = facts.groups.map((g) => ({
			gid: g.gid,
			lines: g.lines.map((l) => Number(contrastOf(l.color, facts.stripBg).toFixed(2))),
			chip: g.unnamed ? null : { border: g.border.width, borderContrast: Number(contrastOf(g.border.color, facts.stripBg).toFixed(2)), text: Number(contrastOf(g.chipText, g.chipFill).toFixed(2)) },
			dot: g.dot === null ? null : Number(contrastOf(g.dot, facts.stripBg).toFixed(2)),
		}));
		// "long" and "work" are next to each other: the end of one line and the start of the next stay apart.
		const long = facts.groups[2];
		const work = facts.groups[3];
		const gap = long && work ? Math.min(...work.lines.map((l) => l.left)) - Math.max(...long.lines.map((l) => l.right)) : NaN;
		record('closeout-forced-colors', { facts, checks, gap, file });
		expect(facts.media).toBe(true);
		expect(facts.forced).toBe(true);
		for (const c of checks) {
			const where = JSON.stringify(c);
			expect({ where, lines: c.lines.every((x) => x >= 3) }).toEqual({ where, lines: true });
			if (c.chip) expect({ where, border: c.chip.border >= 1 && c.chip.borderContrast >= 3, text: c.chip.text >= MIN_CONTRAST }).toEqual({ where, border: true, text: true });
			if (c.dot !== null) expect({ where, dot: c.dot >= 3 }).toEqual({ where, dot: true });
		}
		expect(gap).toBeGreaterThanOrEqual(2);
		// Back to normal colours.
		const after = await browser.execute(() => matchMedia('(forced-colors: active)').matches);
		expect(after).toBe(false);
	});

	it('E11 all nine colours in one strip (default and Atom light)', async function () {
		const roles = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'] as const;
		const ids = await openNotes([...roles]);
		await setPinned(ids.n1, false);
		const names = ['灰色', '蓝色', '红色', '黄色', '绿色', '粉色', '紫色', '青色', '橙色'];
		for (const [i, color] of GROUP_COLORS.entries()) await makeGroup([ids[roles[i] ?? 'n1']], names[i] ?? color, color);
		await setActive(ids.n1);
		const files: string[] = [];
		for (const theme of ['default', 'Atom'] as const) {
			await setLook(theme, false);
			await setUserLayout(true);
			await waitForState((x) => x.chips.length === 9, 'nine chips');
			files.push(await shot(`colours-nine-${theme.toLowerCase()}-light`));
		}
		const s = await pageState();
		record('E11-nine', { files, chips: s.chips.map((c) => ({ text: c.text, fill: c.fill, ink: c.ink })) });
		expect(await readErrors()).toEqual([]);
	});

	it('underline paint: unbroken under the active or hovered tab and up to both group ends, every look (screenshot pixels, with control)', async function () {
		this.timeout(240_000);
		const roles = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9'] as const;
		const ids = await openNotes([...roles]);
		// The first tab is reused from the last case: take it out of its group.
		let s = await pageState();
		for (const id of Object.values(ids)) {
			if (!s.state.members.some((m) => m.leafId === id)) continue;
			await setActive(id);
			await runCommand('tabstrip:remove-from-group');
			s = await waitForState((x) => !x.state.members.some((m) => m.leafId === id), 'ungrouped');
		}
		// n1 | G1 = n2 n3 n4 | n5 | G2 (unnamed) = n6 n7 | G3 = n8 | n9
		const g1 = await makeGroup([ids.n2, ids.n3, ids.n4], '研究 Research', 'blue');
		const g2 = await makeGroup([ids.n6, ids.n7], '', 'green');
		const g3 = await makeGroup([ids.n8], 'Work', 'orange');
		// Tooltips are not part of the strip, but their arrow can touch the underline: keep the
		// pointer in the note area and hide tooltips during this case (test-only style).
		await browser.action('pointer').move({ x: 500, y: 500 }).perform();
		await browser.execute(() => {
			document.head.createEl('style', { attr: { 'data-e2e-style': 'no-tooltips' }, text: '.tooltip { display: none !important; }' });
		});
		const STATES: { name: string; active: Role; hover?: Role; what: string }[] = [
			{ name: 'active-middle', active: 'n3', what: 'active member in the middle of G1' },
			{ name: 'active-last', active: 'n4', what: 'active last member of G1, ungrouped tab after it' },
			{ name: 'active-first', active: 'n2', what: 'active first member (chip) of G1' },
			{ name: 'active-between', active: 'n5', what: 'active ungrouped tab right after G1 and right before G2' },
			{ name: 'active-before-next-group', active: 'n7', what: 'active last member of G2, G3 right after it' },
			{ name: 'active-before-group', active: 'n1', what: 'active ungrouped tab right before G1' },
			{ name: 'active-single', active: 'n8', what: 'active one-tab group G3 between G2 and an ungrouped tab' },
			{ name: 'hover-member', active: 'n9', hover: 'n3', what: 'hovered member in the middle of G1' },
			{ name: 'hover-between', active: 'n9', hover: 'n5', what: 'hovered ungrouped tab right after G1 and before G2' },
		];
		const setOverride = (prop: string | null) =>
			browser.execute((p) => {
				for (const name of ['--tabstrip-line-overlap', '--tabstrip-flare-cut']) document.body.style.removeProperty(name);
				if (p !== null) document.body.style.setProperty(p, '0px');
			}, prop);
		const report: Record<string, unknown> = {};
		for (const look of LOOKS) {
			const key = `${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`;
			await setLook(look.theme, look.dark);
			await setUserLayout(true);
			for (const st of STATES) {
				await setActive(ids[st.active]);
				s = await waitForState((x) => x.chips.length === 3 && x.activeId === ids[st.active], st.name);
				for (const g of [g1, g2, g3]) expectContinuousLine(s, g);
				if (st.hover) {
					await $(titleSel(ids[st.hover])).moveTo();
					await browser.pause(400);
				}
				const paint = await underlinePaint(`${key}-${st.name}`);
				if (st.hover) await browser.action('pointer').move({ x: 500, y: 500 }).perform();
				report[`${key}/${st.name}`] = {
					file: paint.file,
					groups: paint.groups.map((g) => ({
						g: g.groupId,
						css: g.color,
						painted: g.painted,
						gaps: g.gaps,
						columns: g.columns,
						rows: g.rows.length,
						maxMatched: g.maxMatchedDistance,
						spill: [g.spillBefore, g.spillAfter],
					})),
				};
				expect(paint.groups.map((g) => g.groupId).sort()).toEqual([g1, g2, g3].sort());
				for (const g of paint.groups) {
					// The context travels on both sides, so a failure names the look, state and pixel.
					const where = `${key} ${st.what}: group ${g.groupId} (${g.color}) from ${g.from.toFixed(1)} to ${g.to.toFixed(1)}, first miss ${JSON.stringify(g.firstMiss)}, ${paint.file}`;
					expect({ where, rows: g.rows.length >= 2, columns: g.columns > 40, gaps: g.gaps, spill: [g.spillBefore, g.spillAfter] }).toEqual({
						where,
						rows: true,
						columns: true,
						gaps: [],
						spill: [0, 0],
					});
				}
			}

			// Control: without the two rules the same check finds the gaps the reviewer saw.
			await setActive(ids.n3);
			// What Obsidian does here differs by version: the feet's size (--tab-curve: 6px in
			// 1.13.4, 10px from 1.14) and whether the active header is stacked above the headers
			// after it (z-index 1 from 1.14). Without that, the next header paints over the right
			// foot and only the left gap appears.
			const feet = await browser.execute((sel) => {
				const h = document.querySelector<HTMLElement>(sel);
				if (!h) throw new Error('no header for n3');
				const cs = getComputedStyle(h);
				return { zIndex: cs.zIndex, curve: parseFloat(cs.getPropertyValue('--tab-curve')) };
			}, headerSel(ids.n3));
			await setOverride('--tabstrip-line-overlap');
			const noOverlap = (await underlinePaint(`${key}-control-no-overlap`)).groups.find((g) => g.groupId === g1);
			await setActive(ids.n5);
			await setOverride('--tabstrip-flare-cut');
			const noCut = (await underlinePaint(`${key}-control-no-cut`)).groups.find((g) => g.groupId === g1);
			await setOverride(null);
			await setActive(ids.n3);
			const restored = (await underlinePaint(`${key}-control-restored`)).groups.find((g) => g.groupId === g1);
			if (!noOverlap || !noCut || !restored) throw new Error('G1 missing in the control');
			const n3 = noOverlap.members[1];
			if (!n3) throw new Error('G1 members missing');
			/** A gap of at least `min` px that reaches `edge`. */
			const reaching = (gaps: { from: number; to: number }[], edge: number, min: number) =>
				gaps.some((gap) => gap.from - 1 <= edge && edge <= gap.to + 1 && gap.to - gap.from >= min);
			const aboveNext = feet.zIndex !== 'auto';
			const minGap = feet.curve / 2;
			const control = { feet, noOverlap: noOverlap.gaps, noCut: noCut.gaps, restored: restored.gaps, n3, g1CheckedEnd: noCut.to };
			report[`${key}/control`] = control;
			expect(feet.curve).toBeGreaterThanOrEqual(4);
			expect({
				key,
				control,
				// The active n3's left foot covers the end of n2's segment (n2 is painted first).
				leftOfActive: reaching(noOverlap.gaps, n3[0], minGap),
				// Its right foot covers the start of n4's segment only if n3 is stacked above n4;
				// otherwise there must be no gap there at all.
				rightOfActive: aboveNext ? reaching(noOverlap.gaps, n3[1], minGap) : reaching(noOverlap.gaps, n3[1], 0),
				// The active n5's left foot covers the end of G1's line (the checked stretch stops 2px before it).
				endOfGroup: reaching(noCut.gaps, noCut.to, minGap - 1),
				restored: restored.gaps,
			}).toEqual({ key, control, leftOfActive: true, rightOfActive: aboveNext, endOfGroup: true, restored: [] });
		}
		record('E11-underline-paint', report);
		await browser.execute(() => {
			document.querySelector('style[data-e2e-style="no-tooltips"]')?.remove();
		});
		expect(await readErrors()).toEqual([]);
	});

	it('other themes (Cupertino, Blue Topaz, Minimal): the chip keeps its room, is not clipped, sits centred on its tab, hovering it leaves the tab as it is, chip text ≥ 4.5', async function () {
		this.timeout(240_000);
		const installed = await browser.executeObsidian(({ app }) => Object.keys((app as unknown as { customCss: { themes: Record<string, unknown> } }).customCss.themes));
		const missing = [...new Set(OTHER_THEMES.map((t) => t.theme))].filter((name) => !installed.includes(name));
		if (missing.length > 0) throw new Error(`themes not installed in the sandbox (copied from the user's vault by wdio.conf.mts): ${missing.join(', ')}`);
		const roles = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'] as const;
		const ids = await openNotes([...roles]);
		let s = await pageState();
		for (const id of Object.values(ids)) {
			if (!s.state.members.some((m) => m.leafId === id)) continue;
			await setActive(id);
			await runCommand('tabstrip:remove-from-group');
			s = await waitForState((x) => !x.state.members.some((m) => m.leafId === id), 'ungrouped');
		}
		// Start = n1 n2 (the strip starts with a group) | n3 | Middle = n4 | unnamed = n5 (right after Middle) | n6
		const start = await makeGroup([ids.n1, ids.n2], '开头 Start', 'blue');
		const middle = await makeGroup([ids.n4], 'Middle 中', 'red');
		const unnamed = await makeGroup([ids.n5], '', 'green');
		await setActive(ids.n6);
		await browser.action('pointer').move({ x: 500, y: 500 }).perform();
		const report: Record<string, unknown> = {};
		const problems: unknown[] = [];
		try {
			for (const t of OTHER_THEMES) {
				await setTheme(t.theme);
				await browser.execute(
					(cls, all) => {
						for (const c of all) document.body.removeClass(c);
						if (cls !== null) document.body.addClass(cls);
					},
					t.bodyClass,
					VARIANT_CLASSES,
				);
				await browser.pause(400);
				// Some styles animate the tab headers (Blue Topaz "Safari": `transition: 400ms` on
				// everything): measure once no transition or animation is running.
				const settledAfter = await browser.execute(async () => {
					const inStrip = () =>
						document.getAnimations().filter((a) => {
							const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
							return target !== null && target.closest('.workspace-tab-header-container') !== null;
						}).length;
					const started = performance.now();
					while (inStrip() > 0 && performance.now() - started < 3000) {
						await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					}
					return { ms: Math.round(performance.now() - started), running: inStrip() };
				});
				expect(settledAfter.running).toBe(0);
				const st = await waitForState((x) => x.chips.length === 3, `${t.key}: chips`);
				const lineBoxes = st.lines
					.filter((l) => l.groupId !== null && [start, middle, unnamed].includes(l.groupId))
					.map((l) => ({ g: l.groupId, line: [l.rect.left, l.rect.right, l.rect.top, l.rect.bottom], host: l.hostRect ? [l.hostRect.left, l.hostRect.right, l.hostRect.top, l.hostRect.bottom] : null }));
				report[`${t.key}/lines`] = { settledAfter, lineBoxes };
				console.log(`[l4] theme ${t.key} lines: ${JSON.stringify({ settledAfter, lineBoxes })}`);
				// The underline runs from each chip to its group's last tab (Cupertino's unitless
				// --tab-curve once made the segments of multi-tab groups shrink to nothing) ...
				for (const g of [start, middle, unnamed]) expectContinuousLine(st, g);
				// ... and is painted unbroken (screenshot pixels, as in the underline paint case).
				await browser.execute(() => {
					document.head.createEl('style', { attr: { 'data-e2e-style': 'no-tooltips' }, text: '.tooltip { display: none !important; }' });
				});
				const paint = await underlinePaint(`theme-${t.key}`);
				await browser.execute(() => {
					document.querySelector('style[data-e2e-style="no-tooltips"]')?.remove();
				});
				const paintChecks = paint.groups.map((g) => ({ g: g.groupId, gaps: g.gaps, spill: [g.spillBefore, g.spillAfter], columns: g.columns > 40 }));
				const facts = await browser.execute(
					(groups) => {
						const r = (el: Element) => {
							const b = el.getBoundingClientRect();
							return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height };
						};
						/** Theme rules (not Tabstrip's) that match this header and set its start margin. */
						const marginRules = (el: Element): string[] => {
							const found: string[] = [];
							const walk = (rules: CSSRuleList) => {
								for (const rule of Array.from(rules)) {
									if (rule instanceof CSSStyleRule) {
										const m = rule.style.getPropertyValue('margin-left') || rule.style.getPropertyValue('margin-inline-start');
										if (m && !rule.selectorText.includes('tabstrip') && el.matches(rule.selectorText)) found.push(`${rule.selectorText} { margin-left: ${m} }`);
									} else if (rule instanceof CSSGroupingRule) {
										walk(rule.cssRules);
									}
								}
							};
							for (const sheet of Array.from(document.styleSheets)) {
								try {
									walk(sheet.cssRules);
								} catch {
									// A sheet that cannot be read.
								}
							}
							return found;
						};
						return groups.map((gid) => {
							const chip = document.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
							const host = chip?.parentElement;
							if (!chip || !host) throw new Error(`no chip ${gid}`);
							let prev = host.previousElementSibling;
							while (prev && !prev.classList.contains('workspace-tab-header')) prev = prev.previousElementSibling;
							const tab = host.querySelector('.workspace-tab-header-inner');
							const cs = getComputedStyle(chip);
							return {
								gid,
								margin: parseFloat(getComputedStyle(host).marginInlineStart),
								slot: parseFloat(host.style.getPropertyValue('--tabstrip-chip-slot')),
								chip: r(chip),
								host: r(host),
								prev: prev ? r(prev) : null,
								strip: host.parentElement ? r(host.parentElement) : null,
								tab: tab ? r(tab) : null,
								fontSize: parseFloat(cs.fontSize),
								rules: marginRules(host),
							};
						});
					},
					[start, middle, unnamed],
				);
				const file = await shot(`theme-${t.key}`);
				const checks = facts.map((f) => ({
					gid: f.gid,
					// The theme's margin rule does not win over the chip's room.
					slotKept: Math.abs(f.margin - f.slot) <= 0.5,
					// Not over its own tab, not over the previous tab, not clipped at the strip's start.
					clearOfTab: f.chip.right <= f.host.left - 2,
					clearOfPrevious: f.prev === null ? f.strip !== null && f.chip.left >= f.strip.left : f.chip.left >= f.prev.right + 2,
					// Centred on the visible tab, and tall enough for its text.
					centred: f.tab !== null && Math.abs((f.chip.top + f.chip.bottom) / 2 - (f.tab.top + f.tab.bottom) / 2) <= 1.5,
					tallEnough: f.chip.height >= f.fontSize + 6,
				}));
				const ruleOn = t.marginRuleOn === 'start' ? facts[0] : t.marginRuleOn === 'middle' ? facts[1] : null;
				report[t.key] = { file, facts, checks, paint: { file: paint.file, groups: paintChecks } };
				const ok = { slotKept: true, clearOfTab: true, clearOfPrevious: true, centred: true, tallEnough: true };
				for (const c of checks) expect({ theme: t.key, ...c }).toEqual({ theme: t.key, gid: c.gid, ...ok });
				expect(paintChecks.map((p) => p.g).sort()).toEqual([start, middle, unnamed].sort());
				for (const p of paintChecks) expect({ theme: t.key, ...p }).toEqual({ theme: t.key, g: p.g, gaps: [], spill: [0, 0], columns: true });
				// The case exercised what the reviewers saw: a theme rule that sets this header's margin.
				if (ruleOn) expect({ theme: t.key, rules: ruleOn.rules.length > 0 }).toEqual({ theme: t.key, rules: true });

				// Close-out round 2: hovering a chip leaves its tab looking as it does without hover
				// (real pointer), in each theme; control: hovering the tab itself changes something.
				const hover: Record<string, unknown> = {};
				let tabHoverShows = false;
				for (const gid of [start, middle, unnamed]) {
					await browser.action('pointer').move({ x: 500, y: 500 }).perform();
					await browser.pause(300);
					await stripSettled();
					const rest = await tabLook(gid);
					// The pointer is moved onto the chip and the test checks it really got there (:hover).
					// A move can occasionally miss (seen once under Minimal Modern on a 16px dot chip), so
					// retry a bounded number of times from outside, recording what was under the chip
					// centre on each miss. Missing on every attempt stays a hard failure (notHovered).
					let overChip = await tabLook(gid);
					const misses: unknown[] = [];
					for (let attempt = 0; attempt < 3; attempt++) {
						if (attempt > 0) {
							await browser.action('pointer').move({ x: 500, y: 500 }).perform();
							await browser.pause(300);
							await stripSettled();
						}
						await browser.action('pointer').move({ origin: await $(chipSel(gid)).getElement(), duration: 0 }).perform();
						await browser.pause(300);
						await stripSettled();
						overChip = await tabLook(gid);
						if (overChip.chipHovered && overChip.headerHovered) break;
						misses.push(
							await browser.execute((sel) => {
								const chip = document.querySelector(sel);
								if (!chip) return { chip: 'missing' };
								const r = chip.getBoundingClientRect();
								const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
								return { rect: [r.left, r.top, r.right, r.bottom], atCentre: at ? `${at.tagName}.${[...at.classList].join('.')}` : null };
							}, chipSel(gid)),
						);
					}
					if (misses.length > 0) console.log(`[l4] theme ${t.key} ${gid}: pointer missed the chip ${misses.length}x: ${JSON.stringify(misses)}`);
					const host = st.chips.find((c) => c.groupId === gid)?.hostLeafId ?? '';
					await browser.action('pointer').move({ origin: await $(titleSel(host)).getElement(), duration: 0 }).perform();
					await browser.pause(300);
					await stripSettled();
					const overTab = await tabLook(gid);
					await browser.action('pointer').move({ x: 500, y: 500 }).perform();
					if (JSON.stringify(visible(overTab)) !== JSON.stringify(visible(rest))) tabHoverShows = true;
					hover[gid] = { rest: visible(rest), overChip: visible(overChip), overTab: visible(overTab), misses };
					// Collected over all themes and checked after the loop, so one run shows every theme.
					if (!overChip.chipHovered || !overChip.headerHovered) problems.push({ theme: t.key, gid, notHovered: { chip: overChip.chipHovered, header: overChip.headerHovered } });
					if (JSON.stringify(visible(overChip)) !== JSON.stringify(visible(rest))) problems.push({ theme: t.key, gid, hover: diff(visible(rest), visible(overChip)) });
				}
				if (!tabHoverShows) problems.push({ theme: t.key, control: 'hovering a tab changed nothing that is measured' });

				// Close-out round 2: a named grey group (Cupertino computes its greys in oklch): the chip
				// text reaches 4.5:1 on the fill as painted, converted here independently of the plugin.
				await makeGroup([ids.n3], 'Grey 灰', 'grey');
				const greyState = await waitForState((x) => x.chips.length === 4, `${t.key}: grey chip`);
				const named = greyState.chips.filter((c) => !c.unnamed);
				const inks = await paintedRgb(named.flatMap((c) => [c.textColor, c.fill]));
				const textChecks = named.map((c, i) => {
					const text = inks[2 * i];
					const fill = inks[2 * i + 1];
					if (!text || !fill) throw new Error('colour conversion missing');
					return { g: c.text, color: c.color, fillCss: c.fill, ink: c.ink, contrast: Number(contrast(text, fill).toFixed(2)) };
				});
				report[`${t.key}/hover`] = hover;
				report[`${t.key}/text`] = textChecks;
				console.log(`[l4] theme ${t.key} text: ${JSON.stringify(textChecks)}`);
				for (const c of textChecks) if (c.contrast < MIN_CONTRAST) problems.push({ theme: t.key, text: c });
				await setActive(ids.n3);
				await runCommand('tabstrip:remove-from-group');
				await waitForState((x) => x.chips.length === 3 && !x.state.members.some((m) => m.leafId === ids.n3), 'grey group gone');
				await setActive(ids.n6);
			}
		} finally {
			await browser.execute((all) => {
				for (const c of all) document.body.removeClass(c);
			}, VARIANT_CLASSES);
			await setTheme('default');
		}
		record('closeout-other-themes', report);
		expect(problems).toEqual([]);
		expect(await readErrors()).toEqual([]);
	});
});

