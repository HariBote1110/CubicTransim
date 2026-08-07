import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData, TownData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld, TrainRuntime } from './simulation';
import { carPositions } from './consist';
import { fieldFromMaps } from './terrainField';
import { OVERPASS_HEIGHT } from './trackPath';

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

describe('carPositions: 地下(layer<0)の描画高さは地表からの相対深さ(P8b)', () => {
  // 先頭車(k=0)はポリラインの基準点(rt.renderPos、simulation.tsのcellCentreHeightが
  // 既に正しく計算済みの値)をそのまま使う。ここではrenderPos.yに実際にsimが計算する
  // であろう正しい値を与えたうえで、2両目(pathHistoryを辿ってtrackCentreHeightで
  // 高さを引き直す経路)が同じ高さになることを確認する: 修正前は地下(layer<0)の
  // 非rampセルがtrackCentreHeightで常に平地(0.5)扱いになるバグがあり、丘の上では
  // 先頭と2両目の間に高さの断絶(=見た目のガクつき)が生じていた。
  const buildRuntime = (
    grid: { x: number; z: number; layer: -1 },
    prevGrid: { x: number; z: number; layer: -1 },
    headY: number
  ) => ({
    id: 't1', grid, prevGrid, progress: 0, speedKmh: 0, route: [],
    reservedEndIndex: -1, trail: [grid, prevGrid], pathHistory: [grid, prevGrid],
    stopRemaining: 0, waitTimer: 0, debugStatus: '', renderPos: { x: grid.x, y: headY, z: grid.z },
    renderTarget: null, passengers: 0, lastStopStationId: null, haltRemaining: 0,
  }) as unknown as TrainRuntime;

  it('丘の上(標高2)の地下1段は、丘の地表高さから1段沈んだ位置になる(地表が高さ0でも同じ1段沈む)', () => {
    // 標高2の丘(flatセル、四隅すべて2)に地下1段のspanセル(rampではない)を2つ並べる。
    const heights = new Map<string, number>();
    for (let x = 2; x <= 8; x++) for (let z = 2; z <= 8; z++) heights.set(`${x},${z}`, 2);
    const terrain = new Map<string, 'water' | 'mountain'>();
    const field = fieldFromMaps(heights, terrain, 20);

    const railMap = new Map<string, CellData>([
      ['5,5', { type: 'rail', uppers: { '-1': { connections: 0 } } }],
      ['4,5', { type: 'rail', uppers: { '-1': { connections: 0 } } }],
    ]);

    // 丘の地表(2段=2*OVERPASS_HEIGHT)から地下1段(-1*OVERPASS_HEIGHT)沈んだ高さ:
    // 0.5(車体基準) + 2*OVERPASS_HEIGHT(地表) - 1*OVERPASS_HEIGHT(地下1段) = 0.5 + 1*OVERPASS_HEIGHT
    // (低地の地下1段=0.5-OVERPASS_HEIGHTとは異なり、丘の上では絶対高さがそのぶん高いまま沈む)。
    const expectedY = 0.5 + 1 * OVERPASS_HEIGHT;
    const grid = { x: 5, z: 5, layer: -1 as const };
    const prevGrid = { x: 4, z: 5, layer: -1 as const };
    const rt = buildRuntime(grid, prevGrid, expectedY);

    const positions = carPositions(rt, 2, 1.0, railMap, field);
    // grid・prevGridどちらも同じ丘・同じ地下段なので、2両目の高さも先頭と一致する
    // (修正前はここが0.5固定になり、丘の上で先頭とずれていた)。
    expect(positions[1].y).toBeCloseTo(expectedY, 5);
  });

  it('平地(標高0)の地下1段は0.5-OVERPASS_HEIGHTになる(比較対象)', () => {
    const heights = new Map<string, number>();
    const terrain = new Map<string, 'water' | 'mountain'>();
    const field = fieldFromMaps(heights, terrain, 20);
    const railMap = new Map<string, CellData>([
      ['5,5', { type: 'rail', uppers: { '-1': { connections: 0 } } }],
      ['4,5', { type: 'rail', uppers: { '-1': { connections: 0 } } }],
    ]);
    const expectedY = 0.5 - 1 * OVERPASS_HEIGHT;
    const grid = { x: 5, z: 5, layer: -1 as const };
    const prevGrid = { x: 4, z: 5, layer: -1 as const };
    const rt = buildRuntime(grid, prevGrid, expectedY);
    const positions = carPositions(rt, 2, 1.0, railMap, field);
    expect(positions[1].y).toBeCloseTo(expectedY, 5);
  });
});
