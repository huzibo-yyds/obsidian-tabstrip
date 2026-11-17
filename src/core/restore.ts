/**
 * Start-up restore (requirements 7.3, stage 1): turns a stored session back into a group state for
 * the tabs that are open now.
 *
 * Recovery order, per tab:
 *  1. the same leaf id (Obsidian keeps leaf ids in its layout across a restart);
 *  3. a recently closed record: a tab whose id is in the closed list and is open again goes back
 *     into its group like a native undo-close (the caller runs reconcile with a previous snapshot
 *     that lacks these tabs, see `returning`);
 *  4. a unique file fingerprint: exactly one open tab of that file and view type in the window;
 *  5. a group none of whose tabs was found is parked in the unmatched list.
 * (Step 2, a key embedded in the layout, is stage 3.)
 *
 * Restored groups keep name, colour, collapsed state and creation order, and end contiguous: when
 * their tabs are scattered they are lined up in stored order at the leftmost one's place. A group
 * that holds a strip's shown tab or the active tab is expanded. Pure.
 */
import { canHide, pinnedPrefixLength } from './model';
import {
	fingerprintFromStored,
	SESSION_LIMITS,
	tombstoneFromClosed,
	type Session,
	type StoredFingerprint,
	type UnmatchedGroup,
} from './persist';
import { planReorder } from './sequence';
import type { Group, GroupState, Op, PaneInfo, Snapshot, Tombstone } from './types';
import { at, get } from './util';
import { Work } from './work';

export interface RestoreReport {
	/** Tabs matched by leaf id. */
	readonly byId: number;
	/** Tabs that came back through a recently closed record. */
	readonly byClosed: number;
	/** Tabs matched by a unique file fingerprint. */
	readonly byFingerprint: number;
	/** Stored members not found (their group may still be restored with the others). */
	readonly missing: number;
	readonly restoredGroups: number;
	/** Groups parked in the unmatched list by this restore (all of them are kept). */
	readonly unmatchedGroups: number;
	/** Older unmatched entries dropped because the list is full (SESSION_LIMITS.unmatched). */
	readonly droppedUnmatched: number;
}

export interface RestoreResult {
	readonly state: GroupState;
	/** Moves that line up scattered groups; to be carried out before the first pass. */
	readonly ops: readonly Op[];
	/** The whole unmatched list (new ones first, then the stored ones). */
	readonly unmatched: readonly UnmatchedGroup[];
	/**
	 * Open tabs with a recently closed record. Reconcile them from a previous snapshot without these
	 * tabs (`withoutLeaves`), so they go back into their groups the way an undo-close does.
	 */
	readonly returning: readonly string[];
	readonly report: RestoreReport;
}

/** The window a strip is in: main strips share one window, each pop-out strip is its own. */
export function windowOf(pane: PaneInfo): string {
	return pane.windowId ?? (pane.kind === 'main' ? 'main' : `popout:${pane.id}`);
}

/** The snapshot without these tabs (the previous snapshot for tabs that "come back"). */
export function withoutLeaves(snapshot: Snapshot, leafIds: readonly string[]): Snapshot {
	if (leafIds.length === 0) return snapshot;
	const drop = new Set(leafIds);
	return {
		panes: snapshot.panes.map((p) => {
			const leaves = p.leaves.filter((l) => !drop.has(l.id));
			const current = p.currentLeafId !== null && drop.has(p.currentLeafId) ? (leaves[0]?.id ?? null) : p.currentLeafId;
			return { ...p, leaves, currentLeafId: current };
		}),
		activeLeafId: snapshot.activeLeafId !== null && drop.has(snapshot.activeLeafId) ? null : snapshot.activeLeafId,
	};
}

/** A group to put on the strip: its record and its tabs in the wanted order. */
interface Placement {
	readonly group: Group;
	readonly leafIds: readonly string[];
}

/** Open, unpinned tabs not taken by anything yet. */
class Claims {
	readonly taken = new Set<string>();
	constructor(private readonly w: Work) {}

	free(leafId: string): boolean {
		return this.w.leaves.has(leafId) && !this.w.pinned(leafId) && !this.taken.has(leafId);
	}
}

/** Fingerprints that can identify a tab: an empty tab looks like every other empty tab. */
function identifying(fp: StoredFingerprint): boolean {
	return fp.path !== undefined || fp.type !== 'empty';
}

/**
 * Finds tabs for `members` by fingerprint, in one window. `inWindow` null: the window where the most
 * members have a usable candidate (first such window in strip order on a tie). By default only a
 * unique candidate (exactly one free tab of that fingerprint in the window) counts; with
 * `leftmost` (a command the user runs on purpose) a member with several candidates takes the
 * leftmost free one. `inStrip`: only tabs in that strip count. Returns member index → leaf id;
 * claims the tabs.
 */
function matchFingerprints(
	w: Work,
	claims: Claims,
	members: readonly (StoredFingerprint | null)[],
	inWindow: string | null,
	leftmost = false,
	inStrip: string | null = null,
): Map<number, string> {
	const windowOfLeaf = new Map<string, string>();
	const windows: string[] = [];
	for (const pane of w.panes.values()) {
		const win = windowOf(pane);
		if (!windows.includes(win)) windows.push(win);
		for (const id of w.order(pane.id)) windowOfLeaf.set(id, win);
	}
	const candidates = (fp: StoredFingerprint, win: string): string[] => {
		const want = fingerprintFromStored(fp);
		const found: string[] = [];
		// Strip order, so the first one found is the leftmost.
		for (const id of windowOfLeaf.keys()) {
			if (!claims.free(id) || windowOfLeaf.get(id) !== win) continue;
			if (inStrip !== null && w.paneOf.get(id) !== inStrip) continue;
			const leaf = get(w.leaves, id);
			if (leaf.fingerprint.viewType === want.viewType && leaf.fingerprint.path === want.path) found.push(id);
		}
		return found;
	};
	const usable = (n: number): boolean => (leftmost ? n >= 1 : n === 1);
	let home = inWindow;
	if (home === null) {
		let best = 0;
		for (const win of windows) {
			const unique = members.filter((fp) => fp !== null && identifying(fp) && usable(candidates(fp, win).length)).length;
			if (unique > best) {
				best = unique;
				home = win;
			}
		}
	}
	const matched = new Map<number, string>();
	if (home === null) return matched;
	members.forEach((fp, i) => {
		if (fp === null || !identifying(fp)) return;
		const found = candidates(fp, home);
		if (!usable(found.length)) return;
		const id = at(found, 0);
		claims.taken.add(id);
		matched.set(i, id);
	});
	return matched;
}

/** The strip that holds most of the tabs (the first tab's strip on a tie). */
function homeStrip(w: Work, leafIds: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const id of leafIds) {
		const pane = get(w.paneOf, id);
		counts.set(pane, (counts.get(pane) ?? 0) + 1);
	}
	let best = get(w.paneOf, at(leafIds, 0));
	for (const [pane, n] of counts) if (n > (counts.get(best) ?? 0)) best = pane;
	return best;
}

/**
 * Makes each group a member block in one strip. Tabs outside the home strip stay ungrouped. A
 * contiguous block keeps Obsidian's order; scattered tabs are lined up in the wanted order at the
 * leftmost one's place, or just after the group that place falls into.
 */
function placeGroups(w: Work, placements: readonly Placement[]): void {
	for (const { group, leafIds } of placements) {
		if (leafIds.length === 0) continue;
		const paneId = homeStrip(w, leafIds);
		const block = leafIds.filter((id) => w.paneOf.get(id) === paneId);
		const order = w.order(paneId);
		const positions = block.map((id) => order.indexOf(id));
		const first = Math.min(...positions);
		if (Math.max(...positions) - first + 1 !== block.length) {
			const chosen = new Set(block);
			const rest = order.filter((id) => !chosen.has(id));
			let insertAt = Math.max(first, pinnedPrefixLength(rest, (id) => w.pinned(id)));
			const left = insertAt > 0 ? w.memberOf.get(at(rest, insertAt - 1)) : undefined;
			if (left !== undefined) {
				while (insertAt < rest.length && w.memberOf.get(at(rest, insertAt)) === left) insertAt++;
			}
			w.reorder(paneId, [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)], planReorder);
		}
		w.setGroup(group);
		for (const id of block) w.memberOf.set(id, group.id);
	}
}

/** Expands a collapsed group that holds a strip's shown tab or the active tab (never hide them). */
function revealShown(w: Work): void {
	const shown = [...w.panes.values()].map((p) => p.currentLeafId);
	shown.push(w.snapshot.activeLeafId);
	for (const id of shown) {
		if (id === null || !w.leaves.has(id)) continue;
		const group = w.groupOf(id);
		if (group === undefined || !group.collapsed || !canHide(get(w.panes, get(w.paneOf, id)))) continue;
		w.setGroup({ ...group, collapsed: false });
	}
}

/**
 * The strip of a closed record in this session: the strip that now holds its left or right
 * neighbour. Strip ids are numbered per session, so a stored one means nothing here.
 */
function remapTombstone(w: Work, t: Tombstone): Tombstone {
	if (t.paneId === null) return t;
	for (const neighbour of [t.left, t.right]) {
		if (neighbour === undefined || neighbour === null) continue;
		const pane = w.paneOf.get(neighbour);
		if (pane !== undefined) return { ...t, paneId: pane };
	}
	return { ...t, paneId: null };
}

/**
 * Whether the first pass puts a returning closed tab back into its group: the same conditions as
 * reconcile's undo-close (not pinned, and in the strip its record points to). Keep the two in step.
 */
function goesBack(w: Work, t: Tombstone): boolean {
	return !w.pinned(t.leafId) && t.paneId !== null && w.paneOf.get(t.leafId) === t.paneId;
}

export function restoreSession(session: Session, snapshot: Snapshot): RestoreResult {
	const seed: GroupState = { groups: [], members: [], tombstones: [], nextGroupSeq: session.nextGroupSeq };
	const w = new Work(snapshot, seed);
	w.tombstones = session.closed.map((c) => remapTombstone(w, tombstoneFromClosed(c)));
	const claims = new Claims(w);

	// 1. Leaf ids.
	const found = session.groups.map((g) =>
		g.members.map((m) => {
			if (!claims.free(m.leafId)) return null;
			claims.taken.add(m.leafId);
			return m.leafId;
		}),
	);
	const byId = found.reduce((n, ids) => n + ids.filter((id) => id !== null).length, 0);

	// 3. Recently closed records whose tab is open again (and not taken by step 1).
	const returning: string[] = [];
	for (const t of w.tombstones) {
		if (returning.includes(t.leafId) || !claims.free(t.leafId)) continue;
		claims.taken.add(t.leafId);
		returning.push(t.leafId);
	}

	// 4. Unique fingerprints, in the window of the tabs found by id.
	let byFingerprint = 0;
	session.groups.forEach((g, gi) => {
		const ids = at(found, gi);
		if (ids.every((id) => id !== null)) return;
		const firstFound = ids.find((id): id is string => id !== null);
		const inWindow = firstFound === undefined ? null : windowOf(get(w.panes, get(w.paneOf, firstFound)));
		const wanted = g.members.map((m, i) => (ids[i] === null ? m : null));
		for (const [i, id] of matchFingerprints(w, claims, wanted, inWindow)) {
			ids[i] = id;
			byFingerprint++;
		}
	});

	// 5. Groups with no tab at all are parked, except a group a returning closed tab rebuilds (it
	// comes back through step 3 under the same id, so a parked copy would be a second, stale entry).
	// Only tabs the first pass really puts back count (review round 5): a returning tab whose record
	// has no strip any more, or that is in another strip now, stays ungrouped, so its group is parked.
	const revived = new Set<string>();
	for (const id of returning) {
		const t = w.tombstones.find((x) => x.leafId === id);
		if (t !== undefined && goesBack(w, t)) revived.add(t.groupId);
	}
	const placements: Placement[] = [];
	const parked: UnmatchedGroup[] = [];
	let missing = 0;
	session.groups.forEach((g, gi) => {
		const ids = at(found, gi).filter((id): id is string => id !== null);
		missing += g.members.length - ids.length;
		if (ids.length === 0 && revived.has(g.groupId)) return;
		if (ids.length > 0) {
			placements.push({ group: { id: g.groupId, name: g.name, color: g.color, collapsed: g.collapsed }, leafIds: ids });
		} else {
			parked.push({
				groupId: g.groupId,
				name: g.name,
				color: g.color,
				collapsed: g.collapsed,
				members: g.members.map((m) => (m.path === undefined ? { type: m.type } : { type: m.type, path: m.path })),
			});
		}
	});
	placeGroups(w, placements);
	revealShown(w);
	const state = w.finish();
	// New entries first; when the list is full the oldest go, and the report says how many.
	const list = [...parked, ...session.unmatched.filter((u) => !revived.has(u.groupId))];
	const unmatched = list.slice(0, SESSION_LIMITS.unmatched);
	return {
		state,
		ops: w.ops,
		unmatched,
		returning,
		report: {
			byId,
			byClosed: returning.length,
			byFingerprint,
			missing,
			restoredGroups: state.groups.length,
			unmatchedGroups: Math.min(parked.length, unmatched.length),
			droppedUnmatched: list.length - unmatched.length,
		},
	};
}

/**
 * The unmatched entries whose id is not a live group. A closed tab that comes back (undo-close)
 * rebuilds its group under the stored id; when that group was parked, the parked entry is the same
 * group and is dropped, so a group id is never both live and unmatched (review round 3).
 */
export function dropRevived(unmatched: readonly UnmatchedGroup[], state: GroupState): readonly UnmatchedGroup[] {
	if (unmatched.length === 0) return unmatched;
	const live = new Set(state.groups.map((g) => g.id));
	return unmatched.some((u) => live.has(u.groupId)) ? unmatched.filter((u) => !live.has(u.groupId)) : unmatched;
}

export interface UnmatchedResult {
	readonly state: GroupState;
	readonly ops: readonly Op[];
	/** Groups recreated (as they were stored). */
	readonly restored: readonly UnmatchedGroup[];
	/**
	 * What stays in the unmatched list: groups without any matching tab, unchanged, and for a group
	 * recreated in part, its members without a tab, as a smaller entry under a fresh id.
	 */
	readonly remaining: readonly UnmatchedGroup[];
	/** Members of recreated groups that found no tab (kept in `remaining`). */
	readonly leftMembers: number;
	/** Entries dropped from `remaining` because the list is full (oldest first; reported, never silent). */
	readonly dropped: number;
}

/**
 * "Restore unmatched groups": recreates each unmatched group from open tabs that are in no group
 * and match its members' fingerprints in one window (several matches: the leftmost free tab).
 * Groups that match nothing stay in the list; members of a recreated group that match nothing stay
 * too, as a smaller entry, so running the command again later can bring them back. A recreated
 * group keeps its id when it is free, its name, colour and collapsed state (a group holding a
 * shown tab is expanded).
 */
export function restoreUnmatched(state: GroupState, snapshot: Snapshot, unmatched: readonly UnmatchedGroup[]): UnmatchedResult {
	const w = new Work(snapshot, state);
	const claims = new Claims(w);
	for (const id of w.memberOf.keys()) claims.taken.add(id);
	// `taken`: ids of groups and closed records (a recreated group may not reuse them); `used`: those,
	// the list's ids and every id handed out here (fresh ids avoid all of them).
	const used = new Set([...w.groups.keys(), ...w.tombstones.map((t) => t.groupId)]);
	const placements: Placement[] = [];
	const restored: UnmatchedGroup[] = [];
	const remaining: UnmatchedGroup[] = [];
	const left: UnmatchedGroup[] = [];
	const taken = new Set(used);
	for (const g of unmatched) used.add(g.groupId);
	const fresh = (): string => {
		let id = w.freshGroupId();
		while (used.has(id)) id = w.freshGroupId();
		used.add(id);
		return id;
	};
	for (const g of unmatched) {
		let matched = matchFingerprints(w, claims, g.members, null, true);
		if (matched.size === 0) {
			remaining.push(g);
			continue;
		}
		// A group lives in one strip (placeGroups leaves tabs elsewhere ungrouped). When the window
		// match spans strips, match again in the strip that holds most of it, so a member whose tab is
		// in another strip counts as not found and stays in the list (review round 6).
		const home = homeStrip(w, [...matched.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id));
		if ([...matched.values()].some((id) => w.paneOf.get(id) !== home)) {
			for (const id of matched.values()) claims.taken.delete(id);
			matched = matchFingerprints(w, claims, g.members, windowOf(get(w.panes, home)), true, home);
		}
		const ids = [...matched.entries()].sort((a, b) => a[0] - b[0]).map(([, id]) => id);
		const id = taken.has(g.groupId) ? fresh() : g.groupId;
		taken.add(id);
		placements.push({ group: { id, name: g.name, color: g.color, collapsed: g.collapsed }, leafIds: ids });
		restored.push(g);
		// An empty tab member can never match (it identifies nothing), so it is not kept.
		const rest = g.members.filter((fp, i) => !matched.has(i) && identifying(fp));
		if (rest.length > 0) left.push({ ...g, members: rest, groupId: '' });
	}
	if (placements.length === 0) return { state, ops: [], restored, remaining, leftMembers: 0, dropped: 0 };
	// Kept parts get ids no group or list entry uses (ids in the list must differ from group ids).
	for (const part of left) remaining.push({ ...part, groupId: fresh() });
	placeGroups(w, placements);
	revealShown(w);
	const leftMembers = left.reduce((n, g) => n + g.members.length, 0);
	const kept = remaining.slice(0, SESSION_LIMITS.unmatched);
	return { state: w.finish(), ops: w.ops, restored, remaining: kept, leftMembers, dropped: remaining.length - kept.length };
}
