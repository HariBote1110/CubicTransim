import { describe, expect, it } from 'vitest';
import { DIR, toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData } from '../types';
import { calculateRoute, calculateRouteWithStop } from './pathfinding';
import { applyRailPath, applyBridge, applyStation, type ConstructionState } from './construction';

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

describe('立体交差(upper)の経路探索', () => {
  // 十字に交差する線路。地平は (0,0)-(4,0) の東西直線。
  // 南北の線は (2,-2)-(2,2) で、実際の建設(applyRailPath)と同じ規則により
  // 交差セル(2,0)だけが upper(地平のE|Wとは合流しない)になり、それ以外は地平。
  const buildCrossing = () => {
    const railMap = buildRailMap([
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);

    const addGroundLink = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      const dir = getDirFromVector(b.x - a.x, b.z - a.z);
      const opp = getOppositeDir(dir);
      const ak = toKey(a.x, a.z);
      const ac = railMap.get(ak) || { type: 'rail' as const, connections: 0 };
      railMap.set(ak, { ...ac, connections: (ac.connections || 0) | dir });
      const bk = toKey(b.x, b.z);
      const bc = railMap.get(bk) || { type: 'rail' as const, connections: 0 };
      railMap.set(bk, { ...bc, connections: (bc.connections || 0) | opp });
    };
    addGroundLink({ x: 2, z: -2 }, { x: 2, z: -1 });
    addGroundLink({ x: 2, z: 1 }, { x: 2, z: 2 });

    // 交差セル(2,0)は既存のE|Wと合流しないため upper 側にN|Sを持つ。
    // (2,-1)→(2,0)、(2,0)→(2,1) の南北接続はどちらも upper に入る。
    const cell20 = railMap.get(toKey(2, 0))!;
    railMap.set(toKey(2, 0), { ...cell20, upper: { connections: DIR.N | DIR.S } });
    const cell2m1 = railMap.get(toKey(2, -1))!;
    railMap.set(toKey(2, -1), { ...cell2m1, connections: (cell2m1.connections || 0) | DIR.S });
    const cell21 = railMap.get(toKey(2, 1))!;
    railMap.set(toKey(2, 1), { ...cell21, connections: (cell21.connections || 0) | DIR.N });

    railMap.set(toKey(4, 0), { ...railMap.get(toKey(4, 0))!, type: 'station', stationId: 'stA' });
    railMap.set(toKey(2, 2), { ...railMap.get(toKey(2, 2))!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 4, z: 0 }], center: { x: 4, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 2, z: 2 }], center: { x: 2, z: 2 }, platformDoors: 'none' }],
    ]);
    return { railMap, stations };
  };

  it('地平を直進する経路は交差セルで高架側へ曲がらない', () => {
    const { railMap, stations } = buildCrossing();
    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 }, prev: null, targetStationId: 'stA', cars: 1,
    });
    expect(result).toEqual([
      { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ]);
  });

  it('南北の経路は交差セルを高架として通過し、layerが付与される', () => {
    const { railMap, stations } = buildCrossing();
    const result = calculateRouteWithStop(railMap, stations, noOccupied, noReserved, {
      start: { x: 2, z: -2 }, prev: null, targetStationId: 'stB', cars: 1,
    });
    expect(result.path.map(c => ({ x: c.x, z: c.z, layer: c.layer }))).toEqual([
      { x: 2, z: -1, layer: undefined },
      { x: 2, z: 0, layer: 1 },
      { x: 2, z: 1, layer: undefined },
      { x: 2, z: 2, layer: undefined },
    ]);
  });

  it('交差セル上では曲がれない(地平からの直進が高架の南北方向へ分岐しない)', () => {
    const { railMap, stations } = buildCrossing();
    // (2,0)まで地平で来た列車が、そこから南(高架側)へ曲がれずstAへ直進すること。
    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 1, z: 0 }, prev: { x: 0, z: 0 }, targetStationId: 'stA', cars: 1,
    });
    expect(result).toEqual([{ x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
  });
});

describe('平面交差(ダイヤモンドクロッシング)の経路探索', () => {
  const emptyState = (): ConstructionState => ({
    railMap: new Map<string, CellData>(),
    stations: new Map<string, StationData>(),
  });

  // applyRailPathで実際にダイヤモンドクロッシング(4方向接続の1セル)を作り、
  // 直進はできるが直角には曲がれないことを確認する。
  const buildDiamondCrossing = () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
    state = applyRailPath(state, [{ x: 2, z: -2 }, { x: 2, z: -1 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }]);

    const crossing = state.railMap.get(toKey(2, 0))!;
    expect(crossing.connections).toBe(DIR.N | DIR.E | DIR.S | DIR.W);
    expect(crossing.upper).toBeUndefined();

    const railMap = new Map(state.railMap);
    railMap.set(toKey(4, 0), { ...railMap.get(toKey(4, 0))!, type: 'station', stationId: 'stA' });
    railMap.set(toKey(2, 2), { ...railMap.get(toKey(2, 2))!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 4, z: 0 }], center: { x: 4, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 2, z: 2 }], center: { x: 2, z: 2 }, platformDoors: 'none' }],
    ]);
    return { railMap, stations };
  };

  it('東西方向へ直進する経路はクロッシングを通過できる', () => {
    const { railMap, stations } = buildDiamondCrossing();
    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 }, prev: null, targetStationId: 'stA', cars: 1,
    });
    expect(result).toEqual([{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
  });

  it('南北方向へ直進する経路もクロッシングを通過できる', () => {
    const { railMap, stations } = buildDiamondCrossing();
    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 2, z: -2 }, prev: null, targetStationId: 'stB', cars: 1,
    });
    expect(result).toEqual([{ x: 2, z: -1 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }]);
  });

  it('クロッシング上では直角に曲がれない(東進中の列車は南のstBへ到達できない)', () => {
    const { railMap, stations } = buildDiamondCrossing();
    const result = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 1, z: 0 }, prev: { x: 0, z: 0 }, targetStationId: 'stB', cars: 1,
    });
    // 直進(東)しか許されないため、南北のstBへは到達できず経路なし(空配列)になる
    expect(result).toEqual([]);
  });
});

describe('橋(applyBridge)の経路探索', () => {
  const emptyState = (): ConstructionState => ({
    railMap: new Map<string, CellData>(),
    stations: new Map<string, StationData>(),
  });

  it('橋の上を通る経路が引ける', () => {
    let state = emptyState();
    const bridgePath = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 },
      { x: 3, z: 0 }, { x: 4, z: 0 }, { x: 5, z: 0 },
    ];
    state = applyBridge(state, bridgePath);
    const railMap = new Map(state.railMap);
    railMap.set(toKey(5, 0), { ...railMap.get(toKey(5, 0))!, type: 'station', stationId: 'stA' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 5, z: 0 }], center: { x: 5, z: 0 }, platformDoors: 'none' }],
    ]);

    const result = calculateRouteWithStop(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 }, prev: null, targetStationId: 'stA', cars: 1,
    });
    expect(result.path.map(c => ({ x: c.x, z: c.z, layer: c.layer }))).toEqual([
      { x: 1, z: 0, layer: undefined },
      { x: 2, z: 0, layer: 1 },
      { x: 3, z: 0, layer: 1 },
      { x: 4, z: 0, layer: undefined },
      { x: 5, z: 0, layer: undefined },
    ]);
  });

  it('橋の下の地平経路と混線しない(橋を渡る経路と、下を通る地平経路が別々に成立する)', () => {
    let state = emptyState();
    // 橋の下に南北の地平線路を通す
    state = applyRailPath(state, [{ x: 2, z: -1 }, { x: 2, z: 0 }, { x: 2, z: 1 }]);
    const bridgePath = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 },
    ];
    state = applyBridge(state, bridgePath);

    const railMap = new Map(state.railMap);
    railMap.set(toKey(4, 0), { ...railMap.get(toKey(4, 0))!, type: 'station', stationId: 'stBridge' });
    railMap.set(toKey(2, 1), { ...railMap.get(toKey(2, 1))!, type: 'station', stationId: 'stGround' });
    const stations = new Map<string, StationData>([
      ['stBridge', { id: 'stBridge', name: 'Bridge', cells: [{ x: 4, z: 0 }], center: { x: 4, z: 0 }, platformDoors: 'none' }],
      ['stGround', { id: 'stGround', name: 'Ground', cells: [{ x: 2, z: 1 }], center: { x: 2, z: 1 }, platformDoors: 'none' }],
    ]);

    const bridgeRoute = calculateRouteWithStop(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: 0 }, prev: null, targetStationId: 'stBridge', cars: 1,
    });
    expect(bridgeRoute.path.map(c => ({ x: c.x, z: c.z, layer: c.layer }))).toEqual([
      { x: 1, z: 0, layer: undefined },
      { x: 2, z: 0, layer: 1 },
      { x: 3, z: 0, layer: undefined },
      { x: 4, z: 0, layer: undefined },
    ]);

    const groundRoute = calculateRouteWithStop(railMap, stations, noOccupied, noReserved, {
      start: { x: 2, z: -1 }, prev: null, targetStationId: 'stGround', cars: 1,
    });
    expect(groundRoute.path.map(c => ({ x: c.x, z: c.z, layer: c.layer }))).toEqual([
      { x: 2, z: 0, layer: undefined },
      { x: 2, z: 1, layer: undefined },
    ]);
  });
});

describe('十字乗換駅(交差セル)の経路探索', () => {
  // 十字駅: (0,0)を交差セルとして東西・南北の駅セル列が交わる1つの駅を作る。
  const buildCrossStation = () => {
    let state: ConstructionState = { railMap: new Map<string, CellData>(), stations: new Map() };
    // 南北方向を先に敷設(軸を明示。実際のドラッグ方向に相当)
    state = applyStation(state, { x: 0, z: -1 }, undefined, [], 'ns');
    state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ns');
    state = applyStation(state, { x: 0, z: 1 }, undefined, [], 'ns');
    // 東西方向を敷設(交差セル(0,0)を東西でも横切り、十字(cross)接続にする)
    state = applyStation(state, { x: -1, z: 0 }, undefined, [], 'ew');
    state = applyStation(state, { x: 0, z: 0 }, undefined, [], 'ew');
    state = applyStation(state, { x: 1, z: 0 }, undefined, [], 'ew');
    const stationId = state.railMap.get(toKey(0, 0))!.stationId!;
    expect(state.stations.size).toBe(1); // 十字全体が1つの駅に統合されている
    return { railMap: state.railMap, stations: state.stations, stationId };
  };

  it('南北の列車が交差セルを通過して目的駅に到達できる', () => {
    let { railMap, stations, stationId } = buildCrossStation();
    const state = applyRailPath({ railMap, stations }, [{ x: 0, z: -3 }, { x: 0, z: -2 }, { x: 0, z: -1 }]);
    railMap = state.railMap;
    stations = state.stations;

    const route = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 0, z: -3 },
      prev: null,
      targetStationId: stationId,
      cars: 1,
    });
    expect(route.map(c => ({ x: c.x, z: c.z }))).toEqual([
      { x: 0, z: -2 }, { x: 0, z: -1 }, { x: 0, z: 0 },
    ]);
  });

  it('東西の列車も同じ交差セルを通過して目的駅に到達できる', () => {
    let { railMap, stations, stationId } = buildCrossStation();
    const state = applyRailPath({ railMap, stations }, [{ x: -3, z: 0 }, { x: -2, z: 0 }, { x: -1, z: 0 }]);
    railMap = state.railMap;
    stations = state.stations;

    const route = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: -3, z: 0 },
      prev: null,
      targetStationId: stationId,
      cars: 1,
    });
    expect(route.map(c => ({ x: c.x, z: c.z }))).toEqual([
      { x: -2, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 0 },
    ]);
  });
});
