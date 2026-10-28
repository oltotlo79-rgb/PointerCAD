import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createPointFeature,
  DEFAULT_WORK_PLANE_ID,
  createUndoStack,
  findSolid,
  pushUndo,
  redo,
  replaceSketch,
  undo,
  type ExtrudeFeature,
  type HoleFeature,
  type PartDocument,
  type SketchPointArrayFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import type { SolidInputCommit } from '../sketch/numericInput.js';

import {
  commitChamfer,
  commitFillet,
  commitHole,
  commitMachiningInput,
  commitPattern,
  commitThreadHole,
  DEFAULT_CHAMFER_DISTANCE,
  DEFAULT_CYLINDER_HOLE_ANGLE,
  DEFAULT_CYLINDER_HOLE_HEIGHT,
  DEFAULT_FILLET_RADIUS,
  DEFAULT_HOLE_DEPTH,
  DEFAULT_HOLE_DIAMETER,
  DEFAULT_TILT_ANGLE,
  DEFAULT_TILT_AZIMUTH,
  machiningTargetOf,
  machiningToolReadiness,
  type MachiningContext,
} from './machiningCommands.js';
import {
  subShapeElementId,
  type SolidEdgeEntry,
  type SolidFaceEntry,
  type SolidVertexEntry,
  type SubShapeBody,
} from './subShapeSelection.js';

const ZERO = expressionValueFromNumber(0);
const DIAMETER_6 = DEFAULT_HOLE_DIAMETER;
const DEPTH_10 = DEFAULT_HOLE_DEPTH;
const RADIUS_2 = DEFAULT_FILLET_RADIUS;
const DISTANCE_1 = DEFAULT_CHAMFER_DISTANCE;

/** 面 1 枚の素性を組み立てる(タスク20 の SolidFaceEntry、ボディは手で組む)。 */
function makeFace(index: number, overrides: Partial<SolidFaceEntry> = {}): SolidFaceEntry {
  return {
    index,
    surfaceKind: 'plane',
    area: 100,
    centroid: [0, 0, 0],
    axis: [0, 0, 1],
    radius: null,
    triangleOffset: 0,
    triangleCount: 2,
    ...overrides,
  };
}

/** 辺 1 本の素性を組み立てる。start / end は頂点展開の判定材料(isSamePoint)。 */
function makeEdge(
  index: number,
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  overrides: Partial<SolidEdgeEntry> = {},
): SolidEdgeEntry {
  const midpoint: readonly [number, number, number] = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2,
    (start[2] + end[2]) / 2,
  ];
  return {
    index,
    curveKind: 'line',
    length: Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]),
    midpoint,
    start,
    end,
    axis: null,
    radius: null,
    segmentOffset: index,
    segmentCount: 1,
    ...overrides,
  };
}

function makeVertex(index: number, position: readonly [number, number, number]): SolidVertexEntry {
  return { index, position };
}

function makeBody(
  featureId: string,
  fields: {
    readonly faces?: readonly SolidFaceEntry[];
    readonly edges?: readonly SolidEdgeEntry[];
    readonly vertices?: readonly SolidVertexEntry[];
  } = {},
): SubShapeBody {
  return {
    featureId,
    mesh: { edgePositions: new Float32Array(0) },
    faces: fields.faces ?? [],
    edges: fields.edges ?? [],
    vertices: fields.vertices ?? [],
  };
}

function extrudeFeature(id: string): ExtrudeFeature {
  return {
    id,
    name: `押し出し-${id}`,
    suppressed: false,
    kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' },
    distance: DEPTH_10,
    reversed: false,
    symmetric: false,
  };
}

/** 押し出しのボディを 0 個以上持つ部品文書を作る(加工の対象・パターンの対象と紐づく)。 */
function documentWithBodies(ids: readonly string[]): PartDocument {
  let document = createEmptyPartDocument();
  for (const id of ids) {
    document = appendSolid(document, extrudeFeature(id));
  }
  return document;
}

/** パターンの対象になる穴フィーチャーを 1 つ作る(commitPattern / machiningToolReadiness で共用)。 */
function holeFeature(id: string, targetFeatureId = 'extrude-1'): HoleFeature {
  return {
    id,
    name: '穴1',
    suppressed: false,
    kind: 'hole',
    targetFeatureId,
    face: {
      bodyFeatureId: targetFeatureId,
      index: 0,
      fingerprint: {
        kind: 'face',
        surfaceKind: 'plane',
        area: 100,
        position: [0, 0, 0],
        axis: [0, 0, 1],
        radius: null,
      },
    },
    centers: [],
    diameter: DIAMETER_6,
    depth: { kind: 'blind', depth: DEPTH_10 },
    tiltAngle: ZERO,
    tiltAzimuth: ZERO,
  };
}

/** スケッチへ点フィーチャーを 1 つ足す。実際に振られた id を返す(nextFeatureId 任せ)。 */
function withPoint(document: PartDocument): { readonly document: PartDocument; readonly pointId: string } {
  const sketch = document.sketches[0];
  const point = createPointFeature(sketch, absoluteCoordinate(0, 0, 0));
  return { document: replaceSketch(document, appendFeature(sketch, point)), pointId: point.id };
}

/** スケッチへ点列フィーチャーを 1 つ足す(FR-308)。展開は resolvePart の担当なのでここでは形だけ。 */
function withPointArray(
  document: PartDocument,
  id = 'pointArray-1',
): { readonly document: PartDocument; readonly pointArrayId: string } {
  const sketch = document.sketches[0];
  const feature: SketchPointArrayFeature = {
    id,
    name: `点列-${id}`,
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'pointArray',
    layout: {
      kind: 'linear',
      base: absoluteCoordinate(0, 0, 0),
      azimuth: ZERO,
      spacing: expressionValueFromNumber(5),
      count: expressionValueFromNumber(3),
    },
  };
  return {
    document: replaceSketch(document, appendFeature(sketch, feature)),
    pointArrayId: id,
  };
}

const HOLE_PARAMS = {
  diameter: DIAMETER_6,
  depth: { kind: 'blind' as const, depth: DEPTH_10 },
  tiltAngle: DEFAULT_TILT_ANGLE,
  tiltAzimuth: DEFAULT_TILT_AZIMUTH,
};

/** 加工した結果から作られたフィーチャーを取り出す。見つからなければテストを落とす。 */
function requireFeature(document: PartDocument, featureId: string) {
  const feature = findSolid(document, featureId);
  if (feature === undefined) {
    throw new Error(`フィーチャー ${featureId} が見つかりません(テストの前提が壊れています)`);
  }
  return feature;
}

describe('machiningTargetOf(§0.a-0.6)', () => {
  it('部分形状が 1 つの立体だけを指していればその立体', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)],
    };
    expect(machiningTargetOf(context)).toBe('extrude-1');
  });

  it('部分形状が 2 つの立体にまたがっていれば null', () => {
    const document = documentWithBodies(['extrude-1', 'extrude-2']);
    const context: MachiningContext = {
      document,
      bodies: [
        makeBody('extrude-1', { faces: [makeFace(0)] }),
        makeBody('extrude-2', { faces: [makeFace(0)] }),
      ],
      selection: [
        subShapeElementId('extrude-1', 'face', 0),
        subShapeElementId('extrude-2', 'face', 0),
      ],
    };
    expect(machiningTargetOf(context)).toBeNull();
  });

  it('部分形状が無く、立体が 1 つだけ選ばれていればその立体(パターンの対象決定と同じ道筋)', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = { document, bodies: [], selection: ['extrude-1'] };
    expect(machiningTargetOf(context)).toBe('extrude-1');
  });

  it('部分形状も立体の直接選択も無ければ null', () => {
    const document = documentWithBodies([]);
    const context: MachiningContext = { document, bodies: [], selection: [] };
    expect(machiningTargetOf(context)).toBeNull();
  });
});

describe('commitHole(FR-405)', () => {
  it('面 1 枚 + 点 1 つを選べば穴を 1 つ作る', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
    };
    const outcome = commitHole(context, HOLE_PARAMS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.document.solids.length).toBe(document.solids.length + 1);
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.name).toBe('穴1');
    expect(created.kind).toBe('hole');
    if (created.kind === 'hole') {
      expect(created.targetFeatureId).toBe('extrude-1');
    }
  });

  it('面を選ばなければ noFace で断り、文書は変わらない', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [pointId],
    };
    const outcome = commitHole(context, HOLE_PARAMS);
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.noFace' });
    expect(document.solids.length).toBe(1);
  });

  it('面は選んだが中心にする点が無ければ noCenterPoint', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)],
    };
    const outcome = commitHole(context, HOLE_PARAMS);
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.noCenterPoint' });
  });

  it('点列を選ぶと centers が 1 つ(点列フィーチャー 1 つぶん。展開は resolvePart が行う)', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointArrayId } = withPointArray(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointArrayId],
    };
    const outcome = commitHole(context, HOLE_PARAMS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.kind).toBe('hole');
    if (created.kind === 'hole') {
      expect(created.centers).toHaveLength(1);
    }
  });

  it('面が別の立体のもの(立体 2 つで面を 1 枚ずつ)なら faceNotOnTarget', () => {
    const base = documentWithBodies(['extrude-1', 'extrude-2']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [
        makeBody('extrude-1', { faces: [makeFace(0)] }),
        makeBody('extrude-2', { faces: [makeFace(0)] }),
      ],
      selection: [
        subShapeElementId('extrude-1', 'face', 0),
        subShapeElementId('extrude-2', 'face', 0),
        pointId,
      ],
    };
    const outcome = commitHole(context, HOLE_PARAMS);
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.faceNotOnTarget' });
  });

  it('穴を 2 回作ると 2 つ目は 穴2 で id が重ならない', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
    };
    const first = commitHole(context, HOLE_PARAMS);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = commitHole({ ...context, document: first.document }, HOLE_PARAMS);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.featureId).not.toBe(first.featureId);
    const created = requireFeature(second.document, second.featureId);
    expect(created.name).toBe('穴2');
  });

  it('元の document は呼び出しのたびに変わらない(不変)', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const snapshotLength = document.solids.length;
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
    };
    commitHole(context, HOLE_PARAMS);
    commitHole({ ...context, selection: [pointId] }, HOLE_PARAMS);
    expect(document.solids.length).toBe(snapshotLength);
  });
});

describe('commitThreadHole(FR-406)', () => {
  function threadContext(): { readonly context: MachiningContext } {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    return {
      context: {
        document,
        bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
        selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
      },
    };
  }

  const THREAD_HOLE_BASE_PARAMS = {
    depth: { kind: 'blind' as const, depth: DEPTH_10 },
    threadLength: DEPTH_10,
    representation: 'simplified' as const,
    tiltAngle: DEFAULT_TILT_ANGLE,
    tiltAzimuth: DEFAULT_TILT_AZIMUTH,
  };

  it('M8 並目のピッチと下穴径(D1)が規格から作られる', () => {
    const { context } = threadContext();
    const outcome = commitThreadHole(context, {
      ...THREAD_HOLE_BASE_PARAMS,
      designation: 'M8',
      series: 'coarse',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.kind).toBe('threadHole');
    if (created.kind === 'threadHole') {
      expect(created.pitch.value).toBe(1.25);
      expect(created.drillDiameter.value).toBeCloseTo(6.646835307, 9);
    }
  });

  it('M8 細目のピッチは 1', () => {
    const { context } = threadContext();
    const outcome = commitThreadHole(context, {
      ...THREAD_HOLE_BASE_PARAMS,
      designation: 'M8',
      series: 'fine',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.kind).toBe('threadHole');
    if (created.kind === 'threadHole') {
      expect(created.pitch.value).toBe(1);
    }
  });

  it('面が選ばれていなければ noFace', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [pointId],
    };
    const outcome = commitThreadHole(context, { ...THREAD_HOLE_BASE_PARAMS, designation: 'M6', series: 'coarse' });
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.noFace' });
  });
});

describe('commitFillet(FR-407、§0.a-0.17)', () => {
  it('辺 4 本を選べば targets が 4 本、名前が R面取り1', () => {
    const document = documentWithBodies(['extrude-1']);
    const edges = [
      makeEdge(0, [0, 0, 0], [10, 0, 0]),
      makeEdge(1, [10, 0, 0], [10, 10, 0]),
      makeEdge(2, [10, 10, 0], [0, 10, 0]),
      makeEdge(3, [0, 10, 0], [0, 0, 0]),
    ];
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { edges })],
      selection: edges.map((edge) => subShapeElementId('extrude-1', 'edge', edge.index)),
    };
    const outcome = commitFillet(context, { radius: RADIUS_2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.name).toBe('R面取り1');
    expect(created.kind).toBe('fillet');
    if (created.kind === 'fillet') {
      expect(created.targets).toHaveLength(4);
    }
  });

  it('辺(頂点)を選ばなければ noEdge', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1')],
      selection: [],
    };
    const outcome = commitFillet(context, { radius: RADIUS_2 });
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.noEdge' });
  });

  it(
    '頂点 1 つを選ぶと、確定時に「集まる辺」へ展開されて辺の参照として保存される' +
      '(§0.a-0.17 の追記。計画書タスク25の検証表 “targets[0].fingerprint.kind===vertex” は' +
      'この追記より前の記述であり、統括の決定(§0.a-0.17)を優先して実装したので満たさない。' +
      '判断として報告する)',
    () => {
      const document = documentWithBodies(['extrude-1']);
      // 頂点(0,0,0)に 2 本の辺が集まり、3 本目はその頂点に触れない。
      const edges = [
        makeEdge(0, [0, 0, 0], [10, 0, 0]),
        makeEdge(1, [0, 0, 0], [0, 10, 0]),
        makeEdge(2, [10, 10, 0], [10, 0, 0]),
      ];
      const vertices = [makeVertex(0, [0, 0, 0])];
      const context: MachiningContext = {
        document,
        bodies: [makeBody('extrude-1', { edges, vertices })],
        selection: [subShapeElementId('extrude-1', 'vertex', 0)],
      };
      const outcome = commitFillet(context, { radius: RADIUS_2 });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      const created = requireFeature(outcome.document, outcome.featureId);
      expect(created.kind).toBe('fillet');
      if (created.kind === 'fillet') {
        expect(created.targets).toHaveLength(2);
        expect(created.targets.every((target) => target.fingerprint.kind === 'edge')).toBe(true);
        expect(created.targets.map((target) => target.index)).toEqual([0, 1]);
      }
    },
  );

  it('直に選んだ辺と頂点展開の辺が重なっても重複を除く(先に出たほうを残す)', () => {
    const document = documentWithBodies(['extrude-1']);
    const edges = [makeEdge(0, [0, 0, 0], [10, 0, 0]), makeEdge(1, [0, 0, 0], [0, 10, 0])];
    const vertices = [makeVertex(0, [0, 0, 0])];
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { edges, vertices })],
      // 辺0 を直接選び、さらに頂点0(辺0と辺1が集まる)も選ぶ → 辺0 は 1 回だけ。
      selection: [
        subShapeElementId('extrude-1', 'edge', 0),
        subShapeElementId('extrude-1', 'vertex', 0),
      ],
    };
    const outcome = commitFillet(context, { radius: RADIUS_2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.kind).toBe('fillet');
    if (created.kind === 'fillet') {
      expect(created.targets).toHaveLength(2);
      expect(created.targets.map((target) => target.index)).toEqual([0, 1]);
    }
  });

  it('番号の大きい辺を先に選んでも targets は昇順に並ぶ', () => {
    const document = documentWithBodies(['extrude-1']);
    const edges = [
      makeEdge(0, [0, 0, 0], [10, 0, 0]),
      makeEdge(1, [10, 0, 0], [10, 10, 0]),
      makeEdge(2, [10, 10, 0], [0, 10, 0]),
    ];
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { edges })],
      selection: [
        subShapeElementId('extrude-1', 'edge', 2),
        subShapeElementId('extrude-1', 'edge', 0),
        subShapeElementId('extrude-1', 'edge', 1),
      ],
    };
    const outcome = commitFillet(context, { radius: RADIUS_2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.kind).toBe('fillet');
    if (created.kind === 'fillet') {
      expect(created.targets.map((target) => target.index)).toEqual([0, 1, 2]);
    }
  });

  it('選んだ辺が 2 つの立体にまたがっていれば noTargetBody', () => {
    const document = documentWithBodies(['extrude-1', 'extrude-2']);
    const context: MachiningContext = {
      document,
      bodies: [
        makeBody('extrude-1', { edges: [makeEdge(0, [0, 0, 0], [10, 0, 0])] }),
        makeBody('extrude-2', { edges: [makeEdge(0, [0, 0, 0], [10, 0, 0])] }),
      ],
      selection: [
        subShapeElementId('extrude-1', 'edge', 0),
        subShapeElementId('extrude-2', 'edge', 0),
      ],
    };
    const outcome = commitFillet(context, { radius: RADIUS_2 });
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.noTargetBody' });
  });
});

describe('commitChamfer(FR-408)', () => {
  it('辺 2 本を選んで等距離の C 面取りを作る', () => {
    const document = documentWithBodies(['extrude-1']);
    const edges = [makeEdge(0, [0, 0, 0], [10, 0, 0]), makeEdge(1, [10, 0, 0], [10, 10, 0])];
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { edges })],
      selection: edges.map((edge) => subShapeElementId('extrude-1', 'edge', edge.index)),
    };
    const outcome = commitChamfer(context, { size: { kind: 'equal', distance: DISTANCE_1 } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.name).toBe('C面取り1');
    expect(created.kind).toBe('chamfer');
    if (created.kind === 'chamfer') {
      expect(created.size.kind).toBe('equal');
      expect(created.swapReferenceFace).toBe(false);
    }
  });
});

describe('commitPattern(FR-411、FR-412、§0.a-0.20)', () => {
  const LINEAR_PLACEMENT = {
    kind: 'linear' as const,
    direction: { kind: 'world' as const, axis: 'x' as const },
    spacing: expressionValueFromNumber(20),
    count: expressionValueFromNumber(3),
    symmetric: false,
  };

  it('穴を選んで直線パターンを作る', () => {
    const base = documentWithBodies(['extrude-1']);
    const document = appendSolid(base, holeFeature('hole-1'));
    const context: MachiningContext = { document, bodies: [], selection: ['hole-1'] };
    const outcome = commitPattern(context, { placement: LINEAR_PLACEMENT });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.name).toBe('直線パターン1');
    expect(created.kind).toBe('pattern');
    if (created.kind === 'pattern') {
      expect(created.sourceFeatureId).toBe('hole-1');
    }
  });

  it('押し出しを選ぶと sourceNotHole', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = { document, bodies: [], selection: ['extrude-1'] };
    const outcome = commitPattern(context, { placement: LINEAR_PLACEMENT });
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.sourceNotHole' });
  });

  it('何も選ばなければ noPatternSource', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = { document, bodies: [], selection: [] };
    const outcome = commitPattern(context, { placement: LINEAR_PLACEMENT });
    expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.noPatternSource' });
  });

  /**
   * 個数の検査(計画書タスク29、NFR-UX-5「実行してから失敗させない」)。境界は
   * `resolvePart.ts` の `resolvePatternCount`(2 以上 MAX_PATTERN_COUNT(100)以下の整数)と揃える。
   */
  describe('個数の検査(タスク29、NFR-UX-5)', () => {
    function contextWithHole(): MachiningContext {
      const base = documentWithBodies(['extrude-1']);
      const document = appendSolid(base, holeFeature('hole-1'));
      return { document, bodies: [], selection: ['hole-1'] };
    }

    it.each([
      ['1(2 未満)', 1],
      ['101(100 超)', 101],
      ['2.5(整数でない)', 2.5],
    ])('個数が%s なら invalidPatternCount', (_label, count) => {
      const outcome = commitPattern(contextWithHole(), {
        placement: { ...LINEAR_PLACEMENT, count: expressionValueFromNumber(count) },
      });
      expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.invalidPatternCount' });
    });

    it('個数が非数(NaN)なら invalidPatternCount', () => {
      const outcome = commitPattern(contextWithHole(), {
        placement: { ...LINEAR_PLACEMENT, count: { source: 'a', value: Number.NaN, display: 'NaN' } },
      });
      expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.invalidPatternCount' });
    });

    it.each([
      ['2', 2],
      ['100', 100],
    ])('個数が%s なら ok', (_label, count) => {
      const outcome = commitPattern(contextWithHole(), {
        placement: { ...LINEAR_PLACEMENT, count: expressionValueFromNumber(count) },
      });
      expect(outcome.ok).toBe(true);
    });

    it('両側へ + 偶数個(4)は patternSymmetricNeedsOdd', () => {
      const outcome = commitPattern(contextWithHole(), {
        placement: { ...LINEAR_PLACEMENT, count: expressionValueFromNumber(4), symmetric: true },
      });
      expect(outcome).toEqual({ ok: false, reasonKey: 'machiningError.patternSymmetricNeedsOdd' });
    });

    it('両側へ + 奇数個(3)は ok', () => {
      const outcome = commitPattern(contextWithHole(), {
        placement: { ...LINEAR_PLACEMENT, count: expressionValueFromNumber(3), symmetric: true },
      });
      expect(outcome.ok).toBe(true);
    });

    it('円形パターンは「両側へ」を持たないので偶数個でも ok', () => {
      const outcome = commitPattern(contextWithHole(), {
        placement: {
          kind: 'circular',
          axis: { kind: 'world', axis: 'z' },
          angle: expressionValueFromNumber(360),
          count: expressionValueFromNumber(4),
          fullCircle: true,
        },
      });
      expect(outcome.ok).toBe(true);
    });
  });
});

describe('commitMachiningInput(タスク24 の SolidInputCommit から作る)', () => {
  function commit(overrides: Partial<SolidInputCommit>): SolidInputCommit {
    return {
      kind: 'solid',
      tool: 'hole',
      step: 'holeSize',
      values: {},
      flags: {},
      ...overrides,
    };
  }

  it('hole の確定で穴を作り、傾き角・方位角は既定の 0 を使う', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
    };
    const outcome = commitMachiningInput(
      context,
      commit({ tool: 'hole', step: 'holeSize', values: { diameter: DIAMETER_6, depth: DEPTH_10 } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.kind).toBe('hole');
    if (created.kind === 'hole') {
      expect(created.tiltAngle.value).toBe(0);
      expect(created.tiltAzimuth.value).toBe(0);
    }
  });

  it('hole の through が真なら貫通穴になる', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
    };
    const outcome = commitMachiningInput(
      context,
      commit({ tool: 'hole', step: 'holeSize', values: {}, flags: { through: true } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    expect(created.kind).toBe('hole');
    if (created.kind === 'hole') {
      expect(created.depth).toEqual({ kind: 'through' });
    }
  });

  it('spring の確定はここでは作らない(タスク25b の担当。notYetAvailable)', () => {
    const document = documentWithBodies([]);
    const context: MachiningContext = { document, bodies: [], selection: [] };
    const outcome = commitMachiningInput(
      context,
      commit({ tool: 'spring', step: 'springLength', values: {}, flags: {} }),
    );
    expect(outcome).toEqual({ ok: false, reasonKey: 'solidError.notYetAvailable' });
  });
});

describe('machiningToolReadiness(NFR-UX-5)', () => {
  it('hole: 面 + 点があれば ready', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
    };
    expect(machiningToolReadiness(context, 'hole')).toEqual({ ready: true, reasonKey: null });
  });

  it('hole: 何も選ばれていなければ noFace', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [],
    };
    expect(machiningToolReadiness(context, 'hole')).toEqual({
      ready: false,
      reasonKey: 'machiningError.noFace',
    });
  });

  it('threadHole は hole と同じ判定を使う', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)],
    };
    expect(machiningToolReadiness(context, 'threadHole')).toEqual({ ready: true, reasonKey: null });
  });

  it('fillet: 辺があれば ready', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { edges: [makeEdge(0, [0, 0, 0], [10, 0, 0])] })],
      selection: [subShapeElementId('extrude-1', 'edge', 0)],
    };
    expect(machiningToolReadiness(context, 'fillet')).toEqual({ ready: true, reasonKey: null });
  });

  it('chamfer: 辺が無ければ noEdge', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = { document, bodies: [makeBody('extrude-1')], selection: [] };
    expect(machiningToolReadiness(context, 'chamfer')).toEqual({
      ready: false,
      reasonKey: 'machiningError.noEdge',
    });
  });

  it('linearPattern / circularPattern: 穴が選ばれていれば ready', () => {
    const base = documentWithBodies(['extrude-1']);
    const document = appendSolid(base, holeFeature('hole-1'));
    const context: MachiningContext = { document, bodies: [], selection: ['hole-1'] };
    expect(machiningToolReadiness(context, 'linearPattern')).toEqual({ ready: true, reasonKey: null });
    expect(machiningToolReadiness(context, 'circularPattern')).toEqual({ ready: true, reasonKey: null });
  });

  it('linearPattern: 何も選ばれていなければ noPatternSource', () => {
    const document = documentWithBodies(['extrude-1']);
    const context: MachiningContext = { document, bodies: [], selection: [] };
    expect(machiningToolReadiness(context, 'linearPattern')).toEqual({
      ready: false,
      reasonKey: 'machiningError.noPatternSource',
    });
  });
});

describe('スケッチをまたぐ id の取り違え(P4 仕上げ (g)、穴の中心)', () => {
  it('中心の点は編集中のスケッチのものを使う(FR-405)', () => {
    // 両方のスケッチに同じ id(`point-1`)の点を置く。要素 id はスケッチの中でだけ一意。
    const base = withPoint(documentWithBodies(['extrude-1']));
    const second = appendFeature(
      { id: 'sketch-2', name: 'スケッチ2', features: [] },
      createPointFeature({ id: 'sketch-2', name: 'スケッチ2', features: [] }, absoluteCoordinate(9, 9, 0)),
    );
    const document: PartDocument = {
      ...base.document,
      sketches: [base.document.sketches[0], second],
      activeSketchId: 'sketch-2',
    };
    const context: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), base.pointId],
    };
    const commit: SolidInputCommit = {
      kind: 'solid',
      tool: 'hole',
      step: 'holeSize',
      values: { diameter: DIAMETER_6 },
      flags: {},
    };
    const outcome = commitMachiningInput(context, commit);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const hole = findSolid(outcome.document, outcome.featureId);
    expect(hole?.kind).toBe('hole');
    if (hole?.kind !== 'hole') {
      return;
    }
    expect(hole.centers).toEqual([{ sketchId: 'sketch-2', pointFeatureId: base.pointId }]);
  });
});

/* ===== P5 タスク50: 穴と R 面取りへ畳んだ欄(統括の決定 2026-09-06) ===== */

describe('穴と R 面取りへ畳んだ欄(P5 タスク50)', () => {
  const FACE_0 = subShapeElementId('extrude-1', 'face', 0);

  function holeContext(): MachiningContext {
    return {
      document: withPoint(documentWithBodies(['extrude-1'])).document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [FACE_0, 'point-1'],
    };
  }

  function filletContext(): MachiningContext {
    return {
      document: documentWithBodies(['extrude-1']),
      bodies: [
        makeBody('extrude-1', { edges: [makeEdge(0, [0, 0, 0], [10, 0, 0])] }),
      ],
      selection: [subShapeElementId('extrude-1', 'edge', 0)],
    };
  }

  function holeCommit(overrides: Partial<SolidInputCommit> = {}): SolidInputCommit {
    return {
      kind: 'solid',
      tool: 'hole',
      step: 'holeSize',
      values: { diameter: DIAMETER_6, depth: DEPTH_10 },
      flags: {},
      ...overrides,
    };
  }

  function filletCommit(overrides: Partial<SolidInputCommit> = {}): SolidInputCommit {
    return {
      kind: 'solid',
      tool: 'fillet',
      step: 'filletRadius',
      values: { radius: RADIUS_2 },
      flags: {},
      ...overrides,
    };
  }

  it('穴: 入口を「広げない」のままなら `entry` の欄が生えない(P3 と同じ文書)', () => {
    const context = holeContext();
    const plain = commitMachiningInput(context, holeCommit());
    const chosen = commitMachiningInput(
      context,
      holeCommit({ shapeChoices: { holeEntry: 'plain' } }),
    );
    expect(plain.ok && chosen.ok).toBe(true);
    if (!plain.ok || !chosen.ok) {
      return;
    }
    const feature = requireFeature(plain.document, plain.featureId);
    expect(feature.kind === 'hole' ? feature.entry : 'x').toBeUndefined();
    expect(chosen.document.solids).toEqual(plain.document.solids);
  });

  it('穴: ざぐりを選ぶと径と深さが入る(FR-422)', () => {
    const outcome = commitMachiningInput(
      holeContext(),
      holeCommit({
        shapeChoices: { holeEntry: 'counterbore' },
        values: {
          diameter: DIAMETER_6,
          depth: DEPTH_10,
          counterboreDiameter: expressionValueFromNumber(11),
          counterboreDepth: expressionValueFromNumber(4),
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = requireFeature(outcome.document, outcome.featureId);
    expect(feature.kind === 'hole' ? feature.entry : null).toEqual({
      kind: 'counterbore',
      diameter: expressionValueFromNumber(11),
      depth: expressionValueFromNumber(4),
    });
  });

  it('穴: 皿もみを選ぶと頭径と開き角が入り、欄を空にすると既定(12 / 90)になる', () => {
    const outcome = commitMachiningInput(
      holeContext(),
      holeCommit({ shapeChoices: { holeEntry: 'countersink' } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = requireFeature(outcome.document, outcome.featureId);
    expect(feature.kind === 'hole' && feature.entry?.kind === 'countersink'
      ? [feature.entry.diameter.value, feature.entry.angle.value]
      : null,
    ).toEqual([12, 90]);
  });

  it('穴: 知らない入口の値は断る', () => {
    expect(
      commitMachiningInput(holeContext(), holeCommit({ shapeChoices: { holeEntry: 'ざぐり風' } })),
    ).toEqual({ ok: false, reasonKey: 'shapeError.unknownChoice' });
  });

  it('R 面取り: つまみが切なら `radiusEnd` の欄が生えない(P3 と同じ文書)', () => {
    const outcome = commitMachiningInput(filletContext(), filletCommit());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = requireFeature(outcome.document, outcome.featureId);
    expect(feature.kind === 'fillet' ? feature.radiusEnd : 'x').toBeUndefined();
    expect(feature.kind === 'fillet' ? feature.radius.value : null).toBe(2);
  });

  it('R 面取り: 「終わりを別の半径に」で終わりの半径が入る(FR-426)', () => {
    const outcome = commitMachiningInput(
      filletContext(),
      filletCommit({
        flags: { variableRadius: true },
        values: { radius: RADIUS_2, filletRadiusEnd: expressionValueFromNumber(5) },
      }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = requireFeature(outcome.document, outcome.featureId);
    expect(feature.kind === 'fillet' ? feature.radiusEnd?.value : null).toBe(5);
  });

  it('R 面取り: つまみを入れて欄を空にすると既定の 5mm になる', () => {
    const outcome = commitMachiningInput(
      filletContext(),
      filletCommit({ flags: { variableRadius: true } }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const feature = requireFeature(outcome.document, outcome.featureId);
    expect(feature.kind === 'fillet' ? feature.radiusEnd?.value : null).toBe(5);
  });
});

describe('円筒の側面の穴を作る(EX05)', () => {
  /** 半径 10・高さ 40 の円筒の側面(指紋は面の素性から作られる。曲面の種類だけが判定に効く)。 */
  const CYLINDER_SIDE = makeFace(1, { surfaceKind: 'cylinder', area: 2513.2741228718346, centroid: [0, 0, 20], axis: [0, 0, 1], radius: 10 });
  const HEIGHT_12 = expressionValueFromNumber(12);
  const ANGLE_90 = expressionValueFromNumber(90);

  function commit(overrides: Partial<SolidInputCommit>): SolidInputCommit {
    return { kind: 'solid', tool: 'hole', step: 'holeSize', values: {}, flags: {}, ...overrides };
  }

  function cylinderContext(extraSelection: readonly string[] = [], document = documentWithBodies(['extrude-1'])): MachiningContext {
    return {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0), CYLINDER_SIDE] })],
      selection: [subShapeElementId('extrude-1', 'face', 1), ...extraSelection],
    };
  }

  it('「円筒の側面に」で、入れた高さ・角度の式のまま位置 1 つの穴を作る(中心の点は使わない)', () => {
    const context = cylinderContext();
    const outcome = commitMachiningInput(context, commit({
      values: { diameter: DIAMETER_6, depth: DEPTH_10, holeCylinderHeight: HEIGHT_12, holeCylinderAngle: ANGLE_90 },
      flags: { cylinderFace: true },
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    if (created.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(created.face.fingerprint).toMatchObject({ kind: 'face', surfaceKind: 'cylinder', radius: 10 });
    expect(created.centers).toEqual([]);
    expect(created.cylindrical).toEqual({ kind: 'cylinder-face', locations: [{ height: HEIGHT_12, angle: ANGLE_90 }] });
    expect(created.depth).toEqual({ kind: 'blind', depth: DEPTH_10 });
    expect('entry' in created).toBe(false);
  });

  it('高さ・角度を入れずに確定すると既定(10 mm・0 度)を使う', () => {
    const outcome = commitMachiningInput(cylinderContext(), commit({ flags: { cylinderFace: true, through: true } }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const created = requireFeature(outcome.document, outcome.featureId);
    if (created.kind !== 'hole') {
      throw new Error('穴のはず');
    }
    expect(DEFAULT_CYLINDER_HOLE_HEIGHT.value).toBe(10);
    expect(DEFAULT_CYLINDER_HOLE_ANGLE.value).toBe(0);
    expect(created.cylindrical?.locations).toEqual([{ height: DEFAULT_CYLINDER_HOLE_HEIGHT, angle: DEFAULT_CYLINDER_HOLE_ANGLE }]);
    expect(created.depth).toEqual({ kind: 'through' });
  });

  it('円筒座ぐりの高さ・角度と入口寸法を同時に確定し、もとの文書を変えない', () => {
    const context = cylinderContext();
    const diameter = expressionValueFromNumber(8);
    const depth = expressionValueFromNumber(2);
    const outcome = commitMachiningInput(context, commit({
      flags: { cylinderFace: true, through: true }, shapeChoices: { holeEntry: 'counterbore' },
      values: { diameter: DIAMETER_6, counterboreDiameter: diameter, counterboreDepth: depth,
        holeCylinderHeight: HEIGHT_12, holeCylinderAngle: ANGLE_90 },
    }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    const created = requireFeature(outcome.document, outcome.featureId);
    if (created.kind !== 'hole') throw new Error('穴のはず');
    expect(created.entry).toEqual({ kind: 'counterbore', diameter, depth });
    expect(created.cylindrical).toEqual({ kind: 'cylinder-face', locations: [{ height: HEIGHT_12, angle: ANGLE_90 }] });
    expect(created.depth).toEqual({ kind: 'through' });
    expect(created.centers).toEqual([]);
    expect(context.document.solids).toHaveLength(1);
    expect(outcome.document.solids).toHaveLength(2);
  });

  it('円筒でない面・点との同時指定・皿もみは、作る前に断って文書を変えない', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const planeContext: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0), CYLINDER_SIDE] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)],
    };
    const cases: readonly [MachiningContext, SolidInputCommit, string][] = [
      [planeContext, commit({ flags: { cylinderFace: true } }), 'machiningError.cylinderHoleNotCylinder'],
      [cylinderContext([pointId], document), commit({ flags: { cylinderFace: true } }), 'machiningError.cylinderHoleWithPoints'],
      [cylinderContext([], document), commit({ flags: { cylinderFace: true }, shapeChoices: { holeEntry: 'countersink' } }),
        'machiningError.cylinderHoleEntry'],
    ];
    for (const [context, input, reasonKey] of cases) {
      expect(commitMachiningInput(context, input)).toEqual({ ok: false, reasonKey });
    }
    expect(document.solids).toHaveLength(1);
  });

  it('「円筒の側面に」を入れなければ今までどおり点が要り、点の穴には欄を作らない', () => {
    expect(commitMachiningInput(cylinderContext(), commit({}))).toEqual({ ok: false, reasonKey: 'machiningError.noCenterPoint' });
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const outcome = commitHole({
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0), pointId],
    }, HOLE_PARAMS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect('cylindrical' in requireFeature(outcome.document, outcome.featureId)).toBe(false);
  });

  it('穴とねじ穴は面だけでも配置入力を開け、点モードの確定には中心点が要る', () => {
    expect(machiningToolReadiness(cylinderContext(), 'hole')).toEqual({ ready: true, reasonKey: null });
    // ねじ穴も円筒の側面に作れる(EX05、task208/209)。点が無くても道具を押せる。
    expect(machiningToolReadiness(cylinderContext(), 'threadHole')).toEqual({ ready: true, reasonKey: null });
    const planeOnly: MachiningContext = {
      document: documentWithBodies(['extrude-1']),
      bodies: [makeBody('extrude-1', { faces: [makeFace(0)] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)],
    };
    expect(machiningToolReadiness(planeOnly, 'hole')).toEqual({ ready: true, reasonKey: null });
    expect(machiningToolReadiness(planeOnly, 'threadHole')).toEqual({ ready: true, reasonKey: null });
    for (const tool of ['hole', 'threadHole']) {
      if (tool !== 'hole' && tool !== 'threadHole') throw new Error('Unexpected tool');
      const commit: SolidInputCommit = { kind: 'solid', tool,
        step: tool === 'hole' ? 'holeSize' : 'threadSize', values: {}, flags: {} };
      expect(commitMachiningInput(planeOnly, commit))
        .toEqual({ ok: false, reasonKey: 'machiningError.noCenterPoint' });
    }
  });
});

describe('円筒の側面のねじ穴を作る(EX05)', () => {
  /** 半径 10・高さ 40 の円筒の側面(穴の EX05 の試験と同じ素性)。 */
  const CYLINDER_SIDE = makeFace(1, { surfaceKind: 'cylinder', area: 2513.2741228718346, centroid: [0, 0, 20], axis: [0, 0, 1], radius: 10 });
  const HEIGHT_12 = expressionValueFromNumber(12);
  const ANGLE_90 = expressionValueFromNumber(90);

  function commit(overrides: Partial<SolidInputCommit>): SolidInputCommit {
    return { kind: 'solid', tool: 'threadHole', step: 'threadSize', values: {}, flags: {}, ...overrides };
  }

  function cylinderContext(extraSelection: readonly string[] = [], document = documentWithBodies(['extrude-1'])): MachiningContext {
    return {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0), CYLINDER_SIDE] })],
      selection: [subShapeElementId('extrude-1', 'face', 1), ...extraSelection],
    };
  }

  const RADIAL = { values: { depth: DEPTH_10, holeCylinderHeight: HEIGHT_12, holeCylinderAngle: ANGLE_90 }, flags: { cylinderFace: true } };

  it('「円筒の側面に」で、入れた高さ・角度の式のまま M6 のめねじ穴を作る(中心の点は使わない)', () => {
    const context = cylinderContext();
    const outcome = commitMachiningInput(context, commit(RADIAL));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    const created = requireFeature(outcome.document, outcome.featureId);
    if (created.kind !== 'threadHole') throw new Error('ねじ穴のはず');
    expect(created.face.fingerprint).toMatchObject({ kind: 'face', surfaceKind: 'cylinder', radius: 10 });
    expect(created.centers).toEqual([]);
    expect(created.cylindrical).toEqual({ kind: 'cylinder-face', locations: [{ height: HEIGHT_12, angle: ANGLE_90 }] });
    expect(created.depth).toEqual({ kind: 'blind', depth: DEPTH_10 });
    expect(created.designation).toBe('M6');
    // めねじの下穴(D1)は呼び径 6 より細い。軸に切る外ねじ(threadShaft)ではない。
    expect(created.drillDiameter.value).toBeLessThan(6);
    expect(context.document.solids).toHaveLength(1);
    expect(outcome.document.solids).toHaveLength(2);
  });

  it('円筒でない面・点との同時指定は作る前に断り、「円筒の側面に」が切なら今までどおり点が要る', () => {
    const base = documentWithBodies(['extrude-1']);
    const { document, pointId } = withPoint(base);
    const planeContext: MachiningContext = {
      document,
      bodies: [makeBody('extrude-1', { faces: [makeFace(0), CYLINDER_SIDE] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)],
    };
    expect(commitMachiningInput(planeContext, commit({ flags: { cylinderFace: true } })))
      .toEqual({ ok: false, reasonKey: 'machiningError.cylinderHoleNotCylinder' });
    expect(commitMachiningInput(cylinderContext([pointId], document), commit({ flags: { cylinderFace: true } })))
      .toEqual({ ok: false, reasonKey: 'machiningError.cylinderHoleWithPoints' });
    expect(commitMachiningInput(cylinderContext(), commit({}))).toEqual({ ok: false, reasonKey: 'machiningError.noCenterPoint' });
    expect(document.solids).toHaveLength(1);
  });

  it('作ったねじ穴は Undo で前の文書へ正確に戻り、Redo で同じ文書へ戻る', () => {
    const context = cylinderContext();
    const outcome = commitMachiningInput(context, commit(RADIAL));
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    const stack = pushUndo(createUndoStack(context.document), outcome.document);
    expect(undo(stack).present).toBe(context.document);
    expect(redo(undo(stack)).present).toBe(outcome.document);
    expect(redo(undo(stack)).present.solids.find((feature) => feature.id === outcome.featureId))
      .toEqual(requireFeature(outcome.document, outcome.featureId));
  });
});


import { beforeAll } from 'vitest';
import { t } from '../i18n/t.js';
import { applySolidCommit } from '../sketch/commitToStore.js';
import { initializeNativeKernelForNodeTests } from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { nativeHistoryHarness } from './holeThreadHistory.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  chooseNumericInput, commitNumericInput, createNumericInput, reduceNumericInput, toggleNumericInput,
} from '../sketch/numericInput.js';

describe('EX05 creation boundary and unchanged history', () => {
  beforeAll(initializeNativeKernelForNodeTests, 180_000);

  it.each(['hole', 'counterbore', 'threadHole'] as const)('%s: current height and angle sources reach the saved feature without changing other inputs', kind => {
    const tool = kind === 'threadHole' ? 'threadHole' : 'hole';
    let state = toggleNumericInput(createNumericInput(tool, tool === 'hole' ? 'holeSize' : 'threadSize'), 'cylinderFace');
    if (kind === 'counterbore') state = chooseNumericInput(state, 'holeEntry', 'counterbore');
    if (tool === 'threadHole') {
      state = chooseNumericInput(state, 'threadDesignation', 'M10');
      state = chooseNumericInput(state, 'threadSeries', 'fine');
      state = toggleNumericInput(state, 'modeledThread');
    }
    const context: MachiningContext = { document: documentWithBodies(['extrude-1']),
      bodies: [makeBody('extrude-1', { faces: [makeFace(0, { surfaceKind: 'cylinder' })] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)] };
    const saved = (input: typeof state) => {
      const transition = commitNumericInput(input);
      if (transition.kind !== 'solidCommitted') throw new Error('Expected valid numeric input');
      const outcome = commitMachiningInput(context, transition.commit);
      if (!outcome.ok) throw new Error(outcome.reasonKey);
      const feature = requireFeature(outcome.document, outcome.featureId);
      if (feature.kind !== 'hole' && feature.kind !== 'threadHole') throw new Error('Expected hole');
      return feature;
    };
    const before = saved(state);
    for (const [key, member, source, value] of [
      ['holeCylinderHeight', 'height', '2 * 9 + 1', 19],
      ['holeCylinderAngle', 'angle', '-720 - 15', -735],
    ] as const) {
      const next = saved(reduceNumericInput(state, { type: 'edit', index: state.fields.findIndex(field => field.key === key), source }));
      const position = next.cylindrical?.locations[0];
      expect(position?.[member].source).toBe(source);
      expect(position?.[member].value).toBe(value);
      expect(next).toEqual({ ...before, cylindrical: { kind: 'cylinder-face', locations: [
        { ...before.cylindrical?.locations[0], [member]: position?.[member] },
      ] } });
    }
  });

  it('creation guidance names the supported surfaces and cylinder restrictions', () => {
    for (const key of ['toolbar.machining.holeTooltip', 'toolbar.machining.threadHoleTooltip'] as const) {
      for (const text of ['平面', '円筒の外面・内面', '円錐・球・自由曲面', '傾斜穴・皿もみには対応していません']) {
        expect(t(key)).toContain(text);
      }
    }
    expect(t('numericInput.tooltip.holeCylinderHeight')).toContain('下側の端');
    expect(t('numericInput.tooltip.holeCylinderAngle')).toContain('面の X 方向');
    expect(t('numericInput.tooltip.holeCylinderAngle')).toContain('右手');
  });

  it.each(['hole', 'threadHole'] as const)('%s: a plane opens the explicit placement chooser; cylinder rejects mixed points', tool => {
    const { document, pointId } = withPoint(documentWithBodies(['extrude-1']));
    for (const surfaceKind of ['plane', 'cylinder', 'cone', 'sphere', 'other'] as const) {
      for (const withCenter of [false, true]) {
        const context: MachiningContext = { document,
          bodies: [makeBody('extrude-1', { faces: [makeFace(0, { surfaceKind })] })],
          selection: [subShapeElementId('extrude-1', 'face', 0), ...(withCenter ? [pointId] : [])] };
        const readiness = machiningToolReadiness(context, tool);
        expect(readiness.ready).toBe(surfaceKind === 'plane' || surfaceKind === 'cylinder' && !withCenter);
        if (!readiness.ready) {
          expect(readiness.reasonKey).not.toBeNull();
          if (readiness.reasonKey !== null) expect(t(readiness.reasonKey)).not.toBe(readiness.reasonKey);
        }
      }
    }
  });

  it.each(['hole', 'threadHole'] as const)('%s: point mixing, wrong surface, nonfinite input and unsupported entry preserve document and history', async tool => {
    resetTestStore();
    const harness = await nativeHistoryHarness('cylinder');
    harness.dispose();
    for (const invalid of ['points', 'plane', 'heightNaN', 'angleInfinity', 'diameterNaN', 'depthNaN', 'countersink'] as const) {
      const input = harness.begin(tool === 'hole' ? 'blind' : 'thread');
      let commit = input;
      if (invalid === 'points') useAppStore.getState().setSelection([...useAppStore.getState().selection, 'hole-center']);
      if (invalid === 'plane') {
        const planar = useAppStore.getState().bodies[0].faces.find(face => face.surfaceKind === 'plane');
        if (planar === undefined) throw new Error('Expected planar end face');
        useAppStore.getState().setSelection([subShapeElementId('stock', 'face', planar.index)]);
      }
      const bad = { source: '1 / 0', value: invalid === 'angleInfinity' ? Infinity : NaN, display: 'bad' };
      if (invalid === 'heightNaN') commit = { ...input, values: { ...input.values, holeCylinderHeight: bad } };
      if (invalid === 'angleInfinity') commit = { ...input, values: { ...input.values, holeCylinderAngle: bad } };
      if (invalid === 'diameterNaN') commit = { ...input, values: { ...input.values,
        ...(tool === 'hole' ? { diameter: bad } : { threadLength: bad }) } };
      if (invalid === 'depthNaN') commit = { ...input, values: { ...input.values, depth: bad } };
      if (invalid === 'countersink') commit = { ...input, shapeChoices: { holeEntry: 'countersink' } };
      const before = useAppStore.getState();
      expect(applySolidCommit(commit), invalid).toBe(false);
      const after = useAppStore.getState();
      expect(after.document, invalid).toBe(before.document);
      expect(after.undoStack, invalid).toBe(before.undoStack);
      expect(after.numericInput, invalid).toBe(before.numericInput);
      expect(after.bodies, invalid).toBe(before.bodies);
      expect(after.solidErrorKey, invalid).not.toBeNull();
      if (after.solidErrorKey !== null) expect(t(after.solidErrorKey)).not.toBe(after.solidErrorKey);
    }
  }, 180_000);

  it('direct cylinder creation rejects tilt before appending a feature', () => {
    const context: MachiningContext = { document: documentWithBodies(['extrude-1']),
      bodies: [makeBody('extrude-1', { faces: [makeFace(0, { surfaceKind: 'cylinder' })] })],
      selection: [subShapeElementId('extrude-1', 'face', 0)] };
    const cylindrical = { height: expressionValueFromNumber(12), angle: expressionValueFromNumber(30) };
    for (const key of ['tiltAngle', 'tiltAzimuth'] as const) {
      const params = { ...HOLE_PARAMS, cylindrical, [key]: expressionValueFromNumber(15) };
      expect(commitHole(context, params).ok).toBe(false);
      expect(commitThreadHole(context, { ...params, designation: 'M6', series: 'coarse',
        threadLength: DEPTH_10, representation: 'simplified' }).ok).toBe(false);
    }
    expect(context.document.solids).toHaveLength(1);
  });
});

describe('EX05 explicit planar creation adapter', () => {
  const basis: NonNullable<import('@pointercad/model').SolidFaceEntry['planarBasis']> = {
    origin: [11, -7, 5], xAxis: [0.6, 0.8, 0], normal: [-0.48, 0.36, 0.8], yAxis: [-0.64, 0.48, -0.6],
  };
  function planarContext(): MachiningContext {
    const face = { ...makeFace(0), planarBasis: basis };
    return { document: documentWithBodies(['extrude-1']),
      bodies: [{ ...makeBody('extrude-1'), isValid: true, faces: [face] }],
      selection: [subShapeElementId('extrude-1', 'face', 0)] };
  }
  it('stores original signed XY, empty centers and one feature/history increment', () => {
    const context = planarContext();
    const x = { ...expressionValueFromNumber(6), source: '2 * 3' };
    const y = { ...expressionValueFromNumber(-4), source: '-2 * 2' };
    const outcome = commitHole(context, { ...HOLE_PARAMS, planar: { x, y } });
    if (!outcome.ok) throw new Error(outcome.reasonKey);
    const feature = requireFeature(outcome.document, outcome.featureId);
    if (feature.kind !== 'hole') throw new Error('Expected hole');
    expect(feature.planar).toEqual({ kind: 'plane-face', locations: [{ x, y }] });
    expect(feature.planar?.locations[0]?.x).toBe(x);
    expect(feature.centers).toEqual([]);
    expect(feature.cylindrical).toBeUndefined();
    expect(outcome.document.solids.length).toBe(context.document.solids.length + 1);
    const history = pushUndo(createUndoStack(context.document), outcome.document);
    expect(history.past).toHaveLength(1);
    expect(undo(history).present).toBe(context.document);
    expect(redo(undo(history)).present).toBe(outcome.document);
  });
  it('does not silently convert points mode, synthesize missing basis, accept empty/nonfinite XY or mixed modes', () => {
    const context = planarContext(), before = context.document;
    expect(commitHole(context, HOLE_PARAMS)).toEqual({ ok: false, reasonKey: 'machiningError.noCenterPoint' });
    const planar = { x: expressionValueFromNumber(6), y: expressionValueFromNumber(-4) };
    const missing = { ...context, bodies: [{ ...makeBody('extrude-1', { faces: [makeFace(0)] }), isValid: true }] };
    expect(commitHole(missing, { ...HOLE_PARAMS, planar })).toEqual({ ok: false, reasonKey: 'numericInput.error.planarHoleBasis' });
    for (const x of [{ ...planar.x, source: '' }, { ...planar.x, value: Infinity }]) {
      expect(commitHole(context, { ...HOLE_PARAMS, planar: { ...planar, x } }).ok).toBe(false);
      expect(context.document).toBe(before);
    }
    expect(commitHole(context, { ...HOLE_PARAMS, planar, cylindrical: { height: ZERO, angle: ZERO } }))
      .toEqual({ ok: false, reasonKey: 'numericInput.error.planarHoleConflict' });
  });
});

describe('EX05 numeric planar commit producer/consumer', () => {
  it.each(['hole', 'threadHole'])('%s: explicit choice reaches planar expression fields; unknown/missing/conflicting choice refuses', tool => {
    if (tool !== 'hole' && tool !== 'threadHole') throw new Error('Unexpected tool');
    const planarBasis: NonNullable<import('@pointercad/model').SolidFaceEntry['planarBasis']> = {
      origin: [11, -7, 5], xAxis: [0.6, 0.8, 0], yAxis: [-0.64, 0.48, -0.6], normal: [-0.48, 0.36, 0.8],
    };
    const face = { ...makeFace(0), planarBasis };
    const context: MachiningContext = { document: documentWithBodies(['extrude-1']),
      bodies: [{ ...makeBody('extrude-1'), isValid: true, faces: [face] }],
      selection: [subShapeElementId('extrude-1', 'face', 0)] };
    const x = { ...expressionValueFromNumber(6), source: '2 * 3' };
    const y = { ...expressionValueFromNumber(-4), source: '-2 * 2' };
    const commit: SolidInputCommit = { kind: 'solid', tool, step: tool === 'hole' ? 'holeSize' : 'threadSize',
      values: { diameter: DIAMETER_6, depth: DEPTH_10, threadLength: DEPTH_10, holePlanarX: x, holePlanarY: y },
      flags: {}, shapeChoices: { holePlacement: 'plane-face' } };
    const result = commitMachiningInput(context, commit);
    if (!result.ok) throw new Error(result.reasonKey);
    const feature = requireFeature(result.document, result.featureId);
    if (feature.kind !== 'hole' && feature.kind !== 'threadHole') throw new Error('Expected machining feature');
    expect(feature.planar).toEqual({ kind: 'plane-face', locations: [{ x, y }] });
    expect(feature.centers).toEqual([]);
    expect(feature.cylindrical).toBeUndefined();
    const noXY = { ...commit, values: {} };
    expect(commitMachiningInput(context, noXY)).toEqual({ ok: false, reasonKey: 'numericInput.error.planarHoleInput' });
    expect(commitMachiningInput(context, { ...commit, shapeChoices: { holePlacement: 'unknown' } }))
      .toEqual({ ok: false, reasonKey: 'shapeError.unknownChoice' });
    expect(commitMachiningInput(context, { ...commit, flags: { cylinderFace: true } }))
      .toEqual({ ok: false, reasonKey: 'numericInput.error.planarHoleConflict' });
  });
});

describe('自動生成するねじ下穴径の厳密な保存値', () => {
  const cases = [
    { designation: 'M6', diameter: 6, pitch: 1, display: '4.91746824527' },
    { designation: 'M8', diameter: 8, pitch: 1.25, display: '6.64683530659' },
  ];
  for (const size of cases) {
    for (const placement of ['plane', 'cylinder'] as const) {
      it.each([false, true])(`${size.designation} ${placement} through=%s は元倍精度とsourceを保ち表示だけ丸める`, through => {
        const base = documentWithBodies(['extrude-1']);
        const { document, pointId } = withPoint(base);
        const faces = [makeFace(0), makeFace(1, { surfaceKind: 'cylinder', radius: 10,
          centroid: [0, 0, 20], area: 2513.2741228718346 })];
        const context: MachiningContext = { document,
          bodies: [makeBody('extrude-1', { faces })],
          selection: placement === 'plane'
            ? [subShapeElementId('extrude-1', 'face', 0), pointId]
            : [subShapeElementId('extrude-1', 'face', 1)] };
        const threadLength = { ...DEPTH_10, source: '2 * 5' };
        const commit: SolidInputCommit = { kind: 'solid', tool: 'threadHole', step: 'threadSize',
          threadDesignation: size.designation, threadSeries: 'coarse',
          values: { depth: DEPTH_10, threadLength,
            holeCylinderHeight: expressionValueFromNumber(12), holeCylinderAngle: expressionValueFromNumber(90) },
          flags: { through, cylinderFace: placement === 'cylinder' } };
        const outcome = commitMachiningInput(context, commit);
        if (!outcome.ok) throw new Error(outcome.reasonKey);
        const feature = requireFeature(outcome.document, outcome.featureId);
        if (feature.kind !== 'threadHole') throw new Error('Expected a thread hole');
        // ISO基本山形 H=sqrt(3)P/2、D1=D−5H/4。製品の計算関数から期待を得ない。
        const expected = size.diameter - (5 * Math.sqrt(3) / 8) * size.pitch;
        expect(feature.drillDiameter.value).toBe(expected);
        expect(feature.drillDiameter.source).toBe(String(expected));
        const reloaded = evaluateExpression(feature.drillDiameter.source);
        if (!reloaded.ok) throw new Error('Generated source must evaluate');
        expect(reloaded.value.value).toBe(expected);
        expect(feature.drillDiameter.display).toBe(size.display);
        expect(reloaded.value.display).toBe(size.display);
        expect(feature.pitch).toEqual({ source: String(size.pitch), value: size.pitch, display: String(size.pitch) });
        expect(feature.threadLength).toBe(threadLength);
        expect(feature.depth).toEqual(through ? { kind: 'through' } : { kind: 'blind', depth: DEPTH_10 });
        expect(document.solids).toHaveLength(1);
        expect(outcome.document.solids).toHaveLength(2);
      });
    }
  }
});
