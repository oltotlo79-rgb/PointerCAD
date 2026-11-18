/**
 * フレームの溝への締結の打ちかけ(J-02 P6b)の純関数の検査: 穴の面を選び(Shift で足し外し、Shift の無い時は選び直し)、
 * 部分形状でない選択・P7 の時は受けない事。穴の面ごとの合わせ面の候補は、穴の軸に直交し穴の面と辺を共有する平面だけである事。
 * 予告は、表示が古い・ナットの表を読み込み中・穴が無い時に理由を返し、確定を押せない事。
 */
import {
  addComponent, createAssemblyDocument, createComponentFor, EMPTY_PART_LIBRARY, partKeyOf, resolveAssembly, type AssemblyDocument,
  type MateTarget, type OriginBinding, type SolidBody, type SolidFaceEntry,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { AssemblyView } from '../store/assemblySlice.js';
import {
  appendFrameSlotPick, createFrameSlotDraft, faceTargetOf, frameSlotPreviewReady, matingFaceEntries, previewFrameSlotDraft,
  type AssemblyFrameSlotDraft,
} from './frameSlotFasteningDraft.js';

function binding(index: number, role: 'top' | 'bottom' | 'right'): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face',
    featureId: 'plate', role } } };
}

function wall(index: number): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: {
    kind: 'hole-face', featureId: 'hole-a', center: { sketchId: 'centers', producer: { kind: 'point', featureId: 'hole-a-center' } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall' } } };
}

function face(index: number, entry: Partial<SolidFaceEntry> & Pick<SolidFaceEntry, 'surfaceKind' | 'axis'>): SolidFaceEntry {
  return { index, area: 100, centroid: [0, 0, 0], radius: null, triangleOffset: 0, triangleCount: 0, ...entry };
}

/** 板(z = 0〜6): 上の面 0・下の面 1・側の面 2、穴の壁 3(上下と辺を共有)。 */
function plate(): SolidBody {
  return { featureId: 'plate-body', bodyKind: 'solid', volume: 1000, isValid: true, faces: [
    face(0, { surfaceKind: 'plane', axis: [0, 0, 1], centroid: [0, 0, 6] }), face(1, { surfaceKind: 'plane', axis: [0, 0, -1] }),
    face(2, { surfaceKind: 'plane', axis: [1, 0, 0], centroid: [20, 0, 3] }),
    face(3, { surfaceKind: 'cylinder', axis: [0, 0, 1], axisOrigin: [5, 0, 3], cylinderSpan: [-3, 3], cylinderExterior: false, radius: 3,
      adjacentFaces: [0, 1] }),
  ], edges: [], vertices: [], threadMarks: [], mesh: { positions: new Float32Array(0), normals: new Float32Array(0),
    indices: new Uint32Array(0), edgePositions: new Float32Array(0), triangleCount: 0 },
  origins: { version: 1, state: 'tracked', bindings: [binding(0, 'top'), binding(1, 'bottom'), binding(2, 'right'), wall(3)] } };
}

function setup(): { readonly document: AssemblyDocument; readonly view: AssemblyView; readonly body: SolidBody } {
  let document = createAssemblyDocument('締結');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'bracket' }));
  const key = partKeyOf({ kind: 'part', partRef: 'bracket' });
  const body = plate();
  return { document, body, view: { sourceDocument: document, resolved: { ...resolveAssembly(document), partKeys: new Map([['component-1', key]]) },
    bodies: new Map([[key, [body]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() } };
}

function target(body: SolidBody, index: number): MateTarget {
  const entry = body.faces.at(index);
  const found = entry === undefined ? null : faceTargetOf('component-1', body, entry);
  if (found === null) throw new Error(`face ${String(index)}`);
  return found;
}

describe('フレームの溝への締結の選び方', () => {
  it('Shift の時は穴の面を足し外しし、Shift の無い時はその穴だけに選び直す', () => {
    const { body } = setup();
    const two = [target(body, 3), target(body, 2)].reduce<AssemblyFrameSlotDraft>((draft, next) =>
      appendFrameSlotPick(draft, next, true) ?? draft, createFrameSlotDraft('doc'));
    expect(two.holes.map((hole) => hole.ref.index)).toEqual([3, 2]);
    expect(appendFrameSlotPick(two, target(body, 2), true)?.holes.map((hole) => hole.ref.index)).toEqual([3]);
    expect(appendFrameSlotPick(two, target(body, 3), false)?.holes.map((hole) => hole.ref.index)).toEqual([3]);
  });

  it('部分形状でない選択・P7 の時は受けない', () => {
    const { body } = setup();
    expect(appendFrameSlotPick(createFrameSlotDraft('doc'), { kind: 'origin', componentId: 'component-1', element: 'xy' }, false)).toBeNull();
    expect(appendFrameSlotPick(createFrameSlotDraft('doc', ['component-1']), target(body, 3), false)).toBeNull();
  });

  it('合わせ面の候補は、穴の軸に直交し穴の面と辺を共有する平面(上・下)だけ。辺の共有が分からない形は直交する平面の全部', () => {
    const { body } = setup();
    const wallFace = body.faces.at(3);
    if (wallFace === undefined) throw new Error('wall');
    expect(matingFaceEntries(body, wallFace).map((entry) => entry.index)).toEqual([0, 1]);
    const withoutAdjacency = face(3, { surfaceKind: 'cylinder', axis: [0, 0, 1], axisOrigin: [5, 0, 3], cylinderSpan: [-3, 3], radius: 3 });
    expect(matingFaceEntries(body, withoutAdjacency).map((entry) => entry.index)).toEqual([0, 1]);
    expect(matingFaceEntries(body, { ...wallFace, adjacentFaces: [1] }).map((entry) => entry.index)).toEqual([1]);
  });
});

describe('フレームの溝への締結の予告(理由)', () => {
  it('表示が古い時・ナットの表を読み込み中の時は理由を返し、確定を押せない', () => {
    const { document, view, body } = setup();
    const hole = target(body, 3);
    const draft = appendFrameSlotPick(createFrameSlotDraft('doc'), hole, false) ?? createFrameSlotDraft('doc');
    const stale = previewFrameSlotDraft(createAssemblyDocument('別'), view, EMPTY_PART_LIBRARY, draft, null).preview;
    expect(stale).toEqual({ kind: 'issue', issue: 'stale' });
    const loading = previewFrameSlotDraft(document, view, EMPTY_PART_LIBRARY, draft, null).preview;
    expect(loading).toEqual({ kind: 'issue', issue: 'loading' });
    expect([frameSlotPreviewReady(stale), frameSlotPreviewReady(loading), frameSlotPreviewReady(null)]).toEqual([false, false, false]);
  });
});
