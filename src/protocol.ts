export interface TimingData {
    totalMs: number;
    prepareMs: number;
    tileCount: number;
    tileExtractMs: number;
    uploadMs: number;
    convLayerMs: number[];
    deconvMs: number;
    readbackMs: number;
    encodeMs: number;
}

export type Request =
    | { type: 'loadModel'; url: string }
    | { type: 'process'; bitmap: ImageBitmap; modelUrl: string };

export interface ProcessResult {
    blob: Blob;
    width: number;
    height: number;
    timing: TimingData;
}

export type ProgressStage = 'model' | 'tiles';

export type Reply =
    | { id: number; type: 'progress'; stage: ProgressStage; ratio: number }
    | { id: number; type: 'done'; result?: ProcessResult }
    | { id: number; type: 'error'; message: string };
