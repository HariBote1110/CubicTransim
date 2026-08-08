// 二層合成の下層: wgpu(WebGPU)で地形を描くキャンバス。
//
// 上層は既存の three.js キャンバス(透過)で、レール・列車・駅・町・樹木を描く。
// カメラの真実源は上層の OrbitControls で、毎フレーム `WebGpuCameraSync`(下記、
// r3f の useFrame から動く)が同じフレームのカメラ状態を下層へ渡して描かせる。
// 2つの rAF ループに分けないのは、パン中に層がずれて見えるのを避けるため。
//
// 地形編集(cornerDiffs)の反映(R2): このコンポーネントが cornerDiffs を受け取り、
// 変更のあったチャンク(overlayChunkRefsと同じ「サブMapの参照が変わったか」判定)だけを
// wasm へ push する。全チャンク走査はコントローラ生成完了時と cornerDiffs 変更時だけに
// 限られ、頻度は編集操作の回数(=フレームごとではない)。

import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { OVERPASS_HEIGHT } from '../sim/trackPath';
import type { CornerDiffs } from '../sim/terrainOverlay';
import {
  groundCentreFromTarget, pixelsPerWorldUnit, type WebGpuCameraState,
} from '../render/webgpuCamera';
import {
  WebGpuTerrainLayerController, WebGpuUnavailableError, UNAVAILABLE_MESSAGE,
} from '../render/webgpuLayer';

export type WebGpuLayerRef = React.RefObject<WebGpuTerrainLayerController | null>;

interface LayerProps {
  seed: number;
  halfExtent: number;
  /** 地形編集オーバーレイ(useGameLogicのcornerDiffs)。変更があったチャンクだけをwasmへ送る。 */
  cornerDiffs: CornerDiffs;
  /** 生成したコントローラの置き場。上層(GameScene内のWebGpuCameraSync)が毎フレーム読む。 */
  layerRef: WebGpuLayerRef;
  /** WebGPUが使えないとき(非対応・未ビルド・初期化失敗)に理由文を通知する。 */
  onUnavailable: (message: string) => void;
}

const EMPTY_CHUNK: ReadonlyMap<number, number> = new Map();

/**
 * 下層キャンバス本体(three.js の Canvas の**下**に敷く DOM 要素)。
 * サイズは CSS で親いっぱいに広げ、バックバッファ(canvas.width/height)は
 * 上層と同じ DPR で `syncAndRender` 側が合わせる。
 */
export const WebGpuTerrainLayer: React.FC<LayerProps> = ({ seed, halfExtent, cornerDiffs, layerRef, onUnavailable }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // wasm 側へ最後に反映した cornerDiffs(チャンク参照ごとの比較に使う)。
  const pushedDiffsRef = useRef<CornerDiffs>(new Map());
  // 生成完了(非同期)時点で最新の cornerDiffs を一括転送するために参照だけ最新へ保つ。
  const latestDiffsRef = useRef<CornerDiffs>(cornerDiffs);
  latestDiffsRef.current = cornerDiffs;

  const pushChangedChunks = (controller: WebGpuTerrainLayerController, diffs: CornerDiffs) => {
    const prev = pushedDiffsRef.current;
    for (const [chunkKey, chunk] of diffs) {
      if (prev.get(chunkKey) === chunk) continue; // 参照同一なら未変更(overlayChunkRefsと同じ判定)
      controller.pushCornerOverrideChunk(chunkKey, chunk);
    }
    for (const chunkKey of prev.keys()) {
      if (!diffs.has(chunkKey)) controller.pushCornerOverrideChunk(chunkKey, EMPTY_CHUNK);
    }
    pushedDiffsRef.current = diffs;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    pushedDiffsRef.current = new Map(); // 新しいレイヤーには何も転送していない状態から始める

    WebGpuTerrainLayerController.create(canvas, seed, halfExtent)
      .then(controller => {
        if (disposed) return;
        layerRef.current = controller;
        // ロード直後などcornerDiffsが既に非空な場合に備え、生成完了時点の最新状態を一括転送する。
        pushChangedChunks(controller, latestDiffsRef.current);
        // 検証用のデバッグフック(CLAUDE.mdのブラウザ検証手順で使う)。
        (window as any).__webgpuLayer = controller;
        (window as any).__webgpuParams = { seed, halfExtent };
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof WebGpuUnavailableError
          ? UNAVAILABLE_MESSAGE[error.reason]
          : UNAVAILABLE_MESSAGE['init-failed'];
        console.warn('[webgpu] falling back to the classic renderer:', message, error);
        onUnavailable(message);
      });

    return () => {
      disposed = true;
      layerRef.current = null;
      (window as any).__webgpuLayer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, halfExtent, layerRef, onUnavailable]);

  useEffect(() => {
    const controller = layerRef.current;
    if (!controller) return; // 生成完了時のpushChangedChunksが後で拾う
    pushChangedChunks(controller, cornerDiffs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cornerDiffs, layerRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
};

/**
 * three.js側のDIMMED_MATERIALS(palette.ts、opacity 0.3)と見た目を揃えるための
 * wgpu側の色乗算係数。blend:Noneの不透明描画なのでアルファ合成の代わりに色を直接暗くする
 * (screenshot比較で選定した値、R2実装メモ参照)。
 */
export const WEBGPU_UNDERGROUND_DIM_FACTOR = 0.3;

interface SyncProps {
  layerRef: WebGpuLayerRef;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  /** 地下ビュー減光係数(1.0=通常)。GameScene の isLevelDimmed(0, ...) と同調させる。 */
  dim?: number;
}

/**
 * 上層(r3f)の中に置き、毎フレーム下層へカメラ状態を送って描かせるコンポーネント。
 * 画面に何も描かない。
 */
export const WebGpuCameraSync: React.FC<SyncProps> = ({ layerRef, controlsRef, dim = 1 }) => {
  const { camera, gl, size } = useThree();

  useFrame(() => {
    const controller = layerRef.current;
    if (!controller) return;
    const target = controlsRef.current?.target ?? { x: 0, y: 0, z: 0 };
    const dpr = gl.getPixelRatio();
    const zoom = (camera as { zoom?: number }).zoom ?? 1;
    const state: WebGpuCameraState = {
      ...groundCentreFromTarget(target),
      pixelsPerUnit: pixelsPerWorldUnit(zoom, dpr),
      widthPx: size.width * dpr,
      heightPx: size.height * dpr,
    };
    controller.setDim(dim);
    const stats = controller.syncAndRender(state, OVERPASS_HEIGHT);
    if (stats) (window as any).__webgpuStats = stats;
  });

  return null;
};
