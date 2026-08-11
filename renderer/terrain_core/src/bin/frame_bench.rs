use quarterview_terrain_core::clipmap::{select_tiles_into, TileKey, ViewRequest};
use std::fs;
use std::time::Instant;

const FRAMES: usize = 10_000;
const WARMUP: usize = 1_000;

fn camera_at(i: usize) -> ViewRequest {
    let t = i as f64 / FRAMES as f64;
    let (center_x, center_z, ppc) = if i < 2_000 {
        (0.0, 0.0, 8.0)
    } else if i < 5_000 {
        let u = (i - 2_000) as f64 / 3_000.0;
        (-7000.0 + u * 14_000.0, -5000.0 + u * 10_000.0, 3.0)
    } else if i < 7_500 {
        (0.0, 0.0, 1600.0 / 16_384.0)
    } else {
        let u = (i - 7_500) as f64 / 2_500.0;
        let phase = (u * std::f64::consts::TAU).sin() * 0.5 + 0.5;
        let log_hi = 100.0f64.ln();
        let log_lo = (1600.0 / 16_384.0f64).ln();
        (
            500.0 * (t * 8.0).sin(),
            500.0 * (t * 6.0).cos(),
            (log_hi * phase + log_lo * (1.0 - phase)).exp(),
        )
    };
    let span_x = 1600.0 / ppc;
    // Conservative quarter-view expansion: screen vertical covers both world axes.
    let span_z = 900.0 * std::f64::consts::SQRT_2 / ppc;
    ViewRequest {
        center_x,
        center_z,
        span_x_cells: span_x,
        span_z_cells: span_z,
        pixels_per_cell: ppc,
        half_extent: 8192,
        prefetch_border: 1,
    }
}

fn hash_tiles(mut h: u64, tiles: &[TileKey]) -> u64 {
    for tile in tiles {
        for v in [tile.lod as u64, tile.x as u32 as u64, tile.z as u32 as u64] {
            h ^= v;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

fn run_path(measure: bool) -> (Vec<f64>, u64, usize) {
    let mut tiles = Vec::with_capacity(512);
    let mut times = if measure {
        Vec::with_capacity(FRAMES)
    } else {
        Vec::new()
    };
    let mut hash = 0xcbf29ce484222325u64;
    let mut max_tiles = 0usize;
    for i in 0..FRAMES {
        let view = camera_at(i);
        let started = Instant::now();
        select_tiles_into(view, &mut tiles);
        // This hash stands in for instance-command construction and, more importantly,
        // makes the benchmark consume every selected tile so the optimizer cannot elide it.
        hash = hash_tiles(hash, &tiles);
        if measure {
            times.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        max_tiles = max_tiles.max(tiles.len());
    }
    (times, hash, max_tiles)
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((sorted.len() - 1) as f64 * p).ceil() as usize;
    sorted[idx]
}

fn cpu_model() -> String {
    fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|line| line.strip_prefix("model name\t: ").map(str::to_owned))
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn main() {
    // Warm-up without reporting; repeat enough paths to stabilize branch/cache behaviour.
    for _ in 0..(WARMUP / FRAMES).max(1) {
        let _ = run_path(false);
    }

    let (mut times, hash1, max_tiles) = run_path(true);
    let (_, hash2, _) = run_path(false);
    times.sort_by(|a, b| a.total_cmp(b));
    let median = percentile(&times, 0.50);
    let p99 = percentile(&times, 0.99);
    let hitches = times.iter().filter(|&&ms| ms > 16.6).count();
    const HIST_BOUNDS: &[f64] = &[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0, 4.0, 8.3, 16.6];
    let mut histogram = vec![0usize; HIST_BOUNDS.len() + 1];
    for &ms in &times {
        let bucket = HIST_BOUNDS
            .iter()
            .position(|&upper| ms <= upper)
            .unwrap_or(HIST_BOUNDS.len());
        histogram[bucket] += 1;
    }
    let hist_bounds_json = HIST_BOUNDS
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let hist_counts_json = histogram
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let deterministic = hash1 == hash2;
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(0);
    let loadavg = fs::read_to_string("/proc/loadavg").unwrap_or_default();
    let loadavg = loadavg.trim().replace('"', "'");
    let cpu = cpu_model().replace('"', "'");

    println!(
        "{{\"kind\":\"cpu-frame-proto\",\"frames\":{FRAMES},\"medianMs\":{median:.6},\"p99Ms\":{p99:.6},\"hitchesOver16_6ms\":{hitches},\"histogram\":{{\"boundsMs\":[{hist_bounds_json}],\"counts\":[{hist_counts_json}]}},\"maxVisibleTiles\":{max_tiles},\"deterministic\":{deterministic},\"outputHash\":\"{hash1:016x}\",\"cpuModel\":\"{cpu}\",\"logicalCores\":{cores},\"loadavg\":\"{loadavg}\",\"passA1Proto\":{},\"passA7\":{},\"passA8\":{}}}",
        median <= 2.0 && p99 <= 4.0,
        hitches == 0,
        deterministic,
    );
}
