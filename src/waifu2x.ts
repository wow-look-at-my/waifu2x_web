// waifu2x.ts holds Stage.

import { bleedColour } from './alpha';
import type { TimingData } from './protocol';
import vertSrc from '../shaders/fullscreen.vert.glsl';
import convSrc from '../shaders/conv.frag.glsl';
import deconvSrc from '../shaders/deconv.frag.glsl';

interface LayerShape {
    nI: number;
    nO: number;
    kH: number;
    kW: number;
    isDeconv: boolean;
}

interface Layer extends LayerShape {
    biases: Float32Array;
    weightTex: WebGLTexture;
    biasTex: WebGLTexture;
}

interface Program {
    handle: WebGLProgram;
    uniforms: Record<string, WebGLUniformLocation | null>;
}

// The render target of one network layer, sized for one tile shape.
interface Stage {
    tex: WebGLTexture;
    fbo: WebGLFramebuffer;
    texW: number;
    texH: number;
    cellW: number;
    cellH: number;
    gridCols: number;
    numGroups: number;
}

interface Plan {
    key: string;
    tileW: number;
    tileH: number;
    inputTex: WebGLTexture;
    stages: Stage[];
}

export interface Upscaled {
    pixels: Uint8ClampedArray<ArrayBuffer>;
    width: number;
    height: number;
    timing: TimingData;
}

const MAX_TILE = 128;
// Source pixels that the network consumes on each side of a tile.
const BORDER = 7;
const CONV_UNIFORMS = [
    'u_input', 'u_weights', 'u_biases', 'u_numInputGroups', 'u_numOutputGroups',
    'u_inputGridCols', 'u_outputGridCols', 'u_inputCellSize', 'u_outputCellSize',
];
const DECONV_UNIFORMS = [
    'u_input', 'u_weights', 'u_bias', 'u_numInputGroups', 'u_inputGridCols', 'u_inputCellSize',
];

export class Waifu2x {
    private gl: WebGL2RenderingContext;
    private conv: Program;
    private deconv: Program;
    private quadVAO: WebGLVertexArrayObject;
    private models = new Map<string, Layer[]>();
    private plan: Plan | null = null;

    constructor() {
        const canvas = new OffscreenCanvas(1, 1);
        const gl = canvas.getContext('webgl2', {
            antialias: false,
            alpha: false,
            depth: false,
            stencil: false,
            powerPreference: 'high-performance',
        });
        if (!gl) throw new Error('WebGL2 is not supported in this browser');
        if (!gl.getExtension('EXT_color_buffer_float'))
            throw new Error('EXT_color_buffer_float extension not available');

        this.gl = gl;
        this.conv = this.createProgram(vertSrc, convSrc, CONV_UNIFORMS);
        this.deconv = this.createProgram(vertSrc, deconvSrc, DECONV_UNIFORMS);
        this.quadVAO = this.createQuad();
    }

    async loadModel(url: string, onProgress?: (ratio: number) => void): Promise<void> {
        if (this.models.has(url)) return;

        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Model download failed: HTTP ${resp.status} for ${url}`);

        // Content-Length counts compressed bytes, so the ratio can pass one.
        const total = parseInt(resp.headers.get('content-length') || '0', 10);
        const reader = resp.body!.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (onProgress && total) onProgress(Math.min(1, loaded / total));
        }

        const buf = new Uint8Array(loaded);
        let pos = 0;
        for (const chunk of chunks) {
            buf.set(chunk, pos);
            pos += chunk.length;
        }

        this.models.set(url, this.parseModel(buf.buffer, url));
    }

    process(
        image: ImageBitmap,
        modelUrl: string,
        onProgress?: (ratio: number) => void,
    ): Upscaled {
        const totalStart = performance.now();
        const gl = this.gl;
        const model = this.models.get(modelUrl);
        if (!model) throw new Error(`Model is not loaded: ${modelUrl}`);

        const srcW = image.width;
        const srcH = image.height;
        const outW = srcW * 2;
        const outH = srcH * 2;

        const srcCanvas = new OffscreenCanvas(srcW, srcH);
        const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
        srcCtx.drawImage(image, 0, 0);
        const src = srcCtx.getImageData(0, 0, srcW, srcH).data;
        const src32 = new Uint32Array(src.buffer);

        let hasAlpha = false;
        for (let i = 3; i < src.length; i += 4) {
            if (src[i] !== 255) {
                hasAlpha = true;
                break;
            }
        }
        if (hasAlpha) bleedColour(src, srcW, srcH, BORDER);

        // Equal tiles that cover the image waste less work than fixed ones.
        const maxStride = MAX_TILE - 2 * BORDER;
        const tilesX = Math.ceil(srcW / maxStride);
        const tilesY = Math.ceil(srcH / maxStride);
        const strideX = Math.ceil(srcW / tilesX);
        const strideY = Math.ceil(srcH / tilesY);
        const tileW = strideX + 2 * BORDER;
        const tileH = strideY + 2 * BORDER;
        const totalTiles = tilesX * tilesY;

        const mirrorX = mirrorTable(tilesX * strideX + 2 * BORDER, srcW);
        const mirrorY = mirrorTable(tilesY * strideY + 2 * BORDER, srcH);

        const plan = this.ensurePlan(model, tileW, tileH);
        const last = plan.stages[plan.stages.length - 1];
        const cropX = (last.texW - strideX * 2) >> 1;
        const cropY = (last.texH - strideY * 2) >> 1;

        let pixels: Uint8ClampedArray<ArrayBuffer>;
        try {
            pixels = new Uint8ClampedArray(outW * outH * 4);
        } catch {
            throw new Error(`Image is too large: no memory for a ${outW} x ${outH} result`);
        }
        const out = new Uint8Array(pixels.buffer);

        const tile = new Uint8Array(tileW * tileH * 4);
        const tile32 = new Uint32Array(tile.buffer);
        const alphaOut = hasAlpha ? new Uint8Array(strideX * 2 * strideY * 2 * 4) : null;

        const timing: TimingData = {
            totalMs: 0,
            prepareMs: performance.now() - totalStart,
            tileCount: totalTiles,
            tileExtractMs: 0,
            uploadMs: 0,
            convLayerMs: new Array(plan.stages.length - 1).fill(0),
            deconvMs: 0,
            readbackMs: 0,
            encodeMs: 0,
        };

        gl.bindVertexArray(this.quadVAO);

        let processed = 0;
        for (let ty = 0; ty < tilesY; ty++) {
            for (let tx = 0; tx < tilesX; tx++) {
                const outX = tx * strideX * 2;
                const outY = ty * strideY * 2;
                const drawW = Math.min(strideX * 2, outW - outX);
                const drawH = Math.min(strideY * 2, outH - outY);

                let t0 = performance.now();
                const xBase = tx * strideX;
                for (let y = 0; y < tileH; y++) {
                    const srcRow = mirrorY[ty * strideY + y] * srcW;
                    const dstRow = y * tileW;
                    for (let x = 0; x < tileW; x++) {
                        tile32[dstRow + x] = src32[srcRow + mirrorX[xBase + x]];
                    }
                }
                let minA = 255;
                let maxA = 0;
                if (hasAlpha) {
                    for (let i = 3; i < tile.length; i += 4) {
                        const a = tile[i];
                        if (a < minA) minA = a;
                        if (a > maxA) maxA = a;
                    }
                }
                timing.tileExtractMs += performance.now() - t0;

                // A fully transparent tile stays zero in the result.
                if (!hasAlpha || maxA > 0) {
                    this.runTile(model, plan, tile, timing);

                    t0 = performance.now();
                    gl.pixelStorei(gl.PACK_ROW_LENGTH, outW);
                    gl.readPixels(cropX, cropY, drawW, drawH, gl.RGBA, gl.UNSIGNED_BYTE,
                        out, (outY * outW + outX) * 4);
                    timing.readbackMs += performance.now() - t0;
                }

                // The network also upscales alpha, as a grey image.
                if (alphaOut && maxA > 0 && minA < 255) {
                    t0 = performance.now();
                    for (let i = 0; i < tile.length; i += 4) {
                        tile[i] = tile[i + 1] = tile[i + 2] = tile[i + 3];
                    }
                    timing.tileExtractMs += performance.now() - t0;

                    this.runTile(model, plan, tile, timing);

                    t0 = performance.now();
                    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
                    gl.readPixels(cropX, cropY, drawW, drawH, gl.RGBA, gl.UNSIGNED_BYTE, alphaOut);
                    for (let y = 0; y < drawH; y++) {
                        let si = y * drawW * 4 + 1;
                        let di = ((outY + y) * outW + outX) * 4 + 3;
                        for (let x = 0; x < drawW; x++, si += 4, di += 4) {
                            out[di] = alphaOut[si];
                        }
                    }
                    timing.readbackMs += performance.now() - t0;
                }

                // A lost context reads back zeros and raises no error.
                if (gl.isContextLost())
                    throw new Error('The WebGL context was lost during the upscale. Reload the page.');

                processed++;
                if (onProgress) onProgress(processed / totalTiles);
            }
        }

        gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindVertexArray(null);

        timing.totalMs = performance.now() - totalStart;
        return { pixels, width: outW, height: outH, timing };
    }

    // Leaves the upscaled tile in the framebuffer of the last stage, bound for a read.
    private runTile(model: Layer[], plan: Plan, tile: Uint8Array, timing: TimingData): void {
        const gl = this.gl;

        let t0 = performance.now();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, plan.inputTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, plan.tileW, plan.tileH,
            gl.RGBA, gl.UNSIGNED_BYTE, tile);
        gl.finish();
        let t1 = performance.now();
        timing.uploadMs += t1 - t0;
        t0 = t1;

        let inTex = plan.inputTex;
        let inCellW = plan.tileW;
        let inCellH = plan.tileH;
        let inGridCols = 1;
        let inNumGroups = 1;

        for (let li = 0; li < model.length; li++) {
            const layer = model[li];
            const stage = plan.stages[li];
            const prog = layer.isDeconv ? this.deconv : this.conv;
            const u = prog.uniforms;

            gl.useProgram(prog.handle);
            gl.bindFramebuffer(gl.FRAMEBUFFER, stage.fbo);
            gl.viewport(0, 0, stage.texW, stage.texH);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, inTex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, layer.weightTex);

            gl.uniform1i(u.u_numInputGroups, inNumGroups);
            gl.uniform1i(u.u_inputGridCols, inGridCols);
            gl.uniform2i(u.u_inputCellSize, inCellW, inCellH);
            if (layer.isDeconv) {
                gl.uniform3f(u.u_bias, layer.biases[0], layer.biases[1], layer.biases[2]);
            } else {
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, layer.biasTex);
                gl.uniform1i(u.u_numOutputGroups, stage.numGroups);
                gl.uniform1i(u.u_outputGridCols, stage.gridCols);
                gl.uniform2i(u.u_outputCellSize, stage.cellW, stage.cellH);
            }

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.finish();
            t1 = performance.now();
            if (layer.isDeconv) timing.deconvMs += t1 - t0;
            else timing.convLayerMs[li] += t1 - t0;
            t0 = t1;

            inTex = stage.tex;
            inCellW = stage.cellW;
            inCellH = stage.cellH;
            inGridCols = stage.gridCols;
            inNumGroups = stage.numGroups;
        }
    }

    private ensurePlan(model: Layer[], tileW: number, tileH: number): Plan {
        const gl = this.gl;
        const key = `${tileW}x${tileH}:` + model.map(l => `${l.nO}.${l.kW}.${l.kH}`).join(',');
        if (this.plan?.key === key) return this.plan;

        if (this.plan) {
            gl.deleteTexture(this.plan.inputTex);
            for (const stage of this.plan.stages) {
                gl.deleteFramebuffer(stage.fbo);
                gl.deleteTexture(stage.tex);
            }
            this.plan = null;
        }

        const inputTex = this.createTexture(gl.RGBA8, tileW, tileH, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const stages: Stage[] = [];
        let cellW = tileW;
        let cellH = tileH;

        for (const layer of model) {
            let stage: Omit<Stage, 'fbo'>;
            if (layer.isDeconv) {
                cellW = (cellW - 1) * 2 + layer.kW;
                cellH = (cellH - 1) * 2 + layer.kH;
                stage = {
                    tex: this.createTexture(gl.RGBA8, cellW, cellH, gl.RGBA, gl.UNSIGNED_BYTE, null),
                    texW: cellW, texH: cellH, cellW, cellH, gridCols: 1, numGroups: 1,
                };
            } else {
                cellW -= layer.kW - 1;
                cellH -= layer.kH - 1;
                const numGroups = Math.ceil(layer.nO / 4);
                const gridCols = Math.ceil(Math.sqrt(numGroups));
                const texW = gridCols * cellW;
                const texH = Math.ceil(numGroups / gridCols) * cellH;
                stage = {
                    tex: this.createTexture(gl.RGBA32F, texW, texH, gl.RGBA, gl.FLOAT, null),
                    texW, texH, cellW, cellH, gridCols, numGroups,
                };
            }

            const fbo = gl.createFramebuffer()!;
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, stage.tex, 0);
            const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            if (status !== gl.FRAMEBUFFER_COMPLETE)
                throw new Error(`This GPU cannot render to a ${stage.texW} x ${stage.texH} texture (status ${status})`);
            stages.push({ ...stage, fbo });
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        this.plan = { key, tileW, tileH, inputTex, stages };
        return this.plan;
    }

    private createTexture(
        internalFormat: number, w: number, h: number,
        format: number, type: number, data: ArrayBufferView | null,
    ): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, data);
        return tex;
    }

    private parseModel(buffer: ArrayBuffer, url: string): Layer[] {
        const view = new DataView(buffer);
        const corrupt = () => new Error(`Model file is corrupt or incomplete: ${url}`);
        if (buffer.byteLength < 4) throw corrupt();

        // The layer count is a u16. Padding after it keeps every float aligned.
        const numLayers = view.getUint16(0, true);
        let offset = 4;
        if (buffer.byteLength < offset + numLayers * 8) throw corrupt();

        const shapes: LayerShape[] = [];
        let floats = 0;
        for (let i = 0; i < numLayers; i++) {
            const nI = view.getUint16(offset, true);
            const nO = view.getUint16(offset + 2, true);
            const kH = view.getUint8(offset + 4);
            const kW = view.getUint8(offset + 5);
            const isDeconv = view.getUint8(offset + 6) === 1;
            offset += 8;
            shapes.push({ nI, nO, kH, kW, isDeconv });
            floats += nI * nO * kH * kW + nO;
        }
        if (buffer.byteLength !== offset + floats * 4) throw corrupt();

        const weights = shapes.map(s => {
            const count = s.nI * s.nO * s.kH * s.kW;
            const w = new Float32Array(buffer, offset, count);
            offset += count * 4;
            return w;
        });

        return shapes.map((shape, i) => {
            const biases = new Float32Array(buffer, offset, shape.nO);
            offset += shape.nO * 4;
            return {
                ...shape,
                biases,
                weightTex: shape.isDeconv
                    ? this.buildDeconvWeightTex(shape, weights[i])
                    : this.buildConvWeightTex(shape, weights[i]),
                biasTex: this.buildBiasTex(biases),
            };
        });
    }

    private buildConvWeightTex({ nI, nO, kH, kW }: LayerShape, weights: Float32Array): WebGLTexture {
        const numIG = Math.ceil(nI / 4);
        const numOG = Math.ceil(nO / 4);
        const texW = numIG * 12;
        const texH = numOG * 3;
        const data = new Float32Array(texW * texH * 4);

        for (let og = 0; og < numOG; og++) {
            for (let ig = 0; ig < numIG; ig++) {
                for (let ky = 0; ky < kH; ky++) {
                    for (let kx = 0; kx < kW; kx++) {
                        for (let oci = 0; oci < 4; oci++) {
                            const oc = og * 4 + oci;
                            if (oc >= nO) continue;
                            const texX = ig * 12 + kx * 4 + oci;
                            const texY = og * 3 + ky;
                            const texIdx = (texY * texW + texX) * 4;
                            for (let ici = 0; ici < 4; ici++) {
                                const ic = ig * 4 + ici;
                                if (ic >= nI) continue;
                                const wIdx = ((oc * nI + ic) * kH + ky) * kW + kx;
                                data[texIdx + ici] = weights[wIdx];
                            }
                        }
                    }
                }
            }
        }

        const gl = this.gl;
        return this.createTexture(gl.RGBA32F, texW, texH, gl.RGBA, gl.FLOAT, data);
    }

    private buildDeconvWeightTex({ nI, nO, kH, kW }: LayerShape, weights: Float32Array): WebGLTexture {
        const numIG = Math.ceil(nI / 4);
        const texW = numIG * kW;
        const texH = nO * kH;
        const data = new Float32Array(texW * texH * 4);

        for (let oc = 0; oc < nO; oc++) {
            for (let ig = 0; ig < numIG; ig++) {
                for (let ky = 0; ky < kH; ky++) {
                    for (let kx = 0; kx < kW; kx++) {
                        const texX = ig * kW + kx;
                        const texY = oc * kH + ky;
                        const texIdx = (texY * texW + texX) * 4;
                        for (let ici = 0; ici < 4; ici++) {
                            const ic = ig * 4 + ici;
                            if (ic >= nI) continue;
                            const wIdx = ((ic * nO + oc) * kH + ky) * kW + kx;
                            data[texIdx + ici] = weights[wIdx];
                        }
                    }
                }
            }
        }

        const gl = this.gl;
        return this.createTexture(gl.RGBA32F, texW, texH, gl.RGBA, gl.FLOAT, data);
    }

    private buildBiasTex(biases: Float32Array): WebGLTexture {
        const numOG = Math.ceil(biases.length / 4);
        const data = new Float32Array(numOG * 4);
        data.set(biases);
        const gl = this.gl;
        return this.createTexture(gl.RGBA32F, numOG, 1, gl.RGBA, gl.FLOAT, data);
    }

    private createProgram(vert: string, frag: string, uniformNames: string[]): Program {
        const gl = this.gl;
        const compile = (type: number, source: string, label: string) => {
            const shader = gl.createShader(type)!;
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
                throw new Error(`${label} shader: ${gl.getShaderInfoLog(shader)}`);
            return shader;
        };
        const vs = compile(gl.VERTEX_SHADER, vert, 'Vertex');
        const fs = compile(gl.FRAGMENT_SHADER, frag, 'Fragment');

        const handle = gl.createProgram()!;
        gl.attachShader(handle, vs);
        gl.attachShader(handle, fs);
        gl.bindAttribLocation(handle, 0, 'a_position');
        gl.linkProgram(handle);
        if (!gl.getProgramParameter(handle, gl.LINK_STATUS))
            throw new Error('Link: ' + gl.getProgramInfoLog(handle));
        gl.deleteShader(vs);
        gl.deleteShader(fs);

        const uniforms: Program['uniforms'] = {};
        for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(handle, name);

        gl.useProgram(handle);
        gl.uniform1i(uniforms.u_input, 0);
        gl.uniform1i(uniforms.u_weights, 1);
        if (uniforms.u_biases) gl.uniform1i(uniforms.u_biases, 2);
        return { handle, uniforms };
    }

    private createQuad(): WebGLVertexArrayObject {
        const gl = this.gl;
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        return vao;
    }
}

// Source index for each padded position. The image is mirrored past its edges.
function mirrorTable(length: number, size: number): Int32Array {
    const table = new Int32Array(length);
    for (let i = 0; i < length; i++) {
        let x = i - BORDER;
        while (size > 1 && (x < 0 || x >= size)) {
            if (x < 0) x = -x - 1;
            if (x >= size) x = 2 * size - x - 1;
        }
        table[i] = size > 1 ? x : 0;
    }
    return table;
}
