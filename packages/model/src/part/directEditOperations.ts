import type { ExpressionValue } from '@pointercad/expression';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import type { SolidFeatureBase } from './featureIdentity.js';
import { fingerprintKeyText } from './subShapeRef.js';

/** 世界座標の mm。対象は一定径の貫通穴が一つある長方形板に限る。 */
export interface HoleTranslateFeature extends SolidFeatureBase {
  readonly kind: 'holeTranslate';
  readonly targetFeatureId: string;
  readonly face: SubShapeRef;
  readonly translation: readonly [ExpressionValue, ExpressionValue, ExpressionValue];
}

/** 保存角度は度。箱の支持平面を所属辺まわりに回し、隣接面で切り直す。 */
export interface FaceRotateFeature extends SolidFeatureBase {
  readonly kind: 'faceRotate';
  readonly targetFeatureId: string;
  readonly face: SubShapeRef;
  readonly hinge: SubShapeRef;
  readonly angle: ExpressionValue;
}

export interface HoleTranslatePlan {
  readonly kind: 'holeTranslate';
  readonly targetKey: string;
  readonly face: SubShapeRef;
  readonly translation: readonly [number, number, number];
}

export interface FaceRotatePlan {
  readonly kind: 'faceRotate';
  readonly targetKey: string;
  readonly face: SubShapeRef;
  readonly hinge: SubShapeRef;
  /** ラジアン。 */
  readonly angle: number;
}

export interface HoleTranslateKeyMaterial {
  readonly kind: 'holeTranslate';
  readonly targetKey: string;
  readonly face: string;
  readonly translation: readonly [number, number, number];
}

export interface FaceRotateKeyMaterial {
  readonly kind: 'faceRotate';
  readonly targetKey: string;
  readonly face: string;
  readonly hinge: string;
  readonly angle: number;
}

export function directEditKeyMaterial(plan: HoleTranslatePlan | FaceRotatePlan): HoleTranslateKeyMaterial | FaceRotateKeyMaterial {
  const common = { targetKey: plan.targetKey, face: fingerprintKeyText(plan.face) };
  return plan.kind === 'holeTranslate'
    ? { ...common, kind: plan.kind, translation: plan.translation }
    : { ...common, kind: plan.kind, hinge: fingerprintKeyText(plan.hinge), angle: plan.angle };
}

export function createHoleTranslateFeature(input: Omit<HoleTranslateFeature, 'kind' | 'suppressed'>): HoleTranslateFeature {
  return { ...input, kind: 'holeTranslate', suppressed: false };
}

export function createFaceRotateFeature(input: Omit<FaceRotateFeature, 'kind' | 'suppressed'>): FaceRotateFeature {
  return { ...input, kind: 'faceRotate', suppressed: false };
}

export type DirectEditPlanOutcome =
  | { readonly ok: true; readonly plan: HoleTranslatePlan | FaceRotatePlan }
  | { readonly ok: false; readonly message: string };

/** 現在の実体の照合は worker が行う。保存参照を番号や保存座標で代用しない。 */
export function directEditPlan(feature: HoleTranslateFeature | FaceRotateFeature, targetKey: string): DirectEditPlanOutcome {
  if (feature.face.bodyFeatureId !== feature.targetFeatureId || feature.face.fingerprint.kind !== 'face') {
    return { ok: false, message: '編集する立体に属する面を選んでください。' };
  }
  if (feature.kind === 'holeTranslate') {
    const translation: readonly [number, number, number] = [
      feature.translation[0].value, feature.translation[1].value, feature.translation[2].value,
    ];
    if (!translation.every(Number.isFinite) || Math.hypot(...translation) < 1e-6) {
      return { ok: false, message: '穴の移動量は 0 でない有限のベクトルで指定してください。' };
    }
    return { ok: true, plan: { kind: feature.kind, targetKey, face: feature.face, translation } };
  }
  if (feature.hinge.bodyFeatureId !== feature.targetFeatureId || feature.hinge.fingerprint.kind !== 'edge') {
    return { ok: false, message: '回転の軸には、編集する立体に属する辺を選んでください。' };
  }
  const angle = feature.angle.value * Math.PI / 180;
  if (!Number.isFinite(angle) || angle === 0) {
    return { ok: false, message: '面の回転角度は 0 でない有限の数で指定してください。' };
  }
  return { ok: true, plan: { kind: feature.kind, targetKey, face: feature.face, hinge: feature.hinge, angle } };
}
