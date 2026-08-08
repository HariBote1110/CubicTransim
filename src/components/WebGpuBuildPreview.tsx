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
import { bakeGeometries, type BakedMeshChunk } from '../render/bakedMesh';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import type { WebGpuTerrainLayerController } from '../render/webgpuLayer';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';
import { useFrame } from '@react-three/fiber';

/** 半透明ボックスの不透明度(classicの meshBasicMaterial opacity=0.45 と同じ)。 */
const PREVIEW_ALPHA = Math.round(0.45 * 255);
const PREVIEW_CHUNK_ID = 0x9100_0001;
const DRAG_CHUNK_ID = 0x9100_0002;

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
}

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

export const WebGpuBuildPreview: React.FC<Props> = ({ layerRef, cells, dragCell }) => {
  const lastControllerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const lastPreviewSigRef = useRef<string>('');
  const lastDragSigRef = useRef<string>('');

  useFrame(() => {
    const controller = layerRef.current;
    if (!controller) return;

    const controllerChanged = lastControllerRef.current !== controller;
    if (controllerChanged) {
      lastControllerRef.current = controller;
      lastPreviewSigRef.current = '';
      lastDragSigRef.current = '';
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
  });

  return null;
};
