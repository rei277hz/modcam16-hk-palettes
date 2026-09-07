export type SourceBatch = { start: number; stop: number; pixels: Float32Array };
type ReadResult = { batch: SourceBatch; error?: never } | { batch?: never; error: unknown };

/** One working batch and one read ahead; no additional source read is queued. */
export async function* sourceBatches(
  file: Pick<Blob, "size" | "slice">,
  totalPixels: number,
  batchPixels: number,
): AsyncGenerator<SourceBatch, void, void> {
  if (!Number.isSafeInteger(totalPixels) || totalPixels <= 0
      || !Number.isSafeInteger(batchPixels) || batchPixels <= 0
      || file.size !== totalPixels * 12) {
    throw new Error("Invalid prepared source size or batch size.");
  }
  const read = async (start: number): Promise<ReadResult> => {
    try {
      const stop = Math.min(totalPixels, start + batchPixels);
      const bytes = await file.slice(start * 12, stop * 12).arrayBuffer();
      if (bytes.byteLength !== (stop - start) * 12) {
        throw new Error("Prepared source batch could not be read from local scratch storage.");
      }
      return { batch: { start, stop, pixels: new Float32Array(bytes) } };
    } catch (error) {
      // Observe a prefetched failure immediately, even while the consumer is
      // busy or restarting on CPU. Throw it only when that batch is consumed.
      return { error };
    }
  };
  let pending: Promise<ReadResult> | undefined = read(0);
  try {
    while (pending) {
      const result = await pending;
      pending = undefined;
      if (!result.batch) throw result.error;
      if (result.batch.stop < totalPixels) pending = read(result.batch.stop);
      yield result.batch;
    }
  } finally {
    // Blob reads cannot be aborted. Drain the single read before a restart,
    // discarding its result without leaving an unhandled rejection.
    await pending;
    pending = undefined;
  }
}
