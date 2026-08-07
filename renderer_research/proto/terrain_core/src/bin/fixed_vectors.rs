use quarterview_terrain_core::{composite_noise_fixed, TerrainField};

fn main() {
    let seeds = [0u32, 1, 0x1234_5678, 0xdead_beef, 0xffff_ffff];
    let mut out = String::from("[\n");
    let mut count = 0usize;
    for (si, seed) in seeds.into_iter().enumerate() {
        for j in 0..200u32 {
            let x = if j < 4 {
                [-8192, -1, 0, 8192][j as usize]
            } else {
                (((j as i32 + 1) * 7919 + si as i32 * 104729) & 0x3fff) - 8192
            };
            let z = if j < 4 {
                [-8192, 0, 1, 8192][j as usize]
            } else {
                (((j as i32 + 1) * 104729 + si as i32 * 3571) & 0x3fff) - 8192
            };
            let n = composite_noise_fixed(seed, x, z).as_u64();
            let field = TerrainField::new(seed, 8192);
            let h = field.corner_height_at(x, z);
            let water = field.is_water_vertex(x, z);
            if count != 0 { out.push_str(",\n"); }
            out.push_str(&format!("  {{\"seed\":{},\"x\":{},\"z\":{},\"noiseNumHi\":{},\"noiseNumLo\":{},\"height\":{},\"water\":{}}}", seed, x, z, n >> 32, n as u32, h, water));
            count += 1;
        }
    }
    out.push_str("\n]\n");
    print!("{out}");
}
