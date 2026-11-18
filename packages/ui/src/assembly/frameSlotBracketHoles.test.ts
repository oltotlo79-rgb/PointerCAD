/**
 * 選んだブラケットの全部の穴への締結(J-02 P7)の検査: ボディの面の表から、穴(穴の壁の由来を持つ内側の円筒面。縫い目で分かれた
 * 同じ穴は 1 つ)と、合わせ面の候補(軸に直交し、穴の壁と辺を共有する平面)を作る事。外側の円筒・由来の無い円筒は穴にしない事。
 * 選んでいない部品・知らない部品は数えない事。形は表示済みの面の表(model/kernel の別の試験で形から表までを確かめる)。
 */
import {
  addComponent, createAssemblyDocument, createComponentFor, EMPTY_PART_LIBRARY, partKeyOf, resolveAssembly, type AssemblyDocument,
  type OriginBinding, type SolidBody, type SolidEdgeEntry,
  type SolidFaceEntry,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { AssemblyView } from '../store/assemblySlice.js';
import { previewBracketSlotFastening } from './frameSlotBracketHoles.js';
import { createFrameSlotDraft } from './frameSlotFasteningDraft.js';

/** 穴の壁の由来(穴のフィーチャー `featureId` の下穴の壁)。 */
function wall(featureId: string, index: number): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: {
    kind: 'hole-face', featureId, center: { sketchId: 'centers', producer: { kind: 'point', featureId: `${featureId}-center` } },
    placement: { kind: 'original' }, stage: 'bore', role: 'wall',
  } } };
}

/** 断面の輪の穴(円弧の曲線)を押し出した側の面の由来(資料のブラケットの族の穴の面)。 */
function profileSide(index: number, curveFeatureId: string): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: {
    kind: 'extrude-curve-side', featureId: 'extrude-1', profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1', curveFeatureId,
      role: 'whole-curve' } } } };
}

/** 板の面の由来(上・下の面)。 */
function boxFace(index: number, role: 'top' | 'bottom' | 'right'): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face',
    featureId: 'plate', role } } };
}

/** 軸 +Z の円筒(厚さ 6 の板を z = 0〜6 で貫く。`adjacent` は辺を共有する面、`partial` は帯の範囲の無い部分の円筒〔隅の丸み〕)。 */
function cylinder(index: number, x: number,
  options: { readonly exterior?: boolean; readonly adjacent?: readonly number[]; readonly partial?: boolean } = {}): SolidFaceEntry {
  return { index, surfaceKind: 'cylinder', area: 2 * Math.PI * 3 * 6, centroid: [x, 0, 3], axis: [0, 0, 1], axisOrigin: [x, 0, 3],
    cylinderSpan: options.partial === true ? null : [-3, 3], cylinderExterior: options.exterior ?? false, radius: 3, triangleOffset: 0,
    triangleCount: 0, ...(options.adjacent === undefined ? {} : { adjacentFaces: options.adjacent }) };
}

function plane(index: number, z: number, normalZ: number): SolidFaceEntry {
  return { index, surfaceKind: 'plane', area: 1000, centroid: [0, 0, z], axis: [0, 0, normalZ], radius: null, triangleOffset: 0,
    triangleCount: 0 };
}

/** 板のボディ: 上の面 0(z = 6)・下の面 1(z = 0)、側の面 7(法線 +X)と、渡した円筒。 */
function plateBody(cylinders: readonly SolidFaceEntry[], bindings: readonly OriginBinding[], edges: readonly SolidEdgeEntry[] = []): SolidBody {
  const side: SolidFaceEntry = { index: 7, surfaceKind: 'plane', area: 100, centroid: [50, 0, 3], axis: [1, 0, 0], radius: null,
    triangleOffset: 0, triangleCount: 0 };
  return { featureId: 'plate-body', bodyKind: 'solid', volume: 1000, isValid: true, faces: [plane(0, 6, 1), plane(1, 0, -1), side, ...cylinders],
    edges: [...edges], vertices: [], threadMarks: [], mesh: { positions: new Float32Array(0), normals: new Float32Array(0),
      indices: new Uint32Array(0), edgePositions: new Float32Array(0), triangleCount: 0 },
    origins: { version: 1, state: 'tracked', bindings: [boxFace(0, 'top'), boxFace(1, 'bottom'), boxFace(7, 'right'), ...bindings] } };
}

function viewWith(body: SolidBody): { readonly view: AssemblyView; readonly document: ReturnType<typeof createAssemblyDocument> } {
  let document = createAssemblyDocument('ブラケット');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'bracket' }));
  const key = partKeyOf({ kind: 'part', partRef: 'bracket' });
  const view: AssemblyView = { sourceDocument: document, resolved: { ...resolveAssembly(document), partKeys: new Map([['component-1', key]]) },
    bodies: new Map([[key, [body]]]), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
  return { view, document };
}

/** 選んだブラケットの穴ごとに選んだ組(ナットの表を読み込む前なので、穴ごとの候補の初めの組)の [穴の面, 合わせ面]。 */
function chosen(document: AssemblyDocument, view: AssemblyView, bracketIds: readonly string[]): readonly (readonly [number, number])[] {
  return previewBracketSlotFastening(document, view, EMPTY_PART_LIBRARY, createFrameSlotDraft('doc', bracketIds), null).pairs
    .map((pair): readonly [number, number] => [pair.hole.ref.index, pair.face.ref.index]);
}

describe('選んだブラケットの穴', () => {
  it('穴ごとに 1 組(合わせ面は穴の面と辺を共有する上・下の面の候補から選ぶ)', () => {
    const { view, document } = viewWith(plateBody([cylinder(3, 10, { adjacent: [0, 1] }), cylinder(4, 40, { adjacent: [0, 1] })],
      [wall('hole-a', 3), wall('hole-b', 4)]));
    expect(chosen(document, view, ['component-1'])).toEqual([[3, 0], [4, 0]]);
  });

  it('縫い目で分かれた同じ穴は 1 つにし、外側の円筒・帯の範囲の無い部分の円筒は穴にしない(輪の穴の全周の円筒は穴にする)', () => {
    const { view, document } = viewWith(plateBody([cylinder(3, 10, { adjacent: [0, 1] }), cylinder(4, 10, { adjacent: [0, 1] }),
      cylinder(5, 70, { exterior: true }), cylinder(6, 90, { partial: true }), cylinder(8, 30, { adjacent: [0, 1] })],
    [wall('hole-a', 3), wall('hole-a-split', 4), wall('boss', 5), profileSide(6, 'arc-corner'), profileSide(8, 'circle-hole')]));
    expect(chosen(document, view, ['component-1'])).toEqual([[3, 0], [8, 0]]);
  });

  it('選んでいない部品・知らない部品は数えず、穴が 1 つも無い時は「穴を選ぶ」の理由を返す', () => {
    const { view, document } = viewWith(plateBody([cylinder(3, 10)], [wall('hole-a', 3)]));
    expect(chosen(document, view, ['component-1'])).toEqual([[3, 0]]);
    const unknown = previewBracketSlotFastening(document, view, EMPTY_PART_LIBRARY, createFrameSlotDraft('doc', ['component-9']), null);
    expect(unknown).toEqual({ preview: { kind: 'issue', issue: 'needPicks' }, pairs: [] });
  });

  it('半円 2 面で全周を閉じる輪の穴(資料のブラケットの穴)は、1 つの穴にする', () => {
    const { view, document } = viewWith(plateBody(ringHalves(), [profileSide(9, 'circle-a'), profileSide(10, 'circle-b')], ringArcs()));
    expect(chosen(document, view, ['component-1'])).toEqual([[9, 0]]);
  });

  it('起源の表の無いボディ(引き算で作った資料の平板。kernel の実測で untracked・unsupported-producer)も、クリックと同じ指紋の参照で穴と合わせ面を選ぶ', () => {
    const { view, document } = viewWith(untrackedPlate('unsupported-producer'));
    expect(chosen(document, view, ['component-1'])).toEqual([[9, 0]]);
  });

  it('クリックでも参照を作らないボディ(起源の上限を超えた形)は、穴を数えず「穴を選ぶ」の理由を返す', () => {
    const { view, document } = viewWith(untrackedPlate('limit'));
    expect(previewBracketSlotFastening(document, view, EMPTY_PART_LIBRARY, createFrameSlotDraft('doc', ['component-1']), null))
      .toEqual({ preview: { kind: 'issue', issue: 'needPicks' }, pairs: [] });
  });
});

/** 軸 +Z・x = 60 の半円 2 面(面 9・10)で全周を閉じる輪の穴(帯の範囲だけを持ち、全周の帯は持たない。縁の円弧は辺 100〜103)。 */
function ringHalves(): readonly SolidFaceEntry[] {
  const half = (index: number, other: number, part: number): SolidFaceEntry => ({ ...cylinder(index, 60, { partial: true,
    adjacent: [other, 0, 1] }), area: Math.PI * 3 * 6, cylinderAxialExtent: [-3, 3], boundaryEdgeIndices: [100 + 2 * part, 101 + 2 * part] });
  return [half(9, 10, 0), half(10, 9, 1)];
}

/** 輪の穴の縁の円弧(半円 2 面それぞれの、z = 0 と z = 6 の半周)。 */
function ringArcs(): readonly SolidEdgeEntry[] {
  return [0, 1].flatMap((part) => [0, 6].map((z, end): SolidEdgeEntry => ({ index: 100 + 2 * part + end, curveKind: 'circle',
    length: Math.PI * 3, midpoint: [63, 0, z], start: [63, 0, z], end: [57, 0, z], axis: [0, 0, 1], axisOrigin: [60, 0, z], radius: 3,
    segmentOffset: 0, segmentCount: 0 })));
}

/** 輪の穴の板で、起源の表が untracked のボディ(由来の参照は作れない)。 */
function untrackedPlate(reason: 'unsupported-producer' | 'limit'): SolidBody {
  return { ...plateBody(ringHalves(), [], ringArcs()), origins: { version: 1, state: 'untracked', reason } };
}
