import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export function PropertyPanel(): React.JSX.Element {
  const mesh = useAppStore((state) => state.mesh);

  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      {mesh === null ? (
        <p className="pcad-panel__empty">{t('propertyPanel.empty')}</p>
      ) : (
        <ul className="pcad-panel__list">
          <li>
            {t('propertyPanel.triangleCount')}: {mesh.triangleCount}
          </li>
        </ul>
      )}
    </section>
  );
}
