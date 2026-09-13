/** Pure conversion between model curves and the geometry kernel's request data. */
import type { CurveSpec, PlanarFaceRequest } from '@pointercad/kernel';
import { isFullEllipse } from '../sketch/resolveSketch.js';
import type { ResolvedCurve, ResolvedFace } from '../sketch/types.js';


/**
 * 解決済みの曲線をカーネルの言葉へ直す。長さは mm、角度はラジアン(FR-203)。
 *
 * 楕円の角度は解決の段でパラメータ角へ直してあるので、そのまま渡す(§1.4-8)。
 * **全周の楕円は開始角・終了角を渡さない**: カーネルは両方そろっているときだけ
 * 弧として作り、無ければ全周の楕円にする(`makeEllipseEdge.ts` の決め)。
 */
export function toCurveSpec(curve: ResolvedCurve): CurveSpec {
  switch (curve.kind) {
    case 'segment':
      return { kind: 'segment', from: curve.from, to: curve.to };
    case 'arc':
      return {
        kind: 'arc',
        center: curve.center,
        normal: curve.normal,
        xAxis: curve.xAxis,
        radius: curve.radius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'ellipse':
      if (isFullEllipse(curve)) {
        return {
          kind: 'ellipse',
          center: curve.center,
          normal: curve.normal,
          majorAxis: curve.majorAxis,
          majorRadius: curve.majorRadius,
          minorRadius: curve.minorRadius,
        };
      }
      return {
        kind: 'ellipse',
        center: curve.center,
        normal: curve.normal,
        majorAxis: curve.majorAxis,
        majorRadius: curve.majorRadius,
        minorRadius: curve.minorRadius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'spline':
      return {
        kind: 'spline',
        mode: curve.mode,
        points: curve.points,
        closed: curve.closed,
        ...(curve.degree === undefined ? {} : { degree: curve.degree }),
      };
  }
}

/** 面 1 枚の依頼を作る。結果との対応づけには面フィーチャーの id を使う。 */
export function toFaceRequest(face: ResolvedFace): PlanarFaceRequest {
  return { id: face.featureId, curves: face.curves.map((curve) => toCurveSpec(curve)) };
}

/** 全周(ラジアン)。カーネルが角度を省いた楕円は全周の意味になる。 */
const FULL_TURN = 2 * Math.PI;

/**
 * カーネルから返った曲線を model の言葉へ直す(FR-321、P4 タスク15)。`toCurveSpec` の逆。
 *
 * `featureId` は結果を持つフィーチャー(オフセット)の id を付ける。オフセットが返すのは
 * 線分と円弧だけ(`makeOffsetWire.ts`)だが、型の上では 4 種すべて来うるので全部を受ける。
 * B スプラインが返る道(将来の投影・交差)では、曲線の式ではなく**点列**として受ける
 * (`ResolvedSpline` は通過点・制御点しか持たない、`types.ts` の注釈)。
 * 全周の楕円は角度が省かれて返るので、0 から 1 周ぶんとして読む(`toCurveSpec` の裏返し)。
 */
export function fromCurveSpec(spec: CurveSpec, featureId: string): ResolvedCurve {
  switch (spec.kind) {
    case 'segment':
      return { kind: 'segment', featureId, from: spec.from, to: spec.to };
    case 'arc':
      return {
        kind: 'arc',
        featureId,
        center: spec.center,
        normal: spec.normal,
        xAxis: spec.xAxis,
        radius: spec.radius,
        startAngle: spec.startAngle,
        endAngle: spec.endAngle,
      };
    case 'ellipse':
      return {
        kind: 'ellipse',
        featureId,
        center: spec.center,
        normal: spec.normal,
        majorAxis: spec.majorAxis,
        majorRadius: spec.majorRadius,
        minorRadius: spec.minorRadius,
        startAngle: spec.startAngle ?? 0,
        endAngle: spec.endAngle ?? FULL_TURN,
      };
    case 'spline':
      return {
        kind: 'spline',
        featureId,
        mode: spec.mode,
        points: spec.points,
        closed: spec.closed,
        ...(spec.degree === undefined ? {} : { degree: spec.degree }),
      };
  }
}
