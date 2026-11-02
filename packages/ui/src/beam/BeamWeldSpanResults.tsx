import { beamWeldSpanContactResultMatches, type BeamWeldSpanContactInput, type BeamWeldSpanContactResult } from '@pointercad/fem';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { BeamContactResults } from './BeamContactResults.js';
import { BeamWeldSpanStressResults } from './BeamWeldSpanStressResults.js';
import { beamDisplayNumber } from './BeamResults.js';
import { beamDefinition, type BeamSession } from './beamSession.js';
import { beamSourceIsCurrent } from './beamSource.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

interface SpanRequest {
  readonly input: BeamWeldSpanContactInput | null;
  readonly result: BeamWeldSpanContactResult;
  readonly owner: string;
}
interface SpanCompletion extends SpanRequest { readonly matches: boolean }

/** A separate full decoder/digest check; never cast a span reply to the endpoint-weld result. */
export function startWeldSpanResultCheck(request: SpanRequest, publish: (value: SpanCompletion) => void,
  matches = beamWeldSpanContactResultMatches): () => void {
  let active = true;
  if (request.input !== null) void matches(request.result, request.input, request.result.inputSha256).then(
    valid => { if (active) publish({ ...request, matches: valid }); },
    () => { if (active) publish({ ...request, matches: false }); },
  );
  return () => { active = false; };
}

export function currentWeldSpanResult(value: SpanCompletion | null, request: SpanRequest): boolean {
  return request.input !== null && value?.matches === true && value.input === request.input
    && value.result === request.result && value.owner === request.owner;
}

/** SI values are preserved in data-value; displayed displacements alone convert m to mm. */
export function WeldSpanResultTable({ result, view }: {
  readonly result: BeamWeldSpanContactResult; readonly view: BeamSession['contactView'];
}): React.JSX.Element {
  const index = Math.min(Math.max(0, view.state), result.states.length - 1), state = result.states[index];
  return <section data-testid="beam-weld-span-results" data-load-factor={state.loadFactor}
    data-structural-certification={result.structuralCertification}>
    <h4>{t('beam.weldLayers')}</h4><p>{t('beam.weldSpanScope')}</p>
    <p>{t('beam.resultScope')}</p>
    {/* The dedicated decoder binds these contact and full-mesh states to the same factor/solution. */}
    <BeamContactResults result={result.contact} view={view} />
    <table data-testid="beam-weld-span-wrenches">
      <thead><tr><th>{t('beam.weldBead')}</th><th>{t('beam.transientQuantity')}</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>{state.welds.flatMap(weld => [
        <tr key={`${weld.id}-force`} data-weld-span={weld.id} data-quantity="forceOnFirstN">
          <th>{weld.id}</th><td>{t('beam.weldForceA')}</td>
          {weld.forceOnFirstN.map((value, axis) => <td key={axis} data-unit="N" data-value={value}>{beamDisplayNumber(value)}</td>)}
        </tr>,
        <tr key={`${weld.id}-moment`} data-weld-span={weld.id} data-quantity="momentAtCenterNm">
          <th>{weld.id}</th><td>{t('beam.weldSpanCenterMoment')}</td>
          {weld.momentAtCenterNm.map((value, axis) => <td key={axis} data-unit="N m" data-value={value}>{beamDisplayNumber(value)}</td>)}
        </tr>,
        <tr key={`${weld.id}-energy`} data-weld-span={weld.id} data-quantity="energyJ">
          <th>{weld.id}</th><td>{t('beam.weldEnergy')}</td>
          <td colSpan={3} data-unit="J" data-value={weld.energyJ}>{beamDisplayNumber(weld.energyJ)}</td>
        </tr>,
      ])}</tbody>
    </table>
    <table data-testid="beam-weld-span-nodal-loads">
      <caption>{t('beam.weldSpanNodalLoads')}</caption>
      <thead><tr><th>{t('beam.weldBead')}</th><th>{t('beam.weldForceA')} / {t('beam.weldForceB')}</th>
        <th>{t('beam.solverNode')}</th><th>Fx (N)</th><th>Fy (N)</th><th>Fz (N)</th>
        <th>Mx (N m)</th><th>My (N m)</th><th>Mz (N m)</th></tr></thead>
      <tbody>{state.welds.flatMap(weld => (['first', 'second'] as const).flatMap(side => weld[side].map((values, i) =>
        <tr key={`${weld.id}-${side}-${i}`} data-weld-span={weld.id} data-side={side} data-node={state.meshNodes[i].number}>
          <th>{weld.id}</th><td>{side === 'first' ? 'A' : 'B'}</td><td>{state.meshNodes[i].number}</td>
          {values.map((value, axis) => <td key={axis} data-component={axis} data-unit={axis < 3 ? 'N' : 'N m'} data-value={value}>
            {beamDisplayNumber(value)}</td>)}
        </tr>)))}</tbody>
    </table>
    <table data-testid="beam-weld-span-mesh">
      <thead><tr><th>{t('beam.solverNode')}</th><th>{t('beam.transientQuantity')}</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>{state.meshNodes.flatMap(node => [
        <tr key={`${node.number}-u`} data-node={node.number} data-quantity="displacement">
          <th>{node.number}</th><td>{t('beam.displacement')}</td>
          {node.displacementM.map((value, axis) => <td key={axis} data-unit="m" data-value={value}>{beamDisplayNumber(value * 1000)}</td>)}
        </tr>,
        <tr key={`${node.number}-r`} data-node={node.number} data-quantity="rotation">
          <th>{node.number}</th><td>{t('beam.rotation')}</td>
          {node.rotationRad.map((value, axis) => <td key={axis} data-unit="rad" data-value={value}>{beamDisplayNumber(value)}</td>)}
        </tr>,
      ])}</tbody>
    </table>
  </section>;
}

/** Parent and this view both require the current reviewed owner; effect cleanup also fences late replies. */
export function BeamWeldSpanResults({ session, result }: {
  readonly session: BeamSession; readonly result: BeamWeldSpanContactResult;
}): React.JSX.Element {
  const current = useAppStore();
  const owned = current.beamSession?.ownerId === session.ownerId && current.beamSession.analysisId === session.analysisId
    && current.beamSession.revision === session.revision && current.beamSession.result === result
    && current.beamSession.reviewed === session.reviewed
    && session.reviewed !== null && beamSourceIsCurrent(session.reviewed, current);
  const input = useMemo(() => {
    if (!owned || session.reviewed === null) return null;
    const draft = beamDefinition(session, session.reviewed, session.reviewed.document.parameters);
    if (!draft.ok) return null;
    const prepared = prepareBeamAnalysis(session.reviewed, draft.definition);
    return prepared.ok && prepared.kind === 'weld-span-contact' ? prepared.input : null;
  }, [owned, session]);
  const owner = JSON.stringify([session.ownerId, session.analysisId, session.revision]);
  const request = useMemo(() => ({ input, result, owner }), [input, result, owner]);
  const [completion, setCompletion] = useState<SpanCompletion | null>(null);
  useEffect(() => startWeldSpanResultCheck(request, setCompletion), [request]);
  if (!owned || input === null || (completion?.input === input && completion.result === result
    && completion.owner === owner && !completion.matches)) return <p role="alert">{t('beam.error.review')}</p>;
  return currentWeldSpanResult(completion, request) ? <>
    <WeldSpanResultTable result={result} view={session.contactView} />
    <BeamWeldSpanStressResults input={input} result={result} owner={owner} state={session.contactView.state} />
  </>
    : <p role="status">{t('beam.weldStressPending')}</p>;
}
