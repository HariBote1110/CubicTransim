struct TileFinalizeParams { grid_size:u32, _pad0:u32, _pad1:u32, _pad2:u32 };
struct RenderArgs {
  total_vertices: atomic<u32>,
  cliff_vertices: atomic<u32>,
  water_vertices: atomic<u32>,
  instance_count: atomic<u32>,
};
@group(0) @binding(0) var<uniform> params:TileFinalizeParams;
@group(0) @binding(1) var<storage,read> samples:array<u32>;
@group(0) @binding(2) var<storage,read_write> cliff_edges:array<u32>;
@group(0) @binding(3) var<storage,read_write> water_cells:array<u32>;
@group(0) @binding(4) var<storage,read_write> args:RenderArgs;
fn h(i:u32)->u32{return samples[i]&0xffu;}
fn water(i:u32)->bool{return ((samples[i]>>8u)&1u)!=0u;}
fn cell_h(x:u32,z:u32)->u32{
 let g=params.grid_size;
 return min(min(h(x*g+z),h((x+1u)*g+z)),min(h(x*g+z+1u),h((x+1u)*g+z+1u)));
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid:vec3<u32>){
 let cells=params.grid_size-1u; let i=gid.x; if(i>=cells*cells){return;}
 let x=i/cells; let z=i%cells; let g=params.grid_size;
 let a=x*g+z; let b=(x+1u)*g+z; let c=x*g+z+1u; let d=(x+1u)*g+z+1u;
 if(water(a)&&water(b)&&water(c)&&water(d)){
   let slot=atomicAdd(&args.water_vertices,6u)/6u; water_cells[slot]=i; atomicAdd(&args.total_vertices,6u);
 }
 let e=cell_h(x,z);
 if(x+1u<cells){let n=cell_h(x+1u,z); if(e!=n){let slot=atomicAdd(&args.cliff_vertices,6u)/6u; cliff_edges[slot]=i; atomicAdd(&args.total_vertices,6u);}}
 if(z+1u<cells){let n=cell_h(x,z+1u); if(e!=n){let slot=atomicAdd(&args.cliff_vertices,6u)/6u; cliff_edges[slot]=i|0x80000000u; atomicAdd(&args.total_vertices,6u);}}
}
