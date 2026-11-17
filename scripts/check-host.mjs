#!/usr/bin/env node
/**
 * Host-safety guard CLI (read-only towards the host).
 *
 *   node scripts/check-host.mjs snapshot [--out FILE]
 *   node scripts/check-host.mjs compare  [--snapshot FILE] [--report FILE]
 *   node scripts/check-host.mjs self-test
 *
 * `compare` exits 1 when the host changed. `self-test` exits 1 when the guard misses a change.
 * See scripts/host-guard.mjs for what is checked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectState, compareStates, defaultTargets } from './host-guard.mjs';
import { runDoctoredSelfTest, runSyntheticSelfTest } from './host-guard-selftest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SNAPSHOT = path.join(repoRoot, '.e2e-state', 'host-snapshot.json');

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
}

function printResult(result) {
	for (const n of result.notes) console.log(`  ok    ${n}`);
	for (const v of result.violations) console.log(`  FAIL  ${v}`);
}

function snapshot() {
	const out = arg('--out', DEFAULT_SNAPSHOT);
	const state = collectState(defaultTargets());
	if (state.vaults.length === 0) {
		console.error('[host-guard] no host vault found to check; refusing to continue');
		process.exit(1);
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, JSON.stringify(state, null, 2));
	const procs = state.host.mainProcesses.map((p) => `pid ${p.pid} (${p.start})`).join(', ') || 'not running';
	console.log(`[host-guard] snapshot written: ${path.relative(repoRoot, out)}`);
	console.log(`  host Obsidian main process: ${procs}`);
	console.log(`  obsidian.json: ${state.obsidianJson.exists ? state.obsidianJson.sha256.slice(0, 12) + '...' : 'absent'}`);
	console.log(`  CLI socket: ${state.cliSocket.exists ? 'inode ' + state.cliSocket.ino : 'absent'}`);
	for (const v of state.vaults) console.log(`  vault: ${v.path} (plugins/tabstrip ${v.tabstripPlugin ? 'present' : 'absent'})`);
	console.log(`  preferences ${state.prefs.domain}: ${Object.keys(state.prefs.keys).length} keys, files ${Object.keys(state.prefs.files).join(', ') || 'none'}`);
	console.log(`  LaunchServices obsidian:// / md.obsidian entries: ${state.urlHandlers.entries ? state.urlHandlers.entries.length : 'whole domain hashed'}`);
}

function compare() {
	const file = arg('--snapshot', DEFAULT_SNAPSHOT);
	const before = JSON.parse(fs.readFileSync(file, 'utf8'));
	const after = collectState(before.targets, before.vaults.map((v) => v.path));
	const result = compareStates(before, after);
	console.log(`[host-guard] compare against ${path.relative(repoRoot, file)}: ${result.ok ? 'PASS' : 'FAIL'}`);
	printResult(result);
	const report = arg('--report', null);
	if (report) {
		fs.mkdirSync(path.dirname(report), { recursive: true });
		fs.writeFileSync(report, JSON.stringify({ ...result, before: before.takenAt, after: after.takenAt }, null, 2));
	}
	process.exit(result.ok ? 0 : 1);
}

async function selfTest() {
	let failed = 0;
	const show = (r) => {
		if (!r.ok) failed++;
		const expect = r.expectViolation ? 'expect FAIL' : 'expect PASS';
		console.log(`  ${r.ok ? 'ok  ' : 'MISS'}  [${expect}] ${r.name}${r.ok ? '' : `  -> ${r.detail}`}`);
	};
	console.log('[host-guard] self-test 1/2: synthetic host in a temp dir');
	(await runSyntheticSelfTest()).forEach(show);
	console.log('[host-guard] self-test 2/2: doctored snapshots of the real host (real files are only read)');
	const doctored = runDoctoredSelfTest();
	console.log(`  (real host: ${doctored.vaultCount} vault(s) checked)`);
	doctored.results.forEach(show);
	console.log(`[host-guard] self-test ${failed === 0 ? 'PASS' : `FAIL (${failed} case(s) missed)`}`);
	process.exit(failed === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === 'snapshot') snapshot();
else if (mode === 'compare') compare();
else if (mode === 'self-test') await selfTest();
else {
	console.error('usage: check-host.mjs snapshot|compare|self-test');
	process.exit(2);
}
