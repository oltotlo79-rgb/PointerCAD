import { beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber, mathScalarExpression, type ExpressionValue } from '@pointercad/expression';
import {
  createMathBackend,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type KernelBridge } from '../kernelBridge.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import { evaluateDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import { recomputePart } from './recomputePart.js';
import type { PartDocument, PrimitiveFeature } from './types.js';

let backend: MathExecutionBackend, bridge: KernelBridge;
beforeAll(async () => {
  backend = createMathBackend();
  await loadOcctForNode();
  bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, 180_000);
function calculate(request: MathWorkRequest) {
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result;
}
function math(source: string, coefficients: MathWorkRequest['coefficients'] = []): ExpressionValue {
  const result = mathScalarExpression(calculate({ identity: { documentId: 'fixture', documentVersion: 1, editorId: 'fixture', inputRevision: 1 },
    source, notation: 'text', angleUnit: 'degree', coefficients }));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
function context(document: PartDocument): DocumentMathContext {
  return { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) }) } };
}
function box(id: string, size: ExpressionValue, x = 0): PrimitiveFeature {
  return { kind: 'primitive', id, name: id, suppressed: false, axis: { kind: 'world', axis: 'z' },
    origin: { kind: 'coordinate', value: absoluteCoordinate(x, 0, 0) }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
}
function fixture(): PartDocument {
  const invalid = math('1/coef("A")', [{ id: 'A', label: 'A', decimal: '2' }]);
  return { ...createEmptyPartDocument(), parameters: [{ name: 'A', mathId: 'A', unit: 'none', description: '', value: expressionValueFromNumber(0) }],
    solids: [box('good', math('2^3')), box('bad', invalid, 20)] };
}

describe('数学入力の失敗部分を隔離して独立した実形状を残す（FR-504）', () => {
  it('失敗した寸法とBooleanは旧キャッシュを使わず、独立した箱の体積512を維持する', async () => {
    const document: PartDocument = { ...fixture(), solids: [...fixture().solids,
      { id: 'combined', name: 'combined', kind: 'boolean', suppressed: false, operation: 'union', targetFeatureId: 'good', toolFeatureId: 'bad' }] };
    const before = JSON.stringify(document);
    const result = await recomputePart(document, bridge, { math: context(document) });
    expect(result.bodies.map(body => body.featureId)).toEqual(['good']);
    expect(result.bodies[0].volume).toBeCloseTo(512, 8);
    expect(result.errors.map(error => error.featureId)).toEqual(expect.arrayContaining(['bad', 'combined']));
    expect(JSON.stringify(document)).toBe(before);
    const edit = await evaluateDocumentMath(document, context(document));
    expect(edit.ok).toBe(false);
    expect(edit).not.toHaveProperty('document');
  });

  it('係数の修正後には原式のまま再計算され、無効時の形をキャッシュから戻さない', async () => {
    const original = fixture();
    const failed = await recomputePart(original, bridge, { math: context(original) });
    expect(failed.bodies.map(body => body.featureId)).toEqual(['good']);
    const repaired: PartDocument = { ...original, parameters: [{ ...original.parameters[0], value: expressionValueFromNumber(4) }] };
    const result = await recomputePart(repaired, bridge, { math: context(repaired) });
    expect(result.errors).toEqual([]);
    expect(result.bodies.map(body => body.featureId)).toEqual(['good', 'bad']);
    expect(result.bodies.find(body => body.featureId === 'bad')?.volume).toBeCloseTo(0.015625, 10);
  });

  it('失敗した係数名と同じIDの独立図形を誤って無効化しない', async () => {
    const original = fixture(), failedValue = math('1/coef("A")', [{ id: 'A', label: 'A', decimal: '2' }]);
    const dependent = math('coef("good")', [{ id: 'good', label: 'good', decimal: '2' }]);
    const document: PartDocument = { ...original, parameters: [...original.parameters,
      { name: 'good', mathId: 'good', value: failedValue, unit: 'mm', description: '' }], solids: [original.solids[0], box('bad', dependent, 20)] };
    const result = await recomputePart(document, bridge, { math: context(document) });
    expect(result.bodies.map(body => body.featureId)).toEqual(['good']);
    expect(result.bodies[0].volume).toBeCloseTo(512, 8);
    expect(result.parameterAnalysis?.failures.map(failure => failure.name)).toContain('good');
  });

  it('失敗した点の次の「直前の点」を以前の成功点へ付け替えず、後の独立点を残す', async () => {
    const original = fixture(), sketch = original.sketches[0];
    const bad = math('1/coef("A")', [{ id: 'A', label: 'A', decimal: '2' }]);
    const old = { ...createPointFeature(sketch, absoluteCoordinate(5, 0, 0)), id: 'old' };
    const failed = { ...createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x: bad }), id: 'failed-point' };
    const previous = { ...createPointFeature(sketch, { mode: 'relative', base: { kind: 'previous' },
      dx: expressionValueFromNumber(1), dy: expressionValueFromNumber(0), dz: expressionValueFromNumber(0) }), id: 'dependent-point' };
    const independent = { ...createPointFeature(sketch, absoluteCoordinate(40, 0, 0)), id: 'independent-point' };
    const document: PartDocument = { ...original, sketches: [{ ...sketch, features: [old, failed, previous, independent] }] };
    const result = await recomputePart(document, bridge, { math: context(document) });
    expect(result.sketches[0].resolved.points.map(point => point.featureId)).toEqual(['old', 'independent-point']);
    expect(result.errors.map(error => error.featureId)).toEqual(expect.arrayContaining(['failed-point', 'dependent-point']));
  });

  it('無効な寸法拘束の連結成分を解かず、同じスケッチの独立点は残す', async () => {
    const original = fixture(), sketch = original.sketches[0];
    const bad = math('1/coef("A")', [{ id: 'A', label: 'A', decimal: '2' }]);
    const points = ['a', 'b', 'c', 'independent'].map((id, index) => ({ ...createPointFeature(sketch, absoluteCoordinate(index * 10, 0, 0)), id }));
    const document: PartDocument = { ...original, sketches: [{ ...sketch, features: points, constraints: [
      { id: 'bad-distance', name: 'bad-distance', kind: 'distance', a: { kind: 'point', pointId: 'a' }, b: { kind: 'point', pointId: 'b' }, length: bad },
      { id: 'linked', name: 'linked', kind: 'coincident', a: { kind: 'point', pointId: 'b' }, b: { kind: 'point', pointId: 'c' } },
    ] }] };
    const result = await recomputePart(document, bridge, { math: context(document) });
    expect(result.sketches[0].resolved.points.map(point => point.featureId)).toEqual(['independent']);
    expect(result.errors.map(error => error.featureId)).toEqual(expect.arrayContaining(['bad-distance', 'linked']));
    expect(result.bodies.map(body => body.featureId)).toEqual(['good']);
  });

  it('無効な球の古い半径から球面上の点を作らない', async () => {
    const original = fixture(), badBox = original.solids[1], sketch = original.sketches[0];
    if (badBox.kind !== 'primitive' || badBox.shape.kind !== 'box') throw new Error('Expected fixture box');
    const sphere: PrimitiveFeature = { ...badBox, shape: { kind: 'sphere', radius: badBox.shape.sizeX } };
    const point = createPointFeature(sketch, { mode: 'relative', base: { kind: 'sphereGrid', sphereFeatureId: 'bad',
      latitude: expressionValueFromNumber(0), longitude: expressionValueFromNumber(0) },
      dx: expressionValueFromNumber(0), dy: expressionValueFromNumber(0), dz: expressionValueFromNumber(0) });
    const document: PartDocument = { ...original, solids: [original.solids[0], sphere], sketches: [{ ...sketch, features: [point] }] };
    const result = await recomputePart(document, bridge, { math: context(document) });
    expect(result.sketches[0].resolved.points).toEqual([]);
    expect(result.errors.map(error => error.featureId)).toContain(point.id);
    expect(result.bodies.map(body => body.featureId)).toEqual(['good']);
  });

  it('幾何参照と拘束が交互に続く下流を全て除外し、独立点を動かさない', async () => {
    const original = fixture(), sketch = original.sketches[0];
    const bad = math('1/coef("A")', [{ id: 'A', label: 'A', decimal: '2' }]);
    const reference = (id: string, parent: string) => ({ ...createPointFeature(sketch, { mode: 'relative',
      base: { kind: 'point', pointId: parent }, dx: expressionValueFromNumber(1),
      dy: expressionValueFromNumber(0), dz: expressionValueFromNumber(0) }), id });
    const point = (id: string, x: number) => ({ ...createPointFeature(sketch, absoluteCoordinate(x, 0, 0)), id });
    const document: PartDocument = { ...original, sketches: [{ ...sketch, features: [
      { ...createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x: bad }), id: 'failed' },
      reference('from-failed', 'failed'), point('linked', 20), reference('from-linked', 'linked'),
      point('last', 30), point('independent', 50),
    ], constraints: [
      { id: 'first-link', name: 'first-link', kind: 'coincident', a: { kind: 'point', pointId: 'from-failed' }, b: { kind: 'point', pointId: 'linked' } },
      { id: 'last-link', name: 'last-link', kind: 'coincident', a: { kind: 'point', pointId: 'from-linked' }, b: { kind: 'point', pointId: 'last' } },
    ] }] };
    const result = await recomputePart(document, bridge, { math: context(document) });
    expect(result.sketches[0].resolved.points.map(point => point.featureId)).toEqual(['independent']);
    expect(result.sketches[0].resolved.points[0].position).toEqual([50, 0, 0]);
    expect(result.errors.map(error => error.featureId)).toEqual(expect.arrayContaining([
      'failed', 'from-failed', 'linked', 'from-linked', 'last', 'first-link', 'last-link',
    ]));
    expect(result.bodies.map(body => body.featureId)).toEqual(['good']);
  });
});
