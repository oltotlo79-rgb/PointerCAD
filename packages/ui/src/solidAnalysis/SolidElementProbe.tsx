import { useEffect, useState } from 'react';
import type { SolidAnalysisSession } from './solidAnalysisSession.js';
import { solidAnalysisFieldOf } from './solidFieldState.js';
import { readSolidElementProbe, type SolidElementProbe as Probe } from './readSolidElementProbe.js';
import { t } from '../i18n/t.js';

/** Yield-evidence / von Mises line. Only a finite positive ratio is shown as a number; zero stress and missing
 * yield evidence say why there is no ratio, and any other value stays unevaluated (never shown as safe). */
export function probeYieldText(probe: Pick<Probe, 'yieldRatio' | 'capacityMissing' | 'zeroStress'>): string {
  if (probe.capacityMissing) return t('solidAnalysis.probeYieldNoCapacity');
  if (probe.zeroStress) return t('solidAnalysis.yieldZero');
  const ratio = probe.yieldRatio;
  return ratio !== null && Number.isFinite(ratio) && ratio > 0 ? String(ratio) : t('solidAnalysis.probeUnevaluated');
}

/** Independent panel: caller must pass only the currently owned document/session. */
export function SolidElementProbe({ session, ownerId, documentId }: {
  readonly session: SolidAnalysisSession; readonly ownerId: string; readonly documentId: string;
}): React.JSX.Element | null {
  const [indexText, setIndexText] = useState('1');
  const [answer, setAnswer] = useState<{ readonly key: string; readonly result: SolidAnalysisSession['result'];
    readonly field: NonNullable<ReturnType<typeof solidAnalysisFieldOf>>; readonly probe: Probe | null } | null>(null);
  const field = solidAnalysisFieldOf(session);
  const result = session.status === 'complete' && session.ownerId === ownerId
    && session.result?.prepared.input.source.documentId === documentId ? session.result : null;
  const index = /^\d+$/u.test(indexText) ? Number(indexText) - 1 : -1;
  const key = JSON.stringify([ownerId, documentId, session.revision, index, session.fieldView]);
  useEffect(() => {
    let active = true;
    if (result !== null && field !== null) void readSolidElementProbe(result, field, index)
      .then(probe => { if (active) setAnswer({ key, result, field, probe }); });
    return () => { active = false; };
  }, [result, field, index, key]);
  if (result === null || field === null) return null;
  const probe = answer?.key === key && answer.result === result && answer.field === field ? answer.probe : null;
  return <fieldset data-testid="solid-element-probe"><legend>{t('solidAnalysis.probeTitle')}</legend>
    <label title={t('solidAnalysis.probeElementHint')}>{t('solidAnalysis.probeElement')}<input type="number" min="1" step="1" value={indexText}
      onChange={event => setIndexText(event.target.value)} /></label>
    {probe === null ? <p role="status">{t('solidAnalysis.probeUnavailable')}</p> : <SolidElementProbeValues probe={probe} />}
  </fieldset>;
}

/** Values of one read probe; every unit text comes from the probe's i18n unit keys. */
export function SolidElementProbeValues({ probe }: { readonly probe: Probe }): React.JSX.Element {
  const length = t(probe.units.length), stress = t(probe.units.stress), force = t(probe.units.force);
  return <>
    <p>{t('solidAnalysis.probeMaterial')}: {probe.materialId}</p><p>{t('solidAnalysis.probeMises')}: {probe.vonMisesMPa} {stress}</p>
    <p>{t('solidAnalysis.probeEquivalentStrain')}: {probe.equivalentStrain}</p>
    <p>{t('solidAnalysis.probeEnergy')}: {probe.strainEnergyNmm} {t(probe.units.energy)}</p>
    <p>{t('solidAnalysis.probeYield')}: {probeYieldText(probe)}</p>
    <p>{t('solidAnalysis.probeStress')}: {probe.stressMPa.join(', ')}</p>
    <p>{t('solidAnalysis.probeStrain')}: {probe.strain.join(', ')}</p>
    <p>{t('solidAnalysis.probeLimits')}</p>
    <p data-coordinates={probe.coordinates}>{t('solidAnalysis.probeCoordinates')}</p>
    <ul>{probe.nodes.map(node => <li key={node.index}>{t('solidAnalysis.probeNode')} {node.index + 1}: {t('solidAnalysis.probePosition')} {node.positionMm.join(', ')} {length};
      {t('solidAnalysis.probeDisplacement')} {node.displacementMm.join(', ')} {length}; {t('solidAnalysis.probeReaction')} {node.reactionN.join(', ')} {force}</li>)}</ul>
  </>;
}
