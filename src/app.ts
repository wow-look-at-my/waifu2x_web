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
const upscale2xBtn = $<HTMLButtonElement>('upscale-2x-btn');
const upscale4xBtn = $<HTMLButtonElement>('upscale-4x-btn');
const downloadBtn = $<HTMLButtonElement>('download-btn');
const progressTrack = $<HTMLDivElement>('progress-track');
const progressBar = $<HTMLDivElement>('progress-fill');
const statusText = $<HTMLSpanElement>('status-text');
const beforeImg = $<HTMLImageElement>('before-img');
const afterImg = $<HTMLImageElement>('after-img');
const glCanvas = $<HTMLCanvasElement>('gl-canvas');
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
let lastScale = 2;

function setButtons(enabled: boolean) {
    upscale2xBtn.disabled = !enabled;
    upscale4xBtn.disabled = !enabled;
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

    progressTrack.classList.remove('is-hidden');
    await loadModelIfNeeded();
    progressTrack.classList.add('is-hidden');
    statusText.textContent = 'Ready. Drop or select an image.';
}

async function loadModelIfNeeded(): Promise<boolean> {
    const key = noiseSelect.value;
    if (key === loadedModelKey) return true;

    const url = MODELS[key];
    statusText.textContent = 'Loading model...';
    progressTrack.classList.remove('is-hidden');
    progressBar.style.width = '0%';

    try {
        await waifu2x.loadModel(url, ratio => {
            progressBar.style.width = `${(ratio * 100).toFixed(0)}%`;
        });
        progressBar.style.width = '100%';
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
        setButtons(true);
        downloadBtn.classList.add('is-hidden');
        statusText.textContent = `Loaded ${file.name}.`;
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
    await loadModelIfNeeded();
    progressTrack.classList.add('is-hidden');
});

async function runUpscale(scale: number) {
    if (!sourceImage) return;

    if (!await loadModelIfNeeded()) return;

    lastScale = scale;
    const passes = Math.log2(scale);

    setButtons(false);
    progressTrack.classList.remove('is-hidden');
    downloadBtn.classList.add('is-hidden');
    afterImg.classList.add('is-hidden');
    progressBar.style.width = '0%';

    const start = performance.now();

    try {
        let current: HTMLImageElement | HTMLCanvasElement = sourceImage;

        for (let pass = 0; pass < passes; pass++) {
            const passOffset = pass / passes;
            const passScale = 1 / passes;
            const passLabel = passes > 1 ? ` (pass ${pass + 1}/${passes})` : '';

            current = await waifu2x.process(current, ratio => {
                const overall = passOffset + ratio * passScale;
                progressBar.style.width = `${(overall * 100).toFixed(0)}%`;
                statusText.textContent = `Upscaling ${scale}x${passLabel}... ${(overall * 100).toFixed(0)}%`;
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
            downloadBtn.classList.remove('is-hidden');
        }, 'image/png');
    } catch (e) {
        statusText.textContent = `Error: ${(e as Error).message}`;
    }

    setButtons(true);
    progressTrack.classList.add('is-hidden');
}

upscale2xBtn.addEventListener('click', () => runUpscale(2));
upscale4xBtn.addEventListener('click', () => runUpscale(4));

downloadBtn.addEventListener('click', () => {
    if (!resultBlobUrl) return;
    const a = document.createElement('a');
    a.href = resultBlobUrl;
    a.download = `waifu2x_${lastScale}x.png`;
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
