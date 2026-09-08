import { activeHasUnsavedChanges } from '../file/assemblyFile.js';
import { activeFileName } from '../store/documentKind.js';
import {
  isBaseWorkPlaneId,
  isFreeWorkPlaneId,
  liveBodyIds,
  type BaseWorkPlaneId,
} from '@pointercad/model';
import { useEffect, useState } from 'react';

import { missingAppearanceCount } from '../appearance/appearanceCommands.js';
import { documentLabel } from '../file/partFile.js';
import { t, type MessageKey } from '../i18n/t.js';
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
import { AlertIcon, MouseIcon, PlaneIcon, SaveIcon, SnapIcon } from './icons.js';
import { rollbackOf } from './timelineRail.js';
import {
  countSelectedBodies,
  countSelectedSubShapes,
  describeStatus,
  assemblyMateStatus,
  PROGRESS_DELAY_MS,
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
 * 文書に付いている名前(「作業平面1」など)をそのまま出す(タスク13)。3D スケッチ
 * (作図面なし、FR-330)は「3D」と出す(タスク14)。
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

/**
 * 下端のステータスバー(要件§7.1、FR-905)。
 *
 * 左は今の状況を 1 文で伝える(失敗 / 中止 / 計算の進み具合 / 吸着中の案内 / 道具ごとの
 * 操作ガイド)。どれを出すかの順番と文の組み立ては `statusText.ts` の純関数が決める。
 * 右は「作図面」「吸着」「単位」を小さな札で常に見せる。**単位の札だけは押せる**
 * (mm ↔ inch、FR-811。P6 タスク3)。札の数も区画も P5 までと同じで、増やしていない。
 * 失敗しても操作は止めず、帯の色と文言で知らせる(FR-504、NFR-RE-1)。
 *
 * 長い計算のあいだは細い進捗の帯と「中止」を出す(NFR-PF-4)。**進み具合が届いてすぐには
 * 出さない**(`PROGRESS_DELAY_MS`)。短い計算で出すと、操作のたびに札が点滅するため
 * (docs/報告記録.md 2026-09-02 23:35 の②)。
 */
export function StatusBar(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  const mateDraft = useAppStore((state) => state.assemblyMateDraft);
  const mateDiagnosis = useAppStore((state) => state.assemblyView?.diagnosis ?? null);
  const mateTargetErrors = useAppStore((state) => state.assemblyView?.mateTargetErrors ?? null);
  const assemblyDragNotice = useAppStore((state) => state.assemblyDragNotice);
  // 幾何カーネルの初回読み込み中かどうかで帯の文言を分ける(§0.a-0.23 ⑨)。
  const kernelLoaded = useAppStore((state) => state.kernelLoaded);
  const errorMessage = useAppStore((state) => state.errorMessage);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const partErrors = useAppStore((state) => state.partErrors);
  const faceErrorKey = useAppStore((state) => state.faceErrorKey);
  const solidErrorKey = useAppStore((state) => state.solidErrorKey);
  // 整形系の道具(オフセット等)を作れなかった理由(FR-321、P4 タスク21)。
  const editErrorKey = useAppStore((state) => state.editErrorKey);
  // 整形系の道具がうまくいったときの案内(FR-323、P4 タスク23)。断りではないので赤くしない。
  const editNoticeKey = useAppStore((state) => state.editNoticeKey);
  // 外観を割り当てられなかった理由(FR-1106〜1110、P5 タスク11)。
  const appearanceErrorKey = useAppStore((state) => state.appearanceErrorKey);
  // 測れなかった理由(FR-1101、FR-1102、P5 タスク32)。
  const measureErrorKey = useAppStore((state) => state.measureErrorKey);
  /*
   * 選び直せなかった外観の割り当て(FR-1106)。件数だけを取り出すのは、取り出す式が
   * 毎回新しい物を返すと変わっていなくても描き直しになるため(つまみの札と同じ事情)。
   * 数えるのは `appearanceCommands.ts` の 1 か所だけ(同じ判定を画面側に書かない)。
   */
  const appearanceMissing = useAppStore((state) =>
    missingAppearanceCount(state.document, state.appearanceMatches),
  );
  // 新しい図形を作れなかった理由(P4 タスク12)。文言キーではなく組み立て済みの文。
  const shapeErrorMessage = useAppStore((state) => state.shapeErrorMessage);
  // 基準ジオメトリを作れなかった理由(P4 タスク13)。こちらも組み立て済みの文。
  const referenceErrorMessage = useAppStore((state) => state.referenceErrorMessage);
  // 原点を移したときの一言(FR-331、P4 タスク35b)。断りではないので赤くしない。
  const originNoticeMessage = useAppStore((state) => state.originNoticeMessage);
  /*
   * タイムラインのつまみ(FR-507、P4b タスク19)。末尾でないあいだは札を出したままにする。
   * 取り出すのは数だけにして、札の組み立て(新しい物を作る計算)は下の本体で行う。
   * 取り出す式が毎回新しい物を返すと、変わっていなくても描き直しになるため。
   */
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  const historyCount = useAppStore(
    (state) => state.document.references.length + state.document.solids.length,
  );
  const timelineNoticeKey = useAppStore((state) => state.timelineNoticeKey);
  // 書き出しの添え物(P6 タスク45・46)。うまくいったときの知らせなので赤くしない。
  const exchangeNotice = useAppStore((state) => state.exchangeNotice);
  // 3D プリントの点検(FR-815、P6 タスク46)。断りと「点検しています…」の 2 つ。
  const printCheckErrorMessage = useAppStore((state) => state.printCheckErrorMessage);
  const inspectingPrint = useAppStore((state) => state.isInspectingPrint);
  /*
   * 順序の入れ替えの断り(FR-507、FR-504。P4b タスク20)。文だけを取り出す。
   * 断りの向け先(壊れる側の行)の印は `FeatureTree.tsx` が同じ値から出す。
   */
  const timelineRefusalMessage = useAppStore((state) => state.timelineRefusal?.message ?? null);
  /*
   * 拘束(FR-313、P4b タスク13)。断りと「次に何を押せばよいか」、そして決まり具合の 1 文。
   * 決まり具合は model の診断(`ConstraintDiagnosis.summary`)をそのまま出す
   * (「あと N か所決まっていません」「すべて決まりました」「付けすぎの拘束が N 件あります」
   * 「同時に成り立たない拘束が N 件あります」)。同じ文言を ja.json に二重に書かない。
   */
  const constraintErrorMessage = useAppStore((state) => state.constraintErrorMessage);
  const constraintPickMessage = useAppStore((state) => constraintPickGuide(state));
  const constraintSummaryText = useAppStore(
    (state) => state.constraintDiagnosis?.summary ?? null,
  );
  // 引っぱり(FR-313、P4b タスク14)。掴めなかった理由と、引っぱっている最中の案内。
  const dragRefusalKey = useAppStore((state) => state.dragRefusalKey);
  const dragging = useAppStore((state) => state.sketchDrag !== null);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  // 任意の作業平面(FR-328)の名前を札に出すための一覧(タスク13)。
  const customPlanes = workPlaneEntries(useAppStore((state) => state.document));
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  /*
   * 表示の長さの単位(FR-811、P6 タスク3)。**区画も札の数も増やさない。**
   * いままで固定の文字だった右端の「単位: mm」の札を、そのまま押せる 2 択にする。
   * 端末に覚える設定なので、テーマや拡大率と同じ `displaySettings` に入っている。
   */
  const displaySettings = useAppStore((state) => state.displaySettings);
  const setDisplaySettings = useAppStore((state) => state.setDisplaySettings);
  /*
   * 選択フィルタ(FR-112、P6 タスク36)。**端末に覚える設定**なので単位と同じ
   * `displaySettings` の中にある(`localStorage` の鍵を増やさない、§0.43)。
   */
  const selectionFilter = displaySettings.selectionFilter;
  const snapIndicator = useAppStore((state) => state.snapIndicator);
  // 向きの吸着の案内線(FR-110、P4b タスク16)。帯の一言に角度と要素の名前を出す。
  const trackIndicator = useAppStore((state) => state.trackIndicator);
  // 名前(「線分1」)は履歴が持っている。案内線のもとになった要素だけを引く。
  const sketchFeatures = useAppStore((state) => state.sketch.features);
  const fileName = useAppStore(activeFileName);
  const fileMessage = useAppStore((state) => state.fileMessage);
  const recomputeProgress = useAppStore((state) => state.recomputeProgress);
  const recomputeCancelled = useAppStore((state) => state.recomputeCancelled);
  const cancelRecompute = useAppStore((state) => state.cancelRecompute);
  // 真偽で取り出して、印が付くか外れるかが変わったときだけ描き直す(NFR-PF-1)。
  const unsaved = useAppStore(activeHasUnsavedChanges);
  // 数で取り出す。ブーリアンの案内を出すかどうかにしか使わない(FR-404)。
  const selectedBodyCount = useAppStore((state) =>
    countSelectedBodies(state.selection, liveBodyIds(state.document)),
  );
  // 選択の種類の札(§0.a-0.6)。立体を選ぶ道具のときは部分形状を数えない(0 のまま)。
  const selectionKind = useAppStore((state) => state.selectionKind);
  const selectedSubShapeCount = useAppStore((state) =>
    state.selectionKind === 'body' ? 0 : countSelectedSubShapes(state.selection, state.selectionKind),
  );
  /*
   * ばねの段階的な案内(§0.a-0.29、仕上げ (d))。始点にする点が選ばれているかは、
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
   * 進み具合を出してよいかどうかだけを持つ表示専用の状態(rules/04: useState は
   * 表示専用の一時状態だけ)。見張るのは「進み具合が届いているか」の真偽で、
   * 段が進むたびに動く中身ではない。中身で見張ると段ごとに待ち時間が振り出しへ戻り、
   * 長い計算でもいつまでも出なくなる。
   */
  const hasProgress = recomputeProgress !== null;
  const [progressVisible, setProgressVisible] = useState(false);
  /*
   * コマンドラインで打った 1 行を受け取れなかった理由(FR-208、P4b タスク18)。
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

  const line = describeStatus({
    assemblyMateStatus: assemblyMateStatus(mateDraft, mateDiagnosis, mateTargetErrors ?? new Map()),
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
    // つまみが末尾でないことの札と、末尾へ戻したことの知らせ(FR-507、タスク19)。
    rollback: rollbackOf(historyCount, timelineIndex),
    timelineNoticeKey,
    exchangeNotice,
    printCheckErrorMessage,
    inspectingPrint,
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
    // 3D スケッチのときだけ案内へ一言を添える(FR-330、タスク14)。
    workPlaneId,
  });
  const className =
    line.kind === 'failure' ? 'pcad-statusbar pcad-statusbar--error' : 'pcad-statusbar';

  return (
    <footer className={className}>
      {/* 開いているファイルの名前。区画は増やさず、状況の1文の左へ小さく置く。 */}
      <span
        className="pcad-statusbar__file"
        title={unsaved ? t('file.unsavedChanges') : fileLabel}
      >
        {fileLabel}
      </span>
      {/*
        キーボードだけで作図するためのコマンドラインの欄(FR-208、§0.a-0.8)。
        ファイル名の右・状況の 1 文の左へ入れる。**区画は 5 つのまま**で、打っている間だけ
        欄が広がり、そのぶんを右の余白と状況の 1 文が譲る(appShell.css)。
      */}
      <CommandLine onFailureChange={setCommandFailure} />
      <span className="pcad-statusbar__message" aria-live="polite">
        {statusIcon(line.kind)}
        <span className="pcad-statusbar__text">{line.text}</span>
        {/*
          案内に添える一言(3D スケッチで頂点を押せること、FR-330 / NFR-UX-7、タスク14)。
          計算中の進み具合に添える一言は下の進捗の並びで出すので、ここでは案内のときだけ。
        */}
        {line.kind === 'guide' && line.hint !== null ? (
          <span className="pcad-statusbar__hint">{line.hint}</span>
        ) : null}
      </span>
      {line.progress === null ? null : (
        /*
         * 計算の進み具合と中止(NFR-PF-4)。中止は段と段の間でしか効かないので、
         * 待たされることがある旨を薄い字とツールチップで先に伝える(§2.6 の限界)。
         */
        <span className="pcad-statusbar__progress">
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
          {line.hint === null ? null : (
            <span className="pcad-statusbar__hint">{line.hint}</span>
          )}
          <button
            type="button"
            className="pcad-button pcad-button--action pcad-statusbar__cancel"
            title={line.hint ?? t('statusBar.cancel')}
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
        と見えるため(P4b タスク19)。
      */}
      {line.rollbackLabel === null ? null : (
        <span className="pcad-statusbar__rollback" title={t('timeline.rollbackTooltip')}>
          {line.rollbackLabel}
        </span>
      )}
      {/* 選択の種類の札(§0.a-0.6)。`1`〜`4` キーで切り替えられることをツールチップで添える。 */}
      <span className="pcad-statusbar__state" title={t('selection.kindHint')}>
        {line.selectionKindLabel}
      </span>
      {/*
        選択フィルタ(FR-112、P6 タスク36、§0.43)。**区画も並びも増やさない**——
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
      <span className="pcad-statusbar__state">
        <PlaneIcon size={12} />
        {`${t('statusBar.plane')} ${planeLabel(workPlaneId, customPlanes)}`}
      </span>
      <span className="pcad-statusbar__state">
        <SnapIcon size={12} />
        {snapEnabled ? t('statusBar.snapOn') : t('statusBar.snapOff')}
      </span>
      {/*
        拘束の自動推定の入切(FR-333、P6 タスク41、§0.a-0.49)。**区画は増やさない**——
        吸着の札のとなりに入切を 1 つだけ足す。見た目は選択フィルタ・ツールバーの入切と
        同じ作法(`aria-pressed` と `.pcad-button[aria-pressed="true"]`)にそろえるので、
        appShell.css は 1 行も増えない。**既定は入**で、端末に覚える(`displaySettings`)。
        しきい値の数値は出さない(§0.a-0.48「ヘルプにも画面にも数値を書かない」)。
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
