struct TileParams { origin_x: i32, origin_z: i32, stride: i32, grid_size: u32 };
struct CameraParams { center_x: f32, center_z: f32, pixels_per_cell: f32, height_scale: f32, viewport_w: f32, viewport_h: f32, half_extent: f32, _pad: f32 };
@group(0) @binding(0) var<uniform> tile: TileParams;
@group(0) @binding(1) var<storage, read> samples: array<u32>;
@group(0) @binding(2) var<storage, read> edge_ids: array<u32>;
@group(1) @binding(0) var<uniform> camera: CameraParams;

fn cell_h(x:u32,z:u32)->f32 {
  let g=tile.grid_size;
  let a=f32(samples[x*g+z]&0xffu); let b=f32(samples[(x+1u)*g+z]&0xffu);
  let c=f32(samples[x*g+z+1u]&0xffu); let d=f32(samples[(x+1u)*g+z+1u]&0xffu);
  return min(min(a,b),min(c,d));
}
fn project(wx:f32,wz:f32,y:f32)->vec4<f32> {
  let rel_x=wx-camera.center_x; let rel_z=wz-camera.center_z;
  let sx=(rel_x-rel_z)*camera.pixels_per_cell*0.5;
  let sy=(rel_x+rel_z)*camera.pixels_per_cell*0.25-y*camera.height_scale;
  let cx=sx/max(camera.viewport_w*0.5,1.0); let cy=-sy/max(camera.viewport_h*0.5,1.0);
  let diag=(wx+wz+camera.half_extent*2.0)/max(camera.half_extent*4.0,1.0);
  let depth=clamp(0.84-diag*0.6-y*0.002,0.0,1.0);
  return vec4<f32>(cx,cy,depth,1.0);
}

struct Out { @builtin(position) position:vec4<f32>, @location(0) color:vec3<f32> };
@vertex
fn vs_main(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->Out {
  let edge=edge_ids[ii]; let zedge=(edge&0x80000000u)!=0u; let cell=edge&0x7fffffffu;
  let cells=tile.grid_size-1u; let x=cell/cells; let z=cell%cells;
  var low=cell_h(x,z); var high=cell_h(x,z+select(0u,1u,zedge));
  if (!zedge) { high=cell_h(x+1u,z); }
  let y0=min(low,high); let y1=max(low,high);
  let delta=abs(high-low);
  let edge_x=f32(tile.origin_x+i32(x+select(1u,0u,zedge))*tile.stride)-0.5;
  let edge_z=f32(tile.origin_z+i32(z+select(1u,0u,!zedge))*tile.stride)-0.5;
  let x0=f32(tile.origin_x+i32(x)*tile.stride)-0.5;
  let z0=f32(tile.origin_z+i32(z)*tile.stride)-0.5;
  let x1=f32(tile.origin_x+i32(x+1u)*tile.stride)-0.5;
  let z1=f32(tile.origin_z+i32(z+1u)*tile.stride)-0.5;
  var wx0=edge_x; var wz0=z0; var wx1=edge_x; var wz1=z1;
  if (zedge) { wx0=x0; wz0=edge_z; wx1=x1; wz1=edge_z; }
  var px=wx0; var pz=wz0; var py=y0;
  if (vi==1u){px=wx1;pz=wz1;py=y0;} else if(vi==2u){px=wx1;pz=wz1;py=y1;} else if(vi==3u){px=wx0;pz=wz0;py=y0;} else if(vi==4u){px=wx1;pz=wz1;py=y1;} else if(vi==5u){px=wx0;pz=wz0;py=y1;}
  let outp=project(px,pz,py);
  var out:Out; out.position=outp;
  out.color=select(vec3<f32>(0.435,0.416,0.369),vec3<f32>(0.549,0.525,0.467),delta>=2.0);
  if (y1>=8.0) { out.color=vec3<f32>(0.62,0.61,0.58); }
  return out;
}
@fragment fn fs_main(in:Out)->@location(0) vec4<f32>{return vec4<f32>(in.color,1.0);}
