import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { colorDistance, decodePng, innerRows, pixelAt, scanBand, type Image } from '../e2e/png';

/** Test-only PNG writer: 8-bit RGB or RGBA, each row with a different filter (0–4). */
function encodePng(img: Image): Buffer {
	const { width, height, channels, data } = img;
	const stride = width * channels;
	const rows: number[] = [];
	for (let y = 0; y < height; y++) {
		const filter = y % 5;
		rows.push(filter);
		for (let x = 0; x < stride; x++) {
			const at = (yy: number, xx: number) => (yy < 0 || xx < 0 ? 0 : (data[yy * stride + xx] ?? 0));
			const v = at(y, x);
			const a = at(y, x - channels);
			const b = at(y - 1, x);
			const c = at(y - 1, x - channels);
			let pred = 0;
			if (filter === 1) pred = a;
			else if (filter === 2) pred = b;
			else if (filter === 3) pred = (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			rows.push((v - pred) & 255);
		}
	}
	const chunk = (type: string, body: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(body.length);
		const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(typed));
		return Buffer.concat([len, typed, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 4 ? 6 : 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(Buffer.from(rows))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function noise(width: number, height: number, channels: number): Image {
	const data = new Uint8Array(width * height * channels);
	let seed = 7;
	for (let i = 0; i < data.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		data[i] = (seed >> 16) & 255;
	}
	return { width, height, channels, data };
}

describe('decodePng', () => {
	it.each([3, 4])('reads back every filter type with %i channels', (channels) => {
		const img = noise(13, 11, channels);
		const out = decodePng(encodePng(img));
		expect(out.width).toBe(13);
		expect(out.height).toBe(11);
		expect(out.channels).toBe(channels);
		expect(Array.from(out.data)).toEqual(Array.from(img.data));
	});

	it('rejects what it cannot read', () => {
		expect(() => decodePng(Buffer.from('not a png at all'))).toThrow('not a PNG');
		const png = encodePng(noise(2, 2, 3));
		png[8 + 8 + 8] = 16; // IHDR bit depth (signature, chunk length and type, width and height)
		expect(() => decodePng(png)).toThrow('unsupported PNG');
	});
});

describe('scanBand', () => {
	// 10 x 3 image: blue, except columns 4–6 of row 1, which are white.
	const blue = [8, 109, 221] as const;
	const data = new Uint8Array(10 * 3 * 3);
	for (let i = 0; i < 30; i++) data.set(blue, i * 3);
	for (const x of [4, 5, 6]) data.set([255, 255, 255], (10 + x) * 3);
	const img: Image = { width: 10, height: 3, channels: 3, data };

	it('reports runs of columns where a sampled row is not the colour', () => {
		const scan = scanBand(img, 0, 9, [0, 1, 2], [8, 109, 221], 4);
		expect(scan.columns).toBe(10);
		expect(scan.misses).toEqual([{ from: 4, to: 6 }]);
		expect(scan.firstMiss).toEqual({ x: 4, y: 1, rgb: [255, 255, 255] });
		expect(scan.maxMatchedDistance).toBe(0);
	});

	it('only looks at the given rows and columns, within the tolerance', () => {
		expect(scanBand(img, 0, 9, [0, 2], [8, 109, 221], 0).misses).toEqual([]);
		expect(scanBand(img, 7, 9, [1], [10, 105, 221], 4)).toMatchObject({ misses: [], maxMatchedDistance: 4 });
		expect(scanBand(img, 0, 9, [1], [10, 105, 221], 3).misses).toEqual([{ from: 0, to: 9 }]);
	});

	it('reads pixels and distances', () => {
		expect(pixelAt(img, 5, 1)).toEqual([255, 255, 255]);
		expect(() => pixelAt(img, 10, 0)).toThrow('outside');
		expect(colorDistance([1, 2, 3], [4, 2, 1])).toBe(3);
	});
});

describe('innerRows', () => {
	it('keeps the device rows that lie fully inside the band', () => {
		expect(innerRows(74, 76, 2)).toEqual([148, 149, 150, 151]);
		expect(innerRows(74, 76, 1)).toEqual([74, 75]);
		expect(innerRows(74.5, 76.5, 2)).toEqual([149, 150, 151, 152]);
		expect(innerRows(75.75, 77.75, 2)).toEqual([152, 153, 154]);
		expect(innerRows(74.2, 75.8, 1)).toEqual([]);
	});
});
