/**
 * 計算部の段の失敗のうち、文ではなく種類で見分ける物の符号(0b-1)。
 * - missingSubShape: 加工のもとの面・辺・頂点が見つからない(形が大きく変わった。model が PartError の missingSubShape にする)。
 * - nothingLeft: 演算の結果に立体が残らない(加工ごとの言い回しへ包み直す所が、この符号で見分ける)。
 * 文(message)は今までどおり、利用者へそのまま見せる日本語。文で種類を見分けない(文を直しただけで、種類が黙って変わるため)。
 */
export type KernelStepFailureCode = 'missingSubShape' | 'nothingLeft';

/** Reasons carried alongside the legacy sketch Worker message. */
type SketchStaticReason =
  | 'faceNoCurves' | 'notConnected' | 'faceOpen' | 'faceNotPlanar' | 'faceSelfIntersection'
  | 'holeBuild' | 'holeArea' | 'segmentEdge' | 'arcEdge'
  | 'offsetNoCurves' | 'offsetDistance' | 'offsetInside' | 'offsetBuild' | 'offsetEmpty' | 'offsetCurve';

export type SketchGeometryReason =
  | { readonly code: SketchStaticReason }
  | { readonly code: 'holeNotPlanar' | 'holeIntersection' | 'holeOutside' | 'holeNested'; readonly index: string }
  | { readonly code: 'arcRadius'; readonly radius: string }
  | { readonly code: 'internal' };

type SketchInputReason = Exclude<SketchGeometryReason, { readonly code: 'internal' }>;

// Shared geometry callers still receive an ordinary Error with the original message.
const sketchInputReasons = new WeakMap<Error, SketchInputReason>();

export function sketchInputError(reason: SketchInputReason, message: string): Error {
  const error = new Error(message);
  sketchInputReasons.set(error, reason);
  return error;
}

export function sketchInputReason(error: Error): SketchInputReason | undefined {
  return sketchInputReasons.get(error);
}

/** 符号を持つ計算部の段の誤り(makeSurfaceCut.ts の SurfaceCutError と同じ形)。Worker が符号を SolidStepFailure へ写す。 */
export class KernelStepError extends Error {
  constructor(readonly code: KernelStepFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KernelStepError';
  }
}

/** 演算の結果に立体が残らなかった誤りか(包み直す所が、文ではなくこれで見分ける)。 */
export function isNothingLeft(error: unknown): boolean {
  return error instanceof KernelStepError && error.code === 'nothingLeft';
}
