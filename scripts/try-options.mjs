/**
 * Command line options of `npm run try` (scripts/try.mjs), parsed apart so they can be unit tested.
 *
 *   --version <app version>  Obsidian version to open (default 1.15.0)
 *   --vertical               open the sandbox already in vertical tabs, with a few groups to look at
 *                            (installs the development-only seed plugin scripts/try-seed next to
 *                            Tabstrip in the throwaway vault copy)
 */
import path from 'node:path';

/**
 * @param {readonly string[]} argv the arguments after the script name
 * @param {string} repoRoot
 * @returns {{ version: string, vertical: boolean, plugins: string[], problems: string[] }}
 */
export function tryOptions(argv, repoRoot) {
	const problems = [];
	let version = '1.15.0';
	let vertical = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--vertical') vertical = true;
		else if (arg === '--version') {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) problems.push('--version needs a value');
			else version = v;
			i++;
		} else problems.push(`unknown option ${String(arg)}`);
	}
	const plugins = [repoRoot, ...(vertical ? [path.join(repoRoot, 'scripts', 'try-seed')] : [])];
	return { version, vertical, plugins, problems };
}
