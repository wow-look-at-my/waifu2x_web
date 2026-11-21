# waifu2x_web

Client-side waifu2x 2x image upscaler running fully in the browser using WebGL2.

## Architecture

- **Model**: the waifu2x 2x network: conv layers, then a transposed conv that doubles the size
- **Inference**: Custom WebGL2 shaders for convolution and transposed convolution, running in a Web Worker via OffscreenCanvas
- **Tiling**: The image is split into equal tiles of at most 128x128 source pixels. Each tile carries a 7px border that the network consumes, so the seams do not show
- **Models**: Binary `.bin` files in `models/` (converted from nagadomi/waifu2x JSON weights)

## Project structure

```
src/           TypeScript source
  app.ts       UI: paste, drop and file input, result actions
  client.ts    Main-thread side of the worker: requests by id, cancel by restart
  protocol.ts  Message and timing types shared with the worker
  worker.ts    Web Worker entry point: runs requests in order, encodes the PNG
  waifu2x.ts   WebGL2 engine, model loading, inference (runs in worker)
  alpha.ts     Colour bleed into transparent pixels before an upscale
shaders/       GLSL ES 3.00 shaders (WebGL2), bundled into worker.js as text
  fullscreen.vert.glsl   Fullscreen quad vertex shader
  conv.frag.glsl         3x3 valid convolution
  deconv.frag.glsl       4x4 stride-2 transposed convolution (the last layer)
models/        Pre-trained binary model weights
css/           Styles
tests/         Browser tests of build/ (node:test + playwright-core)
scripts/       screenshots.ts, behind `just screenshots`
build.mjs      esbuild build script
justfile       Build, check and test recipes
```

## Build and test

```bash
npm install
just build    # production build to build/
just dev      # dev build with sourcemaps
just check    # tsc --noEmit over src/ and tests/
just test     # build, then run tests/*.test.ts in headless Chromium
just screenshots out/    # paste, upscale, and save a screenshot of each step
```

`UPDATE_FIXTURES=1 just test` writes the current results over the reference images in `tests/fixtures/`.

## Key details

- TypeScript compiled and bundled with esbuild (entry points: app.js + worker.js)
- All WebGL2 processing runs off the main thread in a Web Worker with OffscreenCanvas
- CSP meta tag restricts all network to same-origin (GitHub Pages). A test cannot `fetch` a blob URL for the same reason
- Feature maps packed in channel-group grids (RGBA texels hold the channels of one group)
- Weights stored as RGBA32F textures for GPU-side lookup
- Valid convolution (no padding) shrinks spatial dims by 2 per layer
- Tile pixels are mirrored past the image edges
- The textures and framebuffers of a tile shape are made once and used for every tile
- `readPixels` writes each tile straight into the result buffer
- An image with transparency runs the network again on its alpha channel, for each tile that needs it
- An upscale is one synchronous loop in the worker, so Cancel ends the worker and starts another
- The tests run on SwiftShader, which needs seconds for each tile. Keep the fixtures small
