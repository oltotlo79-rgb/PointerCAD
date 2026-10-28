import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { readBeamAnalysisInputs, type BeamAnalysisInput } from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { savedBoltFixture } from '../../../model/src/analysis/cadNativeBoltPreloadInput.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const OPTIONS = { savedAt: '2026-10-27T00:00:00.000Z' };
type Owner = 'part' | 'assembly';
interface PersistenceCase {
  readonly owners: readonly Owner[];
  readonly make: (documentId: string) => unknown;
}

// 既存保存fixtureの独立入力。実材料の校正値や解析結果ではない。
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured persistence input' };
const curve = { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only',
  referenceStressMpa: 100, referenceCycles: 1e6, slope: 3, cutoffStressMpa: null, source };
const histories = [{ id: 'history', unit: 'MPa', stressMpa: [-80, 80], sequence: 'repeated-periodic', repeats: 1, source }];
const material = { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200000, fatigueStrengthCoefficientMpa: 1000,
  fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
  calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source };
const mesh = { linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
function solid(documentId: string) {
  return { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId }, bodyFeatureId: 'box',
    fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 205000, poisson: 0.3, tractionMPa: [0, 0, -1], ...mesh };
}

// 現unionを鍵にする。追加kindの未登録や所有条件の暗黙fallbackを許さない。
const cases: Readonly<Record<BeamAnalysisInput['kind'], PersistenceCase>> = {
  manual: { owners: ['part', 'assembly'], make: documentId => {
    const f = beamCadFixture();
    return { kind: 'manual', document: { schema: 'pointercad-beam/1', id: 'manual-input', revision: 1,
      source: { ...f.stamp, documentId }, units: 'N-mm',
      nodes: [{ id: 'base', position: [0, 0, 0] }, { id: 'tip', position: [0, 0, 2000] }],
      members: [{ id: 'beam', componentId: 'explicit', occurrencePath: ['explicit'], startNodeId: 'base', endNodeId: 'tip',
        materialId: 'elastic', sectionId: 'rectangle', localYHint: [1, 0, 0] }],
      materials: f.definition.materials, sections: f.definition.sections, constraints: f.definition.constraints, loads: f.definition.loads } };
  } },
  'standard-members': { owners: ['assembly'], make: documentId => {
    const f = beamCadFixture();
    return { kind: 'standard-members', definition: { ...f.definition, source: { ...f.stamp, documentId } } };
  } },
  'native-bolt-preload': { owners: ['assembly'], make: documentId => {
    const f = savedBoltFixture();
    const stamp = { ...f.saved.source, documentId };
    const bolts = f.saved.cadDefinition.axialBolts;
    if (bolts === undefined) throw new Error('Expected actual native bolt input association');
    return { kind: 'native-bolt-preload', definition: { ...f.saved, source: stamp,
      cadDefinition: { ...f.saved.cadDefinition, source: stamp, axialBolts: { ...bolts, source: stamp } },
      input: { ...f.saved.input, source: stamp } } };
  } },
  'plastic-bar': { owners: ['part', 'assembly'], make: documentId => ({ kind: 'plastic-bar', definition: {
    schema: 'pointercad-plastic-bar-input/1', id: 'plastic-bar', source: { documentId }, units: 'N-mm',
    lengthMm: 1000, areaMm2: 100, youngModulusMPa: 200000, poisson: 0.3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
    materialSource: { kind: 'user-supplied', reference: 'Test benchmark constants, not a material specification' },
    endDisplacementMm: [0, 2.5, 0, -2.5, 0], stepsPerSegment: 1 } }) },
  fatigue: { owners: ['part', 'assembly'], make: documentId => ({ kind: 'fatigue', definition: {
    schema: 'pointercad-fatigue-saved/2', id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve, histories } } }) },
  'fatigue-proportional-tensor': { owners: ['part', 'assembly'], make: documentId => ({ kind: 'fatigue-proportional-tensor', definition: {
    schema: 'pointercad-fatigue-saved/4', id: 'fatigue', source: { documentId },
    input: { schema: 'pointercad-fatigue-proportional-tensor/1', method: 'proportional-elastic-signed-von-mises-absolute-largest-principal/1',
      curve: { ...curve, stressDefinition: 'range', meanStressAssumption: 'mean-independent' },
      histories: [{ id: 'history', reference: { unit: 'MPa', components: 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy',
        xx: 0.1, yy: -33.3, zz: 0, yz: 1e-7, xz: 2.5, xy: -0.3 }, loadFactors: [0, 0.0015, -0.7, 1],
        sequence: 'repeated-periodic', repeats: 10, source }] } } }) },
  'fatigue-solid-proportional': { owners: ['part'], make: documentId => ({ kind: 'fatigue-solid-proportional', definition: {
    schema: 'pointercad-fatigue-solid-saved/1', id: 'fatigue', source: { documentId, revision: 9, meshKey: 'mesh:9' },
    inputSha256: 'c'.repeat(64), elementIndex: 0, historyId: 'tet0', loadFactors: [0, 1, -0.7, 0.0015],
    sequence: 'repeated-periodic', repeats: 10, reference: 'Explicit load sequence',
    curve: { ...curve, stressDefinition: 'range', meanStressAssumption: 'mean-independent' } } }) },
  'fatigue-piecewise': { owners: ['part', 'assembly'], make: documentId => ({ kind: 'fatigue-piecewise', definition: {
    schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId },
    input: { schema: 'pointercad-fatigue-piecewise/1', curve: { id: 'two-slope', unit: 'MPa', stressDefinition: 'range',
      meanStressAssumption: 'fully-reversed-only', segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 },
        { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }], endCycles: 1e8, end: 'cutoff-at-end',
      applicability: { material: 'synthetic', detail: 'synthetic', scope: 'unit test only' }, source }, histories } } }) },
  'fatigue-strain-life': { owners: ['part', 'assembly'], make: documentId => ({ kind: 'fatigue-strain-life', definition: {
    schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material,
      histories: [{ id: 'measured', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-0.0078125, 0.0078125, -0.00390625], sequence: 'once', repeats: 1, source }] } } }) },
  'fatigue-local-cycle': { owners: ['part', 'assembly'], make: documentId => ({ kind: 'fatigue-local-cycle', definition: {
    schema: 'pointercad-fatigue-local-cycle-saved/1', id: 'fatigue-local-cycle', source: { documentId },
    input: { schema: 'pointercad-strain-life-local-cycle/1', correction: 'swt', material,
      cycle: { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: 'elastic-plastic-analysis',
        strainMax: 0.01, strainMin: -0.01, stressMax: 500, stressMin: -300, source } } } }) },
  'solid-cad': { owners: ['part'], make: documentId => ({ kind: 'solid-cad', definition: solid(documentId) }) },
  'solid-plastic-cad': { owners: ['part'], make: documentId => ({ kind: 'solid-plastic-cad', definition: {
    schema: 'pointercad-solid-plastic-cad-input/1', id: 'solid-plastic-cad', source: { documentId }, bodyFeatureId: 'box',
    fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 200000, poisson: 0.3,
    yieldStressMPa: 250, hardeningModulusMPa: 2000, materialReference: 'Independent test constants; not a grade specification',
    tractionMPa: [0, 0, -2], loadFactor: [0, 1, 0, -1, 0], stepsPerSegment: 4, ...mesh } }) },
  'solid-modal-cad': { owners: ['part'], make: documentId => ({ kind: 'solid-modal-cad', definition: {
    schema: 'pointercad-solid-modal-cad-input/1', id: 'solid-modal-cad', source: { documentId }, bodyFeatureId: 'box',
    fixedFaces: ['fixed-origin'], youngMPa: 205000, poisson: 0.3, densityKgM3: 7850, modeCount: 6, ...mesh } }) },
  'solid-buckling-cad': { owners: ['part'], make: documentId => ({ kind: 'solid-buckling-cad', definition: {
    schema: 'pointercad-solid-buckling-cad-input/1', id: 'solid-buckling-cad', source: { documentId }, modeCount: 3,
    reference: solid(documentId) } }) },
};

function attachment(row: unknown) {
  return { schema: 'pointercad-beam-inputs/1', analyses: [row] };
}
function boundary(owner: Owner) {
  const part = createEmptyPartDocument();
  const assembly = beamCadFixture().document;
  // 型外の入力もcanonical parserのある実writerへ渡す。元文書は変更しない。
  return {
    id: owner === 'part' ? part.id : assembly.id,
    original: () => owner === 'part' ? serializeDocument(part, OPTIONS) : writeAssemblyDocument(assembly, OPTIONS),
    write: (value: unknown) => {
      if (owner === 'part') {
        const edited = { ...part };
        Reflect.set(edited, 'beamAnalysisInputs', value);
        return serializeDocument(edited, OPTIONS);
      }
      const edited = { ...assembly };
      Reflect.set(edited, 'beamAnalysisInputs', value);
      return writeAssemblyDocument(edited, OPTIONS);
    },
    read: (text: string) => owner === 'part' ? parseDocument(text) : readAssemblyDocument(text),
    rewrite: (text: string) => {
      if (owner === 'part') {
        const opened = parseDocument(text);
        if (!opened.ok) throw new Error(opened.error.message);
        return serializeDocument(opened.document, OPTIONS);
      }
      const opened = readAssemblyDocument(text);
      if (!opened.ok) throw new Error(opened.error.message);
      return writeAssemblyDocument(opened.document, OPTIONS);
    },
  };
}
function replaceAttachment(text: string, value: unknown): string {
  const envelope: unknown = JSON.parse(text);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected actual PCAD envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}
function payload(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) throw new Error('Expected independent input row');
  const value = row.kind === 'manual' ? row.document : row.definition;
  if (!isRecord(value)) throw new Error('Expected independent input definition');
  return value;
}
function replaceFirstNumber(value: unknown, number: number): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'number') return Reflect.set(value, key, number);
    if (replaceFirstNumber(child, number)) return true;
  }
  return false;
}

describe('current analysis kind persistence and owner matrix', () => {
  for (const [kind, fixture] of Object.entries(cases)) {
    it.each(['part', 'assembly'] as const)(`${kind}: actual %s writer/reader with fixed savedAt`, owner => {
      const b = boundary(owner);
      const before = b.original();
      const input = attachment(fixture.make(b.id));
      const independent = structuredClone(input);
      const checked = readBeamAnalysisInputs(input, b.id);
      expect(checked.ok).toBe(true);
      if (!fixture.owners.includes(owner)) {
        expect(() => b.write(input)).toThrow(/part|assembly/u);
        expect(b.read(replaceAttachment(before, input)).ok).toBe(false);
      } else {
        const text = b.write(input);
        const opened = b.read(text);
        if (!opened.ok) throw new Error(opened.error.message);
        expect(opened.document.beamAnalysisInputs).toEqual(independent);
        expect(b.rewrite(text)).toBe(text);
        const envelope: unknown = JSON.parse(text);
        expect(envelope).toHaveProperty('savedAt', OPTIONS.savedAt);
        expect(JSON.stringify(opened.document.beamAnalysisInputs)).not.toMatch(/"(?:results?|displacementM|reactionN|damage|life|frequencyHz|worldPlacement)"\s*:/u);
      }
      expect(input).toEqual(independent);
      expect(b.original()).toBe(before);
    });

    it(`${kind}: rejects corrupt kind/version/result/owner/numbers without changing document bytes`, () => {
      for (const owner of fixture.owners) {
        const b = boundary(owner);
        const before = b.original();
        const row = fixture.make(b.id);
        if (!isRecord(row)) throw new Error('Expected fixture row');
        const wrongVersion = structuredClone(row);
        Reflect.set(payload(wrongVersion), 'schema', 'unsupported-analysis-version/999');
        const result = structuredClone(row);
        Reflect.set(payload(result), 'result', { displacementM: [1, 2, 3] });
        const invalid: unknown[] = [
          attachment({ ...row, kind: 'unknown-analysis-kind' }), attachment(wrongVersion), attachment(result),
          attachment({ ...row, result: {} }),
          attachment(fixture.make('foreign-document')),
          { ...attachment(row), schema: 'pointercad-beam-inputs/999' },
          { ...attachment(row), results: [] },
        ];
        for (const number of [NaN, Infinity, -Infinity]) {
          const nonFinite = structuredClone(row);
          expect(replaceFirstNumber(payload(nonFinite), number)).toBe(true);
          invalid.push(attachment(nonFinite));
        }
        for (const value of invalid) {
          expect(() => b.write(value)).toThrow();
          // JSONの非有限値はnullになるため、読取側でも不正値の拒否を確認する。
          const text = replaceAttachment(before, value);
          const opened = b.read(text);
          expect(opened.ok).toBe(false);
          if (!opened.ok) expect(opened.error.code).toBe('invalidField');
          expect(b.original()).toBe(before);
        }
      }
    });
  }
});
