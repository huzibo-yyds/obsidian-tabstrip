import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
	HIDE_SHIM_FILE,
	HIDE_SHIM_VISIBLE_SWITCH,
	INSTALLER_ASAR,
	asarFileNames,
	readAsarPackageJson,
	writeAsar,
	writeHideShim,
} from '../../scripts/sandbox-app.mjs';

// The patched sandbox copy hides every window in the main process as it is created (patch 4).
const dirs: string[] = [];
const tmp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-shim-'));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Reads one packed file back the way Electron's asar reader does (pickle header, then data). */
function readPacked(file: string, name: string): string {
	const buf = fs.readFileSync(file);
	expect(buf.readUInt32LE(0)).toBe(4);
	const headerSize = buf.readUInt32LE(4);
	expect(buf.readUInt32LE(8)).toBe(headerSize - 4);
	const jsonLen = buf.readUInt32LE(12);
	const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8')) as { files: Record<string, { size: number; offset: string }> };
	const entry = header.files[name];
	if (!entry) throw new Error(`${name} is not packed in ${file}`);
	const start = 8 + headerSize + Number(entry.offset);
	return buf.subarray(start, start + entry.size).toString('utf8');
}

describe('sandbox hide shim', () => {
	it('writeAsar packs flat files that read back byte for byte (odd header lengths are padded)', () => {
		const file = path.join(tmp(), 'a.asar');
		writeAsar(file, { 'package.json': Buffer.from('{"name":"x","version":"1.0.0"}'), 'b.js': Buffer.from('é'), 'c.js': Buffer.from('ccc') });
		expect(asarFileNames(file)).toEqual(['package.json', 'b.js', 'c.js']);
		expect(readAsarPackageJson(file)).toEqual({ name: 'x', version: '1.0.0' });
		expect(readPacked(file, 'b.js')).toBe('é');
		expect(readPacked(file, 'c.js')).toBe('ccc');
	});

	it('moves the installer archive aside and packs a shim that hides windows unless the visible switch is given', () => {
		const res = path.join(tmp(), 'Contents', 'Resources');
		fs.mkdirSync(path.join(res, 'app.asar.unpacked'), { recursive: true });
		fs.writeFileSync(path.join(res, 'app.asar.unpacked', 'native.node'), 'n');
		writeAsar(path.join(res, 'app.asar'), {
			'package.json': Buffer.from(JSON.stringify({ name: 'obsidian', version: '1.5.8', main: 'main.js' })),
			'main.js': Buffer.from('// installer'),
		});
		writeHideShim(path.join(res, '..', '..'));

		expect(asarFileNames(path.join(res, INSTALLER_ASAR))).toEqual(['package.json', 'main.js']);
		expect(fs.existsSync(path.join(res, `${INSTALLER_ASAR}.unpacked`, 'native.node'))).toBe(true);
		expect(fs.existsSync(path.join(res, 'app.asar.unpacked'))).toBe(false);
		expect(readAsarPackageJson(path.join(res, 'app.asar'))).toEqual({ name: 'obsidian', version: '1.5.8', private: true, main: HIDE_SHIM_FILE });
		const shim = readPacked(path.join(res, 'app.asar'), HIDE_SHIM_FILE);
		expect(shim).toContain(`process.argv.includes(${JSON.stringify(HIDE_SHIM_VISIBLE_SWITCH)})`);
		expect(shim).toContain("app.on('browser-window-created'");
		expect(shim).toContain('win.setOpacity(0);');
		expect(shim).toContain('win.setIgnoreMouseEvents(true);');
		expect(shim).toContain(`path.join(process.resourcesPath, ${JSON.stringify(INSTALLER_ASAR)})`);
		// The shim is valid script source (compiled only, not run).
		expect(() => new vm.Script(shim)).not.toThrow();
	});
});
