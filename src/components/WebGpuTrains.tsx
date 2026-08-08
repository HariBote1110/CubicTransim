// R4c: WebGPUモードの列車描画。three.js の <DynamicTrain> の代わりにマウントされ、
// 位置計算(sim/consist.tsのcarPositions、classicと共有)から求めたインスタンス配列を
// 毎フレーム wgpu へ流す(画面には何も描かない)。
//
// メッシュは起動時に1回だけ登録する(車両head/mid・選択マーカー・経路ドットの4種)。
// インスタンスバッファは Float32Array を使い回し(フレームごとの確保を避ける)、
// 必要な時だけ2倍に伸長する。
//
// 地下ビューの明暗の近似(既知の視覚差): wgpuのインスタンスAPIはflags bit0でしか
// クラスを分けられず(surface/underground の2値、meshChunkのtranslucentクラスに相当する
// ものが無い)、three.js版のような「非選択地下レベルを半透明で暗く見せる」表現ができない。
// そのため非選択の地下レベルにいる車両はここで描画自体をスキップする(WebGpuTrackNetwork
// 等の3クラス近似とは異なる簡略化。r4-threejs-retirement-plan.mdのR4c実装メモに記録)。

import React, { useRef } from 'react';
import { FRAME_ORDER } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';
import type { CellData, TrainData, TrainGroupData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import type { SimWorld } from '../sim/simulation';
import { carPositions } from '../sim/consist';
import { isTrainHiddenInTunnel, type ElevatedTunnelIndex } from '../sim/tunnel';
import { findGroup } from '../sim/groups';
import { carGroupPosition, headingToYawPitch } from '../render/trainInstanceMath';
import { buildTrainCarMesh, buildSelectionMarkerMesh, buildRouteDotMesh } from '../render/trainMeshBuilder';
import { loadTrainModel, TRAIN_MODEL_REGISTRY } from '../render/trainModelLoader';
import { parseColourHex } from '../render/bakedMesh';
import { PALETTE } from '../render/palette';
import { MESH_INSTANCE_STRIDE, MESH_INSTANCE_FLAG_UNDERGROUND } from '../render/webgpuLayer';
import type { WebGpuTerrainLayerController } from '../render/webgpuLayer';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

/** R4c専用のインスタンスメッシュid名前空間(meshChunkRegistry.tsとは別体系。固定4種のみ)。 */
const MESH_ID_HEAD = 0x9000_0001;
const MESH_ID_MID = 0x9000_0002;
const MESH_ID_SELECTION = 0x9000_0003;
const MESH_ID_ROUTE_DOT = 0x9000_0004;

/** 列車ドラッグ中に持ち上げる高さ(DynamicTrain.tsxのDRAG_LIFT_Yと同じ)。 */
const DRAG_LIFT_Y = 1.1;
const DRAG_CAR_SPACING = 0.92;

const ROUTE_DOT_COLOUR = parseColourHex('#ffd23f');

interface Props {
  layerRef: WebGpuLayerRef;
  trains: TrainData[];
  railMap: Map<string, CellData>;
  field: TerrainField;
  elevatedTunnelIndex: ElevatedTunnelIndex;
  world: React.RefObject<SimWorld>;
  selectedTrainId: string | null;
  groups?: TrainGroupData[];
  undergroundView?: boolean;
  selectedLevel?: number;
  draggingTrainId?: string | null;
  dragCell?: { x: number; z: number } | null;
}

/** 伸長可能なFloat32Arrayバッファ。フレームごとの確保を避けるため、必要な時だけ倍化する。 */
class InstanceBuffer {
  data = new Float32Array(MESH_INSTANCE_STRIDE * 16);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  push(
    x: number, y: number, z: number, yaw: number, pitch: number,
    tintR: number, tintG: number, tintB: number, flags: number,
  ): void {
    const offset = this.count * MESH_INSTANCE_STRIDE;
    if (offset + MESH_INSTANCE_STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[offset] = x;
    this.data[offset + 1] = y;
    this.data[offset + 2] = z;
    this.data[offset + 3] = yaw;
    this.data[offset + 4] = pitch;
    this.data[offset + 5] = tintR;
    this.data[offset + 6] = tintG;
    this.data[offset + 7] = tintB;
    this.data[offset + 8] = flags;
    this.data[offset + 9] = 0;
    this.count += 1;
  }

  view(): Float32Array {
    return this.data.subarray(0, this.count * MESH_INSTANCE_STRIDE);
  }
}

export const WebGpuTrains: React.FC<Props> = ({
  layerRef, trains, railMap, field, elevatedTunnelIndex, world, selectedTrainId,
  groups = [], undergroundView = false, selectedLevel = 0, draggingTrainId = null, dragCell = null,
}) => {
  const lastControllerRef = useRef<WebGpuTerrainLayerController | null>(null);
  const headBuf = useRef(new InstanceBuffer());
  const midBuf = useRef(new InstanceBuffer());
  const selectionBuf = useRef(new InstanceBuffer());
  const dotBuf = useRef(new InstanceBuffer());

  useFrameLoop(FRAME_ORDER.feed, () => {
    const controller = layerRef.current;
    if (!controller) return;

    if (lastControllerRef.current !== controller) {
      lastControllerRef.current = controller;
      // まずプレースホルダを即時登録する(glbロードは非同期・失敗しうるため、
      // 列車が一瞬でも無表示にならないようにする)。実モデルが用意されている車種は
      // ロード完了後に同じidへ再登録して差し替える(setInstancesは既存インスタンス
      // 配列をそのまま使い回せるので、差し替え中も列車の位置は飛ばない)。
      const head = buildTrainCarMesh('head');
      const mid = buildTrainCarMesh('mid');
      const marker = buildSelectionMarkerMesh();
      const dot = buildRouteDotMesh();
      if (head) controller.registerInstancedMesh(MESH_ID_HEAD, head);
      if (mid) controller.registerInstancedMesh(MESH_ID_MID, mid);
      if (marker) controller.registerInstancedMesh(MESH_ID_SELECTION, marker);
      if (dot) controller.registerInstancedMesh(MESH_ID_ROUTE_DOT, dot);

      // R4c: 車種id→glbモデルidの対応表(現時点ではTRAIN_MODEL_REGISTRYが空なので
      // 全車種がプレースホルダのまま。モデル納品後はここに登録するだけで自動的に使われる)。
      const modelId = TRAIN_MODEL_REGISTRY['commuter'];
      if (modelId) {
        loadTrainModel(modelId).then(model => {
          if (!model || lastControllerRef.current !== controller) return;
          controller.registerInstancedMesh(MESH_ID_HEAD, model.head);
          controller.registerInstancedMesh(MESH_ID_MID, model.mid);
        });
      }
    }

    const head = headBuf.current;
    const mid = midBuf.current;
    const selection = selectionBuf.current;
    const dots = dotBuf.current;
    head.reset();
    mid.reset();
    selection.reset();
    dots.reset();

    for (const train of trains) {
      if (train.status === 'stored') continue;
      const runtime = world.current?.runtimes.get(train.id);
      if (!runtime) continue;
      const isSelected = train.id === selectedTrainId;
      const lineColourHex = isSelected
        ? PALETTE.carLineSelected
        : (findGroup(groups, train.groupId)?.colour ?? PALETTE.carLine);
      const [tintR, tintG, tintB] = parseColourHex(lineColourHex);

      if (draggingTrainId === train.id && dragCell) {
        for (let i = 0; i < train.cars; i++) {
          const buf = i === 0 || i === train.cars - 1 ? head : mid;
          buf.push(dragCell.x, DRAG_LIFT_Y, dragCell.z - DRAG_CAR_SPACING * i, 0, 0, tintR, tintG, tintB, 0);
        }
        continue;
      }

      const level = runtime.grid.layer ?? 0;
      // 通常表示では地下(level<0)は完全非表示。地下ビュー中は選択レベル以外を近似的に隠す
      // (「発見した実装上の注意点」参照)。
      if (level < 0 && (!undergroundView || level !== selectedLevel)) continue;

      const positions = carPositions(runtime, train.cars, 1.0, railMap, field);
      const flags = level < 0 ? MESH_INSTANCE_FLAG_UNDERGROUND : 0;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (isTrainHiddenInTunnel(railMap, elevatedTunnelIndex, pos.x, pos.z, pos.y)) continue;
        const groupPos = carGroupPosition(pos, pos.heading);
        const { yaw, pitch } = headingToYawPitch(pos.heading);
        const isTail = i === positions.length - 1 && positions.length > 1;
        const isHeadOrTail = i === 0 || isTail;
        const finalYaw = isTail ? yaw + Math.PI : yaw;
        const buf = isHeadOrTail ? head : mid;
        buf.push(groupPos.x, groupPos.y, groupPos.z, finalYaw, pitch, tintR, tintG, tintB, flags);

        if (isSelected && i === 0) {
          selection.push(groupPos.x, groupPos.y + 0.85, groupPos.z, 0, 0, tintR, tintG, tintB, 0);
        }
      }

      if (isSelected) {
        for (const routePos of runtime.route) {
          dots.push(routePos.x, 0.2, routePos.z, 0, 0, ROUTE_DOT_COLOUR[0], ROUTE_DOT_COLOUR[1], ROUTE_DOT_COLOUR[2], 0);
        }
      }
    }

    controller.setInstances(MESH_ID_HEAD, head.view());
    controller.setInstances(MESH_ID_MID, mid.view());
    controller.setInstances(MESH_ID_SELECTION, selection.view());
    controller.setInstances(MESH_ID_ROUTE_DOT, dots.view());
  });

  return null;
};
