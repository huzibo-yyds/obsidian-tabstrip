/**
 * Invisible sandbox: makes every sandbox window (pop-outs included) fully transparent and
 * click-through, so test runs never disturb the user working on this Mac. Rendering, screenshots
 * (taken inside Chromium) and WebDriver input (sent through Chromium, not the OS) are unaffected.
 * Pop-outs share the main window's JS context, so the main window hides them on 'window-open'.
 * Test-only: uses Electron's remote module from the page, which plugin code never does.
 */
import { browser } from '@wdio/globals';

export async function hideSandboxWindows(): Promise<string> {
	return browser.execute(() => {
		type Win = { id: number; isDestroyed(): boolean; setOpacity(o: number): void; setIgnoreMouseEvents(i: boolean): void };
		type Electron = { remote?: { BrowserWindow: { getAllWindows(): Win[] } } };
		type Ws = { on(name: 'window-open', cb: () => void): unknown };
		const remote = (window as unknown as { require(m: string): Electron }).require('electron').remote;
		if (!remote) return 'no electron.remote';
		// Each window is hidden once, right after it opens. An earlier version polled every window
		// every 100 ms; on 1.13.4 that touched pop-outs while they were closing and ChromeDriver
		// crashed (3 of 4 runs). Windows are never touched again after they are hidden.
		const host = window as unknown as { __tabstripHidden?: Set<number>; app: { workspace: Ws } };
		const seen = (host.__tabstripHidden ??= new Set<number>());
		const fresh = host.__tabstripHidden.size === 0;
		const hide = () => {
			for (const w of remote.BrowserWindow.getAllWindows()) {
				if (seen.has(w.id) || w.isDestroyed()) continue;
				seen.add(w.id);
				w.setOpacity(0);
				w.setIgnoreMouseEvents(true);
			}
		};
		hide();
		// Pop-outs: Obsidian's public 'window-open' event, after the window exists.
		if (fresh) host.app.workspace.on('window-open', () => window.setTimeout(hide, 0));
		return 'hidden';
	});
}
