// R4b: 水上橋(data.bridgeを持つ線路セルの桁+橋脚)のジオメトリ生成を
// GameScene.tsx のインラインJSXから抽出した純粋関数。
import * as THREE from './geom';
import type { CellData } from '../types';
import { fromKey } from '../utils';
import type { ShadedGeometryEntry } from './stationGeometry';

const DECK_COLOUR = '#8a7a68';
const PIER_COLOUR = '#7b6c5c';

/** railMap中のdata.bridgeセルすべての桁・橋脚ジオメトリを、ワールド座標で生成する。 */
export function buildWaterBridgeGeometries(railMap: Map<string, CellData>): ShadedGeometryEntry[] {
  const entries: ShadedGeometryEntry[] = [];
  for (const [key, data] of railMap) {
    if (!data.bridge) continue;
    const { x, z } = fromKey(key);

    const deck = new THREE.BoxGeometry(0.72, 0.12, 1.0);
    deck.translate(x, -0.03, z);
    entries.push({ geometry: deck, colour: DECK_COLOUR });

    for (const o of [-0.3, 0.3]) {
      const pier = new THREE.BoxGeometry(0.1, 0.26, 0.16);
      pier.translate(x + o, -0.18, z);
      entries.push({ geometry: pier, colour: PIER_COLOUR });
    }
  }
  return entries;
}
