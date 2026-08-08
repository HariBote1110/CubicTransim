// R4c: 列車インスタンス描画(wgpu)向けの純粋な座標変換ヘルパー。
//
// carGroupPosition は元々 components/DynamicTrain.tsx に private でだけあった関数を
// そのまま抽出した(classic/WebGPU 両方の描画パスが同じ計算を使うことで、
// 「レールと列車がずれない」設計を崩さないため)。headingToYawPitch は wgpu の
// インスタンスシェーダ(renderer/renderer_wgpu/shaders/mesh_instanced.wgsl)が
// 適用する「ピッチ(+Xまわり)→ヨー(+Yまわり)」の順の回転から逆算した式で、
// three.js の Object3D.lookAt(target) と同じ向きになるよう符号を合わせてある。

/** 台車の車輪面から車両groupの原点までの高さ。DynamicTrain.tsx と共有する一次値。 */
export const RAIL_SUPPORT_OFFSET = 0.37;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 線路中心線上の点(pos)と進行方向(heading、正規化済み)から、車両groupの原点位置を求める。
 * world上方向を車両の進行方向に直交する平面へ射影したものが、車体のローカル+Yになる
 * (坂で車体を傾けたときに車輪が線路から浮かないようにする補正)。
 */
export const carGroupPosition = (pos: Vec3, heading: Vec3): Vec3 => {
  const upY = Math.sqrt(Math.max(0, 1 - heading.y * heading.y));
  return {
    x: pos.x - heading.x * heading.y * RAIL_SUPPORT_OFFSET,
    y: pos.y + (upY - 1) * RAIL_SUPPORT_OFFSET,
    z: pos.z - heading.z * heading.y * RAIL_SUPPORT_OFFSET,
  };
};

export interface YawPitch {
  yaw: number;
  pitch: number;
}

/**
 * 正規化済みheadingから、wgpuインスタンスシェーダが適用する順(ピッチ→ヨー)で
 * 元のheadingを再現するyaw/pitchを求める。
 *
 * mesh_instanced.wgsl の頂点変換を逆算すると、ローカル+Z(モデルの前方)は
 * 最終的に world 方向 (cos(pitch)*sin(yaw), -sin(pitch), cos(pitch)*cos(yaw)) へ写る。
 * heading と一致させるには:
 *   yaw   = atan2(heading.x, heading.z)
 *   pitch = atan2(-heading.y, hypot(heading.x, heading.z))
 */
export const headingToYawPitch = (heading: Vec3): YawPitch => {
  const horiz = Math.hypot(heading.x, heading.z);
  return {
    yaw: Math.atan2(heading.x, heading.z),
    pitch: Math.atan2(-heading.y, horiz),
  };
};
