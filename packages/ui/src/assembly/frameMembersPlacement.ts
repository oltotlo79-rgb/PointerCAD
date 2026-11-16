/**
 * フレームの一括配置(J-01 包み 1・2)の店の側: 長さを持つ部材(アルミフレームの族の行・鋼材の行)と線の列から、部材 N 本を置いた文書を作る。
 * 店の動作(`placeFrameMembers`)はこの文書を 1 回で入れるので、Undo 1 回で全部戻る。保存の形は変えない(並べた部材は普通の部品)。
 * 1 本ごとの長さ・配置は model の `planFrameMembers`、保存の形・名前・材質は 1 本ずつ置く時と同じ道
 * (族は `commitCatalogItemChoice`、鋼材は `commitStandardPartChoice`)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, createCatalogItemSource, createComponentFor, planFrameMembers, PRODUCT_CATALOG_REGISTRY, steelProductFromSource,
  steelSectionBounds, type AssemblyDocument, type ComponentSource, type FrameCornerRule, type FrameLine, type FrameMembersResult,
} from '@pointercad/model';

import { commitCatalogItemChoice } from './catalogFamilyChoices.js';
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
}

type PlanRejection = Extract<FrameMembersResult, { readonly ok: false }>['reason'];

/** 並べた結果(置いた部品の id)か、置かなかった理由(部材が無い・長さを持たない部材・欄の値で作れない・線の計画の理由)。 */
export type FrameMembersPlacement =
  | { readonly ok: true; readonly componentIds: readonly string[] }
  | { readonly ok: false; readonly reason: 'unavailable' | 'unknownChoice' | 'notLinear' | 'invalidOption' | PlanRejection;
    readonly lineIndex: number | null };

type Rejected = Extract<FrameMembersPlacement, { readonly ok: false }>;
type SectionBounds = Parameters<typeof planFrameMembers>[1]['section'];

/** 長さ 1 本ぶんの置く中身(保存の形・名前・材質)。作れない長さは null。 */
interface PlacedPart {
  readonly source: ComponentSource;
  readonly name: string;
  readonly materialId?: string;
}

interface MemberKind {
  readonly section: SectionBounds;
  readonly partFor: (lengthMm: number) => PlacedPart | null;
}

function catalogMember(choice: Extract<FrameMemberChoice, { readonly kind: 'catalogItem' }>): MemberKind | Rejected {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(choice.familyId);
  const row = family?.rows.find((candidate) => candidate.key === choice.itemKey);
  if (family === undefined || row === undefined) return { ok: false, reason: 'unknownChoice', lineIndex: null };
  if (family.stock !== 'linear' || family.sectionBounds === undefined) return { ok: false, reason: 'notLinear', lineIndex: null };
  // 入れていない欄は族の初めの値で読む(保存の形を作る道と同じ)。
  const section = family.sectionBounds(row, createCatalogItemSource(family, row, choice.values).options);
  if (section === null) return { ok: false, reason: 'invalidOption', lineIndex: null };
  return { section, partFor: (lengthMm) => {
    const committed = commitCatalogItemChoice(choice.familyId, choice.itemKey, { ...choice.values, length: String(lengthMm) });
    return committed.ok ? committed.value : null;
  } };
}

function steelMember(choice: Extract<FrameMemberChoice, { readonly kind: 'steel' }>): MemberKind | Rejected {
  const probe = commitStandardPartChoice('structuralSection', choice.choiceKey, '1000');
  const row = probe.ok ? steelProductFromSource(probe.value.source) : undefined;
  if (row === undefined) return { ok: false, reason: 'unknownChoice', lineIndex: null };
  const section = steelSectionBounds(row);
  if (section === null) return { ok: false, reason: 'notLinear', lineIndex: null };
  return { section, partFor: (lengthMm) => {
    const committed = commitStandardPartChoice('structuralSection', choice.choiceKey, String(lengthMm));
    return committed.ok ? committed.value : null;
  } };
}

type FramePlan = Extract<FrameMembersResult, { readonly ok: true }>;

function resolvePlan(request: FrameMembersRequest): { readonly member: MemberKind; readonly plan: FramePlan } | Rejected {
  const member = request.member.kind === 'steel' ? steelMember(request.member) : catalogMember(request.member);
  if ('ok' in member) return member;
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
    const part = member.partFor(planned.lengthMm);
    if (part === null) return { ok: false, reason: 'invalidOption', lineIndex: planned.lineIndex };
    const [x, y, z] = planned.placement.position;
    const component = createComponentFor(document, part.source, { partName: part.name, placement: {
      position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
      rotation: planned.placement.rotation } });
    document = addComponent(document, part.materialId === undefined ? component : { ...component, materialId: part.materialId });
    componentIds.push(component.id);
  }
  return { ok: true, document, componentIds };
}
