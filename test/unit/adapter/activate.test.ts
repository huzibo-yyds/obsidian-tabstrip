/**
 * L7 review round 1: an `activate` op in a strip that does not hold the active leaf shows the tab
 * with the whitelisted `selectTabIndex` only. `revealLeaf` would focus that strip's window and load
 * a deferred tab (dragging the shown tab next to a collapsed group into a pop-out did both).
 */
import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { WorkspaceRead } from '../../../src/adapter/read';
import { snap } from '../core/dsl';

vi.mock('obsidian', () => ({ Menu: class {}, View: class {}, WorkspaceFloating: class {}, WorkspaceTabs: class {} }));

const { WorkspaceAdapter } = await import('../../../src/adapter/workspace');

function setup(move: boolean) {
	const calls: string[] = [];
	const leaf = (id: string) => ({ id });
	const a = { a: leaf('a'), g1: leaf('g1'), g2: leaf('g2'), c: leaf('c') };
	const x = leaf('x');
	const tabsA = {
		children: [a.a, a.g1, a.g2, a.c],
		currentTab: 1,
		selectTabIndex: (i: number) => calls.push(`A.selectTabIndex(${String(i)})`),
	};
	const tabsB = { children: [leaf('y'), x], currentTab: 1, selectTabIndex: (i: number) => calls.push(`B.selectTabIndex(${String(i)})`) };
	const app = {
		workspace: {
			revealLeaf: (l: { id: string }) => {
				calls.push(`revealLeaf(${l.id})`);
				return Promise.resolve();
			},
			setActiveLeaf: (l: { id: string }) => calls.push(`setActiveLeaf(${l.id})`),
		},
	} as unknown as App;
	const adapter = new WorkspaceAdapter(app);
	(adapter as unknown as { caps: object }).caps = { move };
	const snapshot = snap('A: a g1 g2 c | B: y x', { active: 'x', current: { A: 'g1' }, popouts: ['B'] });
	const strip = (paneId: string, tabs: object, leaves: Record<string, object>) => ({
		paneId,
		tabs,
		kind: 'main' as const,
		windowKey: {},
		doc: null,
		stacked: false,
		leaves: Object.entries(leaves).map(([id, l]) => ({ id, leaf: l, header: null })),
		currentLeafId: null,
		container: null,
	});
	const read = { snapshot, strips: [strip('A', tabsA, a), strip('B', tabsB, { y: tabsB.children[0] as object, x })] } as unknown as WorkspaceRead;
	return { adapter, read, calls };
}

describe('activate in a strip without the active leaf', () => {
	it('uses selectTabIndex on that strip: no revealLeaf, no setActiveLeaf', () => {
		const { adapter, read, calls } = setup(true);
		expect(adapter.applyOps([{ kind: 'activate', leafId: 'c' }], read)).toEqual({ applied: 1, skipped: 0 });
		expect(calls).toEqual(['A.selectTabIndex(3)']);
	});

	it('in the strip that holds the active leaf: setActiveLeaf as before', () => {
		const { adapter, read, calls } = setup(true);
		adapter.applyOps([{ kind: 'activate', leafId: 'y' }], read);
		expect(calls).toEqual(['setActiveLeaf(y)']);
	});

	it('without the move recipe: falls back to revealLeaf', () => {
		const { adapter, read, calls } = setup(false);
		adapter.applyOps([{ kind: 'activate', leafId: 'c' }], read);
		expect(calls).toEqual(['revealLeaf(c)']);
	});
});
