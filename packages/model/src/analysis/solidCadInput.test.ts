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
  it('keeps legacy pressure bytes and optional-field omission unchanged', () => {
    const raw = pressure(), input = readSolidCadSavedInput(raw);
    expect(new TextEncoder().encode(JSON.stringify(input))).toEqual(new TextEncoder().encode(JSON.stringify(raw)));
    expect(Object.hasOwn(input, 'supports')).toBe(false);
    expect(Object.hasOwn(input, 'gravity')).toBe(false);
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

describe('explicit CAD gravity definitions', () => {
  it.each(['traction', 'pressure'] as const)('owns a gravity-only %s definition without inventing loaded faces', load => {
    const { tractionMPa, ...common } = saved();
    const base = load === 'traction' ? saved()
      : { ...common, schema: SOLID_CAD_PRESSURE_SCHEMA, load, pressureMPa: tractionMPa[2] };
    const gravity = { accelerationMps2: [1.25, -9.81, 2.5], densityKgM3: 7800 };
    const raw = { ...base, loadedFaces: [], gravity }, input = readSolidCadSavedInput(raw);
    gravity.accelerationMps2[1] = 0; gravity.densityKgM3 = 1;
    expect(input.gravity).toEqual({ accelerationMps2: [1.25, -9.81, 2.5], densityKgM3: 7800 });
    expect(input.loadedFaces).toEqual([]);
    expect(input.fixedFaces).toEqual(['fixed-origin']);
    expect(readSolidCadSavedInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(() => readSolidCadSavedInput({ ...base, loadedFaces: [] })).toThrow();
    expect(() => readSolidCadSavedInput({ ...base, fixedFaces: [], gravity: input.gravity })).toThrow();
  });
  it.each([
    ['missing', undefined], ['null', null], ['zero density', { accelerationMps2: [0, -9.81, 0], densityKgM3: 0 }],
    ['negative density', { accelerationMps2: [0, -9.81, 0], densityKgM3: -1 }],
    ['infinite density', { accelerationMps2: [0, -9.81, 0], densityKgM3: Infinity }],
    ['NaN acceleration', { accelerationMps2: [0, Number.NaN, 0], densityKgM3: 7800 }],
    ['short acceleration', { accelerationMps2: [0, -9.81], densityKgM3: 7800 }],
    ['sparse acceleration', { accelerationMps2: new Array<number>(3), densityKgM3: 7800 }],
    ['unknown gravity field', { accelerationMps2: [0, -9.81, 0], densityKgM3: 7800, inferred: true }],
    ['extra acceleration property', { accelerationMps2: Object.assign([0, -9.81, 0], { extra: 0 }), densityKgM3: 7800 }],
    ['symbol gravity field', { accelerationMps2: [0, -9.81, 0], densityKgM3: 7800, [Symbol('extra')]: 0 }],
  ])('refuses %s instead of accepting an empty loaded-face selection', (_label, gravity) => {
    expect(() => readSolidCadSavedInput({ ...saved(), loadedFaces: [], gravity })).toThrow();
  });
});

describe('persistent per-face CAD supports', () => {
  const support = { face: 'left-origin', fixed: [true, false, false], prescribedMm: [0.125, 0, 0] };
  it('owns face keys, flags and nonzero millimetre values without filling omitted values', () => {
    const rows = [structuredClone(support), { face: 'front-origin', fixed: [false, true, false] }];
    const input = readSolidCadSavedInput({ ...saved(), fixedFaces: [], supports: rows });
    rows[0].face = 'changed'; rows[0].fixed[0] = false;
    if ('prescribedMm' in rows[0]) rows[0].prescribedMm[0] = 99;
    expect(input.fixedFaces).toEqual([]);
    expect(input.supports).toEqual([support, { face: 'front-origin', fixed: [false, true, false] }]);
    expect(Object.hasOwn(input.supports?.[1] ?? {}, 'prescribedMm')).toBe(false);
    expect(readSolidCadSavedInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });
  it('bounds the support collection at 2048 and preserves distinct legacy clamps', () => {
    const supports = Array.from({ length: 2048 }, (_, index) => ({ face: `support-${index}`, fixed: [true, true, true] }));
    expect(readSolidCadSavedInput({ ...saved(), supports }).supports).toHaveLength(2048);
    expect(() => readSolidCadSavedInput({ ...saved(), supports: [...supports, { ...support }] })).toThrow();
    expect(() => readSolidCadSavedInput({ ...saved(), supports: [{ ...support, face: 'fixed-origin' }] })).toThrow();
    expect(() => readSolidCadSavedInput({ ...saved(), support })).toThrow();
  });
  it.each([
    ['missing', undefined], ['null', null], ['empty', []], ['sparse rows', new Array<unknown>(1)],
    ['duplicate face', [support, { ...support }]], ['numeric face', [{ ...support, face: 5 }]],
    ['empty face', [{ ...support, face: '' }]], ['null row', [null]],
    ['all free', [{ ...support, fixed: [false, false, false] }]],
    ['nonboolean flags', [{ ...support, fixed: [1, false, false] }]],
    ['short flags', [{ ...support, fixed: [true, false] }]],
    ['sparse flags', [{ ...support, fixed: new Array<boolean>(3) }]],
    ['extra flag property', [{ ...support, fixed: Object.assign([true, false, false], { extra: true }) }]],
    ['free-axis displacement', [{ ...support, prescribedMm: [0.125, 0.5, 0] }]],
    ['infinite displacement', [{ ...support, prescribedMm: [Infinity, 0, 0] }]],
    ['short displacement', [{ ...support, prescribedMm: [0.125, 0] }]],
    ['sparse displacement', [{ ...support, prescribedMm: new Array<number>(3) }]],
    ['explicit missing displacement', [{ ...support, prescribedMm: undefined }]],
    ['unknown support field', [{ ...support, node: 0 }]],
    ['symbol support field', [{ ...support, [Symbol('extra')]: 0 }]],
    ['extra row property', Object.assign([support], { extra: true })],
  ])('rejects %s before allowing empty legacy clamps', (_label, supports) => {
    expect(() => readSolidCadSavedInput({ ...saved(), fixedFaces: [], supports })).toThrow();
  });
});
