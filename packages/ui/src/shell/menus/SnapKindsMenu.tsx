/**
 * 吸い付きの種類の一覧(FR-107、FR-322)。一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n/t.js';
import type { SnapKind } from '../../sketch/snapMath.js';
import { TRACK_ANGLE_STEPS } from '../../sketch/trackMath.js';
import { useAppStore } from '../../store/useAppStore.js';
import { ChevronRightIcon } from '../icons.js';
import { angleStepLabel, selectTrackAngleStep, SNAP_KINDS_UI } from './sketchToolTables.js';
import { LABEL_SEPARATOR, NAME_SEPARATOR } from './toolbarShared.js';

interface SnapKindsMenuProps {
  readonly snapEnabled: boolean;
  readonly snapKinds: readonly SnapKind[];
  /** 向きの吸着の角度の刻み(度)。`settings.ts` が端末に覚える(FR-110、§0.12)。 */
  readonly trackAngleStep: number;
}

/**
 * 吸着の種別の畳んだ一覧(§0.a-0.15)。
 *
 * モーダルにしないので、開いている間も背後の視点操作と作図はそのまま効く。
 * 開いているかどうかは見た目だけの一時状態なので、ここでだけ持つ
 * (rules/04-設計の規律.md「useState は表示専用の一時状態だけ」)。
 * 吸着の入り切りと種別そのものはストアが正本。
 */
export function SnapKindsMenu({
  snapEnabled,
  snapKinds,
  trackAngleStep,
}: SnapKindsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 外を押したら閉じる。モーダルの覆いを作らないので、押した先の操作はそのまま通る。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const activeNames = SNAP_KINDS_UI.filter((entry) => snapKinds.includes(entry.kind)).map((entry) =>
    t(entry.labelKey),
  );
  // 畳んでいても何が効いているかを読めるようにし、続けて開き方を伝える(NFR-UX-7)。
  const summary = `${t('toolbar.snap.kindsLabel')}${LABEL_SEPARATOR}${
    activeNames.length === 0 ? t('toolbar.snap.kindsNone') : activeNames.join(NAME_SEPARATOR)
  }\n${t('toolbar.snap.kindsHint')}`;

  return (
    <div
      className="pcad-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="pcad-button pcad-menu__trigger"
        title={summary}
        aria-label={t('toolbar.snap.kindsLabel')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-disabled={!snapEnabled}
        onClick={() => {
          // 吸着が切のときは種別を選ぶ意味がないので開かない(NFR-UX-5)。
          if (snapEnabled) {
            setOpen(!open);
          }
        }}
      >
        <span className="pcad-menu__count">
          {`${String(activeNames.length)}/${String(SNAP_KINDS_UI.length)}`}
        </span>
        <ChevronRightIcon className="pcad-menu__chevron" />
      </button>
      {open ? (
        <div className="pcad-menu__panel" role="group" aria-label={t('toolbar.snap.kindsLabel')}>
          {SNAP_KINDS_UI.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(entry.tooltipKey)}
              aria-pressed={snapKinds.includes(entry.kind)}
              onClick={() => {
                useAppStore.getState().toggleSnapKind(entry.kind);
              }}
            >
              <entry.Icon />
              {t(entry.labelKey)}
            </button>
          ))}
          {/*
            角度の刻み(FR-110、§0.12)。**「角度」の入切のすぐ下**へ置く。この値が効くのは
            「角度」だけなので、設定パネル(テーマ・拡大率)へ離して置くより、切り替える札の
            隣にあるほうが結び付きが分かる(NFR-UX-1)。値そのものは表示設定と同じ 1 つの鍵で
            端末に覚える(`settings.ts`)。
          */}
          <span className="pcad-menu__section">{t('toolbar.snap.angleStepLabel')}</span>
          <div
            className="pcad-segmented pcad-menu__steps"
            role="group"
            aria-label={t('toolbar.snap.angleStepLabel')}
          >
            {TRACK_ANGLE_STEPS.map((step) => (
              <button
                key={step}
                type="button"
                className="pcad-button"
                title={t('toolbar.snap.angleStepTooltip')}
                aria-pressed={step === trackAngleStep}
                onClick={() => {
                  selectTrackAngleStep(step);
                }}
              >
                {angleStepLabel(step)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
