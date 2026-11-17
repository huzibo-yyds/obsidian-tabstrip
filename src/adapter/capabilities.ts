/**
 * Start-up capability probe (requirements 5.6, 7.1): checks each private or newer API the
 * plugin relies on, and switches off only the features that depend on a missing one.
 * Whatever is switched off stays native: the plugin then leaves those tab headers alone.
 *
 * This file must not import `obsidian` (values): it only looks at the shapes of the objects
 * it is given, so it can be unit-tested with fakes.
 */
import { readTabsShape } from './shape';

/** What the probe looks at: the live workspace, one main-area tab strip, and `Menu`. */
export interface ProbeSample {
	readonly workspace: unknown;
	/** A `WorkspaceTabs` of the main area, or null when none was found. */
	readonly tabs: unknown;
	/** The `Menu` class (for the static `Menu.forEvent`). */
	readonly menu: unknown;
}

/** One flag per API family (all whitelisted in requirements 7.4, or public). */
export interface Capabilities {
	/** `workspace.iterateAllLeaves`, `WorkspaceTabs.children`/`currentTab`, `leaf.id`, `leaf.getViewState`. */
	readonly strips: boolean;
	/** `leaf.tabHeaderEl` inside `WorkspaceTabs.tabHeaderContainerEl`. */
	readonly headers: boolean;
	/** The native move recipe: `removeChild`, `setDimension`, `insertChild`, `selectTabIndex`, `requestResize`. */
	readonly move: boolean;
	/** Public `workspace.createLeafInParent`. */
	readonly createLeaf: boolean;
	/** Public `Menu.forEvent` (1.6+), used to add items to the native tab menu. */
	readonly menuForEvent: boolean;
}

/** Features of the plugin and the capabilities each one needs. */
export interface Features {
	/** The group model follows the live tab strips at all. */
	readonly groups: boolean;
	/** Chips, coloured underline and member marks on the tab headers. */
	readonly decorate: boolean;
	/** Group items in the native tab right-click menu. */
	readonly tabMenu: boolean;
	/** The editor bubble (opens under a chip). */
	readonly editor: boolean;
	/** Ops that reorder tabs (group creation from scattered tabs, joining, pinning). */
	readonly moves: boolean;
	/** "New tab in group". */
	readonly newTabInGroup: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function hasFunction(value: unknown, name: string): boolean {
	return (isRecord(value) || typeof value === 'function') && typeof (value as Record<string, unknown>)[name] === 'function';
}

/** Duck-typed element check that also works for elements of pop-out windows. */
export function isElementLike(value: unknown): value is HTMLElement {
	return (
		isRecord(value) &&
		value['nodeType'] === 1 &&
		typeof value['appendChild'] === 'function' &&
		typeof value['getBoundingClientRect'] === 'function' &&
		isRecord(value['classList'])
	);
}

function children(tabs: unknown): readonly unknown[] {
	if (!isRecord(tabs)) return [];
	const list = tabs['children'];
	return Array.isArray(list) ? (list as readonly unknown[]) : [];
}

function probeStrips(sample: ProbeSample): boolean {
	if (!hasFunction(sample.workspace, 'iterateAllLeaves')) return false;
	if (readTabsShape(sample.tabs) === null) return false;
	return children(sample.tabs).every((leaf) => hasFunction(leaf, 'getViewState'));
}

function probeHeaders(sample: ProbeSample): boolean {
	if (!isRecord(sample.tabs)) return false;
	const container = sample.tabs['tabHeaderContainerEl'];
	if (!isElementLike(container) || typeof container.contains !== 'function') return false;
	// Stacked tabs move their headers next to their views, out of the header container.
	const stacked = sample.tabs['isStacked'] === true;
	const leaves = children(sample.tabs);
	return (
		leaves.length > 0 &&
		leaves.every((leaf) => {
			const header = isRecord(leaf) ? leaf['tabHeaderEl'] : undefined;
			return isElementLike(header) && (stacked || container.contains(header));
		})
	);
}

function probeMove(sample: ProbeSample): boolean {
	return (
		hasFunction(sample.tabs, 'removeChild') &&
		hasFunction(sample.tabs, 'insertChild') &&
		hasFunction(sample.tabs, 'selectTabIndex') &&
		hasFunction(sample.workspace, 'requestResize') &&
		children(sample.tabs).every((leaf) => hasFunction(leaf, 'setDimension'))
	);
}

export function probeCapabilities(sample: ProbeSample): Capabilities {
	const strips = probeStrips(sample);
	return {
		strips,
		headers: strips && probeHeaders(sample),
		move: strips && probeMove(sample),
		createLeaf: hasFunction(sample.workspace, 'createLeafInParent'),
		menuForEvent: hasFunction(sample.menu, 'forEvent'),
	};
}

export function featuresOf(caps: Capabilities): Features {
	const groups = caps.strips;
	const decorate = groups && caps.headers;
	return {
		groups,
		decorate,
		tabMenu: decorate && caps.menuForEvent,
		editor: decorate,
		moves: groups && caps.move,
		newTabInGroup: groups && caps.createLeaf,
	};
}

/** Names of the switched-off features, for the debug log and the tests. */
export function missingFeatures(features: Features): string[] {
	return Object.entries(features)
		.filter(([, on]) => !on)
		.map(([name]) => name);
}
