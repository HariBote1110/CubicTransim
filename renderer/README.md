# Quarter-view Rust + WebGPU renderer

This Cargo workspace holds the promoted quarter-view renderer (research prototype -> product code,
see `progress/renderer-integration-plan.md`). Phase R1 mounts it under the existing three.js canvas
as the terrain layer of a two-layer composite; three.js still draws rails, trains, towns and scenery.

## Layout

- `terrain_core/` — dependency-free Rust reference implementation of `src/sim/terrainField.ts`, clipmap/LOD selection, CPU regression benches.
- `renderer_wgpu/` — wgpu compute + vertex-pulling renderer, native Layer-A validators, WASM/browser renderer.
- `web/` — standalone Vite page with pan/zoom/HUD and Playwright BrowserWebGPU smoke/readback checks.
- `bench/` — unified Layer-A harness and generated result JSONs (permanent regression gate).
- `../renderer_research/notes/` — research findings and known limitations.

The Cargo workspace root is this directory (`renderer/Cargo.toml`).

## Game build integration

`npm run build:renderer` (repo root) runs `wasm-pack build --release --target web` and writes the
module into `public/renderer/`, which Vite serves in dev and copies into `dist/` on build. The game
lazily imports it only when the WebGPU renderer is selected, so `npm run build` never needs Rust.

## One-command Layer-A run

From `renderer/`:

```sh
node bench/run-layer-a.mjs
```

This performs the Rust workspace tests/build, `wasm-pack --release`, Vite production build, three 10,000-frame CPU-path runs (selecting the median run), the 10,000,000-point native software-WGPU exactness check, tile-generation check, native offscreen render/readback, and Chrome BrowserWebGPU smoke test. It writes one JSON report under `bench/results/`.

For a fast rerun using existing binaries/assets:

```sh
node bench/run-layer-a.mjs --skip-build
```

For the additional BrowserWebGPU compute/readback exactness check (~1.06 million points, very slow on this VM's browser software backend):

```sh
node bench/run-layer-a.mjs --skip-build --browser-exact
```

The browser exactness check is intentionally not enabled by default because Chrome's software BrowserWebGPU path takes roughly 90 seconds for ~1.06 M points on the current VM. Native llvmpipe validates 10 M points in well under one second.

## Standalone development page

```sh
cd web
npm install
npm run dev
```

Controls:

- drag — pan
- mouse wheel — zoom
- `0` — full 16K map
- `1` — approximately 100 px/cell

The HUD reports renderer CPU time, LOD, draw calls, visible/resident/generated tile counts, estimated tile GPU memory, camera position and zoom.

## Important validation note

Chrome 151 headless in this VM exposes and executes WebGPU but does not composite WebGPU canvases into Playwright screenshots. A raw JavaScript WebGPU solid-color control canvas is also captured as black. Browser correctness is therefore verified with GPU buffer readback, while native wgpu offscreen rendering is separately read back to RGBA for visual inspection. See `../notes/prototype-findings.md`.
