/**
 * Wiring between the live workspace (adapter), the pure group model (core), the tab header
 * decoration (ui) and the per-device session storage (step L6).
 *
 * Flow: workspace events (layout-change, active-leaf-change, a leaf's pinned-change, window
 * open/close) only *schedule* a pass; bursts are coalesced into one pass per tick, after
 * Obsidian's own debounced layout-change, so a snapshot never shows a half-built layout
 * (a strip missing from one snapshot would orphan its tombstones, step L3 §10). A pass reads
 * the strips, reconciles, carries out the returned ops with the native move recipe, and
 * renders. Reconcile is idempotent (L3), so the pass that follows our own ops has nothing
 * to do; a guard stops applying ops if that ever fails to hold.
 *
 * Persistence (step L6): at start the stored session is restored (core `restoreSession`), its
 * moves carried out, and the first pass reconciles from a snapshot without the tabs that came back
 * through a recently closed record, so they go back into their groups like an undo-close. Every
 * pass or command asks for a save; saves are debounced and coalesced, and only write when the
 * stored record would change. A record from a newer plugin version is never overwritten.
 */
import { Menu, Notice, type EventRef, type WorkspaceLeaf } from 'obsidian';
import { isElementLike, type Features } from './adapter/capabilities';
import { panesInWindowOf, type LeafRead, type StripRead, type WorkspaceRead } from './adapter/read';
import type { WorkspaceAdapter } from './adapter/workspace';
import {
	addToGroup,
	closeGroup,
	collapseOthers,
	colorForNewGroup,
	createGroup,
	emptyState,
	recolorGroup,
	buildSession,
	orientationOf,
	parseSession,
	reconcile,
	removeFromGroup,
	dropRevived,
	SESSION_LIMITS,
	restoreSession,
	restoreUnmatched,
	withoutLeaves,
	dropInPlace,
	dropIntentOf,
	dropUse,
	landing,
	predictDrop,
	stepTarget,
	renameGroup,
	setCollapsed,
	stepVisible,
	clampStripWidth,
	stripPrefsOf,
	STRIP_WIDTH,
	ungroup,
	type Direction,
	type DropIntent,
	type DropTarget,
	type ReconcileContext,
	type CommandResult,
	type Group,
	type GroupColor,
	type GroupState,
	type ModelEvent,
	type Op,
	type Orientation,
	type Snapshot,
	type StripPrefs,
	type RestoreReport,
	type UnmatchedGroup,
} from './core';
import type { Translator } from './i18n';
import { ATTR, CLS, HeaderDecorator } from './ui/decorator';
import { DragWatcher } from './ui/drag';
import { GroupEditor, type EditorTarget } from './ui/editor';
import { InkCache } from './ui/ink';
import { fillChipMenu, fillTabMenu } from './ui/menus';
import { planDecorations } from './ui/plan';
import { looksLikeVerticalTabs, planVerticalList, type VGroupState } from './ui/vplan';
import { VerticalStrip, type VStripLook, type VStripStats } from './ui/vstrip';
import type { SessionStorage } from './storage';

/**
 * Why a pass ran. 'ink': a window's styles were not ready for the chip text colour yet.
 * 'resize': Obsidian's workspace 'resize' event while a group is collapsed (a strip may now show
 * a hidden tab without any other event: revealLeaf in a strip without the focus, step L5).
 * 'run': not a pass but a user command (model command, its ops and the render), timed the same way.
 */
export type Trigger = 'start' | 'layout' | 'active' | 'pin' | 'window' | 'css' | 'command' | 'ink' | 'resize' | 'run' | 'drop';

export interface PassTiming {
	readonly triggers: readonly Trigger[];
	/** Milliseconds spent in the pass (read, reconcile, ops, render). */
	readonly ms: number;
	/**
	 * Of `ms`, the time spent inside Obsidian's own API while carrying out ops (moving, showing,
	 * creating, closing tabs). Showing a tab that was never loaded makes Obsidian build its view
	 * there, so `ms - opsMs` is the plugin's own share.
	 */
	readonly opsMs: number;
	/** Of `ms`, the time spent drawing (decorating tab headers, which may make the browser lay out). */
	readonly renderMs: number;
	/**
	 * Of `renderMs`, the measuring reads (chip widths, theme colours, divider side): the browser
	 * brings style and layout up to date there, so it is mostly rendering work, not script time.
	 */
	readonly layoutMs: number;
	readonly ops: number;
	readonly leaves: number;
}

/** What happened at start-up restore (step L6). */
export interface RestoreStats {
	/** What the stored value was. */
	readonly stored: 'empty' | 'ok' | 'future' | 'corrupt';
	readonly problems: number;
	readonly report: RestoreReport | null;
	/** Milliseconds for reading, restoring and carrying out the restore moves (not the first pass). */
	readonly ms: number;
	/** Of `ms`, time inside Obsidian's API carrying out the moves. */
	readonly opsMs: number;
	readonly ops: number;
}

/** A drop of a dragged tab on a strip (step L7), newest last. */
export interface DropRecord {
	readonly target: DropTarget;
	readonly intent: DropIntent;
	/** performance.now() of the drop. */
	readonly at: number;
	/**
	 * 'used' by the pass that saw the dragged tab move; 'noop': Obsidian does not move the tab for
	 * this drop, so there is nothing to use it for; 'unmoved': the layout changed, but the dragged tab
	 * did not move (an unrelated change never applies a drop); 'expired' (not used within
	 * DROP_TTL_MS); 'cancelled' (drag ended without a drop); else 'pending'.
	 */
	fate: 'pending' | 'used' | 'noop' | 'unmoved' | 'expired' | 'cancelled';
	/** Rule 4 carried out by the plugin for a drop Obsidian does not move (see core dropAfterCollapsed). */
	afterCollapsed?: boolean;
	/** Membership changed in place by the plugin for a drop Obsidian does not move (core dropInPlace, rules 2-3). */
	inPlace?: boolean;
	/**
	 * Step V5: where the drop came from when the plugin moves the tab itself: a drop on the vertical
	 * strip, or a keyboard move. Missing for Obsidian's own drops on a horizontal strip.
	 */
	via?: 'vertical' | 'keyboard';
	/** Step V5: the plugin's move of the tab failed (the move recipe was refused). */
	moveFailed?: boolean;
}

/** One reconcile of a pass, recorded only while tracing is on (test fixtures, step L7 S5). */
export interface PassTrace {
	/** performance.now() when the pass reconciled. */
	readonly at: number;
	readonly triggers: readonly Trigger[];
	readonly prev: Snapshot;
	readonly next: Snapshot;
	readonly before: GroupState;
	readonly ctx: ReconcileContext;
	readonly after: GroupState;
	readonly ops: readonly Op[];
}

export interface ControllerStats {
	/** Writes to the per-device storage. */
	saves: number;
	/** Save requests (each pass or command asks once); saves coalesce them. */
	saveRequests: number;
	/** Milliseconds per write (building and storing the record), newest last. */
	saveMs: number[];
	restore: RestoreStats | null;
	/** Calls of onQuit (Obsidian's 'quit' event); after the first, nothing is written. */
	quits: number;
	passes: number;
	opsApplied: number;
	opsSkipped: number;
	/** Passes in which the loop guard refused to apply ops (should stay 0). */
	loopStops: number;
	commands: number;
	notices: string[];
	timings: PassTiming[];
	/** Step L7: drops on strips, newest last (at most 50). */
	drops: DropRecord[];
	/** Step L7: drags that ended (dragend or Escape). */
	dragEnds: number;
	/** Step V2: native tab menus opened from the vertical strip. */
	stripMenus: number;
	/** Step V2: plugin time per vertical strip update (plan, inks, render), ms, newest last. */
	stripMs: number[];
	/** V2 review round 2: plugin time of each chip-ink measurement (probes and style reads), ms, newest last. */
	inkMs: number[];
}

/** Consecutive passes with ops after which ops are no longer applied. */
const LOOP_LIMIT = 4;
/** While a window's styles are not ready, look again this often, at most this many times (about 5 s). */
const INK_RETRY_MS = 100;
const INK_RETRIES = 50;
const TIMING_LIMIT = 2000;
/** Saves wait this long after the last change, and never longer than SAVE_MAX_WAIT_MS after the first. */
export const SAVE_DEBOUNCE_MS = 500;
export const SAVE_MAX_WAIT_MS = 2000;
const DROP_LIMIT = 50;
const TRACE_LIMIT = 200;
/** Debug logging, off by default. */
export const debugLogging = { enabled: false };

function debugLog(...args: unknown[]): void {
	if (debugLogging.enabled) console.debug('[tabstrip]', ...args);
}

export class TabstripController {
	private state: GroupState = emptyState();
	private prev: Snapshot | null = null;
	private read: WorkspaceRead | null = null;
	private features: Features | null = null;
	private timer: number | null = null;
	private inkTimer: number | null = null;
	/** V2 review round 2: the pending idle measurement of the main window's chip inks (warmInk). */
	private inkWarm: (() => void) | null = null;
	private inkRetries = 0;
	private readonly triggers = new Set<Trigger>();
	private txnSeq = 0;
	private txnId: string | null = null;
	/** Time spent in adapter.applyOps since the current pass or run started. */
	private opsMs = 0;
	/** Time spent rendering since the current pass or run started. */
	private renderMs = 0;
	/** Of that, time in the decorator's measuring reads. */
	private layoutMs = 0;
	private streak = 0;
	private running = false;
	/** False while a key press on a chip runs a command: activate ops then leave the focus alone. */
	private activateFocus = true;
	/** "Restore native tab bar": no decoration and no menu items until switched back. */
	private native = false;
	private headerToLeaf = new Map<HTMLElement, string>();
	/** Groups not found at start-up ("Restore unmatched groups"). */
	private unmatched: UnmatchedGroup[] = [];
	private saveTimer: number | null = null;
	private saveDirtySince: number | null = null;
	/** The record last written (or read), as JSON; a save that would write the same is skipped. */
	private lastSaved: string | null = null;
	/**
	 * Nothing is stored (the key was absent at start-up, or was just cleared). Then a session with
	 * no group, no closed record and no unmatched group is not written: running the plugin alone
	 * never creates the key (review round 2).
	 */
	private storedNothing = false;
	/** Saving is allowed only after a restore ran in this session. */
	private restored = false;
	/**
	 * The stored record comes from a newer plugin version, cannot be read, or failed to restore:
	 * never overwrite it (the clear command lifts this).
	 */
	private readOnly = false;
	/** The app is quitting: the last save has run, nothing more is written. */
	private frozen = false;
	private readonly pinRefs = new Map<object, EventRef>();
	private readonly docListeners = new Map<Document, () => void>();
	private readonly ink = new InkCache();
	/** The root tab last seen active (see recentRootLeaf). */
	private lastRootActive: string | null = null;
	private readonly decorator: HeaderDecorator;
	private readonly editor: GroupEditor;
	private readonly drag: DragWatcher;
	/** Step V1: the tab strip orientation on this device (stored in the session record). */
	private orientation: Orientation = 'horizontal';
	private readonly vstrip: VerticalStrip;
	/** Group colours of the stored session, for rows drawn before start() (review round 2 of V1). */
	private earlyColors: VGroupState = { groups: [], members: [] };
	/** Step V3: width and icon bar state of the vertical strip on this device (stored in the session record). */
	private stripPrefs: StripPrefs = {};
	/** The Vertical Tabs conflict notice was shown in this session. */
	private vtNoticed = false;
	/**
	 * Step V6: orientation and native-mode switches asked for while a tab drag is open (a row of the
	 * vertical strip, or a tab header the drag watcher follows). Unmounting the strip would remove the
	 * dragged row, and Obsidian listens for its dragend there, so the switch waits for the drag to end
	 * (its drop, if any, is applied first) and then runs in order.
	 */
	private deferredSwitches: (() => void)[] = [];
	/** Step V6: the orientation a deferred switch will set, so toggling twice during a drag goes back. */
	private pendingOrientation: Orientation | null = null;
	/** The "vertical tabs not available" notice was shown in this session. */
	private vUnavailableNoticed = false;
	/** The last drop on a strip, until a pass uses it, it expires or the drag is cancelled (step L7). */
	private pendingDrop: DropRecord | null = null;
	/** Reconcile inputs and outputs per pass, only while tracing (tests). */
	private trace: PassTrace[] | null = null;
	readonly stats: ControllerStats = {
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
		inkMs: this.ink.measureMs,
	};

	constructor(
		private readonly adapter: WorkspaceAdapter,
		private readonly t: Translator,
		private readonly getFeatures: () => Features,
		private readonly storage: SessionStorage,
	) {
		this.decorator = new HeaderDecorator(t, this.ink, {
			chipMenu: (groupId, chip, evt) => {
				this.openChipMenu(groupId, chip, evt);
			},
			moved: () => {
				this.schedule('window');
			},
			toggle: (groupId, chip, keyboard) => {
				this.toggleFromChip(groupId, chip, keyboard);
			},
		});
		this.editor = new GroupEditor(t);
		this.vstrip = new VerticalStrip(t, {
			activate: (leafId) => {
				this.activateFromStrip(leafId);
			},
			toggleSidebar: (side) => {
				this.adapter.toggleSidebar(side);
			},
			mounted: () => {
				// The mount waited for styles.css (plugin enabled while Obsidian runs): draw the rows now.
				this.drawStripNow();
			},
			hostChanged: () => {
				this.drawStripNow();
			},
			tabsChanged: () => {
				this.drawStripNow();
			},
			close: (leafId) => {
				this.closeFromStrip(leafId);
			},
			tabMenu: (leafId, row, evt) => {
				this.openStripTabMenu(leafId, row, evt);
			},
			groupMenu: (groupId, row, evt) => {
				if (!this.running || this.native) return;
				const menu = this.openChipMenu(groupId, row, evt);
				if (menu !== null) this.watchStripMenu(menu, row, `g:${groupId}`, evt === null);
			},
			toggleGroup: (groupId, keyboard, collapse) => {
				this.toggleFromStripRow(groupId, keyboard, collapse);
			},
			renameGroup: (groupId) => {
				this.openEditor(groupId, true);
			},
			newTab: (paneId) => {
				this.newTabInPane(paneId);
			},
			toggleCollapsed: () => {
				this.toggleStripCollapsed();
			},
			keyScopes: () => this.adapter.keyScopes(),
			widthChanged: (width) => {
				this.setStripPrefs({ ...this.stripPrefs, width });
			},
			dragStart: (leafId, row, evt) => this.startStripDrag(leafId, row, evt),
			dragPredict: (target) => this.predictStripDrop(target),
			dragDrop: (target) => {
				this.applyStripDrop(target, 'vertical');
			},
			moveTab: (leafId, dir) => {
				this.moveTabStep(leafId, dir);
			},
			dragEnd: () => {
				this.afterDrag();
			},
		});
		this.drag = new DragWatcher({
			leafOf: (header) => this.headerToLeaf.get(header) ?? null,
			predict: (target) => this.predictDrop(target),
			dropped: (target) => {
				this.onDrop(target);
			},
			ended: (dropped) => {
				this.stats.dragEnds++;
				if (!dropped && this.pendingDrop !== null) {
					this.pendingDrop.fate = 'cancelled';
					this.pendingDrop = null;
				}
				this.afterDrag();
			},
			anyDrag: (on) => {
				this.vstrip.setAnyDrag(on);
			},
		});
	}

	// ---------------------------------------------------------------- lifecycle

	/** Call once the layout is ready. */
	start(): void {
		this.features = this.getFeatures();
		this.running = true;
		debugLog('features', this.features);
		if (!this.features.groups) {
			this.syncStrip();
			return;
		}
		this.restore();
		this.syncStrip();
		this.pass(['start']);
		this.warmInk();
	}

	/**
	 * V2 review round 2: measures the main window's chip inks when the browser is idle, so the first
	 * update that needs them (a new named group) does not pay for the probes and the style
	 * recalculation they force (1-2 ms at 50 tabs, right after Obsidian moved tabs). Called at start
	 * and after the CSS changed (the cache was cleared). A window that is not ready is measured again
	 * by the next update, as before.
	 */
	private warmInk(): void {
		this.inkWarm?.();
		this.inkWarm = null;
		// May be missing in unit tests' fake page.
		const doc = (this.adapter.workspaceEl().ownerDocument as Document | null | undefined) ?? null;
		const win = doc?.defaultView ?? null;
		if (doc === null || win === null) return;
		const run = () => {
			this.inkWarm = null;
			if (this.running) this.ink.inkFor(doc, 'grey');
		};
		if (typeof win.requestIdleCallback === 'function') {
			const handle = win.requestIdleCallback(run, { timeout: 2000 });
			this.inkWarm = () => {
				win.cancelIdleCallback(handle);
			};
		} else {
			const handle = win.setTimeout(run, 200);
			this.inkWarm = () => {
				win.clearTimeout(handle);
			};
		}
	}

	// ---------------------------------------------------------------- vertical strip (step V1)

	/**
	 * Called from the plugin's onload, before the layout is ready: with a stored vertical orientation
	 * the (empty) strip is mounted at once, so the native tab bar of the root split is never painted
	 * while the layout loads. start() confirms it (or takes it back when the APIs are missing).
	 */
	preMount(orientation: Orientation, colors: VGroupState = { groups: [], members: [] }, prefs: StripPrefs = {}): void {
		this.orientation = orientation;
		this.earlyColors = colors;
		this.stripPrefs = prefs;
		this.vstrip.setLook(this.stripLook());
		this.syncStrip();
		this.drawStripNow();
	}

	/**
	 * Review round 2: draws the rows right away (not in the next scheduled pass), when the strip has
	 * just been mounted or the root split was swapped by a layout load. Before start() (layout not
	 * ready yet) it probes the APIs read-only and colours the rows from the stored session; when the
	 * tab headers are not readable it draws nothing and start() decides.
	 */
	private drawStripNow(): void {
		if (!this.vstrip.mounted) return;
		// Review round 3: the whole update is timed (read + plan + render), not only the row writes.
		const started = performance.now();
		try {
			this.drawStripRows();
		} finally {
			this.vstrip.noteUpdate(performance.now() - started);
		}
	}

	private drawStripRows(): void {
		if (this.running) {
			if (this.features?.decorate === true && !this.native) this.renderStrip(this.adapter.read());
			return;
		}
		let headers = false;
		try {
			headers = this.adapter.probe().headers;
		} catch {
			headers = false;
		}
		if (!headers) {
			// Nothing readable yet. Without a root split element (a layout load) the list is empty.
			if (!this.adapter.rootShown()) this.vstrip.render(EMPTY_LIST, () => null);
			return;
		}
		this.renderStrip(this.adapter.read(), this.earlyColors);
	}

	get orientationMode(): Orientation {
		return this.orientation;
	}

	/** Whether the orientation command can run now. */
	get canToggleOrientation(): boolean {
		return this.running && this.features?.decorate === true && !this.native;
	}

	/** The orientation the toggle command switches away from: a switch waiting for a drag counts (V6). */
	get targetOrientation(): Orientation {
		return this.pendingOrientation ?? this.orientation;
	}

	/** The toggle command: the other orientation than the current (or already requested) one. */
	toggleOrientation(): void {
		this.setOrientation(this.targetOrientation === 'vertical' ? 'horizontal' : 'vertical');
	}

	/**
	 * Switches the orientation on this device and stores it. Groups, pinned tabs, collapsed groups,
	 * the tab order and the active tab are the same model in both orientations, and the layout is not
	 * touched. Strip, class and chips change in one task, so no frame shows both tab bars or neither.
	 * While a tab drag is open the switch waits for its end (step V6).
	 */
	setOrientation(orientation: Orientation): void {
		if (this.dragOpen()) {
			this.pendingOrientation = orientation;
			this.deferSwitch(() => {
				if (this.pendingOrientation !== orientation) return;
				this.pendingOrientation = null;
				this.setOrientation(orientation);
			});
			return;
		}
		this.pendingOrientation = null;
		if (this.orientation === orientation) return;
		const focus = this.focusInTabBar();
		this.orientation = orientation;
		this.syncStrip();
		if (this.running && this.features?.groups === true) {
			this.flush();
			this.render(this.adapter.read());
			// An explicit choice is always compared afresh: after "Clear data on this device" lastSaved may hold
			// a record that was never written, which would swallow a switch back to it.
			this.lastSaved = null;
			this.requestSave();
		}
		this.keepFocus(focus);
	}

	/** Step V6: a tab drag the plugin follows is open (a strip row, or a tab header). */
	private dragOpen(): boolean {
		return this.vstrip.draggedLeaf !== null || this.drag.draggedLeaf !== null;
	}

	private deferSwitch(run: () => void): void {
		this.deferredSwitches.push(run);
	}

	/**
	 * A drag ended: run the switches that waited for it, on the next task (after the drop, which the
	 * strip hands on in a task queued before this one).
	 */
	private afterDrag(): void {
		if (this.deferredSwitches.length === 0 || this.dragOpen()) return;
		const runs = this.deferredSwitches;
		this.deferredSwitches = [];
		window.setTimeout(() => {
			if (!this.running) return;
			for (const run of runs) run();
		}, 0);
	}

	/**
	 * Step V6: the element in the main window's tab bar (a strip row, a strip button, a chip) that has
	 * the keyboard focus, or null when the focus is elsewhere (the editor, a sidebar, a pop-out).
	 */
	private focusInTabBar(): Element | null {
		const ws = this.adapter.workspaceEl() as HTMLElement | null | undefined;
		const doc = ws?.ownerDocument ?? null;
		const active = doc?.activeElement ?? null;
		if (active === null || ws === null || ws === undefined) return null;
		const strip = this.vstrip.element;
		if (strip?.contains(active) === true) return active;
		return active.closest('.tabstrip-chip') !== null && ws.contains(active) ? active : null;
	}

	/** A focused element of the tab bar that the switch removed: the focus goes to the active tab's view. */
	private keepFocus(was: Element | null): void {
		if (was === null || was.isConnected) return;
		this.adapter.focusActiveLeaf();
	}

	get vstripStats(): VStripStats {
		return this.vstrip.stats;
	}

	/** Mounts or unmounts the strip to match the orientation, native mode and the available APIs. */
	private syncStrip(): void {
		const vertical = this.orientation === 'vertical' && !this.native;
		// Before start(): trust the stored orientation. After: the strip needs the tab headers (titles, icons).
		const able = !this.running || this.features?.decorate === true;
		if (vertical && !able && !this.vUnavailableNoticed) {
			this.vUnavailableNoticed = true;
			this.notify(this.t.t('notice.verticalUnavailable'));
		}
		if (vertical && able) {
			this.vstrip.mount(this.adapter.workspaceEl());
		} else {
			this.vstrip.unmount();
		}
		this.checkVerticalTabs();
	}

	/**
	 * The Vertical Tabs community plugin changes the tab bar too, in both orientations: one notice per
	 * session says that they overlap (not in native mode, where Tabstrip leaves the tab bar alone).
	 * Tabstrip never disables it. Checked when the strip is synced and at every pass until shown, since
	 * that plugin may set itself up after Tabstrip started.
	 */
	private checkVerticalTabs(): void {
		if (this.vtNoticed || !this.running || this.native) return;
		const signals = this.adapter.verticalTabsSignals();
		if (!looksLikeVerticalTabs(signals.views, signals.bodyClasses)) return;
		this.vtNoticed = true;
		this.notify(this.t.t('notice.verticalTabsConflict'));
	}

	/** Rows for the tabs of the root split. A failure takes the strip away, so the native tab bar shows again. */
	private renderStrip(read: WorkspaceRead, colors: VGroupState = this.state): void {
		if (!this.vstrip.mounted) return;
		const started = performance.now();
		try {
			const headerRows: HTMLElement[] = [];
			for (const strip of read.strips) if (strip.kind === 'main' && strip.container !== null) headerRows.push(strip.container);
			const root = this.adapter.rootState(headerRows);
			// While a layout loads, the root split is out of the page (no native tab shows): no rows either.
			if (root === 'loading') {
				this.vstrip.render(EMPTY_LIST, () => null);
				return;
			}
			// Tabs in the page but no root split element found: the strip cannot know where it is.
			if (root === 'missing') throw new Error('root split element not found');
			const headers = new Map<string, HTMLElement | null>();
			for (const strip of read.strips) if (strip.kind === 'main') for (const leaf of strip.leaves) headers.set(leaf.id, leaf.header);
			const plan = planVerticalList(read.strips, colors, read.snapshot.activeLeafId, this.recentRootLeaf(read.snapshot.activeLeafId, headers));
			// Measure phase: the group name inks of the main window (cached per colour; may read styles).
			const doc = this.vstrip.element?.ownerDocument ?? null;
			const inks = new Map<GroupColor, string | null>();
			if (doc !== null) for (const g of colors.groups) if (!inks.has(g.color) && (g.name ?? '').trim().length > 0) inks.set(g.color, this.ink.inkFor(doc, g.color));
			const splits = this.adapter.rootSplitElements(headerRows);
			this.vstrip.render(plan, (leafId) => headers.get(leafId) ?? null, headerRows, splits, (color) => inks.get(color) ?? null, headers);
			this.stats.stripMs.push(performance.now() - started);
			if (this.stats.stripMs.length > TIMING_LIMIT) this.stats.stripMs.splice(0, this.stats.stripMs.length - TIMING_LIMIT);
		} catch (e) {
			console.error('Tabstrip: could not draw the vertical tab strip; the native tab bar is shown again', e);
			this.vstrip.unmount();
		}
	}

	/**
	 * The root tab to highlight while the focus is outside the root split (review round 1). The
	 * public getMostRecentLeaf asks every leaf whether it is visible, which forces a layout right after
	 * Obsidian inserted a view (about 6 ms at 150 tabs when a deferred tab loads). So it is asked only
	 * when the focus is outside the root split and the root tab last seen active is gone: while a root
	 * tab is active it is the most recent one, and that id is kept for later.
	 */
	private recentRootLeaf(activeLeafId: string | null, rootLeaves: ReadonlyMap<string, unknown>): string | null {
		if (activeLeafId !== null && rootLeaves.has(activeLeafId)) {
			this.lastRootActive = activeLeafId;
			return null;
		}
		if (this.lastRootActive !== null && rootLeaves.has(this.lastRootActive)) return this.lastRootActive;
		this.lastRootActive = this.adapter.recentRootLeafId();
		return this.lastRootActive;
	}

	/** A click on a strip row: show and focus that tab. */
	private activateFromStrip(leafId: string): void {
		if (!this.running) return;
		const read = this.adapter.read();
		const found = this.findLeaf(read, leafId);
		if (found !== null) this.adapter.activateLeaf(found.leaf.leaf);
	}

	/** Middle click, the row's close button or Delete on a strip row: close that tab (like the native ones). */
	private closeFromStrip(leafId: string): void {
		if (!this.running) return;
		const found = this.findLeaf(this.adapter.read(), leafId);
		if (found !== null) this.adapter.closeLeaf(found.leaf.leaf);
	}

	/**
	 * Right click (or Shift+F10 / the context-menu key) on a strip row: Obsidian's own tab menu for
	 * that tab, with the group items added by the same capture listener as on the horizontal strip.
	 */
	private openStripTabMenu(leafId: string, row: HTMLElement, evt: MouseEvent | null): void {
		if (!this.running || this.native) return;
		this.flush();
		const found = this.findLeaf(this.adapter.read(), leafId);
		const header = found?.leaf.header ?? null;
		if (header === null) return;
		let x: number;
		let y: number;
		if (evt !== null) {
			x = evt.clientX;
			y = evt.clientY;
		} else {
			// Keyboard: under the row's start (an event handler: a measure before anything is written).
			const box = row.getBoundingClientRect();
			x = box.left + 12;
			y = box.bottom;
		}
		this.stats.stripMenus++;
		const menu = this.adapter.openTabMenu(header, row, x, y);
		if (menu !== null) this.watchStripMenu(menu, row, `t:${leafId}`, evt === null);
	}

	/**
	 * Review round 1: a menu opened from a strip row keeps the icon bar's overlay open while it shows
	 * (public Menu.onHide), and a menu opened from the keyboard gives the focus back to its row when
	 * it closes with Escape, or when its item left the focus nowhere (WAI-ARIA menu button pattern).
	 * An item that moved the focus on purpose (the rename bubble, a tab it showed) keeps it there.
	 *
	 * Obsidian closes the menu on Escape from its own key handler at the window, which runs before any
	 * listener a plugin can add there, and the same key press then moves the focus to the editor. So
	 * the Escape is caught on its way on: a listener added to the document while the key press is
	 * still at the window gets it (it is removed again right after).
	 */
	private watchStripMenu(menu: Menu, row: HTMLElement, key: string, keyboard: boolean): void {
		const release = this.vstrip.holdPeek();
		const doc = row.ownerDocument;
		const win = doc.defaultView ?? window;
		menu.onHide(() => {
			let escaped = false;
			const onKey = (e: KeyboardEvent) => {
				if (e.key === 'Escape') escaped = true;
			};
			if (keyboard) doc.addEventListener('keydown', onKey, true);
			// After the rest of the closing key press or click, and the item's action.
			win.setTimeout(() => {
				doc.removeEventListener('keydown', onKey, true);
				release();
				if (!keyboard || this.editor.groupId !== null || !this.vstrip.mounted) return;
				const active = doc.activeElement;
				const lost = active === null || active === doc.body;
				if (escaped || lost) this.vstrip.focusKeyed(key);
			}, 0);
		});
	}

	/**
	 * Click on a group row, or Enter / Space / Arrow Left / Right on it: collapse or expand the group
	 * (the same model as the chip). From the keyboard the focus stays on the group row. `collapse` is
	 * the state the row asks for as drawn: in a stacked pane a collapsed group is drawn expanded, so
	 * there it asks to collapse, which the stacked pane refuses with a notice (review round 3).
	 */
	private toggleFromStripRow(groupId: string, keyboard: boolean, collapse: boolean): void {
		if (!keyboard) {
			this.setGroupCollapsed(groupId, collapse);
			return;
		}
		this.activateFocus = false;
		try {
			this.setGroupCollapsed(groupId, collapse);
		} finally {
			this.activateFocus = true;
		}
		this.vstrip.focusKeyed(`g:${groupId}`);
	}

	/** The "New tab" row of a pane: a new tab at the end of that pane (public createLeafInParent). */
	newTabInPane(paneId: string): string | null {
		if (!this.running || this.features?.newTabInGroup !== true) return null;
		this.flush();
		const read = this.adapter.read();
		const strip = read.strips.find((s) => s.paneId === paneId);
		if (strip === undefined) return null;
		const id = this.adapter.createLeafAt(strip.tabs, strip.leaves.length);
		this.schedule('command');
		return id;
	}

	// ---------------------------------------------------------------- icon bar and width (step V3)

	private stripLook(): VStripLook {
		return { collapsed: this.stripPrefs.collapsed === true, width: clampStripWidth(this.stripPrefs.width ?? STRIP_WIDTH.default), minWidth: STRIP_WIDTH.min, maxWidth: STRIP_WIDTH.max };
	}

	get stripCollapsed(): boolean {
		return this.stripPrefs.collapsed === true;
	}

	/** Whether "Collapse/expand vertical tab strip" can run now. */
	get canToggleStrip(): boolean {
		return this.vstrip.mounted && !this.native;
	}

	/** Collapses the vertical strip to its icon bar, or expands it; stored per device. */
	toggleStripCollapsed(): void {
		if (!this.vstrip.mounted) return;
		const collapsed = this.stripPrefs.collapsed !== true;
		const { width } = this.stripPrefs;
		this.setStripPrefs({ ...(width !== undefined ? { width } : {}), ...(collapsed ? { collapsed: true as const } : {}) });
	}

	private setStripPrefs(prefs: StripPrefs): void {
		this.stripPrefs = prefs;
		this.vstrip.setLook(this.stripLook());
		if (this.running && this.features?.groups === true) {
			// An explicit choice is always compared afresh (see setOrientation).
			this.lastSaved = null;
			this.requestSave();
		}
	}

	/**
	 * Removes everything this plugin added to the page. A pending save runs first: disabling keeps
	 * the stored groups, and enabling again restores them.
	 */
	stop(): void {
		this.flushSave();
		this.running = false;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (this.inkTimer !== null) window.clearTimeout(this.inkTimer);
		this.inkTimer = null;
		this.inkWarm?.();
		this.inkWarm = null;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		this.editor.close('drop');
		this.decorator.clear();
		this.drag.clear();
		this.vstrip.unmount();
		this.pendingDrop = null;
		for (const [leaf, ref] of this.pinRefs) (leaf as WorkspaceLeaf).offref(ref);
		this.pinRefs.clear();
		for (const remove of this.docListeners.values()) remove();
		this.docListeners.clear();
		this.headerToLeaf.clear();
	}

	get nativeMode(): boolean {
		return this.native;
	}

	/**
	 * Restores the native tab bar (removes every chip, mark, underline, bubble and tab menu
	 * item) or shows the groups again. The model keeps following the tabs meanwhile.
	 */
	setNativeMode(on: boolean): void {
		if (this.dragOpen()) {
			this.deferSwitch(() => {
				this.setNativeMode(on);
			});
			return;
		}
		if (this.native === on) return;
		// A strip row or a chip with the keyboard focus leaves the page with the groups (V6 review round 1).
		const focus = this.focusInTabBar();
		if (on) this.expandAll();
		this.native = on;
		if (on) {
			this.editor.close('drop');
			this.decorator.clear();
			this.drag.clear();
			this.vstrip.unmount();
			this.pendingDrop = null;
			for (const remove of this.docListeners.values()) remove();
			this.docListeners.clear();
		} else if (this.running && this.features?.groups === true) {
			this.syncStrip();
			this.render(this.adapter.read());
		}
		this.keepFocus(focus);
	}

	/**
	 * Obsidian's workspace 'resize' event. It follows every change of a strip's shown tab (the
	 * native tab selection asks for a resize), also when no other event fires: revealLeaf on a tab
	 * of a strip that does not hold the focus. Only needed while a group is collapsed, to expand a
	 * group whose hidden tab is now shown; otherwise ignored, so it costs nothing.
	 */
	onResize(): void {
		if (this.state.groups.some((g) => g.collapsed)) this.schedule('resize');
	}

	/**
	 * Obsidian's 'layout-change' (review round 2): in vertical mode the strip's rows follow at once
	 * (a new pane, a closed pane), then the full pass is scheduled as before.
	 */
	onLayoutChange(): void {
		this.drawStripNow();
		this.schedule('layout');
	}

	/** Coalesces bursts of workspace events into one pass on the next tick. */
	schedule(trigger: Trigger): void {
		if (!this.running || this.features?.groups !== true) return;
		if (trigger === 'css') {
			this.ink.clear();
			this.decorator.invalidate();
			this.warmInk();
		}
		this.triggers.add(trigger);
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.runScheduled();
		}, 0);
	}

	/** Runs a scheduled pass now (before a command or a menu reads the state). */
	flush(): void {
		if (this.timer === null) return;
		window.clearTimeout(this.timer);
		this.timer = null;
		this.runScheduled();
	}

	private runScheduled(): void {
		if (!this.running) return;
		const triggers = [...this.triggers];
		this.triggers.clear();
		this.pass(triggers);
	}

	// ---------------------------------------------------------------- persistence (step L6)

	/**
	 * Restores the stored session for the tabs open now (recovery order: leaf id, recently closed
	 * record, unique file fingerprint, else the unmatched list) and carries out the moves that line
	 * up scattered groups. The first pass follows; it expands a restored collapsed group that holds
	 * a shown tab before anything is drawn, so no hidden shown tab is ever painted.
	 */
	private restore(): void {
		const started = performance.now();
		this.opsMs = 0;
		const parsed = parseSession(this.storage.load());
		let read = this.adapter.read();
		let returning: readonly string[] = [];
		let report: RestoreReport | null = null;
		let ops: readonly Op[] = [];
		this.storedNothing = parsed.kind === 'empty';
		if (parsed.kind === 'future') {
			this.readOnly = true;
			this.notify(this.t.t('notice.storeFuture'));
		} else if (parsed.kind === 'corrupt') {
			// Not a session this version can read (a version as text, a fraction, no version, not an
			// object, a failed migration): it may be another version's data or something the user
			// can still recover, so it is kept as it is. Saving resumes only after the user runs
			// "Clear data on this device" (review round 6).
			this.readOnly = true;
			this.notify(this.t.t('notice.storeCorrupt'));
		} else if (parsed.kind === 'ok') {
			if (parsed.problems.length > 0) {
				debugLog('stored session problems', parsed.problems);
				this.notify(this.t.t('notice.storePartial'));
			} else {
				this.lastSaved = JSON.stringify(parsed.session);
			}
			this.orientation = orientationOf(parsed);
			this.stripPrefs = stripPrefsOf(parsed);
			this.vstrip.setLook(this.stripLook());
			try {
				const result = restoreSession(parsed.session, read.snapshot);
				this.state = result.state;
				this.unmatched = [...result.unmatched];
				returning = result.returning;
				report = result.report;
				ops = this.features?.moves === true ? result.ops : [];
				if (result.report.unmatchedGroups > 0) {
					this.notify(this.t.t('notice.unmatchedAtStart', { count: result.report.unmatchedGroups }));
				}
				this.noticeDropped(result.report.droppedUnmatched);
			} catch (e) {
				// Never write over a stored session this session failed to restore: start empty and
				// read-only, like a record from a newer version (review round 1).
				console.error('Tabstrip: could not restore the saved tab groups', e);
				this.state = emptyState();
				this.unmatched = [];
				returning = [];
				report = null;
				ops = [];
				this.readOnly = true;
				this.notify(this.t.t('notice.restoreFailed'));
			}
		}
		if (ops.length > 0) {
			this.applyOps(ops, read);
			read = this.adapter.read();
		}
		// Tabs that came back through a closed record are new to the first pass (like an undo-close).
		this.prev = withoutLeaves(read.snapshot, returning);
		this.txnId = null;
		this.restored = true;
		this.stats.restore = {
			stored: parsed.kind,
			problems: parsed.kind === 'ok' || parsed.kind === 'corrupt' ? parsed.problems.length : 0,
			report,
			ms: performance.now() - started,
			opsMs: this.opsMs,
			ops: ops.length,
		};
		debugLog('restore', this.stats.restore);
	}

	/** Asks for a save: debounced (SAVE_DEBOUNCE_MS after the last request, at most SAVE_MAX_WAIT_MS). */
	private requestSave(): void {
		if (!this.restored || this.readOnly || this.frozen || !this.running) return;
		this.stats.saveRequests++;
		const now = performance.now();
		this.saveDirtySince ??= now;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, this.saveDirtySince + SAVE_MAX_WAIT_MS - now));
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, wait);
	}

	/** Runs a pending save now (plugin disabled, app quitting). */
	flushSave(): void {
		if (this.saveTimer === null) return;
		window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		this.saveNow();
	}

	/** Writes the record when it differs from the last one written. */
	private saveNow(): void {
		this.saveDirtySince = null;
		if (!this.restored || this.readOnly || this.frozen) return;
		const started = performance.now();
		const snapshot = this.read?.snapshot ?? this.adapter.read().snapshot;
		const session = buildSession(this.state, snapshot, this.unmatched, this.orientation, this.stripPrefs);
		const text = JSON.stringify(session);
		if (text === this.lastSaved) return;
		if (this.storedNothing && session.groups.length === 0 && session.closed.length === 0 && session.unmatched.length === 0 && session.orientation === undefined && session.vstrip === undefined) return;
		this.storage.save(session);
		this.storedNothing = false;
		this.lastSaved = text;
		this.stats.saves++;
		this.stats.saveMs.push(performance.now() - started);
		if (this.stats.saveMs.length > TIMING_LIMIT) this.stats.saveMs.splice(0, this.stats.saveMs.length - TIMING_LIMIT);
	}

	/**
	 * Obsidian's public 'quit' event (the main window is closing): save now, then stop writing, so
	 * windows that close while the app shuts down are not stored as closed groups.
	 */
	onQuit(): void {
		this.stats.quits++;
		this.flush();
		this.flushSave();
		this.frozen = true;
	}

	get unmatchedCount(): number {
		return this.unmatched.length;
	}

	/**
	 * "Restore unmatched groups": recreates unmatched groups from open tabs in no group whose files
	 * match (core `restoreUnmatched`), or says that nothing matched. Returns the number recreated.
	 */
	restoreUnmatchedGroups(): number {
		if (this.unmatched.length === 0) {
			this.notify(this.t.t('notice.noUnmatched'));
			return 0;
		}
		let matched = 0;
		// run() returns null when it refused the command (moves needed but unavailable, the command
		// threw, plugin not running): then nothing was committed and the list stays as it is.
		const result = this.run((state, read) => {
			const r = restoreUnmatched(state, read.snapshot, this.unmatched);
			matched = r.restored.length;
			return r;
		});
		if (result === null) {
			this.notify(this.t.t(matched > 0 ? 'notice.unmatchedRefused' : 'notice.nothingMatched', { count: this.unmatched.length }));
			return 0;
		}
		if (result.restored.length === 0) {
			this.notify(this.t.t('notice.nothingMatched', { count: this.unmatched.length }));
			return 0;
		}
		this.unmatched = [...result.remaining];
		this.requestSave();
		this.notify(
			result.leftMembers > 0
				? this.t.t('notice.restoredUnmatchedPartial', { count: result.restored.length, left: result.leftMembers })
				: this.t.t('notice.restoredUnmatched', { count: result.restored.length }),
		);
		this.noticeDropped(result.dropped);
		return result.restored.length;
	}

	/** Tells the user when unmatched entries had to go because the list is full (never silent). */
	private noticeDropped(count: number): void {
		if (count > 0) this.notify(this.t.t('notice.unmatchedDropped', { count, limit: SESSION_LIMITS.unmatched }));
	}

	/**
	 * "Clear data on this device" (after the confirmation): removes the stored key and
	 * forgets the recently closed and unmatched lists. Open groups stay on screen; they are written
	 * again only after the next change to a group or to the orientation, so disabling, uninstalling
	 * or restarting right after clearing leaves nothing stored (`storedNothing`: an empty session is
	 * never written). Clearing also drops the stored orientation; this session keeps its orientation and the next save stores it again.
	 */
	clearData(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		this.saveDirtySince = null;
		this.storage.clear();
		this.storedNothing = true;
		this.unmatched = [];
		this.state = { ...this.state, tombstones: [] };
		this.readOnly = false;
		this.lastSaved = this.read === null ? null : JSON.stringify(buildSession(this.state, this.read.snapshot, this.unmatched, this.orientation, this.stripPrefs));
		this.notify(this.t.t('notice.cleared'));
	}

	// ---------------------------------------------------------------- the pass

	private pass(triggers: readonly Trigger[]): void {
		this.checkVerticalTabs();
		const started = performance.now();
		this.opsMs = 0;
		this.renderMs = 0;
		this.layoutMs = 0;
		const read = this.adapter.read();
		const prev = this.prev ?? read.snapshot;
		const before = this.state;
		let ops: readonly Op[] = [];
		let events: readonly ModelEvent[] = [];
		const dropIntent = this.takeDrop(prev, read.snapshot);
		// A fresh drop (taken only when the layout changed after it) wins over our own last ops' txnId,
		// whose only job is to ignore stale intents.
		const ctx: ReconcileContext = dropIntent !== undefined ? { dropIntent } : this.txnId !== null ? { txnId: this.txnId } : {};
		try {
			const result = reconcile(prev, read.snapshot, this.state, ctx);
			if (this.trace !== null) {
				this.trace.push({ at: performance.now(), triggers, prev, next: read.snapshot, before, ctx, after: result.state, ops: result.ops });
				if (this.trace.length > TRACE_LIMIT) this.trace.splice(0, this.trace.length - TRACE_LIMIT);
			}
			this.state = result.state;
			this.unmatched = [...dropRevived(this.unmatched, this.state)];
			ops = result.ops;
			events = result.events;
		} catch (e) {
			console.error('Tabstrip: could not reconcile the tab groups', e);
		}
		this.prev = read.snapshot;
		this.txnId = null;
		this.stats.passes++;

		let finalRead = read;
		const applicable = this.features?.moves === true ? ops : ops.filter((op) => op.kind !== 'move');
		if (applicable.length > 0) {
			this.streak++;
			if (this.streak > LOOP_LIMIT) {
				this.stats.loopStops++;
				debugLog('loop guard: ops not applied', applicable);
			} else {
				this.applyOps(applicable, read);
				finalRead = this.adapter.read();
			}
		} else {
			this.streak = 0;
		}
		this.stats.opsSkipped += ops.length - applicable.length;
		this.notifyPinnedOut(events, before);
		this.render(finalRead);
		this.record(triggers, started, applicable.length, read);
	}

	// ---------------------------------------------------------------- drag and drop (step L7)

	/** The group the dragged tab ends up in if dropped at `target` (the highlight). */
	private predictDrop(target: DropTarget): string | null {
		const read = this.read;
		if (read === null || !this.running) return null;
		try {
			return predictDrop(this.state, read.snapshot, target).groupId;
		} catch (e) {
			console.error('Tabstrip: could not predict the drop', e);
			return null;
		}
	}

	/**
	 * A dragged tab was released over a strip: keep the drop intent for the pass that follows. A drop
	 * that Obsidian does not move is not kept (an unrelated layout change must never apply it); what
	 * the rules still do for it (dropInPlace) is carried out by the plugin once Obsidian is done with
	 * the drop.
	 */
	private onDrop(target: DropTarget, read: WorkspaceRead | null = this.read, via?: DropRecord['via'], noop = false): DropRecord | null {
		if (read === null || !this.running) return null;
		if (this.pendingDrop !== null) this.pendingDrop.fate = 'expired';
		this.pendingDrop = null;
		const moves = !noop && landing(this.state, read.snapshot, target) !== null;
		const record: DropRecord = { target, intent: dropIntentOf(this.state, read.snapshot, target), at: performance.now(), fate: moves ? 'pending' : 'noop' };
		if (via !== undefined) record.via = via;
		if (moves) this.pendingDrop = record;
		else this.afterDrop(record);
		this.stats.drops.push(record);
		if (this.stats.drops.length > DROP_LIMIT) this.stats.drops.splice(0, this.stats.drops.length - DROP_LIMIT);
		debugLog('drop', record);
		return record;
	}

	// ---------------------------------------------------------------- drag in the vertical strip (step V5)

	/**
	 * A row of the vertical strip starts being dragged: Obsidian's own tab drag starts for its leaf
	 * (whitelisted `workspace.onDragLeaf`, through the adapter), and the L7 watcher learns the dragged
	 * tab (a drop on a pop-out's horizontal strip follows the L7 rules). Null: no drag.
	 */
	private startStripDrag(leafId: string, row: HTMLElement, evt: DragEvent): 'native' | 'missing' | 'threw' | null {
		if (!this.running || this.native || this.features?.groups !== true) return null;
		const read = this.read ?? this.adapter.read();
		const found = this.findLeaf(read, leafId);
		if (found === null) return null;
		const how = this.adapter.dragLeaf(evt, found.leaf.leaf);
		this.drag.begin(leafId, row, evt);
		debugLog('strip drag', { leafId, how });
		return how;
	}

	/** The highlight while dragging over the vertical strip: the group the tab would end up in, and whether the drop changes anything. */
	private predictStripDrop(target: DropTarget): { groupId: string | null; changes: boolean } {
		const read = this.read;
		if (read === null || !this.running) return { groupId: null, changes: false };
		try {
			const prediction = predictDrop(this.state, read.snapshot, target);
			const before = this.state.members.find((m) => m.leafId === target.leafId)?.groupId ?? null;
			return { groupId: prediction.groupId, changes: prediction.moves || prediction.groupId !== before };
		} catch (e) {
			console.error('Tabstrip: could not predict the drop', e);
			return { groupId: null, changes: false };
		}
	}

	/**
	 * A drop on the vertical strip (after Obsidian's own drop handling and the dragend), or a keyboard
	 * move: the same rules as a drop on a horizontal strip. The drop is recorded like Obsidian's
	 * (DropRecord); where Obsidian would move the tab, the plugin moves it with the native move recipe
	 * (also into another pane of the root split), and the pass that follows uses the drop intent.
	 * A drop that moves nothing goes to the in-place rules (afterDrop).
	 */
	private applyStripDrop(target: DropTarget, via: 'vertical' | 'keyboard'): void {
		if (!this.running || this.native || this.features?.groups !== true) return;
		// Everything Obsidian did before (a deferred tab loaded by the drag) is reconciled first.
		this.flush();
		const read = this.adapter.read();
		let index = landing(this.state, read.snapshot, target);
		if (index !== null) {
			// A drop the rules put straight back (the tab right after a collapsed group, released on its
			// chip) changes nothing: no native moves that cancel out, recorded as a no-op (V5 review round 1).
			const prediction = predictDrop(this.state, read.snapshot, target);
			const before = this.state.members.find((m) => m.leafId === target.leafId)?.groupId ?? null;
			if (!prediction.moves && prediction.groupId === before) index = null;
		}
		const record = this.onDrop(target, read, via, index === null);
		if (record === null || index === null) return;
		const moved = this.features.moves ? this.adapter.moveTab(target.leafId, target.paneId, index, read, via === 'vertical') : 'refused';
		if (moved === 'moved') {
			this.pass(['drop']);
			return;
		}
		// A step of the native recipe threw: the tab was put back where it was (adapter carryOut).
		if (moved === 'failed') {
			this.notify(this.t.t('notice.moveFailed'));
			this.schedule('drop');
		}
		record.moveFailed = true;
		record.fate = 'cancelled';
		if (this.pendingDrop === record) this.pendingDrop = null;
	}

	/** Moves a tab one row up (-1) or down (+1) in its strip, with the drag rules (core stepTarget). */
	moveTabStep(leafId: string, dir: -1 | 1): boolean {
		if (!this.running || this.native || this.features?.groups !== true) return false;
		this.flush();
		const read = this.adapter.read();
		const target = stepTarget(this.state, read.snapshot, leafId, dir);
		if (target === null) return false;
		this.applyStripDrop(target, 'keyboard');
		return true;
	}

	/**
	 * The rules for a drop Obsidian does not move (core dropInPlace: rule 4 on a collapsed chip, rule 2
	 * join or rules 2-3 leave in place): after Obsidian's own drop handling, from a fresh read, through
	 * run() (render, requestSave). Nothing happens when the rules change nothing.
	 */
	private afterDrop(record: DropRecord): void {
		window.setTimeout(() => {
			if (!this.running) return;
			const read = this.adapter.read();
			const found = dropInPlace(this.state, read.snapshot, record.target);
			if (found === null || (found.ops.length === 0 && found.state === this.state)) return;
			const result = this.run((state, fresh) => dropInPlace(state, fresh.snapshot, record.target) ?? { state, ops: [] });
			if (result === null) return;
			if (result.ops.length > 0) record.afterCollapsed = true;
			else record.inPlace = true;
		}, 0);
	}

	/**
	 * The drop intent for this pass: only when the dragged tab moved within DROP_TTL_MS of the
	 * drop. It is used once; an old one, or one whose tab did not move although the layout changed,
	 * is dropped.
	 */
	private takeDrop(prev: Snapshot, next: Snapshot): DropIntent | undefined {
		const record = this.pendingDrop;
		if (record === null) return undefined;
		const use = dropUse(performance.now() - record.at, prev, next, record.target.leafId, layoutChanged(prev, next));
		if (use === 'wait') return undefined;
		this.pendingDrop = null;
		if (use !== 'use') {
			record.fate = use;
			return undefined;
		}
		record.fate = 'used';
		return record.intent;
	}

	/** Tracing of reconcile inputs and outputs (tests only): on clears and starts it, off returns it. */
	setTrace(on: boolean): PassTrace[] {
		const out = this.trace ?? [];
		this.trace = on ? [] : null;
		return out;
	}

	get dragTimings(): { eventMs: number[]; frameMs: number[] } {
		return this.drag.timings;
	}

	private applyOps(ops: readonly Op[], read: WorkspaceRead): void {
		this.txnId = `t${String(++this.txnSeq)}`;
		const opsStarted = performance.now();
		const result = this.adapter.applyOps(ops, read, { focus: this.activateFocus });
		this.opsMs += performance.now() - opsStarted;
		this.stats.opsApplied += result.applied;
		this.stats.opsSkipped += result.skipped;
	}

	private record(triggers: readonly Trigger[], started: number, ops: number, read: WorkspaceRead): void {
		const leaves = read.strips.reduce((n, s) => n + s.leaves.length, 0);
		this.stats.timings.push({ triggers, ms: performance.now() - started, opsMs: this.opsMs, renderMs: this.renderMs, layoutMs: this.layoutMs, ops, leaves });
		if (this.stats.timings.length > TIMING_LIMIT) this.stats.timings.splice(0, this.stats.timings.length - TIMING_LIMIT);
	}

	private render(read: WorkspaceRead): void {
		const renderStarted = performance.now();
		try {
			this.draw(read);
		} finally {
			this.renderMs += performance.now() - renderStarted;
		}
	}

	private draw(read: WorkspaceRead): void {
		this.read = read;
		this.requestSave();
		const headerToLeaf = new Map<HTMLElement, string>();
		for (const strip of read.strips) for (const leaf of strip.leaves) if (leaf.header !== null) headerToLeaf.set(leaf.header, leaf.id);
		this.headerToLeaf = headerToLeaf;
		this.watchPins(read);
		if (this.native) return;
		this.watchDocuments(read);
		if (this.features?.decorate === true) {
			// Review round 3: while the vertical strip shows the root split's tabs, their native headers
			// are hidden, so they carry no chips or lines: measuring hidden chips (chip ink probes, widths)
			// cost up to 20 ms per pass at 50 tabs. Pop-out windows keep their decorated horizontal bar.
			// Switching back to horizontal decorates the main headers again.
			const decorated = this.vstrip.mounted ? read.strips.filter((strip) => strip.kind !== 'main') : read.strips;
			this.decorator.render(decorated, planDecorations(decorated, this.state));
			this.drag.watch(read.strips);
			this.layoutMs += this.decorator.lastReadMs;
			this.retryInk();
		}
		this.renderStrip(read);
		this.syncEditor();
	}

	/**
	 * A window whose styles were not ready (a pop-out that has just opened) shows the fallback
	 * chip text colour; look again shortly, until its styles apply (at most about 5 s).
	 */
	private retryInk(): void {
		if (!this.ink.takePending()) {
			this.inkRetries = 0;
			return;
		}
		if (this.inkTimer !== null || this.inkRetries >= INK_RETRIES) return;
		this.inkRetries++;
		this.inkTimer = window.setTimeout(() => {
			this.inkTimer = null;
			this.schedule('ink');
		}, INK_RETRY_MS);
	}

	/** Pinning fires no layout-change; every root leaf reports it with its own public 'pinned-change'. */
	private watchPins(read: WorkspaceRead): void {
		const live = new Set<object>();
		for (const strip of read.strips) {
			for (const { leaf } of strip.leaves) {
				live.add(leaf);
				if (this.pinRefs.has(leaf)) continue;
				const ref = (leaf as WorkspaceLeaf).on('pinned-change', () => {
					this.schedule('pin');
				});
				this.pinRefs.set(leaf, ref);
			}
		}
		for (const [leaf, ref] of this.pinRefs) {
			if (live.has(leaf)) continue;
			(leaf as WorkspaceLeaf).offref(ref);
			this.pinRefs.delete(leaf);
		}
	}

	/** One capture-phase contextmenu listener per window that has root tab strips. */
	private watchDocuments(read: WorkspaceRead): void {
		if (this.features?.tabMenu !== true) return;
		const live = new Set<Document>();
		for (const strip of read.strips) {
			const doc = strip.doc;
			if (doc === null) continue;
			live.add(doc);
			if (this.docListeners.has(doc)) continue;
			const listener = (evt: MouseEvent) => {
				this.onTabContextMenu(evt);
			};
			doc.addEventListener('contextmenu', listener, true);
			this.docListeners.set(doc, () => {
				doc.removeEventListener('contextmenu', listener, true);
			});
		}
		for (const [doc, remove] of this.docListeners) {
			if (live.has(doc)) continue;
			remove();
			this.docListeners.delete(doc);
		}
	}

	private notifyPinnedOut(events: readonly ModelEvent[], before: GroupState): void {
		const labels: string[] = [];
		for (const e of events) {
			const group = before.groups.find((g) => g.id === e.groupId);
			const label = this.t.groupLabel(e.groupName, group?.color ?? 'grey');
			if (!labels.includes(label)) labels.push(label);
		}
		if (labels.length === 0) return;
		this.notify(this.t.t('notice.pinnedOut', { labels: labels.join(this.t.locale === 'zh' ? '、' : ', ') }));
	}

	// ---------------------------------------------------------------- queries

	private group(groupId: string): Group | undefined {
		return this.state.groups.find((g) => g.id === groupId);
	}

	private groupOfLeaf(leafId: string): Group | undefined {
		const m = this.state.members.find((x) => x.leafId === leafId);
		return m === undefined ? undefined : this.group(m.groupId);
	}

	private findLeaf(read: WorkspaceRead, leafId: string): { strip: StripRead; leaf: LeafRead; index: number } | null {
		for (const strip of read.strips) {
			const index = strip.leaves.findIndex((l) => l.id === leafId);
			const leaf = strip.leaves[index];
			if (leaf !== undefined) return { strip, leaf, index };
		}
		return null;
	}

	/** The active tab when it is a main-area or pop-out tab (never a sidebar leaf). */
	activeRootLeaf(): { id: string; pinned: boolean; group: Group | undefined } | null {
		if (!this.running || this.features?.groups !== true) return null;
		this.flush();
		const read = this.adapter.read();
		const id = read.snapshot.activeLeafId;
		if (id === null) return null;
		const found = this.findLeaf(read, id);
		if (found === null) return null;
		return { id, pinned: found.leaf.info.pinned, group: this.groupOfLeaf(id) };
	}

	get enabledFeatures(): Features | null {
		return this.features;
	}

	// ---------------------------------------------------------------- commands

	/**
	 * Runs a model command on a fresh, reconciled snapshot, carries out its ops and renders.
	 * A command that needs to reorder tabs is refused when the move recipe is unavailable.
	 */
	private run<T extends CommandResult>(command: (state: GroupState, read: WorkspaceRead) => T): T | null {
		if (!this.running || this.features?.groups !== true) return null;
		const started = performance.now();
		this.flush();
		this.pass(['command']);
		const passOpsMs = this.opsMs;
		const read = this.adapter.read();
		let result: T;
		try {
			result = command(this.state, read);
		} catch (e) {
			console.error('Tabstrip: group command failed', e);
			return null;
		}
		if (!this.features.moves && result.ops.some((op) => op.kind === 'move')) return null;
		this.stats.commands++;
		this.state = result.state;
		this.prev = read.snapshot;
		this.opsMs = passOpsMs;
		if (result.ops.length > 0) this.applyOps(result.ops, read);
		this.render(result.ops.length > 0 ? this.adapter.read() : read);
		this.record(['run'], started, result.ops.length, read);
		return result;
	}

	/** New group from one tab, with Chrome's colour choice; opens the editor bubble. */
	addToNewGroup(leafId: string): string | null {
		const groupId = this.createGroupOf([leafId], '');
		if (groupId !== null) this.openEditor(groupId);
		return groupId;
	}

	/**
	 * New group from tabs of one strip. Without a colour: the least used colour in that window,
	 * ties in Chrome's order.
	 */
	createGroupOf(leafIds: readonly string[], name: string, color?: GroupColor): string | null {
		const result = this.run((state, read) => {
			const found = this.findLeaf(read, leafIds[0] ?? '');
			const panes = found === null ? new Set<string>() : panesInWindowOf(read, found.strip.paneId);
			return createGroup(state, read.snapshot, leafIds, { name, color: color ?? colorForNewGroup(state, read.snapshot, panes) });
		});
		return result?.groupId ?? null;
	}

	addToGroup(leafId: string, groupId: string): void {
		this.run((state, read) => addToGroup(state, read.snapshot, [leafId], groupId));
	}

	removeFromGroup(leafId: string): void {
		this.run((state, read) => removeFromGroup(state, read.snapshot, [leafId]));
	}

	rename(groupId: string, name: string): void {
		this.run((state) => renameGroup(state, groupId, name));
	}

	recolor(groupId: string, color: GroupColor): void {
		this.run((state) => recolorGroup(state, groupId, color));
	}

	ungroup(groupId: string): void {
		this.run((state) => ungroup(state, groupId));
	}

	closeGroup(groupId: string): void {
		this.run((state, read) => closeGroup(state, read.snapshot, groupId));
	}

	/**
	 * New tab directly at the end of the group (public createLeafInParent, not getLeaf('tab'),
	 * which Open Tab Settings wraps), made a member.
	 */
	newTabInGroup(groupId: string): string | null {
		if (!this.running || this.features?.newTabInGroup !== true) return null;
		this.flush();
		this.pass(['command']);
		const read = this.adapter.read();
		const members = new Set(this.state.members.filter((m) => m.groupId === groupId).map((m) => m.leafId));
		const strip = read.strips.find((s) => s.leaves.some((l) => members.has(l.id)));
		if (strip === undefined) return null;
		let last = -1;
		strip.leaves.forEach((l, i) => {
			if (members.has(l.id)) last = i;
		});
		const id = this.adapter.createLeafAt(strip.tabs, last + 1);
		if (id === null) return null;
		this.pass(['command']);
		this.run((state, r) => addToGroup(state, r.snapshot, [id], groupId));
		return id;
	}

	// ---------------------------------------------------------------- collapse (step L5)

	/** The strip that holds the group's members, from the last read. */
	private stripOfGroup(read: WorkspaceRead, groupId: string): StripRead | null {
		const members = new Set(this.state.members.filter((m) => m.groupId === groupId).map((m) => m.leafId));
		return read.strips.find((s) => s.leaves.some((l) => members.has(l.id))) ?? null;
	}

	/**
	 * Collapses or expands a group (chip click, Enter / Space on the chip, command). Collapsing the
	 * group that holds its strip's shown tab first shows the nearest visible tab to the right, else
	 * to the left, else a new tab (core `setCollapsed`). In a stacked strip groups cannot collapse:
	 * a notice says so. Returns true when the group changed.
	 */
	setGroupCollapsed(groupId: string, collapsed: boolean): boolean {
		if (!this.running || this.features?.groups !== true || this.native) return false;
		this.flush();
		const group = this.group(groupId);
		if (group === undefined) return false;
		// Checked before "no change": a group collapsed before its pane was stacked is drawn
		// expanded there, and asking to collapse it says why nothing happens.
		if (collapsed) {
			const strip = this.read === null ? null : this.stripOfGroup(this.read, groupId);
			if (strip?.stacked === true) {
				this.notify(this.t.t('notice.stackedNoCollapse'));
				return false;
			}
		}
		if (group.collapsed === collapsed) return false;
		const result = this.run((state, read) => setCollapsed(state, read.snapshot, groupId, collapsed));
		return result !== null && this.group(groupId)?.collapsed === collapsed;
	}

	/**
	 * A click or Enter / Space on the chip. From the keyboard, the focus stays on the chip, like
	 * a button: collapsing the group that holds the shown tab shows a neighbour without focusing
	 * it, so the next key press toggles again instead of typing into the note (L5 review round 2).
	 */
	private toggleFromChip(groupId: string, chip: HTMLElement, keyboard: boolean): void {
		const keepFocus = keyboard && chip.ownerDocument.activeElement === chip;
		if (!keepFocus) {
			this.toggleCollapsed(groupId);
			return;
		}
		this.activateFocus = false;
		try {
			this.toggleCollapsed(groupId);
		} finally {
			this.activateFocus = true;
		}
		// A new tab (the group was the strip's only one) may still take the focus: give it back.
		const target = this.decorator.chipFor(groupId) ?? chip;
		if (target.isConnected && target.ownerDocument.activeElement !== target) target.focus();
	}

	toggleCollapsed(groupId: string): boolean {
		const group = this.group(groupId);
		return group !== undefined && this.setGroupCollapsed(groupId, !group.collapsed);
	}

	/** Collapses every other group in the group's strip (chip menu "Collapse other groups"). */
	collapseOthers(groupId: string): void {
		if (this.native) return;
		this.run((state, read) => collapseOthers(state, read.snapshot, groupId));
	}

	/** "Collapse other groups" in the chip menu: hidden, disabled (all others collapsed) or enabled. */
	private collapseOthersMode(groupId: string): 'enabled' | 'disabled' | 'hidden' {
		const read = this.read;
		const strip = read === null ? null : this.stripOfGroup(read, groupId);
		if (strip === null || strip.stacked) return 'hidden';
		const others = new Set<string>();
		for (const leaf of strip.leaves) {
			const g = this.groupOfLeaf(leaf.id);
			if (g !== undefined && g.id !== groupId) others.add(g.id);
		}
		if (others.size === 0) return 'hidden';
		return [...others].some((id) => this.group(id)?.collapsed === false) ? 'enabled' : 'disabled';
	}

	/**
	 * "Go to next / previous tab (skip collapsed groups)": the next visible tab of the active tab's
	 * strip, wrapping around like the native commands. Activated through the adapter (an
	 * `activate` op). Returns the tab id, or null when there is nowhere to go.
	 */
	stepTab(direction: Direction): string | null {
		const active = this.activeRootLeaf();
		if (active === null || this.native) return null;
		let target: string | null = null;
		this.run((state, read) => {
			target = stepVisible(state, read.snapshot, active.id, direction);
			const ops: Op[] = target === null ? [] : [{ kind: 'activate', leafId: target }];
			return { state, ops };
		});
		return target;
	}

	/** Expands every group (entering "Restore native tab bar": what the model hides must show). */
	private expandAll(): void {
		for (const g of this.state.groups) {
			if (g.collapsed) this.run((state, read) => setCollapsed(state, read.snapshot, g.id, false));
		}
	}

	private notify(text: string): void {
		this.stats.notices.push(text);
		new Notice(text);
	}

	// ---------------------------------------------------------------- editor bubble

	/**
	 * Opens the editor bubble at the group's chip (beside its first tab when the chip is hidden in
	 * a stacked strip). `returnToChip`: the bubble came from the chip's keyboard menu, so the
	 * focus goes back to the chip when it closes; otherwise back to where it was.
	 */
	openEditor(groupId: string, returnToChip = false): boolean {
		if (this.features?.editor !== true || this.native) return false;
		this.flush();
		const group = this.group(groupId);
		// At a row of the vertical strip's icon bar: its overlay opens first (so the bubble sits under
		// the whole group row, not a 48px marker) and stays open until the bubble closes.
		const release = this.vstrip.mounted && this.vstrip.groupRow(groupId) !== null ? this.vstrip.holdPeek() : null;
		const chip = this.anchorOf(groupId);
		if (group === undefined || chip === null || !chip.isConnected) {
			release?.();
			return false;
		}
		const original: EditorTarget = { groupId, name: group.name, color: group.color };
		const shown = this.editor.show(
			chip,
			original,
			{
				preview: (name) => {
					this.rename(groupId, name);
				},
				color: (color) => {
					this.recolor(groupId, color);
				},
				commit: (name) => {
					this.rename(groupId, name);
				},
				cancel: (o) => {
					this.rename(groupId, o.name);
					this.recolor(groupId, o.color);
				},
				focusFallback: () => {
					this.adapter.focusActiveLeaf();
				},
				closed: () => {
					release?.();
				},
			},
			returnToChip ? { returnFocus: () => this.anchorOf(groupId) } : {},
		);
		if (!shown) release?.();
		return shown;
	}

	/**
	 * Where a group's bubble and keyboard menu sit: its row in the vertical strip (V2) when the group is
	 * in the main window's root split and the strip is shown, else its chip.
	 */
	private anchorOf(groupId: string): HTMLElement | null {
		return (this.vstrip.mounted ? this.vstrip.groupRow(groupId) : null) ?? this.decorator.chipFor(groupId);
	}

	get editorGroupId(): string | null {
		return this.editor.groupId;
	}

	/** Closes the bubble when its group is gone or went to another window; otherwise keeps it at its chip. */
	private syncEditor(): void {
		const groupId = this.editor.groupId;
		if (groupId === null) return;
		const chip = this.anchorOf(groupId);
		if (this.group(groupId) === undefined || chip === null || !chip.isConnected || chip.ownerDocument !== this.editor.document) {
			this.editor.close('drop');
			return;
		}
		this.editor.reposition(chip);
	}

	// ---------------------------------------------------------------- menus

	private openChipMenu(groupId: string, chip: HTMLElement, evt: MouseEvent | null): Menu | null {
		this.flush();
		const group = this.group(groupId);
		if (group === undefined || this.features === null) return null;
		const menu = new Menu();
		// The colour items show swatches, which only a DOM menu can draw.
		menu.setUseNativeMenu(false);
		fillChipMenu(
			menu,
			this.t,
			{
				color: group.color,
				newTab: this.features.newTabInGroup,
				rename: this.features.editor,
				collapseOthers: this.collapseOthersMode(groupId),
				swatchTitle: (color) =>
					createFragment((f) => {
						f.createSpan({ cls: 'tabstrip-swatch tabstrip-menu-swatch', attr: { [ATTR.color]: color } });
						f.appendText(this.t.colorName(color));
					}),
			},
			{
				// After the menu has closed, so the menu does not take the focus back from the bubble.
				rename: () => {
					window.setTimeout(() => {
						this.openEditor(groupId, evt === null);
					}, 0);
				},
				recolor: (color) => {
					this.recolor(groupId, color);
				},
				newTab: () => {
					this.newTabInGroup(groupId);
				},
				ungroup: () => {
					this.ungroup(groupId);
				},
				close: () => {
					this.closeGroup(groupId);
				},
				collapseOthers: () => {
					this.collapseOthers(groupId);
				},
			},
		);
		if (evt !== null) {
			menu.showAtMouseEvent(evt);
		} else {
			const rect = chip.getBoundingClientRect();
			menu.showAtPosition({ x: rect.left, y: rect.bottom }, chip.ownerDocument);
		}
		return menu;
	}

	/** Capture phase on each window's document: adds group items to Obsidian's own tab menu. */
	private onTabContextMenu(evt: MouseEvent): void {
		if (!this.running || this.native || this.features?.tabMenu !== true) return;
		const target = evt.target;
		if (!isElementLike(target)) return;
		// Right clicks on a chip open the chip menu instead (decorator).
		if (target.closest(`.${CLS.chip}`) !== null) return;
		const header = target.closest('.workspace-tab-header');
		if (!isElementLike(header)) return;
		this.flush();
		const leafId = this.headerToLeaf.get(header);
		const read = this.read;
		if (leafId === undefined || read === null) return;
		const found = this.findLeaf(read, leafId);
		if (found === null || found.leaf.info.pinned) return;
		const own = this.groupOfLeaf(leafId);
		const others: Group[] = [];
		const seen = new Set<string>();
		for (const leaf of found.strip.leaves) {
			const g = this.groupOfLeaf(leaf.id);
			if (g === undefined || g.id === own?.id || seen.has(g.id)) continue;
			seen.add(g.id);
			others.push(g);
		}
		const menu = Menu.forEvent(evt);
		fillTabMenu(
			menu,
			this.t,
			{ member: own !== undefined, otherGroups: others },
			{
				addToNewGroup: () => {
					this.addToNewGroup(leafId);
				},
				addToGroup: (groupId) => {
					this.addToGroup(leafId, groupId);
				},
				removeFromGroup: () => {
					this.removeFromGroup(leafId);
				},
			},
		);
	}

	// ---------------------------------------------------------------- read-only views for tests

	snapshotState(): GroupState {
		return JSON.parse(JSON.stringify(this.state)) as GroupState;
	}

	get decoratedHeaders(): number {
		return this.decorator.decoratedCount;
	}

	/**
	 * Test-only (step V6): turns the chips' ResizeObservers on or off and returns how many are live.
	 * `on` undefined only reads the count.
	 */
	chipObservers(on?: boolean): number {
		if (on !== undefined) this.decorator.setChipObservers(on);
		return this.decorator.chipObserverCount;
	}
}

const EMPTY_LIST = { sections: [], rows: [] } as const;

/** Some strip appeared, closed, or has other tabs or another order. */
function layoutChanged(prev: Snapshot, next: Snapshot): boolean {
	if (prev.panes.length !== next.panes.length) return true;
	return prev.panes.some((p, i) => {
		const q = next.panes[i];
		return q === undefined || q.id !== p.id || q.leaves.length !== p.leaves.length || q.leaves.some((l, k) => l.id !== p.leaves[k]?.id);
	});
}
