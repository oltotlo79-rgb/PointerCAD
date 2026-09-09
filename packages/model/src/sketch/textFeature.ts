import { outlineCurves, type OutlinedText } from '@pointercad/drawing';
import { addExpression, multiplyExpression, exactExpressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import type { WorkPlane } from './planeMath.js';
import type { CoordinateInput, SketchLineFeature, SketchSplineFeature } from './types.js';
import type { Vec3 } from './vec3.js';

export interface TextFeatureInput {
  readonly idPrefix: string;
  readonly name: string;
  readonly text: string;
  readonly height: ExpressionValue;
  readonly angleDegrees: number;
  readonly align: 'start' | 'middle' | 'end';
  /** 文字の原点のワールド座標。文字列と別に数式を保つ。 */
  readonly origin: readonly [ExpressionValue, ExpressionValue, ExpressionValue];
  readonly plane: WorkPlane;
  readonly outlineText: (text: string, sizeMm: number) => OutlinedText;
}
export type TextFeatureResult = {
  readonly ok: true;
  readonly features: readonly (SketchLineFeature | SketchSplineFeature)[];
  readonly contours: readonly { readonly featureIds: readonly string[]; readonly signedArea: number }[];
} | { readonly ok: false; readonly reason: 'invalidInput' | 'fontUnavailable' | 'missingGlyph' | 'invalidOutline' };

/** 元の3次曲線を保ち、高さの式を各座標へ残す。字体解析やカーネルを重複実装しない。 */
export function textFeature(input: TextFeatureInput): TextFeatureResult {
  const { axisU: u, axisV: v, normal } = input.plane;
  const dot = (a: Vec3, b: Vec3): number => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const cross: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  if (input.idPrefix.length === 0 || input.name.length === 0 || !Number.isFinite(input.height.value) || input.height.value <= 0
    || input.height.source.trim().length === 0 || !Number.isFinite(input.angleDegrees)
    || !['start', 'middle', 'end'].includes(input.align) || input.plane.id.length === 0
    || input.origin.some((value) => !Number.isFinite(value.value) || value.source.trim().length === 0)
    || [...u, ...v, ...normal, ...input.plane.origin].some((value) => !Number.isFinite(value))
    || [u, v, normal].some((axis) => Math.abs(dot(axis, axis) - 1) > 1e-8)
    || Math.abs(dot(u, v)) > 1e-8 || cross.some((value, index) => Math.abs(value - normal[index]) > 1e-8)) {
    return { ok: false, reason: 'invalidInput' };
  }
  const originOffset: Vec3 = [input.origin[0].value - input.plane.origin[0],
    input.origin[1].value - input.plane.origin[1], input.origin[2].value - input.plane.origin[2]];
  if (Math.abs(dot(originOffset, normal)) > 1e-7) return { ok: false, reason: 'invalidInput' };
  if (input.text.trim().length === 0) return { ok: true, features: [], contours: [] };
  let outline: OutlinedText;
  try { outline = input.outlineText(input.text, 1); }
  catch { return { ok: false, reason: 'fontUnavailable' }; }
  if (outline.status === 'missingGlyph') return { ok: false, reason: 'missingGlyph' };
  if (outline.status !== 'ready' || outline.metrics === null) return { ok: false, reason: 'fontUnavailable' };
  const sourceContours = outlineCurves(outline.subpaths);
  if (sourceContours === null || !Number.isFinite(outline.metrics.advanceMm) || outline.metrics.advanceMm < 0) {
    return { ok: false, reason: 'invalidOutline' };
  }
  const angle = (input.angleDegrees % 360) * Math.PI / 180;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const xOffset = outline.metrics.advanceMm * (input.align === 'middle' ? -0.5 : input.align === 'end' ? -1 : 0);
  let finiteCoordinates = true;
  const coordinate = (point: Vec3): CoordinateInput => {
    const x = (point[0] + xOffset) * cosine - point[1] * sine;
    const y = (point[0] + xOffset) * sine + point[1] * cosine;
    const axis = (index: number): ExpressionValue => {
      const value = addExpression(input.origin[index],
        multiplyExpression(input.height, exactExpressionValueFromNumber(x * u[index] + y * v[index])));
      if (!Number.isFinite(value.value)) finiteCoordinates = false;
      return value;
    };
    return { mode: 'absolute', x: axis(0), y: axis(1), z: axis(2) };
  };
  const features: (SketchLineFeature | SketchSplineFeature)[] = [];
  const contours: { featureIds: string[]; signedArea: number }[] = [];
  for (const [contourIndex, contour] of sourceContours.entries()) {
    const featureIds: string[] = [];
    for (const [curveIndex, curve] of contour.curves.entries()) {
      const id = `${input.idPrefix}:${contourIndex}:${curveIndex}`;
      const common = { id, name: `${input.name} ${features.length + 1}`, planeId: input.plane.id, construction: false };
      features.push(curve.kind === 'segment' ? { ...common, kind: 'line', from: coordinate(curve.from), to: coordinate(curve.to) }
        : { ...common, kind: 'spline', mode: 'control', closed: false, points: curve.points.map(coordinate) });
      featureIds.push(id);
    }
    const signedArea = contour.signedArea * input.height.value ** 2;
    if (!Number.isFinite(signedArea)) return { ok: false, reason: 'invalidInput' };
    contours.push({ featureIds, signedArea });
  }
  if (!finiteCoordinates) return { ok: false, reason: 'invalidInput' };
  return { ok: true, features, contours };
}
