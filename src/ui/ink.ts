/**
 * Chooses the chip text colour per window and group colour from the computed fill.
 *
 * The fill is derived from `var(--color-…)` of the active theme (styles.css), so it is measured: a few hidden probe
 * elements (one per colour) are added to the window's body, read with getComputedStyle,
 * and removed again in the same task. Results are cached until the CSS changes.
 *
 * A pop-out window gets its stylesheets after it opens (the first one in a session can take
 * about 100 ms). A measurement taken before they apply would read a transparent fill and pick
 * the wrong ink for good, so such a window is not cached: inkFor returns null (the stylesheet's
 * fallback text colour shows meanwhile) and takePending() tells the caller to look again soon.
 *
 * The computed fill may be in any CSS colour space (a theme that defines its colours in oklch
 * computes to `oklch(…)`): parseCssColor converts the spaces Chromium returns, and anything it
 * does not know is painted on a 1×1 canvas of the window and read back as sRGB. The ink is
 * always chosen from the converted fill; a fill that cannot be read at all gets no ink (the
 * stylesheet's fallback), never a guessed one.
 */
import { GROUP_COLORS, type GroupColor } from '../core/types';
import { over, parseCssColor, pickInk, type Ink, type Rgb } from './color';

const WHITE: Rgb = { r: 255, g: 255, b: 255, a: 1 };

/** Custom property the stylesheet sets from the group colour (styles.css). */
const GROUP_COLOR_PROP = '--tabstrip-group-color';

/** A stylesheet link of this document that has not loaded yet. */
function stylesheetsLoading(doc: Document): boolean {
	return Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some((link) => !link.disabled && link.sheet === null);
}

/**
 * A computed colour as sRGB: parsed when it is a form parseCssColor knows, otherwise painted
 * on a 1×1 canvas of this window and read back (the canvas is sRGB). Null when neither works.
 */
export function readColor(doc: Document, value: string): Rgb | null {
	return parseCssColor(value) ?? paintedColor(doc, value);
}

function paintedColor(doc: Document, value: string): Rgb | null {
	const canvas = doc.createElement('canvas') as Partial<HTMLCanvasElement>;
	if (typeof canvas.getContext !== 'function') return null;
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (ctx === null) return null;
	// An assignment the canvas cannot parse is ignored: check against two different starting values.
	ctx.fillStyle = '#000000';
	ctx.fillStyle = value;
	const fromBlack = ctx.fillStyle;
	ctx.fillStyle = '#ffffff';
	ctx.fillStyle = value;
	if (ctx.fillStyle !== fromBlack) return null;
	ctx.clearRect(0, 0, 1, 1);
	ctx.fillRect(0, 0, 1, 1);
	const d = ctx.getImageData(0, 0, 1, 1).data;
	const a = (d[3] ?? 0) / 255;
	return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0, a };
}

/** Measurements kept in InkCache.measureMs. */
const MEASURE_LIMIT = 200;

export class InkCache {
	/** Plugin time of each measurement (probes and style reads), ms, newest last (diagnostics). */
	readonly measureMs: number[] = [];
	private cache = new WeakMap<Document, Map<GroupColor, Ink>>();
	/** Windows found not ready since the last takePending() (measured once per pass). */
	private notReady = new WeakSet<Document>();
	private pending = false;

	/**
	 * Ink for chip text of this colour in this window, or null while the window's styles are
	 * not ready (or the window is gone, or its fill could not be read in any way).
	 */
	inkFor(doc: Document, color: GroupColor): Ink | null {
		let inks = this.cache.get(doc);
		if (inks === undefined) {
			if (this.notReady.has(doc)) return null;
			const started = performance.now();
			const measured = this.measure(doc);
			this.measureMs.push(performance.now() - started);
			if (this.measureMs.length > MEASURE_LIMIT) this.measureMs.splice(0, this.measureMs.length - MEASURE_LIMIT);
			if (measured === 'gone') return null;
			if (measured === 'not-ready') {
				this.notReady.add(doc);
				this.pending = true;
				return null;
			}
			inks = measured;
			this.cache.set(doc, inks);
		}
		return inks.get(color) ?? null;
	}

	/** True when some window was not ready since the last call; ends the current pass. */
	takePending(): boolean {
		const pending = this.pending;
		this.pending = false;
		this.notReady = new WeakSet();
		return pending;
	}

	/** Forget everything (theme or light/dark mode changed). */
	clear(): void {
		this.cache = new WeakMap();
	}

	private measure(doc: Document): Map<GroupColor, Ink> | 'not-ready' | 'gone' {
		const inks = new Map<GroupColor, Ink>();
		const win = doc.defaultView;
		const body = doc.body as HTMLElement | null;
		if (win === null || body === null) return 'gone';
		if (stylesheetsLoading(doc)) return 'not-ready';
		const backdrop = readColor(doc, win.getComputedStyle(body).backgroundColor) ?? WHITE;
		const opaqueBackdrop = backdrop.a < 1 ? over(backdrop, WHITE) : backdrop;
		const probes = GROUP_COLORS.map((color) => {
			const probe = doc.createElement('div');
			probe.className = 'tabstrip-color-probe';
			probe.setAttribute('data-tabstrip-color', color);
			body.appendChild(probe);
			return { color, probe };
		});
		let ready = true;
		for (const { color, probe } of probes) {
			const style = win.getComputedStyle(probe);
			// Without Obsidian's colour variables (or this plugin's stylesheet) the property is empty.
			if (style.getPropertyValue(GROUP_COLOR_PROP).trim() === '') {
				ready = false;
				break;
			}
			const fill = readColor(doc, style.backgroundColor);
			if (fill !== null) inks.set(color, pickInk(fill.a < 1 ? over(fill, opaqueBackdrop) : fill));
		}
		for (const { probe } of probes) probe.remove();
		return ready ? inks : 'not-ready';
	}
}
