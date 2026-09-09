import { zlibSync } from "fflate";

/** Serialize HALF samples in the little-endian byte order required by EXR. */
export function littleEndianHalfBytes(values: Uint16Array): Uint8Array {
  const bytes = new Uint8Array(values.byteLength);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < values.length; index += 1) view.setUint16(index * 2, values[index], true);
  return bytes;
}

/**
 * Apply the OpenEXR ZIP/ZIP16 predictor and return a block payload.
 *
 * ZIP blocks may contain raw little-endian bytes when deflate does not reduce
 * their size. Readers distinguish that lossless fallback by exact payload
 * size, so the comparison must happen after ZIP preprocessing.
 */
export function encodeZip16Block(rawLittleEndian: Uint8Array): Uint8Array {
  const separatedLength = Math.ceil(rawLittleEndian.byteLength / 2);
  const prepared = new Uint8Array(rawLittleEndian.byteLength);
  for (let index = 0; index < separatedLength; index += 1) {
    prepared[index] = rawLittleEndian[index * 2];
    if (index * 2 + 1 < rawLittleEndian.byteLength) prepared[separatedLength + index] = rawLittleEndian[index * 2 + 1];
  }
  let previous = prepared[0] ?? 0;
  for (let index = 1; index < prepared.length; index += 1) {
    const sample = prepared[index];
    prepared[index] = (sample - previous + 128) & 0xff;
    previous = sample;
  }
  const compressed = zlibSync(prepared);
  return compressed.byteLength < rawLittleEndian.byteLength ? compressed : rawLittleEndian;
}

export const OPENEXR_MAGIC = new Uint8Array([0x76, 0x2f, 0x31, 0x01]);

export type ExrFileSink = {
  write(data: Uint8Array, offset?: number): Promise<void>;
  close(): Promise<void>;
  size: number;
  name: string;
};

function u32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value >>> 0, true); return bytes; }
function i32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value | 0, true); return bytes; }
function f32(value: number): Uint8Array { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setFloat32(0, value, true); return bytes; }
function u64(value: number): Uint8Array { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true); return bytes; }
function ascii(value: string): Uint8Array { return new TextEncoder().encode(`${value}\0`); }
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

export class ScanlineExrWriter {
  readonly height: number;
  private readonly sink: ExrFileSink;
  private readonly channels: string[];
  private readonly offsets: number[];
  private cursor = 0;
  private tableOffset = 0;
  private readonly blockRows = 16;
  private pendingRows: Uint8Array[] = [];
  private rowsWritten = 0;

  private constructor(sink: ExrFileSink, height: number, channels: string[]) {
    this.sink = sink;
    this.height = height;
    this.channels = channels;
    this.offsets = new Array(Math.ceil(height / this.blockRows)).fill(0);
  }

  private async initialize(width: number, height: number, channels: string[], component: string): Promise<void> {
    const channelEntries = channels.map((name) => concatBytes(ascii(name), i32(1), new Uint8Array([0, 0, 0, 0]), i32(1), i32(1)));
    const chlist = concatBytes(...channelEntries, new Uint8Array([0]));
    const chromaticities = new Uint8Array(32);
    const chromaticityView = new DataView(chromaticities.buffer);
    [[0.713, 0.293], [0.165, 0.830], [0.128, 0.044], [0.32168, 0.33767]].forEach((value, index) => {
      chromaticityView.setFloat32(index * 8, value[0], true);
      chromaticityView.setFloat32(index * 8 + 4, value[1], true);
    });
    const attr = (name: string, type: string, value: Uint8Array) => concatBytes(ascii(name), ascii(type), u32(value.byteLength), value);
    const header = concatBytes(
      OPENEXR_MAGIC, u32(2),
      attr("channels", "chlist", chlist), attr("compression", "compression", new Uint8Array([3])),
      attr("dataWindow", "box2i", concatBytes(i32(0), i32(0), i32(width - 1), i32(height - 1))),
      attr("displayWindow", "box2i", concatBytes(i32(0), i32(0), i32(width - 1), i32(height - 1))),
      attr("lineOrder", "lineOrder", new Uint8Array([0])), attr("pixelAspectRatio", "float", f32(1)),
      attr("screenWindowCenter", "v2f", concatBytes(f32(0), f32(0))), attr("screenWindowWidth", "float", f32(1)),
      attr("chromaticities", "chromaticities", chromaticities), attr("ocioColorSpace", "string", ascii("ACEScg")),
      attr("decompositionComponent", "string", ascii(component)),
      ...(component === "exposure_norm-ev"
        ? [attr("decompositionExposureEncoding", "string", ascii("normalized_exposure=clamp(log2(s),-10,10)/20+0.5; scalar s is not stored in this channel"))]
        : component === "exposure"
          ? [attr("decompositionExposureEncoding", "string", ascii("RGB=(s,s,s); direct solved s; linear scalar"))]
          : []),
      new Uint8Array([0]),
    );
    await this.sink.write(header);
    this.cursor += header.byteLength;
    this.tableOffset = this.cursor;
    await this.sink.write(concatBytes(...this.offsets.map(() => u64(0))));
    this.cursor += this.offsets.length * 8;
  }

  static async create(sink: ExrFileSink, width: number, height: number, channels: string[], component: string): Promise<ScanlineExrWriter> {
    const writer = new ScanlineExrWriter(sink, height, channels);
    await writer.initialize(width, height, channels, component);
    return writer;
  }

  async writeRow(y: number, values: Record<string, Uint16Array>): Promise<void> {
    if (y !== this.rowsWritten) throw new Error(`EXR rows must be written in order (expected ${this.rowsWritten}, received ${y}).`);
    const rowParts = this.channels.map((channel) => littleEndianHalfBytes(values[channel]));
    this.pendingRows.push(concatBytes(...rowParts));
    this.rowsWritten += 1;
    if (this.pendingRows.length === this.blockRows || this.rowsWritten === this.height) await this.flushBlock(y - this.pendingRows.length + 1);
  }

  private async flushBlock(startY: number): Promise<void> {
    if (!this.pendingRows.length) return;
    const raw = concatBytes(...this.pendingRows);
    const payload = encodeZip16Block(raw);
    const blockIndex = Math.floor(startY / this.blockRows);
    this.offsets[blockIndex] = this.cursor;
    await this.sink.write(concatBytes(i32(startY), u32(payload.byteLength), payload));
    this.cursor += 8 + payload.byteLength;
    this.pendingRows = [];
  }

  get size(): number { return this.sink.size; }

  async close(): Promise<void> {
    if (this.rowsWritten !== this.height) throw new Error(`EXR writer closed after ${this.rowsWritten} of ${this.height} rows.`);
    for (let index = 0; index < this.offsets.length; index += 1) await this.sink.write(u64(this.offsets[index]), this.tableOffset + index * 8);
    await this.sink.close();
  }
}
