/**
 * Pure shape checks for values read from Obsidian's private workspace fields.
 *
 * This file must not import `obsidian`: it only looks at plain values, so it can
 * be unit-tested without a running app. The adapter calls these checks before it
 * trusts a private field, and turns a failed check into "capability missing"
 * instead of an exception.
 */

/** What the adapter needs from a `WorkspaceTabs` (private fields, see requirements 7.4). */
export interface TabsShape {
	/** Leaf ids in `children` order, which is Obsidian's own tab order. */
	readonly leafIds: readonly string[];
	/** Index of the shown tab (`currentTab`), or -1 when the strip is empty. */
	readonly currentIndex: number;
	/** Whether the strip uses stacked tabs (`isStacked`). */
	readonly stacked: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Returns the leaf id of one entry of `WorkspaceTabs.children`, or null if it has none. */
export function readLeafId(leaf: unknown): string | null {
	if (!isRecord(leaf)) return null;
	const id = leaf['id'];
	return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Validates the private fields of a `WorkspaceTabs` and returns them in a typed form.
 * Returns null when any field is missing or has an unexpected type, so callers can
 * fall back to the native tab bar.
 */
export function readTabsShape(tabs: unknown): TabsShape | null {
	if (!isRecord(tabs)) return null;
	const children = tabs['children'];
	if (!Array.isArray(children)) return null;

	const leafIds: string[] = [];
	for (const child of children as readonly unknown[]) {
		const id = readLeafId(child);
		if (id === null) return null;
		leafIds.push(id);
	}
	if (new Set(leafIds).size !== leafIds.length) return null;

	const currentTab = tabs['currentTab'];
	if (typeof currentTab !== 'number' || !Number.isInteger(currentTab)) return null;
	const currentIndex = leafIds.length === 0 ? -1 : currentTab;
	if (leafIds.length > 0 && (currentIndex < 0 || currentIndex >= leafIds.length)) return null;

	const isStacked = tabs['isStacked'];
	if (isStacked !== undefined && typeof isStacked !== 'boolean') return null;

	return { leafIds, currentIndex, stacked: isStacked === true };
}

/** True when both lists hold the same ids in the same order. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}
