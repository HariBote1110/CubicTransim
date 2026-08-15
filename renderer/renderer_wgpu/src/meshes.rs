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
    let mut out = Vec::with_capacity(count * VERTEX_STRIDE_BYTES);
    for i in 0..count {
        out.extend_from_slice(&positions[i * 3].to_le_bytes());
        out.extend_from_slice(&positions[i * 3 + 1].to_le_bytes());
        out.extend_from_slice(&positions[i * 3 + 2].to_le_bytes());
        out.extend_from_slice(&colours[i].to_le_bytes());
    }
    out
}

/// インスタンス配列を「地表」「地下」の2本へ振り分ける(flags の bit0 で判定)。
///
/// パイプライン状態(深度比較)はドロー単位でしか変えられないため、クラスの
/// 振り分けは CPU 側で行い、それぞれを別のインスタンスバッファ+別ドローにする。
/// 端数(stride に満たない末尾)は無視する。
pub fn split_instances_by_class(data: &[f32]) -> (Vec<u8>, Vec<u8>) {
    let count = data.len() / INSTANCE_STRIDE_FLOATS;
    let mut surface = Vec::new();
    let mut underground = Vec::new();
    for i in 0..count {
        let chunk = &data[i * INSTANCE_STRIDE_FLOATS..(i + 1) * INSTANCE_STRIDE_FLOATS];
        let flags = chunk[8] as u32;
        let target = if flags & INSTANCE_FLAG_UNDERGROUND != 0 {
            &mut underground
        } else {
            &mut surface
        };
        for v in chunk {
            target.extend_from_slice(&v.to_le_bytes());
        }
    }
    (surface, underground)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaves_position_and_colour_into_16_byte_vertices() {
        let bytes =
            interleave_vertices(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[0xff00_00ff, 0x00ff_00ff]);
        assert_eq!(bytes.len(), 2 * VERTEX_STRIDE_BYTES);
        assert_eq!(&bytes[0..4], &1.0f32.to_le_bytes());
        assert_eq!(&bytes[12..16], &0xff00_00ffu32.to_le_bytes());
        assert_eq!(&bytes[16..20], &4.0f32.to_le_bytes());
    }

    #[test]
    fn interleave_clamps_to_the_shorter_input() {
        let bytes = interleave_vertices(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0], &[0xffff_ffff]);
        assert_eq!(bytes.len(), VERTEX_STRIDE_BYTES);
    }

    #[test]
    fn splits_instances_by_the_underground_flag() {
        let mut data = vec![0.0f32; INSTANCE_STRIDE_FLOATS * 3];
        data[0] = 1.0; // instance 0: surface
        data[INSTANCE_STRIDE_FLOATS] = 2.0; // instance 1: underground
        data[INSTANCE_STRIDE_FLOATS + 8] = INSTANCE_FLAG_UNDERGROUND as f32;
        data[INSTANCE_STRIDE_FLOATS * 2] = 3.0; // instance 2: surface
        let (surface, underground) = split_instances_by_class(&data);
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
        let (surface, underground) = split_instances_by_class(&data);
        assert_eq!(surface.len(), INSTANCE_STRIDE_BYTES);
        assert!(underground.is_empty());
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
