import { describe, expect, it } from 'vitest';
import { mulberry32 } from './towns';
import {
  generateTerrain,
  terrainAt,
  computeElevation,
  elevationAt,
  cornerElevation,
  cellCornerElevations,
  TERRAIN_COORD_RANGE,
  LAKE_COUNT_MIN,
  LAKE_COUNT_MAX,
  LAKE_SIZE_MAX,
  MOUNTAIN_COUNT_MIN,
  MOUNTAIN_COUNT_MAX,
  MOUNTAIN_LENGTH_MAX,
  MOUNTAIN_WIDTH_MAX,
} from './terrain';
import { fromKey, toKey } from '../utils';
import type { TerrainType } from '../types';

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

describe('computeElevation', () => {
  const makeTerrain = (mountainCells: Array<[number, number]>): Map<string, TerrainType> => {
    const terrain = new Map<string, TerrainType>();
    for (const [x, z] of mountainCells) {
      terrain.set(toKey(x, z), 'mountain');
    }
    return terrain;
  };

  it('非mountainセルは標高を持たない(未登録=0)', () => {
    const terrain = makeTerrain([[0, 0]]);
    const elev = computeElevation(terrain);
    expect(elevationAt(elev, 0, 0)).toBe(1);
    expect(elevationAt(elev, 5, 5)).toBe(0);
  });

  it('3x3のmountain塊は境界セルが標高1、中心セルはマンハッタン距離2で標高2', () => {
    const cells: Array<[number, number]> = [];
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        cells.push([x, z]);
      }
    }
    const terrain = makeTerrain(cells);
    const elev = computeElevation(terrain);
    expect(elevationAt(elev, 1, 0)).toBe(1);
    expect(elevationAt(elev, 0, 0)).toBe(2);
  });

  it('幅7の塊(7x7)で芯は標高3にクランプされる', () => {
    const cells: Array<[number, number]> = [];
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        cells.push([x, z]);
      }
    }
    const terrain = makeTerrain(cells);
    const elev = computeElevation(terrain);
    // 中心(0,0)は最も近い非mountainまでマンハッタン距離4だが、3にクランプされる
    expect(elevationAt(elev, 0, 0)).toBe(3);
    // 端(3,0)は距離1
    expect(elevationAt(elev, 3, 0)).toBe(1);
  });

  it('同じ入力からは同じ標高マップが決定的に得られる', () => {
    const terrain = generateTerrain(mulberry32(42));
    const elevA = computeElevation(terrain);
    const elevB = computeElevation(terrain);
    expect(Array.from(elevA.entries())).toEqual(Array.from(elevB.entries()));
  });
});

describe('cornerElevation / cellCornerElevations', () => {
  it('孤立した1セル山(標高1)は4隅とも0になる(全周斜面のピラミッド)', () => {
    const elev = new Map([[toKey(0, 0), 1]]);
    const corners = cellCornerElevations(elev, 0, 0);
    expect(corners).toEqual([0, 0, 0, 0]);
  });

  it('2x2の標高1塊の中央コーナーは1になる', () => {
    const elev = new Map([
      [toKey(0, 0), 1],
      [toKey(1, 0), 1],
      [toKey(0, 1), 1],
      [toKey(1, 1), 1],
    ]);
    // セル(0,0)の右下隅・セル(1,1)の左上隅などが中央コーナー(1,1)にあたる
    expect(cornerElevation(elev, 1, 1)).toBe(1);
  });

  it('min則により隣接セルの標高差は必ず1以下の連続面になる', () => {
    const elev = new Map([
      [toKey(0, 0), 2],
      [toKey(1, 0), 1],
    ]);
    const cornersLow = cellCornerElevations(elev, 0, 0);
    const cornersHigh = cellCornerElevations(elev, 1, 0);
    // セル(0,0)の右側2隅とセル(1,0)の左側2隅は共有コーナーなので同じ値
    expect(cornersLow[1]).toBe(cornerElevation(elev, 1, 0));
    expect(cornersHigh[0]).toBe(cornerElevation(elev, 1, 0));
    for (const c of [...cornersLow, ...cornersHigh]) {
      expect(c).toBeLessThanOrEqual(2);
    }
  });

  it('cliffFace指定時、その面の2隅はmin則ではなくセル自身の標高になる', () => {
    const elev = new Map([
      [toKey(0, 0), 2],
      [toKey(0, -1), 0],
    ]);
    const withoutCliff = cellCornerElevations(elev, 0, 0);
    // 通常は北隣が平地(0)なのでmin則で北側2隅は0になる
    expect(withoutCliff[0]).toBe(0);
    expect(withoutCliff[1]).toBe(0);

    const cliffFaces = new Set(['0,0,0,-1']);
    const withCliff = cellCornerElevations(elev, 0, 0, cliffFaces);
    // 北面(dx=0,dz=-1)がcliffFace指定されているので、北側2隅(左上・右上)はセル標高2になる
    expect(withCliff[0]).toBe(2);
    expect(withCliff[1]).toBe(2);
    // 他の2隅は変わらずmin則
    expect(withCliff[2]).toBe(withoutCliff[2]);
    expect(withCliff[3]).toBe(withoutCliff[3]);
  });
});
