import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createEmptyPartDocument,
  createPointFeature,
  DEFAULT_WORK_PLANE_ID,
  findSolid,
  replaceSketch,
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
    expect(machiningToolReadiness(context, 'threadHole')).toEqual({
      ready: false,
      reasonKey: 'machiningError.noCenterPoint',
    });
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
