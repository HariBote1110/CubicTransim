#[path = "bench_common/mod.rs"]
mod bench_common;

fn main() {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor { backends: bench_common::select_backends(), ..Default::default() });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("adapter");
    let (device, _) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("shader-check"), required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(), memory_hints: wgpu::MemoryHints::Performance,
    }, None)).expect("device");
    for (name, source) in [
        ("terrain-noise", include_str!("../../shaders/terrain_noise.wgsl")),
        ("tile-generate", include_str!("../../shaders/tile_generate.wgsl")),
        ("tile-finalize", include_str!("../../shaders/tile_finalize.wgsl")),
        ("terrain-draw", include_str!("../../shaders/terrain_draw.wgsl")),
    ] {
        let _ = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(name), source: wgpu::ShaderSource::Wgsl(source.into()) });
        println!("{name}: ok");
    }
    println!("adapter: {:?}", adapter.get_info());
}
