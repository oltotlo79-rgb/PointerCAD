import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export function FeatureTree(): React.JSX.Element {
  const documentName = useAppStore((state) => state.documentName);
  const featureNames = useAppStore((state) => state.featureNames);

  return (
    <section className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('featureTree.title')}</h2>
      {featureNames.length === 0 ? (
        <p className="pcad-panel__empty">{t('featureTree.empty')}</p>
      ) : (
        <ul className="pcad-panel__list">
          <li>{documentName}</li>
          {featureNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
