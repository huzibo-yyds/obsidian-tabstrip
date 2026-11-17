/**
 * Per-device storage of the session (persistence tier T1, requirements 7.3): one key in the app's
 * vault-specific local storage, through the public `App.loadLocalStorage` / `saveLocalStorage`
 * (since 1.8.7). Not synced; nothing keyed by leaf id goes into data.json; workspace.json is never
 * written. Every stored key is listed in the README (uninstall section).
 */
import type { App } from 'obsidian';

/** The only key Tabstrip stores on a device (per vault). */
export const SESSION_KEY = 'tabstrip-session-v1';

export interface SessionStorage {
	/** The stored value, already parsed (null when nothing is stored or it is not valid JSON). */
	load(): unknown;
	save(value: unknown): void;
	/** Removes the key. */
	clear(): void;
}

export function appStorage(app: App): SessionStorage {
	return {
		load: () => {
			try {
				return app.loadLocalStorage(SESSION_KEY) as unknown;
			} catch (e) {
				console.error('Tabstrip: could not read the saved tab groups', e);
				return null;
			}
		},
		save: (value) => {
			try {
				app.saveLocalStorage(SESSION_KEY, value);
			} catch (e) {
				console.error('Tabstrip: could not save the tab groups', e);
			}
		},
		clear: () => {
			try {
				app.saveLocalStorage(SESSION_KEY, null);
			} catch (e) {
				console.error('Tabstrip: could not clear the saved tab groups', e);
			}
		},
	};
}
