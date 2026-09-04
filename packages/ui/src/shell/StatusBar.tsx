import { isBaseWorkPlaneId, liveBodyIds, type BaseWorkPlaneId } from '@pointercad/model';
import { useEffect, useState } from 'react';

import { documentLabel, hasUnsavedChanges } from '../file/partFile.js';
import { t, type MessageKey } from '../i18n/t.js';
import { workPlaneEntries, type WorkPlaneEntry } from '../sketch/referenceCommands.js';
import { solidToolReadiness } from '../solid/solidCommands.js';
import { useAppStore } from '../store/useAppStore.js';
import { AlertIcon, MouseIcon, PlaneIcon, SaveIcon, SnapIcon } from './icons.js';
import {
  countSelectedBodies,
  countSelectedSubShapes,
  describeStatus,
  PROGRESS_DELAY_MS,
  type SpringNumericInputStep,
  type StatusLineKind,
} from './statusText.js';

/** 作図面の表記。ツールバーの区画名と同じ言葉にする。 */
const PLANE_KEYS = {
  xy: 'toolbar.plane.xy',
  xz: 'toolbar.plane.xz',
  yz: 'toolbar.plane.yz',
} as const satisfies Record<BaseWorkPlaneId, MessageKey>;

/**
 * 作図面の札の文言。基準の 3 面は名前を ja.json から引き、任意の作業平面(FR-328)は
 * 文書に付いている名前(「作業平面1」など)をそのまま出す(タスク13)。
 * 名前が引けないとき(消えた平面を指したまま)は id を出して、何を指しているか分かるようにする。
 */
function planeLabel(workPlaneId: string, customPlanes: readonly WorkPlaneEntry[]): string {
  if (isBaseWorkPlaneId(workPlaneId)) {
    return t(PLANE_KEYS[workPlaneId]);
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
  // 新しい図形を作れなかった理由(P4 タスク12)。文言キーではなく組み立て済みの文。
  const shapeErrorMessage = useAppStore((state) => state.shapeErrorMessage);
  // 基準ジオメトリを作れなかった理由(P4 タスク13)。こちらも組み立て済みの文。
  const referenceErrorMessage = useAppStore((state) => state.referenceErrorMessage);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  // 任意の作業平面(FR-328)の名前を札に出すための一覧(タスク13)。
  const customPlanes = workPlaneEntries(useAppStore((state) => state.document));
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const snapIndicator = useAppStore((state) => state.snapIndicator);
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

  const line = describeStatus({
    fileMessage,
    faceErrorKey,
    solidErrorKey,
    shapeErrorMessage,
    referenceErrorMessage,
    errorMessage,
    partErrors,
    sketchErrors,
    cancelled: recomputeCancelled,
    progress: progressVisible ? recomputeProgress : null,
    isComputing,
    kernelLoaded,
    snapKind: snapIndicator === null ? null : snapIndicator.kind,
    activeTool,
    selectedBodyCount,
    selectedSubShapeCount,
    selectionKind,
    springOriginSelected,
    springStep,
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
      <span className="pcad-statusbar__message" aria-live="polite">
        {statusIcon(line.kind)}
        <span className="pcad-statusbar__text">{line.text}</span>
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
