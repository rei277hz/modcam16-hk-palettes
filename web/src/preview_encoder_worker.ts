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
  const input = new Uint8Array(await (await inputHandle.getFile()).arrayBuffer());
  const encoded = encode_preview_pixels(input, message.width, message.height);
  const bytes = encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
  const outputHandle = await root.getFileHandle(message.output, { create: true });
  if (outputHandle.createSyncAccessHandle) {
    const access = await outputHandle.createSyncAccessHandle();
    try {
      const result = access.write(bytes, { at: 0 });
      if (result && typeof result.then === "function") await result;
      access.truncate(bytes.byteLength);
      access.flush();
    } finally {
      access.close();
    }
  } else if (outputHandle.createWritable) {
    const writable = await outputHandle.createWritable({ keepExistingData: false });
    await writable.write(bytes);
    await writable.close();
  } else {
    throw new Error("This browser cannot write the preview JPEG to local scratch storage.");
  }
  // Release references before notifying the decomposition worker. The worker
  // is terminated immediately after each preview, reclaiming its WASM heap.
  postMessage({ kind: "complete", id: message.id, size: bytes.byteLength });
}

self.onmessage = (event: MessageEvent<EncodeMessage>) => {
  void encode(event.data).catch((error) => {
    postMessage({ kind: "error", id: event.data.id, message: error instanceof Error ? error.message : String(error) });
  });
};
