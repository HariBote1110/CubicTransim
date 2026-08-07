# Optimization pass — 2026-08-08

## Implemented

- Terrain grid changed from triangle-list vertex references to a shared u32 indexed grid. The 257x257 tile has 66,049 unique vertex IDs vs 393,216 triangle-list vertex references, reducing index references by 83.2% and allowing vertex pulling to execute once per indexed vertex where the GPU vertex cache is effective.
- Camera parameters were split from per-tile draw parameters. Camera state is now one 32-byte uniform write per frame instead of one 48-byte write per visible tile. Tile origin/stride/grid parameters are immutable per resident tile.
- New-tile generation is visible-first and capped at 24 new tiles/frame. Initial frame no longer synchronously generates the entire one-tile prefetch border.
- WASM/browser prototype remains under the 1 MB strict gzip budget by a large margin.

## Measurements

- Browser first frame after the optimization: ~63.9 ms on the VM Chrome/WebGPU software path.
- First frame generates 24 tiles instead of 36; 16 are visible and the remaining 8 are prefetch.
- WASM heap in the prototype: ~4.25 MiB.
- Full-map native structural render: 9 draw calls, 640,000 non-background pixels, bbox [1,50]-[1598,849]. Native software-raster elapsed time is ~102 ms and is not a Layer-B performance grade.
- Existing native workspace tests and shader pipeline checks pass.

## Important blocker discovered by stricter validation

The original 10M-point noise test used one canonical seed (0x12345678) and passes. A five-seed 50M-point run exposed mismatches for seeds 0, 1 and 0xffffffff. The mismatch count is tiny (1–3 per 10M) but this is a hard failure under the strict T14 policy.

The attempted double-single f32 arithmetic is not a portable exactness mechanism in WGSL. WGSL implementations may use floating-point fast-math/reassociation behavior, and error-free transforms such as 2Sum are therefore not a valid cross-backend guarantee. This is consistent with known WGSL floating-point semantics and existing reports of 2Sum failing in WGSL.

Do not mark the multi-seed exactness gate as passed until a representation/algorithm that is valid under WebGPU's floating-point semantics is implemented. This is now the primary correctness blocker; performance tuning must not weaken this gate.
