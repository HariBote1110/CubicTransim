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
  cellCurveHeight,
  pathHeightAt,
  curvedTrainPolyline,
  type Pt,
} from './trackPath';

describe('stepElevatedLevel: 建設レベル選択の状態遷移', () => {
  it('-MAX_ELEVATED_LEVEL(地下)〜+MAX_ELEVATED_LEVEL(高架)の範囲でクランプする', () => {
    expect(stepElevatedLevel(-MAX_ELEVATED_LEVEL as -3, -1)).toBe(-MAX_ELEVATED_LEVEL);
    expect(stepElevatedLevel(MAX_ELEVATED_LEVEL as 3, 1)).toBe(MAX_ELEVATED_LEVEL);
  });

  it('範囲内では単純に加算する(0をまたいでも特別扱いしない)', () => {
    expect(stepElevatedLevel(0, 1)).toBe(1);
    expect(stepElevatedLevel(1, 1)).toBe(2);
    expect(stepElevatedLevel(2, 1)).toBe(3);
    expect(stepElevatedLevel(2, -1)).toBe(1);
    expect(stepElevatedLevel(1, -1)).toBe(0);
    expect(stepElevatedLevel(0, -1)).toBe(-1);
    expect(stepElevatedLevel(-1, -1)).toBe(-2);
    expect(stepElevatedLevel(-2, -1)).toBe(-3);
    expect(stepElevatedLevel(-3, 1)).toBe(-2);
    expect(stepElevatedLevel(-1, 1)).toBe(0);
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

describe('cellCurveHeight/pathHeightAt: セル曲線上の高さ補間', () => {
  // 地平(0.5)→level1(0.625)→level2(1.175)の3点。rampHeightAtPosがsmoothstepのため
  // 隣接セル中心の単純平均(線形補間)とは値がずれる。emitCurveのpointAt高さ計算と
  // 同じ式であることを検証する(共通化のズレ検知)。
  const h0 = 0.5;
  const h1 = 0.5 + rampHeightAtPos(RAMP_POS_LEVEL1);
  const h2 = 0.5 + rampHeightAtPos(RAMP_POS_LEVEL2);
  const p0: Pt = { x: 0, z: 0 };
  const p1: Pt = { x: 1, z: 0 };
  const p2: Pt = { x: 2, z: 0 };
  const heightAt = (p: Pt): number => (p.x === 0 ? h0 : p.x === 1 ? h1 : h2);

  it('t=0.5(中心)では単純な端点平均(直線近似)より本来のbezier値になる', () => {
    const entry = (h0 + h1) / 2;
    const exit = (h1 + h2) / 2;
    const linearApprox = (entry + exit) / 2;
    const bezier = cellCurveHeight(p0, p1, p2, 0.5, heightAt);
    expect(Math.abs(bezier - linearApprox)).toBeGreaterThan(0.01);
    expect(bezier).toBeCloseTo(0.25 * entry + 0.5 * h1 + 0.25 * exit, 9);
  });

  it('pathHeightAtはprogress=0.5の前後で連続(境界セルどちらから計算しても同じ値)', () => {
    const nextNext: Pt = { x: 3, z: 0 };
    const heightAt2 = (p: Pt): number => {
      if (p.x === 0) return h0;
      if (p.x === 1) return h1;
      if (p.x === 2) return h2;
      return h2 + 0.1;
    };
    const fromLeft = pathHeightAt(p0, p1, p2, nextNext, 0.5, heightAt2);
    const fromRight = pathHeightAt(p0, p1, p2, nextNext, 0.5 + 1e-9, heightAt2);
    expect(fromLeft).toBeCloseTo(fromRight, 6);
  });
});

describe('curvedTrainPolyline: 直線(collinear)区間でも高さが非線形なら中間点を出す', () => {
  it('坂の直線区間(x,zは一直線だが高さはsmoothstepで非線形)で中間サンプルを含む', () => {
    // x=0(地平,0.5) - x=1(level1) - x=2(level2) - x=3(桁,1.3) が一直線に並ぶ坂。
    const h = [0.5, 0.5 + rampHeightAtPos(RAMP_POS_LEVEL1), 0.5 + rampHeightAtPos(RAMP_POS_LEVEL2), 0.5 + OVERPASS_HEIGHT];
    const cell = (i: number): Pt => ({ x: i, z: 0 });
    const heightAt = (p: Pt): number => h[p.x];

    const poly = curvedTrainPolyline({
      head: cell(2),
      grid: cell(2),
      prevGrid: cell(1),
      progress: 0,
      route: [cell(3)],
      history: [cell(2), cell(1), cell(0)],
      heightAt,
    });

    // history側でx=1のセル(prev=x0,curr=x1,next=x2)を丸ごと辿る区間に、
    // 端点2つだけでなく中間サンプルが含まれているはず。
    const interior = poly.filter(p => p.x > 0 && p.x < 1);
    // 直線区間は本来「端点1つ」で足りるが、高さが非線形なら曲線を近似するため
    // 複数サンプル(既定 samples=4 相当)が必要。1点だけでは丸みが失われる。
    expect(interior.length).toBeGreaterThan(1);

    // 中間サンプルの高さは、区間端点(entry/exit)を単純に直線補間した値とは
    // 明確にずれている(=bezierの丸みを保持している)はず。
    const entryY = (h[0] + h[1]) / 2;
    const exitY = (h[1] + h[2]) / 2;
    for (const p of interior) {
      const t = p.x - 0; // entry(x=0.5)〜exit(x=1.5)間の近似位置ではなくx自体で見る
      const linear = entryY + (exitY - entryY) * t;
      // 少なくとも1点は線形近似から十分離れていること
      if (Math.abs((p.y ?? 0) - linear) > 0.01) {
        expect(true).toBe(true);
        return;
      }
    }
    throw new Error('中間サンプルがすべて線形近似と一致してしまっている(曲線化されていない)');
  });
});
