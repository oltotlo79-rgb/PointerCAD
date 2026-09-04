/**
 * 拘束の道具とストアのつなぎ(FR-313、FR-504、NFR-UX-1、NFR-UX-5、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md タスク13)。
 *
 * 判断そのものは `constraintCommands.ts`(t12、純関数)と `constraintPicking.ts`(純関数)が
 * 持ち、ここは**ストアを読んで渡し、返ってきたものをストアへ置く**だけにする
 * (`shell/commandLineActions.ts` と同じ置き方。`.tsx` からも `attachSketchInteraction.ts`
 * からも同じ 1 か所を呼べるようにするため)。
 *
 * **押したら必ず何かが起きる**(P4 タスク12 の失敗 (b))。条件がそろっていなければ
 * 拘束は付かないが、帯に「あと何を押せばよいか」か「なぜ付けられないか」が必ず出る。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import {
  baseWorkPlane,
  replaceSketch,
  type ConstraintTarget,
  type SketchConstraintKind,
  type SketchDocument,
  type SketchResolveOptions,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  commitAddConstraint,
  commitRemoveConstraint,
  commitSetConstraintValue,
  constraintContextOf,
  constraintKindLabel,
  constraintNeedsValue,
  constraintReadiness,
  constraintRejectionMessageKey,
  measuredConstraintValue,
  type ConstraintContext,
} from './constraintCommands.js';
import type { EditToolReadiness } from './editCommands.js';
import {
  constraintTargetCount,
  orderConstraintTargets,
  toggleConstraintTarget,
  type ConstraintPick,
} from './constraintPicking.js';

type Store = ReturnType<typeof useAppStore.getState>;

/**
 * 拘束を下見するときの作図面の引き方。model は中で文書を解き直すので、任意の作業平面
 * (FR-328)も引けるよう、いま解いてある面を渡す(`attachSketchInteraction.ts` の
 * `editResolveOptions` と同じ渡し方)。
 */
export function constraintResolveOptions(store: Store): SketchResolveOptions {
  return {
    workPlane: (planeId) =>
      planeId === store.workPlaneId ? store.workPlane : baseWorkPlane(planeId),
  };
}

/**
 * 判定と測定の材料(t12 の申し送り「1 回作って使い回す」)。**拘束は解かない**ので、
 * ボタンの色を決めるためだけに反復計算が走ることはない(NFR-PF-1)。
 */
export function constraintContextOfStore(store: Store): ConstraintContext {
  return constraintContextOf(store.sketch, constraintResolveOptions(store));
}

/**
 * 帯の一言を組み立てるだけの軽い材料。**解決し直さない**(いま描いている結果を使い回す)。
 *
 * 帯は状態が変わるたびに組み立て直されるので、ここで `constraintContextOf` を呼ぶと
 * 1 文を出すためだけにスケッチを解き直すことになる(NFR-PF-1)。作図面と動かせる数は、
 * 「何を押せばよいか」の 1 文には要らない(`constraintReadiness` は選択が空のときそこへ
 * たどり着く前に断りを返す)ので null で足りる。
 */
function guideContext(store: Store): ConstraintContext {
  return { resolved: store.resolvedSketch, plane: null, variableSet: null };
}

/**
 * 帯へ出す「あと何を押せばよいか」(NFR-UX-7)。拘束の道具を選んでいなければ null。
 *
 * まだ 1 つも押していないときは、**選択が空のときの断りの文**をそのまま出す
 * (「線を 2 本選んでください。」)。同じ文言を 2 か所に書かないため。
 */
export function constraintPickGuide(store: Store): string | null {
  const kind = store.activeConstraintKind;
  if (kind === null) {
    return null;
  }
  const label = constraintKindLabel(kind);
  const separator = t('statusBar.constraintPickSeparator');
  const picked = store.constraintTargets.length;
  if (picked === 0) {
    const readiness = constraintReadiness(store.sketch, [], kind, guideContext(store));
    return `${label}${separator}${readiness.message ?? t('statusBar.constraintPickReady')}`;
  }
  const counted = t('statusBar.constraintPicked').replace('{count}', String(picked));
  return `${label}${separator}${counted}`;
}

/**
 * 足せた拘束をストアへ入れる。**1 回の操作 = Undo 1 段**(`setSketch` が `applyDocument` を
 * 1 回だけ通る)なので、取り消し 1 回で元へ戻る(NFR-UX-3)。
 */
function applyAdded(store: Store, document: SketchDocument, firstId: string): void {
  store.setSketch(document);
  const next = useAppStore.getState();
  next.setConstraintTargets([]);
  next.setConstraintPrompt(null);
  // 付けたばかりの拘束を一覧と印で見せる(何が起きたかを目で確かめられるように)。
  next.setSelectedConstraint(firstId);
}

/**
 * 決まった指し先で拘束を付ける。数値を聞く拘束(距離・角度・半径・直径)で値がまだ無ければ、
 * その場入力を開き、**いま測った値**を既定値にする(NFR-UX-4)。
 */
function addConstraint(
  store: Store,
  kind: SketchConstraintKind,
  targets: readonly ConstraintTarget[],
  context: ConstraintContext,
  anchor: readonly [number, number],
  value?: ExpressionValue,
): void {
  if (constraintNeedsValue(kind) && value === undefined) {
    const measured = measuredConstraintValue(kind, targets, context);
    store.setConstraintPrompt({
      kind,
      targets,
      // 測れないとき(長さ 0 の線分など)は空にして、利用者に入れてもらう(NFR-UX-5)。
      defaultSource: measured === null ? '' : measured.source,
      anchor,
    });
    return;
  }
  const outcome = commitAddConstraint(store.sketch, kind, targets, value, context);
  if (!outcome.ok) {
    store.setConstraintError(outcome.message);
    store.setConstraintTargets([]);
    store.setConstraintPrompt(null);
    return;
  }
  applyAdded(store, outcome.document, outcome.constraintId);
}

/** ビューポートの真ん中(まだ何も押していないときのポップアップの置き場)。 */
function centreOfViewport(store: Store): readonly [number, number] {
  const [width, height] = store.viewportSize;
  return [Math.round(width / 2), Math.round(height / 2)];
}

/** 何も選んでいないときの下見。道具を選ぶための一覧なので全部押せる。 */
const READY_TO_CHOOSE: EditToolReadiness = { ready: true, reasonKey: null };

/**
 * ツールバーの「拘束」の一覧の入り切り(NFR-UX-5「実行前に理由を出す」)。
 *
 * **何も選んでいなければ 14 種すべて押せる。** 拘束の道具は「道具を選んでから要素を順に
 * 押す」流儀(統括の決定 2026-09-05)なので、選択が空のときに全部を不活性にすると
 * 道具そのものを選べなくなる。何かを選んでいるときは、その選択に付けられない種類だけを
 * 不活性にして理由を吹き出しに出す(NFR-UX-1 の「対象を選んでから操作」の側)。
 *
 * 返す関数は**同じ描画の中で使い回す**前提で、材料(`ConstraintContext`)を最初に
 * 要るときだけ 1 度作る。一覧を開かないかぎり解決は 1 回も走らない(NFR-PF-1)。
 */
export function constraintToolReadinessOf(): (kind: SketchConstraintKind) => EditToolReadiness {
  const store = useAppStore.getState();
  let context: ConstraintContext | null = null;
  return (kind) => {
    if (store.selection.length === 0) {
      return READY_TO_CHOOSE;
    }
    context ??= constraintContextOfStore(store);
    const readiness = constraintReadiness(store.sketch, store.selection, kind, context);
    return {
      ready: readiness.ready,
      reasonKey:
        readiness.reason === null ? null : constraintRejectionMessageKey(readiness.reason),
    };
  };
}

/**
 * ツールバーで拘束の道具を選んだとき(NFR-UX-1「対象を選んでから操作」)。
 *
 * すでに条件を満たす要素が選ばれていればその場で付き、足りなければ**道具を選んだ状態**に
 * なって、ビューポートで押した要素を順に受け取る(統括の決定 2026-09-05、トリムと同じ流儀)。
 */
export function chooseConstraintTool(kind: SketchConstraintKind): void {
  const before = useAppStore.getState();
  const context = constraintContextOfStore(before);
  const readiness = constraintReadiness(before.sketch, before.selection, kind, context);
  const anchor = before.pickAnchor ?? centreOfViewport(before);
  if (readiness.ready) {
    // 選んでいるものだけで足りるので、道具の状態にはせずその場で付ける。
    before.setConstraintTool(null);
    addConstraint(useAppStore.getState(), kind, readiness.targets, context, anchor);
    return;
  }
  // 足りない。道具を選んだ状態にして、押した要素を順に受け取る(帯に理由が出る)。
  before.setConstraintTool(kind);
}

/**
 * 拘束の道具でビューポートを押したとき(タスク13)。押した相手を積み、必要な数がそろったら
 * 付ける。同じところをもう一度押すと外れる(選び直せる)。
 */
export function pickForConstraint(pick: ConstraintPick, anchor: readonly [number, number]): void {
  const store = useAppStore.getState();
  const kind = store.activeConstraintKind;
  if (kind === null) {
    return;
  }
  const targets = toggleConstraintTarget(store.constraintTargets, pick.target);
  store.setConstraintError(null);
  // 押した要素は選択にも入れて 3D で光らせる(何を押したかが見えるように、NFR-UX-7)。
  store.setSelection(targets.length === 0 ? [] : [...new Set([...store.selection, pick.elementId])]);
  if (targets.length < constraintTargetCount(kind)) {
    store.setConstraintTargets(targets);
    return;
  }
  const context = constraintContextOfStore(store);
  const ordered = orderConstraintTargets(kind, targets, context.resolved);
  store.setConstraintTargets(ordered);
  addConstraint(store, kind, ordered, context, anchor);
}

/** その場入力で値を決めたとき(FR-313)。空のまま決めると既定値(いま測った値)になる。 */
export function commitConstraintPrompt(source: string): void {
  const store = useAppStore.getState();
  const prompt = store.constraintPrompt;
  if (prompt === null) {
    return;
  }
  const trimmed = source.trim();
  const value = evaluateConstraintSource(store, trimmed === '' ? prompt.defaultSource : trimmed);
  if (value === null) {
    // 読めない式は断って、聞いたまま残す(実行してから失敗させない、NFR-UX-5)。
    store.setConstraintError(t('constraint.error.invalidValue'));
    return;
  }
  store.setConstraintPrompt(null);
  addConstraint(
    useAppStore.getState(),
    prompt.kind,
    prompt.targets,
    constraintContextOfStore(store),
    prompt.anchor,
    value,
  );
}

/** その場入力をやめたとき。押した相手も捨てて、道具はそのまま残す(続けて選び直せる)。 */
export function cancelConstraintPrompt(): void {
  const store = useAppStore.getState();
  store.setConstraintPrompt(null);
  store.setConstraintTargets([]);
}

/** 拘束の道具をやめる(Esc、ツールバーの押し直し)。 */
export function cancelConstraintTool(): void {
  useAppStore.getState().setConstraintTool(null);
}

/** 一覧の「×」(FR-313、NFR-UX-3 で取り消し 1 回で戻る)。 */
export function removeConstraintById(constraintId: string): void {
  const store = useAppStore.getState();
  const outcome = commitRemoveConstraint(store.sketch, constraintId);
  if (!outcome.ok) {
    store.setConstraintError(outcome.message);
    return;
  }
  store.setSketch(outcome.document);
  useAppStore.getState().setSelectedConstraint(null);
}

/**
 * 式を評価する(FR-207 のパラメータ表の名前もそのまま書ける)。読めなければ null。
 * 変数表はストアの 1 か所(`parameterAnalysis.variables`)から取り、打つ場所によって
 * 通ったり通らなかったりしないようにする(t18 の申し送り)。
 */
export function evaluateConstraintSource(store: Store, source: string): ExpressionValue | null {
  const result = evaluateExpression(source, { variables: store.parameterAnalysis.variables });
  return result.ok ? result.value : null;
}

/**
 * 一覧で寸法拘束の値を書き換える(FR-313、FR-207)。式のまま入るので、パラメータ表の
 * 名前(「幅」)を書けば表を 1 か所直すだけで形が追従する。
 *
 * 1 文字ごとに呼ばれるので、同じ拘束の続けざまの書き換えは Undo の 1 段にまとめる
 * (プロパティ欄の式の編集と同じ `coalesceKey` の流儀、§0.a-0.13)。
 */
export function changeConstraintValue(constraintId: string, source: string): void {
  const store = useAppStore.getState();
  const value = evaluateConstraintSource(store, source);
  if (value === null) {
    // 読めない式のあいだは文書を変えない(打っている途中で形が壊れないように)。
    return;
  }
  const outcome = commitSetConstraintValue(store.sketch, constraintId, value);
  if (!outcome.ok) {
    store.setConstraintError(outcome.message);
    return;
  }
  store.applyDocument(replaceSketch(store.document, outcome.document), {
    coalesceKey: `constraintValue:${constraintId}`,
  });
}
