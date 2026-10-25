import { strengthCalculationFields } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { STRENGTH_FIELD_LABELS, strengthExpressionField } from './strengthFields.js';
import { StrengthMaterialFields } from './StrengthMaterialFields.js';
import { StrengthOptions } from './StrengthOptions.js';
import { StrengthResults } from './StrengthResults.js';
import { evaluateStrengthSession, type StrengthSession } from './strengthSession.js';
import './strength.css';

export function StrengthPanel({ session }: { readonly session: StrengthSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const edit = useAppStore(state => state.editStrength);
  const openSolidAnalysis = useAppStore(state => state.openSolidAnalysis);
  const openSolidPlastic = useAppStore(state => state.openSolidPlastic);
  const openBeam = useAppStore(state => state.openBeam);
  const openPlasticBar = useAppStore(state => state.openPlasticBar);
  const openFatigue = useAppStore(state => state.openFatigue);
  const openFatigueStrain = useAppStore(state => state.openFatigueStrain);
  const openFatigueLocalCycle = useAppStore(state => state.openFatigueLocalCycle);
  const assembly = useAppStore(state => state.assembly);
  const calculate = useAppStore(state => state.calculateStrength);
  const close = useAppStore(state => state.closeStrength);
  const help = useAppStore(state => state.openHelpTopic);
  const evaluation = evaluateStrengthSession(session, parameters);
  return <form className="pcad-panel__body pcad-strength" aria-label={t('strength.title')} data-help-topic="strength"
    onSubmit={event => { event.preventDefault(); calculate(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <h3 className="pcad-section__title">{t('strength.title')}</h3>
    <details><summary>{t('strength.help')}</summary><p>{t('strength.assumptions')}</p></details>
    {assembly === null ? null : <button type="button" className="pcad-button" data-testid="beam-open"
      title={t('beam.openHelp')} onClick={openBeam}>{t('beam.open')}</button>}
    <button type="button" className="pcad-button" data-testid="plastic-bar-open"
      title={t('plasticBar.openHelp')} onClick={openPlasticBar}>{t('plasticBar.open')}</button>
    <button type="button" className="pcad-button" data-testid="fatigue-open"
      title={t('fatigue.openHelp')} onClick={openFatigue}>{t('fatigue.open')}</button>
    <button type="button" className="pcad-button" data-testid="fatigue-strain-open"
      onClick={openFatigueStrain} title={t('fatigueStrain.openHelp')}>{t('fatigueStrain.open')}</button>
    <button type="button" className="pcad-button" data-testid="fatigue-local-cycle-open"
      onClick={openFatigueLocalCycle} title={t('fatigueLocalCycle.openHelp')}>{t('fatigueLocalCycle.open')}</button>
    {assembly === null ? <button type="button" className="pcad-button" data-testid="solid-analysis-open"
      onClick={openSolidAnalysis} title={t('solidAnalysis.openHelp')}>{t('solidAnalysis.open')}</button> : null}
    {assembly === null ? <button type="button" className="pcad-button" data-testid="solid-plastic-open"
      onClick={openSolidPlastic} title={t('solidPlastic.openHelp')}>{t('solidPlastic.open')}</button> : null}
    <StrengthOptions session={session} edit={edit} />
    <StrengthMaterialFields session={session} parameters={parameters} edit={edit} />
    {strengthCalculationFields(session.calculation).filter(([name]) => name !== 'tensileArea').map(([name, quantity, allowZero]) =>
      <ExpressionField key={name}
        {...strengthExpressionField(session, parameters, name, quantity, STRENGTH_FIELD_LABELS[name], session.sources.get(name) ?? '', allowZero)}
        lengthUnit={session.lengthUnit} focused={session.focusedField === name}
        onFocus={() => edit({ kind: 'focus', field: name })} onChange={source => edit({ kind: 'source', field: name, source })} />)}
    {evaluation.ok ? null : <p role="alert" className="pcad-field__message--error">{evaluation.message}</p>}
    <div className="pcad-strength__actions">
      <button type="submit" className="pcad-button pcad-button--primary" disabled={!evaluation.ok} title={evaluation.ok ? t('strength.tooltip') : evaluation.message}>
        {t(session.result === null ? 'strength.calculate' : 'strength.recalculate')}</button>
      <button type="button" className="pcad-button" title={t('strength.guide.close')} onClick={close}>{t('strength.close')}</button>
      <button type="button" className="pcad-button" title={t('strength.guide.help')} onClick={() => help('strength')}>{t('strength.help')}</button>
    </div>
    {session.result === null ? null : <StrengthResults snapshot={session.result} edited={session.edited} />}
  </form>;
}
