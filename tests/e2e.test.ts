// End-to-end tests of the built site: image input paths, the upscale result, and cancel.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { FIXTURES, launch, serveBuild } from './harness.ts';
import type { Site } from './harness.ts';

// Software WebGL2 needs seconds for each tile.
const UPSCALE_TIMEOUT = 240_000;
const TOLERANCE = 2;

let site: Site;
let browser: Browser;

before(async () => {
	site = await serveBuild();
	browser = await launch();
});

after(async () => {
	await browser?.close();
	await site?.close();
});

const fixture = async (name: string) => (await readFile(join(FIXTURES, name))).toString('base64');

// Opens a fresh page, runs the body, and fails on any page error or console error.
async function withApp(body: (page: Page) => Promise<void>): Promise<void> {
	const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
	page.on('console', msg => {
		if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
	});
	try {
		await page.goto(site.url);
		await waitForStatus(page, /^Ready\. /);
		await body(page);
		assert.deepEqual(errors, []);
	} finally {
		await context.close();
	}
}

async function waitForStatus(page: Page, pattern: RegExp, timeout = 30_000): Promise<void> {
	const handle = await page.waitForFunction(source => {
		const text = document.getElementById('status-text')!.textContent ?? '';
		return new RegExp(source).test(text) || /^Error|failed/.test(text) ? text : false;
	}, pattern.source, { timeout });
	assert.match(await handle.jsonValue() as string, pattern);
}

async function upscale(page: Page): Promise<void> {
	await page.click('#process-btn');
	await waitForStatus(page, /^Done in /, UPSCALE_TIMEOUT);
	await page.waitForFunction(() => {
		const img = document.getElementById('after-img') as HTMLImageElement;
		return img.complete && img.naturalWidth > 0;
	});
	assert.equal(await page.isVisible('#preview-section'), true);
	assert.equal(await page.isVisible('#download-btn'), true);
}

interface Comparison {
	width: number;
	height: number;
	maxDiff: number;
	corner: number[];
	centre: number[];
}

// Compares the result to a reference PNG. Colour is weighted by alpha, because a
// canvas does not keep the colour of a transparent pixel.
async function compareResult(page: Page, name: string): Promise<Comparison> {
	if (process.env.UPDATE_FIXTURES) {
		const png = await page.evaluate(() => {
			const img = document.getElementById('after-img') as HTMLImageElement;
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			canvas.getContext('2d')!.drawImage(img, 0, 0);
			return canvas.toDataURL('image/png').split(',')[1];
		});
		await writeFile(join(FIXTURES, name), Buffer.from(png, 'base64'));
	}

	return page.evaluate(async base64 => {
		const read = (source: HTMLImageElement | ImageBitmap, w: number, h: number) => {
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d')!;
			ctx.drawImage(source, 0, 0);
			return ctx.getImageData(0, 0, w, h).data;
		};
		const img = document.getElementById('after-img') as HTMLImageElement;
		const width = img.naturalWidth;
		const height = img.naturalHeight;
		const got = read(img, width, height);
		const pixel = (x: number, y: number) => [...got.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];

		const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
		const reference = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
		let maxDiff = 255;
		if (reference.width === width && reference.height === height) {
			const want = read(reference, width, height);
			maxDiff = 0;
			for (let i = 0; i < got.length; i += 4) {
				maxDiff = Math.max(maxDiff, Math.abs(got[i + 3] - want[i + 3]));
				for (let c = 0; c < 3; c++) {
					const diff = Math.abs(got[i + c] * got[i + 3] - want[i + c] * want[i + 3]) / 255;
					maxDiff = Math.max(maxDiff, diff);
				}
			}
		}
		return { width, height, maxDiff, corner: pixel(0, 0), centre: pixel(width >> 1, height >> 1) };
	}, await fixture(name));
}

test('Ctrl+V pastes a clipboard image, and the upscale matches the reference', async () => {
	await withApp(async page => {
		await page.evaluate(async base64 => {
			const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
			const blob = new Blob([bytes], { type: 'image/png' });
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
		}, await fixture('input.png'));
		await page.keyboard.press('Control+V');

		await waitForStatus(page, /^Pasted image\.png\. Ready to upscale\.$/);
		assert.equal(await page.textContent('#dim-info'), '150 x 130 -> 300 x 260');

		await upscale(page);
		const result = await compareResult(page, 'input-2x.png');
		assert.deepEqual([result.width, result.height], [300, 260]);
		assert.ok(result.maxDiff <= TOLERANCE, `largest channel difference is ${result.maxDiff}`);
	});
});

test('a paste with no image says so and loads nothing', async () => {
	await withApp(async page => {
		await page.evaluate(() => navigator.clipboard.writeText('not an image'));
		await page.keyboard.press('Control+V');

		await waitForStatus(page, /^The clipboard holds no image\.$/);
		assert.equal(await page.isDisabled('#process-btn'), true);
	});
});

test('a drop anywhere on the page loads an image file and refuses another file type', async () => {
	await withApp(async page => {
		const drop = (name: string, type: string, base64: string) => page.evaluate(file => {
			const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], file.name, { type: file.type }));
			document.body.dispatchEvent(
				new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
		}, { name, type, base64 });

		await drop('notes.txt', 'text/plain', Buffer.from('text').toString('base64'));
		await waitForStatus(page, /^notes\.txt is not an image\.$/);
		assert.equal(await page.isDisabled('#process-btn'), true);

		await drop('dropped.png', 'image/png', await fixture('input.png'));
		await waitForStatus(page, /^Loaded dropped\.png\. Ready to upscale\.$/);
		assert.equal(await page.isDisabled('#process-btn'), false);
	});
});

test('the file picker loads an image, and the upscale keeps transparency', async () => {
	await withApp(async page => {
		await page.setInputFiles('#file-input', join(FIXTURES, 'input-alpha.png'));
		await waitForStatus(page, /^Loaded input-alpha\.png\. Ready to upscale\.$/);

		await upscale(page);
		const result = await compareResult(page, 'input-alpha-2x.png');
		assert.deepEqual([result.width, result.height], [180, 140]);
		assert.equal(result.corner[3], 0, 'the corner of the fixture is transparent');
		assert.equal(result.centre[3], 255, 'the centre of the fixture is opaque');
		assert.ok(result.maxDiff <= TOLERANCE, `largest channel difference is ${result.maxDiff}`);
	});
});

test('Cancel stops an upscale, and the next upscale completes', async () => {
	await withApp(async page => {
		await page.setInputFiles('#file-input', join(FIXTURES, 'input.png'));
		await waitForStatus(page, /^Loaded input\.png\. Ready to upscale\.$/);

		await page.click('#process-btn');
		await page.click('#cancel-btn');
		await waitForStatus(page, /^Cancelled\.$/);
		assert.equal(await page.isVisible('#cancel-btn'), false);
		assert.equal(await page.isVisible('#preview-section'), false);

		await upscale(page);
	});
});

test('a new image during an upscale replaces that upscale', async () => {
	await withApp(async page => {
		await page.setInputFiles('#file-input', join(FIXTURES, 'input.png'));
		await waitForStatus(page, /^Loaded input\.png\. Ready to upscale\.$/);
		await page.click('#process-btn');
		await waitForStatus(page, /^Upscaling/);

		await page.setInputFiles('#file-input', join(FIXTURES, 'input-alpha.png'));
		await waitForStatus(page, /^Loaded input-alpha\.png\. Ready to upscale\.$/);
		assert.equal(await page.isVisible('#cancel-btn'), false);
		assert.equal(await page.isDisabled('#process-btn'), false);

		await upscale(page);
		assert.equal(await page.textContent('#status-text').then(text => /^Done in /.test(text ?? '')), true);
		const size = await page.evaluate(() => {
			const img = document.getElementById('after-img') as HTMLImageElement;
			return [img.naturalWidth, img.naturalHeight];
		});
		assert.deepEqual(size, [180, 140]);
	});
});
