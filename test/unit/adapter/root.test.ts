/**
 * V1 review round 3: the vertical strip finds the root split element with a DOM query on the public
 * `workspace.containerEl`, not through `rootSplit.containerEl` (not in the public typings, not on
 * the whitelist of requirements 7.4). The fake root split here has public members only.
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';

vi.mock('obsidian', () => ({ Menu: class {}, View: class {}, WorkspaceFloating: class {}, WorkspaceTabs: class {} }));

const { WorkspaceAdapter } = await import('../../../src/adapter/workspace');

interface El {
	isConnected: boolean;
	parentElement: El | null;
	contains(other: unknown): boolean;
}

function el(parent: El | null, connected = true): El {
	const e: El = {
		isConnected: connected,
		parentElement: parent,
		contains(other: unknown) {
			for (let x = other as El | null; x !== null; x = x.parentElement) if (x === e) return true;
			return false;
		},
	};
	return e;
}

function setup(rootInPage: boolean) {
	const ws = el(null);
	const root = el(ws, rootInPage);
	const tabs = el(root, rootInPage);
	const headerRow = el(tabs, rootInPage);
	const queries: string[] = [];
	const app = {
		workspace: {
			containerEl: {
				querySelector: (sel: string) => {
					queries.push(sel);
					return rootInPage && sel === ':scope > .workspace-split.mod-root' ? root : null;
				},
			},
			// Public members only (obsidian.d.ts): no containerEl here.
			rootSplit: { win: {}, doc: {}, getRoot: () => null, getContainer: () => null },
		},
	} as unknown as App;
	return { adapter: new WorkspaceAdapter(app), root, tabs, headerRow: headerRow as unknown as HTMLElement, queries };
}

describe('root split element (V1 review round 3)', () => {
	it('is found from the public workspace.containerEl when the root split has public members only', () => {
		const s = setup(true);
		expect(s.adapter.rootShown()).toBe(true);
		expect(s.adapter.rootState([s.headerRow])).toBe('shown');
		expect(s.adapter.rootSplitElements([s.headerRow])).toEqual([s.root]);
		expect(s.queries.every((q) => q === ':scope > .workspace-split.mod-root')).toBe(true);
	});

	it('is "loading" while neither the root split nor its header rows are in the page', () => {
		const s = setup(false);
		expect(s.adapter.rootShown()).toBe(false);
		expect(s.adapter.rootState([s.headerRow])).toBe('loading');
		expect(s.adapter.rootState([])).toBe('loading');
		expect(s.adapter.rootSplitElements([s.headerRow])).toEqual([]);
	});

	it('is "missing" when header rows are in the page but no root split element is found', () => {
		const s = setup(false);
		const connected = { ...el(null), isConnected: true } as unknown as HTMLElement;
		expect(s.adapter.rootState([connected])).toBe('missing');
	});
});
