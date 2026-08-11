import { describe, it, expect } from 'vitest';
import {
  PLAY_MODE_PRESETS,
  DEFAULT_GAME_RULES,
  PLAY_MODE_LABELS,
  playModeOf,
  effectiveGauge,
  gaugesCompatible,
  cellAllowsTrain,
  type GameRules,
} from './gameRules';
import type { CellData } from '../types';

describe('gameRules: プレイモードのプリセットと逆引き', () => {
  it('4モードのプリセットがplay-modes-plan.mdの定義どおり', () => {
    expect(PLAY_MODE_PRESETS.light).toEqual({ gauge: false, extendedGauges: false, electrification: 'none', signalling: 's0' });
    expect(PLAY_MODE_PRESETS.normal).toEqual({ gauge: true, extendedGauges: false, electrification: 'modes', signalling: 's0' });
    expect(PLAY_MODE_PRESETS.advanced).toEqual({ gauge: true, extendedGauges: false, electrification: 'boundaries', signalling: 's0' });
    expect(PLAY_MODE_PRESETS.realistic).toEqual({ gauge: true, extendedGauges: true, electrification: 'feeding', signalling: 's0' });
  });

  it('DEFAULT_GAME_RULESはライトプリセットと一致する', () => {
    expect(DEFAULT_GAME_RULES).toEqual(PLAY_MODE_PRESETS.light);
  });

  it('4モードすべてに日本語表示ラベルがある', () => {
    expect(PLAY_MODE_LABELS.light).toBe('ライト');
    expect(PLAY_MODE_LABELS.normal).toBe('ノーマル');
    expect(PLAY_MODE_LABELS.advanced).toBe('アドバンスド');
    expect(PLAY_MODE_LABELS.realistic).toBe('リアリスティック');
  });

  it('playModeOfはgauge/electrificationの組がプリセットと一致すればモード名を返す', () => {
    expect(playModeOf(PLAY_MODE_PRESETS.light)).toBe('light');
    expect(playModeOf(PLAY_MODE_PRESETS.normal)).toBe('normal');
    expect(playModeOf(PLAY_MODE_PRESETS.advanced)).toBe('advanced');
    expect(playModeOf(PLAY_MODE_PRESETS.realistic)).toBe('realistic');
  });

  it('playModeOfはsignallingの値を無視する(信号は独立軸)', () => {
    const lightWithS3: GameRules = { ...PLAY_MODE_PRESETS.light, signalling: 's3' };
    expect(playModeOf(lightWithS3)).toBe('light');
  });

  it('playModeOfはどのプリセットとも一致しないフラグ組み合わせをcustomと判定する', () => {
    const custom: GameRules = { gauge: true, extendedGauges: false, electrification: 'none', signalling: 's0' };
    expect(playModeOf(custom)).toBe('custom');
  });

  it('playModeOfはextendedGaugesの差も見分ける', () => {
    const normalButExtended: GameRules = { ...PLAY_MODE_PRESETS.normal, extendedGauges: true };
    expect(playModeOf(normalButExtended)).toBe('custom');
  });
});

describe('gameRules: PM2 軌間・電化の静的可否判定', () => {
  const lightRules = PLAY_MODE_PRESETS.light;
  const normalRules = PLAY_MODE_PRESETS.normal;

  it('rules.gauge=falseなら軌間未設定セルもeffectiveGaugeはDEFAULT_GAUGE(1067)', () => {
    expect(effectiveGauge(undefined, lightRules)).toBe(1067);
    expect(effectiveGauge({ type: 'rail', gauge: 1435 } as CellData, lightRules)).toBe(1067);
  });

  it('rules.gauge=trueなら未設定は1067、設定済みはその値', () => {
    expect(effectiveGauge(undefined, normalRules)).toBe(1067);
    expect(effectiveGauge({ type: 'rail', gauge: 1435 } as CellData, normalRules)).toBe(1435);
  });

  it('rules.gauge=falseならgaugesCompatibleは常にtrue', () => {
    expect(gaugesCompatible(1067, 1435, lightRules)).toBe(true);
  });

  it('rules.gauge=trueなら同一軌間のみtrue', () => {
    expect(gaugesCompatible(1067, 1067, normalRules)).toBe(true);
    expect(gaugesCompatible(1067, 1435, normalRules)).toBe(false);
  });

  it('cellAllowsTrainはrules.gauge=falseなら軌間ミスマッチでも常に許可', () => {
    const cell: CellData = { type: 'rail', gauge: 1435 };
    expect(cellAllowsTrain(cell, lightRules, 1067, 'diesel')).toBe(true);
  });

  it('cellAllowsTrainはrules.gauge=trueなら軌間ミスマッチを拒否', () => {
    const cell: CellData = { type: 'rail', gauge: 1435 };
    expect(cellAllowsTrain(cell, normalRules, 1067, 'diesel')).toBe(false);
    expect(cellAllowsTrain(cell, normalRules, 1435, 'diesel')).toBe(true);
  });

  it('cellAllowsTrainはelectrification!==noneかつ電車には電化セルを要求する', () => {
    const bare: CellData = { type: 'rail', gauge: 1067 };
    const electrified: CellData = { type: 'rail', gauge: 1067, electrified: true };
    expect(cellAllowsTrain(bare, normalRules, 1067, 'electric')).toBe(false);
    expect(cellAllowsTrain(electrified, normalRules, 1067, 'electric')).toBe(true);
    // 気動車はどこでも走行可
    expect(cellAllowsTrain(bare, normalRules, 1067, 'diesel')).toBe(true);
  });

  it('electrification=noneなら電車でも非電化セルを走行可(概念が無いため)', () => {
    const bare: CellData = { type: 'rail', gauge: 1067 };
    expect(cellAllowsTrain(bare, lightRules, 1067, 'electric')).toBe(true);
  });
});
