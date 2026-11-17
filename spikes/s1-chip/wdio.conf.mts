import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// The root config holds the sandbox interlocks (throwaway HOME, patched installer without bundle id);
// importing it runs them. scripts/e2e.mjs refuses configs that do not import it.
import { config as base } from '../../wdio.conf.mts';
import { mainVaultPath } from '../../scripts/host-guard.mjs';

// Spike S1 (step L2). Run only through `npm run spike:s1` (scripts/e2e.mjs --config ...).

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// Atom theme for check A3. The two theme files are READ from the user's vault and written into a
// git-ignored folder of this repo (test/themes/ is in .gitignore); nothing is written to the vault.
// Content is copied with read/write (not a file clone), so no file attributes come along.
const atomSource = process.env.TABSTRIP_ATOM_THEME_DIR ?? path.join(mainVaultPath(), '.obsidian', 'themes', 'Atom');
const atomCopy = path.join(repoRoot, 'test', 'themes', 'Atom');
fs.mkdirSync(atomCopy, { recursive: true });
for (const name of ['manifest.json', 'theme.css']) {
	const from = path.join(atomSource, name);
	if (!fs.existsSync(from)) throw new Error(`Atom theme file not found: ${from} (set TABSTRIP_ATOM_THEME_DIR)`);
	fs.writeFileSync(path.join(atomCopy, name), fs.readFileSync(from));
}

const capabilities = (base.capabilities as WebdriverIO.Capabilities[]).map((cap) => {
	const options = cap['wdio:obsidianOptions'];
	if (!options?.binaryPath) throw new Error('base capability has no sandbox binaryPath');
	return {
		...cap,
		'wdio:obsidianOptions': {
			...options,
			// Only the spike plugin; Tabstrip itself is not needed here.
			plugins: [path.join(here, 'plugin')],
			// Installed into the temporary vault copy, not enabled; the spec switches to it.
			themes: [{ path: atomCopy, enabled: false }],
			vault: path.join(repoRoot, 'test', 'vaults', 'basic'),
			copy: true,
		},
		'goog:chromeOptions': {
			...cap['goog:chromeOptions'],
			args: [
				...(cap['goog:chromeOptions']?.args ?? []),
				// Keep the sandbox window drawing while other windows cover it; otherwise screenshots
				// time out ("Timed out receiving message from renderer") when the user works elsewhere.
				'--disable-backgrounding-occluded-windows',
				'--disable-renderer-backgrounding',
				'--disable-background-timer-throttling',
			],
		},
	};
});

export const config: WebdriverIO.Config = {
	...base,
	specs: [path.join(here, '*.e2e.ts')],
	capabilities,
	mochaOpts: { ui: 'bdd', timeout: 180_000 },
};
