import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { create, Point3, SkpWriteError } from '../src/create';
import { parseSkp } from '../src/index';
import {
  SCAFFOLD_LENGTH,
  SHADOW_INFO_CITY_POS,
  SHADOW_INFO_CITY_DEFAULT,
  SHADOW_INFO_COUNTRY_DEFAULT,
  SHADOW_INFO_LONGITUDE_DEFAULT,
  SHADOW_INFO_LATITUDE_DEFAULT,
  SHADOW_INFO_TZ_OFFSET_HOURS_DEFAULT,
} from '../src/scaffold';
import { makeTestPng } from './helpers/test-png';

/**
 * Tests for the model's `ShadowInfo` location - `setShadowInfoLocation`
 * on the write side, `SkpModel.shadowInfo` on the read side.
 *
 * **Why there are two locations at all.** A geolocated `.skp` carries the
 * same place twice, in two unrelated records: the `GeoReference`
 * attribute dictionary (see `model-attributes.test.ts`) is what makes
 * SketchUp call a file "accurately geo-located", and this one is what
 * Model Info > Geo-location displays and what the sun and shadow engine
 * casts from. Writing one without the other is a real, silent failure
 * mode, and the two real fixtures here are ground truth that it happens
 * in SketchUp's own files too: both were re-geolocated to Boulder with
 * Set Manual Location, and both still carry the city they were authored
 * in - Barcelona and Brasilia - in `ShadowInfo`.
 *
 * **The risk this feature adds.** Unlike the attribute container, the
 * record lives in the document tail, ahead of `TAIL_REF_POSITIONS` and
 * the ISO camera patches. A city or country of a different length than
 * the scaffold's own "Boulder (CO)"/"USA" RESIZES the tail at its very
 * start, moving every one of those later positions. The suffix test
 * below is what pins that: it rebuilds one file with a longer name and
 * one with a shorter one and requires the bytes after the record to come
 * out identical, which they only do if every later action was applied at
 * its moved offset.
 */

const FIXTURES = path.join(__dirname, 'fixtures');

const SQUARE: Point3[] = [
  [0.0, 0.0, 0.0],
  [100.0, 0.0, 0.0],
  [100.0, 100.0, 0.0],
  [0.0, 100.0, 0.0],
];

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

/** Encoded size of one `ff fe ff <len>` UTF-16LE string record. */
function strRecordLen(s: string): number {
  return 4 + s.length * 2;
}

/** Bytes the scaffold's own ShadowInfo city/country/lon/lat/tz occupy -
 * what `setShadowInfoLocation` replaces. */
const DEFAULT_RECORD_LEN =
  strRecordLen(SHADOW_INFO_CITY_DEFAULT) + strRecordLen(SHADOW_INFO_COUNTRY_DEFAULT) + 24;

/** Bytes of document tail that follow the record - fixed, whatever the
 * file: everything spliced in by the writer goes in ahead of the tail,
 * and the record is the first thing in it. Both `TAIL_REF_POSITIONS` and
 * both ISO camera tail patches live in here. */
const BYTES_AFTER_RECORD = SCAFFOLD_LENGTH - SHADOW_INFO_CITY_POS - DEFAULT_RECORD_LEN;

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function loadFixture(name: string) {
  const buf = fs.readFileSync(path.join(FIXTURES, name));
  return parseSkp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
}

/** A file with no randomness in it (no definition or instance, so no
 * GUIDs): two builds of the same arguments are byte-identical, which is
 * what the splice tests compare. */
function buildDeterministic(location?: {
  city?: string;
  country?: string;
  longitude: number;
  latitude: number;
  tzOffsetHours?: number;
}): Uint8Array {
  const builder = create();
  builder.addModelAttributeDict('GeoReference', GEO_REFERENCE);
  const red = builder.addMaterial('Red', [255, 0, 0]);
  const roof = builder.addLayer('Roof');
  if (location) builder.setShadowInfoLocation(location);
  builder.addFace(SQUARE, { material: red, layer: roof });
  return builder.toBytes();
}

describe('ShadowInfo location', () => {
  // Longer than the scaffold's own strings, shorter than them, and empty
  // - the three ways the tail can be resized, including not at all.
  const CASES = [
    { label: 'longer than the defaults', city: 'Saint-Remy-de-Provence', country: 'Confederatio Helvetica' },
    { label: 'shorter than the defaults', city: 'Nice', country: 'FR' },
    { label: 'empty (the default)', city: undefined, country: undefined },
    // Not a length case: pins that the record really is UTF-16LE and not
    // Latin-1, the way every other name in the format is written.
    { label: 'non-ASCII', city: 'Zürich', country: 'Schweiz' },
  ];

  for (const c of CASES) {
    it(`round-trips with a city and country ${c.label}, alongside everything else a file holds`, () => {
      const builder = create();
      builder.addModelAttributeDict('GeoReference', GEO_REFERENCE);
      const brick = builder.addTextureMaterial('Brick', makeTestPng(), 'brick.png');
      const roof = builder.addLayer('Roof');
      const walls = builder.addLayer('Walls');
      const chair = builder.addComponentDefinition('Chair', (def) => {
        def.addFace(SQUARE);
      });
      builder.addInstance(chair, { translation: [200, 0, 0] });
      builder.addInstance(chair, { translation: [400, 0, 0], layer: walls });
      builder.addFace(SQUARE, { material: brick, layer: roof });
      builder.addFace([[0, 0, 50], [100, 0, 50], [100, 100, 50], [0, 100, 50]], { layer: walls });
      builder.setShadowInfoLocation({
        city: c.city,
        country: c.country,
        longitude: 5.3698,
        latitude: 43.2965,
        tzOffsetHours: 1,
      });

      const model = parseSkp(toBuffer(builder.toBytes()));

      expect(model.shadowInfo).not.toBeNull();
      expect(model.shadowInfo!.city).toBe(c.city ?? '');
      expect(model.shadowInfo!.country).toBe(c.country ?? '');
      expect(model.shadowInfo!.longitude).toBeCloseTo(5.3698, 9);
      expect(model.shadowInfo!.latitude).toBeCloseTo(43.2965, 9);
      expect(model.shadowInfo!.tzOffsetHours).toBe(1);

      // The OTHER location, unaffected - a geolocated file needs both.
      expect(model.attributes.GeoReference.Latitude).toBeCloseTo(43.2965, 9);
      expect(model.attributes.GeoReference.Longitude).toBeCloseTo(5.3698, 9);

      // ...and nothing the record's resize moved has come loose.
      expect(model.layers.map((l) => l.name).sort()).toEqual(['Layer0', 'Roof', 'Walls']);
      expect(model.materials.find((m) => m.name === 'Brick')!.texture).not.toBeNull();
      expect(model.definitions.size).toBe(1);
      expect(model.root.instances.length).toBe(2);
      expect(model.root.faces.length).toBe(2);
      expect(model.root.edges.length).toBe(8);
    });
  }

  it('leaves the file byte-identical when it is never called', () => {
    // Writing SketchUp's own defaults back is a no-op splice: same
    // lengths, same bytes. That it comes out byte-identical to a file
    // that never called the method is what says the guard matched the
    // right 62 bytes and the replacement wrote exactly over them.
    const untouched = buildDeterministic();
    const rewritten = buildDeterministic({
      city: SHADOW_INFO_CITY_DEFAULT,
      country: SHADOW_INFO_COUNTRY_DEFAULT,
      longitude: SHADOW_INFO_LONGITUDE_DEFAULT,
      latitude: SHADOW_INFO_LATITUDE_DEFAULT,
      tzOffsetHours: SHADOW_INFO_TZ_OFFSET_HOURS_DEFAULT,
    });
    expect(Array.from(rewritten)).toEqual(Array.from(untouched));

    // And an untouched file still reads back as SketchUp's default
    // location, which is the whole reason this method exists.
    expect(parseSkp(toBuffer(untouched)).shadowInfo).toEqual({
      city: SHADOW_INFO_CITY_DEFAULT,
      country: SHADOW_INFO_COUNTRY_DEFAULT,
      longitude: SHADOW_INFO_LONGITUDE_DEFAULT,
      latitude: SHADOW_INFO_LATITUDE_DEFAULT,
      tzOffsetHours: SHADOW_INFO_TZ_OFFSET_HOURS_DEFAULT,
    });
  });

  it('moves every later tail action by exactly the resize', () => {
    const longer = buildDeterministic({
      city: 'Saint-Remy-de-Provence',
      country: 'Confederatio Helvetica',
      longitude: 5.3698,
      latitude: 43.2965,
      tzOffsetHours: 1,
    });
    const shorter = buildDeterministic({
      city: '',
      country: '',
      longitude: 5.3698,
      latitude: 43.2965,
      tzOffsetHours: 1,
    });

    const longerLen = strRecordLen('Saint-Remy-de-Provence') + strRecordLen('Confederatio Helvetica') + 24;
    const shorterLen = strRecordLen('') + strRecordLen('') + 24;
    expect(longer.length - shorter.length).toBe(longerLen - shorterLen);

    // Everything ahead of the record is untouched by it...
    const head = shorter.length - BYTES_AFTER_RECORD - shorterLen;
    expect(Array.from(longer.subarray(0, head))).toEqual(Array.from(shorter.subarray(0, head)));
    // ...and everything after it comes out identical, at its own moved
    // offset. Both ISO camera tail patches and all six TAIL_REF_POSITIONS
    // land in this span: applied at their unmoved offsets they would be
    // written 2 * (name length difference) bytes away from where they
    // belong, and these would differ.
    expect(Array.from(longer.subarray(longer.length - BYTES_AFTER_RECORD))).toEqual(
      Array.from(shorter.subarray(shorter.length - BYTES_AFTER_RECORD))
    );
  });

  it('can be called at any point, and the last call wins', () => {
    const builder = create();
    builder.setShadowInfoLocation({ city: 'Wrong', longitude: 0, latitude: 0 });
    builder.addMaterial('Red', [255, 0, 0]);
    builder.addFace(SQUARE);
    // After geometry: the record costs no archive slot, so unlike
    // addModelAttributeDict there is no ordering rule to break.
    builder.setShadowInfoLocation({
      city: 'Marseille',
      country: 'France',
      longitude: 5.3698,
      latitude: 43.2965,
      tzOffsetHours: 1,
    });
    const model = parseSkp(toBuffer(builder.toBytes()));
    expect(model.shadowInfo).toEqual({
      city: 'Marseille',
      country: 'France',
      longitude: 5.3698,
      latitude: 43.2965,
      tzOffsetHours: 1,
    });
  });

  it('defaults the strings to empty and the timezone to UTC', () => {
    const model = parseSkp(toBuffer(buildDeterministic({ longitude: -3.7038, latitude: 40.4168 })));
    expect(model.shadowInfo).toEqual({
      city: '',
      country: '',
      longitude: -3.7038,
      latitude: 40.4168,
      tzOffsetHours: 0,
    });
  });

  it('rejects out-of-range and non-finite coordinates', () => {
    const b = create();
    expect(() => b.setShadowInfoLocation({ longitude: 180.5, latitude: 0 })).toThrow(SkpWriteError);
    expect(() => b.setShadowInfoLocation({ longitude: -181, latitude: 0 })).toThrow(/longitude/);
    expect(() => b.setShadowInfoLocation({ longitude: 0, latitude: 90.5 })).toThrow(/latitude/);
    expect(() => b.setShadowInfoLocation({ longitude: 0, latitude: -91 })).toThrow(/latitude/);
    expect(() => b.setShadowInfoLocation({ longitude: 0, latitude: 0, tzOffsetHours: 15 })).toThrow(
      /tzOffsetHours/
    );
    expect(() => b.setShadowInfoLocation({ longitude: NaN, latitude: 0 })).toThrow(/finite/);
    expect(() => b.setShadowInfoLocation({ longitude: 0, latitude: Infinity })).toThrow(/finite/);
    // The bounds themselves are inclusive and legal.
    expect(() => b.setShadowInfoLocation({ longitude: 180, latitude: -90, tzOffsetHours: 14 })).not.toThrow();
  });

  it('rejects a city or country past the one-byte length limit', () => {
    const b = create();
    expect(() => b.setShadowInfoLocation({ city: 'x'.repeat(254), longitude: 0, latitude: 0 })).not.toThrow();
    expect(() => b.setShadowInfoLocation({ city: 'x'.repeat(255), longitude: 0, latitude: 0 })).toThrow(
      /city is too long/
    );
    expect(() =>
      b.setShadowInfoLocation({ country: 'y'.repeat(255), longitude: 0, latitude: 0 })
    ).toThrow(/country is too long/);
  });

  it('reads the record out of real SketchUp-written files', () => {
    // Ground truth for the reader's structural anchor: the record sits
    // directly after the root entity list, wherever that lands. These two
    // files put it at 215278 and 702624 - two versions, two very
    // different sizes - and the blank scaffold at 3515.
    //
    // Note what they say. Both files' GeoReference dictionaries were
    // re-pointed at Boulder (40.018309, -105.242139) with Set Manual
    // Location - see model-attributes.test.ts - and their ShadowInfo
    // still names the city each model was authored in. That divergence is
    // not a defect in these fixtures, it IS the thing this feature
    // exists to prevent: SketchUp's geolocation dialog and its shadows
    // read the record below, not the dictionary.
    const capilla = loadFixture('capilla_quiroz_v17.skp');
    expect(capilla.shadowInfo).not.toBeNull();
    expect(capilla.shadowInfo!.city).toBe('Barcelona');
    expect(capilla.shadowInfo!.country).toBe('España');
    expect(capilla.shadowInfo!.longitude).toBeCloseTo(2.183, 6);
    expect(capilla.shadowInfo!.latitude).toBeCloseTo(41.383, 6);
    expect(capilla.shadowInfo!.tzOffsetHours).toBe(1);
    expect(capilla.attributes.GeoReference.Latitude).toBeCloseTo(40.018309, 6);

    const gondola = loadFixture('gondola_v20.skp');
    expect(gondola.shadowInfo).not.toBeNull();
    expect(gondola.shadowInfo!.city).toBe('Brasilia');
    expect(gondola.shadowInfo!.country).toBe('Brasil');
    expect(gondola.shadowInfo!.longitude).toBeCloseTo(-47.917, 6);
    expect(gondola.shadowInfo!.latitude).toBeCloseTo(-15.783, 6);
    expect(gondola.shadowInfo!.tzOffsetHours).toBe(-3);
    expect(gondola.attributes.GeoReference.Latitude).toBeCloseTo(40.018309, 6);
  });

  it('reads SketchUp\'s own default out of the blank scaffold', () => {
    expect(loadFixture('blank_v17.skp').shadowInfo).toEqual({
      city: SHADOW_INFO_CITY_DEFAULT,
      country: SHADOW_INFO_COUNTRY_DEFAULT,
      longitude: SHADOW_INFO_LONGITUDE_DEFAULT,
      latitude: SHADOW_INFO_LATITUDE_DEFAULT,
      tzOffsetHours: SHADOW_INFO_TZ_OFFSET_HOURS_DEFAULT,
    });
    expect(loadFixture('single_material_v17.skp').shadowInfo).toEqual(
      loadFixture('blank_v17.skp').shadowInfo
    );
  });

  it('reports null for VFF files, which are not decoded for it', () => {
    expect(loadFixture('Untitled.skp').shadowInfo).toBeNull();
  });
});
