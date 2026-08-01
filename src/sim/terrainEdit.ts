// OpenTTD風の地形編集(盛土/切土)。純粋関数のみ。React/THREE には依存しない。
//
// applyTerrainEditが選択セルを±1段した上で、1-Lipschitz(4近傍の段差1以下)を
// 「方向つき伝播」で回復する: 盛土は隣接セルを必要なだけ引き上げ(BFS)、切土は
// 必要なだけ引き下げる。terrain.tsのnormaliseHeights(引き下げのみのチャンファー変換)を
// 盛土に流用すると、盛った当のセルが引き下げられて編集が消えてしまうため使わない。
//
// ブロック規則: 影響セル(伝播で動くセルを含む)のどれかが
//   - railMapに存在する(線路・駅・車庫・信号。高架桁だけのセルも安全側でブロック)
//   - 水域(waterは常に標高0。盛土も切土も不可)
//   - 町タイル(家・道路)
//   - 範囲外(TERRAIN_COORD_RANGE。範囲外は標高0の固定点なので、伝播が及ぶ場合も不可)
// なら、編集全体をno-op(同一参照を返す)にする。部分適用はしない。
//
// 地形種別の不変条件: 編集後も「water以外のセルは mountain ⟺ 標高>=MOUNTAIN_HEIGHT_THRESHOLD」
// を保つ(町・建設ロジックがこの不変条件に依存している)。
import type { CellData, TerrainType } from '../types';
import type { TownTileIndex } from './townTiles';
import { toKey, fromKey } from '../utils';
import {
  TERRAIN_COORD_RANGE,
  TERRAIN_HEIGHT_MAX,
  MOUNTAIN_HEIGHT_THRESHOLD,
} from './terrain';

export type TerrainEditMode = 'raise' | 'lower';

export interface Pos {
  x: number;
  z: number;
}

export interface TerrainEditResult {
  /** 編集後の標高。no-opのときは入力と同一参照。 */
  heights: Map<string, number>;
  /** 編集後の地形種別。変化が無ければ入力と同一参照。 */
  terrain: Map<string, TerrainType>;
  /** 標高が変化したセルのキー。1回の編集で各セルの変化は常に±1段なので、この件数=総段数。 */
  changedCells: string[];
}

const NEIGHBOUR_OFFSETS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 対角2点が囲む矩形内の全セルを返す(OpenTTD風の矩形ドラッグ選択)。
 * 座標の大小順によらず、x昇順→z昇順で列挙する。
 */
export function rectCells(a: Pos, b: Pos): Pos[] {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const z0 = Math.min(a.z, b.z);
  const z1 = Math.max(a.z, b.z);
  const cells: Pos[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      cells.push({ x, z });
    }
  }
  return cells;
}

/**
 * 選択セルを1段盛土(raise)/切土(lower)し、段差1以下を伝播で回復した結果を返す。
 * ブロック規則に抵触する場合・何も変化しない場合は入力と同一参照のno-opを返す。
 */
export function applyTerrainEdit(
  heights: Map<string, number>,
  terrain: Map<string, TerrainType>,
  railMap: Map<string, CellData>,
  townTiles: TownTileIndex,
  cells: Pos[],
  mode: TerrainEditMode,
  range: number = TERRAIN_COORD_RANGE
): TerrainEditResult {
  const noop: TerrainEditResult = { heights, terrain, changedCells: [] };
  if (cells.length === 0) return noop;

  const inRange = (x: number, z: number): boolean =>
    x >= -range && x <= range && z >= -range && z <= range;

  // 影響セルが編集を受け入れられるか。範囲外・水域・建設物・町タイルは不可。
  const isBlocked = (key: string, x: number, z: number): boolean =>
    !inRange(x, z) || terrain.get(key) === 'water' || railMap.has(key) || townTiles.has(key);

  // 編集途中の標高のオーバーレイ。確定するまで元のheightsは触らない。
  const updated = new Map<string, number>();
  const heightAt = (key: string): number => updated.get(key) ?? heights.get(key) ?? 0;

  // 1. 選択セルを±1段する(上限・下限に達しているセルは変化なしのまま許容する)。
  const queue: Pos[] = [];
  const selected = new Set<string>();
  for (const cell of cells) {
    const key = toKey(cell.x, cell.z);
    if (selected.has(key)) continue;
    selected.add(key);
    if (isBlocked(key, cell.x, cell.z)) return noop;
    const current = heights.get(key) ?? 0;
    const target =
      mode === 'raise'
        ? Math.min(TERRAIN_HEIGHT_MAX, current + 1)
        : Math.max(0, current - 1);
    if (target !== current) {
      updated.set(key, target);
      queue.push(cell);
    }
  }
  if (updated.size === 0) return noop;

  // 2. 段差1以下への伝播(BFS)。盛土は隣接セルを h-1 まで引き上げ、切土は h+1 まで
  //    引き下げる。編集前が1-Lipschitzなら各セルの変化は±1段で収まる。
  while (queue.length > 0) {
    const { x, z } = queue.shift()!;
    const h = heightAt(toKey(x, z));
    for (const [dx, dz] of NEIGHBOUR_OFFSETS) {
      const nx = x + dx;
      const nz = z + dz;
      const nKey = toKey(nx, nz);
      // 範囲外は標高0の固定点。変更が必要になった時点でブロックする。
      const nHeight = inRange(nx, nz) ? heightAt(nKey) : 0;
      if (mode === 'raise' && nHeight < h - 1) {
        if (isBlocked(nKey, nx, nz)) return noop;
        updated.set(nKey, h - 1);
        queue.push({ x: nx, z: nz });
      } else if (mode === 'lower' && nHeight > h + 1) {
        if (isBlocked(nKey, nx, nz)) return noop;
        updated.set(nKey, h + 1);
        queue.push({ x: nx, z: nz });
      }
    }
  }

  // 3. 確定: 新しいheightsを組み立てる(0になったセルは未登録=0の規約で取り除く)。
  const changedCells: string[] = [];
  const nextHeights = new Map(heights);
  for (const [key, h] of updated) {
    const original = heights.get(key) ?? 0;
    if (h === original) continue;
    changedCells.push(key);
    if (h > 0) nextHeights.set(key, h);
    else nextHeights.delete(key);
  }
  if (changedCells.length === 0) return noop;

  // 4. 地形種別の整合: mountain ⟺ 標高>=MOUNTAIN_HEIGHT_THRESHOLD(waterは影響セルに
  //    なり得ないため考慮不要)。変化が無ければ同一参照を返す。
  let nextTerrain = terrain;
  for (const key of changedCells) {
    const h = nextHeights.get(key) ?? 0;
    const type = nextTerrain.get(key);
    if (h >= MOUNTAIN_HEIGHT_THRESHOLD && type !== 'mountain') {
      if (nextTerrain === terrain) nextTerrain = new Map(terrain);
      nextTerrain.set(key, 'mountain');
    } else if (h < MOUNTAIN_HEIGHT_THRESHOLD && type === 'mountain') {
      if (nextTerrain === terrain) nextTerrain = new Map(terrain);
      nextTerrain.delete(key);
    }
  }

  // 決定的な出力順(座標順)にする。伝播の探索順に依存させない。
  changedCells.sort((a, b) => {
    const pa = fromKey(a);
    const pb = fromKey(b);
    return pa.x - pb.x || pa.z - pb.z;
  });

  return { heights: nextHeights, terrain: nextTerrain, changedCells };
}
