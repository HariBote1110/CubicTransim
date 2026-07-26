import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import { calculateRouteWithStop } from './pathfinding';
import { carPositions } from './consist';

// 停車位置がセル中心に量子化されず、編成中央がホーム中央と一致することを検証する。
// 旧実装は headIdx = ceil((P+cars)/2)-1 と切り上げていたため、P+cars が奇数のとき
// 編成が半セル(=15m)ホーム奥へ寄っていた。

const buildRailMap = (cells: { x: number; z: number }[]) => {
  const map = new Map<string, CellData>();
  for (let i = 0; i < cells.length - 1; i++) {
    const curr = cells[i];
    const next = cells[i + 1];
    const dir = getDirFromVector(next.x - curr.x, next.z - curr.z);
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

// 長さ lineLength の直線に、末尾 platformLen セルぶんのホームを敷いた盤面。
const buildLineWithPlatform = (lineLength: number, platformLen: number) => {
  const cells = Array.from({ length: lineLength }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  const platformCells: { x: number; z: number }[] = [];
  for (let i = 0; i < platformLen; i++) {
    const x = lineLength - platformLen + i;
    const key = toKey(x, 0);
    railMap.set(key, { ...railMap.get(key)!, type: 'station', stationId: 'stP' });
    platformCells.push({ x, z: 0 });
  }
  const centreX = (platformCells[0].x + platformCells[platformCells.length - 1].x) / 2;
  const stations = new Map<string, StationData>([
    ['stP', { id: 'stP', name: 'P', cells: platformCells, center: { x: centreX, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations, platformCells, centreX };
};

// 目的駅に停車するまで進め、停車後の runtime を返す。
const runUntilStopped = (railMap: Map<string, CellData>, stations: Map<string, StationData>, cars: number) => {
  const train: TrainData = { id: 't1', x: 0, z: 0, schedule: ['stP'], scheduleIndex: 0, status: 'running', cars };
  const world: SimWorld = {
    railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
  };
  for (let i = 0; i < 20000; i++) {
    stepWorld(world, 1 / 60);
    const rt = world.runtimes.get('t1')!;
    if (rt.stopRemaining > 0) return { rt, train };
  }
  throw new Error('列車が停車しなかった');
};

describe('停止位置のサブセル精度', () => {
  it('calculateRouteWithStop は P+cars が奇数のとき stopProgress=0.5 を返す', () => {
    // ホーム3セル・2両 → 先頭車の理想停止位置は入口から1.5セル。
    // 経路は切り上げて2セル目(奥端)まで延ばし、その区間の途中0.5で停める。
    const { railMap, stations } = buildLineWithPlatform(8, 3);
    const result = calculateRouteWithStop(railMap, stations, new Set(), new Set(), {
      start: { x: 0, z: 0 }, prev: null, targetStationId: 'stP', cars: 2, stopLocation: 'middle',
    });
    expect(result.path[result.path.length - 1]).toEqual({ x: 7, z: 0 });
    expect(result.stopProgress).toBeCloseTo(0.5, 6);
  });

  it('P+cars が偶数なら従来どおり stopProgress=1(セル中心停車)', () => {
    // ホーム4セル・2両 → 理想停止位置は入口から2セル(整数)。
    const { railMap, stations } = buildLineWithPlatform(9, 4);
    const result = calculateRouteWithStop(railMap, stations, new Set(), new Set(), {
      start: { x: 0, z: 0 }, prev: null, targetStationId: 'stP', cars: 2, stopLocation: 'middle',
    });
    expect(result.stopProgress).toBe(1);
  });

  it('3セルホームに2両で停車すると編成中央がホーム中央と一致する', () => {
    const { railMap, stations, centreX } = buildLineWithPlatform(8, 3);
    const { rt } = runUntilStopped(railMap, stations, 2);

    const positions = carPositions(rt, 2, 1.0);
    const consistCentreX = (positions[0].x + positions[positions.length - 1].x) / 2;

    // 旧実装では 0.5セル(=15m)ずれていた。1cm以内で一致することを要求する。
    expect(consistCentreX).toBeCloseTo(centreX, 2);
  });

  it('5セルホームに4両で停車しても編成中央がホーム中央と一致する', () => {
    const { railMap, stations, centreX } = buildLineWithPlatform(12, 5);
    const { rt } = runUntilStopped(railMap, stations, 4);

    const positions = carPositions(rt, 4, 1.0);
    const consistCentreX = (positions[0].x + positions[positions.length - 1].x) / 2;
    expect(consistCentreX).toBeCloseTo(centreX, 2);
  });

  it('端数停車中も車間が spacing 一定に保たれる(ポリライン折り返しでめり込まない)', () => {
    const { railMap, stations } = buildLineWithPlatform(10, 3);
    const { rt } = runUntilStopped(railMap, stations, 3);

    const positions = carPositions(rt, 3, 1.0);
    for (let k = 1; k < positions.length; k++) {
      const dx = positions[k - 1].x - positions[k].x;
      const dz = positions[k - 1].z - positions[k].z;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeCloseTo(1.0, 3);
    }
  });

  it('端数停車から発車しても描画位置が跳ねない(連続して前進する)', () => {
    const { railMap, stations } = buildLineWithPlatform(8, 3);
    const train: TrainData = { id: 't1', x: 0, z: 0, schedule: ['stP', 'stP'], scheduleIndex: 0, status: 'running', cars: 2 };
    const world: SimWorld = {
      railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
    };

    // 停車するまで進める
    let rt = world.runtimes.get('t1');
    for (let i = 0; i < 20000; i++) {
      stepWorld(world, 1 / 60);
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }
    const stoppedX = rt!.renderPos.x;
    expect(stoppedX).toBeCloseTo(6.5, 3);

    // 折り返し(反転)しない前進発車を作るため、目的駅はそのままに再探索させる。
    // 停車時間を消化したあとの数tickで renderPos が跳ばないことを確認する。
    let prevX = stoppedX;
    for (let i = 0; i < 400; i++) {
      stepWorld(world, 1 / 60);
      rt = world.runtimes.get('t1')!;
      const jump = Math.abs(rt.renderPos.x - prevX);
      // 1tickあたりの移動量は最大でも MAX_SPEED(100km/h)×dt÷30m ≒ 0.093セル。
      expect(jump).toBeLessThan(0.15);
      prevX = rt.renderPos.x;
    }
  });
});
