import { describe, expect, it } from 'vitest';
import { SOLID_FIELD_QUANTITIES, solidFieldFraction } from '../solidAnalysis/solidFieldView.js';
import { buildSolidFiniteFieldMesh, DEFAULT_SOLID_FINITE_FIELD_VIEW } from './solidFiniteFieldView.js';
import { FIELD_DISPLACEMENTS, FIELD_NODES, finiteFieldOutcome } from './solidFiniteField.testSupport.js';

describe('finite field mesh: pure display transform', () => {
  it('uses row-major Cauchy components and independently known von Mises, not Kirchhoff tau', async () => {
    const outcome = await finiteFieldOutcome();
    const expected = [[Math.sqrt(11850), Math.sqrt(2800)], [100, -40], [-20, 0], [10, 0], [3, 20], [-4, 0], [5, 0]];
    SOLID_FIELD_QUANTITIES.forEach((quantity, index) => {
      expect(buildSolidFiniteFieldMesh(outcome, { step: 1, quantity, deformationScale: 0 })?.elementValues).toEqual(expected[index]);
    });
    expect(buildSolidFiniteFieldMesh(outcome, { ...DEFAULT_SOLID_FINITE_FIELD_VIEW, step: 2 })?.elementValues)
      .toEqual([Math.sqrt(300), 0]);
  });

  it('removes the shared face and keeps outward boundary triangles owned by their elements', async () => {
    const field = buildSolidFiniteFieldMesh(await finiteFieldOutcome(), { step: 1, quantity: 'xx', deformationScale: 0 });
    if (!field) throw new Error('Expected finite field');
    expect(field.triangleElements).toEqual([0, 0, 0, 1, 1, 1]);
    const expectedCorners = [0, 2, 1, 0, 1, 3, 0, 3, 2, 4, 3, 1, 4, 1, 2, 4, 2, 3];
    expect(field.positions).toEqual(expectedCorners.flatMap(node => FIELD_NODES[node]));
    expect(field.legend).toEqual({ minimum: -40, maximum: 100, constant: false });
  });

  it('uses the requested step and exactly initial mm plus scale times displacement mm, without mutating any input', async () => {
    const outcome = await finiteFieldOutcome(), before = JSON.stringify(outcome);
    for (const step of [1, 2]) for (const scale of [0, 1, 100]) {
      const field = buildSolidFiniteFieldMesh(outcome, { step, quantity: 'xx', deformationScale: scale });
      const corners = [0, 2, 1, 0, 1, 3, 0, 3, 2, 4, 3, 1, 4, 1, 2, 4, 2, 3];
      expect(field?.positions).toEqual(corners.flatMap(node => FIELD_NODES[node]
        .map((value, axis) => value + scale * (FIELD_DISPLACEMENTS[node][axis] * step))));
    }
    expect(JSON.stringify(outcome)).toBe(before);
    const zero = buildSolidFiniteFieldMesh(outcome, { step: 2, quantity: 'zz', deformationScale: 0 });
    expect(zero?.legend).toEqual({ minimum: 0, maximum: 0, constant: true });
    if (!zero) throw new Error('Expected zero field');
    expect(solidFieldFraction(0, zero.legend)).toBe(0.5);
  });

  it('refuses failed/cancelled outcomes and noninteger, missing, negative or nonfinite choices', async () => {
    const good = await finiteFieldOutcome();
    expect(buildSolidFiniteFieldMesh(null, DEFAULT_SOLID_FINITE_FIELD_VIEW)).toBeNull();
    expect(buildSolidFiniteFieldMesh({ kind: 'failed', code: 'test', message: 'refused' }, DEFAULT_SOLID_FINITE_FIELD_VIEW)).toBeNull();
    expect(buildSolidFiniteFieldMesh({ kind: 'cancelled', reason: 'abort' }, DEFAULT_SOLID_FINITE_FIELD_VIEW)).toBeNull();
    for (const step of [0, -1, 0.5, 3, NaN, Infinity])
      expect(buildSolidFiniteFieldMesh(good, { ...DEFAULT_SOLID_FINITE_FIELD_VIEW, step })).toBeNull();
    for (const deformationScale of [-1, NaN, Infinity])
      expect(buildSolidFiniteFieldMesh(good, { ...DEFAULT_SOLID_FINITE_FIELD_VIEW, deformationScale })).toBeNull();
    const invalidQuantity = { ...DEFAULT_SOLID_FINITE_FIELD_VIEW };
    Reflect.set(invalidQuantity, 'quantity', 'not-a-field');
    expect(buildSolidFiniteFieldMesh(good, invalidQuantity)).toBeNull();
  });

  it('refuses partial histories, mismatched source/mesh/preparation, and invalid or overflowing displayed numbers', async () => {
    const good = await finiteFieldOutcome(), first = good.result.records[0], second = good.result.records[1];
    const view = DEFAULT_SOLID_FINITE_FIELD_VIEW;
    const withFirst = (record: typeof first) => ({ ...good, result: { ...good.result, records: [record, second] } });
    expect(buildSolidFiniteFieldMesh({ ...good, result: { ...good.result, records: [first] } }, view)).toBeNull();
    expect(buildSolidFiniteFieldMesh(withFirst({ ...first, step: 2 }), view)).toBeNull();
    expect(buildSolidFiniteFieldMesh(withFirst({ ...first, displacementMm: [[0, 0, NaN], ...first.displacementMm.slice(1)] }), view)).toBeNull();
    expect(buildSolidFiniteFieldMesh(withFirst({ ...first, elements: [] }), view)).toBeNull();
    const sigma = [...first.elements[0].sigma]; sigma[8] = Infinity;
    expect(buildSolidFiniteFieldMesh(withFirst({ ...first, elements: [{ ...first.elements[0], sigma }, first.elements[1]] }), view)).toBeNull();
    expect(buildSolidFiniteFieldMesh({ ...good, input: { ...good.input, source: { ...good.input.source, revision: 8 } } }, view)).toBeNull();
    expect(buildSolidFiniteFieldMesh({ ...good, mesh: { ...good.mesh, tetrahedra: [...good.mesh.tetrahedra].reverse() } }, view)).toBeNull();
    expect(buildSolidFiniteFieldMesh({ ...good, prepared: { ...good.prepared, input: { ...good.prepared.input,
      nodes: [[99, 0, 0], ...good.prepared.input.nodes.slice(1)] } } }, view)).toBeNull();
    const hugeMove = withFirst({ ...first, displacementMm: first.displacementMm.map(() => [2, 0, 0]) });
    expect(buildSolidFiniteFieldMesh(hugeMove, { ...view, deformationScale: Number.MAX_VALUE })).toBeNull();
  });
});
