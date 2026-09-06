/**
 * 作図面の一覧(FR-328、FR-330)。一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import { FREE_WORK_PLANE_ID, isFreeWorkPlaneId, type WorkPlaneId } from '@pointercad/model';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n/t.js';
import type { NumericInputToolId } from '../../sketch/numericInput.js';
import type { WorkPlaneEntry } from '../../sketch/referenceCommands.js';
import { ChevronRightIcon } from '../icons.js';
import { activateReferenceTool } from './sketchToolActions.js';
import { PLANE_TOOLS, PLANES, REFERENCE_TOOLS, selectWorkPlane } from './sketchToolTables.js';
import { LABEL_SEPARATOR } from './toolbarShared.js';

interface PlaneMenuProps {
  readonly workPlaneId: WorkPlaneId;
  /** いま選ばれている道具。基準ジオメトリの道具なら一覧の中で押されて見える。 */
  readonly activeTool: NumericInputToolId;
  /** 文書にある任意の作業平面(FR-328)。基準の 3 面の下に名前で並べる。 */
  readonly customPlanes: readonly WorkPlaneEntry[];
}

/**
 * 作図面(XY / XZ / YZ)の畳んだ一覧(§0.a-0.25 ②、§0.34)。
 *
 * ①(無効なモードタブを隠す)と「加工」区画・ばねを足しただけでは、1440 画素へ
 * 必要な幅が実測 1437.3px となり(2026-09-04 実測)、余裕が 3px 弱しか無い
 * (書体やスクロールバーの差で環境によっては 1440px を超えかねない)。そこで
 * `SnapKindsMenu` と同じ畳んだ一覧の作りで 3 つを 1 つのトリガー+一覧へまとめ、
 * 安全な余白を作る(§0.34「②を行ってよい」)。トリガーには**いまの作図面の名前を
 * 札に出す**(畳んでも状態が分かる、§0.34)。モーダルにしない(NFR-UX-2)ので、
 * 開いている間も背後の操作はそのまま効く。
 */
export function PlaneMenu({ workPlaneId, activeTool, customPlanes }: PlaneMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
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

  const base = PLANES.find((plane) => plane.id === workPlaneId);
  const custom = customPlanes.find((plane) => plane.id === workPlaneId);
  const free = isFreeWorkPlaneId(workPlaneId);
  // トリガーの札は、基準の 3 面なら「XY」、任意の作業平面なら付いている名前、
  // 3D スケッチ(作図面なし、FR-330)なら「3D」を出す。
  const currentLabel = free
    ? t('toolbar.plane.free')
    : base === undefined
      ? (custom?.name ?? t(PLANES[0].labelKey))
      : t(base.labelKey);
  const currentTooltip = free
    ? t('toolbar.plane.freeTooltip')
    : base === undefined
      ? t('toolbar.plane.tooltip')
      : t(base.tooltipKey);

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
        title={currentTooltip}
        aria-label={`${t('toolbar.plane.groupLabel')}${LABEL_SEPARATOR}${currentLabel}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="pcad-menu__count">{currentLabel}</span>
        <ChevronRightIcon className="pcad-menu__chevron" />
      </button>
      {open ? (
        <div className="pcad-menu__panel" role="group" aria-label={t('toolbar.plane.groupLabel')}>
          {PLANES.map((plane) => (
            <button
              key={plane.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(plane.tooltipKey)}
              aria-pressed={workPlaneId === plane.id}
              onClick={() => {
                selectWorkPlane(plane.id);
                setOpen(false);
              }}
            >
              {t(plane.labelKey)}
            </button>
          ))}
          {/* 文書にある任意の作業平面(FR-328)。作った順に名前で並べる。 */}
          {customPlanes.map((plane) => (
            <button
              key={plane.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t('toolbar.plane.tooltip')}
              aria-pressed={workPlaneId === plane.id}
              onClick={() => {
                selectWorkPlane(plane.id);
                setOpen(false);
              }}
            >
              {plane.name}
            </button>
          ))}
          {/*
            3D スケッチ(作図面なし、FR-330)。作図面の一覧の最後に置く。空間に直接
            点・線分・円弧・スプライン・面を置く状態で、立体の頂点を押して点にできる。
          */}
          <button
            type="button"
            className="pcad-button pcad-menu__item"
            title={t('toolbar.plane.freeTooltip')}
            aria-pressed={free}
            onClick={() => {
              selectWorkPlane(FREE_WORK_PLANE_ID);
              setOpen(false);
            }}
          >
            {t('toolbar.plane.free')}
          </button>
          {/* 作業平面の作り方 4 通り(FR-328)と、基準軸・基準点・座標系(FR-329)。 */}
          <span className="pcad-menu__section">{t('toolbar.plane.createPlane')}</span>
          {PLANE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(tool.tooltipKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateReferenceTool(tool.id, activeTool === tool.id);
                setOpen(false);
              }}
            >
              {t(tool.labelKey)}
            </button>
          ))}
          <span className="pcad-menu__section">{t('toolbar.reference.groupLabel')}</span>
          {REFERENCE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(tool.tooltipKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateReferenceTool(tool.id, activeTool === tool.id);
                setOpen(false);
              }}
            >
              {t(tool.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
