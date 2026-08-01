import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { TownData } from '../types';
import { fromKey } from '../utils';
import type { TownTileIndex } from '../sim/townTiles';
import { MATERIALS, hash01 } from '../render/palette';
import { mergeAndDispose } from '../render/mergeGeometry';

interface Props {
  towns: TownData[];
  /** 町タイル索引(sim/townTiles.tsのbuildTownTileIndex)。家・道路をこのタイル通りに描く。 */
  townTiles: TownTileIndex;
}

// この人口以上の町には、中心近くのタイルに高層ビルが混ざる。
const TALL_BUILDING_POPULATION = 4000;

// 人口を "2.3k" のような簡易表記に変換する。
const formatPopulation = (population: number): string =>
  population >= 1000 ? `${(population / 1000).toFixed(1)}k` : `${Math.round(population)}`;

/**
 * タイルベースの町の描画。sim/townTiles.tsが決めたタイル(家・道路)を、そのセルの
 * 中央に建てる。家の大きさ・高さ・色はセル座標のハッシュから決定的に散らす。
 * 数百タイル規模になるためマテリアルごとにジオメトリをマージして少数ドローコールに収める。
 *
 * 道路タイルは地平の線路と同居できる(踏切)。その場合も路面スラブは描いたままにする
 * ことで、線路が路面を横切る見た目(簡易的な踏切)になる。遮断機・警報機の描画は未実装
 * (progress/tile-based-towns.md参照)。
 */
export const TownBlocks: React.FC<Props> = ({ towns, townTiles }) => {
  const merged = useMemo(() => {
    const populationByTown = new Map(towns.map(t => [t.id, t.population]));
    const wallsA: THREE.BufferGeometry[] = [];
    const wallsB: THREE.BufferGeometry[] = [];
    const wallsC: THREE.BufferGeometry[] = [];
    const roofs: THREE.BufferGeometry[] = [];
    const roofsFlat: THREE.BufferGeometry[] = [];
    const roads: THREE.BufferGeometry[] = [];
    const kerbs: THREE.BufferGeometry[] = [];

    for (const [key, entry] of townTiles) {
      const { x, z } = fromKey(key);

      if (entry.kind === 'road') {
        // 縁石(タイル全面のわずかに明るい下地)+アスファルトの路面スラブ。
        const kerb = new THREE.BoxGeometry(1.0, 0.03, 1.0);
        kerb.translate(x, 0.015, z);
        kerbs.push(kerb);
        const slab = new THREE.BoxGeometry(0.86, 0.045, 0.86);
        slab.translate(x, 0.0225, z);
        roads.push(slab);
        continue;
      }

      // 家: セル座標ハッシュで大きさ・高さ・色を決定的に散らす。
      const population = populationByTown.get(entry.townId) ?? 0;
      const width = 0.4 + hash01(x, z, 21) * 0.2;
      const depth = 0.4 + hash01(x, z, 22) * 0.2;
      const tall = population >= TALL_BUILDING_POPULATION && hash01(x, z, 25) < 0.18;
      const height = tall
        ? 0.9 + hash01(x, z, 26) * 1.3
        : 0.3 + hash01(x, z, 26) * 0.35;

      const wall = new THREE.BoxGeometry(width, height, depth);
      wall.translate(x, height / 2, z);
      const bucket = hash01(x, z, 23);
      (bucket < 0.34 ? wallsA : bucket < 0.67 ? wallsB : wallsC).push(wall);

      if (tall) {
        // 高層はパラペット(平屋根)で「ビル」らしく。
        const parapet = new THREE.BoxGeometry(width + 0.04, 0.05, depth + 0.04);
        parapet.translate(x, height + 0.025, z);
        roofsFlat.push(parapet);
        const plant = new THREE.BoxGeometry(width * 0.4, 0.09, depth * 0.4);
        plant.translate(x, height + 0.09, z);
        roofsFlat.push(plant);
      } else {
        // 低層の住宅には寄棟屋根を載せる。
        const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.8, 0.2, 4);
        roof.rotateY(Math.PI / 4);
        roof.translate(x, height + 0.1, z);
        roofs.push(roof);
      }
    }

    return {
      wallsA: mergeAndDispose(wallsA),
      wallsB: mergeAndDispose(wallsB),
      wallsC: mergeAndDispose(wallsC),
      roofs: mergeAndDispose(roofs),
      roofsFlat: mergeAndDispose(roofsFlat),
      roads: mergeAndDispose(roads),
      kerbs: mergeAndDispose(kerbs),
    };
  }, [towns, townTiles]);

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  // 町の建物・道路は装飾であり選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  return (
    <group>
      {merged.kerbs && <mesh geometry={merged.kerbs} material={MATERIALS.roadKerb} receiveShadow raycast={noRaycast} />}
      {merged.roads && <mesh geometry={merged.roads} material={MATERIALS.roadAsphalt} receiveShadow raycast={noRaycast} />}
      {merged.wallsA && <mesh geometry={merged.wallsA} material={MATERIALS.buildingA} castShadow receiveShadow raycast={noRaycast} />}
      {merged.wallsB && <mesh geometry={merged.wallsB} material={MATERIALS.buildingB} castShadow receiveShadow raycast={noRaycast} />}
      {merged.wallsC && <mesh geometry={merged.wallsC} material={MATERIALS.buildingC} castShadow receiveShadow raycast={noRaycast} />}
      {merged.roofs && <mesh geometry={merged.roofs} material={MATERIALS.buildingRoof} castShadow raycast={noRaycast} />}
      {merged.roofsFlat && <mesh geometry={merged.roofsFlat} material={MATERIALS.buildingRoofFlat} raycast={noRaycast} />}

      {towns.map(town => (
        <Html key={town.id} position={[town.centre.x, 2.6, town.centre.z]} center style={{ pointerEvents: 'none' }}>
          <div style={{
            background: 'rgba(24,30,38,0.62)', color: '#f2f5f8', padding: '2px 7px',
            borderRadius: '999px', fontSize: '10px', whiteSpace: 'nowrap',
            backdropFilter: 'blur(3px)', border: '1px solid rgba(255,255,255,0.14)',
          }}>
            <span style={{ fontWeight: 700, marginRight: 5 }}>{town.name}</span>
            {formatPopulation(town.population)}
          </div>
        </Html>
      ))}
    </group>
  );
};
