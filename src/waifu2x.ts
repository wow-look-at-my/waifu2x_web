interface LayerMeta {
    nI: number;
    nO: number;
    kH: number;
    kW: number;
    isDeconv: boolean;
    weights: Float32Array;
    biases: Float32Array;
    weightTex: WebGLTexture | null;
    biasTex: WebGLTexture | null;
}

export interface TimingData {
    totalMs: number;
    mirrorPadMs: number;
    tileCount: number;
    tileExtractMs: number;
    uploadMs: number;
    convLayerMs: number[];
    deconvMs: number;
    readbackMs: number;
    stitchMs: number;
}

export interface ProcessResult {
    canvas: OffscreenCanvas;
    timing: TimingData;
}

export class Waifu2x {
    private gl: WebGL2RenderingContext;
    private programs: { conv?: WebGLProgram; deconv?: WebGLProgram } = {};
    private model: LayerMeta[] | null = null;
    private quadVAO: WebGLVertexArrayObject | null = null;

    constructor() {
        const canvas = new OffscreenCanvas(1, 1);
        const gl = canvas.getContext('webgl2', {
            antialias: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
        });
        if (!gl) throw new Error('WebGL2 is not supported in this browser');

        const ext = gl.getExtension('EXT_color_buffer_float');
        if (!ext) throw new Error('EXT_color_buffer_float extension not available');
        gl.getExtension('OES_texture_float_linear');

        this.gl = gl;
    }

    async init(baseUrl: string): Promise<void> {
        const resolve = (path: string) => new URL(path, baseUrl).href;
        const [vertSrc, convSrc, deconvSrc] = await Promise.all([
            fetch(resolve('shaders/fullscreen.vert.glsl')).then(r => r.text()),
            fetch(resolve('shaders/conv.frag.glsl')).then(r => r.text()),
            fetch(resolve('shaders/deconv.frag.glsl')).then(r => r.text()),
        ]);

        this.programs.conv = this.createProgram(vertSrc, convSrc);
        this.programs.deconv = this.createProgram(vertSrc, deconvSrc);
        this.setupQuad();
    }

    async loadModel(url: string, onProgress?: (ratio: number) => void): Promise<void> {
        const resp = await fetch(url);
        const total = parseInt(resp.headers.get('content-length') || '0', 10);
        const reader = resp.body!.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (onProgress && total) onProgress(loaded / total);
        }

        const buf = new Uint8Array(loaded);
        let pos = 0;
        for (const chunk of chunks) {
            buf.set(chunk, pos);
            pos += chunk.length;
        }

        this.model = this.parseModel(buf.buffer);
        this.buildWeightTextures();
    }

    process(
        inputImage: ImageBitmap,
        onProgress?: (ratio: number) => void,
    ): ProcessResult {
        const totalStart = performance.now();
        const model = this.model!;
        const srcW = inputImage.width;
        const srcH = inputImage.height;
        const outW = srcW * 2;
        const outH = srcH * 2;

        const TILE = 128;
        const BORDER = 7;
        const STRIDE = TILE - 2 * BORDER;

        const tilesX = Math.ceil(srcW / STRIDE);
        const tilesY = Math.ceil(srcH / STRIDE);
        const totalTiles = tilesX * tilesY;

        const padW = tilesX * STRIDE + 2 * BORDER;
        const padH = tilesY * STRIDE + 2 * BORDER;

        const padStart = performance.now();
        const paddedCanvas = this.createPadded(inputImage, padW, padH, BORDER);
        const mirrorPadMs = performance.now() - padStart;

        const outputCanvas = new OffscreenCanvas(outW, outH);
        const octx = outputCanvas.getContext('2d')!;

        const convLayers = model.length - 1;
        const convShrink = convLayers * 2;
        const deconvLayer = model[model.length - 1];
        const deconvInputSize = TILE - convShrink;
        const deconvOutputSize = (deconvInputSize - 1) * 2 + deconvLayer.kW;
        const cropEdge = (deconvOutputSize - STRIDE * 2) >> 1;

        let processed = 0;
        let sumExtract = 0;
        let sumUpload = 0;
        const sumConv: number[] = new Array(convLayers).fill(0);
        let sumDeconv = 0;
        let sumReadback = 0;
        let sumStitch = 0;

        for (let ty = 0; ty < tilesY; ty++) {
            for (let tx = 0; tx < tilesX; tx++) {
                const sx = tx * STRIDE;
                const sy = ty * STRIDE;

                let t0 = performance.now();
                const tileCanvas = new OffscreenCanvas(TILE, TILE);
                const tctx = tileCanvas.getContext('2d')!;
                tctx.drawImage(paddedCanvas, sx, sy, TILE, TILE, 0, 0, TILE, TILE);
                sumExtract += performance.now() - t0;

                const tile = this.processTileTimed(tileCanvas);

                sumUpload += tile.uploadMs;
                for (let i = 0; i < tile.convLayerMs.length; i++) {
                    sumConv[i] += tile.convLayerMs[i];
                }
                sumDeconv += tile.deconvMs;
                sumReadback += tile.readbackMs;

                t0 = performance.now();
                const outX = tx * STRIDE * 2;
                const outY = ty * STRIDE * 2;
                const drawW = Math.min(STRIDE * 2, outW - outX);
                const drawH = Math.min(STRIDE * 2, outH - outY);

                if (drawW > 0 && drawH > 0) {
                    octx.drawImage(tile.canvas, cropEdge, cropEdge, drawW, drawH,
                        outX, outY, drawW, drawH);
                }
                sumStitch += performance.now() - t0;

                processed++;
                if (onProgress) onProgress(processed / totalTiles);
            }
        }

        const totalMs = performance.now() - totalStart;

        return {
            canvas: outputCanvas,
            timing: {
                totalMs,
                mirrorPadMs,
                tileCount: totalTiles,
                tileExtractMs: sumExtract,
                uploadMs: sumUpload,
                convLayerMs: sumConv.slice(),
                deconvMs: sumDeconv,
                readbackMs: sumReadback,
                stitchMs: sumStitch,
            },
        };
    }

    private createPadded(
        img: ImageBitmap,
        padW: number, padH: number, border: number,
    ): OffscreenCanvas {
        const w = img.width;
        const h = img.height;

        const tmp = new OffscreenCanvas(w, h);
        const tctx = tmp.getContext('2d')!;
        tctx.drawImage(img, 0, 0);
        const src = tctx.getImageData(0, 0, w, h);

        const pad = new OffscreenCanvas(padW, padH);
        const pctx = pad.getContext('2d')!;
        const dst = pctx.createImageData(padW, padH);

        for (let py = 0; py < padH; py++) {
            const sy = mirror(py - border, h);
            for (let px = 0; px < padW; px++) {
                const sx = mirror(px - border, w);
                const si = (sy * w + sx) * 4;
                const di = (py * padW + px) * 4;
                dst.data[di] = src.data[si];
                dst.data[di + 1] = src.data[si + 1];
                dst.data[di + 2] = src.data[si + 2];
                dst.data[di + 3] = 255;
            }
        }

        pctx.putImageData(dst, 0, 0);
        return pad;
    }

    private processTileTimed(tileCanvas: OffscreenCanvas): {
        canvas: OffscreenCanvas;
        uploadMs: number;
        convLayerMs: number[];
        deconvMs: number;
        readbackMs: number;
    } {
        const gl = this.gl;
        const model = this.model!;
        const tileW = tileCanvas.width;
        const tileH = tileCanvas.height;

        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);

        gl.finish();
        const uploadStart = performance.now();
        let inputTex = this.texFromCanvas(tileCanvas);
        gl.finish();
        const uploadMs = performance.now() - uploadStart;

        let cellW = tileW;
        let cellH = tileH;
        let gridCols = 1;
        let numGroups = 1;

        const convLayerMs: number[] = [];
        let deconvMs = 0;
        let readbackMs = 0;

        for (let li = 0; li < model.length; li++) {
            const layer = model[li];

            if (layer.isDeconv) {
                const outW = (cellW - 1) * 2 + layer.kW;
                const outH = (cellH - 1) * 2 + layer.kH;

                gl.finish();
                let t0 = performance.now();
                const { tex, fbo } = this.runDeconv(
                    inputTex, layer, cellW, cellH, gridCols, numGroups, outW, outH,
                );
                gl.finish();
                deconvMs = performance.now() - t0;

                gl.deleteTexture(inputTex);

                t0 = performance.now();
                const resultCanvas = this.readToCanvas(fbo, outW, outH);
                readbackMs = performance.now() - t0;

                gl.deleteTexture(tex);
                gl.deleteFramebuffer(fbo);
                return { canvas: resultCanvas, uploadMs, convLayerMs, deconvMs, readbackMs };
            }

            const outCellW = cellW - 2;
            const outCellH = cellH - 2;
            const outNumGroups = Math.ceil(layer.nO / 4);
            const outGridCols = Math.ceil(Math.sqrt(outNumGroups));
            const outGridRows = Math.ceil(outNumGroups / outGridCols);
            const outTexW = outGridCols * outCellW;
            const outTexH = outGridRows * outCellH;

            gl.finish();
            const t0 = performance.now();
            const outTex = this.runConv(
                inputTex, layer,
                cellW, cellH, gridCols, numGroups,
                outCellW, outCellH, outGridCols, outNumGroups, outTexW, outTexH,
            );
            gl.finish();
            convLayerMs.push(performance.now() - t0);

            gl.deleteTexture(inputTex);
            inputTex = outTex;
            cellW = outCellW;
            cellH = outCellH;
            gridCols = outGridCols;
            numGroups = outNumGroups;
        }

        return { canvas: new OffscreenCanvas(0, 0), uploadMs, convLayerMs, deconvMs, readbackMs };
    }

    private runConv(
        inputTex: WebGLTexture, layer: LayerMeta,
        inCellW: number, inCellH: number, inGridCols: number, inNumGroups: number,
        outCellW: number, outCellH: number, outGridCols: number, outNumGroups: number,
        outTexW: number, outTexH: number,
    ): WebGLTexture {
        const gl = this.gl;
        const prog = this.programs.conv!;
        gl.useProgram(prog);

        const outTex = this.createFloatTex(outTexW, outTexH);
        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
        gl.viewport(0, 0, outTexW, outTexH);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_input'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, layer.weightTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_weights'), 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, layer.biasTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_biases'), 2);

        gl.uniform1i(gl.getUniformLocation(prog, 'u_numInputGroups'), inNumGroups);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_numOutputGroups'), outNumGroups);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_inputGridCols'), inGridCols);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_outputGridCols'), outGridCols);
        gl.uniform2i(gl.getUniformLocation(prog, 'u_inputCellSize'), inCellW, inCellH);
        gl.uniform2i(gl.getUniformLocation(prog, 'u_outputCellSize'), outCellW, outCellH);

        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);

        return outTex;
    }

    private runDeconv(
        inputTex: WebGLTexture, layer: LayerMeta,
        inCellW: number, inCellH: number, inGridCols: number, inNumGroups: number,
        outW: number, outH: number,
    ): { tex: WebGLTexture; fbo: WebGLFramebuffer } {
        const gl = this.gl;
        const prog = this.programs.deconv!;
        gl.useProgram(prog);

        const outTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, outTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, outW, outH, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);

        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
        gl.viewport(0, 0, outW, outH);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_input'), 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, layer.weightTex);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_weights'), 1);

        gl.uniform3f(gl.getUniformLocation(prog, 'u_bias'),
            layer.biases[0], layer.biases[1], layer.biases[2]);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_numInputGroups'), inNumGroups);
        gl.uniform1i(gl.getUniformLocation(prog, 'u_inputGridCols'), inGridCols);
        gl.uniform2i(gl.getUniformLocation(prog, 'u_inputCellSize'), inCellW, inCellH);

        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return { tex: outTex, fbo };
    }

    private readToCanvas(fbo: WebGLFramebuffer, w: number, h: number): OffscreenCanvas {
        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d')!;
        const imgData = ctx.createImageData(w, h);
        imgData.data.set(pixels);
        ctx.putImageData(imgData, 0, 0);
        return canvas;
    }

    private texFromCanvas(canvas: OffscreenCanvas): WebGLTexture {
        const gl = this.gl;
        const ctx = canvas.getContext('2d')!;
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const floats = new Float32Array(canvas.width * canvas.height * 4);
        const inv = 1 / 255;
        for (let i = 0; i < imgData.data.length; i++) {
            floats[i] = imgData.data[i] * inv;
        }

        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, canvas.width, canvas.height, 0,
            gl.RGBA, gl.FLOAT, floats);
        return tex;
    }

    private createFloatTex(w: number, h: number): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        return tex;
    }

    private createDataTexture(w: number, h: number, data: Float32Array): WebGLTexture {
        const gl = this.gl;
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
        return tex;
    }

    private parseModel(buffer: ArrayBuffer): LayerMeta[] {
        const view = new DataView(buffer);
        let offset = 0;

        const numLayers = view.getUint16(offset, true);
        offset += 4; // u16 num_layers + u16 padding for 4-byte alignment
        const layers: LayerMeta[] = [];

        for (let i = 0; i < numLayers; i++) {
            const nI = view.getUint16(offset, true); offset += 2;
            const nO = view.getUint16(offset, true); offset += 2;
            const kH = view.getUint8(offset); offset += 1;
            const kW = view.getUint8(offset); offset += 1;
            const isDeconv = view.getUint8(offset) === 1; offset += 1;
            offset += 1;
            layers.push({
                nI, nO, kH, kW, isDeconv,
                weights: new Float32Array(0),
                biases: new Float32Array(0),
                weightTex: null,
                biasTex: null,
            });
        }

        // offset is now 4 + numLayers*8 = always 4-byte aligned
        for (const layer of layers) {
            const dim0 = layer.isDeconv ? layer.nI : layer.nO;
            const dim1 = layer.isDeconv ? layer.nO : layer.nI;
            const count = dim0 * dim1 * layer.kH * layer.kW;
            layer.weights = new Float32Array(buffer, offset, count);
            offset += count * 4;
        }

        for (const layer of layers) {
            layer.biases = new Float32Array(buffer, offset, layer.nO);
            offset += layer.nO * 4;
        }

        return layers;
    }

    private buildWeightTextures(): void {
        for (const layer of this.model!) {
            if (layer.isDeconv) {
                this.buildDeconvWeightTex(layer);
            } else {
                this.buildConvWeightTex(layer);
            }
            this.buildBiasTex(layer);
        }
    }

    private buildConvWeightTex(layer: LayerMeta): void {
        const { nI, nO, kH, kW, weights } = layer;
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

        layer.weightTex = this.createDataTexture(texW, texH, data);
    }

    private buildDeconvWeightTex(layer: LayerMeta): void {
        const { nI, nO, kH, kW, weights } = layer;
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

        layer.weightTex = this.createDataTexture(texW, texH, data);
    }

    private buildBiasTex(layer: LayerMeta): void {
        const { nO, biases } = layer;
        const numOG = Math.ceil(nO / 4);
        const data = new Float32Array(numOG * 4);
        for (let i = 0; i < nO; i++) {
            data[i] = biases[i];
        }
        layer.biasTex = this.createDataTexture(numOG, 1, data);
    }

    private createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, vertSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
            throw new Error('Vertex shader: ' + gl.getShaderInfoLog(vs));

        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, fragSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
            throw new Error('Fragment shader: ' + gl.getShaderInfoLog(fs));

        const prog = gl.createProgram()!;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.bindAttribLocation(prog, 0, 'a_position');
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            throw new Error('Link: ' + gl.getProgramInfoLog(prog));

        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return prog;
    }

    private setupQuad(): void {
        const gl = this.gl;
        this.quadVAO = gl.createVertexArray()!;
        gl.bindVertexArray(this.quadVAO);
        const buf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER,
            new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
    }

    destroy(): void {
        const gl = this.gl;
        if (this.model) {
            for (const layer of this.model) {
                if (layer.weightTex) gl.deleteTexture(layer.weightTex);
                if (layer.biasTex) gl.deleteTexture(layer.biasTex);
            }
        }
        for (const prog of Object.values(this.programs)) {
            if (prog) gl.deleteProgram(prog);
        }
        if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    }
}

function mirror(x: number, size: number): number {
    if (size <= 1) return 0;
    while (x < 0 || x >= size) {
        if (x < 0) x = -x - 1;
        if (x >= size) x = 2 * size - x - 1;
    }
    return x;
}
