import { describe, expect, it } from 'vitest';
import {
  computeAcceleration, applyOverspeedDecay, TRAIN_SPECS,
  permittedSpeedKmh, brakingDistanceM, rampDecel, BRAKE_JERK_MS3,
} from './physics';

describe('computeAcceleration', () => {
  const spec = TRAIN_SPECS.commuter;

  it('F/m構造: 満載時は空車より加速度が小さい(=同じ距離への到達時間が長い)', () => {
    const empty = computeAcceleration({ spec, cars: 2, passengers: 0, speedKmh: 0 }, 'accelerating', 20);
    const full = computeAcceleration({ spec, cars: 2, passengers: 200, speedKmh: 0 }, 'accelerating', 20);
    expect(full).toBeGreaterThan(0);
    expect(full).toBeLessThan(empty);
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
