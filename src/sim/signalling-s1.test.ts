import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld, SimEvent } from './simulation';
import { buildBlockIndex } from './blocks';
import { PLAY_MODE_PRESETS } from './gameRules';

const connect = (map: Map<string, CellData>, a: { x: number; z: number }, b: { x: number; z: number }) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dir = getDirFromVector(dx, dz);
  const oppDir = getOppositeDir(dir);
  const aKey = toKey(a.x, a.z);
  const aCell = map.get(aKey) || { type: 'rail' as const, connections: 0 };
  map.set(aKey, { ...aCell, connections: (aCell.connections || 0) | dir });
  const bKey = toKey(b.x, b.z);
  const bCell = map.get(bKey) || { type: 'rail' as const, connections: 0 };
  map.set(bKey, { ...bCell, connections: (bCell.connections || 0) | oppDir });
};

const makeTrain = (overrides: Partial<TrainData>): TrainData => ({
  id: 't', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 2, ...overrides,
});

const s1Rules = { ...PLAY_MODE_PRESETS.light, signalling: 's1' as const };

describe('S1固定閉塞: 予約延長の占有ブロック判定', () => {
  it('信号が無ければ途中に安全点(駅)があっても、ブロック全体を1列車が占有している間は他列車が入れない', () => {
    // stW(0,0)-stMid(10,0、経由駅・行き先ではない)-stE(20,0)。信号は無し=0..20全体が1ブロック。
    // S0なら安全点stMidまでは互いに前進できてしまうが、S1では片方がブロックに入っている間、
    // もう一方はブロックの外(0または20)で待つはず。
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 20; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
    const mid1Key = toKey(5, 0);
    railMap.set(mid1Key, { ...railMap.get(mid1Key)!, type: 'station', stationId: 'stMid1' });
    const mid2Key = toKey(15, 0);
    railMap.set(mid2Key, { ...railMap.get(mid2Key)!, type: 'station', stationId: 'stMid2' });
    const eKey = toKey(20, 0);
    railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });
    const stations = new Map<string, StationData>([
      ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stMid1', { id: 'stMid1', name: 'Mid1', cells: [{ x: 5, z: 0 }], center: { x: 5, z: 0 }, platformDoors: 'none' }],
      ['stMid2', { id: 'stMid2', name: 'Mid2', cells: [{ x: 15, z: 0 }], center: { x: 15, z: 0 }, platformDoors: 'none' }],
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 20, z: 0 }], center: { x: 20, z: 0 }, platformDoors: 'none' }],
    ]);

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 20, z: 0, schedule: ['stW'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s1Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    let bothInsideAtSomeTick = false;
    for (let tick = 0; tick < 2000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const aInside = !!rtA && rtA.trail.some(c => c.x > 0 && c.x < 20);
      const bInside = !!rtB && rtB.trail.some(c => c.x > 0 && c.x < 20);
      if (aInside && bInside) bothInsideAtSomeTick = true;
    }
    expect(bothInsideAtSomeTick).toBe(false);
  });


  it('信号の無い単線1本(=1ブロック)では、片方の列車が入線している間はもう一方が入口で待つ', () => {
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 20; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
    const eKey = toKey(20, 0);
    railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });
    const stations = new Map<string, StationData>([
      ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 20, z: 0 }], center: { x: 20, z: 0 }, platformDoors: 'none' }],
    ]);

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 20, z: 0, schedule: ['stW'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s1Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    for (let tick = 0; tick < 3000; tick++) {
      stepWorld(world, dt);
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      if (rtA && rtB) {
        const setA = new Set(rtA.trail.map(c => toKey(c.x, c.z)));
        for (const c of rtB.trail) {
          expect(setA.has(toKey(c.x, c.z))).toBe(false);
        }
      }
    }
    // 単線1ブロックなので少なくとも一方は目的地に届かず、区間侵入を果たしていないはず。
    const rtA = world.runtimes.get('A')!;
    const rtB = world.runtimes.get('B')!;
    const aEntered = rtA.trail.some(c => c.x > 0 && c.x < 20);
    const bEntered = rtB.trail.some(c => c.x > 0 && c.x < 20);
    expect(aEntered && bEntered).toBe(false);
  });

  it('信号で区切った交換設備があれば、S1でも単線行き違いは機能する', () => {
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 10; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    for (let x = 15; x < 25; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    for (let x = 10; x < 15; x++) connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    connect(railMap, { x: 10, z: 0 }, { x: 11, z: 1 });
    connect(railMap, { x: 11, z: 1 }, { x: 12, z: 1 });
    connect(railMap, { x: 12, z: 1 }, { x: 13, z: 1 });
    connect(railMap, { x: 13, z: 1 }, { x: 14, z: 1 });
    connect(railMap, { x: 14, z: 1 }, { x: 15, z: 0 });

    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
    const eKey = toKey(25, 0);
    railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });

    railMap.set(toKey(11, 0), { ...railMap.get(toKey(11, 0))!, signalDir: DIR.E });
    railMap.set(toKey(14, 1), { ...railMap.get(toKey(14, 1))!, signalDir: DIR.W });
    railMap.set(toKey(14, 0), { ...railMap.get(toKey(14, 0))!, signalDir: DIR.E });

    const stations = new Map<string, StationData>([
      ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 25, z: 0 }], center: { x: 25, z: 0 }, platformDoors: 'none' }],
    ]);

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE', 'stW'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 25, z: 0, schedule: ['stW', 'stE'], scheduleIndex: 0 });
    const world: SimWorld = {
      railMap, stations, trains: [trainA, trainB], runtimes: new Map(), waiting: new Map(),
      rng: () => 1, towns: [], rules: s1Rules, blocks: buildBlockIndex(railMap),
    };

    const dt = 0.1;
    const maxTicks = 8000;
    let arriveA = 0;
    let arriveB = 0;
    let zeroSpeedStreak = 0;
    const DEADLOCK_STREAK_LIMIT = 3000;

    for (let tick = 0; tick < maxTicks; tick++) {
      const events: SimEvent[] = stepWorld(world, dt);
      for (const e of events) {
        if (e.type === 'arrive') {
          if (e.trainId === 'A') { arriveA++; trainA.scheduleIndex = (trainA.scheduleIndex + 1) % trainA.schedule.length; }
          else if (e.trainId === 'B') { arriveB++; trainB.scheduleIndex = (trainB.scheduleIndex + 1) % trainB.schedule.length; }
        }
      }
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const bothStopped = !!rtA && !!rtB && rtA.speedKmh === 0 && rtB.speedKmh === 0
        && rtA.stopRemaining === 0 && rtB.stopRemaining === 0 && rtA.haltRemaining === 0 && rtB.haltRemaining === 0;
      zeroSpeedStreak = bothStopped ? zeroSpeedStreak + 1 : 0;
      expect(zeroSpeedStreak).toBeLessThan(DEADLOCK_STREAK_LIMIT);
      if (arriveA >= 1 && arriveB >= 1) break;
    }
    expect(arriveA).toBeGreaterThanOrEqual(1);
    expect(arriveB).toBeGreaterThanOrEqual(1);
  });
});
