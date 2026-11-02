import { describe, expect, it } from 'vitest';
import { bucklingCadFixture } from './beamBuckling.testSupport.js';
import {
  readBeamAnalysisInputs, withBeamAnalysisInputs,
  type StandardBeamContactDefinition, type StandardBeamFrictionDefinition, type StandardBeamImpactDefinition,
} from './beamInputs.js';
import { standardMembersToBeamAnalysis } from './standardBeamAdapter.js';

const tipLoad = (force: readonly [number, number, number]) =>
  [{ id: 'tip-load', kind: 'nodal', nodeId: 'tip', force: [...force], moment: [0, 0, 0] }] as const;

/** Two CAD nodes (fixed base, free tip); the tip may touch a fixed plane at zero gap and slides with mu 0.3 under four
 * total load steps, the third of which unloads to zero. Nothing is solved here. */
function frictionFixture(solverOptions: StandardBeamFrictionDefinition['solverOptions'] = { solver: 'newton', iterationLimit: 64 }) {
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
  return { fixture, definition };
}
const attachment = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1',
  analyses: [{ kind: 'standard-members', definition }] });

function refusal(definition: unknown, ownerId: string): { code: string; path: string } {
  const checked = readBeamAnalysisInputs(attachment(definition), ownerId);
  if (checked.ok) throw new Error('Expected a refused friction definition');
  return { code: checked.issue.code, path: checked.issue.path };
}

describe('saved frictional contact inputs (schema 7)', () => {
  it.each([
    ['Newton', { solver: 'newton', iterationLimit: 64 }],
    ['NSGS', { solver: 'nsgs', iterationLimit: 20000 }],
  ] as const)('reads every %s field back unchanged, in the saved order', (_, solverOptions) => {
    const { fixture, definition } = frictionFixture(solverOptions);
    const checked = readBeamAnalysisInputs(attachment(definition), fixture.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
    const saved = checked.value.analyses[0];
    expect(saved).toEqual({ kind: 'standard-members', definition });
    // Same bytes as the caller's JSON: no field is added, dropped, reordered or renormalized.
    expect(JSON.stringify(saved)).toBe(JSON.stringify({ kind: 'standard-members', definition }));
    if (saved.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/7') {
      throw new Error('Expected schema 7');
    }
    expect(saved.definition.solverOptions).toEqual(solverOptions);
    expect(saved.definition.friction).toEqual({ 'tip-stop': 0.3 });
    expect(saved.definition.stepLoads.map(step => step[0].force)).toEqual([[2, -10, 0], [5, -10, 0], [0, 0, 0], [-5, -10, 0]]);
    expect(saved.definition.stepLoads.map(step => step[0].moment)).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(saved.definition.contact.contacts[0].gapMm).toBe(0);
    expect(saved.definition.source).toEqual(fixture.stamp);
    const document = withBeamAnalysisInputs(fixture.document, attachment(definition));
    expect(document.beamAnalysisInputs?.analyses[0]).toEqual({ kind: 'standard-members', definition });
    expect(JSON.stringify(document.beamAnalysisInputs))
      .not.toMatch(/"(?:referenceLoads|loadFactors|buckling|modal|constraints|loads|results|states|gapM|nodes|slip|reaction)"/u);
  });

  it('owns its snapshot: later caller edits and edits of one read never reach another read', () => {
    const { fixture, definition } = frictionFixture();
    const caller = JSON.parse(JSON.stringify(definition)) as {
      friction: Record<string, number>; stepLoads: { force: number[] }[][]; contact: { contacts: { normal: number[] }[] };
      solverOptions: { iterationLimit: number }; supports: { restrained: boolean[] }[];
    };
    const first = withBeamAnalysisInputs(fixture.document, attachment(caller));
    const firstText = JSON.stringify(first.beamAnalysisInputs);
    caller.friction['tip-stop'] = 0.9;
    caller.stepLoads[2][0].force[0] = 77;
    caller.stepLoads.reverse();
    caller.contact.contacts[0].normal[1] = 5;
    caller.solverOptions.iterationLimit = 1;
    caller.supports[0].restrained[0] = false;
    expect(JSON.stringify(first.beamAnalysisInputs)).toBe(firstText);
    const second = readBeamAnalysisInputs(first.beamAnalysisInputs, fixture.document.id);
    if (!second.ok) throw new Error(second.issue.code);
    const reread = second.value.analyses[0];
    if (reread.kind !== 'standard-members' || reread.definition.schema !== 'pointercad-standard-beam/7') {
      throw new Error('Expected schema 7');
    }
    expect(reread.definition).toEqual(definition);
    expect(reread.definition.stepLoads).not.toBe(definition.stepLoads);
    expect(reread.definition.friction).not.toBe(definition.friction);
    expect(JSON.stringify(first.beamAnalysisInputs)).toBe(firstText);
  });

  it('keeps several contacts with their own coefficients, including zero, and a nonzero moment-only step', () => {
    const { fixture, definition } = frictionFixture();
    const pair: StandardBeamFrictionDefinition = { ...definition,
      contact: { ...definition.contact, contacts: [...definition.contact.contacts,
        { kind: 'node-pair', id: 'base-tip', nodeIdA: 'base', nodeIdB: 'tip', normal: [0, 0, 2], gapMm: 0.25 }] },
      friction: { 'base-tip': 0, 'tip-stop': 0.3 },
      stepLoads: [[{ id: 'tip-load', kind: 'nodal', nodeId: 'tip', force: [0, 0, 0], moment: [0, 0, 4] }]] };
    const checked = readBeamAnalysisInputs(attachment(pair), fixture.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
    expect(checked.value.analyses[0]).toEqual({ kind: 'standard-members', definition: pair });
  });

  it.each([
    ['missing coefficient', { friction: {} }, 'friction-map'],
    ['coefficient for another contact', { friction: { 'tip-stop': 0.3, elsewhere: 0.1 } }, 'friction-map'],
    ['coefficient keyed to an absent contact', { friction: { elsewhere: 0.3 } }, 'friction-map'],
    ['coefficient list', { friction: [0.3] }, 'friction-map'],
    ['negative coefficient', { friction: { 'tip-stop': -0.01 } }, 'friction-coefficient'],
    ['NaN coefficient', { friction: { 'tip-stop': Number.NaN } }, 'number'],
    ['infinite coefficient', { friction: { 'tip-stop': Number.POSITIVE_INFINITY } }, 'number'],
    ['text coefficient', { friction: { 'tip-stop': '0.3' } }, 'number'],
    ['no step', { stepLoads: [] }, 'friction-steps'],
    ['33 steps', { stepLoads: Array.from({ length: 33 }, () => tipLoad([1, 0, 0])) }, 'size'],
    ['empty step', { stepLoads: [tipLoad([1, 0, 0]), []] }, 'friction-steps'],
    ['all steps unloaded', { stepLoads: [tipLoad([0, 0, 0]), tipLoad([0, 0, 0])] }, 'friction-steps'],
    ['load on an absent node', { stepLoads: [[{ id: 'tip-load', kind: 'nodal', nodeId: 'elsewhere', force: [1, 0, 0], moment: [0, 0, 0] }]] },
      'friction-load-node'],
    ['different loads between steps', { stepLoads: [tipLoad([1, 0, 0]),
      [{ id: 'other-load', kind: 'nodal', nodeId: 'tip', force: [1, 0, 0], moment: [0, 0, 0] }]] }, 'friction-steps'],
    ['load moved to another node', { stepLoads: [tipLoad([1, 0, 0]),
      [{ id: 'tip-load', kind: 'nodal', nodeId: 'base', force: [1, 0, 0], moment: [0, 0, 0] }]] }, 'friction-steps'],
    ['duplicate load in a step', { stepLoads: [[...tipLoad([1, 0, 0]), ...tipLoad([1, 0, 0])]] }, 'duplicate-id'],
    ['load without moment', { stepLoads: [[{ id: 'tip-load', kind: 'nodal', nodeId: 'tip', force: [1, 0, 0] }]] }, 'shape'],
    ['non-finite load', { stepLoads: [tipLoad([Number.NaN, 0, 0])] }, 'number'],
    ['missing solver options', { solverOptions: undefined }, 'shape'],
    ['missing solver', { solverOptions: { iterationLimit: 64 } }, 'shape'],
    ['extra solver option', { solverOptions: { solver: 'newton', iterationLimit: 64, tolerance: 1e-9 } }, 'shape'],
    ['unknown solver', { solverOptions: { solver: 'cg', iterationLimit: 64 } }, 'friction-solver'],
    ['zero iterations', { solverOptions: { solver: 'newton', iterationLimit: 0 } }, 'friction-solver'],
    ['fractional iterations', { solverOptions: { solver: 'nsgs', iterationLimit: 1.5 } }, 'friction-solver'],
    ['unsafe iterations', { solverOptions: { solver: 'nsgs', iterationLimit: 2 ** 53 } }, 'friction-solver'],
    ['text iterations', { solverOptions: { solver: 'nsgs', iterationLimit: '64' } }, 'friction-solver'],
    ['no support', { supports: [] }, 'buckling-supports'],
    ['support on an absent node', { supports: [{ nodeId: 'elsewhere', restrained: [true, true, true, true, true, true] }] },
      'buckling-supports'],
    ['support without restraint', { supports: [{ nodeId: 'base', restrained: [false, false, false, false, false, false] }] },
      'buckling-supports'],
    ['negative revision', { revision: -1 }, 'revision'],
    ['source without geometry revision', { source: { documentId: 'x', documentRevision: 7 } }, 'shape'],
    ['other units', { units: 'N-m' }, 'unsupported-model'],
    ['saved result', { results: [] }, 'shape'],
    ['world nodes', { nodes: [{ id: 'tip', position: [0, 0, 2000] }] }, 'shape'],
    ['schema 5 reference loads', { referenceLoads: [] }, 'shape'],
    ['axial bolts', { axialBolts: { bolts: [] } }, 'friction-unsupported-joint'],
    ['weld layers', { weldLayers: { welds: [] } }, 'friction-unsupported-joint'],
    ['initial strain', { initialStrain: {} }, 'friction-unsupported-joint'],
  ] as const)('refuses %s', (_, change, code) => {
    const { fixture, definition } = frictionFixture();
    const changed: Record<string, unknown> = { ...definition, ...change };
    if ('solverOptions' in change && change.solverOptions === undefined) Reflect.deleteProperty(changed, 'solverOptions');
    expect(refusal(changed, fixture.document.id).code).toBe(code);
  });

  it.each([
    ['independent load factors', { loadFactors: [1] }, 'shape'],
    ['no contact', { contacts: [] }, 'contact-count'],
    ['absent contact node', { contacts: [{ kind: 'node-plane', id: 'tip-stop', nodeId: 'elsewhere', normal: [0, -1, 0], gapMm: 0 }] },
      'contact-node'],
    ['negative gap', { contacts: [{ kind: 'node-plane', id: 'tip-stop', nodeId: 'tip', normal: [0, -1, 0], gapMm: -1 }] }, 'contact-gap'],
    ['zero segments', { segmentsPerMember: 0 }, 'modal-size'],
  ] as const)('refuses contact settings with %s', (_, change, code) => {
    const { fixture, definition } = frictionFixture();
    expect(refusal({ ...definition, contact: { ...definition.contact, ...change } }, fixture.document.id).code).toBe(code);
  });

  it('refuses a source or owner of another document', () => {
    const { fixture, definition } = frictionFixture();
    expect(refusal(definition, 'another-document').code).toBe('wrong-document');
    expect(refusal({ ...definition, source: { ...definition.source, documentId: 'another-document' } }, fixture.document.id).code)
      .toBe('wrong-document');
  });

  it('refuses accessors, symbol keys, other prototypes and sparse lists without running or dropping them', () => {
    const { fixture, definition } = frictionFixture();
    let reads = 0;
    const accessor = Object.defineProperty({}, 'tip-stop', { enumerable: true, get: () => { reads += 1; return 0.3; } });
    const hidden = Object.defineProperty({ 'tip-stop': 0.3 }, 'shadow', { enumerable: false, value: 1 });
    const sparse = [tipLoad([1, 0, 0]), tipLoad([2, 0, 0]), tipLoad([3, 0, 0])];
    Reflect.deleteProperty(sparse, 1);
    const holeWithExtra: unknown[] = [tipLoad([1, 0, 0]), tipLoad([2, 0, 0])];
    Reflect.deleteProperty(holeWithExtra, 1);
    Reflect.set(holeWithExtra, 'extra', tipLoad([2, 0, 0]));
    const inherited = new Array<unknown>(1);
    Object.setPrototypeOf(inherited, [tipLoad([1, 0, 0])]);
    class Options { readonly solver = 'newton'; readonly iterationLimit = 64; }
    for (const [change, path] of [
      [{ friction: accessor }, 'friction'],
      [{ friction: hidden }, 'friction'],
      [{ friction: { 'tip-stop': 0.3, [Symbol('hidden')]: 1 } }, 'friction'],
      [{ stepLoads: sparse }, 'stepLoads'],
      [{ stepLoads: holeWithExtra }, 'stepLoads'],
      [{ stepLoads: inherited }, 'stepLoads'],
      [{ solverOptions: new Options() }, 'solverOptions'],
      [{ solverOptions: { solver: 'newton', iterationLimit: BigInt(64) } }, 'solverOptions.iterationLimit'],
    ] as const) {
      const issue = refusal({ ...definition, ...change }, fixture.document.id);
      expect(issue.code, path).toBe('friction-data');
      expect(issue.path.endsWith(`definition.${path}`), issue.path).toBe(true);
    }
    expect(reads).toBe(0);
  });

  it('is refused by the static CAD adapter, which never solves friction as a static load case', () => {
    const { fixture, definition } = frictionFixture();
    const result = standardMembersToBeamAnalysis(fixture.document, definition,
      { currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issue).toMatchObject({ code: 'unsupported-analysis', path: '$' });
  });

  it('leaves saved schema 5 and 6 values exactly as before and never reads friction fields into them', () => {
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
      const checked = readBeamAnalysisInputs(attachment(definition), fixture.document.id);
      if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
      expect(JSON.stringify(checked.value)).toBe(JSON.stringify(attachment(definition)));
    }
    const { definition: friction } = frictionFixture();
    for (const [extra, code] of [
      [{ friction: friction.friction }, 'shape'],
      [{ stepLoads: friction.stepLoads }, 'shape'],
      [{ solverOptions: friction.solverOptions }, 'shape'],
    ] as const) {
      expect(refusal({ ...contact, ...extra }, fixture.document.id).code).toBe(code);
    }
    // Schema 7 content under an older schema label is never reinterpreted as load factors or a static case.
    expect(refusal({ ...friction, schema: 'pointercad-standard-beam/5' }, fixture.document.id).code).toBe('shape');
    expect(refusal({ ...friction, schema: 'pointercad-standard-beam/8' }, fixture.document.id).code).toBe('shape');
  });
});
