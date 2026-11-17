/**
 * Just enough PNG reading to check what the sandbox window actually painted: WebDriver's
 * screenshots are 8-bit RGB or RGBA, not interlaced. Node built-ins only (no new dependency).
 */
import { inflateSync } from 'node:zlib';

export interface Image {
	width: number;
	height: number;
	/** 3 (RGB) or 4 (RGBA) samples per pixel. */
	channels: number;
	/** Unfiltered samples, row by row. */
	data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(buf: Uint8Array): Image {
	const bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	SIGNATURE.forEach((b, i) => {
		if (bytes[i] !== b) throw new Error('not a PNG file');
	});
	let pos = 8;
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = -1;
	let interlace = 0;
	const idat: Buffer[] = [];
	while (pos + 8 <= bytes.length) {
		const len = bytes.readUInt32BE(pos);
		const type = bytes.toString('latin1', pos + 4, pos + 8);
		const body = bytes.subarray(pos + 8, pos + 8 + len);
		if (type === 'IHDR') {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8] ?? 0;
			colorType = body[9] ?? -1;
			interlace = body[12] ?? 0;
		} else if (type === 'IDAT') {
			idat.push(body);
		} else if (type === 'IEND') {
			break;
		}
		pos += 12 + len;
	}
	if (depth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
		throw new Error(`unsupported PNG: bit depth ${String(depth)}, colour type ${String(colorType)}, interlace ${String(interlace)}`);
	}
	const channels = colorType === 6 ? 4 : 3;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	if (raw.length < (stride + 1) * height) throw new Error('PNG image data is too short');
	const data = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)] ?? 0;
		const src = y * (stride + 1) + 1;
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? (data[row + x - channels] ?? 0) : 0;
			const b = y > 0 ? (data[row - stride + x] ?? 0) : 0;
			const c = y > 0 && x >= channels ? (data[row - stride + x - channels] ?? 0) : 0;
			let v = raw[src + x] ?? 0;
			switch (filter) {
				case 0:
					break;
				case 1:
					v += a;
					break;
				case 2:
					v += b;
					break;
				case 3:
					v += (a + b) >> 1;
					break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
					break;
				}
				default:
					throw new Error(`unknown PNG filter ${String(filter)} in row ${String(y)}`);
			}
			data[row + x] = v & 255;
		}
	}
	return { width, height, channels, data };
}

export type Rgb = [number, number, number];

export function pixelAt(img: Image, x: number, y: number): Rgb {
	if (x < 0 || y < 0 || x >= img.width || y >= img.height) throw new Error(`pixel ${String(x)},${String(y)} is outside the image`);
	const i = (y * img.width + x) * img.channels;
	return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

/** Largest difference over the three channels. */
export function colorDistance(a: Rgb, b: Rgb): number {
	return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

export interface BandScan {
	/** Columns looked at (device pixels). */
	columns: number;
	/** Runs of columns where some sampled row is not the expected colour, in device pixels (inclusive). */
	misses: { from: number; to: number }[];
	/** Largest channel difference among the pixels that matched. */
	maxMatchedDistance: number;
	/** First pixel that did not match, for the failure message. */
	firstMiss: { x: number; y: number; rgb: Rgb } | null;
}

/**
 * Looks at every column from x0 to x1 (device pixels, inclusive) in the given rows and reports
 * where the colour is not `rgb` (within `tolerance` per channel).
 */
export function scanBand(img: Image, x0: number, x1: number, rows: readonly number[], rgb: Rgb, tolerance: number): BandScan {
	const misses: { from: number; to: number }[] = [];
	let maxMatchedDistance = 0;
	let firstMiss: BandScan['firstMiss'] = null;
	for (let x = x0; x <= x1; x++) {
		let miss = false;
		for (const y of rows) {
			const px = pixelAt(img, x, y);
			const d = colorDistance(px, rgb);
			if (d > tolerance) {
				miss = true;
				firstMiss ??= { x, y, rgb: px };
			} else {
				maxMatchedDistance = Math.max(maxMatchedDistance, d);
			}
		}
		if (!miss) continue;
		const last = misses[misses.length - 1];
		if (last !== undefined && last.to === x - 1) last.to = x;
		else misses.push({ from: x, to: x });
	}
	return { columns: Math.max(0, x1 - x0 + 1), misses, maxMatchedDistance, firstMiss };
}

/** Device rows that lie fully inside the CSS band [top, bottom) (no row only partly covered). */
export function innerRows(top: number, bottom: number, scale: number): number[] {
	const first = Math.ceil(top * scale - 0.01);
	const last = Math.floor(bottom * scale + 0.01) - 1;
	const rows: number[] = [];
	for (let y = first; y <= last; y++) rows.push(y);
	return rows;
}
