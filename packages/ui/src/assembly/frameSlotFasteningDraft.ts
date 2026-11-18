/**
 * フレームの溝への締結(J-02 P6b・P7)の打ちかけの純関数。状態は store の 1 か所(`assemblyFrameSlotDraft`)に置き、ここは純関数だけ。
 *
 * 選び方(P6b): ブラケットの穴の内側の面を選ぶ(Shift で足し外し)。合わせ面(フレームに当たる面)はフレームに隠れて見えないので
 * 選ばせず、穴の帯の両端の平面(穴の軸に直交し、穴の面と辺を共有する面)のうち、フレームの溝に当たる方を穴ごとに選ぶ。
 * 選んだブラケットの全部の穴(P7)は `frameSlotBracketHoles.ts` が穴の面を集め、同じ合わせ面の選び方・予告・確定を使う。
 * 予告と確定は model の `planFrameSlotHoles`(穴ごとに頭を決めて P6a の計画を作る)。確定の直前に同じ選択をいまの形へ結び直し、
 * 予告と同じ計画の時だけ 1 回の文書で足す(Undo 1 回)。記録は残さない(直す時は消して置き直す)。下書きは保存しない。
 */
import {
  applyFrameSlotFastening, bindHoleSelection, findComponent, frameSlotCandidates, holeFeatureForSelection,
  isSameSubShape, planFrameSlotHoles, profileClearanceHole, resolveSubShapeReference, type AssemblyDocument, type EntryHoleSelection,
  type FasteningGeometryContext, type FasteningHolePick, type FrameSlotFasteningResult, type FrameSlotHoleFailure, type FrameSlotPlanInputs,
  type MateTarget, type PartLibrary, type SolidBody, type SolidFaceEntry, type BoltedJointRejection, type ProfileHoleRejection,
} from '@pointercad/model';

import { subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { boltedJointGeometryContext } from './boltedJointDraft.js';

export type FaceTarget = Extract<MateTarget, { readonly kind: 'subShape' }>;
type FaceEntry = SolidBody['faces'][number];

/** 穴 1 つ: 穴の内側の面と、その合わせ面(同じ部品)。 */
export interface FrameSlotHolePair {
  readonly hole: FaceTarget;
  readonly face: FaceTarget;
}

/** 穴の軸と合わせ面の法線を平行とみなす、内積の絶対値の 1 からのずれ。 */
const AXIS_PARALLEL_TOLERANCE = 1e-6;

export interface AssemblyFrameSlotDraft {
  readonly documentId: string;
  /** 選んだ穴の内側の面(押した順)。 */
  readonly holes: readonly FaceTarget[];
  /** P7: 選んだブラケットの全部の穴で締結する時のブラケットの部品(この時は holes を使わない)。 */
  readonly bracketIds: readonly string[] | null;
  /** 六角穴付きボルトの呼び。 */
  readonly nominal: string;
  /** 溝用のナットの入れ方・材質(ナットの記録の entry・material の値)。 */
  readonly nutEntry: string;
  readonly nutMaterial: string;
  /** 相手のフレームを絞る時の部品(null は組立の溝つきのフレームの全部)。 */
  readonly frameIds: readonly string[] | null;
}

export type FrameSlotDraftPatch = Partial<Pick<AssemblyFrameSlotDraft, 'nominal' | 'nutEntry' | 'nutMaterial' | 'frameIds'>>;

/** 溝用のナットの族と記録(遅れて読む。読み終わるまで予告も確定もしない)。 */
export interface FrameSlotNutData {
  readonly family: FrameSlotPlanInputs['nutFamily'];
  readonly records: FrameSlotPlanInputs['nutRecords'];
}

/** 溝用のナットの入れ方の選択肢(記録の entry の値)。ボール付き・ストッパー付きは、選ぶと理由つきで断られる。 */
export const FRAME_SLOT_NUT_ENTRIES: readonly string[] = ['後入れ', '先入れ', '後入れ・ロック付き', '後入れ・ボール付き', '先入れ・ストッパー付き'];
/** 溝用のナットの材質の選択肢(記録の material の値)。 */
export type FrameSlotNutMaterial = 'steel' | 'stainless';
export const FRAME_SLOT_NUT_MATERIALS: readonly FrameSlotNutMaterial[] = ['steel', 'stainless'];

/** 既定は M5・後入れ・鋼(溝幅 6 の資料の行に合う呼び)。 */
export function createFrameSlotDraft(documentId: string, bracketIds: readonly string[] | null = null): AssemblyFrameSlotDraft {
  return { documentId, holes: [], bracketIds, nominal: 'M5', nutEntry: '後入れ', nutMaterial: 'steel', frameIds: null };
}

function sameFace(left: FaceTarget, right: FaceTarget): boolean {
  return left.componentId === right.componentId && isSameSubShape(left.ref, right.ref);
}

/**
 * 穴の面を選ぶ。Shift の無い時は、その穴だけにし直す。Shift の時は足し外しする(もう一度選ぶと外す)。
 * 部分形状でない選択・P7 の時は受けない(`null`)。穴の面かどうかは予告が確かめる(穴でない面は理由の行になる)。
 */
export function appendFrameSlotPick(draft: AssemblyFrameSlotDraft, target: MateTarget, add: boolean): AssemblyFrameSlotDraft | null {
  if (target.kind !== 'subShape' || draft.bracketIds !== null) return null;
  if (!add) return { ...draft, holes: [target] };
  const exists = draft.holes.some((hole) => sameFace(hole, target));
  return { ...draft, holes: exists ? draft.holes.filter((hole) => !sameFace(hole, target)) : [...draft.holes, target] };
}

/** 部品の今のボディ(面の参照のボディ)。 */
function bodyOf(view: AssemblyView, componentId: string, bodyFeatureId: string): SolidBody | null {
  const key = view.resolved.partKeys.get(componentId);
  return (key === undefined ? undefined : view.bodies.get(key)?.find((candidate) => candidate.featureId === bodyFeatureId)) ?? null;
}

/**
 * 面の選択。画面でその面をクリックした時と同じ規則(subShapeRefOf)で参照を作る: 由来の表がある形は由来の参照、
 * 由来の表を作らない形(引き算で作った資料の平板・ブラケットは untracked)は指紋の参照。参照を作れない面は選ばない。
 */
export function faceTargetOf(componentId: string, body: SolidBody, face: FaceEntry): FaceTarget | null {
  const ref = subShapeRefOf([body], subShapeElementId(body.featureId, 'face', face.index));
  return ref === null ? null : { kind: 'subShape', componentId, ref };
}

/** 合わせ面の候補: 穴の軸に直交する平面で、穴の面と辺を共有する物(辺の共有が分からない形では、軸に直交する平面の全部)。 */
export function matingFaceEntries(body: SolidBody, wall: FaceEntry): FaceEntry[] {
  const axis = wall.axis;
  if (axis === null) return [];
  return body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
    && 1 - Math.abs(face.axis[0] * axis[0] + face.axis[1] * axis[1] + face.axis[2] * axis[2]) <= AXIS_PARALLEL_TOLERANCE
    && (wall.adjacentFaces === undefined || wall.adjacentFaces.includes(face.index)));
}

/** 穴の面 1 つの、合わせ面の候補つきの組(今の形で選び直せない面は空)。 */
function holePairCandidates(view: AssemblyView, hole: FaceTarget): readonly FrameSlotHolePair[] {
  const body = bodyOf(view, hole.componentId, hole.ref.bodyFeatureId);
  const wall = currentFace(view, hole);
  if (body === null || wall === null) return [];
  return matingFaceEntries(body, wall).flatMap((face) => {
    const target = faceTargetOf(hole.componentId, body, face);
    return target === null ? [] : [{ hole, face: target }];
  });
}

type FrameSlotDraftIssue = 'needPicks' | 'stale' | 'loading' | 'noFrames';

/** 穴を結び付けられなかった理由: 締結と同じ断り、または輪の穴を通し穴と読めない理由。 */
type FrameSlotBindFailure =
  | { readonly kind: 'fastening'; readonly rejection: BoltedJointRejection }
  | { readonly kind: 'profile'; readonly rejection: ProfileHoleRejection };

/** 穴の見分け(部品の名前と、結び付けの理由。表示だけ)。 */
export interface FrameSlotHoleLabel {
  readonly component: string;
  readonly bindFailure: FrameSlotBindFailure | null;
}

export type FrameSlotDraftPreview =
  | { readonly kind: 'issue'; readonly issue: FrameSlotDraftIssue }
  | { readonly kind: 'plan'; readonly result: FrameSlotFasteningResult; readonly holes: readonly FrameSlotHoleLabel[] };

/** 確定を押せるか(1 つでも断られたら押せない)。窓・状態欄・確定の操作が同じ判定を使う。 */
export function frameSlotPreviewReady(preview: FrameSlotDraftPreview | null): boolean {
  return preview !== null && preview.kind === 'plan' && preview.result.ok;
}

function holePickOf(context: FasteningGeometryContext, pair: FrameSlotHolePair): FasteningHolePick | null {
  const component = findComponent(context.document, pair.hole.componentId);
  const featureId = component === undefined ? null : holeFeatureForSelection(context, component, pair.hole.ref);
  return featureId === null ? null : { componentId: pair.hole.componentId, holeFeatureId: featureId, holeFace: pair.hole.ref,
    matingFace: pair.face.ref };
}

interface BoundHoles {
  readonly holes: readonly EntryHoleSelection[];
  readonly labels: readonly FrameSlotHoleLabel[];
}

/** 選んだ面の今の面の表の行(部品のボディで選び直す。選び直せない・曖昧なら null)。 */
function currentFace(view: AssemblyView, target: FaceTarget): SolidFaceEntry | null {
  const body = bodyOf(view, target.componentId, target.ref.bodyFeatureId);
  const resolved = body === null ? null : resolveSubShapeReference(body, target.ref);
  return body === null || resolved?.status !== 'matched' ? null : body.faces.at(resolved.match.reference.index) ?? null;
}

/**
 * 穴のフィーチャーで作っていない通し穴(断面の輪の穴を押し出したブラケット)を、今の面の表から通し穴の選択にする。
 * 形が通し穴でない時は理由を返す(面を今の形で選び直せない時は締結と同じ holeFaceMissing)。
 */
function profileHole(context: FasteningGeometryContext, view: AssemblyView, pair: FrameSlotHolePair):
EntryHoleSelection | FrameSlotBindFailure {
  const component = findComponent(context.document, pair.hole.componentId);
  const hole = currentFace(view, pair.hole), mating = currentFace(view, pair.face);
  const body = bodyOf(view, pair.hole.componentId, pair.hole.ref.bodyFeatureId);
  if (component === undefined || hole === null || mating === null || body === null) {
    return { kind: 'fastening', rejection: { code: 'holeFaceMissing', detail: { componentId: pair.hole.componentId } } };
  }
  const read = profileClearanceHole(component, context.partRevisions, { holeFeatureId: pair.hole.ref.bodyFeatureId, hole, mating,
    matingRef: pair.face.ref, bodyFaces: body.faces, bodyEdges: body.edges });
  if (typeof read === 'string') return { kind: 'profile', rejection: read };
  return 'code' in read ? { kind: 'fastening', rejection: read } : read;
}

/** 締結の結び付けの結果を、選択か理由にそろえる。 */
function boundOf(context: FasteningGeometryContext, view: AssemblyView, pair: FrameSlotHolePair): EntryHoleSelection | FrameSlotBindFailure {
  const pick = holePickOf(context, pair);
  if (pick === null) return profileHole(context, view, pair);
  const bound = bindHoleSelection(context, pick);
  return 'code' in bound ? { kind: 'fastening', rejection: bound } : bound;
}

/**
 * 選んだ穴をいまの形へ結び付ける。穴のフィーチャーの穴は締結と同じ結び付け(ざぐり・皿もみの入口を読む)、
 * 穴のフィーチャーの無い穴は面の表から通し穴にする。結べない穴は理由つきの見分けにする(予告の赤い行)。
 */
function bindPairs(context: FasteningGeometryContext, view: AssemblyView, pairs: readonly FrameSlotHolePair[]): BoundHoles {
  const holes: EntryHoleSelection[] = [];
  const labels: FrameSlotHoleLabel[] = [];
  for (const pair of pairs) {
    const bound = boundOf(context, view, pair);
    const name = findComponent(context.document, pair.hole.componentId)?.name ?? pair.hole.componentId;
    if ('kind' in bound) labels.push({ component: name, bindFailure: bound });
    else { holes.push(bound); labels.push({ component: name, bindFailure: null }); }
  }
  return { holes, labels };
}

/** 予告と確定が同じに作る計画の入力。 */
function planInputs(document: AssemblyDocument, view: AssemblyView, library: PartLibrary, draft: AssemblyFrameSlotDraft,
  nut: FrameSlotNutData | null, pairs: readonly FrameSlotHolePair[]): { readonly inputs: FrameSlotPlanInputs; readonly labels: readonly FrameSlotHoleLabel[] }
  | FrameSlotDraftIssue {
  if (view.sourceDocument !== document) return 'stale';
  if (nut === null) return 'loading';
  if (pairs.length === 0) return 'needPicks';
  const context = boltedJointGeometryContext(document, view, library);
  const bound = bindPairs(context, view, pairs);
  const frames = frameSlotCandidates(document, view.resolved.placements, draft.frameIds === null ? null : new Set(draft.frameIds));
  if (frames.length === 0) return 'noFrames';
  return { inputs: { holes: bound.holes, frames, choices: { nominal: draft.nominal, nutEntry: draft.nutEntry, nutMaterial: draft.nutMaterial },
    nutFamily: nut.family, nutRecords: nut.records, partRevisions: context.partRevisions }, labels: bound.labels };
}

/** 結べなかった穴が 1 つでもあれば、その穴の理由を計画の断りとして返す(計画は作らない)。 */
function bindFailures(labels: readonly FrameSlotHoleLabel[]): FrameSlotFasteningResult | null {
  // 理由の文は見分けの bindFailure から出す(frameSlotReasons.ts)。計画の断りは「置けない」の印だけ。
  const failures = labels.flatMap((label, holeIndex): FrameSlotHoleFailure[] => (label.bindFailure === null ? []
    : [{ holeIndex, code: 'holeNotPlaceable', detail: {},
      ...(label.bindFailure.kind === 'fastening' ? { cause: label.bindFailure.rejection } : {}) }]));
  return failures.length === 0 ? null : { ok: false, failures };
}

/** 組を決めた穴の予告(組を選ぶ前の候補の試しにも使う)。 */
export function previewFrameSlotPairs(document: AssemblyDocument, view: AssemblyView, library: PartLibrary, draft: AssemblyFrameSlotDraft,
  nut: FrameSlotNutData | null, pairs: readonly FrameSlotHolePair[]): FrameSlotDraftPreview {
  const prepared = planInputs(document, view, library, draft, nut, pairs);
  if (typeof prepared === 'string') return { kind: 'issue', issue: prepared };
  return { kind: 'plan', holes: prepared.labels, result: bindFailures(prepared.labels) ?? planFrameSlotHoles(document, prepared.inputs) };
}

/**
 * 穴ごとに、フレームの溝に当たる合わせ面の組を選ぶ(候補を 1 つずつ予告し、最初に通った物。どれも通らない時は、
 * 「溝の面に当たっていない」以外の理由の候補を優先して残し、まとめた予告に理由を出す)。候補の無い穴は、穴の面を
 * 合わせ面にも置いた組で残す(結び付けが理由の行にする。選んだ穴を黙って落とさない)。
 */
export function chooseFrameSlotPairs(document: AssemblyDocument, view: AssemblyView, library: PartLibrary, draft: AssemblyFrameSlotDraft,
  nut: FrameSlotNutData | null, candidates: readonly { readonly hole: FaceTarget; readonly pairs: readonly FrameSlotHolePair[] }[]):
  readonly FrameSlotHolePair[] {
  return candidates.map(({ hole, pairs }) => {
    let chosen: FrameSlotHolePair = pairs.at(0) ?? { hole, face: hole };
    for (const pair of pairs) {
      const preview = previewFrameSlotPairs(document, view, library, draft, nut, [pair]);
      if (preview.kind !== 'plan') return chosen;
      if (preview.result.ok) return pair;
      if (preview.result.failures.some((failure) => failure.code !== 'notOnSlotFace')) chosen = pair;
    }
    return chosen;
  });
}

/** 予告と、予告に使った穴の組(確定は同じ組で作り直す)。 */
export interface FrameSlotPreviewWithPairs {
  readonly preview: FrameSlotDraftPreview;
  readonly pairs: readonly FrameSlotHolePair[];
}

/** P6b の予告: 選んだ穴の面ごとに合わせ面を選び、まとめて予告する。 */
export function previewFrameSlotDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary,
  draft: AssemblyFrameSlotDraft, nut: FrameSlotNutData | null): FrameSlotPreviewWithPairs {
  const candidates = draft.holes.map((hole) => ({ hole, pairs: holePairCandidates(view, hole) }));
  const pairs = chooseFrameSlotPairs(document, view, library, draft, nut, candidates);
  return { preview: previewFrameSlotPairs(document, view, library, draft, nut, pairs), pairs };
}

/**
 * 確定: 予告に使った組で、いまの形から計画を作り直し、通った時だけ 1 回の文書で足す。違えば文書を変えずに作り直した予告を返す。
 */
export function commitFrameSlotDraft(document: AssemblyDocument, view: AssemblyView, library: PartLibrary, draft: AssemblyFrameSlotDraft,
  nut: FrameSlotNutData | null, pairs: readonly FrameSlotHolePair[]):
  { readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly preview: FrameSlotDraftPreview } {
  const preview = previewFrameSlotPairs(document, view, library, draft, nut, pairs);
  if (preview.kind !== 'plan' || !preview.result.ok) return { ok: false, preview };
  return { ok: true, ...applyFrameSlotFastening(document, preview.result.entries) };
}
