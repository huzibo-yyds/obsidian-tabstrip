/**
 * The sandbox renders at a fixed device scale factor (wdio.conf.mts, Chromium's
 * --force-device-scale-factor), not at the main display's. Normal runs: factor 2, so the pixel
 * checks (underline and divider paint) work on a 1x display too. Control run
 * (TABSTRIP_SANDBOX_SCALE=1 on a 2x display): the page reports 1 and the pixel checks refuse the
 * 1x screenshot. Together: the switch decides the scale, the display does not.
 */
import { browser, expect } from '@wdio/globals';
import { decodePng } from '../png';
import { dividerPaint, makeGroup, openNotes } from '../helpers';

const factor = Number(process.env.TABSTRIP_SANDBOX_SCALE ?? '2');

describe('Sandbox device scale factor', function () {
	it('the page and its screenshots use the forced factor; the 1x guard of the pixel checks holds', async function () {
		const ids = await openNotes(['n1', 'n2']);
		await makeGroup([ids.n1], 'Scale', 'blue');
		const page = await browser.execute(() => ({ dpr: window.devicePixelRatio, innerWidth: window.innerWidth }));
		const png = decodePng(Buffer.from(await browser.takeScreenshot(), 'base64'));
		console.log(`[e2e] scale: forced ${String(factor)}, devicePixelRatio ${String(page.dpr)}, screenshot ${String(png.width)} px for ${String(page.innerWidth)} CSS px`);
		expect(page.dpr).toBe(factor);
		expect(png.width).toBe(page.innerWidth * factor);
		if (factor < 2) {
			await expect(dividerPaint('scale-control')).rejects.toThrow(/needs a 2x screenshot/);
		} else {
			const paint = await dividerPaint('scale-check');
			expect(paint.scale).toBe(2);
		}
	});
});
