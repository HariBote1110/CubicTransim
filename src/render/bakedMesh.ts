// R4a: 面単位ランバート陰影を頂点色へ焼き込む共有ヘルパー。
//
// wgpu 側のメッシュチャンク/インスタンス描画は「位置+頂点色」しか受け取らない
// (progress/r4-threejs-retirement-plan.md の方針3: three.js のライト・動的影は廃止し、
// ジオメトリ生成時に陰影を焼き込む)。光の向き・強さは GameScene.tsx の SunLight
// (position=[-30,34,14]、-x 側からの横光)+ hemisphereLight + ambientLight に合わせる。
//
// 色は three.js の MeshStandardMaterial と同じく「16進のsRGB値をそのまま」使い、
// 係数を掛けるだけにする(wgpu 側の地形シェーダ terrain_draw.wgsl も PALETTE の
// 16進値をそのまま書き込んでおり、両者の見た目が揃う)。

import * as THREE from './geom';

/** SunLight(GameScene.tsx)の position を正規化した光の向き。 */
export const SUN_DIRECTION: readonly [number, number, number] = (() => {
  const [x, y, z] = [-30, 34, 14];
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len] as const;
})();

/** 環境光の下限(下向きの面でも真っ黒にしない)。ambientLight intensity=0.2 相当。 */
export const AMBIENT_TERM = 0.2;
/** 半球光(上向きほど明るい)の寄与。hemisphereLight intensity=0.55 相当。 */
export const HEMISPHERE_TERM = 0.28;
/** 平行光(太陽)の寄与。directionalLight intensity=1.75 を焼き込み向けに詰めた値。 */
export const SUN_TERM = 0.55;

/**
 * 面法線 → 明るさ係数(0..1)。法線は正規化されていなくてよい。
 *
 * 焼き込み対象は箱・円錐・多面体といった閉じたローポリで、three.js のプリミティブは
 * 巻き順が揃っている(面法線=外向き)ため、面の外積をそのまま法線として使える。
 * 半球光の項があるので、太陽に背を向けた面・下向きの面でも AMBIENT_TERM 以上は残る。
 */
export const lambertFactor = (nx: number, ny: number, nz: number): number => {
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) return AMBIENT_TERM;
  const x = nx / len;
  const y = ny / len;
  const z = nz / len;
  const sun = Math.max(0, x * SUN_DIRECTION[0] + y * SUN_DIRECTION[1] + z * SUN_DIRECTION[2]);
  const hemi = 0.5 + 0.5 * y;
  return Math.min(1, AMBIENT_TERM + HEMISPHERE_TERM * hemi + SUN_TERM * sun);
};

/** RGBA(0..255)を wgpu の unorm8x4 が読むリトルエンディアン u32(0xAABBGGRR)へ詰める。 */
export const packRgba = (r: number, g: number, b: number, a: number): number => {
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  return ((c(a) << 24) | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0;
};

/** '#4f7c3a' / '4f7c3a' → [0..1, 0..1, 0..1]。 */
export const parseColourHex = (hex: string): [number, number, number] => {
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  const v = parseInt(s, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
};

export interface BakeOptions {
  /** 全体の減光(遠景フェード・焼き込み側で暗くしたいとき)。既定 1。 */
  multiplier?: number;
  /**
   * 頂点色のアルファ(既定 255)。
   * - メッシュチャンクの半透明クラスでは「不透明度」
   * - インスタンス描画では「路線色(tint)を掛ける重み」(mesh_instanced.wgsl 参照)
   */
  alpha?: number;
}

export interface ShadedVertices {
  positions: Float32Array;
  colours: Uint32Array;
}

/**
 * 非インデックス化された三角形スープ(9要素で1三角形)に、面ごとのランバート陰影を
 * 焼き込んだ頂点色を作る。位置はそのまま返す(コピーしない)。
 */
export function bakeFlatShaded(
  positions: Float32Array,
  rgb: readonly [number, number, number],
  options: BakeOptions = {},
): ShadedVertices {
  const multiplier = options.multiplier ?? 1;
  const alpha = options.alpha ?? 255;
  const triangles = Math.floor(positions.length / 9);
  const colours = new Uint32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const ax = positions[o + 3] - positions[o];
    const ay = positions[o + 4] - positions[o + 1];
    const az = positions[o + 5] - positions[o + 2];
    const bx = positions[o + 6] - positions[o];
    const by = positions[o + 7] - positions[o + 1];
    const bz = positions[o + 8] - positions[o + 2];
    const factor = lambertFactor(
      ay * bz - az * by,
      az * bx - ax * bz,
      ax * by - ay * bx,
    ) * multiplier;
    const packed = packRgba(rgb[0] * 255 * factor, rgb[1] * 255 * factor, rgb[2] * 255 * factor, alpha);
    colours[t * 3] = packed;
    colours[t * 3 + 1] = packed;
    colours[t * 3 + 2] = packed;
  }
  return { positions: triangles * 9 === positions.length ? positions : positions.subarray(0, triangles * 9), colours };
}

export interface BakedMeshChunk extends ShadedVertices {
  indices: Uint32Array;
  /** ワールド AABB `[minX,minY,minZ,maxX,maxY,maxZ]`(wgpu 側の画面空間カリングに使う)。 */
  aabb: Float32Array;
}

export interface BakeEntry {
  /** マージ済みのバケット(three.js の BufferGeometry)。null は無視する。 */
  geometry: THREE.BufferGeometry | null;
  /** バケットの基本色(PALETTE の16進値)。 */
  colour: string;
  options?: BakeOptions;
}

/**
 * 複数バケットのジオメトリを、1つのメッシュチャンク(位置+頂点色+インデックス)へ
 * 連結して焼き込む。頂点色を持つので「マテリアルごとに1メッシュ」に分ける必要が無く、
 * チャンクあたり1ドローに収まる。
 *
 * 入力ジオメトリは呼び出し側の所有物のまま(dispose しない)。
 */
export function bakeGeometries(entries: readonly BakeEntry[]): BakedMeshChunk | null {
  const parts: ShadedVertices[] = [];
  let vertexCount = 0;
  for (const entry of entries) {
    if (!entry.geometry) continue;
    // フラットシェーディングのため、共有頂点を持たない三角形スープへ展開する。
    const soup = entry.geometry.index ? entry.geometry.toNonIndexed() : entry.geometry;
    const attribute = soup.getAttribute('position');
    if (attribute) {
      const positions = new Float32Array(attribute.array as ArrayLike<number>);
      const shaded = bakeFlatShaded(positions, parseColourHex(entry.colour), entry.options);
      if (shaded.colours.length > 0) {
        parts.push(shaded);
        vertexCount += shaded.colours.length;
      }
    }
    if (soup !== entry.geometry) soup.dispose();
  }
  if (vertexCount === 0) return null;

  const positions = new Float32Array(vertexCount * 3);
  const colours = new Uint32Array(vertexCount);
  const indices = new Uint32Array(vertexCount);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let offset = 0;
  for (const part of parts) {
    positions.set(part.positions, offset * 3);
    colours.set(part.colours, offset);
    offset += part.colours.length;
  }
  for (let i = 0; i < vertexCount; i++) {
    indices[i] = i;
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    positions,
    colours,
    indices,
    aabb: new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]),
  };
}
