import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TerrainType } from '../types';
import { fromKey } from '../utils';
import {
  computeElevation,
  elevationAt,
  buildCornerElevationMap,
  cellCornersFromMap,
  MOUNTAIN_ELEVATION_MAX,
} from '../sim/terrain';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { MATERIALS } from '../render/palette';
import { mergeAndDispose } from '../render/mergeGeometry';

interface Props {
  terrain: Map<string, TerrainType>;
}

const WATER_LEVEL = -0.07;

// セル(x,z)の4隅の平面座標。cellCornerElevationsと同じ順序[左上,右上,右下,左下]。
const CORNER_OFFSETS: ReadonlyArray<[number, number]> = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

const pushTri = (
  target: THREE.BufferGeometry[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): void => {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  target.push(geo);
};

/**
 * 地形(水域・山岳)の描画。
 *
 *  - 水域: 一段掘り下げた水面 + 岸(砂色の縁)で湖らしく
 *  - 山岳: OpenTTD風に、隣接セルとの標高差を斜面で繋いだ地形メッシュ。
 *    各セルの上面は4隅のコーナー標高(sim/terrain.ts の cellCornerElevations、
 *    隣接4セルの標高のmin則で決まる)を頂点に持つ四角形を2三角形に分割して描く。
 *    コーナー標高は隣接セルと共有される値なので面は自然に連続し、隙間やスカートは不要。
 *    トンネル坑口も例外扱いせず、常に自然な斜面(min則)のまま描く(坑口構造物は
 *    GameScene側で斜面から張り出す別パーツとして描く)。
 *  1段の高さは OVERPASS_HEIGHT に合わせ、将来の高架・トンネルと視覚整合させる。
 * セル数が数百規模になり得るのでマテリアルごとにマージして描く。
 * 地形データ(sim/terrain.ts)そのものは変更していない。
 */
export const TerrainBlocks: React.FC<Props> = ({ terrain }) => {
  const elevation = useMemo(() => computeElevation(terrain), [terrain]);
  // コーナー標高は「コーナー座標→標高」の共有マップとして1度だけ構築する
  // (buildCornerElevationMap)。セルごとに個別計算すると、同じコーナーを共有する
  // 隣接セル間で計算結果がずれ、上面メッシュに裂け目ができる恐れがある。
  const cornerMap = useMemo(() => buildCornerElevationMap(elevation), [elevation]);

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

      // mountain(トンネル敷設済みセルもOpenTTD風に地形メッシュへ埋め込んで描く。
      // 坑口はGameScene側でtunnelPortalsを使い山肌の位置に別途表示する)
      const e = elevationAt(elevation, x, z);
      if (e <= 0) continue;

      const corners = cellCornersFromMap(cornerMap, x, z);
      const worldCorners = corners.map((h, i) => {
        const [ox, oz] = CORNER_OFFSETS[i];
        return new THREE.Vector3(x + ox, h * OVERPASS_HEIGHT, z + oz);
      });
      const [tl, tr, br, bl] = worldCorners;

      // 上面の色: 標高3(芯)は雪、標高1〜2は草地(斜面も同じ扱いでよい)。
      const topTarget = e >= MOUNTAIN_ELEVATION_MAX ? snowTop : grassTop;

      // 対角線は「高さが等しい2隅を結ぶ側」を優先して分割する(ひねりの少ない自然な見た目になる)。
      // 頂点順は+Y(上方)から見てCCW(反時計回り)にすること。tl→tr→brの順は
      // +Yから見て時計回りになり法線が下向き(裏面カリングで上面が消える)ため、
      // 最後の2頂点を入れ替えてCCW(法線+Y)にしている。
      if (corners[0] === corners[2]) {
        pushTri(topTarget, tl, br, tr);
        pushTri(topTarget, tl, bl, br);
      } else if (corners[1] === corners[3]) {
        pushTri(topTarget, tl, bl, tr);
        pushTri(topTarget, tr, bl, br);
      } else {
        pushTri(topTarget, tl, br, tr);
        pushTri(topTarget, tl, bl, br);
      }
    }

    const mergeAll = (list: THREE.BufferGeometry[]): THREE.BufferGeometry | null => {
      const geo = mergeAndDispose(list);
      geo?.computeVertexNormals();
      return geo;
    };

    return {
      water: mergeAll(water),
      shore: mergeAll(shore),
      rock: mergeAll(rock),
      rockDark: mergeAll(rockDark),
      grassTop: mergeAll(grassTop),
      snowTop: mergeAll(snowTop),
    };
  }, [terrain, elevation, cornerMap]);

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  // 水域・山岳の地形装飾は選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  return (
    <group>
      {merged.shore && <mesh geometry={merged.shore} material={MATERIALS.shore} receiveShadow raycast={noRaycast} />}
      {merged.water && <mesh geometry={merged.water} material={MATERIALS.water} raycast={noRaycast} />}
      {merged.rock && (
        <mesh geometry={merged.rock} material={MATERIALS.rock} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.rockDark && (
        <mesh geometry={merged.rockDark} material={MATERIALS.rockDark} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.grassTop && (
        <mesh
          geometry={merged.grassTop}
          material={MATERIALS.grassTerrace}
          castShadow
          receiveShadow
          raycast={noRaycast}
        />
      )}
      {merged.snowTop && (
        <mesh geometry={merged.snowTop} material={MATERIALS.rockSnow} castShadow receiveShadow raycast={noRaycast} />
      )}
    </group>
  );
};
