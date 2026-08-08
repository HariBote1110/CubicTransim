// WebGPU地形レイヤー(下層キャンバス)の生成・駆動。
//
// wasm モジュール(renderer/ の wasm-pack 出力)は **実行時に遅延ロード** する。
// `npm run build` は Rust を必要とせず、成果物(public/renderer/)が無い環境では
// ここが失敗し、呼び出し側が従来(three.js)レンダラーへフォールバックする。
//
// 開発フロー:
//   npm run build:renderer  # wasm-pack --release → public/renderer/
//   npm run dev             # 設定パネルで「WebGPU実験版」を選ぶ

import type { WebGpuCameraState } from './webgpuCamera';
import type { TerrainProfile } from '../sim/terrainField';

/** フォールバック理由。UI・console warn の文言に使う。 */
export type WebGpuUnavailableReason =
  | 'no-webgpu' // navigator.gpu が無い(WebGPU非対応)
  | 'asset-missing' // wasm モジュールが未ビルド(npm run build:renderer 未実行)
  | 'init-failed'; // アダプタ取得・デバイス生成などの失敗

export const UNAVAILABLE_MESSAGE: Record<WebGpuUnavailableReason, string> = {
  'no-webgpu': 'この環境は WebGPU に対応していません。従来レンダラーで表示します。',
  'asset-missing': 'WebGPUレンダラーが未ビルドです(npm run build:renderer)。従来レンダラーで表示します。',
  'init-failed': 'WebGPUレンダラーの初期化に失敗しました。従来レンダラーで表示します。',
};

/** wasm 側 CanvasRenderer のうち、このレイヤーが使う部分だけの型。 */
interface CanvasRendererHandle {
  resize(width: number, height: number): void;
  setCamera(centreX: number, centreZ: number, pixelsPerUnit: number, heightPerLevel?: number): void;
  render(): string;
  adapterInfo(): string;
  /**
   * terrainOverlay.ts の CornerDiffs の1チャンク分を丸ごと置き換える(R2)。
   * entries は `[localIndex0, height0, localIndex1, height1, ...]` のフラット配列。
   * 空配列はチャンク全体の削除(基底へ復帰)を意味する。
   */
  setCornerOverrideChunk(chunkX: number, chunkZ: number, entries: Uint32Array): void;
  /** 地下ビュー減光係数(1.0=通常、0.0=真っ黒)。GameScene の isLevelDimmed と同調させる。 */
  setDim(factor: number): void;
  /**
   * R4a: ジオラマ物(樹木・町など)のメッシュチャンクを1つ登録する(同じidは置き換え)。
   * layerClass は 0=地表 / 1=地下 / 2=半透明(render/bakedMesh.ts で焼き込んだ頂点色を渡す)。
   *
   * 以下の R4a API は R3 以前の wasm 成果物には無いため optional にしてある
   * (未ビルドの古い public/renderer/ でも地形だけは描けるようにするため)。
   */
  uploadMeshChunk?(
    id: number, layerClass: number, aabb: Float32Array,
    positions: Float32Array, colours: Uint32Array, indices: Uint32Array,
  ): void;
  /** R4a: メッシュチャンクを外す。 */
  removeMeshChunk?(id: number): void;
  /** R4a: インスタンス描画のプロトタイプメッシュを登録する(R4cの列車で使う)。 */
  registerInstancedMesh?(
    meshId: number, positions: Float32Array, colours: Uint32Array, indices: Uint32Array,
  ): void;
  /** R4a: 登録済みメッシュのインスタンス配列を差し替える(1件 = MESH_INSTANCE_STRIDE 個のf32)。 */
  setInstances?(meshId: number, data: Float32Array): void;
}

/**
 * インスタンス1件あたりの f32 個数。wasm 側 `meshes::INSTANCE_STRIDE_FLOATS` と同じ値。
 * 並びは [x, y, z, yaw, pitch, tintR, tintG, tintB, flags, 予約]。
 */
export const MESH_INSTANCE_STRIDE = 10;

/** インスタンスの flags: 地下クラスとして描く(深度Always・地下ビュー限定)。 */
export const MESH_INSTANCE_FLAG_UNDERGROUND = 1;

/** メッシュチャンクの描画クラス(wasm 側 `meshes::LayerClass` と同じ数値)。 */
export const MESH_LAYER_CLASS = {
  surface: 0,
  underground: 1,
  translucent: 2,
} as const;

interface RendererModule {
  default: () => Promise<unknown>;
  CanvasRenderer: {
    create(
      canvas: HTMLCanvasElement, seed: number, halfExtent: number, profile: string,
    ): Promise<CanvasRendererHandle>;
  };
}

export class WebGpuUnavailableError extends Error {
  readonly reason: WebGpuUnavailableReason;

  constructor(reason: WebGpuUnavailableReason, cause?: unknown) {
    super(UNAVAILABLE_MESSAGE[reason], { cause });
    this.name = 'WebGpuUnavailableError';
    this.reason = reason;
  }
}

/** wasm モジュールの場所(public/renderer/ に wasm-pack が出力する)。 */
const moduleUrl = (): string =>
  new URL('renderer/quarterview_renderer_wgpu.js', document.baseURI).href;

let modulePromise: Promise<RendererModule> | null = null;

const loadModule = async (): Promise<RendererModule> => {
  if (!modulePromise) {
    modulePromise = (async () => {
      // Vite にビルド時解決させない(成果物が無くてもビルドを通すため)。
      const mod = (await import(/* @vite-ignore */ moduleUrl())) as RendererModule;
      await mod.default();
      return mod;
    })().catch(error => {
      modulePromise = null;
      throw new WebGpuUnavailableError('asset-missing', error);
    });
  }
  return modulePromise;
};

/**
 * 下層キャンバスの実体。カメラ状態を受け取ってリサイズ・カメラ更新・描画を行う。
 * 上層(three.js)の useFrame から毎フレーム `syncAndRender` を呼ぶことで、
 * 2つのキャンバスが必ず同じフレームの同じカメラで揃う。
 */
export class WebGpuTerrainLayerController {
  private failures = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: CanvasRendererHandle;

  private constructor(canvas: HTMLCanvasElement, renderer: CanvasRendererHandle) {
    this.canvas = canvas;
    this.renderer = renderer;
  }

  /**
   * `profile` は世界ごとに不変なので生成時に固定する(あとから差し替えるAPIは持たない)。
   * 変更したいときは呼び出し側がレイヤーごと作り直す(App.tsx の key に含めてある)。
   */
  static async create(
    canvas: HTMLCanvasElement,
    seed: number,
    halfExtent: number,
    profile: TerrainProfile,
  ): Promise<WebGpuTerrainLayerController> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new WebGpuUnavailableError('no-webgpu');
    }
    const mod = await loadModule();
    try {
      const renderer = await mod.CanvasRenderer.create(canvas, seed >>> 0, halfExtent, profile);
      return new WebGpuTerrainLayerController(canvas, renderer);
    } catch (error) {
      throw new WebGpuUnavailableError('init-failed', error);
    }
  }

  adapterInfo(): string {
    return this.renderer.adapterInfo();
  }

  /**
   * terrainOverlay.ts の CornerDiffs 1チャンク分を wasm 側へ転送する。
   * `chunk` が空(またはサイズ0)なら基底復帰(チャンク削除)として送る。
   */
  pushCornerOverrideChunk(chunkKey: string, chunk: ReadonlyMap<number, number>): void {
    const [chunkX, chunkZ] = chunkKey.split(',').map(Number);
    const flat = new Uint32Array(chunk.size * 2);
    let i = 0;
    for (const [localIndex, height] of chunk) {
      flat[i++] = localIndex;
      flat[i++] = height;
    }
    this.renderer.setCornerOverrideChunk(chunkX, chunkZ, flat);
  }

  /** 地下ビュー減光係数を wgpu 側へ同期する(setCamera とは独立、頻度も少ないため毎フレーム呼んでよい)。 */
  setDim(factor: number): void {
    this.renderer.setDim(factor);
  }

  /**
   * R4a: 焼き込み済みのメッシュチャンク(render/bakedMesh.ts の bakeGeometries の出力)を
   * wgpu へ載せる。旧い wasm 成果物(R3以前のビルド)で API が無い場合は何もしない
   * ——地形だけが描かれ、ジオラマ物が出ないだけで動作は継続する。
   */
  uploadMeshChunk(
    id: number,
    layerClass: number,
    chunk: { positions: Float32Array; colours: Uint32Array; indices: Uint32Array; aabb: Float32Array },
  ): void {
    this.renderer.uploadMeshChunk?.(
      id, layerClass, chunk.aabb, chunk.positions, chunk.colours, chunk.indices,
    );
  }

  /** R4a: メッシュチャンクを外す。 */
  removeMeshChunk(id: number): void {
    this.renderer.removeMeshChunk?.(id);
  }

  /** R4a: インスタンス描画のプロトタイプメッシュを登録する(R4cの列車で使う)。 */
  registerInstancedMesh(
    meshId: number,
    mesh: { positions: Float32Array; colours: Uint32Array; indices: Uint32Array },
  ): void {
    this.renderer.registerInstancedMesh?.(meshId, mesh.positions, mesh.colours, mesh.indices);
  }

  /** R4a: 登録済みメッシュのインスタンス配列を差し替える。 */
  setInstances(meshId: number, data: Float32Array): void {
    this.renderer.setInstances?.(meshId, data);
  }

  /** 1フレーム描く。戻り値は wasm 側の統計JSON(失敗時は null)。 */
  syncAndRender(state: WebGpuCameraState, heightPerLevel: number): string | null {
    const width = Math.max(1, Math.round(state.widthPx));
    const height = Math.max(1, Math.round(state.heightPx));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.renderer.resize(width, height);
    }
    this.renderer.setCamera(state.centreX, state.centreZ, state.pixelsPerUnit, heightPerLevel);
    try {
      const stats = this.renderer.render();
      this.failures = 0;
      return stats;
    } catch (error) {
      this.failures += 1;
      if (this.failures <= 3) console.warn('[webgpu] render failed', error);
      return null;
    }
  }
}
