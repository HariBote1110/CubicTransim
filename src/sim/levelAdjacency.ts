// 立体交差(uppers[level])を含む線路の隣接関係を、pathfinding.ts/feeding.ts/blocks.tsの
// 3箇所で二重実装しないための共有ヘルパー。
//
// 「あるセルのある層(layer)から、直接繋がる隣接セル+層」という定義は列車の経路探索
// (pathfinding.tsのresolveEntryLayer)がすでに持っている。き電区間(feeding.ts)・
// ブロック索引(blocks.ts)はどちらも「列車が実際に走れる隣接関係」と同じ連結性で
// 連結成分を作らなければならない(でなければ「列車は繋がっていると認識するのに、
// き電区間やブロックだけ別の層で切れている」という矛盾が起きる)ため、
// この関数を経由してresolveEntryLayerと同じ規則(進入ビットで相手側の層を決める)
// を共有する。
//
// pathfinding.tsのresolveEntryLayerとの違い: あちらは「直前の走行層(prevLayer)」を
// 使って複数候補(立体交差の真上/真下に別の層が重なっている場合)を1つに絞る
// (方向つき探索なので一意な次状態が要る)。feeding/blocksは向きを持たない静的な
// 連結成分分割なので絞り込みは不要で、候補全部をエッジとして扱ってよい
// (どの候補も「列車がその層で入場できる」という点では対等)。
import type { CellData, Level } from '../types';
import { toKey, DIR, getOppositeDir } from '../utils';

/** 0=地平、それ以外はLevel(-3..-1, 1..3)。 */
export type Layer = number;

export const ADJACENCY_DIRS = [
  { x: 0, z: -1, dir: DIR.N }, { x: 1, z: -1, dir: DIR.NE },
  { x: 1, z: 0, dir: DIR.E }, { x: 1, z: 1, dir: DIR.SE },
  { x: 0, z: 1, dir: DIR.S }, { x: -1, z: 1, dir: DIR.SW },
  { x: -1, z: 0, dir: DIR.W }, { x: -1, z: -1, dir: DIR.NW },
] as const;

/** あるセルの、指定した層で出られる方向のconnectionsビット集合。 */
export const activeConnections = (cell: CellData | undefined, layer: Layer): number =>
  layer === 0 ? (cell?.connections ?? 0) : (cell?.uppers?.[layer as Level]?.connections ?? 0);

const UPPER_LEVELS = [1, 2, 3, -1, -2, -3] as const;

/**
 * enterBit(進入元へ戻る方向ビット)を受け付ける層の一覧。地平(0)を先頭に、
 * 高架(1..3)・地下(-1..-3)の順で候補を返す。候補が複数あるのは立体交差の
 * 真上/真下に別の層の坂・桁が重なっている場合(pathfinding.ts resolveEntryLayer
 * のコメント参照)。
 */
export const entryLayerCandidates = (cell: CellData | undefined, enterBit: number): Layer[] => {
  const candidates: Layer[] = [];
  if (cell?.connections && (cell.connections & enterBit)) candidates.push(0);
  for (const lvl of UPPER_LEVELS) {
    const u = cell?.uppers?.[lvl];
    if (u?.connections && (u.connections & enterBit)) candidates.push(lvl);
  }
  return candidates;
};

/**
 * (x,z,layer)から、そのセルのその層のconnectionsで直接繋がる隣接セル+層の一覧
 * (=列車がそこから直接移動できる状態)。無向な連結成分分割(feeding/blocks)に使う。
 */
export function neighboursAtLayer(
  railMap: Map<string, CellData>,
  x: number,
  z: number,
  layer: Layer
): { x: number; z: number; layer: Layer }[] {
  const cell = railMap.get(toKey(x, z));
  const connections = activeConnections(cell, layer);
  if (connections === 0) return [];
  const result: { x: number; z: number; layer: Layer }[] = [];
  for (const d of ADJACENCY_DIRS) {
    if ((connections & d.dir) === 0) continue;
    const nx = x + d.x;
    const nz = z + d.z;
    const nCell = railMap.get(toKey(nx, nz));
    const enterBit = getOppositeDir(d.dir);
    for (const l of entryLayerCandidates(nCell, enterBit)) {
      result.push({ x: nx, z: nz, layer: l });
    }
  }
  return result;
}

/** layer!==0のときの索引キー接尾辞。既存の予約キー`x,z:uN`と同じ規約に合わせる。 */
export const layerKey = (x: number, z: number, layer: Layer): string =>
  layer === 0 ? toKey(x, z) : `${toKey(x, z)}:u${layer}`;
