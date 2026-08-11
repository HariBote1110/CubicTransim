import { describe, it, expect } from 'vitest';
import {
  PLAY_MODE_PRESETS,
  DEFAULT_GAME_RULES,
  PLAY_MODE_LABELS,
  playModeOf,
  type GameRules,
} from './gameRules';

describe('gameRules: プレイモードのプリセットと逆引き', () => {
  it('4モードのプリセットがplay-modes-plan.mdの定義どおり', () => {
    expect(PLAY_MODE_PRESETS.light).toEqual({ gauge: false, electrification: 'none', signalling: 's0' });
    expect(PLAY_MODE_PRESETS.normal).toEqual({ gauge: true, electrification: 'modes', signalling: 's0' });
    expect(PLAY_MODE_PRESETS.advanced).toEqual({ gauge: true, electrification: 'boundaries', signalling: 's0' });
    expect(PLAY_MODE_PRESETS.realistic).toEqual({ gauge: true, electrification: 'feeding', signalling: 's0' });
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
    const custom: GameRules = { gauge: true, electrification: 'none', signalling: 's0' };
    expect(playModeOf(custom)).toBe('custom');
  });
});
