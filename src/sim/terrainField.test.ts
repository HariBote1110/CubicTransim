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
      expect(a.cornerHeightAt(x, z)).toBe(b.cornerHeightAt(x, z));
      expect(a.cellHeightAt(x, z)).toBe(b.cellHeightAt(x, z));
      expect(a.terrainTypeAt(x, z)).toBe(b.terrainTypeAt(x, z));
    }
  });

  it('differs across seeds', () => {
    const a = createTerrainField(1, HALF_EXTENT);
    const b = createTerrainField(2, HALF_EXTENT);
    let diffCount = 0;
    for (let x = 0; x < 200; x++) {
      for (let z = 0; z < 200; z++) {
        if (a.cornerHeightAt(x, z) !== b.cornerHeightAt(x, z)) diffCount++;
      }
    }
    expect(diffCount).toBeGreaterThan(0);
  });

  it('keeps corner heights within 0..TERRAIN_HEIGHT_MAX', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    for (let x = -50; x <= 50; x++) {
      for (let z = -50; z <= 50; z++) {
        const h = field.cornerHeightAt(x, z);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(TERRAIN_HEIGHT_MAX);
        expect(Number.isInteger(h)).toBe(true);
      }
    }
  });

  it('cellCornerHeights returns [nw, ne, sw, se] matching cornerHeightAt at (x,z)/(x+1,z)/(x,z+1)/(x+1,z+1)', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    for (const [x, z] of [[0, 0], [12, -7], [8000, 8000]] as const) {
      const [nw, ne, sw, se] = field.cellCornerHeights(x, z);
      expect(nw).toBe(field.cornerHeightAt(x, z));
      expect(ne).toBe(field.cornerHeightAt(x + 1, z));
      expect(sw).toBe(field.cornerHeightAt(x, z + 1));
      expect(se).toBe(field.cornerHeightAt(x + 1, z + 1));
    }
  });

  it('cellHeightAt is the min of the 4 corners', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    for (const [x, z] of [[0, 0], [12, -7], [8000, 8000], [-300, 150]] as const) {
      const [nw, ne, sw, se] = field.cellCornerHeights(x, z);
      expect(field.cellHeightAt(x, z)).toBe(Math.min(nw, ne, sw, se));
    }
  });

  it('water cells have all 4 corners at height 0, mountain iff cellHeightAt >= threshold and not water', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    for (let x = -300; x <= 300; x++) {
      for (let z = -300; z <= 300; z++) {
        const h = field.cellHeightAt(x, z);
        const t = field.terrainTypeAt(x, z);
        if (t === 'water') {
          expect(field.cellCornerHeights(x, z)).toEqual([0, 0, 0, 0]);
        }
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
    expect(field.cornerHeightAt(HALF_EXTENT + 1, 0)).toBe(0);
    expect(field.cellHeightAt(HALF_EXTENT + 1, 0)).toBe(0);
    expect(field.terrainTypeAt(HALF_EXTENT + 1, 0)).toBe('grass');
    expect(field.cornerHeightAt(0, -HALF_EXTENT - 100)).toBe(0);
    expect(field.terrainTypeAt(0, -HALF_EXTENT - 100)).toBe('grass');
  });

  it('is 1-Lipschitz on the vertex lattice (4-neighbour corner height diff <= 1) across scattered 64x64 windows, including far coordinates', () => {
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
            grid[dx].push(field.cornerHeightAt(ox + dx, oz + dz));
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
        const h = field.cellHeightAt(x, z);
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

  it('computes a 64x64 window of corner heights well under 50ms', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    const start = Date.now();
    for (let x = 0; x < 64; x++) {
      for (let z = 0; z < 64; z++) {
        field.cornerHeightAt(8000 + x, 8000 + z);
      }
    }
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('createTerrainField batch corner grid (P9a)', () => {
  it('cornerGridFor matches per-corner cornerHeightAt over random windows', () => {
    const field = createTerrainField(11, HALF_EXTENT);
    const rng = mulberry32(99);
    for (let trial = 0; trial < 20; trial++) {
      const x0 = Math.floor((rng() - 0.5) * 16000);
      const z0 = Math.floor((rng() - 0.5) * 16000);
      const w = 1 + Math.floor(rng() * 40);
      const h = 1 + Math.floor(rng() * 40);
      const grid = field.cornerGridFor!(x0, z0, w, h);
      const gh = h + 1;
      for (let lx = 0; lx <= w; lx++) {
        for (let lz = 0; lz <= h; lz++) {
          expect(grid[lx * gh + lz]).toBe(field.cornerHeightAt(x0 + lx, z0 + lz));
        }
      }
    }
  });

  it('cornerGridFor matches per-corner heights at map-edge / out-of-range windows', () => {
    const field = createTerrainField(11, 40);
    const grid = field.cornerGridFor!(30, 30, 20, 20);
    const gh = 21;
    for (let lx = 0; lx <= 20; lx++) {
      for (let lz = 0; lz <= 20; lz++) {
        expect(grid[lx * gh + lz]).toBe(field.cornerHeightAt(30 + lx, 30 + lz));
      }
    }
  });

  it('waterCornerGridFor matches the terrainTypeAt-derived water vertex definition', () => {
    const field = createTerrainField(11, HALF_EXTENT);
    const x0 = 100;
    const z0 = -50;
    const w = 32;
    const h = 32;
    const grid = field.waterCornerGridFor!(x0, z0, w, h);
    const gh = h + 1;
    for (let lx = 0; lx <= w; lx++) {
      for (let lz = 0; lz <= h; lz++) {
        const x = x0 + lx;
        const z = z0 + lz;
        const cells: ReadonlyArray<[number, number]> = [[x - 1, z - 1], [x, z - 1], [x - 1, z], [x, z]];
        const expected = cells.every(([cx, cz]) => field.terrainTypeAt(cx, cz) === 'water') ? 1 : 0;
        expect(grid[lx * gh + lz]).toBe(expected);
      }
    }
  });

  it('computes a 33x33 corner grid well under 1ms (median of several calls)', () => {
    const field = createTerrainField(7, HALF_EXTENT);
    // JITウォームアップ
    field.cornerGridFor!(0, 0, 32, 32);
    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const start = performance.now();
      field.cornerGridFor!(8000 + i * 32, 8000 + i * 32, 32, 32);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(1);
  });
});

describe('createTerrainField: 地形プロファイル', () => {
  it('プロファイル省略時はnormalと完全に同じ地形になる', () => {
    const implicit = createTerrainField(42, HALF_EXTENT);
    const explicitNormal = createTerrainField(42, HALF_EXTENT, 'normal');
    for (let x = -80; x <= 80; x += 3) {
      for (let z = -80; z <= 80; z += 3) {
        expect(explicitNormal.cornerHeightAt(x, z), `(${x},${z})`).toBe(implicit.cornerHeightAt(x, z));
        expect(explicitNormal.terrainTypeAt(x, z), `(${x},${z})`).toBe(implicit.terrainTypeAt(x, z));
      }
    }
  });

  it('同じseedで 平坦 <= 標準 <= 山がち の標高になり、山がちは平坦よりずっと起伏が多い', () => {
    const seed = 20260809;
    const flat = createTerrainField(seed, HALF_EXTENT, 'flat');
    const normal = createTerrainField(seed, HALF_EXTENT, 'normal');
    const mountain = createTerrainField(seed, HALF_EXTENT, 'mountain');
    let flatRaised = 0;
    let normalRaised = 0;
    let mountainRaised = 0;
    let total = 0;
    for (let x = -150; x <= 150; x++) {
      for (let z = -150; z <= 150; z++) {
        const f = flat.cornerHeightAt(x, z);
        const n = normal.cornerHeightAt(x, z);
        const m = mountain.cornerHeightAt(x, z);
        expect(f, `(${x},${z})`).toBeLessThanOrEqual(n);
        expect(n, `(${x},${z})`).toBeLessThanOrEqual(m);
        if (f > 0) flatRaised++;
        if (n > 0) normalRaised++;
        if (m > 0) mountainRaised++;
        total++;
      }
    }
    // 平坦は広大な平野が支配的、山がちは過半が起伏、どちらも極端(0%/100%)にはならない。
    expect(flatRaised / total).toBeLessThan(0.2);
    expect(flatRaised / total).toBeGreaterThan(0);
    expect(mountainRaised / total).toBeGreaterThan(0.45);
    expect(mountainRaised / total).toBeLessThan(0.9);
    expect(normalRaised).toBeGreaterThan(flatRaised);
    expect(mountainRaised).toBeGreaterThan(normalRaised);
  });

  it('全プロファイルで頂点格子が1-Lipschitz(隣接コーナー標高差1以下、100万ペア超)', () => {
    const seeds = [1, 7, 42, 0xdead, 20260809];
    const size = 128;
    for (const profile of ['flat', 'normal', 'mountain'] as const) {
      let pairs = 0;
      for (const seed of seeds) {
        const field = createTerrainField(seed, HALF_EXTENT, profile);
        const rng = mulberry32(seed * 7919 + 13);
        const offsets: Array<[number, number]> = [
          [0, 0],
          [64, -64],
          [8000, 8000],
          [-8000, 3000],
          [Math.floor(rng() * 16000) - 8000, Math.floor(rng() * 16000) - 8000],
          [Math.floor(rng() * 16000) - 8000, Math.floor(rng() * 16000) - 8000],
          [Math.floor(rng() * 16000) - 8000, Math.floor(rng() * 16000) - 8000],
        ];
        for (const [ox, oz] of offsets) {
          const grid = field.cornerGridFor!(ox, oz, size, size);
          const gh = size + 1;
          for (let lx = 0; lx <= size; lx++) {
            for (let lz = 0; lz <= size; lz++) {
              const h = grid[lx * gh + lz];
              if (lx < size) {
                expect(Math.abs(grid[(lx + 1) * gh + lz] - h), `${profile} x (${ox + lx},${oz + lz})`).toBeLessThanOrEqual(1);
                pairs++;
              }
              if (lz < size) {
                expect(Math.abs(grid[lx * gh + lz + 1] - h), `${profile} z (${ox + lx},${oz + lz})`).toBeLessThanOrEqual(1);
                pairs++;
              }
            }
          }
        }
      }
      expect(pairs, profile).toBeGreaterThan(1_000_000);
    }
  });

  it('全プロファイルで水セルの4隅は必ず標高0(水域しきい値 < 標高1しきい値)', () => {
    for (const profile of ['flat', 'normal', 'mountain'] as const) {
      const field = createTerrainField(7, HALF_EXTENT, profile);
      for (let x = -250; x <= 250; x++) {
        for (let z = -250; z <= 250; z++) {
          if (field.terrainTypeAt(x, z) === 'water') {
            expect(field.cellCornerHeights(x, z), `${profile} (${x},${z})`).toEqual([0, 0, 0, 0]);
          }
        }
      }
    }
  });

  it('全プロファイルでバッチAPIの格子が cornerHeightAt と一致する', () => {
    for (const profile of ['flat', 'normal', 'mountain'] as const) {
      const field = createTerrainField(99, HALF_EXTENT, profile);
      const grid = field.cornerGridFor!(-33, 77, 32, 32);
      for (let lx = 0; lx <= 32; lx++) {
        for (let lz = 0; lz <= 32; lz++) {
          expect(grid[lx * 33 + lz], `${profile} (${lx},${lz})`).toBe(field.cornerHeightAt(-33 + lx, 77 + lz));
        }
      }
    }
  });
});
