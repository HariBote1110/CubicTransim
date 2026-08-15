use super::*;

#[wasm_bindgen]
impl CanvasRenderer {
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.camera_revision = self.camera_revision.wrapping_add(1);
        let (depth, depth_view) = create_depth(&self.device, width, height);
        self._depth = depth;
        self.depth_view = depth_view;
    }

    /// カメラを本体(three.js)側の直交カメラに合わせる。
    ///
    /// - `center_x` / `center_z`: 画面中心に来る地表(y=0)の点。OrbitControls の
    ///   target が (tx,ty,tz) のとき、等角投影では (tx-ty, tz-ty) がその点になる
    ///   (JS 側 `render/webgpuCamera.ts` の `groundCentreFromTarget` が計算する)。
    /// - `pixels_per_cell`: ワールド1単位あたりの物理ピクセル数(= three.js の zoom × DPR)。
    /// - `height_per_level`: 段数1あたりのワールド高さ(本体の OVERPASS_HEIGHT)。
    ///   省略時は 1.0(プロトタイプの単独ページ用)。
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(
        &mut self,
        center_x: f64,
        center_z: f64,
        pixels_per_cell: f64,
        height_per_level: Option<f64>,
    ) {
        let next_x = center_x.clamp(-(self.half_extent as f64), self.half_extent as f64);
        let next_z = center_z.clamp(-(self.half_extent as f64), self.half_extent as f64);
        let min_ppc = full_map_min_ppc(self.config.width, self.config.height, self.half_extent);
        let next_ppc = pixels_per_cell.clamp(min_ppc, MAX_PIXELS_PER_CELL);
        let next_height = height_per_level.unwrap_or(1.0);
        if self.center_x != next_x
            || self.center_z != next_z
            || self.pixels_per_cell != next_ppc
            || self.height_per_level != next_height
        {
            self.center_x = next_x;
            self.center_z = next_z;
            self.pixels_per_cell = next_ppc;
            self.height_per_level = next_height;
            self.camera_revision = self.camera_revision.wrapping_add(1);
        }
    }

    /// D1: 透視投影カメラ(乗客視点スパイク)を更新する。クォータービューの
    /// `set_camera` とは独立(center_x/pixels_per_cell 等は一切触らない)。
    /// `mode` が Perspective のときだけ render() で使われる。
    #[wasm_bindgen(js_name = setCameraPerspective)]
    pub fn set_camera_perspective(
        &mut self,
        eye_x: f64,
        eye_y: f64,
        eye_z: f64,
        look_x: f64,
        look_y: f64,
        look_z: f64,
        fov_y_radians: f64,
    ) {
        self.persp_eye = [eye_x, eye_y, eye_z];
        self.persp_look = [look_x, look_y, look_z];
        self.persp_fov_y = fov_y_radians.max(0.01);
        self.camera_revision = self.camera_revision.wrapping_add(1);
    }

    /// D1: レンダリングモードを切り替える。'perspective' 以外はすべて 'quarter'
    /// (既定)として扱う。'quarter' に戻すとクォータービューは前回の set_camera
    /// 状態でバイト単位に従来どおり描く(このメソッドは center_x 等を書き換えない)。
    #[wasm_bindgen(js_name = setCameraMode)]
    pub fn set_camera_mode(&mut self, mode: &str) {
        let next = if mode == "perspective" {
            CameraMode::Perspective
        } else {
            CameraMode::Quarter
        };
        if self.mode != next {
            self.mode = next;
            self.camera_revision = self.camera_revision.wrapping_add(1);
        }
    }

    #[wasm_bindgen(js_name = panPixels)]
    pub fn pan_pixels(&mut self, screen_dx: f64, screen_dy: f64) {
        // 等角投影の逆変換(y=0 平面上):
        //   dsx = (dwx-dwz)*ppc*ISO_X, dsy = (dwx+dwz)*ppc*ISO_Y
        let ppc = self.pixels_per_cell.max(0.0001);
        let diff = screen_dx / (ppc * ISO_X);
        let sum = screen_dy / (ppc * ISO_Y);
        let world_x = 0.5 * (sum + diff);
        let world_z = 0.5 * (sum - diff);
        let next_x = (self.center_x - world_x)
            .clamp(-(self.half_extent as f64), self.half_extent as f64);
        let next_z = (self.center_z - world_z)
            .clamp(-(self.half_extent as f64), self.half_extent as f64);
        if self.center_x != next_x || self.center_z != next_z {
            self.center_x = next_x;
            self.center_z = next_z;
            self.camera_revision = self.camera_revision.wrapping_add(1);
        }
    }

    /// コーナー編集オーバーレイの1チャンク分を丸ごと置き換える(terrainOverlay.ts の
    /// `overlayChunkRefs` と同じ考え方: JS 側は参照が変わったサブMapだけを送る)。
    ///
    /// `entries` はフラットな `[localIndex0, height0, localIndex1, height1, ...]`
    /// (localIndex は `lx*OVERLAY_CHUNK_SIZE+lz`、terrainOverlay.ts の localIndexOf と
    /// 同じ並び)。空配列はチャンク全体の削除を意味する(TS 側が全コーナー基底復帰で
    /// chunkを削除するのと同じ)。影響しうる常駐タイル(全LOD、スナップ許容込み)を
    /// キャッシュから外し、次フレームの生成で再評価させる(A3: CPU側はHashMapの
    /// 差し替え+タイルキャッシュのretainのみで、O(編集件数+常駐タイル数)に収まる)。
    #[wasm_bindgen(js_name = setCornerOverrideChunk)]
    pub fn set_corner_override_chunk(&mut self, chunk_x: i32, chunk_z: i32, entries: &[u32]) {
        let key = (chunk_x, chunk_z);
        if entries.is_empty() {
            if self.overrides.remove(&key).is_none() {
                return;
            }
        } else {
            let mut chunk = HashMap::with_capacity(entries.len() / 2);
            for pair in entries.chunks_exact(2) {
                chunk.insert(pair[0], pair[1] as u8);
            }
            self.overrides.insert(key, chunk);
        }
        self.invalidate_chunk(chunk_x, chunk_z);
    }

    /// 地下ビュー減光係数(GameScene の isLevelDimmed と同調させる)。1.0=通常表示。
    #[wasm_bindgen(js_name = setDim)]
    pub fn set_dim(&mut self, factor: f64) {
        let next = factor.clamp(0.0, 1.0);
        if self.dim != next {
            self.dim = next;
            self.camera_revision = self.camera_revision.wrapping_add(1);
        }
    }

    #[wasm_bindgen(js_name = zoomBy)]
    pub fn zoom_by(&mut self, factor: f64) {
        let min_ppc = full_map_min_ppc(self.config.width, self.config.height, self.half_extent);
        let next_ppc = (self.pixels_per_cell * factor).clamp(min_ppc, MAX_PIXELS_PER_CELL);
        if self.pixels_per_cell != next_ppc {
            self.pixels_per_cell = next_ppc;
            self.camera_revision = self.camera_revision.wrapping_add(1);
        }
    }
}
