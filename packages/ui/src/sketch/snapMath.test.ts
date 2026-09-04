import { describe, expect, it } from 'vitest';
import {
  WORK_PLANES, type ResolvedArc, type ResolvedEllipse, type ResolvedPoint,
  type ResolvedSegment, type ResolvedSketch, type ResolvedSpline, type Vec3,
} from '@pointercad/model';

import {
  chooseSnap, collectSnapCandidates, DEFAULT_SNAP_KINDS, nearestGridPoint, segmentIntersection,
  SNAP_PRIORITY, SNAP_RADIUS_PIXELS, type ProjectToScreen, type SnapKind,
} from './snapMath.js';

const HORIZONTAL: ResolvedSegment = {
  kind: 'segment', featureId: 'l1', from: [0, 0, 0], to: [10, 0, 0],
};
const VERTICAL: ResolvedSegment = {
  kind: 'segment', featureId: 'l2', from: [5, -5, 0], to: [5, 5, 0],
};

const SKETCH: ResolvedSketch = {
  points: [],
  segments: [HORIZONTAL, VERTICAL],
  arcs: [],
  ellipses: [],
  splines: [],
  pendingOffsets: [],
  pendingProjections: [],
  curvesByFeature: new Map(),
  faces: [],
  errors: [],
};

const QUARTER_ARC: ResolvedArc = {
  kind: 'arc', featureId: 'a1', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0],
  radius: 10, startAngle: 0, endAngle: Math.PI / 2,
};

const ARC_SKETCH: ResolvedSketch = {
  points: [],
  segments: [],
  arcs: [QUARTER_ARC],
  ellipses: [],
  splines: [],
  pendingOffsets: [],
  pendingProjections: [],
  curvesByFeature: new Map(),
  faces: [],
  errors: [],
};

/** 点フィーチャー 1 つと、点列 `pa1` の 2 番目の点。 */
const LONE_POINT: ResolvedPoint = { id: 'point-1', featureId: 'point-1', position: [1, 2, 3] };
const ARRAY_POINT: ResolvedPoint = { id: 'pa1#2', featureId: 'pa1', position: [4, 5, 6] };

const POINT_SKETCH: ResolvedSketch = {
  points: [LONE_POINT, ARRAY_POINT],
  segments: [],
  arcs: [],
  ellipses: [],
  splines: [],
  pendingOffsets: [],
  pendingProjections: [],
  curvesByFeature: new Map(),
  faces: [],
  errors: [],
};

/** ワールドの (x, y) をそのまま画面座標にする、テスト用の写し方。 */
const project = (point: Vec3): readonly [number, number] => [point[0], point[1]];

/** 何も画面に入らない写し方。画面の外の候補を飛ばすことを確かめるのに使う。 */
const projectNothing: ProjectToScreen = () => null;

const ALL_KINDS: ReadonlySet<SnapKind> = new Set(SNAP_PRIORITY);

const without = (...excluded: readonly SnapKind[]): ReadonlySet<SnapKind> =>
  new Set(SNAP_PRIORITY.filter((kind) => !excluded.includes(kind)));

describe('スナップ(FR-107)', () => {
  it('優先順位は 端点 > 交点 > 中点 > 円中心 > グリッド、判定半径は 12 画素(§0.a-0.10)', () => {
    expect(SNAP_PRIORITY).toEqual(['endpoint', 'intersection', 'midpoint', 'center', 'grid']);
    expect(SNAP_RADIUS_PIXELS).toBe(12);
    // 既定は全種別が有効。
    expect(DEFAULT_SNAP_KINDS).toEqual(SNAP_PRIORITY);
  });

  it('交差する 2 線分の交点を求める', () => {
    // u = (10,0,0)、v = (0,10,0)、w = a.from − b.from = (−5,5,0)。
    // uu = 100、uv = 0、vv = 100、uw = −50、vw = 50、分母 = 100·100 − 0 = 10000。
    // s = (0·50 − 100·(−50)) / 10000 = 0.5、t = (100·50 − 0) / 10000 = 0.5。
    // → a 上の点も b 上の点も (5,0,0) で一致する。
    expect(segmentIntersection(HORIZONTAL, VERTICAL)).toEqual([5, 0, 0]);
  });

  it('平行・線分の外・ねじれの位置では交点を返さない', () => {
    // 平行: 分母 = 100·100 − 100·100 = 0。
    const parallel: ResolvedSegment = {
      kind: 'segment', featureId: 'l3', from: [0, 1, 0], to: [10, 1, 0],
    };
    expect(segmentIntersection(HORIZONTAL, parallel)).toBeNull();
    // 線分の外: s = (100·500) / 10000 = 5 > 1(直線どうしは x = 50 で交わるが線分は届かない)。
    const away: ResolvedSegment = {
      kind: 'segment', featureId: 'l4', from: [50, -5, 0], to: [50, 5, 0],
    };
    expect(segmentIntersection(HORIZONTAL, away)).toBeNull();
    // ねじれ: s = t = 0.5 でも (5,0,0) と (5,0,1) が 1mm 離れている(> 1e-3)。
    const lifted: ResolvedSegment = {
      kind: 'segment', featureId: 'l5', from: [5, -5, 1], to: [5, 5, 1],
    };
    expect(segmentIntersection(HORIZONTAL, lifted)).toBeNull();
  });

  it('格子点は作図面の上で丸める', () => {
    // xy: u = 12.4 → round(2.48) = 2 → 10、v = −7.7 → round(−1.54) = −2 → −10。
    expect(nearestGridPoint(WORK_PLANES.xy, [12.4, -7.7, 0], 5)).toEqual([10, -10, 0]);
    // xz: 第2軸が +Z なので、丸めた v は Z に戻る。
    expect(nearestGridPoint(WORK_PLANES.xz, [12.4, 0, -7.7], 5)).toEqual([10, 0, -10]);
    // yz: 第1軸が +Y、第2軸が +Z。
    expect(nearestGridPoint(WORK_PLANES.yz, [0, 12.4, -7.7], 5)).toEqual([0, 10, -10]);
  });

  it('線分から端点・中点・交点・格子点の候補を作る', () => {
    const candidates = collectSnapCandidates(SKETCH, WORK_PLANES.xy, 5, [0, 0, 0]);
    // 線分 2 本 × (端点 2 + 中点 1) + 交点 1 + 格子点 1 = 8。
    expect(candidates).toHaveLength(8);
    const kinds = candidates.map((candidate) => candidate.kind);
    expect(kinds.filter((kind) => kind === 'endpoint')).toHaveLength(4);
    expect(kinds.filter((kind) => kind === 'midpoint')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'intersection')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'grid')).toHaveLength(1);
    expect(candidates).toContainEqual({
      kind: 'midpoint', position: [5, 0, 0], featureId: 'l1', elementId: 'l1',
    });
    expect(candidates).toContainEqual({
      kind: 'grid', position: [0, 0, 0], featureId: null, elementId: null,
    });
    // 落とす先が無ければ格子点の候補は作らない。
    expect(collectSnapCandidates(SKETCH, WORK_PLANES.xy, 5, null)).toHaveLength(7);
  });

  it('円弧から端点 2 つ・弧長中央・中心の候補を作る', () => {
    const candidates = collectSnapCandidates(ARC_SKETCH, WORK_PLANES.xy, 5, null);
    expect(candidates).toHaveLength(4);
    // 開始角 0 → (10, 0, 0)、終了角 90 度 → (0, 10, 0)。
    expect(candidates[0].kind).toBe('endpoint');
    expect(candidates[0].position[0]).toBeCloseTo(10, 9);
    expect(candidates[1].position[1]).toBeCloseTo(10, 9);
    // 弧長中央は 45 度。10 / √2 = 7.0710678118654755。
    expect(candidates[2].kind).toBe('midpoint');
    expect(candidates[2].position[0]).toBeCloseTo(7.0710678118654755, 9);
    expect(candidates[2].position[1]).toBeCloseTo(7.0710678118654755, 9);
    expect(candidates[3]).toEqual({
      kind: 'center', position: [0, 0, 0], featureId: 'a1', elementId: 'a1',
    });
  });

  it('点の候補は elementId で 1 点を指す。点列の n 番目は `featureId#n`(FR-311 の土台)', () => {
    const candidates = collectSnapCandidates(POINT_SKETCH, WORK_PLANES.xy, 5, null);
    expect(candidates).toEqual([
      { kind: 'endpoint', position: [1, 2, 3], featureId: 'point-1', elementId: 'point-1' },
      { kind: 'endpoint', position: [4, 5, 6], featureId: 'pa1', elementId: 'pa1#2' },
    ]);
  });

  it('判定半径の中では優先度が距離に勝ち、同じ優先度なら画面距離の近い方を選ぶ', () => {
    const candidates = collectSnapCandidates(SKETCH, WORK_PLANES.xy, 5, [5, 2, 0]);
    // ポインタ (5,2) からの画面距離:
    //   端点 (0,0)=√29≈5.39 / (10,0)=√29≈5.39 / (5,−5)=7 / (5,5)=3
    //   中点 (5,0)=2 ×2 / 交点 (5,0)=2 / 格子点 (5,0)=2
    // 交点・中点・格子点の方が近いが、半径 12 の中では優先度の高い端点が勝つ。
    // 端点どうしでは最も近い (5,5,0) が選ばれる。
    expect(chooseSnap(candidates, project, [5, 2], SNAP_RADIUS_PIXELS, ALL_KINDS)).toEqual({
      kind: 'endpoint', position: [5, 5, 0], featureId: 'l2', elementId: 'l2',
    });
  });

  it('切ってある種別は選ばず、半径の外や画面の外にも吸い付かない', () => {
    const candidates = collectSnapCandidates(SKETCH, WORK_PLANES.xy, 5, [5, 2, 0]);
    // 端点を切ると、次に優先度の高い交点が選ばれる。
    expect(
      chooseSnap(candidates, project, [5, 2], SNAP_RADIUS_PIXELS, without('endpoint')),
    ).toEqual({ kind: 'intersection', position: [5, 0, 0], featureId: 'l1', elementId: 'l1' });
    // 交点も切ると中点。
    expect(
      chooseSnap(candidates, project, [5, 2], SNAP_RADIUS_PIXELS, without('endpoint', 'intersection'))
        ?.kind,
    ).toBe('midpoint');
    // グリッドだけ残せば格子点。
    expect(
      chooseSnap(candidates, project, [5, 2], SNAP_RADIUS_PIXELS, new Set<SnapKind>(['grid'])),
    ).toEqual({ kind: 'grid', position: [5, 0, 0], featureId: null, elementId: null });
    // すべて切れば何にも吸い付かない。
    expect(chooseSnap(candidates, project, [5, 2], SNAP_RADIUS_PIXELS, new Set())).toBeNull();
    // 半径の外。最も近い候補でも 495 画素離れている。
    expect(chooseSnap(candidates, project, [500, 500], SNAP_RADIUS_PIXELS, ALL_KINDS)).toBeNull();
    // 画面に写らない候補は数えない。
    expect(chooseSnap(candidates, projectNothing, [5, 2], SNAP_RADIUS_PIXELS, ALL_KINDS)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 楕円・スプラインへの吸着(FR-107、P4 タスク33、タスク12 の申し送り)
 * ------------------------------------------------------------------------- */

/** 全周の楕円。長半径 20、短半径 10。 */
const FULL_ELLIPSE: ResolvedEllipse = {
  kind: 'ellipse',
  featureId: 'e1',
  center: [3, 4, 0],
  normal: [0, 0, 1],
  majorAxis: [1, 0, 0],
  majorRadius: 20,
  minorRadius: 10,
  startAngle: 0,
  endAngle: Math.PI * 2,
};

/** 3 点を通るスプライン。 */
const SPLINE: ResolvedSpline = {
  kind: 'spline',
  featureId: 's1',
  mode: 'interpolate',
  points: [
    [0, 0, 0],
    [10, 10, 0],
    [20, 0, 0],
  ],
  closed: false,
};

const CURVE_SKETCH: ResolvedSketch = {
  points: [],
  segments: [],
  arcs: [],
  ellipses: [FULL_ELLIPSE],
  splines: [SPLINE],
  pendingOffsets: [],
  pendingProjections: [],
  curvesByFeature: new Map(),
  faces: [],
  errors: [],
};

describe('楕円とスプラインへの吸着(FR-107、P4 タスク33)', () => {
  it('楕円は中心を候補に出す', () => {
    const candidates = collectSnapCandidates(CURVE_SKETCH, WORK_PLANES.xy, 0, null);
    const center = candidates.find(
      (candidate) => candidate.kind === 'center' && candidate.featureId === 'e1',
    );
    expect(center?.position).toEqual([3, 4, 0]);
  });

  it('スプラインは端点を候補に出す(通過点の 1 つ目と最後)', () => {
    const candidates = collectSnapCandidates(CURVE_SKETCH, WORK_PLANES.xy, 0, null);
    const endpoints = candidates.filter(
      (candidate) => candidate.kind === 'endpoint' && candidate.featureId === 's1',
    );
    expect(endpoints).toHaveLength(2);
    // 通過点補間なので、曲線の両端は与えた点そのもの。
    expect(endpoints[0].position[0]).toBeCloseTo(0, 6);
    expect(endpoints[1].position[0]).toBeCloseTo(20, 6);
  });

  it('楕円もスプラインも中点の候補を 1 つずつ持つ', () => {
    const candidates = collectSnapCandidates(CURVE_SKETCH, WORK_PLANES.xy, 0, null);
    const midpoints = candidates.filter((candidate) => candidate.kind === 'midpoint');
    expect(midpoints.map((candidate) => candidate.featureId).sort()).toEqual(['e1', 's1']);
  });
});
