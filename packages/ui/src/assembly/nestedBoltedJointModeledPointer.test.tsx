import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, appendSolid, createAssemblyDocument, createEmptyPartDocument,
  createPointFeature, createSubShapeReference, DEFAULT_COMPONENT_PLACEMENT, embedPart, EMPTY_PART_LIBRARY,
  partKeyOf, replaceSketch, resolveAssembly, threadMinorDiameter,
  type AssemblyComponent, type AssemblyDocument, type HoleFeature, type HoleFaceOrigin,
  type JointOccurrencePath, type Placement, type PrimitiveFeature, type SolidBody, type SolidFaceEntry, type SubShapeRef,
  type ThreadHoleFeature,
} from '@pointercad/model';
import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAssemblyInteraction, type AssemblyMateInputObservation } from '../viewport/attachAssemblyInteraction.js';
import { flattenAssemblyGeometry, type AssemblyMateFaceHit, type AssemblyOccurrencePath } from '../viewport/createAssemblyLayer.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import { BoltedJointPopover } from './BoltedJointPopover.js';
import { parseAssemblyTargetId } from './mateCommands.js';
import type { NestedBoltedJointPick } from './nestedBoltedJointDraft.js';

interface ControlProps {
  readonly children?: React.ReactNode;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
}

/** 本物の締結の窓を描き、送信の処理と表示の文を取り出す(予告・確定・命令は置き換えない)。 */
function popover() {
  let submit: ControlProps['onSubmit'];
  function collect(node: React.ReactNode): void {
    if (!isValidElement<ControlProps>(node)) return;
    if (node.props.onSubmit !== undefined) submit = node.props.onSubmit;
    React.Children.forEach(node.props.children, collect);
  }
  function Probe(): React.JSX.Element | null {
    const tree = BoltedJointPopover();
    collect(tree);
    return tree;
  }
  const markup = renderToStaticMarkup(<Probe />);
  if (submit === undefined) throw new Error('Real bolt form missing');
  return { markup, submit };
}

const A = 'A/\u5b50,"α', B = 'B/\u5b50,"β';
const value = expressionValueFromNumber;
const flipped: Placement = { position: [value(0), value(20), value(0)], rotation: [1, 0, 0, 0] };

/**
 * 通し穴 9 の板(入れ子 A の葉)と、M8 の実らせんのねじ穴の板(入れ子 B の葉)。B の壁は2つに分かれ、溝の面がつなぐ
 * (Astra の実らせんの分かれた壁の形と同じ。予告は M8 長さ20・ねじ込み10)。
 */
async function openModeled() {
  let part = createEmptyPartDocument();
  const sketch = part.sketches[0];
  if (sketch === undefined) throw new Error('initial sketch');
  const point = createPointFeature(sketch, absoluteCoordinate(20, 10, 0));
  part = replaceSketch(part, appendFeature(sketch, point));
  const base: PrimitiveFeature = { id: 'base-1', name: 'plate', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, -10) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: value(40), sizeY: value(20), sizeZ: value(10) } };
  const entry: SubShapeRef = { bodyFeatureId: base.id, index: 0,
    fingerprint: { kind: 'face', surfaceKind: 'plane', area: 800, position: [20, 10, 0], axis: [0, 0, 1], radius: null } };
  const hole: HoleFeature = { id: 'hole-1', name: 'clearance', kind: 'hole', suppressed: false,
    targetFeatureId: base.id, face: entry, centers: [{ sketchId: sketch.id, pointFeatureId: point.id }],
    diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) };
  part = appendSolid(appendSolid(part, base), hole);
  const plain = await embedPart(EMPTY_PART_LIBRARY, part, 'plate.pcad', 'plate.pcad');
  const thread: ThreadHoleFeature = { id: hole.id, name: 'M8', kind: 'threadHole', suppressed: false,
    targetFeatureId: hole.targetFeatureId, face: hole.face, centers: hole.centers,
    designation: 'M8', series: 'coarse', pitch: value(1.25), drillDiameter: value(threadMinorDiameter(8, 1.25)),
    depth: { kind: 'through' }, threadLength: value(10), representation: 'modeled', tiltAngle: value(0), tiltAzimuth: value(0) };
  const threadPart = { ...part, solids: part.solids.map((solid) => solid.id === thread.id ? thread : solid) };
  const threaded = await embedPart(plain.library, threadPart, 'thread.pcad', 'thread.pcad');
  const leaf = (partRef: string): AssemblyComponent => ({ id: 'plate', name: 'plate', placement: DEFAULT_COMPONENT_PLACEMENT,
    source: { kind: 'part', partRef }, fixed: false, visible: true, suppressed: false });
  const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [leaf(plain.partRef)] };
  const threadChild: AssemblyDocument = { ...createAssemblyDocument('thread-child'), components: [leaf(threaded.partRef)] };
  const owner = (id: string, assemblyRef: string, placement: Placement): AssemblyComponent => ({ id, name: id, placement,
    source: { kind: 'subAssembly', assemblyRef }, fixed: false, visible: true, suppressed: false });
  const document: AssemblyDocument = { ...createAssemblyDocument('root'),
    components: [owner(A, 'child', DEFAULT_COMPONENT_PLACEMENT), owner(B, 'thread-child', flipped)] };
  useAppStore.getState().openAssembly(document, { ...threaded.library,
    assemblies: new Map([['child', child], ['thread-child', threadChild]]) });
  const opened = useAppStore.getState().assembly;
  if (opened === null) throw new Error('Opened assembly missing');
  const library = useAppStore.getState().assemblyLibrary;
  const origin: HoleFaceOrigin = { kind: 'hole-face', featureId: hole.id,
    center: { sketchId: sketch.id, producer: { kind: 'point', featureId: point.id } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall' };
  const clearance: SolidBody = { featureId: hole.id, bodyKind: 'solid', isValid: true, volume: 8000 - 202.5 * Math.PI,
    faces: [
      { index: 0, surfaceKind: 'plane', area: 800, centroid: [20, 10, -10], axis: [0, 0, -1], radius: null,
        triangleOffset: 0, triangleCount: 0 },
      { index: 1, surfaceKind: 'cylinder', area: 90 * Math.PI, centroid: [20, 10, -5], axis: [0, 0, 1],
        axisOrigin: [20, 10, -5], cylinderSpan: [-5, 5], cylinderExterior: false, radius: 4.5,
        triangleOffset: 0, triangleCount: 0 },
      { index: 2, surfaceKind: 'plane', area: 800, centroid: [20, 10, 0], axis: [0, 0, 1], radius: null,
        triangleOffset: 0, triangleCount: 0 },
    ], edges: [], vertices: [], threadMarks: [],
    mesh: { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
      edgePositions: new Float32Array(0), triangleCount: 0 },
    origins: { version: 1, state: 'tracked', bindings: [
      { state: 'unique', current: { kind: 'face', index: 1 }, origin: { version: 1, shapeKind: 'face', identity: origin } },
      { state: 'unique', current: { kind: 'face', index: 2 }, origin: { version: 1, shapeKind: 'face',
        identity: { kind: 'box-face', featureId: base.id, role: 'top' } } },
    ] } };
  const piece = (index: number, extent: readonly [number, number], adjacentFaces: readonly number[]): SolidFaceEntry => ({
    index, surfaceKind: 'cylinder', area: 10, centroid: [20, 10, -5], axis: [0, 0, 1], axisOrigin: [20, 10, -5],
    cylinderSpan: null, cylinderAxialExtent: extent, cylinderExterior: false, radius: threadMinorDiameter(8, 1.25) / 2,
    triangleOffset: 0, triangleCount: 0, adjacentFaces });
  const modeled: SolidBody = { ...clearance, faces: [
    { index: 0, surfaceKind: 'plane', area: 800, centroid: [20, 10, -10], axis: [0, 0, -1], radius: null,
      triangleOffset: 0, triangleCount: 0, adjacentFaces: [1] },
    piece(1, [-5, 1], [0, 3, 4]),
    { index: 2, surfaceKind: 'plane', area: 800, centroid: [20, 10, 0], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: 0, adjacentFaces: [3] },
    piece(3, [0, 5], [1, 2, 4]),
    { index: 4, surfaceKind: 'other', area: 1, centroid: [23, 10, -5], axis: null, radius: null,
      triangleOffset: 0, triangleCount: 0, adjacentFaces: [1, 3] },
  ], origins: { version: 1, state: 'tracked', bindings: [
    { origin: { version: 1, shapeKind: 'face', identity: origin }, state: 'split',
      candidates: [{ kind: 'face', index: 1 }, { kind: 'face', index: 3 }] },
    { origin: { version: 1, shapeKind: 'face', identity: { ...origin, stage: 'thread', role: 'groove' } },
      state: 'unique', current: { kind: 'face', index: 4 } },
    { origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'base-1', role: 'top' } },
      state: 'unique', current: { kind: 'face', index: 2 } },
  ] } };
  const plainKey = partKeyOf({ kind: 'part', partRef: plain.partRef });
  const threadKey = partKeyOf({ kind: 'part', partRef: threaded.partRef });
  const source = jointOccurrenceInputsOf(opened, library);
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: opened, source,
    resolved: resolveAssembly(opened, { library, subAssemblies: source.subAssemblies }),
    bodies: new Map([[plainKey, [clearance]], [threadKey, [modeled]]]),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  const ref = (body: SolidBody, index: number): SubShapeRef => {
    const result = createSubShapeReference(body, 'face', index);
    if (result === null) throw new Error('face reference');
    return result;
  };
  const first: JointOccurrencePath = [A, 'plate'], second: JointOccurrencePath = [B, 'plate'];
  const picks: NestedBoltedJointPick[] = [
    { kind: 'jointOccurrence', path: first, partKey: plainKey, ref: ref(clearance, 1) },
    { kind: 'jointOccurrence', path: first, partKey: plainKey, ref: ref(clearance, 2) },
    { kind: 'modeledThreadGroup', path: second, partKey: threadKey,
      group: { bodyFeatureId: modeled.featureId, hitFaceIndex: 1, origin } },
    { kind: 'jointOccurrence', path: second, partKey: threadKey, ref: ref(modeled, 2) },
  ];
  return { opened, child, threadChild, part, threadPart, library, picks, first, second };
}

function start(engagementSource: string): void {
  expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
  useAppStore.getState().updateBoltedJointDraft({ dimensionSeries: 'annexJA', nominal: 'M8',
    engagementSource, bottomClearanceSource: '2', protrusionSource: '2' });
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('modeled-thread wall group through the real pointer handler', () => {
  it('turns a nested modeled wall hit into a thread group pick, keeps the clearance wall a face, and commits M8 length 20', async () => {
    const f = await openModeled();
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('view');
    const flat = flattenAssemblyGeometry(f.opened, view.resolved);
    const hitAt = (path: AssemblyOccurrencePath, faceIndex: number): AssemblyMateFaceHit => {
      const row = flat.components.find((component) => JSON.stringify(flat.occurrencePaths?.get(component.id)) === JSON.stringify(path));
      const partKey = row === undefined ? undefined : flat.partKeys.get(row.id);
      if (row === undefined || partKey === undefined) throw new Error(`Resolved leaf missing: ${JSON.stringify(path)}`);
      return { componentId: row.id, partKey, bodyFeatureId: 'hole-1', faceIndex, occurrencePath: path };
    };
    let currentHit: AssemblyMateFaceHit | null = null;
    const observed: AssemblyMateInputObservation[] = [];
    const canvas = Object.assign(new EventTarget(), { focus: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0 }) });
    const scene = { pickAssemblyFace: vi.fn(() => currentHit), pickComponent: vi.fn(() => null),
      worldToScreen: (point: readonly [number, number, number]): readonly [number, number] => [point[0], point[1] + point[2]] };
    const interaction = attachAssemblyInteraction(canvas, scene, {
      viewDirection: () => [0, 0, 1], observeMateInput: (observation) => observed.push({ ...observation }) });
    const press = (hit: AssemblyMateFaceHit): AssemblyMateInputObservation | undefined => {
      currentHit = hit;
      canvas.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }),
        { button: 0, buttons: 1, altKey: false, clientX: 50, clientY: 44, pointerId: 1, shiftKey: false }));
      return observed.at(-1);
    };
    const initialUndo = useAppStore.getState().assemblyUndoStack;
    const hover = (hit: AssemblyMateFaceHit): void => {
      currentHit = hit;
      canvas.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true, cancelable: true }),
        { button: 0, buttons: 0, altKey: false, clientX: 50, clientY: 44, pointerId: 1 }));
    };
    const expectHover = (hit: AssemblyMateFaceHit): void => {
      const draft = useAppStore.getState().assemblyNestedBoltDraft;
      const flatDraft = useAppStore.getState().assemblyBoltedJointDraft;
      hover(hit);
      // Compare the renderer's actual flattened row, not an invented leaf-only identity.
      expect(parseAssemblyTargetId(useAppStore.getState().hoveredElementId ?? '')).toEqual({
        componentId: hit.componentId, elementId: `hole-1#face:${hit.faceIndex}` });
      expect(useAppStore.getState().assemblyNestedBoltDraft).toBe(draft);
      expect(useAppStore.getState().assemblyBoltedJointDraft).toBe(flatDraft);
      expect(useAppStore.getState().assembly).toBe(f.opened);
      expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
    };
    try {
      start('8');
      expectHover(hitAt(f.first, 1));
      expect(press(hitAt(f.first, 1))?.addAccepted).toBe(true);
      expectHover(hitAt(f.first, 2));
      expect(press(hitAt(f.first, 2))?.addAccepted).toBe(true);
      const wallHit = hitAt(f.second, 1);
      const bodies = view.bodies.get(wallHit.partKey);
      const modeled = bodies?.[0];
      if (bodies === undefined || modeled === undefined || modeled.origins?.state !== 'tracked'
        || view.source === undefined) throw new Error('Current modeled evidence missing');
      const ambiguous: SolidBody = { ...modeled, origins: { ...modeled.origins,
        bindings: [...modeled.origins.bindings, modeled.origins.bindings[0]] } };
      const untracked: SolidBody = { ...modeled, origins: { version: 1, state: 'untracked', reason: 'missing-native-map' } };
      const badViews = [
        ...[[modeled, modeled], [ambiguous], [untracked], [{ ...modeled, isValid: false }]].map(rejected => ({
          ...view, bodies: new Map(view.bodies).set(wallHit.partKey, rejected) })),
        { ...view, source: { ...view.source, document: { ...f.opened } } },
      ];
      const beforeWall = useAppStore.getState().assemblyNestedBoltDraft;
      for (const invalidView of badViews) {
        useAppStore.setState({ assemblyView: invalidView });
        hover(wallHit);
        expect(useAppStore.getState().hoveredElementId).toBeNull();
        expect(press(wallHit)?.addAccepted).toBeUndefined();
        expect(useAppStore.getState().assemblyNestedBoltDraft).toBe(beforeWall);
        expect(useAppStore.getState().assembly).toBe(f.opened);
        expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
      }
      useAppStore.setState({ assemblyView: view });
      for (const invalidHit of [{ ...wallHit, componentId: 'not-the-rendered-row' },
        { ...wallHit, partKey: 'not-the-current-part' }]) {
        hover(invalidHit);
        expect(useAppStore.getState().hoveredElementId).toBeNull();
        expect(press(invalidHit)?.addAccepted).toBeUndefined();
        expect(useAppStore.getState().assemblyNestedBoltDraft).toBe(beforeWall);
      }
      expectHover(hitAt(f.second, 3));
      expectHover(wallHit);
      expect(press(hitAt(f.second, 1))?.addAccepted).toBe(true);
      expectHover(hitAt(f.second, 2));
      expect(press(hitAt(f.second, 2))?.addAccepted).toBe(true);
      const picks = useAppStore.getState().assemblyNestedBoltDraft?.picks ?? [];
      // The ordinary clearance wall stays a face pick; only the validated modeled wall becomes a thread group.
      expect(picks.map((pick) => [pick.kind, pick.path])).toEqual([
        ['jointOccurrence', f.first], ['jointOccurrence', f.first], ['modeledThreadGroup', f.second], ['jointOccurrence', f.second]]);
      expect(useAppStore.getState().assembly).toBe(f.opened);
      expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
      const ready = useAppStore.getState().assemblyNestedBoltPreview;
      if (ready?.kind !== 'plan' || !ready.result.ok) throw new Error(JSON.stringify(ready));
      expect([ready.result.plan.nominal, ready.result.plan.boltLength, ready.result.plan.engagedLength]).toEqual(['M8', 20, 10]);
      popover().submit({ preventDefault: vi.fn() });
      const after = useAppStore.getState().assembly;
      if (after === null || after === f.opened) throw new Error('commit did not change the assembly');
      const added = after.components.filter((component) => !f.opened.components.some((old) => old.id === component.id));
      expect(added.map((component) => component.placement.position.map((entry) => entry.value))).toEqual([[20, 10, -10]]);
      expect(after.jointOccurrenceConnections).toEqual([{ kind: 'bolt', firstPath: f.first, secondPath: f.second,
        componentIds: added.map((component) => component.id) }]);
      useAppStore.getState().undo();
      expect(useAppStore.getState().assembly).toBe(f.opened);
      useAppStore.getState().redo();
      expect(useAppStore.getState().assembly).toBe(after);
    } finally { interaction.detach(); }
  });
});
