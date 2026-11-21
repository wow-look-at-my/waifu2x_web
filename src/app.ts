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
const upscale4xBtn = $<HTMLButtonElement>('upscale-4x-btn');
const cancelBtn = $<HTMLButtonElement>('cancel-btn');
const downloadBtn = $<HTMLButtonElement>('download-btn');
const copyBtn = $<HTMLButtonElement>('copy-btn');
const progressBar = $<HTMLDivElement>('progress-fill');
const progressSection = $<HTMLDivElement>('progress-section');
const statusText = $<HTMLDivElement>('status-text');
const previewSection = $<HTMLDivElement>('preview-section');
const beforeImg = $<HTMLImageElement>('before-img');
const afterImg = $<HTMLImageElement>('after-img');
const magnifier = $<HTMLDivElement>('magnifier');
const magOriginal = $<HTMLDivElement>('mag-original');
const magUpscaled = $<HTMLDivElement>('mag-upscaled');
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
    upscale4xBtn.disabled = !source || !ready || busy;
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
    magnifier.classList.add('is-hidden');
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

// The model is a 2x network, so 4x runs it twice: 2x, then 2x again on the result.
async function upscale(scale: 2 | 4) {
    if (!source || !ready || busy) return;
    const current = source;
    const job = ++jobSeq;
    const passes = scale === 4 ? 2 : 1;

    busy = true;
    clearResult();
    progressBar.style.width = '0%';
    statusText.textContent = `Upscaling ${scale}x...`;
    refresh();

    try {
        let bitmap = await createImageBitmap(current.img);
        if (job !== jobSeq) {
            bitmap.close();
            throw new CancelledError();
        }
        const total: TimingData = {
            totalMs: 0,
            prepareMs: 0,
            tileCount: 0,
            tileExtractMs: 0,
            uploadMs: 0,
            convLayerMs: [],
            deconvMs: 0,
            readbackMs: 0,
            encodeMs: 0,
        };
        let done: ProcessResult | undefined;
        for (let pass = 0; pass < passes; pass++) {
            const from = pass / passes;
            const share = 1 / passes;
            done = await engine.process(bitmap, modelUrl(), (stage, ratio) =>
                onProgress(stage, from + ratio * share));
            accumulate(total, done.timing);
            if (job !== jobSeq) throw new CancelledError();
            if (pass < passes - 1) {
                // The worker hands back a PNG, which decodes into the next pass's input.
                bitmap = await createImageBitmap(done.blob);
                if (job !== jobSeq) {
                    bitmap.close();
                    throw new CancelledError();
                }
            }
        }
        if (!done) throw new Error('The worker returned no result');
        showResult({ ...done, timing: total }, current.name);
    } catch (e) {
        // The code that cancelled the job has already set the status.
        if (!(e instanceof CancelledError)) statusText.textContent = `Error: ${(e as Error).message}`;
    }

    // A new job can start before the rejection of a cancelled one arrives here.
    if (job !== jobSeq) return;
    busy = false;
    refresh();
}

// Sums one pass's timing into the total of every pass.
function accumulate(total: TimingData, t: TimingData) {
    total.totalMs += t.totalMs;
    total.prepareMs += t.prepareMs;
    total.tileCount += t.tileCount;
    total.tileExtractMs += t.tileExtractMs;
    total.uploadMs += t.uploadMs;
    for (let i = 0; i < t.convLayerMs.length; i++) {
        total.convLayerMs[i] = (total.convLayerMs[i] ?? 0) + t.convLayerMs[i];
    }
    total.deconvMs += t.deconvMs;
    total.readbackMs += t.readbackMs;
    total.encodeMs += t.encodeMs;
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
processBtn.addEventListener('click', () => upscale(2));
upscale4xBtn.addEventListener('click', () => upscale(4));
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

const MAG_HALF = 200;
const MAG_W = MAG_HALF * 2;
const MAG_H = MAG_HALF;
const MAG_ZOOM = 5;

function setMagPane(pane: HTMLDivElement, img: HTMLImageElement, rx: number, ry: number) {
    if (!img.src) {
        pane.style.backgroundImage = 'none';
        return;
    }
    const bgW = img.naturalWidth * MAG_ZOOM;
    const bgH = img.naturalHeight * MAG_ZOOM;
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
    if (left + MAG_W > window.innerWidth) left = e.clientX - MAG_W - 20;
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
