import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from './beamInputs.js';
import { readSolidBucklingCadSavedInput, SOLID_BUCKLING_CAD_SCHEMA } from './solidBucklingCadInput.js';

const reference = {
  schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'doc-1' }, bodyFeatureId: 'body-1',
  fixedFaces: ['fixed-key'], loadedFaces: ['loaded-key'], youngMPa: 205000, poisson: 0.3, tractionMPa: [0, 0, -2],
  linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1,
};
const saved = { schema: SOLID_BUCKLING_CAD_SCHEMA, id: 'solid-buckling-cad', source: { documentId: 'doc-1' }, modeCount: 3, reference };
function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

describe('readSolidBucklingCadSavedInput', () => {
  it('reads the count and a complete static reference input', () => {
    const value = readSolidBucklingCadSavedInput(structuredClone(saved));
    expect(value).toEqual(saved);
    expect(Object.keys(value)).toEqual(['schema', 'id', 'source', 'modeCount', 'reference']);
  });
  it('accepts a signed normal pressure reference (schema 2) and keeps it a pressure input', () => {
    const pressure = { ...without(reference, 'tractionMPa'), schema: 'pointercad-solid-cad-input/2', load: 'pressure', pressureMPa: 1.5 };
    const value = readSolidBucklingCadSavedInput({ ...saved, reference: pressure });
    expect(value.reference.schema).toBe('pointercad-solid-cad-input/2');
    expect(value.reference.pressureMPa).toBe(1.5);
    expect('tractionMPa' in value.reference).toBe(false);
  });
  it.each([0, 13, 1.5, -1, Number.NaN])('refuses the load factor count %s', modeCount => {
    expect(() => readSolidBucklingCadSavedInput({ ...saved, modeCount })).toThrow();
  });
  it('accepts the bounds 1 and 12', () => {
    expect(readSolidBucklingCadSavedInput({ ...saved, modeCount: 1 }).modeCount).toBe(1);
    expect(readSolidBucklingCadSavedInput({ ...saved, modeCount: 12 }).modeCount).toBe(12);
  });
  it('refuses another schema, id, an extra or a missing field', () => {
    expect(() => readSolidBucklingCadSavedInput({ ...saved, schema: 'pointercad-solid-buckling-cad-input/2' })).toThrow('Unsupported');
    expect(() => readSolidBucklingCadSavedInput({ ...saved, id: 'solid-cad' })).toThrow('Unsupported');
    expect(() => readSolidBucklingCadSavedInput({ ...saved, shape: [] })).toThrow();
    expect(() => readSolidBucklingCadSavedInput(without(saved, 'reference'))).toThrow();
  });
  it('refuses a reference the static reader refuses (no loaded face, traction and pressure together)', () => {
    expect(() => readSolidBucklingCadSavedInput({ ...saved, reference: { ...reference, loadedFaces: [] } })).toThrow();
    expect(() => readSolidBucklingCadSavedInput({ ...saved, reference: { ...reference, load: 'pressure', pressureMPa: 1 } })).toThrow();
  });
  it('refuses a reference saved for another document', () => {
    expect(() => readSolidBucklingCadSavedInput({ ...saved, reference: { ...reference, source: { documentId: 'doc-2' } } }))
      .toThrow('different document');
  });
});

describe('beam analysis inputs with a solid buckling input', () => {
  it('round-trips next to the static input of the same document', () => {
    const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-cad', definition: reference }, { kind: 'solid-buckling-cad', definition: saved }] }, 'doc-1');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value.analyses.map(input => input.kind)).toEqual(['solid-cad', 'solid-buckling-cad']);
  });
  it('refuses two buckling inputs and a buckling input of another document', () => {
    const two = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-buckling-cad', definition: saved }, { kind: 'solid-buckling-cad', definition: saved }] }, 'doc-1');
    expect(two.ok).toBe(false);
    const other = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-buckling-cad', definition: saved }] }, 'doc-2');
    expect(other.ok ? null : other.issue.code).toBe('wrong-document');
  });
});
