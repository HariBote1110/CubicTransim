import { describe, expect, it } from 'vitest';
import {
  computeAcceleration, applyOverspeedDecay, TRAIN_MODELS, DEFAULT_TRAIN_MODEL, trainModelOf,
  permittedSpeedKmh, brakingDistanceM, rampDecel, BRAKE_JERK_MS3,
  railWeightSpeedCapKmh, RAIL_WEIGHT_SPEED_CAP_KMH, AXLE_LOAD_T_BY_POWER,
} from './physics';

describe('computeAcceleration', () => {
  const spec = TRAIN_MODELS.commuter.spec;

  it('F/m構造: 満載時は空車より加速度が小さい(=同じ距離への到達時間が長い)', () => {
    const empty = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 0 }, 'accelerating', 20);
    const full = computeAcceleration({ spec, cars: 2, passengers: 200, speedKmh: 0 }, 'accelerating', 20);
    expect(full).toBeGreaterThan(0);
    expect(full).toBeLessThan(empty);
  });

  it('PM4: tractionFactorは牽引力(加速度)だけを弱める(既定1は無影響)', () => {
    const full = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 30 }, 'accelerating', 20);
    const defaulted = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 30 }, 'accelerating', 20, 1);
    const overloaded = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 30 }, 'accelerating', 20, 0.5);
    expect(defaulted).toBeCloseTo(full, 10);
    expect(overloaded).toBeLessThan(full);
  });

  it('PM4: tractionFactorはbraking/coastingモードには影響しない(traction only)', () => {
    const brakeNormal = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 30 }, 'braking', 20, 1);
    const brakeOverloaded = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 30 }, 'braking', 20, 0.5);
    expect(brakeOverloaded).toBe(brakeNormal);

    const coastNormal = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 30 }, 'coasting', 20, 1);
    const coastOverloaded = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 30 }, 'coasting', 20, 0.5);
    expect(coastOverloaded).toBe(coastNormal);
  });

  it('速度上昇にともなって加速度が逓減する', () => {
    const a0 = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 10 }, 'accelerating', 20);
    const a1 = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 50 }, 'accelerating', 20);
    const a2 = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 90 }, 'accelerating', 20);
    expect(a1).toBeLessThan(a0);
    expect(a2).toBeLessThan(a1);
  });

  it('ブレーキモードは一定減速度(fallback)をそのまま返す', () => {
    const decel = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 80 }, 'braking', 20);
    expect(decel).toBeCloseTo(-20 / 3.6, 5);
  });

  it('コースティングモード(PM3デッドセクション)は牽引力ゼロで転がり抵抗のみの負の加速度を返す', () => {
    const coast = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 60 }, 'coasting', 20);
    expect(coast).toBeLessThan(0);
    // 常用ブレーキ(fallbackDecelKmhS=20)より緩やか(惰行は制動よりゆっくり減速する)。
    expect(coast).toBeGreaterThan(-20 / 3.6);
  });

  it('コースティングモードは停止時(速度0)でも転がり抵抗ぶんのわずかな負の加速度のみ(急停止しない)', () => {
    const coast = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 0 }, 'coasting', 20);
    expect(coast).toBeLessThanOrEqual(0);
    expect(coast).toBeGreaterThan(-20 / 3.6); // 常用ブレーキよりずっと緩やか
  });
});

describe('applyOverspeedDecay', () => {
  it('最高速度超過時は瞬時にクランプせず現在速度の1/10ずつ落ちる', () => {
    const v = applyOverspeedDecay(200, 100, 1 / 30);
    expect(v).toBeCloseTo(180, 5);
    expect(v).toBeGreaterThan(100);
  });

  it('複数tick経過するとtargetKmhへ漸近する', () => {
    const v = applyOverspeedDecay(200, 100, 1);
    expect(v).toBeCloseTo(100, 1);
  });

  it('既にtarget以下なら変化しない', () => {
    expect(applyOverspeedDecay(80, 100, 1)).toBe(80);
  });
});

describe('permittedSpeedKmh / brakingDistanceM (ジャーク制限つき制動曲線)', () => {
  const a = 20 / 3.6; // DECEL_KMH_S=20 相当 (m/s²)
  const j = BRAKE_JERK_MS3;

  it('ジャークを無限大とみなすと従来の sqrt(2ad) に一致する', () => {
    const d = 100;
    expect(permittedSpeedKmh(d, a, 0)).toBeCloseTo(Math.sqrt(2 * a * d) * 3.6, 6);
  });

  it('ジャーク制限があると sqrt(2ad) より低い速度しか許さない(=ブレーキ開始が早まる)', () => {
    const d = 100;
    expect(permittedSpeedKmh(d, a, j)).toBeLessThan(Math.sqrt(2 * a * d) * 3.6);
  });

  it('ブレーキを込め切っている(deficit=0)なら sqrt(2ad) に戻る', () => {
    const d = 50;
    expect(permittedSpeedKmh(d, a, j, a)).toBeCloseTo(Math.sqrt(2 * a * d) * 3.6, 6);
  });

  it('距離0では速度0', () => {
    expect(permittedSpeedKmh(0, a, j)).toBe(0);
    expect(permittedSpeedKmh(-5, a, j)).toBe(0);
  });

  it('permittedSpeedKmh と brakingDistanceM は互いに逆関数になっている', () => {
    for (const d of [1, 10, 50, 200, 800]) {
      const v = permittedSpeedKmh(d, a, j);
      expect(brakingDistanceM(v, a, j)).toBeCloseTo(d, 6);
    }
  });

  it('rampDecel はジャーク上限を超えて減速度を変化させない', () => {
    const dt = 1 / 60;
    expect(rampDecel(0, a, j, dt)).toBeCloseTo(j * dt, 9);
    // 目標との差が1tickぶんの変化量以内ならぴったり目標値になる
    expect(rampDecel(a - j * dt * 0.5, a, j, dt)).toBe(a);
    // 緩解方向も同じ上限
    expect(rampDecel(a, 0, j, dt)).toBeCloseTo(a - j * dt, 9);
  });
});

describe('軌道(何キロレール): レール種別の速度上限・動力方式の軸重', () => {
  it('37kg=70km/h・50kgN=110km/h・60kg=無制限', () => {
    expect(RAIL_WEIGHT_SPEED_CAP_KMH[37]).toBe(70);
    expect(RAIL_WEIGHT_SPEED_CAP_KMH[50]).toBe(110);
    expect(RAIL_WEIGHT_SPEED_CAP_KMH[60]).toBe(Infinity);
  });

  it('railWeightSpeedCapKmhは省略時50kgN扱い', () => {
    expect(railWeightSpeedCapKmh(undefined)).toBe(110);
    expect(railWeightSpeedCapKmh(37)).toBe(70);
    expect(railWeightSpeedCapKmh(60)).toBe(Infinity);
  });

  it('動力方式ごとの軸重: diesel=14t, electric/electric-ac=12t, electric-acdc=13t', () => {
    expect(AXLE_LOAD_T_BY_POWER.diesel).toBe(14);
    expect(AXLE_LOAD_T_BY_POWER.electric).toBe(12);
    expect(AXLE_LOAD_T_BY_POWER['electric-ac']).toBe(12);
    expect(AXLE_LOAD_T_BY_POWER['electric-acdc']).toBe(13);
  });
});

describe('車種(TRAIN_MODELS): 通勤形/近郊形/特急形', () => {
  it('既定は通勤形(commuter)', () => {
    expect(DEFAULT_TRAIN_MODEL).toBe('commuter');
  });

  it('通勤形: 最高100km/h・常用減速24km/h/s', () => {
    expect(TRAIN_MODELS.commuter.maxSpeedKmh).toBe(100);
    expect(TRAIN_MODELS.commuter.serviceDecelKmhS).toBe(24);
    expect(TRAIN_MODELS.commuter.priceMultiplier).toBe(1.0);
  });

  it('近郊形: 最高120km/h・常用減速20km/h/s', () => {
    expect(TRAIN_MODELS.suburban.maxSpeedKmh).toBe(120);
    expect(TRAIN_MODELS.suburban.serviceDecelKmhS).toBe(20);
    expect(TRAIN_MODELS.suburban.priceMultiplier).toBe(1.3);
  });

  it('特急形: 最高130km/h・常用減速18km/h/s(3車種中もっとも減速が緩やか)', () => {
    expect(TRAIN_MODELS.express.maxSpeedKmh).toBe(130);
    expect(TRAIN_MODELS.express.serviceDecelKmhS).toBe(18);
    expect(TRAIN_MODELS.express.priceMultiplier).toBe(1.8);
    expect(TRAIN_MODELS.express.serviceDecelKmhS).toBeLessThan(TRAIN_MODELS.commuter.serviceDecelKmhS);
    expect(TRAIN_MODELS.express.serviceDecelKmhS).toBeLessThan(TRAIN_MODELS.suburban.serviceDecelKmhS);
  });

  it('trainModelOfはundefinedを通勤形(既定・旧セーブ互換)として解決する', () => {
    expect(trainModelOf(undefined)).toBe(TRAIN_MODELS.commuter);
    expect(trainModelOf('express')).toBe(TRAIN_MODELS.express);
  });

  it('特急形(幹線)は「特急形（幹線）」の表示名を持つ', () => {
    expect(TRAIN_MODELS.express.name).toBe('特急形（幹線）');
  });

  it('特急形(ローカル): 最高110km/h・常用減速20km/h/s・50kgレールで性能を出し切れる', () => {
    expect(TRAIN_MODELS['local-express'].name).toBe('特急形（ローカル）');
    expect(TRAIN_MODELS['local-express'].maxSpeedKmh).toBe(110);
    expect(TRAIN_MODELS['local-express'].serviceDecelKmhS).toBe(20);
    expect(TRAIN_MODELS['local-express'].spec).toEqual({ enginePower: 1700, carMassEmpty: 31, maxTractiveEffort: 300 });
    expect(TRAIN_MODELS['local-express'].priceMultiplier).toBe(1.4);
    expect(trainModelOf('local-express')).toBe(TRAIN_MODELS['local-express']);
  });

  it('TRAIN_MODELSは4車種を持つ', () => {
    expect(Object.keys(TRAIN_MODELS).sort()).toEqual(
      ['commuter', 'express', 'local-express', 'suburban'].sort(),
    );
  });
});
