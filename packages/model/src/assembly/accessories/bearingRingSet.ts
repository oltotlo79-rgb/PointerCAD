/**
 * 付属の組 A6: 軸受の C 形止め輪(統括の決定 2026-11-19 14:2x: 設計どおり C 形止め輪。族 catalog/families/cRing.ts)。
 * 軸受の内径(軸径)と呼びが一致する軸用 C 形止め輪、外径(穴径)と呼びが一致する穴用 C 形止め輪を、軸受の端面の外に置く。
 * 呼びが一致する行が無い軸受には組を出さない(近い呼びを推測で選ばない)。次の文書を作るだけの純関数。
 *
 * - 本体: 8 分類の深溝玉軸受と、族のラジアル軸受(アンギュラ玉軸受・円筒ころ軸受 NU・NJ・NUP・N・NF・針状ころ軸受)。
 *   針状ころ軸受は内輪が無いので、ころの内接円径を軸径にする。スラスト玉軸受・ローラフォロアは対象外(軸・穴と端面の関係が違う)。
 * - 置き方: 軸受の局所の +Z が軸の向きで、軸受は z ∈ [0, B]。止め輪の形は原点から +Z へ厚さ t なので、始点の側は z = −t、終点の側は z = B に置く
 *   (向きは軸受と同じ)。止め輪は軸受と同じ一緒に動く組(joinRigidGroup)に入れる。記録を足した文書は保存形式の版 23 以上(使ったファイルだけ)。
 * - 記録の指定は、付ける端(ends)と止め輪の行の鍵(itemKey)。線の端の意味(endReference)は使わないので 'member' で持つ。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import type { CatalogRegistry } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { composePlacement, type RigidPlacement } from '../placementMath.js';
import { joinRigidGroup } from '../rigidGroups.js';
import { findDeepGrooveBallBearing } from '../standard/bearings.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource } from '../types.js';
import { withinMagnitude } from '../../numericTolerance.js';
import type { AccessoryEnds, AccessoryRole, AccessorySetId, AccessorySetRecord } from './accessoryRecord.js';

/** 記録を保存・読み込みできる最小の保存形式の版(accessorySets.ts の ACCESSORY_SETS_SCHEMA_VERSION と同じ値)。 */
const ACCESSORY_SETS_SCHEMA_VERSION = 23;
const FAMILY_KEY = 'family', ITEM_KEY = 'item';
/** 軸径・穴径と止め輪の呼びを同じとみなす差(mm)。 */
const SIZE_TOLERANCE_MM = 1e-6;
/** 止め輪を付けられる族の軸受(ラジアル軸受。スラスト玉軸受・ローラフォロアは入れない)。 */
const RADIAL_BEARING_FAMILIES: ReadonlySet<string> = new Set(['angular-contact-ball-bearing', 'cylindrical-roller-bearing-nu',
  'cylindrical-roller-bearing-nj', 'cylindrical-roller-bearing-nup', 'cylindrical-roller-bearing-n', 'cylindrical-roller-bearing-nf',
  'needle-roller-bearing-rna']);
const RING_FAMILY: Readonly<Record<BearingRingSetId, string>> = { 'bearing-shaft-rings': 'c-ring-shaft', 'bearing-bore-rings': 'c-ring-bore' };
/** 止め輪の族の id(8 分類の窓が、組を出す前に読み込む)。 */
export const BEARING_RING_FAMILY_IDS: readonly string[] = Object.values(RING_FAMILY);

export type BearingRingSetId = Extract<AccessorySetId, 'bearing-shaft-rings' | 'bearing-bore-rings'>;

/** 止め輪を付けられない理由。 */
export type BearingRingRefusal = 'notBearing' | 'ringsNotLoaded' | 'noMatchingRing' | 'unknownItem';

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: BearingRingRefusal };
const refuse = <T>(reason: BearingRingRefusal): Result<T> => ({ ok: false, reason });

/** 止め輪の候補(付属の組の候補と同じ形。size は画面に出す部品名)。 */
interface RingCandidate {
  readonly familyId: string;
  readonly itemKey: string;
  readonly size: string;
  readonly thicknessMm: number;
  readonly quarterTurn: 0;
}

/** 軸受の軸径(内径。針状ころ軸受はころの内接円径)・穴径(外径)・幅(mm)。軸受でない・寸法が欠ける時は null。 */
function bearingFitOf(source: ComponentSource, registry: CatalogRegistry): { readonly shaft: number; readonly bore: number; readonly width: number } | null {
  if (source.kind !== 'standardPart') return null;
  if (source.catalog === 'deepGrooveBallBearing') {
    const row = findDeepGrooveBallBearing(source.size);
    return row === undefined ? null : { shaft: row.boreDiameter, bore: row.outsideDiameter, width: row.width };
  }
  const familyId = source.options[FAMILY_KEY] ?? '';
  if (source.catalog !== 'catalogItem' || !RADIAL_BEARING_FAMILIES.has(familyId)) return null;
  const dims = registry.loaded(familyId)?.rows.find((row) => row.key === source.options[ITEM_KEY])?.dims;
  const shaft = dims?.boreDiameter ?? dims?.rollerInscribedDiameter, bore = dims?.outsideDiameter, width = dims?.width;
  return shaft !== undefined && bore !== undefined && width !== undefined && width > 0 ? { shaft, bore, width } : null;
}

/** 呼び(適用する軸径・穴径 d1)が軸受の軸径・穴径と一致する止め輪の行。 */
function ringRowFor(family: CatalogFamily, diameter: number): CatalogItemRow | undefined {
  return family.rows.find((row) => row.dims.appliedDiameter !== undefined && withinMagnitude(row.dims.appliedDiameter - diameter, SIZE_TOLERANCE_MM));
}

/** 軸受(保存の形)に付けられる止め輪の候補(合う行は 0 か 1)。 */
export function bearingRingCandidates(source: ComponentSource, setId: BearingRingSetId, registry: CatalogRegistry): Result<readonly RingCandidate[]> {
  const fit = bearingFitOf(source, registry);
  if (fit === null) return refuse('notBearing');
  const family = registry.loaded(RING_FAMILY[setId]);
  if (family === undefined) return refuse('ringsNotLoaded');
  const row = ringRowFor(family, setId === 'bearing-shaft-rings' ? fit.shaft : fit.bore);
  const thickness = row?.dims.thickness;
  if (row === undefined || thickness === undefined || !(thickness > 0)) return refuse('noMatchingRing');
  return { ok: true, value: [{ familyId: family.id, itemKey: row.key, size: family.partName(row, {}), thicknessMm: thickness, quarterTurn: 0 }] };
}

/** 付ける止め輪: 役目・行・軸受の局所の置き方。 */
interface RingItem {
  readonly role: AccessoryRole;
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
  readonly local: RigidPlacement;
}

/** 軸受の今の形に付ける止め輪の置き方(付け直しも同じ道)。 */
export function planBearingRings(source: ComponentSource, setId: BearingRingSetId, ends: AccessoryEnds, registry: CatalogRegistry):
Result<readonly RingItem[]> {
  const fit = bearingFitOf(source, registry);
  const candidates = bearingRingCandidates(source, setId, registry);
  if (fit === null || !candidates.ok) return candidates.ok ? refuse('notBearing') : candidates;
  const candidate = candidates.value[0];
  const family = registry.loaded(candidate?.familyId ?? '');
  const row = family?.rows.find((item) => item.key === candidate?.itemKey);
  if (candidate === undefined || family === undefined || row === undefined) return refuse('noMatchingRing');
  const roles: readonly AccessoryRole[] = ends === 'both' ? ['startRing', 'endRing'] : ends === 'start' ? ['startRing'] : ['endRing'];
  return { ok: true, value: roles.map((role) => ({ role, family, row,
    local: { position: [0, 0, role === 'startRing' ? -candidate.thicknessMm : fit.width], rotation: [0, 0, 0, 1] } })) };
}

function rigidOf(component: AssemblyComponent): RigidPlacement {
  const [x, y, z] = component.placement.position;
  return { position: [x.value, y.value, z.value], rotation: component.placement.rotation };
}

/** 世界の置き方を部品の配置の形へ。 */
function ringPlacement(host: AssemblyComponent, local: RigidPlacement): AssemblyComponent['placement'] {
  const world = composePlacement(rigidOf(host), local);
  return { position: [expressionValueFromNumber(world.position[0]), expressionValueFromNumber(world.position[1]),
    expressionValueFromNumber(world.position[2])], rotation: world.rotation };
}

function nextRecordId(document: AssemblyDocument): string {
  const used = new Set((document.accessorySets ?? []).map((record) => record.id));
  let index = 1;
  while (used.has(`accessory-${index}`)) index += 1;
  return `accessory-${index}`;
}

/** 置いた軸受に止め輪を付けた次の文書(止め輪を足し、一緒に動く組へ入れ、記録を足し、版を 23 以上にする)。付けられない時は理由。 */
export function applyBearingRingSet(document: AssemblyDocument, hostComponentId: string, setId: BearingRingSetId,
  choices: { readonly ends: AccessoryEnds; readonly itemKey: string }, registry: CatalogRegistry):
Result<{ readonly document: AssemblyDocument; readonly componentIds: readonly string[] }> {
  const host = document.components.find((component) => component.id === hostComponentId);
  if (host === undefined) return refuse('notBearing');
  const planned = planBearingRings(host.source, setId, choices.ends, registry);
  if (!planned.ok) return planned;
  const itemKey = planned.value[0]?.row.key ?? '';
  if (choices.itemKey !== '' && choices.itemKey !== itemKey) return refuse('unknownItem');
  let next = document;
  const accessories: { componentId: string; role: AccessoryRole }[] = [];
  for (const item of planned.value) {
    const component = createComponentFor(next, createCatalogItemSource(item.family, item.row, {}),
      { partName: item.family.partName(item.row, {}), placement: ringPlacement(host, item.local) });
    const withMaterial = item.row.densityMaterialId === undefined ? component : { ...component, materialId: item.row.densityMaterialId };
    next = addComponent(next, { ...withMaterial, fixed: false });
    accessories.push({ componentId: component.id, role: item.role });
  }
  next = joinRigidGroup(next, [hostComponentId, ...accessories.map((item) => item.componentId)]);
  const record: AccessorySetRecord = { id: nextRecordId(next), setId, hostComponentId, accessories,
    choices: { ends: choices.ends, endReference: 'member', itemKey } };
  return { ok: true, value: { componentIds: accessories.map((item) => item.componentId), document: { ...next,
    accessorySets: [...(next.accessorySets ?? []), record], schemaVersion: Math.max(next.schemaVersion, ACCESSORY_SETS_SCHEMA_VERSION) } } };
}
