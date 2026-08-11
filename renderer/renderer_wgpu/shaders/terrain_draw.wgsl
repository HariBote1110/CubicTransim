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
const ISO_H:f32=0.81649658; // 2/sqrt(6) (mesh_draw.wgsl と同じ、段数→ワールド高さの逆変換用)

// R4b: 斜面陰影。src/render/bakedMesh.ts の SUN_DIRECTION/AMBIENT_TERM/HEMISPHERE_TERM/
// SUN_TERM と同じ光(SunLight position=[-30,34,14]を正規化)・同じ式を使い、ジオラマ物の
// 焼き込み陰影と見た目を揃える。ここは頂点色に焼き込めない(地形は1頂点=複数セル共有)ので
// フラグメント側でスクリーン空間微分から面法線を求めて都度計算する。
const SUN_DIR:vec3<f32>=vec3<f32>(-0.6321746, 0.7164646, 0.2950148);
const SHADE_AMBIENT:f32=0.2;
const SHADE_HEMI:f32=0.28;
const SHADE_SUN:f32=0.55;
// 水平面(n=(0,1,0))での上式の値。これで割ることで平坦な地面の明るさを既存パレットと
// 完全一致させる(平坦地は from now on も見た目を変えない、という要件のため)。
const SHADE_FLAT_NORM:f32=0.8740555;

// 段数(level)単位の高さをワールド単位へ戻す。height_scale = ppc*ISO_H*height_per_level
// (mesh_draw.wgsl の world_y_to_levels の逆)なので height_per_level = height_scale/(ppc*ISO_H)。
fn levels_to_world_y(y_levels:f32)->f32{
 return y_levels*camera.height_scale/max(camera.pixels_per_cell*ISO_H,1e-6);
}

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
// world_pos: フラグメント側で dpdx/dpdy から面法線を復元するための補間対象(ワールド座標)。
// shade: 1.0=斜面陰影を適用、0.0=適用しない(水面は常に平坦に見せたいのでオフ)。
struct Out{@builtin(position)position:vec4<f32>,@location(0)color:vec3<f32>,@location(1)dim:f32,@location(2)world_pos:vec3<f32>,@location(3)shade:f32};

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
 if(isw){color=vec3<f32>(0.851,0.812,0.659);} o.color=color; o.dim=camera.dim;
 o.world_pos=vec3<f32>(wx,levels_to_world_y(rh),wz); o.shade=select(1.0,0.0,isw);
 return o;
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
 var o:Out; o.position=project(wx,wz,y); o.color=select(vec3<f32>(0.435,0.416,0.369),vec3<f32>(0.549,0.525,0.467),hi-lo>=2.0); if(hi>=8.0){o.color=vec3<f32>(0.62,0.61,0.58);} o.dim=camera.dim;
 o.world_pos=vec3<f32>(wx,levels_to_world_y(y),wz); o.shade=1.0;
 return o;
}

fn water_vertex(v:u32)->Out{
 let id=water_cells[v/6u]; let cells=tile.grid_size-1u; let x=id/cells; let z=id%cells;
 let cx=f32(tile.origin_x+i32(x)*tile.stride); let cz=f32(tile.origin_z+i32(z)*tile.stride); let hx=0.47*f32(tile.stride);
 var ox=-hx;var oz=-hx; if(v%6u==1u){ox=hx;}else if(v%6u==2u){ox=hx;oz=hx;}else if(v%6u==4u){ox=hx;oz=hx;}else if(v%6u==5u){oz=hx;}
 var o:Out; o.position=project(cx+ox,cz+oz,-0.055); o.color=vec3<f32>(0.290,0.624,0.831); o.dim=camera.dim;
 o.world_pos=vec3<f32>(cx+ox,levels_to_world_y(-0.055),cz+oz); o.shade=0.0; // 水面は平坦のまま(陰影オフ)
 return o;
}

@vertex fn vs_main(@builtin(vertex_index) v:u32)->Out{
 let base=(tile.grid_size-1u)*(tile.grid_size-1u)*6u; let cliffs=args.cliff_vertices; let waters=args.water_vertices;
 if(v<base){return terrain_vertex(v);} if(v<base+cliffs){return cliff_vertex(v-base);} return water_vertex(v-base-cliffs);
}
@fragment fn fs_main(in:Out)->@location(0)vec4<f32>{
 // dpdx/dpdyは「非uniformな制御フロー(=フラグメントごとに分岐する if)の中で呼ぶな」という
 // WGSL の規則がある(2x2クアッド内で隣接フラグメントの実行が食い違うと差分が壊れるため)。
 // in.shade はフラグメントごとに変わる値なので、if(in.shade>0.5){ dpdx(...) } のように分岐の
 // 内側に置くと Naga/Tint(Chrome の WGSL 検証器)が CreateShaderModule を reject する
 // (Metalネイティブの wgpu バックエンドはこの規則を強制せず素通りしたため、cargo test/
 // shader_check では気づけなかった。実ブラウザで初めて black canvas として顕在化した)。
 // 対策: dpdx/dpdyは分岐の外側で常に計算し、使うかどうかだけを shade で select する。
 //
 // 等角投影(orthographic, w=1)なので dpdx/dpdy はスクリーン隣接フラグメント間のワールド
 // 座標差そのもの。三角形内は平面なのでこれで面法線が厳密に求まる(=フラットシェーディング。
 // 頂点色ブレンドではなくフラグメント単位で効くのでセル境界の稜線がくっきり出る)。
 let dx=dpdx(in.world_pos); let dy=dpdy(in.world_pos);
 let raw_n=cross(dx,dy); let nlen=length(raw_n);
 var n=vec3<f32>(0.0,1.0,0.0);
 if(nlen>1e-8){n=raw_n/nlen;}
 if(n.y<0.0){n=-n;} // 常に上向き半球に畳む(巻き順次第で符号が反転するため)
 let sun=max(0.0,dot(n,SUN_DIR));
 let hemi=0.5+0.5*n.y;
 let shaded=(SHADE_AMBIENT+SHADE_HEMI*hemi+SHADE_SUN*sun)/SHADE_FLAT_NORM;
 let shade_factor=select(1.0,shaded,in.shade>0.5);
 let alpha=select(1.0,0.85,in.color.r>0.25&&in.color.b>0.6);
 return vec4<f32>(in.color*shade_factor*in.dim,alpha);
}
