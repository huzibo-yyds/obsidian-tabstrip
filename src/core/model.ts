/**
 * Shared building blocks for commands, reconcile and invariants.
 */
import { GROUP_COLORS } from './types';
import type { Fingerprint, Group, GroupColor, GroupState, LeafInfo, Membership, PaneInfo, Snapshot, Tombstone } from './types';
import { at, get } from './util';

/** How many closed members are remembered (the newest close batch is always kept whole). */
export const TOMBSTONE_LIMIT = 25;

/** Longest group name, in UTF-16 units. Longer names are cut (input, commands, storage). */
export const GROUP_NAME_LIMIT = 1000;

/** A group name cut to `GROUP_NAME_LIMIT` (never splits a surrogate pair). */
export function clipName(name: string): string {
	if (name.length <= GROUP_NAME_LIMIT) return name;
	const cut = name.slice(0, GROUP_NAME_LIMIT);
	const last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function emptyState(): GroupState {
	return { groups: [], members: [], tombstones: [], nextGroupSeq: 1 };
}

export interface LeafPlace {
	readonly leaf: LeafInfo;
	readonly pane: PaneInfo;
	readonly index: number;
}

/** Leaf id → where it is. Later duplicates are ignored. */
export function indexLeaves(snapshot: Snapshot): Map<string, LeafPlace> {
	const map = new Map<string, LeafPlace>();
	for (const pane of snapshot.panes) {
		pane.leaves.forEach((leaf, index) => {
			if (!map.has(leaf.id)) map.set(leaf.id, { leaf, pane, index });
		});
	}
	return map;
}

/** Number of pinned tabs at the start of `order`. */
export function pinnedPrefixLength(order: readonly string[], pinned: (leafId: string) => boolean): number {
	let n = 0;
	while (n < order.length && pinned(at(order, n))) n++;
	return n;
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
	return a.viewType === b.viewType && a.path === b.path;
}

/** True when tabs of a collapsed group in this strip are hidden (stacked strips never hide). */
export function canHide(pane: PaneInfo): boolean {
	return pane.stacked !== true;
}

/** The least used color, ties broken by Chrome's color order. */
export function pickColor(groups: readonly Group[]): GroupColor {
	let best: GroupColor = GROUP_COLORS[0];
	let bestCount = Number.POSITIVE_INFINITY;
	for (const color of GROUP_COLORS) {
		const count = groups.filter((g) => g.color === color).length;
		if (count < bestCount) {
			best = color;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Colour for a new group in one window (Chrome picks per window): the least used colour
 * among the groups whose members are in `paneIds`, ties broken by Chrome's colour order.
 */
export function colorForNewGroup(state: GroupState, snapshot: Snapshot, paneIds: ReadonlySet<string>): GroupColor {
	const paneOf = new Map<string, string>();
	for (const pane of snapshot.panes) {
		for (const leaf of pane.leaves) if (!paneOf.has(leaf.id)) paneOf.set(leaf.id, pane.id);
	}
	const inWindow = new Set<string>();
	for (const m of state.members) {
		const paneId = paneOf.get(m.leafId);
		if (paneId !== undefined && paneIds.has(paneId)) inWindow.add(m.groupId);
	}
	return pickColor(state.groups.filter((g) => inWindow.has(g.id)));
}

export function isGroupColor(value: string): value is GroupColor {
	return (GROUP_COLORS as readonly string[]).includes(value);
}

/**
 * The nearest tab outside [start, end] of `order` that is not hidden: first to the
 * right, then to the left. Null when every other tab is hidden.
 */
export function nearestVisible(
	order: readonly string[],
	start: number,
	end: number,
	hidden: (leafId: string) => boolean,
): string | null {
	for (let i = end + 1; i < order.length; i++) {
		const id = at(order, i);
		if (!hidden(id)) return id;
	}
	for (let i = start - 1; i >= 0; i--) {
		const id = at(order, i);
		if (!hidden(id)) return id;
	}
	return null;
}

/** Adds a close batch to the tombstone ring (newest first). */
export function pushTombstones(ring: readonly Tombstone[], batch: readonly Tombstone[]): Tombstone[] {
	if (batch.length === 0) return [...ring];
	return [...batch, ...ring].slice(0, Math.max(TOMBSTONE_LIMIT, batch.length));
}

/**
 * Builds the canonical state (members sorted by leaf id, empty groups dropped) and
 * returns `original` itself when nothing changed.
 */
export function finishState(
	original: GroupState,
	groups: readonly Group[],
	memberOf: ReadonlyMap<string, string>,
	fingerprintOf: (leafId: string) => Fingerprint,
	tombstones: readonly Tombstone[],
	nextGroupSeq: number,
): GroupState {
	const used = new Set(memberOf.values());
	const keptGroups = groups.filter((g) => used.has(g.id));
	const known = new Set(keptGroups.map((g) => g.id));
	const ids = [...memberOf.keys()].filter((id) => known.has(get(memberOf, id))).sort(compareIds);
	const members: Membership[] = ids.map((leafId) => ({
		leafId,
		groupId: get(memberOf, leafId),
		fingerprint: fingerprintOf(leafId),
	}));
	const next: GroupState = { groups: keptGroups, members, tombstones, nextGroupSeq };
	return sameState(original, next) ? original : next;
}

export function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function sameGroup(a: Group, b: Group): boolean {
	return a.id === b.id && a.name === b.name && a.color === b.color && a.collapsed === b.collapsed;
}

function sameMember(a: Membership, b: Membership): boolean {
	return a.leafId === b.leafId && a.groupId === b.groupId && sameFingerprint(a.fingerprint, b.fingerprint);
}

/** Structural equality of two states. */
export function sameState(a: GroupState, b: GroupState): boolean {
	return (
		a.nextGroupSeq === b.nextGroupSeq &&
		sameList(a.groups, b.groups, sameGroup) &&
		sameList(a.members, b.members, sameMember) &&
		sameList(a.tombstones, b.tombstones, (x, y) => x === y)
	);
}

function sameList<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean {
	return a.length === b.length && a.every((x, i) => same(x, at(b, i)));
}
