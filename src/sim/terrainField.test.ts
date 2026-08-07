import { describe, expect, it } from 'vitest';
import { createTerrainField, TERRAIN_HEIGHT_MAX, MOUNTAIN_HEIGHT_THRESHOLD } from './terrainField';

// mulberry32風の疑似乱数(テスト内のランダム窓サンプリング専用。地形生成の乱数とは無関係)。
const mulberry32 = (seed: number) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const HALF_EXTENT = 16384;

describe('createTerrainField', () => {
  it('is deterministic for the same seed', () => {
    const a = createTerrainField(42, HALF_EXTENT);
    const b = createTerrainField(42, HALF_EXTENT);
    for (const [x, z] of [[0, 0], [10, -5], [8000, -8000], [-100, 250]] as const) {
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
      expect(a.terrainTypeAt(x, z)).toBe(b.terrainTypeAt(x, z));
    }
  });

  it('differs across seeds', () => {
    const a = createTerrainField(1, HALF_EXTENT);
    const b = createTerrainField(2, HALF_EXTENT);
    let diffCount = 0;
    for (let x = 0; x < 200; x++) {
      for (let z = 0; z < 200; z++) {
        if (a.heightAt(x, z) !== b.heightAt(x, z)) diffCount++;
      }
    }
    expect(diffCount).toBeGreaterThan(0);
  });

  it('keeps heights within 0..TERRAIN_HEIGHT_MAX', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    for (let x = -50; x <= 50; x++) {
      for (let z = -50; z <= 50; z++) {
        const h = field.heightAt(x, z);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(TERRAIN_HEIGHT_MAX);
        expect(Number.isInteger(h)).toBe(true);
      }
    }
  });

  it('water cells always have height 0, mountain iff height >= threshold and not water', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    for (let x = -300; x <= 300; x++) {
      for (let z = -300; z <= 300; z++) {
        const h = field.heightAt(x, z);
        const t = field.terrainTypeAt(x, z);
        if (t === 'water') expect(h).toBe(0);
        if (t === 'mountain') {
          expect(h).toBeGreaterThanOrEqual(MOUNTAIN_HEIGHT_THRESHOLD);
        } else {
          expect(h < MOUNTAIN_HEIGHT_THRESHOLD || t === 'water').toBe(true);
        }
      }
    }
  });

  it('returns grass/height 0 outside the half-extent range', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    expect(field.heightAt(HALF_EXTENT + 1, 0)).toBe(0);
    expect(field.terrainTypeAt(HALF_EXTENT + 1, 0)).toBe('grass');
    expect(field.heightAt(0, -HALF_EXTENT - 100)).toBe(0);
    expect(field.terrainTypeAt(0, -HALF_EXTENT - 100)).toBe('grass');
  });

  it('is 1-Lipschitz (4-neighbour height diff <= 1) across scattered 64x64 windows, including far coordinates', () => {
    const seeds = [1, 2, 3, 42, 99];
    for (const seed of seeds) {
      const field = createTerrainField(seed, HALF_EXTENT);
      const rng = mulberry32(seed * 7919 + 13);
      // オフセットには原点付近・チャンク境界付近(64の倍数)・遠方(x≈8000)を混ぜる。
      const offsets: Array<[number, number]> = [
        [0, 0],
        [64, 64],
        [128, -64],
        [8000, 8000],
        [-8000, 3000],
        [Math.floor(rng() * 16000) - 8000, Math.floor(rng() * 16000) - 8000],
        [Math.floor(rng() * 16000) - 8000, Math.floor(rng() * 16000) - 8000],
      ];
      for (const [ox, oz] of offsets) {
        const size = 64;
        const grid: number[][] = [];
        for (let dx = 0; dx < size; dx++) {
          grid.push([]);
          for (let dz = 0; dz < size; dz++) {
            grid[dx].push(field.heightAt(ox + dx, oz + dz));
          }
        }
        for (let dx = 0; dx < size; dx++) {
          for (let dz = 0; dz < size; dz++) {
            const h = grid[dx][dz];
            if (dx + 1 < size) expect(Math.abs(grid[dx + 1][dz] - h)).toBeLessThanOrEqual(1);
            if (dz + 1 < size) expect(Math.abs(grid[dx][dz + 1] - h)).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('is mostly flat plains with some mountains and some water over a large window', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    let flat = 0;
    let mountain = 0;
    let water = 0;
    const size = 400;
    for (let x = -size; x < size; x++) {
      for (let z = -size; z < size; z++) {
        const h = field.heightAt(x, z);
        const t = field.terrainTypeAt(x, z);
        if (h === 0 && t === 'grass') flat++;
        if (t === 'mountain') mountain++;
        if (t === 'water') water++;
      }
    }
    const total = (2 * size) * (2 * size);
    expect(flat / total).toBeGreaterThan(0.5);
    expect(mountain).toBeGreaterThan(0);
    expect(water).toBeGreaterThan(0);
  });

  it('computes a 64x64 window well under 50ms', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    const start = Date.now();
    for (let x = 0; x < 64; x++) {
      for (let z = 0; z < 64; z++) {
        field.heightAt(8000 + x, 8000 + z);
      }
    }
    expect(Date.now() - start).toBeLessThan(50);
  });
});
