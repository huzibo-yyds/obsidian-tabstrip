/** Step V6: the options of `npm run try` (scripts/try-options.mjs). */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tryOptions } from '../../scripts/try-options.mjs';

type Options = { version: string; vertical: boolean; plugins: string[]; problems: string[] };
const parse = (argv: string[]): Options => (tryOptions as (a: string[], r: string) => Options)(argv, '/repo');

describe('npm run try options', () => {
	it('defaults: 1.15.0, horizontal, only Tabstrip installed', () => {
		expect(parse([])).toEqual({ version: '1.15.0', vertical: false, plugins: ['/repo'], problems: [] });
	});

	it('--vertical installs the seed plugin next to Tabstrip', () => {
		const o = parse(['--vertical']);
		expect(o.vertical).toBe(true);
		expect(o.plugins).toEqual(['/repo', path.join('/repo', 'scripts', 'try-seed')]);
		expect(o.problems).toEqual([]);
	});

	it('--version with --vertical in either order', () => {
		expect(parse(['--version', '1.14.4', '--vertical'])).toMatchObject({ version: '1.14.4', vertical: true, problems: [] });
		expect(parse(['--vertical', '--version', '1.13.4'])).toMatchObject({ version: '1.13.4', vertical: true, problems: [] });
	});

	it('unknown options and a missing version are problems (the script stops)', () => {
		expect(parse(['--vertcal']).problems).toEqual(['unknown option --vertcal']);
		expect(parse(['--version']).problems).toEqual(['--version needs a value']);
		expect(parse(['--version', '--vertical']).problems).toEqual(['--version needs a value']);
	});
});
