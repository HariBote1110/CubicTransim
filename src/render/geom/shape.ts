// R4e: three.js の Shape/ExtrudeGeometry(bevel無効)を代替する最小実装。
//
// 対象(tunnelPortalMeshGeometry.ts)の輪郭はいずれも「穴を持たない単一の閉じた折れ線」
// (アーチ開口は輪郭自体に切り欠きとして織り込まれている。tunnelPortalGeometry.ts の
// buildHeadwallOutline参照)なので、earcut にhole無しで渡すだけで足りる。
//
// 巻き順は入力輪郭の向きに依存させず、各三角形の法線を実測して「z=0面は-Z外向き、
// z=depth面は+Z外向き、側面は輪郭の重心から見て外向き」になるよう頂点順を選び直す
// (three.jsのExtrudeGeometryの内部巻き順アルゴリズムに依存しない、頑健な実装)。

import earcut from 'earcut';
import { BufferGeometry } from './geom';

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/** three.js Shape 互換の最小サブセット(moveTo/lineTo/closePathで折れ線を組み立てるだけ)。 */
export class Shape {
  points: Point2D[] = [];

  moveTo(x: number, y: number): this {
    this.points.push({ x, y });
    return this;
  }

  lineTo(x: number, y: number): this {
    this.points.push({ x, y });
    return this;
  }

  /** 輪郭は既に閉じた点列として扱う(始点=終点を複製しない)ので何もしない。 */
  closePath(): this {
    return this;
  }
}

type Vec3 = [number, number, number];

const faceNormal = (a: Vec3, b: Vec3, c: Vec3): Vec3 => {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
};

const pushOriented = (
  out: number[],
  a: Vec3, b: Vec3, c: Vec3,
  wantsOutward: (normal: Vec3) => boolean,
): void => {
  const n = faceNormal(a, b, c);
  const [pa, pb, pc] = wantsOutward(n) ? [a, b, c] : [a, c, b];
  out.push(...pa, ...pb, ...pc);
};

export interface ExtrudeOptions {
  depth: number;
  /** bevelは未対応(このゲームで使うのは常にfalse)。trueが来たら例外にして気づけるようにする。 */
  bevelEnabled?: boolean;
}

/**
 * 単純多角形(穴なし)をZ方向へ押し出す。z=0面が「手前」(法線-Z)、z=depth面が
 * 「奥」(法線+Z)になる(呼び出し側がtranslateで奥行き方向に配置する前提)。
 */
export class ExtrudeGeometry extends BufferGeometry {
  constructor(shape: Shape, options: ExtrudeOptions) {
    if (options.bevelEnabled) {
      throw new Error('ExtrudeGeometry: bevelEnabled は未対応です(このプロジェクトでは常にfalseで呼ぶ想定)');
    }
    const depth = options.depth;
    const points = shape.points;
    const n = points.length;
    const out: number[] = [];

    if (n >= 3) {
      const flat: number[] = [];
      for (const p of points) flat.push(p.x, p.y);
      const triangles = earcut(flat, null, 2);

      for (let i = 0; i < triangles.length; i += 3) {
        const a = points[triangles[i]], b = points[triangles[i + 1]], c = points[triangles[i + 2]];
        const front: [Vec3, Vec3, Vec3] = [[a.x, a.y, 0], [b.x, b.y, 0], [c.x, c.y, 0]];
        pushOriented(out, front[0], front[1], front[2], (nrm) => nrm[2] < 0);
        const back: [Vec3, Vec3, Vec3] = [[a.x, a.y, depth], [b.x, b.y, depth], [c.x, c.y, depth]];
        pushOriented(out, back[0], back[1], back[2], (nrm) => nrm[2] > 0);
      }

      let cx = 0, cy = 0;
      for (const p of points) { cx += p.x / n; cy += p.y / n; }
      for (let i = 0; i < n; i++) {
        const p0 = points[i], p1 = points[(i + 1) % n];
        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
        const outward = (nrm: Vec3): boolean => nrm[0] * (mx - cx) + nrm[1] * (my - cy) > 0;
        const b0: Vec3 = [p0.x, p0.y, 0], b1: Vec3 = [p1.x, p1.y, 0];
        const t0: Vec3 = [p0.x, p0.y, depth], t1: Vec3 = [p1.x, p1.y, depth];
        pushOriented(out, b0, b1, t1, outward);
        pushOriented(out, b0, t1, t0, outward);
      }
    }

    super(new Float32Array(out), null);
  }
}
