// PM3(progress/play-modes-plan.md)で導入したdc/ac電化方式境界(デッドセクション)は、
// シミュレーション上は牽引力ゼロの惰行区間として存在するが、視覚的な目印が無く
// プレイヤーから見えない。ここでは「どのセルの、どの方向の辺にデッドセクション標識を
// 置くか」という純粋な配置ロジックだけを切り出す(three.js/wgpu非依存。railGeometry.tsが
// この結果を受けてジオメトリを焼く)。

import type { CellData } from '../types';
import { DIR, fromKey, toKey, getVectorFromDir, getOppositeDir } from '../utils';
import { isDeadSectionBoundary } from '../sim/gameRules';

/** デッドセクション標識1件ぶんの配置情報。(x,z)セルから見てdir方向の辺に置く。 */
export interface DeadSectionMarkerEdge {
  x: number;
  z: number;
  dir: number;
}

// 8方向のうち半分(反対向きを含まない4方向)だけを走査すれば、無向の辺1本につき
// ちょうど1回だけ検出できる(残り4方向は隣接セル側からこの4方向のいずれかとして
// 検出されるため)。catenary側のCATENARY系ロジックと同じ考え方。
const CANONICAL_DIRS = [DIR.E, DIR.SE, DIR.S, DIR.SW];

/**
 * railMap全体を走査し、実際に線路(connections)で繋がっているdc/ac電化境界の辺を
 * すべて列挙する。地平のconnectionsのみを対象とする(高架・地下のuppers境界は
 * この関数の対象外。PM3のデッドセクションは地平の`boundaries`段階の範囲で
 * 十分なため、progress/play-modes-plan.mdのフォローアップ課題として別途扱う)。
 */
export function findDeadSectionMarkerEdges(railMap: Map<string, CellData>): DeadSectionMarkerEdge[] {
  const edges: DeadSectionMarkerEdge[] = [];

  for (const [key, cell] of railMap) {
    const connections = cell.connections ?? 0;
    if (connections === 0) continue;
    const { x, z } = fromKey(key);

    for (const dir of CANONICAL_DIRS) {
      if (!(connections & dir)) continue;
      const { x: dx, z: dz } = getVectorFromDir(dir);
      const neighbour = railMap.get(toKey(x + dx, z + dz));
      if (!neighbour) continue;
      const backBit = getOppositeDir(dir);
      if (!((neighbour.connections ?? 0) & backBit)) continue;
      if (isDeadSectionBoundary(cell, neighbour)) {
        edges.push({ x, z, dir });
      }
    }
  }

  return edges;
}
