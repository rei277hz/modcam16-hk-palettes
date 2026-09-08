import { checkpoint, setDebugMemory } from "./debug_worker";
import { readScratchFile, removeIndexedDbFile, writeIndexedDbFile } from "./scratch_store";
import init, { encode_preview_pixels } from "./wasm/decomposition/modcam16_decomposition_wasm.js";

type EncodeMessage = {
  id: number;
  input: string;
  output: string;
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
};

function resizeRgb(source: Uint8Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Uint8Array {
  if (sourceWidth === width && sourceHeight === height) return source;
  const target = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width));
      const si = (sy * sourceWidth + sx) * 3;
      const di = (y * width + x) * 3;
      target[di] = source[si];
      target[di + 1] = source[si + 1];
      target[di + 2] = source[si + 2];
    }
  }
  return target;
}

let ready: Promise<void> | undefined;
function ensureWasm(): Promise<void> {
  if (!ready) {
    checkpoint("Initialize JPEG encoder WASM");
    ready = init().then(exports => { setDebugMemory(exports.memory); checkpoint("JPEG encoder WASM ready"); });
  }
  return ready;
}

async function encode(message: EncodeMessage): Promise<void> {
  const startedAt = performance.now();
  checkpoint("JPEG encoding requested", message);
  await ensureWasm();
  const file = await readScratchFile(message.input);
  const { width, height } = message;
  const sourceWidth = message.sourceWidth ?? width;
  const sourceHeight = message.sourceHeight ?? height;
  const expectedBytes = sourceWidth * sourceHeight * 3;
  checkpoint("JPEG scratch file opened", { id: message.id, size: file.size, expectedBytes, width, height, sourceWidth, sourceHeight });
  if (file.size !== expectedBytes) throw new Error("Preview scratch file has an invalid size.");
  let source = new Uint8Array(await file.arrayBuffer());
  let input = resizeRgb(source, sourceWidth, sourceHeight, width, height);
  if (input !== source) source = new Uint8Array();
  checkpoint("JPEG pixels loaded; encode WASM start", { id: message.id, width, height, sourceWidth, sourceHeight, inputBytes: input.byteLength });
  const bytes = encode_preview_pixels(input, width, height);
  input = new Uint8Array();
  source = new Uint8Array();
  checkpoint("JPEG encode WASM complete; write output", { id: message.id, jpegBytes: bytes.byteLength });
  let outputHandle: any;
  try {
    const root = await (navigator.storage as any).getDirectory();
    outputHandle = await root.getFileHandle(message.output, { create: true });
  } catch (error) {
    console.warn("JPEG OPFS file handle creation failed; using IndexedDB scratch storage", { output: message.output }, error);
  }
  let wrote = false;
  if (outputHandle?.createSyncAccessHandle) {
    try {
      const access = await outputHandle.createSyncAccessHandle();
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          const count = access.write(bytes.subarray(written), { at: written });
          if (!Number.isInteger(count) || count <= 0) throw new Error("Preview JPEG write did not complete.");
          written += count;
        }
        access.truncate(bytes.byteLength);
        access.flush();
        await removeIndexedDbFile(message.output);
        wrote = true;
      } finally {
        access.close();
      }
    } catch (error) {
      console.warn("JPEG OPFS sync handle unavailable; trying writable stream", { output: message.output }, error);
    }
  }
  if (!wrote && outputHandle?.createWritable) {
    try {
      const writable = await outputHandle.createWritable({ keepExistingData: false });
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      await removeIndexedDbFile(message.output);
      wrote = true;
    } catch (error) {
      console.warn("JPEG OPFS writable stream unavailable; using IndexedDB scratch storage", { output: message.output }, error);
    }
  }
  if (!wrote) {
    await writeIndexedDbFile(message.output, bytes, 0);
    wrote = true;
  }
  if (!wrote) {
    throw new Error("This browser cannot write the preview JPEG to local scratch storage.");
  }
  // Release references before notifying the decomposition worker. The worker
  // is terminated immediately after each preview, reclaiming its WASM heap.
  checkpoint("JPEG output complete", { id: message.id, output: message.output, width, height, bytes: bytes.byteLength, elapsedMs: performance.now() - startedAt });
  postMessage({ kind: "complete", id: message.id, size: bytes.byteLength, width, height });
}

self.onmessage = (event: MessageEvent<EncodeMessage>) => {
  void encode(event.data).catch((error) => {
    console.error("JPEG encoding failed", event.data, error);
    postMessage({ kind: "error", id: event.data.id, message: error instanceof Error ? error.message : String(error) });
  });
};
