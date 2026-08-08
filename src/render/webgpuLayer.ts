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
}

interface RendererModule {
  default: () => Promise<unknown>;
  CanvasRenderer: {
    create(canvas: HTMLCanvasElement, seed: number, halfExtent: number): Promise<CanvasRendererHandle>;
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

  static async create(
    canvas: HTMLCanvasElement,
    seed: number,
    halfExtent: number,
  ): Promise<WebGpuTerrainLayerController> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      throw new WebGpuUnavailableError('no-webgpu');
    }
    const mod = await loadModule();
    try {
      const renderer = await mod.CanvasRenderer.create(canvas, seed >>> 0, halfExtent);
      return new WebGpuTerrainLayerController(canvas, renderer);
    } catch (error) {
      throw new WebGpuUnavailableError('init-failed', error);
    }
  }

  adapterInfo(): string {
    return this.renderer.adapterInfo();
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
