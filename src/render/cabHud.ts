// D3: 運転台視点(乗車モードの一種)のHUD情報を求める純関数。
//
// simulation.ts の stepTrain が速度制御のために計算している値
// (distanceAlongRouteTo/distanceToStopPoint、MAX_SPEED_KMH)をそのまま再利用し、
// 別のテーブル・別の制動計算を持ち込まない。信号現示・デッドセクション予告は
// stepTrainが内部変数として持つだけで公開していない値なので、既存の純粋な述語
// (reservation.ts の予約状態、gameRules.ts の isDeadSectionBoundary)から
// この関数の中だけで組み立て直す(sim層のロジック自体は無改造)。

import { toKey } from '../utils';
import type { CellData } from '../types';
import { isDeadSectionBoundary } from '../sim/gameRules';
import {
  MAX_SPEED_KMH, distanceAlongRouteTo, distanceToStopPoint,
} from '../sim/simulation';
import type { SimWorld, TrainRuntime } from '../sim/simulation';

/** 次信号の先読み範囲(セル)。信号が無い区間で毎フレーム経路全体を舐めないための上限。 */
export const NEXT_SIGNAL_LOOKAHEAD_CELLS = 20;
/** デッドセクション予告の先読み範囲(セル)。タスク仕様どおり10。 */
export const DEAD_SECTION_LOOKAHEAD_CELLS = 10;

export interface CabHudInfo {
  speedKmh: number;
  /** 制限速度(km/h)。このゲームには軌道等級別のテーブルは無いため、
   * simulation.ts の唯一の速度上限定数(MAX_SPEED_KMH)をそのまま返す。 */
  speedLimitKmh: number;
  /** 次の停止点(信号のsafe waiting point、または最終停止駅)までの距離(m)。経路が無ければnull。 */
  nextStopDistanceM: number | null;
  /** 次信号の現示。先読み範囲内に信号セルが無ければnull。 */
  nextSignalAspect: 'green' | 'red' | null;
  /** 先読み範囲内に交直(電化方式)デッドセクション境界があるか。 */
  deadSectionAhead: boolean;
}

const cellAt = (railMap: Map<string, CellData>, p: { x: number; z: number }): CellData | undefined =>
  railMap.get(toKey(p.x, p.z));

export function computeCabHud(world: SimWorld, trainId: string): CabHudInfo | null {
  const rt = world.runtimes.get(trainId);
  if (!rt) return null;

  const nextStopDistanceM = computeNextStopDistanceM(rt);
  const nextSignalAspect = computeNextSignalAspect(world, rt);
  const deadSectionAhead = computeDeadSectionAhead(world, rt);

  return {
    speedKmh: rt.speedKmh,
    speedLimitKmh: MAX_SPEED_KMH,
    nextStopDistanceM,
    nextSignalAspect,
    deadSectionAhead,
  };
}

/**
 * 次の停止点までの距離。stepTrainの速度制御(simulation.ts)と同じ分類
 * (予約が経路末尾まで届いていれば'station'、そうでなければ信号などの
 * safe waiting pointである'signal')を、同じ2つの関数で再計算するだけ。
 */
function computeNextStopDistanceM(rt: TrainRuntime): number | null {
  if (rt.route.length === 0) return null;
  if (rt.reservedEndIndex >= rt.route.length - 1) return distanceToStopPoint(rt);
  if (rt.reservedEndIndex < 0) return null; // まだ次の安全点すら予約できていない
  return distanceAlongRouteTo(rt, rt.reservedEndIndex);
}

/**
 * 経路上の先読み範囲から最初の信号セルを探し、reservedEndIndexがその信号の
 * indexまで届いていれば green(通過してよい)、届いていなければ red とする。
 * 信号が見つからなければ null(HUDでは「なし」扱い)。
 */
function computeNextSignalAspect(world: SimWorld, rt: TrainRuntime): 'green' | 'red' | null {
  const limit = Math.min(rt.route.length, NEXT_SIGNAL_LOOKAHEAD_CELLS);
  for (let i = 0; i < limit; i++) {
    const cell = cellAt(world.railMap, rt.route[i]);
    if (cell?.signalDir) {
      return rt.reservedEndIndex >= i ? 'green' : 'red';
    }
  }
  return null;
}

/** 先読み範囲内(現在地からroute[N-1]まで)にデッドセクション境界があるか。 */
function computeDeadSectionAhead(world: SimWorld, rt: TrainRuntime): boolean {
  const limit = Math.min(rt.route.length, DEAD_SECTION_LOOKAHEAD_CELLS);
  let prev: { x: number; z: number } = rt.grid;
  for (let i = 0; i < limit; i++) {
    const curr = rt.route[i];
    if (isDeadSectionBoundary(cellAt(world.railMap, prev), cellAt(world.railMap, curr))) return true;
    prev = curr;
  }
  return false;
}
