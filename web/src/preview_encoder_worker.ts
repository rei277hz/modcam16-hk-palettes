import init, { encode_preview_pixels } from "./wasm/decomposition/modcam16_decomposition_wasm.js";

type EncodeMessage = {
  id: number;
  input: string;
  output: string;
  width: number;
  height: number;
};

let ready: Promise<void> | undefined;
function ensureWasm(): Promise<void> {
  ready ??= init().then(() => undefined);
  return ready;
}

async function encode(message: EncodeMessage): Promise<void> {
  await ensureWasm();
  const root = await (navigator.storage as any).getDirectory();
  const inputHandle = await root.getFileHandle(message.input);
  const file = await inputHandle.getFile();
  if (file.size !== message.width * message.height * 3) throw new Error("Preview scratch file has an invalid size.");
  const { width, height } = message;
  const input = new Uint8Array(await file.arrayBuffer());
  const bytes = encode_preview_pixels(input, width, height);
  const outputHandle = await root.getFileHandle(message.output, { create: true });
  if (outputHandle.createSyncAccessHandle) {
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
    } finally {
      access.close();
    }
  } else if (outputHandle.createWritable) {
    const writable = await outputHandle.createWritable({ keepExistingData: false });
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
  } else {
    throw new Error("This browser cannot write the preview JPEG to local scratch storage.");
  }
  // Release references before notifying the decomposition worker. The worker
  // is terminated immediately after each preview, reclaiming its WASM heap.
  postMessage({ kind: "complete", id: message.id, size: bytes.byteLength, width, height });
}

self.onmessage = (event: MessageEvent<EncodeMessage>) => {
  void encode(event.data).catch((error) => {
    postMessage({ kind: "error", id: event.data.id, message: error instanceof Error ? error.message : String(error) });
  });
};
