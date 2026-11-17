/**
 * Step L5, review round 1: cases for the three problems the independent review found.
 *
 * V1 closing the shown tab next to a collapsed group shows the nearest visible tab (like Chrome)
 *    and leaves the group collapsed.
 * V2 a collapsed group leaves no extra space per hidden member in themes that space tabs with
 *    `gap` (Cupertino), and in the other themes of the L4 theme case.
 * V3 high contrast: the collapsed chip's thicker border keeps the 4px gaps on both sides.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run). Real pointer
 * clicks; every check reads the live state. No real drag and drop (L2).
 */
import { $, browser, expect } from '@wdio/globals';
import {
	chipSel,
	errorTimeline,
	groupOf,
	headerSel,
	mainStrip,
	makeGroup,
	openNotes,
	pageState,
	record,
	runCommand,
	setActive,
	setTheme,
	shot,
	startErrorWatch,
	waitForState,
	type PageState,
} from '../helpers';

function collapsed(s: PageState, groupId: string): boolean | undefined {
	return s.state.groups.find((g) => g.id === groupId)?.collapsed;
}

/** openNotes, with every tab taken out of any group left over from an earlier case. */
async function freshNotes<R extends Parameters<typeof openNotes>[0][number]>(roles: R[]): Promise<Record<R, string>> {
	const ids = (await openNotes(roles)) as Record<R, string>;
	let s = await pageState();
	for (const id of Object.values<string>(ids)) {
		if (groupOf(s, id) === null) continue;
		await setActive(id);
		expect(await runCommand('tabstrip:remove-from-group')).toBe(true);
		s = await waitForState((x) => groupOf(x, id) === null, 'leftover group gone');
	}
	return ids;
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

interface Spacing {
	chip: { left: number; right: number; width: number; borderWidth: number; borderStyle: string };
	prevRight: number;
	holder: { left: number; right: number };
	members: { left: number; right: number; width: number }[];
	next: { left: number; marginStart: number };
	strip: { left: number; right: number };
	gap: number;
}

/** Positions around a group's chip: the tab before it, its members, the first tab after it. */
async function spacing(groupId: string, prevId: string, memberIds: string[], nextId: string): Promise<Spacing> {
	return browser.executeObsidian(
		({ app }, gid, prev, members, next) => {
			const header = (id: string): HTMLElement => {
				const leaf = app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement } | null;
				if (!leaf) throw new Error(`no leaf ${id}`);
				return leaf.tabHeaderEl;
			};
			const chip = document.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${gid}"]`);
			if (!chip) throw new Error(`no chip ${gid}`);
			const cr = chip.getBoundingClientRect();
			const ccs = getComputedStyle(chip);
			const hs = members.map((id) => header(id).getBoundingClientRect());
			const holder = hs[0];
			const nextEl = header(next);
			const container = nextEl.parentElement;
			const strip = nextEl.closest('.workspace-tab-header-container')?.getBoundingClientRect();
			if (!holder || !container || !strip) throw new Error('layout');
			const gap = parseFloat(getComputedStyle(container).columnGap);
			return {
				chip: { left: cr.left, right: cr.right, width: cr.width, borderWidth: parseFloat(ccs.borderTopWidth), borderStyle: ccs.borderTopStyle },
				prevRight: header(prev).getBoundingClientRect().right,
				holder: { left: holder.left, right: holder.right },
				members: hs.map((r) => ({ left: r.left, right: r.right, width: r.width })),
				next: { left: nextEl.getBoundingClientRect().left, marginStart: parseFloat(getComputedStyle(nextEl).marginLeft) },
				strip: { left: strip.left, right: strip.right },
				gap: Number.isFinite(gap) ? gap : 0,
			};
		},
		groupId,
		prevId,
		memberIds,
		nextId,
	);
}

/** Waits until no transition or animation runs in the tab strip (some theme styles animate headers). */
async function settled(): Promise<void> {
	const running = await browser.execute(async () => {
		const inStrip = () =>
			document.getAnimations().filter((a) => {
				const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
				return target !== null && target.closest('.workspace-tab-header-container') !== null;
			}).length;
		const started = performance.now();
		while (inStrip() > 0 && performance.now() - started < 3000) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		}
		return inStrip();
	});
	expect(running).toBe(0);
}

const THEMES = [
	{ theme: 'default', bodyClass: null, key: 'default' },
	// `gap: 4px` on the main area's header container.
	{ theme: 'Cupertino', bodyClass: null, key: 'cupertino' },
	{ theme: 'Blue Topaz', bodyClass: null, key: 'blue-topaz' },
	// "Safari" tabs: `transition: 400ms`, `margin-left: 12px` on every header.
	{ theme: 'Blue Topaz', bodyClass: 'safari-tab-style', key: 'blue-topaz-safari' },
	{ theme: 'Minimal', bodyClass: null, key: 'minimal' },
	{ theme: 'Minimal', bodyClass: 'tabs-modern', key: 'minimal-modern' },
] as const;
const VARIANT_CLASSES = ['safari-tab-style', 'tabs-modern'];

describe('L5 review round 1', function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			vault.setConfig('theme', 'moonstone');
			await vault.saveConfig();
		});
		await startErrorWatch();
	});

	it('V1 closing the shown tab next to a collapsed group shows the nearest visible tab; the group stays collapsed', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n3, ids.n4], 'Closed 关', 'blue');
		await setActive(ids.n1);
		await setCollapsedVia(g, true);

		// (a) n2 active, real click on its close button: Obsidian would show hidden n3 (now at n2's
		// index); the plugin shows n5, the nearest visible tab to the right, instead.
		await setActive(ids.n2);
		await $(`${headerSel(ids.n2)} .workspace-tab-header-inner-close-button`).click();
		let s = await waitForState((x) => !mainStrip(x).leafIds.includes(ids.n2) && x.activeId === ids.n5, 'n2 closed, n5 active');
		expect(collapsed(s, g)).toBe(true);
		expect(mainStrip(s).currentId).toBe(ids.n5);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n3, ids.n4, ids.n5]);
		const a = { active: s.activeId, collapsed: collapsed(s, g) };

		// (b) n5, the last tab, closed with the native "Close current tab" command: Obsidian would
		// show the new last tab, hidden n4; the plugin goes left past the group to n1.
		expect(await runCommand('workspace:close')).toBe(true);
		s = await waitForState((x) => !mainStrip(x).leafIds.includes(ids.n5) && x.activeId === ids.n1, 'n5 closed, n1 active');
		expect(collapsed(s, g)).toBe(true);
		expect(mainStrip(s).currentId).toBe(ids.n1);
		const b = { active: s.activeId, collapsed: collapsed(s, g) };
		const shotB = await shot('v1-close-skips-collapsed', 'L5');

		// (c) Only hidden tabs left: closing n1 shows a hidden tab; there is no visible tab to go
		// to, so the group expands (no new empty tab is made).
		expect(await runCommand('workspace:close')).toBe(true);
		s = await waitForState((x) => !mainStrip(x).leafIds.includes(ids.n1) && collapsed(x, g) === false, 'n1 closed, group expanded');
		expect(mainStrip(s).leafIds).toEqual([ids.n3, ids.n4]);
		expect([ids.n3, ids.n4]).toContain(s.activeId);
		expect(s.stats.loopStops).toBe(0);
		record('V1', { a, b, c: { active: s.activeId, collapsed: collapsed(s, g) }, screenshot: shotB });
	});

	it('V2 a collapsed group is followed by one gap whatever its size, in every theme of the L4 theme case', async function () {
		this.timeout(240_000);
		const installed = await browser.executeObsidian(({ app }) => Object.keys((app as unknown as { customCss: { themes: Record<string, unknown> } }).customCss.themes));
		const missing = [...new Set(THEMES.map((t) => t.theme))].filter((name) => name !== 'default' && !installed.includes(name));
		if (missing.length > 0) throw new Error(`themes not installed in the sandbox: ${missing.join(', ')}`);
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		// n1 | Big = n2 n3 n4 (collapsed) | n5 | n6 (active)
		const big = await makeGroup([ids.n2, ids.n3, ids.n4], 'Big 大', 'purple');
		await setActive(ids.n6);
		await browser.action('pointer').move({ x: 500, y: 500 }).perform();
		const report: Record<string, unknown> = {};
		const problems: unknown[] = [];
		try {
			for (const t of THEMES) {
				await setTheme(t.theme);
				await browser.execute(
					(cls, all) => {
						for (const c of all) document.body.removeClass(c);
						if (cls !== null) document.body.addClass(cls);
					},
					t.bodyClass,
					VARIANT_CLASSES,
				);
				await setCollapsedVia(big, false);
				await browser.pause(300);
				await settled();
				const expanded = await spacing(big, ids.n1, [ids.n2, ids.n3, ids.n4], ids.n5);
				await setCollapsedVia(big, true);
				await browser.pause(300);
				await settled();
				const folded = await spacing(big, ids.n1, [ids.n2, ids.n3, ids.n4], ids.n5);
				if (t.key === 'cupertino') report['cupertino-shot'] = await shot('v2-cupertino-collapsed', 'L5');
				// After the chip: its 4px, the zero-width holder, one strip gap, the next tab's own start margin.
				const want = folded.chip.right + 4 + folded.gap + folded.next.marginStart;
				const facts = { key: t.key, gap: folded.gap, nextLeft: folded.next.left, want, chip: folded.chip, members: folded.members, expandedChipToHolder: expanded.holder.left - expanded.chip.right };
				report[t.key] = { expanded, folded };
				console.log(`[l5-review] ${JSON.stringify(facts)}`);
				if (Math.abs(folded.next.left - want) > 1) problems.push({ ...facts, problem: 'space after the collapsed chip' });
				// The chip keeps its 4px to the tab before it and to its holder, as when expanded.
				if (Math.abs(folded.holder.left - folded.chip.right - 4) > 1) problems.push({ ...facts, problem: 'chip to holder' });
				if (Math.abs(folded.chip.left - folded.prevRight - (expanded.chip.left - expanded.prevRight)) > 1) problems.push({ ...facts, problem: 'chip to previous tab changed' });
				// Hidden headers: zero width, inside the strip, in tab order (native drop positions).
				let last = -Infinity;
				for (const m of folded.members) {
					if (m.width !== 0 || m.left < folded.strip.left || m.left > folded.strip.right || m.left < last) problems.push({ ...facts, problem: 'hidden header box', m });
					last = m.left;
				}
			}
		} finally {
			await browser.execute((all) => {
				for (const c of all) document.body.removeClass(c);
			}, VARIANT_CLASSES);
			await setTheme('default');
		}
		record('V2', report);
		expect(problems).toEqual([]);
	});

	it('V3 high contrast: the collapsed chip keeps 4px to the tab before it and to its own tab', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], '研究 Research', 'blue');
		await setActive(ids.n4);
		await browser.action('pointer').move({ x: 500, y: 500 }).perform();
		await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
		const facts: Record<string, Spacing> = {};
		try {
			await browser.pause(400);
			await waitForState((x) => x.chips.some((c) => c.groupId === g), 'chip');
			facts['expanded'] = await spacing(g, ids.n1, [ids.n2, ids.n3], ids.n4);
			// Real click on the chip: the border goes from 1px solid to 2px dashed.
			await $(chipSel(g)).click();
			await waitForState((x) => collapsed(x, g) === true, 'collapsed');
			await browser.pause(300);
			facts['collapsed'] = await spacing(g, ids.n1, [ids.n2, ids.n3], ids.n4);
			await $(chipSel(g)).click();
			await waitForState((x) => collapsed(x, g) === false, 'expanded again');
			await browser.pause(300);
			facts['expandedAgain'] = await spacing(g, ids.n1, [ids.n2, ids.n3], ids.n4);
		} finally {
			await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [] });
		}
		record('V3', facts);
		const c = facts['collapsed'];
		if (!c) throw new Error('no facts');
		expect({ style: c.chip.borderStyle, width: c.chip.borderWidth }).toEqual({ style: 'dashed', width: 2 });
		expect(facts['expanded']?.chip.borderStyle).toBe('solid');
		for (const [key, f] of Object.entries(facts)) {
			const before = f.chip.left - f.prevRight;
			const after = f.holder.left - f.chip.right;
			expect({ key, before: Math.abs(before - 4) <= 1, after: Math.abs(after - 4) <= 1 }).toEqual({ key, before: true, after: true });
		}
	});

	it('no console errors or warnings during the whole run', async function () {
		expect(await errorTimeline()).toEqual([]);
		expect((await pageState()).stats.loopStops).toBe(0);
	});
});
