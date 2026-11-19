/**
 * ボルトの座金とナットの組(A4。設計 wip/a4/a4-design.md。統括の決定 2026-11-19: Q-A4a 記録の型は A1 で決めた、Q-A4b 既定の締め付ける厚さはねじが 2 ピッチ出る厚さ)。
 * 選ぶ窓で、穴を選ばずに今の 8 分類の六角ボルトを 1 本置く時だけに付ける。穴を選んで締める今のボルト締結(J-02)とその記録は変えない。
 *
 * - 部品は今の 8 分類の平座金(頭側・ナット側)・ばね座金(任意)・六角ナット(J-02 と同じ保存の形なので、部品表で同じ行にまとまる)。
 * - 置き方はボルトの局所(首下の座面が z = 0、軸が +Z。座金とナットは下の面が z = 0、厚さが +Z。fastenerPlacements.ts と同じ向き):
 *   頭側の平座金 z ∈ [0, t1](+Z を −Z へ向け、下の面を z = t1 に)、締め付ける厚さ G の範囲 [t1, t1 + G]、ナット側の平座金・ばね座金・ナットを +Z へ積む。
 * - 既定の G は L − t1 − t2 − ts − m − 2P を 0.5 mm に切り下げた値(m は六角ナットの高さの上限)。G が 0 以下・ねじが 1 ピッチ出ない G は断る。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { composePlacement, type RigidPlacement } from '../placementMath.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { joinRigidGroup } from '../rigidGroups.js';
import { buildStandardPartFromSource, createStandardPartSource } from '../standard/buildStandardPart.js';
import { findHexBolt, findHexNut, findPlainWasher, findSpringWasher } from '../standard/fasteners.js';
import type { FastenerDimensionSeries } from '../standard/types.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource } from '../types.js';
import type { AccessoryRole, AccessorySetRecord } from './accessoryRecord.js';

/** 記録を保存・読み込みできる最小の保存形式の版(accessorySets.ts の ACCESSORY_SETS_SCHEMA_VERSION と同じ値)。 */
const ACCESSORY_SETS_SCHEMA_VERSION = 23;

/** 断る理由。 */
export type BoltAccessoryRefusal = 'notBolt' | 'rowMissing' | 'boltTooShort' | 'gripTooLong' | 'invalidGrip';

/** 既定の締め付ける厚さを切り下げる刻み(mm)。 */
const GRIP_STEP_MM = 0.5;
/** 既定の G で、ナットの外へ出すねじのピッチの数。 */
const DEFAULT_PROTRUSION_PITCHES = 2;
const HALF_TURN_X = [1, 0, 0, 0] as const;
const IDENTITY = [0, 0, 0, 1] as const;

interface BoltFacts {
  readonly nominal: string;
  readonly lengthMm: number;
  readonly pitch: number;
  readonly dimensionSeries: FastenerDimensionSeries;
  readonly threadSeries: string;
  readonly plainThickness: number;
  readonly springThickness: number | null;
  readonly nutHeight: number;
}

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: BoltAccessoryRefusal };

/** 今の 8 分類の六角ボルトの保存の形から、組に要る寸法(行が無ければ理由)。 */
function boltFacts(source: ComponentSource): Result<BoltFacts> {
  if (source.kind !== 'standardPart' || source.catalog !== 'hexBolt') return { ok: false, reason: 'notBolt' };
  const dimensionSeries: FastenerDimensionSeries = source.options.dimensionSeries === 'main' ? 'main' : 'annexJA';
  const bolt = findHexBolt(source.size, dimensionSeries);
  const nut = findHexNut(source.size, dimensionSeries);
  const plain = findPlainWasher(source.size);
  const spring = findSpringWasher(source.size);
  const lengthMm = Number(source.options.length);
  if (bolt === undefined || nut === undefined || plain === undefined || !(lengthMm > 0)) return { ok: false, reason: 'rowMissing' };
  return { ok: true, value: { nominal: source.size, lengthMm, pitch: bolt.pitch, dimensionSeries, threadSeries: source.options.threadSeries ?? 'coarse',
    plainThickness: plain.thickness, springThickness: spring?.thickness ?? null, nutHeight: nut.mMax } };
}

/** 締め付ける厚さの既定(座金とナットの厚さとねじの 2 ピッチを引き、0.5 mm に切り下げる)。0 以下なら理由。 */
export function defaultBoltGrip(source: ComponentSource, springWasher: boolean): Result<number> {
  const facts = boltFacts(source);
  if (!facts.ok) return facts;
  const f = facts.value;
  const stack = 2 * f.plainThickness + (springWasher ? f.springThickness ?? 0 : 0) + f.nutHeight;
  const grip = Math.floor((f.lengthMm - stack - DEFAULT_PROTRUSION_PITCHES * f.pitch) / GRIP_STEP_MM) * GRIP_STEP_MM;
  return grip > 0 ? { ok: true, value: grip } : { ok: false, reason: 'boltTooShort' };
}

/** 付ける部品(役目・保存の形・ボルトの局所の置き方)。 */
interface BoltAccessoryItem {
  readonly role: AccessoryRole;
  readonly source: StandardPartSource;
  readonly local: RigidPlacement;
}

/** ボルトに付ける座金とナットの置き方。ばね座金の行が無い呼びでばね座金を選んだ時は rowMissing。 */
export function planBoltAccessories(source: ComponentSource, gripMm: number, springWasher: boolean): Result<readonly BoltAccessoryItem[]> {
  const facts = boltFacts(source);
  if (!facts.ok) return facts;
  const f = facts.value;
  if (!Number.isFinite(gripMm) || !(gripMm > 0)) return { ok: false, reason: 'invalidGrip' };
  if (springWasher && f.springThickness === null) return { ok: false, reason: 'rowMissing' };
  const spring = springWasher ? f.springThickness ?? 0 : 0;
  // ねじがナットの外へ 1 ピッチ以上出る時だけ。
  if (f.lengthMm - (2 * f.plainThickness + gripMm + spring + f.nutHeight) < f.pitch) return { ok: false, reason: 'gripTooLong' };
  const t1 = f.plainThickness;
  const at = (z: number, rotation: readonly [number, number, number, number]): RigidPlacement => ({ position: [0, 0, z], rotation });
  const nutOptions = { dimensionSeries: f.dimensionSeries, threadSeries: f.threadSeries };
  const items: BoltAccessoryItem[] = [
    { role: 'headWasher', source: createStandardPartSource('plainWasher', f.nominal, {}), local: at(t1, HALF_TURN_X) },
    { role: 'nutWasher', source: createStandardPartSource('plainWasher', f.nominal, {}), local: at(t1 + gripMm, IDENTITY) },
    ...(springWasher ? [{ role: 'springWasher' as const, source: createStandardPartSource('springWasher', f.nominal, {}), local: at(2 * t1 + gripMm, IDENTITY) }] : []),
    { role: 'nut', source: createStandardPartSource('hexNut', f.nominal, nutOptions), local: at(2 * t1 + gripMm + spring, IDENTITY) },
  ];
  return { ok: true, value: items };
}

function rigidOf(component: AssemblyComponent): RigidPlacement {
  const [x, y, z] = component.placement.position;
  return { position: [x.value, y.value, z.value], rotation: component.placement.rotation };
}

function nextRecordId(document: AssemblyDocument): string {
  const used = new Set((document.accessorySets ?? []).map((record) => record.id));
  let index = 1;
  while (used.has(`accessory-${index}`)) index += 1;
  return `accessory-${index}`;
}

/**
 * 置いたボルトに座金とナットを付けた次の文書(付属を足し、一緒に動く組へ入れ、記録を足し、版を 23 以上にする)。締め付ける厚さを
 * 指定しない時は既定の値。付けられない時は何も変えずに理由を返す。
 */
export function applyBoltAccessorySet(document: AssemblyDocument, hostComponentId: string,
  choices: { readonly gripMm?: number; readonly springWasher?: boolean }):
Result<{ readonly document: AssemblyDocument; readonly componentIds: readonly string[] }> {
  const host = document.components.find((component) => component.id === hostComponentId);
  if (host === undefined) return { ok: false, reason: 'notBolt' };
  const springWasher = choices.springWasher === true;
  const grip = choices.gripMm === undefined ? defaultBoltGrip(host.source, springWasher) : { ok: true as const, value: choices.gripMm };
  if (!grip.ok) return grip;
  const planned = planBoltAccessories(host.source, grip.value, springWasher);
  if (!planned.ok) return planned;
  let next = document;
  const accessories: { componentId: string; role: AccessoryRole }[] = [];
  for (const item of planned.value) {
    const world = composePlacement(rigidOf(host), item.local);
    const component = createComponentFor(next, item.source, { partName: buildStandardPartFromSource(item.source)?.name ?? item.role,
      placement: { position: [expressionValueFromNumber(world.position[0]), expressionValueFromNumber(world.position[1]),
        expressionValueFromNumber(world.position[2])], rotation: world.rotation } });
    next = addComponent(next, { ...component, fixed: false });
    accessories.push({ componentId: component.id, role: item.role });
  }
  next = joinRigidGroup(next, [hostComponentId, ...accessories.map((item) => item.componentId)]);
  const nominal = host.source.kind === 'standardPart' ? host.source.size : '';
  const record: AccessorySetRecord = { id: nextRecordId(next), setId: 'bolt-washer-nut', hostComponentId, accessories,
    choices: { ends: 'both', endReference: 'member', itemKey: nominal, gripMm: grip.value, springWasher } };
  return { ok: true, value: { componentIds: accessories.map((item) => item.componentId), document: { ...next,
    accessorySets: [...(next.accessorySets ?? []), record], schemaVersion: Math.max(next.schemaVersion, ACCESSORY_SETS_SCHEMA_VERSION) } } };
}
