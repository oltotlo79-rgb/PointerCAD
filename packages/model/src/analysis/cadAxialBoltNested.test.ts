import { describe, expect, it } from 'vitest';
import { createAssemblyDocument } from '../assembly/createAssemblyDocument.js';
import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, JointOccurrenceConnection } from '../assembly/types.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import type { CadAxialBoltInputs } from './axialBoltInput.js';
import { prepareCadAxialBolts } from './cadAxialBolt.js';
import { cadAxialBoltFixture } from './cadAxialBolt.testSupport.js';

/**
 * One child definition 'cell' (a 10 mm flat bar 'a' at its identity placement) is placed three times: p1 at (100,0,0),
 * p2 at (100,0,20) and a sibling p3 at the same place as p2. Independently, from the top-level fixture (bar at the
 * identity gives base (25,3,0) and tip (25,3,10)), the world endpoints are p1/a tip (125,3,10) and p2/a base (125,3,20):
 * the parent translation is applied once. A root bolt at (125,3,10) spans them along +Z.
 */
const NESTED = 'cell';
function nestedFixture() {
  const base = beamCadFixture(), child = testComponent('a', '10');
  const cell: AssemblyDocument = { ...createAssemblyDocument('cell'), components: [child] };
  const parent = (id: string, position: readonly [number, number, number]): AssemblyComponent => ({
    ...testComponent(id), source: { kind: 'subAssembly', assemblyRef: NESTED }, placement: testPlacement([...position]),
  });
  const bolt: AssemblyComponent = { id: 'bolt', name: 'explicit axial connector', fixed: true,
    visible: true, suppressed: false, placement: testPlacement([125, 3, 10]),
    source: createStandardPartSource('hexBolt', 'M8', { length: '20' }) };
  const connection: JointOccurrenceConnection = { kind: 'bolt', firstPath: ['p1', 'a'], secondPath: ['p2', 'a'], componentIds: ['bolt'] };
  const document: AssemblyDocument = { ...base.document,
    components: [parent('p1', [100, 0, 0]), parent('p2', [100, 0, 20]), parent('p3', [100, 0, 20]), bolt],
    jointOccurrenceConnections: [connection] };
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: 'contact', revision: 1,
    source: base.stamp, units: 'N-mm', members: [testMember(child, ['p1', 'a'], 'p1-'), testMember(child, ['p2', 'a'], 'p2-')],
    materials: base.definition.materials, sections: base.definition.sections,
    supports: [{ nodeId: 'p1-base', restrained: [true, true, true, true, true, true] },
      { nodeId: 'p2-tip', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'force', kind: 'nodal', nodeId: 'p1-tip', force: [0, 0, 1], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'p2-base', normal: [0, 0, 1], gapMm: 10 }],
      loadFactors: [1, -1] } };
  const associations: CadAxialBoltInputs = { schema: 'pointercad-cad-axial-bolts/1', source: base.stamp,
    analysisId: definition.id, analysisRevision: definition.revision, bolts: [{ id: 'tie', boltComponentId: 'bolt',
      expectedPartKey: partKeyOf(bolt.source), expectedMaterialId: null,
      first: { memberId: 'p1-beam', nodeId: 'p1-tip' }, second: { memberId: 'p2-beam', nodeId: 'p2-base' },
      youngMPa: 1000, effectiveAreaMm2: 10, propertySource: TEST_EVIDENCE, idealization: 'bilateral-uniform-axial-elastic' }] };
  const context = { currentSource: base.stamp, bodies: new Map(), assemblyOptions: { subAssemblies: new Map([[NESTED, cell]]) } };
  return { document, definition, associations, context, connection };
}
const withConnections = (document: AssemblyDocument, rows: readonly JointOccurrenceConnection[]): AssemblyDocument =>
  ({ ...document, jointOccurrenceConnections: rows });

describe('axial bolt between nested leaf members through the saved joint occurrence connection', () => {
  it('uses the exact leaf world endpoints once and the same EA/L as a top-level bolt', () => {
    const f = nestedFixture(), before = structuredClone(f.document);
    const result = prepareCadAxialBolts(f.document, f.definition, f.associations, f.context);
    expect(result.geometry.nodes.find(n => n.id === 'p1-tip')?.position).toEqual([125, 3, 10]);
    expect(result.geometry.nodes.find(n => n.id === 'p2-base')?.position).toEqual([125, 3, 20]);
    expect(result.bolts).toHaveLength(1);
    expect(result.bolts[0]).toMatchObject({ id: 'tie', nodeIdA: 'p1-tip', nodeIdB: 'p2-base', youngPa: 1e9 });
    // E = 1000 N/mm2, A = 10 mm2, L = 10 mm -> k = 1e6 N/m, identical to the top-level fixture.
    expect(result.bolts[0].youngPa * result.bolts[0].areaM2 / .01).toBeCloseTo(1e6, 8);
    expect(f.document).toEqual(before);
    // Save/reopen: the plain JSON document keeps the exact association and gives the same prepared bolt.
    const reopened = JSON.parse(JSON.stringify(f.document)) as AssemblyDocument;
    expect(reopened.jointOccurrenceConnections).toEqual([f.connection]);
    expect(prepareCadAxialBolts(reopened, f.definition, f.associations, f.context).bolts).toEqual(result.bolts);
  });

  it('refuses a missing, mixed-kind, duplicated, incomplete or sibling-substituted connection', () => {
    const f = nestedFixture(), message = /Nested bolt endpoints require exactly one complete saved bolt connection/;
    const run = (document: AssemblyDocument) => () => prepareCadAxialBolts(document, f.definition, f.associations, f.context);
    expect(run(withConnections(f.document, []))).toThrow(message);
    expect(run(withConnections(f.document, [{ ...f.connection, kind: 'weld' }]))).toThrow(message);
    expect(run(withConnections(f.document, [f.connection, { ...f.connection }]))).toThrow(message);
    expect(run(withConnections(f.document, [{ ...f.connection, componentIds: ['bolt', 'bolt'] }]))).toThrow(message);
    expect(run(withConnections(f.document, [{ ...f.connection, componentIds: ['bolt', 'missing-nut'] }]))).toThrow(message);
    // p3 is an identical child definition at the same world place as p2: the saved path, not geometry, decides.
    expect(run(withConnections(f.document, [{ ...f.connection, secondPath: ['p3', 'a'] }]))).toThrow(message);
  });

  it('refuses a suppressed or replaced ancestor before any bolt check', () => {
    const f = nestedFixture();
    const suppressed = { ...f.document, components: f.document.components.map(c => c.id === 'p2' ? { ...c, suppressed: true } : c) };
    expect(() => prepareCadAxialBolts(suppressed, f.definition, f.associations, f.context)).toThrow();
    const replaced = { ...f.document, components: f.document.components.map(c => c.id === 'p2'
      ? { ...c, source: { kind: 'subAssembly' as const, assemblyRef: 'other-cell' } } : c) };
    expect(() => prepareCadAxialBolts(replaced, f.definition, f.associations, f.context)).toThrow();
  });

  it('keeps the legacy top-level bolt behaviour without any joint occurrence connection', () => {
    const f = cadAxialBoltFixture();
    expect(f.document.jointOccurrenceConnections ?? []).toEqual([]);
    const result = prepareCadAxialBolts(f.document, f.definition, f.associations, f.context);
    expect(result.bolts[0]).toMatchObject({ id: 'tie', nodeIdA: 'a-tip', nodeIdB: 'b-base', youngPa: 1e9 });
  });
});
