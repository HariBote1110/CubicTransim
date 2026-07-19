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
    });
    expect(eastboundResult).toEqual([
      { x: 1, z: 1 }, { x: 2, z: 1 }, { x: 3, z: 1 }, { x: 4, z: 1 }, { x: 5, z: 1 }, { x: 6, z: 0 },
    ]);

    // 西行き(東から進入、prev=(7,0)): 進行方向左側=z=0(北)の線路を選ぶ
    const westboundResult = calculateRoute(railMap, stations, noOccupied, noReserved, {
      start: { x: 6, z: 0 },
      prev: { x: 7, z: 0 },
      targetStationId: 'stWest',
    });
    expect(westboundResult).toEqual([
      { x: 5, z: 0 }, { x: 4, z: 0 }, { x: 3, z: 0 }, { x: 2, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 0 },
    ]);
  });
});
