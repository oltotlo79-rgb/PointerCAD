/**
 * 置いた部材の分割と統合(E-11)。部材(長さを持つ族の部品と鋼材の部品)1 本を指定の位置で 2 本に分け、同じ線の上で端が接する
 * 同じ断面の部材をまとめて 1 本にする。どちらも次の文書を作るだけの純関数で、店はこれを 1 回で入れる(元に戻す 1 回で戻る)。
 *
 * - 部材の局所の +Z が長さの向きで、z = 0 が始点の端(一括配置 `planFrameMembers` と同じ置き方)。長さは長い側の面の長さ。
 * - 分けた後ろの部材は新しい部品で、位置は元の位置 + 回転 × (0, 0, 分ける位置)。切った端は直角(留めを外す)。
 * - 合致・ジョイント・ボルト締結・連動・文脈の参照・分解の段・梁の解析の入力に指されている部材は扱わない(数を返して断る)。
 *   フレームの接続の記録(`frameJoints`)だけは、分けた・まとめた部品へ付け替える。まとめる所の端どうしをつなぐ記録があれば断る
 *   (板や締結部品を勝手に消さない。統括の決定 2026-11-18 15:0x)。
 * - 長さの欄は数に置き換わる(元が式でも)。
 */
import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';

import { exceedsMagnitude } from '../../numericTolerance.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { nextComponentName } from '../assemblyEdit.js';
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { catalogItemRejection } from '../catalog/source.js';
import { nextComponentId } from '../createAssemblyDocument.js';
import { rotateVector } from '../placementMath.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { buildStandardPartFromSource } from '../standard/buildStandardPart.js';
import { steelLength, steelProductFromSource } from '../standard/steelCatalog.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { FrameJointRecord } from './frameJointRecord.js';

/**
 * 部材を選んでいない(まとめるのは 2 本から)・部材でない部品がある・族の行(鋼材の製品)が混ざる・分ける位置が範囲の外・
 * その長さでは作れない・合致などに指されている・軸が揃わない・端が接しない・接する端に留めがある・接する端をつなぐ記録がある。
 */
type MemberSplitMergeRejection ='noSelection' | 'notMember' | 'mixed' | 'outOfRange' | 'invalidOption' | 'referenced'
  | 'notAligned' | 'notTouching' | 'miteredJoin' | 'jointAtJoin';

export type MemberSplitMergeResult =
  | {
    readonly ok: true;
    readonly document: AssemblyDocument;
    /** 結果の部材の部品(分けたら前・後ろの順、まとめたら残った 1 つ)と、その長さ(mm)。 */
    readonly componentIds: readonly string[];
    readonly lengths: readonly number[];
  }
  | { readonly ok: false; readonly reason: MemberSplitMergeRejection; readonly count: number | null };

const FAMILY_KEY = 'family', ITEM_KEY = 'item', LENGTH_KEY = 'length';
const MITER_KEYS = ['startMiter', 'endMiter'] as const;
/** 端どうしを同じ点・同じ向きとみなす差(mm・向きの成分)。 */
const TOLERANCE = 1e-6;
/** 長さを丸める桁(mm の 1e-6。一括配置と同じ)。 */
const ROUNDING = 1e6;
/** 部材を指しうる文書の欄(部品の id をどこかに持つ記録の並び)。名前を付けた視点と部品表の設定は数えない。 */
const REFERENCE_FIELDS = ['mates', 'joints', 'mechanismCouplings', 'camCouplings', 'crossLevelGearCouplings', 'crossLevelCamCouplings',
  'contextReferences', 'presentation', 'jointOccurrenceConnections', 'boltedJoints', 'beamAnalysisInputs'] as const;

const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING;
const refused = (reason: MemberSplitMergeRejection, count: number | null = null): MemberSplitMergeResult => ({ ok: false, reason, count });

interface MemberInfo {
  readonly component: AssemblyComponent;
  readonly source: StandardPartSource;
  /** 同じ断面かを比べる鍵(族は族と行、鋼材は製品)。 */
  readonly kindKey: string;
  readonly length: number;
  /** 始点の端(局所の原点)のワールドの点と、長さの向き・断面の局所の +X の向き。 */
  readonly start: Vec3;
  readonly axis: Vec3;
  readonly side: Vec3;
}

/** 留めの欄の値(切らない端は null)。 */
function miterOf(source: StandardPartSource, key: typeof MITER_KEYS[number]): string | null {
  const value = source.options[key];
  return value === undefined || value === 'none' ? null : value;
}

function lengthOf(source: StandardPartSource): number | null {
  const text = source.options[LENGTH_KEY];
  if (text === undefined) return null;
  if (source.catalog !== 'catalogItem') return steelLength(text)?.value ?? null;
  const result = evaluateExpression(text);
  return result.ok && Number.isFinite(result.value.value) ? result.value.value : null;
}

function memberInfo(assembly: AssemblyDocument, componentId: string): MemberInfo | null {
  const component = assembly.components.find((candidate) => candidate.id === componentId);
  if (component?.source.kind !== 'standardPart') return null;
  const source = component.source;
  const kindKey = source.catalog === 'catalogItem' ? `${source.options[FAMILY_KEY] ?? ''}/${source.options[ITEM_KEY] ?? ''}`
    : steelProductFromSource(source)?.key;
  const length = lengthOf(source);
  if (kindKey === undefined || length === null || !(length > 0)) return null;
  const { position, rotation } = component.placement;
  return { component, source, kindKey, length, start: [position[0].value, position[1].value, position[2].value],
    axis: rotateVector(rotation, [0, 0, 1]), side: rotateVector(rotation, [1, 0, 0]) };
}

/** 長さと留めを替えた保存の形(ほかの欄は今のまま。切らない端は欄を書かない)。 */
function withLength(source: StandardPartSource, length: number, startMiter: string | null, endMiter: string | null): StandardPartSource {
  const kept = Object.entries(source.options).filter(([key]) => key !== MITER_KEYS[0] && key !== MITER_KEYS[1]);
  return { ...source, options: { ...Object.fromEntries(kept), [LENGTH_KEY]: String(round(length)),
    ...(startMiter === null ? {} : { startMiter }), ...(endMiter === null ? {} : { endMiter }) } };
}

/** その保存の形で部材の形を作れるか(族は族の形の台本、鋼材は鋼材の形。一括の書き換えと同じ確かめ)。 */
function sourceBuilds(source: StandardPartSource, registry: CatalogRegistry): boolean {
  if (source.catalog !== 'catalogItem') return buildStandardPartFromSource(source) !== null;
  const family = registry.loaded(source.options[FAMILY_KEY] ?? '');
  const row = family?.rows.find((candidate) => candidate.key === source.options[ITEM_KEY]);
  if (family === undefined || row === undefined || catalogItemRejection(source, registry) !== null) return false;
  return family.build(row, Object.fromEntries(Object.entries(source.options).filter(([key]) => key !== FAMILY_KEY && key !== ITEM_KEY)))
    !== null;
}

/**
 * 部品を指している記録の数(合致・ジョイント・連動・文脈の参照・分解の段・入れ子の接続・ボルト締結・梁の解析の入力。フレームの接続の
 * 記録は数えない)。記録ごとに、JSON の中に部品の id(引用符つき)があるかで数える(component-3 と component-30 を取り違えない)。
 * 分割と統合(E-11)と、結合の入れ替えと伸縮(E-13)が同じ数え方を使う。
 */
export function componentReferenceCount(assembly: AssemblyDocument, componentIds: readonly string[]): number {
  const quoted = componentIds.map((id) => JSON.stringify(id));
  let count = 0;
  for (const field of REFERENCE_FIELDS) {
    const value: unknown = assembly[field];
    const records: readonly unknown[] = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const record of records) {
      const text = JSON.stringify(record);
      if (quoted.some((id) => text.includes(id))) count++;
    }
  }
  return count;
}

/** 接続の記録の部材の指し先を付け替える(map が返す新しい指し先。同じなら記録をそのまま返す)。 */
function remapJoints(records: readonly FrameJointRecord[] | undefined,
  map: (member: FrameJointRecord['members'][number], record: FrameJointRecord) => FrameJointRecord['members'][number]):
  readonly FrameJointRecord[] | undefined {
  return records?.map((record) => {
    const members = record.members.map((member) => map(member, record));
    return members.every((member, index) => member === record.members[index]) ? record : { ...record, members };
  });
}

/** 部品のワールドの位置(局所の原点)。 */
function positionOf(assembly: AssemblyDocument, componentId: string): Vec3 | null {
  const position = assembly.components.find((candidate) => candidate.id === componentId)?.placement.position;
  return position === undefined ? null : [position[0].value, position[1].value, position[2].value];
}

/** 置いた時の名前の「部品名」(「部品名:番号」の時は番号を外す)。 */
function baseName(name: string): string {
  const match = /^(.*):[0-9]+$/u.exec(name);
  return match?.[1] ?? name;
}

/**
 * 部材 1 本を、始点の端から distance(mm)の所で 2 本に分ける。前の 1 本は元の部品のまま(id・名前・固定・色などを保つ)で、
 * 後ろの 1 本は新しい部品。作れない時は何も変えずに理由。
 */
export function planMemberSplit(assembly: AssemblyDocument, componentId: string, distance: number,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): MemberSplitMergeResult {
  const member = memberInfo(assembly, componentId);
  if (member === null) return refused('notMember');
  const referenced = componentReferenceCount(assembly, [componentId]);
  if (referenced > 0) return refused('referenced', referenced);
  const at = round(distance);
  if (!Number.isFinite(at) || !(at > 0) || !(at < round(member.length))) return refused('outOfRange');
  const first = withLength(member.source, at, miterOf(member.source, 'startMiter'), null);
  const second = withLength(member.source, member.length - at, null, miterOf(member.source, 'endMiter'));
  if (!sourceBuilds(first, registry) || !sourceBuilds(second, registry)) return refused('invalidOption');
  const start = addVec3(member.start, scaleVec3(member.axis, at));
  const secondId = nextComponentId(assembly);
  const secondComponent: AssemblyComponent = { ...member.component, id: secondId,
    name: nextComponentName(assembly, baseName(member.component.name)), source: second,
    placement: { position: [expressionValueFromNumber(round(start[0])), expressionValueFromNumber(round(start[1])),
      expressionValueFromNumber(round(start[2]))], rotation: member.component.placement.rotation } };
  const components = assembly.components.flatMap((component) => component.id === componentId
    ? [{ ...component, source: first }, secondComponent] : [component]);
  // 終点の記録は後ろの 1 本へ、途中の記録は板の位置を軸へ写した値が分ける位置より後なら後ろの 1 本へ。
  const frameJoints = remapJoints(assembly.frameJoints, (target, record) => {
    if (target.componentId !== componentId || target.part === 'start') return target;
    if (target.part === 'end') return { ...target, componentId: secondId };
    const bracket = positionOf(assembly, record.bracket.componentId);
    return bracket !== null && dotVec3(subVec3(bracket, member.start), member.axis) > at ? { ...target, componentId: secondId } : target;
  });
  return { ok: true, document: { ...assembly, components, ...(frameJoints === undefined ? {} : { frameJoints }) },
    componentIds: [componentId, secondId], lengths: [at, round(member.length - at)] };
}

/** 軸の向きと断面の向きが同じで、始点が同じ直線の上にあるか。 */
function aligned(base: MemberInfo, other: MemberInfo): boolean {
  const same = (a: Vec3, b: Vec3): boolean => lengthVec3(subVec3(a, b)) <= TOLERANCE;
  return same(base.axis, other.axis) && same(base.side, other.side)
    && lengthVec3(crossVec3(subVec3(other.start, base.start), base.axis)) <= TOLERANCE;
}

/**
 * 同じ線の上で端が接する、同じ断面の部材をまとめて 1 本にする。残るのは軸の上で一番前の部材の部品で、ほかの部品は消す。
 * 作れない時は何も変えずに理由。
 */
export function planMemberMerge(assembly: AssemblyDocument, componentIds: readonly string[],
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): MemberSplitMergeResult {
  if (new Set(componentIds).size < 2) return refused('noSelection');
  const members = [...new Set(componentIds)].map((id) => memberInfo(assembly, id));
  const base = members[0];
  if (base === null || base === undefined || members.some((member) => member === null)) return refused('notMember');
  const infos = members.filter((member): member is MemberInfo => member !== null);
  if (infos.some((member) => member.kindKey !== base.kindKey)) return refused('mixed');
  const referenced = componentReferenceCount(assembly, infos.map((member) => member.component.id));
  if (referenced > 0) return refused('referenced', referenced);
  if (infos.some((member) => !aligned(base, member))) return refused('notAligned');
  const along = (member: MemberInfo): number => dotVec3(subVec3(member.start, base.start), base.axis);
  const ordered = [...infos].sort((a, b) => along(a) - along(b));
  for (const [index, member] of ordered.slice(1).entries()) {
    const previous = ordered[index];
    if (previous === undefined || exceedsMagnitude(along(previous) + previous.length - along(member), TOLERANCE)) return refused('notTouching');
    if (miterOf(previous.source, 'endMiter') !== null || miterOf(member.source, 'startMiter') !== null) return refused('miteredJoin');
  }
  const first = ordered[0], last = ordered.at(-1);
  if (first === undefined || last === undefined) return refused('notMember');
  // 接する端(前の部材の終点・後ろの部材の始点)を指す記録があれば、2 本を板でつないでいるので断る。
  const joinEnds = (member: FrameJointRecord['members'][number]): boolean => ordered.some((info, index) =>
    info.component.id === member.componentId && ((member.part === 'end' && index < ordered.length - 1) || (member.part === 'start' && index > 0)));
  const atJoin = (assembly.frameJoints ?? []).filter((record) => record.members.some(joinEnds)).length;
  if (atJoin > 0) return refused('jointAtJoin', atJoin);
  const total = round(ordered.reduce((sum, member) => sum + member.length, 0));
  const merged = withLength(first.source, total, miterOf(first.source, 'startMiter'), miterOf(last.source, 'endMiter'));
  if (!sourceBuilds(merged, registry)) return refused('invalidOption');
  const keepId = first.component.id;
  const removed = new Set(ordered.slice(1).map((member) => member.component.id));
  const components = assembly.components.filter((component) => !removed.has(component.id))
    .map((component) => component.id === keepId ? { ...component, source: merged } : component);
  // 一番後ろの終点と、途中を指す記録は、残る部品へ付け替える(始点・終点・途中の別は保つ)。
  const frameJoints = remapJoints(assembly.frameJoints, (target) => removed.has(target.componentId) ? { ...target, componentId: keepId } : target);
  return { ok: true, document: { ...assembly, components, ...(frameJoints === undefined ? {} : { frameJoints }) },
    componentIds: [keepId], lengths: [total] };
}
