// D4: 手動運転(進捗計画 progress/dream-modes-plan.md フェーズD4)のノッチ・難易度まわりの
// 純関数群。simulation.ts の stepTrain が使う既存の加速モデル(physics.ts)・制動定数
// (simulation.ts の DECEL_KMH_S/EMERGENCY_DECEL_KMH_S)をそのまま再利用し、新しい
// テーブルはノッチ→割合の対応表だけに留める。

import type { TrainProtection } from '../types';
import { weakerProtection } from './economy';

/** マスコン(力行)ノッチ。P5が最強、P1が最弱。 */
export type PowerNotch = 'P5' | 'P4' | 'P3' | 'P2' | 'P1';
/** ブレーキノッチ。B7が常用最大、B1が最弱。EBは非常制動。 */
export type BrakeNotch = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'B7';
export type ManualNotch = PowerNotch | 'N' | BrakeNotch | 'EB';

/** キーボード(↑↓)でノッチを送るときの並び順。先頭がEB(最強制動)、末尾がP5(最強力行)。 */
export const NOTCH_ORDER: ManualNotch[] = [
  'EB', 'B7', 'B6', 'B5', 'B4', 'B3', 'B2', 'B1', 'N', 'P1', 'P2', 'P3', 'P4', 'P5',
];

/** 難易度(運転モード内の独立選択、progress/dream-modes-plan.md D4の表)。 */
export type ManualDifficulty = 'easy' | 'normal' | 'hard';

/** SimWorldへ載せる手動運転の状態。1度に手動運転できる列車は1本まで。 */
export interface ManualDriveState {
  trainId: string;
  notch: ManualNotch;
  difficulty: ManualDifficulty;
  /** この乗車(乗車中〜降車まで)の運転成績の累計。simulation.tsが停車のたびに加算する。 */
  tally: ManualRideTally;
}

/** ノッチを1段階だけ強く/弱くする。両端(EB/P5)でクランプする。 */
export function stepNotch(current: ManualNotch, direction: 1 | -1): ManualNotch {
  const idx = NOTCH_ORDER.indexOf(current);
  const next = idx + direction;
  if (next < 0) return NOTCH_ORDER[0];
  if (next >= NOTCH_ORDER.length) return NOTCH_ORDER[NOTCH_ORDER.length - 1];
  return NOTCH_ORDER[next];
}

const POWER_FRACTION: Record<PowerNotch, number> = { P1: 0.2, P2: 0.4, P3: 0.6, P4: 0.8, P5: 1.0 };
const BRAKE_FRACTION: Record<BrakeNotch, number> = {
  B1: 1 / 7, B2: 2 / 7, B3: 3 / 7, B4: 4 / 7, B5: 5 / 7, B6: 6 / 7, B7: 1.0,
};

/** 力行ノッチなら[0,1]の出力割合、それ以外は0。 */
export function notchPowerFraction(notch: ManualNotch): number {
  return (POWER_FRACTION as Record<string, number | undefined>)[notch] ?? 0;
}

/** ブレーキノッチ(EB以外)なら[0,1]の常用最大に対する割合、それ以外は0。 */
export function notchBrakeFraction(notch: ManualNotch): number {
  return (BRAKE_FRACTION as Record<string, number | undefined>)[notch] ?? 0;
}

export function isPowerNotch(notch: ManualNotch): notch is PowerNotch {
  return notch in POWER_FRACTION;
}

export function isBrakeNotch(notch: ManualNotch): notch is BrakeNotch {
  return notch in BRAKE_FRACTION;
}

/**
 * かんたん(ATO)モードの最高速度キャップ(km/h)。力行ノッチを「プレイヤーが指示する
 * 最高速度」として読み替える(P5=maxSpeedKmhそのまま、P1=20%)。N・ブレーキ系ノッチは
 * 「止まってほしい」という意思表示として0を返す(自動制御が停止目標に切り替わる)。
 */
export function easyModeSpeedCapKmh(notch: ManualNotch, maxSpeedKmh: number): number {
  if (isPowerNotch(notch)) return notchPowerFraction(notch) * maxSpeedKmh;
  return 0;
}

/**
 * ふつう/むずかしいで実際にプレイヤーが指令する加速度(m/s²、正=力行・負=制動)。
 * 力行はaccelMs2(computeAccelerationの結果)にノッチ割合を掛けるだけ、制動は
 * serviceDecelMs2(既存のDECEL_KMH_S相当)にノッチ割合を掛ける。EBはemergencyDecelMs2
 * (既存のEMERGENCY_DECEL_KMH_S相当)をそのまま使う。Nは0。
 */
export function manualCommandedAccelMs2(
  notch: ManualNotch,
  fullAccelMs2: number,
  serviceDecelMs2: number,
  emergencyDecelMs2: number
): number {
  if (notch === 'EB') return -emergencyDecelMs2;
  if (isPowerNotch(notch)) return notchPowerFraction(notch) * fullAccelMs2;
  if (isBrakeNotch(notch)) return -notchBrakeFraction(notch) * serviceDecelMs2;
  return 0; // N
}

/**
 * むずかしい難易度で「実際に装備している保安装置」による自動ブレーキが働くか。
 * S3のSPAD確率テーブル(economy.ts SPAD_CHANCE)と同じ強さの順位を使い、
 * ATS-P/ATC/CBTC(SPAD確率0%=決定的に守ってくれる)のときだけtrueとする。
 * ATS-S(警報のみ)・未装備はfalse(=何も守ってくれない、プレイヤー任せ)。
 */
export function equippedProtectionActive(
  trackProtection: TrainProtection | undefined,
  trainProtection: TrainProtection | undefined
): boolean {
  const effective = weakerProtection(trackProtection, trainProtection);
  return effective === 'ats-p' || effective === 'atc' || effective === 'cbtc';
}

/**
 * むずかしい難易度で、閉塞(ブロック占有)により本来止まるべき信号を、プレイヤーが
 * 力行ノッチで押し切って通過しようとしているか。保安装置が実際に有効
 * (equippedProtectionActive)なら常にfalse(=通常どおり信号を守る)。無装備区間でだけ
 * true になり、simulation.ts側でblocksSegmentEntryの結果を上書きして予約を強行させ、
 * 既存のSPAD確率(economy.ts SPAD_CHANCE)で事故判定する呼び出し元に委ねる。
 */
export function canManualForceEntry(
  notch: ManualNotch,
  difficulty: ManualDifficulty,
  trackProtection: TrainProtection | undefined,
  trainProtection: TrainProtection | undefined
): boolean {
  if (difficulty !== 'hard') return false;
  if (equippedProtectionActive(trackProtection, trainProtection)) return false;
  return isPowerNotch(notch);
}

/** 難易度別の停車判定の許容誤差(m、progress/dream-modes-plan.md D4の表)。 */
export const STOP_TOLERANCE_M: Record<ManualDifficulty, number> = {
  easy: Infinity, // かんたんは自動着地するため「失敗が存在しない」
  normal: 15,
  hard: 5,
};

/** 停車スコアの分類。 */
export function classifyStopAccuracy(
  distanceM: number,
  difficulty: ManualDifficulty
): { withinTolerance: boolean; toleranceM: number } {
  const toleranceM = STOP_TOLERANCE_M[difficulty];
  return { withinTolerance: Math.abs(distanceM) <= toleranceM, toleranceM };
}

/** 1回の乗車(乗車中〜降車まで)の運転成績の累計。 */
export interface ManualRideTally {
  stops: number;
  withinToleranceStops: number;
  totalAbsErrorM: number;
  overspeedSeconds: number;
  emergencyBrakeCount: number;
}

export function createManualRideTally(): ManualRideTally {
  return { stops: 0, withinToleranceStops: 0, totalAbsErrorM: 0, overspeedSeconds: 0, emergencyBrakeCount: 0 };
}
