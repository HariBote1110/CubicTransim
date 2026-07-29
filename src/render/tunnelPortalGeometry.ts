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
