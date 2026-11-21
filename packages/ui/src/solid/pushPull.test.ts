/**
 * 押し引き(M-05 4-1a・4-1b)の振り分け(`pushPull.ts`)と、押せる条件が振り分け先の道具と同じである事。
 * 手で組んだ部分形状のボディは `shapeEditCommands.test.ts` と同じひな型。穴の壁の出どころは
 * `assembly/boltedJointDraft.test.ts` の `wall` と同じ形(計算部から出どころの表までの道は model・kernel の別の検査)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  DEFAULT_FACE_COLOR,
  replaceSketch,
  type HoleFeature,
  type OriginBinding,
  type PartDocument,
  type SketchDocument,
  type SketchFeature,
  type ThreadHoleFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { pushPullTarget } from './pushPull.js';
import { solidToolReadiness } from './solidCommands.js';
import { subShapeElementId, type SolidEdgeEntry, type SolidFaceEntry, type SubShapeBody } from './subShapeSelection.js';

function addFace(sketch: SketchDocument, id: string): SketchDocument {
  return appendFeature(sketch, { id, name: id, planeId: 'xy', kind: 'face', boundary: [], color: DEFAULT_FACE_COLOR });
}

function addLine(sketch: SketchDocument, id: string): SketchDocument {
  return appendFeature(sketch, {
    id, name: id, planeId: 'xy', kind: 'line', from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0), construction: false,
  });
}

function faceEntry(index: number, surfaceKind: SolidFaceEntry['surfaceKind'] = 'plane'): SolidFaceEntry {
  return { index, surfaceKind, area: 100, centroid: [0, 0, index], axis: [0, 0, 1], radius: surfaceKind === 'cylinder' ? 5 : null,
    triangleOffset: index * 2, triangleCount: 2 };
}

function edgeEntry(index: number): SolidEdgeEntry {
  return { index, curveKind: 'line', length: 10, midpoint: [5, 0, index], start: [0, 0, index], end: [10, 0, index], axis: [1, 0, 0],
    radius: null, segmentOffset: index, segmentCount: 1 };
}

/** 作図の面 2 枚・線分 1 本と、押し出し 1 つ(ボディ `extrude-1`。平らな面 2 枚・円柱の面 1 枚・辺 2 本)。 */
function fixture(): { readonly document: PartDocument; readonly bodies: readonly SubShapeBody[] } {
  const base = createEmptyPartDocument();
  const sketch = addLine(addFace(addFace(base.sketches[0], 'face-1'), 'face-2'), 'line-1');
  const document = appendSolid(replaceSketch(base, sketch), {
    id: 'extrude-1', name: 'extrude-1', suppressed: false, kind: 'extrude',
    profile: { sketchId: base.activeSketchId, faceFeatureId: 'face-1' },
    distance: expressionValueFromNumber(10), reversed: false, symmetric: false,
  });
  const body: SubShapeBody = { featureId: 'extrude-1', mesh: { edgePositions: new Float32Array(12) },
    faces: [faceEntry(0), faceEntry(1), faceEntry(2, 'cylinder')], edges: [edgeEntry(0), edgeEntry(1)], vertices: [] };
  return { document, bodies: [body] };
}

const FACE_0 = subShapeElementId('extrude-1', 'face', 0);
const FACE_1 = subShapeElementId('extrude-1', 'face', 1);
const CYLINDER_FACE = subShapeElementId('extrude-1', 'face', 2);
const EDGE_0 = subShapeElementId('extrude-1', 'edge', 0);
const EDGE_1 = subShapeElementId('extrude-1', 'edge', 1);
const VERTEX_0 = subShapeElementId('extrude-1', 'vertex', 0);

describe('押し引きは、選んだ物の種類だけで道具を 1 つ選ぶ(M-05 4-1a)', () => {
  it.each([
    [['face-1'], 'extrude'],
    [['face-1', 'face-2'], 'extrude'],
    [[FACE_0], 'faceOffset'],
    [[FACE_0, CYLINDER_FACE], 'faceOffset'],
    [[EDGE_0], 'fillet'],
    [[EDGE_0, EDGE_1], 'fillet'],
  ] as const)('%j は %s へ振り分ける', (selection, tool) => {
    const { document, bodies } = fixture();
    expect(pushPullTarget(document, selection, bodies)).toEqual({ kind: 'tool', tool });
  });

  it.each([
    [[]],
    [['line-1']],
    [['extrude-1']],
    [[VERTEX_0]],
    [['face-1', FACE_0]],
    [[FACE_0, EDGE_0]],
    [['missing-1']],
  ] as const)('%j は振り分けずに理由を返す', (selection) => {
    expect(pushPullTarget(fixture().document, selection)).toEqual({ kind: 'refused', reasonKey: 'solidError.pushPullUnsupported' });
  });

  it('何も選んでいなくても、押せる閉じた領域があれば押し出しへ振り分ける(M-01 と同じ条件)', () => {
    const base = createEmptyPartDocument();
    const rectangle: SketchFeature = { id: 'rectangle-1', name: 'rectangle-1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(60, 40, 0), construction: false };
    const document = replaceSketch(base, appendFeature(base.sketches[0], rectangle));
    expect(pushPullTarget(document, [])).toEqual({ kind: 'tool', tool: 'extrude' });
    expect(solidToolReadiness(document, [], 'pushPull')).toEqual(solidToolReadiness(document, [], 'extrude'));
  });

  it('押せる条件は、振り分け先の道具の条件と同じ(平らでない面・面 2 枚は面の移動の理由で断る)', () => {
    const { document, bodies } = fixture();
    for (const selection of [['face-1'], [FACE_0], [CYLINDER_FACE], [FACE_0, FACE_1], [EDGE_0], [EDGE_0, EDGE_1]]) {
      const target = pushPullTarget(document, selection, bodies);
      if (target.kind !== 'tool') throw new Error(`道具へ振り分けられない: ${selection.join(',')}`);
      expect(solidToolReadiness(document, selection, 'pushPull', bodies), selection.join(','))
        .toEqual(solidToolReadiness(document, selection, target.tool, bodies));
    }
    expect(solidToolReadiness(document, [VERTEX_0], 'pushPull', bodies))
      .toEqual({ ready: false, reasonKey: 'solidError.pushPullUnsupported' });
  });
});

/** 計算部が名付けた穴の面(既定は下穴の壁)。 */
function holeFace(featureId: string, index: number, stage: 'bore' | 'counterbore' = 'bore'): OriginBinding {
  return { state: 'unique', current: { kind: 'face', index }, origin: { version: 1, shapeKind: 'face', identity: {
    kind: 'hole-face', featureId, center: { sketchId: 'centers', producer: { kind: 'point', featureId: `${featureId}-center` } },
    placement: { kind: 'original' }, stage, role: 'wall',
  } } };
}

const value = expressionValueFromNumber;
const HOLE: HoleFeature = {
  id: 'hole-1', name: 'hole-1', kind: 'hole', suppressed: false, targetFeatureId: 'extrude-1',
  face: { bodyFeatureId: 'extrude-1', index: 1, fingerprint: { kind: 'face', surfaceKind: 'plane',
    area: 100, position: [0, 0, 1], axis: [0, 0, 1], radius: null } },
  centers: [{ sketchId: 'centers', pointFeatureId: 'hole-1-center' }], diameter: value(6), depth: { kind: 'through' },
  tiltAngle: value(0), tiltAzimuth: value(0),
};
const THREAD: ThreadHoleFeature = {
  ...HOLE, id: 'thread-1', name: 'thread-1', kind: 'threadHole', designation: 'M6', series: 'coarse',
  pitch: value(1), drillDiameter: value(5), threadLength: value(10), representation: 'simplified',
};

/** 穴と、そのボディ(円柱の面 2 が穴の壁)。`bindings` で面の出どころを差し替える。 */
function holeBody(featureId: string, bindings: readonly OriginBinding[] | null): SubShapeBody {
  const body: SubShapeBody = { featureId, mesh: { edgePositions: new Float32Array(12) },
    faces: [faceEntry(0), faceEntry(1), faceEntry(2, 'cylinder')], edges: [edgeEntry(0)], vertices: [] };
  return bindings === null ? body : { ...body, origins: { version: 1, state: 'tracked', bindings } };
}

describe('押し引きで穴の壁の面を押すと、その穴の径の欄へ移す(M-05 4-1b)', () => {
  const document = [HOLE, THREAD].reduce<PartDocument>(appendSolid, fixture().document);
  const HOLE_WALL = subShapeElementId('hole-1', 'face', 2);
  const THREAD_WALL = subShapeElementId('thread-1', 'face', 2);

  it.each([
    [HOLE_WALL, 'hole-1', 'diameter'],
    [THREAD_WALL, 'thread-1', 'drillDiameter'],
  ] as const)('%s は %s の %s の欄', (face, featureId, fieldKey) => {
    const bodies = [holeBody('hole-1', [holeFace('hole-1', 2)]), holeBody('thread-1', [holeFace('thread-1', 2)])];
    expect(pushPullTarget(document, [face], bodies)).toEqual({ kind: 'holeField', featureId, fieldKey });
    expect(solidToolReadiness(document, [face], 'pushPull', bodies)).toEqual({ ready: true, reasonKey: null });
  });

  it.each([
    ['出どころの無いボディ', [holeBody('hole-1', null)], [HOLE_WALL]],
    ['名付けの無い面', [holeBody('hole-1', [])], [HOLE_WALL]],
    ['2 つの出どころが同じ面を名乗る', [holeBody('hole-1', [holeFace('hole-1', 2), holeFace('thread-1', 2)])], [HOLE_WALL]],
    ['座ぐりの壁', [holeBody('hole-1', [holeFace('hole-1', 2, 'counterbore')])], [HOLE_WALL]],
    ['文書に無い穴を名乗る', [holeBody('hole-1', [holeFace('hole-9', 2)])], [HOLE_WALL]],
    ['穴の壁と別の面の 2 枚', [holeBody('hole-1', [holeFace('hole-1', 2)])], [HOLE_WALL, subShapeElementId('hole-1', 'face', 0)]],
    ['ボディの一覧を渡さない', [], [HOLE_WALL]],
  ] as const)('%s は、今までどおり面の移動', (_name, bodies, selection) => {
    expect(pushPullTarget(document, selection, bodies)).toEqual({ kind: 'tool', tool: 'faceOffset' });
  });
});
