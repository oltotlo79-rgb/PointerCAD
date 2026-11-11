import { recoverBeamWeldSpanStress, type BeamWeldSpanContactInput, type BeamWeldSpanContactResult,
  type BeamWeldSpanStressResult } from '@pointercad/fem';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/t.js';
import { beamDisplayNumber } from './BeamResults.js';

interface SpanStressRequest {
  readonly input: BeamWeldSpanContactInput;
  readonly result: BeamWeldSpanContactResult;
  readonly owner: string;
}
interface SpanStressCompletion extends SpanStressRequest { readonly stress: BeamWeldSpanStressResult | null }

/** The input-bound FEM API owns and checks its data; cleanup fences delivery, not WebCrypto cancellation. */
export function startWeldSpanStressRecovery(request: SpanStressRequest, publish: (value: SpanStressCompletion) => void,
  recover = recoverBeamWeldSpanStress): () => void {
  let active = true;
  void recover(request.input, request.result).then(
    stress => { if (active) publish({ ...request, stress }); },
    () => { if (active) publish({ ...request, stress: null }); },
  );
  return () => { active = false; };
}

/** Identity is checked during render too, before cleanup of the preceding passive effect. */
export function currentWeldSpanStress(value: SpanStressCompletion | null, request: SpanStressRequest): SpanStressCompletion | null {
  return value?.input === request.input && value.result === request.result && value.owner === request.owner ? value : null;
}

/** The actual Gauss positions/tractions, not endpoint interpolation or a claimed maximum stress. */
export function WeldSpanStressTable({ stress, state }: {
  readonly stress: BeamWeldSpanStressResult; readonly state: number;
}): React.JSX.Element {
  const selected = stress.states[Math.min(Math.max(0, state), stress.states.length - 1)];
  return <section data-testid="beam-weld-span-stress" data-load-factor={selected.loadFactor}
    data-structural-certification={stress.structuralCertification}>
    <h5>{t('beam.weldSpanStressTitle')}</h5><p>{t('beam.weldSpanStressScope')}</p>
    <p>{t('beam.contactState')}: {beamDisplayNumber(selected.loadFactor)}</p>
    {selected.welds.map(weld => <details key={weld.id} data-weld-span={weld.id}>
      <summary>{t('beam.weldBead')}: {weld.id} — {t('beam.weldSpanStressTitle')}</summary>
      <table><caption>{t('beam.weldSpanStressPosition')}</caption>
        <thead><tr><th>{t('beam.weldBead')}</th><th>X (mm)</th><th>Y (mm)</th><th>Z (mm)</th>
          <th>{t('beam.weldStressNormal')}</th><th>{t('beam.weldStressShearAlong')}</th>
          <th>{t('beam.weldStressShearAcross')}</th></tr></thead>
        <tbody>{weld.points.map((point, index) => <tr key={index} data-point={index} data-load-factor={selected.loadFactor}>
          <th>{weld.id}</th>
          {point.positionM.map((value, axis) => <td key={axis} data-coordinate={axis} data-unit="m" data-value={value}>
            {beamDisplayNumber(value * 1000)}</td>)}
          {(['normalPa', 'shearAlongPa', 'shearAcrossPa'] as const).map(quantity => <td key={quantity}
            data-stress={quantity} data-unit="Pa" data-value={point[quantity]}>
            {beamDisplayNumber(point[quantity] / 1e6)}</td>)}
        </tr>)}</tbody>
      </table>
    </details>)}
  </section>;
}

/** Mounted only inside the existing current/reviewed full-result gate. */
export function BeamWeldSpanStressResults({ input, result, owner, state }: SpanStressRequest & {
  readonly state: number;
}): React.JSX.Element {
  const request = useMemo(() => ({ input, result, owner }), [input, result, owner]);
  const [completion, setCompletion] = useState<SpanStressCompletion | null>(null);
  useEffect(() => startWeldSpanStressRecovery(request, setCompletion), [request]);
  return <WeldSpanStressView completion={completion} request={request} state={state} />;
}

/** Same render-time gate for pending, failed and late-result paths. */
export function WeldSpanStressView({ completion, request, state }: {
  readonly completion: SpanStressCompletion | null; readonly request: SpanStressRequest; readonly state: number;
}): React.JSX.Element {
  const current = currentWeldSpanStress(completion, request);
  if (current?.stress === null) return <p role="alert">{t('beam.error.review')}</p>;
  return current === null ? <p role="status">{t('beam.weldStressPending')}</p>
    : <WeldSpanStressTable stress={current.stress} state={state} />;
}
