import { componentSourceKey, placementFingerprint } from '../assembly/fastening/frames.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import { quaternionFromAxisAngle } from '../assembly/placementMath.js';
import { planFilletWeld } from '../assembly/welding/planFilletWeld.js';
import { applyFilletWeld } from '../assembly/welding/applyFilletWeld.js';
import { lineEdge, planeFace, weldTestBox } from '../assembly/welding/filletWeld.testSupport.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import type { CadWeldSpanInputs } from './weldSpanInput.js';

/** Real FB50x6x20 sources, actual planner/apply, analytic boundary meshes. No invented cylindrical body. */
export function cadWeldSpanFixture(mixed = false, segments = [{ start: 5, length: 10 }]) {
  const base = beamCadFixture();
  const a = { ...testComponent('a', '20'), placement: testPlacement(mixed ? [0, 0, 6] : [0, 0, 0]) };
  const b = { ...testComponent('b', '20'), placement: testPlacement(mixed ? [0, 6, 6] : [50, 6, 0],
    quaternionFromAxisAngle(mixed ? [0, 1, 0] : [0, 0, 1], Math.PI/2)) };
  const before = { ...base.document, components: [a, b] }, body = weldTestBox([0, 0, 0], [50, 6, 20]);
  const revisions = new Map<string, string>(), ka = componentSourceKey(a, revisions), kb = componentSourceKey(b, revisions);
  if (ka === null || kb === null) throw new Error('Missing actual member source');
  const plan = planFilletWeld(before, {
    first: { ...planeFace('a', '', [25, 6, 10], [0, 1, 0]), sourceKey: ka },
    second: { ...planeFace('b', '', mixed ? [0, 3, 10] : [25, 6, 10], mixed ? [-1, 0, 0] : [0, 1, 0]), sourceKey: kb },
    edge: lineEdge(mixed ? [10, 6, 0] : [44, 6, 10], mixed ? [1, 0, 0] : [0, 0, 1], 20),
    legOnSecond: 3, legOnFirst: 4, segments, materialId: 'aluminum',
  }, revisions, () => [body]);
  if (!plan.ok) throw new Error('Actual span fixture plan refused: '+JSON.stringify(plan.rejections));
  const applied = applyFilletWeld(before, plan.plan, revisions);
  if (!applied.ok) throw new Error('Actual span fixture apply refused');
  const document = applied.document;
  const associations: CadWeldSpanInputs = { schema: 'pointercad-cad-weld-layers/2', source: base.stamp,
    analysisId: 'span-cad', analysisRevision: 1, welds: applied.componentIds.map((id, i) => {
      const bead = document.components.find(c => c.id === id);
      if (bead === undefined) throw new Error('Missing actual bead');
      return { id: 'span-'+i, beadComponentId: id, expectedPartKey: partKeyOf(bead.source),
        expectedPlacementKey: placementFingerprint(bead.placement), expectedMaterialId: 'aluminum',
        first: mixed ? { kind: 'section-node', memberId: 'a-beam', nodeId: 'a-base' } : { kind: 'member-span', memberId: 'a-beam' },
        second: { kind: 'member-span', memberId: 'b-beam' }, youngMPa: 1000, poisson: .25,
        effectiveThroatMm: 2, complianceLengthMm: 1, propertySource: TEST_EVIDENCE,
        idealization: 'rectangular-effective-elastic-throat' };
    }) };
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: associations.analysisId,
    revision: 1, source: base.stamp, units: 'N-mm', members: [testMember(a, ['a'], 'a-'), testMember(b, ['b'], 'b-')],
    materials: base.definition.materials, sections: base.definition.sections,
    supports: [{ nodeId: 'a-base', restrained: [true, true, true, true, true, true] }, { nodeId: 'b-base', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'force', kind: 'nodal', nodeId: 'b-tip', force: [1, 0, 0], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 2, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b-tip', normal: [1, 0, 0], gapMm: 10 }], loadFactors: [1, 0, -1] },
    weldLayers: associations };
  const context = { currentSource: base.stamp, bodies: new Map([[partKeyOf(a.source), [body]]]), assemblyOptions: {} };
  return { document, definition, associations, context };
}
