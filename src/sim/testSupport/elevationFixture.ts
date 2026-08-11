// テスト専用のフィクスチャ生成ヘルパー。旧terrain.ts(P6で削除)のcomputeElevation/
// elevationAtを、min則コーナー導出(fieldFromMaps)向けの「境界からのマンハッタン距離で
// 段丘状に標高が上がる山塊」テストデータを組み立てる目的だけに残した。本番コードからは
// 参照しない(tunnel.test.ts/construction.test.tsのフィクスチャ専用)。
import type { TerrainType } from '../../types';
import { toKey, fromKey } from '../../utils';

// mountainセルの標高をこの値でクランプする(段丘の最大段数)。旧terrain.tsの
// MOUNTAIN_ELEVATION_MAXと同じ値。
const MOUNTAIN_ELEVATION_MAX = 3;

const NEIGHBOUR_OFFSETS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * mountainセルの標高を、最も近い非mountainセルまでのマンハッタン距離から決定的に導出する。
 * OpenTTD風の段丘表現のテストフィクスチャ用(標高はMOUNTAIN_ELEVATION_MAXでクランプ)。
 * 多始点BFS(全ての非mountain隣接境界を初期キューにする)でO(セル数)に計算する。
 */
export function computeElevation(terrain: Map<string, TerrainType>): Map<string, number> {
  const elevation = new Map<string, number>();
  const visited = new Set<string>();
  let frontier: string[] = [];

  // 境界セル(mountainかつ非mountain隣接を持つ)を距離1の初期フロンティアにする。
  for (const [key, type] of terrain) {
    if (type !== 'mountain') continue;
    const { x, z } = fromKey(key);
    let isBoundary = false;
    for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
      const nKey = toKey(x + dx, z + dz);
      if (terrain.get(nKey) !== 'mountain') {
        isBoundary = true;
        break;
      }
    }
    if (isBoundary) {
      elevation.set(key, 1);
      visited.add(key);
      frontier.push(key);
    }
  }

  let dist = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const key of frontier) {
      const { x, z } = fromKey(key);
      for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
        const nx = x + dx;
        const nz = z + dz;
        const nKey = toKey(nx, nz);
        if (visited.has(nKey)) continue;
        if (terrain.get(nKey) !== 'mountain') continue;
        visited.add(nKey);
        elevation.set(nKey, Math.min(dist + 1, MOUNTAIN_ELEVATION_MAX));
        next.push(nKey);
      }
    }
    frontier = next;
    dist += 1;
  }

  return elevation;
}

/** 指定座標の標高を返す。未登録セルは既定値0。 */
export function elevationAt(elevation: Map<string, number>, x: number, z: number): number {
  return elevation.get(toKey(Math.round(x), Math.round(z))) ?? 0;
}
