import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 「拘束の推定」の節(FR-333、§0.a-0.49、タスク41・43)。
 *
 * **値はステータスバーの入切とまったく同じ 1 つ**(`displaySettings.inferConstraints`)で、
 * 同じ setter を通す。2 か所で別々に持つと、片方を押したときにもう片方が古い値のまま
 * 残る(rules/04「同じ状態を 2 か所に持たない」)。しきい値の数は出さない(§0.a-0.48)。
 */
export function InferConstraintsSection(): React.JSX.Element {
  const displaySettings = useAppStore((state) => state.displaySettings);
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionInferConstraints')}</h3>
      <div className="pcad-appearance__actions">
        <button
          type="button"
          className="pcad-button"
          aria-pressed={displaySettings.inferConstraints}
          title={t('statusBar.inferConstraintsHint')}
          onClick={() => {
            useAppStore.getState().setDisplaySettings({
              ...displaySettings,
              inferConstraints: !displaySettings.inferConstraints,
            });
          }}
        >
          {t('propertyPanel.inferConstraintsOn')}
        </button>
      </div>
      <p className="pcad-panel__note">{t('propertyPanel.inferConstraintsShift')}</p>
    </div>
  );
}
