/**
 * Reads the live tab strips into the core `Snapshot`, plus what the UI needs (tab header
 * elements, which window a strip is in).
 *
 * No `obsidian` import here (values): the strips are passed in already collected
 * (`collectRootTabs` in workspace.ts), and everything private is checked before use, so
 * this can be unit-tested with fake objects. A leaf is never loaded: only `getViewState()`
 * is read, which a deferred leaf answers from its saved state.
 */
import type { Fingerprint, LeafInfo, PaneKind, Snapshot } from '../core/types';
import { isElementLike } from './capabilities';
import { readLeafId, readTabsShape } from './shape';

/** Stable ids for tab strips. Obsidian's own strip id is not on the whitelist, so we number them. */
export class PaneIds {
	private readonly ids = new WeakMap<object, string>();
	private next = 1;

	idOf(tabs: object): string {
		let id = this.ids.get(tabs);
		if (id === undefined) {
			id = `p${String(this.next++)}`;
			this.ids.set(tabs, id);
		}
		return id;
	}
}

export interface LeafRead {
	readonly id: string;
	/** The `WorkspaceLeaf`. */
	readonly leaf: object;
	/** Its tab header, or null when headers are not available. */
	readonly header: HTMLElement | null;
	readonly info: LeafInfo;
	/**
	 * Step V2: the tab has not been loaded yet (public `WorkspaceLeaf.isDeferred`, a getter that never
	 * loads it). Drawn greyed in the vertical strip.
	 */
	readonly deferred: boolean;
}

export interface StripRead {
	readonly paneId: string;
	/** The `WorkspaceTabs`. */
	readonly tabs: object;
	readonly kind: PaneKind;
	/** Identity of the window the strip is in (its workspace container). */
	readonly windowKey: object;
	/** Document of that window, when the container exposes it. */
	readonly doc: Document | null;
	readonly stacked: boolean;
	readonly leaves: readonly LeafRead[];
	readonly currentLeafId: string | null;
	/** The strip's tab header row (private `tabHeaderContainerEl`), or null when headers are not available. */
	readonly container: HTMLElement | null;
}

export interface WorkspaceRead {
	readonly snapshot: Snapshot;
	readonly strips: readonly StripRead[];
}

export interface ReadOptions {
	readonly paneIds: PaneIds;
	/** `workspace.rootSplit`: strips in this container are 'main', all others 'popout'. */
	readonly mainContainer: unknown;
	/** `workspace.activeLeaf`. */
	readonly activeLeaf: unknown;
	/** Read `leaf.tabHeaderEl` (capability `headers`). */
	readonly headers: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isDocumentLike(value: unknown): value is Document {
	return isRecord(value) && value['nodeType'] === 9 && typeof value['createElement'] === 'function';
}

/** Pinned flag and fingerprint from the public `getViewState()`. */
export function readViewState(leaf: unknown): { pinned: boolean; fingerprint: Fingerprint } {
	if (!isRecord(leaf) || typeof leaf['getViewState'] !== 'function') {
		return { pinned: false, fingerprint: { viewType: 'unknown' } };
	}
	let state: unknown;
	try {
		state = (leaf['getViewState'] as () => unknown).call(leaf);
	} catch {
		return { pinned: false, fingerprint: { viewType: 'unknown' } };
	}
	if (!isRecord(state)) return { pinned: false, fingerprint: { viewType: 'unknown' } };
	const type = typeof state['type'] === 'string' ? state['type'] : 'unknown';
	const inner = state['state'];
	const file = isRecord(inner) && typeof inner['file'] === 'string' ? inner['file'] : undefined;
	return {
		pinned: state['pinned'] === true,
		fingerprint: file === undefined ? { viewType: type } : { viewType: type, path: file },
	};
}

/** Public `isDeferred` (Obsidian 1.7.2+); false when missing or throwing. Never loads the tab. */
export function readDeferred(leaf: Record<string, unknown>): boolean {
	try {
		return leaf['isDeferred'] === true;
	} catch {
		return false;
	}
}

function containerOf(tabs: Record<string, unknown>): unknown {
	const getContainer = tabs['getContainer'];
	if (typeof getContainer !== 'function') return null;
	try {
		return (getContainer as () => unknown).call(tabs);
	} catch {
		return null;
	}
}

/** Reads the given strips. Strips whose private fields have an unexpected shape are left out. */
export function readStrips(tabsList: readonly unknown[], options: ReadOptions): WorkspaceRead {
	const strips: StripRead[] = [];
	const seenLeaves = new Set<string>();
	for (const tabs of tabsList) {
		if (!isRecord(tabs)) continue;
		const shape = readTabsShape(tabs);
		if (shape === null) continue;
		const rawChildren = tabs['children'] as readonly unknown[];
		const leaves: LeafRead[] = [];
		for (const leaf of rawChildren) {
			const id = readLeafId(leaf);
			if (id === null || !isRecord(leaf) || seenLeaves.has(id)) continue;
			seenLeaves.add(id);
			const headerValue = options.headers ? leaf['tabHeaderEl'] : null;
			const { pinned, fingerprint } = readViewState(leaf);
			leaves.push({
				id,
				leaf,
				header: isElementLike(headerValue) ? headerValue : null,
				info: { id, pinned, fingerprint },
				deferred: readDeferred(leaf),
			});
		}
		const container = containerOf(tabs);
		const doc = isRecord(container) ? container['doc'] : null;
		const headerRow = options.headers ? tabs['tabHeaderContainerEl'] : null;
		strips.push({
			paneId: options.paneIds.idOf(tabs),
			tabs,
			kind: container !== null && container === options.mainContainer ? 'main' : 'popout',
			windowKey: isRecord(container) ? container : tabs,
			doc: isDocumentLike(doc) ? doc : null,
			stacked: shape.stacked,
			leaves,
			currentLeafId: shape.currentIndex >= 0 ? (shape.leafIds[shape.currentIndex] ?? null) : null,
			container: isElementLike(headerRow) ? headerRow : null,
		});
	}
	const windows: object[] = [];
	for (const s of strips) if (!windows.includes(s.windowKey)) windows.push(s.windowKey);
	const activeId = readLeafId(options.activeLeaf);
	const activeLeafId = activeId !== null && seenLeaves.has(activeId) ? activeId : null;
	const snapshot: Snapshot = {
		panes: strips.map((s) => ({
			id: s.paneId,
			kind: s.kind,
			leaves: s.leaves.map((l) => l.info),
			currentLeafId: s.leaves.some((l) => l.id === s.currentLeafId) ? s.currentLeafId : (s.leaves[0]?.id ?? null),
			...(s.stacked ? { stacked: true } : {}),
			windowId: `w${String(windows.indexOf(s.windowKey))}`,
		})),
		activeLeafId,
	};
	return { snapshot, strips };
}

/** Strip ids that are in the same window as `paneId` (for Chrome's per-window colour choice). */
export function panesInWindowOf(read: WorkspaceRead, paneId: string): Set<string> {
	const strip = read.strips.find((s) => s.paneId === paneId);
	if (strip === undefined) return new Set([paneId]);
	return new Set(read.strips.filter((s) => s.windowKey === strip.windowKey).map((s) => s.paneId));
}
