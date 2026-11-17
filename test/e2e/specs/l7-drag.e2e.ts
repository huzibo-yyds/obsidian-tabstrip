/**
 * Step L7: drag tabs into and out of groups with Obsidian's own tab drag.
 *
 * Every drag here starts with REAL pointer input on the tab (trusted dragstart, Obsidian's own
 * tab drag), with Chromium's drag interception on, so it never becomes a system drag; the moves
 * and the drop are browser-level drag events (DevTools `Input.dispatchDragEvent`), hit-tested by
 * Chromium and delivered as trusted dragover / drop / dragend to the page. See test/e2e/drag.ts.
 * Where a case cannot do this, it says so.
 *
 * Run only through `npm run e2e` (sandbox Obsidian, host checks around the run).
 */
import { browser, expect } from '@wdio/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DropRecord, PassTrace } from '../../../src/controller';
import { cancelDrag, dragOver, dragTo, dropAt, enableDrags, highlight, indicator, pointFor, startDrag, type SpotSpec } from '../drag';
import {
	setLook,
	expectContiguous,
	expectDecorated,
	groupOf,
	mainStrip,
	makeGroup,
	membersInOrder,
	NOTES,
	openNotes,
	pageState,
	readErrors,
	record,
	repoRoot,
	runCommand,
	setActive,
	startErrorWatch,
	stripOf,
	waitForState,
	warmUpPopouts,
	withWarmPopout,
	openPopoutLeafWithNotes,
	windowHandleWith,
	headerSel,
	writeEvidence,
	type PageState,
	type Role,
} from '../helpers';

const CMD = { remove: 'tabstrip:remove-from-group', undo: 'workspace:undo-close-pane', moveToWindow: 'workspace:move-to-new-window' } as const;

function collapsed(s: PageState, groupId: string): boolean | undefined {
	return s.state.groups.find((g) => g.id === groupId)?.collapsed;
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
async function freshNotes<R extends Role>(roles: R[]): Promise<Record<R, string>> {
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

async function drops(): Promise<DropRecord[]> {
	return (await pageState()).stats.drops;
}

/** Waits until the drop was used by a pass (or failed to be), then for the layout to settle. */
async function afterDrop(count: number): Promise<PageState> {
	return waitForState((x) => x.stats.drops.length >= count && x.stats.drops[count - 1]?.fate !== 'pending', 'drop handled', 3000);
}

/** No group is split; every group is in one strip; the active tab is not hidden. */
function expectSane(s: PageState): void {
	for (const g of s.state.groups) expectContiguous(s, g.id);
	const active = s.activeId;
	if (active !== null) {
		const g = groupOf(s, active);
		const strip = s.strips.find((x) => x.leafIds.includes(active));
		if (g !== null && strip !== undefined && !strip.stacked) expect(collapsed(s, g)).toBe(false);
	}
}

interface LoggedEvent {
	t: number;
	type: string;
	detail?: string;
}

interface Fixture {
	name: string;
	what: string;
	obsidian: string;
	events: LoggedEvent[];
	passes: PassTrace[];
}

/**
 * Test-only event log for the S5 recordings: drag events on every window's document (capture, never
 * cancelled; dragover only counted), and the workspace events that schedule the plugin's passes.
 * Kept in the main window. Idempotent.
 */
async function installEventLog(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		type W = Window & { e2eEventLog?: { t: number; type: string; detail?: string }[]; e2eEventDocs?: WeakSet<Document> };
		const w = window as W;
		const log = (w.e2eEventLog ??= []);
		const docs = (w.e2eEventDocs ??= new WeakSet());
		const push = (type: string, detail?: string) => {
			const last = log[log.length - 1];
			if (type === 'dragover' && last?.type.startsWith('dragover')) {
				const n = Number(last.type.split('x')[1] ?? '1') + 1;
				last.type = `dragoverx${String(n)}`;
				return;
			}
			log.push(detail === undefined ? { t: performance.now(), type } : { t: performance.now(), type, detail });
		};
		const attach = (doc: Document, where: string) => {
			if (docs.has(doc)) return;
			docs.add(doc);
			for (const type of ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
				doc.addEventListener(
					type,
					(e) => {
						const el = e.target as HTMLElement | null;
						const header = el?.closest?.('.workspace-tab-header');
						push(type === 'dragover' ? 'dragover' : `${type}@${where}`, header?.getAttribute('data-e2e-leaf') ?? (el?.className?.toString().split(' ')[0] || undefined));
					},
					true,
				);
			}
		};
		attach(document, 'main');
		app.workspace.iterateAllLeaves((leaf) => {
			const doc = (leaf.getContainer() as unknown as { doc: Document }).doc;
			if (doc !== document) attach(doc, 'popout');
		});
		if ((w as Window & { e2eEventWs?: boolean }).e2eEventWs !== true) {
			(w as Window & { e2eEventWs?: boolean }).e2eEventWs = true;
			app.workspace.on('window-open', (ww) => {
				push('window-open');
				attach((ww as unknown as { doc: Document }).doc, 'popout');
			});
			app.workspace.on('window-close', () => {
				push('window-close');
			});
			app.workspace.on('layout-change', () => {
				push('layout-change');
			});
			app.workspace.on('active-leaf-change', (leaf) => {
				push('active-leaf-change', (leaf as unknown as { id?: string } | null)?.id);
			});
			app.workspace.on('file-open', () => {
				push('file-open');
			});
		}
	});
}

/** Returns the event log since the last call and clears it. */
async function clearEventLog(): Promise<LoggedEvent[]> {
	return browser.executeObsidian(() => {
		const w = window as Window & { e2eEventLog?: { t: number; type: string; detail?: string }[] };
		const out = [...(w.e2eEventLog ?? [])];
		if (w.e2eEventLog) w.e2eEventLog.length = 0;
		return out;
	});
}

/** The plugin's pass trace: on starts afresh, off stops and returns it. */
async function traceOn(on: boolean): Promise<PassTrace[]> {
	return browser.executeObsidian(({ app }, value) => {
		const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { trace(on: boolean): PassTrace[] } } | undefined> } }).plugins.plugins['tabstrip'];
		return p?.debug.trace(value) ?? [];
	}, on);
}

/** Screenshot of the sandbox window: docs/verification/L7 on 1.15.0 with TABSTRIP_WRITE_DOCS=1, else .e2e-state. */
async function l7shot(name: string): Promise<string> {
	const version = browser.getObsidianVersion();
	const toDocs = version === '1.15.0' && process.env.TABSTRIP_WRITE_DOCS === '1';
	const dir = toDocs ? path.join(repoRoot, 'docs', 'verification', 'L7') : path.join(repoRoot, '.e2e-state', 'l7-screens', version);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.png`);
	await browser.saveScreenshot(file);
	return path.relative(repoRoot, file);
}

async function expectNoErrors(): Promise<void> {
	expect(await readErrors()).toEqual([]);
}


describe('L7 drag tabs into and out of groups', function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }) => {
			const vault = app.vault as unknown as { setConfig(key: string, value: unknown): void; saveConfig(): Promise<void> };
			vault.setConfig('nativeMenus', false);
			await vault.saveConfig();
		});
		await startErrorWatch();
		const warmUp = await warmUpPopouts();
		await enableDrags();
		record('l7-setup', { warmUp, obsidian: browser.getObsidianVersion() });
	});

	beforeEach(async function () {
		// The plugin keeps only the last 50 drop records (DROP_LIMIT); the cases count their drops by
		// the length of that list, so each case starts from an empty list (review round 2: with D17's
		// drops the list was full by D15, and its count never grew).
		await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { controller?: { stats: { drops: unknown[] } } | null } | undefined> } }).plugins.plugins['tabstrip'];
			plugin?.controller?.stats.drops.splice(0);
		});
	});

	afterEach(async function () {
		// A case that failed halfway may leave a drag open in Chromium: end it (a no-op otherwise).
		const main = (await browser.getWindowHandles())[0];
		if (main !== undefined) await browser.switchToWindow(main);
		await cancelDrag();
		// A failed case may leave pop-outs open: close them, so the next case starts from the main window only.
		if (this.currentTest?.state === 'failed') {
			await browser.executeObsidian(({ app }) => {
				const wins = new Set<Window>();
				app.workspace.iterateAllLeaves((leaf) => {
					const win = leaf.getContainer().win;
					if (win !== window) wins.add(win);
				});
				for (const w of wins) w.close();
			});
			await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'pop-outs of a failed case closed');
		}
	});

	after(function () {
		writeEvidence('l7-drag');
	});

	it('D0 real drags stay inside the sandbox: interception confirmed, the press and move give one trusted dragstart', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		await startDrag(ids.n1);
		// Released over its own tab: no move.
		const p = await pointFor({ tab: ids.n1, side: 'before' });
		await dragOver(p, true);
		await dropAt(p);
		const s = await waitForState((x) => x.stats.dragEnds >= 1, 'drag ended');
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3]);
		record('D0', { dragEnds: s.stats.dragEnds, drops: s.stats.drops.map((d) => ({ spot: d.target.spot, fate: d.fate })) });
		await expectNoErrors();
	});

	it('D1 into the middle of a group: joins it; the group is highlighted while dragging, not after', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const g = await makeGroup([ids.n2, ids.n3, ids.n4], 'Work 工作', 'blue');
		await setActive(ids.n6);
		const before = (await drops()).length;
		let during: Awaited<ReturnType<typeof highlight>> | null = null;
		await dragTo(ids.n6, { tab: ids.n3, side: 'after' }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		const s = await afterDrop(before + 1);
		expect(during).toEqual({ headers: [ids.n2, ids.n3, ids.n4], chips: [g], group: g });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n6, ids.n4, ids.n5]);
		expect(groupOf(s, ids.n6)).toBe(g);
		expect(s.stats.drops[before]?.fate).toBe('used');
		expect(s.stats.drops[before]?.target.spot).toEqual({ kind: 'tab', leafId: ids.n3, side: 'after' });
		expectDecorated(s, g);
		expect(await highlight()).toEqual({ headers: [], chips: [], group: null });
		record('D1', { during, order: mainStrip(s).leafIds, intent: s.stats.drops[before]?.intent });
		await expectNoErrors();
	});

	it('D2 at a group end: the pointer on the last member joins; on the ungrouped neighbour stays out', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n1, ids.n2], 'End', 'green');
		await setActive(ids.n5);
		let n = (await drops()).length;
		let during: unknown = null;
		await dragTo(ids.n5, { tab: ids.n2, side: 'after' }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		let s = await afterDrop(++n);
		expect(during).toEqual({ headers: [ids.n1, ids.n2], chips: [g], group: g });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n5, ids.n3, ids.n4]);
		expect(groupOf(s, ids.n5)).toBe(g);

		// Same landing slot (after the group), pointer on the ungrouped tab to its right.
		await setActive(ids.n4);
		let off: unknown = null;
		await dragTo(ids.n4, { tab: ids.n3, side: 'before' }, async () => {
			await browser.pause(80);
			off = await highlight();
		});
		s = await afterDrop(++n);
		expect(off).toEqual({ headers: [], chips: [], group: null });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n5, ids.n4, ids.n3]);
		expect(groupOf(s, ids.n4)).toBeNull();
		expectDecorated(s, g);
		record('D2', { join: during, off });
		await expectNoErrors();
	});

	it('D3 at a group start: the pointer on the chip joins (the chip moves to the tab); on the tab before stays out', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n3, ids.n4], 'Start 开始', 'red');
		await setActive(ids.n5);
		let n = (await drops()).length;
		let during: unknown = null;
		await dragTo(ids.n5, { chip: g }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		let s = await afterDrop(++n);
		expect(during).toEqual({ headers: [ids.n3, ids.n4], chips: [g], group: g });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n5, ids.n3, ids.n4]);
		expect(groupOf(s, ids.n5)).toBe(g);
		expect(s.chips.find((c) => c.groupId === g)?.hostLeafId).toBe(ids.n5);
		expectDecorated(s, g);

		await setActive(ids.n1);
		await dragTo(ids.n1, { tab: ids.n2, side: 'after' });
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n2, ids.n1, ids.n5, ids.n3, ids.n4]);
		expect(groupOf(s, ids.n1)).toBeNull();
		expectDecorated(s, g);
		await expectNoErrors();
	});

	it('D4 out of a group: leaves it; the chip moves to the new first member; a member at its own edge with the pointer outside leaves too', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n1, ids.n2, ids.n3], 'Out', 'purple');
		let n = (await drops()).length;
		await setActive(ids.n1);
		await dragTo(ids.n1, { endOf: ids.n5 });
		let s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n2, ids.n3, ids.n4, ids.n5, ids.n1]);
		expect(groupOf(s, ids.n1)).toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3]);
		expect(s.chips.find((c) => c.groupId === g)?.hostLeafId).toBe(ids.n2);
		expectDecorated(s, g);
		// n3, the last member, dropped on the right half of the ungrouped n4 (the left half would be the
		// slot it already has): it leaves the group.
		await setActive(ids.n3);
		await dragTo(ids.n3, { tab: ids.n4, side: 'after' });
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n2, ids.n4, ids.n3, ids.n5, ids.n1]);
		expect(groupOf(s, ids.n3)).toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n2]);
		await expectNoErrors();
	});

	it('D5 S2 collapsed groups at the start, middle and end: the native drop line stays at sane places; a drop on a collapsed chip goes right after the group', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
		const start = await makeGroup([ids.n1, ids.n2], 'S', 'cyan');
		const mid = await makeGroup([ids.n4, ids.n5], 'M', 'orange');
		const end = await makeGroup([ids.n7, ids.n8], '', 'pink');
		await setActive(ids.n3);
		for (const g of [start, mid, end]) await setCollapsedVia(g, true);
		let s = await waitForState((x) => x.state.groups.every((g) => g.collapsed), 'all collapsed');
		const strip = mainStrip(s);
		expect(strip.leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6, ids.n7, ids.n8]);
		const geometry = await browser.executeObsidian(({ app }, leafIds) => {
			const out: Record<string, { left: number; right: number }> = {};
			for (const id of leafIds) {
				const leaf = app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement } | null;
				const r = leaf?.tabHeaderEl.getBoundingClientRect();
				if (r) out[id] = { left: r.left, right: r.right };
			}
			const row = (app.workspace.getLeafById(leafIds[0] ?? '') as unknown as { parent: { tabHeaderContainerEl: HTMLElement } }).parent.tabHeaderContainerEl.getBoundingClientRect();
			return { headers: out, row: { left: row.left, right: row.right } };
		}, strip.leafIds);

		// Drag n6 (visible) and hover each boundary: three samples each, the line must not move and
		// must sit at the boundary Obsidian computes (start or end edge of a visible header, or the
		// hidden headers' place right after a chip), never at the strip's left end.
		await setActive(ids.n6);
		await startDrag(ids.n6);
		const spots: { name: string; spec: SpotSpec }[] = [
			{ name: 'start chip', spec: { chip: start } },
			{ name: 'n3 left half', spec: { tab: ids.n3, side: 'before' } },
			{ name: 'n3 right half', spec: { tab: ids.n3, side: 'after' } },
			{ name: 'middle chip', spec: { chip: mid } },
			{ name: 'n6 right half', spec: { tab: ids.n6, side: 'after' } },
			{ name: 'end chip', spec: { chip: end } },
			{ name: 'strip end', spec: { endOf: ids.n6 } },
		];
		const samples: Record<string, unknown> = {};
		let first = true;
		for (const { name, spec } of spots) {
			const p = await pointFor(spec);
			const lines: ({ center: number } | null)[] = [];
			// The line glides to a new place (Obsidian's own transition): sample once it has arrived,
			// then twice more while the pointer stays.
			await dragOver(p, first);
			first = false;
			await browser.pause(300);
			for (let i = 0; i < 3; i++) {
				await dragOver(p);
				await browser.pause(70);
				lines.push(await indicator());
			}
			samples[name] = { pointer: p, lines };
			console.log(`[l7] D5 ${name}: ${JSON.stringify(samples[name])}`);
			const centers = lines.map((l) => l?.center ?? NaN);
			// Visible, stable (no flicker between samples), inside the strip, not at its left end.
			for (const c of centers) {
				expect(Number.isNaN(c)).toBe(false);
				expect(c).toBeGreaterThan(geometry.row.left + 2);
				expect(c).toBeLessThan(geometry.row.right);
			}
			expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(0.5);
		}
		record('D5-lines', { geometry, samples });
		const at = (name: string) => ((samples[name] as { lines: { center: number }[] }).lines[0]?.center ?? NaN);
		const h = geometry.headers;
		// Start chip: the line sits where the hidden n1 n2 are (right after the chip, before n3).
		expect(Math.abs(at('start chip') - (h[ids.n1]?.left ?? NaN))).toBeLessThanOrEqual(1);
		expect(Math.abs(at('n3 left half') - (h[ids.n3]?.left ?? NaN))).toBeLessThanOrEqual(1);
		expect(Math.abs(at('n3 right half') - (h[ids.n3]?.right ?? NaN))).toBeLessThanOrEqual(1);
		expect(Math.abs(at('middle chip') - (h[ids.n4]?.left ?? NaN))).toBeLessThanOrEqual(1);
		expect(Math.abs(at('end chip') - (h[ids.n7]?.left ?? NaN))).toBeLessThanOrEqual(1);
		// No group is highlighted over a collapsed group.
		expect(await highlight()).toEqual({ headers: [], chips: [], group: null });

		// Drop on the middle chip: right after M, ungrouped, visible; M stays collapsed.
		let n = (await drops()).length;
		await dropAt(await pointFor({ chip: mid }));
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6, ids.n7, ids.n8]);
		expect(groupOf(s, ids.n6)).toBeNull();
		expect(s.state.groups.every((g) => g.collapsed)).toBe(true);
		expect(s.stats.drops[n - 1]?.intent).toEqual({ leafId: ids.n6, joinGroupId: null, afterGroupId: mid });
		// n3 onto the end chip: Obsidian inserts it before n7; the plugin moves it right after the group.
		await setActive(ids.n3);
		await dragTo(ids.n3, { chip: end });
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n4, ids.n5, ids.n6, ids.n7, ids.n8, ids.n3]);
		expect(groupOf(s, ids.n3)).toBeNull();
		expect(collapsed(s, end)).toBe(true);
		// n3 onto the start chip: right after S.
		await dragTo(ids.n3, { chip: start });
		s = await afterDrop(++n);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6, ids.n7, ids.n8]);
		expect(s.state.groups.every((g) => g.collapsed)).toBe(true);
		expectSane(s);
		for (const g of [start, mid, end]) await setCollapsedVia(g, false);
		await expectNoErrors();
	});

	it('D6 to another split: leaves its group; into the middle of a group there: joins it; a group left empty goes', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n1, ids.n2], 'Left', 'blue');
		const solo = await makeGroup([ids.n4], 'Solo', 'yellow');
		// A split to the right with three notes (public API), grouped there.
		const right = await browser.executeObsidian(
			async ({ app, obsidian }, paths) => {
				const out: string[] = [];
				let leaf = app.workspace.getLeaf('split', 'vertical');
				for (const [i, p] of paths.entries()) {
					const file = app.vault.getFileByPath(p);
					if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
					if (i > 0) leaf = app.workspace.getLeaf('tab');
					await leaf.openFile(file);
					out.push((leaf as unknown as { id: string }).id);
				}
				return out;
			},
			[NOTES.n7, NOTES.n8, NOTES.n9],
		);
		const [r1, r2, r3] = right as [string, string, string];
		await waitForState((x) => x.strips.length === 2, 'split ready');
		const h = await makeGroup([r1, r2, r3], 'Right 右', 'green');
		let n = (await drops()).length;
		await setActive(ids.n2);
		let during: unknown = null;
		await dragTo(ids.n2, { tab: r2, side: 'after' }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		let s = await afterDrop(++n);
		expect(during).toEqual({ headers: [r1, r2, r3], chips: [h], group: h });
		expect(stripOf(s, r1).leafIds).toEqual([r1, r2, ids.n2, r3]);
		expect(groupOf(s, ids.n2)).toBe(h);
		expect(membersInOrder(s, g)).toEqual([ids.n1]);
		// The only member of Solo, dropped after the right group with the pointer outside it: Solo goes.
		await setActive(ids.n4);
		await dragTo(ids.n4, { endOf: r3 });
		s = await afterDrop(++n);
		expect(stripOf(s, r1).leafIds).toEqual([r1, r2, ids.n2, r3, ids.n4]);
		expect(groupOf(s, ids.n4)).toBeNull();
		expect(s.state.groups.some((x) => x.id === solo)).toBe(false);
		expectSane(s);
		record('D6', { during, right: stripOf(s, r1).leafIds });
		await expectNoErrors();
	});

	it('D7 to a pop-out window: leaves its group in the main window; at the pop-out group\'s chip: joins it; "Move to new window" leaves too', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3']);
		const g = await makeGroup([ids.n1, ids.n2], 'Main', 'red');
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n10]));
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 2), 'pop-out ready');
		const [p1, p2] = pop as [string, string];
		const pg = await makeGroup([p1, p2], 'Pop 弹出', 'cyan');
		await pageState();
		const main = await browser.getWindowHandle();
		const popHandle = await windowHandleWith(headerSel(p1));
		if (popHandle === null) throw new Error('no pop-out window handle');
		await browser.switchToWindow(popHandle);
		await enableDrags();
		await browser.switchToWindow(main);
		let n = (await drops()).length;
		await setActive(ids.n2);
		await startDrag(ids.n2);
		// The pointer leaves the main window and enters the pop-out (its own browser window).
		await browser.switchToWindow(popHandle);
		const p = await pointFor({ chip: pg });
		await dragOver(p, true);
		await browser.pause(120);
		await dragOver(p);
		await browser.pause(120);
		const during = await highlight();
		await dropAt(p);
		let s = await afterDrop(++n);
		// The source window ends its drag.
		await browser.switchToWindow(main);
		await cancelDrag();
		s = await waitForState((x) => x.strips.some((st) => st.leafIds.includes(ids.n2) && st.kind === 'popout'), 'n2 in the pop-out');
		expect(during).toEqual({ headers: [p1, p2], chips: [pg], group: pg });
		expect(stripOf(s, p1).leafIds).toEqual([ids.n2, p1, p2]);
		expect(groupOf(s, ids.n2)).toBe(pg);
		expect(membersInOrder(s, g)).toEqual([ids.n1]);
		expect(s.stats.drops[n - 1]?.fate).toBe('used');
		expectSane(s);
		record('D7', { during, pop: stripOf(s, p1).leafIds, drop: s.stats.drops[n - 1] });
		// "Move to new window" (command) on a member: leaves its group (rule 5, no drag intent).
		await withWarmPopout(async () => {
			await setActive(ids.n1);
			await runCommand(CMD.moveToWindow);
			await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 1 && st.leafIds[0] === ids.n1), 'n1 in its own window');
		});
		s = await pageState();
		expect(groupOf(s, ids.n1)).toBeNull();
		expect(s.state.groups.some((x) => x.id === g)).toBe(false);
		await browser.executeObsidian(({ app }, idList) => {
			for (const id of idList) app.workspace.getLeafById(id)?.getContainer().win.close();
		}, [p1, ids.n1]);
		await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'pop-outs closed');
		await expectNoErrors();
	});

	it('D8 Escape / cancelled drag: the highlight goes, nothing moves, the drop intent is not kept; leaving the strip clears it too', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Esc', 'orange');
		await setActive(ids.n4);
		const before = await pageState();
		await startDrag(ids.n4);
		const p = await pointFor({ tab: ids.n2, side: 'after' });
		await dragOver(p, true);
		await browser.pause(80);
		await dragOver(p);
		await browser.pause(80);
		const on = await highlight();
		// A real Escape key press (WebDriver key input) does not reach a drag that Chromium holds for
		// the test (interception): recorded, not asserted. In real use Escape ends the system drag and
		// Chromium sends dragleave and dragend with dropEffect none, which is what dragCancel does.
		await browser.keys('Escape');
		await browser.pause(150);
		const afterKey = { highlight: await highlight(), dragEnds: (await pageState()).stats.dragEnds - before.stats.dragEnds };
		await cancelDrag();
		const s = await waitForState((x) => x.stats.dragEnds > before.stats.dragEnds, 'drag ended');
		expect(on).toEqual({ headers: [ids.n2, ids.n3], chips: [g], group: g });
		expect(await highlight()).toEqual({ headers: [], chips: [], group: null });
		expect(mainStrip(s).leafIds).toEqual(mainStrip(before).leafIds);
		expect(s.stats.drops.length).toBe(before.stats.drops.length);
		expect(groupOf(s, ids.n4)).toBeNull();
		const grabbing = await browser.execute(() => document.body.classList.contains('is-grabbing'));
		expect(grabbing).toBe(false);
		record('D8', { on, afterKey, grabbing });
		// Leaving the strip (over the note below) also removes the highlight.
		await startDrag(ids.n4);
		await dragOver(p, true);
		await browser.pause(80);
		await dragOver(p);
		await browser.pause(80);
		expect((await highlight()).group).toBe(g);
		const content = await browser.execute(() => {
			const r = document.querySelector('.workspace-leaf.mod-active .view-content')?.getBoundingClientRect();
			return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 500, y: 400 };
		});
		await dragOver(content);
		await browser.pause(80);
		expect(await highlight()).toEqual({ headers: [], chips: [], group: null });
		await cancelDrag();
		await waitForState((x) => x.stats.dragEnds >= s.stats.dragEnds + 1, 'second drag ended');
		await expectNoErrors();
	});

	it('D9 pinned tabs: a pinned tab dropped inside a group stays out and goes back to the pinned area', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3, ids.n4], 'Pins', 'grey');
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.setPinned(true);
		}, ids.n1);
		await waitForState((x) => mainStrip(x).pinned[0] === true, 'n1 pinned');
		const n = (await drops()).length;
		await setActive(ids.n1);
		let during: unknown = null;
		await dragTo(ids.n1, { tab: ids.n3, side: 'after' }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		await afterDrop(n + 1);
		const settled = await waitForState((x) => mainStrip(x).leafIds[0] === ids.n1, 'pinned tab first again');
		expect(during).toEqual({ headers: [], chips: [], group: null });
		expect(groupOf(settled, ids.n1)).toBeNull();
		expect(membersInOrder(settled, g)).toEqual([ids.n2, ids.n3, ids.n4]);
		expect(mainStrip(settled).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4]);
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.setPinned(false);
		}, ids.n1);
		await expectNoErrors();
	});

	it('D10 a drop that moved nothing is never kept: a later programmatic move gets no intent (L3 rules apply)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n1, ids.n2], 'Late', 'pink');
		await setActive(ids.n4);
		const n = (await drops()).length;
		// n4 released over its own right half: nothing moves, so the drop is not kept at all (review
		// round 1: before, it stayed pending for 1 s and an unrelated change could pick it up).
		await dragTo(ids.n4, { tab: ids.n4, side: 'after' });
		expect((await afterDrop(n + 1)).stats.drops[n]?.fate).toBe('noop');
		// Within the 1 s an intent used to live.
		await browser.pause(150);
		// Another plugin moves n4 to the end of G (native move recipe, test code): no intent now.
		await browser.executeObsidian(({ app }, id) => {
			type Tabs = { children: unknown[]; currentTab: number; removeChild(l: unknown): void; insertChild(i: number, l: unknown): void; selectTabIndex(i: number): void };
			const leaf = app.workspace.getLeafById(id) as unknown as { parent: Tabs; setDimension(d: null): void };
			const tabs = leaf.parent;
			const shown = tabs.children[tabs.currentTab];
			tabs.removeChild(leaf);
			leaf.setDimension(null);
			tabs.insertChild(2, leaf);
			tabs.selectTabIndex(shown ? tabs.children.indexOf(shown) : 2);
			app.workspace.trigger('layout-change');
		}, ids.n4);
		const s = await waitForState((x) => mainStrip(x).leafIds[2] === ids.n4 && x.stats.drops[n]?.fate !== 'pending', 'moved by another plugin');
		expect(s.stats.drops[n]?.fate).toBe('noop');
		expect(s.stats.drops).toHaveLength(n + 1);
		expect(groupOf(s, ids.n4)).toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n1, ids.n2]);
		record('D10', { drop: s.stats.drops[n] });
		await expectNoErrors();
	});

	it('D16 review round 1: a drag never outlives its drop (source pop-out closed, stacked pop-out); a pop-out drop next to a collapsed group leaves the source strip alone; a chip drop right before a collapsed group goes after it', async function () {
		const main = await browser.getWindowHandle();
		const reveals = async (on: boolean): Promise<string[]> =>
			browser.executeObsidian(({ app }, value) => {
				type W = Window & { e2eReveals?: string[] };
				const w = window as W;
				const ws = app.workspace as unknown as { revealLeaf: (l: unknown) => Promise<void> };
				const out = [...(w.e2eReveals ?? [])];
				if (value && w.e2eReveals === undefined) {
					const orig = ws.revealLeaf.bind(ws);
					w.e2eReveals = [];
					// Test-only spy on this instance: counts revealLeaf calls (the plugin must not make any here).
					ws.revealLeaf = (l: unknown) => {
						w.e2eReveals?.push((l as { id?: string }).id ?? '?');
						return orig(l);
					};
				} else if (!value && w.e2eReveals !== undefined) {
					// The spy is an own property; deleting it brings back the class method.
					delete (ws as { revealLeaf?: unknown }).revealLeaf;
					delete w.e2eReveals;
				}
				return out;
			}, on);
		/** A drag from outside (no dragstart: a file, a link) over the group: nothing may be highlighted. */
		const foreignOver = async (groupId: string): Promise<{ headers: string[]; chips: string[]; group: string | null }> => {
			const p = await pointFor({ chip: groupId });
			await dragOver(p, true);
			await browser.pause(80);
			await dragOver({ x: p.x + 1, y: p.y });
			await browser.pause(80);
			const h = await highlight();
			await cancelDrag();
			return h;
		};

		// (a) The only tab of a pop-out dragged into the middle of a main-window group: the pop-out
		// closes, and its dragend never comes (no manual cancel in the source window here).
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		const g = await makeGroup([ids.n2, ids.n3], 'Stay', 'blue');
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n11]));
		const lone = pop[0] ?? '';
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(lone)), 'lone pop-out ready');
		const popHandle = await windowHandleWith(headerSel(lone));
		if (popHandle === null) throw new Error('no pop-out window handle');
		await browser.switchToWindow(popHandle);
		await enableDrags();
		let n = (await drops()).length;
		const ends = (await pageState()).stats.dragEnds;
		await startDrag(lone);
		await browser.switchToWindow(main);
		const mid = await pointFor({ tab: ids.n2, side: 'after' });
		await dragOver(mid, true);
		await browser.pause(100);
		await dragOver(mid);
		await browser.pause(100);
		const during = await highlight();
		await dropAt(mid);
		let s = await afterDrop(++n);
		s = await waitForState((x) => x.strips.every((st) => st.kind === 'main') && x.stats.dragEnds > ends, 'pop-out closed, drag ended');
		expect(during.group).toBe(g);
		expect(groupOf(s, lone)).toBe(g);
		expect(membersInOrder(s, g)).toEqual([ids.n2, lone, ids.n3]);
		const afterA = await foreignOver(g);
		expect(afterA).toEqual({ headers: [], chips: [], group: null });
		record('D16a', { during, ends: s.stats.dragEnds - ends, foreign: afterA, drops: (await pageState()).stats.drops.length - n });
		expect((await pageState()).stats.drops).toHaveLength(n);

		// (b) A main tab dropped into a pop-out whose only strip is stacked: dragend goes to the pop-out.
		const { result: pop2 } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9, NOTES.n11]));
		const [s1] = pop2 as [string, string];
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(s1)), 'second pop-out ready');
		await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id) as unknown as { parent: { setStacked(on: boolean): void } };
			leaf.parent.setStacked(true);
		}, s1);
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.stacked), 'pop-out stacked');
		const stackHandle = await windowHandleWith(headerSel(s1));
		if (stackHandle === null) throw new Error('no stacked pop-out handle');
		await browser.switchToWindow(stackHandle);
		await enableDrags();
		await browser.switchToWindow(main);
		const ends2 = (await pageState()).stats.dragEnds;
		await setActive(ids.n4);
		await startDrag(ids.n4);
		await browser.switchToWindow(stackHandle);
		const onStacked = await pointFor({ tab: s1, side: 'after' });
		await dragOver(onStacked, true);
		await browser.pause(100);
		await dragOver(onStacked);
		await browser.pause(100);
		await dropAt(onStacked);
		await browser.switchToWindow(main);
		s = await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(ids.n4)), 'n4 in the stacked pop-out');
		s = await waitForState((x) => x.stats.dragEnds > ends2, 'drag ended in the stacked pop-out');
		const afterB = await foreignOver(g);
		expect(afterB).toEqual({ headers: [], chips: [], group: null });
		record('D16b', { ends: s.stats.dragEnds - ends2, foreign: afterB, pop: stripOf(s, s1).leafIds });
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.getContainer().win.close();
		}, s1);
		await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'stacked pop-out closed');

		// (c) The shown tab next to a collapsed group dragged into a pop-out: the main strip shows its
		// visible neighbour without revealLeaf (no window focus, no deferred load); the dropped tab
		// stays active in the pop-out; the group stays collapsed.
		const c = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const gc = await makeGroup([c.n3, c.n4], 'Shut', 'purple');
		await setCollapsedVia(gc, true);
		await setActive(c.n2);
		// Loading the layout again leaves background tabs deferred (as after a restart).
		await browser.executeObsidian(async ({ app }) => {
			await app.workspace.changeLayout(app.workspace.getLayout());
		});
		await waitForState((x) => mainStrip(x).leafIds.length === 5 && collapsed(x, gc) === true, 'layout loaded again');
		await setActive(c.n2);
		const deferred = () =>
			browser.executeObsidian(({ app }) => {
				const out: string[] = [];
				app.workspace.iterateRootLeaves((l) => {
					if ((l as unknown as { isDeferred?: boolean }).isDeferred === true) out.push((l as unknown as { id: string }).id);
				});
				return out;
			});
		const deferredBefore = await deferred();
		const { result: pop3 } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9]));
		const target = pop3[0] ?? '';
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(target)), 'target pop-out ready');
		const targetHandle = await windowHandleWith(headerSel(target));
		if (targetHandle === null) throw new Error('no target pop-out handle');
		await browser.switchToWindow(targetHandle);
		await enableDrags();
		await browser.switchToWindow(main);
		await setActive(c.n2);
		await reveals(true);
		n = (await drops()).length;
		const ends3 = (await pageState()).stats.dragEnds;
		await startDrag(c.n2);
		await browser.switchToWindow(targetHandle);
		const end = await pointFor({ endOf: target });
		await dragOver(end, true);
		await browser.pause(100);
		await dragOver(end);
		await browser.pause(100);
		await dropAt(end);
		await browser.switchToWindow(main);
		s = await afterDrop(++n);
		s = await waitForState((x) => stripOf(x, target).leafIds.includes(c.n2) && mainStrip(x).currentId === c.n5, 'main strip shows its visible neighbour');
		await browser.pause(300);
		s = await pageState();
		const revealed = await reveals(false);
		const deferredAfter = await deferred();
		const result = {
			main: mainStrip(s).leafIds,
			shown: mainStrip(s).currentId,
			active: s.activeId,
			collapsed: collapsed(s, gc),
			revealed,
			deferredBefore,
			loaded: deferredBefore.filter((id) => !deferredAfter.includes(id)),
			drop: s.stats.drops[n - 1]?.fate,
		};
		record('D16c', result);
		expect(result.shown).toBe(c.n5);
		expect(result.active).toBe(c.n2);
		expect(result.collapsed).toBe(true);
		expect(result.revealed).toEqual([]);
		expect(deferredBefore).toContain(c.n5);
		expect(deferredBefore).toContain(c.n1);
		// Obsidian loads the tab a visible strip shows (its own tab display: first n3, the tab at the
		// moved tab's index, then n5, the visible neighbour the plugin selects; the same as closing the
		// shown tab, step L5). No other tab is loaded: the plugin itself loads nothing.
		expect(result.loaded.filter((id) => id !== c.n2 && id !== c.n3 && id !== c.n5)).toEqual([]);
		expect(deferredAfter).toContain(c.n1);
		// The plugin ended the drag on the drop by itself.
		expect(s.stats.dragEnds).toBeGreaterThan(ends3);
		expectSane(s);
		// Chromium still holds the intercepted drag in the source window (a real system drag ends by
		// itself): end it there, or the next press in this window starts no drag.
		await cancelDrag();
		await browser.executeObsidian(({ app }, id) => {
			app.workspace.getLeafById(id)?.getContainer().win.close();
		}, target);
		await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'target pop-out closed');

		// (d) The tab right before a collapsed group, released on that group's chip: Obsidian does not
		// move it (it inserts before the group, where the tab is); the plugin puts it right after the
		// group, ungrouped, like every other drop on a collapsed chip.
		const d = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const gd = await makeGroup([d.n3, d.n4], 'Next', 'yellow');
		await setCollapsedVia(gd, true);
		await setActive(d.n2);
		n = (await drops()).length;
		await dragTo(d.n2, { chip: gd });
		s = await afterDrop(++n);
		s = await waitForState((x) => mainStrip(x).leafIds.indexOf(d.n2) === 3, 'n2 right after the collapsed group');
		expect(mainStrip(s).leafIds).toEqual([d.n1, d.n3, d.n4, d.n2, d.n5]);
		expect(s.stats.drops[n - 1]?.fate).toBe('noop');
		expect(s.stats.drops[n - 1]?.afterCollapsed).toBe(true);
		expect(groupOf(s, d.n2)).toBeNull();
		expect(collapsed(s, gd)).toBe(true);
		expectSane(s);
		record('D16d', { strip: mainStrip(s).leafIds, drop: s.stats.drops[n - 1] });
		await expectNoErrors();
	});

	it('D17 review round 2: the tab next to an expanded group, released on its chip, its first member\'s left half or its last member\'s right half, joins in place; a boundary member released on its ungrouped neighbour leaves in place', async function () {
		// Obsidian does not move any of these drops (the tab is released next to itself, on the side it
		// already is); the plugin applies rules 2 and 3 itself after Obsidian's drop (core dropInPlace).
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const g = await makeGroup([ids.n3, ids.n4], 'Edge', 'cyan');
		const order = [ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6];
		let n = (await drops()).length;
		const spans: Record<string, unknown> = {};
		const step = async (name: string, leafId: string, spot: SpotSpec, until: (x: PageState) => boolean): Promise<PageState> => {
			await setActive(leafId);
			let during: unknown = null;
			await dragTo(leafId, spot, async () => {
				await browser.pause(80);
				during = await highlight();
			});
			await afterDrop(++n);
			const s = await waitForState(until, name);
			// Obsidian moved nothing, and neither did the plugin.
			expect(mainStrip(s).leafIds).toEqual(order);
			expect(s.stats.drops[n - 1]?.fate).toBe('noop');
			expect(s.stats.drops[n - 1]?.inPlace).toBe(true);
			expect(s.stats.drops[n - 1]?.afterCollapsed).toBeUndefined();
			expectSane(s);
			expectDecorated(s, g);
			spans[name] = { during, members: membersInOrder(s, g), drop: s.stats.drops[n - 1] };
			return { ...s, during } as PageState & { during: unknown };
		};

		// (a) n2, right before G, released on G's chip: joins as first member; the chip moves to n2.
		let s = await step('a-chip', ids.n2, { chip: g }, (x) => groupOf(x, ids.n2) === g);
		expect((s as PageState & { during: unknown }).during).toEqual({ headers: [ids.n3, ids.n4], chips: [g], group: g });
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3, ids.n4]);
		expect(s.chips.find((c) => c.groupId === g)?.hostLeafId).toBe(ids.n2);

		// (b) n5, right after G, released on the right half of G's last member: joins as last member.
		s = await step('b-last-right-half', ids.n5, { tab: ids.n4, side: 'after' }, (x) => groupOf(x, ids.n5) === g);
		expect((s as PageState & { during: unknown }).during).toEqual({ headers: [ids.n2, ids.n3, ids.n4], chips: [g], group: g });
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3, ids.n4, ids.n5]);

		// (c) n2, the first member, released on the right half of the ungrouped n1: leaves in place; the
		// chip moves to the new first member, n3; no highlight while over n1.
		s = await step('c-leave-first', ids.n2, { tab: ids.n1, side: 'after' }, (x) => groupOf(x, ids.n2) === null);
		expect((s as PageState & { during: unknown }).during).toEqual({ headers: [], chips: [], group: null });
		expect(membersInOrder(s, g)).toEqual([ids.n3, ids.n4, ids.n5]);
		expect(s.chips.find((c) => c.groupId === g)?.hostLeafId).toBe(ids.n3);

		// (d) n5, the last member, released on the left half of the ungrouped n6: leaves in place.
		s = await step('d-leave-last', ids.n5, { tab: ids.n6, side: 'before' }, (x) => groupOf(x, ids.n5) === null);
		expect(membersInOrder(s, g)).toEqual([ids.n3, ids.n4]);

		// (e) n2 again (ungrouped, right before G), released on the left half of G's first member: joins.
		s = await step('e-first-left-half', ids.n2, { tab: ids.n3, side: 'before' }, (x) => groupOf(x, ids.n2) === g);
		expect((s as PageState & { during: unknown }).during).toEqual({ headers: [ids.n3, ids.n4], chips: [g], group: g });
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3, ids.n4]);
		expect(s.chips.find((c) => c.groupId === g)?.hostLeafId).toBe(ids.n2);

		// The change is saved like any other (run -> render -> requestSave): the stored group lists n2 first.
		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ app }, gid, want) => {
					const v = app.loadLocalStorage('tabstrip-session-v1') as { groups?: { groupId: string; members: { leafId: string }[] }[] } | null;
					const group = v?.groups?.find((x) => x.groupId === gid);
					return JSON.stringify(group?.members.map((m) => m.leafId)) === JSON.stringify(want);
				}, g, [ids.n2, ids.n3, ids.n4]),
			{ timeout: 4000, timeoutMsg: 'in-place join saved' },
		);
		record('D17', spans);
		await expectNoErrors();
	});

	it('D18 review round 3: a tab dragged out of a stacked strip into a horizontal strip: the pointer on a member joins (rule 2), a collapsed chip puts it after the group (rule 4); it leaves its stacked group (rule 5)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const g = await makeGroup([ids.n2, ids.n3], 'Open', 'purple');
		const c = await makeGroup([ids.n5, ids.n6], 'Shut', 'orange');
		await setActive(ids.n1);
		await setCollapsedVia(c, true);
		// A split to the right with three notes, two of them grouped, then shown stacked (test code
		// calls setStacked directly, like D16b).
		const right = await browser.executeObsidian(
			async ({ app, obsidian }, paths) => {
				const out: string[] = [];
				let leaf = app.workspace.getLeaf('split', 'vertical');
				for (const [i, p] of paths.entries()) {
					const file = app.vault.getFileByPath(p);
					if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
					if (i > 0) leaf = app.workspace.getLeaf('tab');
					await leaf.openFile(file);
					out.push((leaf as unknown as { id: string }).id);
				}
				return out;
			},
			[NOTES.n7, NOTES.n8, NOTES.n9],
		);
		const [r1, r2, r3] = right as [string, string, string];
		await waitForState((x) => x.strips.length === 2, 'split ready');
		const k = await makeGroup([r1, r2], 'Stack', 'green');
		await browser.executeObsidian(({ app }, id) => {
			const leaf = app.workspace.getLeafById(id) as unknown as { parent: { setStacked(on: boolean): void } };
			leaf.parent.setStacked(true);
		}, r1);
		await waitForState((x) => x.strips.some((st) => st.leafIds.includes(r1) && st.stacked), 'right split stacked');
		let n = (await drops()).length;

		// (a) r1 from the stacked strip, released on the right half of G's last member: joins G.
		await setActive(r1);
		let duringA: unknown = null;
		await dragTo(r1, { tab: ids.n3, side: 'after' }, async () => {
			await browser.pause(80);
			duringA = await highlight();
		});
		let s = await afterDrop(++n);
		s = await waitForState((x) => groupOf(x, r1) !== k, 'r1 left its stacked group');
		expect(duringA).toEqual({ headers: [ids.n2, ids.n3], chips: [g], group: g });
		expect(s.stats.drops[n - 1]?.target.leafId).toBe(r1);
		expect(s.stats.drops[n - 1]?.target.spot).toEqual({ kind: 'tab', leafId: ids.n3, side: 'after' });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, r1, ids.n4, ids.n5, ids.n6]);
		expect(groupOf(s, r1)).toBe(g);
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n3, r1]);
		expect(membersInOrder(s, k)).toEqual([r2]);
		expectSane(s);

		// (b) r2, the last member of the stacked group, released on the collapsed group's chip: placed
		// right after that group, ungrouped and visible; the group stays collapsed; the stacked group goes.
		await setActive(r2);
		let duringB: unknown = null;
		await dragTo(r2, { chip: c }, async () => {
			await browser.pause(80);
			duringB = await highlight();
		});
		s = await afterDrop(++n);
		s = await waitForState((x) => mainStrip(x).leafIds.at(-1) === r2, 'r2 after the collapsed group');
		expect(duringB).toEqual({ headers: [], chips: [], group: null });
		expect(s.stats.drops[n - 1]?.target.spot).toEqual({ kind: 'chip', groupId: c });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, r1, ids.n4, ids.n5, ids.n6, r2]);
		expect(groupOf(s, r2)).toBeNull();
		expect(collapsed(s, c)).toBe(true);
		expect(s.state.groups.some((x) => x.id === k)).toBe(false);
		expect(stripOf(s, r3).leafIds).toEqual([r3]);
		expectSane(s);
		record('D18', { duringA, duringB, main: mainStrip(s).leafIds, drops: s.stats.drops.slice(n - 2, n) });
		await expectNoErrors();
	});

	it('D19 review round 3: the header row scrolls during a drag: the highlight and the drop follow the tab under the pointer, not the boxes measured before the scroll', async function () {
		// Obsidian's own root tab row never scrolls (tabs shrink; 1.14+ also clips it). Themes and
		// plugins can make it scroll: the Vertical Tabs plugin's "scrollable tabs" mode gives tabs a
		// minimum width and lets the row overflow. Test-only CSS does the same here (removed at the end).
		await browser.execute(() => {
			const style = document.createElement('style');
			style.id = 'e2e-scrollable-tabs';
			style.textContent =
				'.workspace .mod-root .workspace-tabs:not(.mod-stacked) .workspace-tab-header-container-inner{overflow-x:auto !important}' +
				'.workspace .mod-root .workspace-tabs:not(.mod-stacked) .workspace-tab-header{min-width:140px !important}';
			document.head.appendChild(style);
		});
		try {
			await scrolledDrag();
		} finally {
			await browser.execute(() => document.getElementById('e2e-scrollable-tabs')?.remove());
		}
	});

	async function scrolledDrag(): Promise<void> {
		// A strip long enough to scroll; G near its end, the dragged tab first (visible at scroll 0).
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11']);
		const scrollerOf = (leafId: string) =>
			browser.executeObsidian(({ app }, id) => {
				const leaf = app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement } | null;
				const el = leaf?.tabHeaderEl.parentElement;
				if (!el) throw new Error('no header row');
				return { scroll: el.scrollLeft, max: el.scrollWidth - el.clientWidth };
			}, leafId);
		const extra = [NOTES.n1, NOTES.n2, NOTES.n3, NOTES.n4, NOTES.n5, NOTES.n6, NOTES.n7, NOTES.n8, NOTES.n9, NOTES.n10, NOTES.n11];
		for (let round = 0; round < 3 && (await scrollerOf(ids.n1)).max < 400; round++) {
			await browser.executeObsidian(async ({ app, obsidian }, paths) => {
				for (const p of paths) {
					const file = app.vault.getFileByPath(p);
					if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
					await app.workspace.getLeaf('tab').openFile(file, { active: false });
				}
			}, extra);
			await browser.pause(300);
		}
		let s = await pageState();
		const all = mainStrip(s).leafIds;
		const max = (await scrollerOf(ids.n1)).max;
		// Precondition: the row really overflows (else this case tests nothing).
		expect(max).toBeGreaterThanOrEqual(400);
		const nTabs = all.length;
		const [m0, m1, m2] = [all[nTabs - 4], all[nTabs - 3], all[nTabs - 2]] as [string, string, string];
		const g = await makeGroup([m0, m1, m2], 'Far', 'pink');
		await setActive(ids.n1);
		// Scroll test input (what a wheel or Chromium's drag autoscroll does to the row).
		const scrollTo = async (x: number): Promise<number> => {
			const got = await browser.executeObsidian(async ({ app }, id, left) => {
				const leaf = app.workspace.getLeafById(id) as unknown as { tabHeaderEl: HTMLElement } | null;
				const el = leaf?.tabHeaderEl.parentElement;
				if (!el) throw new Error('no header row');
				el.scrollLeft = left;
				// The scroll event goes out with the next frame.
				await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
				return el.scrollLeft;
			}, ids.n1, x);
			return got;
		};
		const headerAt = (p: { x: number; y: number }) =>
			browser.execute((x, y) => document.elementFromPoint(x, y)?.closest('.workspace-tab-header')?.getAttribute('data-e2e-leaf') ?? null, p.x, p.y);
		let n = (await drops()).length;
		// The drag starts first: on 1.13.4 and 1.14.4 the row's scroll range during a tab drag is about
		// half the one before it (matrix run, review round 3), so P and the far end are found during
		// the drag. The plugin measures a strip at the first dragover only, so this changes nothing
		// for it.
		expect(await scrollTo(0)).toBe(0);
		await startDrag(ids.n1);
		const maxDuring = (await scrollerOf(ids.n1)).max;
		// The pointer P: on the right half of G's middle member when the row is scrolled to the end.
		const far = await scrollTo(maxDuring);
		expect(far).toBeGreaterThanOrEqual(400);
		await browser.pause(150);
		const p = await pointFor({ tab: m1, side: 'after' });
		expect(await headerAt(p)).toBe(m1);
		// Scrolled back to the start, P is over some other tab, outside G.
		expect(await scrollTo(0)).toBe(0);
		await browser.pause(150);
		const before = await headerAt(p);
		s = await pageState();
		expect(before).not.toBeNull();
		expect(groupOf(s, before ?? '')).toBeNull();
		await dragOver(p, true);
		await browser.pause(80);
		await dragOver(p);
		await browser.pause(80);
		// Measured at scroll 0: the pointer is over a tab outside G, nothing to highlight.
		const atStart = await highlight();
		expect(atStart).toEqual({ headers: [], chips: [], group: null });
		// The row scrolls during the drag.
		expect(await scrollTo(far)).toBe(far);
		await dragOver(p);
		await browser.pause(80);
		await dragOver(p);
		await browser.pause(80);
		const afterScroll = await highlight();
		expect(await headerAt(p)).toBe(m1);
		expect(afterScroll).toEqual({ headers: [m0, m1, m2], chips: [g], group: g });
		await dropAt(p);
		s = await afterDrop(++n);
		s = await waitForState((x) => groupOf(x, ids.n1) === g, 'n1 joined G');
		expect(s.stats.drops[n - 1]?.target.spot).toEqual({ kind: 'tab', leafId: m1, side: 'after' });
		expect(s.stats.drops[n - 1]?.fate).toBe('used');
		expect(membersInOrder(s, g)).toEqual([m0, m1, ids.n1, m2]);
		expectSane(s);
		record('D19', { tabs: nTabs, max, maxDuring, far, before, atStart, afterScroll, drop: s.stats.drops[n - 1] });
		await expectNoErrors();
	}

	it('D20 review close-out: background tabs (not the active one) dragged into a group, in place onto a chip, onto a collapsed chip, and cancelled: the active tab stays; the shown tab stays where Obsidian moves nothing', async function () {
		// In Obsidian a tab is made active on click, not on press, and its tab drag does not make the
		// dragged tab active: a user can drag a background tab while another tab stays active. Only the
		// first drop below is moved by Obsidian; its drop shows the moved tab in the target strip without
		// making it active (its own behaviour, the same without the plugin). The other drops are not
		// moved by Obsidian; the plugin applies rules 2 and 4 itself (dropInPlace, moveLeaf), and must
		// keep both the active tab and the shown tab.
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
		const g = await makeGroup([ids.n2, ids.n3, ids.n4], 'Back 后台', 'purple');
		const h = await makeGroup([ids.n6, ids.n7], 'Shut', 'grey');
		await setCollapsedVia(h, true);
		await setActive(ids.n8);
		let n = (await drops()).length;
		const steps: Record<string, unknown> = {};
		const activeIs = (s: PageState, id: string) => {
			expect({ active: s.activeId, shown: mainStrip(s).currentId }).toEqual({ active: id, shown: id });
		};
		let s = await pageState();
		activeIs(s, ids.n8);
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n4, ids.n5, ids.n6, ids.n7, ids.n8]);

		// (a) n5 (background) into the middle of G (right half of n3): Obsidian moves it and selects it.
		let during: unknown = null;
		await dragTo(ids.n5, { tab: ids.n3, side: 'after' }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		await afterDrop(++n);
		s = await waitForState((x) => groupOf(x, ids.n5) === g, 'background n5 joined G');
		expect(during).toEqual({ headers: [ids.n2, ids.n3, ids.n4], chips: [g], group: g });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n5, ids.n4, ids.n6, ids.n7, ids.n8]);
		expect(s.stats.drops[n - 1]?.fate).toBe('used');
		expect(s.stats.drops[n - 1]?.target.spot).toEqual({ kind: 'tab', leafId: ids.n3, side: 'after' });
		steps['a-middle'] = { during, order: mainStrip(s).leafIds, active: s.activeId, current: mainStrip(s).currentId, drop: s.stats.drops[n - 1] };
		// Obsidian's drop shows the moved tab in its strip but does not make it active: the active leaf
		// stays n8 (checked over 1 s in a diagnostic run: unchanged). The plugin adds nothing to this.
		expect(s.activeId).toBe(ids.n8);
		expect(mainStrip(s).currentId).toBe(ids.n5);
		expect(collapsed(s, h)).toBe(true);
		expectSane(s);
		expectDecorated(s, g);
		expect(await highlight()).toEqual({ headers: [], chips: [], group: null });
		// n8 is still the active leaf, so setActiveLeaf would change nothing: show it again with the
		// public revealLeaf before the next drags.
		await browser.executeObsidian(async ({ app }, id) => {
			const leaf = app.workspace.getLeafById(id);
			if (!leaf) throw new Error(`no leaf ${id}`);
			await app.workspace.revealLeaf(leaf);
		}, ids.n8);
		s = await waitForState((x) => mainStrip(x).currentId === ids.n8, 'n8 shown again');
		activeIs(s, ids.n8);

		// (b) n1 (background, right before G) released on G's chip: Obsidian moves nothing; the plugin
		// adds it in place (rule 2). The chip moves to n1; the active tab stays n8.
		during = null;
		await dragTo(ids.n1, { chip: g }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		await afterDrop(++n);
		s = await waitForState((x) => groupOf(x, ids.n1) === g, 'background n1 joined G in place');
		expect(during).toEqual({ headers: [ids.n2, ids.n3, ids.n5, ids.n4], chips: [g], group: g });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n5, ids.n4, ids.n6, ids.n7, ids.n8]);
		expect(s.stats.drops[n - 1]?.fate).toBe('noop');
		expect(s.stats.drops[n - 1]?.inPlace).toBe(true);
		expect(s.chips.find((c) => c.groupId === g)?.hostLeafId).toBe(ids.n1);
		steps['b-chip-in-place'] = { during, order: mainStrip(s).leafIds, active: s.activeId, current: mainStrip(s).currentId, drop: s.stats.drops[n - 1] };
		activeIs(s, ids.n8);
		expectSane(s);
		expectDecorated(s, g);

		// (c) n4 (background, G's last member, right before the collapsed H) released on H's chip:
		// Obsidian moves nothing; the plugin puts it right after H, ungrouped (rule 4); H stays
		// collapsed; the active tab stays n8 (the plugin's move keeps the shown tab).
		during = null;
		await dragTo(ids.n4, { chip: h }, async () => {
			await browser.pause(80);
			during = await highlight();
		});
		await afterDrop(++n);
		s = await waitForState((x) => mainStrip(x).leafIds.indexOf(ids.n4) === 6, 'background n4 right after the collapsed group');
		expect(during).toEqual({ headers: [], chips: [], group: null });
		expect(mainStrip(s).leafIds).toEqual([ids.n1, ids.n2, ids.n3, ids.n5, ids.n6, ids.n7, ids.n4, ids.n8]);
		expect(s.stats.drops[n - 1]?.fate).toBe('noop');
		expect(s.stats.drops[n - 1]?.afterCollapsed).toBe(true);
		expect(groupOf(s, ids.n4)).toBeNull();
		expect(membersInOrder(s, g)).toEqual([ids.n1, ids.n2, ids.n3, ids.n5]);
		expect(collapsed(s, h)).toBe(true);
		steps['c-collapsed-chip'] = { during, order: mainStrip(s).leafIds, active: s.activeId, current: mainStrip(s).currentId, drop: s.stats.drops[n - 1] };
		activeIs(s, ids.n8);
		expectSane(s);
		expectDecorated(s, g);

		// (d) n3 (background member) dragged over another member, then cancelled: nothing moves, the
		// highlight goes, no drop is recorded, the active tab stays.
		const before = await pageState();
		await startDrag(ids.n3);
		const p = await pointFor({ tab: ids.n1, side: 'after' });
		await dragOver(p, true);
		await browser.pause(80);
		await dragOver(p);
		await browser.pause(80);
		const on = await highlight();
		await cancelDrag();
		s = await waitForState((x) => x.stats.dragEnds > before.stats.dragEnds, 'background drag ended');
		expect(on).toEqual({ headers: [ids.n1, ids.n2, ids.n3, ids.n5], chips: [g], group: g });
		expect(await highlight()).toEqual({ headers: [], chips: [], group: null });
		expect(mainStrip(s).leafIds).toEqual(mainStrip(before).leafIds);
		expect(s.stats.drops.length).toBe(before.stats.drops.length);
		expect(membersInOrder(s, g)).toEqual(membersInOrder(before, g));
		steps['d-cancel'] = { on, active: s.activeId, current: mainStrip(s).currentId };
		activeIs(s, ids.n8);
		expectSane(s);
		record('D20', steps);
		await expectNoErrors();
	});

	it('D11 highlight look: light and dark, default and Atom, and forced colours (screenshots)', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const named = await makeGroup([ids.n1, ids.n2], 'Research 研究', 'blue');
		const dot = await makeGroup([ids.n4, ids.n5], '', 'green');
		await setActive(ids.n6);
		const looks: { theme: 'default' | 'Atom'; dark: boolean; forced?: boolean }[] = [
			{ theme: 'default', dark: false },
			{ theme: 'default', dark: true },
			{ theme: 'Atom', dark: false },
			{ theme: 'Atom', dark: true },
			{ theme: 'default', dark: false, forced: true },
		];
		const results: unknown[] = [];
		try {
			for (const look of looks) {
				await setLook(look.theme, look.dark);
				if (look.forced === true) await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
				await pageState();
				for (const [gid, over] of [
					[named, ids.n2],
					[dot, ids.n4],
				] as const) {
					await startDrag(ids.n6);
					const p = await pointFor({ tab: over, side: 'after' });
					await dragOver(p, true);
					await browser.pause(80);
					await dragOver(p);
					await browser.pause(150);
					const hl = await highlight();
					const facts = await browser.execute((g) => {
						const line = document.querySelector<HTMLElement>(`.workspace-tab-header.tabstrip-drop-join[data-tabstrip-group="${g}"] > .tabstrip-line`);
						const plain = document.querySelector<HTMLElement>('.workspace-tab-header.tabstrip-member:not(.tabstrip-drop-join) > .tabstrip-line');
						const chip = document.querySelector<HTMLElement>(`.tabstrip-chip[data-tabstrip-group="${g}"]`);
						const dotEl = chip?.querySelector<HTMLElement>('.tabstrip-chip-dot');
						const cs = chip ? getComputedStyle(chip) : null;
						// The system colours as this page resolves them (a test-only probe, removed at once).
						const probe = document.createElement('div');
						document.body.appendChild(probe);
						const sys: Record<string, string> = {};
						for (const name of ['Highlight', 'Canvas', 'CanvasText']) {
							probe.style.setProperty('forced-color-adjust', 'none');
							probe.style.setProperty('color', name);
							sys[name] = getComputedStyle(probe).color;
						}
						probe.remove();
						return {
							line: line ? { height: line.getBoundingClientRect().height, color: getComputedStyle(line).backgroundColor } : null,
							plainLine: plain ? plain.getBoundingClientRect().height : null,
							chip: cs ? { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor, fill: cs.backgroundColor, ink: cs.color } : null,
							dotShadow: dotEl ? getComputedStyle(dotEl).boxShadow : null,
							dotFill: dotEl ? getComputedStyle(dotEl).backgroundColor : null,
							forced: matchMedia('(forced-colors: active)').matches,
							sys,
						};
					}, gid);
					const name = `d11-${look.forced === true ? 'forced-colors' : `${look.theme.toLowerCase()}-${look.dark ? 'dark' : 'light'}`}-${gid === named ? 'named' : 'dot'}`;
					const file = await l7shot(name);
					await cancelDrag();
					await browser.pause(150);
					results.push({ look, gid, hl, facts, file });
					expect(hl.group).toBe(gid);
					expect(facts.line?.height).toBe(4);
					expect(facts.plainLine).toBe(2);
					expect(facts.forced).toBe(look.forced === true);
					if (gid === named) {
						expect(facts.chip?.outlineStyle).toBe('solid');
						expect(facts.chip?.outlineWidth).toBe('2px');
						if (look.forced !== true) expect(facts.chip?.outlineColor).toBe(facts.chip?.fill);
					} else if (look.forced !== true) {
						expect(facts.dotShadow).toContain(facts.dotFill ?? '?');
					} else {
						expect(facts.chip?.outlineWidth).toBe('2px');
					}
					if (look.forced === true) {
						// Only system colours (review close-out): the ring and the line in Highlight; a named
						// chip keeps the Canvas fill and CanvasText ink it has when not highlighted; the dot
						// stays CanvasText with no ring in the group colour.
						expect(facts.chip?.outlineColor).toBe(facts.sys['Highlight']);
						expect(facts.line?.color).toBe(facts.sys['Highlight']);
						if (gid === named) {
							expect(facts.chip?.fill).toBe(facts.sys['Canvas']);
							expect(facts.chip?.ink).toBe(facts.sys['CanvasText']);
						} else {
							expect(facts.dotFill).toBe(facts.sys['CanvasText']);
							expect(facts.dotShadow).toBe('none');
						}
					}
					expect(await highlight()).toEqual({ headers: [], chips: [], group: null });
				}
				if (look.forced === true) await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [] });
			}
		} finally {
			await browser.sendCommandAndGetResult('Emulation.setEmulatedMedia', { features: [] });
			await setLook('default', false);
		}
		record('D11', results);
		await expectNoErrors();
	});

	it('D12 performance: dragover handling and the highlight frame stay under 1 ms (median); no deferred tab is loaded by the plugin', async function () {
		// 20 tabs after loading a saved layout: Obsidian keeps background tabs deferred (not loaded).
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10']);
		await browser.executeObsidian(async ({ app, obsidian }, paths) => {
			for (const p of paths) {
				const file = app.vault.getFileByPath(p);
				if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${p}`);
				await app.workspace.getLeaf('tab').openFile(file, { active: false });
			}
		}, [NOTES.n1, NOTES.n2, NOTES.n3, NOTES.n4, NOTES.n5, NOTES.n6, NOTES.n7, NOTES.n8, NOTES.n9, NOTES.n10]);
		let s = await waitForState((x) => mainStrip(x).leafIds.length === 20, '20 tabs');
		const all = mainStrip(s).leafIds;
		for (let i = 0; i < 4; i++) await makeGroup(all.slice(i * 5 + 1, i * 5 + 4), `P${String(i)}`);
		await setCollapsedVia((await pageState()).state.groups[1]?.id ?? '', true);
		await browser.executeObsidian(async ({ app }) => {
			const layout = app.workspace.getLayout();
			await app.workspace.changeLayout(layout);
		});
		s = await waitForState((x) => mainStrip(x).leafIds.length === 20, 'layout loaded again');
		const deferred = () =>
			browser.executeObsidian(({ app }) => {
				const out: string[] = [];
				app.workspace.iterateRootLeaves((l) => {
					if ((l as unknown as { isDeferred?: boolean }).isDeferred === true) out.push((l as unknown as { id: string }).id);
				});
				return out;
			});
		const deferredBefore = await deferred();
		const strip = mainStrip(s);
		const dragged = strip.currentId ?? strip.leafIds[0] ?? '';
		await browser.executeObsidian(({ app }) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { dragTimings(): { eventMs: number[]; frameMs: number[] } } } | undefined> } }).plugins.plugins['tabstrip'];
			const t = p?.debug.dragTimings();
			if (t) {
				t.eventMs.length = 0;
				t.frameMs.length = 0;
			}
		});
		await startDrag(dragged);
		const visible = strip.leafIds.filter((id) => {
			const g = groupOf(s, id);
			return g === null || collapsed(s, g) !== true;
		});
		let first = true;
		for (const id of visible) {
			for (const side of ['before', 'after'] as const) {
				const p = await pointFor({ tab: id, side });
				for (let k = 0; k < 3; k++) {
					await dragOver({ x: p.x + k, y: p.y }, first);
					first = false;
				}
			}
		}
		await browser.pause(100);
		await cancelDrag();
		await browser.pause(200);
		const timings = await browser.executeObsidian(({ app }) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { debug: { dragTimings(): { eventMs: number[]; frameMs: number[] } } } | undefined> } }).plugins.plugins['tabstrip'];
			return p?.debug.dragTimings() ?? { eventMs: [], frameMs: [] };
		});
		const deferredAfter = await deferred();
		const median = (xs: number[]) => {
			const v = [...xs].sort((a, b) => a - b);
			return v.length === 0 ? NaN : (v[Math.floor(v.length / 2)] ?? NaN);
		};
		const p95 = (xs: number[]) => {
			const v = [...xs].sort((a, b) => a - b);
			return v[Math.floor(v.length * 0.95)] ?? NaN;
		};
		const result = {
			events: timings.eventMs.length,
			eventMedian: median(timings.eventMs),
			eventP95: p95(timings.eventMs),
			frames: timings.frameMs.length,
			frameMedian: median(timings.frameMs),
			frameP95: p95(timings.frameMs),
			frameMax: Math.max(...timings.frameMs),
			deferredBefore: deferredBefore.length,
			deferredAfter: deferredAfter.length,
			loaded: deferredBefore.filter((id) => !deferredAfter.includes(id)),
			dragged,
		};
		record('D12', result);
		expect(result.events).toBeGreaterThan(100);
		expect(result.frames).toBeGreaterThan(10);
		expect(result.eventMedian).toBeLessThanOrEqual(1);
		expect(result.frameMedian).toBeLessThanOrEqual(1);
		expect(result.deferredBefore).toBeGreaterThan(5);
		// Only the dragged tab may load (Obsidian loads it when its drag starts).
		expect(result.loaded.filter((id) => id !== dragged)).toEqual([]);
		void ids;
		await expectNoErrors();
	});

	it('D13 S5 recordings: event and layout sequences of drags, splits, pop-outs, new window, duplicate, open-after-current and loading a layout become reconcile fixtures', async function () {
		await installEventLog();
		const fixtures: Fixture[] = [];
		const capture = async (name: string, what: string, act: () => Promise<void>) => {
			await clearEventLog();
			await traceOn(true);
			await act();
			await browser.pause(400);
			const passes = await traceOn(false);
			const events = await clearEventLog();
			fixtures.push({ name, what, obsidian: browser.getObsidianVersion(), events, passes: passes.filter((p) => JSON.stringify(p.prev) !== JSON.stringify(p.next) || p.ops.length > 0 || p.ctx.dropIntent !== undefined) });
		};
		let ids: Record<string, string> = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
		const at = (role: string): string => ids[role] ?? '';
		let g = await makeGroup([at('n2'), at('n3'), at('n4')], 'S5', 'blue');
		await setActive(at('n6'));
		await capture('drag-into-middle', 'n6 dropped on the right half of n3 (G = n2 n3 n4)', () => dragTo(at('n6'), { tab: at('n3'), side: 'after' }));
		// Now n1 n2 n3 n6 n4 n5 (G = n2 n3 n6 n4).
		await setActive(at('n5'));
		await capture('drag-start-boundary-chip', 'n5 dropped on the chip of G', () => dragTo(at('n5'), { chip: g }));
		// Now n1 n5 n2 n3 n6 n4 (G = n5 n2 n3 n6 n4).
		await setActive(at('n1'));
		await capture('drag-end-boundary-member', 'n1 dropped on the right half of the last member n4', () => dragTo(at('n1'), { tab: at('n4'), side: 'after' }));
		// Now n5 n2 n3 n6 n4 n1, all in G.
		await setActive(at('n5'));
		await capture('drag-end-boundary-outside', 'n5 (first member) dropped past the strip end', () => dragTo(at('n5'), { endOf: at('n5') }));
		// Now n2 n3 n6 n4 n1 n5: n5 left G (the pointer was past the last tab).
		await setActive(at('n2'));
		await capture('drag-out', 'n2 dragged from the middle of G to the strip end', () => dragTo(at('n2'), { endOf: at('n2') }));

		// Another split.
		ids = await freshNotes(['n1', 'n2', 'n3']);
		g = await makeGroup([at('n1'), at('n2')], 'Split', 'green');
		const splitLeaf = await browser.executeObsidian(async ({ app, obsidian }, p) => {
			const leaf = app.workspace.getLeaf('split', 'vertical');
			const file = app.vault.getFileByPath(p);
			if (!(file instanceof obsidian.TFile)) throw new Error('missing');
			await leaf.openFile(file);
			return (leaf as unknown as { id: string }).id;
		}, NOTES.n8);
		await waitForState((x) => x.strips.length === 2, 'split');
		await setActive(at('n2'));
		await capture('drag-to-split', 'member n2 dropped after the only tab of another split', () => dragTo(at('n2'), { tab: splitLeaf, side: 'after' }));

		// A pop-out window.
		ids = await freshNotes(['n1', 'n2', 'n3']);
		g = await makeGroup([at('n1'), at('n2')], 'Pop', 'purple');
		const { result: pop } = await withWarmPopout(() => openPopoutLeafWithNotes([NOTES.n9]));
		await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 1), 'pop-out ready');
		const popId = pop[0] ?? '';
		const main = await browser.getWindowHandle();
		const popHandle = await windowHandleWith(headerSel(popId));
		if (popHandle === null) throw new Error('no pop-out handle');
		await browser.switchToWindow(popHandle);
		await enableDrags();
		await installEventLog();
		await browser.switchToWindow(main);
		await setActive(at('n2'));
		await capture('drag-to-popout', 'member n2 dropped after the pop-out tab', async () => {
			await startDrag(at('n2'));
			await browser.switchToWindow(popHandle);
			const p = await pointFor({ tab: popId, side: 'after' });
			await dragOver(p, true);
			await browser.pause(80);
			await dropAt(p);
			await browser.pause(300);
			await browser.switchToWindow(main);
			await cancelDrag();
		});
		await setActive(at('n1'));
		await capture('move-to-new-window', 'command "Move current tab to new window" on member n1', async () => {
			await runCommand(CMD.moveToWindow);
			await waitForState((x) => x.strips.some((st) => st.kind === 'popout' && st.leafIds.length === 1 && st.leafIds[0] === at('n1')), 'n1 in its own window');
		});
		await browser.executeObsidian(({ app }, list) => {
			for (const id of list) app.workspace.getLeafById(id)?.getContainer().win.close();
		}, [popId, at('n1')]);
		await waitForState((x) => x.strips.every((st) => st.kind === 'main'), 'pop-outs closed');

		// Duplicate a middle member; open a new tab right after a middle member (Open Tab Settings'
		// "after current", simulated with the public createLeafInParent).
		ids = await freshNotes(['n1', 'n2', 'n3', 'n4']);
		g = await makeGroup([at('n1'), at('n2'), at('n3')], 'Dup', 'orange');
		await setActive(at('n2'));
		await capture('duplicate-tab', 'workspace.duplicateLeaf(n2, "tab") on a middle member', async () => {
			await browser.executeObsidian(async ({ app }, id) => {
				const leaf = app.workspace.getLeafById(id);
				if (leaf) await app.workspace.duplicateLeaf(leaf, 'tab');
			}, at('n2'));
		});
		await setActive(at('n2'));
		await capture('open-after-current', 'new tab at the index right after the middle member n2, then a file opened in it', async () => {
			await browser.executeObsidian(
				async ({ app, obsidian }, id, p) => {
					const leaf = app.workspace.getLeafById(id) as unknown as { parent: { children: unknown[] } };
					const tabs = leaf.parent;
					const created = app.workspace.createLeafInParent(tabs as unknown as import('obsidian').WorkspaceSplit, tabs.children.indexOf(leaf) + 1);
					const file = app.vault.getFileByPath(p);
					if (!(file instanceof obsidian.TFile)) throw new Error('missing');
					await created.openFile(file);
					app.workspace.setActiveLeaf(created, { focus: true });
				},
				at('n2'),
				NOTES.n7,
			);
		});
		// Loading a layout: the same tabs, as Obsidian's "Workspaces" core plugin does (changeLayout).
		const layout = await browser.executeObsidian(({ app }) => app.workspace.getLayout());
		await capture('load-layout', 'workspace.changeLayout(saved layout of the same tabs)', async () => {
			await browser.executeObsidian(async ({ app }, l) => {
				await app.workspace.changeLayout(l);
			}, layout);
			await browser.pause(300);
		});
		const s = await pageState();
		expectSane(s);

		const version = browser.getObsidianVersion();
		const toRepo = version === '1.15.0' && process.env.TABSTRIP_WRITE_FIXTURES === '1';
		const dir = toRepo ? path.join(repoRoot, 'test', 'unit', 'core', 'fixtures', 's5') : path.join(repoRoot, '.e2e-state', 'l7-s5', version);
		fs.mkdirSync(dir, { recursive: true });
		for (const f of fixtures) fs.writeFileSync(path.join(dir, `${f.name}.json`), JSON.stringify(f, null, '\t') + '\n');
		record('D13', fixtures.map((f) => ({ name: f.name, events: f.events.map((e) => e.type), passes: f.passes.length, intents: f.passes.map((p) => p.ctx.dropIntent ?? null) })));
		for (const f of fixtures) expect({ name: f.name, passes: f.passes.length > 0 }).toEqual({ name: f.name, passes: true });
		void g;
		await expectNoErrors();
	});

	it('D14 random 50 steps (native drags, close, undo close, go to tab N, open into a collapsed group, move to a pop-out): groups contiguous, active tab visible, no errors after every step', async function () {
		const seed = Number(process.env['TABSTRIP_L7_SEED'] ?? 20261110);
		let x = seed >>> 0;
		const rand = () => {
			// mulberry32
			x = (x + 0x6d2b79f5) >>> 0;
			let t = x;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const pick = <T>(xs: readonly T[]): T => {
			const v = xs[Math.floor(rand() * xs.length)];
			if (v === undefined) throw new Error('pick from empty');
			return v;
		};
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
		await makeGroup([ids.n2, ids.n3, ids.n4], 'A', 'blue');
		await makeGroup([ids.n6, ids.n7], 'B', 'red');
		await setActive(ids.n9);
		const log: string[] = [];
		const counts: Record<string, number> = {};
		let popouts = 0;
		const hidden = (s: PageState, id: string) => {
			const g = groupOf(s, id);
			return g !== null && collapsed(s, g) === true;
		};
		for (let step = 0; step < 50; step++) {
			const s = await pageState();
			const strip = mainStrip(s);
			const visible = strip.leafIds.filter((id) => !hidden(s, id) && !strip.pinned[strip.leafIds.indexOf(id)]);
			const roll = rand();
			let kind: string;
			if (roll < 0.4 && visible.length >= 2) kind = 'drag';
			else if (roll < 0.5 && strip.leafIds.length > 4) kind = 'close';
			else if (roll < 0.58) kind = 'undo-close';
			else if (roll < 0.66) kind = 'goto';
			else if (roll < 0.74 && s.state.groups.some((g) => g.collapsed)) kind = 'open-into-collapsed';
			else if (roll < 0.86 && s.state.groups.length > 0) kind = 'toggle';
			else if (roll < 0.94 && visible.length >= 2) kind = 'group';
			else if (popouts < 2 && visible.length >= 3) kind = 'to-popout';
			else kind = 'goto';
			counts[kind] = (counts[kind] ?? 0) + 1;
			let detail = '';
			switch (kind) {
				case 'drag': {
					const dragged = pick(visible);
					const targets: SpotSpec[] = [];
					for (const id of strip.leafIds) if (!hidden(s, id)) targets.push({ tab: id, side: 'before' }, { tab: id, side: 'after' });
					for (const c of s.chips) if (strip.leafIds.includes(c.hostLeafId ?? '')) targets.push({ chip: c.groupId ?? '' });
					targets.push({ endOf: dragged });
					const spot = pick(targets);
					// Every other drag takes a background tab (review close-out): the tab is dragged while
					// another tab stays active, as a user does; the others make it active first. A fixed
					// alternation, not rand(), so the seeded choices stay the same.
					const background = (counts['drag'] ?? 0) % 2 === 0 && s.activeId !== null && dragged !== s.activeId;
					detail = `${dragged} -> ${JSON.stringify(spot)}${background ? ' (background)' : ''}`;
					if (background) counts['background-drag'] = (counts['background-drag'] ?? 0) + 1;
					else await setActive(dragged);
					await dragTo(dragged, spot);
					await browser.pause(150);
					break;
				}
				case 'close': {
					const id = pick(visible.length > 0 ? visible : strip.leafIds);
					detail = id;
					await browser.executeObsidian(({ app }, leafId) => {
						app.workspace.getLeafById(leafId)?.detach();
					}, id);
					await browser.pause(350);
					break;
				}
				case 'undo-close':
					await runCommand(CMD.undo);
					await browser.pause(300);
					break;
				case 'goto': {
					const nth = 1 + Math.floor(rand() * Math.min(8, strip.leafIds.length));
					detail = String(nth);
					await runCommand(`workspace:goto-tab-${String(nth)}`);
					break;
				}
				case 'open-into-collapsed': {
					// Like Open Tab Settings' "open in a tab next to …" landing inside a collapsed group.
					const g = pick(s.state.groups.filter((gg) => gg.collapsed));
					const members = membersInOrder(s, g.id);
					const inside = strip.leafIds.indexOf(members[0] ?? '') + 1;
					detail = `${g.id} at ${String(inside)}`;
					await browser.executeObsidian(
						async ({ app, obsidian }, anchor, index, p) => {
							const leaf = app.workspace.getLeafById(anchor) as unknown as { parent: unknown };
							const created = app.workspace.createLeafInParent(leaf.parent as import('obsidian').WorkspaceSplit, index);
							const file = app.vault.getFileByPath(p);
							if (file instanceof obsidian.TFile) await created.openFile(file);
							app.workspace.setActiveLeaf(created, { focus: true });
						},
						members[0] ?? '',
						inside,
						NOTES.n11,
					);
					break;
				}
				case 'toggle': {
					const g = pick(s.state.groups);
					const inMain = membersInOrder(s, g.id).some((id) => strip.leafIds.includes(id));
					detail = g.id;
					if (inMain) await setCollapsedVia(g.id, !g.collapsed);
					break;
				}
				case 'group': {
					const start = Math.floor(rand() * (visible.length - 1));
					const run = visible.slice(start, start + 2);
					detail = run.join(',');
					try {
						await makeGroup(run, `R${String(step)}`);
					} catch {
						detail += ' (refused)';
					}
					break;
				}
				case 'to-popout': {
					const id = pick(visible);
					detail = id;
					popouts++;
					await withWarmPopout(async () => {
						await setActive(id);
						await runCommand(CMD.moveToWindow);
						await waitForState((y) => y.strips.some((st) => st.kind === 'popout' && st.leafIds.includes(id)), 'moved to a pop-out');
					});
					break;
				}
			}
			log.push(`${String(step)} ${kind} ${detail}`);
			const after = await waitForState(() => true, 'settled');
			try {
				expectSane(after);
				expect(after.stats.loopStops).toBe(0);
				await expectNoErrors();
			} catch (e) {
				record('D14-failed', { seed, log, state: after.state, strips: after.strips });
				throw e;
			}
		}
		record('D14', { seed, counts, log });
		expect(counts['drag'] ?? 0).toBeGreaterThanOrEqual(10);
		expect(counts['background-drag'] ?? 0).toBeGreaterThanOrEqual(4);
		// Close the pop-outs it made.
		const s = await pageState();
		const popLeaves = s.strips.filter((st) => st.kind === 'popout').map((st) => st.leafIds[0] ?? '');
		await browser.executeObsidian(({ app }, list) => {
			for (const id of list) app.workspace.getLeafById(id)?.getContainer().win.close();
		}, popLeaves);
		await waitForState((y) => y.strips.every((st) => st.kind === 'main'), 'pop-outs closed');
		await expectNoErrors();
	});

	it('D15 membership changed by drags is saved and survives a real restart', async function () {
		const ids = await freshNotes(['n1', 'n2', 'n3', 'n4', 'n5']);
		const g = await makeGroup([ids.n1, ids.n2], 'Keep 保留', 'green');
		let n = (await drops()).length;
		await setActive(ids.n4);
		await dragTo(ids.n4, { tab: ids.n2, side: 'after' });
		await afterDrop(++n);
		await setActive(ids.n1);
		await dragTo(ids.n1, { endOf: ids.n1 });
		let s = await afterDrop(++n);
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n4]);
		const orderBefore = mainStrip(s).leafIds;
		// The plugin saves by itself (debounced).
		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ app }, gid, want) => {
					const v = app.loadLocalStorage('tabstrip-session-v1') as { groups?: { groupId: string; members: { leafId: string }[] }[] } | null;
					const group = v?.groups?.find((x) => x.groupId === gid);
					return JSON.stringify(group?.members.map((m) => m.leafId)) === JSON.stringify(want);
				}, g, [ids.n2, ids.n4]),
			{ timeout: 4000, timeoutMsg: 'drag result saved' },
		);
		await browser.executeObsidian(async ({ app }) => {
			await app.workspace.requestSaveLayout.run();
		});
		await browser.reloadObsidian({ plugins: ['tabstrip', 'e2e-startup-log-probe'] });
		await startErrorWatch();
		await enableDrags();
		s = await waitForState((x) => x.stats.restore !== null && x.state.groups.length >= 1, 'restored', 15000);
		expect(mainStrip(s).leafIds).toEqual(orderBefore);
		expect(membersInOrder(s, g)).toEqual([ids.n2, ids.n4]);
		expect(groupOf(s, ids.n1)).toBeNull();
		expect(s.state.groups.find((x) => x.id === g)?.name).toBe('Keep 保留');
		// Drags still work after the restart.
		await setActive(ids.n5);
		const before = s.stats.drops.length;
		await dragTo(ids.n5, { chip: g });
		s = await afterDrop(before + 1);
		expect(membersInOrder(s, g)).toEqual([ids.n5, ids.n2, ids.n4]);
		record('D15', { order: mainStrip(s).leafIds, restore: s.stats.restore?.report });
		await expectNoErrors();
	});
});
