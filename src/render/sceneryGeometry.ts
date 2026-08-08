// 樹木(装飾)の候補セル列挙とジオメトリ生成。描画専任レイヤーの純粋な部品で、
// three.js(Scenery.tsx)と wgpu(WebGpuScenery.tsx)の両方から同じ関数を呼ぶ。
//
// 樹木はセーブデータに載らず、セル座標のハッシュ(hash01)だけで決まる純粋な関数として
// 生成する。可視チャンクの組み合わせが変わっても同じセルには常に同じ木が生える
// (チャンク非依存の決定性)。

import * as THREE from './geom';
import type { CellData } from '../types';
import type { TownTileIndex } from '../sim/townTiles';
import { toKey } from '../utils';
import { hash01 } from './palette';
import type { TerrainField } from '../sim/terrainField';
import { cornerGridFor, waterCornerGridFor, cellCornersFromGrid } from '../sim/terrainField';
import { mergeAndDispose } from './mergeGeometry';
import { chunkCellBounds, type ChunkCoord, type CellPos } from './terrainChunks';
import { slopeOf } from '../sim/slopes';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

/** 草地セルに樹木を置く確率。上げすぎると森で埋まって線路が見づらくなる。 */
export const TREE_DENSITY = 0.055;
/**
 * 町タイル(家・道路)とその周囲この距離(チェビシェフ)以内には樹木を置かない
 * (市街地の輪郭に沿って空き地を作るため)。
 */
export const TOWN_TILE_MARGIN = 1;

/**
 * 1チャンク分の樹木候補セルを列挙する。
 *
 * チャンクごとにコーナー格子・水域格子を1回だけバッチ評価し(TerrainBlocksと同じ
 * cornerGridFor/waterCornerGridFor)、セルごとの水域判定・slopeOf用の4隅取得は
 * 配列引きだけにする(terrainTypeAt/cellCornerHeightsの個別呼び出しを避ける)。
 */
export function treeCandidatesInChunk(
  field: TerrainField,
  townTiles: TownTileIndex,
  chunk: ChunkCoord,
  range: number,
): CellPos[] {
  const bounds = chunkCellBounds(chunk, range);
  if (!bounds) return [];
  const list: CellPos[] = [];
  const w = bounds.x1 - bounds.x0 + 1;
  const h = bounds.z1 - bounds.z0 + 1;
  const gh = h + 1;
  const heightGrid = cornerGridFor(field, bounds.x0, bounds.z0, w, h);
  const waterGrid = waterCornerGridFor(field, bounds.x0, bounds.z0, w, h);

  for (let x = bounds.x0; x <= bounds.x1; x++) {
    const lx = x - bounds.x0;
    for (let z = bounds.z0; z <= bounds.z1; z++) {
      const lz = z - bounds.z0;
      if (hash01(x, z, 11) >= TREE_DENSITY) continue;

      const isWater =
        waterGrid[lx * gh + lz] === 1 &&
        waterGrid[(lx + 1) * gh + lz] === 1 &&
        waterGrid[lx * gh + (lz + 1)] === 1 &&
        waterGrid[(lx + 1) * gh + (lz + 1)] === 1;
      // mountain(標高1以上)は建設不可の障害物ではないため、樹木も平坦な高原なら
      // 生やす(水域・傾斜地は除外、標高そのものは問わない)。
      if (isWater) continue;
      if (slopeOf(cellCornersFromGrid(heightGrid, gh, lx, lz)).kind !== 'flat') continue;
      // 町タイル(家・道路)とその周囲1タイルは市街地として空けておく。
      let nearTown = false;
      for (let dx = -TOWN_TILE_MARGIN; dx <= TOWN_TILE_MARGIN && !nearTown; dx++) {
        for (let dz = -TOWN_TILE_MARGIN; dz <= TOWN_TILE_MARGIN && !nearTown; dz++) {
          if (townTiles.has(toKey(x + dx, z + dz))) nearTown = true;
        }
      }
      if (nearTown) continue;
      list.push({ x, z });
    }
  }
  return list;
}

export interface SceneryGeometries {
  trunks: THREE.BufferGeometry | null;
  foliage: THREE.BufferGeometry | null;
  foliageDark: THREE.BufferGeometry | null;
}

/**
 * 候補セルから樹木のジオメトリを組み立てる(マテリアル別に3バケットへマージ)。
 * セル内の位置・大きさ・樹種はセル座標のハッシュで決定的に散らす。
 */
export function buildSceneryGeometries(
  candidates: readonly CellPos[],
  railMap: Map<string, CellData>,
  field: TerrainField,
): SceneryGeometries {
  const trunks: THREE.BufferGeometry[] = [];
  const foliage: THREE.BufferGeometry[] = [];
  const foliageDark: THREE.BufferGeometry[] = [];

  for (const c of candidates) {
    if (railMap.has(toKey(c.x, c.z))) continue; // 敷設済みセルには生やさない

    const ox = c.x + (hash01(c.x, c.z, 12) - 0.5) * 0.6;
    const oz = c.z + (hash01(c.x, c.z, 13) - 0.5) * 0.6;
    const scale = 0.75 + hash01(c.x, c.z, 14) * 0.6;
    const conifer = hash01(c.x, c.z, 15) < 0.55;
    // 樹木は地形の表面(セル標高)に乗せる。候補セルはflat限定なのでcellHeightAtの
    // 単一値で足りる(inclineのような低い側/高い側の使い分けは不要)。
    const oy = field.cellHeightAt(c.x, c.z) * OVERPASS_HEIGHT;

    const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.26 * scale, 5);
    trunk.translate(ox, oy + 0.13 * scale, oz);
    trunks.push(trunk);

    const crown = conifer
      ? new THREE.ConeGeometry(0.22 * scale, 0.62 * scale, 6)
      : new THREE.IcosahedronGeometry(0.24 * scale, 0);
    crown.translate(ox, oy + (conifer ? 0.55 : 0.42) * scale, oz);
    (hash01(c.x, c.z, 16) < 0.45 ? foliageDark : foliage).push(crown);
  }

  return {
    trunks: mergeAndDispose(trunks),
    foliage: mergeAndDispose(foliage),
    foliageDark: mergeAndDispose(foliageDark),
  };
}
