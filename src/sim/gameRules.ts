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
  /** 電化の段階。 */
  electrification: Electrification;
  /** 信号方式の段階(モード非依存の別軸)。 */
  signalling: Signalling;
}

export type PlayMode = 'light' | 'normal' | 'advanced' | 'realistic';

export const PLAY_MODE_PRESETS: Record<PlayMode, GameRules> = {
  light: { gauge: false, electrification: 'none', signalling: 's0' },
  normal: { gauge: true, electrification: 'modes', signalling: 's0' },
  advanced: { gauge: true, electrification: 'boundaries', signalling: 's0' },
  realistic: { gauge: true, electrification: 'feeding', signalling: 's0' },
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
    m => PLAY_MODE_PRESETS[m].gauge === rules.gauge && PLAY_MODE_PRESETS[m].electrification === rules.electrification
  );
  return mode ?? 'custom';
}
