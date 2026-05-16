import { Waifu2x } from './waifu2x';

let waifu2x: Waifu2x;

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    try {
        switch (msg.type) {
            case 'init': {
                waifu2x = new Waifu2x();
                await waifu2x.init(msg.baseUrl);
                self.postMessage({ type: 'initDone' });
                break;
            }
            case 'loadModel': {
                await waifu2x.loadModel(msg.url, ratio => {
                    self.postMessage({ type: 'modelProgress', ratio });
                });
                self.postMessage({ type: 'modelDone' });
                break;
            }
            case 'process': {
                const result = waifu2x.process(msg.bitmap as ImageBitmap, ratio => {
                    self.postMessage({ type: 'progress', ratio });
                });
                const bitmap = result.canvas.transferToImageBitmap();
                self.postMessage(
                    { type: 'done', bitmap, timing: result.timing },
                    [bitmap] as any,
                );
                break;
            }
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: (err as Error).message });
    }
};
