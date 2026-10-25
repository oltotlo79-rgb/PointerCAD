import { buildStandardPartFromSource, createStandardPartSource, steelProducts, steelProductOptions, type CutFeature } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createUndoStack, pushUndo, redo, undo } from '@pointercad/model';
import {
  readBeamAnalysisInputs, withBeamAnalysisInputs,
  type BeamAnalysisDocument, type BeamAnalysisInputs,
  type FatigueSavedInput,
} from '@pointercad/model/beam-analysis';
import { beamCadFixture } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';
import { findStrengthMaterial, STRENGTH_SOURCES } from '@pointercad/model';
import type { AnalysisMaterialCapacity, SolidCadSavedInput } from '@pointercad/model/beam-analysis';

const WRITE_OPTIONS = { savedAt: '2026-10-10T00:00:00.000Z' };

function manualInputs(ownerId: string): BeamAnalysisInputs {
  const fixture = beamCadFixture();
  const document: BeamAnalysisDocument = {
    schema: 'pointercad-beam/1', id: 'manual-input', revision: 1,
    source: { ...fixture.stamp, documentId: ownerId }, units: 'N-mm',
    nodes: [{ id: 'base', position: [0, 0, 0] }, { id: 'tip', position: [0, 0, 2000] }],
    members: [{
      id: 'manual-beam', componentId: 'explicit', occurrencePath: ['explicit'],
      startNodeId: 'base', endNodeId: 'tip', materialId: 'elastic', sectionId: 'rectangle', localYHint: [1, 0, 0],
    }],
    materials: fixture.definition.materials, sections: fixture.definition.sections,
    constraints: fixture.definition.constraints, loads: fixture.definition.loads,
  };
  return { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'manual', document }] };
}

function replaceAttachment(serialized: string, value: unknown): string {
  const envelope: unknown = JSON.parse(serialized);
  if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
  return JSON.stringify({ ...envelope, document: { ...envelope.document, beamAnalysisInputs: value } });
}

describe('versioned beam inputs in part and assembly persistence', () => {
  it('keeps old documents without the optional attachment compatible and absent on write', () => {
    const part = createEmptyPartDocument();
    const partText = serializeDocument(part, WRITE_OPTIONS);
    expect(partText).not.toContain('beamAnalysisInputs');
    const partRead = parseDocument(partText);
    expect(partRead.ok).toBe(true);
    if (!partRead.ok) throw new Error(partRead.error.message);
    expect(partRead.document).toEqual(part);
    const assembly = beamCadFixture().document;
    const assemblyText = writeAssemblyDocument(assembly, WRITE_OPTIONS);
    expect(assemblyText).not.toContain('beamAnalysisInputs');
    const assemblyRead = readAssemblyDocument(assemblyText);
    expect(assemblyRead.ok).toBe(true);
    if (!assemblyRead.ok) throw new Error(assemblyRead.error.message);
    expect(assemblyRead.document).toEqual(assembly);
  });

  it('round-trips manual part inputs and preserves provenance and units deterministically', () => {
    const part = createEmptyPartDocument();
    const edited = withBeamAnalysisInputs(part, manualInputs(part.id));
    const serialized = serializeDocument(edited, WRITE_OPTIONS);
    const restored = parseDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(edited.beamAnalysisInputs);
    expect(serializeDocument(restored.document, WRITE_OPTIONS)).toBe(serialized);
  });

  it('round-trips mixed manual and CAD inputs without saving solved world nodes or results', () => {
    const fixture = beamCadFixture();
    const inputs: BeamAnalysisInputs = {
      schema: 'pointercad-beam-inputs/1', analyses: [
        ...manualInputs(fixture.document.id).analyses,
        { kind: 'standard-members', definition: fixture.definition },
      ],
    };
    const edited = withBeamAnalysisInputs(fixture.document, inputs);
    const serialized = writeAssemblyDocument(edited, WRITE_OPTIONS);
    const restored = readAssemblyDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(inputs);
    expect(writeAssemblyDocument(restored.document, WRITE_OPTIONS)).toBe(serialized);
    const cad = restored.document.beamAnalysisInputs?.analyses.find(input => input.kind === 'standard-members');
    expect(cad).toBeDefined();
    expect(JSON.stringify(cad)).not.toMatch(/"(?:nodes|results|displacementM|worldPlacement)"/u);
  });

  it('owns nested inputs and preserves before/after snapshots through actual Undo and Redo', () => {
    const fixture = beamCadFixture();
    const caller = {
      schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: {
        ...fixture.definition, members: fixture.definition.members.map(member => ({
          ...member, occurrencePath: [...member.occurrencePath], sectionFrame: {
            ...member.sectionFrame, centroidMm: [...member.sectionFrame.centroidMm],
            source: { ...member.sectionFrame.source },
          },
        })),
      } }],
    };
    const first = withBeamAnalysisInputs(fixture.document, caller);
    const ownedText = writeAssemblyDocument(first, WRITE_OPTIONS);
    caller.analyses[0].definition.members[0].occurrencePath[0] = 'mutated';
    caller.analyses[0].definition.members[0].sectionFrame.centroidMm[0] = 999;
    caller.analyses[0].definition.members[0].sectionFrame.source.reference = 'mutated';
    expect(writeAssemblyDocument(first, WRITE_OPTIONS)).toBe(ownedText);
    expect(fixture.document.beamAnalysisInputs).toBeUndefined();
    const second = withBeamAnalysisInputs(first, { schema: 'pointercad-beam-inputs/1', analyses: [] });
    const initial = createUndoStack(fixture.document);
    const stack = pushUndo(pushUndo(initial, first, { now: 1 }), second, { now: 2 });
    expect(undo(stack).present).toBe(first);
    expect(undo(undo(stack)).present).toBe(fixture.document);
    expect(redo(undo(stack)).present).toBe(second);
    expect(writeAssemblyDocument(first, WRITE_OPTIONS)).toBe(ownedText);
  });

  it.each(['unknown-schema', 'unknown-field', 'wrong-owner', 'invalid-section', 'duplicate-analysis', 'null'])(
    'refuses %s in both part and assembly readers', kind => {
      const fixture = beamCadFixture();
      for (const owner of ['part', 'assembly']) {
        const part = createEmptyPartDocument();
        const document = owner === 'part' ? part : fixture.document;
        const valid = manualInputs(document.id);
        const input = valid.analyses[0];
        if (input.kind !== 'manual') throw new Error('Expected manual fixture');
        let invalid: unknown = valid;
        if (kind === 'unknown-schema') invalid = { ...valid, schema: 'pointercad-beam-inputs/2' };
        if (kind === 'unknown-field') invalid = { ...valid, results: [] };
        if (kind === 'wrong-owner') invalid = manualInputs('different-document');
        if (kind === 'invalid-section') invalid = { ...valid, analyses: [{ ...input, document: {
          ...input.document, sections: [{ ...input.document.sections[0], iy: -1 }],
        } }] };
        if (kind === 'duplicate-analysis') invalid = { ...valid, analyses: [input, input] };
        if (kind === 'null') invalid = null;
        const original = owner === 'part' ? serializeDocument(part, WRITE_OPTIONS) : writeAssemblyDocument(fixture.document, WRITE_OPTIONS);
        const changed = replaceAttachment(original, invalid);
        const result = owner === 'part' ? parseDocument(changed) : readAssemblyDocument(changed);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('invalidField');
          expect(result.error.message).toContain('beamAnalysisInputs');
        }
      }
    },
  );

  it('refuses a part attachment containing assembly occurrence associations', () => {
    const part = createEmptyPartDocument();
    const fixture = beamCadFixture();
    const input = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: {
      ...fixture.definition, source: { ...fixture.stamp, documentId: part.id },
    } }] };
    expect(parseDocument(replaceAttachment(serializeDocument(part, WRITE_OPTIONS), input)).ok).toBe(false);
    const checked = readBeamAnalysisInputs(input, part.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(() => serializeDocument({ ...part, beamAnalysisInputs: checked.value }, WRITE_OPTIONS)).toThrow(/assembly/u);
  });
});

describe('current schema combined purchased steel and persisted analysis inputs', () => {
  function steelPart() {
    const product = steelProducts('SS400', 'flatBar').find(row => row.size === 'FB 50×6');
    if (product === undefined) throw new Error('Missing actual steel product');
    const source = createStandardPartSource(product.catalog, product.size, {
      ...steelProductOptions(product), length: '2000',
    });
    const part = buildStandardPartFromSource(source);
    if (part === null) throw new Error('Actual steel generation failed');
    return { part, source };
  }

  it('keeps independent steel identity, purchased length, cut history and analysis input through the real codec', () => {
    const { part, source } = steelPart();
    const target = part.solids.at(-1)?.id;
    if (target === undefined) throw new Error('Missing generated steel feature');
    const cut: CutFeature = { id: 'steel-cut', name: 'cut', kind: 'cut', suppressed: false,
      targetFeatureId: target, pairedWith: null, keep: 'negative',
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(600) } };
    const inputs = manualInputs(part.id);
    const edited = withBeamAnalysisInputs({ ...part, solids: [...part.solids, cut] }, inputs);
    const text = serializeDocument(edited, WRITE_OPTIONS);
    const envelope: unknown = JSON.parse(text);
    if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Missing public envelope');
    expect(envelope.schema).toBe(PCAD_SCHEMA_VERSION);
    expect(envelope.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    const opened = parseDocument(text);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.document.steelStockSource?.catalog).toBe('flatBar');
    expect(opened.document.steelStockSource?.size).toBe('FB 50×6');
    expect(opened.document.steelStockSource?.options.length).toBe('2000');
    expect(opened.document.steelStockSource).toEqual(source);
    expect(opened.document.solids.at(-1)).toEqual(cut);
    expect(opened.document.beamAnalysisInputs).toEqual(inputs);
    expect(opened.document).toEqual(edited);
    expect(serializeDocument(opened.document, WRITE_OPTIONS)).toBe(text);
    expect(envelope.document).not.toHaveProperty('analysisResults');
    expect(envelope.document).not.toHaveProperty('beamSession');
  });

  it.each([18, 19])('upgrades schema%s without fabricating absent inputs and preserves present valid inputs', schema => {
    const empty = createEmptyPartDocument();
    const plain: unknown = JSON.parse(serializeDocument(empty, WRITE_OPTIONS));
    if (!isRecord(plain) || !isRecord(plain.document)) throw new Error('Missing public envelope');
    const legacy = { ...plain, schema, document: { ...plain.document, schemaVersion: schema } };
    const before = structuredClone(legacy);
    const absent = parseDocument(JSON.stringify(legacy));
    if (!absent.ok) throw new Error(absent.error.message);
    expect(absent.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    expect(Object.hasOwn(absent.document, 'beamAnalysisInputs')).toBe(false);
    expect(Object.hasOwn(absent.document, 'steelStockSource')).toBe(false);
    expect(absent.document).toEqual(empty);
    const inputs = manualInputs(empty.id);
    const present = parseDocument(JSON.stringify({ ...legacy,
      document: { ...legacy.document, beamAnalysisInputs: inputs } }));
    if (!present.ok) throw new Error(present.error.message);
    expect(present.document).toEqual({ ...empty, beamAnalysisInputs: inputs });
    expect(legacy).toEqual(before);
    const invalid = parseDocument(JSON.stringify({ ...legacy,
      document: { ...legacy.document, beamAnalysisInputs: { ...inputs, results: [] } } }));
    expect(invalid.ok).toBe(false);
  });

  it('preserves schema19 purchased provenance alongside valid inputs instead of overwriting either on migration', () => {
    const { part, source } = steelPart();
    const inputs = manualInputs(part.id);
    const current = withBeamAnalysisInputs(part, inputs);
    const raw: unknown = JSON.parse(serializeDocument(current, WRITE_OPTIONS));
    if (!isRecord(raw) || !isRecord(raw.document)) throw new Error('Missing public envelope');
    const opened = parseDocument(JSON.stringify({ ...raw, schema: 19,
      document: { ...raw.document, schemaVersion: 19 } }));
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.document.steelStockSource).toEqual(source);
    expect(opened.document.beamAnalysisInputs).toEqual(inputs);
    expect(opened.document).toEqual(current);
  });

  it('keeps assembly standard sources and rigid groups with inputs, refuses old-version writes and future formats', () => {
    const fixture = beamCadFixture();
    const assembly = { ...fixture.document, components: fixture.document.components.map(component => ({
      ...component, rigidGroupId: 'explicit-group',
    })) };
    const edited = withBeamAnalysisInputs(assembly, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'standard-members', definition: fixture.definition }] });
    const text = writeAssemblyDocument(edited, WRITE_OPTIONS);
    const opened = readAssemblyDocument(text);
    if (!opened.ok) throw new Error(opened.error.message);
    expect(opened.document.components[0].rigidGroupId).toBe('explicit-group');
    expect(opened.document.components[0].source).toEqual(assembly.components[0].source);
    expect(opened.document).toEqual(edited);
    expect(writeAssemblyDocument(opened.document, WRITE_OPTIONS)).toBe(text);
    for (const schemaVersion of [18, 19]) {
      expect(() => writeAssemblyDocument({ ...edited, schemaVersion }, WRITE_OPTIONS)).toThrow('schema 20');
      const part = createEmptyPartDocument();
      expect(() => serializeDocument({ ...withBeamAnalysisInputs(part, manualInputs(part.id)), schemaVersion }, WRITE_OPTIONS))
        .toThrow('schema 20');
    }
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || !isRecord(raw.document)) throw new Error('Missing public envelope');
    const future = readAssemblyDocument(JSON.stringify({ ...raw, schema: PCAD_SCHEMA_VERSION + 1, document: { ...raw.document, schemaVersion: PCAD_SCHEMA_VERSION + 1 } }));
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe('unsupportedNewVersion');
    expect(readAssemblyDocument(JSON.stringify({ ...raw, schema: 19 })).ok).toBe(false);
  });
});

function goodmanSaved(ownerId: string): Extract<FatigueSavedInput, { readonly schema: 'pointercad-fatigue-saved/3' }> {
  const source = { kind: 'user-supplied', reference: 'independent synthetic persistence fixture',
    condition: 'uniaxial elastic, symmetric yield, minimum 1001 cycles' } as const;
  return { schema: 'pointercad-fatigue-saved/3', id: 'fatigue', source: { documentId: ownerId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: null, source }, histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [150, 250],
      sequence: 'repeated-periodic', repeats: 1, source }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 1001, source } };
}

describe('Goodman fatigue saved version 3', () => {
  it.each(['part', 'assembly'] as const)('cold-round-trips %s correction and provenance without calculated results', kind => {
    const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
    const document = kind === 'part' ? part : assembly, definition = goodmanSaved(document.id);
    const value = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue', definition }] };
    const serialized = kind === 'part' ? serializeDocument(withBeamAnalysisInputs(part, value), WRITE_OPTIONS)
      : writeAssemblyDocument(withBeamAnalysisInputs(assembly, value), WRITE_OPTIONS);
    const restored = kind === 'part' ? parseDocument(serialized) : readAssemblyDocument(serialized);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.beamAnalysisInputs).toEqual(value);
    const fatigue = restored.document.beamAnalysisInputs?.analyses[0];
    if (fatigue?.kind !== 'fatigue' || fatigue.definition.schema !== 'pointercad-fatigue-saved/3') throw new Error('Expected v3');
    expect(fatigue.definition.correction).toEqual(definition.correction);
    expect(fatigue.definition.correction).not.toBe(definition.correction);
    expect(JSON.stringify(fatigue)).not.toMatch(/"(?:damage|life|result|cycles|equivalentStressMpa)"/u);
    // Re-encode the parsed object from a fresh read, not the original in-memory input.
    const second = kind === 'part' ? parseDocument(serialized) : readAssemblyDocument(serialized);
    if (!second.ok) throw new Error(second.error.message);
    expect(second.document.beamAnalysisInputs).toEqual(restored.document.beamAnalysisInputs);
    expect(kind === 'part' ? serializeDocument(parsePart(serialized), WRITE_OPTIONS)
      : writeAssemblyDocument(parseAssembly(serialized), WRITE_OPTIONS)).toBe(serialized);
  });

  it('preserves v1/v2 as uncorrected and never invents strengths on a cold read', () => {
    const part = createEmptyPartDocument(), current = goodmanSaved(part.id);
    const common = { id: current.id, source: current.source, input: current.input };
    const version2 = { ...common, schema: 'pointercad-fatigue-saved/2', axial: [] };
    for (const definition of [{ ...common, schema: 'pointercad-fatigue-saved/1' }, version2]) {
      const text = replaceAttachment(serializeDocument(part, WRITE_OPTIONS), {
        schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue', definition }],
      });
      const restored = parseDocument(text);
      if (!restored.ok) throw new Error(restored.error.message);
      const fatigue = restored.document.beamAnalysisInputs?.analyses[0];
      expect(fatigue?.kind === 'fatigue' ? fatigue.definition : null).toEqual(version2);
      expect(JSON.stringify(restored.document.beamAnalysisInputs)).not.toContain('correction');
    }
  });

  it('keeps correction values and source through actual Undo/Redo and a fresh serialized reopen', () => {
    const part = createEmptyPartDocument(), firstSaved = goodmanSaved(part.id);
    const first = withBeamAnalysisInputs(part, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue', definition: firstSaved }] });
    const secondSaved = { ...firstSaved, correction: { ...firstSaved.correction, ultimateTensileStrengthMpa: 500,
      source: { ...firstSaved.correction.source, reference: 'second independent source' } } };
    const second = withBeamAnalysisInputs(first, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue', definition: secondSaved }] });
    const stack = pushUndo(pushUndo(createUndoStack(part), first, { now: 1 }), second, { now: 2 });
    const previous = undo(stack);
    expect(previous.present.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue', definition: firstSaved }]);
    const reopened = parseDocument(serializeDocument(redo(previous).present, WRITE_OPTIONS));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs?.analyses).toEqual([{ kind: 'fatigue', definition: secondSaved }]);
    expect(undo(previous).present).toBe(part);
  });

  it.each(['unknown-method', 'missing-source', 'invalid-strength', 'legacy-injection', 'results-injection'])(
    'refuses %s in both actual document readers', kind => {
      const part = createEmptyPartDocument(), assembly = beamCadFixture().document;
      for (const owner of ['part', 'assembly']) {
        const document = owner === 'part' ? part : assembly, saved = goodmanSaved(document.id);
        let definition: unknown = saved;
        if (kind === 'unknown-method') definition = { ...saved, correction: { ...saved.correction, method: 'other' } };
        if (kind === 'missing-source') definition = { ...saved, correction: { ...saved.correction, source: null } };
        if (kind === 'invalid-strength') definition = { ...saved, correction: { ...saved.correction, yieldStrengthMpa: 401 } };
        if (kind === 'legacy-injection') definition = { ...saved, schema: 'pointercad-fatigue-saved/2' };
        if (kind === 'results-injection') definition = { ...saved, result: { damage: 0 } };
        const original = owner === 'part' ? serializeDocument(part, WRITE_OPTIONS) : writeAssemblyDocument(assembly, WRITE_OPTIONS);
        const text = replaceAttachment(original, { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue', definition }] });
        const read = owner === 'part' ? parseDocument(text) : readAssemblyDocument(text);
        expect(read.ok).toBe(false);
        if (!read.ok) expect(read.error.code).toBe('invalidField');
      }
    });
});

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

describe('FE material yield evidence through the actual part and assembly codecs', () => {
  const rows = [
    ['ss400-plate-0-16', 245, 'jisf-g3101-draft', 16],
    ['ss400-plate-16-40', 235, 'jisf-g3101-draft', 40],
    ['ss400-plate-40-100', 215, 'jisf-g3101-draft', 100],
    ['s45c-normalized-reference', 345, 'tsubaki-s45c', null],
    ['s45c-quenched-tempered-reference', 490, 'tsubaki-s45c', null],
  ] as const;
  function solidInput(ownerId: string): Extract<SolidCadSavedInput, { schema: 'pointercad-solid-cad-input/1' }> {
    return { schema: 'pointercad-solid-cad-input/1', id: 'solid-cad', source: { documentId: ownerId }, bodyFeatureId: 'body',
      fixedFaces: ['fixed-origin'], loadedFaces: ['loaded-origin'], youngMPa: 205000, poisson: 0.3, tractionMPa: [0, 0, -1],
      linearDeflectionMm: 0.1, angularDeflectionRad: 0.3, maximumChordDeviationMm: 0.2, maximumVolumeDeviationMm3: 1 };
  }
  it.each(rows)('round-trips beam and both solid load schemas with exact evidence: %s', (materialConditionId, yieldMPa, sourceId, thicknessMm) => {
    const preset = findStrengthMaterial(materialConditionId);
    if (preset === undefined) throw new Error('Missing W01 material');
    expect(preset.yieldStress.mpa).toBe(String(yieldMPa));
    expect(preset.yieldStress.sourceId).toBe(sourceId);
    const capacity: AnalysisMaterialCapacity = { materialConditionId, yieldMPa, sourceId, thicknessMm,
      condition: preset.condition, evidence: STRENGTH_SOURCES[sourceId].evidence, basis: preset.yieldStress.basis };
    const part = createEmptyPartDocument();
    const manual = manualInputs(part.id).analyses[0];
    if (manual.kind !== 'manual') throw new Error('Expected manual input');
    const inputs: BeamAnalysisInputs = { schema: 'pointercad-beam-inputs/1', analyses: [{ ...manual,
      document: { ...manual.document, materials: manual.document.materials.map(material => ({ ...material, capacity })) } }] };
    const text = serializeDocument(withBeamAnalysisInputs(part, inputs), WRITE_OPTIONS);
    const restored = parsePart(text);
    expect(restored.beamAnalysisInputs).toEqual(inputs);
    const beam = restored.beamAnalysisInputs?.analyses[0];
    if (beam?.kind !== 'manual') throw new Error('Missing reopened beam');
    expect(beam.document.materials[0].capacity).toEqual(capacity);
    expect(beam.document.materials[0].capacity).not.toBe(capacity);
    expect(serializeDocument(restored, WRITE_OPTIONS)).toBe(text);
    const fixture = beamCadFixture();
    const assemblyInputs: BeamAnalysisInputs = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members',
      definition: { ...fixture.definition, materials: fixture.definition.materials.map(material => ({ ...material, capacity })) } }] };
    const assemblyText = writeAssemblyDocument(withBeamAnalysisInputs(fixture.document, assemblyInputs), WRITE_OPTIONS);
    expect(parseAssembly(assemblyText).beamAnalysisInputs).toEqual(assemblyInputs);
    expect(writeAssemblyDocument(parseAssembly(assemblyText), WRITE_OPTIONS)).toBe(assemblyText);
    const { tractionMPa, ...common } = solidInput(part.id);
    const solids: readonly SolidCadSavedInput[] = [
      { ...common, schema: 'pointercad-solid-cad-input/1', tractionMPa, capacity },
      { ...common, schema: 'pointercad-solid-cad-input/2', load: 'pressure', pressureMPa: -2, capacity },
    ];
    for (const definition of solids) {
      const solidInputs: BeamAnalysisInputs = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad', definition }] };
      const solidText = serializeDocument(withBeamAnalysisInputs(part, solidInputs), WRITE_OPTIONS);
      const reopened = parsePart(solidText), solid = reopened.beamAnalysisInputs?.analyses[0];
      if (solid?.kind !== 'solid-cad') throw new Error('Missing reopened solid');
      expect(solid.definition.capacity).toEqual(capacity);
      expect(solid.definition.capacity).not.toBe(capacity);
      if (sourceId === 'tsubaki-s45c') expect(solid.definition.capacity)
        .toMatchObject({ evidence: 'manufacturer-reference', basis: 'reference' });
      expect(reopened.beamAnalysisInputs).toEqual(solidInputs);
      expect(serializeDocument(reopened, WRITE_OPTIONS)).toBe(solidText);
      expect(reopened).not.toHaveProperty('analysisResults');
    }
  });

  it.each(['manual', 'solid-cad'] as const)('keeps legacy %s yield evidence absent on cold read and rewrite', kind => {
    const part = createEmptyPartDocument();
    const input = kind === 'manual' ? manualInputs(part.id).analyses[0] : { kind, definition: solidInput(part.id) };
    const inputs = { schema: 'pointercad-beam-inputs/1', analyses: [input] };
    const text = serializeDocument(withBeamAnalysisInputs(part, inputs), WRITE_OPTIONS);
    const restored = parsePart(text);
    expect(restored.beamAnalysisInputs).toEqual(inputs);
    expect(text).not.toContain('"capacity":');
    expect(text).not.toContain('"yieldMPa":');
    expect(text).not.toContain('"sourceId":');
    expect(serializeDocument(restored, WRITE_OPTIONS)).toBe(text);
  });

  it.each([
    ['source-missing', { sourceId: undefined }],
    ['condition-mismatch', { condition: '焼入焼戻・適用寸法未指定の参考値' }],
    ['thickness-outside', { thicknessMm: 101 }],
  ])('refuses %s in actual writes and reads while preserving the prior document', (reason, patch) => {
    const part = createEmptyPartDocument();
    const capacity: AnalysisMaterialCapacity = { materialConditionId: 'ss400-plate-0-16', yieldMPa: 245,
      sourceId: 'jisf-g3101-draft', condition: '圧延鋼板（熱処理の指定なし）', thicknessMm: 16,
      evidence: 'standard-draft', basis: 'minimum' };
    const inputs = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-cad',
      definition: { ...solidInput(part.id), capacity } }] };
    const document = withBeamAnalysisInputs(part, inputs);
    const before = serializeDocument(document, WRITE_OPTIONS);
    const invalid = { ...inputs, analyses: [{ kind: 'solid-cad', definition: { ...solidInput(part.id), capacity: { ...capacity, ...patch } } }] };
    expect(() => withBeamAnalysisInputs(document, invalid)).toThrow(`material-capacity-${reason}`);
    const checked = readBeamAnalysisInputs(invalid, part.id);
    if (checked.ok) throw new Error('Expected invalid capacity');
    expect(checked.issue.code).toBe(`material-capacity-${reason}`);
    const invalidDocument = structuredClone(document);
    const saved = invalidDocument.beamAnalysisInputs?.analyses[0];
    if (saved?.kind !== 'solid-cad') throw new Error('Expected saved solid');
    Reflect.set(saved.definition, 'capacity', { ...capacity, ...patch });
    expect(() => serializeDocument(invalidDocument, WRITE_OPTIONS)).toThrow(`material-capacity-${reason}`);
    const opened = parseDocument(replaceAttachment(before, invalid));
    expect(opened.ok).toBe(false);
    expect(serializeDocument(document, WRITE_OPTIONS)).toBe(before);
  });
});
