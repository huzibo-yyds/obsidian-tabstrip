/**
 * Data types of the pure group model.
 *
 * Everything in src/core is plain TypeScript: no `obsidian` import, no page or
 * element access, no timers, no randomness. The adapter turns the live workspace
 * into a `Snapshot`, calls the functions here, and carries out the returned `Op`s.
 */

/** Chrome's nine tab group colors, in Chrome's order. */
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

/** What a tab shows, used later to find a leaf again when its id is lost. */
export interface Fingerprint {
	readonly viewType: string;
	readonly path?: string;
}

/** One tab as seen by the model. */
export interface LeafInfo {
	readonly id: string;
	readonly pinned: boolean;
	readonly fingerprint: Fingerprint;
}

export type PaneKind = 'main' | 'popout';

/** One tab strip (an Obsidian `WorkspaceTabs`) in the main area or a pop-out window. */
export interface PaneInfo {
	readonly id: string;
	readonly kind: PaneKind;
	/** Tabs in Obsidian's own order. The model never stores this order. */
	readonly leaves: readonly LeafInfo[];
	/** The tab this strip shows, or null when the strip is empty. */
	readonly currentLeafId: string | null;
	/** Stacked tabs: groups show their color only and cannot hide tabs. */
	readonly stacked?: boolean;
	/**
	 * The window the strip is in (strips of one window share it). Used only to find a tab again by
	 * its file after a restart (unique within one window). Missing: main strips share one window,
	 * every pop-out strip is its own.
	 */
	readonly windowId?: string;
}

/** Plain-data picture of all tab strips, produced by the adapter. */
export interface Snapshot {
	readonly panes: readonly PaneInfo[];
	/** The focused tab (always the current tab of its strip), or null. */
	readonly activeLeafId: string | null;
}

export interface Group {
	readonly id: string;
	/** May be empty: the chip then shows a color dot only. */
	readonly name: string;
	readonly color: GroupColor;
	readonly collapsed: boolean;
}

/** Leaf → group link, with the last seen fingerprint of that leaf. */
export interface Membership {
	readonly leafId: string;
	readonly groupId: string;
	readonly fingerprint: Fingerprint;
}

/** Record of a group member that was closed, so undo-close can put it back. */
export interface Tombstone {
	readonly leafId: string;
	readonly groupId: string;
	readonly groupName: string;
	readonly groupColor: GroupColor;
	/**
	 * Strip the leaf was closed in, or null once that strip has closed. Then there is
	 * no slot to go back to: an undo-closed tab stays ungrouped where Obsidian puts it,
	 * even in a new strip that reuses the old id.
	 */
	readonly paneId: string | null;
	/** Index of the leaf in that strip when it was closed. */
	readonly paneIndex: number;
	/** Position of the leaf among its group's members when it was closed. */
	readonly indexInGroup: number;
	readonly fingerprint: Fingerprint;
	/**
	 * Nearest tabs to the left and right that stayed open when it closed (null at the strip's end).
	 * Strip ids are not kept across a restart, so these find the strip again (persistence, step L6).
	 */
	readonly left?: string | null;
	readonly right?: string | null;
}

/**
 * Everything the model owns. Tab order and pane membership of a group are never
 * stored: both always come from the snapshot.
 */
export interface GroupState {
	/** Groups in creation order. */
	readonly groups: readonly Group[];
	/** Sorted by leaf id, at most one entry per leaf. */
	readonly members: readonly Membership[];
	/** Newest first. */
	readonly tombstones: readonly Tombstone[];
	/** Next number for a fresh group id. Never reused, so tombstoned ids stay unique. */
	readonly nextGroupSeq: number;
}

/**
 * Instructions for the adapter. Ops are applied in order; indexes refer to the
 * strip as it is when that op runs. See `applyOps` for the exact meaning.
 */
export type Op =
	/** Take the leaf out of its strip and insert it at `index` of strip `paneId`. */
	| { readonly kind: 'move'; readonly leafId: string; readonly paneId: string; readonly index: number }
	/** Show the leaf in its strip. It becomes the active leaf only if its strip held the active leaf. */
	| { readonly kind: 'activate'; readonly leafId: string }
	/** Close these leaves. */
	| { readonly kind: 'close'; readonly leafIds: readonly string[] }
	/** Create an empty tab at `index` of strip `paneId` and show it, like `activate`. */
	| { readonly kind: 'create'; readonly paneId: string; readonly index: number };

export interface CommandResult {
	readonly state: GroupState;
	readonly ops: readonly Op[];
}

/** Where the pointer was when a dragged tab was dropped (step L7: see core `dropIntentOf`). */
export interface DropIntent {
	readonly leafId: string;
	/**
	 * The group whose member or chip was under the pointer, or null for "outside any group". A
	 * collapsed group is never joined by a drop (rule 4): its tabs would be hidden, or it would open.
	 */
	readonly joinGroupId: string | null;
	/**
	 * The pointer was on the chip of this collapsed group. Obsidian then inserts the tab just before
	 * the group, while its drop line shows just after the chip, where the group's hidden tabs are: the
	 * tab is moved to just after the group, ungrouped and visible, like a drop into its middle.
	 */
	readonly afterGroupId?: string;
}

export interface ReconcileContext {
	readonly dropIntent?: DropIntent;
	/**
	 * Set when the layout change was caused by applying our own ops. A stale drop
	 * intent is then ignored. Reconcile is idempotent, so such a change yields no ops.
	 */
	readonly txnId?: string;
}

/** Something the UI may want to tell the user about. */
export interface ModelEvent {
	readonly kind: 'pinned-out';
	readonly leafId: string;
	readonly groupId: string;
	readonly groupName: string;
}

export interface ReconcileResult extends CommandResult {
	readonly events: readonly ModelEvent[];
}

export type Violation =
	| { readonly kind: 'duplicate-leaf'; readonly leafId: string }
	| { readonly kind: 'pinned-not-prefix'; readonly paneId: string; readonly leafId: string }
	| { readonly kind: 'duplicate-group'; readonly groupId: string }
	| { readonly kind: 'duplicate-member'; readonly leafId: string }
	| { readonly kind: 'unknown-leaf'; readonly leafId: string }
	| { readonly kind: 'unknown-group'; readonly leafId: string; readonly groupId: string }
	| { readonly kind: 'pinned-member'; readonly leafId: string }
	| { readonly kind: 'empty-group'; readonly groupId: string }
	| { readonly kind: 'group-spans-panes'; readonly groupId: string }
	| { readonly kind: 'group-not-contiguous'; readonly groupId: string }
	| { readonly kind: 'hidden-current'; readonly paneId: string; readonly leafId: string }
	| { readonly kind: 'hidden-active'; readonly leafId: string };
