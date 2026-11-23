/**
 * 認識した板金(M-08)を、既存の展開・後続の加工が受け取る ResolvedSheetBody と、組み直しの計画へ写す。
 * 曲げの座標(frame)は計算部の曲げの作り方(makeSheetMetalBend.ts の buildBend)と同じ約束: normal は親の板の
 * 板厚の向き、origin は親の始点側の面の接線の端、xAxis は接線(幅)、yAxis は親の板から曲げへ向かう面内の向き。
 * 角度は始点側の面が曲げの外側なら正(認識の angleDegrees と同じ符号)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import type { SheetMetalRecognizedBend, SheetMetalRecognizedRim } from '@pointercad/kernel';
import { belowMagnitude } from '../numericTolerance.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, addVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetBendMetrics } from './bendAllowance.js';
import { resolvedSheetBodyPlan } from './bodyPlan.js';
import { resolveSheetRule, sheetPanelId } from './featureInputs.js';
import type { SheetPanelGeometry, SheetTangentFrame } from './panelGeometry.js';
import type { ResolvedSheetBend, ResolvedSheetBody, SheetBodyPlan } from './resolveSheetGeometry.js';
import { sheetConvertKeys, type RecognizedSheet, type SheetConvertOrigins, type SheetConvertPanelKeys } from './sheetConvertIdentity.js';
import type { SheetConvertFeature } from './types.js';

/** 認識の後に変換できなかった理由。認識そのものの理由(計算部の符号)とは別に持つ。 */
export type SheetConvertFailure = 'invalidRule' | 'unsupportedConnection' | 'unsupportedBend';
export type SheetConvertResult = { readonly ok: true; readonly plan: SheetBodyPlan; readonly body: ResolvedSheetBody }
  | { readonly ok: false; readonly reason: SheetConvertFailure };

/** 面内の向きを単位にする時、これより短いものは向きが決まらないとして断る(mm)。 */
const DIRECTION_LENGTH_MM = 1e-9;

function rimCurve(rim: SheetMetalRecognizedRim, featureId: string): ResolvedCurve {
  return { ...rim.curve, featureId };
}
function midpoint(from: Vec3, to: Vec3): Vec3 {
  return scaleVec3(addVec3(from, to), 0.5);
}
function samePoint(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

type Tangent = SheetMetalRecognizedBend['fromTangent'];
type ContactEdge = ResolvedSheetBend['parentEdge'];
/** 曲げの座標と、親・子の板との境の縁。 */
interface BendContact { readonly frame: SheetTangentFrame; readonly parentEdge: ContactEdge; readonly childEdge: ContactEdge }

/** 接線の 2 端を、向き axis の座標の小さい端・大きい端の順に返す。 */
function alongAxis(tangent: Tangent, axis: Vec3): readonly [Vec3, Vec3] {
  return dotVec3(subVec3(tangent.to, tangent.from), axis) > 0 ? [tangent.from, tangent.to] : [tangent.to, tangent.from];
}

/**
 * 曲げの座標と縁の向きを決める 1 か所(認識の接線がどちら向きでも同じ答え)。yAxis は親の接線から子の側の接線へ
 * 向かう面内の向き(0 < 角度 < 180° なら面内の成分は正)、xAxis = yAxis × normal、origin は親の接線の xAxis の小さい端。
 * 縁の向きはフランジの道具(resolveSheetGeometry.ts の resolveSheetFlange)と同じ: 親の縁は大きい端 → origin(親の板の
 * 境界の向き)、子の縁は小さい端 → 大きい端。展開(panelGraph.ts の flattenSheetPanelGraph)は 2 本を逆向きとして子を置く。
 */
function bendContact(bend: SheetMetalRecognizedBend, normal: Vec3): BendContact | null {
  const { fromTangent: from, toTangent: to } = bend;
  const along = subVec3(from.to, from.from), length = lengthVec3(along);
  if (belowMagnitude(length, DIRECTION_LENGTH_MM)) return null;
  const line = scaleVec3(along, 1 / length), toward = subVec3(midpoint(to.from, to.to), midpoint(from.from, from.to));
  const inPlane = subVec3(subVec3(toward, scaleVec3(normal, dotVec3(toward, normal))), scaleVec3(line, dotVec3(toward, line)));
  const size = lengthVec3(inPlane);
  if (belowMagnitude(size, DIRECTION_LENGTH_MM)) return null;
  const yAxis = scaleVec3(inPlane, 1 / size), xAxis = crossVec3(yAxis, normal);
  const [low, high] = alongAxis(from, xAxis), [childLow, childHigh] = alongAxis(to, xAxis);
  return { frame: { origin: low, xAxis, yAxis, normal }, parentEdge: { from: high, to: low }, childEdge: { from: childLow, to: childHigh } };
}

/** 親の板の輪郭のうち、曲げの接線と同じ端の辺の鍵(曲げの id に使う)。 */
function tangentRimKey(parent: SheetConvertPanelKeys, bend: SheetMetalRecognizedBend): string | undefined {
  const rims = [...parent.panel.outer.map((rim, i) => ({ rim, key: parent.outer[i] })),
    ...parent.panel.holes.flatMap((loop, j) => loop.map((rim, i) => ({ rim, key: parent.holes[j][i] })))];
  const { from, to } = bend.fromTangent;
  return rims.find(({ rim }) => rim.curve.kind === 'segment'
    && ((samePoint(rim.curve.from, from) && samePoint(rim.curve.to, to)) || (samePoint(rim.curve.from, to) && samePoint(rim.curve.to, from))))?.key;
}

export function resolveSheetConvert(feature: SheetConvertFeature, sheet: RecognizedSheet, origins: SheetConvertOrigins): SheetConvertResult {
  const rule = { thickness: expressionValueFromNumber(sheet.thickness), innerRadius: feature.rule.innerRadius, kFactor: feature.rule.kFactor };
  const values = resolveSheetRule(rule);
  if (!values.ok) return { ok: false, reason: 'invalidRule' };
  const keyed = sheetConvertKeys(sheet, origins);
  if (keyed === null) return { ok: false, reason: 'unsupportedConnection' };
  const byFace = new Map(keyed.map(entry => [entry.panel.faceIndex, { ...entry, id: sheetPanelId(feature.id, entry.key) }]));
  const panels: SheetPanelGeometry[] = keyed.map(({ panel, key, outer, holes }) => ({ id: sheetPanelId(feature.id, key), normal: panel.inward,
    outer: panel.outer.map((rim, i) => rimCurve(rim, outer[i])), holes: panel.holes.map((loop, j) => loop.map((rim, i) => rimCurve(rim, holes[j][i]))) }));
  const bends: ResolvedSheetBend[] = [];
  for (const child of keyed.slice(1)) {
    const bend = sheet.bends.find(item => item.toFaceIndex === child.panel.faceIndex);
    const parent = bend === undefined ? undefined : byFace.get(bend.fromFaceIndex);
    if (bend === undefined || parent === undefined) return { ok: false, reason: 'unsupportedConnection' };
    const contact = bendContact(bend, parent.panel.inward), rimKey = tangentRimKey(parent, bend);
    if (contact === null || rimKey === undefined) return { ok: false, reason: 'unsupportedBend' };
    const metrics = sheetBendMetrics({ thickness: sheet.thickness, radius: bend.radius, kFactor: values.rule.kFactor, angle: bend.angleDegrees });
    if (!metrics.ok) return { ok: false, reason: 'unsupportedBend' };
    bends.push({ id: JSON.stringify(['sheet-bend', parent.id, rimKey]), parentPanelId: parent.id, childPanelId: sheetPanelId(feature.id, child.key),
      parentEdge: contact.parentEdge, childEdge: contact.childEdge, angle: bend.angleDegrees, radius: bend.radius, kFactor: values.rule.kFactor,
      allowance: metrics.metrics.bendAllowance, frame: contact.frame, width: bend.width });
  }
  const body: ResolvedSheetBody = { rootFeatureId: feature.id, rule, converted: true, panels, bends };
  const plan = resolvedSheetBodyPlan(body);
  return plan.ok ? { ok: true, plan: plan.value, body } : { ok: false, reason: 'invalidRule' };
}
