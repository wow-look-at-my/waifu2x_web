import type { TimingData } from './waifu2x';

const MODELS: Record<string, string> = {
    'none': 'models/scale2x.bin',
    '1': 'models/noise1-scale2x.bin',
    '2': 'models/noise2-scale2x.bin',
    '3': 'models/noise3-scale2x.bin',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dropZone = $<HTMLDivElement>('drop-zone');
const fileInput = $<HTMLInputElement>('file-input');
const noiseSelect = $<HTMLSelectElement>('noise-level');
const processBtn = $<HTMLButtonElement>('process-btn');
const downloadBtn = $<HTMLButtonElement>('download-btn');
const progressBar = $<HTMLDivElement>('progress-fill');
const progressSection = $<HTMLDivElement>('progress-section');
const statusText = $<HTMLDivElement>('status-text');
const previewSection = $<HTMLDivElement>('preview-section');
const beforeImg = $<HTMLImageElement>('before-img');
const afterImg = $<HTMLImageElement>('after-img');
const compSlider = $<HTMLInputElement>('comp-slider');
const afterWrap = $<HTMLDivElement>('after-wrap');
const modelProgress = $<HTMLDivElement>('model-progress-fill');
const initSection = $<HTMLDivElement>('init-section');
const controlsSection = $<HTMLDivElement>('controls-section');
const dimInfo = $<HTMLSpanElement>('dim-info');
const timingSection = $<HTMLDivElement>('timing-section');

const baseUrl = new URL('.', location.href).href;
const worker = new Worker('js/worker.js', { type: 'module' });

let loadedModelKey = '';
let sourceImage: HTMLImageElement | null = null;
let resultBlobUrl = '';

function rpc(msgType: string): Promise<void>;
function rpc(msgType: string, extra: Record<string, unknown>, transfer?: Transferable[]): Promise<any>;
function rpc(msgType: string, extra?: Record<string, unknown>, transfer?: Transferable[]): Promise<any> {
    return new Promise((resolve, reject) => {
        const prev = worker.onmessage;
        worker.onmessage = (e: MessageEvent) => {
            const msg = e.data;
            if (msg.type === 'error') {
                worker.onmessage = prev;
                reject(new Error(msg.message));
            } else if (msg.type === 'modelProgress') {
                modelProgress.style.width = `${(msg.ratio * 100).toFixed(0)}%`;
            } else if (msg.type === 'progress') {
                progressBar.style.width = `${(msg.ratio * 100).toFixed(0)}%`;
                const pct = (msg.ratio * 100).toFixed(0);
                statusText.textContent = `Upscaling... ${pct}%`;
            } else {
                worker.onmessage = prev;
                resolve(msg);
            }
        };
        worker.postMessage({ type: msgType, ...extra }, transfer ?? []);
    });
}

async function boot() {
    statusText.textContent = 'Initializing WebGL2...';
    try {
        await rpc('init', { baseUrl });
    } catch (e) {
        statusText.textContent = `Error: ${(e as Error).message}`;
        return;
    }

    await loadModelIfNeeded();

    initSection.hidden = true;
    controlsSection.hidden = false;
    statusText.textContent = 'Ready. Drop or select an image.';
}

async function loadModelIfNeeded(): Promise<boolean> {
    const key = noiseSelect.value;
    if (key === loadedModelKey) return true;

    const url = new URL(MODELS[key], baseUrl).href;
    statusText.textContent = 'Loading model...';
    initSection.hidden = false;
    modelProgress.style.width = '0%';

    try {
        await rpc('loadModel', { url });
        modelProgress.style.width = '100%';
        loadedModelKey = key;
        statusText.textContent = 'Model loaded.';
        return true;
    } catch (e) {
        statusText.textContent = `Model load failed: ${(e as Error).message}`;
        return false;
    }
}

function handleFile(file: File) {
    if (!file.type.startsWith('image/')) return;

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        sourceImage = img;
        beforeImg.src = url;
        dimInfo.textContent = `${img.width} x ${img.height} -> ${img.width * 2} x ${img.height * 2}`;
        processBtn.disabled = false;
        previewSection.hidden = true;
        downloadBtn.hidden = true;
        statusText.textContent = `Loaded ${file.name}. Ready to upscale.`;
    };
    img.src = url;
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
});
dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer?.files[0]) handleFile(e.dataTransfer.files[0]);
});

noiseSelect.addEventListener('change', async () => {
    initSection.hidden = false;
    await loadModelIfNeeded();
    initSection.hidden = true;
});

processBtn.addEventListener('click', async () => {
    if (!sourceImage) return;

    initSection.hidden = false;
    if (!await loadModelIfNeeded()) return;
    initSection.hidden = true;

    processBtn.disabled = true;
    progressSection.hidden = false;
    downloadBtn.hidden = true;
    previewSection.hidden = true;
    timingSection.hidden = true;
    progressBar.style.width = '0%';
    statusText.textContent = 'Upscaling...';

    try {
        const bitmap = await createImageBitmap(sourceImage);
        const result = await rpc('process', { bitmap }, [bitmap]);
        const timing: TimingData = result.timing;
        const resultBitmap: ImageBitmap = result.bitmap;

        const elapsed = (timing.totalMs / 1000).toFixed(1);
        statusText.textContent = `Done in ${elapsed}s.`;
        progressBar.style.width = '100%';

        timingSection.textContent = formatTiming(timing);
        timingSection.hidden = false;

        const resultCanvas = document.createElement('canvas');
        resultCanvas.width = resultBitmap.width;
        resultCanvas.height = resultBitmap.height;
        const ctx = resultCanvas.getContext('2d')!;
        ctx.drawImage(resultBitmap, 0, 0);
        resultBitmap.close();

        if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);

        resultCanvas.toBlob(blob => {
            if (!blob) return;
            resultBlobUrl = URL.createObjectURL(blob);
            afterImg.src = resultBlobUrl;
            previewSection.hidden = false;
            downloadBtn.hidden = false;
            compSlider.value = '100';
            afterWrap.style.clipPath = '';
        }, 'image/png');
    } catch (e) {
        statusText.textContent = `Error: ${(e as Error).message}`;
    }

    processBtn.disabled = false;
    progressSection.hidden = true;
});

downloadBtn.addEventListener('click', () => {
    if (!resultBlobUrl) return;
    const a = document.createElement('a');
    a.href = resultBlobUrl;
    a.download = 'waifu2x_upscaled.png';
    a.click();
});

compSlider.addEventListener('input', () => {
    const pct = parseInt(compSlider.value, 10);
    afterWrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
});

function formatTiming(t: TimingData): string {
    const fmt = (label: string, ms: number) => {
        const val = ms.toFixed(1) + ' ms';
        return label.padEnd(20) + val.padStart(10);
    };
    const lines = [
        `Timing breakdown (${t.tileCount} tile${t.tileCount !== 1 ? 's' : ''})`,
        fmt('Mirror padding:', t.mirrorPadMs),
        fmt('Tile extract:', t.tileExtractMs),
        fmt('Upload:', t.uploadMs),
    ];
    for (let i = 0; i < t.convLayerMs.length; i++) {
        lines.push(fmt(`Conv L${i}:`, t.convLayerMs[i]));
    }
    lines.push(fmt('Deconv:', t.deconvMs));
    lines.push(fmt('Readback:', t.readbackMs));
    lines.push(fmt('Stitch:', t.stitchMs));
    lines.push(fmt('Total:', t.totalMs));
    return lines.join('\n');
}

boot();
