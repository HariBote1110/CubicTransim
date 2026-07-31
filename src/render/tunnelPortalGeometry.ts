// トンネル坑口を「斜面に斜めに開いた穴」として描くための純粋な幾何計算。
// GameScene(描画専任)から呼ばれる。sim層(terrain.ts)のコーナー標高そのものは
// 変更せず、ここでは「坑口セルの4隅コーナー標高(cellCornersFromMap互換の順序)+
// 坑口が向く方向(dx,dz)」から、開口を斜面に沿わせるための傾き(ピッチ角)だけを導く。

// セル(x,z)の4隅の平面オフセット。sim/terrain.ts の CORNER_COORD_DELTAS /
// render/TerrainBlocks.tsx の CORNER_OFFSETS と同じ並び[左上,右上,右下,左下]。
const CORNER_OFFSETS: ReadonlyArray<[number, number]> = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

export interface PortalPitch {
  /** 開口を斜面に沿わせるための、ローカルX軸まわりの回転角(ラジアン)。 */
  pitch: number;
  /** 坑口が向く方向側(非mountain側、境界面)の平均標高(world Y単位)。 */
  outerHeight: number;
}

/**
 * 4隅のコーナー標高を、坑口が向く方向(dx,dz)への内積で「外側(坑口方向に近い2隅)」
 * 「内側(山の奥に近い2隅)」に分類する。オフセット(-0.5〜0.5)と方向ベクトルの内積が
 * 大きいほど坑口が向く方向に近いコーナーなので、内積上位2つを外側とする。
 * 直交方向(N/E/S/Wおよびその対角)のどちらでも同じロジックで動く。
 */
export function classifyPortalCorners(
  corners: readonly [number, number, number, number],
  dx: number,
  dz: number,
): { outer: [number, number]; inner: [number, number] } {
  const scored = corners.map((h, i) => {
    const [ox, oz] = CORNER_OFFSETS[i];
    return { h, dot: ox * dx + oz * dz };
  });
  const sorted = [...scored].sort((a, b) => b.dot - a.dot);
  return {
    outer: [sorted[0].h, sorted[1].h],
    inner: [sorted[2].h, sorted[3].h],
  };
}

/**
 * 坑口の開口を斜面に沿わせるためのピッチ角を求める。
 * 外側2隅の平均標高と内側2隅の平均標高の差(1セル=1ワールド単位あたりの高低差)を
 * rise/runとみなし、atan2で角度化する。この角度だけローカルX軸まわりに回転させれば、
 * 開口(平らな板)が斜面の傾きとほぼ一致する向きになる。
 */
/** ヘッドウォールの最低高さ(world Y単位)。平坦地でも開口+笠石を確保できる高さ。 */
export const MIN_HEADWALL_HEIGHT = 0.62;

/** ヘッドウォールを斜面へめり込ませる奥行きオフセット(world単位)。隙間・浮きを防ぐ。 */
export const HEADWALL_EMBED_DEPTH = 0.08;

export interface PortalHeadwall {
  /** ヘッドウォールの高さ(world Y単位)。切り口を覆うのに十分な高さを保証する。 */
  height: number;
  /** 坑口方向側(境界面)の基準標高(world Y単位)。壁の設置基準面。 */
  outerHeight: number;
  /** 壁を斜面へめり込ませるための奥行きオフセット(world単位、正の値)。 */
  embedDepth: number;
}

/**
 * ヘッドウォール(垂直な正面壁)に必要な高さを求める。
 * 内側(山側)コーナーが外側(坑口方向側)コーナーより高いぶんだけ、斜面の切り口が
 * 露出するため、その差ぶん壁を高くしないと斜面との間に隙間・段差が見えてしまう。
 * 平坦地(差が0以下)ではMIN_HEADWALL_HEIGHTを最低保証する。
 */
export function computePortalHeadwall(
  corners: readonly [number, number, number, number],
  dx: number,
  dz: number,
  overpassHeight: number,
): PortalHeadwall {
  const { outer, inner } = classifyPortalCorners(corners, dx, dz);
  const outerHeight = ((outer[0] + outer[1]) / 2) * overpassHeight;
  const innerHeight = ((inner[0] + inner[1]) / 2) * overpassHeight;
  const cutExposure = Math.max(0, innerHeight - outerHeight);
  const height = Math.max(MIN_HEADWALL_HEIGHT, MIN_HEADWALL_HEIGHT + cutExposure);
  return { height, outerHeight, embedDepth: HEADWALL_EMBED_DEPTH };
}

export function computePortalPitch(
  corners: readonly [number, number, number, number],
  dx: number,
  dz: number,
  overpassHeight: number,
): PortalPitch {
  const { outer, inner } = classifyPortalCorners(corners, dx, dz);
  const outerHeight = ((outer[0] + outer[1]) / 2) * overpassHeight;
  const innerHeight = ((inner[0] + inner[1]) / 2) * overpassHeight;
  const slope = innerHeight - outerHeight; // 1ワールド単位の奥行きあたりの高低差
  return { pitch: Math.atan2(slope, 1), outerHeight };
}
