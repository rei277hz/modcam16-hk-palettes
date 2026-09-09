import assert from "node:assert/strict";
import { test } from "node:test";
import { unzlibSync } from "fflate";
import { encodeZip16Block, littleEndianHalfBytes, OPENEXR_MAGIC, ScanlineExrWriter } from "../src/exr_zip.ts";

class MemorySink {
  bytes = new Uint8Array();
  name = "test.exr";
  get size() { return this.bytes.byteLength; }
  async write(data, offset = this.size) {
    const end = offset + data.byteLength;
    if (end > this.bytes.byteLength) {
      const expanded = new Uint8Array(end);
      expanded.set(this.bytes);
      this.bytes = expanded;
    }
    this.bytes.set(data, offset);
  }
  async close() {}
}

function decodeZipBlock(payload, rawSize) {
  if (payload.byteLength === rawSize) return new Uint8Array(payload);
  const prepared = unzlibSync(payload);
  const samples = new Uint8Array(prepared);
  let previous = samples[0] ?? 0;
  for (let index = 1; index < samples.length; index += 1) {
    samples[index] = (previous + samples[index] - 128) & 0xff;
    previous = samples[index];
  }
  const raw = new Uint8Array(samples.length);
  const half = Math.ceil(samples.length / 2);
  for (let index = 0; index < half; index += 1) {
    raw[index * 2] = samples[index];
    if (index * 2 + 1 < raw.length) raw[index * 2 + 1] = samples[half + index];
  }
  return raw;
}

function readHeaderAttributes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const readCString = (start) => {
    let end = start;
    while (bytes[end] !== 0) end += 1;
    return [decoder.decode(bytes.subarray(start, end)), end + 1];
  };
  const attributes = new Map();
  let cursor = 8;
  while (true) {
    const [name, afterName] = readCString(cursor);
    cursor = afterName;
    if (!name) break;
    const [type, afterType] = readCString(cursor);
    cursor = afterType;
    const size = view.getUint32(cursor, true);
    cursor += 4;
    const value = bytes.subarray(cursor, cursor + size);
    attributes.set(name, { type, value: decoder.decode(value).replace(/\0$/, "") });
    cursor += size;
  }
  return { attributes, end: cursor };
}

test("writes a standards-compliant ZIP16 EXR that round-trips scanlines", async () => {
  const sink = new MemorySink();
  const writer = await ScanlineExrWriter.create(sink, 3, 17, ["B", "G", "R"], "base");
  const expected = [];
  for (let y = 0; y < 17; y += 1) {
    const row = {
      B: Uint16Array.from({ length: 3 }, (_, x) => 0x1000 + y * 3 + x),
      G: Uint16Array.from({ length: 3 }, (_, x) => 0x2000 + y * 3 + x),
      R: Uint16Array.from({ length: 3 }, (_, x) => 0x3000 + y * 3 + x),
    };
    expected.push(new Uint8Array([...littleEndianHalfBytes(row.B), ...littleEndianHalfBytes(row.G), ...littleEndianHalfBytes(row.R)]));
    await writer.writeRow(y, row);
  }
  await writer.close();

  assert.deepEqual(Array.from(sink.bytes.subarray(0, 4)), Array.from(OPENEXR_MAGIC));
  assert.equal(sink.bytes[8], 0x63); // channels attribute starts after magic/version.
  const { end: headerEnd } = readHeaderAttributes(sink.bytes);
  assert.ok(headerEnd > 100, "header terminator present");

  // The offset table immediately follows the header. Locate both chunks from
  // their little-endian scanline coordinate and validate every row payload.
  const view = new DataView(sink.bytes.buffer);
  const chunkStart = Number(view.getBigUint64(headerEnd, true));
  const line0 = view.getInt32(chunkStart, true);
  const payloadSize = view.getUint32(chunkStart + 4, true);
  assert.equal(line0, 0);
  const firstRaw = decodeZipBlock(sink.bytes.subarray(chunkStart + 8, chunkStart + 8 + payloadSize), 16 * 3 * 3 * 2);
  assert.deepEqual(Array.from(firstRaw), Array.from(expected.slice(0, 16).reduce((all, row) => new Uint8Array([...all, ...row]), new Uint8Array())));
  const secondChunk = Number(view.getBigUint64(headerEnd + 8, true));
  assert.equal(view.getInt32(secondChunk, true), 16);
  const secondPayloadSize = view.getUint32(secondChunk + 4, true);
  const secondRaw = decodeZipBlock(sink.bytes.subarray(secondChunk + 8, secondChunk + 8 + secondPayloadSize), 1 * 3 * 3 * 2);
  assert.deepEqual(Array.from(secondRaw), Array.from(expected[16]));
});

test("serializes the normalized EV component name as an EXR string", async () => {
  const sink = new MemorySink();
  await ScanlineExrWriter.create(sink, 1, 1, ["exposure"], "exposure_norm-ev");
  const { attributes } = readHeaderAttributes(sink.bytes);
  assert.equal(attributes.get("decompositionComponent")?.type, "string");
  assert.equal(attributes.get("decompositionComponent")?.value, "exposure_norm-ev");
});

test("uses raw little-endian bytes when ZIP would expand a block", () => {
  const raw = Uint8Array.from([149, 51, 171, 150, 200, 208, 94, 158, 90, 136, 5, 118, 65, 147, 27, 207, 234, 182, 22, 226, 165, 37, 245, 9, 150, 21, 224, 99, 191, 180, 63, 39, 123, 13, 10, 205, 160, 149, 93, 211, 197, 209, 21, 190, 12, 254, 152, 111, 243, 132, 22, 205, 189, 89, 62, 214, 205, 201, 145, 245, 74, 201, 173, 174]);
  const payload = encodeZip16Block(raw);
  assert.equal(payload.byteLength, raw.byteLength);
  assert.deepEqual(Array.from(payload), Array.from(raw));
});
