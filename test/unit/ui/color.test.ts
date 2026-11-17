import { describe, expect, it } from 'vitest';
import { contrast, INKS, luminance, MIN_CONTRAST, over, parseCssColor, pickInk, type Rgb } from '../../../src/ui/color';

const rgb = (r: number, g: number, b: number, a = 1): Rgb => ({ r, g, b, a });

/** Obsidian 1.15 default theme colour variables (light and dark), the fills of the nine group colours. */
const OBSIDIAN_FILLS = {
	light: ['#ababab', '#086ddd', '#e93147', '#e0ac00', '#08b94e', '#d53984', '#7852ee', '#00bfbc', '#ec7500'],
	dark: ['#666666', '#027aff', '#fb464c', '#e0de71', '#44cf6e', '#fa99cd', '#a882ff', '#53dfdd', '#e9973f'],
};

describe('parseCssColor', () => {
	it.each([
		['rgb(8, 109, 221)', rgb(8, 109, 221)],
		['rgba(8, 109, 221, 0.5)', rgb(8, 109, 221, 0.5)],
		['rgb(8 109 221 / 50%)', rgb(8, 109, 221, 0.5)],
		['color(srgb 1 0.5 0)', rgb(255, 127.5, 0)],
		['color(srgb 1 0 0 / 0.25)', rgb(255, 0, 0, 0.25)],
		['#fff', rgb(255, 255, 255)],
		['#0000', rgb(0, 0, 0, 0)],
		['#e93147', rgb(233, 49, 71)],
		['#e9314780', rgb(233, 49, 71, 128 / 255)],
		['RGB(100%, 0%, 0%)', rgb(255, 0, 0)],
	])('%s', (text, expected) => {
		const c = parseCssColor(text);
		expect(c).not.toBeNull();
		expect(c?.r).toBeCloseTo(expected.r, 5);
		expect(c?.g).toBeCloseTo(expected.g, 5);
		expect(c?.b).toBeCloseTo(expected.b, 5);
		expect(c?.a).toBeCloseTo(expected.a, 5);
	});

	it.each([
		'transparent',
		'red',
		'hsl(0 100% 50%)',
		'color(unknown-space 1 0 0)',
		'oklch(0.5 0.1)',
		'lab(50 x 0)',
		'#12',
		'rgb(1, 2)',
		'rgb(a, b, c)',
		'rgb(1,2,3,x)',
		'',
	])('returns null for %j', (text) => {
		expect(parseCssColor(text)).toBeNull();
	});
});

/**
 * Close-out round 2 (ink-unparseable-color-white-fallback): Chromium 111+ keeps CSS Color 4
 * colours in their own space in computed values. Reference values: sRGB red and a mid grey
 * written in each space (CSS Color 4 conversions; the greys are exact, the reds round-trip
 * within a fraction of a channel).
 */
describe('parseCssColor: CSS Color 4 spaces (as computed by Chromium)', () => {
	it.each([
		// sRGB red in every space.
		['oklab(0.627955 0.224863 0.125846)', rgb(255, 0, 0)],
		['oklch(0.627955 0.257683 29.2339)', rgb(255, 0, 0)],
		['oklch(62.7955% 64.42% 29.2339deg)', rgb(255, 0, 0)],
		['lab(54.2905 80.8049 69.891)', rgb(255, 0, 0)],
		['lch(54.2905 106.837 40.8526)', rgb(255, 0, 0)],
		['color(srgb-linear 1 0 0)', rgb(255, 0, 0)],
		['color(display-p3 0.917488 0.200287 0.138561)', rgb(255, 0, 0)],
		['color(xyz-d65 0.412391 0.212639 0.0193308)', rgb(255, 0, 0)],
		['color(xyz 0.412391 0.212639 0.0193308)', rgb(255, 0, 0)],
		['color(xyz-d50 0.436066 0.222488 0.013916)', rgb(255, 0, 0)],
		['color(a98-rgb 0.858651 0 0)', rgb(255, 0, 0)],
		['color(prophoto-rgb 0.702342 0.27566 0.103519)', rgb(255, 0, 0)],
		['color(rec2020 0.791977 0.230976 0.0739748)', rgb(255, 0, 0)],
		// Greys: Cupertino's grey (oklch L 0.8 on macOS, 0.76 on Windows).
		['oklch(0.8 0 279)', rgb(189.5, 189.5, 189.5)],
		['oklch(0.76 none 285)', rgb(176.9, 176.9, 176.9)],
		['lab(77 0 0)', rgb(190.1, 190.1, 190.1)],
		['color(display-p3 0.7 0.7 0.7)', rgb(178.5, 178.5, 178.5)],
		['color(srgb 0.5 50% 0 / 0.5)', rgb(127.5, 127.5, 0, 0.5)],
		['oklab(0.5 0 0 / 25%)', rgb(99, 99, 99, 0.25)],
	])('%s', (text, expected) => {
		const c = parseCssColor(text);
		expect(c).not.toBeNull();
		expect(Math.abs((c?.r ?? NaN) - expected.r), 'r').toBeLessThan(0.75);
		expect(Math.abs((c?.g ?? NaN) - expected.g), 'g').toBeLessThan(0.75);
		expect(Math.abs((c?.b ?? NaN) - expected.b), 'b').toBeLessThan(0.75);
		expect(c?.a).toBeCloseTo(expected.a, 5);
	});

	it('clips a colour outside the sRGB gamut into it (display-p3 pure red)', () => {
		const c = parseCssColor('color(display-p3 1 0 0)');
		expect(c).not.toBeNull();
		expect(c?.r).toBeCloseTo(255, 6);
		expect(c?.g).toBeCloseTo(0, 6);
		expect(c?.b).toBeCloseTo(0, 6);
	});

	it('Cupertino light grey on macOS: white ink fails (1.9:1), the dark ink is chosen (8.6:1)', () => {
		const fill = parseCssColor('oklch(0.8 0 279)');
		if (fill === null) throw new Error('unparsed');
		expect(contrast(INKS.light, fill)).toBeLessThan(2);
		expect(pickInk(fill)).toBe('dark');
		expect(contrast(INKS.dark, fill)).toBeGreaterThan(8);
	});
});

describe('contrast (WCAG 2.x)', () => {
	it('matches known values', () => {
		expect(contrast(rgb(255, 255, 255), rgb(0, 0, 0))).toBeCloseTo(21, 5);
		expect(contrast(rgb(255, 255, 255), rgb(255, 255, 255))).toBeCloseTo(1, 5);
		expect(luminance(rgb(255, 255, 255))).toBeCloseTo(1, 5);
		expect(contrast(rgb(118, 118, 118), rgb(255, 255, 255))).toBeCloseTo(4.54, 2);
	});

	it('composites translucent colours', () => {
		expect(over(rgb(0, 0, 0, 0.5), rgb(255, 255, 255))).toEqual(rgb(127.5, 127.5, 127.5));
	});
});

describe('pickInk', () => {
	it('reaches 4.5:1 for every grey level', () => {
		for (let v = 0; v <= 255; v++) {
			const fill = rgb(v, v, v);
			expect(contrast(INKS[pickInk(fill)], fill), `grey ${String(v)}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
		}
	});

	it('reaches 4.5:1 on a coarse RGB grid', () => {
		for (let r = 0; r <= 255; r += 17) {
			for (let g = 0; g <= 255; g += 17) {
				for (let b = 0; b <= 255; b += 17) {
					const fill = rgb(r, g, b);
					expect(contrast(INKS[pickInk(fill)], fill)).toBeGreaterThanOrEqual(MIN_CONTRAST);
				}
			}
		}
	});

	it('prefers white on dark fills and the dark ink on light fills', () => {
		expect(pickInk(rgb(0, 0, 0))).toBe('light');
		expect(pickInk(rgb(255, 255, 255))).toBe('dark');
		expect(pickInk(rgb(26, 115, 232))).toBe('light');
	});

	it('reaches 4.5:1 on all nine Obsidian default colours, light and dark', () => {
		for (const fills of Object.values(OBSIDIAN_FILLS)) {
			for (const hex of fills) {
				const fill = parseCssColor(hex);
				if (fill === null) throw new Error(hex);
				expect(contrast(INKS[pickInk(fill)], fill), hex).toBeGreaterThanOrEqual(MIN_CONTRAST);
			}
		}
	});
});
