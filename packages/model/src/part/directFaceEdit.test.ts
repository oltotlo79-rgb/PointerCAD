import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { ResolvedSubShape } from '../geometry/planeSpec.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import {
  checkFaceOffset,
  createFaceOffsetFeature,
  FACE_OFFSET_DISTANCE_MESSAGE,
  FACE_OFFSET_KIND,
  FACE_OFFSET_NOT_FACE_MESSAGE,
  FACE_OFFSET_NOT_PLANAR_MESSAGE,
  FACE_OFFSET_OTHER_BODY_MESSAGE,
  faceOffsetKeyMaterial,
  faceOffsetKeyText,
  faceOffsetPlan,
  reevaluateFaceOffset,
  withFaceOffsetDistance,
  withFaceOffsetFace,
  type FaceOffsetFeature,
} from './directFaceEdit.js';

/** 式を評価した値。評価できない式は検査の前提が崩れているので落とす。 */
function expression(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`式を評価できません: ${source}`);
  return result.value;
}

/** 立ち上がりの上面(z=40、法線 +Z、面積 320)を指す保存参照。 */
const TOP_FACE: SubShapeRef = {
  bodyFeatureId: 'imported-bracket',
  index: 4,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 320, position: [4, 20, 40], axis: [0, 0, 1], radius: null },
};

const HOLE_FACE: SubShapeRef = {
  bodyFeatureId: 'imported-bracket',
  index: 8,
  fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 201.06192982974676, position: [45, 20, 4],
    axis: [0, 0, 1], radius: 4 },
};

function plane(reference: SubShapeRef): ResolvedSubShape | null {
  if (reference.fingerprint.kind !== 'face') return null;
  return { kind: 'face', position: reference.fingerprint.position, axis: reference.fingerprint.axis,
    surfaceKind: reference.fingerprint.surfaceKind, curveKind: null };
}

function feature(offset = '5'): FaceOffsetFeature {
  return createFaceOffsetFeature({ id: 'face-offset-1', name: '面の移動 1', targetFeatureId: 'imported-bracket',
    face: TOP_FACE, offset: expression(offset) });
}

describe('平らな面の移動(EX-18、model の保存形と解決前の検査)', () => {
  it('保存形は面の参照と距離の式だけを持ち、JSON の往復で同じになる', () => {
    const saved = feature('-2.5');
    expect(saved.kind).toBe(FACE_OFFSET_KIND);
    expect(saved.offset.source).toBe('-2.5');
    expect(saved.offset.value).toBe(-2.5);
    const reopened = JSON.parse(JSON.stringify(saved)) as unknown;
    expect(reopened).toEqual(saved);
    expect(Object.keys(saved).sort()).toEqual(['face', 'id', 'kind', 'name', 'offset', 'suppressed', 'targetFeatureId']);
  });

  it('正・負の距離は通り、計画は評価済みの mm と同じ参照を持つ', () => {
    for (const source of ['5', '-5', '12.5']) {
      const input = feature(source);
      const check = checkFaceOffset(input, plane);
      expect(check).toEqual({ ok: true, offset: Number(source) });
      if (!check.ok) continue;
      const planned = faceOffsetPlan(input, 'key:bracket', check.offset);
      expect(planned).toEqual({ kind: FACE_OFFSET_KIND, targetKey: 'key:bracket', face: TOP_FACE, offset: Number(source) });
    }
  });

  it.each(['0', '0.0000000001'])('距離 %s は動かさないので断る', (source) => {
    expect(checkFaceOffset(feature(source), plane))
      .toEqual({ ok: false, code: 'invalidValue', message: FACE_OFFSET_DISTANCE_MESSAGE });
  });

  it('評価できなかった式(値が NaN)は断る', () => {
    const broken = withFaceOffsetDistance(feature(), { source: '幅 +', value: Number.NaN, display: '' });
    expect(checkFaceOffset(broken, plane))
      .toEqual({ ok: false, code: 'invalidValue', message: FACE_OFFSET_DISTANCE_MESSAGE });
  });

  it('平らでない面(穴の円柱面)、面でない参照、別の立体の面は断る', () => {
    expect(checkFaceOffset(withFaceOffsetFace(feature(), HOLE_FACE), plane))
      .toEqual({ ok: false, code: 'degenerate', message: FACE_OFFSET_NOT_PLANAR_MESSAGE });
    const vertex: SubShapeRef = { bodyFeatureId: 'imported-bracket', index: 0,
      fingerprint: { kind: 'vertex', position: [0, 0, 0] } };
    expect(checkFaceOffset(withFaceOffsetFace(feature(), vertex), plane))
      .toEqual({ ok: false, code: 'invalidValue', message: FACE_OFFSET_NOT_FACE_MESSAGE });
    expect(checkFaceOffset(withFaceOffsetFace(feature(), { ...TOP_FACE, bodyFeatureId: 'other' }), plane))
      .toEqual({ ok: false, code: 'invalidValue', message: FACE_OFFSET_OTHER_BODY_MESSAGE });
  });

  it('今の形で選び直せない参照はここでは通し、カーネルの「見つかりません」に任せる', () => {
    expect(checkFaceOffset(feature(), () => null)).toEqual({ ok: true, offset: 5 });
  });

  it('寸法の編集: 距離の式を写し直すと値と鍵が変わり、面の参照と id は変わらない', () => {
    const before = feature('5');
    const after = reevaluateFaceOffset(before, () => expression('10'));
    expect(after.offset.value).toBe(10);
    expect(after.face).toBe(before.face);
    expect(after.id).toBe(before.id);
    expect(after.targetFeatureId).toBe(before.targetFeatureId);

    const keyNumber = (value: number): string => String(value);
    const text = (input: FaceOffsetFeature): string => {
      const check = checkFaceOffset(input, plane);
      if (!check.ok) throw new Error(check.message);
      return faceOffsetKeyText(faceOffsetKeyMaterial(faceOffsetPlan(input, 'key:bracket', check.offset),
        (reference) => `face#${reference.index}`), keyNumber);
    };
    expect(text(before)).toBe('faceOffset{targetKey=key:bracket;face=face#4;offset=5}');
    expect(text(after)).toBe('faceOffset{targetKey=key:bracket;face=face#4;offset=10}');
    expect(text(withFaceOffsetDistance(before, expression('5')))).toBe(text(before));
  });

  it('取り消し(Undo)の材料: 差し替えは新しい値を返し、元のフィーチャーを変えない', () => {
    const original = feature('5');
    const snapshot = JSON.stringify(original);
    withFaceOffsetDistance(original, expression('-3'));
    withFaceOffsetFace(original, HOLE_FACE);
    reevaluateFaceOffset(original, () => expression('7'));
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
