/**
 * Release metadata: manifest.json, package.json, package-lock.json and versions.json agree, and the
 * description follows the community directory's rules (no "Obsidian", starts with a verb, ends
 * with a period, short).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')) as Record<string, unknown>;

const manifest = read('manifest.json');
const pkg = read('package.json');
const lock = read('package-lock.json') as { version?: string; packages?: Record<string, { version?: string }> };
const versions = read('versions.json');

describe('release metadata', () => {
	it('has one version everywhere, listed in versions.json with the manifest minAppVersion', () => {
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.version).toBe(manifest.version);
		expect(lock.version).toBe(manifest.version);
		expect(lock.packages?.['']?.version).toBe(manifest.version);
		expect(versions[manifest.version as string]).toBe(manifest.minAppVersion);
		// Only released versions are listed.
		expect(Object.keys(versions)).not.toContain('0.0.1');
		expect(Object.keys(versions)).not.toContain('0.1.0');
	});

	it('uses the same description in manifest.json and package.json, within the directory rules', () => {
		const description = manifest.description as string;
		expect(pkg.description).toBe(description);
		expect(description).not.toMatch(/obsidian/i);
		expect(description).toMatch(/^Group\s/);
		expect(description.endsWith('.')).toBe(true);
		expect(description.length).toBeLessThanOrEqual(250);
		expect(description).toMatch(/vertical tab strip/);
	});

	it('is a desktop-only plugin with id tabstrip', () => {
		expect(manifest.id).toBe('tabstrip');
		expect(manifest.isDesktopOnly).toBe(true);
	});
});
