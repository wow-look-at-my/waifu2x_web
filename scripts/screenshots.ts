// Pastes an image into the built site with Ctrl+V, upscales it, and saves a screenshot of each step.

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES, launch, serveBuild } from '../tests/harness.ts';

const [outDir = 'screenshots', input = join(FIXTURES, 'input.png')] = process.argv.slice(2);
await mkdir(outDir, { recursive: true });

const site = await serveBuild();
const browser = await launch();
try {
	const context = await browser.newContext({
		viewport: { width: 900, height: 620 },
		deviceScaleFactor: 2,
		permissions: ['clipboard-read', 'clipboard-write'],
	});
	const page = await context.newPage();
	const status = (prefix: string, timeout = 30_000) => page.waitForFunction(
		start => document.getElementById('status-text')!.textContent!.startsWith(start), prefix, { timeout });

	await page.goto(site.url);
	await status('Ready');
	await page.screenshot({ path: join(outDir, '1-ready.png') });

	await page.evaluate(async base64 => {
		const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
		const blob = new Blob([bytes], { type: 'image/png' });
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
	}, (await readFile(input)).toString('base64'));
	await page.keyboard.press('Control+V');
	await status('Pasted');
	await page.screenshot({ path: join(outDir, '2-pasted.png') });

	await page.click('#process-btn');
	await status('Done', 600_000);
	await page.waitForFunction(() => {
		const img = document.getElementById('after-img') as HTMLImageElement;
		return img.complete && img.naturalWidth > 0;
	});
	await page.screenshot({ path: join(outDir, '3-upscaled.png'), fullPage: true });
	console.log(`wrote ${outDir}/1-ready.png, 2-pasted.png, 3-upscaled.png`);
} finally {
	await browser.close();
	await site.close();
}
