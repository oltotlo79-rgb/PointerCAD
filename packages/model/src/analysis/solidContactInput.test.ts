import { describe, expect, it } from 'vitest';
import { InputIssue } from './analysisValidation.js';
import { readSolidContactInput, SOLID_CONTACT_ID, SOLID_CONTACT_LIMITS, SOLID_CONTACT_METHODS,
  SOLID_CONTACT_SCHEMA, validateSolidContactInput, type SolidContactPair, type SolidContactSavedInput } from './solidContactInput.js';
import { solidCadFaceKey } from './solidCadInput.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';

function faceKey(role: 'top' | 'bottom'): string {
  const reference: SubShapeRef = { bodyFeatureId: 'box', index: 0,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 6, position: [0, 0, 0], axis: [0, 0, 1], radius: null },
    origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box', role } } };
  return solidCadFaceKey(reference);
}
function pair(patch: Partial<SolidContactPair> = {}): SolidContactPair {
  return { id: 'pair-1', masterFace: faceKey('top'), slaveFace: faceKey('bottom'), normal: { kind: 'master-outward' },
    gapMm: 0, frictionCoefficient: null, frictionSourceId: null, method: 'surface-to-surface', ...patch };
}
function saved(contacts: readonly SolidContactPair[] = [pair()]): SolidContactSavedInput {
  return { schema: SOLID_CONTACT_SCHEMA, id: SOLID_CONTACT_ID, source: { documentId: 'part' }, contacts };
}
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
function issue(value: unknown, code: string, path: string): void {
  const before = bytes(value);
  let failure: unknown;
  try { readSolidContactInput(value, 'attachment'); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(InputIssue);
  if (!(failure instanceof InputIssue)) throw new Error('Expected the shared InputIssue');
  expect(failure.code).toBe(code);
  expect(failure.path).toBe(path);
  expect(failure.message.length).toBeGreaterThan(0);
  expect(bytes(value)).toEqual(before);
}

describe('solid contact saved definitions', () => {
  it.each([
    ['frictionless, zero gap', pair()],
    ['sourced friction', pair({ frictionCoefficient: 0.3, frictionSourceId: 'test-report:steel:dry' })],
    ['explicit direction, zero gap', pair({ normal: { kind: 'explicit', vector: [0, -1, 0] } })],
    ['positive gap', pair({ gapMm: 2.5 })],
    ['sourced zero friction', pair({ frictionCoefficient: 0, frictionSourceId: 'measurement:zero' })],
    ['upper bounds', pair({ frictionCoefficient: 1, frictionSourceId: 'measurement:one', gapMm: SOLID_CONTACT_LIMITS.gapMm })],
  ] as const)('reads %s and round trips identical UTF-8 JSON bytes', (_name, contact) => {
    const value = saved([contact]), json = JSON.stringify(value);
    const raw: unknown = JSON.parse(json);
    const read = readSolidContactInput(raw);
    expect(read).toEqual(value);
    expect(bytes(read)).toEqual(new TextEncoder().encode(json));
    expect(bytes(raw)).toEqual(bytes(value));
    expect(read).not.toBe(raw);
    expect(read.contacts[0]).not.toBe(contact);
  });

  it('preserves a different property order at every object level', () => {
    const contact = pair({ normal: { kind: 'explicit', vector: [0.6, 0.8, 0] } });
    const raw = { contacts: [{ method: contact.method, frictionSourceId: null, frictionCoefficient: null, gapMm: 0,
      normal: { vector: [0.6, 0.8, 0], kind: 'explicit' }, slaveFace: contact.slaveFace,
      masterFace: contact.masterFace, id: contact.id }], source: { documentId: '日本語部品' }, id: SOLID_CONTACT_ID, schema: SOLID_CONTACT_SCHEMA };
    const json = JSON.stringify(raw), decoded: unknown = JSON.parse(json);
    expect(bytes(readSolidContactInput(decoded))).toEqual(new TextEncoder().encode(json));
  });

  it('owns nested source, arrays and explicit vectors without normalizing them', () => {
    const value = { ...saved(), contacts: [{ ...pair(), normal: { kind: 'explicit', vector: [1 + 1e-10, 0, 0] } }] };
    const read = readSolidContactInput(value);
    value.source = { documentId: 'changed' }; value.contacts[0].normal.vector[0] = 0;
    value.contacts.length = 0;
    expect(read.source.documentId).toBe('part');
    expect(read.contacts[0].normal).toEqual({ kind: 'explicit', vector: [1 + 1e-10, 0, 0] });
  });

  it('accepts zero and 64 explicit pairs and rejects 65', () => {
    expect(readSolidContactInput(saved([])).contacts).toEqual([]);
    const contacts = Array.from({ length: 64 }, (_, index) => pair({ id: `pair-${index}`, masterFace: `master-${index}`, slaveFace: `slave-${index}` }));
    expect(readSolidContactInput(saved(contacts)).contacts).toHaveLength(64);
    issue(saved([...contacts, pair()]), 'size', 'attachment.contacts');
    expect(SOLID_CONTACT_LIMITS.pairs).toBe(64);
    expect(SOLID_CONTACT_METHODS).toEqual(['surface-to-surface']);
  });

  it.each([
    ['same face', { slaveFace: faceKey('top') }, 'contact-self', ''],
    ['negative gap', { gapMm: -1 }, 'contact-gap', '.gapMm'],
    ['oversized gap', { gapMm: 1000000.01 }, 'contact-gap', '.gapMm'],
    ['missing source', { frictionCoefficient: 0.2, frictionSourceId: null }, 'contact-friction-source', '.frictionSourceId'],
    ['empty source', { frictionCoefficient: 0.2, frictionSourceId: '' }, 'contact-friction-source', '.frictionSourceId'],
    ['unsourced zero', { frictionCoefficient: 0 }, 'contact-friction-source', '.frictionSourceId'],
    ['negative coefficient', { frictionCoefficient: -0.01, frictionSourceId: 'test' }, 'contact-friction', '.frictionCoefficient'],
    ['large coefficient', { frictionCoefficient: 1.01, frictionSourceId: 'test' }, 'contact-friction', '.frictionCoefficient'],
    ['unknown method', { method: 'node-to-surface' }, 'contact-method', '.method'],
    ['zero direction', { normal: { kind: 'explicit', vector: [0, 0, 0] } }, 'contact-normal', '.normal.vector'],
    ['nonunit direction', { normal: { kind: 'explicit', vector: [0, 0, 2] } }, 'contact-normal', '.normal.vector'],
    ['unknown direction', { normal: { kind: 'slave-outward' } }, 'contact-normal', '.normal.kind'],
    ['short direction', { normal: { kind: 'explicit', vector: [0, 1] } }, 'contact-normal', '.normal.vector'],
    ['long direction', { normal: { kind: 'explicit', vector: [0, 1, 0, 0] } }, 'size', '.normal.vector'],
    ['frictionless with source', { frictionSourceId: 'unused' }, 'contact-friction-source', '.frictionSourceId'],
    ['empty face', { masterFace: '' }, 'text', '.masterFace'],
    ['numeric face', { masterFace: 3 }, 'text', '.masterFace'],
    ['long id', { id: 'a'.repeat(65) }, 'text', '.id'],
    ['long face key', { masterFace: 'a'.repeat(16385) }, 'text', '.masterFace'],
    ['long source', { frictionCoefficient: 0.2, frictionSourceId: 'a'.repeat(257) }, 'text', '.frictionSourceId'],
    ['whitespace source', { frictionCoefficient: 0.2, frictionSourceId: '   ' }, 'text', '.frictionSourceId'],
    ['extra field', { result: 2 }, 'shape', ''],
  ] as const)('rejects %s with code, path, message and no mutation', (_name, patch, code, suffix) => {
    issue({ ...saved(), contacts: [{ ...pair(), ...patch }] }, String(code), `attachment.contacts[0]${String(suffix)}`);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite numbers %s', value => {
    issue(saved([pair({ gapMm: value })]), 'number', 'attachment.contacts[0].gapMm');
    issue(saved([pair({ frictionCoefficient: value })]), 'number', 'attachment.contacts[0].frictionCoefficient');
    issue(saved([pair({ normal: { kind: 'explicit', vector: [value, 0, 1] } })]), 'number', 'attachment.contacts[0].normal.vector[0]');
  });

  it.each([false, true])('rejects duplicate face pairs (reversed=%s)', reversed => {
    const original = pair(), duplicate = pair({ id: 'second', gapMm: 10,
      masterFace: reversed ? original.slaveFace : original.masterFace,
      slaveFace: reversed ? original.masterFace : original.slaveFace });
    issue(saved([original, duplicate]), 'contact-duplicate', 'attachment.contacts[1]');
  });
  it('rejects duplicate ids independently of face pairs', () => {
    issue(saved([pair(), pair({ masterFace: 'other-master', slaveFace: 'other-slave' })]), 'duplicate-id', 'attachment.contacts[1].id');
  });

  it('rejects missing fields, versions, derived state and sparse arrays', () => {
    issue({ ...saved(), schema: 'pointercad-solid-contact-input/2' }, 'unsupported-schema', 'attachment');
    issue({ ...saved(), id: 'mate' }, 'unsupported-schema', 'attachment');
    issue({ ...saved(), mesh: [] }, 'shape', 'attachment');
    issue({ ...saved(), mates: [] }, 'shape', 'attachment');
    issue({ ...saved(), source: {} }, 'shape', 'attachment.source');
    const missing = { ...pair() };
    Reflect.deleteProperty(missing, 'frictionSourceId');
    issue({ ...saved(), contacts: [missing] }, 'shape', 'attachment.contacts[0]');
    issue({ ...saved(), contacts: new Array<unknown>(1) }, 'shape', 'attachment.contacts');
    issue({ ...saved(), contacts: Object.assign([pair()], { extra: 1 }) }, 'shape', 'attachment.contacts');
    issue({ ...saved(), contacts: [{ ...pair(), normal: { kind: 'explicit', vector: new Array<unknown>(3) } }] },
      'shape', 'attachment.contacts[0].normal.vector');
  });

  it('rejects accessors, hidden and symbol properties without executing them', () => {
    let calls = 0;
    const getter = { ...saved() };
    Object.defineProperty(getter, 'contacts', { enumerable: true, get: () => { calls++; return []; } });
    expect(() => readSolidContactInput(getter)).toThrow(InputIssue);
    expect(calls).toBe(0);
    const symbol = Object.assign(saved(), { [Symbol('hidden')]: 1 });
    expect(() => readSolidContactInput(symbol)).toThrow(InputIssue);
    const hidden = Object.defineProperty(saved(), 'extra', { value: 1 });
    expect(() => readSolidContactInput(hidden)).toThrow(InputIssue);
    const unknown: unknown = saved();
    validateSolidContactInput(unknown);
    expect(unknown.schema).toBe(SOLID_CONTACT_SCHEMA);
  });
});
