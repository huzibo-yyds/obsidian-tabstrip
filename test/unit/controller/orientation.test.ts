/**
 * Step V1: the orientation is stored per device in the session record, also when no group exists
 * (an empty session is otherwise never written), and read back on restore. The strip itself is
 * replaced by a stub: no page in unit tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Features } from '../../../src/adapter/capabilities';
import type { WorkspaceAdapter } from '../../../src/adapter/workspace';
import type { Snapshot } from '../../../src/core/types';
import { translator } from '../../../src/i18n';
import type { SessionStorage } from '../../../src/storage';

const notices: string[] = [];
vi.mock('obsidian', () => ({
	Menu: class {},
	Notice: class {
		constructor(text: string) {
			notices.push(text);
		}
	},
	setIcon: () => undefined,
}));
vi.stubGlobal('window', globalThis);

const { TabstripController: Controller } = await import('../../../src/controller');

interface Internals {
	running: boolean;
	features: Features | null;
	restored: boolean;
	vstrip: { mounted: boolean; element: null; draggedLeaf: string | null; mount(): void; unmount(): void; setLook(look: unknown): void; groupRow(): null; render(plan: { rows: unknown[] }, headerOf: unknown): void; noteUpdate(ms: number): void };
	restore(): void;
	saveNow(): void;
	flush(): void;
	render(): void;
	setOrientation(o: 'horizontal' | 'vertical'): void;
	toggleOrientation(): void;
	afterDrag(): void;
	preMount(o: 'horizontal' | 'vertical', colors?: { groups: { id: string; color: string }[]; members: { leafId: string; groupId: string }[] }): void;
	readonly orientationMode: string;
	readonly canToggleOrientation: boolean;
	setNativeMode(on: boolean): void;
	start(): void;
	toggleStripCollapsed(): void;
	readonly stripCollapsed: boolean;
	readonly canToggleStrip: boolean;
}

const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [{ id: 'a', pinned: false, fingerprint: { viewType: 'markdown', path: 'a.md' } }], currentLeafId: 'a' }], activeLeafId: 'a' };

function setup(initial: unknown, features: Partial<Features> = { groups: true, decorate: true }) {
	let value = initial;
	const writes: unknown[] = [];
	const storage: SessionStorage = {
		load: () => value,
		save: (v) => {
			writes.push(JSON.parse(JSON.stringify(v)));
			value = JSON.parse(JSON.stringify(v)) as unknown;
		},
		clear: () => {
			value = null;
		},
	};
	const signals = { views: 0, bodyClasses: [] as string[] };
	const root = { shown: true, headers: true, missing: false };
	const strips = [{ paneId: 'p0', kind: 'main', leaves: [{ id: 'a', header: null, info: { pinned: false } }, { id: 'b', header: null, info: { pinned: false } }], currentLeafId: 'a' }];
	const adapter = {
		read: () => ({ snapshot, strips }),
		workspaceEl: () => ({}),
		verticalTabsSignals: () => signals,
		probe: () => ({ headers: root.headers }),
		rootShown: () => root.shown,
		rootState: () => (root.shown ? 'shown' : root.missing ? 'missing' : 'loading'),
		recentRootLeafId: () => null,
		rootSplitElements: () => [],
	} as unknown as WorkspaceAdapter;
	const c = new Controller(adapter, translator('en'), () => features as Features, storage) as unknown as Internals;
	let mounted = false;
	const drag = { leaf: null as string | null };
	const renders: { leafId: string; color: string | null }[][] = [];
	const looks: { collapsed: boolean; width: number }[] = [];
	const updates: number[] = [];
	c.vstrip = {
		get mounted() {
			return mounted;
		},
		element: null,
		get draggedLeaf() {
			return drag.leaf;
		},
		setLook: (look) => {
			looks.push(look as { collapsed: boolean; width: number });
		},
		groupRow: () => null,
		mount: () => {
			mounted = true;
		},
		unmount: () => {
			mounted = false;
		},
		render: (plan) => {
			renders.push((plan.rows as { leafId: string; color: string | null }[]).map((r) => ({ leafId: r.leafId, color: r.color })));
		},
		noteUpdate: (ms) => {
			updates.push(ms);
		},
	};
	c.flush = () => undefined;
	c.render = () => undefined;
	return { c, writes, signals, mounted: () => mounted, renders, root, looks, updates, adapter, drag };
}

describe('orientation (step V1)', () => {
	it('is stored when switched to vertical with no group at all, and removed again when switched back', () => {
		const { c, writes } = setup(null);
		c.running = true;
		c.features = { groups: true, decorate: true } as Features;
		c.restore();
		expect(c.orientationMode).toBe('horizontal');
		c.setOrientation('vertical');
		c.saveNow();
		expect(writes).toHaveLength(1);
		expect((writes[0] as { orientation?: string }).orientation).toBe('vertical');
		c.setOrientation('horizontal');
		c.saveNow();
		expect(writes).toHaveLength(2);
		expect('orientation' in (writes[1] as object)).toBe(false);
	});

	it('is read back on restore and mounts the strip; horizontal records never mount it', () => {
		const v = setup({ version: 1, orientation: 'vertical', nextGroupSeq: 1, groups: [], closed: [], unmatched: [] });
		v.c.start();
		expect(v.c.orientationMode).toBe('vertical');
		expect(v.mounted()).toBe(true);
		const h = setup({ version: 1, nextGroupSeq: 1, groups: [], closed: [], unmatched: [] });
		h.c.start();
		expect(h.mounted()).toBe(false);
	});

	it('preMount mounts before start; start takes it back when the tab headers are not available', () => {
		notices.length = 0;
		const s = setup({ version: 1, orientation: 'vertical', nextGroupSeq: 1, groups: [], closed: [], unmatched: [] }, { groups: true, decorate: false });
		s.c.preMount('vertical');
		expect(s.mounted()).toBe(true);
		s.c.start();
		expect(s.mounted()).toBe(false);
		expect(notices).toEqual([translator('en').t('notice.verticalUnavailable')]);
		expect(s.c.canToggleOrientation).toBe(false);
	});

	it('review round 2: preMount draws the rows at once, coloured from the stored session; none while the root split is out of the page', () => {
		const s = setup({ version: 1, orientation: 'vertical', nextGroupSeq: 1, groups: [], closed: [], unmatched: [] });
		s.c.preMount('vertical', { groups: [{ id: 'g1', color: 'red' }], members: [{ leafId: 'b', groupId: 'g1' }] });
		expect(s.mounted()).toBe(true);
		expect(s.renders).toEqual([
			[
				{ leafId: 'a', color: null },
				{ leafId: 'b', color: 'red' },
			],
		]);
		const n = setup(null);
		n.root.shown = false;
		n.c.preMount('vertical');
		expect(n.renders).toEqual([[]]);
		const h = setup(null);
		h.root.headers = false;
		h.c.preMount('vertical');
		expect(h.renders).toEqual([]);
		const off = setup(null);
		off.c.preMount('horizontal');
		expect(off.renders).toEqual([]);
	});

	it('"Restore native tab bar" unmounts, "Show tab groups again" mounts again', () => {
		const s = setup(null);
		s.c.start();
		s.c.setOrientation('vertical');
		expect(s.mounted()).toBe(true);
		s.c.setNativeMode(true);
		expect(s.mounted()).toBe(false);
		expect(s.c.canToggleOrientation).toBe(false);
		s.c.setNativeMode(false);
		expect(s.mounted()).toBe(true);
	});

	it('shows the Vertical Tabs overlap notice once per session, also in horizontal mode', () => {
		notices.length = 0;
		const s = setup(null);
		s.signals.bodyClasses = ['vt-scrollable-tabs'];
		s.c.start();
		expect(s.c.orientationMode).toBe('horizontal');
		expect(notices).toEqual([translator('en').t('notice.verticalTabsConflict')]);
		s.c.setOrientation('vertical');
		s.c.setOrientation('horizontal');
		s.c.setOrientation('vertical');
		expect(notices).toEqual([translator('en').t('notice.verticalTabsConflict')]);
	});

	it('the overlap notice also comes in vertical mode, and from the open Vertical Tabs view alone', () => {
		notices.length = 0;
		const s = setup({ version: 1, orientation: 'vertical', nextGroupSeq: 1, groups: [], closed: [], unmatched: [] });
		s.signals.views = 1;
		s.c.start();
		expect(s.c.orientationMode).toBe('vertical');
		expect(notices).toEqual([translator('en').t('notice.verticalTabsConflict')]);
	});

	it('the overlap notice comes once Vertical Tabs sets itself up after Tabstrip started (next pass)', () => {
		notices.length = 0;
		const s = setup(null);
		s.c.start();
		expect(notices).toEqual([]);
		s.signals.bodyClasses = ['vt-scrollable-tabs'];
		(s.c as unknown as { pass(t: string[]): void }).pass(['layout']);
		(s.c as unknown as { pass(t: string[]): void }).pass(['layout']);
		expect(notices).toEqual([translator('en').t('notice.verticalTabsConflict')]);
	});

	it('no overlap notice without Vertical Tabs, and none in native mode', () => {
		notices.length = 0;
		const s = setup(null);
		s.signals.bodyClasses = ['theme-dark', 'is-vt'];
		s.c.start();
		s.c.setOrientation('vertical');
		expect(notices).toEqual([]);
		s.c.setNativeMode(true);
		s.signals.bodyClasses = ['vt-scrollable-tabs'];
		(s.c as unknown as { pass(t: string[]): void }).pass(['layout']);
		expect(notices).toEqual([]);
		// Positive control: back from native mode, the notice comes.
		s.c.setNativeMode(false);
		expect(notices).toEqual([translator('en').t('notice.verticalTabsConflict')]);
	});

	it('the overlap notice says Tabstrip never disables the other plugin (EN and zh)', () => {
		expect(translator('en').t('notice.verticalTabsConflict')).toMatch(/horizontal and in vertical mode/);
		expect(translator('en').t('notice.verticalTabsConflict')).toMatch(/Tabstrip leaves it enabled/);
		expect(translator('zh').t('notice.verticalTabsConflict')).toMatch(/横排和竖排/);
		expect(translator('zh').t('notice.verticalTabsConflict')).toMatch(/Tabstrip 不会停用它/);
	});
	it('an explicit switch after "Clear data on this device" is stored again (review round 1)', () => {
		const { c, writes } = setup({ version: 1, orientation: 'vertical', nextGroupSeq: 1, groups: [], closed: [], unmatched: [] });
		c.start();
		expect(c.orientationMode).toBe('vertical');
		// As at runtime: the last pass's read is kept (render is a stub here).
		(c as unknown as { read: unknown }).read = { snapshot, strips: [] };
		(c as unknown as { clearData(): void }).clearData();
		c.setOrientation('horizontal');
		c.saveNow();
		// Nothing stored means horizontal: no write is needed.
		expect(writes).toHaveLength(0);
		c.setOrientation('vertical');
		c.saveNow();
		expect(writes).toHaveLength(1);
		expect((writes[0] as { orientation?: string }).orientation).toBe('vertical');
		// A restart reads the last explicit choice back.
		const again = setup(writes[0]);
		again.c.start();
		expect(again.c.orientationMode).toBe('vertical');
	});

	it('step V3: the icon bar state and the width are stored per device and read back; defaults are not written', () => {
		const { c, writes, looks } = setup({ version: 1, orientation: 'vertical', nextGroupSeq: 1, groups: [], closed: [], unmatched: [] });
		c.start();
		expect(c.canToggleStrip).toBe(true);
		expect(looks.at(-1)).toMatchObject({ collapsed: false, width: 240 });
		c.toggleStripCollapsed();
		expect(c.stripCollapsed).toBe(true);
		expect(looks.at(-1)).toMatchObject({ collapsed: true, width: 240 });
		c.saveNow();
		expect((writes.at(-1) as { vstrip?: unknown }).vstrip).toEqual({ collapsed: true });
		// The edge handle reports a width (hook of the strip).
		(c as unknown as { setStripPrefs(p: object): void }).setStripPrefs({ collapsed: true, width: 333 });
		c.saveNow();
		expect((writes.at(-1) as { vstrip?: unknown }).vstrip).toEqual({ collapsed: true, width: 333 });
		const again = setup(writes.at(-1));
		again.c.start();
		expect(again.c.stripCollapsed).toBe(true);
		expect(again.looks.at(-1)).toMatchObject({ collapsed: true, width: 333 });
		again.c.toggleStripCollapsed();
		(again.c as unknown as { setStripPrefs(p: object): void }).setStripPrefs({ width: 240 });
		again.c.saveNow();
		expect('vstrip' in (again.writes.at(-1) as object)).toBe(false);
	});

	it('step V3: the strip toggle command is only available while the strip is shown', () => {
		const s = setup(null);
		s.c.start();
		expect(s.c.canToggleStrip).toBe(false);
		s.c.setOrientation('vertical');
		expect(s.c.canToggleStrip).toBe(true);
		s.c.setNativeMode(true);
		expect(s.c.canToggleStrip).toBe(false);
	});

	it('review round 3: tabs in the page but no root split element found gives the native tab bar back', () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const s = setup(null);
		s.root.shown = false;
		s.root.missing = true;
		s.c.preMount('vertical');
		expect(s.mounted()).toBe(false);
		expect(s.renders).toEqual([]);
		expect(err).toHaveBeenCalledTimes(1);
		err.mockRestore();
	});

	it('review round 1 (V2-V4): the recent root tab is asked from Obsidian only when the focus is outside the root split and the last root tab is gone', () => {
		const s = setup(null);
		const recent = vi.fn(() => 'b');
		(s.adapter as unknown as { recentRootLeafId: () => string | null }).recentRootLeafId = recent;
		const pick = (active: string | null, roots: string[]) => (s.c as unknown as { recentRootLeaf(a: string | null, r: Map<string, unknown>): string | null }).recentRootLeaf(active, new Map(roots.map((id) => [id, null])));
		// A root tab is active: it is the most recent one, nothing is asked (getMostRecentLeaf forces a layout).
		expect(pick('a', ['a', 'b'])).toBe(null);
		expect(recent).not.toHaveBeenCalled();
		// The focus went to a sidebar: the root tab last seen active.
		expect(pick('side', ['a', 'b'])).toBe('a');
		expect(recent).not.toHaveBeenCalled();
		// That tab closed meanwhile: now Obsidian is asked, once, and the answer is kept.
		expect(pick('side', ['b'])).toBe('b');
		expect(pick('side', ['b'])).toBe('b');
		expect(recent).toHaveBeenCalledTimes(1);
	});

	it('review round 3: every strip update outside a pass is timed as a whole (read + plan + render)', () => {
		const s = setup(null);
		s.c.preMount('vertical');
		expect(s.renders).toHaveLength(1);
		expect(s.updates).toHaveLength(1);
		expect(s.updates[0]).toBeGreaterThanOrEqual(0);
	});

	describe('step V6 review round 1: the keyboard focus survives when the tab bar it was in goes away', () => {
		/** A focusable element in the tab bar (a strip row or a chip) that holds the focus until it leaves the page. */
		function withFocus(s: ReturnType<typeof setup>, chip: boolean) {
			const el = { isConnected: true, closest: (sel: string) => (chip && sel === '.tabstrip-chip' ? el : null) };
			const doc = { activeElement: null as unknown };
			const ws = { ownerDocument: doc, contains: (x: unknown) => x === el };
			let focusCalls = 0;
			const a = s.adapter as unknown as { workspaceEl: () => unknown; focusActiveLeaf: () => void };
			a.workspaceEl = () => ws;
			a.focusActiveLeaf = () => {
				focusCalls++;
			};
			const leave = () => {
				if (doc.activeElement === el) doc.activeElement = null;
				el.isConnected = false;
			};
			const strip = s.c.vstrip as unknown as { element: unknown; unmount: () => void };
			const unmount = strip.unmount;
			Object.defineProperty(strip, 'element', { get: () => (s.mounted() ? { contains: (x: unknown) => !chip && x === el } : null), configurable: true });
			strip.unmount = () => {
				unmount();
				if (!chip) leave();
			};
			const deco = (s.c as unknown as { decorator: { clear: () => void } }).decorator;
			const clear = deco.clear.bind(deco);
			deco.clear = () => {
				clear();
				if (chip) leave();
			};
			return {
				focus: () => {
					el.isConnected = true;
					doc.activeElement = el;
				},
				calls: () => focusCalls,
			};
		}

		it('control: switching to horizontal with a strip row focused gives the focus to the active tab', () => {
			const s = setup(null);
			s.c.start();
			s.c.setOrientation('vertical');
			const f = withFocus(s, false);
			f.focus();
			s.c.setOrientation('horizontal');
			expect(f.calls()).toBe(1);
		});

		it('"Restore native tab bar" from vertical with a strip row focused gives the focus to the active tab', () => {
			const s = setup(null);
			s.c.start();
			s.c.setOrientation('vertical');
			const f = withFocus(s, false);
			f.focus();
			s.c.setNativeMode(true);
			expect(s.mounted()).toBe(false);
			expect(f.calls()).toBe(1);
		});

		it('"Restore native tab bar" from horizontal with a chip focused gives the focus to the active tab', () => {
			const s = setup(null);
			s.c.start();
			const f = withFocus(s, true);
			f.focus();
			s.c.setNativeMode(true);
			expect(f.calls()).toBe(1);
		});

		it('the focus is left alone when it was outside the tab bar, and when the element stays', () => {
			const s = setup(null);
			s.c.start();
			s.c.setOrientation('vertical');
			const f = withFocus(s, false);
			s.c.setNativeMode(true);
			s.c.setNativeMode(false);
			expect(f.calls()).toBe(0);
		});
	});

	describe('step V6: a switch during an open tab drag waits for its end', () => {
		it('switching orientation while a strip row is dragged changes nothing until the drag ends, then switches on the next task', () => {
			vi.useFakeTimers();
			try {
				const s = setup(null);
				s.c.start();
				s.c.setOrientation('vertical');
				s.drag.leaf = 'a';
				s.c.toggleOrientation();
				expect(s.c.orientationMode).toBe('vertical');
				expect(s.mounted()).toBe(true);
				// The drag ends (the strip calls its dragEnd hook after it queued the drop).
				s.drag.leaf = null;
				s.c.afterDrag();
				expect(s.mounted()).toBe(true);
				vi.advanceTimersByTime(0);
				expect(s.c.orientationMode).toBe('horizontal');
				expect(s.mounted()).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it('toggling twice during the drag leaves the orientation as it was', () => {
			vi.useFakeTimers();
			try {
				const s = setup(null);
				s.c.start();
				s.c.setOrientation('vertical');
				s.drag.leaf = 'a';
				s.c.toggleOrientation();
				s.c.toggleOrientation();
				s.drag.leaf = null;
				s.c.afterDrag();
				vi.advanceTimersByTime(0);
				expect(s.c.orientationMode).toBe('vertical');
				expect(s.mounted()).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it('"Restore native tab bar" during the drag waits too; nothing runs while another drag is still open', () => {
			vi.useFakeTimers();
			try {
				const s = setup(null);
				s.c.start();
				s.c.setOrientation('vertical');
				s.drag.leaf = 'a';
				s.c.setNativeMode(true);
				expect(s.mounted()).toBe(true);
				s.c.afterDrag();
				vi.advanceTimersByTime(0);
				expect(s.mounted()).toBe(true);
				s.drag.leaf = null;
				s.c.afterDrag();
				vi.advanceTimersByTime(0);
				expect(s.mounted()).toBe(false);
				expect((s.c as unknown as { nativeMode: boolean }).nativeMode).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
