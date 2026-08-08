// R4d: 遠景(全図ズームアウト、render/farView.ts の hidden 段階)の町ドット。
// three.js の <TownMarkers>(PointsMaterial の sizeAttenuation:false)を退役させ、
// wgpu のインスタンス描画へ移した。
//
// three.js 版は「画面上つねに MARKER_PIXEL_SIZE ピクセル」という点描画で、ワールド単位の
// ジオメトリがサブピクセルへ潰れる問題を回避していた。wgpu のインスタンス API には
// スケール要素が無い(stride は [x,y,z,yaw,pitch,tintRGB,flags,予約])ため、
// **プロトタイプメッシュ自体をズームに応じた大きさで作り直す**ことで同じ効果を出す。
// 作り直しは 8 頂点のダイヤ1個ぶんなので、ズームが一定比率を超えて変わったときにだけ
// 呼んでも十分安い(インスタンス配列は町数ぶんで、町/地形が変わらない限り再送しない)。

import React, { useRef } from 'react';
import * as THREE from 'three';
import type { TownData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { bakeGeometries, parseColourHex } from '../render/bakedMesh';
import { MESH_INSTANCE_STRIDE } from '../render/webgpuLayer';
import type { WebGpuTerrainLayerController } from '../render/webgpuLayer';
import { toWebGpuCameraState, type GameCameraState, type ViewportSize } from '../render/cameraState';
import { FRAME_ORDER } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

/** インスタンスメッシュid(WebGpuTrains.tsx の 0x9000_000x とは別番地)。 */
const MESH_ID_TOWN_MARKER = 0x9200_0001;

/** 画面上で確保したいドットのおおよその物理ピクセル径(three.js 版の MARKER_PIXEL_SIZE 相当)。 */
export const TOWN_MARKER_PIXEL_SIZE = 10;

/** 人口による色分け(three.js 版の TownMarkers.tsx から引き継いだ遠景専用ティア)。 */
export const TOWN_MARKER_TIER_COLOURS = ['#8fae6b', '#d9b45c', '#e08a4d', '#c9524f'];
const TIER_THRESHOLDS = [0, 2000, 6000, 12000];

export const townMarkerTierIndex = (population: number): number => {
  let index = 0;
  for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
    if (population >= TIER_THRESHOLDS[i]) index = i;
  }
  return index;
};

/** プロトタイプを作り直すズームの刻み(この比率を超えて変わったときだけ再登録する)。 */
const SIZE_REBUILD_RATIO = 1.35;

const buildMarkerMesh = (sizeWorld: number) => {
  const geometry = new THREE.OctahedronGeometry(sizeWorld / 2, 0);
  // 頂点色は白+alpha=255(=tint をそのまま最終色にする規約。R4a 実装メモ参照)。
  const baked = bakeGeometries([{ geometry, colour: '#ffffff', options: { alpha: 255 } }]);
  geometry.dispose();
  return baked;
};

interface Props {
  layerRef: WebGpuLayerRef;
  towns: readonly TownData[];
  field: TerrainField;
  cameraRef: React.RefObject<GameCameraState>;
  viewportRef: React.RefObject<ViewportSize>;
  /** false の間はインスタンスを空にする(近景では詳細な町メッシュが出るため)。 */
  active: boolean;
}

export const WebGpuTownMarkers: React.FC<Props> = ({
  layerRef, towns, field, cameraRef, viewportRef, active,
}) => {
  const lastControllerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const lastSizeRef = useRef(0);
  const lastSignatureRef = useRef('');
  const dataRef = useRef(new Float32Array(0));

  useFrameLoop(FRAME_ORDER.feed, () => {
    const controller = layerRef.current;
    if (!controller) return;

    const controllerChanged = lastControllerRef.current !== controller;
    if (controllerChanged) {
      lastControllerRef.current = controller;
      lastSizeRef.current = 0;
      lastSignatureRef.current = '';
    }

    if (!active) {
      if (lastSignatureRef.current !== 'off') {
        lastSignatureRef.current = 'off';
        controller.setInstances(MESH_ID_TOWN_MARKER, new Float32Array(0));
      }
      return;
    }

    const camera = toWebGpuCameraState(cameraRef.current, viewportRef.current);
    const sizeWorld = TOWN_MARKER_PIXEL_SIZE / Math.max(1e-6, camera.pixelsPerUnit);
    const previous = lastSizeRef.current;
    if (previous <= 0 || sizeWorld / previous > SIZE_REBUILD_RATIO || previous / sizeWorld > SIZE_REBUILD_RATIO) {
      const mesh = buildMarkerMesh(sizeWorld);
      if (mesh) controller.registerInstancedMesh(MESH_ID_TOWN_MARKER, mesh);
      lastSizeRef.current = sizeWorld;
    }

    // インスタンス配列は町・地形・高さが変わったときだけ組み直す(位置は静的)。
    const signature = `${towns.length}:${lastSizeRef.current.toFixed(4)}`;
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;

    if (dataRef.current.length !== towns.length * MESH_INSTANCE_STRIDE) {
      dataRef.current = new Float32Array(towns.length * MESH_INSTANCE_STRIDE);
    }
    const data = dataRef.current;
    for (let i = 0; i < towns.length; i++) {
      const town = towns[i];
      const [r, g, b] = parseColourHex(TOWN_MARKER_TIER_COLOURS[townMarkerTierIndex(town.population)]);
      const offset = i * MESH_INSTANCE_STRIDE;
      data[offset] = town.centre.x;
      data[offset + 1] = field.cellHeightAt(town.centre.x, town.centre.z) * OVERPASS_HEIGHT + lastSizeRef.current;
      data[offset + 2] = town.centre.z;
      data[offset + 3] = 0;
      data[offset + 4] = 0;
      data[offset + 5] = r;
      data[offset + 6] = g;
      data[offset + 7] = b;
      data[offset + 8] = 0;
      data[offset + 9] = 0;
    }
    controller.setInstances(MESH_ID_TOWN_MARKER, data);
  });

  return null;
};
