import { browser, expect } from '@wdio/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TabStripSnapshot } from '../../../src/adapter/workspace';
import { bundleIdentifier, bundleOfBinary, sandboxBundleProblems } from '../../../scripts/sandbox-app.mjs';
import { repoRoot } from '../helpers';

const PLUGIN_ID = 'tabstrip';

/** Private `app.plugins` registry, read from tests only. */
interface PluginRegistry {
	plugins: Record<string, unknown>;
	enabledPlugins: Set<string>;
	manifests: Record<string, { version: string } | undefined>;
	enablePlugin(id: string): Promise<boolean>;
	disablePlugin(id: string): Promise<void>;
}

interface BrowserLogEntry {
	level: string;
	message: string;
	source?: string;
	timestamp: number;
}

describe('Tabstrip L1 skeleton', function () {
	it('runs the sandbox with its own HOME, so the host CLI socket is left alone', function () {
		const home = process.env.HOME ?? '';
		expect(home).not.toBe(os.userInfo().homedir);
		// The sandbox Obsidian created its CLI socket in the sandbox HOME, not in the user's home.
		expect(fs.existsSync(path.join(home, '.obsidian-cli.sock'))).toBe(true);
	});

	it('runs a patched sandbox build that cannot write the host preferences or obsidian:// handler', async function () {
		const installersFile = process.env.TABSTRIP_SANDBOX_INSTALLERS ?? '';
		const installers = JSON.parse(fs.readFileSync(installersFile, 'utf8')) as Record<string, { binaryPath: string } | undefined>;
		const entry = installers[browser.getObsidianVersion()];
		expect(entry).toBeDefined();
		if (!entry) return;
		const bundle = bundleOfBinary(entry.binaryPath);
		const cacheDir = process.env.OBSIDIAN_CACHE ?? path.join(os.userInfo().homedir, '.obsidian-cache');
		// No bundle id: macOS cannot file its preferences under the host's md.obsidian domain, and
		// Electron will not make it the obsidian:// handler.
		expect(bundleIdentifier(bundle)).toBeNull();
		expect(sandboxBundleProblems(bundle, cacheDir)).toEqual([]);
		// The running renderer really comes from that bundle and got the sandbox HOME.
		const renderer = await browser.execute(() => ({
			execPath: process.execPath,
			home: process.env.HOME ?? null,
			cfHome: process.env.CFFIXED_USER_HOME ?? null,
		}));
		console.log(`[e2e] sandbox renderer ${renderer.execPath}`);
		expect(renderer.execPath.startsWith(bundle + path.sep)).toBe(true);
		expect(renderer.home).toBe(process.env.HOME);
		expect(renderer.cfHome).toBe(process.env.HOME);
	});

	it('loads the tabstrip plugin', async function () {
		const state = await browser.executeObsidian(({ app }, id) => {
			const registry = (app as unknown as { plugins: PluginRegistry }).plugins;
			return {
				loaded: registry.plugins[id] !== undefined,
				enabled: registry.enabledPlugins.has(id),
				version: registry.manifests[id]?.version ?? null,
			};
		}, PLUGIN_ID);
		console.log(`[e2e] Obsidian ${browser.getObsidianVersion()} (installer ${browser.getObsidianInstallerVersion()}), plugin state ${JSON.stringify(state)}`);
		// The installed copy is this build: its version is the one in the repo's manifest.json.
		const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8')) as { version: string };
		expect(state).toEqual({ loaded: true, enabled: true, version: manifest.version });
	});

	it('opens 3 notes in tabs and reads their leaf ids in order from the tab strip', async function () {
		const paths = ['欢迎.md', '会议记录（2026-11-08）.md', '项目/计划.md'];
		const result = await browser.executeObsidian(async ({ app, plugins, obsidian }, notePaths) => {
			const opened: string[] = [];
			for (const p of notePaths) {
				const file = app.vault.getFileByPath(p);
				if (!file) throw new Error(`missing fixture note ${p}`);
				const leaf = app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				opened.push((leaf as unknown as { id: string }).id);
			}
			const plugin = plugins['tabstrip'] as unknown as { readTabStrips(): (TabStripSnapshot | null)[] };
			const strips = plugin.readTabStrips();
			// Files shown by the leaves, looked up by the ids the plugin read.
			const fileOf = (id: string) => {
				const view = app.workspace.getLeafById(id)?.view;
				return view instanceof obsidian.FileView ? (view.file?.path ?? null) : null;
			};
			const strip = strips.find((s) => s?.leafIds.includes(opened[0] ?? '')) ?? null;
			return {
				opened,
				strips,
				filesInStrip: strip ? strip.leafIds.map(fileOf) : [],
				activeLeafId: (app.workspace.getMostRecentLeaf() as unknown as { id?: string } | null)?.id ?? null,
			};
		}, paths);
		console.log(`[e2e] opened leaf ids ${JSON.stringify(result.opened)}; strips ${JSON.stringify(result.strips)}`);

		expect(result.opened).toHaveLength(3);
		expect(new Set(result.opened).size).toBe(3);
		// Every strip in the main area could be read (no private field had an unexpected shape).
		expect(result.strips.length).toBeGreaterThanOrEqual(1);
		expect(result.strips.every((s) => s !== null)).toBe(true);

		const strip = result.strips.find((s) => s?.leafIds.includes(result.opened[0] ?? ''));
		expect(strip).toBeDefined();
		if (!strip) return;
		// The three tabs are adjacent and in opening order, in Obsidian's order and on screen.
		const start = strip.leafIds.indexOf(result.opened[0] ?? '');
		expect(strip.leafIds.slice(start, start + 3)).toEqual(result.opened);
		expect(strip.headerLeafIds).toEqual(strip.leafIds);
		expect(strip.currentLeafId).toBe(result.opened[2]);
		expect(result.activeLeafId).toBe(result.opened[2]);
		// The ids read from the strip point at the notes that were opened.
		expect(result.filesInStrip.slice(start, start + 3)).toEqual(paths);
	});

	it('unloads and loads again without errors', async function () {
		const result = await browser.executeObsidian(async ({ app }, id) => {
			const registry = (app as unknown as { plugins: PluginRegistry }).plugins;
			const errors: string[] = [];
			const originalError = console.error;
			console.error = (...args: unknown[]) => {
				errors.push(args.map(String).join(' '));
				originalError.apply(console, args);
			};
			const onError = (e: ErrorEvent) => errors.push(`uncaught: ${e.message}`);
			const onRejection = (e: PromiseRejectionEvent) => errors.push(`unhandled rejection: ${String(e.reason)}`);
			window.addEventListener('error', onError);
			window.addEventListener('unhandledrejection', onRejection);
			try {
				await registry.disablePlugin(id);
				const unloaded = registry.plugins[id] === undefined;
				await registry.enablePlugin(id);
				await new Promise((resolve) => window.setTimeout(resolve, 500));
				return { errors, unloaded, reloaded: registry.plugins[id] !== undefined };
			} finally {
				console.error = originalError;
				window.removeEventListener('error', onError);
				window.removeEventListener('unhandledrejection', onRejection);
			}
		}, PLUGIN_ID);
		expect(result).toEqual({ errors: [], unloaded: true, reloaded: true });
	});

	it('has no error-level console messages from the plugin', async function () {
		// Positive controls: prove the browser log captures info and error levels, both now and
		// during plugin startup (the test-only probe plugin logs while it loads next to tabstrip).
		await browser.execute(() => {
			console.info('e2e-log-probe info');
			console.error('e2e-log-probe error');
		});
		// Everything the sandbox renderer logged since launch (plugin load, the tests above, reload).
		const logs = (await browser.getLogs('browser')) as BrowserLogEntry[];
		const levelsOf = (marker: string) =>
			logs
				.filter((l) => l.message.includes(marker))
				.map((l) => l.level)
				.sort();
		expect(levelsOf('e2e-log-probe')).toEqual(['INFO', 'SEVERE']);
		expect(levelsOf('e2e-startup-probe')).toEqual(['INFO', 'SEVERE']);

		const isProbe = (l: BrowserLogEntry) => /e2e-(startup-)?log-probe|e2e-startup-probe/.test(l.message);
		const severe = logs.filter((l) => l.level === 'SEVERE' && !isProbe(l));
		const fromPlugin = severe.filter((l) => /tabstrip/i.test(l.message));
		const levels: Record<string, number> = {};
		for (const l of logs) levels[l.level] = (levels[l.level] ?? 0) + 1;
		console.log(
			`[e2e] browser log: ${logs.length} entries ${JSON.stringify(levels)}, ${severe.length} error-level (probes excluded), ${fromPlugin.length} from the plugin`,
		);
		for (const l of severe) console.log(`[e2e]   SEVERE ${l.message.slice(0, 300)}`);
		expect(fromPlugin).toEqual([]);
		// Wish book L1 #2 is stricter: the whole sandbox console has no error-level message.
		expect(severe).toEqual([]);
	});
});
