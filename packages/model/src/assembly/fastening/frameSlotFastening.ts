/**
 * フレームの締結(J-02 P6b): ブラケットの通し穴(今の形で結び付けた選択)を、フレームの部材の溝の中心線(`frame/frameSlots.ts`)に照らし、
 * 溝用のナット(族 `t-slot-nut` の行)と六角穴付きボルト(族の行と長さの候補。Codex の `selectEntryBoltLength`)を選んで置く計画を作る。
 *
 * - 照合: 穴の合わせ面がフレームの溝のある面の上にあり(面の法線が向き合い、面の間が許容の内)、穴の軸が溝の中心線から
 *   (口の幅 − ボルトの径)/2 の内にあり、溝用のナットの長さが溝の線の端の内に収まる事。
 * - 溝用のナットは、溝の呼びの幅(族が持つ値)・ボルトの呼び・入れ方(既定 後入れ)が合う行。肩の裏(外の面から肩の厚さ)に置く。
 *   肩の裏の部屋の形は簡略形状なので、置く深さが簡略である事を計画に残す(予告に出す)。
 * - ナットの形の数は行の dims から読む。主のねじ穴は、dims.holeOffset(長さの端の面から穴の中心まで)が有る行はその位置、
 *   無い行は長さの中央(length / 2 と決めつけるのは鍵が無い時だけ)。穴の軸をボルトの軸に合わせて置き、溝の端の判定も穴の位置から測る。
 * - dims.slotPartHeightUnknown = 1 の行(ボール付き・ストッパー付き。全高がボールやストッパーの先までを包んだ値で、溝に入る所の
 *   高さが資料に無い)は、全高 − 首の高さを置く深さとボルトの長さに使わず、選べない理由(slotPartHeightUnknown)を返す。
 * - 複数の穴は全部が通った時だけ計画を返し、1 つでも断られたら全部やめて穴ごとの理由を返す(1 回の文書で足す)。
 * - 記録は残さない(保存の形は変えない)。直す時は消して置き直す。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import type { TSlotNutRecord } from '../catalog/families/framePartCatalog.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import type { FrameSlotLine } from '../frame/frameSlots.js';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { quaternionFromBasis } from '../placementMath.js';
import type { AssemblyDocument, ComponentSource, Placement } from '../types.js';
import { addVec3, cleanZeroVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { exceedsMagnitude, withinMagnitude } from '../../numericTolerance.js';
import { selectEntryBoltLength } from './entryBoltLength.js';
import { placementOnAxis } from './fastenerPlacements.js';
import { resolveWorldHole, type WorldHole } from './frames.js';
import type { EntryHeadSpec } from './holeEntry.js';
import type { BoltedJointRejection, BoltLengthAvailability, FasteningHoleSelection } from './types.js';

/** 合わせ面とフレームの面の間を同じ面とみなす距離(mm)。 */
const FACE_CONTACT_TOLERANCE_MM = 1e-3;
/** 穴の軸の向きと溝の内向きの法線を向き合うとみなす、内積の 1 からのずれ。 */
const SLOT_FACE_DIRECTION_TOLERANCE = 1e-6;
/** ナットの行の dims の印 slotPartHeightUnknown の値(溝に入る所の高さが資料に無い行。族の行の表が付ける)。 */
const SLOT_PART_HEIGHT_UNKNOWN = 1;

/** 候補のフレームの部材(溝の中心線と、溝の呼びの幅。呼びの幅が分からない族は null)。 */
export interface FrameSlotCandidate {
  readonly componentId: string;
  readonly lines: readonly FrameSlotLine[];
  /** 行の溝幅の呼び(行の dims.slotWidth → 鍵の頭)。溝ごとの呼び(線の nominalWidth)がある溝は、そちらを先に使う。 */
  readonly slotWidth: number | null;
  /** 行の簡略の印の鍵に、溝の横の位置の対称の簡略(slotPositionSymmetric)があるか(予告に知らせる)。無い時は false と同じ。 */
  readonly slotPositionSimplified?: boolean;
}

export interface FrameSlotFasteningRequest {
  readonly holes: readonly FasteningHoleSelection[];
  readonly frames: readonly FrameSlotCandidate[];
  /** 六角穴付きボルト(座の深さ 0 の頭)と、族の行の長さの候補。 */
  readonly bolt: { readonly head: EntryHeadSpec; readonly availability: readonly BoltLengthAvailability[] };
  /** 溝用のナットの族と、入れ方・材質(記録の entry・material の値。既定は後入れ・鋼)。 */
  readonly nutFamily: CatalogFamily;
  /**
   * 溝用のナットの記録(溝幅・呼び・入れ方・材質で行を選ぶ)。族の表は必要な時だけ読む決まりなので、ここで静的に読まず、
   * 呼ぶ側が `loadSlotNutRecords`(族を読む時と同じ遅れた読み込み)で渡す。
   */
  readonly nutRecords: readonly TSlotNutRecord[];
  readonly nutEntry: string;
  readonly nutMaterial: string;
  readonly partRevisions: ReadonlyMap<string, string>;
}

type FrameSlotCode = 'holeNotClearance' | 'holeNotPlaceable' | 'notOnSlotFace' | 'offSlot' | 'outsideSlotEnd' | 'slotWidthUnknown'
  | 'slotNominalUnknown' | 'boltWiderThanSlot' | 'noSlotNut' | 'slotPartHeightUnknown' | 'noBoltLength';

export interface FrameSlotHoleFailure {
  readonly holeIndex: number;
  readonly code: FrameSlotCode;
  /** ずれた量(mm)などの数。無い理由は空。 */
  readonly detail: Readonly<Record<string, string | number>>;
  /** 締結と同じ断り(置き場所が読めない・ボルトの長さが合わない時の元の理由)。画面は締結の窓と同じ文を出す。 */
  readonly cause?: BoltedJointRejection;
}

/** 穴 1 つの計画: 当たったフレームの部材と溝、置く溝用のナットとボルト。 */
interface FrameSlotEntry {
  readonly holeIndex: number;
  readonly frameComponentId: string;
  readonly face: FrameSlotLine['face'];
  readonly nut: { readonly source: ComponentSource; readonly placement: Placement; readonly name: string };
  readonly bolt: { readonly source: ComponentSource; readonly placement: Placement; readonly name: string; readonly length: number };
  /** 溝用のナットを置く深さが、簡略形状の部屋の形に頼るか(予告に出す)。 */
  readonly nutDepthSimplified: boolean;
  /** 当たった溝の横の位置が、資料の図に記入の無い対称の簡略か(予告に出す)。 */
  readonly slotPositionSimplified: boolean;
}

export type FrameSlotFasteningResult =
  | { readonly ok: true; readonly entries: readonly FrameSlotEntry[] }
  | { readonly ok: false; readonly failures: readonly FrameSlotHoleFailure[] };

interface SlotHit {
  readonly frame: FrameSlotCandidate;
  readonly line: FrameSlotLine;
  /** 溝の中心線の上の、穴の軸が通る点(外の面の上)。 */
  readonly point: Vec3;
  readonly lateral: number;
  readonly along: number;
  readonly length: number;
}

/** 穴の合わせ面が乗っている溝(面の向きが合い、面の間が許容の内の溝のうち、横のずれが一番小さい物)。 */
function nearestSlot(hole: WorldHole, frames: readonly FrameSlotCandidate[]): SlotHit | null {
  const toward = scaleVec3(hole.into, -1);
  let best: SlotHit | null = null;
  for (const frame of frames) {
    for (const line of frame.lines) {
      if (exceedsMagnitude(dotVec3(toward, line.inward) - 1, SLOT_FACE_DIRECTION_TOLERANCE)) continue;
      const offset = subVec3(hole.matingPoint, line.start);
      if (!withinMagnitude(dotVec3(offset, line.inward), FACE_CONTACT_TOLERANCE_MM)) continue;
      const span = subVec3(line.end, line.start), length = lengthVec3(span);
      if (!(length > 0)) continue;
      const along = dotVec3(offset, span) / length;
      // 横のずれ(符号つき。溝の口の幅の向き)。許容の比較は withinMagnitude、どの溝に一番近いかは 2 乗で比べる。
      const lateral = dotVec3(offset, line.across);
      const point = addVec3(line.start, scaleVec3(span, along / length));
      if (best === null || lateral ** 2 < best.lateral ** 2) best = { frame, line, point, lateral, along, length };
    }
  }
  return best;
}

/** 溝の呼びの幅・ボルトの呼び・入れ方・材質が合う溝用のナットの記録と、族の行。 */
function slotNut(request: FrameSlotFasteningRequest, slotWidth: number, nominal: string, opening: number):
{ readonly record: TSlotNutRecord; readonly row: CatalogItemRow } | null {
  const family = request.nutFamily;
  // 同じ溝幅・呼び・入れ方・材質の行が幾つかある時(口の寸法の違う行)は、首が溝の口を通る最初の行。
  const record = request.nutRecords.find((candidate) => candidate.slot === slotWidth && candidate.thread === nominal
    && candidate.entry === request.nutEntry && candidate.material === request.nutMaterial
    && candidate.neckWidth <= opening + FACE_CONTACT_TOLERANCE_MM);
  const row = record === undefined ? undefined : family.rows.find((candidate) => candidate.key === record.key);
  return record === undefined || row === undefined ? null : { record, row };
}

/** 行の dims の 1 つの数。鍵が無い・有限でない時は null(dims は鍵の有る無しで行の違いを表す)。 */
function rowDimension(row: CatalogItemRow, key: string): number | null {
  const value = Object.hasOwn(row.dims, key) ? row.dims[key] : undefined;
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/** ナットを置く形の数: 溝の向きの全長・つばの厚さ(全高 − 首の高さ)・首の高さ・長さの端の面(部品の −X の端)から主のねじ穴まで。 */
interface NutGeometry { readonly length: number; readonly flange: number; readonly neckHeight: number; readonly holeOffset: number }

/** 行の dims から置く形の数を読む。溝に入る所の高さが資料に無い行は理由を、数が欠ける行は null を返す。 */
function nutGeometry(row: CatalogItemRow): NutGeometry | 'slotPartHeightUnknown' | null {
  if (rowDimension(row, 'slotPartHeightUnknown') === SLOT_PART_HEIGHT_UNKNOWN) return 'slotPartHeightUnknown';
  const length = rowDimension(row, 'length'), totalHeight = rowDimension(row, 'totalHeight');
  const neckHeight = rowDimension(row, 'neckHeight');
  if (length === null || totalHeight === null || neckHeight === null) return null;
  return { length, flange: totalHeight - neckHeight, neckHeight, holeOffset: rowDimension(row, 'holeOffset') ?? length / 2 };
}

/**
 * 溝用のナットの配置: +X を溝の線の向き、+Z を外の面へ向け、つばの裏(z = 0)を外の面から 肩の厚さ + つばの厚さ の深さに置き、
 * 主のねじ穴の軸(部品の原点は長さの中央なので x = holeOffset − length / 2)を溝の線の上の穴の点に合わせる。
 */
function nutPlacement(hit: SlotHit, nut: NutGeometry): Placement | null {
  const along = scaleVec3(subVec3(hit.line.end, hit.line.start), 1 / hit.length);
  const outward = scaleVec3(hit.line.inward, -1);
  const rotation = quaternionFromBasis(along, crossVec3(outward, along), outward, 1e-9);
  if (rotation === null) return null;
  const depth = addVec3(hit.point, scaleVec3(hit.line.inward, hit.line.shoulder + nut.flange));
  const position = cleanZeroVec3(subVec3(depth, scaleVec3(along, nut.holeOffset - nut.length / 2)));
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]), expressionValueFromNumber(position[2])],
    rotation };
}

interface HolePlan { readonly entry?: FrameSlotEntry; readonly failure?: FrameSlotHoleFailure }

/** 穴 1 つを照らし、溝用のナットとボルトを選んで置く。 */
function planHole(document: AssemblyDocument, request: FrameSlotFasteningRequest, selection: FasteningHoleSelection, holeIndex: number):
HolePlan {
  const fail = (code: FrameSlotCode, detail: FrameSlotHoleFailure['detail'] = {}, cause?: BoltedJointRejection): HolePlan =>
    ({ failure: { holeIndex, code, detail, ...(cause === undefined ? {} : { cause }) } });
  if (selection.hole.kind !== 'clearance') return fail('holeNotClearance');
  const resolved = resolveWorldHole(document, selection, request.partRevisions);
  if ('rejection' in resolved) return fail('holeNotPlaceable', {}, resolved.rejection);
  const hole = resolved.hole;
  const hit = nearestSlot(hole, request.frames);
  if (hit === null) return fail('notOnSlotFace');
  // 呼びが決まらない溝(null。標準の溝の組に当たらない)は、行の呼びに戻らず専用の理由で断る。ずれの判定より先に見る
  // (そうした溝は口がボルトより狭い事があり、ずれの判定が先だと「通るのは負の mm まで」という意味の無い理由になる)。
  if (hit.line.nominalWidth === null) return fail('slotNominalUnknown');
  const head = request.bolt.head, diameter = rowDimension(head.row, 'nominalDiameter') ?? NaN;
  // ボルトの径が溝の口より太い時は、ずれに依らず通らない(許すずれが負になるので、負の mm を見せずに専用の理由で断る)。
  if (diameter > hit.line.opening) return fail('boltWiderThanSlot', { thread: head.row.size, openingMm: hit.line.opening });
  // ボルトの軸が口の中を通れるずれの大きさ(口の幅と呼びの径の差の半分。どちらも行の値)。
  const allowed = (hit.line.opening - diameter) / 2;
  if (!withinMagnitude(hit.lateral, allowed)) return fail('offSlot', { offsetMm: Math.hypot(hit.lateral), allowedMm: allowed });
  // 溝幅の呼びは、溝ごとの呼び → 行の呼び(dims.slotWidth → 鍵の頭)の順。どちらも無ければ選べない。理由には使った呼びを入れる。
  const slotWidth = hit.line.nominalWidth ?? hit.frame.slotWidth;
  if (slotWidth === null) return fail('slotWidthUnknown');
  const nut = slotNut(request, slotWidth, head.row.size, hit.line.opening);
  if (nut === null) return fail('noSlotNut', { slot: slotWidth, thread: head.row.size });
  const shape = nutGeometry(nut.row);
  // 溝に入る所の高さが資料に無い行は、全高を深さとボルトの長さに使わない(選べない理由を返す)。
  if (shape === 'slotPartHeightUnknown') return fail('slotPartHeightUnknown', { nut: nut.row.size });
  if (shape === null) return fail('noSlotNut', { slot: slotWidth, thread: head.row.size });
  // ナットは穴の点から −X へ holeOffset、+X へ length − holeOffset 伸びる。
  if (hit.along - shape.holeOffset < 0 || hit.along - shape.holeOffset + shape.length > hit.length) {
    return fail('outsideSlotEnd', { alongMm: hit.along, slotLengthMm: hit.length });
  }
  // 頭の座から合わせ面まで(ざぐり・皿もみの穴は座の深さを引く。planEntryBoltedJoint と同じ数え方)。
  const thickness = selection.hole.length - head.seatDepth;
  const length = selectEntryBoltLength(head, request.bolt.availability, { minimum: thickness + hit.line.shoulder + shape.flange,
    maximum: thickness + hit.line.shoulder + hit.line.slotDepth, gripLength: thickness + Math.max(0, hit.line.shoulder - shape.neckHeight) });
  if ('code' in length) return fail('noBoltLength', {}, length);
  const placement = nutPlacement(hit, shape);
  if (placement === null) return fail('notOnSlotFace');
  return { entry: {
    holeIndex, frameComponentId: hit.frame.componentId, face: hit.line.face,
    nut: { source: createCatalogItemSource(request.nutFamily, nut.row), placement, name: request.nutFamily.partName(nut.row, {}) },
    bolt: { source: createCatalogItemSource(head.family, head.row, { length: String(length.length) }), length: length.length,
      placement: placementOnAxis(hole.matingPoint, hole.into, thickness + (head.includesHead ? head.seatDepth : head.headHeight),
        scaleVec3(hole.into, -1)),
      name: head.family.partName(head.row, { length: String(length.length) }) },
    nutDepthSimplified: hit.line.roomSimplified,
    slotPositionSimplified: hit.frame.slotPositionSimplified === true,
  } };
}

/** 溝用のナットの記録を、族の表と同じく必要な時だけ読む(静的に読むと、族の遅れた読み込みが効かなくなる)。 */
export async function loadSlotNutRecords(): Promise<readonly TSlotNutRecord[]> {
  return (await import('../catalog/families/framePartRows.js')).T_SLOT_NUT_RECORDS;
}

/** 穴の全部を照らす。1 つでも断られたら計画を返さず、穴ごとの理由を返す。 */
export function planFrameSlotFastening(document: AssemblyDocument, request: FrameSlotFasteningRequest): FrameSlotFasteningResult {
  const plans = request.holes.map((selection, index) => planHole(document, request, selection, index));
  const failures = plans.flatMap((plan) => (plan.failure === undefined ? [] : [plan.failure]));
  if (failures.length > 0 || request.holes.length === 0) return { ok: false, failures };
  return { ok: true, entries: plans.flatMap((plan) => (plan.entry === undefined ? [] : [plan.entry])) };
}

/** 計画した溝用のナットとボルトを 1 回の文書で足す(Undo 1 回。記録は残さない)。 */
export function applyFrameSlotFastening(document: AssemblyDocument, entries: readonly FrameSlotEntry[]):
{ readonly document: AssemblyDocument; readonly componentIds: readonly string[] } {
  let next = document;
  const componentIds: string[] = [];
  for (const entry of entries) {
    for (const part of [entry.nut, entry.bolt]) {
      const component = createComponentFor(next, part.source, { partName: part.name, placement: part.placement });
      next = addComponent(next, component);
      componentIds.push(component.id);
    }
  }
  return { document: next, componentIds };
}
