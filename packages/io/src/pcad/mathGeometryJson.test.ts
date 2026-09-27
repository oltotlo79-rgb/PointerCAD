import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, type MathGeometryDefinition, type MathGeometryQuantity,
  type MathGeometryCurve, type MathGeometryFace, type MathGeometryFrame, type MathGeometryPoint } from '@pointercad/model';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readMathGeometry, serializeMathGeometry } from './codecs/mathGeometry.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';
import { isRecord } from './guards.js';

const document = createEmptyPartDocument();
const point: MathGeometryPoint = { kind: 'sketch-point', sketchId: document.sketches[0].id, reference: { kind: 'point', pointId: 'p1' } };
const vertex: MathGeometryPoint = { kind: 'vertex', reference: { bodyFeatureId: 'box', index: 0,
  fingerprint: { kind: 'vertex', position: [1, 2, 3] } } };
const curve: MathGeometryCurve = { kind: 'sketch-curve', sketchId: document.sketches[0].id, featureId: 'line' };
const edge: MathGeometryCurve = { kind: 'edge', reference: { bodyFeatureId: 'box', index: 1,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 5, position: [0, 0, 0], axis: [1, 0, 0], radius: null } } };
const face: MathGeometryFace = { kind: 'face', reference: { bodyFeatureId: 'box', index: 2,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 20, position: [1, 2, 3], axis: [0, 0, 1], radius: null } } };
const body = { kind: 'body' as const, featureId: 'box' };
const quantities: readonly MathGeometryQuantity[] = [
  { kind: 'coordinate', point, component: 'X' }, { kind: 'coordinate', point: vertex, component: 'Z' },
  { kind: 'point-distance', first: point, second: vertex }, { kind: 'shape-distance', first: body, second: face },
  { kind: 'length', curve }, { kind: 'length', curve: edge }, { kind: 'area', shape: body }, { kind: 'area', shape: face },
  { kind: 'volume', body }, { kind: 'angle', first: curve, second: edge, unit: 'degree' },
  { kind: 'angle', first: curve, second: edge, unit: 'radian' }, { kind: 'parallel', first: curve, second: edge },
  { kind: 'perpendicular', first: curve, second: edge },
];
const definitions: readonly MathGeometryDefinition[] = quantities.map((quantity, index) => ({
  id: `measurement:${String(index)}`, name: `測定${String(index)}`, documentId: document.id, quantity,
  tolerance: { linearMm: 1e-6, angularRadians: 1e-8 },
}));

const angleQuantities: readonly MathGeometryQuantity[] = [
  ...(['degree', 'radian'] as const).flatMap((unit): readonly MathGeometryQuantity[] => [
    { kind: 'plane-angle', first: face, second: face, unit },
    { kind: 'line-plane-angle', line: edge, plane: face, unit },
    { kind: 'point-angle', first: point, second: vertex, third: point, unit },
  ]),
  ...(['parallel', 'perpendicular'] as const).flatMap((kind): readonly MathGeometryQuantity[] => [
    { kind, first: face, second: face }, { kind, first: curve, second: face }, { kind, first: face, second: edge },
  ]),
];
const angleDefinitions: readonly MathGeometryDefinition[] = angleQuantities.map((quantity, index) => ({
  id: `angle:${String(index)}`, name: `角度${String(index)}`, documentId: document.id, quantity,
  tolerance: { linearMm: 0.025, angularRadians: Math.PI / 180 },
}));

describe('GR-09 角度と平面の判定の保存', () => {
  it.each(angleDefinitions)('新しい量と単位を実pcadファイルで往復する $id', definition => {
    const source = { ...document, mathGeometry: [definition] };
    const reopened = readPcadFile(writePcadFile(source));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document).toEqual(source);
    expect(reopened.document.schemaVersion).toBe(17);
    expect(reopened.document.mathGeometry?.[0]).not.toBe(definition);
  });
  it('既定と違う長さ・角度の比べる幅を全新種で保持し、測定値やキャッシュは保存しない', () => {
    const inputs = angleDefinitions.map(definition => ({ ...definition, value: 90, status: 'value', generation: 23,
      quantity: { ...definition.quantity, bodyKey: 'old-cache', placement: [10, 20, 30] } }));
    const saved = serializeMathGeometry(inputs, document.id);
    expect(saved).toEqual(angleDefinitions);
    const reopened = readPcadFile(writePcadFile({ ...document, mathGeometry: inputs }));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document.mathGeometry).toEqual(angleDefinitions);
    for (const definition of reopened.document.mathGeometry ?? []) {
      expect(definition.tolerance).toEqual({ linearMm: 0.025, angularRadians: Math.PI / 180 });
      expect(definition).not.toHaveProperty('value');
      expect(definition).not.toHaveProperty('generation');
      expect(definition.quantity).not.toHaveProperty('bodyKey');
    }
  });
  it.each([
    { kind: 'plane-angle', first: edge, second: face, unit: 'degree' },
    { kind: 'plane-angle', first: face, second: body, unit: 'degree' },
    { kind: 'plane-angle', first: face, second: face, unit: 'mm' },
    { kind: 'plane-angle', first: face, unit: 'degree' },
    { kind: 'plane-angle', first: face, second: face },
    { kind: 'line-plane-angle', line: face, plane: face, unit: 'degree' },
    { kind: 'line-plane-angle', line: edge, plane: edge, unit: 'degree' },
    { kind: 'line-plane-angle', line: point, plane: face, unit: 'degree' },
    { kind: 'line-plane-angle', line: edge, unit: 'degree' },
    { kind: 'line-plane-angle', plane: face, unit: 'degree' },
    { kind: 'line-plane-angle', line: edge, plane: face, unit: 'mm' },
    { kind: 'line-plane-angle', line: edge, plane: face },
    { kind: 'point-angle', first: curve, second: point, third: vertex, unit: 'degree' },
    { kind: 'point-angle', first: point, second: face, third: vertex, unit: 'degree' },
    { kind: 'point-angle', first: point, second: vertex, third: body, unit: 'degree' },
    { kind: 'point-angle', first: point, second: vertex, unit: 'degree' },
    { kind: 'point-angle', first: point, second: vertex, third: point, unit: 'mm' },
    { kind: 'point-angle', first: point, second: vertex, third: point },
    { kind: 'parallel', first: body, second: face },
    { kind: 'parallel', first: face, second: point },
    { kind: 'perpendicular', first: point, second: face },
    { kind: 'perpendicular', first: face, second: body },
    { kind: 'plane-angle', first: { ...face, reference: { ...face.reference, fingerprint: edge.kind === 'edge' ? edge.reference.fingerprint : null } }, second: face, unit: 'degree' },
  ].map(quantity => ({ quantity })))('対象の種類・必須欄・角度単位が壊れた入力を拒否する #%#', ({ quantity }) => {
    const input = [{ ...angleDefinitions[0], quantity }];
    expect(readMathGeometry(input, document.id, 'document.mathGeometry').ok).toBe(false);
    const encoded: unknown = JSON.parse(serializeDocument(document));
    if (!isRecord(encoded) || !isRecord(encoded.document)) throw new Error('Expected serialized part envelope');
    expect(parseDocument(JSON.stringify({ ...encoded, document: { ...encoded.document, mathGeometry: input } })).ok).toBe(false);
  });
});

describe('図形を参照する量は数値ではなく型と参照を保存する', () => {
  it('全ての量・点・辺・面・立体と角度単位を実pcadファイルで往復する', () => {
    const source = { ...document, mathGeometry: definitions };
    const bytes = writePcadFile(source);
    const reopened = readPcadFile(bytes);
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document).toEqual(source);
    expect(reopened.document.mathGeometry).not.toBe(definitions);
    expect(reopened.document.mathGeometry?.[1].quantity).toEqual(quantities[1]);
  });
  it('測定した値・状態・世代や任意の識別上書きを書き出さない', () => {
    const input = definitions.map(definition => ({ ...definition, value: 999, status: 'value', generation: 19,
      quantity: { ...definition.quantity, bodyKey: 'old-cache', placement: [99, 99, 99] } }));
    const saved = serializeMathGeometry(input, document.id);
    expect(saved).toEqual(definitions);
    expect(saved[0]).not.toBe(input[0]);
    expect(saved[0].tolerance).not.toBe(input[0].tolerance);
    expect(saved[1].quantity).not.toBe(input[1].quantity);
  });
  it('旧版は測定を勝手に追加せず移行し、新定義を旧版として書き出さない', () => {
    const old = parseDocument(serializeDocument({ ...document, schemaVersion: 16 }));
    if (!old.ok) throw new Error(JSON.stringify(old.error));
    expect(old.document).toEqual(document);
    expect(old.document.mathGeometry).toBeUndefined();
    expect(old.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(() => serializeDocument({ ...document, schemaVersion: 16, mathGeometry: definitions })).toThrow(/版17/u);
  });
  it('削除された参照は修正用に保持し、同じ名前の別の図形へ付け替えない', () => {
    const source = { ...document, solids: [], mathGeometry: definitions };
    const reopened = parseDocument(serializeDocument(source));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document.mathGeometry).toEqual(definitions);
    expect(reopened.document.solids).toEqual([]);
  });
  it.each([
    null,
    [definitions[0], definitions[0]],
    [{ ...definitions[0], id: '' }],
    [{ ...definitions[0], name: '\u0000' }],
    [{ ...definitions[0], documentId: 'foreign-document' }],
    [{ ...definitions[0], quantity: { kind: 'coordinate', point: body, component: 'X' } }],
    [{ ...definitions[0], quantity: { kind: 'coordinate', point, component: 'W' } }],
    [{ ...definitions[0], quantity: { kind: 'volume', body: face } }],
    [{ ...definitions[0], quantity: { kind: 'length', curve: point } }],
    [{ ...definitions[0], quantity: { kind: 'angle', first: curve, second: edge, unit: 'mm' } }],
    [{ ...definitions[0], quantity: { kind: 'unknown' } }],
    [{ ...definitions[0], tolerance: { linearMm: 0, angularRadians: 1e-8 } }],
    [{ ...definitions[0], tolerance: { linearMm: Number.NaN, angularRadians: 1e-8 } }],
    [{ ...definitions[0], tolerance: { linearMm: 1e-6, angularRadians: Math.PI / 4 } }],
    [{ ...definitions[0], quantity: { kind: 'coordinate', component: 'X', point: {
      kind: 'vertex', reference: { bodyFeatureId: 'box', index: 0.5, fingerprint: { kind: 'vertex', position: [1, 2, 3] } } } } }],
    [{ ...definitions[0], quantity: { kind: 'area', shape: { ...face, kind: 'edge' } } }],
    [{ ...definitions[0], quantity: { kind: 'coordinate', component: 'X', point: {
      kind: 'sketch-point', sketchId: 's1', reference: { kind: 'point', pointId: '' } } } }],
  ].map(value => ({ value })))('壊れた型・番号・単位・許容差を読み飛ばさず拒否する #%#', ({ value }) => {
    expect(readMathGeometry(value, document.id, 'document.mathGeometry').ok).toBe(false);
    const malformed = serializeDocument(document).replace('"schemaVersion": 17,',
      `"schemaVersion": 17, "mathGeometry": ${JSON.stringify(value)},`);
    expect(parseDocument(malformed).ok).toBe(false);
  });
});

const radiusQuantities: readonly MathGeometryQuantity[] = [
  { kind: 'radius', curve }, { kind: 'radius', curve: edge },
  ...(['degree', 'radian'] as const).flatMap((unit): readonly MathGeometryQuantity[] => [
    { kind: 'central-angle', curve, unit }, { kind: 'central-angle', curve: edge, unit },
  ]),
  { kind: 'contour-length', sketchId: document.sketches[0].id, featureId: 'rectangle' },
];

describe('GR-10 半径・中心角・輪郭長の保存', () => {
  it.each(radiusQuantities.map(quantity => ({ quantity })))('新種の実pcad往復 #%#', ({ quantity }) => {
    const definition = { ...definitions[0], quantity };
    const source = { ...document, mathGeometry: [definition] };
    const reopened = readPcadFile(writePcadFile(source));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document).toEqual(source);
    expect(reopened.document.schemaVersion).toBe(17);
    expect(reopened.document.mathGeometry?.[0]).not.toBe(definition);
  });
  it('派生値とキャッシュを全新種で保存しない', () => {
    const clean = radiusQuantities.map(quantity => ({ ...definitions[0], id: quantity.kind + JSON.stringify(quantity), quantity }));
    const dirty = clean.map(definition => ({ ...definition, value: 123, generation: 42,
      quantity: { ...definition.quantity, radius: 123, sweep: 123, length: 123, bodyKey: 'stale' } }));
    expect(serializeMathGeometry(dirty, document.id)).toEqual(clean);
  });
  it.each([
    { kind: 'radius' }, { kind: 'radius', curve: point }, { kind: 'radius', curve: face },
    { kind: 'central-angle', curve }, { kind: 'central-angle', unit: 'degree' },
    { kind: 'central-angle', curve, unit: 'mm' }, { kind: 'central-angle', curve: body, unit: 'degree' },
    { kind: 'contour-length', featureId: 'rectangle' }, { kind: 'contour-length', sketchId: 'sketch-1' },
    { kind: 'contour-length', sketchId: '', featureId: 'rectangle' },
    { kind: 'contour-length', sketchId: 'sketch-1', featureId: '' },
    { kind: 'contour-length', sketchId: 1, featureId: 'rectangle' },
    { kind: 'contour-length', sketchId: 'sketch-1', featureId: null },
    { kind: 'contour-length', sketchId: 'sketch-1', featureId: '\u0000' },
  ].map(quantity => ({ quantity })))('壊れた新種をcodecと文書読込みの両方で拒否 #%#', ({ quantity }) => {
    const input = [{ ...definitions[0], quantity }];
    expect(readMathGeometry(input, document.id, 'document.mathGeometry').ok).toBe(false);
    const encoded: unknown = JSON.parse(serializeDocument(document));
    if (!isRecord(encoded) || !isRecord(encoded.document)) throw new Error('Expected serialized part envelope');
    expect(parseDocument(JSON.stringify({ ...encoded, document: { ...encoded.document, mathGeometry: input } })).ok).toBe(false);
  });
});


describe('GR-10b 座標系付き座標の保存', () => {
  const frame: MathGeometryFrame = { kind: 'reference', featureId: 'coordinate-system-1' };
  const quantity: MathGeometryQuantity = { kind: 'coordinate', point, component: 'X', frame };
  const definition = { ...definitions[0], quantity };

  it.each(['X', 'Y', 'Z'] as const)('座標系付き%s成分を実pcadで往復し版17を保つ', component => {
    const source = { ...document, mathGeometry: [{ ...definition, quantity: { ...quantity, component } }] };
    const reopened = readPcadFile(writePcadFile(source));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document).toEqual(source);
    expect(reopened.document.schemaVersion).toBe(17);
    expect(reopened.document.mathGeometry?.[0].quantity).not.toBe(source.mathGeometry[0].quantity);
    // Missing frames remain repairable definitions; opening never rebinds by name.
    expect(reopened.document.references).toEqual([]);
  });

  it('座標系の導出原点・3軸・値・キャッシュを実pcadへ保存しない', () => {
    const dirty = { ...definition, value: 999, generation: 13, quantity: { ...quantity,
      position: [99, 99, 99], frame: { ...frame, origin: [1, 2, 3], xAxis: [0, 1, 0], yAxis: [0, 0, 1],
        zAxis: [1, 0, 0], value: 999, bodyKey: 'stale', name: '古い表示名' } } };
    expect(serializeMathGeometry([dirty], document.id)).toEqual([definition]);
    const reopened = readPcadFile(writePcadFile({ ...document, mathGeometry: [dirty] }));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document.mathGeometry).toEqual([definition]);
  });

  it('frameを省略した旧来の座標へ欄を勝手に補わない', () => {
    const original = { ...definitions[0], quantity: { kind: 'coordinate' as const, point, component: 'X' as const } };
    const saved = serializeMathGeometry([original], document.id);
    expect(saved).toEqual([original]);
    expect(saved[0].quantity).not.toHaveProperty('frame');
  });

  it.each([null, [], 'frame', 1, {}, { featureId: 'frame' }, { kind: 'reference' },
    { kind: 'body', featureId: 'frame' }, { kind: 'world', featureId: 'frame' },
    { kind: 'reference', featureId: '' }, { kind: 'reference', featureId: '  ' },
    { kind: 'reference', featureId: null }, { kind: 'reference', featureId: 1 },
    { kind: 'reference', featureId: 'a\u0000b' }, { kind: 'reference', featureId: 'a\nb' },
    { kind: 'reference', featureId: 'a\u007fb' },
  ].map(frame => ({ frame })))('壊れたframeをcodecと文書読込みで拒否する #%#', ({ frame }) => {
    const input = [{ ...definition, quantity: { ...quantity, frame } }];
    const checked = readMathGeometry(input, document.id, 'document.mathGeometry');
    expect(checked.ok).toBe(false);
    const encoded: unknown = JSON.parse(serializeDocument(document));
    if (!isRecord(encoded) || !isRecord(encoded.document)) throw new Error('Expected serialized part envelope');
    expect(parseDocument(JSON.stringify({ ...encoded, document: { ...encoded.document, mathGeometry: input } })).ok).toBe(false);
  });
});

describe('GR-11 合同・相似の定義の保存', () => {
  const polygon: MathGeometryCurve = { kind: 'sketch-curve', sketchId: document.sketches[0].id, featureId: 'rectangle' };
  const circular: MathGeometryCurve = { kind: 'edge', reference: { bodyFeatureId: 'cylinder', index: 0,
    fingerprint: { kind: 'edge', curveKind: 'circle', length: 20 * Math.PI, position: [0, 0, 0], axis: [0, 0, 1], radius: 10 } } };
  const quantities = (['congruent', 'similar'] as const).flatMap((kind): readonly MathGeometryQuantity[] => [
    { kind, first: curve, second: curve }, { kind, first: edge, second: curve },
    { kind, first: circular, second: circular }, { kind, first: polygon, second: { ...polygon, featureId: 'other-polygon' } },
  ]);
  it.each(quantities.map(quantity => ({ quantity })))('合同・相似を識別情報と個別の幅だけで実pcad往復する #%#', ({ quantity }) => {
    const definition: MathGeometryDefinition = { ...definitions[0], quantity, tolerance: { linearMm: 0.0025, angularRadians: 0.001 } };
    const source = { ...document, mathGeometry: [definition] };
    const reopened = readPcadFile(writePcadFile(source));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document).toEqual(source);
    expect(reopened.document.schemaVersion).toBe(17);
    expect(reopened.document.mathGeometry?.[0]).not.toBe(definition);
  });
  it('真偽・周長比・角と辺の並び・世代・キャッシュを保存しない', () => {
    const clean = quantities.map((quantity, index) => ({ ...definitions[0], id: `comparison-${String(index)}`, quantity }));
    const dirty = clean.map(definition => ({ ...definition, value: true, status: 'value', generation: 22,
      quantity: { ...definition.quantity, ratio: 2, lengths: [4, 2, 4, 2], turns: [Math.PI / 2], bodyKey: 'stale' } }));
    expect(serializeMathGeometry(dirty, document.id)).toEqual(clean);
    const reopened = readPcadFile(writePcadFile({ ...document, mathGeometry: dirty }));
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document.mathGeometry).toEqual(clean);
  });
  it.each((['congruent', 'similar'] as const).flatMap(kind => [
    { kind }, { kind, first: curve }, { kind, second: curve },
    { kind, first: point, second: curve }, { kind, first: curve, second: face },
    { kind, first: body, second: curve }, { kind, first: curve, second: { kind: 'sketch-curve', sketchId: '', featureId: 'polygon' } },
    { kind, first: { kind: 'sketch-curve', sketchId: document.sketches[0].id, featureId: '\u0000' }, second: curve },
    { kind, first: { kind: 'edge', reference: { ...face.reference, fingerprint: face.reference.fingerprint } }, second: edge },
    { kind, first: { kind: 'edge', reference: { ...circular.reference, index: -1 } }, second: curve },
  ]).map(quantity => ({ quantity })))('壊れた対象や必須欄をcodecと文書読込みで拒否 #%#', ({ quantity }) => {
    const input = [{ ...definitions[0], quantity }];
    expect(readMathGeometry(input, document.id, 'document.mathGeometry').ok).toBe(false);
    const encoded: unknown = JSON.parse(serializeDocument(document));
    if (!isRecord(encoded) || !isRecord(encoded.document)) throw new Error('Expected serialized part envelope');
    expect(parseDocument(JSON.stringify({ ...encoded, document: { ...encoded.document, mathGeometry: input } })).ok).toBe(false);
  });
  it.each([
    { linearMm: 0, angularRadians: 1e-6 }, { linearMm: 1e-6, angularRadians: 0 },
    { linearMm: 1e-6, angularRadians: Math.PI / 4 }, { linearMm: Number.NaN, angularRadians: 1e-6 },
  ])('合同・相似の不正な比べる幅を拒否する #%#', tolerance => {
    const input = quantities.map((quantity, index) => ({ ...definitions[0], id: `bad-${String(index)}`, quantity, tolerance }));
    expect(readMathGeometry(input, document.id, 'document.mathGeometry').ok).toBe(false);
    expect(() => serializeMathGeometry(input, document.id)).toThrow(RangeError);
  });
});
