// D1: 透視投影(乗客視点スパイク)用のインスタンス描画(列車など)。
// mesh_instanced.wgsl と同じ回転規約(ヨー→ピッチ)だが、投影は真の view_proj 行列。

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
  @location(2) inst_pos: vec3<f32>,
  @location(3) inst_rot: vec2<f32>,   // (yaw, pitch)
  @location(4) inst_tint: vec3<f32>,
) -> Out {
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
  o.position = camera.view_proj * vec4<f32>(world, 1.0);
  let tinted = colour.rgb * mix(vec3<f32>(1.0), inst_tint, colour.a);
  o.colour = vec4<f32>(tinted, 1.0);
  o.world_pos = world;
  return o;
}

@fragment fn fs_main(in: Out) -> @location(0) vec4<f32> {
  let factor = select(camera.dim, 1.0, class_params.layer_class == 1u);
  let dist = length(in.world_pos - camera.eye);
  let fog_t = clamp(dist / max(camera.fog_end, 1.0), 0.0, 1.0);
  let shaded = in.colour.rgb * factor;
  let fogged = mix(shaded, camera.sky, fog_t);
  return vec4<f32>(fogged, in.colour.a);
}
