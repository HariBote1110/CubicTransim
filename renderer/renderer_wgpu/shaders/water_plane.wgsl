struct TileParams { origin_x:i32, origin_z:i32, stride:i32, grid_size:u32 };
struct CameraParams { center_x:f32, center_z:f32, pixels_per_cell:f32, height_scale:f32, viewport_w:f32, viewport_h:f32, half_extent:f32, _pad:f32 };
@group(0) @binding(0) var<uniform> tile:TileParams;
@group(0) @binding(1) var<storage,read> samples:array<u32>;
@group(0) @binding(2) var<storage,read> water_cells:array<u32>;
@group(1) @binding(0) var<uniform> camera:CameraParams;
struct Out { @builtin(position) position:vec4<f32>, @location(0) color:vec4<f32> };
fn project(wx:f32,wz:f32,y:f32)->vec4<f32>{
 let rx=wx-camera.center_x; let rz=wz-camera.center_z;
 let sx=(rx-rz)*camera.pixels_per_cell*0.5; let sy=(rx+rz)*camera.pixels_per_cell*0.25-y*camera.height_scale;
 let cx=sx/max(camera.viewport_w*0.5,1.0); let cy=-sy/max(camera.viewport_h*0.5,1.0);
 let diag=(wx+wz+camera.half_extent*2.0)/max(camera.half_extent*4.0,1.0);
 return vec4<f32>(cx,cy,clamp(0.86-diag*0.6,0.0,1.0),1.0);
}
@vertex fn vs_main(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out{
 let cells=tile.grid_size-1u; let id=water_cells[ii]; let x=id/cells; let z=id%cells;
 let cx=f32(tile.origin_x+i32(x)*tile.stride); let cz=f32(tile.origin_z+i32(z)*tile.stride);
 let hx=0.47*f32(tile.stride); let hz=hx;
 var ox=-hx; var oz=-hz; if(vi==1u){ox=hx;oz=-hz;} else if(vi==2u){ox=hx;oz=hz;} else if(vi==3u){ox=-hx;oz=-hz;} else if(vi==4u){ox=hx;oz=hz;} else if(vi==5u){ox=-hx;oz=hz;}
 var out:Out; out.position=project(cx+ox,cz+oz,-0.055); out.color=vec4<f32>(0.290,0.624,0.831,0.85); return out;
}
@fragment fn fs_main(in:Out)->@location(0) vec4<f32>{return in.color;}
