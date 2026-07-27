import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';

// 2セル間を接続する(双方向に connections ビットを立てる)。
// src/sim/passing-loop.test.ts の connect を参考に、本ファイル内で自前で用意する。
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

// 駅A(x=0) --- 単線(x=1..14、信号なし) --- 駅B(x=15) の一直線。
// 交換設備が無いため、対向列車どうしはすれ違えない。安全な挙動は
// 「単線区間には正面衝突せずに、一方が手前で待つ」ことである。
describe('単線での対向列車デッドロック回避(交換設備・信号なし)', () => {
  it('2本の対向列車が同時に単線区間へ入らず、少なくとも一方は目的駅に到着する', () => {
    const railMap = new Map<string, CellData>();
    for (let x = 0; x < 15; x++) {
      connect(railMap, { x, z: 0 }, { x: x + 1, z: 0 });
    }
    const aKey = toKey(0, 0);
    railMap.set(aKey, { ...railMap.get(aKey)!, type: 'station', stationId: 'stA' });
    const bKey = toKey(15, 0);
    railMap.set(bKey, { ...railMap.get(bKey)!, type: 'station', stationId: 'stB' });

    const stations = new Map<string, StationData>([
      ['stA', { id: 'stA', name: 'A', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none' }],
      ['stB', { id: 'stB', name: 'B', cells: [{ x: 15, z: 0 }], center: { x: 15, z: 0 }, platformDoors: 'none' }],
    ]);

    const trainA = makeTrain({ id: 'A', x: 0, z: 0, schedule: ['stB', 'stA'], scheduleIndex: 0 });
    const trainB = makeTrain({ id: 'B', x: 15, z: 0, schedule: ['stA', 'stB'], scheduleIndex: 0 });
    const world = makeWorld(railMap, stations, [trainA, trainB]);

    const dt = 0.1;
    const maxTicks = 6000;
    let arriveA = 0;
    let arriveB = 0;

    for (let tick = 0; tick < maxTicks; tick++) {
      const events = stepWorld(world, dt);
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

      // (a) いかなる時点でも2本の列車が単線区間(x=1..14)に同時に存在しない。
      const rtA = world.runtimes.get('A');
      const rtB = world.runtimes.get('B');
      const inSection = (grid: { x: number; z: number } | undefined) =>
        !!grid && grid.x >= 1 && grid.x <= 14 && grid.z === 0;
      if (inSection(rtA?.grid) && inSection(rtB?.grid)) {
        throw new Error(`両列車が単線区間に同時進入しました(tick=${tick}): A=${JSON.stringify(rtA?.grid)} B=${JSON.stringify(rtB?.grid)}`);
      }

      if (arriveA >= 1 || arriveB >= 1) break;
    }

    // (b) 少なくとも一方は目的駅に到着している。
    expect(arriveA + arriveB).toBeGreaterThanOrEqual(1);
  });
});
