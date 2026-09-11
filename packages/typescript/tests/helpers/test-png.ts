/**
 * A minimal, dependency-free PNG generator, shared by the writer tests
 * that need real image bytes for `addTextureMaterial`. Lifted out of
 * create.test.ts so model-attributes.test.ts can build the same textured
 * material without a second copy of it.
 */
// A minimal, dependency-free 4x4 solid-color PNG (raw deflate stored
// blocks, no compression library needed) - mirrors Python's
// _make_test_png fixture generator, avoiding an image-library dependency
// just for a test fixture.
export function makeTestPng(size = 4, rgb: [number, number, number] = [200, 50, 50]): Uint8Array {
  function crc32(buf: number[]): number {
    let c: number;
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function u32be(v: number): number[] {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }
  function chunk(tag: number[], data: number[]): number[] {
    return [...u32be(data.length), ...tag, ...data, ...u32be(crc32([...tag, ...data]))];
  }
  // Raw, uncompressed zlib stream: zlib header (0x78 0x01) + one stored
  // (uncompressed) deflate block per scanline.
  const rawRows: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter type 0 (none)
    for (let x = 0; x < size; x++) row.push(...rgb);
    rawRows.push(row);
  }
  const rawData = rawRows.flat();
  let adler1 = 1;
  let adler2 = 0;
  for (const b of rawData) {
    adler1 = (adler1 + b) % 65521;
    adler2 = (adler2 + adler1) % 65521;
  }
  const deflate: number[] = [];
  const CHUNK = 65535;
  for (let i = 0; i < rawData.length; i += CHUNK) {
    const slice = rawData.slice(i, i + CHUNK);
    const isFinal = i + CHUNK >= rawData.length;
    deflate.push(isFinal ? 1 : 0);
    const len = slice.length;
    deflate.push(len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff);
    deflate.push(...slice);
  }
  const zlibStream = [0x78, 0x01, ...deflate, (adler2 >> 8) & 0xff, adler2 & 0xff, (adler1 >> 8) & 0xff, adler1 & 0xff];
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk([0x49, 0x48, 0x44, 0x52], [...u32be(size), ...u32be(size), 8, 2, 0, 0, 0]);
  const idat = chunk([0x49, 0x44, 0x41, 0x54], zlibStream);
  const iend = chunk([0x49, 0x45, 0x4e, 0x44], []);
  return Uint8Array.from([...sig, ...ihdr, ...idat, ...iend]);
}
