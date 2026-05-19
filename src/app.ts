import { Waifu2x } from './waifu2x';

const MODELS: Record<string, string> = {
    'none': 'models/scale2x.bin',
    '1': 'models/noise1-scale2x.bin',
    '2': 'models/noise2-scale2x.bin',
    '3': 'models/noise3-scale2x.bin',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dropZone = $<HTMLDivElement>('drop-zone');
const dropContent = $<HTMLDivElement>('drop-content');
const fileInput = $<HTMLInputElement>('file-input');
const noiseSelect = $<HTMLSelectElement>('noise-level');
const scaleSelect = $<HTMLSelectElement>('scale-select');
const processBtn = $<HTMLButtonElement>('process-btn');
const downloadBtn = $<HTMLButtonElement>('download-btn');
const progressBar = $<HTMLDivElement>('progress-fill');
const progressSection = $<HTMLDivElement>('progress-section');
const statusText = $<HTMLDivElement>('status-text');
const beforeImg = $<HTMLImageElement>('before-img');
const afterImg = $<HTMLImageElement>('after-img');
const glCanvas = $<HTMLCanvasElement>('gl-canvas');
const modelProgress = $<HTMLDivElement>('model-progress-fill');
const initSection = $<HTMLDivElement>('init-section');
const controlsSection = $<HTMLDivElement>('controls-section');
const dimInfo = $<HTMLSpanElement>('dim-info');
const magnifier = $<HTMLDivElement>('magnifier');
const magOriginal = $<HTMLDivElement>('mag-original');
const magUpscaled = $<HTMLDivElement>('mag-upscaled');

const MAG_HALF = 200;
const MAG_W = MAG_HALF * 2;
const MAG_H = MAG_HALF;
const MAGNIFIER_ZOOM = 5;

let waifu2x: Waifu2x;
let loadedModelKey = '';
let sourceImage: HTMLImageElement | null = null;
let resultBlobUrl = '';

function getScale(): number {
    return parseInt(scaleSelect.value, 10);
}

function updateDimInfo() {
    if (!sourceImage) return;
    const s = getScale();
    dimInfo.textContent = `${sourceImage.width} x ${sourceImage.height} -> ${sourceImage.width * s} x ${sourceImage.height * s}`;
}

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
        beforeImg.classList.remove('is-hidden');
        dropContent.classList.add('is-hidden');
        afterImg.classList.add('is-hidden');
        updateDimInfo();
        processBtn.disabled = false;
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

scaleSelect.addEventListener('change', () => {
    processBtn.textContent = `Upscale ${getScale()}x`;
    updateDimInfo();
});

processBtn.addEventListener('click', async () => {
    if (!sourceImage) return;

    initSection.hidden = false;
    if (!await loadModelIfNeeded()) return;
    initSection.hidden = true;

    const scale = getScale();
    const passes = Math.log2(scale);

    processBtn.disabled = true;
    progressSection.hidden = false;
    downloadBtn.hidden = true;
    afterImg.classList.add('is-hidden');
    progressBar.style.width = '0%';

    const start = performance.now();
    statusText.textContent = 'Upscaling...';

    try {
        let current: HTMLImageElement | HTMLCanvasElement = sourceImage;

        for (let pass = 0; pass < passes; pass++) {
            const passOffset = pass / passes;
            const passScale = 1 / passes;
            const passLabel = passes > 1 ? ` (pass ${pass + 1}/${passes})` : '';

            current = await waifu2x.process(current, ratio => {
                const overall = passOffset + ratio * passScale;
                progressBar.style.width = `${(overall * 100).toFixed(0)}%`;
                statusText.textContent = `Upscaling${passLabel}... ${(overall * 100).toFixed(0)}%`;
            });
        }

        const elapsed = ((performance.now() - start) / 1000).toFixed(1);
        statusText.textContent = `Done in ${elapsed}s.`;
        progressBar.style.width = '100%';

        if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);

        const result = current as HTMLCanvasElement;
        result.toBlob(blob => {
            if (!blob) return;
            resultBlobUrl = URL.createObjectURL(blob);
            afterImg.src = resultBlobUrl;
            afterImg.classList.remove('is-hidden');
            downloadBtn.hidden = false;
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
    a.download = `waifu2x_${getScale()}x.png`;
    a.click();
});

function setMagPane(pane: HTMLDivElement, img: HTMLImageElement, rx: number, ry: number) {
    if (!img.src || img.classList.contains('is-hidden')) {
        pane.style.backgroundImage = 'none';
        return;
    }
    const bgW = img.naturalWidth * MAGNIFIER_ZOOM;
    const bgH = img.naturalHeight * MAGNIFIER_ZOOM;
    const bgX = -(rx * bgW - MAG_HALF / 2);
    const bgY = -(ry * bgH - MAG_H / 2);
    pane.style.backgroundImage = `url("${img.src}")`;
    pane.style.backgroundSize = `${bgW}px ${bgH}px`;
    pane.style.backgroundPosition = `${bgX}px ${bgY}px`;
}

function onMagMove(e: MouseEvent) {
    const img = e.currentTarget as HTMLImageElement;
    const rect = img.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / rect.width;
    const ry = (e.clientY - rect.top) / rect.height;

    setMagPane(magOriginal, beforeImg, rx, ry);
    setMagPane(magUpscaled, afterImg, rx, ry);

    let left = e.clientX + 20;
    let top = e.clientY - MAG_H / 2;
    if (left + MAG_W > window.innerWidth) {
        left = e.clientX - MAG_W - 20;
    }
    top = Math.max(4, Math.min(top, window.innerHeight - MAG_H - 4));

    magnifier.style.left = `${left}px`;
    magnifier.style.top = `${top}px`;
    magnifier.classList.remove('is-hidden');
}

function onMagLeave() {
    magnifier.classList.add('is-hidden');
}

beforeImg.addEventListener('mousemove', onMagMove);
beforeImg.addEventListener('mouseleave', onMagLeave);
afterImg.addEventListener('mousemove', onMagMove);
afterImg.addEventListener('mouseleave', onMagLeave);

boot();
