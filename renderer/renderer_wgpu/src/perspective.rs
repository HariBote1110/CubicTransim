/// 4x4 行列(列優先、WGSL の `mat4x4<f32>` と同じメモリレイアウト)。
pub type Mat4 = [f32; 16];

fn mat4_mul(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.0f32; 16];
    for col in 0..4 {
        for row in 0..4 {
            let mut sum = 0.0f32;
            for k in 0..4 {
                // a は列優先: a[col_a*4+row]。b も同様。
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            out[col * 4 + row] = sum;
        }
    }
    out
}

fn normalise(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len < 1e-9 {
        return [0.0, 0.0, 1.0];
    }
    [v[0] / len, v[1] / len, v[2] / len]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// 右手系 lookAt。up がほぼ視線方向と平行なとき(真上/真下を見る)は
/// ワールド +Z を代替の up として使い、退化を避ける。
pub fn look_at_rh(eye: [f32; 3], target: [f32; 3], up: [f32; 3]) -> Mat4 {
    let f = normalise(sub(target, eye));
    let mut up_ref = up;
    if dot(f, normalise(up)).abs() > 0.999 {
        up_ref = [0.0, 0.0, 1.0];
    }
    let s = normalise(cross(f, up_ref));
    let u = cross(s, f);
    // 列優先: 列0=s, 列1=u, 列2=-f, 列3=平行移動。
    [
        s[0], u[0], -f[0], 0.0,
        s[1], u[1], -f[1], 0.0,
        s[2], u[2], -f[2], 0.0,
        -dot(s, eye), -dot(u, eye), dot(f, eye), 1.0,
    ]
}

/// 右手系透視投影、深度レンジ [0,1](wgpu既定、reversed-Zは使わない)。
pub fn perspective_rh_zo(fov_y_radians: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
    let f = 1.0 / (fov_y_radians * 0.5).tan();
    let range_inv = 1.0 / (near - far);
    [
        f / aspect.max(1e-6), 0.0, 0.0, 0.0,
        0.0, f, 0.0, 0.0,
        0.0, 0.0, far * range_inv, -1.0,
        0.0, 0.0, near * far * range_inv, 0.0,
    ]
}

/// `perspective_rh_zo(...) * look_at_rh(...)`。
pub fn view_proj(
    eye: [f32; 3],
    target: [f32; 3],
    fov_y_radians: f32,
    aspect: f32,
    near: f32,
    far: f32,
) -> Mat4 {
    let view = look_at_rh(eye, target, [0.0, 1.0, 0.0]);
    let proj = perspective_rh_zo(fov_y_radians, aspect, near, far);
    mat4_mul(&proj, &view)
}

fn transform_point(m: &Mat4, p: [f32; 3]) -> [f32; 4] {
    [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
    ]
}

/// AABB `[min_x,min_y,min_z,max_x,max_y,max_z]` が view_proj のクリップ空間で
/// 完全に外側(6平面のいずれかの外側に8頂点すべてがある)でなければ可視とみなす
/// (保守的な判定: 偽陽性は許容、偽陰性は避ける)。
pub fn aabb_visible_persp(aabb: &[f32; 6], view_proj: &Mat4) -> bool {
    let corners = [
        [aabb[0], aabb[1], aabb[2]],
        [aabb[3], aabb[1], aabb[2]],
        [aabb[0], aabb[4], aabb[2]],
        [aabb[3], aabb[4], aabb[2]],
        [aabb[0], aabb[1], aabb[5]],
        [aabb[3], aabb[1], aabb[5]],
        [aabb[0], aabb[4], aabb[5]],
        [aabb[3], aabb[4], aabb[5]],
    ];
    let clipped: Vec<[f32; 4]> = corners.iter().map(|&p| transform_point(view_proj, p)).collect();
    // 6平面それぞれについて、全頂点がその平面の外側にあれば不可視。
    let outside_all = |test: &dyn Fn(&[f32; 4]) -> bool| clipped.iter().all(|c| test(c));
    if outside_all(&|c| c[0] < -c[3]) {
        return false;
    }
    if outside_all(&|c| c[0] > c[3]) {
        return false;
    }
    if outside_all(&|c| c[1] < -c[3]) {
        return false;
    }
    if outside_all(&|c| c[1] > c[3]) {
        return false;
    }
    if outside_all(&|c| c[2] < 0.0) {
        return false;
    }
    if outside_all(&|c| c[2] > c[3]) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_in_front_of_eye_projects_within_ndc() {
        let vp = view_proj([0.0, 1.0, 0.0], [0.0, 1.0, 10.0], std::f32::consts::FRAC_PI_3, 1.0, 0.1, 100.0);
        let clip = transform_point(&vp, [0.0, 1.0, 10.0]);
        // 視線の中心にある点は画面中央(x/w=0,y/w=0)近くに来る。
        assert!((clip[0] / clip[3]).abs() < 1e-3);
        assert!((clip[1] / clip[3]).abs() < 1e-3);
        // 深度は [0,1] の範囲内。
        let ndc_z = clip[2] / clip[3];
        assert!(ndc_z >= 0.0 && ndc_z <= 1.0);
    }

    #[test]
    fn box_behind_camera_is_not_visible() {
        let vp = view_proj([0.0, 1.0, 0.0], [0.0, 1.0, 10.0], std::f32::consts::FRAC_PI_3, 1.0, 0.1, 100.0);
        assert!(!aabb_visible_persp(&[-1.0, 0.0, -20.0, 1.0, 2.0, -18.0], &vp));
    }

    #[test]
    fn box_ahead_of_camera_is_visible() {
        let vp = view_proj([0.0, 1.0, 0.0], [0.0, 1.0, 10.0], std::f32::consts::FRAC_PI_3, 1.0, 0.1, 100.0);
        assert!(aabb_visible_persp(&[-1.0, 0.0, 9.0, 1.0, 2.0, 11.0], &vp));
    }

    #[test]
    fn box_far_to_the_side_is_not_visible() {
        let vp = view_proj([0.0, 1.0, 0.0], [0.0, 1.0, 10.0], std::f32::consts::FRAC_PI_3, 1.0, 0.1, 100.0);
        assert!(!aabb_visible_persp(&[500.0, 0.0, 9.0, 502.0, 2.0, 11.0], &vp));
    }
}
