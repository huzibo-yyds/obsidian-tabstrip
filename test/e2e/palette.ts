/**
 * The intended group palette (Chrome-like look) and the colour
 * maths the tests use to check it. Test code only; the plugin's own source of truth is
 * styles.css, and a unit test checks that its default amounts equal the ones here.
 */
import type { GroupColor } from '../../src/core/types';

/** The Obsidian variable each group colour starts from (requirements 7.2; grey: a base grey). */
export const BASE_VARIABLE: Record<GroupColor, string> = {
	grey: '--color-base-70',
	blue: '--color-blue',
	red: '--color-red',
	yellow: '--color-yellow',
	green: '--color-green',
	pink: '--color-pink',
	purple: '--color-purple',
	cyan: '--color-cyan',
	orange: '--color-orange',
};

/** How much of black (light mode) or white (dark mode) is mixed into the base, in OKLab, in %. */
export const FILL_MIX: Record<'light' | 'dark', Record<GroupColor, number>> = {
	light: { grey: 0, blue: 10, red: 15, yellow: 0, green: 30, pink: 12, purple: 10, cyan: 32, orange: 0 },
	dark: { grey: 25, blue: 40, red: 35, yellow: 0, green: 15, pink: 0, purple: 25, cyan: 0, orange: 15 },
};

/** The chip text the look aims for (Chrome): white on dark fills, #202124 on bright or pastel ones. */
export const TARGET_INK: Record<'light' | 'dark', Record<GroupColor, 'light' | 'dark'>> = {
	light: { grey: 'light', blue: 'light', red: 'light', yellow: 'dark', green: 'light', pink: 'light', purple: 'light', cyan: 'light', orange: 'dark' },
	dark: { grey: 'dark', blue: 'dark', red: 'dark', yellow: 'dark', green: 'dark', pink: 'dark', purple: 'dark', cyan: 'dark', orange: 'dark' },
};

/** The CSS a fill is expected to compute like (same expression as styles.css, with the amounts above). */
export function expectedFillCss(color: GroupColor, mode: 'light' | 'dark'): string {
	const towards = mode === 'light' ? 'black' : 'white';
	return `color-mix(in oklab, var(${BASE_VARIABLE[color]}), ${towards} ${String(FILL_MIX[mode][color])}%)`;
}

/** Smallest CIEDE2000 difference two group colours must keep (clearly different at a glance). */
export const MIN_DELTA_E = 10;

export type Srgb = { r: number; g: number; b: number };
type Vec3 = [number, number, number];

const toLinear = (c255: number) => {
	const c = c255 / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** sRGB (0..255) to OKLab (Björn Ottosson's matrices). */
export function srgbToOklab(c: Srgb): Vec3 {
	const r = toLinear(c.r);
	const g = toLinear(c.g);
	const b = toLinear(c.b);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** OKLCH of an sRGB colour: lightness 0..1, chroma, hue in degrees. */
export function oklch(c: Srgb): { l: number; c: number; h: number } {
	const [l, a, b] = srgbToOklab(c);
	return { l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** Euclidean distance in OKLab (×100, so 1 is roughly a just-noticeable step). */
export function oklabDistance(x: Srgb, y: Srgb): number {
	const a = srgbToOklab(x);
	const b = srgbToOklab(y);
	return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** sRGB (0..255) to CIE Lab with the D65 white point. */
export function srgbToLab(c: Srgb): Vec3 {
	const r = toLinear(c.r);
	const g = toLinear(c.g);
	const b = toLinear(c.b);
	const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
	const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
	return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference of two Lab colours (Sharma, Wu and Dalal, 2005). */
export function deltaE2000(lab1: Vec3, lab2: Vec3): number {
	const rad = Math.PI / 180;
	const [l1, a1, b1] = lab1;
	const [l2, a2, b2] = lab2;
	const c1 = Math.hypot(a1, b1);
	const c2 = Math.hypot(a2, b2);
	const cBar7 = ((c1 + c2) / 2) ** 7;
	const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
	const ap1 = a1 * (1 + g);
	const ap2 = a2 * (1 + g);
	const cp1 = Math.hypot(ap1, b1);
	const cp2 = Math.hypot(ap2, b2);
	const hueOf = (a: number, b: number) => {
		if (a === 0 && b === 0) return 0;
		const h = Math.atan2(b, a) / rad;
		return h < 0 ? h + 360 : h;
	};
	const hp1 = hueOf(ap1, b1);
	const hp2 = hueOf(ap2, b2);
	const dL = l2 - l1;
	const dC = cp2 - cp1;
	let dh = 0;
	if (cp1 * cp2 !== 0) {
		dh = hp2 - hp1;
		if (dh > 180) dh -= 360;
		else if (dh < -180) dh += 360;
	}
	const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dh * rad) / 2);
	const lBar = (l1 + l2) / 2;
	const cpBar = (cp1 + cp2) / 2;
	let hBar = hp1 + hp2;
	if (cp1 * cp2 !== 0) {
		if (Math.abs(hp1 - hp2) <= 180) hBar = (hp1 + hp2) / 2;
		else hBar = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
	}
	const t =
		1 -
		0.17 * Math.cos((hBar - 30) * rad) +
		0.24 * Math.cos(2 * hBar * rad) +
		0.32 * Math.cos((3 * hBar + 6) * rad) -
		0.2 * Math.cos((4 * hBar - 63) * rad);
	const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
	const cpBar7 = cpBar ** 7;
	const rc = 2 * Math.sqrt(cpBar7 / (cpBar7 + 25 ** 7));
	const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
	const sc = 1 + 0.045 * cpBar;
	const sh = 1 + 0.015 * cpBar * t;
	const rt = -Math.sin(2 * dTheta * rad) * rc;
	return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

/** CIEDE2000 between two sRGB colours. */
export function deltaE(x: Srgb, y: Srgb): number {
	return deltaE2000(srgbToLab(x), srgbToLab(y));
}

/** The closest pair among named colours (CIEDE2000), and its OKLab distance and hue gap. */
export function closestPair(colors: readonly { name: string; rgb: Srgb }[]): { pair: [string, string]; deltaE: number; oklab: number; hueGap: number } {
	let best: { pair: [string, string]; deltaE: number; oklab: number; hueGap: number } | null = null;
	for (let i = 0; i < colors.length; i++) {
		for (let j = i + 1; j < colors.length; j++) {
			const a = colors[i];
			const b = colors[j];
			if (!a || !b) continue;
			const d = deltaE(a.rgb, b.rgb);
			if (best === null || d < best.deltaE) {
				const ha = oklch(a.rgb).h;
				const hb = oklch(b.rgb).h;
				const gap = Math.abs(ha - hb) % 360;
				best = { pair: [a.name, b.name], deltaE: d, oklab: oklabDistance(a.rgb, b.rgb), hueGap: Math.min(gap, 360 - gap) };
			}
		}
	}
	if (best === null) throw new Error('need at least two colours');
	return best;
}
