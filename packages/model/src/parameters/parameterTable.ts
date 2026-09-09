/**
 * パラメータ表の依存グラフ・循環・未使用・変数表と、表そのものの編集
 * (要件 FR-207・FR-206、計画書 docs/plans/P4b-スケッチの仕上げ.md §2.6・タスク2)。
 *
 * ここに置くのは**純関数だけ**で、DOM にも React にも文書の歩き回りにも触れない。
 * 部品文書の全式を評価し直すのはタスク3(`part/reevaluatePart.ts`)、
 * 断りの文言を組み立てるのはタスク10(`ui/src/parameters/parameterCommands.ts`)の担当にする。
 *
 * 評価の流れ(§2.6):
 *   ① 各パラメータの式が参照する名前を集める(`collectVariableNames`)
 *   ② 有向グラフを作り、深さ優先で並べ替える(参照される側が先)
 *   ③ 循環に含まれる名前は評価せず「循環」の印を付ける(値は前回のまま据え置く)
 *   ④ 循環の外を並び順に評価し、公開用の number と式間用の十進表記を育てる
 */

import {
  checkVariableName,
  collectVariableNames,
  evaluateExpressionExact,
  renameVariable,
  toLengthUnit,
  type VariableNameIssue,
} from '@pointercad/expression';

import { nextSerialName } from '../sketch/createSketchDocument.js';
import { nonLengthVariables } from '../units/length.js';

import type {
  Parameter,
  ParameterAnalysis,
  ParameterFailure,
  ParameterOrder,
} from './types.js';

/** 新しいパラメータの名前の接頭辞(「パラメータ1」「パラメータ2」…)。 */
export const PARAMETER_LABEL = 'パラメータ';

/** 深さ優先の塗り分け。灰は「いま辿っている途中」、黒は「辿り終えた」。 */
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/**
 * 名前から引ける表。同じ名前が 2 つあるときは**先に出たほう**を採る(決定性のため)。
 * 名前の重複はタスク10 が追加・改名の時点で断るので、ここまで来るのは想定外の形だけ。
 */
function indexByName(parameters: readonly Parameter[]): ReadonlyMap<string, Parameter> {
  const byName = new Map<string, Parameter>();
  for (const parameter of parameters) {
    if (!byName.has(parameter.name)) {
      byName.set(parameter.name, parameter);
    }
  }
  return byName;
}

/**
 * 依存グラフ。鍵はパラメータの名前、値はその式が参照している**パラメータの**名前
 * (表に無い名前は評価のときに `unknownVariable` として拾うので、グラフには載せない)。
 *
 * 自分自身への参照(`A = 'A + 1'`)は**残す**。これを落とすと自己参照の循環を見つけられない。
 */
export function parameterDependencies(
  parameters: readonly Parameter[],
): ReadonlyMap<string, readonly string[]> {
  const known = new Set(parameters.map((parameter) => parameter.name));
  const graph = new Map<string, readonly string[]>();
  for (const parameter of parameters) {
    if (graph.has(parameter.name)) {
      continue;
    }
    const referenced = collectVariableNames(parameter.value.source).filter((name) =>
      known.has(name),
    );
    graph.set(parameter.name, referenced);
  }
  return graph;
}

/**
 * 評価順(参照される側が先)と、循環に含まれる名前を求める。
 *
 * 深さ優先で灰・黒に塗り、**辿っている途中(灰)の名前へ戻る辺**を見つけたら、いま辿っている
 * 道のうちその名前から先が 1 つの循環になる。循環に含まれない名前は帰りがけの順(後行順)に
 * 並べると、必ず参照される側が先に来る。
 */
export function parameterEvaluationOrder(parameters: readonly Parameter[]): ParameterOrder {
  const graph = parameterDependencies(parameters);
  const color = new Map<string, number>();
  const path: string[] = [];
  const circular = new Set<string>();
  const finished: string[] = [];

  const visit = (name: string): void => {
    color.set(name, GRAY);
    path.push(name);
    for (const dependency of graph.get(name) ?? []) {
      const state = color.get(dependency) ?? WHITE;
      if (state === GRAY) {
        // 辿っている道へ戻る辺。その名前から先(自分まで)が循環。
        const from = path.indexOf(dependency);
        for (let index = from; index < path.length; index += 1) {
          circular.add(path[index]);
        }
        continue;
      }
      if (state === WHITE) {
        visit(dependency);
      }
    }
    path.pop();
    color.set(name, BLACK);
    finished.push(name);
  };

  for (const name of graph.keys()) {
    if ((color.get(name) ?? WHITE) === WHITE) {
      visit(name);
    }
  }

  return {
    order: finished.filter((name) => !circular.has(name)),
    // 循環の並びは表の順にする(見つけた順にすると表と行き来しづらい)。
    circular: parameters
      .map((parameter) => parameter.name)
      .filter((name, index, names) => names.indexOf(name) === index && circular.has(name)),
  };
}

/**
 * パラメータ表を解析し、変数表・循環・未使用・失敗を返す(FR-207)。
 *
 * `usedSources` は文書の中の全ての式の文字列(タスク3 の `collectExpressionSources` が集める)。
 * 「使われていない名前」の判定に使い、**パラメータ自身の式もここで見る**ので、
 * `usedSources` にパラメータの式が入っていてもいなくても結果は同じになる。
 *
 * 例外を投げない。読めない式・知らない名前・循環はすべて結果の中で表す(NFR-RE-1)。
 */
export function analyzeParameters(
  parameters: readonly Parameter[],
  usedSources: Iterable<string>,
): ParameterAnalysis {
  const byName = indexByName(parameters);
  const { order, circular } = parameterEvaluationOrder(parameters);

  const variables = new Map<string, number>();
  const exactVariables = new Map<string, string>();
  const nonLength = nonLengthVariables(parameters);
  const failures: ParameterFailure[] = [];
  for (const name of order) {
    const parameter = byName.get(name);
    if (parameter === undefined) {
      continue;
    }
    const result = evaluateExpressionExact(parameter.value.source, { variables, exactVariables, nonLengthVariables: nonLength });
    if (result.ok) {
      variables.set(name, result.value.value);
      exactVariables.set(name, result.value.exact);
      continue;
    }
    // 循環の外にあって循環を参照している名前も、ここで unknownVariable として拾われる(§2.6)。
    failures.push({ name, message: result.error.message });
  }

  return {
    variables,
    exactVariables,
    nonLengthVariables: nonLength,
    circular,
    unused: unusedParameterNames(parameters, usedSources),
    failures,
  };
}

/**
 * どこからも参照されない名前(FR-207「使われていない名前」)。
 *
 * **自分自身への参照は「使われている」に数えない。** `A = 'A + 1'` は循環として別に印が付き、
 * これを「使われている」と数えると、誰も使っていない名前が消せなくなる。
 */
function unusedParameterNames(
  parameters: readonly Parameter[],
  usedSources: Iterable<string>,
): readonly string[] {
  const referenced = new Set<string>();
  for (const parameter of parameters) {
    for (const name of collectVariableNames(parameter.value.source)) {
      if (name !== parameter.name) {
        referenced.add(name);
      }
    }
  }
  for (const source of usedSources) {
    for (const name of collectVariableNames(source)) {
      referenced.add(name);
    }
  }
  return parameters
    .map((parameter) => parameter.name)
    .filter((name, index, names) => names.indexOf(name) === index && !referenced.has(name));
}

/**
 * その名前を参照している**他の**パラメータの名前。削除の可否の判断に使う(タスク10)。
 * 自分自身への参照は数えない(理由は `unusedParameterNames` と同じ)。
 */
export function referencesTo(
  parameters: readonly Parameter[],
  name: string,
): readonly string[] {
  return parameters
    .filter(
      (parameter) =>
        parameter.name !== name && collectVariableNames(parameter.value.source).includes(name),
    )
    .map((parameter) => parameter.name);
}

/** 表の末尾へ足す。元の配列は変えない。重複した名前を断るのは呼び出し側(タスク10)。 */
export function addParameter(
  parameters: readonly Parameter[],
  parameter: Parameter,
): readonly Parameter[] {
  return [...parameters, parameter];
}

/**
 * 名前で 1 つ取り除く。**消すだけ**で、参照が残っているかは見ない。
 * 参照されている名前を消してよいかの判断は、`referencesTo` を見て呼び出し側(タスク10)が行う
 * (型の層で断ると、断りの文へ参照元の件数を差し込めない)。
 */
export function removeParameter(
  parameters: readonly Parameter[],
  name: string,
): readonly Parameter[] {
  return parameters.filter((parameter) => parameter.name !== name);
}

/** 名前で 1 つ差し替える。並び順は変えない。見つからなければ元の配列をそのまま返す。 */
export function replaceParameter(
  parameters: readonly Parameter[],
  name: string,
  next: Parameter,
): readonly Parameter[] {
  return parameters.map((parameter) => (parameter.name === name ? next : parameter));
}

/**
 * 改名。参照している**他のパラメータの式**も同時に書き換える(タスク1 の `renameVariable`)。
 * 字句単位で差し替えるので、`板厚` を改名しても `板厚さ` という別の名前は変わらない。
 *
 * 式の**値**は変えない。名前が変わっても数は変わらないので、`value` と `display` はそのまま持つ
 * (FR-202「式は文字列のまま保存され、再表示・再編集できる」)。
 *
 * **文書の側の式**(押し出しの距離など)は、この関数の対象外。文書を歩くのはタスク3 の担当。
 * `from` の名前が表に無ければ、何もせず元の配列を返す。
 */
export function renameParameter(
  parameters: readonly Parameter[],
  from: string,
  to: string,
): readonly Parameter[] {
  if (!parameters.some((parameter) => parameter.name === from)) {
    return parameters;
  }
  return parameters.map((parameter) => {
    const source = renameVariable(parameter.value.source, from, to);
    return {
      ...parameter,
      name: parameter.name === from ? to : parameter.name,
      value: source === parameter.value.source ? parameter.value : { ...parameter.value, source },
    };
  });
}

/**
 * 表の中で 1 行を動かす(利用者の並べ替え)。`from` の行を抜いて `to` の位置へ差し込む。
 * 範囲の外の位置を渡されたら何もせず元の配列を返す(画面の取り違えで表が壊れないように)。
 *
 * 並び順は**表示の順**でしかなく、評価の順序(依存順)には影響しない(§2.6)。
 */
export function reorderParameters(
  parameters: readonly Parameter[],
  from: number,
  to: number,
): readonly Parameter[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return parameters;
  }
  if (from < 0 || from >= parameters.length || to < 0 || to >= parameters.length || from === to) {
    return parameters;
  }
  const next = [...parameters];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 次の空き名(「パラメータ1」「パラメータ2」…)。
 * `createSketchDocument.ts` の `nextSerialName` と同じ流儀(最大連番 + 1)にする。
 */
export function nextParameterName(parameters: readonly Parameter[]): string {
  return nextSerialName(
    parameters.map((parameter) => parameter.name),
    PARAMETER_LABEL,
  );
}

/* ---------------------------------------------------------------------------
 * 新しく付ける名前の検査(P6 §0.a-0.1、`docs/報告記録.md` 2026-09-06 02:16 の統括の決定)
 * ------------------------------------------------------------------------- */

/**
 * その綴りが長さの単位か(`mm` / `in` / `"`。大文字小文字を問わない)。
 * 綴りの正本は `@pointercad/expression` の `lengthUnits.ts` 1 か所だけなので、ここでは
 * その表(`toLengthUnit`)に尋ねる。単位を増やしたときに、こちらの書き漏らしが起きない。
 */
export function isLengthUnitName(name: string): boolean {
  return toLengthUnit(name) !== null;
}

/**
 * **新しく付ける**パラメータ名として使えない理由。`checkVariableName` の理由に、
 * 「単位の名前」1 つを足したもの。
 */
export type NewParameterNameIssue = VariableNameIssue | 'lengthUnitName';

/**
 * 単位の名前をパラメータ名にしようとしたときの断り(NFR-UX-5)。
 *
 * 文言をここに置くのは、`packages/model` から `ja.json`(`packages/ui`)を引けないため
 * (`diagnose.ts` の `CONSTRAINT_TOO_MANY_MESSAGE` と同じ扱い)。画面側がこの文言を
 * ja.json のキーへ移すなら、この定数を消して 1 か所に戻す。
 */
export const LENGTH_UNIT_NAME_MESSAGE = 'in と mm は単位の名前なので、パラメータの名前には使えません。';

/**
 * **新しく付ける**パラメータ名として使えるか。使えない理由を返し、使えるなら null を返す。
 *
 * `checkVariableName`(式として読める名前か)に加えて、**長さの単位の綴り**(`mm` / `in` /
 * `"`)を断る。これらは変数名としては書けてしまうが、`2mm` や `(w)in` のように数や閉じ
 * 括弧の直後では単位として読まれるので(`expression` の `tokenize.ts` の `canPrecedeUnit`)、
 * 同じ綴りのパラメータを新しく作らせると「どちらの意味か式によって変わる」名前が生まれる。
 *
 * **既存の文書に `mm` や `in` という名前があっても、これで弾かない。** 読み込みと評価は
 * これまでどおり通す(`checkVariableName` も `analyzeParameters` も変えていない)。
 * 断るのは利用者がこれから名前を打つとき(追加・改名)だけである(統括の決定)。
 */
export function checkNewParameterName(name: string): NewParameterNameIssue | null {
  // 単位の判定を先に置く。`"` は識別子の文字ではないので `checkVariableName` を先に呼ぶと
  // 「使えない文字があります」になり、単位だから断ったことが利用者へ伝わらない。
  if (isLengthUnitName(name)) {
    return 'lengthUnitName';
  }
  return checkVariableName(name);
}
