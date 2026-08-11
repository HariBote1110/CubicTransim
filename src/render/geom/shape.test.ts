import { describe, expect, it } from 'vitest';
import { Shape, ExtrudeGeometry } from './shape';

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

describe('Shape', () => {
  it('moveTo/lineToで頂点列を積む。closePathは点を複製しない', () => {
    const shape = new Shape();
    shape.moveTo(0, 0).lineTo(1, 0).lineTo(1, 1).lineTo(0, 1).closePath();
    expect(shape.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  });
});

describe('ExtrudeGeometry: 単純多角形(穴なし)のZ方向押し出し', () => {
  const unitSquare = (): Shape => {
    const shape = new Shape();
    shape.moveTo(0, 0).lineTo(1, 0).lineTo(1, 1).lineTo(0, 1).closePath();
    return shape;
  };

  it('単位正方形をdepth=1で押し出すと立方体(12三角形)になる', () => {
    const g = new ExtrudeGeometry(unitSquare(), { depth: 1, bevelEnabled: false });
    // 前面2 + 背面2 + 側面4辺×2 = 12三角形。
    expect(g.vertexCount / 3).toBe(12);
  });

  it('AABBが押し出し範囲と一致する', () => {
    const g = new ExtrudeGeometry(unitSquare(), { depth: 2, bevelEnabled: false });
    const { minX, minY, minZ, maxX, maxY, maxZ } = aabbOf(g.positions);
    expect([minX, minY, minZ, maxX, maxY, maxZ]).toEqual([0, 0, 0, 1, 1, 2]);
  });

  it('全ての面が固体の中心(0.5,0.5,depth/2)から見て外向き', () => {
    const depth = 1;
    const g = new ExtrudeGeometry(unitSquare(), { depth, bevelEnabled: false });
    const normals = faceNormals(g.positions);
    const centre = [0.5, 0.5, depth / 2];
    for (let i = 0; i < g.positions.length; i += 9) {
      const fx = (g.positions[i] + g.positions[i + 3] + g.positions[i + 6]) / 3;
      const fy = (g.positions[i + 1] + g.positions[i + 4] + g.positions[i + 7]) / 3;
      const fz = (g.positions[i + 2] + g.positions[i + 5] + g.positions[i + 8]) / 3;
      const n = normals[i / 9];
      const toFace = [fx - centre[0], fy - centre[1], fz - centre[2]];
      expect(n[0] * toFace[0] + n[1] * toFace[1] + n[2] * toFace[2]).toBeGreaterThan(0);
    }
  });

  it('bevelEnabled:trueは例外にする(未対応であることを明示)', () => {
    expect(() => new ExtrudeGeometry(unitSquare(), { depth: 1, bevelEnabled: true })).toThrow();
  });

  it('凹な輪郭(アーチ切り欠き相当のL字形)でも三角形の合計面積が輪郭の面積×2(前後面)+側面と一致する', () => {
    // L字(凹多角形): (0,0)-(2,0)-(2,1)-(1,1)-(1,2)-(0,2)
    const shape = new Shape();
    shape.moveTo(0, 0).lineTo(2, 0).lineTo(2, 1).lineTo(1, 1).lineTo(1, 2).lineTo(0, 2).closePath();
    const g = new ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
    // 面積(L字 = 2x2の正方形からその四半分を除いた3): 2*2 - 1*1 = 3。
    let area = 0;
    for (let i = 0; i < g.positions.length; i += 9) {
      const ax = g.positions[i], ay = g.positions[i + 1], az = g.positions[i + 2];
      const bx = g.positions[i + 3], by = g.positions[i + 4], bz = g.positions[i + 5];
      const cx = g.positions[i + 6], cy = g.positions[i + 7], cz = g.positions[i + 8];
      const e1 = [bx - ax, by - ay, bz - az];
      const e2 = [cx - ax, cy - ay, cz - az];
      const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      area += Math.hypot(cross[0], cross[1], cross[2]) / 2;
    }
    // 前面+背面 = 3*2=6、側面(輪郭6辺、外周長=2+1+1+1+1+2=8、depth=1) = 8。合計14。
    expect(area).toBeCloseTo(14, 6);
  });
});
