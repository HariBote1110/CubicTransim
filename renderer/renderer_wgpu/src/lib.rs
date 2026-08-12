//! Quarter-view WebGPU renderer prototype.
//!
//! The browser and headless paths share the same WGSL terrain generator.  The wasm
//! renderer keeps only visible/prefetched height tiles resident, generates missing
//! tiles with compute, then vertex-pulls the packed height/water buffer directly.

pub const TERRAIN_NOISE_WGSL: &str = include_str!("../shaders/terrain_noise.wgsl");
/// R4a: ジオラマ物(木・町・レール等)のメッシュチャンク描画シェーダ。
pub const MESH_DRAW_WGSL: &str = include_str!("../shaders/mesh_draw.wgsl");
/// R4a: 列車などのインスタンス描画シェーダ(R4cで使う)。
pub const MESH_INSTANCED_WGSL: &str = include_str!("../shaders/mesh_instanced.wgsl");
/// D1: 透視投影(乗客視点スパイク)用のメッシュチャンク描画シェーダ。クォータービューの
/// MESH_DRAW_WGSL とは別経路(等角投影の閉形式ではなく、真の view_proj 行列を使う)。
pub const MESH_DRAW_PERSP_WGSL: &str = include_str!("../shaders/mesh_draw_persp.wgsl");
/// D1: 透視投影用のインスタンス描画シェーダ。
pub const MESH_INSTANCED_PERSP_WGSL: &str = include_str!("../shaders/mesh_instanced_persp.wgsl");
pub const TILE_GENERATE_WGSL: &str = include_str!("../shaders/tile_generate.wgsl");
pub const TERRAIN_DRAW_WGSL: &str = include_str!("../shaders/terrain_draw.wgsl");
pub const TILE_FINALIZE_WGSL: &str = include_str!("../shaders/tile_finalize.wgsl");
pub const TILE_CLAMP_ARGS_WGSL: &str = include_str!("../shaders/tile_clamp_args.wgsl");

/// Hard upper bound on the vertex count of any single indirect terrain draw.
///
/// One tile can legitimately emit at most
/// `256*256*6 (surface) + 6*130560 (cliffs) + 6*65536 (water) = 1,569,792` vertices,
/// so 2,000,000 leaves headroom while still catching an argument-encoding fault long
/// before it can hang the GPU. Enforced on the GPU by `tile_clamp_args.wgsl` (release
/// clamp + diagnostics record) and asserted on the CPU by the bench harness.
pub const MAX_DRAW_VERTICES: u32 = 2_000_000;

/// Size of the indirect-args buffer: the 16-byte draw quad, then the 16-byte per-class
/// count block the vertex shader reads, then a 16-byte diagnostics region holding the
/// pre-clamp request. See `tile_finalize.wgsl` / `tile_clamp_args.wgsl`.
pub const RENDER_ARGS_TOTAL_BYTES: u64 = 48;
/// Bytes copied into the vertex shader's read-only snapshot: the draw quad plus counts.
pub const RENDER_COUNTS_BYTES: u64 = 32;

/// R4a: 真等角投影の閉形式(shaders/*.wgsl と同じ式)と、それを使った画面空間の
/// バウンディングボックス判定。ターゲット非依存(ネイティブの `cargo test` で検証できる)。
pub mod projection;

/// D1: 透視投影カメラ(乗客視点スパイク)の行列計算とフラスタムカリング。
///
/// クォータービュー(等角投影・projection モジュール)とは完全に別経路。真の
/// view-projection 行列(右手系、深度レンジ [0,1]、reversed-Z は使わない — wgpu の
/// LessEqual 比較・Clear(1.0) をそのまま流用できるいちばん単純な選択)を組む。
/// ネイティブの `cargo test` で検証できるよう target非依存にしてある。
pub mod perspective;

/// R4a: メッシュチャンク / インスタンス描画のCPU側データ整形。
///
/// wasm 側(CanvasRenderer)からもネイティブのテストからも使える target 非依存モジュール。
pub mod meshes;

/// R4a: メッシュチャンク / インスタンス描画のパイプライン構築。
///
/// wasm の `CanvasRenderer` と、ネイティブの検証バイナリ(`mesh_shader_check`)の
/// 両方から使う target 非依存モジュール。WGSL とバッファレイアウトの整合はここ1箇所で
/// 決まるので、ブラウザを立ち上げずに `cargo run --bin mesh_shader_check` で検証できる。
pub mod mesh_pipeline;

/// 地形編集オーバーレイ(terrainOverlay.ts の CornerDiffs)を GPU タイル生成へ橋渡しする
/// 共有ロジック。wasm 側(CanvasRenderer)とネイティブの回帰ゲート(edit_check)の両方から
/// 使う target 非依存モジュール(R2実装メモ参照: progress/renderer-integration-plan.md)。
pub mod edits;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
