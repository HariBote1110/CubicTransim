import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from '../sim/simulation';
import type { SimWorld } from '../sim/simulation';
import {
  computeRiderCamera, PASSENGER_EYE_HEIGHT, PASSENGER_LOOK_AHEAD,
} from './passengerView';

// D2: 乗客視点カメラの純関数テスト。sim/consist.ts の carPositions(曲線サンプリング)を
// そのまま使う前提なので、ここでは「carPositions の先頭車出力 + 固定オフセット」の
// 組み立てが正しいことだけを検証する(曲線そのものの正しさは consist.test.ts の担当)。

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
  id: 't1', x: 0, z: 0, schedule: [], scheduleIndex: 0, status: 'running', cars: 4, ...overrides,
});

const makeWorld = (
  railMap: Map<string, CellData>, stations: Map<string, StationData>, trains: TrainData[],
): SimWorld => ({
  railMap, stations, trains, runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
});

describe('computeRiderCamera (D2 乗客視点カメラ)', () => {
  it('存在しない列車IDにはnullを返す', () => {
    const railMap = buildRailMap([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const world = makeWorld(railMap, new Map(), []);
    expect(computeRiderCamera(world, 'no-such-train')).toBeNull();
  });

  it('直線走行中、eyeは先頭車位置+PASSENGER_EYE_HEIGHT、lookはeyeから進行方向へPASSENGER_LOOK_AHEADだけ先', () => {
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

    let cam: ReturnType<typeof computeRiderCamera> = null;
    for (let i = 0; i < 300; i++) {
      stepWorld(world, 0.1);
      const rt = world.runtimes.get('t1')!;
      if (rt.grid.x < 10 || rt.grid.x > 20) continue; // 巡航区間(直線・定速)だけ見る
      cam = computeRiderCamera(world, 't1');
      break;
    }
    expect(cam).not.toBeNull();
    const rt = world.runtimes.get('t1')!;
    // 直線+x方向を巡航中なので heading はほぼ (1,0,0)。
    expect(cam!.eye[0]).toBeCloseTo(rt.renderPos.x, 1);
    expect(cam!.eye[1]).toBeCloseTo(rt.renderPos.y + PASSENGER_EYE_HEIGHT, 5);
    expect(cam!.eye[2]).toBeCloseTo(rt.renderPos.z, 1);
    expect(cam!.look[0]).toBeCloseTo(cam!.eye[0] + PASSENGER_LOOK_AHEAD, 0);
    expect(cam!.look[2]).toBeCloseTo(cam!.eye[2], 1);
  });
});
