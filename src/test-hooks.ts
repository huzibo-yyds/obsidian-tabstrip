/**
 * The test-setup hooks of `plugin.debug` (group, rename, collapse, flush, trace, the chip
 * ResizeObserver switch) do nothing in normal use. They work only while the main window carries
 * the flag below, which only the end-to-end harness (wdio.conf.mts) and the development-only seed
 * plugin of `npm run try` set. The read-only diagnostics of `plugin.debug` are always there.
 *
 * This file must not import `obsidian`, so the gate can be unit-tested.
 */

/** Property of the main window that turns the test-setup hooks on (set to `true`). */
export const TEST_HOOKS_FLAG = 'tabstripTestHooks';

/** Whether the test-setup hooks are on: `host` (default: the main window) has the flag set to `true`. */
export function testHooksEnabled(host: unknown = typeof window === 'undefined' ? undefined : window): boolean {
	return typeof host === 'object' && host !== null && (host as Record<string, unknown>)[TEST_HOOKS_FLAG] === true;
}

/**
 * Wraps a test-setup hook: it runs `hook` while the hooks are on (`isOn`, default
 * testHooksEnabled), else it does nothing and returns `off`. The flag is read at every call, so it
 * survives a plugin reload but not a window reload.
 */
export function testHook<A extends unknown[], R>(off: R, hook: (...args: A) => R, isOn: () => boolean = () => testHooksEnabled()): (...args: A) => R {
	return (...args: A): R => (isOn() ? hook(...args) : off);
}
