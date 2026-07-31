// トンネル坑口(OpenTTD風の垂直ヘッドウォール+アーチ開口)を描くための純粋な幾何計算。
// GameScene(描画専任)から呼ばれる。sim層(terrain.ts)のコーナー標高そのものは
// 変更せず、ここでは「坑口セルの4隅コーナー標高(cellCornersFromMap互換の順序)+
// 坑口が向く方向(dx,dz)」から、ヘッドウォールに必要な高さと埋め込み奥行きだけを導く。

// セル(x,z)の4隅の平面オフセット。sim/terrain.ts の CORNER_COORD_DELTAS /
// render/TerrainBlocks.tsx の CORNER_OFFSETS と同じ並び[左上,右上,右下,左下]。
const CORNER_OFFSETS: ReadonlyArray<[number, number]> = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

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

/** ヘッドウォールの高さ(world Y単位、固定値)。地形は実際には切削しておらず、壁の
 *  背後の斜面は無傷のまま(壁がそれを覆い隠すだけ)なので、内外コーナーの標高差ぶん
 *  壁を高くする必要はない。openingStraightHeight(0.26)+archRadius(0.26)のアーチを
 *  収め、その上に笠石ぶんの梁(0.1程度)を確保できる高さとして0.62に固定している。
 *  OpenTTDの坑口も壁は山の1段ぶんの高さで止まり、山はその上に自然に続く。 */
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
 * ヘッドウォール(垂直な正面壁)の高さ・基準標高を求める。
 * 高さは常にMIN_HEADWALL_HEIGHT固定(内外コーナーの標高差は加算しない)。地形メッシュは
 * 坑口の有無に関わらず自然な斜面のままで実際には切削されておらず、壁が山の1段目を覆う
 * だけなので、標高差ぶん壁を高くする必要がそもそもない(以前はこれを加算しており、
 * 内外標高差が大きい坑口で壁が山の稜線より突き出て「塔門」に見える不具合があった)。
 * outerHeightは坑口方向側(境界面)の基準標高で、壁の設置基準面として引き続き返す。
 */
export function computePortalHeadwall(
  corners: readonly [number, number, number, number],
  dx: number,
  dz: number,
  overpassHeight: number,
): PortalHeadwall {
  const { outer } = classifyPortalCorners(corners, dx, dz);
  const outerHeight = ((outer[0] + outer[1]) / 2) * overpassHeight;
  return { height: MIN_HEADWALL_HEIGHT, outerHeight, embedDepth: HEADWALL_EMBED_DEPTH };
}

/** ローカルXY平面上の2次元点。壁・開口の断面はこの平面(X=左右, Y=高さ)に描く。 */
export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/**
 * アーチ開口の断面(下半分=矩形、上半分=半円)を、地面(y=0)で開いた1本の折れ線として
 * 返す。archRadius===openingHalfWidthのとき、半円の両端が直線部の上端(y=openingStraightHeight)
 * にちょうど繋がり、滑らかな馬蹄形になる。
 * 半円はTHREE.Path.absarcと同じ角度規約(角度0=+X、反時計回りが正)で、角度πの左端から
 * 角度0の右端まで、頂上(角度π/2)を通って時計回りに分割する。これによりx座標は常に
 * [-archRadius, archRadius]の対称範囲に収まり、片側だけが描かれる非対称の不具合を防ぐ。
 * 頂点順序: 左足元(y=0)→左直線→半円(左→上→右)→右直線→右足元(y=0)。
 */
export function buildArchOutline(
  openingHalfWidth: number,
  openingStraightHeight: number,
  archRadius: number,
  archSegments = 16,
): Point2D[] {
  const points: Point2D[] = [];
  points.push({ x: -openingHalfWidth, y: 0 });
  points.push({ x: -openingHalfWidth, y: openingStraightHeight });
  for (let i = 1; i < archSegments; i++) {
    const angle = Math.PI - (Math.PI * i) / archSegments;
    points.push({
      x: archRadius * Math.cos(angle),
      y: openingStraightHeight + archRadius * Math.sin(angle),
    });
  }
  points.push({ x: openingHalfWidth, y: openingStraightHeight });
  points.push({ x: openingHalfWidth, y: 0 });
  return points;
}

/**
 * ヘッドウォール(壁)の外形を、中央にアーチ開口の切り欠きを持つ1本の閉じた折れ線として
 * 返す。開口はbuildArchOutlineの折れ線をそのまま壁の足元(y=0)に切り込ませているため、
 * 「壁の中に別パーツの黒い開口パネルを重ねる」張りぼて構成ではなく、壁自体に実際に穴が
 * 開いた1枚のジオメトリになる(THREE.ExtrudeGeometryでこの外形を押し出して使う想定)。
 * 頂点順序: 左足元→開口の切り欠き→右足元→右上→左上(→左足元に閉じる)。
 */
export function buildHeadwallOutline(
  wallWidth: number,
  wallHeight: number,
  openingHalfWidth: number,
  openingStraightHeight: number,
  archRadius: number,
  archSegments = 16,
): Point2D[] {
  const halfWidth = wallWidth / 2;
  const notch = buildArchOutline(openingHalfWidth, openingStraightHeight, archRadius, archSegments);
  return [
    { x: -halfWidth, y: 0 },
    ...notch,
    { x: halfWidth, y: 0 },
    { x: halfWidth, y: wallHeight },
    { x: -halfWidth, y: wallHeight },
  ];
}
