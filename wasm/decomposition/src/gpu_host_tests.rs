//! Host-side execution of the browser WGSL kernel through Mesa lavapipe.
//!
//! This test deliberately dispatches the actual shader instead of duplicating
//! its equations in Rust. A software Vulkan adapter makes the numerical gate
//! testable on CI and on development machines without a physical GPU.

use super::*;
use std::sync::mpsc;
use wgpu::util::DeviceExt;

const WORKGROUP_SIZE: u32 = 64;

fn adapter_device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::LowPower,
        force_fallback_adapter: true,
        compatible_surface: None,
        apply_limit_buckets: false,
    }))
    .ok()?;
    let info = adapter.get_info();
    eprintln!("WGSL host validation adapter: {} ({:?})", info.name, info.backend);
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()
}

fn run_shader(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    profile: u32,
    refl: f32,
    pixels: &[[f32; 3]],
) -> (Vec<f32>, Vec<u32>) {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("host WGSL validation"),
        source: wgpu::ShaderSource::Wgsl(include_str!("gpu.wgsl").into()),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("host WGSL validation layout"),
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
                    ty: wgpu::BufferBindingType::Storage { read_only: true },
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            },
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("host WGSL validation pipeline layout"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("host WGSL validation pipeline"),
        layout: Some(&pipeline_layout),
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let input: Vec<[f32; 4]> = pixels
        .iter()
        .map(|p| [p[0], p[1], p[2], 0.0])
        .collect();
    let target = jhk_for_ap0([refl; 3], profile) as f32;
    let params = [profile, refl.to_bits(), target.to_bits(), pixels.len() as u32];
    let input_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("host WGSL input"),
        contents: bytemuck::cast_slice(&input),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let output_size = (pixels.len() * 4 * std::mem::size_of::<f32>()) as u64;
    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("host WGSL output"),
        size: output_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let flags_size = (pixels.len() * std::mem::size_of::<u32>()) as u64;
    let flags_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("host WGSL flags"),
        size: flags_size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let params_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("host WGSL params"),
        contents: bytemuck::cast_slice(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let parameter_data = modcam16_color_core::aces_output::gpu_parameter_blob();
    let parameter_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("host WGSL ACES parameters"),
        contents: bytemuck::cast_slice(&parameter_data),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let output_readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("host WGSL output readback"),
        size: output_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let flags_readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("host WGSL flags readback"),
        size: flags_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("host WGSL bind group"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: params_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: input_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: output_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: flags_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: parameter_buffer.as_entire_binding() },
        ],
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("host WGSL command encoder"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("host WGSL compute pass"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups((pixels.len() as u32).div_ceil(WORKGROUP_SIZE), 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output_buffer, 0, &output_readback, 0, output_size);
    encoder.copy_buffer_to_buffer(&flags_buffer, 0, &flags_readback, 0, flags_size);
    queue.submit(Some(encoder.finish()));

    fn read(device: &wgpu::Device, buffer: &wgpu::Buffer, size: u64) -> Vec<u8> {
        let (sender, receiver) = mpsc::channel();
        buffer.slice(..size).map_async(wgpu::MapMode::Read, move |result| {
            sender.send(result).expect("map callback receiver");
        });
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        receiver.recv().expect("map callback").expect("map readback");
        let bytes = buffer
            .slice(..size)
            .get_mapped_range()
            .expect("mapped range")
            .to_vec();
        buffer.unmap();
        bytes
    }
    let packed = bytemuck::cast_slice::<u8, f32>(&read(device, &output_readback, output_size)).to_vec();
    let flags = bytemuck::cast_slice::<u8, u32>(&read(device, &flags_readback, flags_size)).to_vec();
    (packed, flags)
}

#[test]
fn actual_wgsl_kernel_matches_f64_cpu_reference_on_software_adapter() {
    let Some((device, queue)) = adapter_device() else {
        eprintln!("No software Vulkan adapter is installed; skipping WGSL execution test");
        return;
    };
    let pixels = [
        [0.0, 0.0, 0.0],
        [0.001, 0.02, 0.12],
        [0.15, 0.25, 0.4],
        [0.5, 0.5, 0.5],
        [1.0, 0.25, 0.03125],
        [4.0, 2.0, 0.5],
        [-0.05, 0.2, 0.7],
        [20.0, 20.0, 20.0],
        [0.6123, 0.0417, 1.8731],
        [3.1042, 0.0081, 0.2274],
        [f32::NAN, 0.2, 0.7],
    ];
    for profile in [0, 1, 2, 4] {
        let request = Request {
            format: "exr".into(),
            gamut: "ACEScg".into(),
            transfer: "Linear".into(),
            profile,
            refl: 0.5,
            blur_sigma: 0.0,
        };
        let (packed, flags) = run_shader(&device, &queue, profile, request.refl, &pixels);
        let (cpu_base, cpu_exposure, cpu_stats) = solve_prepared(&pixels, &request);
        let expected_flags = cpu_base
            .iter()
            .enumerate()
            .map(|(i, _base)| {
                if !finite(pixels[i]) { 4 } else {
                    let projected = pixels[i].iter().any(|v| *v < 0.0);
                    let (_, _, clipped) = solve_exposure(
                        [pixels[i][0].max(0.0), pixels[i][1].max(0.0), pixels[i][2].max(0.0)],
                        profile,
                        jhk_for_ap0([request.refl; 3], profile),
                        request.refl,
                    );
                    (if projected { 1 } else { 0 }) | (if clipped { 2 } else { 0 })
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(cpu_stats.non_finite_pixels as usize, 1);
        for (i, base) in cpu_base.iter().enumerate() {
            let out = &packed[i * 4..i * 4 + 4];
            if expected_flags[i] & 4 != 0 {
                assert_eq!(flags[i], 4, "profile {profile} non-finite flag");
                continue;
            }
            let max_base_error = base
                .iter()
                .enumerate()
                .map(|(channel, value)| (out[channel] - value).abs())
                .fold(0.0_f32, f32::max);
            let exposure_error_stops = (out[3] - cpu_exposure[i]).abs() * 20.0;
            assert!(max_base_error <= 0.0002, "profile {profile} pixel {i} base error {max_base_error}");
            assert!(exposure_error_stops <= 0.002, "profile {profile} pixel {i} exposure error {exposure_error_stops}");
            assert_eq!(flags[i], expected_flags[i], "profile {profile} pixel {i} diagnostic flags");
        }
    }
}
