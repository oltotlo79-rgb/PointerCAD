import {
  addComponent, createAssemblyDocument, createComponentFor, createStandardPartSource,
  type AssemblyDocument, type BoltedJointRecord, type SubShapeRef,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';

/*
 * Persistence of flat bolted-joint edit records (EX-06): the record round-trips exactly, an empty list is not written
 * (files without records keep their exact bytes), an old file without the field reads as "no record", and records
 * that name missing, non-standard or shared parts are refused instead of being loaded half-valid.
 */

const SAVED_AT = '2026-10-19T00:00:00.000Z';

function face(bodyFeatureId: string, index: number, z: number): SubShapeRef {
  return { bodyFeatureId, index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 400, position: [20, 10, z],
    axis: [0, 0, 1], radius: null } };
}

function base(): AssemblyDocument {
  let document = createAssemblyDocument('締結の記録');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plate-a' }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plate-b' }));
  document = addComponent(document, createComponentFor(document, createStandardPartSource('plainWasher', 'M10')));
  return addComponent(document, createComponentFor(document, createStandardPartSource('hexBolt', 'M10',
    { length: '35', dimensionSeries: 'annexJA', threadSeries: 'coarse' })));
}

const RECORD: BoltedJointRecord = {
  id: 'bolted-joint-1',
  first: { componentId: 'component-1', holeFeatureId: 'hole-1', holeFace: face('hole-1', 1, -5), matingFace: face('hole-1', 2, 0) },
  second: { componentId: 'component-2', holeFeatureId: 'hole-2', holeFace: face('hole-2', 1, 5), matingFace: face('hole-2', 2, 0) },
  choices: { dimensionSeries: 'annexJA', explicitBolt: { nominal: 'M10', threadSeries: 'coarse' }, minimumProtrusion: 0,
    headWashers: ['plainWasher'], nutWashers: [] },
  componentIds: ['component-3', 'component-4'],
};

function read(text: string): AssemblyDocument {
  const result = readAssemblyDocument(text);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.document;
}

/** Edit one field of the saved JSON (as a hand-edited or corrupted file would). */
function tampered(document: AssemblyDocument, edit: (records: Record<string, unknown>[]) => void): string {
  const envelope = JSON.parse(writeAssemblyDocument(document, { savedAt: SAVED_AT })) as { document: { boltedJoints: Record<string, unknown>[] } };
  edit(envelope.document.boltedJoints);
  return JSON.stringify(envelope);
}

describe('EX-06 bolted-joint records in .pcada', () => {
  it('a record round-trips exactly and the second write is byte-identical', () => {
    const document = { ...base(), boltedJoints: [RECORD] };
    const text = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    const reopened = read(text);
    expect(reopened.boltedJoints).toEqual([RECORD]);
    expect(writeAssemblyDocument(reopened, { savedAt: SAVED_AT })).toBe(text);
  });

  it('an empty list is not written, and a file without the field reads as no record', () => {
    const plain = writeAssemblyDocument(base(), { savedAt: SAVED_AT });
    expect(writeAssemblyDocument({ ...base(), boltedJoints: [] }, { savedAt: SAVED_AT })).toBe(plain);
    expect(plain).not.toContain('boltedJoints');
    expect(read(plain).boltedJoints).toBeUndefined();
  });

  it('refuses: a plate as hardware, a missing part, hardware shared by two records, no hardware, the same plate twice, an unknown washer, a negative length', () => {
    const document = { ...base(), boltedJoints: [RECORD] };
    const choicesOf = (records: Record<string, unknown>[]) => records[0]?.['choices'] as Record<string, unknown> | undefined;
    const cases: ((records: Record<string, unknown>[]) => void)[] = [
      (records) => { if (records[0] !== undefined) records[0]['componentIds'] = ['component-1']; },
      (records) => { if (records[0] !== undefined) records[0]['componentIds'] = ['component-9']; },
      (records) => { records.push({ ...records[0], id: 'bolted-joint-2' }); },
      (records) => { if (records[0] !== undefined) records[0]['componentIds'] = []; },
      (records) => { if (records[0] !== undefined) records[0]['second'] = records[0]['first']; },
      (records) => { const choices = choicesOf(records); if (choices !== undefined) choices['headWashers'] = ['lockWasher']; },
      (records) => { const choices = choicesOf(records); if (choices !== undefined) choices['engagement'] = -1; },
    ];
    // The untouched record is accepted, so each refusal comes from its one edit.
    expect(readAssemblyDocument(tampered(document, () => undefined)).ok).toBe(true);
    for (const edit of cases) expect(readAssemblyDocument(tampered(document, edit)).ok).toBe(false);
  });

  it('writing a record whose hardware is not a standard part throws instead of saving it', () => {
    const broken = { ...base(), boltedJoints: [{ ...RECORD, componentIds: ['component-2'] }] };
    expect(() => writeAssemblyDocument(broken, { savedAt: SAVED_AT })).toThrow(RangeError);
  });
});
