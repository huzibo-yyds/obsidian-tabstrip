#!/usr/bin/env node
/**
 * Runs the e2e suite in a sandbox Obsidian, with host-safety checks around it.
 *
 *   node scripts/e2e.mjs            # Obsidian 1.15.0 (or TABSTRIP_E2E_VERSIONS)
 *   node scripts/e2e.mjs --matrix   # TABSTRIP_E2E_MATRIX, default 1.13.4,1.14.4,1.15.0
 *   node scripts/e2e.mjs --config spikes/s1-chip/wdio.conf.mts
 *                                   # another wdio config inside the repo (it must import
 *                                   # ./wdio.conf.mts, which holds the sandbox interlocks, and
 *                                   # build on its config; see scripts/config-guard.mjs)
 *   node scripts/e2e.mjs --spec test/e2e/specs/l4-groups.e2e.ts
 *                                   # only these spec files (repeatable; *.e2e.ts inside the repo)
 *
 * Steps:
 *  1. guard self-test: the host guard must catch doctored snapshots, else abort;
 *  2. prepare the sandbox installer: a patched copy without a bundle id (scripts/sandbox-app.mjs),
 *     so the sandbox cannot write the host app's macOS preferences domain or its URL handler;
 *  3. make sure the sandbox preferences domain is empty (it must not hold anything that is not ours);
 *  4. snapshot the host (scripts/host-guard.mjs);
 *  5. run wdio with HOME and CFFIXED_USER_HOME set to a fresh temp dir, so the sandbox keeps its CLI
 *     socket and its per-user Cocoa files away from the user's home; meanwhile poll the host
 *     (process, CLI socket, preferences, URL handlers) every second and stop the run at the first
 *     change;
 *     Also poll the frontmost app every ~200 ms (scripts/focus-monitor.mjs) and count how often the
 *     sandbox took the focus, and with which LaunchServices application type it ran (report only);
 *  6. compare the host with the snapshot (always, also when wdio failed); check the sandbox wrote
 *     its preferences to its own domain (evidence that the isolation works), then delete that domain.
 * Exit code is 0 only when wdio passed, the host is unchanged and the isolation evidence is there.
 * The focus report never changes the exit code.
 * Results go to .e2e-state/ (git-ignored).
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWdioConfig } from './config-guard.mjs';
import { focusSummaryLines, startFocusMonitor } from './focus-monitor.mjs';
import { collectQuickState, collectState, compareQuick, compareStates, defaultTargets, realHome } from './host-guard.mjs';
import { runDoctoredSelfTest } from './host-guard-selftest.mjs';
import { acquireSandboxLock } from './sandbox-lock.mjs';
import {
	SANDBOX_INSTALLER_DIR,
	SANDBOX_PREFS_DOMAIN,
	bundleOfBinary,
	deleteSandboxDomain,
	domainKeys,
	prepareSandboxInstallers,
	sandboxActivationMode,
	sandboxPrefsFile,
} from './sandbox-app.mjs';

const repoRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const stateDir = path.join(repoRoot, '.e2e-state');
const matrix = process.argv.includes('--matrix');
// Optional wdio config other than ./wdio.conf.mts (e.g. a spike). It has to live inside the repo,
// and because the sandbox interlocks (throwaway HOME, patched installer) run when ./wdio.conf.mts is
// evaluated, it must really import that file and build on its `config` (scripts/config-guard.mjs
// parses the config and resolves the import; a commented-out import or another wdio.conf.mts fails).
const configIndex = process.argv.indexOf('--config');
const configArg = configIndex === -1 ? './wdio.conf.mts' : process.argv[configIndex + 1];
const configCheck = checkWdioConfig(configArg, repoRoot);
if (!configCheck.ok) {
	console.error(`[e2e] refusing --config ${configArg ?? '(nothing)'}: ${configCheck.problems.join('; ')}`);
	process.exit(1);
}
const configPath = configCheck.configPath;
const isRootConfig = configCheck.isRoot;
// Optional --spec <file> (repeatable): run only these spec files of the config. Specs are test
// code, not interlocks; they still have to be *.e2e.ts files inside the repo.
const specArgs = [];
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i] !== '--spec') continue;
	const arg = process.argv[i + 1];
	const resolved = arg ? path.resolve(repoRoot, arg) : '';
	const real = arg && fs.existsSync(resolved) ? fs.realpathSync(resolved) : '';
	if (!real || !real.startsWith(repoRoot + path.sep) || !real.endsWith('.e2e.ts') || !fs.statSync(real).isFile()) {
		console.error(`[e2e] refusing --spec ${arg ?? '(nothing)'}: must be an existing *.e2e.ts file inside the repo`);
		process.exit(1);
	}
	specArgs.push('--spec', real);
}
// Separate log files per config, so a spike run does not overwrite the main e2e log.
const runTag = isRootConfig ? '' : `-${path.basename(path.dirname(configPath))}`;
const versions = (matrix ? (process.env.TABSTRIP_E2E_MATRIX ?? '1.13.4,1.14.4,1.15.0') : (process.env.TABSTRIP_E2E_VERSIONS ?? '1.15.0'))
	.split(',')
	.map((v) => v.trim())
	.filter(Boolean);
const cacheDir = process.env.OBSIDIAN_CACHE ?? path.join(realHome(), '.obsidian-cache');

fs.mkdirSync(stateDir, { recursive: true });
const logFile = path.join(stateDir, `last-run${matrix ? '-matrix' : ''}${runTag}.log`);
const summaryFile = path.join(stateDir, `last-run${matrix ? '-matrix' : ''}${runTag}.json`);
const installersFile = path.join(stateDir, 'sandbox-installers.json');
// In the shared cache (not per checkout): with the sandbox lock, whoever runs next owns leftovers.
const prefsMarkerFile = path.join(cacheDir, 'tabstrip-sandbox-prefs-domain.json');
const log = fs.createWriteStream(logFile);
const say = (line) => {
	console.log(line);
	log.write(line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const summary = {
	startedAt: new Date().toISOString(),
	node: process.version,
	config: path.relative(repoRoot, configPath),
	specs: specArgs.filter((_, i) => i % 2 === 1).map((f) => path.relative(repoRoot, f)),
	versions,
	selfTest: null,
	sandboxInstallers: null,
	sandboxPrefs: { domain: SANDBOX_PREFS_DOMAIN, before: null, keysWritten: null, cleaned: null },
	sandboxProcesses: [],
	sandboxHomeLibrary: [],
	preferencesTouched: [],
	wdioExit: null,
	monitor: { polls: 0, violations: [] },
	focus: null,
	host: null,
	leftoverSandboxProcesses: [],
};

function finish(ok, reason) {
	summary.finishedAt = new Date().toISOString();
	fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
	say(`[e2e] result: ${ok ? 'PASS' : 'FAIL'}${reason ? ` (${reason})` : ''}`);
	log.end();
	process.exitCode = ok ? 0 : 1;
}

/** Processes started from the Obsidian cache (the sandbox app, its helpers, chromedriver). */
function sandboxProcesses() {
	const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
	return out
		.split('\n')
		.map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
		.filter((m) => m && m[2].startsWith(cacheDir))
		.map((m) => ({ pid: Number(m[1]), command: m[2] }));
}

/** name -> { size, mtimeMs } of the top level of ~/Library/Preferences (for the touched-files report). */
function listPreferences() {
	const dir = path.join(realHome(), 'Library', 'Preferences');
	const out = {};
	for (const name of fs.readdirSync(dir)) {
		try {
			const st = fs.statSync(path.join(dir, name));
			if (st.isFile()) out[name] = { size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			// vanished meanwhile
		}
	}
	return out;
}

function listTree(dir, base = dir, depth = 0, out = []) {
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const rel = path.relative(base, path.join(dir, e.name));
		out.push(e.isDirectory() ? `${rel}/` : rel);
		if (e.isDirectory() && depth < 2) listTree(path.join(dir, e.name), base, depth + 1, out);
	}
	return out;
}

// 0. One sandbox at a time, across worktrees and tools: wait for the shared lock.
await acquireSandboxLock({ cacheDir, tool: 'scripts/e2e.mjs', say: (m) => say(`[e2e] ${m}`) });

// 1. The guard must work before we trust it.
say('[e2e] 1/6 host guard self-test (doctored snapshots; real files are only read)');
const doctored = runDoctoredSelfTest();
const missed = doctored.results.filter((r) => !r.ok);
summary.selfTest = { cases: doctored.results.length, missed: missed.map((r) => r.name) };
for (const r of doctored.results) say(`  ${r.ok ? 'ok  ' : 'MISS'} ${r.name}`);
if (missed.length > 0) {
	finish(false, 'host guard self-test failed; sandbox not started');
	process.exit();
}

// 2. Patched sandbox installer(s).
say(`[e2e] 2/6 sandbox installer for Obsidian ${versions.join(', ')} (copy without bundle id, ad-hoc signed, activation ${sandboxActivationMode()})`);
try {
	summary.sandboxInstallers = await prepareSandboxInstallers(versions, cacheDir, (m) => say(`  ${m}`));
} catch (e) {
	say(`[e2e] could not prepare the sandbox installer: ${String(e && e.stack ? e.stack : e)}`);
	finish(false, 'sandbox installer not prepared');
	process.exit();
}
fs.writeFileSync(installersFile, JSON.stringify(summary.sandboxInstallers, null, 2));

// 3. The sandbox preferences domain must hold nothing that is not ours.
const keysBefore = domainKeys(SANDBOX_PREFS_DOMAIN);
summary.sandboxPrefs.before = keysBefore;
if (keysBefore.length > 0) {
	if (fs.existsSync(prefsMarkerFile)) {
		say(`[e2e] 3/6 preferences domain "${SANDBOX_PREFS_DOMAIN}" holds ${keysBefore.length} key(s) left by an earlier sandbox run; deleting them`);
		deleteSandboxDomain();
	} else {
		say(`[e2e] preferences domain "${SANDBOX_PREFS_DOMAIN}" is not empty (${keysBefore.join(', ')}) and was not created by this tool; refusing to run. Inspect it with: defaults read ${SANDBOX_PREFS_DOMAIN}`);
		finish(false, 'sandbox preferences domain not empty');
		process.exit();
	}
} else {
	say(`[e2e] 3/6 preferences domain "${SANDBOX_PREFS_DOMAIN}" is empty${fs.existsSync(sandboxPrefsFile()) ? ` (an empty ${sandboxPrefsFile()} exists)` : ''}`);
}
fs.writeFileSync(prefsMarkerFile, JSON.stringify({ domain: SANDBOX_PREFS_DOMAIN, owner: 'scripts/e2e.mjs', startedAt: summary.startedAt }, null, 2));

// 4. Snapshot.
const targets = defaultTargets();
const before = collectState(targets);
if (before.vaults.length === 0) {
	finish(false, 'no host vault found to check');
	process.exit();
}
const prefsListBefore = listPreferences();
const snapshotFile = path.join(stateDir, 'host-snapshot.json');
fs.writeFileSync(snapshotFile, JSON.stringify(before, null, 2));
say(
	`[e2e] 4/6 host snapshot: Obsidian main process ${before.host.mainProcesses.map((p) => `pid ${p.pid} (${p.start})`).join(', ') || 'not running'}; ${before.vaults.length} vault(s); CLI socket ${before.cliSocket.exists ? 'inode ' + before.cliSocket.ino : 'absent'}; ${before.prefs.domain} ${Object.keys(before.prefs.keys).length} keys; obsidian:// handler entries ${before.urlHandlers.entries ? before.urlHandlers.entries.length : 'n/a'}`,
);

// 5. wdio with a throwaway HOME (also as CFFIXED_USER_HOME for Cocoa per-user paths).
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-home-'));
const env = {
	...process.env,
	HOME: sandboxHome,
	CFFIXED_USER_HOME: sandboxHome,
	TABSTRIP_SANDBOX_HOME: sandboxHome,
	TABSTRIP_SANDBOX_INSTALLERS: installersFile,
	TABSTRIP_E2E_VERSIONS: versions.join(','),
	OBSIDIAN_CACHE: cacheDir,
};
if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) env.NODE_USE_ENV_PROXY = '1';
say(
	`[e2e] 5/6 wdio (${path.relative(repoRoot, configPath)}${specArgs.length ? `, specs ${specArgs.filter((_, i) => i % 2 === 1).map((f) => path.relative(repoRoot, f)).join(', ')}` : ''}) on Obsidian ${versions.join(', ')} with sandbox HOME ${sandboxHome}`,
);

// Which app is frontmost while the sandbox runs (report only, see scripts/focus-monitor.mjs).
const focusMonitor = startFocusMonitor({
	sandboxRoot: path.join(cacheDir, SANDBOX_INSTALLER_DIR),
	sandboxBundles: Object.values(summary.sandboxInstallers).map((i) => bundleOfBinary(i.binaryPath)),
	rootPid: process.pid,
});

const wdioBin = path.join(repoRoot, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js');
const child = spawn(process.execPath, [wdioBin, 'run', configPath, ...specArgs], { cwd: repoRoot, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => {
	process.stdout.write(d);
	log.write(d);
});
child.stderr.on('data', (d) => {
	process.stderr.write(d);
	log.write(d);
});

const seenCommands = new Set();
const quickBefore = { host: before.host, cliSocket: before.cliSocket, prefs: before.prefs, urlHandlers: before.urlHandlers };
const monitor = setInterval(() => {
	summary.monitor.polls++;
	for (const p of sandboxProcesses()) {
		// Main sandbox processes and chromedriver; Chromium helpers carry --type=.
		if (p.command.includes('--type=')) continue;
		const cmd = p.command.slice(0, 1200);
		if (!seenCommands.has(cmd)) {
			seenCommands.add(cmd);
			summary.sandboxProcesses.push({ pid: p.pid, command: cmd });
		}
	}
	const result = compareQuick(quickBefore, collectQuickState(targets));
	if (!result.ok) {
		summary.monitor.violations.push(...result.violations);
		say(`[e2e] HOST CHANGED DURING RUN, stopping: ${result.violations.join(' | ')}`);
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			// already gone
		}
		clearInterval(monitor);
	}
}, 1000);

summary.wdioExit = await new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
clearInterval(monitor);

// Sandbox processes should be gone; give them a moment, then stop leftovers (they are ours).
await sleep(3000);
summary.leftoverSandboxProcesses = sandboxProcesses().map((p) => ({ pid: p.pid, command: p.command.slice(0, 200) }));
for (const p of summary.leftoverSandboxProcesses) {
	say(`[e2e] leftover sandbox process ${p.pid}: ${p.command}`);
	try {
		process.kill(p.pid, 'SIGTERM');
	} catch {
		// already gone
	}
}
summary.focus = await focusMonitor.stop();
summary.sandboxHomeLibrary = listTree(path.join(sandboxHome, 'Library'));
fs.rmSync(sandboxHome, { recursive: true, force: true });

for (const p of summary.sandboxProcesses.filter((x) => !x.command.includes('chromedriver'))) {
	say(`[e2e] sandbox main process ${p.pid}: ${p.command.slice(0, 400)}`);
}
say(`[e2e] files the sandbox created under its own HOME/Library: ${summary.sandboxHomeLibrary.length ? summary.sandboxHomeLibrary.join(', ') : 'none'}`);

// 6. Compare the host, then the sandbox's own preferences domain.
const after = collectState(before.targets, before.vaults.map((v) => v.path));
summary.host = compareStates(before, after);
say(`[e2e] 6/6 host check: ${summary.host.ok ? 'PASS' : 'FAIL'}`);
for (const n of summary.host.notes) say(`  ok    ${n}`);
for (const v of summary.host.violations) say(`  FAIL  ${v}`);
say(`[e2e] monitor: ${summary.monitor.polls} polls, ${summary.monitor.violations.length} violation(s)`);
for (const line of focusSummaryLines(summary.focus)) say(line);

// cfprefsd may write the sandbox's file a moment after the app quits.
let keysWritten = domainKeys(SANDBOX_PREFS_DOMAIN);
for (let i = 0; i < 10 && keysWritten.length === 0; i++) {
	await sleep(1000);
	keysWritten = domainKeys(SANDBOX_PREFS_DOMAIN);
}
summary.sandboxPrefs.keysWritten = keysWritten;
const isolationEvidence = summary.wdioExit === 0 ? keysWritten.length > 0 : true;
say(
	`[e2e] sandbox preferences went to its own domain "${SANDBOX_PREFS_DOMAIN}": ${keysWritten.length ? keysWritten.join(', ') : 'nothing written'}${isolationEvidence ? '' : '  <- expected the keys the sandbox writes at startup'}`,
);

// Report every file in ~/Library/Preferences that changed during the run (other apps write there too).
const prefsListAfter = listPreferences();
for (const [name, st] of Object.entries(prefsListAfter)) {
	const b = prefsListBefore[name];
	if (!b) summary.preferencesTouched.push(`${name} (new)`);
	else if (b.mtimeMs !== st.mtimeMs || b.size !== st.size) summary.preferencesTouched.push(`${name} (modified)`);
}
for (const name of Object.keys(prefsListBefore)) if (!(name in prefsListAfter)) summary.preferencesTouched.push(`${name} (removed)`);
say(`[e2e] ~/Library/Preferences files changed during the run (any app): ${summary.preferencesTouched.length ? summary.preferencesTouched.join(', ') : 'none'}`);

const cleanup = deleteSandboxDomain();
summary.sandboxPrefs.cleaned = cleanup.keysLeft.length === 0 && !cleanup.fileLeft;
if (summary.sandboxPrefs.cleaned) fs.rmSync(prefsMarkerFile, { force: true });
say(
	`[e2e] sandbox preferences domain "${SANDBOX_PREFS_DOMAIN}" deleted: ${summary.sandboxPrefs.cleaned ? `yes (${sandboxPrefsFile()} removed)` : `no, keys left [${cleanup.keysLeft.join(', ')}], file left ${cleanup.fileLeft}`}`,
);

const ok = summary.wdioExit === 0 && summary.host.ok && summary.monitor.violations.length === 0 && isolationEvidence;
finish(ok, `wdio exit ${summary.wdioExit}, host ${summary.host.ok && summary.monitor.violations.length === 0 ? 'unchanged' : 'CHANGED'}, sandbox preferences isolated ${isolationEvidence ? 'yes' : 'NOT PROVEN'}`);
