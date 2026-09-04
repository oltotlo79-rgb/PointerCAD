import {
  isBaseWorkPlaneId,
  isFreeWorkPlaneId,
  liveBodyIds,
  type BaseWorkPlaneId,
} from '@pointercad/model';
import { useEffect, useState } from 'react';

import { documentLabel, hasUnsavedChanges } from '../file/partFile.js';
import { t, type MessageKey } from '../i18n/t.js';
import { workPlaneEntries, type WorkPlaneEntry } from '../sketch/referenceCommands.js';
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
 * 右は「作図面」「吸着」「単位」を小さな札で常に見せる。
 * 失敗しても操作は止めず、帯の色と文言で知らせる(FR-504、NFR-RE-1)。
 *
 * 長い計算のあいだは細い進捗の帯と「中止」を出す(NFR-PF-4)。**進み具合が届いてすぐには
 * 出さない**(`PROGRESS_DELAY_MS`)。短い計算で出すと、操作のたびに札が点滅するため
 * (docs/報告記録.md 2026-09-02 23:35 の②)。
 */
export function StatusBar(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
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
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  // 任意の作業平面(FR-328)の名前を札に出すための一覧(タスク13)。
  const customPlanes = workPlaneEntries(useAppStore((state) => state.document));
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const snapIndicator = useAppStore((state) => state.snapIndicator);
  // 向きの吸着の案内線(FR-110、P4b タスク16)。帯の一言に角度と要素の名前を出す。
  const trackIndicator = useAppStore((state) => state.trackIndicator);
  // 名前(「線分1」)は履歴が持っている。案内線のもとになった要素だけを引く。
  const sketchFeatures = useAppStore((state) => state.sketch.features);
  const fileName = useAppStore((state) => state.fileName);
  const fileMessage = useAppStore((state) => state.fileMessage);
  const recomputeProgress = useAppStore((state) => state.recomputeProgress);
  const recomputeCancelled = useAppStore((state) => state.recomputeCancelled);
  const cancelRecompute = useAppStore((state) => state.cancelRecompute);
  // 真偽で取り出して、印が付くか外れるかが変わったときだけ描き直す(NFR-PF-1)。
  const unsaved = useAppStore((state) => hasUnsavedChanges(state.document, state.savedDocument));
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
    fileMessage,
    faceErrorKey,
    solidErrorKey,
    editErrorKey,
    editNoticeKey,
    shapeErrorMessage,
    referenceErrorMessage,
    commandLineFailure: commandFailure,
    originNoticeMessage,
    // つまみが末尾でないことの札と、末尾へ戻したことの知らせ(FR-507、タスク19)。
    rollback: rollbackOf(historyCount, timelineIndex),
    timelineNoticeKey,
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
      <span className="pcad-statusbar__state">
        <PlaneIcon size={12} />
        {`${t('statusBar.plane')} ${planeLabel(workPlaneId, customPlanes)}`}
      </span>
      <span className="pcad-statusbar__state">
        <SnapIcon size={12} />
        {snapEnabled ? t('statusBar.snapOn') : t('statusBar.snapOff')}
      </span>
      <span className="pcad-statusbar__unit">{t('statusBar.unit')}</span>
    </footer>
  );
}
