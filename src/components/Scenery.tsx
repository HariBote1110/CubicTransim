import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import type { TownTileIndex } from '../sim/townTiles';
import { toKey } from '../utils';
import { materialsFor, hash01 } from '../render/palette';
import { SURFACE_RENDER_ORDER } from '../render/viewMode';
import type { TerrainField } from '../sim/terrainField';
import { cornerGridFor, waterCornerGridFor, cellCornersFromGrid } from '../sim/terrainField';
import { mergeAndDispose } from '../render/mergeGeometry';
import { visibleChunkRange, chunkCellBounds, chunkKey } from '../render/terrainChunks';
import { slopeOf } from '../sim/slopes';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

interface Props {
  field: TerrainField;
  railMap: Map<string, CellData>;
  /** 町タイル索引(sim/townTiles.tsのbuildTownTileIndex)。市街地には樹木を置かない。 */
  townTiles: TownTileIndex;
  /** 装飾を置く範囲(-RANGE..RANGE)。sim/terrain.ts の生成範囲に合わせる。 */
  range?: number;
  /** カメラが注視しているセル座標(TerrainBlocksと同じ可視チャンク集合を使う)。 */
  cameraTargetCell: { x: number; z: number };
  /** カメラの可視半径(セル数)。 */
  viewRadiusCells: number;
  /** P8b: 地下ビュー中は樹木を暗く半透明にする(render/palette.tsのDIMMED_MATERIALS)。 */
  dimmed?: boolean;
  /**
   * R3: trueのとき、樹木の候補セル列挙(visibleChunkRange)そのものを行わず何も描かない
   * (render/farView.tsのfarViewStageForRatioが'hidden'を返した場合。WebGPU全図
   * ズームアウトで可視半径がマップ全体に迫るとチャンク数が爆発するため、GameScene側で
   * 事前に見積もって止める)。
   */
  hidden?: boolean;
}

// 草地セルに樹木を置く確率。上げすぎると森で埋まって線路が見づらくなる。
const TREE_DENSITY = 0.055;
// 町タイル(家・道路)とその周囲この距離(チェビシェフ)以内には樹木を置かない
// (市街地の輪郭に沿って空き地を作るため)。
const TOWN_TILE_MARGIN = 1;

/**
 * 平地(草地)に置く装飾物(樹木)。
 *
 * sim層の地形データは水域/山岳しか持たないため、樹木はセル座標のハッシュから
 * 決定的に生成する純粋な描画要素として扱う(セーブデータにも載らないが、
 * 同じ座標には必ず同じ木が生えるので見た目は安定する)。
 * 数百本規模になるのでマテリアルごとにジオメトリをマージして3ドローコールに収める。
 */
export const Scenery: React.FC<Props> = ({
  field, railMap, townTiles, range = 45, cameraTargetCell, viewRadiusCells, dimmed = false, hidden = false,
}) => {
  const MATERIALS = materialsFor(dimmed);
  // P4: 全セル(-range..range)を毎回走査するのではなく、TerrainBlocksと同じ
  // 可視チャンク集合(render/terrainChunks.ts)だけを候補にする。木の配置自体は
  // セル座標のハッシュ(hash01)だけで決まる純粋な関数なので、可視チャンクの
  // 組み合わせが変わっても同じセルには常に同じ木が生える(チャンク非依存の決定性)。
  // R3: hiddenのときはvisibleChunkRange自体を呼ばない(配列生成コストと後段の全走査を
  // 両方避ける。GameScene側がrender/farView.tsの見積もりで事前に決めている)。
  const visibleChunks = useMemo(
    () => (hidden ? [] : visibleChunkRange(cameraTargetCell, viewRadiusCells, range, 1)),
    [cameraTargetCell.x, cameraTargetCell.z, viewRadiusCells, range, hidden],
  );

  const candidates = useMemo(() => {
    const list: { x: number; z: number }[] = [];
    const seen = new Set<string>();
    // P9a: チャンクごとにコーナー格子・水域格子を1回だけバッチ評価し(TerrainBlocksと
    // 同じcornerGridFor/waterCornerGridFor)、セルごとの水域判定・slopeOf用の4隅取得は
    // 配列引きだけにする(terrainTypeAt/cellCornerHeightsの個別呼び出しを避ける)。
    for (const chunk of visibleChunks) {
      const bounds = chunkCellBounds(chunk, range);
      if (!bounds) continue;
      const w = bounds.x1 - bounds.x0 + 1;
      const h = bounds.z1 - bounds.z0 + 1;
      const gh = h + 1;
      const heightGrid = cornerGridFor(field, bounds.x0, bounds.z0, w, h);
      const waterGrid = waterCornerGridFor(field, bounds.x0, bounds.z0, w, h);

      for (let x = bounds.x0; x <= bounds.x1; x++) {
        const lx = x - bounds.x0;
        for (let z = bounds.z0; z <= bounds.z1; z++) {
          const lz = z - bounds.z0;
          const key = chunkKey(x, z);
          if (seen.has(key)) continue; // チャンクのマージン境界での重複を防ぐ。
          seen.add(key);
          if (hash01(x, z, 11) >= TREE_DENSITY) continue;

          const isWater =
            waterGrid[lx * gh + lz] === 1 &&
            waterGrid[(lx + 1) * gh + lz] === 1 &&
            waterGrid[lx * gh + (lz + 1)] === 1 &&
            waterGrid[(lx + 1) * gh + (lz + 1)] === 1;
          // P7d: mountain(標高1以上)は建設不可の障害物ではなくなったため、樹木も
          // 平坦な高原なら生やす(水域・傾斜地は除外、標高そのものは問わない)。
          if (isWater) continue;
          if (slopeOf(cellCornersFromGrid(heightGrid, gh, lx, lz)).kind !== 'flat') continue;
          // 町タイル(家・道路)とその周囲1タイルは市街地として空けておく
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
    }
    return list;
  }, [field, townTiles, range, visibleChunks]);

  const merged = useMemo(() => {
    const trunks: THREE.BufferGeometry[] = [];
    const foliage: THREE.BufferGeometry[] = [];
    const foliageDark: THREE.BufferGeometry[] = [];

    for (const c of candidates) {
      if (railMap.has(toKey(c.x, c.z))) continue; // 敷設済みセルには生やさない

      // セル内の位置と大きさを座標ハッシュで散らす
      const ox = c.x + (hash01(c.x, c.z, 12) - 0.5) * 0.6;
      const oz = c.z + (hash01(c.x, c.z, 13) - 0.5) * 0.6;
      const scale = 0.75 + hash01(c.x, c.z, 14) * 0.6;
      const conifer = hash01(c.x, c.z, 15) < 0.55;
      // P7d: 樹木は地形の表面(セル標高)に乗せる。候補セルはflat限定なので
      // cellHeightAtの単一値で足りる(inclineのような低い側/高い側の使い分けは不要)。
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

    const mergeAll = mergeAndDispose;

    return {
      trunks: mergeAll(trunks),
      foliage: mergeAll(foliage),
      foliageDark: mergeAll(foliageDark),
    };
  }, [candidates, railMap, field]);

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  // 樹木は装飾であり選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  return (
    <group>
      {merged.trunks && <mesh geometry={merged.trunks} material={MATERIALS.trunk} raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.foliage && <mesh geometry={merged.foliage} material={MATERIALS.foliage} castShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.foliageDark && (
        <mesh geometry={merged.foliageDark} material={MATERIALS.foliageDark} castShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
      )}
    </group>
  );
};
