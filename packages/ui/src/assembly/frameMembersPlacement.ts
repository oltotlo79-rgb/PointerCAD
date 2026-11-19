/**
 * フレームの一括配置(J-01 包み 1・2)の店の側: 長さを持つ部材(アルミフレームの族の行・鋼材の行)と線の列から、部材 N 本を置いた文書を作る。
 * 店の動作(`placeFrameMembers`)はこの文書を 1 回で入れるので、Undo 1 回で全部戻る。保存の形は変えない(並べた部材は普通の部品)。
 * 1 本ごとの長さ・配置は model の `planFrameMembers`、保存の形・名前・材質は 1 本ずつ置く時と同じ道
 * (族は `commitCatalogItemChoice`、鋼材は `commitStandardPartChoice`)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, buildStandardPartFromSource, createCatalogItemSource, createComponentFor, planFrameMembers, PRODUCT_CATALOG_REGISTRY,
  steelProductFromSource, steelSectionBounds, type AssemblyDocument, type ComponentSource, type FrameCornerRule, type FrameLine,
  type FrameMembersResult,
} from '@pointercad/model';

import { commitCatalogItemChoice } from './catalogFamilyChoices.js';
import { withFrameAccessories, type FrameAccessoryRequest } from './frameMembersAccessory.js';
import { commitStandardPartChoice } from './standardPartPicker.js';

/** 並べる部材: 族の行(欄の値。長さは線ごとに入れ替える)か、鋼材の行(選ぶ画面の呼びの鍵 `steel:<行の鍵>`)。 */
export type FrameMemberChoice =
  | { readonly kind: 'catalogItem'; readonly familyId: string; readonly itemKey: string; readonly values: Readonly<Record<string, string>> }
  | { readonly kind: 'steel'; readonly choiceKey: string };

/** 並べる部材と、線の列・断面の向き・端の扱い。 */
export interface FrameMembersRequest {
  readonly member: FrameMemberChoice;
  readonly lines: readonly FrameLine[];
  readonly up: readonly [number, number, number];
  readonly quarterTurns: number;
  readonly startExtension: number;
  readonly endExtension: number;
  readonly corners: FrameCornerRule;
  /** 突き当てで、通す部材を後の線の部材へ入れ替える角の番号(予告の角の並びの番号)。 */
  readonly swapThrough: readonly number[];
  /** 並べた部材に付ける付属の組(A2。端は部材ごとに決める)。無ければ付けない。 */
  readonly accessory?: FrameAccessoryRequest;
}

type PlanRejection = Extract<FrameMembersResult, { readonly ok: false }>['reason'];
type FrameMembersPlan = Extract<FrameMembersResult, { readonly ok: true }>;

/**
 * 並べた結果(置いた部品の id)か、置かなかった理由(部材が無い・長さを持たない部材・欄の値で作れない・留めの欄を持たない部材
 * 〔留めの欄を持たない族〕・線の計画の理由)。
 */
export type FrameMembersPlacement =
  | { readonly ok: true; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'unavailable' | 'unknownChoice' | 'notLinear' | 'invalidOption' | 'miterUnsupported' | 'accessoryRefused'
    | PlanRejection; readonly lineIndex: number | null };

type Rejected = Extract<FrameMembersPlacement, { readonly ok: false }>;
type SectionBounds = Parameters<typeof planFrameMembers>[1]['section'];

/** 長さ 1 本ぶんの置く中身(保存の形・名前・材質)。作れない長さは null。 */
interface PlacedPart {
  readonly source: ComponentSource;
  readonly name: string;
  readonly materialId?: string;
}

type MiterEnd = FrameMembersPlan['members'][number]['startMiter'];

interface MemberKind {
  readonly section: SectionBounds;
  /** 留めの欄(始点・終点)を持つ部材か(アルミフレームの族)。 */
  readonly miter: boolean;
  readonly partFor: (lengthMm: number, startMiter: MiterEnd, endMiter: MiterEnd) => PlacedPart | null;
}

const MITER_KEYS = ['startMiter', 'endMiter'];

function catalogMember(choice: Extract<FrameMemberChoice, { readonly kind: 'catalogItem' }>): MemberKind | Rejected {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(choice.familyId);
  const row = family?.rows.find((candidate) => candidate.key === choice.itemKey);
  if (family === undefined || row === undefined) return { ok: false, reason: 'unknownChoice', lineIndex: null };
  if (family.stock !== 'linear' || family.sectionBounds === undefined) return { ok: false, reason: 'notLinear', lineIndex: null };
  // 入れていない欄は族の初めの値で読む(保存の形を作る道と同じ)。
  const section = family.sectionBounds(row, createCatalogItemSource(family, row, choice.values).options);
  if (section === null) return { ok: false, reason: 'invalidOption', lineIndex: null };
  const miter = MITER_KEYS.every((key) => family.options.some((spec) => spec.key === key));
  return { section, miter, partFor: (lengthMm, startMiter, endMiter) => {
    // 留めの端だけ欄を書く(切らない端は書かない。保存の形は留めを使わない部品と同じ)。
    const committed = commitCatalogItemChoice(choice.familyId, choice.itemKey, { ...choice.values, length: String(lengthMm),
      ...(startMiter === null ? {} : { startMiter }), ...(endMiter === null ? {} : { endMiter }) });
    return committed.ok ? committed.value : null;
  } };
}

/** 選んだ部材が角の扱い「留め」を使えるか(留めの欄を持つアルミフレームの族と、鋼材。J-01 包み 5・6)。 */
export function frameMemberMiterSupported(choice: FrameMemberChoice): boolean {
  const member = choice.kind === 'steel' ? steelMember(choice) : catalogMember(choice);
  return !('ok' in member) && member.miter;
}

/** 選んだ部材の断面の外形(局所。外形の中心を線に乗せて置く)。作れない部材は null(安全柵の柱と横の材の面の位置に使う。E-12)。 */
export function frameMemberSection(choice: FrameMemberChoice): SectionBounds | null {
  const member = choice.kind === 'steel' ? steelMember(choice) : catalogMember(choice);
  return 'ok' in member ? null : member.section;
}

function steelMember(choice: Extract<FrameMemberChoice, { readonly kind: 'steel' }>): MemberKind | Rejected {
  const probe = commitStandardPartChoice('structuralSection', choice.choiceKey, '1000');
  const row = probe.ok ? steelProductFromSource(probe.value.source) : undefined;
  if (row === undefined) return { ok: false, reason: 'unknownChoice', lineIndex: null };
  const section = steelSectionBounds(row);
  if (section === null) return { ok: false, reason: 'notLinear', lineIndex: null };
  return { section, miter: true, partFor: (lengthMm, startMiter, endMiter) => {
    const committed = commitStandardPartChoice('structuralSection', choice.choiceKey, String(lengthMm));
    if (!committed.ok) return null;
    if (startMiter === null && endMiter === null || committed.value.source.kind !== 'standardPart') return committed.value;
    // 留めの端だけ欄を書き(J-01 包み 6)、その保存で形が組める事を確かめる(切らない端は書かない)。
    const source = { ...committed.value.source, options: { ...committed.value.source.options,
      ...(startMiter === null ? {} : { startMiter }), ...(endMiter === null ? {} : { endMiter }) } };
    return buildStandardPartFromSource(source) === null ? null : { ...committed.value, source };
  } };
}

type FramePlan = FrameMembersPlan;

function resolvePlan(request: FrameMembersRequest): { readonly member: MemberKind; readonly plan: FramePlan } | Rejected {
  const member = request.member.kind === 'steel' ? steelMember(request.member) : catalogMember(request.member);
  if ('ok' in member) return member;
  if (request.corners === 'miter' && !member.miter) return { ok: false, reason: 'miterUnsupported', lineIndex: null };
  const plan = planFrameMembers(request.lines, { section: member.section, up: request.up, quarterTurns: request.quarterTurns,
    startExtension: request.startExtension, endExtension: request.endExtension, corners: request.corners,
    swapThrough: request.swapThrough });
  return plan.ok ? { member, plan } : plan;
}

/** 並べる前の予告: 1 本ごとの長さ・端の伸び縮みと角の扱い(置かない)。作れない時は理由。 */
export function frameMembersPreview(request: FrameMembersRequest): FramePlan | Rejected {
  const resolved = resolvePlan(request);
  return 'ok' in resolved ? resolved : resolved.plan;
}

/** 線の列から部材を並べた文書を作る。1 本でも作れなければ何も置かずに理由を返す。 */
export function frameMembersDocument(assembly: AssemblyDocument, request: FrameMembersRequest):
{ readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[] } | Rejected {
  const resolved = resolvePlan(request);
  if ('ok' in resolved) return resolved;
  const { member, plan } = resolved;
  let document = assembly;
  const componentIds: string[] = [];
  for (const planned of plan.members) {
    // 長さは planFrameMembers が mm の 1e-6 で丸めた値(端数で切断の一覧の行が分かれない)。
    const part = member.partFor(planned.lengthMm, planned.startMiter, planned.endMiter);
    if (part === null) return { ok: false, reason: 'invalidOption', lineIndex: planned.lineIndex };
    const [x, y, z] = planned.placement.position;
    const component = createComponentFor(document, part.source, { partName: part.name, placement: {
      position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
      rotation: planned.placement.rotation } });
    document = addComponent(document, part.materialId === undefined ? component : { ...component, materialId: part.materialId });
    componentIds.push(component.id);
  }
  const accessorized = request.accessory === undefined ? null : withFrameAccessories(document, request.lines, plan, componentIds, request.accessory);
  if (accessorized !== null && !accessorized.ok) return { ok: false, reason: accessorized.reason, lineIndex: accessorized.lineIndex };
  return { ok: true, document: accessorized?.document ?? document, componentIds: [...componentIds, ...(accessorized?.accessoryIds ?? [])] };
}
