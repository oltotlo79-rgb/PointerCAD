import { componentSourceKey, placementFingerprint } from '../assembly/fastening/frames.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import { planFilletWeld } from '../assembly/welding/planFilletWeld.js';
import { applyFilletWeld } from '../assembly/welding/applyFilletWeld.js';
import { lineEdge, planeFace, weldTestBox } from '../assembly/welding/filletWeld.testSupport.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import type { CadWeldLayerInputs } from './weldLayerInput.js';

/** Actual straight flat-bar sources and existing CAD weld planner, with analytic box boundary meshes. */
export function cadWeldLayerFixture(segments: readonly { readonly start: number; readonly length: number }[] = [{ start: 20, length: 10 }]) {
  const base = beamCadFixture();
  const a = { ...testComponent('a', '20'), placement: testPlacement([0, 0, 6]) };
  const b = { ...testComponent('b', '20'), placement: testPlacement([0, 6, 6], [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]) };
  const before = { ...base.document, components: [a, b] };
  const body = weldTestBox([0, 0, 0], [50, 6, 20]);
  const revisions = new Map<string, string>();
  const keyA = componentSourceKey(a, revisions), keyB = componentSourceKey(b, revisions);
  if (keyA === null || keyB === null) throw new Error('Actual standard source identities required');
  const plan = planFilletWeld(before, {
    first: { ...planeFace('a', '', [25, 6, 10], [0, 1, 0]), sourceKey: keyA },
    second: { ...planeFace('b', '', [25, 0, 10], [0, -1, 0]), sourceKey: keyB },
    edge: lineEdge([25, 6, 0], [1, 0, 0], 50), legOnSecond: 3, legOnFirst: 4,
    segments, materialId: 'aluminum',
  }, revisions, () => [body]);
  if (!plan.ok) throw new Error('CAD weld fixture refused: '+JSON.stringify(plan.rejections));
  const applied = applyFilletWeld(before, plan.plan, revisions);
  if (!applied.ok) throw new Error('CAD weld fixture apply refused');
  const document = applied.document, bead = document.components.find(c => c.id === applied.componentIds[0]);
  if (bead === undefined) throw new Error('Actual bead missing');
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: 'weld-contact', revision: 1,
    source: base.stamp, units: 'N-mm', members: [testMember(a, ['a'], 'a-'), testMember(b, ['b'], 'b-')],
    materials: base.definition.materials, sections: base.definition.sections,
    supports: [{ nodeId: 'a-tip', restrained: [true, true, true, true, true, true] },
      { nodeId: 'b-tip', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'force', kind: 'nodal', nodeId: 'a-base', force: [0, 0, 1], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b-base', normal: [0, 0, 1], gapMm: 10 }], loadFactors: [1, -1] } };
  const associations: CadWeldLayerInputs = { schema: 'pointercad-cad-weld-layers/1', source: base.stamp,
    analysisId: definition.id, analysisRevision: definition.revision, welds: applied.componentIds.map((id, index): CadWeldLayerInputs['welds'][number] => {
      const segment = document.components.find(c => c.id === id);
      if (segment === undefined) throw new Error('Actual interval missing');
      return { id: index === 0 ? 'effective-throat' : 'effective-throat-'+index, beadComponentId: segment.id,
      expectedPartKey: partKeyOf(segment.source), expectedPlacementKey: placementFingerprint(segment.placement), expectedMaterialId: 'aluminum',
      first: { memberId: 'a-beam', nodeId: 'a-base' }, second: { memberId: 'b-beam', nodeId: 'b-base' },
      youngMPa: 1000, poisson: .25, effectiveThroatMm: 2, complianceLengthMm: 1,
      propertySource: TEST_EVIDENCE, idealization: 'rectangular-effective-elastic-throat' };
    }) };
  const context = { currentSource: base.stamp, bodies: new Map([[partKeyOf(a.source), [body]]]), assemblyOptions: {} };
  return { document, definition, associations, context, beadId: bead.id };
}
