//! Quarter-view WebGPU renderer prototype.
//!
//! The browser and headless paths share the same WGSL terrain generator.  The wasm
//! renderer keeps only visible/prefetched height tiles resident, generates missing
//! tiles with compute, then vertex-pulls the packed height/water buffer directly.

pub const TERRAIN_NOISE_WGSL: &str = include_str!("../shaders/terrain_noise.wgsl");
pub const TILE_GENERATE_WGSL: &str = include_str!("../shaders/tile_generate.wgsl");
pub const TERRAIN_DRAW_WGSL: &str = include_str!("../shaders/terrain_draw.wgsl");
pub const TILE_FINALIZE_WGSL: &str = include_str!("../shaders/tile_finalize.wgsl");
pub const TILE_CLAMP_ARGS_WGSL: &str = include_str!("../shaders/tile_clamp_args.wgsl");

/// Hard upper bound on the vertex count of any single indirect terrain draw.
///
/// One tile can legitimately emit at most
/// `256*256*6 (surface) + 6*130560 (cliffs) + 6*65536 (water) = 1,569,792` vertices,
/// so 2,000,000 leaves headroom while still catching an argument-encoding fault long
/// before it can hang the GPU. Enforced on the GPU by `tile_clamp_args.wgsl` (release
/// clamp + diagnostics record) and asserted on the CPU by the bench harness.
pub const MAX_DRAW_VERTICES: u32 = 2_000_000;

/// Size of the indirect-args buffer: the 16-byte draw quad, then the 16-byte per-class
/// count block the vertex shader reads, then a 16-byte diagnostics region holding the
/// pre-clamp request. See `tile_finalize.wgsl` / `tile_clamp_args.wgsl`.
pub const RENDER_ARGS_TOTAL_BYTES: u64 = 48;
/// Bytes copied into the vertex shader's read-only snapshot: the draw quad plus counts.
pub const RENDER_COUNTS_BYTES: u64 = 32;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use quarterview_terrain_core::clipmap::{
        select_tiles_into, tile_cell_span, TileKey, ViewRequest, TILE_SAMPLES,
    };
    use std::collections::HashMap;
    use wasm_bindgen::prelude::*;
    use web_sys::HtmlCanvasElement;
    use wgpu::util::DeviceExt;

    const GRID: u32 = TILE_SAMPLES as u32 + 1;
    const TILE_BYTES: u64 = GRID as u64 * GRID as u64 * 4;
    const MAX_RESIDENT_TILES: usize = 384;
    const MAX_NEW_TILES_PER_FRAME: usize = 24;
    const INDEX_COUNT_PER_TILE: u32 = (GRID - 1) * (GRID - 1) * 6;
    const MAX_CLIFF_EDGES: usize = 2 * (GRID as usize - 1) * (GRID as usize - 2);
    const MAX_WATER_CELLS: usize = (GRID as usize - 1) * (GRID as usize - 1);
    use super::{MAX_DRAW_VERTICES, RENDER_ARGS_TOTAL_BYTES, RENDER_COUNTS_BYTES};
    fn push_u32(out: &mut Vec<u8>, v: u32) {
        out.extend_from_slice(&v.to_le_bytes());
    }
    fn push_i32(out: &mut Vec<u8>, v: i32) {
        out.extend_from_slice(&v.to_le_bytes());
    }

    fn put_i32(out: &mut [u8], offset: usize, v: i32) {
        out[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put_u32(out: &mut [u8], offset: usize, v: u32) {
        out[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put_f32(out: &mut [u8], offset: usize, v: f32) {
        out[offset..offset + 4].copy_from_slice(&v.to_le_bytes());
    }

    /// 真等角投影の画面座標係数(shaders/terrain_draw.wgsl の ISO_X / ISO_Y と同一)。
    /// three.js 側の OrthographicCamera(position=(20,20,20), up=+Y)から導いた値。
    pub(crate) const ISO_X: f64 = std::f64::consts::FRAC_1_SQRT_2; // 1/sqrt(2)
    pub(crate) const ISO_Y: f64 = 0.408_248_290_463_863_0; // 1/sqrt(6)
    /// 高さ項の係数(2/sqrt(6))。y は段数なので、ワールド高さ(=段数×height_per_level)へ
    /// 直してから掛ける。
    pub(crate) const ISO_H: f64 = 0.816_496_580_927_726_0;
    /// 拡大の上限(物理ピクセル/ワールド単位)。three.js 側の maxZoom(100)× DPR(<=2)を
    /// 十分に上回る値にしておく。
    const MAX_PIXELS_PER_CELL: f64 = 4096.0;

    fn full_map_min_ppc(width: u32, height: u32, half_extent: i32) -> f64 {
        let half = (half_extent.max(1)) as f64;
        // screen_x = (x-z)*ppc*ISO_X -> full map width  = 4*half*ppc*ISO_X
        // screen_y = (x+z)*ppc*ISO_Y -> full map height = 4*half*ppc*ISO_Y
        (width as f64 / (4.0 * half * ISO_X))
            .min(height as f64 / (4.0 * half * ISO_Y))
            .max(0.000_01)
    }

    struct GpuTile {
        _samples: wgpu::Buffer,
        _tile_params: wgpu::Buffer,
        _cliff_edges: wgpu::Buffer,
        _water_cells: wgpu::Buffer,
        render_args: wgpu::Buffer,
        _render_counts: wgpu::Buffer,
        draw_bind_group: wgpu::BindGroup,
        last_used: u64,
    }

    fn create_depth(
        device: &wgpu::Device,
        width: u32,
        height: u32,
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("quarterview-depth"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, view)
    }

    #[wasm_bindgen]
    pub struct CanvasRenderer {
        surface: wgpu::Surface<'static>,
        device: wgpu::Device,
        queue: wgpu::Queue,
        config: wgpu::SurfaceConfiguration,
        _depth: wgpu::Texture,
        depth_view: wgpu::TextureView,

        tile_pipeline: wgpu::ComputePipeline,
        tile_bgl: wgpu::BindGroupLayout,
        draw_pipeline: wgpu::RenderPipeline,
        draw_bgl: wgpu::BindGroupLayout,
        _camera_bgl: wgpu::BindGroupLayout,
        camera_buffer: wgpu::Buffer,
        camera_bind_group: wgpu::BindGroup,
        finalize_pipeline: wgpu::ComputePipeline,
        finalize_bgl: wgpu::BindGroupLayout,
        clamp_pipeline: wgpu::ComputePipeline,
        clamp_bgl: wgpu::BindGroupLayout,
        clamp_params: wgpu::Buffer,

        tiles: HashMap<TileKey, GpuTile>,
        visible: Vec<TileKey>,
        needed: Vec<TileKey>,
        frame_index: u64,
        camera_revision: u64,

        seed: u32,
        half_extent: i32,
        center_x: f64,
        center_z: f64,
        pixels_per_cell: f64,
        /// 段数1あたりのワールド高さ(本体の OVERPASS_HEIGHT)。set_camera で更新する。
        height_per_level: f64,

        adapter_name: String,
        adapter_backend: String,
    }

    #[wasm_bindgen]
    impl CanvasRenderer {
        #[wasm_bindgen(js_name = create)]
        pub async fn create(
            canvas: HtmlCanvasElement,
            seed: u32,
            half_extent: i32,
        ) -> Result<CanvasRenderer, JsValue> {
            console_error_panic_hook::set_once();
            let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
                backends: wgpu::Backends::BROWSER_WEBGPU,
                ..Default::default()
            });
            let surface: wgpu::Surface<'static> = instance
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
                .map_err(|e| JsValue::from_str(&format!("create_surface: {e}")))?;
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    compatible_surface: Some(&surface),
                    force_fallback_adapter: false,
                })
                .await
                .ok_or_else(|| JsValue::from_str("No WebGPU adapter available"))?;
            let info = adapter.get_info();
            let (device, queue) = adapter
                .request_device(
                    &wgpu::DeviceDescriptor {
                        label: Some("quarterview-renderer"),
                        required_features: wgpu::Features::empty(),
                        required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                            .using_resolution(adapter.limits()),
                        memory_hints: wgpu::MemoryHints::Performance,
                    },
                    None,
                )
                .await
                .map_err(|e| JsValue::from_str(&format!("request_device: {e}")))?;

            let caps = surface.get_capabilities(&adapter);
            let format = caps
                .formats
                .iter()
                .copied()
                .find(|f| f.is_srgb())
                .unwrap_or(caps.formats[0]);
            let config = wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format,
                width: canvas.width().max(1),
                height: canvas.height().max(1),
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 2,
                alpha_mode: caps.alpha_modes[0],
                view_formats: vec![],
            };
            surface.configure(&device, &config);
            let (depth, depth_view) = create_depth(&device, config.width, config.height);

            let tile_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("tile-generate"),
                source: wgpu::ShaderSource::Wgsl(super::TILE_GENERATE_WGSL.into()),
            });
            let tile_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("tile-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: false },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });
            let tile_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("tile-layout"),
                bind_group_layouts: &[&tile_bgl],
                push_constant_ranges: &[],
            });
            let tile_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("tile-pipeline"),
                layout: Some(&tile_layout),
                module: &tile_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });

            let draw_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("terrain-draw"),
                source: wgpu::ShaderSource::Wgsl(super::TERRAIN_DRAW_WGSL.into()),
            });
            let draw_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("draw-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 4, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                ],
            });
            let camera_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("camera-bgl"), entries: &[wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::VERTEX, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }],
            });
            let draw_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("draw-layout"), bind_group_layouts: &[&draw_bgl, &camera_bgl], push_constant_ranges: &[] });

            let finalize_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("tile-finalize"), source: wgpu::ShaderSource::Wgsl(super::TILE_FINALIZE_WGSL.into()) });
            let finalize_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("tile-finalize-bgl"), entries: &[
                    wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 3, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 4, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                ],
            });
            let finalize_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("tile-finalize-layout"), bind_group_layouts: &[&finalize_bgl], push_constant_ranges: &[] });
            let finalize_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some("tile-finalize-pipeline"), layout: Some(&finalize_layout), module: &finalize_shader, entry_point: Some("main"), compilation_options: Default::default(), cache: None });

            // Draw-safety guard: clamps every tile's indirect quad before it can be
            // submitted (see shaders/tile_clamp_args.wgsl).
            let clamp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("tile-clamp-args"), source: wgpu::ShaderSource::Wgsl(super::TILE_CLAMP_ARGS_WGSL.into()) });
            let clamp_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("tile-clamp-args-bgl"), entries: &[
                    wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None },
                    wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::COMPUTE, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: false }, has_dynamic_offset: false, min_binding_size: None }, count: None },
                ],
            });
            let clamp_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("tile-clamp-args-layout"), bind_group_layouts: &[&clamp_bgl], push_constant_ranges: &[] });
            let clamp_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some("tile-clamp-args-pipeline"), layout: Some(&clamp_layout), module: &clamp_shader, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
            let mut clamp_params_bytes = [0u8; 16];
            put_u32(&mut clamp_params_bytes, 0, MAX_DRAW_VERTICES);
            let clamp_params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("tile-clamp-args-params"), contents: &clamp_params_bytes, usage: wgpu::BufferUsages::UNIFORM });

            let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor { label: Some("terrain-camera-params"), size: 32, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("terrain-camera-bg"), layout: &camera_bgl, entries: &[wgpu::BindGroupEntry { binding: 0, resource: camera_buffer.as_entire_binding() }] });

            let draw_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("terrain-draw-pipeline"),
                layout: Some(&draw_layout),
                vertex: wgpu::VertexState {
                    module: &draw_shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &draw_shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth32Float,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::LessEqual,
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                multiview: None,
                cache: None,
            });

            Ok(Self {
                surface,
                device,
                queue,
                config,
                _depth: depth,
                depth_view,
                tile_pipeline,
                tile_bgl,
                draw_pipeline,
                draw_bgl,
                _camera_bgl: camera_bgl,
                camera_buffer,
                camera_bind_group,
                finalize_pipeline,
                finalize_bgl,
                clamp_pipeline,
                clamp_bgl,
                clamp_params,
                tiles: HashMap::with_capacity(128),
                visible: Vec::with_capacity(64),
                needed: Vec::with_capacity(96),
                frame_index: 0,
                camera_revision: 1,
                seed,
                half_extent,
                center_x: 0.0,
                center_z: 0.0,
                pixels_per_cell: 3.0,
                height_per_level: 1.0,
                adapter_name: info.name,
                adapter_backend: format!("{:?}", info.backend),
            })
        }

        pub fn resize(&mut self, width: u32, height: u32) {
            if width == 0 || height == 0 {
                return;
            }
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(&self.device, &self.config);
            self.camera_revision = self.camera_revision.wrapping_add(1);
            let (depth, depth_view) = create_depth(&self.device, width, height);
            self._depth = depth;
            self.depth_view = depth_view;
        }

        /// カメラを本体(three.js)側の直交カメラに合わせる。
        ///
        /// - `center_x` / `center_z`: 画面中心に来る地表(y=0)の点。OrbitControls の
        ///   target が (tx,ty,tz) のとき、等角投影では (tx-ty, tz-ty) がその点になる
        ///   (JS 側 `render/webgpuCamera.ts` の `groundCentreFromTarget` が計算する)。
        /// - `pixels_per_cell`: ワールド1単位あたりの物理ピクセル数(= three.js の zoom × DPR)。
        /// - `height_per_level`: 段数1あたりのワールド高さ(本体の OVERPASS_HEIGHT)。
        ///   省略時は 1.0(プロトタイプの単独ページ用)。
        #[wasm_bindgen(js_name = setCamera)]
        pub fn set_camera(
            &mut self,
            center_x: f64,
            center_z: f64,
            pixels_per_cell: f64,
            height_per_level: Option<f64>,
        ) {
            let next_x = center_x.clamp(-(self.half_extent as f64), self.half_extent as f64);
            let next_z = center_z.clamp(-(self.half_extent as f64), self.half_extent as f64);
            let min_ppc = full_map_min_ppc(self.config.width, self.config.height, self.half_extent);
            let next_ppc = pixels_per_cell.clamp(min_ppc, MAX_PIXELS_PER_CELL);
            let next_height = height_per_level.unwrap_or(1.0);
            if self.center_x != next_x
                || self.center_z != next_z
                || self.pixels_per_cell != next_ppc
                || self.height_per_level != next_height
            {
                self.center_x = next_x;
                self.center_z = next_z;
                self.pixels_per_cell = next_ppc;
                self.height_per_level = next_height;
                self.camera_revision = self.camera_revision.wrapping_add(1);
            }
        }

        #[wasm_bindgen(js_name = panPixels)]
        pub fn pan_pixels(&mut self, screen_dx: f64, screen_dy: f64) {
            // 等角投影の逆変換(y=0 平面上):
            //   dsx = (dwx-dwz)*ppc*ISO_X, dsy = (dwx+dwz)*ppc*ISO_Y
            let ppc = self.pixels_per_cell.max(0.0001);
            let diff = screen_dx / (ppc * ISO_X);
            let sum = screen_dy / (ppc * ISO_Y);
            let world_x = 0.5 * (sum + diff);
            let world_z = 0.5 * (sum - diff);
            let next_x = (self.center_x - world_x)
                .clamp(-(self.half_extent as f64), self.half_extent as f64);
            let next_z = (self.center_z - world_z)
                .clamp(-(self.half_extent as f64), self.half_extent as f64);
            if self.center_x != next_x || self.center_z != next_z {
                self.center_x = next_x;
                self.center_z = next_z;
                self.camera_revision = self.camera_revision.wrapping_add(1);
            }
        }

        #[wasm_bindgen(js_name = zoomBy)]
        pub fn zoom_by(&mut self, factor: f64) {
            let min_ppc = full_map_min_ppc(self.config.width, self.config.height, self.half_extent);
            let next_ppc = (self.pixels_per_cell * factor).clamp(min_ppc, MAX_PIXELS_PER_CELL);
            if self.pixels_per_cell != next_ppc {
                self.pixels_per_cell = next_ppc;
                self.camera_revision = self.camera_revision.wrapping_add(1);
            }
        }

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
            self.queue
                .write_buffer(&self.camera_buffer, 0, &camera_bytes);

            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("quarterview-terrain-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: 0.604,
                                g: 0.722,
                                b: 0.435,
                                a: 1.0,
                            }),
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
                pass.set_pipeline(&self.draw_pipeline);
                pass.set_bind_group(1, &self.camera_bind_group, &[]);
                for &key in &self.visible {
                    if let Some(tile) = self.tiles.get(&key) {
                        pass.set_bind_group(0, &tile.draw_bind_group, &[]);
                        pass.draw_indirect(&tile.render_args, 0);
                    }
                }
            }
            self.queue.submit(Some(encoder.finish()));
            frame.present();
            self.prune_lru();

            let cpu_ms = js_sys::Date::now() - cpu_started;
            let lod = self.visible.first().map(|t| t.lod).unwrap_or(0);
            Ok(format!(
                "{{\"cpuMs\":{cpu_ms:.3},\"cfgW\":{},\"cfgH\":{},\"heightScale\":{:.3},\"halfExtent\":{},\"drawCalls\":{},\"visibleTiles\":{},\"generatedTiles\":{generated},\"paramUpdates\":{param_updates},\"residentTiles\":{},\"tileGpuBytes\":{},\"lod\":{lod},\"centerX\":{:.3},\"centerZ\":{:.3},\"pixelsPerCell\":{:.5}}}",
                self.config.width, self.config.height,
                self.pixels_per_cell * ISO_H * self.height_per_level, self.half_extent,
                self.visible.len(), self.visible.len(), self.tiles.len(), self.tiles.len() as u64 * TILE_BYTES,
                self.center_x, self.center_z, self.pixels_per_cell,
            ))
        }

        #[wasm_bindgen(js_name = adapterInfo)]
        pub fn adapter_info(&self) -> String {
            format!(
                "{{\"name\":{:?},\"backend\":{:?},\"format\":\"{:?}\"}}",
                self.adapter_name, self.adapter_backend, self.config.format
            )
        }
    }

    impl CanvasRenderer {
        fn create_gpu_tile(&self, key: TileKey, encoder: &mut wgpu::CommandEncoder) -> GpuTile {
            let origin_x = key.x * tile_cell_span(key.lod);
            let origin_z = key.z * tile_cell_span(key.lod);
            let stride = 1i32 << key.lod;
            let samples = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-tile-samples"), size: TILE_BYTES,
                usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false,
            });
            let mut params = Vec::with_capacity(32);
            push_u32(&mut params, self.seed); push_i32(&mut params, self.half_extent);
            push_i32(&mut params, origin_x); push_i32(&mut params, origin_z);
            push_i32(&mut params, stride); push_u32(&mut params, GRID);
            push_u32(&mut params, 0); push_u32(&mut params, 0);
            let params = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-tile-params"), contents: &params, usage: wgpu::BufferUsages::UNIFORM,
            });
            let compute_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-tile-compute-bg"), layout: &self.tile_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                ],
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("terrain-tile-generate"), timestamp_writes: None });
                pass.set_pipeline(&self.tile_pipeline); pass.set_bind_group(0, &compute_bg, &[]);
                pass.dispatch_workgroups((GRID * GRID + 255) / 256, 1, 1);
            }

            let mut finalize_params_bytes = [0u8; 16];
            put_u32(&mut finalize_params_bytes, 0, GRID);
            let finalize_params = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-tile-finalize-params"), contents: &finalize_params_bytes, usage: wgpu::BufferUsages::UNIFORM,
            });
            let cliff_edges = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-cliff-edges"), size: (MAX_CLIFF_EDGES * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false,
            });
            let water_cells = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-water-cells"), size: (MAX_WATER_CELLS * 4) as u64,
                usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false,
            });
            let base_vertices = INDEX_COUNT_PER_TILE;
            // words: [vertex_count, instance_count, first_vertex, first_instance,
            //         cliff_vertices, water_vertices, pad, pad, diagnostics x4]
            let render_args_bytes = [base_vertices, 1u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32, 0u32];
            let render_args = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-render-indirect-args"), contents: bytemuck::cast_slice(&render_args_bytes),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
            });
            debug_assert_eq!(render_args.size(), RENDER_ARGS_TOTAL_BYTES);
            let finalize_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-tile-finalize-bg"), layout: &self.finalize_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: finalize_params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: cliff_edges.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: water_cells.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: render_args.as_entire_binding() },
                ],
            });
            {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("terrain-tile-finalize"), timestamp_writes: None });
                pass.set_pipeline(&self.finalize_pipeline); pass.set_bind_group(0, &finalize_bg, &[]);
                pass.dispatch_workgroups(((GRID - 1) * (GRID - 1) + 255) / 256, 1, 1);
            }
            {
                let clamp_bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("terrain-tile-clamp-args-bg"), layout: &self.clamp_bgl,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: self.clamp_params.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: render_args.as_entire_binding() },
                    ],
                });
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("terrain-tile-clamp-args"), timestamp_writes: None });
                pass.set_pipeline(&self.clamp_pipeline); pass.set_bind_group(0, &clamp_bg, &[]);
                pass.dispatch_workgroups(1, 1, 1);
            }
            let render_counts = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("terrain-render-counts"), size: RENDER_COUNTS_BYTES, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
            });
            encoder.copy_buffer_to_buffer(&render_args, 0, &render_counts, 0, RENDER_COUNTS_BYTES);

            let mut tile_bytes = [0u8; 16];
            put_i32(&mut tile_bytes, 0, origin_x); put_i32(&mut tile_bytes, 4, origin_z);
            put_i32(&mut tile_bytes, 8, stride); put_u32(&mut tile_bytes, 12, GRID);
            let tile_params = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("terrain-tile-draw-params"), contents: &tile_bytes, usage: wgpu::BufferUsages::UNIFORM,
            });
            let draw_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("terrain-draw-bg"), layout: &self.draw_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: tile_params.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: cliff_edges.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: water_cells.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 4, resource: render_counts.as_entire_binding() },
                ],
            });
            GpuTile { _samples: samples, _tile_params: tile_params, _cliff_edges: cliff_edges, _water_cells: water_cells, render_args, _render_counts: render_counts, draw_bind_group, last_used: self.frame_index }
        }

        fn prune_lru(&mut self) {
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
    }

    #[wasm_bindgen]
    pub fn cpu_corner_height(seed: u32, half_extent: i32, x: i32, z: i32) -> u8 {
        quarterview_terrain_core::TerrainField::new(seed, half_extent).corner_height_at(x, z)
    }

    #[wasm_bindgen(js_name = cpuTilePacked)]
    pub fn cpu_tile_packed(
        seed: u32,
        half_extent: i32,
        origin_x: i32,
        origin_z: i32,
        stride: i32,
    ) -> Vec<u32> {
        let field = quarterview_terrain_core::TerrainField::new(seed, half_extent);
        let mut out = Vec::with_capacity((GRID * GRID) as usize);
        for lx in 0..GRID as i32 {
            for lz in 0..GRID as i32 {
                let x = origin_x + lx * stride;
                let z = origin_z + lz * stride;
                let h = field.corner_height_at(x, z) as u32;
                let water = u32::from(field.is_water_vertex(x, z));
                out.push(h | (water << 8));
            }
        }
        out
    }

    #[wasm_bindgen(js_name = tileGenerateWgsl)]
    pub fn tile_generate_wgsl() -> String {
        super::TILE_GENERATE_WGSL.to_owned()
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::*;
