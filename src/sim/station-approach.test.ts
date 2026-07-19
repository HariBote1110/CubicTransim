import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld, MIN_CRAWL_SPEED_KMH } from './simulation';
import type { SimWorld } from './simulation';

// 駅接近時の減速プロファイルが「滑らかに単調減速し、クロール時間が短い」ことを
// 検証する回帰テスト群。OpenTTD原式(train_cmd.cpp Train::GetCurrentMaxSpeed())の
// 「sqrtカーブがまだ十分減速していない場合にのみ st_max_speed = cur_speed - delta_v/10 で
// 上書きする」という条件付き介入を再現できているかを、実測プロファイルから確認する。

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

const buildStraightLine = (length: number, stationId: string, platformLen = 2) => {
  const cells = Array.from({ length }, (_, i) => ({ x: i, z: 0 }));
  const railMap = buildRailMap(cells);
  const lastKey = toKey(length - 1, 0);
  railMap.set(lastKey, { ...railMap.get(lastKey)!, type: 'station', stationId });
  const platformCells = Array.from({ length: platformLen }, (_, i) => ({ x: length - 1, z: i }));
  const stations = new Map<string, StationData>([
    [stationId, { id: stationId, name: 'A', cells: platformCells, center: { x: length - 1, z: 0 }, platformDoors: 'none' }],
  ]);
  return { railMap, stations };
};

// 駅到着まで dt=1/60 で刻み、tickごとの speedKmh 系列を記録する。
const recordApproachProfile = (lineLength: number): number[] => {
  const { railMap, stations } = buildStraightLine(lineLength, 'stA');
  const train: TrainData = { id: 't1', x: 0, z: 0, schedule: ['stA'], scheduleIndex: 0, status: 'running', cars: 2 };
  const world: SimWorld = { railMap, stations, trains: [train], runtimes: new Map(), waiting: new Map(), rng: () => 1, towns: [] };

  const dt = 1 / 60;
  const speeds: number[] = [];
  for (let i = 0; i < 5000; i++) {
    stepWorld(world, dt);
    const rt = world.runtimes.get('t1')!;
    speeds.push(rt.speedKmh);
    if (rt.stopRemaining > 0) break;
  }
  return speeds;
};

describe('駅接近時の減速プロファイル', () => {
  it('ピーク速度到達後、停止まで速度が増加に転じない(脈動なし・単調非増加)', () => {
    const speeds = recordApproachProfile(15);

    let peakIdx = 0;
    for (let i = 1; i < speeds.length; i++) {
      if (speeds[i] > speeds[peakIdx]) peakIdx = i;
    }

    for (let i = peakIdx + 1; i < speeds.length; i++) {
      expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1] + 1e-6);
    }
  });

  it('MIN_CRAWL_SPEED_KMH以下の低速クロール時間は妥当な範囲に収まる(=無限に這い続けない)', () => {
    const dt = 1 / 60;
    const speeds = recordApproachProfile(15);

    const crawlTicks = speeds.filter(s => s > 0 && s <= MIN_CRAWL_SPEED_KMH).length;
    const crawlSeconds = crawlTicks * dt;

    // MIN_CRAWL_SPEED_KMH(5km/h=約1.39m/s)は「到着判定を確実に発火させるための
    // 最低保証速度」。停止位置直前のごく短い区間に限られるべきで、1秒以内に収める。
    expect(crawlSeconds).toBeLessThanOrEqual(1.0);
  });

  it('10km/h未満の低速区間は合計1.5秒以内(=スッと入ってピタッと止まる)', () => {
    const dt = 1 / 60;
    const speeds = recordApproachProfile(15);

    // 「25×残りセル数」の線形床(v∝d)が終盤の支配的制約になると、時間軸では
    // 指数的漸近となり10km/h未満の区間が数秒〜十秒近くまで延びる(だらだらクロール)。
    // OpenTTD実機の停車感に合わせ、超低速区間は停止位置直前の短時間に限定する。
    const slowTicks = speeds.filter(s => s > 0 && s < 10).length;
    const slowSeconds = slowTicks * dt;

    expect(slowSeconds).toBeLessThanOrEqual(1.5);
  });
});
