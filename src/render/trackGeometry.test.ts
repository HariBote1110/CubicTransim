import { describe, it, expect } from 'vitest';
import { DIR } from '../utils';
import {
  buildCellTrackParts, buildRampTrackParts, buildRampAbutmentPart, buildTrackCentreLines,
} from './trackGeometry';
import { rampHeightAtPos } from '../sim/trackPath';

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

describe('buildTrackCentreLines: 分岐器の中心線', () => {
  it('単線の交換設備で使う3方向分岐は、本線と分岐線の2本として組み立てる', () => {
    const routes = buildTrackCentreLines(DIR.E | DIR.W | DIR.SE);

    // 中心から3本の腕を放射状に伸ばすのではなく、直線の本線と片側から分かれる
    // 分岐線にする。これによりレールがセル中心で三重に重ならない。
    expect(routes).toHaveLength(2);
    expect(routes[0]).toHaveLength(2);
    expect(routes[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ x: -0.5, z: 0 }),
      expect.objectContaining({ x: 0.5, z: 0 }),
    ]));
    expect(routes[1][0]).toEqual(expect.objectContaining({ x: 0.5, z: 0 }));
    expect(routes[1][routes[1].length - 1]).toEqual(expect.objectContaining({ x: 0.5, z: 0.5 }));
  });
});

describe('buildRampTrackParts: 坂の線路', () => {
  it('低い側(posLow)から高い側(posHigh)へ、rampHeightAtPosの曲線に沿って登る部品を生成する', () => {
    const posLow = 0.1;
    const posHigh = 0.9;
    const parts = buildRampTrackParts(DIR.E, 0, 0, posLow, posHigh);
    expect(parts.rails.length).toBeGreaterThan(0);
    expect(parts.sleepers.length).toBeGreaterThan(0);
    expect(parts.ballast.length).toBeGreaterThan(0);

    // レール全体(複数のサブセグメント)のバウンディングボックスが
    // rampHeightAtPos(posLow)〜rampHeightAtPos(posHigh) の範囲にまたがっていること。
    const lowY = rampHeightAtPos(posLow);
    const highY = rampHeightAtPos(posHigh);
    let overallMin = Infinity;
    let overallMax = -Infinity;
    for (const rail of parts.rails) {
      rail.computeBoundingBox();
      const bb = rail.boundingBox!;
      overallMin = Math.min(overallMin, bb.min.y);
      overallMax = Math.max(overallMax, bb.max.y);
    }
    expect(overallMin).toBeLessThan(lowY + 0.2);
    expect(overallMax).toBeGreaterThan(highY - 0.2);
  });

  it('1セルを複数のサブセグメントに分割し、各分割点の高さがrampHeightAtPosに沿って単調に変化する', () => {
    const segments = 4;
    const posLow = 0;
    const posHigh = 1;
    const parts = buildRampTrackParts(DIR.E, 0, 0, posLow, posHigh, segments);

    // バラストは1セグメントにつき1つ生成されるので、分割数ぶんの本数になる。
    expect(parts.ballast.length).toBe(segments);

    // 各バラスト片の中心yが、境界側から中央側へ向けて単調に増加すること
    // (段差ではなく、rampHeightAtPosに沿った曲線として繋がっていることの確認)。
    const centres = parts.ballast.map(b => {
      b.computeBoundingBox();
      const bb = b.boundingBox!;
      return (bb.min.y + bb.max.y) / 2;
    });
    for (let i = 1; i < centres.length; i++) {
      expect(centres[i]).toBeGreaterThanOrEqual(centres[i - 1]);
    }
  });

  it('不正な方向ビット(接続ではない値)には空を返す', () => {
    const parts = buildRampTrackParts(0, 0, 0, 0, 1);
    expect(parts.rails.length).toBe(0);
  });
});

describe('buildRampAbutmentPart: 坂の橋台くさび', () => {
  it('低い側(posLow=0)で高さ0、高い側(posHigh)でrampHeightAtPos(posHigh)に達するくさび状ジオメトリを生成する', () => {
    const posHigh = 0.5;
    const geo = buildRampAbutmentPart(DIR.E, 0, 0, posHigh, 0);
    expect(geo).not.toBeNull();
    geo!.computeBoundingBox();
    const bb = geo!.boundingBox!;
    expect(bb.min.y).toBeCloseTo(0, 5);
    expect(bb.max.y).toBeCloseTo(rampHeightAtPos(posHigh), 5);
  });

  it('不正な方向ビットには null を返す', () => {
    const geo = buildRampAbutmentPart(0, 0, 0, 0.5, 0);
    expect(geo).toBeNull();
  });

  it('posHighがposLow以下なら null を返す', () => {
    const geo = buildRampAbutmentPart(DIR.E, 0, 0, 0, 0);
    expect(geo).toBeNull();
  });
});
