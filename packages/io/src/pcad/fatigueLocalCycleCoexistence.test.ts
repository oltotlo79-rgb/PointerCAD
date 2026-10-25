import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { readBeamAnalysisInputs, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

/* The saved local cycle beside the inputs that already exist in documents: the legacy stress-life `fatigue` input
 * (version 3 with its Goodman correction) and the zero-mean strain histories. All values are synthetic and written out
 * here (manufactured coefficients, not a real material), independent of the readers. */
const WRITE_OPTIONS = { savedAt: '2026-10-19T00:00:00.000Z' };
const source = { kind: 'user-supplied', reference: 'synthetic coexistence fixture', condition: 'manufactured values only' };
const material = { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
  fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
  calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source };
function localCycle(documentId: string) {
  return { schema: 'pointercad-fatigue-local-cycle-saved/1', id: 'fatigue-local-cycle', source: { documentId },
    input: { schema: 'pointercad-strain-life-local-cycle/1', correction: 'morrow', material,
      cycle: { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: 'measured',
        strainMax: 0.004, strainMin: -0.002, stressMax: 320, stressMin: -180, source } } };
}
function strainHistories(documentId: string) {
  return { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material,
      histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-0.0078125, 0.0078125], sequence: 'repeated-periodic', repeats: 10, source }] } };
}
function stressLifeV3(documentId: string) {
  return { schema: 'pointercad-fatigue-saved/3', id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: null, source }, histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [150, 250],
      sequence: 'repeated-periodic', repeats: 1, source }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 1001, source } };
}
const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
const existing = (documentId: string): unknown[] => [{ kind: 'fatigue', definition: stressLifeV3(documentId) },
  { kind: 'fatigue-strain-life', definition: strainHistories(documentId) }];

type Owner = 'part' | 'assembly';
type Opened = ReturnType<typeof parseDocument>;
/** One owner document per case (ids are created per document), written and read through the actual file readers. */
function ownerFile(owner: Owner) {
  const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
  const id = owner === 'part' ? part.id : assembly.id;
  const write = (value: unknown): string => owner === 'part' ? serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS)
    : writeAssemblyDocument(withBeamAnalysisInputs(assembly, value), WRITE_OPTIONS);
  const open = (text: string): Opened | ReturnType<typeof readAssemblyDocument> =>
    owner === 'part' ? parseDocument(text) : readAssemblyDocument(text);
  const read = (text: string) => {
    const opened = open(text);
    if (!opened.ok) throw new Error(opened.error.message);
    return opened.document;
  };
  const rewrite = (text: string): string => {
    if (owner === 'part') {
      const opened = parseDocument(text);
      if (!opened.ok) throw new Error(opened.error.message);
      return serializeDocument(opened.document, WRITE_OPTIONS);
    }
    const opened = readAssemblyDocument(text);
    if (!opened.ok) throw new Error(opened.error.message);
    return writeAssemblyDocument(opened.document, WRITE_OPTIONS);
  };
  const edit = (value: unknown): void => { withBeamAnalysisInputs(owner === 'part' ? part : assembly, value); };
  return { id, write, open, read, rewrite, edit };
}
function withAttachment(serialized: string, value: unknown): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}

describe('local-cycle input beside existing fatigue inputs in cold part and assembly files', () => {
  it.each(['part', 'assembly'] as const)('keeps the stress-life v3 and strain-history inputs of a %s unchanged', owner => {
    const file = ownerFile(owner);
    const before = file.write(attachment(...existing(file.id)));
    const value = attachment(...existing(file.id), { kind: 'fatigue-local-cycle', definition: localCycle(file.id) });
    const serialized = file.write(value);
    const reopened = file.read(serialized);
    expect(reopened.beamAnalysisInputs).toEqual(value);
    expect(reopened.beamAnalysisInputs?.analyses.map(input => input.kind)).toEqual(['fatigue', 'fatigue-strain-life', 'fatigue-local-cycle']);
    // A fresh read writes the same bytes, and dropping the local cycle again gives the earlier file byte for byte.
    expect(file.rewrite(serialized)).toBe(serialized);
    const without = reopened.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue-local-cycle') ?? [];
    expect(file.write(attachment(...without))).toBe(before);
    expect(JSON.stringify(reopened.beamAnalysisInputs)).not.toMatch(/"(?:cyclesToFailure|reversalsToFailure|damage|swtParameterMpa|result)"/u);
  });

  it.each(['part', 'assembly'] as const)('refuses a second local cycle in a %s file', owner => {
    const file = ownerFile(owner);
    const original = file.write(attachment(...existing(file.id)));
    const twice = attachment(...existing(file.id), { kind: 'fatigue-local-cycle', definition: localCycle(file.id) },
      { kind: 'fatigue-local-cycle', definition: localCycle(file.id) });
    expect(file.open(withAttachment(original, twice)).ok).toBe(false);
    expect(() => { file.edit(twice); }).toThrow();
    expect(file.read(original).beamAnalysisInputs).toEqual(attachment(...existing(file.id)));
  });

  it.each(['part', 'assembly'] as const)('refuses a local cycle saved for another document in a %s file', owner => {
    const file = ownerFile(owner);
    const foreign = attachment(...existing(file.id), { kind: 'fatigue-local-cycle', definition: localCycle(`${file.id}-other`) });
    expect(file.open(withAttachment(file.write(attachment(...existing(file.id))), foreign)).ok).toBe(false);
    const checked = readBeamAnalysisInputs(foreign, file.id);
    expect(checked.ok ? null : checked.issue.code).toBe('wrong-document');
    expect(() => { file.edit(foreign); }).toThrow();
  });
});
