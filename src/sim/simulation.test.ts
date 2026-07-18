import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld, STOP_DURATION, ACCEL_KMH_S, TRAIN_LENGTH_TILES } from './simulation';
import type { SimWorld, SimEvent } from './simulation';

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
  ...overrides,
});

const makeWorld = (railMap: Map<string, CellData>, stations: Map<string, StationData>, trains: TrainData[]): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(),
});

const runTicks = (world: SimWorld, dt: number, count: number): SimEvent[] => {
  const events: SimEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(...stepWorld(world, dt));
  }
  return events;
};

const buildStraightLine = (length: number, stationId: string) => {
  const cells = Array.from({ length }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  const lastKey = toKey(length - 1, 0);
  railMap.set(lastKey, { ...railMap.get(lastKey)!, type: 'station', stationId });
  const stations = new Map<string, StationData>([
    [stationId, { id: stationId, name: 'A', cells: [{ x: length - 1, z: 0 }], center: { x: length - 1, z: 0 } }],
  ]);
  return { railMap, stations };
};

describe('stepWorld', () => {
  it('加速: 障害物が無ければ速度がACCEL_KMH_S刻みで増える', () => {
    const { railMap, stations } = buildStraightLine(10, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    runTicks(world, dt, 3);

    const rt = world.runtimes.get('t1')!;
    expect(rt.speedKmh).toBeCloseTo(ACCEL_KMH_S * dt * 3, 5);
  });

  it('走行: progressが進みマスが進行してtrailが更新される(上限TRAIN_LENGTH_TILES)', () => {
    const { railMap, stations } = buildStraightLine(10, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    let ticks = 0;
    let rt = world.runtimes.get('t1');
    while (ticks < 3000) {
      stepWorld(world, dt);
      ticks++;
      rt = world.runtimes.get('t1')!;
      if (rt.grid.x >= 2) break;
    }

    expect(rt!.grid.x).toBeGreaterThanOrEqual(2);
    expect(rt!.trail.length).toBe(TRAIN_LENGTH_TILES);
    expect(rt!.trail[0]).toEqual(rt!.grid);
  });

  it('目標駅到着: 停車しstopRemaining=STOP_DURATIONがセットされ、speed=0になる', () => {
    const { railMap, stations } = buildStraightLine(6, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    let ticks = 0;
    let rt = world.runtimes.get('t1');
    while (ticks < 5000) {
      stepWorld(world, dt);
      ticks++;
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    expect(rt!.stopRemaining).toBe(STOP_DURATION);
    expect(rt!.speedKmh).toBe(0);
    expect(rt!.grid).toEqual({ x: 5, z: 0 });
  });

  it('3秒経過(dtを複数回)でarriveイベントが1回だけ発行される', () => {
    const { railMap, stations } = buildStraightLine(6, 'stA');
    const train = makeTrain({ schedule: ['stA'] });
    const world = makeWorld(railMap, stations, [train]);

    const dt = 0.1;
    let ticks = 0;
    let rt = world.runtimes.get('t1');
    while (ticks < 5000) {
      stepWorld(world, dt);
      ticks++;
      rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    let arriveCount = 0;
    for (let i = 0; i < 10; i++) {
      const evs = stepWorld(world, 0.5);
      arriveCount += evs.filter(e => e.type === 'arrive').length;
    }

    expect(arriveCount).toBe(1);
  });

  it('前方マスを他列車のtrailが占有していれば速度0になる(即時ブロック)', () => {
    const { railMap, stations } = buildStraightLine(5, 'stA');
    const trainA = makeTrain({ id: 'A', schedule: ['stA'] });
    const trainB = makeTrain({ id: 'B', x: 1, z: 0, status: 'stored' });
    const world = makeWorld(railMap, stations, [trainA, trainB]);

    world.runtimes.set('B', {
      id: 'B', grid: { x: 1, z: 0 }, prevGrid: null, progress: 0, speedKmh: 0,
      route: [], trail: [{ x: 1, z: 0 }], stopRemaining: 0, waitTimer: 0, debugStatus: '',
      renderPos: { x: 1, y: 0.5, z: 0 }, renderTarget: null,
    });

    stepWorld(world, 0.1);

    const rtA = world.runtimes.get('A')!;
    expect(rtA.speedKmh).toBe(0);
  });

  it('storedの列車はrouteもspeedも変化しない(runtimeも生成しない)', () => {
    const { railMap, stations } = buildStraightLine(5, 'stA');
    const train = makeTrain({ schedule: ['stA'], status: 'stored' });
    const world = makeWorld(railMap, stations, [train]);

    runTicks(world, 0.1, 10);

    expect(world.runtimes.get('t1')).toBeUndefined();
  });
});
