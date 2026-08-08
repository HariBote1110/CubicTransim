struct Params {
  seed: u32,
  half_extent: i32,
  count: u32,
  _pad: u32,
};

struct U64 { hi: u32, lo: u32 };

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<vec2<i32>>;
@group(0) @binding(2) var<storage, read_write> heights: array<u32>;

const FIXED_ONE_HI: u32 = 1u;
const FIXED_ONE_LO: u32 = 0u;

fn u64_add(a: U64, b: U64) -> U64 {
  let lo = a.lo + b.lo;
  let carry = select(0u, 1u, lo < a.lo);
  return U64(a.hi + b.hi + carry, lo);
}

fn u64_mul_u32(a: u32, b: u32) -> U64 {
  let a0 = a & 0xffffu;
  let a1 = a >> 16u;
  let b0 = b & 0xffffu;
  let b1 = b >> 16u;
  let p0 = a0 * b0;
  let p1 = a0 * b1;
  let p2 = a1 * b0;
  let p3 = a1 * b1;
  let mid = (p0 >> 16u) + (p1 & 0xffffu) + (p2 & 0xffffu);
  let lo = (p0 & 0xffffu) | ((mid & 0xffffu) << 16u);
  let hi = p3 + (p1 >> 16u) + (p2 >> 16u) + (mid >> 16u);
  return U64(hi, lo);
}

fn u64_mul_small(a: U64, b: u32) -> U64 {
  let lo_prod = u64_mul_u32(a.lo, b);
  return U64(a.hi * b + lo_prod.hi, lo_prod.lo);
}

fn u64_cmp(a: U64, b: U64) -> i32 {
  if (a.hi < b.hi || (a.hi == b.hi && a.lo < b.lo)) { return -1; }
  if (a.hi > b.hi || (a.hi == b.hi && a.lo > b.lo)) { return 1; }
  return 0;
}

fn u64_div_u32(n: U64, d: u32) -> U64 {
  var rem = 0u;
  var q_hi = 0u;
  var q_lo = 0u;
  for (var i: i32 = 63; i >= 0; i = i - 1) {
    var bit = 0u;
    if (i >= 32) { bit = (n.hi >> u32(i - 32)) & 1u; } else { bit = (n.lo >> u32(i)) & 1u; }
    rem = rem * 2u + bit;
    if (rem >= d) {
      rem = rem - d;
      if (i >= 32) { q_hi = q_hi | (1u << u32(i - 32)); }
      else { q_lo = q_lo | (1u << u32(i)); }
    }
  }
  return U64(q_hi, q_lo);
}

fn smooth_q(x:i32,wave:i32)->vec2<u32>{
 let trunc_q=x/wave; let trunc_r=x%wave; let grid=trunc_q-select(0,1,x<0&&trunc_r!=0);
 let rem=u32(x-grid*wave); let w=u32(wave); let n=(rem*rem)*(3u*w-2u*rem); let d=w*w*w;
 let coarse=(n*65536u)/d; let rem2=n*65536u-coarse*d; let low=((rem2*65536u)+d/2u)/d;
 return vec2<u32>(u32(grid),(coarse<<16u)|low);
}
fn hash_bits(seed: u32, x: i32, z: i32) -> u32 {
  var h = seed ^ (u32(x) * 374761393u) ^ (u32(z) * 668265263u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return h;
}

fn derive_octave_seed(seed: u32, index: u32) -> u32 {
  var h = seed ^ ((index + 1u) * 0x9e3779b9u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = h ^ (h >> 13u);
  h = h * 0xc2b2ae35u;
  h = h ^ (h >> 16u);
  return h;
}

fn lerp_q(a: u32, b: u32, t: u32) -> u32 {
  if (b >= a) { return a + u64_mul_u32(b - a, t).hi; }
  return a - u64_mul_u32(a - b, t).hi;
}

fn value_noise_fixed(seed: u32, x: i32, z: i32, wave: i32) -> u32 {
  let sx = smooth_q(x, wave);
  let sz = smooth_q(z, wave);
  let v00 = hash_bits(seed, i32(sx.x), i32(sz.x));
  let v10 = hash_bits(seed, i32(sx.x) + 1, i32(sz.x));
  let v01 = hash_bits(seed, i32(sx.x), i32(sz.x) + 1);
  let v11 = hash_bits(seed, i32(sx.x) + 1, i32(sz.x) + 1);
  let top = lerp_q(v00, v10, sx.y);
  let bottom = lerp_q(v01, v11, sx.y);
  return lerp_q(top, bottom, sz.y);
}

fn composite_num(seed: u32, x: i32, z: i32) -> U64 {
  var n = U64(0u, 0u);
  n = u64_add(n, u64_mul_small(U64(0u, value_noise_fixed(derive_octave_seed(seed, 0u), x, z, 40)), 8u));
  n = u64_add(n, u64_mul_small(U64(0u, value_noise_fixed(derive_octave_seed(seed, 1u), x, z, 20)), 4u));
  n = u64_add(n, u64_mul_small(U64(0u, value_noise_fixed(derive_octave_seed(seed, 2u), x, z, 10)), 2u));
  n = u64_add(n, U64(0u, value_noise_fixed(derive_octave_seed(seed, 3u), x, z, 5)));
  return n;
}

fn height_from_num(n: U64) -> u32 {
  let thresholds = array<U64, 10>(
    U64(8u, 1073741824u), U64(9u, 2635548114u), U64(10u, 4197354403u), U64(12u, 1464193397u),
    U64(13u, 3025999686u), U64(15u, 292838680u), U64(16u, 1854644969u), U64(17u, 3416451259u),
    U64(19u, 683290252u), U64(20u, 2245096542u)
  );
  var h = 0u;
  for (var i = 0u; i < 10u; i = i + 1u) {
    if (u64_cmp(n, thresholds[i]) >= 0) { h = i + 1u; }
  }
  return h;
}

fn corner_height_at(seed: u32, half_extent: i32, x: i32, z: i32) -> u32 {
  if (x < -half_extent || x > half_extent || z < -half_extent || z > half_extent) { return 0u; }
  let n = composite_num(seed, x, z);
  if (u64_cmp(n, U64(2u, 1073741824u)) < 0) { return 0u; }
  return height_from_num(n);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let p = positions[i];
  heights[i] = corner_height_at(params.seed, params.half_extent, p.x, p.y);
}