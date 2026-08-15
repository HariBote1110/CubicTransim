use super::*;

#[wasm_bindgen]
impl CanvasRenderer {
    /// デバッグ用: 現在 GPU に常駐しているタイルの一覧と、各タイルに適用された
    /// build_tile_overrides の生の出力をそのまま JSON で返す。コーナー高さの
    /// 上書きがコンピュートシェーダへ渡る直前の状態をブラウザから直接検査するため。
    /// このAPI群(debugTiles/debugOverrideStore/debugReadTileSamples)はコーナー
    /// オーバーライドのブラウザ側診断のために常設した。調査経緯は
    /// progress/wgpu-corner-override-z-investigation.md を参照。
    #[wasm_bindgen(js_name = debugTiles)]
    pub fn debug_tiles(&self) -> String {
        const MAX_ENTRIES: usize = 4096;
        let mut visible = String::from("[");
        for (i, key) in self.visible.iter().enumerate() {
            if i > 0 {
                visible.push(',');
            }
            visible.push_str(&format!("[{},{},{}]", key.x, key.z, key.lod));
        }
        visible.push(']');

        let mut tiles = String::from("[");
        for (i, (key, tile)) in self.tiles.iter().enumerate() {
            if i > 0 {
                tiles.push(',');
            }
            let origin_x = key.x * tile_cell_span(key.lod);
            let origin_z = key.z * tile_cell_span(key.lod);
            let stride = 1i32 << key.lod;
            let override_count = (tile.debug_overrides.len() / 2) as u32;
            let mut entries = String::from("[");
            for (j, v) in tile
                .debug_overrides
                .iter()
                .take(MAX_ENTRIES)
                .enumerate()
            {
                if j > 0 {
                    entries.push(',');
                }
                entries.push_str(&v.to_string());
            }
            entries.push(']');
            tiles.push_str(&format!(
                "{{\"kx\":{},\"kz\":{},\"lod\":{},\"originX\":{origin_x},\"originZ\":{origin_z},\"stride\":{stride},\"overrideCount\":{override_count},\"entries\":{entries},\"lastUsed\":{}}}",
                key.x, key.z, key.lod, tile.last_used
            ));
        }
        tiles.push(']');

        format!("{{\"visible\":{visible},\"tiles\":{tiles}}}")
    }

    /// デバッグ用: 編集オーバーレイの現在の格納状態を、チャンクごとに local_index 昇順で
    /// 整列したフラット配列として返す。GPU 側の debugTiles と突き合わせて、
    /// 「保存されている編集」と「タイル生成時に実際に適用された編集」の食い違いを追う。
    /// ブラウザ側診断用に常設。調査経緯は progress/wgpu-corner-override-z-investigation.md 参照。
    #[wasm_bindgen(js_name = debugOverrideStore)]
    pub fn debug_override_store(&self) -> String {
        const MAX_ENTRIES: usize = 4096;
        let mut chunks = String::from("[");
        for (i, (&(cx, cz), chunk)) in self.overrides.iter().enumerate() {
            if i > 0 {
                chunks.push(',');
            }
            let mut sorted: Vec<(u32, u8)> = chunk.iter().map(|(&k, &v)| (k, v)).collect();
            sorted.sort_unstable_by_key(|(local_index, _)| *local_index);
            let mut entries = String::from("[");
            for (j, (local_index, height)) in sorted.iter().take(MAX_ENTRIES / 2).enumerate()
            {
                if j > 0 {
                    entries.push(',');
                }
                entries.push_str(&format!("{local_index},{height}"));
            }
            entries.push(']');
            chunks.push_str(&format!(
                "{{\"cx\":{cx},\"cz\":{cz},\"len\":{},\"entries\":{entries}}}",
                sorted.len()
            ));
        }
        chunks.push(']');
        chunks
    }

    /// デバッグ用: 常駐タイルの samples バッファ(コンピュートシェーダが書き込んだ生の
    /// 標高グリッド)を GPU から読み戻す。debugTiles で上書きエントリの適用状況が
    /// 正しく見えるのに描画結果が誤っている場合、コンピュートシェーダの出力そのものが
    /// 期待どおりかをブラウザから直接検証するために使う。
    /// ブラウザ側診断用に常設。調査経緯は progress/wgpu-corner-override-z-investigation.md 参照。
    #[wasm_bindgen(js_name = debugReadTileSamples)]
    pub async fn debug_read_tile_samples(
        &mut self,
        kx: i32,
        kz: i32,
        lod: u32,
    ) -> Result<js_sys::Uint32Array, JsValue> {
        let key = TileKey {
            lod: lod as u8,
            x: kx,
            z: kz,
        };
        let samples_buf = self
            .tiles
            .get(&key)
            .map(|tile| tile.samples.clone())
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "debugReadTileSamples: no resident tile for kx={kx} kz={kz} lod={lod}"
                ))
            })?;

        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("debug-tile-samples-staging"),
            size: TILE_BYTES,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("debug-read-tile-samples"),
            });
        encoder.copy_buffer_to_buffer(&samples_buf, 0, &staging, 0, TILE_BYTES);
        self.queue.submit(Some(encoder.finish()));

        let slice = staging.slice(..);
        let promise = js_sys::Promise::new(&mut |resolve, reject| {
            slice.map_async(wgpu::MapMode::Read, move |result| match result {
                Ok(()) => {
                    let _ = resolve.call0(&JsValue::NULL);
                }
                Err(err) => {
                    let _ = reject.call1(&JsValue::NULL, &JsValue::from_str(&format!("{err:?}")));
                }
            });
        });
        // WebGPU バックエンドではブラウザのイベントループが map_async を解決する。
        // Poll はネイティブ経路との対称性のために呼ぶが、wasm 上では実質no-op。
        let _ = self.device.poll(wgpu::Maintain::Poll);
        wasm_bindgen_futures::JsFuture::from(promise).await?;

        let mapped = slice.get_mapped_range();
        let words: &[u32] = bytemuck::cast_slice(&mapped);
        let out = js_sys::Uint32Array::new_with_length(words.len() as u32);
        out.copy_from(words);
        drop(mapped);
        staging.unmap();

        Ok(out)
    }

    #[wasm_bindgen(js_name = adapterInfo)]
    pub fn adapter_info(&self) -> String {
        format!(
            "{{\"name\":{:?},\"backend\":{:?},\"format\":\"{:?}\"}}",
            self.adapter_name, self.adapter_backend, self.config.format
        )
    }
}
