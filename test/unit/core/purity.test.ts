/**
 * src/core must stay framework-free: no `obsidian` import, no imports from outside
 * the folder, no page/window access, no timers. The lint config enforces the same;
 * this test also catches it when lint is skipped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE = join(import.meta.dirname, '../../../src/core');

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith('.ts') ? [path] : [];
	});
}

/** Drops comments and string contents so that prose and messages do not count. */
function code(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '')
		.replace(/`(?:\\.|[^`\\])*`/g, '``')
		.replace(/'(?:\\.|[^'\\])*'/g, "''");
}

const FORBIDDEN_CODE = [
	/\bwindow\b/,
	/\bdocument\b/,
	/\bactiveWindow\b/,
	/\bactiveDocument\b/,
	/\bnavigator\b/,
	/\blocalStorage\b/,
	/\bHTMLElement\b/,
	/\bMutationObserver\b/,
	/\bsetTimeout\b/,
	/\bsetInterval\b/,
	/\brequestAnimationFrame\b/,
	/\bcreateEl\b/,
	/\bcreateDiv\b/,
	/\bMath\.random\b/,
	/\bDate\.now\b/,
	/\bnew Date\b/,
	/\brequire\(/,
	/\bimport\(/,
];

describe('src/core purity', () => {
	const files = sources(CORE);

	it('finds the core sources', () => {
		expect(files.length).toBeGreaterThanOrEqual(5);
	});

	it.each(files.map((f) => [f.slice(CORE.length + 1), f]))('%s imports only from src/core and never obsidian', (_name, file) => {
		const text = readFileSync(file, 'utf8');
		const specifiers = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
		for (const spec of specifiers) {
			expect(spec).toMatch(/^\.\/[\w-]+$/);
		}
		expect(text).not.toMatch(/['"]obsidian['"]/);
	});

	it.each(files.map((f) => [f.slice(CORE.length + 1), f]))('%s does not touch the page, timers, clock or randomness', (_name, file) => {
		const body = code(readFileSync(file, 'utf8'));
		for (const pattern of FORBIDDEN_CODE) expect(body).not.toMatch(pattern);
	});

	it('the checks do fire on forbidden code', () => {
		const sample = code("import { Plugin } from 'obsidian';\nconst x = document.body; setTimeout(() => 0); // window");
		expect(sample).toMatch(/\bdocument\b/);
		expect(sample).toMatch(/\bsetTimeout\b/);
		expect(sample).not.toMatch(/\bwindow\b/);
		expect("import { Plugin } from 'obsidian';").toMatch(/['"]obsidian['"]/);
	});
});
