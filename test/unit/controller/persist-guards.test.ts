/**
 * L6 review round 1: two controller paths that could lose stored data. The controller is driven
 * with a fake workspace (plain snapshots) and fake storage; `obsidian` is replaced by stand-ins,
 * and the page-facing parts of a command (pass, render) are stubbed on the instance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Features } from '../../../src/adapter/capabilities';
import type { WorkspaceAdapter } from '../../../src/adapter/workspace';
import type { WorkspaceRead } from '../../../src/adapter/read';
import type { GroupState, Snapshot } from '../../../src/core/types';
import { translator } from '../../../src/i18n';
import type { SessionStorage } from '../../../src/storage';

const notices: string[] = [];
const fault = { restore: false };

vi.mock('obsidian', () => ({
	Menu: class {},
	Notice: class {
		constructor(text: string) {
			notices.push(text);
		}
	},
}));

vi.mock('../../../src/core', async (importOriginal) => {
	const core = await importOriginal<typeof import('../../../src/core')>();
	return {
		...core,
		restoreSession: (...args: Parameters<typeof core.restoreSession>) => {
			if (fault.restore) throw new Error('injected restore fault');
			return core.restoreSession(...args);
		},
	};
});

const { TabstripController: Controller, SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS } = await import('../../../src/controller');

function leaf(id: string, path = `${id}.md`) {
	return { id, pinned: false, fingerprint: { viewType: 'markdown', path } };
}

function readOf(snapshot: Snapshot): WorkspaceRead {
	return { snapshot, strips: [] };
}

function memoryStorage(initial: unknown) {
	let value = initial;
	const writes: unknown[] = [];
	const storage: SessionStorage = {
		load: () => value,
		save: (v) => {
			writes.push(v);
			value = JSON.parse(JSON.stringify(v)) as unknown;
		},
		clear: () => {
			value = null;
		},
	};
	return { storage, writes, current: () => value };
}

const t = translator('en');
const features = { groups: true, moves: false } as unknown as Features;

/** The private members these tests reach (TypeScript privacy only; plain fields at run time). */
interface Internals {
	state: GroupState;
	running: boolean;
	features: Features | null;
	readonly unmatchedCount: number;
	restore(): void;
	saveNow(): void;
	requestSave(): void;
	restoreUnmatchedGroups(): number;
	clearData(): void;
	flush(): void;
	pass(): void;
	render(): void;
	record(): void;
	applyOps(): void;
}

function controllerFor(snapshot: Snapshot, storage: SessionStorage): Internals {
	const adapter = { read: () => readOf(snapshot), verticalTabsSignals: () => ({ views: 0, bodyClasses: [] }) } as unknown as WorkspaceAdapter;
	const c = new Controller(adapter, t, () => features, storage) as unknown as Internals;
	// Page-facing parts of a command: no page in unit tests.
	c.flush = () => undefined;
	c.pass = () => undefined;
	c.render = () => undefined;
	c.record = () => undefined;
	c.applyOps = () => undefined;
	return c;
}

const stored = {
	version: 1,
	nextGroupSeq: 3,
	groups: [{ groupId: 'g1', name: 'Work', color: 'green', collapsed: false, members: [{ leafId: 'a', type: 'markdown', path: 'a.md' }] }],
	closed: [],
	unmatched: [{ groupId: 'g2', name: 'Old', color: 'red', collapsed: false, members: [{ type: 'markdown', path: 'x.md' }, { type: 'markdown', path: 'y.md' }] }],
};

// The debounced save uses window timers.
vi.stubGlobal('window', globalThis);

beforeEach(() => {
	notices.length = 0;
	fault.restore = false;
});

describe('restore that throws (restore-throw-overwrites)', () => {
	it('never overwrites the stored session and tells the user', () => {
		fault.restore = true;
		const mem = memoryStorage(JSON.parse(JSON.stringify(stored)));
		const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a')], currentLeafId: 'a' }], activeLeafId: 'a' };
		const c = controllerFor(snapshot, mem.storage);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		c.restore();
		errors.mockRestore();
		c.saveNow();
		expect(mem.writes).toEqual([]);
		expect(mem.current()).toEqual(stored);
		expect(notices).toEqual([t.t('notice.restoreFailed')]);
	});

	it('positive control: without the fault, a later change is saved', () => {
		const mem = memoryStorage(JSON.parse(JSON.stringify(stored)));
		const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a')], currentLeafId: 'a' }], activeLeafId: 'a' };
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.state = { ...c.state, groups: c.state.groups.map((g) => ({ ...g, name: 'Renamed' })) };
		c.saveNow();
		expect(mem.writes).toHaveLength(1);
		expect((mem.current() as { groups: { name: string }[] }).groups[0]?.name).toBe('Renamed');
	});
});

describe('"Restore unmatched groups" when the command is refused (unmatched-restore-false-success)', () => {
	// x.md and y.md are open but not side by side, so the group needs a move; without the move
	// recipe (features.moves false) the command is refused.
	const snapshot: Snapshot = {
		panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a'), leaf('x', 'x.md'), leaf('b'), leaf('y', 'y.md')], currentLeafId: 'a' }],
		activeLeafId: 'a',
	};

	it('keeps the unmatched list and does not claim success', () => {
		const mem = memoryStorage(JSON.parse(JSON.stringify(stored)));
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.running = true;
		c.features = features;
		notices.length = 0;
		expect(c.unmatchedCount).toBe(1);
		const restored = c.restoreUnmatchedGroups();
		expect(restored).toBe(0);
		expect(c.unmatchedCount).toBe(1);
		expect(c.state.groups.map((g) => g.id)).toEqual(['g1']);
		expect(notices).toEqual([t.t('notice.unmatchedRefused')]);
	});

	it('positive control: with the move recipe the group is recreated and leaves the list', () => {
		const mem = memoryStorage(JSON.parse(JSON.stringify(stored)));
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.running = true;
		c.features = { ...features, moves: true };
		notices.length = 0;
		expect(c.restoreUnmatchedGroups()).toBe(1);
		expect(c.unmatchedCount).toBe(0);
		expect(c.state.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
		expect(notices).toEqual([t.t('notice.restoredUnmatched', { count: 1 })]);
	});
});

describe('"Restore unmatched groups" with members that match nothing (L6 review round 2)', () => {
	it('recreates the group from what matched, keeps the rest in the list and says so', () => {
		// Only x.md is open: y.md must stay recoverable.
		const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a'), leaf('x', 'x.md')], currentLeafId: 'a' }], activeLeafId: 'a' };
		const mem = memoryStorage(JSON.parse(JSON.stringify(stored)));
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.running = true;
		c.features = { ...features, moves: true };
		notices.length = 0;
		expect(c.restoreUnmatchedGroups()).toBe(1);
		expect(c.state.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
		expect(c.unmatchedCount).toBe(1);
		expect(notices).toEqual([t.t('notice.restoredUnmatchedPartial', { count: 1, left: 1 })]);
		c.saveNow();
		const saved = mem.current() as { unmatched: { groupId: string; name: string; members: { path: string }[] }[] };
		expect(saved.unmatched).toEqual([{ groupId: 'g3', name: 'Old', color: 'red', collapsed: false, members: [{ type: 'markdown', path: 'y.md' }] }]);
	});
});

describe('empty storage is not written back (readme-clear-rewrite-claim)', () => {
	const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a')], currentLeafId: 'a' }], activeLeafId: 'a' };

	it('a start with nothing stored and no group writes nothing', () => {
		const mem = memoryStorage(null);
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.saveNow();
		expect(mem.writes).toEqual([]);
		expect(mem.current()).toBeNull();
	});

	it('positive control: the first group made after such a start is saved', () => {
		const mem = memoryStorage(null);
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.state = { ...c.state, groups: [{ id: 'g1', name: 'New', color: 'blue', collapsed: false }], members: [{ leafId: 'a', groupId: 'g1', fingerprint: { viewType: 'markdown', path: 'a.md' } }] };
		c.saveNow();
		expect(mem.writes).toHaveLength(1);
		expect((mem.current() as { groups: { name: string }[] }).groups[0]?.name).toBe('New');
	});
});

describe('a parked group rebuilt by undo-close (parked-group-id-revived-by-tombstone, review round 3)', () => {
	// Stored: G = [a] (a is gone) and a closed record of b from G. b is not open at start, so G is
	// parked; then native undo-close brings b back and the first pass rebuilds G under its id.
	const sess = {
		version: 1,
		nextGroupSeq: 50,
		groups: [{ groupId: 'g7', name: 'G', color: 'red', collapsed: false, members: [{ leafId: 'a', type: 'markdown', path: 'a.md' }] }],
		closed: [{ leafId: 'b', groupId: 'g7', name: 'G', color: 'red', pane: 'old', paneIndex: 1, indexInGroup: 1, left: 'x', right: null, type: 'markdown', path: 'b.md' }],
		unmatched: [],
	};
	const strip = (...ids: string[]): Snapshot => ({ panes: [{ id: 'p0', kind: 'main', leaves: ids.map((id) => leaf(id)), currentLeafId: ids[0] ?? null }], activeLeafId: ids[0] ?? null });

	function live(mem: ReturnType<typeof memoryStorage>) {
		let current = strip('x', 'y');
		const adapter = { read: () => readOf(current), verticalTabsSignals: () => ({ views: 0, bodyClasses: [] }) } as unknown as WorkspaceAdapter;
		const c = new Controller(adapter, t, () => features, mem.storage) as unknown as Internals & { pass(triggers: string[]): void };
		c.render = () => undefined;
		c.record = () => undefined;
		c.applyOps = () => undefined;
		return { c, set: (s: Snapshot) => (current = s) };
	}

	it('keeps one copy of the group: it leaves the unmatched list, and the saved record reads back cleanly', async () => {
		const { parseSession } = await import('../../../src/core');
		const mem = memoryStorage(JSON.parse(JSON.stringify(sess)));
		const { c, set } = live(mem);
		c.restore();
		c.running = true;
		c.features = features;
		expect(c.unmatchedCount).toBe(1);
		set(strip('x', 'y', 'b'));
		c.pass(['layout-change']);
		expect(c.state.groups.map((g) => g.id)).toEqual(['g7']);
		expect(c.unmatchedCount).toBe(0);
		c.saveNow();
		const back = parseSession(mem.current());
		expect(back.kind === 'ok' ? back.problems : ['not ok']).toEqual([]);
		expect(back.kind === 'ok' ? back.session.groups.map((g) => g.groupId) : []).toEqual(['g7']);
		// "Restore unmatched groups" has nothing left to recreate: no second group G.
		set(strip('x', 'y', 'b', 'a'));
		notices.length = 0;
		expect(c.restoreUnmatchedGroups()).toBe(0);
		expect(c.state.groups.filter((g) => g.name === 'G')).toHaveLength(1);
	});

	it('positive control: a pass that rebuilds nothing keeps the parked group', () => {
		const mem = memoryStorage(JSON.parse(JSON.stringify(sess)));
		const { c, set } = live(mem);
		c.restore();
		c.running = true;
		c.features = features;
		set(strip('x', 'y', 'z'));
		c.pass(['layout-change']);
		expect(c.state.groups).toEqual([]);
		expect(c.unmatchedCount).toBe(1);
	});
});

describe('saves are debounced and coalesced (p14-burst-vacuous, L6 review round 4)', () => {
	// Every step below really changes the state (a rename), so each write that happens is a write
	// of new data: a save per request would show up as one write per step.
	const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a')], currentLeafId: 'a' }], activeLeafId: 'a' };

	function started() {
		const mem = memoryStorage(JSON.parse(JSON.stringify(stored)));
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.running = true;
		c.features = features;
		const rename = (name: string) => {
			c.state = { ...c.state, groups: c.state.groups.map((g) => ({ ...g, name })) };
			c.requestSave();
		};
		const savedName = () => (mem.current() as { groups: { name: string }[] }).groups[0]?.name;
		return { c, mem, rename, savedName };
	}

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		return () => {
			vi.useRealTimers();
		};
	});

	it('the debounce is at least 300 ms and the max wait is longer than it', () => {
		expect(SAVE_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
		expect(SAVE_MAX_WAIT_MS).toBeGreaterThan(SAVE_DEBOUNCE_MS);
	});

	it('a burst of 20 changes 10 ms apart is written once, SAVE_DEBOUNCE_MS after the last change, with the last state', () => {
		const { mem, rename, savedName } = started();
		for (let i = 0; i < 20; i++) {
			rename(`Burst ${String(i)}`);
			vi.advanceTimersByTime(10);
		}
		// The last change was 10 ms ago: nothing is written until SAVE_DEBOUNCE_MS after it.
		vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 11);
		expect(mem.writes).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(mem.writes).toHaveLength(1);
		expect(savedName()).toBe('Burst 19');
		vi.advanceTimersByTime(5000);
		expect(mem.writes).toHaveLength(1);
	});

	it('changes that never pause are still written every SAVE_MAX_WAIT_MS, and once more after they stop', () => {
		const { mem, rename, savedName } = started();
		const step = 100;
		const writeTimes: number[] = [];
		let seen = 0;
		for (let t = 0; t < 4500; t += step) {
			rename(`Steady ${String(t)}`);
			vi.advanceTimersByTime(step);
			if (mem.writes.length > seen) {
				seen = mem.writes.length;
				writeTimes.push(t + step);
			}
		}
		// Each write lands SAVE_MAX_WAIT_MS after the first unsaved change of its round.
		expect(writeTimes).toEqual([SAVE_MAX_WAIT_MS, 2 * SAVE_MAX_WAIT_MS]);
		vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
		expect(mem.writes).toHaveLength(3);
		expect(savedName()).toBe('Steady 4400');
	});

	it('positive control: two changes further apart than the debounce are two writes', () => {
		const { mem, rename, savedName } = started();
		rename('First');
		vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
		expect(mem.writes).toHaveLength(1);
		expect(savedName()).toBe('First');
		rename('Second');
		vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
		expect(mem.writes).toHaveLength(2);
		expect(savedName()).toBe('Second');
	});
});

describe('a full unmatched list is never cut silently (unmatched-silently-truncated, L6 review round 5)', () => {
	const old = (i: number) => ({ groupId: `u${String(i)}`, name: `Old ${String(i)}`, color: 'red', collapsed: false, members: [{ type: 'markdown', path: `old${String(i)}.md` }] });
	const lost = { groupId: 'g1', name: 'Lost', color: 'blue', collapsed: false, members: [{ leafId: 'gone', type: 'markdown', path: 'gone.md' }] };
	const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a')], currentLeafId: 'a' }], activeLeafId: 'a' };

	it('start-up: the notice counts the group parked now and a second notice says how many old entries were removed', async () => {
		const { SESSION_LIMITS } = await import('../../../src/core');
		const full = Array.from({ length: SESSION_LIMITS.unmatched }, (_, i) => old(i));
		const mem = memoryStorage({ version: 1, nextGroupSeq: 5, groups: [lost], closed: [], unmatched: full });
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		expect(c.unmatchedCount).toBe(SESSION_LIMITS.unmatched);
		expect(notices).toEqual([
			'Tabstrip: tab groups without matching open tabs: 1. Run "Restore unmatched groups" to try again.',
			`Tabstrip: the unmatched list keeps at most ${String(SESSION_LIMITS.unmatched)} tab groups. The 1 oldest were removed to make room.`,
		]);
	});

	it('positive control: with room in the list there is only the start-up notice', () => {
		const mem = memoryStorage({ version: 1, nextGroupSeq: 5, groups: [lost], closed: [], unmatched: [old(0), old(1)] });
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		expect(c.unmatchedCount).toBe(3);
		expect(notices).toEqual(['Tabstrip: tab groups without matching open tabs: 1. Run "Restore unmatched groups" to try again.']);
	});
});

describe('a stored value the plugin cannot read is kept until the user clears it (corrupt-overwritten, L6 review round 6)', () => {
	const snapshot: Snapshot = { panes: [{ id: 'p0', kind: 'main', leaves: [leaf('a')], currentLeafId: 'a' }], activeLeafId: 'a' };
	const unreadable: [string, unknown][] = [
		['a string', 'hello'],
		['a version as text', { version: '2', groups: [] }],
		['a fractional version', { version: 2.5, groups: [] }],
		['a negative version', { version: -1 }],
		['no version', { groups: [{ groupId: 'g1' }] }],
		['an array', [1, 2, 3]],
		['a number', 42],
	];
	const makeGroup = (c: Internals) => {
		c.state = { ...c.state, groups: [{ id: 'g1', name: 'New', color: 'blue', collapsed: false }], members: [{ leafId: 'a', groupId: 'g1', fingerprint: { viewType: 'markdown', path: 'a.md' } }] };
	};

	for (const [name, value] of unreadable) {
		it(`${name}: no write at start-up or after a change, and the notice says how to start saving again`, () => {
			const mem = memoryStorage(JSON.parse(JSON.stringify(value)));
			const c = controllerFor(snapshot, mem.storage);
			c.restore();
			c.saveNow();
			makeGroup(c);
			c.saveNow();
			expect(mem.writes).toEqual([]);
			expect(mem.current()).toEqual(value);
			expect(notices).toEqual([t.t('notice.storeCorrupt')]);
		});
	}

	it('positive control: after "Clear data on this device" the next change is saved', () => {
		const mem = memoryStorage('hello');
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.clearData();
		makeGroup(c);
		c.saveNow();
		expect(mem.writes).toHaveLength(1);
		expect((mem.current() as { groups: { name: string }[] }).groups[0]?.name).toBe('New');
	});

	it('positive control: a readable record with skipped parts is repaired (written back) as before', () => {
		const mem = memoryStorage({ version: 1, nextGroupSeq: 3, groups: [{ groupId: 'g1', name: 'Work', color: 'green', members: [{ leafId: 'a', type: 'markdown', path: 'a.md' }] }, 'junk'], closed: [], unmatched: [] });
		const c = controllerFor(snapshot, mem.storage);
		c.restore();
		c.saveNow();
		expect(mem.writes).toHaveLength(1);
		expect(notices).toEqual([t.t('notice.storePartial')]);
	});
});
