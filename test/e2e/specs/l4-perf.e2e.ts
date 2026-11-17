/**
 * Step L4, E9: plugin time per layout change and per tab switch with about 150 tabs in three
 * strips, most of them deferred (not loaded); the plugin must never load a deferred leaf.
 *
 * Times come from the plugin's own pass timings (read + reconcile + ops + render), recorded
 * with performance.now() around each pass.
 */
import { browser, expect } from '@wdio/globals';
import { NOTES, readErrors, record, startErrorWatch, writeEvidence } from '../helpers';

interface Timing {
	triggers: string[];
	ms: number;
	ops: number;
	leaves: number;
}

interface PluginDebug {
	stats(): { passes: number; timings: Timing[]; loopStops: number };
	state(): { groups: unknown[]; members: unknown[] };
	group(ids: string[], name: string, color?: string): string | null;
	flush(): void;
}

const STRIPS = 3;
const PER_STRIP = 50;

function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
	return {
		n: sorted.length,
		median: Number(at(0.5).toFixed(3)),
		p95: Number(at(0.95).toFixed(3)),
		max: Number((sorted[sorted.length - 1] ?? NaN).toFixed(3)),
	};
}

describe('L4 performance with ~150 tabs (E9)', function () {
	it('E9 layout changes and tab switches stay fast and load no deferred leaf', async function () {
		await startErrorWatch();
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
		});

		// 1. Plugin off; load a layout with three strips of 50 tabs. Obsidian defers background tabs.
		const built = await browser.executeObsidian(
			async ({ app }, files, strips, perStrip) => {
				const plugins = (app as unknown as { plugins: { disablePlugin(id: string): Promise<void> } }).plugins;
				await plugins.disablePlugin('tabstrip');
				const hex = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
				const layout = app.workspace.getLayout();
				const tabs = Array.from({ length: strips }, (_, k) => ({
					id: hex(),
					type: 'tabs',
					currentTab: 0,
					children: Array.from({ length: perStrip }, (_, i) => ({
						id: hex(),
						type: 'leaf',
						// Like a saved workspace: with an icon and a title, background tabs load deferred.
						state: {
							type: 'markdown',
							state: { file: files[(k * perStrip + i) % files.length], mode: 'source', source: false },
							icon: 'lucide-file',
							title: (files[(k * perStrip + i) % files.length] ?? '').replace(/^.*\//, '').replace(/\.md$/, ''),
						},
					})),
				}));
				const firstLeaf = tabs[0]?.children[0]?.id;
				await app.workspace.changeLayout({ ...layout, main: { id: hex(), type: 'split', direction: 'vertical', children: tabs }, active: firstLeaf });
				await new Promise((r) => setTimeout(r, 800));
				const all: { id: string; deferred: boolean }[] = [];
				app.workspace.iterateRootLeaves((leaf) => {
					all.push({ id: (leaf as unknown as { id: string }).id, deferred: leaf.isDeferred });
				});
				return all;
			},
			Object.values(NOTES),
			STRIPS,
			PER_STRIP,
		);
		const deferredAtStart = built.filter((l) => l.deferred).map((l) => l.id);
		expect(built.length).toBe(STRIPS * PER_STRIP);
		expect(deferredAtStart.length).toBeGreaterThanOrEqual(STRIPS * (PER_STRIP - 1));

		// 2. Plugin on (start-up pass over all 150 tabs), then groups: 4 groups of 5 per strip.
		const startup = await browser.executeObsidian(async ({ app }) => {
			const plugins = (app as unknown as { plugins: { enablePlugin(id: string): Promise<boolean>; plugins: Record<string, { debug: PluginDebug }> } }).plugins;
			await plugins.enablePlugin('tabstrip');
			await new Promise((r) => setTimeout(r, 300));
			const debug = plugins.plugins['tabstrip']?.debug;
			if (!debug) throw new Error('tabstrip not loaded');
			return debug.stats().timings.slice(0, 3);
		});
		const groups = await browser.executeObsidian(async ({ app }, perStrip) => {
			const debug = (app as unknown as { plugins: { plugins: Record<string, { debug: PluginDebug }> } }).plugins.plugins['tabstrip']?.debug;
			if (!debug) throw new Error('tabstrip not loaded');
			const strips = new Set<{ children: { id: string }[] }>();
			app.workspace.iterateRootLeaves((leaf) => {
				strips.add(leaf.parent as unknown as { children: { id: string }[] });
			});
			const made: string[] = [];
			for (const tabs of strips) {
				for (let g = 0; g < 4; g++) {
					const ids = tabs.children.slice(5 + g * 10, 10 + g * 10).map((l) => l.id);
					const id = debug.group(ids, `组 ${String(made.length + 1)}`);
					if (id !== null) made.push(id);
				}
			}
			await new Promise((r) => setTimeout(r, 300));
			return { made: made.length, members: debug.state().members.length, perStrip };
		}, PER_STRIP);
		expect(groups.made).toBe(12);
		expect(groups.members).toBe(60);

		// 3. Layout changes: new tab at a strip's end then closed again, and native moves of
		// background tabs. Tab switches: between the three shown tabs. Every step waits for its pass.
		const run = await browser.executeObsidian(async ({ app }) => {
			const debug = (app as unknown as { plugins: { plugins: Record<string, { debug: PluginDebug }> } }).plugins.plugins['tabstrip']?.debug;
			if (!debug) throw new Error('tabstrip not loaded');
			type Tabs = {
				children: import('obsidian').WorkspaceLeaf[];
				currentTab: number;
				removeChild(l: unknown): void;
				insertChild(i: number, l: unknown): void;
				selectTabIndex(i: number): void;
			};
			const strips: Tabs[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				const p = leaf.parent as unknown as Tabs;
				if (!strips.includes(p)) strips.push(p);
			});
			const shown = new Set<string>();
			const noteShown = () => {
				for (const t of strips) {
					const leaf = t.children[t.currentTab];
					if (leaf) shown.add((leaf as unknown as { id: string }).id);
				}
			};
			noteShown();
			const settle = async () => {
				const before = debug.stats().passes;
				for (let i = 0; i < 40 && debug.stats().passes === before; i++) await new Promise((r) => setTimeout(r, 15));
				await new Promise((r) => setTimeout(r, 30));
				noteShown();
			};
			const first = debug.stats().timings.length;
			for (let i = 0; i < 12; i++) {
				const tabs = strips[i % strips.length];
				if (!tabs) continue;
				const leaf = app.workspace.createLeafInParent(tabs as unknown as import('obsidian').WorkspaceSplit, tabs.children.length);
				await settle();
				leaf.detach();
				await settle();
			}
			for (let i = 0; i < 12; i++) {
				const tabs = strips[i % strips.length];
				if (!tabs) continue;
				// A background tab in the ungrouped tail moves within the tail (test code calls the recipe directly).
				const leaf = tabs.children[tabs.children.length - 1 - (i % 3)];
				if (!leaf) continue;
				const keep = tabs.children[tabs.currentTab];
				tabs.removeChild(leaf);
				(leaf as unknown as { setDimension(d: null): void }).setDimension(null);
				tabs.insertChild(tabs.children.length - 4, leaf);
				tabs.selectTabIndex(keep ? tabs.children.indexOf(keep) : 0);
				(app.workspace as unknown as { requestResize(): void }).requestResize();
				await settle();
			}
			const layoutEnd = debug.stats().timings.length;
			const targets = strips.map((t) => t.children[t.currentTab]).filter((l): l is import('obsidian').WorkspaceLeaf => l !== undefined);
			for (let i = 0; i < 30; i++) {
				const leaf = targets[i % targets.length];
				if (!leaf) continue;
				app.workspace.setActiveLeaf(leaf, { focus: true });
				await settle();
			}
			const all = debug.stats().timings;
			const deferredNow: string[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				if (leaf.isDeferred) deferredNow.push((leaf as unknown as { id: string }).id);
			});
			return {
				layout: all.slice(first, layoutEnd),
				switches: all.slice(layoutEnd),
				deferredNow,
				shownByTest: [...shown],
				loopStops: debug.stats().loopStops,
				leaves: all[all.length - 1]?.leaves ?? 0,
			};
		});

		const layoutPasses = run.layout.filter((t) => t.triggers.includes('layout'));
		const switchPasses = run.switches.filter((t) => t.triggers.length === 1 && t.triggers[0] === 'active');
		const layoutStats = stats(layoutPasses.map((t) => t.ms));
		const switchStats = stats(switchPasses.map((t) => t.ms));
		const startupStats = startup.map((t) => ({ triggers: t.triggers, ms: Number(t.ms.toFixed(3)), leaves: t.leaves }));
		// The plugin loaded no deferred leaf: every leaf deferred at the start is still deferred,
		// except the ones the test itself brought to the front (Obsidian loads a tab it shows).
		const shown = new Set(run.shownByTest);
		const stillDeferred = new Set(run.deferredNow);
		const loadedByPlugin = deferredAtStart.filter((id) => !shown.has(id) && !stillDeferred.has(id));
		record('E9', {
			tabs: built.length,
			deferredAtStart: deferredAtStart.length,
			deferredAtEnd: run.deferredNow.length,
			shownByTest: run.shownByTest.length,
			loadedByPlugin,
			startup: startupStats,
			layout: layoutStats,
			tabSwitch: switchStats,
			leavesInLastPass: run.leaves,
			passesWithOps: run.layout.filter((t) => t.ops > 0).length,
			loopStops: run.loopStops,
		});
		expect(layoutPasses.length).toBeGreaterThanOrEqual(30);
		expect(switchPasses.length).toBeGreaterThanOrEqual(25);
		expect(layoutStats.median).toBeLessThan(5);
		expect(layoutStats.max).toBeLessThan(50);
		expect(switchStats.median).toBeLessThan(5);
		expect(switchStats.max).toBeLessThan(50);
		expect(startupStats[0]?.leaves).toBe(STRIPS * PER_STRIP);
		expect(loadedByPlugin).toEqual([]);
		expect(run.loopStops).toBe(0);
		expect(await readErrors()).toEqual([]);
		writeEvidence('l4-perf');
	});
});
