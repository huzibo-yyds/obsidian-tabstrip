/**
 * Release preparation: the test-setup hooks of `plugin.debug` do nothing in normal use. They work
 * only while the main window carries the test-hooks flag (set by the e2e harness and the `npm run
 * try` seed plugin). The read-only diagnostics stay available.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_HOOKS_FLAG, testHook, testHooksEnabled } from '../../src/test-hooks';

vi.mock('obsidian', () => ({
	Plugin: class {
		constructor(readonly app: unknown) {}
	},
	getLanguage: () => 'en',
	Menu: class {},
	Modal: class {},
	Notice: class {},
	Scope: class {},
	Setting: class {},
	View: class {},
	WorkspaceFloating: class {},
	WorkspaceTabs: class {},
	setIcon: () => undefined,
}));

const host = globalThis as unknown as Record<string, unknown>;
vi.stubGlobal('window', globalThis);

afterEach(() => {
	Reflect.deleteProperty(host, TEST_HOOKS_FLAG);
});

describe('test hooks gate', () => {
	it('is off unless the flag is exactly true', () => {
		expect(TEST_HOOKS_FLAG).toBe('tabstripTestHooks');
		expect(testHooksEnabled({})).toBe(false);
		expect(testHooksEnabled({ [TEST_HOOKS_FLAG]: 'true' })).toBe(false);
		expect(testHooksEnabled({ [TEST_HOOKS_FLAG]: 1 })).toBe(false);
		expect(testHooksEnabled(null)).toBe(false);
		expect(testHooksEnabled({ [TEST_HOOKS_FLAG]: true })).toBe(true);
		// Default host: the main window.
		expect(testHooksEnabled()).toBe(false);
		host[TEST_HOOKS_FLAG] = true;
		expect(testHooksEnabled()).toBe(true);
	});

	it('a wrapped hook returns the "off" value without running, and runs once the flag is set (read at each call)', () => {
		const run = vi.fn((a: number, b: number) => a + b);
		const hook = testHook(-1, run);
		expect(hook(1, 2)).toBe(-1);
		expect(run).not.toHaveBeenCalled();
		host[TEST_HOOKS_FLAG] = true;
		expect(hook(1, 2)).toBe(3);
		expect(run).toHaveBeenCalledTimes(1);
		Reflect.deleteProperty(host, TEST_HOOKS_FLAG);
		expect(hook(1, 2)).toBe(-1);
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe('plugin.debug', () => {
	async function plugin() {
		const { default: TabstripPlugin } = await import('../../src/main');
		const p = new (TabstripPlugin as unknown as new (app: unknown) => { debug: Record<string, (...args: unknown[]) => unknown> })({});
		const calls: string[] = [];
		const controller = {
			snapshotState: () => ({ groups: [{ id: 'g1' }], members: [], tombstones: [], nextGroupSeq: 2 }),
			flush: () => calls.push('flush'),
			flushSave: () => calls.push('flushSave'),
			createGroupOf: (ids: string[], name: string, color?: string) => {
				calls.push(`group(${ids.join(',')},${name},${String(color)})`);
				return 'g9';
			},
			setGroupCollapsed: (id: string, on: boolean) => {
				calls.push(`collapse(${id},${String(on)})`);
				return true;
			},
			rename: (id: string, name: string) => calls.push(`rename(${id},${name})`),
			setTrace: (on: boolean) => {
				calls.push(`trace(${String(on)})`);
				return [];
			},
			chipObservers: (on?: boolean) => {
				calls.push(`chipObservers(${String(on)})`);
				return 3;
			},
			orientationMode: 'vertical',
		};
		(p as unknown as { controller: unknown }).controller = controller;
		return { d: p.debug, calls };
	}

	const testSetup = (d: Record<string, (...args: unknown[]) => unknown>) => [
		d.flush?.(),
		d.flushSave?.(),
		d.group?.(['a', 'b'], 'Work', 'blue'),
		d.setCollapsed?.('g1', true),
		d.rename?.('g1', 'New'),
		d.trace?.(true),
		d.chipObservers?.(false),
	];

	it('without the flag: the test-setup hooks change nothing; the read-only diagnostics work', async () => {
		const { d, calls } = await plugin();
		expect(testSetup(d)).toEqual([undefined, undefined, null, false, undefined, [], 3]);
		// chipObservers without the flag only counts (the switch is not passed on).
		expect(calls).toEqual(['chipObservers(undefined)']);
		expect((d.state?.() as { groups: unknown[] }).groups).toHaveLength(1);
		expect(d.orientation?.()).toBe('vertical');
	});

	it('positive control: with the flag every test-setup hook reaches the controller', async () => {
		const { d, calls } = await plugin();
		host[TEST_HOOKS_FLAG] = true;
		expect(testSetup(d)).toEqual([undefined, undefined, 'g9', true, undefined, [], 3]);
		expect(calls).toEqual(['flush', 'flushSave', 'group(a,b,Work,blue)', 'collapse(g1,true)', 'rename(g1,New)', 'trace(true)', 'chipObservers(false)']);
	});
});
