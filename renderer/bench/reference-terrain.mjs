import fs from 'node:fs';

const TERRAIN_HEIGHT_MAX = 10;
const NOISE_OCTAVES = [[40, 1], [20, 0.5], [10, 0.25], [5, 0.125]];
const AMPLITUDE_SUM = 1.875;
const FLATLAND_THRESHOLD = 0.55;
const WATER_THRESHOLD = 0.15;
const HEIGHT_GAIN = 11;

const hashLattice = (seed, x, z) => {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

const deriveOctaveSeed = (seed, index) => {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};

const smoothstep01 = t => t * t * (3 - 2 * t);
const valueNoise = (seed, x, z, wave) => {
  const gx = Math.floor(x / wave);
  const gz = Math.floor(z / wave);
  const tx = smoothstep01(x / wave - gx);
  const tz = smoothstep01(z / wave - gz);
  const v00 = hashLattice(seed, gx, gz);
  const v10 = hashLattice(seed, gx + 1, gz);
  const v01 = hashLattice(seed, gx, gz + 1);
  const v11 = hashLattice(seed, gx + 1, gz + 1);
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * tz;
};

const compositeNoise = (seed, x, z) => {
  let noise = 0;
  for (let i = 0; i < NOISE_OCTAVES.length; i++) {
    const [wave, amp] = NOISE_OCTAVES[i];
    noise += valueNoise(deriveOctaveSeed(seed, i), x, z, wave) * amp;
  }
  return noise / AMPLITUDE_SUM;
};

const cornerHeightAt = (seed, halfExtent, x, z) => {
  if (x < -halfExtent || x > halfExtent || z < -halfExtent || z > halfExtent) return 0;
  const noise = compositeNoise(seed, x, z);
  if (noise < WATER_THRESHOLD) return 0;
  const lifted = Math.max(0, noise - FLATLAND_THRESHOLD);
  return Math.min(TERRAIN_HEIGHT_MAX, Math.round(lifted * HEIGHT_GAIN));
};

const seed = Number(process.argv[2] ?? 0x12345678) >>> 0;
const count = Number(process.argv[3] ?? 1_000_000);
const halfExtent = Number(process.argv[4] ?? 8192);
const output = process.argv[5];
let state = 0x6d2b79f5 >>> 0;
let checksum = 0x811c9dc5 >>> 0;
const heights = output ? Buffer.allocUnsafe(count) : null;
for (let i = 0; i < count; i++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  const x = (state % (halfExtent * 2 + 1)) - halfExtent;
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  const z = (state % (halfExtent * 2 + 1)) - halfExtent;
  const h = cornerHeightAt(seed, halfExtent, x, z);
  if (heights) heights[i] = h;
  checksum ^= h;
  checksum = Math.imul(checksum, 16777619) >>> 0;
}
if (output) fs.writeFileSync(output, heights);
console.log(JSON.stringify({seed, count, halfExtent, checksum, output: output ?? null}));
