import { describe, it, expect } from 'vitest';
import {
  PLAY_MODE_PRESETS,
  DEFAULT_GAME_RULES,
  PLAY_MODE_LABELS,
  playModeOf,
  effectiveGauge,
  gaugesCompatible,
  cellAllowsTrain,
  electrificationOf,
  isDeadSectionBoundary,
  effectiveRailWeight,
  axleLoadAllowed,
  effectiveRailOptions,
  type GameRules,
} from './gameRules';
import type { CellData } from '../types';
import type { RailBuildOptions } from './construction';

describe('gameRules: プレイモードのプリセットと逆引き', () => {
  it('4モードのプリセットがplay-modes-plan.mdの定義どおり', () => {
    expect(PLAY_MODE_PRESETS.light).toEqual({ gauge: false, extendedGauges: false, electrification: 'none', signalling: 's0', trackClasses: false });
    expect(PLAY_MODE_PRESETS.normal).toEqual({ gauge: true, extendedGauges: false, electrification: 'modes', signalling: 's0', trackClasses: false });
    expect(PLAY_MODE_PRESETS.advanced).toEqual({ gauge: true, extendedGauges: false, electrification: 'boundaries', signalling: 's0', trackClasses: false });
    expect(PLAY_MODE_PRESETS.realistic).toEqual({ gauge: true, extendedGauges: true, electrification: 'feeding', signalling: 's0', trackClasses: true });
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
    const custom: GameRules = { gauge: true, extendedGauges: false, electrification: 'none', signalling: 's0', trackClasses: false };
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

describe('gameRules: PM3 交直流電化', () => {
  const boundariesRules = PLAY_MODE_PRESETS.advanced; // electrification: 'boundaries'

  it('electrificationOfはlegacyのtrueをdcとして正規化する', () => {
    expect(electrificationOf({ type: 'rail', electrified: true })).toBe('dc');
    expect(electrificationOf({ type: 'rail', electrified: 'dc' })).toBe('dc');
    expect(electrificationOf({ type: 'rail', electrified: 'ac' })).toBe('ac');
    expect(electrificationOf({ type: 'rail' })).toBe(null);
    expect(electrificationOf(undefined)).toBe(null);
  });

  it('cellAllowsTrainはdc車をac区間から拒否し、ac車をdc区間から拒否する', () => {
    const dcCell: CellData = { type: 'rail', electrified: 'dc' };
    const acCell: CellData = { type: 'rail', electrified: 'ac' };
    expect(cellAllowsTrain(dcCell, boundariesRules, 1067, 'electric')).toBe(true);
    expect(cellAllowsTrain(acCell, boundariesRules, 1067, 'electric')).toBe(false);
    expect(cellAllowsTrain(acCell, boundariesRules, 1067, 'electric-ac')).toBe(true);
    expect(cellAllowsTrain(dcCell, boundariesRules, 1067, 'electric-ac')).toBe(false);
  });

  it('cellAllowsTrainはacdc車をdc/ac両方に許可する', () => {
    const dcCell: CellData = { type: 'rail', electrified: 'dc' };
    const acCell: CellData = { type: 'rail', electrified: 'ac' };
    expect(cellAllowsTrain(dcCell, boundariesRules, 1067, 'electric-acdc')).toBe(true);
    expect(cellAllowsTrain(acCell, boundariesRules, 1067, 'electric-acdc')).toBe(true);
  });

  it('気動車はboundaries段階でもどこでも走行可', () => {
    const acCell: CellData = { type: 'rail', electrified: 'ac' };
    expect(cellAllowsTrain(acCell, boundariesRules, 1067, 'diesel')).toBe(true);
  });

  it('isDeadSectionBoundaryはdc/ac隣接セルのみtrue', () => {
    const dcCell: CellData = { type: 'rail', electrified: 'dc' };
    const acCell: CellData = { type: 'rail', electrified: 'ac' };
    const bareCell: CellData = { type: 'rail' };
    expect(isDeadSectionBoundary(dcCell, acCell)).toBe(true);
    expect(isDeadSectionBoundary(dcCell, dcCell)).toBe(false);
    expect(isDeadSectionBoundary(dcCell, bareCell)).toBe(false);
    expect(isDeadSectionBoundary(bareCell, bareCell)).toBe(false);
  });
});

describe('gameRules: 軌道(何キロレール・対荷重)', () => {
  const realisticRules: GameRules = {
    gauge: true, extendedGauges: true, electrification: 'feeding', signalling: 's0', trackClasses: true,
  };
  const offRules: GameRules = {
    gauge: true, extendedGauges: false, electrification: 'feeding', signalling: 's0', trackClasses: false,
  };

  it('effectiveRailWeightはtrackClasses=falseなら常に50kgN(DEFAULT_RAIL_WEIGHT)扱い', () => {
    const cell37: CellData = { type: 'rail', railWeight: 37 };
    expect(effectiveRailWeight(cell37, offRules)).toBe(50);
    expect(effectiveRailWeight(undefined, offRules)).toBe(50);
  });

  it('effectiveRailWeightはtrackClasses=trueならセルの値、省略時は50kgN', () => {
    const cell37: CellData = { type: 'rail', railWeight: 37 };
    const bare: CellData = { type: 'rail' };
    expect(effectiveRailWeight(cell37, realisticRules)).toBe(37);
    expect(effectiveRailWeight(bare, realisticRules)).toBe(50);
  });

  it('axleLoadAllowedはtrackClasses=falseなら常にtrue', () => {
    const cell37: CellData = { type: 'rail', railWeight: 37 };
    expect(axleLoadAllowed(cell37, offRules, 20)).toBe(true);
  });

  it('axleLoadAllowedは37kgレール(上限12t)を超える軸重を拒否する', () => {
    const cell37: CellData = { type: 'rail', railWeight: 37 };
    expect(axleLoadAllowed(cell37, realisticRules, 12)).toBe(true);
    expect(axleLoadAllowed(cell37, realisticRules, 12.01)).toBe(false);
  });

  it('axleLoadAllowedは50kgNレール(上限16t)・60kgレール(無制限)を正しく判定する', () => {
    const cell50: CellData = { type: 'rail', railWeight: 50 };
    const cell60: CellData = { type: 'rail', railWeight: 60 };
    expect(axleLoadAllowed(cell50, realisticRules, 16)).toBe(true);
    expect(axleLoadAllowed(cell50, realisticRules, 16.01)).toBe(false);
    expect(axleLoadAllowed(cell60, realisticRules, 999)).toBe(true);
  });

  it('axleLoadAllowedは列車側にaxleLoadTが無ければ常にtrue', () => {
    const cell37: CellData = { type: 'rail', railWeight: 37 };
    expect(axleLoadAllowed(cell37, realisticRules, undefined)).toBe(true);
  });

  it('cellAllowsTrainは軸重超過セルを拒否する(gauge/electrificationが許可していても)', () => {
    const cell37: CellData = { type: 'rail', railWeight: 37 };
    expect(cellAllowsTrain(cell37, realisticRules, 1067, 'diesel', 14)).toBe(false);
    expect(cellAllowsTrain(cell37, realisticRules, 1067, 'diesel', 12)).toBe(true);
  });

  it('cellAllowsTrainはtrackClasses=falseなら軸重を無視する', () => {
    const cell37: CellData = { type: 'rail', railWeight: 37 };
    expect(cellAllowsTrain(cell37, offRules, 1067, 'diesel', 999)).toBe(true);
  });
});

describe('gameRules: effectiveRailOptions(H2 UI→construction境界での概念ストリップ)', () => {
  const full: RailBuildOptions = { gauge: 1435, electrified: 'ac', protection: 'cbtc', railWeight: 60 };
  // signallingはモード非依存の別軸(gameRules.ts冒頭コメント)なので、realisticプリセットに
  // s3を明示的に足したものを「全概念あり」の基準ルールとする。
  const realisticS3: GameRules = { ...PLAY_MODE_PRESETS.realistic, signalling: 's3' };

  it('全概念ありのルールではそのまま通す', () => {
    expect(effectiveRailOptions(realisticS3, full)).toEqual(full);
  });

  it('ライト(gauge無し・electrification無し・s0・trackClasses無し)はすべて剥がす', () => {
    expect(effectiveRailOptions(PLAY_MODE_PRESETS.light, full)).toEqual({});
  });

  it('gauge概念が無ければgaugeだけ剥がす', () => {
    const rules: GameRules = { ...realisticS3, gauge: false };
    expect(effectiveRailOptions(rules, full)).toEqual({ electrified: 'ac', protection: 'cbtc', railWeight: 60 });
  });

  it("electrification==='none'ならelectrifiedだけ剥がす", () => {
    const rules: GameRules = { ...realisticS3, electrification: 'none' };
    expect(effectiveRailOptions(rules, full)).toEqual({ gauge: 1435, protection: 'cbtc', railWeight: 60 });
  });

  it("signalling!=='s3'ならprotectionだけ剥がす", () => {
    const rules: GameRules = { ...realisticS3, signalling: 's2' };
    expect(effectiveRailOptions(rules, full)).toEqual({ gauge: 1435, electrified: 'ac', railWeight: 60 });
  });

  it('trackClasses=falseならrailWeightだけ剥がす', () => {
    const rules: GameRules = { ...realisticS3, trackClasses: false };
    expect(effectiveRailOptions(rules, full)).toEqual({ gauge: 1435, electrified: 'ac', protection: 'cbtc' });
  });
});
