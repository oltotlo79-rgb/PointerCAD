/**
 * パラメータ表(名前を付けた数値、FR-207)の追加・削除・改名・並べ替えを、その場の編集から
 * 部品文書へ渡す純関数(要件 FR-207、NFR-UX-5、計画書 docs/plans/P4b-スケッチの仕上げ.md
 * §2.6・タスク10)。
 *
 * `referenceCommands.ts` / `shapeCommands.ts` と同じ流儀にそろえる。DOM にもストアにも
 * 触れず、文書は不変で、断るときは元の文書をそのまま返して理由だけを添える(FR-504)。
 * パネル(タスク11)はここが返した文書をそのままストアへ渡すだけでよい。
 *
 * **どの確定関数も、最後に必ず `applyParameters`(model、タスク3)を通してから返す。**
 * これでパラメータ表の値を1か所変えると、参照している押し出しの距離・穴の径などの
 * 欄がすべて追従した状態になる(FR-502、利用者の例「板厚 = 3、穴径 = 板厚 * 2」)。
 *
 * **1文字打つごとに呼ばない。** `applyParameters` は部品文書全体(スケッチ・立体・
 * 基準ジオメトリ)を歩くので、呼ぶのは確定(Enter・フォーカスが外れる)のときだけにする。
 * 打っている途中の式1本だけの評価は、この先(タスク11)の `ExpressionField` の役目にする。
 *
 * **循環を作ることは断らない。** FR-207 は「参照が循環している名前を画面上で示す」であり、
 * 作らせない、ではない。途中で必ず循環する瞬間があるので(A を作ってから B を作る間)、
 * 断ると表が編集できなくなる。`analyzeParameters`(`applyParameters` の内部)が
 * 例外を投げずに `analysis.circular` へ印を付けるので、ここでは何もしない。
 */

import {
  checkVariableName,
  collectVariableNames,
  expressionValueFromNumber,
  type VariableNameIssue,
} from '@pointercad/expression';
import {
  addParameter,
  applyParameters,
  collectExpressionSources,
  nextParameterName,
  referencesTo,
  removeParameter,
  renameParameter,
  renameVariableInPartDocument,
  reorderParameters,
  replaceParameter,
  type Parameter,
  type ParameterAnalysis,
  type PartDocument,
  type ReevaluationFailure,
} from '@pointercad/model';

import { t } from '../i18n/t.js';

/* ---------------------------------------------------------------------------
 * 結果の型
 * ------------------------------------------------------------------------- */

/**
 * 確定できた。`applyParameters` を通した文書をそのまま返す(値の追従が確定の中で起きる)。
 */
export interface ParameterCommandSuccess {
  readonly ok: true;
  readonly document: PartDocument;
  /** パラメータ表そのものの解析(循環・未使用・評価できなかった名前)。 */
  readonly analysis: ParameterAnalysis;
  /** 文書の側で評価し直せなかった式(パラメータ表の失敗は analysis.failures)。 */
  readonly failures: readonly ReevaluationFailure[];
}

/**
 * 断った理由のコード。`checkVariableName` の理由(`VariableNameIssue`)はそのまま使う
 * (「そのまま日本語に」する対応が 1 か所で追える)。
 */
export type ParameterCommandRejectionReason =
  | VariableNameIssue
  | 'duplicateName'
  | 'duplicateRename'
  | 'referenced'
  | 'notFound';

export interface ParameterCommandRejection {
  readonly ok: false;
  readonly reason: ParameterCommandRejectionReason;
  /** 画面へそのまま出す日本語(NFR-UX-5)。 */
  readonly message: string;
}

export type ParameterCommandOutcome = ParameterCommandSuccess | ParameterCommandRejection;

/* ---------------------------------------------------------------------------
 * 断りの文言(NFR-MA-5: 動かない文言は ja.json、件数を差し込む文だけ組み立てる)
 * ------------------------------------------------------------------------- */

function nameIssueMessage(issue: VariableNameIssue): string {
  switch (issue) {
    case 'empty':
      return t('parameter.error.empty');
    case 'startsWithDigit':
      return t('parameter.error.startsWithDigit');
    case 'reserved':
      return t('parameter.error.reserved');
    case 'invalidCharacter':
      return t('parameter.error.invalidCharacter');
  }
}

function invalidName(issue: VariableNameIssue): ParameterCommandRejection {
  return { ok: false, reason: issue, message: nameIssueMessage(issue) };
}

function duplicateName(): ParameterCommandRejection {
  return { ok: false, reason: 'duplicateName', message: t('parameter.error.duplicateName') };
}

function duplicateRename(): ParameterCommandRejection {
  return { ok: false, reason: 'duplicateRename', message: t('parameter.error.duplicateName') };
}

function notFound(): ParameterCommandRejection {
  return { ok: false, reason: 'notFound', message: t('parameter.error.notFound') };
}

/**
 * 削除を断る文。限界値(件数)を差し込むので ja.json のキー1つでは組み立てられない
 * (`numericInput.ts` の `describeRange` と同じ事情)。見出しの語だけ ja.json から引く。
 */
function referencedMessage(count: number): string {
  return `${t('parameter.error.referencedPrefix')}${String(count)}${t(
    'parameter.error.referencedSuffix',
  )}`;
}

function hasName(parameters: readonly Parameter[], name: string): boolean {
  return parameters.some((parameter) => parameter.name === name);
}

/**
 * 文書の中(パラメータ表以外)で、その名前が何箇所から参照されているか。
 * `collectExpressionSources` はパラメータ表自身の式を含まないので、二重に数えない
 * (`referencesTo` がパラメータどうしの参照を数える)。
 */
function documentUsageCount(document: PartDocument, name: string): number {
  let count = 0;
  for (const source of collectExpressionSources(document)) {
    if (collectVariableNames(source).includes(name)) {
      count += 1;
    }
  }
  return count;
}

/** 部品文書のパラメータ表を差し替えて `applyParameters` を通す(全確定関数の最後の一歩)。 */
function applied(document: PartDocument): ParameterCommandSuccess {
  const outcome = applyParameters(document);
  return {
    ok: true,
    document: outcome.document,
    analysis: outcome.analysis,
    failures: outcome.failures,
  };
}

/* ---------------------------------------------------------------------------
 * 新しい行の下書き
 * ------------------------------------------------------------------------- */

/**
 * 新しいパラメータの行の既定(名前は次の空き名、式は `0`、単位は mm)。
 * 表の「+」で行を足すときの初期値にする(タスク11)。
 */
export function parameterDraftFor(document: PartDocument): Parameter {
  return {
    name: nextParameterName(document.parameters),
    value: expressionValueFromNumber(0),
    unit: 'mm',
    description: '',
  };
}

/* ---------------------------------------------------------------------------
 * 確定関数(追加・削除・改名・差し替え・並べ替え)
 * ------------------------------------------------------------------------- */

/**
 * 1 行を足す(FR-207)。名前が不正・重複なら断る。
 */
export function commitAddParameter(document: PartDocument, draft: Parameter): ParameterCommandOutcome {
  const issue = checkVariableName(draft.name);
  if (issue !== null) {
    return invalidName(issue);
  }
  if (hasName(document.parameters, draft.name)) {
    return duplicateName();
  }
  return applied({ ...document, parameters: addParameter(document.parameters, draft) });
}

/**
 * 1 行を消す(FR-207)。参照が残っていれば断り、件数を文へ差し込む
 * (他のパラメータからの参照は `referencesTo`、文書の側からの参照は `collectExpressionSources`
 * を数える。model の `removeParameter` 自身は消すだけで可否を見ないので、ここで判断する)。
 */
export function commitRemoveParameter(document: PartDocument, name: string): ParameterCommandOutcome {
  if (!hasName(document.parameters, name)) {
    return notFound();
  }
  const total = referencesTo(document.parameters, name).length + documentUsageCount(document, name);
  if (total > 0) {
    return { ok: false, reason: 'referenced', message: referencedMessage(total) };
  }
  return applied({ ...document, parameters: removeParameter(document.parameters, name) });
}

/**
 * 改名(FR-207)。参照している他のパラメータの式(`renameParameter`)と、文書の側の式
 * (`renameVariableInPartDocument`)の両方を書き換える。値は変えない(名前が変わっても
 * 数は変わらないため)。
 */
export function commitRenameParameter(
  document: PartDocument,
  from: string,
  to: string,
): ParameterCommandOutcome {
  if (!hasName(document.parameters, from)) {
    return notFound();
  }
  if (from === to) {
    // 同じ名前への「改名」は書き換えるものが無い。applyParameters だけ通して整合させる。
    return applied(document);
  }
  const issue = checkVariableName(to);
  if (issue !== null) {
    return invalidName(issue);
  }
  if (hasName(document.parameters, to)) {
    return duplicateRename();
  }
  const parameters = renameParameter(document.parameters, from, to);
  const renamed = renameVariableInPartDocument({ ...document, parameters }, from, to);
  return applied(renamed);
}

/**
 * 値・単位・説明を差し替える(FR-207)。**名前は変えない**(改名は `commitRenameParameter` の
 * 役目。参照の追従が要るため、ここで名前を混ぜると二重の経路ができる)。
 *
 * 式が読めない・循環している値も断らない。既存の式の欄の赤表示(`analysis.failures` /
 * `analysis.circular`)に任せる(タスク10 の落とし穴、NFR-RE-1「止めずに警告する」)。
 */
export function commitReplaceParameter(
  document: PartDocument,
  name: string,
  patch: Partial<Parameter>,
): ParameterCommandOutcome {
  const current = document.parameters.find((parameter) => parameter.name === name);
  if (current === undefined) {
    return notFound();
  }
  const next: Parameter = { ...current, ...patch, name: current.name };
  return applied({ ...document, parameters: replaceParameter(document.parameters, name, next) });
}

/**
 * 表の中で 1 行を動かす(FR-207)。並び順は表示の順でしかなく、評価順(依存順)には
 * 影響しない。範囲の外の位置は model の `reorderParameters` が黙って無視する。
 */
export function commitReorderParameters(
  document: PartDocument,
  from: number,
  to: number,
): ParameterCommandOutcome {
  return applied({ ...document, parameters: reorderParameters(document.parameters, from, to) });
}

/* ---------------------------------------------------------------------------
 * パネルの行(タスク11 が表へ並べる)
 * ------------------------------------------------------------------------- */

/** パラメータ表の 1 行(名前・式・値・単位・説明・循環/未使用/失敗の印)。 */
export interface ParameterRow {
  readonly name: string;
  /** 式の文字列(そのまま再編集できる、FR-202)。 */
  readonly source: string;
  /** 評価済みの値。読み取り専用(式から導かれる)。 */
  readonly value: number;
  readonly unit: Parameter['unit'];
  readonly description: string;
  /** 参照が循環している(FR-207)。 */
  readonly circular: boolean;
  /** どこからも参照されていない(FR-207)。 */
  readonly unused: boolean;
  /** 評価できなかった理由。無ければ null。 */
  readonly failureMessage: string | null;
}

/**
 * パラメータ表をパネルの行へ直す(FR-207)。表の並び順(`document.parameters` の順)のまま返す。
 * 値は `document.parameters` にすでに書き戻されている評価値をそのまま使う
 * (`applyParameters` が確定のたびに書き直すので、ここで変数表から引き直さない。
 * 循環しているときは前回の値のまま据え置かれているのも、そのまま画面に出したい振る舞い)。
 */
export function parameterRowsOf(
  document: PartDocument,
  analysis: ParameterAnalysis,
): readonly ParameterRow[] {
  const failureByName = new Map(
    analysis.failures.map((failure) => [failure.name, failure.message] as const),
  );
  const circular = new Set(analysis.circular);
  const unused = new Set(analysis.unused);
  return document.parameters.map((parameter) => ({
    name: parameter.name,
    source: parameter.value.source,
    value: parameter.value.value,
    unit: parameter.unit,
    description: parameter.description,
    circular: circular.has(parameter.name),
    unused: unused.has(parameter.name),
    failureMessage: failureByName.get(parameter.name) ?? null,
  }));
}
