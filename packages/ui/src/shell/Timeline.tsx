import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  timelineIndexForClick,
  timelineStopTooltipKey,
  type TimelineStop,
} from './timelineRail.js';

/**
 * タイムラインのつまみ 1 つ(FR-507、FR-506。P4b タスク19)。
 *
 * 置き場はモデルブラウザ(左の区画)の中で、「基準」「ソリッド」の行の左端をなぞる細い
 * 縦のレール(§0.a-0.18 の利用者の決定は案 B)。**固定区画は 5 つのまま増やさない**
 * (rules/04-設計の規律.md)。履歴の順序はすでに木が表しているので、同じ並びを
 * 帯としてもう 1 本描かず、木の行そのものを帯の段として使う。
 *
 * 押すとその段までの形が 3D に出る(ロールバック)。もう一度同じ段を押すと末尾へ戻るので、
 * 素早く 2 回押す(ダブルクリック)操作でも末尾へ戻る。つまみより後ろの行は薄くなる。
 *
 * どこを押すと何が起きるかは `timelineRail.ts` の純関数が決め、ここは描くだけにする。
 */
export interface TimelineStopHandleProps {
  readonly stop: TimelineStop;
  /** つまみが末尾にいるか。説明の言い回しを変えるのに使う。 */
  readonly atEnd: boolean;
}

export function TimelineStopHandle({ stop, atEnd }: TimelineStopHandleProps): React.JSX.Element {
  const tooltip = t(timelineStopTooltipKey(stop.state, atEnd));
  return (
    <button
      type="button"
      className={`pcad-timeline__stop pcad-timeline__stop--${stop.state}`}
      title={`${stop.entry.name} ${tooltip}`}
      aria-label={`${stop.entry.name} ${tooltip}`}
      aria-pressed={stop.state === 'current'}
      onClick={(event) => {
        // 行そのものの選択(木の行の onClick)までは連れて行かない。つまみは
        // 「どこまで戻すか」だけを決める道具で、選択は行の名前を押して変える。
        event.stopPropagation();
        const store = useAppStore.getState();
        store.setTimelineIndex(
          timelineIndexForClick(store.document, store.timelineIndex, stop.entry.index),
        );
      }}
    >
      {/* レールと節(まる)。意味は隣の行の名前が担うので読み上げ対象にしない。 */}
      <span className="pcad-timeline__rail" aria-hidden="true" />
      <span className="pcad-timeline__knob" aria-hidden="true" />
    </button>
  );
}
