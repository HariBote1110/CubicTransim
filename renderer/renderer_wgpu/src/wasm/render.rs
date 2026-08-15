use super::*;

#[wasm_bindgen]
impl CanvasRenderer {
    pub fn render(&mut self) -> Result<String, JsValue> {
        let cpu_started = js_sys::Date::now();
        self.frame_index = self.frame_index.wrapping_add(1);

        // The draw set has no border; a second selection with a one-tile border is generated
        // ahead of time so panning does not expose blank terrain.
        let projected_span =
            (self.config.width as f64 + self.config.height as f64 * 2.0) / self.pixels_per_cell;
        let base_view = ViewRequest {
            center_x: self.center_x,
            center_z: self.center_z,
            span_x_cells: projected_span,
            span_z_cells: projected_span,
            pixels_per_cell: self.pixels_per_cell,
            half_extent: self.half_extent,
            prefetch_border: 0,
        };
        select_tiles_into(base_view, &mut self.visible);
        let mut prefetch_view = base_view;
        prefetch_view.prefetch_border = 1;
        select_tiles_into(prefetch_view, &mut self.needed);

        let frame = self
            .surface
            .get_current_texture()
            .map_err(|e| JsValue::from_str(&format!("surface frame: {e}")))?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("quarterview-frame"),
            });

        let mut generated = 0usize;
        let param_updates = 1usize;
        // R4a: この1フレームで実際に発行したジオラマ物のドロー数(perf JSON へ出す)。
        let mut mesh_draws = 0usize;
        let mut instance_draws = 0usize;
        // Visible tiles are hard priority. Prefetch is best-effort and budgeted so the
        // first frame never synchronously generates the whole one-tile border.
        for i in 0..self.visible.len() {
            let key = self.visible[i];
            if !self.tiles.contains_key(&key) {
                if generated >= MAX_NEW_TILES_PER_FRAME {
                    break;
                }
                let tile = self.create_gpu_tile(key, &mut encoder);
                self.tiles.insert(key, tile);
                generated += 1;
            }
            if let Some(tile) = self.tiles.get_mut(&key) {
                tile.last_used = self.frame_index;
            }
        }
        for i in 0..self.needed.len() {
            if generated >= MAX_NEW_TILES_PER_FRAME {
                break;
            }
            let key = self.needed[i];
            if !self.tiles.contains_key(&key) {
                let tile = self.create_gpu_tile(key, &mut encoder);
                self.tiles.insert(key, tile);
                generated += 1;
            }
            if let Some(tile) = self.tiles.get_mut(&key) {
                tile.last_used = self.frame_index;
            }
        }

        let width = self.config.width as f32;
        let height = self.config.height as f32;
        let mut camera_bytes = [0u8; 32];
        put_f32(&mut camera_bytes, 0, self.center_x as f32);
        put_f32(&mut camera_bytes, 4, self.center_z as f32);
        put_f32(&mut camera_bytes, 8, self.pixels_per_cell as f32);
        put_f32(
            &mut camera_bytes,
            12,
            (self.pixels_per_cell * ISO_H * self.height_per_level) as f32,
        );
        put_f32(&mut camera_bytes, 16, width);
        put_f32(&mut camera_bytes, 20, height);
        put_f32(&mut camera_bytes, 24, self.half_extent as f32);
        put_f32(&mut camera_bytes, 28, self.dim as f32);
        self.queue
            .write_buffer(&self.camera_buffer, 0, &camera_bytes);

        // D1: 透視投影カメラ uniform(mode==Perspective のときだけ実際に使われるが、
        // 書き込み自体は毎フレーム軽いのでガード無しで行う)。
        let aspect = (self.config.width.max(1) as f64) / (self.config.height.max(1) as f64);
        let persp_vp = crate::perspective::view_proj(
            [
                self.persp_eye[0] as f32,
                self.persp_eye[1] as f32,
                self.persp_eye[2] as f32,
            ],
            [
                self.persp_look[0] as f32,
                self.persp_look[1] as f32,
                self.persp_look[2] as f32,
            ],
            self.persp_fov_y as f32,
            aspect as f32,
            PERSP_NEAR as f32,
            PERSP_DRAW_RADIUS as f32,
        );
        let eye_underground = self.persp_eye[1] < 0.0;
        let sky = if eye_underground {
            [0.02f32, 0.02, 0.03]
        } else {
            [0.53, 0.75, 0.93]
        };
        let mut persp_bytes = [0u8; 96];
        persp_bytes[0..64].copy_from_slice(bytemuck::bytes_of(&persp_vp));
        put_f32(&mut persp_bytes, 64, self.persp_eye[0] as f32);
        put_f32(&mut persp_bytes, 68, self.persp_eye[1] as f32);
        put_f32(&mut persp_bytes, 72, self.persp_eye[2] as f32);
        put_f32(&mut persp_bytes, 76, PERSP_DRAW_RADIUS as f32);
        put_f32(&mut persp_bytes, 80, sky[0]);
        put_f32(&mut persp_bytes, 84, sky[1]);
        put_f32(&mut persp_bytes, 88, sky[2]);
        put_f32(&mut persp_bytes, 92, 1.0);
        self.queue
            .write_buffer(&self.persp_camera_buffer, 0, &persp_bytes);

        let clear_colour = if self.mode == CameraMode::Perspective {
            wgpu::Color {
                r: sky[0] as f64,
                g: sky[1] as f64,
                b: sky[2] as f64,
                a: 1.0,
            }
        } else {
            wgpu::Color {
                r: 0.604,
                g: 0.722,
                b: 0.435,
                a: 1.0,
            }
        };

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("quarterview-terrain-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(clear_colour),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if self.mode == CameraMode::Quarter {
                // --- クォータービュー(既存経路、バイト単位で無改造) ---
                pass.set_pipeline(&self.draw_pipeline);
                pass.set_bind_group(1, &self.camera_bind_group, &[]);
                for &key in &self.visible {
                    if let Some(tile) = self.tiles.get(&key) {
                        pass.set_bind_group(0, &tile.draw_bind_group, &[]);
                        pass.draw_indirect(&tile.render_args, 0);
                    }
                }

                // --- R4a: ジオラマ物(メッシュチャンク+インスタンス) ---
                // 描画順は 地表(不透明) → 地表インスタンス → 地下 → 地下インスタンス →
                // 半透明。地下クラスは深度比較 Always で地形の上に出るため、地下ビュー
                // (dim<1.0)以外では丸ごと描かない(three.js 側で通常表示時に地下の
                // ジオメトリを出さないのと同じ規則)。
                let cull = CullCamera {
                    centre_x: self.center_x,
                    centre_z: self.center_z,
                    pixels_per_cell: self.pixels_per_cell,
                    viewport_w: self.config.width as f64,
                    viewport_h: self.config.height as f64,
                };
                let underground_visible = self.dim < 1.0;
                pass.set_bind_group(0, &self.mesh_camera_bind_group, &[]);

                let draw_class = |pass: &mut wgpu::RenderPass<'_>, class: LayerClass| {
                    let slot = class.as_u32() as usize;
                    pass.set_pipeline(&self.mesh_pipelines[slot]);
                    pass.set_bind_group(1, &self.class_bind_groups[slot], &[]);
                    let mut drawn = 0usize;
                    for chunk in self.mesh_chunks.values() {
                        if chunk.class != class || !aabb_visible(&chunk.aabb, cull) {
                            continue;
                        }
                        pass.set_vertex_buffer(0, chunk.vertices.slice(..));
                        pass.set_index_buffer(chunk.indices.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..chunk.index_count, 0, 0..1);
                        drawn += 1;
                    }
                    drawn
                };
                mesh_draws += draw_class(&mut pass, LayerClass::Surface);
                instance_draws += self.draw_instances(&mut pass, LayerClass::Surface);
                if underground_visible {
                    mesh_draws += draw_class(&mut pass, LayerClass::Underground);
                    instance_draws += self.draw_instances(&mut pass, LayerClass::Underground);
                }
                // 地上ビューの地下ゴースト。存在するかどうかは TS 側のフィーダが
                // 決める(地下ビュー中はチャンクを載せない)ので、ここでは条件を持たない。
                mesh_draws += draw_class(&mut pass, LayerClass::UndergroundGhost);
                mesh_draws += draw_class(&mut pass, LayerClass::Translucent);
            } else {
                // --- D1: 透視投影(乗客視点スパイク) ---
                // 地形は個別のドロー機構を持たない: TS 側が cellCornerHeights から
                // 焼いた通常のメッシュチャンク(Surfaceクラス)として届く前提で、
                // ここでは iso 用の tile indirect draw を一切呼ばない。
                pass.set_bind_group(0, &self.persp_camera_bind_group, &[]);
                let underground_visible = eye_underground;

                let draw_class_persp = |pass: &mut wgpu::RenderPass<'_>, class: LayerClass| {
                    let slot = class.as_u32() as usize;
                    pass.set_pipeline(&self.persp_mesh_pipelines[slot]);
                    pass.set_bind_group(1, &self.class_bind_groups[slot], &[]);
                    let mut drawn = 0usize;
                    for chunk in self.mesh_chunks.values() {
                        if chunk.class != class || !crate::perspective::aabb_visible_persp(&chunk.aabb, &persp_vp) {
                            continue;
                        }
                        pass.set_vertex_buffer(0, chunk.vertices.slice(..));
                        pass.set_index_buffer(chunk.indices.slice(..), wgpu::IndexFormat::Uint32);
                        pass.draw_indexed(0..chunk.index_count, 0, 0..1);
                        drawn += 1;
                    }
                    drawn
                };
                mesh_draws += draw_class_persp(&mut pass, LayerClass::Surface);
                instance_draws += self.draw_instances_persp(&mut pass, LayerClass::Surface);
                if underground_visible {
                    mesh_draws += draw_class_persp(&mut pass, LayerClass::Underground);
                    instance_draws += self.draw_instances_persp(&mut pass, LayerClass::Underground);
                }
                // 半透明は最後(depth書き込み無し)。地下ゴーストはクォータービュー
                // 固有の演出なので透視パスでは描かない(D2以降のスコープ)。
                mesh_draws += draw_class_persp(&mut pass, LayerClass::Translucent);
            }
        }
        self.queue.submit(Some(encoder.finish()));
        frame.present();
        self.prune_lru();

        let cpu_ms = js_sys::Date::now() - cpu_started;
        let lod = self.visible.first().map(|t| t.lod).unwrap_or(0);
        // drawCalls は従来どおり地形タイルのドロー数(既存の計測・ゲートとの互換のため)。
        // R4a のジオラマ物は meshDrawCalls / instancedDrawCalls として別に出す。
        Ok(format!(
            "{{\"cpuMs\":{cpu_ms:.3},\"cfgW\":{},\"cfgH\":{},\"heightScale\":{:.3},\"halfExtent\":{},\"drawCalls\":{},\"visibleTiles\":{},\"generatedTiles\":{generated},\"paramUpdates\":{param_updates},\"residentTiles\":{},\"tileGpuBytes\":{},\"lod\":{lod},\"centerX\":{:.3},\"centerZ\":{:.3},\"pixelsPerCell\":{:.5},\"meshChunks\":{},\"meshDrawCalls\":{mesh_draws},\"instancedMeshes\":{},\"instancedDrawCalls\":{instance_draws}}}",
            self.config.width, self.config.height,
            self.pixels_per_cell * ISO_H * self.height_per_level, self.half_extent,
            self.visible.len(), self.visible.len(), self.tiles.len(), self.tiles.len() as u64 * TILE_BYTES,
            self.center_x, self.center_z, self.pixels_per_cell,
            self.mesh_chunks.len(), self.instanced_meshes.len(),
        ))
    }
}

impl CanvasRenderer {
    /// R4a: 登録済みインスタンスメッシュのうち、指定クラスのインスタンス群を描く。
    /// 戻り値は発行したドロー数(メッシュ1つにつき1インスタンスドロー)。
    fn draw_instances(&self, pass: &mut wgpu::RenderPass<'_>, class: LayerClass) -> usize {
        let slot = match class {
            LayerClass::Underground => 1,
            _ => 0,
        };
        pass.set_pipeline(&self.instanced_pipelines[slot]);
        pass.set_bind_group(1, &self.class_bind_groups[class.as_u32() as usize], &[]);
        let mut draws = 0usize;
        for mesh in self.instanced_meshes.values() {
            let instances = match class {
                LayerClass::Underground => mesh.underground.draw(),
                _ => mesh.surface.draw(),
            };
            let Some((buffer, count)) = instances else {
                continue;
            };
            pass.set_vertex_buffer(0, mesh.vertices.slice(..));
            pass.set_vertex_buffer(1, buffer.slice(..));
            pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..mesh.index_count, 0, 0..count);
            draws += 1;
        }
        draws
    }

    /// D1: `draw_instances` の透視投影版(persp_instanced_pipelines を使うだけの違い)。
    fn draw_instances_persp(&self, pass: &mut wgpu::RenderPass<'_>, class: LayerClass) -> usize {
        let slot = match class {
            LayerClass::Underground => 1,
            _ => 0,
        };
        pass.set_pipeline(&self.persp_instanced_pipelines[slot]);
        pass.set_bind_group(1, &self.class_bind_groups[class.as_u32() as usize], &[]);
        let mut draws = 0usize;
        for mesh in self.instanced_meshes.values() {
            let instances = match class {
                LayerClass::Underground => mesh.underground.draw(),
                _ => mesh.surface.draw(),
            };
            let Some((buffer, count)) = instances else {
                continue;
            };
            pass.set_vertex_buffer(0, mesh.vertices.slice(..));
            pass.set_vertex_buffer(1, buffer.slice(..));
            pass.set_index_buffer(mesh.indices.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..mesh.index_count, 0, 0..count);
            draws += 1;
        }
        draws
    }
}
