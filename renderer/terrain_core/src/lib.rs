pub mod clipmap;

pub const TERRAIN_HEIGHT_MAX: u8 = 10;
pub const MOUNTAIN_HEIGHT_THRESHOLD: u8 = 1;

const NOISE_OCTAVES: [(i32, u32); 4] = [(40, 8), (20, 4), (10, 2), (5, 1)];
const FIXED_ONE: u64 = 1u64 << 32;
const WATER_NUM_MAX: u64 = 9 * (FIXED_ONE / 4); // 0.15 * (15 * 2^32) = 9 * 2^30

/// Upper bound on |ΔN| between adjacent corners (see src/sim/canonicalNoise.ts for the
/// construction argument): each octave is a u32 lattice hash interpolated with a smoothstep
/// whose maximum slope is 1.5/wave, so |ΔN| <= (2^32-1) * 1.5 * (8/40+4/20+2/10+1/5)
/// = (2^32-1) * 1.2 < 1.2 * 2^32, plus at most 64 for the integer rounding. A profile whose
/// threshold spacing is >= this bound cannot produce an adjacent corner step of 2 or more.
pub const ADJACENT_NUM_BOUND: u64 = 5_153_960_820;

/// Terrain profile chosen at new-game time. Only the height threshold table changes;
/// the hashes, octaves and composite numerator N are identical for every profile, so the
/// canonical byte-exactness corpus (TS / Rust / WGSL) stays valid across profiles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TerrainProfile {
    /// Wide plains, hills are rare.
    Flat,
    /// Historic default (the canonical document's table).
    #[default]
    Normal,
    /// Much more land raised, denser relief (spacing compressed close to ADJACENT_NUM_BOUND).
    Mountain,
}

const HEIGHT_THRESHOLDS_FLAT: [u64; 10] = [
    43_486_543_872,
    51_286_543_872,
    59_086_543_872,
    66_886_543_872,
    74_686_543_872,
    82_486_543_872,
    90_286_543_872,
    98_086_543_872,
    105_886_543_872,
    113_686_543_872,
];

const HEIGHT_THRESHOLDS: [u64; 10] = [
    35_433_480_192,
    41_290_253_778,
    47_147_027_363,
    53_003_800_949,
    58_860_574_534,
    64_717_348_120,
    70_574_121_705,
    76_430_895_291,
    82_287_668_876,
    88_144_442_462,
];

const HEIGHT_THRESHOLDS_MOUNTAIN: [u64; 10] = [
    28_991_029_248,
    34_191_029_248,
    39_391_029_248,
    44_591_029_248,
    49_791_029_248,
    54_991_029_248,
    60_191_029_248,
    65_391_029_248,
    70_591_029_248,
    75_791_029_248,
];

impl TerrainProfile {
    pub const ALL: [TerrainProfile; 3] = [
        TerrainProfile::Flat,
        TerrainProfile::Normal,
        TerrainProfile::Mountain,
    ];

    pub const fn thresholds(self) -> [u64; 10] {
        match self {
            TerrainProfile::Flat => HEIGHT_THRESHOLDS_FLAT,
            TerrainProfile::Normal => HEIGHT_THRESHOLDS,
            TerrainProfile::Mountain => HEIGHT_THRESHOLDS_MOUNTAIN,
        }
    }

    /// Stable index used by the params uniform and the CLI/JS boundary. Unknown values map to Normal.
    pub const fn from_index(index: u32) -> Self {
        match index {
            0 => TerrainProfile::Flat,
            2 => TerrainProfile::Mountain,
            _ => TerrainProfile::Normal,
        }
    }

    pub const fn index(self) -> u32 {
        match self {
            TerrainProfile::Flat => 0,
            TerrainProfile::Normal => 1,
            TerrainProfile::Mountain => 2,
        }
    }

    /// Parses the TypeScript-side profile name. Unknown names fall back to Normal.
    pub fn from_name(name: &str) -> Self {
        match name {
            "flat" => TerrainProfile::Flat,
            "mountain" => TerrainProfile::Mountain,
            _ => TerrainProfile::Normal,
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            TerrainProfile::Flat => "flat",
            TerrainProfile::Normal => "normal",
            TerrainProfile::Mountain => "mountain",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerrainKind {
    Grass,
    Mountain,
    Water,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedNoiseNum {
    /// Numerator over the canonical denominator 15 * 2^32.
    pub hi: u32,
    pub lo: u32,
}

impl FixedNoiseNum {
    #[inline]
    pub const fn as_u64(self) -> u64 { ((self.hi as u64) << 32) | self.lo as u64 }
}

#[derive(Debug, Clone, Copy)]
pub struct TerrainField {
    seed: u32,
    half_extent: i32,
    profile: TerrainProfile,
}

impl TerrainField {
    /// Historic default profile (Normal).
    pub const fn new(seed: u32, half_extent: i32) -> Self {
        Self { seed, half_extent, profile: TerrainProfile::Normal }
    }

    pub const fn with_profile(seed: u32, half_extent: i32, profile: TerrainProfile) -> Self {
        Self { seed, half_extent, profile }
    }

    pub const fn profile(&self) -> TerrainProfile { self.profile }

    #[inline]
    fn in_range(&self, v: i32) -> bool { v >= -self.half_extent && v <= self.half_extent }

    #[inline]
    pub fn corner_height_at(&self, x: i32, z: i32) -> u8 {
        if !self.in_range(x) || !self.in_range(z) { return 0; }
        let noise_num = composite_noise_fixed(self.seed, x, z).as_u64();
        if noise_num < WATER_NUM_MAX { return 0; }
        let mut h = 0u8;
        for (i, threshold) in self.profile.thresholds().iter().enumerate() {
            if noise_num >= *threshold { h = (i + 1) as u8; } else { break; }
        }
        h.min(TERRAIN_HEIGHT_MAX)
    }

    #[inline]
    pub fn is_water_vertex(&self, x: i32, z: i32) -> bool {
        self.in_range(x) && self.in_range(z) && composite_noise_fixed(self.seed, x, z).as_u64() < WATER_NUM_MAX
    }

    pub fn cell_corner_heights(&self, x: i32, z: i32) -> [u8; 4] {
        [self.corner_height_at(x, z), self.corner_height_at(x + 1, z), self.corner_height_at(x, z + 1), self.corner_height_at(x + 1, z + 1)]
    }

    pub fn cell_height_at(&self, x: i32, z: i32) -> u8 {
        self.cell_corner_heights(x, z).into_iter().min().unwrap_or(0)
    }

    pub fn terrain_type_at(&self, x: i32, z: i32) -> TerrainKind {
        if self.is_water_vertex(x, z)
            && self.is_water_vertex(x + 1, z)
            && self.is_water_vertex(x, z + 1)
            && self.is_water_vertex(x + 1, z + 1)
        {
            TerrainKind::Water
        } else if self.cell_height_at(x, z) >= MOUNTAIN_HEIGHT_THRESHOLD {
            TerrainKind::Mountain
        } else {
            TerrainKind::Grass
        }
    }

    pub fn corner_grid_for(&self, x0: i32, z0: i32, w: usize, h: usize) -> Vec<u8> {
        let gh = h + 1;
        let mut out = vec![0; (w + 1) * gh];
        for lx in 0..=w {
            for lz in 0..=h { out[lx * gh + lz] = self.corner_height_at(x0 + lx as i32, z0 + lz as i32); }
        }
        out
    }
}

#[inline]
fn mul_u32(a: u32, b: u32) -> u64 { (a as u64) * (b as u64) }

#[inline]
fn hash_lattice(seed: u32, x: i32, z: i32) -> u32 {
    let mut h = seed ^ (x as u32).wrapping_mul(374_761_393) ^ (z as u32).wrapping_mul(668_265_263);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^ (h >> 16)
}

#[inline]
fn derive_octave_seed(seed: u32, index: usize) -> u32 {
    let mut h = seed ^ ((index as u32 + 1).wrapping_mul(0x9e37_79b9));
    h = (h ^ (h >> 15)).wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

/// Canonical smoothstep in Q32.32. The rational form is exact for integer x/wave:
/// r²(3−2r) = r_num²(3w−2r_num)/w³. Round half-up to the fixed grid.
#[inline]
fn smooth_q(x: i32, wave: i32) -> (i32, u32) {
    let mut grid = x.div_euclid(wave);
    let rem = x.rem_euclid(wave);
    if rem == wave { grid += 1; }
    let r = rem as u64;
    let w = wave as u64;
    let n = r * r * (3 * w - 2 * r);
    let d = w * w * w;
    let q = (n * FIXED_ONE + d / 2) / d;
    (grid, q.min(u32::MAX as u64) as u32)
}

#[inline]
fn lerp_q(a: u32, b: u32, t: u32) -> u32 {
    if b >= a {
        a.saturating_add((mul_u32(b - a, t) >> 32) as u32)
    } else {
        a.saturating_sub((mul_u32(a - b, t) >> 32) as u32)
    }
}

#[inline]
fn value_noise_fixed(seed: u32, x: i32, z: i32, wave: i32) -> u32 {
    let (gx, tx) = smooth_q(x, wave);
    let (gz, tz) = smooth_q(z, wave);
    let v00 = hash_lattice(seed, gx, gz);
    let v10 = hash_lattice(seed, gx + 1, gz);
    let v01 = hash_lattice(seed, gx, gz + 1);
    let v11 = hash_lattice(seed, gx + 1, gz + 1);
    let top = lerp_q(v00, v10, tx);
    let bottom = lerp_q(v01, v11, tx);
    lerp_q(top, bottom, tz)
}

/// Returns N = 8*q0 + 4*q1 + 2*q2 + q3, where each qi is Q0.32.
/// Canonical normalized noise is N / (15 * 2^32).
pub fn composite_noise_fixed(seed: u32, x: i32, z: i32) -> FixedNoiseNum {
    let mut n = 0u64;
    for (i, (wave, weight)) in NOISE_OCTAVES.iter().copied().enumerate() {
        n += mul_u32(value_noise_fixed(derive_octave_seed(seed, i), x, z, wave), weight);
    }
    FixedNoiseNum { hi: (n >> 32) as u32, lo: n as u32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_large_sample() {
        let a = TerrainField::new(0x1234_5678, 8192);
        let b = TerrainField::new(0x1234_5678, 8192);
        for i in 0..100_000i32 {
            let x = ((i.wrapping_mul(7919)) & 0x3fff) - 8192;
            let z = ((i.wrapping_mul(104729)) & 0x3fff) - 8192;
            assert_eq!(a.corner_height_at(x, z), b.corner_height_at(x, z));
        }
    }

    #[test]
    fn adjacent_corner_delta_never_exceeds_one() {
        let field = TerrainField::new(0x5eed_cafe, 8192);
        for i in 0..250_000i32 {
            let x = ((i.wrapping_mul(3571)) & 0x3fff) - 8192;
            let z = ((i.wrapping_mul(2371)) & 0x3fff) - 8192;
            let h = field.corner_height_at(x, z) as i16;
            let hx = field.corner_height_at(x + 1, z) as i16;
            let hz = field.corner_height_at(x, z + 1) as i16;
            assert!((h - hx).abs() <= 1, "x delta > 1 at ({x},{z}): {h} -> {hx}");
            assert!((h - hz).abs() <= 1, "z delta > 1 at ({x},{z}): {h} -> {hz}");
        }
    }

    #[test]
    fn out_of_range_is_safe_flat_ground() {
        let field = TerrainField::new(1, 45);
        assert_eq!(field.corner_height_at(46, 0), 0);
        assert_eq!(field.corner_height_at(0, -46), 0);
        assert!(!field.is_water_vertex(46, 0));
        assert_eq!(field.terrain_type_at(46, 0), TerrainKind::Grass);
    }

    #[test]
    fn canonical_thresholds_are_monotonic() {
        for pair in HEIGHT_THRESHOLDS.windows(2) { assert!(pair[0] < pair[1]); }
        assert!(WATER_NUM_MAX < HEIGHT_THRESHOLDS[0]);
    }

    #[test]
    fn every_profile_table_is_monotonic_and_respects_the_lipschitz_bound() {
        for profile in TerrainProfile::ALL {
            let table = profile.thresholds();
            for pair in table.windows(2) {
                assert!(pair[0] < pair[1], "{profile:?} not monotonic");
                assert!(
                    pair[1] - pair[0] >= ADJACENT_NUM_BOUND,
                    "{profile:?} spacing {} < bound {ADJACENT_NUM_BOUND}",
                    pair[1] - pair[0]
                );
            }
            // Water can never sit on a raised corner.
            assert!(WATER_NUM_MAX < table[0], "{profile:?} h1 threshold below water");
        }
    }

    #[test]
    fn profiles_are_ordered_flat_le_normal_le_mountain() {
        let flat = TerrainField::with_profile(0x5eed_cafe, 8192, TerrainProfile::Flat);
        let normal = TerrainField::with_profile(0x5eed_cafe, 8192, TerrainProfile::Normal);
        let mountain = TerrainField::with_profile(0x5eed_cafe, 8192, TerrainProfile::Mountain);
        let mut raised = [0usize; 3];
        for i in 0..50_000i32 {
            let x = ((i.wrapping_mul(3571)) & 0x3fff) - 8192;
            let z = ((i.wrapping_mul(2371)) & 0x3fff) - 8192;
            let (f, n, m) = (
                flat.corner_height_at(x, z),
                normal.corner_height_at(x, z),
                mountain.corner_height_at(x, z),
            );
            assert!(f <= n && n <= m, "profile order broken at ({x},{z}): {f} {n} {m}");
            if f > 0 { raised[0] += 1; }
            if n > 0 { raised[1] += 1; }
            if m > 0 { raised[2] += 1; }
        }
        assert!(raised[0] < raised[1] && raised[1] < raised[2], "raised counts: {raised:?}");
    }

    #[test]
    fn adjacent_corner_delta_never_exceeds_one_for_every_profile() {
        for profile in TerrainProfile::ALL {
            let field = TerrainField::with_profile(0x5eed_cafe, 8192, profile);
            for i in 0..250_000i32 {
                let x = ((i.wrapping_mul(3571)) & 0x3fff) - 8192;
                let z = ((i.wrapping_mul(2371)) & 0x3fff) - 8192;
                let h = field.corner_height_at(x, z) as i16;
                let hx = field.corner_height_at(x + 1, z) as i16;
                let hz = field.corner_height_at(x, z + 1) as i16;
                assert!((h - hx).abs() <= 1, "{profile:?} x delta > 1 at ({x},{z})");
                assert!((h - hz).abs() <= 1, "{profile:?} z delta > 1 at ({x},{z})");
            }
        }
    }

    #[test]
    fn profile_names_and_indices_round_trip() {
        for profile in TerrainProfile::ALL {
            assert_eq!(TerrainProfile::from_index(profile.index()), profile);
            assert_eq!(TerrainProfile::from_name(profile.name()), profile);
        }
        assert_eq!(TerrainProfile::from_index(99), TerrainProfile::Normal);
        assert_eq!(TerrainProfile::from_name("nonsense"), TerrainProfile::Normal);
    }
}
