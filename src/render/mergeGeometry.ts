import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * ジオメトリ配列を1つにマージして、元のジオメトリを破棄する。
 *
 * three の mergeGeometries は「全てindex付き」か「全てindex無し」でないと失敗する。
 * BoxGeometry/ConeGeometry/CylinderGeometry はindex付き、
 * OctahedronGeometry/IcosahedronGeometry(多面体系)はindex無しなので、
 * 混在させると黙って null が返る。ここで必ず非index化に揃えてから合成する。
 */
export function mergeAndDispose(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null;

  const normalised = list.map(g => {
    if (!g.index) return g;
    const n = g.toNonIndexed();
    g.dispose();
    return n;
  });

  const merged = mergeGeometries(normalised, false);
  for (const g of normalised) g.dispose();
  return merged;
}
