import { describe, expect, it } from 'vitest';
import { createSolidFiniteSession, parseSolidFiniteFactors, solidFiniteSavedInput, type SolidFiniteSession } from './solidFiniteSession.js';
import { createSolidSupport } from '../solidAnalysis/solidBoundaryDraft.js';

/** Synthetic benchmark constants only. */
function filled(): SolidFiniteSession {
  const base = createSolidFiniteSession('owner');
  return { ...base, bodyFeatureId: 'box', fixedFaces: ['bottom'], loadedFaces: ['top'],
    values: { ...base.values, young: '200 GPa', poisson: '0.3', yield: '250', hardening: '2000', tz: '-4/2', volume: '1',
      forceFactors: '1, 1, 0, -1', prescribedFactors: '0, -1, -1, 2', reference: 'Synthetic benchmark source' } };
}
describe('finite session authored input', () => {
  it('starts without implicit material, histories, force reference or density', () => {
    const session = createSolidFiniteSession('owner');
    expect(session.fieldView).toEqual({ step: 1, quantity: 'vonMises', deformationScale: 1 });
    for (const name of ['young', 'poisson', 'yield', 'hardening', 'reference', 'forceFactors', 'prescribedFactors', 'referenceForce'] as const)
      expect(session.values[name]).toBe('');
    expect(session.gravity?.density).toBe(''); expect(session.gravity?.enabled).toBe(false);
    expect(session.values.tx).toBe('0'); expect(session.values.ty).toBe('0'); expect(session.values.tz).toBe('');
    expect(() => solidFiniteSavedInput(session, 'part', [])).toThrow();
  });
  it('evaluates existing units/expressions and round-trips the two columns without inserting or interpolating steps', () => {
    const saved = solidFiniteSavedInput(filled(), 'part', []);
    expect(Object.hasOwn(saved, 'fieldView')).toBe(false);
    expect(saved.youngMPa).toBe(200000); expect(saved.tractionMPa).toEqual([0, 0, -2]);
    expect(saved.forceFactors).toEqual([1, 1, 0, -1]); expect(saved.prescribedDisplacementFactors).toEqual([0, -1, -1, 2]);
    const restored = createSolidFiniteSession('different-owner', saved);
    expect(restored.ownerId).toBe('different-owner'); expect(restored.status).toBe('editing'); expect(restored.result).toBeNull();
    expect(solidFiniteSavedInput(restored, 'part', [])).toEqual(saved);
  });
  it.each(['', '1,,2', 'NaN', 'Infinity', '1e999', '1+1', '1 2', '0x10', '1\n2'])('rejects malformed factor list %j', value => {
    expect(() => parseSolidFiniteFactors(value)).toThrow();
  });
  it('accepts signed decimal and exponent forms, including repeated values, within 200 actual steps', () => {
    expect(parseSolidFiniteFactors(' +1, -.5, 1e-2, 1e-2 ')).toEqual([1, -0.5, 0.01, 0.01]);
    expect(parseSolidFiniteFactors(Array(200).fill('1').join(','))).toHaveLength(200);
    expect(() => parseSolidFiniteFactors(Array(201).fill('1').join(','))).toThrow();
  });
  it.each([{ prescribedFactors: '1' }, { reference: '  ' }, { hardening: '-1' }, { poisson: '-0.1' },
    { referenceForce: '0' }, { referenceForce: 'Infinity' }, { forceFactors: '0,0,0,0' }])('rejects invalid session %j', patch => {
    const session = filled();
    expect(() => solidFiniteSavedInput({ ...session, values: { ...session.values, ...patch } }, 'part', [])).toThrow();
  });
  it('keeps disabled gravity drafts inert and accepts signed displacement control with explicit N reference', () => {
    const session = filled(), row = createSolidSupport('side');
    const draft = { ...session, fixedFaces: [], loadedFaces: [], supports: [{ ...row, fixed: [true, false, true] as const,
      displacement: ['-2 mm', '0', '1'] as const, prescribed: true }],
    gravity: { enabled: false, acceleration: ['invalid', 'invalid', 'invalid'] as const, density: 'invalid' },
    values: { ...session.values, referenceForce: '2 kN' } };
    const saved = solidFiniteSavedInput(draft, 'part', []);
    expect(saved.referenceForceN).toBe(2000); expect(saved.supports?.[0].prescribedMm).toEqual([-2, 0, 1]);
    expect(Object.hasOwn(saved, 'gravity')).toBe(false);
    expect(solidFiniteSavedInput(createSolidFiniteSession('owner', saved), 'part', [])).toEqual(saved);
  });
  it('uses the existing gravity helpers and keeps negative prescribed values and yield above E', () => {
    const session = filled();
    const saved = solidFiniteSavedInput({ ...session, loadedFaces: [],
      gravity: { enabled: true, acceleration: ['0', '0', '-9.81 m/s2'], density: '7800' },
      values: { ...session.values, yield: '300 GPa' } }, 'part', []);
    expect(saved.yieldStressMPa).toBe(300000); expect(saved.gravity?.accelerationMps2).toEqual([0, 0, -9.81]);
    expect(saved.gravity?.densityKgM3).toBe(7800);
  });
});
