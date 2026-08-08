pub const TILE_SAMPLES: i32 = 256;
pub const MAX_LOD: u8 = 6; // 256 * 2^6 = 16384 cells per top-level tile

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileKey {
    pub lod: u8,
    pub x: i32,
    pub z: i32,
}

#[derive(Debug, Clone, Copy)]
pub struct ViewRequest {
    pub center_x: f64,
    pub center_z: f64,
    /// Horizontal viewport span expressed in level-0 cells.
    pub span_x_cells: f64,
    /// Vertical viewport span expressed in level-0 cells. For quarter-view callers this
    /// should already include the conservative rotation/isometric expansion.
    pub span_z_cells: f64,
    /// Approximate projected size of one level-0 cell in pixels.
    pub pixels_per_cell: f64,
    pub half_extent: i32,
    /// One-tile prefetch border prevents blank tiles while panning.
    pub prefetch_border: i32,
}

#[inline]
pub fn lod_for_pixels_per_cell(pixels_per_cell: f64) -> u8 {
    if !pixels_per_cell.is_finite() || pixels_per_cell <= 0.0 {
        return MAX_LOD;
    }
    // Keep roughly >=2 px between retained samples at zoomed-out levels. At high zoom this selects LOD0;
    // zooming out doubles sample stride at powers of two.
    let target_stride = (2.0 / pixels_per_cell).max(1.0);
    target_stride.log2().ceil().clamp(0.0, MAX_LOD as f64) as u8
}

#[inline]
pub const fn tile_cell_span(lod: u8) -> i32 {
    TILE_SAMPLES << lod
}

pub fn select_tiles(view: ViewRequest) -> Vec<TileKey> {
    let mut out = Vec::new();
    select_tiles_into(view, &mut out);
    out
}

pub fn select_tiles_into(view: ViewRequest, out: &mut Vec<TileKey>) {
    out.clear();
    let lod = lod_for_pixels_per_cell(view.pixels_per_cell);
    let tile_span = tile_cell_span(lod) as f64;
    let world_min = -(view.half_extent as f64);
    let world_max = view.half_extent as f64;

    let min_x = (view.center_x - view.span_x_cells * 0.5).max(world_min);
    let max_x = (view.center_x + view.span_x_cells * 0.5).min(world_max);
    let min_z = (view.center_z - view.span_z_cells * 0.5).max(world_min);
    let max_z = (view.center_z + view.span_z_cells * 0.5).min(world_max);

    if min_x > max_x || min_z > max_z {
        return;
    }

    // Tile coordinates are anchored at world 0 and may be negative. floor is required.
    let mut tx0 = (min_x / tile_span).floor() as i32 - view.prefetch_border;
    let mut tx1 = (max_x / tile_span).floor() as i32 + view.prefetch_border;
    let mut tz0 = (min_z / tile_span).floor() as i32 - view.prefetch_border;
    let mut tz1 = (max_z / tile_span).floor() as i32 + view.prefetch_border;

    let map_tx0 = (world_min / tile_span).floor() as i32;
    let map_tx1 = (world_max / tile_span).floor() as i32;
    let map_tz0 = map_tx0;
    let map_tz1 = map_tx1;
    tx0 = tx0.max(map_tx0);
    tx1 = tx1.min(map_tx1);
    tz0 = tz0.max(map_tz0);
    tz1 = tz1.min(map_tz1);

    let capacity = ((tx1 - tx0 + 1).max(0) * (tz1 - tz0 + 1).max(0)) as usize;
    if out.capacity() < capacity {
        // Vec::reserve takes additional elements relative to len, not capacity.
        // `out` was just cleared, so reserve the full desired capacity here; otherwise
        // a 20 -> 30 growth request could no-op and reallocate during push().
        out.reserve(capacity);
    }
    for tx in tx0..=tx1 {
        for tz in tz0..=tz1 {
            out.push(TileKey { lod, x: tx, z: tz });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_selects_monotonic_lod() {
        assert_eq!(lod_for_pixels_per_cell(100.0), 0);
        assert_eq!(lod_for_pixels_per_cell(2.0), 0);
        assert_eq!(lod_for_pixels_per_cell(1.0), 1);
        assert!(lod_for_pixels_per_cell(0.1) >= 2);
        assert_eq!(lod_for_pixels_per_cell(0.00001), MAX_LOD);
    }

    #[test]
    fn full_16k_view_collapses_to_small_top_level_set() {
        let tiles = select_tiles(ViewRequest {
            center_x: 0.0,
            center_z: 0.0,
            span_x_cells: 16_384.0,
            span_z_cells: 16_384.0,
            pixels_per_cell: 1600.0 / 16_384.0,
            half_extent: 8192,
            prefetch_border: 0,
        });
        assert!(
            tiles.len() <= 81,
            "too many tiles for full-map view: {}",
            tiles.len()
        );
        assert!(tiles.iter().all(|t| t.lod >= 2));
    }

    #[test]
    fn selection_is_deterministic() {
        let view = ViewRequest {
            center_x: 123.25,
            center_z: -456.5,
            span_x_cells: 800.0,
            span_z_cells: 600.0,
            pixels_per_cell: 2.0,
            half_extent: 8192,
            prefetch_border: 1,
        };
        assert_eq!(select_tiles(view), select_tiles(view));
    }
}
