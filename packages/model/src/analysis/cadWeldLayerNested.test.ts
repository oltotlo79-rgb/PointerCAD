import { describe, expect, it } from 'vitest';
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
import { prepareCadWeldLayers } from './cadWeldLayer.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import type { CadWeldLayerInputs } from './weldLayerInput.js';

/**
 * One child definition 'cell' holds one 20 mm flat bar 'bar' at its identity placement. It is placed twice:
 * P1 at (0,0,6) and P2 at (0,6,6) rotated -90 deg about x. That is exactly the world geometry of the top-level fixture
 * cadWeldLayer.testSupport.ts (a at (0,0,6), b at (0,6,6) with the same rotation), so the nested weld must give the same
 * physical layer as the legacy top-level path, while every endpoint comes from the exact leaf path.
 *
 * Independent world endpoints (testMember section centroid (25,3), generator extrudes along local +z):
 *   P1/bar base (25,3,0)+(0,0,6) = (25,3,6), tip (25,3,26).
 *   R_x(-90): (x,y,z) -> (x, z, -y); P2/bar base (25,0,-3)+(0,6,6) = (25,6,3), tip (25,20,-3)+(0,6,6) = (25,26,3).
 *
 * The weld is a root-generated connector made by the real occurrence commands (previewOccurrenceFilletWeld /
 * commitOccurrenceFilletWeld), so the saved jointOccurrenceConnections row is the producer's own. A weld whose beads are
 * stored inside the child document is a separate, still pending case and is not exercised here.
 */
const CHILD = 'cell';
const body = weldTestBox([0, 0, 0], [50, 6, 20]);
type Segments = readonly { readonly start: number; readonly length: number }[];

function nestedWeld(segments: Segments = [{ start: 20, length: 10 }]) {
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
    bodiesOf: () => [body],
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
  const adapter = { currentSource: base.stamp, bodies: new Map([[partKeyOf(bar.source), [body]]]),
    assemblyOptions: { library, subAssemblies }, jointOccurrence: context };
  return { document, definition, associations, adapter, beadIds: committed.componentIds, connection: committed.connection };
}

const close = (actual: readonly number[] | undefined, expected: readonly number[]) => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 9));
};
const NESTED_REFUSAL = /Nested weld endpoints require exactly one saved weld connection/;

describe('effective weld layer between nested leaf members of a repeated child definition', () => {
  it('uses each leaf world endpoint once, keeps the repeated occurrences distinct and equals the top-level physical layer', () => {
    const f = nestedWeld(), before = structuredClone(f.document);
    // Precondition: the real commit saved one weld connection on the two exact leaf paths with the whole bead group.
    expect(f.connection).toEqual({ kind: 'weld', firstPath: ['P1', 'bar'], secondPath: ['P2', 'bar'], componentIds: [...f.beadIds] });
    expect(f.document.jointOccurrenceConnections).toEqual([f.connection]);
    const result = prepareCadWeldLayers(f.document, f.definition, f.associations, f.adapter);
    const node = (id: string) => result.geometry.nodes.find(n => n.id === id)?.position;
    close(node('a-base'), [25, 3, 6]); close(node('a-tip'), [25, 3, 26]);
    close(node('b-base'), [25, 6, 3]); close(node('b-tip'), [25, 26, 3]);
    expect(result.geometry.members.map(m => m.occurrencePath)).toEqual([['P1', 'bar'], ['P2', 'bar']]);
    // Independent cross-check with the legacy top-level weld of the same world geometry.
    const top = cadWeldLayerFixture();
    const legacy = prepareCadWeldLayers(top.document, top.definition, top.associations, top.context);
    expect(result.welds).toHaveLength(1);
    const [nested] = result.welds, [flat] = legacy.welds;
    if (nested === undefined || flat === undefined) throw new Error('weld layer missing');
    expect([nested.nodeIdA, nested.nodeIdB, nested.widthM, nested.lengthM, nested.thicknessM, nested.youngPa, nested.poisson])
      .toEqual([flat.nodeIdA, flat.nodeIdB, flat.widthM, flat.lengthM, flat.thicknessM, flat.youngPa, flat.poisson]);
    close(nested.centerM, flat.centerM); close(nested.normal, flat.normal); close(nested.along, flat.along);
    expect(f.document).toEqual(before);
  });

  it('refuses swapped endpoint owners against the saved connection order', () => {
    const f = nestedWeld();
    const swapped = { ...f.associations, welds: f.associations.welds.map(w => ({ ...w,
      first: { memberId: 'b-beam', nodeId: 'b-base' }, second: { memberId: 'a-beam', nodeId: 'a-base' } })) };
    expect(swapped.welds[0]?.first.memberId).not.toBe(f.associations.welds[0]?.first.memberId);
    expect(() => prepareCadWeldLayers(f.document, f.definition, swapped, f.adapter)).toThrow(NESTED_REFUSAL);
  });

  it('refuses an association list that covers only part of the saved bead group', () => {
    const f = nestedWeld([{ start: 5, length: 10 }, { start: 30, length: 10 }]);
    expect(f.beadIds).toHaveLength(2);
    const partial = { ...f.associations, welds: f.associations.welds.slice(0, 1) };
    expect(partial.welds).toHaveLength(1);
    expect(() => prepareCadWeldLayers(f.document, f.definition, partial, f.adapter)).toThrow();
  });

  it('refuses a nested weld when the analysis context carries no joint occurrence view', () => {
    const f = nestedWeld();
    const { jointOccurrence, ...withoutView } = f.adapter;
    expect(jointOccurrence).toBeDefined();
    expect(() => prepareCadWeldLayers(f.document, f.definition, f.associations, withoutView))
      .toThrow(/Nested weld groups need the current joint occurrence view/);
  });

  it('refuses a saved connection whose kind was changed to bolt', () => {
    const f = nestedWeld();
    const wrongKind = { ...f.document, jointOccurrenceConnections: [{ ...f.connection, kind: 'bolt' as const }] };
    expect(wrongKind.jointOccurrenceConnections[0]?.kind).toBe('bolt');
    expect(() => prepareCadWeldLayers(wrongKind, f.definition, f.associations, f.adapter)).toThrow(NESTED_REFUSAL);
  });

  it('refuses a stale bead placement recorded in the association', () => {
    const f = nestedWeld();
    const bead = f.document.components.find(c => c.id === f.beadIds[0]);
    if (bead === undefined) throw new Error('bead missing');
    const moved = { ...f.document, components: f.document.components.map(c => c.id === bead.id
      ? { ...c, placement: testPlacement([1, 0, 0]) } : c) };
    const movedBead = moved.components.find(c => c.id === bead.id);
    expect(movedBead === undefined ? '' : placementFingerprint(movedBead.placement)).not.toBe(f.associations.welds[0]?.expectedPlacementKey);
    expect(() => prepareCadWeldLayers(moved, f.definition, f.associations, f.adapter)).toThrow();
  });

  it('refuses a suppressed second parent occurrence before any weld check', () => {
    const f = nestedWeld();
    const suppressed = { ...f.document, components: f.document.components.map(c => c.id === 'P2' ? { ...c, suppressed: true } : c) };
    expect(suppressed.components.find(c => c.id === 'P2')?.suppressed).toBe(true);
    expect(() => prepareCadWeldLayers(suppressed, f.definition, f.associations, f.adapter)).toThrow();
  });

  it('refuses a second parent replaced by another child definition', () => {
    const f = nestedWeld();
    const replaced = { ...f.document, components: f.document.components.map(c => c.id === 'P2'
      ? { ...c, source: { kind: 'subAssembly' as const, assemblyRef: 'other-cell' } } : c) };
    const p2 = replaced.components.find(c => c.id === 'P2');
    expect(p2?.source.kind === 'subAssembly' ? p2.source.assemblyRef : '').toBe('other-cell');
    expect(() => prepareCadWeldLayers(replaced, f.definition, f.associations, f.adapter)).toThrow();
  });

  it('keeps the legacy top-level weld layer working without any joint occurrence context', () => {
    const top = cadWeldLayerFixture();
    expect(top.document.jointOccurrenceConnections ?? []).toEqual([]);
    const legacy = prepareCadWeldLayers(top.document, top.definition, top.associations, top.context);
    expect(legacy.welds).toHaveLength(1);
  });
});
