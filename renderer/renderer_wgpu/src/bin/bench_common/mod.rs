//! bin/ 配下のベンチ・チェック用バイナリで共有する小さなヘルパー。
//!
//! `wgpu::Backends` をハードコードすると、Mac(Metal)とCIのUbuntu VM(Vulkan/llvmpipe)の
//! どちらか一方でしか `request_adapter` が成功しない。`WGPU_BACKEND` 環境変数で明示指定できる
//! ようにしつつ、既定値は `Backends::PRIMARY`(Vulkan/Metal/DX12 のネイティブ主要backendすべて)
//! として、同一コミットのバイナリがMacでもVMでもそのまま動くようにする。

/// `WGPU_BACKEND` 環境変数からバックエンドを選ぶ。
/// - `vulkan` → `wgpu::Backends::VULKAN`
/// - `metal` → `wgpu::Backends::METAL`
/// - 未設定 / それ以外 → `wgpu::Backends::PRIMARY`
pub fn select_backends() -> wgpu::Backends {
    match std::env::var("WGPU_BACKEND") {
        Ok(v) if v.eq_ignore_ascii_case("vulkan") => wgpu::Backends::VULKAN,
        Ok(v) if v.eq_ignore_ascii_case("metal") => wgpu::Backends::METAL,
        _ => wgpu::Backends::PRIMARY,
    }
}
