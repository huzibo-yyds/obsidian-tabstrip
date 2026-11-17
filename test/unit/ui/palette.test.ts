import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROUP_COLORS } from '../../../src/core/types';
import { contrast, INKS, MIN_CONTRAST, parseCssColor, pickInk, type Rgb } from '../../../src/ui/color';
import { BASE_VARIABLE, closestPair, deltaE2000, FILL_MIX, MIN_DELTA_E, srgbToOklab, TARGET_INK } from '../../e2e/palette';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Obsidian 1.15 default theme values of the base variables (Atom does not change them):
 * grey is --color-base-70, the others --color-<name>.
 */
const BASES: Record<'light' | 'dark', Record<string, string>> = {
	light: { grey: '#5c5c5c', blue: '#086ddd', red: '#e93147', yellow: '#e0ac00', green: '#08b94e', pink: '#d53984', purple: '#7852ee', cyan: '#00bfbc', orange: '#ec7500' },
	dark: { grey: '#b3b3b3', blue: '#027aff', red: '#fb464c', yellow: '#e0de71', green: '#44cf6e', pink: '#fa99cd', purple: '#a882ff', cyan: '#53dfdd', orange: '#e9973f' },
};

/** color-mix(in oklab, base, black|white p%) the way CSS Color 5 defines it, as an sRGB colour. */
function mixed(hex: string, mode: 'light' | 'dark', percent: number): Rgb {
	const base = parseCssColor(hex);
	if (base === null) throw new Error(hex);
	const [l, a, b] = srgbToOklab(base);
	const p = percent / 100;
	const towards = mode === 'light' ? 0 : 1;
	const out = parseCssColor(`oklab(${String(l * (1 - p) + towards * p)} ${String(a * (1 - p))} ${String(b * (1 - p))})`);
	if (out === null) throw new Error('oklab');
	return out;
}

describe('CIEDE2000 (Sharma, Wu and Dalal test data)', () => {
	it.each([
		[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
		[[50, 0, 0], [50, -1, 2], 2.3669],
		[[50, 2.5, 0], [73, 25, -18], 27.1492],
		[[50, 2.5, 0], [61, -5, 29], 22.8977],
		[[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
	] as const)('%j / %j', (x, y, expected) => {
		expect(deltaE2000([...x], [...y])).toBeCloseTo(expected, 3);
		expect(deltaE2000([...y], [...x])).toBeCloseTo(expected, 3);
	});
});

describe('palette in styles.css', () => {
	const css = readFileSync(path.join(repoRoot, 'styles.css'), 'utf8');

	it('every colour starts from its Obsidian variable and has the intended default amounts', () => {
		for (const color of GROUP_COLORS) {
			const block = new RegExp(`\\[data-tabstrip-color='${color}'\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
			expect({ color, base: /--tabstrip-group-base:\s*var\(([^)]+)\)/.exec(block)?.[1] }).toEqual({ color, base: BASE_VARIABLE[color] });
			for (const mode of ['light', 'dark'] as const) {
				const amount = new RegExp(`--tabstrip-fill-mix-${mode}:\\s*var\\(--tabstrip-fill-mix-${mode}-${color},\\s*(\\d+)%\\)`).exec(block)?.[1];
				expect({ color, mode, amount: Number(amount) }).toEqual({ color, mode, amount: FILL_MIX[mode][color] });
			}
		}
	});

	it('mixes towards black in light mode and towards white in dark mode, in OKLab', () => {
		expect(css).toContain('.theme-light [data-tabstrip-color] { --tabstrip-group-color: color-mix(in oklab, var(--tabstrip-group-base), black var(--tabstrip-fill-mix-light)); }');
		expect(css).toContain('.theme-dark [data-tabstrip-color] { --tabstrip-group-color: color-mix(in oklab, var(--tabstrip-group-base), white var(--tabstrip-fill-mix-dark)); }');
	});
});

describe('palette on Obsidian default colours', () => {
	for (const mode of ['light', 'dark'] as const) {
		it(`${mode}: the target text colour is picked and reaches 4.5:1`, () => {
			for (const color of GROUP_COLORS) {
				const fill = mixed(BASES[mode][color] ?? '', mode, FILL_MIX[mode][color]);
				const ink = pickInk(fill);
				expect({ color, ink }).toEqual({ color, ink: TARGET_INK[mode][color] });
				expect(contrast(INKS[ink], fill), color).toBeGreaterThanOrEqual(MIN_CONTRAST);
			}
		});

		it(`${mode}: the nine fills stay clearly apart (CIEDE2000 ≥ ${String(MIN_DELTA_E)})`, () => {
			const closest = closestPair(GROUP_COLORS.map((name) => ({ name, rgb: mixed(BASES[mode][name] ?? '', mode, FILL_MIX[mode][name]) })));
			expect(closest.deltaE, JSON.stringify(closest)).toBeGreaterThanOrEqual(MIN_DELTA_E);
		});
	}
});
