/**
 * Compact notation for snapshots and states in core tests.
 *
 *   snap('A: p1* a b | B: x y', { active: 'a' })
 *
 * Strips are separated by `|`; a trailing `*` marks a pinned tab. Every tab's default
 * fingerprint is a markdown view of `<id>.md`.
 */
import { applyOps } from '../../../src/core/ops';
import type {
	Fingerprint,
	GroupColor,
	GroupState,
	LeafInfo,
	Op,
	PaneInfo,
	Snapshot,
	Tombstone,
} from '../../../src/core/types';

export interface SnapOptions {
	/** Active leaf; defaults to the shown tab of the first strip. */
	readonly active?: string | null;
	/** Shown tab per strip; defaults to the active leaf if it is in the strip, else the first tab. */
	readonly current?: Readonly<Record<string, string | null>>;
	readonly popouts?: readonly string[];
	readonly stacked?: readonly string[];
	readonly paths?: Readonly<Record<string, string>>;
}

export function fp(id: string): Fingerprint {
	return { viewType: 'markdown', path: `${id}.md` };
}

export function snap(spec: string, options: SnapOptions = {}): Snapshot {
	const parsed = spec
		.split('|')
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => {
			const [id, rest = ''] = part.split(':').map((x) => x.trim());
			if (id === undefined || id.length === 0) throw new Error(`bad pane spec ${part}`);
			const leaves: LeafInfo[] = rest
				.split(/\s+/)
				.filter((t) => t.length > 0)
				.map((token) => {
					const pinned = token.endsWith('*');
					const leafId = pinned ? token.slice(0, -1) : token;
					const path = options.paths?.[leafId];
					return { id: leafId, pinned, fingerprint: path === undefined ? fp(leafId) : { viewType: 'markdown', path } };
				});
			return { id, leaves };
		});
	const firstLeaf = parsed[0]?.leaves[0]?.id ?? null;
	const active = options.active === undefined ? firstLeaf : options.active;
	const panes: PaneInfo[] = parsed.map(({ id, leaves }) => {
		const explicit = options.current?.[id];
		const holdsActive = leaves.some((l) => l.id === active);
		const currentLeafId = explicit !== undefined ? explicit : holdsActive ? active : (leaves[0]?.id ?? null);
		const base = { id, kind: options.popouts?.includes(id) ? ('popout' as const) : ('main' as const), leaves, currentLeafId };
		return options.stacked?.includes(id) ? { ...base, stacked: true } : base;
	});
	return { panes, activeLeafId: active };
}

export interface GroupSpec {
	readonly members: string;
	readonly collapsed?: boolean;
	readonly name?: string;
	readonly color?: GroupColor;
}

/** State with the given groups; members get the default fingerprint. */
export function groups(
	spec: Readonly<Record<string, string | GroupSpec>>,
	extra: { readonly tombstones?: readonly Tombstone[]; readonly nextGroupSeq?: number } = {},
): GroupState {
	const list = Object.entries(spec).map(([id, value]) => {
		const g = typeof value === 'string' ? { members: value } : value;
		return { id, g };
	});
	const members = list
		.flatMap(({ id, g }) =>
			g.members
				.split(/\s+/)
				.filter((x) => x.length > 0)
				.map((leafId) => ({ leafId, groupId: id, fingerprint: fp(leafId) })),
		)
		.sort((a, b) => (a.leafId < b.leafId ? -1 : a.leafId > b.leafId ? 1 : 0));
	return {
		groups: list.map(({ id, g }) => ({
			id,
			name: g.name ?? id,
			color: g.color ?? 'blue',
			collapsed: g.collapsed ?? false,
		})),
		members,
		tombstones: extra.tombstones ?? [],
		nextGroupSeq: extra.nextGroupSeq ?? 100,
	};
}

/** Strip layout back in `snap` notation. */
export function layout(s: Snapshot): string {
	return s.panes
		.map((p) => `${p.id}: ${p.leaves.map((l) => (l.pinned ? `${l.id}*` : l.id)).join(' ')}`.trimEnd())
		.join(' | ');
}

/** leafId → groupId. */
export function membership(state: GroupState): Record<string, string> {
	return Object.fromEntries(state.members.map((m) => [m.leafId, m.groupId]));
}

export function group(state: GroupState, id: string) {
	return state.groups.find((g) => g.id === id);
}

/** Applies ops with deterministic ids n1, n2, … for created tabs. */
export function apply(s: Snapshot, ops: readonly Op[], prefix = 'n'): Snapshot {
	let n = 0;
	return applyOps(s, ops, () => `${prefix}${String(++n)}`);
}

export function tomb(partial: Partial<Tombstone> & Pick<Tombstone, 'leafId' | 'groupId' | 'paneId'>): Tombstone {
	return {
		groupName: partial.groupId,
		groupColor: 'red',
		paneIndex: 0,
		indexInGroup: 0,
		fingerprint: fp(partial.leafId),
		...partial,
	};
}
