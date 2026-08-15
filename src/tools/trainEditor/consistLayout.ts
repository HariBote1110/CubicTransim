// 列車外観エディタのプレビュー編成(head+mid+tail)のレイアウト計算。
// previewController.ts(描画への流し込み)と partPicking.ts(画面上ピッキング)が
// 同じ変換を共有するための純関数。two箇所で式がずれるとクリック判定と見た目がずれるため、
// 1箇所にまとめる。

/** 車間spacing(ゲーム本体のcarPositions呼び出しと同じ1.0)。 */
export const CAR_SPACING = 1.0;

/**
 * 地表(y=0)に対する車体origin(car group)の高さ。ゲーム本体では
 * carGroupPosition(trainInstanceMath.ts)が RAIL_SUPPORT_OFFSET 分だけ持ち上げており、
 * 平坦な線路上(heading.y=0)では renderPos.y=0.5 が「車輪が地面に接する」高さになる
 * (progress/train-model-format.md: モデル空間の y=0 がレール上面)。
 * エディタは平坦プロファイルの地表(高さ0)固定なので、この定数をそのまま使う。
 */
export const GROUND_SURFACE_Y = 0.5;

export type CarVariant = 'head' | 'mid';

export interface CarInstanceTransform {
  x: number;
  y: number;
  z: number;
  yaw: number;
  variant: CarVariant;
  /** どの論理車両か(head車体メッシュは先頭・後尾の2箇所で使い回すため区別する)。 */
  role: 'head' | 'tail' | 'mid';
}

/**
 * 編成(head→mid→tail)の3インスタンスのワールド変換。yawDegは編成全体をY軸まわり
 * (原点=mid中心)に回す角度。previewController.updateInstances と同じ式。
 */
export function consistTransforms(yawDeg: number): CarInstanceTransform[] {
  const yaw = (yawDeg * Math.PI) / 180;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const rotate = (localZ: number): [number, number] => [localZ * sin, localZ * cos];
  const [hx, hz] = rotate(CAR_SPACING);
  const [tx, tz] = rotate(-CAR_SPACING);
  return [
    { x: hx, y: GROUND_SURFACE_Y, z: hz, yaw, variant: 'head', role: 'head' },
    { x: tx, y: GROUND_SURFACE_Y, z: tz, yaw: yaw + Math.PI, variant: 'head', role: 'tail' },
    { x: 0, y: GROUND_SURFACE_Y, z: 0, yaw, variant: 'mid', role: 'mid' },
  ];
}
