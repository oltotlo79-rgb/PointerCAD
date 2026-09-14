import { SectionViewSection } from '../solid/SectionViewSection.js';
import { SelectionSetSection } from '../solid/SelectionSetSection.js';
import { CanvasSection } from '../sketch/CanvasSection.js';
import { PrintCheckSection } from '../solid/PrintCheckSection.js';
import { InferConstraintsSection } from '../sketch/InferConstraintsSection.js';
import { AppearanceSection } from '../appearance/AppearanceSection.js';
import { FACE_COLORS } from '../appearance/appearancePropertyValues.js';
import { useFieldUnits, evaluateFieldSource, committedFieldSource } from './propertyFieldUnits.js';
import { Fragment, useEffect, useRef, useState } from 'react';
import { FunctionCurveProperties } from '../functionPlot/FunctionCurveProperties.js';
import { FunctionSurfaceProperties } from '../functionPlot/FunctionSurfaceProperties.js';
import { FunctionPointProperties } from '../functionPlot/FunctionPointProperties.js';
import { FunctionDirectionProperties } from '../functionPlot/FunctionDirectionProperties.js';
import { FunctionSectionProperties } from '../functionPlot/FunctionSectionProperties.js';
import { tryMathComposition } from '../math/tryMathComposition.js';
import { surfaceHelpTopic } from '../solid/surfaceHelpTopic.js';
import { SheetMetalPanel } from '../sheetMetal/SheetMetalPanel.js';
import { ScriptPanel } from '../scripting/ScriptPanel.js';
import { SheetUnfoldPanel } from '../sheetMetal/SheetUnfoldPanel.js';
import { sheetFieldUnitError } from '../sheetMetal/sheetFieldError.js';

import {
  evaluateExpression,
  type ExpressionValue,
} from '@pointercad/expression';
import {
  baseWorkPlane,
  findReference,
  findSolid,
  replaceReference,
  replaceSolid,
  resolveSketch,
  type CutFeature,
  type ReferenceFeature,
  type LoftFeature,
  type PrimitiveFeature,
  type RuledFeature,
  type SketchFeature,
  type SolidFeature,
} from '@pointercad/model';

import {
  appearanceOfSelection,
  appearanceReadiness,
  type AppearanceContext,
} from '../appearance/appearanceCommands.js';
import { t, type MessageKey } from '../i18n/t.js';
import { ParameterPanel } from '../parameters/ParameterPanel.js';
import { ConstraintList } from '../sketch/ConstraintList.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { PropertyMathField, replacePropertySketchFeature } from '../math/PropertyMathField.js';
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
  primitiveFieldSummaries,
  primitiveOriginSummary,
  setPrimitiveAxis,
  setPrimitiveField,
  setPrimitiveOriginCoordinate,
} from '../solid/primitiveCommands.js';
import { partMeasureReadiness } from '../sketch/sketchMeasure.js';
import { MeasureSection, MassPropertiesSection } from '../solid/MeasurementSections.js';
import { formatVolume, VOLUME_UNIT_KEYS } from '../solid/measureFormatting.js';
import {
  cutPlaneRejection,
  inferPlaneSpec,
  type CutContext,
} from '../solid/cutCommands.js';
import { ruledTwistNoteKey } from '../solid/ruledCommands.js';
import { isValidSphereGridStep } from '../viewport/buildSphereGrid.js';
import {
  isLengthFieldUnit,
  numericChoiceOptionLabel,
  rangeErrorFor,
  type NumericField,
} from '../sketch/numericInput.js';
import {
  COORDINATE_MODES,
  fieldUnitLabelKey,
  fieldValueNumberText,
  fieldValueText,
  MODE_LABEL_KEYS,
  MODE_TOOLTIP_KEYS,
  roundToSignificantDigits,
} from '../sketch/numericInputPresentation.js';
import {
  missingValueKey,
  partErrorMessage,
  PLANE_SPEC_LABEL_KEYS,
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
  const units = useFieldUnits();
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

  const functionPoint=feature.kind==='point'&&feature.at.mode!=='absolute'&&feature.at.base.kind==='functionPoint'?feature.at.base:null;
  const summarized = summarizeFeature(feature, sketchErrors, {
    document: sketch,
    // 立体の名前は部品文書にしかないので、ここで引いて渡す(頂点参照の「押し出し1 / 立体の頂点」)。
    bodyName: (featureId) => findSolid(part, featureId)?.name ?? null,
    rectangleView,
  });
  const attachedFunctionPoint=functionPoint!==null&&feature.kind==='point'&&feature.at.mode==='relative'
    &&[feature.at.dx,feature.at.dy,feature.at.dz].every(value=>value.source==='0'&&!value.mathDefinition);
  const attachedDirection=feature.kind==='line'&&feature.from.mode==='relative'&&feature.from.base.kind==='point'
    &&feature.to.mode==='relative'&&feature.to.base.kind==='functionPoint'
    &&feature.to.base.direction?.sourcePointId===feature.from.base.pointId
    &&[feature.from.dx,feature.from.dy,feature.from.dz,feature.to.dx,feature.to.dy,feature.to.dz].every(value=>value.source==='0'&&!value.mathDefinition);
  const baseSummary=attachedFunctionPoint||attachedDirection?{...summarized,coordinates:[]}:summarized;
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
    const drafted = draft !== null && draft.path === item.path;
    const source = drafted ? draft.source : item.value.source;
    const evaluated = evaluateFieldSource(source, item.unit, drafted, units);
    return (
      <PropertyMathField
        key={item.path}
        storedValue={item.value}
        replaceValue={(document, value) => replacePropertySketchFeature(document, feature.id, setFeatureField(feature, item.path, value))}
        lengthUnit={units.lengthUnit}
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
          const parsed = evaluateExpression(committedFieldSource(next, item.unit, units), units);
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

      {feature.kind === 'functionCurve' ? <FunctionCurveProperties feature={feature} /> : null}
      {feature.kind === 'planeSection' ? <FunctionSectionProperties featureId={feature.id} /> : null}
      {functionPoint?<FunctionPointProperties pointId={feature.id} reference={functionPoint}/>:null}
      {feature.kind==='line'?<FunctionDirectionProperties key={feature.id} feature={feature}/>:null}

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
  /*
    面をつなぐ・ロフト(FR-430、FR-410、P5 タスク27)が参照するのは「加工するもとの立体」
    ではなく**つなぐ断面**なので、押し出し・回転・縫合と同じ「断面」の見出しにする
    (対象を消費しないので「対象」という言葉が実態に合わない。§0.a-0.27)。
  */
  if (feature.kind === 'ruled' || feature.kind === 'loft') {
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
  const isLong = choice.presentation === 'menu' || choice.options.length > LONG_CHOICE_OPTION_THRESHOLD;
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
  const units = useFieldUnits();
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

  /**
   * 式の 1 欄。範囲(`SolidFieldSummary.range`、P5 タスク52)を持つ欄は、**範囲の外の値では
   * 履歴を差し替えず**に赤と理由だけを出す(NFR-UX-5「実行してから失敗させない」)。
   * 範囲を持たない P1〜P4 からの欄のふるまいは 1 つも変わらない。
   */
  const renderField = (item: SolidFieldSummary): React.JSX.Element => {
    const drafted = draft !== null && draft.key === item.key;
    const source = drafted ? draft.source : item.value.source;
    const unitError = sheetFieldUnitError(item.key, source);
    const evaluated = evaluateFieldSource(source, item.unit, drafted, units);
    const numericField: NumericField = {
      key: item.key,
      labelKey: item.labelKey,
      tooltipKey: item.tooltipKey,
      unit: item.unit,
      defaultSource: item.value.source,
      source,
      ...(item.range === undefined ? {} : { range: item.range }),
    };
    const rangeError = evaluated.ok ? rangeErrorFor(numericField, evaluated.value) : null;
    return (
      <PropertyMathField
        key={item.key}
        storedValue={item.value}
        replaceValue={(document, value) => replaceSolid(document, feature.id, setSolidField(feature, item.key, value, units.variables, units))}
        field={numericField}
        lengthUnit={units.lengthUnit}
        result={
          unitError !== null ? { key: item.key, value: null, error: unitError } : !evaluated.ok
            ? { key: item.key, value: null, error: evaluated.error }
            : rangeError !== null
              ? { key: item.key, value: null, error: rangeError }
              : { key: item.key, value: evaluated.value, error: null }
        }
        /* 焦点の正本は利用者のクリックとタブ移動。こちらからは動かさない。 */
        focused={false}
        onFocus={() => undefined}
        onChange={(next) => {
          setDraftState({ draft: { key: item.key, source: next }, seenVersion: documentVersion });
          if (sheetFieldUnitError(item.key, next) !== null) return;
          const parsed = evaluateExpression(committedFieldSource(next, item.unit, units), units);
          if (!parsed.ok || rangeErrorFor({ ...numericField, source: next }, parsed.value) !== null) {
            return;
          }
          const calculated = tryMathComposition(() => setSolidField(feature, item.key, parsed.value, units.variables, units));
          if (!calculated.ok) { useAppStore.getState().setShapeError(calculated.message); return; }
          apply(calculated.value, `field:${feature.id}:${item.key}`);
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
        /*
          式を入れられない欄なので、**数そのもの**を表示の単位で出す(タスク3b)。
          打ち込める欄と違って「保存されている式」を見せる意味が無く、横の札(in)と
          中身の数の単位が食い違うほうが読み違いを生む。mm のときは 1 文字も変わらない。
        */
        value={
          isLengthFieldUnit(item.unit) && units.lengthUnit === 'inch'
            ? fieldValueNumberText(item.unit, item.value, units.lengthUnit)
            : item.value.source
        }
        title={t(item.tooltipKey)}
      />
      <span className="pcad-field__unit">{t(fieldUnitLabelKey(item.unit, units.lengthUnit))}</span>
      <p className="pcad-field__message">
        {`= ${fieldValueText(item.unit, item.value, units.lengthUnit)}`}
      </p>
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
        <div className="pcad-section" data-help-topic={surfaceHelpTopic(feature.kind)}>
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
                const calculated = tryMathComposition(() => setSolidChoice(feature, choice.key, value, units.variables, units, part));
                if (!calculated.ok) { useAppStore.getState().setShapeError(calculated.message); return; }
                apply(calculated.value);
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

      {feature.kind === 'functionSurface' ? <FunctionSurfaceProperties feature={feature} /> : null}
      {feature.kind === 'sheetBase' || feature.kind === 'sheetFlange' || feature.kind === 'sheetBend' || feature.kind === 'sheetRelief' ? <div className="pcad-section">
        <button type="button" className="pcad-button" disabled={feature.suppressed}
          title={t(feature.suppressed ? 'sheetMetal.editSuppressed' : 'sheetMetal.editHint')}
          onClick={() => useAppStore.getState().openSheetMetalTool(feature.kind, feature.id)}>{t('sheetMetal.editReferences')}</button>
      </div> : null}

      <div className="pcad-section">
        <h3 className="pcad-section__title">{t('propertyPanel.sectionResult')}</h3>
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.volume')}</dt>
          <dd className="pcad-properties__value">
            {body === undefined
              ? missing
              : `${formatVolume(body.volume, units.lengthUnit)} ${t(VOLUME_UNIT_KEYS[units.lengthUnit])}`}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.triangleCount')}</dt>
          <dd className="pcad-properties__value">
            {body === undefined ? missing : String(body.mesh.triangleCount)}
          </dd>
          {/*
            読み込んだ形(FR-802、P6 §2.18、タスク32)だけに出す面の数。
            **素性の節ではなくここに出す**のは、面の数が文書には入っておらず、
            計算した形からしか分からないため(体積・三角形の数と同じ出どころ)。
            読み込んだ形は「その上へ穴や面取りを積めるか」の目安になるので出す。
          */}
          {feature.kind === 'importedSolid' ? (
            <>
              <dt className="pcad-properties__key">{t('propertyPanel.importedFaceCount')}</dt>
              <dd className="pcad-properties__value">
                {body === undefined ? missing : String(body.faces.length)}
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 基本形状(FR-429、P5 タスク18)
 * ------------------------------------------------------------------ */

/** 打っている途中の基本形状の欄。寸法の欄と中心の座標の欄で名前空間を分ける。 */
interface PrimitiveFieldDraft {
  /** 寸法の欄の名前、または中心の座標の欄(`origin:x` の形)。 */
  readonly key: string;
  readonly source: string;
}

/** 中心の座標の欄の下書きの名前。寸法の欄の名前と混ざらないように接頭辞を付ける。 */
const PRIMITIVE_ORIGIN_DRAFT_PREFIX = 'origin:';

/**
 * 選ばれている基本形状 1 つの寸法・中心・向き(FR-429、FR-201、FR-502)。
 *
 * `SolidProperties` の「立体」「かたち」「結果」の節の**下に続けて**出す独立した節にしてある。
 * 寸法の欄を `solidSummary.ts` の `SolidFieldSummary` へ載せる案もあるが、
 * **`solidSummary.ts` はタスク43 の変更がコミット検査待ち**で触れないため、
 * 基本形状の欄だけをこの節に閉じた(統括の指示。タスク43 が載ったあと `solidSummary.ts` へ
 * 寄せ直すかは統括の判断。**そのときも中心の 3 通りと向きはここの作りをそのまま使える**)。
 *
 * 打っている途中の値は表示専用の下書きに置き、式として読めたときだけ履歴を差し替える
 * (`SolidProperties` とまったく同じ作り)。続けざまの書き換えは `coalesceKey` で Undo の
 * 1 段にまとめる(§0.a-0.13)。
 */
function PrimitiveSection({ feature }: { readonly feature: PrimitiveFeature }): React.JSX.Element {
  const documentVersion = useAppStore((state) => state.documentVersion);
  const part = useAppStore((state) => state.document);
  const units = useFieldUnits();
  const [draftState, setDraftState] = useState(() =>
    initialDraftVersionState<PrimitiveFieldDraft>(documentVersion),
  );
  const reconciled = reconcileDraftVersion(draftState, documentVersion);
  if (reconciled !== draftState) {
    setDraftState(reconciled);
  }
  const draft = reconciled.draft;

  const apply = (next: PrimitiveFeature, coalesceKey: string): void => {
    if (next === feature) {
      return;
    }
    const store = useAppStore.getState();
    store.applyDocument(replaceSolid(store.document, feature.id, next), { coalesceKey });
  };

  /** 式を 1 つ入れる欄。読めたときだけ履歴を差し替える(読めない間は下書きに残す)。 */
  const renderExpression = (
    draftKey: string,
    field: NumericField,
    storedValue: ExpressionValue,
    transform: (value: ExpressionValue) => PrimitiveFeature,
  ): React.JSX.Element => {
    const drafted = draft !== null && draft.key === draftKey;
    const source = drafted ? draft.source : field.source;
    const evaluated = evaluateFieldSource(source, field.unit, drafted, units);
    return (
      <PropertyMathField
        key={draftKey}
        storedValue={storedValue}
        replaceValue={(document, value) => replaceSolid(document, feature.id, transform(value))}
        field={{ ...field, source }}
        lengthUnit={units.lengthUnit}
        result={
          evaluated.ok
            ? { key: field.key, value: evaluated.value, error: null }
            : { key: field.key, value: null, error: evaluated.error }
        }
        /* 焦点の正本は利用者のクリックとタブ移動。こちらからは動かさない。 */
        focused={false}
        onFocus={() => undefined}
        onChange={(next) => {
          setDraftState({ draft: { key: draftKey, source: next }, seenVersion: documentVersion });
          const parsed = evaluateExpression(committedFieldSource(next, field.unit, units), units);
          if (parsed.ok) {
            apply(transform(parsed.value), `primitive:${feature.id}:${draftKey}`);
          }
        }}
      />
    );
  };

  const origin = primitiveOriginSummary(part, feature);

  return (
    <>
      <div className="pcad-section">
        <h3 className="pcad-section__title">{t('propertyPanel.sectionPrimitive')}</h3>
        <div className="pcad-coordinate__fields">
          {primitiveFieldSummaries(feature).map((item) =>
            renderExpression(
              item.key,
              {
                key: item.key,
                labelKey: item.labelKey,
                tooltipKey: item.tooltipKey,
                unit: item.unit,
                defaultSource: item.value.source,
                source: item.value.source,
              },
              item.value,
              (value: ExpressionValue) => setPrimitiveField(feature, item.key, value),
            ),
          )}
        </div>
        <div className="pcad-choice">
          <span className="pcad-choice__label">{t('propertyPanel.primitiveAxis')}</span>
          <div
            className="pcad-segmented pcad-choice__options"
            role="group"
            aria-label={t('propertyPanel.primitiveAxis')}
          >
            {WORLD_AXIS_CHOICES.map((choice) => (
              <button
                key={choice.axis}
                type="button"
                className="pcad-button"
                aria-pressed={feature.axis.kind === 'world' && feature.axis.axis === choice.axis}
                onClick={() => {
                  apply(setPrimitiveAxis(feature, choice.axis), `primitive:${feature.id}:axis`);
                }}
              >
                {t(choice.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="pcad-section">
        <h3 className="pcad-section__title">{t('propertyPanel.primitiveCenter')}</h3>
        {origin.kind === 'coordinate' ? (
          <div className="pcad-coordinate__fields">
            {origin.fields.map((item) =>
              renderExpression(
                `${PRIMITIVE_ORIGIN_DRAFT_PREFIX}${item.axis}`,
                {
                  key: item.axis,
                  labelKey: item.labelKey,
                  tooltipKey: item.labelKey,
                  unit: 'mm',
                  defaultSource: item.value.source,
                  source: item.value.source,
                },
                item.value,
                (value: ExpressionValue) => setPrimitiveOriginCoordinate(feature, item.axis, value),
              ),
            )}
          </div>
        ) : (
          <dl className="pcad-properties">
            <dt className="pcad-properties__key">
              {t(
                origin.kind === 'sketchPoint'
                  ? 'propertyPanel.primitiveCenterSketchPoint'
                  : 'propertyPanel.primitiveCenterVertex',
              )}
            </dt>
            <dd className="pcad-properties__value">
              {origin.name === null ? (
                <span className="pcad-properties__missing">
                  {t('propertyPanel.referenceMissing')}
                </span>
              ) : (
                origin.name
              )}
            </dd>
          </dl>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 球面の案内線と球面上の点(FR-431、P5 タスク21・22)
 * ------------------------------------------------------------------ */

/**
 * 球を選んでいるときに出す「球面の案内線」の節(FR-431、§0.a-0.21)。
 *
 * 線の間隔(式、FR-201)と「いつも出す」の 2 つだけを持つ。**どちらも文書には残らない**
 * 画面の設定なので、履歴にも保存にも触れない(ストアの `sphereGridStep` /
 * `sphereGridAlwaysVisible` が正本)。間隔が 1 度未満・90 度超のときは案内線を出せないので、
 * 赤い断りではなく注記で理由を伝える(rules/04「止めずに警告する」)。
 */
function SphereGridSection(): React.JSX.Element {
  const step = useAppStore((state) => state.sphereGridStep);
  const alwaysVisible = useAppStore((state) => state.sphereGridAlwaysVisible);
  const units = useFieldUnits();
  const [draft, setDraft] = useState<string | null>(null);
  const source = draft ?? step.source;
  const evaluated = evaluateFieldSource(source, 'degree', draft !== null, units);
  const outOfRange = evaluated.ok && !isValidSphereGridStep(evaluated.value.value);

  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionSphereGrid')}</h3>
      <div className="pcad-coordinate__fields">
        <ExpressionField
          field={{
            key: 'sphereGridStep',
            labelKey: 'propertyPanel.sphereGridStep',
            tooltipKey: 'propertyPanel.sphereGridStepTooltip',
            unit: 'degree',
            defaultSource: step.source,
            source,
          }}
          result={
            evaluated.ok
              ? { key: 'sphereGridStep', value: evaluated.value, error: null }
              : { key: 'sphereGridStep', value: null, error: evaluated.error }
          }
          focused={false}
          onFocus={() => undefined}
          onChange={(next) => {
            setDraft(next);
            const parsed = evaluateExpression(committedFieldSource(next, 'degree', units), units);
            if (parsed.ok) {
              useAppStore.getState().setSphereGridStep(parsed.value);
            }
          }}
        />
      </div>
      {outOfRange ? (
        <p className="pcad-panel__note">{t('propertyPanel.sphereGridStepRange')}</p>
      ) : null}
      <div className="pcad-toggles">
        <button
          type="button"
          role="switch"
          className="pcad-switch"
          aria-checked={alwaysVisible}
          onClick={() => {
            useAppStore.getState().setSphereGridAlwaysVisible(!alwaysVisible);
          }}
        >
          <span className="pcad-switch__track" aria-hidden="true">
            <span className="pcad-switch__thumb" />
          </span>
          <span>{t('propertyPanel.sphereGridAlways')}</span>
        </button>
      </div>
      <p className="pcad-panel__note">{t('propertyPanel.sphereGridHint')}</p>
    </div>
  );
}

/** 球面上の点の緯度・経度(度)。基準が球でなければ null。 */
export function sphereGridAnglesOf(
  feature: SketchFeature,
): { readonly latitude: ExpressionValue; readonly longitude: ExpressionValue } | null {
  if (feature.kind !== 'point' || feature.at.mode === 'absolute') {
    return null;
  }
  const base = feature.at.base;
  return base.kind === 'sphereGrid'
    ? { latitude: base.latitude, longitude: base.longitude }
    : null;
}

/** 球面上の点の緯度・経度のどちらを直すか。 */
export type SphereGridAngleKey = 'latitude' | 'longitude';

/**
 * 球面上の点の緯度・経度を 1 つ書き戻す(FR-431、FR-202、FR-502)。
 *
 * 基準が球でない要素が来たら**そのまま返す**(`setPrimitiveField` と同じ約束。
 * 呼び出し側が要素の種類を数え直さずに済む)。座標そのものは書き換えないので、
 * 直した点は球面の上に留まったまま緯度・経度だけが動く。
 */
export function setSphereGridAngle(
  feature: SketchFeature,
  key: SphereGridAngleKey,
  value: ExpressionValue,
): SketchFeature {
  if (feature.kind !== 'point' || feature.at.mode === 'absolute') {
    return feature;
  }
  const base = feature.at.base;
  if (base.kind !== 'sphereGrid') {
    return feature;
  }
  return {
    ...feature,
    at: {
      ...feature.at,
      base:
        key === 'latitude' ? { ...base, latitude: value } : { ...base, longitude: value },
    },
  };
}

/**
 * 球面上の点の「球の上の位置」の節(FR-431、FR-202、タスク22)。
 *
 * 緯度・経度を**式のまま**直せる。座標(ΔX / ΔY / ΔZ)は 0 のままで意味を持たないので、
 * 直すのはこの 2 つだけにする。半径や中心を変えれば点はひとりでに動くので、
 * ここには位置の欄を置かない(rules/04「導出できるものは保存しない」)。
 */
function SphereGridPointSection({
  feature,
}: {
  readonly feature: SketchFeature;
}): React.JSX.Element | null {
  const documentVersion = useAppStore((state) => state.documentVersion);
  const units = useFieldUnits();
  const [draftState, setDraftState] = useState(() =>
    initialDraftVersionState<FieldDraft>(documentVersion),
  );
  const reconciled = reconcileDraftVersion(draftState, documentVersion);
  if (reconciled !== draftState) {
    setDraftState(reconciled);
  }
  const draft = reconciled.draft;
  const angles = sphereGridAnglesOf(feature);
  if (angles === null) {
    return null;
  }

  const renderAngle = (
    key: SphereGridAngleKey,
    labelKey: MessageKey,
    value: ExpressionValue,
  ): React.JSX.Element => {
    const path = `sphereGrid.${key}`;
    const drafted = draft !== null && draft.path === path;
    const source = drafted ? draft.source : value.source;
    const evaluated = evaluateFieldSource(source, 'degree', drafted, units);
    return (
      <PropertyMathField
        key={path}
        storedValue={value}
        replaceValue={(document, parsed) => replacePropertySketchFeature(document, feature.id, setSphereGridAngle(feature, key, parsed))}
        lengthUnit={units.lengthUnit}
        field={{
          key: path,
          labelKey,
          tooltipKey: labelKey,
          unit: 'degree',
          defaultSource: value.source,
          source,
        }}
        result={
          evaluated.ok
            ? { key: path, value: evaluated.value, error: null }
            : { key: path, value: null, error: evaluated.error }
        }
        focused={false}
        onFocus={() => undefined}
        onChange={(next) => {
          setDraftState({ draft: { path, source: next }, seenVersion: documentVersion });
          const parsed = evaluateExpression(committedFieldSource(next, 'degree', units), units);
          if (!parsed.ok) {
            return;
          }
          useAppStore
            .getState()
            .replaceSketchFeature(feature.id, setSphereGridAngle(feature, key, parsed.value));
        }}
      />
    );
  };

  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionSphereGridPoint')}</h3>
      <div className="pcad-coordinate__fields">
        {renderAngle('latitude', 'propertyPanel.latitude', angles.latitude)}
        {renderAngle('longitude', 'propertyPanel.longitude', angles.longitude)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 面をつなぐ・ロフト(FR-430、FR-410、P5 タスク27)
 * ------------------------------------------------------------------ */

/**
 * 面をつなぐ・ロフトの「つなぎ方」の節(FR-430、FR-410、§0.a-0.87)。
 *
 * ねじれの式の欄・なめらかさの 3 択・つなぐ面の一覧は、どれも `solidSummary.ts` の
 * `fields` / `choices` / `references` に載せてあるので、すぐ上の `SolidProperties` が
 * そのまま描く。**この節が持つのは注記 1 行だけ**である。
 *
 * 注記が要るのは「立体の面から取り出した断面にはねじれが効かない」ことで(タスク24b の
 * 実装。カーネルは面の外周を元の並びのまま結び、ずらしを断りもしない)、欄を伏せるわけには
 * いかない(値は保存され、スケッチの面の断面には効く)。効かないだけで**間違いではない**
 * ので赤い断りにはせず、淡い注記で伝える(rules/04「止めずに警告する」)。
 * 注記が要らないとき(断面が全部スケッチの面・球)は何も出さない。
 */
function RuledNoteSection({
  feature,
}: {
  readonly feature: RuledFeature | LoftFeature;
}): React.JSX.Element | null {
  const noteKey = ruledTwistNoteKey(feature);
  if (noteKey === null) {
    return null;
  }
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionRuled')}</h3>
      <p className="pcad-panel__note">{t(noteKey)}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 平面による切断(FR-432、§2.9b、P5 タスク27f)
 * ------------------------------------------------------------------ */

/**
 * 切断の「切る面」の節(FR-432、§0.a-0.56〜0.58)。
 *
 * 傾き角・方位角・ずらす距離の欄と「反対側を残す」のつまみは `solidSummary.ts` の
 * `fields` / `toggles` に載せてあるので、すぐ上の `SolidProperties` がそのまま描く。
 * **この節が持つのは、欄にできない 3 つ**である:
 *
 * 1. 切る面の決め方(3 点を通る・点と辺…)の読み取り専用の表示。
 * 2. 残る側が面のどちら側かの読み取り専用の表示(つまみの結果を言葉で確かめられる)。
 * 3. **「選び直す」のボタン**。切る面のもとになる点・辺・面は画面で指すものなので、
 *    いま選んでいるものから決め方を組み立て直す(道具と同じ推測 `inferPlaneSpec` を使う。
 *    同じ規則を 2 か所に書かない)。押せないときは理由を添える(NFR-UX-5)。
 *
 * 対で作られた切断(§0.a-0.58)は 2 つが同じ面で切っているので、選び直したときは
 * **相手の面も一緒に**差し替える(片方だけ動くと 2 つのボディが噛み合わなくなる)。
 */
function CutSection({ feature }: { readonly feature: CutFeature }): React.JSX.Element {
  const part = useAppStore((state) => state.document);
  const bodies = useAppStore((state) => state.bodies);
  const selection = useAppStore((state) => state.selection);
  const context: CutContext = {
    document: part,
    bodies: subShapeBodiesOf(bodies),
    selection,
  };
  const inferred = inferPlaneSpec(context);
  const rejection = inferred === null ? null : cutPlaneRejection(inferred);
  const canRepick = inferred !== null && rejection === null;

  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionCut')}</h3>
      <dl className="pcad-properties">
        <dt className="pcad-properties__key">{t('propertyPanel.cutPlaneKind')}</dt>
        <dd className="pcad-properties__value">{t(PLANE_SPEC_LABEL_KEYS[feature.plane.kind])}</dd>
        <dt className="pcad-properties__key">{t('propertyPanel.cutKeep')}</dt>
        <dd className="pcad-properties__value">
          {t(
            feature.keep === 'positive'
              ? 'propertyPanel.cutKeepPositive'
              : 'propertyPanel.cutKeepNegative',
          )}
        </dd>
      </dl>
      <button
        type="button"
        className="pcad-button pcad-button--action"
        title={t('propertyPanel.cutRepickTooltip')}
        disabled={!canRepick}
        onClick={() => {
          if (inferred === null) {
            return;
          }
          const store = useAppStore.getState();
          let next = store.document;
          for (const solid of store.document.solids) {
            if (solid.kind !== 'cut') {
              continue;
            }
            const isPartner =
              solid.id === feature.id ||
              solid.id === feature.pairedWith ||
              solid.pairedWith === feature.id;
            if (isPartner) {
              next = replaceSolid(next, solid.id, { ...solid, plane: inferred });
            }
          }
          store.applyDocument(next);
        }}
      >
        {t('propertyPanel.cutRepick')}
      </button>
      {canRepick ? null : (
        <p className="pcad-panel__note">
          {rejection === null ? t('propertyPanel.cutRepickHint') : t(rejection)}
        </p>
      )}
    </div>
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
  const units = useFieldUnits();
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
    unit: NumericField['unit'],
    value: ExpressionValue,
    transform: (parsed: ExpressionValue) => ReferenceFeature,
  ): React.JSX.Element => {
    const drafted = draft !== null && draft.key === key;
    const source = drafted ? draft.source : value.source;
    const evaluated = evaluateFieldSource(source, unit, drafted, units);
    return (
      <PropertyMathField
        key={key}
        storedValue={value}
        replaceValue={(document, parsed) => replaceReference(document, feature.id, transform(parsed))}
        lengthUnit={units.lengthUnit}
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
          const parsed = evaluateExpression(committedFieldSource(next, unit, units), units);
          if (parsed.ok) {
            apply(transform(parsed.value));
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
                return setReferenceField(feature, item.key, parsed);
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
                    return feature;
                  }
                  if (current.definition.kind !== 'coordinate') {
                    return feature;
                  }
                  const nextAt = setCoordinateField(
                    current.definition.at,
                    item.path.slice(item.path.lastIndexOf('.') + 1),
                    parsed,
                  );
                  return setReferenceCoordinate(current, nextAt);
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

/**
 * 基本形状の節の `key` に付ける接頭辞(P5 タスク18、rules/06 10.9)。
 *
 * 基本形状の節は `SolidProperties`(`key={solid.id}`)と**同じ親**に並ぶので、
 * 接頭辞を付けずにフィーチャーの id をそのまま `key` にすると兄弟の鍵が必ず重なる
 * (10.9 で外観の節が起こしたのとまったく同じ事故で、古い節が消えずに積み上がる)。
 * `feature.id` は model の `nextSolidId` が作る `sphere-1` の形で `primitive:` から
 * 始まることは無いので、この接頭辞を付ければ兄弟の鍵は必ず食い違う。
 */
const PRIMITIVE_KEY_PREFIX = 'primitive:';

/**
 * 基本形状の節の `key`。**同じ親に並ぶ他の節の `key`(`solid.id` / `feature.id` /
 * `reference.id` / `appearanceSectionKey(...)`)と絶対に重ならないこと**が満たすべき性質で、
 * それを `PropertyPanel.test.ts` が固定する。
 */
export function primitiveSectionKey(featureId: string): string {
  return `${PRIMITIVE_KEY_PREFIX}${featureId}`;
}

/**
 * 面をつなぐ・ロフトの注記の節の `key` に付ける接頭辞(P5 タスク27、rules/06 10.9)。
 *
 * 基本形状の節・外観の節とまったく同じ理由で付ける。接頭辞が無いとフィーチャーの id を
 * そのまま `key` にすることになり、同じ親(`.pcad-panel__body`)に並ぶ `SolidProperties`
 * (`key={solid.id}`)と兄弟の鍵が必ず重なる。`feature.id` は model の `nextSolidId` が
 * 作る `ruled-1` の形で `ruled:` から始まることは無い(`-` と `:` で区切りが違う)ので、
 * この接頭辞を付ければ兄弟の鍵は必ず食い違う。
 */
const RULED_KEY_PREFIX = 'ruled:';

/**
 * 面をつなぐ・ロフトの注記の節の `key`。**同じ親に並ぶ他の節の `key`(`solid.id` /
 * `feature.id` / `reference.id` / `primitiveSectionKey(...)` / `appearanceSectionKey(...)`)と
 * 絶対に重ならないこと**が満たすべき性質で、それを `PropertyPanel.test.ts` が固定する。
 */
export function ruledSectionKey(featureId: string): string {
  return `${RULED_KEY_PREFIX}${featureId}`;
}

/**
 * 切断の「切る面」の節の `key` に付ける接頭辞(P5 タスク27f、rules/06 10.9)。
 * 外観・基本形状・つなぎ方の節とまったく同じ理由で付ける。
 */
const CUT_KEY_PREFIX = 'cut:';

/**
 * 切断の節の `key`。**同じ親に並ぶ他の節の `key` と絶対に重ならないこと**が満たすべき
 * 性質で、それを `PropertyPanel.test.ts` が固定する。フィーチャーの id は model の
 * `nextSolidId` が作る `cut-1` の形で `cut:` から始まることは無い(`-` と `:` の違い)。
 */
export function sphereGridSectionKey(featureId: string): string {
  return `${SPHERE_GRID_KEY_PREFIX}${featureId}`;
}

/**
 * 球面の案内線・球の上の位置の節の `key` に付ける接頭辞(P5 タスク21・22、rules/06 10.9)。
 * 外観・基本形状・つなぎ方・切断の節とまったく同じ理由で付ける。フィーチャーの id は
 * model の `nextSolidId` / `nextFeatureId` が作る `sphere-1` / `point-1` の形なので、
 * `sphereGrid:` から始まることは無い(`-` と `:` の違い)。
 */
const SPHERE_GRID_KEY_PREFIX = 'sphereGrid:';

export function cutSectionKey(featureId: string): string {
  return `${CUT_KEY_PREFIX}${featureId}`;
}

/**
 * 測定の節・質量特性の節の `key` に付ける接頭辞(P5 タスク32、rules/06 10.9)。
 *
 * 外観・基本形状・つなぎ方の節とまったく同じ理由で付ける。接頭辞が無いと、立体を 1 つだけ
 * 選んでいるときに `SolidProperties` の `key={solid.id}` と同じ文字列になり、**同じ親の中で
 * 兄弟の鍵が重なる**(古い節が消えずに積み上がる)。
 */
const MEASURE_KEY_PREFIX = 'measure:';
const MASS_KEY_PREFIX = 'mass:';

/**
 * 測定の節の `key`(接頭辞 + いまの選択)。選び直すたびに作り直され、
 * **同じ親に並ぶ他の節の `key` と絶対に重ならない**ことを `PropertyPanel.test.ts` が固定する。
 */
export function measureSectionKey(selection: readonly string[]): string {
  return `${MEASURE_KEY_PREFIX}${selection.join('|')}`;
}

/**
 * 質量特性の節の `key`(接頭辞 + 立体のフィーチャーの id)。立体を選び直すと作り直され、
 * 材料と密度がその立体の外観から選び直される(§0.a-0.31)。
 */
export function massSectionKey(featureId: string): string {
  return `${MASS_KEY_PREFIX}${featureId}`;
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
  const scriptOpen = useAppStore(state => state.scriptPanelOpen);
  const sheetMetalTool = useAppStore((state) => state.sheetMetalTool);
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
  /*
    測定と質量特性(FR-1101、FR-1102、タスク32)。**判断は `measure.ts` の 1 か所**で、
    ここは「節を出すかどうか」を決めるためだけに読む。測った結果は選択の変化では消えない
    (§0.a-0.29)ので、いま選んでいるものが測れなくても結果が残っていれば節を出す。
  */
  const measureSketch = useAppStore(state => state.isComputing ? undefined : state.resolvedSketch);
  const measureReady = partMeasureReadiness(selection, appearanceContext.bodies, measureSketch);
  const measurement = useAppStore((state) => state.measurement);
  const showMeasure = measureReady.ready || measurement !== null;
  // 質量特性は立体を 1 つ選んでいるときだけ(`measureReadiness` が種類でそう言う)。
  const showMass = measureReady.kinds.includes('massProperties');
  const massTarget = measureReady.targets[0];
  const massBodyId = showMass && massTarget !== undefined && 'bodyFeatureId' in massTarget ? massTarget.bodyFeatureId : null;

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

  if (scriptOpen) return <section className="pcad-panel pcad-panel--right"><ScriptPanel /></section>;
  if (sheetMetalTool !== null && sheetMetalTool.document === part) return <section className="pcad-panel pcad-panel--right">
    <h2 className="pcad-panel__title">{t('propertyPanel.title')}</h2>
    {sheetMetalTool.kind === 'sheetUnfold' ? <SheetUnfoldPanel key={sheetMetalTool.id} session={sheetMetalTool} />
      : <SheetMetalPanel key={sheetMetalTool.id} session={sheetMetalTool} />}
  </section>;

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
        ) : origin !== null || appearanceReady || showMeasure ? null : (
          /*
            立体の頂点だけを選んでいるときは「原点」の節が、面(または立体)を選んでいて
            外観を割り当てられるときは「外観」の節が、測れるもの(または測った結果)が
            あるときは「測定」の節が出るので、空の案内は出さない。
          */
          <div className="pcad-panel__empty">
            <p className="pcad-panel__empty-text">{t('propertyPanel.empty')}</p>
          </div>
        )}
        {/*
          基本形状の寸法・中心・向き(FR-429、FR-502、タスク18)。「立体」の節の下に続けて
          出す。**`key` には必ず `PRIMITIVE_KEY_PREFIX` を付ける**(すぐ上の
          `SolidProperties` の `key={solid.id}` と同じ文字列になると兄弟の鍵が重なり、
          古い節が消えずに残る。rules/06 10.9 の再発を防ぐ)。
        */}
        {solid === null || solid.kind !== 'primitive' ? null : (
          <PrimitiveSection key={primitiveSectionKey(solid.id)} feature={solid} />
        )}
        {/*
          面をつなぐ・ロフトの注記(FR-430、タスク27)。欄・選択肢・つなぐ面の一覧は
          `SolidProperties` がすでに描いているので、ここは「立体の面にはねじれが効かない」
          注記だけを添える。**`key` には必ず `RULED_KEY_PREFIX` を付ける**(基本形状の節と
          同じ理由。rules/06 10.9 の再発を防ぐ)。
        */}
        {solid === null || (solid.kind !== 'ruled' && solid.kind !== 'loft') ? null : (
          <RuledNoteSection key={ruledSectionKey(solid.id)} feature={solid} />
        )}
        {/*
          切断の「切る面」(FR-432、タスク27f)。決め方・残る側・選び直しは欄にできないので
          ここへ出す(欄とつまみは `SolidProperties` が描く)。**`key` には必ず
          `CUT_KEY_PREFIX` を付ける**(基本形状・つなぎ方の節と同じ理由。rules/06 10.9)。
        */}
        {solid === null || solid.kind !== 'cut' ? null : (
          <CutSection key={cutSectionKey(solid.id)} feature={solid} />
        )}
        {/*
          球面の案内線(FR-431、タスク21)。球を選んでいるときだけ出す。線の間隔と
          「いつも出す」は画面の設定で、履歴にも保存にも触れない。**`key` には必ず
          `SPHERE_GRID_KEY_PREFIX` を付ける**(基本形状の節と同じ理由。rules/06 10.9)。
        */}
        {solid === null || solid.kind !== 'primitive' || solid.shape.kind !== 'sphere' ? null : (
          <SphereGridSection key={sphereGridSectionKey(solid.id)} />
        )}
        {/*
          球の上の位置(FR-431、FR-202、タスク22)。球面上の点を選んでいるときだけ出す。
          **`key` の接頭辞**は上と同じ理由(`FeatureProperties` の `key={feature.id}` と
          兄弟になるので、接頭辞が無いと鍵が重なる)。
        */}
        {feature === null || sphereGridAnglesOf(feature) === null ? null : (
          <SphereGridPointSection key={sphereGridSectionKey(feature.id)} feature={feature} />
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
          測定と質量特性(FR-1101、FR-1102、タスク32)。外観の節と同じ流儀で、選んでいるものが
          何であってもその下に続けて出す。**`key` には必ず接頭辞を付ける**(すぐ上の
          `SolidProperties` の `key={solid.id}` と重なると古い節が消えずに残る。rules/06 10.9)。
        */}
        {!showMeasure ? null : (
          <MeasureSection key={measureSectionKey(selection)} readiness={measureReady} />
        )}
        {massBodyId === null ? null : (
          <MassPropertiesSection
            key={massSectionKey(massBodyId)}
            spec={appearanceOfSelection(appearanceContext)}
          />
        )}
        {/*
          拘束の一覧(FR-313、P4b タスク13)。**区画もタブも増やさない**(rules/04)。
          いま編集しているスケッチの拘束をここへ並べ、行を押すと 3D の印が光り、
          寸法拘束は値をその場で書き換えられる。拘束が 1 つも無ければ何も出ない。
        */}
        {/*
          P6 の 5 つの節(FR-111、FR-112、FR-332、FR-333、FR-815。§2.18、タスク43)。
          **区画もタブも増やさない**(rules/04)。選んでいるものが何であっても、
          外観・測定の節と同じくその下に続けて出す。**`key` は付けない**——条件で
          出し分ける兄弟ではなく常に同じ位置に 1 つずつ並ぶので、鍵が重なりようがない
          (rules/06 10.9 の事故は「同じ親に id を `key` にした節が並ぶ」形でだけ起きる)。
        */}
        <SectionViewSection />
        <SelectionSetSection />
        <CanvasSection />
        <PrintCheckSection />
        <InferConstraintsSection />
        <ConstraintList />
      </div>
      )}
    </section>
  );
}
