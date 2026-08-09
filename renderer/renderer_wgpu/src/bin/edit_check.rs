//! A3 回帰ゲート: 地形編集オーバーレイ(CornerDiffs)の正しさとCPU側処理コストを検証する。
//!
//! 正しさ: ランダムな編集集合を CPU リファレンス(override ?? base、
//! createEditedTerrainField の意味論そのまま)と、実際に GPU へ送る経路
//! (build_tile_overrides でタイル用に切り出し・ソート → tile_generate.wgsl の二分探索)の
//! 両方に適用し、影響ウィンドウ内の全コーナー高さを比較する。stride=1(LOD0)のタイルは
//! スナップ無しの厳密一致契約なので、ここでの不一致は0件が必須(renderer/bench/run-layer-a.mjs
//! の A3 ゲートが読む)。
//!
//! CPU側コスト: `set_corner_override_chunk` 相当(HashMapの構築+置き換え)の処理時間を
//! 1万回計測し、中央値/p99を出す(目標 ≤1ms、quarterview-renderer-spec.md の A3)。

use quarterview_renderer_wgpu::edits::{build_tile_overrides, OverrideChunks};
use quarterview_terrain_core::TerrainField;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Instant;
use wgpu::util::DeviceExt;

#[path = "bench_common/mod.rs"]
mod bench_common;

const GRID: u32 = 257;
const WORKGROUP: u32 = 256;
const SEED: u32 = 0x4242_4242;
const HALF_EXTENT: i32 = 8192;

fn push_u32(dst: &mut Vec<u8>, v: u32) {
    dst.extend_from_slice(&v.to_le_bytes());
}
fn push_i32(dst: &mut Vec<u8>, v: i32) {
    dst.extend_from_slice(&v.to_le_bytes());
}

/// 決定的な疑似乱数(xorshift32)。テストの再現性のため rand crate は使わない。
struct Rng(u32);
impl Rng {
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + (self.next_u32() % ((hi - lo) as u32)) as i32
    }
}

/// 1回の盛土/切土ストロークを模した、矩形+段差1以下の疑似的な編集を1件生成する。
/// 実際の applyCornerEdit の伝播アルゴリズムそのものは移植しない(TS側でユニットテスト済み)。
/// ここではオーバーライドの「疎な分布」を再現できれば十分。
fn random_edit_batch(
    rng: &mut Rng,
    origin_x: i32,
    origin_z: i32,
    count: usize,
) -> Vec<(i32, i32, u8)> {
    let mut out = Vec::with_capacity(count);
    let cx = origin_x + rng.range(-40, 40);
    let cz = origin_z + rng.range(-40, 40);
    for _ in 0..count {
        let x = cx + rng.range(-20, 20);
        let z = cz + rng.range(-20, 20);
        let h = (rng.next_u32() % 11) as u8;
        out.push((x, z, h));
    }
    out
}

fn apply_batch(overrides: &mut OverrideChunks, batch: &[(i32, i32, u8)]) {
    const CHUNK: i32 = quarterview_renderer_wgpu::edits::OVERLAY_CHUNK_SIZE;
    for &(x, z, h) in batch {
        let cx = x.div_euclid(CHUNK);
        let cz = z.div_euclid(CHUNK);
        let lx = x.rem_euclid(CHUNK) as u32;
        let lz = z.rem_euclid(CHUNK) as u32;
        let local_index = lx * CHUNK as u32 + lz;
        overrides
            .entry((cx, cz))
            .or_default()
            .insert(local_index, h);
    }
}

fn expected_height(field: &TerrainField, overrides: &OverrideChunks, x: i32, z: i32) -> u8 {
    const CHUNK: i32 = quarterview_renderer_wgpu::edits::OVERLAY_CHUNK_SIZE;
    let cx = x.div_euclid(CHUNK);
    let cz = z.div_euclid(CHUNK);
    let lx = x.rem_euclid(CHUNK) as u32;
    let lz = z.rem_euclid(CHUNK) as u32;
    let local_index = lx * CHUNK as u32 + lz;
    if let Some(chunk) = overrides.get(&(cx, cz)) {
        if let Some(&h) = chunk.get(&local_index) {
            return h;
        }
    }
    field.corner_height_at(x, z)
}

fn main() {
    let field = TerrainField::new(SEED, HALF_EXTENT);

    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: bench_common::select_backends(),
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
            label: Some("edit-check"),
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

    // 5つのタイル(すべて stride=1/LOD0。LOD一貫性規則の「厳密一致」契約はここでのみ検証する)
    // へ、それぞれ異なるランダム編集集合を適用して比較する。
    let cases: [(i32, i32); 5] = [
        (-128, -128),
        (0, 0),
        (4096, -2048),
        (-8192, 0),
        (8000, 8000),
    ];
    let mut rng = Rng(0x1234_5678);
    let mut total_mismatches = 0usize;
    let mut total_points = 0usize;
    let mut overrides: OverrideChunks = HashMap::new();
    let total_started = Instant::now();

    for &(origin_x, origin_z) in &cases {
        let stride = 1i32;
        let batch = random_edit_batch(&mut rng, origin_x, origin_z, 300);
        apply_batch(&mut overrides, &batch);

        let entries = build_tile_overrides(&overrides, origin_x, origin_z, stride, GRID as i32);
        let override_count = (entries.len() / 2) as u32;
        let overrides_bytes: Vec<u8> = if entries.is_empty() {
            vec![0u8; 8]
        } else {
            entries.iter().flat_map(|v| v.to_le_bytes()).collect()
        };
        let overrides_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("edit-check-overrides"),
            contents: &overrides_bytes,
            usage: wgpu::BufferUsages::STORAGE,
        });

        let mut params = Vec::with_capacity(32);
        push_u32(&mut params, SEED);
        push_i32(&mut params, HALF_EXTENT);
        push_i32(&mut params, origin_x);
        push_i32(&mut params, origin_z);
        push_i32(&mut params, stride);
        push_u32(&mut params, GRID);
        push_u32(&mut params, override_count);
        push_u32(&mut params, 0);
        // TileParams のしきい値(プロファイル別)。この検査は歴史的既定(Normal)を使う。
        for word in quarterview_terrain_core::TerrainProfile::Normal.threshold_words() {
            push_u32(&mut params, word);
        }
        let params_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("edit-check-params"),
            contents: &params,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("edit-check-bg"),
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
            label: Some("edit-check-encoder"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("edit-check-pass"),
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
                let x = origin_x + lx as i32 * stride;
                let z = origin_z + lz as i32 * stride;
                let expected = expected_height(&field, &overrides, x, z);
                if actual != expected {
                    mismatches += 1;
                }
            }
        }
        drop(data);
        readback.unmap();
        total_mismatches += mismatches;
        total_points += (GRID * GRID) as usize;
        println!(
            "tile origin=({origin_x},{origin_z}) overrides={override_count} mismatches={mismatches}"
        );
    }

    // A3タイミング: set_corner_override_chunk 相当(HashMap構築+チャンク差し替え)の
    // CPU側コストを1万回計測する。典型的な1回の盛土/切土(300コーナー)を想定。
    let mut samples = Vec::with_capacity(10_000);
    let mut bench_rng = Rng(0xdead_beef);
    for _ in 0..10_000 {
        let batch = random_edit_batch(&mut bench_rng, 0, 0, 300);
        let started = Instant::now();
        let mut chunk: HashMap<u32, u8> = HashMap::with_capacity(batch.len());
        for &(x, z, h) in &batch {
            const CHUNK: i32 = quarterview_renderer_wgpu::edits::OVERLAY_CHUNK_SIZE;
            let lx = x.rem_euclid(CHUNK) as u32;
            let lz = z.rem_euclid(CHUNK) as u32;
            chunk.insert(lx * CHUNK as u32 + lz, h);
        }
        let mut store: OverrideChunks = HashMap::new();
        store.insert((0, 0), chunk);
        let _ = build_tile_overrides(&store, 0, 0, 1, GRID as i32);
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.total_cmp(b));
    let median = samples[samples.len() / 2];
    let p99 = samples[((samples.len() as f64 * 0.99).ceil() as usize).min(samples.len() - 1)];

    let pass_correctness = total_mismatches == 0;
    let pass_timing = median <= 1.0;
    println!(
        "{{\"kind\":\"edit-overlay-check\",\"adapter\":{:?},\"backend\":\"{:?}\",\"tilesChecked\":{},\"pointsChecked\":{},\"mismatches\":{},\"cpuDiffMedianMs\":{:.6},\"cpuDiffP99Ms\":{:.6},\"passA3Correctness\":{},\"passA3Timing\":{},\"elapsedMs\":{:.3}}}",
        info.name, info.backend, cases.len(), total_points, total_mismatches,
        median, p99, pass_correctness, pass_timing, total_started.elapsed().as_secs_f64() * 1000.0
    );
    if total_mismatches != 0 {
        std::process::exit(1);
    }
}
