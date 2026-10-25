import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type BeamAnalysisInputs, type SolidBucklingCadSavedInput,
  type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-19T00:00:00.000Z' };

function staticInput(ownerId: string): SolidCadSavedInput {
  return { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: ownerId },
    bodyFeatureId: 'box', fixedFaces: ['{"face":1}'], loadedFaces: ['{"face":2}'], youngMPa: 205000, poisson: 0.3,
    tractionMPa: [0, 0, -1], linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
function buckling(ownerId: string, modeCount = 3, reference: SolidCadSavedInput = staticInput(ownerId)): SolidBucklingCadSavedInput {
  return { schema: 'pointercad-solid-buckling-cad-input/1', id: 'solid-buckling-cad', source: { documentId: ownerId }, modeCount, reference };
}
function replaceAttachment(serialized: string, value: unknown): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}

describe('solid buckling input in actual .pcad persistence', () => {
  it('round-trips beside the static solid input deterministically and saves no load factor or shape', () => {
    const part = createEmptyPartDocument();
    const inputs: BeamAnalysisInputs = { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'solid-cad', definition: staticInput(part.id) }, { kind: 'solid-buckling-cad', definition: buckling(part.id) }] };
    const checked = readBeamAnalysisInputs(inputs, part.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    const text = serializeDocument(withBeamAnalysisInputs(part, checked.value), WRITE_OPTIONS);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual(checked.value.analyses);
    expect(serializeDocument(reopened.document, WRITE_OPTIONS)).toBe(text);
    expect(text).not.toMatch(/loadFactor|normalizedResidual|freeDofs|"shape"/u);
  });

  it('keeps a pressure reference a pressure input through a reopen', () => {
    const part = createEmptyPartDocument();
    const pressure: SolidCadSavedInput = { schema: 'pointercad-solid-cad-input/2', id: 'solid-cad', source: { documentId: part.id },
      bodyFeatureId: 'box', fixedFaces: ['{"face":1}'], loadedFaces: ['{"face":2}'], youngMPa: 205000, poisson: 0.3, load: 'pressure',
      pressureMPa: 2, linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
    const saved = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-buckling-cad', definition: buckling(part.id, 1, pressure) }] });
    const reopened = parseDocument(serializeDocument(saved, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-buckling-cad', definition: buckling(part.id, 1, pressure) }]);
  });

  it('keeps the saved values through actual Undo/Redo and a fresh serialized reopen', () => {
    const part = createEmptyPartDocument();
    const first = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-buckling-cad', definition: buckling(part.id) }] });
    const second = withBeamAnalysisInputs(first, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-buckling-cad', definition: buckling(part.id, 12) }] });
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    const previous = undo(stack);
    expect(previous.present.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-buckling-cad', definition: buckling(part.id) }]);
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-buckling-cad', definition: buckling(part.id, 12) }]);
    expect(undo(previous).present).toBe(part);
  });

  it('refuses the single-solid buckling input in an assembly on both read and write', () => {
    const assembly = beamCadFixture().document;
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-buckling-cad', definition: buckling(assembly.id) }] };
    expect(readAssemblyDocument(replaceAttachment(writeAssemblyDocument(assembly, WRITE_OPTIONS), attachment)).ok).toBe(false);
    const checked = readBeamAnalysisInputs(attachment, assembly.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(() => writeAssemblyDocument({ ...assembly, beamAnalysisInputs: checked.value }, WRITE_OPTIONS)).toThrow(/part/u);
  });

  it('refuses a bad buckling input at its own definition', () => {
    const part = createEmptyPartDocument();
    for (const definition of [{ ...buckling(part.id), loadFactors: [1] }, buckling(part.id, 0), buckling(part.id, 13),
      buckling(part.id, 3, { ...staticInput(part.id), loadedFaces: [] }), buckling(part.id, 3, staticInput('other-part'))]) {
      const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-buckling-cad', definition }] }, part.id);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.issue.path).toContain('definition');
      expect(parseDocument(replaceAttachment(serializeDocument(part, WRITE_OPTIONS),
        { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-buckling-cad', definition }] })).ok).toBe(false);
    }
  });
});
