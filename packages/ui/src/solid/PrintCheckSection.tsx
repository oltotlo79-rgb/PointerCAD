import { useId } from 'react';
import { formatDisplayLength } from '@pointercad/model';
import { withCount } from '../shell/propertySectionText.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { useFieldUnits } from '../shell/propertyFieldUnits.js';
import { evaluatePrintCheckDraft } from './printCheckCommands.js';

/**
 * 「3D プリントの点検」の節(FR-815、§0.53、§2.16)。
 *
 * 43b が結果の入れ物を描き、タスク46 が点検を走らせる入口(ツールバーの「表示」)と
 * 色の層をつないだ。点検をまだ 1 度もしていなければ `printability` は `null` で、
 * 「まだ点検していません。」と説明だけが出る。
 * 数の意味は model の `PrintabilitySummary` の注釈のとおり。
 */
export function PrintCheckSection(): React.JSX.Element {
  const report = useAppStore((state) => state.printability);
  const draft = useAppStore(state => state.printCheckDraft);
  const running = useAppStore(state => state.isInspectingPrint);
  const units = useFieldUnits();
  const evaluated = evaluatePrintCheckDraft(draft, units);
  const thicknessId = useId();
  const angleId = useId();
  const thicknessInvalid = evaluated.thicknessError !== null && !evaluated.thicknessPending;
  const angleInvalid = evaluated.angleError !== null && !evaluated.anglePending;
  return (
    <div className="pcad-section">
      <h3 className="pcad-section__title">{t('propertyPanel.sectionPrintCheck')}</h3>
      <div className="pcad-section__fields">
        <div className={thicknessInvalid ? 'pcad-field pcad-field--error' : 'pcad-field'}>
          <label className="pcad-field__label" htmlFor={thicknessId}>{t('propertyPanel.printCheckThicknessInput')}</label>
          <input id={thicknessId} className="pcad-field__input" type="text" autoComplete="off" spellCheck={false}
            title={t('propertyPanel.printCheckThicknessTooltip')}
            value={draft.minThicknessSource} disabled={running} aria-invalid={thicknessInvalid}
            aria-describedby={`${thicknessId}-message`}
            onChange={event => {
              useAppStore.getState().setPrintCheckDraft({ ...draft, minThicknessSource: event.target.value,
                minThicknessUnit: units.lengthUnit });
            }} />
          <span className="pcad-field__unit">{t(draft.minThicknessUnit === 'mm' ? 'measure.unit.millimeter' : 'measure.unit.inch')}</span>
          <p id={`${thicknessId}-message`} className={thicknessInvalid ? 'pcad-field__message pcad-field__message--error' : 'pcad-field__message'}>
            {evaluated.thicknessError ?? (evaluated.thicknessMm === null ? '' : `= ${formatDisplayLength(evaluated.thicknessMm, units.lengthUnit)}`)}
          </p>
        </div>
        <div className={angleInvalid ? 'pcad-field pcad-field--error' : 'pcad-field'}>
          <label className="pcad-field__label" htmlFor={angleId}>{t('propertyPanel.printCheckAngleInput')}</label>
          <input id={angleId} className="pcad-field__input" type="text" autoComplete="off" spellCheck={false}
            title={t('propertyPanel.printCheckAngleHint')}
            value={draft.overhangAngleSource} disabled={running} aria-invalid={angleInvalid}
            aria-describedby={`${angleId}-message ${angleId}-hint`}
            onChange={event => { useAppStore.getState().setPrintCheckDraft({ ...draft, overhangAngleSource: event.target.value }); }} />
          <span className="pcad-field__unit">{t('measure.unit.degree')}</span>
          <p id={`${angleId}-message`} className={angleInvalid ? 'pcad-field__message pcad-field__message--error' : 'pcad-field__message'}>
            {evaluated.angleError ?? (evaluated.angleDeg === null ? '' : `= ${evaluated.angleDeg} ${t('measure.unit.degree')}`)}
          </p>
        </div>
      </div>
      <p id={`${angleId}-hint`} className="pcad-panel__note">{t('propertyPanel.printCheckAngleHint')}</p>
      <div className="pcad-appearance__actions">
        <button type="button" className="pcad-button" disabled={!running && evaluated.criteria === null}
          title={t(running ? 'propertyPanel.printCheckCancelTooltip' : 'propertyPanel.printCheckRunTooltip')}
          onClick={() => { useAppStore.getState().inspectPrintability(); }}>
          {t(running ? 'propertyPanel.printCheckCancel' : report === null ? 'propertyPanel.printCheckRun' : 'propertyPanel.printCheckAgain')}
        </button>
      </div>
      {running && report !== null && <p className="pcad-panel__note" role="status">{t('propertyPanel.printCheckRunning')}</p>}
      {report === null ? (
        <p className="pcad-panel__note">{t('propertyPanel.printCheckNotYet')}</p>
      ) : (
        <dl className="pcad-properties">
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckUsedThickness')}</dt>
          <dd className="pcad-properties__value">{formatDisplayLength(report.summary.minThicknessMm, units.lengthUnit)}</dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckUsedAngle')}</dt>
          <dd className="pcad-properties__value">{`${report.summary.overhangAngleDeg} ${t('measure.unit.degree')}`}</dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckWatertight')}</dt>
          <dd className="pcad-properties__value">
            {t(
              report.summary.watertight
                ? 'propertyPanel.printCheckWatertightYes'
                : 'propertyPanel.printCheckWatertightNo',
            )}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckThin')}</dt>
          <dd className="pcad-properties__value">
            {withCount('propertyPanel.printCheckPlaceCount', report.summary.thinCount)}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckOverhang')}</dt>
          <dd className="pcad-properties__value">
            {withCount('propertyPanel.printCheckPlaceCount', report.summary.overhangCount)}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckOpenEdges')}</dt>
          <dd className="pcad-properties__value">
            {withCount('propertyPanel.printCheckPlaceCount', report.summary.openEdgeCount)}
          </dd>
          <dt className="pcad-properties__key">{t('propertyPanel.printCheckMinThickness')}</dt>
          <dd className="pcad-properties__value">
            {report.summary.minThicknessFoundMm === null
              ? t('propertyPanel.printCheckUnknown')
              : formatDisplayLength(report.summary.minThicknessFoundMm, units.lengthUnit)}
          </dd>
        </dl>
      )}
      {report !== null && (
        <>
          {/* 色と意味の対応(§0.53)。ヘルプ(`print-check.md`)と同じ言い方にそろえる。 */}
          <p className="pcad-panel__note">{t('propertyPanel.printCheckColors')}</p>
          <div className="pcad-appearance__actions">
            <button
              type="button"
              className="pcad-button"
              title={t('propertyPanel.printCheckCloseTooltip')}
              onClick={() => {
                // 閉じると色が消えて元の外観に戻る(形も体積も 1 つも変わらない、§0.53)。
                useAppStore.getState().setPrintability(null);
              }}
            >
              {t('propertyPanel.printCheckClose')}
            </button>
          </div>
        </>
      )}
      <p className="pcad-panel__note">
        {report !== null && report.cancelled
          ? t('propertyPanel.printCheckCancelled')
          : t('propertyPanel.printCheckHint')}
      </p>
    </div>
  );
}
