import { replaceAttachment } from './analysisAttachment.testSupport.js';
import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createEmptyPartDocument } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type ShellCadSavedInput,
  type SolidCadSavedInput } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '@pointercad/model/testing/analysis-fixtures';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';
import { PCAD_DOCUMENT_ENTRY, readPcadFile, writePcadFile } from './pcadFile.js';

const WRITE_OPTIONS = { savedAt: '2026-11-01T00:00:00.000Z' };
const FIELDS = ['schema', 'id', 'source', 'bodyFeatureId', 'midsurfaceFaces', 'thicknessMm', 'offsetMm'];
// Saved midsurface keys in the solidCadFaceKey form, written out by hand: to the reader they are opaque saved text.
const TOP = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"top"},"shapeKind":"face","version":1}}';
const BOTTOM = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"bottom"},"shapeKind":"face","version":1}}';

function shell(ownerId: string, midsurfaceFaces: readonly string[] = [TOP], thicknessMm = 2, offsetMm = 0): ShellCadSavedInput {
  return { schema: 'pointercad-shell-cad-input/1', id: 'shell-cad', source: { documentId: ownerId }, bodyFeatureId: 'sheet',
    midsurfaceFaces, thicknessMm, offsetMm };
}
function staticInput(ownerId: string): SolidCadSavedInput {
  return { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: ownerId },
    bodyFeatureId: 'box', fixedFaces: ['{"face":1}'], loadedFaces: ['{"face":2}'], youngMPa: 205000, poisson: 0.3,
    tractionMPa: [0, 0, -1], linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
}
const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
function envelopeOf(text: string): Record<string, unknown> & { document: Record<string, unknown> } {
  const envelope: unknown = JSON.parse(text);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return { ...envelope, document: envelope.document };
}
/** The attachment as saved in the document.json entry of an actual .pcad archive. */
function archivedInputs(bytes: Uint8Array): unknown {
  return envelopeOf(strFromU8(unzipSync(bytes)[PCAD_DOCUMENT_ENTRY])).document.beamAnalysisInputs;
}
/** The same archive with its document.json attachment replaced; the reader must refuse a bad one. */
function injected(bytes: Uint8Array, value: unknown): Uint8Array {
  const entries = unzipSync(bytes);
  entries[PCAD_DOCUMENT_ENTRY] = strToU8(replaceAttachment(strFromU8(entries[PCAD_DOCUMENT_ENTRY]), value));
  return zipSync(entries);
}

describe('shell CAD input in actual .pcad persistence (part documents only)', () => {
  it('writePcadFile/readPcadFile: one midsurface face, thickness and offset 0 reopen equal, deterministic and with nothing derived', () => {
    const part = createEmptyPartDocument();
    const value = attachment({ kind: 'shell-cad', definition: shell(part.id) });
    const independent = structuredClone(value);
    const bytes = writePcadFile(withBeamAnalysisInputs(part, value), WRITE_OPTIONS);
    const opened = readPcadFile(bytes);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.document.beamAnalysisInputs).toEqual(independent);
    expect(archivedInputs(bytes)).toEqual(independent);
    expect(JSON.stringify(archivedInputs(bytes))).not.toMatch(/"(?:normals?|mesh|triangles?|elements|nodes|results?|shiftMm|youngMPa)"\s*:/u);
    expect(writePcadFile(opened.document, WRITE_OPTIONS)).toEqual(bytes);
    expect(value).toEqual(independent);
  });

  it('writePcadFile/readPcadFile: two faces keep their saved order, a signed offset and the analysis order beside a static input', () => {
    const part = createEmptyPartDocument();
    const value = attachment({ kind: 'solid-cad', definition: staticInput(part.id) },
      { kind: 'shell-cad', definition: shell(part.id, [BOTTOM, TOP], 1.25, -0.625) });
    const bytes = writePcadFile(withBeamAnalysisInputs(part, value), WRITE_OPTIONS);
    const opened = readPcadFile(bytes);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.document.beamAnalysisInputs).toEqual(value);
    const analyses = opened.document.beamAnalysisInputs?.analyses ?? [];
    expect(analyses.map(row => row.kind)).toEqual(['solid-cad', 'shell-cad']);
    const reopened = analyses.find(row => row.kind === 'shell-cad');
    if (reopened?.kind !== 'shell-cad') throw new Error('Expected the reopened shell input');
    expect(Object.keys(reopened.definition)).toEqual(FIELDS);
    expect(reopened.definition.midsurfaceFaces).toEqual([BOTTOM, TOP]);
    expect([reopened.definition.bodyFeatureId, reopened.definition.source.documentId, reopened.definition.thicknessMm,
      reopened.definition.offsetMm]).toEqual(['sheet', part.id, 1.25, -0.625]);
    expect(writePcadFile(opened.document, WRITE_OPTIONS)).toEqual(bytes);
  });

  it('serializeDocument/parseDocument: the JSON text reopens equal and serializes again to the same text', () => {
    const part = createEmptyPartDocument();
    const value = attachment({ kind: 'shell-cad', definition: shell(part.id, [TOP, BOTTOM], 3, 1.5) });
    const text = serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(value);
    expect(serializeDocument(reopened.document, WRITE_OPTIONS)).toBe(text);
  });

  it('refuses the shell input in an assembly document on both read and write', () => {
    const assembly = beamCadFixture().document;
    const value = attachment({ kind: 'shell-cad', definition: shell(assembly.id) });
    // The model reader accepts the input for this owner; only the io part-document rule refuses an assembly.
    const checked = readBeamAnalysisInputs(value, assembly.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    const written = writeAssemblyDocument(assembly, WRITE_OPTIONS);
    expect(readAssemblyDocument(written).ok).toBe(true);
    const opened = readAssemblyDocument(replaceAttachment(written, value));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe('invalidField');
    expect(() => writeAssemblyDocument({ ...assembly, beamAnalysisInputs: checked.value }, WRITE_OPTIONS)).toThrow(/part document/u);
  });

  it('refuses a bad or a second shell input in an actual .pcad archive and in the writer', () => {
    const part = createEmptyPartDocument();
    const raw = writePcadFile(part, WRITE_OPTIONS);
    const good = shell(part.id);
    expect(readPcadFile(injected(raw, attachment({ kind: 'shell-cad', definition: good }))).ok).toBe(true);
    for (const value of [
      attachment({ kind: 'shell-cad', definition: { ...good, thicknessMm: 0 } }),
      attachment({ kind: 'shell-cad', definition: { ...good, schema: 'pointercad-shell-cad-input/2' } }),
      attachment({ kind: 'shell-cad', definition: { ...good, normals: [[0, 0, 1]] } }),
      attachment({ kind: 'shell-cad', definition: { ...good, midsurfaceFaces: [] } }),
      attachment({ kind: 'shell-cad', definition: good }, { kind: 'shell-cad', definition: { ...good, thicknessMm: 3 } }),
      attachment({ kind: 'shell-cad', definition: shell('other-part') }),
    ]) {
      const opened = readPcadFile(injected(raw, value));
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error.code).toBe('invalidField');
      const edited = { ...part };
      Reflect.set(edited, 'beamAnalysisInputs', value);
      expect(() => serializeDocument(edited, WRITE_OPTIONS)).toThrow(RangeError);
    }
  });
});
