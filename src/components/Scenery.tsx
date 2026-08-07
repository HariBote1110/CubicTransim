import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import type { TownTileIndex } from '../sim/townTiles';
import { toKey } from '../utils';
import { MATERIALS, hash01 } from '../render/palette';
import type { TerrainField } from '../sim/terrainField';
import { mergeAndDispose } from '../render/mergeGeometry';

interface Props {
  field: TerrainField;
  railMap: Map<string, CellData>;
  /** 町タイル索引(sim/townTiles.tsのbuildTownTileIndex)。市街地には樹木を置かない。 */
  townTiles: TownTileIndex;
  /** 装飾を置く範囲(-RANGE..RANGE)。sim/terrain.ts の生成範囲に合わせる。 */
  range?: number;
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
export const Scenery: React.FC<Props> = ({ field, railMap, townTiles, range = 45 }) => {
  // 地形と街だけに依存する候補リスト(建設のたびに全セル走査しないよう分離する)。
  const candidates = useMemo(() => {
    const list: { x: number; z: number }[] = [];
    for (let x = -range; x <= range; x++) {
      for (let z = -range; z <= range; z++) {
        if (hash01(x, z, 11) >= TREE_DENSITY) continue;
        if (field.terrainTypeAt(x, z) !== 'grass') continue; // 水域・山岳は除外
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
    return list;
  }, [field, townTiles, range]);

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

      const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.26 * scale, 5);
      trunk.translate(ox, 0.13 * scale, oz);
      trunks.push(trunk);

      const crown = conifer
        ? new THREE.ConeGeometry(0.22 * scale, 0.62 * scale, 6)
        : new THREE.IcosahedronGeometry(0.24 * scale, 0);
      crown.translate(ox, (conifer ? 0.55 : 0.42) * scale, oz);
      (hash01(c.x, c.z, 16) < 0.45 ? foliageDark : foliage).push(crown);
    }

    const mergeAll = mergeAndDispose;

    return {
      trunks: mergeAll(trunks),
      foliage: mergeAll(foliage),
      foliageDark: mergeAll(foliageDark),
    };
  }, [candidates, railMap]);

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  // 樹木は装飾であり選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  return (
    <group>
      {merged.trunks && <mesh geometry={merged.trunks} material={MATERIALS.trunk} raycast={noRaycast} />}
      {merged.foliage && <mesh geometry={merged.foliage} material={MATERIALS.foliage} castShadow raycast={noRaycast} />}
      {merged.foliageDark && (
        <mesh geometry={merged.foliageDark} material={MATERIALS.foliageDark} castShadow raycast={noRaycast} />
      )}
    </group>
  );
};
