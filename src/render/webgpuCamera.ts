// WebGPU地形レイヤー(下層キャンバス)のカメラ同期。
//
// 上層の three.js は OrthographicCamera(position=(20,20,20)・up=+Y・enableRotate=false)で
// 真等角(true isometric)に描いている。下層の wgpu も同じ画面座標へ落とさないと地形と
// レールがずれるため、three.js のカメラ設定から解析的に投影式を導き、その式を
// renderer/renderer_wgpu/shaders/terrain_draw.wgsl と共有する(向こうの ISO_X/ISO_Y が
// ここの定数と同じ値)。
//
// 導出:
//   カメラ基底は Z_cam = (1,1,1)/√3、X_cam = normalize(up × Z_cam) = (1,0,-1)/√2、
//   Y_cam = Z_cam × X_cam = (-1,2,-1)/√6。
//   直交カメラ(left/right=∓w/2, top/bottom=±h/2, zoom)では、画面中心からの
//   CSSピクセル変位が (world・X_cam)*zoom, (world・Y_cam)*zoom になるので
//     sx        = (x - z)/√2      * zoom
//     sy(下向き) = (x + z - 2y)/√6 * zoom
//   物理ピクセルで扱うため zoom には DPR を掛ける(= pixelsPerWorldUnit)。

/** 画面横方向の係数 1/√2。shaders/terrain_draw.wgsl の ISO_X と同一。 */
export const ISO_X = Math.SQRT1_2;
/** 画面縦方向の係数 1/√6。shaders/terrain_draw.wgsl の ISO_Y と同一。 */
export const ISO_Y = 1 / Math.sqrt(6);
/** 高さ(ワールドy)の係数 2/√6。wasm 側は height_scale = ppc * ISO_H * OVERPASS_HEIGHT を使う。 */
export const ISO_H = 2 / Math.sqrt(6);

export interface WebGpuCameraState {
  /** 画面中心に来る地表(y=0)の点。 */
  centreX: number;
  centreZ: number;
  /** ワールド1単位あたりの物理ピクセル数(= three.js の zoom × DPR)。 */
  pixelsPerUnit: number;
  /** 下層キャンバスの物理ピクセルサイズ。 */
  widthPx: number;
  heightPx: number;
}

/**
 * OrbitControls の注視点(target)から、画面中心に見える地表(y=0)の点を求める。
 *
 * 画面中心には target そのものが写る。等角投影では (x,y,z) と (x-y, 0, z-y) が同じ
 * 画面位置に落ちる(sx・sy の両式に代入すると一致する)ので、地表側の代表点は
 * (tx-ty, tz-ty) になる。OrbitControls のパンは target.y を動かしうるため、
 * y を無視して target.x/target.z をそのまま渡すとズレる。
 */
export const groundCentreFromTarget = (
  target: { x: number; y: number; z: number },
): { centreX: number; centreZ: number } => ({
  centreX: target.x - target.y,
  centreZ: target.z - target.y,
});

/** ワールド1単位あたりの物理ピクセル数。 */
export const pixelsPerWorldUnit = (zoom: number, dpr: number): number => zoom * dpr;

/**
 * 全図(-halfExtent..halfExtentのダイヤモンド)がビューポートに収まる、three.js
 * OrbitControlsのminZoomの下限値(R3)。
 *
 * renderer/renderer_wgpu/src/lib.rs の full_map_min_ppc と同じ式(ISO_X/ISO_Y)から導く。
 * 向こうは物理ピクセル(width/height)で ppc(pixelsPerUnit) の下限を計算するが、
 * ppc = zoom * dpr なので dpr は式から相殺して消える
 * (zoom_min = width_px/(4*half*ISO_X)/dpr = (width_px/dpr)/(4*half*ISO_X) = cssWidth/(4*half*ISO_X))。
 * そのためこの関数は CSS ピクセル(three.jsのOrbitControls/zoomがそのまま使う単位)の
 * viewport幅・高さをそのまま渡せばよく、DPRを引数に取らない。
 *
 * halfExtentが1未満(縮退マップ)は1として扱う(lib.rs側のhalf_extent.max(1)と同じ)。
 */
/**
 * OrthographicCameraのnear/farをhalfExtentに応じて広げる(R3)。
 *
 * GameScene.tsxのカメラはposition=target+(20,20,20)で常にtargetから一定オフセットの
 * 位置にいるため、target付近だけを描く分にはnear/farを固定値(-50/200)のままでも
 * 問題ない(TerrainBlocks/Scenery/TrackNetwork等は可視チャンクだけをcameraTargetCell
 * 付近に描くため)。しかしTownMarkers(R3、遠景の町ドット)はカメラのtarget位置に関係なく
 * マップ全域の点を一括で描くため、target から離れた町ほど視線方向(1,1,1)/√3への
 * 射影(深度)が大きくなり、固定のnear/farでは視錐台の外に出てクリップされてしまう
 * (全図ズームアウトで町の一部しか見えない不具合の原因だった)。
 *
 * 深度は (target-p)の各成分の合計を√3で割った値なので、p がマップの対角
 * (-halfExtent..halfExtent の正方形)を動くと、その合計の振れ幅は最大で
 * 4*halfExtent(x成分・z成分それぞれ最大2*halfExtentぶん振れる)になる。安全のため
 * その値をそのままnear/farの両側へ広げる(y成分・オフセット(20,20,20)ぶんは
 * 元のbaseNear/baseFarの余白で十分吸収できる)。
 */
export const DEPTH_MARGIN_PER_HALF_EXTENT = 4 / Math.sqrt(3);

export const orthographicNearFarForHalfExtent = (
  halfExtent: number,
  baseNear = -50,
  baseFar = 200,
): { near: number; far: number } => {
  const margin = Math.max(0, halfExtent) * DEPTH_MARGIN_PER_HALF_EXTENT;
  return { near: baseNear - margin, far: baseFar + margin };
};

export const minZoomForFullMap = (
  halfExtent: number,
  viewportWidthCssPx: number,
  viewportHeightCssPx: number,
): number => {
  const half = Math.max(1, halfExtent);
  return Math.min(
    viewportWidthCssPx / (4 * half * ISO_X),
    viewportHeightCssPx / (4 * half * ISO_Y),
  );
};

/**
 * ワールド座標を、画面中心を原点とする物理ピクセル座標へ落とす(sy は下向きが正)。
 * wgpu シェーダの project() と同じ式。整合検証用。
 */
export const projectToScreenPx = (
  world: { x: number; y: number; z: number },
  camera: WebGpuCameraState,
): { sx: number; sy: number } => {
  const rx = world.x - camera.centreX;
  const rz = world.z - camera.centreZ;
  return {
    sx: (rx - rz) * camera.pixelsPerUnit * ISO_X,
    sy: (rx + rz) * camera.pixelsPerUnit * ISO_Y - world.y * camera.pixelsPerUnit * ISO_H,
  };
};
