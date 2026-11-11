import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, appendReference, type AssemblyComponent, type AssemblyDocument, type ContextReferenceLink,
  createAssemblyDocument, createComponentFor, createEmptyPartDocument, embedPart, findReference, IDENTITY_PLACEMENT,
  type PartLibrary, type Placement, type ReferencePointFeature, type SolidBody, type SubShapeRef,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AssemblyView } from '../store/assemblySlice.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { runContextReferenceCommit } from './contextReferenceCommand.js';

const POINT: ReferencePointFeature = { id: 'point-1', name: '点1', visible: true, kind: 'referencePoint',
  definition: { kind: 'coordinate', at: { mode: 'absolute', x: expressionValueFromNumber(0),
    y: expressionValueFromNumber(0), z: expressionValueFromNumber(0) } } };
const FACE: SubShapeRef = { bodyFeatureId: 'extrude-1', index: 3, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
  area: 10, position: [5, 0, 0], axis: [0, 0, 1], radius: 2 } };

/** Bの今のボディ。面3(円筒)の中心が部品の座標で (5,0,0)。 */
function baseBody(): SolidBody {
  const face = (index: number, surfaceKind: 'plane' | 'cylinder', centroid: readonly [number, number, number]) => ({
    index, surfaceKind, area: 10, centroid, axis: [0, 0, 1] as const, radius: surfaceKind === 'cylinder' ? 2 : null,
    triangleOffset: 0, triangleCount: 0 });
  return { featureId: 'extrude-1', mesh: { positions: new Float32Array([0, 0, 0, 10, 10, 10]), normals: new Float32Array(),
    indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
  volume: 1, isValid: true, edges: [], vertices: [], threadMarks: [],
  faces: [face(0, 'plane', [5, 5, 0]), face(1, 'plane', [5, 5, 10]), face(2, 'plane', [0, 5, 5]), face(3, 'cylinder', [5, 0, 0])] };
}

function placement(x: number, y: number): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(0)],
    rotation: [0, 0, 0, 1] };
}

function viewOf(document: AssemblyDocument, a: AssemblyComponent, b: AssemblyComponent): AssemblyView {
  return { sourceDocument: document,
    resolved: { parts: new Map(), errors: [], placements: new Map([[a.id, IDENTITY_PLACEMENT], [b.id, IDENTITY_PLACEMENT]]),
      partKeys: new Map([[a.id, 'a'], [b.id, 'b']]) },
    bodies: new Map([['b', [baseBody()]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
}

async function openScene() {
  const empty: PartLibrary = { partFiles: [], parts: new Map(), attachments: new Map() };
  const bracket = await embedPart(empty, appendReference(createEmptyPartDocument(), POINT), 'a.pcad', 'a.pcad');
  const base = await embedPart(bracket.library, createEmptyPartDocument(), 'b.pcad', 'b.pcad');
  let document: AssemblyDocument = createAssemblyDocument('確定');
  const a: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: bracket.partRef }), placement: placement(10, 20) };
  document = addComponent(document, a);
  const b: AssemblyComponent = { ...createComponentFor(document, { kind: 'part', partRef: base.partRef }), placement: placement(0, 50) };
  document = addComponent(document, b);
  useAppStore.getState().openAssembly(document, base.library);
  useAppStore.setState({ isComputing: false, assemblyView: viewOf(document, a, b) });
  const link: ContextReferenceLink = { id: 'context-1', targetComponentId: a.id, targetReferenceId: 'point-1',
    sourceComponentId: b.id, source: FACE };
  return { document, link, bracketRef: bracket.partRef };
}

function pointOf(library: PartLibrary, partRef: string): readonly number[] {
  const part = library.parts.get(partRef);
  const feature = part === undefined ? undefined : findReference(part, 'point-1');
  if (feature?.kind !== 'referencePoint' || feature.definition.kind !== 'coordinate' || feature.definition.at.mode !== 'absolute') {
    throw new Error('point');
  }
  return [feature.definition.at.x.value, feature.definition.at.y.value, feature.definition.at.z.value];
}

beforeEach(() => { resetTestStore(); });

describe('組立の文脈の参照の確定(UI・本物のストア)', () => {
  it('今の表示のボディの面の中心から点を書き、1段の Undo で元に戻る', async () => {
    const s = await openScene();
    expect(await runContextReferenceCommit(useAppStore.getState, s.link)).toEqual({ status: 'committed' });
    const state = useAppStore.getState();
    expect(state.assembly?.contextReferences).toEqual([s.link]);
    pointOf(state.assemblyLibrary, s.bracketRef).forEach((value, index) =>
      expect(Math.abs(value - [-5, 30, 0][index])).toBeLessThanOrEqual(1e-9));
    state.undoAssembly();
    expect(useAppStore.getState().assembly?.contextReferences).toBeUndefined();
    expect(pointOf(useAppStore.getState().assemblyLibrary, s.bracketRef)).toEqual([0, 0, 0]);
  });

  it('待つ間に Undo して戻した(組立と一式は同じ物でも履歴が別)なら書かない', async () => {
    const s = await openScene();
    const pending = runContextReferenceCommit(useAppStore.getState, s.link);
    const state = useAppStore.getState();
    state.applyAssembly({ ...s.document, name: '別の操作' }, state.assemblyLibrary);
    useAppStore.getState().undoAssembly();
    expect(await pending).toEqual({ status: 'stale' });
    expect(useAppStore.getState().assembly?.contextReferences).toBeUndefined();
  });

  it('待つ間に表示の形が作り直されたら書かない', async () => {
    const s = await openScene();
    const pending = runContextReferenceCommit(useAppStore.getState, s.link);
    const view = useAppStore.getState().assemblyView;
    if (view === null) throw new Error('view');
    useAppStore.setState({ assemblyView: { ...view, bodies: new Map(view.bodies) } });
    expect(await pending).toEqual({ status: 'stale' });
    expect(useAppStore.getState().assembly?.contextReferences).toBeUndefined();
  });

  it('形の計算中や、表示の形が今の組立のものでない時は始めない', async () => {
    const s = await openScene();
    useAppStore.setState({ isComputing: true });
    expect(await runContextReferenceCommit(useAppStore.getState, s.link)).toEqual({ status: 'notReady' });
    useAppStore.setState({ isComputing: false, assembly: { ...s.document, name: '変更後' } });
    expect(await runContextReferenceCommit(useAppStore.getState, s.link)).toEqual({ status: 'notReady' });
  });

  it('断った時は何も書かず、理由を返す', async () => {
    const s = await openScene();
    expect(await runContextReferenceCommit(useAppStore.getState, { ...s.link, sourceComponentId: 'component-99' }))
      .toEqual({ status: 'rejected', rejection: { code: 'sourceComponentMissing', linkId: 'context-1' } });
    expect(useAppStore.getState().assembly?.contextReferences).toBeUndefined();
  });
});

it('共通の文書判定で添付だけの変更も失効させ、組立と履歴を保持する', async () => {
  const scene = await openScene();
  const before = useAppStore.getState();
  const pending = runContextReferenceCommit(useAppStore.getState, scene.link);
  before.addImportedAttachments(new Map([['late-shape', Uint8Array.of(1)]]), new Map());
  const changed = useAppStore.getState();
  expect(await pending).toEqual({ status: 'stale' });
  const after = useAppStore.getState();
  expect(after.assembly).toBe(before.assembly);
  expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
  expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
  expect(after.importedShapes).toBe(changed.importedShapes);
});

it('後発の参照確定だけを採用し、履歴は1段だけ増やす', async () => {
  const scene = await openScene();
  const before = useAppStore.getState();
  const first = runContextReferenceCommit(useAppStore.getState, scene.link);
  const second = runContextReferenceCommit(useAppStore.getState, scene.link);
  expect(await first).toEqual({ status: 'stale' });
  expect(await second).toEqual({ status: 'committed' });
  expect(useAppStore.getState().assemblyUndoStack?.past.length)
    .toBe((before.assemblyUndoStack?.past.length ?? 0) + 1);
  expect(useAppStore.getState().assembly?.contextReferences).toEqual([scene.link]);
});
