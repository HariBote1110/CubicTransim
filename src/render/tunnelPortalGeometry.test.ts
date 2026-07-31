import { describe, it, expect } from 'vitest';
import {
  classifyPortalCorners,
  computePortalHeadwall,
  MIN_HEADWALL_HEIGHT,
  HEADWALL_EMBED_DEPTH,
  buildArchOutline,
  buildHeadwallOutline,
  PORTAL_TOTAL_DEPTH,
} from './tunnelPortalGeometry';

describe('classifyPortalCorners', () => {
  it('北面(dz=-1)では上側2隅(左上・右上)が外側、下側2隅(右下・左下)が内側になる', () => {
    const corners: [number, number, number, number] = [10, 20, 30, 40]; // tl,tr,br,bl
    const { outer, inner } = classifyPortalCorners(corners, 0, -1);
    expect(outer.sort()).toEqual([10, 20].sort());
    expect(inner.sort()).toEqual([30, 40].sort());
  });

  it('東面(dx=1)では右側2隅(右上・右下)が外側、左側2隅(左上・左下)が内側になる', () => {
    const corners: [number, number, number, number] = [10, 20, 30, 40];
    const { outer, inner } = classifyPortalCorners(corners, 1, 0);
    expect(outer.sort()).toEqual([20, 30].sort());
    expect(inner.sort()).toEqual([10, 40].sort());
  });
});

describe('computePortalHeadwall', () => {
  it('平坦(内外標高差0)なら最低高さMIN_HEADWALL_HEIGHTになる', () => {
    const corners: [number, number, number, number] = [2, 2, 2, 2];
    const { height } = computePortalHeadwall(corners, 0, -1, 1);
    expect(height).toBe(MIN_HEADWALL_HEIGHT);
  });

  it('内側(山側)が外側より高くても、壁の高さはMIN_HEADWALL_HEIGHT固定のまま変わらない(地形は切削しないため)', () => {
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const { height } = computePortalHeadwall(corners, 0, -1, 1);
    expect(height).toBe(MIN_HEADWALL_HEIGHT);
  });

  it('overpassHeightのスケールが変わっても壁の高さはMIN_HEADWALL_HEIGHT固定のまま変わらない', () => {
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const half = computePortalHeadwall(corners, 0, -1, 0.5);
    const full = computePortalHeadwall(corners, 0, -1, 1);
    expect(half.height).toBe(MIN_HEADWALL_HEIGHT);
    expect(full.height).toBe(MIN_HEADWALL_HEIGHT);
  });

  it('outerHeightは坑口方向側(境界面)の基準標高を返す', () => {
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const { outerHeight } = computePortalHeadwall(corners, 0, -1, 1);
    expect(outerHeight).toBe(0);
  });

  it('embedDepthは斜面へめり込ませるための正の奥行きオフセットを返す(HEADWALL_EMBED_DEPTHに等しい)', () => {
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const { embedDepth } = computePortalHeadwall(corners, 0, -1, 1);
    expect(embedDepth).toBe(HEADWALL_EMBED_DEPTH);
  });
});

describe('buildArchOutline', () => {
  it('下端(y=0)の左右2点が原点に対して左右対称になる(半円が偏らない)', () => {
    const points = buildArchOutline(0.26, 0.26, 0.26, 16);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first.y).toBe(0);
    expect(last.y).toBe(0);
    expect(first.x).toBeCloseTo(-last.x, 10);
  });

  it('半円の頂点(y最大点)がx=0付近にあり、左右へ偏らない', () => {
    const points = buildArchOutline(0.26, 0.26, 0.26, 16);
    const apex = points.reduce((a, b) => (b.y > a.y ? b : a));
    expect(apex.x).toBeCloseTo(0, 5);
    expect(apex.y).toBeCloseTo(0.26 + 0.26, 5);
  });

  it('すべての頂点のy座標が0以上(地面より下に潜らない)', () => {
    const points = buildArchOutline(0.26, 0.26, 0.26, 16);
    points.forEach(p => expect(p.y).toBeGreaterThanOrEqual(-1e-9));
  });

  it('すべての頂点のx座標が[-openingHalfWidth, openingHalfWidth]の範囲に収まる(半円が片側に切れない)', () => {
    const points = buildArchOutline(0.26, 0.26, 0.26, 16);
    points.forEach(p => {
      expect(p.x).toBeGreaterThanOrEqual(-0.26 - 1e-9);
      expect(p.x).toBeLessThanOrEqual(0.26 + 1e-9);
    });
  });
});

describe('PORTAL_TOTAL_DEPTH', () => {
  it('坑口の合計奥行きがセル半幅(0.5)を超えず、隣接セルへはみ出さない', () => {
    expect(PORTAL_TOTAL_DEPTH).toBeLessThanOrEqual(0.5);
  });
});

describe('buildHeadwallOutline', () => {
  it('壁の外形が幅wallWidthいっぱいに左右対称になる(最小/最大xがwallWidth/2)', () => {
    const points = buildHeadwallOutline(1.0, 1.3, 0.26, 0.26, 0.26, 16);
    const minX = Math.min(...points.map(p => p.x));
    const maxX = Math.max(...points.map(p => p.x));
    expect(minX).toBeCloseTo(-0.5, 10);
    expect(maxX).toBeCloseTo(0.5, 10);
  });

  it('壁天端の高さがwallHeightに一致する', () => {
    const points = buildHeadwallOutline(1.0, 1.3, 0.26, 0.26, 0.26, 16);
    const maxY = Math.max(...points.map(p => p.y));
    expect(maxY).toBeCloseTo(1.3, 10);
  });

  it('開口の切り欠きがy=0(壁の足元)まで達している(浮いた開口にならない)', () => {
    const points = buildHeadwallOutline(1.0, 1.3, 0.26, 0.26, 0.26, 16);
    const zeroYPoints = points.filter(p => Math.abs(p.y) < 1e-9);
    // 壁の左右の足元2点+開口の左右の足元2点で、少なくとも4点はy=0にある。
    expect(zeroYPoints.length).toBeGreaterThanOrEqual(4);
  });
});
