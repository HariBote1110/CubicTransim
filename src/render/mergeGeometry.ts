import { BufferGeometry } from './geom';

/**
 * ジオメトリ配列を1つの非indexedジオメトリへマージして、元のジオメトリを破棄する。
 *
 * render/geom/ のキットは position 属性しか持たない(bakedMesh.ts が三角形ごとに
 * flat shading用の法線を計算し直すため、normal/uv は最終的な見た目に寄与しない)。
 * そのため three.js 版で必要だった「属性セットの和集合をゼロ埋めで揃える」処理は不要で、
 * 各ジオメトリを非indexedへ揃えてから position をそのまま連結するだけで足りる。
 */
export function mergeAndDispose(list: BufferGeometry[]): BufferGeometry | null {
  if (list.length === 0) return null;

  const soups = list.map(g => (g.index ? g.toNonIndexed() : g));

  let total = 0;
  for (const g of soups) total += g.positions.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const g of soups) {
    merged.set(g.positions, offset);
    offset += g.positions.length;
  }

  for (const g of list) g.dispose();
  return new BufferGeometry(merged, null);
}
