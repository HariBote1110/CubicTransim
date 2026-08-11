// 駅の発車標(接近案内)。
//
// 「この駅を今まさに目指して走っている列車」を到着が早い順に並べる。
// あくまで目安の予測であり、信号待ちや発車間隔(headway)による停止・減速は
// 織り込まない(経路上の残距離と速度だけから単純計算する)。実際にはこれより
// 遅く到着することがある。
import type { TrainData, TrainGroupData } from '../types';
import type { TrainRuntime } from './simulation';
import { TILE_LENGTH } from './simulation';
import { effectiveSchedule, findGroup, stopsOnCurrentRun } from './groups';

/** 単独運用(グループ未所属)の列車の路線名・ラインカラー表示。 */
const STANDALONE_LINE_NAME = '単独';
const STANDALONE_LINE_COLOUR = '#8a8f98';

/** 到着秒数の見積もりに使う速度の下限(km/h)。停車中・極低速でも秒数が無限大にならないようにする。 */
const MIN_SPEED_FOR_ETA_KMH = 20;

export interface StationArrival {
  trainId: string;
  groupId: string | null;
  lineName: string;
  lineColour: string;
  /** この列車がこの駅を出たあとに向かう先の駅id。運行表が1駅だけ等で決められなければnull。 */
  destinationStationId: string | null;
  cars: number;
  /** 到着までの秒数の見積もり。停車中は0。 */
  secondsUntilArrival: number;
  isStopped: boolean;
}

/** rt.grid(+progress)からroute末尾までの弧長距離(m)。simulation.tsのdistanceAlongRouteToと同じ考え方。 */
const remainingRouteDistanceM = (rt: TrainRuntime): number => {
  const route = rt.route;
  if (route.length === 0) return 0;

  const first = route[0];
  const currentTileGeoDist = Math.sqrt((first.x - rt.grid.x) ** 2 + (first.z - rt.grid.z) ** 2);
  let dist = (1.0 - rt.progress) * (currentTileGeoDist * TILE_LENGTH);

  for (let i = 1; i < route.length; i++) {
    const p = route[i];
    const prevP = route[i - 1];
    const dGeo = Math.sqrt((p.x - prevP.x) ** 2 + (p.z - prevP.z) ** 2);
    dist += dGeo * TILE_LENGTH;
  }

  return Math.max(0, dist);
};

/**
 * 指定した駅を目指して走っている列車を、到着が早い順に並べる。
 *
 * @param stationId 発車標を出す駅
 * @param trains    全列車
 * @param runtimes  列車id→走行状態
 * @param groups    運用グループ一覧
 * @param maxResults 最大件数(既定5)
 */
export function computeStationArrivals(
  stationId: string,
  trains: TrainData[],
  runtimes: Map<string, TrainRuntime>,
  groups: TrainGroupData[],
  maxResults = 5
): StationArrival[] {
  const results: StationArrival[] = [];

  for (const train of trains) {
    if (train.status !== 'running') continue;

    const rt = runtimes.get(train.id);
    if (!rt) continue;

    const schedule = effectiveSchedule(train, groups);
    if (schedule.length === 0) continue;

    const targetStationId = schedule[train.scheduleIndex % schedule.length];
    if (targetStationId !== stationId) continue;

    const group = findGroup(groups, train.groupId);
    const lineName = group ? group.name : STANDALONE_LINE_NAME;
    const lineColour = group ? group.colour : STANDALONE_LINE_COLOUR;

    const ahead = stopsOnCurrentRun(
      schedule,
      { index: train.scheduleIndex, direction: train.scheduleDirection ?? 1 },
      group?.mode ?? 'loop'
    );
    const destinationStationId = ahead.length > 0 ? ahead[0] : null;

    const isStopped = rt.stopRemaining > 0;
    let secondsUntilArrival: number;
    if (isStopped) {
      secondsUntilArrival = 0;
    } else {
      const distanceM = remainingRouteDistanceM(rt);
      const effectiveSpeedKmh = Math.max(rt.speedKmh, MIN_SPEED_FOR_ETA_KMH);
      const speedMs = effectiveSpeedKmh / 3.6;
      secondsUntilArrival = speedMs > 0 ? distanceM / speedMs : 0;
    }

    results.push({
      trainId: train.id,
      groupId: train.groupId ?? null,
      lineName,
      lineColour,
      destinationStationId,
      cars: train.cars,
      secondsUntilArrival,
      isStopped,
    });
  }

  results.sort((a, b) => a.secondsUntilArrival - b.secondsUntilArrival);
  return results.slice(0, maxResults);
}
