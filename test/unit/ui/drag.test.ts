/**
 * Step L7: the passive tab-drag watcher (src/ui/drag.ts) on a fake page. The live behaviour with
 * Obsidian's own drag is covered by test/e2e/specs/l7-drag.e2e.ts.
 */
import { describe, expect, it } from 'vitest';
import type { StripRead } from '../../../src/adapter/read';
import type { DropTarget } from '../../../src/core';
import { DragWatcher, DROP_CLS } from '../../../src/ui/drag';
import { FakeDocument, fakeEvent, rect, type FakeElement } from './fake-dom';

/** One strip: a (0-100) | chip G (104-140) g1 (144-244) g2 (244-344) | b (344-444). */
function scene() {
	const doc = new FakeDocument();
	const row = doc.el(doc.body, 'workspace-tab-header-container', rect(0, 0, 800, 40));
	const header = (id: string, left: number, width: number, cls = '') => {
		const h = doc.el(row, `workspace-tab-header ${cls}`.trim(), rect(left, 0, width, 40));
		h.setAttribute('data-id', id);
		doc.el(h, 'workspace-tab-header-inner-title', rect(left + 10, 10, Math.max(0, width - 20), 20));
		return h;
	};
	const a = header('a', 0, 100);
	const g1 = header('g1', 144, 100, 'tabstrip-member tabstrip-has-chip');
	const chip = doc.el(g1, 'tabstrip-chip', rect(104, 10, 36, 20));
	chip.setAttribute('data-tabstrip-group', 'G');
	const g2 = header('g2', 244, 100, 'tabstrip-member');
	const b = header('b', 344, 100);
	for (const h of [g1, g2]) h.setAttribute('data-tabstrip-group', 'G');
	const headers: Record<string, FakeElement> = { a, g1, g2, b };
	const strip = {
		paneId: 'P',
		tabs: {},
		kind: 'main',
		windowKey: {},
		doc,
		stacked: false,
		currentLeafId: 'a',
		container: row,
		leaves: Object.entries(headers).map(([id, el]) => ({ id, leaf: {}, header: el, info: { id, pinned: false, fingerprint: { viewType: 'markdown' } } })),
	} as unknown as StripRead;
	const calls = { predicted: [] as DropTarget[], dropped: [] as DropTarget[], ended: [] as boolean[] };
	let prediction: string | null = 'G';
	const watcher = new DragWatcher({
		leafOf: (h) => (h as unknown as FakeElement).getAttribute('data-id'),
		predict: (t) => {
			calls.predicted.push(t);
			return prediction;
		},
		dropped: (t) => calls.dropped.push(t),
		ended: (d) => calls.ended.push(d),
	});
	watcher.watch([strip]);
	const win = doc.defaultView;
	if (win === null) throw new Error('no window');
	const fire = (type: string, target: FakeElement | null, extra: Record<string, unknown> = {}) => {
		doc.dispatch(fakeEvent(type, target, extra));
	};
	const painted = () => ({
		headers: Object.entries(headers)
			.filter(([, h]) => h.hasClass(DROP_CLS.join))
			.map(([id]) => id),
		chip: chip.hasClass(DROP_CLS.chip),
	});
	return { doc, win, row, headers, chip, strip, watcher, calls, fire, painted, setPrediction: (p: string | null) => (prediction = p) };
}

const END_MOVE: Record<string, unknown> = { dataTransfer: { dropEffect: 'move' } };

describe('DragWatcher', () => {
	it('records the dragged tab, highlights once per frame what predict says, and reports the drop spot', () => {
		const t = scene();
		t.fire('dragstart', t.headers.b?.children[0] ?? null);
		expect(t.watcher.draggedLeaf).toBe('b');
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 });
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 201 });
		expect(t.calls.predicted).toEqual([]);
		t.win.runFrames();
		// Several dragovers, one frame, one prediction; the target spot is worked out from the boxes.
		expect(t.calls.predicted).toEqual([{ leafId: 'b', paneId: 'P', spot: { kind: 'tab', leafId: 'g1', side: 'after' } }]);
		expect(t.painted()).toEqual({ headers: ['g1', 'g2'], chip: true });
		// Same spot again: no new prediction.
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 202 });
		t.win.runFrames();
		expect(t.calls.predicted).toHaveLength(1);
		// Over the chip.
		t.fire('dragover', t.chip, { clientX: 120 });
		t.win.runFrames();
		expect(t.calls.predicted[1]?.spot).toEqual({ kind: 'chip', groupId: 'G' });
		t.fire('drop', t.chip, { clientX: 120 });
		expect(t.calls.dropped).toEqual([{ leafId: 'b', paneId: 'P', spot: { kind: 'chip', groupId: 'G' } }]);
		expect(t.painted()).toEqual({ headers: [], chip: false });
		t.fire('dragend', t.headers.b ?? null, { dataTransfer: { dropEffect: 'move' } });
		expect(t.calls.ended).toEqual([true]);
		expect(t.watcher.draggedLeaf).toBeNull();
	});

	it('a null prediction paints nothing; past the last tab is the empty end', () => {
		const t = scene();
		t.setPrediction(null);
		t.fire('dragstart', t.headers.a ?? null);
		t.fire('dragover', t.row, { clientX: 600 });
		t.win.runFrames();
		expect(t.calls.predicted[0]?.spot).toEqual({ kind: 'empty' });
		expect(t.painted()).toEqual({ headers: [], chip: false });
	});

	it('dragend without a drop, a cancelled drop and Escape report ended(false) and clear the highlight', () => {
		const t = scene();
		for (const end of ['dragend', 'cancelled', 'escape'] as const) {
			t.fire('dragstart', t.headers.b ?? null);
			t.fire('dragover', t.headers.g2 ?? null, { clientX: 260 });
			t.win.runFrames();
			expect(t.painted().headers).toEqual(['g1', 'g2']);
			if (end === 'dragend') t.fire('dragend', t.headers.b ?? null, { dataTransfer: { dropEffect: 'none' } });
			else if (end === 'cancelled') {
				t.fire('drop', t.headers.g2 ?? null, { clientX: 260 });
				t.fire('dragend', t.headers.b ?? null, { dataTransfer: { dropEffect: 'none' } });
			} else t.fire('keydown', t.headers.b ?? null, { key: 'Escape' });
			expect(t.painted()).toEqual({ headers: [], chip: false });
			expect(t.watcher.draggedLeaf).toBeNull();
		}
		expect(t.calls.ended).toEqual([false, false, false]);
	});

	it('leaving the strip clears the highlight; moving between its children does not', () => {
		const t = scene();
		t.fire('dragstart', t.headers.b ?? null);
		t.fire('dragover', t.headers.g2 ?? null, { clientX: 260 });
		t.win.runFrames();
		t.fire('dragleave', t.headers.g2 ?? null, { relatedTarget: t.headers.g1 });
		expect(t.painted().headers).toEqual(['g1', 'g2']);
		t.fire('dragleave', t.row, { relatedTarget: t.doc.body });
		expect(t.painted().headers).toEqual([]);
		// The frame queued before leaving does not paint again.
		t.win.runFrames();
		expect(t.painted().headers).toEqual([]);
	});

	it('ignores drags that are not of a strip tab: from a chip, from an unknown element, and dragovers without a drag', () => {
		const t = scene();
		t.fire('dragstart', t.chip);
		expect(t.watcher.draggedLeaf).toBeNull();
		const clone = t.doc.el(t.row, 'workspace-tab-header', rect(0, 0, 10, 10));
		t.fire('dragstart', clone);
		expect(t.watcher.draggedLeaf).toBeNull();
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 });
		t.win.runFrames();
		t.fire('drop', t.headers.g1 ?? null, { clientX: 200 });
		expect(t.calls).toEqual({ predicted: [], dropped: [], ended: [] });
	});

	it('a collapsed group: its zero-width headers count as its chip', () => {
		const t = scene();
		for (const id of ['g1', 'g2']) {
			const h = t.headers[id];
			if (!h) continue;
			h.addClass('tabstrip-collapsed');
			h.box = rect(144, 0, 0, 40);
		}
		t.watcher.watch([t.strip]);
		t.fire('dragstart', t.headers.a ?? null);
		t.fire('dragover', t.row, { clientX: 142 });
		t.win.runFrames();
		expect(t.calls.predicted[0]?.spot).toEqual({ kind: 'chip', groupId: 'G' });
		t.fire('dragover', t.headers.b ?? null, { clientX: 350 });
		t.win.runFrames();
		expect(t.calls.predicted[1]?.spot).toEqual({ kind: 'tab', leafId: 'b', side: 'before' });
	});

	it('watch() follows the strips (listeners off for strips that went, stacked strips skipped) and clear() removes everything', () => {
		const t = scene();
		// Row listeners (dragstart is on the document since review round 3, for stacked strips' tabs too).
		const count = () => ['dragover', 'drop', 'scroll'].map((type) => t.row.listeners.get(type)?.length ?? 0);
		expect(count()).toEqual([1, 1, 1]);
		expect(t.doc.listeners.get('dragstart')?.length ?? 0).toBe(1);
		t.watcher.watch([{ ...t.strip, stacked: true }]);
		expect(count()).toEqual([0, 0, 0]);
		t.watcher.watch([t.strip]);
		t.fire('dragstart', t.headers.b ?? null);
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 });
		t.win.runFrames();
		expect(t.painted().headers).toEqual(['g1', 'g2']);
		t.watcher.clear();
		expect(count()).toEqual([0, 0, 0]);
		expect(t.doc.listeners.get('dragend')?.length ?? 0).toBe(0);
		expect(t.doc.listeners.get('dragstart')?.length ?? 0).toBe(0);
		expect(t.painted()).toEqual({ headers: [], chip: false });
	});

	it('a drop after a render mid-drag measures before it clears the highlight: no layout read after a write (L7 review round 2)', () => {
		const t = scene();
		t.fire('dragstart', t.headers.b ?? null);
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 });
		t.win.runFrames();
		expect(t.painted().headers).toEqual(['g1', 'g2']);
		// A render during the drag forgets the measured boxes, so the drop must measure again.
		t.watcher.watch([t.strip]);
		const log: string[] = [];
		for (const el of [...Object.values(t.headers), t.chip, t.row]) {
			const read = el.getBoundingClientRect.bind(el);
			el.getBoundingClientRect = () => {
				log.push('read');
				return read();
			};
			const add = el.addClass.bind(el);
			el.addClass = (cls: string) => {
				log.push('write');
				add(cls);
			};
			const remove = el.removeClass.bind(el);
			el.removeClass = (cls: string) => {
				log.push('write');
				remove(cls);
			};
		}
		t.fire('drop', t.headers.g2 ?? null, { clientX: 260 });
		expect(t.calls.dropped.at(-1)?.spot).toEqual({ kind: 'tab', leafId: 'g2', side: 'before' });
		expect(t.painted()).toEqual({ headers: [], chip: false });
		expect(log).toContain('read');
		expect(log).toContain('write');
		expect(log.lastIndexOf('read')).toBeLessThan(log.indexOf('write'));
	});

	it('a drop anywhere in a watched window ends the drag once Obsidian handled it, even with no dragend (L7 review round 1)', () => {
		const t = scene();
		// Dropped on the strip; the source window then closes and its dragend never comes.
		t.fire('dragstart', t.headers.b ?? null);
		t.fire('drop', t.headers.g2 ?? null, { clientX: 260 });
		expect(t.calls.dropped).toHaveLength(1);
		expect(t.watcher.draggedLeaf).toBe('b');
		t.win.runTimers();
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([true]);
		// A later drag that is not a tab drag (a file, a link: no dragstart on a strip) highlights nothing and records nothing.
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 });
		t.win.runFrames();
		t.fire('drop', t.headers.g1 ?? null, { clientX: 200 });
		expect(t.calls.predicted).toEqual([]);
		expect(t.calls.dropped).toHaveLength(1);
		expect(t.painted()).toEqual({ headers: [], chip: false });
		// Dropped outside the strips (a split, a note): ends as not dropped on a strip.
		t.fire('dragstart', t.headers.b ?? null);
		t.fire('drop', t.doc.body, { clientX: 500 });
		t.win.runTimers();
		expect(t.calls.ended).toEqual([true, false]);
		// The dragend that follows a handled drop is not counted twice.
		t.fire('dragend', t.headers.b ?? null, { dataTransfer: { dropEffect: 'move' } });
		expect(t.calls.ended).toEqual([true, false]);
	});

	it('any other dragstart ends a drag still open; the dragged header\'s own dragend ends it wherever the header went', () => {
		const t = scene();
		t.fire('dragstart', t.headers.b ?? null);
		const file = t.doc.el(t.doc.body, 'nav-file-title');
		t.fire('dragstart', file);
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([false]);
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 });
		t.win.runFrames();
		expect(t.calls.predicted).toEqual([]);
		// The header moved to a window the watcher does not know: dragend reaches the header only.
		t.fire('dragstart', t.headers.b ?? null);
		const header = t.headers.b;
		if (header === undefined) throw new Error('no header');
		header.dispatch(fakeEvent('dragend', header, END_MOVE));
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([false, false]);
	});

	it('windows with only stacked strips get the end-of-drag listeners; a watched window that closes ends the drag', () => {
		const t = scene();
		const doc2 = new FakeDocument();
		const row2 = doc2.el(doc2.body, 'workspace-tab-header-container', rect(0, 0, 800, 40));
		const h2 = doc2.el(row2, 'workspace-tab-header', rect(0, 0, 100, 40));
		h2.setAttribute('data-id', 'p1');
		const stackedStrip = { ...t.strip, paneId: 'S', doc: doc2, stacked: true, container: row2, leaves: [{ id: 'p1', leaf: {}, header: h2 }] } as unknown as StripRead;
		t.watcher.watch([t.strip, stackedStrip]);
		expect(doc2.listeners.get('dragend')?.length ?? 0).toBe(1);
		expect(row2.listeners.get('dragstart')?.length ?? 0).toBe(0);
		// dragend in the stacked-only window (the header was dropped there) ends the drag.
		t.fire('dragstart', t.headers.b ?? null);
		doc2.dispatch(fakeEvent('dragend', h2, END_MOVE));
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([false]);
		// The window goes away during a drag: the drag ends.
		const popRow = doc2.el(doc2.body, 'workspace-tab-header-container', rect(0, 0, 800, 40));
		const ph = doc2.el(popRow, 'workspace-tab-header', rect(0, 0, 100, 40));
		ph.setAttribute('data-id', 'q');
		const popStrip = { ...t.strip, paneId: 'Q', doc: doc2, container: popRow, leaves: [{ id: 'q', leaf: {}, header: ph }] } as unknown as StripRead;
		t.watcher.watch([t.strip, popStrip]);
		doc2.dispatch(fakeEvent('dragstart', ph));
		expect(t.watcher.draggedLeaf).toBe('q');
		t.watcher.watch([t.strip]);
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([false, false]);
		expect(doc2.listeners.get('dragend')?.length ?? 0).toBe(0);
	});

	it('a tab dragged from a stacked strip (its header is outside every watched row) still gets the highlight and the drop intent (L7 review round 3)', () => {
		const t = scene();
		const stackedRow = t.doc.el(t.doc.body, 'workspace-tab-container', rect(0, 100, 400, 300));
		const s1 = t.doc.el(stackedRow, 'workspace-tab-header', rect(0, 100, 40, 300));
		s1.setAttribute('data-id', 's1');
		const stacked = { ...t.strip, paneId: 'S', stacked: true, container: null, leaves: [{ id: 's1', leaf: {}, header: s1 }] } as unknown as StripRead;
		t.watcher.watch([t.strip, stacked]);
		t.fire('dragstart', s1);
		expect(t.watcher.draggedLeaf).toBe('s1');
		t.fire('dragover', t.headers.g2 ?? null, { clientX: 320 });
		t.win.runFrames();
		expect(t.calls.predicted).toEqual([{ leafId: 's1', paneId: 'P', spot: { kind: 'tab', leafId: 'g2', side: 'after' } }]);
		expect(t.painted().headers).toEqual(['g1', 'g2']);
		t.fire('drop', t.headers.g2 ?? null, { clientX: 320 });
		expect(t.calls.dropped).toEqual([{ leafId: 's1', paneId: 'P', spot: { kind: 'tab', leafId: 'g2', side: 'after' } }]);
		t.fire('dragend', s1, END_MOVE);
		expect(t.calls.ended).toEqual([true]);
		// One dragstart starts one drag: a tab of a watched row is not started twice (no spurious end).
		t.fire('dragstart', t.headers.b ?? null);
		expect(t.watcher.draggedLeaf).toBe('b');
		expect(t.calls.ended).toEqual([true]);
	});

	it('a strip scrolled during a drag is measured again: highlight and drop follow the tab under the pointer (L7 review round 3)', () => {
		const t = scene();
		t.fire('dragstart', t.headers.b ?? null);
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 });
		t.win.runFrames();
		expect(t.calls.predicted.at(-1)?.spot).toEqual({ kind: 'tab', leafId: 'g1', side: 'after' });
		// Chromium's drag autoscroll (or a wheel) scrolls the row by 100 px: every box moves left.
		for (const el of [...Object.values(t.headers), t.chip]) el.box = rect(el.box.left - 100, el.box.top, el.box.width, el.box.height);
		t.fire('scroll', t.row);
		t.fire('dragover', t.headers.g2 ?? null, { clientX: 200 });
		t.win.runFrames();
		expect(t.calls.predicted.at(-1)?.spot).toEqual({ kind: 'tab', leafId: 'g2', side: 'after' });
		t.fire('drop', t.headers.g2 ?? null, { clientX: 200 });
		expect(t.calls.dropped).toEqual([{ leafId: 'b', paneId: 'P', spot: { kind: 'tab', leafId: 'g2', side: 'after' } }]);
	});

	it('times each dragover and each frame', () => {
		const t = scene();
		t.fire('dragstart', t.headers.b ?? null);
		for (let i = 0; i < 5; i++) t.fire('dragover', t.headers.g1 ?? null, { clientX: 200 + i });
		t.win.runFrames();
		expect(t.watcher.timings.eventMs).toHaveLength(5);
		expect(t.watcher.timings.frameMs).toHaveLength(1);
	});

	it('a tab dragstart that another listener cancels (no drag starts) leaves no dragged tab behind for a later file drag (L7 review round 4)', () => {
		const t = scene();
		// Our capture listener sees the dragstart first; a later (bubble) listener cancels it.
		const start = fakeEvent('dragstart', t.headers.a ?? null);
		t.doc.dispatch(start);
		start.preventDefault();
		expect(t.watcher.draggedLeaf).toBe('a');
		// Once the event is done, the watcher sees it was cancelled and disarms.
		t.win.runTimers();
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([false]);
		// A file dragged in from Finder later (no dragstart in the page): no highlight, no drop for tab a.
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 190 });
		t.win.runFrames();
		t.fire('drop', t.headers.g1 ?? null, { clientX: 190 });
		expect(t.calls.predicted).toEqual([]);
		expect(t.calls.dropped).toEqual([]);
		expect(t.painted()).toEqual({ headers: [], chip: false });
	});

	it('begin() from a vertical-strip row whose dragstart a later listener cancels: the watcher disarms once the event is done (V5 review round 1)', () => {
		const t = scene();
		const source = t.doc.el(t.doc.body, 'tabstrip-vrow', rect(0, 100, 200, 30));
		const start = fakeEvent('dragstart', source);
		t.watcher.begin('a', source as unknown as HTMLElement, start as unknown as DragEvent);
		start.preventDefault();
		expect(t.watcher.draggedLeaf).toBe('a');
		t.win.runTimers();
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([false]);
		// A later drop on the strip is not taken for tab a.
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 190 });
		t.win.runFrames();
		t.fire('drop', t.headers.g1 ?? null, { clientX: 190 });
		expect(t.calls.predicted).toEqual([]);
		expect(t.calls.dropped).toEqual([]);
	});

	it('begin() whose dragstart is not cancelled keeps the drag open until its dragend', () => {
		const t = scene();
		const source = t.doc.el(t.doc.body, 'tabstrip-vrow', rect(0, 100, 200, 30));
		const start = fakeEvent('dragstart', source);
		t.watcher.begin('a', source as unknown as HTMLElement, start as unknown as DragEvent);
		t.win.runTimers();
		expect(t.watcher.draggedLeaf).toBe('a');
	});

	it('a drag that carries files is never taken for a tab drag, even with a dragged tab still recorded', () => {
		const t = scene();
		t.fire('dragstart', t.headers.a ?? null);
		t.win.runTimers();
		expect(t.watcher.draggedLeaf).toBe('a');
		// Whatever left the tab recorded, a drag with files is not it: the drag ends, nothing is painted or reported.
		const files = { dataTransfer: { types: ['Files'], dropEffect: 'copy' } };
		t.fire('dragover', t.headers.g1 ?? null, { clientX: 190, ...files });
		t.win.runFrames();
		t.fire('drop', t.headers.g1 ?? null, { clientX: 190, ...files });
		expect(t.watcher.draggedLeaf).toBeNull();
		expect(t.calls.ended).toEqual([false]);
		expect(t.calls.predicted).toEqual([]);
		expect(t.calls.dropped).toEqual([]);
		expect(t.painted()).toEqual({ headers: [], chip: false });
	});

	it('anyDrag: any drag that starts in a watched window (a sidebar tab, a file, a strip tab) is reported, and every way it ends (V6 review round 2)', () => {
		const t = scene();
		const seen: boolean[] = [];
		const watcher = new DragWatcher({ leafOf: (h) => (h as unknown as FakeElement).getAttribute('data-id'), predict: () => null, dropped: () => undefined, ended: () => undefined, anyDrag: (on) => seen.push(on) });
		watcher.watch([t.strip]);
		// A sidebar tab: a header that is no tab of any strip. Not a tab drag for the strips, but some drag.
		const side = t.doc.el(t.doc.body, 'workspace-tab-header', rect(900, 0, 100, 40));
		t.doc.dispatch(fakeEvent('dragstart', side));
		expect(watcher.draggedLeaf).toBeNull();
		expect(watcher.anyDragOpen).toBe(true);
		t.doc.dispatch(fakeEvent('dragend', side, END_MOVE));
		expect(watcher.anyDragOpen).toBe(false);
		expect(seen).toEqual([true, false]);
		// A file from the file explorer, dropped: over once Obsidian handled the drop (no dragend needed).
		const file = t.doc.el(t.doc.body, 'nav-file-title');
		t.doc.dispatch(fakeEvent('dragstart', file));
		t.doc.dispatch(fakeEvent('drop', t.doc.body));
		expect(watcher.anyDragOpen).toBe(true);
		t.win.runTimers();
		expect(watcher.anyDragOpen).toBe(false);
		// Escape.
		t.doc.dispatch(fakeEvent('dragstart', t.headers.a ?? null));
		expect(watcher.anyDragOpen).toBe(true);
		t.doc.dispatch(fakeEvent('keydown', null, { key: 'Escape' }));
		expect(watcher.anyDragOpen).toBe(false);
		// The dragged element is removed while the drag is open: its dragend goes to the detached node
		// and never reaches the document. The next pointerdown ends the drag (V6 final review).
		t.doc.dispatch(fakeEvent('dragstart', side));
		expect(watcher.anyDragOpen).toBe(true);
		t.doc.dispatch(fakeEvent('pointerdown', t.doc.body));
		expect(watcher.anyDragOpen).toBe(false);
		// A dragstart that a later listener cancels: no drag, nothing left open.
		const start = fakeEvent('dragstart', side);
		t.doc.dispatch(start);
		start.preventDefault();
		t.win.runTimers();
		expect(watcher.anyDragOpen).toBe(false);
		// A deferred end of an earlier drop does not end the next drag.
		t.doc.dispatch(fakeEvent('dragstart', side));
		t.doc.dispatch(fakeEvent('drop', t.doc.body));
		t.doc.dispatch(fakeEvent('dragstart', file));
		t.win.runTimers();
		expect(watcher.anyDragOpen).toBe(true);
		// The watched window goes away, or clear(): over.
		watcher.watch([]);
		expect(watcher.anyDragOpen).toBe(false);
		watcher.watch([t.strip]);
		t.doc.dispatch(fakeEvent('dragstart', side));
		watcher.clear();
		expect(watcher.anyDragOpen).toBe(false);
		expect(seen.filter((x) => x).length).toBe(seen.filter((x) => !x).length);
	});
});
