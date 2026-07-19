import { describe, expect, it } from 'vitest';
import { computeAcceleration, applyOverspeedDecay, TRAIN_SPECS } from './physics';

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
