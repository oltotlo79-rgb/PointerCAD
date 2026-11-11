import { describe, expect, it } from 'vitest';
import { InputIssue } from './analysisValidation.js';
import { readBeamAnalysisInputs } from './beamInputs.js';
import { readFatigueSavedInput } from './fatigueInput.js';
import { readFatigueTensorSavedInput } from './fatigueTensorInput.js';

/* Values are written out here independently of the reader: a manufactured curve and synthetic tensors, not a material. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured tensor history' };
const curve = { id: 'curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
  referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null, source };
const reference = (xx: number, yy = 0, zz = 0, yz = 0, xz = 0, xy = 0) =>
  ({ unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy', xx, yy, zz, yz, xz, xy });
const history = (overrides: Record<string, unknown> = {}) => ({ id: 'history-1', reference: reference(100),
  loadFactors: [0, 1, 0], sequence: 'once', repeats: 1, source, ...overrides });
const saved = (histories: readonly unknown[] = [history()], overrides: Record<string, unknown> = {}) =>
  ({ schema: 'pointercad-fatigue-saved/4', id: 'fatigue', source: { documentId: 'owner' },
    input: { schema: 'pointercad-fatigue-proportional-tensor/1',
      method: 'proportional-elastic-signed-von-mises-absolute-largest-principal/1', curve, histories }, ...overrides });
const issue = (value: unknown): readonly [string, string] | null => {
  try {
    readFatigueTensorSavedInput(value, 'fatigue');
    return null;
  } catch (error) {
    if (error instanceof InputIssue) return [error.code, error.path];
    throw error;
  }
};

describe('saved proportional tensor fatigue input (version 4)', () => {
  it('reads a complete input exactly: inputs, sources and method only', () => {
    const value = saved([history(), history({ id: 'history-2', reference: reference(0, 0, 0, 0, 0, 10), loadFactors: [-1, 1],
      sequence: 'repeated-periodic', repeats: 1000 })]);
    expect(readFatigueTensorSavedInput(value, 'fatigue')).toEqual(value);
  });

  it('keeps versions 1 to 3 to their own reader and refuses other versions in both readers', () => {
    expect(issue(saved([history()], { schema: 'pointercad-fatigue-saved/5' }))).toEqual(['unsupported-model', 'fatigue']);
    expect(issue(saved([history()], { schema: 'pointercad-fatigue-saved/3' }))).toEqual(['unsupported-model', 'fatigue']);
    expect(() => readFatigueSavedInput(saved(), 'fatigue')).toThrow(InputIssue);
  });

  it.each([
    ['a Goodman correction', saved([history()], { correction: { schema: 'pointercad-fatigue-goodman/1' } }), 'fatigue'],
    ['a stored result', saved([history()], { result: { damage: 0 } }), 'fatigue'],
    ['imported axial sources', saved([history()], { axial: [] }), 'fatigue'],
    ['another id', saved([history()], { id: 'fatigue-2' }), 'fatigue.id'],
    ['an engineering shear convention', saved([history({ reference: { ...reference(100), components: 'engineering-shear' } })]),
      'fatigue.input.histories[0].reference.components'],
    ['a pascal unit', saved([history({ reference: { ...reference(100), unit: 'Pa' } })]), 'fatigue.input.histories[0].reference.unit'],
    ['a missing component', saved([history({ reference: { unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy', xx: 100,
      yy: 0, zz: 0, yz: 0, xz: 0 } })]), 'fatigue.input.histories[0].reference'],
    ['a component of 10000.000001 MPa', saved([history({ reference: reference(10000.000001) })]), 'fatigue.input.histories[0].reference.xx'],
    ['a zero reference', saved([history({ reference: reference(0) })]), 'fatigue.input.histories[0].reference'],
    ['a hydrostatic reference', saved([history({ reference: reference(50, 50, 50) })]), 'fatigue.input.histories[0].reference'],
    ['no load factor', saved([history({ loadFactors: [] })]), 'fatigue.input.histories[0].loadFactors'],
    ['a text factor', saved([history({ loadFactors: [0, '1'] })]), 'fatigue.input.histories[0].loadFactors[1]'],
    ['factor x equivalent of 10100 MPa', saved([history({ loadFactors: [0, 101] })]), 'fatigue.input.histories[0].loadFactors[1]'],
    // 0.5 x MIN_VALUE is the exact half-way value and rounds to the even neighbour 0.
    ['a nonzero factor whose stress rounds to 0', saved([history({ reference: reference(0.5), loadFactors: [0, Number.MIN_VALUE] })]),
      'fatigue.input.histories[0].loadFactors[1]'],
    ['repeats on a once history', saved([history({ repeats: 2 })]), 'fatigue.input.histories[0].repeats'],
    ['a duplicate history id', saved([history(), history()]), 'fatigue.input.histories[1].id'],
    ['65 histories', saved(Array.from({ length: 65 }, (_, index) => history({ id: `h${index}` }))), 'fatigue.input.histories'],
    ['another method', saved([history()], { input: { ...saved().input, method: 'critical-plane' } }), 'fatigue.input.method'],
  ])('refuses %s', (_label, value, path) => {
    expect(issue(value)?.[1]).toBe(path);
  });

  it('accepts the exact boundaries the core accepts', () => {
    expect(issue(saved([history({ reference: reference(10000), loadFactors: [0, 1] })]))).toBeNull();
    expect(issue(saved([history({ loadFactors: [0, 100] })]))).toBeNull();
    expect(issue(saved([history({ reference: reference(1), loadFactors: [0, Number.MIN_VALUE] })]))).toBeNull();
    expect(issue(saved([history({ reference: reference(Number.MIN_VALUE), loadFactors: [-1, 1] })]))).toBeNull();
    expect(issue(saved(Array.from({ length: 64 }, (_, index) => history({ id: `h${index}` }))))).toBeNull();
  });
});

describe('the single fatigue configuration of a document', () => {
  const stressV3 = { schema: 'pointercad-fatigue-saved/3', id: 'fatigue', source: { documentId: 'owner' }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { ...curve, meanStressAssumption: 'fully-reversed-only' },
      histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [-80, 80], sequence: 'repeated-periodic', repeats: 1, source }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 10_000, source } };
  const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });

  it('reads a tensor configuration through the analysis attachment and keeps a stress configuration readable', () => {
    const tensor = readBeamAnalysisInputs(attachment({ kind: 'fatigue-proportional-tensor', definition: saved() }), 'owner');
    expect(tensor.ok ? tensor.value.analyses : null).toEqual([{ kind: 'fatigue-proportional-tensor', definition: saved() }]);
    const stress = readBeamAnalysisInputs(attachment({ kind: 'fatigue', definition: stressV3 }), 'owner');
    expect(stress.ok ? stress.value.analyses : null).toEqual([{ kind: 'fatigue', definition: stressV3 }]);
  });

  it('refuses a stress and a tensor configuration together, and a foreign document', () => {
    const both = readBeamAnalysisInputs(attachment({ kind: 'fatigue', definition: stressV3 },
      { kind: 'fatigue-proportional-tensor', definition: saved() }), 'owner');
    expect(both.ok ? null : both.issue.code).toBe('duplicate-id');
    const foreign = readBeamAnalysisInputs(attachment({ kind: 'fatigue-proportional-tensor', definition: saved() }), 'other');
    expect(foreign.ok ? null : foreign.issue.code).toBe('wrong-document');
    // The version 1-3 reader checks its field set first, so a version 4 value under the stress kind is a shape refusal.
    const asStress = readBeamAnalysisInputs(attachment({ kind: 'fatigue', definition: saved() }), 'owner');
    expect(asStress.ok ? null : asStress.issue.code).toBe('shape');
  });
});
