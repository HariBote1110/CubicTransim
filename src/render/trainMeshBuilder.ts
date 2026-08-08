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

import * as THREE from 'three';
import { PALETTE } from './palette';
import { bakeGeometries, type BakedMeshChunk } from './bakedMesh';

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

function buildCarEntries(variant: PlaceholderCarVariant): RawEntry[] {
  const entries: RawEntry[] = [];
  const push = (geometry: THREE.BufferGeometry, colour: string, tint = false) => entries.push({ geometry, colour, tint });

  // 台車(前後2つ)
  for (const z of [-0.26, 0.26]) push(box(WIDTH - 0.08, 0.10, 0.18, 0, BOGIE_Y, z), PALETTE.carBogie);
  // 床下機器
  push(box(WIDTH - 0.03, 0.09, LEN - 0.1, 0, SKIRT_Y, 0), PALETTE.carSkirt);
  // 車体
  push(box(WIDTH, BODY_H, LEN, 0, BODY_Y, 0), PALETTE.carBody);
  // 側面窓帯(左右)
  for (const side of [-1, 1]) push(box(0.012, 0.105, LEN - 0.2, side * (WIDTH / 2 + 0.002), WINDOW_Y, 0), PALETTE.carWindow);
  // ラインカラーの帯(腰板部、左右) — 路線色でtintする
  for (const side of [-1, 1]) push(box(0.014, 0.055, LEN - 0.04, side * (WIDTH / 2 + 0.002), BODY_Y - 0.085, 0), PALETTE.carLine, true);
  // 屋根
  push(box(WIDTH - 0.07, 0.05, LEN - 0.03, 0, ROOF_Y, 0), PALETTE.carRoof);
  // 屋根上のクーラー
  for (const z of [-0.22, 0.22]) push(box(WIDTH - 0.19, 0.03, 0.16, 0, ROOF_Y + 0.038, z), PALETTE.carRoof);

  if (variant === 'head') {
    // 前後どちらの妻面にも前面窓・ラインカラー帯・前照灯/尾灯を置く
    // (car_head を180°回転してtail流用しても、進行方向側が常に白灯・反対側が赤灯になる)。
    for (const dir of [1, -1] as const) {
      const faceZ = dir * (NOSE + 0.004);
      push(box(WIDTH - 0.09, 0.11, 0.014, 0, WINDOW_Y + 0.015, faceZ), PALETTE.carWindow);
      push(box(WIDTH - 0.02, 0.05, 0.014, 0, BODY_Y - 0.085, faceZ), PALETTE.carLine, true);
      for (const sx of [-1, 1]) {
        push(
          box(0.05, 0.032, 0.012, sx * (WIDTH / 2 - 0.075), BODY_Y - 0.025, faceZ + dir * 0.006),
          dir === 1 ? PALETTE.headlight : PALETTE.taillight,
        );
      }
    }
    // 連結器は妻面のどちらか一方(-Z側=編成の内側)にだけ置く。全長が寸法制約(<=0.92)を
    // 超えないよう、突き出しは控えめにする。
    push(box(0.07, 0.05, 0.04, 0, SKIRT_Y - 0.02, -(NOSE + 0.01)), PALETTE.carBogie);
  }

  return entries;
}

/** 1車種ぶんのプレースホルダ形状を焼き込む(頂点色に陰影+tint重みを持つ)。 */
export function buildTrainCarMesh(variant: PlaceholderCarVariant): BakedMeshChunk | null {
  const entries = buildCarEntries(variant);
  const baked = bakeGeometries(entries.map(e => ({
    geometry: e.geometry,
    colour: e.colour,
    options: { alpha: e.tint ? 255 : 0 },
  })));
  for (const e of entries) e.geometry.dispose();
  return baked;
}

/** 選択マーカー(頭上の逆三角錐)。白ベースで全面tint(alpha=255)にし、選択色をそのまま乗せる。 */
export function buildSelectionMarkerMesh(): BakedMeshChunk | null {
  const geometry = new THREE.ConeGeometry(0.16, 0.28, 4);
  geometry.rotateX(Math.PI); // 先端を下に向ける(three.js版のrotation=[PI,0,0]と同じ見た目)
  const baked = bakeGeometries([{ geometry, colour: '#ffffff', options: { alpha: 255 } }]);
  geometry.dispose();
  return baked;
}

/** 経路プレビューのドット(小球で近似)。白ベースで全面tint。 */
export function buildRouteDotMesh(): BakedMeshChunk | null {
  const geometry = new THREE.OctahedronGeometry(0.09, 1);
  const baked = bakeGeometries([{ geometry, colour: '#ffffff', options: { alpha: 255 } }]);
  geometry.dispose();
  return baked;
}

/** プレースホルダ車体の寸法(バリデータ・テストの参考値として export)。 */
export const PLACEHOLDER_CAR_DIMENSIONS = { length: LEN, width: WIDTH } as const;
