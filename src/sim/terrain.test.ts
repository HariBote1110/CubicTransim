import { describe, expect, it } from 'vitest';
import { mulberry32 } from './towns';
import {
  generateMap,
  generateHeights,
  normaliseHeights,
  terrainAt,
  computeElevation,
  elevationAt,
  cornerElevation,
  cellCornerElevations,
  buildCornerElevationMap,
  cellCornersFromMap,
  TERRAIN_COORD_RANGE,
  TERRAIN_HEIGHT_MAX,
  MOUNTAIN_HEIGHT_THRESHOLD,
  LAKE_COUNT_MIN,
  LAKE_COUNT_MAX,
  LAKE_SIZE_MAX,
} from './terrain';
import { fromKey, toKey } from '../utils';
import type { TerrainType } from '../types';

// 4近傍の標高差がすべて1以下(1-Lipschitz)であることを検証するヘルパー。
// 未登録セル(マップ外含む)は標高0として扱うため、登録セルの周囲も必ず確認する。
const expectLipschitz = (heights: Map<string, number>): void => {
  for (const [key, h] of heights) {
    const { x, z } = fromKey(key);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nh = heights.get(toKey(x + dx, z + dz)) ?? 0;
      expect(Math.abs(h - nh)).toBeLessThanOrEqual(1);
    }
  }
};

describe('generateHeights', () => {
  it('同じシードからは同じ標高マップが決定的に得られる', () => {
    const a = generateHeights(mulberry32(42));
    const b = generateHeights(mulberry32(42));
    expect(Array.from(a.entries())).toEqual(Array.from(b.entries()));
  });

  it('標高は1以上TERRAIN_HEIGHT_MAX以下の整数のみを登録する(0は未登録で表す)', () => {
    const heights = generateHeights(mulberry32(7));
    expect(heights.size).toBeGreaterThan(0);
    for (const h of heights.values()) {
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(1);
      expect(h).toBeLessThanOrEqual(TERRAIN_HEIGHT_MAX);
    }
  });

  it('生成される座標はすべて-45..45の範囲に収まる', () => {
    const heights = generateHeights(mulberry32(3));
    for (const key of heights.keys()) {
      const { x, z } = fromKey(key);
      expect(Math.abs(x)).toBeLessThanOrEqual(TERRAIN_COORD_RANGE);
      expect(Math.abs(z)).toBeLessThanOrEqual(TERRAIN_COORD_RANGE);
    }
  });
});

describe('normaliseHeights', () => {
  it('どの4近傍間も標高差1以下(1-Lipschitz)になる(ランダム入力のプロパティテスト)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = mulberry32(seed * 101);
      const raw = new Map<string, number>();
      for (let i = 0; i < 400; i++) {
        const x = Math.floor(rng() * 41) - 20;
        const z = Math.floor(rng() * 41) - 20;
        raw.set(toKey(x, z), Math.floor(rng() * (TERRAIN_HEIGHT_MAX + 1)));
      }
      const normalised = normaliseHeights(raw, 20);
      expectLipschitz(normalised);
    }
  });

  it('標高を持ち上げることはない(引き下げのみで整合させる)', () => {
    const raw = new Map<string, number>([
      [toKey(0, 0), 10],
      [toKey(5, 5), 4],
    ]);
    const normalised = normaliseHeights(raw, 10);
    for (const [key, h] of normalised) {
      expect(h).toBeLessThanOrEqual(raw.get(key) ?? 0);
    }
  });

  it('孤立した高いセルは周囲0との差が1になるまで引き下げられる', () => {
    const raw = new Map<string, number>([[toKey(0, 0), 10]]);
    const normalised = normaliseHeights(raw, 10);
    expect(normalised.get(toKey(0, 0))).toBe(1);
  });

  it('既に1-Lipschitzな入力は変化しない(冪等)', () => {
    // 十字型: 中心2、4近傍1、その外は0 — どの隣接段差も1以下。
    const raw = new Map<string, number>([
      [toKey(0, 0), 2],
      [toKey(1, 0), 1],
      [toKey(-1, 0), 1],
      [toKey(0, 1), 1],
      [toKey(0, -1), 1],
    ]);
    const once = normaliseHeights(raw, 10);
    const twice = normaliseHeights(once, 10);
    expect(Array.from(once.entries()).sort()).toEqual(Array.from(raw.entries()).sort());
    expect(Array.from(twice.entries()).sort()).toEqual(Array.from(once.entries()).sort());
  });

  it('標高0のセルはマップに登録しない(未登録=0の規約を保つ)', () => {
    const raw = new Map<string, number>([
      [toKey(0, 0), 0],
      [toKey(1, 0), 1],
    ]);
    const normalised = normaliseHeights(raw, 10);
    expect(normalised.has(toKey(0, 0))).toBe(false);
    expect(normalised.get(toKey(1, 0))).toBe(1);
  });
});

describe('generateMap', () => {
  it('同じシードからは同じ地形・標高が決定的に得られる', () => {
    const a = generateMap(mulberry32(42));
    const b = generateMap(mulberry32(42));
    expect(Array.from(a.terrain.entries())).toEqual(Array.from(b.terrain.entries()));
    expect(Array.from(a.heights.entries())).toEqual(Array.from(b.heights.entries()));
  });

  it('標高は1-Lipschitz(隣接段差1以下)を満たす', () => {
    for (const seed of [1, 42, 2026]) {
      const { heights } = generateMap(mulberry32(seed));
      expectLipschitz(heights);
    }
  });

  it('waterセルの標高は必ず0(未登録)になる', () => {
    for (const seed of [1, 42, 2026]) {
      const { terrain, heights } = generateMap(mulberry32(seed));
      for (const [key, type] of terrain) {
        if (type === 'water') expect(heights.has(key)).toBe(false);
      }
    }
  });

  it('mountainセルと「標高がMOUNTAIN_HEIGHT_THRESHOLD以上のセル」は一致する', () => {
    const { terrain, heights } = generateMap(mulberry32(42));
    for (const [key, h] of heights) {
      if (h >= MOUNTAIN_HEIGHT_THRESHOLD) {
        expect(terrain.get(key)).toBe('mountain');
      }
    }
    for (const [key, type] of terrain) {
      if (type === 'mountain') {
        expect(heights.get(key) ?? 0).toBeGreaterThanOrEqual(MOUNTAIN_HEIGHT_THRESHOLD);
      }
    }
  });

  it('がっつり高低差: 標高6以上のセルが必ず存在する', () => {
    for (const seed of [1, 2, 3, 42, 2026]) {
      const { heights } = generateMap(mulberry32(seed));
      const max = Math.max(...heights.values());
      expect(max).toBeGreaterThanOrEqual(6);
    }
  });

  it('駅・車庫・街を置ける平地(標高0の陸地)が十分に残る(全セルの30%以上)', () => {
    for (const seed of [1, 2, 3, 42, 2026]) {
      const { terrain, heights } = generateMap(mulberry32(seed));
      const side = TERRAIN_COORD_RANGE * 2 + 1;
      const total = side * side;
      let flatLand = 0;
      for (let x = -TERRAIN_COORD_RANGE; x <= TERRAIN_COORD_RANGE; x++) {
        for (let z = -TERRAIN_COORD_RANGE; z <= TERRAIN_COORD_RANGE; z++) {
          const key = toKey(x, z);
          if (!heights.has(key) && terrain.get(key) !== 'water') flatLand++;
        }
      }
      expect(flatLand / total).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('waterセルは仕様範囲内の個数になる(湖は従来通り生成される)', () => {
    const { terrain } = generateMap(mulberry32(42));
    const waterCount = Array.from(terrain.values()).filter(t => t === 'water').length;
    expect(waterCount).toBeGreaterThan(0);
    expect(waterCount).toBeLessThanOrEqual(LAKE_COUNT_MAX * LAKE_SIZE_MAX);
    expect(LAKE_COUNT_MIN).toBe(3);
  });

  it('生成される座標はすべて-45..45の範囲に収まる', () => {
    const { terrain, heights } = generateMap(mulberry32(7));
    for (const key of [...terrain.keys(), ...heights.keys()]) {
      const { x, z } = fromKey(key);
      expect(Math.abs(x)).toBeLessThanOrEqual(TERRAIN_COORD_RANGE);
      expect(Math.abs(z)).toBeLessThanOrEqual(TERRAIN_COORD_RANGE);
    }
  });
});

describe('terrainAt', () => {
  it('Mapに登録が無いセルは既定値grassを返す', () => {
    const { terrain } = generateMap(mulberry32(1));
    expect(terrainAt(new Map(), 0, 0)).toBe('grass');
    // 実データでも登録の無い座標(範囲外)はgrass
    expect(terrainAt(terrain, 9999, 9999)).toBe('grass');
  });

  it('登録されたセルはその地形種別を返す', () => {
    const terrain = new Map([['1,2', 'water' as const]]);
    expect(terrainAt(terrain, 1, 2)).toBe('water');
  });
});

// computeElevationは旧セーブ(v13以前: heights無し)の移行専用として残している。
describe('computeElevation (旧セーブ移行用)', () => {
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
    const { terrain } = generateMap(mulberry32(42));
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

  it('坑口面(cliffFaces)は撤去済みのため、mountainセルの標高が高くても自然な斜面(min則)のまま持ち上がらない', () => {
    // かつてはcliffFacesで坑口面のコーナーを人工的に持ち上げていたが、
    // OpenTTD風に「斜面へ掘り込む」見た目へ再設計したため、坑口面も常にmin則の
    // 自然な標高になる(垂直の崖にはしない)。
    const elev = new Map([
      [toKey(0, 0), 2],
      [toKey(0, -1), 0],
    ]);
    const corners = cellCornerElevations(elev, 0, 0);
    // 北隣が平地(0)なのでmin則で北側2隅は0のまま
    expect(corners[0]).toBe(0);
    expect(corners[1]).toBe(0);
  });
});

describe('buildCornerElevationMap / cellCornersFromMap', () => {
  it('共有コーナーは隣接セル側から見ても同じ値になる(裂け目が出ない)', () => {
    const elev = new Map([
      [toKey(0, 0), 2],
      [toKey(1, 0), 1],
    ]);

    const map = buildCornerElevationMap(elev);
    const cellA = cellCornersFromMap(map, 0, 0);
    const cellB = cellCornersFromMap(map, 1, 0);

    // セル(0,0)の右上隅とセル(1,0)の左上隅は同じコーナー(1,0)を指す。
    expect(cellA[1]).toBe(cornerElevation(elev, 1, 0));
    expect(cellB[0]).toBe(cornerElevation(elev, 1, 0));
    expect(cellA[1]).toBe(cellB[0]);
  });

  it('cellCornerElevations(旧API)はbuildCornerElevationMap+cellCornersFromMapで置き換えても既存の結果と一致する', () => {
    const elev = new Map([
      [toKey(0, 0), 2],
      [toKey(1, 0), 1],
      [toKey(0, 1), 1],
      [toKey(1, 1), 1],
    ]);

    const viaLegacyApi = cellCornerElevations(elev, 0, 0);
    const map = buildCornerElevationMap(elev);
    const viaSharedMap = cellCornersFromMap(map, 0, 0);

    expect(viaLegacyApi).toEqual(viaSharedMap);
  });
});
