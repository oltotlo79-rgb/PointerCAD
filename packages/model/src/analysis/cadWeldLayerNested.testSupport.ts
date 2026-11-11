import { createAssemblyDocument } from '../assembly/createAssemblyDocument.js';
import { placementFingerprint } from '../assembly/fastening/frames.js';
import type { JointOccurrenceInputs } from '../assembly/jointOccurrence.js';
import type { JointOccurrenceCommandContext } from '../assembly/jointOccurrenceSelection.js';
import { EMPTY_PART_LIBRARY } from '../assembly/partLibrary.js';
import { partKeyOf, resolveAssembly } from '../assembly/resolveAssembly.js';
import { buildStandardPartFromSource } from '../assembly/standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument } from '../assembly/types.js';
import { commitOccurrenceFilletWeld, previewOccurrenceFilletWeld, type OccurrenceWeldPicks } from '../assembly/welding/bindWeldSelection.js';
import { lineEdge, planeFace, weldTestBox } from '../assembly/welding/filletWeld.testSupport.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import type { CadWeldLayerInputs } from './weldLayerInput.js';

/**
 * One child definition 'cell' holds one 20 mm flat bar 'bar' at its identity placement. It is placed twice:
 * P1 at (0,0,6) and P2 at (0,6,6) rotated -90 deg about x, the same world geometry as cadWeldLayer.testSupport.ts.
 * The weld is a root-generated connector made by the real occurrence commands, so the saved
 * jointOccurrenceConnections row is the producer's own. Beads stored inside the child document are not covered.
 */
const CHILD = 'cell';
export const NESTED_WELD_BODY = weldTestBox([0, 0, 0], [50, 6, 20]);

export function nestedWeldFixture(segments: readonly { readonly start: number; readonly length: number }[] = [{ start: 20, length: 10 }]) {
  const base = beamCadFixture();
  const bar = testComponent('bar', '20');
  const cell: AssemblyDocument = { ...createAssemblyDocument('cell'), components: [bar] };
  const subAssemblies = new Map([[CHILD, cell]]);
  const parent = (id: string, placement: AssemblyComponent['placement'], fixed: boolean): AssemblyComponent => ({
    ...testComponent(id), source: { kind: 'subAssembly', assemblyRef: CHILD }, placement, fixed,
  });
  const root: AssemblyDocument = { ...base.document, components: [
    parent('P1', testPlacement([0, 0, 6]), true),
    parent('P2', testPlacement([0, 6, 6], [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]), false),
  ] };
  const library = { ...EMPTY_PART_LIBRARY, assemblies: subAssemblies };
  const options = { library, subAssemblies, standardPart: buildStandardPartFromSource };
  const contextFor = (inputs: JointOccurrenceInputs): JointOccurrenceCommandContext => ({ inputs,
    view: { source: inputs, resolved: resolveAssembly(inputs.document, options) },
    partDocument: occurrence => occurrence.leafComponent.source.kind === 'standardPart'
      ? buildStandardPartFromSource(occurrence.leafComponent.source) : null,
    resolveFace: () => ({ status: 'missing' }),
    // Local leaf geometry of the bar (the command places it with the exact occurrence pose).
    resolveWeldGeometry: (occurrence, ref) => ref.fingerprint.kind === 'edge'
      ? { kind: 'edge', curveKind: 'line', length: 50, position: [25, 6, 0], axis: [1, 0, 0], radius: null }
      : occurrence.path[0] === 'P1'
        ? { kind: 'face', surfaceKind: 'plane', area: 1000, position: [25, 6, 10], axis: [0, 1, 0], radius: null }
        : { kind: 'face', surfaceKind: 'plane', area: 1000, position: [25, 0, 10], axis: [0, -1, 0], radius: null },
    bodiesOf: () => [NESTED_WELD_BODY],
  });
  const first = contextFor({ document: root, library, subAssemblies });
  const picks: OccurrenceWeldPicks = {
    first: { path: ['P1', 'bar'], ref: planeFace('bar', '', [25, 6, 10], [0, 1, 0]).face },
    edge: { path: ['P1', 'bar'], ref: lineEdge([25, 6, 0], [1, 0, 0], 50).edge },
    second: { path: ['P2', 'bar'], ref: planeFace('bar', '', [25, 0, 10], [0, -1, 0]).face },
  };
  const choices = { legOnSecond: 3, legOnFirst: 4, materialId: 'aluminum', segments };
  const preview = previewOccurrenceFilletWeld(first, picks, choices);
  if (!preview.ok) throw new Error('nested weld preview refused: ' + JSON.stringify(preview));
  const committed = commitOccurrenceFilletWeld(first, picks, choices, preview);
  if (!committed.ok) throw new Error('nested weld commit refused: ' + committed.reason);
  const document = committed.document;
  const context = contextFor({ document, library, subAssemblies });
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: 'weld-contact', revision: 1,
    source: base.stamp, units: 'N-mm', members: [testMember(bar, ['P1', 'bar'], 'a-'), testMember(bar, ['P2', 'bar'], 'b-')],
    materials: base.definition.materials, sections: base.definition.sections,
    supports: [{ nodeId: 'a-tip', restrained: [true, true, true, true, true, true] },
      { nodeId: 'b-tip', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'force', kind: 'nodal', nodeId: 'a-base', force: [0, 0, 1], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b-base', normal: [0, 0, 1], gapMm: 10 }], loadFactors: [1, -1] } };
  const associations: CadWeldLayerInputs = { schema: 'pointercad-cad-weld-layers/1', source: base.stamp,
    analysisId: definition.id, analysisRevision: definition.revision, welds: committed.componentIds.map((id, index): CadWeldLayerInputs['welds'][number] => {
      const segment = document.components.find(c => c.id === id);
      if (segment === undefined) throw new Error('Actual interval missing');
      return { id: index === 0 ? 'effective-throat' : 'effective-throat-' + index, beadComponentId: segment.id,
        expectedPartKey: partKeyOf(segment.source), expectedPlacementKey: placementFingerprint(segment.placement), expectedMaterialId: 'aluminum',
        first: { memberId: 'a-beam', nodeId: 'a-base' }, second: { memberId: 'b-beam', nodeId: 'b-base' },
        youngMPa: 1000, poisson: .25, effectiveThroatMm: 2, complianceLengthMm: 1,
        propertySource: TEST_EVIDENCE, idealization: 'rectangular-effective-elastic-throat' };
    }) };
  const adapter = { currentSource: base.stamp, bodies: new Map([[partKeyOf(bar.source), [NESTED_WELD_BODY]]]),
    assemblyOptions: { library, subAssemblies }, jointOccurrence: context };
  return { document, library, definition, associations, adapter, beadIds: committed.componentIds, connection: committed.connection };
}
