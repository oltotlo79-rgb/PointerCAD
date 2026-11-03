import { replaceAttachment } from './analysisAttachment.testSupport.js';
import { createEmptyPartDocument } from '@pointercad/model';
import {
  readBeamAnalysisInputs, withBeamAnalysisInputs,
  type StandardBeamContactDefinition, type StandardBeamFrictionDefinition, type StandardBeamImpactDefinition,
} from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { bucklingCadFixture } from '@pointercad/model/testing/analysis-fixtures';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { isRecord } from './guards.js';

const WRITE_OPTIONS = { savedAt: '2026-10-29T00:00:00.000Z' };

const tipLoad = (force: readonly [number, number, number]) =>
  [{ id: 'tip-load', kind: 'nodal', nodeId: 'tip', force: [...force], moment: [0, 0, 0] }] as const;

/** Two CAD nodes, mu 0.3 at a zero-gap stop and four total tip load steps (the third unloads to zero). */
function frictionAttachment(solverOptions: StandardBeamFrictionDefinition['solverOptions']) {
  const fixture = bucklingCadFixture();
  const old = fixture.definition;
  const definition: StandardBeamFrictionDefinition = {
    schema: 'pointercad-standard-beam/7', id: old.id, revision: old.revision, source: old.source, units: old.units,
    members: old.members, materials: old.materials, sections: old.sections,
    contact: { segmentsPerMember: 8,
      contacts: [{ kind: 'node-plane', id: 'tip-stop', nodeId: 'tip', normal: [0, -1, 0], gapMm: 0 }] },
    supports: old.supports,
    friction: { 'tip-stop': 0.3 },
    stepLoads: [tipLoad([2, -10, 0]), tipLoad([5, -10, 0]), tipLoad([0, 0, 0]), tipLoad([-5, -10, 0])],
    solverOptions,
  };
  return { fixture, definition,
    attachment: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } };
}

function reopen(text: string) {
  const read = readAssemblyDocument(text);
  if (!read.ok) throw new Error(read.error.message);
  return read.document;
}


describe('frictional contact inputs (schema 7) through the actual assembly file codec', () => {
  it.each([
    ['Newton', { solver: 'newton', iterationLimit: 64 }],
    ['NSGS', { solver: 'nsgs', iterationLimit: 20000 }],
  ] as const)('saves and reopens every %s field, the step order and the zero step exactly', (_, solverOptions) => {
    const { fixture, definition, attachment } = frictionAttachment(solverOptions);
    const serialized = writeAssemblyDocument(withBeamAnalysisInputs(fixture.document, attachment), WRITE_OPTIONS);
    const reopened = reopen(serialized);
    expect(reopened.beamAnalysisInputs).toEqual(attachment);
    expect(JSON.stringify(reopened.beamAnalysisInputs)).toBe(JSON.stringify(attachment));
    expect(writeAssemblyDocument(reopened, WRITE_OPTIONS)).toBe(serialized);
    const saved = reopened.beamAnalysisInputs?.analyses[0];
    if (saved?.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/7') {
      throw new Error('Expected a reopened schema 7 definition');
    }
    expect(saved.definition.source).toEqual(fixture.stamp);
    expect(saved.definition.friction).toEqual({ 'tip-stop': 0.3 });
    expect(saved.definition.solverOptions).toEqual(solverOptions);
    expect(saved.definition.stepLoads).toEqual(definition.stepLoads);
    expect(saved.definition.stepLoads[2]).toEqual([{ id: 'tip-load', kind: 'nodal', nodeId: 'tip', force: [0, 0, 0], moment: [0, 0, 0] }]);
    // Inputs only: no solved state, result, derived world geometry or schema 5 load factor is ever written.
    expect(JSON.stringify(reopened.beamAnalysisInputs))
      .not.toMatch(/"(?:referenceLoads|loadFactors|buckling|modal|results|states|slip|reaction|gapM|nodes|worldPlacement)"/u);
  });

  it('keeps the saved document independent of later caller edits and of edits to another reopened copy', () => {
    const { fixture, definition, attachment } = frictionAttachment({ solver: 'newton', iterationLimit: 64 });
    const caller = structuredClone(attachment);
    const document = withBeamAnalysisInputs(fixture.document, caller);
    const serialized = writeAssemblyDocument(document, WRITE_OPTIONS);
    const callerDefinition = caller.analyses[0].definition;
    Reflect.set(callerDefinition.friction, 'tip-stop', 0.8);
    Reflect.set(callerDefinition.stepLoads[1][0].force, 0, 99);
    Reflect.set(callerDefinition.solverOptions, 'iterationLimit', 3);
    expect(writeAssemblyDocument(document, WRITE_OPTIONS)).toBe(serialized);
    const first = reopen(serialized), second = reopen(serialized);
    const edited = first.beamAnalysisInputs?.analyses[0];
    if (edited?.kind !== 'standard-members' || edited.definition.schema !== 'pointercad-standard-beam/7') throw new Error('Expected schema 7');
    Reflect.set(edited.definition.stepLoads[3][0].force, 0, 42);
    expect(second.beamAnalysisInputs?.analyses[0]).toEqual({ kind: 'standard-members', definition });
    expect(writeAssemblyDocument(second, WRITE_OPTIONS)).toBe(serialized);
  });

  it('refuses malformed or injected friction data through the actual file reader', () => {
    const { fixture, attachment } = frictionAttachment({ solver: 'nsgs', iterationLimit: 20000 });
    const serialized = writeAssemblyDocument(withBeamAnalysisInputs(fixture.document, attachment), WRITE_OPTIONS);
    // writeAssemblyDocument pretty-prints with JSON.stringify(envelope, null, 2).
    for (const [from, to] of [
      ['"tip-stop": 0.3', '"tip-stop": -0.3'],
      ['"tip-stop": 0.3', '"other-stop": 0.3'],
      ['"tip-stop": 0.3', '"tip-stop": 0.3, "other-stop": 0.3'],
      ['"solver": "nsgs"', '"solver": "gauss-seidel"'],
      ['"iterationLimit": 20000', '"iterationLimit": 0'],
      ['"iterationLimit": 20000', '"iterationLimit": 20000, "tolerance": 1e-9'],
      ['"stepLoads": [', '"results": [], "stepLoads": ['],
      ['"stepLoads": [', '"loadFactors": [1], "stepLoads": ['],
      ['"stepLoads": [', '"axialBolts": {}, "stepLoads": ['],
      ['pointercad-standard-beam/7', 'pointercad-standard-beam/5'],
    ] as const) {
      const changed = serialized.replace(from, to);
      expect(changed, to).not.toBe(serialized);
      const read = readAssemblyDocument(changed);
      expect(read.ok, to).toBe(false);
      if (!read.ok) expect(read.error.code, to).toBe('invalidField');
    }
    const definition = attachment.analyses[0].definition;
    for (const stepLoads of [[], Array.from({ length: 33 }, () => tipLoad([1, 0, 0])), [tipLoad([0, 0, 0])],
      [[{ ...tipLoad([1, 0, 0])[0], nodeId: 'elsewhere' }]]]) {
      const changed = replaceAttachment(serialized, { ...attachment, analyses: [{ kind: 'standard-members',
        definition: { ...definition, stepLoads } }] });
      expect(readAssemblyDocument(changed).ok, JSON.stringify(stepLoads).slice(0, 80)).toBe(false);
    }
    const without = (name: string) => Object.fromEntries(Object.entries(definition).filter(([key]) => key !== name));
    for (const changedDefinition of [without('friction'), without('solverOptions'), without('stepLoads'),
      { ...definition, supports: [] }, { ...definition, source: { ...definition.source, documentId: 'another-document' } }]) {
      const changed = replaceAttachment(serialized, { ...attachment, analyses: [{ kind: 'standard-members', definition: changedDefinition }] });
      expect(readAssemblyDocument(changed).ok).toBe(false);
    }
  });

  it('keeps schema 7 occurrence inputs assembly-only in both the part reader and writer', () => {
    const part = createEmptyPartDocument();
    const { definition } = frictionAttachment({ solver: 'newton', iterationLimit: 64 });
    const input = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members',
      definition: { ...definition, source: { ...definition.source, documentId: part.id } } }] };
    expect(parseDocument(replaceAttachment(serializeDocument(part, WRITE_OPTIONS), input)).ok).toBe(false);
    const checked = readBeamAnalysisInputs(input, part.id);
    if (!checked.ok) throw new Error(checked.issue.message);
    expect(() => serializeDocument({ ...part, beamAnalysisInputs: checked.value }, WRITE_OPTIONS)).toThrow(/assembly/u);
  });

  it('writes and reopens saved schema 5 and 6 values byte for byte as before', () => {
    const fixture = bucklingCadFixture();
    const old = fixture.definition;
    const contact: StandardBeamContactDefinition = {
      schema: 'pointercad-standard-beam/5', id: old.id, revision: old.revision, source: old.source, units: old.units,
      members: old.members, materials: old.materials, sections: old.sections,
      contact: { segmentsPerMember: 8,
        contacts: [{ kind: 'node-plane', id: 'tip-stop', nodeId: 'tip', normal: [0, 0, 1], gapMm: 0.5 }],
        loadFactors: [1, 0, -2] },
      supports: old.supports, referenceLoads: old.referenceLoads,
    };
    const impact: StandardBeamImpactDefinition = {
      schema: 'pointercad-standard-beam/6', id: old.id, revision: old.revision, source: old.source, units: old.units,
      members: old.members, materials: old.materials, sections: old.sections, supports: old.supports,
      impact: { segmentsPerMember: 8, initialVelocities: [{ nodeId: 'tip', velocityMPerS: [0, 0, -2] }],
        planes: [{ id: 'tip-stop', nodeId: 'tip', normal: [0, 0, 2], gapMm: 0.5 }],
        contactStiffnessNPerM: 1e7, history: { timeStepS: 1e-5, stepCount: 200, outputEvery: 2 } },
    };
    for (const definition of [contact, impact]) {
      const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] };
      const serialized = writeAssemblyDocument(withBeamAnalysisInputs(fixture.document, attachment), WRITE_OPTIONS);
      const envelope: unknown = JSON.parse(serialized);
      if (!isRecord(envelope) || !isRecord(envelope.document)) throw new Error('Expected a document envelope');
      // The saved attachment is exactly the caller's JSON: no friction field, default or reordering is introduced.
      expect(JSON.stringify(envelope.document.beamAnalysisInputs)).toBe(JSON.stringify(attachment));
      const reopened = reopen(serialized);
      expect(JSON.stringify(reopened.beamAnalysisInputs)).toBe(JSON.stringify(attachment));
      expect(writeAssemblyDocument(reopened, WRITE_OPTIONS)).toBe(serialized);
      expect(serialized).not.toMatch(/"(?:friction|stepLoads|solverOptions)"/u);
    }
  });
});
