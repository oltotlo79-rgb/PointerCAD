/**
 * ソリッドの道具を押したときの配線(FR-401〜、FR-1101・FR-1102)。
 *
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import type { BooleanOperation } from '@pointercad/model';
import {
  createNumericInput,
  SOLID_TOOL_STEPS,
  type SolidToolId,
} from '../../sketch/numericInput.js';
import { ruledSelectionHasSphere } from '../../solid/ruledCommands.js';
import { selectedCurvePath } from '../../solid/shapeEditCommands.js';
import { sweepGuideCandidates } from '../../solid/sweepGuideChoices.js';
import {
  commitBooleanFromSelection,
  selectedLineRef,
  type SolidToolReadiness,
} from '../../solid/solidCommands.js';
import { subShapeBodiesOf } from '../../solid/subShapeSelection.js';
import { useAppStore } from '../../store/useAppStore.js';
import { viewportCenterAnchor } from './toolbarShared.js';

/**
 * ソリッドのその場入力を出す場所。
 *
 * 立体の道具は「先に面を選んでから押す」ので、最後にビューポートで選んだところの
 * すぐそばへ出すと、何に対する入力なのかが目で追える(NFR-UX-1、NFR-UX-2)。
 * ツリーから選んだときなど、ビューポートを押していなければ中央へ出す。
 */
function solidAnchor(): readonly [number, number] {
  return useAppStore.getState().pickAnchor ?? viewportCenterAnchor();
}

/**
 * 道具のボタンを押したときの処理。
 *
 * 同じ道具をもう一度押したら解除して選択へ戻す(取りかけの操作を残さない、NFR-UX-3)。
 * 数値で位置を決める道具は、選んだ時点で入力欄を開く(NFR-UX-1)。
 */

/**
 * 押し出し・回転・縫合(FR-401〜403)。道具を選び、その場で数値を聞く(NFR-UX-2)。
 * 回転は線分が選ばれていれば「選んだ線分」も軸の候補に加える(§0.a-0.9)。
 */
function openSolidInput(tool: SolidToolId): void {
  const store = useAppStore.getState();
  store.setActiveTool(tool);
  const axisLine = tool === 'revolve' ? selectedLineRef(store.document, store.selection) : undefined;
  /*
    面をつなぐ(FR-430)の「なめらかさ」は、**球を含む断面のときだけ**出す(§0.a-0.87)。
    球を含まない断面では点の数が形に 1 つも効かないので、出すと「変えたのに形が変わらない」
    ことになる。判定は `ruledCommands.ts` の 1 か所に置き、ここは選択から見込んで渡すだけ。
  */
  const ruledHasSphere =
    tool === 'ruled'
      ? ruledSelectionHasSphere({
          document: store.document,
          bodies: subShapeBodiesOf(store.bodies),
          selection: store.selection,
        })
      : undefined;
  store.openNumericInput(
    createNumericInput(tool, SOLID_TOOL_STEPS[tool], undefined, {
      ...(axisLine === undefined ? {} : { axisLine }),
      ...(ruledHasSphere === undefined ? {} : { ruledHasSphere }),
      ...(tool === 'sweep' ? { sweepGuides: sweepGuideCandidates(store.document, selectedCurvePath(store.document, store.selection) ?? undefined) } : {}),
    }),
    solidAnchor(),
  );
}

/**
 * 和・差・積(FR-404)。数値を聞かないので、押した瞬間に作って選択へ戻す(§0.a-0.6)。
 * 作った立体をそのまま選んでおくと、続けてもう 1 つ組み合わせられる(NFR-UX-1)。
 */
function commitBooleanAction(operation: BooleanOperation): void {
  const store = useAppStore.getState();
  const outcome = commitBooleanFromSelection(store.document, store.selection, operation);
  if (!outcome.ok) {
    store.setSolidError(outcome.reasonKey);
    return;
  }
  store.applyDocument(outcome.document);
  store.setSelection([outcome.featureId]);
  store.setActiveTool('select');
}

/**
 * 「作る」「加工」の一覧から道具を選んだときの処理(P5 タスク51)。
 *
 * 押せるならその場入力を開く。押せなくても、押した時点で選ぶものを道具が要る種類へ
 * 切り替える(§0.a-0.6、P3 タスク30 不具合(b))。これで「穴を選ぶ → 面を選ぶ →
 * 点を Shift で足す → もう一度穴」の流れが成立する。あわせて理由を帯へも出す
 * (ツールチップだけでは押した瞬間に読めないため、NFR-UX-5)。
 */
export function runSolidTool(id: SolidToolId, readiness: SolidToolReadiness): void {
  if (readiness.ready) {
    openSolidInput(id);
    return;
  }
  const store = useAppStore.getState();
  store.setActiveTool(id);
  store.setSolidError(readiness.reasonKey);
}

/**
 * 「合わせる」の一覧(和・差・積)から選んだときの処理(P5 タスク51)。
 *
 * 数値を聞かず、選ぶものも常に立体のままなので、押せないときも道具を切り替えず
 * 理由だけを出す(P4b までの図柄ボタンと同じ切り分け)。
 */
export function runCombineTool(operation: BooleanOperation, readiness: SolidToolReadiness): void {
  if (!readiness.ready) {
    useAppStore.getState().setSolidError(readiness.reasonKey);
    return;
  }
  commitBooleanAction(operation);
}

/**
 * 「測る」を押したときの処理(FR-1101、FR-1102。タスク32、§2.10)。
 *
 * **押したら必ず何かが起きる**(NFR-UX-5)。測れるなら測り、測れないなら帯に理由を出す。
 * どちらの場合も道具は「測る」にする(`keepsSelectionKind` が真なので、いま選んでいる
 * ものも選ぶ種類もそのまま残る、§2.15)。
 *
 * **同じ道具をもう一度押したら「測り直す」。** 他の一覧は「もう一度押したら解除」だが、
 * 測るは取りかけの状態を持たない道具で、解除しても画面から何も減らない(結果が消える
 * のは形の変更と Esc、§0.a-0.68)。選び直して押すたびに測れるほうが、この道具では
 * 利用者の期待に合う(プロパティ欄の「測り直す」と同じ 1 手になる)。
 */
export function runMeasureTool(readiness: SolidToolReadiness): void {
  const store = useAppStore.getState();
  store.setActiveTool('measure');
  store.requestViewportFocus();
  if (!readiness.ready) {
    store.setMeasureError(readiness.reasonKey);
    return;
  }
  store.measureSelection();
}
