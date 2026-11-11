import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from './beamInputs.js';
import { readSolidModalCadSavedInput, SOLID_MODAL_CAD_SCHEMA } from './solidModalCadInput.js';

const valid = {
  schema: SOLID_MODAL_CAD_SCHEMA, id: 'solid-modal-cad', source: { documentId: 'part-1' }, bodyFeatureId: 'box',
  fixedFaces: ['{"face":1}'], youngMPa: 205000, poisson: 0.3, densityKgM3: 7850, modeCount: 6,
  linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1,
};

describe('readSolidModalCadSavedInput', () => {
  it('reads exactly the saved physical input, with free-free as an empty face list', () => {
    expect(readSolidModalCadSavedInput(valid)).toEqual(valid);
    expect(readSolidModalCadSavedInput({ ...valid, fixedFaces: [] }).fixedFaces).toEqual([]);
    expect(JSON.stringify(readSolidModalCadSavedInput(JSON.parse(JSON.stringify(valid))))).toBe(JSON.stringify(valid));
  });

  it('refuses display choices, unknown versions and invalid physical values', () => {
    for (const bad of [
      { ...valid, amplitudeMm: 10 }, { ...valid, modeNumber: 1 }, { ...valid, schema: 'pointercad-solid-modal-cad-input/2' },
      { ...valid, id: 'solid-cad' }, { ...valid, densityKgM3: 0 }, { ...valid, densityKgM3: Number.NaN },
      { ...valid, modeCount: 0 }, { ...valid, modeCount: 21 }, { ...valid, modeCount: 2.5 }, { ...valid, poisson: 0.5 },
      { ...valid, youngMPa: -1 }, { ...valid, fixedFaces: ['a', 'a'] }, { ...valid, maximumChordDeviationMm: -1 },
    ]) expect(() => readSolidModalCadSavedInput(bad)).toThrow();
  });

  it('is one more attachment kind beside an existing static input, at most once per document', () => {
    const staticInput = { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'part-1' },
      bodyFeatureId: 'box', fixedFaces: ['{"face":1}'], loadedFaces: ['{"face":2}'], youngMPa: 205000, poisson: 0.3,
      tractionMPa: [0, 0, -1], linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
    const both = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'solid-cad', definition: staticInput }, { kind: 'solid-modal-cad', definition: valid }] }, 'part-1');
    expect(both.ok).toBe(true);
    // A legacy attachment without the modal kind is read unchanged.
    expect(readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition: staticInput }] }, 'part-1').ok).toBe(true);
    expect(readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'solid-modal-cad', definition: valid }, { kind: 'solid-modal-cad', definition: valid }] }, 'part-1').ok).toBe(false);
    expect(readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'solid-modal-cad', definition: { ...valid, source: { documentId: 'other' } } }] }, 'part-1').ok).toBe(false);
  });
});
