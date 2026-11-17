import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWdioConfig } from '../../scripts/config-guard.mjs';

// `scripts/e2e.mjs --config` only runs a wdio config that really imports the root wdio.conf.mts
// (where the sandbox interlocks are) and builds on its config. These cases run against a fake repo
// in a temp dir; the real repo is only read for the last case.

const BASE_IMPORT = "import { config as base } from '../../wdio.conf.mts';";
const USES_BASE = 'export const config = { ...base, specs: [] };';

let repo = '';
const write = (rel: string, text: string): string => {
	const file = path.join(repo, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return rel;
};
const check = (rel: string) => checkWdioConfig(rel, repo);

beforeAll(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-config-guard-'));
	write('wdio.conf.mts', 'export const config = { capabilities: [] };\n');
});
afterAll(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe('e2e --config interlock', () => {
	it('accepts the root config itself', () => {
		const result = check('./wdio.conf.mts');
		expect(result.problems).toEqual([]);
		expect(result.isRoot).toBe(true);
	});

	it('accepts a config that imports the root config and builds on it', () => {
		expect(check(write('spikes/ok/wdio.conf.mts', `${BASE_IMPORT}\n${USES_BASE}\n`)).problems).toEqual([]);
		expect(check(write('spikes/ok-plain/wdio.conf.mts', "import { config } from '../../wdio.conf.mts';\nexport default { ...config };\n")).ok).toBe(true);
		expect(check(write('spikes/ok-ns/wdio.conf.mts', "import * as root from '../../wdio.conf.mts';\nexport const config = { ...root.config };\n")).ok).toBe(true);
		// Other imports next to it do not matter.
		expect(check(write('spikes/ok-more/wdio.conf.mts', `import * as path from 'node:path';\n${BASE_IMPORT}\n${USES_BASE}\nconsole.log(path.sep);\n`)).ok).toBe(true);
	});

	it('refuses a line-commented import', () => {
		const result = check(write('spikes/line-comment/wdio.conf.mts', `// ${BASE_IMPORT}\nconst base = { capabilities: [] };\n${USES_BASE}\n`));
		expect(result.ok).toBe(false);
		expect(result.problems.join(' ')).toContain('path imports found: none');
	});

	it('refuses a block-commented import', () => {
		expect(check(write('spikes/block-comment/wdio.conf.mts', `/*\n${BASE_IMPORT}\n*/\nconst base = {};\n${USES_BASE}\n`)).ok).toBe(false);
	});

	it('refuses an import that only appears inside a string or template', () => {
		expect(check(write('spikes/string/wdio.conf.mts', `const s = "${BASE_IMPORT}";\nconst t = \`\n${BASE_IMPORT}\n\`;\nconst base = {};\n${USES_BASE}\n`)).ok).toBe(false);
	});

	it('refuses an import of a different, nested wdio.conf.mts', () => {
		write('spikes/nested/wdio.conf.mts', 'export const config = { capabilities: [] };\n');
		// Sibling file with the same name.
		const sibling = check(write('spikes/nested/run.conf.mts', "import { config as base } from './wdio.conf.mts';\nexport const config = { ...base };\n"));
		expect(sibling.ok).toBe(false);
		expect(sibling.problems.join(' ')).toContain(path.join('spikes', 'nested', 'wdio.conf.mts'));
		// One level too shallow: resolves to spikes/wdio.conf.mts.
		write('spikes/wdio.conf.mts', 'export const config = { capabilities: [] };\n');
		expect(check(write('spikes/shallow/wdio.conf.mts', "import { config as base } from '../wdio.conf.mts';\nexport const config = { ...base };\n")).ok).toBe(false);
		// Right name, but not a path that resolves to the root file.
		expect(check(write('spikes/query/wdio.conf.mts', "import { config as base } from '../../wdio.conf.mts?x';\nexport const config = { ...base };\n")).ok).toBe(false);
	});

	it('refuses imports that do not evaluate the root config or do not bind its config', () => {
		// Type-only imports are erased before the config runs.
		expect(check(write('spikes/type-only/wdio.conf.mts', "import type { config as base } from '../../wdio.conf.mts';\nconst b: typeof base = {} as never;\nexport const config = { ...b };\n")).ok).toBe(false);
		expect(check(write('spikes/type-element/wdio.conf.mts', "import { type config as base } from '../../wdio.conf.mts';\nexport const config = {} as typeof base;\n")).ok).toBe(false);
		// Imported but never used as a value: TypeScript loaders drop such an import.
		expect(check(write('spikes/unused/wdio.conf.mts', `${BASE_IMPORT}\nexport const config = { specs: [] };\n`)).ok).toBe(false);
		expect(check(write('spikes/type-use/wdio.conf.mts', `${BASE_IMPORT}\nexport const config: typeof base = { specs: [] } as never;\n`)).ok).toBe(false);
		expect(check(write('spikes/member-name/wdio.conf.mts', `${BASE_IMPORT}\nconst x = { base: 1 };\nexport const config = { specs: [], n: x.base };\n`)).ok).toBe(false);
		// Something other than `config`.
		expect(check(write('spikes/other-name/wdio.conf.mts', "import { other } from '../../wdio.conf.mts';\nexport const config = { ...other };\n")).ok).toBe(false);
		// Side-effect import only.
		expect(check(write('spikes/side-effect/wdio.conf.mts', "import '../../wdio.conf.mts';\nexport const config = {};\n")).ok).toBe(false);
		// Import nested in a block is not a module import (and would not parse as one).
		expect(check(write('spikes/dynamic/wdio.conf.mts', "const { config: base } = await import('../../wdio.conf.mts');\nexport const config = { ...base };\n")).ok).toBe(false);
	});

	it('refuses configs outside the repo, missing files and symlinks that leave the repo', () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-config-outside-'));
		try {
			fs.writeFileSync(path.join(outside, 'wdio.conf.mts'), `${BASE_IMPORT}\n${USES_BASE}\n`);
			expect(check(path.join(outside, 'wdio.conf.mts')).ok).toBe(false);
			expect(check('../' + path.basename(outside) + '/wdio.conf.mts').ok).toBe(false);
			fs.symlinkSync(path.join(outside, 'wdio.conf.mts'), path.join(repo, 'link.conf.mts'));
			expect(check('link.conf.mts').problems.join(' ')).toContain('outside the repo');
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
		expect(check('spikes/missing/wdio.conf.mts').ok).toBe(false);
		expect(check('spikes').ok).toBe(false);
		expect(checkWdioConfig(undefined, repo).ok).toBe(false);
	});

	it('accepts the real S1 spike config of this repo', () => {
		const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
		expect(checkWdioConfig('spikes/s1-chip/wdio.conf.mts', repoRoot).problems).toEqual([]);
	});
});
