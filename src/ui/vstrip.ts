/**
 * The vertical tab strip (steps V1-V4): a strip of its own at the far left of the main window,
 * mounted INSIDE the window's `.workspace` element as its first child (requirements 7.2: the right
 * sidebar's resize math assumes `.workspace` starts at x = 0, and a sidebar view cannot become an
 * icon bar). The `.workspace` element also gets the class `tabstrip-vertical`, which hides the
 * native tab header rows (and stacked tabs' spines) of the root split (styles.css); the native tab
 * model is never touched.
 *
 * Remounting: Obsidian puts the `.workspace` children back in place whenever it loads a layout
 * (which drops elements it does not know). A MutationObserver on `.workspace` puts the strip and
 * the class back. Its callback runs as a microtask in the same task as the change, so no frame is
 * painted without the strip; it also asks for the rows of the new root split then (V1 review 2).
 *
 * The list (V2) is a tree (V4): a pinned area, then one section per pane (titled when there is more
 * than one pane), group rows with their members, and a "New tab" row per section. Tab rows copy
 * each tab's icon and title from the native tab header (so Iconize icons follow); a second
 * MutationObserver on those headers refreshes a row when its header's title or icon changes.
 * Mouse and keys are handled here and handed to the controller through hooks. One item holds the
 * tab stop (roving tabindex).
 *
 * The icon bar (V3): collapsed, the strip is about 48px wide and shows icons and group markers only.
 * Hovering it (or moving the keyboard focus into it) opens it over the workspace for a moment (an
 * overlay: the strip's own box keeps its width, so nothing reflows), and leaving closes it again
 * after a short delay. Expanded, the edge handle resizes it.
 *
 * Rendering only writes: it never reads layout (no boxes, no sizes). Boxes are read only in event
 * handlers (a resize drag start), before anything is written.
 */
import { Scope, setIcon } from 'obsidian';
import type { DropTarget } from '../core/drag';
import type { GroupColor } from '../core/types';
import type { MessageKey, Translator } from '../i18n';
import { collapsedLineY, vspotAt, vspotKey, type VDropBox, type VDropSpot } from './vdrop';
import { keyAction, rovingIndex, type VKeyItem } from './vkeys';
import { itemKey, type VGroupItem, type VItem, type VListPlan, type VNewItem, type VSection, type VTabItem } from './vplan';

export const VCLS = {
	host: 'tabstrip-vertical',
	strip: 'tabstrip-vstrip',
	panel: 'tabstrip-vstrip-panel',
	header: 'tabstrip-vstrip-header',
	drag: 'tabstrip-vstrip-drag',
	toggle: 'tabstrip-vstrip-toggle',
	collapse: 'tabstrip-vstrip-collapse',
	list: 'tabstrip-vstrip-list',
	section: 'tabstrip-vsection',
	paneTitle: 'tabstrip-vpane-title',
	row: 'tabstrip-vrow',
	icon: 'tabstrip-vrow-icon',
	title: 'tabstrip-vrow-title',
	close: 'tabstrip-vrow-close',
	group: 'tabstrip-vgroup',
	groupArrow: 'tabstrip-vgroup-arrow',
	groupChip: 'tabstrip-vgroup-chip',
	groupLabel: 'tabstrip-vgroup-label',
	groupCount: 'tabstrip-vgroup-count',
	newTab: 'tabstrip-vnew',
	resize: 'tabstrip-vstrip-resize',
	/** Step V5: the drop line, and the rows of the group a dragged tab would join. */
	dropLine: 'tabstrip-vdrop-line',
	dropJoin: 'tabstrip-vdrop-join',
	/** On the dragged row while it is dragged. */
	dragging: 'is-dragging',
	/** On the strip: the icon bar stays open, in place (not over the workspace), during a drag. */
	dragOpen: 'is-drag-open',
	/**
	 * Step V6: on the host (.workspace) while a row is dragged. styles.css then gives the hidden tab
	 * header row of a stacked pane an invisible box again, one header row high at the pane's top (where
	 * the row sits on the horizontal tab bar), so Obsidian's drop code, which allows a left / right
	 * split of a stacked pane only with the pointer inside that row's box, offers the same splits as on
	 * the horizontal tab bar.
	 */
	hostDragging: 'tabstrip-vdragging',
	/**
	 * Step V6 review round 2: on the host while any other drag is open in a watched window (a tab of a
	 * sidebar or a pop-out, a note from the file explorer): the same box for those drags.
	 */
	hostAnyDrag: 'tabstrip-vdrag-any',
} as const;

/** Row attribute holding the leaf id. */
export const VROW_LEAF = 'data-tabstrip-leaf';
/** Item attribute holding the item key (`t:`, `g:`, `n:` + id). */
export const VITEM_KEY = 'data-tabstrip-item';
const NATIVE_TITLE = '.workspace-tab-header-inner-title';
const NATIVE_ICON = '.workspace-tab-header-inner-icon';
const TIMING_LIMIT = 200;
const ITEM_SELECTOR = `[${VITEM_KEY}]`;
/** Hover on the icon bar this long before it opens as an overlay; it closes this long after leaving. */
export const PEEK_OPEN_MS = 150;
export const PEEK_CLOSE_MS = 350;
/** Delete: the focus comes back to the tree this long after the close (Obsidian moves it on first). */
const REFOCUS_MS = 50;
/** A contextmenu event this soon after a menu key belongs to that key press. */
const KEY_MENU_MS = 500;
/** Keyboard resize step on the edge handle, px. */
const RESIZE_STEP = 16;

export interface VStripHooks {
	/** Single click on a tab row, or Enter / Space on it. */
	activate(leafId: string): void;
	toggleSidebar(side: 'left' | 'right'): void;
	/** Middle click, the row's close button, or Delete. */
	close?(leafId: string): void;
	/** Right click (`evt`) or Shift+F10 / the context-menu key (`evt` null) on a tab row. */
	tabMenu?(leafId: string, row: HTMLElement, evt: MouseEvent | null): void;
	/** The same on a group row. */
	groupMenu?(groupId: string, row: HTMLElement, evt: MouseEvent | null): void;
	/**
	 * Click on a group row, or Enter / Space / Arrow Left / Right on it. `collapse`: the state asked
	 * for, from the row as drawn (not a blind toggle of the model).
	 */
	toggleGroup?(groupId: string, keyboard: boolean, collapse: boolean): void;
	/** F2 on a group row (or on a member: its group). */
	renameGroup?(groupId: string): void;
	/** The "New tab" row of a pane. */
	newTab?(paneId: string): void;
	/** The header button: collapse to the icon bar, or expand. */
	toggleCollapsed?(): void;
	/** The edge handle was dragged (or moved with the keyboard) to this width. */
	widthChanged?(width: number): void;
	/**
	 * Step V4: Obsidian's key scopes. While the tree has the focus a scope of ours is pushed, so its
	 * keys reach the tree before Obsidian's hotkeys (which run at the window, first).
	 */
	keyScopes?(): { parent: Scope; push(scope: Scope): void; pop(scope: Scope): void };
	/** A mount that waited for the plugin's stylesheet has just happened. */
	mounted?(): void;
	/**
	 * Step V5: a tab row starts being dragged. The caller starts Obsidian's own tab drag for it
	 * (whitelisted `workspace.onDragLeaf`) and says how that went ('native'; 'missing' / 'threw':
	 * the drag then works inside the strip only), or null when no drag may start.
	 */
	dragStart?(leafId: string, row: HTMLElement, evt: DragEvent): 'native' | 'missing' | 'threw' | null;
	/** The group the dragged tab would be in if dropped at `target`, and whether the drop changes anything. */
	dragPredict?(target: DropTarget): { readonly groupId: string | null; readonly changes: boolean };
	/** The dragged tab was released on the strip at `target`; runs after the drag ended (dragend). */
	dragDrop?(target: DropTarget): void;
	/** A drag that started in the strip is over (dropped anywhere, or cancelled). */
	dragEnd?(): void;
	/** Step V5: Alt+Arrow Up / Down on a tab row: move the tab one row (the keyboard's drag). */
	moveTab?(leafId: string, dir: -1 | 1): void;
	/**
	 * V1 review round 2: the host's children changed (a layout load or clear swapped the root split).
	 * Runs in the observer's microtask, before the next paint: the caller draws the rows now, so no
	 * frame shows the rows of the old layout.
	 */
	hostChanged?(): void;
	/**
	 * V1 review round 2: a tab header was added to or removed from one of the root split's tab header
	 * rows (a tab opened, closed or moved). Runs before the next paint, like hostChanged.
	 */
	tabsChanged?(): void;
}

export interface VStripStats {
	renders: number;
	/** Plugin time per render (ms). */
	renderMs: number[];
	/** Plugin time per header-change refresh (ms). */
	refreshMs: number[];
	/**
	 * Review round 3: strip updates outside a pass (a tab opened, closed or moved, a layout load, a
	 * mount): the whole plugin time of each, read + plan + render (ms). Updates inside a pass are
	 * timed by the pass itself (controller stats.timings).
	 */
	updateMs: number[];
	/** Count of those updates (updateMs keeps the last ones only). */
	updates: number;
	/** Times the strip or the host class had to be put back. */
	remounts: number;
	/** Why: 'strip' (the strip was removed from .workspace), 'class' (the host class was removed). */
	remountLog: { at: number; what: 'strip' | 'class' }[];
	/** Rows whose title or icon was copied again after their native header changed. */
	headerRefreshes: number;
	/** Frames each mount waited for the plugin's stylesheet (only mounts that had to wait). */
	styleWaits: number[];
	/** Step V3: times the icon bar opened as an overlay. */
	peeks: number;
	/** Step V5: drags started from a row, by what Obsidian's onDragLeaf did. */
	drags: { native: number; missing: number; threw: number };
	/** Step V5: drops on the strip handed to the controller. */
	drops: number;
	/** Step V5: plugin time per drag event over the window while a row is dragged (ms). */
	dragEventMs: number[];
	/** Step V5: plugin time per frame that measured, worked out the spot and painted (ms). */
	dragFrameMs: number[];
	/** Step V5: renders held back while a row was dragged (drawn once the drag ended). */
	heldRenders: number;
	/** Step V6: animation frames that ran the drag's frame work (at most one per browser frame). */
	dragFrames: number;
	/** Step V6: times the drop line and highlight were painted (only inside a drag frame). */
	dragPaints: number;
	/** Step V6: paints outside a drag frame (must stay 0). */
	dragPaintsOffFrame: number;
	/** Step V6: drag frames that ran in the same browser frame as the one before (must stay 0). */
	dragFramesSameFrame: number;
	/** Step V6: paints made only because the list scrolled under an unchanged spot. */
	dragScrollRepaints: number;
}

/** The look of the strip on this device (step V3). */
export interface VStripLook {
	readonly collapsed: boolean;
	/** Expanded width, CSS px. */
	readonly width: number;
	readonly minWidth: number;
	readonly maxWidth: number;
}

/** Inks of the group colours in the strip's window (the chip text colour, src/ui/ink.ts). */
export type InkOf = (color: GroupColor) => string | null;

interface ItemEls {
	readonly el: HTMLElement;
	readonly kind: VItem['kind'];
	/** Item key (`t:` / `g:` / `n:` + id). */
	readonly id: string;
	/** Marks last written (itemKey), to skip unchanged writes. */
	marks: string;
	item: VItem | null;
	tabindex: string;
}

interface RowEls extends ItemEls {
	readonly icon: HTMLElement;
	readonly title: HTMLElement;
	titleText: string | null;
	/** Deep copy of the native icon element last copied, to see whether it changed. */
	iconCopy: Node | null;
	header: HTMLElement | null;
}

interface GroupEls extends ItemEls {
	readonly arrow: HTMLElement;
	readonly chip: HTMLElement;
	readonly label: HTMLElement;
	readonly count: HTMLElement;
	collapsedIcon: boolean | null;
}

interface SectionEls {
	readonly el: HTMLElement;
	readonly title: HTMLElement;
	marks: string;
}

/** Step V5: a row being dragged. */
interface VDrag {
	readonly leafId: string;
	readonly row: HTMLElement;
	readonly m: Mounted;
	/** Removes the window, list and row listeners of this drag. */
	off: () => void;
	/** Shown rows measured for this drag (rows do not move during a drag; again after a scroll). */
	boxes: VDropBox[] | null;
	/** The strip's top and the list's box, measured with the rows. */
	rootTop: number;
	listTop: number;
	listBottom: number;
	/** The pointer's height while it is over the list, else null. */
	y: number | null;
	frame: number | null;
	/** The spot last painted (vspotKey). */
	key: string;
	/**
	 * Step V6: the list scrolled since the last paint, so the rows (and the line drawn at one of them)
	 * moved even when the spot did not: the next frame paints again.
	 */
	scrolled: boolean;
	/** Step V6: the timestamp of the browser frame that last ran this drag's frame work. */
	frameAt: number;
	/** Where the tab was released on the strip, once it was. */
	drop: DropTarget | null;
	/** Ends the drag if no dragend comes after a drop (the source row's dragend is the normal end). */
	dropTimer: number | null;
	line: HTMLElement | null;
	painted: HTMLElement[];
	/** The dragged tab is pinned (its drop spot is aimed where pinned tabs land; vspotAt). */
	readonly pinned: boolean;
}

/** After a drop on the strip, the drag ends this long later at the latest (no dragend seen). */
const DROP_END_MS = 1000;
const DRAG_TIMING_LIMIT = 2000;

/** Files dragged in from outside (or along): never a tab drag. */
function carriesFiles(e: DragEvent): boolean {
	const types = e.dataTransfer?.types;
	return types !== undefined && Array.from(types).includes('Files');
}

interface Mounted {
	readonly host: HTMLElement;
	readonly root: HTMLElement;
	readonly list: HTMLElement;
	readonly collapseButton: HTMLElement;
	readonly handle: HTMLElement;
	readonly hostObserver: MutationObserver;
	readonly headerObserver: MutationObserver;
	/** Watches the root split's tab header rows for headers coming and going. */
	readonly paneObserver: MutationObserver;
	readonly win: Window;
}

/** Custom property set on <body> by styles.css: present once the plugin's stylesheet is applied. */
export const STYLES_MARKER = '--tabstrip-styles';
/** Frames to wait for the stylesheet before giving up (the native tab bar then stays). */
const STYLES_WAIT_FRAMES = 600;

/**
 * Whether the plugin's stylesheet is applied in `doc`. A style read (no layout). Without
 * getComputedStyle (unit tests' fake DOM) the styles count as applied.
 */
export function stylesApplied(doc: Document): boolean {
	const win = doc.defaultView;
	if (!win || typeof win.getComputedStyle !== 'function') return true;
	return win.getComputedStyle(doc.body).getPropertyValue(STYLES_MARKER).trim() !== '';
}

interface Pending {
	readonly host: HTMLElement;
	readonly win: Window;
	frame: number;
	waited: number;
}

/** Native elements whose coming and going changes the root split's tab list: a tab header, a pane, a split. */
const PANE_PARTS = ['workspace-tab-header', 'workspace-tabs', 'workspace-split'];

/**
 * A mutation that adds or removes a native tab header, a pane or a split (not a title or icon
 * change inside a header).
 */
export function movesHeader(record: Pick<MutationRecord, 'addedNodes' | 'removedNodes'>): boolean {
	const isHeader = (n: Node): boolean => {
		const list = (n as Partial<Element>).classList;
		return list !== undefined && PANE_PARTS.some((c) => list.contains(c));
	};
	return Array.from(record.addedNodes).some(isHeader) || Array.from(record.removedNodes).some(isHeader);
}

function sameElements(a: readonly HTMLElement[], b: readonly HTMLElement[]): boolean {
	return a.length === b.length && a.every((el, i) => el === b[i]);
}

/** Sets an attribute only when it differs (no needless DOM writes). */
function setAttr(el: HTMLElement, name: string, value: string | null): void {
	if (value === null) {
		if (el.getAttribute(name) !== null) el.removeAttribute(name);
	} else if (el.getAttribute(name) !== value) {
		el.setAttribute(name, value);
	}
}

/** Custom properties only (never a literal style); skipped where the element has no setCssProps (fake DOM). */
function setCss(el: HTMLElement, props: Record<string, string>): void {
	const target = el as Partial<Pick<HTMLElement, 'setCssProps'>>;
	if (typeof target.setCssProps === 'function') target.setCssProps(props);
}

function toggleCls(el: HTMLElement, cls: string, on: boolean): void {
	if (on) el.classList.add(cls);
	else el.classList.remove(cls);
}

export class VerticalStrip {
	private m: Mounted | null = null;
	/**
	 * Enabling the plugin while Obsidian runs: Obsidian applies styles.css a little after onload.
	 * Mounting before that would paint the unstyled strip next to the still visible native tab rows,
	 * so mount() waits (one check per frame, before paint) until the stylesheet is applied.
	 */
	private pending: Pending | null = null;
	private readonly items = new Map<string, ItemEls>();
	private readonly sections = new Map<string, SectionEls>();
	private readonly byHeader = new Map<HTMLElement, string>();
	/** Shown items in list order (keyboard navigation). */
	private order: ItemEls[] = [];
	/** The item holding the tab stop, and where it was. */
	private focusKey: string | null = null;
	private focusIndex = -1;
	private look: VStripLook = { collapsed: false, width: 240, minWidth: 180, maxWidth: 480 };
	private peekTimer: number | null = null;
	private peeking = false;
	/** Some drag is open in a window of the app (Step V6 review round 2), see setAnyDrag. */
	private anyDrag = false;
	private hovered = false;
	/**
	 * The last input was the pointer (a press anywhere in the window), not a key in the strip or Tab.
	 * Focus in the strip then does not keep the overlay open once the pointer leaves (a click on a
	 * row or a header button focuses it); focus from the keyboard does.
	 */
	private pointerFocus = false;
	/** Removes the window-level input listeners added by wire(). */
	private offDoc: (() => void) | null = null;
	/** Menus and bubbles opened from the strip that keep the overlay open while they are shown. */
	private holds = 0;
	/** Elements the observers watch now (re-observed only when these change). */
	private observedHeaders: readonly HTMLElement[] = [];
	private observedPanes: readonly HTMLElement[] = [];
	private observedRows = 0;
	/** When a menu key last opened a menu (the system may follow it with a contextmenu event). */
	private keyMenuAt = -Infinity;
	/** The key scope pushed while the tree has the focus, and how to pop it. */
	private keyScope: { scope: Scope; pop(): void } | null = null;
	/** Step V5: the drag of a row, while it lasts. */
	private vdrag: VDrag | null = null;
	/** Step V6: a drag frame is painting now (paints anywhere else are counted as off-frame). */
	private inFrame = false;
	/** Step V5: the latest render asked for during a drag (drawn when it ends). */
	private heldRender: Parameters<VerticalStrip['render']> | null = null;
	readonly stats: VStripStats = {
		renders: 0,
		renderMs: [],
		refreshMs: [],
		updates: 0,
		updateMs: [],
		remounts: 0,
		remountLog: [],
		headerRefreshes: 0,
		styleWaits: [],
		peeks: 0,
		drags: { native: 0, missing: 0, threw: 0 },
		drops: 0,
		dragEventMs: [],
		dragFrameMs: [],
		heldRenders: 0,
		dragFrames: 0,
		dragPaints: 0,
		dragPaintsOffFrame: 0,
		dragFramesSameFrame: 0,
		dragScrollRepaints: 0,
	};

	constructor(
		private readonly t: Translator,
		private readonly hooks: VStripHooks,
	) {}

	get mounted(): boolean {
		return this.m !== null;
	}

	/** The strip element (tests, placement), or null when not mounted. */
	get element(): HTMLElement | null {
		return this.m?.root ?? null;
	}

	/** Whether a mount is waiting for the plugin's stylesheet. */
	get waiting(): boolean {
		return this.pending !== null;
	}

	/** Whether the icon bar is open as an overlay now. */
	get peeked(): boolean {
		return this.peeking;
	}

	/** The row of a group (the editor bubble's anchor), or null. */
	groupRow(groupId: string): HTMLElement | null {
		const els = this.items.get(`g:${groupId}`);
		return els !== undefined && els.el.isConnected ? els.el : null;
	}

	/**
	 * Mounts the (empty) strip into `host` (the window's `.workspace`). Idempotent. When the plugin's
	 * stylesheet is not applied yet, the mount happens in the first frame where it is, and
	 * `hooks.mounted` runs then (the caller draws the rows).
	 */
	mount(host: HTMLElement): void {
		if (this.m !== null && this.m.host === host) return;
		if (this.pending !== null && this.pending.host === host) return;
		this.unmount();
		const doc = host.ownerDocument;
		if (stylesApplied(doc)) {
			this.mountNow(host);
			return;
		}
		const win = doc.defaultView ?? window;
		const p: Pending = { host, win, frame: 0, waited: 0 };
		const check = () => {
			if (this.pending !== p) return;
			p.waited++;
			if (stylesApplied(doc)) {
				this.pending = null;
				this.stats.styleWaits.push(p.waited);
				if (this.stats.styleWaits.length > TIMING_LIMIT) this.stats.styleWaits.shift();
				this.mountNow(host);
				this.hooks.mounted?.();
			} else if (p.waited >= STYLES_WAIT_FRAMES) {
				this.pending = null;
				console.warn('Tabstrip: the plugin stylesheet did not load; the native tab bar stays');
			} else {
				p.frame = win.requestAnimationFrame(check);
			}
		};
		this.pending = p;
		p.frame = win.requestAnimationFrame(check);
	}

	private mountNow(host: HTMLElement): void {
		const doc = host.ownerDocument;
		const win = doc.defaultView ?? window;
		const root = doc.createElement('div');
		root.className = VCLS.strip;
		root.setAttribute('role', 'navigation');
		root.setAttribute('aria-label', this.t.t('vstrip.label'));
		const panel = root.appendChild(doc.createElement('div'));
		panel.className = VCLS.panel;
		const header = panel.appendChild(doc.createElement('div'));
		header.className = VCLS.header;
		header.appendChild(
			this.button(doc, `${VCLS.toggle} mod-left`, 'vstrip.toggleLeft', 'panel-left', () => {
				this.hooks.toggleSidebar('left');
			}),
		);
		header.appendChild(doc.createElement('div')).className = VCLS.drag;
		const collapseButton = header.appendChild(
			this.button(doc, VCLS.collapse, 'vstrip.collapse', 'chevrons-left', () => {
				this.hooks.toggleCollapsed?.();
			}),
		);
		header.appendChild(
			this.button(doc, `${VCLS.toggle} mod-right`, 'vstrip.toggleRight', 'panel-right', () => {
				this.hooks.toggleSidebar('right');
			}),
		);
		const list = panel.appendChild(doc.createElement('div'));
		list.className = VCLS.list;
		list.setAttribute('role', 'tree');
		list.setAttribute('aria-label', this.t.t('vstrip.treeLabel'));
		const handle = root.appendChild(doc.createElement('div'));
		handle.className = VCLS.resize;
		handle.setAttribute('role', 'separator');
		handle.setAttribute('aria-orientation', 'vertical');
		handle.setAttribute('tabindex', '0');
		handle.setAttribute('aria-label', this.t.t('vstrip.resize'));

		const hostObserver = new win.MutationObserver((records) => {
			this.ensure();
			if (this.m !== null && records.some((r) => r.type === 'childList')) this.hooks.hostChanged?.();
		});
		const headerObserver = new win.MutationObserver((records) => {
			this.onHeaderMutations(records);
		});
		const paneObserver = new win.MutationObserver((records) => {
			if (this.m !== null && records.some(movesHeader)) this.hooks.tabsChanged?.();
		});
		const m: Mounted = { host, root, list, collapseButton, handle, hostObserver, headerObserver, paneObserver, win };
		this.m = m;
		this.wire(m);
		this.applyLook();
		host.prepend(root);
		host.classList.add(VCLS.host);
		if (this.anyDrag) host.classList.add(VCLS.hostAnyDrag);
		hostObserver.observe(host, { childList: true, attributes: true, attributeFilter: ['class'] });
	}

	/** Removes the strip, the host class and every observer: nothing is left behind. */
	unmount(): void {
		const p = this.pending;
		if (p !== null) {
			this.pending = null;
			p.win.cancelAnimationFrame(p.frame);
		}
		const m = this.m;
		if (m === null) return;
		this.endDrag(null);
		this.heldRender = null;
		this.m = null;
		this.clearPeekTimer(m);
		this.peeking = false;
		this.hovered = false;
		this.pointerFocus = false;
		this.holds = 0;
		this.offDoc?.();
		this.offDoc = null;
		this.releaseKeys();
		m.hostObserver.disconnect();
		m.headerObserver.disconnect();
		m.paneObserver.disconnect();
		m.root.remove();
		m.host.classList.remove(VCLS.host);
		m.host.classList.remove(VCLS.hostAnyDrag);
		this.items.clear();
		this.sections.clear();
		this.byHeader.clear();
		this.order = [];
		this.observedHeaders = [];
		this.observedPanes = [];
		this.observedRows = 0;
		this.focusKey = null;
		this.focusIndex = -1;
	}

	/**
	 * Step V6 review round 2: some drag is open (`true`) or over (`false`) in a window of the app. While
	 * mounted, the host carries the class that gives stacked panes their drop band; the state is kept
	 * for a mount during the drag.
	 */
	setAnyDrag(on: boolean): void {
		this.anyDrag = on;
		const host = this.m?.host;
		if (host === undefined) return;
		if (on) host.classList.add(VCLS.hostAnyDrag);
		else host.classList.remove(VCLS.hostAnyDrag);
	}

	/** Puts the strip back as the first child of the host and the class on it, when they went missing. */
	private ensure(): void {
		const m = this.m;
		if (m === null) return;
		if (m.root.parentElement !== m.host) {
			m.host.prepend(m.root);
			this.noteRemount('strip');
		}
		if (!m.host.classList.contains(VCLS.host)) {
			m.host.classList.add(VCLS.host);
			this.noteRemount('class');
		}
	}

	private noteRemount(what: 'strip' | 'class'): void {
		this.stats.remounts++;
		this.stats.remountLog.push({ at: performance.now(), what });
		if (this.stats.remountLog.length > TIMING_LIMIT) this.stats.remountLog.shift();
	}

	private button(doc: Document, cls: string, label: MessageKey, icon: string, run: () => void): HTMLElement {
		const el = doc.createElement('div');
		el.className = `${cls} clickable-icon`;
		el.setAttribute('role', 'button');
		el.setAttribute('tabindex', '0');
		el.setAttribute('aria-label', this.t.t(label));
		setIcon(el, icon);
		el.addEventListener('click', () => {
			run();
		});
		el.addEventListener('keydown', (evt: KeyboardEvent) => {
			if ((evt.key !== 'Enter' && evt.key !== ' ') || evt.isComposing) return;
			evt.preventDefault();
			run();
		});
		return el;
	}

	// ---------------------------------------------------------------- look (step V3)

	/** Collapsed or expanded, and the expanded width. Writes classes and a custom property only. */
	setLook(look: VStripLook): void {
		const was = this.look;
		this.look = look;
		if (was.collapsed !== look.collapsed || was.width !== look.width || was.minWidth !== look.minWidth || was.maxWidth !== look.maxWidth) this.applyLook();
	}

	get currentLook(): VStripLook {
		return this.look;
	}

	private applyLook(): void {
		const m = this.m;
		if (m === null) return;
		const collapsed = this.look.collapsed;
		toggleCls(m.root, 'is-collapsed', collapsed);
		if (!collapsed) this.setPeek(false);
		setCss(m.root, { '--tabstrip-vstrip-width': `${String(this.look.width)}px` });
		setAttr(m.collapseButton, 'aria-label', this.t.t(collapsed ? 'vstrip.expand' : 'vstrip.collapse'));
		setAttr(m.collapseButton, 'aria-expanded', collapsed ? 'false' : 'true');
		setIcon(m.collapseButton, collapsed ? 'chevrons-right' : 'chevrons-left');
		setAttr(m.handle, 'aria-valuenow', String(this.look.width));
		setAttr(m.handle, 'aria-valuemin', String(this.look.minWidth));
		setAttr(m.handle, 'aria-valuemax', String(this.look.maxWidth));
		setAttr(m.handle, 'aria-hidden', collapsed ? 'true' : null);
		setAttr(m.handle, 'tabindex', collapsed ? '-1' : '0');
	}

	private setPeek(on: boolean): void {
		const m = this.m;
		if (m === null || this.peeking === on) return;
		this.peeking = on;
		if (on) this.stats.peeks++;
		toggleCls(m.root, 'is-peek', on);
	}

	private clearPeekTimer(m: Mounted): void {
		if (this.peekTimer !== null) m.win.clearTimeout(this.peekTimer);
		this.peekTimer = null;
	}

	/** Opens (after PEEK_OPEN_MS) or closes (after PEEK_CLOSE_MS) the icon bar overlay. */
	private schedulePeek(on: boolean): void {
		const m = this.m;
		if (m === null) return;
		this.clearPeekTimer(m);
		// Step V5: the icon bar keeps its state while a row is dragged (see startDrag).
		if (this.vdrag !== null) return;
		if (!this.look.collapsed || on === this.peeking) return;
		this.peekTimer = m.win.setTimeout(
			() => {
				this.peekTimer = null;
				if (this.m !== m || this.vdrag !== null) return;
				this.setPeek(this.look.collapsed && (on || this.keepsPeek(m)));
			},
			on ? PEEK_OPEN_MS : PEEK_CLOSE_MS,
		);
	}

	/**
	 * What keeps the overlay open after the pointer left: the pointer is back, the keyboard focus is
	 * in the strip, or a menu or bubble opened from it is shown.
	 */
	private keepsPeek(m: Mounted): boolean {
		if (this.hovered || this.holds > 0) return true;
		const active = m.root.ownerDocument.activeElement;
		return active !== null && m.root.contains(active) && !this.pointerFocus;
	}

	/**
	 * Keeps the icon bar's overlay open (opening it now when the bar is collapsed) until the returned
	 * function is called: for a menu or the rename bubble opened from one of its rows, which sit
	 * outside the strip. Without this, moving onto them would close the overlay and leave them next
	 * to a 48px marker.
	 */
	holdPeek(): () => void {
		const m = this.m;
		if (m === null) return () => undefined;
		this.holds++;
		if (this.look.collapsed && !this.peeking) {
			this.clearPeekTimer(m);
			this.setPeek(true);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.m !== m) return;
			this.holds = Math.max(0, this.holds - 1);
			if (this.holds === 0) this.schedulePeek(false);
		};
	}

	// ---------------------------------------------------------------- drag (step V5)

	/** The dragged tab, while a row is dragged (tests). */
	get draggedLeaf(): string | null {
		return this.vdrag?.leafId ?? null;
	}

	/**
	 * A tab row's dragstart. Obsidian's own tab drag starts first (the caller's dragStart hook, which
	 * calls the whitelisted `workspace.onDragLeaf`, registering Obsidian's window listeners); then the
	 * strip registers its own window listeners, so they run after Obsidian's for every drag event:
	 * - over the strip's list, Obsidian finds no drop target there (it leaves the drop effect 'none');
	 *   the strip accepts the drop (preventDefault, 'move'), works out the spot at most once per frame
	 *   and draws a drop line and the group the tab would join;
	 * - anywhere else the strip does nothing and Obsidian's drop runs as for a native tab (splits,
	 *   other panes, sidebars, pop-outs, out of the window into a new window);
	 * - a drop on the strip: Obsidian's drop finds no target and only cleans up; the strip keeps the
	 *   spot and hands it to the caller after the drag ended (the row's dragend), so the move happens
	 *   after Obsidian's cleanup.
	 * Nothing here stops Obsidian's events. Events Obsidian relays from pop-out windows to the main
	 * window are told apart by their target's document. Nothing is redrawn during the drag, so the
	 * dragged row's element stays in the page until its dragend.
	 */
	private startDrag(m: Mounted, evt: DragEvent): void {
		this.endDrag(null);
		// Cancelled by an earlier listener (no drag starts), or files: not ours.
		if (evt.defaultPrevented || carriesFiles(evt)) return;
		const it = this.itemOf(evt.target);
		const item = it?.item ?? null;
		if (it === null || item?.kind !== 'tab') return;
		const leafId = item.row.leafId;
		const how = this.hooks.dragStart?.(leafId, it.el, evt) ?? null;
		if (how === null) {
			evt.preventDefault();
			return;
		}
		this.stats.drags[how]++;
		// Without Obsidian's drag the drag must still carry something to start (it stays in the strip).
		if (how !== 'native' && evt.dataTransfer !== null) {
			evt.dataTransfer.setData('text/plain', '');
			evt.dataTransfer.effectAllowed = 'move';
		}
		const { win, root, list } = m;
		const d: VDrag = { leafId, row: it.el, m, off: () => undefined, boxes: null, rootTop: 0, listTop: 0, listBottom: 0, y: null, frame: null, key: '', scrolled: false, frameAt: -1, drop: null, dropTimer: null, line: null, painted: [], pinned: it.item?.kind === 'tab' && it.item.row.pinned };
		const onOver = (e: DragEvent) => {
			this.onDragOver(d, e);
		};
		const onDrop = (e: DragEvent) => {
			this.onDrop(d, e);
		};
		const onLeave = (e: DragEvent) => {
			// Out of the window (no element it went to): no spot.
			if (e.relatedTarget === null && this.vdrag === d) this.pointerAt(d, null);
		};
		const onEnd = () => {
			this.onDragEnd(d);
		};
		// The list scrolled (Chromium scrolls it near its edges during a drag, or a wheel): measure again,
		// and paint again even if the spot stays the same (its row moved; V6).
		const onScroll = () => {
			d.boxes = null;
			d.scrolled = true;
			if (d.y !== null) this.queueFrame(d);
		};
		// Any later dragstart in this window (a note from the file explorer, another tab) means this drag
		// is over, even if its dragend never came (V5 review round 1).
		const onStart = (e: DragEvent) => {
			if (e !== evt && this.vdrag === d) this.endDrag(null);
		};
		win.addEventListener('dragstart', onStart, true);
		win.addEventListener('dragenter', onOver);
		win.addEventListener('dragover', onOver);
		win.addEventListener('dragleave', onLeave);
		win.addEventListener('drop', onDrop);
		it.el.addEventListener('dragend', onEnd);
		list.addEventListener('scroll', onScroll, { passive: true });
		d.off = () => {
			win.removeEventListener('dragstart', onStart, true);
			win.removeEventListener('dragenter', onOver);
			win.removeEventListener('dragover', onOver);
			win.removeEventListener('dragleave', onLeave);
			win.removeEventListener('drop', onDrop);
			it.el.removeEventListener('dragend', onEnd);
			list.removeEventListener('scroll', onScroll);
		};
		this.vdrag = d;
		// A later listener (another plugin, in the bubble phase) may still cancel this dragstart: then no
		// drag starts and no dragend comes. Check once the event is done; the drag ends with no drop, so
		// the strip draws again and no later, unrelated drag is taken for this tab (V5 review round 1).
		win.setTimeout(() => {
			if (this.vdrag === d && evt.defaultPrevented) this.endDrag(null);
		}, 0);
		it.el.classList.add(VCLS.dragging);
		m.host.classList.add(VCLS.hostDragging);
		// The icon bar: an open overlay stays open, but in place for the drag (Obsidian finds its drop
		// targets by their boxes, so an overlay over the editor would be the editor for its drops too);
		// a closed bar stays closed (icons only) and does not open on its own until the drag is over.
		this.clearPeekTimer(m);
		if (this.look.collapsed && this.peeking) root.classList.add(VCLS.dragOpen);
	}

	private onDragOver(d: VDrag, e: DragEvent): void {
		if (this.vdrag !== d) return;
		const started = performance.now();
		if (carriesFiles(e)) {
			this.endDrag(null);
			return;
		}
		const target = e.target as Node | null;
		// Over the list of this window's strip; a pop-out's events relayed here have another document.
		const over = target !== null && target.ownerDocument === d.m.list.ownerDocument && d.m.list.contains(target);
		if (over) {
			e.preventDefault();
			if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
		}
		this.pointerAt(d, over ? e.clientY : null);
		this.pushDragMs(this.stats.dragEventMs, performance.now() - started);
	}

	private pointerAt(d: VDrag, y: number | null): void {
		if (d.y === y) return;
		d.y = y;
		this.queueFrame(d);
	}

	private queueFrame(d: VDrag): void {
		if (d.frame !== null) return;
		d.frame = d.m.win.requestAnimationFrame((at: number) => {
			d.frame = null;
			this.runFrame(d, at);
		});
	}

	/**
	 * Once per frame: measure (only when needed), work out the spot, then paint (reads before writes).
	 * Paints when the spot changed, or when the list scrolled under the same spot (its row moved).
	 */
	private runFrame(d: VDrag, at: number): void {
		if (this.vdrag !== d) return;
		const started = performance.now();
		this.stats.dragFrames++;
		if (at === d.frameAt) this.stats.dragFramesSameFrame++;
		d.frameAt = at;
		const spot = d.y === null ? null : this.spotAt(d, d.y);
		const key = vspotKey(spot);
		const moved = key !== d.key;
		if (moved || (d.scrolled && spot !== null)) {
			if (!moved) this.stats.dragScrollRepaints++;
			d.key = key;
			this.inFrame = true;
			try {
				this.paintDrop(d, spot);
			} finally {
				this.inFrame = false;
			}
		}
		d.scrolled = false;
		this.pushDragMs(this.stats.dragFrameMs, performance.now() - started);
	}

	/** The spot at height `y` (measures the shown rows first when needed; no writes). */
	private spotAt(d: VDrag, y: number): VDropSpot | null {
		if (d.boxes === null) this.measure(d);
		if (d.boxes === null || y < d.listTop || y > d.listBottom) return null;
		return vspotAt(y, d.boxes, d.pinned);
	}

	/** Reads the boxes of the shown rows (list order), the strip's top and the list's box. */
	private measure(d: VDrag): void {
		const boxes: VDropBox[] = [];
		for (const it of this.order) {
			const item = it.item;
			if (item === null || !it.el.isConnected) continue;
			const r = it.el.getBoundingClientRect();
			if (r.height <= 0) continue;
			if (item.kind === 'tab') boxes.push({ kind: 'tab', paneId: item.row.paneId, leafId: item.row.leafId, pinned: item.row.pinned, top: r.top, bottom: r.bottom });
			else if (item.kind === 'group') boxes.push({ kind: 'group', paneId: item.paneId, groupId: item.groupId, firstLeafId: item.memberIds[0] ?? '', top: r.top, bottom: r.bottom });
			else boxes.push({ kind: 'new', paneId: item.paneId, top: r.top, bottom: r.bottom });
		}
		const list = d.m.list.getBoundingClientRect();
		d.rootTop = d.m.root.getBoundingClientRect().top;
		d.listTop = list.top;
		d.listBottom = list.bottom;
		d.boxes = boxes;
	}

	/** The drop line and the rows of the group the tab would join (writes only). */
	private paintDrop(d: VDrag, spot: VDropSpot | null): void {
		this.stats.dragPaints++;
		if (!this.inFrame) this.stats.dragPaintsOffFrame++;
		this.unpaintDrop(d);
		if (spot === null) return;
		const target: DropTarget = { leafId: d.leafId, paneId: spot.paneId, spot: spot.spot };
		const predicted = this.hooks.dragPredict?.(target) ?? { groupId: null, changes: true };
		const groupId = predicted.groupId;
		if (groupId !== null) {
			for (const it of this.order) {
				const item = it.item;
				const inGroup = item?.kind === 'group' ? item.groupId === groupId : item?.kind === 'tab' && item.row.groupId === groupId;
				if (!inGroup) continue;
				it.el.classList.add(VCLS.dropJoin);
				d.painted.push(it.el);
			}
		}
		if (!predicted.changes) return;
		let y = spot.lineY;
		if (spot.spot.kind === 'chip' && d.boxes !== null) {
			const box = d.boxes[spot.row];
			const group = this.items.get(`g:${spot.spot.groupId}`)?.item;
			if (box?.kind === 'group' && group?.kind === 'group' && group.collapsed) y = collapsedLineY(d.boxes, spot.row, new Set(group.memberIds));
		}
		let line = d.line;
		if (line === null) {
			line = d.m.root.ownerDocument.createElement('div');
			line.className = VCLS.dropLine;
			line.setAttribute('aria-hidden', 'true');
			d.m.root.appendChild(line);
			d.line = line;
		}
		toggleCls(line, 'is-member', groupId !== null);
		setCss(line, { '--tabstrip-vdrop-y': `${String(Math.round(y - d.rootTop))}px` });
		line.classList.add('is-shown');
	}

	private unpaintDrop(d: VDrag): void {
		for (const el of d.painted) el.classList.remove(VCLS.dropJoin);
		d.painted = [];
		d.line?.classList.remove('is-shown');
	}

	private onDrop(d: VDrag, e: DragEvent): void {
		if (this.vdrag !== d) return;
		const target = e.target as Node | null;
		const over = target !== null && target.ownerDocument === d.m.list.ownerDocument && d.m.list.contains(target);
		if (!over || carriesFiles(e)) return;
		e.preventDefault();
		// Read first (a fresh measure when needed), then write.
		const spot = this.spotAt(d, e.clientY);
		if (d.frame !== null) d.m.win.cancelAnimationFrame(d.frame);
		d.frame = null;
		d.y = null;
		d.key = '';
		this.unpaintDrop(d);
		if (spot === null) return;
		d.drop = { leafId: d.leafId, paneId: spot.paneId, spot: spot.spot };
		// The row's dragend ends the drag; if it never comes, end it anyway.
		d.dropTimer = d.m.win.setTimeout(() => {
			d.dropTimer = null;
			this.onDragEnd(d);
		}, DROP_END_MS);
	}

	/** The row's dragend (after Obsidian's own, which was registered first). */
	private onDragEnd(d: VDrag): void {
		if (this.vdrag !== d) return;
		const drop = d.drop;
		this.endDrag(drop);
	}

	/**
	 * Ends the drag: listeners, line, highlight, the icon bar's drag state go; the held render is
	 * drawn. A drop on the strip goes to the caller on the next task, after Obsidian's cleanup.
	 */
	private endDrag(drop: DropTarget | null): void {
		const d = this.vdrag;
		if (d === null) return;
		this.vdrag = null;
		d.off();
		if (d.frame !== null) d.m.win.cancelAnimationFrame(d.frame);
		if (d.dropTimer !== null) d.m.win.clearTimeout(d.dropTimer);
		this.unpaintDrop(d);
		d.line?.remove();
		d.row.classList.remove(VCLS.dragging);
		d.m.root.classList.remove(VCLS.dragOpen);
		d.m.host.classList.remove(VCLS.hostDragging);
		// Pointer events stop during a drag: where the pointer is now is not known. The next move over the
		// strip opens the icon bar again (pointermove); otherwise it closes.
		this.hovered = false;
		this.schedulePeek(false);
		const held = this.heldRender;
		this.heldRender = null;
		if (held !== null && this.m === d.m) this.render(...held);
		if (drop !== null) {
			this.stats.drops++;
			d.m.win.setTimeout(() => {
				if (this.m === d.m) this.hooks.dragDrop?.(drop);
			}, 0);
		}
		// After the drop's task is queued: what the caller runs on the next task follows the drop (V6).
		this.hooks.dragEnd?.();
	}

	private pushDragMs(list: number[], ms: number): void {
		list.push(ms);
		if (list.length > DRAG_TIMING_LIMIT) list.splice(0, list.length - DRAG_TIMING_LIMIT);
	}

	// ---------------------------------------------------------------- events

	private itemOf(target: EventTarget | null): ItemEls | null {
		const el = target as Partial<Element> | null;
		const found = typeof el?.closest === 'function' ? el.closest(ITEM_SELECTOR) : null;
		const key = found?.getAttribute(VITEM_KEY) ?? null;
		return key === null ? null : (this.items.get(key) ?? null);
	}

	private wire(m: Mounted): void {
		const { root, list, handle, win } = m;
		const onClose = (target: EventTarget | null): boolean => {
			const el = target as Partial<Element> | null;
			return typeof el?.closest === 'function' && el.closest(`.${VCLS.close}`) !== null;
		};
		list.addEventListener('click', (evt: MouseEvent) => {
			if (evt.button !== 0) return;
			const it = this.itemOf(evt.target);
			const item = it?.item ?? null;
			if (it === null || item === null) return;
			this.takeFocusKey(it);
			if (item.kind === 'tab') {
				if (onClose(evt.target)) this.hooks.close?.(item.row.leafId);
				else this.hooks.activate(item.row.leafId);
			} else if (item.kind === 'group') {
				this.hooks.toggleGroup?.(item.groupId, false, !item.collapsed);
			} else {
				this.hooks.newTab?.(item.paneId);
			}
		});
		// Middle button: no autoscroll; a middle click closes the tab (like the native tab).
		// Left press on a row's close button: keep the focus where it is (like the native close
		// button). Otherwise the press focuses the row, the row is removed by the close and the
		// focus moves on to its neighbour, unseen, where the next Backspace/Delete closes another tab.
		list.addEventListener('mousedown', (evt: MouseEvent) => {
			if (evt.button === 1 || (evt.button === 0 && onClose(evt.target))) evt.preventDefault();
		});
		list.addEventListener('auxclick', (evt: MouseEvent) => {
			if (evt.button !== 1) return;
			const item = this.itemOf(evt.target)?.item ?? null;
			if (item?.kind !== 'tab') return;
			evt.preventDefault();
			this.hooks.close?.(item.row.leafId);
		});
		list.addEventListener('contextmenu', (evt: MouseEvent) => {
			const it = this.itemOf(evt.target);
			const item = it?.item ?? null;
			if (it === null || item === null) return;
			evt.preventDefault();
			// A context menu from the keyboard (the context-menu key, Shift+F10 where the system turns it
			// into one): placed at the row like the key handler's; skipped when that key just opened it.
			const keyboard = evt.button !== 2;
			if (keyboard && performance.now() - this.keyMenuAt < KEY_MENU_MS) return;
			const at = keyboard ? null : evt;
			if (item.kind === 'tab') this.hooks.tabMenu?.(item.row.leafId, it.el, at);
			else if (item.kind === 'group') this.hooks.groupMenu?.(item.groupId, it.el, at);
		});
		// Step V5: dragging a tab row. Rows of groups and "New tab" are not draggable.
		list.addEventListener('dragstart', (evt: DragEvent) => {
			this.startDrag(m, evt);
		});
		// Without a key scope (or for keys it let through) the tree's own listener handles them.
		list.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (!evt.defaultPrevented) this.onKey(evt, this.itemOf(evt.target));
		});
		list.addEventListener('focusin', (evt: FocusEvent) => {
			const it = this.itemOf(evt.target);
			if (it !== null) this.takeFocusKey(it);
			this.claimKeys();
		});
		list.addEventListener('focusout', (evt: FocusEvent) => {
			const next = evt.relatedTarget as Node | null;
			if (next !== null && list.contains(next)) return;
			this.releaseKeys();
		});
		// Icon bar overlay: hover or keyboard focus opens it, leaving closes it after a short delay.
		root.addEventListener('pointerenter', () => {
			this.hovered = true;
			this.schedulePeek(true);
		});
		// A pointer already over the bar when it collapsed (no pointerenter) opens it on its next move.
		root.addEventListener('pointermove', () => {
			if (this.hovered && (this.peeking || this.peekTimer !== null)) return;
			this.hovered = true;
			this.schedulePeek(true);
		});
		root.addEventListener('pointerleave', () => {
			this.hovered = false;
			this.schedulePeek(false);
		});
		// Where the focus in the strip comes from (capture phase, before the focus moves): a press of the
		// pointer anywhere, or a key in the strip, or Tab anywhere (moving the focus into the strip).
		// Keys typed elsewhere (in the rename bubble) do not count: a bubble opened with the mouse gives
		// the focus back to the row, and that must not keep the overlay open.
		const doc = root.ownerDocument;
		const onDocPointer = () => {
			this.pointerFocus = true;
		};
		const onDocKey = (evt: KeyboardEvent) => {
			if (evt.key === 'Tab') this.pointerFocus = false;
		};
		doc.addEventListener('pointerdown', onDocPointer, true);
		doc.addEventListener('keydown', onDocKey, true);
		this.offDoc?.();
		this.offDoc = () => {
			doc.removeEventListener('pointerdown', onDocPointer, true);
			doc.removeEventListener('keydown', onDocKey, true);
		};
		root.addEventListener(
			'keydown',
			() => {
				this.pointerFocus = false;
			},
			true,
		);
		root.addEventListener('focusin', () => {
			this.schedulePeek(true);
		});
		root.addEventListener('focusout', (evt: FocusEvent) => {
			const next = evt.relatedTarget as Node | null;
			if (next !== null && root.contains(next)) return;
			this.schedulePeek(false);
		});
		// Edge handle: drag to resize (expanded only), or Arrow Left / Right.
		let drag: { pointerId: number; startX: number; startWidth: number; width: number; dir: number } | null = null;
		handle.addEventListener('pointerdown', (evt: PointerEvent) => {
			if (evt.button !== 0 || this.look.collapsed) return;
			evt.preventDefault();
			// Measure first (an event handler, before any write).
			const box = root.getBoundingClientRect();
			const rtl = win.getComputedStyle(root).direction === 'rtl';
			drag = { pointerId: evt.pointerId, startX: evt.clientX, startWidth: box.width, width: Math.round(box.width), dir: rtl ? -1 : 1 };
			handle.setPointerCapture(evt.pointerId);
			root.classList.add('is-resizing');
		});
		handle.addEventListener('pointermove', (evt: PointerEvent) => {
			if (drag?.pointerId !== evt.pointerId) return;
			const width = this.clampWidth(drag.startWidth + (evt.clientX - drag.startX) * drag.dir);
			if (width === drag.width) return;
			drag.width = width;
			setCss(root, { '--tabstrip-vstrip-width': `${String(width)}px` });
		});
		const endDrag = (evt: PointerEvent) => {
			if (drag?.pointerId !== evt.pointerId) return;
			const width = drag.width;
			drag = null;
			root.classList.remove('is-resizing');
			if (handle.hasPointerCapture(evt.pointerId)) handle.releasePointerCapture(evt.pointerId);
			this.look = { ...this.look, width };
			this.applyLook();
			this.hooks.widthChanged?.(width);
		};
		handle.addEventListener('pointerup', endDrag);
		handle.addEventListener('pointercancel', endDrag);
		handle.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (this.look.collapsed || evt.isComposing) return;
			const step = evt.key === 'ArrowRight' ? RESIZE_STEP : evt.key === 'ArrowLeft' ? -RESIZE_STEP : 0;
			if (step === 0) return;
			evt.preventDefault();
			const width = this.clampWidth(this.look.width + step);
			this.look = { ...this.look, width };
			this.applyLook();
			this.hooks.widthChanged?.(width);
		});
	}

	/** Pushes our key scope (once) while the tree has the focus. */
	private claimKeys(): void {
		if (this.keyScope !== null || this.m === null) return;
		const host = this.hooks.keyScopes?.();
		if (host === undefined) return;
		const scope = new Scope(host.parent);
		// Every key: ours are handled and stopped (false); anything else goes on to Obsidian (undefined).
		scope.register(null, null, (evt: KeyboardEvent) => {
			const m = this.m;
			const active = m?.list.ownerDocument.activeElement ?? null;
			if (m === null || active === null || !m.list.contains(active)) return undefined;
			return this.onKey(evt, this.itemOf(active)) ? false : undefined;
		});
		host.push(scope);
		this.keyScope = {
			scope,
			pop: () => {
				host.pop(scope);
			},
		};
	}

	private releaseKeys(): void {
		const k = this.keyScope;
		if (k === null) return;
		this.keyScope = null;
		k.pop();
	}

	private clampWidth(width: number): number {
		return Math.round(Math.min(this.look.maxWidth, Math.max(this.look.minWidth, width)));
	}

	private takeFocusKey(it: ItemEls): void {
		this.focusKey = it.id;
		this.focusIndex = this.order.indexOf(it);
		for (const other of this.order) this.setTabindex(other, other === it ? '0' : '-1');
	}

	private setTabindex(it: ItemEls, value: string): void {
		if (it.tabindex === value) return;
		it.tabindex = value;
		it.el.setAttribute('tabindex', value);
	}

	/** Carries out the tree's action for a key press; true when the key was the tree's (then prevented). */
	private onKey(evt: KeyboardEvent, it: ItemEls | null): boolean {
		// A key in the tree: the focus is the keyboard's now (also for keys Obsidian's key scope took
		// before they reached the strip's own listeners).
		this.pointerFocus = false;
		const item = it?.item ?? null;
		if (it === null || item === null) return false;
		const index = this.order.indexOf(it);
		if (index < 0) return false;
		const keyItems: VKeyItem[] = this.order.map((o) => {
			const x = o.item;
			if (x === null) return { kind: 'new', level: 1 };
			return x.kind === 'group' ? { kind: 'group', level: x.level, collapsed: x.collapsed } : { kind: x.kind, level: x.level };
		});
		const action = keyAction(keyItems, index, evt);
		if (action === null) return false;
		evt.preventDefault();
		evt.stopPropagation();
		switch (action.kind) {
			case 'focus': {
				const target = this.order[action.index];
				if (target !== undefined) this.focusItem(target);
				break;
			}
			case 'activate':
				if (item.kind === 'tab') this.hooks.activate(item.row.leafId);
				break;
			case 'toggle':
			case 'expand':
			case 'collapse':
				// The target state follows the row as drawn (a stacked pane draws a collapsed group expanded).
				if (item.kind === 'group') this.hooks.toggleGroup?.(item.groupId, true, action.kind === 'toggle' ? !item.collapsed : action.kind === 'collapse');
				break;
			case 'close':
				if (item.kind === 'tab') {
					this.hooks.close?.(item.row.leafId);
					this.refocusAt(index);
				}
				break;
			case 'rename': {
				const groupId = item.kind === 'group' ? item.groupId : item.kind === 'tab' ? item.row.groupId : null;
				if (groupId !== null) this.hooks.renameGroup?.(groupId);
				break;
			}
			case 'menu':
				this.keyMenuAt = performance.now();
				if (item.kind === 'tab') this.hooks.tabMenu?.(item.row.leafId, it.el, null);
				else if (item.kind === 'group') this.hooks.groupMenu?.(item.groupId, it.el, null);
				break;
			case 'newTab':
				if (item.kind === 'new') this.hooks.newTab?.(item.paneId);
				break;
			case 'move':
				if (item.kind === 'tab') this.hooks.moveTab?.(item.row.leafId, action.dir);
				break;
		}
		return true;
	}

	/**
	 * After Delete closed the focused tab, the focus stays in the tree: on the item now at that place
	 * (Obsidian gives the focus to the next shown tab when the closed one was active).
	 */
	private refocusAt(index: number): void {
		const m = this.m;
		if (m === null) return;
		m.win.setTimeout(() => {
			if (this.m !== m || this.order.length === 0) return;
			const active = m.list.ownerDocument.activeElement;
			if (active !== null && m.list.contains(active)) return;
			const target = this.order[Math.min(index, this.order.length - 1)];
			if (target !== undefined) this.focusItem(target);
		}, REFOCUS_MS);
	}

	private focusItem(it: ItemEls): void {
		this.takeFocusKey(it);
		it.el.focus();
	}

	/** Moves the keyboard focus to an item (key `t:<leafId>`, `g:<groupId>` or `n:<paneId>`); false when not shown. */
	focusKeyed(key: string): boolean {
		const it = this.items.get(key);
		if (it === undefined || !this.order.includes(it)) return false;
		this.focusItem(it);
		return true;
	}

	// ---------------------------------------------------------------- render

	/**
	 * Brings the list in line with `plan`. `headerOf` gives each tab's native header (title and icon
	 * are copied from it). `headerRows` are the panes' native tab header rows, watched for tabs
	 * coming and going; `splits` the elements that hold the panes, watched (children only, not the
	 * views inside) for panes coming and going. `inkOf` gives the group name's text colour (measured
	 * by the caller before). Writes only what changed; never reads layout.
	 */
	render(
		plan: VListPlan,
		headerOf: (leafId: string) => HTMLElement | null,
		headerRows: readonly HTMLElement[] = [],
		splits: readonly HTMLElement[] = [],
		inkOf: InkOf = () => null,
		allHeaders: ReadonlyMap<string, HTMLElement | null> | null = null,
	): void {
		const m = this.m;
		if (m === null) return;
		// Step V5: while a row is dragged nothing is redrawn (the dragged row's element must stay in the
		// page until the drag ends: Obsidian's drag ends on its dragend). The latest list is drawn then.
		if (this.vdrag !== null) {
			this.heldRender = [plan, headerOf, headerRows, splits, inkOf, allHeaders];
			this.stats.heldRenders++;
			return;
		}
		const started = performance.now();
		const doc = m.root.ownerDocument;
		const focused = doc.activeElement;
		const hadFocus = focused !== null && m.list.contains(focused);
		// The focus is outside the tree: its tab stop goes back to the highlighted tab, so Tab lands there.
		if (!hadFocus) {
			this.focusKey = null;
			this.focusIndex = -1;
		}
		const liveItems = new Set<string>();
		const liveSections = new Set<string>();
		const headers: HTMLElement[] = [];
		const order: ItemEls[] = [];
		let activeIndex = -1;
		this.byHeader.clear();
		// Rows that go away (or hide) leave first, so the rows after them do not have to move one by one.
		for (const section of plan.sections) {
			liveSections.add(section.key);
			for (const item of section.items) liveItems.add(item.key);
		}
		for (const [key, els] of this.items) if (!liveItems.has(key)) els.el.remove();
		for (const [key, sec] of this.sections) if (!liveSections.has(key)) sec.el.remove();
		plan.sections.forEach((section, sIndex) => {
			const sec = this.sectionEls(doc, section);
			const at = m.list.children.item(sIndex);
			if (at !== sec.el) m.list.insertBefore(sec.el, at);
			section.items.forEach((item, iIndex) => {
				const els = this.itemEls(doc, item);
				let copy = false;
				if (item.kind === 'tab') {
					const row = els as RowEls;
					const header = headerOf(item.row.leafId);
					// Title and icon are copied when the row gets a (new) header; later changes come through headerObserver.
					copy = row.header !== header || row.titleText === null;
					row.header = header;
					if (header !== null && allHeaders === null) {
						this.byHeader.set(header, item.row.leafId);
						headers.push(header);
					}
					if (item.row.active) activeIndex = order.length;
				}
				this.applyItem(els, item, inkOf);
				if (copy) this.copyFromHeader(els as RowEls);
				// Child 0 of a section is its title.
				const before = sec.el.children.item(iIndex + 1);
				if (before !== els.el) sec.el.insertBefore(els.el, before);
				order.push(els);
			});
		});
		// Every tab's header is watched, hidden members' too: collapsing a group then changes no observation.
		if (allHeaders !== null) {
			for (const [leafId, header] of allHeaders) {
				if (header === null) continue;
				this.byHeader.set(header, leafId);
				headers.push(header);
			}
		}
		for (const [key, sec] of this.sections) {
			if (liveSections.has(key)) continue;
			sec.el.remove();
			this.sections.delete(key);
		}
		for (const [key, els] of this.items) {
			if (liveItems.has(key)) continue;
			els.el.remove();
			// A hidden member of a collapsed group keeps its row for when the group opens again (no rebuild).
			const leafId = els.kind === 'tab' ? els.el.getAttribute(VROW_LEAF) : null;
			if (leafId !== null && allHeaders?.has(leafId) === true) continue;
			this.items.delete(key);
		}
		// Items now shown in another section were moved there; anything else left at a section's end goes.
		for (const sec of this.sections.values()) {
			while (sec.el.children.length > 0) {
				const last = sec.el.lastElementChild;
				if (last === null || last === sec.title) break;
				const key = last.getAttribute(VITEM_KEY);
				if (key !== null && liveItems.has(key) && this.items.get(key)?.el === last) break;
				last.remove();
			}
		}
		this.order = order;
		// Roving tab stop: the focused item, else the item now at its place, else the highlighted tab.
		const roving = rovingIndex(
			order.map((o) => o.id),
			this.focusKey,
			this.focusIndex,
			activeIndex,
		);
		order.forEach((o, i) => {
			this.setTabindex(o, i === roving ? '0' : '-1');
		});
		const keeper = order[roving];
		this.focusKey = keeper?.id ?? null;
		this.focusIndex = roving;
		const now = doc.activeElement;
		if (hadFocus && keeper !== undefined && (now === null || !m.list.contains(now))) keeper.el.focus();
		// Re-observe when the headers changed (a MutationObserver cannot drop single targets). Records
		// still pending are handled first: disconnect() would drop them.
		if (!sameElements(this.observedHeaders, headers)) {
			const pending = m.headerObserver.takeRecords();
			if (pending.length > 0) this.onHeaderMutations(pending);
			m.headerObserver.disconnect();
			for (const header of headers) m.headerObserver.observe(header, { childList: true, characterData: true, subtree: true });
			this.observedHeaders = headers;
		}
		const paneTargets = [...headerRows, ...splits];
		if (!sameElements(this.observedPanes, paneTargets) || this.observedRows !== headerRows.length) {
			const pending = m.paneObserver.takeRecords();
			m.paneObserver.disconnect();
			for (const row of headerRows) m.paneObserver.observe(row, { childList: true, subtree: true });
			for (const split of splits) m.paneObserver.observe(split, { childList: true });
			this.observedPanes = paneTargets;
			this.observedRows = headerRows.length;
			if (pending.some(movesHeader)) this.hooks.tabsChanged?.();
		}
		this.stats.renders++;
		this.pushMs(this.stats.renderMs, performance.now() - started);
	}

	private sectionEls(doc: Document, section: VSection): SectionEls {
		let sec = this.sections.get(section.key);
		if (sec === undefined) {
			const el = doc.createElement('div');
			el.className = `${VCLS.section} mod-${section.kind}`;
			const title = el.appendChild(doc.createElement('div'));
			title.className = VCLS.paneTitle;
			title.setAttribute('aria-hidden', 'true');
			sec = { el, title, marks: '' };
			this.sections.set(section.key, sec);
		}
		const label = section.kind === 'pinned' ? this.t.t('vstrip.pinned') : this.t.t('vstrip.pane', { index: section.index });
		const marks = `${label}|${section.titled ? 't' : ''}`;
		if (sec.marks !== marks) {
			sec.marks = marks;
			// One pane only: its section is no group of its own (role none); the pinned area always is.
			const grouped = section.kind === 'pinned' || section.titled;
			setAttr(sec.el, 'role', grouped ? 'group' : 'none');
			setAttr(sec.el, 'aria-label', grouped ? label : null);
			toggleCls(sec.el, 'is-titled', section.titled);
			sec.title.textContent = section.kind === 'pane' && section.titled ? label : '';
		}
		return sec;
	}

	private itemEls(doc: Document, item: VItem): ItemEls {
		const found = this.items.get(item.key);
		if (found !== undefined) return found;
		let els: ItemEls;
		if (item.kind === 'tab') els = this.newRow(doc, item);
		else if (item.kind === 'group') els = this.newGroupRow(doc, item);
		else els = this.newTabRow(doc, item);
		els.el.setAttribute(VITEM_KEY, item.key);
		els.el.setAttribute('role', 'treeitem');
		els.el.setAttribute('tabindex', '-1');
		this.items.set(item.key, els);
		return els;
	}

	private newRow(doc: Document, item: VTabItem): RowEls {
		const el = doc.createElement('div');
		el.className = VCLS.row;
		el.setAttribute(VROW_LEAF, item.row.leafId);
		const icon = el.appendChild(doc.createElement('div'));
		icon.className = VCLS.icon;
		const title = el.appendChild(doc.createElement('div'));
		title.className = VCLS.title;
		const close = el.appendChild(doc.createElement('div'));
		close.className = `${VCLS.close} clickable-icon`;
		// Not a tab stop of its own: Delete closes the focused row (the tree keeps one tab stop).
		close.setAttribute('aria-hidden', 'true');
		close.setAttribute('title', this.t.t('vstrip.close'));
		setIcon(close, 'x');
		// Step V5: tab rows (only they) can be dragged.
		el.setAttribute('draggable', 'true');
		return { el, kind: 'tab', id: item.key, marks: '', item: null, tabindex: '-1', icon, title, titleText: null, iconCopy: null, header: null };
	}

	private newGroupRow(doc: Document, item: VGroupItem): GroupEls {
		const el = doc.createElement('div');
		el.className = VCLS.group;
		const arrow = el.appendChild(doc.createElement('div'));
		arrow.className = VCLS.groupArrow;
		arrow.setAttribute('aria-hidden', 'true');
		const chip = el.appendChild(doc.createElement('div'));
		chip.className = VCLS.groupChip;
		const label = chip.appendChild(doc.createElement('span'));
		label.className = VCLS.groupLabel;
		const count = el.appendChild(doc.createElement('div'));
		count.className = VCLS.groupCount;
		count.setAttribute('aria-hidden', 'true');
		return { el, kind: 'group', id: item.key, marks: '', item: null, tabindex: '-1', arrow, chip, label, count, collapsedIcon: null };
	}

	private newTabRow(doc: Document, item: VNewItem): ItemEls {
		const el = doc.createElement('div');
		el.className = VCLS.newTab;
		const icon = el.appendChild(doc.createElement('div'));
		icon.className = VCLS.icon;
		setIcon(icon, 'plus');
		const title = el.appendChild(doc.createElement('div'));
		title.className = VCLS.title;
		title.textContent = this.t.t('vstrip.newTab');
		el.setAttribute('aria-label', this.t.t('vstrip.newTab'));
		return { el, kind: 'new', id: item.key, marks: '', item: null, tabindex: '-1' };
	}

	/** Writes an item's marks when they changed. */
	private applyItem(els: ItemEls, item: VItem, inkOf: InkOf): void {
		els.item = item;
		const el = els.el;
		if (item.kind === 'group') {
			const label = this.t.chipLabel(item.name, item.color, item.count, item.collapsed);
			const named = item.name.trim().length > 0;
			const ink = named ? (inkOf(item.color) ?? '') : '';
			const marks = itemKey(item, `${label}|${ink}`);
			if (els.marks === marks) return;
			els.marks = marks;
			const g = els as GroupEls;
			el.setAttribute('data-tabstrip-group', item.groupId);
			el.setAttribute('data-tabstrip-color', item.color);
			toggleCls(el, 'is-collapsed', item.collapsed);
			toggleCls(el, 'holds-active', item.holdsActive);
			el.setAttribute('aria-expanded', item.collapsed ? 'false' : 'true');
			el.setAttribute('aria-label', label);
			this.setPos(el, item);
			toggleCls(g.chip, 'is-unnamed', !named);
			g.chip.setAttribute('data-tabstrip-color', item.color);
			setAttr(g.chip, 'data-tabstrip-ink', ink === '' ? null : ink);
			g.label.textContent = named ? item.name.trim() : this.t.groupLabel('', item.color);
			g.count.textContent = String(item.count);
			if (g.collapsedIcon !== item.collapsed) {
				g.collapsedIcon = item.collapsed;
				setIcon(g.arrow, item.collapsed ? 'chevron-right' : 'chevron-down');
			}
			return;
		}
		if (item.kind === 'new') {
			const marks = itemKey(item, '');
			if (els.marks === marks) return;
			els.marks = marks;
			el.setAttribute('data-tabstrip-pane', item.paneId);
			this.setPos(el, item);
			return;
		}
		const marks = itemKey(item, '');
		if (els.marks === marks) return;
		els.marks = marks;
		const plan = item.row;
		toggleCls(el, 'is-active', plan.active);
		toggleCls(el, 'is-current', plan.current);
		toggleCls(el, 'is-pinned', plan.pinned);
		toggleCls(el, 'is-deferred', item.deferred);
		toggleCls(el, 'is-member', item.level === 2);
		// First tab of a pane after the first (V1's mark; the section draws the separator now).
		toggleCls(el, 'is-pane-start', plan.paneStart);
		el.setAttribute('aria-selected', plan.active ? 'true' : 'false');
		setAttr(el, 'aria-current', plan.current ? 'page' : null);
		this.setPos(el, item);
		if (plan.color === null) {
			setAttr(el, 'data-tabstrip-color', null);
			setAttr(el, 'data-tabstrip-group', null);
		} else {
			el.setAttribute('data-tabstrip-color', plan.color);
			el.setAttribute('data-tabstrip-group', plan.groupId ?? '');
		}
		this.labelRow(els as RowEls);
	}

	private setPos(el: HTMLElement, item: VItem): void {
		el.setAttribute('aria-level', String(item.level));
		el.setAttribute('aria-setsize', String(item.setsize));
		el.setAttribute('aria-posinset', String(item.posinset));
	}

	/** Accessible name of a tab row: its title, plus pinned / not loaded. */
	private labelRow(row: RowEls): void {
		const item = row.item;
		if (item?.kind !== 'tab') return;
		const parts = [row.titleText ?? ''];
		if (item.row.pinned) parts.push(this.t.t('vstrip.pinnedTab'));
		if (item.deferred) parts.push(this.t.t('vstrip.notLoaded'));
		setAttr(row.el, 'aria-label', parts.filter((p) => p.length > 0).join(this.t.locale === 'zh' ? '，' : ', '));
	}

	/** Copies title and icon from the row's native header when they differ from the last copy. */
	private copyFromHeader(row: RowEls): void {
		const header = row.header;
		const title = header?.querySelector(NATIVE_TITLE)?.textContent ?? '';
		if (title !== row.titleText) {
			row.titleText = title;
			row.title.textContent = title;
			this.labelRow(row);
		}
		const icon = header?.querySelector(NATIVE_ICON) ?? null;
		if (icon === null) {
			if (row.iconCopy !== null) {
				row.iconCopy = null;
				row.icon.replaceChildren();
			}
			return;
		}
		if (row.iconCopy !== null && icon.isEqualNode(row.iconCopy)) return;
		row.iconCopy = icon.cloneNode(true);
		row.icon.replaceChildren(...Array.from(icon.childNodes, (n) => n.cloneNode(true)));
	}

	private onHeaderMutations(records: readonly MutationRecord[]): void {
		if (this.m === null) return;
		const started = performance.now();
		const touched = new Set<string>();
		for (const r of records) {
			let node: Node | null = r.target;
			while (node !== null) {
				const leafId = this.byHeader.get(node as HTMLElement);
				if (leafId !== undefined) {
					touched.add(leafId);
					break;
				}
				node = node.parentNode;
			}
		}
		for (const leafId of touched) {
			const row = this.items.get(`t:${leafId}`) as RowEls | undefined;
			if (row === undefined) continue;
			const before = row.titleText;
			const iconBefore = row.iconCopy;
			this.copyFromHeader(row);
			if (row.titleText !== before || row.iconCopy !== iconBefore) this.stats.headerRefreshes++;
		}
		this.pushMs(this.stats.refreshMs, performance.now() - started);
	}

	/** Records the plugin time of one strip update made outside a pass (see VStripStats.updateMs). */
	noteUpdate(ms: number): void {
		this.stats.updates++;
		this.pushMs(this.stats.updateMs, ms);
	}

	private pushMs(list: number[], ms: number): void {
		list.push(ms);
		if (list.length > TIMING_LIMIT) list.splice(0, list.length - TIMING_LIMIT);
	}
}
