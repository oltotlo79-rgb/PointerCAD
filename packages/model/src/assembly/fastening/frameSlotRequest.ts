/**
 * フレームの締結の入口(J-02 P6b・P7): 組立の部品から溝つきのフレームの候補(溝の中心線)を作り、結び付けた穴の選択と
 * 画面の指定(ボルトの呼び・溝用のナットの入れ方と材質)から、P6a の計画(`planFrameSlotFastening`)を作る。
 *
 * - 候補: 族が `sectionSlots` と `sectionBounds` を持つ部品(読み込み済みの族だけ)。長さは保存の形の欄、留めの端は欄の
 *   startMiter・endMiter、配置は表示中の配置。溝の呼びの幅は行の dims の slotWidth、無ければ行の鍵の頭(s6- など)。
 *   どちらも無い族(寸法を指定する汎用の形)は null で、計画が slotWidthUnknown の理由で断る。
 * - ボルト: 六角穴付きボルトの行(呼びの並目のピッチ)。穴の入口がざぐり・皿もみならその頭(座の深さつき)、入口の無い
 *   通し穴は座の深さ 0。頭が穴ごとに違えるので、穴ごとに計画し、1 つでも断られたら全部やめる(穴ごとの理由を返す)。
 */
import { evaluateExpression } from '@pointercad/expression';

import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { frameSlotLines } from '../frame/frameSlots.js';
import type { RigidPlacement } from '../placementMath.js';
import { miterEndsOf } from '../standard/profileMiter.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { SolidEdgeEntry, SolidFaceEntry } from '../../kernelBridge/solidContracts.js';
import { withinMagnitude } from '../../numericTolerance.js';
import { addVec3, dotVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { findMetricThread, metricThreadPitch } from '../../thread/metricThread.js';
import { entryLengthAvailability } from './entryBoltLength.js';
import {
  planFrameSlotFastening, type FrameSlotCandidate, type FrameSlotFasteningRequest, type FrameSlotFasteningResult,
  type FrameSlotHoleFailure,
} from './frameSlotFastening.js';
import { componentSourceKey } from './frames.js';
import { entryHeadSpec } from './holeEntry.js';
import type { EntryHoleSelection, FasteningHoleEntry } from './holeEntryTypes.js';
import type { BoltedJointRejection } from './types.js';

const FAMILY_KEY = 'family', ITEM_KEY = 'item';
/** 行の鍵の頭の溝の呼びの幅(資料の族・系列の族の鍵 `s6-20x20` の形)。 */
const SLOT_WIDTH_KEY_PATTERN = /^s([0-9]+)-/u;
/** 入口の無い通し穴の頭(六角穴付きボルトを座の深さ 0 で面に座らせる。径は頭の判定に使わない)。 */
const FLAT_SEAT: FasteningHoleEntry = { kind: 'counterbore', diameter: 0, depth: 0, side: 'outer' };

/** 画面の指定: ボルトの呼び(六角穴付きボルトの行)・溝用のナットの入れ方と材質(ナットの記録の entry・material の値)。 */
interface FrameSlotChoices {
  readonly nominal: string;
  readonly nutEntry: string;
  readonly nutMaterial: string;
}

/** 六角穴付きボルトの族の呼びの並び(重複を除く)。画面の選択肢に使う。 */
export function frameSlotBoltNominals(): readonly string[] {
  return [...new Set(SOCKET_HEAD_CAP_SCREW_FAMILY.rows.map((row) => row.size))];
}

/** 溝の呼びの幅: 行の dims の slotWidth、無ければ行の鍵の頭。どちらも無ければ null(寸法を指定する汎用の形)。 */
function frameSlotWidthOf(row: CatalogItemRow): number | null {
  const own = Object.hasOwn(row.dims, 'slotWidth') ? row.dims.slotWidth : undefined;
  if (own !== undefined && Number.isFinite(own) && own > 0) return own;
  const match = SLOT_WIDTH_KEY_PATTERN.exec(row.key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** 部品 1 つの溝の候補。溝を持たない族・読み込んでいない族・長さが読めない部品は null。 */
function candidateOf(family: CatalogFamily, row: CatalogItemRow, options: Readonly<Record<string, string>>, componentId: string,
  placement: RigidPlacement): FrameSlotCandidate | null {
  const values = Object.fromEntries(Object.entries(options).filter(([key]) => key !== FAMILY_KEY && key !== ITEM_KEY));
  const slots = family.sectionSlots?.(row, values) ?? null;
  const bounds = family.sectionBounds?.(row, values) ?? null;
  const length = evaluateExpression(Object.hasOwn(values, 'length') ? values.length : '');
  if (slots === null || slots.length === 0 || !length.ok || !(length.value.value > 0)) return null;
  return { componentId, lines: frameSlotLines(slots, placement, length.value.value, bounds, miterEndsOf(values)),
    slotWidth: frameSlotWidthOf(row), slotPositionSimplified: row.simplifiedKinds?.includes('slotPositionSymmetric') === true };
}

/**
 * 組立の溝つきのフレームの全部(`only` を渡すとその部品だけ)。配置は表示中の配置(動きの配置を含む)を渡す。
 * 隠した・抑制した部品は候補にしない。
 */
export function frameSlotCandidates(document: AssemblyDocument, placements: ReadonlyMap<string, RigidPlacement>,
  only: ReadonlySet<string> | null = null, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): readonly FrameSlotCandidate[] {
  return document.components.flatMap((component): FrameSlotCandidate[] => {
    const source = component.source;
    const placement = placements.get(component.id);
    if (source.kind !== 'standardPart' || source.catalog !== 'catalogItem' || placement === undefined || component.suppressed
      || !component.visible || (only !== null && !only.has(component.id))) return [];
    const family = registry.loaded(source.options[FAMILY_KEY] ?? '');
    const row = family?.rows.find((candidate) => candidate.key === source.options[ITEM_KEY]);
    const candidate = family === undefined || row === undefined ? null : candidateOf(family, row, source.options, component.id, placement);
    return candidate === null ? [] : [candidate];
  });
}

/** 穴の軸と合わせ面の法線を平行とみなす、内積の絶対値の 1 からのずれ。 */
const PROFILE_AXIS_TOLERANCE = 1e-6;
/** 合わせ面が穴の帯の端にあるとみなす、軸の向きの距離(mm)。 */
const PROFILE_END_TOLERANCE_MM = 1e-6;

/** 穴の面と合わせ面(今のボディの面の表の行)、同じボディの面の全部(反対の端と段を確かめる)と、選択に残す参照。 */
interface ProfileHoleFaces {
  /** 見分けに残す id(穴のフィーチャーが無い形は、穴の面のボディのフィーチャー)。 */
  readonly holeFeatureId: string;
  readonly hole: SolidFaceEntry;
  readonly mating: SolidFaceEntry;
  readonly matingRef: SubShapeRef;
  readonly bodyFaces: readonly SolidFaceEntry[];
  /** 同じボディの辺の全部(半円などで作った穴の輪が閉じているかを、縁の円弧で確かめる)。 */
  readonly bodyEdges: readonly SolidEdgeEntry[];
}

/**
 * 輪の穴を通し穴と読めない理由: 円筒でない・外側の円筒(ボス)・全周でない円筒(長穴・切り欠き・隅の丸み)・合わせ面が平面でない・
 * 軸に直交しない・帯の端にない・反対の端に直交する平面が無い(止まり穴)・同じ軸に径の違う円筒か円錐がある(途中で径が変わる穴・
 * ざぐり・皿もみ)。画面は理由ごとの文と次の手を出す。
 */
export type ProfileHoleRejection = 'notCylinder' | 'exteriorCylinder' | 'partialCylinder' | 'matingNotPlane' | 'matingNotPerpendicular'
  | 'matingNotAtEnd' | 'oppositeEndMissing' | 'steppedHole';

function parallel(left: Vec3, right: Vec3): boolean {
  return 1 - Math.abs(dotVec3(left, right)) <= PROFILE_AXIS_TOLERANCE;
}

/** 軸の上の点 `origin`・向き `axis` から、点 `point` までの軸に直交する距離の 2 乗。 */
function offAxisSquared(origin: Vec3, axis: Vec3, point: Vec3): number {
  const gap = subVec3(point, origin), along = dotVec3(gap, axis);
  return dotVec3(gap, gap) - along ** 2;
}

/** 同じ軸に、径の違う円筒か円錐の面があるか(途中で径が変わる穴・ざぐり・皿もみ)。 */
function coaxialStep(faces: ProfileHoleFaces, origin: Vec3, axis: Vec3, radius: number): boolean {
  return faces.bodyFaces.some((face) => {
    if (face.index === faces.hole.index || (face.surfaceKind !== 'cylinder' && face.surfaceKind !== 'cone')) return false;
    const otherOrigin = face.axisOrigin ?? null;
    if (face.axis === null || otherOrigin === null || !parallel(face.axis, axis)
      || offAxisSquared(origin, axis, otherOrigin) > PROFILE_END_TOLERANCE_MM ** 2) return false;
    return face.surfaceKind === 'cone' || face.radius === null || !withinMagnitude(face.radius - radius, PROFILE_END_TOLERANCE_MM);
  });
}

/**
 * 輪の穴の面の面積の和・縁の円弧の角度の和を全周(2πrh・2π)とみなす比のずれ。kernel の面積と辺の長さは形の積分なので、
 * 半円 2 つの和と全周は丸めの桁まで合う(隅の丸みや切り欠きの弧は全周の半分以下なので、この幅で取り違えない)。
 */
const RING_CLOSURE_RELATIVE_TOLERANCE = 1e-4;

/** 全周の値 `full` に、和 `total` が比 RING_CLOSURE_RELATIVE_TOLERANCE の内で合うか。 */
function closesRing(total: number, full: number): boolean {
  return full > 0 && withinMagnitude(total - full, full * RING_CLOSURE_RELATIVE_TOLERANCE);
}

/**
 * 輪の面の縁の円弧のうち、帯の始めの端(穴の面の軸の上の点から `start`)にある同じ径の円の辺の角度の和(rad。弧の長さ ÷ 径)。
 * 縁の辺の表が無い面がある時は null(閉じているかを確かめられない)。
 */
function ringStartAngle(ring: readonly SolidFaceEntry[], edges: readonly SolidEdgeEntry[], origin: Vec3, axis: Vec3, radius: number,
  start: number): number | null {
  let total = 0;
  for (const face of ring) {
    if (face.boundaryEdgeIndices === undefined) return null;
    for (const index of face.boundaryEdgeIndices) {
      const edge = edges.find((candidate) => candidate.index === index);
      if (edge === undefined || edge.curveKind !== 'circle' || edge.radius === null
        || !withinMagnitude(edge.radius - radius, PROFILE_END_TOLERANCE_MM)
        || !withinMagnitude(dotVec3(subVec3(edge.midpoint, origin), axis) - start, PROFILE_END_TOLERANCE_MM)) continue;
      total += edge.length / radius;
    }
  }
  return total;
}

/** 同じ軸・同じ径の内側の円筒の面か。 */
function sameBore(face: SolidFaceEntry, origin: Vec3, axis: Vec3, radius: number): boolean {
  const faceOrigin = face.axisOrigin ?? null;
  return face.surfaceKind === 'cylinder' && face.cylinderExterior !== true && face.axis !== null && parallel(face.axis, axis)
    && face.radius !== null && withinMagnitude(face.radius - radius, PROFILE_END_TOLERANCE_MM)
    && faceOrigin !== null && offAxisSquared(origin, axis, faceOrigin) <= PROFILE_END_TOLERANCE_MM ** 2;
}

/**
 * 穴の壁の帯の範囲(穴の面の軸の上の点からの、軸の向きの両端)。全周の内側の円筒 1 面はその帯、全周でない面は、同じ軸・同じ径の
 * 内側の円筒の面と辺の共有でつながり、面積の和が全周(2πr × 帯の長さ)で、縁の円弧の角度の和が 360 度になる時だけその帯
 * (断面の輪の円を半円の弧 2 つで作った穴)。長穴・切り欠き・隅の丸み・径や軸の違う弧は全周にならないので null。
 */
export function profileHoleSpan(hole: SolidFaceEntry, bodyFaces: readonly SolidFaceEntry[], bodyEdges: readonly SolidEdgeEntry[]):
readonly [number, number] | null {
  if (hole.surfaceKind !== 'cylinder' || hole.cylinderExterior === true) return null;
  const whole = hole.cylinderSpan ?? null;
  if (whole !== null) return whole;
  const axis = hole.axis, origin = hole.axisOrigin ?? null, radius = hole.radius, extent = hole.cylinderAxialExtent ?? null;
  if (axis === null || origin === null || radius === null || extent === null) return null;
  const ring: SolidFaceEntry[] = [hole];
  for (let at = 0; at < ring.length; at += 1) {
    for (const index of ring[at]?.adjacentFaces ?? []) {
      const next = bodyFaces.find((face) => face.index === index);
      if (next !== undefined && !ring.includes(next) && sameBore(next, origin, axis, radius)) ring.push(next);
    }
  }
  if (ring.length < 2) return null;
  const area = ring.reduce((sum, face) => sum + face.area, 0);
  const angle = ringStartAngle(ring, bodyEdges, origin, axis, radius, extent[0]);
  return closesRing(area, 2 * Math.PI * radius * (extent[1] - extent[0])) && angle !== null && closesRing(angle, 2 * Math.PI) ? extent : null;
}

/** 帯の位置 `at` に、軸に直交する平面があるか(辺の共有が分かる時は、穴の面と辺を共有する平面だけ)。 */
function endPlaneAt(faces: ProfileHoleFaces, origin: Vec3, axis: Vec3, at: number): boolean {
  const adjacent = faces.hole.adjacentFaces;
  return faces.bodyFaces.some((face) => face.surfaceKind === 'plane' && face.axis !== null && parallel(face.axis, axis)
    && (adjacent === undefined || adjacent.includes(face.index))
    && withinMagnitude(dotVec3(subVec3(face.centroid, origin), axis) - at, PROFILE_END_TOLERANCE_MM));
}

/**
 * 穴のフィーチャーで作っていない通し穴(断面の輪の穴を押し出した平板・ブラケットなど)を、今の面の表から通し穴の選択にする。
 * 通し穴とするのは「全周の内側の円筒(1 面か、半円 2 つのように全周を閉じる面の輪)と、帯の両端の軸に直交する平面」の時だけ。合わせ面はその片方で、軸は合わせ面から
 * 板の中へ向ける。そうでない時は理由(記録を残さない締結だけが使う。記録を残す締結は穴のフィーチャーの由来を要る)。
 */
export function profileClearanceHole(component: AssemblyComponent, partRevisions: ReadonlyMap<string, string>, faces: ProfileHoleFaces):
EntryHoleSelection | ProfileHoleRejection | BoltedJointRejection {
  const { hole, mating } = faces;
  const sourceKey = componentSourceKey(component, partRevisions);
  if (sourceKey === null) return { code: 'missingSourceRevision', detail: { componentId: component.id } };
  const axis = hole.axis, origin = hole.axisOrigin ?? null, radius = hole.radius;
  if (hole.surfaceKind !== 'cylinder' || axis === null || origin === null || radius === null) return 'notCylinder';
  if (hole.cylinderExterior === true) return 'exteriorCylinder';
  const span = profileHoleSpan(hole, faces.bodyFaces, faces.bodyEdges);
  if (span === null) return 'partialCylinder';
  if (mating.surfaceKind !== 'plane' || mating.axis === null) return 'matingNotPlane';
  if (!parallel(mating.axis, axis)) return 'matingNotPerpendicular';
  // 合わせ面の軸の向きの位置(面は軸に直交するので、面の重心の軸への射影)。
  const at = dotVec3(subVec3(mating.centroid, origin), axis);
  const atStart = withinMagnitude(at - span[0], PROFILE_END_TOLERANCE_MM), atEnd = withinMagnitude(at - span[1], PROFILE_END_TOLERANCE_MM);
  if (!atStart && !atEnd) return 'matingNotAtEnd';
  if (!endPlaneAt(faces, origin, axis, atStart ? span[1] : span[0])) return 'oppositeEndMissing';
  if (coaxialStep(faces, origin, axis, radius)) return 'steppedHole';
  const into = atStart ? axis : scaleVec3(axis, -1);
  return { componentId: component.id, sourceKey, holeFeatureId: faces.holeFeatureId, matingFace: faces.matingRef,
    hole: { kind: 'clearance', diameter: 2 * radius, length: span[1] - span[0] }, axisOrigin: addVec3(origin, scaleVec3(axis, at)),
    axisDirection: into, matingFaceNormal: scaleVec3(into, -1) };
}

/** 計画に要る物(族の表は読み込み済みの物を渡す)。 */
export interface FrameSlotPlanInputs {
  readonly holes: readonly EntryHoleSelection[];
  readonly frames: readonly FrameSlotCandidate[];
  readonly choices: FrameSlotChoices;
  readonly nutFamily: CatalogFamily;
  readonly nutRecords: FrameSlotFasteningRequest['nutRecords'];
  readonly partRevisions: ReadonlyMap<string, string>;
}

/** 頭が作れない穴の理由(行が無い・ピッチが表に無い。締結と同じ断りを元の理由に持つ)。 */
function headFailure(holeIndex: number, cause: BoltedJointRejection): FrameSlotHoleFailure {
  return { holeIndex, code: 'noBoltLength', detail: {}, cause };
}

/**
 * 穴ごとに頭(入口に合う六角穴付き・皿頭、入口の無い穴は座の深さ 0)を決め、P6a の計画を穴ごとに作って 1 つにまとめる。
 * 1 つでも断られたら計画を返さず、穴の番号つきの理由を返す(穴の番号は入力の順)。
 */
export function planFrameSlotHoles(document: AssemblyDocument, inputs: FrameSlotPlanInputs): FrameSlotFasteningResult {
  if (inputs.holes.length === 0) return { ok: false, failures: [] };
  const size = findMetricThread(inputs.choices.nominal);
  const pitch = size === undefined ? null : metricThreadPitch(size, 'coarse');
  const entries: Extract<FrameSlotFasteningResult, { readonly ok: true }>['entries'][number][] = [];
  const failures: FrameSlotHoleFailure[] = [];
  for (const [index, hole] of inputs.holes.entries()) {
    const head = pitch === null ? null : entryHeadSpec(hole.entry ?? FLAT_SEAT, inputs.choices.nominal, pitch);
    if (head === null || 'code' in head) {
      failures.push(headFailure(index, head ?? { code: 'unknownThread', detail: { nominal: inputs.choices.nominal } }));
      continue;
    }
    const result = planFrameSlotFastening(document, {
      holes: [hole], frames: inputs.frames, partRevisions: inputs.partRevisions,
      bolt: { head, availability: entryLengthAvailability() },
      nutFamily: inputs.nutFamily, nutRecords: inputs.nutRecords, nutEntry: inputs.choices.nutEntry, nutMaterial: inputs.choices.nutMaterial,
    });
    if (result.ok) entries.push(...result.entries.map((entry) => ({ ...entry, holeIndex: index })));
    else failures.push(...result.failures.map((failure) => ({ ...failure, holeIndex: index })));
  }
  return failures.length > 0 ? { ok: false, failures } : { ok: true, entries };
}
