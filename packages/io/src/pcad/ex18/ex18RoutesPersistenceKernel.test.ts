import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createUndoStack, pushUndo, undo, redo, contentHashOf, replaceSolid, PART_SCHEMA_VERSION, type PartDocument } from '@pointercad/model';
import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import { emptyPcadAttachments, readPcadFile, writePcadFile } from '../pcadFile.js';
import { W08_CASES, W08_TIMEOUT, W08_SAVED_AT, W08_CHANGED, W08_DIRECT_CHANGED,
  EX18_ORACLE_EXPECTATIONS, w08Build, w08Session, w08Compute, w08Expect } from './ex18PersistenceSupport.js';

beforeAll(loadOcctForNode, W08_TIMEOUT);

describe('EX18 W08 twelve authored routes, real PCAD and independent cold B-reps', () => {
  it('existing version-17 fingerprint-only compatibility reopens a real expression bracket without inventing an origin', async () => {
    const original = w08Session(), cold = w08Session();
    try {
      const built = await w08Build('A', 'expression', original);
      const hole = built.part.solids.find(feature => feature.id === built.finalId);
      if (hole?.kind !== 'hole') throw new Error('W08 compatibility hole missing');
      // The legacy contract in documentJson.test.ts uses schemaVersion 17 and no semantic origin.
      const face = { bodyFeatureId: hole.face.bodyFeatureId, index: hole.face.index, fingerprint: hole.face.fingerprint };
      const legacy = { ...replaceSolid(built.part, hole.id, { ...hole, face }), schemaVersion: 17 };
      const read = readPcadFile(writePcadFile(legacy, { savedAt: W08_SAVED_AT }));
      if (!read.ok) throw new Error(JSON.stringify(read.error));
      expect(read.document).toEqual({ ...legacy, schemaVersion: PART_SCHEMA_VERSION });
      const savedHole = read.document.solids.find(feature => feature.id === built.finalId);
      if (savedHole?.kind !== 'hole') throw new Error('W08 migrated hole missing');
      expect(savedHole.face).toEqual(face); expect('origin' in savedHole.face).toBe(false);
      expect(savedHole.diameter.source).toBe('2*3');
      const result = await w08Compute(read.document, built.finalId, cold);
      expect(result.result.cacheHits).toBe(0);
      w08Expect('A/version-17 fingerprint-only', result, EX18_ORACLE_EXPECTATIONS.A);
      const current = readPcadFile(writePcadFile(read.document, { savedAt: W08_SAVED_AT }));
      if (!current.ok) throw new Error(JSON.stringify(current.error));
      expect(current.document).toEqual(read.document);
    } finally { cold.dispose(); original.dispose(); }
  }, W08_TIMEOUT);

  it.each(W08_CASES)('$shape / $route retains inputs, references and attachments across reopen/edit/history', async spec => {
    const original = w08Session();
    try {
      const built = await w08Build(spec.shape, spec.route, original);
      const attachments = { ...emptyPcadAttachments(), shapes: built.shapes,
        shapeDigests: new Map([...built.shapes].map(([ref, value]) => [ref, createHash('sha256').update(value).digest('hex')])) };
      const snapshot = structuredClone(built.part), originalHash = await contentHashOf(snapshot);
      const bytes = writePcadFile(built.part, { savedAt: W08_SAVED_AT, attachments });
      const reopened = readPcadFile(bytes);
      if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
      expect(reopened.document).not.toBe(built.part);
      expect(reopened.document).toEqual(snapshot);
      expect(await contentHashOf(reopened.document)).toBe(originalHash);
      expect(reopened.attachments).toEqual(attachments);
      expect(writePcadFile(reopened.document, { savedAt: W08_SAVED_AT, attachments: reopened.attachments })).toEqual(bytes);
      if (spec.route === 'direct STEP') {
        expect(reopened.attachments.shapes.size).toBe(1);
        const imported = reopened.document.solids.find(entry => entry.kind === 'importedSolid');
        if (imported?.kind !== 'importedSolid') throw new Error('W08 missing imported feature');
        expect(reopened.attachments.shapes.get(imported.shapeRef)).toEqual(built.shapes.get(imported.shapeRef));
        expect(imported.source.fileName).toBe(`direct-seed-${spec.shape}.step`);
      } else expect(reopened.attachments.shapes.size).toBe(0);
      const coldCheck = async (part: PartDocument, changed: boolean): Promise<void> => {
        const cold = w08Session();
        try {
          expect(cold.bridge).not.toBe(original.bridge); expect(cold.cache).not.toBe(original.cache);
          const actual = await w08Compute(part, built.finalId, cold, reopened.attachments.shapes);
          expect(actual.result.cacheHits).toBe(0);
          w08Expect(`${spec.shape}/${spec.route}/${changed ? 'edited' : 'original'}`, actual,
            changed ? (spec.route === 'direct STEP' ? W08_DIRECT_CHANGED : W08_CHANGED)[spec.shape] : EX18_ORACLE_EXPECTATIONS[spec.shape]);
        } finally { cold.dispose(); }
      };
      await coldCheck(reopened.document, false);
      const edited = built.edit(reopened.document);
      expect(edited).not.toEqual(reopened.document);
      expect(edited.solids.map(entry => entry.id)).toEqual(reopened.document.solids.map(entry => entry.id));
      expect(edited.sketches.map(entry => entry.features.map(feature => feature.id)))
        .toEqual(reopened.document.sketches.map(entry => entry.features.map(feature => feature.id)));
      expect(await contentHashOf(edited)).not.toBe(originalHash);
      const editedBytes = writePcadFile(edited, { savedAt: W08_SAVED_AT, attachments: reopened.attachments });
      const editedRead = readPcadFile(editedBytes);
      if (!editedRead.ok) throw new Error(JSON.stringify(editedRead.error));
      expect(editedRead.document).toEqual(edited); expect(editedRead.attachments).toEqual(attachments);
      await coldCheck(editedRead.document, true);
      const stack = pushUndo(createUndoStack(reopened.document), editedRead.document);
      expect(stack.past).toHaveLength(1); expect(stack.future).toHaveLength(0);
      const back = undo(stack);
      expect(back.present).toEqual(snapshot); expect(back.past).toHaveLength(0); expect(back.future).toHaveLength(1);
      await coldCheck(back.present, false);
      const again = redo(back);
      expect(again.present).toEqual(edited); expect(again.past).toHaveLength(1); expect(again.future).toHaveLength(0);
      await coldCheck(again.present, true);
      expect(built.part).toEqual(snapshot); expect(await contentHashOf(built.part)).toBe(originalHash);
    } finally { original.dispose(); }
  }, W08_TIMEOUT);
});
