import type { WorkPlaneId } from '@pointercad/model';

import { documentLabel, hasUnsavedChanges } from '../file/partFile.js';
import { t, type MessageKey } from '../i18n/t.js';
import type { NumericInputToolId } from '../sketch/numericInput.js';
import type { SnapKind } from '../sketch/snapMath.js';
import { useAppStore } from '../store/useAppStore.js';
import { AlertIcon, MouseIcon, PlaneIcon, SaveIcon, SnapIcon } from './icons.js';

/**
 * 道具ごとの次の一手(FR-905、NFR-UX-7)。
 * 選択のときは道具そのものの説明より、視点の動かし方を知らせるほうが役に立つので
 * これまでの案内(`statusBar.ready`)をそのまま出す。
 */
const GUIDE_KEYS = {
  select: 'statusBar.ready',
  point: 'statusBar.guide.point',
  line: 'statusBar.guide.line',
  arc: 'statusBar.guide.arc',
  pointArray: 'statusBar.guide.pointArray',
  face: 'statusBar.guide.face',
  extrude: 'statusBar.guide.extrude',
  revolve: 'statusBar.guide.revolve',
  sew: 'statusBar.guide.sew',
} as const satisfies Record<NumericInputToolId, MessageKey>;

/** いま何に吸い付いているかの案内(FR-107、NFR-UX-7)。 */
const SNAP_GUIDE_KEYS = {
  endpoint: 'statusBar.snap.endpoint',
  intersection: 'statusBar.snap.intersection',
  midpoint: 'statusBar.snap.midpoint',
  center: 'statusBar.snap.center',
  grid: 'statusBar.snap.grid',
} as const satisfies Record<SnapKind, MessageKey>;

/** 作図面の表記。ツールバーの区画名と同じ言葉にする。 */
const PLANE_KEYS = {
  xy: 'toolbar.plane.xy',
  xz: 'toolbar.plane.xz',
  yz: 'toolbar.plane.yz',
} as const satisfies Record<WorkPlaneId, MessageKey>;

/** 帯に出す1文。何の失敗かで頭の言葉を変える。頭の言葉が要らないものは null。 */
interface StatusFailure {
  readonly prefix: string | null;
  readonly text: string;
}

/** 頭の言葉と本文をつなぐ空白。文字そのものは言葉に依らないのでここに置く。 */
const PREFIX_SEPARATOR = ' ';

function failureText(failure: StatusFailure): string {
  return failure.prefix === null
    ? failure.text
    : `${failure.prefix}${PREFIX_SEPARATOR}${failure.text}`;
}

/**
 * 下端のステータスバー(要件§7.1、FR-905)。
 *
 * 左は今の状況を1文で伝える(失敗 / 計算中 / 吸着中の案内 / 道具ごとの操作ガイド)。
 * 右は「作図面」「吸着」「単位」を小さな札で常に見せる。
 * 失敗しても操作は止めず、帯の色と文言で知らせる(FR-504、NFR-RE-1)。
 */
export function StatusBar(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  const errorMessage = useAppStore((state) => state.errorMessage);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const faceErrorKey = useAppStore((state) => state.faceErrorKey);
  const solidErrorKey = useAppStore((state) => state.solidErrorKey);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const snapIndicator = useAppStore((state) => state.snapIndicator);
  const fileName = useAppStore((state) => state.fileName);
  const fileMessage = useAppStore((state) => state.fileMessage);
  // 真偽で取り出して、印が付くか外れるかが変わったときだけ描き直す(NFR-PF-1)。
  const unsaved = useAppStore((state) => hasUnsavedChanges(state.document, state.savedDocument));

  // 開いているファイルの名前。保存していない変更があれば末尾に印が付く(FR-806)。
  const fileLabel = documentLabel(fileName, unsaved);

  /*
   * 面を張れなかった・立体を作れなかったことは、いま押した Enter やボタンへの返事なので
   * 最初に出す。頭の言葉は「面を作れませんでした:」「立体を作れませんでした:」で、
   * 計算の失敗の「計算に失敗しました:」とは重ねない。
   * 続いて計算そのものの失敗、最後にスケッチの解決の失敗(FR-504)。
   */
  const sketchFailure = sketchErrors.length === 0 ? null : sketchErrors[0].message;
  const failure: StatusFailure | null =
    // ファイルの失敗は、いま押したボタンへの返事なので最初に出す。理由の文だけで
    // 何が起きたかが分かる書き方にしてあるので、頭の言葉は添えない。
    fileMessage !== null && fileMessage.failed
      ? { prefix: null, text: t(fileMessage.key) }
      : faceErrorKey !== null
        ? { prefix: t('statusBar.faceError'), text: t(faceErrorKey) }
        : solidErrorKey !== null
          ? { prefix: t('statusBar.solidError'), text: t(solidErrorKey) }
          : errorMessage !== null
            ? { prefix: t('statusBar.error'), text: errorMessage }
            : sketchFailure !== null
              ? { prefix: t('statusBar.error'), text: sketchFailure }
              : null;
  const className = failure === null ? 'pcad-statusbar' : 'pcad-statusbar pcad-statusbar--error';

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
        {failure !== null ? (
          <>
            <AlertIcon size={14} />
            <span className="pcad-statusbar__text">{failureText(failure)}</span>
          </>
        ) : fileMessage !== null ? (
          /* 保存できたことなど、うまくいったときの短い知らせ(FR-806)。 */
          <>
            <SaveIcon size={14} />
            <span className="pcad-statusbar__text">{t(fileMessage.key)}</span>
          </>
        ) : isComputing ? (
          <>
            <span className="pcad-spinner" aria-hidden="true" />
            <span className="pcad-statusbar__text">{t('statusBar.loading')}</span>
          </>
        ) : snapIndicator !== null ? (
          <>
            <SnapIcon size={14} />
            <span className="pcad-statusbar__text">
              {t(SNAP_GUIDE_KEYS[snapIndicator.kind])}
            </span>
          </>
        ) : (
          <>
            <MouseIcon size={14} />
            <span className="pcad-statusbar__text">{t(GUIDE_KEYS[activeTool])}</span>
          </>
        )}
      </span>
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
