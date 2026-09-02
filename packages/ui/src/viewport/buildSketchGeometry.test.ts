import { DEFAULT_FACE_COLOR, type ResolvedArc, type ResolvedSegment, type ResolvedSketch, type SketchFaceMesh, type SketchMesh } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { ARC_SEGMENTS_PER_TURN } from '../sketch/sampleCurve.js';
import {
  buildSketchGeometry,
  emphasisOf,
  EMPTY_RESOLVED_SKETCH,
  NO_HIGHLIGHT,
} from './buildSketchGeometry.js';

/** 線分 1 本。両端 2 点 → 6 個の数。 */
const SEGMENT: ResolvedSegment = {
  kind: 'segment',
  featureId: 'l1',
  from: [0, 0, 0],
  to: [10, 0, 0],
};

/** 90 度の円弧。64 分割の 1/4 なので 16 区間 → 16 × 6 = 96 個の数。 */
const QUARTER_ARC: ResolvedArc = {
  kind: 'arc',
  featureId: 'a1',
  center: [0, 0, 0],
  normal: [0, 0, 1],
  xAxis: [1, 0, 0],
  radius: 10,
  startAngle: 0,
  endAngle: Math.PI / 2,
};

/** 点だけで張った面。境界の線はフィーチャーとして存在しないので featureId は面自身。 */
const POINT_FACE: ResolvedSketch['faces'][number] = {
  featureId: 'f1',
  color: DEFAULT_FACE_COLOR,
  curves: [
    { kind: 'segment', featureId: 'f1', from: [0, 0, 0], to: [10, 0, 0] },
    { kind: 'segment', featureId: 'f1', from: [10, 0, 0], to: [10, 10, 0] },
    { kind: 'segment', featureId: 'f1', from: [10, 10, 0], to: [0, 0, 0] },
  ],
};

/** 線を選んで張った面。境界は線フィーチャー l1 そのもの。 */
const CURVE_FACE: ResolvedSketch['faces'][number] = {
  featureId: 'f2',
  color: '#ffb454',
  curves: [SEGMENT],
};

/** 三角形 1 枚ぶんの面メッシュ。境界は線分対(6 要素/本)で 3 本 = 18 個。 */
function faceMesh(featureId: string, color: string): SketchFaceMesh {
  return {
    featureId,
    color,
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    triangleCount: 1,
    boundaryPositions: new Float32Array([
      0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 10, 0, 10, 10, 0, 0, 0, 0,
    ]),
  };
}

const SKETCH: ResolvedSketch = {
  points: [
    { id: 'p1', featureId: 'p1', position: [0, 0, 0] },
    { id: 'pa1#0', featureId: 'pa1', position: [10, 0, 0] },
    { id: 'pa1#1', featureId: 'pa1', position: [20, 0, 0] },
  ],
  segments: [SEGMENT],
  arcs: [QUARTER_ARC],
  faces: [POINT_FACE],
  errors: [],
};

describe('スケッチの描画データ', () => {
  it('何も無ければ空の並びになり、対応表も空になる', () => {
    const bundle = buildSketchGeometry(EMPTY_RESOLVED_SKETCH, null);
    expect(bundle.points.none).toHaveLength(0);
    expect(bundle.points.hovered).toHaveLength(0);
    expect(bundle.points.selected).toHaveLength(0);
    expect(bundle.curves.none).toHaveLength(0);
    expect(bundle.faceOutlines.none).toHaveLength(0);
    expect(bundle.faces).toHaveLength(0);
    expect(bundle.index.size).toBe(0);
  });

  it('点は 1 個あたり 3 個の数になり、対応表が入った場所を指す', () => {
    const bundle = buildSketchGeometry(SKETCH, null);
    expect(bundle.points.none).toHaveLength(9);
    expect(Array.from(bundle.points.none)).toEqual([0, 0, 0, 10, 0, 0, 20, 0, 0]);
    expect(bundle.index.get('p1')).toEqual({
      elementId: 'p1',
      featureId: 'p1',
      kind: 'point',
      emphasis: 'none',
      offset: 0,
      length: 3,
      meshIndex: null,
    });
    expect(bundle.index.get('pa1#1')?.offset).toBe(6);
    expect(bundle.index.get('pa1#1')?.featureId).toBe('pa1');
  });

  it('線分は 1 本あたり 6 個、90 度の円弧は 16 本ぶん 96 個の数になる', () => {
    const bundle = buildSketchGeometry(SKETCH, null);
    expect(ARC_SEGMENTS_PER_TURN).toBe(64);
    // 線分 6 + 円弧 96 = 102。円弧は 64 × 1/4 = 16 区間。
    expect(bundle.curves.none).toHaveLength(102);
    expect(Array.from(bundle.curves.none.slice(0, 6))).toEqual([0, 0, 0, 10, 0, 0]);
    expect(bundle.index.get('l1')).toEqual({
      elementId: 'l1',
      featureId: 'l1',
      kind: 'curve',
      emphasis: 'none',
      offset: 0,
      length: 6,
      meshIndex: null,
    });
    // 円弧は線分の後ろに続く。
    expect(bundle.index.get('a1')?.offset).toBe(6);
    expect(bundle.index.get('a1')?.length).toBe(96);
  });

  it('点だけで張った面の縁は曲線ごとに 1 本ずつ、3 本ぶん 18 個の数になる', () => {
    const bundle = buildSketchGeometry(SKETCH, null);
    expect(bundle.faceOutlines.none).toHaveLength(18);
    expect(Array.from(bundle.faceOutlines.none.slice(0, 6))).toEqual([0, 0, 0, 10, 0, 0]);
    expect(bundle.index.get('f1')).toEqual({
      elementId: 'f1',
      featureId: 'f1',
      kind: 'face',
      emphasis: 'none',
      offset: 0,
      length: 18,
      meshIndex: null,
    });
    // 三角形がまだ届いていないので面は 1 枚も無く、縁だけが出る。
    expect(bundle.faces).toHaveLength(0);
  });

  it('線を選んで張った面の縁は引かない(同じ線を 2 本重ねない)', () => {
    const sketch: ResolvedSketch = { ...SKETCH, faces: [CURVE_FACE] };
    const bundle = buildSketchGeometry(sketch, null);
    expect(bundle.faceOutlines.none).toHaveLength(0);
    expect(bundle.index.get('f2')?.length).toBe(0);
    // 線そのものは「線・円弧」として 1 本だけ描かれている。
    expect(bundle.index.get('l1')?.length).toBe(6);
  });

  it('カーネルの面が届いたら三角形と境界の線分対を使う', () => {
    const mesh: SketchMesh = { faces: [faceMesh('f1', DEFAULT_FACE_COLOR)] };
    const bundle = buildSketchGeometry(SKETCH, mesh);
    expect(bundle.faces).toHaveLength(1);
    expect(bundle.faces[0].featureId).toBe('f1');
    expect(bundle.faces[0].color).toBe(DEFAULT_FACE_COLOR);
    expect(bundle.faces[0].indices).toHaveLength(3);
    expect(bundle.faces[0].positions).toHaveLength(9);
    expect(bundle.faces[0].emphasis).toBe('none');
    // 境界は折れ線ではなく線分対(6 要素/本)なのでそのまま使う。3 本 = 18 個。
    expect(bundle.faceOutlines.none).toHaveLength(18);
    expect(bundle.index.get('f1')?.meshIndex).toBe(0);
  });

  it('ホバーと選択は別の並びへ分かれ、選択がホバーより強い', () => {
    const mesh: SketchMesh = { faces: [faceMesh('f1', DEFAULT_FACE_COLOR)] };
    const bundle = buildSketchGeometry(SKETCH, mesh, {
      hoveredElementId: 'p1',
      selection: ['l1', 'f1'],
    });
    // 点 3 個のうち 1 個がホバー。
    expect(bundle.points.none).toHaveLength(6);
    expect(bundle.points.hovered).toHaveLength(3);
    expect(bundle.points.selected).toHaveLength(0);
    expect(Array.from(bundle.points.hovered)).toEqual([0, 0, 0]);
    // 線分は選択、円弧はそのまま。
    expect(bundle.curves.selected).toHaveLength(6);
    expect(bundle.curves.none).toHaveLength(96);
    expect(bundle.index.get('a1')?.offset).toBe(0);
    // 面は選択。縁も面の三角形も強調側へ入る。
    expect(bundle.faceOutlines.selected).toHaveLength(18);
    expect(bundle.faceOutlines.none).toHaveLength(0);
    expect(bundle.faces[0].emphasis).toBe('selected');
    expect(bundle.index.get('f1')?.emphasis).toBe('selected');
  });

  it('点列そのものを選ぶと中の点がすべて強調される', () => {
    const bundle = buildSketchGeometry(SKETCH, null, {
      hoveredElementId: null,
      selection: ['pa1'],
    });
    expect(bundle.points.selected).toHaveLength(6);
    expect(bundle.points.none).toHaveLength(3);
    expect(bundle.index.get('pa1#0')?.emphasis).toBe('selected');
    expect(bundle.index.get('pa1#1')?.offset).toBe(3);
  });

  it('強調の決め方は選択 > ホバー > 通常', () => {
    const highlight = { hoveredElementId: 'l1', selection: ['l1'] };
    expect(emphasisOf('l1', 'l1', highlight, new Set(highlight.selection))).toBe('selected');
    expect(emphasisOf('a1', 'a1', highlight, new Set(highlight.selection))).toBe('none');
    expect(
      emphasisOf('pa1#0', 'pa1', { hoveredElementId: 'pa1', selection: [] }, new Set()),
    ).toBe('hovered');
    expect(emphasisOf('p1', 'p1', NO_HIGHLIGHT, new Set())).toBe('none');
  });

  it('対応表は 点 → 線・円弧 → 面 の順に並ぶ', () => {
    const bundle = buildSketchGeometry(SKETCH, null);
    expect(Array.from(bundle.index.keys())).toEqual(['p1', 'pa1#0', 'pa1#1', 'l1', 'a1', 'f1']);
    expect(bundle.index.size).toBe(6);
  });
});
