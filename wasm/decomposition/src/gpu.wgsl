struct Params {
  profile: u32,
  refl_bits: u32,
  target_bits: u32,
  count: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input_pixels: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> output_pixels: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> output_flags: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  if (index >= params.count) {
    return;
  }
  let pixel = input_pixels[index].xyz;
  output_pixels[index] = vec4<f32>(pixel, 0.5);
  output_flags[index] = 0u;
}
