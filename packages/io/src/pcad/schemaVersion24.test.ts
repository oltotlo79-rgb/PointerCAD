import { writePcadFile } from './pcadFile.js';
import { PcadWriteError } from './writeDiagnostic.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendFeature, createEmptyPartDocument, replaceSketch, type PartDocument, type SketchElementRef,
  type SketchFeature, type SolidFeature } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';

/**
 * 保存形式の版 24(次の版の欄を使った文書だけが名乗る。M-02 の辺からの距離の穴が最初)の守りと、今の版 22・23 の文書の互換。
 * 互換: 採用の前の実装で同じ入力・同じ保存時刻から書いた文書の UTF-8 バイトの SHA-256 を下に固定し、採用の後も 1 バイトも変わらない事、
 * 開いて保存し直しても変わらない事を確かめる(値は採用の前の作業ツリーの実装で求めた)。
 */
const savedAt = '2026-09-03T01:23:45.678Z';
const expression = (source: string, value: number) => ({ source, value, display: source });
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const topFace = { bodyFeatureId: 'box-1', index: 5,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 2400, position: [30, 20, 10], axis: [0, 0, 1], radius: null } } satisfies
  Extract<SolidFeature, { readonly kind: 'hole' }>['face'];
const edge = (index: number, axis: [number, number, number]) => ({ bodyFeatureId: 'box-1', index,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 40, position: [60, 20, 10], axis, radius: null } }) satisfies
  Extract<SolidFeature, { readonly kind: 'hole' }>['face'];
const hole = (planar: Extract<SolidFeature, { readonly kind: 'hole' }>['planar']): SolidFeature => ({
  id: 'hole-1', name: '穴 1', suppressed: false, kind: 'hole', targetFeatureId: 'box-1', face: topFace, centers: [],
  diameter: expression('6', 6), depth: { kind: 'through' }, tiltAngle: expression('0', 0), tiltAzimuth: expression('0', 0),
  ...(planar === undefined ? {} : { planar }) });
const edgeDistance = hole({ kind: 'edge-distance', edge1: edge(3, [0, 1, 0]), edge2: edge(4, [1, 0, 0]),
  locations: [{ distance1: expression('8', 8), distance2: expression('8', 8) }] });
const planeFace = hole({ kind: 'plane-face', locations: [{ x: expression('6', 6), y: expression('-4', -4) }] });
const withSolid = (document: PartDocument, feature: SolidFeature): PartDocument => ({ ...document, solids: [...document.solids, feature] });

/** 穴つきの面(版 23 の欄)の文書。sketchFaceHoles.test.ts と同じ形。 */
function faceDocument(inner?: readonly (readonly SketchElementRef[])[]): PartDocument {
  const part = createEmptyPartDocument();
  const rectangle: SketchFeature = { id: 'outer', name: 'outer', kind: 'rectangle', planeId: 'xy',
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(60, 40, 0), construction: false };
  const circle: SketchFeature = { id: 'inner', name: 'inner', kind: 'arc', planeId: 'xy',
    center: absoluteCoordinate(30, 20, 0), radius: { source: '5', value: 5, display: '5' },
    startAngle: { source: '0', value: 0, display: '0' },
    endAngle: { source: '360', value: 360, display: '360' }, construction: false };
  const face = { id: 'face-1', name: 'face', kind: 'face' as const, planeId: 'xy',
    boundary: [{ featureId: rectangle.id }], color: '#eeeeee', ...(inner === undefined ? {} : { holes: inner }) };
  return replaceSketch(part, [rectangle, circle, face].reduce((sketch, feature) => appendFeature(sketch, feature), part.sketches[0]));
}

describe('保存形式の版 24 の守り(M-02)', () => {
  it.each([17, 21, 22, 23])('旧版%dの書出しで辺からの距離の穴に必要な版24を返す', schemaVersion => {
    const document = { ...withSolid(createEmptyPartDocument(), edgeDistance), name: '試験部品', schemaVersion };
    expect.assertions(3);
    try { writePcadFile(document, { savedAt }); } catch (error) {
      expect(error).toBeInstanceOf(PcadWriteError);
      expect(error).toBeInstanceOf(RangeError);
      expect(error).toMatchObject({ diagnostic: { code: 'requiresVersion', field: 'edgeDistanceHole',
        requiredVersion: 24, actualVersion: schemaVersion, documentName: '試験部品' },
      message: schemaVersion < 22 ? '面内X・Yの穴を保存するには保存形式の版22が必要です。'
        : '辺からの距離の穴を保存するには保存形式の版24が必要です。' });
    }
  });
  it('版 24 の文書は辺からの距離の穴を往復し、開いて保存し直しても 1 バイトも変わらない', () => {
    const encoded = serializeDocument({ ...withSolid(createEmptyPartDocument(), edgeDistance), schemaVersion: 24 }, { savedAt });
    expect(encoded).toContain('"schema": 24');
    expect(encoded).toContain('"edge-distance"');
    const reopened = parseDocument(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.schemaVersion).toBe(24);
    expect(reopened.document.solids).toEqual([edgeDistance]);
    expect(serializeDocument(reopened.document, { savedAt })).toBe(encoded);
  });

  it('版 24 未満を名乗る文書に辺からの距離の穴があれば、書くのも読むのも断る', () => {
    for (const schemaVersion of [22, 23]) {
      const document = { ...withSolid(createEmptyPartDocument(), edgeDistance), schemaVersion };
      expect(() => serializeDocument(document, { savedAt })).toThrow('辺からの距離の穴を保存するには保存形式の版24が必要です。');
    }
    const encoded = serializeDocument({ ...withSolid(createEmptyPartDocument(), edgeDistance), schemaVersion: 24 }, { savedAt });
    for (const schema of [22, 23]) {
      const forged = encoded.replace('"schema": 24', `"schema": ${String(schema)}`).replace('"schemaVersion": 24', `"schemaVersion": ${String(schema)}`);
      const result = parseDocument(forged);
      expect(result).toMatchObject({ ok: false, error: { code: 'notPcad' } });
      if (result.ok) throw new Error('辺からの距離の穴が黙って捨てられました');
      expect(result.error.message).toBe('辺からの距離の穴を読むには保存形式の版24が必要です。');
    }
  });

  it('封筒と本文の版の食い違いと、版 25 以上は断る', () => {
    const encoded = serializeDocument({ ...withSolid(createEmptyPartDocument(), edgeDistance), schemaVersion: 24 }, { savedAt });
    expect(parseDocument(encoded.replace('"schemaVersion": 24', '"schemaVersion": 23'))).toMatchObject({ ok: false, error: { code: 'versionMismatch' } });
    expect(parseDocument(encoded.replace('"schema": 24', '"schema": 25').replace('"schemaVersion": 24', '"schemaVersion": 25')))
      .toMatchObject({ ok: false, error: { code: 'unsupportedNewVersion' } });
  });
});

describe('今の版 22・23 の文書は、採用の前と同じバイトで書き、開いて保存し直しても変わらない(M-02)', () => {
  const cases: readonly { readonly name: string; readonly document: PartDocument; readonly version: number; readonly sha256: string }[] = [
    { name: '空の部品(版 22)', document: createEmptyPartDocument(), version: 22, sha256: '6b1bb63b5dd94949e0ac25d4f53de4d037ef527f7ab988502a5fa8a57c6664c1' },
    { name: '面内 X・Y の穴(版 22)', document: withSolid(createEmptyPartDocument(), planeFace), version: 22, sha256: '3a9d14faaee28481190052101efb701b5a39166795a164b245d4620ad7a3fe90' },
    { name: '穴の無いスケッチ面(版 22)', document: faceDocument(), version: 22, sha256: 'e8a6cc66a870d1b0feb7404cf03cee35f5b53f6638b51307dc2d5852a9097eaa' },
    { name: '穴つきの面(版 23)', document: { ...faceDocument([[{ featureId: 'inner' }]]), schemaVersion: 23 }, version: 23, sha256: 'd330bfda755e0ff748be326e26309baa109a4b2cfdb5eedbd4e15bf431824729' },
    { name: '面内 X・Y の穴の版 23', document: { ...withSolid(createEmptyPartDocument(), planeFace), schemaVersion: 23 }, version: 23, sha256: 'aaa29c72f78810c84674f6bad7e9296a3a7ee24bf4d4ee1b9d8221c82c5b630b' },
  ];
  it.each(cases)('$name', ({ document, version, sha256: expected }) => {
    const encoded = serializeDocument(document, { savedAt });
    expect(sha256(encoded)).toBe(expected);
    const reopened = parseDocument(encoded);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.schemaVersion).toBe(version);
    expect(serializeDocument(reopened.document, { savedAt })).toBe(encoded);
  });
});
