import { getLanguage, Plugin } from 'obsidian';
import { featuresOf, missingFeatures, type Capabilities, type Features } from './adapter/capabilities';
import { collectRootTabs, snapshotTabStrip, WorkspaceAdapter, type TabStripSnapshot } from './adapter/workspace';
import { TabstripController, type ControllerStats, type PassTrace } from './controller';
import { isGroupColor, orientationOf, parseSession, storedColors, stripPrefsOf, type GroupState, type Orientation } from './core';
import { localeFor, translator, type Translator } from './i18n';
import { appStorage } from './storage';
import { testHook, testHooksEnabled } from './test-hooks';
import { ConfirmModal } from './ui/confirm';
import type { VStripStats } from './ui/vstrip';

/**
 * Hooks for diagnostics and the end-to-end tests. The read-only ones (state, stats, ...) are always
 * there and have no effect. The test-setup ones (flush, flushSave, group, setCollapsed, rename,
 * trace, chipObservers with an argument) do nothing unless the test hooks are on (see
 * src/test-hooks.ts): then they return null / false / [] / the unchanged count.
 */
export interface TabstripDebug {
	state(): GroupState;
	stats(): ControllerStats;
	capabilities(): Capabilities | null;
	features(): Features | null;
	missingFeatures(): string[];
	/** Runs a pending pass now. */
	flush(): void;
	/** Group id whose editor bubble is open, or null. */
	editorGroupId(): string | null;
	decoratedHeaders(): number;
	/**
	 * Test setup: groups these tabs through the same path as "Add tab to new group", with a
	 * name and optionally a colour, without opening the editor bubble.
	 */
	group(leafIds: string[], name: string, color?: string): string | null;
	/** Test setup: collapses or expands a group through the same path as a chip click. */
	setCollapsed(groupId: string, collapsed: boolean): boolean;
	/** Test setup: renames a group through the same path as the chip editor. */
	rename(groupId: string, name: string): void;
	/** Number of groups in the unmatched list (step L6). */
	unmatchedCount(): number;
	/** Runs a pending save now. */
	flushSave(): void;
	/** Step L7: records reconcile inputs and outputs per pass (on: start afresh; off: stop and return them). */
	trace(on: boolean): PassTrace[];
	/** Step L7: milliseconds per handled dragover event and per highlight frame. */
	dragTimings(): { eventMs: number[]; frameMs: number[] };
	/** Step V1: the orientation on this device. */
	orientation(): Orientation;
	/** Step V1: render timings and remounts of the vertical strip. */
	vstrip(): VStripStats;
	/** Step V3: whether the vertical strip is collapsed to its icon bar. */
	stripCollapsed(): boolean;
	/**
	 * Step V6, test-only: the chips' own ResizeObservers off (false) or on (true) for the pop-out
	 * ResizeObserver investigation; returns how many are live. Without an argument it only counts.
	 */
	chipObservers(on?: boolean): number;
}

/**
 * Tabstrip (pre-alpha), steps L4–L6: Chrome-style tab groups on Obsidian's own tab bar.
 * Groups are created from the tab menu or commands, shown as a chip and a coloured
 * underline, edited from the chip menu, collapsed to their chip with a click (L5), and kept
 * per device across restarts; native undo-close puts a tab back into its group (L6).
 */
export default class TabstripPlugin extends Plugin {
	private controller: TabstripController | null = null;
	private adapter: WorkspaceAdapter | null = null;
	private i18n: Translator = translator('en');
	/** The open "clear data" confirmation, closed when the plugin unloads. */
	private confirm: ConfirmModal | null = null;

	override onload(): void {
		this.i18n = translator(localeFor(getLanguage()));
		const adapter = new WorkspaceAdapter(this.app);
		this.adapter = adapter;
		const storage = appStorage(this.app);
		const controller = new TabstripController(adapter, this.i18n, () => featuresOf(adapter.probe()), storage);
		this.controller = controller;
		// Step V1: a stored vertical orientation mounts the strip now, before the layout loads.
		const parsed = parseSession(storage.load());
		controller.preMount(orientationOf(parsed), storedColors(parsed), stripPrefsOf(parsed));

		this.registerCommands(controller);
		// The main window is closing: save now, then write nothing more (pop-outs close on the way out).
		this.registerEvent(
			this.app.workspace.on('quit', () => {
				controller.onQuit();
			}),
		);
		this.app.workspace.onLayoutReady(() => {
			if (this.controller !== controller) return;
			controller.start();
			const ws = this.app.workspace;
			this.registerEvent(
				ws.on('layout-change', () => {
					controller.onLayoutChange();
				}),
			);
			this.registerEvent(
				ws.on('active-leaf-change', () => {
					controller.schedule('active');
				}),
			);
			this.registerEvent(
				ws.on('window-open', () => {
					controller.schedule('window');
				}),
			);
			this.registerEvent(
				ws.on('window-close', () => {
					controller.schedule('window');
				}),
			);
			this.registerEvent(
				ws.on('css-change', () => {
					controller.schedule('css');
				}),
			);
			this.registerEvent(
				ws.on('resize', () => {
					controller.onResize();
				}),
			);
		});
	}

	override onunload(): void {
		this.confirm?.close();
		this.confirm = null;
		this.controller?.stop();
		this.controller = null;
	}

	private registerCommands(controller: TabstripController): void {
		const t = this.i18n;
		this.addCommand({
			id: 'add-to-new-group',
			name: t.t('command.addToNewGroup'),
			checkCallback: (checking) => {
				if (controller.nativeMode) return false;
				const leaf = controller.activeRootLeaf();
				if (leaf === null || leaf.pinned) return false;
				if (!checking) controller.addToNewGroup(leaf.id);
				return true;
			},
		});
		this.addCommand({
			id: 'remove-from-group',
			name: t.t('command.removeFromGroup'),
			checkCallback: (checking) => {
				if (controller.nativeMode) return false;
				const leaf = controller.activeRootLeaf();
				if (leaf?.group === undefined) return false;
				if (!checking) controller.removeFromGroup(leaf.id);
				return true;
			},
		});
		this.addCommand({
			id: 'rename-group',
			name: t.t('command.renameGroup'),
			checkCallback: (checking) => {
				const leaf = controller.activeRootLeaf();
				if (controller.nativeMode || leaf?.group === undefined || controller.enabledFeatures?.editor !== true) return false;
				if (!checking) controller.openEditor(leaf.group.id);
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-collapse-current-group',
			name: t.t('command.toggleCollapse'),
			checkCallback: (checking) => {
				const leaf = controller.activeRootLeaf();
				if (controller.nativeMode || leaf?.group === undefined) return false;
				// In stacked tabs it stays available and says why nothing happens (a notice).
				if (!checking) controller.toggleCollapsed(leaf.group.id);
				return true;
			},
		});
		this.addCommand({
			id: 'next-tab-skip-collapsed',
			name: t.t('command.nextTabSkip'),
			checkCallback: (checking) => {
				if (controller.nativeMode || controller.activeRootLeaf() === null) return false;
				if (!checking) controller.stepTab(1);
				return true;
			},
		});
		this.addCommand({
			id: 'previous-tab-skip-collapsed',
			name: t.t('command.previousTabSkip'),
			checkCallback: (checking) => {
				if (controller.nativeMode || controller.activeRootLeaf() === null) return false;
				if (!checking) controller.stepTab(-1);
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-vertical-tabs',
			name: t.t('command.toggleVertical'),
			checkCallback: (checking) => {
				if (!controller.canToggleOrientation) return false;
				if (!checking) controller.toggleOrientation();
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-vertical-strip-collapsed',
			name: t.t('command.toggleStripCollapsed'),
			checkCallback: (checking) => {
				if (!controller.canToggleStrip) return false;
				if (!checking) controller.toggleStripCollapsed();
				return true;
			},
		});
		// Step V5: the keyboard's drag (no default hotkey; Alt+Arrow Up / Down in the vertical strip's tree).
		this.addCommand({
			id: 'move-tab-back',
			name: t.t('command.moveTabBack'),
			checkCallback: (checking) => {
				const leaf = controller.activeRootLeaf();
				if (controller.nativeMode || leaf === null) return false;
				if (!checking) controller.moveTabStep(leaf.id, -1);
				return true;
			},
		});
		this.addCommand({
			id: 'move-tab-forward',
			name: t.t('command.moveTabForward'),
			checkCallback: (checking) => {
				const leaf = controller.activeRootLeaf();
				if (controller.nativeMode || leaf === null) return false;
				if (!checking) controller.moveTabStep(leaf.id, 1);
				return true;
			},
		});
		this.addCommand({
			id: 'restore-native-tab-bar',
			name: t.t('command.restoreNative'),
			checkCallback: (checking) => {
				if (controller.nativeMode || controller.enabledFeatures?.decorate !== true) return false;
				if (!checking) controller.setNativeMode(true);
				return true;
			},
		});
		this.addCommand({
			id: 'restore-unmatched-groups',
			name: t.t('command.restoreUnmatched'),
			checkCallback: (checking) => {
				if (controller.nativeMode || controller.enabledFeatures?.groups !== true) return false;
				if (!checking) controller.restoreUnmatchedGroups();
				return true;
			},
		});
		this.addCommand({
			id: 'clear-local-data',
			name: t.t('command.clearData'),
			callback: () => {
				this.confirm?.close();
				const modal = new ConfirmModal(
					this.app,
					{ title: t.t('clear.title'), message: t.t('clear.message'), confirm: t.t('clear.confirm'), cancel: t.t('clear.cancel') },
					() => {
						if (this.controller === controller) controller.clearData();
					},
					() => {
						if (this.confirm === modal) this.confirm = null;
					},
				);
				this.confirm = modal;
				modal.open();
			},
		});
		this.addCommand({
			id: 'show-tab-groups',
			name: t.t('command.showGroups'),
			checkCallback: (checking) => {
				if (!controller.nativeMode) return false;
				if (!checking) controller.setNativeMode(false);
				return true;
			},
		});
	}

	/**
	 * Read-only state of every tab strip in the main area and pop-out windows.
	 * An entry is null when that strip's private fields do not have the expected shape.
	 */
	readTabStrips(): (TabStripSnapshot | null)[] {
		return collectRootTabs(this.app).map((tabs) => snapshotTabStrip(tabs));
	}

	readonly debug: TabstripDebug = {
		state: () => this.controller?.snapshotState() ?? { groups: [], members: [], tombstones: [], nextGroupSeq: 1 },
		stats: () =>
			JSON.parse(
				JSON.stringify(
					this.controller?.stats ?? {
						passes: 0,
						opsApplied: 0,
						opsSkipped: 0,
						loopStops: 0,
						commands: 0,
						notices: [],
						timings: [],
						saves: 0,
						saveRequests: 0,
						saveMs: [],
						restore: null,
						quits: 0,
						drops: [],
						dragEnds: 0,
						stripMenus: 0,
						stripMs: [],
						inkMs: [],
					},
				),
			) as ControllerStats,
		capabilities: () => this.adapter?.capabilities ?? null,
		features: () => this.controller?.enabledFeatures ?? null,
		missingFeatures: () => {
			const features = this.controller?.enabledFeatures;
			return features ? missingFeatures(features) : [];
		},
		flush: testHook(undefined, () => {
			this.controller?.flush();
		}),
		editorGroupId: () => this.controller?.editorGroupId ?? null,
		decoratedHeaders: () => this.controller?.decoratedHeaders ?? 0,
		group: testHook(null, (leafIds: string[], name: string, color?: string) =>
			this.controller?.createGroupOf(leafIds, name, color !== undefined && isGroupColor(color) ? color : undefined) ?? null,
		),
		setCollapsed: testHook(false, (groupId: string, collapsed: boolean) => this.controller?.setGroupCollapsed(groupId, collapsed) ?? false),
		rename: testHook(undefined, (groupId: string, name: string) => {
			this.controller?.rename(groupId, name);
		}),
		unmatchedCount: () => this.controller?.unmatchedCount ?? 0,
		flushSave: testHook(undefined, () => {
			this.controller?.flushSave();
		}),
		trace: testHook([], (on: boolean) => JSON.parse(JSON.stringify(this.controller?.setTrace(on) ?? [])) as PassTrace[]),
		orientation: () => this.controller?.orientationMode ?? 'horizontal',
		vstrip: () =>
			JSON.parse(JSON.stringify(this.controller?.vstripStats ?? { renders: 0, renderMs: [], refreshMs: [], updates: 0, updateMs: [], remounts: 0, remountLog: [], headerRefreshes: 0, styleWaits: [], peeks: 0 })) as VStripStats,
		stripCollapsed: () => this.controller?.stripCollapsed ?? false,
		// Counting is read-only; switching the observers is a test-setup hook.
		chipObservers: (on) => this.controller?.chipObservers(on !== undefined && testHooksEnabled() ? on : undefined) ?? 0,
		dragTimings: () => JSON.parse(JSON.stringify(this.controller?.dragTimings ?? { eventMs: [], frameMs: [] })) as { eventMs: number[]; frameMs: number[] },
	};
}
