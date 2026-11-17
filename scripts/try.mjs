#!/usr/bin/env node
/**
 * npm run try — open the plugin in an interactive sandbox Obsidian so the user can try it by hand.
 *
 * Same isolation as the e2e sandbox (scripts/e2e.mjs), minus the test driver:
 *  - a separate patched installer copy (no bundle id, ad-hoc signed; scripts/sandbox-app.mjs) in
 *    "regular" activation, so its window can be clicked and typed into. It is kept apart from the
 *    e2e copy (suffix "-try"), so the invisible e2e sandbox is not rebuilt;
 *  - a throwaway HOME / CFFIXED_USER_HOME and a throwaway Obsidian config dir;
 *  - a throwaway COPY of test/vaults/basic with the freshly built plugin installed;
 *  - the host snapshot (scripts/host-guard.mjs) before launch and after the window is closed;
 *  - the same ownership rule as scripts/e2e.mjs for the sandbox's own macOS preferences domain
 *    ("Obsidian": the copy has no bundle id): it must be empty or marked as ours before launch, it is
 *    marked while the sandbox runs, and it is deleted after the window is closed;
 *  - only one sandbox at a time: it refuses to start while another sandbox copy is running.
 * The window is visible on purpose (--tabstrip-sandbox-visible): this is the user's own try-out,
 * started by the user. Quit the sandbox with Cmd+Q in its window when done.
 * Options (scripts/try-options.mjs): --version <app version> (default 1.15.0); --vertical opens the
 * sandbox already in vertical tabs with a few groups (the development-only seed plugin
 * scripts/try-seed is installed next to Tabstrip in the throwaway vault copy).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectState, compareStates, defaultTargets, realHome } from './host-guard.mjs';
import { acquireSandboxLock } from './sandbox-lock.mjs';
import { HIDE_SHIM_VISIBLE_SWITCH, SANDBOX_PREFS_DOMAIN, deleteSandboxDomain, domainKeys, patchInstaller } from './sandbox-app.mjs';
import { tryOptions } from './try-options.mjs';

const repoRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const options = tryOptions(process.argv.slice(2), repoRoot);
if (options.problems.length > 0) {
	console.error(`[try] ${options.problems.join('; ')} (options: --version <app version>, --vertical)`);
	process.exit(1);
}
const requested = options.version;
const cacheDir = process.env.OBSIDIAN_CACHE ?? path.join(realHome(), '.obsidian-cache');
const say = (m) => console.log(`[try] ${m}`);
const stateDir = path.join(repoRoot, '.e2e-state');
// In the shared cache (not per checkout): with the sandbox lock, whoever runs next owns leftovers.
const prefsMarkerFile = path.join(cacheDir, 'tabstrip-sandbox-prefs-domain.json');

// One sandbox at a time (e2e or try, in any checkout): do not wait, say who holds it.
if (!(await acquireSandboxLock({ cacheDir, tool: 'scripts/try.mjs', say, wait: false }))) {
	say('refusing to start a second sandbox; try again when it has finished');
	process.exit(1);
}
// The sandbox preferences domain must hold nothing that is not ours (same rule as scripts/e2e.mjs).
const keysBefore = domainKeys(SANDBOX_PREFS_DOMAIN);
if (keysBefore.length > 0) {
	if (!fs.existsSync(prefsMarkerFile)) {
		say(`preferences domain "${SANDBOX_PREFS_DOMAIN}" is not empty (${keysBefore.join(', ')}) and was not created by this tool; refusing to run. Inspect it with: defaults read ${SANDBOX_PREFS_DOMAIN}`);
		process.exit(1);
	}
	say(`preferences domain "${SANDBOX_PREFS_DOMAIN}" holds ${keysBefore.length} key(s) left by an earlier sandbox run; deleting them`);
	deleteSandboxDomain();
}
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(prefsMarkerFile, JSON.stringify({ domain: SANDBOX_PREFS_DOMAIN, owner: 'scripts/try.mjs', startedAt: new Date().toISOString() }, null, 2));

const targets = defaultTargets();
const before = collectState(targets);
say(`host snapshot: Obsidian ${before.host.mainProcesses.map((p) => `pid ${p.pid}`).join(', ') || 'not running'}; ${before.vaults.length} vault(s)`);

const { default: ObsidianLauncher } = await import('obsidian-launcher');
const launcher = new ObsidianLauncher({ cacheDir });
const [appVersion, installerVersion] = await launcher.resolveVersion(requested, 'earliest');
const sourceBinary = await launcher.downloadInstaller(installerVersion);
const sourceBundle = path.resolve(sourceBinary, '..', '..', '..');
const binary = patchInstaller(sourceBundle, installerVersion, cacheDir, say, 'regular', '-try');

const vault = await launcher.setupVault({ vault: path.join(repoRoot, 'test', 'vaults', 'basic'), copy: true, plugins: options.plugins });
const configDir = await launcher.setupConfigDir({ appVersion, installerVersion, vault });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-try-home-'));
say(`Obsidian ${appVersion} (installer ${installerVersion}); vault copy: ${vault}${options.vertical ? '; opens in vertical tabs with a few groups (seed plugin)' : ''}`);
say('the sandbox window opens now; quit it with Cmd+Q in that window when you are done');

const child = spawn(binary, [`--user-data-dir=${configDir}`, HIDE_SHIM_VISIBLE_SWITCH], {
	env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home },
	stdio: 'ignore',
});
const code = await new Promise((resolve) => child.on('exit', resolve));
say(`sandbox exited (${code})`);

const after = collectState(before.targets, before.vaults.map((v) => v.path));
const result = compareStates(before, after);
say(`host check: ${result.ok ? 'PASS' : 'FAIL'}`);
for (const v of result.violations) say(`  FAIL  ${v}`);
for (const dir of [configDir, home, vault]) fs.rmSync(dir, { recursive: true, force: true });
const cleanup = deleteSandboxDomain();
const cleaned = cleanup.keysLeft.length === 0 && !cleanup.fileLeft;
if (cleaned) fs.rmSync(prefsMarkerFile, { force: true });
say(`sandbox preferences domain "${SANDBOX_PREFS_DOMAIN}" deleted: ${cleaned ? 'yes' : `no, keys left [${cleanup.keysLeft.join(', ')}]`}`);
process.exit(result.ok ? 0 : 1);
