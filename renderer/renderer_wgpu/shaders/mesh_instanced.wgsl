// R4a: インスタンス描画(R4c の列車で使う)。
//
// プロトタイプメッシュ(車両モデル)を1度登録し、毎フレーム
// 「原点+ヨー+ピッチ+路線色」のインスタンス配列だけを更新する。
//
// 頂点色のアルファは**色付け重み**として使う(メッシュチャンクの半透明クラスとは
// 意味が違うので注意):
//   a = 255 -> 頂点色 * tint(路線色で塗る面。車体の帯など)
//   a = 0   -> 頂点色そのまま(窓・台車など路線色に染まってほしくない面)
//   中間値は線形補間。
// この規約により「どの面を路線色にするか」を TS のジオメトリ生成側だけで決められる。

struct CameraParams {
  center_x: f32, center_z: f32, pixels_per_cell: f32, height_scale: f32,
  viewport_w: f32, viewport_h: f32, half_extent: f32, dim: f32,
};
struct ClassParams { layer_class: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

@group(0) @binding(0) var<uniform> camera: CameraParams;
@group(1) @binding(0) var<uniform> class_params: ClassParams;

const ISO_X: f32 = 0.70710678;
const ISO_Y: f32 = 0.40824829;
const ISO_H: f32 = 0.81649658;

fn project(wx: f32, wz: f32, y_levels: f32) -> vec4<f32> {
  let rx = wx - camera.center_x;
  let rz = wz - camera.center_z;
  let sx = (rx - rz) * camera.pixels_per_cell * ISO_X;
  let sy = (rx + rz) * camera.pixels_per_cell * ISO_Y - y_levels * camera.height_scale;
  let cx = sx / max(camera.viewport_w * 0.5, 1.0);
  let cy = -sy / max(camera.viewport_h * 0.5, 1.0);
  let inv_span = 1.0 / max(camera.half_extent * 4.0 + 64.0, 1.0);
  return vec4<f32>(cx, cy, clamp(0.5 - (wx + wz + y_levels) * inv_span, 0.0, 1.0), 1.0);
}

fn world_y_to_levels(y_world: f32) -> f32 {
  return y_world * camera.pixels_per_cell * ISO_H / max(camera.height_scale, 1e-6);
}

// R4f: 列車はインスタンスごとに yaw/pitch で回転するため、TS側(bakedMesh.ts)で
// 固定光源のランバート陰影を頂点色へ焼き込むと、回転しても陰影が付いてこない
// (坂やtail車両の反転ピッチで特に破綻する)。そこでインスタンスメッシュだけは
// TS側は基本色をそのまま渡し(unlit)、ここで回転後のワールド位置から
// screen-space微分で面法線を求め、bakedMesh.ts の lambertFactor と同じ式・同じ
// 太陽方向で毎フレーム陰影を計算する(地形/静的メッシュチャンクは従来どおり
// 焼き込み陰影のままで、このシェーダの変更対象ではない)。
const SUN_DIRECTION: vec3<f32> = vec3<f32>(-0.632021, 0.716357, 0.294980);
const AMBIENT_TERM: f32 = 0.2;
const HEMISPHERE_TERM: f32 = 0.28;
const SUN_TERM: f32 = 0.55;

struct Out {
  @builtin(position) position: vec4<f32>,
  @location(0) colour: vec4<f32>,
  @location(1) world_pos: vec3<f32>,
};

@vertex fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) colour: vec4<f32>,
  @location(2) inst_pos: vec3<f32>,
  @location(3) inst_rot: vec2<f32>,   // (yaw, pitch)
  @location(4) inst_tint: vec4<f32>,  // unorm8x4。A は flags なので使わない
) -> Out {
  // flags は tint の A バイトに同居しているが、クラス振り分け(meshes::split_instances_into)で
  // CPU 側が既に使い切っているため、シェーダでは読まない。
  // ピッチ(進行方向 +Z まわりの傾き)→ ヨー(+Y まわり)の順に回す。
  // three.js の rotateY(theta) がローカル +Z を (sin θ, 0, cos θ) へ写すのと同じ符号規約
  // (render/palette.ts の angleFromVector)。
  let cp = cos(inst_rot.y);
  let sp = sin(inst_rot.y);
  let pitched = vec3<f32>(pos.x, pos.y * cp - pos.z * sp, pos.y * sp + pos.z * cp);
  let cy_ = cos(inst_rot.x);
  let sy_ = sin(inst_rot.x);
  let rotated = vec3<f32>(
    pitched.x * cy_ + pitched.z * sy_,
    pitched.y,
    -pitched.x * sy_ + pitched.z * cy_,
  );
  let world = rotated + inst_pos;

  var o: Out;
  o.position = project(world.x, world.z, world_y_to_levels(world.y));
  let tinted = colour.rgb * mix(vec3<f32>(1.0), inst_tint.rgb, colour.a);
  o.colour = vec4<f32>(tinted, 1.0);
  o.world_pos = world;
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4<f32> {
  // 微分命令は非一様分岐の外(関数先頭)で無条件に呼ぶこと(WGSLの制約)。
  let dx = dpdx(in.world_pos);
  let dy = dpdy(in.world_pos);
  let normal = normalize(cross(dy, dx));
  let sun = max(0.0, dot(normal, SUN_DIRECTION));
  let hemi = 0.5 + 0.5 * normal.y;
  let lambert = min(1.0, AMBIENT_TERM + HEMISPHERE_TERM * hemi + SUN_TERM * sun);

  let factor = select(camera.dim, 1.0, class_params.layer_class == 1u);
  return vec4<f32>(in.colour.rgb * lambert * factor, in.colour.a);
}
