import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-19T00:00:00.000Z' };
/** Synthetic values written out here (manufactured coefficients, not a real material; stresses typed, not computed from
 * a strain), independent of the readers. Times and values are binary fractions so a JSON round trip is exact. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured strain-life coefficients' };
const material = { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
  fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
  calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source };
const paired = { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressMeasure: 'local-stress', stressUnit: 'MPa',
  timeUnit: 'second' };
function pairedSaved(documentId: string) {
  return { schema: 'pointercad-fatigue-strain-stress-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: { schema: 'pointercad-strain-stress-history/1', meanStress: 'morrow-paired-reversal-stress', material,
      histories: [{ id: 'measured-1', ...paired, derivation: 'measured',
        samples: [{ timeSeconds: 0, strain: -0.0078125, stressMpa: -312.5 }, { timeSeconds: 0.25, strain: 0.0078125, stressMpa: 287.5 },
          { timeSeconds: 0.75, strain: -0.00390625, stressMpa: -150.25 }], sequence: 'once', repeats: 1, source },
      { id: 'analysis-1', ...paired, derivation: 'elastic-plastic-analysis',
        samples: [{ timeSeconds: 10, strain: 0, stressMpa: 12.5 }, { timeSeconds: 10.5, strain: 0.015625, stressMpa: 412.75 }],
        sequence: 'repeated-periodic', repeats: 1000, source }] } };
}
/** The zero-mean strain-only configuration exactly as saved format 1 writes it. */
function strainSaved(documentId: string) {
  return { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material,
      histories: [{ id: 'measured-1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-0.0078125, 0.0078125, -0.00390625], sequence: 'once', repeats: 1, source }] } };
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

describe('paired strain-stress fatigue inputs in part and assembly persistence', () => {
  it.each(['part', 'assembly'] as const)('cold-round-trips %s paired samples beside Goodman inputs, without results', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    const document = kind === 'part' ? part : assembly;
    const value = attachment({ kind: 'fatigue', definition: goodmanSaved(document.id) },
      { kind: 'fatigue-strain-life', definition: pairedSaved(document.id) });
    const serialized = kind === 'part' ? serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS)
      : writeAssemblyDocument(withBeamAnalysisInputs(assembly, value), WRITE_OPTIONS);
    const restored = kind === 'part' ? parseDocument(serialized) : readAssemblyDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    // Every sample keeps its own time, strain and stress, in the typed order.
    expect(restored.document.beamAnalysisInputs).toEqual(value);
    expect(JSON.stringify(restored.document.beamAnalysisInputs))
      .not.toMatch(/"(?:damage|life|result|cycles|cyclesToFailure|meanStressMpa)"/u);
    expect(kind === 'part' ? serializeDocument(parsePart(serialized), WRITE_OPTIONS)
      : writeAssemblyDocument(parseAssembly(serialized), WRITE_OPTIONS)).toBe(serialized);
  });

  it('switches between the zero-mean and the paired configuration through actual Undo/Redo and a fresh reopen', () => {
    const part = createEmptyPartDocument(), zeroMean = strainSaved(part.id), withStress = pairedSaved(part.id);
    const first = withBeamAnalysisInputs(part, attachment({ kind: 'fatigue-strain-life', definition: zeroMean }));
    const second = withBeamAnalysisInputs(first, attachment({ kind: 'fatigue-strain-life', definition: withStress }));
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    const previous = undo(stack);
    // The old zero-mean document stays exactly as written, with its explicit zero-mean statement.
    const reopenedOld = parsePart(serializeDocument(previous.present, WRITE_OPTIONS));
    expect(reopenedOld.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-strain-life', definition: zeroMean }]);
    const reopened = parsePart(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    expect(reopened.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-strain-life', definition: withStress }]);
    expect(undo(previous).present).toBe(part);
  });

  const refusals = ['paired-under-zero-mean-schema', 'zero-mean-under-paired-schema', 'unknown-paired-version',
    'paired-declared-zero-mean', 'separate-stress-list', 'repeated-time', 'reordered-time', 'stress-in-kPa', 'stress-in-Pa',
    'null-stress', 'both-variants', 'results-injection'] as const;
  it.each(refusals)('refuses %s in both actual document readers', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    for (const owner of ['part', 'assembly']) {
      const document = owner === 'part' ? part : assembly, saved = pairedSaved(document.id);
      const [history, other] = saved.input.histories;
      const samples = (rows: readonly unknown[]): unknown => ({ ...saved, input: { ...saved.input,
        histories: [{ ...history, samples: rows }, other] } });
      const [s0, s1, s2] = history?.samples ?? [];
      const definitions: Record<typeof refusals[number], unknown[]> = {
        'paired-under-zero-mean-schema': [{ ...saved, schema: 'pointercad-fatigue-strain-saved/1' }],
        'zero-mean-under-paired-schema': [{ ...strainSaved(document.id), schema: 'pointercad-fatigue-strain-stress-saved/1' }],
        'unknown-paired-version': [{ ...saved, schema: 'pointercad-fatigue-strain-stress-saved/2' }],
        'paired-declared-zero-mean': [{ ...saved, input: { ...saved.input, meanStress: 'assumed-zero' } }],
        'separate-stress-list': [{ ...saved, input: { ...saved.input, histories: [{ ...history, stressMpa: [-312.5, 287.5] }, other] } }],
        'repeated-time': [samples([s0, { ...s1, timeSeconds: 0 }, s2])],
        'reordered-time': [samples([s0, s2, s1])],
        'stress-in-kPa': [{ ...saved, input: { ...saved.input, histories: [{ ...history, stressUnit: 'kPa' }, other] } }],
        'stress-in-Pa': [samples([s0, { ...s1, stressMpa: 287.5e6 }, s2])],
        // JSON has no undefined: a missing stress is written as null, which the strict reader refuses as a non-number.
        'null-stress': [samples([s0, { ...s1, stressMpa: null }, s2])],
        'both-variants': [strainSaved(document.id), saved],
        'results-injection': [{ ...saved, result: { damage: 0 } }],
      };
      const original = owner === 'part' ? serializeDocument(part, WRITE_OPTIONS) : writeAssemblyDocument(assembly, WRITE_OPTIONS);
      const text = replaceAttachment(original, attachment(...definitions[kind].map(definition =>
        ({ kind: 'fatigue-strain-life', definition }))));
      const read = owner === 'part' ? parseDocument(text) : readAssemblyDocument(text);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.code).toBe('invalidField');
    }
  });
});
