import { createSubShapeReference } from '@pointercad/model';
import { solidCadFaceKey } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import type { SolidFiniteSession } from './solidFiniteSession.js';
import { createSolidBoundaryDraft, SOLID_BOUNDARY_AXES, SOLID_BOUNDARY_INDEX,
  solidGravityExpressionField, solidSupportExpressionField } from '../solidAnalysis/solidBoundaryDraft.js';

const AXIS_LABELS = { x: 'solidAnalysis.supportFixedX', y: 'solidAnalysis.supportFixedY', z: 'solidAnalysis.supportFixedZ' } as const;
export function SolidFiniteBoundaryFields({ session }: { readonly session: SolidFiniteSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.document.parameters);
  const bodies = useAppStore(state => state.bodies);
  const runner = useAppStore(state => state.solidFiniteRunner);
  const edit = useAppStore(state => state.editSolidFinite);
  const focus = useAppStore(state => state.focusSolidFiniteBoundary);
  const openHelp = useAppStore(state => state.openHelpTopic);
  const supports = session.supports ?? [], gravity = session.gravity ?? createSolidBoundaryDraft().gravity;
  const body = bodies.find(value => value.featureId === session.bodyFeatureId);
  const labels = new Map<string, number | null>();
  for (const face of body?.faces ?? []) {
    if (!body) break;
    const reference = createSubShapeReference(body, 'face', face.index);
    if (reference?.origin) {
      const key = solidCadFaceKey(reference);
      labels.set(key, labels.has(key) ? null : face.index + 1);
    }
  }
  const faceName = (key: string, index: number): string => typeof labels.get(key) === 'number'
    ? `${t('solidAnalysis.face')} ${labels.get(key)}` : `${t('solidAnalysis.savedFace')} ${index + 1}`;
  return <section aria-label={t('solidAnalysis.boundaryTitle')} data-testid="solid-finite-boundary-fields" data-help-topic="strength">
    <h4>{t('solidAnalysis.boundaryTitle')}</h4>
    <p>{t('solidAnalysis.supportHelp')}</p>
    {session.fixedFaces.map((face, index) => <div key={face} data-testid={`solid-clamp-${index}`}>
      <span>{faceName(face, index)} — {t('solidAnalysis.fullClamp')}</span>
      <button type="button" className="pcad-button" onClick={() => edit({ kind: 'convert-clamp', face })} title={t('solidAnalysis.supportConvertHelp')}
        data-testid={`solid-clamp-convert-${index}`}>{t('solidAnalysis.supportConvert')}</button>
      <button type="button" className="pcad-button" onClick={() => edit({ kind: 'remove-clamp', face })} title={t('solidAnalysis.supportRemoveHelp')}
        data-testid={`solid-clamp-remove-${index}`}>{t('solidAnalysis.supportRemove')}</button>
    </div>)}
    <button type="button" className="pcad-button" data-testid="solid-support-add" disabled={runner === null}
      onClick={() => runner?.captureFaces('support')} title={t('solidAnalysis.supportAddHelp')}>{t('solidAnalysis.supportAdd')}</button>
    {supports.map((row, rowIndex) => <fieldset key={row.face} data-testid={`solid-support-${rowIndex}`}>
      <legend>{faceName(row.face, rowIndex)} — {t('solidAnalysis.axisSupport')}</legend>
      {SOLID_BOUNDARY_AXES.map(axis => {
        const index = SOLID_BOUNDARY_INDEX[axis], key = `solid-support-${rowIndex}-${axis}`;
        return <div key={axis}>
          <label><input type="checkbox" checked={row.fixed[index]} data-testid={`${key}-fixed`}
            onChange={event => edit({ kind: 'support', face: row.face, axis, fixed: event.currentTarget.checked })}
            title={t('solidAnalysis.supportFixedHelp')} />{t(AXIS_LABELS[axis])}</label>
          {row.fixed[index] ? <ExpressionField {...solidSupportExpressionField(axis, key, row.displacement[index], parameters)}
            focused={session.boundaryFocused === key} onFocus={() => focus(key)}
            onChange={displacement => edit({ kind: 'support', face: row.face, axis, displacement })} />
            : <output data-testid={`${key}-free`}>{t('solidAnalysis.freeAxis')}</output>}
        </div>;
      })}
      {row.fixed.some(Boolean) ? null : <p role="alert">{t('solidAnalysis.supportAllFree')}</p>}
      <button type="button" className="pcad-button" onClick={() => edit({ kind: 'remove-support', face: row.face })}
        data-testid={`solid-support-remove-${rowIndex}`} title={t('solidAnalysis.supportRemoveHelp')}>{t('solidAnalysis.supportRemove')}</button>
    </fieldset>)}
    <fieldset data-testid="solid-gravity">
      <legend>{t('solidAnalysis.gravityTitle')}</legend>
      <label><input type="checkbox" checked={gravity.enabled} data-testid="solid-gravity-enabled"
        onChange={event => edit({ kind: 'gravity-enabled', enabled: event.currentTarget.checked })} title={t('solidAnalysis.gravityToggleHelp')} />{t('solidAnalysis.gravityEnabled')}</label>
      <p>{t('solidAnalysis.gravityHelp')}</p>
      {gravity.enabled ? <>
        {([...SOLID_BOUNDARY_AXES, 'density'] as const).map(name => {
          const source = name === 'density' ? gravity.density : gravity.acceleration[SOLID_BOUNDARY_INDEX[name]];
          const field = solidGravityExpressionField(name, source, parameters);
          return <ExpressionField key={name} {...field} focused={session.boundaryFocused === field.field.key}
            onFocus={() => focus(field.field.key)} onChange={value => edit({ kind: 'gravity', field: name, value })} />;
        })}
        <button type="button" className="pcad-button" data-testid="solid-loaded-clear" onClick={() => edit({ kind: 'clear-loaded' })}
          disabled={session.loadedFaces.length === 0} title={t('solidAnalysis.gravityOnlyHelp')}>{t('solidAnalysis.gravityOnly')}</button>
      </> : null}
    </fieldset>
    {(supports.length > 0 || gravity.enabled) ? <p>{t('solidAnalysis.boundaryOtherAnalyses')}</p> : null}
    <button type="button" className="pcad-button" data-testid="solid-boundary-help" onClick={() => { openHelp('strength'); }}
      title={t('solidAnalysis.boundaryHelpTitle')}>{t('solidAnalysis.boundaryHelp')}</button>
  </section>;
}
