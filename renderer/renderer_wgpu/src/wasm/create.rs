use super::*;
use web_sys::HtmlCanvasElement;

#[wasm_bindgen]
impl CanvasRenderer {
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        canvas: HtmlCanvasElement,
        seed: u32,
        half_extent: i32,
        // 地形プロファイル名 ("flat" / "normal" / "mountain")。世界ごとに不変なので
        // 生成時に固定する。未指定(旧い呼び出し)は "normal" として扱う。
        profile: Option<String>,
    ) -> Result<CanvasRenderer, JsValue> {
        console_error_panic_hook::set_once();
        let profile = profile
            .as_deref()
            .map(quarterview_terrain_core::TerrainProfile::from_name)
            .unwrap_or_default();
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
            source: wgpu::ShaderSource::Wgsl(crate::TILE_GENERATE_WGSL.into()),
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
                // R2: 疎な地形編集オーバーレイ(local_index昇順ソート済み)。
                // build_tile_overrides が組み立て、tile_generate.wgsl が二分探索する。
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
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
            source: wgpu::ShaderSource::Wgsl(crate::TERRAIN_DRAW_WGSL.into()),
        });
        let draw_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("draw-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let camera_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("camera-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let draw_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("draw-layout"),
            bind_group_layouts: &[&draw_bgl, &camera_bgl],
            push_constant_ranges: &[],
        });

        let finalize_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tile-finalize"),
            source: wgpu::ShaderSource::Wgsl(crate::TILE_FINALIZE_WGSL.into()),
        });
        let finalize_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tile-finalize-bgl"),
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
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
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
        let finalize_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("tile-finalize-layout"),
            bind_group_layouts: &[&finalize_bgl],
            push_constant_ranges: &[],
        });
        let finalize_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("tile-finalize-pipeline"),
                layout: Some(&finalize_layout),
                module: &finalize_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });

        // Draw-safety guard: clamps every tile's indirect quad before it can be
        // submitted (see shaders/tile_clamp_args.wgsl).
        let clamp_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tile-clamp-args"),
            source: wgpu::ShaderSource::Wgsl(crate::TILE_CLAMP_ARGS_WGSL.into()),
        });
        let clamp_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tile-clamp-args-bgl"),
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
        let clamp_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("tile-clamp-args-layout"),
            bind_group_layouts: &[&clamp_bgl],
            push_constant_ranges: &[],
        });
        let clamp_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("tile-clamp-args-pipeline"),
            layout: Some(&clamp_layout),
            module: &clamp_shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let mut clamp_params_bytes = [0u8; 16];
        put_u32(&mut clamp_params_bytes, 0, MAX_DRAW_VERTICES);
        let clamp_params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("tile-clamp-args-params"),
            contents: &clamp_params_bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("terrain-camera-params"),
            size: 32,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("terrain-camera-bg"),
            layout: &camera_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: camera_buffer.as_entire_binding(),
            }],
        });

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

        // --- R4a: メッシュチャンク / インスタンス描画のパイプライン(mesh_pipeline モジュール) ---
        let mesh = crate::mesh_pipeline::create_all(&device, format);
        let mesh_camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("mesh-camera-bg"),
            layout: &mesh.camera_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: camera_buffer.as_entire_binding(),
            }],
        });
        let class_bind_groups = [
            LayerClass::Surface,
            LayerClass::Underground,
            LayerClass::Translucent,
            LayerClass::UndergroundGhost,
        ]
        .map(|class| {
            let mut bytes = [0u8; 16];
            put_u32(&mut bytes, 0, class.as_u32());
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh-class-params"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("mesh-class-bg"),
                layout: &mesh.class_bgl,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: buffer.as_entire_binding(),
                }],
            })
        });
        let mesh_pipelines = mesh.chunk;
        let instanced_pipelines = mesh.instanced;

        // --- D1: 透視投影(乗客視点スパイク)パイプライン一式 ---
        // camera_bgl/class_bgl はクォータービューと共有(バッファの中身に関知しない
        // 汎用レイアウトのため)。専用のカメラ uniform だけ別バッファにする。
        let (persp_mesh_pipelines, persp_instanced_pipelines) =
            crate::mesh_pipeline::create_perspective_all(&device, format, &mesh.camera_bgl, &mesh.class_bgl);
        let persp_camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("persp-camera-params"),
            size: 96,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let persp_camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("persp-camera-bg"),
            layout: &mesh.camera_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: persp_camera_buffer.as_entire_binding(),
            }],
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
            mesh_pipelines,
            instanced_pipelines,
            class_bind_groups,
            mesh_camera_bind_group,
            mesh_chunks: HashMap::new(),
            instanced_meshes: HashMap::new(),
            persp_mesh_pipelines,
            persp_instanced_pipelines,
            persp_camera_buffer,
            persp_camera_bind_group,
            mode: CameraMode::default(),
            persp_eye: [0.0, 1.6, 0.0],
            persp_look: [0.0, 1.6, 1.0],
            persp_fov_y: std::f64::consts::FRAC_PI_3,
            tiles: HashMap::with_capacity(128),
            visible: Vec::with_capacity(64),
            needed: Vec::with_capacity(96),
            frame_index: 0,
            camera_revision: 1,
            seed,
            half_extent,
            profile,
            center_x: 0.0,
            center_z: 0.0,
            pixels_per_cell: 3.0,
            height_per_level: 1.0,
            dim: 1.0,
            overrides: HashMap::new(),
            adapter_name: info.name,
            adapter_backend: format!("{:?}", info.backend),
        })
    }
}
