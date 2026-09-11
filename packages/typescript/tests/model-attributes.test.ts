import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { create, Point3 } from '../src/create';
import { parseSkp } from '../src/index';
import { MODEL_ATTR_NULL_POS } from '../src/scaffold';
import { makeTestPng } from './helpers/test-png';

/**
 * Tests for MODEL-level attribute dictionaries - `addModelAttributeDict`
 * on the write side, `SkpModel.attributes` on the read side.
 *
 * Two risks, and one test each.
 *
 * *Placement.* The model's own `CAttributeContainer` is the last field of
 * the model record, immediately ahead of the material list - NOT the
 * first `CAttributeContainer` declared in the stream, which belongs to
 * whichever record first carried one (a component definition's
 * `Name`/`Description`/`IsClassified` properties, in real files). Writing
 * a `GeoReference` dictionary into that other container produces a file
 * SketchUp opens and reports as "not geo-located". The structural test
 * and the two real-fixture reads below are what pin the right one: both
 * `capilla_quiroz_v17.skp` and `gondola_v20.skp` were geolocated in real
 * SketchUp with Set Manual Location, so their model container is ground
 * truth for the shape this writer emits.
 *
 * *Slot numbering.* The container and its dictionaries take the first
 * archive slots at `BASE` - the ones the material writer would otherwise
 * have handed out - so every later object moves down. The round-trip test
 * builds one model containing every writer's output at once and checks
 * the COUNTS as well as the values: a missed shift shows up as a layer,
 * material, definition or face that no longer resolves, not as a wrong
 * attribute.
 */

const FIXTURES = path.join(__dirname, 'fixtures');

const SQUARE: Point3[] = [
  [0.0, 0.0, 0.0],
  [100.0, 0.0, 0.0],
  [100.0, 100.0, 0.0],
  [0.0, 100.0, 0.0],
];

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function loadFixture(name: string) {
  const buf = fs.readFileSync(path.join(FIXTURES, name));
  return parseSkp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

/** Marseille (43.2965 N, 5.3698 E), the same values the demo script uses.
 * The two translations are minus the UTM easting/northing of the model
 * origin expressed in INCHES, which is the convention real SketchUp
 * writes (verified against a file SketchUp's own Add Location produced:
 * -22943783.43 in = -582772.1 m, the UTM 18N easting of that file's
 * own latitude/longitude, to the centimetre). */
const GEO_REFERENCE = {
  GeoReferenceNorthAngle: 0.0,
  Latitude: 43.2965,
  Longitude: 5.3698,
  LocationSource: 'Custom',
  ModelTranslationX: -27918461.5,
  ModelTranslationY: -189249637.25,
  ModelTranslationZ: 0.0,
  UsesGeoReferencing: true,
};

/** The 14 undecoded model-record bytes that sit between the container and
 * the u32 material count - identical in every legacy file this package
 * bundles, and the reader's own `MODEL_RECORD_TRAILER_LEN` anchor. */
const MODEL_RECORD_TRAILER = [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];

describe('Model attribute dictionaries', () => {
  it('round-trips alongside materials, layers, definitions, instances and faces', () => {
    const builder = create();
    builder.addModelAttributeDict('GeoReference', GEO_REFERENCE);
    builder.addModelAttributeDict('MyDict', { note: 'second dictionary', count: 7, ratio: 0.25 });

    // Everything that allocates archive slots, in the order the writer
    // requires: material -> layers -> definition (with a thumbnail) ->
    // group -> instances -> root faces.
    const brick = builder.addTextureMaterial('Brick', makeTestPng(), 'brick.png');
    const roof = builder.addLayer('Roof');
    const walls = builder.addLayer('Walls');
    const chair = builder.addComponentDefinition('Chair', (def) => {
      def.addFace(SQUARE);
    });
    builder.addGroup(
      (grp) => {
        grp.addFace(SQUARE);
      },
      { name: 'Table', translation: [0, 300, 0] }
    );
    builder.addInstance(chair, { translation: [200, 0, 0] });
    builder.addInstance(chair, { translation: [400, 0, 0], layer: walls });
    builder.addFace(SQUARE, { material: brick, layer: roof });
    builder.addFace(
      [[0, 0, 50], [100, 0, 50], [100, 100, 50], [0, 100, 50]],
      { layer: walls }
    );

    const model = parseSkp(toBuffer(builder.toBytes()));

    // -- the attributes themselves --
    expect(Object.keys(model.attributes).sort()).toEqual(['GeoReference', 'MyDict']);
    const geo = model.attributes.GeoReference;
    expect(geo.Latitude).toBeCloseTo(43.2965, 9);
    expect(geo.Longitude).toBeCloseTo(5.3698, 9);
    expect(geo.GeoReferenceNorthAngle).toBe(0);
    expect(geo.LocationSource).toBe('Custom');
    expect(geo.ModelTranslationX).toBeCloseTo(-27918461.5, 6);
    expect(geo.ModelTranslationY).toBeCloseTo(-189249637.25, 6);
    expect(geo.ModelTranslationZ).toBe(0);
    // A boolean is written as SketchUp's own 1-byte bool (0x07), which
    // legacy.ts decodes as a u8 - so it comes back as the NUMBER 1, not
    // as `true`. Documented on ModelAttributeValue.
    expect(geo.UsesGeoReferencing).toBe(1);
    expect(model.attributes.MyDict).toEqual({ note: 'second dictionary', count: 7, ratio: 0.25 });

    // -- every slot-shifted reference still resolves --
    expect(model.layers.map((l) => l.name).sort()).toEqual(['Layer0', 'Roof', 'Walls']);
    expect(model.materials.map((m) => m.name)).toContain('Brick');
    expect(model.materials.find((m) => m.name === 'Brick')!.texture).not.toBeNull();
    // Chair + Table: one definition each.
    expect(model.definitions.size).toBe(2);
    // Two chair instances + the group instance.
    expect(model.root.instances.length).toBe(3);
    expect(model.root.faces.length).toBe(2);
    expect(model.root.edges.length).toBe(8);
  });

  it('writes the container where real SketchUp writes it, in the same byte shape', () => {
    const builder = create();
    builder.addModelAttributeDict('GeoReference', GEO_REFERENCE);
    builder.addMaterial('Red', [255, 0, 0]);
    builder.addFace(SQUARE);
    const bytes = builder.toBytes();

    // The container replaces the scaffold's null model-attribute pointer:
    // a class-ref to the already-declared CAttributeContainer (slot 3 in
    // this scaffold's numbering) plus its own 3-byte preamble, then a
    // CAttributeNamed child (slot 5) with the same preamble, its u32, and
    // the dictionary name as a UTF-16 string record. Real files carry the
    // identical shape with their own slot numbers (05 80 / 07 80).
    const head = Array.from(bytes.subarray(MODEL_ATTR_NULL_POS, MODEL_ATTR_NULL_POS + 14));
    expect(head).toEqual([
      0x03, 0x80, 0x00, 0x00, 0x00, // container
      0x05, 0x80, 0x00, 0x00, 0x00, // first CAttributeNamed child
      0x00, 0x00, 0x00, 0x00, // its u32
    ]);
    const name = Array.from(bytes.subarray(MODEL_ATTR_NULL_POS + 14, MODEL_ATTR_NULL_POS + 18));
    expect(name).toEqual([0xff, 0xfe, 0xff, 'GeoReference'.length]);

    // ...and it is terminated right before the model-record trailer and
    // the u32 material count - i.e. it really is the model's container,
    // the one the material list follows, not some entity's.
    const tail = [0x00, 0x00, ...MODEL_RECORD_TRAILER, 0x01, 0x00, 0x00, 0x00];
    let at = -1;
    for (let i = MODEL_ATTR_NULL_POS; i + tail.length <= bytes.length; i++) {
      if (tail.every((b, j) => bytes[i + j] === b)) {
        at = i;
        break;
      }
    }
    expect(at).toBeGreaterThan(MODEL_ATTR_NULL_POS);
    // The CMaterial class declaration starts immediately after that count.
    const afterCount = at + tail.length;
    expect(Array.from(bytes.subarray(afterCount, afterCount + 2))).toEqual([0xff, 0xff]);
  });

  it('reads the real GeoReference block out of SketchUp-written files', () => {
    // Both fixtures were geolocated in real SketchUp with Set Manual
    // Location (LocationSource "Manual"). If the reader ever anchors on
    // the wrong CAttributeContainer again, these go empty or report a
    // component definition's Name/Description/IsClassified instead.
    const capilla = loadFixture('capilla_quiroz_v17.skp');
    expect(Object.keys(capilla.attributes).sort()).toEqual([
      'GSU_ContributorsInfo',
      'GeoReference',
      'temp',
    ]);
    expect(capilla.attributes.GeoReference.Latitude).toBeCloseTo(40.018309, 6);
    expect(capilla.attributes.GeoReference.Longitude).toBeCloseTo(-105.242139, 6);
    expect(capilla.attributes.GeoReference.LocationSource).toBe('Manual');
    expect(capilla.attributes.GeoReference.UsesGeoReferencing).toBe(0);
    expect(capilla.attributes.GSU_ContributorsInfo.VersionKey).toBe(1000);

    const gondola = loadFixture('gondola_v20.skp');
    expect(Object.keys(gondola.attributes).sort()).toEqual([
      'GSU_ContributorsInfo',
      'GeoReference',
      'temp',
    ]);
    expect(gondola.attributes.GeoReference.Latitude).toBeCloseTo(40.018309, 6);
    expect(gondola.attributes.GeoReference.Longitude).toBeCloseTo(-105.242139, 6);
    expect(gondola.attributes.GeoReference.LocationSource).toBe('Manual');
    expect(gondola.attributes.temp).toEqual({ temp: 0 });
  });

  it('reports no attributes for files whose model container is null', () => {
    // The blank scaffold and the single-material fixture both carry the
    // 2-byte null pointer instead of a container. Reading the first
    // CAttributeContainer in the stream would report something here
    // (those files' own ModelProperties-style dictionaries live in a
    // different, earlier container) - reporting {} is the proof this
    // anchors on the model's own.
    expect(loadFixture('blank_v17.skp').attributes).toEqual({});
    expect(loadFixture('single_material_v17.skp').attributes).toEqual({});

    const builder = create();
    builder.addFace(SQUARE);
    expect(parseSkp(toBuffer(builder.toBytes())).attributes).toEqual({});
  });

  it('a single dictionary shifts the slot base without breaking a thumbnail-carrying definition', () => {
    const withDict = create();
    withDict.addModelAttributeDict('GeoReference', GEO_REFERENCE);
    const defA = withDict.addComponentDefinition('Chair', (def) => def.addFace(SQUARE));
    withDict.addInstance(defA, { translation: [200, 0, 0] });
    const model = parseSkp(toBuffer(withDict.toBytes()));
    expect(model.definitions.size).toBe(1);
    expect(model.root.instances.length).toBe(1);
    expect(model.attributes.GeoReference.Latitude).toBeCloseTo(43.2965, 9);
  });

  it('adding no dictionary leaves the output byte-identical', () => {
    // The ground-truth byte size create.test.ts pins (6149, cross-checked
    // against Python's own writer) must still hold: touching the new API
    // is what costs bytes, having it available is not.
    const plain = create();
    plain.addFace(SQUARE);
    const plainBytes = plain.toBytes();
    expect(plainBytes.length).toBe(6149);

    const untouched = create();
    untouched.addFace(SQUARE);
    expect(Array.from(untouched.toBytes())).toEqual(Array.from(plainBytes));

    const withDict = create();
    withDict.addModelAttributeDict('GeoReference', GEO_REFERENCE);
    withDict.addFace(SQUARE);
    expect(withDict.toBytes().length).toBeGreaterThan(plainBytes.length);
  });

  it('a boolean value writes SketchUp\'s 1-byte bool type and reads back as 1', () => {
    const builder = create();
    builder.addModelAttributeDict('Flags', { on: true, off: false });
    builder.addFace(SQUARE);
    const bytes = builder.toBytes();
    // 0x07 is the bool type tag; the two values follow their keys as a
    // single byte each. Asserted on the parsed result rather than by
    // hunting the byte pattern, plus one direct byte check that the tag
    // really is 0x07 (a 0/1 written as an int32 would read back the same
    // way but cost 4 extra bytes and a different tag).
    const model = parseSkp(toBuffer(bytes));
    expect(model.attributes.Flags).toEqual({ on: 1, off: 0 });

    // "on" as UTF-16LE, followed by the type tag.
    const needle = [0x6f, 0x00, 0x6e, 0x00, 0x07, 0x01];
    let found = false;
    for (let i = 0; i + needle.length <= bytes.length && !found; i++) {
      found = needle.every((b, j) => bytes[i + j] === b);
    }
    expect(found).toBe(true);
  });

  it('rejects a dictionary added after a layer, material, definition or face', () => {
    const afterLayer = create();
    afterLayer.addLayer('Roof');
    expect(() => afterLayer.addModelAttributeDict('GeoReference', GEO_REFERENCE)).toThrow(
      /must be called before/
    );

    const afterMaterial = create();
    afterMaterial.addMaterial('Red', [255, 0, 0]);
    expect(() => afterMaterial.addModelAttributeDict('GeoReference', GEO_REFERENCE)).toThrow(
      /must be called before/
    );

    const afterDefinition = create();
    afterDefinition.addComponentDefinition('Chair', (def) => def.addFace(SQUARE));
    expect(() => afterDefinition.addModelAttributeDict('GeoReference', GEO_REFERENCE)).toThrow(
      /must be called before/
    );

    const afterFace = create();
    afterFace.addFace(SQUARE);
    expect(() => afterFace.addModelAttributeDict('GeoReference', GEO_REFERENCE)).toThrow(
      /must be called before/
    );
  });

  it('rejects a duplicate dictionary name', () => {
    const builder = create();
    builder.addModelAttributeDict('GeoReference', GEO_REFERENCE);
    expect(() => builder.addModelAttributeDict('GeoReference', { Latitude: 0 })).toThrow(
      /already added/
    );
  });

  it('validates entries at call time, not at toBytes time', () => {
    const builder = create();
    expect(() =>
      builder.addModelAttributeDict('Bad', { value: {} as unknown as number })
    ).toThrow(/unsupported value type/);
    // The rejected dictionary must not have been recorded - otherwise it
    // would have shifted the slot base for a write that never happened.
    builder.addFace(SQUARE);
    expect(builder.toBytes().length).toBe(6149);
  });
});
