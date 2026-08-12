use super::*;

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
        let vertex_bytes = interleave_vertices(positions, colours);
        if vertex_bytes.is_empty() {
            self.mesh_chunks.remove(&id);
            return;
        }
        let vertices = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh-chunk-vertices"),
                contents: &vertex_bytes,
                usage: wgpu::BufferUsages::VERTEX,
            });
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
        let vertex_bytes = interleave_vertices(positions, colours);
        if vertex_bytes.is_empty() {
            self.instanced_meshes.remove(&mesh_id);
            return;
        }
        let vertices = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("instanced-mesh-vertices"),
                contents: &vertex_bytes,
                usage: wgpu::BufferUsages::VERTEX,
            });
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
                surface: None,
                underground: None,
            },
        );
    }

    /// R4a: 登録済みメッシュのインスタンス配列を丸ごと差し替える。
    /// 1インスタンス = `INSTANCE_STRIDE_FLOATS` 個の f32(レイアウトは meshes モジュール参照)。
    /// 未登録の mesh_id は無視する。
    #[wasm_bindgen(js_name = setInstances)]
    pub fn set_instances(&mut self, mesh_id: u32, data: &[f32]) {
        let (surface_bytes, underground_bytes) = split_instances_by_class(data);
        let make = |device: &wgpu::Device, bytes: &[u8]| -> Option<(wgpu::Buffer, u32)> {
            if bytes.is_empty() {
                return None;
            }
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("instance-data"),
                contents: bytes,
                usage: wgpu::BufferUsages::VERTEX,
            });
            Some((buffer, (bytes.len() / INSTANCE_STRIDE_BYTES) as u32))
        };
        let surface = make(&self.device, &surface_bytes);
        let underground = make(&self.device, &underground_bytes);
        if let Some(mesh) = self.instanced_meshes.get_mut(&mesh_id) {
            mesh.surface = surface;
            mesh.underground = underground;
        }
    }

}
