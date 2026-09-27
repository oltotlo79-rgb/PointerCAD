/**
 * 図形の測定値の依存解析(GR-02。計画書 `scratchpad/claude/plans/geomref-plan.md` §4(d)、
 * 利用者の回答 Q7=O1「測る形は、その値を係数経由で使う形より履歴の前。連なりは最大8段」)。
 *
 * OCCT を呼ばない純関数だけを置く。形を作る前に、文書の式と参照だけから次を求める。
 *
 * 1. 係数 → 図形の測定値: GR-04 の `mathGeometryDerivedParameters`(係数の数式の `coef` 参照のうち
 *    `math-geometry:` の識別番号を、係数どうしの依存 `parameterDependencies` をたどって推移的に集める)を
 *    そのまま使う。形の依存に数えるのは、そのうち `resolvableMathGeometryDefinitions` で 1 つに決まる
 *    定義だけ。構成は選んだものだけが `document.parameters` に写っているので、選んでいない構成の式は
 *    数えない。
 * 2. 式の持ち主 → 係数: `collectExpressionOwners`(立体・基準ジオメトリ・スケッチ要素・拘束の欄と、
 *    `mapDocumentNonScalarExpressions` が歩く関数作図・未解決の式)が使う係数を
 *    `expressionParameterNames` で引く。図形の値が形へ入る道は係数だけ(Q2=U3)。欄の式に直接書いた
 *    `math-geometry:` の参照は評価(GR-04)が「係数の式の中でだけ使えます」で断るので、依存に数えない。
 * 3. 図形の測定値 → 形: 参照先(`mathGeometryTargetsOf` の立体の `featureId`・部分形状の
 *    `bodyFeatureId`・スケッチの `sketchId`)と、その上流(帯の依存 `historyDependencies` の
 *    推移閉包と、途中で通るスケッチ)。量の種類では分岐しない。
 * 4. 循環: 定義 G の測る形の上流にある持ち主が、G を(他の係数・他の図形の測定値を通して)使う
 *    係数を使っていれば循環。形を作る前に見つけ、古い値で回さない。
 * 5. 順序(Q7=O1): 図形由来の係数を使う帯の項目 F は、G が測る帯の項目 T より後ろ。ただし基準
 *    ジオメトリは常に立体より前の区間に並ぶ(`buildTimeline`)ので、立体を測った値を使う基準ジオメトリは
 *    並べ替えで後ろへ移せない。その組は順序違反にも並べ替えの辺にもせず、計算は段階再計算に任せる
 *    (立体の面に載せた作業平面を、再計算が立体の後で解くのと同じ扱い)。
 * 6. 段: 測る→係数→形→測る…の連なりの深さ。上限 8 段を超えたら理由付きで止める。
 *
 * ## スケッチ単位の依存の得方(写さずに同じ規則を使う)
 *
 * `historyDependencies` はスケッチを経由する依存を帯の項目へ畳み込んで返し、「どのスケッチを
 * 通ったか」「スケッチ自身が何に依存するか」は公開していない(`timelineOrder.ts` の非公開の
 * `sketchDependencies`)。規則を 2 か所に書かないため、解析専用の文書を 1 つ作って
 * `historyDependencies` を 1 回だけ呼ぶ。
 * - 各スケッチに目印の点を 1 つ足し、その作図面を目印の作業平面にする(`timelineOrder.ts` の表の
 *   「スケッチ → 基準ジオメトリ: 各要素の作図面 planeId」)。項目の依存に目印の作業平面が現れれば、
 *   その項目は(他の項目を挟まずに)そのスケッチを通っている。
 * - 測る対象のスケッチごとに、そのスケッチだけを使う目印の押し出しを足す(「立体 → スケッチ」)。
 *   その依存が、スケッチ自身の依存(帯の項目と、通るスケッチ)になる。
 * 目印は解析の中だけで使い、文書・画面・保存には出ない。
 *
 * 抑制(FR-503)された立体も帯の依存としては数える(`historyDependencies` と同じ)。順序違反だけは
 * 再計算で実際に作る形の話なので、使う側・測る側のどちらかが抑制されていれば数えない。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { MathInputProblem } from '@pointercad/expression/math/contracts';

import { expressionParameterNames } from '../parameters/expressionReferences.js';
import { collectExpressionOwners } from '../part/reevaluatePart.js';
import { buildTimeline, historyDependencies } from '../part/timelineOrder.js';
import type { ExtrudeFeature, PartDocument, ReferencePlaneFeature } from '../part/types.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import {
  mathGeometryDerivedParameters,
  mathGeometryUnresolvedMessage,
  resolvableMathGeometryDefinitions,
} from './mathGeometryCoefficients.js';
import { mathGeometryTargetsOf, type MathGeometryTarget } from './mathGeometryIdentity.js';
import type { MathGeometryDefinition } from './mathGeometryTypes.js';

/** Q7=O1: 測る→係数→形→測る…の連なり(段)の上限。これを超える段の測定値は係数へ渡さない。 */
export const MATH_GEOMETRY_MAX_STAGES = 8;

/* ---------------------------------------------------------------------------
 * 結果の型
 * ------------------------------------------------------------------------- */

/** 図形の測定値の循環 1 つ(定義の強連結成分)。 */
export interface MathGeometryCycle {
  /** 循環に含まれる図形の測定値の定義ID(文書の並び)。 */
  readonly definitionIds: readonly string[];
  /** 循環の途中で測定値を形へ渡している係数の名前(表の並び)。 */
  readonly coefficientNames: readonly string[];
  /** 循環に含まれる測る形(立体・スケッチ)の id。 */
  readonly shapeIds: readonly string[];
  /** 付録C の循環の文(代表の 1 組)。 */
  readonly message: string;
}

/** Q7=O1 の順序違反 1 件。F が T より前にあり、T を測った値を係数から使っている。 */
export interface MathGeometryOrderViolation {
  /** 使う側の帯の項目(F)。 */
  readonly featureId: string;
  /** 測る側の帯の項目(T)。スケッチを測るときは、そのスケッチが依存する帯の項目。 */
  readonly targetFeatureId: string;
  readonly definitionId: string;
  readonly coefficientName: string;
  readonly message: string;
}

export interface MathGeometryDependencyAnalysis {
  /**
   * 係数名 → その係数が直接または他の係数を通して使う図形の測定値の定義ID(図形由来の係数だけ)。
   * GR-04 の `mathGeometryDerivedParameters` と同じ関係(集合にしただけ)。式に書かれた識別番号を
   * そのまま入れるので、1 つに決まらない定義の ID も含む(その参照は評価が理由付きで断る)。
   */
  readonly geometryDerived: ReadonlyMap<string, ReadonlySet<string>>;
  /** 式の持ち主の ID(`collectExpressionOwners` の `ownerId`)→ 係数を通して使う定義ID。 */
  readonly ownerGeometry: ReadonlyMap<string, ReadonlySet<string>>;
  /** 定義ID → 文書に実在する測る対象の ID(立体・座標系の featureId・部分形状の bodyFeatureId・スケッチの sketchId)。 */
  readonly targets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly cycles: readonly MathGeometryCycle[];
  readonly orderViolations: readonly MathGeometryOrderViolation[];
  /**
   * 定義ID → 段(1 始まり)。段 k の測定値は、段 k より前の測定値だけで作れる形から測れる。
   * 循環に含まれる定義と、循環の値を使って作る形を測る定義は入らない。
   */
  readonly stageOf: ReadonlyMap<string, number>;
  /** 係数から使われ、上限以内の定義の段の最大。0 なら係数へ渡す測定値が無い(段は最後の 1 回だけ)。 */
  readonly stageCount: number;
  /** 段が上限(`MATH_GEOMETRY_MAX_STAGES`)を超えた定義ID(文書の並び)。 */
  readonly tooDeep: readonly string[];
  /** 係数名 → その係数を計算させない理由(循環・循環の値・段数超過・順序違反。表の並び)。 */
  readonly blocked: ReadonlyMap<string, string>;
  /** 係数から使われ、1 つに決まる定義ID。 */
  readonly usedDefinitionIds: ReadonlySet<string>;
  /**
   * 並べ替え用の辺(F → そこより前でなければならない T)。循環に含まれる定義の辺と、立体を測った値を
   * 使う基準ジオメトリの辺(区間が違い、どう並べ替えても満たせない)は入れない。抑制された項目の辺は入れる。
   */
  readonly historyEdges: ReadonlyMap<string, readonly string[]>;
  /** 式の係数参照を読めなかった理由(同じ識別番号に 2 つの名前がある式など)。このとき依存は空。 */
  readonly unreadable?: string;
}

/* ---------------------------------------------------------------------------
 * 理由の文(計画書 付録C。検査で文字列を照合する)。「測れない」「参照先の不一致」など評価で使う文は
 * GR-04 の `mathGeometryCoefficients.ts` にあり、ここには循環・順序・段数の 3 つだけを置く。
 * ------------------------------------------------------------------------- */

export function mathGeometryCycleMessage(coefficient: string, definition: string, shape: string): string {
  return `係数「${coefficient}」は図形の測定値「${definition}」を使っていますが、その測る形「${shape}」が「${coefficient}」を使って作られているため循環しています。`;
}

export function mathGeometryOrderMessage(feature: string, target: string, definition: string, coefficient: string): string {
  return `「${feature}」は、後ろにある「${target}」を測った値（図形の測定値「${definition}」）を係数「${coefficient}」から使っています。「${target}」より後ろへ移してください。`;
}

export function mathGeometryTooDeepMessage(limit: number = MATH_GEOMETRY_MAX_STAGES): string {
  return `図形の測定値を使う係数の連なりが上限（${String(limit)}段）を超えています。`;
}

/* ---------------------------------------------------------------------------
 * 小さな道具
 * ------------------------------------------------------------------------- */

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, new Set([value]));
  else values.add(value);
}

function orderIndex(ids: Iterable<string>): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (const id of ids) if (!index.has(id)) index.set(id, index.size);
  return index;
}

/** `ids` のうち `order` にあるものを `order` の並びで返す。 */
function inOrder(ids: ReadonlySet<string>, order: ReadonlyMap<string, number>): readonly string[] {
  return [...ids].filter(id => order.has(id)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/* ---------------------------------------------------------------------------
 * 1. 係数 → 図形の測定値
 * ------------------------------------------------------------------------- */

interface CoefficientGeometry {
  /** 係数名 → 式に書かれた定義ID(推移的。1 つに決まるかは問わない)。 */
  readonly written: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * 係数名 → そのうち `resolvableMathGeometryDefinitions` で 1 つに決まる定義ID。形の依存に使うのは
   * こちらだけ。式に書かれた名前が定義の名前と違う参照(評価が「参照先を確認できません」で断る)も
   * 依存には数える(循環・段を見落とさない側へ倒す)。
   */
  readonly valid: ReadonlyMap<string, ReadonlySet<string>>;
}

function analyzeCoefficients(document: PartDocument): CoefficientGeometry {
  const derived = mathGeometryDerivedParameters(document.parameters);
  if (derived.size === 0) return { written: new Map(), valid: new Map() };
  const resolvable = resolvableMathGeometryDefinitions(document);
  const written = new Map<string, ReadonlySet<string>>(), valid = new Map<string, ReadonlySet<string>>();
  for (const [name, ids] of derived) {
    written.set(name, new Set(ids));
    const resolved = ids.filter(id => resolvable.has(id));
    if (resolved.length > 0) valid.set(name, new Set(resolved));
  }
  return { written, valid };
}

/* ---------------------------------------------------------------------------
 * 2. 式の持ち主 → 係数
 * ------------------------------------------------------------------------- */

/** 持ち主の式が使う図形由来の係数 1 つと、その係数が 1 つに決まる参照で使う定義ID。 */
interface OwnerUse {
  readonly coefficientName: string;
  readonly definitionIds: ReadonlySet<string>;
}

interface OwnerGeometry {
  readonly written: ReadonlyMap<string, ReadonlySet<string>>;
  /** 持ち主ID → 形の依存に使う係数(最初に現れた順)。持ち主は `collectExpressionOwners` の順。 */
  readonly uses: ReadonlyMap<string, readonly OwnerUse[]>;
}

function analyzeOwners(document: PartDocument, coefficients: CoefficientGeometry): OwnerGeometry {
  const written = new Map<string, Set<string>>();
  const uses = new Map<string, OwnerUse[]>();
  for (const owner of collectExpressionOwners(document)) {
    for (const name of expressionParameterNames(owner, document.parameters)) {
      for (const id of coefficients.written.get(name) ?? []) addTo(written, owner.ownerId, id);
      const valid = coefficients.valid.get(name);
      if (valid === undefined) continue;
      const list = uses.get(owner.ownerId) ?? [];
      if (!list.some(use => use.coefficientName === name)) list.push({ coefficientName: name, definitionIds: valid });
      uses.set(owner.ownerId, list);
    }
  }
  return { written, uses };
}

/* ---------------------------------------------------------------------------
 * 3. 形の依存(帯の項目とスケッチ)
 * ------------------------------------------------------------------------- */

/** 目印の id の頭。利用者の文書の id には現れない文字で始め、既存の id と重なれば番号を足す。 */
const MARKER_PREFIX = '\u0000math-geometry-dependencies:';

interface StructuralIndex {
  /** 帯の項目 → 直接の依存(帯の項目)。`historyDependencies` そのもの。 */
  readonly itemDeps: ReadonlyMap<string, readonly string[]>;
  /** 帯の項目 → その項目が他の項目を挟まずに通るスケッチ。 */
  readonly itemSketches: ReadonlyMap<string, readonly string[]>;
  /** 測る対象のスケッチ → そのスケッチが依存する帯の項目。 */
  readonly sketchItems: ReadonlyMap<string, readonly string[]>;
  /** 測る対象のスケッチ → そのスケッチが通るスケッチ(自分を含む)。 */
  readonly sketchSketches: ReadonlyMap<string, readonly string[]>;
}

function buildStructuralIndex(document: PartDocument, measuredSketchIds: ReadonlySet<string>): StructuralIndex {
  const itemIds = new Set([...document.references.map(feature => feature.id), ...document.solids.map(feature => feature.id)]);
  const taken = new Set([...itemIds, ...document.sketches.flatMap(sketch => [sketch.id, ...sketch.features.map(feature => feature.id)])]);
  const unique = (base: string): string => {
    let id = base;
    for (let serial = 2; taken.has(id); serial += 1) id = `${base}~${String(serial)}`;
    taken.add(id);
    return id;
  };
  const sketchOfMarker = new Map<string, string>(), markerOfSketch = new Map<string, string>();
  const markers: ReferencePlaneFeature[] = [];
  const sketches = document.sketches.map(sketch => {
    // 同じ id のスケッチが 2 本あるときは先のほうだけが歩かれる(`timelineOrder.ts` と同じ)。
    if (markerOfSketch.has(sketch.id)) return sketch;
    const planeId = unique(`${MARKER_PREFIX}plane:${sketch.id}`);
    markerOfSketch.set(sketch.id, planeId);
    sketchOfMarker.set(planeId, sketch.id);
    markers.push({ id: planeId, name: planeId, kind: 'referencePlane', visible: false,
      plane: { kind: 'workPlane', planeId: 'xy', offset: expressionValueFromNumber(0) } });
    const point = { ...createPointFeature(sketch, absoluteCoordinate(0, 0, 0), planeId), id: unique(`${MARKER_PREFIX}point:${sketch.id}`) };
    return { ...sketch, features: [...sketch.features, point] };
  });
  const sketchOfProbe = new Map<string, string>();
  const probes: ExtrudeFeature[] = [];
  for (const sketchId of measuredSketchIds) {
    if (!markerOfSketch.has(sketchId)) continue;
    const id = unique(`${MARKER_PREFIX}probe:${sketchId}`);
    sketchOfProbe.set(id, sketchId);
    probes.push({ id, name: id, kind: 'extrude', suppressed: false, profile: { sketchId, faceFeatureId: id },
      distance: expressionValueFromNumber(1), reversed: false, symmetric: false });
  }
  const graph = historyDependencies({ ...document, sketches,
    references: [...document.references, ...markers], solids: [...document.solids, ...probes] });
  const itemsIn = (ids: readonly string[]): readonly string[] => ids.filter(id => itemIds.has(id));
  const sketchesIn = (ids: readonly string[]): readonly string[] => ids.flatMap(id => {
    const sketchId = sketchOfMarker.get(id);
    return sketchId === undefined ? [] : [sketchId];
  });
  const itemDeps = new Map<string, readonly string[]>(), itemSketches = new Map<string, readonly string[]>();
  const sketchItems = new Map<string, readonly string[]>(), sketchSketches = new Map<string, readonly string[]>();
  for (const [id, dependencies] of graph) {
    const probed = sketchOfProbe.get(id);
    if (probed !== undefined) {
      sketchItems.set(probed, itemsIn(dependencies));
      sketchSketches.set(probed, sketchesIn(dependencies));
    } else if (itemIds.has(id)) {
      itemDeps.set(id, itemsIn(dependencies));
      itemSketches.set(id, sketchesIn(dependencies));
    }
  }
  return { itemDeps, itemSketches, sketchItems, sketchSketches };
}

/** 形の依存の節。帯の項目(基準ジオメトリ・立体)かスケッチ。 */
interface ShapeNode {
  readonly kind: 'item' | 'sketch';
  readonly id: string;
}

interface Upstream {
  readonly items: ReadonlySet<string>;
  readonly sketches: ReadonlySet<string>;
}

/** その節を作るのに先に要る帯の項目とスケッチ(自分を含む)。 */
function upstreamOf(structure: StructuralIndex, node: ShapeNode): Upstream {
  const items = new Set<string>(), sketches = new Set<string>();
  const queue: string[] = [];
  const visit = (id: string): void => {
    if (items.has(id)) return;
    items.add(id);
    queue.push(id);
  };
  if (node.kind === 'item') visit(node.id);
  else {
    sketches.add(node.id);
    for (const sketchId of structure.sketchSketches.get(node.id) ?? []) sketches.add(sketchId);
    for (const id of structure.sketchItems.get(node.id) ?? []) visit(id);
  }
  for (let position = 0; position < queue.length; position += 1) {
    const id = queue[position];
    for (const sketchId of structure.itemSketches.get(id) ?? []) sketches.add(sketchId);
    for (const dependency of structure.itemDeps.get(id) ?? []) visit(dependency);
  }
  return { items, sketches };
}

/**
 * 測る対象 1 つの形の節。文書に無い参照先は null(実行時は missing-reference。循環ではない)。
 * 参照の種類ごとに return するので、種類が増えると `noImplicitReturns` で型検査が落ちる。
 */
function shapeNodeOf(target: MathGeometryTarget, solidIds: ReadonlySet<string>, sketchIds: ReadonlySet<string>,
  frameIds: ReadonlySet<string>): ShapeNode | null {
  switch (target.kind) {
    case 'sketch-point':
    case 'sketch-curve':
      return sketchIds.has(target.sketchId) ? { kind: 'sketch', id: target.sketchId } : null;
    case 'vertex':
    case 'edge':
    case 'face':
      return solidIds.has(target.reference.bodyFeatureId) ? { kind: 'item', id: target.reference.bodyFeatureId } : null;
    case 'body':
      return solidIds.has(target.featureId) ? { kind: 'item', id: target.featureId } : null;
    case 'reference':
      return frameIds.has(target.featureId) ? { kind: 'item', id: target.featureId } : null;
  }
}

function shapeNodesOf(definition: MathGeometryDefinition, solidIds: ReadonlySet<string>, sketchIds: ReadonlySet<string>,
  frameIds: ReadonlySet<string>): readonly ShapeNode[] {
  const nodes: ShapeNode[] = [];
  for (const target of mathGeometryTargetsOf(definition.quantity)) {
    const node = shapeNodeOf(target, solidIds, sketchIds, frameIds);
    if (node !== null && !nodes.some(known => known.kind === node.kind && known.id === node.id)) nodes.push(node);
  }
  return nodes;
}

/* ---------------------------------------------------------------------------
 * 4〜6. 定義どうしの依存・循環・段
 * ------------------------------------------------------------------------- */

/** 定義 G の測る形の上流にある持ち主が、係数を通して定義 G' を使っていること(G → G')。 */
interface Witness {
  readonly ownerId: string;
  readonly coefficientName: string;
  /** その持ち主が上流にある、G の測る形。 */
  readonly shape: ShapeNode;
}

type DefinitionEdges = ReadonlyMap<string, ReadonlyMap<string, Witness>>;

/** 強連結成分(Tarjan)。依存される側の成分が先に並ぶ。 */
function stronglyConnected(ids: readonly string[], edges: DefinitionEdges): readonly (readonly string[])[] {
  const records = new Map<string, { readonly index: number; low: number }>();
  const stack: string[] = [], onStack = new Set<string>(), components: string[][] = [];
  const visit = (id: string): void => {
    const record = { index: records.size, low: records.size };
    records.set(id, record);
    stack.push(id);
    onStack.add(id);
    for (const next of edges.get(id)?.keys() ?? []) {
      const known = records.get(next);
      if (known === undefined) {
        visit(next);
        record.low = Math.min(record.low, records.get(next)?.low ?? record.low);
      } else if (onStack.has(next)) {
        record.low = Math.min(record.low, known.index);
      }
    }
    if (record.low !== record.index) return;
    const component: string[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.push(member);
      if (member === id) break;
    }
    components.push(component);
  };
  for (const id of ids) if (!records.has(id)) visit(id);
  return components;
}

/* ---------------------------------------------------------------------------
 * 入口
 * ------------------------------------------------------------------------- */

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * 図形の測定値の依存を形を作る前に解析する(§4(d))。例外を投げない: 式の係数参照を読めない
 * (同じ識別番号に 2 つの名前がある)ときは、依存を空にして `unreadable` に理由を入れる
 * (その式は評価でも理由付きで断られる)。
 */
export function analyzeMathGeometryDependencies(document: PartDocument): MathGeometryDependencyAnalysis {
  const index = indexDocument(document);
  try {
    return analyze(document, index);
  } catch (error) {
    if (!(error instanceof MathInputProblem)) throw error;
    return { ...emptyAnalysis(index), unreadable: error.message };
  }
}

/** 並べ替え(GR-07)で `historyDependencies` へ足す辺。F → F より前でなければならない T。 */
export function mathGeometryHistoryEdges(document: PartDocument): ReadonlyMap<string, readonly string[]> {
  return analyzeMathGeometryDependencies(document).historyEdges;
}

interface DocumentIndex {
  readonly definitions: readonly MathGeometryDefinition[];
  readonly definitionOrder: ReadonlyMap<string, number>;
  readonly solidIds: ReadonlySet<string>;
  readonly frameIds: ReadonlySet<string>;
  readonly sketchIds: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
  /** スケッチ要素・拘束の id → スケッチの id(先に出たほう)。 */
  readonly sketchOfOwner: ReadonlyMap<string, string>;
  readonly names: ReadonlyMap<string, string>;
  readonly sketchNames: ReadonlyMap<string, string>;
  readonly parameterOrder: ReadonlyMap<string, number>;
}

function indexDocument(document: PartDocument): DocumentIndex {
  const definitions: MathGeometryDefinition[] = [];
  const definitionIds = new Set<string>();
  for (const definition of document.mathGeometry ?? []) {
    if (definitionIds.has(definition.id)) continue;
    definitionIds.add(definition.id);
    definitions.push(definition);
  }
  const sketchOfOwner = new Map<string, string>();
  for (const sketch of document.sketches) {
    for (const owner of [...sketch.features, ...(sketch.constraints ?? [])]) {
      if (!sketchOfOwner.has(owner.id)) sketchOfOwner.set(owner.id, sketch.id);
    }
  }
  const names = new Map<string, string>();
  for (const feature of [...document.references, ...document.solids]) if (!names.has(feature.id)) names.set(feature.id, feature.name);
  const sketchNames = new Map<string, string>();
  for (const sketch of document.sketches) if (!sketchNames.has(sketch.id)) sketchNames.set(sketch.id, sketch.name);
  return {
    definitions,
    definitionOrder: orderIndex(definitions.map(definition => definition.id)),
    solidIds: new Set(document.solids.map(feature => feature.id)),
    frameIds: new Set(document.references.filter(feature => feature.kind === 'referenceCoordinateSystem').map(feature => feature.id)),
    sketchIds: new Set(document.sketches.map(sketch => sketch.id)),
    itemIds: new Set([...document.references.map(feature => feature.id), ...document.solids.map(feature => feature.id)]),
    sketchOfOwner,
    names,
    sketchNames,
    parameterOrder: orderIndex(document.parameters.map(parameter => parameter.name)),
  };
}

function targetsOf(index: DocumentIndex): ReadonlyMap<string, readonly ShapeNode[]> {
  return new Map(index.definitions.map(definition => [definition.id, shapeNodesOf(definition, index.solidIds, index.sketchIds, index.frameIds)]));
}

function targetIds(targets: ReadonlyMap<string, readonly ShapeNode[]>): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map([...targets].map(([id, nodes]) => [id, new Set(nodes.map(node => node.id))]));
}

/** 係数が図形の測定値を 1 つも参照しない文書の結果。段は最後の 1 回だけで、現行の再計算と同じ。 */
function emptyAnalysis(index: DocumentIndex): MathGeometryDependencyAnalysis {
  return {
    geometryDerived: new Map(), ownerGeometry: new Map(), targets: targetIds(targetsOf(index)), cycles: [], orderViolations: [],
    stageOf: new Map(index.definitions.map(definition => [definition.id, 1])), stageCount: 0, tooDeep: [],
    blocked: new Map(), usedDefinitionIds: EMPTY_SET, historyEdges: new Map(),
  };
}

function analyze(document: PartDocument, index: DocumentIndex): MathGeometryDependencyAnalysis {
  const coefficients = analyzeCoefficients(document);
  if (coefficients.written.size === 0) return emptyAnalysis(index);
  const owners = analyzeOwners(document, coefficients);
  const targets = targetsOf(index);
  const graph = definitionGraph(document, index, owners, targets);
  const cycles = findCycles(index, graph);
  const stages = assignStages(index, graph.edges, cycles);
  const used = new Set<string>();
  for (const ids of coefficients.valid.values()) for (const id of ids) used.add(id);
  let stageCount = 0;
  for (const id of used) {
    const stage = stages.stageOf.get(id);
    if (stage !== undefined && stage <= MATH_GEOMETRY_MAX_STAGES) stageCount = Math.max(stageCount, stage);
  }
  const order = orderAndEdges(document, index, owners, targets, graph, cycles.cyclic);
  return {
    geometryDerived: coefficients.written,
    ownerGeometry: owners.written,
    targets: targetIds(targets),
    cycles: cycles.list,
    orderViolations: order.violations,
    stageOf: stages.stageOf,
    stageCount,
    tooDeep: stages.tooDeep,
    blocked: blockedCoefficients(index, coefficients, cycles, stages, order.violations),
    usedDefinitionIds: used,
    historyEdges: order.edges,
  };
}

interface DefinitionGraph {
  readonly edges: DefinitionEdges;
  /** 形の依存の索引。形へ入る図形由来の係数が無ければ作らない(目印の文書も作らない)。 */
  readonly structure: StructuralIndex | null;
  /** その形の節の上流(覚え書き付き)。 */
  readonly upstream: (node: ShapeNode) => Upstream;
  /** 持ち主を他の項目を挟まずに使う帯の項目(持ち主自身が帯の項目ならそれも)。 */
  readonly directUsers: (ownerId: string) => readonly string[];
}

function definitionGraph(
  document: PartDocument,
  index: DocumentIndex,
  owners: OwnerGeometry,
  targets: ReadonlyMap<string, readonly ShapeNode[]>,
): DefinitionGraph {
  /** 持ち主が上流にあるか(帯の項目そのものか、上流のスケッチの要素・拘束)。 */
  const ownerWithin = (ownerId: string, upstream: Upstream): boolean => {
    const sketchId = index.sketchOfOwner.get(ownerId);
    return (index.itemIds.has(ownerId) && upstream.items.has(ownerId)) || (sketchId !== undefined && upstream.sketches.has(sketchId));
  };
  const placed = [...owners.uses.keys()].filter(ownerId => index.itemIds.has(ownerId) || index.sketchOfOwner.has(ownerId));
  if (placed.length === 0) {
    return { edges: new Map(), structure: null, upstream: () => ({ items: EMPTY_SET, sketches: EMPTY_SET }), directUsers: () => [] };
  }
  const measuredSketches = new Set<string>();
  for (const nodes of targets.values()) for (const node of nodes) if (node.kind === 'sketch') measuredSketches.add(node.id);
  const structure = buildStructuralIndex(document, measuredSketches);
  const cache = new Map<string, Upstream>();
  const upstream = (node: ShapeNode): Upstream => {
    const key = `${node.kind}:${node.id}`;
    const known = cache.get(key);
    if (known !== undefined) return known;
    const computed = upstreamOf(structure, node);
    cache.set(key, computed);
    return computed;
  };
  const sketchUsers = new Map<string, string[]>();
  for (const entry of buildTimeline(document)) {
    for (const sketchId of structure.itemSketches.get(entry.featureId) ?? []) {
      const users = sketchUsers.get(sketchId) ?? [];
      if (!users.includes(entry.featureId)) users.push(entry.featureId);
      sketchUsers.set(sketchId, users);
    }
  }
  const directUsers = (ownerId: string): readonly string[] => {
    const sketchId = index.sketchOfOwner.get(ownerId);
    const users = [...(index.itemIds.has(ownerId) ? [ownerId] : []), ...(sketchId === undefined ? [] : sketchUsers.get(sketchId) ?? [])];
    return [...new Set(users)];
  };
  const edges = new Map<string, Map<string, Witness>>();
  for (const definition of index.definitions) {
    const out = new Map<string, Witness>();
    for (const shape of targets.get(definition.id) ?? []) {
      const above = upstream(shape);
      for (const ownerId of placed) {
        if (!ownerWithin(ownerId, above)) continue;
        for (const use of owners.uses.get(ownerId) ?? []) {
          for (const usedId of inOrder(use.definitionIds, index.definitionOrder)) {
            if (!out.has(usedId)) out.set(usedId, { ownerId, coefficientName: use.coefficientName, shape });
          }
        }
      }
    }
    edges.set(definition.id, out);
  }
  return { edges, structure, upstream, directUsers };
}

interface CycleResult {
  readonly list: readonly MathGeometryCycle[];
  /** 循環に含まれる定義ID → その循環。 */
  readonly cyclic: ReadonlyMap<string, MathGeometryCycle>;
  /** 循環の途中で値を渡す係数 → その係数を名指しした循環の文。 */
  readonly coefficientMessages: ReadonlyMap<string, string>;
  readonly components: readonly (readonly string[])[];
}

function shapeName(index: DocumentIndex, node: ShapeNode): string {
  return (node.kind === 'item' ? index.names.get(node.id) : index.sketchNames.get(node.id)) ?? node.id;
}

function findCycles(index: DocumentIndex, graph: DefinitionGraph): CycleResult {
  const components = stronglyConnected(index.definitions.map(definition => definition.id), graph.edges);
  const nameOf = new Map(index.definitions.map(definition => [definition.id, definition.name]));
  const list: MathGeometryCycle[] = [];
  const cyclic = new Map<string, MathGeometryCycle>();
  const coefficientMessages = new Map<string, string>();
  for (const component of components) {
    const first = component[0];
    if (component.length === 1 && graph.edges.get(first)?.has(first) !== true) continue;
    const members = inOrder(new Set(component), index.definitionOrder);
    const inside = new Set(members);
    /** その定義の測る形のうち、循環の値を使って作られるもの(循環の中へ向かう最初の辺の形)。 */
    const cycleShape = (id: string): ShapeNode | null => {
      for (const [next, witness] of graph.edges.get(id) ?? []) if (inside.has(next)) return witness.shape;
      return null;
    };
    const messages: string[] = [];
    const coefficients = new Set<string>();
    for (const member of members) {
      for (const [next, witness] of graph.edges.get(member) ?? []) {
        if (!inside.has(next)) continue;
        const shape = cycleShape(next);
        const message = mathGeometryCycleMessage(witness.coefficientName, nameOf.get(next) ?? next,
          shape === null ? '' : shapeName(index, shape));
        messages.push(message);
        coefficients.add(witness.coefficientName);
        if (!coefficientMessages.has(witness.coefficientName)) coefficientMessages.set(witness.coefficientName, message);
      }
    }
    const shapeIds = [...new Set(members.flatMap(member => {
      const shape = cycleShape(member);
      return shape === null ? [] : [shape.id];
    }))];
    const cycle: MathGeometryCycle = { definitionIds: members, coefficientNames: inOrder(coefficients, index.parameterOrder),
      shapeIds, message: messages[0] ?? '' };
    list.push(cycle);
    for (const member of members) cyclic.set(member, cycle);
  }
  list.sort((a, b) => (index.definitionOrder.get(a.definitionIds[0]) ?? 0) - (index.definitionOrder.get(b.definitionIds[0]) ?? 0));
  return { list, cyclic, coefficientMessages, components };
}

interface StageResult {
  readonly stageOf: ReadonlyMap<string, number>;
  /** 循環に含まれるか、循環の値を使って作る形を測る定義 → 原因の循環。 */
  readonly blockedBy: ReadonlyMap<string, MathGeometryCycle>;
  readonly tooDeep: readonly string[];
}

function assignStages(index: DocumentIndex, edges: DefinitionEdges, cycles: CycleResult): StageResult {
  const stageOf = new Map<string, number>();
  const blockedBy = new Map<string, MathGeometryCycle>();
  // 強連結成分は依存される側が先に並ぶので、1 回の走査で段が決まる。
  for (const component of cycles.components) {
    const id = component[0];
    const own = cycles.cyclic.get(id);
    if (own !== undefined) {
      for (const member of component) blockedBy.set(member, own);
      continue;
    }
    let stage = 1;
    let cause: MathGeometryCycle | undefined;
    for (const usedId of edges.get(id)?.keys() ?? []) {
      const blocked = blockedBy.get(usedId);
      if (blocked !== undefined) cause ??= blocked;
      else stage = Math.max(stage, (stageOf.get(usedId) ?? 0) + 1);
    }
    if (cause !== undefined) blockedBy.set(id, cause);
    else stageOf.set(id, stage);
  }
  const ordered = new Map(index.definitions.flatMap(definition => {
    const stage = stageOf.get(definition.id);
    return stage === undefined ? [] : [[definition.id, stage] as const];
  }));
  return {
    stageOf: ordered,
    blockedBy,
    tooDeep: index.definitions.map(definition => definition.id).filter(id => (ordered.get(id) ?? 0) > MATH_GEOMETRY_MAX_STAGES),
  };
}

interface OrderResult {
  readonly violations: readonly MathGeometryOrderViolation[];
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

function orderAndEdges(
  document: PartDocument,
  index: DocumentIndex,
  owners: OwnerGeometry,
  targets: ReadonlyMap<string, readonly ShapeNode[]>,
  graph: DefinitionGraph,
  cyclic: ReadonlyMap<string, MathGeometryCycle>,
): OrderResult {
  const structure = graph.structure;
  if (structure === null) return { violations: [], edges: new Map() };
  const timeline = buildTimeline(document);
  const position = new Map(timeline.map(entry => [entry.featureId, entry.index] as const));
  const section = new Map(timeline.map(entry => [entry.featureId, entry.section] as const));
  const suppressed = new Set(timeline.filter(entry => entry.suppressed).map(entry => entry.featureId));
  const nameOf = new Map(index.definitions.map(definition => [definition.id, definition.name]));
  const edges = new Map<string, Set<string>>();
  const violations: MathGeometryOrderViolation[] = [];
  const reported = new Set<string>();
  for (const [ownerId, uses] of owners.uses) {
    const users = graph.directUsers(ownerId);
    if (users.length === 0) continue;
    for (const use of uses) {
      for (const definitionId of inOrder(use.definitionIds, index.definitionOrder)) {
        // 循環は循環として断る。並べ替えでは直せないので、辺にして並べ替えを二重に断らない。
        if (cyclic.has(definitionId)) continue;
        for (const shape of targets.get(definitionId) ?? []) {
          const measured = shape.kind === 'item' ? [shape.id] : structure.sketchItems.get(shape.id) ?? [];
          const above = graph.upstream(shape);
          for (const featureId of users) {
            if (above.items.has(featureId)) continue;
            for (const targetId of measured) {
              if (targetId === featureId) continue;
              // 基準ジオメトリは立体より前の区間から動かせないので、立体を測った値を使う組は
              // どう並べ替えても満たせない。辺にも順序違反にもしない(ファイル冒頭の 5)。
              if (section.get(featureId) === 'reference' && section.get(targetId) === 'solid') continue;
              addTo(edges, featureId, targetId);
              const from = position.get(featureId), to = position.get(targetId);
              if (from === undefined || to === undefined || from > to || suppressed.has(featureId) || suppressed.has(targetId)) continue;
              const key = [featureId, targetId, definitionId, use.coefficientName].join('\u0000');
              if (reported.has(key)) continue;
              reported.add(key);
              violations.push({ featureId, targetFeatureId: targetId, definitionId, coefficientName: use.coefficientName,
                message: mathGeometryOrderMessage(index.names.get(featureId) ?? featureId, index.names.get(targetId) ?? targetId,
                  nameOf.get(definitionId) ?? definitionId, use.coefficientName) });
            }
          }
        }
      }
    }
  }
  violations.sort((a, b) => (position.get(a.featureId) ?? 0) - (position.get(b.featureId) ?? 0)
    || (position.get(a.targetFeatureId) ?? 0) - (position.get(b.targetFeatureId) ?? 0));
  const ordered = new Map<string, readonly string[]>();
  for (const entry of timeline) {
    const found = edges.get(entry.featureId);
    if (found !== undefined) ordered.set(entry.featureId, inOrder(found, position));
  }
  return { violations, edges: ordered };
}

/**
 * 係数を計算させない理由。1 つの係数に理由が重なるときは、直し方の根本に近い順に 1 つだけ
 * (循環の途中で値を渡している → 循環の値を使う → 段数超過 → 順序違反)。
 */
function blockedCoefficients(
  index: DocumentIndex,
  coefficients: CoefficientGeometry,
  cycles: CycleResult,
  stages: StageResult,
  violations: readonly MathGeometryOrderViolation[],
): ReadonlyMap<string, string> {
  const nameOf = new Map(index.definitions.map(definition => [definition.id, definition.name]));
  const tooDeep = new Set(stages.tooDeep);
  const blocked = new Map<string, string>();
  for (const name of index.parameterOrder.keys()) {
    const onCycle = cycles.coefficientMessages.get(name);
    if (onCycle !== undefined) {
      blocked.set(name, onCycle);
      continue;
    }
    const used = inOrder(coefficients.valid.get(name) ?? EMPTY_SET, index.definitionOrder);
    const unavailable = used.find(id => stages.blockedBy.has(id));
    const cause = unavailable === undefined ? undefined : stages.blockedBy.get(unavailable);
    if (unavailable !== undefined && cause !== undefined) {
      blocked.set(name, mathGeometryUnresolvedMessage(nameOf.get(unavailable) ?? unavailable, name, cause.message));
    } else if (used.some(id => tooDeep.has(id))) {
      blocked.set(name, mathGeometryTooDeepMessage());
    } else {
      const violation = violations.find(entry => entry.coefficientName === name);
      if (violation !== undefined) blocked.set(name, violation.message);
    }
  }
  return blocked;
}
