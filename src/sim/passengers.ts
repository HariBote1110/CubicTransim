// 旅客の経路検索。純粋関数のみ。React/THREE には依存しない。
//
// 考え方は Cities: Skylines に近い:
//  - 旅客が歩く先は線路ではなく「実際に列車が走っている区間」。運行表(路線×種別の有効運行表、
//    または列車自身の運行表)で隣り合う駅どうしを辺とみなしたサービス網の上を探索する。
//    線路が繋がっていても列車が走っていない区間は移動できない。
//  - 経路は1人ずつ引かない。出発駅→目的駅ごとに1回だけ探索し、その結果を
//    同じ駅ペアの旅客全員(コホート)で使い回す(routeBetween のキャッシュ)。
//  - 評価軸は「乗換の少なさ」が第一、次に「駅数の少なさ」。所要時間まで見ないのは、
//    運転間隔や待ち時間を含めた実所要時間の推定が路線ダイヤの実装待ちのため。
import type { StationData, TownData, TrainData, LineData, ServiceData } from '../types';
import { demandFactor } from './economy';
import { effectiveSchedule } from './lines';

/** 乗換の上限回数。これを超える経路は「乗らない」とみなす。 */
export const MAX_TRANSFERS = 2;

/** サービス網の辺。lineId は由来する系統(種別id、単独運用なら列車id)。 */
export interface ServiceEdge {
  to: string;
  lineId: string;
}

/** 駅idから、その駅を出る辺の一覧への写像。 */
export type ServiceGraph = Map<string, ServiceEdge[]>;

/** 経路の1区間(同じ系統に乗り continue する範囲)。 */
export interface RouteLeg {
  lineId: string;
  from: string;
  to: string;
}

export interface PassengerRoute {
  legs: RouteLeg[];
  /** 通過する駅間の数。 */
  hops: number;
  /** 乗換回数(legs.length - 1、legsが空なら0)。 */
  transfers: number;
}

const addEdge = (graph: ServiceGraph, from: string, to: string, lineId: string) => {
  const edges = graph.get(from) ?? [];
  // 同じ系統で同じ隣接駅の辺は1本だけ持つ(同一グループに複数の列車がいる場合に重複するため)。
  if (edges.some(e => e.to === to && e.lineId === lineId)) return;
  edges.push({ to, lineId });
  graph.set(from, edges);
};

/**
 * 走行中の列車の運行表から、旅客が移動できるサービス網を組み立てる。
 * 運行表で連続する駅どうしを双方向の辺にする(折り返し運転を前提とするため)。
 */
export function buildServiceGraph(trains: TrainData[], lines: LineData[], services: ServiceData[]): ServiceGraph {
  const graph: ServiceGraph = new Map();

  for (const train of trains) {
    // 車庫で待機中の列車は運行していないので、その運行表は移動手段にならない。
    if (train.status !== 'running') continue;

    const schedule = effectiveSchedule(train, lines, services);
    const lineId = train.serviceId ?? train.id;

    for (let i = 0; i + 1 < schedule.length; i++) {
      const a = schedule[i];
      const b = schedule[i + 1];
      if (a === b) continue;
      addEdge(graph, a, b, lineId);
      addEdge(graph, b, a, lineId);
    }
  }

  return graph;
}

// 探索中の状態。「どの駅に、どの系統で着いたか」までを状態にしないと乗換回数を数えられない。
interface SearchNode {
  station: string;
  lineId: string | null;
  transfers: number;
  hops: number;
  legs: RouteLeg[];
}

/**
 * 出発駅から目的駅への経路を探す。見つからなければ null。
 *
 * 乗換回数を第一、駅数を第二の評価軸にした一様コスト探索。
 * 状態は (駅, 到着に使った系統) の組で、同じ駅でも別系統で着いたなら別状態として扱う。
 */
export function findRoute(
  graph: ServiceGraph,
  from: string,
  to: string,
  maxTransfers: number = MAX_TRANSFERS
): PassengerRoute | null {
  if (from === to) return { legs: [], hops: 0, transfers: 0 };

  const start: SearchNode = { station: from, lineId: null, transfers: 0, hops: 0, legs: [] };
  const queue: SearchNode[] = [start];
  // (駅|系統)ごとの到達コスト。より良いコストで再訪できたときだけ展開し直す。
  const best = new Map<string, number>();
  const costOf = (n: SearchNode) => n.transfers * 1_000 + n.hops;

  let found: PassengerRoute | null = null;

  while (queue.length > 0) {
    // 一様コスト探索: いちばん安い状態から取り出す。駅数は高々数十なので線形走査で十分。
    let bestIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (costOf(queue[i]) < costOf(queue[bestIdx])) bestIdx = i;
    }
    const node = queue.splice(bestIdx, 1)[0];

    if (node.station === to) {
      found = { legs: node.legs, hops: node.hops, transfers: Math.max(0, node.legs.length - 1) };
      break;
    }

    for (const edge of graph.get(node.station) ?? []) {
      const isTransfer = node.lineId !== null && node.lineId !== edge.lineId;
      const transfers = node.transfers + (isTransfer ? 1 : 0);
      if (transfers > maxTransfers) continue;

      // 同じ系統に乗り続けるなら直前のlegを延ばし、乗り換えるなら新しいlegを作る。
      const legs = isTransfer || node.lineId === null
        ? [...node.legs, { lineId: edge.lineId, from: node.station, to: edge.to }]
        : [...node.legs.slice(0, -1), { ...node.legs[node.legs.length - 1], to: edge.to }];

      const next: SearchNode = {
        station: edge.to,
        lineId: edge.lineId,
        transfers,
        hops: node.hops + 1,
        legs,
      };

      const key = `${next.station}|${next.lineId}`;
      const known = best.get(key);
      if (known !== undefined && known <= costOf(next)) continue;
      best.set(key, costOf(next));
      queue.push(next);
    }
  }

  return found;
}

/**
 * 経路キャッシュ。「出発駅|目的駅」→経路(見つからなかった場合は null)。
 * 経路探索は旅客1人ごとではなく駅ペアごとに1回だけ行い、結果を全員で共有する。
 */
export type RouteCache = Map<string, PassengerRoute | null>;

export function createRouteCache(): RouteCache {
  return new Map();
}

/** キャッシュ経由で経路を得る。未計算なら探索し、結果(nullも含む)を記録する。 */
export function routeBetween(
  cache: RouteCache,
  graph: ServiceGraph,
  from: string,
  to: string
): PassengerRoute | null {
  const key = `${from}|${to}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const route = findRoute(graph, from, to);
  cache.set(key, route);
  return route;
}

/**
 * キャッシュを破棄する。運行表・グループ・列車の配備が変わってサービス網が
 * 変化したときに呼ぶ(経路が古いままだと、走っていない区間へ旅客を送り続けてしまう)。
 */
export function invalidateRoutes(cache: RouteCache): void {
  cache.clear();
}

// --- 行き先の決め方(重力モデル) ---

/** 行き先候補とその重み。 */
export interface DestinationWeight {
  stationId: string;
  weight: number;
}

/**
 * 出発駅から見た行き先の重み。
 *
 * 重力モデル: 「行き先の集客力(周辺の街の人口・距離から決まる demandFactor)」を
 * 「駅間の距離」で割る。近くて栄えている駅ほど選ばれやすい。
 * reachable が false を返す駅(列車で行けない駅)は候補から外す ── これにより
 * 「線路が繋がっていない駅に客が湧く」ことがなくなる。
 */
export function destinationWeights(
  originId: string,
  stations: Map<string, StationData>,
  towns: TownData[],
  reachable: (destinationId: string) => boolean
): DestinationWeight[] {
  const origin = stations.get(originId);
  if (!origin) return [];

  const weights: DestinationWeight[] = [];
  for (const station of stations.values()) {
    if (station.id === originId) continue;
    if (!reachable(station.id)) continue;

    const pull = demandFactor(station.center, towns);
    if (pull <= 0) continue;

    const dist = Math.hypot(station.center.x - origin.center.x, station.center.z - origin.center.z);
    // 隣接しすぎている駅で重みが発散しないよう、距離は最低1タイルとして扱う。
    weights.push({ stationId: station.id, weight: pull / Math.max(1, dist) });
  }
  return weights;
}

/** 重みに比例した抽選で行き先を1つ選ぶ。候補が無ければ null。 */
export function pickDestination(weights: DestinationWeight[], rng: () => number): string | null {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return null;

  let threshold = rng() * total;
  for (const w of weights) {
    threshold -= w.weight;
    if (threshold < 0) return w.stationId;
  }
  return weights[weights.length - 1].stationId;
}

// --- 待ち客のコホート ---

/**
 * 行き先を共有する旅客の塊。
 * 1人ずつのエージェントを持たず、「同じ駅で同じ行き先を待っている人数」としてまとめる。
 * 湧く量が小数で蓄積されるため count は小数を取りうる(乗車時に整数へ切り捨てる)。
 */
export interface PassengerCohort {
  destinationId: string;
  count: number;
}

/** 待ち行列に人数を足す(同じ行き先があればまとめる)。 */
export function addWaiting(cohorts: PassengerCohort[], destinationId: string, count: number): void {
  if (count <= 0) return;
  const existing = cohorts.find(c => c.destinationId === destinationId);
  if (existing) existing.count += count;
  else cohorts.push({ destinationId, count });
}

/** 待ち人数の合計。 */
export function totalWaiting(cohorts: PassengerCohort[]): number {
  return cohorts.reduce((sum, c) => sum + c.count, 0);
}

/**
 * 駅の待ち行列から、この列車に乗れる客を空席分だけ乗せる(cohortsを破壊的に減らす)。
 *
 * @param canBoard 行き先ごとに「この列車に乗るのが正しいか」を返す述語
 * @param capacity 空席数
 * @returns 乗車した塊(整数人数)
 */
export function boardFromStation(
  cohorts: PassengerCohort[],
  canBoard: (destinationId: string) => boolean,
  capacity: number
): PassengerCohort[] {
  let remaining = Math.floor(Math.max(0, capacity));
  const boarded: PassengerCohort[] = [];

  for (const cohort of cohorts) {
    if (remaining <= 0) break;
    if (!canBoard(cohort.destinationId)) continue;

    // 端数は駅に残す(車内の乗客数を常に整数に保つため)。
    const take = Math.min(Math.floor(cohort.count), remaining);
    if (take <= 0) continue;

    cohort.count -= take;
    remaining -= take;
    boarded.push({ destinationId: cohort.destinationId, count: take });
  }

  // 乗り切って空になった塊は取り除く。
  for (let i = cohorts.length - 1; i >= 0; i--) {
    if (cohorts[i].count <= 0) cohorts.splice(i, 1);
  }

  return boarded;
}
