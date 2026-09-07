import assert from "node:assert/strict";
import test from "node:test";
import { sourceBatches } from "../src/source_batches.ts";
import { batchPixelLimit, convertExrRow } from "../src/decomposition_buffers.ts";

function controlledSource(totalPixels) {
  const reads = [];
  const file = {
    size: totalPixels * 12,
    slice(start, stop) {
      return { arrayBuffer: () => new Promise((resolve, reject) => {
        reads.push({ start, stop, resolve: () => resolve(new ArrayBuffer(stop - start)), reject });
      }) };
    },
  };
  return { file, reads };
}

test("loads exactly one batch ahead while the consumer works", async () => {
  const { file, reads } = controlledSource(10);
  const batches = sourceBatches(file, 10, 4);
  const first = batches.next();
  assert.equal(reads.length, 1);
  reads[0].resolve();
  const current = (await first).value;
  assert.deepEqual([current.start, current.stop], [0, 4]);
  assert.equal(reads.length, 2, "next read starts before current processing");
  reads[1].resolve();
  await new Promise(setImmediate);
  assert.equal(reads.length, 2, "a completed prefetch cannot trigger a third read");
  current.pixels = new Float32Array();
  const second = (await batches.next()).value;
  assert.deepEqual([second.start, second.stop], [4, 8]);
  assert.equal(reads.length, 3);
  second.pixels = new Float32Array();
  reads[2].resolve();
  const last = (await batches.next()).value;
  assert.deepEqual([last.start, last.stop, last.pixels.length], [8, 10, 6]);
  assert.equal((await batches.next()).done, true);
  assert.equal(reads.length, 3);
});

test("preserves pixel order and values including a short final batch", async () => {
  const pixels = Float32Array.from({ length: 77 * 3 }, (_, i) => (i - 50) / 7);
  const file = new Blob([pixels]);
  const actual = [];
  for await (const batch of sourceBatches(file, 77, 21)) actual.push(...batch.pixels);
  assert.deepEqual(actual, Array.from(pixels));
});

test("observes a prefetch rejection during processing and throws on consumption", async () => {
  const { file, reads } = controlledSource(12);
  const batches = sourceBatches(file, 12, 4);
  const first = batches.next();
  reads[0].resolve();
  await first;
  const failure = new Error("storage read failed");
  reads[1].reject(failure);
  await new Promise(setImmediate); // Would surface an unhandled rejection.
  await assert.rejects(batches.next(), failure);
  assert.equal(reads.length, 2);
});

test("early return drains one pending read before a CPU restart", async () => {
  const { file, reads } = controlledSource(12);
  const gpu = sourceBatches(file, 12, 4);
  const first = gpu.next();
  reads[0].resolve();
  await first;
  let closed = false;
  const stopping = gpu.return().then(() => { closed = true; });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  assert.equal(reads.length, 2);
  reads[1].reject(new Error("discard this failed prefetch"));
  await stopping;
  const cpu = sourceBatches(file, 12, 2);
  const restarted = cpu.next();
  assert.deepEqual([reads[2].start, reads[2].stop], [0, 24]);
  reads[2].resolve();
  assert.equal((await restarted).value.start, 0);
  reads[3].resolve();
  await cpu.return();
  assert.equal(reads.length, 4);
});

test("rejects incomplete files and truncated reads", async () => {
  await assert.rejects(sourceBatches(new Blob([]), 2, 1).next(), /source size/);
  await assert.rejects(sourceBatches(new Blob([new Uint8Array(24)]), 2, 0).next(), /batch size/);
  const truncated = { size: 24, slice: () => new Blob([new Uint8Array(3)]) };
  await assert.rejects(sourceBatches(truncated, 2, 1).next(), /could not be read/);
});

test("batch budgets are row-aligned and respect the GPU adapter", () => {
  assert.equal(batchPixelLimit(6000, true), 522000);
  assert.equal(batchPixelLimit(6000, false), 30000);
  assert.equal(batchPixelLimit(6000, true, { max_batch_pixels: 10000 }), 6000);
  assert.equal(batchPixelLimit(6000, true, { max_batch_pixels: 5999 }), 0);
  assert.equal(batchPixelLimit(6000, true, { max_batch_pixels: 0 }), 0);
  assert.equal(batchPixelLimit(6000, false, { max_batch_pixels: 1 }), 30000);
  assert.equal(batchPixelLimit(40000, false), 40000);
  assert.throws(() => batchPixelLimit(0, true), /width/);
});

test("6000x4000 traversal stays bounded, row-aligned, and visits every source sample", async () => {
  const width = 6000, height = 4000, total = width * height;
  const limit = batchPixelLimit(width, true);
  let reads = 0, consumed = 0;
  const file = {
    size: total * 12,
    slice(start, stop) {
      assert.ok(stop - start <= limit * 12);
      assert.equal(start % (width * 12), 0);
      assert.equal(stop % (width * 12), 0);
      reads++;
      assert.ok(reads <= consumed + 2);
      return { arrayBuffer: async () => {
        const pixels = Float32Array.from({ length: (stop - start) / 4 }, (_, i) => (start / 4 + i) % 4096);
        return pixels.buffer;
      } };
    },
  };
  let cursor = 0;
  for await (const batch of sourceBatches(file, total, limit)) {
    assert.equal(batch.start, cursor);
    assert.ok(batch.pixels.every((v, i) => v === (cursor * 3 + i) % 4096));
    cursor = batch.stop;
    batch.pixels = new Float32Array();
    consumed++;
  }
  assert.equal(cursor, total);
  assert.equal(consumed, 46);
});

test("EXR row conversion is independent of batch boundaries", () => {
  const base = new Float32Array([0, 0, 0, 1, 1, 1, 0.1, 0.5, 2, -0.2, 0.1, 0.25]);
  const exposure = new Float32Array([0, 0.5, 0.25, 1]);
  const whole = convertExrRow(base, exposure, 0, 4);
  const first = convertExrRow(base, exposure, 0, 2);
  const last = convertExrRow(base.subarray(6), exposure.subarray(2), 0, 2);
  for (const channel of Object.keys(whole)) {
    assert.deepEqual([...first[channel], ...last[channel]], [...whole[channel]]);
  }
  assert.deepEqual([...whole.exposure], [0x1400, 0x3c00, 0x2800, 0x6400]);
});
