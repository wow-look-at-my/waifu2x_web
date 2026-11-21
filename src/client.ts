import type { ProcessResult, ProgressStage, Reply, Request } from './protocol';

type OnProgress = (stage: ProgressStage, ratio: number) => void;

interface Pending {
    resolve: (result: ProcessResult | undefined) => void;
    reject: (err: Error) => void;
    onProgress?: OnProgress;
}

export class CancelledError extends Error {
    constructor() {
        super('Cancelled');
    }
}

export class EngineClient {
    private worker!: Worker;
    private nextId = 0;
    private pending = new Map<number, Pending>();

    constructor(private workerUrl: string) {
        this.spawn();
    }

    loadModel(url: string, onProgress?: OnProgress): Promise<void> {
        return this.request({ type: 'loadModel', url }, [], onProgress).then(() => undefined);
    }

    async process(bitmap: ImageBitmap, modelUrl: string, onProgress?: OnProgress): Promise<ProcessResult> {
        const result = await this.request({ type: 'process', bitmap, modelUrl }, [bitmap], onProgress);
        if (!result) throw new Error('The worker returned no result');
        return result;
    }

    // An upscale is one long synchronous loop, so only a new worker can stop it.
    restart(): void {
        this.worker.terminate();
        this.failAll(new CancelledError());
        this.spawn();
    }

    private spawn(): void {
        this.worker = new Worker(this.workerUrl);
        this.worker.onmessage = (e: MessageEvent<Reply>) => {
            const msg = e.data;
            const entry = this.pending.get(msg.id);
            if (!entry) return;
            if (msg.type === 'progress') {
                entry.onProgress?.(msg.stage, msg.ratio);
                return;
            }
            this.pending.delete(msg.id);
            if (msg.type === 'error') entry.reject(new Error(msg.message));
            else entry.resolve(msg.result);
        };
        this.worker.onerror = e => {
            this.failAll(new Error(e.message || 'The worker script failed to load'));
        };
    }

    private failAll(err: Error): void {
        const entries = [...this.pending.values()];
        this.pending.clear();
        for (const entry of entries) entry.reject(err);
    }

    private request(msg: Request, transfer: Transferable[], onProgress?: OnProgress) {
        return new Promise<ProcessResult | undefined>((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject, onProgress });
            this.worker.postMessage({ ...msg, id }, transfer);
        });
    }
}
