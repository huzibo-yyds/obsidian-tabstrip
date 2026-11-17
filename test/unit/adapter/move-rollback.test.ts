/**
 * Release preparation: a step of the native move recipe that throws after `removeChild` must not
 * lose the tab. The adapter puts it back where it was in its own strip and reports 'failed'.
 * The strips are fakes that behave like WorkspaceTabs (children, currentTab and the recipe) and
 * sit in a fake layout tree (public `parent` / `getRoot()`). Like Obsidian, a strip whose last tab
 * is removed leaves the layout (its parent drops it and its `parent` becomes null), so it can no
 * longer take the tab back: then the tab stays in the target strip, or is opened again in a new
 * tab of the main area (public `getLeaf('tab')` + `setViewState`), and is never left out of
 * every strip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { WorkspaceRead } from '../../../src/adapter/read';

vi.mock('obsidian', () => ({ Menu: class {}, View: class {}, WorkspaceFloating: class {}, WorkspaceTabs: class {} }));

const { WorkspaceAdapter } = await import('../../../src/adapter/workspace');
const { WorkspaceFloating } = await import('obsidian');

interface Leaf {
	id: string;
	dims: (number | null)[];
	detached: boolean;
	setDimension(d: number | null): void;
	getViewState(): { type: string; state: { file: string } };
	detach(): void;
}

/** A node of the fake layout tree with the public `parent` / `getRoot()`. */
class Node {
	parent: FakeSplit | null = null;
	getRoot(): Node {
		return this.parent === null ? this : this.parent.getRoot();
	}
}

class FakeSplit extends Node {
	readonly items: Node[] = [];
	add(...items: Node[]): this {
		for (const item of items) {
			item.parent = this;
			this.items.push(item);
		}
		return this;
	}
	drop(item: Node): void {
		this.items.splice(this.items.indexOf(item), 1);
		item.parent = null;
	}
}

type Fail = 'insert' | 'insert-after' | 'select' | 'resize' | 'remove' | null;

class FakeTabs extends Node {
	children: Leaf[];
	currentTab = 0;
	/** Which step throws, once (the next call of that step). */
	fail: Fail = null;
	/** Every call of the recipe, in order. */
	readonly calls: string[];
	constructor(
		readonly name: string,
		leaves: Leaf[],
		calls: string[],
	) {
		super();
		this.children = leaves;
		this.calls = calls;
	}
	removeChild(leaf: Leaf): void {
		this.calls.push(`${this.name}.removeChild(${leaf.id})`);
		if (this.fail === 'remove') {
			this.fail = null;
			throw new Error('removeChild failed');
		}
		const i = this.children.indexOf(leaf);
		if (i < 0) throw new Error('not a child');
		const shown = this.children[this.currentTab];
		this.children.splice(i, 1);
		// Like Obsidian: a strip in a split leaves the layout with its last tab.
		if (this.children.length === 0 && this.parent !== null) {
			this.parent.drop(this);
			return;
		}
		const at = shown === undefined ? -1 : this.children.indexOf(shown);
		this.currentTab = at >= 0 ? at : Math.max(0, Math.min(i, this.children.length - 1));
	}
	insertChild(index: number, leaf: Leaf): void {
		this.calls.push(`${this.name}.insertChild(${String(index)}, ${leaf.id})`);
		if (this.fail === 'insert') {
			this.fail = null;
			throw new Error('insertChild failed');
		}
		this.children.splice(index, 0, leaf);
		if (this.fail === 'insert-after') {
			this.fail = null;
			throw new Error('insertChild failed after inserting');
		}
	}
	selectTabIndex(index: number): void {
		this.calls.push(`${this.name}.selectTabIndex(${String(index)})`);
		if (this.fail === 'select') {
			this.fail = null;
			throw new Error('selectTabIndex failed');
		}
		this.currentTab = index;
	}
	ids(): string[] {
		return this.children.map((l) => l.id);
	}
}

function leaf(id: string): Leaf {
	const l: Leaf = {
		id,
		dims: [],
		detached: false,
		setDimension(d) {
			l.dims.push(d);
		},
		getViewState: () => ({ type: 'markdown', state: { file: `${id}.md` } }),
		detach() {
			l.detached = true;
		},
	};
	return l;
}

function setup(aLeaves: string[] = ['a1', 'a2', 'a3']) {
	const calls: string[] = [];
	const A = new FakeTabs('A', aLeaves.map(leaf), calls);
	const B = new FakeTabs('B', [leaf('b1'), leaf('b2')], calls);
	A.currentTab = aLeaves.length - 1;
	B.currentTab = 1;
	const rootSplit = new FakeSplit().add(new FakeSplit().add(A, B));
	let resizeFails = false;
	/** New tabs opened with the public getLeaf('tab'), with the view state they were given. */
	const opened: { state: unknown }[] = [];
	let getLeafFails = false;
	const app = {
		workspace: {
			rootSplit,
			getLeaf: (kind: string) => {
				calls.push(`getLeaf(${kind})`);
				if (getLeafFails) throw new Error('getLeaf failed');
				const fresh = { state: null as unknown, setViewState: (state: unknown) => ((fresh.state = state), Promise.resolve()) };
				opened.push(fresh);
				return fresh;
			},
			requestResize: () => {
				calls.push('requestResize');
				if (resizeFails) {
					resizeFails = false;
					throw new Error('requestResize failed');
				}
			},
			getActiveViewOfType: () => null,
		},
	} as unknown as App;
	const adapter = new WorkspaceAdapter(app);
	(adapter as unknown as { caps: object }).caps = { move: true };
	const strip = (paneId: string, tabs: FakeTabs) => ({
		paneId,
		tabs,
		kind: 'main' as const,
		windowKey: {},
		doc: null,
		stacked: false,
		leaves: tabs.children.map((l) => ({ id: l.id, leaf: l, header: null })),
		currentLeafId: null,
		container: null,
	});
	const read = { snapshot: { panes: [], activeLeafId: null }, strips: [strip('A', A), strip('B', B)] } as unknown as WorkspaceRead;
	return {
		adapter,
		read,
		A,
		B,
		calls,
		rootSplit,
		opened,
		failResize: () => {
			resizeFails = true;
		},
		failGetLeaf: () => {
			getLeafFails = true;
		},
	};
}

/** Whether a strip is still in the layout under the main area's root. */
function attached(tabs: FakeTabs, root: Node): boolean {
	return tabs.getRoot() === root;
}

let errors: unknown[][] = [];
beforeEach(() => {
	errors = [];
	vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		errors.push(args);
	});
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('native move recipe rollback', () => {
	it('positive control: a move into another strip works and shows the moved tab', () => {
		const { adapter, read, A, B } = setup();
		expect(adapter.moveTab('a2', 'B', 1, read, true)).toBe('moved');
		expect(A.ids()).toEqual(['a1', 'a3']);
		expect(B.ids()).toEqual(['b1', 'a2', 'b2']);
		expect(B.currentTab).toBe(1);
		expect(errors).toEqual([]);
	});

	it.each<[Fail, string]>([
		['insert', 'insertChild throws before inserting'],
		['insert-after', 'insertChild throws after inserting'],
		['select', 'selectTabIndex throws'],
	])('into another strip, %s (%s): the tab is back at its place in its own strip', (fail) => {
		const { adapter, read, A, B } = setup();
		B.fail = fail;
		expect(adapter.moveTab('a2', 'B', 1, read, true)).toBe('failed');
		expect(A.ids()).toEqual(['a1', 'a2', 'a3']);
		expect(B.ids()).toEqual(['b1', 'b2']);
		// The tab the source strip showed before is shown again.
		expect(A.children[A.currentTab]?.id).toBe('a3');
		expect(errors).toHaveLength(1);
		expect(String(errors[0]?.[0])).toContain('it was put back where it was');
	});

	it('requestResize throws after the move: the tab goes back too (nothing half-done is left)', () => {
		const { adapter, read, A, B, failResize } = setup();
		failResize();
		expect(adapter.moveTab('a1', 'B', 0, read, true)).toBe('failed');
		expect(A.ids()).toEqual(['a1', 'a2', 'a3']);
		expect(B.ids()).toEqual(['b1', 'b2']);
	});

	it('removeChild throws: nothing moved, the tab stays where it was', () => {
		const { adapter, read, A, B } = setup();
		A.fail = 'remove';
		expect(adapter.moveTab('a2', 'B', 0, read, true)).toBe('failed');
		expect(A.ids()).toEqual(['a1', 'a2', 'a3']);
		expect(B.ids()).toEqual(['b1', 'b2']);
	});

	it.each<[boolean]>([[false], [true]])('inside one strip (show %s), insertChild throws: the tab is back at its old index', (show) => {
		const { adapter, read, A } = setup();
		A.fail = 'insert';
		expect(adapter.moveTab('a1', 'A', 2, read, show)).toBe('failed');
		expect(A.ids()).toEqual(['a1', 'a2', 'a3']);
		expect(A.children[A.currentTab]?.id).toBe('a3');
	});

	it('moveLeaf (the ops path) puts the tab back too and reports false', () => {
		const { adapter, A } = setup();
		A.fail = 'insert';
		const a1 = A.children[0] as object;
		expect(adapter.moveLeaf(A, a1, 2)).toBe(false);
		expect(A.ids()).toEqual(['a1', 'a2', 'a3']);
	});

	it('when putting back fails too, the tab is not claimed to be back and stays in the target strip instead of being lost', () => {
		const { adapter, read, A, B } = setup();
		B.fail = 'insert';
		// The put-back insert into A throws as well.
		const insert = A.insertChild.bind(A);
		let first = true;
		A.insertChild = (index: number, l: Leaf) => {
			if (first) {
				first = false;
				throw new Error('put back failed');
			}
			insert(index, l);
		};
		expect(adapter.moveTab('a2', 'B', 1, read, true)).toBe('failed');
		expect(A.ids()).toEqual(['a1', 'a3']);
		// Before this round the tab was then in no strip at all; now it goes to the end of the target.
		expect(B.ids()).toEqual(['b1', 'b2', 'a2']);
		expect(B.children[B.currentTab]?.id).toBe('a2');
		expect(errors.map((e) => String(e[0]))).toEqual([
			'Tabstrip: could not put the tab back after a failed move',
			'Tabstrip: moving the tab failed; it was kept in the pane it was moved to',
		]);
	});

	it('refuses without touching anything when the recipe is not available', () => {
		const { adapter, read, A, B, calls } = setup();
		(adapter as unknown as { caps: object }).caps = { move: false };
		expect(adapter.moveTab('a2', 'B', 1, read, true)).toBe('refused');
		expect(calls).toEqual([]);
		expect(A.ids()).toEqual(['a1', 'a2', 'a3']);
		expect(B.ids()).toEqual(['b1', 'b2']);
	});
});

describe('rollback when the moved tab was the last one in its source strip', () => {
	it('positive control: the move works and the emptied source strip leaves the layout, as in Obsidian', () => {
		const { adapter, read, A, B, rootSplit } = setup(['a1']);
		expect(adapter.moveTab('a1', 'B', 1, read, true)).toBe('moved');
		expect(attached(A, rootSplit)).toBe(false);
		expect(B.ids()).toEqual(['b1', 'a1', 'b2']);
		expect(errors).toEqual([]);
	});

	it('insertChild into the target throws before inserting: the detached source is not used, the tab goes to the end of the target and is shown', () => {
		const { adapter, read, A, B, rootSplit, calls } = setup(['a1']);
		B.fail = 'insert';
		expect(adapter.moveTab('a1', 'B', 1, read, true)).toBe('failed');
		expect(attached(A, rootSplit)).toBe(false);
		// Nothing was inserted into the detached source strip.
		expect(calls.filter((c) => c.startsWith('A.insertChild'))).toEqual([]);
		expect(A.ids()).toEqual([]);
		expect(B.ids()).toEqual(['b1', 'b2', 'a1']);
		expect(B.children[B.currentTab]?.id).toBe('a1');
		expect(errors.map((e) => String(e[0]))).toEqual(['Tabstrip: moving the tab failed; it was kept in the pane it was moved to']);
	});

	it.each<[Fail, string[]]>([
		['insert-after', ['b1', 'a1', 'b2']],
		['select', ['b1', 'a1', 'b2']],
	])('%s: the tab is already in the target, so it stays there and is shown', (fail, ids) => {
		const { adapter, read, A, B, rootSplit } = setup(['a1']);
		B.fail = fail;
		expect(adapter.moveTab('a1', 'B', 1, read, true)).toBe('failed');
		expect(attached(A, rootSplit)).toBe(false);
		expect(A.ids()).toEqual([]);
		expect(B.ids()).toEqual(ids);
		expect(B.children[B.currentTab]?.id).toBe('a1');
		expect(attached(B, rootSplit)).toBe(true);
		expect(errors.map((e) => String(e[0]))).toEqual(['Tabstrip: moving the tab failed; it was kept in the pane it was moved to']);
	});

	it('the target refuses the tab twice: it is opened again in a new tab of the main area with the same view, and the orphan is closed', () => {
		const { adapter, read, A, B, rootSplit, opened } = setup(['a1']);
		const a1 = A.children[0] as Leaf;
		B.insertChild = () => {
			throw new Error('insertChild always fails');
		};
		expect(adapter.moveTab('a1', 'B', 1, read, true)).toBe('failed');
		expect(attached(A, rootSplit)).toBe(false);
		expect(B.ids()).toEqual(['b1', 'b2']);
		expect(opened.map((o) => o.state)).toEqual([{ type: 'markdown', state: { file: 'a1.md' } }]);
		expect(a1.detached).toBe(true);
		expect(errors.map((e) => String(e[0]))).toEqual([
			'Tabstrip: could not keep the tab in the pane it was moved to',
			'Tabstrip: moving the tab failed; it was opened again in a new tab',
		]);
	});

	it('when opening it again fails too, the error says the tab was lost (no false claim)', () => {
		const { adapter, read, B, failGetLeaf } = setup(['a1']);
		B.insertChild = () => {
			throw new Error('insertChild always fails');
		};
		failGetLeaf();
		expect(adapter.moveTab('a1', 'B', 1, read, true)).toBe('failed');
		expect(errors.map((e) => String(e[0]))).toEqual([
			'Tabstrip: could not keep the tab in the pane it was moved to',
			'Tabstrip: could not open the tab again',
			'Tabstrip: moving the tab failed; it could not be put back in any pane',
		]);
	});

	it('a drop of the only tab on its own place changes nothing: no removeChild, so its strip never leaves the layout', () => {
		const { adapter, read, A, rootSplit, calls } = setup(['a1']);
		expect(adapter.moveTab('a1', 'A', 0, read, true)).toBe('moved');
		expect(calls.filter((c) => c.includes('removeChild') || c.includes('insertChild'))).toEqual([]);
		expect(attached(A, rootSplit)).toBe(true);
		expect(A.ids()).toEqual(['a1']);
		expect(A.currentTab).toBe(0);
	});

	it('a strip of a pop-out window (root: WorkspaceFloating) counts as attached: the tab goes back there', () => {
		const { adapter, read, A, B } = setup();
		const floating: object = Object.assign(new (WorkspaceFloating as unknown as new () => object)(), {
			parent: null,
			getRoot: () => floating,
		});
		const win = new FakeSplit();
		win.parent = floating as unknown as FakeSplit;
		(A.parent as FakeSplit).drop(A);
		win.add(A);
		expect(A.getRoot()).toBe(floating);
		B.fail = 'insert';
		expect(adapter.moveTab('a2', 'B', 1, read, true)).toBe('failed');
		expect(A.ids()).toEqual(['a1', 'a2', 'a3']);
		expect(B.ids()).toEqual(['b1', 'b2']);
		expect(String(errors[0]?.[0])).toContain('it was put back where it was');
	});
});
