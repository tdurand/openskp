import { describe, it, expect } from 'vitest';
import { _internal, create, Point3 } from '../src/create';
import { parseSkp } from '../src/index';

/**
 * ArchiveWriter accumulates the archive in a GrowableBytes: a list of
 * typed-array chunks (never copied) instead of a number[] (~9 bytes of heap
 * per file byte) or one Uint8Array that doubles (a 1 GB archive then asks
 * for a 2 GB block while the 1 GB it copies from is still alive).
 */
describe('GrowableBytes', () => {
  const { GrowableBytes } = _internal;
  const joined = (b: InstanceType<typeof GrowableBytes>) => Array.from(b.view());

  it('push appends in order across chunk boundaries', () => {
    const b = new GrowableBytes(4);
    b.push(1, 2, 3);
    b.push(4, 5); // does not fit the 4-byte first chunk: seals it
    expect(b.length).toBe(5);
    expect(b.parts().length).toBe(2);
    expect(joined(b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('append takes a Uint8Array or a plain array and keeps earlier bytes', () => {
    const b = new GrowableBytes(2);
    b.push(9);
    b.append(new Uint8Array([1, 2, 3]));
    b.append([4, 5]);
    expect(joined(b)).toEqual([9, 1, 2, 3, 4, 5]);
  });

  it('a write larger than the next chunk gets a chunk of its own size', () => {
    const b = new GrowableBytes(4);
    b.push(1);
    const big = Array.from({ length: 100 }, (_, i) => i);
    b.append(big);
    expect(joined(b)).toEqual([1, ...big]);
  });

  it('every push lands in one chunk, so parts concatenate to the bytes written', () => {
    const b = new GrowableBytes(8);
    const expected: number[] = [];
    for (let i = 0; i < 200; i++) {
      const rec = [i & 0xff, (i * 7) & 0xff, (i * 13) & 0xff];
      b.push(...rec);
      expected.push(...rec);
    }
    const parts = b.parts();
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.reduce((n, p) => n + p.length, 0)).toBe(b.length);
    expect(joined(b)).toEqual(expected);
  });

  it('patchU32 rewrites bytes in sealed chunks and across a chunk boundary', () => {
    const b = new GrowableBytes(4);
    for (let i = 0; i < 64; i++) b.push(0); // byte by byte, as pushZeros does
    expect(b.parts().length).toBeGreaterThan(2);
    b.patchU32(0, 0x04030201); // first, sealed chunk
    b.patchU32(2, 0x08070605); // straddles the 4-byte first chunk
    b.patchU32(30, 0xddccbbaa); // a middle chunk
    b.patchU32(60, 0x11223344); // live chunk
    const v = b.view();
    expect(Array.from(v.subarray(0, 6))).toEqual([1, 2, 5, 6, 7, 8]);
    expect(Array.from(v.subarray(30, 34))).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(Array.from(v.subarray(60, 64))).toEqual([0x44, 0x33, 0x22, 0x11]);
  });

  it('grows past 1 MB without losing bytes', () => {
    const b = new GrowableBytes(16);
    const n = 1_500_000;
    for (let i = 0; i < n; i++) b.push(i & 0xff);
    expect(b.length).toBe(n);
    const v = b.view();
    expect(v[0]).toBe(0);
    expect(v[255]).toBe(255);
    expect(v[n - 1]).toBe((n - 1) & 0xff);
  });
});

describe('SkpBuilder.toParts', () => {
  // A grid of triangles per group, large enough that the definition
  // archive spans several chunks and each group's entity count is patched
  // back into a chunk that is already sealed.
  function gridBuilder(groups: number, n: number) {
    const builder = create();
    for (let g = 0; g < groups; g++) {
      builder.addGroup(
        (def) => {
          for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
              const p = (x: number, y: number): Point3 => [x * 10 + g * 1000, y * 10, ((x * 7 + y * 3) % 5) * 2];
              def.addFace([p(i, j), p(i + 1, j), p(i + 1, j + 1)]);
              def.addFace([p(i, j), p(i + 1, j + 1), p(i, j + 1)]);
            }
          }
        },
        { name: `G${g}` }
      );
    }
    return builder;
  }

  it('slices concatenate to a file that parses group by group', () => {
    const builder = gridBuilder(3, 20);
    const parts = builder.toParts();
    expect(parts.filter((p) => !p.scaffold).length).toBeGreaterThan(3);
    expect(parts.some((p) => p.scaffold)).toBe(true);
    const total = parts.reduce((n, p) => n + p.bytes.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      bytes.set(p.bytes, offset);
      offset += p.bytes.length;
    }
    const model = parseSkp(bytes.buffer as ArrayBuffer);
    expect(model.root.instances.map((i) => i.name).sort()).toEqual(['G0', 'G1', 'G2']);
    for (const def of model.definitions.values()) expect(def.faces.length).toBe(800);
  });

  it('toBytes is the joined toParts', () => {
    const a = gridBuilder(2, 5).toBytes();
    const b = gridBuilder(2, 5).toParts();
    expect(a.length).toBe(b.reduce((n, p) => n + p.bytes.length, 0));
  });
});
