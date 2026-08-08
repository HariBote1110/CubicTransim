use std::{fs, sync::mpsc, time::Instant};
use wgpu::util::DeviceExt;

#[path = "bench_common/mod.rs"]
mod bench_common;

const GRID: u32 = 257;
const WIDTH: u32 = 800;
const HEIGHT: u32 = 600;
const INDEX_COUNT_PER_TILE: u32 = (GRID - 1) * (GRID - 1) * 6;

fn u32b(v: u32, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn i32b(v: i32, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn f32b(v: f32, out: &mut Vec<u8>) {
    out.extend_from_slice(&v.to_le_bytes());
}
fn build_indices() -> Vec<u32> {
    let cells = GRID - 1;
    let mut out = Vec::with_capacity(INDEX_COUNT_PER_TILE as usize);
    for z in 0..cells {
        for x in 0..cells {
            let a = z * GRID + x;
            let b = a + 1;
            let c = (z + 1) * GRID + x;
            let d = c + 1;
            out.extend_from_slice(&[a, b, c, b, d, c]);
        }
    }
    out
}

fn main() {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: bench_common::select_backends(),
        ..Default::default()
    });
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("adapter");
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("offscreen-render"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .expect("device");

    let tile_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("tile-generate"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/tile_generate.wgsl").into()),
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
        source: wgpu::ShaderSource::Wgsl(
            include_str!("../../shaders/terrain_draw_surface.wgsl").into(),
        ),
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
    let draw_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("draw-pipeline"),
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
                format: wgpu::TextureFormat::Rgba8Unorm,
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

    let index_data = build_indices();
    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("terrain-grid-index-buffer"),
        contents: bytemuck::cast_slice(&index_data),
        usage: wgpu::BufferUsages::INDEX,
    });
    let camera_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("camera-params"),
        contents: &[0u8; 32],
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });
    let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("camera-bg"),
        layout: &camera_bgl,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: camera_buffer.as_entire_binding(),
        }],
    });
    let mut camera_bytes = Vec::with_capacity(32);
    f32b(0.0, &mut camera_bytes);
    f32b(0.0, &mut camera_bytes);
    f32b(3.0, &mut camera_bytes);
    f32b(10.0, &mut camera_bytes);
    f32b(WIDTH as f32, &mut camera_bytes);
    f32b(HEIGHT as f32, &mut camera_bytes);
    f32b(8192.0, &mut camera_bytes);
    f32b(0.0, &mut camera_bytes);
    queue.write_buffer(&camera_buffer, 0, &camera_bytes);

    let sample_bytes = GRID as u64 * GRID as u64 * 4;
    let samples = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("tile-samples"),
        size: sample_bytes,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });

    let origin_x = -128i32;
    let origin_z = -128i32;
    let stride = 1i32;
    let mut tile_params = Vec::with_capacity(32);
    u32b(0x1234_5678, &mut tile_params);
    i32b(8192, &mut tile_params);
    i32b(origin_x, &mut tile_params);
    i32b(origin_z, &mut tile_params);
    i32b(stride, &mut tile_params);
    u32b(GRID, &mut tile_params);
    u32b(0, &mut tile_params);
    u32b(0, &mut tile_params);
    let tile_params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("tile-params"),
        contents: &tile_params,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let overrides_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("tile-overrides"),
        contents: &[0u8; 8],
        usage: wgpu::BufferUsages::STORAGE,
    });
    let tile_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("tile-bg"),
        layout: &tile_bgl,
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
                resource: overrides_buf.as_entire_binding(),
            },
        ],
    });

    let mut draw_params = Vec::with_capacity(16);
    i32b(origin_x, &mut draw_params);
    i32b(origin_z, &mut draw_params);
    i32b(stride, &mut draw_params);
    u32b(GRID, &mut draw_params);
    let draw_params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("draw-params"),
        contents: &draw_params,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let draw_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("draw-bg"),
        layout: &draw_bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: draw_params.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: samples.as_entire_binding(),
            },
        ],
    });

    let color = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen-color"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let color_view = color.create_view(&Default::default());
    let depth = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("offscreen-depth"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let depth_view = depth.create_view(&Default::default());

    let unpadded = WIDTH * 4;
    let padded = (unpadded + 255) & !255;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("color-readback"),
        size: padded as u64 * HEIGHT as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let started = Instant::now();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("offscreen-encoder"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("tile-generate"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&tile_pipeline);
        pass.set_bind_group(0, &tile_bg, &[]);
        pass.dispatch_workgroups((GRID * GRID + 255) / 256, 1, 1);
    }
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("terrain-render"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &color_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 0.08,
                        g: 0.09,
                        b: 0.11,
                        a: 1.0,
                    }),
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
        pass.set_pipeline(&draw_pipeline);
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        pass.set_bind_group(1, &camera_bind_group, &[]);
        pass.set_bind_group(0, &draw_bg, &[]);
        pass.draw_indexed(0..INDEX_COUNT_PER_TILE, 0, 0..1);
    }
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &color,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: Some(HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    queue.submit(Some(encoder.finish()));
    let slice = readback.slice(..);
    let (tx, rx) = mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| {
        tx.send(r).ok();
    });
    device.poll(wgpu::Maintain::Wait);
    rx.recv().unwrap().unwrap();
    let data = slice.get_mapped_range();
    let mut compact = Vec::with_capacity((WIDTH * HEIGHT * 4) as usize);
    let mut non_bg = 0usize;
    for y in 0..HEIGHT as usize {
        let row = &data[y * padded as usize..y * padded as usize + unpadded as usize];
        compact.extend_from_slice(row);
        for px in row.chunks_exact(4) {
            if !(px[0] < 25 && px[1] < 28 && px[2] < 32) {
                non_bg += 1;
            }
        }
    }
    drop(data);
    readback.unmap();
    fs::create_dir_all("../bench").unwrap();
    fs::write("../bench/offscreen.rgba", &compact).unwrap();
    println!("{{\"kind\":\"offscreen-render\",\"adapter\":{:?},\"backend\":\"{:?}\",\"width\":{WIDTH},\"height\":{HEIGHT},\"nonBackgroundPixels\":{non_bg},\"elapsedMs\":{:.3},\"raw\":\"../bench/offscreen.rgba\"}}", info.name, info.backend, started.elapsed().as_secs_f64()*1000.0);
}
