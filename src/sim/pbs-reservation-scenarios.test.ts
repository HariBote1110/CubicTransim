import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld, SimEvent } from './simulation';

// 2セル間を接続する(双方向に connections ビットを立てる)。passing-loop.test.tsと同じ規約。
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
  id: 't',
  x: 0,
  z: 0,
  schedule: [],
  scheduleIndex: 0,
  status: 'running',
  cars: 2,
  ...overrides,
});

const makeWorld = (railMap: Map<string, CellData>, stations: Map<string, StationData>, trains: TrainData[]): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
});

const assertNoCollision = (world: SimWorld, tick: number) => {
  const runtimes = [...world.runtimes.values()];
  for (let i = 0; i < runtimes.length; i++) {
    for (let j = i + 1; j < runtimes.length; j++) {
      const setA = new Set(runtimes[i].trail.map(c => toKey(c.x, c.z)));
      for (const c of runtimes[j].trail) {
        if (setA.has(toKey(c.x, c.z))) {
          throw new Error(`衝突を検出しました(tick=${tick}): ${toKey(c.x, c.z)}`);
        }
      }
    }
  }
};

describe('PBS予約モデル: 双方向1本ホーム', () => {
  it('対向2列車が行き止まりでない共有ホームを順番に使用し、衝突・デッドロックしない', () => {
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 10; x++) {
      connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    }
    // 中央(5,0)を両側から入れる通過型の1セルホームにする(行き止まりではない)。
    const mKey = toKey(5, 0);
    railMap.set(mKey, { ...railMap.get(mKey)!, type: 'station', stationId: 'stM' });
    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
    const eKey = toKey(10, 0);
    railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });

    const stations = new Map<string, StationData>([
      ['stM', { id: 'stM', name: 'M', cells: [{ x: 5, z: 0 }], center: { x: 5, z: 0 }, platformDoors: 'none' }],
      ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 10, z: 0 }], center: { x: 10, z: 0 }, platformDoors: 'none' }],
    ]);

    // 両列車ともまず中央のstMを目指し、その後は自分の始発側の終端へ戻ってstMを空ける。
    const trainA = makeTrain({ id: 'A', x: 1, z: 0, schedule: ['stM', 'stW'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 9, z: 0, schedule: ['stM', 'stE'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [trainA, trainB]);

    const dt = 0.1;
    let arriveAAtM = 0;
    let arriveBAtM = 0;
    let zeroSpeedStreak = 0;
    const DEADLOCK_STREAK_LIMIT = 3000;

    for (let tick = 0; tick < 6000; tick++) {
      const events: SimEvent[] = stepWorld(world, dt);
      for (const e of events) {
        if (e.type === 'arrive') {
          if (e.trainId === 'A') {
            if (e.scheduleIndex === 0) arriveAAtM++;
            trainA.scheduleIndex = (trainA.scheduleIndex + 1) % trainA.schedule.length;
          } else if (e.trainId === 'B') {
            if (e.scheduleIndex === 0) arriveBAtM++;
            trainB.scheduleIndex = (trainB.scheduleIndex + 1) % trainB.schedule.length;
          }
        }
      }

      assertNoCollision(world, tick);

      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const bothStopped = !!rtA && !!rtB && rtA.speedKmh === 0 && rtB.speedKmh === 0
        && rtA.stopRemaining === 0 && rtB.stopRemaining === 0 && rtA.haltRemaining === 0 && rtB.haltRemaining === 0;
      zeroSpeedStreak = bothStopped ? zeroSpeedStreak + 1 : 0;
      expect(zeroSpeedStreak).toBeLessThan(DEADLOCK_STREAK_LIMIT);

      if (arriveAAtM >= 1 && arriveBAtM >= 1) break;
    }

    expect(arriveAAtM).toBeGreaterThanOrEqual(1);
    expect(arriveBAtM).toBeGreaterThanOrEqual(1);
  });
});

describe('PBS予約モデル: 予約の解放', () => {
  it('列車が通過したセルは、trailから抜けた時点で他列車から予約可能になる', () => {
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 10; x++) {
      connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    }
    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
    const eKey = toKey(10, 0);
    railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });
    const stations = new Map<string, StationData>([
      ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 10, z: 0 }], center: { x: 10, z: 0 }, platformDoors: 'none' }],
    ]);

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE'], scheduleIndex: 0, cars: 2 });
    const world = makeWorld(railMap, stations, [trainA]);

    const dt = 0.1;
    for (let tick = 0; tick < 200; tick++) {
      stepWorld(world, dt);
    }

    const rtA = world.runtimes.get('A')!;
    expect(rtA.grid.x).toBeGreaterThan(1);

    // 列車Aの現在のtrail(=占有中のセル)には含まれない、既に通過して抜けたセル(x=0)は
    // 予約テーブル上でも解放されている(Aの所有ではなくなっている)はず。
    expect(world.reservations?.has(toKey(0, 0))).toBe(false);
    expect(rtA.trail.some(c => c.x === 0 && c.z === 0)).toBe(false);

    // 解放されたセルは他列車が予約可能。
    const cell0Owner = world.reservations?.get(toKey(0, 0));
    expect(cell0Owner).toBeUndefined();
  });
});

describe('PBS予約モデル: 分岐の直前で待たない', () => {
  it('経路上に分岐点があっても、列車の停止位置は分岐点そのものにならない', () => {
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 10; x++) {
      connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    }
    for (let x = 15; x < 25; x++) {
      connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    }
    for (let x = 10; x < 15; x++) {
      connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    }
    connect(railMap, { x: 10, z: 0 }, { x: 11, z: 1 });
    connect(railMap, { x: 11, z: 1 }, { x: 12, z: 1 });
    connect(railMap, { x: 12, z: 1 }, { x: 13, z: 1 });
    connect(railMap, { x: 13, z: 1 }, { x: 14, z: 1 });
    connect(railMap, { x: 14, z: 1 }, { x: 15, z: 0 });

    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
    const eKey = toKey(25, 0);
    railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });
    const s1Key = toKey(11, 0);
    railMap.set(s1Key, { ...railMap.get(s1Key)!, signalDir: DIR.E });
    const s2Key = toKey(14, 1);
    railMap.set(s2Key, { ...railMap.get(s2Key)!, signalDir: DIR.W });

    const stations = new Map<string, StationData>([
      ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 25, z: 0 }], center: { x: 25, z: 0 }, platformDoors: 'none' }],
    ]);

    const popcount = (n: number) => {
      let c = 0; let v = n;
      while (v) { c += v & 1; v >>= 1; }
      return c;
    };
    const isJunctionCell = (x: number, z: number) => {
      const cell = railMap.get(toKey(x, z));
      return popcount(cell?.connections ?? 0) >= 3;
    };

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE', 'stW'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 25, z: 0, schedule: ['stW', 'stE'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [trainA, trainB]);

    const dt = 0.1;
    for (let tick = 0; tick < 400; tick++) {
      stepWorld(world, dt);
      for (const rt of world.runtimes.values()) {
        if (rt.speedKmh === 0 && rt.route.length > 0) {
          // 走行中に速度0で待機している(=safe waiting pointで待っている)なら、
          // その現在地は分岐点であってはならない。
          expect(isJunctionCell(rt.grid.x, rt.grid.z)).toBe(false);
        }
      }
    }
  });
});
