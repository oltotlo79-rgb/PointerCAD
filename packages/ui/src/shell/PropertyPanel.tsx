import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 右のプロパティパネル(要件§7.1)。
 *
 * 節ごとに「鍵(補助色)と値(等幅の数字)」の2列で並べる。数字の桁が揃うので
 * 値の増減が目で追える。何も選ばれていないときは案内文だけを出す。
 */
export function PropertyPanel(): React.JSX.Element {
  const mesh = useAppStore((state) => state.mesh);

  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      <div className="pcad-panel__body">
        {mesh === null ? (
          <div className="pcad-panel__empty">
            <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p>
          </div>
        ) : (
          <div className="pcad-section">
            <h3 className="pcad-section__title">{t('propertyPanel.sectionShape')}</h3>
            <dl className="pcad-properties">
              <dt className="pcad-properties__key">{t('propertyPanel.triangleCount')}</dt>
              <dd className="pcad-properties__value">{mesh.triangleCount}</dd>
            </dl>
          </div>
        )}
      </div>
    </section>
  );
}
