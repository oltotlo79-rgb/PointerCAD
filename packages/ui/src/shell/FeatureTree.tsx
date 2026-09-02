import { useState } from 'react';

import type { SketchFeatureKind } from '@pointercad/model';

import { t } from '../i18n/t.js';
import {
  FEATURE_KIND_LABEL_KEYS,
  featureErrorMessage,
  featureIdOf,
} from '../sketch/featureSummary.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  AlertIcon,
  ArcToolIcon,
  ChevronRightIcon,
  EmptyBoxIcon,
  FaceToolIcon,
  LayersIcon,
  LineToolIcon,
  PlotPointIcon,
  PointArrayToolIcon,
  type IconProps,
} from './icons.js';

/** 行の頭に出す種類の絵。道具のアイコンと同じ図柄にして、かいたものと道具を結び付ける。 */
const KIND_ICONS: Readonly<Record<SketchFeatureKind, (props: IconProps) => React.JSX.Element>> = {
  point: PlotPointIcon,
  line: LineToolIcon,
  arc: ArcToolIcon,
  pointArray: PointArrayToolIcon,
  face: FaceToolIcon,
};

/**
 * 左のモデルブラウザ(要件§7.1、FR-501)。
 *
 * 「スケッチ → その中の要素」の親子で、かいた順(履歴の順)に並べる。行をクリックで選び、
 * Shift+クリックで足す(FR-106)。指を乗せるとビューポート側も光る。計算できていない
 * 要素には赤い印を出し、理由をホバーで見せる(FR-504)。Delete か行末の印で消せる。
 *
 * 開いているかどうかは見た目だけの一時状態なのでコンポーネントに持つ(rules/04-設計の規律.md)。
 */
export function FeatureTree(): React.JSX.Element {
  const documentName = useAppStore((state) => state.documentName);
  const features = useAppStore((state) => state.sketch.features);
  const selection = useAppStore((state) => state.selection);
  const hoveredElementId = useAppStore((state) => state.hoveredElementId);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const [isExpanded, setIsExpanded] = useState(true);

  const chevronClassName =
    'pcad-tree__chevron' + (isExpanded ? ' pcad-tree__chevron--open' : '');
  // 選択もホバーも「点列の n 番目」を指すことがあるので、元の要素の id へそろえて比べる。
  const selectedIds = new Set(selection.map((id) => featureIdOf(id)));
  const hoveredId = hoveredElementId === null ? null : featureIdOf(hoveredElementId);

  return (
    <section className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('featureTree.title')}</h2>
      <div className="pcad-panel__body">
        {features.length === 0 ? (
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
                  {features.map((feature) => {
                    const KindIcon = KIND_ICONS[feature.kind];
                    const failure = featureErrorMessage(sketchErrors, feature.id);
                    const selected = selectedIds.has(feature.id);
                    const rowClassName =
                      'pcad-tree__row pcad-tree__row--child' +
                      (selected ? ' pcad-tree__row--selected' : '') +
                      (hoveredId === feature.id ? ' pcad-tree__row--hovered' : '');
                    return (
                      <li key={feature.id}>
                        <div
                          className={rowClassName}
                          onPointerEnter={() => {
                            useAppStore.getState().setHovered(feature.id);
                          }}
                          onPointerLeave={() => {
                            const store = useAppStore.getState();
                            const current = store.hoveredElementId;
                            if (current !== null && featureIdOf(current) === feature.id) {
                              store.setHovered(null);
                            }
                          }}
                        >
                          <button
                            type="button"
                            className="pcad-tree__select"
                            aria-pressed={selected}
                            title={t(FEATURE_KIND_LABEL_KEYS[feature.kind])}
                            onClick={(event) => {
                              const store = useAppStore.getState();
                              if (event.shiftKey) {
                                store.toggleSelection(feature.id);
                                return;
                              }
                              store.setSelection([feature.id]);
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Delete') {
                                return;
                              }
                              // 参照していた要素が壊れても消させる。理由は帯と赤い印で伝える(FR-504)。
                              event.preventDefault();
                              useAppStore.getState().removeSketchFeature(feature.id);
                            }}
                          >
                            <KindIcon size={14} className="pcad-tree__icon" />
                            <span className="pcad-tree__label">{feature.name}</span>
                          </button>
                          {failure === null ? null : (
                            <span
                              className="pcad-tree__alert"
                              title={`${failure} ${t('featureTree.errorTooltip')}`}
                            >
                              <AlertIcon size={12} />
                            </span>
                          )}
                          <button
                            type="button"
                            className="pcad-tree__delete"
                            title={t('featureTree.deleteTooltip')}
                            aria-label={t('featureTree.deleteTooltip')}
                            onClick={() => {
                              useAppStore.getState().removeSketchFeature(feature.id);
                            }}
                          >
                            {t('featureTree.deleteMark')}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          </ul>
        )}
      </div>
    </section>
  );
}
