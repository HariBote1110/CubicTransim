// R4b: WebGPUモードの車庫・信号・トンネル坑口・水上橋フィーダ。
// いずれも常にレベル0(地平)相当で、地下ビューのdim/bright振り分けを必要としない
// (DepotBlock/SignalBlockはそもそもdimmed propを持たず、坑口・水上橋も地平/高架のみ)ため、
// すべてlayerClass=surfaceの単純な1〜2チャンクにまとめる。

import React, { useCallback } from 'react';
import type { CellData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { fromKey } from '../utils';
import { bakeGeometries, type BakedMeshChunk } from '../render/bakedMesh';
import { buildDepotGeometries } from '../render/depotGeometry';
import { buildSubstationGeometries } from '../render/substationGeometry';
import { buildSignalGeometries } from '../render/signalGeometry';
import { buildTunnelPortalGeometries, type TunnelPortalLike } from '../render/tunnelPortalMeshGeometry';
import { buildWaterBridgeGeometries } from '../render/waterBridgeGeometry';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { MESH_CHUNK_NAMESPACE } from '../render/meshChunkRegistry';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import { useMeshChunkFeeder } from './useMeshChunkFeeder';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

interface Props {
  layerRef: WebGpuLayerRef;
  railMap: Map<string, CellData>;
  field: TerrainField;
  tunnelPortalList: readonly TunnelPortalLike[];
}

const DEPOT_KEY = 'depots';
const SUBSTATION_KEY = 'substations';
const SIGNAL_KEY = 'signals';
const PORTAL_KEY = 'portals';
const BRIDGE_KEY = 'bridges';

export const WebGpuTrackExtras: React.FC<Props> = ({ layerRef, railMap, field, tunnelPortalList }) => {
  const buildDepotChunk = useCallback((): BakedMeshChunk | null => {
    const entries = [...railMap.entries()].flatMap(([key, data]) => {
      if (data.type !== 'depot') return [];
      const { x, z } = fromKey(key);
      const groundY = field.cellHeightAt(x, z) * OVERPASS_HEIGHT;
      return buildDepotGeometries([x, groundY, z], data.rotation ?? 0);
    });
    return bakeGeometries(entries.map(e => ({ geometry: e.geometry, colour: e.colour })));
  }, [railMap, field]);

  // PM4: 変電所。車庫と同じくrailMap上のセル1つとして持つ(常に地平)。
  const buildSubstationChunk = useCallback((): BakedMeshChunk | null => {
    const entries = [...railMap.entries()].flatMap(([key, data]) => {
      if (data.type !== 'substation') return [];
      const { x, z } = fromKey(key);
      const groundY = field.cellHeightAt(x, z) * OVERPASS_HEIGHT;
      return buildSubstationGeometries([x, groundY, z]);
    });
    return bakeGeometries(entries.map(e => ({ geometry: e.geometry, colour: e.colour })));
  }, [railMap, field]);

  const buildSignalChunk = useCallback((): BakedMeshChunk | null => {
    const entries = [...railMap.entries()].flatMap(([key, data]) => {
      if (!data.signalDir) return [];
      const { x, z } = fromKey(key);
      const groundY = field.cellHeightAt(x, z) * OVERPASS_HEIGHT;
      return buildSignalGeometries([x, groundY + 0.05, z], data.signalDir, data.signalKind ?? 'block');
    });
    const opaque = entries.filter(e => !e.translucent).map(e => ({ geometry: e.geometry, colour: e.colour }));
    return bakeGeometries(opaque);
  }, [railMap, field]);

  const buildSignalMarkerChunk = useCallback((): BakedMeshChunk | null => {
    const entries = [...railMap.entries()].flatMap(([key, data]) => {
      if (!data.signalDir) return [];
      const { x, z } = fromKey(key);
      const groundY = field.cellHeightAt(x, z) * OVERPASS_HEIGHT;
      return buildSignalGeometries([x, groundY + 0.05, z], data.signalDir, data.signalKind ?? 'block');
    });
    const translucent = entries.filter(e => e.translucent);
    const options = { alpha: Math.round(0.6 * 255) };
    return bakeGeometries(translucent.map(e => ({ geometry: e.geometry, colour: e.colour, options })));
  }, [railMap, field]);

  const buildPortalChunk = useCallback((): BakedMeshChunk | null => {
    const entries = buildTunnelPortalGeometries(tunnelPortalList, field);
    return bakeGeometries(entries.map(e => ({ geometry: e.geometry, colour: e.colour })));
  }, [tunnelPortalList, field]);

  const buildBridgeChunk = useCallback((): BakedMeshChunk | null => {
    const entries = buildWaterBridgeGeometries(railMap);
    return bakeGeometries(entries.map(e => ({ geometry: e.geometry, colour: e.colour })));
  }, [railMap]);

  const buildChunk = useCallback((key: string): BakedMeshChunk | null => {
    if (key === DEPOT_KEY) return buildDepotChunk();
    if (key === SUBSTATION_KEY) return buildSubstationChunk();
    if (key === SIGNAL_KEY) return buildSignalChunk();
    if (key === PORTAL_KEY) return buildPortalChunk();
    if (key === BRIDGE_KEY) return buildBridgeChunk();
    return null;
  }, [buildDepotChunk, buildSubstationChunk, buildSignalChunk, buildPortalChunk, buildBridgeChunk]);

  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.depot,
    desiredKeys: [DEPOT_KEY],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.surface,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.substation,
    desiredKeys: [SUBSTATION_KEY],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.surface,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.signal,
    desiredKeys: [SIGNAL_KEY],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.surface,
  });
  useMeshChunkFeeder({
    layerRef,
    // 信号の地面マーカー(半透明)は別のフィーダインスタンス(=別のMeshChunkRegistry)
    // なので、同じnamespaceを使うとidがsignalチャンクと衝突する。専用の名前空間を使う。
    namespace: MESH_CHUNK_NAMESPACE.signalMarker,
    desiredKeys: ['signalMarkers'],
    buildChunk: buildSignalMarkerChunk,
    layerClass: MESH_LAYER_CLASS.translucent,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.tunnelPortal,
    desiredKeys: [PORTAL_KEY],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.surface,
  });
  useMeshChunkFeeder({
    layerRef,
    namespace: MESH_CHUNK_NAMESPACE.waterBridge,
    desiredKeys: [BRIDGE_KEY],
    buildChunk,
    layerClass: MESH_LAYER_CLASS.surface,
  });

  return null;
};
