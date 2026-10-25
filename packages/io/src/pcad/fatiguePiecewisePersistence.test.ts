import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-20T00:00:00.000Z' };
/*
 * SYNTHETIC calibration written out here (task180's analytically specified two-slope curve), not a steel standard,
 * detail category or FAT class: N = 1e5 (400/S)^3 down to 200 MPa, then N = 8e5 (200/S)^5 down to 1e8 cycles.
 */
const source = { kind: 'user-supplied', reference: 'synthetic test calibration (not a standard)', condition: 'unit test only' };
const applicability = { material: 'synthetic', detail: 'synthetic', scope: 'unit test only' };
function piecewiseSaved(documentId: string, end: 'cutoff-at-end' | 'none' = 'cutoff-at-end') {
  return { schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId },
    input: { schema: 'pointercad-fatigue-piecewise/1',
      curve: { id: 'two-slope', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'fully-reversed-only',
        segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }, { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }],
        endCycles: 1e8, end, applicability, source },
      histories: [{ id: 'upper', unit: 'MPa', stressMpa: [125, -125], sequence: 'repeated-periodic', repeats: 2, source },
        { id: 'lower', unit: 'MPa', stressMpa: [80, -80], sequence: 'repeated-periodic', repeats: 3, source }] } };
}
/** The existing single-slope version 2 exactly as the saved format writes it. */
function stressSaved(documentId: string) {
  return { schema: 'pointercad-fatigue-saved/2', id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null, source },
    histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [-80, 80], sequence: 'repeated-periodic', repeats: 1, source }] } };
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

describe('piecewise S-N fatigue inputs in part and assembly persistence', () => {
  it.each(['part', 'assembly'] as const)('cold-round-trips %s calibrated input exactly, without results, with stable bytes', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    const document = kind === 'part' ? part : assembly;
    const value = attachment({ kind: 'fatigue-piecewise', definition: piecewiseSaved(document.id) });
    const serialized = kind === 'part' ? serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS)
      : writeAssemblyDocument(withBeamAnalysisInputs(assembly, value), WRITE_OPTIONS);
    const restored = kind === 'part' ? parseDocument(serialized) : readAssemblyDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(value);
    const analyses = restored.document.beamAnalysisInputs?.analyses ?? [];
    const curve = analyses[0]?.kind === 'fatigue-piecewise' ? analyses[0].definition.input.curve : null;
    expect(curve?.segments).toEqual([{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }, { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }]);
    expect([curve?.endCycles, curve?.end, curve?.applicability, curve?.source]).toEqual([1e8, 'cutoff-at-end', applicability, source]);
    expect(JSON.stringify(restored.document.beamAnalysisInputs)).not.toMatch(/"(?:damage|life|result|cycles)"/u);
    expect(kind === 'part' ? serializeDocument(parsePart(serialized), WRITE_OPTIONS)
      : writeAssemblyDocument(parseAssembly(serialized), WRITE_OPTIONS)).toBe(serialized);
  });

  it('keeps a cold-read single-slope version 2 input unchanged', () => {
    const part = createEmptyPartDocument();
    const text = replaceAttachment(serializeDocument(part, WRITE_OPTIONS), attachment({ kind: 'fatigue', definition: stressSaved(part.id) }));
    const restored = parseDocument(text);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue', definition: stressSaved(part.id) }]);
  });

  it('keeps calibrated values through actual Undo/Redo and a fresh serialized reopen', () => {
    const part = createEmptyPartDocument();
    const first = withBeamAnalysisInputs(part, attachment({ kind: 'fatigue-piecewise', definition: piecewiseSaved(part.id) }));
    const second = withBeamAnalysisInputs(part, attachment({ kind: 'fatigue-piecewise', definition: piecewiseSaved(part.id, 'none') }));
    const history = pushUndo(createUndoStack(first), second);
    const previous = undo(history);
    expect(previous.present.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-piecewise', definition: piecewiseSaved(part.id) }]);
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue-piecewise', definition: piecewiseSaved(part.id, 'none') }]);
  });

  it('refuses a second fatigue configuration and an invalid stored calibration on cold read', () => {
    const part = createEmptyPartDocument();
    const twice = replaceAttachment(serializeDocument(part, WRITE_OPTIONS), attachment(
      { kind: 'fatigue', definition: stressSaved(part.id) }, { kind: 'fatigue-piecewise', definition: piecewiseSaved(part.id) }));
    expect(parseDocument(twice).ok).toBe(false);
    const broken = piecewiseSaved(part.id);
    const discontinuous = { ...broken, input: { ...broken.input, curve: { ...broken.input.curve,
      segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }, { fromStressMpa: 210, fromCycles: 8e5, slope: 5 }] } } };
    const text = replaceAttachment(serializeDocument(part, WRITE_OPTIONS), attachment({ kind: 'fatigue-piecewise', definition: discontinuous }));
    expect(parseDocument(text).ok).toBe(false);
  });
});
