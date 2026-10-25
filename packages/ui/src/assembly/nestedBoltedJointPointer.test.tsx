import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, appendSolid, createAssemblyDocument, createEmptyPartDocument,
  createPointFeature, DEFAULT_COMPONENT_PLACEMENT, embedPart, EMPTY_PART_LIBRARY,
  replaceSketch, resolveAssembly,
  type AssemblyComponent, type AssemblyDocument, type HoleFeature, type HoleFaceOrigin,
  type Placement, type PrimitiveFeature, type SolidBody, type SubShapeRef,
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

interface ControlProps {
  readonly children?: React.ReactNode;
  readonly onSubmit?: (event: { readonly preventDefault: () => void }) => void;
}

/** 本物の締結の窓を描き、送信の処理を取り出す(予告・確定・命令は置き換えない)。 */
function submitPopover(): void {
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
  renderToStaticMarkup(<Probe />);
  if (submit === undefined) throw new Error('Real bolt form missing');
  submit({ preventDefault: vi.fn() });
}

const A = 'A/\u5b50,"α', B = 'B/\u5b50,"β';
const value = expressionValueFromNumber;
const flipped: Placement = { position: [value(0), value(20), value(0)], rotation: [1, 0, 0, 0] };

/**
 * 厚さ10の板の通し穴 9(面1 は普通の円筒の壁、面2 は上の合わせ面)。A は根の葉か入れ子の葉、B は入れ子の葉。
 * 光線の当たり(AssemblyMateFaceHit)だけを固定にし、振り分け・経路の確かめ・下書き・予告・確定・履歴は本物を通す。
 */
async function openFixture(rootFirst: boolean) {
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
  const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'plate.pcad', 'plate.pcad');
  const leaf = (id: string): AssemblyComponent => ({ id, name: id, placement: DEFAULT_COMPONENT_PLACEMENT,
    source: { kind: 'part', partRef: embedded.partRef }, fixed: false, visible: true, suppressed: false });
  const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [leaf('plate')] };
  const owner = (id: string, placement: Placement): AssemblyComponent => ({ id, name: id, placement,
    source: { kind: 'subAssembly', assemblyRef: 'child' }, fixed: false, visible: true, suppressed: false });
  const document: AssemblyDocument = { ...createAssemblyDocument('root'),
    components: [rootFirst ? leaf(A) : owner(A, DEFAULT_COMPONENT_PLACEMENT), owner(B, flipped)] };
  useAppStore.getState().openAssembly(document, { ...embedded.library, assemblies: new Map([['child', child]]) });
  const opened = useAppStore.getState().assembly;
  if (opened === null) throw new Error('Opened assembly missing');
  const library = useAppStore.getState().assemblyLibrary;
  const origin: HoleFaceOrigin = { kind: 'hole-face', featureId: hole.id,
    center: { sketchId: sketch.id, producer: { kind: 'point', featureId: point.id } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall' };
  const body: SolidBody = { featureId: hole.id, bodyKind: 'solid', isValid: true, volume: 8000 - 202.5 * Math.PI,
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
  const source = jointOccurrenceInputsOf(opened, library);
  const resolved = resolveAssembly(opened, { library, subAssemblies: source.subAssemblies });
  expect(resolved.errors).toEqual([]);
  const flat = flattenAssemblyGeometry(opened, resolved);
  const hitAt = (path: AssemblyOccurrencePath, faceIndex: number): AssemblyMateFaceHit => {
    const row = flat.components.find((component) => JSON.stringify(flat.occurrencePaths?.get(component.id)) === JSON.stringify(path));
    const partKey = row === undefined ? undefined : flat.partKeys.get(row.id);
    if (row === undefined || partKey === undefined) throw new Error(`Resolved leaf missing: ${JSON.stringify(path)}`);
    return { componentId: row.id, partKey, bodyFeatureId: body.featureId, faceIndex, occurrencePath: path };
  };
  const keys = new Set(flat.components.map((component) => flat.partKeys.get(component.id)));
  const partKey = [...keys][0];
  if (keys.size !== 1 || partKey === undefined) throw new Error('one shared part key expected');
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: opened, source, resolved,
    bodies: new Map([[partKey, [body]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  const first: AssemblyOccurrencePath = rootFirst ? [A] : [A, 'plate'];
  const second: AssemblyOccurrencePath = [B, 'plate'];
  return { opened, child, part, first, second, hitAt };
}

function attach() {
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
  return { interaction, press };
}

function startM8(): void {
  expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
  useAppStore.getState().updateBoltedJointDraft({ dimensionSeries: 'annexJA', nominal: 'M8',
    engagementSource: '12', bottomClearanceSource: '2', protrusionSource: '2' });
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('nested bolted joint through the real pointer handler', () => {
  it.each([false, true])('picks four faces by pointer and commits M8 length 30 with one history step; root first=%s', async (rootFirst) => {
    const f = await openFixture(rootFirst);
    const before = JSON.stringify([f.opened, f.child, f.part]);
    const initialUndo = useAppStore.getState().assemblyUndoStack;
    startM8();
    const { interaction, press } = attach();
    try {
      expect(press(f.hitAt(f.first, 1))?.addAccepted).toBe(true);
      expect(press(f.hitAt(f.first, 2))?.addAccepted).toBe(true);
      // 根の葉を先に選んだ時は平らな下書きに入り、入れ子の葉を選んだ時に経路 [A] の選択として移る。
      if (rootFirst) {
        expect(useAppStore.getState().assemblyNestedBoltDraft).toBeNull();
        expect(useAppStore.getState().assemblyBoltedJointDraft?.picks).toHaveLength(2);
      }
      expect(press(f.hitAt(f.second, 1))?.addAccepted).toBe(true);
      expect(useAppStore.getState().assemblyBoltedJointDraft?.picks).toEqual([]);
      expect(press(f.hitAt(f.second, 2))?.addAccepted).toBe(true);
      const picks = useAppStore.getState().assemblyNestedBoltDraft?.picks ?? [];
      // 普通の円筒の壁(面1)は実らせんの組にならず、面の選択のまま。
      expect(picks.map((pick) => [pick.kind, pick.path])).toEqual([
        ['jointOccurrence', f.first], ['jointOccurrence', f.first], ['jointOccurrence', f.second], ['jointOccurrence', f.second]]);
      expect(useAppStore.getState().assembly).toBe(f.opened);
      expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
      const ready = useAppStore.getState().assemblyNestedBoltPreview;
      if (ready?.kind !== 'plan' || !ready.result.ok) throw new Error(JSON.stringify(ready));
      expect([ready.result.plan.nominal, ready.result.plan.boltLength, ready.result.plan.gripLength]).toEqual(['M8', 30, 20]);
      submitPopover();
      const after = useAppStore.getState().assembly;
      if (after === null || after === f.opened) throw new Error('commit did not change the assembly');
      const added = after.components.filter((component) => !f.opened.components.some((old) => old.id === component.id));
      expect(added.map((component) => component.placement.position.map((entry) => entry.value))).toEqual([[20, 10, -10], [20, 10, 10]]);
      expect(after.jointOccurrenceConnections).toEqual([{ kind: 'bolt', firstPath: f.first, secondPath: f.second,
        componentIds: added.map((component) => component.id) }]);
      expect(JSON.stringify([f.opened, f.child, f.part])).toBe(before);
      useAppStore.getState().undo();
      expect(useAppStore.getState().assembly).toBe(f.opened);
      useAppStore.getState().redo();
      expect(useAppStore.getState().assembly).toBe(after);
    } finally { interaction.detach(); }
  });

  it('refuses a damaged nested path by pointer and keeps the document, history and draft; cancel changes nothing', async () => {
    const f = await openFixture(false);
    const initialUndo = useAppStore.getState().assemblyUndoStack;
    startM8();
    const { interaction, press } = attach();
    try {
      expect(press(f.hitAt(f.first, 1))?.addAccepted).toBe(true);
      const draft = useAppStore.getState().assemblyNestedBoltDraft;
      // 経路は表示の行から作り直さず当たりの経路のまま。存在しない子の部品を指す経路は解けずに断る。
      const missing = { ...f.hitAt(f.second, 1), occurrencePath: [B, 'missing'] as const };
      const refused = press(missing);
      expect(refused?.addAccepted).not.toBe(true);
      expect(useAppStore.getState().assemblyNestedBoltDraft).toBe(draft);
      expect(useAppStore.getState().assembly).toBe(f.opened);
      expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
      useAppStore.getState().cancelBoltedJoint();
      expect(useAppStore.getState().assemblyNestedBoltDraft).toBeNull();
      expect(useAppStore.getState().assembly).toBe(f.opened);
      expect(useAppStore.getState().assemblyUndoStack).toBe(initialUndo);
    } finally { interaction.detach(); }
  });
});
