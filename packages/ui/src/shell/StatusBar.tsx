import { activeHasUnsavedChanges } from '../file/assemblyFile.js';
import { activeDocumentKind, activeFileName } from '../store/documentKind.js';
import {
  isBaseWorkPlaneId,
  isFreeWorkPlaneId,
  liveBodyIds,
  type BaseWorkPlaneId,
} from '@pointercad/model';
import { useEffect, useState } from 'react';
import './statusBar.css';

import { missingAppearanceCount } from '../appearance/appearanceCommands.js';
import { nestedBoltedJointRefusalKey } from '../assembly/nestedBoltedJointDisplay.js';
import { documentLabel } from '../file/partFile.js';
import { t, type MessageKey } from '../i18n/t.js';
import { mathGeometryToolGuide, mathGeometryToolGuideText } from '../math/mathGeometryToolGuide.js';
import { LENGTH_UNIT_LABEL_KEYS, nextLengthUnit } from '../settings/settings.js';
import { constraintPickGuide } from '../sketch/constraintActions.js';
import { workPlaneEntries, type WorkPlaneEntry } from '../sketch/referenceCommands.js';
import {
  isNoneSelectable,
  SELECTION_FILTER_KINDS,
  SELECTION_KIND_LABEL_KEYS,
  toggleSelectionFilter,
} from '../solid/selectionFilter.js';
import { solidToolReadiness } from '../solid/solidCommands.js';
import { useAppStore } from '../store/useAppStore.js';
import { CommandLine } from './CommandLine.js';
import type { CommandLineFailure } from './commandLineActions.js';
import { AlertIcon, MouseIcon, PlaneIcon, RecentFileIcon, SaveIcon, SnapIcon } from './icons.js';
import { rollbackOf } from './timelineRail.js';
import {
  countSelectedBodies,
  countSelectedSubShapes,
  describeStatus,
  assemblyMateStatus,
  assemblyToolGuide,
  boltedJointStatus,
  filletWeldStatus,
  PROGRESS_DELAY_MS,
  saveMarkLabel,
  statusBarSlotStyle,
  type SpringNumericInputStep,
  type StatusLineKind,
  type TrackStatus,
} from './statusText.js';

/** 作図面の表記。ツールバーの区画名と同じ言葉にする。 */
const PLANE_KEYS = {
  xy: 'toolbar.plane.xy',
  xz: 'toolbar.plane.xz',
  yz: 'toolbar.plane.yz',
} as const satisfies Record<BaseWorkPlaneId, MessageKey>;

/**
 * 作図面の札の文言。基準の 3 面は名前を ja.json から引き、任意の作業平面(FR-328)は
 * 文書に付いている名前(「作業平面1」など)をそのまま出す。3D スケッチ
 * (作図面なし、FR-330)は「3D」と出す。
 * 名前が引けないとき(消えた平面を指したまま)は id を出して、何を指しているか分かるようにする。
 */
function planeLabel(workPlaneId: string, customPlanes: readonly WorkPlaneEntry[]): string {
  if (isBaseWorkPlaneId(workPlaneId)) {
    return t(PLANE_KEYS[workPlaneId]);
  }
  if (isFreeWorkPlaneId(workPlaneId)) {
    return t('toolbar.plane.free');
  }
  return customPlanes.find((plane) => plane.id === workPlaneId)?.name ?? workPlaneId;
}

/** 帯の 1 文に添える印。何を伝えているかで替える。 */
function statusIcon(kind: StatusLineKind): React.JSX.Element {
  switch (kind) {
    case 'failure':
    case 'cancelled':
      return <AlertIcon size={14} />;
    case 'saved':
      return <SaveIcon size={14} />;
    case 'progress':
    case 'computing':
      return <span className="pcad-spinner" aria-hidden="true" />;
    case 'snap':
      return <SnapIcon size={14} />;
    case 'guide':
      return <MouseIcon size={14} />;
  }
}

/** 割合(0〜1)を帯の幅の百分率にする。 */
function widthPercent(ratio: number): string {
  return `${String(Math.round(ratio * 100))}%`;
}

/** 保存の段階・復元用の保存の状態の印に渡すもの。 */
interface StatusMarkProps {
  readonly slot: 'save' | 'recovery';
  /** 段階の名前。画面検査が `data-save-stage` / `data-recovery-stage` で見分ける。 */
  readonly stage: string;
  readonly icon: React.JSX.Element;
  /** 画面に出す 1〜2 語。図柄だけで足りる段階は null。 */
  readonly label: string | null;
  /** 段階の全文。ツールチップと読み上げへ渡す。 */
  readonly text: string;
  readonly failed?: boolean;
}

/**
 * 保存の段階・復元用の保存の状態の印(UI の点検の指摘 1)。図柄と 1〜2 語だけを画面に出し、全文は
 * ツールチップと読み上げへ渡す。幅が足りない時は案内の 1 文より先に縮むが、縮むのは語の部分だけで、
 * 図柄の幅は残す(`statusBarSlotStyle`。幅 0 に潰れて見えなくならない。C-02a の直し)。
 */
function StatusMark(props: StatusMarkProps): React.JSX.Element {
  return (
    <span
      className={props.failed === true ? 'pcad-statusbar__mark pcad-statusbar__mark--failed' : 'pcad-statusbar__mark'}
      data-save-stage={props.slot === 'save' ? props.stage : undefined}
      data-recovery-stage={props.slot === 'recovery' ? props.stage : undefined}
      title={props.text}
      style={statusBarSlotStyle(props.slot)}
    >
      {props.icon}
      {props.label === null ? null : (
        <span className="pcad-statusbar__mark-text" aria-hidden="true">{props.label}</span>
      )}
      <span className="pcad-statusbar__spoken" role="status" aria-live="polite">{props.text}</span>
    </span>
  );
}

/**
 * 下端のステータスバー(要件§7.1、FR-905)。
 *
 * 左は今の状況を伝える。計算中も道具の操作ガイドを残し、計算状態を小さく並べる。
 * どれを出すかの順番と文の組み立ては `statusText.ts` の純関数が決める。
 * 右は「作図面」「吸着」(部品の文書だけ)と「単位」を小さな札で見せる。**単位の札だけは押せる**
 * (mm ↔ inch、FR-811)。札の数も区画も増やしていない。
 * 帯の幅が足りない時は、案内の 1 文を最後に縮める(縮む順と最小の幅は `statusBarSlotStyle`。UI の点検の指摘 1)。
 * 失敗しても操作は止めず、帯の色と文言で知らせる(FR-504、NFR-RE-1)。
 *
 * 長い計算のあいだは細い進捗の帯と「中止」を出す(NFR-PF-4)。**進み具合が届いてすぐには
 * 出さない**(`PROGRESS_DELAY_MS`)。短い計算で出すと、操作のたびに札が
 * 点滅するため。
 */
export function StatusBar(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  const mateDraft = useAppStore((state) => state.assemblyMateDraft);
  const mateDiagnosis = useAppStore((state) => state.assemblyView?.diagnosis ?? null);
  const mateTargetErrors = useAppStore((state) => state.assemblyView?.mateTargetErrors ?? null);
  const assemblyDragNotice = useAppStore((state) => state.assemblyDragNotice);
  const assemblyPlacement = useAppStore((state) => state.assemblyPlacement);
  const standardPartPickerOpen = useAppStore((state) => state.standardPartPickerOpen);
  const assemblyReplacementBusy = useAppStore((state) => state.assemblyReplacementBusy);
  const assemblyReplacementPreview = useAppStore((state) => state.assemblyReplacementPreview);
  const assemblyExplodeDraft = useAppStore((state) => state.assemblyExplodeDraft);
  // ボルト締結の打ちかけ(追加要件6)。下書きと予告はストアの同じ物を取り出し、文は statusText.ts が組む。
  const boltedJointDraft = useAppStore((state) => state.assemblyBoltedJointDraft);
  const boltedJointPreview = useAppStore((state) => state.assemblyBoltedJointPreview);
  // すみ肉溶接の打ちかけ。締結の打ちかけとは同時に開かない(「組む」の道具が互いを止める)ので、同じ欄で出す。
  const filletWeldDraft = useAppStore((state) => state.assemblyFilletWeldDraft);
  const circularWeldDraft = useAppStore((state) => state.assemblyCircularWeldDraft);
  const filletWeldPreview = useAppStore((state) => state.assemblyFilletWeldPreview);
  const nestedWeldDraft = useAppStore((state) => state.assemblyNestedWeldDraft);
  const nestedBoltDraft = useAppStore((state) => state.assemblyNestedBoltDraft);
  const nestedBoltRefusal = nestedBoltedJointRefusalKey(useAppStore((state) => state.assemblyNestedBoltPreview));
  const checkingAssemblyInterference = useAppStore(
    (state) => state.isCheckingAssemblyInterference,
  );
  const assemblyInterferenceCount = useAppStore(
    (state) => state.assemblyInterferenceResult?.pairs.length ?? null,
  );
  const viewingAssemblyBom = useAppStore((state) => state.selection.includes('bom'));
  // 幾何カーネルの初回読み込み中かどうかで帯の文言を分ける。
  const kernelLoaded = useAppStore((state) => state.kernelLoaded);
  const errorMessage = useAppStore((state) => state.errorMessage);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const partErrors = useAppStore((state) => state.partErrors);
  const faceErrorKey = useAppStore((state) => state.faceErrorKey);
  const solidErrorKey = useAppStore((state) => state.solidErrorKey);
  // 整形系の道具(オフセット等)を作れなかった理由(FR-321)。
  const editErrorKey = useAppStore((state) => state.editErrorKey);
  // 整形系の道具がうまくいったときの案内(FR-323)。断りではないので赤くしない。
  const editNoticeKey = useAppStore((state) => state.editNoticeKey);
  // 外観を割り当てられなかった理由(FR-1106〜1110)。
  const appearanceErrorKey = useAppStore((state) => state.appearanceErrorKey);
  // 測れなかった理由(FR-1101、FR-1102)。
  const measureErrorKey = useAppStore((state) => state.measureErrorKey);
  /*
   * 選び直せなかった外観の割り当て(FR-1106)。件数だけを取り出すのは、取り出す式が
   * 毎回新しい物を返すと変わっていなくても描き直しになるため(つまみの札と同じ事情)。
   * 数えるのは `appearanceCommands.ts` の 1 か所だけ(同じ判定を画面側に書かない)。
   */
  const appearanceMissing = useAppStore((state) =>
    missingAppearanceCount(state.document, state.appearanceMatches),
  );
  // 新しい図形を作れなかった理由。文言キーではなく組み立て済みの文。
  const shapeErrorMessage = useAppStore((state) => state.shapeErrorMessage);
  // 基準ジオメトリを作れなかった理由。こちらも組み立て済みの文。
  const referenceErrorMessage = useAppStore((state) => state.referenceErrorMessage);
  // 原点を移したときの一言(FR-331)。断りではないので赤くしない。
  const originNoticeMessage = useAppStore((state) => state.originNoticeMessage);
  /*
   * タイムラインのつまみ(FR-507)。末尾でないあいだは札を出したままにする。
   * 取り出すのは数だけにして、札の組み立て(新しい物を作る計算)は下の本体で行う。
   * 取り出す式が毎回新しい物を返すと、変わっていなくても描き直しになるため。
   */
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  const historyCount = useAppStore(
    (state) => state.document.references.length + state.document.solids.length,
  );
  const timelineNoticeKey = useAppStore((state) => state.timelineNoticeKey);
  // 書き出しの添え物。うまくいったときの知らせなので赤くしない。
  const exchangeNotice = useAppStore((state) => state.exchangeNotice);
  // 3D プリントの点検(FR-815)。断りと「点検しています…」の 2 つ。
  const printCheckErrorMessage = useAppStore((state) => state.printCheckErrorMessage);
  const inspectingPrint = useAppStore((state) => state.isInspectingPrint);
  // 形の計算に使うメモリ(NFR-PF-6)。上限に近いかどうかの判断と文言は statusText.ts が持つ。
  const kernelMemory = useAppStore((state) => state.kernelMemory);
  /*
   * 順序の入れ替えの断り(FR-507、FR-504)。文だけを取り出す。
   * 断りの向け先(壊れる側の行)の印は `FeatureTree.tsx` が同じ値から出す。
   */
  const timelineRefusalMessage = useAppStore((state) => state.timelineRefusal?.message ?? null);
  /*
   * 拘束(FR-313)。断りと「次に何を押せばよいか」、そして決まり具合の 1 文。
   * 決まり具合は model の診断(`ConstraintDiagnosis.summary`)をそのまま出す
   * (「あと N か所決まっていません」「すべて決まりました」「付けすぎの拘束が N 件あります」
   * 「同時に成り立たない拘束が N 件あります」)。同じ文言を ja.json に二重に書かない。
   */
  const constraintErrorMessage = useAppStore((state) => state.constraintErrorMessage);
  const constraintPickMessage = useAppStore((state) => constraintPickGuide(state));
  const constraintSummaryText = useAppStore(
    (state) => state.constraintDiagnosis?.summary ?? null,
  );
  // 引っぱり(FR-313)。掴めなかった理由と、引っぱっている最中の案内。
  const dragRefusalKey = useAppStore((state) => state.dragRefusalKey);
  const dragging = useAppStore((state) => state.sketchDrag !== null);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  // 任意の作業平面(FR-328)の名前を札に出すための一覧。
  const customPlanes = workPlaneEntries(useAppStore((state) => state.document));
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  /*
   * 表示の長さの単位(FR-811)。**区画も札の数も増やさない。**
   * いままで固定の文字だった右端の「単位: mm」の札を、そのまま押せる 2 択にする。
   * 端末に覚える設定なので、テーマや拡大率と同じ `displaySettings` に入っている。
   */
  const displaySettings = useAppStore((state) => state.displaySettings);
  const setDisplaySettings = useAppStore((state) => state.setDisplaySettings);
  /*
   * 選択フィルタ(FR-112)。**端末に覚える設定**なので単位と同じ
   * `displaySettings` の中にある(`localStorage` の鍵を増やさない)。
   */
  const selectionFilter = displaySettings.selectionFilter;
  const snapIndicator = useAppStore((state) => state.snapIndicator);
  // 向きの吸着の案内線(FR-110)。帯の一言に角度と要素の名前を出す。
  const trackIndicator = useAppStore((state) => state.trackIndicator);
  // 名前(「線分1」)は履歴が持っている。案内線のもとになった要素だけを引く。
  const sketchFeatures = useAppStore((state) => state.sketch.features);
  const fileName = useAppStore(activeFileName);
  // 作図面・吸着・拘束の推定の札は部品の文書だけで使う(ツールバーと同じ判定。UI の点検の小 21)。
  const documentKind = useAppStore((state) => activeDocumentKind(state));
  const fileMessage = useAppStore((state) => state.fileMessage);
  const saveOperation = useAppStore(state => state.documentSaveOperation?.documentId === state.activeDocumentId
    && state.documentSaveOperation.gateway === state.fileGateway ? state.documentSaveOperation : null);
  const recoveryState = useAppStore(state => state.recoverySaveState?.documentId === state.activeDocumentId
    && state.recoverySaveState.saver === state.autoSaver ? state.recoverySaveState : null);
  const recomputeProgress = useAppStore((state) => state.recomputeProgress);
  const recomputeCancelled = useAppStore((state) => state.recomputeCancelled);
  const cancelRecompute = useAppStore((state) => state.cancelRecompute);
  // 真偽で取り出して、印が付くか外れるかが変わったときだけ描き直す(NFR-PF-1)。
  const unsaved = useAppStore(activeHasUnsavedChanges);
  // 数で取り出す。ブーリアンの案内を出すかどうかにしか使わない(FR-404)。
  const selectedBodyCount = useAppStore((state) =>
    countSelectedBodies(state.selection, liveBodyIds(state.document)),
  );
  // 選択の種類の札。立体を選ぶ道具のときは部分形状を数えない(0 のまま)。
  const selectionKind = useAppStore((state) => state.selectionKind);
  const selectedSubShapeCount = useAppStore((state) =>
    state.selectionKind === 'body' ? 0 : countSelectedSubShapes(state.selection, state.selectionKind),
  );
  /*
   * ばねの段階的な案内。始点にする点が選ばれているかは、
   * ツールバーの「ばね」ボタンの押せる条件と同じ solidToolReadiness で判定する
   * (同じ判断を2か所に書かない)。activeTool が spring でないときは常に false にし、
   * 無関係な選択の変化のたびには描き直さない(NFR-PF-1、上の selectedBodyCount と同じ考え方)。
   */
  const springOriginSelected = useAppStore((state) =>
    state.activeTool === 'spring'
      ? solidToolReadiness(state.document, state.selection, 'spring').ready
      : false,
  );
  // いま開いているその場入力がばねの何段目か(springShape / springLength)。それ以外は null。
  const springStep = useAppStore((state): SpringNumericInputStep | null => {
    if (state.numericInput === null || state.numericInput.toolId !== 'spring') {
      return null;
    }
    const { step } = state.numericInput;
    return step === 'springShape' || step === 'springLength' ? step : null;
  });
  /*
   * いま開いているその場入力の段(FR-905)。窓が次の段(線分の終点・外ねじの大きさ)へ
   * 進んだら案内もその段の一手へ替える(`numericStepGuideText`)。今の道具の窓でなければ
   * null にして、ほかの道具の案内へ前の窓の段が混ざらないようにする。段名は文字列なので、
   * 変わらない間は描き直さない(NFR-PF-1)。
   */
  const numericInputStep = useAppStore((state) =>
    state.numericInput === null || state.numericInput.toolId !== state.activeTool
      ? null
      : state.numericInput.step,
  );
  /*
   * 道具「図形の測定値」を先に押したときの段階の案内(ADD-23)。判断は
   * `math/mathGeometryToolGuide.ts` の純関数 1 か所に置く(節の先頭の文も同じものを使う)。
   * 道具が有効なときだけ呼び、それ以外は常に null にして、無関係な選択の変化のたびには
   * 描き直さない(上の springOriginSelected と同じ考え方、NFR-PF-1)。取り出すのは組み立てた
   * 文字列だけにする。毎回新しい物を返す取り出し方だと、変わっていなくても描き直しになるため。
   */
  const mathGeometryGuide = useAppStore((state) => {
    if (state.activeTool !== 'mathGeometry') {
      return null;
    }
    const guide = mathGeometryToolGuide(state);
    return guide === null ? null : mathGeometryToolGuideText(guide);
  });

  /*
   * 進み具合を出してよいかどうかだけを持つ表示専用の状態(rules/04: useState は
   * 表示専用の一時状態だけ)。見張るのは「進み具合が届いているか」の真偽で、
   * 段が進むたびに動く中身ではない。中身で見張ると段ごとに待ち時間が振り出しへ戻り、
   * 長い計算でもいつまでも出なくなる。
   */
  const hasProgress = recomputeProgress !== null;
  const [progressVisible, setProgressVisible] = useState(false);
  /*
   * コマンドラインで打った 1 行を受け取れなかった理由(FR-208)。
   * 帯に出すのは 1 文だけなので、他の断りと同じ優先順位の列(`describeStatus`)へ渡す。
   * 断りは「いま押した Enter への返事」で、次に打ち直せば消える表示だけの一時状態なので
   * ここで持つ(rules/04-設計の規律.md。欄の打ちかけも `CommandLine.tsx` が同じ扱いで持つ)。
   */
  const [commandFailure, setCommandFailure] = useState<CommandLineFailure | null>(null);
  useEffect(() => {
    if (!hasProgress) {
      setProgressVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setProgressVisible(true);
    }, PROGRESS_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [hasProgress]);

  // 開いているファイルの名前。保存していない変更があれば末尾に印が付く(FR-806)。
  const fileLabel = documentLabel(fileName, unsaved);

  // 案内線 1 本ごとに、帯へ出す材料(種類・角度・もとの要素の名前)へ詰め替える。
  const track: readonly TrackStatus[] | null =
    trackIndicator === null
      ? null
      : trackIndicator.map((line) => ({
          kind: line.kind,
          angleDegrees: line.angleDegrees,
          sourceName:
            line.sourceFeatureId === null
              ? null
              : (sketchFeatures.find((feature) => feature.id === line.sourceFeatureId)?.name ??
                null),
        }));

  const assemblyOperationStatus = assemblyReplacementPreview !== null
    ? t('assembly.status.replaceConfirm')
    : assemblyReplacementBusy
      ? t('assembly.status.fileReading')
      : standardPartPickerOpen
        ? assemblyToolGuide('placeStandardPart')
        : assemblyPlacement !== null
          ? assemblyToolGuide('placePart')
          : assemblyExplodeDraft !== null
            ? assemblyToolGuide('explode')
            : checkingAssemblyInterference
              ? t('assembly.status.interferenceRunning')
              : viewingAssemblyBom
                ? assemblyToolGuide('bom')
                : null;

  const circularWeldGuide: ReturnType<typeof filletWeldStatus> = circularWeldDraft === null ? null
    : { text: t(circularWeldDraft.picks.length === 0 ? 'assembly.circularFilletWeld.pickPlane'
      : circularWeldDraft.picks.length === 1 ? 'assembly.circularFilletWeld.pickEdge'
        : circularWeldDraft.picks.length === 2 ? 'assembly.circularFilletWeld.pickCylinder' : 'assembly.circularFilletWeld.picked'), failed: false };
  const line = describeStatus({
    assemblyMateStatus: assemblyMateStatus(mateDraft, mateDiagnosis, mateTargetErrors ?? new Map()),
    assemblyMateActive: mateDraft !== null,
    assemblyBoltedJointStatus: boltedJointStatus(boltedJointDraft, boltedJointPreview, nestedBoltDraft, nestedBoltRefusal)
      ?? circularWeldGuide ?? filletWeldStatus(filletWeldDraft, filletWeldPreview, nestedWeldDraft),
    assemblyOperationStatus,
    assemblyInterferenceCount,
    assemblyDragNotice,
    fileMessage,
    faceErrorKey,
    solidErrorKey,
    editErrorKey,
    appearanceErrorKey,
    measureErrorKey,
    appearanceMissingCount: appearanceMissing,
    editNoticeKey,
    shapeErrorMessage,
    referenceErrorMessage,
    commandLineFailure: commandFailure,
    originNoticeMessage,
    // つまみが末尾でないことの札と、末尾へ戻したことの知らせ(FR-507)。
    rollback: rollbackOf(historyCount, timelineIndex),
    timelineNoticeKey,
    exchangeNotice,
    printCheckErrorMessage,
    inspectingPrint,
    // 上限に近いときだけ、帯に保存と開き直しを促す(NFR-PF-6)。ふだんは何も出さない。
    kernelMemory,
    timelineRefusalMessage,
    constraintErrorMessage,
    constraintPickMessage,
    constraintSummaryText,
    dragRefusalKey,
    dragging,
    errorMessage,
    partErrors,
    sketchErrors,
    cancelled: recomputeCancelled,
    progress: progressVisible ? recomputeProgress : null,
    isComputing,
    kernelLoaded,
    snapKind: snapIndicator === null ? null : snapIndicator.kind,
    track,
    activeTool,
    selectedBodyCount,
    selectedSubShapeCount,
    selectionKind,
    springOriginSelected,
    springStep,
    // その場入力の段ごとの案内(FR-905)。窓が開いていなければ null。
    numericInputStep,
    // 図形の測定値の道具の段階の案内。道具が有効でなければ null。
    mathGeometryGuide,
    // 3D スケッチのときだけ案内へ一言を添える(FR-330)。
    workPlaneId,
  });
  const className =
    line.kind === 'failure' ? 'pcad-statusbar pcad-statusbar--error' : 'pcad-statusbar';
  const saveText = saveOperation === null ? null : t(`file.save.${saveOperation.stage}`)
    .replace('{name}', saveOperation.fileName ?? fileLabel);
  // 「復元用の保存を待っています」は今の文書に保存していない変更がある間だけ示す。新規・開く・Undo で
  // 保存済みの内容になった文書へ、差し替えの途中で付いた待機の表示を残さない(復元の表示は今の世代だけに)。
  // 失敗の理由(detail)は、帯には短い印だけを出すので、全文の後ろに添えてツールチップと読み上げへ渡す。
  const recoveryText = recoveryState === null || (recoveryState.stage === 'pending' && !unsaved) ? null
    : `${t(`file.recovery.${recoveryState.stage}`)}${recoveryState.detail === undefined ? '' : ` ${recoveryState.detail}`}`;

  return (
    <footer className={className}>
      {/* 開いているファイルの名前。区画は増やさず、状況の1文の左へ小さく置く。未保存は * とツールチップで伝える(点検の指摘 1)。 */}
      <span className="pcad-statusbar__file" title={unsaved ? t('file.unsavedChanges') : fileLabel}
        style={statusBarSlotStyle('file')}>
        {fileLabel}
      </span>
      {/*
        キーボードだけで作図するためのコマンドラインの欄(FR-208)。
        ファイル名の右・状況の 1 文の左へ入れる。**区画は 5 つのまま**で、打っている間だけ
        欄が広がり、そのぶんを右の余白と状況の 1 文が譲る(appShell.css)。
      */}
      <CommandLine onFailureChange={setCommandFailure} />
      {/*
        保存の段階(実行中は回る印と「保存中…」、完了は図柄だけ)と、復元用の保存の状態(失敗だけ危険の色の
        短い語、ほかは図柄だけ)。段階の全文はツールチップと読み上げへ渡す(UI の点検の指摘 1)。
      */}
      {saveOperation === null ? null : (
        <StatusMark slot="save" stage={saveOperation.stage} label={saveMarkLabel(saveOperation.stage)}
          text={saveText ?? ''} icon={saveOperation.stage === 'complete' || saveOperation.stage === 'cancelled'
            ? <SaveIcon size={12} /> : <span className="pcad-spinner" aria-hidden="true" />} />
      )}
      {/* 中止のボタンは印の外に置く(印の語が縮んでもボタンは隠れない。C-02a の直し)。 */}
      {saveOperation === null || saveOperation.cancel === null ? null : (
        <button type="button" className="pcad-button pcad-button--action pcad-statusbar__cancel"
          title={t('controlGuide.save.cancel')}
          onClick={saveOperation.cancel}>{t('file.save.cancel')}</button>
      )}
      {recoveryText === null || recoveryState === null ? null : (
        <StatusMark slot="recovery" stage={recoveryState.stage} text={recoveryText}
          failed={recoveryState.stage === 'failed'}
          label={recoveryState.stage === 'failed' ? t('statusBar.recoveryMark.failed') : null}
          icon={recoveryState.stage === 'failed' ? <AlertIcon size={12} /> : <RecentFileIcon size={12} />} />
      )}
      <span className="pcad-statusbar__message" aria-live="polite" style={statusBarSlotStyle('message')}>
        {statusIcon(line.kind)}
        <span className="pcad-statusbar__text" title={line.text}>
          {line.text}{fileMessage?.detail === undefined ? '' : ` ${fileMessage.detail}`}
        </span>
        {/*
          案内に添える一言(3D スケッチで頂点を押せること、FR-330 / NFR-UX-7)。
          計算中の進み具合に添える一言は下の進捗の並びで出すので、ここでは案内のときだけ。
        */}
        {line.kind === 'guide' && line.hint !== null ? (
          <span className="pcad-statusbar__hint">{line.hint}</span>
        ) : null}
      </span>
      {line.activity === null ? null : (
        <span
          className="pcad-statusbar__activity"
          role="status"
          aria-label={line.activity.detail}
          title={line.activity.detail}
        >
          <span className="pcad-spinner" aria-hidden="true" />
          <span>{line.activity.text}</span>
        </span>
      )}
      {line.progress === null ? null : (
        /*
         * 計算の進み具合と中止(NFR-PF-4)。中止は段と段の間でしか効かないので、
         * 待たされることがある旨を薄い字とツールチップで先に伝える。
         */
        <span className="pcad-statusbar__progress" style={statusBarSlotStyle('progress')}>
          <span
            className="pcad-statusbar__progress-track"
            role="progressbar"
            aria-label={t('statusBar.progress')}
            aria-valuemin={0}
            aria-valuemax={line.progress.total}
            aria-valuenow={line.progress.done}
          >
            <span
              className="pcad-statusbar__progress-fill"
              style={{ width: widthPercent(line.progress.ratio) }}
            />
          </span>
          <span className="pcad-statusbar__hint">{t('statusBar.progressHint')}</span>
          <button
            type="button"
            className="pcad-button pcad-button--action pcad-statusbar__cancel"
            title={t('statusBar.progressHint')}
            onClick={() => {
              cancelRecompute();
            }}
          >
            {t('statusBar.cancel')}
          </button>
        </span>
      )}
      <span className="pcad-statusbar__spacer" />
      {/*
        タイムラインのつまみが末尾でないことの札(FR-507、NFR-UX-7)。状況の1文とは
        独立に、戻しているあいだは必ず出す。戻したままだと「作ったはずのものが消えた」
        と見えるため。
      */}
      {line.rollbackLabel === null ? null : (
        <span className="pcad-statusbar__rollback" title={t('timeline.rollbackTooltip')}>
          {line.rollbackLabel}
        </span>
      )}
      {/* 選択の種類の札。`1`〜`4` キーで切り替えられることをツールチップで添える。 */}
      <span className="pcad-statusbar__state" title={t('selection.kindHint')}>
        {line.selectionKindLabel}
      </span>
      {/*
        選択フィルタ(FR-112)。**区画も並びも増やさない**——
        「選ぶもの」の札のとなりに、4 つの入切を 1 かたまり(1 項目)として置く。
        切ってある種類は当たり判定の候補から外れ、ホバーの強調も出ない。
        4 つとも切ってあるときだけ、その場に理由を添える(NFR-UX-5)。
      */}
      <span className="pcad-statusbar__state" title={t('statusBar.selectionFilterHint')}>
        {SELECTION_FILTER_KINDS.map((kind) => (
          <button
            key={`selectionFilter:${kind}`}
            type="button"
            /*
              入切の見た目は**ツールバーの入切ボタンと同じ作法**(`aria-pressed` と
              `.pcad-button[aria-pressed="true"]`)にそろえる。ステータスバーのために
              新しい見た目を足さないので、appShell.css は 1 行も増えない。
            */
            className="pcad-button"
            aria-pressed={selectionFilter[kind]}
            title={t('statusBar.selectionFilterHint')}
            onClick={() => {
              setDisplaySettings({
                ...displaySettings,
                selectionFilter: toggleSelectionFilter(selectionFilter, kind),
              });
            }}
          >
            {t(SELECTION_KIND_LABEL_KEYS[kind])}
          </button>
        ))}
        {isNoneSelectable(selectionFilter) ? (
          <span className="pcad-statusbar__hint">{t('statusBar.selectionFilterNone')}</span>
        ) : null}
      </span>
      {/*
        作図面・吸着・拘束の推定はスケッチの道具の札なので、部品の文書だけに出す。アセンブリでは
        ツールバーも隠しているので、帯にも使わない札を残さない(UI の点検の小 21)。
      */}
      {documentKind === 'part' ? <>
      <span className="pcad-statusbar__state">
        <PlaneIcon size={12} />
        {`${t('statusBar.plane')} ${planeLabel(workPlaneId, customPlanes)}`}
      </span>
      <span className="pcad-statusbar__state">
        <SnapIcon size={12} />
        {snapEnabled ? t('statusBar.snapOn') : t('statusBar.snapOff')}
      </span>
      {/*
        拘束の自動推定の入切(FR-333)。**区画は増やさない**——
        吸着の札のとなりに入切を 1 つだけ足す。見た目は選択フィルタ・ツールバーの入切と
        同じ作法(`aria-pressed` と `.pcad-button[aria-pressed="true"]`)にそろえるので、
        appShell.css は 1 行も増えない。**既定は入**で、端末に覚える(`displaySettings`)。
        しきい値の数値は出さない(「ヘルプにも画面にも数値を書かない」)。
      */}
      <span className="pcad-statusbar__state">
        <button
          type="button"
          className="pcad-button"
          aria-pressed={displaySettings.inferConstraints}
          title={t('statusBar.inferConstraintsHint')}
          onClick={() => {
            setDisplaySettings({
              ...displaySettings,
              inferConstraints: !displaySettings.inferConstraints,
            });
          }}
        >
          {t('statusBar.inferConstraints')}
        </button>
      </span>
      </> : null}
      {/*
        表示の単位(FR-811)。押すたびに mm ↔ inch を入れ替える。**内部の値は変わらない**
        ので、切り替えても `.pcad` のバイト列は 1 バイトも変わらない(NFR-RE-3)。
        札の見た目と位置はいままでと同じで、押せることをツールチップで添える(NFR-UX-7)。
      */}
      <button
        type="button"
        className="pcad-statusbar__unit"
        title={t('statusBar.unitHint')}
        onClick={() => {
          setDisplaySettings({
            ...displaySettings,
            lengthUnit: nextLengthUnit(displaySettings.lengthUnit),
          });
        }}
      >
        {t(LENGTH_UNIT_LABEL_KEYS[displaySettings.lengthUnit])}
      </button>
    </footer>
  );
}
