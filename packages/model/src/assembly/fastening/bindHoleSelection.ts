/**
 * 利用者が選んだ穴と合わせ面を、いまの部品文書と形へ結び付けて締結の選択を作る(EX-06、修正4)。
 *
 * 選んだ時に渡された面の指紋は「どの面か」を指すだけで、寸法の正本にしない。穴の呼び・ピッチ・
 * ねじ部の長さは部品文書の穴のフィーチャーから、軸・半径・長さ・合わせ面は現在のボディで選び直した
 * 面から読む。部品の出どころの版・フィーチャー・面のどれかが変わっていれば断る(確定の直前にも
 * 同じ関数で結び直す)。
 */

import type { CurrentOriginIndex, HoleFaceOrigin, HoleThreadGrooveOrigin, OriginBinding } from '../../geometry/subShapeOrigin.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { MateSubShapeGeometry, SolidBody, SubShapeReferenceResolution } from '../../kernelBridge.js';
import type { PartDocument } from '../../part/types.js';
import { addVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { findComponent } from '../assemblyEdit.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { componentSourceKey } from './frames.js';
import {
  type BoltedJointRejection, FASTENING_DIRECTION_TOLERANCE, FASTENING_LENGTH_TOLERANCE_MM,
  type FasteningHoleSelection, type FasteningHoleSpec,
} from './types.js';

/**
 * 締結の穴の枠だけで使う、一時的な実らせんの組の選択(保存しない)。同一性は穴の由来(featureId・center・placement)と
 * ボディ。当たった面の番地は、選んだ時と結び直す時に「その面が今の組の一員か」を確かめるためだけに使う。
 */
export interface ModeledThreadGroupPick {
  readonly bodyFeatureId: string;
  readonly origin: HoleFaceOrigin;
  readonly hitFaceIndex: number;
}

/** 利用者が画面で選んだもの。面は選んだ時の参照(指紋)。実らせんの穴は組の選択(holeGroup)で選ぶ。 */
export type FasteningHolePick = {
  readonly componentId: string;
  readonly holeFeatureId: string;
  /** 相手の部品に当てる平らな面。 */
  readonly matingFace: SubShapeRef;
} & (
  /** 穴の円筒面(ねじ穴では下穴の面)。 */
  | { readonly holeFace: SubShapeRef; readonly holeGroup?: never }
  | { readonly holeGroup: ModeledThreadGroupPick; readonly holeFace?: never });

/** 実らせんの組を今のボディで結び直した結果。 */
export type ModeledThreadResolution =
  | { readonly status: 'matched'; readonly evidence: ModeledThreadEvidence; readonly axisOrigin: Vec3 }
  | { readonly status: 'missing' };

/**
 * 今の番地の面に kernel が付けた穴の壁の由来(makeHole.ts の bore/wall)。番地を主張する binding が
 * ちょうど 1 つで unique の時だけ `hole`。保存の指紋や径から作らない。
 */
export type HoleWallOrigin =
  | { readonly status: 'hole'; readonly origin: HoleFaceOrigin }
  | { readonly status: 'untracked' | 'unnamed' | 'ambiguous' | 'notHoleWall' };

export type FaceResolution =
  | { readonly status: 'matched'; readonly geometry: MateSubShapeGeometry; readonly wall: HoleWallOrigin;
      /** 実らせんの壁の今の形の証拠(由来の鎖・隣の面・端の面)。無ければ実らせんとして結ばない。 */
      readonly modeledThread?: ModeledThreadEvidence }
  /** body-missing: 参照のボディが今のボディの一覧に無い(ボディはあるが面・履歴が無いのとは分ける)。 */
  | { readonly status: 'missing'; readonly reason?: 'body-missing' }
  | { readonly status: 'ambiguous' };

/** binding が今の番地の面を主張するか(unique・merged の今の面、split の候補)。 */
function claimsFace(binding: OriginBinding, faceIndex: number): boolean {
  switch (binding.state) {
    case 'unique':
    case 'merged': return binding.current.kind === 'face' && binding.current.index === faceIndex;
    case 'split': return binding.candidates.some((candidate) => candidate.kind === 'face' && candidate.index === faceIndex);
    case 'missing':
    case 'untracked': return false;
  }
}

/** 今のボディの由来の表から、面の今の番地の穴の壁の由来を引く。分かれた・まとまった面は順で選ばずに断る。 */
export function holeWallOriginAt(origins: CurrentOriginIndex | undefined, faceIndex: number): HoleWallOrigin {
  if (origins === undefined || origins.state !== 'tracked') return { status: 'untracked' };
  const claims = origins.bindings.filter((binding) => claimsFace(binding, faceIndex));
  const claim = claims[0];
  if (claim === undefined) return { status: 'unnamed' };
  if (claims.length !== 1 || claim.state !== 'unique') return { status: 'ambiguous' };
  if (claim.origin.shapeKind !== 'face') return { status: 'notHoleWall' };
  const identity = claim.origin.identity;
  return identity.kind === 'hole-face' && identity.stage === 'bore' && identity.role === 'wall'
    ? { status: 'hole', origin: identity } : { status: 'notHoleWall' };
}

/**
 * 実らせんの明示経路だけが使う、壁の小片と自分の溝の面(kernel の makeThread が native の履歴で付けた由来)。
 * 選んだ面は bore/wall の split の候補の1枚で、溝は同じ穴(featureId・center・placement の全て)の thread/groove が
 * ちょうど1つ。どの面も他の binding に主張されていない。普通の split は `holeWallOriginAt` が今までどおり断る。
 * これは由来だけの条件で、隣の面と端の輪の確認(現在の形)を別に通らないと締結に使わない。
 */
export type ModeledThreadWall =
  | { readonly status: 'candidate'; readonly origin: HoleFaceOrigin; readonly walls: readonly number[]; readonly grooves: readonly number[] }
  | { readonly status: 'untracked' | 'unnamed' | 'ambiguous' | 'notThreadWall' };

/** 保存の値を、欄の順に依らない文字列にする(同じ穴の比較用。番地は含まない)。 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown): unknown => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

function sameHole(a: HoleFaceOrigin | HoleThreadGrooveOrigin, b: HoleFaceOrigin | HoleThreadGrooveOrigin): boolean {
  return a.featureId === b.featureId && canonical(a.center) === canonical(b.center) && canonical(a.placement) === canonical(b.placement);
}

function claimedFaces(binding: OriginBinding): readonly number[] | null {
  if (binding.state === 'unique') return binding.current.kind === 'face' ? [binding.current.index] : null;
  if (binding.state !== 'split' || binding.candidates.some((candidate) => candidate.kind !== 'face')) return null;
  return binding.candidates.map((candidate) => candidate.index);
}

export function modeledThreadWallAt(origins: CurrentOriginIndex | undefined, faceIndex: number): ModeledThreadWall {
  if (origins === undefined || origins.state !== 'tracked') return { status: 'untracked' };
  const claims = origins.bindings.filter((binding) => claimsFace(binding, faceIndex));
  const claim = claims[0];
  if (claim === undefined) return { status: 'unnamed' };
  if (claims.length !== 1 || claim.state !== 'split') return { status: 'ambiguous' };
  const wall = claim.origin.shapeKind === 'face' ? claim.origin.identity : null;
  if (wall === null || wall.kind !== 'hole-face' || wall.stage !== 'bore' || wall.role !== 'wall') return { status: 'notThreadWall' };
  const grooves = origins.bindings.filter((binding) => binding.origin.shapeKind === 'face'
    && binding.origin.identity.kind === 'hole-face' && binding.origin.identity.stage === 'thread' && sameHole(binding.origin.identity, wall));
  const groove = grooves[0];
  const walls = claimedFaces(claim), grooveFaces = groove === undefined ? null : claimedFaces(groove);
  if (grooves.length !== 1 || walls === null || grooveFaces === null) return { status: 'notThreadWall' };
  // 壁と溝のどの面も、この2つの binding 以外に主張されていない(merged・別の由来・重なりを断る)。
  for (const index of [...walls, ...grooveFaces]) {
    if (origins.bindings.filter((binding) => claimsFace(binding, index)).length !== 1) return { status: 'ambiguous' };
  }
  return { status: 'candidate', origin: wall, walls, grooves: grooveFaces };
}

/** 実らせんの壁の小片の鎖が今の形で閉じている証拠。軸方向の範囲は選んだ面の axisOrigin からの距離。 */
export interface ModeledThreadEvidence {
  readonly origin: HoleFaceOrigin;
  readonly radius: number;
  readonly axis: Vec3;
  readonly span: readonly [number, number];
}

type BodyFace = SolidBody['faces'][number];

function parallel(a: Vec3 | null, b: Vec3): boolean {
  const unitA = unit(a);
  return unitA !== null && Math.abs(Math.abs(dotVec3(unitA, b)) - 1) <= FASTENING_DIRECTION_TOLERANCE;
}

/**
 * 由来の候補(`modeledThreadWallAt`)を、今のボディの面で確かめる。
 * - 壁の小片は全て同じ半径・同じ軸の円筒で、隣の面の一覧と有限の軸方向の範囲を持つ。
 * - 壁と溝の全ての面が隣の一覧を持ち(無ければ断る)、その隣は壁・溝か、範囲の端にある軸に直交する平面だけ
 *   (後からの窓・溝・溝の端だけを削る加工を断る)。
 * - 小片の範囲はすき間なしにつながる(min/max で途中の欠けを埋めない)。両端にそれぞれ端の平面が接する。
 */
export function modeledThreadEvidence(body: Pick<SolidBody, 'origins' | 'faces'>, faceIndex: number): ModeledThreadEvidence | null {
  const candidate = modeledThreadWallAt(body.origins, faceIndex);
  if (candidate.status !== 'candidate') return null;
  const faces = body.faces;
  const picked = faces[faceIndex];
  const axis = picked === undefined ? null : unit(picked.axis);
  const origin = picked?.axisOrigin;
  if (picked === undefined || axis === null || origin == null || picked.radius === null || !origin.every(Number.isFinite)) return null;
  const radius = picked.radius;
  const chain = new Set([...candidate.walls, ...candidate.grooves]);
  const ranges: [number, number][] = [];
  const walls: BodyFace[] = [];
  for (const index of candidate.walls) {
    const wall = faces[index];
    const extent = wall?.cylinderAxialExtent, wallOrigin = wall?.axisOrigin;
    if (wall === undefined || wall.surfaceKind !== 'cylinder' || wall.radius === null || wall.adjacentFaces === undefined
      || extent == null || wallOrigin == null || !parallel(wall.axis, axis)
      || Math.abs(wall.radius - radius) > FASTENING_LENGTH_TOLERANCE_MM) return null;
    const offset = subVec3(wallOrigin, origin), along = dotVec3(offset, axis);
    // 同じ軸の上にあること(軸に垂直なずれが許容内)。
    if (lengthVec3(subVec3(offset, scaleVec3(axis, along))) > FASTENING_LENGTH_TOLERANCE_MM) return null;
    const signed = dotVec3(unit(wall.axis) ?? axis, axis) > 0 ? 1 : -1;
    const ends = [along + signed * extent[0], along + signed * extent[1]];
    if (!ends.every(Number.isFinite)) return null;
    ranges.push([Math.min(...ends), Math.max(...ends)]);
    walls.push(wall);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0];
  if (first === undefined) return null;
  let reach = first[1];
  for (const [start, end] of ranges.slice(1)) {
    if (start > reach + FASTENING_LENGTH_TOLERANCE_MM) return null;
    reach = Math.max(reach, end);
  }
  const span: readonly [number, number] = [first[0], reach];
  if (!(span[1] - span[0] > FASTENING_LENGTH_TOLERANCE_MM)) return null;
  const endOf = (index: number): 0 | 1 | null => {
    const face = faces[index];
    if (face === undefined || face.surfaceKind !== 'plane' || !parallel(face.axis, axis)) return null;
    const at = dotVec3(subVec3(face.centroid, origin), axis);
    return Math.abs(at - span[0]) <= FASTENING_LENGTH_TOLERANCE_MM ? 0
      : Math.abs(at - span[1]) <= FASTENING_LENGTH_TOLERANCE_MM ? 1 : null;
  };
  const touched = [false, false];
  const chainFaces = [...walls, ...candidate.grooves.map((index) => faces[index])];
  for (const face of chainFaces) {
    // 鎖の全ての面(壁・溝の平面の端を含む)が今の隣の一覧を持つこと。無い一覧を完全とみなさない。
    if (face?.adjacentFaces === undefined) return null;
    for (const neighbour of face.adjacentFaces) {
      if (chain.has(neighbour)) continue;
      const end = endOf(neighbour);
      if (end === null) return null;
      if (face.surfaceKind === 'cylinder') touched[end] = true;
    }
  }
  return touched[0] === true && touched[1] === true ? { origin: candidate.origin, radius, axis, span } : null;
}

export interface FasteningGeometryContext {
  readonly document: AssemblyDocument;
  /** 抱き込んだ部品の内容の版。出どころの鍵に入れる。 */
  readonly partRevisions: ReadonlyMap<string, string>;
  /** 置いた部品のいまの部品文書(抱き込んだ文書、または規格部品の台本から組んだ文書)。 */
  readonly partDocument: (component: AssemblyComponent) => PartDocument | null;
  /** 置いた部品のいまの形で、保存された面の参照を選び直す。曖昧なら採用しない。 */
  readonly resolveFace: (component: AssemblyComponent, reference: SubShapeRef) => FaceResolution;
  /** 実らせんの組の選択を、いまのボディで結び直す。無い文脈では組の選択を断る。 */
  readonly resolveModeledThread?: (component: AssemblyComponent, group: ModeledThreadGroupPick) => ModeledThreadResolution;
}

/**
 * 実らせんの組を今のボディで結び直す既定の口。ボディの id が同じで、当たった番地の面から今の証拠が作れ、
 * その由来が選んだ時の由来と全て(featureId・center・placement)同じ時だけ matched。
 */
export function modeledThreadResolverFromBodies(
  bodiesOf: (component: AssemblyComponent) => readonly SolidBody[] | null,
): NonNullable<FasteningGeometryContext['resolveModeledThread']> {
  return (component, group) => {
    // 同じ id のボディはちょうど1つの時だけ(普通の面の選択 subShapeRefOf と同じ。順や中身で選ばない)。
    const matches = bodiesOf(component)?.filter((candidate) => candidate.featureId === group.bodyFeatureId) ?? [];
    const body = matches.length === 1 ? matches[0] : undefined;
    // 無効なボディ(作り直しで壊れた形など)は、普通の参照の作成・結び直しと同じく使わない。
    const evidence = body === undefined || !body.isValid ? null : modeledThreadEvidence(body, group.hitFaceIndex);
    const axisOrigin = body?.faces[group.hitFaceIndex]?.axisOrigin;
    if (evidence === null || axisOrigin == null || canonical(evidence.origin) !== canonical(group.origin)) return { status: 'missing' };
    return { status: 'matched', evidence, axisOrigin };
  };
}

/** 当たった面から、組の選択を作る(由来とボディは今の証拠から取り、番地は所属の確かめだけに残す)。 */
export function modeledThreadGroupPickAt(body: SolidBody, faceIndex: number): ModeledThreadGroupPick | null {
  const evidence = body.isValid ? modeledThreadEvidence(body, faceIndex) : null;
  return evidence === null ? null : { bodyFeatureId: body.featureId, origin: evidence.origin, hitFaceIndex: faceIndex };
}

/** 再計算済みのボディから面を選び直す既定の口(`resolveSubShapeReference` の照合をそのまま使う)。 */
export function faceResolverFromBodies(
  bodiesOf: (component: AssemblyComponent) => readonly SolidBody[] | null,
  resolve: (body: SolidBody, reference: SubShapeRef) => SubShapeReferenceResolution,
): FasteningGeometryContext['resolveFace'] {
  return (component, reference) => {
    const body = bodiesOf(component)?.find((candidate) => candidate.featureId === reference.bodyFeatureId);
    if (body === undefined) return { status: 'missing', reason: 'body-missing' };
    const resolution = resolve(body, reference);
    // 照合した候補の今の番地で、同じボディの由来の表を引く(幾何だけを残して番地を捨てない)。
    if (resolution.status !== 'matched') return { status: resolution.status };
    const index = resolution.match.reference.index;
    const modeledThread = modeledThreadEvidence(body, index);
    return { status: 'matched', geometry: resolution.match.geometry, wall: holeWallOriginAt(body.origins, index),
      ...(modeledThread === null ? {} : { modeledThread }) };
  };
}

function reject(code: BoltedJointRejection['code'], detail: BoltedJointRejection['detail']): BoltedJointRejection {
  return { code, detail };
}

function unit(vector: Vec3 | null): Vec3 | null {
  if (vector === null || !vector.every((value) => Number.isFinite(value))) return null;
  const size = lengthVec3(vector);
  return !Number.isFinite(size) || size <= FASTENING_LENGTH_TOLERANCE_MM ? null : scaleVec3(vector, 1 / size);
}

interface BoundCylinder {
  readonly radius: number;
  readonly axis: Vec3;
  readonly center: Vec3;
  readonly length: number;
}

function cylinderOf(geometry: MateSubShapeGeometry): BoundCylinder | null {
  if (geometry.kind !== 'face' || geometry.surfaceKind !== 'cylinder' || geometry.radius === null) return null;
  const axis = unit(geometry.axis);
  const radius = geometry.radius;
  const origin = geometry.axisOrigin, span = geometry.cylinderSpan;
  if (axis === null || !Number.isFinite(radius) || radius <= 0 || origin === undefined || span === undefined
    || !origin.every(Number.isFinite) || !span.every(Number.isFinite)
    || span[1] - span[0] <= FASTENING_LENGTH_TOLERANCE_MM) return null;
  // 現在のB-repが全周を確認した範囲だけを使う。面積/重心も保存指紋も寸法の代用にしない。
  const length = span[1] - span[0];
  const center = addVec3(origin, scaleVec3(axis, span[0] / 2 + span[1] / 2));
  if (!Number.isFinite(length) || !center.every(Number.isFinite)) return null;
  return { radius, axis, center, length };
}

/** 組の結び直しの証拠から円筒を作る(範囲は当たった面の axisOrigin から測ってある)。 */
function groupCylinder(group: Extract<ModeledThreadResolution, { readonly status: 'matched' }>): BoundCylinder | null {
  const { evidence, axisOrigin } = group;
  const length = evidence.span[1] - evidence.span[0];
  const center = addVec3(axisOrigin, scaleVec3(evidence.axis, (evidence.span[0] + evidence.span[1]) / 2));
  return Number.isFinite(length) && length > FASTENING_LENGTH_TOLERANCE_MM && center.every(Number.isFinite)
    ? { radius: evidence.radius, axis: evidence.axis, center, length } : null;
}

/** 実らせんの証拠の範囲から、選んだ面の今の軸の上に円筒を作る(範囲は同じ axisOrigin から測ってある)。 */
function modeledCylinder(geometry: MateSubShapeGeometry, evidence: ModeledThreadEvidence): BoundCylinder | null {
  if (geometry.kind !== 'face' || geometry.surfaceKind !== 'cylinder' || geometry.axisOrigin === undefined) return null;
  const axis = unit(geometry.axis);
  if (axis === null || !parallel(axis, evidence.axis) || !geometry.axisOrigin.every(Number.isFinite)) return null;
  const direction = dotVec3(axis, evidence.axis) > 0 ? 1 : -1;
  const length = evidence.span[1] - evidence.span[0];
  const center = addVec3(geometry.axisOrigin, scaleVec3(evidence.axis, (evidence.span[0] + evidence.span[1]) / 2));
  return Number.isFinite(length) && center.every(Number.isFinite)
    ? { radius: evidence.radius, axis: scaleVec3(evidence.axis, direction), center, length } : null;
}

function planeOf(geometry: MateSubShapeGeometry): { readonly point: Vec3; readonly normal: Vec3 } | null {
  if (geometry.kind !== 'face' || geometry.surfaceKind !== 'plane') return null;
  const normal = unit(geometry.axis);
  return normal === null || !geometry.position.every((value) => Number.isFinite(value)) ? null : { point: geometry.position, normal };
}

/** 円筒の両端のうち平面に載る側。載る端から円筒の中へ向かう向きを返す。 */
function entryOf(cylinder: BoundCylinder, plane: { readonly point: Vec3; readonly normal: Vec3 }):
  { readonly origin: Vec3; readonly into: Vec3 } | null {
  for (const side of [1, -1] as const) {
    const end = addVec3(cylinder.center, scaleVec3(cylinder.axis, side * cylinder.length / 2));
    if (Math.abs(dotVec3(subVec3(end, plane.point), plane.normal)) <= FASTENING_LENGTH_TOLERANCE_MM) {
      return { origin: end, into: scaleVec3(cylinder.axis, -side) };
    }
  }
  return null;
}

function sameDiameter(radius: number, diameter: number): boolean {
  return Number.isFinite(diameter) && Math.abs(2 * radius - diameter) <= FASTENING_LENGTH_TOLERANCE_MM;
}

/** ねじの入口が合わせ面か反対の面か。フィーチャーの面を選び直して決める。 */
function threadStartOf(
  context: FasteningGeometryContext, component: AssemblyComponent, featureFace: SubShapeRef,
  entry: { readonly origin: Vec3; readonly into: Vec3 }, length: number, threadLength: number, holeBodyId: string,
): number | null {
  if (threadLength >= length - FASTENING_LENGTH_TOLERANCE_MM) return 0;
  // フィーチャーの面は加工前のボディを指す。そのボディは穴あけで消費され、今のボディの一覧に無い。
  // 元のボディが無い(body-missing)時で、保存の参照が由来を持つ時だけ、同じ由来を今の穴のボディで選び直す。
  // 元のボディで曖昧・面や履歴が無い時と、指紋だけの参照は選び直さない(別のボディで救わない)。
  const direct = context.resolveFace(component, featureFace);
  const consumed = direct.status === 'missing' && direct.reason === 'body-missing';
  const resolved = consumed && featureFace.origin !== undefined && featureFace.bodyFeatureId !== holeBodyId
    ? context.resolveFace(component, { ...featureFace, bodyFeatureId: holeBodyId }) : direct;
  const plane = resolved.status === 'matched' ? planeOf(resolved.geometry) : null;
  if (plane === null) return null;
  const offset = dotVec3(subVec3(plane.point, entry.origin), entry.into);
  if (Math.abs(offset) <= FASTENING_LENGTH_TOLERANCE_MM) return 0;
  return Math.abs(offset - length) <= FASTENING_LENGTH_TOLERANCE_MM ? length - threadLength : null;
}

/**
 * 選んだ円筒面を今の形で選び直し、kernel が付けた穴の壁の由来からフィーチャーの id を返す。
 * 径・番号・順・最後のフィーチャーでは選ばない。由来が無い・曖昧なら `null`(理由は `bindHoleSelection` が返す)。
 * 返した id は `bindHoleSelection` が同じ由来と形で照合し直す。
 */
export function holeFeatureForSelection(
  context: FasteningGeometryContext, component: AssemblyComponent, holeFace: SubShapeRef,
): string | null {
  const resolved = context.resolveFace(component, holeFace);
  return resolved.status === 'matched' && resolved.wall.status === 'hole' ? resolved.wall.origin.featureId : null;
}

/** 選んだ面の今の由来が、このフィーチャーの下穴の壁であること。由来が無い時は形だけで認めない。 */
function wallMismatch(wall: HoleWallOrigin, featureId: string): BoltedJointRejection['detail'] | null {
  if (wall.status !== 'hole') return { reason: 'holeIdentityUnproven', origin: wall.status };
  return wall.origin.featureId === featureId ? null
    : { reason: 'holeIdentityMismatch', holeFeatureId: featureId, originFeatureId: wall.origin.featureId };
}

/**
 * 選んだものを現在の形へ結び付ける。合えば部品の局所座標の選択を返す。
 * 座ぐり・皿もみの入口がある穴は、円筒の端が合わせ面に載らないので `holeNotOnMatingFace` で断る。
 */
export function bindHoleSelection(
  context: FasteningGeometryContext, pick: FasteningHolePick,
): FasteningHoleSelection | BoltedJointRejection {
  const component = findComponent(context.document, pick.componentId);
  if (component === undefined) return reject('componentMissing', { componentId: pick.componentId });
  if (component.suppressed) return reject('componentSuppressed', { componentId: component.id });
  if (component.source.kind === 'subAssembly') return reject('componentNotPlaceable', { componentId: component.id });
  const sourceKey = componentSourceKey(component, context.partRevisions);
  if (sourceKey === null) return reject('missingSourceRevision', { componentId: component.id });
  const feature = context.partDocument(component)?.solids.find((solid) => solid.id === pick.holeFeatureId);
  if (feature === undefined || feature.suppressed || (feature.kind !== 'hole' && feature.kind !== 'threadHole')) {
    return reject('holeFeatureMissing', { componentId: component.id, holeFeatureId: pick.holeFeatureId });
  }
  const holeBody = pick.holeGroup === undefined ? pick.holeFace.bodyFeatureId : pick.holeGroup.bodyFeatureId;
  if (holeBody !== pick.matingFace.bodyFeatureId) {
    return reject('holeFaceMismatch', { componentId: component.id, reason: 'differentBodies' });
  }
  if (pick.holeGroup !== undefined) {
    // 実らせんの組はねじ穴だけ。結び直しの口が無い・今の組と合わない時は断る(番地や指紋で救わない)。
    if (feature.kind !== 'threadHole') {
      return reject('holeFeatureMissing', { componentId: component.id, holeFeatureId: pick.holeFeatureId });
    }
    const group = context.resolveModeledThread?.(component, pick.holeGroup) ?? { status: 'missing' as const };
    const cylinder = group.status === 'matched' ? groupCylinder(group) : null;
    if (group.status !== 'matched' || cylinder === null) return reject('holeFaceMissing', { componentId: component.id, status: 'missing' });
    const mismatch = wallMismatch({ status: 'hole', origin: group.evidence.origin }, feature.id);
    if (mismatch !== null) return reject('holeFaceMismatch', { componentId: component.id, ...mismatch });
    return boundSelection(context, component, pick, feature, sourceKey, cylinder);
  }
  const holeFace = context.resolveFace(component, pick.holeFace);
  // 実らせんはねじ穴だけ。由来の鎖と今の形の証拠がそろった時だけ、分かれた壁の範囲を使う。
  const modeled = feature.kind === 'threadHole' && holeFace.status === 'matched' ? holeFace.modeledThread : undefined;
  const cylinder = modeled !== undefined && holeFace.status === 'matched' ? modeledCylinder(holeFace.geometry, modeled)
    : holeFace.status === 'matched' ? cylinderOf(holeFace.geometry) : null;
  if (cylinder === null) return reject('holeFaceMissing', { componentId: component.id, status: holeFace.status,
    ...(holeFace.status === 'matched' ? { reason: 'uncertifiedCylinderBand' } : {}) });
  if (holeFace.status === 'matched') {
    const mismatch = modeled !== undefined
      ? wallMismatch({ status: 'hole', origin: modeled.origin }, feature.id) : wallMismatch(holeFace.wall, feature.id);
    if (mismatch !== null) return reject('holeFaceMismatch', { componentId: component.id, ...mismatch });
  }
  return boundSelection(context, component, pick, feature, sourceKey, cylinder);
}

type HoleFeature = Extract<NonNullable<ReturnType<FasteningGeometryContext['partDocument']>>['solids'][number],
  { readonly kind: 'hole' | 'threadHole' }>;

/** 結び直した円筒から、径・合わせ面・入口・ねじの範囲を確かめて選択を作る(面の選択と組の選択で同じ)。 */
function boundSelection(
  context: FasteningGeometryContext, component: AssemblyComponent, pick: FasteningHolePick, feature: HoleFeature,
  sourceKey: string, cylinder: BoundCylinder,
): FasteningHoleSelection | BoltedJointRejection {
  const drill = feature.kind === 'hole' ? feature.diameter.value : feature.drillDiameter.value;
  if (!sameDiameter(cylinder.radius, drill)) {
    return reject('holeFaceMismatch', { componentId: component.id, diameter: 2 * cylinder.radius, featureDiameter: drill });
  }
  const mating = context.resolveFace(component, pick.matingFace);
  const plane = mating.status === 'matched' ? planeOf(mating.geometry) : null;
  if (plane === null) return reject('matingFaceMissing', { componentId: component.id, status: mating.status });
  if (Math.abs(dotVec3(cylinder.axis, plane.normal)) < 1 - FASTENING_DIRECTION_TOLERANCE) {
    return reject('faceAxisMismatch', { componentId: component.id, holeFeatureId: feature.id });
  }
  const entry = entryOf(cylinder, plane);
  if (entry === null) return reject('holeNotOnMatingFace', { componentId: component.id, holeFeatureId: feature.id });
  let hole: FasteningHoleSpec;
  if (feature.kind === 'hole') {
    if (feature.depth.kind !== 'through') return reject('unsupportedHole', { componentId: component.id, reason: 'blindPlainHole' });
    hole = { kind: 'clearance', diameter: 2 * cylinder.radius, length: cylinder.length };
  } else if (feature.depth.kind === 'through') {
    const threadLength = Math.min(feature.threadLength.value, cylinder.length);
    const holeBodyId = pick.holeGroup === undefined ? pick.holeFace.bodyFeatureId : pick.holeGroup.bodyFeatureId;
    const threadStart = threadStartOf(context, component, feature.face, entry, cylinder.length, threadLength, holeBodyId);
    if (threadStart === null) return reject('threadEntryUnknown', { componentId: component.id, holeFeatureId: feature.id });
    hole = { kind: 'throughThreaded', nominal: feature.designation, pitch: feature.pitch.value,
      threadStart, threadLength, length: cylinder.length };
  } else {
    hole = { kind: 'blindThreaded', nominal: feature.designation, pitch: feature.pitch.value,
      usableThreadDepth: Math.min(feature.threadLength.value, cylinder.length), drillDepth: cylinder.length };
  }
  return {
    componentId: component.id, sourceKey, holeFeatureId: feature.id, matingFace: pick.matingFace, hole,
    axisOrigin: entry.origin, axisDirection: entry.into, matingFaceNormal: scaleVec3(entry.into, -1),
  };
}
