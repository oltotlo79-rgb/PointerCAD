import { liveBodyIds, type WorkPlaneId } from '@pointercad/model';
import { useEffect, useState } from 'react';

import { documentLabel, hasUnsavedChanges } from '../file/partFile.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { AlertIcon, MouseIcon, PlaneIcon, SaveIcon, SnapIcon } from './icons.js';
import {
  countSelectedBodies,
  describeStatus,
  PROGRESS_DELAY_MS,
  type StatusLineKind,
} from './statusText.js';

/** 作図面の表記。ツールバーの区画名と同じ言葉にする。 */
const PLANE_KEYS = {
  xy: 'toolbar.plane.xy',
  xz: 'toolbar.plane.xz',
  yz: 'toolbar.plane.yz',
} as const satisfies Record<WorkPlaneId, MessageKey>;

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
  const errorMessage = useAppStore((state) => state.errorMessage);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const partErrors = useAppStore((state) => state.partErrors);
  const faceErrorKey = useAppStore((state) => state.faceErrorKey);
  const solidErrorKey = useAppStore((state) => state.solidErrorKey);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
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
    errorMessage,
    partErrors,
    sketchErrors,
    cancelled: recomputeCancelled,
    progress: progressVisible ? recomputeProgress : null,
    isComputing,
    snapKind: snapIndicator === null ? null : snapIndicator.kind,
    activeTool,
    selectedBodyCount,
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
      <span className="pcad-statusbar__state">
        <PlaneIcon size={12} />
        {`${t('statusBar.plane')} ${t(PLANE_KEYS[workPlaneId])}`}
      </span>
      <span className="pcad-statusbar__state">
        <SnapIcon size={12} />
        {snapEnabled ? t('statusBar.snapOn') : t('statusBar.snapOff')}
      </span>
      <span className="pcad-statusbar__unit">{t('statusBar.unit')}</span>
    </footer>
  );
}
