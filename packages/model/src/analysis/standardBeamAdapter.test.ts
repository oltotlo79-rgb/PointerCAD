import { describe, expect, it } from 'vitest';
import { createAssemblyDocument } from '../assembly/createAssemblyDocument.js';
import { quaternionFromAxisAngle } from '../assembly/placementMath.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument } from '../assembly/types.js';
import type { BeamAnalysisDocument, Vector3 } from './analysisModel.js';
import { readBeamAnalysis, serializeBeamAnalysis } from './analysisValidation.js';
import { beamCadFixture, testComponent, testMember, testPlacement } from './beamInputs.testSupport.js';
import { readBeamAnalysisInputs } from './beamInputs.js';
import { standardMembersToBeamAnalysis, type StandardBeamAdapterContext } from './standardBeamAdapter.js';
import { weldTestBody } from '../assembly/welding/filletWeld.testSupport.js';

function derive(document: AssemblyDocument, definition: unknown, context?: Partial<StandardBeamAdapterContext>): BeamAnalysisDocument {
  const result = standardMembersToBeamAnalysis(document, definition, {
    currentSource: beamCadFixture().stamp, bodies: new Map(), assemblyOptions: {}, ...context,
  });
  if (!result.ok) throw new Error(`${result.issue.code}: ${result.issue.message}`);
  return result.document;
}

function close(actual: Vector3 | undefined, expected: Vector3): void {
  expect(actual).toBeDefined();
  if (actual === undefined) throw new Error('Missing vector');
  for (let index = 0; index < 3; index += 1) expect(Math.abs(actual[index] - expected[index])).toBeLessThan(1e-7);
}

describe('standard CAD members to explicit beam input', () => {
  it('uses the actual generator length, explicit centroid and principal frame without mutating input', () => {
    const fixture = beamCadFixture();
    const before = structuredClone(fixture);
    const result = derive(fixture.document, fixture.definition);
    close(result.nodes.find(node => node.id === 'base')?.position, [25, 3, 0]);
    close(result.nodes.find(node => node.id === 'tip')?.position, [25, 3, 2000]);
    close(result.members[0]?.localYHint, [1, 0, 0]);
    expect(result.units).toBe('N-mm');
    expect(fixture).toEqual(before);
  });

  it('keeps repeated child ids distinct and composes rotated nested world placement once', () => {
    const fixture = beamCadFixture();
    const child = { ...testComponent('same'), placement: testPlacement([2, 4, 6], quaternionFromAxisAngle([0, 0, 1], Math.PI / 2)) };
    const nested: AssemblyDocument = { ...createAssemblyDocument('nested'), components: [child] };
    const parent = (id: string, position: Vector3, rotated: boolean): AssemblyComponent => ({
      ...testComponent(id), source: { kind: 'subAssembly', assemblyRef: 'nested-file' },
      placement: testPlacement(position, rotated ? quaternionFromAxisAngle([0, 1, 0], Math.PI / 2) : [0, 0, 0, 1]),
    });
    const document = { ...fixture.document, components: [parent('left', [10, 20, 30], true), parent('right', [-100, 0, 0], false)] };
    const definition = {
      ...fixture.definition, members: [testMember(child, ['left', 'same'], 'left-'), testMember(child, ['right', 'same'], 'right-')],
      constraints: [
        { id: 'left-clamp', kind: 'fixed', nodeId: 'left-base' },
        { id: 'right-clamp', kind: 'fixed', nodeId: 'right-base' },
      ],
      loads: [{ ...fixture.definition.loads[0], nodeId: 'left-tip' }],
    };
    const result = derive(document, definition, { assemblyOptions: { subAssemblies: new Map([['nested-file', nested]]) } });
    close(result.nodes.find(node => node.id === 'left-base')?.position, [16, 49, 31]);
    close(result.nodes.find(node => node.id === 'left-tip')?.position, [2016, 49, 31]);
    close(result.nodes.find(node => node.id === 'right-base')?.position, [-101, 29, 6]);
    close(result.members[0]?.localYHint, [0, 1, 0]);
    expect(result.members.map(member => member.occurrencePath)).toEqual([['left', 'same'], ['right', 'same']]);
    expect(result.members.map(member => member.componentId)).toEqual(['same', 'same']);
  });

  it('preserves CAD interpretation in the canonical input while keeping manual documents compatible', () => {
    const fixture = beamCadFixture();
    const original = derive(fixture.document, fixture.definition);
    const member = fixture.definition.members[0];
    const changed = derive(fixture.document, {
      ...fixture.definition,
      members: [{ ...member, sectionFrame: {
        ...member.sectionFrame,
        source: { ...member.sectionFrame.source, reference: 'independent section measurement' },
      } }],
    });
    expect(changed.nodes).toEqual(original.nodes);
    expect(serializeBeamAnalysis(changed)).not.toBe(serializeBeamAnalysis(original));
    expect(original.members[0].cadSource?.expectedPartKey).toBe(member.expectedPartKey);
    expect(original.members[0].cadSource?.sectionFrameSource).toEqual(member.sectionFrame.source);
    expect(original.members[0].cadSource?.sectionFrameSource).not.toBe(member.sectionFrame.source);

    const manual = { ...original, members: original.members.map(row => {
      const input = { ...row };
      delete input.cadSource;
      return input;
    }) };
    expect(readBeamAnalysis(manual).ok).toBe(true);
    expect(serializeBeamAnalysis(manual)).not.toContain('cadSource');
    for (const cadSource of [undefined, { ...original.members[0].cadSource, result: [] },
      { ...original.members[0].cadSource, shearCenterModel: 'automatic' }]) {
      expect(readBeamAnalysis({ ...original, members: [{ ...original.members[0], cadSource }] }).ok).toBe(false);
    }
  });

  it('refuses a missing or suppressed ancestor even when its child id exists elsewhere', () => {
    const fixture = beamCadFixture();
    const child = testComponent('same');
    const nested = { ...createAssemblyDocument('nested'), components: [child] };
    const parent: AssemblyComponent = {
      ...testComponent('parent'), source: { kind: 'subAssembly', assemblyRef: 'nested-file' },
    };
    const definition = { ...fixture.definition, members: [testMember(child, ['parent', 'same'])] };
    const options = { subAssemblies: new Map([['nested-file', nested]]) };
    for (const document of [
      { ...fixture.document, components: [child] },
      { ...fixture.document, components: [{ ...parent, suppressed: true }, child] },
    ]) {
      expect(() => derive(document, definition, { assemblyOptions: options })).toThrow(/missing-occurrence/u);
    }
    expect(() => derive({ ...fixture.document, components: [parent] }, definition)).toThrow(/missing-occurrence/u);
  });

  it('uses actual solved mate translations rather than saved initial placement', () => {
    const fixture = beamCadFixture();
    const ground = { ...testComponent('ground'), placement: testPlacement([10, 20, 30]) };
    const moving = { ...testComponent('moving'), fixed: false, placement: testPlacement([40, 50, 60]) };
    const document: AssemblyDocument = {
      ...fixture.document, components: [ground, moving],
      mates: [{ id: 'position', name: 'position', kind: 'coincident',
        a: { kind: 'origin', componentId: 'moving', element: 'origin' },
        b: { kind: 'origin', componentId: 'ground', element: 'origin' }, flipped: false, suppressed: false }],
    };
    const result = derive(document, { ...fixture.definition, members: [testMember(moving)] });
    close(result.nodes.find(node => node.id === 'base')?.position, [35, 23, 30]);
    close(result.nodes.find(node => node.id === 'tip')?.position, [35, 23, 2030]);
    expect(document.components[1]?.placement.position[0].value).toBe(40);
  });

  it('transforms explicitly confirmed L-section principal axes instead of assuming sketch axes', () => {
    const fixture = beamCadFixture();
    const component = { ...testComponent(), source: createStandardPartSource('equalAngle', 'L 25×25×3', { length: '2000' }),
      placement: testPlacement([10, 20, 30], quaternionFromAxisAngle([0, 0, 1], Math.PI / 2)) };
    const member = testMember(component);
    const definition = { ...fixture.definition, members: [{ ...member, sectionFrame: {
      ...member.sectionFrame, centroidMm: [7, 7, 0], principalY: [Math.SQRT1_2, Math.SQRT1_2, 0],
    } }] };
    const result = derive({ ...fixture.document, components: [component] }, definition);
    close(result.nodes.find(node => node.id === 'base')?.position, [3, 27, 30]);
    close(result.members[0]?.localYHint, [-Math.SQRT1_2, Math.SQRT1_2, 0]);
    // These supplied values are a deliberate test assumption, not catalog-derived section properties.
    expect(result.sections).toEqual(fixture.definition.sections);
  });

  it.each(['deleted', 'suppressed', 'ambiguous', 'source-change', 'generator', 'revision', 'quaternion', 'unsupported'])(
    'refuses %s before producing an analysis document', reason => {
      const fixture = beamCadFixture();
      const original = testComponent();
      let component = original;
      let document = fixture.document;
      let stamp = fixture.stamp;
      let definition = fixture.definition;
      if (reason === 'deleted') document = { ...document, components: [] };
      if (reason === 'suppressed') component = { ...component, suppressed: true };
      if (reason === 'ambiguous') document = { ...document, components: [original, original] };
      if (reason === 'source-change' && component.source.kind === 'standardPart') {
        component = { ...component, source: { ...component.source, options: { ...component.source.options, length: '1999' } } };
      }
      if (reason === 'revision') stamp = { ...stamp, geometryRevision: 'new-generation' };
      if (reason === 'generator' && component.source.kind === 'standardPart') {
        component = { ...component, source: { ...component.source, generatorRevision: 'unknown-generation' } };
        definition = { ...definition, members: [{ ...definition.members[0], expectedPartKey: partKeyOf(component.source) }] };
      }
      if (reason === 'quaternion') component = { ...component, placement: testPlacement([0, 0, 0], [0, 0, 0, 0]) };
      if (reason === 'unsupported') {
        component = { ...component, source: createStandardPartSource('hexBolt', 'M6') };
        definition = { ...definition, members: [{ ...definition.members[0], expectedPartKey: partKeyOf(component.source) }] };
      }
      if (component !== original) document = { ...document, components: [component] };
      const result = standardMembersToBeamAnalysis(document, definition, { currentSource: stamp, bodies: new Map(), assemblyOptions: {} });
      expect(result.ok).toBe(false);
    },
  );

  it('requires explicit shared node ids and refuses a false shared endpoint', () => {
    const fixture = beamCadFixture();
    const a = testComponent('a', '1000');
    const b = { ...testComponent('b', '1000'), placement: testPlacement([0, 0, 1000]) };
    const first = { ...testMember(a), endNodeId: 'joint' };
    const second = { ...testMember(b), id: 'second', startNodeId: 'joint' };
    const definition = { ...fixture.definition, members: [first, second] };
    const document = { ...fixture.document, components: [a, b] };
    expect(derive(document, definition).nodes).toHaveLength(3);
    expect(() => derive(document, { ...definition, constraints: [] })).toThrow(/unconstrained-component/u);
    const disconnected = { ...definition, members: [first, { ...second, startNodeId: 'separate' }] };
    expect(() => derive(document, disconnected)).toThrow(/unconstrained-component/u);
    expect(() => derive({ ...document, components: [a, { ...b, placement: testPlacement([0, 0, 1001]) }] }, definition))
      .toThrow(/inconsistent-connection/u);
  });

  it('requires section confirmation and rejects unknown persisted versions/results/program fields', () => {
    const fixture = beamCadFixture();
    const attachment = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] });
    const badDefinitions = [
      { ...fixture.definition, schema: 'pointercad-standard-beam/99' },
      { ...fixture.definition, nodes: [] },
      { ...fixture.definition, result: [] },
      { ...fixture.definition, python: 'print(1)' },
      { ...fixture.definition, members: [{ ...fixture.definition.members[0], sectionFrame: {
        ...fixture.definition.members[0].sectionFrame, confirmed: false,
      } }] },
      { ...fixture.definition, members: [{ ...fixture.definition.members[0], sectionFrame: {
        ...fixture.definition.members[0].sectionFrame, principalY: [0, 0, 1],
      } }] },
      { ...fixture.definition, materials: [{ ...fixture.definition.materials[0], youngModulus: NaN }] },
    ];
    for (const invalid of badDefinitions) expect(readBeamAnalysisInputs(attachment(invalid), fixture.document.id).ok).toBe(false);
    expect(readBeamAnalysisInputs({ ...attachment(fixture.definition), schema: 'future' }, fixture.document.id).ok).toBe(false);
  });
});

describe('standard beam mass accounting', () => {
  it('adds a mass summary without changing the canonical analysis document or borrowing input data', () => {
    const fixture = beamCadFixture();
    const before = structuredClone(fixture);
    const result = standardMembersToBeamAnalysis(fixture.document, fixture.definition, {
      currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {},
    });
    if (!result.ok) throw new Error(result.issue.message);
    // 50 x 6 x 2000 mm3 = 600 cm3; 600 x 7.85 g = 4.71 kg.
    expect(Math.abs(result.totalMassKg - 4.71) / 4.71).toBeLessThanOrEqual(1e-6);
    expect(result.excludedParts).toEqual([]);
    expect(readBeamAnalysis(result.document)).toEqual({ ok: true, document: result.document });
    expect(serializeBeamAnalysis(result.document)).not.toContain('totalMassKg');
    expect(fixture).toEqual(before);
  });

  it('counts nested occurrences, including hidden parts, but omits suppressed parts and selected members', () => {
    const fixture = beamCadFixture();
    const child = testComponent('member');
    const bolt: AssemblyComponent = { ...testComponent('bolt'), visible: false,
      source: createStandardPartSource('hexBolt', 'M6', { length: '20' }) };
    const suppressed = { ...bolt, id: 'suppressed', suppressed: true };
    const nested = { ...createAssemblyDocument('nested'), components: [child, bolt, suppressed] };
    const parent = (id: string): AssemblyComponent => ({ ...testComponent(id),
      source: { kind: 'subAssembly', assemblyRef: 'child' } });
    const document = { ...fixture.document, components: [parent('a'), parent('b')] };
    const definition = { ...fixture.definition,
      members: [testMember(child, ['a', 'member'], 'a-'), testMember(child, ['b', 'member'], 'b-')],
      constraints: [{ id: 'a-clamp', kind: 'fixed', nodeId: 'a-base' }, { id: 'b-clamp', kind: 'fixed', nodeId: 'b-base' }],
      loads: [{ ...fixture.definition.loads[0], nodeId: 'a-tip' }] };
    const bodies = new Map([[partKeyOf(bolt.source), [{ ...weldTestBody([], []), volume: 1000 }]]]);
    const before = structuredClone({ document, definition, bodies });
    const result = standardMembersToBeamAnalysis(document, definition, { currentSource: fixture.stamp, bodies,
      assemblyOptions: { subAssemblies: new Map([['child', nested]]) } });
    if (!result.ok) throw new Error(result.issue.message);
    expect(result.totalMassKg).toBeCloseTo(9.42, 12);
    expect(result.excludedParts.map(({ kind, count }) => ({ kind, count }))).toEqual([{ kind: 'hexBolt', count: 2 }]);
    const mass = result.excludedParts[0].massKg;
    if (mass === null) throw new Error('Known nested mass was lost');
    expect(Math.abs(mass - 0.0157) / 0.0157).toBeLessThanOrEqual(1e-12);
    expect({ document, definition, bodies }).toEqual(before);
  });

  it('reports an unknown excluded mass instead of inventing zero or a nominal catalog mass', () => {
    const fixture = beamCadFixture();
    const bolt = { ...testComponent('bolt'), source: createStandardPartSource('hexBolt', 'M6') };
    const document = { ...fixture.document, components: [...fixture.document.components, bolt] };
    for (const bodies of [new Map(), new Map([[partKeyOf(bolt.source), [{ ...weldTestBody([], []), volume: NaN }]]])]) {
      const result = standardMembersToBeamAnalysis(document, fixture.definition, {
        currentSource: fixture.stamp, bodies, assemblyOptions: {},
      });
      if (!result.ok) throw new Error(result.issue.message);
      expect(result.excludedParts).toEqual([{ kind: 'hexBolt', count: 1, massKg: null }]);
    }
  });

  it.each(['zero-density', 'negative-density', 'unknown-material'])('refuses %s with a reason and no analysis document', reason => {
    const fixture = beamCadFixture();
    const definition = reason === 'unknown-material'
      ? { ...fixture.definition, members: [{ ...fixture.definition.members[0], materialId: 'missing' }] }
      : { ...fixture.definition, materials: [{ ...fixture.definition.materials[0], densityKgM3: reason === 'zero-density' ? 0 : -7850 }] };
    const before = structuredClone({ document: fixture.document, definition });
    const result = standardMembersToBeamAnalysis(fixture.document, definition, {
      currentSource: fixture.stamp, bodies: new Map(), assemblyOptions: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Invalid mass input was accepted');
    expect(result.issue.message.length).toBeGreaterThan(0);
    expect(result.issue.code).toBe(reason === 'unknown-material' ? 'missing-reference' : 'number');
    expect('document' in result).toBe(false);
    expect('totalMassKg' in result).toBe(false);
    expect({ document: fixture.document, definition }).toEqual(before);
  });
});
