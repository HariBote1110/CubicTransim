// R4f(Phase A): 列車の見た目を「宣言的パーツ配列」として持ち、外観エディタ(Phase B)から
// JSONとして読み書きできるようにする。trainMeshBuilder.ts の MODEL_VISUALS/buildCarEntries が
// 手続き的に組んでいた car_head/car_mid のジオメトリを、TrainPart[] というプレーンデータ
// (プリミティブのみ・関数を持たない)へ落とし込む。progress/train-model-format.md の
// 寸法制約(全長<=0.92, 全幅<=0.50, 全高<=0.60, +Z=顔)を単位系として踏襲する。

import * as THREE from './geom';

export type TrainPartKind = 'box' | 'wedge' | 'cylinder' | 'cone';

export interface TrainPart {
  kind: TrainPartKind;
  /**
   * kindごとの意味:
   * - box:      [幅(X), 高さ(Y), 奥行き(Z)]
   * - wedge:    [幅(X), 高さ(Y), 奥行き(Z)] (下記 buildWedgeGeometry の意味論を参照)
   * - cylinder: [radiusTop, height, radiusBottom]
   * - cone:     [radius, height, 未使用(0)]  (radiusTop=0のcylinder相当)
   */
  size: [number, number, number];
  /** ローカル原点からの平行移動(X, Y, Z)。回転を適用したあとに加える。 */
  pos: [number, number, number];
  /** オイラー角(ラジアン)。X→Y→Zの順に適用する。省略時は無回転。 */
  rot?: [number, number, number];
  /** '#rrggbb'。bakedMesh.ts の parseColourHex がそのまま読む。 */
  colour: string;
  /** true: 路線色で塗り替える(alpha=255)。省略時は false(焼き込んだ色のまま、alpha=0)。 */
  tint?: boolean;
  /** エディタ表示用のパーツ名(任意)。ジオメトリ生成には影響しない。 */
  label?: string;
}

/** 1両ぶんのパーツ構成。head/tailは同じ head を呼び出し側が180°回転して流用する規約。 */
export interface TrainCarParts {
  head: TrainPart[];
  mid: TrainPart[];
}

/**
 * wedge(流線形の鼻先)の意味論。
 *
 * ローカル座標: X∈[-w/2, w/2], Z∈[-d/2(後端), d/2(前端)]。
 * - 後端(Z=-d/2)は幅w×高さhの矩形断面(Y∈[-h/2, h/2])。
 * - 前端(Z=d/2)は「低い前端エッジ」— 幅wのまま、上面と下面がY=-h/2の1本の辺に収束する。
 * - 底面(Y=-h/2)は後端から前端まで平坦。
 * - 上面は後端の+h/2から前端の-h/2まで滑らかに一枚の面で傾斜する。
 *
 * これにより「上から見た輪郭は矩形のまま、横から見ると三角形に尖る」楔形になり、
 * express(E657/E353系風)の流線形ノーズを1パーツで再現できる。
 */
function buildWedgeGeometry(width: number, height: number, depth: number): THREE.BufferGeometry {
  const hw = width / 2, hh = height / 2, hd = depth / 2;
  const rb0: [number, number, number] = [-hw, -hh, -hd];
  const rb1: [number, number, number] = [hw, -hh, -hd];
  const rt0: [number, number, number] = [-hw, hh, -hd];
  const rt1: [number, number, number] = [hw, hh, -hd];
  const fb0: [number, number, number] = [-hw, -hh, hd];
  const fb1: [number, number, number] = [hw, -hh, hd];

  const out: number[] = [];
  const tri = (a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): void => {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  const quad = (
    a: readonly [number, number, number], b: readonly [number, number, number],
    c: readonly [number, number, number], d: readonly [number, number, number],
  ): void => {
    tri(a, b, c);
    tri(a, c, d);
  };

  quad(rb0, rb1, fb1, fb0); // 底面(平坦、外向き-Y)
  quad(rt0, fb0, fb1, rt1); // 上面(傾斜、外向き+Y寄り+Z)
  quad(rb1, rb0, rt0, rt1); // 後端(外向き-Z)
  tri(rb0, fb0, rt0); // 左側面(外向き-X)
  tri(rb1, rt1, fb1); // 右側面(外向き+X)
  // 前端は幅wのまま上下が1本の辺に収束するため面積0(明示的な面は不要)。

  return new THREE.BufferGeometry(new Float32Array(out), null);
}

/** 1パーツぶんのジオメトリを組み立てる(純関数。pos/rotを適用済みで返す)。 */
export function buildPartGeometry(part: TrainPart): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry;
  switch (part.kind) {
    case 'box': {
      const [sx, sy, sz] = part.size;
      geometry = new THREE.BoxGeometry(sx, sy, sz);
      break;
    }
    case 'wedge': {
      const [w, h, d] = part.size;
      geometry = buildWedgeGeometry(w, h, d);
      break;
    }
    case 'cylinder': {
      const [radiusTop, height, radiusBottom] = part.size;
      geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height);
      break;
    }
    case 'cone': {
      const [radius, height] = part.size;
      geometry = new THREE.ConeGeometry(radius, height);
      break;
    }
  }
  const [rx, ry, rz] = part.rot ?? [0, 0, 0];
  if (rx) geometry.rotateX(rx);
  if (ry) geometry.rotateY(ry);
  if (rz) geometry.rotateZ(rz);
  const [tx, ty, tz] = part.pos;
  geometry.translate(tx, ty, tz);
  return geometry;
}

// progress/train-model-format.md の寸法制約(1車両ぶん)。
const LENGTH_LIMIT = 0.92;
const WIDTH_LIMIT = 0.50;
const HEIGHT_LIMIT = 0.60;

/**
 * パーツ配列全体のバウンディングボックスを寸法制約と照合し、日本語の警告文を返す
 * (空配列 = 問題なし)。編集中のプレビュー(Phase Bのエディタ)からそのまま呼べるよう、
 * 個々のパーツではなく組み立て後のAABBで判定する。
 */
export function validateParts(parts: TrainPart[]): string[] {
  const warnings: string[] = [];
  if (parts.length === 0) return warnings;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const part of parts) {
    const g = buildPartGeometry(part);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    minX = Math.min(minX, bb.min.x);
    minY = Math.min(minY, bb.min.y);
    minZ = Math.min(minZ, bb.min.z);
    maxX = Math.max(maxX, bb.max.x);
    maxY = Math.max(maxY, bb.max.y);
    maxZ = Math.max(maxZ, bb.max.z);
  }

  const width = maxX - minX;
  const length = maxZ - minZ;
  if (width > WIDTH_LIMIT) warnings.push(`全幅が上限(${WIDTH_LIMIT})を超えています: ${width.toFixed(3)}`);
  if (length > LENGTH_LIMIT) warnings.push(`全長が上限(${LENGTH_LIMIT})を超えています: ${length.toFixed(3)}`);
  if (maxY > HEIGHT_LIMIT) warnings.push(`上端が上限(${HEIGHT_LIMIT})を超えています: ${maxY.toFixed(3)}`);
  if (minY < -HEIGHT_LIMIT) warnings.push(`下端が下限(${-HEIGHT_LIMIT})を下回っています: ${minY.toFixed(3)}`);
  return warnings;
}
