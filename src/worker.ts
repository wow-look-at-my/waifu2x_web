// worker.ts holds queue.

import { Waifu2x } from './waifu2x';

import type { ProcessResult, ProgressStage, Reply, Request } from './protocol';

let waifu2x: Waifu2x | undefined;
const reply = (msg: Reply) => self.postMessage(msg);

async function handle(id: number, msg: Request): Promise<ProcessResult | undefined> {
    waifu2x ??= new Waifu2x();
    const progress = (stage: ProgressStage) =>
        (ratio: number) => reply({ id, type: 'progress', stage, ratio });

    if (msg.type === 'loadModel') {
        await waifu2x.loadModel(msg.url, progress('model'));
        return undefined;
    }

    await waifu2x.loadModel(msg.modelUrl, progress('model'));
    const { pixels, width, height, timing } = waifu2x.process(msg.bitmap, msg.modelUrl, progress('tiles'));
    msg.bitmap.close();

    const encodeStart = performance.now();
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    timing.encodeMs = performance.now() - encodeStart;
    timing.totalMs += timing.encodeMs;
    return { blob, width, height, timing };
}

// A chain keeps requests in order across the awaits inside each.
let queue = Promise.resolve();
self.onmessage = (e: MessageEvent<Request & { id: number }>) => {
    const msg = e.data;
    queue = queue.then(async () => {
        try {
            reply({ id: msg.id, type: 'done', result: await handle(msg.id, msg) });
        } catch (err) {
            reply({ id: msg.id, type: 'error', message: (err as Error).message });
        }
    });
};
