import { useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { SHELL_DOFS, SHELL_FIELDS, SHELL_LOAD_COMPONENTS, SHELL_MATERIAL_SOURCE_KINDS, SHELL_STRESS_COMPONENTS,
  shellExpressionField, shellLoadExpressionField, shellNumberText, shellSavedInput, summarizeShellResult,
  type ShellAnalysisSession, type ShellMaterialSourceKind, type ShellStressComponent } from './shellAnalysisSession.js';

const DOF_LABELS = { ux: 'shellAnalysis.dofUx', uy: 'shellAnalysis.dofUy', uz: 'shellAnalysis.dofUz',
  rx: 'shellAnalysis.dofRx', ry: 'shellAnalysis.dofRy', rz: 'shellAnalysis.dofRz' } as const satisfies Readonly<Record<string, MessageKey>>;
const SOURCE_LABELS = { 'user-supplied': 'shellAnalysis.sourceUser', measured: 'shellAnalysis.sourceMeasured',
  published: 'shellAnalysis.sourcePublished' } as const satisfies Readonly<Record<ShellMaterialSourceKind, MessageKey>>;
const COMPONENT_LABELS = { xx: 'shellAnalysis.stressXx', yy: 'shellAnalysis.stressYy', zz: 'shellAnalysis.stressZz',
  yz: 'shellAnalysis.stressYz', xz: 'shellAnalysis.stressXz', xy: 'shellAnalysis.stressXy',
} as const satisfies Readonly<Record<ShellStressComponent, MessageKey>>;
function isSourceKind(value: string): value is ShellMaterialSourceKind { return SHELL_MATERIAL_SOURCE_KINDS.some(kind => kind === value); }
function isComponent(value: string): value is ShellStressComponent { return SHELL_STRESS_COMPONENTS.some(kind => kind === value); }

/** Thin-sheet (shell) analysis panel: every physical input explicit, every run state shown, no value invented. */
export function ShellAnalysisPanel({ session }: { readonly session: ShellAnalysisSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.document.parameters);
  const documentId = useAppStore(state => state.document.id);
  const runner = useAppStore(state => state.shellAnalysisRunner);
  const edit = useAppStore(state => state.editShellAnalysis);
  const editSource = useAppStore(state => state.editShellMaterialSource);
  const setFixed = useAppStore(state => state.setShellSupportFixed);
  const removeSupport = useAppStore(state => state.removeShellSupport);
  const editLoad = useAppStore(state => state.editShellEdgeLoad);
  const removeLoad = useAppStore(state => state.removeShellEdgeLoad);
  const clearMidsurface = useAppStore(state => state.clearShellMidsurface);
  const focus = useAppStore(state => state.focusShellAnalysis);
  const close = useAppStore(state => state.closeShellAnalysis);
  const cancel = useAppStore(state => state.cancelShellAnalysis);
  const save = useAppStore(state => state.saveShellAnalysis);
  const setView = useAppStore(state => state.setShellAnalysisView);
  const setSelectionKind = useAppStore(state => state.setSelectionKind);
  const composing = useRef(false);
  let inputProblem: string | null = null;
  try { shellSavedInput(session, documentId, parameters); } catch (error) {
    inputProblem = error instanceof Error ? error.message : t('shellAnalysis.invalidInput');
  }
  const ready = inputProblem === null;
  const summary = session.result === null ? null : summarizeShellResult(session.result, session.view.component);
  return <form className="pcad-panel__body pcad-strength" aria-label={t('shellAnalysis.title')} data-testid="shell-analysis-panel"
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }} onSubmit={event => { event.preventDefault(); }}>
    <h3>{t('shellAnalysis.title')}</h3>
    <p data-testid="shell-assumptions">{t('shellAnalysis.assumptions')}</p>
    <p>{t('shellAnalysis.unsupported')}</p>
    <fieldset data-testid="shell-midsurface">
      <legend>{t('shellAnalysis.midsurface')}</legend>
      <p>{t('shellAnalysis.midsurfaceHelp')}</p>
      <p>{t('shellAnalysis.body')}: {session.bodyFeatureId ?? t('shellAnalysis.none')} / {t('shellAnalysis.faceCount')}: {session.midsurfaceFaces.length}</p>
      <button type="button" className="pcad-button" onClick={() => setSelectionKind('face')} title={t('shellAnalysis.guide.pickFaces')}>
        {t('shellAnalysis.pickFaces')}</button>
      <button type="button" className="pcad-button" data-testid="shell-capture-midsurface" onClick={() => runner?.capture('midsurface')}
        disabled={runner === null} title={t('shellAnalysis.guide.captureMidsurface')}>{t('shellAnalysis.captureMidsurface')}</button>
      <button type="button" className="pcad-button" data-testid="shell-clear-midsurface" onClick={clearMidsurface}
        disabled={session.midsurfaceFaces.length === 0} title={t('shellAnalysis.guide.clearMidsurface')}>{t('shellAnalysis.clearMidsurface')}</button>
      {(['thickness', 'offset'] as const).map(name => <ExpressionField key={name} {...shellExpressionField(name, session.values[name], parameters)}
        focused={session.focused === name} onFocus={() => focus(name)} onChange={value => edit(name, value)} />)}
      <p>{t('shellAnalysis.offsetHelp')}</p>
    </fieldset>
    <fieldset data-testid="shell-material">
      <legend>{t('shellAnalysis.material')}</legend>
      <p>{t('shellAnalysis.materialHelp')}</p>
      {(['young', 'poisson'] as const).map(name => <ExpressionField key={name} {...shellExpressionField(name, session.values[name], parameters)}
        focused={session.focused === name} onFocus={() => focus(name)} onChange={value => edit(name, value)} />)}
      <label>{t('shellAnalysis.sourceKind')}
        <select data-testid="shell-source-kind" value={session.materialSource.kind ?? ''} title={t('shellAnalysis.guide.sourceKind')}
          onChange={event => { const value = event.target.value; editSource({ kind: isSourceKind(value) ? value : null }); }}>
          <option value="">{t('shellAnalysis.sourceNone')}</option>
          {SHELL_MATERIAL_SOURCE_KINDS.map(kind => <option key={kind} value={kind}>{t(SOURCE_LABELS[kind])}</option>)}
        </select></label>
      <label>{t('shellAnalysis.sourceReference')}
        <input type="text" data-testid="shell-source-reference" value={session.materialSource.reference}
          onChange={event => editSource({ reference: event.target.value })} title={t('shellAnalysis.guide.sourceReference')} /></label>
      <label>{t('shellAnalysis.sourceCondition')}
        <input type="text" data-testid="shell-source-condition" value={session.materialSource.condition}
          onChange={event => editSource({ condition: event.target.value })} title={t('shellAnalysis.guide.sourceCondition')} /></label>
    </fieldset>
    <fieldset data-testid="shell-supports">
      <legend>{t('shellAnalysis.supports')}</legend>
      <p>{t('shellAnalysis.supportHelp')}</p>
      <button type="button" className="pcad-button" onClick={() => setSelectionKind('edge')} title={t('shellAnalysis.guide.pickEdges')}>
        {t('shellAnalysis.pickEdges')}</button>
      <button type="button" className="pcad-button" onClick={() => setSelectionKind('vertex')} title={t('shellAnalysis.guide.pickVertices')}>
        {t('shellAnalysis.pickVertices')}</button>
      <button type="button" className="pcad-button" data-testid="shell-capture-support" onClick={() => runner?.capture('support')}
        disabled={runner === null} title={t('shellAnalysis.guide.captureSupport')}>{t('shellAnalysis.captureSupport')}</button>
      {session.supports.map((row, position) => <div key={row.key} data-testid="shell-support-row" role="group"
        aria-label={`${t(row.kind === 'edge' ? 'shellAnalysis.supportEdge' : 'shellAnalysis.supportVertex')} ${position + 1}`}>
        <span>{t(row.kind === 'edge' ? 'shellAnalysis.supportEdge' : 'shellAnalysis.supportVertex')} {position + 1}</span>
        {SHELL_DOFS.map((dof, index) => <label key={dof}>
          <input type="checkbox" data-testid={`shell-support-${dof}`} checked={row.fixed[index]}
            onChange={event => setFixed(row.key, dof, event.target.checked)} title={t('shellAnalysis.guide.dof')} />{t(DOF_LABELS[dof])}</label>)}
        {row.fixed.some(Boolean) ? null : <p role="alert">{t('shellAnalysis.needFixedDof')}</p>}
        <button type="button" className="pcad-button" onClick={() => removeSupport(row.key)} title={t('shellAnalysis.guide.remove')}>
          {t('shellAnalysis.remove')}</button>
      </div>)}
    </fieldset>
    <fieldset data-testid="shell-loads">
      <legend>{t('shellAnalysis.loads')}</legend>
      <p>{t('shellAnalysis.loadHelpText')}</p>
      <button type="button" className="pcad-button" data-testid="shell-capture-load" onClick={() => runner?.capture('load')}
        disabled={runner === null} title={t('shellAnalysis.guide.captureLoad')}>{t('shellAnalysis.captureLoad')}</button>
      {session.edgeLoads.map((row, position) => <div key={row.key} data-testid="shell-load-row" role="group"
        aria-label={`${t('shellAnalysis.loadEdge')} ${position + 1}`}>
        <span>{t('shellAnalysis.loadEdge')} {position + 1}</span>
        {SHELL_LOAD_COMPONENTS.map(component => <ExpressionField key={component}
          {...shellLoadExpressionField(row.key, component, row.values[component], parameters)}
          focused={session.focused === `${row.key}:${component}`} onFocus={() => focus(`${row.key}:${component}`)}
          onChange={value => editLoad(row.key, component, value)} />)}
        <button type="button" className="pcad-button" onClick={() => removeLoad(row.key)} title={t('shellAnalysis.guide.remove')}>
          {t('shellAnalysis.remove')}</button>
      </div>)}
    </fieldset>
    <fieldset data-testid="shell-surface">
      <legend>{t('shellAnalysis.surface')}</legend>
      {SHELL_FIELDS.filter(name => !['thickness', 'offset', 'young', 'poisson'].includes(name)).map(name => <ExpressionField key={name}
        {...shellExpressionField(name, session.values[name], parameters)}
        focused={session.focused === name} onFocus={() => focus(name)} onChange={value => edit(name, value)} />)}
      <p>{t('shellAnalysis.surfaceHelp')}</p>
    </fieldset>
    {inputProblem === null ? null : <p data-testid="shell-input-problem">{inputProblem}</p>}
    {session.error === null ? null : <p role="alert" data-testid="shell-error">{session.error}</p>}
    {session.status === 'running' ? <p role="status" data-testid="shell-running">{t('shellAnalysis.running')}</p> : null}
    {session.status === 'cancelled' ? <p role="status" data-testid="shell-cancelled">{t('shellAnalysis.cancelled')}</p> : null}
    <button type="button" className="pcad-button pcad-button--primary" data-testid="shell-run"
      onClick={() => { if (!composing.current && ready) runner?.run(); }}
      disabled={runner === null || session.status === 'running' || !ready} title={t('shellAnalysis.guide.run')}>{t('shellAnalysis.run')}</button>
    <button type="button" className="pcad-button" data-testid="shell-cancel" onClick={cancel} disabled={session.status !== 'running'}
      title={t('shellAnalysis.guide.cancel')}>{t('shellAnalysis.cancel')}</button>
    <button type="button" className="pcad-button" data-testid="shell-save" onClick={() => { if (ready) save(); }} disabled={!ready}
      title={t('shellAnalysis.guide.save')}>{t('shellAnalysis.save')}</button>
    <button type="button" className="pcad-button" onClick={close} title={t('shellAnalysis.guide.close')}>{t('shellAnalysis.close')}</button>
    {summary === null || session.result === null
      ? <p data-testid="shell-empty">{t('shellAnalysis.empty')}</p>
      : <section aria-label={t('shellAnalysis.results')} data-testid="shell-results">
        <h4>{t('shellAnalysis.results')}</h4>
        {summary.finite ? null : <p role="alert" data-testid="shell-not-finite">{t('shellAnalysis.resultNotFinite')}</p>}
        <label>{t('shellAnalysis.stressComponent')}
          <select data-testid="shell-stress-component" value={session.view.component} title={t('shellAnalysis.guide.stressComponent')}
            onChange={event => { if (isComponent(event.target.value)) setView(event.target.value); }}>
            {SHELL_STRESS_COMPONENTS.map(component => <option key={component} value={component}>{t(COMPONENT_LABELS[component])}</option>)}
          </select></label>
        <dl>
          <dt>{t('shellAnalysis.meshSize')}</dt><dd>{summary.nodes} / {summary.elements}</dd>
          <dt>{t('shellAnalysis.maxDisplacement')}</dt><dd data-testid="shell-max-displacement">{shellNumberText(summary.finite ? summary.maximumDisplacementMm : null)} mm</dd>
          <dt>{t('shellAnalysis.maxRotation')}</dt><dd>{shellNumberText(summary.finite ? summary.maximumRotationRad : null)} rad</dd>
          <dt>{t('shellAnalysis.topStress')}</dt><dd data-testid="shell-top-stress">
            {shellNumberText(summary.finite ? summary.topMinimumMPa : null)} … {shellNumberText(summary.finite ? summary.topMaximumMPa : null)} MPa</dd>
          <dt>{t('shellAnalysis.bottomStress')}</dt><dd data-testid="shell-bottom-stress">
            {shellNumberText(summary.finite ? summary.bottomMinimumMPa : null)} … {shellNumberText(summary.finite ? summary.bottomMaximumMPa : null)} MPa</dd>
          <dt>{t('shellAnalysis.reaction')}</dt><dd>{summary.reactionForceN.map(value => shellNumberText(summary.finite ? value : null)).join(', ')} N</dd>
          <dt>{t('shellAnalysis.residual')}</dt><dd>{shellNumberText(summary.finite ? summary.freeResidualRelative : null)} / {shellNumberText(summary.finite ? summary.balanceRelative : null)}</dd>
          <dt>{t('shellAnalysis.offsetShift')}</dt><dd>{session.result.midsurface.shiftMm.map(value => shellNumberText(value)).join(', ')} mm</dd>
        </dl>
        <p>{t('shellAnalysis.resultLimit')}</p>
      </section>}
  </form>;
}
