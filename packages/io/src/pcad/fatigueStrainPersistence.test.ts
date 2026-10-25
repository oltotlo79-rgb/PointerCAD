import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-18T00:00:00.000Z' };
/** Synthetic values written out here (manufactured coefficients, not a real material), independent of the readers. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured strain-life coefficients' };
function strainSaved(documentId: string) {
  return { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero',
      material: { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
        fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
        calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source },
      histories: [{ id: 'measured-1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-0.0078125, 0.0078125, -0.00390625], sequence: 'once', repeats: 1, source },
      { id: 'analysis-1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'elastic-plastic-analysis',
        strain: [0, 0.015625], sequence: 'repeated-periodic', repeats: 1000, source }] } };
}
/** Stress-life version 3 (Goodman) exactly as the existing saved format writes it. */
function goodmanSaved(documentId: string) {
  return { schema: 'pointercad-fatigue-saved/3', id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 3,
      cutoffStressMpa: null, source }, histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [-80, 80],
      sequence: 'repeated-periodic', repeats: 1, source }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 10_000, source } };
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

describe('strain-life fatigue inputs in part and assembly persistence', () => {
  it.each(['part', 'assembly'] as const)('cold-round-trips %s strain-life inputs beside Goodman inputs, without results', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    const document = kind === 'part' ? part : assembly;
    const value = attachment({ kind: 'fatigue', definition: goodmanSaved(document.id) },
      { kind: 'fatigue-strain-life', definition: strainSaved(document.id) });
    const serialized = kind === 'part' ? serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS)
      : writeAssemblyDocument(withBeamAnalysisInputs(assembly, value), WRITE_OPTIONS);
    const restored = kind === 'part' ? parseDocument(serialized) : readAssemblyDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(value);
    expect(JSON.stringify(restored.document.beamAnalysisInputs)).not.toMatch(/"(?:damage|life|result|cycles|cyclesToFailure)"/u);
    // Re-encode a fresh read, not the original in-memory value: the bytes must not drift.
    expect(kind === 'part' ? serializeDocument(parsePart(serialized), WRITE_OPTIONS)
      : writeAssemblyDocument(parseAssembly(serialized), WRITE_OPTIONS)).toBe(serialized);
  });

  it('keeps a cold-read legacy version 2 stress input unchanged beside a strain-life input', () => {
    const part = createEmptyPartDocument(), current = goodmanSaved(part.id);
    const version2 = { schema: 'pointercad-fatigue-saved/2', id: current.id, source: current.source, input: current.input, axial: [] };
    const text = replaceAttachment(serializeDocument(part, WRITE_OPTIONS), attachment({ kind: 'fatigue', definition: version2 },
      { kind: 'fatigue-strain-life', definition: strainSaved(part.id) }));
    const restored = parseDocument(text);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue', definition: version2 },
      { kind: 'fatigue-strain-life', definition: strainSaved(part.id) }]);
    expect(JSON.stringify(restored.document.beamAnalysisInputs)).not.toContain('correction');
  });

  it('keeps strain-life values and sources through actual Undo/Redo and a fresh serialized reopen', () => {
    const part = createEmptyPartDocument(), firstSaved = strainSaved(part.id);
    const first = withBeamAnalysisInputs(part, attachment({ kind: 'fatigue-strain-life', definition: firstSaved }));
    const secondSaved = { ...firstSaved, input: { ...firstSaved.input, material: { ...firstSaved.input.material,
      calibration: { minimumCycles: 10, maximumCycles: 1e5 }, source: { ...source, reference: 'second independent source' } } } };
    const second = withBeamAnalysisInputs(first, attachment({ kind: 'fatigue-strain-life', definition: secondSaved }));
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    const previous = undo(stack);
    expect(previous.present.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-strain-life', definition: firstSaved }]);
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-strain-life', definition: secondSaved }]);
    expect(undo(previous).present).toBe(part);
  });

  it.each(['unknown-version', 'stress-as-strain', 'morrow', 'results-injection', 'reversed-calibration', 'sparse-strain'])(
    'refuses %s in both actual document readers', kind => {
      const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
      for (const owner of ['part', 'assembly']) {
        const document = owner === 'part' ? part : assembly, saved = strainSaved(document.id);
        const history = saved.input.histories[0];
        let definition: unknown = saved;
        if (kind === 'unknown-version') definition = { ...saved, schema: 'pointercad-fatigue-strain-saved/2' };
        if (kind === 'stress-as-strain') definition = { ...saved, input: { ...saved.input,
          histories: [{ ...history, strainMeasure: 'elastic-stress-over-modulus' }] } };
        if (kind === 'morrow') definition = { ...saved, input: { ...saved.input, meanStress: 'morrow' } };
        if (kind === 'results-injection') definition = { ...saved, result: { damage: 0 } };
        if (kind === 'reversed-calibration') definition = { ...saved, input: { ...saved.input, material: { ...saved.input.material,
          calibration: { minimumCycles: 1e6, maximumCycles: 1 } } } };
        // JSON has no holes: a sparse list is written as null entries, which the strict reader refuses as non-numbers.
        if (kind === 'sparse-strain') definition = { ...saved, input: { ...saved.input, histories: [{ ...history, strain: new Array(2) }] } };
        const original = owner === 'part' ? serializeDocument(part, WRITE_OPTIONS) : writeAssemblyDocument(assembly, WRITE_OPTIONS);
        const text = replaceAttachment(original, attachment({ kind: 'fatigue-strain-life', definition }));
        const read = owner === 'part' ? parseDocument(text) : readAssemblyDocument(text);
        expect(read.ok).toBe(false);
        if (!read.ok) expect(read.error.code).toBe('invalidField');
      }
    });
});
