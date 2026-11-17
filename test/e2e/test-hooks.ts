/**
 * The test-setup hooks of the plugin's `debug` object (group, rename, flush, ...) do nothing unless
 * the main window carries the flag of src/test-hooks.ts. wdio.conf.mts sets it at the start of every
 * session and after every reload; the flag lives in the page, so plugin reloads keep it.
 *
 * After `reloadObsidian` the command can return while the new main window is still loading its
 * vault (a flag set then is lost with that page), so this waits for the workspace layout to be
 * ready in the page before it sets the flag.
 */
import { browser } from '@wdio/globals';
import { TEST_HOOKS_FLAG } from '../../src/test-hooks';

export async function enableTestHooks(timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		const on = await browser
			.execute((flag: string) => {
				const host = window as unknown as Record<string, unknown> & { app?: { workspace?: { layoutReady?: boolean } } };
				if (host.app?.workspace?.layoutReady !== true) return false;
				host[flag] = true;
				return host[flag] === true;
			}, TEST_HOOKS_FLAG)
			.catch(() => false);
		if (on) return;
		if (Date.now() - start > timeoutMs) throw new Error('Could not turn on the test hooks: the workspace layout did not become ready');
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
