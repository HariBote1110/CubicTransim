// D3: 運転台視点(乗車モードの一種)のHUD情報を求める純関数。
//
// simulation.ts の stepTrain が速度制御・閉塞判定のために計算している値
// (distanceAlongRouteTo/distanceToStopPoint、railWeightSpeedCapKmh、
// entrySignalKindFor/blocksSegmentEntry)をそのまま再利用し、別のテーブル・
// 別の閉塞判定を持ち込まない。stepTrainのローカル変数としてしか存在しない
// 「安全点までの分類」「ブロック占有の再評価」だけは、この関数の中で
// 同じ2〜3行の組み立てを再現する(sim層のロジック自体は無改造。可視性のみ変更)。

import { toKey } from '../utils';
import type { CellData } from '../types';
import { DEFAULT_GAME_RULES, isDeadSectionBoundary } from '../sim/gameRules';
import {
  MAX_SPEED_KMH, distanceAlongRouteTo, distanceToStopPoint,
  entrySignalKindFor, blocksSegmentEntry,
} from '../sim/simulation';
import type { SimWorld, TrainRuntime } from '../sim/simulation';
import { railWeightSpeedCapKmh } from '../sim/physics';
import { findSafeSegmentEnd } from '../sim/reservation';
import type { ManualNotch, ManualDifficulty, ManualRideTally } from '../sim/manualDrive';

/** 次信号の先読み範囲(セル)。信号が無い区間で毎フレーム経路全体を舐めないための上限。 */
export const NEXT_SIGNAL_LOOKAHEAD_CELLS = 20;
/** デッドセクション予告の先読み範囲(セル)。タスク仕様どおり10。 */
export const DEAD_SECTION_LOOKAHEAD_CELLS = 10;

export interface CabHudInfo {
  speedKmh: number;
  /**
   * 制限速度(km/h)。`rules.trackClasses`が有効なら現在セルのレール種別に応じた
   * 速度上限(`railWeightSpeedCapKmh`、physics.tsのテーブルをそのまま参照)、
   * 無効なら唯一の速度上限定数(`MAX_SPEED_KMH`)にフォールバックする。
   */
  speedLimitKmh: number;
  /** 次の停止点(信号のsafe waiting point、または最終停止駅)までの距離(m)。経路が無ければnull。 */
  nextStopDistanceM: number | null;
  /** 次信号の現示。先読み範囲内に信号セルが無ければnull。 */
  nextSignalAspect: 'green' | 'red' | null;
  /** 先読み範囲内に交直(電化方式)デッドセクション境界があるか。 */
  deadSectionAhead: boolean;
  /** D4: この列車がworld.manualDriveの対象なら、ノッチ・難易度・乗車タリーをそのまま。 */
  manual?: { notch: ManualNotch; difficulty: ManualDifficulty; tally: ManualRideTally };
  /** D4: 直近の停車採点(TrainRuntime.manualLastStopScoreの転記)。未採点ならundefined。 */
  lastStopScore?: { distanceM: number; withinTolerance: boolean; toleranceM: number };
}

const cellAt = (railMap: Map<string, CellData>, p: { x: number; z: number }): CellData | undefined =>
  railMap.get(toKey(p.x, p.z));

export function computeCabHud(world: SimWorld, trainId: string): CabHudInfo | null {
  const rt = world.runtimes.get(trainId);
  if (!rt) return null;
  const rules = world.rules ?? DEFAULT_GAME_RULES;

  const nextStopDistanceM = computeNextStopDistanceM(rt);
  const nextSignalAspect = computeNextSignalAspect(world, rt, trainId);
  const deadSectionAhead = computeDeadSectionAhead(world, rt);
  const speedLimitKmh = rules.trackClasses
    ? railWeightSpeedCapKmh(cellAt(world.railMap, rt.grid)?.railWeight)
    : MAX_SPEED_KMH;

  const manual = world.manualDrive && world.manualDrive.trainId === trainId
    ? { notch: world.manualDrive.notch, difficulty: world.manualDrive.difficulty, tally: world.manualDrive.tally }
    : undefined;

  return {
    speedKmh: rt.speedKmh,
    speedLimitKmh,
    nextStopDistanceM,
    nextSignalAspect,
    deadSectionAhead,
    manual,
    lastStopScore: rt.manualLastStopScore,
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
 * 経路上の先読み範囲から最初の信号セルを探す。
 *
 * - 既に`reservedEndIndex`がその信号のindexまで届いていれば無条件でgreen
 *   (予約はブロック占有チェックを通過済みの結果なので、これより確実な情報は無い)。
 * - s0(ブロックの概念が無い)なら、そこまでで届いていない=red。
 * - s1/s2/s3では、`reservedEndIndex`が届いていないからといって即redにはしない。
 *   列車がまだ制動距離圏内に入っておらず予約延長そのものを試みていないだけの
 *   可能性があるため(旧実装はこれを誤ってredと報告していた)、「信号セルそのものを
 *   route上のsafe waiting pointとみなして、そこから先(信号の先のブロック)を
 *   予約しようとしたら通るか」をstepTrainのensureReservationと同じ組み立て
 *   (`findSafeSegmentEnd`で信号の先の次の安全点区間を求め、
 *   `entrySignalKindFor`/`blocksSegmentEntry`でその区間が予約可能かを評価する)で
 *   直接問い合わせる。信号セル自身はどのブロックにも属さない(blocks.ts)ため、
 *   区間の起点を信号のindexそのものにすることで、信号の先のブロックの占有状態を
 *   確実に踏む(reservedEndIndex+1を起点にすると、まだ手前のブロックしか見ない)。
 */
function computeNextSignalAspect(world: SimWorld, rt: TrainRuntime, trainId: string): 'green' | 'red' | null {
  const limit = Math.min(rt.route.length, NEXT_SIGNAL_LOOKAHEAD_CELLS);
  let signalIdx = -1;
  for (let i = 0; i < limit; i++) {
    if (cellAt(world.railMap, rt.route[i])?.signalDir) {
      signalIdx = i;
      break;
    }
  }
  if (signalIdx === -1) return null;
  if (rt.reservedEndIndex >= signalIdx) return 'green';

  const rules = world.rules ?? DEFAULT_GAME_RULES;
  if (rules.signalling === 's0' || !world.blocks) return 'red';

  const nextIdx = findSafeSegmentEnd(world.railMap, rt.route, signalIdx);
  const segment = rt.route.slice(signalIdx, nextIdx + 1);
  const entryKind = entrySignalKindFor(world, rt, signalIdx);
  const trainProtection = world.trains.find(t => t.id === trainId)?.protection;
  const blocked = blocksSegmentEntry(world, rules, trainId, segment, entryKind, trainProtection, rt.route, signalIdx);
  return blocked ? 'red' : 'green';
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
