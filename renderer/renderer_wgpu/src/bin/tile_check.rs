use quarterview_terrain_core::TerrainField;
use std::sync::mpsc;
use std::time::Instant;
use wgpu::util::DeviceExt;

const GRID: u32 = 257;
const WORKGROUP: u32 = 256;

fn push_u32(dst: &mut Vec<u8>, v: u32) {
    dst.extend_from_slice(&v.to_le_bytes());
}
fn push_i32(dst: &mut Vec<u8>, v: i32) {
    dst.extend_from_slice(&v.to_le_bytes());
}

fn main() {
    let seed = 0x1234_5678u32;
    let half_extent = 8192i32;
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..Default::default()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        force_fallback_adapter: false,
    }))
    .expect("adapter");
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("tile-check"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::Performance,
        },
        None,
    ))
    .expect("device");

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("tile-generate"),
        source: wgpu::ShaderSource::Wgsl(include_str!("../../shaders/tile_generate.wgsl").into()),
    });
    let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("tile-layout"),
        bind_group_layouts: &[&bgl],
        push_constant_ranges: &[],
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("tile-pipeline"),
        layout: Some(&layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let output_size = (GRID as u64) * (GRID as u64) * 4;
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("tile-output"),
        size: output_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("tile-readback"),
        size: output_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let overrides_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("tile-overrides"),
        contents: &[0u8; 8],
        usage: wgpu::BufferUsages::STORAGE,
    });

    let cases = [
        (-8192, -8192, 1),
        (-4096, 2048, 1),
        (-2048, -1024, 2),
        (0, 0, 8),
        (-8192, 0, 16),
        (-8192, -8192, 64),
    ];
    let field = TerrainField::new(seed, half_extent);
    let mut total_mismatches = 0usize;
    let total_started = Instant::now();

    for &(origin_x, origin_z, stride) in &cases {
        let mut params = Vec::with_capacity(32);
        push_u32(&mut params, seed);
        push_i32(&mut params, half_extent);
        push_i32(&mut params, origin_x);
        push_i32(&mut params, origin_z);
        push_i32(&mut params, stride);
        push_u32(&mut params, GRID);
        push_u32(&mut params, 0);
        push_u32(&mut params, 0);
        let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("tile-params"),
            contents: &params,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("tile-bg"),
            layout: &bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: output.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: overrides_buf.as_entire_binding(),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("tile-encoder"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("tile-pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups((GRID * GRID + WORKGROUP - 1) / WORKGROUP, 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, output_size);
        queue.submit(Some(encoder.finish()));
        let slice = readback.slice(..);
        let (tx, rx) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            tx.send(r).ok();
        });
        device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();
        let data = slice.get_mapped_range();
        let mut mismatches = 0usize;
        for lx in 0..GRID as usize {
            for lz in 0..GRID as usize {
                let idx = lx * GRID as usize + lz;
                let packed = u32::from_le_bytes(data[idx * 4..idx * 4 + 4].try_into().unwrap());
                let actual = (packed & 0xff) as u8;
                let actual_water = ((packed >> 8) & 1) != 0;
                let x = origin_x + lx as i32 * stride;
                let z = origin_z + lz as i32 * stride;
                let expected = field.corner_height_at(x, z);
                let expected_water = field.is_water_vertex(x, z);
                if actual != expected || actual_water != expected_water {
                    mismatches += 1;
                }
            }
        }
        drop(data);
        readback.unmap();
        total_mismatches += mismatches;
        println!("tile origin=({origin_x},{origin_z}) stride={stride} mismatches={mismatches}");
    }

    // CPU command-recording cost: reuse resources and measure only encoder/pass/dispatch/finish.
    let mut params = Vec::with_capacity(32);
    push_u32(&mut params, seed);
    push_i32(&mut params, half_extent);
    push_i32(&mut params, 0);
    push_i32(&mut params, 0);
    push_i32(&mut params, 1);
    push_u32(&mut params, GRID);
    push_u32(&mut params, 0);
    push_u32(&mut params, 0);
    let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("bench-params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("bench-bg"),
        layout: &bgl,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: params_buf.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: output.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: overrides_buf.as_entire_binding(),
            },
        ],
    });
    let mut samples = Vec::with_capacity(10_000);
    for _ in 0..10_000 {
        let started = Instant::now();
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups((GRID * GRID + WORKGROUP - 1) / WORKGROUP, 1, 1);
        }
        let _commands = encoder.finish();
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.total_cmp(b));
    let median = samples[samples.len() / 2];
    let p99 = samples[((samples.len() as f64 * 0.99).ceil() as usize).min(samples.len() - 1)];
    println!(
        "{{\"kind\":\"tile-generate-check\",\"adapter\":{:?},\"backend\":\"{:?}\",\"tilesChecked\":{},\"pointsChecked\":{},\"mismatches\":{},\"cpuIssueMedianMs\":{:.6},\"cpuIssueP99Ms\":{:.6},\"passA2\":{},\"elapsedMs\":{:.3}}}",
        info.name, info.backend, cases.len(), cases.len() * GRID as usize * GRID as usize,
        total_mismatches, median, p99, median <= 0.3, total_started.elapsed().as_secs_f64()*1000.0
    );
    if total_mismatches != 0 {
        std::process::exit(1);
    }
}
