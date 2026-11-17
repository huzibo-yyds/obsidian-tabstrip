import { describe, expect, it } from 'vitest';
import { PaneIds, panesInWindowOf, readStrips, readViewState } from '../../../src/adapter/read';
import { fakeDocument, fakeLeaf, fakeTabs } from './fakes';

describe('readStrips', () => {
	it('builds the core snapshot: order, pinned, fingerprint, current tab, kind and stacked', () => {
		const main = { doc: fakeDocument() };
		const popout = { doc: fakeDocument() };
		const a = fakeLeaf('a', { file: 'A.md', pinned: true });
		const b = fakeLeaf('b', { type: 'empty' });
		const c = fakeLeaf('c', { file: 'C.md' });
		const read = readStrips([fakeTabs([a, b], { current: 1, container: main }), fakeTabs([c], { stacked: true, container: popout })], {
			paneIds: new PaneIds(),
			mainContainer: main,
			activeLeaf: b,
			headers: true,
		});
		expect(read.snapshot).toEqual({
			panes: [
				{
					id: 'p1',
					kind: 'main',
					leaves: [
						{ id: 'a', pinned: true, fingerprint: { viewType: 'markdown', path: 'A.md' } },
						{ id: 'b', pinned: false, fingerprint: { viewType: 'empty' } },
					],
					currentLeafId: 'b',
					windowId: 'w0',
				},
				{ id: 'p2', kind: 'popout', leaves: [{ id: 'c', pinned: false, fingerprint: { viewType: 'markdown', path: 'C.md' } }], currentLeafId: 'c', stacked: true, windowId: 'w1' },
			],
			activeLeafId: 'b',
		});
		expect(read.strips.map((s) => s.doc)).toEqual([main.doc, popout.doc]);
		expect(panesInWindowOf(read, 'p1')).toEqual(new Set(['p1']));
		expect(panesInWindowOf(read, 'p2')).toEqual(new Set(['p2']));
		expect(panesInWindowOf(read, 'nope')).toEqual(new Set(['nope']));
	});

	it('gives a strip the same id while it lives, and groups strips by window', () => {
		const ids = new PaneIds();
		const container = { doc: fakeDocument() };
		const t1 = fakeTabs([fakeLeaf('a')], { container });
		const t2 = fakeTabs([fakeLeaf('b')], { container });
		const opts = { paneIds: ids, mainContainer: container, activeLeaf: null, headers: true };
		const first = readStrips([t1, t2], opts);
		const again = readStrips([t2, t1], opts);
		expect(first.snapshot.panes.map((p) => p.id)).toEqual(['p1', 'p2']);
		expect(again.snapshot.panes.map((p) => p.id)).toEqual(['p2', 'p1']);
		expect(panesInWindowOf(first, 'p1')).toEqual(new Set(['p1', 'p2']));
		// Strips of one window share a window id in the snapshot (restore by file is per window).
		expect(first.snapshot.panes.map((p) => p.windowId)).toEqual(['w0', 'w0']);
		// A sidebar or unknown active leaf is not a root tab.
		expect(first.snapshot.activeLeafId).toBeNull();
	});

	it('skips strips with an unexpected shape, and a leaf id seen in an earlier strip', () => {
		const read = readStrips([{ children: 'x' }, null, fakeTabs([fakeLeaf('a'), fakeLeaf('a')]), fakeTabs([fakeLeaf('b')]), fakeTabs([fakeLeaf('b'), fakeLeaf('c')])], {
			paneIds: new PaneIds(),
			mainContainer: null,
			activeLeaf: null,
			headers: true,
		});
		expect(read.snapshot.panes.map((p) => p.leaves.map((l) => l.id))).toEqual([['b'], ['c']]);
	});

	it('survives a throwing or odd getViewState', () => {
		expect(readViewState(fakeLeaf('a', { throwingViewState: true }))).toEqual({ pinned: false, fingerprint: { viewType: 'unknown' } });
		expect(readViewState(fakeLeaf('a', { noViewState: true }))).toEqual({ pinned: false, fingerprint: { viewType: 'unknown' } });
		expect(readViewState({ getViewState: () => 7 })).toEqual({ pinned: false, fingerprint: { viewType: 'unknown' } });
		expect(readViewState({ getViewState: () => ({ type: 3, state: { file: 1 } }) })).toEqual({
			pinned: false,
			fingerprint: { viewType: 'unknown' },
		});
	});
});
