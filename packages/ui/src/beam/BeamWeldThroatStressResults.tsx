import { recoverWeldThroatStress, recoverJointWeldThroatStress, recoverInitialStrainWeldThroatStress,
  type BeamWeldContactInput, type BeamWeldContactResult, type BeamJointContactInput, type BeamJointContactResult,
  type BeamJointInitialStrainInput, type BeamJointInitialStrainResult } from '@pointercad/fem';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/t.js';
import { beamDisplayNumber } from './BeamResults.js';
import { beamDefinition, type BeamSession } from './beamSession.js';
import { prepareBeamAnalysis } from './prepareBeamAnalysis.js';

type StressStates = Awaited<ReturnType<typeof recoverWeldThroatStress>>;
/** Caller first admits the reviewed source with beamSourceIsCurrent, as for the existing result views. */
export function prepareWeldStressInput(session: BeamSession): BeamWeldContactInput | null {
  const source = session.reviewed;
  if (source === null) return null;
  const draft = beamDefinition(session, source, source.document.parameters);
  if (!draft.ok) return null;
  const prepared = prepareBeamAnalysis(source, draft.definition);
  return prepared.ok && prepared.kind === 'weld-contact' ? prepared.input : null;
}
export type PreparedWeldStressInput =
  | { readonly kind: 'weld-contact'; readonly input: BeamWeldContactInput }
  | { readonly kind: 'joint-contact'; readonly input: BeamJointContactInput }
  | { readonly kind: 'joint-initial-strain'; readonly input: BeamJointInitialStrainInput };

/** The original weld-only preparation and callers remain compatible. */
export function prepareCombinedWeldStressInput(session: BeamSession): PreparedWeldStressInput | null {
  const source = session.reviewed;
  if (source === null) return null;
  const draft = beamDefinition(session, source, source.document.parameters);
  if (!draft.ok) return null;
  const prepared = prepareBeamAnalysis(source, draft.definition);
  return prepared.ok && (prepared.kind === 'weld-contact' || prepared.kind === 'joint-contact'
    || prepared.kind === 'joint-initial-strain') ? prepared : null;
}

export type WeldStressRequest = (
  | { readonly kind?: 'weld-contact'; readonly input: BeamWeldContactInput | null; readonly result: BeamWeldContactResult }
  | { readonly kind: 'joint-contact'; readonly input: BeamJointContactInput | null; readonly result: BeamJointContactResult }
  | { readonly kind: 'joint-initial-strain'; readonly input: BeamJointInitialStrainInput | null; readonly result: BeamJointInitialStrainResult }
) & { readonly owner: string };
export type WeldStressCompletion = WeldStressRequest & { readonly states: StressStates | null };

export function prepareWeldStressRequest(prepared: PreparedWeldStressInput | null,
  result: BeamWeldContactResult | BeamJointContactResult | BeamJointInitialStrainResult, owner: string): WeldStressRequest {
  if (result.kind === 'oofem-beam-joint-contact') return { kind: 'joint-contact', result, owner,
    input: prepared?.kind === 'joint-contact' ? prepared.input : null };
  if (result.kind === 'oofem-beam-joint-initial-strain') return { kind: 'joint-initial-strain', result, owner,
    input: prepared?.kind === 'joint-initial-strain' ? prepared.input : null };
  return { kind: 'weld-contact', result, owner, input: prepared?.kind === 'weld-contact' ? prepared.input : null };
}

/** Passive-effect owner only. Cleanup drops delivery; it does not claim to cancel WebCrypto. */
export function startWeldStressRecovery(request: WeldStressRequest, publish: (value: WeldStressCompletion) => void,
  recover: typeof recoverWeldThroatStress = recoverWeldThroatStress,
  combined = { joint: recoverJointWeldThroatStress, initialStrain: recoverInitialStrainWeldThroatStress }): () => void {
  let current = true;
  if (request.input !== null) {
    const promise = request.kind === 'joint-contact' ? combined.joint(request.input, request.result)
      : request.kind === 'joint-initial-strain' ? combined.initialStrain(request.input, request.result)
      : recover(request.input, request.result);
    void promise.then(
      states => { if (current) publish({ ...request, states }); },
      () => { if (current) publish({ ...request, states: null }); },
    );
  }
  return () => { current = false; };
}

/** Rendering checks identity as well as effect cleanup, including before the next passive effect runs. */
export function currentWeldStress(value: WeldStressCompletion | null, request: WeldStressRequest): WeldStressCompletion | null {
  return request.input !== null && value?.input === request.input && value.result === request.result
    && value.owner === request.owner && value.kind === request.kind ? value : null;
}

export function WeldStressTable({ states, state }: { readonly states: StressStates; readonly state: number }): React.JSX.Element {
  const selected = states[Math.min(Math.max(0, state), states.length - 1)];
  return <section data-testid="beam-weld-throat-stress">
    <h5>{t('beam.weldStressTitle')}</h5><p>{t('beam.weldStressScope')}</p>
    <table><thead><tr><th>{t('beam.contactId')}</th><th>{t('beam.weldStressAlong')}</th><th>{t('beam.weldStressAcross')}</th>
      <th>{t('beam.weldStressNormal')}</th><th>{t('beam.weldStressShearAlong')}</th><th>{t('beam.weldStressShearAcross')}</th></tr></thead>
    <tbody>{selected.welds.flatMap(weld => weld.corners.map((corner, index) => <tr key={`${weld.id}:${index}`}
      data-weld-stress-patch={weld.id} data-corner={index} data-load-factor={selected.loadFactor}>
      <th>{weld.id}</th><td data-unit="mm" data-value={corner.alongM * 1000}>{beamDisplayNumber(corner.alongM * 1000)}</td>
      <td data-unit="mm" data-value={corner.acrossM * 1000}>{beamDisplayNumber(corner.acrossM * 1000)}</td>
      {(['normalPa', 'shearAlongPa', 'shearAcrossPa'] as const).map(quantity => <td key={quantity} data-stress={quantity}
        data-unit="MPa" data-value={corner[quantity] / 1e6}>{beamDisplayNumber(corner[quantity] / 1e6)}</td>)}
    </tr>))}</tbody></table>
  </section>;
}

export function BeamWeldThroatStressResults(props: WeldStressRequest & { readonly state: number }): React.JSX.Element {
  const { kind, input, result, owner } = props;
  const request = useMemo<WeldStressRequest>(() => kind === 'joint-contact' ? { kind, input, result, owner }
    : kind === 'joint-initial-strain' ? { kind, input, result, owner } : { kind, input, result, owner },
  [kind, input, result, owner]);
  const [completion, setCompletion] = useState<WeldStressCompletion | null>(null);
  useEffect(() => startWeldStressRecovery(request, setCompletion), [request]);
  const current = currentWeldStress(completion, request);
  if (props.input === null || current?.states === null) return <p data-testid="beam-weld-stress-unavailable">{t('beam.weldStressUnavailable')}</p>;
  return current === null ? <p role="status">{t('beam.weldStressPending')}</p> : <WeldStressTable states={current.states} state={props.state} />;
}
