import { toKey } from '../utils';
import type { CellData, StationData, TrainData, TrainGroupData, TownData, Level, TrainProtection } from '../types';
import type { TerrainField } from './terrainField';
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
import { growTown, townServiceLevel, resolveTownSpawnTick } from './towns';
import type { StationTransportInfo } from './towns';
import { calculateRouteWithStop, stationIdAtLayer } from './pathfinding';
import { DEFAULT_GAME_RULES, isDeadSectionBoundary, type GameRules } from './gameRules';
import { OVERLOAD_ACCEL_FACTOR, isOverloaded, type FeedingIndex } from './feeding';
import {
  pathPointAt, pathHeightAt, rampHeightAtPos, OVERPASS_HEIGHT,
  RAMP_POS_LEVEL1, RAMP_POS_LEVEL2,
} from './trackPath';
import { groundRailCentreHeight } from './slopes';
import { effectiveSchedule, findGroup, departureKey, headwayHoldSeconds, stopsOnCurrentRun, recordInterval } from './groups';
import type { IntervalSamples } from './groups';
import { tryReserve, releaseCell, findSafeSegmentEnd, findDepartureSegmentEnd, reservationKey } from './reservation';
import { blocksOccupiedByOthers, type BlockIndex } from './blocks';
import {
  computeAcceleration, applyOverspeedDecay, TRAIN_SPECS, DEFAULT_TRAIN_TYPE,
  permittedSpeedKmh, rampDecel, brakingDistanceM, BRAKE_JERK_MS3, railWeightSpeedCapKmh,
} from './physics';
import {
  PASSENGER_SPAWN_RATE,
  STATION_WAITING_CAP,
  CAPACITY_PER_CAR,
  FARE_PER_TILE,
  ACCIDENT_HALT_DURATION,
  ACCIDENT_PENALTY,
  STALL_RECOVERY_SECONDS,
  STALL_RESCUE_COST,
  calculateAccidentChance,
  demandFactor,
  monthIndexOf,
  yearMonthOfIndex,
  dayIndexOf,
  SPAD_CHANCE,
  weakerProtection,
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

// 軌道(何キロレール): レール速度上限への接近距離から差し引く安全マージン(m)。
// 停止点向けのBRAKING_MARGIN_Mより大きく取る。停止(target=0)と違い速度上限への
// 接近は「その場で止まれば帳尻が合う」余地が無く、1tickぶんの移動(speed×dt)が
// 制動曲線の計算を追い越して境界を跨いだ直後にわずかに上限を超える離散化誤差が
// 生じやすいため、その分の先読み余裕をあらかじめ距離から差し引いておく。
export const RAIL_CAP_APPROACH_MARGIN_M = 5;
// 停止点までの残距離がこの値以下になったら停車完了とみなす(m)。
// 減速カーブは理論上有限時間で0に収束するが、dtが粗い場合に停止直前で
// 極低速のまま刻み続けるのを防ぐスナップ。1セル=30mに対し十分小さい値にする。
export const ARRIVAL_SNAP_M = 0.05;
// デッドセクション失速判定のしきい値(km/h)。惰行(coasting)で速度がこれを下回ったら
// 「事実上停止」とみなし失速状態へ入る(完全な0を待つとdtの粗さで揺れるため近傍値)。
export const STALL_SPEED_THRESHOLD_KMH = 0.5;
// 非常制動の減速度(km/h/s)。ジャーク制限つきの常用ブレーキが間に合わない場合
// (予約が急に短くなった等)にのみ効く安全網。
export const EMERGENCY_DECEL_KMH_S = 34.0;
// ブレーキ緩解のヒステリシス(km/h)。制動中に見通しがこの分だけ伸びて初めて緩解する。
export const BRAKE_RELEASE_MARGIN_KMH = 3.0;
// PBS予約を延長する判定の余裕(m)。予約末端で完全停止した状態からでも
// 必ず延長を再試行できるようにするための下駄。
export const RESERVE_EXTEND_SLACK_M = 1.0;

// layer省略(または0)は地平、1〜3は立体交差の高架側(レベル)。列車自体には層を
// 持たせず、pathfindingが解決した層をルート/現在地セルにそのまま載せて運ぶ。
type Grid = { x: number; z: number; layer?: 0 | Level };

// 坂(ramp)のlevelを、base〜base+1を1本のsmoothstep曲線として結ぶための
// 正規化位置(RAMP_POS_*)に写像する。level1がbase寄りの下段、level2がbase+1寄りの
// 上段。旧セーブ(levelが無いramp)は上段に近いlevel2として扱う(移行処理は行わない)。
const rampPos = (level: 1 | 2 | undefined): number =>
  (level ?? 2) === 1 ? RAMP_POS_LEVEL1 : RAMP_POS_LEVEL2;

// セルの正規化ramp高さ(地平からの上乗せ分、rampHeightAtPos基準)を求める。
//   - 高架(layer>0): そのレベルの桁として layer*OVERPASS_HEIGHT
//   - 坂(railMap上のセルにrampが付いている): base + levelに応じた正規化位置
//   - それ以外の地平: 地形の標高ぶん(P7c、groundRailCentreHeight。terrainField省略時は
//     従来通り0=旧セーブ・テスト用フィクスチャとの後方互換)
// railMapを見るのは、坂かどうかがGrid(x,z,layer)だけでは分からず、セルデータ
// (CellData.ramp)に依存するため。
const cellRampHeight = (
  railMap: Map<string, CellData>,
  x: number,
  z: number,
  layer?: 0 | Level,
  terrainField?: TerrainField
): number => {
  if (layer && layer > 0) return layer * OVERPASS_HEIGHT;
  const cell = railMap.get(toKey(x, z));
  // P8a: 地下(layer<0)は地表からの相対深さ(design doc「相対深さ方式」)。
  // 地表の高さ(groundRailCentreHeight)にlayer*OVERPASS_HEIGHT(負)を上乗せする。
  // ramp(掘割)セルはbase(常に負)が付いているため、この分岐より先にramp判定を
  // 通さない(rampはbase自体が地表からの相対段数として一貫している)。
  if (layer && layer < 0 && !cell?.ramp) {
    const surface = terrainField ? groundRailCentreHeight(terrainField, cell, x, z) : 0;
    return surface + layer * OVERPASS_HEIGHT;
  }
  if (cell?.ramp) {
    const rampOffset = rampHeightAtPos(rampPos(cell.ramp.level), cell.ramp.base ?? 0);
    // P8a: 掘割ランプ(base<0)は地表からの相対深さで解釈する。rampOffsetは既に
    // (base+pos)*OVERPASS_HEIGHTであり、地平(0)側の端でちょうど0になる設計なので、
    // ここへ地表標高を足すだけで「その掘割が乗る地表」からの相対高さになる。
    if ((cell.ramp.base ?? 0) < 0) {
      const surface = terrainField ? groundRailCentreHeight(terrainField, cell, x, z) : 0;
      return surface + rampOffset;
    }
    return rampOffset;
  }
  if (!terrainField) return 0;
  return groundRailCentreHeight(terrainField, cell, x, z);
};

// セル中心の描画高さ(renderPos.y)を求める。地平の基準高さ0.5は既存の車両モデルの
// 原点合わせ。坂の上乗せぶんはrampHeightAtPos(=1本のsmoothstep曲線)で求めるので、
// base→level1→level2→base+1のどの境界でも折れ角が生じない。地形標高(P7c)は
// groundRailCentreHeightから上乗せする。
const cellCentreHeight = (
  railMap: Map<string, CellData>,
  x: number,
  z: number,
  layer?: 0 | Level,
  terrainField?: TerrainField
): number =>
  0.5 + cellRampHeight(railMap, x, z, layer, terrainField);

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
  // PM3フォローアップ: デッドセクションで失速している秒数の累積。失速中でない間は0/undefined。
  // セーブ対象外の走行状態(TrainRuntime全体がセーブに含まれないため他フィールドと同様)。
  stalledSeconds?: number;
  // 失速から救援されたあと、先頭がデッドセクションを完全に抜けるまで牽引力を持たせる
  // (「全力で抜けきるまで」のフラグ)。区間を抜けるとstepTrainがfalseへ戻す。
  stallRecovered?: boolean;
  // S3(保安装置)のSPAD(信号冒進)判定ラッチ。閉塞境界での待機に入った信号セルの
  // キー(toKey)を記録し、同じ信号への「進入待ち」の間は再判定しない(1approachにつき
  // 1回)。待機が解消(予約成功)したらundefinedへ戻し、次に別の信号で待ったときに
  // また判定できるようにする。セーブ対象外(他の走行状態フィールドと同様)。
  spadCheckedFor?: string;
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
  // 地形field(sim/terrainField.tsのcreateTerrainField + sim/terrainOverlay.tsの
  // createEditedTerrainFieldで合成した純関数field)。デバッグ表示・描画同期用。
  terrainField?: TerrainField;
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
  /**
   * PM2: プレイモードのルールフラグ集合。旧セーブ・デバッグシナリオには存在しないため
   * 任意とし、未設定時はDEFAULT_GAME_RULES(ライト相当=軌間・電化の概念なし)として扱う
   * (stepWorldの参照箇所は必ず`world.rules ?? DEFAULT_GAME_RULES`で読む)。
   */
  rules?: GameRules;
  /**
   * PM4: き電インフラの索引(sim/feeding.tsのbuildFeedingIndex)。useGameLogic.tsが
   * railMap変化時にのみ再計算して鏡写しする(rulesと同じ同期パターン)。セーブ対象外
   * (railMapから毎回導出できるため)。rules.electrification!=='feeding'のときは
   * 誰も参照しない(挙動変更ゼロ)。
   */
  feeding?: FeedingIndex;
  /**
   * PM4フォローアップ: 直近tickの、き電区間ごとの在線数(電車のみ)。stepWorldが
   * 容量超過ペナルティ判定のために1パス目で数えたものをそのまま鏡写しする(セーブ対象外、
   * デバッグ・オーバーレイ描画用の副産物)。rules.electrification!=='feeding'なら常に
   * undefined。
   */
  feedingSectionCounts?: Map<string, number>;
  /**
   * S1(固定閉塞、progress/signalling-plan.md)のブロック索引(sim/blocks.tsの
   * buildBlockIndex)。useGameLogic.tsがrailMap変化時にのみ再計算して鏡写しする
   * (feedingIndexと同じ同期パターン)。セーブ対象外。rules.signalling!=='s1'のときは
   * 誰も参照しない(挙動変更ゼロ)。
   */
  blocks?: BlockIndex;
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
  // kind='spad'はS3の信号冒進(progress/signalling-plan.md)。省略時(=undefined)は
  // 従来どおりの駅の人身事故。stationIdはspadでは駅ではなく信号の位置ラベルを入れる
  // (AccidentNotice表示のフォールバック=stations.get(id)が無ければそのまま文字列表示)。
  | { type: 'accident'; trainId: string; stationId: string; penalty: number; kind?: 'spad' }
  // PM3フォローアップ: デッドセクション失速からの救援(1回だけ課金)。
  | { type: 'stallRescue'; trainId: string; penalty: number }
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

// このセグメントの先頭(route[startIdx]、= 直前のsafe waiting pointの次のセル)が信号
// セルであれば、そのsignalKindを返す。isSafeWaitingPointの規則上、区切られたセグメントは
// 必ず「信号セルそのもの」から始まるか、信号を経由しない安全点(駅・車庫・行き止まり)から
// 始まるかのどちらかなので、これがそのセグメントへ「くぐって入る」信号になる。
// 信号が無ければundefined(=閉塞信号扱いに準ずる)。s0/s1配下では呼び出し側が種別を
// 見ないため未使用。
const entrySignalKindFor = (
  world: SimWorld,
  rt: TrainRuntime,
  startIdx: number
): CellData['signalKind'] | undefined => {
  const point = rt.route[startIdx];
  if (!point) return undefined;
  const cell = world.railMap.get(toKey(point.x, point.z));
  if (!cell?.signalDir) return undefined;
  return cell.signalKind ?? 'block';
};

// S3のCBTC移動閉塞(Effect B)判定用: segmentの全セルが保安装置'cbtc'を敷設済みか。
// 1セルでも欠ければfalse(=固定閉塞の判定へフォールバック)。
const segmentAllCbtc = (world: SimWorld, segment: Grid[]): boolean =>
  segment.every(p => world.railMap.get(toKey(p.x, p.z))?.protection === 'cbtc');

// PBS予約の取得・延長。route[0..reservedEndIndex]が予約済み区間になる。
// - reservedEndIndexが-1(未取得)なら、次のsafe waiting pointまでの区間取得を試みる
// - 取得済みで、予約末端までの残り距離が制動距離+マージン以内に近づいたら、
//   さらに次のsafe waiting pointまでの延長を試みる(失敗時は現状維持=末端で待機)
// S1(固定閉塞)のとき、segmentが他列車の占有する未占有でないブロックへ踏み込むなら
// trueを返す(=このセグメントは予約してはいけない)。rules.signalling!=='s1'/'s2'/'s3'、または
// ブロック索引が無ければ常にfalse(=S0と同じ、制約なし)。
// H3(progress/review-play-modes-branch.md): entryKind==='home'のときブロック全体占有を
// 無条件でバイパスすると、単線区間の両端に場内信号を置いただけで対向列車が中央でセルを
// 取り合う恒久デッドロックになる(signalling-plan.mdの意図は駅構内の複数ホームへの
// 同時進入=互いに重ならないトラックを使う場合の許可であり、単線の対向を許すものではない)。
// 「自分がこのブロック内で実際に通る経路(route上、ブロックを出るまでの全セル)」が
// 他列車の保有セルと重ならない場合に限って許可する。二面ホームなど互いに交わらない
// トラックを使うケースは常に成立し(既存挙動を維持)、単線の対向は経路が必ず重なるため
// 先着した列車がブロックを空けるまで後発が入口で待つ(=S1相当の排他)。
const cellsThroughBlock = (world: SimWorld, route: Grid[], startIdx: number): Grid[] => {
  if (!world.blocks) return [];
  const cells: Grid[] = [];
  let blockKey: string | undefined;
  for (let i = startIdx; i < route.length; i++) {
    const p = route[i];
    const bk = world.blocks.blockKeyOf(p.x, p.z, p.layer ?? 0);
    if (bk === undefined) {
      // 信号セル(どのブロックにも属さない)。まだブロックへ入っていなければ
      // くぐって入る信号そのものなのでスキップして先を見る。既にブロック内に
      // 入ったあとなら、次の境界に達したということなのでそこで打ち切る。
      if (blockKey !== undefined) break;
      continue;
    }
    if (blockKey === undefined) blockKey = bk;
    else if (bk !== blockKey) break;
    cells.push(p);
  }
  return cells;
};

const pathOverlapsOthers = (
  reservations: Map<string, string> | undefined,
  path: Grid[],
  trainId: string
): boolean => {
  if (!reservations) return false;
  for (const c of path) {
    const owner = reservations.get(reservationKey(c));
    if (owner && owner !== trainId) return true;
  }
  return false;
};

// S2(信号の種別)ではS1と同じブロック全体判定を使うが、entryKind==='home'(場内信号を
// くぐって入る)のときだけ、上記pathOverlapsOthersによる「自分の全経路 vs 他列車の保有セル」
// の判定に差し替える。
// S3(保安装置)はS2の判定をそのまま含んだ上で(「S3はS2挙動を包含する」設計どおり)、
// Effect B(CBTC移動閉塞)を追加する: segmentの全セルとtrainProtectionがともに'cbtc'なら
// ブロック全体判定を丸ごとバイパスしてfalse(=S0と同じ、セル単位の排他のみ)を返す。
const blocksSegmentEntry = (
  world: SimWorld,
  rules: GameRules,
  trainId: string,
  segment: Grid[],
  entryKind?: CellData['signalKind'],
  trainProtection?: TrainProtection,
  route?: Grid[],
  routeStartIdx?: number
): boolean => {
  if (!world.blocks) return false;
  if (rules.signalling === 's1') {
    return blocksOccupiedByOthers(world.reservations, world.blocks, segment, trainId);
  }
  if (rules.signalling === 's2' || rules.signalling === 's3') {
    if (rules.signalling === 's3' && trainProtection === 'cbtc' && segmentAllCbtc(world, segment)) return false;
    if (entryKind === 'home') {
      const path = route && routeStartIdx !== undefined
        ? cellsThroughBlock(world, route, routeStartIdx)
        : segment;
      return pathOverlapsOthers(world.reservations, path, trainId);
    }
    return blocksOccupiedByOthers(world.reservations, world.blocks, segment, trainId);
  }
  return false;
};

// PBS予約の取得・延長。route[0..reservedEndIndex]が予約済み区間になる。
// - reservedEndIndexが-1(未取得)なら、次のsafe waiting pointまでの区間取得を試みる
// - 取得済みで、予約末端までの残り距離が制動距離+マージン以内に近づいたら、
//   さらに次のsafe waiting pointまでの延長を試みる(失敗時は現状維持=末端で待機)
// S1(固定閉塞)では、セグメントが跨ぐブロックが他列車に占有されている場合、
// tryReserve自体は成功しうる(セル単位の排他はS0と同じ)としても、ここで先に弾いて
// 予約を取らせない。これにより「信号(=ブロック境界)の手前で待つ」挙動になる。
// S3: 停止信号への進入待ちに入った瞬間(=このtickで初めてblocksSegmentEntryがtrueに
// なった信号)にだけ、SPAD(信号冒進)を1回判定する。rt.spadCheckedForで同じ信号への
// 待機中の再判定を防ぐ(1approachにつき1回のラッチ)。有効な保安装置は地上(track)と
// 車上(train)の弱い方(weakerProtection)。信号セルが無い(entryKindがundefined、
// =閉塞境界ではあるが信号を経由しない安全点由来)場合は判定しない。
const evaluateSpadOnce = (
  world: SimWorld,
  rules: GameRules,
  train: TrainData,
  rt: TrainRuntime,
  signalGrid: Grid | undefined,
  entryKind: CellData['signalKind'] | undefined,
  events: SimEvent[]
): void => {
  if (rules.signalling !== 's3') return;
  if (!signalGrid || entryKind === undefined) return;
  const signalKey = toKey(signalGrid.x, signalGrid.z);
  if (rt.spadCheckedFor === signalKey) return; // 同じ信号への待機中はこのapproachで判定済み
  rt.spadCheckedFor = signalKey;

  const trackProtection = world.railMap.get(signalKey)?.protection;
  const effective = weakerProtection(trackProtection, train.protection);
  const chance = SPAD_CHANCE[effective];
  if (world.rng() < chance) {
    rt.haltRemaining = ACCIDENT_HALT_DURATION;
    events.push({
      type: 'accident',
      trainId: train.id,
      stationId: `信号 (${signalGrid.x}, ${signalGrid.z})`,
      penalty: ACCIDENT_PENALTY,
      kind: 'spad',
    });
  }
};

const ensureReservation = (
  world: SimWorld,
  train: TrainData,
  rt: TrainRuntime,
  rules: GameRules,
  events: SimEvent[]
) => {
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
    const segment = rt.route.slice(0, idx + 1);
    const entryKind = entrySignalKindFor(world, rt, 0);
    if (blocksSegmentEntry(world, rules, train.id, segment, entryKind, train.protection, rt.route, 0)) {
      rt.debugStatus = 'Waiting for block to clear...';
      evaluateSpadOnce(world, rules, train, rt, rt.route[0], entryKind, events);
      return;
    }
    rt.spadCheckedFor = undefined;
    if (tryReserve(world.reservations, train.id, segment)) {
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
  const entryKind = entrySignalKindFor(world, rt, rt.reservedEndIndex + 1);
  if (blocksSegmentEntry(world, rules, train.id, segment, entryKind, train.protection, rt.route, rt.reservedEndIndex + 1)) {
    evaluateSpadOnce(world, rules, train, rt, rt.route[rt.reservedEndIndex + 1], entryKind, events);
    return; // ブロックが空くまで現在の末端で待機
  }
  rt.spadCheckedFor = undefined;
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

// M4: distanceAlongRouteTo(rt, i)をrt.route全域についてループで呼ぶと、1回の呼び出しが
// O(i)なのでO(n²)になる(呼び出し元が3箇所あり合計O(3n²))。累積距離を1回のO(n)走査で
// 前計算し、result[i] === distanceAlongRouteTo(rt, i) と一致する配列を返す。
// 軌道(何キロレール)の速度上限判定3箇所(railApproachCapKmh・hardEnvelopeループ・
// requiredDecelループ)がこれを共有する。
const cumulativeRouteDistances = (rt: TrainRuntime): number[] => {
  const route = rt.route;
  const result: number[] = new Array(route.length);
  if (route.length === 0) return result;
  const first = route[0];
  const currentTileGeoDist = Math.sqrt((first.x - rt.grid.x) ** 2 + (first.z - rt.grid.z) ** 2);
  let dist = (1.0 - rt.progress) * (currentTileGeoDist * TILE_LENGTH);
  result[0] = dist;
  for (let i = 1; i < route.length; i++) {
    const p = route[i];
    const prevP = route[i - 1];
    const dGeo = Math.sqrt((p.x - prevP.x) ** 2 + (p.z - prevP.z) ** 2);
    dist += dGeo * TILE_LENGTH;
    result[i] = dist;
  }
  return result;
};

// 軌道(何キロレール): 現在地から前方に見えている最も厳しいレール速度上限へ、
// 今の位置からブレーキを掛け始めて間に合う速度(km/h)。既存の停止点向け制動曲線
// (permittedSpeedKmh/brakingDistanceM)をそのまま使い回す。目標速度が0でない点だけが
// 通常の停止制御と異なるため、「距離d先で目標速度targetに減速し終える」を
// 「(brakingDistanceM(target)を先取りした)距離 d + brakingDistanceM(target) 先で
// 停止し終える」問題に還元して同じ式を適用する(brakingDistanceMはpermittedSpeedKmhの
// 逆関数なので、この変換で数式が完全に整合する)。
// rules.trackClasses=falseなら概念が無いため常にInfinity(呼び出し側でMAX_SPEED_KMHとminされる)。
const railApproachCapKmh = (
  world: SimWorld,
  rt: TrainRuntime,
  rules: GameRules,
  decelMs2: number,
  jerkMs3: number,
  routeDistances: number[]
): number => {
  if (!rules.trackClasses) return Infinity;
  const currentCell = world.railMap.get(toKey(rt.grid.x, rt.grid.z));
  let cap = railWeightSpeedCapKmh(currentCell?.railWeight);
  for (let i = 0; i < rt.route.length; i++) {
    const cell = world.railMap.get(toKey(rt.route[i].x, rt.route[i].z));
    const cellCap = railWeightSpeedCapKmh(cell?.railWeight);
    if (!isFinite(cellCap)) continue;
    const dist = Math.max(0, routeDistances[i] - RAIL_CAP_APPROACH_MARGIN_M);
    const approach = permittedSpeedKmh(
      dist + brakingDistanceM(cellCap, decelMs2, jerkMs3),
      decelMs2,
      jerkMs3,
      0
    );
    cap = Math.min(cap, approach);
  }
  return cap;
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
  // 高架ホーム(arrivedGrid.layer===1)に停車中も、走行中と同じ高さ計算
  // (cellCentreHeight)を使う。ここを0.5固定にすると、高架駅で停車した瞬間だけ
  // 列車が地平の高さへ沈んで見える不具合になる。
  rt.renderPos = {
    x: headPos.x,
    y: cellCentreHeight(world.railMap, arrivedGrid.x, arrivedGrid.z, arrivedGrid.layer, world.terrainField),
    z: headPos.z,
  };
  // renderTargetをリセットせず、進入方向の延長線上の点に維持する。
  // こうしないとDynamicTrain側のlookAtが働かず、停車の瞬間に列車の向きが初期値へ戻ってしまう。
  const enterVec = normalize(arrivedGrid.x - oldCurrent.x, arrivedGrid.z - oldCurrent.z);
  rt.renderTarget = { x: headPos.x + enterVec.x, y: rt.renderPos.y, z: headPos.z + enterVec.z };
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

const stepTrain = (
  world: SimWorld,
  train: TrainData,
  rt: TrainRuntime,
  dt: number,
  events: SimEvent[],
  // PM4: き電区間ごとの在線数(電車のみ、tick開始時点でstepWorldが数えたもの)。
  // rules.electrification!=='feeding'なら常にundefined。
  feedingSectionCounts?: Map<string, number>
) => {
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
    // PM2: rules省略時(旧セーブ・デバッグシナリオ)はDEFAULT_GAME_RULES(ライト相当)に
    // 短絡するため、軌間・電化の概念が無いワールドでは挙動が一切変わらない。
    const rules = world.rules ?? DEFAULT_GAME_RULES;
    let routeResult = calculateRouteWithStop(world.railMap, world.stations, blocked, blocked, {
      start: rt.grid,
      prev: rt.prevGrid,
      targetStationId,
      cars: carCountForRoute,
      stopLocation,
      rules,
      trainGauge: train.gauge ?? 1067,
      trainPower: train.power ?? 'diesel',
      trainAxleLoadT: train.axleLoadT,
      feeding: world.feeding,
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
          rules,
          trainGauge: train.gauge ?? 1067,
          trainPower: train.power ?? 'diesel',
          trainAxleLoadT: train.axleLoadT,
          feeding: world.feeding,
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
      const currentLayer = rt.grid.layer ?? 0;
      if (stationIdAtLayer(currentCell, currentLayer) === targetStationId) {
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
  // PM2: rules省略時(旧セーブ・デバッグシナリオ)はDEFAULT_GAME_RULES(ライト相当)に短絡する。
  const rules = world.rules ?? DEFAULT_GAME_RULES;
  ensureReservation(world, train, rt, rules, events);

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

  // 軌道(何キロレール): 前方(現在セル含む)のレール速度上限へ、今の位置から間に合う
  // ための許容速度(km/h)。停止点への制動(target速度0)と同じ制動曲線を、target速度が
  // cap(≠0)である問題に一般化して適用する(railApproachCapKmhのdocコメント参照)。
  // rules.trackClasses=falseなら常にInfinity(無条件で無関係)。
  // M4: distanceAlongRouteTo(rt, i)をO(n)ループの中で毎回呼ぶとO(n²)になる箇所が
  // 3つ(このrailApproachCapKmh・直後のhardEnvelopeループ・後方のrequiredDecelループ)
  // あったため、累積距離を1回だけ前計算して共有する。
  const routeDistances = cumulativeRouteDistances(rt);
  const railCapKmh = railApproachCapKmh(world, rt, rules, serviceDecelMs2, BRAKE_JERK_MS3, routeDistances);

  // ブレーキ指令のしきい値。「今ブレーキを緩解している状態から、ジャークで常用最大まで
  // 立ち上げて停止する」のに必要な距離を織り込んだ包絡線。これを超えたら制動に入る。
  // 一度制動に入ると、実速度はこの包絡線より必ず上に留まる(既に込めているぶん有利なため)
  // ので、制動中に加速側へ戻って脈動することがない。
  const releaseEnvelopeKmh = Math.min(
    MAX_SPEED_KMH,
    railCapKmh,
    permittedSpeedKmh(usableDistance, serviceDecelMs2, BRAKE_JERK_MS3, 0)
  );
  // ジャーク制限を無視した常用ブレーキの包絡線。絶対に超えてはならない上限で、
  // 終盤は sqrt(2ad) に従って有限時間で0へ収束する(=だらだらクロールしない)。
  // 軌道の速度上限も同じ形の式(sqrt(target² + 2ad))で織り込み、より厳しい方を採る。
  let hardEnvelopeKmh = Math.sqrt(2 * serviceDecelMs2 * usableDistance) * 3.6;
  if (rules.trackClasses) {
    // 現在セル自身の速度上限(距離0)。列車がまさに制限区間の中にいる場合はこれが効く
    // (rt.routeは未通過の先のセルしか含まないため、現在セルはここで別途扱う必要がある)。
    const currentCap = railWeightSpeedCapKmh(world.railMap.get(toKey(rt.grid.x, rt.grid.z))?.railWeight);
    if (isFinite(currentCap)) hardEnvelopeKmh = Math.min(hardEnvelopeKmh, currentCap);
    for (let i = 0; i < rt.route.length; i++) {
      const cell = world.railMap.get(toKey(rt.route[i].x, rt.route[i].z));
      const cap = railWeightSpeedCapKmh(cell?.railWeight);
      if (!isFinite(cap)) continue;
      const dist = Math.max(0, routeDistances[i] - RAIL_CAP_APPROACH_MARGIN_M);
      const capMs = cap / 3.6;
      const hard = Math.sqrt(Math.max(0, capMs * capMs + 2 * serviceDecelMs2 * dist)) * 3.6;
      hardEnvelopeKmh = Math.min(hardEnvelopeKmh, hard);
    }
  }

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
  } else if (rules.trackClasses && rt.speedKmh > hardEnvelopeKmh) {
    // 軌道(何キロレール)の制動曲線(hardEnvelopeKmh)を超えている(前方のレール速度上限に
    // 間に合わなくなった、または既に速度上限を超えたセルへ進んでしまった)場合も、
    // 通常のブレーキラッチ(rt.braking)を待たず非常制動で追いつく(design: 停止点向けの
    // hardEnvelope超過時の非常制動と同じ扱い)。
    // M1: rules.trackClasses=falseならhardEnvelopeKmhはsqrt(2ad)そのもの(=従来からの
    // 停止点向け制動曲線と同値)なので、この分岐をゲートしないと下位ティアの挙動が
    // 変わってしまう(brakeDecelMs2が瞬時にserviceDecelMs2へ飛び、rampDecelを経由しない)。
    rt.speedKmh = Math.max(hardEnvelopeKmh, rt.speedKmh - EMERGENCY_DECEL_KMH_S * dt);
    rt.brakeDecelMs2 = serviceDecelMs2;
    rt.braking = true;
  } else if (rt.braking) {
    // 制動中。「常に常用最大で込める」のではなく、停止点でちょうど0になるのに必要な
    // 減速度 aReq = v²/(2d) を目標にし、ジャーク制限つきで追従させる(サーボ制御)。
    //
    // 常用最大で込め切ってしまうと、必要以上に減速して停止点の手前で失速し、
    // そこから包絡線に沿って這い直す(=だらだらクロール)ことになる。
    // 必要ぶんだけ込めれば、ブレーキ開始から停止まで一定の当たりで滑らかに減速し、
    // 有限時間でちょうど停止点に着く。
    const speedMs = rt.speedKmh / 3.6;
    let requiredDecelMs2 = usableDistance > 1e-6
      ? (speedMs * speedMs) / (2 * usableDistance)
      : serviceDecelMs2;
    // 軌道(何キロレール): 前方のレール速度上限にも、ちょうど間に合う減速度で追従する
    // (複数の制約のうち、最も強い減速を要求するものに従う)。
    if (rules.trackClasses) {
      for (let i = 0; i < rt.route.length; i++) {
        const cell = world.railMap.get(toKey(rt.route[i].x, rt.route[i].z));
        const cap = railWeightSpeedCapKmh(cell?.railWeight);
        if (!isFinite(cap)) continue;
        const dist = Math.max(0, routeDistances[i] - RAIL_CAP_APPROACH_MARGIN_M);
        if (dist <= 1e-6) continue;
        const capMs = cap / 3.6;
        if (speedMs <= capMs) continue;
        const need = (speedMs * speedMs - capMs * capMs) / (2 * dist);
        requiredDecelMs2 = Math.max(requiredDecelMs2, need);
      }
    }
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
      // PM3: 先頭が現在セル→次セルの境界(=デッドセクション)の前後1セル以内にいる間は
      // 牽引力ゼロで惰行する(design decision 4)。現在セルと次セルの電化方式が異なれば
      // その境界を跨いでいる/跨ごうとしていることになる。
      const currentCellForDeadSection = world.railMap.get(toKey(rt.grid.x, rt.grid.z));
      const nextCellForDeadSection = world.railMap.get(toKey(nextTile.x, nextTile.z));
      const inDeadSection = isDeadSectionBoundary(currentCellForDeadSection, nextCellForDeadSection);

      // PM3フォローアップ: デッドセクション失速。rules.electrification が
      // 'boundaries'/'feeding' の電車限定(気動車は電化方式に関係なく走れるので対象外)。
      // 惰行中に速度がほぼ0まで落ちたら失速状態に入り、STALL_RECOVERY_SECONDS秒
      // 経つと1回だけ課金して救援=以降このデッドセクションを抜けきるまで牽引力を持たせる
      // (design: 「抜けるまで通電扱い」が最も単純で正しい)。
      const rulesForStall = world.rules ?? DEFAULT_GAME_RULES;
      const stallingActive =
        (rulesForStall.electrification === 'boundaries' || rulesForStall.electrification === 'feeding') &&
        !!train.power && train.power !== 'diesel';

      let inStall = false;
      if (stallingActive) {
        if (!inDeadSection) {
          rt.stalledSeconds = 0;
          rt.stallRecovered = false;
        } else if (!rt.stallRecovered && rt.speedKmh < STALL_SPEED_THRESHOLD_KMH) {
          rt.stalledSeconds = (rt.stalledSeconds ?? 0) + dt;
          if (rt.stalledSeconds >= STALL_RECOVERY_SECONDS) {
            events.push({ type: 'stallRescue', trainId: train.id, penalty: STALL_RESCUE_COST });
            rt.stalledSeconds = 0;
            rt.stallRecovered = true;
          } else {
            inStall = true;
            rt.debugStatus = `失速 (${rt.stalledSeconds.toFixed(0)}s)`;
          }
        }
      }

      if (!inStall) {
        // PM4: き電区間の在線数が容量を超えていれば、牽引力にOVERLOAD_ACCEL_FACTORを掛ける
        // (電圧降下の離散近似、design decision 4「traction only」)。気動車・feeding未満の
        // プレイモードでは常に1(無影響)。
        let tractionFactor = 1;
        if (world.feeding && feedingSectionCounts && train.power && train.power !== 'diesel') {
          const sectionKey = world.feeding.sectionLoadKey(rt.grid.x, rt.grid.z, rt.grid.layer ?? 0);
          if (sectionKey) {
            const capacity = world.feeding.sectionCapacity(sectionKey);
            const count = feedingSectionCounts.get(sectionKey) ?? 0;
            if (isOverloaded(count, capacity)) tractionFactor = OVERLOAD_ACCEL_FACTOR;
          }
        }

        // 救援後は区間を抜けきるまで牽引力を持たせる(通常の'accelerating'扱い)。
        const useCoasting = inDeadSection && !rt.stallRecovered;

        // OpenTTD Realisticモデル構造(F/m)を再実装したcomputeAccelerationで増速する。
        // 乗客数に応じて質量が増え、満載時ほど加速が鈍る。
        const accelMs2 = computeAcceleration(
          { spec: TRAIN_SPECS[DEFAULT_TRAIN_TYPE], cars: train.cars ?? 2, passengers: rt.passengers, speedKmh: rt.speedKmh },
          useCoasting ? 'coasting' : 'accelerating',
          DECEL_KMH_S,
          tractionFactor
        );
        rt.speedKmh = Math.min(releaseEnvelopeKmh, Math.max(0, rt.speedKmh + accelMs2 * 3.6 * dt));
      }
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
      rt.renderPos = { x: head.x, y: cellCentreHeight(world.railMap, arrivedGrid.x, arrivedGrid.z, arrivedGrid.layer, world.terrainField), z: head.z };
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
    // 高さも同じセル曲線ベジェ(pathHeightAt)で求める。従来はセル中心高さの線形補間
    // (interpCellHeight)だったため、坂のsmoothstepカーブとズレてセル境界でピッチ角が
    // 折れて見えていた(レール描画・後続車と定義を合わせる)。
    const headY = pathHeightAt(
      rt.prevGrid, rt.grid, nextTile, rt.route[1] ?? null, newProgress,
      (p: Grid) => cellCentreHeight(world.railMap, p.x, p.z, p.layer, world.terrainField)
    );
    rt.renderPos = { x: head.x, y: headY, z: head.z };
    rt.renderTarget = { x: nextTile.x, y: 0.5, z: nextTile.z };
  }
};

// 駅ごとの輸送力(その駅に停車する運行を持つ列車の編成定員合計)。
// resolveTownSpawnTick(sim/towns.ts)は trains/groups の型を知らないため、ここで集計してから渡す。
const computeStationTransportInfos = (world: SimWorld): StationTransportInfo[] => {
  const capacities = new Map<string, number>();
  for (const train of world.trains) {
    if (train.status !== 'running') continue;
    const schedule = effectiveSchedule(train, world.groups ?? []);
    if (schedule.length === 0) continue;
    const capacity = (train.cars ?? 2) * CAPACITY_PER_CAR;
    for (const stationId of new Set(schedule)) {
      capacities.set(stationId, (capacities.get(stationId) ?? 0) + capacity);
    }
  }

  const infos: StationTransportInfo[] = [];
  for (const station of world.stations.values()) {
    const capacity = capacities.get(station.id) ?? 0;
    if (capacity <= 0) continue;
    infos.push({ stationId: station.id, pos: station.center, capacity });
  }
  return infos;
};

// H4(progress/review-play-modes-branch.md): 改軌(applyRegaugePath)のno-op判定は
// 「列車が在線中のセル」を見る必要があるが、TrainData.x/zは車庫での初期位置のまま
// 更新されない(走行中の実位置はTrainRuntime.gridおよびrt.route)。useGameLogic.tsの
// commitPath('regauge')はworld.trainsではなくこちらを使うこと。
// 予約中の区間(reservedEndIndex分)だけでなく経路全体を含めるのは、経路探索中の
// 列車が改軌直後に軌間ミスマッチで立ち往生するのを避けるため、やや広めに取る安全側の判断。
export function occupiedCellKeysFromRuntimes(runtimes: Map<string, TrainRuntime>): Set<string> {
  const occupied = new Set<string>();
  for (const rt of runtimes.values()) {
    occupied.add(toKey(rt.grid.x, rt.grid.z));
    for (const p of rt.route) occupied.add(toKey(p.x, p.z));
  }
  return occupied;
}

export function stepWorld(world: SimWorld, dt: number): SimEvent[] {
  const events: SimEvent[] = [];

  // ゲーム内暦を進め、月が変わったtickでmonthEndイベントを発行する(dtが大きく複数月
  // 跨いだ場合は月数分発行する)。
  if (!world.clock) world.clock = { elapsed: 0 };
  const prevDayIndex = dayIndexOf(world.clock.elapsed);
  const prevMonthIndex = monthIndexOf(world.clock.elapsed);
  world.clock.elapsed += dt;
  const newDayIndex = dayIndexOf(world.clock.elapsed);
  const newMonthIndex = monthIndexOf(world.clock.elapsed);

  // 町の湧き判定は日次(dtが大きく複数日跨いだ場合は日数分)。駅を置いただけでは湧かず、
  // 実際に列車が停まり輸送力が閾値を超えて初めて町の芽(小さな新しい町)が生える
  // (resolveTownSpawnTick、sim/towns.ts)。
  if (newDayIndex > prevDayIndex && world.terrainField) {
    const stationInfos = computeStationTransportInfos(world);
    for (let d = prevDayIndex; d < newDayIndex; d++) {
      if (stationInfos.length === 0) break;
      // railMapを渡し、線路・駅・車庫が地面を占有するセルの上に町の中心が湧かないようにする。
      const result = resolveTownSpawnTick(stationInfos, world.towns ?? [], world.terrainField, world.rng, world.railMap);
      if (result.spawnedTowns.length > 0) {
        world.towns = result.towns;
        events.push({ type: 'townGrowth', towns: world.towns });
      }
    }
  }

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

  // PM4: き電区間ごとの在線数(電車のみ)を1tick分先に数えておく。容量超過の判定は
  // 「そのtick開始時点の在線数」を使う(列車ごとに動かしながら数えると走行順で
  // 結果が変わってしまうため、1パス目で固定してから2パス目のstepTrainへ渡す)。
  const rules = world.rules ?? DEFAULT_GAME_RULES;
  let feedingSectionCounts: Map<string, number> | undefined;
  if (rules.electrification === 'feeding' && world.feeding) {
    feedingSectionCounts = new Map();
    const feeding = world.feeding;
    for (const train of world.trains) {
      if (train.status !== 'running') continue;
      if (!train.power || train.power === 'diesel') continue;
      const rt = world.runtimes.get(train.id);
      if (!rt) continue;
      const key = feeding.sectionLoadKey(rt.grid.x, rt.grid.z, rt.grid.layer ?? 0);
      if (!key) continue;
      feedingSectionCounts.set(key, (feedingSectionCounts.get(key) ?? 0) + 1);
    }
  }
  world.feedingSectionCounts = feedingSectionCounts;

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
    stepTrain(world, train, rt, dt, events, feedingSectionCounts);
  }

  return events;
}
