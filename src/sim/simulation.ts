import { toKey, getVectorFromDir } from '../utils';
import type { CellData, StationData, TrainData, TownData, TerrainType } from '../types';
import { calculateRoute } from './pathfinding';
import {
  PASSENGER_SPAWN_RATE,
  STATION_WAITING_CAP,
  CAPACITY_PER_CAR,
  FARE_PER_TILE,
  ACCIDENT_HALT_DURATION,
  ACCIDENT_PENALTY,
  calculateAccidentChance,
  demandFactor,
  monthIndexOf,
  yearMonthOfIndex,
} from './economy';

export const STOP_DURATION = 3; // seconds (simulation time)
export const TILE_LENGTH = 30;
export const MAX_SPEED_KMH = 100.0;
export const MIN_CRAWL_SPEED_KMH = 5.0;
export const ACCEL_KMH_S = 15.0;
export const DECEL_KMH_S = 20.0;
// 減速カーブ計算で見通し距離から安全マージンとして差し引く距離(m)。
export const BRAKING_MARGIN_M = 0.5;

type Grid = { x: number; z: number };

export interface TrainRuntime {
  id: string;
  grid: Grid;
  prevGrid: Grid | null;
  progress: number;
  speedKmh: number;
  route: Grid[];
  trail: Grid[];
  // 描画用の走行履歴。占有判定に使う trail(cars長)とは別に、連結器の滑らか描画のため
  // trail より長め(cars+2程度)に保持する。先頭は常に trail[0](= rt.grid)と一致する。
  pathHistory: Grid[];
  stopRemaining: number;
  waitTimer: number;
  debugStatus: string;
  renderPos: { x: number; y: number; z: number };
  renderTarget: { x: number; y: number; z: number } | null;
  passengers: number;
  lastStopStationId: string | null;
  haltRemaining: number;
}

export interface SimWorld {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  trains: TrainData[];
  runtimes: Map<string, TrainRuntime>;
  waiting: Map<string, number>;
  rng: () => number;
  economyMirror?: { money: number };
  // 立地需要のもとになる街一覧。旧セーブ(v3以前)には存在しないため任意とする。
  towns?: TownData[];
  // 地形(水域・山岳)。デバッグ表示・描画同期用。旧セーブ(v4以前)には存在しないため任意とする。
  terrain?: Map<string, TerrainType>;
  // ゲーム内暦(シミュレーション累積秒)。旧セーブ(v5以前)には存在しないため任意とする。
  clock?: { elapsed: number };
}

export type SimEvent =
  | { type: 'arrive'; trainId: string; scheduleIndex: number }
  | { type: 'income'; trainId: string; amount: number; passengers: number }
  | { type: 'accident'; trainId: string; stationId: string; penalty: number }
  | { type: 'monthEnd'; year: number; month: number };

const normalize = (x: number, z: number) => {
  const len = Math.sqrt(x * x + z * z) || 1;
  return { x: x / len, z: z / len };
};

const dot = (a: Grid, b: Grid) => a.x * b.x + a.z * b.z;

// connectionsビットマスクの立っているビット数(接続方向の数)を数える。
const popcount = (n: number) => {
  let c = 0;
  let v = n;
  while (v) {
    c += v & 1;
    v >>= 1;
  }
  return c;
};

// 分岐点(connectionsが3方向以上)または信号セルを「区間の境界」とみなす。
// すれ違い設備では分岐点そのものは両列車が一時的に立ち寄る共有地点であり、
// そこに対向列車が留まっているだけで単線区間への進入を諦めるべきではないため、
// 信号コンフリクト判定の見通し距離はこの境界の手前までに限定する。
const isSectionBoundary = (cell: CellData | undefined) => {
  if (!cell) return false;
  if (cell.signalDir) return true;
  if (popcount(cell.connections ?? 0) >= 3) return true;
  return false;
};

const ensureRuntime = (world: SimWorld, train: TrainData): TrainRuntime => {
  let rt = world.runtimes.get(train.id);
  if (!rt) {
    rt = {
      id: train.id,
      grid: { x: train.x, z: train.z },
      prevGrid: null,
      progress: 0,
      speedKmh: 0,
      route: [],
      trail: [{ x: train.x, z: train.z }],
      pathHistory: [{ x: train.x, z: train.z }],
      stopRemaining: 0,
      waitTimer: 0,
      debugStatus: '',
      renderPos: { x: train.x, y: 0.5, z: train.z },
      renderTarget: null,
      passengers: 0,
      lastStopStationId: null,
      haltRemaining: 0,
    };
    world.runtimes.set(train.id, rt);
  }
  return rt;
};

// 経路探索用: 自分以外の列車の占有(trail)・予約(route)セルを集める
const buildRouteSets = (world: SimWorld, selfId: string) => {
  const occupied = new Set<string>();
  const reserved = new Set<string>();
  for (const t of world.trains) {
    if (t.id === selfId) continue;
    const otherRt = world.runtimes.get(t.id);
    if (otherRt) {
      otherRt.trail.forEach(c => occupied.add(toKey(c.x, c.z)));
      if (t.status === 'running') {
        otherRt.route.forEach(p => reserved.add(toKey(p.x, p.z)));
      }
    } else {
      occupied.add(toKey(t.x, t.z));
    }
  }
  return { occupied, reserved };
};

// 直前マスの物理的占有(緊急ブレーキ)判定
const findPhysicalBlocker = (world: SimWorld, selfId: string, nextTile: Grid): string | null => {
  for (const t of world.trains) {
    if (t.id === selfId) continue;
    const otherRt = world.runtimes.get(t.id);
    const cells = otherRt ? otherRt.trail : [{ x: t.x, z: t.z }];
    if (cells.some(c => Math.round(c.x) === nextTile.x && Math.round(c.z) === nextTile.z)) {
      return t.id;
    }
  }
  return null;
};

interface ObstacleResult {
  limitDistance: number;
  obstacleType: 'station' | 'signal' | 'none';
}

// 前方の障害物(駅・信号)までの距離を計算する
const computeObstacleDistance = (world: SimWorld, train: TrainData, rt: TrainRuntime): ObstacleResult => {
  const nextTile = rt.route[0];
  let distAccumulator = 0;
  const currentTileGeoDist = Math.sqrt((nextTile.x - rt.grid.x) ** 2 + (nextTile.z - rt.grid.z) ** 2);
  distAccumulator += (1.0 - rt.progress) * (currentTileGeoDist * TILE_LENGTH);

  let foundObstacle = false;
  let obstacleType: 'station' | 'signal' | 'none' = 'none';

  for (let i = 0; i < rt.route.length; i++) {
    const p = rt.route[i];

    if (i > 0) {
      const prevP = rt.route[i - 1];
      const dGeo = Math.sqrt((p.x - prevP.x) ** 2 + (p.z - prevP.z) ** 2);
      distAccumulator += dGeo * TILE_LENGTH;
    }

    const cell = world.railMap.get(toKey(p.x, p.z));

    // 駅 (停止目標)
    if (cell && cell.type === 'station') {
      foundObstacle = true;
      obstacleType = 'station';
      break;
    }

    // 信号 (赤なら停止目標)
    if (cell && cell.signalDir) {
      const prevGridForSignal = i === 0 ? rt.grid : rt.route[i - 1];
      const dx = p.x - prevGridForSignal.x;
      const dz = p.z - prevGridForSignal.z;
      if (dx !== 0 || dz !== 0) {
        const moveVec = normalize(dx, dz);
        const sv = getVectorFromDir(cell.signalDir);
        const signalVec = normalize(sv.x, sv.z);

        if (dot(moveVec, signalVec) > 0.1) {
          const lookAheadStart = i + 1;
          // 固定10マスではなく「次の分岐点または信号セルの手前まで」を見通し区間とする。
          // 分岐点セル自体は境界外(対向列車がそこに留まっていても衝突判定しない)。
          let lookAheadEnd = rt.route.length;
          for (let j = lookAheadStart; j < rt.route.length; j++) {
            const boundaryCell = world.railMap.get(toKey(rt.route[j].x, rt.route[j].z));
            if (isSectionBoundary(boundaryCell)) {
              lookAheadEnd = j;
              break;
            }
          }
          const blockSegment = rt.route.slice(lookAheadStart, lookAheadEnd);

          const conflict = world.trains.some(other => {
            if (other.id === train.id) return false;
            if (other.status !== 'running') return false;
            const otherRt = world.runtimes.get(other.id);
            if (!otherRt) return false;

            if (blockSegment.some(bp => otherRt.trail.some(oc => Math.round(oc.x) === bp.x && Math.round(oc.z) === bp.z))) return true;

            if (blockSegment.some(bp => otherRt.route.some(op => op.x === bp.x && op.z === bp.z))) {
              const myDir = moveVec;
              let otherDir = { x: 0, z: 0 };
              if (otherRt.route.length > 0) {
                const op = otherRt.route[0];
                otherDir = normalize(op.x - otherRt.grid.x, op.z - otherRt.grid.z);
              }
              if (dot(myDir, otherDir) > 0.5) return false;
              if (train.id < other.id) return false;
              return true;
            }
            return false;
          });

          if (conflict) {
            foundObstacle = true;
            obstacleType = 'signal';
          }
          if (foundObstacle) break;
        }
      }
    }
  }

  return { limitDistance: foundObstacle ? distAccumulator : 9999, obstacleType };
};

// trail(占有判定用、cars長)とpathHistory(描画用、cars+2長)を同時に更新する。
// pathHistory[0]は常にtrail[0](= arrivedGrid = rt.grid)と一致させる。
const pushArrivedGrid = (rt: TrainRuntime, arrivedGrid: Grid, carCount: number) => {
  rt.trail = [arrivedGrid, ...rt.trail];
  if (rt.trail.length > carCount) rt.trail.pop();

  rt.pathHistory = [arrivedGrid, ...rt.pathHistory];
  const historyCap = carCount + 2;
  if (rt.pathHistory.length > historyCap) rt.pathHistory.length = historyCap;
};

// 駅への到着処理(停車・乗降・事故判定・停車時間の決定)。
// 通常の1マス進行後の到着と、「経路探索した結果すでに目的駅上にいた」場合の即到着の
// 両方から呼ばれる。
const stopAtStation = (
  world: SimWorld,
  train: TrainData,
  rt: TrainRuntime,
  targetStationId: string,
  arrivedGrid: Grid,
  oldCurrent: Grid,
  events: SimEvent[]
) => {
  const st = world.stations.get(targetStationId);

  // 降車: 乗客がいれば直前駅からの距離×運賃で収入イベントを発行する
  if (rt.passengers > 0 && rt.lastStopStationId) {
    const prevSt = world.stations.get(rt.lastStopStationId);
    if (prevSt && st) {
      const dist = Math.sqrt((prevSt.center.x - st.center.x) ** 2 + (prevSt.center.z - st.center.z) ** 2);
      const amount = dist * FARE_PER_TILE * rt.passengers;
      events.push({ type: 'income', trainId: train.id, amount, passengers: rt.passengers });
    }
    rt.passengers = 0;
  }

  // 乗車: waitingから編成定員(cars×CAPACITY_PER_CAR)まで乗せる。waitingは小数で蓄積されるため、
  // 乗車人数は整数に切り捨て、端数は駅に残す(passengersが常に整数であることを保証する)。
  const carCount = train.cars ?? 2;
  const trainCapacity = carCount * CAPACITY_PER_CAR;
  const waitingCount = world.waiting.get(targetStationId) ?? 0;
  const boarding = Math.max(0, Math.min(Math.floor(waitingCount), trainCapacity - rt.passengers));
  rt.passengers += boarding;
  world.waiting.set(targetStationId, waitingCount - boarding);
  rt.lastStopStationId = targetStationId;

  // 人身事故判定: 停車の瞬間、ホーム混雑度とドア種別に応じた確率で発生する
  const doorType = st?.platformDoors ?? 'none';
  const accidentChance = calculateAccidentChance(doorType, waitingCount);
  if (world.rng() < accidentChance) {
    rt.haltRemaining = ACCIDENT_HALT_DURATION;
    events.push({ type: 'accident', trainId: train.id, stationId: targetStationId, penalty: ACCIDENT_PENALTY });
  }

  // ホーム長ペナルティ: 編成両数がホーム(停車したセルのstationId一致セル数)を超えると
  // 乗降に余分な時間がかかるものとして停車時間を延長する。
  const platformLen = st?.cells.length ?? 1;
  const stopMultiplier = carCount > platformLen ? 1 + 0.5 * (carCount - platformLen) : 1;
  rt.stopRemaining = STOP_DURATION * stopMultiplier;
  rt.speedKmh = 0;
  rt.route = [];
  rt.prevGrid = null;
  rt.renderPos = { x: arrivedGrid.x, y: 0.5, z: arrivedGrid.z };
  // renderTargetをリセットせず、進入方向の延長線上の点に維持する。
  // こうしないとDynamicTrain側のlookAtが働かず、停車の瞬間に列車の向きが初期値へ戻ってしまう。
  const enterVec = normalize(arrivedGrid.x - oldCurrent.x, arrivedGrid.z - oldCurrent.z);
  rt.renderTarget = { x: arrivedGrid.x + enterVec.x, y: 0.5, z: arrivedGrid.z + enterVec.z };
  rt.debugStatus = 'Arrived';
};

const stepTrain = (world: SimWorld, train: TrainData, rt: TrainRuntime, dt: number, events: SimEvent[]) => {
  const targetStationId = train.schedule.length > 0 ? train.schedule[train.scheduleIndex] : null;

  // 人身事故による運転見合わせ中: stopRemainingより優先して完全停止する
  if (rt.haltRemaining > 0) {
    rt.haltRemaining = Math.max(0, rt.haltRemaining - dt);
    rt.speedKmh = 0;
    rt.debugStatus = 'Service suspended (accident)';
    return;
  }

  // 駅停車中
  if (rt.stopRemaining > 0) {
    rt.stopRemaining = Math.max(0, rt.stopRemaining - dt);
    rt.speedKmh = 0;
    rt.debugStatus = 'Stopped at Station';
    if (rt.stopRemaining === 0) {
      events.push({ type: 'arrive', trainId: train.id, scheduleIndex: train.scheduleIndex });
    }
    return;
  }

  if (!targetStationId) {
    rt.speedKmh = Math.max(0, rt.speedKmh - DECEL_KMH_S * dt);
    rt.debugStatus = 'No Schedule';
    return;
  }

  // 経路が無ければ探索する
  if (rt.route.length === 0) {
    const { occupied, reserved } = buildRouteSets(world, train.id);
    const newPath = calculateRoute(world.railMap, world.stations, occupied, reserved, {
      start: rt.grid,
      prev: rt.prevGrid,
      targetStationId,
    });

    if (newPath.length > 0) {
      rt.route = newPath;
      rt.debugStatus = 'Route Found';
      rt.waitTimer = 0;
    } else {
      // 目的駅のセル上に既にいる場合(例: 車庫の隣駅が単独スケジュールでscheduleIndexが
      // ループして再び同じ駅を目指すケース)、経路探索は空を返す(BFSが開始セルで即座に
      // 目的駅ヒットと判定し空経路を返すため)。これを「経路なし=永久待機」として扱うと
      // 二度と発車できずWaitingし続けるバグになるため、既に目的駅にいるなら即到着扱いにする。
      const currentCell = world.railMap.get(toKey(rt.grid.x, rt.grid.z));
      if (currentCell && currentCell.stationId === targetStationId) {
        // scheduleIndexの更新はReact側で非同期のため、同一バッチ内で複数tick進むと
        // 「停車を終えたばかりの駅がまだ目的駅のまま」の状態でここに来ることがある。
        // その場合に再度stopAtStationを呼ぶと停車をリセットして無限に発車できなくなる
        // (回帰バグ)ため、直前に停車を終えた駅と同じなら再停車もarriveも発行せず、
        // scheduleIndexが進んで別の駅が目的地になるまで静かに待機する。
        if (rt.lastStopStationId === targetStationId) {
          rt.speedKmh = 0;
          rt.debugStatus = 'At destination';
          return;
        }
        stopAtStation(world, train, rt, targetStationId, rt.grid, rt.prevGrid ?? rt.grid, events);
        return;
      }
      rt.speedKmh = Math.max(0, rt.speedKmh - DECEL_KMH_S * dt);
      rt.debugStatus = 'Waiting for Path...';
      rt.waitTimer += dt;
      return;
    }
  }

  const nextTile = rt.route[0];
  let immediateBlock = false;
  let limitDistance = 9999;
  let obstacleType: 'station' | 'signal' | 'none' = 'none';

  // 1. 直前マスの物理的占有 (緊急ブレーキ)
  const physicalBlocker = findPhysicalBlocker(world, train.id, nextTile);
  if (physicalBlocker) {
    immediateBlock = true;
    rt.debugStatus = `Blocked by Train ${physicalBlocker}`;
  } else {
    // 2. 前方の障害物までの距離計算
    const obstacle = computeObstacleDistance(world, train, rt);
    limitDistance = obstacle.limitDistance;
    obstacleType = obstacle.obstacleType;
  }

  // 3. 速度制御: 前方の障害物までの距離から「今の位置で安全に止まれる許容速度」を逆算する方式。
  // permittedSpeed = sqrt(2×減速度(m/s²)×max(0, 見通し距離−マージン)) をkm/hに変換する。
  // 駅のみ最低速度(MIN_CRAWL_SPEED_KMH)を保証し、到着判定(newProgress>=1.0)を確実に発火させる。
  // 信号・他列車待ちは許容速度が0まで落ち切ってよい。
  let targetSpeed = MAX_SPEED_KMH;

  if (immediateBlock) {
    targetSpeed = 0;
    rt.speedKmh = 0;
  } else {
    const decelMs2 = DECEL_KMH_S / 3.6;
    const permittedMs = Math.sqrt(2 * decelMs2 * Math.max(0, limitDistance - BRAKING_MARGIN_M));
    const permittedKmh = permittedMs * 3.6;
    targetSpeed = Math.min(MAX_SPEED_KMH, permittedKmh);

    if (limitDistance >= 9999) {
      rt.debugStatus = `Accelerating (${Math.round(rt.speedKmh)} km/h)`;
    } else if (obstacleType === 'station') {
      targetSpeed = Math.max(targetSpeed, MIN_CRAWL_SPEED_KMH);
      rt.debugStatus = `Arriving... (${limitDistance.toFixed(1)}m)`;
    } else if (targetSpeed < 0.5) {
      targetSpeed = 0;
      rt.debugStatus = `Waiting Signal... (${limitDistance.toFixed(1)}m)`;
    } else {
      rt.debugStatus = `Braking... (${limitDistance.toFixed(1)}m)`;
    }
  }

  if (rt.speedKmh < targetSpeed) {
    rt.speedKmh = Math.min(targetSpeed, rt.speedKmh + ACCEL_KMH_S * dt);
  } else {
    rt.speedKmh = Math.max(targetSpeed, rt.speedKmh - DECEL_KMH_S * dt);
  }

  // 4. 移動
  const moveSpeedTilesPerSec = rt.speedKmh / 3.6 / TILE_LENGTH;
  const geoDist = Math.sqrt((nextTile.x - rt.grid.x) ** 2 + (nextTile.z - rt.grid.z) ** 2) || 1;
  const progressDelta = (moveSpeedTilesPerSec / geoDist) * dt;
  const newProgress = rt.progress + progressDelta;

  if (newProgress >= 1.0) {
    const arrivedGrid = nextTile;
    const oldCurrent = rt.grid;

    rt.grid = arrivedGrid;
    rt.prevGrid = oldCurrent;
    rt.progress = 0;
    rt.route = rt.route.slice(1);

    pushArrivedGrid(rt, arrivedGrid, train.cars ?? 2);

    // 駅到着判定
    let shouldStop = false;
    const cell = world.railMap.get(toKey(arrivedGrid.x, arrivedGrid.z));
    if (cell && cell.stationId === targetStationId) {
      const st = world.stations.get(targetStationId);
      if (st) {
        const distToCenter = Math.sqrt((arrivedGrid.x - st.center.x) ** 2 + (arrivedGrid.z - st.center.z) ** 2);
        let keepGoing = false;
        if (rt.route.length > 0) {
          const nextCell = world.railMap.get(toKey(rt.route[0].x, rt.route[0].z));
          if (nextCell && nextCell.stationId === targetStationId) {
            const nextDist = Math.sqrt((rt.route[0].x - st.center.x) ** 2 + (rt.route[0].z - st.center.z) ** 2);
            // 駅の中心に近づくなら進む
            if (nextDist < distToCenter - 0.5) keepGoing = true;
          }
        }
        if (!keepGoing) shouldStop = true;
      }
    }

    if (shouldStop) {
      stopAtStation(world, train, rt, targetStationId!, arrivedGrid, oldCurrent, events);
    } else {
      rt.renderPos = { x: arrivedGrid.x, y: 0.5, z: arrivedGrid.z };
    }
  } else {
    rt.progress = newProgress;
    rt.renderPos = {
      x: rt.grid.x + (nextTile.x - rt.grid.x) * newProgress,
      y: 0.5,
      z: rt.grid.z + (nextTile.z - rt.grid.z) * newProgress,
    };
    rt.renderTarget = { x: nextTile.x, y: 0.5, z: nextTile.z };
  }
};

export function stepWorld(world: SimWorld, dt: number): SimEvent[] {
  const events: SimEvent[] = [];

  // ゲーム内暦を進め、月が変わったtickでmonthEndイベントを発行する(dtが大きく複数月
  // 跨いだ場合は月数分発行する)。
  if (!world.clock) world.clock = { elapsed: 0 };
  const prevMonthIndex = monthIndexOf(world.clock.elapsed);
  world.clock.elapsed += dt;
  const newMonthIndex = monthIndexOf(world.clock.elapsed);
  for (let m = prevMonthIndex; m < newMonthIndex; m++) {
    const { year, month } = yearMonthOfIndex(m);
    events.push({ type: 'monthEnd', year, month });
  }

  // 旅客需要: 各駅の待ち人数を PASSENGER_SPAWN_RATE×demandFactor×dt ずつ増やす(上限STATION_WAITING_CAP)。
  // demandFactorは周辺の街の人口と距離から決まり、街から離れた駅にはほぼ客が来ない。
  const towns = world.towns ?? [];
  for (const station of world.stations.values()) {
    const current = world.waiting.get(station.id) ?? 0;
    const factor = demandFactor(station.center, towns);
    world.waiting.set(station.id, Math.min(STATION_WAITING_CAP, current + PASSENGER_SPAWN_RATE * factor * dt));
  }

  for (const train of world.trains) {
    if (train.status !== 'running') {
      const rt = world.runtimes.get(train.id);
      if (rt) {
        rt.speedKmh = 0;
        rt.debugStatus = 'Stored';
      }
      continue;
    }

    const rt = ensureRuntime(world, train);
    stepTrain(world, train, rt, dt, events);
  }

  return events;
}
