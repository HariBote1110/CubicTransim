import { describe, expect, it } from 'vitest';
import {
  NOTCH_ORDER, stepNotch, notchPowerFraction, notchBrakeFraction,
  easyModeSpeedCapKmh, manualCommandedAccelMs2, equippedProtectionActive,
  classifyStopAccuracy, createManualRideTally, canManualForceEntry,
} from './manualDrive';

describe('manualDrive: ノッチの並び・遷移', () => {
  it('NOTCH_ORDERはEB(最強制動)からP5(最強力行)まで昇順に並ぶ', () => {
    expect(NOTCH_ORDER[0]).toBe('EB');
    expect(NOTCH_ORDER[NOTCH_ORDER.length - 1]).toBe('P5');
    expect(NOTCH_ORDER).toContain('N');
  });

  it('stepNotch(+1)はP5側へ、stepNotch(-1)はEB側へ1段ずつ動く', () => {
    expect(stepNotch('N', 1)).toBe('P1');
    expect(stepNotch('N', -1)).toBe('B1');
    expect(stepNotch('P4', 1)).toBe('P5');
    expect(stepNotch('B6', -1)).toBe('B7');
  });

  it('両端でクランプする(P5より強くも、EBより弱くもならない)', () => {
    expect(stepNotch('P5', 1)).toBe('P5');
    expect(stepNotch('EB', -1)).toBe('EB');
  });
});

describe('manualDrive: ノッチ→割合マッピング', () => {
  it('力行ノッチはP1=0.2〜P5=1.0の割合を返す', () => {
    expect(notchPowerFraction('P1')).toBeCloseTo(0.2);
    expect(notchPowerFraction('P5')).toBeCloseTo(1.0);
  });

  it('N・ブレーキノッチの力行割合は0', () => {
    expect(notchPowerFraction('N')).toBe(0);
    expect(notchPowerFraction('B3')).toBe(0);
    expect(notchPowerFraction('EB')).toBe(0);
  });

  it('ブレーキノッチはB1=1/7〜B7=1.0の割合を返す', () => {
    expect(notchBrakeFraction('B7')).toBeCloseTo(1.0);
    expect(notchBrakeFraction('B1')).toBeCloseTo(1 / 7);
  });

  it('N・力行ノッチの制動割合は0', () => {
    expect(notchBrakeFraction('N')).toBe(0);
    expect(notchBrakeFraction('P3')).toBe(0);
  });
});

describe('manualDrive: manualCommandedAccelMs2', () => {
  const fullAccel = 1.0;
  const serviceDecel = 5.56; // DECEL_KMH_S=20km/h/s相当
  const emergencyDecel = 9.44; // EMERGENCY_DECEL_KMH_S=34km/h/s相当

  it('P5はfullAccelMs2をそのまま返す(正の加速度)', () => {
    expect(manualCommandedAccelMs2('P5', fullAccel, serviceDecel, emergencyDecel)).toBeCloseTo(1.0);
  });

  it('P1はfullAccelMs2の20%', () => {
    expect(manualCommandedAccelMs2('P1', fullAccel, serviceDecel, emergencyDecel)).toBeCloseTo(0.2);
  });

  it('Nは0', () => {
    expect(manualCommandedAccelMs2('N', fullAccel, serviceDecel, emergencyDecel)).toBe(0);
  });

  it('B7はserviceDecelMs2の負値(常用最大)', () => {
    expect(manualCommandedAccelMs2('B7', fullAccel, serviceDecel, emergencyDecel)).toBeCloseTo(-serviceDecel);
  });

  it('B1はserviceDecelMs2の-1/7', () => {
    expect(manualCommandedAccelMs2('B1', fullAccel, serviceDecel, emergencyDecel)).toBeCloseTo(-serviceDecel / 7);
  });

  it('EBはemergencyDecelMs2の負値(常用最大より強い)', () => {
    const eb = manualCommandedAccelMs2('EB', fullAccel, serviceDecel, emergencyDecel);
    expect(eb).toBeCloseTo(-emergencyDecel);
    expect(Math.abs(eb)).toBeGreaterThan(serviceDecel);
  });
});

describe('manualDrive: かんたん(ATO)の速度キャップ', () => {
  it('P3ノッチはmaxSpeedKmhの60%をキャップとして返す', () => {
    expect(easyModeSpeedCapKmh('P3', 100)).toBeCloseTo(60);
  });

  it('P5ノッチはmaxSpeedKmhそのまま', () => {
    expect(easyModeSpeedCapKmh('P5', 100)).toBeCloseTo(100);
  });

  it('N・ブレーキ系ノッチは0(停止を指示)', () => {
    expect(easyModeSpeedCapKmh('N', 100)).toBe(0);
    expect(easyModeSpeedCapKmh('B4', 100)).toBe(0);
    expect(easyModeSpeedCapKmh('EB', 100)).toBe(0);
  });
});

describe('manualDrive: むずかしい難易度の保安装置判定', () => {
  it('ATS-P/ATC/CBTC(地上または車上のいずれか弱い方がこれ以上)ならtrue', () => {
    expect(equippedProtectionActive('ats-p', 'ats-p')).toBe(true);
    expect(equippedProtectionActive('atc', 'cbtc')).toBe(true);
    expect(equippedProtectionActive('cbtc', undefined)).toBe(false); // 弱い方はnone
  });

  it('ATS-S(警報のみ)や未装備はfalse(自動ブレーキは働かない)', () => {
    expect(equippedProtectionActive('ats-s', 'ats-s')).toBe(false);
    expect(equippedProtectionActive(undefined, 'ats-p')).toBe(false); // 弱い方はnone
    expect(equippedProtectionActive(undefined, undefined)).toBe(false);
  });
});

describe('manualDrive: 停車精度の採点', () => {
  it('ふつうは±15m以内で合格', () => {
    expect(classifyStopAccuracy(14, 'normal').withinTolerance).toBe(true);
    expect(classifyStopAccuracy(-14, 'normal').withinTolerance).toBe(true);
    expect(classifyStopAccuracy(16, 'normal').withinTolerance).toBe(false);
  });

  it('むずかしいは±5m以内で合格', () => {
    expect(classifyStopAccuracy(4.9, 'hard').withinTolerance).toBe(true);
    expect(classifyStopAccuracy(5.1, 'hard').withinTolerance).toBe(false);
  });

  it('かんたんは常に合格(失敗が存在しない)', () => {
    expect(classifyStopAccuracy(9999, 'easy').withinTolerance).toBe(true);
  });
});

describe('manualDrive: canManualForceEntry(むずかしいでの信号強行)', () => {
  it('むずかしい・無装備・力行ノッチならtrue(プレイヤーが押し切ろうとしている)', () => {
    expect(canManualForceEntry('P1', 'hard', undefined, undefined)).toBe(true);
    expect(canManualForceEntry('P1', 'hard', 'ats-s', undefined)).toBe(true);
  });

  it('保安装置が実際に有効(ATS-P以上)ならむずかしいでもfalse', () => {
    expect(canManualForceEntry('P5', 'hard', 'ats-p', 'ats-p')).toBe(false);
  });

  it('ふつう・かんたんは常にfalse(通常のensureReservationに任せる)', () => {
    expect(canManualForceEntry('P5', 'normal', undefined, undefined)).toBe(false);
    expect(canManualForceEntry('P5', 'easy', undefined, undefined)).toBe(false);
  });

  it('N・ブレーキ系ノッチは力行の意思が無いのでfalse', () => {
    expect(canManualForceEntry('N', 'hard', undefined, undefined)).toBe(false);
    expect(canManualForceEntry('B3', 'hard', undefined, undefined)).toBe(false);
    expect(canManualForceEntry('EB', 'hard', undefined, undefined)).toBe(false);
  });
});

describe('manualDrive: 乗車タリー', () => {
  it('createManualRideTallyは全項目0の初期値を返す', () => {
    const tally = createManualRideTally();
    expect(tally).toEqual({
      stops: 0, withinToleranceStops: 0, totalAbsErrorM: 0, overspeedSeconds: 0, emergencyBrakeCount: 0,
    });
  });
});
