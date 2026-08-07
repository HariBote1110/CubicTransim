import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import type { TownData } from '../types';
import { fromKey } from '../utils';
import type { TownSubTileIndex } from '../sim/townTiles';
import { subTileWorldCentre, townSubTileRadius, SUB_TILES_PER_TILE, parentTileOfSub } from '../sim/townTiles';
import { materialsFor, hash01 } from '../render/palette';
import { SURFACE_RENDER_ORDER } from '../render/viewMode';
import { mergeAndDispose } from '../render/mergeGeometry';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

interface Props {
  towns: TownData[];
  /** 町サブタイル索引(sim/townTiles.tsのbuildTownIndexes)。家・道路をこのサブタイル通りに描く。 */
  townSubTiles: TownSubTileIndex;
  /**
   * 地形(P7d)。サブタイルは親タイル単位の標高(flat限定なのでcellHeightAtで一意)ぶん
   * y方向に持ち上げる。2x2のサブタイルは親セルを跨がない(sim/townTiles.tsのP7d実装メモ
   * 参照)ため、サブタイル単位で個別の高さを持たせる必要はなく、親タイルの標高1つで足りる。
   */
  field: TerrainField;
  /** P8b: 地下ビュー中は町を暗く半透明にする(render/palette.tsのDIMMED_MATERIALS)。 */
  dimmed?: boolean;
}

// この人口以上の町には、一部のサブタイルに高層ビルが混ざる。
const TALL_BUILDING_POPULATION = 4000;
// この人口以上の町は「都心コア(高層)・中層リング・郊外(低層)」の同心円構造になる。
const CITY_CORE_POPULATION = 10000;
// 正規化距離(中心からのチェビシェフ距離 / 町サブタイル半径)による同心円の境界。
const CITY_CORE_RADIUS_RATIO = 0.35;
const CITY_MIDRISE_RADIUS_RATIO = 0.7;

// 人口を "2.3k" のような簡易表記に変換する。
const formatPopulation = (population: number): string =>
  population >= 1000 ? `${(population / 1000).toFixed(1)}k` : `${Math.round(population)}`;

/**
 * タイルベースの町の描画。sim/townTiles.tsが決めたサブタイル(1ゲームタイルを2x2分割、
 * 一辺0.5)の中央に建てる。道路は幅0.5の帯になり、1タイル幅の線路より明確に細く、
 * 家は道路沿いに並ぶ小さな建物になる。家の大きさ・高さ・色はサブタイル座標のハッシュ
 * から決定的に散らす。
 * 千サブタイル規模になるためマテリアルごとにジオメトリをマージして少数ドローコールに収める。
 *
 * 道路サブタイルは地平の線路と同居できる(踏切)。その場合も路面スラブは描いたままにする
 * ことで、線路が路面を横切る見た目(簡易的な踏切)になる。遮断機・警報機の描画は未実装
 * (progress/tile-based-towns.md参照)。
 */
export const TownBlocks: React.FC<Props> = ({ towns, townSubTiles, field, dimmed = false }) => {
  const MATERIALS = materialsFor(dimmed);
  const merged = useMemo(() => {
    const townById = new Map(towns.map(t => [t.id, t]));
    const wallsA: THREE.BufferGeometry[] = [];
    const wallsB: THREE.BufferGeometry[] = [];
    const wallsC: THREE.BufferGeometry[] = [];
    const roofs: THREE.BufferGeometry[] = [];
    const roofsFlat: THREE.BufferGeometry[] = [];
    const roads: THREE.BufferGeometry[] = [];
    const kerbs: THREE.BufferGeometry[] = [];

    for (const [key, entry] of townSubTiles) {
      const { x: sx, z: sz } = fromKey(key);
      const wx = subTileWorldCentre(sx);
      const wz = subTileWorldCentre(sz);
      // P7d: サブタイルは親タイルを跨がない(sim/townTiles.ts)ので、親タイルの標高
      // (flat限定なのでcellHeightAtで一意に決まる)ぶんだけ丸ごと持ち上げれば足りる。
      const wy = field.cellHeightAt(parentTileOfSub(sx), parentTileOfSub(sz)) * OVERPASS_HEIGHT;

      if (entry.kind === 'road') {
        // 縁石(サブタイル全面のわずかに明るい下地)+アスファルトの路面スラブ。
        // 隣接する道路サブタイル同士はスラブが繋がって幅0.5の帯になる。
        const kerb = new THREE.BoxGeometry(0.5, 0.03, 0.5);
        kerb.translate(wx, wy + 0.015, wz);
        kerbs.push(kerb);
        const slab = new THREE.BoxGeometry(0.44, 0.045, 0.44);
        slab.translate(wx, wy + 0.0225, wz);
        roads.push(slab);
        continue;
      }

      // 家: サブタイル座標ハッシュで大きさ・高さ・色を決定的に散らす。
      // 一辺0.5のサブタイルに収まる 0.30..0.42 の足元。
      const town = townById.get(entry.townId);
      const population = town?.population ?? 0;
      const width = 0.3 + hash01(sx, sz, 21) * 0.12;
      const depth = 0.3 + hash01(sx, sz, 22) * 0.12;

      // 都市の高さ分布: 人口CITY_CORE_POPULATION以上の町は、中心からの正規化距離で
      // 「高層コア→中層リング→低層の郊外」の同心円になる(すべてハッシュ由来で決定的)。
      // それ未満の町は従来通り、TALL_BUILDING_POPULATION以上で12%の高層のみ。
      let tall = false;
      let midRise = false;
      let coreTower = false;
      if (population >= CITY_CORE_POPULATION && town) {
        const subRadius = townSubTileRadius(population);
        const d =
          Math.max(
            Math.abs(sx - town.centre.x * SUB_TILES_PER_TILE),
            Math.abs(sz - town.centre.z * SUB_TILES_PER_TILE)
          ) / subRadius;
        if (d <= CITY_CORE_RADIUS_RATIO) {
          tall = hash01(sx, sz, 25) < 0.55;
          coreTower = tall;
        } else if (d <= CITY_MIDRISE_RADIUS_RATIO) {
          tall = hash01(sx, sz, 25) < 0.12;
          midRise = !tall && hash01(sx, sz, 27) < 0.45;
        } else {
          tall = hash01(sx, sz, 25) < 0.04;
        }
      } else if (population >= TALL_BUILDING_POPULATION) {
        tall = hash01(sx, sz, 25) < 0.12;
      }
      const height = coreTower
        ? 1.2 + hash01(sx, sz, 26) * 1.8
        : tall
          ? 0.9 + hash01(sx, sz, 26) * 1.2
          : midRise
            ? 0.5 + hash01(sx, sz, 26) * 0.6
            : 0.24 + hash01(sx, sz, 26) * 0.28;

      const wall = new THREE.BoxGeometry(width, height, depth);
      wall.translate(wx, wy + height / 2, wz);
      const bucket = hash01(sx, sz, 23);
      (bucket < 0.34 ? wallsA : bucket < 0.67 ? wallsB : wallsC).push(wall);

      if (tall || midRise) {
        // 高層・中層はパラペット(平屋根)で「ビル」らしく。
        const parapet = new THREE.BoxGeometry(width + 0.03, 0.04, depth + 0.03);
        parapet.translate(wx, wy + height + 0.02, wz);
        roofsFlat.push(parapet);
        const plant = new THREE.BoxGeometry(width * 0.4, 0.07, depth * 0.4);
        plant.translate(wx, wy + height + 0.07, wz);
        roofsFlat.push(plant);
      } else {
        // 低層の住宅には寄棟屋根を載せる。
        const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.8, 0.15, 4);
        roof.rotateY(Math.PI / 4);
        roof.translate(wx, wy + height + 0.075, wz);
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
  }, [towns, townSubTiles, field]);

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  // 町の建物・道路は装飾であり選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  return (
    <group>
      {merged.kerbs && <mesh geometry={merged.kerbs} material={MATERIALS.roadKerb} receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.roads && <mesh geometry={merged.roads} material={MATERIALS.roadAsphalt} receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.wallsA && <mesh geometry={merged.wallsA} material={MATERIALS.buildingA} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.wallsB && <mesh geometry={merged.wallsB} material={MATERIALS.buildingB} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.wallsC && <mesh geometry={merged.wallsC} material={MATERIALS.buildingC} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.roofs && <mesh geometry={merged.roofs} material={MATERIALS.buildingRoof} castShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.roofsFlat && <mesh geometry={merged.roofsFlat} material={MATERIALS.buildingRoofFlat} raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}

      {towns.map(town => (
        <Html
          key={town.id}
          position={[town.centre.x, 2.6 + field.cellHeightAt(town.centre.x, town.centre.z) * OVERPASS_HEIGHT, town.centre.z]}
          center
          style={{ pointerEvents: 'none' }}
        >
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
