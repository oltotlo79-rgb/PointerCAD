import { useState } from 'react';
import { t } from '../i18n/t.js';
import { SELECTION_KIND_LABEL_KEYS } from '../solid/selectionFilter.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { useAppStore } from '../store/useAppStore.js';
import './numericInputPopover.css';

const DEFAULT_EDGE_DISTANCE_COLLAPSED = false;

/**
 * 辺からの距離の穴(M-02)の欄の中の案内。3D で選んである辺 1・辺 2 を選んだ順に見せる
 * (確定で同じ順が辺 1・辺 2 になる。`machiningCommands.ts` の `edgeDistancePlacement`)。文書・履歴は変えない。
 */
export function EdgeDistanceHoleInfo(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(DEFAULT_EDGE_DISTANCE_COLLAPSED);
  const selection = useAppStore((state) => state.selection);
  const edges = selection.flatMap((id) => {
    const parsed = parseSubShapeId(id);
    return parsed?.kind === 'edge' ? [parsed.index] : [];
  });
  const label = (index: number | undefined): string => index === undefined
    ? t('numericInput.edgeDistance.unpicked') : `${t(SELECTION_KIND_LABEL_KEYS.edge)} ${String(index + 1)}`;
  return <div className="pcad-section pcad-edge-distance-hole" role="note" data-edge-distance-collapsed={collapsed}>
    <dl className="pcad-properties">
      <dt>{t('numericInput.edgeDistance.edge1')}</dt><dd>{label(edges.at(0))}</dd>
      <dt>{t('numericInput.edgeDistance.edge2')}</dt><dd>{label(edges.at(1))}</dd>
    </dl>
    <button
      type="button"
      className="pcad-button"
      aria-expanded={!collapsed}
      title={t(collapsed ? 'controlGuide.button.numericEdgeDistanceExpand' : 'controlGuide.button.numericEdgeDistanceCollapse')}
      onKeyDown={(event) => {
        // Space はこのボタンに任せ、Enter と Esc は入力の窓へ渡す。
        if (event.key === ' ' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation();
      }}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        setCollapsed(wasCollapsed => !wasCollapsed);
      }}
    >
      {t(collapsed ? 'numericInput.edgeDistance.expand' : 'numericInput.edgeDistance.collapse')}
    </button>
    <p>{t('numericInput.edgeDistance.note')}</p>
  </div>;
}
