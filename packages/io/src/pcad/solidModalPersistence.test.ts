import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type BeamAnalysisInputs, type SolidModalCadSavedInput }
  from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-19T00:00:00.000Z' };

function modal(ownerId: string, overrides: Partial<SolidModalCadSavedInput> = {}): SolidModalCadSavedInput {
  return {
    schema: 'pointercad-solid-modal-cad-input/1', id: 'solid-modal-cad', source: { documentId: ownerId }, bodyFeatureId: 'box',
    fixedFaces: ['{"face":1}'], youngMPa: 205000, poisson: 0.3, densityKgM3: 7850, modeCount: 6,
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1, ...overrides,
  };
}
function staticInput(ownerId: string) {
  return { schema: 'pointercad-solid-cad-input/1' as const, id: 'solid-cad' as const, source: { documentId: ownerId },
    bodyFeatureId: 'box', fixedFaces: ['{"face":1}'], loadedFaces: ['{"face":2}'], youngMPa: 205000, poisson: 0.3,
    tractionMPa: [0, 0, -1] as const, linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
function replaceAttachment(serialized: string, value: unknown): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}

describe('solid modal input in actual .pcad persistence', () => {
  it('round-trips beside the static solid input deterministically and keeps the static input unchanged', () => {
    const part = createEmptyPartDocument();
    const inputs: BeamAnalysisInputs = { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'solid-cad', definition: staticInput(part.id) }, { kind: 'solid-modal-cad', definition: modal(part.id) }] };
    const checked = readBeamAnalysisInputs(inputs, part.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    const text = serializeDocument(withBeamAnalysisInputs(part, checked.value), WRITE_OPTIONS);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual(checked.value.analyses);
    expect(serializeDocument(reopened.document, WRITE_OPTIONS)).toBe(text);
    expect(text).not.toMatch(/amplitude|phase|modeNumber|massNormalizedShape|frequencyHz/u);
  });

  it('keeps a legacy part without the modal input byte for byte', () => {
    const part = createEmptyPartDocument();
    const legacy = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition: staticInput(part.id) }] });
    const text = serializeDocument(legacy, WRITE_OPTIONS);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document).toEqual(legacy);
    expect(text).not.toContain('solid-modal-cad');
  });

  it('keeps the saved values through actual Undo/Redo and a fresh serialized reopen', () => {
    const part = createEmptyPartDocument();
    const first = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-modal-cad', definition: modal(part.id) }] });
    const second = withBeamAnalysisInputs(first, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-modal-cad', definition: modal(part.id, { densityKgM3: 2700, modeCount: 3, fixedFaces: [] }) }] });
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    const previous = undo(stack);
    expect(previous.present.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-modal-cad', definition: modal(part.id) }]);
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses)
      .toEqual([{ kind: 'solid-modal-cad', definition: modal(part.id, { densityKgM3: 2700, modeCount: 3, fixedFaces: [] }) }]);
    expect(undo(previous).present).toBe(part);
  });

  it('refuses the single-solid modal input in an assembly on both read and write', () => {
    const assembly = beamCadFixture().document;
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-modal-cad', definition: modal(assembly.id) }] };
    expect(readAssemblyDocument(replaceAttachment(writeAssemblyDocument(assembly, WRITE_OPTIONS), attachment)).ok).toBe(false);
    const checked = readBeamAnalysisInputs(attachment, assembly.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(() => writeAssemblyDocument({ ...assembly, beamAnalysisInputs: checked.value }, WRITE_OPTIONS)).toThrow(/part/u);
  });

  it('refuses a bad modal input at its own definition, never as a beam analysis', () => {
    const part = createEmptyPartDocument();
    for (const definition of [{ ...modal(part.id), amplitudeMm: 10 }, modal(part.id, { modeCount: 0 }), { ...modal(part.id), schema: 'pointercad-standard-beam/1' }]) {
      const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-modal-cad', definition }] }, part.id);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.issue.path).toContain('definition');
      expect(parseDocument(replaceAttachment(serializeDocument(part, WRITE_OPTIONS),
        { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-modal-cad', definition }] })).ok).toBe(false);
    }
    const otherDocument = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'solid-modal-cad', definition: modal('other-part') }] }, part.id);
    expect(otherDocument.ok).toBe(false);
  });
});
