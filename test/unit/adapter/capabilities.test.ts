/**
 * E10: the start-up probe. A missing whitelisted API switches off only the features that
 * need it; the rest keeps working and nothing throws.
 */
import { describe, expect, it } from 'vitest';
import { featuresOf, isElementLike, missingFeatures, probeCapabilities, type ProbeSample } from '../../../src/adapter/capabilities';
import { PaneIds, readStrips } from '../../../src/adapter/read';
import { planDecorations } from '../../../src/ui/plan';
import { fakeElement, fakeLeaf, fakeMenu, fakeTabs, fakeWorkspace } from './fakes';

function sample(o: Partial<ProbeSample> = {}): ProbeSample {
	return {
		workspace: o.workspace ?? fakeWorkspace(),
		tabs: o.tabs === undefined ? fakeTabs([fakeLeaf('a'), fakeLeaf('b')]) : o.tabs,
		menu: o.menu ?? fakeMenu,
	};
}

const ALL_ON = { groups: true, decorate: true, tabMenu: true, editor: true, moves: true, newTabInGroup: true };

describe('probeCapabilities + featuresOf', () => {
	it('turns everything on when every API has the expected shape', () => {
		const caps = probeCapabilities(sample());
		expect(caps).toEqual({ strips: true, headers: true, move: true, createLeaf: true, menuForEvent: true });
		expect(featuresOf(caps)).toEqual(ALL_ON);
		expect(missingFeatures(featuresOf(caps))).toEqual([]);
	});

	it('no tabHeaderEl: no chips, underline, tab menu or editor; grouping, moves and new tab stay', () => {
		const tabs = fakeTabs([fakeLeaf('a', { noHeader: true }), fakeLeaf('b')]);
		const features = featuresOf(probeCapabilities(sample({ tabs })));
		expect(features).toEqual({ ...ALL_ON, decorate: false, tabMenu: false, editor: false });
		expect(missingFeatures(features)).toEqual(['decorate', 'tabMenu', 'editor']);
	});

	it('no tabHeaderContainerEl: same as missing headers', () => {
		const tabs = fakeTabs([fakeLeaf('a')], { noHeaderContainer: true });
		expect(featuresOf(probeCapabilities(sample({ tabs })))).toEqual({ ...ALL_ON, decorate: false, tabMenu: false, editor: false });
	});

	it('a header outside the strip container counts as missing headers, except in a stacked strip', () => {
		const leaf = fakeLeaf('a');
		const tabs = fakeTabs([leaf]);
		leaf['tabHeaderEl'] = fakeElement();
		expect(probeCapabilities(sample({ tabs })).headers).toBe(false);
		// Stacked tabs move their headers next to their views.
		const stackedLeaf = fakeLeaf('b');
		const stacked = fakeTabs([stackedLeaf], { stacked: true });
		stackedLeaf['tabHeaderEl'] = fakeElement();
		expect(probeCapabilities(sample({ tabs: stacked })).headers).toBe(true);
	});

	it.each([
		['removeChild', () => fakeTabs([fakeLeaf('a')], { noRecipe: true }), fakeWorkspace()],
		['setDimension', () => fakeTabs([fakeLeaf('a', { noSetDimension: true })]), fakeWorkspace()],
		['requestResize', () => fakeTabs([fakeLeaf('a')]), fakeWorkspace({ noResize: true })],
	])('no %s: only moves are off', (_name, tabs, workspace) => {
		const features = featuresOf(probeCapabilities(sample({ tabs: tabs(), workspace })));
		expect(features).toEqual({ ...ALL_ON, moves: false });
	});

	it('no createLeafInParent: only "New tab in group" is off', () => {
		const features = featuresOf(probeCapabilities(sample({ workspace: fakeWorkspace({ noCreate: true }) })));
		expect(features).toEqual({ ...ALL_ON, newTabInGroup: false });
	});

	it('no Menu.forEvent: only the tab menu items are off', () => {
		const features = featuresOf(probeCapabilities(sample({ menu: {} })));
		expect(features).toEqual({ ...ALL_ON, tabMenu: false });
	});

	it.each([
		['no tab strip found', { tabs: null }],
		['children not an array', { tabs: { children: {}, currentTab: 0 } }],
		['a leaf without id', { tabs: fakeTabs([{ getViewState: () => ({}) }]) }],
		['currentTab missing', { tabs: { children: [fakeLeaf('a')] } }],
		['no getViewState', { tabs: fakeTabs([fakeLeaf('a', { noViewState: true })]) }],
		['no iterateAllLeaves', { workspace: fakeWorkspace({ noIterate: true }) }],
	])('%s: the plugin stays out of the tab bar entirely', (_label, o) => {
		const caps = probeCapabilities(sample(o));
		expect(caps.strips).toBe(false);
		const features = featuresOf(caps);
		// Nothing that touches tabs; only "New tab in group" capability may be reported, but it needs groups.
		expect(features.groups).toBe(false);
		expect(features.decorate).toBe(false);
		expect(features.tabMenu).toBe(false);
		expect(features.moves).toBe(false);
	});

	it('never throws on odd values', () => {
		for (const odd of [undefined, null, 0, 'x', [], () => undefined]) {
			expect(() => probeCapabilities({ workspace: odd, tabs: odd, menu: odd })).not.toThrow();
		}
		expect(isElementLike(null)).toBe(false);
		expect(isElementLike({ nodeType: 1 })).toBe(false);
	});
});

describe('degraded reading and decoration plan', () => {
	it('without headers the strips are still read, headers are null, and grouping state still plans marks', () => {
		const leaves = [fakeLeaf('a', { noHeader: true, file: 'a.md' }), fakeLeaf('b', { noHeader: true, pinned: true })];
		const read = readStrips([fakeTabs(leaves)], { paneIds: new PaneIds(), mainContainer: null, activeLeaf: leaves[0], headers: false });
		expect(read.strips).toHaveLength(1);
		expect(read.strips[0]?.leaves.map((l) => l.header)).toEqual([null, null]);
		expect(read.snapshot.panes[0]?.leaves).toEqual([
			{ id: 'a', pinned: false, fingerprint: { viewType: 'markdown', path: 'a.md' } },
			{ id: 'b', pinned: true, fingerprint: { viewType: 'markdown' } },
		]);
		// The plan is pure; the controller only hands it to the DOM when `decorate` is on.
		const plan = planDecorations(read.strips, {
			groups: [{ id: 'g1', name: 'G', color: 'blue', collapsed: false }],
			members: [{ leafId: 'a', groupId: 'g1', fingerprint: { viewType: 'markdown', path: 'a.md' } }],
			tombstones: [],
			nextGroupSeq: 2,
		});
		expect([...plan.keys()]).toEqual(['a']);
	});

	it('reads headers only when the capability is on', () => {
		const leaves = [fakeLeaf('a')];
		const on = readStrips([fakeTabs(leaves)], { paneIds: new PaneIds(), mainContainer: null, activeLeaf: null, headers: true });
		const off = readStrips([fakeTabs(leaves)], { paneIds: new PaneIds(), mainContainer: null, activeLeaf: null, headers: false });
		expect(on.strips[0]?.leaves[0]?.header).not.toBeNull();
		expect(off.strips[0]?.leaves[0]?.header).toBeNull();
	});
});
