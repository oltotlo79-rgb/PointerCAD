import { replaceAttachment } from './analysisAttachment.testSupport.js';
import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type BeamAnalysisInputs,
  type SolidFiniteCadSavedInput } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '@pointercad/model/testing/analysis-fixtures';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';

const WRITE_OPTIONS = { savedAt: '2026-10-22T00:00:00.000Z' };

function plastic(ownerId: string, hardeningModulusMPa = 2000): SolidFiniteCadSavedInput {
  return { schema: 'pointercad-solid-finite-cad-input/1', id: 'solid-finite-cad', source: { documentId: ownerId },
    bodyFeatureId: 'box', fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 200000, poisson: 0.3,
    yieldStressMPa: 250, hardeningModulusMPa, materialReference: 'Independent test constants; not a grade specification',
    tractionMPa: [0, 0, -2], forceFactors: [1, 0, -1], prescribedDisplacementFactors: [0.5, 1, -1],
    linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}

function attachment(ownerId: string, hardeningModulusMPa = 2000): BeamAnalysisInputs {
  return { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'solid-finite-cad', definition: plastic(ownerId, hardeningModulusMPa) }] };
}


describe('solid finite plasticity input at the actual .pcad owner boundary', () => {
  it('refuses a part-only finite plasticity definition in an assembly on read and write', () => {
    const assembly = beamCadFixture().document;
    const inputs = attachment(assembly.id);
    // Valid values and a matching document ID isolate the owner-kind defect.
    const checked = readBeamAnalysisInputs(inputs, assembly.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    const original = writeAssemblyDocument(assembly, WRITE_OPTIONS);
    expect(readAssemblyDocument(replaceAttachment(original, inputs)).ok).toBe(false);
    expect(() => writeAssemblyDocument({ ...assembly, beamAnalysisInputs: checked.value }, WRITE_OPTIONS)).toThrow(/part/u);
    expect(writeAssemblyDocument(assembly, WRITE_OPTIONS)).toBe(original);
  });

  it('round-trips a valid part with unload/reversal, material provenance and semantic faces intact', () => {
    const part = createEmptyPartDocument();
    const inputs = attachment(part.id);
    const text = serializeDocument(withBeamAnalysisInputs(part, inputs), WRITE_OPTIONS);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(inputs);
    expect(serializeDocument(reopened.document, WRITE_OPTIONS)).toBe(text);
    expect(text).not.toMatch(/"(?:results|mesh|inputSha256|freeResidualRatio|stressMPa|plasticStrain)"/u);
  });

  it('preserves input edits through Undo/Redo and reopen without adding input to the legacy part', () => {
    const part = createEmptyPartDocument();
    const original = serializeDocument(part, WRITE_OPTIONS);
    const first = withBeamAnalysisInputs(part, attachment(part.id));
    const second = withBeamAnalysisInputs(first, attachment(part.id, 0));
    const previous = undo(pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 }));
    expect(previous.present.beamAnalysisInputs).toEqual(attachment(part.id));
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment(part.id, 0));
    expect(serializeDocument(undo(previous).present, WRITE_OPTIONS)).toBe(original);
    const legacy = parseDocument(original);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(legacy.document.beamAnalysisInputs).toBeUndefined();
    expect(serializeDocument(legacy.document, WRITE_OPTIONS)).toBe(original);
  });
});

it('preserves an old small-strain definition byte-for-byte beside a distinct finite definition', () => {
  const part = createEmptyPartDocument(), finite = plastic(part.id);
  const { forceFactors: _forces, prescribedDisplacementFactors: _prescribed, ...common } = finite;
  expect(_forces).toEqual([1, 0, -1]); expect(_prescribed).toEqual([0.5, 1, -1]);
  const small = { ...common, schema: 'pointercad-solid-plastic-cad-input/1' as const, id: 'solid-plastic-cad' as const,
    loadFactor: [0, 1, 0], stepsPerSegment: 4 };
  const legacyDocument = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1',
    analyses: [{ kind: 'solid-plastic-cad', definition: small }] });
  const legacyText = serializeDocument(legacyDocument, WRITE_OPTIONS);
  const legacyReopened = parseDocument(legacyText);
  if (!legacyReopened.ok) throw new Error(legacyReopened.error.message);
  expect(legacyReopened.document.beamAnalysisInputs?.analyses[0]).toEqual({ kind: 'solid-plastic-cad', definition: small });
  // Preserve the old codec's actual persisted field order, independently of the
  // construction order of this in-memory fixture.
  const legacyBytes = JSON.stringify(legacyReopened.document.beamAnalysisInputs?.analyses[0]);
  const both: BeamAnalysisInputs = { schema: 'pointercad-beam-inputs/1', analyses: [
    { kind: 'solid-plastic-cad', definition: small }, { kind: 'solid-finite-cad', definition: finite }] };
  const reopened = parseDocument(serializeDocument(withBeamAnalysisInputs(part, both), WRITE_OPTIONS));
  if (!reopened.ok) throw new Error(reopened.error.message);
  expect(reopened.document.beamAnalysisInputs).toEqual(both);
  expect(JSON.stringify(reopened.document.beamAnalysisInputs?.analyses[0])).toBe(legacyBytes);
  expect(serializeDocument(legacyDocument, WRITE_OPTIONS)).toBe(legacyText);
  expect(readBeamAnalysisInputs({ ...both, analyses: [...both.analyses, both.analyses[1]] }, part.id).ok).toBe(false);
});
