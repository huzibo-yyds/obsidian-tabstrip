/**
 * Close-out round 2 (atom-divider-detaches-chip): the theme's tab divider side, read from the
 * computed `::after` of a tab header's inner box.
 */
import { describe, expect, it } from 'vitest';
import { DividerCache, dividerSide, type DividerStyle } from '../../../src/ui/divider';
import { FakeDocument, rect } from './fake-dom';

/** Obsidian's own divider: `inset-inline-end: -0.5px` in a 120px wide header (used values). */
const OBSIDIAN: DividerStyle = { content: '""', display: 'block', position: 'absolute', left: '119.5px', right: '-0.5px' };
/** Atom: `right: unset; left: -0.5px`. */
const ATOM: DividerStyle = { content: '""', display: 'block', position: 'absolute', left: '-0.5px', right: '119.5px' };

describe('dividerSide', () => {
	it('Obsidian draws it at the end of each tab; Atom at the start', () => {
		expect(dividerSide(OBSIDIAN, false)).toBe('end');
		expect(dividerSide(ATOM, false)).toBe('start');
	});

	it('right to left mirrors the logical side', () => {
		expect(dividerSide(OBSIDIAN, true)).toBe('start');
		expect(dividerSide(ATOM, true)).toBe('end');
	});

	it('a box that is not displayed reports its specified offsets (auto for the other side)', () => {
		expect(dividerSide({ ...ATOM, display: 'block', right: 'auto' }, false)).toBe('start');
		expect(dividerSide({ ...OBSIDIAN, left: 'auto' }, false)).toBe('end');
	});

	it.each([
		['no content', { ...ATOM, content: 'none' }],
		['normal content', { ...ATOM, content: 'normal' }],
		['not displayed (Minimal "Modern")', { ...ATOM, display: 'none' }],
		['not positioned', { ...ATOM, position: 'static' }],
		['no usable offsets', { ...ATOM, left: 'auto', right: 'auto' }],
		['centred', { ...ATOM, left: '10px', right: '10px' }],
	])('%s: no side', (_what, style) => {
		expect(dividerSide(style, false)).toBeNull();
	});
});

function strip(after: Record<string, string> | null, stacked = false) {
	const doc = new FakeDocument();
	const parent = stacked ? doc.el(doc.body, 'workspace-tabs mod-stacked') : doc.el(doc.body, 'workspace-tab-header-container');
	const header = doc.el(parent, 'workspace-tab-header', rect(100, 0, 120, 40));
	header.computed = { direction: 'ltr' };
	const inner = doc.el(header, 'workspace-tab-header-inner', rect(103, 1, 114, 36));
	if (after !== null) inner.pseudo['::after'] = after;
	return { doc, header, inner };
}

const asHeader = (h: unknown) => h as HTMLElement;

describe('DividerCache', () => {
	it('Atom: at the start, measured once per window', () => {
		const { header, inner } = strip({ ...ATOM });
		const cache = new DividerCache();
		expect(cache.atStart(asHeader(header))).toBe(true);
		// Cached: a changed style is not read again until clear().
		inner.pseudo['::after'] = { ...OBSIDIAN };
		expect(cache.atStart(asHeader(header))).toBe(true);
		cache.clear();
		expect(cache.atStart(asHeader(header))).toBe(false);
	});

	it('Obsidian default: not at the start', () => {
		const { header } = strip({ ...OBSIDIAN });
		expect(new DividerCache().atStart(asHeader(header))).toBe(false);
	});

	it('no divider box (Minimal "Modern"): not at the start, and not measured again', () => {
		const { header, inner } = strip({ ...ATOM, display: 'none' });
		const cache = new DividerCache();
		expect(cache.atStart(asHeader(header))).toBe(false);
		inner.pseudo['::after'] = { ...ATOM };
		expect(cache.atStart(asHeader(header))).toBe(false);
	});

	it('a stacked header is not measured (and does not fill the cache)', () => {
		const { header, doc } = strip({ ...ATOM }, true);
		const cache = new DividerCache();
		expect(cache.atStart(asHeader(header))).toBe(false);
		const container = doc.el(doc.body, 'workspace-tab-header-container');
		container.appendChild(header);
		expect(cache.atStart(asHeader(header))).toBe(true);
	});

	it('a hidden member of a collapsed group (width 0) is not measured: a visible tab of its strip is (step L5)', () => {
		const { header, doc } = strip({ ...ATOM, left: '0px', right: '-1px' });
		header.className = 'workspace-tab-header tabstrip-collapsed';
		const parent = header.parentElement;
		if (parent === null) throw new Error('no parent');
		const visible = doc.el(parent, 'workspace-tab-header', rect(220, 0, 120, 40));
		visible.computed = { direction: 'ltr' };
		const inner = doc.el(visible, 'workspace-tab-header-inner', rect(223, 1, 114, 36));
		inner.pseudo['::after'] = { ...ATOM };
		expect(new DividerCache().atStart(asHeader(header))).toBe(true);
		// Without a visible tab to go by: no answer, and nothing cached.
		const lonely = strip({ ...ATOM });
		lonely.header.className = 'workspace-tab-header tabstrip-collapsed';
		const cache = new DividerCache();
		expect(cache.atStart(asHeader(lonely.header))).toBe(false);
		lonely.header.className = 'workspace-tab-header';
		expect(cache.atStart(asHeader(lonely.header))).toBe(true);
	});

	it('atEnd: only for an end-side theme; never for a start-side theme, no divider box or a stacked header (L5 review round 2)', () => {
		expect(new DividerCache().atEnd(asHeader(strip({ ...OBSIDIAN }).header))).toBe(true);
		expect(new DividerCache().atEnd(asHeader(strip({ ...ATOM }).header))).toBe(false);
		expect(new DividerCache().atEnd(asHeader(strip({ ...ATOM, display: 'none' }).header))).toBe(false);
		expect(new DividerCache().atEnd(asHeader(strip({ ...OBSIDIAN }, true).header))).toBe(false);
		// One measurement answers both questions.
		const { header, inner } = strip({ ...ATOM });
		const cache = new DividerCache();
		expect(cache.atStart(asHeader(header))).toBe(true);
		inner.pseudo['::after'] = { ...OBSIDIAN };
		expect(cache.atEnd(asHeader(header))).toBe(false);
	});
});
