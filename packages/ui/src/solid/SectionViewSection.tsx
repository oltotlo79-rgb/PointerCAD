import { formatLength } from '@pointercad/model';
import { PLANE_SPEC_LABEL_KEYS } from './referenceSummary.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 「断面表示」の節(FR-111、§2.18)。
 *
 * **状態の表示と入切だけに絞る。** 切る位置のつまみとその場の数値入力はビューポートの
 * 浮かぶ欄(タスク35)が持っている。同じ値の入口を 2 か所に作ると、打っている途中の
 * 下書きが 2 つに分かれてどちらが本物か分からなくなる(P4b の「同じ値の入口を 2 つ
 * 作らない」)。ここは**いまどの面で・どれだけずらして・どちら側を残しているか**を読み、
 * 浮かぶ欄には無い「切る位置を 0 へ戻す」だけを足す。
 *
 * **再計算は走らない**(文書に触らない。§2.17-7)。
 */
export function SectionViewSection(): React.JSX.Element {
  const sectionView = useAppStore((state) => state.sectionView);
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('sectionView.title')}</h3>
      {sectionView === null ? (
        <p className="pcad-panel__note">{t('propertyPanel.sectionViewOff')}</p>
      ) : (
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.sectionViewPlane')}</dt>
          <dd className="pcad-properties__value">
            {t(PLANE_SPEC_LABEL_KEYS[sectionView.plane.kind])}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.sectionViewOffset')}</dt>
          <dd className="pcad-properties__value">{formatLength(sectionView.offsetMm)}</dd>
          <dt className="pcad-properties__key">{t('propertyPanel.sectionViewSide')}</dt>
          <dd className="pcad-properties__value">
            {t(
              sectionView.flipped
                ? 'propertyPanel.sectionViewSideBack'
                : 'propertyPanel.sectionViewSideFront',
            )}
          </dd>
        </dl>
      )}
      <div className="pcad-appearance__actions">
        <button
          type="button"
          className="pcad-button"
          aria-pressed={sectionView !== null}
          title={t(
            sectionView === null
              ? 'propertyPanel.sectionViewOnTooltip'
              : 'propertyPanel.sectionViewOffTooltip',
          )}
          onClick={() => {
            useAppStore.getState().toggleSectionView();
          }}
        >
          {t(sectionView === null ? 'propertyPanel.sectionViewOn' : 'sectionView.close')}
        </button>
        <button
          type="button"
          className="pcad-button"
          title={t('propertyPanel.sectionViewResetTooltip')}
          disabled={sectionView === null || sectionView.offsetMm === 0}
          onClick={() => {
            useAppStore.getState().setSectionOffset(0);
          }}
        >
          {t('propertyPanel.sectionViewReset')}
        </button>
      </div>
    </div>
  );
}
