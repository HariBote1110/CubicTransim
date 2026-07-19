import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData, TownData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import { carPositions } from './consist';

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

const makeTrain = (overrides: Partial<TrainData>): TrainData => ({
  id: 't1',
  x: 0,
  z: 0,
  schedule: [],
  scheduleIndex: 0,
  status: 'running',
  cars: 4,
  ...overrides,
});

const makeWorld = (
  railMap: Map<string, CellData>,
  stations: Map<string, StationData>,
  trains: TrainData[],
  towns: TownData[] = []
): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1, towns,
});

describe('carPositions (連結車両のなめらか配置)', () => {
  it('直線走行中、各車両の間隔が常に spacing±誤差内である', () => {
    const cells = Array.from({ length: 30 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    const startKey = toKey(0, 0);
    const endKey = toKey(29, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 29, z: 0 }], center: { x: 29, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ x: 0, z: 0, schedule: ['stB'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [train]);

    for (let i = 0; i < 300; i++) {
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1')!;
      if (rt.grid.x < 5 || rt.grid.x > 20) continue; // 加減速区間を除いた巡航区間のみ検証
      const positions = carPositions(rt, 4, 1.0);
      for (let k = 1; k < positions.length; k++) {
        const dx = positions[k - 1].x - positions[k].x;
        const dz = positions[k - 1].z - positions[k].z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        expect(dist).toBeGreaterThan(0.9);
        expect(dist).toBeLessThan(1.1);
      }
    }
  });

  it('先頭がセル境界を跨ぐ瞬間の前後で2両目の位置がジャンプしない', () => {
    const cells = Array.from({ length: 30 }, (_, i) => ({ x: i, z: 0 }));
    const railMap = buildRailMap(cells);
    const startKey = toKey(0, 0);
    const endKey = toKey(29, 0);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 29, z: 0 }], center: { x: 29, z: 0 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ x: 0, z: 0, schedule: ['stB'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [train]);

    let prevCar1: { x: number; z: number } | null = null;
    for (let i = 0; i < 500; i++) {
      stepWorld(world, 0.02);
      const rt = world.runtimes.get('t1')!;
      if (rt.grid.x < 5 || rt.grid.x > 20) { prevCar1 = null; continue; }
      const positions = carPositions(rt, 4, 1.0);
      const car1 = positions[1];
      if (prevCar1) {
        const dx = car1.x - prevCar1.x;
        const dz = car1.z - prevCar1.z;
        const moved = Math.sqrt(dx * dx + dz * dz);
        // dt=0.02sで最大速度(100km/h)でも1tick最大移動量は約0.56タイル。跳躍が起きればこれを大きく超える。
        expect(moved).toBeLessThan(0.7);
      }
      prevCar1 = { x: car1.x, z: car1.z };
    }
  });

  it('45度カーブ通過時も車両間隔(弧長基準)が維持される', () => {
    // (0,0)->(10,0) 直線 -> (10,0)->(20,10) 斜め45度 -> (20,10)->(30,10) 直線
    const cells: { x: number; z: number }[] = [];
    for (let x = 0; x <= 10; x++) cells.push({ x, z: 0 });
    for (let i = 1; i <= 10; i++) cells.push({ x: 10 + i, z: i });
    for (let x = 21; x <= 30; x++) cells.push({ x, z: 10 });
    const railMap = buildRailMap(cells);
    const startKey = toKey(0, 0);
    const endKey = toKey(30, 10);
    railMap.set(startKey, { ...railMap.get(startKey)!, type: 'station', stationId: 'stA' });
    railMap.set(endKey, { ...railMap.get(endKey)!, type: 'station', stationId: 'stB' });
    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 30, z: 10 }], center: { x: 30, z: 10 }, platformDoors: 'none' }],
    ]);
    const train = makeTrain({ x: 0, z: 0, schedule: ['stB'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [train]);

    let checked = 0;
    for (let i = 0; i < 400; i++) {
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1')!;
      // カーブ区間(x:11..19)を通過中のみ検証
      if (rt.grid.x < 12 || rt.grid.x > 18) continue;
      const positions = carPositions(rt, 4, 1.0);
      for (let k = 1; k < positions.length; k++) {
        const dx = positions[k - 1].x - positions[k].x;
        const dz = positions[k - 1].z - positions[k].z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        expect(dist).toBeGreaterThan(0.85);
        expect(dist).toBeLessThan(1.15);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
