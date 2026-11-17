/**
 * Pure colour helpers for the chip text ("ink").
 *
 * The chip fill is the group colour mapped to an Obsidian colour variable (requirements
 * 7.2) and made darker or lighter with color-mix() (styles.css), so it changes with the theme
 * and light or dark mode. The ink is chosen from the computed fill so that the text keeps a
 * WCAG contrast of at least 4.5:1.
 */

export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	/** 0..1 */
	readonly a: number;
}

/** Text colours the stylesheet knows (styles.css, `data-tabstrip-ink`). */
export const INKS = {
	light: { r: 255, g: 255, b: 255, a: 1 },
	dark: { r: 32, g: 33, b: 36, a: 1 },
	black: { r: 0, g: 0, b: 0, a: 1 },
} as const satisfies Record<string, Rgb>;

export type Ink = keyof typeof INKS;

/** WCAG 2.x minimum contrast for normal text. */
export const MIN_CONTRAST = 4.5;

function clamp255(n: number): number {
	return Math.min(255, Math.max(0, n));
}

/** An rgb() channel: 0..255 or a percentage. */
function channel(token: string): number | null {
	const t = token.trim();
	if (t.length === 0) return null;
	if (t === 'none') return 0;
	if (t.endsWith('%')) {
		const n = Number(t.slice(0, -1));
		return Number.isFinite(n) ? clamp255((n / 100) * 255) : null;
	}
	const n = Number(t);
	if (!Number.isFinite(n)) return null;
	return clamp255(n);
}

function alpha(token: string | undefined): number | null {
	if (token === undefined) return 1;
	const t = token.trim();
	if (t.endsWith('%')) {
		const n = Number(t.slice(0, -1));
		return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : null;
	}
	const n = Number(t);
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/**
 * Parses the colour formats a computed style returns in Chromium: hex (`#rgb`, `#rrggbb`,
 * `#rrggbbaa`), `rgb()`/`rgba()` (comma or space syntax), and the CSS Color 4 forms that
 * Chromium (111 and later) keeps in their own colour space: `oklab()`, `oklch()`, `lab()`,
 * `lch()` and `color(<space> …)` for srgb, srgb-linear, display-p3, a98-rgb, prophoto-rgb,
 * rec2020, xyz, xyz-d50 and xyz-d65. A theme that defines `--color-*` in oklch (Cupertino's
 * greys) computes to `oklch(…)`, and so does `color-mix()` in those spaces.
 *
 * The result is sRGB on 0..255 channels. A colour outside the sRGB gamut is clipped into it,
 * which keeps its luminance close enough for a contrast decision.
 */
export function parseCssColor(value: string): Rgb | null {
	const v = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,8})$/.exec(v);
	if (hex) {
		const h = hex[1] ?? '';
		if (h.length === 3 || h.length === 4) {
			const d = [0, 1, 2, 3].slice(0, h.length).map((i) => parseInt(h.charAt(i).repeat(2), 16));
			return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: h.length === 4 ? (d[3] ?? 255) / 255 : 1 };
		}
		if (h.length === 6 || h.length === 8) {
			const d = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
			return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a: h.length === 8 ? (d[3] ?? 255) / 255 : 1 };
		}
		return null;
	}
	const fn = /^(rgba?|color|oklab|oklch|lab|lch)\((.*)\)$/.exec(v);
	if (!fn) return null;
	const kind = fn[1] ?? '';
	const body = fn[2] ?? '';
	if (kind === 'rgb' || kind === 'rgba') return parseRgb(body);
	if (kind === 'color') return parseColorFunction(body);
	return parseLabLike(kind, body);
}

function parseRgb(body: string): Rgb | null {
	const [main, slashAlpha] = body.split('/');
	const parts = (main ?? '').includes(',') ? (main ?? '').split(',') : (main ?? '').trim().split(/\s+/);
	if (parts.length < 3 || parts.length > 4) return null;
	const r = channel(parts[0] ?? '');
	const g = channel(parts[1] ?? '');
	const b = channel(parts[2] ?? '');
	const a = alpha(parts.length === 4 ? parts[3] : slashAlpha);
	if (r === null || g === null || b === null || a === null) return null;
	return { r, g, b, a };
}

/** Space-separated components with an optional `/ alpha`: three numbers (`none` is 0) and the alpha. */
function components(body: string): { c: [string, string, string]; a: number } | null {
	const parts = body.split('/');
	if (parts.length > 2) return null;
	const c = (parts[0] ?? '').trim().split(/\s+/);
	if (c.length !== 3) return null;
	const a = alpha(parts.length === 2 ? (parts[1] === undefined || parts[1].trim() === 'none' ? '0' : parts[1]) : undefined);
	if (a === null) return null;
	return { c: [c[0] ?? '', c[1] ?? '', c[2] ?? ''], a };
}

/** A number, or a percentage of `percentOf`; `none` is 0. */
function num(token: string, percentOf: number): number | null {
	const t = token.trim();
	if (t === 'none') return 0;
	const n = t.endsWith('%') ? (Number(t.slice(0, -1)) / 100) * percentOf : Number(t);
	return Number.isFinite(n) ? n : null;
}

/** A hue in degrees (bare number, deg, rad, grad or turn); `none` is 0. */
function hue(token: string): number | null {
	const t = token.trim();
	if (t === 'none') return 0;
	const unit = /^(-?[\d.e+-]+)(deg|rad|grad|turn)?$/.exec(t);
	if (!unit) return null;
	const n = Number(unit[1]);
	if (!Number.isFinite(n)) return null;
	switch (unit[2]) {
		case 'rad':
			return (n * 180) / Math.PI;
		case 'grad':
			return n * 0.9;
		case 'turn':
			return n * 360;
		default:
			return n;
	}
}

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

function mul(m: Mat3, v: Vec3): Vec3 {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

// Matrices from CSS Color 4 (section 18, "Sample code for color conversions").
const XYZ_D65_TO_LINEAR_SRGB: Mat3 = [
	[3.2409699419045226, -1.537383177570094, -0.4986107602930034],
	[-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
	[0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_TO_D65: Mat3 = [
	[0.955473421488075, -0.02309845494876471, 0.06325924320057072],
	[-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
	[0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const LINEAR_P3_TO_XYZ_D65: Mat3 = [
	[0.48657094864821626, 0.26566769316909294, 0.1982172852343625],
	[0.2289745640697487, 0.6917385218365062, 0.079286914093745],
	[0, 0.04511338185890257, 1.043944368900976],
];
const LINEAR_A98_TO_XYZ_D65: Mat3 = [
	[0.5766690429101308, 0.18555823790654627, 0.18822864623499472],
	[0.29734497525053616, 0.627363566255466, 0.07529145849399789],
	[0.027031361386412378, 0.07068885253582714, 0.9913375368376389],
];
const LINEAR_PROPHOTO_TO_XYZ_D50: Mat3 = [
	[0.7977666449006423, 0.13518129740053308, 0.0313477341283922],
	[0.2880748288194013, 0.711835234241873, 0.00008993693872564],
	[0, 0, 0.8251046025104602],
];
const LINEAR_REC2020_TO_XYZ_D65: Mat3 = [
	[0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
	[0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
	[0, 0.028072693049087428, 1.060985057710791],
];
const D50_WHITE: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];

const signed = (c: number, f: (x: number) => number) => (c < 0 ? -f(-c) : f(c));
const srgbToLinear = (c: number) => signed(c, (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
const linearToSrgb = (c: number) => signed(c, (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));

/** Linear sRGB (0..1) to sRGB 0..255, clipped into the gamut. */
function fromLinearSrgb(v: Vec3, a: number): Rgb {
	const ch = (c: number) => clamp255(linearToSrgb(Math.min(1, Math.max(0, c))) * 255);
	return { r: ch(v[0]), g: ch(v[1]), b: ch(v[2]), a };
}

const fromXyzD65 = (xyz: Vec3, a: number) => fromLinearSrgb(mul(XYZ_D65_TO_LINEAR_SRGB, xyz), a);

function parseColorFunction(body: string): Rgb | null {
	const m = /^\s*([a-z0-9-]+)\s+(.*)$/.exec(body);
	if (!m) return null;
	const space = m[1] ?? '';
	const parsed = components(m[2] ?? '');
	if (parsed === null) return null;
	const c0 = num(parsed.c[0], 1);
	const c1 = num(parsed.c[1], 1);
	const c2 = num(parsed.c[2], 1);
	if (c0 === null || c1 === null || c2 === null) return null;
	const v: Vec3 = [c0, c1, c2];
	const a = parsed.a;
	switch (space) {
		case 'srgb':
			return { r: clamp255(v[0] * 255), g: clamp255(v[1] * 255), b: clamp255(v[2] * 255), a };
		case 'srgb-linear':
			return fromLinearSrgb(v, a);
		case 'display-p3':
			return fromXyzD65(mul(LINEAR_P3_TO_XYZ_D65, [srgbToLinear(v[0]), srgbToLinear(v[1]), srgbToLinear(v[2])]), a);
		case 'a98-rgb': {
			const lin = (x: number) => signed(x, (y) => y ** (563 / 256));
			return fromXyzD65(mul(LINEAR_A98_TO_XYZ_D65, [lin(v[0]), lin(v[1]), lin(v[2])]), a);
		}
		case 'prophoto-rgb': {
			const lin = (x: number) => signed(x, (y) => (y <= 16 / 512 ? y / 16 : y ** 1.8));
			return fromXyzD65(mul(D50_TO_D65, mul(LINEAR_PROPHOTO_TO_XYZ_D50, [lin(v[0]), lin(v[1]), lin(v[2])])), a);
		}
		case 'rec2020': {
			const alpha2020 = 1.09929682680944;
			const beta = 0.018053968510807;
			const lin = (x: number) => signed(x, (y) => (y < beta * 4.5 ? y / 4.5 : ((y + alpha2020 - 1) / alpha2020) ** (1 / 0.45)));
			return fromXyzD65(mul(LINEAR_REC2020_TO_XYZ_D65, [lin(v[0]), lin(v[1]), lin(v[2])]), a);
		}
		case 'xyz':
		case 'xyz-d65':
			return fromXyzD65(v, a);
		case 'xyz-d50':
			return fromXyzD65(mul(D50_TO_D65, v), a);
		default:
			return null;
	}
}

/** CIE Lab (D50) to XYZ D65. */
function labToXyzD65(l: number, a: number, b: number): Vec3 {
	const kappa = 24389 / 27;
	const epsilon = 216 / 24389;
	const f1 = (l + 16) / 116;
	const f0 = a / 500 + f1;
	const f2 = f1 - b / 200;
	const x = f0 ** 3 > epsilon ? f0 ** 3 : (116 * f0 - 16) / kappa;
	const y = l > kappa * epsilon ? f1 ** 3 : l / kappa;
	const z = f2 ** 3 > epsilon ? f2 ** 3 : (116 * f2 - 16) / kappa;
	return mul(D50_TO_D65, [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]]);
}

/** OKLab to linear sRGB (Björn Ottosson's matrices, as in CSS Color 4). */
function oklabToLinearSrgb(l: number, a: number, b: number): Vec3 {
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
	];
}

function parseLabLike(kind: string, body: string): Rgb | null {
	const parsed = components(body);
	if (parsed === null) return null;
	const [t0, t1, t2] = parsed.c;
	const ok = kind === 'oklab' || kind === 'oklch';
	// Percentages: OKLab L 100% = 1, a/b 100% = 0.4, C 100% = 0.4; Lab L 100% = 100, a/b 100% = 125, C 100% = 150.
	const l = num(t0, ok ? 1 : 100);
	if (l === null) return null;
	let a: number | null;
	let b: number | null;
	if (kind === 'oklch' || kind === 'lch') {
		const c = num(t1, kind === 'oklch' ? 0.4 : 150);
		const h = hue(t2);
		if (c === null || h === null) return null;
		a = c * Math.cos((h * Math.PI) / 180);
		b = c * Math.sin((h * Math.PI) / 180);
	} else {
		a = num(t1, ok ? 0.4 : 125);
		b = num(t2, ok ? 0.4 : 125);
		if (a === null || b === null) return null;
	}
	return ok ? fromLinearSrgb(oklabToLinearSrgb(l, a, b), parsed.a) : fromXyzD65(labToXyzD65(l, a, b), parsed.a);
}

function linear(c255: number): number {
	const c = c255 / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: Rgb): number {
	return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/** Puts a translucent colour over an opaque backdrop. */
export function over(top: Rgb, backdrop: Rgb): Rgb {
	const a = top.a;
	return {
		r: top.r * a + backdrop.r * (1 - a),
		g: top.g * a + backdrop.g * (1 - a),
		b: top.b * a + backdrop.b * (1 - a),
		a: 1,
	};
}

export function contrast(a: Rgb, b: Rgb): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Ink for text on `fill`: white when it reaches 4.5:1 and reads better than the dark ink,
 * else the dark ink when that reaches 4.5:1, else whichever of white and pure black is
 * stronger (one of them always reaches 4.58:1 or more).
 */
export function pickInk(fill: Rgb): Ink {
	const cLight = contrast(INKS.light, fill);
	const cDark = contrast(INKS.dark, fill);
	if (cLight >= MIN_CONTRAST && cLight >= cDark) return 'light';
	if (cDark >= MIN_CONTRAST) return 'dark';
	if (cLight >= MIN_CONTRAST) return 'light';
	return contrast(INKS.black, fill) >= cLight ? 'black' : 'light';
}
