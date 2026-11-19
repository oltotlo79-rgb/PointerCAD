/**
 * 付属の組の画面の側の純関数(A2。設計 wip/auto-accessory-design.md §3・§5。統括の決定 2026-11-19 02:08: 既定は全長)。
 *
 * - 選ぶ窓・一括配置・一筆書きに出す組は、置く本体に当てはまる組だけ(model の `accessoryCandidatesForPart`。鋼材や機械要素の組も登録すれば同じ欄に出る)。
 *   当てはまる組が 1 つも無い本体には欄を出さない。
 * - 選んだ組と指定は、アプリを閉じるまで 1 つだけ覚える(設定にも文書にも持たない。最近使った物 K-07b と同じ)。
 * - 一括配置と一筆書きでは、端を利用者に選ばせず、端ごとに決める: 何にも会わない端と、突き当てで通した部材の端(相手の外の面まで出る)に付ける。
 *   当てる部材の端・留めの端・3 本以上が会う端・直角でない端には付けない。
 */
import { evaluateExpression } from '@pointercad/expression';
import {
  ACCESSORY_SET_IDS, accessoryCandidatesForPart, createCatalogItemSource, PRODUCT_CATALOG_REGISTRY, type AccessoryCandidate,
  type AccessoryChoices, type AccessoryEndReference, type AccessoryEnds, type AccessorySetId, type CatalogRegistry,
  type FrameLine, type FrameMembersResult,
} from '@pointercad/model';

import type { FrameAccessoryRequest } from './frameMembersAccessory.js';
import type { FrameMemberChoice } from './frameMembersPlacement.js';

/** 族と行の型(model の公開の名前に族の型が無いので、登録口の読み込みの戻りから取る)。 */
type CatalogFamily = NonNullable<ReturnType<CatalogRegistry['loaded']>>;
type CatalogItemRow = CatalogFamily['rows'][number];

/** 本体に当てはまる組 1 つと、その候補の行。 */
export interface AccessoryOption {
  readonly setId: AccessorySetId;
  readonly candidates: readonly AccessoryCandidate[];
}

/** 画面で選んだ付属。setId が null は「付けない」。 */
export interface AccessorySelection {
  readonly setId: AccessorySetId | null;
  readonly ends: AccessoryEnds;
  readonly endReference: AccessoryEndReference;
  /** 候補の行の鍵。空なら候補の先頭。 */
  readonly itemKey: string;
}

const NO_ACCESSORY: AccessorySelection = { setId: null, ends: 'both', endReference: 'overall', itemKey: '' };

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

/** 今の本体で使える選択(覚えている組が当てはまらない・行が候補に無い時は直す)。付けない時は null。 */
export function effectiveAccessory(options: readonly AccessoryOption[], selection: AccessorySelection):
{ readonly setId: AccessorySetId; readonly candidate: AccessoryCandidate; readonly ends: AccessoryEnds; readonly endReference: AccessoryEndReference } | null {
  const option = options.find((item) => item.setId === selection.setId);
  const candidate = option?.candidates.find((item) => item.itemKey === selection.itemKey) ?? option?.candidates[0];
  return option === undefined || candidate === undefined ? null
    : { setId: option.setId, candidate, ends: selection.ends, endReference: selection.endReference };
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
  const active = effectiveAccessory(options, remembered);
  return active === null ? undefined
    : { setId: active.setId, choices: { ends: active.ends, endReference: active.endReference, itemKey: active.candidate.itemKey } };
}

/** 一括配置・一筆書きの部材に当てはまる組(族の部材だけ。鋼材は今は組が無いので空)。 */
export function layoutAccessoryOptions(member: FrameMemberChoice): readonly AccessoryOption[] {
  if (member.kind !== 'catalogItem') return [];
  const family = PRODUCT_CATALOG_REGISTRY.loaded(member.familyId);
  return accessoryOptionsFor(family, family?.rows.find((row) => row.key === member.itemKey), member.values);
}

/** 並べる時に店へ渡す付属(端は部材ごとに決めるので持たない)。 */
export function layoutAccessory(member: FrameMemberChoice): FrameAccessoryRequest | undefined {
  const active = effectiveAccessory(layoutAccessoryOptions(member), remembered);
  return active === null ? undefined : { setId: active.setId, endReference: active.endReference, itemKey: active.candidate.itemKey };
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
