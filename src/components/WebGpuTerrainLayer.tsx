// wgpu(WebGPU)で世界を描くキャンバス。R4d で three.js を全面退役させたため、
// ゲーム画面はこのキャンバス1枚だけになった(上に重なるのは DOM のラベルと GUI だけ)。
//
// カメラの真実源は TS 側の `GameCameraState`(render/cameraState.ts)で、共有 rAF ループ
// (render/frameLoop.ts)の render フェーズで `WebGpuRenderDriver` が毎フレーム wasm へ
// push して1回だけ描かせる。
//
// 地形編集(cornerDiffs)の反映(R2): このコンポーネントが cornerDiffs を受け取り、
// 変更のあったチャンク(overlayChunkRefsと同じ「サブMapの参照が変わったか」判定)だけを
// wasm へ push する。全チャンク走査はコントローラ生成完了時と cornerDiffs 変更時だけに
// 限られ、頻度は編集操作の回数(=フレームごとではない)。

import React, { useEffect, useRef } from 'react';

import { OVERPASS_HEIGHT } from '../sim/trackPath';
import type { CornerDiffs } from '../sim/terrainOverlay';
import type { TerrainProfile } from '../sim/terrainField';
import type { WebGpuCameraState } from '../render/webgpuCamera';
import {
  toWebGpuCameraState, type GameCameraState, type ViewportSize,
} from '../render/cameraState';
import { FRAME_ORDER, frameLoop } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';
import {
  WebGpuTerrainLayerController, WebGpuUnavailableError,
  type WebGpuUnavailableReason,
} from '../render/webgpuLayer';

export type WebGpuLayerRef = React.RefObject<WebGpuTerrainLayerController | null>;

interface LayerProps {
  seed: number;
  halfExtent: number;
  /** 地形プロファイル(平坦/標準/山がち)。TS側 createTerrainField と同じテーブルをwasmへ渡す。 */
  terrainProfile: TerrainProfile;
  /** 地形編集オーバーレイ(useGameLogicのcornerDiffs)。変更があったチャンクだけをwasmへ送る。 */
  cornerDiffs: CornerDiffs;
  /** 生成したコントローラの置き場。フィーダ・描画ドライバが毎フレーム読む。 */
  layerRef: WebGpuLayerRef;
  /** WebGPUが使えないとき(非対応・未ビルド・初期化失敗)に理由を通知する。 */
  onUnavailable: (reason: WebGpuUnavailableReason) => void;
  /** 生成完了の通知(案内画面を閉じるのに使う)。 */
  onReady?: () => void;
}

const EMPTY_CHUNK: ReadonlyMap<number, number> = new Map();

/**
 * 下層キャンバス本体(three.js の Canvas の**下**に敷く DOM 要素)。
 * サイズは CSS で親いっぱいに広げ、バックバッファ(canvas.width/height)は
 * 上層と同じ DPR で `syncAndRender` 側が合わせる。
 */
export const WebGpuTerrainLayer: React.FC<LayerProps> = ({ seed, halfExtent, terrainProfile, cornerDiffs, layerRef, onUnavailable, onReady }) => {
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

    WebGpuTerrainLayerController.create(canvas, seed, halfExtent, terrainProfile)
      .then(controller => {
        if (disposed) return;
        layerRef.current = controller;
        // ロード直後などcornerDiffsが既に非空な場合に備え、生成完了時点の最新状態を一括転送する。
        pushChangedChunks(controller, latestDiffsRef.current);
        // 検証用のデバッグフック(CLAUDE.mdのブラウザ検証手順で使う)。
        (window as any).__webgpuLayer = controller;
        (window as any).__webgpuParams = { seed, halfExtent, terrainProfile };
        onReady?.();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const reason: WebGpuUnavailableReason =
          error instanceof WebGpuUnavailableError ? error.reason : 'init-failed';
        console.error('[webgpu] renderer unavailable:', reason, error);
        onUnavailable(reason);
      });

    return () => {
      disposed = true;
      layerRef.current = null;
      (window as any).__webgpuLayer = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, halfExtent, terrainProfile, layerRef, onUnavailable, onReady]);

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

interface RenderDriverProps {
  layerRef: WebGpuLayerRef;
  /** カメラの真実源(App.tsx が保持し、入力ハンドラが書き換える)。 */
  cameraRef: React.RefObject<GameCameraState>;
  viewportRef: React.RefObject<ViewportSize>;
  /** 地下ビュー減光係数(1.0=通常)。GameScene の isLevelDimmed(0, ...) と同調させる。 */
  dim?: number;
  /**
   * 直近フレームのカメラ状態(物理ピクセル基準)の置き場。DOMラベルオーバーレイ
   * (LabelOverlay.tsx)が読む。ピッキングは即時性が要るのでこれを読まず、
   * cameraRef/viewportRef から毎回その場で組み立てる。
   */
  stateRef?: React.MutableRefObject<WebGpuCameraState | null>;
}

/**
 * 共有 rAF ループの render フェーズで、カメラ状態を wgpu へ送って1フレーム描かせる。
 * 画面には何も出さない(描画そのものは WebGpuTerrainLayer のキャンバスが受け持つ)。
 */
export const WebGpuRenderDriver: React.FC<RenderDriverProps> = ({
  layerRef, cameraRef, viewportRef, dim = 1, stateRef,
}) => {
  const dimRef = useRef(dim);
  dimRef.current = dim;

  useFrameLoop(FRAME_ORDER.render, () => {
    const controller = layerRef.current;
    if (!controller) return;
    const state = toWebGpuCameraState(cameraRef.current, viewportRef.current);
    if (stateRef) stateRef.current = state;
    controller.setDim(dimRef.current);
    const stats = controller.syncAndRender(state, OVERPASS_HEIGHT);
    if (stats) (window as any).__webgpuStats = stats;
    (window as any).__dbgFrames = frameLoop.frameCount;
  });

  return null;
};
