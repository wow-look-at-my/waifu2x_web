# waifu2x_web

Client-side waifu2x 2x image upscaler running fully in the browser using WebGL2.

## Architecture

- **Model**: waifu2x model (conv layers + 1 transposed conv for 2x upscale)
- **Inference**: Custom WebGL2 shaders for convolution and transposed convolution, running in a Web Worker via OffscreenCanvas
- **Tiling**: Large images are processed in 128x128 tiles with 7px overlap for seamless output
- **Models**: Binary `.bin` files in `models/` (converted from nagadomi/waifu2x JSON weights)

## Project structure

```
src/           TypeScript source
  app.ts       UI, file handling, worker communication
  worker.ts    Web Worker entry point (owns WebGL2 context)
  waifu2x.ts   WebGL2 engine, model loading, inference (runs in worker)
shaders/       GLSL ES 3.00 shaders (WebGL2)
  fullscreen.vert.glsl   Fullscreen quad vertex shader
  conv.frag.glsl         3x3 valid convolution (layers 0-5)
  deconv.frag.glsl       4x4 stride-2 transposed convolution (layer 6)
models/        Pre-trained binary model weights
css/           Styles
build.mjs      esbuild build script
```

## Build

```bash
npm install
npm run build    # production build to build/
npm run dev      # dev build with sourcemaps
```

## Key details

- TypeScript compiled and bundled with esbuild (entry points: app.js + worker.js)
- All WebGL2 processing runs off the main thread in a Web Worker with OffscreenCanvas
- CSP meta tag restricts all network to same-origin (GitHub Pages)
- Feature maps packed in channel-group grids (channels per RGBA texel)
- Weights stored as RGBA32F textures for GPU-side lookup
- Valid convolution (no padding) shrinks spatial dims by 2 per layer
- Mirror padding applied to input to handle tile borders
