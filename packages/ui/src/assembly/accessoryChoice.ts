/**
 * 付属の組の画面の側の純関数(A2。設計 wip/auto-accessory-design.md §3・§5。統括の決定 2026-11-19 02:08: 既定は全長)。
 *
 * - 選ぶ窓・一括配置・一筆書きに出す組は、置く本体に当てはまる組だけ(model の `accessoryCandidatesForPart`。鋼材や機械要素の組も登録すれば同じ欄に出る)。
 *   当てはまる組が 1 つも無い本体には欄を出さない。
 * - 選んだ組と指定は、アプリを閉じるまで 1 つだけ覚える(設定にも文書にも持たない。最近使った物 K-07b と同じ)。
 * - 一括配置と一筆書きでは、端を利用者に選ばせず、端ごとに決める: 何にも会わない端と、突き当てで通した部材の端(相手の外の面まで出る)に付ける。
 *   当てる部材の端・留めの端・3 本以上が会う端・直角でない端には付けない。
 * - 鋼材の配管用炭素鋼鋼管(SGP)には、鋼管の端の継手の組を出す(8 分類の窓の鋼材と、一括配置・一筆書きの鋼材の部材。K-28 束 3)。
 *   継手の族の id と、エルボ・チーズの枝の向きを指定に持つ。
 */
import { evaluateExpression } from '@pointercad/expression';
import {
  ACCESSORY_SET_IDS, accessoryCandidatesForPart, accessoryCandidatesForSource, BEARING_RING_FAMILY_IDS, bearingRingCandidates,
  createCatalogItemSource, defaultBoltGrip, PIPE_END_FITTING_FAMILY_IDS, PRODUCT_CATALOG_REGISTRY, type AccessoryCandidate,
  type AccessoryChoices, type AccessoryEndReference, type AccessoryEnds, type AccessorySetId, type CatalogRegistry, type ComponentSource,
  type FrameLine, type FrameMembersResult,
} from '@pointercad/model';

import type { FrameAccessoryRequest } from './frameMembersAccessory.js';
import { commitStandardPartChoice, type StandardPartCategory } from './standardPartPicker.js';
import type { FrameMemberChoice } from './frameMembersPlacement.js';

/** 族と行の型(model の公開の名前に族の型が無いので、登録口の読み込みの戻りから取る)。 */
type CatalogFamily = NonNullable<ReturnType<CatalogRegistry['loaded']>>;
type CatalogItemRow = CatalogFamily['rows'][number];

/** 本体に当てはまる組 1 つと、その候補の行。 */
export interface AccessoryOption {
  readonly setId: AccessorySetId;
  readonly candidates: readonly AccessoryCandidate[];
  /** ボルトの座金とナットの組(A4)の既定の締め付ける厚さ(mm。ばね座金の有・無の順)。ほかの組は持たない。 */
  readonly defaultGripMm?: { readonly plain: number; readonly spring: number | null };
}

/** 画面で選んだ付属。setId が null は「付けない」。 */
export interface AccessorySelection {
  readonly setId: AccessorySetId | null;
  readonly ends: AccessoryEnds;
  readonly endReference: AccessoryEndReference;
  /** 候補の行の鍵。空なら候補の先頭。 */
  readonly itemKey: string;
  /** ボルトの組の締め付ける厚さの欄の文字(空・数でない時は既定の値)。 */
  readonly gripText?: string;
  /** ボルトの組のばね座金の有無。 */
  readonly springWasher?: boolean;
  /** 鋼管の端の継手のエルボ・チーズの枝の向き(管の軸のまわりの 90° の回しの数。無ければ 0)。 */
  readonly turn?: AccessoryTurn;
}

/** エルボ・チーズの枝の向き(model の指定の型)。 */
export type AccessoryTurn = NonNullable<AccessoryChoices['turn']>;

const NO_ACCESSORY: AccessorySelection = { setId: null, ends: 'both', endReference: 'overall', itemKey: '' };

/** 今の 8 分類のボルトに当てはまるボルトの組(A4)。ボルトでない・座金かナットの行が無い・既定の厚さが 0 以下なら空。 */
function boltAccessoryOptions(source: ComponentSource | null): readonly AccessoryOption[] {
  if (source === null) return [];
  const plain = defaultBoltGrip(source, false);
  if (!plain.ok) return [];
  const spring = defaultBoltGrip(source, true);
  return [{ setId: 'bolt-washer-nut', candidates: [], defaultGripMm: { plain: plain.value, spring: spring.ok ? spring.value : null } }];
}

/** 8 分類の深溝玉軸受に当てはまる止め輪の組(A6。軸用・穴用のうち、呼びが一致する行がある組)。止め輪の族を読む前は空。 */
function bearingRingOptions(source: ComponentSource): readonly AccessoryOption[] {
  return (['bearing-shaft-rings', 'bearing-bore-rings'] as const).flatMap((setId): AccessoryOption[] => {
    const result = bearingRingCandidates(source, setId, PRODUCT_CATALOG_REGISTRY);
    return result.ok ? [{ setId, candidates: result.value }] : [];
  });
}

/** 鋼材の配管用炭素鋼鋼管(SGP)に当てはまる鋼管の端の継手の組(K-28 束 3)。鋼管でない・継手の族を読む前・合う行が無い時は空。 */
function pipeFittingOptions(source: ComponentSource): readonly AccessoryOption[] {
  const result = accessoryCandidatesForSource(source, 'pipe-end-fittings', PRODUCT_CATALOG_REGISTRY);
  return result.ok ? [{ setId: 'pipe-end-fittings', candidates: result.value }] : [];
}

/** 今の 8 分類の窓の組が使う族(深溝玉軸受は止め輪の族、鋼材は鋼管の端の継手の族。窓が先に読み込む)。 */
export function standardAccessoryFamilies(category: StandardPartCategory): readonly string[] {
  return category === 'deepGrooveBallBearing' ? BEARING_RING_FAMILY_IDS : category === 'structuralSection' ? PIPE_END_FITTING_FAMILY_IDS : [];
}

/**
 * 今の 8 分類の窓の選んだ呼びに当てはまる組(六角ボルトは座金とナット、深溝玉軸受は止め輪、鋼材の SGP の鋼管は端の継手。
 * 置く時と同じ道で保存の形を作る)。
 */
export function standardAccessoryOptionsFor(category: StandardPartCategory, choiceKey: string, lengthSource: string,
  dimensionSeries: 'annexJA' | 'main', threadSeries: 'coarse' | 'fine'): readonly AccessoryOption[] {
  if (category !== 'hexBolt' && category !== 'deepGrooveBallBearing' && category !== 'structuralSection') return [];
  const committed = commitStandardPartChoice(category, choiceKey, lengthSource, dimensionSeries, threadSeries);
  if (!committed.ok) return [];
  if (category === 'structuralSection') return pipeFittingOptions(committed.value.source);
  return category === 'hexBolt' ? boltAccessoryOptions(committed.value.source) : bearingRingOptions(committed.value.source);
}

/** ボルトの組の今の指定(締め付ける厚さは欄の数、無ければ既定)。組を選んでいない・当てはまらない時は null。 */
export function effectiveBoltAccessory(options: readonly AccessoryOption[], selection: AccessorySelection):
{ readonly gripMm: number; readonly springWasher: boolean } | null {
  const defaults = options.find((item) => item.setId === 'bolt-washer-nut')?.defaultGripMm;
  if (selection.setId !== 'bolt-washer-nut' || defaults === undefined) return null;
  const springWasher = selection.springWasher === true && defaults.spring !== null;
  const typed = evaluateExpression(selection.gripText ?? '');
  const gripMm = typed.ok && typed.value.value > 0 ? typed.value.value : springWasher ? defaults.spring ?? defaults.plain : defaults.plain;
  return { gripMm, springWasher };
}

let remembered: AccessorySelection = NO_ACCESSORY;

/** 覚えている選択(アプリを閉じるまで)。 */
export function rememberedAccessory(): AccessorySelection {
  return remembered;
}

/** 選択を覚える(窓の欄を変えた時)。 */
export function rememberAccessory(selection: AccessorySelection): void {
  remembered = selection;
}

/** 族の行(と欄の値)に当てはまる組の一覧。読み込んでいない族・当てはまる組が無い本体は空。 */
function accessoryOptionsFor(family: CatalogFamily | undefined, row: CatalogItemRow | undefined,
  values: Readonly<Record<string, string>>): readonly AccessoryOption[] {
  if (family === undefined || row === undefined) return [];
  return ACCESSORY_SET_IDS.flatMap((setId): AccessoryOption[] => {
    const result = accessoryCandidatesForPart(family, row, values, setId, PRODUCT_CATALOG_REGISTRY);
    return result.ok ? [{ setId, candidates: result.value }] : [];
  });
}

/** 今の本体で使える選択(覚えている組と行)。 */
interface ActiveAccessory {
  readonly setId: AccessorySetId;
  readonly candidate: AccessoryCandidate;
  readonly ends: AccessoryEnds;
  readonly endReference: AccessoryEndReference;
  readonly turn: AccessoryTurn;
}

/** 今の本体で使える選択(覚えている組が当てはまらない・行が候補に無い時は直す)。付けない時は null。 */
export function effectiveAccessory(options: readonly AccessoryOption[], selection: AccessorySelection): ActiveAccessory | null {
  const option = options.find((item) => item.setId === selection.setId);
  const candidate = option?.candidates.find((item) => item.itemKey === selection.itemKey) ?? option?.candidates[0];
  return option === undefined || candidate === undefined ? null
    : { setId: option.setId, candidate, ends: selection.ends, endReference: selection.endReference, turn: selection.turn ?? 0 };
}

/** 店へ渡す指定(鋼管の端の継手は族の id と、エルボ・チーズの時だけ枝の向きも)。端は呼ぶ側が決める。 */
function accessoryChoicesOf(active: ActiveAccessory, ends: AccessoryEnds): AccessoryChoices {
  const base = { ends, endReference: active.endReference, itemKey: active.candidate.itemKey };
  return active.setId !== 'pipe-end-fittings' ? base
    : { ...base, familyId: active.candidate.familyId, ...(active.candidate.turnable === true ? { turn: active.turn } : {}) };
}

/** 選ぶ窓の族の行に出す欄の元: 当てはまる組と、本体の長さ(欄の値。無い欄は族の初めの値。読めなければ null)。 */
export function familyAccessoryProps(family: CatalogFamily | undefined, row: CatalogItemRow | undefined,
  values: Readonly<Record<string, string>>): { readonly options: readonly AccessoryOption[]; readonly lengthMm: number | null } {
  const options = accessoryOptionsFor(family, row, values);
  if (family === undefined || row === undefined || options.length === 0) return { options, lengthMm: null };
  const length = evaluateExpression(createCatalogItemSource(family, row, values).options.length ?? '');
  return { options, lengthMm: length.ok && length.value.value > 0 ? length.value.value : null };
}

/** 1 本を置く時に店へ渡す付属(付けない・当てはまらない時は undefined)。 */
export function pickedAccessory(options: readonly AccessoryOption[]):
{ readonly setId: AccessorySetId; readonly choices: AccessoryChoices } | undefined {
  const bolt = effectiveBoltAccessory(options, remembered);
  if (bolt !== null) return { setId: 'bolt-washer-nut', choices: { ends: 'both', endReference: 'member', itemKey: '', ...bolt } };
  const active = effectiveAccessory(options, remembered);
  return active === null ? undefined : { setId: active.setId, choices: accessoryChoicesOf(active, active.ends) };
}

/** 一括配置・一筆書きの部材に当てはまる組(族の部材は族の行で、鋼材の部材は長さ 1000 の保存の形で引く。SGP の鋼管には端の継手の組)。 */
export function layoutAccessoryOptions(member: FrameMemberChoice): readonly AccessoryOption[] {
  if (member.kind === 'steel') {
    const probe = commitStandardPartChoice('structuralSection', member.choiceKey, '1000');
    return probe.ok ? pipeFittingOptions(probe.value.source) : [];
  }
  const family = PRODUCT_CATALOG_REGISTRY.loaded(member.familyId);
  return accessoryOptionsFor(family, family?.rows.find((row) => row.key === member.itemKey), member.values);
}

/** 並べる時に店へ渡す付属(端は部材ごとに決めるので持たない)。 */
export function layoutAccessory(member: FrameMemberChoice): FrameAccessoryRequest | undefined {
  const active = effectiveAccessory(layoutAccessoryOptions(member), remembered);
  if (active === null) return undefined;
  const choices = accessoryChoicesOf(active, 'both');
  return { setId: active.setId, endReference: choices.endReference, itemKey: choices.itemKey,
    ...(choices.familyId === undefined ? {} : { familyId: choices.familyId }), ...(choices.turn === undefined ? {} : { turn: choices.turn }) };
}

/** 予告の数: 付けた後の本体の長さ(全長の時は厚さ × 端の数だけ縮む)と付属の数。長さが読めない本体は長さ null。 */
export function accessoryPreview(lengthMm: number | null, thicknessMm: number, ends: AccessoryEnds, endReference: AccessoryEndReference):
{ readonly hostLengthMm: number | null; readonly count: number } {
  const count = ends === 'both' ? 2 : 1;
  const hostLengthMm = lengthMm === null ? null : Math.round((endReference === 'overall' ? lengthMm - thicknessMm * count : lengthMm) * 1e6) / 1e6;
  return { hostLengthMm, count };
}

type FramePlan = Extract<FrameMembersResult, { readonly ok: true }>;
/** 端を同じ点とみなす距離(mm。planFrameMembers の POINT_TOLERANCE と同じ)。 */
const POINT_TOLERANCE_MM = 1e-6;
type Point = readonly [number, number, number];
const near = (a: Point, b: Point): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= POINT_TOLERANCE_MM;

/**
 * 一括配置の部材ごとに、付属を付ける端(付けない部材は null)。何にも会わない端と、突き当てで通した部材の端に付ける。
 * 並びは plan.members と同じ。
 */
export function exposedEnds(lines: readonly FrameLine[], plan: FramePlan): readonly (AccessoryEnds | null)[] {
  return plan.members.map((member) => {
    const line = lines[member.lineIndex];
    if (line === undefined) return null;
    const open = (point: Point): boolean => {
      const corner = plan.corners.find((item) => item.lines.includes(member.lineIndex) && near(item.point, point));
      return corner === undefined || (corner.treatment === 'butt' && corner.through === member.lineIndex);
    };
    const start = open(line.start), end = open(line.end);
    return start && end ? 'both' : start ? 'start' : end ? 'end' : null;
  });
}
