import { checkFibreSection, compareWithYield, elementFibreStresses, impactElementEndForces, type BeamImpactResult,
  type ElementFibreStress, type FibreSectionCheck, type ImpactMemberResponseSet, type ImpactMemberSeries,
  type SectionResultants } from '@pointercad/fem';
import type { StandardBeamFibreOutline } from '@pointercad/model/beam-analysis';
import { useMemo } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { fibreSectionInMetres, summarizeBeamImpact } from './beamImpactDraft.js';
import { beamDisplayNumber } from './BeamResults.js';

type UnassessedKey = keyof ImpactMemberResponseSet['unassessed'];
const unassessedLabel: Readonly<Record<UnassessedKey, MessageKey>> = {
  'end-and-interior-section-forces': 'beam.impactMembersUnassessedEndForces',
  'bending-fibre-stress': 'beam.impactMembersUnassessedFibreStress',
  'torsional-shear-stress': 'beam.impactMembersUnassessedTorsionalShear',
  'transverse-shear': 'beam.impactMembersUnassessedTransverseShear',
  'combined-or-equivalent-stress': 'beam.impactMembersUnassessedCombined',
  'yield-check': 'beam.impactMembersUnassessedYield',
};
type QuantityKey = 'axialStressPa' | 'axialForceN' | 'meanTorqueNm' | 'meanMomentYNm' | 'meanMomentZNm';
const quantities: readonly { readonly key: QuantityKey; readonly label: MessageKey }[] = [
  { key: 'axialStressPa', label: 'beam.impactMembersAxialStress' },
  { key: 'axialForceN', label: 'beam.impactMembersAxialForce' },
  { key: 'meanTorqueNm', label: 'beam.impactMembersTorque' },
  { key: 'meanMomentYNm', label: 'beam.impactMembersMomentY' },
  { key: 'meanMomentZNm', label: 'beam.impactMembersMomentZ' },
];
const extreme = (item: ImpactMemberSeries['maximum']): string =>
  `${beamDisplayNumber(item.value)} (${beamDisplayNumber(item.timeS * 1000)} ms)`;
/** The emitted sample whose bending moment magnitude hypot(My, Mz) is largest at this element end (first on a tie). */
function governingSample(values: readonly SectionResultants[]): number {
  let best = 0;
  values.forEach((value, index) => {
    if (Math.hypot(value[4], value[5]) > Math.hypot(values[best][4], values[best][5])) best = index;
  });
  return best;
}
const sectionStatusLabel: Readonly<Record<Exclude<FibreSectionCheck['status'], 'supported'>, MessageKey>> = {
  unsupported: 'beam.impactFibreStatusUnsupported', invalid: 'beam.impactFibreStatusInvalid',
  inconsistent: 'beam.impactFibreStatusInconsistent',
};
type FibreRow =
  | { readonly memberId: string; readonly status: 'missing' }
  | { readonly memberId: string; readonly status: Exclude<FibreSectionCheck['status'], 'supported'> }
  | { readonly memberId: string; readonly status: 'supported'; readonly ends: readonly ElementFibreStress[] };
const location = (yM: number, zM: number): string => `(y ${beamDisplayNumber(yM * 1000)} mm, z ${beamDisplayNumber(zM * 1000)} mm)`;

/** Readable summary of an accepted impact result (only shown while the panel's reviewed source is current). Lengths
 * and times are shown in mm and ms like the rest of the beam panel. The non-certification notice, the scope of the method
 * and the unassessed strength are always shown before the numbers; a rotation beyond the linearisation warning threshold
 * is marked, and the numbers stay visible for inspection only. `members` is the member-mean set the panel has already
 * bound to this result (impactMemberResponseMatches); its unassessed quantities are listed by name, never shown as 0.
 * When the accepted result carries the solver mesh fields, the elastic element end forces K_e u_e are derived once per
 * result from that same decoded result (so a cleared or replaced result can never show them) and listed per element end
 * at the emitted sample with the largest bending moment; an old-format result shows none. With the member outlines
 * entered for this run (`outlines`, mm) and the bound member set (its analysed A, Iy and Iz), the nominal longitudinal
 * fibre stress is derived per element end over the actual outline boundary; a missing, unsupported, invalid or
 * inconsistent outline is stated by type and gives no number. */
export function BeamImpactResults({ result, members = null, outlines = null }: {
  readonly result: BeamImpactResult; readonly members?: ImpactMemberResponseSet | null;
  readonly outlines?: ReadonlyMap<string, StandardBeamFibreOutline> | null;
}): React.JSX.Element {
  const summary = summarizeBeamImpact(result);
  const endForces = useMemo(() => result.interior === undefined ? null : impactElementEndForces(result.interior), [result]);
  const elements = useMemo(() => new Map(result.interior?.elements.map(element => [element.element, element]) ?? []), [result]);
  const fibre = useMemo((): readonly FibreRow[] | null => {
    if (endForces === null || members === null || outlines === null) return null;
    return members.members.map((member): FibreRow => {
      const outline = outlines.get(member.memberId);
      if (outline === undefined) return { memberId: member.memberId, status: 'missing' };
      const analysed = { areaM2: member.areaM2, iyM4: member.iyM4, izM4: member.izM4 };
      // Entered A, Iy and Iz are often rounded to a few digits; within 0.1 % the stress uses the analysed values and the
      // outline only for fibre positions, so its relative error stays within the same 0.1 %. Beyond that it is refused.
      const checked = checkFibreSection(fibreSectionInMetres(outline), analysed, 1e-3);
      if (checked.status !== 'supported') return { memberId: member.memberId, status: checked.status };
      return { memberId: member.memberId, status: 'supported',
        ends: elementFibreStresses(endForces.filter(row => row.memberId === member.memberId), checked.section, analysed) };
    });
  }, [endForces, members, outlines]);
  // The bending-fibre row below is replaced only by actual numbers: a nonempty bound member set in which every member
  // has a supported outline AND at least one evaluated element end of this result. A supported outline alone, a member
  // without element rows in this result, or an empty set (every([]) is true) is not an evaluated stress.
  const fibreEvaluated = fibre !== null && fibre.length > 0
    && fibre.every(row => row.status === 'supported' && row.ends.length > 0);
  // No sourced yield strength is linked to a beam material (evidence: BeamMaterial has none), so the comparison is
  // always data-missing in this slice; it is never shown as a pass.
  const yieldComparison = compareWithYield(0, null);
  return <section className="pcad-beam__results" data-testid="beam-impact-results">
    <h4>{t('beam.impactResult')}</h4>
    <p role="note" data-testid="beam-impact-not-certified">{t('beam.impactNotCertified')}</p>
    <p role="note" data-testid="beam-impact-applicability">{t('beam.impactApplicability')}</p>
    <p role="note" data-testid="beam-impact-strength-not-assessed">{t('beam.impactStrengthNotAssessed')}</p>
    {summary.rotationBeyondLinearization
      ? <p role="alert" data-testid="beam-impact-linearization-warning">{t('beam.impactLinearizationWarning')}</p> : null}
    <dl>
      <dt>{t('beam.impactDuration')}</dt><dd data-beam-impact-value="duration">{beamDisplayNumber(summary.durationMs)}</dd>
      <dt>{t('beam.impactInitialEnergy')}</dt><dd data-beam-impact-value="energy">{beamDisplayNumber(summary.initialEnergyJ)}</dd>
      <dt>{t('beam.impactEnergyError')}</dt>
      <dd data-beam-impact-value="energy-error">{beamDisplayNumber(summary.maximumEnergyBalanceError)}</dd>
      <dt>{t('beam.impactMaximumRotation')}</dt>
      <dd data-beam-impact-value="maximum-rotation">{beamDisplayNumber(summary.maximumRotationRad)}</dd>
    </dl>
    <table data-testid="beam-impact-contacts">
      <thead><tr>
        <th>{t('beam.impactContactNode')}</th><th>{t('beam.impactPeakForce')}</th><th>{t('beam.impactPeakTime')}</th>
        <th>{t('beam.impactImpulse')}</th><th>{t('beam.impactMinimumGap')}</th>
      </tr></thead>
      <tbody>{summary.contacts.map(row => <tr key={row.nodeId} data-beam-impact-contact={row.nodeId}>
        <td>{row.nodeId}</td><td>{beamDisplayNumber(row.peakForceN)}</td><td>{beamDisplayNumber(row.peakTimeMs)}</td>
        <td>{beamDisplayNumber(row.totalImpulseNs)}</td>
        <td>{row.minimumGapMm === null ? t('beam.impactNoSample') : beamDisplayNumber(row.minimumGapMm)}</td>
      </tr>)}</tbody>
    </table>
    {members === null ? null : <section data-testid="beam-impact-members" aria-label={t('beam.impactMembers')}>
      <h5>{t('beam.impactMembers')}</h5>
      <p role="note" data-testid="beam-impact-members-scope">{t('beam.impactMembersScope')}</p>
      <p role="note" data-testid="beam-impact-members-limits">{t('beam.impactMembersLimits')}</p>
      <ul data-testid="beam-impact-members-unassessed" aria-label={t('beam.impactMembersUnassessed')}>
        {(Object.keys(members.unassessed) as UnassessedKey[])
          // The element end forces below replace this one row only when the result really carries them.
          .filter(key => endForces === null || key !== 'end-and-interior-section-forces')
          // Likewise the fibre stress section replaces the bending-fibre row only when it holds every member's numbers.
          .filter(key => !fibreEvaluated || key !== 'bending-fibre-stress')
          .map(key => <li key={key} data-beam-impact-unassessed={key}>{t(unassessedLabel[key])}</li>)}
      </ul>
      <table>
        <thead><tr><th>{t('beam.impactMembersMember')}</th><th>{t('beam.impactMembersQuantity')}</th>
          <th>{t('beam.impactMembersMaximum')}</th><th>{t('beam.impactMembersMinimum')}</th></tr></thead>
        <tbody>{members.members.flatMap(member => quantities.map(({ key, label }) =>
          <tr key={`${member.memberId}/${key}`} data-beam-impact-member={member.memberId} data-beam-impact-quantity={key}>
            <td>{member.memberId} ({member.startNodeId} → {member.endNodeId})</td><td>{t(label)}</td>
            <td>{extreme(member[key].maximum)}</td><td>{extreme(member[key].minimum)}</td>
          </tr>))}</tbody>
      </table>
    </section>}
    {endForces === null ? null : <section data-testid="beam-impact-end-forces" aria-label={t('beam.impactEndForces')}>
      <h5>{t('beam.impactEndForces')}</h5>
      <p role="note" data-testid="beam-impact-end-forces-scope">{t('beam.impactEndForcesScope')}</p>
      <p role="note" data-testid="beam-impact-end-forces-limits">{t('beam.impactEndForcesLimits')}</p>
      <table>
        <thead><tr><th>{t('beam.impactEndForcesStation')}</th><th>{t('beam.impactEndForcesTime')}</th>
          <th>N (N)</th><th>Vy (N)</th><th>Vz (N)</th><th>T (N·m)</th><th>My (N·m)</th><th>Mz (N·m)</th></tr></thead>
        <tbody>{endForces.flatMap(row => (['start', 'end'] as const).map(end => {
          const values = row[end], sample = governingSample(values);
          const element = elements.get(row.element);
          const stationM = element === undefined ? Number.NaN : (row.segment + (end === 'end' ? 1 : 0)) * element.lengthM;
          return <tr key={`${row.element}/${end}`} data-beam-impact-element={row.element} data-beam-impact-end={end}>
            <td>{row.memberId} {t('beam.impactEndForcesSegment')} {row.segment + 1} {t(end === 'start'
              ? 'beam.impactEndForcesStart' : 'beam.impactEndForcesEnd')} ({beamDisplayNumber(stationM)} m)</td>
            <td>{beamDisplayNumber(result.samples[sample].timeS * 1000)} ms</td>
            {values[sample].map((value, axis) => <td key={axis} data-beam-impact-force={axis}>{beamDisplayNumber(value)}</td>)}
          </tr>;
        }))}</tbody>
      </table>
    </section>}
    {fibre === null ? null : <section data-testid="beam-impact-fibre-stress" aria-label={t('beam.impactFibreStress')}>
      <h5>{t('beam.impactFibreStress')}</h5>
      <p role="note" data-testid="beam-impact-fibre-scope">{t('beam.impactFibreScope')}</p>
      <p role="note" data-testid="beam-impact-fibre-limits">{t('beam.impactFibreLimits')}</p>
      <p role="note" data-testid="beam-impact-fibre-yield" data-beam-impact-yield={yieldComparison.status}>
        {t('beam.impactFibreYieldMissing')}</p>
      {fibre.flatMap(row => row.status === 'supported' ? [] : [row]).map(row =>
        <p key={row.memberId} role="status" data-beam-impact-fibre-status={row.status} data-beam-impact-fibre-member={row.memberId}>
          {`${row.memberId}: ${t(row.status === 'missing' ? 'beam.impactFibreStatusMissing' : sectionStatusLabel[row.status])}`}</p>)}
      <table>
        <thead><tr><th>{t('beam.impactEndForcesStation')}</th>
          <th>{t('beam.impactFibreTension')}</th><th>{t('beam.impactFibreCompression')}</th></tr></thead>
        <tbody>{fibre.flatMap(row => row.status !== 'supported' ? [] : row.ends.map(end => {
          const element = elements.get(end.element);
          const stationM = element === undefined ? Number.NaN : (end.segment + (end.end === 'end' ? 1 : 0)) * element.lengthM;
          return <tr key={`${end.element}/${end.end}`} data-beam-impact-fibre-element={end.element} data-beam-impact-fibre-end={end.end}>
            <td>{end.memberId} {t('beam.impactEndForcesSegment')} {end.segment + 1} {t(end.end === 'start'
              ? 'beam.impactEndForcesStart' : 'beam.impactEndForcesEnd')} ({beamDisplayNumber(stationM)} m)</td>
            <td data-beam-impact-fibre="tension">{`${beamDisplayNumber(end.tension.stressPa / 1e6)} MPa `
              + `${location(end.tension.yM, end.tension.zM)} ${beamDisplayNumber(result.samples[end.tension.sample].timeS * 1000)} ms`}</td>
            <td data-beam-impact-fibre="compression">{`${beamDisplayNumber(end.compression.stressPa / 1e6)} MPa `
              + `${location(end.compression.yM, end.compression.zM)} ${beamDisplayNumber(result.samples[end.compression.sample].timeS * 1000)} ms`}</td>
          </tr>;
        }))}</tbody>
      </table>
    </section>}
  </section>;
}
