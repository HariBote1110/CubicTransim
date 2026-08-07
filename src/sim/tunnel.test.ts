import { describe, it, expect } from 'vitest';
import { toKey, DIR } from '../utils';
import type { CellData, TerrainType } from '../types';
import {
  tunnelPortals, isInTunnelInterior, isMountainInteriorAtLevel,
  buildElevatedTunnelIndex, elevatedTunnelPortals, isInElevatedTunnelInterior,
  isTrainHiddenInTunnel,
} from './tunnel';
import { OVERPASS_HEIGHT } from './trackPath';
import { computeElevation } from './testSupport/elevationFixture';
import type { TerrainField } from './terrainField';
import { fieldFromMaps } from './terrainField';

// セル高さのMap(旧elevation Map)からTerrainFieldを組み立てる。terrainTypeAtは
// 標高がMOUNTAIN_HEIGHT_THRESHOLD以上のセルをmountainとして扱う(terrain.tsと同じ
// 規約)。コーナー標高はfieldFromMapsがterrain.tsのcornerElevationと同じmin則で導出する。
const fieldFromElevation = (elevation: Map<string, number>): TerrainField => {
  const terrain = new Map<string, TerrainType>();
  for (const [key, h] of elevation) if (h >= 1) terrain.set(key, 'mountain');
  return fieldFromMaps(elevation, terrain, 45);
};

// isMountainInteriorAtLevelのテストは、コーナー座標→標高を直接指定したいので、
// セル→コーナーのmin則導出を経由しない最小限のTerrainFieldをその場で組み立てる。
const fieldFromCornerMap = (cornerMap: Map<string, number>): TerrainField => {
  const cornerHeightAt = (x: number, z: number): number => cornerMap.get(toKey(Math.round(x), Math.round(z))) ?? 0;
  const cellCornerHeights = (x: number, z: number): [number, number, number, number] => [
    cornerHeightAt(x, z), cornerHeightAt(x + 1, z), cornerHeightAt(x, z + 1), cornerHeightAt(x + 1, z + 1),
  ];
  return {
    cornerHeightAt,
    cellCornerHeights,
    cellHeightAt: (x, z) => Math.min(...cellCornerHeights(x, z)),
    terrainTypeAt: () => 'grass',
  };
};

describe('tunnelPortals', () => {
  it('直線トンネル3セルで坑口が両端の2つだけになる', () => {
    // (0,0)-(0,1)-(0,2) の南北直線。中間(0,1)は両隣ともtunnelなので坑口なし。
    // 両端の外側((0,-1)/(0,3))は未登録(=非mountain、標高0)なので坑口が立つ。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: { height: 0 } }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N | DIR.S, tunnel: { height: 0 } }],
      [toKey(0, 2), { type: 'rail', connections: DIR.N, tunnel: { height: 0 } }],
    ]);
    const field = fieldFromElevation(new Map());

    const portals = tunnelPortals(railMap, field);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: 0, dz: -1 },
        { x: 0, z: 2, dx: 0, dz: 1 },
      ])
    );
  });

  it('単セルトンネルは坑口が2つになる', () => {
    const railMap = new Map<string, CellData>([
      [toKey(5, 5), { type: 'rail', connections: DIR.N | DIR.S, tunnel: { height: 0 } }],
    ]);
    const field = fieldFromElevation(new Map());

    const portals = tunnelPortals(railMap, field);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 5, z: 5, dx: 0, dz: -1 },
        { x: 5, z: 5, dx: 0, dz: 1 },
      ])
    );
  });

  it('L字トンネルでも境界面(=非tunnel隣接方向)だけが坑口になる', () => {
    // (0,0)-(1,0)-(1,1) のL字。曲がり角(1,0)は両隣ともtunnelなので坑口なし。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.E, tunnel: { height: 0 } }],
      [toKey(1, 0), { type: 'rail', connections: DIR.W | DIR.S, tunnel: { height: 0 } }],
      [toKey(1, 1), { type: 'rail', connections: DIR.N, tunnel: { height: 0 } }],
    ]);
    const field = fieldFromElevation(new Map());

    const portals = tunnelPortals(railMap, field);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: -1, dz: 0 },
        { x: 1, z: 1, dx: 0, dz: 1 },
      ])
    );
  });

  it('非tunnelセルは坑口を持たない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const field = fieldFromElevation(new Map());

    expect(tunnelPortals(railMap, field)).toEqual([]);
  });

  it('山の内部(行き止まり方向の隣接セルもmountain)で終端するレールは行き止まり坑口を作らない', () => {
    // (0,0)は南へ1方向だけ接続。行き止まり方向(北)の隣接セル(0,-1)がmountain(標高2)
    // ならまだ山の中なので、そこに坑口を立てるべきではない。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: { height: 0 } }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N, tunnel: { height: 0 } }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(0, -1), 2]]));

    const portals = tunnelPortals(railMap, field);

    // (0,0)の北側(行き止まり方向)には坑口が立たない。(0,1)の南側は非mountainなので立つ。
    expect(portals).toEqual([{ x: 0, z: 1, dx: 0, dz: 1 }]);
  });

  it('山肌(行き止まり方向の隣接セルが非mountain)で終端する場合は坑口を作る', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: { height: 0 } }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N, tunnel: { height: 0 } }],
    ]);
    // (0,-1)は未登録=非mountain(標高0)なので山肌。
    const field = fieldFromElevation(new Map());

    const portals = tunnelPortals(railMap, field);

    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: 0, dz: -1 },
        { x: 0, z: 1, dx: 0, dz: 1 },
      ])
    );
    expect(portals).toHaveLength(2);
  });
});

describe('isInTunnelInterior', () => {
  it('tunnelセルの座標(四捨五入)ならtrueを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: DIR.N | DIR.S, tunnel: { height: 0 } }],
    ]);

    expect(isInTunnelInterior(railMap, 3.2, 3.9)).toBe(true);
  });

  it('非tunnelセル・空セルはfalseを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);

    expect(isInTunnelInterior(railMap, 3, 4)).toBe(false);
    expect(isInTunnelInterior(railMap, 99, 99)).toBe(false);
  });
});

describe('isMountainInteriorAtLevel', () => {
  it('4隅すべてがlevel以上ならtrueを返す', () => {
    const cornerMap = new Map<string, number>([
      [toKey(0, 0), 2], [toKey(1, 0), 2], [toKey(1, 1), 2], [toKey(0, 1), 2],
    ]);

    expect(isMountainInteriorAtLevel(fieldFromCornerMap(cornerMap), 0, 0, 2)).toBe(true);
  });

  it('1隅でもlevel未満ならfalseを返す(箱の底・側面が地形からはみ出す位置とみなす)', () => {
    const cornerMap = new Map<string, number>([
      [toKey(0, 0), 2], [toKey(1, 0), 2], [toKey(1, 1), 1], [toKey(0, 1), 2],
    ]);

    expect(isMountainInteriorAtLevel(fieldFromCornerMap(cornerMap), 0, 0, 2)).toBe(false);
  });
});

describe('elevatedTunnelPortals / isInElevatedTunnelInterior (孤立セル・線状=山が薄いケース)', () => {
  // 以下のテストはいずれも、周囲(左右または前後)の地形が登録されていない
  // 「薄い」ケース。min則により、このようなセルは4隅のどこかが必ず0に引っ張られる
  // ため、isMountainInteriorAtLevelを満たせない。TerrainField.cellHeightAtは常に
  // 4隅コーナーのmin(terrainField.ts/terrainOverlay.tsのコーナー一次データという
  // 設計そのもの)なので、旧terrain.ts時代のような「セル自身の生標高」を使った
  // 独立なフォールバック判定は数学的にコーナー判定と一致してしまい意味を持たない
  // (fieldに一本化したことで、コーナーと矛盾する生標高という概念自体が無くなった)。
  // そのため孤立/線状の薄い山は「まだ実体の無い山」として通常の露出した高架
  // (坑口も内部非表示も無し)のまま扱われるのが正しい挙動になる。

  it('標高がlevel未満(=山の内部でない)高架セルは坑口を持たない(通常の高架として扱う)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(0, 0), 0]]));

    const index = buildElevatedTunnelIndex(railMap, field);

    expect(elevatedTunnelPortals(index, 1)).toEqual([]);
  });

  it('孤立した単セルの標高だけでは(隣接コーナーが0に引っ張られ)内部化されず、坑口も作られない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(5, 5), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(5, 5), 1]]));

    const index = buildElevatedTunnelIndex(railMap, field);
    const portals = elevatedTunnelPortals(index, 1);

    expect(portals).toEqual([]);
    expect(isInElevatedTunnelInterior(index, 5, 5, 1)).toBe(false);
  });

  it('線状(幅1セル)の高架トンネルも、周囲が未登録(=標高0)なら実体の無い山として扱われる', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.S } } }],
      [toKey(0, 1), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
      [toKey(0, 2), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N } } }],
    ]);
    const field = fieldFromElevation(new Map([
      [toKey(0, 0), 1], [toKey(0, 1), 1], [toKey(0, 2), 1],
    ]));

    const index = buildElevatedTunnelIndex(railMap, field);

    expect(elevatedTunnelPortals(index, 1)).toEqual([]);
    expect(isInElevatedTunnelInterior(index, 0, 1, 1)).toBe(false);
  });

  it('幅を持たせて4隅すべてを標高1以上にすると、内部判定を満たし坑口が立つ', () => {
    // z=-1..1の3行ぶん標高1にして、x=0の列に実際に「幅のある」山を作る。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.S } } }],
      [toKey(0, 1), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
      [toKey(0, 2), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N } } }],
    ]);
    const elevation = new Map<string, number>();
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 3; z++) elevation.set(toKey(x, z), 1);
    }
    const field = fieldFromElevation(elevation);

    const index = buildElevatedTunnelIndex(railMap, field);
    const portals = elevatedTunnelPortals(index, 1);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: 0, dz: -1, level: 1 },
        { x: 0, z: 2, dx: 0, dz: 1, level: 1 },
      ])
    );
  });

  it('レベルが異なる高架は互いに独立して判定される(いずれも幅が無ければどちらも内部化しない)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), {
        type: 'rail', connections: 0,
        uppers: { 1: { connections: DIR.N | DIR.S }, 2: { connections: DIR.N | DIR.S } },
      }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(0, 0), 1]]));

    const index = buildElevatedTunnelIndex(railMap, field);

    expect(elevatedTunnelPortals(index, 1)).toEqual([]);
    expect(elevatedTunnelPortals(index, 2)).toEqual([]);
  });

  it('標高がlevel未満なら、高架セルがあってもfalseを返す(まだ山肌より上=通常の高架)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(3, 4), 0]]));
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isInElevatedTunnelInterior(index, 3, 4, 1)).toBe(false);
  });

  it('level<=0(地平)は常にfalseを返す', () => {
    const railMap = new Map<string, CellData>();
    const field = fieldFromElevation(new Map());
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isInElevatedTunnelInterior(index, 0, 0, 0)).toBe(false);
  });

  it('そのレベルの高架セル自体が無ければfalseを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(3, 4), 1]]));
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isInElevatedTunnelInterior(index, 3, 4, 2)).toBe(false);
  });
});

describe('elevatedTunnelPortals (実際の5x5山の標高から導出、坑口の浮き防止)', () => {
  // ユーザー報告: 「急峻な山でレベル1高架の坑口ボックスが斜面から浮き、箱の下・
  // 背後・左右に大きな隙間が見える」。5x5のmountainブロック(実際にcomputeElevation
  // /fieldFromMapsのmin則を通した標高)をE-W方向にレベル1高架で貫通させる。
  // 境界セル(x=-2, x=2)は4隅の標高が[0,1,1,0]/[1,0,0,1]で、外側の2隅が0のまま
  // (=斜面の裾がまだレール高さに届いていない)なので、そこに坑口を置くと浮く。
  // 1つ内側(x=-1, x=1)は4隅が[1,2,2,1]/[2,1,1,2]ですべて1以上に達しており、
  // 坑口はここに立つべき。
  const terrain = new Map<string, TerrainType>();
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) terrain.set(toKey(x, z), 'mountain');
  }
  const elevation = computeElevation(terrain);
  const field = fieldFromMaps(elevation, terrain, 45);

  const buildEwRail = (): Map<string, CellData> => {
    const railMap = new Map<string, CellData>();
    for (let x = -4; x <= 3; x++) {
      const conns = x === -4 ? DIR.E : x === 3 ? DIR.W : DIR.E | DIR.W;
      railMap.set(toKey(x, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: conns } } });
    }
    return railMap;
  };

  it('坑口は境界セル(x=-2,x=2)ではなく、4隅すべて標高1以上に達した1つ内側(x=-1,x=1)に立つ', () => {
    const railMap = buildEwRail();
    const index = buildElevatedTunnelIndex(railMap, field);
    const portals = elevatedTunnelPortals(index, 1);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: -1, z: 0, dx: -1, dz: 0, level: 1 },
        { x: 1, z: 0, dx: 1, dz: 0, level: 1 },
      ])
    );
  });

  it('境界セル(x=-2,x=2)は露出した高架として扱われ、トンネル内部(非表示)にはならない', () => {
    const railMap = buildEwRail();
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isInElevatedTunnelInterior(index, -2, 0, 1)).toBe(false);
    expect(isInElevatedTunnelInterior(index, 2, 0, 1)).toBe(false);
  });

  it('坑口の1つ内側から山頂側(x=-1〜1)はトンネル内部(非表示対象)になる', () => {
    const railMap = buildEwRail();
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isInElevatedTunnelInterior(index, -1, 0, 1)).toBe(true);
    expect(isInElevatedTunnelInterior(index, 0, 0, 1)).toBe(true);
    expect(isInElevatedTunnelInterior(index, 1, 0, 1)).toBe(true);
  });
});

describe('isTrainHiddenInTunnel', () => {
  it('y=0.5(地平)は地平のtunnelフラグで判定する', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, tunnel: { height: 0 } }],
    ]);
    const index = buildElevatedTunnelIndex(railMap, fieldFromElevation(new Map()));

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5)).toBe(true);
  });

  it('y=0.5+level*OVERPASS_HEIGHT(高架)は、そのレベルの高架トンネル判定を使う', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    // 4隅すべてが標高1以上になるよう、幅を持たせた山を作る(孤立1セルはコーナーが
    // 0に引っ張られ内部化しないため)。
    const elevation = new Map<string, number>();
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) elevation.set(toKey(x, z), 1);
    const field = fieldFromElevation(elevation);
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5 + OVERPASS_HEIGHT)).toBe(true);
  });

  it('高架レベルの高さだが、そのセルがまだ山に埋もれていなければ非表示にしない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(0, 0), 0]]));
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5 + OVERPASS_HEIGHT)).toBe(false);
  });

  it('坂の途中など中途半端な高さは、対応する高架セルが無ければ非表示にしない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const field = fieldFromElevation(new Map([[toKey(0, 0), 1]]));
    const index = buildElevatedTunnelIndex(railMap, field);

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5 + OVERPASS_HEIGHT * 0.5)).toBe(false);
  });
});
