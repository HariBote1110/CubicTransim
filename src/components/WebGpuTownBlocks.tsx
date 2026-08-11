// R4a: WebGPUモードの町フィーダ。three.js の <TownBlocks> の代わりにマウントされ、
// 同じ純粋関数(render/townGeometry.ts)で作ったジオメトリに陰影を焼き込んで
// wgpu のメッシュチャンクとして載せる。チャンクの単位は町1つ(町idがキー)。
//
// 町名ラベル(drei Html)は R4c で素のDOMオーバーレイへ置き換えるまで three.js 側の
// TownLabels をそのまま使うため、ここでは描画物を持たない。

import React, { useCallback, useMemo } from 'react';
import type { TownData } from '../types';
import type { TownTileCache } from '../sim/townTiles';
import type { TerrainField } from '../sim/terrainField';
import { PALETTE } from '../render/palette';
import { bakeGeometries } from '../render/bakedMesh';
import { buildTownGeometries } from '../render/townGeometry';
import { MESH_CHUNK_NAMESPACE } from '../render/meshChunkRegistry';
import { useMeshChunkFeeder } from './useMeshChunkFeeder';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

interface Props {
  layerRef: WebGpuLayerRef;
  /** 可視範囲に交差する町だけ(GameScene の visibleTowns)。 */
  towns: readonly TownData[];
  /** サブタイルを町単位で遅延生成するキャッシュ(useGameLogic の townTileIndex)。 */
  townTiles: TownTileCache;
  field: TerrainField;
  /** 遠景フェードの減光係数(WebGpuScenery と同じ扱い。地下ビューは dim uniform 側の担当)。 */
  dimMultiplier?: number;
}

export const WebGpuTownBlocks: React.FC<Props> = ({
  layerRef, towns, townTiles, field, dimMultiplier = 1,
}) => {
  const townById = useMemo(() => new Map(towns.map(t => [t.id, t])), [towns]);
  const desiredKeys = useMemo(() => towns.map(t => t.id), [towns]);

  const buildChunk = useCallback((townId: string) => {
    const town = townById.get(townId);
    if (!town) return null;
    const subTiles = townTiles.subTilesForTowns([townId]);
    const geometries = buildTownGeometries([town], subTiles, field);
    const options = { multiplier: dimMultiplier };
    const baked = bakeGeometries([
      { geometry: geometries.kerbs, colour: PALETTE.roadKerb, options },
      { geometry: geometries.roads, colour: PALETTE.roadAsphalt, options },
      { geometry: geometries.wallsA, colour: PALETTE.buildingA, options },
      { geometry: geometries.wallsB, colour: PALETTE.buildingB, options },
      { geometry: geometries.wallsC, colour: PALETTE.buildingC, options },
      { geometry: geometries.roofs, colour: PALETTE.buildingRoof, options },
      { geometry: geometries.roofsFlat, colour: PALETTE.buildingRoofFlat, options },
    ]);
    Object.values(geometries).forEach(g => g?.dispose());
    return baked;
  }, [townById, townTiles, field, dimMultiplier]);

  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.town,
    desiredKeys,
    buildChunk,
    version: dimMultiplier,
  });

  return null;
};
