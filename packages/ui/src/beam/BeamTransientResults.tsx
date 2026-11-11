import type { BeamTransientResult, TransientAxialResponse, TransientNodeResponse } from '@pointercad/fem';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from './BeamResults.js';
import type { BeamSession } from './beamSession.js';

type ResponseField = Exclude<keyof TransientNodeResponse, 'solverNode' | 'nodeId'>;
const quantities: readonly { readonly field: ResponseField; readonly label: MessageKey; readonly unit: string }[] = [
  { field: 'displacementM', label: 'beam.transientDisplacement', unit: 'm' },
  { field: 'rotationRad', label: 'beam.transientRotation', unit: 'rad' },
  { field: 'velocityMPerS', label: 'beam.transientVelocity', unit: 'm/s' },
  { field: 'angularVelocityRadPerS', label: 'beam.transientAngularVelocity', unit: 'rad/s' },
  { field: 'accelerationMPerS2', label: 'beam.transientAcceleration', unit: 'm/s²' },
  { field: 'angularAccelerationRadPerS2', label: 'beam.transientAngularAcceleration', unit: 'rad/s²' },
];

/** Plain-language view of one validated result. The chosen time and node live in the session (store), not here. */
export function BeamTransientResults({ result, view, axial }: {
  readonly result: BeamTransientResult; readonly view: BeamSession['transientView'];
  /** Member-mean linear axial measure already matched to this result, or null. */
  readonly axial: TransientAxialResponse | null;
}): React.JSX.Element {
  const edit = useAppStore(state => state.editBeam);
  const sampleIndex = Math.min(Math.max(0, view.sample), result.samples.length - 1);
  const nodeIndex = Math.min(Math.max(0, view.node), result.samples[0].nodes.length - 1);
  const sample = result.samples[sampleIndex];
  const series = result.samples.map(row => Math.hypot(...row.nodes[nodeIndex].displacementM));
  const largest = Math.max(0, ...series);
  const duration = result.samples[result.samples.length - 1].timeS;
  const x = (time: number): number => 10 + 200 * (duration > 0 ? time / duration : 0);
  const points = result.samples.map((row, index) => `${x(row.timeS)},${110 - 100 * (largest > 0 ? series[index] / largest : 0)}`).join(' ');
  return <section className="pcad-beam__results" data-testid="beam-transient-results" aria-label={t('beam.transientResults')}>
    <h4>{t('beam.transientResults')}</h4>
    <p>{t('beam.transientResultScope')}</p>
    <p>{t('beam.transientMethod')}</p>
    <dl>
      <dt>{t('beam.transientDamping')}</dt>
      <dd>{t(result.method === 'oofem-beam3d-matrices-newmark-average-acceleration/2'
        ? 'beam.transientDampingRayleigh' : 'beam.transientDampingNone')}</dd>
      {result.method === 'oofem-beam3d-matrices-newmark-average-acceleration/2' ? <>
        <dt>{t('beam.transientMassCoefficient')}</dt><dd>{beamDisplayNumber(result.damping.massCoefficientPerS)} 1/s</dd>
        <dt>{t('beam.transientStiffnessCoefficient')}</dt><dd>{beamDisplayNumber(result.damping.stiffnessCoefficientS)} s</dd>
        <dt>{t('beam.transientDissipatedEnergy')}</dt>
        <dd data-testid="beam-transient-dissipated-energy" data-value={result.dissipatedEnergyJ}>
          {beamDisplayNumber(result.dissipatedEnergyJ)} J</dd>
      </> : null}
      <dt>{t('beam.transientPeakDisplacement')}</dt>
      <dd data-testid="beam-transient-peak-displacement" data-value={result.peakDisplacementM}>
        {beamDisplayNumber(result.peakDisplacementM)} m ({t('beam.transientAt')} {beamDisplayNumber(result.peakDisplacementTimeS)} s,
        {' '}{t('beam.node')} {result.peakDisplacementSolverNode})</dd>
      <dt>{t('beam.transientPeakRotation')}</dt>
      <dd data-testid="beam-transient-peak-rotation" data-value={result.peakRotationRad}>
        {beamDisplayNumber(result.peakRotationRad)} rad ({t('beam.transientAt')} {beamDisplayNumber(result.peakRotationTimeS)} s,
        {' '}{t('beam.node')} {result.peakRotationSolverNode})</dd>
      <dt>{t('beam.transientEquilibrium')}</dt><dd>{beamDisplayNumber(result.maximumEquilibriumResidual)}</dd>
      <dt>{t('beam.transientEnergy')}</dt><dd>{beamDisplayNumber(result.maximumEnergyBalanceError)}</dd>
      <dt>{t('beam.meshSize')}</dt><dd>{result.meshNodes} / {result.meshElements}</dd>
    </dl>
    <label>{t('beam.transientTime')}<select data-testid="beam-transient-time" value={sampleIndex}
      onChange={event => edit({ kind: 'transient-view', sample: Number(event.target.value), node: nodeIndex })} title={t('beam.guide.transientTime')}>
      {result.samples.map((row, index) => <option key={index} value={index}>{beamDisplayNumber(row.timeS)} s</option>)}
    </select></label>
    <label>{t('beam.transientPlotNode')}<select data-testid="beam-transient-node" value={nodeIndex}
      onChange={event => edit({ kind: 'transient-view', sample: sampleIndex, node: Number(event.target.value) })} title={t('beam.guide.transientPlotNode')}>
      {sample.nodes.map((node, index) => <option key={node.solverNode} value={index}>{node.nodeId}</option>)}
    </select></label>
    <figure>
      <svg viewBox="0 0 220 120" width="220" height="120" role="img" aria-label={t('beam.transientPlot')}>
        <title>{t('beam.transientPlot')}</title>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
        <line x1={x(sample.timeS)} y1="10" x2={x(sample.timeS)} y2="110" stroke="currentColor" strokeDasharray="3 3" />
      </svg>
      <figcaption>{t('beam.transientPlot')} ({t('beam.transientPlotScale')} {beamDisplayNumber(largest)} m)</figcaption>
    </figure>
    <p data-testid="beam-transient-load-factor">{t('beam.transientLoadFactorAt')}: {beamDisplayNumber(sample.loadFactor)}</p>
    <table data-testid="beam-transient-table">
      <thead><tr><th>{t('beam.node')}</th><th>{t('beam.transientQuantity')}</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>{sample.nodes.flatMap(node => quantities.map(quantity =>
        <tr key={`${node.solverNode}-${quantity.field}`} data-beam-transient-node={node.solverNode} data-quantity={quantity.field}>
          <th>{node.nodeId}</th><td>{t(quantity.label)} ({quantity.unit})</td>
          {node[quantity.field].map((value, axis) => <td key={axis} data-component={axis} data-value={value}>
            {beamDisplayNumber(value)}</td>)}
        </tr>))}</tbody>
    </table>
    {axial === null ? null : <section data-testid="beam-transient-axial" aria-label={t('beam.transientAxial')}>
      <h5>{t('beam.transientAxial')}</h5>
      <p>{t('beam.transientAxialScope')}</p>
      <p>{t('beam.transientAxialLimits')}</p>
      <table data-testid="beam-transient-axial-table">
        <thead><tr><th>{t('beam.transientAxialMember')}</th><th>{t('beam.transientAxialEnds')}</th>
          <th>{t('beam.transientAxialStrainAt')}</th><th>{t('beam.transientAxialStressAt')} (Pa)</th>
          <th>{t('beam.transientAxialMaximum')}</th><th>{t('beam.transientAxialMinimum')}</th></tr></thead>
        <tbody>{axial.members.map(member => <tr key={member.memberId} data-beam-transient-axial-member={member.memberId}>
          <th>{member.memberId}</th>
          <td>{`${member.startNodeId} (${t('beam.node')} ${member.startSolverNode}) → ${member.endNodeId} (${t('beam.node')} ${member.endSolverNode})`}</td>
          <td data-quantity="strain" data-value={member.strain[sampleIndex]}>{beamDisplayNumber(member.strain[sampleIndex])}</td>
          <td data-quantity="stress" data-value={member.stressPa[sampleIndex]}>{beamDisplayNumber(member.stressPa[sampleIndex])}</td>
          {([['maximum', member.maximum], ['minimum', member.minimum]] as const).map(([name, extreme]) =>
            <td key={name} data-extreme={name} data-value={extreme.stressPa} data-time={extreme.timeS}>
              {`${beamDisplayNumber(extreme.stressPa)} Pa (${beamDisplayNumber(extreme.strain)}, ${t('beam.transientAt')} ${beamDisplayNumber(extreme.timeS)} s)`}</td>)}
        </tr>)}</tbody>
      </table>
    </section>}
  </section>;
}
