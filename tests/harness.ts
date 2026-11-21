// Serves the built site and opens it in headless Chromium with software WebGL2.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
export const FIXTURES = join(import.meta.dirname, 'fixtures');

const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.bin': 'application/octet-stream',
};

export interface Site {
	url: string;
	close(): Promise<void>;
}

export async function serveBuild(): Promise<Site> {
	const root = join(ROOT, 'build');
	if (!existsSync(join(root, 'index.html')))
		throw new Error('build/index.html is missing. Run `just build` first.');

	const server = createServer(async (req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
		const file = resolve(root, '.' + (path.endsWith('/') ? path + 'index.html' : path));
		if (!file.startsWith(root + sep)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const body = await readFile(file);
			res.writeHead(200, {
				'content-type': MIME[extname(file)] ?? 'application/octet-stream',
				'content-length': body.length,
			}).end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => new Promise(done => {
			server.closeAllConnections();
			server.close(() => done());
		}),
	};
}

export function launch(): Promise<Browser> {
	return chromium.launch({
		args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
	});
}
