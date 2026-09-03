import { Fragment, useEffect, useRef, useState } from 'react';

import { evaluateExpression } from '@pointercad/expression';
import { replaceSolid, type SketchFeature, type SolidFeature } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { ChevronRightIcon } from './icons.js';
import {
  faceBoundaryEntries,
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
  numericChoiceOptionLabel,
  UNIT_KEYS,
} from '../sketch/numericInput.js';
import {
  formatVolume,
  missingValueKey,
  partErrorMessage,
  selectionKindLabelKeys,
  setSolidAxis,
  setSolidChoice,
  setSolidField,
  setSolidToggle,
  solidForSelection,
  summarizeSolid,
  WORLD_AXIS_CHOICES,
  type SolidChoiceSummary,
  type SolidFieldKey,
  type SolidFieldSummary,
} from '../solid/solidSummary.js';
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

/** 参照しているものの名前。押すとそれを選ぶ(面の境界の一覧と同じ操作、FR-311)。 */
function ReferenceButton({
  elementId,
  name,
}: {
  readonly elementId: string;
  readonly name: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="pcad-reference"
      title={t('propertyPanel.boundaryTooltip')}
      onClick={() => {
        useAppStore.getState().setSelection([elementId]);
      }}
    >
      {name}
    </button>
  );
}

/**
 * 参照の節の見出し(P3 タスク27)。もとは押し出し・回転・縫合(断面)とブーリアン
 * (組み合わせるもの)の2択だったが、加工6種の「加工するもとの立体・並べる穴」は
 * どちらにも当たらないので専用の見出し(`sectionTarget`)を足した。
 */
function referencesSectionTitleKey(feature: SolidFeature): MessageKey {
  if (feature.kind === 'boolean') {
    return 'propertyPanel.sectionCombine';
  }
  if (feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'sew') {
    return 'propertyPanel.sectionProfile';
  }
  return 'propertyPanel.sectionTarget';
}

/**
 * 選択肢が多い一覧(ねじの呼び28個)は横並びのボタンでなく畳んだ一覧にするしきい値
 * (`NumericInputPopover.tsx` の `ChoiceGroup` と同じ値・同じ理由。呼び径だけが該当し、
 * 深さの種類・系列・見せ方・決め方・向き・巻き方向・求める値はどれも4個以下で横並びのまま)。
 */
const LONG_CHOICE_OPTION_THRESHOLD = 6;

/**
 * いくつかから1つを選ぶ欄(深さの種類・ねじの呼び・面取りの決め方・パターンの向き等)。
 * 選択肢が多い(ねじの呼び28個)ときは、`NumericInputPopover.tsx` の `ChoiceGroup` と同じ
 * pcad-menu の作り(ボタン1つ+その下に開く一覧)で畳む(タスク28、§2.11「呼びの畳んだ一覧」)。
 *
 * 開閉は見た目だけの一時状態なのでここでだけ持つ(rules/04-設計の規律.md)。
 */
function ChoiceButtons({
  choice,
  onChoose,
}: {
  readonly choice: SolidChoiceSummary;
  readonly onChoose: (value: string) => void;
}): React.JSX.Element {
  const isLong = choice.options.length > LONG_CHOICE_OPTION_THRESHOLD;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const groupLabel = t(choice.labelKey);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    // 外を押したら閉じる。モーダルの覆いを作らないので、押した先の操作はそのまま通る
    // (NumericInputPopover.tsx の ChoiceGroup と同じ作り)。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  if (!isLong) {
    return (
      <div className="pcad-choice">
        <span className="pcad-choice__label">{groupLabel}</span>
        <div className="pcad-segmented pcad-choice__options" role="group" aria-label={groupLabel}>
          {choice.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="pcad-button"
              aria-pressed={choice.value === option.value}
              onClick={() => {
                onChoose(option.value);
              }}
            >
              {numericChoiceOptionLabel(option)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const selected = choice.options.find((option) => option.value === choice.value) ?? null;

  return (
    <div className="pcad-choice">
      <span className="pcad-choice__label">{groupLabel}</span>
      <div className="pcad-menu" ref={containerRef}>
        <button
          type="button"
          className="pcad-button pcad-menu__trigger"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <span className="pcad-menu__count">
            {selected === null ? '' : numericChoiceOptionLabel(selected)}
          </span>
          <ChevronRightIcon className="pcad-menu__chevron" />
        </button>
        {open ? (
          <div className="pcad-menu__panel" role="group" aria-label={groupLabel}>
            {choice.options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                className="pcad-button pcad-menu__item"
                aria-pressed={option.value === choice.value}
                onClick={() => {
                  onChoose(option.value);
                  setOpen(false);
                }}
              >
                {numericChoiceOptionLabel(option)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 打っている途中の立体の欄。式として読めるようになるまで履歴へは書き戻さない。 */
interface SolidFieldDraft {
  readonly key: SolidFieldKey;
  readonly source: string;
}

/**
 * 選ばれている立体 1 つの中身(FR-202、FR-311、FR-501)。
 *
 * 距離・角度・許容量は**入力した式そのもの**を出し、式として読めたときだけ履歴を差し替える。
 * 打っている途中は表示専用の下書きに置く(スケッチの欄と同じ作り、docs/報告記録.md 2026-09-02 23:35)。
 * 続けざまの書き換えは `coalesceKey` で Undo の 1 段にまとめる(§0.a-0.13)。
 *
 * 形が作れていない立体でも欄は編集できる。直せばそのまま作り直せるようにするため(FR-504)。
 * 体積と三角形の数は形ができたときだけ出し、出せないときは「—」ではなく理由を言葉で出す。
 */
function SolidProperties({ feature }: { readonly feature: SolidFeature }): React.JSX.Element {
  const part = useAppStore((state) => state.document);
  const bodies = useAppStore((state) => state.bodies);
  const partErrors = useAppStore((state) => state.partErrors);
  const [draft, setDraft] = useState<SolidFieldDraft | null>(null);

  const summary = summarizeSolid(part, feature, partErrors);
  const errorMessage = partErrorMessage(partErrors, feature.id);
  const body = bodies.find((candidate) => candidate.featureId === feature.id);
  const missing = t(missingValueKey(summary));

  /** 履歴を差し替える。中身が変わらないときは何もしない(無駄な再計算を起こさない)。 */
  const apply = (next: SolidFeature, coalesceKey?: string): void => {
    if (next === feature) {
      return;
    }
    const store = useAppStore.getState();
    store.applyDocument(replaceSolid(store.document, feature.id, next), { coalesceKey });
  };

  const renderField = (item: SolidFieldSummary): React.JSX.Element => {
    const source = draft !== null && draft.key === item.key ? draft.source : item.value.source;
    const evaluated = evaluateExpression(source);
    return (
      <ExpressionField
        key={item.key}
        field={{
          key: item.key,
          labelKey: item.labelKey,
          tooltipKey: item.tooltipKey,
          unit: item.unit,
          defaultSource: item.value.source,
          source,
        }}
        result={
          evaluated.ok
            ? { key: item.key, value: evaluated.value, error: null }
            : { key: item.key, value: null, error: evaluated.error }
        }
        /* 焦点の正本は利用者のクリックとタブ移動。こちらからは動かさない。 */
        focused={false}
        onFocus={() => undefined}
        onChange={(next) => {
          setDraft({ key: item.key, source: next });
          const parsed = evaluateExpression(next);
          if (!parsed.ok) {
            return;
          }
          apply(setSolidField(feature, item.key, parsed.value), `field:${feature.id}:${item.key}`);
        }}
      />
    );
  };

  /**
   * derived が指す欄(§0.a-0.30)。式は入れられないので `ExpressionField` を使わず、
   * 同じ `pcad-field` の見た目で値だけを見せる(タスク29b「ExpressionField を無効化」)。
   * `readOnly` の HTML 属性と `tabIndex=-1` で、打っても効かず Tab でも止まらないようにする。
   */
  const renderReadOnlyField = (item: SolidFieldSummary): React.JSX.Element => (
    <div className="pcad-field pcad-field--readonly" key={item.key}>
      <span className="pcad-field__label" title={t(item.tooltipKey)}>
        {t(item.labelKey)}
      </span>
      <input
        className="pcad-field__input"
        type="text"
        readOnly
        tabIndex={-1}
        aria-readonly="true"
        value={item.value.source}
        title={t(item.tooltipKey)}
      />
      <span className="pcad-field__unit">{t(UNIT_KEYS[item.unit])}</span>
      <p className="pcad-field__message">{`= ${item.value.display}`}</p>
    </div>
  );

  const axis = summary.axis;

  return (
    <>
      {errorMessage === null ? null : <p className="pcad-panel__error">{errorMessage}</p>}
      {!summary.suppressed ? null : (
        <p className="pcad-panel__note">{t('propertyPanel.suppressedNote')}</p>
      )}

      <div className="pcad-section">
        <h3 className="pcad-section__title">{t('propertyPanel.sectionSolid')}</h3>
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.selectedKinds')}</dt>
          <dd className="pcad-properties__value">{t(summary.kindLabelKey)}</dd>
        </dl>
      </div>

      {summary.fields.length === 0 &&
      summary.toggles.length === 0 &&
      summary.choices.length === 0 &&
      axis === null ? null : (
        <div className="pcad-section">
          <h3 className="pcad-section__title">{t('propertyPanel.sectionSketch')}</h3>
          {summary.fields.length === 0 ? null : (
            <div className="pcad-coordinate__fields">
              {summary.fields.map((item) => (item.readOnly ? renderReadOnlyField(item) : renderField(item)))}
            </div>
          )}
          {axis === null ? null : (
            <div className="pcad-choice">
              <span className="pcad-choice__label">{t('propertyPanel.axis')}</span>
              {axis.kind === 'line' ? (
                <span className="pcad-choice__value">{axis.name}</span>
              ) : (
                <div
                  className="pcad-segmented pcad-choice__options"
                  role="group"
                  aria-label={t('propertyPanel.axis')}
                >
                  {WORLD_AXIS_CHOICES.map((choice) => (
                    <button
                      key={choice.axis}
                      type="button"
                      className="pcad-button"
                      aria-pressed={axis.axis === choice.axis}
                      onClick={() => {
                        apply(setSolidAxis(feature, choice.axis));
                      }}
                    >
                      {t(choice.labelKey)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {summary.choices.map((choice) => (
            <ChoiceButtons
              key={choice.key}
              choice={choice}
              onChoose={(value) => {
                apply(setSolidChoice(feature, choice.key, value));
              }}
            />
          ))}
          {summary.toggles.length === 0 ? null : (
            <div className="pcad-toggles">
              {summary.toggles.map((toggle) => (
                <button
                  key={toggle.key}
                  type="button"
                  role="switch"
                  className="pcad-switch"
                  aria-checked={toggle.value}
                  onClick={() => {
                    apply(setSolidToggle(feature, toggle.key, !toggle.value));
                  }}
                >
                  <span className="pcad-switch__track" aria-hidden="true">
                    <span className="pcad-switch__thumb" />
                  </span>
                  <span>{t(toggle.labelKey)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {summary.references.length === 0 && summary.subShapeCounts.length === 0 ? null : (
        <div className="pcad-section">
          <h3 className="pcad-section__title">{t(referencesSectionTitleKey(feature))}</h3>
          <dl className="pcad-properties">
            {feature.kind !== 'boolean' ? null : (
              // 組み合わせ方(和・差・積)。種類は summarizeSolid がすでに持っている(P3 §0.a-0.23 ②)。
              <>
                <dt className="pcad-properties__key">{t('propertyPanel.operation')}</dt>
                <dd className="pcad-properties__value">{t(summary.kindLabelKey)}</dd>
              </>
            )}
            {summary.references.map((reference, index) => (
              <Fragment key={`${reference.labelKey}-${String(index)}`}>
                <dt className="pcad-properties__key">{t(reference.labelKey)}</dt>
                <dd className="pcad-properties__value">
                  {reference.elementId === null ? (
                    <span className="pcad-properties__missing" title={reference.name}>
                      {t('propertyPanel.referenceMissing')}
                    </span>
                  ) : (
                    <ReferenceButton elementId={reference.elementId} name={reference.name} />
                  )}
                </dd>
              </Fragment>
            ))}
            {/* 選んだ部分形状は数だけを出す(「選んだ辺 4」)。個々の番号は利用者に意味が無い(§0.a-0.17)。 */}
            {summary.subShapeCounts.map((entry, index) => (
              <Fragment key={`${entry.labelKey}-${String(index)}`}>
                <dt className="pcad-properties__key">{t(entry.labelKey)}</dt>
                <dd className="pcad-properties__value">{entry.count}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      <div className="pcad-section">
        <h3 className="pcad-section__title">{t('propertyPanel.sectionResult')}</h3>
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.volume')}</dt>
          <dd className="pcad-properties__value">
            {body === undefined
              ? missing
              : `${formatVolume(body.volume)} ${t('propertyPanel.unitCubicMillimeter')}`}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.triangleCount')}</dt>
          <dd className="pcad-properties__value">
            {body === undefined ? missing : String(body.mesh.triangleCount)}
          </dd>
        </dl>
      </div>
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
  const part = useAppStore((state) => state.document);
  const sketch = useAppStore((state) => state.sketch);
  const selection = useAppStore((state) => state.selection);

  const featureIds = [...new Set(selection.map((id) => featureIdOf(id)))];
  const single = featureIds.length === 1;
  const feature = single ? featureForSelection(sketch, selection) : null;
  // スケッチの要素で見つからなければ立体を探す。id は文書の中で重ならない(§0.a-0.5)。
  const solid = single && feature === null ? solidForSelection(part, selection) : null;
  const kinds = selectionKindLabelKeys(part, selection).map((key) => t(key));

  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      <div className="pcad-panel__body">
        {feature !== null ? (
          <FeatureProperties key={feature.id} feature={feature} />
        ) : solid !== null ? (
          <SolidProperties key={solid.id} feature={solid} />
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
