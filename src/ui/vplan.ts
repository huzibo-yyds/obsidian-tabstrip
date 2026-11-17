/**
 * Pure part of the vertical tab strip (step V1): which rows it shows, in which order, with which
 * marks. Rows are the tabs of the main window's root split (strips of kind 'main'), pane after pane
 * in Obsidian's own order. Pop-out windows keep their horizontal tab bar (requirements 3: one strip
 * per window is P1), so their tabs are not listed. No page access here.
 */
import type { GroupColor, GroupState } from '../core/types';

export interface VStripInput {
	readonly paneId: string;
	readonly kind: 'main' | 'popout';
	readonly leaves: readonly { readonly id: string; readonly info: { readonly pinned: boolean } }[];
	readonly currentLeafId: string | null;
}

export interface VRowPlan {
	readonly leafId: string;
	readonly paneId: string;
	/** First row of a pane after the first pane (the strip draws a separator above it). */
	readonly paneStart: boolean;
	/** Shown in its pane. */
	readonly current: boolean;
	/**
	 * The highlighted tab: the focused one, or, while the focus is outside the root split (a sidebar
	 * view), the most recently active root tab, so exactly one row stays highlighted (as the native
	 * tab bar keeps its selected tab).
	 */
	readonly active: boolean;
	readonly pinned: boolean;
	/** Group membership; the row then gets the group's colour bar. */
	readonly groupId: string | null;
	readonly color: GroupColor | null;
}

/** What the rows need of the group model: group colours and memberships (GroupState fits). */
export interface VColorState {
	readonly groups: readonly Pick<GroupState['groups'][number], 'id' | 'color'>[];
	readonly members: readonly Pick<GroupState['members'][number], 'leafId' | 'groupId'>[];
}

export function planVerticalRows(strips: readonly VStripInput[], state: VColorState, activeLeafId: string | null, recentLeafId: string | null = null): VRowPlan[] {
	const highlighted = highlightedLeaf(strips, activeLeafId, recentLeafId);
	const colors = new Map(state.groups.map((g) => [g.id, g.color]));
	const memberOf = new Map<string, string>();
	for (const m of state.members) if (colors.has(m.groupId)) memberOf.set(m.leafId, m.groupId);
	const rows: VRowPlan[] = [];
	let pane = 0;
	for (const strip of strips) {
		if (strip.kind !== 'main' || strip.leaves.length === 0) continue;
		strip.leaves.forEach((leaf, i) => {
			const groupId = memberOf.get(leaf.id) ?? null;
			rows.push({
				leafId: leaf.id,
				paneId: strip.paneId,
				paneStart: pane > 0 && i === 0,
				current: leaf.id === strip.currentLeafId,
				active: leaf.id === highlighted,
				pinned: leaf.info.pinned,
				groupId,
				color: groupId === null ? null : (colors.get(groupId) ?? null),
			});
		});
		pane++;
	}
	return rows;
}

/** The focused root tab, else the recent root tab, else the first pane's shown tab. */
function highlightedLeaf(strips: readonly VStripInput[], activeLeafId: string | null, recentLeafId: string | null): string | null {
	const main = strips.filter((s) => s.kind === 'main' && s.leaves.length > 0);
	const listed = (id: string | null): boolean => id !== null && main.some((s) => s.leaves.some((l) => l.id === id));
	if (listed(activeLeafId)) return activeLeafId;
	if (listed(recentLeafId)) return recentLeafId;
	return main[0]?.currentLeafId ?? null;
}

/** Stable text form of a row's marks (not its title or icon), used to skip DOM writes. */
export function rowKey(row: VRowPlan): string {
	return [row.paneStart ? 'p' : '', row.current ? 'c' : '', row.active ? 'a' : '', row.pinned ? 'P' : '', row.groupId ?? '', row.color ?? ''].join('|');
}

/**
 * Heuristic for the Vertical Tabs community plugin being on (no public API lists other plugins, and
 * the plugin registry is not on the private API whitelist): its sidebar view is open, or it has put
 * one of its `vt-` body classes on the page.
 */
export function looksLikeVerticalTabs(openViews: number, bodyClasses: readonly string[]): boolean {
	return openViews > 0 || bodyClasses.some((c) => c.startsWith('vt-'));
}

// ---------------------------------------------------------------- the full list (steps V2-V4)

/** A strip as the list needs it: V1's input plus the deferred flags and the stacked mode. */
export interface VListStrip extends VStripInput {
	readonly leaves: readonly { readonly id: string; readonly info: { readonly pinned: boolean }; readonly deferred?: boolean }[];
	/** Stacked tabs never hide tabs (requirements 5.1): a collapsed group shows its members there. */
	readonly stacked?: boolean;
}

/** What the list needs of the group model (GroupState fits). */
export interface VGroupState {
	readonly groups: readonly { readonly id: string; readonly color: GroupColor; readonly name?: string; readonly collapsed?: boolean }[];
	readonly members: readonly { readonly leafId: string; readonly groupId: string }[];
}

/** Position in the tree (aria-level, aria-setsize, aria-posinset). */
export interface VTreePos {
	readonly level: number;
	readonly setsize: number;
	readonly posinset: number;
}

export interface VTabItem extends VTreePos {
	readonly kind: 'tab';
	/** Unique in the list: `t:<leafId>`. */
	readonly key: string;
	readonly row: VRowPlan;
	/** Not loaded yet (Obsidian's deferred view): drawn greyed. */
	readonly deferred: boolean;
}

export interface VGroupItem extends VTreePos {
	readonly kind: 'group';
	readonly key: string;
	readonly groupId: string;
	readonly paneId: string;
	readonly name: string;
	readonly color: GroupColor;
	/**
	 * Collapsed as drawn: collapsed in the model and its members hidden here (the arrow points right,
	 * aria-expanded is false). A stacked pane never hides tabs, so there a collapsed group is drawn
	 * expanded: the tree never says "collapsed" while it lists the members (review round 3).
	 */
	readonly collapsed: boolean;
	/** Members of the group in this pane, hidden or not. */
	readonly count: number;
	/** The highlighted tab is a member (the icon bar marks the group). */
	readonly holdsActive: boolean;
	/** Step V5: the group's tabs in this pane, in tab order, hidden or not (drop spots). */
	readonly memberIds: readonly string[];
}

export interface VNewItem extends VTreePos {
	readonly kind: 'new';
	readonly key: string;
	readonly paneId: string;
}

export type VItem = VTabItem | VGroupItem | VNewItem;

export interface VSection {
	/** 'pinned', or `p:<paneId>`. */
	readonly key: string;
	readonly kind: 'pinned' | 'pane';
	readonly paneId: string | null;
	/** 1-based pane number (pane sections), 0 for the pinned area. */
	readonly index: number;
	/** The pane title shows (more than one pane). */
	readonly titled: boolean;
	readonly items: readonly VItem[];
}

export interface VListPlan {
	readonly sections: readonly VSection[];
	/** Every tab row of the list, in list order (pinned area first). Hidden members are not listed. */
	readonly rows: readonly VRowPlan[];
}

/**
 * The vertical strip's list (requirements 5.2): a pinned area first (the pinned tabs of every pane,
 * pane after pane), then one section per pane of the root split; a section has a title only when
 * there is more than one pane. In a section, each group gets a row (arrow, name, colour, member
 * count) before its members; members of a collapsed group are hidden like in the horizontal strip
 * (same model), except the pane's shown tab, which is never hidden. The last row of a section is
 * "New tab". Tree levels: tabs and group rows 1, members 2.
 */
export function planVerticalList(strips: readonly VListStrip[], state: VGroupState, activeLeafId: string | null, recentLeafId: string | null = null): VListPlan {
	const rows = planVerticalRows(strips, state, activeLeafId, recentLeafId);
	const byLeaf = new Map(rows.map((r) => [r.leafId, r]));
	const groups = new Map(state.groups.map((g) => [g.id, g]));
	const deferred = new Set<string>();
	for (const s of strips) for (const l of s.leaves) if (l.deferred === true) deferred.add(l.id);
	const main = strips.filter((s) => s.kind === 'main' && s.leaves.length > 0);
	const sections: VSection[] = [];
	const listed: VRowPlan[] = [];
	const tab = (row: VRowPlan, level: number): VTabItem => ({ kind: 'tab', key: `t:${row.leafId}`, row, deferred: deferred.has(row.leafId), level, setsize: 0, posinset: 0 });

	const pinned: VItem[] = [];
	for (const s of main) for (const l of s.leaves) {
		const row = byLeaf.get(l.id);
		if (row?.pinned === true) pinned.push(tab(row, 1));
	}
	if (pinned.length > 0) sections.push({ key: 'pinned', kind: 'pinned', paneId: null, index: 0, titled: false, items: numbered(pinned) });

	main.forEach((s, i) => {
		const items: VItem[] = [];
		const counts = new Map<string, number>();
		for (const l of s.leaves) {
			const g = byLeaf.get(l.id)?.groupId;
			if (g !== null && g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1);
		}
		const seen = new Set<string>();
		for (const l of s.leaves) {
			const row = byLeaf.get(l.id);
			if (row === undefined || row.pinned) continue;
			const groupId = row.groupId;
			const group = groupId === null ? undefined : groups.get(groupId);
			if (groupId === null || group === undefined) {
				items.push(tab(row, 1));
				continue;
			}
			if (!seen.has(groupId)) {
				seen.add(groupId);
				const memberIds = s.leaves.filter((m) => byLeaf.get(m.id)?.groupId === groupId).map((m) => m.id);
				items.push({
					kind: 'group',
					key: `g:${groupId}`,
					groupId,
					paneId: s.paneId,
					name: group.name ?? '',
					color: group.color,
					collapsed: group.collapsed === true && s.stacked !== true,
					count: counts.get(groupId) ?? 1,
					holdsActive: memberIds.some((id) => byLeaf.get(id)?.active === true),
					memberIds,
					level: 1,
					setsize: 0,
					posinset: 0,
				});
			}
			const hidden = group.collapsed === true && s.stacked !== true && !row.current;
			if (!hidden) items.push(tab(row, 2));
		}
		items.push({ kind: 'new', key: `n:${s.paneId}`, paneId: s.paneId, level: 1, setsize: 0, posinset: 0 });
		sections.push({ key: `p:${s.paneId}`, kind: 'pane', paneId: s.paneId, index: i + 1, titled: main.length > 1, items: numbered(items) });
	});
	for (const section of sections) for (const item of section.items) if (item.kind === 'tab') listed.push(item.row);
	return { sections, rows: listed };
}

/** Fills in aria-setsize and aria-posinset: level-1 items per section, level-2 items per group. */
function numbered(items: readonly VItem[]): VItem[] {
	const top = items.filter((it) => it.level === 1).length;
	const out: VItem[] = [];
	let topPos = 0;
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (it === undefined) continue;
		if (it.level === 1) {
			out.push({ ...it, setsize: top, posinset: ++topPos });
			continue;
		}
		// A run of level-2 items (one group's shown members).
		let start = i;
		while (start > 0 && items[start - 1]?.level === 2) start--;
		let end = i;
		while (end + 1 < items.length && items[end + 1]?.level === 2) end++;
		out.push({ ...it, setsize: end - start + 1, posinset: i - start + 1 });
	}
	return out;
}

/** Stable text form of an item's marks (not a tab's title or icon), used to skip DOM writes. */
export function itemKey(item: VItem, label: string): string {
	const pos = `${String(item.level)}/${String(item.posinset)}/${String(item.setsize)}`;
	switch (item.kind) {
		case 'tab':
			return `${rowKey(item.row)}|${item.deferred ? 'd' : ''}|${pos}`;
		case 'group':
			return `${item.color}|${item.collapsed ? 'c' : ''}|${String(item.count)}|${item.holdsActive ? 'a' : ''}|${item.name}|${label}|${pos}`;
		case 'new':
			return `${label}|${pos}`;
	}
}
