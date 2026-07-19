import { toKey } from '../utils';
import type { CellData, StationData, TrainData, TownData, TerrainType } from '../types';
import { calculateRoute } from './pathfinding';
import { tryReserve, releaseCell, findSafeSegmentEnd, reservationKey } from './reservation';
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
  // route[0..reservedEndIndex]がPBS予約済みの区間(safe waiting pointまで)。
  // -1は「まだ何も予約できていない(次の安全点を待っている)」を意味する。
  reservedEndIndex: number;
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
  // PBS風のセル予約テーブル(セルキー→列車ID)。セーブデータには含めない。
  // ロード直後は空のため、stepWorld/ensureRuntimeが各列車のtrailから遅延再構築する。
  reservations?: Map<string, string>;
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

const ensureRuntime = (world: SimWorld, train: TrainData): TrainRuntime => {
  if (!world.reservations) world.reservations = new Map();
  let rt = world.runtimes.get(train.id);
  if (!rt) {
    rt = {
      id: train.id,
      grid: { x: train.x, z: train.z },
      prevGrid: null,
      progress: 0,
      speedKmh: 0,
      route: [],
      reservedEndIndex: -1,
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
  // 予約テーブルへの遅延再構築: セーブロード直後や、まだ他列車の予約と衝突していない
  // trailセルは、この列車の物理占有として予約テーブルへ補完しておく(自列車の予約=
  // 物理占有+前方経路、という設計のため)。
  for (const c of rt.trail) {
    const k = reservationKey(c);
    if (!world.reservations.has(k)) world.reservations.set(k, train.id);
  }
  return rt;
};

// 経路探索用: 自分以外の列車が予約している(物理占有+前方経路)セル集合を集める。
// 予約テーブルが「占有」と「予約」を統合した単一の情報源になったため、
// 以前のtrail(占有)/route(予約)を別々に集めるロジックは不要になった。
const buildBlockedSet = (world: SimWorld, selfId: string): Set<string> => {
  const blocked = new Set<string>();
  if (!world.reservations) return blocked;
  for (const [key, owner] of world.reservations) {
    if (owner !== selfId) blocked.add(key);
  }
  return blocked;
};

// PBS予約の取得・延長。route[0..reservedEndIndex]が予約済み区間になる。
// - reservedEndIndexが-1(未取得)なら、次のsafe waiting pointまでの区間取得を試みる
// - 取得済みで、予約末端までの残り距離が制動距離+マージン以内に近づいたら、
//   さらに次のsafe waiting pointまでの延長を試みる(失敗時は現状維持=末端で待機)
const ensureReservation = (world: SimWorld, train: TrainData, rt: TrainRuntime) => {
  if (rt.route.length === 0) return;
  if (!world.reservations) world.reservations = new Map();

  if (rt.reservedEndIndex < 0) {
    const idx = findSafeSegmentEnd(world.railMap, rt.route, 0);
    if (tryReserve(world.reservations, train.id, rt.route.slice(0, idx + 1))) {
      rt.reservedEndIndex = idx;
    }
    return;
  }

  if (rt.reservedEndIndex >= rt.route.length - 1) return; // 既に目的地(経路末尾)まで予約済み

  const remaining = distanceAlongRouteTo(rt, rt.reservedEndIndex);
  const decelMs2 = DECEL_KMH_S / 3.6;
  const brakingDistance = (rt.speedKmh / 3.6) ** 2 / (2 * decelMs2);
  if (remaining > brakingDistance + BRAKING_MARGIN_M) return;

  const nextIdx = findSafeSegmentEnd(world.railMap, rt.route, rt.reservedEndIndex + 1);
  const segment = rt.route.slice(rt.reservedEndIndex + 1, nextIdx + 1);
  if (tryReserve(world.reservations, train.id, segment)) {
    rt.reservedEndIndex = nextIdx;
  }
};

// 現在位置(rt.grid + progress)からroute[idx]までの弧長距離(m)
const distanceAlongRouteTo = (rt: TrainRuntime, idx: number): number => {
  const route = rt.route;
  const first = route[0];
  const currentTileGeoDist = Math.sqrt((first.x - rt.grid.x) ** 2 + (first.z - rt.grid.z) ** 2);
  let dist = (1.0 - rt.progress) * (currentTileGeoDist * TILE_LENGTH);
  for (let i = 1; i <= idx; i++) {
    const p = route[i];
    const prevP = route[i - 1];
    const dGeo = Math.sqrt((p.x - prevP.x) ** 2 + (p.z - prevP.z) ** 2);
    dist += dGeo * TILE_LENGTH;
  }
  return dist;
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

// trail(占有判定用、cars長)とpathHistory(描画用、cars+2長)を同時に更新する。
// pathHistory[0]は常にtrail[0](= arrivedGrid = rt.grid)と一致させる。
// trailから抜け落ちた(後端の)セルは、この列車の物理占有ではなくなるため
// 予約テーブルからも即時解放する(他列車が直後にそのセルを予約できるようにするため)。
const pushArrivedGrid = (world: SimWorld, rt: TrainRuntime, arrivedGrid: Grid, carCount: number) => {
  rt.trail = [arrivedGrid, ...rt.trail];
  if (rt.trail.length > carCount) {
    const dropped = rt.trail.pop();
    if (dropped && world.reservations) releaseCell(world.reservations, dropped);
  }

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
  rt.reservedEndIndex = -1;
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
    // 直前に停車を終えた駅がそのまま次の目的駅でもある場合(単独駅スケジュールのループ、
    // scheduleIndexがReact側の非同期更新でまだ進んでいない場合など)、経路探索を行わず
    // 静かに待機する。停止セルは編成中央基準で延長され、ホーム外(prevGridがnullで
    // 方向制約が外れた状態)のこともあるため、ここで経路探索してしまうとBFSが逆方向の
    // 短絡路(直前に通過したホームへ逆走する経路)を見つけてしまい、無用な瞬時反転を
    // 繰り返す回帰につながる。そのため経路探索より前にこの判定を行う。
    if (rt.lastStopStationId === targetStationId) {
      rt.speedKmh = 0;
      rt.debugStatus = 'At destination';
      return;
    }

    const blocked = buildBlockedSet(world, train.id);
    const carCountForRoute = train.cars ?? 2;
    let newPath = calculateRoute(world.railMap, world.stations, blocked, blocked, {
      start: rt.grid,
      prev: rt.prevGrid,
      targetStationId,
      cars: carCountForRoute,
    });

    if (newPath.length > 0) {
      // 折り返し判定: 発車方向が「自編成の2両目へめり込む方向」、または到着時の進行方向と
      // 逆(内積<0)であれば、終端駅での折り返しとみなす。
      const firstStep = newPath[0];
      const mergesIntoSelf = rt.trail.length > 1 && firstStep.x === rt.trail[1].x && firstStep.z === rt.trail[1].z;
      const arrivalVec = rt.prevGrid ? normalize(rt.grid.x - rt.prevGrid.x, rt.grid.z - rt.prevGrid.z) : null;
      const departVec = normalize(firstStep.x - rt.grid.x, firstStep.z - rt.grid.z);
      const isReversal = mergesIntoSelf || (arrivalVec !== null && dot(arrivalVec, departVec) < 0);

      if (isReversal && rt.trail.length > 0) {
        // 編成ごと瞬時に反転する: 新先頭セル=旧最後尾セル。trail/pathHistoryを反転した向きに
        // 組み直す(pathHistoryは旧向きの延長分(carCount超過分)をそのまま反転すると
        // 新先頭の手前に逆走の折り返し点ができてしまう=carPositionsの弧長サンプリングが
        // 破綻するため、trail反転分を最後尾セルの複製で埋め直す)。
        const carCount = train.cars ?? 2;
        const reversedTrail = [...rt.trail].reverse();
        rt.trail = reversedTrail;
        const historyCap = carCount + 2;
        const reversedHistory = [...reversedTrail];
        while (reversedHistory.length < historyCap) {
          reversedHistory.push(reversedHistory[reversedHistory.length - 1]);
        }
        rt.pathHistory = reversedHistory;

        const newHead = reversedTrail[0];
        rt.grid = newHead;
        rt.prevGrid = reversedTrail.length > 1 ? reversedTrail[1] : null;
        rt.progress = 0;
        rt.renderPos = { x: newHead.x, y: 0.5, z: newHead.z };
        rt.renderTarget = null;

        newPath = calculateRoute(world.railMap, world.stations, blocked, blocked, {
          start: rt.grid,
          prev: rt.prevGrid,
          targetStationId,
          cars: carCountForRoute,
        });
      }

      rt.route = newPath;
      // 予約はここでは取得しない(=まだ何も予約できていない状態)。この直後の
      // ensureReservation呼び出しで、次のsafe waiting pointまでの区間を実際に取得する。
      rt.reservedEndIndex = -1;
      rt.debugStatus = 'Route Found';
      rt.waitTimer = 0;
    } else {
      // 目的駅に既にいる場合(例: 車庫の隣駅が単独スケジュールでscheduleIndexがループして
      // 再び同じ駅を目指すケース)、経路探索は空を返す(BFSが開始セルで即座に目的駅ヒットと
      // 判定し空経路を返すため)。これを「経路なし=永久待機」として扱うと二度と発車できず
      // Waitingし続けるバグになるため、既に目的駅にいるなら即到着扱いにする。
      // (直前に停車を終えた駅と目的駅が同じケースは、この分岐に来る前に既に
      // 'At destination'として処理済みのため、ここに来るのは「まだ一度も停車していない
      // (lastStopStationIdがnullまたは別駅)のに、たまたま目的駅セル上にいる」場合のみ)
      const currentCell = world.railMap.get(toKey(rt.grid.x, rt.grid.z));
      if (currentCell && currentCell.stationId === targetStationId) {
        stopAtStation(world, train, rt, targetStationId, rt.grid, rt.prevGrid ?? rt.grid, events);
        return;
      }
      rt.speedKmh = Math.max(0, rt.speedKmh - DECEL_KMH_S * dt);
      rt.debugStatus = 'Waiting for Path...';
      rt.waitTimer += dt;
      return;
    }
  }

  // PBS予約の取得・延長を試みる(取得済み区間の末端が制動距離+マージン以内に
  // 近づいたら、次のsafe waiting pointまでの延長を試みる)。
  ensureReservation(world, train, rt);

  if (rt.reservedEndIndex < 0) {
    // 次のsafe waiting pointまでの区間がまだ1つも予約できていない
    // (他列車がそこを予約中)。その場で待機し、毎tick再試行する。
    rt.speedKmh = Math.max(0, rt.speedKmh - DECEL_KMH_S * dt);
    rt.debugStatus = 'Waiting for reservation...';
    return;
  }

  const nextTile = rt.route[0];
  let immediateBlock = false;
  let limitDistance = 9999;
  let obstacleType: 'station' | 'signal' | 'none' = 'none';

  // 1. 直前マスの物理的占有 (緊急ブレーキ。予約が正しく機能していれば通常は発生しないが、
  // 念のための安全網として残す)
  const physicalBlocker = findPhysicalBlocker(world, train.id, nextTile);
  if (physicalBlocker) {
    immediateBlock = true;
    rt.debugStatus = `Blocked by Train ${physicalBlocker}`;
  } else {
    // 2. 減速目標はPBS予約の末端に一本化する(駅停止位置も信号待ちも「予約がそこまで
    // しか無い」の一形態として統一。予約末端が経路の最後尾=目的駅なら'station'、
    // 途中のsafe waiting pointなら'signal'として扱う)。
    limitDistance = distanceAlongRouteTo(rt, rt.reservedEndIndex);
    obstacleType = rt.reservedEndIndex >= rt.route.length - 1 ? 'station' : 'signal';
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
    rt.reservedEndIndex -= 1;

    pushArrivedGrid(world, rt, arrivedGrid, train.cars ?? 2);

    // 駅到着判定: 経路は既にpathfinding側で編成中央基準の停止セル(ホーム外のこともある)
    // まで延長済みのため、経路を消化しきった(rt.route.length === 0)セルで停車する。
    const shouldStop = rt.route.length === 0;

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

  // 予約テーブルへのbootstrap(自列車の物理占有セルの予約登録)は、経路の予約取得より
  // 必ず先に全列車分終わらせる。同一tick内でrunning中の列車を先に処理してしまうと、
  // まだ自身のtrailセルを予約登録していない停車中の列車の位置を、先に動く列車が
  // 「誰も予約していないセル」と誤認して横取りしてしまうため(2パスに分離して回避)。
  for (const train of world.trains) {
    if (train.status !== 'running') continue;
    ensureRuntime(world, train);
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
