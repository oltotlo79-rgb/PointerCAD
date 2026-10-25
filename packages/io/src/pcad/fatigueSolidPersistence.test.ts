import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { fatigueSolidInputMatches, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const options = { savedAt: '2026-10-22T00:00:00.000Z' };
function saved(documentId: string) {
  return { schema: 'pointercad-fatigue-solid-saved/1', id: 'fatigue', source: { documentId, revision: 9, meshKey: 'mesh:9' },
    inputSha256: 'c'.repeat(64), elementIndex: 0, historyId: 'tet0', loadFactors: [0, 1, -0.7, 0.0015],
    sequence: 'repeated-periodic', repeats: 10, reference: 'Explicit load sequence',
    curve: { id: 'synthetic', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
      referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null,
      source: { kind: 'user-supplied', reference: 'Synthetic test only', condition: 'No material inference' } } };
}
const attachment = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue-solid-proportional', definition }] });

describe('solid proportional fatigue definition in actual PCAD boundaries', () => {
  it('roundtrips exact selected source/hash/factors with stable bytes and no derived stress/result', () => {
    const part = createEmptyPartDocument(), definition = saved(part.id);
    const text = serializeDocument(withBeamAnalysisInputs(part, attachment(definition)), options);
    const restored = parseDocument(text);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(attachment(definition));
    expect(serializeDocument(restored.document, options)).toBe(text);
    expect(JSON.stringify(restored.document.beamAnalysisInputs)).not.toMatch(/"(?:stressMPa|result|damage|cycles|life|tensorInput)"/u);
    const row = restored.document.beamAnalysisInputs?.analyses[0];
    if (row?.kind !== 'fatigue-solid-proportional') throw new Error('Missing restored solid fatigue');
    expect(fatigueSolidInputMatches(row.definition, { source: row.definition.source,
      inputSha256: row.definition.inputSha256, elementCount: 1 })).toBe(true);
    expect(fatigueSolidInputMatches(row.definition, { source: { ...row.definition.source, revision: 10 },
      inputSha256: row.definition.inputSha256, elementCount: 1 })).toBe(false);
  });
  it('preserves actual Undo/Redo input definitions and an unchanged legacy document', () => {
    const part = createEmptyPartDocument(), legacy = serializeDocument(part, options);
    const first = withBeamAnalysisInputs(part, attachment(saved(part.id)));
    const second = withBeamAnalysisInputs(first, attachment({ ...saved(part.id), loadFactors: [0, -1, 1] }));
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    expect(undo(stack).present.beamAnalysisInputs).toEqual(first.beamAnalysisInputs);
    const restored = parseDocument(serializeDocument(redo(undo(stack)).present, options));
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(second.beamAnalysisInputs);
    const old = parseDocument(legacy);
    if (!old.ok) throw new Error(old.error.message);
    expect(serializeDocument(old.document, options)).toBe(legacy);
  });
  it('rejects assembly read/write and injected derived output through the real codec', () => {
    const assembly = beamCadFixture().document;
    expect(() => writeAssemblyDocument(withBeamAnalysisInputs(assembly, attachment(saved(assembly.id))), options)).toThrow();
    const envelope: unknown = JSON.parse(writeAssemblyDocument(assembly, options));
    if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected actual assembly envelope');
    expect(readAssemblyDocument(JSON.stringify({ ...envelope, document: { ...envelope.document,
      beamAnalysisInputs: attachment(saved(assembly.id)) } })).ok).toBe(false);
    const part = createEmptyPartDocument();
    expect(() => serializeDocument(withBeamAnalysisInputs(part, attachment({ ...saved(part.id), result: {} })), options)).toThrow();
  });
});
