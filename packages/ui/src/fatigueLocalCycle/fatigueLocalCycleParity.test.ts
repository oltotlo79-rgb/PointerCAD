import { analyzeLocalCycle, validateLocalCycleInput } from '@pointercad/fem';
import { readFatigueLocalCycleSavedProblem } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';

/* The panel saves through the model reader and runs the solver reader, so both must give the same verdict on the same
 * data. This file adds the missing-unit, source, calibration and check-order cases to the 30 rows of the fem
 * persistence test. Every expected verdict is written by hand from the saved-format contract ('accepted', '$' for the
 * whole problem, or the first refused field relative to the problem; a missing key is a shape refusal of its parent
 * record, a present but wrong value is refused at its own path), not copied from either implementation. Coefficients
 * are manufactured test values, not a real material. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured local cycle' };
const calibration = { minimumCycles: 1, maximumCycles: 1e6 };
const material = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'manufactured', stressUnit: 'MPa',
  elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000, fatigueStrengthExponent: -0.5,
  fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5, calibration, source, ...change });
const cycle = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ strainMeasure: 'local-total-strain',
  strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: 'measured', strainMax: 0.01, strainMin: -0.01, stressMax: 500,
  stressMin: -300, source, ...change });
const problem = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ schema: 'pointercad-strain-life-local-cycle/1',
  correction: 'swt', material: material(), cycle: cycle(), ...change });
const without = (row: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
/** Eight own fields and the ninth (source) only inherited: not a saved field. */
function inheritedSource(): Record<string, unknown> {
  const row = without(cycle(), 'source');
  if (!Reflect.setPrototypeOf(row, { source })) throw new Error('Prototype not set');
  return row;
}

function modelVerdict(value: unknown): string {
  try {
    readFatigueLocalCycleSavedProblem(value, 'input');
    return 'accepted';
  } catch (error) {
    if (!(error instanceof Error) || !('path' in error) || typeof error.path !== 'string') throw error;
    const path = error.path.replace(/^input\.?/u, '');
    return path === '' ? '$' : path;
  }
}
function solverVerdict(value: unknown): string {
  const checked = validateLocalCycleInput(value);
  return checked.ok ? 'accepted' : checked.path;
}

const cases: [string, unknown, string][] = [
  // Units.
  ['material stress unit GPa', problem({ material: material({ stressUnit: 'GPa' }) }), 'material.stressUnit'],
  ['material stress unit missing', problem({ material: without(material(), 'stressUnit') }), 'material'],
  ['material stress unit holding undefined', problem({ material: material({ stressUnit: undefined }) }), 'material.stressUnit'],
  ['cycle strain unit missing', problem({ cycle: without(cycle(), 'strainUnit') }), 'cycle'],
  ['cycle stress unit missing', problem({ cycle: without(cycle(), 'stressUnit') }), 'cycle'],
  ['cycle stress unit holding undefined', problem({ cycle: cycle({ stressUnit: undefined }) }), 'cycle.stressUnit'],
  ['cycle stress unit with a trailing space', problem({ cycle: cycle({ stressUnit: 'MPa ' }) }), 'cycle.stressUnit'],
  ['cycle strain measure missing', problem({ cycle: without(cycle(), 'strainMeasure') }), 'cycle'],
  ['cycle derivation holding undefined', problem({ cycle: cycle({ derivation: undefined }) }), 'cycle.derivation'],
  // Sources.
  ['material source missing', problem({ material: without(material(), 'source') }), 'material'],
  ['material source null', problem({ material: material({ source: null }) }), 'material.source'],
  ['material source from a handbook kind', problem({ material: material({ source: { ...source, kind: 'handbook' } }) }), 'material.source'],
  ['material source extra key', problem({ material: material({ source: { ...source, grade: 'invented' } }) }), 'material.source'],
  ['material source reference over 512 characters', problem({ material: material({ source: { ...source, reference: 'r'.repeat(513) } }) }),
    'material.source'],
  ['material source condition holding undefined', problem({ material: material({ source: { ...source, condition: undefined } }) }),
    'material.source'],
  ['material id blank', problem({ material: material({ id: '   ' }) }), 'material.id'],
  ['material id over 64 characters', problem({ material: material({ id: 'm'.repeat(65) }) }), 'material.id'],
  ['cycle source missing', problem({ cycle: without(cycle(), 'source') }), 'cycle'],
  ['cycle source only inherited', problem({ cycle: inheritedSource() }), 'cycle'],
  ['cycle source null', problem({ cycle: cycle({ source: null }) }), 'cycle.source'],
  ['cycle source of another kind', problem({ cycle: cycle({ source: { ...source, kind: 'library' } }) }), 'cycle.source'],
  ['cycle source extra key', problem({ cycle: cycle({ source: { ...source, cyclesToFailure: 100 } }) }), 'cycle.source'],
  // Calibration.
  ['calibration missing', problem({ material: without(material(), 'calibration') }), 'material'],
  ['calibration null', problem({ material: material({ calibration: null }) }), 'material.calibration'],
  ['calibration extra key', problem({ material: material({ calibration: { ...calibration, confidence: 0.9 } }) }), 'material.calibration'],
  ['calibration minimum zero', problem({ material: material({ calibration: { ...calibration, minimumCycles: 0 } }) }),
    'material.calibration.minimumCycles'],
  ['calibration minimum negative zero', problem({ material: material({ calibration: { ...calibration, minimumCycles: -0 } }) }),
    'material.calibration.minimumCycles'],
  ['calibration minimum below half a cycle', problem({ material: material({ calibration: { ...calibration, minimumCycles: 0.25 } }) }),
    'material.calibration.minimumCycles'],
  ['calibration minimum text', problem({ material: material({ calibration: { ...calibration, minimumCycles: '1' } }) }),
    'material.calibration.minimumCycles'],
  ['calibration maximum beyond 1e12', problem({ material: material({ calibration: { ...calibration, maximumCycles: 1e13 } }) }),
    'material.calibration.maximumCycles'],
  ['calibration interval empty', problem({ material: material({ calibration: { minimumCycles: 1000, maximumCycles: 1000 } }) }),
    'material.calibration.maximumCycles'],
  // Shapes and values.
  ['schema missing', without(problem(), 'schema'), '$'],
  ['problem as an array', [], '$'],
  ['material as an array', problem({ material: [] }), 'material'],
  ['cycle as an array', problem({ cycle: [] }), 'cycle'],
  ['correction in capitals', problem({ correction: 'SWT' }), 'correction'],
  ['strain minimum not a number', problem({ cycle: cycle({ strainMin: Number.NaN }) }), 'cycle.strainMin'],
  // Check order: the first refused field in the documented order wins in both readers.
  ['material before cycle', problem({ material: material({ stressUnit: 'GPa' }), cycle: cycle({ stressUnit: 'GPa' }) }), 'material.stressUnit'],
  ['id before stress unit', problem({ material: material({ id: '', stressUnit: 'GPa' }) }), 'material.id'],
  ['calibration before material source', problem({ material: material({ calibration: { minimumCycles: 10, maximumCycles: 5 },
    source: { ...source, reference: '' } }) }), 'material.calibration.maximumCycles'],
  ['strain measure before derivation', problem({ cycle: cycle({ strainMeasure: 'nominal', derivation: 'linear-elastic' }) }),
    'cycle.strainMeasure'],
  ['derivation before strain unit', problem({ cycle: cycle({ derivation: 'linear-elastic', strainUnit: 'percent' }) }), 'cycle.derivation'],
  ['units before values', problem({ cycle: cycle({ stressUnit: 'GPa', strainMax: 2 }) }), 'cycle.stressUnit'],
  ['extrema before cycle source', problem({ cycle: cycle({ strainMin: 0.01, source: { ...source, reference: '' } }) }), 'cycle.strainMin'],
  // Accepted edges: domain limits are analysis refusals, not saved-format refusals.
  ['negative-zero stress minimum', problem({ cycle: cycle({ stressMax: 400, stressMin: -0 }) }), 'accepted'],
  ['calibration at both cycle limits', problem({ material: material({ calibration: { minimumCycles: 0.5, maximumCycles: 1e12 } }) }),
    'accepted'],
  ['SWT with zero maximum stress', problem({ cycle: cycle({ stressMax: 0, stressMin: -500 }) }), 'accepted'],
];

/** Codes that only the analysis (not a reader) may return for an accepted problem. */
const ANALYSIS_CODES = ['swt-nonpositive-maximum-stress', 'swt-parameter-underflow', 'strain-life-morrow-domain',
  'strain-life-shorter-than-calibration', 'strain-life-longer-than-calibration', 'strain-life-flat', 'strain-life-not-converged'];

describe('saved local-cycle model reader and solver reader agree on units, sources, calibration and order', () => {
  it.each(cases)('%s', (_label, value, expected) => {
    expect([modelVerdict(value), solverVerdict(value)]).toEqual([expected, expected]);
  });

  it.each(cases.filter(([, , expected]) => expected === 'accepted'))('analyses the accepted %s without a reader refusal', (_label, value) => {
    const analysis = analyzeLocalCycle(value);
    expect(analysis.ok || ANALYSIS_CODES.includes(analysis.code)).toBe(true);
  });

  it('never reports a life or no damage for SWT with zero maximum stress', () => {
    const analysis = analyzeLocalCycle(problem({ cycle: cycle({ stressMax: 0, stressMin: -500 }) }));
    expect(analysis.ok ? null : [analysis.code, analysis.path]).toEqual(['swt-nonpositive-maximum-stress', 'cycle.stressMax']);
  });
});
