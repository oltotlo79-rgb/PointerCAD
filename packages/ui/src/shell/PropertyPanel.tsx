import { Fragment, useEffect, useRef, useState } from 'react';

import {
  evaluateExpression,
  expressionValueFromNumber,
  type ExpressionValue,
} from '@pointercad/expression';
import {
  appearanceOf,
  baseWorkPlane,
  findReference,
  findSolid,
  isSameAppearanceTarget,
  MATERIAL_PRESETS,
  replaceReference,
  replaceSolid,
  resolveSketch,
  WOOD_SPECIES,
  type AppearancePattern,
  type AppearancePresetId,
  type AppearanceSpec,
  type ReferenceFeature,
  type SketchFeature,
  type SolidFeature,
  type WoodSpecies,
} from '@pointercad/model';

import {
  appearanceOfSelection,
  appearanceReadiness,
  appearanceTargetsOf,
  appearanceWithColor,
  appearanceWithNumber,
  appearanceWithPattern,
  appearanceWithPreset,
  appearanceWithWoodSpecies,
  isSameAppearanceSpec,
  missingAppearanceIds,
  type AppearanceContext,
  type AppearanceNumberField,
} from '../appearance/appearanceCommands.js';
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
  rangeErrorFor,
  UNIT_KEYS,
  type NumericField,
  type NumericFieldRange,
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
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
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
 * 「拘束で決まった、いまの位置」の**表示だけ**を有効数字 9 桁へ丸める桁数
 * (利用者の決定、docs/報告記録.md 2026-09-05 10:43「保存値・入力欄・他の『= 値』の
 * 桁は変えない」。P4b タスク23b-1)。保存値(履歴)には一切使わない。
 */
const SOLVED_COORDINATE_DISPLAY_DIGITS = 9;

/**
 * 数値 1 つを有効数字 `digits` 桁へ丸める(末尾の 0 は落ちる。`String()` の癖どおり)。
 * `0` と有限でない値はそのまま返す(`log10(0)` が `-Infinity` になるのを避ける)。
 */
function roundToSignificantDigits(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) {
    return value;
  }
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, digits - 1 - magnitude);
  return Math.round(value * factor) / factor;
}

/**
 * `solvedCoordinateText`(`../sketch/featureSummary.js`)が作る
 * 「= (x, y, z)(拘束で決まった値)」の 3 つの数だけを有効数字 9 桁へ丸め直す
 * (P4b タスク23b-1、利用者の決定「解の表示は 9 桁で丸める」)。
 *
 * 丸めるのは**この行の表示だけ**。座標の保存値・入力欄・他の「= 値」の行(スカラーの
 * 読み取り専用の欄など)はここを通らないので変わらない。`solvedCoordinateText` 自体は
 * 変更しない(このタスクで触れるのは `PropertyPanel.tsx` の (g) の表示だけ)。
 *
 * 接頭辞・区切り・接尾辞は `ja.json` の `propertyPanel.solved*` を `t()` で読むので、
 * 文言が変わってもここを直す必要はない。想定と違う形(区切りの数が合わない等)が来たら
 * 丸めずに元の文字列をそのまま返す(壊れた文字列を作らない、NFR-RE-1 と同じ考え方)。
 */
export function roundSolvedCoordinateText(text: string): string {
  const prefix = t('propertyPanel.solvedPrefix');
  const separator = t('propertyPanel.solvedSeparator');
  const suffix = t('propertyPanel.solvedSuffix');
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
    return text;
  }
  const inner = text.slice(prefix.length, text.length - suffix.length);
  const values = inner.split(separator).map((part) => Number(part));
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    return text;
  }
  const rounded = values.map((value) =>
    String(roundToSignificantDigits(value, SOLVED_COORDINATE_DISPLAY_DIGITS)),
  );
  return `${prefix}${rounded.join(separator)}${suffix}`;
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
              {/*
                拘束で決まった、いまの位置(FR-313、タスク22b-(g))。動いた欄だけ出る。
                数字だけ表示用に有効数字 9 桁へ丸める(タスク23b-1、保存値は丸めない)。
              */}
              {group.solvedText === null ? null : (
                <p className="pcad-coordinate__solved" title={t('propertyPanel.solvedTooltip')}>
                  {roundSolvedCoordinateText(group.solvedText)}
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

/* ---------------------------------------------------------------------------
 * 外観(FR-1106〜1110、要件§4.12、計画書 P5 タスク12)
 * ------------------------------------------------------------------------- */

/** 材質プリセットの見出し(§2.4.1、11 種)。id → ja.json のキーの対応はここ 1 か所に置く。 */
const PRESET_LABEL_KEYS: Readonly<Record<AppearancePresetId, MessageKey>> = {
  default: 'appearance.preset.default',
  steel: 'appearance.preset.steel',
  checkerPlate: 'appearance.preset.checkerPlate',
  expandedMetal: 'appearance.preset.expandedMetal',
  aluminum: 'appearance.preset.aluminum',
  stainless: 'appearance.preset.stainless',
  plastic: 'appearance.preset.plastic',
  wood: 'appearance.preset.wood',
  mirror: 'appearance.preset.mirror',
  glass: 'appearance.preset.glass',
  custom: 'appearance.preset.custom',
};

/** 木材の樹種の見出し(§0.a-0.5、6 種)。 */
const WOOD_LABEL_KEYS: Readonly<Record<WoodSpecies, MessageKey>> = {
  hinoki: 'appearance.wood.hinoki',
  sugi: 'appearance.wood.sugi',
  oak: 'appearance.wood.oak',
  walnut: 'appearance.wood.walnut',
  teak: 'appearance.wood.teak',
  maple: 'appearance.wood.maple',
};

/** 柄の種類の見出し(FR-1108、4 種)。 */
const PATTERN_LABEL_KEYS: Readonly<Record<AppearancePattern['kind'], MessageKey>> = {
  none: 'appearance.pattern.none',
  expandedMetal: 'appearance.pattern.expandedMetal',
  checkerPlate: 'appearance.pattern.checkerPlate',
  woodGrain: 'appearance.pattern.woodGrain',
};

/** 柄の選択肢の並び順(FR-1108)。 */
const PATTERN_KINDS: readonly AppearancePattern['kind'][] = [
  'none',
  'expandedMetal',
  'checkerPlate',
  'woodGrain',
];

/**
 * 柄を「なし」から選んだときの、繰り返しの間隔の既定値(mm)。プリセット経由
 * (model の `appearanceFromPreset`)は柄ごとに違う既定値を使うが、ここは柄だけを直に
 * 選んだときの初期値なので 1 つでよい(選んだ直後に打ち直せる。NFR-UX-4)。
 */
const DEFAULT_PATTERN_SPACING_MM = 10;

/** 柄を「なし」から木目へ選んだときの、樹種の既定値(§0.a-0.5 の表の先頭)。 */
const DEFAULT_WOOD_SPECIES_FOR_PATTERN: WoodSpecies = 'hinoki';

/**
 * 柄の種類だけを差し替える(FR-1108)。間隔・樹種は引き継ぎ、無ければ既定値を補う。
 * 色・光沢・粗さ・プリセットの扱いは呼び出し側(`appearanceWithPattern`)に任せる。
 */
function patternWithKind(
  current: AppearancePattern,
  kind: AppearancePattern['kind'],
): AppearancePattern {
  if (current.kind === kind) {
    return current;
  }
  if (kind === 'none') {
    return { kind: 'none' };
  }
  const spacing =
    current.kind === 'none'
      ? expressionValueFromNumber(DEFAULT_PATTERN_SPACING_MM)
      : current.spacing;
  if (kind === 'woodGrain') {
    return {
      kind: 'woodGrain',
      spacing,
      species: current.kind === 'woodGrain' ? current.species : DEFAULT_WOOD_SPECIES_FOR_PATTERN,
    };
  }
  return { kind, spacing };
}

/** 柄の間隔だけを差し替える(FR-1108)。「なし」には間隔が無いのでそのまま返す。 */
function patternWithSpacing(pattern: AppearancePattern, spacing: ExpressionValue): AppearancePattern {
  switch (pattern.kind) {
    case 'none':
      return pattern;
    case 'expandedMetal':
    case 'checkerPlate':
    case 'woodGrain':
      return { ...pattern, spacing };
  }
}

/** 16進として読めるか(`#rrggbb`)。大文字で打っても小文字にそろえる(FR-1109)。 */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function normalizeHexColor(source: string): string | null {
  const trimmed = source.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** 透過率・光沢・粗さの範囲(0〜100、FR-1109)。`rangeErrorFor` に渡す形だけ揃える。 */
const PERCENT_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: 100,
  maxInclusive: true,
};

/** 透過率・光沢・粗さの見出しキー(タスク6の表)。 */
const PERCENT_FIELD_LABEL_KEYS: Readonly<Record<AppearanceNumberField, MessageKey>> = {
  transmission: 'propertyPanel.appearanceTransmission',
  gloss: 'propertyPanel.appearanceGloss',
  roughness: 'propertyPanel.appearanceRoughness',
};

/**
 * 百分率の記号。ASCII の文字なので ja.json へ分けない(i18n.test.ts が禁じるのは日本語の
 * 直書きだけ)。`numericInput.ts` の `FieldUnit` に「%」を増やすのはここだけのために
 * 割に合わないので、`ExpressionField` は使わず自前で組み立てる(範囲判定だけ
 * `rangeErrorFor` を借りる、下の `renderPercentField` の注釈)。
 */
const PERCENT_SIGN = '%';

/** 打っている途中の外観の欄。式として読めて範囲にも収まるまで確定しない。 */
interface AppearanceFieldDraft {
  readonly key: 'color' | AppearanceNumberField | 'spacing';
  readonly source: string;
}

/**
 * いくつかから 1 つを選ぶ、畳んだ一覧(材質プリセット・樹種。`Toolbar.tsx` の `PlaneMenu`
 * と同じ作り、`ChoiceButtons` の長い一覧の分岐と同じ見た目)。値と選択肢は文字列 1 つずつ
 * なので、`SolidChoiceSummary` を要る `ChoiceButtons` とは別に置く(数値の書式が要らない
 * ぶん単純)。開閉は見た目だけの一時状態(rules/04-設計の規律.md)。
 */
function AppearanceMenu({
  groupLabelKey,
  value,
  options,
  onChoose,
}: {
  readonly groupLabelKey: MessageKey;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly labelKey: MessageKey }[];
  readonly onChoose: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const groupLabel = t(groupLabelKey);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    // 外を押したら閉じる。モーダルの覆いを作らないので、押した先の操作はそのまま通る。
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

  const selected = options.find((option) => option.value === value) ?? null;

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
          <span className="pcad-menu__count">{selected === null ? '' : t(selected.labelKey)}</span>
          <ChevronRightIcon className="pcad-menu__chevron" />
        </button>
        {open ? (
          <div className="pcad-menu__panel" role="group" aria-label={groupLabel}>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                className="pcad-button pcad-menu__item"
                aria-pressed={option.value === value}
                onClick={() => {
                  onChoose(option.value);
                  setOpen(false);
                }}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 外観の節(FR-1106〜1110、要件§4.12、計画書タスク12)。立体または面を選んでいるときだけ
 * 描く(呼び出し側の `PropertyPanel` が `appearanceReadiness` で判定済み。§0.a-0.13
 * 「専用パネル/ダイアログは作らず、プロパティの節+ツールバーのボタン1つ」)。
 *
 * 確定は `useAppStore.getState().assignAppearance` を呼ぶだけにし、選択から割り当て先を
 * 決める判断・範囲外(NFR-UX-5)・上限(§0.a-0.11)の判定は
 * `appearance/appearanceCommands.ts`(タスク11)に任せて、ここで二重に作らない。
 * ただし透過率・光沢・粗さは打っている途中に赤くしたい(NFR-UX-5「実行してから
 * 失敗させない」)ので、確定する前に `numericInput.ts` の `rangeErrorFor` で
 * 範囲外を確かめる(コマンド側の断りは、欄を経ない入口からの保険として残る)。
 *
 * 選ぶ対象が変わるたびに `key`(呼び出し側が選択から作る文字列)で作り直され、
 * 打っている途中の下書きも消える(`FeatureProperties`/`SolidProperties` と同じ流儀)。
 */
function AppearanceSection({
  context,
}: {
  readonly context: AppearanceContext;
}): React.JSX.Element | null {
  const documentVersion = useAppStore((state) => state.documentVersion);
  const variables = useAppStore((state) => state.parameterAnalysis.variables);
  const [draftState, setDraftState] = useState(() =>
    initialDraftVersionState<AppearanceFieldDraft>(documentVersion),
  );
  const reconciled = reconcileDraftVersion(draftState, documentVersion);
  if (reconciled !== draftState) {
    setDraftState(reconciled);
  }
  const draft = reconciled.draft;

  const targets = appearanceTargetsOf(context);
  if (targets.length === 0) {
    return null;
  }
  const spec = appearanceOfSelection(context);
  const table = appearanceOf(context.document);
  const directEntry = table.entries.find((entry) =>
    isSameAppearanceTarget(entry.target, targets[0]),
  );
  const missingIds = missingAppearanceIds(context.document, context.matches);
  const missingEntries = table.entries.filter((entry) => missingIds.includes(entry.id));

  /** 外観を確定する。中身が変わらないときは何もしない(無駄な Undo の段を積まない)。 */
  const apply = (next: AppearanceSpec): void => {
    if (isSameAppearanceSpec(next, spec)) {
      return;
    }
    useAppStore.getState().assignAppearance(next);
  };

  const renderHexField = (): React.JSX.Element => {
    const source = draft !== null && draft.key === 'color' ? draft.source : spec.color;
    const hasError = normalizeHexColor(source) === null;
    return (
      <div className={hasError ? 'pcad-field pcad-field--error' : 'pcad-field'}>
        <span className="pcad-field__label" title={t('propertyPanel.appearanceColor')}>
          {t('propertyPanel.appearanceColor')}
        </span>
        <input
          className="pcad-field__input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={source}
          aria-invalid={hasError}
          title={t('propertyPanel.appearanceColor')}
          onChange={(event) => {
            const next = event.target.value;
            setDraftState({ draft: { key: 'color', source: next }, seenVersion: documentVersion });
            const normalized = normalizeHexColor(next);
            if (normalized !== null) {
              apply(appearanceWithColor(spec, normalized));
            }
          }}
        />
        <span className="pcad-field__unit" />
        <p className="pcad-field__message" />
      </div>
    );
  };

  /** 透過率・光沢・粗さの 1 欄(百分率、FR-1109)。単位は「%」を直に置く(上の注釈)。 */
  const renderPercentField = (field: AppearanceNumberField): React.JSX.Element => {
    const value = spec[field];
    const source = draft !== null && draft.key === field ? draft.source : value.source;
    const evaluated = evaluateExpression(source, { variables });
    const numericField: NumericField = {
      key: field,
      labelKey: PERCENT_FIELD_LABEL_KEYS[field],
      tooltipKey: PERCENT_FIELD_LABEL_KEYS[field],
      // 表示には使わない(単位は「%」を直に置く)。範囲判定にだけ使う仮値。
      unit: 'count',
      defaultSource: value.source,
      source,
      range: PERCENT_RANGE,
    };
    const fieldError = evaluated.ok ? rangeErrorFor(numericField, evaluated.value) : evaluated.error;
    const hasError = fieldError !== null;
    return (
      <div className={hasError ? 'pcad-field pcad-field--error' : 'pcad-field'} key={field}>
        <span className="pcad-field__label" title={t(PERCENT_FIELD_LABEL_KEYS[field])}>
          {t(PERCENT_FIELD_LABEL_KEYS[field])}
        </span>
        <input
          className="pcad-field__input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={source}
          aria-invalid={hasError}
          title={t(PERCENT_FIELD_LABEL_KEYS[field])}
          onChange={(event) => {
            const next = event.target.value;
            setDraftState({ draft: { key: field, source: next }, seenVersion: documentVersion });
            const parsed = evaluateExpression(next, { variables });
            if (!parsed.ok || rangeErrorFor(numericField, parsed.value) !== null) {
              return;
            }
            apply(appearanceWithNumber(spec, field, parsed.value));
          }}
        />
        <span className="pcad-field__unit">{PERCENT_SIGN}</span>
        <p className={hasError ? 'pcad-field__message pcad-field__message--error' : 'pcad-field__message'}>
          {fieldError === null ? (evaluated.ok ? `= ${evaluated.value.display}` : '') : fieldError.message}
        </p>
      </div>
    );
  };

  /** 柄の間隔(mm、FR-1108)。「なし」以外のときだけ呼ばれる。 */
  const renderSpacingField = (spacingValue: ExpressionValue): React.JSX.Element => {
    const source = draft !== null && draft.key === 'spacing' ? draft.source : spacingValue.source;
    const evaluated = evaluateExpression(source, { variables });
    return (
      <ExpressionField
        key="spacing"
        field={{
          key: 'spacing',
          labelKey: 'propertyPanel.appearanceSpacing',
          tooltipKey: 'propertyPanel.appearanceSpacing',
          unit: 'mm',
          defaultSource: spacingValue.source,
          source,
        }}
        result={
          evaluated.ok
            ? { key: 'spacing', value: evaluated.value, error: null }
            : { key: 'spacing', value: null, error: evaluated.error }
        }
        focused={false}
        onFocus={() => undefined}
        onChange={(next) => {
          setDraftState({ draft: { key: 'spacing', source: next }, seenVersion: documentVersion });
          const parsed = evaluateExpression(next, { variables });
          if (!parsed.ok) {
            return;
          }
          apply(appearanceWithPattern(spec, patternWithSpacing(spec.pattern, parsed.value)));
        }}
      />
    );
  };

  return (
    <>
      <div className="pcad-section">
        <h3 className="pcad-section__title">{t('propertyPanel.sectionAppearance')}</h3>
        <AppearanceMenu
          groupLabelKey="propertyPanel.appearancePreset"
          value={spec.preset}
          options={MATERIAL_PRESETS.map((preset) => ({
            value: preset.id,
            labelKey: PRESET_LABEL_KEYS[preset.id],
          }))}
          onChoose={(value) => {
            const preset = MATERIAL_PRESETS.find((candidate) => candidate.id === value);
            if (preset !== undefined) {
              apply(appearanceWithPreset(spec, preset.id));
            }
          }}
        />
        {spec.pattern.kind !== 'woodGrain' ? null : (
          <AppearanceMenu
            groupLabelKey="propertyPanel.appearanceSpecies"
            value={spec.pattern.species}
            options={WOOD_SPECIES.map((species) => ({
              value: species.id,
              labelKey: WOOD_LABEL_KEYS[species.id],
            }))}
            onChoose={(value) => {
              const info = WOOD_SPECIES.find((candidate) => candidate.id === value);
              if (info !== undefined) {
                apply(appearanceWithWoodSpecies(spec, info.id));
              }
            }}
          />
        )}
        <div className="pcad-choice">
          <span className="pcad-choice__label">{t('propertyPanel.appearanceColor')}</span>
          <div
            className="pcad-swatches"
            role="group"
            aria-label={t('propertyPanel.appearanceColor')}
          >
            {FACE_COLORS.map((color, index) => (
              <button
                key={color}
                type="button"
                className={`pcad-swatch pcad-swatch--${String(index + 1)}`}
                aria-pressed={spec.color === color}
                aria-label={color}
                title={t('propertyPanel.appearanceColor')}
                onClick={() => {
                  apply(appearanceWithColor(spec, color));
                }}
              />
            ))}
          </div>
          {renderHexField()}
        </div>
        <div className="pcad-choice">
          <span className="pcad-choice__label">{t('propertyPanel.appearancePattern')}</span>
          <div
            className="pcad-segmented pcad-choice__options"
            role="group"
            aria-label={t('propertyPanel.appearancePattern')}
          >
            {PATTERN_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="pcad-button"
                aria-pressed={spec.pattern.kind === kind}
                onClick={() => {
                  apply(appearanceWithPattern(spec, patternWithKind(spec.pattern, kind)));
                }}
              >
                {t(PATTERN_LABEL_KEYS[kind])}
              </button>
            ))}
          </div>
        </div>
        {spec.pattern.kind === 'none' ? null : (
          <div className="pcad-coordinate__fields">{renderSpacingField(spec.pattern.spacing)}</div>
        )}
        <div className="pcad-coordinate__fields">
          {renderPercentField('transmission')}
          {renderPercentField('gloss')}
          {renderPercentField('roughness')}
        </div>
        <div className="pcad-appearance__actions">
          <button
            type="button"
            className="pcad-button"
            disabled={directEntry === undefined}
            onClick={() => {
              if (directEntry !== undefined) {
                useAppStore.getState().removeAppearance(directEntry.id);
              }
            }}
          >
            {t('propertyPanel.appearanceRemove')}
          </button>
          <button
            type="button"
            className="pcad-button"
            onClick={() => {
              useAppStore.getState().clearAppearance();
            }}
          >
            {t('propertyPanel.appearanceClear')}
          </button>
        </div>
      </div>
      {missingEntries.length === 0 ? null : (
        <div className="pcad-section">
          <h3 className="pcad-section__title">{t('propertyPanel.appearanceMissing')}</h3>
          <ul className="pcad-appearance-missing">
            {missingEntries.map((entry) => (
              <li className="pcad-appearance-missing__row" key={entry.id}>
                <span className="pcad-appearance-missing__label">
                  {t(PRESET_LABEL_KEYS[entry.appearance.preset])}
                </span>
                <button
                  type="button"
                  className="pcad-button pcad-coordinate__action"
                  title={t('propertyPanel.appearanceRemove')}
                  aria-label={t('propertyPanel.appearanceRemove')}
                  onClick={() => {
                    useAppStore.getState().removeAppearance(entry.id);
                  }}
                >
                  {t('propertyPanel.removePointMark')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * 外観の節の `key` に付ける接頭辞(P5 仕上げ (d))。
 *
 * 外観の節は「選び直したら打ちかけの下書きを捨てる」ために選択そのものを `key` にするが、
 * **接頭辞を付けないと、立体を 1 つだけ選んでいるときに `SolidProperties` の
 * `key={solid.id}` と同じ文字列になり、同じ親の中で兄弟の鍵が重なる**。重なった鍵は
 * React の入れ替えを狂わせ、古い節が消えずに残る。上の枠が `key` に使うのは
 * フィーチャーの id(`extrude-1` の形。model の `nextFeatureId` が作る)だけで、
 * `appearance:` で始まることは無いので、この接頭辞を付ければ兄弟の鍵は必ず食い違う。
 */
const APPEARANCE_KEY_PREFIX = 'appearance:';

/**
 * 外観の節の `key`(上の接頭辞 + いまの選択)。**同じ親に並ぶ他の節の `key`
 * (`feature.id` / `solid.id` / `reference.id`)と絶対に重ならないこと**が満たすべき性質で、
 * それを `PropertyPanel.test.ts` が固定する(この 1 行のためだけに関数へ出してある)。
 */
export function appearanceSectionKey(selection: readonly string[]): string {
  return `${APPEARANCE_KEY_PREFIX}${selection.join('|')}`;
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
  // 外観の節(FR-1106〜1110)が要る一式。`bodies`/`selectionKind`/`appearanceMatches` は
  // ここでしか使わないので、他の節の描画には影響しない購読を足すだけにする。
  const bodies = useAppStore((state) => state.bodies);
  const selectionKind = useAppStore((state) => state.selectionKind);
  const appearanceMatches = useAppStore((state) => state.appearanceMatches);
  const appearanceContext: AppearanceContext = {
    document: part,
    bodies: subShapeBodiesOf(bodies),
    selection,
    selectionKind,
    matches: appearanceMatches,
  };
  const appearanceReady = appearanceReadiness(appearanceContext).ok;

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
        ) : origin !== null || appearanceReady ? null : (
          /*
            立体の頂点だけを選んでいるときは「原点」の節が、面(または立体)を選んでいて
            外観を割り当てられるときは「外観」の節が出るので、空の案内は出さない。
          */
          <div className="pcad-panel__empty">
            <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p>
          </div>
        )}
        {/* 点を 1 つだけ選んでいるときの「ここを原点にする」(FR-331、タスク35b)。 */}
        {origin === null ? null : <OriginSection origin={origin} />}
        {/*
          外観の節(FR-1106〜1110、要件§4.12、タスク12)。立体または面を選んでいるときだけ
          出す(`feature`/`solid`/`reference` のどれが出ていても、その下に続けて出す)。
          選ぶ対象が変わるたびに作り直す(`key` は選択そのものから作るので、選び直すたびに
          打っている途中の下書きも消える。`FeatureProperties`/`SolidProperties` と同じ流儀)。

          **`key` には必ず `APPEARANCE_KEY_PREFIX` を付ける。** 付けないと、立体を 1 つだけ
          選んでいるときの `selection.join('|')` が上の `SolidProperties` の `key={solid.id}`
          とまったく同じ文字列になり、**同じ親の中で兄弟の鍵が重なる**。鍵が重なると React は
          入れ替えのときに古い側を消し損ね、前に選んでいた立体の節が画面に残り続ける
          (選ぶたびに 4 節ずつ積み上がる。2026-09-05 実測、P5 仕上げ (d)。
          docs/報告記録.md の同日の追記)。
        */}
        {!appearanceReady ? null : (
          <AppearanceSection key={appearanceSectionKey(selection)} context={appearanceContext} />
        )}
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
