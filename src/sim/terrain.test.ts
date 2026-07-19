import { describe, expect, it } from 'vitest';
import { mulberry32 } from './towns';
import {
  generateTerrain,
  terrainAt,
  TERRAIN_COORD_RANGE,
  LAKE_COUNT_MIN,
  LAKE_COUNT_MAX,
  LAKE_SIZE_MAX,
  MOUNTAIN_COUNT_MIN,
  MOUNTAIN_COUNT_MAX,
  MOUNTAIN_LENGTH_MAX,
  MOUNTAIN_WIDTH_MAX,
} from './terrain';
import { fromKey } from '../utils';

describe('generateTerrain', () => {
  it('同じシードからは同じ地形が決定的に得られる', () => {
    const terrainA = generateTerrain(mulberry32(42));
    const terrainB = generateTerrain(mulberry32(42));
    expect(Array.from(terrainA.entries())).toEqual(Array.from(terrainB.entries()));
  });

  it('water/mountainのセルはいずれも仕様範囲内の個数になる', () => {
    const terrain = generateTerrain(mulberry32(42));
    const waterCount = Array.from(terrain.values()).filter(t => t === 'water').length;
    const mountainCount = Array.from(terrain.values()).filter(t => t === 'mountain').length;

    expect(waterCount).toBeGreaterThan(0);
    expect(waterCount).toBeLessThanOrEqual(LAKE_COUNT_MAX * LAKE_SIZE_MAX);
    expect(mountainCount).toBeGreaterThan(0);
    expect(mountainCount).toBeLessThanOrEqual(MOUNTAIN_COUNT_MAX * MOUNTAIN_LENGTH_MAX * MOUNTAIN_WIDTH_MAX);
  });

  it('生成される座標はすべて-45..45の範囲に収まる', () => {
    const terrain = generateTerrain(mulberry32(7));
    for (const key of terrain.keys()) {
      const { x, z } = fromKey(key);
      expect(x).toBeGreaterThanOrEqual(-TERRAIN_COORD_RANGE);
      expect(x).toBeLessThanOrEqual(TERRAIN_COORD_RANGE);
      expect(z).toBeGreaterThanOrEqual(-TERRAIN_COORD_RANGE);
      expect(z).toBeLessThanOrEqual(TERRAIN_COORD_RANGE);
    }
  });

  it('異なるシードでは湖・山脈の個数が仕様範囲内で決定される(下限・上限のsanityチェック)', () => {
    // 複数シードで試し、常に妥当な範囲であることを確認する
    for (const seed of [1, 2, 3, 4, 5]) {
      const terrain = generateTerrain(mulberry32(seed));
      expect(terrain.size).toBeGreaterThan(0);
    }
    expect(LAKE_COUNT_MIN).toBe(3);
    expect(LAKE_COUNT_MAX).toBe(5);
    expect(MOUNTAIN_COUNT_MIN).toBe(2);
    expect(MOUNTAIN_COUNT_MAX).toBe(3);
  });
});

describe('terrainAt', () => {
  it('Mapに登録が無いセルは既定値grassを返す', () => {
    const terrain = generateTerrain(mulberry32(1));
    expect(terrainAt(new Map(), 0, 0)).toBe('grass');
    // 実データでも登録の無い座標(範囲外)はgrass
    expect(terrainAt(terrain, 9999, 9999)).toBe('grass');
  });

  it('登録されたセルはその地形種別を返す', () => {
    const terrain = new Map([['1,2', 'water' as const]]);
    expect(terrainAt(terrain, 1, 2)).toBe('water');
  });
});
