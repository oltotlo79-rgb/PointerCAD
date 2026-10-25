import { createEmptyPartDocument } from '@pointercad/model';
import { withBeamAnalysisInputs, type BeamAnalysisInputs, type PlasticBarSavedInput } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-12T00:00:00.000Z' };

/** Benchmark inputs in the saved units (mm, mm², MPa); stated for this test only, not a material specification. */
function saved(documentId: string, change: Partial<Record<keyof PlasticBarSavedInput, unknown>> = {}): Record<string, unknown> {
  return { schema: 'pointercad-plastic-bar-input/1', id: 'plastic-bar', source: { documentId }, units: 'N-mm',
    lengthMm: 1000, areaMm2: 100, youngModulusMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
    materialSource: { kind: 'user-supplied', reference: 'Test benchmark constants, not a material specification' },
    endDisplacementMm: [0, 2.5, 0, -2.5, 0], stepsPerSegment: 1, ...change };
}
function attachment(...definitions: readonly Record<string, unknown>[]): unknown {
  return { schema: 'pointercad-beam-inputs/1', analyses: definitions.map(definition => ({ kind: 'plastic-bar', definition })) };
}
function replaceAttachment(serialized: string, value: unknown): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}

describe('saved plastic-bar configuration in part and assembly files', () => {
  it('round-trips the configuration of a part exactly, including values that are not short decimals', () => {
    const part = createEmptyPartDocument();
    for (const definition of [saved(part.id), saved(part.id, { lengthMm: 1000 / 3, areaMm2: 0.1 + 0.2,
      youngModulusMPa: 210000 + 1 / 7, endDisplacementMm: [0, 0.1 + 0.2, -(1 / 3), 0] })]) {
      const edited = withBeamAnalysisInputs(part, attachment(definition));
      const text = serializeDocument(edited, WRITE_OPTIONS);
      const reopened = parseDocument(text);
      if (!reopened.ok) throw new Error(reopened.error.message);
      expect(reopened.document.beamAnalysisInputs).toEqual(attachment(definition));
      expect(serializeDocument(reopened.document, WRITE_OPTIONS)).toBe(text);
      // Only inputs are stored: no result, digest, run state or solver handle.
      expect(JSON.stringify(reopened.document.beamAnalysisInputs))
        .not.toMatch(/"(?:samples|result|inputSha256|status|phase|revision|referenceDeviation|worker)"/u);
    }
  });

  it('keeps existing beam inputs of an assembly next to the plastic-bar configuration', () => {
    const fixture = beamCadFixture();
    const inputs = { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: fixture.definition },
      { kind: 'plastic-bar', definition: saved(fixture.document.id) },
    ] };
    const edited = withBeamAnalysisInputs(fixture.document, inputs);
    const text = writeAssemblyDocument(edited, WRITE_OPTIONS);
    const reopened = readAssemblyDocument(text);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(inputs);
    expect(writeAssemblyDocument(reopened.document, WRITE_OPTIONS)).toBe(text);
  });

  it('refuses future, unknown, foreign and invalid configurations through the real file reader', () => {
    const part = createEmptyPartDocument();
    const text = serializeDocument(withBeamAnalysisInputs(part, attachment(saved(part.id))), WRITE_OPTIONS);
    const cases: readonly (readonly [string, unknown])[] = [
      ['future schema', attachment(saved(part.id, { schema: 'pointercad-plastic-bar-input/2' }))],
      ['unknown kind', { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'plastic-bar-2', definition: saved(part.id) }] }],
      ['another document', attachment(saved('another-document'))],
      ['stored result', attachment({ ...saved(part.id), samples: [] })],
      ['missing source', attachment(Object.fromEntries(Object.entries(saved(part.id)).filter(([key]) => key !== 'materialSource')))],
      ['blank source', attachment(saved(part.id, { materialSource: { kind: 'user-supplied', reference: '   ' } }))],
      ['grade-derived source kind', attachment(saved(part.id, { materialSource: { kind: 'published', reference: 'SS400' } }))],
      ['non-number value', attachment(saved(part.id, { youngModulusMPa: 'NaN' }))],
      ['null value', attachment(saved(part.id, { poisson: null }))],
      ['first knot not zero', attachment(saved(part.id, { endDisplacementMm: [1, 2.5] }))],
      ['repeated knot', attachment(saved(part.id, { endDisplacementMm: [0, 2.5, 2.5] }))],
      ['beyond small strain', attachment(saved(part.id, { endDisplacementMm: [0, 50.001] }))],
      ['yield not below Young', attachment(saved(part.id, { yieldStressMPa: 200000 }))],
      ['softening', attachment(saved(part.id, { hardeningModulusMPa: -1 }))],
      ['fractional steps', attachment(saved(part.id, { stepsPerSegment: 1.5 }))],
      ['too many steps', attachment(saved(part.id, { stepsPerSegment: 200, endDisplacementMm: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1] }))],
      ['two configurations', attachment(saved(part.id), saved(part.id))],
    ];
    for (const [label, value] of cases) {
      expect(parseDocument(replaceAttachment(text, value)).ok, label).toBe(false);
    }
    // The unchanged text still opens: the refusals above come from the edited attachment only.
    expect(parseDocument(text).ok).toBe(true);
  });

  it('accepts the exact small-strain boundary and leaves documents without the configuration unchanged', () => {
    const part = createEmptyPartDocument();
    const boundary = withBeamAnalysisInputs(part, attachment(saved(part.id, { endDisplacementMm: [0, 50, -50] })));
    const reopened = parseDocument(serializeDocument(boundary, WRITE_OPTIONS));
    expect(reopened.ok).toBe(true);
    const plain = parseDocument(serializeDocument(part, WRITE_OPTIONS));
    if (!plain.ok) throw new Error(plain.error.message);
    expect(plain.document.beamAnalysisInputs).toBeUndefined();
    const inputs: BeamAnalysisInputs | undefined = boundary.beamAnalysisInputs;
    expect(inputs?.analyses).toHaveLength(1);
  });
});
