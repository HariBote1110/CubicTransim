use super::*;
use quarterview_terrain_core::clipmap::{tile_cell_span, TileKey};

impl CanvasRenderer {
    pub(super) fn create_gpu_tile(&self, key: TileKey, encoder: &mut wgpu::CommandEncoder) -> GpuTile {
        let origin_x = key.x * tile_cell_span(key.lod);
        let origin_z = key.z * tile_cell_span(key.lod);
        let stride = 1i32 << key.lod;
        let samples = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("terrain-tile-samples"),
            size: TILE_BYTES,
            // COPY_SRC: debugReadTileSamples がライブ状態の読み戻し検証に使う。
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        // R2: このタイルが実際にサンプルする範囲へ重なる編集オーバーレイだけを、
        // local_index昇順のソート済みフラット配列へ変換する(build_tile_overrides の
        // LOD一貫性規則を参照)。tile_generate.wgsl はこれを二分探索する。
        let override_entries =
            build_tile_overrides(&self.overrides, origin_x, origin_z, stride, GRID as i32);
        let override_count = (override_entries.len() / 2) as u32;
        let override_buffer_contents: Vec<u8> = if override_entries.is_empty() {
            vec![0u8; 8]
        } else {
            override_entries
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect()
        };
        let overrides_buf = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-tile-overrides"),
                contents: &override_buffer_contents,
                usage: wgpu::BufferUsages::STORAGE,
            });
        let mut params = Vec::with_capacity(32);
        push_u32(&mut params, self.seed);
        push_i32(&mut params, self.half_extent);
        push_i32(&mut params, origin_x);
        push_i32(&mut params, origin_z);
        push_i32(&mut params, stride);
        push_u32(&mut params, GRID);
        push_u32(&mut params, override_count);
        push_u32(&mut params, 0);
        // プロファイル別の標高しきい値(hi,lo × 10)。シェーダ側はプロファイル分岐を持たない。
        for word in self.profile.threshold_words() {
            push_u32(&mut params, word);
        }
        let params = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-tile-params"),
                contents: &params,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let compute_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("terrain-tile-compute-bg"),
            layout: &self.tile_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: overrides_buf.as_entire_binding(),
                },
            ],
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("terrain-tile-generate"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.tile_pipeline);
            pass.set_bind_group(0, &compute_bg, &[]);
            pass.dispatch_workgroups((GRID * GRID + 255) / 256, 1, 1);
        }

        let mut finalize_params_bytes = [0u8; 16];
        put_u32(&mut finalize_params_bytes, 0, GRID);
        let finalize_params =
            self.device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("terrain-tile-finalize-params"),
                    contents: &finalize_params_bytes,
                    usage: wgpu::BufferUsages::UNIFORM,
                });
        let cliff_edges = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("terrain-cliff-edges"),
            size: (MAX_CLIFF_EDGES * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let water_cells = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("terrain-water-cells"),
            size: (MAX_WATER_CELLS * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let base_vertices = INDEX_COUNT_PER_TILE;
        // words: [vertex_count, instance_count, first_vertex, first_instance,
        //         cliff_vertices, water_vertices, pad, pad, diagnostics x4]
        let render_args_bytes = [
            base_vertices,
            1u32,
            0u32,
            0u32,
            0u32,
            0u32,
            0u32,
            0u32,
            0u32,
            0u32,
            0u32,
            0u32,
        ];
        let render_args = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-render-indirect-args"),
                contents: bytemuck::cast_slice(&render_args_bytes),
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::INDIRECT
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
            });
        debug_assert_eq!(render_args.size(), RENDER_ARGS_TOTAL_BYTES);
        let finalize_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("terrain-tile-finalize-bg"),
            layout: &self.finalize_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: finalize_params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: cliff_edges.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: water_cells.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: render_args.as_entire_binding(),
                },
            ],
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("terrain-tile-finalize"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.finalize_pipeline);
            pass.set_bind_group(0, &finalize_bg, &[]);
            pass.dispatch_workgroups(((GRID - 1) * (GRID - 1) + 255) / 256, 1, 1);
        }
        {
            let clamp_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-tile-clamp-args-bg"),
                layout: &self.clamp_bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.clamp_params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: render_args.as_entire_binding(),
                    },
                ],
            });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("terrain-tile-clamp-args"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.clamp_pipeline);
            pass.set_bind_group(0, &clamp_bg, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        }
        let render_counts = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("terrain-render-counts"),
            size: RENDER_COUNTS_BYTES,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(&render_args, 0, &render_counts, 0, RENDER_COUNTS_BYTES);

        let mut tile_bytes = [0u8; 16];
        put_i32(&mut tile_bytes, 0, origin_x);
        put_i32(&mut tile_bytes, 4, origin_z);
        put_i32(&mut tile_bytes, 8, stride);
        put_u32(&mut tile_bytes, 12, GRID);
        let tile_params = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-tile-draw-params"),
                contents: &tile_bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let draw_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("terrain-draw-bg"),
            layout: &self.draw_bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: tile_params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: samples.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: cliff_edges.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: water_cells.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: render_counts.as_entire_binding(),
                },
            ],
        });
        GpuTile {
            samples,
            _tile_params: tile_params,
            _cliff_edges: cliff_edges,
            _water_cells: water_cells,
            render_args,
            _render_counts: render_counts,
            _overrides: overrides_buf,
            draw_bind_group,
            last_used: self.frame_index,
            debug_overrides: override_entries.clone(),
        }
    }

    pub(super) fn prune_lru(&mut self) {
        if self.tiles.len() <= MAX_RESIDENT_TILES {
            return;
        }
        let remove_count = self.tiles.len() - MAX_RESIDENT_TILES;
        let mut ages: Vec<(TileKey, u64)> =
            self.tiles.iter().map(|(&k, v)| (k, v.last_used)).collect();
        ages.sort_unstable_by_key(|(_, age)| *age);
        for (key, _) in ages.into_iter().take(remove_count) {
            self.tiles.remove(&key);
        }
    }

    /// 編集オーバーレイのチャンク(chunk_x,chunk_z)に触れうる常駐タイルをキャッシュから
    /// 外す(全LODが対象。スナップ許容 ±stride/2 も bbox に含める)。次フレームの
    /// visible/needed 選択に載れば create_gpu_tile が最新のオーバーレイで再生成する
    /// (T8: 影響タイルだけの再生成であり全タイル再構築ではない)。
    pub(super) fn invalidate_chunk(&mut self, chunk_x: i32, chunk_z: i32) {
        let cx0 = chunk_x * crate::edits::OVERLAY_CHUNK_SIZE;
        let cx1 = cx0 + crate::edits::OVERLAY_CHUNK_SIZE - 1;
        let cz0 = chunk_z * crate::edits::OVERLAY_CHUNK_SIZE;
        let cz1 = cz0 + crate::edits::OVERLAY_CHUNK_SIZE - 1;
        self.tiles.retain(|&key, _| {
            let stride = 1i32 << key.lod;
            let origin_x = key.x * tile_cell_span(key.lod);
            let origin_z = key.z * tile_cell_span(key.lod);
            let (tx0, tx1, tz0, tz1) =
                tile_world_bounds_for(origin_x, origin_z, stride, GRID as i32);
            !(tx0 <= cx1 && tx1 >= cx0 && tz0 <= cz1 && tz1 >= cz0)
        });
    }
}
