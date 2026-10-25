import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-18T00:00:00.000Z' };
/** Synthetic values written out here (manufactured coefficients, not a real material), independent of the readers. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured local cycle' };
const material = { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
  fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
  calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source };
function localCycleSaved(documentId: string, correction = 'swt') {
  return { schema: 'pointercad-fatigue-local-cycle-saved/1', id: 'fatigue-local-cycle', source: { documentId },
    input: { schema: 'pointercad-strain-life-local-cycle/1', correction, material,
      cycle: { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa',
        derivation: 'elastic-plastic-analysis', strainMax: 0.01, strainMin: -0.01, stressMax: 500, stressMin: -300, source } } };
}
function strainHistories(documentId: string) {
  return { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material,
      histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-0.0078125, 0.0078125], sequence: 'repeated-periodic', repeats: 10, source }] } };
}
const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
function parsePart(text: string): ReturnType<typeof createEmptyPartDocument> {
  const read = parseDocument(text);
  if (!read.ok) throw new Error(read.error.message);
  return read.document;
}
function parseAssembly(text: string): ReturnType<typeof beamCadFixture>['document'] {
  const read = readAssemblyDocument(text);
  if (!read.ok) throw new Error(read.error.message);
  return read.document;
}
function replaceAttachment(serialized: string, value: unknown): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}

describe('local-cycle fatigue inputs in part and assembly persistence', () => {
  it.each(['part', 'assembly'] as const)('cold-round-trips %s local-cycle inputs beside zero-mean histories, without results', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    const document = kind === 'part' ? part : assembly;
    const value = attachment({ kind: 'fatigue-strain-life', definition: strainHistories(document.id) },
      { kind: 'fatigue-local-cycle', definition: localCycleSaved(document.id) });
    const serialized = kind === 'part' ? serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS)
      : writeAssemblyDocument(withBeamAnalysisInputs(assembly, value), WRITE_OPTIONS);
    const restored = kind === 'part' ? parseDocument(serialized) : readAssemblyDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(value);
    expect(JSON.stringify(restored.document.beamAnalysisInputs)).not.toMatch(/"(?:cyclesToFailure|reversalsToFailure|damage|life|swtParameterMpa|result)"/u);
    // Re-encode a fresh read, not the original in-memory value: the bytes must not drift.
    expect(kind === 'part' ? serializeDocument(parsePart(serialized), WRITE_OPTIONS)
      : writeAssemblyDocument(parseAssembly(serialized), WRITE_OPTIONS)).toBe(serialized);
  });

  it('keeps the correction method, extrema and sources through actual Undo/Redo and a fresh serialized reopen', () => {
    const part = createEmptyPartDocument(), firstSaved = localCycleSaved(part.id, 'swt');
    const first = withBeamAnalysisInputs(part, attachment({ kind: 'fatigue-local-cycle', definition: firstSaved }));
    const secondSaved = { ...localCycleSaved(part.id, 'morrow'), input: { ...localCycleSaved(part.id, 'morrow').input,
      cycle: { ...firstSaved.input.cycle, stressMax: 450, source: { ...source, reference: 'second independent source' } } } };
    const second = withBeamAnalysisInputs(first, attachment({ kind: 'fatigue-local-cycle', definition: secondSaved }));
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    const previous = undo(stack);
    expect(previous.present.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-local-cycle', definition: firstSaved }]);
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-local-cycle', definition: secondSaved }]);
    expect(undo(previous).present).toBe(part);
  });

  it.each(['unknown-version', 'unknown-correction', 'stress-unit', 'undefined-extremum', 'reversed-calibration', 'results-injection',
    'blank-source'])('refuses %s in both actual document readers', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    for (const owner of ['part', 'assembly']) {
      const document = owner === 'part' ? part : assembly, saved = localCycleSaved(document.id);
      let definition: unknown = saved;
      if (kind === 'unknown-version') definition = { ...saved, schema: 'pointercad-fatigue-local-cycle-saved/2' };
      if (kind === 'unknown-correction') definition = { ...saved, input: { ...saved.input, correction: 'goodman' } };
      if (kind === 'stress-unit') definition = { ...saved, input: { ...saved.input, cycle: { ...saved.input.cycle, stressUnit: 'Pa' } } };
      // JSON drops an undefined value, so the written field is missing: a shape refusal.
      if (kind === 'undefined-extremum') definition = { ...saved, input: { ...saved.input, cycle: { ...saved.input.cycle, stressMin: undefined } } };
      if (kind === 'reversed-calibration') definition = { ...saved, input: { ...saved.input,
        material: { ...material, calibration: { minimumCycles: 1e6, maximumCycles: 1 } } } };
      if (kind === 'results-injection') definition = { ...saved, result: { cyclesToFailure: 100 } };
      if (kind === 'blank-source') definition = { ...saved, input: { ...saved.input, cycle: { ...saved.input.cycle, source: { ...source, reference: ' ' } } } };
      const original = owner === 'part' ? serializeDocument(part, WRITE_OPTIONS) : writeAssemblyDocument(assembly, WRITE_OPTIONS);
      const text = replaceAttachment(original, attachment({ kind: 'fatigue-local-cycle', definition }));
      const read = owner === 'part' ? parseDocument(text) : readAssemblyDocument(text);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.code).toBe('invalidField');
    }
  });
});
