/**
 * Negative self-tests for the host-safety guard. They never modify real host files:
 *  - synthetic: builds a fake host (fake obsidian.json, fake vaults, fake CLI socket file, a fake
 *    "host" process, and preferences domains addressed by absolute path inside the temp dir) in a
 *    temp dir, mutates it, and checks the guard reports each change;
 *  - doctored: reads the real host state (read-only), writes doctored copies of the snapshot into a
 *    temp dir, and checks that comparing the real state against each copy reports a violation.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectState, compareStates, defaultTargets, mainVaultPath } from './host-guard.mjs';

function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function plistXml(value, indent = '') {
	if (typeof value === 'boolean') return `${indent}<${value}/>`;
	if (typeof value === 'number') return `${indent}<integer>${value}</integer>`;
	if (typeof value === 'string') return `${indent}<string>${value}</string>`;
	if (Array.isArray(value)) return [`${indent}<array>`, ...value.map((v) => plistXml(v, indent + '\t')), `${indent}</array>`].join('\n');
	const lines = [`${indent}<dict>`];
	for (const [k, v] of Object.entries(value)) lines.push(`${indent}\t<key>${k}</key>`, plistXml(v, indent + '\t'));
	lines.push(`${indent}</dict>`);
	return lines.join('\n');
}

/** Replaces a preferences domain given by absolute path (inside the temp dir only) through cfprefsd. */
function assertInTemp(domainPath) {
	if (!domainPath.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) {
		throw new Error(`self-test refuses to write preferences outside the temp dir: ${domainPath}`);
	}
}

function setDomain(domainPath, data, scratch) {
	assertInTemp(domainPath);
	try {
		execFileSync('/usr/bin/defaults', ['delete', domainPath], { stdio: 'ignore' });
	} catch {
		// did not exist
	}
	if (data === null) return;
	const file = path.join(scratch, 'import.plist');
	fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${plistXml(data)}\n</plist>\n`);
	execFileSync('/usr/bin/defaults', ['import', domainPath, file], { stdio: 'ignore' });
}

function writeDefault(domainPath, ...args) {
	assertInTemp(domainPath);
	execFileSync('/usr/bin/defaults', ['write', domainPath, ...args], { stdio: 'ignore' });
}

async function startFakeHost(dir) {
	// A node process running a uniquely named script stands in for the host binary.
	// (Copies of system binaries such as /bin/sleep are killed by macOS code signing.)
	const script = path.join(dir, 'FakeObsidian.cjs');
	fs.writeFileSync(script, 'setTimeout(() => {}, 600000);\n');
	const binary = `${process.execPath} ${script}`;
	const child = spawn(process.execPath, [script], { stdio: 'ignore' });
	await sleep(300);
	return { binary, script, child };
}

async function stopProcess(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const done = new Promise((r) => child.once('exit', r));
	child.kill('SIGTERM');
	await done;
}

/** Runs the synthetic suite. Returns [{ name, expectViolation, ok, detail }]. */
export async function runSyntheticSelfTest() {
	// Real path: cfprefsd silently ignores domains addressed through the /var -> /private/var symlink.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-guard-selftest-')));
	const scratch = path.join(root, 'scratch');
	const home = path.join(root, 'home');
	const vault = path.join(root, 'vault');
	const vault2 = path.join(root, 'vault-2');
	const pinned = path.join(root, 'pinned-main-vault');
	const obsidianJson = path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
	const cliSocket = path.join(home, '.obsidian-cli.sock');
	const configDir = path.join(vault, '.obsidian');
	const pinnedConfigDir = path.join(pinned, '.obsidian');
	const prefsDir = path.join(home, 'Library', 'Preferences');
	const prefsDomain = path.join(prefsDir, 'md.obsidian');
	const launchServicesDomain = path.join(prefsDir, 'com.apple.LaunchServices', 'com.apple.launchservices.secure');
	const results = [];
	fs.mkdirSync(scratch, { recursive: true });
	let host = await startFakeHost(root);

	const writeConfig = (dir) => {
		fs.rmSync(dir, { recursive: true, force: true });
		writeJson(path.join(dir, 'community-plugins.json'), ['dataview']);
		writeJson(path.join(dir, 'appearance.json'), { cssTheme: 'Atom' });
		writeJson(path.join(dir, 'app.json'), {});
		writeJson(path.join(dir, 'core-plugins.json'), { 'file-explorer': true });
		writeJson(path.join(dir, 'workspace.json'), { main: {} });
	};
	const resetFiles = () => {
		writeJson(obsidianJson, { vaults: { aaaa: { path: vault, ts: 1, open: true } }, cli: true });
		fs.rmSync(cliSocket, { force: true });
		fs.writeFileSync(cliSocket, '');
		writeConfig(configDir);
		writeConfig(pinnedConfigDir);
		fs.mkdirSync(vault2, { recursive: true });
		fs.rmSync(path.join(prefsDir, 'ByHost'), { recursive: true, force: true });
		setDomain(path.join(prefsDir, 'md.obsidian.helper'), null, scratch);
		setDomain(path.join(prefsDir, 'Obsidian'), null, scratch);
		setDomain(prefsDomain, { AppleTextDirection: true, NSTreatUnknownArgumentsAsOpen: 'NO' }, scratch);
		setDomain(launchServicesDomain, { LSHandlers: [{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }] }, scratch);
	};

	/** @type {Array<[string, boolean, () => void | Promise<void>]>} */
	const cases = [
		['no change', false, () => {}],
		['workspace.json and workspace-mobile.json changed (ignored on purpose)', false, () => {
			writeJson(path.join(configDir, 'workspace.json'), { main: { changed: true } });
			writeJson(path.join(configDir, 'workspace-mobile.json'), { main: {} });
		}],
		['obsidian.json rewritten with the same vaults', false, () => {
			writeJson(obsidianJson, { vaults: { aaaa: { path: vault, ts: 2, open: false } }, cli: true, frame: 'hidden' });
		}],
		['appearance.json changed', true, () => writeJson(path.join(configDir, 'appearance.json'), { cssTheme: '' })],
		['community-plugins.json changed', true, () => writeJson(path.join(configDir, 'community-plugins.json'), ['dataview', 'tabstrip'])],
		['app.json removed', true, () => fs.rmSync(path.join(configDir, 'app.json'))],
		['core-plugins.json changed', true, () => writeJson(path.join(configDir, 'core-plugins.json'), {})],
		['plugins/tabstrip created', true, () => writeJson(path.join(configDir, 'plugins', 'tabstrip', 'manifest.json'), { id: 'tabstrip' })],
		['obsidian.json vault added', true, () => {
			writeJson(obsidianJson, { vaults: { aaaa: { path: vault, ts: 1, open: true }, bbbb: { path: vault2, ts: 1 } } });
		}],
		['obsidian.json deleted', true, () => fs.rmSync(obsidianJson)],
		['CLI socket replaced by a new file', true, () => {
			fs.rmSync(cliSocket);
			fs.writeFileSync(cliSocket, '');
		}],
		['CLI socket removed', true, () => fs.rmSync(cliSocket)],
		['main vault not listed in obsidian.json: its appearance.json changed', true, () => {
			writeJson(path.join(pinnedConfigDir, 'appearance.json'), { cssTheme: '' });
		}],
		['main vault not listed in obsidian.json: plugins/tabstrip created', true, () => {
			writeJson(path.join(pinnedConfigDir, 'plugins', 'tabstrip', 'manifest.json'), { id: 'tabstrip' });
		}],
		['md.obsidian preference added through cfprefsd (NSFullScreenMenuItemEverywhere)', true, () => {
			writeDefault(prefsDomain, 'NSFullScreenMenuItemEverywhere', '-bool', 'false');
		}],
		['md.obsidian preference value changed', true, () => writeDefault(prefsDomain, 'AppleTextDirection', '-bool', 'false')],
		['md.obsidian.plist rewritten with the same bytes (mtime only)', true, () => {
			const file = `${prefsDomain}.plist`;
			const t = fs.statSync(file).mtime;
			fs.utimesSync(file, t, new Date(t.getTime() + 5000));
		}],
		['md.obsidian.helper.plist appeared', true, () => writeDefault(path.join(prefsDir, 'md.obsidian.helper'), 'X', '-bool', 'true')],
		['ByHost/md.obsidian.<host>.plist appeared', true, () => writeDefault(path.join(prefsDir, 'ByHost', 'md.obsidian.0000-TEST'), 'X', '-bool', 'true')],
		['sandbox domain Obsidian.plist written (not the host domain)', false, () => {
			writeDefault(path.join(prefsDir, 'Obsidian'), 'NSFullScreenMenuItemEverywhere', '-bool', 'false');
		}],
		['obsidian:// handler entry added', true, () => {
			setDomain(launchServicesDomain, {
				LSHandlers: [
					{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' },
					{ LSHandlerURLScheme: 'obsidian', LSHandlerRoleAll: 'md.obsidian.sandbox' },
				],
			}, scratch);
		}],
		['file type handler pointed at md.obsidian', true, () => {
			setDomain(launchServicesDomain, {
				LSHandlers: [
					{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' },
					{ LSHandlerContentType: 'net.daringfireball.markdown', LSHandlerRoleAll: 'md.obsidian' },
				],
			}, scratch);
		}],
		['unrelated handler (mailto) changed (ignored on purpose)', false, () => {
			setDomain(launchServicesDomain, { LSHandlers: [{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.example.mail' }] }, scratch);
		}],
		['host process exited', true, async () => stopProcess(host.child)],
		['host process restarted', true, async () => {
			await stopProcess(host.child);
			host.child = spawn(process.execPath, [host.script], { stdio: 'ignore' });
			await sleep(300);
		}],
	];

	try {
		for (const [name, expectViolation, mutate] of cases) {
			resetFiles();
			if (host.child.exitCode !== null || host.child.signalCode !== null) host = await startFakeHost(root);
			const targets = {
				hostBinary: host.binary,
				obsidianJson,
				cliSocket,
				pinnedVaults: [pinned],
				extraVaults: [],
				prefsDomain,
				prefsDir,
				launchServicesDomain,
				urlScheme: 'obsidian',
			};
			const before = collectState(targets);
			await mutate();
			const result = compareStates(before, collectState(targets, before.vaults.map((v) => v.path)));
			const ok = expectViolation ? !result.ok : result.ok;
			results.push({ name, expectViolation, ok, detail: (expectViolation ? result.violations : result.notes).join(' | ') });
		}
	} finally {
		await stopProcess(host.child);
		for (const d of [prefsDomain, launchServicesDomain, path.join(prefsDir, 'md.obsidian.helper'), path.join(prefsDir, 'Obsidian'), path.join(prefsDir, 'ByHost', 'md.obsidian.0000-TEST')]) {
			setDomain(d, null, scratch);
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
	return results;
}

/**
 * Doctored-snapshot suite against the real host (read-only). Each doctored snapshot is written to a
 * temp dir and loaded back, like `check-host.mjs compare --snapshot <file>` does.
 */
export function runDoctoredSelfTest(targets = defaultTargets()) {
	const real = collectState(targets);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-guard-doctored-'));
	const results = [];
	const firstVault = real.vaults[0];
	const mainVault = mainVaultPath();
	const pickMain = (s) => s.vaults.find((v) => v.path === mainVault) ?? s.vaults[0];
	/** @type {Array<[string, boolean, (snapshot: any) => void]>} */
	const doctors = [
		['real snapshot, unchanged', false, () => {}],
		['host pid differs', true, (s) => {
			s.host.mainProcesses = s.host.mainProcesses.length
				? s.host.mainProcesses.map((p) => ({ ...p, pid: p.pid + 1 }))
				: [{ pid: 1, start: 'Thu Jan  1 00:00:00 1970' }];
		}],
		['host start time differs', true, (s) => {
			s.host.mainProcesses = s.host.mainProcesses.length
				? s.host.mainProcesses.map((p) => ({ ...p, start: 'Thu Jan 1 00:00:00 1970' }))
				: [{ pid: 1, start: 'Thu Jan 1 00:00:00 1970' }];
		}],
		['obsidian.json sha256 and vaults differ', true, (s) => {
			s.obsidianJson.sha256 = '0'.repeat(64);
			s.obsidianJson.vaults = { ...(s.obsidianJson.vaults ?? {}), doctored: '/tmp/doctored-vault' };
		}],
		['appearance.json hash differs', true, (s) => {
			const v = pickMain(s);
			if (v) v.files['appearance.json'] = 'f'.repeat(64);
		}],
		['community-plugins.json hash differs', true, (s) => {
			if (s.vaults[0]) s.vaults[0].files['community-plugins.json'] = 'e'.repeat(64);
		}],
		['plugins/tabstrip state differs', true, (s) => {
			if (s.vaults[0]) s.vaults[0].tabstripPlugin = s.vaults[0].tabstripPlugin ? null : { 'manifest.json': 'd'.repeat(64) };
		}],
		['CLI socket inode differs', true, (s) => {
			s.cliSocket = s.cliSocket.exists ? { ...s.cliSocket, ino: s.cliSocket.ino + 1 } : { ...s.cliSocket, exists: true, ino: 1, dev: 1, birthtimeMs: 0 };
		}],
		['main vault app.json hash differs', true, (s) => {
			const v = pickMain(s);
			if (v) v.files['app.json'] = 'c'.repeat(64);
		}],
		['md.obsidian preferences were empty before (keys added since)', true, (s) => {
			s.prefs.exportSha256 = '0'.repeat(64);
			s.prefs.keys = {};
		}],
		['md.obsidian.plist mtime differs', true, (s) => {
			const names = Object.keys(s.prefs.files);
			if (names.length) for (const n of names) s.prefs.files[n] = { ...s.prefs.files[n], mtimeMs: s.prefs.files[n].mtimeMs - 1000 };
			else s.prefs.files['md.obsidian.plist'] = { sha256: 'b'.repeat(64), size: 1, mtimeMs: 0 };
		}],
		['md.obsidian.helper.plist present before', true, (s) => {
			s.prefs.files['md.obsidian.helper.plist'] = { sha256: 'a'.repeat(64), size: 1, mtimeMs: 0 };
		}],
		['obsidian:// handler entries differ', true, (s) => {
			s.urlHandlers = { ...s.urlHandlers, sha256: '9'.repeat(64), entries: ['{"LSHandlerRoleAll":"doctored","LSHandlerURLScheme":"obsidian"}'] };
		}],
	];
	try {
		for (const [name, expectViolation, doctor] of doctors) {
			const copy = structuredClone(real);
			doctor(copy);
			const file = path.join(dir, `${name.replace(/[^a-z0-9]+/gi, '-')}.json`);
			fs.writeFileSync(file, JSON.stringify(copy));
			const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
			const later = collectState(targets, snapshot.vaults.map((v) => v.path));
			const result = compareStates(snapshot, later);
			const ok = expectViolation ? !result.ok : result.ok;
			results.push({ name, expectViolation, ok, detail: (expectViolation ? result.violations : result.violations.concat(result.notes)).join(' | ') });
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	const pinnedOk = real.vaults.some((v) => v.path === mainVault && v.exists);
	results.push({
		name: `main vault is always in the checked set (${mainVault})`,
		expectViolation: false,
		ok: pinnedOk,
		detail: pinnedOk ? 'present' : `checked: ${real.vaults.map((v) => v.path).join(', ')}`,
	});
	return { results, vaultCount: real.vaults.length, firstVault: firstVault?.path ?? null };
}
