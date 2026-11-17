// Builds the throwaway spike plugin (spikes/s1-chip/plugin/main.ts -> main.js, git-ignored).
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
	entryPoints: [path.join(here, 'plugin', 'main.ts')],
	outfile: path.join(here, 'plugin', 'main.js'),
	bundle: true,
	format: 'cjs',
	target: 'es2021',
	external: ['obsidian'],
	logLevel: 'info',
});
