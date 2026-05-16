import { Waifu2x } from './waifu2x';

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
const glCanvas = $<HTMLCanvasElement>('gl-canvas');
const modelProgress = $<HTMLDivElement>('model-progress-fill');
const initSection = $<HTMLDivElement>('init-section');
const controlsSection = $<HTMLDivElement>('controls-section');
const dimInfo = $<HTMLSpanElement>('dim-info');

let waifu2x: Waifu2x;
let loadedModelKey = '';
let sourceImage: HTMLImageElement | null = null;
let resultBlobUrl = '';

async function boot() {
    statusText.textContent = 'Initializing WebGL2...';
    try {
        waifu2x = new Waifu2x(glCanvas);
        await waifu2x.init();
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

    const url = MODELS[key];
    statusText.textContent = 'Loading model...';
    initSection.hidden = false;
    modelProgress.style.width = '0%';

    try {
        await waifu2x.loadModel(url, ratio => {
            modelProgress.style.width = `${(ratio * 100).toFixed(0)}%`;
        });
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
    progressBar.style.width = '0%';

    const start = performance.now();
    statusText.textContent = 'Upscaling...';

    try {
        const result = await waifu2x.process(sourceImage, ratio => {
            progressBar.style.width = `${(ratio * 100).toFixed(0)}%`;
            const pct = (ratio * 100).toFixed(0);
            statusText.textContent = `Upscaling... ${pct}%`;
        });

        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
        statusText.textContent = `Done in ${elapsed}s.`;
        progressBar.style.width = '100%';

        if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);

        result.toBlob(blob => {
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

boot();
