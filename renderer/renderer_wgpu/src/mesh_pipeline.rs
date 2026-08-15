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

/// D1: 透視投影パイプライン一式。`create_all` と**同じ** camera_bgl/class_bgl
/// (パイプラインレイアウト)を再利用する — bind group layout はバッファの中身に
/// 関知しない(uniform 1本、サイズ制約なし)ので、専用の透視投影カメラ uniform
/// バッファ(こちらは view_proj 行列を積む、CanvasRenderer::persp_camera_buffer)を
/// 同じレイアウトへ束ねられる。シェーダとバインドグループだけが別経路になる。
pub fn create_perspective_all(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    camera_bgl: &wgpu::BindGroupLayout,
    class_bgl: &wgpu::BindGroupLayout,
) -> ([wgpu::RenderPipeline; 4], [wgpu::RenderPipeline; 2]) {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("mesh-persp-layout"),
        bind_group_layouts: &[camera_bgl, class_bgl],
        push_constant_ranges: &[],
    });
    let mesh_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("mesh-draw-persp"),
        source: wgpu::ShaderSource::Wgsl(super::MESH_DRAW_PERSP_WGSL.into()),
    });
    let instanced_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("mesh-instanced-persp"),
        source: wgpu::ShaderSource::Wgsl(super::MESH_INSTANCED_PERSP_WGSL.into()),
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
            "mesh-draw-persp-pipeline",
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
            "mesh-instanced-persp-pipeline",
        )
    });
    (chunk, instanced)
}
