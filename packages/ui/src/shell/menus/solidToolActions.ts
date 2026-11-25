import { createConfiguredNumericInput as createNumericInput } from '../../settings/createConfiguredNumericInput.js';
/**
 * ソリッドの道具を押したときの配線(FR-401〜、FR-1101・FR-1102)。
 *
 * 一覧ごとに 1 ファイルへ分けた。
 */

import type { BooleanOperation } from '@pointercad/model';
import {
  SOLID_TOOL_STEPS,
  type SolidToolId,
} from '../../sketch/numericInput.js';
import { ruledSelectionHasSphere } from '../../solid/ruledCommands.js';
import { selectedCurvePath } from '../../solid/shapeEditCommands.js';
import { solidTargetCandidates, supportsSolidOperation } from '../../solid/solidOperation.js';
import { cancelExtrusion } from '../../solid/extrudePreview.js';
import { selectedExtrudeProfiles } from '../../solid/sketchRefs.js';
import { faceOfEdgePair } from '../../solid/edgeDistanceHoleInput.js';
import { sweepGuideCandidates } from '../../solid/sweepGuideChoices.js';
import { pushPullTarget } from '../../solid/pushPull.js';
import {
  commitBooleanFromSelection,
  selectedLineRef,
  solidToolReadiness,
  type SolidToolReadiness,
} from '../../solid/solidCommands.js';
import { subShapeBodiesOf } from '../../solid/subShapeSelection.js';
import { commitWorkingPartDocument } from '../../store/partEditActions.js';
import { useAppStore } from '../../store/useAppStore.js';
import { viewportCenterAnchor } from './toolbarShared.js';

/**
 * ソリッドのその場入力を出す場所。
 *
 * 立体の道具は「先に面を選んでから押す」ので、最後にビューポートで選んだところの
 * すぐそばへ出すと、何に対する入力なのかが目で追える(NFR-UX-1、NFR-UX-2)。
 * ツリーから選んだときなど、ビューポートを押していなければ中央へ出す。
 * ビューポートで面を選んでいれば、窓はその面の画面の外形を避けて開く(M-10 ①。外形は
 * `pickAnchor` と一緒に覚えた `pickAvoidRect`。面でない物を選んだ時と押していない時は null)。
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
 * 回転は線分が選ばれていれば「選んだ線分」も軸の候補に加える。
 */
function openSolidInput(tool: SolidToolId, keepSingleProfile = false): void {
  const store = useAppStore.getState();
  // 前の押し出しの確かめた形・古い確定の知らせを、新しい入力の窓へ持ち越さない。
  if (tool === 'extrude' || tool === 'holeTranslate' || tool === 'faceRotate') cancelExtrusion();
  // 面を選ばずに辺 2 本だけを選んで穴・ねじ穴を押した時は、辺からの距離で開く(M-10 ③)。
  const fromEdges = (tool === 'hole' || tool === 'threadHole')
    && faceOfEdgePair(subShapeBodiesOf(store.bodies), store.selection) !== null;
  const keepProfiles = tool === 'extrude'
    && selectedExtrudeProfiles(store.document, store.selection).length >= (keepSingleProfile ? 1 : 2);
  store.setActiveTool(tool);
  // 選ぶ種類が変わっても、穴の辺を選んだ順と押し出しに渡す作図面を保つ。
  if (fromEdges || (keepProfiles && useAppStore.getState().selection.length === 0)) store.setSelection(store.selection);
  const axisLine = tool === 'revolve' ? selectedLineRef(store.document, store.selection) : undefined;
  /*
    面をつなぐ(FR-430)の「なめらかさ」は、**球を含む断面のときだけ**出す。
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
      ...(fromEdges ? { initialHolePlacement: 'edge-distance' as const } : {}),
      ...(axisLine === undefined ? {} : { axisLine }),
      ...(supportsSolidOperation(tool) ? { extrudeTargets: solidTargetCandidates(store.document) } : {}),
      ...(ruledHasSphere === undefined ? {} : { ruledHasSphere }),
      ...(tool === 'sweep' ? { sweepGuides: sweepGuideCandidates(store.document, selectedCurvePath(store.document, store.selection) ?? undefined) } : {}),
    }),
    solidAnchor(),
    useAppStore.getState().pickAvoidRect,
  );
}

/**
 * 和・差・積(FR-404)。数値を聞かないので、押した瞬間に作って選択へ戻す。
 * 作った立体をそのまま選んでおくと、続けてもう 1 つ組み合わせられる(NFR-UX-1)。
 */
function commitBooleanAction(operation: BooleanOperation): void {
  const store = useAppStore.getState();
  const outcome = commitBooleanFromSelection(store.document, store.selection, operation);
  if (!outcome.ok) {
    store.setSolidError(outcome.reasonKey);
    return;
  }
  void commitWorkingPartDocument(store, outcome.document, current => {
    current.setSelection([outcome.featureId]);
    current.setActiveTool('select');
  });
}

/**
 * 「作る」「加工」の一覧から道具を選んだときの処理。
 *
 * 押せるならその場入力を開く。押せなくても、押した時点で選ぶものを道具が要る種類へ
 * 切り替える。これで「穴を選ぶ → 面を選ぶ →
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
  // Start by picking a face, while retaining an already chosen face/hinge pair.
  if (id === 'holeTranslate' || (id === 'faceRotate'
    && store.selectionKind !== 'face' && store.selectionKind !== 'edge')) store.setSelectionKind('face');
  if (id === 'thicken' || id === 'offsetBody') store.setSelectionKind('body');
  store.setSolidError(readiness.reasonKey);
}

/**
 * 「加工」の一覧の押し引き(M-05 4-1a・4-1b)。選んだ物から振り分け先の道具を決め(`solid/pushPull.ts`)、
 * 押せるならその道具の入力欄を開く。確定・元に戻すは振り分け先の道具のまま。
 * 振り分けが決まらない時と、振り分け先がまだ押せない時は、道具も選ぶ種類も変えずに理由だけを帯へ出す
 * (道具を切り替えると、選んであった物が消えることがある)。
 * 穴の壁の面の時は、履歴の木で穴の行を押した時と同じ選び方(`featureTreeCommands.ts` の `selectTreeRow`)で穴を選び、
 * 右の欄のその穴の径の欄へ焦点を移す頼みを出す(径を打ち直すと、穴を作り直す今までの欄の働きのまま)。
 */
export function runPushPull(): void {
  const store = useAppStore.getState();
  const bodies = subShapeBodiesOf(store.bodies);
  const target = pushPullTarget(store.document, store.selection, bodies);
  if (target.kind === 'refused') {
    store.setSolidError(target.reasonKey);
    return;
  }
  if (target.kind === 'holeField') {
    store.setSelection([target.featureId]);
    store.requestFocus({ kind: 'solidField', featureId: target.featureId, fieldKey: target.fieldKey });
    return;
  }
  const readiness = solidToolReadiness(store.document, store.selection, target.tool, bodies);
  if (readiness.ready) openSolidInput(target.tool, true);
  else store.setSolidError(readiness.reasonKey);
}

/**
 * 「合わせる」の一覧(和・差・積)から選んだときの処理。
 *
 * 数値を聞かず、選ぶものも常に立体のままなので、押せないときも道具を切り替えず
 * 理由だけを出す(図柄ボタンと同じ切り分け)。
 */
export function runCombineTool(operation: BooleanOperation, readiness: SolidToolReadiness): void {
  if (!readiness.ready) {
    useAppStore.getState().setSolidError(readiness.reasonKey);
    return;
  }
  commitBooleanAction(operation);
}

/**
 * 「測る」を押したときの処理(FR-1101、FR-1102)。
 *
 * **押したら必ず何かが起きる**(NFR-UX-5)。測れるなら測り、測れないなら帯に理由を出す。
 * どちらの場合も道具は「測る」にする(`keepsSelectionKind` が真なので、いま選んでいる
 * ものも選ぶ種類もそのまま残る)。
 *
 * **同じ道具をもう一度押したら「測り直す」。** 他の一覧は「もう一度押したら解除」だが、
 * 測るは取りかけの状態を持たない道具で、解除しても画面から何も減らない(結果が消える
 * のは形の変更と Esc)。選び直して押すたびに測れるほうが、この道具では
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
