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

const FEEDING_OVERLAY_CHUNK_ID = 0x9200_0001;

/** 通常セルの板の不透明度(WebGpuBuildPreviewのPREVIEW_ALPHAと同じ0.45相当)。 */
const PLATE_ALPHA = Math.round(0.45 * 255);
/** 変電所セルは目立たせるため、より不透明に。 */
const SUBSTATION_ALPHA = Math.round(0.7 * 255);

/** 地表すれすれの薄い板(タスク仕様の0.05高)。 */
const PLATE_HEIGHT = 0.05;
const PLATE_Y = PLATE_HEIGHT / 2 + 0.01;
/** 変電所の板は少し背を高くして強調する。 */
const SUBSTATION_HEIGHT = 0.5;
const SUBSTATION_Y = SUBSTATION_HEIGHT / 2 + 0.01;

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
  /** 変電所ツールが選択中のときだけ表示する(タスク仕様どおり、専用トグルは無い)。 */
  active: boolean;
}

const buildOverlayChunk = (cells: readonly FeedingOverlayCell[]): BakedMeshChunk | null => {
  if (cells.length === 0) return null;
  const geometries: THREE.BoxGeometry[] = [];
  const entries = cells.map(cell => {
    const isSubstation = cell.colourKind === 'substation';
    const height = isSubstation ? SUBSTATION_HEIGHT : PLATE_HEIGHT;
    const y = isSubstation ? SUBSTATION_Y : PLATE_Y;
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

export const WebGpuFeedingOverlay: React.FC<Props> = ({ layerRef, railMap, world, active }) => {
  const lastControllerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const lastSigRef = useRef<string>('');

  useFrameLoop(FRAME_ORDER.feed, () => {
    const controller = layerRef.current;
    if (!controller) return;

    const feeding = world.current?.feeding;
    const feedingSectionCounts = world.current?.feedingSectionCounts;

    const controllerChanged = lastControllerRef.current !== controller;
    if (controllerChanged) {
      lastControllerRef.current = controller;
      lastSigRef.current = '';
    }

    const sig = active && feeding ? `${railSignatureOf(railMap)}#${feedingSectionCounts?.size ?? -1}` : '';
    if (!controllerChanged && sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    if (!active || !feeding) {
      controller.removeMeshChunk(FEEDING_OVERLAY_CHUNK_ID);
      return;
    }

    const cells = buildFeedingOverlayCells(railMap, feeding, feedingSectionCounts);
    const chunk = buildOverlayChunk(cells);
    if (chunk) controller.uploadMeshChunk(FEEDING_OVERLAY_CHUNK_ID, MESH_LAYER_CLASS.translucent, chunk);
    else controller.removeMeshChunk(FEEDING_OVERLAY_CHUNK_ID);
  });

  return null;
};
