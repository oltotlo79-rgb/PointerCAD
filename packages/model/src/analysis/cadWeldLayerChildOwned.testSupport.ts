import { createAssemblyDocument } from '../assembly/createAssemblyDocument.js';
import { placementFingerprint } from '../assembly/fastening/frames.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument } from '../assembly/types.js';
import { weldSegmentsOf } from '../assembly/welding/planFilletWeld.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import { testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import type { CadWeldLayerInputs } from './weldLayerInput.js';

export const WELDED_CHILD_REF = 'welded-cell';
const PREFIXES = { P1: 'p1', P2: 'p2' } as const;

/**
 * The welded child IS the real top-level weld fixture (two flat bars a, b and a bead group made by planFilletWeld +
 * applyFilletWeld), saved as a child document. It is placed twice: P1 translated by (100,0,0) and P2 rotated +90 deg
 * about z then translated by (0,200,0). Each occurrence gets its own members and its own weld associations; both
 * associations name the SAME child-local bead id, so only the occurrence prefix can tell them apart.
 */
export function childOwnedWeldFixture(segments?: readonly { readonly start: number; readonly length: number }[]) {
  const top = cadWeldLayerFixture(segments);
  const child: AssemblyDocument = { ...top.document, id: createAssemblyDocument('welded cell').id };
  const subAssemblies = new Map([[WELDED_CHILD_REF, child]]);
  const parent = (id: string, placement: AssemblyComponent['placement'], fixed: boolean): AssemblyComponent => ({
    id, name: id, source: { kind: 'subAssembly', assemblyRef: WELDED_CHILD_REF }, placement, fixed, visible: true, suppressed: false,
  });
  const document: AssemblyDocument = { ...top.document, components: [
    parent('P1', testPlacement([100, 0, 0]), true),
    parent('P2', testPlacement([0, 200, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]), false),
  ] };
  const a = child.components.find(c => c.id === 'a'), b = child.components.find(c => c.id === 'b');
  if (a === undefined || b === undefined) throw new Error('welded child members missing');
  const beads = weldSegmentsOf(child).get('weld-1') ?? [];
  const members = (Object.keys(PREFIXES) as (keyof typeof PREFIXES)[]).flatMap(occurrence => [
    testMember(a, [occurrence, 'a'], `${PREFIXES[occurrence]}a-`), testMember(b, [occurrence, 'b'], `${PREFIXES[occurrence]}b-`)]);
  const definition: StandardBeamContactDefinition = { ...top.definition, members,
    supports: [{ nodeId: 'p1a-tip', restrained: [true, true, true, true, true, true] }, { nodeId: 'p1b-tip', restrained: [true, true, true, true, true, true] },
      { nodeId: 'p2a-tip', restrained: [true, true, true, true, true, true] }, { nodeId: 'p2b-tip', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'force', kind: 'nodal', nodeId: 'p1a-base', force: [0, 0, 1], moment: [0, 0, 0] }],
    contact: { ...top.definition.contact, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'p1b-base', normal: [0, 0, 1], gapMm: 10 }] } };
  const associations: CadWeldLayerInputs = { ...top.associations, welds: (Object.keys(PREFIXES) as (keyof typeof PREFIXES)[]).flatMap(occurrence =>
    beads.map((bead, index): CadWeldLayerInputs['welds'][number] => ({
      id: `${PREFIXES[occurrence]}-throat-${index}`, beadComponentId: bead.id,
      expectedPartKey: partKeyOf(bead.source), expectedPlacementKey: placementFingerprint(bead.placement), expectedMaterialId: 'aluminum',
      first: { memberId: `${PREFIXES[occurrence]}a-beam`, nodeId: `${PREFIXES[occurrence]}a-base` },
      second: { memberId: `${PREFIXES[occurrence]}b-beam`, nodeId: `${PREFIXES[occurrence]}b-base` },
      youngMPa: 1000, poisson: .25, effectiveThroatMm: 2, complianceLengthMm: 1,
      propertySource: TEST_EVIDENCE, idealization: 'rectangular-effective-elastic-throat' }))) };
  const context = { ...top.context, assemblyOptions: { subAssemblies } };
  return { top, child, document, definition, associations, context, subAssemblies, beads };
}
