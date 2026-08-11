import { describe, expect, it } from 'vitest';
import { toKey, getDirFromVector, getOppositeDir } from '../utils';
import type { CellData, StationData, TrainData } from '../types';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';

// 駅接近時の減速プロファイルが「滑らかに単調減速し、クロール時間が短く、
// 最後に速度が0へ飛ばない」ことを検証する回帰テスト群。
// v0.2.0-Alpha-3 で、OpenTTDのヒューリスティック(cur_speed − delta_v/10 と
// 25×残りセル数の線形床、およびそれを打ち消すための最低速度床)を廃し、
// ジャーク制限つきの制動曲線1本に統一した。

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

  it('5km/h以下の低速クロール時間は1秒以内(=無限に這い続けない)', () => {
    const dt = 1 / 60;
    const speeds = recordApproachProfile(15);

    const crawlTicks = speeds.filter(s => s > 0 && s <= 5).length;
    expect(crawlTicks * dt).toBeLessThanOrEqual(1.0);
  });

  it('10km/h未満の低速区間は合計1.5秒以内(=スッと入ってピタッと止まる)', () => {
    const dt = 1 / 60;
    const speeds = recordApproachProfile(15);

    // 線形床(v∝d)が終盤の支配的制約になると、時間軸では指数的漸近となり
    // 10km/h未満の区間が数秒〜十秒近くまで延びる(だらだらクロール)。
    const slowTicks = speeds.filter(s => s > 0 && s < 10).length;
    expect(slowTicks * dt).toBeLessThanOrEqual(1.5);
  });

  it('停車の瞬間まで速度が連続している(最低速度床による0への飛びがない)', () => {
    const speeds = recordApproachProfile(15);

    // 旧実装では MIN_CRAWL_SPEED_KMH=5km/h の床があったため、最後のtickで
    // 5km/h → 0 とカクッと落ちていた。ジャーク制限つきの制動曲線では
    // 停車直前の速度が十分小さくなっているはず。
    const lastMoving = [...speeds].reverse().find(s => s > 0) ?? 0;
    expect(lastMoving).toBeLessThan(3.0);
  });

  it('減速度(km/h/s)が階段状に跳ばず、ジャーク制限内で滑らかに立ち上がる', () => {
    const dt = 1 / 60;
    const speeds = recordApproachProfile(20);

    // ピーク速度に達したあと(=制動フェーズ)だけを見る。停車確定の最終tick
    // (速度0へのスナップ)は除く。加速→巡航の頭打ちは別の話なので対象外。
    let peakIdx = 0;
    for (let i = 1; i < speeds.length; i++) if (speeds[i] > speeds[peakIdx]) peakIdx = i;
    const moving = speeds.slice(peakIdx).filter(s => s > 0);

    const decels: number[] = [];
    for (let i = 1; i < moving.length; i++) {
      decels.push((moving[i - 1] - moving[i]) / dt);
    }

    // 減速度そのものの変化率(ジャーク)[km/h/s²]の上限。
    // BRAKE_JERK_MS3=6.0 m/s³ ≒ 21.6 km/h/s² に離散化ぶんの余裕を見た値。
    let maxJerk = 0;
    for (let i = 1; i < decels.length; i++) {
      maxJerk = Math.max(maxJerk, Math.abs(decels[i] - decels[i - 1]) / dt);
    }
    expect(maxJerk).toBeLessThanOrEqual(30);
  });
});
