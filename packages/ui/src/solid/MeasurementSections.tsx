import { useState } from 'react';
import { evaluateExpression } from '@pointercad/expression';
import { DENSITY_MATERIALS, formatMass, type AppearanceSpec } from '@pointercad/model';
import { AppearanceMenu } from '../appearance/AppearanceMenu.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useFieldUnits } from '../shell/propertyFieldUnits.js';
import type { PartMeasureReadiness } from '../sketch/sketchMeasure.js';
import { useAppStore } from '../store/useAppStore.js';
import { measureKindLabel } from './measure.js';
import {
  defaultDensityMaterialId, densityOf, describeMeasureKinds, describeMeasureTargets,
  formatMeasurePoint, formatMeasureValue, formatMoments, massPropertiesView,
} from './measureCommands.js';
import { formatArea, formatVolume, AREA_UNIT_KEYS, VOLUME_UNIT_KEYS } from './measureFormatting.js';

/**
 * 質量の材料 19 種の見出し(§2.4.2、`densityMaterials.ts` の `DENSITY_MATERIALS` と同じ id)。
 *
 * **id は `string`**(木材が `wood-<樹種>` で作られる合成の id なので、model 側にも
 * 合併型が無い)ので、`Record<string, MessageKey>` で持ち、引けなかった id は
 * 呼び出し側が既定の材料へ落とす。文言は `ja.json` の `material.*`(タスク6 で追加済み)。
 */
const DENSITY_MATERIAL_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  steel: 'material.steel',
  stainless: 'material.stainless',
  aluminum: 'material.aluminum',
  brass: 'material.brass',
  copper: 'material.copper',
  titanium: 'material.titanium',
  abs: 'material.abs',
  pc: 'material.pc',
  nylon: 'material.nylon',
  acrylic: 'material.acrylic',
  pla: 'material.pla',
  glass: 'material.glass',
  rubber: 'material.rubber',
  'wood-hinoki': 'material.wood-hinoki',
  'wood-sugi': 'material.wood-sugi',
  'wood-oak': 'material.wood-oak',
  'wood-walnut': 'material.wood-walnut',
  'wood-teak': 'material.wood-teak',
  'wood-maple': 'material.wood-maple',
};

/** 材料の見出しキー。知らない id は既定の材料(鋼)の見出しにする。 */
function densityMaterialLabelKey(id: string): MessageKey {
  return DENSITY_MATERIAL_LABEL_KEYS[id] ?? 'material.steel';
}

/**
 * 「測定」の節(FR-1102、要件§7.1、計画書タスク32、§2.10.3)。
 *
 * 出すのは 3 つと 1 ボタン。**選んでいるもの / 測れるもの / 結果 / 「測り直す」**。
 * 測る 1 手はストアの `measureSelection`(判断は `solid/measureCommands.ts`)1 か所に
 * あるので、ツールバーの「測る」を押したときとまったく同じ道を通る。
 *
 * **結果はモデルを変えるまで残る**(FR-1102、§0.a-0.29)ので、選び直しても消えない。
 * だから「選んでいるもの」と「結果」が食い違うことがあり、結果には**何を測った値か**
 * (種類の見出し)を必ず添える。消したいときは Esc(§0.a-0.68)。
 */
export function MeasureSection({
  readiness,
}: {
  readonly readiness: PartMeasureReadiness;
}): React.JSX.Element {
  const measurement = useAppStore((state) => state.measurement);
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionMeasure')}</h3>
      <dl className="pcad-properties">
        <dt className="pcad-properties__key">{t('propertyPanel.measureTargets')}</dt>
        <dd className="pcad-properties__value">
          {readiness.ready
            ? describeMeasureTargets(readiness.targets)
            : (readiness.message ?? '')}
        </dd>
        <dt className="pcad-properties__key">{t('propertyPanel.measureKinds')}</dt>
        <dd className="pcad-properties__value">
          {readiness.ready ? describeMeasureKinds(readiness.kinds) : ''}
        </dd>
        <dt className="pcad-properties__key">{t('propertyPanel.measureResult')}</dt>
        <dd className="pcad-properties__value">
          {measurement === null
            ? t('propertyPanel.measureNotYet')
            : `${measureKindLabel(measurement.result.kind)}: ${formatMeasureValue(measurement.result)}`}
        </dd>
      </dl>
      <div className="pcad-appearance__actions">
        <button
          type="button"
          className="pcad-button"
          title={t('propertyPanel.measureAgainTooltip')}
          disabled={!readiness.ready}
          onClick={() => {
            useAppStore.getState().measureSelection();
          }}
        >
          {t('propertyPanel.measureAgain')}
        </button>
      </div>
    </div>
  );
}

/**
 * 「質量特性」の節(FR-1101、§0.a-0.31、§0.a-0.32、計画書タスク32)。立体を 1 つ選んで
 * いるときだけ出す。
 *
 * **材料と密度はこの節が持つ**(文書には保存しない)。密度を変えるたびに文書が変わると
 * 取り消しの段が積まれ、形が変わっていないのに再計算の判定を通ることになるため
 * (rules/04-設計の規律.md「導出できるものは保存しない」)。立体を選び直すと `key` で
 * 作り直され、その立体の**外観のプリセットに対応する材料**から始まる(§0.a-0.31)。
 *
 * 体積・重心・慣性モーメントはカーネルが測った密度なしの値で、**密度の掛け算は model の
 * 関数だけ**を通す(`massPropertiesView` → `massFromVolume` / `inertiaWithDensity`。
 * 統括の決定: 密度の掛け算は model の 1 か所)。
 */
export function MassPropertiesSection({
  spec,
}: {
  readonly spec: AppearanceSpec;
}): React.JSX.Element {
  const massProperties = useAppStore((state) => state.massProperties);
  const units = useFieldUnits();
  const [materialId, setMaterialId] = useState(() =>
    defaultDensityMaterialId(spec.preset, spec.pattern.kind === 'woodGrain' ? spec.pattern.species : null),
  );
  /** 密度の欄の式。材料を選び直すとその材料の密度で置き換わる(式で上書きもできる)。 */
  const [densitySource, setDensitySource] = useState(() => String(densityOf(materialId)));

  const evaluated = evaluateExpression(densitySource, units);
  const density = evaluated.ok ? evaluated.value.value : densityOf(materialId);
  const view = massProperties === null ? null : massPropertiesView(massProperties, density);

  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionMassProperties')}</h3>
      <AppearanceMenu
        groupLabelKey="propertyPanel.massMaterial"
        value={materialId}
        options={DENSITY_MATERIALS.map((material) => ({
          value: material.id,
          labelKey: densityMaterialLabelKey(material.id),
        }))}
        onChoose={(value) => {
          setMaterialId(value);
          // 材料を選び直したら、密度の欄もその材料の値へ戻す(打った式は上書きされる)。
          setDensitySource(String(densityOf(value)));
        }}
      />
      <div className="pcad-coordinate__fields">
        <div className={evaluated.ok ? 'pcad-field' : 'pcad-field pcad-field--error'}>
          <span className="pcad-field__label" title={t('propertyPanel.massDensity')}>
            {t('propertyPanel.massDensity')}
          </span>
          <input
            className="pcad-field__input"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={densitySource}
            aria-invalid={!evaluated.ok}
            title={t('propertyPanel.massDensity')}
            onChange={(event) => {
              setDensitySource(event.target.value);
            }}
          />
          <span className="pcad-field__unit">
            {t('propertyPanel.unitGramPerCubicCentimeter')}
          </span>
          <p
            className={
              evaluated.ok ? 'pcad-field__message' : 'pcad-field__message pcad-field__message--error'
            }
          >
            {evaluated.ok ? `= ${evaluated.value.display}` : evaluated.error.message}
          </p>
        </div>
      </div>
      {massProperties === null || view === null ? (
        <p className="pcad-panel__note">{t('propertyPanel.massNotYet')}</p>
      ) : (
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.massVolume')}</dt>
          <dd className="pcad-properties__value">
            {`${formatVolume(massProperties.volume, units.lengthUnit)} ${t(VOLUME_UNIT_KEYS[units.lengthUnit])}`}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.massArea')}</dt>
          <dd className="pcad-properties__value">
            {`${formatArea(massProperties.area, units.lengthUnit)} ${t(AREA_UNIT_KEYS[units.lengthUnit])}`}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.massMass')}</dt>
          <dd className="pcad-properties__value">{formatMass(view.mass)}</dd>
          <dt className="pcad-properties__key">{t('propertyPanel.massCentre')}</dt>
          <dd className="pcad-properties__value">
            {formatMeasurePoint(massProperties.centreOfMass)}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.massInertia')}</dt>
          <dd className="pcad-properties__value">{formatMoments(view.moments)}</dd>
        </dl>
      )}
    </div>
  );
}
