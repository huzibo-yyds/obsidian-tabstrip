/**
 * The only module that touches Obsidian's private workspace members.
 *
 * Allowed private members (requirements 7.4): `leaf.id`, `leaf.tabHeaderEl`,
 * `WorkspaceTabs.children`, `currentTab`, `isStacked`, `tabHeaderContainerEl`, the native
 * move recipe `removeChild` → `setDimension(null)` → `insertChild` → `selectTabIndex` →
 * `workspace.requestResize`, and `workspace.onDragLeaf` (step V5). Everything private is typed as `unknown` here and checked
 * before use (see capabilities.ts and read.ts). No prototype is patched.
 */
import { Menu, View, WorkspaceFloating, WorkspaceTabs, type App, type Scope, type WorkspaceLeaf, type WorkspaceSplit } from 'obsidian';
import type { Op, Snapshot } from '../core/types';
import { probeCapabilities, type Capabilities } from './capabilities';
import { PaneIds, readStrips, type StripRead, type WorkspaceRead } from './read';
import { readLeafId, readTabsShape } from './shape';

/** Private members read from a `WorkspaceTabs`. */
interface TabsPrivate {
	readonly children?: unknown;
	readonly currentTab?: unknown;
	readonly isStacked?: unknown;
	readonly tabHeaderContainerEl?: unknown;
}

/** The native move recipe on a `WorkspaceTabs` (whitelisted, checked by the probe). */
interface TabsMoveRecipe {
	readonly children: readonly unknown[];
	readonly currentTab: number;
	removeChild(leaf: unknown): void;
	insertChild(index: number, leaf: unknown): void;
	selectTabIndex(index: number): void;
}

interface LeafPrivate {
	readonly id?: unknown;
	readonly tabHeaderEl?: unknown;
	setDimension?(dimension: number | null): void;
}

interface WorkspacePrivate {
	requestResize?(): void;
	/** Whitelisted (requirements 7.4): starts Obsidian's own tab drag for a leaf from a dragstart event. */
	onDragLeaf?(evt: DragEvent, leaf: unknown): void;
}

/**
 * What a move with the native recipe did: 'moved'; 'refused' (recipe not available, tab or strip
 * gone, index out of range: nothing was touched); 'failed' (a step threw: the tab was put back).
 */
export type MoveResult = 'moved' | 'refused' | 'failed';

/**
 * Where the tab ended up after a failed move: 'back' in its own strip at its old place; 'kept' in
 * the target strip (its own strip left the layout with its last tab, or could not take it back);
 * 'reopened' in a new tab of the main area; 'lost' when all of that failed.
 */
type PutBack = 'back' | 'kept' | 'reopened' | 'lost';

const PUT_BACK_TEXT: Record<PutBack, string> = {
	back: 'it was put back where it was',
	kept: 'it was kept in the pane it was moved to',
	reopened: 'it was opened again in a new tab',
	lost: 'it could not be put back in any pane',
};

function isMoveRecipe(tabs: Partial<TabsMoveRecipe>): tabs is TabsMoveRecipe {
	return (
		Array.isArray(tabs.children) &&
		typeof tabs.currentTab === 'number' &&
		typeof tabs.removeChild === 'function' &&
		typeof tabs.insertChild === 'function' &&
		typeof tabs.selectTabIndex === 'function'
	);
}

/** What starting Obsidian's tab drag from the vertical strip did (step V5). */
export type DragLeafResult = 'native' | 'missing' | 'threw';

/** Read-only state of one tab strip (one `WorkspaceTabs`), used by the L1 skeleton test. */
export interface TabStripSnapshot {
	/** Leaf ids in Obsidian's tab order (`children`). */
	readonly leafIds: readonly string[];
	/** Leaf ids in the on-screen order of their tab headers. */
	readonly headerLeafIds: readonly string[];
	/** Leaf id of the tab currently shown in this strip. */
	readonly currentLeafId: string | null;
	readonly stacked: boolean;
}

/** Works across pop-out windows, where each window has its own `HTMLElement`. */
function isHTMLElement(value: unknown): value is HTMLElement {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<Pick<Node, 'instanceOf'>>;
	return typeof candidate.instanceOf === 'function' && candidate.instanceOf(HTMLElement);
}

function byDocumentOrder(a: HTMLElement, b: HTMLElement): number {
	if (a === b) return 0;
	return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/**
 * Tab strips of the main area and pop-out windows. Sidebars, and leaves of other plugins'
 * floating containers (Hover Editor), are not included: only strips whose root is the main
 * area or a pop-out window count. (`iterateRootLeaves` covers the main area only.)
 */
export function collectRootTabs(app: App): WorkspaceTabs[] {
	const found = new Set<WorkspaceTabs>();
	const main = app.workspace.rootSplit;
	app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
		const parent = leaf.parent;
		if (!(parent instanceof WorkspaceTabs) || found.has(parent)) return;
		// getRoot() climbs to the top: the main area, the pop-out windows' WorkspaceFloating, or a sidebar.
		const root = leaf.getRoot();
		if (root === main || root instanceof WorkspaceFloating) found.add(parent);
	});
	return [...found];
}

/** Returns null when a private field is missing or has an unexpected shape. */
export function snapshotTabStrip(tabs: WorkspaceTabs): TabStripSnapshot | null {
	const raw = tabs as unknown as TabsPrivate;
	const shape = readTabsShape(raw);
	if (shape === null) return null;

	const container = raw.tabHeaderContainerEl;
	if (!isHTMLElement(container)) return null;

	const headers: { id: string; el: HTMLElement }[] = [];
	for (const child of raw.children as readonly unknown[]) {
		const leaf = child as LeafPrivate;
		const id = readLeafId(leaf);
		const el = leaf.tabHeaderEl;
		if (id === null || !isHTMLElement(el)) return null;
		if (container.contains(el)) headers.push({ id, el });
	}
	headers.sort((a, b) => byDocumentOrder(a.el, b.el));

	return {
		leafIds: shape.leafIds,
		headerLeafIds: headers.map((h) => h.id),
		currentLeafId: shape.currentIndex >= 0 ? (shape.leafIds[shape.currentIndex] ?? null) : null,
		stacked: shape.stacked,
	};
}

/** The strip holds the active leaf, or there is no active main-area or pop-out leaf at all. */
function holdsActive(strip: StripRead | undefined, snapshot: Snapshot): boolean {
	return snapshot.activeLeafId === null || (strip?.leaves.some((l) => l.id === snapshot.activeLeafId) ?? false);
}

/** What applying a list of ops did. */
/** Where the main window's root split stands for the vertical strip (see WorkspaceAdapter.rootState). */
export type RootState = 'shown' | 'loading' | 'missing';

export interface ApplyResult {
	readonly applied: number;
	readonly skipped: number;
}

/** How to carry out ops. */
export interface ApplyOptions {
	/**
	 * Whether an `activate` op gives the keyboard focus to the tab it shows (default true). False
	 * when the command came from a key press on the chip: the focus stays there (L5 review round 2).
	 */
	readonly focus?: boolean;
}

/**
 * Live workspace access for the controller: reading strips into a snapshot, and carrying out
 * the model's ops with the native move recipe or public API.
 */
export class WorkspaceAdapter {
	readonly paneIds = new PaneIds();
	private caps: Capabilities | null = null;

	constructor(private readonly app: App) {}

	/** Probes the APIs once (call after the layout is ready). */
	probe(): Capabilities {
		const tabs = collectRootTabs(this.app).find((t) => t.getContainer() === this.app.workspace.rootSplit) ?? null;
		this.caps = probeCapabilities({ workspace: this.app.workspace, tabs, menu: Menu });
		return this.caps;
	}

	get capabilities(): Capabilities | null {
		return this.caps;
	}

	/** The focused leaf (may be a sidebar leaf), through the public active view. */
	activeLeaf(): WorkspaceLeaf | null {
		return this.app.workspace.getActiveViewOfType(View)?.leaf ?? null;
	}

	/**
	 * The most recently active tab of the main window's root split (public `getMostRecentLeaf`), used
	 * by the vertical strip while the focus is in a sidebar view.
	 */
	recentRootLeafId(): string | null {
		return readLeafId(this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit));
	}

	/** Gives the keyboard focus to the active tab's view (public `setActiveLeaf` with focus). */
	focusActiveLeaf(): void {
		const leaf = this.activeLeaf();
		if (leaf !== null) this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** The main window's `.workspace` element (public `workspace.containerEl`), where the vertical strip lives. */
	workspaceEl(): HTMLElement {
		return this.app.workspace.containerEl;
	}

	/**
	 * The main window's root split element: the `.workspace-split.mod-root` child of the public
	 * `workspace.containerEl`, found with a plain DOM query (no private member). Null before the
	 * first layout load and while a layout load has taken it out of the page.
	 */
	private rootEl(): HTMLElement | null {
		return this.app.workspace.containerEl.querySelector<HTMLElement>(':scope > .workspace-split.mod-root');
	}

	/**
	 * Where the root split stands for the vertical strip, given the root split's tab header rows
	 * (whitelisted `tabHeaderContainerEl`):
	 * - 'shown': the root split element is in the page;
	 * - 'loading': it is not, and none of its header rows is in the page either (a layout load);
	 * - 'missing': header rows are in the page but the element cannot be found (the page structure
	 *   is not what the plugin knows): the caller gives the native tab bar back.
	 */
	rootState(headerRows: readonly HTMLElement[]): RootState {
		if (this.rootEl() !== null) return 'shown';
		return headerRows.some((row) => row.isConnected) ? 'missing' : 'loading';
	}

	/** Whether the main window's root split element is in the page (see rootEl). */
	rootShown(): boolean {
		return this.rootEl() !== null;
	}

	/**
	 * The elements that hold the root split's panes: each tab header row's pane element and its
	 * ancestors up to the root split element (DOM parents only, no private member). The pane element
	 * itself is left out: its children are the header row and the views.
	 */
	rootSplitElements(headerRows: readonly HTMLElement[]): HTMLElement[] {
		const root = this.rootEl();
		if (root === null) return [];
		const out = new Set<HTMLElement>();
		for (const row of headerRows) {
			if (!root.contains(row)) continue;
			let el = row.parentElement?.parentElement ?? null;
			while (el !== null && !out.has(el)) {
				out.add(el);
				if (el === root) break;
				el = el.parentElement;
			}
		}
		out.add(root);
		return [...out];
	}

	/** Shows and focuses a tab (public `setActiveLeaf`); used by a click on a vertical strip row. */
	activateLeaf(leaf: object): void {
		this.app.workspace.setActiveLeaf(leaf as WorkspaceLeaf, { focus: true });
	}

	/** Closes a tab (public `WorkspaceLeaf.detach`), like the native middle click or close button. */
	closeLeaf(leaf: object): void {
		(leaf as WorkspaceLeaf).detach();
	}

	/**
	 * Step V2: Obsidian's own tab menu for a tab whose header is hidden (vertical strip), shown at
	 * (`x`, `y`) and tied to `anchor` (the strip's row). The native menu is built by the tab header's
	 * own contextmenu listener through the public `Menu.forEvent`; a contextmenu event is dispatched
	 * on the whitelisted `leaf.tabHeaderEl` (a plain DOM event, no private method), so the native
	 * items, the view's items, 'leaf-menu' and our capture listener (group items) all run as for a
	 * right click on the header. The public `Menu.forEvent` returns that same menu for this event;
	 * `setParentElement(anchor)` (public) ties it to the visible row, since a menu whose parent is
	 * hidden is closed by Obsidian. Returns false when the tab has no header.
	 */
	openTabMenu(header: HTMLElement, anchor: HTMLElement, x: number, y: number): Menu | null {
		const win = header.ownerDocument.defaultView;
		if (win === null) return null;
		const evt = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, button: 2, buttons: 2, clientX: x, clientY: y, view: win });
		header.dispatchEvent(evt);
		const menu = Menu.forEvent(evt);
		menu.setParentElement(anchor);
		return menu;
	}

	/**
	 * Step V4: Obsidian's key handling (public `app.scope`, `app.keymap.pushScope` / `popScope`).
	 * Obsidian reads key presses at the window, before the page sees them, and runs its hotkeys
	 * there (F2 is "Rename file"); a scope pushed while the vertical strip's tree has the focus gets
	 * them first, so the tree's keys win and every other key goes on to Obsidian's hotkeys.
	 */
	keyScopes(): { parent: Scope; push(scope: Scope): void; pop(scope: Scope): void } {
		const { app } = this;
		return {
			parent: app.scope,
			push: (scope) => {
				app.keymap.pushScope(scope);
			},
			pop: (scope) => {
				app.keymap.popScope(scope);
			},
		};
	}

	/** Public `WorkspaceSidedock.toggle()` / `WorkspaceMobileDrawer.toggle()`. */
	toggleSidebar(side: 'left' | 'right'): void {
		(side === 'left' ? this.app.workspace.leftSplit : this.app.workspace.rightSplit).toggle();
	}

	/** Signals that the Vertical Tabs plugin is on: its open views (public getLeavesOfType) and the main body's classes. */
	verticalTabsSignals(): { views: number; bodyClasses: string[] } {
		return {
			views: this.app.workspace.getLeavesOfType('vertical-tabs').length,
			bodyClasses: Array.from(this.app.workspace.containerEl.ownerDocument.body.classList),
		};
	}

	/** Snapshot of the main area and pop-out windows. Never loads a deferred leaf. */
	read(): WorkspaceRead {
		return readStrips(collectRootTabs(this.app), {
			paneIds: this.paneIds,
			mainContainer: this.app.workspace.rootSplit,
			activeLeaf: this.activeLeaf(),
			headers: this.caps?.headers === true,
		});
	}

	/**
	 * Moves a leaf inside its strip with Obsidian's own recipe and keeps the shown tab (the
	 * active leaf, when it is in this strip) as it was.
	 */
	moveLeaf(tabs: object, leaf: object, index: number): boolean {
		if (this.caps?.move !== true) return false;
		const recipe = tabs as unknown as TabsMoveRecipe;
		const from = recipe.children.indexOf(leaf);
		if (from < 0 || index < 0 || index > recipe.children.length - 1) return false;
		if (from === index) return true;
		const active = this.activeLeaf();
		const shown = active !== null && recipe.children.includes(active) ? active : recipe.children[recipe.currentTab];
		return (
			this.carryOut(recipe, recipe, leaf, index, () => {
				const shownIndex = shown === undefined ? index : recipe.children.indexOf(shown);
				recipe.selectTabIndex(shownIndex >= 0 ? shownIndex : index);
			}) === 'moved'
		);
	}

	/**
	 * The native move recipe from strip `from` to strip `to` (the same strip for a move inside it):
	 * `removeChild`, `setDimension(null)`, `insertChild`, then `select`, then `requestResize`. When a
	 * step throws, the tab is put back where it was in `from` (see putBack), or, when `from` has left
	 * the layout, kept in `to` or opened again, so it is never left out of every strip, and the
	 * failure is logged. 'failed': the move did not happen as asked.
	 */
	private carryOut(from: TabsMoveRecipe, to: TabsMoveRecipe, leaf: object, index: number, select: () => void): MoveResult {
		const fromIndex = from.children.indexOf(leaf);
		const shown = from.children[from.currentTab];
		try {
			from.removeChild(leaf);
			(leaf as LeafPrivate).setDimension?.(null);
			to.insertChild(index, leaf);
			select();
			this.requestResize();
			return 'moved';
		} catch (e) {
			const back = this.putBack(from, to, leaf, fromIndex, shown);
			console.error(`Tabstrip: moving the tab failed; ${PUT_BACK_TEXT[back]}`, e);
			return 'failed';
		}
	}

	/**
	 * After a failed move: takes the tab out of `to` (when it got there) and inserts it again at
	 * `fromIndex` of `from`, with the same recipe, and shows the tab `from` showed before. That needs
	 * `from` to be in the layout still: Obsidian closes a pane whose last tab is removed, and a tab
	 * inserted into it then shows nowhere. When `from` is gone or does not take the tab back, see
	 * rehome.
	 */
	private putBack(from: TabsMoveRecipe, to: TabsMoveRecipe, leaf: object, fromIndex: number, shown: unknown): PutBack {
		if (this.isAttached(from)) {
			try {
				if (to !== from && to.children.includes(leaf)) to.removeChild(leaf);
				const at = from.children.indexOf(leaf);
				if (at !== fromIndex) {
					if (at >= 0) from.removeChild(leaf);
					(leaf as LeafPrivate).setDimension?.(null);
					from.insertChild(Math.max(0, Math.min(fromIndex, from.children.length)), leaf);
				}
				const shownIndex = shown === undefined ? -1 : from.children.indexOf(shown);
				if (shownIndex >= 0) from.selectTabIndex(shownIndex);
				this.requestResize();
			} catch (e) {
				console.error('Tabstrip: could not put the tab back after a failed move', e);
			}
			if (from.children.includes(leaf) && this.isAttached(from)) return 'back';
		}
		return this.rehome(to, leaf);
	}

	/**
	 * The tab could not go back to its own strip: it stays in (or goes to the end of) the target
	 * strip `to` and is shown there, with the same recipe; when that fails too, its view is opened
	 * again in a new tab of the main area (public `getLeaf('tab')`, `getViewState`, `setViewState`)
	 * and the orphaned leaf is closed (public `detach`).
	 */
	private rehome(to: TabsMoveRecipe, leaf: object): PutBack {
		if (this.isAttached(to)) {
			try {
				if (!to.children.includes(leaf)) {
					(leaf as LeafPrivate).setDimension?.(null);
					to.insertChild(to.children.length, leaf);
				}
				to.selectTabIndex(to.children.indexOf(leaf));
				this.requestResize();
			} catch (e) {
				console.error('Tabstrip: could not keep the tab in the pane it was moved to', e);
			}
			if (to.children.includes(leaf)) return 'kept';
		}
		try {
			const orphan = leaf as WorkspaceLeaf;
			const state = orphan.getViewState();
			const fresh = this.app.workspace.getLeaf('tab');
			fresh.setViewState(state).catch((e: unknown) => {
				console.error('Tabstrip: could not open the tab again', e);
			});
			try {
				orphan.detach();
			} catch (e) {
				console.error('Tabstrip: could not close the tab left out of every pane', e);
			}
			return 'reopened';
		} catch (e) {
			console.error('Tabstrip: could not open the tab again', e);
			return 'lost';
		}
	}

	/**
	 * Whether a tab strip is still in the layout: its root (public `getRoot()`) is the main area or
	 * the pop-out windows' `WorkspaceFloating`, the roots `collectRootTabs` reads strips from. A strip
	 * without `getRoot` cannot be checked and counts as attached.
	 */
	private isAttached(tabs: object): boolean {
		const getRoot = (tabs as { getRoot?: unknown }).getRoot;
		if (typeof getRoot !== 'function') return true;
		const root = (getRoot as () => unknown).call(tabs);
		return root === this.app.workspace.rootSplit || root instanceof WorkspaceFloating;
	}

	private requestResize(): void {
		(this.app.workspace as unknown as WorkspacePrivate).requestResize?.();
	}

	/**
	 * Step V5: a tab row of the vertical strip is being dragged. Obsidian's own tab drag starts for its
	 * leaf with the whitelisted `workspace.onDragLeaf(evt, leaf)`, exactly what a native tab header
	 * does in its dragstart: from then on Obsidian handles drops on the editor area (splits), on other
	 * panes, sidebars and pop-out windows, and a drag out of the window (new window). Returns
	 * 'missing' when the method is not there and 'threw' when it failed; the caller then keeps the drag
	 * going for the strip alone.
	 */
	dragLeaf(evt: DragEvent, leaf: object): DragLeafResult {
		const ws = this.app.workspace as unknown as WorkspacePrivate;
		if (typeof ws.onDragLeaf !== 'function') return 'missing';
		try {
			ws.onDragLeaf(evt, leaf);
			return 'native';
		} catch (e) {
			console.error('Tabstrip: Obsidian could not start the tab drag', e);
			return 'threw';
		}
	}

	/**
	 * Step V5: a drop on the vertical strip (or a keyboard move) puts the tab at `index` of the strip
	 * `paneId` (the index once the tab has left its own strip), with the native move recipe, also from
	 * another strip of the root split: the source strip's `removeChild`, `setDimension(null)`, the
	 * target's `insertChild`, `selectTabIndex`, `requestResize` (what Obsidian's own tab drop does).
	 * `show`: the moved tab becomes its strip's shown tab, as after a native drop; otherwise the shown
	 * tabs stay (keyboard). 'refused' when the recipe is not available or the tab or strip is gone;
	 * 'failed' when a step of the recipe threw: the tab was put back where it was (carryOut).
	 */
	moveTab(leafId: string, paneId: string, index: number, read: WorkspaceRead, show: boolean): MoveResult {
		if (this.caps?.move !== true) return 'refused';
		const strip = read.strips.find((s) => s.paneId === paneId);
		const source = read.strips.find((s) => s.leaves.some((l) => l.id === leafId));
		const leaf = source?.leaves.find((l) => l.id === leafId)?.leaf;
		if (strip === undefined || source === undefined || leaf === undefined) return 'refused';
		const from = source.tabs as unknown as Partial<TabsMoveRecipe>;
		const to = strip.tabs as unknown as Partial<TabsMoveRecipe>;
		if (!isMoveRecipe(from) || !isMoveRecipe(to)) return 'refused';
		if (source === strip && show && from.children.indexOf(leaf) === index) {
			// A drop on its own place: no recipe. Removing the only tab of a pane would make Obsidian
			// close that pane, and the tab would be inserted into a strip that is no longer in the layout.
			from.selectTabIndex(index);
			return 'moved';
		}
		if (source === strip && !show) {
			const at = from.children.indexOf(leaf);
			if (at < 0 || index < 0 || index > from.children.length - 1) return 'refused';
			if (at === index) return 'moved';
			const active = this.activeLeaf();
			const shown = active !== null && from.children.includes(active) ? active : from.children[from.currentTab];
			return this.carryOut(from, from, leaf, index, () => {
				const shownIndex = shown === undefined ? index : from.children.indexOf(shown);
				from.selectTabIndex(shownIndex >= 0 ? shownIndex : index);
			});
		}
		if (!from.children.includes(leaf)) return 'refused';
		const max = to.children.length - (source === strip ? 1 : 0);
		if (index < 0 || index > max) return 'refused';
		return this.carryOut(from, to, leaf, index, () => {
			to.selectTabIndex(to.children.indexOf(leaf));
		});
	}

	/**
	 * Shows a tab in a strip that does not hold the active leaf, with the whitelisted
	 * `selectTabIndex` only: unlike `revealLeaf` it neither focuses that strip's window nor loads a
	 * deferred tab, and the active leaf stays where it is (L7 review round 1). False when the
	 * recipe is not available or the tab is not in the strip.
	 */
	showInStrip(tabs: object, leaf: object): boolean {
		if (this.caps?.move !== true) return false;
		const recipe = tabs as unknown as TabsMoveRecipe;
		const index = recipe.children.indexOf(leaf);
		if (index < 0) return false;
		recipe.selectTabIndex(index);
		return true;
	}

	/**
	 * New empty tab at `index` of the strip (public `createLeafInParent`); it becomes the active
	 * leaf. Returns its id (private `leaf.id`, read here so callers never touch the leaf), or null
	 * when the tab could not be created or has no readable id.
	 */
	createLeafAt(tabs: object, index: number): string | null {
		if (this.caps?.createLeaf !== true) return null;
		const count = (tabs as unknown as TabsMoveRecipe).children.length;
		const at = Math.max(0, Math.min(index, count));
		// The public signature names WorkspaceSplit; Obsidian inserts into any parent, here a tab strip.
		const leaf = this.app.workspace.createLeafInParent(tabs as unknown as WorkspaceSplit, at);
		return readLeafId(leaf);
	}

	/**
	 * Carries out the model's ops in order (see core `applyOps` for their meaning). Moves are
	 * skipped when the move recipe is not available; anything that no longer matches the live
	 * workspace is skipped too. `options.focus`: see ApplyOptions.
	 */
	applyOps(ops: readonly Op[], read: WorkspaceRead, options: ApplyOptions = {}): ApplyResult {
		let applied = 0;
		let skipped = 0;
		const strips = new Map<string, StripRead>(read.strips.map((s) => [s.paneId, s]));
		const leaves = new Map<string, object>();
		for (const s of read.strips) for (const l of s.leaves) leaves.set(l.id, l.leaf);
		for (const op of ops) {
			if (this.applyOne(op, strips, leaves, read.snapshot, options.focus ?? true)) applied++;
			else skipped++;
		}
		return { applied, skipped };
	}

	private applyOne(op: Op, strips: Map<string, StripRead>, leaves: Map<string, object>, snapshot: Snapshot, focus: boolean): boolean {
		switch (op.kind) {
			case 'move': {
				const strip = strips.get(op.paneId);
				const leaf = leaves.get(op.leafId);
				if (strip === undefined || leaf === undefined) return false;
				return this.moveLeaf(strip.tabs, leaf, op.index);
			}
			case 'activate': {
				const leaf = leaves.get(op.leafId) as WorkspaceLeaf | undefined;
				if (leaf === undefined) return false;
				const strip = [...strips.values()].find((s) => s.leaves.some((l) => l.id === op.leafId));
				if (holdsActive(strip, snapshot)) this.app.workspace.setActiveLeaf(leaf, { focus });
				else if (strip === undefined || !this.showInStrip(strip.tabs, leaf)) void this.app.workspace.revealLeaf(leaf);
				return true;
			}
			case 'close': {
				let any = false;
				for (const id of op.leafIds) {
					const leaf = leaves.get(id) as WorkspaceLeaf | undefined;
					if (leaf === undefined) continue;
					leaf.detach();
					any = true;
				}
				return any;
			}
			case 'create': {
				const strip = strips.get(op.paneId);
				if (strip === undefined) return false;
				// createLeafInParent always makes the new tab the active leaf. The op only shows it in
				// its strip unless that strip held the active leaf (core semantics): give the focus back.
				const before = holdsActive(strip, snapshot) || snapshot.activeLeafId === null ? undefined : leaves.get(snapshot.activeLeafId);
				const created = this.createLeafAt(strip.tabs, op.index) !== null;
				if (created && before !== undefined) this.app.workspace.setActiveLeaf(before as WorkspaceLeaf, { focus: true });
				return created;
			}
		}
	}
}
