/**
 * 2部品の間の直線のすみ肉溶接を計画する(純関数)。面と辺は選んだ時の形から部品の座標で読んだ値で、ここで
 * 今の配置へ写し、扱える当たりの形かを確かめ、ビードの座標系の向きを1か所で決め、区間を確かめる。確かめられない
 * 形は、別の場所へビードを置かずに理由を添えて断る。
 *
 * 確かめること: 2面が平面で、平行でなく、平行に近い当たりは脚長に対して内角が決まる(`weldAngleConditioned`)。
 * 断面の三角形が長さの許容差より厚い(`weldCrossSectionIssue`。直角も同じ基準)。選んだ直線の辺が両方の
 * 面の平面上にある(当たりの線)。1つ目の面が2つ目の
 * 面から立ち上がる(角の凹側)。どのビードも選んだ辺の内側に収まる。合計の長さと体積が有限。最後に、ビード
 * 1 区間ごとの足元の長方形(2 つの面の上に 1 枚ずつ)が、各部品のいまのボディの有限の面に実際に載ること
 * (`weldContact.ts`。穴・面の端・小さい面を見つける)。ボディが無い・判定できない時も断る。
 */

import { findDensityMaterial } from '../../appearance/densityMaterials.js';
import type { SolidBody } from '../../kernelBridge.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { findComponent } from '../assemblyEdit.js';
import { applyPlacementToDirection, applyPlacementToPoint, rotateVector } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { componentSourceKey, placementFingerprint, rigidPlacementOf, validPlacement } from '../fastening/frames.js';
import { nextSerialId } from '../../sketch/createSketchDocument.js';
import { filletWeldLegs, filletWeldNominalVolume, filletWeldSegmentOptions, filletWeldSegmentRevision } from './filletWeldPart.js';
import { occupiedLength, stationRejections } from './stationing.js';
import { contactRejection, footprintContact } from './weldContact.js';
import { cylindricalWeldContact, cylindricalWeldCoversSegment, cylindricalWeldSection, selectedWeldCylinder,
  type CurrentCylinder } from './cylindricalWeld.js';
import {
  type FilletWeldPlan, type FilletWeldPlanResult, type FilletWeldRejection, type FilletWeldRequest,
  WELD_DIRECTION_TOLERANCE, WELD_ID_PREFIX, WELD_LENGTH_TOLERANCE_MM, weldAngleRangeDegrees, weldCrossSection,
  weldCrossSectionIssue, type WeldContactEvidence, type WeldFaceSelection, type WeldFrame, weldInteriorAngle, type WeldInteriorAngle,
  type WeldSegmentSpec,
} from './types.js';

/** 平行に近い(条件の悪い)当たりの断り。内角と、この脚長で扱える範囲を添える。 */
function illConditionedAngle(ids: Readonly<Record<string, string>>, degrees: number, legOnSecond: number, legOnFirst: number): FilletWeldRejection {
  const range = weldAngleRangeDegrees(legOnSecond, legOnFirst);
  return reject('unsupportedJointAngle', { ...ids, angleDegrees: degrees, minimumDegrees: range.minimum, maximumDegrees: range.maximum });
}

/** 断面の確かめ(直角も同じ基準)。問題が無ければ `null`。桁あふれは公称体積の検査(`finishPlan`)が断る。 */
function crossSectionRejection(
  ids: Readonly<Record<string, string>>, angle: WeldInteriorAngle | null, degrees: number, legOnSecond: number, legOnFirst: number,
): FilletWeldRejection | null {
  const issue = weldCrossSectionIssue(legOnSecond, legOnFirst, angle);
  if (issue === 'illConditioned') return illConditionedAngle(ids, degrees, legOnSecond, legOnFirst);
  if (issue === 'degenerate') {
    return reject('degenerateCrossSection', { ...ids, legOnSecond, legOnFirst, angleDegrees: degrees,
      minimumAltitude: weldCrossSection(legOnSecond, legOnFirst, angle).minimumAltitude, tolerance: WELD_LENGTH_TOLERANCE_MM });
  }
  return null;
}

function reject(code: FilletWeldRejection['code'], detail: FilletWeldRejection['detail'] = {}): FilletWeldRejection {
  return { code, detail };
}

function finite(vector: Vec3): boolean {
  return vector.every((value) => Number.isFinite(value));
}

function unitRejection(name: string, vector: Vec3): FilletWeldRejection | null {
  if (!finite(vector) || lengthVec3(vector) <= WELD_LENGTH_TOLERANCE_MM) return reject('invalidVector', { name });
  const size = lengthVec3(vector);
  return Math.abs(size - 1) > WELD_DIRECTION_TOLERANCE ? reject('vectorNotNormalized', { name, value: size }) : null;
}

/** 文書の溶接のビードの部品(全区間)を溶接の id ごとに。 */
export function weldSegmentsOf(document: AssemblyDocument): ReadonlyMap<string, readonly AssemblyComponent[]> {
  const out = new Map<string, AssemblyComponent[]>();
  for (const component of document.components) {
    if (component.source.kind !== 'standardPart' || component.source.catalog !== 'filletWeld') continue;
    const options = filletWeldSegmentOptions(component.source.options);
    const id = options?.weldId ?? component.source.options.weldId ?? '';
    const list = out.get(id) ?? [];
    list.push(component);
    out.set(id, list);
  }
  return out;
}

/** 次の溶接の id(`weld-<n>`)。文書に残っている番号は使わない。 */
export function nextWeldId(document: AssemblyDocument): string {
  return nextSerialId([...weldSegmentsOf(document).keys()].filter((id) => id !== ''), WELD_ID_PREFIX);
}

interface ResolvedFace {
  readonly component: AssemblyComponent;
  readonly centroid: Vec3;
  readonly normal: Vec3;
  readonly cylindricalRadius?: number;
  readonly cylindricalSide?: 'interior';
  readonly selectedCylinder?: CurrentCylinder;
}

function resolveFace(
  document: AssemblyDocument, selection: WeldFaceSelection, partRevisions: ReadonlyMap<string, string>,
  cylindrical?: { readonly root: Vec3; readonly bodiesOf: WeldBodyLookup },
): { readonly face: ResolvedFace } | { readonly rejection: FilletWeldRejection } {
  const component = findComponent(document, selection.componentId);
  const componentId = selection.componentId;
  if (component === undefined) return { rejection: reject('componentMissing', { componentId }) };
  if (component.suppressed) return { rejection: reject('componentSuppressed', { componentId }) };
  if (component.source.kind === 'subAssembly') return { rejection: reject('componentNotPlaceable', { componentId }) };
  const key = componentSourceKey(component, partRevisions);
  if (key === null) return { rejection: reject('missingSourceRevision', { componentId }) };
  if (key !== selection.sourceKey) return { rejection: reject('staleSource', { componentId }) };
  if (!validPlacement(component.placement)) return { rejection: reject('invalidPlacement', { componentId }) };
  const fingerprint = selection.face.fingerprint;
  if (!finite(selection.centroid)) return { rejection: reject('invalidVector', { componentId, name: 'centroid' }) };
  if (fingerprint.kind === 'face' && fingerprint.surfaceKind === 'cylinder' && cylindrical !== undefined) {
    const bodies = cylindrical.bodiesOf(component);
    const placement = rigidPlacementOf(component.placement);
    const cylinder = bodies === null ? null : selectedWeldCylinder(bodies, selection.face, placement, cylindrical.root);
    if (cylinder === null) return { rejection: reject('contactUndecidable', { componentId, reason: 'currentOrientedBandRequired' }) };
    return { face: { component, centroid: applyPlacementToPoint(placement, selection.centroid), normal: cylinder.normal,
      cylindricalRadius: cylinder.radius, selectedCylinder: cylinder,
      ...(cylinder.side === 'interior' ? { cylindricalSide: cylinder.side } : {}) } };
  }
  if (fingerprint.kind !== 'face' || fingerprint.surfaceKind !== 'plane') return { rejection: reject('faceNotPlanar', { componentId }) };
  if (selection.normal === null) return { rejection: reject('invalidVector', { componentId, name: 'normal' }) };
  const unit = unitRejection('normal', selection.normal);
  if (unit !== null) return { rejection: { ...unit, detail: { ...unit.detail, componentId } } };
  const placement = rigidPlacementOf(component.placement);
  const centroid = applyPlacementToPoint(placement, selection.centroid);
  const normal = applyPlacementToDirection(placement, selection.normal);
  if (!finite(centroid) || !finite(normal) || Math.abs(lengthVec3(normal) - 1) > WELD_DIRECTION_TOLERANCE) {
    return { rejection: reject('invalidWorldFrame', { componentId }) };
  }
  return { face: { component, centroid, normal } };
}

function identity(component: AssemblyComponent, partRevisions: ReadonlyMap<string, string>): string {
  return `${componentSourceKey(component, partRevisions) ?? ''}|${placementFingerprint(component.placement)}`;
}

function legAndMaterialRejections(legOnSecond: number, legOnFirst: number, materialId: string): FilletWeldRejection[] {
  const out: FilletWeldRejection[] = [];
  for (const [name, value] of [['legOnSecond', legOnSecond], ['legOnFirst', legOnFirst]] as const) {
    if (!Number.isFinite(value) || value <= WELD_LENGTH_TOLERANCE_MM) out.push(reject('invalidDimension', { name, value }));
  }
  if (materialId.trim() === '') out.push(reject('materialRequired'));
  else if (findDensityMaterial(materialId) === undefined) out.push(reject('unknownMaterial', { materialId }));
  return out;
}

/** 置いた部品のいまのボディ(部品座標、再計算の結果)。形が無ければ `null`。 */
export type WeldBodyLookup = (component: AssemblyComponent) => readonly SolidBody[] | null;

type PlanBase = Omit<FilletWeldPlan, 'totalLength' | 'nominalVolume' | 'contact'>;

/**
 * ビード 1 区間ごとに、2 つの面の上の足元の長方形がそれぞれの部品の実際の面に載るかを確かめる。
 * 2 つ目の面の上: 溶接線 × x(脚 legOnSecond)、1 つ目の面の上: 溶接線 × 1 つ目の面の上の脚の向き(脚 legOnFirst。
 * 直角は y、直角でない時は cos θ·x + sin θ·y)。
 */
export function firstLegDirection(frame: WeldFrame, angle: WeldInteriorAngle | null): Vec3 {
  return angle === null ? frame.yAxis : addVec3(scaleVec3(frame.xAxis, angle.cos), scaleVec3(frame.yAxis, angle.sin));
}

function contactCheck(
  base: PlanBase, first: AssemblyComponent, second: AssemblyComponent, bodiesOf: WeldBodyLookup,
): { readonly rejections: FilletWeldRejection[]; readonly evidence: WeldContactEvidence[] } {
  const out: FilletWeldRejection[] = [];
  const evidence: WeldContactEvidence[] = [];
  const sides = [
    { side: 'first' as const, component: first, across: firstLegDirection(base.frame, base.interiorAngle), width: base.legOnFirst },
    { side: 'second' as const, component: second, across: base.frame.xAxis, width: base.legOnSecond },
  ];
  for (const { side, component, across, width } of sides) {
    const bodies = bodiesOf(component);
    if (bodies === null || bodies.length === 0) {
      out.push(reject('contactFaceUnavailable', { side, componentId: component.id }));
      continue;
    }
    const placement = rigidPlacementOf(component.placement);
    base.segments.forEach((segment, index) => {
      if (side === 'second' && base.cylindricalRadius !== undefined) {
        if (cylindricalWeldContact(bodies, placement, base.frame, base.cylindricalRadius,
          base.legOnSecond, base.legOnFirst, segment, base.cylindricalSide)) {
          evidence.push({ segment: index, side, componentId: component.id, coveredRatio: 1 });
        } else out.push(reject('contactNotCovered', { side, componentId: component.id, segment: index, reason: 'cylindricalBand' }));
        return;
      }
      const result = footprintContact(bodies, placement, {
        corner: addVec3(base.frame.origin, scaleVec3(base.frame.zAxis, segment.start)), along: base.frame.zAxis, across,
        length: segment.length, width,
      });
      const rejection = contactRejection(result, index, side, component.id);
      if (rejection !== null) out.push(rejection);
      else if (result.coveredRatio !== null) evidence.push({ segment: index, side, componentId: component.id, coveredRatio: result.coveredRatio });
    });
  }
  return { rejections: out, evidence };
}

/**
 * 同じ材料の当たりに既にある別の溶接と、この計画のビードが重なれば断る(同じ所を二重に溶接して質量を二重に数えない)。
 * 当たりが同じとは、溶接した 2 部品が同じ組(順は問わない)で、溶接線が同じ直線の上にあり(向きは逆でもよい)、
 * 2 本の脚の向きの組が一致すること(同じ線の反対側の角や別の辺は別の当たり)。保存したビードの座標系は
 * `planFilletWeldEdit` と同じく配置から戻し、区間の始点・終点をこの計画の線の座標へ写して比べる。端が接する
 * だけなら重ならない(`stationRejections` と同じ)。直している溶接自身(`base.weldId`)とは比べない。欄や配置を
 * 読めないビードはその溶接を直す時に `weldDamaged` で断られるので、ここでは比べない。
 */
function existingWeldOverlaps(document: AssemblyDocument, base: PlanBase): FilletWeldRejection[] {
  const legs = [base.frame.xAxis, firstLegDirection(base.frame, base.interiorAngle)] as const;
  const parallel = (a: Vec3, b: Vec3): boolean => dotVec3(a, b) >= 1 - WELD_DIRECTION_TOLERANCE;
  const out: FilletWeldRejection[] = [];
  for (const [weldId, beads] of weldSegmentsOf(document)) {
    if (weldId === base.weldId) continue;
    for (const bead of beads) {
      const options = bead.source.kind === 'standardPart' ? filletWeldSegmentOptions(bead.source.options) : null;
      if (options === null || !validPlacement(bead.placement)) continue;
      const [one, two] = options.parts;
      if (!((one === base.firstComponentId && two === base.secondComponentId)
        || (one === base.secondComponentId && two === base.firstComponentId))) continue;
      const angle = options.interiorAngleDegrees === undefined ? null : weldInteriorAngle(options.interiorAngleDegrees);
      if (options.interiorAngleDegrees !== undefined && angle === null) continue;
      const placement = rigidPlacementOf(bead.placement);
      const zAxis = rotateVector(placement.rotation, [0, 0, 1]);
      const along = dotVec3(zAxis, base.frame.zAxis);
      if (Math.abs(along) < 1 - WELD_DIRECTION_TOLERANCE) continue;
      const offset = subVec3(placement.position, base.frame.origin);
      const startAt = dotVec3(offset, base.frame.zAxis);
      if (lengthVec3(subVec3(offset, scaleVec3(base.frame.zAxis, startAt))) > WELD_LENGTH_TOLERANCE_MM) continue;
      const frame: WeldFrame = { origin: subVec3(placement.position, scaleVec3(zAxis, options.station)),
        xAxis: rotateVector(placement.rotation, [1, 0, 0]), yAxis: rotateVector(placement.rotation, [0, 1, 0]), zAxis };
      const theirs = [frame.xAxis, firstLegDirection(frame, angle)] as const;
      if (!((parallel(legs[0], theirs[0]) && parallel(legs[1], theirs[1]))
        || (parallel(legs[0], theirs[1]) && parallel(legs[1], theirs[0])))) continue;
      const endAt = startAt + along * options.length;
      const low = Math.min(startAt, endAt), high = Math.max(startAt, endAt);
      base.segments.forEach((segment, index) => {
        const overlap = Math.min(high, segment.start + segment.length) - Math.max(low, segment.start);
        if (overlap > WELD_LENGTH_TOLERANCE_MM) out.push(reject('overlapsExistingWeld', { weldId, segment: index, overlap }));
      });
    }
  }
  return out;
}

/**
 * 合計の長さと公称体積が有限の正の数で(桁あふれで無限の質量の計画を作らない)、全ビードの足元が実際の面に
 * 載る時だけ計画を返す。安い検査を先に行い、当たりの判定はその後。
 */
function finishPlan(
  document: AssemblyDocument, base: PlanBase, first: AssemblyComponent, second: AssemblyComponent, bodiesOf: WeldBodyLookup,
  selectedCylinder?: CurrentCylinder,
): FilletWeldPlanResult {
  const totalLength = occupiedLength(base.segments);
  const curvedSection = base.cylindricalRadius === undefined ? null
    : cylindricalWeldSection(base.cylindricalRadius, base.legOnSecond, base.legOnFirst, base.cylindricalSide);
  if (base.cylindricalRadius !== undefined && (curvedSection === null || base.interiorAngle !== null)) {
    return { ok: false, rejections: [reject('degenerateCrossSection', { reason: 'cylindricalSection' })] };
  }
  const nominalVolume = curvedSection === null
    ? filletWeldNominalVolume(base.legOnSecond, base.legOnFirst, totalLength, base.interiorAngle) : curvedSection.area * totalLength;
  const rejections: FilletWeldRejection[] = [];
  if (!Number.isFinite(totalLength) || totalLength <= 0) rejections.push(reject('invalidDimension', { name: 'totalLength', value: totalLength }));
  if (!Number.isFinite(nominalVolume) || nominalVolume <= 0) rejections.push(reject('invalidDimension', { name: 'nominalVolume', value: nominalVolume }));
  if (rejections.length > 0) return { ok: false, rejections };
  // Preserve dimension/section classification before selected-face coverage.
  // Midpoint only chose the radial direction; every actual bead needs this band.
  if (selectedCylinder !== undefined) {
    const uncovered = base.segments.flatMap((segment, index) =>
      cylindricalWeldCoversSegment(selectedCylinder, base.frame, selectedCylinder.radius, base.legOnSecond, base.legOnFirst, segment) ? []
        : [reject('contactNotCovered', { side: 'second', componentId: second.id, segment: index, reason: 'selectedCylindricalBand' })]);
    if (uncovered.length > 0) return { ok: false, rejections: uncovered };
  }
  const existing = existingWeldOverlaps(document, base);
  if (existing.length > 0) return { ok: false, rejections: existing };
  const contact = contactCheck(base, first, second, bodiesOf);
  return contact.rejections.length > 0 ? { ok: false, rejections: contact.rejections }
    : { ok: true, plan: { ...base, totalLength, nominalVolume, contact: contact.evidence } };
}

/** 直角の当たりの座標系(従来と同じ値): x = 1 つ目の面の法線、y = 2 つ目の面の法線、z = 向きをそろえた辺。 */
function rightAngleFrame(midpoint: Vec3, along: Vec3, corner: Vec3, length: number, firstNormal: Vec3, secondNormal: Vec3): WeldFrame {
  const oriented = dotVec3(along, corner) > 0 ? along : scaleVec3(along, -1);
  return { origin: subVec3(midpoint, scaleVec3(oriented, length / 2)), xAxis: firstNormal, yAxis: secondNormal, zAxis: oriented };
}

/**
 * 直角でない当たりの座標系(正規直交のまま): x = 1 つ目の面の法線を 2 つ目の面へ射影した単位(2 つ目の面の上で
 * 1 つ目の部品から離れる向き)、y = 2 つ目の面の法線、z = x × y(= 法線の外積の向き)。辺の向きは z と
 * 平行なことを呼び出し側で確かめ済み(edgeNotAlongCorner)。
 */
function obliqueFrame(midpoint: Vec3, length: number, firstNormal: Vec3, secondNormal: Vec3, cosine: number): WeldFrame {
  const projected = subVec3(firstNormal, scaleVec3(secondNormal, cosine));
  const xAxis = scaleVec3(projected, 1 / lengthVec3(projected));
  const cross = crossVec3(xAxis, secondNormal);
  const zAxis = scaleVec3(cross, 1 / lengthVec3(cross));
  return { origin: subVec3(midpoint, scaleVec3(zAxis, length / 2)), xAxis, yAxis: secondNormal, zAxis };
}

/** 選んだ面と辺から新しい溶接を計画する。当たりの判定に各部品のいまのボディ(`bodiesOf`)が要る。 */
export function planFilletWeld(
  document: AssemblyDocument, request: FilletWeldRequest, partRevisions: ReadonlyMap<string, string>, bodiesOf: WeldBodyLookup,
): FilletWeldPlanResult {
  const out = legAndMaterialRejections(request.legOnSecond, request.legOnFirst, request.materialId);
  if (request.first.componentId === request.second.componentId) {
    out.push(reject('sameComponent', { componentId: request.first.componentId }));
  }
  const first = resolveFace(document, request.first, partRevisions);
  const second = resolveFace(document, request.second, partRevisions, 'rejection' in first ? undefined : {
    root: applyPlacementToPoint(rigidPlacementOf(first.face.component.placement), request.edge.midpoint), bodiesOf,
  });
  if ('rejection' in first) out.push(first.rejection);
  if ('rejection' in second) out.push(second.rejection);
  const edge = request.edge;
  if (edge.edge.fingerprint.kind !== 'edge' || edge.edge.fingerprint.curveKind !== 'line') out.push(reject('edgeNotStraight'));
  if (!finite(edge.midpoint)) out.push(reject('invalidVector', { name: 'edgeMidpoint' }));
  const direction = unitRejection('edgeDirection', edge.direction);
  if (direction !== null) out.push(direction);
  if (!Number.isFinite(edge.length) || edge.length <= WELD_LENGTH_TOLERANCE_MM) {
    out.push(reject('invalidDimension', { name: 'edgeLength', value: edge.length }));
  }
  if (out.length > 0 || 'rejection' in first || 'rejection' in second) return { ok: false, rejections: out };

  const a = first.face;
  const b = second.face;
  const placement = rigidPlacementOf(a.component.placement);
  const midpoint = applyPlacementToPoint(placement, edge.midpoint);
  const along = applyPlacementToDirection(placement, edge.direction);
  const ids = { first: a.component.id, second: b.component.id };
  const cosine = dotVec3(a.normal, b.normal);
  // 2 面の間の内角 θ(ビードの 2 脚の間)は cos θ = −(外向きの法線どうしの内積)。直角は従来の扱い(null)。
  const right = Math.abs(cosine) <= WELD_DIRECTION_TOLERANCE;
  if (b.cylindricalRadius !== undefined && !right) {
    return { ok: false, rejections: [reject('unsupportedJointAngle', { ...ids, reason: 'radialPlaneRequired' })] };
  }
  const interiorDegrees = Math.acos(Math.max(-1, Math.min(1, -cosine))) * 180 / Math.PI;
  const interiorAngle = right ? null : weldInteriorAngle(interiorDegrees);
  // 平行(内角 0°・180°)と、脚長に対して条件の悪い平行に近い当たりは、脚の先を許容差の中で決められないので断る。
  if (!right && interiorAngle === null) {
    return { ok: false, rejections: [illConditionedAngle(ids, interiorDegrees, request.legOnSecond, request.legOnFirst)] };
  }
  const section = crossSectionRejection(ids, interiorAngle, interiorDegrees, request.legOnSecond, request.legOnFirst);
  if (section?.code === 'unsupportedJointAngle') return { ok: false, rejections: [section] };
  const rejections: FilletWeldRejection[] = section === null ? [] : [section];
  const offFirst = dotVec3(subVec3(midpoint, a.centroid), a.normal);
  if (Math.abs(offFirst) > WELD_LENGTH_TOLERANCE_MM || Math.abs(dotVec3(along, a.normal)) > WELD_DIRECTION_TOLERANCE) {
    rejections.push(reject('edgeNotOnFirstFace', { ...ids, distance: offFirst }));
  }
  // A cylindrical centroid lies on/near its axis, not on the contact tangent plane.
  // selectedWeldCylinder has already checked this actual root against the native radial surface.
  const offSecond = b.cylindricalRadius === undefined ? dotVec3(subVec3(midpoint, b.centroid), b.normal) : 0;
  if (Math.abs(offSecond) > WELD_LENGTH_TOLERANCE_MM || Math.abs(dotVec3(along, b.normal)) > WELD_DIRECTION_TOLERANCE) {
    rejections.push(reject('edgeNotOnSecondFace', { ...ids, distance: offSecond }));
  }
  // 直角でない時は法線の外積の長さが sin θ なので、単位にしてから辺の向きと比べる(直角は従来の値のまま)。
  const corner = crossVec3(a.normal, b.normal);
  const zAxis = interiorAngle === null ? corner : scaleVec3(corner, 1 / lengthVec3(corner));
  if (Math.abs(Math.abs(dotVec3(along, zAxis)) - 1) > WELD_DIRECTION_TOLERANCE) rejections.push(reject('edgeNotAlongCorner', ids));
  // 1つ目の面は2つ目の面から立ち上がる(重心が2つ目の面の外向きの側にある)。
  const rise = dotVec3(subVec3(a.centroid, midpoint), b.normal);
  if (!(rise > WELD_LENGTH_TOLERANCE_MM)) rejections.push(reject('notConcaveCorner', { ...ids, rise }));
  rejections.push(...stationRejections(request.segments, edge.length));
  if (rejections.length > 0) return { ok: false, rejections };

  const frame = interiorAngle === null ? rightAngleFrame(midpoint, along, zAxis, edge.length, a.normal, b.normal)
    : obliqueFrame(midpoint, edge.length, a.normal, b.normal, cosine);
  return finishPlan(document, {
    weldId: nextWeldId(document), firstComponentId: a.component.id, secondComponentId: b.component.id, frame,
    contactLength: edge.length, legOnSecond: request.legOnSecond, legOnFirst: request.legOnFirst,
    segments: request.segments.map((segment) => ({ start: segment.start, length: segment.length })),
    materialId: request.materialId, interiorAngle,
    ...(b.cylindricalRadius === undefined ? {} : { cylindricalRadius: b.cylindricalRadius }),
    ...(b.cylindricalSide === undefined ? {} : { cylindricalSide: b.cylindricalSide }),
    sourceIdentities: { [a.component.id]: identity(a.component, partRevisions), [b.component.id]: identity(b.component, partRevisions) },
    replacedComponentIds: [],
  }, a.component, b.component, bodiesOf, b.selectedCylinder);
}

export interface FilletWeldEditRequest {
  readonly weldId: string;
  readonly legOnSecond: number;
  readonly legOnFirst: number;
  readonly segments: readonly WeldSegmentSpec[];
  readonly materialId: string;
}

/**
 * 既存の溶接の脚長・区間・材質を、保存した座標系のまま計画し直す。座標系は保存した区間の配置から戻す
 * (原点 = 位置 − 始点·z)。全区間で座標系・当たりの長さ・溶接した2部品が一致し、その2部品が今も同じ組に
 * いることを確かめ、新しい区間・脚長の足元が2部品のいまの面に載ることを新しい溶接と同じ判定で確かめ直す
 * (部品の形が変わって当たりが無くなった溶接を、保存した位置のまま黙って置き直さない)。
 */
export function planFilletWeldEdit(
  document: AssemblyDocument, request: FilletWeldEditRequest, partRevisions: ReadonlyMap<string, string>, bodiesOf: WeldBodyLookup,
): FilletWeldPlanResult {
  const segments = weldSegmentsOf(document).get(request.weldId);
  if (segments === undefined || segments.length === 0) return { ok: false, rejections: [reject('weldMissing', { weldId: request.weldId })] };
  const out = legAndMaterialRejections(request.legOnSecond, request.legOnFirst, request.materialId);
  let frame: WeldFrame | null = null;
  let interiorAngle: WeldInteriorAngle | null = null;
  let cylindricalRadius: number | undefined;
  let cylindricalSide: 'interior' | undefined;
  let contactLength = 0;
  let firstComponentId = '';
  let secondComponentId = '';
  for (const component of segments) {
    const options = component.source.kind === 'standardPart' ? filletWeldSegmentOptions(component.source.options) : null;
    const legs = component.source.kind === 'standardPart' ? filletWeldLegs(component.source.size) : null;
    if (options === null || legs === null || !validPlacement(component.placement)) {
      return { ok: false, rejections: [reject('weldDamaged', { weldId: request.weldId, componentId: component.id })] };
    }
    if (component.source.kind !== 'standardPart' || component.source.generatorRevision !== filletWeldSegmentRevision(options)) {
      return { ok: false, rejections: [reject('weldDamaged', { weldId: request.weldId, componentId: component.id })] };
    }
    const parts = options.parts;
    const placement = rigidPlacementOf(component.placement);
    const zAxis = rotateVector(placement.rotation, [0, 0, 1]);
    const candidate: WeldFrame = {
      origin: subVec3(placement.position, scaleVec3(zAxis, options.station)),
      xAxis: rotateVector(placement.rotation, [1, 0, 0]), yAxis: rotateVector(placement.rotation, [0, 1, 0]), zAxis,
    };
    // 内角は保存した区間の欄から(座標系は配置から)。直角のビードは欄を持たない(null)。
    const candidateAngle = options.interiorAngleDegrees === undefined ? null : weldInteriorAngle(options.interiorAngleDegrees);
    if (options.interiorAngleDegrees !== undefined && candidateAngle === null) {
      return { ok: false, rejections: [reject('weldDamaged', { weldId: request.weldId, componentId: component.id })] };
    }
    if (frame === null) {
      frame = candidate;
      interiorAngle = candidateAngle;
      cylindricalRadius = options.cylindricalRadius;
      cylindricalSide = options.cylindricalSide;
      contactLength = options.contactLength;
      [firstComponentId, secondComponentId] = parts;
      continue;
    }
    const sameFrame = lengthVec3(subVec3(frame.origin, candidate.origin)) <= WELD_LENGTH_TOLERANCE_MM
      && dotVec3(frame.xAxis, candidate.xAxis) >= 1 - WELD_DIRECTION_TOLERANCE
      && dotVec3(frame.zAxis, candidate.zAxis) >= 1 - WELD_DIRECTION_TOLERANCE;
    const sameAngle = interiorAngle === null ? candidateAngle === null
      : candidateAngle !== null && Math.abs(candidateAngle.degrees - interiorAngle.degrees) <= WELD_DIRECTION_TOLERANCE;
    if (!sameFrame || !sameAngle || options.cylindricalRadius !== cylindricalRadius || options.cylindricalSide !== cylindricalSide
      || Math.abs(options.contactLength - contactLength) > WELD_LENGTH_TOLERANCE_MM
      || parts[0] !== firstComponentId || parts[1] !== secondComponentId) {
      return { ok: false, rejections: [reject('weldDamaged', { weldId: request.weldId, componentId: component.id })] };
    }
  }
  if (frame === null) return { ok: false, rejections: [reject('weldMissing', { weldId: request.weldId })] };
  const group = segments[0].rigidGroupId;
  const participants: AssemblyComponent[] = [];
  for (const componentId of [firstComponentId, secondComponentId]) {
    const component = findComponent(document, componentId);
    if (component === undefined) out.push(reject('componentMissing', { componentId }));
    else if (component.suppressed) out.push(reject('componentSuppressed', { componentId }));
    else if (componentSourceKey(component, partRevisions) === null) out.push(reject('missingSourceRevision', { componentId }));
    else if (group === undefined || component.rigidGroupId !== group) out.push(reject('weldDamaged', { weldId: request.weldId, componentId }));
    else participants.push(component);
  }
  out.push(...stationRejections(request.segments, contactLength));
  // 内角は保存した値のまま。新しい脚長でも断面を確かめ直す(脚を長くすると平行に近い当たりは扱えない・脚を短く
  // すると細すぎる)。脚長そのものの誤り(invalidDimension)は上で断っているので、その時は理由を重ねない。
  const legsValid = [request.legOnSecond, request.legOnFirst].every((value) => Number.isFinite(value) && value > WELD_LENGTH_TOLERANCE_MM);
  const section = legsValid ? crossSectionRejection({ weldId: request.weldId }, interiorAngle, interiorAngle?.degrees ?? 90,
    request.legOnSecond, request.legOnFirst) : null;
  if (section !== null) out.push(section);
  if (out.length > 0) return { ok: false, rejections: out };
  // 溶接した2部品の出どころと配置も、ビードと同じく確定の直前に照合する(計画の後に部品が変わった・
  // 抑制された・消された・版が変わったら、ビードが変わっていなくても足さない)。
  const sourceIdentities: Record<string, string> = {};
  for (const component of [...participants, ...segments]) sourceIdentities[component.id] = identity(component, partRevisions);
  const [first, second] = participants;
  if (first === undefined || second === undefined) return { ok: false, rejections: [reject('weldMissing', { weldId: request.weldId })] };
  return finishPlan(document, {
    weldId: request.weldId, firstComponentId, secondComponentId, frame, contactLength, legOnSecond: request.legOnSecond, legOnFirst: request.legOnFirst,
    segments: request.segments.map((segment) => ({ start: segment.start, length: segment.length })),
    materialId: request.materialId, interiorAngle, sourceIdentities, replacedComponentIds: segments.map((component) => component.id),
    ...(cylindricalRadius === undefined ? {} : { cylindricalRadius }),
    ...(cylindricalSide === undefined ? {} : { cylindricalSide }),
  }, first, second, bodiesOf);
}
