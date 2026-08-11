struct TileParams { origin_x:i32, origin_z:i32, stride:i32, grid_size:u32 };
struct CameraParams { center_x:f32, center_z:f32, pixels_per_cell:f32, height_scale:f32, viewport_w:f32, viewport_h:f32, half_extent:f32, _pad:f32 };
@group(0) @binding(0) var<uniform> tile:TileParams;
@group(0) @binding(1) var<storage,read> samples:array<u32>;
@group(1) @binding(0) var<uniform> camera:CameraParams;
struct Out{@builtin(position)position:vec4<f32>,@location(0)color:vec3<f32>};
fn project(wx:f32,wz:f32,y:f32)->vec4<f32>{let rx=wx-camera.center_x;let rz=wz-camera.center_z;let sx=(rx-rz)*camera.pixels_per_cell*0.5;let sy=(rx+rz)*camera.pixels_per_cell*0.25-y*camera.height_scale;let cx=sx/max(camera.viewport_w*0.5,1.0);let cy=-sy/max(camera.viewport_h*0.5,1.0);let d=(wx+wz+camera.half_extent*2.0)/max(camera.half_extent*4.0,1.0);return vec4<f32>(cx,cy,clamp(0.85-d*0.6-y*0.002,0.0,1.0),1.0);}
@vertex fn vs_main(@builtin(vertex_index) vi:u32)->Out{let sx=vi/tile.grid_size;let sz=vi%tile.grid_size;let h=f32(samples[sx*tile.grid_size+sz]&0xffu);let rawx=f32(tile.origin_x+i32(sx)*tile.stride)-0.5;let rawz=f32(tile.origin_z+i32(sz)*tile.stride)-0.5;var o:Out;o.position=project(clamp(rawx,-camera.half_extent-0.5,camera.half_extent+0.5),clamp(rawz,-camera.half_extent-0.5,camera.half_extent+0.5),h);o.color=select(vec3<f32>(0.604,0.722,0.435),vec3<f32>(0.529,0.663,0.373),h>=1.0);if(h>=8.0){o.color=vec3<f32>(0.910,0.902,0.875);}return o;}
@fragment fn fs_main(in:Out)->@location(0)vec4<f32>{return vec4<f32>(in.color,1.0);}
