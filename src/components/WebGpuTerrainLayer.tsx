// 二層合成の下層: wgpu(WebGPU)で地形を描くキャンバス。
//
// 上層は既存の three.js キャンバス(透過)で、レール・列車・駅・町・樹木を描く。
// カメラの真実源は上層の OrbitControls で、毎フレーム `WebGpuCameraSync`(下記、
// r3f の useFrame から動く)が同じフレームのカメラ状態を下層へ渡して描かせる。
// 2つの rAF ループに分けないのは、パン中に層がずれて見えるのを避けるため。
//
// 地形編集(cornerDiffs)の反映は R2 の作業で、このフェーズでは下層に出ない
// (progress/renderer-integration-plan.md 参照)。

import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import { OVERPASS_HEIGHT } from '../sim/trackPath';
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
  /** 生成したコントローラの置き場。上層(GameScene内のWebGpuCameraSync)が毎フレーム読む。 */
  layerRef: WebGpuLayerRef;
  /** WebGPUが使えないとき(非対応・未ビルド・初期化失敗)に理由文を通知する。 */
  onUnavailable: (message: string) => void;
}

/**
 * 下層キャンバス本体(three.js の Canvas の**下**に敷く DOM 要素)。
 * サイズは CSS で親いっぱいに広げ、バックバッファ(canvas.width/height)は
 * 上層と同じ DPR で `syncAndRender` 側が合わせる。
 */
export const WebGpuTerrainLayer: React.FC<LayerProps> = ({ seed, halfExtent, layerRef, onUnavailable }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;

    WebGpuTerrainLayerController.create(canvas, seed, halfExtent)
      .then(controller => {
        if (disposed) return;
        layerRef.current = controller;
        (window as any).__webgpuLayer = controller;
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
  }, [seed, halfExtent, layerRef, onUnavailable]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
    />
  );
};

interface SyncProps {
  layerRef: WebGpuLayerRef;
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
}

/**
 * 上層(r3f)の中に置き、毎フレーム下層へカメラ状態を送って描かせるコンポーネント。
 * 画面に何も描かない。
 */
export const WebGpuCameraSync: React.FC<SyncProps> = ({ layerRef, controlsRef }) => {
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
    const stats = controller.syncAndRender(state, OVERPASS_HEIGHT);
    if (stats) (window as any).__webgpuStats = stats;
  });

  return null;
};
