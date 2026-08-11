// プレイモード(ライト/ノーマル/アドバンスド/リアリスティック)の器(PM1)。
// progress/play-modes-plan.md の設計どおり、モード名を直接分岐条件にせず、
// GameRulesというフラグ集合のプリセットとして持つ。
// signallingはモードとは独立した別軸(progress/signalling-plan.md)なので、
// 4プリセットとも既定値s0で揃え、playModeOfの逆引きでも無視する。

/** 電化の段階。'none'=概念なし、以降ノーマル/アドバンスド/リアリスティックの順で深くなる。 */
export type Electrification = 'none' | 'modes' | 'boundaries' | 'feeding';

/** 信号方式の段階(PM1時点ではUIから触れない独立軸。既定はs0=おまかせ)。 */
export type Signalling = 's0' | 's1' | 's2' | 's3';

export interface GameRules {
  /** 軌間の概念の有無。 */
  gauge: boolean;
  /**
   * 軌間の拡張ラインナップ(PM2、progress/play-modes-plan.md「軌間の決定事項」)。
   * false(基本、ノーマル/アドバンスド既定): 1067(狭軌)・1435(標準軌)の2種のみ。
   * true(リアリスティックのみ): 762(特殊狭軌)・1372(馬車軌間)を加えた4種。
   * gauge=falseのときは無意味(軌間概念自体が無い)。
   */
  extendedGauges: boolean;
  /** 電化の段階。 */
  electrification: Electrification;
  /** 信号方式の段階(モード非依存の別軸)。 */
  signalling: Signalling;
}

export type PlayMode = 'light' | 'normal' | 'advanced' | 'realistic';

export const PLAY_MODE_PRESETS: Record<PlayMode, GameRules> = {
  light: { gauge: false, extendedGauges: false, electrification: 'none', signalling: 's0' },
  normal: { gauge: true, extendedGauges: false, electrification: 'modes', signalling: 's0' },
  advanced: { gauge: true, extendedGauges: false, electrification: 'boundaries', signalling: 's0' },
  realistic: { gauge: true, extendedGauges: true, electrification: 'feeding', signalling: 's0' },
};

/** 新規ゲーム・旧セーブ読み込み時の既定ルール。現行仕様=ライトと定義する。 */
export const DEFAULT_GAME_RULES: GameRules = PLAY_MODE_PRESETS.light;

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  light: 'ライト',
  normal: 'ノーマル',
  advanced: 'アドバンスド',
  realistic: 'リアリスティック',
};

/**
 * ルールフラグからプレイモード名を逆引きする。signallingは独立軸のため無視し、
 * gauge/electrificationの組がどのプリセットとも一致しなければ'custom'を返す。
 */
export function playModeOf(rules: GameRules): PlayMode | 'custom' {
  const mode = (Object.keys(PLAY_MODE_PRESETS) as PlayMode[]).find(
    m =>
      PLAY_MODE_PRESETS[m].gauge === rules.gauge &&
      PLAY_MODE_PRESETS[m].extendedGauges === rules.extendedGauges &&
      PLAY_MODE_PRESETS[m].electrification === rules.electrification
  );
  return mode ?? 'custom';
}

// --- PM2: 軌間・電化の静的可否判定 ------------------------------------------------
// progress/play-modes-plan.mdの決定どおり、rules.gauge=falseのときは概念そのものが
// 「無い」ため、以下の述語はすべて無条件でtrue(=許可)を返す(挙動変更ゼロを保証する)。

import type { RailGauge, CellData, TrainPower } from '../types';
import { DEFAULT_GAUGE } from '../types';

/** セルの実効軌間。rules.gauge=falseなら概念が無いためDEFAULT_GAUGE固定。 */
export function effectiveGauge(cell: CellData | undefined, rules: GameRules): RailGauge {
  if (!rules.gauge) return DEFAULT_GAUGE;
  return cell?.gauge ?? DEFAULT_GAUGE;
}

/** 2つの軌間が接続可能か(=同一軌間か)。rules.gauge=falseなら常にtrue。 */
export function gaugesCompatible(a: RailGauge, b: RailGauge, rules: GameRules): boolean {
  if (!rules.gauge) return true;
  return a === b;
}

/**
 * セルの電化方式を正規化する('dc'|'ac'|null)。PM2以前のセーブ・'modes'段階のUIが
 * 書き込むlegacyのboolean `true`は「直流」を意味する(design decision 1)。
 * persistence.tsのdeserialiseWorldで一度正規化しているが、テスト・デバッグシナリオ等
 * 経由で正規化前のCellDataがそのまま渡ってくることもあるため、ここでも防御的に扱う。
 */
export function electrificationOf(cell: CellData | undefined): 'dc' | 'ac' | null {
  const e = cell?.electrified;
  if (e === 'ac') return 'ac';
  if (e === 'dc' || e === true) return 'dc';
  return null;
}

/** 列車がそのセルへ進入できるか(軌間+電化)。rules側の各段階に応じて短絡する。 */
export function cellAllowsTrain(
  cell: CellData | undefined,
  rules: GameRules,
  trainGauge: RailGauge,
  trainPower: TrainPower
): boolean {
  if (rules.gauge && !gaugesCompatible(effectiveGauge(cell, rules), trainGauge, rules)) return false;
  if (rules.electrification === 'none' || trainPower === 'diesel') return true;

  const system = electrificationOf(cell);
  if (!system) return false;

  // 'modes'段階はUIが'ac'を書き込まないため、trainPowerも'electric'(=直流専用)しか
  // 存在しない前提だが、念のため'boundaries'以上と同じ判定式を使い回す。
  if (trainPower === 'electric') return system === 'dc';
  if (trainPower === 'electric-ac') return system === 'ac';
  if (trainPower === 'electric-acdc') return system === 'dc' || system === 'ac';
  return false;
}

/**
 * 隣接する2セルがデッドセクション境界か(PM3)。両方が電化されており、かつ
 * 電化方式が異なる('dc'と'ac')場合にtrueを返す。片方でも非電化ならデッドセクションではない
 * (単に非電化区間との境界であり、気動車の運用は元々自由)。
 */
export function isDeadSectionBoundary(a: CellData | undefined, b: CellData | undefined): boolean {
  const sa = electrificationOf(a);
  const sb = electrificationOf(b);
  return sa !== null && sb !== null && sa !== sb;
}
