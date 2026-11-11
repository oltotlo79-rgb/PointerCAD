import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createUndoStack, pushUndo, redo, undo } from '../history/undoStack.js';
import { appendSolid, createEmptyPartDocument } from '../part/createPartDocument.js';
import type { PrimitiveFeature } from '../part/types.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { addComponent, createComponentFor, removeComponent, setComponentSuppressed } from './assemblyEdit.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { applyBoltedJoint } from './fastening/applyBoltedJoint.js';
import { planBoltedJoint } from './fastening/planBoltedJoint.js';
import type { FasteningHoleSelection } from './fastening/types.js';
import type { JointOccurrenceCommandContext } from './jointOccurrenceSelection.js';
import { embedPart, EMPTY_PART_LIBRARY } from './partLibrary.js';
import { resolveAssembly } from './resolveAssembly.js';
import { joinRigidGroup, rigidGroupsOf } from './rigidGroups.js';
import { buildStandardPartFromSource } from './standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument, JointOccurrenceConnection, Mate, PresentationStep } from './types.js';
import { removeFilletWeld } from './welding/applyFilletWeld.js';
import { commitOccurrenceFilletWeld, previewOccurrenceFilletWeld, type OccurrenceWeldPicks } from './welding/bindWeldSelection.js';
import { BASE_BOX, plainTee, STANDING_BOX, teeRequest, weldTestPlacement } from './welding/filletWeld.testSupport.js';

const A = 'a/子,"α', B = 'b/子,"β', C = 'c', D = 'd';

/** Three actual occurrence commands: AB, CD, AB; each produces two beads. */
async function connectedScene() {
  const box = (x: number, y: number, z: number) => {
    const feature: PrimitiveFeature = { id: 'extrude-1', name: 'box', kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: expressionValueFromNumber(x), sizeY: expressionValueFromNumber(y), sizeZ: expressionValueFromNumber(z) } };
    return appendSolid(createEmptyPartDocument(), feature);
  };
  const standing = await embedPart(EMPTY_PART_LIBRARY, box(100, 8, 50), 's.pcad', 's.pcad');
  const base = await embedPart(standing.library, box(100, 60, 10), 'b.pcad', 'b.pcad');
  const child: AssemblyDocument = { ...createAssemblyDocument('shared child'), components: [
    { id: 'standing', name: 'standing', source: { kind: 'part', partRef: standing.partRef },
      placement: weldTestPlacement([0, 26, 10]), fixed: false, visible: true, suppressed: false },
    { id: 'base', name: 'base', source: { kind: 'part', partRef: base.partRef },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false },
  ] };
  const owners: AssemblyComponent[] = [A, B, C, D].map(id => ({ id, name: id,
    source: { kind: 'subAssembly', assemblyRef: 'child' }, placement: DEFAULT_COMPONENT_PLACEMENT,
    fixed: id === A, visible: true, suppressed: false }));
  const subAssemblies = new Map([['child', child]]);
  const library = { ...base.library, assemblies: subAssemblies };
  let document: AssemblyDocument = { ...createAssemblyDocument('root'), components: owners };
  const request = teeRequest();
  const pairs: readonly (readonly [string, string])[] = [[A, B], [C, D], [A, B]];
  for (const [first, second] of pairs) {
    const inputs = { document, library, subAssemblies };
    const context: JointOccurrenceCommandContext = { inputs,
      view: { source: inputs, resolved: resolveAssembly(document, { library, subAssemblies, standardPart: buildStandardPartFromSource }) },
      partDocument: occurrence => occurrence.leafComponent.source.kind === 'part'
        ? library.parts.get(occurrence.leafComponent.source.partRef) ?? null : null,
      resolveFace: () => ({ status: 'missing' }),
      resolveWeldGeometry: (occurrence, ref) => ref.fingerprint.kind === 'edge'
        ? { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }
        : occurrence.leafComponent.id === 'standing'
          ? { kind: 'face', surfaceKind: 'plane', area: 5000, position: [50, 8, 25], axis: [0, 1, 0], radius: null }
          : { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: [0, 0, 1], radius: null },
      bodiesOf: occurrence => [occurrence.leafComponent.id === 'standing' ? STANDING_BOX : BASE_BOX],
    };
    const picks: OccurrenceWeldPicks = { first: { path: [first, 'standing'], ref: request.first.face },
      edge: { path: [first, 'standing'], ref: request.edge.edge }, second: { path: [second, 'base'], ref: request.second.face } };
    const choices = { legOnFirst: 8, legOnSecond: 6, materialId: 'aluminum',
      segments: [{ start: 10, length: 20 }, { start: 50, length: 20 }] };
    const preview = previewOccurrenceFilletWeld(context, picks, choices);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const committed = commitOccurrenceFilletWeld(context, picks, choices, preview);
    if (!committed.ok) throw new Error(committed.reason);
    document = committed.document;
  }
  expect(document.components.map(component => component.id)).toEqual([A, B, C, D,
    'component-1', 'component-2', 'component-3', 'component-4', 'component-5', 'component-6']);
  return { document, child, library };
}

const ids = (document: AssemblyDocument) => document.components.map(component => component.id);

describe('occurrence connection deletion', () => {
  it.each([
    { owner: A, remaining: [B, C, D, 'component-3', 'component-4'] },
    { owner: B, remaining: [A, C, D, 'component-3', 'component-4'] },
  ])('removes all connections of root $owner, keeping other real owners even in the same rigid group', async ({ owner, remaining }) => {
    const f = await connectedScene();
    const before = joinRigidGroup(f.document, [A, C]);
    const snapshot = JSON.stringify([before, f.child]);
    const unrelated = before.jointOccurrenceConnections?.[1];
    const after = removeComponent(before, owner);
    expect(ids(after)).toEqual(remaining);
    expect(after.jointOccurrenceConnections).toEqual([unrelated]);
    expect(after.jointOccurrenceConnections?.[0]).toBe(unrelated);
    for (const component of after.components) expect(component).toBe(before.components.find(entry => entry.id === component.id));
    expect(rigidGroupsOf(after).size).toBe(1);
    expect(JSON.stringify([before, f.child])).toBe(snapshot);
  });

  it('deletes an entire owned bead group from any member, without deleting another connection on the same owners', async () => {
    const { document } = await connectedScene();
    const after = removeComponent(document, 'component-2');
    expect(ids(after)).toEqual([A, B, C, D, 'component-3', 'component-4', 'component-5', 'component-6']);
    expect(after.jointOccurrenceConnections).toEqual(document.jointOccurrenceConnections?.slice(1));
    expect(after.components.find(component => component.id === A)?.fixed).toBe(true);
    expect(after.components.find(component => component.id === B)?.fixed).toBe(false);
  });

  it('uses the existing removeFilletWeld entry atomically, including duplicate and missing requested members', async () => {
    const { document } = await connectedScene();
    const after = removeFilletWeld(document, ['component-2', 'component-1', 'component-2', 'missing']);
    expect(ids(after)).toEqual([A, B, C, D, 'component-3', 'component-4', 'component-5', 'component-6']);
    expect(after.jointOccurrenceConnections).toHaveLength(2);
    expect(removeFilletWeld(after, ['component-1', 'missing'])).toBe(after);
    expect(removeFilletWeld(document, [])).toBe(document);
  });

  it('cleans every removed hardware ID from constraints and presentation while retaining unrelated entries', async () => {
    const { document } = await connectedScene();
    const mate = (id: string, first: string, second: string): Mate => ({ id, name: id, kind: 'coincident',
      a: { kind: 'origin', componentId: first, element: 'origin' }, b: { kind: 'origin', componentId: second, element: 'origin' },
      suppressed: false, flipped: false });
    const retained = mate('retain', C, D);
    const presentation: PresentationStep[] = [
      { id: 'mixed', name: 'mixed', start: 0, end: 1, body: { kind: 'explode',
        componentIds: ['component-1', B, 'component-2'], direction: { kind: 'world', axis: 'z' }, distance: expressionValueFromNumber(5) } },
      { id: 'joint-step', name: 'joint-step', start: 0, end: 1, body: { kind: 'joint', jointId: 'gone',
        from: expressionValueFromNumber(0), to: expressionValueFromNumber(90) } },
      { id: 'only-hardware', name: 'only-hardware', start: 0, end: 1, body: { kind: 'explode',
        componentIds: ['component-1', 'component-2'], direction: { kind: 'world', axis: 'z' }, distance: expressionValueFromNumber(5) } },
    ];
    const before: AssemblyDocument = { ...document, mates: [mate('one', A, 'component-1'), mate('two', B, 'component-2'), retained],
      joints: [{ id: 'gone', name: 'gone', kind: 'revolute', a: { kind: 'origin', componentId: 'component-2', element: 'z' },
        b: { kind: 'origin', componentId: B, element: 'z' }, minValue: null, maxValue: null, suppressed: false }], presentation };
    const after = removeComponent(before, 'component-1');
    expect(after.mates).toEqual([retained]);
    expect(after.mates[0]).toBe(retained);
    expect(after.joints).toEqual([]);
    expect(after.presentation).toHaveLength(1);
    expect(after.presentation[0]?.body).toMatchObject({ kind: 'explode', componentIds: [B] });
    expect(before.presentation).toBe(presentation);
    expect(before.mates).toHaveLength(3);
  });

  it('terminates shared generated-ID closure without deleting unrelated owners or connections', async () => {
    const { document } = await connectedScene();
    const connections = document.jointOccurrenceConnections;
    if (connections === undefined || connections[0] === undefined) throw new Error('connections missing');
    const shared: JointOccurrenceConnection = { ...connections[0], componentIds: ['component-2', 'component-5', 'missing'] };
    const before = { ...document, jointOccurrenceConnections: [shared, ...connections] };
    const after = removeComponent(before, 'component-1');
    expect(ids(after)).toEqual([A, B, C, D, 'component-3', 'component-4']);
    expect(after.jointOccurrenceConnections).toEqual([connections[1]]);
    expect(removeComponent(before, 'missing')).toBe(before);
  });

  it('keeps suppression reversible and still removes a suppressed owner with its owned hardware', async () => {
    const { document } = await connectedScene();
    const suppressed = setComponentSuppressed(document, A, true);
    expect(suppressed.jointOccurrenceConnections).toBe(document.jointOccurrenceConnections);
    expect(ids(suppressed)).toEqual(ids(document));
    const restored = setComponentSuppressed(suppressed, A, false);
    expect(restored.jointOccurrenceConnections).toBe(document.jointOccurrenceConnections);
    const removed = removeComponent(suppressed, A);
    expect(ids(removed)).toEqual([B, C, D, 'component-3', 'component-4']);
    // The surviving B retains its saved group field; singleton groups are inert
    // under the existing rigidGroupsOf contract. CD remains one active group.
    expect(rigidGroupsOf(removed).size).toBe(1);
    expect(removed.components.find(component => component.id === B)).toBe(suppressed.components.find(component => component.id === B));
  });

  it('preserves legacy deletion and no-op reference identity without introducing new metadata', () => {
    const before = plainTee();
    expect(removeComponent(before, 'missing')).toBe(before);
    const after = removeComponent(before, 'component-1');
    expect(ids(after)).toEqual(['component-2']);
    expect(after.components[0]).toBe(before.components[1]);
    expect(Object.hasOwn(after, 'jointOccurrenceConnections')).toBe(false);
    expect(before.components).toHaveLength(2);
  });

  it('retains the connection array itself when deleting an unrelated component', async () => {
    const { document } = await connectedScene();
    const spare = createComponentFor(document, { kind: 'part', partRef: 'unrelated' });
    const before = addComponent(document, spare);
    const after = removeComponent(before, spare.id);
    expect(ids(after)).toEqual([A, B, C, D, 'component-1', 'component-2', 'component-3', 'component-4', 'component-5', 'component-6']);
    expect(after.jointOccurrenceConnections).toBe(document.jointOccurrenceConnections);
    expect(removeComponent(after, spare.id)).toBe(after);
  });

  it('restores the exact previous ownership and children in one Undo step and redoes the same result', async () => {
    const { document, child } = await connectedScene();
    const snapshot = JSON.stringify(child);
    const after = removeComponent(document, A);
    const history = pushUndo(createUndoStack(document), after, { now: 10 });
    expect(history.past).toHaveLength(1);
    const back = undo(history);
    expect(back.present).toBe(document);
    expect(redo(back).present).toBe(after);
    expect(pushUndo(history, removeComponent(after, 'missing'), { now: 20 })).toBe(history);
    expect(JSON.stringify(child)).toBe(snapshot);
  });

  it('removes both bolt and nut generated by the actual bolt planner/apply command, preserving both plates', () => {
    let before = createAssemblyDocument('bolted');
    before = addComponent(before, createComponentFor(before, { kind: 'part', partRef: 'plateA' }));
    before = addComponent(before, createComponentFor(before, { kind: 'part', partRef: 'plateB' }));
    const revisions = new Map([['plateA', 'a'], ['plateB', 'b']]);
    const selection = (id: string, ref: string, revision: string, sign: number): FasteningHoleSelection => ({
      componentId: id, sourceKey: `part:${ref}@${revision}`, holeFeatureId: 'hole', hole: { kind: 'clearance', diameter: 9, length: 10 },
      axisOrigin: [0, 0, 0], axisDirection: [0, 0, sign], matingFaceNormal: [0, 0, -sign],
      matingFace: { bodyFeatureId: 'box', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100,
        position: [0, 0, 0], axis: [0, 0, -sign], radius: null } },
    });
    const plan = planBoltedJoint(before, { first: selection('component-1', 'plateA', 'a', -1),
      second: selection('component-2', 'plateB', 'b', 1), dimensionSeries: 'annexJA',
      explicitBolt: { nominal: 'M8', threadSeries: 'coarse' }, minimumProtrusion: 2, headWashers: [], nutWashers: [],
      lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA', lengths: [30],
        basis: 'perDiameterEvidence', verified: true, source: 'test fixture, not JIS availability' }] }, revisions);
    if (!plan.ok) throw new Error(JSON.stringify(plan.rejections));
    const applied = applyBoltedJoint(before, plan.plan, revisions);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    expect(applied.componentIds).toEqual(['component-3', 'component-4']);
    // Attach the durable ownership contract to actual generated bolt/nut components.
    const connected: AssemblyDocument = { ...applied.document, jointOccurrenceConnections: [{ kind: 'bolt',
      firstPath: ['component-1'], secondPath: ['component-2'], componentIds: applied.componentIds }] };
    const after = removeComponent(connected, 'component-3');
    expect(ids(after)).toEqual(['component-1', 'component-2']);
    expect(after.jointOccurrenceConnections).toEqual([]);
    expect(after.components[0]).toBe(connected.components[0]);
    expect(after.components[1]).toBe(connected.components[1]);
    expect(ids(connected)).toEqual(['component-1', 'component-2', 'component-3', 'component-4']);
  });
});
