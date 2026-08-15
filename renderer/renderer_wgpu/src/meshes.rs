/// 頂点1つのバイト数: position(f32x3) + colour(unorm8x4)。
pub const VERTEX_STRIDE_BYTES: usize = 16;

/// インスタンス1つあたりの f32 個数。
///
/// レイアウト(TS 側 `setInstances` が渡すフラット配列と同じ並び):
///   0: x, 1: y, 2: z            — ワールド位置(y はワールド単位)
///   3: yaw   — +Y 軸まわり(three.js の rotateY と同符号、`angleFromVector` 準拠)
///   4: pitch — 進行方向まわりの傾き(勾配の可視化に使う)
///   5..7: tintR, tintG, tintB   — 頂点色へ掛ける色(路線色など、0..1)
///   8: flags — bit0=1 で地下クラス(深度Always・地下ビュー以外では非表示)
///   9: 予約(16バイト境界に揃えるためのパディング。常に 0 を書く)
pub const INSTANCE_STRIDE_FLOATS: usize = 10;
pub const INSTANCE_STRIDE_BYTES: usize = INSTANCE_STRIDE_FLOATS * 4;

/// インスタンスフラグ: 地下クラスとして描く。
pub const INSTANCE_FLAG_UNDERGROUND: u32 = 1;

/// メッシュチャンクの描画クラス。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerClass {
    /// 地表の不透明物。地形と同じ dim 係数で減光される。
    Surface,
    /// 地下の構造物。地表より後に深度比較 Always で描く(地下ビュー以外では非表示)。
    Underground,
    /// 半透明オーバーレイ。深度書き込み無しで最後に描く(αは頂点色のA)。
    Translucent,
    /// 地上ビューで地下を透かして見せるゴースト。Underground と同じく深度比較
    /// Always で地形の上に出るが、αブレンドで薄く重なる(退役した three.js の
    /// DIMMED_MATERIALS: opacity 0.3 + depthTest:false と同じ狙い)。
    UndergroundGhost,
}

impl LayerClass {
    /// JS から渡る数値(0/1/2/3)を解釈する。未知の値は Surface に丸める。
    pub fn from_u32(v: u32) -> Self {
        match v {
            1 => LayerClass::Underground,
            2 => LayerClass::Translucent,
            3 => LayerClass::UndergroundGhost,
            _ => LayerClass::Surface,
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            LayerClass::Surface => 0,
            LayerClass::Underground => 1,
            LayerClass::Translucent => 2,
            LayerClass::UndergroundGhost => 3,
        }
    }
}

/// position(f32x3 のフラット配列)と colour(頂点ごとの RGBA8 パック値)を
/// GPU 頂点バッファのバイト列(stride 16)へ交互配置する。
///
/// 長さが食い違う場合は短いほうに合わせる(JS からの呼び出しを落とさないための防御)。
pub fn interleave_vertices(positions: &[f32], colours: &[u32]) -> Vec<u8> {
    let count = (positions.len() / 3).min(colours.len());
    let mut out_u32 = vec![0u32; count * (VERTEX_STRIDE_BYTES / 4)];
    let pos_slice: &[u32] = bytemuck::cast_slice(positions);
    for i in 0..count {
        out_u32[i * 4] = pos_slice[i * 3];
        out_u32[i * 4 + 1] = pos_slice[i * 3 + 1];
        out_u32[i * 4 + 2] = pos_slice[i * 3 + 2];
        out_u32[i * 4 + 3] = colours[i];
    }

    // Convert to target-endian bytes (WebGPU typically runs on little-endian,
    // and wasm32 is always little-endian).
    bytemuck::cast_slice(&out_u32).to_vec()
}

/// インスタンス配列を「地表」「地下」の2本へ振り分ける(flags の bit0 で判定)。
///
/// パイプライン状態(深度比較)はドロー単位でしか変えられないため、クラスの
/// 振り分けは CPU 側で行い、それぞれを別のインスタンスバッファ+別ドローにする。
/// 端数(stride に満たない末尾)は無視する。
pub fn split_instances_by_class(data: &[f32]) -> (Vec<u8>, Vec<u8>) {
    let count = data.len() / INSTANCE_STRIDE_FLOATS;
    let mut surface = Vec::with_capacity(count * INSTANCE_STRIDE_BYTES);
    let mut underground = Vec::with_capacity(count * INSTANCE_STRIDE_BYTES);
    for i in 0..count {
        let chunk = &data[i * INSTANCE_STRIDE_FLOATS..(i + 1) * INSTANCE_STRIDE_FLOATS];
        let flags = chunk[8] as u32;
        let target = if flags & INSTANCE_FLAG_UNDERGROUND != 0 {
            &mut underground
        } else {
            &mut surface
        };
        target.extend_from_slice(bytemuck::cast_slice(chunk));
    }
    (surface, underground)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用: 宛先を用意して `interleave_vertices_into` を呼ぶ。
    fn interleave_to_vec(positions: &[f32], colours: &[u32]) -> Vec<u8> {
        let mut out = vec![0u8; interleaved_vertex_bytes(positions, colours)];
        interleave_vertices_into(&mut out, positions, colours);
        out
    }

    /// テスト用: 宛先を用意して `split_instances_into` を呼ぶ。
    fn split_to_vecs(data: &[f32]) -> (Vec<u8>, Vec<u8>) {
        let total = data.len() / INSTANCE_STRIDE_FLOATS;
        let under = underground_instance_count(data);
        let mut surface = vec![0u8; (total - under) * INSTANCE_STRIDE_BYTES];
        let mut underground = vec![0u8; under * INSTANCE_STRIDE_BYTES];
        split_instances_into(&mut surface, &mut underground, data);
        (surface, underground)
    }

    #[test]
    fn interleaves_position_and_colour_into_16_byte_vertices() {
        let bytes =
            interleave_to_vec(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[0xff00_00ff, 0x00ff_00ff]);
        assert_eq!(bytes.len(), 2 * VERTEX_STRIDE_BYTES);
        assert_eq!(&bytes[0..4], &1.0f32.to_le_bytes());
        assert_eq!(&bytes[12..16], &0xff00_00ffu32.to_le_bytes());
        assert_eq!(&bytes[16..20], &4.0f32.to_le_bytes());
    }

    #[test]
    fn interleave_clamps_to_the_shorter_input() {
        let positions = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        assert_eq!(
            interleaved_vertex_bytes(&positions, &[0xffff_ffff]),
            VERTEX_STRIDE_BYTES
        );
        let bytes = interleave_to_vec(&positions, &[0xffff_ffff]);
        assert_eq!(bytes.len(), VERTEX_STRIDE_BYTES);
        assert_eq!(&bytes[0..4], &1.0f32.to_le_bytes());
    }

    /// 宛先が足りないときは書ける分だけ書いて落ちない(JS からの呼び出しを守る)。
    #[test]
    fn interleave_into_never_overruns_a_short_destination() {
        let mut dst = [0u8; VERTEX_STRIDE_BYTES];
        interleave_vertices_into(
            &mut dst,
            &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
            &[0xaaaa_aaaa, 0xbbbb_bbbb],
        );
        assert_eq!(&dst[0..4], &1.0f32.to_le_bytes());
        assert_eq!(&dst[12..16], &0xaaaa_aaaau32.to_le_bytes());
    }

    #[test]
    fn splits_instances_by_the_underground_flag() {
        let mut data = vec![0.0f32; INSTANCE_STRIDE_FLOATS * 3];
        data[0] = 1.0; // instance 0: surface
        data[INSTANCE_STRIDE_FLOATS] = 2.0; // instance 1: underground
        data[INSTANCE_STRIDE_FLOATS + 8] = INSTANCE_FLAG_UNDERGROUND as f32;
        data[INSTANCE_STRIDE_FLOATS * 2] = 3.0; // instance 2: surface
        assert_eq!(underground_instance_count(&data), 1);
        let (surface, underground) = split_to_vecs(&data);
        assert_eq!(surface.len(), 2 * INSTANCE_STRIDE_BYTES);
        assert_eq!(underground.len(), INSTANCE_STRIDE_BYTES);
        assert_eq!(&surface[0..4], &1.0f32.to_le_bytes());
        assert_eq!(
            &surface[INSTANCE_STRIDE_BYTES..INSTANCE_STRIDE_BYTES + 4],
            &3.0f32.to_le_bytes()
        );
        assert_eq!(&underground[0..4], &2.0f32.to_le_bytes());
    }

    #[test]
    fn split_ignores_a_trailing_partial_instance() {
        let data = vec![0.0f32; INSTANCE_STRIDE_FLOATS + 3];
        assert_eq!(underground_instance_count(&data), 0);
        let (surface, underground) = split_to_vecs(&data);
        assert_eq!(surface.len(), INSTANCE_STRIDE_BYTES);
        assert!(underground.is_empty());
    }

    /// 宛先が足りないときは、そのクラスの残りを捨てて落ちない。
    #[test]
    fn split_into_never_overruns_a_short_destination() {
        let mut data = vec![0.0f32; INSTANCE_STRIDE_FLOATS * 3];
        data[0] = 1.0;
        data[INSTANCE_STRIDE_FLOATS] = 2.0;
        data[INSTANCE_STRIDE_FLOATS * 2] = 3.0;
        let mut surface = [0u8; INSTANCE_STRIDE_BYTES];
        let mut underground = [0u8; 0];
        split_instances_into(&mut surface, &mut underground, &data);
        assert_eq!(&surface[0..4], &1.0f32.to_le_bytes());
    }

    #[test]
    fn layer_class_round_trips_and_clamps_unknown_values() {
        for c in [
            LayerClass::Surface,
            LayerClass::Underground,
            LayerClass::Translucent,
            LayerClass::UndergroundGhost,
        ] {
            assert_eq!(LayerClass::from_u32(c.as_u32()), c);
        }
        assert_eq!(LayerClass::from_u32(99), LayerClass::Surface);
    }

    #[test]
    fn underground_ghost_is_translucent_and_ignores_depth() {
        // 地上ビューで地下を薄いゴーストとして地形の上に重ねるためのクラス。
        // αブレンド(半透明)+深度比較 Always(地形に隠されない)+深度書き込み無し。
        let state = super::super::mesh_pipeline::depth_blend_state_for(
            LayerClass::UndergroundGhost,
        );
        assert!(!state.depth_write);
        assert_eq!(state.depth_compare, wgpu::CompareFunction::Always);
        assert!(state.blend.is_some());
    }

    #[test]
    fn underground_class_stays_opaque_over_terrain() {
        let state =
            super::super::mesh_pipeline::depth_blend_state_for(LayerClass::Underground);
        assert!(!state.depth_write);
        assert_eq!(state.depth_compare, wgpu::CompareFunction::Always);
        assert!(state.blend.is_none());
    }
}
