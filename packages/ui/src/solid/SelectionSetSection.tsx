import { useState } from 'react';
import { selectionSetRefusalMessageKey } from './selectionSetCommands.js';
import { withCount } from '../shell/propertySectionText.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 「選択セット」の節(FR-112、§2.13、§0.a-0.44)。
 *
 * 一覧(名前と員数)・新しく作る・名前を変える・消す・選ぶ・足すを 1 か所に置く。
 * 判断は `solid/selectionSetCommands.ts` と model の `part/selectionSets.ts` にあり、
 * ここは画面だけを描く。**組を触っても再計算は走らない**(`affectsShape` が偽、§0.a-0.44)。
 *
 * 覚えられるのは**立体・面・辺・頂点の 4 種すべて**(利用者の決定、2026-09-06)。
 */
export function SelectionSetSection(): React.JSX.Element {
  const sets = useAppStore((state) => state.document.selectionSets);
  const selection = useAppStore((state) => state.selection);
  const [name, setName] = useState('');
  /** 断り・知らせの 1 行(NFR-UX-5)。押すたびに入れ替わる、画面だけの状態。 */
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );

  const create = (): void => {
    const refusal = useAppStore.getState().createSelectionSetFromSelection(name);
    if (refusal !== null) {
      setNotice(t(selectionSetRefusalMessageKey(refusal)));
      return;
    }
    setName('');
    setNotice(null);
  };

  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionSelectionSets')}</h3>
      {sets.length === 0 ? (
        <p className="pcad-panel__note">{t('propertyPanel.selectionSetEmpty')}</p>
      ) : (
        <ul className="pcad-constraint-list">
          {sets.map((set) => (
            <li key={`selectionSet:${set.id}`} className="pcad-constraint-row">
              {renaming !== null && renaming.id === set.id ? (
                <input title={t('controlGuide.selectionSet.rename')}
                  className="pcad-field__input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('propertyPanel.selectionSetName')}
                  value={renaming.text}
                  onChange={(event) => {
                    setRenaming({ id: set.id, text: event.target.value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') {
                      return;
                    }
                    const refusal = useAppStore
                      .getState()
                      .renameSelectionSet(set.id, renaming.text);
                    setNotice(refusal === null ? null : t(selectionSetRefusalMessageKey(refusal)));
                    if (refusal === null) {
                      setRenaming(null);
                    }
                  }}
                  onBlur={() => {
                    setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="pcad-constraint-row__pick"
                  title={t('propertyPanel.selectionSetSelectTooltip')}
                  onClick={() => {
                    const missing = useAppStore.getState().selectSelectionSet(set.id);
                    setNotice(
                      missing === 0
                        ? null
                        : withCount('propertyPanel.selectionSetMissing', missing),
                    );
                  }}
                  onDoubleClick={() => {
                    setRenaming({ id: set.id, text: set.name });
                  }}
                >
                  <span className="pcad-constraint-row__label">{set.name}</span>
                  <span className="pcad-constraint-row__detail">
                    {withCount('propertyPanel.selectionSetCount', set.members.length)}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="pcad-button"
                title={t('propertyPanel.selectionSetAddTooltip')}
                disabled={selection.length === 0}
                onClick={() => {
                  useAppStore.getState().addSelectionToSet(set.id);
                  setNotice(null);
                }}
              >
                {t('propertyPanel.selectionSetAdd')}
              </button>
              <button
                type="button"
                className="pcad-button pcad-constraint-row__remove"
                title={t('propertyPanel.selectionSetRemoveTooltip')}
                onClick={() => {
                  useAppStore.getState().removeSelectionSet(set.id);
                  setNotice(null);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pcad-field">
        <span className="pcad-field__label">{t('propertyPanel.selectionSetName')}</span>
        <input title={t('controlGuide.selectionSet.name')}
          className="pcad-field__input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('propertyPanel.selectionSetNamePlaceholder')}
          aria-label={t('propertyPanel.selectionSetName')}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              // Enter だけで作れる(NFR-UX-4)。
              event.preventDefault();
              create();
            }
          }}
        />
      </div>
      <div className="pcad-appearance__actions">
        <button
          type="button"
          className="pcad-button"
          title={t('propertyPanel.selectionSetCreateTooltip')}
          onClick={create}
        >
          {t('propertyPanel.selectionSetCreate')}
        </button>
      </div>
      {notice === null ? null : <p className="pcad-panel__note">{notice}</p>}
    </div>
  );
}
