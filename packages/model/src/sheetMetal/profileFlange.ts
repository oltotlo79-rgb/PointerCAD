/** スケッチの基準縁を接線面へ剛体配置する。半径・径数角・スプラインの方式を保持する。 */
import { exceedsMagnitude } from '../numericTolerance.js';
import type { SketchFaceRef } from '../part/featureReferences.js';
import { curveSamplePoints } from '../sketch/curvePlaneSamples.js';
import { fitPlaneNormal } from '../sketch/resolveSketch.js';
import type { ResolvedCurve, ResolvedFace } from '../sketch/types.js';
import { crossVec3, distanceVec3, normalizeVec3, subVec3 } from '../sketch/vec3.js';
import { sheetPanelId } from './featureInputs.js';
import { flangeEndFrame, sheetBoundaryEdges, type RectangularFlangeGeometry, type SheetGeometryResult, type SheetPanelGeometry, type SheetTangentFrame } from './panelGeometry.js';
import type { SheetFlangeProfile } from './types.js';
import { rigidSheetCurve } from './rigidCurve.js';

/** 作成画面も保存した基準縁と同じ識別方法で候補を表示する。 */
export function sheetFlangeProfileEdges(face: ResolvedFace) {
  if ((face.holes?.length ?? 0) > 0) return { ok: false as const, message: '穴つきの面はフランジに対応していません。外周と穴を別の面で指定してください。' };
  const normal = fitPlaneNormal(face.curves.flatMap(curveSamplePoints));
  if (normal === null || !normal.every(Number.isFinite))
    return { ok: false as const, message: 'フランジには平らな閉輪郭を選んでください。' };
  return sheetBoundaryEdges({ id: face.featureId, normal, outer: face.curves, holes: [] });
}

export function profileFlangePanel(featureId: string, boundaryId: string, profile: SheetFlangeProfile,
  face: (reference: SketchFaceRef) => ResolvedFace | undefined, frame: SheetTangentFrame,
  width: number, thickness: number, radius: number, angle: number): SheetGeometryResult<RectangularFlangeGeometry> {
  const outer = face(profile.face);
  if (outer === undefined) return { ok: false, message: 'フランジの輪郭が見つかりません。スケッチの面を選び直してください。' };
  if ((outer.holes?.length ?? 0) > 0) return { ok: false, message: '穴つきの面はフランジに対応していません。外周と穴を別の面で指定してください。' };
  const normal = fitPlaneNormal(outer.curves.flatMap(curveSamplePoints));
  if (normal === null || !normal.every(Number.isFinite)) return { ok: false, message: 'フランジには平らな閉輪郭を選んでください。' };
  const holes: (readonly ResolvedCurve[])[] = [];
  for (const reference of profile.holes) {
    const hole = face(reference);
    if (hole === undefined) return { ok: false, message: 'フランジの穴の輪郭が見つかりません。穴の面を選び直してください。' };
    if ((hole.holes?.length ?? 0) > 0) return { ok: false, message: 'フランジの穴には穴つきの面を使えません。穴のない面を指定してください。' };
    holes.push(hole.curves);
  }
  const sourcePanel: SheetPanelGeometry = { id: outer.featureId, normal, outer: outer.curves, holes };
  const edges = sheetBoundaryEdges(sourcePanel); if (!edges.ok) return edges;
  const baseline = edges.value.find((edge) => edge.id === profile.baselineId);
  if (baseline === undefined) return { ok: false, message: '任意輪郭の基準となる直線縁を選び直してください。' };
  if (!Number.isFinite(width) || width <= 1e-7 || exceedsMagnitude(distanceVec3(baseline.from, baseline.to) - width, 1e-7))
    return { ok: false, message: '輪郭の基準縁の長さを、端の距離を引いたフランジの幅と一致させてください。輪郭は拡縮されません。' };
  const xAxis = normalizeVec3(subVec3(baseline.to, baseline.from));
  const source: SheetTangentFrame = { origin: baseline.from, xAxis, yAxis: crossVec3(normal, xAxis), normal };
  const end = flangeEndFrame(frame, thickness, radius, angle); if (!end.ok) return end;
  const mappedOuter = outer.curves.map((curve) => rigidSheetCurve(curve, source, end.value));
  const mappedHoles = holes.map((loop) => loop.map((curve) => rigidSheetCurve(curve, source, end.value)));
  if (![...mappedOuter, ...mappedHoles.flat()].flatMap(curveSamplePoints).flat().every(Number.isFinite))
    return { ok: false, message: 'フランジの座標が扱える範囲を超えています。' };
  return { ok: true, value: { panel: { id: sheetPanelId(featureId, boundaryId), normal: end.value.normal, outer: mappedOuter, holes: mappedHoles },
    tangentFrame: frame, endFrame: end.value, width } };
}
