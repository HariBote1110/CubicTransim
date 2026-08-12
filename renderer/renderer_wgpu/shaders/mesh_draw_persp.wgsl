// D1: 透視投影(乗客視点スパイク)用のメッシュチャンク描画。
//
// mesh_draw.wgsl(クォータービュー・等角投影)とは別経路。頂点は真の view_proj 行列で
// クリップ空間へ写すだけ(投影の分岐は無い)。フラグメントでは地下ビュー減光の代わりに
// 距離フォグ(sky 色へ mix)を掛ける。地形もこのパイプラインで描く(TS 側が
// cellCornerHeights から作った通常のメッシュチャンクとして届く。地形専用のバッファ・
// パイプラインは持たない)。
//
// 微分命令(dpdx/dpdy)は使わない(WGSLブラウザ検証器は非一様分岐内の微分命令を
// Chromeで弾く。progress の既知の罠を踏まないため、そもそも使わない設計にした)。

struct CameraParams {
  view_proj: mat4x4<f32>,
  eye: vec3<f32>, fog_end: f32,
  sky: vec3<f32>, dim: f32,
};
struct ClassParams { layer_class: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

@group(0) @binding(0) var<uniform> camera: CameraParams;
@group(1) @binding(0) var<uniform> class_params: ClassParams;

struct Out {
  @builtin(position) position: vec4<f32>,
  @location(0) colour: vec4<f32>,
  @location(1) world_pos: vec3<f32>,
};

@vertex fn vs_main(
  @location(0) pos: vec3<f32>,
  @location(1) colour: vec4<f32>,
) -> Out {
  var o: Out;
  o.position = camera.view_proj * vec4<f32>(pos, 1.0);
  o.colour = colour;
  o.world_pos = pos;
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4<f32> {
  // 地表・半透明は dim 係数(通常は1.0)、地下クラスだけ常に等倍表示。
  let factor = select(camera.dim, 1.0, class_params.layer_class == 1u);
  let dist = length(in.world_pos - camera.eye);
  let fog_t = clamp(dist / max(camera.fog_end, 1.0), 0.0, 1.0);
  let shaded = in.colour.rgb * factor;
  let fogged = mix(shaded, camera.sky, fog_t);
  return vec4<f32>(fogged, in.colour.a);
}
