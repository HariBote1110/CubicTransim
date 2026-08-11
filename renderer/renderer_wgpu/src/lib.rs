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
pub mod projection {
    /// 画面座標係数(shaders/terrain_draw.wgsl の ISO_X / ISO_Y / ISO_H と同一)。
    /// three.js 側の OrthographicCamera(position=(20,20,20), up=+Y)から導いた値。
    pub const ISO_X: f64 = std::f64::consts::FRAC_1_SQRT_2; // 1/sqrt(2)
    pub const ISO_Y: f64 = 0.408_248_290_463_863; // 1/sqrt(6)
    /// 高さ項の係数(2/sqrt(6))。メッシュの y は**ワールド単位**(段数ではない)なので、
    /// 画面へのオフセットは `y_world * pixels_per_cell * ISO_H` になる。
    pub const ISO_H: f64 = 0.816_496_580_927_726;

    /// カリング判定に必要なカメラ状態(render() が毎フレーム作る)。
    #[derive(Clone, Copy, Debug)]
    pub struct CullCamera {
        pub centre_x: f64,
        pub centre_z: f64,
        pub pixels_per_cell: f64,
        pub viewport_w: f64,
        pub viewport_h: f64,
    }

    /// 画面中心を原点とした矩形(ピクセル、+y は画面下向き)。
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct ScreenRect {
        pub min_x: f64,
        pub max_x: f64,
        pub min_y: f64,
        pub max_y: f64,
    }

    /// ワールド AABB `[min_x,min_y,min_z,max_x,max_y,max_z]`(y はワールド単位)を
    /// 等角投影して画面空間の外接矩形を求める。
    ///
    /// 投影は各軸について単調なので、8頂点を回さずに端点の組み合わせだけで厳密な
    /// 外接矩形が出る:
    ///   sx = (rx-rz)*ppc*ISO_X       -> rx 最大・rz 最小で最大
    ///   sy = (rx+rz)*ppc*ISO_Y - y*ppc*ISO_H -> rx,rz 最大・y 最小で最大
    pub fn aabb_screen_rect(aabb: &[f32; 6], cam: CullCamera) -> ScreenRect {
        let x0 = aabb[0] as f64 - cam.centre_x;
        let y0 = aabb[1] as f64;
        let z0 = aabb[2] as f64 - cam.centre_z;
        let x1 = aabb[3] as f64 - cam.centre_x;
        let y1 = aabb[4] as f64;
        let z1 = aabb[5] as f64 - cam.centre_z;
        let ppc = cam.pixels_per_cell;
        ScreenRect {
            min_x: (x0 - z1) * ppc * ISO_X,
            max_x: (x1 - z0) * ppc * ISO_X,
            min_y: (x0 + z0) * ppc * ISO_Y - y1 * ppc * ISO_H,
            max_y: (x1 + z1) * ppc * ISO_Y - y0 * ppc * ISO_H,
        }
    }

    /// AABB がビューポートに掛かるか(接触も可視扱い)。
    pub fn aabb_visible(aabb: &[f32; 6], cam: CullCamera) -> bool {
        let rect = aabb_screen_rect(aabb, cam);
        let half_w = cam.viewport_w * 0.5;
        let half_h = cam.viewport_h * 0.5;
        rect.max_x >= -half_w
            && rect.min_x <= half_w
            && rect.max_y >= -half_h
            && rect.min_y <= half_h
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn cam() -> CullCamera {
            CullCamera {
                centre_x: 0.0,
                centre_z: 0.0,
                pixels_per_cell: 10.0,
                viewport_w: 100.0,
                viewport_h: 100.0,
            }
        }

        #[test]
        fn origin_cell_projects_to_screen_centre() {
            let rect = aabb_screen_rect(&[0.0; 6], cam());
            assert!(rect.min_x.abs() < 1e-9 && rect.max_x.abs() < 1e-9);
            assert!(rect.min_y.abs() < 1e-9 && rect.max_y.abs() < 1e-9);
        }

        #[test]
        fn height_pushes_the_box_upwards_on_screen() {
            // y は画面下向きなので、高い(y_max が大きい)ほど min_y は小さくなる。
            let flat = aabb_screen_rect(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0], cam());
            let tall = aabb_screen_rect(&[0.0, 0.0, 0.0, 0.0, 2.0, 0.0], cam());
            assert!(tall.min_y < flat.min_y);
            assert!((tall.min_y - (-2.0 * 10.0 * ISO_H)).abs() < 1e-9);
            assert!((tall.max_y - flat.max_y).abs() < 1e-9);
        }

        #[test]
        fn centred_box_is_visible_and_distant_box_is_not() {
            assert!(aabb_visible(&[-1.0, 0.0, -1.0, 1.0, 1.0, 1.0], cam()));
            // +x/+z へ大きく離すと画面下方向(sy)へ抜ける。
            assert!(!aabb_visible(
                &[100.0, 0.0, 100.0, 101.0, 1.0, 101.0],
                cam()
            ));
            // +x/-z へ離すと画面右方向(sx)へ抜ける。
            assert!(!aabb_visible(
                &[100.0, 0.0, -101.0, 101.0, 1.0, -100.0],
                cam()
            ));
        }

        #[test]
        fn camera_centre_follows_the_box() {
            let far = [100.0f32, 0.0, 100.0, 101.0, 1.0, 101.0];
            let mut c = cam();
            assert!(!aabb_visible(&far, c));
            c.centre_x = 100.5;
            c.centre_z = 100.5;
            assert!(aabb_visible(&far, c));
        }
    }
}

/// R4a: メッシュチャンク / インスタンス描画のCPU側データ整形。
///
/// wasm 側(CanvasRenderer)からもネイティブのテストからも使える target 非依存モジュール。
pub mod meshes {
    /// 頂点1つのバイト数: position(f32x3) + colour(unorm8x4)。
    pub const VERTEX_STRIDE_BYTES: usize = 16;

    /// インスタンス1つあたりの f32 個数。
    ///
    /// レイアウト(TS 側 `setInstances` が渡すフラット配列と同じ並び):
    ///   0: x, 1: y, 2: z            — ワールド位置(y はワールド単位)
    ///   3: yaw   — +Y 軸まわり(three.js の rotateY と同符号、`angleFromVector` 準拠)
    ///   4: pitch — 進行方向まわりの傾き(勾配の可視化に使う)
    ///   5..7: tintR, tintG, tintB   — 頂点色へ掛ける色(路線色など、0..1)
    ///   8: flags — bit0=1 で地下クラス(深度Always・地下ビュー以外では非表示)
    ///   9: 予約(16バイト境界に揃えるためのパディング。常に 0 を書く)
    pub const INSTANCE_STRIDE_FLOATS: usize = 10;
    pub const INSTANCE_STRIDE_BYTES: usize = INSTANCE_STRIDE_FLOATS * 4;

    /// インスタンスフラグ: 地下クラスとして描く。
    pub const INSTANCE_FLAG_UNDERGROUND: u32 = 1;

    /// メッシュチャンクの描画クラス。
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum LayerClass {
        /// 地表の不透明物。地形と同じ dim 係数で減光される。
        Surface,
        /// 地下の構造物。地表より後に深度比較 Always で描く(地下ビュー以外では非表示)。
        Underground,
        /// 半透明オーバーレイ。深度書き込み無しで最後に描く(αは頂点色のA)。
        Translucent,
        /// 地上ビューで地下を透かして見せるゴースト。Underground と同じく深度比較
        /// Always で地形の上に出るが、αブレンドで薄く重なる(退役した three.js の
        /// DIMMED_MATERIALS: opacity 0.3 + depthTest:false と同じ狙い)。
        UndergroundGhost,
    }

    impl LayerClass {
        /// JS から渡る数値(0/1/2/3)を解釈する。未知の値は Surface に丸める。
        pub fn from_u32(v: u32) -> Self {
            match v {
                1 => LayerClass::Underground,
                2 => LayerClass::Translucent,
                3 => LayerClass::UndergroundGhost,
                _ => LayerClass::Surface,
            }
        }

        pub fn as_u32(self) -> u32 {
            match self {
                LayerClass::Surface => 0,
                LayerClass::Underground => 1,
                LayerClass::Translucent => 2,
                LayerClass::UndergroundGhost => 3,
            }
        }
    }

    /// position(f32x3 のフラット配列)と colour(頂点ごとの RGBA8 パック値)を
    /// GPU 頂点バッファのバイト列(stride 16)へ交互配置する。
    ///
    /// 長さが食い違う場合は短いほうに合わせる(JS からの呼び出しを落とさないための防御)。
    pub fn interleave_vertices(positions: &[f32], colours: &[u32]) -> Vec<u8> {
        let count = (positions.len() / 3).min(colours.len());
        let mut out = Vec::with_capacity(count * VERTEX_STRIDE_BYTES);
        for i in 0..count {
            out.extend_from_slice(&positions[i * 3].to_le_bytes());
            out.extend_from_slice(&positions[i * 3 + 1].to_le_bytes());
            out.extend_from_slice(&positions[i * 3 + 2].to_le_bytes());
            out.extend_from_slice(&colours[i].to_le_bytes());
        }
        out
    }

    /// インスタンス配列を「地表」「地下」の2本へ振り分ける(flags の bit0 で判定)。
    ///
    /// パイプライン状態(深度比較)はドロー単位でしか変えられないため、クラスの
    /// 振り分けは CPU 側で行い、それぞれを別のインスタンスバッファ+別ドローにする。
    /// 端数(stride に満たない末尾)は無視する。
    pub fn split_instances_by_class(data: &[f32]) -> (Vec<u8>, Vec<u8>) {
        let count = data.len() / INSTANCE_STRIDE_FLOATS;
        let mut surface = Vec::new();
        let mut underground = Vec::new();
        for i in 0..count {
            let chunk = &data[i * INSTANCE_STRIDE_FLOATS..(i + 1) * INSTANCE_STRIDE_FLOATS];
            let flags = chunk[8] as u32;
            let target = if flags & INSTANCE_FLAG_UNDERGROUND != 0 {
                &mut underground
            } else {
                &mut surface
            };
            for v in chunk {
                target.extend_from_slice(&v.to_le_bytes());
            }
        }
        (surface, underground)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn interleaves_position_and_colour_into_16_byte_vertices() {
            let bytes =
                interleave_vertices(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[0xff00_00ff, 0x00ff_00ff]);
            assert_eq!(bytes.len(), 2 * VERTEX_STRIDE_BYTES);
            assert_eq!(&bytes[0..4], &1.0f32.to_le_bytes());
            assert_eq!(&bytes[12..16], &0xff00_00ffu32.to_le_bytes());
            assert_eq!(&bytes[16..20], &4.0f32.to_le_bytes());
        }

        #[test]
        fn interleave_clamps_to_the_shorter_input() {
            let bytes = interleave_vertices(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[0xffff_ffff]);
            assert_eq!(bytes.len(), VERTEX_STRIDE_BYTES);
        }

        #[test]
        fn splits_instances_by_the_underground_flag() {
            let mut data = vec![0.0f32; INSTANCE_STRIDE_FLOATS * 3];
            data[0] = 1.0; // instance 0: surface
            data[INSTANCE_STRIDE_FLOATS] = 2.0; // instance 1: underground
            data[INSTANCE_STRIDE_FLOATS + 8] = INSTANCE_FLAG_UNDERGROUND as f32;
            data[INSTANCE_STRIDE_FLOATS * 2] = 3.0; // instance 2: surface
            let (surface, underground) = split_instances_by_class(&data);
            assert_eq!(surface.len(), 2 * INSTANCE_STRIDE_BYTES);
            assert_eq!(underground.len(), INSTANCE_STRIDE_BYTES);
            assert_eq!(&surface[0..4], &1.0f32.to_le_bytes());
            assert_eq!(
                &surface[INSTANCE_STRIDE_BYTES..INSTANCE_STRIDE_BYTES + 4],
                &3.0f32.to_le_bytes()
            );
            assert_eq!(&underground[0..4], &2.0f32.to_le_bytes());
        }

        #[test]
        fn split_ignores_a_trailing_partial_instance() {
            let data = vec![0.0f32; INSTANCE_STRIDE_FLOATS + 3];
            let (surface, underground) = split_instances_by_class(&data);
            assert_eq!(surface.len(), INSTANCE_STRIDE_BYTES);
            assert!(underground.is_empty());
        }

        #[test]
        fn layer_class_round_trips_and_clamps_unknown_values() {
            for c in [
                LayerClass::Surface,
                LayerClass::Underground,
                LayerClass::Translucent,
                LayerClass::UndergroundGhost,
            ] {
                assert_eq!(LayerClass::from_u32(c.as_u32()), c);
            }
            assert_eq!(LayerClass::from_u32(99), LayerClass::Surface);
        }

        #[test]
        fn underground_ghost_is_translucent_and_ignores_depth() {
            // 地上ビューで地下を薄いゴーストとして地形の上に重ねるためのクラス。
            // αブレンド(半透明)+深度比較 Always(地形に隠されない)+深度書き込み無し。
            let state = super::super::mesh_pipeline::depth_blend_state_for(
                LayerClass::UndergroundGhost,
            );
            assert!(!state.depth_write);
            assert_eq!(state.depth_compare, wgpu::CompareFunction::Always);
            assert!(state.blend.is_some());
        }

        #[test]
        fn underground_class_stays_opaque_over_terrain() {
            let state =
                super::super::mesh_pipeline::depth_blend_state_for(LayerClass::Underground);
            assert!(!state.depth_write);
            assert_eq!(state.depth_compare, wgpu::CompareFunction::Always);
            assert!(state.blend.is_none());
        }
    }
}

/// R4a: メッシュチャンク / インスタンス描画のパイプライン構築。
///
/// wasm の `CanvasRenderer` と、ネイティブの検証バイナリ(`mesh_shader_check`)の
/// 両方から使う target 非依存モジュール。WGSL とバッファレイアウトの整合はここ1箇所で
/// 決まるので、ブラウザを立ち上げずに `cargo run --bin mesh_shader_check` で検証できる。
pub mod mesh_pipeline {
    use super::meshes::{LayerClass, INSTANCE_STRIDE_BYTES, VERTEX_STRIDE_BYTES};

    /// メッシュ頂点バッファのレイアウト(位置 f32x3 + 頂点色 unorm8x4、stride 16)。
    const MESH_VERTEX_ATTRS: [wgpu::VertexAttribute; 2] = wgpu::vertex_attr_array![
        0 => Float32x3,
        1 => Unorm8x4,
    ];
    /// インスタンスバッファのレイアウト(meshes::INSTANCE_STRIDE_FLOATS のコメント参照)。
    /// flags(offset 32)と予約(offset 36)はシェーダから読まないので属性を張らない。
    const MESH_INSTANCE_ATTRS: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![
        2 => Float32x3,
        3 => Float32x2,
        4 => Float32x3,
    ];

    pub fn mesh_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: VERTEX_STRIDE_BYTES as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &MESH_VERTEX_ATTRS,
        }
    }

    pub fn mesh_instance_layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: INSTANCE_STRIDE_BYTES as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &MESH_INSTANCE_ATTRS,
        }
    }

    /// カメラ uniform のバインドグループレイアウト(group 0)。地形のものと違い、
    /// フラグメントでも dim を読むため VERTEX|FRAGMENT にする。
    pub fn camera_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mesh-camera-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        })
    }

    /// クラス uniform(0=地表/1=地下/2=半透明)のバインドグループレイアウト(group 1)。
    pub fn class_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("mesh-class-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        })
    }

    /// クラスごとの深度・ブレンド状態。パイプライン生成から切り離してテストできるようにする。
    pub struct DepthBlendState {
        pub depth_write: bool,
        pub depth_compare: wgpu::CompareFunction,
        pub blend: Option<wgpu::BlendState>,
    }

    pub fn depth_blend_state_for(class: LayerClass) -> DepthBlendState {
        let (depth_write, depth_compare, blend) = match class {
            LayerClass::Surface => (true, wgpu::CompareFunction::LessEqual, None),
            LayerClass::Underground => (false, wgpu::CompareFunction::Always, None),
            LayerClass::Translucent => (
                false,
                wgpu::CompareFunction::LessEqual,
                Some(wgpu::BlendState::ALPHA_BLENDING),
            ),
            // 地上ビューのゴースト: 地形に隠されず(Always)、薄く重なる(αブレンド)。
            LayerClass::UndergroundGhost => (
                false,
                wgpu::CompareFunction::Always,
                Some(wgpu::BlendState::ALPHA_BLENDING),
            ),
        };
        DepthBlendState {
            depth_write,
            depth_compare,
            blend,
        }
    }

    /// クラス別の深度・ブレンド状態でメッシュ描画パイプラインを作る。
    ///
    /// - Surface: 地形と同じ深度テスト(LessEqual)+深度書き込み。dim で減光。
    /// - Underground: 地表の後に深度比較 Always で上描き(地下ビューでのみ描く)。
    /// - Translucent: αブレンド・深度書き込み無しで最後に描く。
    pub fn create_mesh_pipeline(
        device: &wgpu::Device,
        shader: &wgpu::ShaderModule,
        layout: &wgpu::PipelineLayout,
        format: wgpu::TextureFormat,
        class: LayerClass,
        buffers: &[wgpu::VertexBufferLayout<'_>],
        label: &str,
    ) -> wgpu::RenderPipeline {
        let DepthBlendState {
            depth_write,
            depth_compare,
            blend,
        } = depth_blend_state_for(class);
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_main"),
                buffers,
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: depth_write,
                depth_compare,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview: None,
            cache: None,
        })
    }

    /// メッシュチャンク3クラス+インスタンス2クラスのパイプライン一式を作る。
    pub struct MeshPipelines {
        pub camera_bgl: wgpu::BindGroupLayout,
        pub class_bgl: wgpu::BindGroupLayout,
        /// index は `LayerClass::as_u32()`(0=地表/1=地下/2=半透明/3=地下ゴースト)。
        pub chunk: [wgpu::RenderPipeline; 4],
        /// index 0=地表 / 1=地下(半透明インスタンスは用途が無いので作らない)。
        pub instanced: [wgpu::RenderPipeline; 2],
    }

    pub fn create_all(device: &wgpu::Device, format: wgpu::TextureFormat) -> MeshPipelines {
        let camera_bgl = camera_bind_group_layout(device);
        let class_bgl = class_bind_group_layout(device);
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("mesh-layout"),
            bind_group_layouts: &[&camera_bgl, &class_bgl],
            push_constant_ranges: &[],
        });
        let mesh_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mesh-draw"),
            source: wgpu::ShaderSource::Wgsl(super::MESH_DRAW_WGSL.into()),
        });
        let instanced_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mesh-instanced"),
            source: wgpu::ShaderSource::Wgsl(super::MESH_INSTANCED_WGSL.into()),
        });
        let chunk = [
            LayerClass::Surface,
            LayerClass::Underground,
            LayerClass::Translucent,
            LayerClass::UndergroundGhost,
        ]
        .map(|class| {
            create_mesh_pipeline(
                device,
                &mesh_shader,
                &layout,
                format,
                class,
                &[mesh_vertex_layout()],
                "mesh-draw-pipeline",
            )
        });
        let instanced = [LayerClass::Surface, LayerClass::Underground].map(|class| {
            create_mesh_pipeline(
                device,
                &instanced_shader,
                &layout,
                format,
                class,
                &[mesh_vertex_layout(), mesh_instance_layout()],
                "mesh-instanced-pipeline",
            )
        });
        MeshPipelines {
            camera_bgl,
            class_bgl,
            chunk,
            instanced,
        }
    }
}

/// 地形編集オーバーレイ(terrainOverlay.ts の CornerDiffs)を GPU タイル生成へ橋渡しする
/// 共有ロジック。wasm 側(CanvasRenderer)とネイティブの回帰ゲート(edit_check)の両方から
/// 使う target 非依存モジュール(R2実装メモ参照: progress/renderer-integration-plan.md)。
pub mod edits {
    use std::collections::HashMap;

    /// terrainOverlay.ts の OVERLAY_CHUNK_SIZE と同じ値(コーナー座標のチャンク分割単位)。
    pub const OVERLAY_CHUNK_SIZE: i32 = 64;

    /// 1タイルへ転送するオーバーライドの上限(local_index 昇順ソート後、先頭からこの件数まで
    /// 採用する)。現実的な1回の盛土/切土(矩形+段差1以下伝播)は数百コーナー程度なので、
    /// この上限は十分に余裕がある(シェーダ側の二分探索コストは log2(N) なので上限を
    /// 大きく取ってもコストはほぼ変わらない)。
    pub const MAX_TILE_OVERRIDES: usize = 16_384;

    /// コーナー編集の全体ストア。`chunkKey=(cx,cz) -> (localIndex -> height)`。
    /// terrainOverlay.ts の `CornerDiffs`(`Map<string, Map<number, number>>`)と同じ
    /// 2段構成をミラーする。localIndex の並び順(`lx*OVERLAY_CHUNK_SIZE+lz`)も一致させる。
    pub type OverrideChunks = HashMap<(i32, i32), HashMap<u32, u8>>;

    const fn div_floor(v: i32, d: i32) -> i32 {
        v.div_euclid(d)
    }

    /// タイル(origin_x,origin_z,stride,grid)がワールド上で覆いうるコーナー範囲
    /// (LOD>0のスナップ許容分 ±stride/2 を含む)。invalidate 判定・overrides 収集の
    /// 両方で使う共通のバウンディングボックス。
    pub fn tile_world_bounds_for(
        origin_x: i32,
        origin_z: i32,
        stride: i32,
        grid: i32,
    ) -> (i32, i32, i32, i32) {
        let half = stride / 2;
        let span = stride * (grid - 1);
        (
            origin_x - half,
            origin_x + span + half,
            origin_z - half,
            origin_z + span + half,
        )
    }

    /// あるタイルに適用すべきオーバーライドを、シェーダの二分探索に載せられる形
    /// (local_index 昇順にソートしたフラット配列
    /// `[local_index0, height0, local_index1, height1, ...]`、`local_index = lx*grid+lz`
    /// で tile_generate.wgsl のスレッド添字 `i` と一致する)へ変換する。
    ///
    /// **LOD一貫性規則**: `stride=1`(LOD0)では厳密一致のみを採用する
    /// (`createEditedTerrainField` の `Math.round` + 完全一致と同じ挙動、これが唯一の
    /// 「正しさ」契約)。`stride>1`(粗いLOD)では、編集されたコーナーをそのタイルが実際に
    /// サンプルする最も近い格子点(世界座標で ±stride/2 以内)へスナップして適用する。
    /// これにより遠景ズームでも編集地形が消えずに見える(スナップ位置は最大 stride/2 セル
    /// ずれうるが、これは表示上の近似であり正しさの契約はLOD0にのみ課す)。
    /// 複数の編集コーナーが同じ粗いサンプル点へスナップする場合は、距離が最も近いものを
    /// 採用し、同距離なら x→z の昇順で決定的にタイブレークする(HashMap の走査順に依存しない
    /// 決定性を保証する。A8: 同一シード・同一カメラ経路での出力バイト一致に必要)。
    pub fn build_tile_overrides(
        overrides: &OverrideChunks,
        origin_x: i32,
        origin_z: i32,
        stride: i32,
        grid: i32,
    ) -> Vec<u32> {
        if overrides.is_empty() {
            return Vec::new();
        }
        let (x_lo, x_hi, z_lo, z_hi) = tile_world_bounds_for(origin_x, origin_z, stride, grid);
        let cx0 = div_floor(x_lo, OVERLAY_CHUNK_SIZE);
        let cx1 = div_floor(x_hi, OVERLAY_CHUNK_SIZE);
        let cz0 = div_floor(z_lo, OVERLAY_CHUNK_SIZE);
        let cz1 = div_floor(z_hi, OVERLAY_CHUNK_SIZE);

        // (local_index, dist_sq, x, z, height) の候補を集め、距離→座標の順で決定的に
        // ソートしてからタイブレークする。
        let mut candidates: Vec<(u32, i64, i32, i32, u8)> = Vec::new();
        let span = stride * (grid - 1);
        let half = stride / 2;
        for cx in cx0..=cx1 {
            for cz in cz0..=cz1 {
                let Some(chunk) = overrides.get(&(cx, cz)) else {
                    continue;
                };
                for (&local_index, &height) in chunk {
                    let lx_local = (local_index / OVERLAY_CHUNK_SIZE as u32) as i32;
                    let lz_local = (local_index % OVERLAY_CHUNK_SIZE as u32) as i32;
                    let x = cx * OVERLAY_CHUNK_SIZE + lx_local;
                    let z = cz * OVERLAY_CHUNK_SIZE + lz_local;
                    let rel_x = x - origin_x;
                    let rel_z = z - origin_z;
                    if rel_x < -half || rel_x > span + half {
                        continue;
                    }
                    if rel_z < -half || rel_z > span + half {
                        continue;
                    }
                    let snapped_lx = ((rel_x as f64) / (stride as f64)).round() as i32;
                    let snapped_lz = ((rel_z as f64) / (stride as f64)).round() as i32;
                    if snapped_lx < 0 || snapped_lx >= grid || snapped_lz < 0 || snapped_lz >= grid
                    {
                        continue;
                    }
                    let sample_x = origin_x + snapped_lx * stride;
                    let sample_z = origin_z + snapped_lz * stride;
                    let dx = (x - sample_x) as i64;
                    let dz = (z - sample_z) as i64;
                    let dist_sq = dx * dx + dz * dz;
                    let local_i = (snapped_lx as u32) * (grid as u32) + snapped_lz as u32;
                    candidates.push((local_i, dist_sq, x, z, height));
                }
            }
        }
        candidates.sort_unstable_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.cmp(&b.1))
                .then(a.2.cmp(&b.2))
                .then(a.3.cmp(&b.3))
        });
        let mut out = Vec::new();
        let mut last: Option<u32> = None;
        for (local_i, _, _, _, height) in candidates {
            if Some(local_i) == last {
                continue;
            }
            last = Some(local_i);
            out.push(local_i);
            out.push(height as u32);
            if out.len() / 2 >= MAX_TILE_OVERRIDES {
                break;
            }
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn chunk_of(diffs: &mut OverrideChunks, cx: i32, cz: i32) -> &mut HashMap<u32, u8> {
            diffs.entry((cx, cz)).or_default()
        }

        #[test]
        fn lod0_exact_match_only() {
            let mut diffs = OverrideChunks::new();
            // corner (10, 20) raised to height 5.
            chunk_of(&mut diffs, 0, 0).insert(10 * OVERLAY_CHUNK_SIZE as u32 + 20, 5);
            let out = build_tile_overrides(&diffs, 0, 0, 1, 257);
            assert_eq!(out, vec![10u32 * 257 + 20, 5]);
        }

        #[test]
        fn empty_overrides_produce_empty_output() {
            let diffs = OverrideChunks::new();
            assert!(build_tile_overrides(&diffs, 0, 0, 1, 257).is_empty());
        }

        #[test]
        fn coarse_lod_snaps_to_nearest_sample() {
            let mut diffs = OverrideChunks::new();
            // corner (3, 0) raised; at stride=4 the nearest sample is local (1,0) -> world (4,0).
            chunk_of(&mut diffs, 0, 0).insert(3 * OVERLAY_CHUNK_SIZE as u32 + 0, 7);
            let out = build_tile_overrides(&diffs, 0, 0, 4, 257);
            assert_eq!(out, vec![1u32 * 257 + 0, 7]);
        }

        #[test]
        fn collision_picks_nearest_deterministically() {
            let mut diffs = OverrideChunks::new();
            // Both (3,0) and (5,0) snap to local (1,0) at stride=4; (3,0) is nearer to
            // world x=4 (distance 1) than (5,0) (distance 1) -- tie, so x-ascending wins (3,0).
            chunk_of(&mut diffs, 0, 0).insert(3 * OVERLAY_CHUNK_SIZE as u32 + 0, 7);
            chunk_of(&mut diffs, 0, 0).insert(5 * OVERLAY_CHUNK_SIZE as u32 + 0, 9);
            let out = build_tile_overrides(&diffs, 0, 0, 4, 257);
            assert_eq!(out, vec![1u32 * 257 + 0, 7]);
        }

        #[test]
        fn deterministic_regardless_of_insertion_order() {
            let mut a = OverrideChunks::new();
            chunk_of(&mut a, 0, 0).insert(1, 2);
            chunk_of(&mut a, 0, 0).insert(5, 6);
            chunk_of(&mut a, -1, 0).insert(63 * OVERLAY_CHUNK_SIZE as u32 + 63, 3);
            let mut b = OverrideChunks::new();
            chunk_of(&mut b, -1, 0).insert(63 * OVERLAY_CHUNK_SIZE as u32 + 63, 3);
            chunk_of(&mut b, 0, 0).insert(5, 6);
            chunk_of(&mut b, 0, 0).insert(1, 2);
            assert_eq!(
                build_tile_overrides(&a, -10, -10, 2, 257),
                build_tile_overrides(&b, -10, -10, 2, 257)
            );
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use quarterview_terrain_core::clipmap::{
        select_tiles_into, tile_cell_span, TileKey, ViewRequest, TILE_SAMPLES,
    };
    use std::collections::HashMap;
    use wasm_bindgen::prelude::*;
    use web_sys::HtmlCanvasElement;
    use wgpu::util::DeviceExt;

    const GRID: u32 = TILE_SAMPLES as u32 + 1;
    const TILE_BYTES: u64 = GRID as u64 * GRID as u64 * 4;
    const MAX_RESIDENT_TILES: usize = 384;
    const MAX_NEW_TILES_PER_FRAME: usize = 24;
    const INDEX_COUNT_PER_TILE: u32 = (GRID - 1) * (GRID - 1) * 6;
    const MAX_CLIFF_EDGES: usize = 2 * (GRID as usize - 1) * (GRID as usize - 2);
    const MAX_WATER_CELLS: usize = (GRID as usize - 1) * (GRID as usize - 1);
    use super::{MAX_DRAW_VERTICES, RENDER_ARGS_TOTAL_BYTES, RENDER_COUNTS_BYTES};

    pub use super::edits::{build_tile_overrides, tile_world_bounds_for, OVERLAY_CHUNK_SIZE};
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

    pub use super::meshes::{
        interleave_vertices, split_instances_by_class, LayerClass, INSTANCE_STRIDE_BYTES,
        INSTANCE_STRIDE_FLOATS, VERTEX_STRIDE_BYTES,
    };
    pub use super::projection::{aabb_visible, CullCamera, ISO_H, ISO_X, ISO_Y};
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
        overrides: super::edits::OverrideChunks,

        adapter_name: String,
        adapter_backend: String,
    }

    #[wasm_bindgen]
    impl CanvasRenderer {
        #[wasm_bindgen(js_name = create)]
        pub async fn create(
            canvas: HtmlCanvasElement,
            seed: u32,
            half_extent: i32,
            // 地形プロファイル名 ("flat" / "normal" / "mountain")。世界ごとに不変なので
            // 生成時に固定する。未指定(旧い呼び出し)は "normal" として扱う。
            profile: Option<String>,
        ) -> Result<CanvasRenderer, JsValue> {
            console_error_panic_hook::set_once();
            let profile = profile
                .as_deref()
                .map(quarterview_terrain_core::TerrainProfile::from_name)
                .unwrap_or_default();
            let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
                backends: wgpu::Backends::BROWSER_WEBGPU,
                ..Default::default()
            });
            let surface: wgpu::Surface<'static> = instance
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                .map_err(|e| JsValue::from_str(&format!("create_surface: {e}")))?;
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: Some(&surface),
                    force_fallback_adapter: false,
                })
                .await
                .ok_or_else(|| JsValue::from_str("No WebGPU adapter available"))?;
            let info = adapter.get_info();
            let (device, queue) = adapter
                .request_device(
                    &wgpu::DeviceDescriptor {
                        label: Some("quarterview-renderer"),
                        required_features: wgpu::Features::empty(),
                        required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                            .using_resolution(adapter.limits()),
                        memory_hints: wgpu::MemoryHints::Performance,
                    },
                    None,
                )
                .await
                .map_err(|e| JsValue::from_str(&format!("request_device: {e}")))?;

            let caps = surface.get_capabilities(&adapter);
            let format = caps
                .formats
                .iter()
                .copied()
                .find(|f| f.is_srgb())
                .unwrap_or(caps.formats[0]);
            let config = wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: canvas.width().max(1),
                height: canvas.height().max(1),
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 2,
                alpha_mode: caps.alpha_modes[0],
                view_formats: vec![],
            };
            surface.configure(&device, &config);
            let (depth, depth_view) = create_depth(&device, config.width, config.height);

            let tile_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("tile-generate"),
                source: wgpu::ShaderSource::Wgsl(super::TILE_GENERATE_WGSL.into()),
            });
            let tile_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("tile-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    // R2: 疎な地形編集オーバーレイ(local_index昇順ソート済み)。
                    // build_tile_overrides が組み立て、tile_generate.wgsl が二分探索する。
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
            let tile_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("tile-layout"),
                bind_group_layouts: &[&tile_bgl],
                push_constant_ranges: &[],
            });
            let tile_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("tile-pipeline"),
                layout: Some(&tile_layout),
                module: &tile_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });

            let draw_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("terrain-draw"),
                source: wgpu::ShaderSource::Wgsl(super::TERRAIN_DRAW_WGSL.into()),
            });
            let draw_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("draw-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 4,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
            let camera_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("camera-bgl"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
            let draw_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("draw-layout"),
                bind_group_layouts: &[&draw_bgl, &camera_bgl],
                push_constant_ranges: &[],
            });

            let finalize_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("tile-finalize"),
                source: wgpu::ShaderSource::Wgsl(super::TILE_FINALIZE_WGSL.into()),
            });
            let finalize_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("tile-finalize-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 4,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
            let finalize_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("tile-finalize-layout"),
                bind_group_layouts: &[&finalize_bgl],
                push_constant_ranges: &[],
            });
            let finalize_pipeline =
                device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some("tile-finalize-pipeline"),
                    layout: Some(&finalize_layout),
                    module: &finalize_shader,
                    entry_point: Some("main"),
                    compilation_options: Default::default(),
                    cache: None,
                });

            // Draw-safety guard: clamps every tile's indirect quad before it can be
            // submitted (see shaders/tile_clamp_args.wgsl).
            let clamp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("tile-clamp-args"),
                source: wgpu::ShaderSource::Wgsl(super::TILE_CLAMP_ARGS_WGSL.into()),
            });
            let clamp_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("tile-clamp-args-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
            let clamp_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("tile-clamp-args-layout"),
                bind_group_layouts: &[&clamp_bgl],
                push_constant_ranges: &[],
            });
            let clamp_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("tile-clamp-args-pipeline"),
                layout: Some(&clamp_layout),
                module: &clamp_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            let mut clamp_params_bytes = [0u8; 16];
            put_u32(&mut clamp_params_bytes, 0, MAX_DRAW_VERTICES);
            let clamp_params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("tile-clamp-args-params"),
                contents: &clamp_params_bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });

            let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-camera-params"),
                size: 32,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-camera-bg"),
                layout: &camera_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_buffer.as_entire_binding(),
                }],
            });

            let draw_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("terrain-draw-pipeline"),
                layout: Some(&draw_layout),
                vertex: wgpu::VertexState {
                    module: &draw_shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &draw_shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth32Float,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::LessEqual,
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                multiview: None,
                cache: None,
            });

            // --- R4a: メッシュチャンク / インスタンス描画のパイプライン(mesh_pipeline モジュール) ---
            let mesh = super::mesh_pipeline::create_all(&device, format);
            let mesh_camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("mesh-camera-bg"),
                layout: &mesh.camera_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_buffer.as_entire_binding(),
                }],
            });
            let class_bind_groups = [
                LayerClass::Surface,
                LayerClass::Underground,
                LayerClass::Translucent,
                LayerClass::UndergroundGhost,
            ]
            .map(|class| {
                let mut bytes = [0u8; 16];
                put_u32(&mut bytes, 0, class.as_u32());
                let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("mesh-class-params"),
                    contents: &bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("mesh-class-bg"),
                    layout: &mesh.class_bgl,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    }],
                })
            });
            let mesh_pipelines = mesh.chunk;
            let instanced_pipelines = mesh.instanced;

            Ok(Self {
                surface,
                device,
                queue,
                config,
                _depth: depth,
                depth_view,
                tile_pipeline,
                tile_bgl,
                draw_pipeline,
                draw_bgl,
                _camera_bgl: camera_bgl,
                camera_buffer,
                camera_bind_group,
                finalize_pipeline,
                finalize_bgl,
                clamp_pipeline,
                clamp_bgl,
                clamp_params,
                mesh_pipelines,
                instanced_pipelines,
                class_bind_groups,
                mesh_camera_bind_group,
                mesh_chunks: HashMap::new(),
                instanced_meshes: HashMap::new(),
                tiles: HashMap::with_capacity(128),
                visible: Vec::with_capacity(64),
                needed: Vec::with_capacity(96),
                frame_index: 0,
                camera_revision: 1,
                seed,
                half_extent,
                profile,
                center_x: 0.0,
                center_z: 0.0,
                pixels_per_cell: 3.0,
                height_per_level: 1.0,
                dim: 1.0,
                overrides: HashMap::new(),
                adapter_name: info.name,
                adapter_backend: format!("{:?}", info.backend),
            })
        }

        pub fn resize(&mut self, width: u32, height: u32) {
            if width == 0 || height == 0 {
                return;
            }
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
            self.camera_revision = self.camera_revision.wrapping_add(1);
            let (depth, depth_view) = create_depth(&self.device, width, height);
            self._depth = depth;
            self.depth_view = depth_view;
        }

        /// カメラを本体(three.js)側の直交カメラに合わせる。
        ///
        /// - `center_x` / `center_z`: 画面中心に来る地表(y=0)の点。OrbitControls の
        ///   target が (tx,ty,tz) のとき、等角投影では (tx-ty, tz-ty) がその点になる
        ///   (JS 側 `render/webgpuCamera.ts` の `groundCentreFromTarget` が計算する)。
        /// - `pixels_per_cell`: ワールド1単位あたりの物理ピクセル数(= three.js の zoom × DPR)。
        /// - `height_per_level`: 段数1あたりのワールド高さ(本体の OVERPASS_HEIGHT)。
        ///   省略時は 1.0(プロトタイプの単独ページ用)。
        #[wasm_bindgen(js_name = setCamera)]
        pub fn set_camera(
            &mut self,
            center_x: f64,
            center_z: f64,
            pixels_per_cell: f64,
            height_per_level: Option<f64>,
        ) {
            let next_x = center_x.clamp(-(self.half_extent as f64), self.half_extent as f64);
            let next_z = center_z.clamp(-(self.half_extent as f64), self.half_extent as f64);
            let min_ppc = full_map_min_ppc(self.config.width, self.config.height, self.half_extent);
            let next_ppc = pixels_per_cell.clamp(min_ppc, MAX_PIXELS_PER_CELL);
            let next_height = height_per_level.unwrap_or(1.0);
            if self.center_x != next_x
                || self.center_z != next_z
                || self.pixels_per_cell != next_ppc
                || self.height_per_level != next_height
            {
                self.center_x = next_x;
                self.center_z = next_z;
                self.pixels_per_cell = next_ppc;
                self.height_per_level = next_height;
                self.camera_revision = self.camera_revision.wrapping_add(1);
            }
        }

        #[wasm_bindgen(js_name = panPixels)]
        pub fn pan_pixels(&mut self, screen_dx: f64, screen_dy: f64) {
            // 等角投影の逆変換(y=0 平面上):
            //   dsx = (dwx-dwz)*ppc*ISO_X, dsy = (dwx+dwz)*ppc*ISO_Y
            let ppc = self.pixels_per_cell.max(0.0001);
            let diff = screen_dx / (ppc * ISO_X);
            let sum = screen_dy / (ppc * ISO_Y);
            let world_x = 0.5 * (sum + diff);
            let world_z = 0.5 * (sum - diff);
            let next_x = (self.center_x - world_x)
                .clamp(-(self.half_extent as f64), self.half_extent as f64);
            let next_z = (self.center_z - world_z)
                .clamp(-(self.half_extent as f64), self.half_extent as f64);
            if self.center_x != next_x || self.center_z != next_z {
                self.center_x = next_x;
                self.center_z = next_z;
                self.camera_revision = self.camera_revision.wrapping_add(1);
            }
        }

        /// コーナー編集オーバーレイの1チャンク分を丸ごと置き換える(terrainOverlay.ts の
        /// `overlayChunkRefs` と同じ考え方: JS 側は参照が変わったサブMapだけを送る)。
        ///
        /// `entries` はフラットな `[localIndex0, height0, localIndex1, height1, ...]`
        /// (localIndex は `lx*OVERLAY_CHUNK_SIZE+lz`、terrainOverlay.ts の localIndexOf と
        /// 同じ並び)。空配列はチャンク全体の削除を意味する(TS 側が全コーナー基底復帰で
        /// chunkを削除するのと同じ)。影響しうる常駐タイル(全LOD、スナップ許容込み)を
        /// キャッシュから外し、次フレームの生成で再評価させる(A3: CPU側はHashMapの
        /// 差し替え+タイルキャッシュのretainのみで、O(編集件数+常駐タイル数)に収まる)。
        #[wasm_bindgen(js_name = setCornerOverrideChunk)]
        pub fn set_corner_override_chunk(&mut self, chunk_x: i32, chunk_z: i32, entries: &[u32]) {
            let key = (chunk_x, chunk_z);
            if entries.is_empty() {
                if self.overrides.remove(&key).is_none() {
                    return;
                }
            } else {
                let mut chunk = HashMap::with_capacity(entries.len() / 2);
                for pair in entries.chunks_exact(2) {
                    chunk.insert(pair[0], pair[1] as u8);
                }
                self.overrides.insert(key, chunk);
            }
            self.invalidate_chunk(chunk_x, chunk_z);
        }

        /// 地下ビュー減光係数(GameScene の isLevelDimmed と同調させる)。1.0=通常表示。
        #[wasm_bindgen(js_name = setDim)]
        pub fn set_dim(&mut self, factor: f64) {
            let next = factor.clamp(0.0, 1.0);
            if self.dim != next {
                self.dim = next;
                self.camera_revision = self.camera_revision.wrapping_add(1);
            }
        }

        /// R4a: ジオラマ物のメッシュチャンクを1つ登録(同じ id は置き換え)する。
        ///
        /// - `layer_class`: 0=地表(dim で減光) / 1=地下(深度 Always・地下ビュー限定) /
        ///   2=半透明(αは頂点色のA、深度書き込み無しで最後に描く)
        /// - `aabb`: `[min_x,min_y,min_z,max_x,max_y,max_z]`(y はワールド単位)。
        ///   毎フレームこの AABB を等角投影してビューポートと矩形判定し、外れたら描かない。
        /// - `positions`: xyz のフラット配列、`colours`: 頂点ごとの RGBA8(リトルエンディアン
        ///   で R,G,B,A の順)、`indices`: 三角形リストの u32 インデックス。
        ///
        /// 空(インデックス0件)の登録は既存チャンクの削除と同義に扱う。
        #[wasm_bindgen(js_name = uploadMeshChunk)]
        pub fn upload_mesh_chunk(
            &mut self,
            id: u32,
            layer_class: u32,
            aabb: &[f32],
            positions: &[f32],
            colours: &[u32],
            indices: &[u32],
        ) {
            if indices.is_empty() || positions.is_empty() {
                self.mesh_chunks.remove(&id);
                return;
            }
            let vertex_bytes = interleave_vertices(positions, colours);
            if vertex_bytes.is_empty() {
                self.mesh_chunks.remove(&id);
                return;
            }
            let vertices = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("mesh-chunk-vertices"),
                    contents: &vertex_bytes,
                    usage: wgpu::BufferUsages::VERTEX,
                });
            let index_buffer = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("mesh-chunk-indices"),
                    contents: bytemuck::cast_slice(indices),
                    usage: wgpu::BufferUsages::INDEX,
                });
            let mut bounds = [0f32; 6];
            bounds[..aabb.len().min(6)].copy_from_slice(&aabb[..aabb.len().min(6)]);
            self.mesh_chunks.insert(
                id,
                MeshChunk {
                    vertices,
                    indices: index_buffer,
                    index_count: indices.len() as u32,
                    class: LayerClass::from_u32(layer_class),
                    aabb: bounds,
                },
            );
        }

        /// R4a: メッシュチャンクを外す(存在しない id は無視)。
        #[wasm_bindgen(js_name = removeMeshChunk)]
        pub fn remove_mesh_chunk(&mut self, id: u32) {
            self.mesh_chunks.remove(&id);
        }

        /// R4a: インスタンス描画のプロトタイプメッシュを登録(同じ id は置き換え)する。
        /// 頂点色のアルファは「路線色(tint)で塗る重み」として使う(mesh_instanced.wgsl 参照)。
        #[wasm_bindgen(js_name = registerInstancedMesh)]
        pub fn register_instanced_mesh(
            &mut self,
            mesh_id: u32,
            positions: &[f32],
            colours: &[u32],
            indices: &[u32],
        ) {
            if indices.is_empty() || positions.is_empty() {
                self.instanced_meshes.remove(&mesh_id);
                return;
            }
            let vertex_bytes = interleave_vertices(positions, colours);
            if vertex_bytes.is_empty() {
                self.instanced_meshes.remove(&mesh_id);
                return;
            }
            let vertices = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("instanced-mesh-vertices"),
                    contents: &vertex_bytes,
                    usage: wgpu::BufferUsages::VERTEX,
                });
            let index_buffer = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("instanced-mesh-indices"),
                    contents: bytemuck::cast_slice(indices),
                    usage: wgpu::BufferUsages::INDEX,
                });
            self.instanced_meshes.insert(
                mesh_id,
                InstancedMesh {
                    vertices,
                    indices: index_buffer,
                    index_count: indices.len() as u32,
                    surface: None,
                    underground: None,
                },
            );
        }

        /// R4a: 登録済みメッシュのインスタンス配列を丸ごと差し替える。
        /// 1インスタンス = `INSTANCE_STRIDE_FLOATS` 個の f32(レイアウトは meshes モジュール参照)。
        /// 未登録の mesh_id は無視する。
        #[wasm_bindgen(js_name = setInstances)]
        pub fn set_instances(&mut self, mesh_id: u32, data: &[f32]) {
            let (surface_bytes, underground_bytes) = split_instances_by_class(data);
            let make = |device: &wgpu::Device, bytes: &[u8]| -> Option<(wgpu::Buffer, u32)> {
                if bytes.is_empty() {
                    return None;
                }
                let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("instance-data"),
                    contents: bytes,
                    usage: wgpu::BufferUsages::VERTEX,
                });
                Some((buffer, (bytes.len() / INSTANCE_STRIDE_BYTES) as u32))
            };
            let surface = make(&self.device, &surface_bytes);
            let underground = make(&self.device, &underground_bytes);
            if let Some(mesh) = self.instanced_meshes.get_mut(&mesh_id) {
                mesh.surface = surface;
                mesh.underground = underground;
            }
        }

        #[wasm_bindgen(js_name = zoomBy)]
        pub fn zoom_by(&mut self, factor: f64) {
            let min_ppc = full_map_min_ppc(self.config.width, self.config.height, self.half_extent);
            let next_ppc = (self.pixels_per_cell * factor).clamp(min_ppc, MAX_PIXELS_PER_CELL);
            if self.pixels_per_cell != next_ppc {
                self.pixels_per_cell = next_ppc;
                self.camera_revision = self.camera_revision.wrapping_add(1);
            }
        }

        pub fn render(&mut self) -> Result<String, JsValue> {
            let cpu_started = js_sys::Date::now();
            self.frame_index = self.frame_index.wrapping_add(1);

            // The draw set has no border; a second selection with a one-tile border is generated
            // ahead of time so panning does not expose blank terrain.
            let projected_span =
                (self.config.width as f64 + self.config.height as f64 * 2.0) / self.pixels_per_cell;
            let base_view = ViewRequest {
                center_x: self.center_x,
                center_z: self.center_z,
                span_x_cells: projected_span,
                span_z_cells: projected_span,
                pixels_per_cell: self.pixels_per_cell,
                half_extent: self.half_extent,
                prefetch_border: 0,
            };
            select_tiles_into(base_view, &mut self.visible);
            let mut prefetch_view = base_view;
            prefetch_view.prefetch_border = 1;
            select_tiles_into(prefetch_view, &mut self.needed);

            let frame = self
                .surface
                .get_current_texture()
                .map_err(|e| JsValue::from_str(&format!("surface frame: {e}")))?;
            let view = frame
                .texture
                .create_view(&wgpu::TextureViewDescriptor::default());
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("quarterview-frame"),
                });

            let mut generated = 0usize;
            let param_updates = 1usize;
            // R4a: この1フレームで実際に発行したジオラマ物のドロー数(perf JSON へ出す)。
            let mut mesh_draws = 0usize;
            let mut instance_draws = 0usize;
            // Visible tiles are hard priority. Prefetch is best-effort and budgeted so the
            // first frame never synchronously generates the whole one-tile border.
            for i in 0..self.visible.len() {
                let key = self.visible[i];
                if !self.tiles.contains_key(&key) {
                    if generated >= MAX_NEW_TILES_PER_FRAME {
                        break;
                    }
                    let tile = self.create_gpu_tile(key, &mut encoder);
                    self.tiles.insert(key, tile);
                    generated += 1;
                }
                if let Some(tile) = self.tiles.get_mut(&key) {
                    tile.last_used = self.frame_index;
                }
            }
            for i in 0..self.needed.len() {
                if generated >= MAX_NEW_TILES_PER_FRAME {
                    break;
                }
                let key = self.needed[i];
                if !self.tiles.contains_key(&key) {
                    let tile = self.create_gpu_tile(key, &mut encoder);
                    self.tiles.insert(key, tile);
                    generated += 1;
                }
                if let Some(tile) = self.tiles.get_mut(&key) {
                    tile.last_used = self.frame_index;
                }
            }

            let width = self.config.width as f32;
            let height = self.config.height as f32;
            let mut camera_bytes = [0u8; 32];
            put_f32(&mut camera_bytes, 0, self.center_x as f32);
            put_f32(&mut camera_bytes, 4, self.center_z as f32);
            put_f32(&mut camera_bytes, 8, self.pixels_per_cell as f32);
            put_f32(
                &mut camera_bytes,
                12,
                (self.pixels_per_cell * ISO_H * self.height_per_level) as f32,
            );
            put_f32(&mut camera_bytes, 16, width);
            put_f32(&mut camera_bytes, 20, height);
            put_f32(&mut camera_bytes, 24, self.half_extent as f32);
            put_f32(&mut camera_bytes, 28, self.dim as f32);
            self.queue
                .write_buffer(&self.camera_buffer, 0, &camera_bytes);

            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("quarterview-terrain-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.604,
                                g: 0.722,
                                b: 0.435,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &self.depth_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_pipeline(&self.draw_pipeline);
                pass.set_bind_group(1, &self.camera_bind_group, &[]);
                for &key in &self.visible {
                    if let Some(tile) = self.tiles.get(&key) {
                        pass.set_bind_group(0, &tile.draw_bind_group, &[]);
                        pass.draw_indirect(&tile.render_args, 0);
                    }
                }

                // --- R4a: ジオラマ物(メッシュチャンク+インスタンス) ---
                // 描画順は 地表(不透明) → 地表インスタンス → 地下 → 地下インスタンス →
                // 半透明。地下クラスは深度比較 Always で地形の上に出るため、地下ビュー
                // (dim<1.0)以外では丸ごと描かない(three.js 側で通常表示時に地下の
                // ジオメトリを出さないのと同じ規則)。
                let cull = CullCamera {
                    centre_x: self.center_x,
                    centre_z: self.center_z,
                    pixels_per_cell: self.pixels_per_cell,
                    viewport_w: self.config.width as f64,
                    viewport_h: self.config.height as f64,
                };
                let underground_visible = self.dim < 1.0;
                pass.set_bind_group(0, &self.mesh_camera_bind_group, &[]);

                let draw_class = |pass: &mut wgpu::RenderPass<'_>, class: LayerClass| {
                    let slot = class.as_u32() as usize;
                    pass.set_pipeline(&self.mesh_pipelines[slot]);
                    pass.set_bind_group(1, &self.class_bind_groups[slot], &[]);
                    let mut drawn = 0usize;
                    for chunk in self.mesh_chunks.values() {
                        if chunk.class != class || !aabb_visible(&chunk.aabb, cull) {
                            continue;
                        }
                        pass.set_vertex_buffer(0, chunk.vertices.slice(..));
                        pass.set_index_buffer(chunk.indices.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..chunk.index_count, 0, 0..1);
                        drawn += 1;
                    }
                    drawn
                };
                mesh_draws += draw_class(&mut pass, LayerClass::Surface);
                instance_draws += self.draw_instances(&mut pass, LayerClass::Surface);
                if underground_visible {
                    mesh_draws += draw_class(&mut pass, LayerClass::Underground);
                    instance_draws += self.draw_instances(&mut pass, LayerClass::Underground);
                }
                // 地上ビューの地下ゴースト。存在するかどうかは TS 側のフィーダが
                // 決める(地下ビュー中はチャンクを載せない)ので、ここでは条件を持たない。
                mesh_draws += draw_class(&mut pass, LayerClass::UndergroundGhost);
                mesh_draws += draw_class(&mut pass, LayerClass::Translucent);
            }
            self.queue.submit(Some(encoder.finish()));
            frame.present();
            self.prune_lru();

            let cpu_ms = js_sys::Date::now() - cpu_started;
            let lod = self.visible.first().map(|t| t.lod).unwrap_or(0);
            // drawCalls は従来どおり地形タイルのドロー数(既存の計測・ゲートとの互換のため)。
            // R4a のジオラマ物は meshDrawCalls / instancedDrawCalls として別に出す。
            Ok(format!(
                "{{\"cpuMs\":{cpu_ms:.3},\"cfgW\":{},\"cfgH\":{},\"heightScale\":{:.3},\"halfExtent\":{},\"drawCalls\":{},\"visibleTiles\":{},\"generatedTiles\":{generated},\"paramUpdates\":{param_updates},\"residentTiles\":{},\"tileGpuBytes\":{},\"lod\":{lod},\"centerX\":{:.3},\"centerZ\":{:.3},\"pixelsPerCell\":{:.5},\"meshChunks\":{},\"meshDrawCalls\":{mesh_draws},\"instancedMeshes\":{},\"instancedDrawCalls\":{instance_draws}}}",
                self.config.width, self.config.height,
                self.pixels_per_cell * ISO_H * self.height_per_level, self.half_extent,
                self.visible.len(), self.visible.len(), self.tiles.len(), self.tiles.len() as u64 * TILE_BYTES,
                self.center_x, self.center_z, self.pixels_per_cell,
                self.mesh_chunks.len(), self.instanced_meshes.len(),
            ))
        }

        /// デバッグ用: 現在 GPU に常駐しているタイルの一覧と、各タイルに適用された
        /// build_tile_overrides の生の出力をそのまま JSON で返す。コーナー高さの
        /// 上書きがコンピュートシェーダへ渡る直前の状態をブラウザから直接検査するため。
        /// このAPI群(debugTiles/debugOverrideStore/debugReadTileSamples)はコーナー
        /// オーバーライドのブラウザ側診断のために常設した。調査経緯は
        /// progress/wgpu-corner-override-z-investigation.md を参照。
        #[wasm_bindgen(js_name = debugTiles)]
        pub fn debug_tiles(&self) -> String {
            const MAX_ENTRIES: usize = 4096;
            let mut visible = String::from("[");
            for (i, key) in self.visible.iter().enumerate() {
                if i > 0 {
                    visible.push(',');
                }
                visible.push_str(&format!("[{},{},{}]", key.x, key.z, key.lod));
            }
            visible.push(']');

            let mut tiles = String::from("[");
            for (i, (key, tile)) in self.tiles.iter().enumerate() {
                if i > 0 {
                    tiles.push(',');
                }
                let origin_x = key.x * tile_cell_span(key.lod);
                let origin_z = key.z * tile_cell_span(key.lod);
                let stride = 1i32 << key.lod;
                let override_count = (tile.debug_overrides.len() / 2) as u32;
                let mut entries = String::from("[");
                for (j, v) in tile
                    .debug_overrides
                    .iter()
                    .take(MAX_ENTRIES)
                    .enumerate()
                {
                    if j > 0 {
                        entries.push(',');
                    }
                    entries.push_str(&v.to_string());
                }
                entries.push(']');
                tiles.push_str(&format!(
                    "{{\"kx\":{},\"kz\":{},\"lod\":{},\"originX\":{origin_x},\"originZ\":{origin_z},\"stride\":{stride},\"overrideCount\":{override_count},\"entries\":{entries},\"lastUsed\":{}}}",
                    key.x, key.z, key.lod, tile.last_used
                ));
            }
            tiles.push(']');

            format!("{{\"visible\":{visible},\"tiles\":{tiles}}}")
        }

        /// デバッグ用: 編集オーバーレイの現在の格納状態を、チャンクごとに local_index 昇順で
        /// 整列したフラット配列として返す。GPU 側の debugTiles と突き合わせて、
        /// 「保存されている編集」と「タイル生成時に実際に適用された編集」の食い違いを追う。
        /// ブラウザ側診断用に常設。調査経緯は progress/wgpu-corner-override-z-investigation.md 参照。
        #[wasm_bindgen(js_name = debugOverrideStore)]
        pub fn debug_override_store(&self) -> String {
            const MAX_ENTRIES: usize = 4096;
            let mut chunks = String::from("[");
            for (i, (&(cx, cz), chunk)) in self.overrides.iter().enumerate() {
                if i > 0 {
                    chunks.push(',');
                }
                let mut sorted: Vec<(u32, u8)> = chunk.iter().map(|(&k, &v)| (k, v)).collect();
                sorted.sort_unstable_by_key(|(local_index, _)| *local_index);
                let mut entries = String::from("[");
                for (j, (local_index, height)) in sorted.iter().take(MAX_ENTRIES / 2).enumerate()
                {
                    if j > 0 {
                        entries.push(',');
                    }
                    entries.push_str(&format!("{local_index},{height}"));
                }
                entries.push(']');
                chunks.push_str(&format!(
                    "{{\"cx\":{cx},\"cz\":{cz},\"len\":{},\"entries\":{entries}}}",
                    sorted.len()
                ));
            }
            chunks.push(']');
            chunks
        }

        /// デバッグ用: 常駐タイルの samples バッファ(コンピュートシェーダが書き込んだ生の
        /// 標高グリッド)を GPU から読み戻す。debugTiles で上書きエントリの適用状況が
        /// 正しく見えるのに描画結果が誤っている場合、コンピュートシェーダの出力そのものが
        /// 期待どおりかをブラウザから直接検証するために使う。
        /// ブラウザ側診断用に常設。調査経緯は progress/wgpu-corner-override-z-investigation.md 参照。
        #[wasm_bindgen(js_name = debugReadTileSamples)]
        pub async fn debug_read_tile_samples(
            &mut self,
            kx: i32,
            kz: i32,
            lod: u32,
        ) -> Result<js_sys::Uint32Array, JsValue> {
            let key = TileKey {
                lod: lod as u8,
                x: kx,
                z: kz,
            };
            let samples_buf = self
                .tiles
                .get(&key)
                .map(|tile| tile.samples.clone())
                .ok_or_else(|| {
                    JsValue::from_str(&format!(
                        "debugReadTileSamples: no resident tile for kx={kx} kz={kz} lod={lod}"
                    ))
                })?;

            let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("debug-tile-samples-staging"),
                size: TILE_BYTES,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("debug-read-tile-samples"),
                });
            encoder.copy_buffer_to_buffer(&samples_buf, 0, &staging, 0, TILE_BYTES);
            self.queue.submit(Some(encoder.finish()));

            let slice = staging.slice(..);
            let promise = js_sys::Promise::new(&mut |resolve, reject| {
                slice.map_async(wgpu::MapMode::Read, move |result| match result {
                    Ok(()) => {
                        let _ = resolve.call0(&JsValue::NULL);
                    }
                    Err(err) => {
                        let _ = reject.call1(&JsValue::NULL, &JsValue::from_str(&format!("{err:?}")));
                    }
                });
            });
            // WebGPU バックエンドではブラウザのイベントループが map_async を解決する。
            // Poll はネイティブ経路との対称性のために呼ぶが、wasm 上では実質no-op。
            let _ = self.device.poll(wgpu::Maintain::Poll);
            wasm_bindgen_futures::JsFuture::from(promise).await?;

            let mapped = slice.get_mapped_range();
            let words: &[u32] = bytemuck::cast_slice(&mapped);
            let out = js_sys::Uint32Array::new_with_length(words.len() as u32);
            out.copy_from(words);
            drop(mapped);
            staging.unmap();

            Ok(out)
        }

        #[wasm_bindgen(js_name = adapterInfo)]
        pub fn adapter_info(&self) -> String {
            format!(
                "{{\"name\":{:?},\"backend\":{:?},\"format\":\"{:?}\"}}",
                self.adapter_name, self.adapter_backend, self.config.format
            )
        }
    }

    impl CanvasRenderer {
        /// R4a: 登録済みインスタンスメッシュのうち、指定クラスのインスタンス群を描く。
        /// 戻り値は発行したドロー数(メッシュ1つにつき1インスタンスドロー)。
        fn draw_instances(&self, pass: &mut wgpu::RenderPass<'_>, class: LayerClass) -> usize {
            let slot = match class {
                LayerClass::Underground => 1,
                _ => 0,
            };
            pass.set_pipeline(&self.instanced_pipelines[slot]);
            pass.set_bind_group(1, &self.class_bind_groups[class.as_u32() as usize], &[]);
            let mut draws = 0usize;
            for mesh in self.instanced_meshes.values() {
                let slice = match class {
                    LayerClass::Underground => mesh.underground.as_ref(),
                    _ => mesh.surface.as_ref(),
                };
                let Some((buffer, count)) = slice else {
                    continue;
                };
                if *count == 0 {
                    continue;
                }
                pass.set_vertex_buffer(0, mesh.vertices.slice(..));
                pass.set_vertex_buffer(1, buffer.slice(..));
                pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..mesh.index_count, 0, 0..*count);
                draws += 1;
            }
            draws
        }

        fn create_gpu_tile(&self, key: TileKey, encoder: &mut wgpu::CommandEncoder) -> GpuTile {
            let origin_x = key.x * tile_cell_span(key.lod);
            let origin_z = key.z * tile_cell_span(key.lod);
            let stride = 1i32 << key.lod;
            let samples = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-tile-samples"),
                size: TILE_BYTES,
                // COPY_SRC: debugReadTileSamples がライブ状態の読み戻し検証に使う。
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            // R2: このタイルが実際にサンプルする範囲へ重なる編集オーバーレイだけを、
            // local_index昇順のソート済みフラット配列へ変換する(build_tile_overrides の
            // LOD一貫性規則を参照)。tile_generate.wgsl はこれを二分探索する。
            let override_entries =
                build_tile_overrides(&self.overrides, origin_x, origin_z, stride, GRID as i32);
            let override_count = (override_entries.len() / 2) as u32;
            let override_buffer_contents: Vec<u8> = if override_entries.is_empty() {
                vec![0u8; 8]
            } else {
                override_entries
                    .iter()
                    .flat_map(|v| v.to_le_bytes())
                    .collect()
            };
            let overrides_buf = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("terrain-tile-overrides"),
                    contents: &override_buffer_contents,
                    usage: wgpu::BufferUsages::STORAGE,
                });
            let mut params = Vec::with_capacity(32);
            push_u32(&mut params, self.seed);
            push_i32(&mut params, self.half_extent);
            push_i32(&mut params, origin_x);
            push_i32(&mut params, origin_z);
            push_i32(&mut params, stride);
            push_u32(&mut params, GRID);
            push_u32(&mut params, override_count);
            push_u32(&mut params, 0);
            // プロファイル別の標高しきい値(hi,lo × 10)。シェーダ側はプロファイル分岐を持たない。
            for word in self.profile.threshold_words() {
                push_u32(&mut params, word);
            }
            let params = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("terrain-tile-params"),
                    contents: &params,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let compute_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-tile-compute-bg"),
                layout: &self.tile_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: samples.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: overrides_buf.as_entire_binding(),
                    },
                ],
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("terrain-tile-generate"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.tile_pipeline);
                pass.set_bind_group(0, &compute_bg, &[]);
                pass.dispatch_workgroups((GRID * GRID + 255) / 256, 1, 1);
            }

            let mut finalize_params_bytes = [0u8; 16];
            put_u32(&mut finalize_params_bytes, 0, GRID);
            let finalize_params =
                self.device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("terrain-tile-finalize-params"),
                        contents: &finalize_params_bytes,
                        usage: wgpu::BufferUsages::UNIFORM,
                    });
            let cliff_edges = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-cliff-edges"),
                size: (MAX_CLIFF_EDGES * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });
            let water_cells = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-water-cells"),
                size: (MAX_WATER_CELLS * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            });
            let base_vertices = INDEX_COUNT_PER_TILE;
            // words: [vertex_count, instance_count, first_vertex, first_instance,
            //         cliff_vertices, water_vertices, pad, pad, diagnostics x4]
            let render_args_bytes = [
                base_vertices,
                1u32,
                0u32,
                0u32,
                0u32,
                0u32,
                0u32,
                0u32,
                0u32,
                0u32,
                0u32,
                0u32,
            ];
            let render_args = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("terrain-render-indirect-args"),
                    contents: bytemuck::cast_slice(&render_args_bytes),
                    usage: wgpu::BufferUsages::STORAGE
                        | wgpu::BufferUsages::INDIRECT
                        | wgpu::BufferUsages::COPY_DST
                        | wgpu::BufferUsages::COPY_SRC,
                });
            debug_assert_eq!(render_args.size(), RENDER_ARGS_TOTAL_BYTES);
            let finalize_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-tile-finalize-bg"),
                layout: &self.finalize_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: finalize_params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: samples.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: cliff_edges.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: water_cells.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: render_args.as_entire_binding(),
                    },
                ],
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("terrain-tile-finalize"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.finalize_pipeline);
                pass.set_bind_group(0, &finalize_bg, &[]);
                pass.dispatch_workgroups(((GRID - 1) * (GRID - 1) + 255) / 256, 1, 1);
            }
            {
                let clamp_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("terrain-tile-clamp-args-bg"),
                    layout: &self.clamp_bgl,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: self.clamp_params.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: render_args.as_entire_binding(),
                        },
                    ],
                });
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("terrain-tile-clamp-args"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(&self.clamp_pipeline);
                pass.set_bind_group(0, &clamp_bg, &[]);
                pass.dispatch_workgroups(1, 1, 1);
            }
            let render_counts = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-render-counts"),
                size: RENDER_COUNTS_BYTES,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            encoder.copy_buffer_to_buffer(&render_args, 0, &render_counts, 0, RENDER_COUNTS_BYTES);

            let mut tile_bytes = [0u8; 16];
            put_i32(&mut tile_bytes, 0, origin_x);
            put_i32(&mut tile_bytes, 4, origin_z);
            put_i32(&mut tile_bytes, 8, stride);
            put_u32(&mut tile_bytes, 12, GRID);
            let tile_params = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("terrain-tile-draw-params"),
                    contents: &tile_bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let draw_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-draw-bg"),
                layout: &self.draw_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: tile_params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: samples.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: cliff_edges.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: water_cells.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: render_counts.as_entire_binding(),
                    },
                ],
            });
            GpuTile {
                samples,
                _tile_params: tile_params,
                _cliff_edges: cliff_edges,
                _water_cells: water_cells,
                render_args,
                _render_counts: render_counts,
                _overrides: overrides_buf,
                draw_bind_group,
                last_used: self.frame_index,
                debug_overrides: override_entries.clone(),
            }
        }

        fn prune_lru(&mut self) {
            if self.tiles.len() <= MAX_RESIDENT_TILES {
                return;
            }
            let remove_count = self.tiles.len() - MAX_RESIDENT_TILES;
            let mut ages: Vec<(TileKey, u64)> =
                self.tiles.iter().map(|(&k, v)| (k, v.last_used)).collect();
            ages.sort_unstable_by_key(|(_, age)| *age);
            for (key, _) in ages.into_iter().take(remove_count) {
                self.tiles.remove(&key);
            }
        }

        /// 編集オーバーレイのチャンク(chunk_x,chunk_z)に触れうる常駐タイルをキャッシュから
        /// 外す(全LODが対象。スナップ許容 ±stride/2 も bbox に含める)。次フレームの
        /// visible/needed 選択に載れば create_gpu_tile が最新のオーバーレイで再生成する
        /// (T8: 影響タイルだけの再生成であり全タイル再構築ではない)。
        fn invalidate_chunk(&mut self, chunk_x: i32, chunk_z: i32) {
            let cx0 = chunk_x * super::edits::OVERLAY_CHUNK_SIZE;
            let cx1 = cx0 + super::edits::OVERLAY_CHUNK_SIZE - 1;
            let cz0 = chunk_z * super::edits::OVERLAY_CHUNK_SIZE;
            let cz1 = cz0 + super::edits::OVERLAY_CHUNK_SIZE - 1;
            self.tiles.retain(|&key, _| {
                let stride = 1i32 << key.lod;
                let origin_x = key.x * tile_cell_span(key.lod);
                let origin_z = key.z * tile_cell_span(key.lod);
                let (tx0, tx1, tz0, tz1) =
                    tile_world_bounds_for(origin_x, origin_z, stride, GRID as i32);
                !(tx0 <= cx1 && tx1 >= cx0 && tz0 <= cz1 && tz1 >= cz0)
            });
        }
    }

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
        super::TILE_GENERATE_WGSL.to_owned()
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
