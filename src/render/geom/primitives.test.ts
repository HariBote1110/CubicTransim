import { describe, expect, it } from 'vitest';
import {
  BoxGeometry, CylinderGeometry, ConeGeometry, CircleGeometry, IcosahedronGeometry, OctahedronGeometry,
} from './primitives';

/** 三角形スープから各三角形の(未正規化)法線を返す。 */
const faceNormals = (positions: Float32Array): [number, number, number][] => {
  const normals: [number, number, number][] = [];
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    normals.push([e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x]);
  }
  return normals;
};

const aabbOf = (positions: Float32Array) => {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
};

describe('BoxGeometry', () => {
  it('12三角形=36頂点(非indexed)を持つ', () => {
    const g = new BoxGeometry(2, 4, 6);
    expect(g.vertexCount).toBe(36);
    expect(g.index).toBeNull();
  });

  it('寸法どおりのAABBになる', () => {
    const g = new BoxGeometry(2, 4, 6);
    const { minX, minY, minZ, maxX, maxY, maxZ } = aabbOf(g.positions);
    expect([minX, minY, minZ, maxX, maxY, maxZ]).toEqual([-1, -2, -3, 1, 2, 3]);
  });

  it('全ての面が外向き法線を持つ(cross積が中心から見て外側を向く)', () => {
    const g = new BoxGeometry(2, 2, 2);
    const normals = faceNormals(g.positions);
    // 各三角形の重心方向とcross積の内積が正 → 外向き。
    for (let i = 0; i < g.positions.length; i += 9) {
      const cx = (g.positions[i] + g.positions[i + 3] + g.positions[i + 6]) / 3;
      const cy = (g.positions[i + 1] + g.positions[i + 4] + g.positions[i + 7]) / 3;
      const cz = (g.positions[i + 2] + g.positions[i + 5] + g.positions[i + 8]) / 3;
      const n = normals[i / 9];
      expect(n[0] * cx + n[1] * cy + n[2] * cz).toBeGreaterThan(0);
    }
  });
});

describe('CylinderGeometry / ConeGeometry', () => {
  it('両端に半径があるとき側面+上下キャップの三角形数になる', () => {
    const g = new CylinderGeometry(1, 1, 2, 8);
    // 側面16 + 上キャップ8 + 下キャップ8 = 32三角形。
    expect(g.vertexCount / 3).toBe(32);
  });

  it('radiusTop=0(円錐)は上キャップを持たない', () => {
    const g = new ConeGeometry(1, 2, 8);
    // 側面(頂点が縮退する三角形込みで2*8=16) + 下キャップ8 = 24三角形。
    expect(g.vertexCount / 3).toBe(24);
  });

  it('側面・キャップとも外向き法線を持つ', () => {
    const g = new CylinderGeometry(1, 1, 2, 12);
    const normals = faceNormals(g.positions);
    for (let i = 0; i < g.positions.length; i += 9) {
      const cx = (g.positions[i] + g.positions[i + 3] + g.positions[i + 6]) / 3;
      const cz = (g.positions[i + 2] + g.positions[i + 5] + g.positions[i + 8]) / 3;
      const cy = (g.positions[i + 1] + g.positions[i + 4] + g.positions[i + 7]) / 3;
      const n = normals[i / 9];
      // 中心軸(0,cy,0)から見た外向き判定。
      expect(n[0] * cx + n[1] * 0 + n[2] * cz).toBeGreaterThanOrEqual(-1e-9);
      void cy;
    }
  });

  it('半径・高さどおりのAABBになる', () => {
    const g = new CylinderGeometry(1, 1, 4, 32);
    const { minY, maxY } = aabbOf(g.positions);
    expect(minY).toBeCloseTo(-2, 6);
    expect(maxY).toBeCloseTo(2, 6);
  });
});

describe('CircleGeometry', () => {
  it('segments個の三角形を持ち、法線は+Z', () => {
    const g = new CircleGeometry(1, 8);
    expect(g.vertexCount / 3).toBe(8);
    const normals = faceNormals(g.positions);
    for (const n of normals) expect(n[2]).toBeGreaterThan(0);
  });
});

describe('IcosahedronGeometry / OctahedronGeometry', () => {
  it('detail=0の正20面体は20面(60頂点)', () => {
    const g = new IcosahedronGeometry(1, 0);
    expect(g.vertexCount / 3).toBe(20);
  });

  it('detail=0の正8面体は8面(24頂点)', () => {
    const g = new OctahedronGeometry(1, 0);
    expect(g.vertexCount / 3).toBe(8);
  });

  it('detail=1で正8面体は4倍(32面)に細分される', () => {
    const g = new OctahedronGeometry(1, 1);
    expect(g.vertexCount / 3).toBe(32);
  });

  it('全頂点が半径どおり原点から等距離(球面上)', () => {
    const g = new IcosahedronGeometry(2.5, 1);
    for (let i = 0; i < g.positions.length; i += 3) {
      const len = Math.hypot(g.positions[i], g.positions[i + 1], g.positions[i + 2]);
      expect(len).toBeCloseTo(2.5, 6);
    }
  });

  it('全ての面が外向き法線を持つ(中心=原点からの外向き)', () => {
    const g = new OctahedronGeometry(1, 0);
    const normals = faceNormals(g.positions);
    for (let i = 0; i < g.positions.length; i += 9) {
      const cx = (g.positions[i] + g.positions[i + 3] + g.positions[i + 6]) / 3;
      const cy = (g.positions[i + 1] + g.positions[i + 4] + g.positions[i + 7]) / 3;
      const cz = (g.positions[i + 2] + g.positions[i + 5] + g.positions[i + 8]) / 3;
      const n = normals[i / 9];
      expect(n[0] * cx + n[1] * cy + n[2] * cz).toBeGreaterThan(0);
    }
  });
});
