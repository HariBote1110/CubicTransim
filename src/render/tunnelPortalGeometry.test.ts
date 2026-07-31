import { describe, it, expect } from 'vitest';
import {
  classifyPortalCorners,
  computePortalPitch,
  computePortalHeadwall,
  MIN_HEADWALL_HEIGHT,
  HEADWALL_EMBED_DEPTH,
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

describe('computePortalPitch', () => {
  it('外側(坑口方向)が低く内側(山側)が高い場合、pitchは正になる(山側へ上る傾き)', () => {
    // 北面: 外側(上2隅)標高0、内側(下2隅)標高1
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const { pitch, outerHeight } = computePortalPitch(corners, 0, -1, 1);
    expect(outerHeight).toBe(0);
    expect(pitch).toBeGreaterThan(0);
    expect(pitch).toBeCloseTo(Math.atan2(1, 1), 10);
  });

  it('外側と内側の標高が同じなら、pitchは0(平坦)になる', () => {
    const corners: [number, number, number, number] = [2, 2, 2, 2];
    const { pitch } = computePortalPitch(corners, 0, -1, 1);
    expect(pitch).toBe(0);
  });

  it('overpassHeightのスケールに応じてpitchが変わる', () => {
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const half = computePortalPitch(corners, 0, -1, 0.5);
    const full = computePortalPitch(corners, 0, -1, 1);
    expect(half.pitch).toBeLessThan(full.pitch);
  });
});

describe('computePortalHeadwall', () => {
  it('平坦(内外標高差0)なら最低高さMIN_HEADWALL_HEIGHTになる', () => {
    const corners: [number, number, number, number] = [2, 2, 2, 2];
    const { height } = computePortalHeadwall(corners, 0, -1, 1);
    expect(height).toBe(MIN_HEADWALL_HEIGHT);
  });

  it('内側(山側)が外側より高いほど、切り口を覆うために壁が高くなる', () => {
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const { height } = computePortalHeadwall(corners, 0, -1, 1);
    expect(height).toBeGreaterThan(MIN_HEADWALL_HEIGHT);
  });

  it('overpassHeightのスケールに応じて必要な高さが変わる', () => {
    const corners: [number, number, number, number] = [0, 0, 1, 1];
    const half = computePortalHeadwall(corners, 0, -1, 0.5);
    const full = computePortalHeadwall(corners, 0, -1, 1);
    expect(half.height).toBeLessThan(full.height);
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
