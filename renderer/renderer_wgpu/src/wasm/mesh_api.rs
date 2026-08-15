use super::*;

/// 頂点バッファを「マップ済みで作成 → その領域へ直接交互配置 → unmap」で用意する。
///
/// `create_buffer_init` は中身をいったん呼び出し側の `Vec<u8>` に組んでから
/// コピーするので、その中間バッファ(頂点数×16バイト)を丸ごと省ける。
/// 頂点が0件のときは `None`(呼び出し側でチャンク削除に倒す)。
fn create_interleaved_vertex_buffer(
    device: &wgpu::Device,
    label: &'static str,
    positions: &[f32],
    colours: &[u32],
) -> Option<wgpu::Buffer> {
    let size = interleaved_vertex_bytes(positions, colours);
    if size == 0 {
        return None;
    }
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: size as u64,
        usage: wgpu::BufferUsages::VERTEX,
        mapped_at_creation: true,
    });
    interleave_vertices_into(
        &mut buffer.slice(..).get_mapped_range_mut(),
        positions,
        colours,
    );
    buffer.unmap();
    Some(buffer)
}

/// インスタンスバッファ1本を更新する。容量が足りていればバッファは作り直さず、
/// `write_buffer` で中身だけ差し替える(毎フレームの GPU バッファ確保を避ける)。
fn upload_instance_buffer(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    slot: &mut InstanceBuffer,
    count: usize,
    src: &[u8],
) {
    if let Some(capacity) = instance_buffer_capacity(src.len(), slot.capacity) {
        slot.capacity = capacity;
        slot.buffer = (capacity > 0).then(|| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("instance-data"),
                size: capacity as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        });
    }
    slot.count = count as u32;
    if let (Some(buffer), false) = (slot.buffer.as_ref(), src.is_empty()) {
        queue.write_buffer(buffer, 0, src);
    }
}

#[wasm_bindgen]
impl CanvasRenderer {
    /// R4a: ジオラマ物のメッシュチャンクを1つ登録(同じ id は置き換え)する。
    ///
    /// - `layer_class`: 0=地表(dim で減光) / 1=地下(深度 Always・地下ビュー限定) /
    ///   2=半透明(αは頂点色のA、深度書き込み無しで最後に描く)
    /// - `aabb`: `[min_x,min_y,min_z,max_x,max_y,max_z]`(y はワールド単位)。
    ///   毎フレームこの AABB を等角投影してビューポートと矩形判定し、外れたら描かない。
    /// - `positions`: xyz のフラット配列、`colours`: 頂点ごとの RGBA8(リトルエンディアン
    ///   で R,G,B,A の順)、`indices`: 三角形リストの u32 インデックス。
    ///
    /// 空(インデックス0件)の登録は既存チャンクの削除と同義に扱う。
    #[wasm_bindgen(js_name = uploadMeshChunk)]
    pub fn upload_mesh_chunk(
        &mut self,
        id: u32,
        layer_class: u32,
        aabb: &[f32],
        positions: &[f32],
        colours: &[u32],
        indices: &[u32],
    ) {
        if indices.is_empty() || positions.is_empty() {
            self.mesh_chunks.remove(&id);
            return;
        }
        let Some(vertices) = create_interleaved_vertex_buffer(
            &self.device,
            "mesh-chunk-vertices",
            positions,
            colours,
        ) else {
            self.mesh_chunks.remove(&id);
            return;
        };
        let index_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh-chunk-indices"),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });
        let mut bounds = [0f32; 6];
        bounds[..aabb.len().min(6)].copy_from_slice(&aabb[..aabb.len().min(6)]);
        self.mesh_chunks.insert(
            id,
            MeshChunk {
                vertices,
                indices: index_buffer,
                index_count: indices.len() as u32,
                class: LayerClass::from_u32(layer_class),
                aabb: bounds,
            },
        );
    }

    /// R4a: メッシュチャンクを外す(存在しない id は無視)。
    #[wasm_bindgen(js_name = removeMeshChunk)]
    pub fn remove_mesh_chunk(&mut self, id: u32) {
        self.mesh_chunks.remove(&id);
    }

    /// R4a: インスタンス描画のプロトタイプメッシュを登録(同じ id は置き換え)する。
    /// 頂点色のアルファは「路線色(tint)で塗る重み」として使う(mesh_instanced.wgsl 参照)。
    #[wasm_bindgen(js_name = registerInstancedMesh)]
    pub fn register_instanced_mesh(
        &mut self,
        mesh_id: u32,
        positions: &[f32],
        colours: &[u32],
        indices: &[u32],
    ) {
        if indices.is_empty() || positions.is_empty() {
            self.instanced_meshes.remove(&mesh_id);
            return;
        }
        let Some(vertices) = create_interleaved_vertex_buffer(
            &self.device,
            "instanced-mesh-vertices",
            positions,
            colours,
        ) else {
            self.instanced_meshes.remove(&mesh_id);
            return;
        };
        let index_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("instanced-mesh-indices"),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });
        self.instanced_meshes.insert(
            mesh_id,
            InstancedMesh {
                vertices,
                indices: index_buffer,
                index_count: indices.len() as u32,
                surface: InstanceBuffer::default(),
                underground: InstanceBuffer::default(),
            },
        );
    }

    /// R4a: 登録済みメッシュのインスタンス配列を丸ごと差し替える。
    /// 1インスタンス = `INSTANCE_STRIDE_FLOATS` 個の f32(レイアウトは meshes モジュール参照)。
    /// 未登録の mesh_id は無視する。
    #[wasm_bindgen(js_name = setInstances)]
    pub fn set_instances(&mut self, mesh_id: u32, data: &[f32]) {
        // インスタンス配列は毎フレーム丸ごと差し替わる。GPU バッファを毎回作り直すと
        // 中身の量に関わらず1回あたり数マイクロ秒の固定費がかかるので、容量に余裕が
        // あるかぎり使い回して `write_buffer` で中身だけ差し替える。
        //
        // 振り分けは常設のステージング(`instance_staging`)へ一度で行う。地表を前半、
        // 地下を後半に置いた1本の連続領域なので、そのまま2回の write_buffer に渡せる。
        // ステージングは伸びるだけで、定常状態では確保が起きない。
        let Some(mesh) = self.instanced_meshes.get_mut(&mesh_id) else {
            return;
        };
        let underground_count = underground_instance_count(data);
        let surface_count = data.len() / INSTANCE_STRIDE_FLOATS - underground_count;
        let surface_bytes = surface_count * INSTANCE_STRIDE_BYTES;
        let underground_bytes = underground_count * INSTANCE_STRIDE_BYTES;

        if self.instance_staging.len() < surface_bytes + underground_bytes {
            self.instance_staging
                .resize(surface_bytes + underground_bytes, 0);
        }
        {
            let (surface_dst, rest) = self.instance_staging.split_at_mut(surface_bytes);
            split_instances_into(surface_dst, &mut rest[..underground_bytes], data);
        }

        let (surface_src, underground_src) = self.instance_staging
            [..surface_bytes + underground_bytes]
            .split_at(surface_bytes);
        upload_instance_buffer(
            &self.device,
            &self.queue,
            &mut mesh.surface,
            surface_count,
            surface_src,
        );
        upload_instance_buffer(
            &self.device,
            &self.queue,
            &mut mesh.underground,
            underground_count,
            underground_src,
        );
    }

}
