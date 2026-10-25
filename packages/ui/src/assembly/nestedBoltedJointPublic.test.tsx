import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, appendSolid, createAssemblyDocument, createEmptyPartDocument,
  createPointFeature, createSubShapeReference, DEFAULT_COMPONENT_PLACEMENT, embedPart, EMPTY_PART_LIBRARY,
  partKeyOf, replaceSketch, resolveAssembly,
  type AssemblyComponent, type AssemblyDocument, type HoleFeature, type HoleFaceOrigin,
  type JointOccurrencePath, type Placement, type PrimitiveFeature, type SolidBody, type SubShapeRef,
} from '@pointercad/model';
import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { jointOccurrenceInputsOf } from '../viewport/pickJointOccurrence.js';
import { BoltedJointPopover } from './BoltedJointPopover.js';
import { BOLTED_JOINT_PICK_GUIDE_KEYS } from './boltedJointDraft.js';
import type { NestedBoltedJointPick } from './nestedBoltedJointDraft.js';

interface ControlProps {
  readonly children?: React.ReactNode;
  readonly 'data-testid'?: string;
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

/** 厚さ10の板の通し穴 9 を2枚、入れ子の組の葉として向かい合わせる(M8 長さ30・掴み20 の既知の組)。 */
async function openFixture() {
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
  const leaf: AssemblyComponent = { id: 'plate', name: 'plate', placement: DEFAULT_COMPONENT_PLACEMENT,
    source: { kind: 'part', partRef: embedded.partRef }, fixed: false, visible: true, suppressed: false };
  const child: AssemblyDocument = { ...createAssemblyDocument('child'), components: [leaf] };
  const owner = (id: string, placement: Placement): AssemblyComponent => ({ id, name: id, placement,
    source: { kind: 'subAssembly', assemblyRef: 'child' }, fixed: false, visible: true, suppressed: false });
  const document: AssemblyDocument = { ...createAssemblyDocument('root'),
    components: [owner(A, DEFAULT_COMPONENT_PLACEMENT), owner(B, flipped)] };
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
  const key = partKeyOf({ kind: 'part', partRef: embedded.partRef });
  const source = jointOccurrenceInputsOf(opened, library);
  useAppStore.setState({ isComputing: false, assemblyView: { sourceDocument: opened, source,
    resolved: resolveAssembly(opened, { library, subAssemblies: source.subAssemblies }), bodies: new Map([[key, [body]]]),
    appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } });
  const ref = (index: number): SubShapeRef => {
    const result = createSubShapeReference(body, 'face', index);
    if (result === null) throw new Error('face reference');
    return result;
  };
  const pick = (path: JointOccurrencePath, index: number): NestedBoltedJointPick =>
    ({ kind: 'jointOccurrence', path, partKey: key, ref: ref(index) });
  const first: JointOccurrencePath = [A, 'plate'], second: JointOccurrencePath = [B, 'plate'];
  return { opened, child, part, library, picks: [pick(first, 1), pick(first, 2), pick(second, 1), pick(second, 2)], first, second };
}

function prompt(markup: string): boolean[] {
  return BOLTED_JOINT_PICK_GUIDE_KEYS.map((key) => markup.includes(t(key)));
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('public nested bolted joint: real store, real popover submit', () => {
  it('advances the rendered prompt per nested pick and commits M8 length 30 with one Undo/Redo', async () => {
    const f = await openFixture();
    const before = JSON.stringify([f.opened, f.child, f.part]);
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ dimensionSeries: 'annexJA', nominal: 'M8',
      engagementSource: '12', bottomClearanceSource: '2', protrusionSource: '2' });
    f.picks.forEach((selected, index) => {
      // 旧来の誤り: 入れ子を選んでも平らな picks の数(0)で案内し、いつも1つ目の穴を求めていた。
      const shown = prompt(popover().markup);
      expect(shown.indexOf(true)).toBe(index);
      expect(useAppStore.getState().pickNestedBoltedJointTarget(selected)).toBe(true);
    });
    const ready = useAppStore.getState().assemblyNestedBoltPreview;
    if (ready?.kind !== 'plan' || !ready.result.ok) throw new Error(JSON.stringify(ready));
    expect([ready.result.plan.nominal, ready.result.plan.boltLength, ready.result.plan.gripLength]).toEqual(['M8', 30, 20]);
    expect(useAppStore.getState().assembly).toBe(f.opened);
    const preventDefault = vi.fn();
    popover().submit({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    const after = useAppStore.getState().assembly;
    if (after === null || after === f.opened) throw new Error('commit did not change the assembly');
    const added = after.components.filter((component) => !f.opened.components.some((old) => old.id === component.id));
    expect(added.map((component) => component.placement.position.map((entry) => entry.value))).toEqual([[20, 10, -10], [20, 10, 10]]);
    expect(after.jointOccurrenceConnections).toEqual([{ kind: 'bolt', firstPath: f.first, secondPath: f.second,
      componentIds: added.map((component) => component.id) }]);
    expect(after.components.slice(0, 2).map((component) => component.placement)).toEqual(f.opened.components.map((component) => component.placement));
    expect(useAppStore.getState().assemblyNestedBoltDraft).toBeNull();
    expect(JSON.stringify([f.opened, f.child, f.part])).toBe(before);
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.opened);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(after);
  });

  it('refuses a stale view at confirm without changing the document or history, and explains it', async () => {
    const f = await openFixture();
    expect(useAppStore.getState().beginBoltedJoint()).toBe(true);
    useAppStore.getState().updateBoltedJointDraft({ dimensionSeries: 'annexJA', nominal: 'M8',
      engagementSource: '12', bottomClearanceSource: '2', protrusionSource: '2' });
    for (const selected of f.picks) expect(useAppStore.getState().pickNestedBoltedJointTarget(selected)).toBe(true);
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('view');
    // 表示の元を別の部品の版にする(取り込みの版の変化)。確定は文書を変えずに断る。
    const changed = { ...f.library, partFiles: f.library.partFiles.map((file) => ({ ...file, attachmentsDigest: 'changed' })) };
    useAppStore.setState({ assemblyView: { ...view, source: jointOccurrenceInputsOf(f.opened, changed) } });
    popover().submit({ preventDefault: vi.fn() });
    expect(useAppStore.getState().assembly).toBe(f.opened);
    expect(useAppStore.getState().assembly?.jointOccurrenceConnections).toBeUndefined();
    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(f.opened);
  });
});
