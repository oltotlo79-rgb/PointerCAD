import { Fragment, useState } from 'react';

import { evaluateExpression } from '@pointercad/expression';
import type { SketchFeature } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import {
  faceBoundaryEntries,
  FEATURE_KIND_LABEL_KEYS,
  featureForSelection,
  featureIdOf,
  resolvedFields,
  setFeatureCoordinateMode,
  setFeatureField,
  summarizeFeature,
  type FeatureFieldSummary,
} from '../sketch/featureSummary.js';
import {
  COORDINATE_MODES,
  MODE_LABEL_KEYS,
  MODE_TOOLTIP_KEYS,
} from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 面の塗り色の見本(FR-310、§0.a-0.5)。ここが履歴へ保存する値の正本で、
 * appShell.css の --pcad-swatch-1〜8 は同じ色を見本の下地に使うための写し。
 * 任意色は P2 以降。
 */
const FACE_COLORS: readonly string[] = [
  '#7aa2f7',
  '#7dcfff',
  '#9ece6a',
  '#e0af68',
  '#f7768e',
  '#bb9af7',
  '#c0caf5',
  '#8c93a3',
];

/** 打っている途中の欄。式として読めるようになるまで履歴へは書き戻さない。 */
interface FieldDraft {
  readonly path: string;
  readonly source: string;
}

/**
 * 選ばれている要素 1 つの中身(FR-202、FR-311)。
 *
 * 欄には**入力した式そのもの**を出す。評価値ではない(FR-202)。式として読めたときだけ
 * 履歴を差し替え、下流は再計算で追従する(FR-311)。読めない間は履歴を変えず、欄だけが赤くなる。
 *
 * 打っている途中の文字を `useState` に持つのは、`ExpressionField` が値を自分で覚えない
 * 作りだから。`10*√2` の `*` まで打った瞬間は式として読めず、履歴へ書き戻せない。
 * 書き戻せないものを覚えておかないと、打っている途中で欄の中身が前の値へ戻ってしまう。
 * 見た目だけの一時状態なので `useState` に置いてよい(rules/04-設計の規律.md)。
 * 選ぶ要素が変わったときは `key` で作り直され、この途中の文字も消える。
 */
function FeatureProperties({ feature }: { readonly feature: SketchFeature }): React.JSX.Element {
  const sketch = useAppStore((state) => state.sketch);
  const resolved = useAppStore((state) => state.resolvedSketch);
  const sketchMesh = useAppStore((state) => state.sketchMesh);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const [draft, setDraft] = useState<FieldDraft | null>(null);

  const summary = summarizeFeature(feature, sketchErrors);
  const computed = resolvedFields(feature, resolved, sketchMesh);

  const renderField = (item: FeatureFieldSummary): React.JSX.Element => {
    const source = draft !== null && draft.path === item.path ? draft.source : item.value.source;
    const evaluated = evaluateExpression(source);
    return (
      <ExpressionField
        key={item.path}
        field={{
          key: item.path,
          labelKey: item.labelKey,
          tooltipKey: item.labelKey,
          unit: item.unit,
          defaultSource: item.value.source,
          source,
        }}
        result={
          evaluated.ok
            ? { key: item.path, value: evaluated.value, error: null }
            : { key: item.path, value: null, error: evaluated.error }
        }
        /* 焦点の正本は利用者のクリックとタブ移動。こちらからは動かさない。 */
        focused={false}
        onFocus={() => undefined}
        onChange={(next) => {
          setDraft({ path: item.path, source: next });
          const parsed = evaluateExpression(next);
          if (!parsed.ok) {
            return;
          }
          useAppStore
            .getState()
            .replaceSketchFeature(feature.id, setFeatureField(feature, item.path, parsed.value));
        }}
      />
    );
  };

  return (
    <>
      {summary.errorMessage === null ? null : (
        <p className="pcad-panel__error">{summary.errorMessage}</p>
      )}

      {summary.coordinates.length === 0 && summary.scalars.length === 0 ? null : (
        <div className="pcad-section">
          <h3 className="pcad-section__title">{t('propertyPanel.sectionSketch')}</h3>
          {summary.coordinates.map((group) => (
            <div className="pcad-coordinate" key={group.path}>
              <h4 className="pcad-coordinate__title">{t(group.labelKey)}</h4>
              <div
                className="pcad-segmented pcad-coordinate__modes"
                role="group"
                aria-label={t('numericInput.modeGroupLabel')}
              >
                {COORDINATE_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className="pcad-button"
                    aria-pressed={group.mode === mode}
                    title={t(MODE_TOOLTIP_KEYS[mode])}
                    onClick={() => {
                      const next = setFeatureCoordinateMode(feature, group.path, mode);
                      if (next !== feature) {
                        useAppStore.getState().replaceSketchFeature(feature.id, next);
                      }
                    }}
                  >
                    {t(MODE_LABEL_KEYS[mode])}
                  </button>
                ))}
              </div>
              <div className="pcad-coordinate__fields">{group.fields.map(renderField)}</div>
            </div>
          ))}
          {summary.scalars.length === 0 ? null : (
            <div className="pcad-coordinate__fields">{summary.scalars.map(renderField)}</div>
          )}
        </div>
      )}

      {feature.kind !== 'face' ? null : (
        <>
          <div className="pcad-section">
            <h3 className="pcad-section__title">{t('propertyPanel.sectionColor')}</h3>
            <div
              className="pcad-swatches"
              role="group"
              aria-label={t('propertyPanel.sectionColor')}
            >
              {FACE_COLORS.map((color, index) => (
                <button
                  key={color}
                  type="button"
                  className={`pcad-swatch pcad-swatch--${String(index + 1)}`}
                  aria-pressed={feature.color === color}
                  aria-label={color}
                  title={t('propertyPanel.colorTooltip')}
                  onClick={() => {
                    useAppStore
                      .getState()
                      .replaceSketchFeature(feature.id, { ...feature, color });
                  }}
                />
              ))}
            </div>
          </div>
          <div className="pcad-section">
            <h3 className="pcad-section__title">{t('propertyPanel.sectionBoundary')}</h3>
            <ol className="pcad-boundary">
              {faceBoundaryEntries(sketch, feature).map((entry) => (
                <li key={entry.elementId}>
                  <button
                    type="button"
                    className="pcad-boundary__row"
                    title={t('propertyPanel.boundaryTooltip')}
                    onClick={() => {
                      useAppStore.getState().setSelection([entry.elementId]);
                    }}
                  >
                    {entry.label}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}

      {computed.length === 0 ? null : (
        <div className="pcad-section">
          <h3 className="pcad-section__title">{t('propertyPanel.sectionShape')}</h3>
          <dl className="pcad-properties">
            {computed.map((item) => (
              <Fragment key={item.labelKey}>
                <dt className="pcad-properties__key">{t(item.labelKey)}</dt>
                <dd className="pcad-properties__value">{item.text}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

/**
 * 右のプロパティパネル(要件§7.1、FR-202、FR-310、FR-311)。
 *
 * 1 つだけ選ばれているときは中身を出して式のまま直せるようにし、いくつも選ばれているときは
 * 数と種類だけを出す(面を張るときは順に選んでいくので、そのたびに欄が入れ替わらないように)。
 * 節ごとに「鍵(補助色)と値(等幅の数字)」の2列で並べる形は P0 から変えない。
 */
export function PropertyPanel(): React.JSX.Element {
  const sketch = useAppStore((state) => state.sketch);
  const selection = useAppStore((state) => state.selection);

  const featureIds = [...new Set(selection.map((id) => featureIdOf(id)))];
  const feature = featureIds.length === 1 ? featureForSelection(sketch, selection) : null;
  const kinds = [
    ...new Set(
      featureIds.map((id) => {
        const found = sketch.features.find((candidate) => candidate.id === id);
        return found === undefined ? null : t(FEATURE_KIND_LABEL_KEYS[found.kind]);
      }),
    ),
  ].filter((label): label is string => label !== null);

  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      <div className="pcad-panel__body">
        {feature !== null ? (
          <FeatureProperties key={feature.id} feature={feature} />
        ) : featureIds.length > 1 ? (
          <div className="pcad-section">
            <h3 className="pcad-section__title">{t('propertyPanel.sectionSelection')}</h3>
            <dl className="pcad-properties">
              <dt className="pcad-properties__key">{t('propertyPanel.selectedCount')}</dt>
              <dd className="pcad-properties__value">{featureIds.length}</dd>
              <dt className="pcad-properties__key">{t('propertyPanel.selectedKinds')}</dt>
              <dd className="pcad-properties__value">{kinds.join(' / ')}</dd>
            </dl>
          </div>
        ) : (
          <div className="pcad-panel__empty">
            <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
