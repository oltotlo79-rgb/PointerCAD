/**
 * 伸縮(E-13。設計 wip/e13-design.md §2。統括の決定 2026-11-18 15:5x の (1)): 向き d(世界の軸の 6 つの向き)・面の座標 c・量 Δ で、
 * 面の向こう(d の側)の部品を d·Δ だけ動かし、面をまたぐ部材(族の線の材と鋼材)で軸が d と平行な物を Δ だけ伸び縮みさせる。
 * 次の文書を作るだけの純関数(形を作らない。部品の世界の外接箱は呼ぶ側が表示の形から作って渡す)。店はこれを 1 回で入れる(元に戻す 1 回で戻る)。
 *
 * - 分け方: 外接箱を d へ写した範囲 [u0, u1] が、u0 ≥ c − 許容 なら向こう、u1 ≤ c + 許容 なら手前、それ以外は面をまたぐ(c も d へ写した値)。
 *   外接箱の無い部品(抑制した部品など)は、配置の原点の 1 点で分ける。
 * - 伸び縮み: 向こうにある端を動かす(終点が向こうなら長さだけ、始点が向こうなら長さと、位置を d·Δ)。留めの欄は今のまま。
 *   長さの書き換えは一括の書き換え(`planMemberBulkEdit`)と同じ作り方と確かめ(形が作れるか。部品名に長さを含む名前は付け直す)。
 * - 位置は、動く軸の座標だけを数に置き換える(ほかの 2 つの座標の式はそのまま)。長さの欄も数に置き換わる。
 * - フレームの接続の記録はそのまま(部品の id は変わらず、接続の部品は相手と一緒に動く)。
 * - 断る(何も変えずに理由と部品を返す): 量が 0・動く物が無い・面をまたぐ部材でない部品がある・面をまたぐ部材の軸が d と平行でない・
 *   縮めて長さが 0 以下になるか面の向こうの部分より縮める・その長さで形が作れない・動く・伸び縮みする部品が合致などに指されている
 *   (数。分割と統合と同じ数え方 `componentReferenceCount`)。
 */
import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';

import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { rotateVector } from '../placementMath.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { steelLength, steelProductFromSource } from '../standard/steelCatalog.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { withinMagnitude } from '../../numericTolerance.js';
import { dotVec3, type Vec3 } from '../../sketch/vec3.js';
import type { PartBox } from './frameJointCheck.js';
import { planMemberBulkEdit } from './memberBulkEdit.js';
import { componentReferenceCount } from './memberSplitMerge.js';

/** 動かす向き(世界の軸の 6 つ)。 */
export type MemberStretchDirection = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

interface MemberStretchRequest {
  readonly direction: MemberStretchDirection;
  /** 面の位置(その向きの軸の世界の座標、mm)。 */
  readonly plane: number;
  /** 量(mm。負は縮める)。 */
  readonly amount: number;
}

type MemberStretchRejection = 'noAmount' | 'nothing' | 'straddling' | 'notParallel' | 'invalidLength' | 'referenced';

/** 伸び縮みする部材 1 本(前と後の長さ)。 */
interface StretchedMember {
  readonly componentId: string;
  readonly previous: number;
  readonly length: number;
}

export type MemberStretchPlan =
  | { readonly ok: true; readonly document: AssemblyDocument; readonly stretched: readonly StretchedMember[]; readonly moved: readonly string[] }
  | { readonly ok: false; readonly reason: MemberStretchRejection; readonly componentIds: readonly string[]; readonly count: number };

/** 面の上とみなす余り(mm)。置いた部品の配置は式の値から作るので、面に接する箱の端は丸めの桁で一致する。 */
const PLANE_TOLERANCE_MM = 0.01;
/** 軸を d と平行とみなす、内積の大きさの 1 からの差(配置の回転は四元数で、成分に丸めの桁の誤差が残る)。 */
const AXIS_TOLERANCE = 1e-6;
/** 長さ・座標を丸める桁(mm の 1e-6。一括配置・分割と同じ)。 */
const ROUNDING = 1e6;
const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING;

type AxisIndex = 0 | 1 | 2;
const AXES: Readonly<Record<MemberStretchDirection, { readonly index: AxisIndex; readonly sign: 1 | -1 }>> = {
  '+x': { index: 0, sign: 1 }, '-x': { index: 0, sign: -1 }, '+y': { index: 1, sign: 1 },
  '-y': { index: 1, sign: -1 }, '+z': { index: 2, sign: 1 }, '-z': { index: 2, sign: -1 },
};

/** 面をまたぐ部材 1 本: 今の長さ、始点が向こうか、面から向こうの端までの長さ(縮められる上限)。 */
interface CrossingMember {
  readonly component: AssemblyComponent;
  readonly length: number;
  readonly startFar: boolean;
  readonly farSpan: number;
}

/** 部品の分け方の結果。 */
interface StretchSplit {
  readonly moved: readonly AssemblyComponent[];
  readonly crossing: readonly CrossingMember[];
  readonly straddling: readonly string[];
  readonly notParallel: readonly string[];
}

function linearCatalogLength(source: StandardPartSource, text: string, registry: CatalogRegistry): number | null {
  if (registry.loaded(source.options.family ?? '')?.stock !== 'linear') return null;
  const result = evaluateExpression(text);
  return result.ok ? result.value.value : null;
}

/** 線の材(族の在庫が線の材の部品と、鋼材の部品)の長さ。線の材でない・長さが読めない部品は null。 */
function linearLength(component: AssemblyComponent, registry: CatalogRegistry): number | null {
  const source = component.source;
  if (source.kind !== 'standardPart') return null;
  const text = source.options.length;
  if (text === undefined) return null;
  const value = source.catalog === 'catalogItem' ? linearCatalogLength(source, text, registry)
    : steelProductFromSource(source) === undefined ? null : steelLength(text)?.value ?? null;
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

/** 部品の d へ写した範囲(箱が無い部品は配置の原点の 1 点)。 */
function rangeAlong(component: AssemblyComponent, box: PartBox | undefined, index: AxisIndex, sign: 1 | -1): readonly [number, number] {
  const low = sign * (box === undefined ? component.placement.position[index].value : box.min[index]);
  const high = sign * (box === undefined ? component.placement.position[index].value : box.max[index]);
  return [Math.min(low, high), Math.max(low, high)];
}

/** 部品を、向こう・面をまたぐ部材・断る部品に分ける(手前の部品は入れない)。 */
function splitComponents(document: AssemblyDocument, request: MemberStretchRequest, boxes: ReadonlyMap<string, PartBox>,
  registry: CatalogRegistry): StretchSplit {
  const { index, sign } = AXES[request.direction];
  const direction: Vec3 = [index === 0 ? sign : 0, index === 1 ? sign : 0, index === 2 ? sign : 0];
  const plane = sign * request.plane;
  const moved: AssemblyComponent[] = [], crossing: CrossingMember[] = [], straddling: string[] = [], notParallel: string[] = [];
  for (const component of document.components) {
    const [low, high] = rangeAlong(component, boxes.get(component.id), index, sign);
    if (low >= plane - PLANE_TOLERANCE_MM) moved.push(component);
    else if (high > plane + PLANE_TOLERANCE_MM) {
      const length = linearLength(component, registry);
      const dot = dotVec3(rotateVector(component.placement.rotation, [0, 0, 1]), direction);
      if (length === null) straddling.push(component.id);
      else if (!withinMagnitude(1 - Math.abs(dot), AXIS_TOLERANCE)) notParallel.push(component.id);
      else crossing.push({ component, length, startFar: dot < 0, farSpan: high - plane });
    }
  }
  return { moved, crossing, straddling, notParallel };
}

/** 位置の動く軸の座標だけを数に置き換えた部品。 */
function movedComponent(component: AssemblyComponent, index: AxisIndex, delta: number): AssemblyComponent {
  const [x, y, z] = component.placement.position;
  const shift = (axis: AxisIndex, value: typeof x): typeof x => (axis === index ? expressionValueFromNumber(round(value.value + delta)) : value);
  return { ...component, placement: { ...component.placement, position: [shift(0, x), shift(1, y), shift(2, z)] } };
}

const refused = (reason: MemberStretchRejection, componentIds: readonly string[] = [], count = componentIds.length): MemberStretchPlan =>
  ({ ok: false, reason, componentIds, count });

/** 伸縮の計画。作れない時は何も変えずに理由を返す。 */
export function planMemberStretch(document: AssemblyDocument, request: MemberStretchRequest, boxes: ReadonlyMap<string, PartBox>,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): MemberStretchPlan {
  if (!Number.isFinite(request.amount) || withinMagnitude(request.amount, PLANE_TOLERANCE_MM)) return refused('noAmount');
  const split = splitComponents(document, request, boxes, registry);
  if (split.straddling.length > 0) return refused('straddling', split.straddling);
  if (split.notParallel.length > 0) return refused('notParallel', split.notParallel);
  if (split.moved.length === 0 && split.crossing.length === 0) return refused('nothing');
  const amount = request.amount;
  // 縮める時は、長さが 0 以下にならず、面の向こうの部分より短くしない(向こうの部品が面を越えて手前の部品に重ならない)。
  const short = split.crossing.filter((member) => member.length + amount <= 0 || (amount < 0 && -amount >= member.farSpan - PLANE_TOLERANCE_MM));
  if (short.length > 0) return refused('invalidLength', short.map((member) => member.component.id));
  const ids = [...split.moved, ...split.crossing.map((member) => member.component)].map((component) => component.id);
  const referenced = componentReferenceCount(document, ids);
  if (referenced > 0) return refused('referenced', [], referenced);
  const { index, sign } = AXES[request.direction];
  const delta = sign * amount;
  const movedIds = new Set(split.moved.map((component) => component.id));
  let next: AssemblyDocument = { ...document,
    components: document.components.map((component) => (movedIds.has(component.id) ? movedComponent(component, index, delta) : component)) };
  const stretched: StretchedMember[] = [], invalid: string[] = [];
  // 1 本ずつ、それまでに付け直した名前を使用中として長さを書き換える(連番の名前が重ならない)。
  for (const member of split.crossing) {
    const length = round(member.length + amount);
    const plan = planMemberBulkEdit(next, [member.component.id], { length: String(length) }, registry);
    const entry = plan.ok ? plan.entries[0] : undefined;
    if (entry === undefined) { invalid.push(member.component.id); continue; }
    const edited: AssemblyComponent = { ...member.component, source: entry.nextSource, name: entry.nextName };
    const placed = member.startFar ? movedComponent(edited, index, delta) : edited;
    next = { ...next, components: next.components.map((component) => (component.id === placed.id ? placed : component)) };
    stretched.push({ componentId: member.component.id, previous: member.length, length });
  }
  if (invalid.length > 0) return refused('invalidLength', invalid);
  return { ok: true, document: next, stretched, moved: split.moved.map((component) => component.id) };
}
