// R4c: WebGPUモードの建設プレビュー・列車ドラッグ配置ゴースト。
//
// classicモードは GameScene.tsx 内の three.js <mesh> オーバーレイ(半透明ボックス)を
// そのまま使う(透過三.jsキャンバスが常に最前面にあるため、wgpu地形の上に正しく
// 合成される。実際 R4c 実装中の検証でも classic 用のこのコードは webgpu モードでも
// 何も手を入れずに正しく表示されていた)。ここでは R4d の three.js 全面退役に備え、
// 同じ見た目を wgpu のメッシュチャンク(半透明クラス)で再現する版を用意する。
//
// 簡略化(意図的): classicの地平レール(buildMode==='rail'&&buildLevel===0)プレビューは
// RailBlockの実レールジオメトリ(バラスト・枕木・レール)を出すが、ここでは他の建設
// プレビューと同じ「半透明ボックス」に統一する。GameScene.tsx のレールプレビュー実装が
// 元々「確定前は簡略化する」設計(P7c、design memo「keep it simple」)を踏襲した判断で、
// 見た目の差は色付きボックスの有無程度に留まる。

import React, { useRef } from 'react';
import * as THREE from 'three';
import { FRAME_ORDER } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';
import { bakeGeometries, type BakedMeshChunk } from '../render/bakedMesh';
import { mergeAndDispose } from '../render/mergeGeometry';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import type { WebGpuTerrainLayerController } from '../render/webgpuLayer';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

/** 半透明ボックスの不透明度(classicの meshBasicMaterial opacity=0.45 と同じ)。 */
const PREVIEW_ALPHA = Math.round(0.45 * 255);
const PREVIEW_CHUNK_ID = 0x9100_0001;
const DRAG_CHUNK_ID = 0x9100_0002;
const GRID_CHUNK_ID = 0x9100_0003;

/** R4d: 建設モードのグリッド(旧 three.js gridHelper の代替)。中心セルからの片側セル数。 */
const GRID_HALF_CELLS = 48;
/** グリッド線の太さ(ワールド単位)と高さ。旧 gridHelper と同じく地表すれすれに置く。 */
const GRID_LINE_WIDTH = 0.03;
const GRID_LINE_Y = 0.004;
const GRID_COLOUR = '#9fbb84';
const GRID_ALPHA = Math.round(0.5 * 255);
/** グリッドを作り直す間隔(中心セルがこのセル数だけ動いたら作り直す)。 */
const GRID_SNAP_CELLS = 8;

export interface PreviewGhostCell {
  x: number;
  y: number;
  z: number;
  colour: string;
}

interface Props {
  layerRef: WebGpuLayerRef;
  /** 建設プレビューのセル一覧(GameSceneのpreviewPath相当、色・高さ計算済み)。 */
  cells: readonly PreviewGhostCell[];
  /** 列車ドラッグ中の置き先ゴースト(無ければnull)。 */
  dragCell?: PreviewGhostCell | null;
  /**
   * 建設グリッドの中心セル(null で非表示)。旧 GameScene の
   * `buildMode !== 'none' && <gridHelper .../>` と同じ「建設中だけ出す」規則。
   */
  gridCentre?: { x: number; z: number } | null;
}

/** 中心セル周りの格子線を、細い板(quad)の集まりとして焼き込む。 */
const buildGridChunk = (centre: { x: number; z: number }): BakedMeshChunk | null => {
  const geometries: THREE.BufferGeometry[] = [];
  const span = GRID_HALF_CELLS * 2;
  // セル境界(±0.5 オフセット)へ線を置く。gridHelper と同じ見え方。
  for (let i = -GRID_HALF_CELLS; i <= GRID_HALF_CELLS; i++) {
    const alongZ = new THREE.BoxGeometry(GRID_LINE_WIDTH, 0.001, span);
    alongZ.translate(centre.x + i + 0.5, GRID_LINE_Y, centre.z + 0.5);
    geometries.push(alongZ);
    const alongX = new THREE.BoxGeometry(span, 0.001, GRID_LINE_WIDTH);
    alongX.translate(centre.x + 0.5, GRID_LINE_Y, centre.z + i + 0.5);
    geometries.push(alongX);
  }
  const merged = mergeAndDispose(geometries);
  if (!merged) return null;
  const baked = bakeGeometries([{ geometry: merged, colour: GRID_COLOUR, options: { alpha: GRID_ALPHA } }]);
  merged.dispose();
  return baked;
};

const buildBoxChunk = (cells: readonly PreviewGhostCell[]): BakedMeshChunk | null => {
  if (cells.length === 0) return null;
  const geometries: THREE.BoxGeometry[] = [];
  const entries = cells.map(cell => {
    const geometry = new THREE.BoxGeometry(0.92, 0.4, 0.92);
    geometry.translate(cell.x, cell.y, cell.z);
    geometries.push(geometry);
    return { geometry, colour: cell.colour, options: { alpha: PREVIEW_ALPHA } };
  });
  const baked = bakeGeometries(entries);
  geometries.forEach(g => g.dispose());
  return baked;
};

/** cellsの中身が変わったかどうかを安価に判定するための署名文字列。 */
const signatureOf = (cells: readonly PreviewGhostCell[]): string =>
  cells.map(c => `${c.x},${c.y.toFixed(3)},${c.z},${c.colour}`).join('|');

export const WebGpuBuildPreview: React.FC<Props> = ({ layerRef, cells, dragCell, gridCentre = null }) => {
  const lastControllerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const lastPreviewSigRef = useRef<string>('');
  const lastDragSigRef = useRef<string>('');
  const lastGridSigRef = useRef<string>('');

  useFrameLoop(FRAME_ORDER.feed, () => {
    const controller = layerRef.current;
    if (!controller) return;

    const controllerChanged = lastControllerRef.current !== controller;
    if (controllerChanged) {
      lastControllerRef.current = controller;
      lastPreviewSigRef.current = '';
      lastDragSigRef.current = '';
      lastGridSigRef.current = '';
    }

    const previewSig = signatureOf(cells);
    if (controllerChanged || previewSig !== lastPreviewSigRef.current) {
      lastPreviewSigRef.current = previewSig;
      const chunk = buildBoxChunk(cells);
      if (chunk) controller.uploadMeshChunk(PREVIEW_CHUNK_ID, MESH_LAYER_CLASS.translucent, chunk);
      else controller.removeMeshChunk(PREVIEW_CHUNK_ID);
    }

    const dragCells = dragCell ? [dragCell] : [];
    const dragSig = signatureOf(dragCells);
    if (controllerChanged || dragSig !== lastDragSigRef.current) {
      lastDragSigRef.current = dragSig;
      const chunk = buildBoxChunk(dragCells);
      if (chunk) controller.uploadMeshChunk(DRAG_CHUNK_ID, MESH_LAYER_CLASS.translucent, chunk);
      else controller.removeMeshChunk(DRAG_CHUNK_ID);
    }

    // 建設グリッド。中心セルを GRID_SNAP_CELLS でスナップして、少し動いただけでは
    // 作り直さないようにする(パンのたびに 194 本の板を焼き直さないため)。
    const snapped = gridCentre
      ? {
        x: Math.round(gridCentre.x / GRID_SNAP_CELLS) * GRID_SNAP_CELLS,
        z: Math.round(gridCentre.z / GRID_SNAP_CELLS) * GRID_SNAP_CELLS,
      }
      : null;
    const gridSig = snapped ? `${snapped.x},${snapped.z}` : '';
    if (controllerChanged || gridSig !== lastGridSigRef.current) {
      lastGridSigRef.current = gridSig;
      const chunk = snapped ? buildGridChunk(snapped) : null;
      if (chunk) controller.uploadMeshChunk(GRID_CHUNK_ID, MESH_LAYER_CLASS.translucent, chunk);
      else controller.removeMeshChunk(GRID_CHUNK_ID);
    }
  });

  return null;
};
