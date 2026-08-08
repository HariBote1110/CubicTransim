use quarterview_terrain_core::TerrainField;
use std::sync::mpsc;
use std::time::Instant;
use wgpu::util::DeviceExt;

const WORKGROUP: u32 = 256;

fn push_u32(dst: &mut Vec<u8>, value: u32) {
    dst.extend_from_slice(&value.to_le_bytes());
}

fn push_i32(dst: &mut Vec<u8>, value: i32) {
    dst.extend_from_slice(&value.to_le_bytes());
}

fn sample_positions(count: usize, half_extent: i32) -> Vec<(i32, i32)> {
    let mut state = 0x6d2b_79f5u32;
    let span = (half_extent * 2 + 1) as u32;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let x = (state % span) as i32 - half_extent;
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let z = (state % span) as i32 - half_extent;
        out.push((x, z));
    }
    out
}

fn main() {
    let mut args = std::env::args().skip(1);
    let seed: u32 = args
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x1234_5678);
    let count: usize = args
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_000_000);
    let half_extent: i32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(8192);

    if count == 0 || count > u32::MAX as usize {
        eprintln!("count must be in 1..=u32::MAX");
        std::process::exit(2);
    }

    let positions = sample_positions(count, half_extent);
    let field = TerrainField::new(seed, half_extent);
    let expected: Vec<u8> = positions
        .iter()
        .map(|&(x, z)| field.corner_height_at(x, z))
        .collect();

    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..Default::default()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))
    .expect("no wgpu adapter available");
    let info = adapter.get_info();
    eprintln!(
        "adapter: name={:?} backend={:?} type={:?}",
        info.name, info.backend, info.device_type
    );

    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("noise-check-device"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .expect("request_device failed");

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("terrain-noise"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/terrain_noise.wgsl").into()),
    });

    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("noise-bgl"),
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
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("noise-pipeline-layout"),
        bind_group_layouts: &[&bind_group_layout],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("noise-pipeline"),
        layout: Some(&pipeline_layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let mut params_bytes = Vec::with_capacity(16);
    push_u32(&mut params_bytes, seed);
    push_i32(&mut params_bytes, half_extent);
    push_u32(&mut params_bytes, count as u32);
    push_u32(&mut params_bytes, 0);
    let params_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("params"),
        contents: &params_bytes,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let mut position_bytes = Vec::with_capacity(count * 8);
    for &(x, z) in &positions {
        push_i32(&mut position_bytes, x);
        push_i32(&mut position_bytes, z);
    }
    let positions_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("positions"),
        contents: &position_bytes,
        usage: wgpu::BufferUsages::STORAGE,
    });

    let output_size = (count * 4) as wgpu::BufferAddress;
    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("heights"),
        size: output_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: output_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("noise-bg"),
        layout: &bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: positions_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output_buffer.as_entire_binding(),
            },
        ],
    });

    let started = Instant::now();
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("noise-encoder"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("noise-pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups((count as u32 + WORKGROUP - 1) / WORKGROUP, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output_buffer, 0, &readback, 0, output_size);
    queue.submit(Some(encoder.finish()));

    let slice = readback.slice(..);
    let (tx, rx) = mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).ok();
    });
    device.poll(wgpu::Maintain::Wait);
    rx.recv()
        .expect("map callback dropped")
        .expect("map failed");
    let elapsed = started.elapsed();

    let data = slice.get_mapped_range();
    let mut mismatch_count = 0usize;
    let mut first = Vec::new();
    for i in 0..count {
        let base = i * 4;
        let actual = u32::from_le_bytes(data[base..base + 4].try_into().unwrap()) as u8;
        if actual != expected[i] {
            mismatch_count += 1;
            if first.len() < 12 {
                let (x, z) = positions[i];
                first.push((i, x, z, expected[i], actual));
            }
        }
    }
    drop(data);
    readback.unmap();

    println!(
        "{{\"seed\":{seed},\"count\":{count},\"halfExtent\":{half_extent},\"mismatches\":{mismatch_count},\"elapsedMs\":{:.3},\"adapter\":{:?},\"backend\":\"{:?}\"}}",
        elapsed.as_secs_f64() * 1000.0,
        info.name,
        info.backend
    );
    for (i, x, z, e, a) in first {
        eprintln!("mismatch i={i} pos=({x},{z}) expected={e} actual={a}");
    }
    if mismatch_count != 0 {
        std::process::exit(1);
    }
}
