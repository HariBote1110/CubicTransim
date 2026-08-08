import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '..');
const repoRoot = path.resolve(rendererRoot, '..');
const terrain = path.join(rendererRoot, 'terrain_core');
const renderer = path.join(rendererRoot, 'renderer_wgpu');
const web = path.join(rendererRoot, 'web');
const resultsDir = path.join(here, 'results');
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const browserExact = args.has('--browser-exact'); // ~90 s / 1.06 M points on this VM
const checkTsMigration = args.has('--check-ts-migration');

fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(path.join(terrain, '.tmp'), { recursive: true });
fs.mkdirSync(path.join(renderer, '.tmp'), { recursive: true });
fs.mkdirSync(path.join(web, '.tmp'), { recursive: true });

function run(command, commandArgs, cwd, extraEnv = {}, tolerateFailure = false) {
  const r = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !tolerateFailure) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed (${r.status})\n${r.stderr}\n${r.stdout}`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseLastJson(text) {
  const lines = text.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { return JSON.parse(s); } catch { /* keep searching */ }
  }
  throw new Error(`No JSON object found in output:\n${text.slice(-4000)}`);
}

const terrainEnv = { TMPDIR: path.join(terrain, '.tmp') };
const workspaceEnv = { TMPDIR: path.join(rendererRoot, '.tmp'), CARGO_HOME: path.join(renderer, '.cargo-home') };
const rendererEnv = { TMPDIR: path.join(renderer, '.tmp'), CARGO_HOME: path.join(renderer, '.cargo-home') };
const chromeLib = path.join(web, '.chrome-libs/usr/lib/x86_64-linux-gnu');
const chromeLib2 = path.join(web, '.chrome-libs/usr/lib');
const browserEnv = {
  TMPDIR: path.join(web, '.tmp'),
  LD_LIBRARY_PATH: [chromeLib, chromeLib2, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
};

const startedAt = new Date().toISOString();
const build = {};
if (!skipBuild) {
  build.workspaceTests = run('cargo', ['test', '--workspace', '--release', '--lib', '--bins'], rendererRoot, workspaceEnv).status === 0;
  build.nativeBins = run('cargo', ['build', '--workspace', '--release', '--bins'], rendererRoot, workspaceEnv).status === 0;
  build.productionTsVsRust1M = checkTsMigration ? run('npx', ['vitest', 'run', '--config', 'renderer/vitest.direct.config.ts'], repoRoot).status === 0 : null;

  const rustc = run('rustup', ['which', '--toolchain', 'stable', 'rustc'], renderer).stdout.trim();
  const wasmEnv = {
    ...rendererEnv,
    PATH: `${path.dirname(rustc)}:${process.env.PATH}`,
  };
  build.wasmPack = run('wasm-pack', ['build', '--target', 'web', '--release', '--out-dir', '../web/pkg'], renderer, wasmEnv).status === 0;
  build.vite = run('npm', ['run', 'build'], web).status === 0;
}

const frameRuns = [];
for (let i = 0; i < 3; i++) {
  frameRuns.push(parseLastJson(run(path.join(rendererRoot, 'target/release/frame_bench'), [], terrain, terrainEnv).stdout));
}
const sortedFrames = [...frameRuns].sort((a, b) => a.medianMs - b.medianMs);
const selectedFrame = sortedFrames[Math.floor(sortedFrames.length / 2)];

const noise = parseLastJson(run(
  path.join(rendererRoot, 'target/release/noise-check'),
  ['305419896', '10000000', '8192'], renderer, rendererEnv,
).stdout);
const strictNoiseSeeds = [0, 1, 0x12345678, 0xdeadbeef, 0xffffffff];
const multiSeedNoise = strictNoiseSeeds.map(seed => {
  const r = spawnSync(path.join(rendererRoot, 'target/release/noise-check'), [String(seed >>> 0), '10000000', '8192'], {
    cwd: renderer,
    env: rendererEnv,
    encoding: 'utf8',
  });
  return parseLastJson(r.stdout);
});
const multiSeedNoisePass = multiSeedNoise.every(item => item.mismatches === 0);
const tile = parseLastJson(run(path.join(rendererRoot, 'target/release/tile_check'), [], renderer, rendererEnv).stdout);
const offscreen = parseLastJson(run(path.join(rendererRoot, 'target/release/offscreen_render'), [], renderer, rendererEnv).stdout);
const fullmap = parseLastJson(run(path.join(rendererRoot, 'target/release/fullmap_render'), [], renderer, rendererEnv).stdout);

const smokeRun = run('node', ['bench/smoke.mjs'], web, browserEnv, true);
const browserSmoke = smokeRun.status === 0 ? parseLastJson(smokeRun.stdout) : {
  ok: false,
  error: `${smokeRun.stderr}\n${smokeRun.stdout}`.trim(),
};

const cameraRuns = [];
for (let i = 0; i < 3; i++) {
  const cameraRun = run('node', ['bench/camera_replay.mjs'], web, browserEnv, true);
  cameraRuns.push(cameraRun.status === 0 ? parseLastJson(cameraRun.stdout) : { ok: false, error: `${cameraRun.stderr}\n${cameraRun.stdout}`.trim(), phases: [] });
}
const cameraScore = item => {
  const p99s = (item.phases ?? []).map(p => p.wasmCpu?.p99Ms ?? Infinity);
  return p99s.length ? Math.max(...p99s) : Infinity;
};
const sortedCameraRuns = [...cameraRuns].sort((a,b) => cameraScore(a) - cameraScore(b));
const selectedCameraRun = sortedCameraRuns[Math.floor(sortedCameraRuns.length / 2)];

let browserNoise = null;
if (browserExact) {
  const browserNoiseRun = run('node', ['bench/browser-compute.mjs', '16'], web, browserEnv, true);
  browserNoise = browserNoiseRun.status === 0 ? parseLastJson(browserNoiseRun.stdout) : {
    ok: false,
    error: `${browserNoiseRun.stderr}\n${browserNoiseRun.stdout}`.trim(),
  };
}

const wasmAsset = fs.readdirSync(path.join(web, 'dist/assets')).find(name => name.endsWith('.wasm'));
if (!wasmAsset) throw new Error('No production wasm asset found in web/dist/assets');
const wasmBytes = fs.readFileSync(path.join(web, 'dist/assets', wasmAsset));
const wasmGzipBytes = zlib.gzipSync(wasmBytes, { level: 9 }).byteLength;

const heapBytes = browserSmoke?.diagnostics?.wasmHeapBytes ?? null;
const firstFrameMs = browserSmoke?.diagnostics?.firstFrameMs ?? null;
const a1Proto = selectedFrame.medianMs <= 2 && selectedFrame.p99Ms <= 4;
const a2 = tile.cpuIssueMedianMs <= 0.3;
const a4Native = noise.points ? noise.points >= 10_000_000 && noise.mismatches === 0 : noise.count >= 10_000_000 && noise.mismatches === 0;
const a5Proto = heapBytes == null ? null : heapBytes <= 128 * 1024 * 1024;
const a6 = wasmGzipBytes <= 2 * 1024 * 1024;
const a7 = selectedFrame.hitchesOver16_6ms === 0;
const a8 = selectedFrame.deterministic === true;
const strict = {
  A1: { pass: selectedFrame.medianMs <= 1 && selectedFrame.p99Ms <= 2, target: 'median <=1 ms, p99 <=2 ms', measurement: { medianMs: selectedFrame.medianMs, p99Ms: selectedFrame.p99Ms } },
  A2: { pass: tile.cpuIssueMedianMs <= 0.15, target: '<=0.15 ms/tile', measurement: tile.cpuIssueMedianMs },
  A5: { pass: heapBytes == null ? null : heapBytes <= 96 * 1024 * 1024, targetBytes: 96 * 1024 * 1024, measuredBytes: heapBytes },
  A6: { pass: wasmGzipBytes <= 1 * 1024 * 1024, targetBytes: 1 * 1024 * 1024, measuredBytes: wasmGzipBytes },
  A7: { pass: selectedFrame.hitchesOver16_6ms === 0, target: '0 frames >16.6 ms / 10,000' },
  A8: { pass: a8, target: 'bit-exact deterministic output' },
  T1: { pass: null, target: 'median <=1.5 ms, p99 <=3 ms', status: 'Layer B real-GPU required' },
  T2: { pass: null, target: 'median <=3 ms, p99 <=6 ms', status: 'Layer B real-GPU required' },
  T3: { pass: null, target: '0 frames >16.6 ms / 10,000', status: 'Layer B real-GPU required' },
  T4: { pass: fullmap.drawCalls <= 24, target: '<=24 draw calls plus Layer-B frame-time gate', measurement: { drawCalls: fullmap.drawCalls } },
  T5: { pass: null, target: '0 hitch + p99 <=6 ms', status: 'Layer B real-GPU required' },
  T6: { pass: firstFrameMs == null ? null : firstFrameMs <= 200, targetMs: 200, measuredMs: firstFrameMs },
  T7: { pass: null, targetMs: 33, status: 'not instrumented yet' },
  T8: { pass: null, target: '<=1 frame', status: 'not-in-prototype-scope' },
  T9: { pass: null, targetBytes: 192 * 1024 * 1024, status: 'Layer B full scene required' },
  T10: { pass: a5Proto && (heapBytes == null || heapBytes <= 96 * 1024 * 1024), targetBytes: 96 * 1024 * 1024, measuredBytes: heapBytes },
  T11: { pass: fullmap.drawCalls <= 24, target: '<=24 draw calls', measurement: fullmap.drawCalls },
  T12: { pass: null, target: '100k trees + 30k houses + 1k trains while maintaining T1-T3', status: 'Layer B final scene required' },
  T13: { pass: null, targetMs: 0.05, status: 'not instrumented yet' },
  T14: { pass: multiSeedNoisePass, target: '5 seeds x 10,000,000 points x 0 mismatches', measurement: multiSeedNoise },
  T15: { pass: wasmGzipBytes <= 1 * 1024 * 1024, targetBytes: 1 * 1024 * 1024, measuredBytes: wasmGzipBytes },
  indexPath: { pass: true, note: 'Indexed terrain grid: 66,049 unique vertex IDs vs 393,216 triangle-list vertex references (-83.2% index references). GPU vertex-cache hit rate is measured only on Layer B.' },
};

const report = {
  schema: 'quarterview-layer-a-proto-v1',
  startedAt,
  finishedAt: new Date().toISOString(),
  build,
  environment: {
    cpuModel: selectedFrame.cpuModel,
    logicalCores: selectedFrame.logicalCores,
    loadavg: selectedFrame.loadavg,
    nativeAdapter: noise.adapter,
    nativeBackend: noise.backend,
    browserBackend: browserSmoke?.hasGpu ? 'BrowserWebGpu' : null,
    note: 'Pixel/GPU absolute performance is not graded on Layer A software rasterizers.',
  },
  gates: {
    strict,
    A1_proto_cpu_path: { pass: a1Proto, target: 'median <=2 ms, p99 <=4 ms', measurement: selectedFrame, caveat: 'prototype LOD/culling/command skeleton, not final full A1 workload' },
    A2_tile_issue: { pass: a2, target: '<=0.3 ms/tile CPU issue', measurement: tile },
    A3_overlay_update: { pass: null, status: 'not-in-prototype-scope' },
    A4_production_ts_vs_rust_1m: { pass: build.productionTsVsRust1M, target: 'production src/sim/terrainField.ts vs Rust, 1,000,000 heights byte-for-byte', status: checkTsMigration ? undefined : 'pending main-TS integer migration owned by caller' },
    A4_noise_exact_native_10m: { pass: a4Native, target: '10,000,000 points, 0 mismatches', measurement: noise },
    A4_noise_exact_multiseed_50m: { pass: multiSeedNoisePass, target: '5 seeds x 10,000,000 points, 0 mismatches', measurement: multiSeedNoise },
    A4_noise_exact_browser_proto: browserNoise ? { pass: browserNoise.mismatches === 0, measurement: browserNoise } : { pass: null, status: 'not-run; add --browser-exact for ~1.06M BrowserWebGPU readback check' },
    cameraReplay: { pass: selectedCameraRun.ok === true, runs: cameraRuns.map((r,i)=>({run:i+1,score:cameraScore(r),ok:r.ok})), selectedRun: cameraRuns.indexOf(selectedCameraRun)+1, selected: selectedCameraRun, policy: '3 runs; median run selected by worst-phase WASM CPU p99' },
    A5_wasm_heap_proto: { pass: a5Proto, targetBytes: 128 * 1024 * 1024, measuredBytes: heapBytes, caveat: 'prototype state only; towns/trains final scenario not implemented' },
    A6_wasm_gzip: { pass: a6, targetBytes: 2 * 1024 * 1024, rawBytes: wasmBytes.byteLength, gzipBytes: wasmGzipBytes, asset: wasmAsset },
    A7_cpu_hitches: { pass: a7, target: '0 frames >16.6 ms / 10,000', count: selectedFrame.hitchesOver16_6ms },
    A8_determinism: { pass: a8, outputHash: selectedFrame.outputHash },
  },
  prototype: {
    firstFrame: { passUnder1s: firstFrameMs == null ? null : firstFrameMs <= 1000, milliseconds: firstFrameMs, stats: browserSmoke?.diagnostics?.firstStats ?? null },
    browserSmoke,
    nativeOffscreen: offscreen,
    fullMapStructure: {
      pass: fullmap.drawCalls <= 30 && fullmap.nonBackgroundPixels > 600000 && fullmap.nonBackgroundPixels < 680000 && fullmap.bbox?.[0] <= 2 && fullmap.bbox?.[1] >= 48 && fullmap.bbox?.[1] <= 52 && fullmap.bbox?.[2] >= 1597 && fullmap.bbox?.[3] >= 847,
      measurement: fullmap,
      caveat: 'structural/readback check only; full-map frame-time T4 remains a Layer-B real-GPU measurement',
    },
    frameRuns,
    selectedFrameRun: selectedFrame,
    cameraReplay: { runs: cameraRuns, selected: selectedCameraRun },
    captureNote: 'Chrome 151 headless does not composite WebGPU canvases into Playwright screenshots on this VM; raw JS WebGPU clear has the same behaviour. Correctness is checked by GPU readback.',
  },
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const resultPath = path.join(resultsDir, `layer-a-${stamp}.json`);
fs.writeFileSync(resultPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
console.error(`wrote ${resultPath}`);
