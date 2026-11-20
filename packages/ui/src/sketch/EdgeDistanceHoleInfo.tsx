import { t } from '../i18n/t.js';
import { SELECTION_KIND_LABEL_KEYS } from '../solid/selectionFilter.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 辺からの距離の穴(M-02)の欄の中の案内。3D で選んである辺 1・辺 2 を選んだ順に見せる
 * (確定で同じ順が辺 1・辺 2 になる。`machiningCommands.ts` の `edgeDistancePlacement`)。文書・履歴は変えない。
 */
export function EdgeDistanceHoleInfo(): React.JSX.Element {
  const selection = useAppStore((state) => state.selection);
  const edges = selection.flatMap((id) => {
    const parsed = parseSubShapeId(id);
    return parsed?.kind === 'edge' ? [parsed.index] : [];
  });
  const label = (index: number | undefined): string => index === undefined
    ? t('numericInput.edgeDistance.unpicked') : `${t(SELECTION_KIND_LABEL_KEYS.edge)} ${String(index + 1)}`;
  return <div className="pcad-section" role="note">
    <dl className="pcad-properties">
      <dt>{t('numericInput.edgeDistance.edge1')}</dt><dd>{label(edges.at(0))}</dd>
      <dt>{t('numericInput.edgeDistance.edge2')}</dt><dd>{label(edges.at(1))}</dd>
    </dl>
    <p>{t('numericInput.edgeDistance.note')}</p>
  </div>;
}
