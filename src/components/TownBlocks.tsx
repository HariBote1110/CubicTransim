import React, { useEffect, useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { TownData } from '../types';
import type { TownSubTileIndex } from '../sim/townTiles';
import { materialsFor } from '../render/palette';
import { SURFACE_RENDER_ORDER } from '../render/viewMode';
import type { TerrainField } from '../sim/terrainField';
import { buildTownGeometries, formatPopulation } from '../render/townGeometry';
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

/**
 * タイルベースの町の描画(従来=three.jsモード)。ジオメトリ生成は
 * render/townGeometry.ts の純粋関数にあり、WebGPUモードのフィーダ
 * (WebGpuTownBlocks.tsx)と共有している。
 * 千サブタイル規模になるためマテリアルごとにジオメトリをマージして少数ドローコールに収める。
 */
export const TownBlocks: React.FC<Props> = ({ towns, townSubTiles, field, dimmed = false }) => {
  const MATERIALS = materialsFor(dimmed);
  const merged = useMemo(
    () => buildTownGeometries(towns, townSubTiles, field),
    [towns, townSubTiles, field],
  );

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

      <TownLabels towns={towns} field={field} />
    </group>
  );
};

/**
 * 町名+人口のDOMラベル(drei Html)。WebGPUモードのフィーダからも使うため
 * 独立したコンポーネントに切り出してある(R4cで素のDOMオーバーレイへ置き換える予定)。
 */
export const TownLabels: React.FC<{ towns: readonly TownData[]; field: TerrainField }> = ({ towns, field }) => (
  <>
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
  </>
);
