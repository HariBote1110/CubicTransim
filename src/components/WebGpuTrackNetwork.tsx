// R4b: WebGPUモードの線路網フィーダ。three.js の <TrackNetwork> の代わりにマウントされ、
// 同じ純粋関数(render/railGeometry.ts の buildRailNetworkGeometry)で作ったジオメトリに
// 陰影を焼き込んで wgpu のメッシュチャンクとして載せる。画面には何も描かない。
//
// レール網は自機が敷いた線路だけでスパースなため、TrackNetwork.tsx の useMemo と同様
// railMap 全体を1回で計算し、few チャンク(surface 1つ + underground bright/dim 各1つ)に
// まとめる(FAR_VIEW_RAIL_CELL_BUDGET は呼び出し側 GameScene.tsx が今まで通り担う)。
//
// 地下ビューの明暗: 地表(level>=0)は wgpu の dim uniform が地形と同じ係数で担当するため、
// surface チャンクは常に layerClass=surface(0)のまま。地下(level<0)は選択中レベルと
// 一致する bright を layerClass=underground(1、深度無視・常時フル輝度)、それ以外の
// dim を layerClass=translucent(2、alpha≈0.3相当)で描き、three.js の
// DIMMED_MATERIALS(opacity 0.3)の見た目を近似する(3クラスの範囲で再現できる近似であり、
// 新しいクラスは追加していない)。

import React, { useCallback, useMemo } from 'react';
import type { CellData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { PALETTE } from '../render/palette';
import { bakeGeometries, type BakedMeshChunk } from '../render/bakedMesh';
import { buildRailNetworkGeometry } from '../render/railGeometry';
import { MESH_CHUNK_NAMESPACE } from '../render/meshChunkRegistry';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import { useMeshChunkFeeder } from './useMeshChunkFeeder';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

interface Props {
  layerRef: WebGpuLayerRef;
  railMap: Map<string, CellData>;
  field: TerrainField;
  undergroundView?: boolean;
  selectedLevel?: number;
}

/** 地下の非選択レベルを近似する半透明の不透明度(0..255)。three.jsのopacity 0.3相当。 */
const UNDERGROUND_DIM_ALPHA = Math.round(0.3 * 255);

const SURFACE_KEY = 'surface';
const UNDERGROUND_BRIGHT_KEY = 'undergroundBright';
const UNDERGROUND_DIM_KEY = 'undergroundDim';

export const WebGpuTrackNetwork: React.FC<Props> = ({
  layerRef, railMap, field, undergroundView = false, selectedLevel = 0,
}) => {
  const geometry = useMemo(
    () => buildRailNetworkGeometry(railMap, field, undergroundView, selectedLevel),
    [railMap, field, undergroundView, selectedLevel],
  );

  const buildChunk = useCallback((key: string): BakedMeshChunk | null => {
    if (key === SURFACE_KEY) {
      return bakeGeometries([
        { geometry: geometry.surface.decks, colour: PALETTE.overpassDeck },
        { geometry: geometry.surface.piers, colour: PALETTE.overpassPier },
        { geometry: geometry.surface.abutments, colour: PALETTE.overpassPier },
        { geometry: geometry.surface.ballast, colour: PALETTE.ballast },
        { geometry: geometry.surface.sleepers, colour: PALETTE.sleeper },
        { geometry: geometry.surface.rails, colour: PALETTE.railSteel },
        { geometry: geometry.openings, colour: PALETTE.undergroundPit },
      ]);
    }
    if (key === UNDERGROUND_BRIGHT_KEY) {
      return bakeGeometries([
        { geometry: geometry.undergroundBright.ballast, colour: PALETTE.ballast },
        { geometry: geometry.undergroundBright.sleepers, colour: PALETTE.sleeper },
        { geometry: geometry.undergroundBright.rails, colour: PALETTE.railSteel },
      ]);
    }
    if (key === UNDERGROUND_DIM_KEY) {
      const options = { alpha: UNDERGROUND_DIM_ALPHA };
      return bakeGeometries([
        { geometry: geometry.undergroundDim.ballast, colour: PALETTE.ballast, options },
        { geometry: geometry.undergroundDim.sleepers, colour: PALETTE.sleeper, options },
        { geometry: geometry.undergroundDim.rails, colour: PALETTE.railSteel, options },
      ]);
    }
    return null;
  }, [geometry]);

  // surfaceは常にsurfaceクラス、bright/dimはlayerClassが違うのでチャンクidの
  // 名前空間内で描画クラスを分ける必要がある。useMeshChunkFeederはlayerClassを
  // 1回しか受け取れないため、3つの独立したフィーダとして呼び出す。
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.railSurface,
    desiredKeys: [SURFACE_KEY],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.surface,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.railUndergroundBright,
    desiredKeys: undergroundView ? [UNDERGROUND_BRIGHT_KEY] : [],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.underground,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.railUndergroundDim,
    desiredKeys: undergroundView ? [UNDERGROUND_DIM_KEY] : [],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.translucent,
  });

  return null;
};
