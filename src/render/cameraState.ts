// R4d: カメラの真実源。three.js の OrthographicCamera + OrbitControls を退役させ、
// 「画面中心に写る地表(y=0)の点」と「ズーム(CSSピクセル/ワールド単位)」だけを持つ
// 素の状態オブジェクトへ置き換えた。
//
// 状態は毎フレーム `toWebGpuCameraState` で物理ピクセル単位の `WebGpuCameraState` へ
// 変換して wasm(CanvasRenderer.setCamera)へ push する。ピッキング(render/picking.ts)・
// DOMラベル(render/labelOverlay.ts)・列車クリック(render/trainPicking.ts)も同じ
// `WebGpuCameraState` を読むため、1フレーム内で必ず同じカメラが使われる。
//
// 単位の約束:
//   - `zoom` は「ワールド1単位あたりの **CSS** ピクセル数」。旧 three.js
//     OrthographicCamera.zoom と同じ意味・同じ既定値(40)なので、minZoomForFullMap の
//     戻り値(CSSピクセル基準)をそのまま下限に使える。
//   - `WebGpuCameraState.pixelsPerUnit` は物理ピクセル基準なので `zoom * dpr`。

import {
  ISO_X, ISO_Y, minZoomForFullMap, pixelsPerWorldUnit, type WebGpuCameraState,
} from './webgpuCamera';

export interface GameCameraState {
  /** 画面中心に写る地表(y=0)の点。 */
  centreX: number;
  centreZ: number;
  /** ワールド1単位あたりのCSSピクセル数(旧 three.js OrthographicCamera.zoom と同義)。 */
  zoom: number;
}

/** 初期カメラ。旧 GameScene の OrthographicCamera(zoom=40)+OrbitControls(target=原点)と同じ。 */
export const DEFAULT_CAMERA: Readonly<GameCameraState> = { centreX: 0, centreZ: 0, zoom: 40 };

/** ズーム上限。旧 OrbitControls の maxZoom と同じ値。 */
export const MAX_ZOOM = 100;

/** ズーム下限の安全弁(0や負値にならないための最低限。R3の GameScene と同じ考え方)。 */
export const MIN_ZOOM_FLOOR = 0.001;

/** 1ホイールノッチあたりの倍率(OrbitControls の zoomSpeed=1 と同じ 0.95)。 */
export const WHEEL_ZOOM_BASE = 0.95;

/** 1イベントで進めるノッチ数の上限(トラックパッドの巨大な deltaY を抑える)。 */
export const WHEEL_MAX_NOTCHES = 4;

export const createCameraState = (): GameCameraState => ({ ...DEFAULT_CAMERA });

export interface ViewportSize {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/** wgpu / ピッキング / ラベルが共通で読む物理ピクセル単位のカメラ状態へ変換する。 */
export const toWebGpuCameraState = (
  state: GameCameraState,
  viewport: ViewportSize,
): WebGpuCameraState => ({
  centreX: state.centreX,
  centreZ: state.centreZ,
  pixelsPerUnit: pixelsPerWorldUnit(state.zoom, viewport.dpr),
  widthPx: viewport.cssWidth * viewport.dpr,
  heightPx: viewport.cssHeight * viewport.dpr,
});

/**
 * 画面上の変位(ピクセル)を地表(y=0)のワールド変位へ落とす、projectToScreenPx の逆写像。
 *
 *   sx = (dx - dz) * ppu * ISO_X
 *   sy = (dx + dz) * ppu * ISO_Y
 * を dx/dz について解く。`pixelsPerUnit` は sx/sy と同じ単位系であればよい
 * (CSSピクセルを渡せば CSS の zoom、物理ピクセルを渡せば pixelsPerUnit)。
 */
export const screenDeltaToGroundDelta = (
  sx: number,
  sy: number,
  pixelsPerUnit: number,
): { dx: number; dz: number } => {
  if (!(pixelsPerUnit > 0)) return { dx: 0, dz: 0 };
  const a = sx / (pixelsPerUnit * ISO_X); // = dx - dz
  const b = sy / (pixelsPerUnit * ISO_Y); // = dx + dz
  return { dx: (a + b) / 2, dz: (b - a) / 2 };
};

/**
 * ポインタのドラッグ量(CSSピクセル)でパンする。掴んだ地表の点がポインタに
 * 貼り付いて動く挙動(= 画面中心は逆方向へ動く)。旧 OrbitControls の右ドラッグと同じ。
 */
export const panByScreenDelta = (
  state: GameCameraState,
  dxCssPx: number,
  dyCssPx: number,
): GameCameraState => {
  const { dx, dz } = screenDeltaToGroundDelta(dxCssPx, dyCssPx, state.zoom);
  return { ...state, centreX: state.centreX - dx, centreZ: state.centreZ - dz };
};

/**
 * ホイールの deltaY からズーム倍率を求める。
 * OrbitControls(orthographic)は注視点を動かさず zoom だけを 0.95^n 倍するので、
 * カーソル位置へ吸い寄せる挙動は**再現しない**(R4d 時点の UX 据え置き)。
 */
export const wheelZoomFactor = (deltaY: number, zoomSpeed = 1): number => {
  if (deltaY === 0) return 1;
  const notches = Math.max(-WHEEL_MAX_NOTCHES, Math.min(WHEEL_MAX_NOTCHES, deltaY * 0.01)) * zoomSpeed;
  return Math.pow(WHEEL_ZOOM_BASE, notches);
};

export const clampZoom = (zoom: number, minZoom: number, maxZoom: number): number =>
  Math.min(maxZoom, Math.max(minZoom, zoom));

export const zoomBy = (
  state: GameCameraState,
  factor: number,
  minZoom: number,
  maxZoom: number,
): GameCameraState => ({ ...state, zoom: clampZoom(state.zoom * factor, minZoom, maxZoom) });

/**
 * 全図(-halfExtent..halfExtent)が収まるズーム下限。R3で WebGPU モードだけ解禁した
 * `minZoomForFullMap` を、three.js 退役後は唯一の下限として使う。
 */
export const minZoomFor = (
  halfExtent: number,
  cssWidth: number,
  cssHeight: number,
): number => Math.max(MIN_ZOOM_FLOOR, minZoomForFullMap(halfExtent, cssWidth, cssHeight));
