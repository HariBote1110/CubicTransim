import { describe, it, expect } from 'vitest';
import { toKey, DIR } from '../utils';
import type { CellData, TerrainType } from '../types';
import {
  tunnelPortals, isInTunnelInterior, isMountainInteriorAtLevel,
  buildElevatedTunnelIndex, elevatedTunnelPortals, isInElevatedTunnelInterior,
  isTrainHiddenInTunnel,
} from './tunnel';
import { OVERPASS_HEIGHT } from './trackPath';
import { computeElevation, buildCornerElevationMap } from './terrain';

describe('tunnelPortals', () => {
  it('直線トンネル3セルで坑口が両端の2つだけになる', () => {
    // (0,0)-(0,1)-(0,2) の南北直線。中間(0,1)は両隣ともtunnelなので坑口なし。
    // 両端の外側((0,-1)/(0,3))は未登録(=非mountain、標高0)なので坑口が立つ。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: true }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
      [toKey(0, 2), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

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
      [toKey(5, 5), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
    ]);
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

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
      [toKey(0, 0), { type: 'rail', connections: DIR.E, tunnel: true }],
      [toKey(1, 0), { type: 'rail', connections: DIR.W | DIR.S, tunnel: true }],
      [toKey(1, 1), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

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
    const elevation = new Map<string, number>();

    expect(tunnelPortals(railMap, elevation)).toEqual([]);
  });

  it('山の内部(行き止まり方向の隣接セルもmountain)で終端するレールは行き止まり坑口を作らない', () => {
    // (0,0)は南へ1方向だけ接続。行き止まり方向(北)の隣接セル(0,-1)がmountain(標高2)
    // ならまだ山の中なので、そこに坑口を立てるべきではない。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: true }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, -1), 2]]);

    const portals = tunnelPortals(railMap, elevation);

    // (0,0)の北側(行き止まり方向)には坑口が立たない。(0,1)の南側は非mountainなので立つ。
    expect(portals).toEqual([{ x: 0, z: 1, dx: 0, dz: 1 }]);
  });

  it('山肌(行き止まり方向の隣接セルが非mountain)で終端する場合は坑口を作る', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: true }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);
    // (0,-1)は未登録=非mountain(標高0)なので山肌。
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

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
      [toKey(3, 4), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
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
    const cornerElevation = new Map<string, number>([
      [toKey(0, 0), 2], [toKey(1, 0), 2], [toKey(1, 1), 2], [toKey(0, 1), 2],
    ]);

    expect(isMountainInteriorAtLevel(cornerElevation, 0, 0, 2)).toBe(true);
  });

  it('1隅でもlevel未満ならfalseを返す(箱の底・側面が地形からはみ出す位置とみなす)', () => {
    const cornerElevation = new Map<string, number>([
      [toKey(0, 0), 2], [toKey(1, 0), 2], [toKey(1, 1), 1], [toKey(0, 1), 2],
    ]);

    expect(isMountainInteriorAtLevel(cornerElevation, 0, 0, 2)).toBe(false);
  });
});

describe('elevatedTunnelPortals / isInElevatedTunnelInterior (孤立セル・線状=山が薄いフォールバック経路)', () => {
  // 以下のテストはいずれも、周囲(左右または前後)の地形が登録されていない
  // 「薄い」ケース。cellCornersFromMapのmin則により、このようなセルは4隅の
  // どこかが必ず0に引っ張られるため、コーナー基準では絶対にisMountainInteriorAtLevel
  // を満たせない。この場合はフォールバック(そのセル自身の標高がlevel以上か、という
  // 従来の単純な判定)が使われ、山が薄すぎてもトンネル効果自体は消えないことを確認する。

  it('標高がlevel未満(=山の内部でない)高架セルは坑口を持たない(通常の高架として扱う)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, 0), 0]]);
    const cornerElevation = buildCornerElevationMap(elevation);

    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(elevatedTunnelPortals(index, 1)).toEqual([]);
  });

  it('単セルの高架トンネル(標高がlevel以上)は坑口が2つになる(フォールバック判定)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(5, 5), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(5, 5), 1]]);
    const cornerElevation = buildCornerElevationMap(elevation);

    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);
    const portals = elevatedTunnelPortals(index, 1);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 5, z: 5, dx: 0, dz: -1, level: 1 },
        { x: 5, z: 5, dx: 0, dz: 1, level: 1 },
      ])
    );
  });

  it('直線の高架トンネル3セルで坑口が両端の2つだけになる(フォールバック判定)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.S } } }],
      [toKey(0, 1), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
      [toKey(0, 2), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N } } }],
    ]);
    const elevation = new Map<string, number>([
      [toKey(0, 0), 1], [toKey(0, 1), 1], [toKey(0, 2), 1],
    ]);
    const cornerElevation = buildCornerElevationMap(elevation);

    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);
    const portals = elevatedTunnelPortals(index, 1);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: 0, dz: -1, level: 1 },
        { x: 0, z: 2, dx: 0, dz: 1, level: 1 },
      ])
    );
  });

  it('行き止まり方向の隣接セルもまだ山の内部(標高≥level)なら坑口を作らない(フォールバック判定)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.S } } }],
      [toKey(0, 1), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N } } }],
    ]);
    const elevation = new Map<string, number>([
      [toKey(0, -1), 2], [toKey(0, 0), 1], [toKey(0, 1), 1],
    ]);
    const cornerElevation = buildCornerElevationMap(elevation);

    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);
    const portals = elevatedTunnelPortals(index, 1);

    expect(portals).toEqual([{ x: 0, z: 1, dx: 0, dz: 1, level: 1 }]);
  });

  it('レベルが異なる高架は互いに独立して判定される(レベル1のみ埋まっている場合レベル2は対象外)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), {
        type: 'rail', connections: 0,
        uppers: { 1: { connections: DIR.N | DIR.S }, 2: { connections: DIR.N | DIR.S } },
      }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, 0), 1]]);
    const cornerElevation = buildCornerElevationMap(elevation);

    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(elevatedTunnelPortals(index, 1)).toHaveLength(2);
    expect(elevatedTunnelPortals(index, 2)).toEqual([]);
  });

  it('標高がlevel以上で、そのレベルの高架セルがあればtrueを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(3, 4), 1]]);
    const cornerElevation = buildCornerElevationMap(elevation);
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isInElevatedTunnelInterior(index, 3.2, 3.9, 1)).toBe(true);
  });

  it('標高がlevel未満なら、高架セルがあってもfalseを返す(まだ山肌より上=通常の高架)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(3, 4), 0]]);
    const cornerElevation = buildCornerElevationMap(elevation);
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isInElevatedTunnelInterior(index, 3, 4, 1)).toBe(false);
  });

  it('level<=0(地平)は常にfalseを返す', () => {
    const railMap = new Map<string, CellData>();
    const elevation = new Map<string, number>();
    const cornerElevation = new Map<string, number>();
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isInElevatedTunnelInterior(index, 0, 0, 0)).toBe(false);
  });

  it('そのレベルの高架セル自体が無ければfalseを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(3, 4), 1]]);
    const cornerElevation = buildCornerElevationMap(elevation);
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isInElevatedTunnelInterior(index, 3, 4, 2)).toBe(false);
  });
});

describe('elevatedTunnelPortals (実際の5x5山の標高から導出、坑口の浮き防止)', () => {
  // ユーザー報告: 「急峻な山でレベル1高架の坑口ボックスが斜面から浮き、箱の下・
  // 背後・左右に大きな隙間が見える」。5x5のmountainブロック(実際にcomputeElevation/
  // buildCornerElevationMapを通した標高)をE-W方向にレベル1高架で貫通させる。
  // 境界セル(x=-2, x=2)は4隅の標高が[0,1,1,0]/[1,0,0,1]で、外側の2隅が0のまま
  // (=斜面の裾がまだレール高さに届いていない)なので、そこに坑口を置くと浮く。
  // 1つ内側(x=-1, x=1)は4隅が[1,2,2,1]/[2,1,1,2]ですべて1以上に達しており、
  // 坑口はここに立つべき。
  const terrain = new Map<string, TerrainType>();
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) terrain.set(toKey(x, z), 'mountain');
  }
  const elevation = computeElevation(terrain);
  const cornerElevation = buildCornerElevationMap(elevation);

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
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);
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
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isInElevatedTunnelInterior(index, -2, 0, 1)).toBe(false);
    expect(isInElevatedTunnelInterior(index, 2, 0, 1)).toBe(false);
  });

  it('坑口の1つ内側から山頂側(x=-1〜1)はトンネル内部(非表示対象)になる', () => {
    const railMap = buildEwRail();
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isInElevatedTunnelInterior(index, -1, 0, 1)).toBe(true);
    expect(isInElevatedTunnelInterior(index, 0, 0, 1)).toBe(true);
    expect(isInElevatedTunnelInterior(index, 1, 0, 1)).toBe(true);
  });
});

describe('isTrainHiddenInTunnel', () => {
  it('y=0.5(地平)は地平のtunnelフラグで判定する', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
    ]);
    const index = buildElevatedTunnelIndex(railMap, new Map(), new Map());

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5)).toBe(true);
  });

  it('y=0.5+level*OVERPASS_HEIGHT(高架)は、そのレベルの高架トンネル判定を使う', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, 0), 1]]);
    const cornerElevation = buildCornerElevationMap(elevation);
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5 + OVERPASS_HEIGHT)).toBe(true);
  });

  it('高架レベルの高さだが、そのセルがまだ山に埋もれていなければ非表示にしない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, 0), 0]]);
    const cornerElevation = buildCornerElevationMap(elevation);
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5 + OVERPASS_HEIGHT)).toBe(false);
  });

  it('坂の途中など中途半端な高さは、対応する高架セルが無ければ非表示にしない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, 0), 1]]);
    const cornerElevation = buildCornerElevationMap(elevation);
    const index = buildElevatedTunnelIndex(railMap, cornerElevation, elevation);

    expect(isTrainHiddenInTunnel(railMap, index, 0, 0, 0.5 + OVERPASS_HEIGHT * 0.5)).toBe(false);
  });
});
