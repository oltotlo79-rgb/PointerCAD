import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { InputIssue } from './analysisValidation.js';
import { readBeamAnalysisInputs } from './beamInputs.js';
import * as analysisEntry from './index.js';
import { createShellCadSavedInput, readShellCadInput, SHELL_CAD_LIMITS, SHELL_CAD_SCHEMA,
  type ShellCadSavedInput } from './shellCadInput.js';
import { solidCadFaceKey } from './solidCadInput.js';

const FIELDS = ['schema', 'id', 'source', 'bodyFeatureId', 'midsurfaceFaces', 'thicknessMm', 'offsetMm'];
function face(role: 'top' | 'bottom' = 'top', index = 0, bodyFeatureId = 'sheet'): SubShapeRef {
  return { bodyFeatureId, index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1200,
    position: [20, 15, 0], axis: [0, 0, 1], radius: null },
  origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'sheet', role } } };
}
function saved(): Record<string, unknown> & { midsurfaceFaces: string[] } {
  return { schema: 'pointercad-shell-cad-input/1', id: 'shell-cad', source: { documentId: 'part' }, bodyFeatureId: 'sheet',
    midsurfaceFaces: [solidCadFaceKey(face())], thicknessMm: 2, offsetMm: 0 };
}
/** The thrown InputIssue (any other error, or no error, fails the test). */
function issue(read: () => unknown): InputIssue {
  try {
    read();
  } catch (error) {
    if (error instanceof InputIssue) return error;
    throw error;
  }
  throw new Error('Expected an InputIssue');
}
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

describe('saved explicit shell midsurface, thickness and offset', () => {
  it('stores exactly the three inputs and reads them back unchanged: values, key order and bytes', () => {
    const created = createShellCadSavedInput({ documentId: 'part', bodyFeatureId: 'sheet', faces: [face()],
      thicknessMm: 2, offsetMm: -1 });
    expect(created).toEqual({ schema: SHELL_CAD_SCHEMA, id: 'shell-cad', source: { documentId: 'part' }, bodyFeatureId: 'sheet',
      midsurfaceFaces: [solidCadFaceKey(face())], thicknessMm: 2, offsetMm: -1 });
    expect(Object.keys(created)).toEqual(FIELDS);
    const json = JSON.stringify(created), read = readShellCadInput(JSON.parse(json));
    expect(read).toEqual(created);
    expect(JSON.stringify(read)).toBe(json);
    expect(Object.keys(read)).toEqual(FIELDS);
    // Nothing derived is saved: no mesh, normal, runtime index, material, support, load or result.
    expect(json).not.toMatch(/normal|index|mesh|material|young|result|triangle/i);
  });

  it('defaults only the offset to 0 when an input is created and keeps a signed offset exactly as given', () => {
    const base = { documentId: 'part', bodyFeatureId: 'sheet', faces: [face()], thicknessMm: 2.5 };
    expect(createShellCadSavedInput(base).offsetMm).toBe(0);
    for (const offsetMm of [-1.25, 0, 1e-9, 3.75, -1e6]) {
      const input = createShellCadSavedInput({ ...base, offsetMm });
      expect(input.offsetMm).toBe(offsetMm);
      expect(input.thicknessMm).toBe(2.5);
      expect(readShellCadInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
    }
    // The reader never supplies the default: a saved value without offsetMm is refused, not completed.
    const missing: Record<string, unknown> = saved();
    Reflect.deleteProperty(missing, 'offsetMm');
    expect(issue(() => readShellCadInput(missing)).code).toBe('shape');
  });

  it('keys the semantic face origin, not the ordinal, fingerprint or orientation, and keeps the selection order', () => {
    const top = face();
    const moved: SubShapeRef = { ...face('top', 7), fingerprint: { kind: 'face', surfaceKind: 'plane', area: 9,
      position: [1, 2, 3], axis: [0, 0, -1], radius: null } };
    expect(solidCadFaceKey(moved)).toBe(solidCadFaceKey(top));
    const both = createShellCadSavedInput({ documentId: 'part', bodyFeatureId: 'sheet', faces: [face('bottom', 1), top],
      thicknessMm: 2 });
    expect(both.midsurfaceFaces).toEqual([solidCadFaceKey(face('bottom', 1)), solidCadFaceKey(top)]);
    expect(new Set(both.midsurfaceFaces).size).toBe(2);
    expect(issue(() => createShellCadSavedInput({ documentId: 'part', bodyFeatureId: 'sheet', faces: [top, moved],
      thicknessMm: 2 })).code).toBe('invalid-input');
  });

  it('owns its array, never changes the value it reads and reads a deeply frozen value', () => {
    const raw = saved(), before = JSON.stringify(raw), input = readShellCadInput(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(input.midsurfaceFaces).not.toBe(raw.midsurfaceFaces);
    expect(input.source).not.toBe(raw.source);
    raw.midsurfaceFaces[0] = 'changed'; raw.thicknessMm = 9;
    expect(input.midsurfaceFaces).toEqual([solidCadFaceKey(face())]);
    expect(input.thicknessMm).toBe(2);
    expect(readShellCadInput(frozen(saved()))).toEqual(readShellCadInput(saved()));
  });

  it('is exported from the pure analysis entry with the reader and the schema', () => {
    expect(analysisEntry.readShellCadInput).toBe(readShellCadInput);
    expect(analysisEntry.createShellCadSavedInput).toBe(createShellCadSavedInput);
    expect(analysisEntry.SHELL_CAD_SCHEMA).toBe('pointercad-shell-cad-input/1');
    expect(analysisEntry.SHELL_CAD_LIMITS).toEqual({ maximumFaces: 2048, maximumKeyLength: 16384 });
    const typed: ShellCadSavedInput = readShellCadInput(saved());
    expect(typed.id).toBe('shell-cad');
  });
});

describe('refusals with reasons; the refused value is never rewritten', () => {
  // Explicit labels: %j would print NaN, Infinity and -Infinity all as null and give identical test titles.
  it.each([
    ['thickness 0', { thicknessMm: 0 }, 'invalid-input'], ['thickness -0', { thicknessMm: -0 }, 'invalid-input'],
    ['thickness -2', { thicknessMm: -2 }, 'invalid-input'], ['thickness NaN', { thicknessMm: Number.NaN }, 'number'],
    ['thickness +Infinity', { thicknessMm: Infinity }, 'number'], ['thickness as a string', { thicknessMm: '2' }, 'number'],
    ['thickness null', { thicknessMm: null }, 'number'], ['thickness beyond 1e30', { thicknessMm: 1e31 }, 'number'],
    ['offset NaN', { offsetMm: Number.NaN }, 'number'], ['offset +Infinity', { offsetMm: Infinity }, 'number'],
    ['offset -Infinity', { offsetMm: -Infinity }, 'number'], ['offset as a string', { offsetMm: '0' }, 'number'],
    ['offset null', { offsetMm: null }, 'number'], ['offset beyond 1e30', { offsetMm: -1e31 }, 'number'],
  ] as const)('refuses a non-physical number: %s', (_label, patch, code) => {
    const value = { ...saved(), ...patch }, before = JSON.stringify(value);
    const refused = issue(() => readShellCadInput(value));
    expect(refused.code).toBe(code);
    expect(refused.path.startsWith('shell-cad')).toBe(true);
    expect(refused.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(value)).toBe(before);
  });

  const sparse = new Array<string>(1);
  const withProperty = Object.assign([solidCadFaceKey(face())], { note: 'extra' });
  it.each([
    ['no faces', { midsurfaceFaces: [] }, 'invalid-input'], ['a repeated face', { midsurfaceFaces: ['a', 'a'] }, 'invalid-input'],
    ['a sparse face array', { midsurfaceFaces: sparse }, 'invalid-input'],
    ['a face array with an extra property', { midsurfaceFaces: withProperty }, 'invalid-input'],
    ['an empty key', { midsurfaceFaces: ['a', ''] }, 'text'], ['a key with outer spaces', { midsurfaceFaces: [' a'] }, 'text'],
    ['a key that is not text', { midsurfaceFaces: [7] }, 'text'], ['one key instead of a list', { midsurfaceFaces: 'a' }, 'size'],
    ['too many faces', { midsurfaceFaces: Array.from({ length: SHELL_CAD_LIMITS.maximumFaces + 1 }, (_, i) => `f${i}`) }, 'size'],
    ['an empty body id', { bodyFeatureId: '' }, 'text'], ['an empty document id', { source: { documentId: '' } }, 'text'],
  ] as const)('refuses a missing or ambiguous midsurface reference: %s', (_label, patch, code) => {
    const value = { ...saved(), ...patch }, before = JSON.stringify(value);
    expect(issue(() => readShellCadInput(value)).code).toBe(code);
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    ['schema 2', { schema: 'pointercad-shell-cad-input/2' }, 'unsupported-schema'],
    ['the solid schema', { schema: 'pointercad-solid-cad-input/1' }, 'unsupported-schema'],
    ['another id', { id: 'solid-cad' }, 'unsupported-schema'],
    ['saved normals', { normals: [[0, 0, 1]] }, 'shape'], ['saved results', { results: [] }, 'shape'],
    ['a material', { youngMPa: 210000 }, 'shape'], ['a guessed midsurface', { midsurface: 'inferred' }, 'shape'],
    ['an extra source field', { source: { documentId: 'part', revision: 3 } }, 'shape'],
  ] as const)('refuses an unknown version or an unexpected field: %s', (_label, patch, code) => {
    const value = { ...saved(), ...patch }, before = JSON.stringify(value);
    expect(issue(() => readShellCadInput(value)).code).toBe(code);
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each(['midsurfaceFaces', 'thicknessMm', 'offsetMm', 'source', 'bodyFeatureId', 'schema'])('refuses a missing %s', name => {
    const value: Record<string, unknown> = saved();
    Reflect.deleteProperty(value, name);
    const before = JSON.stringify(value);
    expect(issue(() => readShellCadInput(value)).code).toBe('shape');
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([null, [], 'shell', 3])('refuses a value that is not a saved object: %j', value => {
    expect(issue(() => readShellCadInput(value)).code).toBe('shape');
  });

  it('refuses references that cannot be saved when an input is created', () => {
    const base = { documentId: 'part', bodyFeatureId: 'sheet', thicknessMm: 2 };
    const noOrigin: SubShapeRef = { ...face(), origin: undefined };
    const edge: SubShapeRef = { bodyFeatureId: 'sheet', index: 0, fingerprint: { kind: 'edge', curveKind: 'line', length: 40,
      position: [20, 0, 0], axis: [1, 0, 0], radius: null },
    origin: { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-front' } } };
    for (const faces of [[noOrigin], [face('top', 0, 'other-body')], [edge], []]) {
      const before = JSON.stringify(faces);
      expect(issue(() => createShellCadSavedInput({ ...base, faces })).code).toBe('invalid-input');
      expect(JSON.stringify(faces)).toBe(before);
    }
    for (const thicknessMm of [0, -1]) {
      expect(issue(() => createShellCadSavedInput({ ...base, faces: [face()], thicknessMm })).code).toBe('invalid-input');
    }
    expect(issue(() => createShellCadSavedInput({ ...base, faces: [face()], offsetMm: Number.NaN })).code).toBe('number');
  });
});

describe('saved among the document analysis inputs (readBeamAnalysisInputs)', () => {
  const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
  const solid = { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: 'part' }, bodyFeatureId: 'box',
    fixedFaces: ['fixed'], loadedFaces: ['loaded'], youngMPa: 205000, poisson: 0.3, tractionMPa: [0, 0, -1],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };

  it('round-trips the three inputs beside a solid input: values, references, key order, analysis order and bytes', () => {
    const shell = createShellCadSavedInput({ documentId: 'part', bodyFeatureId: 'sheet', faces: [face('bottom', 1), face()],
      thicknessMm: 1.5, offsetMm: -0.75 });
    const input = attachment({ kind: 'shell-cad', definition: shell }, { kind: 'solid-cad', definition: solid });
    const json = JSON.stringify(input);
    const checked = readBeamAnalysisInputs(JSON.parse(json), 'part');
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(checked.value).toEqual(input);
    expect(JSON.stringify(checked.value)).toBe(json);
    expect(checked.value.analyses.map(row => row.kind)).toEqual(['shell-cad', 'solid-cad']);
    const [first] = checked.value.analyses;
    if (first.kind !== 'shell-cad') throw new Error('Expected the shell input first');
    expect(Object.keys(first.definition)).toEqual(FIELDS);
    expect(first.definition.midsurfaceFaces).toEqual([solidCadFaceKey(face('bottom', 1)), solidCadFaceKey(face())]);
    expect([first.definition.bodyFeatureId, first.definition.thicknessMm, first.definition.offsetMm]).toEqual(['sheet', 1.5, -0.75]);
  });

  it.each([
    ['thickness 0', { thicknessMm: 0 }, 'invalid-input'], ['thickness NaN', { thicknessMm: Number.NaN }, 'number'],
    ['schema 2', { schema: 'pointercad-shell-cad-input/2' }, 'unsupported-schema'],
    ['saved normals', { normals: [[0, 0, 1]] }, 'shape'], ['an empty key', { midsurfaceFaces: ['a', ''] }, 'text'],
    ['one key instead of a list', { midsurfaceFaces: 'a' }, 'size'],
  ] as const)('passes the shell refusal through unchanged: %s', (_label, patch, code) => {
    const definition = { ...saved(), ...patch }, before = JSON.stringify(definition);
    const direct = issue(() => readShellCadInput(definition, 'analyses[0].definition'));
    expect(direct.code).toBe(code);
    expect(readBeamAnalysisInputs(attachment({ kind: 'shell-cad', definition }), 'part'))
      .toEqual({ ok: false, issue: { code, path: direct.path, message: direct.message } });
    expect(JSON.stringify(definition)).toBe(before);
  });

  it('refuses a second shell input of the same document with a reason', () => {
    const definition = readShellCadInput(saved());
    expect(readBeamAnalysisInputs(attachment({ kind: 'shell-cad', definition },
      { kind: 'shell-cad', definition: { ...definition, thicknessMm: 3 } }), 'part'))
      .toEqual({ ok: false, issue: { code: 'duplicate-id', path: 'analyses', message: 'At most one shell CAD configuration per document' } });
  });

  it('refuses a shell input of another document', () => {
    expect(readBeamAnalysisInputs(attachment({ kind: 'shell-cad', definition: { ...saved(), source: { documentId: 'other' } } }), 'part'))
      .toEqual({ ok: false, issue: { code: 'wrong-document', path: 'source.documentId', message: 'Analysis belongs to a different document' } });
  });
});
