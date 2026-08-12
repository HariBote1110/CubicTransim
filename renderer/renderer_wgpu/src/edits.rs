use std::collections::HashMap;

/// terrainOverlay.ts の OVERLAY_CHUNK_SIZE と同じ値(コーナー座標のチャンク分割単位)。
pub const OVERLAY_CHUNK_SIZE: i32 = 64;

/// 1タイルへ転送するオーバーライドの上限(local_index 昇順ソート後、先頭からこの件数まで
/// 採用する)。現実的な1回の盛土/切土(矩形+段差1以下伝播)は数百コーナー程度なので、
/// この上限は十分に余裕がある(シェーダ側の二分探索コストは log2(N) なので上限を
/// 大きく取ってもコストはほぼ変わらない)。
pub const MAX_TILE_OVERRIDES: usize = 16_384;

/// コーナー編集の全体ストア。`chunkKey=(cx,cz) -> (localIndex -> height)`。
/// terrainOverlay.ts の `CornerDiffs`(`Map<string, Map<number, number>>`)と同じ
/// 2段構成をミラーする。localIndex の並び順(`lx*OVERLAY_CHUNK_SIZE+lz`)も一致させる。
pub type OverrideChunks = HashMap<(i32, i32), HashMap<u32, u8>>;

const fn div_floor(v: i32, d: i32) -> i32 {
    v.div_euclid(d)
}

/// タイル(origin_x,origin_z,stride,grid)がワールド上で覆いうるコーナー範囲
/// (LOD>0のスナップ許容分 ±stride/2 を含む)。invalidate 判定・overrides 収集の
/// 両方で使う共通のバウンディングボックス。
pub fn tile_world_bounds_for(
    origin_x: i32,
    origin_z: i32,
    stride: i32,
    grid: i32,
) -> (i32, i32, i32, i32) {
    let half = stride / 2;
    let span = stride * (grid - 1);
    (
        origin_x - half,
        origin_x + span + half,
        origin_z - half,
        origin_z + span + half,
    )
}

/// あるタイルに適用すべきオーバーライドを、シェーダの二分探索に載せられる形
/// (local_index 昇順にソートしたフラット配列
/// `[local_index0, height0, local_index1, height1, ...]`、`local_index = lx*grid+lz`
/// で tile_generate.wgsl のスレッド添字 `i` と一致する)へ変換する。
///
/// **LOD一貫性規則**: `stride=1`(LOD0)では厳密一致のみを採用する
/// (`createEditedTerrainField` の `Math.round` + 完全一致と同じ挙動、これが唯一の
/// 「正しさ」契約)。`stride>1`(粗いLOD)では、編集されたコーナーをそのタイルが実際に
/// サンプルする最も近い格子点(世界座標で ±stride/2 以内)へスナップして適用する。
/// これにより遠景ズームでも編集地形が消えずに見える(スナップ位置は最大 stride/2 セル
/// ずれうるが、これは表示上の近似であり正しさの契約はLOD0にのみ課す)。
/// 複数の編集コーナーが同じ粗いサンプル点へスナップする場合は、距離が最も近いものを
/// 採用し、同距離なら x→z の昇順で決定的にタイブレークする(HashMap の走査順に依存しない
/// 決定性を保証する。A8: 同一シード・同一カメラ経路での出力バイト一致に必要)。
pub fn build_tile_overrides(
    overrides: &OverrideChunks,
    origin_x: i32,
    origin_z: i32,
    stride: i32,
    grid: i32,
) -> Vec<u32> {
    if overrides.is_empty() {
        return Vec::new();
    }
    let (x_lo, x_hi, z_lo, z_hi) = tile_world_bounds_for(origin_x, origin_z, stride, grid);
    let cx0 = div_floor(x_lo, OVERLAY_CHUNK_SIZE);
    let cx1 = div_floor(x_hi, OVERLAY_CHUNK_SIZE);
    let cz0 = div_floor(z_lo, OVERLAY_CHUNK_SIZE);
    let cz1 = div_floor(z_hi, OVERLAY_CHUNK_SIZE);

    // (local_index, dist_sq, x, z, height) の候補を集め、距離→座標の順で決定的に
    // ソートしてからタイブレークする。
    let mut candidates: Vec<(u32, i64, i32, i32, u8)> = Vec::new();
    let span = stride * (grid - 1);
    let half = stride / 2;
    for cx in cx0..=cx1 {
        for cz in cz0..=cz1 {
            let Some(chunk) = overrides.get(&(cx, cz)) else {
                continue;
            };
            for (&local_index, &height) in chunk {
                let lx_local = (local_index / OVERLAY_CHUNK_SIZE as u32) as i32;
                let lz_local = (local_index % OVERLAY_CHUNK_SIZE as u32) as i32;
                let x = cx * OVERLAY_CHUNK_SIZE + lx_local;
                let z = cz * OVERLAY_CHUNK_SIZE + lz_local;
                let rel_x = x - origin_x;
                let rel_z = z - origin_z;
                if rel_x < -half || rel_x > span + half {
                    continue;
                }
                if rel_z < -half || rel_z > span + half {
                    continue;
                }
                let snapped_lx = ((rel_x as f64) / (stride as f64)).round() as i32;
                let snapped_lz = ((rel_z as f64) / (stride as f64)).round() as i32;
                if snapped_lx < 0 || snapped_lx >= grid || snapped_lz < 0 || snapped_lz >= grid
                {
                    continue;
                }
                let sample_x = origin_x + snapped_lx * stride;
                let sample_z = origin_z + snapped_lz * stride;
                let dx = (x - sample_x) as i64;
                let dz = (z - sample_z) as i64;
                let dist_sq = dx * dx + dz * dz;
                let local_i = (snapped_lx as u32) * (grid as u32) + snapped_lz as u32;
                candidates.push((local_i, dist_sq, x, z, height));
            }
        }
    }
    candidates.sort_unstable_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(&b.3))
    });
    let mut out = Vec::new();
    let mut last: Option<u32> = None;
    for (local_i, _, _, _, height) in candidates {
        if Some(local_i) == last {
            continue;
        }
        last = Some(local_i);
        out.push(local_i);
        out.push(height as u32);
        if out.len() / 2 >= MAX_TILE_OVERRIDES {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk_of(diffs: &mut OverrideChunks, cx: i32, cz: i32) -> &mut HashMap<u32, u8> {
        diffs.entry((cx, cz)).or_default()
    }

    #[test]
    fn lod0_exact_match_only() {
        let mut diffs = OverrideChunks::new();
        // corner (10, 20) raised to height 5.
        chunk_of(&mut diffs, 0, 0).insert(10 * OVERLAY_CHUNK_SIZE as u32 + 20, 5);
        let out = build_tile_overrides(&diffs, 0, 0, 1, 257);
        assert_eq!(out, vec![10u32 * 257 + 20, 5]);
    }

    #[test]
    fn empty_overrides_produce_empty_output() {
        let diffs = OverrideChunks::new();
        assert!(build_tile_overrides(&diffs, 0, 0, 1, 257).is_empty());
    }

    #[test]
    fn coarse_lod_snaps_to_nearest_sample() {
        let mut diffs = OverrideChunks::new();
        // corner (3, 0) raised; at stride=4 the nearest sample is local (1,0) -> world (4,0).
        chunk_of(&mut diffs, 0, 0).insert(3 * OVERLAY_CHUNK_SIZE as u32 + 0, 7);
        let out = build_tile_overrides(&diffs, 0, 0, 4, 257);
        assert_eq!(out, vec![1u32 * 257 + 0, 7]);
    }

    #[test]
    fn collision_picks_nearest_deterministically() {
        let mut diffs = OverrideChunks::new();
        // Both (3,0) and (5,0) snap to local (1,0) at stride=4; (3,0) is nearer to
        // world x=4 (distance 1) than (5,0) (distance 1) -- tie, so x-ascending wins (3,0).
        chunk_of(&mut diffs, 0, 0).insert(3 * OVERLAY_CHUNK_SIZE as u32 + 0, 7);
        chunk_of(&mut diffs, 0, 0).insert(5 * OVERLAY_CHUNK_SIZE as u32 + 0, 9);
        let out = build_tile_overrides(&diffs, 0, 0, 4, 257);
        assert_eq!(out, vec![1u32 * 257 + 0, 7]);
    }

    #[test]
    fn deterministic_regardless_of_insertion_order() {
        let mut a = OverrideChunks::new();
        chunk_of(&mut a, 0, 0).insert(1, 2);
        chunk_of(&mut a, 0, 0).insert(5, 6);
        chunk_of(&mut a, -1, 0).insert(63 * OVERLAY_CHUNK_SIZE as u32 + 63, 3);
        let mut b = OverrideChunks::new();
        chunk_of(&mut b, -1, 0).insert(63 * OVERLAY_CHUNK_SIZE as u32 + 63, 3);
        chunk_of(&mut b, 0, 0).insert(5, 6);
        chunk_of(&mut b, 0, 0).insert(1, 2);
        assert_eq!(
            build_tile_overrides(&a, -10, -10, 2, 257),
            build_tile_overrides(&b, -10, -10, 2, 257)
        );
    }
}
