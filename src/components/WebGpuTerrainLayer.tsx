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
import type { TerrainField, TerrainProfile } from '../sim/terrainField';
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
import { buildPerspectiveTerrainMesh, PERSPECTIVE_TERRAIN_CHUNK_ID } from '../render/perspectiveTerrain';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import { computeRiderCamera, riderState } from '../render/passengerView';
import type { SimWorld } from '../sim/simulation';

/**
 * D1: 透視投影(乗客視点スパイク)のデバッグ状態。モジュール単位のミュータブルフラグ
 * (CLAUDE.md 指定の「WebGpuRenderDriver にモジュール単位のフラグを持たせる」方式)。
 * 実際の乗車UIはD2以降のスコープで、これは `window.__perspectiveDebug` からの検証専用。
 */
export const perspectiveDebugState: {
  active: boolean;
  eye: [number, number, number];
  look: [number, number, number];
  fovYRadians: number;
  /** 直近に地形メッシュを焼いた中心セル(再焼き込みの要不要判定に使う)。 */
  lastTerrainCentre: [number, number] | null;
} = {
  active: false,
  eye: [0, 1.6, 0],
  look: [10, 1.2, 0],
  fovYRadians: Math.PI / 3,
  lastTerrainCentre: null,
};

/** 透視パスで地形メッシュを焼く半径(セル)。オンデマンド生成、視点移動のたびに作り直す。 */
const PERSPECTIVE_TERRAIN_RADIUS_CELLS = 48;
/** 中心セルがこの距離以上動いたら地形メッシュを焼き直す(毎フレーム再構築を避ける)。 */
const PERSPECTIVE_TERRAIN_REBAKE_THRESHOLD = 8;

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
  /** D1/D2: 透視パスの地形メッシュをオンデマンドに焼くための地形フィールド。 */
  field?: TerrainField;
  /** D2: 乗車中のライダーカメラを計算するための SimWorld(App.tsx の worldRef)。 */
  world?: React.RefObject<SimWorld>;
}

/**
 * 共有 rAF ループの render フェーズで、カメラ状態を wgpu へ送って1フレーム描かせる。
 * 画面には何も出さない(描画そのものは WebGpuTerrainLayer のキャンバスが受け持つ)。
 *
 * D1/D2: 透視パスが有効な間(`riderState.trainId` での乗車、または
 * `perspectiveDebugState.active` でのデバッグ乗車)は、クォータービューのカメラ供給
 * (setCamera)を止めて透視カメラ(setCameraPerspective)を毎フレーム供給する。
 * 乗車(riderState)がデバッグより優先。両方ともモジュール単位のミュータブルフラグ
 * (Reactの再レンダリングを経由しない)。
 */
export const WebGpuRenderDriver: React.FC<RenderDriverProps> = ({
  layerRef, cameraRef, viewportRef, dim = 1, stateRef, field, world,
}) => {
  const dimRef = useRef(dim);
  dimRef.current = dim;
  const fieldRef = useRef(field);
  fieldRef.current = field;
  const worldRef = useRef(world);
  worldRef.current = world;
  // 直前フレームの透視ソース('ride:<id>' / 'debug' / null)。切り替わった瞬間だけ
  // 地形メッシュを強制的に焼き直す/外す(距離しきい値を待たずに済ませる)。
  const prevActiveKeyRef = useRef<string | null>(null);

  useEffect(() => {
    (window as any).__perspectiveDebug = {
      /** 乗客視点デバッグモードへ入る(実際の乗車UIはD2、window.__perspectiveDebugとは独立)。 */
      enter(
        eye: [number, number, number],
        look: [number, number, number],
        fovYRadians = Math.PI / 3,
      ) {
        perspectiveDebugState.active = true;
        perspectiveDebugState.eye = eye;
        perspectiveDebugState.look = look;
        perspectiveDebugState.fovYRadians = fovYRadians;
      },
      exit() {
        perspectiveDebugState.active = false;
      },
    };
    return () => {
      delete (window as any).__perspectiveDebug;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrameLoop(FRAME_ORDER.render, () => {
    const controller = layerRef.current;
    if (!controller) return;
    controller.setDim(dimRef.current);

    // D2: 乗車中の列車が消えた(到着後の回収・車庫入りなど)場合は自動的に降車する。
    const ridingId = riderState.trainId;
    const worldNow = worldRef.current?.current;
    const riderCam = ridingId && worldNow ? computeRiderCamera(worldNow, ridingId) : null;
    if (ridingId && !riderCam) riderState.trainId = null;

    const active = riderCam
      ? { eye: riderCam.eye, look: riderCam.look, fovYRadians: perspectiveDebugState.fovYRadians }
      : perspectiveDebugState.active
        ? { eye: perspectiveDebugState.eye, look: perspectiveDebugState.look, fovYRadians: perspectiveDebugState.fovYRadians }
        : null;
    const activeKey = riderCam ? `ride:${ridingId}` : perspectiveDebugState.active ? 'debug' : null;
    const modeChanged = activeKey !== prevActiveKeyRef.current;
    prevActiveKeyRef.current = activeKey;

    if (active) {
      controller.setCameraMode('perspective');
      controller.setCameraPerspective(active.eye, active.look, active.fovYRadians);
      const field = fieldRef.current;
      if (field) {
        const [ex, , ez] = active.eye;
        const last = perspectiveDebugState.lastTerrainCentre;
        const needsRebake = modeChanged || !last
          || Math.hypot(ex - last[0], ez - last[1]) >= PERSPECTIVE_TERRAIN_REBAKE_THRESHOLD;
        if (needsRebake) {
          const mesh = buildPerspectiveTerrainMesh(field, ex, ez, PERSPECTIVE_TERRAIN_RADIUS_CELLS);
          if (mesh) {
            controller.uploadMeshChunk(PERSPECTIVE_TERRAIN_CHUNK_ID, MESH_LAYER_CLASS.surface, mesh);
          }
          perspectiveDebugState.lastTerrainCentre = [ex, ez];
        }
      }
      const stats = controller.syncAndRender(
        toWebGpuCameraState(cameraRef.current, viewportRef.current),
        OVERPASS_HEIGHT,
      );
      if (stats) (window as any).__webgpuStats = stats;
      (window as any).__dbgFrames = frameLoop.frameCount;
      return;
    }

    if (modeChanged) {
      // 直前まで透視パス(デバッグ or 乗車)だった → 地形メッシュチャンクを外す。残したままだと
      // クォータービューのSurfaceクラス描画(iso投影)にもそのまま乗ってしまい、地形の上に
      // 別の地形が二重に(等角投影のずれた位置で)描かれてしまう(D1で発見・修正した不具合と同じ)。
      controller.removeMeshChunk(PERSPECTIVE_TERRAIN_CHUNK_ID);
      perspectiveDebugState.lastTerrainCentre = null;
    }

    controller.setCameraMode('quarter');
    const state = toWebGpuCameraState(cameraRef.current, viewportRef.current);
    if (stateRef) stateRef.current = state;
    const stats = controller.syncAndRender(state, OVERPASS_HEIGHT);
    if (stats) (window as any).__webgpuStats = stats;
    (window as any).__dbgFrames = frameLoop.frameCount;
  });

  return null;
};
