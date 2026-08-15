/// 画面座標係数(shaders/terrain_draw.wgsl の ISO_X / ISO_Y / ISO_H と同一)。
/// three.js 側の OrthographicCamera(position=(20,20,20), up=+Y)から導いた値。
pub const ISO_X: f64 = std::f64::consts::FRAC_1_SQRT_2; // 1/sqrt(2)
pub const ISO_Y: f64 = 0.408_248_290_463_863; // 1/sqrt(6)
/// 高さ項の係数(2/sqrt(6))。メッシュの y は**ワールド単位**(段数ではない)なので、
/// 画面へのオフセットは `y_world * pixels_per_cell * ISO_H` になる。
pub const ISO_H: f64 = 0.816_496_580_927_726;

/// カリング判定に必要なカメラ状態(render() が毎フレーム作る)。
#[derive(Clone, Copy, Debug)]
pub struct CullCamera {
    pub centre_x: f64,
    pub centre_z: f64,
    pub pixels_per_cell: f64,
    pub viewport_w: f64,
    pub viewport_h: f64,
}

/// 画面中心を原点とした矩形(ピクセル、+y は画面下向き)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenRect {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

/// ワールド AABB `[min_x,min_y,min_z,max_x,max_y,max_z]`(y はワールド単位)を
/// 等角投影して画面空間の外接矩形を求める。
///
/// 投影は各軸について単調なので、8頂点を回さずに端点の組み合わせだけで厳密な
/// 外接矩形が出る:
///   sx = (rx-rz)*ppc*ISO_X       -> rx 最大・rz 最小で最大
///   sy = (rx+rz)*ppc*ISO_Y - y*ppc*ISO_H -> rx,rz 最大・y 最小で最大
pub fn aabb_screen_rect(aabb: &[f32; 6], cam: CullCamera) -> ScreenRect {
    let x0 = aabb[0] as f64 - cam.centre_x;
    let y0 = aabb[1] as f64;
    let z0 = aabb[2] as f64 - cam.centre_z;
    let x1 = aabb[3] as f64 - cam.centre_x;
    let y1 = aabb[4] as f64;
    let z1 = aabb[5] as f64 - cam.centre_z;
    let ppc = cam.pixels_per_cell;
    ScreenRect {
        min_x: (x0 - z1) * ppc * ISO_X,
        max_x: (x1 - z0) * ppc * ISO_X,
        min_y: (x0 + z0) * ppc * ISO_Y - y1 * ppc * ISO_H,
        max_y: (x1 + z1) * ppc * ISO_Y - y0 * ppc * ISO_H,
    }
}

/// AABB がビューポートに掛かるか(接触も可視扱い)。
pub fn aabb_visible(aabb: &[f32; 6], cam: CullCamera) -> bool {
    let rect = aabb_screen_rect(aabb, cam);
    let half_w = cam.viewport_w * 0.5;
    let half_h = cam.viewport_h * 0.5;
    rect.max_x >= -half_w
        && rect.min_x <= half_w
        && rect.max_y >= -half_h
        && rect.min_y <= half_h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam() -> CullCamera {
        CullCamera {
            centre_x: 0.0,
            centre_z: 0.0,
            pixels_per_cell: 10.0,
            viewport_w: 100.0,
            viewport_h: 100.0,
        }
    }

    #[test]
    fn origin_cell_projects_to_screen_centre() {
        let rect = aabb_screen_rect(&[0.0; 6], cam());
        assert!(rect.min_x.abs() < 1e-9 && rect.max_x.abs() < 1e-9);
        assert!(rect.min_y.abs() < 1e-9 && rect.max_y.abs() < 1e-9);
    }

    #[test]
    fn height_pushes_the_box_upwards_on_screen() {
        // y は画面下向きなので、高い(y_max が大きい)ほど min_y は小さくなる。
        let flat = aabb_screen_rect(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0], cam());
        let tall = aabb_screen_rect(&[0.0, 0.0, 0.0, 0.0, 2.0, 0.0], cam());
        assert!(tall.min_y < flat.min_y);
        assert!((tall.min_y - (-2.0 * 10.0 * ISO_H)).abs() < 1e-9);
        assert!((tall.max_y - flat.max_y).abs() < 1e-9);
    }

    #[test]
    fn centred_box_is_visible_and_distant_box_is_not() {
        assert!(aabb_visible(&[-1.0, 0.0, -1.0, 1.0, 1.0, 1.0], cam()));
        // +x/+z へ大きく離すと画面下方向(sy)へ抜ける。
        assert!(!aabb_visible(
            &[100.0, 0.0, 100.0, 101.0, 1.0, 101.0],
            cam()
        ));
        // +x/-z へ離すと画面右方向(sx)へ抜ける。
        assert!(!aabb_visible(
            &[100.0, 0.0, -101.0, 101.0, 1.0, -100.0],
            cam()
        ));
    }

    #[test]
    fn camera_centre_follows_the_box() {
        let far = [100.0f32, 0.0, 100.0, 101.0, 1.0, 101.0];
        let mut c = cam();
        assert!(!aabb_visible(&far, c));
        c.centre_x = 100.5;
        c.centre_z = 100.5;
        assert!(aabb_visible(&far, c));
    }
}
