import { describe, it, expect } from 'vitest';
import { DIR } from '../utils';
import { buildCellTrackParts, buildRampTrackParts, buildRampAbutmentPart } from './trackGeometry';

describe('buildCellTrackParts: connections が 0 のセル', () => {
  it('何も生成しない(applyBridgeが作る「地平connectionsが0の橋桁下セル」に幽霊の線路を描かせないため)', () => {
    const parts = buildCellTrackParts(0);
    expect(parts.ballast.length).toBe(0);
    expect(parts.sleepers.length).toBe(0);
    expect(parts.rails.length).toBe(0);
  });
});

describe('buildCellTrackParts: 通常の接続', () => {
  it('直線(N|S)は従来どおりレール・枕木・バラストを生成する', () => {
    const parts = buildCellTrackParts(DIR.N | DIR.S);
    expect(parts.rails.length).toBeGreaterThan(0);
    expect(parts.sleepers.length).toBeGreaterThan(0);
    expect(parts.ballast.length).toBeGreaterThan(0);
  });
});

describe('buildRampTrackParts: 坂の線路', () => {
  it('低い側(originY=0)から高い側(rampHeight)へ登る部品を生成する', () => {
    const parts = buildRampTrackParts(DIR.E, 0, 0, 1.2);
    expect(parts.rails.length).toBeGreaterThan(0);
    expect(parts.sleepers.length).toBeGreaterThan(0);
    expect(parts.ballast.length).toBeGreaterThan(0);

    // レールのバウンディングボックスが 0〜rampHeight の範囲にまたがっていること
    for (const rail of parts.rails) {
      rail.computeBoundingBox();
      const bb = rail.boundingBox!;
      expect(bb.min.y).toBeLessThan(0.1);
      expect(bb.max.y).toBeGreaterThan(1.0);
    }
  });

  it('不正な方向ビット(接続ではない値)には空を返す', () => {
    const parts = buildRampTrackParts(0, 0, 0, 1.2);
    expect(parts.rails.length).toBe(0);
  });
});

describe('buildRampAbutmentPart: 坂の橋台くさび', () => {
  it('低い側で高さ0、高い側でrampHeightに達するくさび状ジオメトリを生成する', () => {
    const geo = buildRampAbutmentPart(DIR.E, 0, 0, 1.2);
    expect(geo).not.toBeNull();
    geo!.computeBoundingBox();
    const bb = geo!.boundingBox!;
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(1.2, 5);
  });

  it('不正な方向ビットには null を返す', () => {
    const geo = buildRampAbutmentPart(0, 0, 0, 1.2);
    expect(geo).toBeNull();
  });
});
