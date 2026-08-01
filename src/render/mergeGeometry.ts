import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * ジオメトリ配列を1つにマージして、元のジオメトリを破棄する。
 *
 * three の mergeGeometries は「全てindex付き」か「全てindex無し」でないと失敗する。
 * BoxGeometry/ConeGeometry/CylinderGeometry はindex付き、
 * OctahedronGeometry/IcosahedronGeometry(多面体系)はindex無しなので、
 * 混在させると黙って null が返る。ここで必ず非index化に揃えてから合成する。
 *
 * さらに mergeGeometries は属性セットが一致しないと null を返す。Box系は
 * position/normal/uv を持つ一方、自作のBufferGeometry(坂のくさび等)は
 * position/normal だけになりがちで、同じ配列に混ぜた瞬間に部品が全部消える。
 * ここで全ジオメトリの属性の和集合を取り、欠けている属性はゼロ埋めで補って
 * から合成する(色を塗るだけのマテリアルではuv値は使われないので実害はない)。
 */
export function mergeAndDispose(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null;

  const normalised = list.map(g => {
    if (!g.index) return g;
    const n = g.toNonIndexed();
    g.dispose();
    return n;
  });

  const attributeNames = new Set<string>();
  for (const g of normalised) {
    for (const name of Object.keys(g.attributes)) attributeNames.add(name);
  }
  for (const name of attributeNames) {
    const template = normalised
      .map(g => g.getAttribute(name))
      .find((a): a is THREE.BufferAttribute => !!a);
    if (!template) continue;
    for (const g of normalised) {
      if (g.getAttribute(name)) continue;
      const count = g.getAttribute('position').count;
      g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * template.itemSize), template.itemSize));
    }
  }

  const merged = mergeGeometries(normalised, false);
  if (!merged) {
    // 属性を揃えてもなお失敗した場合は、部品が黙って全部消える前に警告を残す。
    console.warn('mergeAndDispose: mergeGeometries が null を返しました(ジオメトリの属性が非互換です)');
  }
  for (const g of normalised) g.dispose();
  return merged;
}
