import { describe, expect, it } from 'vitest';
import { readSolidCadSavedInput, solidCadFaceKey } from './solidCadInput.js';
import { SOLID_CAD_PRESSURE_SCHEMA, SOLID_CAD_TRACTION_SCHEMA } from './solidCadInput.js';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from './beamInputs.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';

function saved() {
  return { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'part' }, bodyFeatureId: 'box',
    fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 210000, poisson: 0.3, tractionMPa: [0, 0, -2],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
describe('unchanged saved face identity contract', () => {
  it('retains both schema strings and byte-identical legacy traction without persisting normals', () => {
    expect(SOLID_CAD_TRACTION_SCHEMA).toBe('pointercad-solid-cad-input/1');
    expect(SOLID_CAD_PRESSURE_SCHEMA).toBe('pointercad-solid-cad-input/2');
    const raw = saved(), bytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(new TextEncoder().encode(JSON.stringify(readSolidCadSavedInput(raw)))).toEqual(bytes);
    expect(() => readSolidCadSavedInput({ ...raw, normals: [[0, 0, 1]] })).toThrow();
    expect(new TextEncoder().encode(JSON.stringify(raw))).toEqual(bytes);
  });
  it('keeps orientation out of a semantic key and owns the saved key arrays', () => {
    const face: SubShapeRef = { bodyFeatureId: 'box', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane',
      area: 6, position: [0, 0, 4], axis: [0, 0, 1], radius: null },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box', role: 'top' } } };
    if (face.fingerprint.kind !== 'face') throw new Error('Expected face fixture');
    const bytes = new TextEncoder().encode(JSON.stringify(face)), key = solidCadFaceKey(face);
    expect(solidCadFaceKey({ ...face, fingerprint: { ...face.fingerprint, axis: [0, 0, -1] } })).toBe(key);
    const raw = { ...saved(), fixedFaces: [key], loadedFaces: [key] }, input = readSolidCadSavedInput(raw);
    raw.loadedFaces[0] = 'changed'; raw.fixedFaces[0] = 'changed';
    expect(input.loadedFaces).toEqual([key]); expect(input.fixedFaces).toEqual([key]);
    expect(new TextEncoder().encode(JSON.stringify(face))).toEqual(bytes);
  });
});
describe('versioned single-solid CAD input persistence', () => {
  it('stores only definitions, owns arrays and checks the shared envelope owner', () => {
    const value = saved(), input = readSolidCadSavedInput(value);
    value.tractionMPa[2] = 100; value.fixedFaces[0] = 'changed';
    expect(input.tractionMPa).toEqual([0, 0, -2]); expect(input.fixedFaces).toEqual(['fixed-origin']);
    const before = { id: 'part' }, after = withBeamAnalysisInputs(before,
      { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition: input }] });
    expect(after).not.toBe(before); expect(before).toEqual({ id: 'part' });
    expect(readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition: input }] }, 'other').ok).toBe(false);
  });
  it.each([
    { schema: 'pointercad-solid-cad-input/2' }, { results: [] }, { youngMPa: 0 }, { poisson: 0.5 },
    { tractionMPa: [0, Infinity, 0] }, { fixedFaces: [] }, { loadedFaces: ['same', 'same'] },
    { fixedFaces: new Array<string>(1) }, { bodyFeatureId: '' }, { maximumVolumeDeviationMm3: -1 },
  ])('refuses malformed/versioned inputs without defaults: %j', patch => {
    expect(() => readSolidCadSavedInput({ ...saved(), ...patch })).toThrow();
  });
  it('keys the semantic native origin instead of transient face ordinal or geometry fingerprint', () => {
    const face: SubShapeRef = { bodyFeatureId: 'box', index: 4, fingerprint: { kind: 'face', surfaceKind: 'plane',
      area: 6, position: [0, 0, 4], axis: [0, 0, 1], radius: null },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box', role: 'top' } } };
    if (face.fingerprint.kind !== 'face') throw new Error('Expected face fixture');
    expect(solidCadFaceKey({ ...face, index: 8, fingerprint: { ...face.fingerprint, area: 9 } })).toBe(solidCadFaceKey(face));
    expect(solidCadFaceKey({ ...face, bodyFeatureId: 'other' })).not.toBe(solidCadFaceKey(face));
    expect(() => solidCadFaceKey({ ...face, origin: undefined })).toThrow();
  });
});

describe('strict signed pressure input beside the legacy traction schema', () => {
  function pressure(): Record<string, unknown> & { loadedFaces: string[] } {
    return { schema: 'pointercad-solid-cad-input/2', id: 'solid-cad', source: { documentId: 'part' }, bodyFeatureId: 'box',
      fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 210000, poisson: 0.3, load: 'pressure',
      pressureMPa: 1.5, linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2,
      maximumVolumeDeviationMm3: 1 };
  }
  it.each([1.5, -2, 0])('reads pressure %s MPa without a traction vector and owns its arrays', value => {
    const raw = { ...pressure(), pressureMPa: value }, input = readSolidCadSavedInput(raw);
    raw.loadedFaces[0] = 'changed';
    expect(input).toMatchObject({ schema: 'pointercad-solid-cad-input/2', load: 'pressure', pressureMPa: value,
      loadedFaces: ['loaded-origin'] });
    expect(Object.is(input.pressureMPa, -0)).toBe(false);
    expect('tractionMPa' in input).toBe(false);
    expect(readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition: input }] }, 'part').ok)
      .toBe(true);
  });
  it('keeps the legacy traction keys and their order unchanged', () => {
    const input = readSolidCadSavedInput(saved());
    expect(Object.keys(input)).toEqual(Object.keys(saved()));
    expect(input).toEqual(saved());
    expect('pressureMPa' in input).toBe(false);
  });
  // Explicit labels: %j would print NaN, Infinity and -Infinity all as null and give three identical test titles.
  it.each([
    ['pressure NaN', { pressureMPa: Number.NaN }], ['pressure +Infinity', { pressureMPa: Infinity }],
    ['pressure -Infinity', { pressureMPa: -Infinity }], ['pressure as a string', { pressureMPa: '1' }],
    ['pressure beyond 1e30', { pressureMPa: 1e31 }], ['load traction', { load: 'traction' }],
    ['load Pressure (wrong case)', { load: 'Pressure' }], ['an added traction vector', { tractionMPa: [0, 0, -2] }],
    ['schema 3', { schema: 'pointercad-solid-cad-input/3' }], ['no loaded faces', { loadedFaces: [] }],
    ['empty body id', { bodyFeatureId: '' }],
  ] as const)('refuses malformed, mixed or ambiguous pressure input: %s', (label, patch) => {
    expect(() => readSolidCadSavedInput({ ...pressure(), ...patch }), label).toThrow();
  });
  it('refuses a traction file that also names a pressure or load kind', () => {
    expect(() => readSolidCadSavedInput({ ...saved(), pressureMPa: 1 })).toThrow();
    expect(() => readSolidCadSavedInput({ ...saved(), load: 'pressure' })).toThrow();
    const withoutLoad = pressure();
    Reflect.deleteProperty(withoutLoad, 'load');
    expect(() => readSolidCadSavedInput(withoutLoad)).toThrow();
  });
});
