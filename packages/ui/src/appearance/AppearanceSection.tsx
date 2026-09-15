import { useState } from 'react';
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { appearanceOf, isSameAppearanceTarget, MATERIAL_PRESETS, WOOD_SPECIES, type AppearanceSpec } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { rangeErrorFor, type NumericField } from '../sketch/numericInput.js';
import { initialDraftVersionState, reconcileDraftVersion } from '../shell/fieldDraft.js';
import { committedFieldSource, evaluateFieldSource, useFieldUnits } from '../shell/propertyFieldUnits.js';
import { useAppStore } from '../store/useAppStore.js';
import { appearanceOfSelection, appearanceTargetsOf, appearanceWithColor, appearanceWithNumber,
  appearanceWithPattern, appearanceWithPreset, appearanceWithWoodSpecies, isSameAppearanceSpec,
  missingAppearanceIds, type AppearanceContext, type AppearanceNumberField } from './appearanceCommands.js';
import { FACE_COLORS, PRESET_LABEL_KEYS, WOOD_LABEL_KEYS, PATTERN_LABEL_KEYS, PATTERN_KINDS,
  patternWithKind, patternWithSpacing, normalizeHexColor, PERCENT_RANGE, PERCENT_FIELD_LABEL_KEYS,
  PERCENT_SIGN, type AppearanceFieldDraft } from './appearancePropertyValues.js';
import { AppearanceMenu } from './AppearanceMenu.js';

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
export function AppearanceSection({
  context,
}: {
  readonly context: AppearanceContext;
}): React.JSX.Element | null {
  const documentVersion = useAppStore((state) => state.documentVersion);
  const units = useFieldUnits();
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
    const evaluated = evaluateExpression(source, units);
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
            const parsed = evaluateExpression(next, units);
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
    const drafted = draft !== null && draft.key === 'spacing';
    const source = drafted ? draft.source : spacingValue.source;
    const evaluated = evaluateFieldSource(source, 'mm', drafted, units);
    return (
      <ExpressionField
        key="spacing"
        lengthUnit={units.lengthUnit}
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
          const parsed = evaluateExpression(committedFieldSource(next, 'mm', units), units);
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
              <button title={t('controlGuide.button.pattern').replace('{name}', t(PATTERN_LABEL_KEYS[kind]))}
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
          <button title={t('controlGuide.button.appearanceRemove')}
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
          <button title={t('controlGuide.button.appearanceClear')}
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
