// R4e: three.js のプリミティブジオメトリ(Box/Cylinder/Cone/Circle/Icosahedron/Octahedron)を
// 代替する最小実装。bakedMesh.ts が三角形ごとにflat shading用の法線を計算し直すため、
// 全て「非indexed(共有頂点なし)の三角形スープ」として直接生成する(normal/uv属性は持たない)。
//
// 巻き順(winding)は three.js と同じ「外向き法線」になるよう、各面の頂点順を
// cross(edge1, edge2) が外向きを向く順に選んでいる(geom.test.tsの回転式と組み合わせても
// 陰影が反転しないことを前提にした設計。実際の検証は各ビルダーのテストで行う)。

import { BufferGeometry } from './geom';

const TAU = Math.PI * 2;

const pushTriangle = (
  out: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): void => {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
};

const pushQuad = (
  out: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
): void => {
  pushTriangle(out, a, b, c);
  pushTriangle(out, a, c, d);
};

/** 直方体(three.js BoxGeometryの1x1x1セグメント版と同じ寸法・巻き順)。 */
export class BoxGeometry extends BufferGeometry {
  constructor(width: number, height: number, depth: number) {
    const hw = width / 2, hh = height / 2, hd = depth / 2;
    const out: number[] = [];
    // +X
    pushQuad(out, [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd], [hw, -hh, hd]);
    // -X
    pushQuad(out, [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd], [-hw, -hh, -hd]);
    // +Y
    pushQuad(out, [-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]);
    // -Y
    pushQuad(out, [-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]);
    // +Z
    pushQuad(out, [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]);
    // -Z
    pushQuad(out, [hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]);
    super(new Float32Array(out), null);
  }
}

/**
 * 円柱/円錐(radiusTop=0でcone相当)。radialSegmentsの既定値は three.js の
 * CylinderGeometry/ConeGeometryと同じ32。
 */
export class CylinderGeometry extends BufferGeometry {
  constructor(radiusTop: number, radiusBottom: number, height: number, radialSegments = 32) {
    const hh = height / 2;
    const n = Math.max(3, Math.floor(radialSegments));
    const top: [number, number, number][] = [];
    const bottom: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * TAU;
      const cx = Math.cos(theta), sz = Math.sin(theta);
      top.push([radiusTop * cx, hh, radiusTop * sz]);
      bottom.push([radiusBottom * cx, -hh, radiusBottom * sz]);
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pushTriangle(out, bottom[i], top[i], top[j]);
      pushTriangle(out, bottom[i], top[j], bottom[j]);
    }
    if (radiusTop > 1e-8) {
      const centre: [number, number, number] = [0, hh, 0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        pushTriangle(out, centre, top[j], top[i]);
      }
    }
    if (radiusBottom > 1e-8) {
      const centre: [number, number, number] = [0, -hh, 0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        pushTriangle(out, centre, bottom[i], bottom[j]);
      }
    }
    super(new Float32Array(out), null);
  }
}

/** 円錐(three.js ConeGeometry相当。CylinderGeometryのradiusTop=0特殊形)。 */
export class ConeGeometry extends CylinderGeometry {
  constructor(radius: number, height: number, radialSegments = 32) {
    super(0, radius, height, radialSegments);
  }
}

/** XY平面上の円板(法線+Z、three.js CircleGeometryと同じ向き)。既定segmentsは32。 */
export class CircleGeometry extends BufferGeometry {
  constructor(radius: number, segments = 32) {
    const n = Math.max(3, Math.floor(segments));
    const rim: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * TAU;
      rim.push([radius * Math.cos(theta), radius * Math.sin(theta), 0]);
    }
    const centre: [number, number, number] = [0, 0, 0];
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pushTriangle(out, centre, rim[i], rim[j]);
    }
    super(new Float32Array(out), null);
  }
}

type Vec3 = [number, number, number];

const normalizeTo = (v: Vec3, radius: number): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  const s = radius / len;
  return [v[0] * s, v[1] * s, v[2] * s];
};

const midpointOnUnitSphere = (a: Vec3, b: Vec3): Vec3 =>
  normalizeTo([a[0] + b[0], a[1] + b[1], a[2] + b[2]], 1);

/**
 * 正多面体を球面上へ細分割する(three.js PolyhedronGeometryのdetail相当)。
 * detail>=1は各三角形をエッジ中点で4分割し、中点を単位球へ再投影する処理を
 * detail回繰り返す(detail=1のとき three.js の分割結果と一致する)。
 */
const subdividePolyhedron = (
  unitVertices: readonly Vec3[],
  faces: readonly [number, number, number][],
  detail: number,
  radius: number,
): Float32Array => {
  let current: [Vec3, Vec3, Vec3][] = faces.map(([ia, ib, ic]) => [unitVertices[ia], unitVertices[ib], unitVertices[ic]]);
  for (let d = 0; d < Math.max(0, Math.floor(detail)); d++) {
    const next: [Vec3, Vec3, Vec3][] = [];
    for (const [a, b, c] of current) {
      const ab = midpointOnUnitSphere(a, b);
      const bc = midpointOnUnitSphere(b, c);
      const ca = midpointOnUnitSphere(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    current = next;
  }
  const out = new Float32Array(current.length * 9);
  let o = 0;
  for (const [a, b, c] of current) {
    const pa = normalizeTo(a, radius), pb = normalizeTo(b, radius), pc = normalizeTo(c, radius);
    out[o++] = pa[0]; out[o++] = pa[1]; out[o++] = pa[2];
    out[o++] = pb[0]; out[o++] = pb[1]; out[o++] = pb[2];
    out[o++] = pc[0]; out[o++] = pc[1]; out[o++] = pc[2];
  }
  return out;
};

// three.js IcosahedronGeometry の頂点/面テーブル(黄金比の正20面体)。
const ICOSAHEDRON_T = (1 + Math.sqrt(5)) / 2;
const ICOSAHEDRON_VERTICES: Vec3[] = [
  [-1, ICOSAHEDRON_T, 0], [1, ICOSAHEDRON_T, 0], [-1, -ICOSAHEDRON_T, 0], [1, -ICOSAHEDRON_T, 0],
  [0, -1, ICOSAHEDRON_T], [0, 1, ICOSAHEDRON_T], [0, -1, -ICOSAHEDRON_T], [0, 1, -ICOSAHEDRON_T],
  [ICOSAHEDRON_T, 0, -1], [ICOSAHEDRON_T, 0, 1], [-ICOSAHEDRON_T, 0, -1], [-ICOSAHEDRON_T, 0, 1],
];
const ICOSAHEDRON_FACES: [number, number, number][] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];
const ICOSAHEDRON_UNIT: Vec3[] = ICOSAHEDRON_VERTICES.map(v => normalizeTo(v, 1));

/** 正20面体(three.js IcosahedronGeometryと同じ頂点テーブル・面構成)。 */
export class IcosahedronGeometry extends BufferGeometry {
  constructor(radius: number, detail = 0) {
    super(subdividePolyhedron(ICOSAHEDRON_UNIT, ICOSAHEDRON_FACES, detail, radius), null);
  }
}

// three.js OctahedronGeometry の頂点/面テーブル。
const OCTAHEDRON_VERTICES: Vec3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
const OCTAHEDRON_FACES: [number, number, number][] = [
  [0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2],
  [1, 2, 5], [1, 5, 3], [1, 3, 4], [1, 4, 2],
];

/** 正8面体(three.js OctahedronGeometryと同じ頂点テーブル・面構成)。 */
export class OctahedronGeometry extends BufferGeometry {
  constructor(radius: number, detail = 0) {
    super(subdividePolyhedron(OCTAHEDRON_VERTICES, OCTAHEDRON_FACES, detail, radius), null);
  }
}
