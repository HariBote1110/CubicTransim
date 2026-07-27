import { toKey } from '../utils';
import type { CellData, StationData, TrainData, TrainGroupData, TownData, TerrainType } from '../types';
import {
  buildServiceGraph,
  createRouteCache,
  routeBetween,
  destinationWeights,
  pickDestination,
  addWaiting,
  totalWaiting,
  boardFromStation,
} from './passengers';
import type { PassengerCohort, RouteCache, ServiceGraph } from './passengers';
import { growTown, townServiceLevel } from './towns';
import { calculateRouteWithStop } from './pathfinding';
import {
  pathPointAt, rampHeightAtPos,
  RAMP_POS_GROUND, RAMP_POS_LEVEL1, RAMP_POS_LEVEL2, RAMP_POS_DECK,
} from './trackPath';
import { effectiveSchedule, findGroup, departureKey, headwayHoldSeconds, stopsOnCurrentRun, recordInterval } from './groups';
import type { IntervalSamples } from './groups';
import { tryReserve, releaseCell, findSafeSegmentEnd, findDepartureSegmentEnd, reservationKey } from './reservation';
import {
  computeAcceleration, applyOverspeedDecay, TRAIN_SPECS, DEFAULT_TRAIN_TYPE,
  permittedSpeedKmh, rampDecel, brakingDistanceM, BRAKE_JERK_MS3,
} from './physics';
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
export const ACCEL_KMH_S = 15.0;
export const DECEL_KMH_S = 20.0;
// 減速カーブ計算で見通し距離から安全マージンとして差し引く距離(m)。
// 信号・予約末端で「手前に止まる」ために使う。駅の停止位置には適用しない
// (停止位置そのものを狙うのが正しく、マージンを引くと永遠に手前で漸近してしまう)。
export const BRAKING_MARGIN_M = 0.5;
// 停止点までの残距離がこの値以下になったら停車完了とみなす(m)。
// 減速カーブは理論上有限時間で0に収束するが、dtが粗い場合に停止直前で
// 極低速のまま刻み続けるのを防ぐスナップ。1セル=30mに対し十分小さい値にする。
export const ARRIVAL_SNAP_M = 0.05;
// 非常制動の減速度(km/h/s)。ジャーク制限つきの常用ブレーキが間に合わない場合
// (予約が急に短くなった等)にのみ効く安全網。
export const EMERGENCY_DECEL_KMH_S = 34.0;
// ブレーキ緩解のヒステリシス(km/h)。制動中に見通しがこの分だけ伸びて初めて緩解する。
export const BRAKE_RELEASE_MARGIN_KMH = 3.0;
// PBS予約を延長する判定の余裕(m)。予約末端で完全停止した状態からでも
// 必ず延長を再試行できるようにするための下駄。
export const RESERVE_EXTEND_SLACK_M = 1.0;

// layer省略(または0)は地平、1は立体交差の高架側。列車自体には層を持たせず、
// pathfindingが解決した層をルート/現在地セルにそのまま載せて運ぶ。
type Grid = { x: number; z: number; layer?: 0 | 1 };

// 坂(ramp)のlevelを、地平(0)〜桁(1)を1本のsmoothstep曲線として結ぶための
// 正規化位置(RAMP_POS_*)に写像する。level1が地平寄りの下段、level2が桁寄りの
// 上段。旧セーブ(levelが無いramp)は桁側に近いlevel2として扱う(移行処理は行わない)。
const rampPos = (level: 1 | 2 | undefined): number =>
  (level ?? 2) === 1 ? RAMP_POS_LEVEL1 : RAMP_POS_LEVEL2;

// セルの正規化ramp位置(RAMP_POS_GROUND〜RAMP_POS_DECK)を求める。
//   - 高架(layer===1): 桁として RAMP_POS_DECK
//   - 坂(railMap上のセルにrampが付いている): levelに応じたRAMP_POS_LEVEL1/2
//   - それ以外の地平: RAMP_POS_GROUND
// railMapを見るのは、坂かどうかがGrid(x,z,layer)だけでは分からず、セルデータ
// (CellData.ramp)に依存するため。
const cellRampPos = (railMap: Map<string, CellData>, x: number, z: number, layer?: 0 | 1): number => {
  if (layer === 1) return RAMP_POS_DECK;
  const cell = railMap.get(toKey(x, z));
  if (cell?.ramp) return rampPos(cell.ramp.level);
  return RAMP_POS_GROUND;
};

// セル中心の描画高さ(renderPos.y)を求める。地平の基準高さ0.5は既存の車両モデルの
// 原点合わせ。坂の上乗せぶんはrampHeightAtPos(=1本のsmoothstep曲線)で求めるので、
// 地平→level1→level2→桁のどの境界でも折れ角が生じない。
const cellCentreHeight = (railMap: Map<string, CellData>, x: number, z: number, layer?: 0 | 1): number =>
  0.5 + rampHeightAtPos(cellRampPos(railMap, x, z, layer));

// fromセル→toセルの区間をtで補間した描画高さ(tは0..1にクランプ)。
// 単に両端の高さを線形補間するのではなく、それぞれの正規化ramp位置(pos)を
// 線形補間してから同じrampHeightAtPos(smoothstep)に通す。こうすることで
// 地平→坂→桁の全区間が「1本の連続したsmoothstep曲線をposで辿る」ことになり、
// セル境界(level1/level2の切り替わり)でも折れ角のない縦曲線になる。
const interpCellHeight = (
  railMap: Map<string, CellData>,
  from: { x: number; z: number; layer?: 0 | 1 },
  to: { x: number; z: number; layer?: 0 | 1 },
  t: number
): number => {
  const posA = cellRampPos(railMap, from.x, from.z, from.layer);
  const posB = cellRampPos(railMap, to.x, to.z, to.layer);
  const ct = t < 0 ? 0 : t > 1 ? 1 : t;
  return 0.5 + rampHeightAtPos(posA + (posB - posA) * ct);
};

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
  // 経路末尾セルへの最終区間のうち、先頭車が実際に停止する位置(0<f<=1)。
  // 1 は「末尾セル中心で停車」(従来挙動)、0.5 は「末尾セル中心の半セル手前で停車」。
  // 端数停車中は progress が負値(= セル中心の手前)になる。
  // 旧セーブには存在しないため任意とし、読み出しは常に (rt.stopProgress ?? 1) で行う。
  stopProgress?: number;
  // 現在込めているブレーキの減速度(m/s²)。ジャーク(加加速度)制限のために保持する。
  // 旧セーブには存在しないため任意とし、読み出しは常に (rt.brakeDecelMs2 ?? 0) で行う。
  brakeDecelMs2?: number;
  // 制動中フラグ(ブレーキ指令のラッチ)。一度制動に入ったら、見通しが伸びて明確に
  // 余裕ができるまで解除しない。これがないと、停止直前でブレーキ指令のしきい値
  // (ジャーク余裕を織り込んだ包絡線)と実速度が交差し続け、込める/緩めるを毎tick
  // 繰り返して速度が脈動する。
  braking?: boolean;
  // 停車を終えて発車待ちの駅id。発車間隔(グループダイヤ)の判定はこの間だけ行い、
  // 実際に発車した時点でクリアする。線路上で経路待ちをしている状態と区別するために持つ。
  pendingDepartureFrom?: string | null;
  // 車内の旅客を行き先つきの塊で持つ。passengersはこの合計(質量計算と描画のために残している)。
  // 旧セーブには存在しないため任意とし、persistenceの移行処理で空配列を補う。
  load?: OnboardCohort[];
}

/** 車内の旅客の塊。alightAtで降りて、そこが目的地でなければ乗り換える。 */
export interface OnboardCohort {
  destinationId: string;
  /** この列車を降りる駅(目的地、または乗換駅)。 */
  alightAt: string;
  /** 運賃計算に使う乗車駅。 */
  boardedAt: string;
  count: number;
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
  // 駅停車位置設定(OpenTTD流のNear/Middle/Far)。ゲーム全体設定として持つ。
  // 旧セーブ(v7以前)には存在しないため任意とし、既定値は'middle'(既存の編成中央基準)。
  stopLocation?: 'near' | 'middle' | 'far';
  // 運用グループ(共有運行表と発車間隔)。旧セーブ(v8以前)には存在しないため任意。
  groups?: TrainGroupData[];
  // 「グループ×駅」ごとの最終発車時刻(clock.elapsed基準)。発車間隔の判定に使う。
  groupDepartures?: Map<string, number>;
  // 「路線×駅」ごとの実測の発車間隔。設定値どおりに走れているかの表示に使う(セーブ対象外)。
  groupIntervals?: IntervalSamples;
  // 駅ごとの待ち客(行き先つきの塊)。waitingはこの合計を写したもので、表示・セーブ用。
  demand?: Map<string, PassengerCohort[]>;
  // 旅客が移動できるサービス網と経路キャッシュ。運行表が変わるまで使い回す(セーブ対象外)。
  serviceGraph?: ServiceGraph;
  routeCache?: RouteCache;
  serviceSignature?: string;
}

/**
 * サービス網と経路キャッシュを最新に保つ。運行表・グループ・配備状況が変わったときだけ
 * 組み直し、経路キャッシュを捨てる(走らなくなった区間へ旅客を送り続けないため)。
 */
const ensureService = (world: SimWorld): { graph: ServiceGraph; cache: RouteCache } => {
  const groups = world.groups ?? [];
  const signature = [
    world.trains.map(t => `${t.id}:${t.status}:${t.groupId ?? ''}:${t.schedule.join('>')}`).join('|'),
    groups.map(g => `${g.id}:${g.schedule.join('>')}`).join('|'),
  ].join('#');

  if (world.serviceSignature !== signature || !world.serviceGraph || !world.routeCache) {
    world.serviceGraph = buildServiceGraph(world.trains, groups);
    world.routeCache = createRouteCache();
    world.serviceSignature = signature;
  }
  return { graph: world.serviceGraph, cache: world.routeCache };
};

/** 表示・セーブ用の待ち人数(world.waiting)を、行き先つきの待ち客から作り直す。 */
const syncWaiting = (world: SimWorld) => {
  world.waiting.clear();
  for (const [stationId, cohorts] of world.demand ?? []) {
    world.waiting.set(stationId, totalWaiting(cohorts));
  }
};

/** 駅の待ち行列(無ければ作る)。 */
const cohortsAt = (world: SimWorld, stationId: string): PassengerCohort[] => {
  if (!world.demand) world.demand = new Map();
  let cohorts = world.demand.get(stationId);
  if (!cohorts) {
    cohorts = [];
    world.demand.set(stationId, cohorts);
  }
  return cohorts;
};

export type SimEvent =
  | { type: 'arrive'; trainId: string; scheduleIndex: number }
  | { type: 'income'; trainId: string; amount: number; passengers: number }
  | { type: 'accident'; trainId: string; stationId: string; penalty: number }
  | { type: 'monthEnd'; year: number; month: number }
  // 月末の町の成長。React側は towns state をこの配列で置き換える。
  | { type: 'townGrowth'; towns: TownData[] };

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
      stopProgress: 1,
      brakeDecelMs2: 0,
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

/**
 * 停車中の列車が、そのホーム(駅を構成するセル全体)を予約する。
 *
 * 車体ぶんのセルしか予約しないと、ホームの残りのセルが空きとして見えてしまい、
 * 別の列車が同じホームに進入して並んでしまう。ホーム全体を押さえることで
 * 「1ホームに1編成」を保証する(他列車が既に持っているセルは奪わない)。
 */
const reservePlatform = (world: SimWorld, trainId: string, stationId: string): void => {
  const station = world.stations.get(stationId);
  if (!station || !world.reservations) return;
  for (const cell of station.cells) {
    const key = reservationKey(cell);
    const owner = world.reservations.get(key);
    if (!owner || owner === trainId) world.reservations.set(key, trainId);
  }
};

/**
 * 発車時に、ホームの予約のうち「もう要らないセル」を解放する。
 * 車体が乗っているセルとこれから走る経路上のセルは残す。
 */
const releasePlatformExcept = (
  world: SimWorld,
  trainId: string,
  stationId: string | null,
  keep: Set<string>
): void => {
  if (!stationId || !world.reservations) return;
  const station = world.stations.get(stationId);
  if (!station) return;
  for (const cell of station.cells) {
    const key = reservationKey(cell);
    if (world.reservations.get(key) !== trainId) continue;
    if (keep.has(key)) continue;
    world.reservations.delete(key);
  }
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
    // 車庫から出るときだけは、途中の安全点ではなく「次の信号まで、信号が無ければ
    // 目的駅のホームまで」を一括で予約できたときに限り出庫する。本線上に出てから
    // 駅の手前で立ち往生して後続を塞ぐのを防ぐ。
    const inDepot = world.railMap.get(toKey(rt.grid.x, rt.grid.z))?.type === 'depot';
    const idx = inDepot
      ? findDepartureSegmentEnd(world.railMap, rt.route)
      : findSafeSegmentEnd(world.railMap, rt.route, 0);
    if (tryReserve(world.reservations, train.id, rt.route.slice(0, idx + 1))) {
      rt.reservedEndIndex = idx;
    } else if (inDepot) {
      rt.debugStatus = 'Waiting for departure path...';
    }
    return;
  }

  if (rt.reservedEndIndex >= rt.route.length - 1) return; // 既に目的地(経路末尾)まで予約済み

  const remaining = distanceAlongRouteTo(rt, rt.reservedEndIndex);
  // 制動距離は速度制御と同じ式(ジャーク立ち上げぶんを含む)を使う。ここだけ
  // sqrt(2ad)前提の短い制動距離を使うと、速度制御が常にその外側を走るため
  // 「remaining > brakingDistance + マージン」が永久に成立し、予約末端の直前で
  // 停止したまま二度と延長できないデッドロックになる。
  // さらに、予約末端で完全停止した状態(制動距離0・残距離=マージン)でも必ず
  // 再試行できるよう RESERVE_EXTEND_SLACK_M の余裕を持たせる。
  const brakingDistance = brakingDistanceM(rt.speedKmh, DECEL_KMH_S / 3.6, BRAKE_JERK_MS3);
  if (remaining > brakingDistance + BRAKING_MARGIN_M + RESERVE_EXTEND_SLACK_M) return;

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

// route[idx]へ入る区間(route[idx-1]→route[idx]、idx=0なら rt.grid→route[0])の長さ(m)
const segmentLengthInto = (rt: TrainRuntime, idx: number): number => {
  const to = rt.route[idx];
  const from = idx === 0 ? rt.grid : rt.route[idx - 1];
  return Math.sqrt((to.x - from.x) ** 2 + (to.z - from.z) ** 2) * TILE_LENGTH;
};

// 現在位置から実際の停止点(経路末尾セルの手前 stopProgress の位置)までの距離(m)。
// stopProgress=1(セル中心停車)なら distanceAlongRouteTo(末尾) と一致する。
const distanceToStopPoint = (rt: TrainRuntime): number => {
  const last = rt.route.length - 1;
  const f = rt.stopProgress ?? 1;
  const base = distanceAlongRouteTo(rt, last);
  if (f >= 1) return base;
  return base - (1 - f) * segmentLengthInto(rt, last);
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
  events: SimEvent[],
  // 先頭車が実際に停止した位置(セル中心とは限らない)。省略時は arrivedGrid の中心。
  headPos: Grid = arrivedGrid
) => {
  const st = world.stations.get(targetStationId);

  const { graph, cache } = ensureService(world);
  const waitingCohorts = cohortsAt(world, targetStationId);
  const waitingCount = totalWaiting(waitingCohorts);
  if (!rt.load) rt.load = [];

  // 降車: この駅で降りる塊(目的地に着いた客と、ここで乗り換える客)を降ろす。
  // 目的地に着いた客からは乗車駅→降車駅の距離ぶんの運賃を得る。乗換客はその駅の
  // 待ち客に戻り、次の系統を待つ。
  const staying: OnboardCohort[] = [];
  let fare = 0;
  let arrivedPassengers = 0;
  for (const cohort of rt.load) {
    if (cohort.alightAt !== targetStationId) {
      staying.push(cohort);
      continue;
    }
    if (cohort.destinationId === targetStationId) {
      const boardedSt = world.stations.get(cohort.boardedAt);
      if (boardedSt && st) {
        const dist = Math.hypot(boardedSt.center.x - st.center.x, boardedSt.center.z - st.center.z);
        fare += dist * FARE_PER_TILE * cohort.count;
      }
      arrivedPassengers += cohort.count;
    } else {
      addWaiting(waitingCohorts, cohort.destinationId, cohort.count);
    }
  }
  rt.load = staying;
  if (arrivedPassengers > 0) {
    events.push({ type: 'income', trainId: train.id, amount: fare, passengers: arrivedPassengers });
  }

  // 乗車: 待ち客のうち「この列車の系統に乗るのが経路上正しい」客だけを、編成定員
  // (cars×CAPACITY_PER_CAR)の空きまで乗せる。待ち客は小数で蓄積されるため、乗車人数は
  // 整数に切り捨て、端数は駅に残す(passengersが常に整数であることを保証する)。
  const carCount = train.cars ?? 2;
  const trainCapacity = carCount * CAPACITY_PER_CAR;
  const lineId = train.groupId ?? train.id;
  const onboard = rt.load.reduce((sum, c) => sum + c.count, 0);

  const firstLegOf = (destinationId: string) => {
    const route = routeBetween(cache, graph, targetStationId, destinationId);
    if (!route || route.legs.length === 0) return null;
    return route.legs[0];
  };

  // この列車がこの先どの駅に停まるか(折返し運転なら折り返した先も含む)。
  // 目的地と逆向きに発車する列車に乗ってしまわないよう、乗車判定に使う。
  const line = findGroup(world.groups ?? [], train.groupId);
  const schedule = effectiveSchedule(train, world.groups ?? []);
  const ahead = new Set(
    stopsOnCurrentRun(
      schedule,
      { index: train.scheduleIndex, direction: train.scheduleDirection ?? 1 },
      line?.mode ?? 'loop'
    )
  );

  const boarded = boardFromStation(
    waitingCohorts,
    dest => {
      const leg = firstLegOf(dest);
      return leg?.lineId === lineId && ahead.has(leg.to);
    },
    trainCapacity - onboard
  );
  for (const cohort of boarded) {
    const leg = firstLegOf(cohort.destinationId);
    if (!leg) continue;
    rt.load.push({
      destinationId: cohort.destinationId,
      alightAt: leg.to,
      boardedAt: targetStationId,
      count: cohort.count,
    });
  }

  rt.passengers = rt.load.reduce((sum, c) => sum + c.count, 0);
  syncWaiting(world);
  rt.lastStopStationId = targetStationId;
  // ホーム全体を押さえ、停車中に別の列車が同じホームへ入ってこないようにする。
  reservePlatform(world, train.id, targetStationId);

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
  rt.brakeDecelMs2 = 0;
  rt.braking = false;
  rt.route = [];
  rt.reservedEndIndex = -1;
  rt.prevGrid = null;
  // 端数停車(headPosがセル中心でない)の場合も、描画位置は実際の停止点に置く。
  rt.renderPos = { x: headPos.x, y: 0.5, z: headPos.z };
  // renderTargetをリセットせず、進入方向の延長線上の点に維持する。
  // こうしないとDynamicTrain側のlookAtが働かず、停車の瞬間に列車の向きが初期値へ戻ってしまう。
  const enterVec = normalize(arrivedGrid.x - oldCurrent.x, arrivedGrid.z - oldCurrent.z);
  rt.renderTarget = { x: headPos.x + enterVec.x, y: 0.5, z: headPos.z + enterVec.z };
  rt.pendingDepartureFrom = targetStationId;
  rt.debugStatus = 'Arrived';
};

/**
 * 発車間隔を満たすまであと何秒待つ必要があるか(0なら発車可)。
 * 駅での停車を終えて発車待ちの間(pendingDepartureFrom が立っている間)だけ効く。
 * 線路上で経路や予約を待っている状態には適用しない。
 */
const departureHoldSeconds = (world: SimWorld, train: TrainData, rt: TrainRuntime): number => {
  const stationId = rt.pendingDepartureFrom;
  if (!stationId) return 0;
  const group = findGroup(world.groups ?? [], train.groupId);
  if (!group) return 0;
  const last = world.groupDepartures?.get(departureKey(group.id, stationId));
  return headwayHoldSeconds(group.headwaySeconds, last, world.clock?.elapsed ?? 0);
};

/** 発車したことをグループの発車時刻表へ記録し、発車待ち状態を解除する。 */
const recordDeparture = (world: SimWorld, train: TrainData, rt: TrainRuntime): void => {
  const stationId = rt.pendingDepartureFrom;
  rt.pendingDepartureFrom = null;
  if (!stationId) return;
  const group = findGroup(world.groups ?? [], train.groupId);
  if (!group) return;
  if (!world.groupDepartures) world.groupDepartures = new Map();
  if (!world.groupIntervals) world.groupIntervals = new Map();

  const now = world.clock?.elapsed ?? 0;
  const key = departureKey(group.id, stationId);
  // 設定した発車間隔どおりに走れているかを見るため、実測値も残す。
  recordInterval(world.groupIntervals, group.id, stationId, world.groupDepartures.get(key), now);
  world.groupDepartures.set(key, now);
};

const stepTrain = (world: SimWorld, train: TrainData, rt: TrainRuntime, dt: number, events: SimEvent[]) => {
  // グループに所属している列車はグループの運行表に従う(共有運行表)。
  const schedule = effectiveSchedule(train, world.groups ?? []);
  const targetStationId = schedule.length > 0 ? schedule[train.scheduleIndex % schedule.length] : null;

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

    // 発車間隔(グループダイヤ)の判定。同じグループの列車が同じ駅を発車してから
    // headway秒経つまでその場で待つ。これだけで団子運転がほどけて等間隔になる。
    const hold = departureHoldSeconds(world, train, rt);
    if (hold > 0) {
      rt.speedKmh = 0;
      rt.debugStatus = `Holding for headway (${hold.toFixed(0)}s)`;
      return;
    }

    const blocked = buildBlockedSet(world, train.id);
    const carCountForRoute = train.cars ?? 2;
    const stopLocation = world.stopLocation ?? 'middle';
    let routeResult = calculateRouteWithStop(world.railMap, world.stations, blocked, blocked, {
      start: rt.grid,
      prev: rt.prevGrid,
      targetStationId,
      cars: carCountForRoute,
      stopLocation,
    });
    let newPath = routeResult.path;

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

        routeResult = calculateRouteWithStop(world.railMap, world.stations, blocked, blocked, {
          start: rt.grid,
          prev: rt.prevGrid,
          targetStationId,
          cars: carCountForRoute,
          stopLocation,
        });
        newPath = routeResult.path;
      }

      rt.route = newPath;
      rt.stopProgress = routeResult.stopProgress;
      // 停車中に押さえていたホームの予約を、車体と新しい経路のぶんだけ残して解放する。
      releasePlatformExcept(
        world,
        train.id,
        rt.lastStopStationId,
        new Set([...rt.trail, ...newPath].map(reservationKey))
      );
      // 実際に発車したので、グループの「その駅の最終発車時刻」を更新する。
      recordDeparture(world, train, rt);
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
    if (rt.reservedEndIndex >= rt.route.length - 1) {
      obstacleType = 'station';
      // 駅は「停止点そのもの」を狙う。セル中心とは限らない(stopProgressの端数)。
      limitDistance = distanceToStopPoint(rt);
    } else {
      obstacleType = 'signal';
      limitDistance = distanceAlongRouteTo(rt, rt.reservedEndIndex);
    }
  }

  // 停止点まであとわずかなら、そこで停車を確定させる。減速カーブは理論上有限時間で
  // 0に収束するが、dtが粗いと停止直前で極低速のまま刻み続けてしまうため、
  // 1セル(30m)に対して十分小さい距離でスナップする。
  if (!immediateBlock && obstacleType === 'station' && limitDistance <= ARRIVAL_SNAP_M) {
    const stopP = rt.stopProgress ?? 1;
    const lastIdx = rt.route.length - 1;
    const finalTile = rt.route[lastIdx];
    const fromTile = lastIdx === 0 ? rt.grid : rt.route[lastIdx - 1];
    const headPos = {
      x: fromTile.x + (finalTile.x - fromTile.x) * stopP,
      z: fromTile.z + (finalTile.z - fromTile.z) * stopP,
    };
    const oldCurrent = rt.grid;
    rt.grid = finalTile;
    rt.prevGrid = fromTile;
    // 端数停車ではセル中心の手前で止まっているため progress は負値になる。
    // 発車時にこの値から動き出すことで、描画位置が跳ねずに滑らかに走り出す。
    rt.progress = stopP - 1;
    rt.route = [];
    rt.reservedEndIndex = -1;
    if (finalTile.x !== oldCurrent.x || finalTile.z !== oldCurrent.z) {
      pushArrivedGrid(world, rt, finalTile, train.cars ?? 2);
    }
    stopAtStation(world, train, rt, targetStationId, finalTile, fromTile, events, headPos);
    return;
  }

  // 3. 速度制御: 前方の停止点までの距離から「今の位置で安全に止まれる許容速度」を逆算する。
  //
  // 従来は sqrt(2ad) の包絡線に、OpenTTDのヒューリスティック(cur_speed − delta_v/10 と
  // 25×残りセル数の線形床)を重ねていたが、
  //   - 2つの制約が競合して減速が段付きになる
  //   - 線形床(v∝d)は時間軸では指数的漸近になり、停止直前のだらだらクロールを生む
  //   - それを潰すための最低速度床(15km/h→5km/h)のせいで最後に速度が0へ飛ぶ
  // という三重苦になっていた。ここでは制約を「ジャーク制限つきの制動曲線」1本に統一する。
  //
  //   - 包絡線 permittedSpeedKmh() は「まだ込めていない減速度をジャークで立ち上げる」
  //     ぶんの距離を織り込むため、ブレーキ開始が早まり当たりが柔らかくなる
  //   - 込め終わった時点で包絡線は sqrt(2ad) に一致し、有限時間で0へ収束する
  //     (=線形床のような無限クロールにならないので最低速度床が不要)
  //   - 実際の減速度も rampDecel() でジャーク制限し、階段状の減速をなくす
  const serviceDecelMs2 = DECEL_KMH_S / 3.6;
  // 駅の停止点は「そこに止まりたい位置」そのものなので手前マージンを引かない。
  // 信号・予約末端は手前で止まりたいのでマージンを引く。
  const margin = obstacleType === 'station' ? 0 : BRAKING_MARGIN_M;
  const usableDistance = Math.max(0, limitDistance - margin);

  // ブレーキ指令のしきい値。「今ブレーキを緩解している状態から、ジャークで常用最大まで
  // 立ち上げて停止する」のに必要な距離を織り込んだ包絡線。これを超えたら制動に入る。
  // 一度制動に入ると、実速度はこの包絡線より必ず上に留まる(既に込めているぶん有利なため)
  // ので、制動中に加速側へ戻って脈動することがない。
  const releaseEnvelopeKmh = Math.min(
    MAX_SPEED_KMH,
    permittedSpeedKmh(usableDistance, serviceDecelMs2, BRAKE_JERK_MS3, 0)
  );
  // ジャーク制限を無視した常用ブレーキの包絡線。絶対に超えてはならない上限で、
  // 終盤は sqrt(2ad) に従って有限時間で0へ収束する(=だらだらクロールしない)。
  const hardEnvelopeKmh = Math.sqrt(2 * serviceDecelMs2 * usableDistance) * 3.6;

  if (limitDistance >= 9999) {
    rt.debugStatus = `Accelerating (${Math.round(rt.speedKmh)} km/h)`;
  } else if (obstacleType === 'station') {
    rt.debugStatus = `Arriving... (${limitDistance.toFixed(1)}m)`;
  } else if (releaseEnvelopeKmh < 0.5) {
    rt.debugStatus = `Waiting Signal... (${limitDistance.toFixed(1)}m)`;
  } else {
    rt.debugStatus = `Braking... (${limitDistance.toFixed(1)}m)`;
  }

  // ブレーキ指令のラッチ。しきい値を超えたら制動に入り、見通しが伸びて明確な余裕
  // (BRAKE_RELEASE_MARGIN_KMH)ができるまで緩解しない。
  // これがないと、停止直前でしきい値と実速度が交差し続けて毎tick込める/緩めるを
  // 繰り返し、速度が脈動したうえ「v ∝ 残り距離」の線形則に引き込まれて
  // だらだらクロールになる(旧実装の最低速度床が必要だった原因)。
  if (rt.speedKmh > releaseEnvelopeKmh) {
    rt.braking = true;
  } else if (releaseEnvelopeKmh > rt.speedKmh + BRAKE_RELEASE_MARGIN_KMH) {
    rt.braking = false;
  }

  if (immediateBlock) {
    rt.speedKmh = 0;
    rt.brakeDecelMs2 = serviceDecelMs2;
    rt.braking = true;
  } else if (rt.speedKmh > MAX_SPEED_KMH) {
    // OpenTTD DoUpdateSpeed同様、最高速度超過時は瞬時にクランプせず現在速度の1/10ずつ
    // 緩やかに落とす(applyOverspeedDecay)。
    rt.speedKmh = applyOverspeedDecay(rt.speedKmh, Math.min(releaseEnvelopeKmh, MAX_SPEED_KMH), dt);
    rt.brakeDecelMs2 = 0;
  } else if (rt.braking) {
    // 制動中。「常に常用最大で込める」のではなく、停止点でちょうど0になるのに必要な
    // 減速度 aReq = v²/(2d) を目標にし、ジャーク制限つきで追従させる(サーボ制御)。
    //
    // 常用最大で込め切ってしまうと、必要以上に減速して停止点の手前で失速し、
    // そこから包絡線に沿って這い直す(=だらだらクロール)ことになる。
    // 必要ぶんだけ込めれば、ブレーキ開始から停止まで一定の当たりで滑らかに減速し、
    // 有限時間でちょうど停止点に着く。
    const speedMs = rt.speedKmh / 3.6;
    const requiredDecelMs2 = usableDistance > 1e-6
      ? (speedMs * speedMs) / (2 * usableDistance)
      : serviceDecelMs2;
    const desiredDecelMs2 = Math.min(serviceDecelMs2, requiredDecelMs2);
    rt.brakeDecelMs2 = rampDecel(rt.brakeDecelMs2 ?? 0, desiredDecelMs2, BRAKE_JERK_MS3, dt);
    let next = rt.speedKmh - rt.brakeDecelMs2 * 3.6 * dt;
    // 上限: ジャーク制限を無視した常用ブレーキの包絡線 sqrt(2ad)。
    // 予約が急に短くなった等でこれを上回った場合のみ非常制動で追いつく。
    // 終盤はこの包絡線が支配的になり、有限時間で0へ収束する。
    if (next > hardEnvelopeKmh) {
      next = Math.max(hardEnvelopeKmh, rt.speedKmh - EMERGENCY_DECEL_KMH_S * dt);
    }
    rt.speedKmh = Math.max(0, next);
  } else {
    // 制動不要。ブレーキを緩解して加速(または巡航)する。
    rt.brakeDecelMs2 = 0;
    if (rt.speedKmh < releaseEnvelopeKmh) {
      // OpenTTD Realisticモデル構造(F/m)を再実装したcomputeAccelerationで増速する。
      // 乗客数に応じて質量が増え、満載時ほど加速が鈍る。
      const accelMs2 = computeAcceleration(
        { spec: TRAIN_SPECS[DEFAULT_TRAIN_TYPE], cars: train.cars ?? 2, passengers: rt.passengers, speedKmh: rt.speedKmh },
        'accelerating',
        DECEL_KMH_S
      );
      rt.speedKmh = Math.min(releaseEnvelopeKmh, rt.speedKmh + accelMs2 * 3.6 * dt);
    }
  }

  // 4. 移動
  const moveSpeedTilesPerSec = rt.speedKmh / 3.6 / TILE_LENGTH;
  const geoDist = Math.sqrt((nextTile.x - rt.grid.x) ** 2 + (nextTile.z - rt.grid.z) ** 2) || 1;
  const progressDelta = (moveSpeedTilesPerSec / geoDist) * dt;
  const newProgress = rt.progress + progressDelta;

  // 最終区間だけは、セル中心(1.0)ではなく停止点(stopProgress)で到着とする。
  // これにより停止位置がセル中心に量子化されず、ホーム中央と編成中央が正確に合う。
  const isFinalSegment = rt.route.length === 1;
  const arriveAt = isFinalSegment ? (rt.stopProgress ?? 1) : 1.0;

  if (newProgress >= arriveAt) {
    const arrivedGrid = nextTile;
    const oldCurrent = rt.grid;
    const headPos = {
      x: oldCurrent.x + (arrivedGrid.x - oldCurrent.x) * arriveAt,
      z: oldCurrent.z + (arrivedGrid.z - oldCurrent.z) * arriveAt,
    };

    rt.grid = arrivedGrid;
    rt.prevGrid = oldCurrent;
    // 端数停車(arriveAt<1)ではセル中心の手前で止まっているため progress は負値になる。
    // 発車時にこの値から動き出すことで、描画位置が跳ねずに滑らかに走り出す。
    rt.progress = arriveAt - 1;
    rt.route = rt.route.slice(1);
    rt.reservedEndIndex -= 1;

    pushArrivedGrid(world, rt, arrivedGrid, train.cars ?? 2);

    // 駅到着判定: 経路は既にpathfinding側で編成中央基準の停止セル(ホーム外のこともある)
    // まで延長済みのため、経路を消化しきった(rt.route.length === 0)セルで停車する。
    const shouldStop = rt.route.length === 0;

    if (shouldStop) {
      stopAtStation(world, train, rt, targetStationId!, arrivedGrid, oldCurrent, events, headPos);
    } else {
      // 描画位置は線路の中心線(セル曲線)上に置く。カーブではセル中心を直線で
      // 結んだ位置とレールの実形状が最大0.125セル(≒3.7m)ずれるため。
      const head = pathPointAt(oldCurrent, arrivedGrid, rt.route[0] ?? null, rt.route[1] ?? null, 0);
      rt.renderPos = { x: head.x, y: cellCentreHeight(world.railMap, arrivedGrid.x, arrivedGrid.z, arrivedGrid.layer), z: head.z };
      // renderTargetを更新せずに放置すると、この1tickだけ renderPos と renderTarget が
      // 同じ点になり、描画側の lookAt が縮退して向きが飛ぶ。次のセルがあればそこを、
      // 無ければ進入方向の延長線上を向かせる。
      const following = rt.route[0];
      if (following) {
        rt.renderTarget = { x: following.x, y: 0.5, z: following.z };
      } else {
        const enterVec = normalize(arrivedGrid.x - oldCurrent.x, arrivedGrid.z - oldCurrent.z);
        rt.renderTarget = { x: arrivedGrid.x + enterVec.x, y: 0.5, z: arrivedGrid.z + enterVec.z };
      }
    }
  } else {
    rt.progress = newProgress;
    // セル中心間の線形補間ではなく、線路の中心線(セル曲線)上の点を描画位置にする。
    // 直線区間ではこの2つは厳密に一致するので、従来の挙動は変わらない。
    const head = pathPointAt(rt.prevGrid, rt.grid, nextTile, rt.route[1] ?? null, newProgress);
    rt.renderPos = { x: head.x, y: interpCellHeight(world.railMap, rt.grid, nextTile, newProgress), z: head.z };
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

    // 町の成長も月次で行う。列車が実際に停まる駅が近くにある町だけが育つ。
    if (world.towns && world.towns.length > 0) {
      const served = new Set(ensureService(world).graph.keys());
      world.towns = world.towns.map(town =>
        growTown(town, townServiceLevel(town, world.stations, served))
      );
      events.push({ type: 'townGrowth', towns: world.towns });
    }
  }

  // 旅客需要: 各駅の待ち人数を PASSENGER_SPAWN_RATE×demandFactor×dt ずつ増やす(上限STATION_WAITING_CAP)。
  // demandFactorは周辺の街の人口と距離から決まり、街から離れた駅にはほぼ客が来ない。
  //
  // 旅客は湧いた時点で行き先を持つ。行き先は「列車で行ける駅」の中から、
  // 行き先の集客力÷距離の重み(重力モデル)で抽選する。列車が走っていない駅、
  // 経路が繋がっていない駅は候補に入らないので、そこ行きの客は湧かない。
  const towns = world.towns ?? [];
  const { graph, cache } = ensureService(world);
  for (const station of world.stations.values()) {
    const cohorts = cohortsAt(world, station.id);
    const current = totalWaiting(cohorts);
    if (current >= STATION_WAITING_CAP) continue;

    const factor = demandFactor(station.center, towns);
    const spawn = PASSENGER_SPAWN_RATE * factor * dt;
    if (spawn <= 0) continue;

    const weights = destinationWeights(
      station.id,
      world.stations,
      towns,
      dest => routeBetween(cache, graph, station.id, dest) !== null
    );
    const destination = pickDestination(weights, world.rng);
    if (!destination) continue;

    addWaiting(cohorts, destination, Math.min(spawn, STATION_WAITING_CAP - current));
  }
  syncWaiting(world);

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
