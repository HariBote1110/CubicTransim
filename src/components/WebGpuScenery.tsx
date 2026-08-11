// R4a: WebGPUモードの樹木フィーダ。three.js の <Scenery> の代わりにマウントされ、
// 同じ純粋関数(render/sceneryGeometry.ts)で作ったジオメトリに陰影を焼き込んで
// wgpu のメッシュチャンクとして載せる。画面には何も描かない(描くのは下層のwgpu)。

import React, { useCallback, useMemo } from 'react';
import type { CellData } from '../types';
import type { TownTileIndex } from '../sim/townTiles';
import type { TerrainField } from '../sim/terrainField';
import { PALETTE } from '../render/palette';
import { bakeGeometries } from '../render/bakedMesh';
import { visibleChunkRange, chunkKey } from '../render/terrainChunks';
import { treeCandidatesInChunk, buildSceneryGeometries } from '../render/sceneryGeometry';
import { MESH_CHUNK_NAMESPACE } from '../render/meshChunkRegistry';
import { useMeshChunkFeeder } from './useMeshChunkFeeder';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

interface Props {
  layerRef: WebGpuLayerRef;
  field: TerrainField;
  railMap: Map<string, CellData>;
  townTiles: TownTileIndex;
  range: number;
  cameraTargetCell: { x: number; z: number };
  viewRadiusCells: number;
  /**
   * 遠景フェード(render/farView.ts の 'dimmed' 段階)の減光係数。1で減光なし。
   *
   * 地下ビューの減光はここでは扱わない: wgpu 側の dim uniform(setDim)が地形と同じ
   * 係数で地表クラスを丸ごと暗くするため、焼き込みで二重に暗くしてはいけない。
   */
  dimMultiplier?: number;
  /** true の間はチャンクを1つも載せない(遠景 'hidden' 段階)。 */
  hidden?: boolean;
}

export const WebGpuScenery: React.FC<Props> = ({
  layerRef, field, railMap, townTiles, range, cameraTargetCell, viewRadiusCells,
  dimMultiplier = 1, hidden = false,
}) => {
  const desiredKeys = useMemo(
    () => (hidden
      ? []
      : visibleChunkRange(cameraTargetCell, viewRadiusCells, range, 1).map(c => chunkKey(c.cx, c.cz))),
    [cameraTargetCell, viewRadiusCells, range, hidden],
  );

  const buildChunk = useCallback((key: string) => {
    const [cx, cz] = key.split(',').map(Number);
    const candidates = treeCandidatesInChunk(field, townTiles, { cx, cz }, range);
    const geometries = buildSceneryGeometries(candidates, railMap, field);
    const options = { multiplier: dimMultiplier };
    const baked = bakeGeometries([
      { geometry: geometries.trunks, colour: PALETTE.trunk, options },
      { geometry: geometries.foliage, colour: PALETTE.foliage, options },
      { geometry: geometries.foliageDark, colour: PALETTE.foliageDark, options },
    ]);
    Object.values(geometries).forEach(g => g?.dispose());
    return baked;
  }, [field, townTiles, range, railMap, dimMultiplier]);

  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.scenery,
    desiredKeys,
    buildChunk,
    version: dimMultiplier,
  });

  return null;
};
