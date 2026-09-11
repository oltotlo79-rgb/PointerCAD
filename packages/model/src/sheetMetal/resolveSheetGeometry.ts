/** 板金の保存入力から、折曲げ形状の段と展開用パネルを同時に導出する。 */
import type { SketchFaceRef } from '../part/featureReferences.js';
import { curveSamplePoints } from '../sketch/curvePlaneSamples.js';
import { fitPlaneNormal } from '../sketch/resolveSketch.js';
import type { ResolvedCurve, ResolvedFace } from '../sketch/types.js';
import { addVec3, scaleVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetBendMetrics, sheetStraightLength } from './bendAllowance.js';
import { resolveSheetRule, sheetPanelId } from './featureInputs.js';
import { rectangularFlangePanel, sheetTangentFrame, type SheetGeometryResult, type SheetPanelGeometry, type SheetTangentFrame } from './panelGeometry.js';
import type { SheetBaseFeature, SheetFlangeFeature, SheetMetalRule } from './types.js';
import { profileFlangePanel } from './profileFlange.js';
import { availableSheetBoundaryEdges } from './availableBoundaryEdges.js';

export interface SheetBasePlan {
  readonly kind: 'sheetBase';
  readonly outer: readonly ResolvedCurve[]; readonly holes: readonly (readonly ResolvedCurve[])[];
  readonly thickness: number; readonly normal: Vec3; readonly reversed: boolean;
}
interface SheetFlangeGeometryBase {
  readonly frame: SheetTangentFrame; readonly width: number;
  readonly thickness: number; readonly radius: number; readonly angle: number;
}
export type SheetFlangeGeometryInput = SheetFlangeGeometryBase & (
  { readonly kind: 'rectangle'; readonly secondLength: number }
  | { readonly kind: 'profile'; readonly outer: readonly ResolvedCurve[]; readonly holes: readonly (readonly ResolvedCurve[])[] });
export interface SheetFlangePlan {
  readonly kind: 'sheetFlange'; readonly targetKey: string;
  readonly flanges: readonly SheetFlangeGeometryInput[];
}
/** 展開パネルの結合。通常の和と異なり、食込みと分離を成功にしない。 */
export interface SheetJoinPlan { readonly kind: 'sheetJoin'; readonly targetKey: string; readonly toolKey: string }
export type SheetBodyBendGeometry = (SheetFlangeGeometryBase & { readonly kind: 'rectangle' })
  | (Omit<SheetFlangeGeometryBase, 'width'> & { readonly kind: 'profile'; readonly neutralRadius: number;
    readonly outer: readonly ResolvedCurve[]; readonly holes: readonly (readonly ResolvedCurve[])[] });
export interface SheetBodyPlan {
  readonly kind: 'sheetBody'; readonly panels: readonly SheetBasePlan[]; readonly bends: readonly SheetBodyBendGeometry[];
}
export type SheetSolidPlan = SheetBasePlan | SheetFlangePlan | SheetJoinPlan | SheetBodyPlan;
export interface ResolvedSheetBend {
  readonly id: string; readonly parentPanelId: string; readonly childPanelId: string;
  readonly parallelGroupId?: string;
  /** 一本の曲げ帯が複数パネルをつなぐ場合も、実材料はこのIDごとに一度だけ作る。 */
  readonly materialId?: string;
  readonly parentEdge: { readonly from: Vec3; readonly to: Vec3 };
  readonly childEdge: { readonly from: Vec3; readonly to: Vec3 };
  /** 非矩形の帯の実接触区間。配置用の接線範囲と区別して後続加工の占有を判定する。 */
  readonly parentContacts?: readonly { readonly from: Vec3; readonly to: Vec3 }[];
  readonly childContacts?: readonly { readonly from: Vec3; readonly to: Vec3 }[];
  readonly angle: number; readonly radius: number; readonly kFactor: number; readonly allowance: number;
  readonly frame: SheetTangentFrame; readonly width: number;
  /** 指定線やリリーフの曲げ帯。frame基準のXY展開輪郭、y=0..allowance。未指定は矩形。 */
  readonly flatProfile?: Pick<SheetPanelGeometry, 'outer' | 'holes'>;
}
export interface ResolvedSheetBody {
  readonly rootFeatureId: string; readonly rule: SheetMetalRule;
  /** 加工前の接続IDから現在の実接続へ。履歴の入力から導出し、ファイルには保存しない。 */
  readonly connectionAliases?: ReadonlyMap<string, readonly string[]>;
  readonly panels: readonly SheetPanelGeometry[]; readonly bends: readonly ResolvedSheetBend[];
}
export interface SheetGeometryPlan { readonly plan: SheetSolidPlan; readonly body: ResolvedSheetBody }
export type SheetFaceResolver = (reference: SketchFaceRef) => ResolvedFace | undefined;

export function resolveSheetBase(feature: SheetBaseFeature, face: SheetFaceResolver): SheetGeometryResult<SheetGeometryPlan> {
  const rule = resolveSheetRule(feature.rule); if (!rule.ok) return rule;
  const profile = face(feature.profile);
  if (profile === undefined) return { ok: false, message: '板金基板の外周が見つかりません。スケッチの面を選び直してください。' };
  const normal = fitPlaneNormal(profile.curves.flatMap(curveSamplePoints));
  if (normal === null || !normal.every(Number.isFinite)) return { ok: false, message: '基板の平面を決められません。平らな閉輪郭を選んでください。' };
  const holes: (readonly ResolvedCurve[])[] = [];
  for (const reference of feature.holes) {
    const hole = face(reference);
    if (hole === undefined) return { ok: false, message: '板金基板の穴の輪郭が見つかりません。穴の面を選び直してください。' };
    holes.push(hole.curves);
  }
  const direction = feature.reversed ? scaleVec3(normal, -1) : normal;
  return { ok: true, value: {
    plan: { kind: 'sheetBase', outer: profile.curves, holes, thickness: rule.rule.thickness, normal, reversed: feature.reversed },
    body: { rootFeatureId: feature.id, rule: feature.rule, bends: [], panels: [{ id: sheetPanelId(feature.id, null), normal: direction, outer: profile.curves, holes }] },
  } };
}

/** 矩形だけを受ける便宜入口。任意輪郭には輪郭の解決元が必須。 */
export function resolveRectangularFlange(feature: SheetFlangeFeature & { readonly profile: null }, source: ResolvedSheetBody, targetKey: string): SheetGeometryResult<SheetGeometryPlan> {
  return resolveSheetFlange(feature, source, targetKey, () => undefined);
}

export function resolveSheetFlange(feature: SheetFlangeFeature, source: ResolvedSheetBody, targetKey: string, face: SheetFaceResolver): SheetGeometryResult<SheetGeometryPlan> {
  const rule = resolveSheetRule(source.rule, feature.rule); if (!rule.ok) return rule;
  const angle = feature.angle.value;
  const metrics = sheetBendMetrics({ ...rule.rule, angle });
  if (!metrics.ok) return { ok: false, message: '曲げ角と板金の条件を確認してください。曲げ角は-180°より大きく180°未満で指定します。' };
  const length = feature.profile === null ? sheetStraightLength(feature.length.value, feature.lengthBasis, metrics.metrics) : 0;
  if (length === null) return { ok: false, message: 'フランジの長さが曲げ部分より短くなっています。長さか寸法の基準を変更してください。' };
  const identities = feature.edges.map((edge) => JSON.stringify([edge.panelId, edge.boundaryId]));
  if (identities.length === 0 || new Set(identities).size !== identities.length) return { ok: false, message: 'フランジの縁を重複なく1本以上選んでください。' };
  const panels = [...source.panels], bends = [...source.bends], flanges: SheetFlangeGeometryInput[] = [];
  // 選択順で幾何のIDや実カーネルの演算順が変わらないよう、安定参照で揃える。
  const ordered = [...feature.edges].sort((a, b) => {
    const first = JSON.stringify([a.panelId, a.boundaryId]), second = JSON.stringify([b.panelId, b.boundaryId]);
    return first < second ? -1 : first > second ? 1 : 0;
  });
  for (const reference of ordered) {
    const panel = source.panels.find((item) => item.id === reference.panelId);
    if (panel === undefined) return { ok: false, message: 'フランジの元のパネルが見つかりません。板金の縁を選び直してください。' };
    const tangent = sheetTangentFrame(panel, reference.boundaryId, feature.startOffset.value, feature.endOffset.value);
    if (!tangent.ok) return tangent;
    const available = availableSheetBoundaryEdges(source, panel.id); if (!available.ok) return available;
    if (!available.value.some((edge) => edge.id === reference.boundaryId))
      return { ok: false, message: 'この縁にはすでに曲げがあります。別の縁を選んでください。' };
    const { frame, width } = tangent.value;
    const boundaryId = JSON.stringify([reference.panelId, reference.boundaryId]);
    const child = feature.profile === null
      ? rectangularFlangePanel(feature.id, boundaryId, frame, width, length, rule.rule.thickness, rule.rule.radius, angle)
      : profileFlangePanel(feature.id, boundaryId, feature.profile, face, frame, width, rule.rule.thickness, rule.rule.radius, angle);
    if (!child.ok) return child;
    const parentTo = frame.origin, parentFrom = addVec3(parentTo, scaleVec3(frame.xAxis, width));
    const childFrom = child.value.endFrame.origin, childTo = addVec3(childFrom, scaleVec3(frame.xAxis, width));
    panels.push(child.value.panel);
    bends.push({ id: JSON.stringify(['sheet-bend', reference.panelId, reference.boundaryId]), parentPanelId: panel.id, childPanelId: child.value.panel.id,
      parentEdge: { from: parentFrom, to: parentTo }, childEdge: { from: childFrom, to: childTo },
      angle, radius: rule.rule.radius, kFactor: rule.rule.kFactor, allowance: metrics.metrics.bendAllowance, frame, width });
    const common = { frame, width, thickness: rule.rule.thickness, radius: rule.rule.radius, angle };
    flanges.push(feature.profile === null ? { ...common, kind: 'rectangle', secondLength: length }
      : { ...common, kind: 'profile', outer: child.value.panel.outer, holes: child.value.panel.holes });
  }
  return { ok: true, value: { plan: { kind: 'sheetFlange', targetKey, flanges }, body: { ...source, panels, bends } } };
}
