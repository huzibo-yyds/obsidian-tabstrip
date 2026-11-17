/**
 * Host-safety guard: proves that an e2e run did not touch the Obsidian the user has open.
 *
 * It records a snapshot of the host before the run and compares after the run:
 *  (a) the host Obsidian main process (pid + start time) is the same;
 *  (b) obsidian.json is unchanged, or, if the running host rewrote it, its `vaults` set is unchanged;
 *  (c) in every host vault, .obsidian/{community-plugins,appearance,app,core-plugins}.json are
 *      unchanged and no plugins/tabstrip folder appeared;
 *  (d) the host's CLI socket (~/.obsidian-cli.sock) is the same file. Obsidian (1.12+) deletes and
 *      re-creates this socket at startup, so a second instance with the same HOME takes it over;
 *  (e) the host app's macOS preferences domain (`md.obsidian`, through cfprefsd) has the same content,
 *      and every ~/Library/Preferences{,/ByHost}/md.obsidian*.plist file has the same bytes and mtime.
 *      Any app with the bundle id `md.obsidian` writes there, whatever its HOME;
 *  (f) the LaunchServices handler entries for obsidian:// (and any entry pointing at md.obsidian*)
 *      are unchanged. Obsidian registers itself as the obsidian:// handler at startup.
 * The main vault is always checked under (c), also when obsidian.json does not list it.
 * workspace*.json is deliberately not checked: the host app and file sync change it all the time.
 *
 * Everything here only reads host files. Paths are resolved from the user database home
 * (os.userInfo), not from $HOME, because the e2e run gives the sandbox its own HOME.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 2;
export const CONFIG_FILES = ['community-plugins.json', 'appearance.json', 'app.json', 'core-plugins.json'];
export const PLUGIN_ID = 'tabstrip';

/** Home directory of the current user, independent of $HOME. */
export function realHome() {
	return os.userInfo().homedir;
}

/** Git-ignored per-machine settings at the repo root (see README, "Local settings"). */
export const LOCAL_SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.tabstrip-local.json');

/**
 * The developer's main vault: always checked, even if obsidian.json stops listing it, and the source
 * of the themes and window settings some e2e cases copy (read only). Set it with TABSTRIP_MAIN_VAULT
 * or "mainVault" in the git-ignored .tabstrip-local.json; null when neither is set (then only the
 * vaults obsidian.json lists are checked).
 */
export function mainVaultPath() {
	const fromEnv = process.env.TABSTRIP_MAIN_VAULT?.trim();
	if (fromEnv) return path.resolve(fromEnv);
	try {
		const local = JSON.parse(fs.readFileSync(LOCAL_SETTINGS_FILE, 'utf8'));
		return typeof local.mainVault === 'string' && local.mainVault.trim() ? path.resolve(local.mainVault.trim()) : null;
	} catch {
		return null;
	}
}

/** Default host targets. Extra vaults can be added with TABSTRIP_HOST_VAULTS (path-delimited). */
export function defaultTargets() {
	const home = realHome();
	const extra = (process.env.TABSTRIP_HOST_VAULTS ?? '').split(path.delimiter).filter(Boolean);
	const prefsDir = path.join(home, 'Library', 'Preferences');
	return {
		hostBinary: '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
		obsidianJson: path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
		cliSocket: path.join(home, '.obsidian-cli.sock'),
		pinnedVaults: [mainVaultPath()].filter((v) => v !== null),
		extraVaults: extra,
		// (e) Domain name as `defaults` takes it; an absolute path (without .plist) also works.
		prefsDomain: 'md.obsidian',
		prefsDir,
		// (f)
		launchServicesDomain: 'com.apple.LaunchServices/com.apple.launchservices.secure',
		urlScheme: 'obsidian',
	};
}

function sha256File(file) {
	try {
		return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
	} catch (e) {
		if (e && e.code === 'ENOENT') return null;
		throw e;
	}
}

/** Main processes of the host binary: exact path, no Chromium `--type=` helper flag. */
export function listMainProcesses(hostBinary) {
	// LC_ALL=C: lstart is locale-formatted (a zh_CN shell prints Chinese weekdays), and the pattern
	// below expects the C format. Without this every host process looked like it had exited.
	const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,lstart=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
	const result = [];
	for (const line of out.split('\n')) {
		const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
		if (!m) continue;
		const command = m[3];
		const isHost = command === hostBinary || command.startsWith(hostBinary + ' ');
		if (isHost && !command.includes('--type=')) {
			result.push({ pid: Number(m[1]), start: m[2].replace(/\s+/g, ' ') });
		}
	}
	return result.sort((a, b) => a.pid - b.pid);
}

function readObsidianJson(file) {
	const sha256 = sha256File(file);
	if (sha256 === null) return { path: file, exists: false, sha256: null, vaults: null };
	let vaults = null;
	let parseError = null;
	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		vaults = {};
		for (const [id, v] of Object.entries(data.vaults ?? {})) vaults[id] = v && typeof v.path === 'string' ? v.path : null;
	} catch (e) {
		parseError = String(e);
	}
	return { path: file, exists: true, sha256, vaults, parseError };
}

function readSocket(file) {
	try {
		const st = fs.lstatSync(file);
		return { path: file, exists: true, ino: st.ino, dev: st.dev, birthtimeMs: st.birthtimeMs };
	} catch (e) {
		if (e && e.code === 'ENOENT') return { path: file, exists: false };
		throw e;
	}
}

function listFilesRecursive(dir, base = dir) {
	const out = {};
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) Object.assign(out, listFilesRecursive(full, base));
		else out[path.relative(base, full)] = sha256File(full);
	}
	return out;
}

function readVault(vaultPath) {
	const configDir = path.join(vaultPath, '.obsidian');
	const files = {};
	for (const name of CONFIG_FILES) files[name] = sha256File(path.join(configDir, name));
	const pluginDir = path.join(configDir, 'plugins', PLUGIN_ID);
	const tabstripPlugin = fs.existsSync(pluginDir) ? listFilesRecursive(pluginDir) : null;
	return { path: vaultPath, exists: fs.existsSync(configDir), files, tabstripPlugin };
}

/** Vaults to check: the pinned ones, every vault registered in the host obsidian.json, extra ones. */
export function vaultsToCheck(obsidianJsonState, extraVaults, pinnedVaults = []) {
	const registered = Object.values(obsidianJsonState.vaults ?? {}).filter((p) => typeof p === 'string');
	const all = [...pinnedVaults, ...registered, ...extraVaults].map((p) => path.resolve(p).normalize('NFC'));
	return [...new Set(all)].sort();
}

/** `defaults` with the real user's preferences (no redirection variables). */
function runDefaults(args) {
	const env = { ...process.env };
	delete env.CFFIXED_USER_HOME;
	return execFileSync('/usr/bin/defaults', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

const sha256Text = (text) => createHash('sha256').update(text).digest('hex');

/** Splits a `defaults export` XML plist into its top-level entries: { key: sha256(value xml) }. */
export function topLevelEntries(xml) {
	const entries = {};
	let key = null;
	let value = [];
	const flush = () => {
		if (key !== null) entries[key] = sha256Text(value.join('\n'));
	};
	for (const line of xml.split('\n')) {
		const m = /^\t<key>(.*)<\/key>$/.exec(line);
		if (m) {
			flush();
			key = m[1];
			value = [];
		} else if (line === '</dict>' || line === '<dict/>') {
			flush();
			key = null;
		} else if (key !== null) {
			value.push(line);
		}
	}
	return entries;
}

function statFile(file) {
	const st = fs.statSync(file);
	return { sha256: sha256File(file), size: st.size, mtimeMs: st.mtimeMs };
}

/** (e) Preferences domain content (via cfprefsd) and the domain's plist files on disk. */
export function readPrefs(targets) {
	const domain = targets.prefsDomain;
	const xml = runDefaults(['export', domain, '-']);
	const prefix = path.basename(domain);
	const files = {};
	for (const dir of [targets.prefsDir, path.join(targets.prefsDir, 'ByHost')]) {
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			if (e && e.code === 'ENOENT') continue;
			throw e;
		}
		for (const name of names) {
			if (name === `${prefix}.plist` || (name.startsWith(`${prefix}.`) && name.endsWith('.plist'))) {
				const full = path.join(dir, name);
				if (fs.statSync(full).isFile()) files[path.relative(targets.prefsDir, full)] = statFile(full);
			}
		}
	}
	return { domain, exportSha256: sha256Text(xml), keys: topLevelEntries(xml), files };
}

/** (f) LaunchServices handler entries for the obsidian:// scheme or pointing at md.obsidian*. */
export function readUrlHandlers(targets) {
	const xml = runDefaults(['export', targets.launchServicesDomain, '-']);
	let handlers;
	try {
		const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
		handlers = JSON.parse(json).LSHandlers ?? [];
	} catch {
		// Not convertible to JSON (dates or data in it): fall back to the whole domain.
		return { domain: targets.launchServicesDomain, mode: 'whole-domain', sha256: sha256Text(xml), entries: null };
	}
	const scheme = targets.urlScheme.toLowerCase();
	const relevant = handlers.filter((h) => {
		if (!h || typeof h !== 'object') return false;
		if (String(h.LSHandlerURLScheme ?? '').toLowerCase() === scheme) return true;
		return Object.entries(h).some(([k, v]) => k.startsWith('LSHandlerRole') && String(v).toLowerCase().startsWith('md.obsidian'));
	});
	const entries = relevant.map((h) => JSON.stringify(sortObj(h))).sort();
	return { domain: targets.launchServicesDomain, mode: 'entries', sha256: sha256Text(entries.join('\n')), entries };
}

/** Full host state. Pass `vaultPaths` to re-read exactly the vaults of an earlier snapshot. */
export function collectState(targets, vaultPaths) {
	const obsidianJson = readObsidianJson(targets.obsidianJson);
	const vaults = (vaultPaths ?? vaultsToCheck(obsidianJson, targets.extraVaults ?? [], targets.pinnedVaults ?? [])).map(readVault);
	return {
		schema: SCHEMA,
		takenAt: new Date().toISOString(),
		targets,
		...collectQuickState(targets),
		obsidianJson,
		vaults,
	};
}

/** Cheap subset for polling during a run: processes, CLI socket, preferences, URL handlers. */
export function collectQuickState(targets) {
	return {
		host: { binary: targets.hostBinary, mainProcesses: listMainProcesses(targets.hostBinary) },
		cliSocket: readSocket(targets.cliSocket),
		prefs: readPrefs(targets),
		urlHandlers: readUrlHandlers(targets),
	};
}

const fmtProcs = (list) => (list.length ? list.map((p) => `pid ${p.pid} started ${p.start}`).join(', ') : 'none');

function compareProcesses(before, after, violations, notes) {
	const a = fmtProcs(before.host.mainProcesses);
	const b = fmtProcs(after.host.mainProcesses);
	if (a !== b) violations.push(`(a) host Obsidian main process changed: before [${a}], after [${b}]`);
	else notes.push(`(a) host Obsidian main process unchanged: ${a}`);
}

function compareSocket(before, after, violations, notes) {
	const s0 = before.cliSocket;
	const s1 = after.cliSocket;
	const same = s0.exists === s1.exists && (!s0.exists || (s0.ino === s1.ino && s0.dev === s1.dev && s0.birthtimeMs === s1.birthtimeMs));
	if (!same) {
		const d = (s) => (s.exists ? `inode ${s.ino}` : 'missing');
		violations.push(`(d) host CLI socket ${s0.path} was replaced or removed: before ${d(s0)}, after ${d(s1)}`);
	} else {
		notes.push(`(d) host CLI socket unchanged: ${s0.exists ? `inode ${s0.ino}` : 'not present before or after'}`);
	}
}

function comparePrefs(before, after, violations, notes) {
	const p0 = before.prefs;
	const p1 = after.prefs;
	const problems = [];
	if (p0.exportSha256 !== p1.exportSha256) {
		const k0 = Object.keys(p0.keys);
		const k1 = Object.keys(p1.keys);
		const added = k1.filter((k) => !(k in p0.keys));
		const removed = k0.filter((k) => !(k in p1.keys));
		const changed = k0.filter((k) => k in p1.keys && p0.keys[k] !== p1.keys[k]);
		const parts = [];
		if (added.length) parts.push(`added ${added.join(', ')}`);
		if (removed.length) parts.push(`removed ${removed.join(', ')}`);
		if (changed.length) parts.push(`changed ${changed.join(', ')}`);
		problems.push(`domain ${p0.domain} content changed (${parts.join('; ') || 'export differs'})`);
	}
	const names = [...new Set([...Object.keys(p0.files), ...Object.keys(p1.files)])].sort();
	for (const name of names) {
		const f0 = p0.files[name];
		const f1 = p1.files[name];
		if (!f0) problems.push(`${name} appeared`);
		else if (!f1) problems.push(`${name} disappeared`);
		else if (f0.sha256 !== f1.sha256 || f0.size !== f1.size) problems.push(`${name} bytes changed`);
		else if (f0.mtimeMs !== f1.mtimeMs) problems.push(`${name} rewritten (same bytes, mtime ${new Date(f0.mtimeMs).toISOString()} -> ${new Date(f1.mtimeMs).toISOString()})`);
	}
	if (problems.length > 0) {
		violations.push(`(e) host preferences changed: ${problems.join(' | ')} (if you used a file dialog in the host Obsidian during the run, rerun)`);
	} else {
		const files = names.map((n) => `${n} sha256 ${p0.files[n].sha256.slice(0, 12)}..., mtime ${new Date(p0.files[n].mtimeMs).toISOString()}`).join('; ');
		notes.push(`(e) host preferences domain ${p0.domain} unchanged (${Object.keys(p0.keys).length} keys, export sha256 ${p0.exportSha256.slice(0, 12)}...; ${files || 'no plist file'})`);
	}
}

function compareUrlHandlers(before, after, violations, notes) {
	const h0 = before.urlHandlers;
	const h1 = after.urlHandlers;
	if (h0.mode !== h1.mode || h0.sha256 !== h1.sha256) {
		const show = (h) => (h.mode === 'entries' ? JSON.stringify(h.entries) : `whole domain sha256 ${h.sha256.slice(0, 12)}...`);
		violations.push(`(f) LaunchServices handlers for obsidian:// / md.obsidian changed: before ${show(h0)}, after ${show(h1)}`);
	} else if (h0.mode === 'entries') {
		notes.push(`(f) LaunchServices handlers for obsidian:// / md.obsidian unchanged (${h0.entries.length} explicit entr${h0.entries.length === 1 ? 'y' : 'ies'})`);
	} else {
		notes.push(`(f) LaunchServices preferences unchanged (whole domain sha256 ${h0.sha256.slice(0, 12)}...)`);
	}
}

/** Compares a full snapshot with a later full state. Returns { ok, violations, notes }. */
export function compareStates(before, after) {
	const violations = [];
	const notes = [];
	if (before.schema !== SCHEMA) violations.push(`snapshot schema ${String(before.schema)} is not ${SCHEMA}`);

	compareProcesses(before, after, violations, notes);

	const j0 = before.obsidianJson;
	const j1 = after.obsidianJson;
	if (j0.exists !== j1.exists) {
		violations.push(`(b) obsidian.json ${j0.exists ? 'disappeared' : 'appeared'}: ${j0.path}`);
	} else if (!j0.exists) {
		notes.push('(b) obsidian.json absent before and after');
	} else if (j0.sha256 === j1.sha256) {
		notes.push(`(b) obsidian.json unchanged (sha256 ${j0.sha256.slice(0, 12)}...)`);
	} else if (j0.vaults !== null && j1.vaults !== null && JSON.stringify(sortObj(j0.vaults)) === JSON.stringify(sortObj(j1.vaults))) {
		notes.push('(b) obsidian.json was rewritten (sha256 changed) but its vaults set is unchanged: treated as a write by the running host app');
	} else {
		violations.push(`(b) obsidian.json vaults changed: before ${JSON.stringify(j0.vaults)}, after ${JSON.stringify(j1.vaults)}`);
	}

	if (before.vaults.length === 0) violations.push('(c) snapshot lists no host vault to check');
	for (const v0 of before.vaults) {
		const v1 = after.vaults.find((v) => v.path === v0.path);
		if (!v1) {
			violations.push(`(c) vault missing from the later state: ${v0.path}`);
			continue;
		}
		const changed = CONFIG_FILES.filter((name) => v0.files[name] !== v1.files[name]);
		for (const name of changed) violations.push(`(c) ${path.join(v0.path, '.obsidian', name)} changed`);
		const p0 = JSON.stringify(v0.tabstripPlugin && sortObj(v0.tabstripPlugin));
		const p1 = JSON.stringify(v1.tabstripPlugin && sortObj(v1.tabstripPlugin));
		if (p0 !== p1) {
			violations.push(`(c) ${path.join(v0.path, '.obsidian', 'plugins', PLUGIN_ID)} ${v0.tabstripPlugin ? 'changed' : 'was created'}`);
		}
		if (changed.length === 0 && p0 === p1) {
			notes.push(`(c) ${v0.path}: ${CONFIG_FILES.length} config files unchanged, plugins/${PLUGIN_ID} ${v0.tabstripPlugin ? 'unchanged' : 'absent'}`);
		}
	}

	compareSocket(before, after, violations, notes);
	comparePrefs(before, after, violations, notes);
	compareUrlHandlers(before, after, violations, notes);
	return { ok: violations.length === 0, violations, notes };
}

/** Compares only the quick subset (for polling during a run). */
export function compareQuick(before, after) {
	const violations = [];
	const notes = [];
	compareProcesses(before, after, violations, notes);
	compareSocket(before, after, violations, notes);
	comparePrefs(before, after, violations, notes);
	compareUrlHandlers(before, after, violations, notes);
	return { ok: violations.length === 0, violations, notes };
}

function sortObj(obj) {
	return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
