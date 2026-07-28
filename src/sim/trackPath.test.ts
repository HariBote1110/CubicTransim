import { describe, it, expect } from 'vitest';
import {
  smoothstep01,
  rampHeightAtPos,
  stepElevatedLevel,
  OVERPASS_HEIGHT,
  MAX_ELEVATED_LEVEL,
  RAMP_POS_GROUND,
  RAMP_POS_LEVEL1,
  RAMP_POS_LEVEL2,
  RAMP_POS_DECK,
} from './trackPath';

describe('stepElevatedLevel: 建設レベル選択の状態遷移', () => {
  it('0(地平)〜MAX_ELEVATED_LEVELの範囲でクランプする', () => {
    expect(stepElevatedLevel(0, -1)).toBe(0);
    expect(stepElevatedLevel(MAX_ELEVATED_LEVEL, 1)).toBe(MAX_ELEVATED_LEVEL);
  });

  it('範囲内では単純に加算する', () => {
    expect(stepElevatedLevel(0, 1)).toBe(1);
    expect(stepElevatedLevel(1, 1)).toBe(2);
    expect(stepElevatedLevel(2, 1)).toBe(3);
    expect(stepElevatedLevel(2, -1)).toBe(1);
    expect(stepElevatedLevel(1, -1)).toBe(0);
  });
});

describe('smoothstep01', () => {
  it('範囲外はクランプされる', () => {
    expect(smoothstep01(-1)).toBe(0);
    expect(smoothstep01(2)).toBe(1);
  });

  it('両端の傾きがほぼ0(ease-in-out)', () => {
    const eps = 1e-4;
    const slopeAtStart = (smoothstep01(eps) - smoothstep01(0)) / eps;
    const slopeAtEnd = (smoothstep01(1) - smoothstep01(1 - eps)) / eps;
    expect(Math.abs(slopeAtStart)).toBeLessThan(0.01);
    expect(Math.abs(slopeAtEnd)).toBeLessThan(0.01);
  });

  it('単調増加', () => {
    let prev = -Infinity;
    for (let x = 0; x <= 1; x += 0.05) {
      const v = smoothstep01(x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('rampHeightAtPos: 坂の高さプロファイル', () => {
  it('地平(pos=0)で高さ0、桁(pos=1)でOVERPASS_HEIGHT', () => {
    expect(rampHeightAtPos(RAMP_POS_GROUND)).toBeCloseTo(0, 6);
    expect(rampHeightAtPos(RAMP_POS_DECK)).toBeCloseTo(OVERPASS_HEIGHT, 6);
  });

  it('level1/level2の中間点も含めて単調増加(折れ角があっても値の逆転はしない)', () => {
    const positions = [RAMP_POS_GROUND, RAMP_POS_LEVEL1, RAMP_POS_LEVEL2, RAMP_POS_DECK];
    let prev = -Infinity;
    for (const p of positions) {
      const h = rampHeightAtPos(p);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  it('坂セルの中心高さは描画側の0〜0.5／0.5〜1の区間中心と一致する', () => {
    expect(RAMP_POS_LEVEL1).toBe(0.25);
    expect(RAMP_POS_LEVEL2).toBe(0.75);
  });

  it('両端付近では区間あたりの高さ変化が中間区間より小さい(急勾配で始まらない)', () => {
    const dStart = rampHeightAtPos(0.1) - rampHeightAtPos(0);
    const dMid = rampHeightAtPos(0.55) - rampHeightAtPos(0.45);
    const dEnd = rampHeightAtPos(1) - rampHeightAtPos(0.9);
    expect(dStart).toBeLessThan(dMid);
    expect(dEnd).toBeLessThan(dMid);
  });

  it('連続関数として全域で滑らか(隣接サンプル間の変化が一定の上限を超えない)', () => {
    const step = 0.01;
    let prev = rampHeightAtPos(0);
    let maxJump = 0;
    for (let p = step; p <= 1; p += step) {
      const v = rampHeightAtPos(p);
      maxJump = Math.max(maxJump, Math.abs(v - prev));
      prev = v;
    }
    expect(maxJump).toBeLessThan(OVERPASS_HEIGHT * 0.05);
  });
});
