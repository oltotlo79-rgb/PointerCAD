import { Fragment, useEffect, useRef, useState } from 'react';

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import {
  baseWorkPlane,
  findReference,
  findSolid,
  replaceReference,
  replaceSolid,
  resolveSketch,
  type ReferenceFeature,
  type SketchFeature,
  type SolidFeature,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { ParameterPanel } from '../parameters/ParameterPanel.js';
import { ConstraintList } from '../sketch/ConstraintList.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { initialDraftVersionState, reconcileDraftVersion } from './fieldDraft.js';
import { ChevronRightIcon } from './icons.js';
import { isFeatureAheadOfTimeline } from './timelineRail.js';
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
  withSolvedCoordinates,
  type FeatureCoordinateSummary,
  type FeatureFieldSummary,
  type RectangleView,
} from '../sketch/featureSummary.js';
import { originChangeFor, originPickFor, type OriginPick } from '../sketch/originCommands.js';
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
  // パラメータ表の変数表(FR-207、FR-201)。`板厚 * 2` のような式をここでも読めるようにする。
  // その場入力・コマンドラインの欄と**同じ表**を渡す(タスク18 の申し送り)。
  const variables = useAppStore((state) => state.parameterAnalysis.variables);
  // 拘束の診断(FR-313)。null なら拘束を 1 つも持たないスケッチ(タスク22b-(g))。
  const constraintDiagnosis = useAppStore((state) => state.constraintDiagnosis);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  const workPlane = useAppStore((state) => state.workPlane);
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

  const baseSummary = summarizeFeature(feature, sketchErrors, {
    document: sketch,
    // 立体の名前は部品文書にしかないので、ここで引いて渡す(頂点参照の「押し出し1 / 立体の頂点」)。
    bodyName: (featureId) => findSolid(part, featureId)?.name ?? null,
    rectangleView,
  });
  /*
    拘束で決まった、いまの位置を欄の下へ添える(FR-313、P4b タスク22b-(g))。
    解いた座標は文書に書かない(rules/04「導出できるものは保存しない」)ので、上の欄には
    保存された式しか出ない。形が動いたのに数字が変わらないと読めてしまうため、
    **保存された式だけで解いた形**と**いま描いている形**を突き合わせ、動いた欄にだけ
    1 行を足す(NFR-UX-7)。突き合わせのための解決は**拘束を持つスケッチのときだけ**
    行う(拘束を使わない文書では 1 回も増やさない。NFR-PF-1)。
  */
  const summary =
    constraintDiagnosis === null
      ? baseSummary
      : withSolvedCoordinates(
          baseSummary,
          feature,
          resolveSketch(sketch, {
            // 作図面の解き方はストアの控えと同じにそろえる(同じ規則を 2 か所に書かない)。
            workPlane: (planeId) => (planeId === workPlaneId ? workPlane : baseWorkPlane(planeId)),
          }),
          resolved,
        );
  const computed = resolvedFields(feature, resolved, sketchMesh);

  /** 履歴を差し替える。中身が変わらないときは何もしない(無駄な再計算を起こさない)。 */
  const apply = (next: SketchFeature): void => {
    if (next !== feature) {
      useAppStore.getState().replaceSketchFeature(feature.id, next);
    }
  };

  const renderField = (item: FeatureFieldSummary): React.JSX.Element => {
    const source = draft !== null && draft.path === item.path ? draft.source : item.value.source;
    const evaluated = evaluateExpression(source, { variables });
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
          const parsed = evaluateExpression(next, { variables });
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
              {/* 拘束で決まった、いまの位置(FR-313、タスク22b-(g))。動いた欄だけ出る。 */}
              {group.solvedText === null ? null : (
                <p className="pcad-coordinate__solved" title={t('propertyPanel.solvedTooltip')}>
                  {group.solvedText}
                </p>
              )}
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
  // パラメータ表の変数表(FR-207)。押し出しの距離に `板厚 * 2` と書けるようにする。
  const variables = useAppStore((state) => state.parameterAnalysis.variables);
  // タイムラインのつまみ(FR-507)。つまみより後ろの段はまだ作られていないだけで、
  // 失敗ではない(P4b タスク22a-(2)、docs/報告記録.md 2026-09-05 実時計 01:05 の申し送り①)。
  const timelineIndex = useAppStore((state) => state.timelineIndex);
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
  const isAhead = isFeatureAheadOfTimeline(part, timelineIndex, feature.id);
  // つまみより後ろの段は、失敗(赤)と見た目を分けて「まだ作られていません」にする
  // (rules/04-設計の規律.md「止めずに警告する」。赤は使わない)。
  const missing = isAhead ? t('propertyPanel.notYetCreated') : t(missingValueKey(summary));

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
    const evaluated = evaluateExpression(source, { variables });
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
          const parsed = evaluateExpression(next, { variables });
          if (!parsed.ok) {
            return;
          }
          apply(
            setSolidField(feature, item.key, parsed.value, variables),
            `field:${feature.id}:${item.key}`,
          );
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
                apply(setSolidChoice(feature, choice.key, value, variables));
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
  // パラメータ表の変数表(FR-207)。作業平面のオフセットにも名前で書けるようにする。
  const variables = useAppStore((state) => state.parameterAnalysis.variables);
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
    const evaluated = evaluateExpression(source, { variables });
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
          const parsed = evaluateExpression(next, { variables });
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

/** 原点にできる 1 点が選ばれているときの、その要素 id と指し方。 */
interface OriginSelection {
  readonly elementId: string;
  readonly pick: OriginPick;
}

/**
 * いま選ばれているものが「原点にできる 1 点」かを見る(FR-331、P4 タスク35b)。
 *
 * 立体の頂点は木に行が無いのでプロパティが唯一の入り口になる。頂点を選ぶと
 * `solidForSelection` は何も返さない(要素 id が `押し出し1#vertex:3` の形で立体の id と
 * 一致しない)ので、その場合は「選択されているものはありません。」の代わりにこの節だけを出す。
 */
function useOriginSelection(): OriginSelection | null {
  const part = useAppStore((state) => state.document);
  const sketch = useAppStore((state) => state.sketch);
  const resolvedSketch = useAppStore((state) => state.resolvedSketch);
  const resolvedReferences = useAppStore((state) => state.resolvedReferences);
  const bodies = useAppStore((state) => state.bodies);
  const selection = useAppStore((state) => state.selection);

  const elementId = selection.length === 1 ? selection[0] : undefined;
  if (elementId === undefined) {
    return null;
  }
  const pick = originPickFor({
    document: part,
    sketch,
    resolvedSketch,
    resolvedReferences,
    bodies,
    elementId,
  });
  return pick === null ? null : { elementId, pick };
}

/**
 * 「ここを原点にする」のボタン(FR-331、P4 タスク35b)。
 *
 * 押すと、その点が (0, 0, 0) になるよう文書内の絶対座標が**式のまま**平行移動し、ほかの
 * 要素は式のまま追従する。ツールバーには道具を増やさない決まりなので、入り口はここと
 * モデルブラウザの「⋮」一覧の 2 つ(§0.a-0.25 ③)。頂点は式を持たないため、丸めない
 * 倍精度の数値で移す(FR-331)。
 *
 * 何が選ばれているか(欄の中身)とは別の話なので、上の欄と並ばず独立した節にする。
 */
function OriginSection({ origin }: { readonly origin: OriginSelection }): React.JSX.Element {
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('originCommand.sectionTitle')}</h3>
      <button
        type="button"
        className="pcad-button pcad-button--action"
        title={t('originCommand.tooltip')}
        onClick={() => {
          const store = useAppStore.getState();
          const change = originChangeFor(store, origin.elementId);
          if (change === null) {
            // 位置が計算できていない点は断って何も変えない(FR-504、NFR-RE-1)。
            store.setEditError('originCommand.failed');
            return;
          }
          // 式を書き換えるだけなので履歴に段は増えず、Undo 1 回で戻る(利用者の決定)。
          store.applyDocument(change.document);
          store.setOriginNotice(change.notice);
        }}
      >
        {t(origin.pick.labelKey)}
      </button>
    </div>
  );
}

/** 右の区画のタブ(§0.a-0.15)。区画は 5 つのままで、この 2 枚だけを切り替える。 */
type PanelTab = 'properties' | 'parameters';

/**
 * 右のプロパティパネル(要件§7.1、FR-202、FR-310、FR-311、FR-207)。
 *
 * 1 つだけ選ばれているときは中身を出して式のまま直せるようにし、いくつも選ばれているときは
 * 数と種類だけを出す(面を張るときは順に選んでいくので、そのたびに欄が入れ替わらないように)。
 * 節ごとに「鍵(補助色)と値(等幅の数字)」の2列で並べる形は P0 から変えない。
 *
 * P4b から「プロパティ」「パラメータ」の 2 タブを持つ(§0.a-0.15、FR-207)。
 * **区画は増やさない**(rules/04-設計の規律.md)。どちらを開いているかは履歴に残らない
 * 画面だけの状態なので `useState` に置く(同上「表示専用の一時状態だけ」)。
 */
export function PropertyPanel(): React.JSX.Element {
  const [tab, setTab] = useState<PanelTab>('properties');
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
  // 「ここを原点にする」を出せる 1 点(FR-331、タスク35b)。立体の頂点はここだけに出る。
  const origin = useOriginSelection();

  return (
    <section className="pcad-panel pcad-panel--right">
      <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
      <div className="pcad-panel__tabs" role="tablist" aria-label={t('propertyPanel.tabsLabel')}>
        <button
          type="button"
          role="tab"
          className="pcad-tab"
          aria-selected={tab === 'properties'}
          aria-pressed={tab === 'properties'}
          onClick={() => {
            setTab('properties');
          }}
        >
          {t('propertyPanel.tabProperties')}
        </button>
        <button
          type="button"
          role="tab"
          className="pcad-tab"
          aria-selected={tab === 'parameters'}
          aria-pressed={tab === 'parameters'}
          onClick={() => {
            setTab('parameters');
          }}
        >
          {t('propertyPanel.tabParameters')}
        </button>
      </div>
      {tab === 'parameters' ? (
        <div className="pcad-panel__body">
          <ParameterPanel />
        </div>
      ) : (
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
        ) : origin !== null ? null : (
          /* 立体の頂点だけを選んでいるときは「原点」の節が出るので、空の案内は出さない。 */
          <div className="pcad-panel__empty">
            <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p>
          </div>
        )}
        {/* 点を 1 つだけ選んでいるときの「ここを原点にする」(FR-331、タスク35b)。 */}
        {origin === null ? null : <OriginSection origin={origin} />}
        {/*
          拘束の一覧(FR-313、P4b タスク13)。**区画もタブも増やさない**(rules/04)。
          いま編集しているスケッチの拘束をここへ並べ、行を押すと 3D の印が光り、
          寸法拘束は値をその場で書き換えられる。拘束が 1 つも無ければ何も出ない。
        */}
        <ConstraintList />
      </div>
      )}
    </section>
  );
}
