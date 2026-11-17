/**
 * Sandbox copy of the Obsidian installer, isolated from the host's macOS preferences.
 *
 * Why: macOS stores an app's preferences (NSUserDefaults / CFPreferences) under its bundle
 * identifier, through the per-user cfprefsd daemon. The official installer has the same bundle id
 * as the host app (`md.obsidian`), so a sandbox started from it writes into the host's preferences
 * domain (~/Library/Preferences/md.obsidian.plist). Neither a separate HOME nor CFFIXED_USER_HOME
 * changes that: cfprefsd resolves the domain itself.
 *
 * Giving the sandbox a different bundle id is not safe either: Obsidian's main process registers
 * itself as the obsidian:// handler at startup when it is not the default handler already, which
 * would point the user's obsidian:// links at the sandbox.
 *
 * So the sandbox runs from a copy of the installer whose Info.plist has NO bundle id:
 *  - preferences fall back to a domain named after the executable (`Obsidian`), not `md.obsidian`;
 *  - Electron refuses to change the protocol handler when the app has no bundle id;
 *  - CFBundleURLTypes / CFBundleDocumentTypes / NSUbiquitousContainers are removed, so the copy
 *    claims no URL scheme, no file type and no iCloud container in LaunchServices.
 * The copy is ad-hoc signed again (its Info.plist changed). Nothing is downloaded here except what
 * obsidian-launcher would download anyway (the official installer, into the shared cache).
 *
 * Quiet sandbox (step Q): the user works on this Mac while the e2e suites run, so by default the copy
 * also gets an activation key in its Info.plist (see ACTIVATION_MODES) that keeps the sandbox out of
 * the Dock and stops it from becoming the frontmost app, so it cannot take the keyboard focus.
 * TABSTRIP_SANDBOX_ACTIVATION=regular gives a normal app again (Dock icon, takes the focus), e.g. to
 * watch a run; it (and uielement) also needs TABSTRIP_ALLOW_FOREGROUND=1, set only by the user. Switching modes rebuilds the copy.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Bump when the patch below changes, so cached copies are rebuilt. */
export const PATCH_VERSION = 4;
/** Folder (inside the Obsidian cache) that holds the patched copies. */
export const SANDBOX_INSTALLER_DIR = 'tabstrip-sandbox-installer';
/** Preferences domain the patched sandbox ends up writing to (its executable name). */
export const SANDBOX_PREFS_DOMAIN = 'Obsidian';
/** Info.plist keys removed from the copy. */
export const REMOVED_KEYS = ['CFBundleIdentifier', 'CFBundleURLTypes', 'CFBundleDocumentTypes', 'NSUbiquitousContainers'];

/**
 * Info.plist keys that decide how the sandbox app shows up (macOS application type):
 *  - background: LSBackgroundOnly. No Dock icon, no menu bar, and macOS never makes it the active
 *    (frontmost) app, so it never takes the keyboard focus. Its window can still be on screen.
 *  - uielement: LSUIElement ("agent" app). No Dock icon, but it can still activate itself.
 *  - regular: neither key; a normal app with a Dock icon (the behaviour before step Q).
 */
export const ACTIVATION_MODES = {
	background: { LSBackgroundOnly: true },
	uielement: { LSUIElement: true },
	regular: {},
};
export const DEFAULT_ACTIVATION_MODE = 'background';
const ACTIVATION_KEYS = ['LSBackgroundOnly', 'LSUIElement'];

/**
 * Invisible-from-birth windows (patch 3). The copy's Resources/app.asar is replaced by a tiny archive
 * (packed below) whose only job is to register a main-process 'browser-window-created' hook and then
 * load the installer's original archive, kept unchanged next to it as tabstrip-installer.asar (with
 * its .unpacked folder). The hook makes every sandbox window transparent and click-through in the same
 * tick it is created, before macOS ever draws it. (A Resources/app folder is not used by this Electron
 * build: it loads app.asar first.) The renderer-side hide in test/e2e/invisible.ts stays as a second
 * layer; before this, each fresh app launch (L6 restarts) showed its first window until that hide ran.
 * Opt out (watch a run): wdio passes --tabstrip-sandbox-visible when TABSTRIP_SANDBOX_VISIBLE=1.
 */
export const HIDE_SHIM_VISIBLE_SWITCH = '--tabstrip-sandbox-visible';
export const HIDE_SHIM_FILE = 'tabstrip-sandbox-shim.js';
export const INSTALLER_ASAR = 'tabstrip-installer.asar';
const HIDE_SHIM_SOURCE = `'use strict';
// Tabstrip test sandbox only (scripts/sandbox-app.mjs packs this into a patched installer copy).
// Makes every window transparent and click-through as it is created, then loads the real installer.
const path = require('path');
const { app } = require('electron');
if (!process.argv.includes(${JSON.stringify(HIDE_SHIM_VISIBLE_SWITCH)})) {
	app.on('browser-window-created', (_event, win) => {
		win.setOpacity(0);
		win.setIgnoreMouseEvents(true);
	});
}
const realApp = path.join(process.resourcesPath, ${JSON.stringify(INSTALLER_ASAR)});
app.setAppPath(realApp);
require(realApp);
`;

function readAsarHeader(asarPath) {
	const fd = fs.openSync(asarPath, 'r');
	try {
		const head = Buffer.alloc(16);
		fs.readSync(fd, head, 0, 16, 0);
		const pickleSize = head.readUInt32LE(4);
		const jsonSize = head.readUInt32LE(12);
		const json = Buffer.alloc(jsonSize);
		fs.readSync(fd, json, 0, jsonSize, 16);
		return { header: JSON.parse(json.toString('utf8')), base: 8 + pickleSize };
	} finally {
		fs.closeSync(fd);
	}
}

/** Names of the top-level files packed in an asar archive, read from its header. */
export function asarFileNames(asarPath) {
	return Object.keys(readAsarHeader(asarPath).header.files ?? {});
}

/** package.json of an asar archive, read straight from it (read-only, no extraction). */
export function readAsarPackageJson(asarPath) {
	const { header, base } = readAsarHeader(asarPath);
	const entry = header.files?.['package.json'];
	if (!entry || entry.unpacked) throw new Error(`no packed package.json in ${asarPath}`);
	const fd = fs.openSync(asarPath, 'r');
	try {
		const body = Buffer.alloc(entry.size);
		fs.readSync(fd, body, 0, entry.size, base + Number(entry.offset));
		return JSON.parse(body.toString('utf8'));
	} finally {
		fs.closeSync(fd);
	}
}

/** Writes a minimal asar archive of flat files ({ name: Buffer }). */
export function writeAsar(file, files) {
	const header = { files: {} };
	let offset = 0;
	for (const [name, body] of Object.entries(files)) {
		header.files[name] = { size: body.length, offset: String(offset) };
		offset += body.length;
	}
	const json = Buffer.from(JSON.stringify(header), 'utf8');
	const aligned = (json.length + 3) & ~3;
	const head = Buffer.alloc(16 + aligned);
	head.writeUInt32LE(4, 0);
	head.writeUInt32LE(8 + aligned, 4);
	head.writeUInt32LE(4 + aligned, 8);
	head.writeUInt32LE(json.length, 12);
	json.copy(head, 16);
	fs.writeFileSync(file, Buffer.concat([head, ...Object.values(files)]));
}

/**
 * Moves a (staging) bundle's app.asar and app.asar.unpacked aside as tabstrip-installer.asar[.unpacked]
 * and packs the hide shim as the new app.asar. Name and version mirror the original.
 */
export function writeHideShim(bundle) {
	const res = path.join(bundle, 'Contents', 'Resources');
	const original = path.join(res, 'app.asar');
	const real = readAsarPackageJson(original);
	fs.renameSync(original, path.join(res, INSTALLER_ASAR));
	if (fs.existsSync(`${original}.unpacked`)) fs.renameSync(`${original}.unpacked`, path.join(res, `${INSTALLER_ASAR}.unpacked`));
	const pkg = { name: real.name, version: real.version, private: true, main: HIDE_SHIM_FILE };
	if (real.productName) pkg.productName = real.productName;
	writeAsar(original, {
		'package.json': Buffer.from(JSON.stringify(pkg, null, '\t') + '\n'),
		[HIDE_SHIM_FILE]: Buffer.from(HIDE_SHIM_SOURCE),
	});
}

/** Activation mode for this run: TABSTRIP_SANDBOX_ACTIVATION, default DEFAULT_ACTIVATION_MODE. */
export function sandboxActivationMode(env = process.env) {
	const mode = env.TABSTRIP_SANDBOX_ACTIVATION?.trim() || DEFAULT_ACTIVATION_MODE;
	if (!Object.hasOwn(ACTIVATION_MODES, mode)) {
		throw new Error(`TABSTRIP_SANDBOX_ACTIVATION must be one of ${Object.keys(ACTIVATION_MODES).join(', ')} (got ${mode})`);
	}
	// The user works on this Mac during runs and asked that the sandbox never take their focus.
	// Modes that can activate the app need the user's own opt-in; agents must not set it.
	if (mode !== 'background' && env.TABSTRIP_ALLOW_FOREGROUND !== '1') {
		throw new Error(
			`TABSTRIP_SANDBOX_ACTIVATION=${mode} can take the user's focus and is disabled. ` +
				'Run in the default background mode (take screenshots there too). ' +
				'Only the user may opt in, by also setting TABSTRIP_ALLOW_FOREGROUND=1 themselves.',
		);
	}
	return mode;
}

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function plistHasKey(plist, key) {
	try {
		execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { stdio: ['ignore', 'pipe', 'ignore'] });
		return true;
	} catch {
		return false;
	}
}

/** Reads CFBundleIdentifier of an app bundle, or null when it has none. */
export function bundleIdentifier(bundle) {
	try {
		return execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}

/** App bundle that contains a Contents/MacOS/<executable> path. */
export function bundleOfBinary(binaryPath) {
	return path.resolve(binaryPath, '..', '..', '..');
}

/** Problems that make a bundle unfit to run as the sandbox (empty array = fit). */
export function sandboxBundleProblems(bundle, cacheDir) {
	const problems = [];
	const root = path.join(path.resolve(cacheDir), SANDBOX_INSTALLER_DIR) + path.sep;
	if (!path.resolve(bundle).startsWith(root)) problems.push(`not inside ${root}`);
	const plist = path.join(bundle, 'Contents', 'Info.plist');
	if (!fs.existsSync(plist)) return [...problems, `missing ${plist}`];
	for (const key of REMOVED_KEYS) if (plistHasKey(plist, key)) problems.push(`Info.plist still has ${key}`);
	try {
		const res = path.join(bundle, 'Contents', 'Resources');
		const shimmed = fs.existsSync(path.join(res, INSTALLER_ASAR)) && asarFileNames(path.join(res, 'app.asar')).includes(HIDE_SHIM_FILE);
		if (!shimmed) problems.push('missing the invisible-window shim');
	} catch (e) {
		problems.push(`cannot read the invisible-window shim: ${e}`);
	}
	return problems;
}

function patchedIsCurrent(dest, stampFile, sourcePlistSha, activation) {
	try {
		const stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
		if (stamp.patchVersion !== PATCH_VERSION || stamp.sourceInfoPlistSha256 !== sourcePlistSha || stamp.activation !== activation) return false;
		execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/**
 * Makes (or reuses) the patched copy of one installer bundle. Returns the path of its executable.
 * `log` receives one-line progress messages.
 */
export function patchInstaller(sourceBundle, installerVersion, cacheDir, log = () => {}, activation = sandboxActivationMode(), suffix = '') {
	const platformDir = `${process.platform}-${process.arch}`;
	const parent = path.join(path.resolve(cacheDir), SANDBOX_INSTALLER_DIR, platformDir);
	// suffix: a separate copy (scripts/try.mjs keeps its interactive copy apart from the e2e one).
	const dest = path.join(parent, `Obsidian-${installerVersion}${suffix}`);
	const stampFile = `${dest}.stamp.json`;
	const sourcePlist = path.join(sourceBundle, 'Contents', 'Info.plist');
	const sourcePlistSha = sha256File(sourcePlist);
	const binary = path.join(dest, 'Contents', 'MacOS', 'Obsidian');

	if (patchedIsCurrent(dest, stampFile, sourcePlistSha, activation) && sandboxBundleProblems(dest, cacheDir).length === 0) {
		log(`reusing patched installer ${installerVersion} (activation ${activation}): ${dest}`);
		return binary;
	}

	log(`patching installer ${installerVersion} (activation ${activation}): ${sourceBundle} -> ${dest}`);
	fs.mkdirSync(parent, { recursive: true });
	const staging = `${dest}.staging-${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	try {
		// Plain copy: no extended attributes, no quarantine, no ACLs. The source is only read.
		execFileSync('/usr/bin/ditto', ['--noextattr', '--noqtn', '--noacl', sourceBundle, staging], { stdio: 'inherit' });
		const plist = path.join(staging, 'Contents', 'Info.plist');
		for (const key of [...REMOVED_KEYS, ...ACTIVATION_KEYS]) {
			if (plistHasKey(plist, key)) execFileSync('/usr/bin/plutil', ['-remove', key, plist], { stdio: 'inherit' });
		}
		for (const [key, value] of Object.entries(ACTIVATION_MODES[activation])) {
			execFileSync('/usr/bin/plutil', ['-replace', key, '-bool', value ? 'YES' : 'NO', plist], { stdio: 'inherit' });
		}
		writeHideShim(staging);
		// Ad-hoc signature (no identity, no keychain); without the hardened-runtime flag.
		execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', staging], { stdio: 'inherit' });
		execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staging], { stdio: 'inherit' });
		fs.rmSync(dest, { recursive: true, force: true });
		fs.renameSync(staging, dest);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
	const problems = sandboxBundleProblems(dest, cacheDir);
	if (problems.length > 0) throw new Error(`patched installer is not fit as a sandbox: ${problems.join('; ')}`);
	fs.writeFileSync(
		stampFile,
		JSON.stringify(
			{
				patchVersion: PATCH_VERSION,
				installerVersion,
				sourceBundle,
				sourceInfoPlistSha256: sourcePlistSha,
				removedKeys: REMOVED_KEYS,
				activation,
				activationKeys: ACTIVATION_MODES[activation],
				createdAt: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	return binary;
}

/**
 * Resolves each app version like wdio-obsidian-service does (installer "earliest"), downloads the
 * official installer into the cache if needed, and prepares its patched copy.
 * Returns { [appVersion]: { appVersion, installerVersion, binaryPath, sourceBinaryPath, activation } }.
 */
export async function prepareSandboxInstallers(appVersions, cacheDir, log = () => {}) {
	const activation = sandboxActivationMode();
	const { default: ObsidianLauncher } = await import('obsidian-launcher');
	const launcher = new ObsidianLauncher({ cacheDir });
	const result = {};
	for (const requested of appVersions) {
		const [appVersion, installerVersion] = await launcher.resolveVersion(requested, 'earliest');
		const sourceBinaryPath = await launcher.downloadInstaller(installerVersion);
		const binaryPath = patchInstaller(bundleOfBinary(sourceBinaryPath), installerVersion, cacheDir, log, activation);
		result[requested] = { appVersion, installerVersion, binaryPath, sourceBinaryPath, activation };
	}
	return result;
}

// ---- the sandbox preferences domain (evidence and cleanup) ----

const DEFAULTS = '/usr/bin/defaults';

/** Environment for `defaults`: the real user, no redirection variables. */
function defaultsEnv() {
	const env = { ...process.env };
	delete env.CFFIXED_USER_HOME;
	return env;
}

/** Top-level keys of a preferences domain (empty array when the domain is empty or absent). */
export function domainKeys(domain) {
	const xml = execFileSync(DEFAULTS, ['export', domain, '-'], { encoding: 'utf8', env: defaultsEnv() });
	return [...xml.matchAll(/^\t<key>(.*)<\/key>$/gm)].map((m) => m[1]);
}

/** Path of the sandbox domain's plist file in the real user's preferences folder. */
export function sandboxPrefsFile(home = os.userInfo().homedir) {
	return path.join(home, 'Library', 'Preferences', `${SANDBOX_PREFS_DOMAIN}.plist`);
}

function isEmptyDictPlist(file) {
	try {
		const xml = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		return /<plist version="1\.0">\s*<dict\/>\s*<\/plist>\s*$/.test(xml);
	} catch {
		return false;
	}
}

/**
 * Deletes the sandbox preferences domain (refuses any other domain), then removes its plist file
 * if cfprefsd left it behind holding an empty dictionary.
 * Returns { keysLeft, fileLeft }.
 */
export function deleteSandboxDomain(domain = SANDBOX_PREFS_DOMAIN) {
	if (domain !== SANDBOX_PREFS_DOMAIN) throw new Error(`refusing to delete preferences domain ${domain}`);
	try {
		execFileSync(DEFAULTS, ['delete', domain], { stdio: 'ignore', env: defaultsEnv() });
	} catch {
		// domain did not exist
	}
	const keysLeft = domainKeys(domain);
	const file = sandboxPrefsFile();
	if (keysLeft.length === 0 && fs.existsSync(file) && isEmptyDictPlist(file)) fs.rmSync(file);
	return { keysLeft, fileLeft: fs.existsSync(file) };
}
