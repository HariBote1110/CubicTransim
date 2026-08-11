// PM4: 変電所(き電インフラ)のジオメトリ生成。車庫(depotGeometry.ts)と同じ
// 「9メッシュ程度の小さな固定形状」の方針を踏襲する。見た目は変圧器の箱+碍子3本の
// シンプルな構成で、車庫(青系)と見分けやすいよう黄系の変圧器色を使う。
import * as THREE from './geom';
import { PALETTE } from './palette';
import type { ShadedGeometryEntry } from './stationGeometry';

/** 変電所1棟ぶんを、ワールド座標(position)で配置して生成する(回転は無し、対称形状のため)。 */
export function buildSubstationGeometries(
  position: readonly [number, number, number]
): ShadedGeometryEntry[] {
  const [x, y, z] = position;
  const entries: ShadedGeometryEntry[] = [];
  const push = (geometry: THREE.BufferGeometry, colour: string) => {
    geometry.translate(x, y, z);
    entries.push({ geometry, colour });
  };

  const base = new THREE.BoxGeometry(0.9, 0.06, 0.9);
  base.translate(0, 0.03, 0);
  push(base, PALETTE.substationBody);

  const transformer = new THREE.BoxGeometry(0.55, 0.4, 0.4);
  transformer.translate(0, 0.06 + 0.2, 0);
  push(transformer, PALETTE.substationTransformer);

  for (const ix of [-0.18, 0, 0.18]) {
    const insulator = new THREE.CylinderGeometry(0.03, 0.03, 0.22, 8);
    insulator.translate(ix, 0.06 + 0.4 + 0.11, 0);
    push(insulator, PALETTE.substationInsulator);
  }

  for (const fz of [-0.45, 0.45]) {
    const fence = new THREE.BoxGeometry(0.94, 0.5, 0.04);
    fence.translate(0, 0.06 + 0.25, fz);
    push(fence, PALETTE.substationBody);
  }

  return entries;
}
