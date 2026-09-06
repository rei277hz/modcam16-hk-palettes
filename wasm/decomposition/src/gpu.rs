//! WebGPU compute backend for the per-pixel decomposition solve.
//!
//! The browser build owns one context per worker. The CPU implementation
//! remains available for native tests and for browsers without WebGPU.

#[cfg(target_arch = "wasm32")]
mod webgpu {
    use super::super::{jhk_for_ap0, Request, SolveStats};
    use futures_channel::oneshot;
    use js_sys::{Object, Reflect};
    use std::cell::RefCell;
    use wasm_bindgen::prelude::*;
    use wgpu::util::DeviceExt;

    const WORKGROUP_SIZE: u32 = 64;
    const MAX_BATCH_PIXELS: usize = 1_048_576;
    const SHADER: &str = include_str!("gpu.wgsl");

    struct GpuContext {
        device: wgpu::Device,
        queue: wgpu::Queue,
        pipeline: wgpu::ComputePipeline,
        bind_group_layout: wgpu::BindGroupLayout,
        max_batch_pixels: usize,
        adapter_name: String,
    }

    pub struct GpuResult {
        pub base: Vec<f32>,
        pub exposure: Vec<f32>,
        pub stats: SolveStats,
    }

    thread_local! {
        static CONTEXT: RefCell<Option<GpuContext>> = const { RefCell::new(None) };
    }

    fn context_error(error: impl std::fmt::Display) -> JsValue {
        JsValue::from_str(&format!("WebGPU initialization failed: {error}"))
    }

    async fn create_context() -> Result<GpuContext, JsValue> {
        let instance = wgpu::util::new_instance_with_webgpu_detection(
            wgpu::InstanceDescriptor {
                backends: wgpu::Backends::BROWSER_WEBGPU,
                ..wgpu::InstanceDescriptor::new_without_display_handle()
            },
        )
        .await;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .map_err(context_error)?;
        let adapter_name = adapter.get_info().name;
        let limits = adapter.limits();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(context_error)?;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("modCAM16-HK decomposition"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("decomposition compute bindings"),
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
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("decomposition compute pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("decomposition compute pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let bytes_per_pixel = 16 + 16 + 4;
        let max_by_limit = (limits.max_storage_buffer_binding_size as usize / bytes_per_pixel)
            .max(WORKGROUP_SIZE as usize);
        Ok(GpuContext {
            device,
            queue,
            pipeline,
            bind_group_layout,
            max_batch_pixels: MAX_BATCH_PIXELS.min(max_by_limit),
            adapter_name,
        })
    }

    pub async fn probe() -> Result<JsValue, JsValue> {
        let context = create_context().await?;
        let object = Object::new();
        Reflect::set(&object, &JsValue::from_str("available"), &JsValue::TRUE)?;
        Reflect::set(
            &object,
            &JsValue::from_str("adapter_name"),
            &JsValue::from_str(&context.adapter_name),
        )?;
        Reflect::set(
            &object,
            &JsValue::from_str("max_batch_pixels"),
            &JsValue::from_f64(context.max_batch_pixels as f64),
        )?;
        CONTEXT.with(|slot| *slot.borrow_mut() = Some(context));
        Ok(object.into())
    }

    async fn map_readback(
        device: &wgpu::Device,
        buffer: &wgpu::Buffer,
        size: u64,
    ) -> Result<Vec<u8>, String> {
        let slice = buffer.slice(..size);
        let (sender, receiver) = oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result.map_err(|error| error.to_string()));
        });
        device
            .poll(wgpu::PollType::Poll)
            .map_err(|error| format!("WebGPU polling failed: {error}"))?;
        let result = receiver
            .await
            .map_err(|_| "WebGPU readback channel was dropped".to_string())?
            .map_err(|error| format!("WebGPU readback failed: {error}"))?;
        device
            .poll(wgpu::PollType::Wait)
            .map_err(|error| format!("WebGPU polling failed: {error}"))?;
        let view = buffer
            .slice(..size)
            .get_mapped_range()
            .to_vec();
        buffer.unmap();
        Ok(view)
    }

    fn bytes_as_f32(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect()
    }

    fn bytes_as_u32(bytes: &[u8]) -> Vec<u32> {
        bytes
            .chunks_exact(4)
            .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect()
    }

    pub async fn solve(data: Vec<f32>, request: &Request) -> Result<GpuResult, String> {
        if data.len() % 3 != 0 {
            return Err("Prepared pixel chunk must contain RGB triples.".into());
        }
        let count = data.len() / 3;
        let mut input = Vec::with_capacity(count * 4);
        for pixel in data.chunks_exact(3) {
            input.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0.0]);
        }
        let (device, queue, pipeline, bind_group_layout, max_batch_pixels) = CONTEXT.with(|slot| {
            let context = slot.borrow();
            let context = context
                .as_ref()
                .ok_or_else(|| "WebGPU has not been initialized.".to_string())?;
            Ok((
                context.device.clone(),
                context.queue.clone(),
                context.pipeline.clone(),
                context.bind_group_layout.clone(),
                context.max_batch_pixels,
            ))
        })?;
        if count > max_batch_pixels {
            return Err(format!(
                "GPU batch has {count} pixels but the adapter limit is {max_batch_pixels}."
            ));
        }
        let target = jhk_for_ap0([request.refl; 3], request.profile) as f32;
        let params = [
            request.profile,
            request.refl.to_bits(),
            target.to_bits(),
            count as u32,
        ];
        let input_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("decomposition input"),
                contents: bytemuck::cast_slice(&input),
                usage: wgpu::BufferUsages::STORAGE,
        });
        let output_size = (count * 4 * std::mem::size_of::<f32>()) as u64;
        let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("decomposition output"),
                size: output_size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
        });
        let flags_size = (count * std::mem::size_of::<u32>()) as u64;
        let flags_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("decomposition flags"),
                size: flags_size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
        });
        let params_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("decomposition parameters"),
                contents: bytemuck::cast_slice(&params),
                usage: wgpu::BufferUsages::UNIFORM,
        });
        let output_readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("decomposition output readback"),
                size: output_size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
        });
        let flags_readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("decomposition flags readback"),
                size: flags_size,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("decomposition compute bind group"),
                layout: &bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: params_buffer.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: input_buffer.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: output_buffer.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: flags_buffer.as_entire_binding() },
                ],
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("decomposition compute encoder"),
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("decomposition compute pass"),
                    timestamp_writes: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.dispatch_workgroups((count as u32).div_ceil(WORKGROUP_SIZE), 1, 1);
        }
        encoder.copy_buffer_to_buffer(&output_buffer, 0, &output_readback, 0, output_size);
        encoder.copy_buffer_to_buffer(&flags_buffer, 0, &flags_readback, 0, flags_size);
        queue.submit(Some(encoder.finish()));
        let output_bytes = map_readback(&device, &output_readback, output_size).await?;
        let flags_bytes = map_readback(&device, &flags_readback, flags_size).await?;
        let packed = bytes_as_f32(&output_bytes);
        let flags = bytes_as_u32(&flags_bytes);
        let mut base = Vec::with_capacity(count * 3);
        let mut exposure = Vec::with_capacity(count);
        let mut stats = SolveStats {
            exposure_min: f32::INFINITY,
            exposure_max: f32::NEG_INFINITY,
            base_min: f32::INFINITY,
            base_max: f32::NEG_INFINITY,
            ..SolveStats::default()
        };
        for index in 0..count {
            let offset = index * 4;
            let values = &packed[offset..offset + 4];
            let flag = flags[index];
            if flag & 4 != 0 {
                stats.non_finite_pixels += 1;
                base.extend_from_slice(&[0.0; 3]);
                exposure.push(0.0);
                continue;
            }
            if flag & 1 != 0 {
                stats.projected_pixels += 1;
            }
            if flag & 2 != 0 {
                stats.clipped_pixels += 1;
            }
            let e = (values[3] - 0.5) * 20.0;
            stats.exposure_min = stats.exposure_min.min(e);
            stats.exposure_max = stats.exposure_max.max(e);
            stats.exposure_sum += e as f64;
            for value in &values[..3] {
                stats.base_min = stats.base_min.min(*value);
                stats.base_max = stats.base_max.max(*value);
                stats.base_sum += *value as f64;
                base.push(*value);
            }
            stats.finite_pixels += 1;
            exposure.push(values[3].clamp(0.0, 1.0));
        }
        Ok(GpuResult { base, exposure, stats })
    }
}

#[cfg(target_arch = "wasm32")]
pub use webgpu::{probe, solve};

#[cfg(not(target_arch = "wasm32"))]
pub async fn probe() -> Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue> {
    Err(wasm_bindgen::JsValue::from_str(
        "WebGPU is only available in the wasm32 browser build.",
    ))
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn solve(
    _data: Vec<f32>,
    _request: &super::Request,
) -> Result<(), String> {
    Err("WebGPU is only available in the wasm32 browser build.".into())
}
