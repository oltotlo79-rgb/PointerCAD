import { useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { solidExpressionField } from '../solidAnalysis/solidAnalysisSession.js';
import type { SolidPlasticField, SolidPlasticSession } from './solidPlasticSession.js';

type Vector6 = readonly [number, number, number, number, number, number];
/** von Mises equivalent stress of a Voigt stress vector [xx, yy, zz, yz, xz, xy] (same formula as SolidAnalysisPanel). */
function vonMises([x, y, z, yz, xz, xy]: Vector6): number {
  return Math.hypot((x - y) / Math.SQRT2, (y - z) / Math.SQRT2, (z - x) / Math.SQRT2,
    Math.sqrt(3) * xy, Math.sqrt(3) * yz, Math.sqrt(3) * xz);
}
/** Equivalent plastic strain sqrt(2/3 e:e) of a Voigt vector with engineering shear (tensor shear = gamma / 2). */
function equivalentStrain([x, y, z, yz, xz, xy]: Vector6): number {
  return Math.sqrt((2 / 3) * (x * x + y * y + z * z + (yz * yz + xz * xz + xy * xy) / 2));
}
/** [session field, linear field kind used for the unit/expression rules, literal label key (MessageKey)]. */
const EXPRESSION_FIELDS = [['young', 'young', 'solidPlastic.young'], ['poisson', 'poisson', 'solidPlastic.poisson'],
  ['yield', 'young', 'solidPlastic.yield'], ['hardening', 'tx', 'solidPlastic.hardening'], ['tx', 'tx', 'solidPlastic.tx'],
  ['ty', 'ty', 'solidPlastic.ty'], ['tz', 'tz', 'solidPlastic.tz'], ['linear', 'linear', 'solidPlastic.linear'],
  ['angular', 'angular', 'solidPlastic.angular'], ['chord', 'chord', 'solidPlastic.chord'],
  ['volume', 'volume', 'solidPlastic.volume']] as const satisfies readonly (readonly [SolidPlasticField, string, MessageKey])[];

export function SolidPlasticPanel({ session }: { readonly session: SolidPlasticSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.document.parameters);
  const runner = useAppStore(state => state.solidPlasticRunner);
  const edit = useAppStore(state => state.editSolidPlastic);
  const focus = useAppStore(state => state.focusSolidPlastic);
  const close = useAppStore(state => state.closeSolidPlastic);
  const cancel = useAppStore(state => state.cancelSolidPlastic);
  const save = useAppStore(state => state.saveSolidPlastic);
  const composing = useRef(false);
  const result = session.result;
  const text = (name: Extract<SolidPlasticField, 'steps' | 'history' | 'reference'>, labelKey: MessageKey) =>
    <label key={name}>{t(labelKey)}
      <input value={session.values[name]} data-testid={`solid-plastic-${name}`} onFocus={() => focus(name)}
        onChange={event => edit(name, event.currentTarget.value)} title={t(name === 'reference' ? 'solidPlastic.guide.reference' : name === 'history' ? 'solidPlastic.guide.history' : 'solidPlastic.guide.steps')} /></label>;
  return <form className="pcad-panel__body pcad-strength" aria-label={t('solidPlastic.title')} data-testid="solid-plastic-panel"
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }} onSubmit={event => { event.preventDefault(); }}>
    <h3>{t('solidPlastic.title')}</h3>
    <p>{t('solidPlastic.assumptions')}</p>
    <p>{t('solidPlastic.selectionHelp')}</p>
    <p>{t('solidPlastic.body')}: {session.bodyFeatureId ?? t('solidPlastic.none')}</p>
    <button type="button" className="pcad-button" data-testid="solid-plastic-fixed" onClick={() => runner?.captureFaces('fixed')} title={t('solidPlastic.guide.fixed')}>
      {t('solidPlastic.fixed')} ({session.fixedFaces.length})</button>
    <button type="button" className="pcad-button" data-testid="solid-plastic-loaded" onClick={() => runner?.captureFaces('loaded')} title={t('solidPlastic.guide.loaded')}>
      {t('solidPlastic.loaded')} ({session.loadedFaces.length})</button>
    {EXPRESSION_FIELDS.map(([name, kind, labelKey]) => {
      const field = solidExpressionField(kind, session.values[name], parameters);
      return <ExpressionField key={name} {...field} field={{ ...field.field, labelKey }}
        focused={session.focused === name} onFocus={() => focus(name)} onChange={value => edit(name, value)} />;
    })}
    {text('reference', 'solidPlastic.reference')}
    <p>{t('solidPlastic.referenceHelp')}</p>
    {text('history', 'solidPlastic.history')}
    <p>{t('solidPlastic.historyHelp')}</p>
    {text('steps', 'solidPlastic.steps')}
    {session.error === null ? null : <p role="alert">{session.error}</p>}
    {session.status === 'running' ? <p role="status">{t('solidPlastic.running')}</p> : null}
    {session.status === 'cancelled' ? <p role="status">{t('solidPlastic.cancelled')}</p> : null}
    <button type="button" className="pcad-button pcad-button--primary" data-testid="solid-plastic-run"
      onClick={() => { if (!composing.current) runner?.run(); }}
      disabled={runner === null || session.status === 'running'} title={t('solidPlastic.guide.run')}>{t('solidPlastic.run')}</button>
    <button type="button" className="pcad-button" onClick={cancel} disabled={session.status !== 'running'} title={t('solidPlastic.guide.cancel')}>{t('solidPlastic.cancel')}</button>
    <button type="button" className="pcad-button" data-testid="solid-plastic-save" onClick={save} title={t('solidPlastic.guide.save')}>{t('solidPlastic.save')}</button>
    <button type="button" className="pcad-button" onClick={close} title={t('solidPlastic.guide.close')}>{t('solidPlastic.close')}</button>
    {result === null ? null : <section aria-label={t('solidPlastic.results')} data-testid="solid-plastic-results">
      <h4>{t('solidPlastic.results')}</h4>
      <p>{t(result.result.yielded ? 'solidPlastic.yielded' : 'solidPlastic.notYielded')}</p>
      <table>
        <thead><tr><th>{t('solidPlastic.factor')}</th><th>{t('solidPlastic.displacement')} (mm)</th>
          <th>{t('solidPlastic.stress')} (MPa)</th><th>{t('solidPlastic.plastic')}</th><th>{t('solidPlastic.residual')}</th></tr></thead>
        <tbody>{result.result.records.map(record => <tr key={record.step}>
          <td>{record.loadFactor}</td>
          <td>{record.displacementMm.reduce((maximum, vector) => Math.max(maximum, Math.hypot(...vector)), 0)}</td>
          <td>{record.elements.reduce((maximum, element) => Math.max(maximum, vonMises(element.stressMPa)), 0)}</td>
          <td>{record.elements.reduce((maximum, element) => Math.max(maximum, equivalentStrain(element.plasticStrain)), 0)}</td>
          <td>{record.freeResidualRatio}</td></tr>)}</tbody>
      </table>
      <p>{t('solidPlastic.resultLimit')}</p>
    </section>}
  </form>;
}
