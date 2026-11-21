// app.ts holds offer.

import { CancelledError, EngineClient } from './client';
import type { ProcessResult, ProgressStage, TimingData } from './protocol';

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
const cancelBtn = $<HTMLButtonElement>('cancel-btn');
const downloadBtn = $<HTMLButtonElement>('download-btn');
const copyBtn = $<HTMLButtonElement>('copy-btn');
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
const engine = new EngineClient('js/worker.js');
const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;

interface Source {
    img: HTMLImageElement;
    url: string;
    name: string;
}

let source: Source | null = null;
let result: { blob: Blob; url: string; name: string } | null = null;
let ready = false;
let busy = false;
let jobSeq = 0;
let decodeSeq = 0;

const modelUrl = () => new URL(MODELS[noiseSelect.value], baseUrl).href;

function refresh() {
    processBtn.disabled = !source || !ready || busy;
    cancelBtn.hidden = !busy;
    noiseSelect.disabled = busy;
    progressSection.hidden = !busy;
}

function onProgress(stage: ProgressStage, ratio: number) {
    const pct = `${Math.round(ratio * 100)}%`;
    if (stage === 'model') {
        modelProgress.style.width = pct;
    } else {
        progressBar.style.width = pct;
        statusText.textContent = `Upscaling... ${pct}`;
    }
}

async function loadModel(): Promise<boolean> {
    initSection.hidden = false;
    modelProgress.style.width = '0%';
    statusText.textContent = 'Loading model...';
    try {
        await engine.loadModel(modelUrl(), onProgress);
        return true;
    } catch (e) {
        if (!(e instanceof CancelledError)) statusText.textContent = `Error: ${(e as Error).message}`;
        return false;
    } finally {
        initSection.hidden = true;
    }
}

async function boot() {
    ready = await loadModel();
    if (!ready) return;
    controlsSection.hidden = false;
    statusText.textContent = source
        ? `Loaded ${source.name}. Ready to upscale.`
        : 'Ready. Drop, paste or select an image.';
    refresh();
}

function clearResult() {
    if (result) URL.revokeObjectURL(result.url);
    result = null;
    previewSection.hidden = true;
    downloadBtn.hidden = true;
    copyBtn.hidden = true;
    timingSection.hidden = true;
}

function showResult(res: ProcessResult, sourceName: string) {
    result = {
        blob: res.blob,
        url: URL.createObjectURL(res.blob),
        name: `${sourceName.replace(/\.[^.]+$/, '')}_waifu2x.png`,
    };
    afterImg.src = result.url;
    compSlider.value = '100';
    afterWrap.style.clipPath = '';
    previewSection.hidden = false;
    downloadBtn.hidden = false;
    copyBtn.hidden = !canCopy;
    timingSection.textContent = formatTiming(res.timing);
    timingSection.hidden = false;
    statusText.textContent = `Done in ${(res.timing.totalMs / 1000).toFixed(1)}s.`;
}

function cancel() {
    if (!busy) return;
    jobSeq++;
    busy = false;
    engine.restart();
    refresh();
}

function setSource(file: File, verb: string) {
    const seq = ++decodeSeq;
    const url = URL.createObjectURL(file);
    const name = file.name || 'image.png';
    const img = new Image();
    img.onload = () => {
        if (seq !== decodeSeq) {
            URL.revokeObjectURL(url);
            return;
        }
        cancel();
        if (source) URL.revokeObjectURL(source.url);
        source = { img, url, name };
        clearResult();
        beforeImg.src = url;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        dimInfo.textContent = `${w} x ${h} -> ${w * 2} x ${h * 2}`;
        statusText.textContent = ready ? `${verb} ${name}. Ready to upscale.` : `${verb} ${name}.`;
        refresh();
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
        if (seq === decodeSeq) statusText.textContent = `Could not read ${name} as an image.`;
    };
    img.src = url;
}

// Takes the first image of a paste or a drop. Reports why when there is none.
function offer(transfer: DataTransfer | null, verb: string, emptyMessage: string): boolean {
    const files = [...(transfer?.files ?? [])];
    const file = files.find(f => f.type.startsWith('image/'));
    if (!file) {
        statusText.textContent = files.length ? `${files[0].name} is not an image.` : emptyMessage;
        return false;
    }
    setSource(file, verb);
    return true;
}

async function upscale() {
    if (!source || !ready || busy) return;
    const current = source;
    const job = ++jobSeq;

    busy = true;
    clearResult();
    progressBar.style.width = '0%';
    statusText.textContent = 'Upscaling...';
    refresh();

    try {
        const bitmap = await createImageBitmap(current.img);
        if (job !== jobSeq) {
            bitmap.close();
            throw new CancelledError();
        }
        showResult(await engine.process(bitmap, modelUrl(), onProgress), current.name);
    } catch (e) {
        // The code that cancelled the job has already set the status.
        if (!(e instanceof CancelledError)) statusText.textContent = `Error: ${(e as Error).message}`;
    }

    // A new job can start before the rejection of a cancelled one arrives here.
    if (job !== jobSeq) return;
    busy = false;
    refresh();
}

document.addEventListener('paste', e => {
    if (offer(e.clipboardData, 'Pasted', 'The clipboard holds no image.')) e.preventDefault();
});

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    fileInput.click();
});
fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    // An empty value lets the same file be selected again.
    fileInput.value = '';
    if (file) setSource(file, 'Loaded');
});

window.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});
window.addEventListener('dragleave', e => {
    if (!e.relatedTarget) dropZone.classList.remove('dragover');
});
window.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    offer(e.dataTransfer, 'Loaded', 'Drop an image file.');
});

noiseSelect.addEventListener('change', async () => {
    if (await loadModel()) statusText.textContent = 'Model loaded.';
});
processBtn.addEventListener('click', upscale);
cancelBtn.addEventListener('click', () => {
    cancel();
    statusText.textContent = 'Cancelled.';
});

downloadBtn.addEventListener('click', () => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = result.url;
    a.download = result.name;
    a.click();
});

copyBtn.addEventListener('click', async () => {
    if (!result) return;
    try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': result.blob })]);
        statusText.textContent = 'Copied the result to the clipboard.';
    } catch (e) {
        statusText.textContent = `Copy failed: ${(e as Error).message}`;
    }
});

compSlider.addEventListener('input', () => {
    const pct = parseInt(compSlider.value, 10);
    afterWrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
});

function formatTiming(t: TimingData): string {
    const total = t.totalMs;
    const pct = (ms: number) => (ms / total * 100).toFixed(0).padStart(3) + '%';
    const fmt = (label: string, ms: number) => {
        const val = ms.toFixed(1) + ' ms';
        return label.padEnd(16) + val.padStart(10) + '  ' + pct(ms);
    };
    const lines = [
        `Timing breakdown (${t.tileCount} tile${t.tileCount !== 1 ? 's' : ''})`,
        fmt('Prepare:', t.prepareMs),
        fmt('Tile extract:', t.tileExtractMs),
        fmt('Upload:', t.uploadMs),
    ];
    for (let i = 0; i < t.convLayerMs.length; i++) {
        lines.push(fmt(`Conv L${i}:`, t.convLayerMs[i]));
    }
    lines.push(fmt('Deconv:', t.deconvMs));
    lines.push(fmt('Readback:', t.readbackMs));
    lines.push(fmt('Encode PNG:', t.encodeMs));
    lines.push(fmt('Total:', t.totalMs));
    return lines.join('\n');
}

boot();
