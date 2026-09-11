import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { ResolvedArc, ResolvedCurve, ResolvedFace } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { profileFlangePanel } from './profileFlange.js';
import { resolveSheetFlange, type ResolvedSheetBody } from './resolveSheetGeometry.js';
import { sheetShapeKey } from './shapeKey.js';
import type { SheetFlangeFeature, SheetFlangeProfile } from './types.js';

const edgeId = (id: string) => JSON.stringify(['sheet-edge', id, 0]);
function polygon(points: readonly Vec3[], prefix: string): readonly ResolvedCurve[] {
  return points.map((from, i) => ({ kind: 'segment', featureId: `${prefix}${i}`, from, to: points[(i + 1) % points.length] }));
}
const outline: ResolvedFace = { featureId: 'outline', color: '#ffffff',
  curves: polygon([[10, 10, 0], [60, 10, 0], [50, 30, 0], [20, 30, 0]], 'side') };
const hole: ResolvedArc = { kind: 'arc', featureId: 'circle', center: [35, 20, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 2, startAngle: 0, endAngle: Math.PI * 2 };
const profile: SheetFlangeProfile = { face: { sketchId: 'profile', faceFeatureId: 'outline' }, baselineId: edgeId('side0'),
  holes: [{ sketchId: 'profile', faceFeatureId: 'hole' }] };
const face = (reference: { readonly faceFeatureId: string }): ResolvedFace | undefined => reference.faceFeatureId === 'outline' ? outline
  : reference.faceFeatureId === 'hole' ? { featureId: 'hole', color: '#ffffff', curves: [hole] } : undefined;
const frame = { origin: [0, 30, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } as const;
const source: ResolvedSheetBody = { rootFeatureId: 'base', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) }, bends: [],
  panels: [{ id: 'base-panel', normal: [0, 0, 1], holes: [], outer: polygon([[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]], 'base') }] };
const feature: SheetFlangeFeature = { kind: 'sheetFlange', id: 'flange', name: '任意フランジ', suppressed: false, targetFeatureId: 'base',
  edges: [{ panelId: 'base-panel', boundaryId: edgeId('base2') }], profile, length: n(1), angle: n(90), lengthBasis: 'outer',
  startOffset: n(0), endOffset: n(0), rule: { innerRadius: null, kFactor: null } };

describe('P10 任意輪郭の基準縁・剛体配置・更新', () => {
  it.each([90, -90, 0])('%d°でも台形の各頂点・穴の半径と位置を厳密な曲線として保つ', (angle) => {
    const result = profileFlangePanel('flange', 'top', profile, face, frame, 50, 2, 3, angle);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message);
    const points = result.value.panel.outer.map((curve) => { if (curve.kind !== 'segment') throw new Error('台形は線分'); return curve.from; });
    const expected = angle === 90 ? [[0, 35, 5], [50, 35, 5], [40, 35, 25], [10, 35, 25]]
      : angle === -90 ? [[0, 33, -3], [50, 33, -3], [40, 33, -23], [10, 33, -23]]
        : [[0, 30, 0], [50, 30, 0], [40, 50, 0], [10, 50, 0]];
    points.forEach((point, i) => point.forEach((value, j) => expect(value).toBeCloseTo(expected[i][j], 10)));
    const mapped = result.value.panel.holes[0][0]; if (mapped.kind !== 'arc') throw new Error('穴は円');
    expect(mapped.radius).toBe(2); expect(mapped.endAngle).toBe(Math.PI * 2);
    expect(mapped.center[0]).toBe(25); expect(outline.curves[0]).toMatchObject({ from: [10, 10, 0] });
  });
  it('基準縁の欠落・幅の不一致・穴の欠落を断り、寸法を黙って合わせない', () => {
    const mismatch = profileFlangePanel('f', 'e', profile, face, frame, 49, 2, 3, 90);
    expect(mismatch.ok).toBe(false); if (mismatch.ok) throw new Error('幅の不一致を断る必要があります');
    expect(mismatch.message).toContain('拡縮');
    expect(profileFlangePanel('f', 'e', { ...profile, baselineId: 'missing' }, face, frame, 50, 2, 3, 90).ok).toBe(false);
    expect(profileFlangePanel('f', 'e', profile, (ref) => ref.faceFeatureId === 'hole' ? undefined : face(ref), frame, 50, 2, 3, 90).ok).toBe(false);
  });
  it('円・楕円・スプラインの穴を回転しても方式・径数・通過点を保持する', () => {
    const curves: readonly ResolvedCurve[] = [hole,
      { kind: 'ellipse', featureId: 'ellipse', center: [35, 20, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0], majorRadius: 4, minorRadius: 2, startAngle: 0, endAngle: Math.PI * 2 },
      { kind: 'spline', featureId: 'spline', mode: 'interpolate', closed: true, points: [[30, 15, 0], [40, 15, 0], [40, 25, 0], [30, 25, 0]] }];
    for (const curve of curves) {
      const result = profileFlangePanel('f', 'e', profile, (ref) => ref.faceFeatureId === 'hole' ? { featureId: 'hole', color: '#fff', curves: [curve] } : face(ref), frame, 50, 2, 3, 90);
      if (!result.ok) throw new Error(result.message);
      const transformed = result.value.panel.holes[0][0];
      expect(transformed.kind).toBe(curve.kind);
      if (transformed.kind === 'ellipse') expect(transformed).toMatchObject({ majorRadius: 4, minorRadius: 2, endAngle: Math.PI * 2, majorAxis: [1, 0, 0] });
      if (transformed.kind === 'spline') {
        expect(transformed.mode).toBe('interpolate'); expect(transformed.closed).toBe(true);
        expect(transformed.points[0][0]).toBe(20); expect(transformed.points[0][2]).toBeCloseTo(10, 10);
      }
    }
  });
  it('任意輪郭の段を作り、穴・上流の変更は形状鍵へ反映し、非使用の矩形長さは反映しない', () => {
    const first = resolveSheetFlange(feature, source, 'base-key', face);
    const lengthChanged = resolveSheetFlange({ ...feature, length: n(100) }, source, 'base-key', face);
    const holeChanged = resolveSheetFlange(feature, source, 'base-key', (ref) => ref.faceFeatureId === 'hole'
      ? { featureId: 'hole', color: '#fff', curves: [{ ...hole, radius: 3 }] } : face(ref));
    if (!first.ok || !lengthChanged.ok || !holeChanged.ok) throw new Error('台形を解決できません');
    expect(first.value.plan).toMatchObject({ kind: 'sheetFlange', flanges: [{ kind: 'profile', holes: [[{ kind: 'arc', radius: 2 }]] }] });
    expect(sheetShapeKey(first.value.plan)).toBe(sheetShapeKey(lengthChanged.value.plan));
    expect(sheetShapeKey(first.value.plan)).not.toBe(sheetShapeKey(holeChanged.value.plan));
    expect(first.value.body.bends[0].allowance).toBeCloseTo(5.969026041821, 10);
    expect(resolveSheetFlange(feature, first.value.body, 'next', face).ok).toBe(false);
  });
});
