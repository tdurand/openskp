import { describe, it, expect } from 'vitest';
import { create, Point3 } from '../src/create';
import { parseSkp } from '../src/index';
import { faceUvBasis, computeFaceUv } from '../src/model';
import { reconstructLoopVertices } from '../src/geometry';

/**
 * `uvMatrixForFace` used to fit its 3x3 UV-to-world matrix against the
 * face's FIRST EDGE direction (`faceUvBasis(points, normal)`, a create.ts-
 * local helper of the same name as, but different from, model.ts's
 * `faceUvBasis(normal)`). The reader turns that matrix back into UV with
 * the NORMAL-derived basis instead (`readFtc` / face-groups.ts's own
 * `faceUvBasis(fn)` call, exported from model.ts as `faceUvBasis`). Those
 * two bases only coincide when a flat face's first edge happens to be +X -
 * any other winding, or any non-flat face, got its texture written against
 * one basis and read back against another: rotated/skewed UVs in
 * SketchUp.
 *
 * This test writes three faces with an explicit `frontUv` mapping their
 * first three corners to (0,0)/(1,0)/(1,1), round-trips the bytes through
 * this package's own `parseSkp`, and recomputes each corner's UV the same
 * way the reader/face-groups.ts scene builder does: `faceUvBasis(normal)`
 * + `computeFaceUv`. All four corners (including the 4th, never given
 * explicitly - an affine map fits the whole plane, not just the 3 named
 * points) must come back matching what was written.
 */

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Mirrors create.test.ts's own makeTestPng fixture generator (dependency-
// free, raw-deflate PNG).
function makeTestPng(size = 4, rgb: [number, number, number] = [200, 50, 50]): Uint8Array {
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
  const rawRows: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
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

const c30 = Math.cos(Math.PI / 6);
const s30 = Math.sin(Math.PI / 6);

const TEST_FACES: { name: string; points: Point3[] }[] = [
  {
    name: 'flat square, first edge +X',
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ],
  },
  {
    name: 'flat square, first edge +Y (rotated 90deg)',
    points: [
      [100, 0, 0],
      [100, 10, 0],
      [90, 10, 0],
      [90, 0, 0],
    ],
  },
  {
    name: 'tilted 30deg roof quad',
    points: [
      [200, 0, 0],
      [200, 10 * c30, 10 * s30],
      [210, 10 * c30, 10 * s30],
      [210, 0, 0],
    ],
  },
];

const UV_CORNERS: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

describe('a written face texture matrix survives round-trip through the normal-derived reader basis', () => {
  it('recovers the exact UV at every corner, including the 4th one never given explicitly', () => {
    const builder = create();
    const png = makeTestPng();
    // Width/height default to 1.0 (openskp#252), so the matrix maps
    // directly to the given 0..1 uv pairs with no extra tile scaling.
    const brick = builder.addTextureMaterial('Brick', png, 'brick.png');

    for (const face of TEST_FACES) {
      const frontUv: [Point3, [number, number]][] = [0, 1, 2].map((i) => [face.points[i], UV_CORNERS[i]]);
      builder.addFace(face.points, { material: brick, frontUv });
    }

    const model = parseSkp(toBuffer(builder.toBytes()));
    expect(model.root.faces.length).toBe(TEST_FACES.length);

    const vertexById = new Map(model.root.vertices.map((v) => [v.id, [v.x, v.y, v.z] as Point3]));
    const edgeMap = new Map(model.root.edges.map((e) => [e.id, [e.v1Id, e.v2Id] as [number, number]]));

    model.root.faces.forEach((face, idx) => {
      const expected = TEST_FACES[idx];
      const loopVertIds = reconstructLoopVertices(face.loops[0], edgeMap);
      const points = loopVertIds.map((id) => vertexById.get(id)!);
      expect(points.length).toBe(expected.points.length);

      const { xr, yr } = faceUvBasis(face.normal);

      for (const p of points) {
        // Match the parsed point back to its original corner by nearest
        // position - loop winding/start vertex isn't guaranteed to match
        // input order.
        let bestIdx = -1;
        let bestDist = Infinity;
        expected.points.forEach((ep, i) => {
          const d = Math.hypot(p[0] - ep[0], p[1] - ep[1], p[2] - ep[2]);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        });
        const [expectedU, expectedV] = UV_CORNERS[bestIdx];
        const [u, v] = computeFaceUv(p, xr, yr, face.uvTransform, 1, 1);
        expect(u).toBeCloseTo(expectedU, 6);
        expect(v).toBeCloseTo(expectedV, 6);
      }
    });
  });
});
