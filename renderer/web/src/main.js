import init, { CanvasRenderer, cpuTilePacked, tileGenerateWgsl, profileThresholdWords } from '../pkg/quarterview_renderer_wgpu.js';

const canvas = document.querySelector('#view');
const hud = document.querySelector('#hud');
const errorBox = document.querySelector('#error');

const fail = (message) => {
  errorBox.style.display = 'grid';
  errorBox.textContent = message;
  throw new Error(message);
};

if (!navigator.gpu) fail('WebGPU is not available in this browser. The game should fall back to the current three.js renderer here.');

const wasm = await init();
globalThis.__quarterviewTest = { cpuTilePacked, tileGenerateWgsl, profileThresholdWords, wasmMemory: wasm.memory };
globalThis.__quarterviewControl = null;
const renderer = await CanvasRenderer.create(canvas, 0x12345678, 8192);
globalThis.__quarterviewRenderer = renderer;
let dpr = 1;
let lastStats = {};
let frameSamples = [];
const frameHistory = [];

const fitPpc = () => Math.min(canvas.width / 16384, canvas.height / 8192);
globalThis.__quarterviewControl = {
  setCamera: (x,z,ppc) => renderer.setCamera(x,z,ppc),
  panPixels: (dx,dy) => renderer.panPixels(dx,dy),
  zoomBy: (factor) => renderer.zoomBy(factor),
  fitPpc: () => fitPpc(),
  clearHistory: () => { frameHistory.length = 0; frameSamples.length = 0; },
  history: () => frameHistory.slice(),
};
const resize = () => {
  dpr = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(innerWidth * dpr));
  const height = Math.max(1, Math.round(innerHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    renderer.resize(width, height);
  }
};
resize();
addEventListener('resize', resize);

let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const dx = (event.clientX - lastX) * dpr;
  const dy = (event.clientY - lastY) * dpr;
  lastX = event.clientX;
  lastY = event.clientY;
  renderer.panPixels(dx, dy);
});
const endDrag = (event) => {
  dragging = false;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  renderer.zoomBy(Math.exp(-event.deltaY * 0.0015));
}, { passive: false });

addEventListener('keydown', (event) => {
  if (event.key === '0') renderer.setCamera(0, 0, fitPpc());
  if (event.key === '1') renderer.setCamera(0, 0, 100 * dpr);
});

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * p))];
};

let previousRaf = performance.now();
function frame(now) {
  resize();
  const rafDelta = now - previousRaf;
  previousRaf = now;
  frameSamples.push(rafDelta);
  if (frameSamples.length > 600) frameSamples.shift();

  try {
    lastStats = JSON.parse(renderer.render());
    frameHistory.push({ rafMs: rafDelta, cpuMs: lastStats.cpuMs ?? 0, drawCalls: lastStats.drawCalls ?? 0, visibleTiles: lastStats.visibleTiles ?? 0, generatedTiles: lastStats.generatedTiles ?? 0, lod: lastStats.lod ?? 0 });
    if (frameHistory.length > 5000) frameHistory.shift();
    globalThis.__quarterviewLastStats = { ...lastStats };
    if (globalThis.__quarterviewFirstFrameAt == null) {
      globalThis.__quarterviewFirstFrameAt = performance.now();
      globalThis.__quarterviewFirstStats = { ...lastStats };
    }
  } catch (error) {
    console.error(error);
  }
  const mib = (lastStats.tileGpuBytes || 0) / 1048576;
  hud.textContent = [
    'Quarter-view Rust + wgpu/WASM proto',
    `adapter: ${renderer.adapterInfo()}`,
    `raf median/p99: ${percentile(frameSamples, .5).toFixed(2)} / ${percentile(frameSamples, .99).toFixed(2)} ms`,
    `wasm CPU frame: ${(lastStats.cpuMs ?? 0).toFixed(3)} ms`,
    `LOD: ${lastStats.lod ?? 0}  draw calls: ${lastStats.drawCalls ?? 0}`,
    `tiles visible/resident/new: ${lastStats.visibleTiles ?? 0} / ${lastStats.residentTiles ?? 0} / ${lastStats.generatedTiles ?? 0}`,
    `tile GPU memory(est): ${mib.toFixed(1)} MiB`,
    `camera: (${(lastStats.centerX ?? 0).toFixed(1)}, ${(lastStats.centerZ ?? 0).toFixed(1)})`,
    `pixels/cell: ${(lastStats.pixelsPerCell ?? 0).toFixed(4)}`,
  ].join('\n');
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
