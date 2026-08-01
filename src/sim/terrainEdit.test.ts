// OpenTTD風の地形編集(盛土/切土)のテスト。
// applyTerrainEditは「選択セルを±1段」した上で1-Lipschitz(4近傍の段差1以下)を
// 方向つき伝播(盛土=引き上げ伝播/切土=引き下げ伝播)で回復する。
// 影響セル(伝播で動くセルを含む)に線路・町・水域・範囲外が絡む場合は編集全体をno-opにする。
import { describe, it, expect } from 'vitest';
import { applyTerrainEdit, rectCells } from './terrainEdit';
import type { TerrainEditMode } from './terrainEdit';
import { TERRAIN_HEIGHT_MAX, MOUNTAIN_HEIGHT_THRESHOLD, normaliseHeights } from './terrain';
import { TERRAIN_EDIT_COST, costOfTerrainEdit } from './economy';
import { mulberry32 } from './towns';
import { toKey, fromKey } from '../utils';
import type { CellData, TerrainType } from '../types';
import type { TownTileIndex } from './townTiles';

const emptyRail = new Map<string, CellData>();
const emptyTown: TownTileIndex = new Map();

const edit = (
  heights: Map<string, number>,
  cells: { x: number; z: number }[],
  mode: TerrainEditMode,
  opts: {
    terrain?: Map<string, TerrainType>;
    railMap?: Map<string, CellData>;
    townTiles?: TownTileIndex;
    range?: number;
  } = {}
) =>
  applyTerrainEdit(
    heights,
    opts.terrain ?? new Map(),
    opts.railMap ?? emptyRail,
    opts.townTiles ?? emptyTown,
    cells,
    mode,
    opts.range
  );

// 4近傍の段差が全域で1以下か(範囲外=0の固定点も含めて)を確かめる。
const isLipschitz = (heights: Map<string, number>, range: number): boolean => {
  const at = (x: number, z: number): number =>
    x < -range || x > range || z < -range || z > range ? 0 : heights.get(toKey(x, z)) ?? 0;
  for (let x = -range - 1; x <= range + 1; x++) {
    for (let z = -range - 1; z <= range + 1; z++) {
      if (Math.abs(at(x, z) - at(x + 1, z)) > 1) return false;
      if (Math.abs(at(x, z) - at(x, z + 1)) > 1) return false;
    }
  }
  return true;
};

describe('rectCells: 矩形選択のセル列', () => {
  it('対角2点から矩形内の全セルを返す(座標の大小順によらない)', () => {
    const cells = rectCells({ x: 2, z: 3 }, { x: 0, z: 1 });
    expect(cells).toHaveLength(9);
    for (let x = 0; x <= 2; x++) {
      for (let z = 1; z <= 3; z++) {
        expect(cells).toContainEqual({ x, z });
      }
    }
  });

  it('同一点なら1セルだけ返す', () => {
    expect(rectCells({ x: 5, z: -2 }, { x: 5, z: -2 })).toEqual([{ x: 5, z: -2 }]);
  });

  it('直線(1行)の矩形も扱える', () => {
    expect(rectCells({ x: 0, z: 0 }, { x: 3, z: 0 })).toEqual([
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 },
    ]);
  });
});

describe('applyTerrainEdit: 基本の盛土/切土', () => {
  it('平地のセルを盛土すると+1段になり、changedCellsに載る', () => {
    const heights = new Map<string, number>();
    const result = edit(heights, [{ x: 0, z: 0 }], 'raise');
    expect(result.heights.get('0,0')).toBe(1);
    expect(result.changedCells).toEqual(['0,0']);
    // 元のマップは変更しない(イミュータブル)
    expect(heights.size).toBe(0);
  });

  it('高さ1のセルを切土すると0段になり、キーがマップから消える(未登録=0の規約)', () => {
    const heights = new Map<string, number>([['0,0', 1]]);
    const result = edit(heights, [{ x: 0, z: 0 }], 'lower');
    expect(result.heights.has('0,0')).toBe(false);
    expect(result.changedCells).toEqual(['0,0']);
    expect(heights.get('0,0')).toBe(1);
  });

  it('矩形の複数セルをまとめて盛土できる', () => {
    const heights = new Map<string, number>();
    const result = edit(heights, rectCells({ x: 0, z: 0 }, { x: 1, z: 1 }), 'raise');
    expect(result.heights.get('0,0')).toBe(1);
    expect(result.heights.get('1,0')).toBe(1);
    expect(result.heights.get('0,1')).toBe(1);
    expect(result.heights.get('1,1')).toBe(1);
    expect(result.changedCells).toHaveLength(4);
  });

  it('TERRAIN_HEIGHT_MAXのセルの盛土は変化なし(同一参照のno-op)', () => {
    const start = new Map<string, number>();
    // 中央をMAXまで積み上げた正規のピラミッドを作る
    for (let x = -TERRAIN_HEIGHT_MAX; x <= TERRAIN_HEIGHT_MAX; x++) {
      for (let z = -TERRAIN_HEIGHT_MAX; z <= TERRAIN_HEIGHT_MAX; z++) {
        const h = Math.max(0, TERRAIN_HEIGHT_MAX - (Math.abs(x) + Math.abs(z)));
        if (h > 0) start.set(toKey(x, z), h);
      }
    }
    const terrain = new Map<string, TerrainType>();
    const result = edit(start, [{ x: 0, z: 0 }], 'raise', { terrain });
    expect(result.heights).toBe(start);
    expect(result.terrain).toBe(terrain);
    expect(result.changedCells).toEqual([]);
  });

  it('高さ0のセルの切土は変化なし(同一参照のno-op)', () => {
    const heights = new Map<string, number>();
    const terrain = new Map<string, TerrainType>();
    const result = edit(heights, [{ x: 3, z: 3 }], 'lower', { terrain });
    expect(result.heights).toBe(heights);
    expect(result.terrain).toBe(terrain);
    expect(result.changedCells).toEqual([]);
  });

  it('一部が上限でも、残りのセルが変化するなら編集は成立する', () => {
    // (0,0)=1・(1,0)=0 を両方盛土: (0,0)→2, (1,0)→1
    const heights = new Map<string, number>([['0,0', 1]]);
    const result = edit(heights, [{ x: 0, z: 0 }, { x: 1, z: 0 }], 'raise');
    expect(result.heights.get('0,0')).toBe(2);
    expect(result.heights.get('1,0')).toBe(1);
  });
});

describe('applyTerrainEdit: 段差1以下への伝播(カスケード)', () => {
  it('盛土で段差2ができる場合、隣接セルも引き上げられる', () => {
    // (0,0)=1(周囲は0)。もう1段盛ると、4近傍が0のままでは段差2になるため1へ引き上がる。
    const heights = new Map<string, number>([['0,0', 1]]);
    const result = edit(heights, [{ x: 0, z: 0 }], 'raise');
    expect(result.heights.get('0,0')).toBe(2);
    expect(result.heights.get('1,0')).toBe(1);
    expect(result.heights.get('-1,0')).toBe(1);
    expect(result.heights.get('0,1')).toBe(1);
    expect(result.heights.get('0,-1')).toBe(1);
    expect(result.changedCells).toHaveLength(5);
    expect(isLipschitz(result.heights, 45)).toBe(true);
  });

  it('切土で段差2ができる場合、隣接セルも連鎖的に引き下げられる', () => {
    // (2,0)を頂点とする高さ3の円錐(マンハッタン距離)。裾の(0,0)を切土すると
    // 稜線に沿って(1,0)・(2,0)も1段ずつ下がる。
    const heights = new Map<string, number>();
    for (let x = -2; x <= 6; x++) {
      for (let z = -4; z <= 4; z++) {
        const h = Math.max(0, 3 - (Math.abs(x - 2) + Math.abs(z)));
        if (h > 0) heights.set(toKey(x, z), h);
      }
    }
    expect(isLipschitz(heights, 45)).toBe(true);
    const result = edit(heights, [{ x: 0, z: 0 }], 'lower');
    expect(result.heights.has('0,0')).toBe(false);
    expect(result.heights.get('1,0')).toBe(1);
    expect(result.heights.get('2,0')).toBe(2);
    expect(result.changedCells).toHaveLength(3);
    expect(isLipschitz(result.heights, 45)).toBe(true);
  });

  it('プロパティ: ランダム地形へのランダム編集後も常に1-Lipschitzかつ0..MAXに収まる', () => {
    const rng = mulberry32(20260801);
    const range = 8;
    // ランダムな生の標高を正規化して初期地形にする
    const raw = new Map<string, number>();
    for (let x = -range; x <= range; x++) {
      for (let z = -range; z <= range; z++) {
        const h = Math.floor(rng() * (TERRAIN_HEIGHT_MAX + 1));
        if (h > 0) raw.set(toKey(x, z), h);
      }
    }
    let heights = normaliseHeights(raw, range);
    expect(isLipschitz(heights, range)).toBe(true);

    for (let i = 0; i < 200; i++) {
      const x0 = Math.floor(rng() * (2 * range + 1)) - range;
      const z0 = Math.floor(rng() * (2 * range + 1)) - range;
      const x1 = Math.min(range, x0 + Math.floor(rng() * 3));
      const z1 = Math.min(range, z0 + Math.floor(rng() * 3));
      const mode: TerrainEditMode = rng() < 0.5 ? 'raise' : 'lower';
      const result = edit(heights, rectCells({ x: x0, z: z0 }, { x: x1, z: z1 }), mode, { range });
      expect(isLipschitz(result.heights, range)).toBe(true);
      for (const h of result.heights.values()) {
        expect(h).toBeGreaterThanOrEqual(1); // 0は未登録の規約
        expect(h).toBeLessThanOrEqual(TERRAIN_HEIGHT_MAX);
      }
      heights = result.heights;
    }
  });
});

describe('applyTerrainEdit: 地形種別(terrain)の整合', () => {
  it('盛土で標高がしきい値以上になった草地セルはmountainになる', () => {
    const terrain = new Map<string, TerrainType>();
    const result = edit(new Map(), [{ x: 0, z: 0 }], 'raise', { terrain });
    expect(result.heights.get('0,0')).toBe(MOUNTAIN_HEIGHT_THRESHOLD);
    expect(result.terrain.get('0,0')).toBe('mountain');
    // 元のterrainは変更しない
    expect(terrain.has('0,0')).toBe(false);
  });

  it('切土で標高0に戻ったmountainセルはgrass(未登録)へ戻る', () => {
    const terrain = new Map<string, TerrainType>([['0,0', 'mountain']]);
    const heights = new Map<string, number>([['0,0', 1]]);
    const result = edit(heights, [{ x: 0, z: 0 }], 'lower', { terrain });
    expect(result.heights.has('0,0')).toBe(false);
    expect(result.terrain.has('0,0')).toBe(false);
  });

  it('伝播で引き上がったセルもmountainになる(mountain⟺標高1以上の不変条件)', () => {
    const terrain = new Map<string, TerrainType>([['0,0', 'mountain']]);
    const heights = new Map<string, number>([['0,0', 1]]);
    const result = edit(heights, [{ x: 0, z: 0 }], 'raise', { terrain });
    for (const [key, h] of result.heights) {
      if (h >= MOUNTAIN_HEIGHT_THRESHOLD) expect(result.terrain.get(key)).toBe('mountain');
    }
    for (const [key, type] of result.terrain) {
      if (type === 'mountain') {
        expect(result.heights.get(key) ?? 0).toBeGreaterThanOrEqual(MOUNTAIN_HEIGHT_THRESHOLD);
      }
    }
  });

  it('プロパティ: 編集後は常にmountain⟺標高1以上(waterを除く)が成り立つ', () => {
    const rng = mulberry32(42);
    const range = 6;
    let heights = new Map<string, number>();
    let terrain = new Map<string, TerrainType>([['5,5', 'water']]);
    for (let i = 0; i < 100; i++) {
      const x = Math.floor(rng() * (2 * range + 1)) - range;
      const z = Math.floor(rng() * (2 * range + 1)) - range;
      const mode: TerrainEditMode = rng() < 0.6 ? 'raise' : 'lower';
      const result = edit(heights, [{ x, z }], mode, { terrain, range });
      heights = result.heights;
      terrain = result.terrain;
      for (const [key, type] of terrain) {
        if (type === 'water') continue;
        expect(type).toBe('mountain');
        expect(heights.get(key) ?? 0).toBeGreaterThanOrEqual(MOUNTAIN_HEIGHT_THRESHOLD);
      }
      for (const [key, h] of heights) {
        if (h >= MOUNTAIN_HEIGHT_THRESHOLD) expect(terrain.get(key)).toBe('mountain');
      }
    }
    // waterは常に標高0のまま
    expect(heights.has('5,5')).toBe(false);
    expect(terrain.get('5,5')).toBe('water');
  });
});

describe('applyTerrainEdit: 建設物・町・水域・範囲外によるブロック(編集全体がno-op)', () => {
  const expectNoop = (
    result: ReturnType<typeof applyTerrainEdit>,
    heights: Map<string, number>,
    terrain: Map<string, TerrainType>
  ) => {
    expect(result.heights).toBe(heights);
    expect(result.terrain).toBe(terrain);
    expect(result.changedCells).toEqual([]);
  };

  it('選択セルに線路があると編集できない', () => {
    const railMap = new Map<string, CellData>([['0,0', { type: 'rail', connections: 0 }]]);
    const heights = new Map<string, number>();
    const terrain = new Map<string, TerrainType>();
    expectNoop(edit(heights, [{ x: 0, z: 0 }], 'raise', { railMap, terrain }), heights, terrain);
  });

  it('伝播で動くセルに線路があると、選択セル自体が空いていても編集できない', () => {
    // (0,0)=1を盛土すると隣の(1,0)も引き上がるが、そこに線路がある
    const railMap = new Map<string, CellData>([['1,0', { type: 'rail', connections: 0 }]]);
    const heights = new Map<string, number>([['0,0', 1]]);
    const terrain = new Map<string, TerrainType>([['0,0', 'mountain']]);
    expectNoop(edit(heights, [{ x: 0, z: 0 }], 'raise', { railMap, terrain }), heights, terrain);
  });

  it('伝播で動くセルに線路があると切土もできない', () => {
    // 斜面 1,2 の低い端を切土すると(1,0)も下がるが、そこに線路(トンネル)がある
    const railMap = new Map<string, CellData>([['1,0', { type: 'rail', connections: 0 }]]);
    const heights = new Map<string, number>([['0,0', 1], ['1,0', 2]]);
    const terrain = new Map<string, TerrainType>([['0,0', 'mountain'], ['1,0', 'mountain']]);
    expectNoop(edit(heights, [{ x: 0, z: 0 }], 'lower', { railMap, terrain }), heights, terrain);
  });

  it('駅・車庫・信号つきセルもブロックする(railMapに存在するセルはすべて対象)', () => {
    for (const cell of [
      { type: 'station', connections: 0, stationId: 's1' },
      { type: 'depot', connections: 0 },
      { type: 'rail', connections: 0, signalDir: 2 },
    ] as CellData[]) {
      const railMap = new Map<string, CellData>([['0,0', cell]]);
      const heights = new Map<string, number>();
      const terrain = new Map<string, TerrainType>();
      expectNoop(edit(heights, [{ x: 0, z: 0 }], 'raise', { railMap, terrain }), heights, terrain);
    }
  });

  it('町タイル(家・道路)は盛土できない', () => {
    for (const kind of ['house', 'road'] as const) {
      const townTiles: TownTileIndex = new Map([['0,0', { townId: 't1', kind }]]);
      const heights = new Map<string, number>();
      const terrain = new Map<string, TerrainType>();
      expectNoop(edit(heights, [{ x: 0, z: 0 }], 'raise', { townTiles, terrain }), heights, terrain);
    }
  });

  it('伝播で動くセルに町の家があると編集できない', () => {
    const townTiles: TownTileIndex = new Map([['1,0', { townId: 't1', kind: 'house' }]]);
    const heights = new Map<string, number>([['0,0', 1]]);
    const terrain = new Map<string, TerrainType>([['0,0', 'mountain']]);
    expectNoop(edit(heights, [{ x: 0, z: 0 }], 'raise', { townTiles, terrain }), heights, terrain);
  });

  it('水域セルは盛土も切土もできない(waterは標高0のまま)', () => {
    const terrain = new Map<string, TerrainType>([['0,0', 'water']]);
    const heights = new Map<string, number>();
    expectNoop(edit(heights, [{ x: 0, z: 0 }], 'raise', { terrain }), heights, terrain);
    expectNoop(edit(heights, [{ x: 0, z: 0 }], 'lower', { terrain }), heights, terrain);
  });

  it('水域の隣を高さ2へ盛土しようとすると、水域へ伝播が及ぶためブロックされる', () => {
    const terrain = new Map<string, TerrainType>([['1,0', 'water'], ['0,0', 'mountain']]);
    const heights = new Map<string, number>([['0,0', 1]]);
    expectNoop(edit(heights, [{ x: 0, z: 0 }], 'raise', { terrain }), heights, terrain);
  });

  it('範囲外のセルは選択できない', () => {
    const heights = new Map<string, number>();
    const terrain = new Map<string, TerrainType>();
    expectNoop(edit(heights, [{ x: 46, z: 0 }], 'raise', { terrain }), heights, terrain);
  });

  it('範囲の縁のセルを高さ2にしようとすると、範囲外(標高0固定)へ伝播が及ぶためブロックされる', () => {
    const range = 5;
    const heights = new Map<string, number>([[toKey(range, 0), 1]]);
    const terrain = new Map<string, TerrainType>([[toKey(range, 0), 'mountain']]);
    expectNoop(edit(heights, [{ x: range, z: 0 }], 'raise', { terrain, range }), heights, terrain);
  });

  it('範囲の縁のセルでも高さ1までは盛土できる(範囲外との段差は1以下)', () => {
    const range = 5;
    const result = edit(new Map(), [{ x: range, z: 0 }], 'raise', { range });
    expect(result.heights.get(toKey(range, 0))).toBe(1);
    expect(isLipschitz(result.heights, range)).toBe(true);
  });
});

describe('costOfTerrainEdit: 地形編集のコスト', () => {
  it('変化したセル段数に比例する', () => {
    expect(costOfTerrainEdit(0)).toBe(0);
    expect(costOfTerrainEdit(1)).toBe(TERRAIN_EDIT_COST);
    expect(costOfTerrainEdit(5)).toBe(5 * TERRAIN_EDIT_COST);
  });

  it('伝播を含む変化セル数がそのまま課金対象になる(選択1セルでも5セル分)', () => {
    const heights = new Map<string, number>([['0,0', 1]]);
    const result = edit(heights, [{ x: 0, z: 0 }], 'raise');
    expect(costOfTerrainEdit(result.changedCells.length)).toBe(5 * TERRAIN_EDIT_COST);
  });
});

// fromKeyの往復(キー規約が変わったら伝播計算が壊れるため)
describe('キー規約', () => {
  it('toKey/fromKeyが往復する', () => {
    expect(fromKey(toKey(-3, 7))).toEqual({ x: -3, z: 7 });
  });
});
