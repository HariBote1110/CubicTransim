import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import { carPositions } from './consist';

// 走行中の車両の向きが、セル境界や斜め↔直線の変わり目で飛ばないことを検証する。
//
// 旧実装の問題は2つあった:
//  1. 到着tickで renderPos と renderTarget が同じセル中心になり、描画側の lookAt が
//     縮退して1フレームだけワールド+Z方向を向いていた
//  2. heading をポリラインの「そのセグメントの向き」から取っていたため、折れ点を
//     跨いだ瞬間に階段状に飛んでいた(斜め45°ぶん)

const buildRailMap = (cells: { x: number; z: number }[]) => {
  const map = new Map<string, CellData>();
  for (let i = 0; i < cells.length - 1; i++) {
    const curr = cells[i];
    const next = cells[i + 1];
    const dir = getDirFromVector(next.x - curr.x, next.z - curr.z);
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

// 直線 → 斜め → 直線 と折れ曲がる経路。斜めと直線の変わり目が2回ある。
const buildDoglegLine = () => {
  const cells: { x: number; z: number }[] = [];
  for (let x = 0; x <= 4; x++) cells.push({ x, z: 0 });          // 東へ直線
  for (let i = 1; i <= 4; i++) cells.push({ x: 4 + i, z: i });   // 南東へ斜め
  for (let x = 9; x <= 14; x++) cells.push({ x, z: 4 });          // 東へ直線

  const railMap = buildRailMap(cells);
  const last = cells[cells.length - 1];
  const lastKey = toKey(last.x, last.z);
  railMap.set(lastKey, { ...railMap.get(lastKey)!, type: 'station', stationId: 'stA' });
  const stations = new Map<string, StationData>([
    ['stA', { id: 'stA', name: 'A駅', cells: [last], center: last, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

/** 走行中の全車両の heading(度)を毎tick記録する。 */
const recordHeadings = (cars: number): number[][] => {
  const { railMap, stations } = buildDoglegLine();
  const train: TrainData = { id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running', cars };
  const world: SimWorld = {
    railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [],
  };

  const frames: number[][] = [];
  for (let i = 0; i < 5000; i++) {
    stepWorld(world, 1 / 60);
    const rt = world.runtimes.get('t1')!;
    if (rt.speedKmh <= 0) continue; // 発車前・停車後は対象外
    frames.push(
      carPositions(rt, cars, 1.0).map(p => (Math.atan2(p.heading.x, p.heading.z) * 180) / Math.PI)
    );
    if (rt.stopRemaining > 0) break;
  }
  return frames;
};

/** 角度差を -180..180 に畳む。 */
const angleDelta = (a: number, b: number): number => {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
};

describe('走行中の車両の向き', () => {
  it('4両編成の全車両で、1tickあたりの向きの変化が連続的(飛びがない)', () => {
    const frames = recordHeadings(4);
    expect(frames.length).toBeGreaterThan(200);

    let worst = 0;
    for (let i = 1; i < frames.length; i++) {
      for (let k = 0; k < frames[i].length; k++) {
        worst = Math.max(worst, angleDelta(frames[i][k], frames[i - 1][k]));
      }
    }

    // 旧実装ではセル境界で45°の段差が1tickで出ていた。
    // 前後台車から向きを求め、かつ走行線を線路の中心線(セル曲線)に載せたことで、
    // 45°の転回はカーブ全体(約1セル)に分散され、最高速100km/hでも1°/tick未満になる。
    expect(worst).toBeLessThan(1.5);
  });

  it('1両編成でも向きが飛ばない(先頭車の前台車クランプで不連続にならない)', () => {
    const frames = recordHeadings(1);
    let worst = 0;
    for (let i = 1; i < frames.length; i++) {
      worst = Math.max(worst, angleDelta(frames[i][0], frames[i - 1][0]));
    }
    expect(worst).toBeLessThan(1.5);
  });

  it('直線区間では向きがその区間の方位と一致する', () => {
    const frames = recordHeadings(2);
    // 最初の数tickは発車直後の直線(東向き = atan2(1,0) = 90°)
    expect(angleDelta(frames[5][0], 90)).toBeLessThan(1.0);
  });
});
