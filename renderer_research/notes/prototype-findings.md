# Quarter-view renderer prototype findings

## 2026-08-07: terrain exactness is not safe with naive WGSL f32

The TypeScript terrain field performs interpolation and quantization in JavaScript `number` (f64). A literal WGSL f32 port looked correct visually but failed exact comparison at height quantization boundaries.

With seed `0x12345678`, one million deterministic sample points produced four mismatches in the naive f32 shader. Example: `(-4532, 6016)` returned height 2 in the TypeScript-equivalent Rust f64 reference but height 1 in WGSL f32.

The prototype therefore uses a double-single representation (`hi: f32`, `lo: f32`) for the noise interpolation path. The u32 hash is split exactly into two 16-bit fractions, smoothstep is evaluated from the integer remainder as `r^2(3w-2r)/w^3`, and fma is used to recover the low part of division/multiplication. Height classification is performed in the unnormalised octave-sum domain against split-f32 threshold constants instead of first dividing by 1.875.

Results after the change:

- JavaScript terrainField-equivalent reference vs Rust f64: 1,000,000 heights byte-for-byte identical.
- Native wgpu + llvmpipe/Vulkan WGSL vs Rust f64: 10,000,000 points, 0 mismatches.
- Browser WebGPU (Chrome 151 headless) vs Rust/WASM f64 reference: 1,056,784 points, 0 mismatches.
- Packed tile generation (height + water flag), six LOD/stride cases: 396,294 points, 0 mismatches.

The BrowserWebGPU software path is extremely slow on this VM (~91 s for 1.06 M points), while native llvmpipe executes the 10 M comparison in ~139 ms. Software WebGPU execution time is therefore treated as correctness-only, not a GPU performance result.

## 2026-08-07: wgpu 0.20 browser backend is incompatible with current Chrome

`wgpu 0.20.1` successfully compiled, and its native Vulkan path worked, but its browser backend always inserted `maxInterStageShaderComponents` into `GPUAdapter.requestDevice().requiredLimits`. Chrome 151 no longer recognises that legacy limit name and rejected device creation with `OperationError`.

The prototype was moved to `wgpu 24.0.5` (still satisfying the requirement of wgpu 0.20+). Native Vulkan tests, WASM compilation, the 10 M noise comparison, tile generation and offscreen rendering were rerun after the migration and stayed correct.

## 2026-08-07: headless Chrome screenshots do not prove WebGPU presentation here

Chrome for Testing 151 can expose `navigator.gpu` and run BrowserWebGPU in the VM. However, a Playwright screenshot captures WebGPU canvases as black in this environment. A control test using raw JavaScript WebGPU to clear a second canvas to solid red is also captured as black, so this is not specific to the Rust/WASM renderer.

For Layer-A correctness the harness therefore validates WebGPU by GPU-to-buffer readback rather than by screenshot pixels. Native offscreen wgpu rendering is separately read back to RGBA and produces a coherent quarter-view terrain image.

## Current prototype measurements

Environment: i5-13400F VM, Ubuntu, llvmpipe (LLVM 21.1.8) Vulkan for native software wgpu; Chrome 151 BrowserWebGPU for browser smoke tests.

- CPU LOD/culling command skeleton, 10,000 frames: median ~0.00010 ms, p99 ~0.00018 ms, >16.6 ms hitches 0, deterministic output hash identical on repeat. This is not yet the complete A1 workload.
- Tile compute command-recording issue cost: median ~0.00085 ms, p99 ~0.00141 ms, below A2's 0.3 ms target.
- Native offscreen vertical slice (compute tile -> storage buffer -> vertex pulling -> depth -> readback), 800x600 under llvmpipe: tens of milliseconds. This is software-raster timing and is not a T-GPU result.
- Native 16K full-map structural render at 1600x900: LOD 5, 9 draw calls, 640,000 non-background pixels and bbox `[1,50]-[1598,849]`. The expected projected map is a 1600x800 diamond (area 640,000 px), so this also verifies that partial edge tiles collapse at the map boundary rather than drawing ground outside the 16385-cell world.
- Browser first frame from navigation: ~65 ms in the current smoke test, with 36 tiles generated/prefetched; below the prototype T6 <=1 s threshold, but again on the software BrowserWebGPU path.
- Browser full-map view: LOD 5, 9 visible draw calls, ~11.3 MiB estimated resident tile storage after transition.
- Browser WASM linear memory observed during smoke test: ~1.125 MiB. This is prototype state only, not the final A5 scenario containing towns/trains.
- Production Vite bundle: WASM ~166.2 kB raw / ~67.6 kB gzip plus ~33.6 kB JS. Well below the 2 MB gzip target at this stage.

## Remaining prototype work

- Add explicit cliff/vertical side faces; the current vertex-pulled terrain draws top surfaces only.
- Turn the existing CPU path, noise checker, tile checker, offscreen renderer and browser smoke/readback tests into one Layer-A JSON harness.
- Record the scripted camera path and histogram in the unified result format.
- Layer-B real-GPU measurements for frame time, full-map p99, hitch count and GPU timestamp data cannot be judged on this VM and must be run on a real-GPU machine.
