import { describe, expect, it } from 'vitest';
import { createStandardPartSource } from '../../model/src/assembly/standard/buildStandardPart.js';
import { partKeyOf } from '../../model/src/assembly/resolveAssembly.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from '../../model/src/analysis/beamInputs.testSupport.js';
import type { AssemblyComponent } from '@pointercad/model';
import type { StandardBeamContactDefinition } from '@pointercad/model/beam-analysis';
import { prepareCadNativeBoltPreload, type CadNativeBoltPreloadInput } from './cadNativeBoltPreload.js';
import { prepareNativeBoltPreload } from './nativeBoltPreload.js';

// Independent dimensions: two 50 mm FB50x6 members, explicit E=200000 MPa,
// A=300 mm2 => cm=100/(200000*300) mm/N = (5/3)e-9 m/N.
// Actual M16 shaft contains an explicit effective area100 mm2. L=100 mm gives
// cs=5e-9 m/N; thread/head/bearing=2/1/2 nm/N, cb=10e-9 m/N.
// Fi4000 requires s=4000*(10+5/3)e-9 = 0.00004666666666666667 m.
function fixture(reverse = false) {
  const base = beamCadFixture(), sign = reverse ? -1 : 1;
  const rotation = reverse ? [1, 0, 0, 0] as const : [0, 0, 0, 1] as const;
  const a = { ...testComponent('a', '50'), placement: testPlacement([0, 0, 0], rotation) };
  const b = { ...testComponent('b', '50'), placement: testPlacement([0, 0, 50 * sign], rotation) };
  const bolt: AssemblyComponent = { id: 'selected-bolt', name: 'M16', fixed: true, visible: true, suppressed: false,
    source: createStandardPartSource('hexBolt', 'M16', { length: '100' }), placement: testPlacement([25, 3 * sign, 0], rotation) };
  const document = { ...base.document, components: [a, b, bolt] };
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: 'axial', revision: 2,
    source: base.stamp, units: 'N-mm', members: [testMember(a, ['a'], 'a-'), testMember(b, ['b'], 'b-')],
    materials: [{ ...base.definition.materials[0], youngModulus: 200000, shearModulus: 200000 / 2.6 }],
    sections: base.definition.sections,
    supports: ['a-base', 'a-tip', 'b-base', 'b-tip'].map(nodeId => ({ nodeId,
      restrained: [true, true, nodeId === 'a-base', true, true, true] })),
    referenceLoads: [{ id: 'unit', kind: 'nodal', nodeId: 'b-tip', force: [0, 0, sign], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'interface', kind: 'node-pair', nodeIdA: 'a-tip', nodeIdB: 'b-base', normal: [0, 0, sign], gapMm: 0 }],
      loadFactors: [0, 1000, 0] },
    axialBolts: { schema: 'pointercad-cad-axial-bolts/1', source: base.stamp, analysisId: 'axial', analysisRevision: 2,
      bolts: [{ id: 'tie', boltComponentId: bolt.id, expectedPartKey: partKeyOf(bolt.source), expectedMaterialId: null,
        first: { memberId: 'a-beam', nodeId: 'a-base' }, second: { memberId: 'b-beam', nodeId: 'b-tip' },
        youngMPa: 200000, effectiveAreaMm2: 100, propertySource: TEST_EVIDENCE, idealization: 'bilateral-uniform-axial-elastic' }] } };
  const declaration: CadNativeBoltPreloadInput = { schema: 'pointercad-cad-native-bolt-preload/1', source: base.stamp,
    analysisId: 'axial', analysisRevision: 2, boltComponentId: bolt.id, contactId: 'interface', memberIds: ['a-beam', 'b-beam'],
    declaration: { boltId: 'tie', model: 'coaxial-outer-planes-series-bearing', modelSource: TEST_EVIDENCE,
      shankSource: TEST_EVIDENCE, shorteningSource: TEST_EVIDENCE,
      preloadN: { value: 4000, source: TEST_EVIDENCE }, threadCompliance: { value: 2e-9, source: TEST_EVIDENCE },
      headCompliance: { value: 1e-9, source: TEST_EVIDENCE }, bearingCompliance: { value: 2e-9, source: TEST_EVIDENCE },
      memberCompliance: { value: 5 / 3 * 1e-9, source: TEST_EVIDENCE }, externalLoadsN: [1000, 0], loadSource: TEST_EVIDENCE } };
  return { document, definition, declaration, context: { currentSource: base.stamp, bodies: new Map(), assemblyOptions: {} } };
}
describe('CAD to explicit native axial preload plan, pure preparation only', () => {
  it.each([false, true])('preserves actual straight CAD and both axis directions: reverse=%s', async reverse => {
    const f = fixture(reverse), before = JSON.stringify(f.document);
    const p = await prepareCadNativeBoltPreload(f.document, f.definition, f.declaration, f.context);
    const numeric = await prepareNativeBoltPreload(p.wire.plan);
    expect(p.authored.declaration.memberCompliance.value).toBeCloseTo(1 / 600000000, 18);
    expect(numeric.plan.boltPlan.bolts[0].youngPa).toBe(200000000000);
    expect(numeric.plan.boltPlan.bolts[0].areaM2).toBeCloseTo(.0001, 16);
    expect(numeric.plan.shorteningM).toBeCloseTo(7 / 150000, 16);
    expect(numeric.cb).toBeCloseTo(1e-8, 18);
    expect(numeric.normal).toEqual([0, 0, reverse ? -1 : 1]);
    expect(p.ownership.nodeIds).toEqual(['a-base', 'a-tip', 'b-base', 'b-tip']);
    expect(p.wire.source).toEqual({ documentId: f.document.id, revision: 7 });
    expect(p.inputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(f.document)).toBe(before);
  });
  it('rejects noncoaxial actual CAD even when all ownership stamps match', async () => {
    const f = fixture();
    const moved = { ...f.document, components: f.document.components.map(c => c.id === 'b' ? { ...c, placement: testPlacement([.1, 0, 50]) } : c) };
    await expect(prepareCadNativeBoltPreload(moved, f.definition, f.declaration, f.context)).rejects.toMatchObject({ code: 'bolt-axis' });
  });
  it('rejects another document, document revision, geometry revision, analysis revision and bolt selection', async () => {
    const f = fixture();
    for (const declaration of [
      { ...f.declaration, source: { ...f.declaration.source, documentId: 'other' } },
      { ...f.declaration, source: { ...f.declaration.source, documentRevision: 8 } },
      { ...f.declaration, source: { ...f.declaration.source, geometryRevision: 'other' } },
      { ...f.declaration, analysisRevision: 3 }, { ...f.declaration, boltComponentId: 'other' },
      { ...f.declaration, memberIds: ['b-beam', 'a-beam'] }, { ...f.declaration, memberIds: ['a-beam', 'a-beam'] },
    ]) await expect(prepareCadNativeBoltPreload(f.document, f.definition, declaration, f.context)).rejects.toThrow();
  });
  it('refuses missing values, provenance, wrong member compliance and foreign units', async () => {
    const f = fixture(), { threadCompliance, ...missing } = f.declaration.declaration;
    expect(threadCompliance.value).toBe(2e-9);
    for (const declaration of [missing, { ...f.declaration.declaration, preloadN: { value: 4000 } },
      { ...f.declaration.declaration, memberCompliance: { value: 2.5e-9, source: TEST_EVIDENCE } },
      { ...f.declaration.declaration, units: 'nm/N' },
    ]) await expect(prepareCadNativeBoltPreload(f.document, f.definition, { ...f.declaration, declaration }, f.context)).rejects.toThrow();
  });
  it('rejects lost contact topology, non-unit reference load and reversed contact normal', async () => {
    const f = fixture();
    for (const definition of [
      { ...f.definition, contact: { ...f.definition.contact, segmentsPerMember: 2 } },
      { ...f.definition, referenceLoads: [{ ...f.definition.referenceLoads[0], force: [0, 0, 1000] }] },
      { ...f.definition, contact: { ...f.definition.contact, contacts: [{ ...f.definition.contact.contacts[0], normal: [0, 0, -1] }] } },
    ]) await expect(prepareCadNativeBoltPreload(f.document, definition, f.declaration, f.context)).rejects.toThrow();
  });
  it('does not invoke accessor payloads or silently accept unknown fields', async () => {
    const f = fixture(); let invoked = false;
    const accessor = { ...f.declaration, get extra() { invoked = true; return 1; } };
    await expect(prepareCadNativeBoltPreload(f.document, f.definition, accessor, f.context)).rejects.toThrow();
    expect(invoked).toBe(false);
    await expect(prepareCadNativeBoltPreload(f.document, f.definition, { ...f.declaration, torqueNm: 10 }, f.context)).rejects.toThrow();
  });
});
