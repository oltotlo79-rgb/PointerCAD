/**
 * 付属の組「フレームの端のキャップ」(A1〜A3。設計 wip/auto-accessory-design.md)の候補と付け方。段 1(G2)で accessorySets.ts から移した(計算は変えない)。
 *
 * - 本体: 長さを持つ族で `sectionBounds` と `sectionSlots` を持つ物。キャップの行は、溝の呼び(`frameSlotWidthOf`)と、
 *   断面の外形の幅 × 高さが一致する長方形の板(L 形の板は向きが決まらないので出さない)。行が「合うフレームの行の鍵」(`fitsFrameKeys`。
 *   小形のキャップ)を持つ時は、溝の呼びの代わりにその鍵で照らす(外形は向きを決めるために見る)。鍵を持つ行が 1 つも無い小形のキャップの族では
 *   理由 capLinkUnknown(外形だけで照らすと別の溝の形のキャップも当たるため)。幅と高さが入れ替わって一致する行は、キャップを本体の長さの軸のまわりに 90° 回して置く。
 * - 置き方: 本体の局所の +Z が長さの向き、z = 0 が始点の端(一括配置 `planFrameMembers` と同じ)。キャップの板(原点が外形の中心、+Z へ厚さ t)は、
 *   始点の側を z ∈ [−t, 0]、終点の側を z ∈ [L, L + t] に、断面の外形の中心へ置く。全長の時は、本体の長さを t × 端の数だけ縮め、始点に付ける時は
 *   本体を +Z へ t ずらす(線の端がキャップの外の面になる)。
 * - 付属は本体と同じ一緒に動く組(`joinRigidGroup`)に入れる。記録を足した文書は保存形式の版 23 以上にする(使ったファイルだけ。frameJoints と同じ)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import type { CatalogRegistry } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { frameSlotWidthOf } from '../frame/frameJoints.js';
import { planMemberBulkEdit } from '../frame/memberBulkEdit.js';
import { composePlacement, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import { joinRigidGroup } from '../rigidGroups.js';
import { withinMagnitude } from '../../numericTolerance.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { CatalogItemHost } from './accessoryHost.js';
import type { AccessoryRole, AccessorySetRecord } from './accessoryRecord.js';
import type { AccessoryCandidate, AccessoryChoices, AccessoryRefusal } from './accessorySets.js';

/** 記録を保存・読み込みできる最小の保存形式の版(frameJoints・穴つきの面と同じ版 23。統括の決定 Q2)。 */
const ACCESSORY_SETS_SCHEMA_VERSION = 23;

/** 幅・高さ・溝の呼びを同じとみなす差(mm)。 */
const SIZE_TOLERANCE_MM = 1e-6;
/** 長さを丸める桁(mm の 1e-6。一括配置と同じ)。 */
const ROUNDING = 1e6;
const SMALL_FRAME_FAMILY = 't-slot-frame-small';
const CAP_FAMILY = 't-slot-frame-cap';
const SMALL_CAP_FAMILY = 't-slot-frame-cap-small';

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AccessoryRefusal };
const refuse = <T>(reason: AccessoryRefusal): Result<T> => ({ ok: false, reason });
const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING;
const same = (left: number | undefined, right: number): boolean => left !== undefined && withinMagnitude(left - right, SIZE_TOLERANCE_MM);

/** 置く前の本体(族と行と欄の値)。選ぶ窓が、置く前に組の候補を出すために使う。 */
interface AccessoryPart { readonly family: CatalogFamily; readonly row: CatalogItemRow; readonly values: Readonly<Record<string, string>> }

/** フレームの端のキャップの候補(本体の断面に合う行)。合う行が 0 なら理由。 */
export function frameCapCandidates(host: AccessoryPart, registry: CatalogRegistry): Result<readonly AccessoryCandidate[]> {
  const bounds = host.family.sectionBounds?.(host.row, host.values) ?? null;
  const slots = host.family.sectionSlots?.(host.row, host.values) ?? null;
  if (host.family.stock !== 'linear' || bounds === null || slots === null || slots.length === 0) return refuse('notFrame');
  // 小形のキャップの行は溝の欄を持たず、外形が同じで溝の違うフレームがあるので、行の「合うフレームの行の鍵」(fitsFrameKeys)だけで照らす。
  const small = host.family.id === SMALL_FRAME_FAMILY;
  const slot = small ? null : frameSlotWidthOf(host.row);
  if (!small && slot === null) return refuse('slotWidthUnknown');
  const caps = registry.loaded(small ? SMALL_CAP_FAMILY : CAP_FAMILY);
  if (caps === undefined) return refuse('capsNotLoaded');
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
  // L 形のフレーム(行の dims に腕の幅)には、腕の幅の同じ L 形のキャップだけを向きを変えずに合わせる(L 形は 90° 回すと形が合わない)。
  // ほかの外周が長方形でないフレーム(dims に outlineSection。1 つの角の大きな丸みなど)には、合う形のキャップの行が無いので、
  // 同じ外形の四角のキャップを出さない(行の fitsFrameKeys で明示したキャップだけ)。長方形のフレームには L 形のキャップを出さない。
  const hostArm = Object.hasOwn(host.row.dims, 'armWidth') ? host.row.dims.armWidth : undefined;
  const shapedWithoutArm = hostArm === undefined && Object.hasOwn(host.row.dims, 'outlineSection');
  const candidates = caps.rows.flatMap((row): AccessoryCandidate[] => {
    const { dims } = row;
    const fits = row.fitsFrameKeys === undefined ? slot !== null && same(dims.slot, slot) : row.fitsFrameKeys.includes(host.row.key);
    const capArm = Object.hasOwn(dims, 'armWidth') ? dims.armWidth : undefined;
    if (!fits || (capArm === undefined) !== (hostArm === undefined) || !(dims.thickness !== undefined && dims.thickness > 0)) return [];
    if (shapedWithoutArm && row.fitsFrameKeys === undefined) return [];
    const lShape = hostArm !== undefined && same(capArm, hostArm);
    const turn = hostArm !== undefined ? (lShape && same(dims.width, width) && same(dims.height, height) ? 0 : null)
      : same(dims.width, width) && same(dims.height, height) ? 0 : same(dims.width, height) && same(dims.height, width) ? 1 : null;
    return turn === null ? [] : [{ familyId: caps.id, itemKey: row.key, size: row.size, thicknessMm: dims.thickness, quarterTurn: turn }];
  });
  if (candidates.length > 0) return { ok: true, value: candidates };
  return refuse(small && !caps.rows.some((row) => row.fitsFrameKeys !== undefined) ? 'capLinkUnknown' : 'noMatchingCap');
}

/** 置く物: 本体の新しい長さと局所の z のずれ、付属ごとの役目と、本体の局所の置き方。 */
interface AccessoryPlan {
  readonly hostLengthMm: number;
  readonly hostShiftMm: number;
  readonly accessories: readonly { readonly role: AccessoryRole; readonly candidate: AccessoryCandidate; readonly local: RigidPlacement }[];
}

function planFrameCaps(host: CatalogItemHost, candidate: AccessoryCandidate, choices: AccessoryChoices): Result<AccessoryPlan> {
  const bounds = host.family.sectionBounds?.(host.row, host.values) ?? null;
  if (host.lengthMm === null || bounds === null) return refuse('invalidLength');
  const roles: readonly AccessoryRole[] = choices.ends === 'both' ? ['startCap', 'endCap'] : choices.ends === 'start' ? ['startCap'] : ['endCap'];
  const t = candidate.thicknessMm;
  const overall = choices.endReference === 'overall';
  const hostLengthMm = round(overall ? host.lengthMm - t * roles.length : host.lengthMm);
  if (!(hostLengthMm > 0)) return refuse('invalidLength');
  const hostShiftMm = overall && roles.includes('startCap') ? t : 0;
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  const rotation = quaternionFromAxisAngle([0, 0, 1], candidate.quarterTurn * Math.PI / 2);
  // 置き方は、ずらした後の本体の局所の座標(始点の端が z = 0)。
  const accessories = roles.map((role) => ({ role, candidate,
    local: { position: [cx, cy, role === 'startCap' ? -t : hostLengthMm] as const, rotation } }));
  return { ok: true, value: { hostLengthMm, hostShiftMm, accessories } };
}

function nextRecordId(document: AssemblyDocument): string {
  const used = new Set((document.accessorySets ?? []).map((record) => record.id));
  let index = 1;
  while (used.has(`accessory-${index}`)) index += 1;
  return `accessory-${index}`;
}

/** 本体の配置(式を数へ解いた値)。 */
function rigidOf(component: AssemblyComponent): RigidPlacement {
  const [x, y, z] = component.placement.position;
  return { position: [x.value, y.value, z.value], rotation: component.placement.rotation };
}

function placementOf(rigid: RigidPlacement): AssemblyComponent['placement'] {
  const [x, y, z] = rigid.position;
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: rigid.rotation };
}

/**
 * 本体(族の部品)に端のキャップを付けた次の文書。本体の長さと位置(全長の時)を直し、付属を足し、一緒に動く組へ入れ、記録を足し、版を 23 以上にする。
 * 付けられない時は何も変えずに理由を返す。候補は呼ぶ側(accessorySets.ts)が今の本体で引いた物を渡す。
 */
export function applyFrameEndCaps(document: AssemblyDocument, component: AssemblyComponent, host: CatalogItemHost,
  candidates: readonly AccessoryCandidate[], choices: AccessoryChoices, registry: CatalogRegistry):
Result<{ readonly document: AssemblyDocument; readonly componentIds: readonly string[] }> {
  const hostComponentId = component.id;
  const candidate = candidates.find((item) => item.itemKey === choices.itemKey);
  if (candidate === undefined) return refuse('unknownItem');
  const planned = planFrameCaps(host, candidate, choices);
  if (!planned.ok) return planned;
  const plan = planned.value;
  // 長さの書き換えは一括の書き換えと同じ作り方と確かめ(形が作れるか。部品名に長さを含む「部品名:番号」は付け直す。伸縮と同じ)。
  const resized = plan.hostLengthMm === host.lengthMm ? null
    : planMemberBulkEdit(document, [hostComponentId], { length: String(plan.hostLengthMm) }, registry);
  const entry = resized?.ok === true ? resized.entries[0] : undefined;
  if (resized !== null && entry === undefined) return refuse('lengthOutOfRange');
  const hostRigid = composePlacement(rigidOf(component), { position: [0, 0, plan.hostShiftMm], rotation: [0, 0, 0, 1] });
  let next: AssemblyDocument = { ...document, components: document.components.map((item) => (item.id === hostComponentId
    ? { ...item, ...(entry === undefined ? {} : { source: entry.nextSource, name: entry.nextName }), placement: placementOf(hostRigid) }
    : item)) };
  const accessories: { componentId: string; role: AccessoryRole }[] = [];
  const caps = registry.loaded(candidate.familyId);
  const capRow = caps?.rows.find((row) => row.key === candidate.itemKey);
  if (caps === undefined || capRow === undefined) return refuse('capsNotLoaded');
  for (const item of plan.accessories) {
    const created = createComponentFor(next, createCatalogItemSource(caps, capRow, {}),
      { partName: caps.partName(capRow, {}), placement: placementOf(composePlacement(hostRigid, item.local)) });
    const withMaterial = capRow.densityMaterialId === undefined ? created : { ...created, materialId: capRow.densityMaterialId };
    next = addComponent(next, { ...withMaterial, fixed: false });
    accessories.push({ componentId: created.id, role: item.role });
  }
  next = joinRigidGroup(next, [hostComponentId, ...accessories.map((item) => item.componentId)]);
  const record: AccessorySetRecord = { id: nextRecordId(next), setId: 'frame-end-caps', hostComponentId, accessories, choices };
  return { ok: true, value: { componentIds: accessories.map((item) => item.componentId), document: { ...next,
    accessorySets: [...(next.accessorySets ?? []), record], schemaVersion: Math.max(next.schemaVersion, ACCESSORY_SETS_SCHEMA_VERSION) } } };
}
