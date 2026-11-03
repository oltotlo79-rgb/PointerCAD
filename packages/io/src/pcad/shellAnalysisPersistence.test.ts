import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { readPcadFile, writePcadFile } from './pcadFile.js';
import { PCAD_DOCUMENT_ENTRY } from './pcadFile.js';
import { replaceAttachment } from './analysisAttachment.testSupport.js';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { beamCadFixture } from '@pointercad/model/testing/analysis-fixtures';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { face, edge, vertex, shellAnalysisInput as input } from './shellAnalysisPersistence.testSupport.js';

const attachment = (value: unknown) => ({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'shell-cad-analysis', definition: value }] });

describe('complete shell analysis persistence', () => {
  it('round trips independent literal settings through the actual pcad codec with no result', () => {
    const part = createEmptyPartDocument(), value = attachment(input(part.id));
    const bytes = writePcadFile(withBeamAnalysisInputs(part, value), { savedAt: '2026-11-01T00:00:00.000Z' });
    const reopened = readPcadFile(bytes);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(value);
    expect(JSON.stringify(reopened.document.beamAnalysisInputs)).not.toMatch(/"(?:result|results|mesh|nodes|triangles)"\s*:/u);
    expect(writePcadFile(reopened.document, { savedAt: '2026-11-01T00:00:00.000Z' })).toEqual(bytes);
  });
  it('rejects malformed, stale, duplicate, sparse and result-bearing conditions', () => {
    const part = createEmptyPartDocument(), good = input(part.id), sparse = new Array<unknown>(1);
    const sparseForce = new Array<unknown>(3); sparseForce[0] = 1; sparseForce[2] = 3;
    expect(Object.hasOwn(sparseForce, 1)).toBe(false);
    const cases: unknown[] = [
      { ...good, schema: 'pointercad-shell-cad-analysis/2' },
      { ...good, source: { documentId: 'other' } },
      { ...good, geometry: { ...good.geometry, thicknessMm: 0 } },
      { ...good, geometry: { ...good.geometry, thicknessMm: -1 } },
      { ...good, geometry: { ...good.geometry, thicknessMm: NaN } },
      { ...good, material: { ...good.material, poisson: 0.5 } },
      { ...good, material: { ...good.material, poisson: -1 } },
      { ...good, material: { ...good.material, youngMPa: Infinity } },
      { ...good, supports: sparse },
      { ...good, supports: [good.supports[0], good.supports[0]] },
      { ...good, supports: [{ ...good.supports[0], kind: 'edge' }] },
      { ...good, supports: [{ ...good.supports[0], fixed: [false, false, false, false, false, false] }] },
      { ...good, edgeLoads: [good.edgeLoads[0], good.edgeLoads[0]] },
      { ...good, edgeLoads: [{ ...good.edgeLoads[0], origin: vertex }] },
      { ...good, edgeLoads: [{ ...good.edgeLoads[0], forceNPerMm: sparseForce }] },
      { ...good, geometry: { ...good.geometry, midsurfaceFaces: [] } },
      { ...good, geometry: { ...good.geometry, midsurfaceFaces: [face, face] } },
      { ...good, geometry: { ...good.geometry, midsurfaceFaces: [JSON.stringify({ bodyFeatureId: 'sheet', origin: edge })] } },
      { ...good, result: { displacement: [] } },
      { ...good, unexpected: true },
    ];
    for (const value of cases) {
      expect(readBeamAnalysisInputs(attachment(value), part.id).ok).toBe(false);
      expect(() => withBeamAnalysisInputs(part, attachment(value))).toThrow();
      // JSON has no NaN or holes: their serialized form becomes null and must also be rejected.
      const entries = unzipSync(writePcadFile(part, { savedAt: '2026-11-01T00:00:00.000Z' }));
      entries[PCAD_DOCUMENT_ENTRY] = strToU8(replaceAttachment(strFromU8(entries[PCAD_DOCUMENT_ENTRY]), attachment(value)));
      expect(readPcadFile(zipSync(entries)).ok).toBe(false);
    }
  });
  it('refuses the complete part-only configuration in an assembly codec', () => {
    const assembly = beamCadFixture().document, value = attachment(input(assembly.id));
    const checked = readBeamAnalysisInputs(value, assembly.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    const original = writeAssemblyDocument(assembly, { savedAt: '2026-11-01T00:00:00.000Z' });
    expect(readAssemblyDocument(replaceAttachment(original, value)).ok).toBe(false);
    expect(() => writeAssemblyDocument({ ...assembly, beamAnalysisInputs: checked.value },
      { savedAt: '2026-11-01T00:00:00.000Z' })).toThrow();
  });
});
