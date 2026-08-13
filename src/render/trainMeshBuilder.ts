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
// それを見てbox形状を組み立てる。先頭車の「流線形の鼻先」はShape+ExtrudeGeometryではなく、
// 幅・高さを段階的に絞った2段のBoxGeometryで近似する(タスク仕様が明示的に許容する
// 「角度付きboxでの近似」。全長は寸法制約(<=0.92)を超えないよう、鼻先の突き出しは
// 車体本体(LEN=0.86)に対してわずか(express: 片側0.02)にとどめる)。

import * as THREE from './geom';
import { PALETTE } from './palette';
import { bakeGeometries, type BakedMeshChunk } from './bakedMesh';
import type { TrainModelId } from '../sim/physics';

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

interface RawEntry {
  geometry: THREE.BufferGeometry;
  colour: string;
  /** true: 路線色で塗り替える面(alpha=255)。false: 焼き込んだ色そのまま(alpha=0)。 */
  tint: boolean;
}

const box = (
  sx: number, sy: number, sz: number,
  tx: number, ty: number, tz: number,
): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(tx, ty, tz);
  return g;
};

/** 原点中心のまま返す(rotateX等で傾けてから配置したいときに使う)。 */
const rawBox = (sx: number, sy: number, sz: number): THREE.BufferGeometry => new THREE.BoxGeometry(sx, sy, sz);

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

function buildCarEntries(variant: PlaceholderCarVariant, modelId: TrainModelId): RawEntry[] {
  const spec = MODEL_VISUALS[modelId];
  const entries: RawEntry[] = [];
  const push = (geometry: THREE.BufferGeometry, colour: string, tint = false) => entries.push({ geometry, colour, tint });

  // 台車(前後2つ)
  for (const z of [-0.26, 0.26]) push(box(WIDTH - 0.08, 0.10, 0.18, 0, BOGIE_Y, z), PALETTE.carBogie);
  // 床下機器
  push(box(WIDTH - 0.03, 0.09, LEN - 0.1, 0, SKIRT_Y, 0), PALETTE.carSkirt);
  // 車体
  push(box(WIDTH, BODY_H, LEN, 0, BODY_Y, 0), spec.bodyColour);
  // 側面窓帯(左右)
  for (const side of [-1, 1]) push(box(0.012, 0.105, LEN - 0.2, side * (WIDTH / 2 + 0.002), WINDOW_Y, 0), PALETTE.carWindow);
  // ラインカラーの帯(側面、左右) — 車種ごとに1本または2本。路線色でtintする
  for (const band of spec.bands) {
    for (const side of [-1, 1]) {
      push(box(0.014, band.height, LEN - 0.04, side * (WIDTH / 2 + 0.002), BODY_Y + band.offsetY, 0), PALETTE.carLine, true);
    }
  }
  // 屋根
  push(box(WIDTH - 0.07, 0.05, LEN - 0.03, 0, ROOF_Y, 0), spec.roofColour);
  // 屋根上のクーラー
  for (const z of [-0.22, 0.22]) push(box(WIDTH - 0.19, 0.03, 0.16, 0, ROOF_Y + 0.038, z), spec.roofColour);

  if (variant === 'head') {
    // 前後どちらの妻面にも前面(窓/鼻先)・ラインカラー帯・前照灯/尾灯を置く
    // (car_head を180°回転してtail流用しても、進行方向側が常に白灯・反対側が赤灯になる)。
    for (const dir of [1, -1] as const) {
      buildFace(push, dir, spec);
    }
    // 連結器は妻面のどちらか一方(-Z側=編成の内側)にだけ置く。全長が寸法制約(<=0.92)を
    // 超えないよう、突き出しは控えめにする。
    push(box(0.07, 0.05, 0.04, 0, SKIRT_Y - 0.02, -(NOSE + 0.01)), PALETTE.carBogie);
  }

  return entries;
}

/** 前照灯/尾灯を1組(左右)配置する。 */
function pushLamp(
  push: (g: THREE.BufferGeometry, colour: string, tint?: boolean) => void,
  dir: 1 | -1,
  z: number,
  y: number,
): void {
  for (const sx of [-1, 1]) {
    push(
      box(0.05, 0.032, 0.012, sx * (WIDTH / 2 - 0.075), y, z + dir * 0.006),
      dir === 1 ? PALETTE.headlight : PALETTE.taillight,
    );
  }
}

/** 1方向(dir=+1:進行方向側、-1:反対側)ぶんの前面ジオメトリを、車種の前面スタイルに応じて積む。 */
function buildFace(
  push: (g: THREE.BufferGeometry, colour: string, tint?: boolean) => void,
  dir: 1 | -1,
  spec: ModelVisualSpec,
): void {
  const faceZ = dir * (NOSE + 0.004);

  if (spec.face === 'flat-black') {
    // E235系風: 前面窓を額縁ごと黒いマスクパネルへ拡張する。
    push(box(WIDTH - 0.04, 0.17, 0.014, 0, WINDOW_Y + 0.01, faceZ), '#14181c');
    for (const band of spec.bands) push(box(WIDTH - 0.02, band.height, 0.014, 0, BODY_Y + band.offsetY, faceZ), PALETTE.carLine, true);
    pushLamp(push, dir, faceZ, WINDOW_Y - 0.01);
    return;
  }

  if (spec.face === 'bevel') {
    // E233近郊形風: 前面窓パネルだけをわずかに後方へ傾け、面取りの陰影を作る。
    const tilt = 0.22;
    const panel = rawBox(WIDTH - 0.09, 0.11, 0.014);
    panel.rotateX(-tilt * dir);
    panel.translate(0, WINDOW_Y + 0.015, faceZ);
    push(panel, PALETTE.carWindow);
    for (const band of spec.bands) push(box(WIDTH - 0.02, band.height, 0.014, 0, BODY_Y + band.offsetY, faceZ), PALETTE.carLine, true);
    pushLamp(push, dir, faceZ, BODY_Y - 0.025);
    return;
  }

  // 'nose-long' (E657/E353系風) / 'nose-short' (E257系風):
  // 幅・高さを段階的に絞った2段のBoxGeometryで流線形の鼻先を近似する。
  const isLong = spec.face === 'nose-long';
  const noseLen = isLong ? 0.17 : 0.08;
  const overhang = isLong ? 0.015 : 0.0;
  const backZ = dir * (NOSE - noseLen);
  const midZ = dir * (NOSE - noseLen * 0.35);
  const tipZ = dir * (NOSE + overhang);

  // 下段: 車体幅に近いまま前へ張り出す
  push(box(WIDTH - 0.06, BODY_H - 0.06, Math.abs(midZ - backZ) + 0.02, 0, BODY_Y - 0.02, (backZ + midZ) / 2), spec.bodyColour);
  // 先端段: さらに幅・高さを絞る
  push(box(WIDTH - 0.16, BODY_H - 0.13, Math.abs(tipZ - midZ) + 0.02, 0, BODY_Y - 0.03, (midZ + tipZ) / 2), spec.bodyColour);

  for (const band of spec.bands) push(box(WIDTH - 0.20, band.height, 0.012, 0, BODY_Y + band.offsetY, tipZ), PALETTE.carLine, true);
  if (spec.face === 'nose-short') {
    // E257系風: 前面に路線色のアクセントパッチを追加する。
    push(box(WIDTH - 0.28, 0.03, 0.012, 0, BODY_Y - 0.03, tipZ), PALETTE.carLine, true);
  }
  pushLamp(push, dir, tipZ, BODY_Y - 0.03);
}

/** 1車種ぶんのプレースホルダ形状を焼き込む(頂点色に陰影+tint重みを持つ)。modelIdの既定は通勤形。 */
export function buildTrainCarMesh(variant: PlaceholderCarVariant, modelId: TrainModelId = 'commuter'): BakedMeshChunk | null {
  const entries = buildCarEntries(variant, modelId);
  const baked = bakeGeometries(entries.map(e => ({
    geometry: e.geometry,
    colour: e.colour,
    options: { alpha: e.tint ? 255 : 0, unlit: true },
  })));
  for (const e of entries) e.geometry.dispose();
  return baked;
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
