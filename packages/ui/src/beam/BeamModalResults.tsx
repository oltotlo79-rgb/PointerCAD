import type { BeamModalResult, BeamModeShape } from '@pointercad/model/beam-analysis';
import { t } from '../i18n/t.js';
import { beamDisplayNumber } from './BeamResults.js';

function ModeProjection({ result, mode, axes }: {
  readonly result: BeamModalResult;
  readonly mode: BeamModeShape;
  readonly axes: readonly [number, number];
}): React.JSX.Element {
  const length = result.normalizationLengthM;
  const minimum = axes.map(axis => Math.min(...mode.nodes.map(node => node.positionM[axis])));
  const maximum = axes.map(axis => Math.max(...mode.nodes.map(node => node.positionM[axis])));
  const centre = minimum.map((value, index) => (value + maximum[index]) / 2);
  const point = (number: number, deformed: boolean): readonly [number, number] => {
    const node = mode.nodes[number - 1];
    const x = (node.positionM[axes[0]] - centre[0]) / length + (deformed ? 0.08 * node.translation[axes[0]] : 0);
    const y = (node.positionM[axes[1]] - centre[1]) / length + (deformed ? 0.08 * node.translation[axes[1]] : 0);
    return [110 + 160 * x, 110 - 160 * y];
  };
  const label = `${t('beam.modeProjection')} ${['X', 'Y', 'Z'][axes[0]]}${['X', 'Y', 'Z'][axes[1]]}`;
  return <figure>
    <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label={label}>
      <title>{label}</title>
      {result.edges.map((edge, index) => {
        const start = point(edge.nodes[0], false), end = point(edge.nodes[1], false);
        const movedStart = point(edge.nodes[0], true), movedEnd = point(edge.nodes[1], true);
        return <g key={index}>
          <line x1={start[0]} y1={start[1]} x2={end[0]} y2={end[1]} stroke="currentColor" opacity="0.45" strokeDasharray="3 3" />
          <line x1={movedStart[0]} y1={movedStart[1]} x2={movedEnd[0]} y2={movedEnd[1]} stroke="currentColor" strokeWidth="2" />
        </g>;
      })}
    </svg>
    <figcaption>{label}</figcaption>
  </figure>;
}

export function BeamModalResults({ result }: { readonly result: BeamModalResult }): React.JSX.Element {
  return <section className="pcad-beam__results" data-testid="beam-modal-results" aria-label={t('beam.modalResults')}>
    <h4>{t('beam.modalResults')}</h4>
    <p>{t('beam.modalNormalization')}</p>
    <p>{t('beam.modalShapeHelp')}</p>
    <dl>
      <dt>{t('beam.normalizationLength')}</dt><dd data-testid="beam-modal-length">{beamDisplayNumber(result.normalizationLengthM)} m</dd>
      <dt>{t('beam.totalMass')}</dt><dd data-testid="beam-modal-mass">{beamDisplayNumber(result.totalMassKg)} kg</dd>
      <dt>{t('beam.rigidModes')}</dt><dd data-testid="beam-rigid-modes">{result.rigidBodyModes}</dd>
      <dt>{t('beam.meshSize')}</dt><dd>{result.meshNodes} / {result.meshElements}</dd>
      <dt>{t('beam.orthogonality')}</dt><dd data-testid="beam-modal-orthogonality">{beamDisplayNumber(result.maximumMassOrthogonalityError)}</dd>
    </dl>
    <p>{t('beam.modalMethod')}</p>
    {result.modes.map(mode => <details key={mode.number} open={mode.number === 1} data-beam-mode={mode.number}>
      <summary>{t('beam.mode')} {mode.number}: <span data-beam-frequency={mode.frequencyHz}>
        {beamDisplayNumber(mode.frequencyHz)} Hz</span></summary>
      <p>{t('beam.eigenResidual')}: <span data-beam-eigen-residual={mode.normalizedResidual}>
        {beamDisplayNumber(mode.normalizedResidual)}</span></p>
      <div className="pcad-beam__numbers">
        {([[0, 1], [0, 2], [1, 2]] as const).map(axes =>
          <ModeProjection key={axes.join('-')} result={result} mode={mode} axes={axes} />)}
      </div>
      <details><summary>{t('beam.modeComponents')}</summary>
        <table><thead><tr><th>{t('beam.node')}</th>
          {['uX/L', 'uY/L', 'uZ/L', 'θX', 'θY', 'θZ'].map(name => <th key={name}>{name}</th>)}
        </tr></thead><tbody>{mode.nodes.map(node => <tr key={node.solverNode} data-beam-mode-node={node.solverNode}>
          <th>{node.nodeId ?? `${t('beam.interiorNode')} ${node.solverNode}`}</th>
          {[...node.translation, ...node.rotation].map((value, index) => <td key={index} data-component={index} data-value={value}>
            {beamDisplayNumber(value)}</td>)}
        </tr>)}</tbody></table>
      </details>
    </details>)}
  </section>;
}
