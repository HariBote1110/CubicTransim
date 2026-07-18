import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld, STOP_DURATION, ACCEL_KMH_S, TRAIN_LENGTH_TILES } from './simulation';
import type { SimWorld, SimEvent } from './simulation';
import { PASSENGER_SPAWN_RATE, STATION_WAITING_CAP, TRAIN_CAPACITY, FARE_PER_TILE } from './economy';

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
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(),
});

// 直線上に2駅(両端)を置く。列車が往復してincome/lastStopStationIdを検証するために使う。
const buildTwoStationLine = (length: number, stationAId: string, stationBId: string) => {
  const cells = Array.from({ length }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  const aKey = toKey(0, 0);
  const bKey = toKey(length - 1, 0);
  railMap.set(aKey, { ...railMap.get(aKey)!, type: 'station', stationId: stationAId });
  railMap.set(bKey, { ...railMap.get(bKey)!, type: 'station', stationId: stationBId });
  const stations = new Map<string, StationData>([
    [stationAId, { id: stationAId, name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 } }],
    [stationBId, { id: stationBId, name: 'B', cells: [{ x: length - 1, z: 0 }], center: { x: length - 1, z: 0 } }],
  ]);
  return { railMap, stations };
};

const runUntilStopped = (world: SimWorld, dt: number, maxTicks: number): SimEvent[] => {
  const events: SimEvent[] = [];
  for (let i = 0; i < maxTicks; i++) {
    events.push(...stepWorld(world, dt));
    const rt = world.runtimes.get(world.trains[0].id);
    if (rt && rt.stopRemaining > 0) break;
  }
  return events;
};

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
      passengers: 0, lastStopStationId: null,
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

describe('stepWorld: 旅客需要と運賃収入', () => {
  it('waitingは毎tick PASSENGER_SPAWN_RATE×dt ずつ増え、STATION_WAITING_CAPで頭打ちになる', () => {
    const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
    const world = makeWorld(railMap, stations, []);

    stepWorld(world, 1.0);
    expect(world.waiting.get('stA')).toBeCloseTo(PASSENGER_SPAWN_RATE, 5);
    expect(world.waiting.get('stB')).toBeCloseTo(PASSENGER_SPAWN_RATE, 5);

    // 大きなdtで一気に上限を超えさせる
    stepWorld(world, 100000);
    expect(world.waiting.get('stA')).toBe(STATION_WAITING_CAP);
  });

  it('停車時にwaitingから最大TRAIN_CAPACITYまで乗車し、waitingが減る', () => {
    const { railMap, stations } = buildTwoStationLine(6, 'stA', 'stB');
    const train = makeTrain({ schedule: ['stB', 'stA'] });
    const world = makeWorld(railMap, stations, [train]);
    // stBに大量の待ち客がいる状態を用意(capacityを超える)
    world.waiting.set('stB', TRAIN_CAPACITY + 50);

    // 停車する直前(dt適用前)のwaiting値を都度記録し、境界の1tickでの
    // 需要増加分を厳密に織り込んで期待値を計算する
    let waitingJustBeforeStop = world.waiting.get('stB')!;
    for (let i = 0; i < 5000; i++) {
      waitingJustBeforeStop = world.waiting.get('stB') ?? 0;
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1')!;
      if (rt.stopRemaining > 0) break;
    }

    const rt = world.runtimes.get('t1')!;
    expect(rt.passengers).toBe(TRAIN_CAPACITY);
    const waitingAfterGrowth = Math.min(STATION_WAITING_CAP, waitingJustBeforeStop + PASSENGER_SPAWN_RATE * 0.1);
    expect(world.waiting.get('stB')).toBeCloseTo(waitingAfterGrowth - TRAIN_CAPACITY, 5);
  });

  it('2駅目到着時にincomeイベントが発行される(金額=距離×FARE_PER_TILE×人数)', () => {
    const length = 6;
    const { railMap, stations } = buildTwoStationLine(length, 'stA', 'stB');
    // 列車はどちらの駅上にも置かず、中間セルから出発させる
    // (駅上から出発すると同一駅への経路長0でrouteが見つからず、到着イベントが発生しない)
    const train = makeTrain({ x: Math.floor(length / 2), z: 0, schedule: ['stA', 'stB'] });
    const world = makeWorld(railMap, stations, [train]);
    world.waiting.set('stA', 10);

    // 1駅目(stA)到着: 乗車のみ、income無し
    // (移動中もwaitingは増え続けるため、実際に乗車した人数を記録して以降の期待値に使う)
    const eventsAtA = runUntilStopped(world, 0.1, 5000);
    expect(eventsAtA.some(e => e.type === 'income')).toBe(false);
    const rtAfterA = world.runtimes.get('t1')!;
    const boardedAtA = rtAfterA.passengers;
    expect(boardedAtA).toBeGreaterThanOrEqual(10);
    expect(rtAfterA.lastStopStationId).toBe('stA');

    // 停車完了(STOP_DURATION経過)でarriveイベントが発行されるので、
    // 実機のuseGameLogic.handleTrainArrive相当の処理でscheduleIndexを進める
    let events: SimEvent[] = [];
    for (let i = 0; i < 50; i++) {
      const evs = stepWorld(world, 0.1);
      events.push(...evs);
      evs.forEach(e => {
        if (e.type === 'arrive') train.scheduleIndex = (train.scheduleIndex + 1) % train.schedule.length;
      });
    }
    // 2駅目(stB)到着まで進める
    let ticks = 0;
    let rt = world.runtimes.get('t1')!;
    while (ticks < 5000 && rt.grid.x !== length - 1) {
      events.push(...stepWorld(world, 0.1));
      rt = world.runtimes.get('t1')!;
      ticks++;
    }

    const incomeEvents = events.filter(e => e.type === 'income');
    expect(incomeEvents.length).toBe(1);
    const incomeEvent = incomeEvents[0] as Extract<SimEvent, { type: 'income' }>;
    expect(incomeEvent.passengers).toBe(boardedAtA);
    expect(incomeEvent.amount).toBeCloseTo((length - 1) * FARE_PER_TILE * boardedAtA, 5);
    expect(rt.lastStopStationId).toBe('stB');
  });
});
