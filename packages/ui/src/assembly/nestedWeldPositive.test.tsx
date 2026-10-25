import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument,
  DEFAULT_COMPONENT_PLACEMENT, embedPart, EMPTY_PART_LIBRARY, resolveAssembly,
  type AssemblyComponent, type AssemblyDocument, type Placement, type PrimitiveFeature, type SolidBody,
} from '@pointercad/model';
import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_BOX, STANDING_BOX, weldTestPlacement } from '../../../model/src/assembly/welding/filletWeld.testSupport.js';
import { t } from '../i18n/t.js';
import { chooseAssemblyBuild } from '../shell/menus/assemblyToolActions.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAssemblyInteraction, type AssemblyMateInputObservation } from '../viewport/attachAssemblyInteraction.js';
import { flattenAssemblyGeometry, type AssemblyMateFaceHit, type AssemblyOccurrencePath } from '../viewport/createAssemblyLayer.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import { FilletWeldPopover } from './FilletWeldPopover.js';

interface ControlProps {
  readonly children?: React.ReactNode;
  readonly 'data-testid'?: string;
  readonly disabled?: boolean;
  readonly onChange?: (event: { readonly currentTarget: { readonly value: string } }) => void;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
}

/** Capture the real rendered form handlers; no preview, command or commit is replaced. */
function popover() {
  const controls = new Map<string, ControlProps>();
  let submit: ControlProps['onSubmit'];
  function collect(node: React.ReactNode): void {
    if (!isValidElement<ControlProps>(node)) return;
    if (node.props.onSubmit !== undefined) submit = node.props.onSubmit;
    const id = node.props['data-testid'];
    if (id !== undefined) controls.set(id, node.props);
    React.Children.forEach(node.props.children, collect);
  }
  function Probe(): React.JSX.Element | null {
    const tree = FilletWeldPopover();
    collect(tree);
    return tree;
  }
  const markup = renderToStaticMarkup(<Probe />);
  if (submit === undefined) throw new Error('Real weld form missing');
  return { markup, submit, controls };
}

function change(id: string, value: string): void {
  const handler = popover().controls.get(id)?.onChange;
  if (handler === undefined) throw new Error(`Real input missing: ${id}`);
  handler({ currentTarget: { value } });
}

function leaf(id: string, partRef: string, placement: Placement): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef }, placement,
    fixed: false, visible: true, suppressed: false };
}

/** The model fixture has analytic line edges but no display tessellation. Sample those same lines for real UI picking. */
function pickableLines(body: SolidBody): SolidBody {
  if (body.coordinateFrame !== undefined || body.edges.some(edge => edge.curveKind !== 'line')) {
    throw new Error('This independent fixture requires unshifted straight box edges');
  }
  const edgePositions = new Float32Array(body.edges.flatMap(edge => [...edge.start, ...edge.end]));
  return { ...body, edges: body.edges.map((edge, index) => ({ ...edge, segmentOffset: index, segmentCount: 1 })),
    mesh: { ...body.mesh, edgePositions } };
}

async function fixture(nestedStanding: boolean) {
  const box = (name: string, x: number, y: number, z: number) => {
    const feature: PrimitiveFeature = { id: 'extrude-1', name, kind: 'primitive', suppressed: false,
      origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: expressionValueFromNumber(x), sizeY: expressionValueFromNumber(y), sizeZ: expressionValueFromNumber(z) } };
    return appendSolid(createEmptyPartDocument(), feature);
  };
  const standingPart = box('standing', 100, 8, 50), basePart = box('base', 100, 60, 10);
  const standing = await embedPart(EMPTY_PART_LIBRARY, standingPart, 's.pcad', 's.pcad');
  const base = await embedPart(standing.library, basePart, 'b.pcad', 'b.pcad');
  const standingLeaf = leaf('standing', standing.partRef, weldTestPlacement([0, 26, 10]));
  const baseLeaf = leaf('base', base.partRef, DEFAULT_COMPONENT_PLACEMENT);
  const ownerId = 'owner/group,"A';
  const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [nestedStanding ? standingLeaf : baseLeaf] };
  const owner: AssemblyComponent = { id: ownerId, name: ownerId, source: { kind: 'subAssembly', assemblyRef: 'child' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false };
  const document: AssemblyDocument = { ...createAssemblyDocument('root'), components: [owner, nestedStanding ? baseLeaf : standingLeaf] };
  const subAssemblies = new Map([['child', child]]);
  const library = { ...base.library, assemblies: subAssemblies };
  useAppStore.getState().openAssembly(document, library);
  const opened = useAppStore.getState().assembly;
  if (opened === null) throw new Error('Opened assembly missing');
  const actualLibrary = useAppStore.getState().assemblyLibrary;
  const source = jointOccurrenceInputsOf(opened, actualLibrary);
  const resolved = resolveAssembly(opened, { library: actualLibrary, subAssemblies: source.subAssemblies });
  expect(resolved.errors).toEqual([]);
  const flat = flattenAssemblyGeometry(opened, resolved);
  const standingPath: AssemblyOccurrencePath = nestedStanding ? [ownerId, 'standing'] : ['standing'];
  const basePath: AssemblyOccurrencePath = nestedStanding ? ['base'] : [ownerId, 'base'];
  const rowFor = (path: readonly string[]) => {
    const row = flat.components.find(component => JSON.stringify(flat.occurrencePaths?.get(component.id)) === JSON.stringify(path));
    if (row === undefined) throw new Error(`Resolved leaf missing: ${JSON.stringify(path)}`);
    const partKey = flat.partKeys.get(row.id);
    if (partKey === undefined) throw new Error('Resolved part key missing');
    return { row, partKey };
  };
  const standingRow = rowFor(standingPath), baseRow = rowFor(basePath);
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: opened, source, resolved,
    bodies: new Map([[standingRow.partKey, [pickableLines(STANDING_BOX)]], [baseRow.partKey, [pickableLines(BASE_BOX)]]]),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  const first: AssemblyMateFaceHit = { componentId: standingRow.row.id, partKey: standingRow.partKey,
    bodyFeatureId: 'extrude-1', faceIndex: 3, occurrencePath: standingPath };
  const second: AssemblyMateFaceHit = { componentId: baseRow.row.id, partKey: baseRow.partKey,
    bodyFeatureId: 'extrude-1', faceIndex: 5, occurrencePath: basePath };
  return { opened, child, standingPart, basePart, actualLibrary, standingPath, basePath, first, second };
}

beforeEach(() => {
  resetTestStore();
  // The existing SSR adapter supplies snapshots; all model/store actions remain real.
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('mixed root/nested weld through real pointer and popover actions', () => {
  it.each([true, false])('commits the independent tee and restores it with Undo/Redo; standing nested=%s', async nestedStanding => {
    const f = await fixture(nestedStanding);
    const sourceSnapshot = JSON.stringify([f.child, f.standingPart, f.basePart]);
    const initialUndo = useAppStore.getState().assemblyUndoStack;
    if (initialUndo === null) throw new Error('Opened assembly history missing');
    let currentHit: AssemblyMateFaceHit | null = f.first;
    const observed: AssemblyMateInputObservation[] = [];
    const canvas = Object.assign(new EventTarget(), { focus: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0 }) });
    const scene = { pickAssemblyFace: vi.fn(() => currentHit), pickComponent: vi.fn(() => null),
      worldToScreen: (point: readonly [number, number, number]): readonly [number, number] => [point[0], point[1] + point[2]] };
    const interaction = attachAssemblyInteraction(canvas, scene, {
      viewDirection: () => [0, 0, 1], observeMateInput: observation => observed.push({ ...observation }) });
    const press = () => canvas.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }),
      { button: 0, buttons: 1, altKey: false, clientX: 50, clientY: 44, pointerId: 1, shiftKey: false }));
    try {
      chooseAssemblyBuild('filletWeld');
      expect(popover().markup).toContain(t('assembly.filletWeld.pickFirstFace'));
      expect(popover().controls.get('fillet-weld-commit')?.disabled).toBe(true);
      press();
      expect(observed.at(-1)?.addAccepted).toBe(true);
      expect(popover().markup).toContain(t('assembly.filletWeld.pickEdge'));
      expect(popover().controls.get('fillet-weld-commit')?.disabled).toBe(true);
      // Keep the first face hit. Only a real edge-kind switch can advance here.
      press();
      expect(observed.at(-1)?.addAccepted).toBe(true);
      expect(popover().markup).toContain(t('assembly.filletWeld.pickSecondFace'));
      expect(popover().controls.get('fillet-weld-commit')?.disabled).toBe(true);
      currentHit = f.second;
      press();
      expect(observed.at(-1)?.addAccepted).toBe(true);
      expect(observed.every(observation => observation.jointOccurrenceIssue === undefined)).toBe(true);
      expect(popover().markup).toContain(t('assembly.filletWeld.picked'));
      expect(popover().controls.get('fillet-weld-commit')?.disabled).toBe(true);
      const picks = useAppStore.getState().assemblyNestedWeldDraft?.picks;
      expect(picks?.map(pick => pick.path)).toEqual([f.standingPath, f.standingPath, f.basePath]);
      expect(picks?.map(pick => [pick.ref.fingerprint.kind, pick.ref.index])).toEqual([['face', 3], ['edge', 2], ['face', 5]]);
      expect(useAppStore.getState().assembly).toBe(f.opened);
      expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
      change('fillet-weld-leg-second', '6');
      change('fillet-weld-leg-first', '8');
      change('fillet-weld-start', '10');
      change('fillet-weld-lengths', '20');
      change('fillet-weld-material', 'aluminum');
      const preview = useAppStore.getState().assemblyNestedWeldPreview;
      if (preview?.kind !== 'plan' || !preview.result.ok) throw new Error(`Real preview refused: ${JSON.stringify(preview)}`);
      expect(preview.result.plan.frame.origin).toEqual([0, 34, 10]);
      expect(preview.result.plan.nominalVolume).toBe(480);
      expect(preview.result.plan.segments).toEqual([{ start: 10, length: 20 }]);
      expect(popover().controls.get('fillet-weld-commit')?.disabled).toBe(false);
      expect(popover().markup).toContain(`${t('assembly.filletWeld.nominalVolume')} 480`);
      change('fillet-weld-leg-first', '4');
      const edited = useAppStore.getState().assemblyNestedWeldPreview;
      if (edited?.kind !== 'plan' || !edited.result.ok) throw new Error('Edited real preview missing');
      expect(edited.result.plan.nominalVolume).toBe(240);
      expect(popover().markup).toContain(`${t('assembly.filletWeld.nominalVolume')} 240`);
      change('fillet-weld-leg-first', '8');
      const preventDefault = vi.fn();
      popover().submit({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      const after = useAppStore.getState().assembly;
      if (after === null || after === f.opened) throw new Error('Real commit did not change assembly');
      expect(after.components).toHaveLength(3);
      const bead = after.components[2];
      if (bead === undefined) throw new Error('Generated bead missing');
      expect(bead.placement.position.map(value => value.value)).toEqual([10, 34, 10]);
      expect(bead.source.kind).toBe('standardPart');
      expect(after.jointOccurrenceConnections).toEqual([{ kind: 'weld', firstPath: f.standingPath,
        secondPath: f.basePath, componentIds: [bead.id] }]);
      const ownerFields = (component: AssemblyComponent) => ({ id: component.id, name: component.name,
        source: component.source, placement: component.placement, fixed: component.fixed,
        visible: component.visible, suppressed: component.suppressed });
      expect(after.components.slice(0, 2).map(ownerFields)).toEqual(f.opened.components.map(ownerFields));
      // The real weld command joins the owners and bead; their geometry stays unchanged.
      if (bead.rigidGroupId === undefined || bead.rigidGroupId.length === 0) throw new Error('Real rigid group missing');
      expect(after.components.map(component => component.rigidGroupId))
        .toEqual([bead.rigidGroupId, bead.rigidGroupId, bead.rigidGroupId]);
      expect(useAppStore.getState().assemblyFilletWeldDraft).toBeNull();
      expect(useAppStore.getState().assemblyNestedWeldDraft).toBeNull();
      expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(initialUndo.past.length + 1);
      useAppStore.getState().undo();
      expect(useAppStore.getState().assembly).toBe(f.opened);
      expect(useAppStore.getState().assembly?.jointOccurrenceConnections).toBeUndefined();
      useAppStore.getState().redo();
      expect(useAppStore.getState().assembly).toBe(after);
      expect(useAppStore.getState().assembly?.jointOccurrenceConnections).toEqual(after.jointOccurrenceConnections);
      expect(JSON.stringify([f.child, f.standingPart, f.basePart])).toBe(sourceSnapshot);
      expect(useAppStore.getState().assemblyLibrary.assemblies?.get('child')).toBe(f.child);
      expect(useAppStore.getState().assemblyLibrary.parts).toBe(f.actualLibrary.parts);
    } finally { interaction.detach(); }
  });
});
