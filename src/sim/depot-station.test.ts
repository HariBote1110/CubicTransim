import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld, SimEvent } from './simulation';

// 車庫(0,0)の真ん前に駅X(1,0)、その先に駅Y(5,0)がある直線区間。
// 「車庫の真ん前に駅があるとバグるかもしれない」という報告の再現・修正確認用シナリオ。
const buildDepotLine = () => {
  const cells = Array.from({ length: 6 }, (_, i) => ({ x: i, z: 0 })); // 0..5
  const railMap = new Map<string, CellData>();
  for (let i = 0; i < cells.length - 1; i++) {
    const curr = cells[i];
    const next = cells[i + 1];
    const dir = getDirFromVector(next.x - curr.x, next.z - curr.z);
    const oppDir = getOppositeDir(dir);
    const currKey = toKey(curr.x, curr.z);
    const currCell = railMap.get(currKey) || { type: 'rail' as const, connections: 0 };
    railMap.set(currKey, { ...currCell, connections: (currCell.connections || 0) | dir });
    const nextKey = toKey(next.x, next.z);
    const nextCell = railMap.get(nextKey) || { type: 'rail' as const, connections: 0 };
    railMap.set(nextKey, { ...nextCell, connections: (nextCell.connections || 0) | oppDir });
  }
  railMap.set(toKey(0, 0), { ...railMap.get(toKey(0, 0))!, type: 'depot', rotation: 0 });
  railMap.set(toKey(1, 0), { ...railMap.get(toKey(1, 0))!, type: 'station', stationId: 'stX' });
  railMap.set(toKey(5, 0), { ...railMap.get(toKey(5, 0))!, type: 'station', stationId: 'stY' });

  const stations = new Map<string, StationData>([
    ['stX', { id: 'stX', name: 'X', cells: [{ x: 1, z: 0 }], center: { x: 1, z: 0 }, platformDoors: 'none' }],
    ['stY', { id: 'stY', name: 'Y', cells: [{ x: 5, z: 0 }], center: { x: 5, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

const makeTrain = (overrides: Partial<TrainData>): TrainData => ({
  id: 't1',
  x: 0,
  z: 0,
  schedule: [],
  scheduleIndex: 0,
  status: 'running',
  cars: 2,
  ...overrides,
});

const makeWorld = (railMap: Map<string, CellData>, stations: Map<string, StationData>, trains: TrainData[]): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1,
});

// 実機のuseGameLogic.handleTrainArrive相当。arriveイベントでscheduleIndexを進める。
const advanceSchedule = (train: TrainData, events: SimEvent[]) => {
  events.forEach(e => {
    if (e.type === 'arrive' && e.trainId === train.id) {
      train.scheduleIndex = (train.scheduleIndex + 1) % train.schedule.length;
    }
  });
};

const runTicks = (world: SimWorld, train: TrainData, dt: number, count: number): SimEvent[] => {
  const all: SimEvent[] = [];
  for (let i = 0; i < count; i++) {
    const evs = stepWorld(world, dt);
    all.push(...evs);
    advanceSchedule(train, evs);
  }
  return all;
};

describe('車庫の真ん前に駅があるシナリオ', () => {
  it('シナリオ1: スケジュール[X, Y] で X に到着・停車後、Y へ発車できる', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stX', 'stY'] });
    const world = makeWorld(railMap, stations, [train]);

    const events = runTicks(world, train, 0.1, 200);
    const rt = world.runtimes.get('t1')!;

    expect(events.some(e => e.type === 'arrive' && (e as any).scheduleIndex === 0)).toBe(true);
    expect(rt.debugStatus).not.toBe('Waiting for Path...');
    // stYに到着していること(cars=2でホーム長1のため多少停車時間が延びるが十分なtick数)
    expect(rt.grid.x).toBe(5);
  });

  it('シナリオ2: スケジュール[Y, X](先に遠い駅へ)でも正常に往復できる', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stY', 'stX'] });
    const world = makeWorld(railMap, stations, [train]);

    const events = runTicks(world, train, 0.1, 400);
    const rt = world.runtimes.get('t1')!;

    expect(events.some(e => e.type === 'arrive')).toBe(true);
    expect(rt.debugStatus).not.toBe('Waiting for Path...');
  });

  it('シナリオ3: 4両編成(trailが車庫からはみ出す)でも正常に発車・停車する', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stX', 'stY'], cars: 4 });
    const world = makeWorld(railMap, stations, [train]);

    const events = runTicks(world, train, 0.1, 300);
    const rt = world.runtimes.get('t1')!;

    expect(events.some(e => e.type === 'arrive')).toBe(true);
    expect(rt.debugStatus).not.toBe('Waiting for Path...');
    expect(rt.grid.x).toBe(5);
  });

  it('シナリオ4: スケジュールが[X]のみ(単独駅)でscheduleIndexがループしても永久Waitingにならない', () => {
    const { railMap, stations } = buildDepotLine();
    const train = makeTrain({ schedule: ['stX'] });
    const world = makeWorld(railMap, stations, [train]);

    // 最初にstXへ到着するまで進める
    let events = runTicks(world, train, 0.1, 100);
    expect(events.some(e => e.type === 'arrive')).toBe(true);
    let rt = world.runtimes.get('t1')!;
    expect(rt.grid.x).toBe(1);

    // scheduleIndexは0のままstXに戻ってくる。この状態でさらに進めても
    // 「既に目的駅にいる」ため経路が空になり、永久Waitingにならず
    // 停車→到着イベントを繰り返せることを確認する。
    const arriveEventsAfter = runTicks(world, train, 0.1, 200).filter(e => e.type === 'arrive');
    expect(arriveEventsAfter.length).toBeGreaterThan(0);
    rt = world.runtimes.get('t1')!;
    expect(rt.debugStatus).not.toBe('Waiting for Path...');
  });
});
