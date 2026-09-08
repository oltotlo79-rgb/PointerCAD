/**
 * アセンブリの解決(計画書 docs/plans/P7-アセンブリ.md §2.3、タスク6。FR-601 / FR-606 / NFR-PF-3)。
 *
 * アセンブリ文書(保存する形)を、**部品ごとの再計算の依頼**と**インスタンスごとの配置(数)**
 * へ直す。ここで済ませるのは model 側で計算できることだけで、
 *   ① 抱き込んだ部品文書を `partRef` で引く(`partLibrary.ts` の `partOf`)
 *   ② **同じ部品は 1 回だけ**解決する(§0.a-0.4。§2.13-6 の「インスタンスごとに再計算すると
 *      50 × 252ms = 12.6 秒で上限を割る」がこの決めの根拠)
 *   ③ 保存形の配置(位置 = 式)を数へ解き、四元数を `w >= 0` へ揃える(§0.a-0.54)
 *   ④ 親の配置と合成する(サブアセンブリの入れ子。§2.11)
 * の 4 つである。
 *
 * **カーネルを呼ばない純関数。** 実際の B-rep を作るのはカーネルの側で、この関数が返すのは
 * その依頼(`ResolvedPart`)と、できた形をどこへ置くか(`RigidPlacement`)だけである。
 * 部品 1 つの解決は `part/resolvePart.ts` をそのまま使う——部品の履歴の読み方を
 * アセンブリの側へ書き写さないため(同じ規約を 2 か所に持たない)。
 *
 * **例外を投げない。** 部品が見つからない・位置が数にならないは `errors` へ積んで先へ進む
 * (FR-504、NFR-RE-1「止めずに警告する」)。**抑制(`suppressed`)は失敗ではない**ので
 * `errors` には入らず、置かれなかったものとして扱う(部品文書の `resolvePart` と同じ流儀)。
 *
 * **合致は解かない**(§2.3 の⑤。P7 タスク15)。ここが返す配置は「利用者が置いた配置」で、
 * 合致の解はその上に別の段として乗る(§0.a-0.6。解は保存しない)。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import { analyzeParameters } from '../parameters/parameterTable.js';
import { applyParameters } from '../part/reevaluatePart.js';
import { resolvePart, type ResolvedPart } from '../part/resolvePart.js';
import type { PartDocument } from '../part/types.js';
import { cleanZeroVec3, type Vec3 } from '../sketch/vec3.js';
import { EMPTY_PART_LIBRARY, partOf, type PartLibrary } from './partLibrary.js';
import {
  composePlacement,
  IDENTITY_PLACEMENT,
  normalizeQuaternion,
  type RigidPlacement,
} from './placementMath.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource } from './types.js';

/** 規格部品の出どころ(`ComponentSource` の 1 枝)。台本(タスク29)へ渡す形。 */
export type StandardPartSource = Extract<ComponentSource, { readonly kind: 'standardPart' }>;

/**
 * 解決できなかった理由の区別(FR-504)。**利用者へは `message` をそのまま見せる。**
 * 名前は部品側の `PartErrorCode` と同じ語彙にそろえてある(同じ意味に 2 つの綴りを作らない)。
 */
export type AssemblyErrorCode =
  /** 置いた部品の中身(部品文書・規格部品の寸法)が引けない。 */
  | 'missingPart'
  /** 置いた位置の式が数にならない。 */
  | 'invalidValue';

/** 解決できなかった理由 1 つ。**どの部品(インスタンス)の話か**を `componentId` で指す。 */
export interface AssemblyError {
  /** 木の行と対応づけるための `AssemblyComponent.id`。 */
  readonly componentId: string;
  readonly code: AssemblyErrorCode;
  readonly message: string;
}

/**
 * アセンブリの解決結果。
 *
 * `parts` の鍵は**部品の鍵**(`partKeyOf`)で、`kind: 'part'` のときは `partRef` そのもの
 * (計画書のタスク6 が言う `Map<partRef, ResolvedPart>`)。規格部品は文書を持たないので、
 * 呼び寸法から作った鍵になる。**同じ鍵は 1 つしか入らない**(§0.a-0.4)。
 *
 * `placements` は**インスタンスごと**(`componentId` → 数に直した配置)。抑制された部品は
 * 入らない。並び順は文書の `components` の順で、2 回解いても変わらない(§0.a-0.54)。
 */
export interface ResolvedAssembly {
  /** 部品の鍵 → 部品 1 つの解決結果。**部品ごとに 1 回だけ**(§0.a-0.4)。 */
  readonly parts: ReadonlyMap<string, ResolvedPart>;
  /** インスタンスの id → 世界座標での配置(親と合成した後)。 */
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  /**
   * インスタンスの id → 部品の鍵。**中身を引けたインスタンスだけ**が入る。
   *
   * 計画書のタスク6 が挙げる 3 つの欄には無いが、これが無いと受け取った側が
   * `partKeyOf` を自分で呼び直すことになり、鍵の作り方が 2 か所に散る。
   * 「置いてあるが中身が引けなかった」(`placements` にはあり、ここには無い)を
   * 1 回の照合で見分けられるようにもなる。
   */
  readonly partKeys: ReadonlyMap<string, string>;
  /** 解決できなかった理由(FR-504)。抑制は失敗ではないので入らない。 */
  readonly errors: readonly AssemblyError[];
}

/** 解決に添える設定。どれも省略できる。 */
export interface ResolveAssemblyOptions {
  /** 再計算済みの部品。指定された鍵は解決し直さず、その結果を共有する。 */
  readonly resolvedParts?: ReadonlyMap<string, ResolvedPart>;
  /**
   * 抱き込んだ部品の一式(`partLibrary.ts`)。**アセンブリ文書と対で持ち回るもの**で、
   * 省くと部品を 1 つも引けない(置いた部品はすべて「部品が見つかりません。」になる)。
   */
  readonly library?: PartLibrary;
  /**
   * 親の配置(サブアセンブリの入れ子、§2.11)。**外側 ∘ 内側**の順で合成するので、
   * ここへ親の配置を渡すと、この文書の部品はすべて親ごと動く。省くと恒等。
   */
  readonly parent?: RigidPlacement;
  /**
   * 規格部品の寸法表から部品文書を組む台本(FR-612、FR-616、§0.a-0.35。P7 タスク29 の
   * `buildStandardPart`)。**表に無い呼び寸法では `null` を返す**(投げない)。
   * 渡さなければ規格部品は組み立てられず、`errors` に理由が積まれる。
   */
  readonly standardPart?: (source: StandardPartSource) => PartDocument | null;
}

/** 部品文書が引けない(`parts/<ref>.json` が無い)。計画書のタスク6 の検証表の文言。 */
export const MISSING_PART_MESSAGE = '部品が見つかりません。';

/** 規格部品の呼び寸法が寸法表に無い(§2.12 の断りの文言)。 */
export const MISSING_STANDARD_SIZE_MESSAGE = 'この呼び寸法は用意されていません。';

/**
 * 置いた位置が数にならない(壊れた値。FR-504)。
 *
 * 式が読めないだけなら**保存されている評価値をそのまま使う**(`reevaluatePart.ts` の
 * `reevaluateValue` と同じ約束)ので、ここまで来るのは値そのものが有限の数でない場合だけ。
 * 止めずに 0mm へ落として開く——置き場所が 1 つ狂うより、開けないほうが困るためである。
 */
export const INVALID_PLACEMENT_MESSAGE = '置いた位置を数にできません。0mm として開いています。';

/** パラメータ表が空のときの変数表。呼び出しのたびに作らない(`reevaluatePart.ts` と同じ流儀)。 */
const NO_VARIABLES: ReadonlyMap<string, number> = new Map<string, number>();

/**
 * 部品の鍵(§0.a-0.4 の「同じ部品は 1 回だけ」の単位)。
 *
 * - 部品・サブアセンブリは抱き込んだ文書の `ref`。ZIP の中では `parts/<ref>.json` の
 *   1 つの名前空間なので、2 つの枝で鍵がぶつかることはない(§2.2)。
 * - 規格部品は文書を持たない(§0.a-0.35)ので、**形が決まるもの**(種類・呼び寸法・指定)
 *   から鍵を作る。指定は**名前の辞書順**に並べて書く——並べないと、同じ指定を違う順で
 *   作っただけで鍵が変わり、同じ形を 2 回組むことになる(§0.a-0.54 の決定性)。
 */
export function partKeyOf(source: ComponentSource): string {
  switch (source.kind) {
    case 'part':
      return source.partRef;
    case 'subAssembly':
      return source.assemblyRef;
    case 'standardPart': {
      // 鍵は同じ 1 つの物になるので、名前が重なることはない(等しいときの順序は決めなくてよい)。
      const options = Object.entries(source.options)
        .sort((left, right) => (left[0] < right[0] ? -1 : 1))
        .map(([name, value]) => `|${name}=${value}`)
        .join('');
      return `${source.catalog}@${source.catalogRevision}/${source.generatorRevision}:${source.size}${options}`;
    }
  }
}

/** 置いた部品の位置に書かれている式(パラメータ表の「使われていない名前」の判定に使う)。 */
function* placementSources(assembly: AssemblyDocument): Generator<string> {
  for (const component of assembly.components) {
    for (const value of component.placement.position) {
      yield value.source;
    }
  }
}

/**
 * アセンブリのパラメータ表(§0.a-0.9)を解いた変数表。
 *
 * **部品の側のパラメータとは別物**で、混ぜない(部品の表は部品文書の中で閉じている)。
 * 合致の距離・ジョイントの可動範囲・分解の距離(P7 タスク12 以降)も同じ表で評価するので、
 * 作り方を 1 か所に置いて輸出しておく。**表が空なら解析そのものを行わない。**
 */
export function assemblyVariables(assembly: AssemblyDocument): ReadonlyMap<string, number> {
  if (assembly.parameters.length === 0) {
    return NO_VARIABLES;
  }
  return analyzeParameters(assembly.parameters, placementSources(assembly)).variables;
}

/**
 * 式 1 つを変数表つきで数にする。**評価できなければ保存された評価値を残す**
 * (`reevaluatePart.ts` の `reevaluateValue` と同じ約束。FR-504)。
 */
function numberOf(value: ExpressionValue, variables: ReadonlyMap<string, number>): number {
  const result = evaluateExpression(value.source, { variables });
  return result.ok ? result.value.value : value.value;
}

/**
 * 保存形の配置(位置 = 式、向き = 四元数)を、計算に使う配置(数)へ直す。
 *
 * 向きは必ず `normalizeQuaternion` を通す——長さ 1・`w >= 0` へ揃える場所を 1 か所に
 * 保つため(§0.a-0.54)。壊れた向き(長さ 0・NaN)は同関数が恒等へ落とすので、
 * ここでは断らない(位置と違って「どこに置いたか」が狂わないため)。
 */
function rigidPlacementOf(
  component: AssemblyComponent,
  variables: ReadonlyMap<string, number>,
  errors: AssemblyError[],
): RigidPlacement {
  const [x, y, z] = component.placement.position;
  const raw: Vec3 = [numberOf(x, variables), numberOf(y, variables), numberOf(z, variables)];
  if (!raw.every((value) => Number.isFinite(value))) {
    // 3 つのうち何本壊れていても 1 件だけ積む(木の行 1 つに同じ断りを並べない)。
    errors.push({
      componentId: component.id,
      code: 'invalidValue',
      message: INVALID_PLACEMENT_MESSAGE,
    });
  }
  return {
    position: cleanZeroVec3([
      Number.isFinite(raw[0]) ? raw[0] : 0,
      Number.isFinite(raw[1]) ? raw[1] : 0,
      Number.isFinite(raw[2]) ? raw[2] : 0,
    ]),
    rotation: normalizeQuaternion(component.placement.rotation),
  };
}

/** 置いた部品の中身(部品文書)を引く。引けなければ理由をつけて `null`。 */
function partDocumentOf(
  component: AssemblyComponent,
  options: ResolveAssemblyOptions,
): { readonly document: PartDocument } | { readonly message: string } {
  const source = component.source;
  if (source.kind === 'standardPart') {
    const built = options.standardPart?.(source) ?? null;
    return built === null ? { message: MISSING_STANDARD_SIZE_MESSAGE } : { document: built };
  }
  if (source.kind === 'subAssembly') {
    /*
      サブアセンブリ(FR-613)が指すのは抱き込んだ**アセンブリ文書**で、部品の一式
      (`PartLibrary.parts`。中身は `PartDocument` だけ)には入っていない。**部品として
      引き当てにいかない**——ZIP の中では `parts/<ref>.json` の 1 つの名前空間なので、
      壊れたファイルで `ref` がぶつかると部品文書を掴んでしまい、別の形が黙って出る。
      中を再帰で解くのは P7 タスク36 で、この枝がその入り口になる(親の配置を
      `options.parent` へ渡して自分自身を呼ぶ形。§2.11)。
    */
    return { message: MISSING_PART_MESSAGE };
  }
  const document = partOf(options.library ?? EMPTY_PART_LIBRARY, source.partRef);
  return document === undefined ? { message: MISSING_PART_MESSAGE } : { document };
}

/**
 * アセンブリ文書を解決する(FR-601、FR-606)。**例外を投げない**(FR-504)。
 *
 * 部品 1 つの解決は `resolvePart` に任せ、その前に**部品自身のパラメータ表を配る**
 * (`applyParameters`。部品の経路 `recomputePart` とまったく同じ順序で、これを省くと
 * 表の値を変えても部品の形が追従しない)。アセンブリのパラメータ表は配置の式にだけ効く
 * (部品の側のパラメータはアセンブリからは見えない。§0.a-0.9)。
 */
export function resolveAssembly(
  assembly: AssemblyDocument,
  options: ResolveAssemblyOptions = {},
): ResolvedAssembly {
  const parent = options.parent ?? IDENTITY_PLACEMENT;
  const variables = assemblyVariables(assembly);
  const parts = new Map<string, ResolvedPart>();
  const placements = new Map<string, RigidPlacement>();
  const partKeys = new Map<string, string>();
  const errors: AssemblyError[] = [];

  for (const component of assembly.components) {
    // 抑制は失敗ではない(FR-503)。置かれなかったものとして扱い、errors にも入れない。
    if (component.suppressed) {
      continue;
    }
    placements.set(
      component.id,
      composePlacement(parent, rigidPlacementOf(component, variables, errors)),
    );

    const key = partKeyOf(component.source);
    if (parts.has(key)) {
      // 2 個目以降。**解決し直さない**(§0.a-0.4)。形は 1 つを全インスタンスで使い回す。
      partKeys.set(component.id, key);
      continue;
    }
    const resolved = options.resolvedParts?.get(key);
    if (resolved !== undefined) {
      parts.set(key, resolved);
      partKeys.set(component.id, key);
      continue;
    }
    const found = partDocumentOf(component, options);
    if ('message' in found) {
      // 同じ部品を指すインスタンスが複数あれば**その数だけ**積む(木の行ごとに理由を出す)。
      errors.push({ componentId: component.id, code: 'missingPart', message: found.message });
      continue;
    }
    parts.set(key, resolvePart(applyParameters(found.document).document));
    partKeys.set(component.id, key);
  }

  return { parts, placements, partKeys, errors };
}
