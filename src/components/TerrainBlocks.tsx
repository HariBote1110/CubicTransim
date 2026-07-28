import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TerrainType } from '../types';
import { fromKey } from '../utils';
import {
  computeElevation,
  elevationAt,
  cellCornerElevations,
  cornerElevation,
  CLIFF_CORNER_MAP,
  MOUNTAIN_ELEVATION_MAX,
} from '../sim/terrain';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { MATERIALS } from '../render/palette';
import { mergeAndDispose } from '../render/mergeGeometry';

interface Props {
  terrain: Map<string, TerrainType>;
  /** トンネル坑口の面集合("x,z,dx,dz"形式)。この面は斜面にせず垂直の崖として描く。 */
  cliffFaces?: Set<string>;
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

const pushQuad = (
  target: THREE.BufferGeometry[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
): void => {
  // a,b,c,d は四角形を一周する順(a-b-c-dの辺で構成)。2三角形(a,b,c)(a,c,d)に分割する。
  pushTri(target, a, b, c);
  pushTri(target, a, c, d);
};

/**
 * 地形(水域・山岳)の描画。
 *
 *  - 水域: 一段掘り下げた水面 + 岸(砂色の縁)で湖らしく
 *  - 山岳: OpenTTD風に、隣接セルとの標高差を斜面で繋いだ地形メッシュ。
 *    各セルの上面は4隅のコーナー標高(sim/terrain.ts の cellCornerElevations、
 *    隣接4セルの標高のmin則で決まる)を頂点に持つ四角形を2三角形に分割して描く。
 *    コーナー標高は隣接セルと共有される値なので面は自然に連続し、隙間やスカートは不要。
 *    トンネル坑口面(cliffFaces)だけは例外的に、対象2隅をセル自身の標高に固定して
 *    垂直の崖として扱い、その面には別途壁クアッドを張る。
 *  1段の高さは OVERPASS_HEIGHT に合わせ、将来の高架・トンネルと視覚整合させる。
 * セル数が数百規模になり得るのでマテリアルごとにマージして描く。
 * 地形データ(sim/terrain.ts)そのものは変更していない。
 */
export const TerrainBlocks: React.FC<Props> = ({ terrain, cliffFaces }) => {
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

      // mountain(トンネル敷設済みセルもOpenTTD風に地形メッシュへ埋め込んで描く。
      // 坑口はGameScene側でtunnelPortalsを使い山肌の位置に別途表示する)
      const e = elevationAt(elevation, x, z);
      if (e <= 0) continue;

      const corners = cellCornerElevations(elevation, x, z, cliffFaces);
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

      // 坑口面の垂直壁: cliffFacesで持ち上げた2隅から、坑口が無かった場合の
      // 本来のコーナー標高(=隣接セル側の自然な高さ)まで壁クアッドを張る。
      if (cliffFaces) {
        for (const [dirKey, [i0, i1]] of Object.entries(CLIFF_CORNER_MAP)) {
          if (!cliffFaces.has(`${x},${z},${dirKey}`)) continue;
          const [ox0, oz0] = CORNER_OFFSETS[i0];
          const [ox1, oz1] = CORNER_OFFSETS[i1];
          const naturalH0 = cornerElevation(elevation, Math.round(x + ox0 + 0.5), Math.round(z + oz0 + 0.5));
          const naturalH1 = cornerElevation(elevation, Math.round(x + ox1 + 0.5), Math.round(z + oz1 + 0.5));
          const top0 = worldCorners[i0];
          const top1 = worldCorners[i1];
          const bottom0 = new THREE.Vector3(top0.x, naturalH0 * OVERPASS_HEIGHT, top0.z);
          const bottom1 = new THREE.Vector3(top1.x, naturalH1 * OVERPASS_HEIGHT, top1.z);
          // 傾きの大きい坑口の垂直壁は岩色にする。
          // 頂点順(top0→top1→bottom1→bottom0)は外側(dx,dz方向)から見てCCWになる
          // ことを確認済み(例: 北面dz=-1では法線が(0,0,-1)になり、外向きになる)。
          pushQuad(rockDark, top0, top1, bottom1, bottom0);
        }
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
  }, [terrain, elevation, cliffFaces]);

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
