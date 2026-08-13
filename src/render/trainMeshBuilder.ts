// R4c: WebGPUモードの列車インスタンス描画用プロトタイプメッシュ(プレースホルダ形状)。
//
// components/TrainCar.tsx のプリミティブ構成(台車・床下機器・車体・窓帯・ラインカラー帯・
// 屋根・クーラー・先頭車の前面)をそのまま複製し、静的なジオメトリ+頂点色として1回だけ
// 焼き込む(TrainCar.tsx自体はclassicモード用にJSXのまま残す。R4d でclassic側が
// 削除されるまでは二重管理になるが、寸法定数は数値としてそのまま複製しているだけで、
// 見た目の一次情報源は progress/train-model-format.md の寸法制約に揃えてある)。
//
// tint(路線色)規約は bakedMesh.ts / mesh_instanced.wgsl と同じ:
// ラインカラー帯(帯・妻面の帯)だけ alpha=255(路線色で塗り替え)、それ以外は
// alpha=0(焼き込んだ色そのまま)にする。
//
// 車種idの物理仕様(全長・全幅・原点の位置など)は progress/train-model-format.md 準拠。
// car_head は spec の通り +Z を向く「顔」で、最後尾は呼び出し側が yaw+180° して流用する
// (この関数自身は反転しない)。ヘッドライト/テールライトは前後どちらの妻面にも置き、
// 180°回転で流用しても常に「進行方向の顔が白、後方が赤」に見えるようにしている
// (three.js版TrainCarはvariantごとに片方だけ生やしていたのに対する意図的な簡略化。
// progress/r4-threejs-retirement-plan.md のR4c実装メモに記載)。
//
// 0.5.0-Alpha-22a: 車種(TrainModelId)ごとに見た目を描き分ける(progress/train-visuals.md)。
// 車体色・帯レイアウト・前面スタイルを MODEL_VISUALS テーブルで持ち、buildCarEntries が
// それを見てbox形状を組み立てる。
//
// Phase A(列車外観エディタ計画): 車種ごとの見た目を「宣言的パーツ配列」(TrainPart[]、
// trainPartsSpec.ts)として MODEL_PARTS に持たせるよう書き換えた。以前は buildCarEntries が
// box()呼び出しを直接積んでいたが、そのロジックを「TrainPartを積むヘルパー関数群」へ移し、
// 最終的に得られる MODEL_PARTS は JSON往復可能なプレーンデータになる(Phase Bのエディタが
// これをそのまま読み書きする想定)。buildTrainCarMesh は MODEL_PARTS + buildCarMeshFromParts の
// 薄いラッパーに縮小した。流線形の鼻先(nose-long/nose-short)は、以前の「2段のBoxGeometryで
// 近似」から trainPartsSpec.ts の 'wedge' パーツ(1パーツで後端の矩形断面→前端の低いエッジへ
// 傾斜する形状)に置き換えている。

import * as THREE from './geom';
import { PALETTE } from './palette';
import { bakeGeometries, type BakedMeshChunk } from './bakedMesh';
import type { TrainModelId } from '../sim/physics';
import { buildPartGeometry, type TrainPart, type TrainCarParts } from './trainPartsSpec';

// --- 寸法(TrainCar.tsxと同じ値。1セル=1.0、車間spacing=1.0) ---
const LEN = 0.86;
const WIDTH = 0.44;
const BODY_H = 0.25;
const BODY_Y = 0.01;
const ROOF_Y = BODY_Y + BODY_H / 2 + 0.025;
const SKIRT_Y = BODY_Y - BODY_H / 2 - 0.045;
const BOGIE_Y = -0.32;
const WINDOW_Y = BODY_Y + 0.045;
const NOSE = LEN / 2;

export type PlaceholderCarVariant = 'head' | 'mid';

/** 帯(ラインカラー)1本ぶんのレイアウト。offsetYはBODY_Yからの相対値。 */
interface BandSpec {
  offsetY: number;
  height: number;
}

/** 前面(妻面)の見た目バリエーション。progress/train-visuals.md の表と対応する。 */
type FaceStyle = 'flat-black' | 'bevel' | 'nose-long' | 'nose-short';

interface ModelVisualSpec {
  bodyColour: string;
  roofColour: string;
  bands: BandSpec[];
  face: FaceStyle;
}

// 車種ごとの見た目スペック(JR東日本風の外観差別化)。
// - commuter (E235系風): 銀色車体・単帯・E235風の黒い額縁前面。
// - suburban (E233近郊風): 銀色車体・二本帯(腰板+窓下)・前面をわずかに傾けた面取り。
// - express (E657/E353系風): 白色車体・濃色屋根・高い位置の細帯・流線形の鼻先(長め)。
// - local-express (E257系風): クリーム色車体・通常帯+前面アクセント・短めの鼻先。
const MODEL_VISUALS: Record<TrainModelId, ModelVisualSpec> = {
  commuter: {
    bodyColour: PALETTE.carBody,
    roofColour: PALETTE.carRoof,
    bands: [{ offsetY: -0.085, height: 0.055 }],
    face: 'flat-black',
  },
  suburban: {
    bodyColour: PALETTE.carBody,
    roofColour: PALETTE.carRoof,
    bands: [
      { offsetY: -0.085, height: 0.045 },
      { offsetY: 0.028, height: 0.02 },
    ],
    face: 'bevel',
  },
  express: {
    bodyColour: '#f2f3f5',
    roofColour: '#8b939c',
    bands: [{ offsetY: 0.075, height: 0.028 }],
    face: 'nose-long',
  },
  'local-express': {
    bodyColour: '#ece9e0',
    roofColour: PALETTE.carRoof,
    bands: [{ offsetY: -0.085, height: 0.05 }],
    face: 'nose-short',
  },
};

const box = (
  size: [number, number, number],
  pos: [number, number, number],
  colour: string,
  tint = false,
  label?: string,
): TrainPart => ({ kind: 'box', size, pos, colour, tint, label });

/** 台車(前後2つ)。 */
function bogieParts(): TrainPart[] {
  return [-0.26, 0.26].map(z => box([WIDTH - 0.08, 0.10, 0.18], [0, BOGIE_Y, z], PALETTE.carBogie, false, '台車'));
}

/** 床下機器。 */
function skirtPart(): TrainPart {
  return box([WIDTH - 0.03, 0.09, LEN - 0.1], [0, SKIRT_Y, 0], PALETTE.carSkirt, false, '床下機器');
}

/** 車体本体。 */
function bodyPart(colour: string): TrainPart {
  return box([WIDTH, BODY_H, LEN], [0, BODY_Y, 0], colour, false, '車体');
}

/** 側面窓帯(左右)。 */
function windowParts(): TrainPart[] {
  return [-1, 1].map(side => box([0.012, 0.105, LEN - 0.2], [side * (WIDTH / 2 + 0.002), WINDOW_Y, 0], PALETTE.carWindow, false, '窓'));
}

/** ラインカラーの帯(側面、左右) — 車種ごとに1本または2本。路線色でtintする。 */
function bandParts(bands: readonly BandSpec[]): TrainPart[] {
  const parts: TrainPart[] = [];
  for (const band of bands) {
    for (const side of [-1, 1]) {
      parts.push(box([0.014, band.height, LEN - 0.04], [side * (WIDTH / 2 + 0.002), BODY_Y + band.offsetY, 0], PALETTE.carLine, true, '帯'));
    }
  }
  return parts;
}

/** 屋根+屋根上のクーラー。 */
function roofParts(colour: string): TrainPart[] {
  const parts: TrainPart[] = [box([WIDTH - 0.07, 0.05, LEN - 0.03], [0, ROOF_Y, 0], colour, false, '屋根')];
  for (const z of [-0.22, 0.22]) parts.push(box([WIDTH - 0.19, 0.03, 0.16], [0, ROOF_Y + 0.038, z], colour, false, 'クーラー'));
  return parts;
}

/** 連結器(妻面の一方、-Z側=編成の内側にだけ置く)。 */
function couplerPart(): TrainPart {
  return box([0.07, 0.05, 0.04], [0, SKIRT_Y - 0.02, -(NOSE + 0.01)], PALETTE.carBogie, false, '連結器');
}

/** 前照灯/尾灯を1組(左右)配置する。dir=+1で進行方向側(白)、-1で反対側(赤)。 */
function lampParts(dir: 1 | -1, z: number, y: number): TrainPart[] {
  return [-1, 1].map(sx => box(
    [0.05, 0.032, 0.012],
    [sx * (WIDTH / 2 - 0.075), y, z + dir * 0.006],
    dir === 1 ? PALETTE.headlight : PALETTE.taillight,
    false,
    dir === 1 ? '前照灯' : '尾灯',
  ));
}

/** 1方向(dir=+1:進行方向側、-1:反対側)ぶんの前面パーツを、車種の前面スタイルに応じて積む。 */
function faceParts(dir: 1 | -1, spec: ModelVisualSpec): TrainPart[] {
  const faceZ = dir * (NOSE + 0.004);
  const parts: TrainPart[] = [];

  if (spec.face === 'flat-black') {
    // E235系風: 前面窓を額縁ごと黒いマスクパネルへ拡張する。
    parts.push(box([WIDTH - 0.04, 0.17, 0.014], [0, WINDOW_Y + 0.01, faceZ], '#14181c', false, '前面マスク'));
    for (const band of spec.bands) parts.push(box([WIDTH - 0.02, band.height, 0.014], [0, BODY_Y + band.offsetY, faceZ], PALETTE.carLine, true, '前面帯'));
    parts.push(...lampParts(dir, faceZ, WINDOW_Y - 0.01));
    return parts;
  }

  if (spec.face === 'bevel') {
    // E233近郊形風: 前面窓パネルだけをわずかに後方へ傾け、面取りの陰影を作る。
    const tilt = 0.22;
    parts.push({
      kind: 'box',
      size: [WIDTH - 0.09, 0.11, 0.014],
      pos: [0, WINDOW_Y + 0.015, faceZ],
      rot: [-tilt * dir, 0, 0],
      colour: PALETTE.carWindow,
      label: '前面窓(面取り)',
    });
    for (const band of spec.bands) parts.push(box([WIDTH - 0.02, band.height, 0.014], [0, BODY_Y + band.offsetY, faceZ], PALETTE.carLine, true, '前面帯'));
    parts.push(...lampParts(dir, faceZ, BODY_Y - 0.025));
    return parts;
  }

  // 'nose-long' (E657/E353系風) / 'nose-short' (E257系風):
  // wedgeパーツ1つで、後端(車体幅×車体高)から前端の低いエッジへ傾斜する流線形を作る。
  const isLong = spec.face === 'nose-long';
  const noseLen = isLong ? 0.17 : 0.08;
  const overhang = isLong ? 0.015 : 0.0;
  const wedgeH = BODY_H - 0.05;
  const wedgeW = WIDTH - 0.06;
  const backZ = dir * (NOSE - noseLen);
  const tipZ = dir * (NOSE + overhang);
  const depth = Math.abs(tipZ - backZ);
  const centreZ = (backZ + tipZ) / 2;
  parts.push({
    kind: 'wedge',
    size: [wedgeW, wedgeH, depth],
    pos: [0, BODY_Y - 0.02, centreZ],
    // dir=-1側は wedge のローカル+Z(低いエッジ側)がワールド-Z を向くよう180°回す。
    rot: dir === 1 ? undefined : [0, Math.PI, 0],
    colour: spec.bodyColour,
    label: '鼻先',
  });

  for (const band of spec.bands) parts.push(box([WIDTH - 0.20, band.height, 0.012], [0, BODY_Y + band.offsetY, tipZ], PALETTE.carLine, true, '前面帯'));
  if (spec.face === 'nose-short') {
    // E257系風: 前面に路線色のアクセントパッチを追加する。
    parts.push(box([WIDTH - 0.28, 0.03, 0.012], [0, BODY_Y - 0.03, tipZ], PALETTE.carLine, true, 'アクセント'));
  }
  if (isLong) {
    // E657/E353系風: 鼻先の付け根に前面窓(ウインドシールド)を追加する。
    parts.push(box([wedgeW - 0.12, 0.09, 0.012], [0, BODY_Y + 0.05, backZ + dir * 0.006], PALETTE.carWindow, false, '前面窓'));
  }
  parts.push(...lampParts(dir, tipZ, BODY_Y - 0.03));
  return parts;
}

/** 1車種・1バリアントぶんのパーツ配列を組み立てる。 */
function buildCarParts(variant: PlaceholderCarVariant, modelId: TrainModelId): TrainPart[] {
  const spec = MODEL_VISUALS[modelId];
  const parts: TrainPart[] = [
    ...bogieParts(),
    skirtPart(),
    bodyPart(spec.bodyColour),
    ...windowParts(),
    ...bandParts(spec.bands),
    ...roofParts(spec.roofColour),
  ];

  if (variant === 'head') {
    // 前後どちらの妻面にも前面(窓/鼻先)・ラインカラー帯・前照灯/尾灯を置く
    // (car_head を180°回転してtail流用しても、進行方向側が常に白灯・反対側が赤灯になる)。
    for (const dir of [1, -1] as const) parts.push(...faceParts(dir, spec));
    // 連結器は妻面のどちらか一方(-Z側=編成の内側)にだけ置く。全長が寸法制約(<=0.92)を
    // 超えないよう、突き出しは控えめにする。
    parts.push(couplerPart());
  }

  return parts;
}

const MODEL_IDS: readonly TrainModelId[] = ['commuter', 'suburban', 'express', 'local-express'];

/**
 * 車種(TrainModelId)ごとの見た目を宣言的パーツ配列で持つテーブル。JSONへ往復可能な
 * プレーンデータ(TrainPart[])のみで構成される。Phase B(列車外観エディタ)がこれを
 * そのまま読み書きする想定。
 */
export const MODEL_PARTS: Record<TrainModelId, TrainCarParts> = Object.fromEntries(
  MODEL_IDS.map(modelId => [modelId, {
    head: buildCarParts('head', modelId),
    mid: buildCarParts('mid', modelId),
  }]),
) as Record<TrainModelId, TrainCarParts>;

/**
 * パーツ配列(頭上の逆三角錐)を、tint(路線色)/焼き込み色の規約に従って1メッシュへ焼き込む。
 * `highlightIndex` はエディタ専用のオプション(ゲーム本体は未使用=undefinedのまま呼ぶ)。
 * 指定したパーツだけ `highlightColour` で不透明に塗り替え、選択状態を可視化する。
 */
export function buildCarMeshFromParts(
  parts: TrainPart[],
  highlightIndex?: number,
  highlightColour = '#ff2e63',
): BakedMeshChunk | null {
  const geometries = parts.map(part => buildPartGeometry(part));
  const baked = bakeGeometries(parts.map((part, i) => ({
    geometry: geometries[i],
    colour: i === highlightIndex ? highlightColour : part.colour,
    options: { alpha: i === highlightIndex ? 255 : (part.tint ? 255 : 0), unlit: true },
  })));
  for (const g of geometries) g.dispose();
  return baked;
}

/** 1車種ぶんのプレースホルダ形状を焼き込む(頂点色に陰影+tint重みを持つ)。modelIdの既定は通勤形。 */
export function buildTrainCarMesh(variant: PlaceholderCarVariant, modelId: TrainModelId = 'commuter'): BakedMeshChunk | null {
  return buildCarMeshFromParts(MODEL_PARTS[modelId][variant]);
}

/** 選択マーカー(頭上の逆三角錐)。白ベースで全面tint(alpha=255)にし、選択色をそのまま乗せる。 */
export function buildSelectionMarkerMesh(): BakedMeshChunk | null {
  const geometry = new THREE.ConeGeometry(0.16, 0.28, 4);
  geometry.rotateX(Math.PI); // 先端を下に向ける(three.js版のrotation=[PI,0,0]と同じ見た目)
  const baked = bakeGeometries([{ geometry, colour: '#ffffff', options: { alpha: 255, unlit: true } }]);
  geometry.dispose();
  return baked;
}

/** 経路プレビューのドット(小球で近似)。白ベースで全面tint。 */
export function buildRouteDotMesh(): BakedMeshChunk | null {
  const geometry = new THREE.OctahedronGeometry(0.09, 1);
  const baked = bakeGeometries([{ geometry, colour: '#ffffff', options: { alpha: 255, unlit: true } }]);
  geometry.dispose();
  return baked;
}

/** プレースホルダ車体の寸法(バリデータ・テストの参考値として export)。 */
export const PLACEHOLDER_CAR_DIMENSIONS = { length: LEN, width: WIDTH } as const;
