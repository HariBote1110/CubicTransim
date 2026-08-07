use quarterview_terrain_core::TerrainField;
use std::env;

fn main() {
    let mut args = env::args().skip(1);
    let seed: u32 = args
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x1234_5678);
    let count: usize = args
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1_000_000);
    let half_extent: i32 = args.next().and_then(|v| v.parse().ok()).unwrap_or(8192);

    let field = TerrainField::new(seed, half_extent);
    let mut state = 0x6d2b_79f5u32;
    let mut checksum = 0x811c_9dc5u32;
    let span = (half_extent * 2 + 1) as u32;

    for _ in 0..count {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let x = (state % span) as i32 - half_extent;
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let z = (state % span) as i32 - half_extent;
        let h = field.corner_height_at(x, z);
        checksum ^= h as u32;
        checksum = checksum.wrapping_mul(16_777_619);
    }

    println!("{{\"seed\":{seed},\"count\":{count},\"halfExtent\":{half_extent},\"checksum\":{checksum}}}");
}
