import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TerrainType } from '../types';
import { fromKey } from '../utils';
import { computeElevation, elevationAt, MOUNTAIN_ELEVATION_MAX } from '../sim/terrain';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { MATERIALS, hash01 } from '../render/palette';
import { mergeAndDispose } from '../render/mergeGeometry';

interface Props {
  terrain: Map<string, TerrainType>;
}

const WATER_LEVEL = -0.07;

/**
 * 地形(水域・山岳)の描画。
 *
 *  - 水域: 一段掘り下げた水面 + 岸(砂色の縁)で湖らしく
 *  - 山岳: OpenTTD風の整数標高の段丘ブロック。標高は sim/terrain.ts の
 *    computeElevation で地形データから決定的に導出する(セーブ形式には含めない)。
 *    1段の高さは OVERPASS_HEIGHT に合わせ、将来の高架・トンネルと視覚整合させる。
 * セル数が数百規模になり得るのでマテリアルごとにマージして描く。
 * 地形データ(sim/terrain.ts)そのものは変更していない。
 */
export const TerrainBlocks: React.FC<Props> = ({ terrain }) => {
  const elevation = useMemo(() => computeElevation(terrain), [terrain]);

  const merged = useMemo(() => {
    const water: THREE.BufferGeometry[] = [];
    const shore: THREE.BufferGeometry[] = [];
    const rock: THREE.BufferGeometry[] = [];
    const rockDark: THREE.BufferGeometry[] = [];
    const grassTop: THREE.BufferGeometry[] = [];
    const snowTop: THREE.BufferGeometry[] = [];

    for (const [key, type] of terrain) {
      const { x, z } = fromKey(key);

      if (type === 'water') {
        // 岸: セル全体を砂色で塗り、その内側に水面を張る。
        // 水域の外周セルだけ縁が見えるので、自然に汀線ができる。
        const bank = new THREE.BoxGeometry(1.0, 0.08, 1.0);
        bank.translate(x, WATER_LEVEL - 0.02, z);
        shore.push(bank);

        const surface = new THREE.BoxGeometry(0.94, 0.05, 0.94);
        surface.translate(x, WATER_LEVEL + 0.02, z);
        water.push(surface);
        continue;
      }

      // mountain(トンネル敷設済みセルもOpenTTD風に地形ブロックへ埋め込んで描く。
      // 坑口はGameScene側でtunnelPortalsを使い山肌の位置に別途表示する)
      const e = elevationAt(elevation, x, z);
      if (e <= 0) continue;

      const height = e * OVERPASS_HEIGHT;

      // 側面: 段丘の柱。標高ごとに色をわずかに散らして単調さを崩す。
      const side = new THREE.BoxGeometry(1.0, height, 1.0);
      side.translate(x, height / 2, z);
      (hash01(x, z, 5) < 0.4 ? rockDark : rock).push(side);

      // 上面: 薄い板。標高3(芯)は雪、標高1〜2は草地。
      const top = new THREE.BoxGeometry(0.98, 0.06, 0.98);
      top.translate(x, height + 0.03, z);
      (e >= MOUNTAIN_ELEVATION_MAX ? snowTop : grassTop).push(top);
    }

    const mergeAll = mergeAndDispose;

    return {
      water: mergeAll(water),
      shore: mergeAll(shore),
      rock: mergeAll(rock),
      rockDark: mergeAll(rockDark),
      grassTop: mergeAll(grassTop),
      snowTop: mergeAll(snowTop),
    };
  }, [terrain, elevation]);

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  // 水域・山岳の地形装飾は選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  return (
    <group>
      {merged.shore && <mesh geometry={merged.shore} material={MATERIALS.shore} receiveShadow raycast={noRaycast} />}
      {merged.water && <mesh geometry={merged.water} material={MATERIALS.water} raycast={noRaycast} />}
      {merged.rock && <mesh geometry={merged.rock} material={MATERIALS.rock} castShadow receiveShadow raycast={noRaycast} />}
      {merged.rockDark && (
        <mesh geometry={merged.rockDark} material={MATERIALS.rockDark} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.grassTop && (
        <mesh geometry={merged.grassTop} material={MATERIALS.grassTerrace} receiveShadow raycast={noRaycast} />
      )}
      {merged.snowTop && (
        <mesh geometry={merged.snowTop} material={MATERIALS.rockSnow} receiveShadow raycast={noRaycast} />
      )}
    </group>
  );
};
