import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber as num, type ExpressionValue } from '@pointercad/expression';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { SketchFeature } from '../sketch/types.js';
import { toSolidStepRequest } from '../kernelBridge/solidRequests.js';
import { appendSolid, createEmptyPartDocument } from './createPartDocument.js';
import { collectExpressionSources } from './reevaluatePart.js';
import { resolvePart } from './resolvePart.js';
import type { PartDocument, SweepFeature } from './types.js';

const profile = { sketchId: 'sketch-1', faceFeatureId: 'face' };
const plain: SweepFeature = { id: 'sweep', name: 'sweep', kind: 'sweep', suppressed: false, profile, frenet: false,
  path: { sketchId: 'sketch-1', curveIds: ['line'] } };
const formula = (source: string, value: number): ExpressionValue => ({ ...num(value), source });

function documentWith(sweep: SweepFeature): PartDocument {
  const part = createEmptyPartDocument();
  const outer: SketchFeature = { id: 'outer', name: 'outer', kind: 'rectangle', planeId: 'xy',
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(20, 10, 0), construction: false };
  const line: SketchFeature = { id: 'line', name: 'line', kind: 'line', planeId: 'xy',
    from: absoluteCoordinate(10, 5, 0), to: absoluteCoordinate(10, 60, 0), construction: false };
  const face = { id: 'face', name: 'face', kind: 'face' as const, planeId: 'xy', boundary: [{ featureId: 'outer' }], color: '#eeeeee' };
  return { ...part, sketches: [{ ...part.sketches[0], features: [outer, line, face] }], solids: [sweep] };
}
function stepOf(sweep: SweepFeature) {
  const result = resolvePart(documentWith(sweep));
  expect(result.errors).toEqual([]);
  const step = result.steps[0];
  if (step?.plan.kind !== 'sweep') throw new Error('スイープの計画がありません');
  return { step, plan: step.plan };
}
function refusal(sweep: SweepFeature): string | undefined {
  const result = resolvePart(documentWith(sweep));
  expect(result.steps).toEqual([]);
  return result.errors.find(error => error.featureId === sweep.id)?.message;
}

/** スイープのねじれ・終わりの大きさ・肉厚(M-07)の解決。使わない欄は plan・段・鍵に載せず、今のスイープは 1 字も変わらない。 */
describe('スイープのねじれ・終わりの大きさ・肉厚の計画(M-07)', () => {
  it('欄の無いスイープと、ねじれ 0・倍率 1・肉厚 0 を書いたスイープは、同じ plan・同じ段・同じ鍵', () => {
    const before = stepOf(plain);
    for (const key of ['twist', 'endScale', 'wallThickness', 'holes']) expect(before.plan).not.toHaveProperty(key);
    const written = stepOf({ ...plain, twistDegrees: formula('0', 0), endScale: formula('1', 1), wallThickness: formula('0', 0) });
    expect(written.plan).toEqual(before.plan);
    expect(written.step.key).toBe(before.step.key);
    expect(toSolidStepRequest(written.step).step).toEqual(toSolidStepRequest(before.step).step);
  });

  it('ねじれは度からラジアンへ、倍率と肉厚はそのまま plan と段に載り、鍵が変わる', () => {
    const before = stepOf(plain);
    const shaped = stepOf({ ...plain, twistDegrees: formula('45 * 2', 90), endScale: formula('1 / 2', 0.5), wallThickness: formula('1', 1) });
    expect(shaped.plan.twist).toBeCloseTo(Math.PI / 2, 15);
    expect(shaped.plan.endScale).toBe(0.5);
    expect(shaped.plan.wallThickness).toBe(1);
    expect(toSolidStepRequest(shaped.step).step).toMatchObject({ kind: 'sweep', endScale: 0.5, wallThickness: 1 });
    expect(shaped.step.key).not.toBe(before.step.key);
    expect(stepOf({ ...plain, twistDegrees: formula('-90', -90) }).step.key).not.toBe(stepOf({ ...plain, twistDegrees: formula('90', 90) }).step.key);
  });

  it('範囲の外と組み合わせは、理由をつけて断る', () => {
    expect(refusal({ ...plain, twistDegrees: formula('3601', 3601) })).toBe('ねじれは±3600度(10回転)までにしてください。');
    expect(refusal({ ...plain, endScale: formula('0', 0) })).toBe('終わりの大きさは、0より大きく10以下の倍率にしてください。');
    expect(refusal({ ...plain, endScale: formula('11', 11) })).toBe('終わりの大きさは、0より大きく10以下の倍率にしてください。');
    expect(refusal({ ...plain, wallThickness: formula('-1', -1) })).toBe('肉厚は0より大きい長さにしてください。');
    expect(refusal({ ...plain, guide: { sketchId: 'sketch-1', curveIds: ['line'] }, twistDegrees: formula('90', 90) }))
      .toBe('案内線とねじれ・先細りは同時に使えません。');
  });

  it('3 つのどれかを持つスイープを足すと文書は版 24、無ければ版 22 のまま。式は依存の集めにも出る', () => {
    expect(appendSolid(createEmptyPartDocument(), plain).schemaVersion).toBe(22);
    for (const shape of [{ twistDegrees: formula('90', 90) }, { endScale: formula('2', 2) }, { wallThickness: formula('1', 1) }]) {
      expect(appendSolid(createEmptyPartDocument(), { ...plain, ...shape }).schemaVersion).toBe(24);
    }
    const sources = collectExpressionSources(documentWith({ ...plain, twistDegrees: formula('角度 * 2', 90) }));
    expect(sources).toContain('角度 * 2');
  });
});
