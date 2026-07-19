import { describe, expect, it } from 'vitest';
import { DIR, toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData } from '../types';
import { calculateRoute } from './pathfinding';

const noOccupied = new Set<string>();
const noReserved = new Set<string>();

const buildRailMap = (cells: { x: number; z: number }[]) => {
  const map = new Map<string, CellData>();
  for (let i = 0; i < cells.length - 1; i++) {
    const curr = cells[i];
    const next = cells[i + 1];
    const dx = next.x - curr.x;
    const dz = next.z - curr.z;
    const dir = getDirFromVector(dx, dz);
    const oppDir = getOppositeDir(dir);

    const currKey = toKey(curr.x, curr.z);
    const currCell = map.get(currKey) || { type: 'rail' as const, connections: 0 };
    map.set(currKey, { ...currCell, connections: (currCell.connections || 0) | dir });

    const nextKey = toKey(next.x, next.z);
    const nextCell = map.get(nextKey) || { type: 'rail' as const, connections: 0 };
    map.set(nextKey, { ...nextCell, connections: (nextCell.connections || 0) | oppDir });
  }
  return map;
};

describe('calculateRoute', () => {
  it('直線線路で目標駅までの最短経路を返す', () => {
    const cells = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ];
    const railMap = buildRailMap(cells);
    railMap.set(toKey(4, 0), { ...railMap.get(toKey(4, 0))!, type: 'station', stationId: 'stA' });

    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 4, z: 0 }], center: { x: 4, z: 0 }, platformDoors: 'none' }],
    ]);

    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stA',
      cars: 1,
    });

    expect(result).toEqual([
      { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);
  });

  it('目標駅が存在しない場合は空配列を返す', () => {
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    const railMap = buildRailMap(cells);
    const stations = new Map<string, StationData>();

    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'nope',
      cars: 1,
    });

    expect(result).toEqual([]);
  });

  it('分岐では目標駅側の経路を選ぶ', () => {
    // (0,0) - (1,0) が本線、(1,0) から (2,1) - (3,2) へ45度で分岐する支線
    // (急カーブ判定(内積<0.5)に抵触しないよう、分岐は45度で構成する)
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }]);
    const branch = buildRailMap([{ x: 1, z: 0 }, { x: 2, z: 1 }, { x: 3, z: 2 }]);
    branch.forEach((cell, key) => {
      const existing = railMap.get(key);
      if (existing) {
        railMap.set(key, { ...existing, connections: (existing.connections || 0) | (cell.connections || 0) });
      } else {
        railMap.set(key, cell);
      }
    });
    railMap.set(toKey(3, 2), { ...railMap.get(toKey(3, 2))!, type: 'station', stationId: 'stB' });

    const stations = new Map<string, StationData>([
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 3, z: 2 }], center: { x: 3, z: 2 }, platformDoors: 'none' }],
    ]);

    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stB',
      cars: 1,
    });

    expect(result).toEqual([
      { x: 1, z: 0 }, { x: 2, z: 1 }, { x: 3, z: 2 },
    ]);
  });

  it('他列車の占有セルを避けて迂回する', () => {
    // (0,0)-(1,0)-(2,0)-(3,0)-(4,0) の本線 (2,0) を占有し、
    // (1,0)-(2,1)-(3,1)-(4,0) の45度迂回路へ逃がす
    const mainLine = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
    const detour = buildRailMap([{ x: 1, z: 0 }, { x: 2, z: 1 }, { x: 3, z: 1 }, { x: 4, z: 0 }]);
    const railMap = new Map<string, CellData>(mainLine);
    detour.forEach((cell, key) => {
      const existing = railMap.get(key);
      if (existing) {
        railMap.set(key, { ...existing, connections: (existing.connections || 0) | (cell.connections || 0) });
      } else {
        railMap.set(key, cell);
      }
    });
    railMap.set(toKey(4, 0), { ...railMap.get(toKey(4, 0))!, type: 'station', stationId: 'stC' });

    const stations = new Map<string, StationData>([
      ['stC', { id: 'stC', name: 'C', cells: [{ x: 4, z: 0 }], center: { x: 4, z: 0 }, platformDoors: 'none' }],
    ]);

    const occupied = new Set<string>([toKey(2, 0)]);

    const result = calculateRoute(railMap, stations, occupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stC',
      cars: 1,
    });

    expect(result).toEqual([
      { x: 1, z: 0 }, { x: 2, z: 1 }, { x: 3, z: 1 }, { x: 4, z: 0 },
    ]);
  });

  it('迂回路が無いときは占有無視のフォールバック経路を返す', () => {
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const railMap = buildRailMap(cells);
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, type: 'station', stationId: 'stD' });

    const stations = new Map<string, StationData>([
      ['stD', { id: 'stD', name: 'D', cells: [{ x: 2, z: 0 }], center: { x: 2, z: 0 }, platformDoors: 'none' }],
    ]);

    const occupied = new Set<string>([toKey(1, 0)]);

    const result = calculateRoute(railMap, stations, occupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stD',
      cars: 1,
    });

    expect(result).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }]);
  });

  it('信号に逆行する進入は除外される', () => {
    // (1,0) に「東向き」信号を置く。西からの進入 (E方向移動) は許可されるが、
    // 東からの進入 (W方向移動) は逆走として除外される。
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const railMap = buildRailMap(cells);
    railMap.set(toKey(1, 0), { ...railMap.get(toKey(1, 0))!, signalDir: DIR.E });
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, type: 'station', stationId: 'stE' });

    const stations = new Map<string, StationData>([
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 2, z: 0 }], center: { x: 2, z: 0 }, platformDoors: 'none' }],
    ]);

    // 東向き (0,0)->(2,0) は信号の向きと同じなので通過できる
    const okResult = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stE',
      cars: 1,
    });
    expect(okResult).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }]);

    // 西向きに置き換えた駅 stF を (0,0) に置き、(2,0) から (0,0) へ逆走させると
    // 信号 (東向き) に逆らう進入になり、迂回路がないため経路が見つからない
    railMap.set(toKey(0, 0), { ...railMap.get(toKey(0, 0))!, type: 'station', stationId: 'stF' });
    const stations2 = new Map<string, StationData>([
      ['stF', { id: 'stF', name: 'F', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ]);

    const blockedResult = calculateRoute(railMap, stations2, noOccupied, noReserved, {
      start: { x: 2, z: 0 },
      prev: null,
      targetStationId: 'stF',
      cars: 1,
    });
    expect(blockedResult).toEqual([]);
  });

  it('急カーブ(内積0.5未満)は除外される', () => {
    // (0,0)->(1,0) で進んできた列車が (1,0) から (1,-1) (北, 90度カーブ) へ折れるのは除外
    // (1,0) から (2,0) への直進、および (1,1) への45度カーブは許可される
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    // (1,0) から北 (1,-1) への行き止まり分岐を追加
    const north = buildRailMap([{ x: 1, z: 0 }, { x: 1, z: -1 }]);
    north.forEach((cell, key) => {
      const existing = railMap.get(key);
      if (existing) {
        railMap.set(key, { ...existing, connections: (existing.connections || 0) | (cell.connections || 0) });
      } else {
        railMap.set(key, cell);
      }
    });
    railMap.set(toKey(1, -1), { ...railMap.get(toKey(1, -1))!, type: 'station', stationId: 'stG' });

    const stations = new Map<string, StationData>([
      ['stG', { id: 'stG', name: 'G', cells: [{ x: 1, z: -1 }], center: { x: 1, z: -1 }, platformDoors: 'none' }],
    ]);

    // start=(0,0), prev=null なので方向制約はかからず一旦 (1,0) までは進める。
    // (1,0) から (1,-1) は直前移動 (0,0)->(1,0) との内積が 0 (< 0.5) のため除外され、
    // 行き止まりとして (0,0) へ戻る経路になり、目的地には到達できない。
    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stG',
      cars: 1,
    });

    expect(result).toEqual([]);
  });

  // 座標系: x+=東, z+=南。「進行方向左」はこのゲームの座標系における
  // 左側通行の定義であり、東行き(dv=(1,0))はz+側(z=1、南側の並行線)を、
  // 西行き(dv=(-1,0))はz-側(z=0、北側の並行線)を優先する。
  it('無信号の並行複線では、同距離のタイブレークで進行方向左側の線路が優先される(日本式左側通行)', () => {
    // z=0(北側)とz=1(南側)の2本の並行線路が(0,0)で分岐し(6,0)で合流する、同距離の複線。
    const pathZ0 = buildRailMap([
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }, { x: 6, z: 0 },
    ]);
    const pathZ1 = buildRailMap([
      { x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 1 }, { x: 3, z: 1 }, { x: 4, z: 1 }, { x: 5, z: 1 }, { x: 6, z: 0 },
    ]);
    const railMap = new Map<string, CellData>(pathZ0);
    pathZ1.forEach((cell, key) => {
      const existing = railMap.get(key);
      if (existing) {
        railMap.set(key, { ...existing, connections: (existing.connections || 0) | (cell.connections || 0) });
      } else {
        railMap.set(key, cell);
      }
    });
    railMap.set(toKey(6, 0), { ...railMap.get(toKey(6, 0))!, type: 'station', stationId: 'stEast' });
    railMap.set(toKey(0, 0), { ...railMap.get(toKey(0, 0))!, type: 'station', stationId: 'stWest' });

    const stations = new Map<string, StationData>([
      ['stEast', { id: 'stEast', name: 'East', cells: [{ x: 6, z: 0 }], center: { x: 6, z: 0 }, platformDoors: 'none' }],
      ['stWest', { id: 'stWest', name: 'West', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ]);

    // 東行き(西から進入、prev=(-1,0)): 進行方向左側=z=1(南)の線路を選ぶ
    const eastboundResult = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: { x: -1, z: 0 },
      targetStationId: 'stEast',
      cars: 1,
    });
    expect(eastboundResult).toEqual([
      { x: 1, z: 1 }, { x: 2, z: 1 }, { x: 3, z: 1 }, { x: 4, z: 1 }, { x: 5, z: 1 }, { x: 6, z: 0 },
    ]);

    // 西行き(東から進入、prev=(7,0)): 進行方向左側=z=0(北)の線路を選ぶ
    const westboundResult = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 6, z: 0 },
      prev: { x: 7, z: 0 },
      targetStationId: 'stWest',
      cars: 1,
    });
    expect(westboundResult).toEqual([
      { x: 5, z: 0 }, { x: 4, z: 0 }, { x: 3, z: 0 }, { x: 2, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 0 },
    ]);
  });

  it('ホーム(同一駅IDの連続セル)3セル+3両編成はホーム奥端まで経路を延長する', () => {
    // (2,0)-(3,0)-(4,0) の3セルが同一駅stHのホーム。目的駅ヒットは(2,0)で成立するが、
    // 3両編成(cars=3, P=3)はheadIdx=P-1=奥端となるため、経路は奥端(4,0)まで延長される。
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const railMap = buildRailMap(cells);
    for (const x of [2, 3, 4]) {
      railMap.set(toKey(x, 0), { ...railMap.get(toKey(x, 0))!, type: 'station', stationId: 'stH' });
    }
    const stations = new Map<string, StationData>([
      ['stH', { id: 'stH', name: 'H', cells: [{ x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }], center: { x: 3, z: 0 }, platformDoors: 'none' }],
    ]);

    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stH',
      cars: 3,
    });

    expect(result).toEqual([
      { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);
  });

  it('編成中央基準: ホーム3セル+1両は中央セルで止まる', () => {
    // P=3, cars=1 -> headIdx = ceil((3+1)/2)-1 = 1 (ホーム中央セル)
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
    const railMap = buildRailMap(cells);
    for (const x of [2, 3, 4]) {
      railMap.set(toKey(x, 0), { ...railMap.get(toKey(x, 0))!, type: 'station', stationId: 'stH2' });
    }
    const stations = new Map<string, StationData>([
      ['stH2', { id: 'stH2', name: 'H2', cells: [{ x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }], center: { x: 3, z: 0 }, platformDoors: 'none' }],
    ]);

    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stH2',
      cars: 1,
    });

    expect(result).toEqual([
      { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 },
    ]);
  });

  it('FarEnd固定: ホーム1セル+4両(cars>=P)はホーム奥端(自身)で止まり、先の線路へは延長しない', () => {
    // P=1, cars=4 (>=P) -> FarEnd固定でheadIdx=P-1=0。ホームの先に線路があっても出て行かない。
    const cells = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    const railMap = buildRailMap(cells);
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, type: 'station', stationId: 'stJ' });
    const stations = new Map<string, StationData>([
      ['stJ', { id: 'stJ', name: 'J', cells: [{ x: 2, z: 0 }], center: { x: 2, z: 0 }, platformDoors: 'none' }],
    ]);

    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stJ',
      cars: 4,
    });

    expect(result).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }]);
  });

  it('ホーム延長は先が行き止まり(接続なし)であれば最初の到達セルで止まる', () => {
    // 単一セルの駅(既存の全テストと同じ形)では延長候補が無いため従来通りの挙動になる。
    const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const railMap = buildRailMap(cells);
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, type: 'station', stationId: 'stI' });
    const stations = new Map<string, StationData>([
      ['stI', { id: 'stI', name: 'I', cells: [{ x: 2, z: 0 }], center: { x: 2, z: 0 }, platformDoors: 'none' }],
    ]);

    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 },
      prev: null,
      targetStationId: 'stI',
      cars: 1,
    });

    expect(result).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }]);
  });

  describe('stopLocation (Near/Middle/Far)', () => {
    // ホーム5セル(x=2..6)、cars=2 で near/middle/far それぞれの停止セルを検証する。
    const buildFiveCellPlatform = () => {
      const cells = [
        { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 },
        { x: 4, z: 0 }, { x: 5, z: 0 }, { x: 6, z: 0 },
      ];
      const railMap = buildRailMap(cells);
      for (const x of [2, 3, 4, 5, 6]) {
        railMap.set(toKey(x, 0), { ...railMap.get(toKey(x, 0))!, type: 'station', stationId: 'stP' });
      }
      const stations = new Map<string, StationData>([
        ['stP', {
          id: 'stP', name: 'P',
          cells: [2, 3, 4, 5, 6].map(x => ({ x, z: 0 })),
          center: { x: 4, z: 0 }, platformDoors: 'none',
        }],
      ]);
      return { railMap, stations };
    };

    it('near: 編成ができるだけホーム内に収まる最小前進(手前寄り)で止まる', () => {
      const { railMap, stations } = buildFiveCellPlatform();
      const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
        start: { x: 0, z: 0 }, prev: null, targetStationId: 'stP', cars: 2, stopLocation: 'near',
      });
      expect(result).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }]);
    });

    it('middle: 編成中央がホーム中央に最も近づく位置で止まる', () => {
      const { railMap, stations } = buildFiveCellPlatform();
      const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
        start: { x: 0, z: 0 }, prev: null, targetStationId: 'stP', cars: 2, stopLocation: 'middle',
      });
      expect(result).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }]);
    });

    it('far: ホーム奥端で止まる', () => {
      const { railMap, stations } = buildFiveCellPlatform();
      const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
        start: { x: 0, z: 0 }, prev: null, targetStationId: 'stP', cars: 2, stopLocation: 'far',
      });
      expect(result).toEqual([
        { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 }, { x: 6, z: 0 },
      ]);
    });

    it('編成長がホーム長以上の場合、stopLocation設定によらずFarEnd固定になる', () => {
      // P=3, cars=4 (>=P) -> nearを指定してもFarEndで止まる。
      const cells = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }];
      const railMap = buildRailMap(cells);
      for (const x of [2, 3, 4]) {
        railMap.set(toKey(x, 0), { ...railMap.get(toKey(x, 0))!, type: 'station', stationId: 'stF' });
      }
      const stations = new Map<string, StationData>([
        ['stF', { id: 'stF', name: 'F', cells: [2, 3, 4].map(x => ({ x, z: 0 })), center: { x: 3, z: 0 }, platformDoors: 'none' }],
      ]);

      const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
        start: { x: 0, z: 0 }, prev: null, targetStationId: 'stF', cars: 4, stopLocation: 'near',
      });

      expect(result).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
    });
  });
});
