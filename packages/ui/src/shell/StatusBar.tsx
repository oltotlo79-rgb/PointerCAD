import type { WorkPlaneId } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { SketchToolId } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { AlertIcon, MouseIcon, PlaneIcon, SnapIcon } from './icons.js';

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
} as const satisfies Record<SketchToolId, MessageKey>;

/** かく面の表記。ツールバーの区画名と同じ言葉にする。 */
const PLANE_KEYS = {
  xy: 'toolbar.plane.xy',
  xz: 'toolbar.plane.xz',
  yz: 'toolbar.plane.yz',
} as const satisfies Record<WorkPlaneId, MessageKey>;

/**
 * 下端のステータスバー(要件§7.1、FR-905)。
 *
 * 左は今の状況を1文で伝える(道具ごとの操作ガイド / 計算中 / 失敗)。
 * 右は「かく面」「吸着」「単位」を小さな札で常に見せる。
 * 失敗しても操作は止めず、帯の色と文言で知らせる(FR-504、NFR-RE-1)。
 */
export function StatusBar(): React.JSX.Element {
  const isComputing = useAppStore((state) => state.isComputing);
  const errorMessage = useAppStore((state) => state.errorMessage);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  const snapEnabled = useAppStore((state) => state.snapEnabled);

  // スケッチの解決に失敗したときも、計算の失敗と同じ帯で最初の理由を見せる(FR-504)。
  const sketchFailure = sketchErrors.length === 0 ? null : sketchErrors[0].message;
  const failure = errorMessage ?? sketchFailure;
  const className = failure === null ? 'pcad-statusbar' : 'pcad-statusbar pcad-statusbar--error';

  return (
    <footer className={className}>
      <span className="pcad-statusbar__message" aria-live="polite">
        {failure !== null ? (
          <>
            <AlertIcon size={14} />
            <span className="pcad-statusbar__text">{`${t('statusBar.error')} ${failure}`}</span>
          </>
        ) : isComputing ? (
          <>
            <span className="pcad-spinner" aria-hidden="true" />
            <span className="pcad-statusbar__text">{t('statusBar.loading')}</span>
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
