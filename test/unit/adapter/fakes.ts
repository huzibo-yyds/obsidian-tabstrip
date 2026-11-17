/**
 * Plain-object stand-ins for Obsidian's workspace objects, shaped like the private members
 * the adapter reads (requirements 7.4). No page and no Obsidian needed.
 */
export interface FakeElement {
	nodeType: 1;
	classList: { add(): void };
	appendChild(): void;
	getBoundingClientRect(): { width: number };
	contains(other: unknown): boolean;
	children: FakeElement[];
}

export function fakeElement(children: FakeElement[] = []): FakeElement {
	return {
		nodeType: 1,
		classList: { add: () => undefined },
		appendChild: () => undefined,
		getBoundingClientRect: () => ({ width: 10 }),
		contains(other: unknown) {
			return other === this || children.includes(other as FakeElement);
		},
		children,
	};
}

export interface FakeLeafOptions {
	pinned?: boolean;
	type?: string;
	file?: string;
	/** Leave out tabHeaderEl. */
	noHeader?: boolean;
	noSetDimension?: boolean;
	noViewState?: boolean;
	throwingViewState?: boolean;
}

export function fakeLeaf(id: string, o: FakeLeafOptions = {}): Record<string, unknown> {
	const leaf: Record<string, unknown> = { id };
	if (!o.noHeader) leaf['tabHeaderEl'] = fakeElement();
	if (!o.noSetDimension) leaf['setDimension'] = () => undefined;
	if (!o.noViewState) {
		leaf['getViewState'] = () => {
			if (o.throwingViewState) throw new Error('view state');
			return {
				type: o.type ?? 'markdown',
				state: o.file === undefined ? {} : { file: o.file },
				...(o.pinned ? { pinned: true } : {}),
			};
		};
	}
	return leaf;
}

export interface FakeTabsOptions {
	current?: number;
	stacked?: boolean;
	container?: unknown;
	noRecipe?: boolean;
	noHeaderContainer?: boolean;
}

export function fakeTabs(leaves: Record<string, unknown>[], o: FakeTabsOptions = {}): Record<string, unknown> {
	const headers = leaves.map((l) => l['tabHeaderEl']).filter((h): h is FakeElement => h !== undefined);
	const tabs: Record<string, unknown> = {
		children: leaves,
		currentTab: o.current ?? 0,
		isStacked: o.stacked ?? false,
		getContainer: () => o.container ?? null,
	};
	if (!o.noHeaderContainer) tabs['tabHeaderContainerEl'] = fakeElement(headers);
	if (!o.noRecipe) {
		tabs['removeChild'] = () => undefined;
		tabs['insertChild'] = () => undefined;
		tabs['selectTabIndex'] = () => undefined;
	}
	return tabs;
}

export function fakeWorkspace(o: { noIterate?: boolean; noResize?: boolean; noCreate?: boolean } = {}): Record<string, unknown> {
	const ws: Record<string, unknown> = {};
	if (!o.noIterate) ws['iterateAllLeaves'] = () => undefined;
	if (!o.noResize) ws['requestResize'] = () => undefined;
	if (!o.noCreate) ws['createLeafInParent'] = () => undefined;
	return ws;
}

export const fakeMenu = { forEvent: () => undefined };

export function fakeDocument(): Record<string, unknown> {
	return { nodeType: 9, createElement: () => fakeElement() };
}
