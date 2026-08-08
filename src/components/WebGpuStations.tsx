// R4b: WebGPUモードの駅フィーダ。three.js の <StationBlock> の代わりにマウントされ、
// 同じ寸法定数(components/StationBlock.tsx からexport)で作った render/stationGeometry.ts
// のジオメトリに陰影を焼き込んで wgpu のメッシュチャンクとして載せる。
//
// バケット割り(駅1つにつき最大4チャンク):
// - `${stationId}:surface`  地平+高架ホームの構造(床・上屋等、ガラス除く)。layerClass=surface。
//   dim uniformが地形と同じ係数で地表全体を暗くするため、レベルごとの明暗判定は不要
//   (level>=0のホームはundergroundView中つねに一律で暗くなる。three.jsのisLevelDimmedも
//   level>=0のときはselectedLevel(常に負)と一致しないため常にdimmed=trueで揃う)。
// - `${stationId}:glass`    ホームドアのガラス(全レベル合算)。layerClass=translucent、
//   alpha=0.55×255固定。three.jsは地下dim時にガラスだけopacity 0.14まで下げるが、
//   ここでは1chunkに複数レベルのガラスを混在させる簡略化のため区別しない
//   (既知の視覚差としてprogress memoに記録する)。
// - `${stationId}:undergroundBright` 選択中の地下レベルのホーム構造。layerClass=underground。
// - `${stationId}:undergroundDim`    選択中でない地下レベルのホーム構造。layerClass=translucent、
//   alpha=0.3×255(three.jsのDIMMED_MATERIALS opacity 0.3相当)。

import React, { useCallback, useMemo } from 'react';
import type { StationData } from '../types';
import type { StationLayerCell } from '../render/stationLayers';
import type { TerrainField } from '../sim/terrainField';
import { bakeGeometries, type BakedMeshChunk } from '../render/bakedMesh';
import { buildStationCellGeometries, type ShadedGeometryEntry } from '../render/stationGeometry';
import { MESH_CHUNK_NAMESPACE } from '../render/meshChunkRegistry';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { useMeshChunkFeeder } from './useMeshChunkFeeder';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

interface Props {
  layerRef: WebGpuLayerRef;
  groundCells: StationLayerCell[];
  elevatedCells: StationLayerCell[];
  undergroundCells: StationLayerCell[];
  stationEndKeys: Set<string>;
  elevatedEndKeys: Set<string>;
  undergroundEndKeys: Set<string>;
  stations: Map<string, StationData>;
  field: TerrainField;
  undergroundView?: boolean;
  selectedLevel?: number;
}

const UNDERGROUND_DIM_ALPHA = Math.round(0.3 * 255);
const GLASS_ALPHA = Math.round(0.55 * 255);

interface CellEntry {
  cell: StationLayerCell;
  y: number;
  isEnd: boolean;
}

export const WebGpuStations: React.FC<Props> = ({
  layerRef, groundCells, elevatedCells, undergroundCells,
  stationEndKeys, elevatedEndKeys, undergroundEndKeys,
  stations, field, undergroundView = false, selectedLevel = 0,
}) => {
  // 駅idごとにセルをグループ化する(surface=地平+高架、underground=地下)。
  const grouping = useMemo(() => {
    const surfaceByStation = new Map<string, CellEntry[]>();
    const undergroundByStation = new Map<string, CellEntry[]>();

    for (const cell of groundCells) {
      const y = field.cellHeightAt(cell.x, cell.z) * OVERPASS_HEIGHT;
      const list = surfaceByStation.get(cell.stationId) ?? [];
      list.push({ cell, y, isEnd: stationEndKeys.has(cell.key) });
      surfaceByStation.set(cell.stationId, list);
    }
    for (const cell of elevatedCells) {
      const y = (cell.level ?? 1) * OVERPASS_HEIGHT;
      const list = surfaceByStation.get(cell.stationId) ?? [];
      list.push({ cell, y, isEnd: elevatedEndKeys.has(cell.key) });
      surfaceByStation.set(cell.stationId, list);
    }
    for (const cell of undergroundCells) {
      const y = (cell.level ?? -1) * OVERPASS_HEIGHT;
      const list = undergroundByStation.get(cell.stationId) ?? [];
      list.push({ cell, y, isEnd: undergroundEndKeys.has(cell.key) });
      undergroundByStation.set(cell.stationId, list);
    }
    return { surfaceByStation, undergroundByStation };
  }, [groundCells, elevatedCells, undergroundCells, stationEndKeys, elevatedEndKeys, undergroundEndKeys, field]);

  const cellGeometries = useCallback((entry: CellEntry): ShadedGeometryEntry[] =>
    buildStationCellGeometries(
      [entry.cell.x, entry.y, entry.cell.z],
      entry.cell.connections,
      stations.get(entry.cell.stationId)?.platformDoors ?? 'none',
      entry.isEnd,
    ), [stations]);

  const surfaceKeys = useMemo(() => [...grouping.surfaceByStation.keys()], [grouping]);
  const undergroundKeys = useMemo(() => [...grouping.undergroundByStation.keys()], [grouping]);
  const glassKeys = useMemo(
    () => [...new Set([...surfaceKeys, ...(undergroundView ? undergroundKeys : [])])],
    [surfaceKeys, undergroundKeys, undergroundView],
  );
  const brightKeys = useMemo(
    () => (undergroundView ? undergroundKeys.filter(id =>
      grouping.undergroundByStation.get(id)!.some(e => (e.cell.level ?? -1) === selectedLevel)) : []),
    [undergroundView, undergroundKeys, grouping, selectedLevel],
  );
  const dimKeys = useMemo(
    () => (undergroundView ? undergroundKeys.filter(id =>
      grouping.undergroundByStation.get(id)!.some(e => (e.cell.level ?? -1) !== selectedLevel)) : []),
    [undergroundView, undergroundKeys, grouping, selectedLevel],
  );

  const buildSurfaceChunk = useCallback((stationId: string): BakedMeshChunk | null => {
    const cells = grouping.surfaceByStation.get(stationId);
    if (!cells) return null;
    const entries = cells.flatMap(cellGeometries).filter(e => !e.translucent);
    return bakeGeometries(entries.map(e => ({ geometry: e.geometry, colour: e.colour })));
  }, [grouping, cellGeometries]);

  const buildGlassChunk = useCallback((stationId: string): BakedMeshChunk | null => {
    const surfaceCells = grouping.surfaceByStation.get(stationId) ?? [];
    const undergroundList = undergroundView ? (grouping.undergroundByStation.get(stationId) ?? []) : [];
    const entries = [...surfaceCells, ...undergroundList].flatMap(cellGeometries).filter(e => e.translucent);
    const options = { alpha: GLASS_ALPHA };
    return bakeGeometries(entries.map(e => ({ geometry: e.geometry, colour: e.colour, options })));
  }, [grouping, cellGeometries, undergroundView]);

  const buildUndergroundChunk = useCallback((stationId: string, bright: boolean): BakedMeshChunk | null => {
    const cells = grouping.undergroundByStation.get(stationId);
    if (!cells) return null;
    const filtered = cells.filter(e => ((e.cell.level ?? -1) === selectedLevel) === bright);
    const entries = filtered.flatMap(cellGeometries).filter(e => !e.translucent);
    const options = bright ? undefined : { alpha: UNDERGROUND_DIM_ALPHA };
    return bakeGeometries(entries.map(e => ({ geometry: e.geometry, colour: e.colour, options })));
  }, [grouping, cellGeometries, selectedLevel]);

  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.station,
    desiredKeys: surfaceKeys,
    buildChunk: buildSurfaceChunk,
    layerClass: MESH_LAYER_CLASS.surface,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.stationGlass,
    desiredKeys: glassKeys,
    buildChunk: buildGlassChunk,
    layerClass: MESH_LAYER_CLASS.translucent,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.stationUndergroundBright,
    desiredKeys: brightKeys,
    buildChunk: (id: string) => buildUndergroundChunk(id, true),
    layerClass: MESH_LAYER_CLASS.underground,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.stationUndergroundDim,
    desiredKeys: dimKeys,
    buildChunk: (id: string) => buildUndergroundChunk(id, false),
    layerClass: MESH_LAYER_CLASS.translucent,
  });

  return null;
};
