import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createEmptyPartDocument } from '@pointercad/model';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { PCAD_DOCUMENT_ENTRY, readPcadFile, writePcadFile } from './pcadFile.js';

const savedAt = '2026-10-20T00:00:00.000Z';
const source = { kind: 'user-supplied', reference: 'synthetic calibration', condition: 'unit test only' };
function definition(documentId: string, kind: 'weld' | 'bolt') {
  const weld = kind === 'weld';
  return { schema: 'pointercad-fatigue-saved/6', id: 'fatigue', source: { documentId }, input: {
    schema: 'pointercad-fatigue-detail/1',
    detail: weld ? { id: 'joint', kind: 'weld', method: 'fillet-weld-nominal-shear/1', loadPath: 'concentric-in-plane-shear',
      geometry: { kind: 'fillet-throat-area', throatMm: 4, effectiveLengthMm: 10, lines: 2 } }
      : { id: 'joint', kind: 'bolt', method: 'bolt-axial-nominal/1',
        geometry: { kind: 'iso-metric-thread-tensile-stress-area', nominalDiameterMm: 10, pitchMm: 1.5 } },
    loading: { detailId: 'joint', location: 'joint centroid', quantity: weld ? 'weld-group-concentric-shear-force' : 'bolt-total-axial-force',
      histories: [{ id: 'h1', unit: 'N', forceN: weld ? [100, -100, 0] : [100, 0, 200], sequence: 'once', repeats: 1, source }] },
    curve: { detailStress: weld ? 'weld-fillet-throat-nominal-shear' : 'bolt-axial-normal-tensile-stress-area',
      calibration: { id: 'curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
        segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }, { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }],
        endCycles: 1e8, end: 'none', applicability: { material: 'synthetic', detail: 'synthetic', scope: 'test' }, source } } } };
}
const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
function injected(bytes: Uint8Array, value: unknown): Uint8Array {
  const entries = unzipSync(bytes);
  const envelope = JSON.parse(strFromU8(entries[PCAD_DOCUMENT_ENTRY])) as { document: Record<string, unknown> };
  envelope.document.beamAnalysisInputs = value;
  entries[PCAD_DOCUMENT_ENTRY] = strToU8(JSON.stringify(envelope));
  return zipSync(entries);
}
describe('fatigue detail actual PCAD archive persistence', () => {
  it.each(['weld', 'bolt'] as const)('saves and reopens %s input without derived values', kind => {
    const part = createEmptyPartDocument();
    const value = attachment({ kind: 'fatigue-detail', definition: definition(part.id, kind) });
    const document = withBeamAnalysisInputs(part, value);
    const bytes = writePcadFile(document, { savedAt });
    const opened = readPcadFile(bytes);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.document.beamAnalysisInputs).toEqual(value);
    const archived = strFromU8(unzipSync(bytes)[PCAD_DOCUMENT_ENTRY]);
    expect(archived).not.toMatch(/"(?:areaMm2|stressHistories|damage|life|result)"\s*:/u);
    expect(writePcadFile(opened.document, { savedAt })).toEqual(bytes);
  });
  it('rejects old fatigue with detail and duplicate detail', () => {
    const part = createEmptyPartDocument(); const raw = writePcadFile(part, { savedAt });
    const detail = { kind: 'fatigue-detail', definition: definition(part.id, 'weld') };
    const legacy = { kind: 'fatigue', definition: { schema: 'pointercad-fatigue-saved/2', id: 'fatigue', source: { documentId: part.id }, axial: [],
      input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
        meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null, source },
      histories: [{ id: 'h', unit: 'MPa', stressMpa: [-80, 80], sequence: 'once', repeats: 1, source }] } } };
    expect(readPcadFile(injected(raw, attachment(legacy, detail))).ok).toBe(false);
    expect(readPcadFile(injected(raw, attachment(detail, detail))).ok).toBe(false);
  });
  it('rejects unknown saved and input schema and mismatched joint identity or stress definition', () => {
    const part = createEmptyPartDocument(); const raw = writePcadFile(part, { savedAt }); const good = definition(part.id, 'weld');
    const bad = [ { ...good, schema: 'pointercad-fatigue-saved/7' },
      { ...good, input: { ...good.input, schema: 'pointercad-fatigue-detail/2' } },
      { ...good, input: { ...good.input, loading: { ...good.input.loading, detailId: 'other' } } },
      { ...good, input: { ...good.input, curve: { ...good.input.curve, detailStress: 'bolt-axial-normal-nominal-shank-area' } } } ];
    for (const value of bad) expect(readPcadFile(injected(raw, attachment({ kind: 'fatigue-detail', definition: value }))).ok).toBe(false);
  });

  it.each(['fatigue', 'fatigue-piecewise'] as const)('legacy coexistence: %s with strain-life and local-cycle', kind => {
    const part = createEmptyPartDocument();
    const curve = { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only',
      referenceStressMpa: 100, referenceCycles: 1e6, slope: 3, cutoffStressMpa: null, source };
    const histories = [{ id: 'h', unit: 'MPa', stressMpa: [-80, 80], sequence: 'once', repeats: 1, source }];
    const fatigue = kind === 'fatigue' ? { kind, definition: { schema: 'pointercad-fatigue-saved/2', id: 'fatigue', source: { documentId: part.id }, axial: [],
      input: { schema: 'pointercad-fatigue/1', curve, histories } } } : { kind, definition: { schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId: part.id },
      input: { schema: 'pointercad-fatigue-piecewise/1', curve: { id: 'two-slope', unit: 'MPa', stressDefinition: 'range',
        meanStressAssumption: 'fully-reversed-only', segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 },
          { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }], endCycles: 1e8, end: 'none',
        applicability: { material: 'synthetic', detail: 'synthetic', scope: 'unit test only' }, source }, histories } } };
    const material = { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200000, fatigueStrengthCoefficientMpa: 1000,
      fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
      calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source };
    const strain = { kind: 'fatigue-strain-life', definition: { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId: part.id },
      input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material,
        histories: [{ id: 'measured', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
          strain: [-0.0078125, 0.0078125, -0.00390625], sequence: 'once', repeats: 1, source }] } } };
    const local = { kind: 'fatigue-local-cycle', definition: { schema: 'pointercad-fatigue-local-cycle-saved/1', id: 'fatigue-local-cycle', source: { documentId: part.id },
      input: { schema: 'pointercad-strain-life-local-cycle/1', correction: 'swt', material,
        cycle: { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: 'elastic-plastic-analysis',
          strainMax: 0.01, strainMin: -0.01, stressMax: 500, stressMin: -300, source } } } };
    for (const other of [strain, local]) {
      const input = attachment(fatigue, other); const edited = withBeamAnalysisInputs(part, input);
      const opened = readPcadFile(writePcadFile(edited, { savedAt }));
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.document.beamAnalysisInputs).toEqual(input);
    }
  });
});
