import { useState } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ChevronRightIcon, CubeIcon, EmptyBoxIcon, LayersIcon } from './icons.js';

/**
 * 左のモデルブラウザ(要件§7.1)。
 *
 * 「部品 → その中の形」の親子で並べ、親には開閉の印を付ける。開いているかどうかは
 * 見た目だけの一時状態なのでコンポーネントに持つ(rules/04-設計の規律.md)。
 */
export function FeatureTree(): React.JSX.Element {
  const documentName = useAppStore((state) => state.documentName);
  const featureNames = useAppStore((state) => state.featureNames);
  const [isExpanded, setIsExpanded] = useState(true);

  const chevronClassName =
    'pcad-tree__chevron' + (isExpanded ? ' pcad-tree__chevron--open' : '');

  return (
    <section className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('featureTree.title')}</h2>
      <div className="pcad-panel__body">
        {featureNames.length === 0 ? (
          <div className="pcad-panel__empty">
            <EmptyBoxIcon size={28} />
            <p className="pcad-panel__empty-text">{t('featureTree.empty')}</p>
          </div>
        ) : (
          <ul className="pcad-tree">
            <li>
              <button
                type="button"
                className="pcad-tree__row"
                title={t('featureTree.toggleTooltip')}
                aria-expanded={isExpanded}
                onClick={() => {
                  setIsExpanded((expanded) => !expanded);
                }}
              >
                <ChevronRightIcon size={12} className={chevronClassName} />
                <LayersIcon size={14} className="pcad-tree__icon" />
                <span className="pcad-tree__label">{documentName}</span>
              </button>
              {isExpanded ? (
                <ul className="pcad-tree__children">
                  {featureNames.map((name) => (
                    <li key={name}>
                      <div className="pcad-tree__row pcad-tree__row--child">
                        <CubeIcon size={14} className="pcad-tree__icon" />
                        <span className="pcad-tree__label">{name}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          </ul>
        )}
      </div>
    </section>
  );
}
