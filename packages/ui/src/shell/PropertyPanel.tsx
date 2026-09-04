import { Fragment, useEffect, useRef, useState } from 'react';

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import {
  findReference,
  findSolid,
  replaceReference,
  replaceSolid,
  type ReferenceFeature,
  type SketchFeature,
  type SolidFeature,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { initialDraftVersionState, reconcileDraftVersion } from './fieldDraft.js';
import { ChevronRightIcon } from './icons.js';
import {
  addSplinePoint,
  faceBoundaryEntries,
  featureForSelection,
  featureIdOf,
  RECTANGLE_VIEWS,
  removeSplinePoint,
  resolvedFields,
  setCoordinateField,
  setFeatureChoice,
  setFeatureCoordinateMode,
  setFeatureField,
  setFeatureToggle,
  summarizeFeature,
  type FeatureCoordinateSummary,
  type FeatureFieldSummary,
  type RectangleView,
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
  setReferenceCoordinate,
  setReferenceField,
  setReferenceVisible,
  setSolidAxis,
  setSolidChoice,
  setSolidField,
  setSolidToggle,
  solidForSelection,
  summarizeReference,
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
 * 相対・極で入れた点の「基準」を読める形で出す(FR-302、FR-303、FR-330、P4 タスク33)。
 * 立体の頂点を基準にしているときは「押し出し1 / 立体の頂点」のように出す
 * (タスク10 の申し送り)。基準が要素なら押してその要素を選べる。
 */
function CoordinateBaseRow({
  group,
}: {
  readonly group: FeatureCoordinateSummary;
}): React.JSX.Element | null {
  const base = group.base;
  if (base === null) {
    return null;
  }
  return (
    <p className="pcad-coordinate__base">
      <span className="pcad-coordinate__base-label">{t('propertyPanel.baseLabel')}</span>
      {base.elementId === null ? (
        <span className="pcad-coordinate__base-value">{base.text}</span>
      ) : (
        <ReferenceButton elementId={base.elementId} name={base.text} />
      )}
    </p>
  );
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
 *
 * ただし**選ぶ要素が変わらないまま文書だけが差し替わる**(焦点を残したまま開く・新規・
 * 復元・Undo/Redo をすると、開き直した文書にも同じ id のフィーチャーが残っているため
 * `key` は変わらない)ときは、この作り直しが起きず古い下書きが残ってしまう
 * (docs/報告記録.md 2026-09-04 14:05 の 9b)。`documentVersion`(文書が丸ごと
 * 差し替わった回数)を `fieldDraft.ts` の純関数で見張り、変わっていたら下書きを捨てる。
 */
function FeatureProperties({ feature }: { readonly feature: SketchFeature }): React.JSX.Element {
  const part = useAppStore((state) => state.document);
  const sketch = useAppStore((state) => state.sketch);
  const resolved = useAppStore((state) => state.resolvedSketch);
  const sketchMesh = useAppStore((state) => state.sketchMesh);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const documentVersion = useAppStore((state) => state.documentVersion);
  // 矩形の見せ方(対角 2 点 / 中心+幅+高さ)は履歴に残らない画面だけの状態
  // (rules/04-設計の規律.md「表示専用の一時状態だけ useState に置く」)。
  const [rectangleView, setRectangleView] = useState<RectangleView>('corners');
  const [draftState, setDraftState] = useState(() =>
    initialDraftVersionState<FieldDraft>(documentVersion),
  );
  // 文書が丸ごと差し替わっていたら、この描画のうちに下書きを捨てて文書の値を出す
  // (焦点は同じ DOM のまま残るので、ここで動かす必要は無い)。
  const reconciled = reconcileDraftVersion(draftState, documentVersion);
  if (reconciled !== draftState) {
    setDraftState(reconciled);
  }
  const draft = reconciled.draft;

  const summary = summarizeFeature(feature, sketchErrors, {
    document: sketch,
    // 立体の名前は部品文書にしかないので、ここで引いて渡す(頂点参照の「押し出し1 / 立体の頂点」)。
    bodyName: (featureId) => findSolid(part, featureId)?.name ?? null,
    rectangleView,
  });
  const computed = resolvedFields(feature, resolved, sketchMesh);

  /** 履歴を差し替える。中身が変わらないときは何もしない(無駄な再計算を起こさない)。 */
  const apply = (next: SketchFeature): void => {
    if (next !== feature) {
      useAppStore.getState().replaceSketchFeature(feature.id, next);
    }
  };

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
          setDraftState({ draft: { path: item.path, source: next }, seenVersion: documentVersion });
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

      {summary.coordinates.length === 0 &&
      summary.scalars.length === 0 &&
      summary.toggles.length === 0 &&
      summary.choices.length === 0 ? null : (
        <div className="pcad-section">
          <h3 className="pcad-section__title">{t('propertyPanel.sectionSketch')}</h3>
          {/*
            矩形の見せ方(対角 2 点 / 中心+幅+高さ)の切替は履歴を変えないので、
            他の選択肢より先に、欄の並びの上へ出す(何の欄を見ているかが先に分かる)。
          */}
          {summary.choices
            .filter((choice) => choice.key === 'rectangleMode')
            .map((choice) => (
              <div className="pcad-choice" key={choice.key}>
                <span className="pcad-choice__label">{t(choice.labelKey)}</span>
                <div
                  className="pcad-segmented pcad-choice__options"
                  role="group"
                  aria-label={t(choice.labelKey)}
                >
                  {RECTANGLE_VIEWS.map((view) => {
                    const option = choice.options.find((candidate) => candidate.value === view);
                    return option === undefined ? null : (
                      <button
                        key={view}
                        type="button"
                        className="pcad-button"
                        aria-pressed={choice.value === view}
                        onClick={() => {
                          setRectangleView(view);
                        }}
                      >
                        {t(option.labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          {summary.coordinates.map((group, index) => (
            <div className="pcad-coordinate" key={group.path}>
              <h4 className="pcad-coordinate__title">
                {group.ordinal === null
                  ? t(group.labelKey)
                  : `${t(group.labelKey)} ${String(group.ordinal)}`}
                {/* スプラインの点は 1 つずつ足せる・消せる(FR-317)。 */}
                {group.path.startsWith('points.') ? (
                  <span className="pcad-coordinate__actions">
                    <button
                      type="button"
                      className="pcad-button pcad-coordinate__action"
                      title={t('propertyPanel.addPointTooltip')}
                      aria-label={t('propertyPanel.addPointTooltip')}
                      onClick={() => {
                        apply(addSplinePoint(feature, index));
                      }}
                    >
                      {t('propertyPanel.addPointMark')}
                    </button>
                    <button
                      type="button"
                      className="pcad-button pcad-coordinate__action"
                      title={t('propertyPanel.removePointTooltip')}
                      aria-label={t('propertyPanel.removePointTooltip')}
                      disabled={!group.removable}
                      onClick={() => {
                        apply(removeSplinePoint(feature, index));
                      }}
                    >
                      {t('propertyPanel.removePointMark')}
                    </button>
                  </span>
                ) : null}
              </h4>
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
              <CoordinateBaseRow group={group} />
              <div className="pcad-coordinate__fields">{group.fields.map(renderField)}</div>
            </div>
          ))}
          {summary.scalars.length === 0 ? null : (
            <div className="pcad-coordinate__fields">{summary.scalars.map(renderField)}</div>
          )}
          {summary.choices
            .filter((choice) => choice.key !== 'rectangleMode')
            .map((choice) => (
              <div className="pcad-choice" key={choice.key}>
                <span className="pcad-choice__label">{t(choice.labelKey)}</span>
                <div
                  className="pcad-segmented pcad-choice__options"
                  role="group"
                  aria-label={t(choice.labelKey)}
                >
                  {choice.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="pcad-button"
                      aria-pressed={choice.value === option.value}
                      onClick={() => {
                        apply(setFeatureChoice(feature, choice.key, option.value));
                      }}
                    >
                      {t(option.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
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
                    apply(setFeatureToggle(feature, toggle.key, !toggle.value));
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

      {summary.references.length === 0 ? null : (
        <div className="pcad-section">
          <h3 className="pcad-section__title">{t('propertyPanel.sectionTarget')}</h3>
          <dl className="pcad-properties">
            {summary.references.map((reference, index) => (
              <Fragment key={`${reference.labelKey}-${String(index)}`}>
                <dt className="pcad-properties__key">{t(reference.labelKey)}</dt>
                <dd className="pcad-properties__value">
                  {reference.elementId === null ? (
                    <span className="pcad-properties__missing" title={reference.name}>
                      {reference.name}
                    </span>
                  ) : (
                    <ReferenceButton elementId={reference.elementId} name={reference.name} />
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>
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
 *
 * 下書きが**選ぶ要素が変わらないまま文書だけ差し替わった**ときに残ってしまう不具合
 * (docs/報告記録.md 2026-09-04 14:05 の 9b)への対処は `FeatureProperties` と同じ
 * (`fieldDraft.ts` の `documentVersion` の見張り)。
 */
function SolidProperties({ feature }: { readonly feature: SolidFeature }): React.JSX.Element {
  const part = useAppStore((state) => state.document);
  const bodies = useAppStore((state) => state.bodies);
  const partErrors = useAppStore((state) => state.partErrors);
  const documentVersion = useAppStore((state) => state.documentVersion);
  const [draftState, setDraftState] = useState(() =>
    initialDraftVersionState<SolidFieldDraft>(documentVersion),
  );
  const reconciled = reconcileDraftVersion(draftState, documentVersion);
  if (reconciled !== draftState) {
    setDraftState(reconciled);
  }
  const draft = reconciled.draft;

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
          setDraftState({ draft: { key: item.key, source: next }, seenVersion: documentVersion });
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

/** 打っている途中の基準ジオメトリの欄。 */
interface ReferenceFieldDraft {
  readonly key: string;
  readonly source: string;
}

/**
 * 選ばれている基準ジオメトリ 1 つの中身(FR-328、FR-329、FR-503、P4 タスク33)。
 *
 * 決め方(3 点・辺・面の法線など)は作ったときに決まるので読み取り専用で出し、
 * 式で決まる欄(平面のオフセット・傾き・角度)と、座標で置いた基準点の位置だけを直せる。
 * 名前を変えるのはツリーの ⋮ から(立体と同じ流儀)。
 */
function ReferenceProperties({
  feature,
}: {
  readonly feature: ReferenceFeature;
}): React.JSX.Element {
  const part = useAppStore((state) => state.document);
  const resolvedReferences = useAppStore((state) => state.resolvedReferences);
  const documentVersion = useAppStore((state) => state.documentVersion);
  const [draftState, setDraftState] = useState(() =>
    initialDraftVersionState<ReferenceFieldDraft>(documentVersion),
  );
  const reconciled = reconcileDraftVersion(draftState, documentVersion);
  if (reconciled !== draftState) {
    setDraftState(reconciled);
  }
  const draft = reconciled.draft;

  const summary = summarizeReference(feature, resolvedReferences.errors);

  const apply = (next: ReferenceFeature): void => {
    if (next === feature) {
      return;
    }
    const store = useAppStore.getState();
    store.applyDocument(replaceReference(store.document, feature.id, next));
  };

  /** 式の 1 欄。打っている途中は下書きに置き、読めたときだけ履歴を差し替える(FR-202)。 */
  const renderExpression = (
    key: string,
    labelKey: MessageKey,
    unit: 'mm' | 'degree' | 'count',
    value: { readonly source: string },
    write: (parsed: ExpressionValue) => void,
  ): React.JSX.Element => {
    const source = draft !== null && draft.key === key ? draft.source : value.source;
    const evaluated = evaluateExpression(source);
    return (
      <ExpressionField
        key={key}
        field={{
          key,
          labelKey,
          tooltipKey: labelKey,
          unit,
          defaultSource: value.source,
          source,
        }}
        result={
          evaluated.ok
            ? { key, value: evaluated.value, error: null }
            : { key, value: null, error: evaluated.error }
        }
        focused={false}
        onFocus={() => undefined}
        onChange={(next) => {
          setDraftState({ draft: { key, source: next }, seenVersion: documentVersion });
          const parsed = evaluateExpression(next);
          if (parsed.ok) {
            write(parsed.value);
          }
        }}
      />
    );
  };

  const coordinate = summary.coordinate;

  return (
    <>
      {summary.errorMessage === null ? null : (
        <p className="pcad-panel__error">{summary.errorMessage}</p>
      )}

      <div className="pcad-section">
        <h3 className="pcad-section__title">{t('propertyPanel.sectionReference')}</h3>
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.selectedKinds')}</dt>
          <dd className="pcad-properties__value">{t(summary.kindLabelKey)}</dd>
          <dt className="pcad-properties__key">{t('propertyPanel.referenceDefinition')}</dt>
          <dd className="pcad-properties__value">{t(summary.definitionLabelKey)}</dd>
        </dl>
        {summary.fields.length === 0 ? null : (
          <div className="pcad-coordinate__fields">
            {summary.fields.map((item) =>
              renderExpression(item.key, item.labelKey, item.unit, item.value, (parsed) => {
                apply(setReferenceField(feature, item.key, parsed));
              }),
            )}
          </div>
        )}
        {coordinate === null ? null : (
          <div className="pcad-coordinate">
            <h4 className="pcad-coordinate__title">{t(coordinate.labelKey)}</h4>
            <div className="pcad-coordinate__fields">
              {coordinate.fields.map((item) =>
                renderExpression(item.path, item.labelKey, item.unit, item.value, (parsed) => {
                  const current = findReference(part, feature.id);
                  if (current === undefined || current.kind !== 'referencePoint') {
                    return;
                  }
                  if (current.definition.kind !== 'coordinate') {
                    return;
                  }
                  const nextAt = setCoordinateField(
                    current.definition.at,
                    item.path.slice(item.path.lastIndexOf('.') + 1),
                    parsed,
                  );
                  apply(setReferenceCoordinate(current, nextAt));
                }),
              )}
            </div>
          </div>
        )}
        <div className="pcad-toggles">
          <button
            type="button"
            role="switch"
            className="pcad-switch"
            aria-checked={summary.visible}
            onClick={() => {
              apply(setReferenceVisible(feature, !summary.visible));
            }}
          >
            <span className="pcad-switch__track" aria-hidden="true">
              <span className="pcad-switch__thumb" />
            </span>
            <span>{t('propertyPanel.referenceVisible')}</span>
          </button>
        </div>
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
  // スケッチの要素で見つからなければ立体、それも無ければ基準ジオメトリを探す。
  // id は文書の中で重ならない(§0.a-0.5)。
  const solid = single && feature === null ? solidForSelection(part, selection) : null;
  const reference =
    single && feature === null && solid === null && selection[0] !== undefined
      ? (findReference(part, selection[0]) ?? null)
      : null;
  const kinds = selectionKindLabelKeys(part, selection).map((key) => t(key));

  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      <div className="pcad-panel__body">
        {feature !== null ? (
          <FeatureProperties key={feature.id} feature={feature} />
        ) : solid !== null ? (
          <SolidProperties key={solid.id} feature={solid} />
        ) : reference !== null ? (
          <ReferenceProperties key={reference.id} feature={reference} />
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
