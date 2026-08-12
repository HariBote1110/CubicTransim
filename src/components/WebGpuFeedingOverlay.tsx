// PM4フォローアップ: き電区間の可視化オーバーレイ。変電所ツール使用中(buildMode==='substation'、
// rules.electrification==='feeding'のときしかこのツールは無いのでこの条件だけで十分)だけ、
// 地平の電化railセルを給電状態で塗り分けた半透明の板を出す。WebGpuBuildPreview.tsxと同じ
// 「メッシュチャンクを署名が変わったときだけ焼き直す」パターンを踏襲する。
//
// 変電所セルはより強調した高さ・不透明度のリングもどき(単純化して背の高い板)にする。
// 容量超過(overload)の判定は、SimWorldの`feedingSectionCounts`(stepWorldが1tick分
// 先に数えた在線数、simulation.ts参照)が得られる場合だけ行う。得られない(worldRef未反映の
// 初回フレーム等)ときはgreen/redのみにフォールバックする。

import React, { useRef } from 'react';
import * as THREE from '../render/geom';
import { FRAME_ORDER } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';
import { bakeGeometries, type BakedMeshChunk } from '../render/bakedMesh';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import type { WebGpuTerrainLayerController } from '../render/webgpuLayer';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';
import { buildFeedingOverlayCells, type FeedingOverlayCell, type FeedingOverlayColourKind } from '../render/feedingOverlay';
import type { SimWorld } from '../sim/simulation';
import type { CellData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

const FEEDING_OVERLAY_CHUNK_ID = 0x9200_0001;

/** 通常セルの板の不透明度(WebGpuBuildPreviewのPREVIEW_ALPHAと同じ0.45相当)。 */
const PLATE_ALPHA = Math.round(0.45 * 255);
/** 変電所セルは目立たせるため、より不透明に。 */
const SUBSTATION_ALPHA = Math.round(0.7 * 255);

/**
 * 薄い板(タスク仕様の0.05高)。render/trackGeometry.tsのRAIL_TOP(0.13、バラスト+レール
 * 頭頂の高さ)より下に置くとバラスト(BALLAST_WIDTH=0.5の不透明ボックス)に埋もれて
 * 見えなくなる(実機検証で発覚)。レール頭頂より上へ最小限持ち上げて可視化する。
 */
const PLATE_HEIGHT = 0.05;
const PLATE_CLEARANCE_ABOVE_RAIL = 0.13;
const PLATE_Y = PLATE_CLEARANCE_ABOVE_RAIL + PLATE_HEIGHT / 2 + 0.01;
/** 変電所の板は少し背を高くして強調する(同じくレール頭頂より上から積む)。 */
const SUBSTATION_HEIGHT = 0.5;
const SUBSTATION_Y = PLATE_CLEARANCE_ABOVE_RAIL + SUBSTATION_HEIGHT / 2 + 0.01;

const COLOUR_BY_KIND: Record<FeedingOverlayColourKind, string> = {
  powered: '#34d399',
  unpowered: '#f87171',
  overload: '#fb923c',
  substation: '#38b6ff',
};

interface Props {
  layerRef: WebGpuLayerRef;
  railMap: Map<string, CellData>;
  /** feeding索引・直近tickの在線数はworldRefから毎フレーム読む(WebGpuTrainsと同じ生鮮参照パターン)。 */
  world: React.RefObject<SimWorld>;
  /**
   * 地形field(GameScene props と同じ)。板のyへ`cellHeightAt(x,z)*OVERPASS_HEIGHT`ぶんの
   * 標高オフセットを足すのに使う(render/townGeometry.ts等と同じ変換式)。これが無いと
   * 平坦でない地平(丘・自動トンネル部)で板が地形の中に埋もれて見えなくなる(実機検証で発覚)。
   */
  field: TerrainField;
  /** 変電所ツールが選択中のときだけ表示する(タスク仕様どおり、専用トグルは無い)。 */
  active: boolean;
}

const buildOverlayChunk = (cells: readonly FeedingOverlayCell[], field: TerrainField): BakedMeshChunk | null => {
  if (cells.length === 0) return null;
  const geometries: THREE.BoxGeometry[] = [];
  const entries = cells.map(cell => {
    const isSubstation = cell.colourKind === 'substation';
    const height = isSubstation ? SUBSTATION_HEIGHT : PLATE_HEIGHT;
    const baseY = isSubstation ? SUBSTATION_Y : PLATE_Y;
    const y = baseY + field.cellHeightAt(cell.x, cell.z) * OVERPASS_HEIGHT;
    const geometry = new THREE.BoxGeometry(0.92, height, 0.92);
    geometry.translate(cell.x, y, cell.z);
    geometries.push(geometry);
    return {
      geometry,
      colour: COLOUR_BY_KIND[cell.colourKind],
      options: { alpha: isSubstation ? SUBSTATION_ALPHA : PLATE_ALPHA },
    };
  });
  const baked = bakeGeometries(entries);
  geometries.forEach(g => g.dispose());
  return baked;
};

/** railMapの内容(電化・接続・変電所配置)が変わったかどうかの安価な署名。 */
const railSignatureOf = (railMap: Map<string, CellData>): string => {
  let sig = '';
  for (const [key, cell] of railMap) {
    if (cell.type === 'substation') sig += `${key}S|`;
    else if (cell.type === 'rail' || cell.type === 'station') {
      if (cell.electrified) sig += `${key}${cell.electrified}${cell.connections ?? 0}|`;
    }
  }
  return sig;
};

export const WebGpuFeedingOverlay: React.FC<Props> = ({ layerRef, railMap, world, field, active }) => {
  const lastControllerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const lastFieldRef = useRef<TerrainField | null>(null);
  const lastSigRef = useRef<string>('');

  useFrameLoop(FRAME_ORDER.feed, () => {
    const controller = layerRef.current;
    if (!controller) return;

    const feeding = world.current?.feeding;
    const feedingSectionCounts = world.current?.feedingSectionCounts;

    const controllerChanged = lastControllerRef.current !== controller;
    const fieldChanged = lastFieldRef.current !== field;
    if (controllerChanged) lastControllerRef.current = controller;
    if (fieldChanged) lastFieldRef.current = field;
    if (controllerChanged || fieldChanged) lastSigRef.current = '';

    const sig = active && feeding ? `${railSignatureOf(railMap)}#${feedingSectionCounts?.size ?? -1}` : '';
    if (!controllerChanged && !fieldChanged && sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    if (!active || !feeding) {
      controller.removeMeshChunk(FEEDING_OVERLAY_CHUNK_ID);
      return;
    }

    const cells = buildFeedingOverlayCells(railMap, feeding, feedingSectionCounts);
    const chunk = buildOverlayChunk(cells, field);
    if (chunk) controller.uploadMeshChunk(FEEDING_OVERLAY_CHUNK_ID, MESH_LAYER_CLASS.translucent, chunk);
    else controller.removeMeshChunk(FEEDING_OVERLAY_CHUNK_ID);
  });

  return null;
};
