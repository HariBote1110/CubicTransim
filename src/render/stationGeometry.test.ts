import { describe, it, expect } from 'vitest';
import { DIR } from '../utils';
import {
  buildPlatformSideGeometries, buildStationCellGeometries, buildStationHouseGeometries,
  trackAngleFromConnections,
} from './stationGeometry';

describe('trackAngleFromConnections', () => {
  it('接続なしは南北向き(0)を返す', () => {
    expect(trackAngleFromConnections(0)).toBeCloseTo(0, 6);
  });

  it('東西の通り抜け(E|W)は東西向き(π/2)を返す', () => {
    expect(trackAngleFromConnections(DIR.E | DIR.W)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('南北の通り抜け(N|S)は南北向き(π)を返す', () => {
    expect(trackAngleFromConnections(DIR.N | DIR.S)).toBeCloseTo(Math.PI, 6);
  });

  // レンダー側の頑健化: カーブ・接合部や旧セーブの混在ビットで、対向する2方向が
  // 両方立った「通り抜けの直線」があれば、単独ビットより優先してその軸を採る。
  it('東西の通り抜けに単独の北ビットが混ざっていても東西向きを優先する', () => {
    expect(trackAngleFromConnections(DIR.E | DIR.W | DIR.N)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('通り抜けが無い単独ビットのみの場合は従来通りその方向を返す(カーブ等)', () => {
    expect(trackAngleFromConnections(DIR.N | DIR.E)).toBeCloseTo(Math.PI, 6);
  });
});

describe('buildPlatformSideGeometries', () => {
  it('ホームドアなし(none)は5パーツ(床・側壁・点字・上屋・柱1本)を生成する', () => {
    const entries = buildPlatformSideGeometries(1, 'none', false);
    expect(entries).toHaveLength(5);
    expect(entries.filter(e => e.translucent)).toHaveLength(0);
  });

  it('端セル(isEnd)は柱が2本になる', () => {
    const notEnd = buildPlatformSideGeometries(1, 'none', false);
    const end = buildPlatformSideGeometries(1, 'none', true);
    expect(end.length).toBe(notEnd.length + 1);
  });

  it('ホームドアありは2箇所×(扉+ガラス)=4パーツ追加され、ガラスはtranslucent', () => {
    const entries = buildPlatformSideGeometries(1, 'standard', false);
    const glass = entries.filter(e => e.translucent);
    expect(glass).toHaveLength(2);
  });
});

describe('buildStationCellGeometries', () => {
  it('両側ぶん(side=1,-1)を合成するので単側の2倍のパーツ数になる', () => {
    const oneSide = buildPlatformSideGeometries(1, 'standard', true);
    const both = buildStationCellGeometries([0, 0, 0], DIR.N | DIR.S, 'standard', true);
    expect(both).toHaveLength(oneSide.length * 2);
  });

  it('positionぶんワールド座標へ平行移動される(AABBの中心がずれる)', () => {
    const origin = buildStationCellGeometries([0, 0, 0], DIR.N | DIR.S, 'none', false);
    const moved = buildStationCellGeometries([5, 1, -3], DIR.N | DIR.S, 'none', false);
    origin[0].geometry.computeBoundingBox();
    moved[0].geometry.computeBoundingBox();
    const centreOf = (box: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) => ({
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2,
      z: (box.min.z + box.max.z) / 2,
    });
    const oc = centreOf(origin[0].geometry.boundingBox!);
    const mc = centreOf(moved[0].geometry.boundingBox!);
    expect(mc.x - oc.x).toBeCloseTo(5, 5);
    expect(mc.y - oc.y).toBeCloseTo(1, 5);
    expect(mc.z - oc.z).toBeCloseTo(-3, 5);
  });
});

describe('buildStationHouseGeometries', () => {
  it('本体・屋根・入口の3パーツを生成する', () => {
    const entries = buildStationHouseGeometries([0, 0, 0], 0);
    expect(entries).toHaveLength(3);
  });
});
