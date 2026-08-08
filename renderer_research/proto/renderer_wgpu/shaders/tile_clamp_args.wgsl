// Permanent draw-safety invariant for the GPU-driven (indirect) terrain draw.
//
// A single runaway `draw_indirect` on a shared integrated GPU does not merely make
// this renderer slow: it monopolises the device and janks the whole desktop, and on
// Metal it ends in a command-buffer timeout that kills the wgpu device. The indirect
// argument quad is therefore never consumed as written by the producing pass. This
// pass runs once per tile, immediately after `tile_finalize`, records the requested
// arguments verbatim into a diagnostics region (words 4..8, never read by the GPU;
// the harness reads them back), and then clamps the live arguments so that no single
// draw can exceed `max_vertices` vertices or one instance.
//
// Layout of the args buffer (32 bytes):
//   0  vertex_count    (indirect)   4  instance_count (indirect)
//   8  first_vertex    (indirect)  12  first_instance (indirect)
//   16 requested_vertex_count      20  requested_instance_count
//   24 requested_first_vertex      28  requested_first_instance
struct ClampParams { max_vertices: u32, _pad0: u32, _pad1: u32, _pad2: u32 };
@group(0) @binding(0) var<uniform> params: ClampParams;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;

@compute @workgroup_size(1)
fn main() {
  let requested_vertices = args[0];
  let requested_instances = args[1];
  let requested_first_vertex = args[2];
  let requested_first_instance = args[3];

  args[4] = requested_vertices;
  args[5] = requested_instances;
  args[6] = requested_first_vertex;
  args[7] = requested_first_instance;

  args[0] = min(requested_vertices, params.max_vertices);
  args[1] = min(requested_instances, 1u);
  args[2] = 0u;
  args[3] = 0u;
}
