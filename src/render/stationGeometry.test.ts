import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DIR } from '../utils';
import {
  buildPlatformSideGeometries, buildStationCellGeometries, buildStationHouseGeometries,
  trackAngleFromConnections,
} from './stationGeometry';

describe('trackAngleFromConnections', () => {
  it('接続なしは南北向き(0)を返す', () => {
    expect(trackAngleFromConnections(0)).toBeCloseTo(0, 6);
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
    const oc = origin[0].geometry.boundingBox!.getCenter(new THREE.Vector3());
    const mc = moved[0].geometry.boundingBox!.getCenter(new THREE.Vector3());
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
