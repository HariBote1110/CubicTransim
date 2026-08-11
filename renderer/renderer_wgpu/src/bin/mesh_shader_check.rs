//! R4a: メッシュチャンク / インスタンス描画パイプラインのネイティブ検証。
//!
//! `shaders/mesh_draw.wgsl` と `shaders/mesh_instanced.wgsl` を実デバイスでコンパイルし、
//! 5本のパイプライン(チャンク3クラス+インスタンス2クラス)を実際に組み立てて、
//! 頂点バッファレイアウトとシェーダ入力の整合まで検証する。さらに 1x1 のオフスクリーンへ
//! 1三角形ずつ描いて読み戻し、頂点色と dim 減光が期待どおりに出ることを確認する。
//!
//! ブラウザを立ち上げずに WGSL のミスを捕まえるためのゲート(bench/run-layer-a.mjs から
//! 呼ぶネイティブチェック群と同じ位置づけ)。

use quarterview_renderer_wgpu::mesh_pipeline;
use quarterview_renderer_wgpu::meshes::{interleave_vertices, LayerClass, INSTANCE_STRIDE_FLOATS};
use wgpu::util::DeviceExt;

#[path = "bench_common/mod.rs"]
mod bench_common;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const SIZE: u32 = 8;

/// カメラ uniform(32バイト)。terrain_draw.wgsl / mesh_draw.wgsl と同じ並び。
fn camera_bytes(dim: f32) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    let ppc = 8.0f32;
    let put = |bytes: &mut [u8], offset: usize, v: f32| {
        bytes[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
    };
    put(&mut bytes, 0, 0.0); // centre_x
    put(&mut bytes, 4, 0.0); // centre_z
    put(&mut bytes, 8, ppc); // pixels_per_cell
    put(&mut bytes, 12, ppc * 0.816_496_58 * 0.8); // height_scale (= ppc*ISO_H*OVERPASS_HEIGHT)
    put(&mut bytes, 16, SIZE as f32);
    put(&mut bytes, 20, SIZE as f32);
    put(&mut bytes, 24, 64.0); // half_extent
    put(&mut bytes, 28, dim);
    bytes
}

fn class_buffer(device: &wgpu::Device, class: LayerClass) -> wgpu::Buffer {
    let mut bytes = [0u8; 16];
    bytes[0..4].copy_from_slice(&class.as_u32().to_le_bytes());
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("class-params"),
        contents: &bytes,
        usage: wgpu::BufferUsages::UNIFORM,
    })
}

/// 画面全体を覆う1三角形(等角投影を通しても必ずビューポートを覆うよう十分大きく取る)。
fn full_screen_triangle(colour: u32) -> (Vec<u8>, Vec<u32>) {
    let positions: [f32; 9] = [-40.0, 0.0, -40.0, 40.0, 0.0, -40.0, 0.0, 0.0, 60.0];
    let colours = [colour; 3];
    (interleave_vertices(&positions, &colours), vec![0, 1, 2])
}

fn read_centre_pixel(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    draw: impl FnOnce(&mut wgpu::RenderPass<'_>),
) -> [u8; 4] {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("mesh-check-target"),
        size: wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());
    let depth = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("mesh-check-depth"),
        size: wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let depth_view = depth.create_view(&wgpu::TextureViewDescriptor::default());
    // 読み戻しは 256 バイト行ピッチ制約に合わせる。
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("mesh-check-readback"),
        size: 256 * SIZE as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("mesh-check-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        draw(&mut pass);
    }
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(SIZE),
            },
        },
        wgpu::Extent3d {
            width: SIZE,
            height: SIZE,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(encoder.finish()));

    let slice = readback.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
    device.poll(wgpu::Maintain::Wait);
    rx.recv().unwrap().expect("map readback");
    let data = slice.get_mapped_range();
    let row = (SIZE / 2) as usize;
    let col = (SIZE / 2) as usize;
    let offset = row * 256 + col * 4;
    let pixel = [
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ];
    drop(data);
    readback.unmap();
    pixel
}

fn main() {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: bench_common::select_backends(),
        ..Default::default()
    });
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("adapter");
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("mesh-shader-check"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .expect("device");

    // 5本のパイプラインを組み立てる(ここで WGSL と頂点レイアウトの整合が検証される)。
    let pipelines = mesh_pipeline::create_all(&device, FORMAT);

    let make_camera_bg = |dim: f32| {
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("camera"),
            contents: &camera_bytes(dim),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("camera-bg"),
            layout: &pipelines.camera_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        })
    };
    let class_bgs = [
        LayerClass::Surface,
        LayerClass::Underground,
        LayerClass::Translucent,
        LayerClass::UndergroundGhost,
    ]
    .map(|c| {
        let buffer = class_buffer(&device, c);
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("class-bg"),
            layout: &pipelines.class_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        })
    });

    // 不透明な赤(RGBA8 リトルエンディアン: 0xAABBGGRR)。
    let (vertex_bytes, indices) = full_screen_triangle(0xff00_00ff);
    let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("verts"),
        contents: &vertex_bytes,
        usage: wgpu::BufferUsages::VERTEX,
    });
    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("indices"),
        contents: bytemuck::cast_slice(&indices),
        usage: wgpu::BufferUsages::INDEX,
    });

    let camera_full = make_camera_bg(1.0);
    let camera_dim = make_camera_bg(0.3);

    // 1) 地表クラス、dim=1.0 -> 頂点色そのまま。
    let surface_full = read_centre_pixel(&device, &queue, |pass| {
        pass.set_pipeline(&pipelines.chunk[0]);
        pass.set_bind_group(0, &camera_full, &[]);
        pass.set_bind_group(1, &class_bgs[0], &[]);
        pass.set_vertex_buffer(0, vertices.slice(..));
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
    });

    // 2) 地表クラス、dim=0.3 -> 赤が 0.3 倍に減光される。
    let surface_dimmed = read_centre_pixel(&device, &queue, |pass| {
        pass.set_pipeline(&pipelines.chunk[0]);
        pass.set_bind_group(0, &camera_dim, &[]);
        pass.set_bind_group(1, &class_bgs[0], &[]);
        pass.set_vertex_buffer(0, vertices.slice(..));
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
    });

    // 3) 地下クラス、dim=0.3 -> 減光されない(選択中の地下レベルは通常輝度)。
    let underground_dimmed = read_centre_pixel(&device, &queue, |pass| {
        pass.set_pipeline(&pipelines.chunk[1]);
        pass.set_bind_group(0, &camera_dim, &[]);
        pass.set_bind_group(1, &class_bgs[1], &[]);
        pass.set_vertex_buffer(0, vertices.slice(..));
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
    });

    // 4) インスタンス描画: 頂点色 alpha=255(=tint 全掛け)の白へ緑の tint を掛けて描く。
    let (white_bytes, white_indices) = full_screen_triangle(0xffff_ffff);
    let white_vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("verts-white"),
        contents: &white_bytes,
        usage: wgpu::BufferUsages::VERTEX,
    });
    let white_index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("indices-white"),
        contents: bytemuck::cast_slice(&white_indices),
        usage: wgpu::BufferUsages::INDEX,
    });
    let mut instance = vec![0.0f32; INSTANCE_STRIDE_FLOATS];
    instance[6] = 1.0; // tintG = 1、tintR/tintB = 0 -> 緑に染まる
    let instance_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("instances"),
        contents: bytemuck::cast_slice(&instance),
        usage: wgpu::BufferUsages::VERTEX,
    });
    let instanced_tinted = read_centre_pixel(&device, &queue, |pass| {
        pass.set_pipeline(&pipelines.instanced[0]);
        pass.set_bind_group(0, &camera_full, &[]);
        pass.set_bind_group(1, &class_bgs[0], &[]);
        pass.set_vertex_buffer(0, white_vertices.slice(..));
        pass.set_vertex_buffer(1, instance_buffer.slice(..));
        pass.set_index_buffer(white_index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..white_indices.len() as u32, 0, 0..1);
    });

    // 5) 地下ゴーストクラス(地上ビューで地下を透かす層): 不透明な赤の地表を描いた上へ
    //    α=0.3 の青を重ね、深度に関係なく(Always)αブレンドされることを確かめる。
    let (ghost_bytes, ghost_indices) = full_screen_triangle(0x4cff_0000);
    let ghost_vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("verts-ghost"),
        contents: &ghost_bytes,
        usage: wgpu::BufferUsages::VERTEX,
    });
    let ghost_index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("indices-ghost"),
        contents: bytemuck::cast_slice(&ghost_indices),
        usage: wgpu::BufferUsages::INDEX,
    });
    let ghost_over_surface = read_centre_pixel(&device, &queue, |pass| {
        pass.set_pipeline(&pipelines.chunk[0]);
        pass.set_bind_group(0, &camera_full, &[]);
        pass.set_bind_group(1, &class_bgs[0], &[]);
        pass.set_vertex_buffer(0, vertices.slice(..));
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..indices.len() as u32, 0, 0..1);

        pass.set_pipeline(&pipelines.chunk[3]);
        pass.set_bind_group(1, &class_bgs[3], &[]);
        pass.set_vertex_buffer(0, ghost_vertices.slice(..));
        pass.set_index_buffer(ghost_index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        pass.draw_indexed(0..ghost_indices.len() as u32, 0, 0..1);
    });

    let near = |a: u8, b: u8| (a as i32 - b as i32).abs() <= 2;
    let checks = [
        (
            "surfaceUndimmed",
            surface_full[0] == 255 && surface_full[1] == 0,
        ),
        (
            "surfaceDimmed",
            near(surface_dimmed[0], 77) && surface_dimmed[1] == 0,
        ),
        ("undergroundIgnoresDim", underground_dimmed[0] == 255),
        (
            "instancedTint",
            instanced_tinted[0] == 0 && instanced_tinted[1] == 255 && instanced_tinted[2] == 0,
        ),
        // 赤(255,0,0)の上へ α=0.3 の青 -> R≈178, B≈76 のブレンド結果になる。
        (
            "undergroundGhostBlends",
            near(ghost_over_surface[0], 179)
                && near(ghost_over_surface[2], 76)
                && ghost_over_surface[1] == 0,
        ),
    ];
    let failures: Vec<&str> = checks
        .iter()
        .filter(|(_, ok)| !ok)
        .map(|(n, _)| *n)
        .collect();
    let info = adapter.get_info();
    println!(
        "{{\"ok\":{},\"adapter\":{:?},\"backend\":\"{:?}\",\"pipelines\":6,\"failures\":{:?},\"pixels\":{{\"surfaceUndimmed\":{:?},\"surfaceDimmed\":{:?},\"undergroundDimmed\":{:?},\"instancedTinted\":{:?},\"ghostOverSurface\":{:?}}}}}",
        failures.is_empty(),
        info.name,
        info.backend,
        failures,
        surface_full,
        surface_dimmed,
        underground_dimmed,
        instanced_tinted,
        ghost_over_surface,
    );
    if !failures.is_empty() {
        std::process::exit(1);
    }
}
