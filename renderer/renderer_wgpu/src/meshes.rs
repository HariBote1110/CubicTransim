/// 頂点1つのバイト数: position(f32x3) + colour(unorm8x4)。
pub const VERTEX_STRIDE_BYTES: usize = 16;

/// インスタンス1つあたりのワード数(f32 換算の個数)。
///
/// レイアウト(TS 側 `setInstances` が渡すフラット配列と同じ並び。stride 24 バイト):
///   0: x, 1: y, 2: z            — ワールド位置(y はワールド単位)
///   3: yaw   — +Y 軸まわり(three.js の rotateY と同符号、`angleFromVector` 準拠)
///   4: pitch — 進行方向まわりの傾き(勾配の可視化に使う)
///   5: tint+flags — `pack_tint_and_flags` で詰めた u32。頂点属性としては unorm8x4
///      (R,G,B が路線色。A は**シェーダが読まない**ので flags を同居させている)
///
/// 旧レイアウトは 40 バイトで、flags 専用の f32 と 16 バイト境界のためのパディングを
/// 持っていた。シェーダが読むのは位置・回転・tint だけ(`mesh_instanced.wgsl` 参照)で、
/// flags は CPU 側のクラス振り分けにしか使わないため、tint の未使用 A バイトへ畳んだ。
/// インスタンス配列は毎フレーム丸ごと GPU へ送るので、stride の縮小がそのまま
/// 転送量の削減になる(40 → 24 バイト、40% 減)。
pub const INSTANCE_STRIDE_FLOATS: usize = 6;
pub const INSTANCE_STRIDE_BYTES: usize = INSTANCE_STRIDE_FLOATS * 4;

/// tint+flags を詰めたワードの位置(インスタンス先頭からのワード数)。
pub const INSTANCE_TINT_WORD: usize = 5;

/// インスタンスフラグ: 地下クラスとして描く。
pub const INSTANCE_FLAG_UNDERGROUND: u32 = 1;

/// 路線色(0..1)と flags を1ワードへ詰める。unorm8x4 として読ませるので
/// R,G,B の順に下位バイトから並べ、シェーダが読まない A バイトへ flags を置く。
///
/// 範囲外や NaN の tint はクランプする(`as u8` の飽和変換に任せると NaN が 0 になる)。
pub fn pack_tint_and_flags(tint: [f32; 3], flags: u32) -> u32 {
    let to_byte = |v: f32| (v * 255.0 + 0.5) as u8 as u32; // NaN/範囲外は飽和変換で丸まる
    to_byte(tint[0]) | (to_byte(tint[1]) << 8) | (to_byte(tint[2]) << 16) | ((flags & 0xff) << 24)
}

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

/// 交互配置した頂点バッファのバイト数。
///
/// 長さが食い違う場合は短いほうに合わせる(JS からの呼び出しを落とさないための防御)。
/// `interleave_vertices_into` の宛先(GPU バッファ)を確保するサイズはこれで決める。
pub fn interleaved_vertex_bytes(positions: &[f32], colours: &[u32]) -> usize {
    (positions.len() / 3).min(colours.len()) * VERTEX_STRIDE_BYTES
}

/// position(f32x3 のフラット配列)と colour(頂点ごとの RGBA8 パック値)を
/// `dst` へ交互配置する(stride 16)。
///
/// 中間バッファを作らず GPU バッファのマップ領域へ直接書くための形。`dst` の長さが
/// 足りない場合は入る分だけ書いて残りを捨てる(呼び出しを落とさないための防御)。
///
/// バイト順はネイティブ順。wasm32 は常にリトルエンディアンで、ネイティブ実行も
/// 現状 LE のホストしか想定していない(テストが LE 前提で assert している)。
pub fn interleave_vertices_into(dst: &mut [u8], positions: &[f32], colours: &[u32]) {
    let count = (positions.len() / 3)
        .min(colours.len())
        .min(dst.len() / VERTEX_STRIDE_BYTES);
    // chunks_exact 同士を zip すると境界チェックが消え、12バイトのコピーが
    // ベクトル化される(要素ごとに書くより 2〜3 倍速い)。
    let pos: &[u8] = bytemuck::cast_slice(&positions[..count * 3]);
    for ((vertex, xyz), &colour) in dst[..count * VERTEX_STRIDE_BYTES]
        .chunks_exact_mut(VERTEX_STRIDE_BYTES)
        .zip(pos.chunks_exact(12))
        .zip(&colours[..count])
    {
        vertex[..12].copy_from_slice(xyz);
        vertex[12..].copy_from_slice(&colour.to_ne_bytes());
    }
}

/// 地下クラス(flags の bit0)のインスタンス数。端数(stride に満たない末尾)は無視する。
///
/// `split_instances_into` の宛先2本をちょうどのサイズで確保するために使う。
pub fn underground_instance_count(data: &[f32]) -> usize {
    data.chunks_exact(INSTANCE_STRIDE_FLOATS)
        .filter(|chunk| instance_is_underground(chunk))
        .count()
}

/// インスタンス1件が地下クラスか。flags は tint ワードの最上位バイトに入っている。
#[inline]
fn instance_is_underground(chunk: &[f32]) -> bool {
    (chunk[INSTANCE_TINT_WORD].to_bits() >> 24) & INSTANCE_FLAG_UNDERGROUND != 0
}

/// インスタンスバッファの最小確保サイズ(これ未満は切り上げる)。
const MIN_INSTANCE_BUFFER_BYTES: usize = 64;

/// インスタンスバッファを確保し直すべきかを決める。`None` なら現状のまま使い回す。
///
/// インスタンス配列は毎フレーム丸ごと差し替わるので、そのたびに GPU バッファを作ると
/// 内容の量に関わらず1回あたり数マイクロ秒の固定費がかかる。容量に余裕があるかぎり
/// 使い回し、増えるときだけ2の冪へ切り上げて確保することで作り直しの頻度を落とす。
/// 逆に使用率が 1/4 を切ったら縮めて VRAM を抱え込まないようにする。
pub fn instance_buffer_capacity(required: usize, current: usize) -> Option<usize> {
    if required == 0 {
        return if current == 0 { None } else { Some(0) };
    }
    let fits = required <= current;
    let far_too_large = required * 4 < current;
    if fits && !far_too_large {
        return None;
    }
    Some(
        required
            .next_power_of_two()
            .max(MIN_INSTANCE_BUFFER_BYTES),
    )
}

/// インスタンス配列を「地表」「地下」の2本へ振り分けて書き込む(flags の bit0 で判定)。
///
/// パイプライン状態(深度比較)はドロー単位でしか変えられないため、クラスの
/// 振り分けは CPU 側で行い、それぞれを別のインスタンスバッファ+別ドローにする。
/// 端数(stride に満たない末尾)は無視し、宛先が足りないクラスは残りを捨てる。
pub fn split_instances_into(surface: &mut [u8], underground: &mut [u8], data: &[f32]) {
    let (mut si, mut ui) = (0usize, 0usize);
    for chunk in data.chunks_exact(INSTANCE_STRIDE_FLOATS) {
        let src: &[u8] = bytemuck::cast_slice(chunk);
        let (dst, at) = if instance_is_underground(chunk) {
            (&mut *underground, &mut ui)
        } else {
            (&mut *surface, &mut si)
        };
        let Some(slot) = dst.get_mut(*at..*at + INSTANCE_STRIDE_BYTES) else {
            continue;
        };
        slot.copy_from_slice(src);
        *at += INSTANCE_STRIDE_BYTES;
    }
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

    /// インスタンス1件を組み立てる(テスト用)。tint は 0..1、flags は bit0=地下。
    fn instance(x: f32, tint: [f32; 3], flags: u32) -> Vec<f32> {
        let mut out = vec![0.0f32; INSTANCE_STRIDE_FLOATS];
        out[0] = x;
        out[INSTANCE_TINT_WORD] = f32::from_bits(pack_tint_and_flags(tint, flags));
        out
    }

    /// stride は 24 バイト = 6 ワード(位置3 + 回転2 + tint/flags 1)。
    /// 旧レイアウト(40バイト)にあった flags 用の f32 と末尾のパディングを畳んだもの。
    #[test]
    fn instance_stride_is_twenty_four_bytes() {
        assert_eq!(INSTANCE_STRIDE_FLOATS, 6);
        assert_eq!(INSTANCE_STRIDE_BYTES, 24);
        assert_eq!(INSTANCE_TINT_WORD, 5);
    }

    /// tint は unorm8x4 の R,G,B へ、flags は使われない A バイトへ詰める。
    #[test]
    fn tint_and_flags_pack_into_one_word() {
        let packed = pack_tint_and_flags([1.0, 0.0, 0.0], 0);
        assert_eq!(packed & 0xff, 255, "R");
        assert_eq!((packed >> 8) & 0xff, 0, "G");
        assert_eq!((packed >> 24) & 0xff, 0, "A(flags)");

        let packed = pack_tint_and_flags([0.0, 0.0, 1.0], INSTANCE_FLAG_UNDERGROUND);
        assert_eq!((packed >> 16) & 0xff, 255, "B");
        assert_eq!((packed >> 24) & 0xff, INSTANCE_FLAG_UNDERGROUND, "A(flags)");
    }

    /// 範囲外の tint はクランプする(NaN も 0 に倒して不正なバイトを作らない)。
    #[test]
    fn tint_is_clamped_to_the_unit_range() {
        assert_eq!(pack_tint_and_flags([2.0, -1.0, f32::NAN], 0) & 0xff_ffff, 0xff);
    }

    #[test]
    fn splits_instances_by_the_underground_flag() {
        let mut data = Vec::new();
        data.extend(instance(1.0, [1.0, 1.0, 1.0], 0)); // instance 0: surface
        data.extend(instance(2.0, [1.0, 1.0, 1.0], INSTANCE_FLAG_UNDERGROUND)); // 1: underground
        data.extend(instance(3.0, [1.0, 1.0, 1.0], 0)); // instance 2: surface
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
    fn instance_buffer_is_reused_while_it_is_big_enough() {
        // 足りていれば作り直さない(毎フレームの GPU バッファ確保を避けるのが目的)
        assert_eq!(instance_buffer_capacity(4096, 4096), None);
        assert_eq!(instance_buffer_capacity(3000, 4096), None);
    }

    #[test]
    fn instance_buffer_grows_to_a_power_of_two() {
        // 少しずつ増えるたびに作り直さないよう、2の冪へ切り上げて余裕を持たせる
        assert_eq!(instance_buffer_capacity(4097, 4096), Some(8192));
        assert_eq!(instance_buffer_capacity(40, 0), Some(64));
    }

    /// 最小容量を下回る要求でも、確保サイズが 0 や極小にならないこと。
    #[test]
    fn instance_buffer_has_a_floor() {
        assert_eq!(instance_buffer_capacity(40, 0), Some(64));
        assert_eq!(instance_buffer_capacity(1, 0), Some(64));
    }

    #[test]
    fn instance_buffer_shrinks_when_far_too_large() {
        // 使用率が1/4を切ったら縮める(列車を大量に売った後などに VRAM を抱え込まない)
        assert_eq!(instance_buffer_capacity(1000, 65536), Some(1024));
        // 1/4 ちょうどは維持(境界で往復しない)
        assert_eq!(instance_buffer_capacity(16384, 65536), None);
    }

    #[test]
    fn instance_buffer_is_released_when_empty() {
        assert_eq!(instance_buffer_capacity(0, 65536), Some(0));
        assert_eq!(instance_buffer_capacity(0, 0), None);
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
