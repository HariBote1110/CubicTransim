import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TerrainType } from '../types';
import { fromKey } from '../utils';
import { MATERIALS, hash01 } from '../render/palette';
import { mergeAndDispose } from '../render/mergeGeometry';

interface Props {
  terrain: Map<string, TerrainType>;
  // トンネル化された山岳セル(rail敷設済み)。ここは岩を描かず、
  // GameScene側で坑口を別途表示する。
  tunnelKeys?: Set<string>;
}

const WATER_LEVEL = -0.07;

/**
 * 地形(水域・山岳)の描画。
 *
 * 「青い半透明タイル」と「灰色の四角錐」だったものを、
 *  - 水域: 一段掘り下げた水面 + 岸(砂色の縁)で湖らしく
 *  - 山岳: セル座標から決定的に形を散らしたローポリの岩塊(高い所には雪)
 * に作り直した。セル数が数百規模になり得るのでマテリアルごとにマージして描く。
 * 地形データ(sim/terrain.ts)そのものは変更していない。
 */
export const TerrainBlocks: React.FC<Props> = ({ terrain, tunnelKeys }) => {
  const merged = useMemo(() => {
    const water: THREE.BufferGeometry[] = [];
    const shore: THREE.BufferGeometry[] = [];
    const rock: THREE.BufferGeometry[] = [];
    const rockDark: THREE.BufferGeometry[] = [];
    const snow: THREE.BufferGeometry[] = [];

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

      // mountain
      if (tunnelKeys?.has(key)) continue;

      const h = 0.75 + hash01(x, z, 1) * 1.15;
      const r = 0.42 + hash01(x, z, 2) * 0.2;
      const rot = hash01(x, z, 3) * Math.PI * 2;
      const tilt = (hash01(x, z, 4) - 0.5) * 0.28;

      // 岩塊: 8面体を潰して低ポリの山肌にする。個体差は座標ハッシュで決定的に出す。
      const g = new THREE.OctahedronGeometry(r, 0);
      g.scale(1.15, h / r, 1.15);
      g.rotateY(rot);
      g.rotateX(tilt);
      g.translate(x, h * 0.42, z);
      (hash01(x, z, 5) < 0.4 ? rockDark : rock).push(g);

      // 高い岩には雪冠を載せる
      if (h > 1.55) {
        const cap = new THREE.OctahedronGeometry(r * 0.42, 0);
        cap.scale(1.0, 0.55, 1.0);
        cap.rotateY(rot);
        cap.translate(x, h * 0.82, z);
        snow.push(cap);
      }
    }

    const mergeAll = mergeAndDispose;

    return {
      water: mergeAll(water),
      shore: mergeAll(shore),
      rock: mergeAll(rock),
      rockDark: mergeAll(rockDark),
      snow: mergeAll(snow),
    };
  }, [terrain, tunnelKeys]);

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  const snowMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#eceae3', flatShading: true, roughness: 0.95 }),
    []
  );

  return (
    <group>
      {merged.shore && <mesh geometry={merged.shore} material={MATERIALS.shore} receiveShadow />}
      {merged.water && <mesh geometry={merged.water} material={MATERIALS.water} />}
      {merged.rock && <mesh geometry={merged.rock} material={MATERIALS.rock} castShadow receiveShadow />}
      {merged.rockDark && <mesh geometry={merged.rockDark} material={MATERIALS.rockDark} castShadow receiveShadow />}
      {merged.snow && <mesh geometry={merged.snow} material={snowMaterial} />}
    </group>
  );
};
