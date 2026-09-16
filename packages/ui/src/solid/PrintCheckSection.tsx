import { formatLength } from '@pointercad/model';
import { withCount } from '../shell/propertySectionText.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 「3D プリントの点検」の節(FR-815、§0.53、§2.16)。
 *
 * 43b が結果の入れ物を描き、タスク46 が点検を走らせる入口(ツールバーの「表示」)と
 * 色の層をつないだ。点検をまだ 1 度もしていなければ `printability` は `null` で、
 * 「まだ点検していません。」と説明だけが出る。
 * 数の意味は model の `PrintabilitySummary` の注釈のとおり。
 */
export function PrintCheckSection(): React.JSX.Element {
  const report = useAppStore((state) => state.printability);
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionPrintCheck')}</h3>
      {report === null ? (
        <p className="pcad-panel__note">{t('propertyPanel.printCheckNotYet')}</p>
      ) : (
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckWatertight')}</dt>
          <dd className="pcad-properties__value">
            {t(
              report.summary.watertight
                ? 'propertyPanel.printCheckWatertightYes'
                : 'propertyPanel.printCheckWatertightNo',
            )}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckThin')}</dt>
          <dd className="pcad-properties__value">
            {withCount('propertyPanel.printCheckPlaceCount', report.summary.thinCount)}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckOverhang')}</dt>
          <dd className="pcad-properties__value">
            {withCount('propertyPanel.printCheckPlaceCount', report.summary.overhangCount)}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckOpenEdges')}</dt>
          <dd className="pcad-properties__value">
            {withCount('propertyPanel.printCheckPlaceCount', report.summary.openEdgeCount)}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckMinThickness')}</dt>
          <dd className="pcad-properties__value">
            {report.summary.minThicknessFoundMm === null
              ? t('propertyPanel.printCheckUnknown')
              : formatLength(report.summary.minThicknessFoundMm)}
          </dd>
        </dl>
      )}
      {report !== null && (
        <>
          {/* 色と意味の対応(§0.53)。ヘルプ(`print-check.md`)と同じ言い方にそろえる。 */}
          <p className="pcad-panel__note">{t('propertyPanel.printCheckColors')}</p>
          <div className="pcad-appearance__actions">
            <button
              type="button"
              className="pcad-button"
              title={t('propertyPanel.printCheckCloseTooltip')}
              onClick={() => {
                // 閉じると色が消えて元の外観に戻る(形も体積も 1 つも変わらない、§0.53)。
                useAppStore.getState().setPrintability(null);
              }}
            >
              {t('propertyPanel.printCheckClose')}
            </button>
          </div>
        </>
      )}
      <p className="pcad-panel__note">
        {report !== null && report.cancelled
          ? t('propertyPanel.printCheckCancelled')
          : t('propertyPanel.printCheckHint')}
      </p>
    </div>
  );
}
