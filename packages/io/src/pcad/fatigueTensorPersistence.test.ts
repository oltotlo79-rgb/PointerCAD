import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-19T00:00:00.000Z' };
/** Synthetic values written out here (a manufactured curve and tensors, not a material), independent of the readers. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured tensor history' };
const curve = { id: 'curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
  referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null, source };
function tensorSaved(documentId: string) {
  return { schema: 'pointercad-fatigue-saved/4', id: 'fatigue', source: { documentId },
    input: { schema: 'pointercad-fatigue-proportional-tensor/1',
      method: 'proportional-elastic-signed-von-mises-absolute-largest-principal/1', curve,
      histories: [{ id: 'history-1', reference: { unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy',
        xx: 0.1, yy: -33.3, zz: 0, yz: 1e-7, xz: 2.5, xy: -0.3 }, loadFactors: [0, 0.0015, -0.7, 1],
      sequence: 'repeated-periodic', repeats: 10, source },
      { id: 'history-2', reference: { unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy',
        xx: 0, yy: 0, zz: 0, yz: 0, xz: 0, xy: 5e-324 }, loadFactors: [-1, 1], sequence: 'once', repeats: 1, source }] } };
}
const goodman = { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
  applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300, minimumCycles: 10_000, source };
/** Stress-life versions 2 and 3 exactly as the existing saved format writes them. */
function stressSaved(documentId: string, schema: 'pointercad-fatigue-saved/2' | 'pointercad-fatigue-saved/3') {
  const base = { schema, id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { ...curve, stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only' },
      histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [-80, 80], sequence: 'repeated-periodic', repeats: 1, source }] } };
  return schema === 'pointercad-fatigue-saved/2' ? base : { ...base, correction: goodman };
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

describe('proportional tensor fatigue inputs in part and assembly persistence', () => {
  it.each(['part', 'assembly'] as const)('cold-round-trips %s tensor inputs exactly, without results, with stable bytes', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    const document = kind === 'part' ? part : assembly;
    const value = attachment({ kind: 'fatigue-proportional-tensor', definition: tensorSaved(document.id) });
    const serialized = kind === 'part' ? serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS)
      : writeAssemblyDocument(withBeamAnalysisInputs(assembly, value), WRITE_OPTIONS);
    const restored = kind === 'part' ? parseDocument(serialized) : readAssemblyDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(value);
    const analyses = restored.document.beamAnalysisInputs?.analyses ?? [];
    const read = analyses[0]?.kind === 'fatigue-proportional-tensor' ? analyses[0].definition.input.histories : [];
    // Every double comes back as the same double (=== comparison, including the smallest subnormal).
    expect(read[0]?.reference.yz).toBe(1e-7);
    expect(read[0]?.loadFactors[1]).toBe(0.0015);
    expect(read[1]?.reference.xy).toBe(Number.MIN_VALUE);
    expect(JSON.stringify(restored.document.beamAnalysisInputs)).not.toMatch(/"(?:damage|life|result|cycles|stressMpa|conversions)"/u);
    // Re-encode a fresh read, not the original in-memory value: the bytes must not drift.
    expect(kind === 'part' ? serializeDocument(parsePart(serialized), WRITE_OPTIONS)
      : writeAssemblyDocument(parseAssembly(serialized), WRITE_OPTIONS)).toBe(serialized);
  });

  it.each(['pointercad-fatigue-saved/2', 'pointercad-fatigue-saved/3'] as const)('keeps a cold-read %s stress input unchanged', schema => {
    const part = createEmptyPartDocument();
    const text = replaceAttachment(serializeDocument(part, WRITE_OPTIONS), attachment({ kind: 'fatigue', definition: stressSaved(part.id, schema) }));
    const restored = parseDocument(text);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue', definition: stressSaved(part.id, schema) }]);
  });

  it('keeps tensor values and sources through actual Undo/Redo and a fresh serialized reopen', () => {
    const part = createEmptyPartDocument(), firstSaved = tensorSaved(part.id);
    const first = withBeamAnalysisInputs(part, attachment({ kind: 'fatigue-proportional-tensor', definition: firstSaved }));
    const [one, two] = firstSaved.input.histories;
    if (one === undefined || two === undefined) throw new Error('Expected two histories');
    const secondSaved = { ...firstSaved, input: { ...firstSaved.input,
      histories: [{ ...one, loadFactors: [0, 1], source: { ...source, reference: 'second independent source' } }, two] } };
    const second = withBeamAnalysisInputs(first, attachment({ kind: 'fatigue-proportional-tensor', definition: secondSaved }));
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    const previous = undo(stack);
    expect(previous.present.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-proportional-tensor', definition: firstSaved }]);
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-proportional-tensor', definition: secondSaved }]);
    expect(undo(previous).present).toBe(part);
  });

  it.each(['unknown-version', 'goodman', 'results-injection', 'zero-reference', 'rounded-factor', 'stress-and-tensor', 'as-stress'])(
    'refuses %s in both actual document readers', kind => {
      const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
      for (const owner of ['part', 'assembly']) {
        const document = owner === 'part' ? part : assembly, saved = tensorSaved(document.id);
        const [one, two] = saved.input.histories;
        let analyses: unknown[] = [{ kind: 'fatigue-proportional-tensor', definition: saved }];
        if (kind === 'unknown-version') analyses = [{ kind: 'fatigue-proportional-tensor', definition: { ...saved, schema: 'pointercad-fatigue-saved/5' } }];
        if (kind === 'goodman') analyses = [{ kind: 'fatigue-proportional-tensor', definition: { ...saved, correction: goodman } }];
        if (kind === 'results-injection') analyses = [{ kind: 'fatigue-proportional-tensor', definition: { ...saved, result: { damage: 0 } } }];
        if (kind === 'zero-reference' && one !== undefined && two !== undefined) {
          analyses = [{ kind: 'fatigue-proportional-tensor', definition: { ...saved, input: { ...saved.input,
            histories: [{ ...one, reference: { ...one.reference, xx: 0, yy: 0, xz: 0, yz: 0, xy: 0 } }, two] } } }];
        }
        // The pure shear reference xy = 5e-324 has the equivalent sqrt(3) x 5e-324, which rounds to 2 x 5e-324; a factor of
        // 0.25 gives the exact half-way value 0.5 x 5e-324, which rounds to the even neighbour 0.
        if (kind === 'rounded-factor' && one !== undefined && two !== undefined) {
          analyses = [{ kind: 'fatigue-proportional-tensor', definition: { ...saved, input: { ...saved.input,
            histories: [one, { ...two, loadFactors: [0.25] }] } } }];
        }
        if (kind === 'stress-and-tensor') analyses = [{ kind: 'fatigue', definition: stressSaved(document.id, 'pointercad-fatigue-saved/2') },
          { kind: 'fatigue-proportional-tensor', definition: saved }];
        if (kind === 'as-stress') analyses = [{ kind: 'fatigue', definition: saved }];
        const original = owner === 'part' ? serializeDocument(part, WRITE_OPTIONS) : writeAssemblyDocument(assembly, WRITE_OPTIONS);
        const text = replaceAttachment(original, attachment(...analyses));
        const read = owner === 'part' ? parseDocument(text) : readAssemblyDocument(text);
        expect(read.ok).toBe(false);
        if (!read.ok) expect(read.error.code).toBe('invalidField');
      }
    });
});
