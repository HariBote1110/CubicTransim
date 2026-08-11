// R4a: ジオラマ物(樹木・町・レール網など)のメッシュチャンク描画。
//
// ジオメトリ生成は TS 側に残し(progress/r4-threejs-retirement-plan.md)、ここへは
// 「位置(f32x3)+頂点色(unorm8x4)+インデックス(u32)」の平坦な配列が届く。陰影は
// TS 側で面単位ランバートとして頂点色へ焼き込み済みなので、このシェーダは投影と
// 地下ビュー減光しかしない。
//
// 頂点の y は**ワールド単位**(段数ではない)。地形(terrain_draw.wgsl)の project() は
// y を段数で受け取るため、深度式を完全に一致させるためにここでワールド単位→段数へ
// 戻してから同じ式に入れる(そうしないと地形とジオラマ物の深度が食い違い、地表に
// 置いた木が地形に食われる)。

struct CameraParams {
  center_x: f32, center_z: f32, pixels_per_cell: f32, height_scale: f32,
  viewport_w: f32, viewport_h: f32, half_extent: f32, dim: f32,
};
// クラス(0=地表 / 1=地下 / 2=半透明)。パイプラインごとに固定の小さな uniform。
struct ClassParams { layer_class: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

@group(0) @binding(0) var<uniform> camera: CameraParams;
@group(1) @binding(0) var<uniform> class_params: ClassParams;

const ISO_X: f32 = 0.70710678; // 1/sqrt(2)
const ISO_Y: f32 = 0.40824829; // 1/sqrt(6)
const ISO_H: f32 = 0.81649658; // 2/sqrt(6)

// terrain_draw.wgsl の project() と同一(y は段数単位)。
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

// ワールド単位の高さを段数へ戻す。height_scale = ppc * ISO_H * height_per_level なので
// height_per_level = height_scale / (ppc * ISO_H)。
fn world_y_to_levels(y_world: f32) -> f32 {
  return y_world * camera.pixels_per_cell * ISO_H / max(camera.height_scale, 1e-6);
}

struct Out {
  @builtin(position) position: vec4<f32>,
  @location(0) colour: vec4<f32>,
};

@vertex fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) colour: vec4<f32>,
) -> Out {
  var o: Out;
  o.position = project(pos.x, pos.z, world_y_to_levels(pos.y));
  o.colour = colour;
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4<f32> {
  // 地表・半透明は地形と同じ dim 係数で減光する。地下クラスは「選択中の地下レベル」を
  // 通常輝度で見せるための層なので減光しない(CPU 側が dim==1.0 のとき丸ごと描画を
  // 省くため、ここへ来る時点で必ず地下ビュー中)。
  let factor = select(camera.dim, 1.0, class_params.layer_class == 1u);
  return vec4<f32>(in.colour.rgb * factor, in.colour.a);
}
