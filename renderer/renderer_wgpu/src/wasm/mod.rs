use quarterview_terrain_core::clipmap::{
    select_tiles_into, tile_cell_span, TileKey, ViewRequest, TILE_SAMPLES,
};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use wgpu::util::DeviceExt;

const GRID: u32 = TILE_SAMPLES as u32 + 1;
const TILE_BYTES: u64 = GRID as u64 * GRID as u64 * 4;
const MAX_RESIDENT_TILES: usize = 384;
const MAX_NEW_TILES_PER_FRAME: usize = 24;
const INDEX_COUNT_PER_TILE: u32 = (GRID - 1) * (GRID - 1) * 6;
const MAX_CLIFF_EDGES: usize = 2 * (GRID as usize - 1) * (GRID as usize - 2);
const MAX_WATER_CELLS: usize = (GRID as usize - 1) * (GRID as usize - 1);
use crate::{MAX_DRAW_VERTICES, RENDER_ARGS_TOTAL_BYTES, RENDER_COUNTS_BYTES};

pub use crate::edits::{build_tile_overrides, tile_world_bounds_for, OVERLAY_CHUNK_SIZE};
fn push_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn push_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_i32(out: &mut [u8], offset: usize, v: i32) {
    out[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
}
fn put_u32(out: &mut [u8], offset: usize, v: u32) {
    out[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
}
fn put_f32(out: &mut [u8], offset: usize, v: f32) {
    out[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
}

pub use crate::meshes::{
    interleave_vertices, split_instances_by_class, LayerClass, INSTANCE_STRIDE_BYTES,
    INSTANCE_STRIDE_FLOATS, VERTEX_STRIDE_BYTES,
};
pub use crate::projection::{aabb_visible, CullCamera, ISO_H, ISO_X, ISO_Y};
/// 拡大の上限(物理ピクセル/ワールド単位)。three.js 側の maxZoom(100)× DPR(<=2)を
/// 十分に上回る値にしておく。
const MAX_PIXELS_PER_CELL: f64 = 4096.0;

fn full_map_min_ppc(width: u32, height: u32, half_extent: i32) -> f64 {
    let half = (half_extent.max(1)) as f64;
    // screen_x = (x-z)*ppc*ISO_X -> full map width  = 4*half*ppc*ISO_X
    // screen_y = (x+z)*ppc*ISO_Y -> full map height = 4*half*ppc*ISO_Y
    (width as f64 / (4.0 * half * ISO_X))
        .min(height as f64 / (4.0 * half * ISO_Y))
        .max(0.000_01)
}

struct GpuTile {
    samples: wgpu::Buffer,
    _tile_params: wgpu::Buffer,
    _cliff_edges: wgpu::Buffer,
    _water_cells: wgpu::Buffer,
    render_args: wgpu::Buffer,
    _render_counts: wgpu::Buffer,
    _overrides: wgpu::Buffer,
    draw_bind_group: wgpu::BindGroup,
    last_used: u64,
    /// デバッグ用: build_tile_overrides が組み立てたフラット配列([local_index, height, ...])の
    /// そのままのコピー。ライブレンダラの実際の上書き適用状態を JS 側から検査するため保持する。
    debug_overrides: Vec<u32>,
}

fn create_depth(
    device: &wgpu::Device,
    width: u32,
    height: u32,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("quarterview-depth"),
        size: wgpu::Extent3d {
            width: width.max(1),
            height: height.max(1),
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

/// R4a: TS 側が組み立てたジオラマ物のメッシュ1バケット分(GPU常駐)。
struct MeshChunk {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    index_count: u32,
    class: LayerClass,
    /// ワールド AABB `[min_x,min_y,min_z,max_x,max_y,max_z]`(y はワールド単位)。
    aabb: [f32; 6],
}

/// R4a: インスタンス描画用に登録したプロトタイプメッシュと、その現在のインスタンス群。
struct InstancedMesh {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    index_count: u32,
    /// (バッファ, インスタンス数)。クラスごとに別ドローになるので2本持つ。
    surface: Option<(wgpu::Buffer, u32)>,
    underground: Option<(wgpu::Buffer, u32)>,
}

/// D1: レンダリングモード。既定は Quarter(クォータービュー、既存挙動と完全一致)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum CameraMode {
    #[default]
    Quarter,
    Perspective,
}

/// D1: 透視パスの描画半径(=フォグ終端)。この距離でカットオフを霧に隠す。
const PERSP_DRAW_RADIUS: f64 = 300.0;
const PERSP_NEAR: f64 = 0.1;

#[wasm_bindgen]
pub struct CanvasRenderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    _depth: wgpu::Texture,
    depth_view: wgpu::TextureView,

    tile_pipeline: wgpu::ComputePipeline,
    tile_bgl: wgpu::BindGroupLayout,
    draw_pipeline: wgpu::RenderPipeline,
    draw_bgl: wgpu::BindGroupLayout,
    _camera_bgl: wgpu::BindGroupLayout,
    camera_buffer: wgpu::Buffer,
    camera_bind_group: wgpu::BindGroup,
    finalize_pipeline: wgpu::ComputePipeline,
    finalize_bgl: wgpu::BindGroupLayout,
    clamp_pipeline: wgpu::ComputePipeline,
    clamp_bgl: wgpu::BindGroupLayout,
    clamp_params: wgpu::Buffer,

    /// R4a: ジオラマ物のメッシュ描画。クラス(0=地表/1=地下/2=半透明/3=地下ゴースト)
    /// ごとにパイプラインとクラス uniform のバインドグループを持つ。
    mesh_pipelines: [wgpu::RenderPipeline; 4],
    instanced_pipelines: [wgpu::RenderPipeline; 2],
    class_bind_groups: [wgpu::BindGroup; 4],
    mesh_camera_bind_group: wgpu::BindGroup,
    mesh_chunks: HashMap<u32, MeshChunk>,
    instanced_meshes: HashMap<u32, InstancedMesh>,

    /// D1: 透視投影(乗客視点スパイク)のパイプライン一式。クォータービュー用の
    /// 上記フィールドとは完全に別経路(mesh_pipeline::create_perspective_all)。
    persp_mesh_pipelines: [wgpu::RenderPipeline; 4],
    persp_instanced_pipelines: [wgpu::RenderPipeline; 2],
    persp_camera_buffer: wgpu::Buffer,
    persp_camera_bind_group: wgpu::BindGroup,
    /// 'quarter'(既定)か 'perspective' か。既定のクォータービューは本フィールドが
    /// Quarter のときバイト単位で従来どおりに描かれる(render() のガード参照)。
    mode: CameraMode,
    persp_eye: [f64; 3],
    persp_look: [f64; 3],
    persp_fov_y: f64,

    tiles: HashMap<TileKey, GpuTile>,
    visible: Vec<TileKey>,
    needed: Vec<TileKey>,
    frame_index: u64,
    camera_revision: u64,

    seed: u32,
    half_extent: i32,
    /// 地形プロファイル(平坦/標準/山がち)。TS側 createTerrainField と同じテーブルを使う。
    profile: quarterview_terrain_core::TerrainProfile,
    center_x: f64,
    center_z: f64,
    pixels_per_cell: f64,
    /// 段数1あたりのワールド高さ(本体の OVERPASS_HEIGHT)。set_camera で更新する。
    height_per_level: f64,
    /// 地下ビュー減光係数(1.0=通常、0.0=真っ黒)。setDim で更新する。
    dim: f64,

    /// terrainOverlay.ts の CornerDiffs をミラーする編集オーバーレイ(R2)。
    /// setCornerOverrideChunk が変更のあったチャンクだけを丸ごと置き換える。
    overrides: crate::edits::OverrideChunks,

    adapter_name: String,
    adapter_backend: String,
}

mod create;
mod camera;
mod mesh_api;
mod render;
mod debug;
mod tiles;

fn profile_from_js(profile: Option<String>) -> quarterview_terrain_core::TerrainProfile {
    profile
        .as_deref()
        .map(quarterview_terrain_core::TerrainProfile::from_name)
        .unwrap_or_default()
}

/// 検証用: プロファイルの標高しきい値を (hi, lo) × 10 の 20 語で返す。
/// browser-compute.mjs が params uniform を自前で組むために使う(値の出所はRust1つに保つ)。
#[wasm_bindgen(js_name = profileThresholdWords)]
pub fn profile_threshold_words(profile: Option<String>) -> Vec<u32> {
    profile_from_js(profile).threshold_words().to_vec()
}

#[wasm_bindgen]
pub fn cpu_corner_height(
    seed: u32,
    half_extent: i32,
    x: i32,
    z: i32,
    profile: Option<String>,
) -> u8 {
    quarterview_terrain_core::TerrainField::with_profile(
        seed,
        half_extent,
        profile_from_js(profile),
    )
    .corner_height_at(x, z)
}

#[wasm_bindgen(js_name = cpuTilePacked)]
pub fn cpu_tile_packed(
    seed: u32,
    half_extent: i32,
    origin_x: i32,
    origin_z: i32,
    stride: i32,
    profile: Option<String>,
) -> Vec<u32> {
    let field = quarterview_terrain_core::TerrainField::with_profile(
        seed,
        half_extent,
        profile_from_js(profile),
    );
    let mut out = Vec::with_capacity((GRID * GRID) as usize);
    for lx in 0..GRID as i32 {
        for lz in 0..GRID as i32 {
            let x = origin_x + lx * stride;
            let z = origin_z + lz * stride;
            let h = field.corner_height_at(x, z) as u32;
            let water = u32::from(field.is_water_vertex(x, z));
            out.push(h | (water << 8));
        }
    }
    out
}

#[wasm_bindgen(js_name = tileGenerateWgsl)]
pub fn tile_generate_wgsl() -> String {
    crate::TILE_GENERATE_WGSL.to_owned()
}
