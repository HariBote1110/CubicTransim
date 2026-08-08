struct TileParams { origin_x:i32, origin_z:i32, stride:i32, grid_size:u32 };
// dim: 地下ビュー減光係数(1.0=通常、0.0=真っ黒)。R2で setDim から書き込む。
// three.js側のDIMMED_MATERIALS(opacity~0.3相当)と見た目を揃えるため、色を直接
// 乗算で暗くする(このパイプラインは blend:None の不透明描画なのでアルファ合成は使えない)。
struct CameraParams { center_x:f32, center_z:f32, pixels_per_cell:f32, height_scale:f32, viewport_w:f32, viewport_h:f32, half_extent:f32, dim:f32 };
// Mirrors tile_finalize.wgsl's RenderArgs: words 0..3 are the draw_indirect quad,
// words 4..5 are the per-class counts this shader splits the vertex range with.
struct RenderArgs { vertex_count:u32, instance_count:u32, first_vertex:u32, first_instance:u32, cliff_vertices:u32, water_vertices:u32, _pad0:u32, _pad1:u32 };
@group(0) @binding(0) var<uniform> tile:TileParams;
@group(0) @binding(1) var<storage,read> samples:array<u32>;
@group(0) @binding(2) var<storage,read> cliff_edges:array<u32>;
@group(0) @binding(3) var<storage,read> water_cells:array<u32>;
@group(0) @binding(4) var<storage,read> args:RenderArgs;
@group(1) @binding(0) var<uniform> camera:CameraParams;

fn sample_h(ix:u32,iz:u32)->f32{return f32(samples[ix*tile.grid_size+iz]&0xffu);}
fn sample_w(ix:u32,iz:u32)->bool{return ((samples[ix*tile.grid_size+iz]>>8u)&1u)!=0u;}
fn cell_h(x:u32,z:u32)->f32{
 let g=tile.grid_size;
 return min(min(sample_h(x,z),sample_h(x+1u,z)),min(sample_h(x,z+1u),sample_h(x+1u,z+1u)));
}
// 本体(three.js)の直交カメラと同じ真等角(true isometric)投影。
// GameScene のカメラは position=(20,20,20)・target=(tx,ty,tz)・up=+Y の
// OrthographicCamera なので、視線基底は
//   X_cam = (1,0,-1)/sqrt(2)、Y_cam = (-1,2,-1)/sqrt(6)
// となり、画面座標(中心からのピクセル)は
//   sx = (x-z)/sqrt(2) * ppc、sy(下向き) = (x+z-2y)/sqrt(6) * ppc
// で表せる。ppc は「ワールド1単位あたりの物理ピクセル数」= three.js の zoom × DPR。
// 高さ項は JS 側で height_scale = ppc * 2/sqrt(6) * OVERPASS_HEIGHT として渡す
// (この shader の y は段数=level 単位のまま)。
const ISO_X:f32=0.70710678; // 1/sqrt(2)
const ISO_Y:f32=0.40824829; // 1/sqrt(6)

fn project(wx:f32,wz:f32,y:f32)->vec4<f32>{
 let rx=wx-camera.center_x; let rz=wz-camera.center_z;
 let sx=(rx-rz)*camera.pixels_per_cell*ISO_X;
 let sy=(rx+rz)*camera.pixels_per_cell*ISO_Y-y*camera.height_scale;
 let cx=sx/max(camera.viewport_w*0.5,1.0); let cy=-sy/max(camera.viewport_h*0.5,1.0);
 // 奥行きは視線方向(1,1,1)/sqrt(3)への射影の単調関数で足りる(手前ほど小さい値)。
 // マップ全域([-half,half]^2)が 0..1 に収まるよう正規化する。
 let inv_span=1.0/max(camera.half_extent*4.0+64.0,1.0);
 return vec4<f32>(cx,cy,clamp(0.5-(wx+wz+y)*inv_span,0.0,1.0),1.0);
}
struct Out{@builtin(position)position:vec4<f32>,@location(0)color:vec3<f32>,@location(1)dim:f32};

fn terrain_vertex(v:u32)->Out{
 let cell=v/6u; let corner=v%6u; let cells=tile.grid_size-1u; let x=cell/cells; let z=cell%cells;
 var sx=x; var sz=z;
 if(corner==1u||corner==2u||corner==4u){sx=x+1u;}
 if(corner==2u||corner==5u||corner==4u){sz=z+1u;}
 let h=sample_h(sx,sz); let isw=sample_w(sx,sz); let rh=select(h,-0.07,isw);
 let rawx=f32(tile.origin_x+i32(sx)*tile.stride)-0.5; let rawz=f32(tile.origin_z+i32(sz)*tile.stride)-0.5;
 let wx=clamp(rawx,-camera.half_extent-0.5,camera.half_extent+0.5); let wz=clamp(rawz,-camera.half_extent-0.5,camera.half_extent+0.5);
 var o:Out; o.position=project(wx,wz,rh);
 var color=vec3<f32>(0.604,0.722,0.435);
 if(h>=1.0){color=vec3<f32>(0.529,0.663,0.373);} if(h>=8.0){color=vec3<f32>(0.910,0.902,0.875);}
 if(isw){color=vec3<f32>(0.851,0.812,0.659);} o.color=color; o.dim=camera.dim; return o;
}

fn cliff_vertex(v:u32)->Out{
 let edge_index=(v/6u); let vi=v%6u; let edge=cliff_edges[edge_index]; let zedge=(edge&0x80000000u)!=0u; let cell=edge&0x7fffffffu;
 let cells=tile.grid_size-1u; let x=cell/cells; let z=cell%cells;
 var a=cell_h(x,z); var b=a;
 if(zedge){b=cell_h(x,z+1u);}else{b=cell_h(x+1u,z);}
 let lo=min(a,b); let hi=max(a,b);
 let x0=f32(tile.origin_x+i32(x)*tile.stride)-0.5; let x1=f32(tile.origin_x+i32(x+1u)*tile.stride)-0.5;
 let z0=f32(tile.origin_z+i32(z)*tile.stride)-0.5; let z1=f32(tile.origin_z+i32(z+1u)*tile.stride)-0.5;
 var wx0=x1; var wz0=z0; var wx1=x1; var wz1=z1;
 if(zedge){wx0=x0;wz0=z1;wx1=x1;wz1=z1;}
 var wx=wx0; var wz=wz0; var y=lo;
 if(vi==1u){wx=wx1;wz=wz1;} else if(vi==2u){wx=wx1;wz=wz1;y=hi;} else if(vi==3u){wx=wx0;wz=wz0;} else if(vi==4u){wx=wx1;wz=wz1;y=hi;} else if(vi==5u){wx=wx0;wz=wz0;y=hi;}
 var o:Out; o.position=project(wx,wz,y); o.color=select(vec3<f32>(0.435,0.416,0.369),vec3<f32>(0.549,0.525,0.467),hi-lo>=2.0); if(hi>=8.0){o.color=vec3<f32>(0.62,0.61,0.58);} o.dim=camera.dim; return o;
}

fn water_vertex(v:u32)->Out{
 let id=water_cells[v/6u]; let cells=tile.grid_size-1u; let x=id/cells; let z=id%cells;
 let cx=f32(tile.origin_x+i32(x)*tile.stride); let cz=f32(tile.origin_z+i32(z)*tile.stride); let hx=0.47*f32(tile.stride);
 var ox=-hx;var oz=-hx; if(v%6u==1u){ox=hx;}else if(v%6u==2u){ox=hx;oz=hx;}else if(v%6u==4u){ox=hx;oz=hx;}else if(v%6u==5u){oz=hx;}
 var o:Out; o.position=project(cx+ox,cz+oz,-0.055); o.color=vec3<f32>(0.290,0.624,0.831); o.dim=camera.dim; return o;
}

@vertex fn vs_main(@builtin(vertex_index) v:u32)->Out{
 let base=(tile.grid_size-1u)*(tile.grid_size-1u)*6u; let cliffs=args.cliff_vertices; let waters=args.water_vertices;
 if(v<base){return terrain_vertex(v);} if(v<base+cliffs){return cliff_vertex(v-base);} return water_vertex(v-base-cliffs);
}
@fragment fn fs_main(in:Out)->@location(0)vec4<f32>{
 let alpha=select(1.0,0.85,in.color.r>0.25&&in.color.b>0.6);
 return vec4<f32>(in.color*in.dim,alpha);
}
