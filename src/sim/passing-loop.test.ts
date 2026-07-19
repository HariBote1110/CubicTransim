import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld, SimEvent } from './simulation';

// 2セル間を接続する(双方向に connections ビットを立てる)。
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

// 受け入れシナリオのレイアウトを構築する:
// 駅W(0,0) - 単線(1..9,0) - 交換設備(本線10..15,0 / 待避線11..14,1) - 単線(16..24,0) - 駅E(25,0)
// 信号: (11,0)に東向き(東行きのみ本線へ進入可)、(14,1)に西向き(西行きのみ待避線から本線へ進入可)
const buildPassingLoopWorld = () => {
  const railMap = new Map<string, CellData>();

  // 単線区間 西側: 0..10
  for (let x = 0; x < 10; x++) {
    connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
  }
  // 単線区間 東側: 15..25
  for (let x = 15; x < 25; x++) {
    connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
  }
  // 交換設備 本線: 10..15 (すでに10-11, 14-15は上のループでカバーされないので明示接続)
  for (let x = 10; x < 15; x++) {
    connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
  }
  // 交換設備 待避線: (10,0)-(11,1)-(12,1)-(13,1)-(14,1)-(15,0)
  connect(railMap, { x: 10, z: 0 }, { x: 11, z: 1 });
  connect(railMap, { x: 11, z: 1 }, { x: 12, z: 1 });
  connect(railMap, { x: 12, z: 1 }, { x: 13, z: 1 });
  connect(railMap, { x: 13, z: 1 }, { x: 14, z: 1 });
  connect(railMap, { x: 14, z: 1 }, { x: 15, z: 0 });

  // 駅
  const wKey = toKey(0, 0);
  railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
  const eKey = toKey(25, 0);
  railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });

  // 信号: (11,0)は東向き(西行きの進入を禁止=本線は東行き専用)
  const s1Key = toKey(11, 0);
  railMap.set(s1Key, { ...railMap.get(s1Key)!, signalDir: DIR.E });
  // (14,1)は西向き(東行きの進入を禁止=待避線は西行き専用)
  const s2Key = toKey(14, 1);
  railMap.set(s2Key, { ...railMap.get(s2Key)!, signalDir: DIR.W });

  const stations = new Map<string, StationData>([
    ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
    ['stE', { id: 'stE', name: 'E', cells: [{ x: 25, z: 0 }], center: { x: 25, z: 0 }, platformDoors: 'none' }],
  ]);

  return { railMap, stations };
};

const makeTrain = (overrides: Partial<TrainData>): TrainData => ({
  id: 't',
  x: 0,
  z: 0,
  schedule: [],
  scheduleIndex: 0,
  status: 'running',
  ...overrides,
});

const makeWorld = (railMap: Map<string, CellData>, stations: Map<string, StationData>, trains: TrainData[]): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
});

// 両列車のtrail(占有セル)が同一セルを共有していないかを検証する。
const assertNoCollision = (world: SimWorld, tick: number) => {
  const rtA = world.runtimes.get('A');
  const rtB = world.runtimes.get('B');
  if (!rtA || !rtB) return;
  const setA = new Set(rtA.trail.map(c => toKey(c.x, c.z)));
  for (const c of rtB.trail) {
    if (setA.has(toKey(c.x, c.z))) {
      throw new Error(`衝突を検出しました(tick=${tick}): ${toKey(c.x, c.z)}`);
    }
  }
};

describe('信号場での自動すれ違い', () => {
  it('対向する2列車が交換設備を使ってすれ違い、衝突せず、デッドロックもせずに互いの目的駅へ到着する', () => {
    const { railMap, stations } = buildPassingLoopWorld();

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE', 'stW'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 25, z: 0, schedule: ['stW', 'stE'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [trainA, trainB]);

    const dt = 0.1;
    const maxTicks = 8000;
    let arriveA = 0;
    let arriveB = 0;
    let zeroSpeedStreak = 0;
    const DEADLOCK_STREAK_LIMIT = 3000; // 300シミュレーション秒、両者とも速度0が続いたらデッドロックとみなす

    for (let tick = 0; tick < maxTicks; tick++) {
      const events: SimEvent[] = stepWorld(world, dt);
      for (const e of events) {
        if (e.type === 'arrive') {
          if (e.trainId === 'A') {
            arriveA++;
            trainA.scheduleIndex = (trainA.scheduleIndex + 1) % trainA.schedule.length;
          } else if (e.trainId === 'B') {
            arriveB++;
            trainB.scheduleIndex = (trainB.scheduleIndex + 1) % trainB.schedule.length;
          }
        }
      }

      assertNoCollision(world, tick);

      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const bothStopped = !!rtA && !!rtB && rtA.speedKmh === 0 && rtB.speedKmh === 0
        && rtA.stopRemaining === 0 && rtB.stopRemaining === 0
        && rtA.haltRemaining === 0 && rtB.haltRemaining === 0;
      if (bothStopped) {
        zeroSpeedStreak++;
      } else {
        zeroSpeedStreak = 0;
      }
      expect(zeroSpeedStreak).toBeLessThan(DEADLOCK_STREAK_LIMIT);

      if (arriveA >= 1 && arriveB >= 1) break;
    }

    expect(arriveA).toBeGreaterThanOrEqual(1);
    expect(arriveB).toBeGreaterThanOrEqual(1);
  });
});

describe('頑健性: 交換設備の無い純単線での対向列車', () => {
  it('すれ違えないが、衝突はせずどちらかが手前で停止し続ける(永久デッドロックでも安全)', () => {
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 20; x++) {
      connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    }
    const wKey = toKey(0, 0);
    railMap.set(wKey, { ...railMap.get(wKey)!, type: 'station', stationId: 'stW' });
    const eKey = toKey(20, 0);
    railMap.set(eKey, { ...railMap.get(eKey)!, type: 'station', stationId: 'stE' });

    const stations = new Map<string, StationData>([
      ['stW', { id: 'stW', name: 'W', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stE', { id: 'stE', name: 'E', cells: [{ x: 20, z: 0 }], center: { x: 20, z: 0 }, platformDoors: 'none' }],
    ]);

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stE', 'stW'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 20, z: 0, schedule: ['stW', 'stE'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [trainA, trainB]);

    const dt = 0.1;
    for (let tick = 0; tick < 3000; tick++) {
      stepWorld(world, dt);
      assertNoCollision(world, tick);
    }
  });
});
