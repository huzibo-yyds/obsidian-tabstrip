import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hideSandboxWindows } from './test/e2e/invisible.ts';
import { enableTestHooks } from './test/e2e/test-hooks.ts';
import { mainVaultPath } from './scripts/host-guard.mjs';
import { sandboxBundleProblems, bundleOfBinary, HIDE_SHIM_VISIBLE_SWITCH } from './scripts/sandbox-app.mjs';

// End-to-end tests in a SANDBOX Obsidian started by wdio-obsidian-service.
// Run through `npm run e2e` (scripts/e2e.mjs), never `wdio run` directly: the wrapper gives the
// sandbox its own HOME, a patched installer, and checks the host Obsidian before and after the run.

// Safety interlock 1. Obsidian (1.12+) deletes and re-creates ~/.obsidian-cli.sock at startup, so a
// sandbox started with the real HOME would take the CLI socket away from the Obsidian the user has
// open. Refuse to start unless HOME (and CFFIXED_USER_HOME) is the throwaway home made by scripts/e2e.mjs.
const realHome = os.userInfo().homedir;
const sandboxHome = process.env.TABSTRIP_SANDBOX_HOME;
if (
	!sandboxHome ||
	process.env.HOME !== sandboxHome ||
	process.env.CFFIXED_USER_HOME !== sandboxHome ||
	path.resolve(sandboxHome) === path.resolve(realHome) ||
	!path.resolve(sandboxHome).startsWith(path.resolve(os.tmpdir()))
) {
	throw new Error(
		'Refusing to launch a sandbox Obsidian with the real HOME (it would take over the host ~/.obsidian-cli.sock). Use `npm run e2e`.',
	);
}

// Obsidian app versions to test, comma-separated. Default: the version the user runs.
const versions = (process.env.TABSTRIP_E2E_VERSIONS ?? '1.15.0')
	.split(',')
	.map((v) => v.trim())
	.filter((v) => v.length > 0);

// Shared download cache outside the repo; resolved from the real home, not the sandbox HOME.
const cacheDir = process.env.OBSIDIAN_CACHE ?? path.join(realHome, '.obsidian-cache');

// Safety interlock 2. The official installer has the host app's bundle id (md.obsidian), so macOS
// would store the sandbox's preferences in the host app's preferences domain. Only run the patched
// copy without a bundle id that scripts/e2e.mjs prepares (see scripts/sandbox-app.mjs).
interface SandboxInstaller {
	appVersion: string;
	installerVersion: string;
	binaryPath: string;
	/** Info.plist activation mode of the patched copy (scripts/sandbox-app.mjs ACTIVATION_MODES). */
	activation?: string;
}
const installersFile = process.env.TABSTRIP_SANDBOX_INSTALLERS;
const installers: Record<string, SandboxInstaller | undefined> = installersFile
	? (JSON.parse(fs.readFileSync(installersFile, 'utf8')) as Record<string, SandboxInstaller | undefined>)
	: {};
const sandboxInstallerFor = (appVersion: string): SandboxInstaller => {
	const entry = installers[appVersion];
	const problems = entry ? sandboxBundleProblems(bundleOfBinary(entry.binaryPath), cacheDir) : ['no patched installer prepared'];
	if (!entry || problems.length > 0) {
		throw new Error(
			`Refusing to launch Obsidian ${appVersion} from an installer that shares the host's bundle id (${problems.join('; ')}). Use \`npm run e2e\`.`,
		);
	}
	return entry;
};

// Quiet sandbox (activation "background", see scripts/sandbox-app.mjs): the sandbox never becomes
// the active app, so it cannot take the keyboard focus. Measured side effect: when ChromeDriver's
// quit request arrives less than ~1 s after the previous WebDriver command, the sandbox closes its
// window but its main process does not exit, and ChromeDriver waits 10 s before it terminates it.
// With 1 s or more of quiet before the quit it exits in about 0.2 s. So before a session ends, wait
// until 1.5 s have passed since the last command. This only waits; it changes nothing in the app.
const QUIET_BEFORE_QUIT_MS = 1500;

// Community themes for the L4 look and contrast cases: Atom (the user's theme) and three more
// themes installed in the user's vault whose tab rules the chip must survive (Cupertino, Blue
// Topaz, Minimal; requirements 5.6). Their two files are READ from the user's vault and written
// into the git-ignored test/themes/<name>; nothing is written to the vault. The themes are
// installed into the temporary vault copy, not enabled. Missing theme: not installed, and the
// cases that need it fail with a clear message.
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const themeFiles = ['manifest.json', 'theme.css'];
// Main vault: TABSTRIP_MAIN_VAULT or .tabstrip-local.json (scripts/host-guard.mjs); without it only
// copies already in test/themes are used.
const mainVault = mainVaultPath();
const themeSource = (name: string): string | null =>
	name === 'Atom' && process.env.TABSTRIP_ATOM_THEME_DIR
		? process.env.TABSTRIP_ATOM_THEME_DIR
		: mainVault === null
			? null
			: path.join(mainVault, '.obsidian', 'themes', name);
const themes = ['Atom', 'Cupertino', 'Blue Topaz', 'Minimal'].flatMap((name) => {
	const copy = path.join(repoRoot, 'test', 'themes', name);
	const source = themeSource(name);
	if (source !== null && themeFiles.every((file) => fs.existsSync(path.join(source, file)))) {
		fs.mkdirSync(copy, { recursive: true });
		for (const file of themeFiles) fs.writeFileSync(path.join(copy, file), fs.readFileSync(path.join(source, file)));
	}
	return themeFiles.every((file) => fs.existsSync(path.join(copy, file))) ? [{ path: copy, enabled: false }] : [];
});
const quietSandbox = Object.values(installers).some((entry) => entry?.activation === 'background');
let lastCommandAt = 0;

// Invisible sandbox (user request 2026-11-09: tests must not disturb the user's work on this Mac).
// The background activation mode already keeps the focus away; this also makes every sandbox
// window fully transparent and click-through, so it can sit on screen without being seen or hit.
// Rendering, screenshots (taken inside Chromium) and WebDriver input (sent through Chromium, not
// the OS) are unaffected. Pop-outs share the main window's JS context, so one poller in the main
// window catches them too. TABSTRIP_SANDBOX_VISIBLE=1 turns it off to watch a run.
const invisibleSandbox = process.env.TABSTRIP_SANDBOX_VISIBLE !== '1';

// Device scale factor the sandbox renders at (Chromium's --force-device-scale-factor), whatever the
// main display is. Always 2 for real runs: the pixel checks need 2x screenshots. 1 exists only for
// the control run of test/e2e/specs/scale.e2e.ts (proves the switch, not the display, decides).
const sandboxScale = process.env.TABSTRIP_SANDBOX_SCALE ?? '2';
if (sandboxScale !== '1' && sandboxScale !== '2') throw new Error(`TABSTRIP_SANDBOX_SCALE must be 1 or 2, got ${sandboxScale}`);

export const config: WebdriverIO.Config = {
	runner: 'local',
	framework: 'mocha',
	specs: ['./test/e2e/specs/**/*.e2e.ts'],
	// One sandbox at a time.
	maxInstances: 1,

	capabilities: versions.map((appVersion) => ({
		browserName: 'obsidian',
		browserVersion: appVersion,
		'wdio:obsidianOptions': {
			// The oldest installer that runs this app version, resolved by scripts/e2e.mjs, run from
			// its patched copy (no bundle id, no URL scheme or file type claims).
			installerVersion: sandboxInstallerFor(appVersion).installerVersion,
			binaryPath: sandboxInstallerFor(appVersion).binaryPath,
			// '.' is Tabstrip. The probe is a test-only plugin that logs known messages at startup,
			// proving the browser log captures what plugins print while they load.
			plugins: ['.', 'test/e2e/plugins/startup-log-probe'],
			vault: 'test/vaults/basic',
			// Tests run on a temporary copy; the fixture vault in the repo is never modified.
			copy: true,
			themes,
		},
		'goog:chromeOptions': {
			args: [
				'--lang=en',
				// The quiet sandbox window usually sits behind other windows. Keep it drawing and its
				// timers at full speed, else screenshots time out and the plugin's next-tick passes lag.
				'--disable-backgrounding-occluded-windows',
				'--disable-renderer-backgrounding',
				'--disable-background-timer-throttling',
				// Render at a fixed 2x scale whatever the user's main display is (step L6): the pixel
				// checks (underline and divider paint) need 2x screenshots, and they must not depend on
				// which monitor is the main one. Chromium's own switch; the display is not touched.
				`--force-device-scale-factor=${sandboxScale}`,
				// The installer copy's main-process shim (scripts/sandbox-app.mjs) hides every window as
				// it is created; this switch turns that off when the user asks to watch a run.
				...(invisibleSandbox ? [] : [HIDE_SHIM_VISIBLE_SWITCH]),
			],
		},
		'goog:loggingPrefs': {
			browser: 'ALL',
		},
	})),

	services: ['obsidian'],
	reporters: ['obsidian'],
	cacheDir,
	mochaOpts: {
		ui: 'bdd',
		timeout: 120_000,
	},
	logLevel: 'warn',

	async before() {
		await enableTestHooks();
		if (!invisibleSandbox) return;
		const result = await hideSandboxWindows();
		if (result !== 'hidden') throw new Error(`Could not make the sandbox invisible: ${result}`);
	},
	async afterCommand(commandName: string) {
		// `pause` only waits in this process; it does not talk to the sandbox.
		if (commandName !== 'pause') lastCommandAt = Date.now();
		// A reload starts a fresh main window and JS context: turn the test hooks on and hide it again.
		// `reloadObsidian` (wdio-obsidian-service) does not reach this hook itself (measured
		// 2026-11-17: only its inner deleteSession / reloadSession do), so the new session is caught at
		// its `reloadSession`; enableTestHooks waits until the new window's layout is ready.
		if (commandName !== 'reloadSession' && commandName !== 'reloadObsidian') return;
		await enableTestHooks();
		if (invisibleSandbox) await hideSandboxWindows();
	},
	async beforeCommand(commandName: string) {
		if (!quietSandbox || commandName !== 'deleteSession') return;
		const wait = lastCommandAt + QUIET_BEFORE_QUIT_MS - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	},
};
